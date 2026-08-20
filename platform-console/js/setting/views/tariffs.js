// Platform → Tariffs. Configure plan tiers + which appear where:
//   - "Visible on landing" → shown in the pricing section of easymed.uz
//   - "Visible in modal"   → shown as plan chips in the in-app upgrade modal
//
// Changes here propagate live: both surfaces fetch from public.tariffs
// (RLS allows anon read of active+visible rows).

import { esc, fmtRelative, toast } from '../../setting.js';

let mountedRoot = null;
let mountedCtx  = null;
let cache = { rows: [] };

export async function renderTariffs(root, ctx) {
    mountedRoot = root; mountedCtx = ctx;
    root.innerHTML = `
      <div class="filterbar">
        <div style="color:var(--ink-3); font-size:13px; line-height:1.45;">
          Changes here go live immediately on
          <a href="https://easymed.uz/" target="_blank">easymed.uz</a>
          and inside every clinic's upgrade modal.
        </div>
        <button class="btn" id="tf-new"       style="margin-left:auto">+ New tariff</button>
        <button class="btn primary" id="tf-refresh">Refresh</button>
      </div>
      <div class="card" style="padding:0">
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>Tier</th>
                <th>Price / month</th>
                <th>Price / year</th>
                <th>On landing</th>
                <th>In modal</th>
                <th>Active</th>
                <th>Sort</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="tf-body"><tr><td colspan="9" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    `;
    root.querySelector('#tf-refresh').addEventListener('click', loadAndRender);
    root.querySelector('#tf-new').addEventListener('click', () => openEditor(null));
    await loadAndRender();
}

async function loadAndRender() {
    const { supabase } = mountedCtx;
    const { data, error } = await supabase.from('tariffs')
        .select('id, key, display_name, tagline, price_monthly, price_yearly, currency, features, sort_order, visible_on_landing, visible_in_modal, is_active, contact_for_pricing, updated_at')
        .order('sort_order', { ascending: true });
    if (error) {
        mountedRoot.querySelector('#tf-body').innerHTML = `<tr><td colspan="9" class="empty">Failed: ${esc(error.message)}</td></tr>`;
        return;
    }
    cache.rows = data || [];
    renderRows();
}

function fmtMoney(n, curr, contact) {
    // Three states match the public landing-page logic so the admin table
    // shows exactly what visitors will see on easymed.uz.
    if (contact)    return '<span class="muted">contact us</span>';
    if (n === 0)    return '<span class="badge approved">free</span>';
    if (n == null)  return '<span class="muted">—</span>';
    return new Intl.NumberFormat('en-US').format(n) + ' <span class="muted">' + esc(curr || 'UZS') + '</span>';
}

