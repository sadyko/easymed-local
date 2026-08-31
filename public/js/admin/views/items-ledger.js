// ITEMS_LEDGER_V1 — Приход-расход for the whole drug/products catalog, valued AT COST.
// Consolidated for ALL items (not a per-drug config). Data sources:
//   • stock_movements — kind receipt/adjustment/issue, signed qty, unit_cost (receipts only)
//   • item_stock      — current qty_on_hand (authoritative on-hand, per branch)
//   • clinic_items    — names / units (browser-readable; writes via the service-role gateway)
// "+ Добавить приход" records a receipt (drug + цена за ед. + ед. + количество); a brand-new
// drug is created through the gateway CRUD. Cost basis for расход/остаток = each item's LATEST
// receipt unit_cost. Respects settings:clinic_items permissions (view to open, edit to add).
import { h, Icon, PageHead, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { supabase } from '../../supabase.js';
import { currentClinicId } from '../tenant-tables.js';
import { canEdit } from '../permissions.js';
import { gw } from '../gateway.js';

const PERM = 'settings:clinic_items';

// SheetJS, self-hosted (site CSP blocks the CDN). Served as .js (ES module).
const SHEETJS_URL = '/js/vendor/xlsx-0.20.3.js';
let _xlsxPromise = null;
function loadXlsx() {
    if (!_xlsxPromise) _xlsxPromise = import(/* @vite-ignore */ SHEETJS_URL)
        .then(m => (m && m.utils) ? m : (m && m.default && m.default.utils) ? m.default : m);
    return _xlsxPromise;
}

const state = {
    period: 'month',      // month | prevmonth | 30d | all
    branch: 'all',
    items: [],            // clinic_items [{id,name,unit,price,...}]
    branches: [],         // [{id,name}]
    movements: [],        // stock_movements in the selected period (desc)
    costByItem: {},       // item_id -> latest receipt unit_cost (cost basis)
    stockByItem: {},      // item_id -> qty_on_hand (branch-filtered)
    loading: true,
    adding: false,
};
let containerRef = null, onBackRef = null, bodyRef = null;

// ---- formatters -----------------------------------------------------------
function money(n) { return (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + ' ' + tr('сум'); }
function num(n)   { const v = Number(n) || 0; return (Math.round(v * 100) / 100).toLocaleString('ru-RU'); }
function itemName(id) { const it = state.items.find(i => i.id === id); return it ? it.name : '—'; }
function itemById(id) { return state.items.find(i => i.id === id) || null; }

function periodBounds(period) {
    const now = new Date();
    if (period === 'all')       return { from: null, to: null };
    if (period === '30d')       { const d = new Date(now); d.setDate(d.getDate() - 30); return { from: d.toISOString(), to: null }; }
    if (period === 'prevmonth') return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
                                         to:   new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to: null }; // this month
}
const PERIOD_LABELS = [['month', 'Этот месяц'], ['prevmonth', 'Прошлый месяц'], ['30d', '30 дней'], ['all', 'Всё время']];

// ---- data -----------------------------------------------------------------
async function loadAll() {
    const cid = currentClinicId();
    if (!cid) { state.loading = false; return; }
    state.loading = true;
    const { from, to } = periodBounds(state.period);
    try {
        const [items, branches, stock, costRecs] = await Promise.all([
            supabase.from('clinic_items').select('id, name, unit, price, is_drug, active').eq('company_id', cid).order('name'),
            supabase.from('branches').select('id, name').eq('company_id', cid).order('name'),
            supabase.from('item_stock').select('item_id, branch_id, qty_on_hand').eq('company_id', cid),
            supabase.from('stock_movements').select('item_id, unit_cost, created_at')
                .eq('company_id', cid).eq('kind', 'receipt').not('unit_cost', 'is', null)
                .order('created_at', { ascending: false }).limit(5000),
        ]);
        state.items    = items.data || [];
        state.branches = branches.data || [];

        // Cost basis = the most recent receipt unit_cost per item (desc order → first wins).
        state.costByItem = {};
        for (const r of (costRecs.data || [])) if (state.costByItem[r.item_id] == null) state.costByItem[r.item_id] = Number(r.unit_cost) || 0;

        // Current on-hand per item, honouring the branch filter.
        state.stockByItem = {};
        for (const s of (stock.data || [])) {
            if (state.branch !== 'all' && s.branch_id !== state.branch) continue;
            state.stockByItem[s.item_id] = (state.stockByItem[s.item_id] || 0) + Number(s.qty_on_hand || 0);
        }

        let mq = supabase.from('stock_movements')
            .select('id, item_id, branch_id, kind, qty, unit_cost, note, created_at, reference_type')
            .eq('company_id', cid).order('created_at', { ascending: false }).limit(2000);
        if (from) mq = mq.gte('created_at', from);
        if (to)   mq = mq.lt('created_at', to);
        if (state.branch !== 'all') mq = mq.eq('branch_id', state.branch);
        const mv = await mq;
        state.movements = mv.data || [];
    } catch (err) {
        toast(err.message || String(err), 'fail');
        state.items = []; state.movements = [];
    } finally {
        state.loading = false;
    }
}

function costOf(itemId) { return Number(state.costByItem[itemId] || 0); }

// приход/расход valued at cost: receipts use their own unit_cost; issues/adjustments use the
// item's latest receipt cost. Returns period totals + current stock value.
function summary() {
    let inQty = 0, inSum = 0, outQty = 0, outSum = 0;
    for (const m of state.movements) {
        const q = Number(m.qty) || 0;
        if (m.kind === 'receipt') { inQty += q; inSum += q * (Number(m.unit_cost) || 0); }
        else if (m.kind === 'issue') { outQty += Math.abs(q); outSum += Math.abs(q) * costOf(m.item_id); }
        else { // adjustment: signed
            if (q >= 0) { inQty += q; inSum += q * costOf(m.item_id); }
            else { outQty += Math.abs(q); outSum += Math.abs(q) * costOf(m.item_id); }
        }
    }
    let stockQty = 0, stockVal = 0;
    for (const iid of Object.keys(state.stockByItem)) {
        const q = Number(state.stockByItem[iid]) || 0;
        stockQty += q; stockVal += q * costOf(iid);
    }
    return { inQty, inSum, outQty, outSum, stockQty, stockVal };
}

// ---- rendering ------------------------------------------------------------
function selectEl(options, value, onchange) {
    const el = h('select', {
        style: { height: '34px', padding: '0 10px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', background: 'var(--surface, #fff)' },
        onchange,
    }, ...options.map(([v, l]) => h('option', { value: v }, l)));
    el.value = value;
    return el;
}

function statCard(icon, label, big, sub, color) {
    return h('div', { class: 'card', style: { padding: '16px 18px', flex: '1 1 200px', minWidth: '180px', display: 'flex', flexDirection: 'column', gap: '5px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--ink-500)', fontSize: '12.5px', fontWeight: '600' } }, Icon(icon, { size: 15 }), label),
        h('div', { style: { fontSize: '20px', fontWeight: '700', color: color || 'var(--ink-900)' } }, big),
        sub ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub) : null,
    );
}

