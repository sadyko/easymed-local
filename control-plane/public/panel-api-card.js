// PUBLIC_LICENCE_V1 — the "Online booking / API" card on a clinic's page.
//
//   • the switch — online booking on the public server api.easymed.uz for this
//     clinic (partners within a minute, the clinic's own exchange from its next
//     hourly check-in);
//   • what partners see right now, and what the clinic's licence last said;
//   • the clinic's API key: accepted (shown as its key code "xxxx-xxxx", the
//     same the clinic sees in Settings → API), or a NEW one waiting (a new
//     computer, a reinstall — or someone with a copy of the clinic's data).
//     Since the step 8c review: a new key is accepted only with the key code
//     the clinic reads out from its own screen, typed here — the card never
//     paints the new key's code, so it cannot just be copied off this page;
//     several new keys from one install cannot be accepted at all (possible
//     copy — re-enrol the clinic); each new key can be blocked; an old key that
//     checks in again is "previously replaced", never "new";
//   • emergency blocks of partner keys — works even while the clinic is
//     offline. The key is hashed HERE, in the browser (panel-logic.js
//     sha256Hex): only its SHA-256 goes to the server.
//
// Every decision is a pure function in panel-logic.js; this file paints and
// calls the API. Every dynamic value goes through esc().

import { cp, ApiError } from './panel-api.js';
import { esc, toast, fmtDateTime } from './panel-dom.js';
import { partnersSeeText, shortFp, keyCode, licenceLine, revocationInput, sha256Hex } from './panel-logic.js';

// New keys waiting (api.candidates, from the server — fingerprints only, no
// codes). Each row is addressed by its index (data-cand-i), so a new key's
// fingerprint, and with it its code, is never written into the page.
function pendingHtml(api) {
  const live = api.candidates.filter((k) => !k.revoked);
  const row = (k, i) => `
      <div class="form-actions" data-cand-i="${esc(String(i))}"><span class="muted">New key, first seen ${esc(fmtDateTime(k.first_seen))}, last check-in ${esc(fmtDateTime(k.last_seen))}${k.revoked ? ' — blocked' : ''}${k.other_clinic ? ` — already the key of clinic ${esc(k.other_clinic)}` : ''}</span>
        ${k.revoked ? '' : '<button class="btn danger small" type="button" data-block-candidate>Block this key</button>'}</div>`;
  if (api.key_competing) {
    return `
      <div class="legacy-note">${esc(String(api.candidates.length))} different new keys from this clinic's install since its key was last accepted — possible copy of the clinic's data. Nothing can be accepted: re-enrol the clinic (a new enrollment code), then accept the key of the re-enrolled computer. Until then online booking keeps the old key.</div>
      ${api.candidates.map(row).join('')}`;
  }
  if (live.length !== 1) return '';
  const i = api.candidates.indexOf(live[0]);
  return `
      <div class="legacy-note">A new key arrived — a new computer, a reinstall, or someone with a copy of the clinic's data. Until it is accepted, online booking keeps the old key.
        Phone the clinic on the number in your records (not one the caller gives) and ask them to read the key code from Settings → API; accept only if it matches.</div>
      ${row(live[0], i)}
      <div class="form-row">
        <label for="api-accept-code">Key code the clinic reads out</label>
        <input id="api-accept-code" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx" maxlength="12">
      </div>
      <div class="form-actions"><button class="btn primary small" id="api-accept" type="button">Accept new key</button></div>
      <div class="form-err" id="api-accept-err"></div>`;
}

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
      ? `<span class="api-fp" title="Key code — the clinic sees the same in Settings → API">${esc(keyCode(api.sync_key))}</span> <span class="muted">accepted ${esc(fmtDateTime(api.sync_key_accepted_at))}</span>`
      : '<span class="muted">none accepted</span>';
    const pending = pendingHtml(api);
    const replaced = api.replaced_seen.map((r, i) => `
      <div class="legacy-note" data-replaced-i="${esc(String(i))}">A previously replaced key, <span class="api-fp">${esc(r.code)}</span>, checked in again ${esc(fmtDateTime(r.last_seen))} — the old computer is still running, or someone has a copy of it. It is not accepted and cannot be.
        <div class="form-actions"><button class="btn danger small" type="button" data-block-replaced>Block this key</button></div></div>`).join('');
    const seenBlocked = api.seen_key_revoked
      ? '<div class="legacy-note">The key this clinic sends is blocked. Its exchange with the public server is refused.</div>' : '';
    const rows = api.revocations.map((r) => `
      <tr data-rid="${esc(String(r.id))}">
        <td>${r.kind === 'partner_key' ? 'Partner key' : 'Clinic API key'}</td>
        <td class="muted api-fp">${esc(r.kind === 'partner_key' ? shortFp(r.value) : (r.code || '—'))}</td>
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
      <div class="next-checkin-note">${esc(licenceLine(api.licence, api.partners_see))}</div>

      <h3 class="stats-subhead">Clinic's API key</h3>
      <div class="form-actions">${keyLine}
        ${api.sync_key ? '<button class="btn danger small" id="api-block-sync" type="button">Block this key</button>' : ''}</div>
      ${pending}${replaced}${seenBlocked}

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

    // The server checks the typed code against the new key; nothing here knows it.
    const accept = box.querySelector('#api-accept');
    if (accept) {
      const only = clinic.api.candidates.find((k) => !k.revoked);
      const codeInput = box.querySelector('#api-accept-code');
      accept.addEventListener('click', () => {
        if (!codeInput.value.trim()) {
          box.querySelector('#api-accept-err').textContent = 'Type the key code the clinic reads out from Settings → API.';
          codeInput.focus();
          return;
        }
        act(() => cp.acceptSyncKey(clinic.id, only.id, codeInput.value), 'Accepted.');
      });
    }

    box.querySelectorAll('[data-cand-i] [data-block-candidate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = clinic.api.candidates[Number(btn.closest('[data-cand-i]').dataset.candI)];
        if (!k) return;
        if (!confirm(`Block this new key for "${clinic.name}"? It can never be accepted then — if it turns out to be the clinic's own new computer, the clinic will have to be re-enrolled.`)) return;
        act(() => cp.addRevocation(clinic.id, { kind: 'sync_key', key_id: k.id, note: 'new key blocked from the panel' }), 'Blocked.');
      });
    });

    box.querySelectorAll('[data-replaced-i] [data-block-replaced]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = clinic.api.replaced_seen[Number(btn.closest('[data-replaced-i]').dataset.replacedI)];
        if (!r) return;
        if (!confirm(`Block the previously replaced key ${r.code}? The current key keeps working.`)) return;
        act(() => cp.addRevocation(clinic.id, { kind: 'sync_key', key_id: r.id, note: 'previously replaced key blocked from the panel' }), 'Blocked.');
      });
    });

    const blockSync = box.querySelector('#api-block-sync');
    if (blockSync) {
      blockSync.addEventListener('click', () => {
        if (!confirm(`Block the API key ${keyCode(clinic.api.sync_key)}? Partners stop seeing "${clinic.name}" within a minute; a new key from the clinic will need your approval.`)) return;
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