function renderRows() {
    const tbody = mountedRoot.querySelector('#tf-body');
    if (!cache.rows.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty">No tariffs yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = cache.rows.map(t => `
        <tr data-id="${esc(t.id)}">
            <td>
                <strong>${esc(t.display_name)}</strong>
                <br><span class="muted" style="font-size:11.5px">${esc(t.key)}${t.tagline ? ' · ' + esc(t.tagline) : ''}</span>
            </td>
            <td>${fmtMoney(t.price_monthly, t.currency, t.contact_for_pricing)}</td>
            <td>${fmtMoney(t.price_yearly,  t.currency, t.contact_for_pricing)}</td>
            <td>${toggleCell(t, 'visible_on_landing')}</td>
            <td>${toggleCell(t, 'visible_in_modal')}</td>
            <td>${toggleCell(t, 'is_active')}</td>
            <td class="num">${t.sort_order}</td>
            <td class="muted">${fmtRelative(t.updated_at)}</td>
            <td>
                <button class="btn small" data-act="edit"   data-id="${esc(t.id)}">Edit</button>
                ${['trial','suspended'].includes(t.key) ? '' : `<button class="btn small danger" data-act="delete" data-id="${esc(t.id)}">Delete</button>`}
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('[data-act="edit"]').forEach(b => b.addEventListener('click', () => openEditor(b.dataset.id)));
    tbody.querySelectorAll('[data-act="delete"]').forEach(b => b.addEventListener('click', () => removeTariff(b.dataset.id)));
    tbody.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', () => toggleField(el.dataset.id, el.dataset.toggle)));
}

function toggleCell(t, field) {
    const on = !!t[field];
    return `<button class="btn small ${on ? 'primary' : ''}" data-toggle="${field}" data-id="${esc(t.id)}">${on ? 'On' : 'Off'}</button>`;
}

async function toggleField(id, field) {
    const t = cache.rows.find(r => r.id === id);
    if (!t) return;
    const { supabase } = mountedCtx;
    const { error } = await supabase.from('tariffs').update({ [field]: !t[field] }).eq('id', id);
    if (error) { toast('Failed: ' + error.message, 'err'); return; }
    t[field] = !t[field];
    toast(t.display_name + ' · ' + field.replace(/_/g, ' ') + ' = ' + (t[field] ? 'On' : 'Off'), 'ok');
    renderRows();
}

async function removeTariff(id) {
    const t = cache.rows.find(r => r.id === id);
    if (!t) return;
    if (!confirm(`Delete tariff "${t.display_name}"? Clinics already on this plan keep their plan name; you'll lose the price/features configuration only.`)) return;
    const { supabase } = mountedCtx;
    const { error } = await supabase.from('tariffs').delete().eq('id', id);
    if (error) { toast('Could not delete: ' + error.message, 'err'); return; }
    toast('Deleted.', 'ok');
    await loadAndRender();
}

function openEditor(id) {
    const t = id ? cache.rows.find(r => r.id === id) : null;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px">
        <h3>${t ? 'Edit ' + esc(t.display_name) : 'New tariff'}</h3>
        <p class="sub">Tariffs control what shows on the marketing site and inside the in-app upgrade modal.</p>
        <div class="row">
          <label>Internal key (lowercase, used in DB)</label>
          <input id="tf-key" type="text" value="${esc(t?.key || '')}" ${t ? 'readonly' : ''} pattern="^[a-z][a-z0-9_-]{2,30}$" placeholder="starter">
        </div>
        <div class="row">
          <label>Display name</label>
          <input id="tf-name" type="text" value="${esc(t?.display_name || '')}" maxlength="60">
        </div>
        <div class="row">
          <label>Tagline (1 line)</label>
          <input id="tf-tagline" type="text" value="${esc(t?.tagline || '')}" maxlength="120" placeholder="Solo doctors or single branch">
        </div>
        <div class="row" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div>
            <label>Price / month (in currency below)</label>
            <input id="tf-price-m" type="number" min="0" step="1" value="${t?.price_monthly ?? ''}" placeholder="500000">
          </div>
          <div>
            <label>Price / year</label>
            <input id="tf-price-y" type="number" min="0" step="1" value="${t?.price_yearly ?? ''}" placeholder="4800000">
          </div>
        </div>
        <div class="row">
          <label>Currency</label>
          <input id="tf-currency" type="text" value="${esc(t?.currency || 'UZS')}" maxlength="8" style="text-transform:uppercase">
          <div class="sub" style="margin-top:4px">Leave price blank if the plan is contact-only ("From — Contact us").</div>
        </div>
        <div class="row">
          <label>Features (one per line)</label>
          <textarea id="tf-features" rows="6" placeholder="Up to 3 users&#10;1 branch&#10;Unlimited patients">${esc((t?.features || []).join('\n'))}</textarea>
        </div>
        <div class="row">
          <label>Sort order (lower = first)</label>
          <input id="tf-sort" type="number" value="${t?.sort_order ?? 100}" min="0" max="999">
        </div>
        <div class="row">
          <label class="check-row">
            <input id="tf-vis-l" type="checkbox" ${t?.visible_on_landing ?? true ? 'checked' : ''}>
            <span>Visible on landing page <span class="check-sub">Show this tier in the easymed.uz pricing section</span></span>
          </label>
          <label class="check-row">
            <input id="tf-vis-m" type="checkbox" ${t?.visible_in_modal ?? true ? 'checked' : ''}>
            <span>Visible in the in-app upgrade modal <span class="check-sub">Appears as a plan chip when a clinic clicks Upgrade</span></span>
          </label>
          <label class="check-row">
            <input id="tf-active" type="checkbox" ${t?.is_active ?? true ? 'checked' : ''}>
            <span>Active <span class="check-sub">Uncheck to deprecate without deleting (existing clinics keep their plan)</span></span>
          </label>
          <label class="check-row" title="Use for Enterprise / custom-quote tiers.">
            <input id="tf-contact" type="checkbox" ${t?.contact_for_pricing ? 'checked' : ''}>
            <span>Contact for pricing <span class="check-sub">Hides the price; shows &ldquo;Contact us&rdquo; on the public landing page</span></span>
          </label>
        </div>
        <div class="modal-err" id="tf-err"></div>
        <div class="modal-actions">
          <button class="btn" id="tf-cancel">Cancel</button>
          <button class="btn primary" id="tf-save">${t ? 'Save changes' : 'Create tariff'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#tf-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#tf-save').addEventListener('click', async () => {
        const errEl = overlay.querySelector('#tf-err');
        errEl.textContent = '';
        const features = overlay.querySelector('#tf-features').value
            .split('\n').map(s => s.trim()).filter(Boolean);
        const priceM = overlay.querySelector('#tf-price-m').value;
        const priceY = overlay.querySelector('#tf-price-y').value;
        const payload = {
            display_name:        overlay.querySelector('#tf-name').value.trim(),
            tagline:             overlay.querySelector('#tf-tagline').value.trim() || null,
            price_monthly:       priceM === '' ? null : Number(priceM),
            price_yearly:        priceY === '' ? null : Number(priceY),
            currency:            overlay.querySelector('#tf-currency').value.trim().toUpperCase() || 'UZS',
            features,
            sort_order:          Number(overlay.querySelector('#tf-sort').value) || 100,
            visible_on_landing:  overlay.querySelector('#tf-vis-l').checked,
            visible_in_modal:    overlay.querySelector('#tf-vis-m').checked,
            is_active:           overlay.querySelector('#tf-active').checked,
            contact_for_pricing: overlay.querySelector('#tf-contact').checked,
        };
        if (payload.display_name.length < 2) { errEl.textContent = 'Display name is required.'; return; }
        const { supabase } = mountedCtx;
        if (t) {
            const { error } = await supabase.from('tariffs').update(payload).eq('id', t.id);
            if (error) { errEl.textContent = error.message; return; }
            toast('Tariff saved.', 'ok');
        } else {
            payload.key = overlay.querySelector('#tf-key').value.trim().toLowerCase();
            if (!/^[a-z][a-z0-9_-]{2,30}$/.test(payload.key)) { errEl.textContent = 'Key must be lowercase letters/digits/hyphens, 3-31 chars.'; return; }
            const { error } = await supabase.from('tariffs').insert(payload);
            if (error) { errEl.textContent = error.message; return; }
            toast('Tariff created.', 'ok');
        }
        overlay.remove();
        await loadAndRender();
    });
}
