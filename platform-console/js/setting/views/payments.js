// Platform → Payments. Invoice list. Issue invoices from upgrade
// requests, mark them paid once the bank/cash transfer lands, and the
// clinic's plan auto-updates via the mark_payment_paid RPC.

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [], companies: {}, tariffs: [], filter: 'pending' };

export async function renderPayments(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <button class="chip on" data-filter="pending">Pending</button>
        <button class="chip"    data-filter="sent">Sent</button>
        <button class="chip"    data-filter="paid">Paid</button>
        <button class="chip"    data-filter="cancelled">Cancelled</button>
        <button class="chip"    data-filter="all">All</button>
        <button class="btn" id="py-new" style="margin-left:auto">+ New invoice</button>
        <button class="btn primary" id="py-refresh">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Clinic</th>
                <th>Tariff</th>
                <th>Period</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Issued</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="py-body"><tr><td colspan="8" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
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
    root.querySelector('#py-refresh').addEventListener('click', loadAndRender);
    root.querySelector('#py-new').addEventListener('click', () => openCreateModal(null));
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const [invRes, coRes, tfRes] = await Promise.all([
        supabase.from('payment_invoices')
            .select('id, invoice_number, company_id, tariff_key, period_months, amount, currency, status, upgrade_request_id, issued_at, due_at, sent_at, paid_at, paid_via, paid_reference, notes')
            .order('issued_at', { ascending: false })
            .limit(300),
        supabase.from('companies').select('id, name, slug, plan, admin_email, admin_telegram'),
        supabase.from('tariffs').select('key, display_name, price_monthly, price_yearly, currency').order('sort_order'),
    ]);
    if (invRes.error) {
        mountedRoot.querySelector('#py-body').innerHTML = `<tr><td colspan="8" class="empty">Failed: ${esc(invRes.error.message)}</td></tr>`;
        return;
    }
    cache.rows = invRes.data || [];
    cache.companies = {};
    for (const c of (coRes.data || [])) cache.companies[c.id] = c;
    cache.tariffs = tfRes.data || [];
    renderRows();
    if (mountedCtx.refreshBadges) mountedCtx.refreshBadges();
}

function fmtMoney(n, curr) {
    if (n == null) return '<span class="muted">—</span>';
    return new Intl.NumberFormat('en-US').format(n) + ' <span class="muted">' + esc(curr || 'UZS') + '</span>';
}
function statusBadge(s) {
    const cls = ({ pending: 'pending', sent: 'starter', paid: 'approved', cancelled: 'suspended', refunded: 'inactive' })[s] || 'inactive';
    return `<span class="badge ${cls}">${esc(s)}</span>`;
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#py-body');
    if (!tbody) return;
    let rows = cache.rows;
    if (cache.filter !== 'all') rows = rows.filter(r => r.status === cache.filter);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty">No invoices in this filter.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const co = cache.companies[r.company_id];
        return `
            <tr>
                <td><strong>${esc(r.invoice_number)}</strong></td>
                <td>${co
                    ? `<strong>${esc(co.name)}</strong><br><span class="muted" style="font-size:11.5px"><a href="https://${esc(co.slug)}.easymed.uz/admin" target="_blank">${esc(co.slug)}.easymed.uz</a></span>`
                    : '<span class="muted">—</span>'}</td>
                <td><span class="badge ${esc(r.tariff_key)}">${esc(r.tariff_key)}</span></td>
                <td class="num">${r.period_months} mo</td>
                <td class="num">${fmtMoney(r.amount, r.currency)}</td>
                <td>${statusBadge(r.status)}</td>
                <td class="muted">${fmtRelative(r.issued_at)}</td>
                <td>
                    <button class="btn small" data-act="open" data-id="${esc(r.id)}">Open</button>
                    ${r.status === 'pending' || r.status === 'sent'
                        ? `<button class="btn small primary" data-act="paid" data-id="${esc(r.id)}">Mark paid</button>`
                        : ''}
                </td>
            </tr>
        `;
    }).join('');
    tbody.querySelectorAll('[data-act="open"]').forEach(b => b.addEventListener('click', () => openInvoice(b.dataset.id)));
    tbody.querySelectorAll('[data-act="paid"]').forEach(b => b.addEventListener('click', () => quickMarkPaid(b.dataset.id)));
}

