// CONTROL_PLANE_V2 — the ••• menu on a clinic card, and the guard in front
// of a permanent delete.
//
// The rule this file enforces: "Delete permanently" is offered ONLY on a
// clinic that is already retired. The server refuses anyway — DELETE
// /admin/clinics/:id answers 409 "Retire this clinic before deleting it."
// when the clinic is still active — so this is a SECOND copy of that rule,
// not the only one. It exists purely so the owner never sees a button that
// is going to say no; retire and delete stay two separate decisions, days
// apart if the owner likes, and nothing here collapses them into one click.
//
// Two flows live here:
//   - Retire: a native confirm() using retireConfirmText() from
//     panel-logic.js — the same function panel-clinic-detail.js calls for
//     its own "Retire clinic" button, so there is one wording for one
//     concept rather than two dialogs disagreeing.
//   - Delete: a modal that requires the clinic's name typed back exactly
//     (case-sensitive) before the destructive button enables. Reading the
//     name back character-by-character is the point of asking — this is
//     irreversible and removes the clinic from the list for good. A
//     selectable copy of the name plus a "Copy name" button make that
//     possible without relying on drag-select over the card (which the
//     card's own navigate-on-click handler fights).

import { cp, ApiError } from './panel-api.js';
import { esc, toast, copyText } from './panel-dom.js';
import { retireConfirmText } from './panel-logic.js';

// Only one card menu (and, separately, one delete dialog) open at a time.
// Opening a second menu tears down whatever the first one was holding —
// listeners included — rather than letting two stack.
let closeOpenMenu = null;
let openMenuAnchor = null;

// CONTROL_PLANE_V2 fix 7 — the board's repaint (panel-clinics-list.js's
// renderBoard) calls this before rebuilding the DOM. Typing in the search box
// or flipping a toggle re-renders the board, which yanks the menu's host
// node out from under it while its document-level click/keydown listeners
// stay registered; it self-heals on the next outside click, but there is no
// reason to leave a dangling listener around when the repaint already knows
// it is about to happen.
export function closeCardMenu() {
  if (closeOpenMenu) closeOpenMenu();
}

export function openCardMenu({ anchor, clinic, onChanged }) {
  // Fix 8 — a second click on the SAME kebab must close the menu, not close
  // then immediately reopen it (which looked like the kebab was stuck). Only
  // a click on a *different* card's kebab (or the board's own repaint) should
  // tear this menu down and open a new one.
  if (closeOpenMenu) {
    const wasSameAnchor = openMenuAnchor === anchor;
    closeOpenMenu();
    if (wasSameAnchor) return;
  }

  // `anchor` is the kebab button, which cannot host block children (it's a
  // <button>) and isn't itself a positioning context — .cardmenu's
  // top/right offsets are measured from the card's own box (.cc, already
  // position:relative). Appending into the card is what the CSS assumes;
  // falling back to the immediate parent only protects against a future
  // caller passing something outside a .cc entirely.
  const host = anchor.closest('.cc') || anchor.parentElement;
  if (!host) return;

  const menu = document.createElement('div');
  menu.className = 'cardmenu';
  menu.setAttribute('role', 'menu');

  function item(label, onClick, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    if (cls) b.className = cls;
    b.textContent = label; // static labels only — never a place esc() is needed
    b.addEventListener('click', onClick);
    return b;
  }

  function goToClinic() {
    close();
    location.hash = `#clinics/${encodeURIComponent(clinic.id)}`;
  }

  if (clinic.active) {
    menu.appendChild(item('Open', goToClinic));
    // The unlock tool already lives on the clinic detail page (see
    // panel-clinic-detail.js's "Unlock code" card) — this is a shortcut to
    // that same screen, not a second implementation of the tool.
    menu.appendChild(item('Unlock code…', goToClinic));
    menu.appendChild(document.createElement('hr'));
    menu.appendChild(item('Retire', () => { close(); doRetire(clinic, onChanged); }, 'danger'));
  } else {
    menu.appendChild(item('Open', goToClinic));
    menu.appendChild(document.createElement('hr'));
    menu.appendChild(item('Delete permanently', () => { close(); openDeleteDialog(clinic, onChanged); }, 'danger'));
  }

  // The menu is a child of the card, and the card itself navigates on
  // click (panel-clinics-list.js's bindCardEvents) — without this, choosing
  // any item would also bubble up and trigger the card's own click-to-open.
  // This runs regardless of what an item's own handler already did (close()
  // may have removed `menu` from the DOM by then, but the event's
  // propagation path was fixed when the click was dispatched, so this
  // listener still fires).
  menu.addEventListener('click', (e) => e.stopPropagation());

  host.appendChild(menu);
  openMenuAnchor = anchor;

  function onDocClick(e) {
    if (!menu.contains(e.target)) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }

  // Deferred to the next tick: the click that opened this menu (the kebab's
  // own click, which already stopPropagation()s) is still the *current*
  // event when this function runs. Wiring the outside-click listener
  // synchronously would let that same click's continued dispatch — or a
  // handler further up reacting to it — be seen by `onDocClick` and close
  // the menu the instant it opens.
  const wireTimer = setTimeout(() => {
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeydown);
  }, 0);

  function close() {
    clearTimeout(wireTimer);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
    menu.remove();
    if (closeOpenMenu === close) { closeOpenMenu = null; openMenuAnchor = null; }
  }

  closeOpenMenu = close;
}

// --- retire --------------------------------------------------------------

