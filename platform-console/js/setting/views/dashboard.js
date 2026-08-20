// Platform dashboard — live KPIs across the whole tenancy.

import { esc, fmtRelative } from '../../setting.js';

// DASH_RESILIENT_V1 — never let one hung/slow request freeze the whole
// dashboard. Previously the sections were awaited sequentially with no timeout,
// so a single client-side stall left EVERY card "…" and EVERY table "Loading…"
// forever (silently, because the paint helpers are null-safe). Now each section
// loads independently with a hard timeout, so a stuck query surfaces as a
// visible per-section error instead of an endless spinner.
const Q_TIMEOUT_MS = 12000;
function withTimeout(p, label) {
    return Promise.race([
        Promise.resolve(p),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('timeout after ' + (Q_TIMEOUT_MS / 1000) + 's: ' + label)), Q_TIMEOUT_MS)),
    ]);
}

export async function renderDashboard(root, { supabase, navigate }) {
    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Total clinics</div><div class="kpi-value" id="kpi-clinics">…</div><div class="kpi-delta" id="kpi-clinics-delta">&nbsp;</div></div>
        <div class="kpi"><div class="kpi-label">On trial</div>     <div class="kpi-value" id="kpi-trial">…</div>  <div class="kpi-delta" id="kpi-trial-delta">&nbsp;</div></div>
        <div class="kpi"><div class="kpi-label">Paid plans</div>   <div class="kpi-value" id="kpi-paid">…</div>   <div class="kpi-delta" id="kpi-paid-delta">&nbsp;</div></div>
        <div class="kpi"><div class="kpi-label">Total users</div>  <div class="kpi-value" id="kpi-users">…</div>  <div class="kpi-delta" id="kpi-users-delta">&nbsp;</div></div>
      </div>

      <div class="card">
        <h2>Trials expiring soon</h2>
        <div class="table-wrap">
          <table class="t" id="expiring-table">
            <thead><tr><th>Clinic</th><th>Subdomain</th><th>Trial ends</th><th>Signed up</th><th></th></tr></thead>
            <tbody><tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Recently signed-up clinics</h2>
        <div class="table-wrap">
          <table class="t" id="recent-table">
            <thead><tr><th>Clinic</th><th>Subdomain</th><th>Plan</th><th>Created</th><th>Users</th></tr></thead>
            <tbody><tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Pending signup requests</h2>
        <div class="table-wrap">
          <table class="t" id="pending-table">
            <thead><tr><th>Clinic</th><th>Subdomain</th><th>Admin</th><th>Submitted</th><th></th></tr></thead>
            <tbody><tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Upgrade requests waiting for a callback</h2>
        <div class="table-wrap">
          <table class="t" id="upgrade-table">
            <thead><tr><th>Clinic</th><th>Manager</th><th>Phone</th><th>Plan interest</th><th>Submitted</th><th></th></tr></thead>
            <tbody><tr><td colspan="6" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    `;

    // ---- KPI counts (parallel queries, timeout-guarded) --------------
    try {
        const [allCo, trialCo, paidCo, usersAll, usersActive] = await withTimeout(Promise.all([
            supabase.from('companies').select('id', { count: 'exact', head: true }),
            supabase.from('companies').select('id', { count: 'exact', head: true }).eq('plan', 'trial'),
            supabase.from('companies').select('id', { count: 'exact', head: true }).in('plan', ['starter','growth','enterprise']),
            supabase.from('users').select('id', { count: 'exact', head: true }),
            supabase.from('users').select('id', { count: 'exact', head: true }).eq('active', true),
        ]), 'KPI counts');

        setKpi('kpi-clinics', allCo.count);
        setKpi('kpi-trial',   trialCo.count);
        setKpi('kpi-paid',    paidCo.count);
        setKpi('kpi-users',   usersAll.count);

        setText('kpi-users-delta', `${usersActive.count || 0} active`);
        const trialPct = allCo.count ? Math.round((trialCo.count / allCo.count) * 100) : 0;
        setText('kpi-trial-delta', `${trialPct}% of clinics`);
        const paidPct = allCo.count ? Math.round((paidCo.count / allCo.count) * 100) : 0;
        setText('kpi-paid-delta', `${paidPct}% of clinics`);
    } catch (e) {
        console.warn('[dashboard] KPI counts failed:', e);
        for (const id of ['kpi-clinics', 'kpi-trial', 'kpi-paid', 'kpi-users']) setText(id, '—');
        const grid = root.querySelector('.kpi-grid');
        if (grid) grid.insertAdjacentHTML('afterend',
            `<div class="empty" style="color:#f87171;margin:-8px 0 12px">Показатели не загрузились: ${esc(e.message)}</div>`);
    }

    // ---- Trials expiring (next 7 days) ------------------------------
    try {
        const in7d = new Date(Date.now() + 7 * 86400000).toISOString();
        const { data: expiring } = await withTimeout(supabase
            .from('companies')
            .select('id, name, slug, trial_ends_at, created_at')
            .eq('plan', 'trial')
            .not('trial_ends_at', 'is', null)
            .lte('trial_ends_at', in7d)
            .order('trial_ends_at', { ascending: true })
            .limit(10), 'trials expiring');
        paintTable('expiring-table',
            (expiring || []).map(c => `
                <tr>
                    <td><strong>${esc(c.name)}</strong></td>
                    <td class="muted"><a href="https://${esc(c.slug)}.easymed.uz/admin" target="_blank">${esc(c.slug)}.easymed.uz</a></td>
                    <td>${fmtRelative(c.trial_ends_at)}</td>
                    <td class="muted">${fmtRelative(c.created_at)}</td>
                    <td><button class="btn small" data-open-clinic="${esc(c.id)}">Open</button></td>
                </tr>
            `).join(''),
            'No trials expiring in the next 7 days.'
        );
    } catch (e) { paintTableError('expiring-table', 5, e); }

    // ---- Recent clinics ---------------------------------------------
    try {
        const { data: recent } = await withTimeout(supabase
            .from('companies')
            .select('id, name, slug, plan, created_at')
            .order('created_at', { ascending: false })
            .limit(8), 'recent clinics');
        const recentIds = (recent || []).map(c => c.id);
        let userCounts = {};
        if (recentIds.length) {
            const { data: ucs } = await withTimeout(supabase
                .from('users')
                .select('company_id', { count: 'exact' })
                .in('company_id', recentIds), 'recent user counts');
            for (const u of (ucs || [])) {
                userCounts[u.company_id] = (userCounts[u.company_id] || 0) + 1;
            }
        }
        paintTable('recent-table',
            (recent || []).map(c => `
                <tr>
                    <td><strong>${esc(c.name)}</strong></td>
                    <td class="muted">${esc(c.slug || '—')}</td>
                    <td><span class="badge ${esc(c.plan)}">${esc(c.plan)}</span></td>
                    <td class="muted">${fmtRelative(c.created_at)}</td>
                    <td class="num">${userCounts[c.id] || 0}</td>
                </tr>
            `).join(''),
            'No clinics yet.'
        );
    } catch (e) { paintTableError('recent-table', 5, e); }

    // ---- Pending signup requests ------------------------------------
    try {
        const { data: pending } = await withTimeout(supabase
            .from('clinic_signup_requests')
            .select('id, clinic_name, desired_slug, admin_full_name, admin_email, created_at')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(8), 'pending signups');
        paintTable('pending-table',
            (pending || []).map(p => `
                <tr>
                    <td><strong>${esc(p.clinic_name)}</strong></td>
                    <td class="muted">${esc(p.desired_slug)}.easymed.uz</td>
                    <td>${esc(p.admin_full_name)}<br><span class="muted" style="font-size:11.5px">${esc(p.admin_email)}</span></td>
                    <td class="muted">${fmtRelative(p.created_at)}</td>
                    <td><button class="btn small" data-goto="signup-requests">Review</button></td>
                </tr>
            `).join(''),
            'No pending requests.'
        );
    } catch (e) { paintTableError('pending-table', 5, e); }

    // ---- Pending upgrade requests -----------------------------------
    try {
        const { data: upgrades } = await withTimeout(supabase
            .from('upgrade_requests')
            .select('id, clinic_name, manager_name, phone, requested_plan, created_at')
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(6), 'upgrade requests');
        paintTable('upgrade-table',
            (upgrades || []).map(u => `
                <tr>
                    <td><strong>${esc(u.clinic_name)}</strong></td>
                    <td>${esc(u.manager_name)}</td>
                    <td><a href="tel:${esc(u.phone)}">${esc(u.phone)}</a></td>
                    <td>${u.requested_plan ? `<span class="badge ${esc(u.requested_plan)}">${esc(u.requested_plan)}</span>` : '<span class="muted">—</span>'}</td>
                    <td class="muted">${fmtRelative(u.created_at)}</td>
                    <td><button class="btn small" data-goto="upgrade-requests">Open</button></td>
                </tr>
            `).join(''),
            'No upgrade requests waiting.'
        );
    } catch (e) { paintTableError('upgrade-table', 6, e); }

    // Wire interactions
    root.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.goto)));
    root.querySelectorAll('[data-open-clinic]').forEach(b => b.addEventListener('click', () => navigate('clinics')));
}

// Null-safe — if the user has navigated away while our queries were in
// flight, the KPI element is gone. Silently bail instead of throwing
// "Cannot set properties of null" (which becomes an uncaught promise
// rejection that knocks out the next view's render too).
function setKpi(id, n) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (n ?? 0).toLocaleString();
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
}

function paintTable(id, rowsHtml, emptyMsg) {
    const tbody = document.querySelector(`#${id} tbody`);
    if (!tbody) return;                          // navigated away during load
    if (!rowsHtml) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty">${esc(emptyMsg)}</td></tr>`;
        return;
    }
    tbody.innerHTML = rowsHtml;
}

// DASH_RESILIENT_V1 — show a per-section error instead of an endless spinner.
function paintTableError(id, cols, err) {
    console.warn('[dashboard]', id, err);
    const tbody = document.querySelector(`#${id} tbody`);
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty" style="color:#f87171">Ошибка загрузки: ${esc(err?.message || String(err))}</td></tr>`;
}
