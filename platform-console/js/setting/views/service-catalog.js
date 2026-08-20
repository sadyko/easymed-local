// Platform → MEDCORE services catalog. Manages the shared core service_catalog
// via the FastAPI gateway (/api/v1/catalog). Replaces the old refdata-backed
// service_catalog table editor. SERVICE_CATALOG_GW_V1.
import { esc, toast } from '../../setting.js';
import { gw } from '../gateway.js';

const PAGE_SIZE = 50;

// Modal CSS reuses the refdata `.rd-*` look so the console feels consistent.
function injectCss() {
    if (document.getElementById('sc-css')) return;
    const s = document.createElement('style'); s.id = 'sc-css';
    s.textContent = `
      .sc-overlay{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px}
      .sc-scrim{position:absolute;inset:0;background:rgba(10,15,20,.45)}
      .sc-modal{position:relative;z-index:1;background:#fff;border-radius:14px;width:min(560px,100%);max-height:90vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.25)}
      .sc-modal header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #eef0f2}
      .sc-modal header h3{margin:0;font-size:15px}
      .sc-x{border:0;background:none;font-size:22px;cursor:pointer;line-height:1;color:#64748b}
      .sc-form{padding:16px 18px;display:flex;flex-direction:column;gap:12px}
      .sc-field{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:#475569}
      .sc-field input,.sc-field select,.sc-field textarea{height:36px;padding:0 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13.5px;font-family:inherit;box-sizing:border-box}
      .sc-field textarea{height:auto;min-height:72px;padding:8px 10px}
      .sc-field select:disabled{background:#f1f5f9;color:#94a3b8;cursor:not-allowed}
      .sc-check{flex-direction:row;align-items:center;gap:8px}
      .sc-check input{height:auto}
      .sc-cascade{border:1px solid #eef0f2;border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:12px;background:#fafbfc}
      .sc-modal footer{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #eef0f2}
      .sc-pager{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:12.5px;color:#475569}
      .sc-pager .grow{flex:1}`;
    document.head.appendChild(s);
}

// ---------------------------------------------------------------------
// Catalog hierarchy loader. Preloads groups/types/categories ONCE and
// filters client-side for the cascading Group → Type → Category dropdowns.
// SERVICE_CATALOG_CASCADE_V1.
// ---------------------------------------------------------------------
let _catalogCache = null;
async function loadCatalog() {
    if (_catalogCache) return _catalogCache;
    const [g, t, c] = await Promise.all([
        gw('/catalog/groups'),
        gw('/catalog/types'),
        gw('/catalog/categories'),
    ]);
    _catalogCache = {
        groups: (g && g.data) || [],
        types: (t && t.data) || [],
        categories: (c && c.data) || [],
    };
    return _catalogCache;
}

const _label = (o) => (o && (o.name_ru || o.name_uz || o.id)) || '';

// Fill a <select> with options for the given list, preselecting `selectedId`.
function fillSelect(sel, list, selectedId, placeholder) {
    sel.innerHTML = `<option value="">${placeholder}</option>` +
        (list || []).map(o => `<option value="${esc(o.id)}" ${String(selectedId || '') === String(o.id) ? 'selected' : ''}>${esc(_label(o))}</option>`).join('');
    sel.value = selectedId == null ? '' : String(selectedId);
}

