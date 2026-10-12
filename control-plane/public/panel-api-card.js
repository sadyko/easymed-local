// PUBLIC_LICENCE_V1 — the "Online booking / API" card on a clinic's page.
//
//   • the switch — online booking on the public server api.easymed.uz for this
//     clinic (partners within a minute, the clinic's own exchange from its next
//     hourly check-in);
//   • what partners see right now, and what the clinic's licence last said;
//   • the clinic's API key: accepted, or a NEW one waiting (a new computer, a
//     reinstall — or someone with a copy of the clinic's token): accept only
//     after confirming with the clinic; block the current one if the computer
//     was stolen;
//   • emergency blocks of partner keys — works even while the clinic is
//     offline. The key is hashed HERE, in the browser (panel-logic.js
//     sha256Hex): only its SHA-256 goes to the server.
//
// Every decision is a pure function in panel-logic.js; this file paints and
// calls the API. Every dynamic value goes through esc().

import { cp, ApiError } from './panel-api.js';
import { esc, toast, fmtDateTime } from './panel-dom.js';
import { partnersSeeText, shortFp, licenceLine, revocationInput, sha256Hex } from './panel-logic.js';

/**
 * @param {HTMLElement} box   the card element (class "card")
 * @param {{id:string, api:object}} clinic  from GET /admin/clinics/:id — clinic.api is replaced after each change
 */
export function renderApiCard(box, clinic) {
  if (!box || !clinic.api) return;
  paint();

  function paint() {
    const api = clinic.api;
    const see = partnersSeeText(api.partners_see);
    const keyLine = api.sync_key
      ? `<span class="api-fp" title="${esc(api.sync_key)}">${esc(shortFp(api.sync_key))}</span> <span class="muted">accepted ${esc(fmtDateTime(api.sync_key_accepted_at))}</span>`
      : '<span class="muted">none accepted</span>';
    const pending = api.key_pending ? `
      <div class="legacy-note">New key from ${esc(fmtDateTime(api.sync_key_seen_at))}:
        <span class="api-fp" title="${esc(api.sync_key_seen)}">${esc(shortFp(api.sync_key_seen))}</span>.
        A new computer or a reinstall? Call the clinic before accepting — until then online booking keeps the old key.</div>
      <div class="form-actions"><button class="btn primary small" id="api-accept" type="button">Accept new key</button></div>` : '';
    const seenBlocked = api.seen_key_revoked
      ? '<div class="legacy-note">The key this clinic sends is blocked. Its exchange with the public server is refused.</div>' : '';
    const rows = api.revocations.map((r) => `
      <tr data-rid="${esc(String(r.id))}">
        <td>${r.kind === 'partner_key' ? 'Partner key' : 'Clinic API key'}</td>
        <td class="muted api-fp" title="${esc(r.value)}">${esc(shortFp(r.value))}</td>
        <td>${esc(r.note || '—')}</td>
        <td class="muted">${esc(fmtDateTime(r.created_at))} · ${esc(r.created_by || '—')}</td>
        <td><button class="btn small" type="button" data-unblock>Unblock</button></td>
      </tr>`).join('');
    box.innerHTML = `
      <h2>Online booking / API</h2>
      <div class="module-row">
        <span class="module-name">Online booking / API</span>
        <label class="switch"><input type="checkbox" id="api-switch" ${api.enabled ? 'checked' : ''} aria-label="Online booking / API"><span class="track"></span></label>
      </div>
      <div><span class="badge ${esc(see.tone)}">${esc(see.label)}</span></div>
      <div class="next-checkin-note">${esc(licenceLine(api.licence))}</div>

      <h3 class="stats-subhead">Clinic's API key</h3>
      <div class="form-actions">${keyLine}
        ${api.sync_key ? '<button class="btn danger small" id="api-block-sync" type="button">Block this key</button>' : ''}</div>
      ${pending}${seenBlocked}

      <h3 class="stats-subhead">Blocked keys</h3>
      ${rows ? `<div class="table-wrap"><table class="t"><thead><tr><th>Kind</th><th>Key</th><th>Why</th><th>Blocked</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="sub">Nothing blocked.</div>'}
      <div class="form-row" style="margin-top:12px">
        <label for="api-block-input">Block a partner key — paste the key (em_live_…) or its SHA-256</label>
        <input id="api-block-input" autocomplete="off" spellcheck="false">
      </div>
      <div class="form-row">
        <label for="api-block-note">Why (seen by your team only)</label>
        <input id="api-block-note" maxlength="200">
      </div>
      <div class="form-actions"><button class="btn danger" id="api-block-go" type="button">Block partner key</button></div>
      <div class="form-err" id="api-err"></div>
      <div class="next-checkin-note">Blocks reach the public server within a minute — even while the clinic is offline. The key itself never leaves this browser: only its SHA-256 is sent.</div>
    `;
    wire();
  }

  async function act(run, okNote) {
    const err = box.querySelector('#api-err');
    if (err) err.textContent = '';
    box.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    try {
      const res = await run();
      if (res && res.api) clinic.api = res.api;
      toast((res && res.note) || okNote, 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast(e.message || 'Could not save.', 'err');
    }
    paint();
  }

  function wire() {
    const sw = box.querySelector('#api-switch');
    sw.addEventListener('change', () => act(() => cp.setApi(clinic.id, sw.checked), 'Saved.'));

    const accept = box.querySelector('#api-accept');
    if (accept) {
      accept.addEventListener('click', () => {
        if (!confirm(`Accept the new key ${shortFp(clinic.api.sync_key_seen)} for "${clinic.name}"? Do this only after the clinic confirmed it moved to a new computer.`)) return;
        act(() => cp.acceptSyncKey(clinic.id, clinic.api.sync_key_seen), 'Accepted.');
      });
    }

    const blockSync = box.querySelector('#api-block-sync');
    if (blockSync) {
      blockSync.addEventListener('click', () => {
        if (!confirm(`Block the API key ${shortFp(clinic.api.sync_key)}? Partners stop seeing "${clinic.name}" within a minute; a new key from the clinic will need your approval.`)) return;
        act(() => cp.addRevocation(clinic.id, { kind: 'sync_key', value: clinic.api.sync_key, note: 'blocked from the panel' }), 'Blocked.');
      });
    }

    const input = box.querySelector('#api-block-input');
    box.querySelector('#api-block-go').addEventListener('click', async () => {
      const parsed = revocationInput(input.value);
      const note = box.querySelector('#api-block-note').value;
      if (parsed.kind === 'bad') {
        box.querySelector('#api-err').textContent = 'Paste the partner key (em_live_…) or its SHA-256 (64 characters 0-9, a-f).';
        return;
      }
      input.value = '';   // the key leaves the page now — never kept in the DOM
      const value = parsed.kind === 'key' ? await sha256Hex(parsed.value) : parsed.value;
      act(() => cp.addRevocation(clinic.id, { kind: 'partner_key', value, note }), 'Blocked.');
    });

    box.querySelectorAll('tr[data-rid] [data-unblock]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rid = btn.closest('tr').dataset.rid;
        if (!confirm('Unblock this key? It works again within a minute, if the clinic still has it switched on.')) return;
        act(() => cp.removeRevocation(clinic.id, rid), 'Unblocked.');
      });
    });
  }
}
