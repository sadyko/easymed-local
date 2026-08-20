// Platform → Signup requests. Review pending clinic signups + approve / reject.
// Approval marks the request as 'approved' — the actual provisioning happens
// when the prospect uses the wizard at easymed.uz (signup_clinic RPC).
// Rejection just records the decision.

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], filter: 'pending' };

export async function renderSignupRequests(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <button class="chip on" data-filter="pending">Pending</button>
        <button class="chip"    data-filter="approved">Approved</button>
        <button class="chip"    data-filter="rejected">Rejected</button>
        <button class="chip"    data-filter="all">All</button>
        <button class="btn primary" id="sr-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Submitted</th>
                <th>Clinic</th>
                <th>Subdomain</th>
                <th>Admin</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="sr-body">
              <tr><td colspan="6" class="row-loading"><div class="spinner"></div>Loading…</td></tr>
            </tbody>
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
    root.querySelector('#sr-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const { data, error } = await supabase
        .from('clinic_signup_requests')
        .select('id, clinic_name, desired_slug, admin_full_name, admin_phone, admin_email, message, referral_source, status, created_at, reviewed_at, review_notes, provisioned_company_id')
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) { mountedRoot.querySelector('#sr-body').innerHTML = `<tr><td colspan="6" class="empty">Failed: ${esc(error.message)}</td></tr>`; return; }
    cache.rows = data || [];
    renderRows();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#sr-body');
    if (!tbody) return;
    let rows = cache.rows;
    if (cache.filter !== 'all') rows = rows.filter(r => r.status === cache.filter);

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">No requests in this filter.</td></tr>`;
        if (mountedCtx?.refreshBadges) mountedCtx.refreshBadges();
        return;
    }

    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${fmtRelative(r.created_at)}</td>
            <td><strong>${esc(r.clinic_name)}</strong></td>
            <td class="muted">${esc(r.desired_slug)}.easymed.uz</td>
            <td>
                ${esc(r.admin_full_name)}<br>
                <span class="muted" style="font-size:11.5px">${esc(r.admin_email)}${r.admin_phone ? ' · ' + esc(r.admin_phone) : ''}</span>
            </td>
            <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td>
            <td>
                <button class="btn small" data-act="open" data-id="${esc(r.id)}">Details</button>
                ${r.status === 'pending' ? `
                    <button class="btn small primary" data-act="approve" data-id="${esc(r.id)}">Approve</button>
                    <button class="btn small danger"  data-act="reject"  data-id="${esc(r.id)}">Reject</button>
                ` : ''}
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => handleAction(b.dataset.act, b.dataset.id)));
    if (mountedCtx?.refreshBadges) mountedCtx.refreshBadges();
}

async function handleAction(act, id) {
    const r = cache.rows.find(x => x.id === id);
    if (!r) return;
    if (act === 'open') return openDetail(r);
    if (act === 'approve' || act === 'reject') return setStatus(r, act === 'approve' ? 'approved' : 'rejected');
}

async function setStatus(r, status) {
    const note = prompt(`${status === 'approved' ? 'Approve' : 'Reject'} "${r.clinic_name}" — optional notes:`, '');
    if (note === null) return;
    const { supabase } = mountedCtx;
    const patch = { status, reviewed_at: new Date().toISOString(), review_notes: note || null };
    const { error } = await supabase.from('clinic_signup_requests').update(patch).eq('id', r.id);
    if (error) { toast('Failed: ' + error.message, 'err'); return; }
    toast('Marked ' + status + '.', 'ok');
    await loadAndRender();
}

