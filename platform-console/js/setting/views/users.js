// Platform → Users (cross-tenant). Read-only directory; clinic admins manage
// their own users from their clinic's Settings page. Super admins can flip
// is_super_admin and active here.

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], companies: {}, search: '', filter: 'all' };

export async function renderUsers(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <input class="search" id="us-search" placeholder="Search name, username, email, clinic…">
        <button class="chip on" data-filter="all">All</button>
        <button class="chip"    data-filter="super">Super admins</button>
        <button class="chip"    data-filter="admin">Clinic admins</button>
        <button class="chip"    data-filter="inactive">Inactive</button>
        <button class="btn primary" id="us-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>User</th>
                <th>Clinic</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="us-body">
              <tr><td colspan="6" class="row-loading"><div class="spinner"></div>Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    root.querySelector('#us-search').addEventListener('input', e => { cache.search = e.target.value.toLowerCase(); renderRows(); });
    root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
        root.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        cache.filter = b.dataset.filter;
        renderRows();
    }));
    root.querySelector('#us-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const [usersRes, companiesRes] = await Promise.all([
        supabase.from('users')
            .select('id, full_name, username, email, role, is_super_admin, active, company_id, created_at, auth_user_id')
            .order('created_at', { ascending: false }),
        supabase.from('companies').select('id, name, slug'),
    ]);
    if (usersRes.error) {
        mountedRoot.querySelector('#us-body').innerHTML = `<tr><td colspan="6" class="empty">Failed: ${esc(usersRes.error.message)}</td></tr>`;
        return;
    }
    cache.rows = usersRes.data || [];
    cache.companies = {};
    for (const c of (companiesRes.data || [])) cache.companies[c.id] = c;
    renderRows();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#us-body');
    if (!tbody) return;
    let rows = cache.rows;

    if (cache.search) {
        const s = cache.search;
        rows = rows.filter(r => {
            const co = cache.companies[r.company_id];
            return (r.full_name || '').toLowerCase().includes(s)
                || (r.username  || '').toLowerCase().includes(s)
                || (r.email     || '').toLowerCase().includes(s)
                || (co?.name || '').toLowerCase().includes(s)
                || (co?.slug || '').toLowerCase().includes(s);
        });
    }
    switch (cache.filter) {
        case 'super':    rows = rows.filter(r => r.is_super_admin); break;
        case 'admin':    rows = rows.filter(r => r.role === 'admin' && !r.is_super_admin); break;
        case 'inactive': rows = rows.filter(r => !r.active); break;
    }

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">No users match this filter.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(u => {
        const co = cache.companies[u.company_id];
        const provisioned = !!u.auth_user_id;
        return `
            <tr>
                <td>
                    <strong>${esc(u.full_name || '(no name)')}</strong>
                    <br><span class="muted" style="font-size:11.5px">${esc(u.username || u.email || '—')}</span>
                </td>
                <td>${co ? `<strong>${esc(co.name)}</strong><br><span class="muted" style="font-size:11.5px">${esc(co.slug || '')}</span>` : '<span class="muted">—</span>'}</td>
                <td>
                    ${u.is_super_admin ? '<span class="badge enterprise">super</span> ' : ''}
                    ${esc(u.role || '—')}
                </td>
                <td>
                    ${u.active ? '<span class="badge approved">active</span>' : '<span class="badge inactive">inactive</span>'}
                    ${provisioned ? '' : '<br><span class="muted" style="font-size:11px">no login</span>'}
                </td>
                <td class="muted">${fmtRelative(u.created_at)}</td>
                <td>
                    <button class="btn small" data-act="edit" data-id="${esc(u.id)}">Edit</button>
                    ${u.is_super_admin
                        ? `<button class="btn small" data-act="unsuper" data-id="${esc(u.id)}">Revoke super</button>`
                        : `<button class="btn small" data-act="super"   data-id="${esc(u.id)}">Grant super</button>`}
                    ${u.active
                        ? `<button class="btn small danger" data-act="deact" data-id="${esc(u.id)}">Deactivate</button>`
                        : `<button class="btn small primary" data-act="act" data-id="${esc(u.id)}">Activate</button>`}
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => handleAction(b.dataset.act, b.dataset.id)));
}

async function handleAction(act, id) {
    const u = cache.rows.find(r => r.id === id);
    if (!u) return;

    if (act === 'edit') { openEditModal(u); return; }

    let patch = null;
    let confirmMsg = '';
    if (act === 'super')   { patch = { is_super_admin: true  }; confirmMsg = `Grant super-admin to ${u.full_name || u.username}?`; }
    if (act === 'unsuper') { patch = { is_super_admin: false }; confirmMsg = `Revoke super-admin from ${u.full_name || u.username}?`; }
    if (act === 'deact')   { patch = { active: false        }; confirmMsg = `Deactivate ${u.full_name || u.username}?`; }
    if (act === 'act')     { patch = { active: true         }; confirmMsg = `Activate ${u.full_name || u.username}?`; }
    if (!patch || !confirm(confirmMsg)) return;
    const { supabase } = mountedCtx;
    const { error } = await supabase.from('users').update(patch).eq('id', u.id);
    if (error) { toast('Failed: ' + error.message, 'err'); return; }
    toast('Updated.', 'ok');
    await loadAndRender();
}

// ---------------------------------------------------------------------------
// Edit modal — lets a super admin reset a user's password.
//
// Supabase Auth passwords are bcrypt-hashed and one-way, so the old password
// can't be displayed. Instead the modal lets you SET a new one in the open
// (so you can copy it before submitting and share with the user). The actual
// reset goes through the admin_reset_user_password RPC introduced in
// migration 043 — guarded server-side on current_user_is_admin().
// ---------------------------------------------------------------------------
function openEditModal(u) {
    const overlay = document.createElement('div');
    overlay.id = 'us-edit-overlay';
    overlay.setAttribute('style', [
        'position:fixed', 'inset:0', 'z-index:9999',
        'background:rgba(11,16,21,0.55)',
        'display:grid', 'place-items:center',
    ].join(';'));

    const co = cache.companies[u.company_id];
    overlay.innerHTML = `
        <div style="
            width:420px; max-width:calc(100vw - 32px); background:#0f1822;
            border:1px solid #243245; border-radius:14px;
            box-shadow:0 24px 60px rgba(0,0,0,0.5);
            padding:22px; color:#e6edf3; font-family:inherit;
        ">
            <div style="font-size:16px; font-weight:700; margin-bottom:4px">
                Edit ${esc(u.full_name || u.username || 'user')}
            </div>
            <div style="font-size:12px; color:#7a8a9a; margin-bottom:18px">
                ${esc(u.username || u.email || '—')} ·
                ${esc(co?.name || 'no clinic')} ·
                ${esc(u.role || 'no role')}${u.is_super_admin ? ' · super' : ''}
            </div>

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">
                New password
            </label>
            <div style="display:flex; gap:8px; margin-bottom:6px">
                <input id="us-edit-pwd" type="text" autocomplete="new-password"
                    placeholder="Type a new password (min 6 characters)"
                    style="flex:1; height:36px; padding:0 12px; border-radius:8px;
                           border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3;
                           font-family:monospace; font-size:14px">
                <button id="us-edit-gen" class="btn small" type="button">Generate</button>
            </div>
            <div style="font-size:11.5px; color:#7a8a9a; margin-bottom:18px">
                Set in the open so you can copy + share with the user via Telegram.
                Stored encrypted in Supabase Auth on save.
            </div>

            <div style="display:flex; gap:8px; justify-content:flex-end">
                <button id="us-edit-cancel" class="btn small" type="button">Cancel</button>
                <button id="us-edit-save"   class="btn small primary" type="button">Save password</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    const pwdEl    = overlay.querySelector('#us-edit-pwd');
    const cancelEl = overlay.querySelector('#us-edit-cancel');
    const saveEl   = overlay.querySelector('#us-edit-save');
    const genEl    = overlay.querySelector('#us-edit-gen');

    const close = () => overlay.remove();
    cancelEl.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Random base32-friendly password so the super admin doesn't have to
    // think one up. Alphabet excludes 0/O/1/I/L/U-style confusables.
    genEl.addEventListener('click', () => {
        const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
        let out = '';
        const arr = new Uint8Array(10);
        crypto.getRandomValues(arr);
        for (const b of arr) out += alphabet[b % alphabet.length];
        pwdEl.value = out;
        pwdEl.focus();
        pwdEl.select();
    });

    saveEl.addEventListener('click', async () => {
        const pwd = pwdEl.value;
        if (!pwd || pwd.length < 6) {
            toast('Password must be at least 6 characters.', 'err');
            pwdEl.focus();
            return;
        }
        saveEl.disabled = true;
        const { supabase } = mountedCtx;
        const { error } = await supabase.rpc('admin_reset_user_password', {
            target_user_id: u.id,
            new_password:   pwd,
        });
        saveEl.disabled = false;
        if (error) {
            toast('Failed: ' + (error.message || error), 'err');
            return;
        }
        toast(`Password set for ${u.full_name || u.username}.`, 'ok');
        close();
        await loadAndRender();
    });

    setTimeout(() => pwdEl.focus(), 0);
}
