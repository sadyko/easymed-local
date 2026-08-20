// Platform → Platform team. Lists the people who have access to this
// console (anyone with users.platform_role set OR is_super_admin=true)
// and lets the super admin add new colleagues with a chosen role.
//
// Role permissions live in the parent js/setting.js PLATFORM_ROLE_SECTIONS
// map (hardcoded for now). When v2 moves them to a roles editor UI this
// page also gets a "Roles" tab.

import { esc, fmtRelative, toast } from '../../setting.js';

const ROLE_OPTIONS = [
    { id: 'super_admin', label: 'Super Admin', desc: 'Full platform access — every section, plus add/remove other team members.' },
    { id: 'admin',       label: 'Admin',       desc: 'Everything except Platform settings. Cannot manage the team.' },
    { id: 'operator',    label: 'Operator',    desc: 'Dashboard, Verifications, Signup requests, Audit log. Read-mostly.' },
];

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], search: '' };

export async function renderPlatformTeam(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <input class="search" id="pt-search" placeholder="Search name, email, role…">
        <button class="btn primary" id="pt-add" style="margin-left:auto">+ Add team member</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Team member</th>
                <th>Email</th>
                <th>Platform role</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="pt-body">
              <tr><td colspan="6" class="row-loading"><div class="spinner"></div>Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
    root.querySelector('#pt-search').addEventListener('input', e => {
        cache.search = e.target.value.toLowerCase();
        renderRows();
    });
    root.querySelector('#pt-add').addEventListener('click', openAddModal);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const { data, error } = await supabase
        .from('users')
        .select('id, full_name, username, email, platform_role, is_super_admin, active, created_at, auth_user_id')
        .or('platform_role.not.is.null,is_super_admin.eq.true')
        .order('created_at', { ascending: false });
    if (error) {
        mountedRoot.querySelector('#pt-body').innerHTML = `<tr><td colspan="6" class="empty">Failed: ${esc(error.message)}</td></tr>`;
        return;
    }
    cache.rows = data || [];
    renderRows();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#pt-body');
    if (!tbody) return;
    let rows = cache.rows;
    if (cache.search) {
        const s = cache.search;
        rows = rows.filter(r =>
            (r.full_name || '').toLowerCase().includes(s)
            || (r.email     || '').toLowerCase().includes(s)
            || (r.username  || '').toLowerCase().includes(s)
            || (r.platform_role || '').toLowerCase().includes(s)
        );
    }
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">No platform team members yet. Click + Add team member to invite a colleague.</td></tr>`;
        return;
    }

    tbody.innerHTML = rows.map(u => {
        const roleLabel = labelForRole(u.platform_role);
        const isSuper = u.is_super_admin || u.platform_role === 'super_admin';
        return `
            <tr>
                <td>
                    <strong>${esc(u.full_name || '(no name)')}</strong>
                    ${u.username ? `<br><span class="muted" style="font-size:11.5px">${esc(u.username)}</span>` : ''}
                </td>
                <td class="muted" style="font-family:monospace;font-size:12px">${esc(u.email || '—')}</td>
                <td>
                    ${isSuper ? '<span class="badge enterprise">super</span> ' : ''}
                    ${esc(roleLabel)}
                </td>
                <td>
                    ${u.active ? '<span class="badge approved">active</span>' : '<span class="badge inactive">inactive</span>'}
                    ${u.auth_user_id ? '' : '<br><span class="muted" style="font-size:11px">no login</span>'}
                </td>
                <td class="muted">${fmtRelative(u.created_at)}</td>
                <td>
                    <select class="role-select" data-id="${esc(u.id)}" style="height:28px;border-radius:6px;border:1px solid #2c3a4d;background:#0a1019;color:#e6edf3;padding:0 6px;font-size:12px;margin-right:6px">
                        ${ROLE_OPTIONS.map(r => `<option value="${r.id}" ${u.platform_role === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
                        <option value="" ${u.platform_role ? '' : 'selected'}>— remove access —</option>
                    </select>
                    <button class="btn small edit-btn" data-id="${esc(u.id)}">Edit</button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', () => onRoleChange(sel.dataset.id, sel.value, sel));
    });
    tbody.querySelectorAll('.edit-btn').forEach(b => {
        b.addEventListener('click', () => {
            const u = cache.rows.find(r => r.id === b.dataset.id);
            if (u) openEditModal(u);
        });
    });
}

