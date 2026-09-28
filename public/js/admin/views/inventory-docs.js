// Закупки — PROCUREMENT_DOCS_V1 — документ-вкладки Phase 2: Заявки (purchase
// requisitions), Заказы на закупку (purchase orders + receive) и
// Инвентаризация (stock counts). Извлечено из прежнего inventory.js при
// переходе на PROCUREMENT_REDESIGN_V1 (RU-shell, отдельные файлы вкладок).
// Вся работа со складом идёт через RPC (receive_purchase_order,
// approve_requisition_and_issue, post_stock_count) — allow-list не даёт
// клиенту трогать on_hand напрямую.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, fmtDateTime, field, Tag } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fmtPrice, fmtMoney2, fmtQty, fmtSignedQty, loadingCard, selStyle, numStyle, vatSelect, vatToSelect, vatText } from './inventory-shared.js';
import { vatOnNet, linkPriceFor } from '../../shared/goods-catalog.js';   // SUPPLIERS_VAT_V1 — НДС строки заказа (для показа); цена связи (ревью F2)

// Локальный анти-гонковый токен (в старом файле был общий на модуль).
let lastFetchToken = 0;

async function loadActiveProducts(cols = 'id,name,base_unit') {
    const { data, error } = await supabase.from('products')
        .select(cols).eq('active', 1).order('name', { ascending: true });
    if (error) throw error;
    return data || [];
}

// SUPPLIERS_VAT_V1 (2026-09-28) — строка заказа на закупку: цена за БАЗОВУЮ
// единицу без НДС и ставка НДС. По умолчанию — из связи товара с поставщиком
// заказа, иначе ставка товара; поправленное руками смена поставщика не
// трогает. Суммы строки и заказа — для показа; НДС и сумму заказа записывает
// сервер (purchase_order_create).
// Ревью F2 — цена связи — за единицу закупки СВЯЗИ (её упаковка, «кор = 100
// таб»), а не товара: делить её на упаковку товара значило ошибиться в разы.
export function poLineDefaults(product, supplierId, links) {
    const link = supplierId ? (links || []).find((l) => l.product_id === product.id && l.supplier_id === supplierId) : null;
    if (link) {
        return { cost: linkPriceFor(link, product, 1), vat: link.vat_rate == null ? null : Number(link.vat_rate) };
    }
    return { cost: null, vat: product.vat_rate == null ? null : Number(product.vat_rate) };
}
export function poLineMoney({ qty, cost, vat }) {
    const net = Math.round((Number(qty) || 0) * (Number(cost) || 0) * 100) / 100;
    const v = vatOnNet(net, vat);
    return { net, vat: v, gross: Math.round((net + v) * 100) / 100 };
}

function poLineEditor(products, links, getSupplierId) {
    const lineObjs = [];
    const body = h('tbody');
    const netEl = h('span', { style: { fontWeight: 700 } }, '0');
    const vatEl = h('span', { style: { fontWeight: 700 } }, '0');
    const grossEl = h('span', { style: { fontWeight: 800 } }, '0');

    function refresh() {
        let net = 0, vat = 0, gross = 0;
        for (const l of lineObjs) {
            const m = poLineMoney(l);
            net += m.net; vat += m.vat; gross += m.gross;
            if (l.grossEl) l.grossEl.textContent = fmtMoney2(m.gross);
        }
        netEl.textContent = fmtMoney2(net); vatEl.textContent = fmtMoney2(vat); grossEl.textContent = fmtMoney2(gross);
    }
    function applyDefaults(line) {
        if (!line.product) return;
        const d = poLineDefaults(line.product, getSupplierId(), links);
        if (!line.costTouched) { line.cost = d.cost == null ? '' : String(d.cost); if (line.costInp) line.costInp.value = line.cost; }
        if (!line.vatTouched) { line.vat = d.vat; if (line.vatSel) line.vatSel.value = vatToSelect(d.vat); }
    }
    function addLine() {
        const line = { product: null, qty: '', cost: '', vat: null, costTouched: false, vatTouched: false };
        lineObjs.push(line);
        body.appendChild(buildRow(line));
        refresh();
    }
    function buildRow(line) {
        const unitEl = h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '6px' } }, '');
        const prodSel = h('select', { style: selStyle, 'aria-label': 'Товар' },
            h('option', { value: '' }, '— Select product —'),
            ...products.map(p => h('option', { value: String(p.id) }, p.name)));
        prodSel.addEventListener('change', () => {
            line.product = products.find(p => p.id === Number(prodSel.value)) || null;
            unitEl.textContent = (line.product && line.product.base_unit) || '';
            applyDefaults(line);
            refresh();
        });
        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', style: numStyle, 'aria-label': 'Количество' });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; refresh(); });
        line.costInp = h('input', { type: 'number', min: '0', step: 'any', style: numStyle, placeholder: 'цена', 'aria-label': 'Цена без НДС' });
        line.costInp.addEventListener('input', () => { line.cost = line.costInp.value; line.costTouched = true; refresh(); });
        line.vatSel = vatSelect(line.vat, (v) => { line.vat = v; line.vatTouched = true; refresh(); });
        line.grossEl = h('span', { style: { fontWeight: 700 } }, '0');
        const removeBtn = h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать строку', 'aria-label': 'Убрать строку',
            onclick: () => { const i = lineObjs.indexOf(line); if (i >= 0) lineObjs.splice(i, 1); row.remove(); if (!lineObjs.length) addLine(); refresh(); },
        }, '×');
        const row = h('tr', null,
            h('td', null, prodSel),
            h('td', { style: { width: '150px', whiteSpace: 'nowrap' } }, h('span', { style: { display: 'inline-block', width: '90px' } }, qtyInp), unitEl),
            h('td', { style: { width: '120px' } }, line.costInp),
            h('td', { style: { width: '110px' } }, line.vatSel),
            h('td', { class: 'num', style: { width: '120px' } }, line.grossEl),
            h('td', { style: { width: '36px', textAlign: 'center' } }, removeBtn));
        return row;
    }

    addLine();
    const el = h('div', null,
        h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '10px' } },
            h('table', { class: 'tbl' }, h('thead', null, h('tr', null,
                h('th', null, 'Товар'), h('th', null, 'Кол-во'), h('th', null, 'Цена без НДС'), h('th', null, 'НДС'), h('th', null, 'Сумма с НДС'), h('th', null, ''))),
            body)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addLine() }, Icon('Plus', { size: 13 }), ' Добавить строку'),
            h('span', { class: 'grow' }),
            h('span', { style: { fontSize: '13.5px', color: 'var(--ink-700)' } },
                h('span', null, 'Без НДС:'), ' ', netEl, ' · ', h('span', null, 'НДС:'), ' ', vatEl, ' · ', h('span', null, 'Итого с НДС:'), ' ', grossEl)),
        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
            'Цена — за единицу выдачи без НДС; цена и ставка подставляются из связи товара с поставщиком заказа.'));

    function getLines() {
        const out = [];
        for (const l of lineObjs) {
            if (!l.product) continue;
            const qty = Number(l.qty);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            const cost = l.cost === '' || l.cost == null ? null : Number(l.cost);
            out.push({ product: l.product, qty, cost: Number.isFinite(cost) && cost >= 0 ? cost : null, vat: l.vat });
        }
        return out;
    }
    // Смена поставщика заказа — цены и ставки его связи там, где их не правили руками.
    function supplierChanged() { for (const l of lineObjs) applyDefaults(l); refresh(); }
    return { el, getLines, supplierChanged };
}