// ---------------------------------------------------------------------
// Shared modal builder (used by both edit + create, in-view and external).
// ---------------------------------------------------------------------
// Renders the create/edit form overlay. `row` null => create. Returns nothing;
// calls onSaved(savedService) after a successful POST/PATCH. The Group/Type/
// Category cascade is loaded from the catalog cache; `service_category_id`
// remains the saved value.
async function openServiceModal({ row = null, onSaved }) {
    injectCss();
    const isEdit = !!row;
    const r = row || {};

    // Load the hierarchy first so the dropdowns can be pre-populated.
    let catalog = { groups: [], types: [], categories: [] };
    try {
        catalog = await loadCatalog();
    } catch (err) {
        toast('Could not load catalog hierarchy: ' + (err.message || err), 'err');
    }

    // Derive the row's group/type/category for edit pre-selection.
    const selCatId = r.service_category_id || '';
    // Type id: prefer the nested read shape, else look the category up in the cache.
    let selTypeId = (r.service_categories && r.service_categories.service_type_id) || '';
    if (!selTypeId && selCatId) {
        const cat = catalog.categories.find(c => String(c.id) === String(selCatId));
        if (cat) selTypeId = cat.service_type_id || '';
    }
    // Group id: look the type up in the cache.
    let selGroupId = '';
    if (selTypeId) {
        const typ = catalog.types.find(t => String(t.id) === String(selTypeId));
        if (typ) selGroupId = typ.service_group_id || '';
    }

    const ov = document.createElement('div'); ov.className = 'sc-overlay';
    ov.innerHTML = `<div class="sc-scrim"></div><div class="sc-modal">
        <header><h3>${isEdit ? 'Edit service' : 'Add service'}</h3><button class="sc-x" type="button">×</button></header>
        <form class="sc-form" onsubmit="return false">
          <div class="sc-cascade">
            <label class="sc-field"><span>Group</span><select name="group_id"></select></label>
            <label class="sc-field"><span>Type</span><select name="type_id"></select></label>
            <label class="sc-field"><span>Category *</span><select name="service_category_id"></select></label>
          </div>
          <label class="sc-field"><span>Name (RU) *</span><input type="text" name="name_ru" value="${esc(r.name_ru == null ? '' : r.name_ru)}"></label>
          <label class="sc-field"><span>Name (UZ) *</span><input type="text" name="name_uz" value="${esc(r.name_uz == null ? '' : r.name_uz)}"></label>
          <label class="sc-field"><span>Name (EN)</span><input type="text" name="name_en" value="${esc(r.name_en == null ? '' : r.name_en)}"></label>
          <label class="sc-field"><span>Description (RU)</span><textarea name="description_ru">${esc(r.description_ru == null ? '' : r.description_ru)}</textarea></label>
          <label class="sc-field"><span>Description (UZ)</span><textarea name="description_uz">${esc(r.description_uz == null ? '' : r.description_uz)}</textarea></label>
          <label class="sc-field"><span>Average duration (minutes)</span><input type="number" name="avg_duration_min" value="${esc(r.avg_duration_min == null ? '' : r.avg_duration_min)}"></label>
          <label class="sc-field sc-check"><input type="checkbox" name="is_active" ${(r.is_active == null ? true : !!r.is_active) ? 'checked' : ''}> Active</label>
        </form>
        <footer><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-save>${isEdit ? 'Save' : 'Create'}</button></footer>
      </div>`;
    document.body.appendChild(ov);
    const form = ov.querySelector('.sc-form');
    const close = () => ov.remove();
    ov.querySelector('.sc-scrim').addEventListener('click', close);
    ov.querySelector('.sc-x').addEventListener('click', close);
    ov.querySelector('[data-cancel]').addEventListener('click', close);

    // --- cascading dropdown wiring -------------------------------------
    const groupSel = form.querySelector('[name="group_id"]');
    const typeSel = form.querySelector('[name="type_id"]');
    const catSel = form.querySelector('[name="service_category_id"]');

    // Group: all groups. Type/Category get filled by syncType/syncCat.
    fillSelect(groupSel, catalog.groups, selGroupId, '— Select group —');

    // Refill Type from the selected group; preserve `keepTypeId` if it still
    // belongs to the group (used for edit pre-selection), else reset.
    function syncType(keepTypeId) {
        const gid = groupSel.value;
        const types = gid ? catalog.types.filter(t => String(t.service_group_id) === String(gid)) : [];
        const keep = (keepTypeId && types.some(t => String(t.id) === String(keepTypeId))) ? keepTypeId : '';
        fillSelect(typeSel, types, keep, '— Select type —');
        typeSel.disabled = !gid;
    }
    // Refill Category from the selected type; preserve `keepCatId` if valid.
    function syncCat(keepCatId) {
        const tid = typeSel.value;
        const cats = tid ? catalog.categories.filter(c => String(c.service_type_id) === String(tid)) : [];
        const keep = (keepCatId && cats.some(c => String(c.id) === String(keepCatId))) ? keepCatId : '';
        fillSelect(catSel, cats, keep, '— Select category —');
        catSel.disabled = !tid;
    }

    // Initial population (edit pre-selects all three; create leaves empty).
    syncType(selTypeId);
    syncCat(selCatId);

    groupSel.addEventListener('change', () => { syncType(''); syncCat(''); });
    typeSel.addEventListener('change', () => { syncCat(''); });

    ov.querySelector('[data-save]').addEventListener('click', async (e) => {
        const get = (n) => form.querySelector(`[name="${n}"]`);
        const name_ru = get('name_ru').value.trim();
        const name_uz = get('name_uz').value.trim();
        const service_category_id = get('service_category_id').value;
        if (!name_ru || !name_uz || !service_category_id) {
            toast('Name (RU), Name (UZ) and Category are required.', 'err');
            return;
        }
        // Build the payload from the form fields only.
        const body = {
            name_ru,
            name_uz,
            name_en: get('name_en').value.trim() || null,
            description_ru: get('description_ru').value.trim() || null,
            description_uz: get('description_uz').value.trim() || null,
            avg_duration_min: get('avg_duration_min').value === '' ? null : Number(get('avg_duration_min').value),
            service_category_id,
            is_active: get('is_active').checked,
        };
        e.target.disabled = true;
        try {
            const saved = isEdit
                ? await gw('/catalog/services/' + row.id, { method: 'PATCH', body })
                : await gw('/catalog/services', { method: 'POST', body });
            toast(isEdit ? 'Service updated.' : 'Service created.');
            close();
            if (onSaved) onSaved(saved);
        } catch (err) {
            toast(err.message || String(err), 'err');
            e.target.disabled = false;
        }
    });
}