function typeBadge(kind, qty) {
    const q = Number(qty) || 0;
    let label = 'Корректировка', bg = 'var(--ink-100, #eef1f4)', fg = 'var(--ink-600, #55606b)';
    if (kind === 'receipt' || (kind === 'adjustment' && q >= 0)) { label = 'Приход'; bg = 'var(--ok-50, #e9f7ef)'; fg = 'var(--ok-700, #1a7f4b)'; }
    else if (kind === 'issue' || (kind === 'adjustment' && q < 0)) { label = 'Расход'; bg = 'var(--crit-50, #fdecec)'; fg = 'var(--crit-700, #c0392b)'; }
    return h('span', { style: { display: 'inline-block', padding: '1px 9px', borderRadius: '999px', background: bg, color: fg, fontSize: '12.5px', fontWeight: '700' } }, label);
}

function rowSum(m) {
    const q = Number(m.qty) || 0;
    if (m.kind === 'receipt') return q * (Number(m.unit_cost) || 0);
    return Math.abs(q) * costOf(m.item_id);
}

function movementsTable() {
    if (!state.movements.length) {
        return h('div', { class: 'card', style: { padding: '34px', textAlign: 'center' } },
            h('div', { class: 'muted', style: { fontSize: '13.5px' } }, 'Нет движений за выбранный период. Нажмите «Добавить приход», чтобы записать поступление.'));
    }
    const body = h('tbody', null, ...state.movements.map(m => {
        const q = Number(m.qty) || 0;
        const isIn = m.kind === 'receipt' || (m.kind === 'adjustment' && q >= 0);
        return h('tr', null,
            h('td', { class: 'muted', style: { fontSize: '12.5px', whiteSpace: 'nowrap' } }, fmtDateTime(m.created_at)),
            h('td', { class: 'cell-strong' }, itemName(m.item_id)),
            h('td', null, typeBadge(m.kind, q)),
            h('td', { class: 'num', style: { color: isIn ? 'var(--ok-700, #1a7f4b)' : 'var(--crit-700, #c0392b)', fontWeight: '600' } },
                (q > 0 ? '+' : '') + num(q)),
            h('td', { class: 'num muted' }, m.unit_cost != null ? money(m.unit_cost) : (state.costByItem[m.item_id] != null ? money(costOf(m.item_id)) : '—')),
            h('td', { class: 'num cell-strong' }, money(rowSum(m))),
        );
    }));
    return h('div', { class: 'card', style: { overflowX: 'auto' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Дата'), h('th', null, 'Товар'), h('th', null, 'Тип'),
                h('th', { class: 'num' }, 'Кол-во'), h('th', { class: 'num' }, 'Цена/ед'), h('th', { class: 'num' }, 'Сумма'))),
            body));
}