function openDetail(r) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px">
        <h3>${esc(r.clinic_name)}</h3>
        <p class="sub">Submitted ${fmtRelative(r.created_at)} · <span class="badge ${esc(r.status)}">${esc(r.status)}</span></p>
        <div class="row"><label>Desired subdomain</label><div>${esc(r.desired_slug)}.easymed.uz</div></div>
        <div class="row"><label>Admin name</label><div>${esc(r.admin_full_name)}</div></div>
        <div class="row"><label>Admin email</label><div>${esc(r.admin_email)}</div></div>
        <div class="row"><label>Admin phone</label><div>${esc(r.admin_phone || '—')}</div></div>
        <div class="row"><label>Message</label><div style="white-space:pre-wrap">${esc(r.message || '—')}</div></div>
        <div class="row"><label>Referral source</label><div>${esc(r.referral_source || '—')}</div></div>
        <div class="row"><label>Reviewed</label><div>${r.reviewed_at ? fmtRelative(r.reviewed_at) : '—'}</div></div>
        ${r.review_notes ? `<div class="row"><label>Review notes</label><div style="white-space:pre-wrap">${esc(r.review_notes)}</div></div>` : ''}

        <div class="row" style="border-top:1px solid rgba(255,255,255,0.08); padding-top:12px; margin-top:4px">
          <label>Debug access</label>
          <div id="d-debug-access">
            ${r.provisioned_company_id ? `
              <div class="sub" style="margin:0 0 8px">
                Passwords are stored hashed and can't be shown. Reset to a temporary
                one to log into the clinic — tell the admin afterwards.
              </div>
              <button class="btn small" id="d-reset-pass">Reset admin password</button>
              <div id="d-temp-pass" style="margin-top:8px"></div>
            ` : `<div class="sub" style="margin:0">Clinic not provisioned yet — no account exists.</div>`}
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn" id="d-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#d-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const resetBtn = overlay.querySelector('#d-reset-pass');
    if (resetBtn) resetBtn.addEventListener('click', () => resetClinicAdminPassword(r, overlay));
}

// Generate a readable temp password: no 0/O/1/I/l ambiguity, 10 chars.
function genTempPassword() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let out = '';
    const rnd = new Uint32Array(10);
    crypto.getRandomValues(rnd);
    for (const n of rnd) out += alphabet[n % alphabet.length];
    return out;
}

// Reset the clinic's admin password to a fresh temp value and show it once.
// Uses admin_reset_user_password (migration 043) — SECURITY DEFINER, guarded
// on current_user_is_admin(), so only platform admins can trigger it.
async function resetClinicAdminPassword(r, overlay) {
    const { supabase } = mountedCtx;
    const btn = overlay.querySelector('#d-reset-pass');
    const out = overlay.querySelector('#d-temp-pass');

    // Find the clinic's admin user — earliest admin of the provisioned company.
    btn.disabled = true;
    const { data: admins, error: uErr } = await supabase
        .from('users')
        .select('id, full_name, username, email, role')
        .eq('company_id', r.provisioned_company_id)
        .eq('role', 'admin')
        .order('created_at', { ascending: true })
        .limit(1);
    if (uErr || !admins || !admins.length) {
        btn.disabled = false;
        toast('Admin user not found: ' + (uErr?.message || 'no admin in this clinic'), 'err');
        return;
    }
    const admin = admins[0];
    const login = admin.email || admin.username || r.admin_email;

    if (!confirm(`Reset the password for "${admin.full_name}" (${login})?\n\nTheir current password stops working immediately. Tell them the new one after you finish debugging.`)) {
        btn.disabled = false;
        return;
    }

    const temp = genTempPassword();
    const { error } = await supabase.rpc('admin_reset_user_password', {
        target_user_id: admin.id,
        new_password:   temp,
    });
    btn.disabled = false;
    if (error) { toast('Reset failed: ' + error.message, 'err'); return; }

    out.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; padding:10px 12px; background:rgba(46,160,67,0.12); border:1px solid rgba(46,160,67,0.4); border-radius:8px;">
        <div style="flex:1; min-width:0">
          <div style="font-size:11px; opacity:.7">Login: <b>${esc(login)}</b></div>
          <div style="font-family:ui-monospace,monospace; font-size:15px; font-weight:700; letter-spacing:.05em" id="d-temp-value">${esc(temp)}</div>
        </div>
        <button class="btn small" id="d-copy-pass">Copy</button>
      </div>
      <div class="sub" style="margin-top:6px">Shown once — it is not stored anywhere. Log in at ${esc(r.desired_slug)}.easymed.uz/admin.</div>
    `;
    out.querySelector('#d-copy-pass').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(temp); toast('Copied.', 'ok'); }
        catch { toast('Copy failed — select it manually.', 'err'); }
    });
    toast('Password reset. Use the temporary password to sign in.', 'ok');
}