/** Аргументы purchase_order_create из окна заказа. */
export function poCreatePayload({ supplierId, notes, lines }) {
    return {
        supplier_id: supplierId || null,
        notes: String(notes || '').trim() || null,
        lines: (lines || []).map((l) => ({
            product_id: l.product.id, qty: l.qty,
            ...(l.cost != null ? { unit_cost: l.cost } : {}),
            vat_rate: l.vat === undefined ? null : l.vat,
        })),
    };
}

// Small overlay/modal helper for the document modals below.
function docModal({ title, icon, body, footer, width = 760 }) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon(icon, { size: 16 }), ' ', title),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } }, body),
        h('footer', { class: 'modal-foot' }, footer(close))));
    document.body.appendChild(overlay);
    return { overlay, close };
}

function tableCard(headers, tbody, emptyEl) {
    return h('div', { class: 'card' },
        h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ...headers.map(x => h('th', null, x)))), tbody), emptyEl);
}
function loadingRowInto(tbody, span) {
    clear(tbody);
    tbody.appendChild(h('tr', null, h('td', { colspan: String(span), style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Loading…')));
}

// =============================================================================
// PURCHASE ORDERS TAB (live — PO_V1) — create purchasing documents and RECEIVE
// them into stock. Receiving is the receive_purchase_order RPC (adds on_hand +
// WAC, marks the PO received/partial). SUPPLIERS_VAT_V1 — creating a PO with
// its lines is ONE purchase_order_create call (lines carry a price without VAT
// and a VAT rate; the server records each line's VAT and the PO total with
// VAT) — the lines table is no longer writable through /api/db.
// =============================================================================
const poRefs = { tbody: null, emptyEl: null, totalEl: null };

function poStatusTag(s) {
    const m = { draft: ['Черновик', ''], ordered: ['Заказан', 'info'], partial: ['Частично принят', 'warn'], received: ['Принят', 'ok'], cancelled: ['Отменён', ''] };
    const [l, k] = m[s] || [s, ''];
    return Tag(l, { kind: k, dot: true });
}

export function renderPurchaseOrdersTab(container) {
    poRefs.tbody = h('tbody');
    poRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Заказов пока нет — создайте первый.');
    poRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openPOModal(fetchPOsAndPaint) }, Icon('Plus', { size: 14 }), ' Новый заказ');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            poRefs.totalEl, h('div', { class: 'page-head-actions' }, addBtn)),
        tableCard(['№ заказа', 'Поставщик', 'Статус', 'Строк', 'Без НДС', 'НДС', 'С НДС', 'Дата'], poRefs.tbody, poRefs.emptyEl)));
    fetchPOsAndPaint();
}

/**
 * SUPPLIERS_VAT_V1 (ревью M8) — деньги заказа в списке: без НДС, НДС и с НДС
 * по его строкам. Одна колонка «Сумма» (purchase_orders.total) у заказа,
 * оформленного после учёта НДС, была суммой С НДС, а у заказа до него — без
 * НДС: две разные основы под одним заголовком. Заказ, ни у одной строки
 * которого НДС не записан, — «не указан»: его сумма без НДС равна сумме с
 * НДС (то же правило, что у строки заказа и у «Прихода по поставщикам»).
 * → Map po_id → { lines, net, vat (null — не указан), gross }
 */