// ---- "+ Добавить приход" inline form --------------------------------------
function addForm() {
    const dl = h('datalist', { id: 'ledger-items' }, ...state.items.map(i => h('option', { value: i.name })));
    const nameInput = h('input', { list: 'ledger-items', placeholder: 'Название препарата/товара', autocomplete: 'off',
        style: inpStyle() });
    const unitInput = h('input', { placeholder: 'ед. (таб, амп, мл…)', style: inpStyle('120px') });
    const costInput = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'Цена за ед. (себестоимость)', style: inpStyle('190px') });
    const qtyInput  = h('input', { type: 'number', min: '0.0001', step: 'any', placeholder: 'Количество', style: inpStyle('140px') });
    const multiBranch = state.branches.length > 1;
    const branchSel = multiBranch
        ? selectEl([['', 'Выберите филиал…'], ...state.branches.map(b => [b.id, b.name])],
                   state.branch !== 'all' ? state.branch : '', null)
        : null;

    // Prefill unit from a matching existing item as the user types the name.
    nameInput.addEventListener('input', () => {
        const it = state.items.find(i => (i.name || '').trim().toLowerCase() === nameInput.value.trim().toLowerCase());
        if (it && it.unit && !unitInput.value) unitInput.value = it.unit;
    });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: (e) => onSaveReceipt(e, { nameInput, unitInput, costInput, qtyInput, branchSel }) },
        Icon('Check', { size: 14 }), ' Сохранить приход');

    return h('div', { class: 'card', style: { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' } }, dl,
        h('div', { style: { fontWeight: '600', fontSize: '13.5px', display: 'flex', alignItems: 'center', gap: '7px' } }, Icon('ArrowDown', { size: 15 }), 'Новый приход (поступление на склад)'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
            nameInput, unitInput, costInput, qtyInput, branchSel),
        h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'Если такого товара ещё нет — он будет создан автоматически. Стоимость считается по цене поступления.'),
        h('div', { style: { display: 'flex', gap: '8px' } },
            saveBtn,
            h('button', { class: 'btn', type: 'button', onclick: () => { state.adding = false; paint(); } }, 'Отмена')),
    );
}
function inpStyle(minW) {
    return { flex: minW ? '0 0 auto' : '1 1 220px', minWidth: minW || '220px', height: '36px', padding: '0 12px',
             border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px' };
}

async function onSaveReceipt(e, f) {
    const name = f.nameInput.value.trim();
    const cost = f.costInput.value === '' ? 0 : Number(f.costInput.value);
    const qty  = Number(f.qtyInput.value);
    const unit = f.unitInput.value.trim() || null;
    if (!name) { toast('Укажите название товара.', 'fail'); f.nameInput.focus(); return; }
    if (!(qty > 0)) { toast('Количество должно быть больше 0.', 'fail'); f.qtyInput.focus(); return; }
    if (!(cost >= 0) || !isFinite(cost)) { toast('Цена указана неверно.', 'fail'); f.costInput.focus(); return; }

    let branchId = state.branches.length === 1 ? state.branches[0].id : (f.branchSel ? f.branchSel.value : (state.branch !== 'all' ? state.branch : ''));
    if (!branchId) { toast('Выберите филиал.', 'fail'); if (f.branchSel) f.branchSel.focus(); return; }

    const cid = currentClinicId();
    e.target.disabled = true;
    try {
        let item = state.items.find(i => (i.name || '').trim().toLowerCase() === name.toLowerCase());
        if (!item) {
            // Brand-new drug/product → create via the service-role gateway (clinic_items RLS blocks browser inserts).
            const created = await gw('/crud/clinic_items', { method: 'POST', body: [{
                name, unit, price: cost, is_drug: true, active: true, company_id: cid,
            }] });
            item = (created && created[0]) || null;
            if (!item) throw new Error('Не удалось создать товар.');
            state.items.push(item);
        }
        const { error } = await supabase.from('stock_movements').insert({
            company_id: cid, item_id: item.id, branch_id: branchId,
            kind: 'receipt', qty: qty, unit_cost: cost,
            reference_type: 'manual', note: null,
        });
        if (error) throw error;
        toast(trf('Приход записан: {name} +{qty}.', { name, qty: num(qty) }), 'ok');
        state.adding = false;
        await loadAll();
        paint();
    } catch (err) {
        toast(err.message || String(err), 'fail');
    } finally {
        e.target.disabled = false;
    }
}

// ---- партия (batch) Excel import: rows -> catalog upsert + receipt movements --
// Column keys match the downloadable sample; Russian headers from a pharmacy
// export are also accepted so the raw report can be uploaded with minimal edits.
const BATCH_COLUMNS = [
    { key: 'name',        hint: 'Наименование (обязательно)' },
    { key: 'quantity',    hint: 'Количество (обязательно, число)' },
    { key: 'unit',        hint: 'Единица: шт, уп, фл, амп…' },
    { key: 'unit_cost',   hint: 'Цена за единицу — себестоимость за 1 ед. (обязательно)' },
    { key: 'sale_price',  hint: 'Цена продажи за единицу — необязательно' },
    { key: 'total_cost',  hint: 'ИЛИ общая сумма закупки за всё количество (если нет цены за ед.); цена за ед. = сумма ÷ количество' },
];
const BATCH_SAMPLE = [
    { name: 'Цефтриаксон 1 г', quantity: 30, unit: 'amp', unit_cost: 12000,  sale_price: 12800, total_cost: '' },
    { name: 'Изофлуран',       quantity: 2,  unit: 'фл',  unit_cost: 630000, sale_price: 630000, total_cost: '' },
    { name: 'Шприц 5 мл',      quantity: 50, unit: 'шт',  unit_cost: 600,    sale_price: 600,   total_cost: '' },
];

function pick(raw, keys) {
    for (const k of keys) { const v = raw[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; }
    return '';
}
function toNum(v) {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(/\s| /g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
}
// Robust sheet → row-objects: auto-detects the header row (a pharmacy export may
// carry a title + blank rows above it) by finding the first row that has both a
// name-ish and a quantity-ish column, so the RAW report uploads without editing.
function sheetToObjects(XLSX, ws) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const nameRe = /наимен|name|товар|препарат/i, qtyRe = /кол-?во|количес|quantity|qty/i;
    let hi = -1;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
        const cells = (aoa[i] || []).map(c => String(c || ''));
        if (cells.some(c => nameRe.test(c)) && cells.some(c => qtyRe.test(c))) { hi = i; break; }
    }
    if (hi < 0) hi = 0;
    const headers = (aoa[hi] || []).map(c => String(c || '').trim());
    const out = [];
    for (let i = hi + 1; i < aoa.length; i++) {
        const row = aoa[i] || [];
        const obj = {};
        headers.forEach((hname, c) => { if (hname) obj[hname] = row[c] !== undefined ? row[c] : ''; });
        out.push(obj);
    }
    return out;
}

function parseBatchRow(raw) {
    return {
        name:       String(pick(raw, ['name', 'Наименование', 'наименование', 'Товар', 'Препарат'])).trim(),
        quantity:   toNum(pick(raw, ['quantity', 'qty', 'Количество', 'количество', 'Кол-во'])),
        unit:       String(pick(raw, ['unit', 'Единица', 'Единица измерения', 'ед', 'Ед'])).trim(),
        unitCost:   toNum(pick(raw, ['unit_cost', 'cost', 'Себестоимость', 'Цена за единицу'])),
        totalCost:  toNum(pick(raw, ['total_cost', 'Общая стоимость без наценки', 'Сумма', 'Стоимость'])),
        salePrice:  toNum(pick(raw, ['price', 'sale_price', 'Цена продажи'])),
        totalPrice: toNum(pick(raw, ['total_price', 'Общая стоимость'])),
    };
}

async function importBatch(rows, branchId) {
    const cid = currentClinicId();
    const byName = {};
    for (const it of state.items) byName[(it.name || '').trim().toLowerCase()] = it;

    const valid = [], errors = [];
    rows.forEach((raw, i) => {
        const p = parseBatchRow(raw);
        if (!p.name && p.quantity == null) return;                         // blank row
        if (!p.name)          { errors.push(trf('стр.{n}: нет названия', { n: i + 2 })); return; }
        if (!(p.quantity > 0)) { errors.push(trf('стр.{n} ({name}): количество не указано', { n: i + 2, name: p.name })); return; }
        const unitCost  = p.unitCost  != null ? p.unitCost  : (p.totalCost  != null ? p.totalCost  / p.quantity : 0);
        const salePrice = p.salePrice != null ? p.salePrice : (p.totalPrice != null ? p.totalPrice / p.quantity : unitCost);
        valid.push({ name: p.name, unit: p.unit, quantity: p.quantity, unitCost, salePrice });
    });

    // Create brand-new drugs (deduped) in one gateway call (RLS blocks browser inserts on clinic_items).
    const newByName = {};
    for (const p of valid) {
        const key = p.name.toLowerCase();
        if (!byName[key] && !newByName[key]) newByName[key] = { name: p.name, unit: p.unit || null, price: Math.round(p.salePrice || 0), is_drug: true, active: true, company_id: cid };
    }
    const newList = Object.values(newByName);
    let createdItems = 0;
    if (newList.length) {
        const created = await gw('/crud/clinic_items', { method: 'POST', body: newList });
        for (const it of (created || [])) { byName[(it.name || '').trim().toLowerCase()] = it; state.items.push(it); }
        createdItems = (created || []).length;
    }

    // One receipt movement per row (chunked insert; trigger updates on-hand).
    const movements = [];
    for (const p of valid) {
        const item = byName[p.name.toLowerCase()];
        if (!item) { errors.push(trf('{name}: товар не создан', { name: p.name })); continue; }
        movements.push({ company_id: cid, item_id: item.id, branch_id: branchId, kind: 'receipt',
                         qty: p.quantity, unit_cost: p.unitCost, reference_type: 'import', note: 'Партия (импорт Excel)' });
    }
    let received = 0;
    for (let i = 0; i < movements.length; i += 200) {
        const chunk = movements.slice(i, i + 200);
        const { error } = await supabase.from('stock_movements').insert(chunk);
        if (error) throw error;
        received += chunk.length;
    }
    return { received, createdItems, errors };
}

async function downloadBatchSample() {
    let XLSX;
    try { XLSX = await loadXlsx(); } catch (e) { toast('Не удалось загрузить Excel-библиотеку.', 'fail'); return; }
    const aoa = [BATCH_COLUMNS.map(c => c.key), ...BATCH_SAMPLE.map(r => BATCH_COLUMNS.map(c => (r[c.key] ?? '')))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = BATCH_COLUMNS.map(c => ({ wch: Math.max(16, c.key.length + 6) }));
    BATCH_COLUMNS.forEach((col, i) => { const a = XLSX.utils.encode_cell({ r: 0, c: i }); if (ws[a] && col.hint) ws[a].c = [{ a: 'Easy-Med', t: col.hint }]; });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Партия');
    XLSX.writeFile(wb, 'easymed_partiya_sample.xlsx');
}

function openBatchImporter() {
    const cid = currentClinicId();
    if (!cid) { toast('Откройте страницу из клиники.', 'info'); return; }
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let parsed = [];
    const branchSel = state.branches.length > 1
        ? selectEl([['', 'Выберите филиал…'], ...state.branches.map(b => [b.id, b.name])], state.branch !== 'all' ? state.branch : '', null)
        : null;
    const status = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Выберите .xlsx / .csv. Первая строка — заголовки (см. «Образец»).');
    const fileInput = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', style: { display: 'none' }, onchange: (ev) => handleFile(ev.target.files && ev.target.files[0]) });
    const importBtn = h('button', { class: 'btn btn-primary', disabled: '', onclick: onImport }, Icon('Check', { size: 14 }), ' Загрузить приход');

    async function handleFile(file) {
        if (!file) return;
        status.textContent = trf('Чтение {name}…', { name: file.name });
        try {
            const XLSX = await loadXlsx();
            const buf = await file.arrayBuffer();
            const wb = XLSX.read(buf, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            if (!ws) throw new Error('в файле нет листов');
            parsed = sheetToObjects(XLSX, ws);
            const ok = parsed.map(parseBatchRow).filter(p => p.name && p.quantity > 0).length;
            status.textContent = trf('К загрузке: {ok} позиц. из {total} строк.', { ok, total: parsed.length });
            importBtn.disabled = ok ? null : '';
        } catch (e) {
            status.textContent = trf('Ошибка чтения: {msg}', { msg: e.message || e });
            importBtn.disabled = '';
        }
    }
    async function onImport(ev) {
        const branchId = state.branches.length === 1 ? state.branches[0].id : (branchSel ? branchSel.value : (state.branch !== 'all' ? state.branch : ''));
        if (!branchId) { toast('Выберите филиал.', 'fail'); if (branchSel) branchSel.focus(); return; }
        ev.currentTarget.disabled = true;
        status.textContent = tr('Загрузка…');
        try {
            const res = await importBatch(parsed, branchId);
            const msg = trf('Загружено позиций: {n}', { n: res.received }) + (res.createdItems ? ', ' + trf('новых товаров: {n}', { n: res.createdItems }) : '');
            toast(msg, 'ok');
            await loadAll(); paint();
            if (res.errors.length) status.textContent = msg + '. ' + trf('Пропущено: {n}.', { n: res.errors.length }) + ' ' + res.errors.slice(0, 4).join('; ');
            else close();
        } catch (e) {
            status.textContent = trf('Ошибка: {msg}', { msg: e.message || e });
            toast(e.message || String(e), 'fail');
        } finally {
            if (ev.currentTarget && ev.currentTarget.isConnected) ev.currentTarget.disabled = null;
        }
    }

    const card = h('div', { class: 'modal-card', style: { width: '640px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('ArrowDown', { size: 16 }), ' Загрузить партию (приход) из Excel'), h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
                h('button', { class: 'btn btn-outline', type: 'button', onclick: () => fileInput.click() }, Icon('Plus', { size: 14 }), ' Выбрать файл…'),
                h('button', { class: 'btn btn-outline', type: 'button', onclick: downloadBatchSample }, Icon('Download', { size: 14 }), ' Образец'),
                branchSel),
            h('div', { style: { padding: '10px 12px', borderRadius: '8px', background: 'var(--info-50, #eef5ff)', border: '1px solid var(--info-200, #c7dcfd)', fontSize: '12.5px', color: 'var(--info-700, #1d4ed8)', lineHeight: '1.55' } },
                h('b', null, 'Колонки'), ': name (Наименование), quantity (Количество), unit (Единица), unit_cost (Цена за единицу), sale_price (Цена продажи, необязат.). ',
                'Каждая строка — приход на склад; новый товар создаётся автоматически. Если задана только общая сумма (total_cost) — цена за ед. = сумма ÷ количество.'),
            fileInput,
            h('div', { style: { marginTop: '12px' } }, status),
        ),
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: close }, 'Отмена'), importBtn),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// ---- paint ----------------------------------------------------------------
function controls() {
    const right = [
        onBackRef && h('button', { class: 'btn btn-outline', onclick: () => onBackRef() }, Icon('ChevronLeft', { size: 14 }), ' К списку товаров'),
        selectEl(PERIOD_LABELS, state.period, (ev) => { state.period = ev.target.value; reload(); }),
    ];
    if (state.branches.length > 1) {
        right.push(selectEl([['all', 'Все филиалы'], ...state.branches.map(b => [b.id, b.name])], state.branch, (ev) => { state.branch = ev.target.value; reload(); }));
    }
    if (canEdit(PERM)) {
        right.push(
            h('button', { class: 'btn btn-outline', title: 'Загрузить партию (приход) из Excel', onclick: () => openBatchImporter() },
                Icon('Download', { size: 14 }), ' Партия из Excel'),
            h('button', { class: 'btn btn-primary', onclick: () => { state.adding = !state.adding; paint(); } },
                Icon('Plus', { size: 14 }), ' Добавить приход'));
    }
    return right.filter(Boolean);
}

function paint() {
    if (!bodyRef) return;
    clear(bodyRef);
    if (state.loading) { bodyRef.appendChild(h('div', { class: 'card', style: { padding: '34px', textAlign: 'center' } }, h('div', { class: 'muted' }, 'Загрузка…'))); return; }
    const s = summary();
    bodyRef.appendChild(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        state.adding ? addForm() : null,
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } },
            statCard('ArrowDown', 'Приход', money(s.inSum), trf('{n} ед. поступило', { n: num(s.inQty) }), 'var(--ok-700, #1a7f4b)'),
            statCard('ArrowUp', 'Расход', money(s.outSum), trf('{n} ед. израсходовано', { n: num(s.outQty) }), 'var(--crit-700, #c0392b)'),
            statCard('Layers', 'Остаток (по себестоимости)', money(s.stockVal), trf('{n} ед. на складе', { n: num(s.stockQty) })),
        ),
        movementsTable(),
    ));
}

async function reload() { state.loading = true; paint(); await loadAll(); paint(); }

export async function renderItemsLedger(container, { onBack } = {}) {
    containerRef = container; onBackRef = onBack || null;
    Object.assign(state, { period: 'month', branch: 'all', adding: false, loading: true, items: [], branches: [], movements: [] });
    clear(container);
    bodyRef = h('div');
    container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({ title: 'Приход-расход', subtitle: 'Поступление и расход товаров и препаратов — по себестоимости, по всем позициям.', right: controls() }),
        bodyRef,
    ));
    await loadAll();
    // Rebuild the header controls now that branches are known (branch filter appears).
    clear(container);
    bodyRef = h('div');
    container.appendChild(h('div', { class: 'fade-in', style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
        PageHead({ title: 'Приход-расход', subtitle: 'Поступление и расход товаров и препаратов — по себестоимости, по всем позициям.', right: controls() }),
        bodyRef,
    ));
    paint();
}
