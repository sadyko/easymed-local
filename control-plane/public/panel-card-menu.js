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
//   - Retire: a native confirm() using the exact sentence
//     panel-clinic-detail.js already uses for the same action, so there is
//     one wording for one concept rather than two dialogs disagreeing.
//   - Delete: a modal that requires the clinic's name typed back exactly
//     (case-sensitive) before the destructive button enables. Reading the
//     name back character-by-character is the point of asking — this is
//     irreversible and removes the clinic from the list for good.

import { cp, ApiError } from './panel-api.js';
import { esc, toast } from './panel-dom.js';

// The exact sentence panel-clinic-detail.js's own "Retire clinic" button
// uses — copied, not re-paraphrased, so the two places that can retire a
// clinic never say two different things about what retiring does.
function retireConfirmText(name) {
  return `Retire "${name}"? The clinic keeps working normally until its current licence runs out — this only stops it from renewing again. This cannot be undone from here.`;
}

// Only one card menu (and, separately, one delete dialog) open at a time.
// Opening a second menu tears down whatever the first one was holding —
// listeners included — rather than letting two stack.
let closeOpenMenu = null;

export function openCardMenu({ anchor, clinic, onChanged }) {
  if (closeOpenMenu) closeOpenMenu();

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
    if (closeOpenMenu === close) closeOpenMenu = null;
  }

  closeOpenMenu = close;
}

// --- retire --------------------------------------------------------------

async function doRetire(clinic, onChanged) {
  if (!confirm(retireConfirmText(clinic.name))) return;
  try {
    const res = await cp.retire(clinic.id);
    toast(res.note || 'Clinic retired.', 'ok');
    if (onChanged) onChanged();
  } catch (e) {
    // A 401 is already handled by panel-api.js's global unauthorized hook
    // (login screen takes over) — nothing more to show here.
    if (e instanceof ApiError && e.status === 401) return;
    toast('Could not retire the clinic: ' + (e.message || 'unknown error'), 'err');
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
    goBtn.disabled = nameInput.value.trim() !== clinic.name;
  });

  let inFlight = false;
  goBtn.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    goBtn.disabled = true;
    err.textContent = '';
    try {
      await cp.deleteClinic(clinic.id);
      close();
      if (onChanged) onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { close(); return; } // login screen already took over
      // Every non-401 error here is the server refusing in a sentence it
      // wrote FOR the owner — "Retire this clinic before deleting it.", or
      // the filial-count sentence naming the whole procedure. Shown
      // verbatim: this file never rewrites the server's own instruction.
      err.textContent = e.message || 'Could not delete the clinic.';
      inFlight = false;
      // Re-enabled unconditionally: the typed name in the box hasn't
      // changed and still matches, so the exact-match gate has nothing left
      // to say — the owner just needs to read the message and decide.
      goBtn.disabled = false;
    }
  });

  nameInput.focus();
}
