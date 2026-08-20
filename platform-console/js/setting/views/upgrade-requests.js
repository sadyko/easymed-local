// Platform → Upgrade requests. Inbox of clinics asking to move off trial.
// Status flow: pending → contacted → converted | closed.
// Per row: open mailto / tel: links so the super-admin can react in one
// click; mark as contacted/converted/closed once handled.

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], companies: {}, requesters: {}, filter: 'pending' };

export async function renderUpgradeRequests(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <button class="chip on" data-filter="pending">Pending</button>
        <button class="chip"    data-filter="contacted">Contacted</button>
        <button class="chip"    data-filter="converted">Converted</button>
        <button class="chip"    data-filter="closed">Closed</button>
        <button class="chip"    data-filter="all">All</button>
        <button class="btn primary" id="ur-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Clinic</th>
                <th>Manager</th>
                <th>Phone</th>
                <th>Interest</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="ur-body"><tr><td colspan="7" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
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
    root.querySelector('#ur-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const [reqRes, coRes] = await Promise.all([
        supabase.from('upgrade_requests')
            .select('id, company_id, requested_by, clinic_name, manager_name, phone, requested_plan, message, status, created_at, reviewed_at, review_notes')
            .order('created_at', { ascending: false })
            .limit(200),
        supabase.from('companies').select('id, name, slug, plan, trial_ends_at'),
    ]);
    if (reqRes.error) {
        mountedRoot.querySelector('#ur-body').innerHTML = `<tr><td colspan="7" class="empty">Failed: ${esc(reqRes.error.message)}</td></tr>`;
        return;
    }
    cache.rows = reqRes.data || [];
    cache.companies = {};
    for (const c of (coRes.data || [])) cache.companies[c.id] = c;
    renderRows();
    if (mountedCtx.refreshBadges) mountedCtx.refreshBadges();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#ur-body');
    if (!tbody) return;
    let rows = cache.rows;
    if (cache.filter !== 'all') rows = rows.filter(r => r.status === cache.filter);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty">No requests in this filter.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const co = r.company_id ? cache.companies[r.company_id] : null;
        const planChip = r.requested_plan
            ? `<span class="badge ${esc(r.requested_plan)}">${esc(r.requested_plan)}</span>`
            : '<span class="muted">—</span>';
        return `
            <tr>
                <td>${fmtRelative(r.created_at)}</td>
                <td>
                    <strong>${esc(r.clinic_name)}</strong>
                    ${co ? `<br><span class="muted" style="font-size:11.5px"><a href="https://${esc(co.slug)}.easymed.uz/admin" target="_blank">${esc(co.slug)}.easymed.uz</a></span>` : ''}
                    ${co && co.trial_ends_at ? `<br><span class="muted" style="font-size:11px">trial ends ${fmtRelative(co.trial_ends_at)}</span>` : ''}
                </td>
                <td>${esc(r.manager_name)}</td>
                <td><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></td>
                <td>${planChip}</td>
                <td><span class="badge ${esc(statusBadgeClass(r.status))}">${esc(r.status)}</span></td>
                <td>
                    <button class="btn small" data-act="open" data-id="${esc(r.id)}">Review</button>
                </td>
            </tr>
        `;
    }).join('');
    tbody.querySelectorAll('[data-act="open"]').forEach(b => b.addEventListener('click', () => openReview(b.dataset.id)));
}

function statusBadgeClass(status) {
    switch (status) {
        case 'pending':   return 'pending';
        case 'contacted': return 'starter';
        case 'converted': return 'approved';
        case 'closed':    return 'inactive';
        default:          return 'inactive';
    }
}

function openReview(id) {
    const r = cache.rows.find(x => x.id === id);
    if (!r) return;
    const co = r.company_id ? cache.companies[r.company_id] : null;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px">
        <h3>${esc(r.clinic_name)}</h3>
        <p class="sub">Submitted ${fmtRelative(r.created_at)} · <span class="badge ${esc(statusBadgeClass(r.status))}">${esc(r.status)}</span></p>
        ${co ? `<div class="row"><label>Clinic</label><div><a href="https://${esc(co.slug)}.easymed.uz/admin" target="_blank">${esc(co.name)}</a> · current plan <span class="badge ${esc(co.plan)}">${esc(co.plan)}</span></div></div>` : ''}
        <div class="row"><label>Manager</label><div>${esc(r.manager_name)}</div></div>
        <div class="row"><label>Phone</label><div><a href="tel:${esc(r.phone)}">${esc(r.phone)}</a> · <a href="https://wa.me/${esc(r.phone.replace(/[^0-9]/g, ''))}" target="_blank">WhatsApp</a></div></div>
        <div class="row"><label>Plan interest</label><div>${r.requested_plan ? `<span class="badge ${esc(r.requested_plan)}">${esc(r.requested_plan)}</span>` : '<span class="muted">unspecified</span>'}</div></div>
        ${r.message ? `<div class="row"><label>Message</label><div style="white-space:pre-wrap">${esc(r.message)}</div></div>` : ''}
        <div class="row"><label>Notes for this review</label>
          <textarea id="ur-notes" rows="2" placeholder="What you agreed on the call…">${esc(r.review_notes || '')}</textarea>
        </div>
        <div class="modal-err" id="ur-err"></div>
        <div class="modal-actions">
          <button class="btn"         id="ur-close">Close</button>
          <button class="btn"         data-status="closed">Closed</button>
          <button class="btn"         data-status="contacted">Mark contacted</button>
          <button class="btn primary" id="ur-invoice">Create invoice →</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#ur-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelectorAll('[data-status]').forEach(b => {
        b.addEventListener('click', () => updateStatus(r, b.dataset.status, overlay.querySelector('#ur-notes').value.trim(), overlay));
    });
    overlay.querySelector('#ur-invoice')?.addEventListener('click', async () => {
        overlay.remove();
        // Lazy-load the payments view's create modal — it has the
        // company + tariff data caches we need.
        const mod = await import('./payments.js');
        // navigate to payments so the modal has the populated cache
        // (payments.js renderPayments loads companies + tariffs).
        mountedCtx.navigate('payments');
        // wait one tick so renderPayments populates its cache
        setTimeout(() => mod.openCreateModal(r), 400);
    });
}

async function updateStatus(r, status, notes, overlay) {
    const { supabase } = mountedCtx;
    const { error } = await supabase.from('upgrade_requests').update({
        status,
        review_notes: notes || null,
        reviewed_at:  new Date().toISOString(),
    }).eq('id', r.id);
    if (error) {
        overlay.querySelector('#ur-err').textContent = error.message;
        return;
    }
    toast('Marked ' + status + '.', 'ok');
    overlay.remove();
    await loadAndRender();
}
