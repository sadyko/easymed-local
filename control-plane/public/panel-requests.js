// CONTROL_PLANE_PANEL_V1 — the "Подключить модуль" leads inbox.
//
// Granting is idempotent server-side (see admin.test.js's own double-click
// attack test), but the button here still disables synchronously on click
// and marks the row granted in place rather than re-fetching the whole list
// — a double-click must never show two success flashes, and the clinic's
// own module chips will reflect the grant the next time that clinic's own
// screen is fetched (list/detail always fetch fresh — see their own files),
// never from a stale cache this view would otherwise have to keep in sync.

import { cp, ApiError } from './panel-api.js';
import { esc, toast, fmtDateTime } from './panel-dom.js';
import { isGrantable } from './panel-logic.js';

export async function renderRequests(root) {
  root.innerHTML = `
    <div class="card" style="padding:0">
      <div class="table-wrap">
        <table class="t">
          <thead>
            <tr><th>Clinic</th><th>Module</th><th>Requested</th><th>Received</th><th></th></tr>
          </thead>
          <tbody id="rq-body">
            <tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading requests…</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  await load();

  async function load() {
    const tbody = root.querySelector('#rq-body');
    try {
      const data = await cp.requests();
      renderRows(data.requests);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // login screen already took over
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5"><div class="load-err">Failed to load requests: ${esc(e.message)}<br><button class="btn small" id="rq-retry">Retry</button></div></td></tr>`;
        const retry = root.querySelector('#rq-retry');
        if (retry) retry.addEventListener('click', load);
      }
    }
  }

  function renderRows(requests) {
    const tbody = root.querySelector('#rq-body');
    if (!tbody) return;

    if (requests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty">No open requests.</td></tr>`;
      return;
    }

    tbody.innerHTML = requests.map((r) => `
      <tr data-req-row data-id="${esc(r.id)}">
        <td><strong>${esc(r.clinic_name || r.clinic_id)}</strong><div class="muted" style="font-size:11.5px">${esc(r.clinic_id)}</div></td>
        <td>${esc(r.module_key)}</td>
        <td class="muted">${fmtDateTime(r.requested_at)}</td>
        <td class="muted">${fmtDateTime(r.received_at)}</td>
        <td>
          ${isGrantable(r.module_key)
            ? `<button class="btn primary small" data-grant type="button">Grant</button>`
            : `<span class="muted" title="Not offerable">Not offerable</span>`}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-req-row]').forEach((tr) => {
      const btn = tr.querySelector('[data-grant]');
      if (!btn) return;
      let inFlight = false;
      btn.addEventListener('click', async () => {
        if (inFlight) return; // the disabled attribute stops a real click, this stops re-entry before it's reflected
        inFlight = true;
        btn.disabled = true;
        btn.textContent = 'Granting…';
        try {
          const res = await cp.grantRequest(tr.dataset.id);
          btn.replaceWith(document.createTextNode(res.already ? 'Already granted' : 'Granted'));
          toast(res.note || 'Module granted.', 'ok');
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) return;
          inFlight = false;
          btn.disabled = false;
          btn.textContent = 'Grant';
          toast('Could not grant: ' + (e.message || 'unknown error'), 'err');
        }
      });
    });
  }
}
