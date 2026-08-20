// Platform → Clinics. Lists every clinic. Per-row actions: change plan,
// extend trial, suspend / reactivate, open admin in new tab.

import { esc, fmtRelative, fmtDate, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], search: '', filter: 'all' };

export async function renderClinics(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <input class="search" id="cl-search" placeholder="Search by name, slug, or admin email…">
        <button class="chip on" data-filter="all">All</button>
        <button class="chip"    data-filter="trial">Trial</button>
        <button class="chip"    data-filter="paid">Paid</button>
        <button class="chip"    data-filter="suspended">Suspended</button>
        <button class="chip"    data-filter="expired">Expired trial</button>
        <button class="btn primary" id="cl-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Clinic</th>
                <th>Subdomain</th>
                <th>Plan</th>
                <th>Trial ends</th>
                <th>Users</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="cl-body">
              <tr><td colspan="7" class="row-loading"><div class="spinner"></div>Loading clinics…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    root.querySelector('#cl-search').addEventListener('input', e => {
        cache.search = e.target.value.toLowerCase();
        renderRows();
    });
    root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
        root.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        cache.filter = b.dataset.filter;
        renderRows();
    }));
    root.querySelector('#cl-refresh').addEventListener('click', loadAndRender);

    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const { data: companies, error } = await supabase
        .from('companies')
        .select('id, name, slug, plan, trial_ends_at, is_active, active, created_at, email, phone')
        .order('created_at', { ascending: false });
    if (error) { mountedRoot.querySelector('#cl-body').innerHTML = `<tr><td colspan="7" class="empty">Failed to load: ${esc(error.message)}</td></tr>`; return; }

    // Pull user counts in one query
    const { data: usersList } = await supabase.from('users').select('company_id');
    const userCounts = {};
    for (const u of (usersList || [])) {
        if (!u.company_id) continue;
        userCounts[u.company_id] = (userCounts[u.company_id] || 0) + 1;
    }

    cache.rows = (companies || []).map(c => ({
        ...c,
        user_count: userCounts[c.id] || 0,
        is_expired_trial: c.plan === 'trial' && c.trial_ends_at && new Date(c.trial_ends_at) < new Date(),
    }));
    renderRows();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#cl-body');
    if (!tbody) return;
    let rows = cache.rows;

    if (cache.search) {
        const s = cache.search;
        rows = rows.filter(r =>
            (r.name || '').toLowerCase().includes(s)
            || (r.slug || '').toLowerCase().includes(s)
            || (r.email || '').toLowerCase().includes(s)
        );
    }
    switch (cache.filter) {
        case 'trial':     rows = rows.filter(r => r.plan === 'trial' && !r.is_expired_trial); break;
        case 'paid':      rows = rows.filter(r => ['starter','growth','enterprise'].includes(r.plan)); break;
        case 'suspended': rows = rows.filter(r => r.plan === 'suspended' || !r.is_active); break;
        case 'expired':   rows = rows.filter(r => r.is_expired_trial); break;
    }

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty">No clinics match this filter.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(c => {
        const planClass = c.plan === 'suspended' ? 'suspended' : c.plan;
        const trialCell = c.plan === 'trial'
            ? (c.trial_ends_at ? (c.is_expired_trial ? `<span class="badge suspended">expired</span> ${fmtDate(c.trial_ends_at)}` : fmtRelative(c.trial_ends_at)) : '—')
            : '<span class="muted">—</span>';
        const slugCell = c.slug
            ? `<a href="https://${esc(c.slug)}.easymed.uz/admin" target="_blank">${esc(c.slug)}.easymed.uz</a>`
            : '<span class="muted">—</span>';
        return `
            <tr>
                <td>
                    <strong>${esc(c.name)}</strong>
                    ${!c.is_active ? '<br><span class="badge inactive">inactive</span>' : ''}
                    ${c.email ? `<br><span class="muted" style="font-size:11.5px">${esc(c.email)}</span>` : ''}
                </td>
                <td class="muted">${slugCell}</td>
                <td><span class="badge ${planClass}">${esc(c.plan)}</span></td>
                <td>${trialCell}</td>
                <td class="num">${c.user_count}</td>
                <td class="muted">${fmtRelative(c.created_at)}</td>
                <td>
                    <button class="btn small" data-act="edit"    data-id="${esc(c.id)}">Edit</button>
                    ${c.plan === 'suspended' || !c.is_active
                        ? `<button class="btn small primary" data-act="reactivate" data-id="${esc(c.id)}">Reactivate</button>`
                        : `<button class="btn small danger"  data-act="suspend"    data-id="${esc(c.id)}">Suspend</button>`}
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('[data-act]').forEach(b => {
        b.addEventListener('click', () => handleAction(b.dataset.act, b.dataset.id));
    });
}

function handleAction(act, id) {
    const c = cache.rows.find(r => r.id === id);
    if (!c) return;
    if (act === 'edit')        return openEditModal(c);
    if (act === 'suspend')     return updatePlan(c, { plan: 'suspended', is_active: false }, 'Clinic suspended.');
    if (act === 'reactivate')  return updatePlan(c, { plan: c.plan === 'suspended' ? 'starter' : c.plan, is_active: true }, 'Clinic reactivated.');
}

async function updatePlan(c, patch, okMsg) {
    if (!confirm(`Apply this change to "${c.name}"?`)) return;
    const { supabase } = mountedCtx;
    const { error } = await supabase.from('companies').update(patch).eq('id', c.id);
    if (error) { toast('Update failed: ' + error.message, 'err'); return; }
    toast(okMsg, 'ok');
    await loadAndRender();
}

function openEditModal(c) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const trialIso = c.trial_ends_at ? new Date(c.trial_ends_at).toISOString().slice(0,10) : '';
    overlay.innerHTML = `
      <div class="modal">
        <h3>Edit ${esc(c.name)}</h3>
        <p class="sub">${esc(c.slug || '')}.easymed.uz · created ${fmtDate(c.created_at)}</p>
        <div class="row">
          <label>Plan</label>
          <select id="m-plan">
            <option value="trial">Trial</option>
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
            <option value="enterprise">Enterprise</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
        <div class="row" id="m-trial-row">
          <label>Trial ends at</label>
          <input type="date" id="m-trial">
          <div class="sub" style="margin:6px 0 0">Set blank to remove the trial deadline (e.g. for enterprise).</div>
        </div>
        <div class="row">
          <label><input type="checkbox" id="m-active"> Active</label>
        </div>
        <div class="modal-err" id="m-err"></div>
        <div class="modal-actions">
          <button class="btn" id="m-cancel">Cancel</button>
          <button class="btn small" id="m-extend">+7 days trial</button>
          <button class="btn primary" id="m-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#m-plan').value   = c.plan;
    overlay.querySelector('#m-trial').value  = trialIso;
    overlay.querySelector('#m-active').checked = !!c.is_active;
    const close = () => overlay.remove();
    overlay.querySelector('#m-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#m-extend').addEventListener('click', () => {
        const current = overlay.querySelector('#m-trial').value;
        const base = current ? new Date(current) : new Date();
        base.setDate(base.getDate() + 7);
        overlay.querySelector('#m-trial').value = base.toISOString().slice(0,10);
    });

    overlay.querySelector('#m-save').addEventListener('click', async () => {
        const plan        = overlay.querySelector('#m-plan').value;
        const trialEnds   = overlay.querySelector('#m-trial').value || null;
        const isActive    = overlay.querySelector('#m-active').checked;
        const patch = { plan, is_active: isActive, trial_ends_at: trialEnds };
        const { supabase } = mountedCtx;
        const errEl = overlay.querySelector('#m-err');
        errEl.textContent = '';
        const { error } = await supabase.from('companies').update(patch).eq('id', c.id);
        if (error) { errEl.textContent = error.message; return; }
        toast('Clinic updated.', 'ok');
        close();
        await loadAndRender();
    });
}