export function poMoneyByOrder(items) {
    const by = new Map();
    for (const it of items || []) {
        const k = it.po_id;
        if (k == null) continue;
        const m = poItemMoney(it);
        const t = by.get(k) || { lines: 0, net: 0, vat: null, gross: 0 };
        t.lines += 1;
        t.net = Math.round((t.net + m.net) * 100) / 100;
        if (m.vat != null) t.vat = Math.round(((t.vat || 0) + m.vat) * 100) / 100;
        t.gross = Math.round((t.gross + m.gross) * 100) / 100;
        by.set(k, t);
    }
    return by;
}

// CLOUD_LEFTOVER_COLUMNS_V1 — сколько строк в каждом документе. Отдельный
// запрос вместо вложенной связи: см. пояснение в шапке файла.
async function countLines(table, parentKey) {
    const { data, error } = await supabase.from(table).select(parentKey).limit(20000);
    const by = new Map();
    if (error) return by;   // счётчик — украшение колонки, из-за него список не пропадает
    for (const r of (data || [])) {
        const k = r[parentKey];
        if (k != null) by.set(k, (by.get(k) || 0) + 1);
    }
    return by;
}

async function fetchPOsAndPaint() {
    const token = ++lastFetchToken;
    loadingRowInto(poRefs.tbody, 8); poRefs.emptyEl.style.display = 'none';
    try {
        const { data, error } = await supabase.from('purchase_orders')
            .select('id,po_number,status,total,created_at, suppliers(id,name)')
            .order('id', { ascending: false }).limit(200);
        if (token !== lastFetchToken) return;
        if (error) throw error;
        const rows = data || [];
        // Ревью M8 — строки ИМЕННО этих заказов (прежде — первые 20 000 строк на
        // всю клинику): их число и деньги без НДС / НДС / с НДС.
        const ids = rows.map((po) => po.id);
        let money = new Map();
        if (ids.length) {
            const it = await supabase.from('purchase_order_items').select('po_id,qty_ordered,unit_cost,vat_rate,vat_amount').in('po_id', ids).limit(100000);
            if (token !== lastFetchToken) return;
            if (!it.error) money = poMoneyByOrder(it.data || []);   // деньги — украшение колонок, из-за них список не пропадает
        }
        clear(poRefs.tbody);
        if (!rows.length) { poRefs.emptyEl.style.display = ''; }
        else for (const po of rows) {
            const m = money.get(po.id) || { lines: 0, net: 0, vat: null, gross: 0 };
            poRefs.tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openPODetail(po, fetchPOsAndPaint) },
                h('td', { class: 'cell-strong' }, po.po_number || '—'),
                h('td', null, (po.suppliers && po.suppliers.name) || h('span', { class: 'muted' }, '—')),
                h('td', null, poStatusTag(po.status)),
                h('td', { class: 'num' }, String(m.lines)),
                h('td', { class: 'num' }, fmtMoney2(m.net)),
                h('td', { class: 'num' }, m.vat == null ? h('span', { class: 'muted' }, tr('не указан')) : fmtMoney2(m.vat)),
                h('td', { class: 'num' }, fmtMoney2(m.gross)),
                h('td', null, fmtDateTime(po.created_at))));
        }
        poRefs.totalEl.textContent = trf('Заказов: {n}', { n: rows.length });
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast(trf('Не удалось загрузить заказы: {msg}', { msg: (e && e.message) || e }), 'fail');
        clear(poRefs.tbody); poRefs.emptyEl.style.display = '';
    }
}

