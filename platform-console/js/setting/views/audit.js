// Platform → Audit log. Cross-tenant view of public.audit_log entries
// (created by migration 040). Read-only.

import { esc, fmtRelative } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], userMap: {}, search: '' };

export async function renderAudit(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <input class="search" id="au-search" placeholder="Search action, table, user…">
        <button class="btn primary" id="au-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Table</th><th>Row</th></tr></thead>
            <tbody id="au-body"><tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    `;
    root.querySelector('#au-search').addEventListener('input', e => { cache.search = e.target.value.toLowerCase(); renderRows(); });
    root.querySelector('#au-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    // Audit log was introduced in migration 040 — table may or may not exist;
    // tolerate either case.
    const tableExists = await probeTable(supabase, 'audit_log');
    const tbody = mountedRoot.querySelector('#au-body');
    if (!tableExists) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty">Audit log table not found yet (migration 040 may be pending). Nothing to show.</td></tr>`;
        return;
    }
    const { data, error } = await supabase
        .from('audit_log')
        .select('id, actor_user_id, action, table_name, row_id, occurred_at')
        .order('occurred_at', { ascending: false })
        .limit(300);
    if (error) { tbody.innerHTML = `<tr><td colspan="5" class="empty">Failed: ${esc(error.message)}</td></tr>`; return; }

    cache.rows = data || [];
    const ids = [...new Set(cache.rows.map(r => r.actor_user_id).filter(Boolean))];
    if (ids.length) {
        const { data: users } = await supabase.from('users').select('id, full_name, username').in('id', ids);
        cache.userMap = {};
        for (const u of (users || [])) cache.userMap[u.id] = u;
    } else {
        cache.userMap = {};
    }
    renderRows();
}

async function probeTable(supabase, name) {
    const { error } = await supabase.from(name).select('*', { head: true, count: 'exact' }).limit(1);
    return !error;
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#au-body');
    if (!tbody) return;
    let rows = cache.rows;
    if (cache.search) {
        const s = cache.search;
        rows = rows.filter(r => {
            const u = cache.userMap[r.actor_user_id];
            return (r.action || '').toLowerCase().includes(s)
                || (r.table_name || '').toLowerCase().includes(s)
                || (u?.full_name || '').toLowerCase().includes(s)
                || (u?.username  || '').toLowerCase().includes(s);
        });
    }
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty">No entries.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const u = cache.userMap[r.actor_user_id];
        return `
            <tr>
                <td>${fmtRelative(r.occurred_at)}</td>
                <td>${u ? esc(u.full_name || u.username) : '<span class="muted">(system)</span>'}</td>
                <td><code style="font-size:12px">${esc(r.action)}</code></td>
                <td class="muted">${esc(r.table_name || '—')}</td>
                <td class="muted copy" title="Click to copy">${esc(r.row_id || '—')}</td>
            </tr>
        `;
    }).join('');
    tbody.querySelectorAll('.copy').forEach(el => {
        el.addEventListener('click', () => navigator.clipboard.writeText(el.textContent.trim()));
    });
}
