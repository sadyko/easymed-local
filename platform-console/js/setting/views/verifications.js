// Platform → Verifications. Clinics awaiting document review.
// Approve/reject via review_clinic_verification RPC; after that, the
// console shows prefilled mailto: + t.me/ links so the super-admin
// can ping the new clinic admin without leaving the page.

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], docsByCompany: {}, filter: 'pending_review' };

export async function renderVerifications(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <button class="chip on" data-filter="pending_review">Pending review</button>
        <button class="chip"    data-filter="pending_documents">Awaiting upload</button>
        <button class="chip"    data-filter="rejected">Rejected</button>
        <button class="chip"    data-filter="all">All non-verified</button>
        <button class="btn primary" id="vf-refresh" style="margin-left:auto">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Clinic</th>
                <th>Subdomain</th>
                <th>Admin</th>
                <th>Documents</th>
                <th>Status</th>
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="vf-body"><tr><td colspan="7" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
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
    root.querySelector('#vf-refresh').addEventListener('click', loadAndRender);
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const [coRes, docsRes] = await Promise.all([
        supabase.from('companies')
            .select('id, name, slug, verification_status, admin_email, admin_telegram, email, rejection_reason, verified_at, created_at')
            .neq('verification_status', 'verified')
            .order('created_at', { ascending: false }),
        supabase.from('clinic_documents')
            .select('id, company_id, doc_type, file_path, file_name, file_size, content_type, uploaded_at, uploaded_by_email')
            .order('uploaded_at', { ascending: false }),
    ]);

    if (coRes.error) {
        mountedRoot.querySelector('#vf-body').innerHTML = `<tr><td colspan="7" class="empty">Failed: ${esc(coRes.error.message)}</td></tr>`;
        return;
    }
    cache.rows = coRes.data || [];
    cache.docsByCompany = {};
    for (const d of (docsRes.data || [])) {
        (cache.docsByCompany[d.company_id] ||= []).push(d);
    }
    renderRows();
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#vf-body');
    if (!tbody) return;
    let rows = cache.rows;
    if (cache.filter !== 'all') rows = rows.filter(r => r.verification_status === cache.filter);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty">No clinics in this filter.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(c => {
        const docs = cache.docsByCompany[c.id] || [];
        const docCounts = { license: 0, certificate: 0, other: 0 };
        for (const d of docs) docCounts[d.doc_type] = (docCounts[d.doc_type] || 0) + 1;
        const docBadges = ['license','certificate','other']
            .filter(k => docCounts[k] > 0)
            .map(k => `<span class="badge ${k === 'license' ? 'approved' : 'starter'}">${k} · ${docCounts[k]}</span>`)
            .join(' ') || '<span class="muted">none uploaded</span>';
        return `
            <tr>
                <td><strong>${esc(c.name)}</strong></td>
                <td class="muted"><a href="https://${esc(c.slug)}.easymed.uz/admin" target="_blank">${esc(c.slug)}.easymed.uz</a></td>
                <td>${esc(c.admin_email || c.email || '—')}${c.admin_telegram ? `<br><span class="muted" style="font-size:11.5px">@${esc(c.admin_telegram)}</span>` : ''}</td>
                <td>${docBadges}</td>
                <td><span class="badge ${esc(c.verification_status)}">${esc(c.verification_status.replace('_',' '))}</span></td>
                <td class="muted">${fmtRelative(c.created_at)}</td>
                <td>
                    <button class="btn small" data-act="open" data-id="${esc(c.id)}">Review</button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.querySelectorAll('[data-act="open"]').forEach(b => b.addEventListener('click', () => openReview(b.dataset.id)));
}

async function openReview(companyId) {
    const c = cache.rows.find(r => r.id === companyId);
    if (!c) return;
    const docs = cache.docsByCompany[c.id] || [];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:620px">
        <h3>${esc(c.name)}</h3>
        <p class="sub"><a href="https://${esc(c.slug)}.easymed.uz/admin" target="_blank">${esc(c.slug)}.easymed.uz</a> · status <span class="badge ${esc(c.verification_status)}">${esc(c.verification_status.replace('_',' '))}</span></p>
        <div class="row"><label>Admin contact</label>
          <div>${esc(c.admin_email || c.email || '—')}${c.admin_telegram ? ` · Telegram <strong>@${esc(c.admin_telegram)}</strong>` : ''}</div>
        </div>
        <div class="row"><label>Uploaded documents</label>
          <div id="vf-doc-list"></div>
        </div>
        ${c.rejection_reason ? `<div class="row"><label>Previous rejection</label><div style="white-space:pre-wrap">${esc(c.rejection_reason)}</div></div>` : ''}
        <div class="row"><label>Notes (optional, included in rejection message)</label>
          <textarea id="vf-notes" rows="2" placeholder="Why you approved / rejected"></textarea>
        </div>
        <div class="modal-err" id="vf-err"></div>
        <div class="modal-actions">
          <button class="btn" id="vf-close">Close</button>
          <button class="btn danger"  id="vf-reject">Reject</button>
          <button class="btn primary" id="vf-approve">Approve</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#vf-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Render doc list with signed URLs (15-min expiry).
    const docList = overlay.querySelector('#vf-doc-list');
    if (docs.length === 0) {
        docList.innerHTML = '<div class="muted">No documents uploaded yet.</div>';
    } else {
        docList.innerHTML = docs.map(d => `
            <div style="padding:8px 10px; border:1px solid var(--line); border-radius:8px; margin-bottom:6px; display:flex; align-items:center; gap:10px;">
                <span class="badge ${d.doc_type === 'license' ? 'approved' : 'starter'}">${esc(d.doc_type)}</span>
                <div style="flex:1; min-width:0">
                    <div style="font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${esc(d.file_name || d.file_path)}</div>
                    <div class="muted" style="font-size:11.5px">${formatBytes(d.file_size)} · ${esc(d.content_type || 'unknown')} · ${fmtRelative(d.uploaded_at)}</div>
                </div>
                <button class="btn small" data-doc-id="${esc(d.id)}" data-doc-path="${esc(d.file_path)}">View</button>
            </div>
        `).join('');
        docList.querySelectorAll('[data-doc-path]').forEach(b => b.addEventListener('click', () => openDoc(b.dataset.docPath)));
    }

    overlay.querySelector('#vf-approve').addEventListener('click', () => decide(c, 'approve', overlay));
    overlay.querySelector('#vf-reject').addEventListener('click',  () => decide(c, 'reject', overlay));
}

async function openDoc(path) {
    const { supabase } = mountedCtx;
    const { data, error } = await supabase.storage.from('clinic-docs').createSignedUrl(path, 900);
    if (error) { toast('Could not generate preview link: ' + error.message, 'err'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
}

async function decide(c, action, overlay) {
    const notes = overlay.querySelector('#vf-notes').value.trim() || null;
    if (action === 'reject' && !notes) {
        overlay.querySelector('#vf-err').textContent = 'Please add a reason — it will be sent to the clinic.';
        return;
    }
    const { supabase } = mountedCtx;
    const { data, error } = await supabase.rpc('review_clinic_verification', {
        p_company_id: c.id, p_decision: action, p_reason: notes,
    });
    if (error) { overlay.querySelector('#vf-err').textContent = error.message; return; }
    overlay.remove();
    openNotifyModal(data, action);
    await loadAndRender();
    if (mountedCtx.refreshBadges) mountedCtx.refreshBadges();
}

function openNotifyModal(result, action) {
    const subject = action === 'approve'
        ? `Your Easy-Med clinic is live — ${result.name}`
        : `Easy-Med — about your clinic application`;
    const body = action === 'approve'
        ? `Hi,\n\nGreat news — your clinic "${result.name}" has been approved and your workspace is now live.\n\n` +
          `Sign in here: ${result.login_url}\n\n` +
          `Use the email and password you set up during signup. Let me know if you need anything.\n\nEasy-Med team`
        : `Hi,\n\nThank you for applying to Easy-Med for "${result.name}". Unfortunately we were unable to approve your application at this time.\n\n` +
          `If you'd like to talk through it or resubmit with updated documents, just reply to this email.\n\nEasy-Med team`;
    const mailto = `mailto:${encodeURIComponent(result.admin_email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    const tg     = result.admin_telegram ? `https://t.me/${encodeURIComponent(result.admin_telegram)}` : null;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:520px">
        <h3>${action === 'approve' ? '✅ Approved' : '⛔ Rejected'} — notify the clinic</h3>
        <p class="sub">${esc(result.name)} · ${esc(result.slug)}.easymed.uz</p>
        <div class="row"><label>Email message (prefilled)</label>
          <textarea readonly rows="6" style="white-space:pre-wrap">${esc(body)}</textarea>
        </div>
        <div class="modal-actions">
          <button class="btn" id="nt-close">Done</button>
          ${tg ? `<a class="btn" href="${esc(tg)}" target="_blank" rel="noopener">Open Telegram</a>` : ''}
          <a class="btn primary" href="${esc(mailto)}">Open email →</a>
        </div>
        ${!tg ? '<p class="sub" style="margin-top:10px;color:var(--ink-3)">No Telegram on file. Email only.</p>' : ''}
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#nt-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    toast(action === 'approve' ? 'Clinic approved.' : 'Clinic rejected.', 'ok');
}

function formatBytes(n) {
    if (n == null)       return '?';
    if (n < 1024)        return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
}
