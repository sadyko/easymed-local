// Platform → Service requests inbox. SERVICE_REQUESTS_V1.
// Clinics submit requests to add a service to the global catalog. Super-admins
// review here: Approve opens the MEDCORE service-create modal (the request only
// carries a free-text name, so the admin must pick a category and complete the
// medcore service); on create it locks the request to approved and best-effort
// drops a priced-at-0 service into the requesting clinic's list so they can
// immediately set a price. Reject just records the decision. SERVICE_REQUESTS_MEDCORE_V2.
import { esc, fmtDate, toast } from '../../setting.js';
import { gw } from '../gateway.js';
import { openServiceCreateModal } from './service-catalog.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], companies: {}, categories: null };

function setRowBusy(btn, busy) {
    const tr = btn && btn.closest && btn.closest('tr');
    if (tr) tr.querySelectorAll('[data-act]').forEach(b => { b.disabled = busy; });
    else if (btn) btn.disabled = busy;
}

export async function renderServiceRequests(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <button class="btn primary" id="svr-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Clinic</th>
                <th>Name</th>
                <th>Type</th>
                <th>Category</th>
                <th>Group</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="svr-body">
              <tr><td colspan="8" class="row-loading"><div class="spinner"></div>Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    root.querySelector('#svr-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const tbody = mountedRoot.querySelector('#svr-body');
    try {
        const [{ data: reqs, error: reqErr }, { data: comps, error: compErr }] = await Promise.all([
            supabase
                .from('service_requests')
                .select('id, company_id, name, category, type, group_name, note, status, review_notes, catalog_service_id, created_at')
                .order('created_at', { ascending: false })
                .limit(300),
            supabase.from('companies').select('id, name'),
        ]);
        if (reqErr) throw reqErr;
        if (compErr) console.warn('[service-requests] companies load:', compErr.message);
        cache.companies = {};
        for (const c of (comps || [])) cache.companies[c.id] = c.name;
        // Pending first, then newest-first within each group.
        cache.rows = (reqs || []).slice().sort((a, b) => {
            const ap = a.status === 'pending' ? 0 : 1;
            const bp = b.status === 'pending' ? 0 : 1;
            if (ap !== bp) return ap - bp;
            return new Date(b.created_at) - new Date(a.created_at);
        });
        renderRows();
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty">Failed to load: ${esc(err.message || String(err))}</td></tr>`;
        toast(err.message || String(err), 'err');
    }
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#svr-body');
    if (!tbody) return;
    if (cache.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty">No service requests yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = cache.rows.map(r => {
        const clinic = cache.companies[r.company_id] || '—';
        const pending = r.status === 'pending';
        const statusCell = pending
            ? `<span class="badge ${esc(r.status)}">${esc(r.status)}</span>`
            : `<span class="badge ${esc(r.status)}">${esc(r.status)}</span>${r.review_notes ? `<br><span class="muted" style="font-size:11.5px">${esc(r.review_notes)}</span>` : ''}`;
        const actions = pending
            ? `<button class="btn small primary" data-act="approve" data-id="${esc(r.id)}">Approve</button>
               <button class="btn small danger"  data-act="reject"  data-id="${esc(r.id)}">Reject</button>`
            : '<span class="muted">—</span>';
        return `
        <tr>
            <td>${esc(fmtDate(r.created_at))}</td>
            <td><strong>${esc(clinic)}</strong></td>
            <td>${esc(r.name || '—')}</td>
            <td>${esc(r.type || '—')}</td>
            <td>${esc(r.category || '—')}</td>
            <td>${esc(r.group_name || '—')}</td>
            <td>${statusCell}</td>
            <td style="white-space:nowrap">${actions}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-act]').forEach(b =>
        b.addEventListener('click', () => handleAction(b.dataset.act, b.dataset.id, b)));
}

async function handleAction(act, id, btn) {
    const r = cache.rows.find(x => x.id === id);
    if (!r) return;
    if (act === 'approve') return approve(r, btn);
    if (act === 'reject')  return reject(r, btn);
}

async function approve(r, btn) {
    const { supabase } = mountedCtx;
    // Load the medcore categories once (the create modal needs them, and the
    // admin MUST pick one — the request only carries a free-text name).
    if (!cache.categories) {
        try {
            const res = await gw('/catalog/categories');
            cache.categories = (res && res.data) || [];
        } catch (err) {
            toast('Could not load categories: ' + (err.message || err), 'err');
            return;
        }
    }
    // Open the medcore service-create modal pre-filled with the request name.
    // The modal performs the medcore POST itself; onCreated runs only after a
    // successful create. Cancelling the modal does nothing (no lock, no busy),
    // so the row buttons stay active and the request stays pending.
    openServiceCreateModal({
        prefill: { name_ru: r.name, name_uz: r.name },
        categories: cache.categories,
        onCreated: async (created) => {
            setRowBusy(btn, true);
            try {
                // Lock: flip pending->approved. If no row was updated, it was already handled.
                const { data: locked, error: e0 } = await supabase.from('service_requests')
                    .update({ status: 'approved' }).eq('id', r.id).eq('status', 'pending').select('id');
                if (e0) throw e0;
                if (!locked || !locked.length) { toast('Already handled.'); await loadAndRender(); return; }
                // Best-effort: drop a price-0 service into the requesting clinic so they can
                // price it. Do NOT set catalog_service_id — that FK points at the retired
                // EasyMed service_catalog, not medcore; leave it null. Surface failure.
                const { error: e2 } = await supabase.from('services').insert({
                    company_id: r.company_id, name: r.name, core_service_id: created && created.id,  // P2: link to the medcore catalog (same as Setup-services / existing services)
                    price: 0, tax_rate: 12, duration_minutes: 30, active: true,
                });
                if (e2) {
                    console.warn('[service-requests] clinic service insert:', e2.message);
                    const who = (cache.companies && cache.companies[r.company_id]) || 'the clinic';
                    toast('Approved, but auto-adding it to ' + who + ' failed: ' + e2.message + '. Add it from that clinic if needed.', 'err');
                } else {
                    toast('Approved.');
                }
                await loadAndRender();
            } catch (e) {
                toast('Approve failed: ' + (e.message || e), 'err');
                setRowBusy(btn, false);
            }
        },
    });
}

async function reject(r, btn) {
    const { supabase } = mountedCtx;
    const notes = prompt('Reason (optional):');
    if (notes === null) return;   // Cancel aborts
    setRowBusy(btn, true);
    try {
        const { error } = await supabase.from('service_requests').update({ status: 'rejected', review_notes: notes || null }).eq('id', r.id);
        if (error) throw error;
        toast('Rejected.');
        await loadAndRender();
    } catch (err) {
        toast(err.message || String(err), 'err');
        setRowBusy(btn, false);
    }
}
