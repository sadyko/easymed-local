// Platform → reference-data CRUD (Geography + access requests). Config-driven. REFDATA_V1.
// Global tables (no company_id); super_admin/admin manage them via the platform session.
import { esc, toast } from '../../setting.js';

const COUNTRIES = {
    table: 'countries', title: 'Country',
    orderBy: { column: 'name', ascending: true }, searchColumns: ['name', 'code'],
    columns: [{ key: 'name', label: 'Country' }, { key: 'code', label: 'ISO code' }, { key: 'active', label: 'Status', type: 'bool' }],
    fields: [
        { key: 'name', label: 'Country name', type: 'text', required: true },
        { key: 'code', label: 'ISO 3166-1 alpha-2 (e.g. UZ, RU, KZ)', type: 'text' },
        { key: 'active', label: 'Active', type: 'bool', default: true },
    ],
};
const REGIONS = {
    table: 'regions', title: 'Region',
    orderBy: { column: 'name', ascending: true }, searchColumns: ['name'], fkLookups: ['countries'],
    columns: [{ key: 'country_id', label: 'Country', lookup: 'countries' }, { key: 'name', label: 'Region' }, { key: 'active', label: 'Status', type: 'bool' }],
    fields: [
        { key: 'country_id', label: 'Country', type: 'fk', source: 'countries', required: true },
        { key: 'name', label: 'Region name', type: 'text', required: true },
        { key: 'active', label: 'Active', type: 'bool', default: true },
    ],
};
const DISTRICTS = {
    table: 'districts', title: 'District',
    orderBy: { column: 'name', ascending: true }, searchColumns: ['name'], fkLookups: ['regions'],
    columns: [{ key: 'region_id', label: 'Region', lookup: 'regions' }, { key: 'name', label: 'District' }, { key: 'active', label: 'Status', type: 'bool' }],
    fields: [
        { key: 'region_id', label: 'Region', type: 'fk', source: 'regions', required: true },
        { key: 'name', label: 'District name', type: 'text', required: true },
        { key: 'active', label: 'Active', type: 'bool', default: true },
    ],
};
const SIGNUP_REQUESTS = {
    table: 'signup_requests', title: 'Sign-up request',
    orderBy: { column: 'created_at', ascending: false }, searchColumns: ['full_name', 'phone', 'email', 'username'],
    columns: [
        { key: 'created_at', label: 'Submitted', type: 'date' }, { key: 'full_name', label: 'Name' },
        { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
        { key: 'username', label: 'Desired username' }, { key: 'status', label: 'Status' },
    ],
    fields: [
        { key: 'full_name', label: 'Full name', type: 'text', required: true },
        { key: 'phone', label: 'Phone', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'username', label: 'Desired username', type: 'text' },
        { key: 'message', label: 'Reason for access', type: 'textarea' },
        { key: 'status', label: 'Status', type: 'select', options: [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']] },
        { key: 'review_notes', label: 'Review notes', type: 'textarea' },
    ],
};
const SERVICE_CATALOG = {
    table: 'service_catalog', title: 'Catalog service',
    orderBy: { column: 'name', ascending: true }, searchColumns: ['name', 'code', 'type', 'category', 'group_name'],
    columns: [
        { key: 'name', label: 'Service' }, { key: 'type', label: 'Type' }, { key: 'category', label: 'Category' },
        { key: 'group_name', label: 'Group' }, { key: 'default_duration_minutes', label: 'Duration' }, { key: 'active', label: 'Status', type: 'bool' },
    ],
    fields: [
        { key: 'name', label: 'Service name', type: 'text', required: true },
        { key: 'code', label: 'Code (optional)', type: 'text' },
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'category', label: 'Category', type: 'text' },
        { key: 'group_name', label: 'Group', type: 'text' },
        { key: 'requires_doctor', label: 'Requires a doctor', type: 'bool', default: true },
        { key: 'default_duration_minutes', label: 'Default duration (minutes)', type: 'number', default: 30 },
        { key: 'active', label: 'Active', type: 'bool', default: true },
    ],
};
const FK_LABEL = { countries: 'name', regions: 'name', districts: 'name' };

function fmtCell(row, col, fk) {
    const v = row[col.key];
    if (v == null || v === '') return '<span class="muted">—</span>';
    if (col.lookup) { const hit = (fk[col.lookup] || []).find(r => r.id === v); return esc(hit ? (hit[FK_LABEL[col.lookup]] || hit.id) : '—'); }
    if (col.type === 'bool') return v ? '<span style="color:#16a34a;font-weight:600">Active</span>' : '<span class="muted">Inactive</span>';
    if (col.type === 'date') { try { return esc(new Date(v).toLocaleDateString()); } catch { return esc(String(v)); } }
    return esc(String(v));
}

async function makeView(root, ctx, cfg) {
    const { supabase } = ctx;
    const st = { rows: [], fk: {}, search: '' };
    injectCss();
    root.innerHTML = `
      <div class="filterbar">
        <input class="search" id="rd-search" placeholder="Search…">
        <button class="btn primary" id="rd-add" style="margin-left:auto">+ Add</button>
      </div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="t">
        <thead><tr>${cfg.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead>
        <tbody id="rd-body"><tr><td colspan="${cfg.columns.length + 1}" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
      </table></div></div>`;
    root.querySelector('#rd-search').addEventListener('input', e => { st.search = e.target.value.toLowerCase(); renderRows(); });
    root.querySelector('#rd-add').addEventListener('click', () => openEditor(null));

    async function load() {
        for (const t of (cfg.fkLookups || [])) {
            if (st.fk[t]) continue;
            const { data } = await supabase.from(t).select('id, ' + (FK_LABEL[t] || 'name')).order(FK_LABEL[t] || 'name');
            st.fk[t] = data || [];
        }
        let q = supabase.from(cfg.table).select('*');
        if (cfg.orderBy) q = q.order(cfg.orderBy.column, { ascending: cfg.orderBy.ascending !== false });
        const { data, error } = await q;
        const body = root.querySelector('#rd-body');
        if (error) { body.innerHTML = `<tr><td colspan="${cfg.columns.length + 1}" class="muted" style="padding:16px">Could not load: ${esc(error.message)}</td></tr>`; return; }
        st.rows = data || []; renderRows();
    }
    function filtered() {
        const t = st.search.trim(); if (!t) return st.rows;
        const cols = cfg.searchColumns || cfg.columns.map(c => c.key);
        return st.rows.filter(r => cols.some(k => r[k] != null && String(r[k]).toLowerCase().includes(t)));
    }
    function renderRows() {
        const rows = filtered(); const body = root.querySelector('#rd-body');
        if (!rows.length) { body.innerHTML = `<tr><td colspan="${cfg.columns.length + 1}" class="muted" style="padding:16px">${st.rows.length ? 'No matches.' : 'No rows yet — click + Add.'}</td></tr>`; return; }
        body.innerHTML = rows.map(r => `<tr>${cfg.columns.map(c => `<td>${fmtCell(r, c, st.fk)}</td>`).join('')}<td style="text-align:right;white-space:nowrap"><button class="btn" data-edit="${esc(r.id)}">Edit</button> <button class="btn" data-del="${esc(r.id)}" style="color:#dc2626">Del</button></td></tr>`).join('');
        body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditor(st.rows.find(x => x.id === b.dataset.edit))));
        body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => del(st.rows.find(x => x.id === b.dataset.del))));
    }
    function fieldHtml(f, v) {
        const val = v == null ? (f.default != null ? f.default : '') : v;
        if (f.type === 'textarea') return `<textarea name="${f.key}">${esc(val == null ? '' : val)}</textarea>`;
        if (f.type === 'bool') return `<label class="rd-check"><input type="checkbox" name="${f.key}" ${(v == null ? f.default !== false : !!v) ? 'checked' : ''}> Yes</label>`;
        if (f.type === 'select') return `<select name="${f.key}">${(f.options || []).map(([ov, ol]) => `<option value="${esc(ov)}" ${String(val) === String(ov) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`;
        if (f.type === 'fk') return `<select name="${f.key}"><option value="">—</option>${(st.fk[f.source] || []).map(o => `<option value="${esc(o.id)}" ${val === o.id ? 'selected' : ''}>${esc(o[FK_LABEL[f.source]] || o.id)}</option>`).join('')}</select>`;
        if (f.type === 'number') return `<input type="number" name="${f.key}" value="${esc(val == null ? '' : val)}">`;
        return `<input type="${f.type === 'email' ? 'email' : 'text'}" name="${f.key}" value="${esc(val == null ? '' : val)}">`;
    }
    function openEditor(row) {
        const ov = document.createElement('div'); ov.className = 'rd-overlay';
        ov.innerHTML = `<div class="rd-scrim"></div><div class="rd-modal">
            <header><h3>${row ? 'Edit' : 'Add'} ${esc(cfg.title)}</h3><button class="rd-x" type="button">×</button></header>
            <form class="rd-form">${cfg.fields.map(f => `<label class="rd-field"><span>${esc(f.label)}${f.required ? ' *' : ''}</span>${fieldHtml(f, row ? row[f.key] : undefined)}</label>`).join('')}</form>
            <footer><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-save>Save</button></footer></div>`;
        document.body.appendChild(ov);
        const close = () => ov.remove();
        ov.querySelector('.rd-scrim').addEventListener('click', close);
        ov.querySelector('.rd-x').addEventListener('click', close);
        ov.querySelector('[data-cancel]').addEventListener('click', close);
        ov.querySelector('[data-save]').addEventListener('click', async (e) => {
            e.target.disabled = true;
            try { await save(ov.querySelector('.rd-form'), row); toast('Saved.'); close(); await load(); }
            catch (err) { toast(err.message || String(err), 'err'); e.target.disabled = false; }
        });
    }
    async function save(formEl, row) {
        const payload = {};
        for (const f of cfg.fields) {
            const el = formEl.querySelector(`[name="${f.key}"]`); if (!el) continue;
            if (f.type === 'bool') payload[f.key] = el.checked;
            else if (f.type === 'number') payload[f.key] = el.value === '' ? null : Number(el.value);
            else payload[f.key] = el.value === '' ? null : el.value;
        }
        const res = row ? await supabase.from(cfg.table).update(payload).eq('id', row.id) : await supabase.from(cfg.table).insert(payload);
        if (res.error) throw res.error;
    }
    async function del(row) {
        if (!row || !confirm('Delete this row?')) return;
        const { error } = await supabase.from(cfg.table).delete().eq('id', row.id);
        if (error) { toast(error.message, 'err'); return; }
        toast('Deleted.'); await load();
    }
    await load();
}

function injectCss() {
    if (document.getElementById('rd-css')) return;
    const s = document.createElement('style'); s.id = 'rd-css';
    s.textContent = `
      .rd-overlay{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px}
      .rd-scrim{position:absolute;inset:0;background:rgba(10,15,20,.45)}
      .rd-modal{position:relative;z-index:1;background:#fff;border-radius:14px;width:min(560px,100%);max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.25)}
      .rd-modal header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #eef0f2}
      .rd-modal header h3{margin:0;font-size:15px}
      .rd-x{border:0;background:none;font-size:22px;cursor:pointer;line-height:1;color:#64748b}
      .rd-form{padding:16px 18px;display:flex;flex-direction:column;gap:12px}
      .rd-field{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:#475569}
      .rd-field input,.rd-field select,.rd-field textarea{height:36px;padding:0 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13.5px;font-family:inherit;box-sizing:border-box}
      .rd-field textarea{height:auto;min-height:72px;padding:8px 10px}
      .rd-check{flex-direction:row;align-items:center;gap:8px}
      .rd-check input{height:auto}
      .rd-modal footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #eef0f2}`;
    document.head.appendChild(s);
}

export const renderCountries    = (root, ctx) => makeView(root, ctx, COUNTRIES);
export const renderRegions      = (root, ctx) => makeView(root, ctx, REGIONS);
export const renderDistricts    = (root, ctx) => makeView(root, ctx, DISTRICTS);
export const renderUserSignups  = (root, ctx) => makeView(root, ctx, SIGNUP_REQUESTS);
export const renderServiceCatalog = (root, ctx) => makeView(root, ctx, SERVICE_CATALOG);