async function quickMarkPaid(id) {
    const r = cache.rows.find(x => x.id === id);
    if (!r) return;
    const co = cache.companies[r.company_id];
    if (!confirm(`Mark ${r.invoice_number} as PAID? ${co ? co.name : 'The clinic'} will switch to plan "${r.tariff_key}" immediately.`)) return;
    await markPaid(r, null, null);
}

async function markPaid(r, paid_via, paid_reference) {
    const { supabase } = mountedCtx;
    const { data, error } = await supabase.rpc('mark_payment_paid', {
        p_invoice_id: r.id,
        p_paid_via: paid_via || null,
        p_paid_reference: paid_reference || null,
    });
    if (error) { toast('Failed: ' + error.message, 'err'); return; }
    toast(`Paid. Plan switched to "${data.new_plan}".`, 'ok');
    await loadAndRender();
}

function openInvoice(id) {
    const r = cache.rows.find(x => x.id === id);
    if (!r) return;
    const co = cache.companies[r.company_id];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px">
        <h3>${esc(r.invoice_number)}</h3>
        <p class="sub">${statusBadge(r.status)} · issued ${fmtRelative(r.issued_at)}${r.paid_at ? ' · paid ' + fmtRelative(r.paid_at) : ''}</p>
        ${co ? `<div class="row"><label>Clinic</label><div><a href="https://${esc(co.slug)}.easymed.uz/admin" target="_blank">${esc(co.name)}</a> · current plan <span class="badge ${esc(co.plan)}">${esc(co.plan)}</span></div></div>` : ''}
        <div class="row" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div><label>Tariff</label><div><span class="badge ${esc(r.tariff_key)}">${esc(r.tariff_key)}</span></div></div>
          <div><label>Period</label><div>${r.period_months} months</div></div>
        </div>
        <div class="row"><label>Amount</label><div>${fmtMoney(r.amount, r.currency)}</div></div>
        ${r.paid_via       ? `<div class="row"><label>Paid via</label><div>${esc(r.paid_via)}</div></div>` : ''}
        ${r.paid_reference ? `<div class="row"><label>Reference</label><div>${esc(r.paid_reference)}</div></div>` : ''}
        ${r.notes          ? `<div class="row"><label>Notes</label><div style="white-space:pre-wrap">${esc(r.notes)}</div></div>` : ''}
        ${(r.status === 'pending' || r.status === 'sent') ? `
            <div class="row" style="border-top:1px solid var(--line); padding-top:12px; margin-top:18px;">
                <label>Mark as paid</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                  <select id="ip-via">
                    <option value="">— via —</option>
                    <option value="bank">Bank transfer</option>
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                    <option value="online">Online (Click/Payme)</option>
                    <option value="other">Other</option>
                  </select>
                  <input id="ip-ref" type="text" placeholder="Receipt # / reference">
                </div>
            </div>
        ` : ''}
        <div class="modal-err" id="ip-err"></div>
        <div class="modal-actions">
          <button class="btn" id="ip-close">Close</button>
          ${(r.status === 'pending' || r.status === 'sent') ? `
            <button class="btn danger" id="ip-cancel-inv">Cancel invoice</button>
            <button class="btn primary" id="ip-mark-paid">Mark paid ✓</button>
          ` : ''}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#ip-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#ip-mark-paid')?.addEventListener('click', async () => {
        const via = overlay.querySelector('#ip-via').value;
        const ref = overlay.querySelector('#ip-ref').value.trim();
        if (!confirm(`Mark ${r.invoice_number} as PAID and switch plan to ${r.tariff_key}?`)) return;
        overlay.remove();
        await markPaid(r, via, ref);
    });
    overlay.querySelector('#ip-cancel-inv')?.addEventListener('click', async () => {
        const reason = prompt('Reason for cancelling this invoice (optional):', '');
        if (reason === null) return;
        const { supabase } = mountedCtx;
        const { error } = await supabase.from('payment_invoices').update({
            status: 'cancelled',
            cancelled_at: new Date().toISOString(),
            cancelled_reason: reason || null,
        }).eq('id', r.id);
        if (error) { overlay.querySelector('#ip-err').textContent = error.message; return; }
        toast('Invoice cancelled.', 'ok');
        overlay.remove();
        await loadAndRender();
    });
}

