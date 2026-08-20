// Platform → Clinics in Symptex. Which clinics are published to the Symptex
// marketplace (symptex.uz). A clinic is "available in Symptex" when its medcore
// record is verification_status='verified' AND is_active. This is platform-only
// control — clinic admins cannot toggle their own Symptex visibility. The toggle
// goes through the gateway (gw), the only path that can read/write medcore;
// the console's own Supabase client only reaches the EasyMed DB. SYMPTEX_CONSOLE_V1

import { esc, toast } from '../../setting.js';
import { gw } from '../gateway.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], branches: {}, filter: 'all' };

const isAvailable = (r) => r.verification_status === 'verified' && r.is_active === true;

export async function renderSymptexClinics(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <button class="chip on" data-filter="all">All</button>
        <button class="chip"    data-filter="available">Available in Symptex</button>
        <button class="chip"    data-filter="requested">Requested</button>
        <button class="chip"    data-filter="hidden">Hidden</button>
        <button class="btn primary" id="sx-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <p class="sub" style="margin:0 0 12px">A clinic is <strong>available in Symptex</strong> when it is verified and active.
      Only platform admins control this — clinics cannot toggle their own Symptex visibility.</p>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead><tr>
              <th>Clinic</th><th>Type</th><th>Subdomain</th><th>District</th>
              <th>Verification</th><th>Symptex</th><th></th>
            </tr></thead>
            <tbody id="sx-body"><tr><td colspan="7" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    `;
    root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
        root.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        cache.filter = b.dataset.filter;
        renderRows();
    }));
    root.querySelector('#sx-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const body = mountedRoot.querySelector('#sx-body');
    let resp;
    try {
        resp = await gw('/publish/clinics?status=all');
    } catch (e) {
        body.innerHTML = `<tr><td colspan="7" class="empty">Failed to load: ${esc(e.message)}</td></tr>`;
        return;
    }
    // SYMPTEX_BRANCHES_ONLY — only branch-clinics are publishable; never show organization rows
    // (defensive client guard on top of the gateway's clinic_type=branch filter).
    cache.rows = ((resp && resp.clinics) || []).filter(r => r.clinic_type === 'branch');
    // Best-effort enrichment: medcore.easymed_external_id IS the EasyMed BRANCH id -> resolve the
    // branch's own name + its owning company's subdomain (slug). (Was wrongly keyed by company id.)
    cache.branches = {};
    try {
        const r = await mountedCtx.supabase.from('branches').select('id, name, company_id, companies(slug, name)');
        for (const b of (r.data || [])) cache.branches[b.id] = b;
    } catch (e) { /* enrichment is optional */ }
    renderRows();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#sx-body');
    if (!tbody) return;
    let rows = cache.rows.slice();
    if (cache.filter === 'available')      rows = rows.filter(isAvailable);
    else if (cache.filter === 'requested') rows = rows.filter(r => r.verification_status === 'requested');
    else if (cache.filter === 'hidden')    rows = rows.filter(r => !isAvailable(r));
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty">No clinics in this filter.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const br    = r.easymed_external_id ? cache.branches[r.easymed_external_id] : null;
        const slug  = br && br.companies && br.companies.slug;
        const avail = isAvailable(r);
        const subdomain = slug
            ? `<a href="https://${esc(slug)}.easymed.uz/admin" target="_blank">${esc(slug)}.easymed.uz</a>`
            : '<span class="muted">—</span>';
        const sbadge = avail
            ? `<span class="badge approved">In Symptex</span>`
            : `<span class="badge">Hidden</span>`;
        const btn = avail
            ? `<button class="btn small danger"  data-act="off" data-id="${esc(r.id)}">Deactivate</button>`
            : `<button class="btn small primary" data-act="on"  data-id="${esc(r.id)}">Activate</button>`;
        const name = r.name_ru || (br && br.name) || '—';
        return `<tr>
            <td><strong>${esc(name)}</strong></td>
            <td class="muted">${esc(r.clinic_type || '—')}</td>
            <td class="muted">${subdomain}</td>
            <td class="muted">${esc(r.district || '—')}</td>
            <td><span class="badge ${esc(r.verification_status || '')}">${esc(r.verification_status || '—')}</span></td>
            <td>${sbadge}</td>
            <td>${btn}</td>
        </tr>`;
    }).join('');
    tbody.querySelectorAll('[data-act]').forEach(b =>
        b.addEventListener('click', () => toggle(b.dataset.id, b.dataset.act === 'on', b)));
}

async function toggle(coreId, active, btn) {
    const row = cache.rows.find(r => r.id === coreId);
    if (!row) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = '…';
    try {
        const resp = await gw('/publish/clinics/' + coreId + '/symptex', { method: 'POST', body: { active } });
        row.verification_status = resp.verification_status;
        row.is_active = resp.is_active;
        toast(active ? 'Clinic is now available in Symptex.' : 'Clinic hidden from Symptex.', 'ok');
        renderRows();
    } catch (e) {
        btn.disabled = false;
        btn.textContent = prev;
        toast('Failed: ' + e.message, 'err');
    }
}