async function openPOModal(onSaved) {
    let products = [], suppliers = [];
    try { products = await loadActiveProducts('id,name,base_unit,pack_factor,vat_rate'); } catch (e) { toast('Не удалось загрузить товары.', 'fail'); }
    try { const r = await supabase.from('suppliers').select('id,name').eq('active', 1).order('name', { ascending: true }); suppliers = r.data || []; } catch (e) { /* optional */ }
    // SUPPLIERS_VAT_V1 — цены и ставки поставщика заказа для строк по
    // умолчанию. Ревью M6 — связи ВЫБРАННОГО поставщика, а не первые 5000 на
    // всю клинику: сверх них у товара не было цены по умолчанию. Массив один и
    // тот же (редактор держит ссылку), меняется его содержимое.
    const links = [];
    const linksBySupplier = new Map();
    let linksToken = 0;
    async function loadSupplierLinks(sid) {
        const token = ++linksToken;
        let rows = [];
        if (sid) {
            if (!linksBySupplier.has(sid)) {
                try {
                    const r = await supabase.from('item_suppliers').select('product_id, supplier_id, last_price, vat_rate, pack_factor').eq('supplier_id', sid).limit(100000);
                    linksBySupplier.set(sid, (r && !r.error && r.data) || []);
                } catch (e) { linksBySupplier.set(sid, []); }
            }
            rows = linksBySupplier.get(sid);
        }
        if (token !== linksToken) return false;   // поставщика уже сменили ещё раз
        links.splice(0, links.length, ...rows);
        return true;
    }

    const supplierSel = h('select', { style: selStyle }, h('option', { value: '' }, '— No supplier —'),
        ...suppliers.map(s => h('option', { value: String(s.id) }, s.name)));
    const notesInp = h('input', { type: 'text', placeholder: 'optional' });
    const editor = poLineEditor(products, links, () => (supplierSel.value ? Number(supplierSel.value) : null));
    supplierSel.addEventListener('change', async () => {
        if (await loadSupplierLinks(supplierSel.value ? Number(supplierSel.value) : null)) editor.supplierChanged();
    });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Создать заказ');
    saveBtn.addEventListener('click', async () => {
        const lines = editor.getLines();
        if (!lines.length) { toast('Добавьте хотя бы одну строку.', 'fail'); return; }
        saveBtn.disabled = true; const prev = saveBtn.textContent; saveBtn.textContent = tr('Creating…');
        try {
            // SUPPLIERS_VAT_V1 — заказ и строки одним вызовом: сервер считает НДС
            // строк и сумму заказа с НДС (purchase_order_create).
            const { error } = await supabase.rpc('purchase_order_create', poCreatePayload({
                supplierId: supplierSel.value ? Number(supplierSel.value) : null, notes: notesInp.value, lines }));
            if (error) throw error;
            toast('Заказ на закупку создан', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось создать заказ.', 'fail');
            saveBtn.disabled = false; saveBtn.textContent = prev;
        }
    });

    const { close } = docModal({
        title: 'Новый заказ на закупку', icon: 'Receipt', width: 900,
        body: [field('Поставщик', supplierSel), editor.el, field('Примечание', notesInp)],
        footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'), h('span', { class: 'grow' }), saveBtn],
    });
}

/**
 * SUPPLIERS_VAT_V1 — деньги строки заказа для окна заказа: без НДС, ставка,
 * НДС и с НДС. Строка до учёта НДС (обе колонки пусты) — «не указан», её
 * сумма без НДС и с НДС равны.
 */
export function poItemMoney(it) {
    const net = Math.round((Number(it.qty_ordered) || 0) * (Number(it.unit_cost) || 0) * 100) / 100;
    const unknown = it.vat_amount == null && it.vat_rate == null;
    const vat = unknown ? null : Math.round((Number(it.vat_amount) || 0) * 100) / 100;
    return { net, vat, gross: Math.round((net + (vat || 0)) * 100) / 100, rate: unknown ? tr('не указан') : vatText(it.vat_rate) };
}

async function openPODetail(po, onSaved) {
    const bodyWrap = h('div', null, h('div', { class: 'muted', style: { padding: '10px', fontSize: '12.5px' } }, 'Loading lines…'));
    const footWrap = h('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });

    const { close } = docModal({
        title: trf('Заказ на закупку {no}', { no: po.po_number }), icon: 'Receipt', width: 900,
        body: [h('div', { style: { marginBottom: '8px' } }, poStatusTag(po.status),
            (po.suppliers && po.suppliers.name) ? h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '12.5px' } }, po.suppliers.name) : null),
            bodyWrap],
        footer: () => footWrap,
    });

    const { data: items, error } = await supabase.from('purchase_order_items')
        .select('id,qty_ordered,qty_received,unit_cost,line_total,vat_rate,vat_amount, products(name,base_unit)').eq('po_id', po.id);
    clear(bodyWrap);
    if (error) { bodyWrap.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить строки.')); return; }
    const rows = items || [];
    const sum = { net: 0, vat: 0, gross: 0 };
    const body = rows.map(it => {
        const unit = (it.products && it.products.base_unit) || '';
        const m = poItemMoney(it);
        sum.net += m.net; sum.vat += m.vat || 0; sum.gross += m.gross;
        return h('tr', null,
            h('td', { class: 'cell-strong' }, (it.products && it.products.name) || '—'),
            h('td', { class: 'num' }, `${fmtQty(it.qty_ordered)} ${unit}`.trim()),
            h('td', { class: 'num' }, fmtQty(it.qty_received)),
            h('td', { class: 'num' }, fmtMoney2(it.unit_cost)),
            h('td', null, m.rate),
            h('td', { class: 'num' }, fmtMoney2(m.net)),
            h('td', { class: 'num' }, m.vat == null ? '—' : fmtMoney2(m.vat)),
            h('td', { class: 'num' }, fmtMoney2(m.gross)));
    });
    bodyWrap.appendChild(h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Товар'), h('th', null, 'Заказано'), h('th', null, 'Принято'), h('th', null, 'Цена без НДС'),
                h('th', null, 'Ставка НДС'), h('th', null, 'Сумма без НДС'), h('th', null, 'НДС'), h('th', null, 'Сумма с НДС'))),
            h('tbody', null, ...body))));
    bodyWrap.appendChild(h('div', { style: { textAlign: 'right', fontSize: '13.5px', color: 'var(--ink-700)', marginTop: '8px' } },
        h('span', null, 'Без НДС:'), ' ', fmtMoney2(sum.net), ' · ', h('span', null, 'НДС:'), ' ', fmtMoney2(sum.vat),
        ' · ', h('span', null, 'Итого с НДС:'), ' ', h('b', null, fmtMoney2(sum.gross))));

    const canReceive = !['received', 'cancelled'].includes(po.status);
    clear(footWrap);
    footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'));
    footWrap.appendChild(h('span', { class: 'grow' }));
    if (po.status === 'draft') {
        footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: async () => {
            try { const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', po.id).select().single(); if (error) throw error; toast('Заказ отменён', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Не удалось отменить.', 'fail'); }
        } }, 'Отменить заказ'));
    }
    if (canReceive) {
        const recvBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Принять всё');
        recvBtn.addEventListener('click', async () => {
            recvBtn.disabled = true; recvBtn.textContent = 'Receiving…';
            try { const { error } = await supabase.rpc('receive_purchase_order', { po_id: po.id }); if (error) throw error; toast('Товар принят на склад', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || tr('Не удалось принять товар.'), 'fail'); recvBtn.disabled = false; recvBtn.textContent = tr('Принять всё'); }
        });
        footWrap.appendChild(recvBtn);
    }
}

