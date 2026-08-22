// CONTROL_PLANE_PANEL_V1 — "New clinic" modal: a short form, then the
// enrollment code the owner reads over the phone. See ONE_TIME_CODE_SURVIVES_V1
// below for why the code step behaves differently from every other modal in
// this app (no click-outside-to-close, a beforeunload guard).

import { cp, ApiError } from './panel-api.js';
import { renderCodeGroups, copyText, toast } from './panel-dom.js';
import { codeGroups } from './panel-logic.js';

export function openNewClinicModal({ onCreated } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  // Once the code is on screen, clicking the backdrop must NOT dismiss it —
  // only the explicit "Done" button may, so an owner's stray click can never
  // lose the one chance to read this code out. `beforeUnloadGuarded` tracks
  // whether we've installed the beforeunload prompt, so closeOverlay() only
  // ever removes a listener it actually added.
  let codeShown = false;
  let beforeUnloadGuarded = false;

  function guardUnload(e) {
    e.preventDefault();
    e.returnValue = ''; // required by some browsers to show the native prompt
  }

  function closeOverlay() {
    if (beforeUnloadGuarded) {
      window.removeEventListener('beforeunload', guardUnload);
      beforeUnloadGuarded = false;
    }
    overlay.remove();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !codeShown) closeOverlay();
  });

  renderForm();

  function renderForm() {
    // Static markup only (no interpolated dynamic values) — safe as
    // innerHTML. Every value the vendor types goes through .value / textContent
    // below, never back into an HTML string.
    overlay.innerHTML = `
      <div class="modal">
        <h3>New clinic</h3>
        <p class="sub">Creates the clinic in the registry and issues a one-time enrollment code.</p>
        <div class="row"><label>Clinic name</label><input id="nc-name" autocomplete="off"></div>
        <div class="row"><label>Contact name (optional)</label><input id="nc-contact-name" autocomplete="off"></div>
        <div class="row"><label>Contact phone (optional)</label><input id="nc-contact-phone" autocomplete="off"></div>
        <div class="modal-err" id="nc-err"></div>
        <div class="modal-actions">
          <button type="button" class="btn" id="nc-cancel">Cancel</button>
          <button type="button" class="btn primary" id="nc-create">Create clinic</button>
        </div>
      </div>
    `;
    const nameI = overlay.querySelector('#nc-name');
    const contactNameI = overlay.querySelector('#nc-contact-name');
    const contactPhoneI = overlay.querySelector('#nc-contact-phone');
    const err = overlay.querySelector('#nc-err');
    const createBtn = overlay.querySelector('#nc-create');

    overlay.querySelector('#nc-cancel').addEventListener('click', closeOverlay);
    nameI.focus();

    let inFlight = false;
    const submit = async () => {
      if (inFlight) return; // guards a double-click/double-Enter the same way the disabled attribute does
      const name = nameI.value.trim();
      err.textContent = '';
      if (!name) { err.textContent = 'Name is required.'; return; }

      inFlight = true;
      createBtn.disabled = true;
      try {
        const result = await cp.createClinic({
          name,
          contact_name: contactNameI.value.trim() || undefined,
          contact_phone: contactPhoneI.value.trim() || undefined,
        });
        renderCode(result.clinic_id, result.enrollment_code);
        if (onCreated) onCreated();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { closeOverlay(); return; } // login screen already took over
        err.textContent = (e && e.message) || 'Could not create the clinic.';
        inFlight = false;
        createBtn.disabled = false;
      }
    };
    createBtn.addEventListener('click', submit);
    overlay.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  // ONE_TIME_CODE_SURVIVES_V1 — the server never returns this code again: it
  // is cleared to NULL the moment the clinic redeems it, and GET
  // /admin/clinics/:id never selects enrollment_code even before that (see
  // admin.js's own comment on why that SELECT is not `SELECT *`). So this is
  // the owner's only chance to read it out. It is kept only in this closure's
  // local variables — never localStorage or any other persisted store — and
  // stays on screen until the owner explicitly clicks "Done", not until any
  // background refresh or accidental outside click could clear it.
  function renderCode(clinicId, code) {
    codeShown = true;
    window.addEventListener('beforeunload', guardUnload);
    beforeUnloadGuarded = true;

    overlay.replaceChildren();
    const modal = document.createElement('div');
    modal.className = 'modal';
    overlay.appendChild(modal);

    const h3 = document.createElement('h3');
    h3.textContent = 'Clinic created';
    modal.appendChild(h3);

    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = `Clinic id: ${clinicId}. Read this code to whoever is setting up the clinic.`;
    modal.appendChild(sub);

    const codeEl = document.createElement('div');
    modal.appendChild(codeEl);
    renderCodeGroups(codeEl, codeGroups(code));

    const onceNote = document.createElement('div');
    onceNote.className = 'once-note';
    onceNote.textContent = 'Shown once — it will not be shown again after you close this.';
    modal.appendChild(onceNote);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(code);
      toast(ok ? 'Code copied.' : 'Could not copy — copy it by hand.', ok ? 'ok' : 'err');
    });

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn primary';
    doneBtn.textContent = "Done, I've noted it";
    doneBtn.addEventListener('click', closeOverlay);

    actions.appendChild(copyBtn);
    actions.appendChild(doneBtn);
    modal.appendChild(actions);
  }
}