// Public helper the service-requests view can import to open a pre-filled
// "create service" modal. SERVICE_CREATE_MODAL_V1.
// `categories` is accepted for backwards compatibility but no longer used —
// the modal loads its own groups/types/categories hierarchy.
export function openServiceCreateModal({ prefill = {}, categories = [], onCreated } = {}) {
    openServiceModal({
        row: Object.assign({ is_active: true }, prefill),
        onSaved: (saved) => { if (onCreated) onCreated(saved); },
    });
}

// ---------------------------------------------------------------------
// Main list view.
// ---------------------------------------------------------------------
export async function renderServiceCatalog(root, ctx) {
    injectCss();
    const st = { categories: [], rows: [], q: '', cat: '', offset: 0, total: null, loading: false };

    root.innerHTML = `
      <div class="filterbar">
        <input class="search" id="sc-search" placeholder="Search services…">
        <select id="sc-cat" class="search" style="max-width:280px"><option value="">All categories</option></select>
        <button class="btn primary" id="sc-add" style="margin-left:auto">+ Add service</button>
      </div>
      <div class="card" style="padding:0"><div class="table-wrap"><table class="t">
        <thead><tr><th>Name (RU)</th><th>Name (UZ)</th><th>Category</th><th>Active</th><th></th></tr></thead>
        <tbody id="sc-body"><tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading…</td></tr></tbody>
      </table></div></div>
      <div class="sc-pager">
        <button class="btn" id="sc-prev" disabled>← Prev</button>
        <button class="btn" id="sc-next">Next →</button>
        <span class="grow"></span>
        <span id="sc-count" class="muted"></span>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const searchEl = $('#sc-search');
    const catEl = $('#sc-cat');
    const bodyEl = $('#sc-body');
    const prevEl = $('#sc-prev');
    const nextEl = $('#sc-next');
    const countEl = $('#sc-count');

    // --- categories (once) for the list filter dropdown -----------------
    try {
        const res = await gw('/catalog/categories');
        st.categories = (res && res.data) || [];
        catEl.innerHTML = '<option value="">All categories</option>' +
            st.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name_ru || c.name_uz || c.id)}</option>`).join('');
    } catch (err) {
        toast('Could not load categories: ' + (err.message || err), 'err');
    }

    function renderRows() {
        if (!st.rows.length) {
            bodyEl.innerHTML = `<tr><td colspan="5" class="muted" style="padding:16px">${(st.q || st.cat) ? 'No matches.' : 'No services yet.'}</td></tr>`;
            return;
        }
        bodyEl.innerHTML = st.rows.map(r => {
            const catName = (r.service_categories && (r.service_categories.name_ru || r.service_categories.name_uz)) || '';
            return `<tr>
                <td>${esc(r.name_ru || '')}</td>
                <td>${esc(r.name_uz || '')}</td>
                <td>${catName ? esc(catName) : '<span class="muted">—</span>'}</td>
                <td>${r.is_active === false ? '<span class="muted">—</span>' : '<span style="color:#16a34a;font-weight:600">✓</span>'}</td>
                <td style="text-align:right;white-space:nowrap"><button class="btn" data-edit="${esc(r.id)}">Edit</button></td>
            </tr>`;
        }).join('');
        bodyEl.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
            const row = st.rows.find(x => String(x.id) === b.dataset.edit);
            if (row) openServiceModal({ row, onSaved: load });
        }));
    }

    async function load() {
        st.loading = true;
        bodyEl.innerHTML = `<tr><td colspan="5" class="row-loading"><div class="spinner"></div>Loading…</td></tr>`;
        const qp = '?q=' + encodeURIComponent(st.q) +
                   '&category_id=' + encodeURIComponent(st.cat) +
                   '&limit=' + PAGE_SIZE +
                   '&offset=' + st.offset;
        try {
            const res = await gw('/catalog/services' + qp);
            st.rows = (res && res.data) || [];
            st.total = (res && typeof res.total === 'number') ? res.total : null;
            renderRows();
        } catch (err) {
            bodyEl.innerHTML = `<tr><td colspan="5" class="muted" style="padding:16px">Could not load: ${esc(err.message || String(err))}</td></tr>`;
            st.rows = [];
        }
        st.loading = false;
        // Prev disabled at the first page; Next disabled when the last page
        // returned fewer than a full page (no more rows to fetch).
        prevEl.disabled = st.offset <= 0;
        nextEl.disabled = st.rows.length < PAGE_SIZE;
        if (st.total != null) {
            const from = st.rows.length ? st.offset + 1 : 0;
            const to = st.offset + st.rows.length;
            countEl.textContent = `${from}–${to} of ${st.total}`;
        } else {
            countEl.textContent = st.rows.length ? `${st.offset + 1}–${st.offset + st.rows.length}` : '';
        }
    }

    // --- toolbar wiring -------------------------------------------------
    let searchTimer = null;
    const applySearch = () => { st.q = searchEl.value.trim(); st.offset = 0; load(); };
    searchEl.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(applySearch, 350);
    });
    searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); applySearch(); } });
    catEl.addEventListener('change', () => { st.cat = catEl.value; st.offset = 0; load(); });
    prevEl.addEventListener('click', () => { if (st.offset <= 0) return; st.offset = Math.max(0, st.offset - PAGE_SIZE); load(); });
    nextEl.addEventListener('click', () => { if (st.rows.length < PAGE_SIZE) return; st.offset += PAGE_SIZE; load(); });
    $('#sc-add').addEventListener('click', () => {
        openServiceCreateModal({ onCreated: () => { st.offset = 0; load(); } });
    });

    await load();
}