// =============================================================================
// REQUISITIONS TAB (live — REQ_V1) — a department requests stock; approving &
// issuing draws it from the pool (approve_requisition_and_issue RPC).
// =============================================================================
const reqRefs = { tbody: null, emptyEl: null, totalEl: null };

function reqStatusTag(s) {
    const m = { draft: ['Черновик', ''], submitted: ['На согласовании', 'info'], approved: ['Согласована', 'info'], issued: ['Выдана', 'ok'], rejected: ['Отклонена', 'warn'], converted: ['В заказе', ''] };
    const [l, k] = m[s] || [s, ''];
    return Tag(l, { kind: k, dot: true });
}

// STOCK_REQUEST_V1 (R2) — ДЛЯ КОГО ЗАЯВКА. После R1 заявку подаёт не только
// отдел: сотрудник просит себе, а минимум подаёт заявку сам («авто»).
// Одобрение выдаёт держателю заявки (approve_requisition_and_issue), поэтому
// кладовщику нужно видеть, КОМУ уйдёт товар: имя сотрудника или отдел. Старая
// заявка без держателя (до миграции 145 триггер ставит его сам) — по отделу.
function reqHolderLabel(rq, staffNames) {
    if (rq.holder_type === 'staff') return staffNames.get(rq.holder_id) || trf('Сотрудник №{id}', { id: rq.holder_id });
    return (rq.departments && rq.departments.name) || null;
}
const autoMark = () => h('span', { style: { marginLeft: '6px' } }, Tag(tr('авто'), { kind: 'info' }));

/** Имена сотрудников-держателей одним запросом; не загрузились — номер вместо имени. */
async function loadStaffNames(rows) {
    const ids = [...new Set(rows.filter((r) => r.holder_type === 'staff' && r.holder_id).map((r) => r.holder_id))];
    const names = new Map();
    if (!ids.length) return names;
    const { data, error } = await supabase.from('users').select('id,full_name').in('id', ids);
    if (error) return names;
    for (const u of data || []) names.set(u.id, u.full_name);
    return names;
}

export function renderRequisitionsTab(container) {
    reqRefs.tbody = h('tbody');
    reqRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Заявок пока нет — создайте первую.');
    reqRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReqModal(fetchReqsAndPaint) }, Icon('Plus', { size: 14 }), ' Новая заявка');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            reqRefs.totalEl, h('div', { class: 'page-head-actions' }, addBtn)),
        tableCard(['№ заявки', 'Для кого', 'Статус', 'Позиции', 'Дата'], reqRefs.tbody, reqRefs.emptyEl)));
    fetchReqsAndPaint();
}

async function fetchReqsAndPaint() {
    const token = ++lastFetchToken;
    loadingRowInto(reqRefs.tbody, 5); reqRefs.emptyEl.style.display = 'none';
    try {
        const [{ data, error }, lineCount] = await Promise.all([
            supabase.from('purchase_requisitions')
                .select('id,req_number,status,created_at,holder_type,holder_id,auto, departments(id,name)')
                .order('id', { ascending: false }).limit(200),
            countLines('purchase_requisition_items', 'req_id'),
        ]);
        if (token !== lastFetchToken) return;
        if (error) throw error;
        const rows = data || [];
        const staffNames = await loadStaffNames(rows);
        if (token !== lastFetchToken) return;
        clear(reqRefs.tbody);
        if (!rows.length) { reqRefs.emptyEl.style.display = ''; }
        else for (const rq of rows) {
            const nLines = lineCount.get(rq.id) || 0;
            const holderName = reqHolderLabel(rq, staffNames);
            reqRefs.tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openReqDetail({ ...rq, holder_name: holderName }, fetchReqsAndPaint) },
                h('td', { class: 'cell-strong' }, rq.req_number || '—', rq.auto ? autoMark() : null),
                h('td', null, holderName || h('span', { class: 'muted' }, '—')),
                h('td', null, reqStatusTag(rq.status)),
                h('td', { class: 'num' }, String(nLines)),
                h('td', null, fmtDateTime(rq.created_at))));
        }
        reqRefs.totalEl.textContent = trf('Заявок: {n}', { n: rows.length });
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast(trf('Не удалось загрузить заявки: {msg}', { msg: (e && e.message) || e }), 'fail');
        clear(reqRefs.tbody); reqRefs.emptyEl.style.display = '';
    }
}

