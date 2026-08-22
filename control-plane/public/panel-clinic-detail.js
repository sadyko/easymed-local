// CONTROL_PLANE_PANEL_V1 — one clinic: module toggles, subscription editor,
// recent check-ins, retire, and the telephone unlock-code tool.
//
// Every mutating call here shows the API's own `note` (see admin.js's
// NEXT_CHECKIN_NOTE) — "applies at next check-in" is never a hardcoded
// duplicate of that sentence risking drifting from the server's wording; the
// persistent caption under the module toggles starts as a generic fallback
// and is replaced by the literal server `note` the first time any mutation
// on this screen succeeds.

import { cp, ApiError } from './panel-api.js';
import { esc, toast, fmtDateTime, renderCodeGroups } from './panel-dom.js';
import {
  SELLABLE_MODULES, moduleToggles, hasUnmanageableMarketingGrant,
  subscriptionBadge, subscriptionUntilPayload, codeGroups,
  counterCheckedState, statsRows,
} from './panel-logic.js';

const FALLBACK_NOTE = "Changes apply at this clinic's next check-in — not instantly.";

export async function renderClinicDetail(root, clinicId) {
  root.innerHTML = `
    <a class="back-link" id="dt-back" href="#clinics">&larr; All clinics</a>
    <div class="row-loading"><div class="spinner"></div>Loading clinic…</div>
  `;
  root.querySelector('#dt-back').addEventListener('click', (e) => { e.preventDefault(); location.hash = '#clinics'; });

  let clinic;
  let checkins;
  let counters; // STATS_V1 — [{name, describe}], the panel's own checkbox list source
  try {
    const [data, countersData] = await Promise.all([cp.clinic(clinicId), cp.counters()]);
    clinic = data.clinic;
    checkins = data.checkins;
    counters = countersData.counters;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return; // session-expired hook already showed the login screen
    const box = document.createElement('div');
    box.className = 'card';
    box.innerHTML = e instanceof ApiError && e.status === 404
      ? `<div class="empty">Clinic not found.</div>`
      : `<div class="load-err">Failed to load clinic: ${esc(e.message)}<br><button class="btn small" id="dt-retry">Retry</button></div>`;
    root.appendChild(box);
    const retry = root.querySelector('#dt-retry');
    if (retry) retry.addEventListener('click', () => renderClinicDetail(root, clinicId));
    return;
  }

  paint();

  function paint() {
    const sub = subscriptionBadge(clinic.subscription, clinic.subscription_until);
    root.innerHTML = `
      <a class="back-link" id="dt-back" href="#clinics">&larr; All clinics</a>
      <div class="detail-head">
        <div>
          <h1>${esc(clinic.name)}${clinic.active ? '' : ' <span class="badge danger">retired</span>'}</h1>
          <div class="sub">${esc(clinic.id)} · created ${fmtDateTime(clinic.created_at)}${clinic.contact_name ? ' · ' + esc(clinic.contact_name) : ''}${clinic.contact_phone ? ' · ' + esc(clinic.contact_phone) : ''}</div>
        </div>
        <span class="badge ${sub.tone}">${esc(sub.label)}</span>
      </div>

      <div class="detail-grid">
        <div>
          <div class="card" id="dt-modules-card">
            <h2>Modules</h2>
            <div id="dt-modules-body"></div>
            <div class="next-checkin-note" id="dt-modules-note">${esc(FALLBACK_NOTE)}</div>
          </div>

          <div class="card">
            <h2>Unlock code</h2>
            <p class="sub" style="margin-bottom:10px">Read the 6-character challenge from the clinic's lock screen, then read this code back to them.</p>
            <div class="form-row">
              <label>Challenge</label>
              <input id="dt-challenge" class="unlock-input" maxlength="12" placeholder="ABCDEF">
            </div>
            <button class="btn primary" id="dt-unlock-go" type="button">Get code</button>
            <div class="form-err" id="dt-unlock-err"></div>
            <div id="dt-unlock-code"></div>
          </div>
        </div>

        <div>
          <div class="card">
            <h2>Subscription</h2>
            <div class="form-row">
              <label>Status</label>
              <select id="dt-sub-status">
                <option value="active">Active</option>
                <option value="unpaid">Unpaid</option>
              </select>
            </div>
            <div class="form-row">
              <label>Paid until (blank = no end date)</label>
              <input type="date" id="dt-sub-until">
            </div>
            <div class="form-actions">
              <button class="btn primary" id="dt-sub-save" type="button">Save</button>
              <span class="form-ok" id="dt-sub-ok"></span>
            </div>
            <div class="form-err" id="dt-sub-err"></div>
          </div>

          <div class="card">
            <h2>Retire</h2>
            ${clinic.active
              ? `<p class="sub" style="margin-bottom:10px">The clinic keeps working normally until its current licence runs out — this only stops future check-ins from renewing it.</p>
                 <button class="btn danger" id="dt-retire" type="button">Retire clinic</button>`
              : `<p class="sub" style="margin:0">This clinic is retired. Its id can never be reissued to another clinic.</p>`}
          </div>
        </div>
      </div>

      <div class="card" id="dt-stats-card">
        <h2>Statistics</h2>
        <div id="dt-stats-body"></div>
        <h3 class="stats-subhead">Collected counters</h3>
        <div id="dt-stats-counters"></div>
        <div class="form-actions">
          <button class="btn primary" id="dt-stats-save" type="button">Save</button>
          <span class="form-ok" id="dt-stats-ok"></span>
        </div>
        <div class="form-err" id="dt-stats-err"></div>
        <div class="next-checkin-note" id="dt-stats-note">${esc(FALLBACK_NOTE)}</div>
      </div>

      <div class="card">
        <h2>Recent check-ins</h2>
        <div id="dt-checkins"></div>
      </div>
    `;
    root.querySelector('#dt-back').addEventListener('click', (e) => { e.preventDefault(); location.hash = '#clinics'; });

    paintModules();
    paintStats();
    paintCheckins();
    wireSubscriptionForm();
    wireRetire();
    wireUnlock();
    wireStats();
  }

  // --- modules ---------------------------------------------------------

  function paintModules() {
    const body = root.querySelector('#dt-modules-body');
    if (!body) return;
    const chips = moduleToggles(SELLABLE_MODULES, clinic.modules);
    body.innerHTML = chips.map((m) => `
      <div class="module-row" data-module-row data-key="${esc(m.key)}">
        <span class="module-name">${esc(m.label)}</span>
        <label class="switch">
          <input type="checkbox" ${m.granted ? 'checked' : ''}>
          <span class="track"></span>
        </label>
      </div>
    `).join('') + (hasUnmanageableMarketingGrant(clinic.modules)
      ? `<div class="legacy-note">This clinic also has a "marketing" grant that predates this screen and cannot be managed here.</div>`
      : '');

    body.querySelectorAll('[data-module-row]').forEach((rowEl) => {
      const key = rowEl.dataset.key;
      const input = rowEl.querySelector('input');
      input.addEventListener('change', async () => {
        const wantGranted = input.checked;
        input.disabled = true;
        try {
          const res = await cp.setModule(clinic.id, key, wantGranted);
          clinic.modules = wantGranted
            ? [...new Set([...clinic.modules, key])]
            : clinic.modules.filter((k) => k !== key);
          const note = root.querySelector('#dt-modules-note');
          if (note && res.note) note.textContent = res.note;
          toast(res.note || FALLBACK_NOTE, 'ok');
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return;
          input.checked = !wantGranted; // revert — the grant did not actually happen
          toast('Could not update module: ' + (e.message || 'unknown error'), 'err');
        } finally {
          input.disabled = false;
        }
      });
    });
  }

  // --- statistics (STATS_V1) --------------------------------------------

  // Two independent pieces in one card: the latest REPORTED numbers (read-
  // only, from the clinic's own last check-in that carried any), and the
  // checkbox list that edits collect_set for the NEXT one — same "applies at
  // next check-in" wording every other mutation on this page already shows.
  function paintStats() {
    const body = root.querySelector('#dt-stats-body');
    if (!body) return;
    if (!clinic.latest_stats) {
      body.innerHTML = `<div class="empty">This clinic has never reported statistics.</div>`;
    } else {
      const rows = statsRows(clinic.latest_stats, counters);
      body.innerHTML = `
        <div class="sub stats-as-of">As of ${esc(fmtDateTime(clinic.latest_stats_at))}</div>
        <div class="table-wrap">
          <table class="t">
            <thead><tr><th>Counter</th><th class="num">Value</th></tr></thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td>${esc(row.describe)}</td>
                  <td class="num">${esc(String(row.value))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    const counterList = root.querySelector('#dt-stats-counters');
    if (!counterList) return;
    const checked = counterCheckedState(counters.map((c) => c.name), clinic.collect_set);
    counterList.innerHTML = counters.map((c) => `
      <label class="counter-row" data-key="${esc(c.name)}">
        <input type="checkbox" ${checked.has(c.name) ? 'checked' : ''}>
        <span class="counter-name">${esc(c.describe)}</span>
      </label>
    `).join('');
  }

  function wireStats() {
    const saveBtn = root.querySelector('#dt-stats-save');
    const err = root.querySelector('#dt-stats-err');
    const ok = root.querySelector('#dt-stats-ok');
    if (!saveBtn) return;

    let inFlight = false;
    saveBtn.addEventListener('click', async () => {
      if (inFlight) return;
      err.textContent = '';
      ok.textContent = '';
      const names = [...root.querySelectorAll('#dt-stats-counters .counter-row')]
        .filter((rowEl) => rowEl.querySelector('input').checked)
        .map((rowEl) => rowEl.dataset.key);

      inFlight = true;
      saveBtn.disabled = true;
      try {
        const res = await cp.setCollect(clinic.id, names);
        clinic.collect_set = names; // matches what GET would now return — an explicit array, even if empty
        const note = root.querySelector('#dt-stats-note');
        if (note && res.note) note.textContent = res.note;
        ok.textContent = res.note || 'Saved.';
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        err.textContent = e.message || 'Could not save the collected counters.';
      } finally {
        inFlight = false;
        if (root.contains(saveBtn)) saveBtn.disabled = false;
      }
    });
  }

  // --- subscription ------------------------------------------------------

  function wireSubscriptionForm() {
    const statusSel = root.querySelector('#dt-sub-status');
    const untilInput = root.querySelector('#dt-sub-until');
    const saveBtn = root.querySelector('#dt-sub-save');
    const err = root.querySelector('#dt-sub-err');
    const ok = root.querySelector('#dt-sub-ok');
    if (!statusSel) return;

    statusSel.value = clinic.subscription;
    untilInput.value = clinic.subscription_until || '';

    let inFlight = false;
    saveBtn.addEventListener('click', async () => {
      if (inFlight) return;
      err.textContent = '';
      ok.textContent = '';
      const payload = {
        subscription: statusSel.value,
        subscription_until: subscriptionUntilPayload(untilInput.value),
      };
      inFlight = true;
      saveBtn.disabled = true;
      try {
        const res = await cp.setSubscription(clinic.id, payload);
        clinic.subscription = payload.subscription;
        clinic.subscription_until = payload.subscription_until;
        ok.textContent = res.note || 'Saved.';
        // The header badge is drawn from `clinic` at initial paint() time only —
        // repaint so it reflects the just-saved subscription immediately rather
        // than requiring a manual refresh of the whole page.
        paint();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        err.textContent = e.message || 'Could not save the subscription.';
      } finally {
        inFlight = false;
        if (root.contains(saveBtn)) saveBtn.disabled = false;
      }
    });
  }

  // --- retire --------------------------------------------------------------

  function wireRetire() {
    const btn = root.querySelector('#dt-retire');
    if (!btn) return;
    let inFlight = false;
    btn.addEventListener('click', async () => {
      if (inFlight) return;
      const confirmed = confirm(
        `Retire "${clinic.name}"? The clinic keeps working normally until its current licence runs out — this only stops it from renewing again. This cannot be undone from here.`
      );
      if (!confirmed) return;
      inFlight = true;
      btn.disabled = true;
      try {
        const res = await cp.retire(clinic.id);
        clinic.active = false;
        toast(res.note || 'Clinic retired.', 'ok');
        paint();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        toast('Could not retire the clinic: ' + (e.message || 'unknown error'), 'err');
        inFlight = false;
        if (root.contains(btn)) btn.disabled = false;
      }
    });
  }

  // --- unlock tool -----------------------------------------------------------

  function wireUnlock() {
    const input = root.querySelector('#dt-challenge');
    const btn = root.querySelector('#dt-unlock-go');
    const err = root.querySelector('#dt-unlock-err');
    const codeBox = root.querySelector('#dt-unlock-code');
    if (!btn) return;

    let inFlight = false;
    const go = async () => {
      if (inFlight) return;
      err.textContent = '';
      codeBox.textContent = '';
      const challenge = input.value.trim();
      if (!challenge) { err.textContent = 'Enter the challenge the clinic read out.'; return; }
      inFlight = true;
      btn.disabled = true;
      try {
        const res = await cp.unlockCode(clinic.id, challenge);
        renderCodeGroups(codeBox, codeGroups(res.code));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return;
        err.textContent = e.message || 'Could not compute the code.';
      } finally {
        inFlight = false;
        if (root.contains(btn)) btn.disabled = false;
      }
    };
    btn.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  // --- check-ins ------------------------------------------------------------

  function paintCheckins() {
    const box = root.querySelector('#dt-checkins');
    if (!box) return;
    if (!checkins.length) { box.innerHTML = '<div class="empty">No check-ins yet.</div>'; return; }
    box.innerHTML = `
      <div class="table-wrap">
        <table class="t checkins-table">
          <thead><tr><th>At</th><th>Version</th><th>Fingerprint</th><th>Change</th></tr></thead>
          <tbody>
            ${checkins.map((c) => `
              <tr>
                <td>${fmtDateTime(c.at)}</td>
                <td class="muted">${esc(c.version || '—')}</td>
                <td class="muted">${esc(c.fingerprint || '—')}</td>
                <td>${c.payload?.fingerprint_changed ? '<span class="fp-flag">changed</span>' : '<span class="muted">—</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
}