// ---------------------------------------------------------------------------
// Edit modal — change full name, email, and (optionally) password.
// All three are routed through the admin_update_team_member RPC (migration
// 047) which atomically syncs auth.users + public.users so the team member
// can keep logging in with the new email immediately.
// ---------------------------------------------------------------------------
function openEditModal(u) {
    const overlay = document.createElement('div');
    overlay.id = 'pt-edit-overlay';
    overlay.setAttribute('style', [
        'position:fixed', 'inset:0', 'z-index:9999',
        'background:rgba(11,16,21,0.55)',
        'display:grid', 'place-items:center',
    ].join(';'));

    overlay.innerHTML = `
        <div style="
            width:460px; max-width:calc(100vw - 32px); background:#0f1822;
            border:1px solid #243245; border-radius:14px;
            box-shadow:0 24px 60px rgba(0,0,0,0.5);
            padding:22px; color:#e6edf3; font-family:inherit;
            max-height:calc(100vh - 48px); overflow-y:auto;
        ">
            <div style="font-size:16px; font-weight:700; margin-bottom:4px">
                Edit team member
            </div>
            <div style="font-size:12px; color:#7a8a9a; margin-bottom:18px">
                ${esc(labelForRole(u.platform_role))} · changes apply on save
            </div>

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">Full name</label>
            <input id="pt-edit-name" type="text"
                value="${esc(u.full_name || '')}"
                style="width:100%; box-sizing:border-box; height:36px; padding:0 12px; border-radius:8px; border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3; font-size:14px; margin-bottom:14px">

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">Email</label>
            <input id="pt-edit-email" type="email" autocomplete="off"
                value="${esc(u.email || '')}"
                style="width:100%; box-sizing:border-box; height:36px; padding:0 12px; border-radius:8px; border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3; font-family:monospace; font-size:14px; margin-bottom:6px">
            <div style="font-size:11.5px; color:#7a8a9a; margin-bottom:14px">
                Email is also their login identifier. Changing it takes effect on next sign-in.
            </div>

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">New password (optional)</label>
            <div style="display:flex; gap:8px; margin-bottom:6px">
                <input id="pt-edit-pwd" type="text" autocomplete="new-password"
                    placeholder="Leave blank to keep current password"
                    style="flex:1; height:36px; padding:0 12px; border-radius:8px; border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3; font-family:monospace; font-size:14px">
                <button id="pt-edit-gen" class="btn small" type="button">Generate</button>
            </div>
            <div style="font-size:11.5px; color:#7a8a9a; margin-bottom:18px">
                Visible while you type so you can copy + share via Telegram before saving.
            </div>

            <div style="display:flex; gap:8px; justify-content:flex-end">
                <button id="pt-edit-cancel" class="btn small" type="button">Cancel</button>
                <button id="pt-edit-save"   class="btn small primary" type="button">Save changes</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    const nameEl   = overlay.querySelector('#pt-edit-name');
    const emailEl  = overlay.querySelector('#pt-edit-email');
    const pwdEl    = overlay.querySelector('#pt-edit-pwd');
    const cancelEl = overlay.querySelector('#pt-edit-cancel');
    const saveEl   = overlay.querySelector('#pt-edit-save');
    const genEl    = overlay.querySelector('#pt-edit-gen');

    const close = () => overlay.remove();
    cancelEl.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    genEl.addEventListener('click', () => {
        const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
        const arr = new Uint8Array(10);
        crypto.getRandomValues(arr);
        pwdEl.value = Array.from(arr, b => alphabet[b % alphabet.length]).join('');
        pwdEl.focus(); pwdEl.select();
    });

    saveEl.addEventListener('click', async () => {
        const fullName = nameEl.value.trim();
        const email    = emailEl.value.trim().toLowerCase();
        const pwd      = pwdEl.value;
        if (!fullName) { toast('Full name is required.', 'err'); nameEl.focus(); return; }
        if (!email || !email.includes('@')) { toast('Valid email is required.', 'err'); emailEl.focus(); return; }
        if (pwd && pwd.length < 6) { toast('Password must be at least 6 characters (or blank to keep current).', 'err'); pwdEl.focus(); return; }

        saveEl.disabled = true;
        const { supabase } = mountedCtx;
        const { error } = await supabase.rpc('admin_update_team_member', {
            p_user_id:   u.id,
            p_full_name: fullName,
            p_email:     email,
            p_password:  pwd || null,
        });
        saveEl.disabled = false;
        if (error) {
            toast('Failed: ' + (error.message || error), 'err');
            return;
        }
        toast(`Updated ${fullName}.`, 'ok');
        close();
        await loadAndRender();
    });

    setTimeout(() => nameEl.focus(), 0);
}

function labelForRole(role) {
    const opt = ROLE_OPTIONS.find(r => r.id === role);
    return opt ? opt.label : (role || '—');
}

async function onRoleChange(userId, newRole, selEl) {
    const u = cache.rows.find(r => r.id === userId);
    if (!u) return;
    const action = newRole === '' ? 'Remove platform access from' : `Set role to ${labelForRole(newRole)} for`;
    if (!confirm(`${action} ${u.full_name || u.email}?`)) {
        selEl.value = u.platform_role || '';
        return;
    }
    selEl.disabled = true;
    const { supabase } = mountedCtx;
    const { error } = await supabase.rpc('admin_set_platform_role', {
        p_user_id: userId,
        p_platform_role: newRole || null,
    });
    selEl.disabled = false;
    if (error) {
        toast('Failed: ' + (error.message || error), 'err');
        selEl.value = u.platform_role || '';
        return;
    }
    toast('Role updated.', 'ok');
    await loadAndRender();
}

// ---------------------------------------------------------------------------
// Add team member modal
// ---------------------------------------------------------------------------
function openAddModal() {
    const overlay = document.createElement('div');
    overlay.id = 'pt-add-overlay';
    overlay.setAttribute('style', [
        'position:fixed', 'inset:0', 'z-index:9999',
        'background:rgba(11,16,21,0.55)',
        'display:grid', 'place-items:center',
    ].join(';'));

    const roleOptionsHtml = ROLE_OPTIONS.map(r => `
        <label style="display:flex; gap:10px; padding:10px 12px; border-radius:8px; border:1px solid #2c3a4d; cursor:pointer; margin-bottom:8px; background:#0a1019">
            <input type="radio" name="pt-role" value="${r.id}" style="margin-top:3px" ${r.id === 'admin' ? 'checked' : ''}>
            <div>
                <div style="font-size:13px; font-weight:600; color:#e6edf3">${r.label}</div>
                <div style="font-size:11.5px; color:#7a8a9a; margin-top:2px">${r.desc}</div>
            </div>
        </label>
    `).join('');

    overlay.innerHTML = `
        <div style="
            width:460px; max-width:calc(100vw - 32px); background:#0f1822;
            border:1px solid #243245; border-radius:14px;
            box-shadow:0 24px 60px rgba(0,0,0,0.5);
            padding:22px; color:#e6edf3; font-family:inherit;
            max-height:calc(100vh - 48px); overflow-y:auto;
        ">
            <div style="font-size:16px; font-weight:700; margin-bottom:4px">Add team member</div>
            <div style="font-size:12px; color:#7a8a9a; margin-bottom:18px">
                Creates a Supabase Auth account for your colleague. They can sign in
                immediately with the email and password you set here.
            </div>

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">Full name</label>
            <input id="pt-add-name" type="text" placeholder="e.g. Anvar Karimov"
                style="width:100%; box-sizing:border-box; height:36px; padding:0 12px; border-radius:8px; border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3; font-size:14px; margin-bottom:14px">

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">Email</label>
            <input id="pt-add-email" type="email" placeholder="anvar@easymed.uz" autocomplete="off"
                style="width:100%; box-sizing:border-box; height:36px; padding:0 12px; border-radius:8px; border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3; font-family:monospace; font-size:14px; margin-bottom:14px">

            <label style="display:block; font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:6px">Password</label>
            <div style="display:flex; gap:8px; margin-bottom:18px">
                <input id="pt-add-pwd" type="text" placeholder="Set a password (min 6 characters)"
                    style="flex:1; box-sizing:border-box; height:36px; padding:0 12px; border-radius:8px; border:1px solid #2c3a4d; background:#0a1019; color:#e6edf3; font-family:monospace; font-size:14px">
                <button id="pt-add-gen" class="btn small" type="button">Generate</button>
            </div>

            <div style="font-size:12px; font-weight:600; color:#a8b6c5; margin-bottom:8px">Role</div>
            ${roleOptionsHtml}

            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px">
                <button id="pt-add-cancel" class="btn small" type="button">Cancel</button>
                <button id="pt-add-save" class="btn small primary" type="button">Create account</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    const nameEl   = overlay.querySelector('#pt-add-name');
    const emailEl  = overlay.querySelector('#pt-add-email');
    const pwdEl    = overlay.querySelector('#pt-add-pwd');
    const genEl    = overlay.querySelector('#pt-add-gen');
    const cancelEl = overlay.querySelector('#pt-add-cancel');
    const saveEl   = overlay.querySelector('#pt-add-save');

    const close = () => overlay.remove();
    cancelEl.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    genEl.addEventListener('click', () => {
        const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
        const arr = new Uint8Array(10);
        crypto.getRandomValues(arr);
        pwdEl.value = Array.from(arr, b => alphabet[b % alphabet.length]).join('');
        pwdEl.focus(); pwdEl.select();
    });

    saveEl.addEventListener('click', async () => {
        const fullName = nameEl.value.trim();
        const email    = emailEl.value.trim().toLowerCase();
        const password = pwdEl.value;
        const role     = overlay.querySelector('input[name="pt-role"]:checked')?.value;

        if (!fullName) { toast('Full name is required.', 'err'); nameEl.focus(); return; }
        if (!email || !email.includes('@')) { toast('Enter a valid email.', 'err'); emailEl.focus(); return; }
        if (!password || password.length < 6) { toast('Password must be at least 6 characters.', 'err'); pwdEl.focus(); return; }
        if (!role) { toast('Pick a role.', 'err'); return; }

        saveEl.disabled = true;
        const { supabase } = mountedCtx;
        const { data: newId, error } = await supabase.rpc('admin_create_platform_user', {
            p_email:         email,
            p_full_name:     fullName,
            p_password:      password,
            p_platform_role: role,
        });
        saveEl.disabled = false;
        if (error) {
            toast('Failed: ' + (error.message || error), 'err');
            return;
        }
        toast(`Created ${fullName}. They can sign in at this console.`, 'ok');
        close();
        await loadAndRender();
    });

    setTimeout(() => nameEl.focus(), 0);
}