// REQ_EASYMED_V1 — «Новая заявка» в дизайне easymed (отдел*, строки с
// примечаниями, поиск товара, согласование администратором).
async function openReqModal(onSaved) {
    let products = [], departments = [];
    try { products = await loadActiveProducts('id,name,base_unit'); } catch (e) { toast('Не удалось загрузить товары.', 'fail'); }
    try { const r = await supabase.from('departments').select('id,name').eq('active', 1).order('name', { ascending: true }); departments = r.data || []; } catch (e) { /* optional */ }

    const deptSel = h('select', { style: { ...selStyle, height: '38px' } },
        h('option', { value: '' }, 'Выберите отдел…'),
        ...departments.map(d => h('option', { value: String(d.id) }, d.name)));

    const lines = [];   // [{ product, qty, note }]
    const linesEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    function paintLines() {
        clear(linesEl);
        if (!lines.length) {
            linesEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '2px' } },
                'Найдите товар в поиске ниже — он появится здесь строкой заявки.'));
            return;
        }
        for (const ln of lines) {
            const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: String(ln.qty),
                style: { ...numStyle, width: '86px', flex: '0 0 auto' } });
            qtyInp.addEventListener('input', () => { ln.qty = qtyInp.value === '' ? null : Number(qtyInp.value); });
            const noteInp = h('input', { type: 'text', placeholder: 'Примечание', value: ln.note || '',
                style: { ...selStyle, width: '180px', flex: '0 0 auto' } });
            noteInp.addEventListener('input', () => { ln.note = noteInp.value; });
            linesEl.appendChild(h('div', {
                class: 'row',
                style: { gap: '8px', alignItems: 'center', flexWrap: 'nowrap', padding: '9px 12px',
                         border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'var(--white, #fff)' },
            },
                h('span', { style: { minWidth: '80px', flex: '1 1 auto', overflow: 'hidden' } },
                    h('span', { style: { display: 'block', fontWeight: 700, fontSize: '13.5px', color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ln.product.name),
                    h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ln.product.base_unit || '')),
                qtyInp, noteInp,
                h('button', {
                    type: 'button', title: 'Убрать',
                    style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', fontWeight: 700, flex: '0 0 auto' },
                    onclick: () => { lines.splice(lines.indexOf(ln), 1); paintLines(); },
                }, '×'),
            ));
        }
    }
    paintLines();

    // поиск товара (комбобокс, как в «Принять товар»)
    const prodSearch = h('input', {
        type: 'text', placeholder: 'Поиск товара — выберите, чтобы добавить…',
        style: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1px solid var(--ink-200)',
                 borderRadius: '10px', fontFamily: 'inherit', fontSize: '13.5px', outline: 'none' },
    });
    const prodResults = h('div', {
        style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 40,
                 maxHeight: '220px', overflow: 'auto', background: 'var(--white, #fff)',
                 border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' },
    });
    function paintProdResults() {
        clear(prodResults);
        const q = prodSearch.value.trim().toLowerCase();
        const pool = products.filter(p => !q || (p.name || '').toLowerCase().includes(q)).slice(0, 10);
        if (!pool.length) { prodResults.style.display = q ? '' : 'none'; if (q) prodResults.appendChild(h('div', { class: 'muted', style: { padding: '9px 12px', fontSize: '12.5px' } }, 'Не найдено')); return; }
        prodResults.style.display = '';
        for (const p of pool) {
            prodResults.appendChild(h('div', {
                style: { padding: '9px 12px', cursor: 'pointer', fontSize: '13.5px' },
                onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                onmousedown: (e) => { e.preventDefault(); lines.push({ product: p, qty: 1, note: '' }); prodSearch.value = ''; prodResults.style.display = 'none'; paintLines(); },
            }, p.name, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' · ' + (p.base_unit || ''))));
        }
    }
    prodSearch.addEventListener('input', paintProdResults);
    prodSearch.addEventListener('focus', paintProdResults);
    prodSearch.addEventListener('blur', () => setTimeout(() => { prodResults.style.display = 'none'; }, 150));
    const searchWrap = h('div', { style: { position: 'relative' } }, prodSearch, prodResults);

    const notesInp = h('input', { type: 'text', placeholder: 'Необязательно' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Новая заявка');
    saveBtn.addEventListener('click', async () => {
        if (!deptSel.value) { toast('Выберите отдел — кто запрашивает.', 'fail'); return; }
        if (!lines.length) { toast('Добавьте хотя бы один товар.', 'fail'); return; }
        for (const ln of lines) {
            if (!(Number(ln.qty) > 0)) { toast(trf('Кол-во должно быть больше нуля: {name}', { name: ln.product.name }), 'fail'); return; }
        }
        saveBtn.disabled = true; const prev = saveBtn.textContent; saveBtn.textContent = tr('Создаём…');
        try {
            const uid = (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.id) || null;
            const payload = { req_number: 'REQ-' + Date.now().toString(36).toUpperCase(), status: 'submitted',
                department_id: Number(deptSel.value), notes: notesInp.value.trim() || null };
            if (uid != null) payload.requested_by = uid;
            const { data: rq, error } = await supabase.from('purchase_requisitions').insert(payload).select('id').single();
            if (error) throw error;
            for (const l of lines) {
                const { error: liErr } = await supabase.from('purchase_requisition_items')
                    .insert({ req_id: rq.id, product_id: l.product.id, qty: Number(l.qty), note: (l.note || '').trim() || null }).select('id').single();
                if (liErr) throw liErr;
            }
            toast('Заявка создана — администратор согласует её в «Заявках».', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось создать заявку.', 'fail');
            saveBtn.disabled = false; saveBtn.textContent = prev;
        }
    });

    const { close } = docModal({
        title: 'Новая заявка', icon: 'Send',
        body: [
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '-6px' } },
                'Перечислите нужные товары; администратор согласует до превращения в заказ.'),
            field('Отдел (кто запрашивает)', deptSel, { required: true }),
            h('div', null,
                h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-800)', margin: '0 0 8px' } }, 'Товары ', h('span', { style: { color: 'var(--crit-500, #ef4444)' } }, '*')),
                linesEl,
                h('div', { style: { marginTop: '8px' } }, searchWrap)),
            field('Примечание', notesInp),
        ],
        footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'), h('span', { class: 'grow' }), saveBtn],
    });
}

