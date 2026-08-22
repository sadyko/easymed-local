// CONTROL_PLANE_PANEL_V1 — the clinics list. Renders once per navigation to
// #clinics; a search box filters the already-fetched array client-side (no
// re-fetch per keystroke). Everything shown per row is O(1) work already
// present on the /admin/clinics response — no per-row lookups into another
// array, which is what would make a 200-clinic list quadratic to render.

import { cp, ApiError } from './panel-api.js';
import { esc } from './panel-dom.js';
import { lastSeenSeverity, formatLastSeen, subscriptionBadge } from './panel-logic.js';
import { openNewClinicModal } from './panel-new-clinic.js';

export async function renderClinicsList(root) {
  root.innerHTML = `
    <div class="filterbar">
      <input class="search" id="cl-search" placeholder="Search by name or clinic id…">
      <button class="btn primary" id="cl-new" style="margin-left:auto">New clinic</button>
    </div>
    <div class="card" style="padding:0">
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              <th>Clinic</th>
              <th>ID</th>
              <th>Subscription</th>
              <th>Modules</th>
              <th>Version</th>
              <th>Last seen</th>
              <th>Fingerprint</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody id="cl-body">
            <tr><td colspan="8" class="row-loading"><div class="spinner"></div>Loading clinics…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  let rows = [];
  let search = '';

  root.querySelector('#cl-new').addEventListener('click', () => {
    openNewClinicModal({ onCreated: load });
  });
  root.querySelector('#cl-search').addEventListener('input', (e) => {
    search = e.target.value.trim().toLowerCase();
    renderRows();
  });

  function renderRows() {
    const tbody = root.querySelector('#cl-body');
    if (!tbody) return; // navigated away while a fetch was in flight

    let visible = rows;
    if (search) {
      visible = rows.filter((c) => c.name.toLowerCase().includes(search) || c.id.toLowerCase().includes(search));
    }

    if (visible.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${rows.length === 0 ? 'No clinics yet.' : 'No clinics match this search.'}</td></tr>`;
      return;
    }

    tbody.innerHTML = visible.map((c) => {
      const sub = subscriptionBadge(c.subscription, c.subscription_until);
      const severity = lastSeenSeverity(c.last_seen_at);
      const modsHtml = c.modules.length
        ? c.modules.map((m) => `<span class="mod-chip">${esc(m)}</span>`).join('')
        : '<span class="mod-chips-empty">—</span>';
      return `
        <tr data-row data-id="${esc(c.id)}">
          <td><strong>${esc(c.name)}</strong>${c.active ? '' : ' <span class="badge danger">retired</span>'}</td>
          <td class="muted">${esc(c.id)}</td>
          <td><span class="badge ${sub.tone}">${esc(sub.label)}</span></td>
          <td>${modsHtml}</td>
          <td class="muted">${esc(c.last_version || '—')}</td>
          <td class="last-seen ${severity}">${esc(formatLastSeen(c.last_seen_at))}</td>
          <td>${c.fingerprint_changed ? '<span class="fp-flag">changed</span>' : '<span class="muted">—</span>'}</td>
          <td class="num">${c.open_request_count > 0 ? `<span class="req-badge">${c.open_request_count}</span>` : '<span class="muted">0</span>'}</td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-row]').forEach((tr) => {
      tr.addEventListener('click', () => { location.hash = `#clinics/${encodeURIComponent(tr.dataset.id)}`; });
    });
  }

  async function load() {
    const tbody = root.querySelector('#cl-body');
    try {
      const data = await cp.clinics();
      rows = data.clinics.slice().sort((a, b) => a.name.localeCompare(b.name));
      renderRows();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        // A 401 is already handled by the panel-wide session-expired hook
        // (login screen takes over); anything else must show a real message
        // here instead of leaving the "Loading…" spinner running forever.
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="8"><div class="load-err">Failed to load clinics: ${esc(e.message)}<br><button class="btn small" id="cl-retry">Retry</button></div></td></tr>`;
          const retry = root.querySelector('#cl-retry');
          if (retry) retry.addEventListener('click', load);
        }
      }
    }
  }

  await load();
}