async function doRetire(clinic, onChanged) {
  if (!confirm(retireConfirmText(clinic))) return;
  try {
    const res = await cp.retire(clinic.id);
    toast(res.note || 'Clinic retired.', 'ok');
    if (onChanged) onChanged();
  } catch (e) {
    // A 401 is already handled by panel-api.js's global unauthorized hook
    // (login screen takes over) — nothing more to show here.
    if (e instanceof ApiError && e.status === 401) return;
    toast('Could not retire the clinic: ' + (e.message || 'unknown error'), 'err');
    // Fix 6 — a 404 means another tab already retired/deleted this exact
    // clinic. The error toast above still needs showing, but the board must
    // also refresh so the now-phantom card doesn't linger on screen.
    if (e instanceof ApiError && e.status === 404 && onChanged) onChanged();
  }
}

// --- delete ----------------------------------------------------------------

function openDeleteDialog(clinic, onChanged) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  // Only used to wire aria-labelledby — clinic.id is not attacker-controlled
  // HTML at this point (it's stripped to a safe id-attribute charset), so no
  // esc() is needed on it here, unlike every place below where it or the
  // clinic's name reaches innerHTML.
  const titleId = 'del-title-' + clinic.id.replace(/[^a-zA-Z0-9_-]/g, '');

  // Clinic names are vendor-entered free text (one live clinic is named
  // "Тестовая клиника (проверка обновлений)") and clinic ids are echoed back
  // from the server — both pass through esc() everywhere they land in this
  // markup.
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <h3 id="${titleId}">Delete "${esc(clinic.name)}" permanently?</h3>
      <p class="sub">This removes the clinic from the list for good. It cannot be undone from the panel.</p>
      <div class="keeps">
        Kept even after this:<br>
        <b>Its check-in history</b> — evidence for any billing question.<br>
        <b>The id ${esc(clinic.id)}</b> — reserved forever, so no old licence can ever come back to life.
      </div>
      <div class="row">
        <label>Clinic name</label>
        <div class="copy-row">
          <code class="copy-value" id="del-name-value">${esc(clinic.name)}</code>
          <button type="button" class="btn small" id="del-copy-name">Copy name</button>
        </div>
      </div>
      <div class="row">
        <label for="del-confirm-name">Type the clinic's name to confirm</label>
        <input id="del-confirm-name" autocomplete="off" spellcheck="false">
      </div>
      <div class="modal-err" id="del-err"></div>
      <div class="modal-actions">
        <button type="button" class="btn" id="del-cancel">Cancel</button>
        <button type="button" class="btn danger" id="del-go" disabled>Delete permanently</button>
      </div>
    </div>
  `;

  const nameInput = overlay.querySelector('#del-confirm-name');
  const goBtn = overlay.querySelector('#del-go');
  const err = overlay.querySelector('#del-err');
  const copyBtn = overlay.querySelector('#del-copy-name');

  // Fix 5 — the name lives on its own selectable line (not just inside the
  // heading, which line-wraps and mixes with punctuation) plus a one-click
  // copy, because the obvious source — the card itself — has a
  // navigate-on-click handler that a drag-select fires. This never fills the
  // input for the owner: typing the name back is the safety gate, not
  // copy-pasting past it.
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(clinic.name);
      copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => { if (overlay.isConnected) copyBtn.textContent = 'Copy name'; }, 1500);
    });
  }

  // Exact-match gate, shared between the live `input` handler and the
  // post-error re-check (fix 9) so the two can never drift apart.
  function nameMatches() {
    return nameInput.value.trim() === clinic.name;
  }

  function close() {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKeydown);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#del-cancel').addEventListener('click', close);

  // Exact, case-sensitive match against the clinic's own name. Reading the
  // name back character-for-character is the entire point of asking, so the
  // typed value is trimmed (no penalising a stray leading/trailing space)
  // but never case-folded or otherwise normalized before the comparison.
  nameInput.addEventListener('input', () => {
    goBtn.disabled = !nameMatches();
  });

  let inFlight = false;
  goBtn.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    goBtn.disabled = true;
    err.textContent = '';
    try {
      const res = await cp.deleteClinic(clinic.id);
      close();
      // Fix 2 — the server deliberately returns a delete-specific note (see
      // DELETE_NOTE in server/routes/admin.js): the licence already on the
      // clinic's own computer keeps working until it expires, and deleting
      // only stops it from ever renewing. That is the single most important
      // thing to say right after an irreversible action, so it must survive
      // even if the server ever sent no note at all.
      toast(res?.note || 'Clinic deleted. Any licence already on its computer keeps working until it expires.', 'ok');
      if (onChanged) onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { close(); return; } // login screen already took over
      // Every non-401 error here is the server refusing in a sentence it
      // wrote FOR the owner — "Retire this clinic before deleting it.", or
      // the filial-count sentence naming the whole procedure. Shown
      // verbatim: this file never rewrites the server's own instruction.
      err.textContent = e.message || 'Could not delete the clinic.';
      inFlight = false;
      // Fix 9 — re-check the same exact-match gate rather than re-enabling
      // unconditionally: if the box has been edited since the click (or a
      // 404 is about to clear the input's meaning entirely), the gate must
      // not just spring back open on its own.
      goBtn.disabled = !nameMatches();
      // Fix 6 — a 404 means another tab already deleted this exact clinic.
      // The error message above still needs to be read, but the board
      // behind this dialog must also refresh so the now-phantom card is
      // gone by the time the owner closes it.
      if (e instanceof ApiError && e.status === 404 && onChanged) onChanged();
    }
  });

  nameInput.focus();
}