async function openReqDetail(rq, onSaved) {
    const bodyWrap = h('div', null, h('div', { class: 'muted', style: { padding: '10px', fontSize: '12.5px' } }, 'Loading lines…'));
    const footWrap = h('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });

    const { close } = docModal({
        title: trf('Заявка {no}', { no: rq.req_number }), icon: 'Send', width: 560,
        body: [h('div', { style: { marginBottom: '8px' } }, reqStatusTag(rq.status),
            rq.auto ? autoMark() : null,
            (rq.holder_name || (rq.departments && rq.departments.name))
                ? h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '12.5px' } }, trf('Для кого: {name}', { name: rq.holder_name || rq.departments.name }))
                : null),
            bodyWrap],
        footer: () => footWrap,
    });

    const { data: items, error } = await supabase.from('purchase_requisition_items')
        .select('id,qty,note, products(name,base_unit)').eq('req_id', rq.id);
    clear(bodyWrap);
    if (error) { bodyWrap.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить строки.')); return; }
    const rows = items || [];
    bodyWrap.appendChild(h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Товар'), h('th', null, 'Кол-во'))),
            h('tbody', null, ...rows.map(it => h('tr', null,
                h('td', { class: 'cell-strong' }, (it.products && it.products.name) || '—'),
                h('td', { class: 'num' }, `${fmtQty(it.qty)} ${(it.products && it.products.base_unit) || ''}`.trim())))))));

    const canAct = ['draft', 'submitted', 'approved'].includes(rq.status);
    clear(footWrap);
    footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'));
    footWrap.appendChild(h('span', { class: 'grow' }));
    if (canAct) {
        footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: async () => {
            const reason = window.prompt('Reject reason (optional):', '') ;
            if (reason === null) return;
            try { const { error } = await supabase.from('purchase_requisitions').update({ status: 'rejected', reject_reason: reason || null }).eq('id', rq.id).select().single(); if (error) throw error; toast('Заявка отклонена', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Не удалось отклонить.', 'fail'); }
        } }, 'Отклонить'));
        const issueBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Approve & issue');
        issueBtn.addEventListener('click', async () => {
            issueBtn.disabled = true; issueBtn.textContent = 'Issuing…';
            try { const { error } = await supabase.rpc('approve_requisition_and_issue', { req_id: rq.id }); if (error) throw error; toast('Заявка одобрена, товар выдан', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Не удалось выдать товар по заявке.', 'fail'); issueBtn.disabled = false; issueBtn.textContent = 'Approve & issue'; }
        });
        footWrap.appendChild(issueBtn);
    }
}

// =============================================================================
// STOCK COUNTS TAB (live — COUNT_V1) — snapshot on-hand into a count sheet,
// enter physical quantities, then POST to reconcile (post_stock_count RPC sets
// on_hand to the counted value and books the signed variance).
// =============================================================================
const countRefs = { tbody: null, emptyEl: null, totalEl: null };

function countStatusTag(s) {
    const m = { open: ['Открыта', ''], counting: ['Идёт пересчёт', 'info'], posted: ['Проведена', 'ok'], cancelled: ['Отменена', ''] };
    const [l, k] = m[s] || [s, ''];
    return Tag(l, { kind: k, dot: true });
}

export function renderStockCountsTab(container) {
    countRefs.tbody = h('tbody');
    countRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Инвентаризаций пока нет.');
    countRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => createStockCount(fetchCountsAndPaint) }, Icon('Plus', { size: 14 }), ' Новая инвентаризация');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            countRefs.totalEl, h('div', { class: 'page-head-actions' }, addBtn)),
        tableCard(['№ ведомости', 'Статус', 'Позиций', 'Проведена', 'Создана'], countRefs.tbody, countRefs.emptyEl)));
    fetchCountsAndPaint();
}

async function fetchCountsAndPaint() {
    const token = ++lastFetchToken;
    loadingRowInto(countRefs.tbody, 5); countRefs.emptyEl.style.display = 'none';
    try {
        const [{ data, error }, lineCount] = await Promise.all([
            supabase.from('stock_counts')
                .select('id,count_number,status,posted_at,created_at')
                .order('id', { ascending: false }).limit(200),
            countLines('stock_count_items', 'count_id'),
        ]);
        if (token !== lastFetchToken) return;
        if (error) throw error;
        const rows = data || [];
        clear(countRefs.tbody);
        if (!rows.length) { countRefs.emptyEl.style.display = ''; }
        else for (const c of rows) {
            countRefs.tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openCountDetail(c, fetchCountsAndPaint) },
                h('td', { class: 'cell-strong' }, c.count_number || '—'),
                h('td', null, countStatusTag(c.status)),
                h('td', { class: 'num' }, String(lineCount.get(c.id) || 0)),
                h('td', null, c.posted_at ? fmtDateTime(c.posted_at) : h('span', { class: 'muted' }, '—')),
                h('td', null, fmtDateTime(c.created_at))));
        }
        countRefs.totalEl.textContent = trf('Инвентаризаций: {n}', { n: rows.length });
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast(trf('Не удалось загрузить инвентаризации: {msg}', { msg: (e && e.message) || e }), 'fail');
        clear(countRefs.tbody); countRefs.emptyEl.style.display = '';
    }
}