// ----- Create-invoice flow (Standalone or from an upgrade request) ----
export function openCreateModal(prefillUpgradeReq) {
    const { supabase } = mountedCtx || {};
    if (!supabase) {
        // If called from another view before this view ever mounted, lazy-load.
        return import('./payments.js').then(() => openCreateModal(prefillUpgradeReq));
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:520px">
        <h3>New invoice</h3>
        <p class="sub">Pick a clinic and tariff. Amount auto-fills from the tariff; tweak if you're discounting.</p>
        <div class="row">
          <label>Clinic</label>
          <select id="nc-company">
            <option value="">— select clinic —</option>
            ${Object.values(cache.companies).sort((a,b)=>a.name.localeCompare(b.name))
                .map(c => `<option value="${esc(c.id)}" ${prefillUpgradeReq?.company_id === c.id ? 'selected' : ''}>${esc(c.name)} (${esc(c.slug || 'no slug')})</option>`).join('')}
          </select>
        </div>
        <div class="row">
          <label>Tariff</label>
          <select id="nc-tariff">
            <option value="">— select tariff —</option>
            ${cache.tariffs.filter(t => !['trial','suspended'].includes(t.key))
                .map(t => `<option value="${esc(t.key)}" ${prefillUpgradeReq?.requested_plan === t.key ? 'selected' : ''}>${esc(t.display_name)} (${esc(t.key)})</option>`).join('')}
          </select>
        </div>
        <div class="row" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div>
            <label>Period (months)</label>
            <select id="nc-period">
              <option value="1">1 month</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12" selected>12 months</option>
              <option value="24">24 months</option>
            </select>
          </div>
          <div>
            <label>Amount</label>
            <input id="nc-amount" type="number" min="0" step="1" placeholder="0">
            <div class="sub" style="margin-top:4px"><span id="nc-curr">UZS</span></div>
          </div>
        </div>
        <div class="row">
          <label>Notes (internal)</label>
          <textarea id="nc-notes" rows="2" placeholder="Anything the next person needs to know"></textarea>
        </div>
        <div class="modal-err" id="nc-err"></div>
        <div class="modal-actions">
          <button class="btn" id="nc-cancel">Cancel</button>
          <button class="btn primary" id="nc-create">Create invoice</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#nc-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    const tariffSel = overlay.querySelector('#nc-tariff');
    const periodSel = overlay.querySelector('#nc-period');
    const amountInp = overlay.querySelector('#nc-amount');
    const currLbl   = overlay.querySelector('#nc-curr');
    function recalcAmount() {
        const t = cache.tariffs.find(x => x.key === tariffSel.value);
        if (!t) { amountInp.value = ''; currLbl.textContent = 'UZS'; return; }
        currLbl.textContent = t.currency || 'UZS';
        const m = Number(periodSel.value);
        if (m >= 12 && t.price_yearly) {
            // pro-rate yearly to the months selected
            amountInp.value = Math.round((t.price_yearly / 12) * m);
        } else if (t.price_monthly) {
            amountInp.value = t.price_monthly * m;
        } else {
            amountInp.value = '';
        }
    }
    tariffSel.addEventListener('change', recalcAmount);
    periodSel.addEventListener('change', recalcAmount);
    if (tariffSel.value) recalcAmount();

    overlay.querySelector('#nc-create').addEventListener('click', async () => {
        const errEl = overlay.querySelector('#nc-err');
        errEl.textContent = '';
        const payload = {
            company_id:     overlay.querySelector('#nc-company').value || null,
            tariff_key:     tariffSel.value || null,
            period_months:  Number(periodSel.value) || 1,
            amount:         Number(amountInp.value) || 0,
            currency:       currLbl.textContent || 'UZS',
            notes:          overlay.querySelector('#nc-notes').value.trim() || null,
            upgrade_request_id: prefillUpgradeReq?.id || null,
        };
        if (!payload.company_id) { errEl.textContent = 'Pick a clinic.'; return; }
        if (!payload.tariff_key) { errEl.textContent = 'Pick a tariff.'; return; }
        const { error } = await supabase.from('payment_invoices').insert(payload);
        if (error) { errEl.textContent = error.message; return; }
        toast('Invoice created.', 'ok');
        overlay.remove();
        await loadAndRender();
    });
}