// Create a count sheet: snapshot every active product's current on_hand as the
// system_qty, leaving counted_qty blank for the counter to fill in.
async function createStockCount(onSaved) {
    if (!window.confirm('Create a stock-count sheet snapshotting all active products?')) return;
    try {
        const products = await loadActiveProducts('id,on_hand');
        if (!products.length) { toast('Нечего пересчитывать: активных товаров нет.', 'fail'); return; }
        const { data: cnt, error } = await supabase.from('stock_counts')
            .insert({ count_number: 'SC-' + Date.now().toString(36).toUpperCase(), status: 'counting' }).select('id,count_number,status,posted_at,created_at').single();
        if (error) throw error;
        for (const p of products) {
            const { error: iErr } = await supabase.from('stock_count_items')
                .insert({ count_id: cnt.id, product_id: p.id, system_qty: Number(p.on_hand) || 0 }).select('id').single();
            if (iErr) throw iErr;
        }
        toast('Ведомость пересчёта создана', 'ok');
        if (typeof onSaved === 'function') await onSaved();
        openCountDetail(cnt, onSaved);
    } catch (e) {
        toast((e && e.message) || 'Не удалось создать ведомость.', 'fail');
    }
}

async function openCountDetail(count, onSaved) {
    const bodyWrap = h('div', null, h('div', { class: 'muted', style: { padding: '10px', fontSize: '12.5px' } }, 'Loading lines…'));
    const footWrap = h('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });
    const editable = ['open', 'counting'].includes(count.status);

    const { close } = docModal({
        title: trf('Инвентаризация {no}', { no: count.count_number }), icon: 'Ruler', width: 640,
        body: [h('div', { style: { marginBottom: '8px' } }, countStatusTag(count.status)), bodyWrap],
        footer: () => footWrap,
    });

    const { data: items, error } = await supabase.from('stock_count_items')
        .select('id,system_qty,counted_qty, products(name,base_unit)').eq('count_id', count.id);
    clear(bodyWrap);
    if (error) { bodyWrap.appendChild(h('div', { class: 'empty' }, 'Не удалось загрузить строки.')); return; }
    const rows = items || [];
    const inputs = new Map();   // item id -> input element
    bodyWrap.appendChild(h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Товар'), h('th', null, 'По системе'), h('th', null, 'Пересчитано'), h('th', null, 'Расхождение'))),
            h('tbody', null, ...rows.map(it => {
                const unit = (it.products && it.products.base_unit) || '';
                const varEl = h('td', { class: 'num' }, it.counted_qty != null ? fmtSignedQty(Number(it.counted_qty) - Number(it.system_qty), '') : h('span', { class: 'muted' }, '—'));
                const inp = h('input', { type: 'number', step: 'any', style: numStyle, value: it.counted_qty != null ? String(it.counted_qty) : '', disabled: !editable });
                if (editable) inp.addEventListener('input', () => {
                    const v = inp.value.trim();
                    varEl.textContent = v === '' ? '' : fmtSignedQty(Number(v) - Number(it.system_qty), '');
                    if (v === '') varEl.appendChild(h('span', { class: 'muted' }, '—'));
                });
                inputs.set(it.id, inp);
                return h('tr', null,
                    h('td', { class: 'cell-strong' }, (it.products && it.products.name) || '—'),
                    h('td', { class: 'num' }, `${fmtQty(it.system_qty)} ${unit}`.trim()),
                    h('td', { style: { width: '120px' } }, inp),
                    varEl);
            })))));

    async function saveCounts() {
        for (const [id, inp] of inputs) {
            const raw = inp.value.trim();
            const val = raw === '' ? null : Number(raw);
            if (val !== null && (!Number.isFinite(val) || val < 0)) throw new Error('Пересчитанное количество не может быть отрицательным.');
            const { error } = await supabase.from('stock_count_items').update({ counted_qty: val }).eq('id', id).select('id').single();
            if (error) throw error;
        }
    }

    clear(footWrap);
    footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: close }, 'Закрыть'));
    footWrap.appendChild(h('span', { class: 'grow' }));
    if (editable) {
        const saveBtn = h('button', { class: 'btn', type: 'button' }, 'Сохранить пересчёт');
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            try { await saveCounts(); toast('Пересчёт сохранён', 'ok'); if (typeof onSaved === 'function') await onSaved(); }
            catch (e) { toast((e && e.message) || 'Не удалось сохранить.', 'fail'); }
            finally { saveBtn.disabled = false; }
        });
        const postBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Провести инвентаризацию');
        postBtn.addEventListener('click', async () => {
            if (!window.confirm('Post this count? On-hand will be set to the counted quantities.')) return;
            postBtn.disabled = true; postBtn.textContent = 'Posting…';
            try {
                await saveCounts();
                const { error } = await supabase.rpc('post_stock_count', { count_id: count.id });
                if (error) throw error;
                toast('Инвентаризация проведена — остатки пересчитаны', 'ok');
                close();
                if (typeof onSaved === 'function') await onSaved();
            } catch (e) {
                toast((e && e.message) || 'Не удалось провести инвентаризацию.', 'fail');
                postBtn.disabled = false; postBtn.textContent = tr('Провести инвентаризацию');
            }
        });
        footWrap.appendChild(saveBtn);
        footWrap.appendChild(postBtn);
    }
}
