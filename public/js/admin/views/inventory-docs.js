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
import { fmtPrice, fmtQty, fmtSignedQty, loadingCard, selStyle, numStyle } from './inventory-shared.js';

// Локальный анти-гонковый токен (в старом файле был общий на модуль).
let lastFetchToken = 0;

async function loadActiveProducts(cols = 'id,name,base_unit') {
    const { data, error } = await supabase.from('products')
        .select(cols).eq('active', 1).order('name', { ascending: true });
    if (error) throw error;
    return data || [];
}

function lineEditor(products, { withCost }) {
    const lineObjs = [];
    const body = h('tbody');

    function addLine() {
        const line = { product: null, qty: '', cost: '' };
        lineObjs.push(line);
        body.appendChild(buildRow(line));
    }
    function buildRow(line) {
        const prodSel = h('select', { style: selStyle },
            h('option', { value: '' }, '— Select product —'),
            ...products.map(p => h('option', { value: String(p.id) }, p.name)));
        prodSel.addEventListener('change', () => {
            line.product = products.find(p => p.id === Number(prodSel.value)) || null;
        });
        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', style: numStyle });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; });
        const costInp = withCost ? h('input', { type: 'number', min: '0', step: 'any', style: numStyle }) : null;
        if (costInp) costInp.addEventListener('input', () => { line.cost = costInp.value; });
        const removeBtn = h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', title: 'Remove line',
            onclick: () => { const i = lineObjs.indexOf(line); if (i >= 0) lineObjs.splice(i, 1); tr.remove(); if (!lineObjs.length) addLine(); },
        }, '×');
        const cells = [h('td', null, prodSel), h('td', { style: { width: '120px' } }, qtyInp)];
        if (withCost) cells.push(h('td', { style: { width: '130px' } }, costInp));
        cells.push(h('td', { style: { width: '36px', textAlign: 'center' } }, removeBtn));
        const tr = h('tr', null, ...cells);
        return tr;
    }

    addLine();
    const headCells = [h('th', null, 'Product'), h('th', null, 'Qty')];
    if (withCost) headCells.push(h('th', null, 'Unit cost'));
    headCells.push(h('th', null, ''));

    const el = h('div', null,
        h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '10px' } },
            h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ...headCells)), body)),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => addLine() }, Icon('Plus', { size: 13 }), ' Add line'));

    function getLines() {
        const out = [];
        for (const l of lineObjs) {
            if (!l.product) continue;
            const qty = Number(l.qty);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            const row = { product: l.product, qty };
            if (withCost) { const c = Number(l.cost); row.cost = (Number.isFinite(c) && c >= 0) ? c : 0; }
            out.push(row);
        }
        return out;
    }
    return { el, getLines };
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
// them into stock. Creating a PO + its lines is plain /api/db; receiving is the
// receive_purchase_order RPC (adds on_hand + WAC, marks the PO received/partial).
// =============================================================================
const poRefs = { tbody: null, emptyEl: null, totalEl: null };

function poStatusTag(s) {
    const m = { draft: ['Draft', ''], ordered: ['Ordered', 'info'], partial: ['Partial', 'warn'], received: ['Received', 'ok'], cancelled: ['Cancelled', ''] };
    const [l, k] = m[s] || [s, ''];
    return Tag(l, { kind: k, dot: true });
}

export function renderPurchaseOrdersTab(container) {
    poRefs.tbody = h('tbody');
    poRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'No purchase orders yet — create the first one.');
    poRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openPOModal(fetchPOsAndPaint) }, Icon('Plus', { size: 14 }), ' New order');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            poRefs.totalEl, h('div', { class: 'page-head-actions' }, addBtn)),
        tableCard(['PO #', 'Supplier', 'Status', 'Lines', 'Total', 'Date'], poRefs.tbody, poRefs.emptyEl)));
    fetchPOsAndPaint();
}

async function fetchPOsAndPaint() {
    const token = ++lastFetchToken;
    loadingRowInto(poRefs.tbody, 6); poRefs.emptyEl.style.display = 'none';
    try {
        const { data, error } = await supabase.from('purchase_orders')
            .select('id,po_number,status,total,created_at, suppliers(id,name), purchase_order_items(id)')
            .order('id', { ascending: false }).limit(200);
        if (token !== lastFetchToken) return;
        if (error) throw error;
        const rows = data || [];
        clear(poRefs.tbody);
        if (!rows.length) { poRefs.emptyEl.style.display = ''; }
        else for (const po of rows) {
            const nLines = (po.purchase_order_items || []).length;
            poRefs.tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openPODetail(po, fetchPOsAndPaint) },
                h('td', { class: 'cell-strong' }, po.po_number || '—'),
                h('td', null, (po.suppliers && po.suppliers.name) || h('span', { class: 'muted' }, '—')),
                h('td', null, poStatusTag(po.status)),
                h('td', { class: 'num' }, String(nLines)),
                h('td', { class: 'num' }, fmtPrice(po.total)),
                h('td', null, fmtDateTime(po.created_at))));
        }
        poRefs.totalEl.textContent = `${rows.length} order${rows.length === 1 ? '' : 's'}`;
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Failed to load purchase orders: ' + ((e && e.message) || e), 'fail');
        clear(poRefs.tbody); poRefs.emptyEl.style.display = '';
    }
}

async function openPOModal(onSaved) {
    let products = [], suppliers = [];
    try { products = await loadActiveProducts(); } catch (e) { toast('Failed to load products.', 'fail'); }
    try { const r = await supabase.from('suppliers').select('id,name').eq('active', 1).order('name', { ascending: true }); suppliers = r.data || []; } catch (e) { /* optional */ }

    const supplierSel = h('select', { style: selStyle }, h('option', { value: '' }, '— No supplier —'),
        ...suppliers.map(s => h('option', { value: String(s.id) }, s.name)));
    const notesInp = h('input', { type: 'text', placeholder: 'optional' });
    const editor = lineEditor(products, { withCost: true });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Create order');
    saveBtn.addEventListener('click', async () => {
        const lines = editor.getLines();
        if (!lines.length) { toast('Add at least one line.', 'fail'); return; }
        const total = lines.reduce((s, l) => s + l.qty * l.cost, 0);
        saveBtn.disabled = true; const prev = saveBtn.textContent; saveBtn.textContent = 'Creating…';
        try {
            const payload = { po_number: 'PO-' + Date.now().toString(36).toUpperCase(), status: 'draft', total,
                supplier_id: supplierSel.value ? Number(supplierSel.value) : null, notes: notesInp.value.trim() || null };
            const { data: po, error } = await supabase.from('purchase_orders').insert(payload).select('id').single();
            if (error) throw error;
            for (const l of lines) {
                const { error: liErr } = await supabase.from('purchase_order_items')
                    .insert({ po_id: po.id, product_id: l.product.id, qty_ordered: l.qty, unit_cost: l.cost }).select('id').single();
                if (liErr) throw liErr;
            }
            toast('Purchase order created', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Failed to create purchase order.', 'fail');
            saveBtn.disabled = false; saveBtn.textContent = prev;
        }
    });

    const { close } = docModal({
        title: 'New purchase order', icon: 'Receipt',
        body: [field('Supplier', supplierSel), editor.el, field('Notes', notesInp)],
        footer: (close) => [h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('span', { class: 'grow' }), saveBtn],
    });
}

async function openPODetail(po, onSaved) {
    const bodyWrap = h('div', null, h('div', { class: 'muted', style: { padding: '10px', fontSize: '12.5px' } }, 'Loading lines…'));
    const footWrap = h('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });

    const { close } = docModal({
        title: `Purchase order ${po.po_number}`, icon: 'Receipt', width: 640,
        body: [h('div', { style: { marginBottom: '8px' } }, poStatusTag(po.status),
            (po.suppliers && po.suppliers.name) ? h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '12.5px' } }, po.suppliers.name) : null),
            bodyWrap],
        footer: () => footWrap,
    });

    const { data: items, error } = await supabase.from('purchase_order_items')
        .select('id,qty_ordered,qty_received,unit_cost,line_total, products(name,base_unit)').eq('po_id', po.id);
    clear(bodyWrap);
    if (error) { bodyWrap.appendChild(h('div', { class: 'empty' }, 'Could not load lines.')); return; }
    const rows = items || [];
    bodyWrap.appendChild(h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Product'), h('th', null, 'Ordered'), h('th', null, 'Received'), h('th', null, 'Unit cost'), h('th', null, 'Line total'))),
            h('tbody', null, ...rows.map(it => {
                const unit = (it.products && it.products.base_unit) || '';
                return h('tr', null,
                    h('td', { class: 'cell-strong' }, (it.products && it.products.name) || '—'),
                    h('td', { class: 'num' }, `${fmtQty(it.qty_ordered)} ${unit}`.trim()),
                    h('td', { class: 'num' }, fmtQty(it.qty_received)),
                    h('td', { class: 'num' }, fmtPrice(it.unit_cost)),
                    h('td', { class: 'num' }, fmtPrice(it.line_total)));
            })))));

    const canReceive = !['received', 'cancelled'].includes(po.status);
    clear(footWrap);
    footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'));
    footWrap.appendChild(h('span', { class: 'grow' }));
    if (po.status === 'draft') {
        footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: async () => {
            try { const { error } = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', po.id).select().single(); if (error) throw error; toast('Order cancelled', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Failed to cancel.', 'fail'); }
        } }, 'Cancel order'));
    }
    if (canReceive) {
        const recvBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Receive all');
        recvBtn.addEventListener('click', async () => {
            recvBtn.disabled = true; recvBtn.textContent = 'Receiving…';
            try { const { error } = await supabase.rpc('receive_purchase_order', { po_id: po.id }); if (error) throw error; toast('Stock received', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Failed to receive.', 'fail'); recvBtn.disabled = false; recvBtn.textContent = 'Receive all'; }
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

export function renderRequisitionsTab(container) {
    reqRefs.tbody = h('tbody');
    reqRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Заявок пока нет — создайте первую.');
    reqRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReqModal(fetchReqsAndPaint) }, Icon('Plus', { size: 14 }), ' Новая заявка');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            reqRefs.totalEl, h('div', { class: 'page-head-actions' }, addBtn)),
        tableCard(['№ заявки', 'Отдел', 'Статус', 'Позиции', 'Дата'], reqRefs.tbody, reqRefs.emptyEl)));
    fetchReqsAndPaint();
}

async function fetchReqsAndPaint() {
    const token = ++lastFetchToken;
    loadingRowInto(reqRefs.tbody, 5); reqRefs.emptyEl.style.display = 'none';
    try {
        const { data, error } = await supabase.from('purchase_requisitions')
            .select('id,req_number,status,created_at, departments(id,name), purchase_requisition_items(id)')
            .order('id', { ascending: false }).limit(200);
        if (token !== lastFetchToken) return;
        if (error) throw error;
        const rows = data || [];
        clear(reqRefs.tbody);
        if (!rows.length) { reqRefs.emptyEl.style.display = ''; }
        else for (const rq of rows) {
            const nLines = (rq.purchase_requisition_items || []).length;
            reqRefs.tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openReqDetail(rq, fetchReqsAndPaint) },
                h('td', { class: 'cell-strong' }, rq.req_number || '—'),
                h('td', null, (rq.departments && rq.departments.name) || h('span', { class: 'muted' }, '—')),
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
        title: `Requisition ${rq.req_number}`, icon: 'Send', width: 560,
        body: [h('div', { style: { marginBottom: '8px' } }, reqStatusTag(rq.status),
            (rq.departments && rq.departments.name) ? h('span', { class: 'muted', style: { marginLeft: '10px', fontSize: '12.5px' } }, rq.departments.name) : null),
            bodyWrap],
        footer: () => footWrap,
    });

    const { data: items, error } = await supabase.from('purchase_requisition_items')
        .select('id,qty,note, products(name,base_unit)').eq('req_id', rq.id);
    clear(bodyWrap);
    if (error) { bodyWrap.appendChild(h('div', { class: 'empty' }, 'Could not load lines.')); return; }
    const rows = items || [];
    bodyWrap.appendChild(h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Product'), h('th', null, 'Qty'))),
            h('tbody', null, ...rows.map(it => h('tr', null,
                h('td', { class: 'cell-strong' }, (it.products && it.products.name) || '—'),
                h('td', { class: 'num' }, `${fmtQty(it.qty)} ${(it.products && it.products.base_unit) || ''}`.trim())))))));

    const canAct = ['draft', 'submitted', 'approved'].includes(rq.status);
    clear(footWrap);
    footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'));
    footWrap.appendChild(h('span', { class: 'grow' }));
    if (canAct) {
        footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: async () => {
            const reason = window.prompt('Reject reason (optional):', '') ;
            if (reason === null) return;
            try { const { error } = await supabase.from('purchase_requisitions').update({ status: 'rejected', reject_reason: reason || null }).eq('id', rq.id).select().single(); if (error) throw error; toast('Requisition rejected', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Failed to reject.', 'fail'); }
        } }, 'Reject'));
        const issueBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Approve & issue');
        issueBtn.addEventListener('click', async () => {
            issueBtn.disabled = true; issueBtn.textContent = 'Issuing…';
            try { const { error } = await supabase.rpc('approve_requisition_and_issue', { req_id: rq.id }); if (error) throw error; toast('Requisition issued', 'ok'); close(); await onSaved(); }
            catch (e) { toast((e && e.message) || 'Failed to issue.', 'fail'); issueBtn.disabled = false; issueBtn.textContent = 'Approve & issue'; }
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
    const m = { open: ['Open', ''], counting: ['Counting', 'info'], posted: ['Posted', 'ok'], cancelled: ['Cancelled', ''] };
    const [l, k] = m[s] || [s, ''];
    return Tag(l, { kind: k, dot: true });
}

export function renderStockCountsTab(container) {
    countRefs.tbody = h('tbody');
    countRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'No stock counts yet.');
    countRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    const addBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => createStockCount(fetchCountsAndPaint) }, Icon('Plus', { size: 14 }), ' New count');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            countRefs.totalEl, h('div', { class: 'page-head-actions' }, addBtn)),
        tableCard(['Count #', 'Status', 'Items', 'Posted', 'Created'], countRefs.tbody, countRefs.emptyEl)));
    fetchCountsAndPaint();
}

async function fetchCountsAndPaint() {
    const token = ++lastFetchToken;
    loadingRowInto(countRefs.tbody, 5); countRefs.emptyEl.style.display = 'none';
    try {
        const { data, error } = await supabase.from('stock_counts')
            .select('id,count_number,status,posted_at,created_at, stock_count_items(id)')
            .order('id', { ascending: false }).limit(200);
        if (token !== lastFetchToken) return;
        if (error) throw error;
        const rows = data || [];
        clear(countRefs.tbody);
        if (!rows.length) { countRefs.emptyEl.style.display = ''; }
        else for (const c of rows) {
            countRefs.tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openCountDetail(c, fetchCountsAndPaint) },
                h('td', { class: 'cell-strong' }, c.count_number || '—'),
                h('td', null, countStatusTag(c.status)),
                h('td', { class: 'num' }, String((c.stock_count_items || []).length)),
                h('td', null, c.posted_at ? fmtDateTime(c.posted_at) : h('span', { class: 'muted' }, '—')),
                h('td', null, fmtDateTime(c.created_at))));
        }
        countRefs.totalEl.textContent = `${rows.length} count${rows.length === 1 ? '' : 's'}`;
    } catch (e) {
        if (token !== lastFetchToken) return;
        toast('Failed to load stock counts: ' + ((e && e.message) || e), 'fail');
        clear(countRefs.tbody); countRefs.emptyEl.style.display = '';
    }
}

// Create a count sheet: snapshot every active product's current on_hand as the
// system_qty, leaving counted_qty blank for the counter to fill in.
async function createStockCount(onSaved) {
    if (!window.confirm('Create a stock-count sheet snapshotting all active products?')) return;
    try {
        const products = await loadActiveProducts('id,on_hand');
        if (!products.length) { toast('No active products to count.', 'fail'); return; }
        const { data: cnt, error } = await supabase.from('stock_counts')
            .insert({ count_number: 'SC-' + Date.now().toString(36).toUpperCase(), status: 'counting' }).select('id,count_number,status,posted_at,created_at').single();
        if (error) throw error;
        for (const p of products) {
            const { error: iErr } = await supabase.from('stock_count_items')
                .insert({ count_id: cnt.id, product_id: p.id, system_qty: Number(p.on_hand) || 0 }).select('id').single();
            if (iErr) throw iErr;
        }
        toast('Count sheet created', 'ok');
        if (typeof onSaved === 'function') await onSaved();
        openCountDetail(cnt, onSaved);
    } catch (e) {
        toast((e && e.message) || 'Failed to create count.', 'fail');
    }
}

async function openCountDetail(count, onSaved) {
    const bodyWrap = h('div', null, h('div', { class: 'muted', style: { padding: '10px', fontSize: '12.5px' } }, 'Loading lines…'));
    const footWrap = h('div', { style: { display: 'flex', width: '100%', alignItems: 'center', gap: '8px' } });
    const editable = ['open', 'counting'].includes(count.status);

    const { close } = docModal({
        title: `Stock count ${count.count_number}`, icon: 'Ruler', width: 640,
        body: [h('div', { style: { marginBottom: '8px' } }, countStatusTag(count.status)), bodyWrap],
        footer: () => footWrap,
    });

    const { data: items, error } = await supabase.from('stock_count_items')
        .select('id,system_qty,counted_qty, products(name,base_unit)').eq('count_id', count.id);
    clear(bodyWrap);
    if (error) { bodyWrap.appendChild(h('div', { class: 'empty' }, 'Could not load lines.')); return; }
    const rows = items || [];
    const inputs = new Map();   // item id -> input element
    bodyWrap.appendChild(h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px' } },
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, 'Product'), h('th', null, 'System'), h('th', null, 'Counted'), h('th', null, 'Variance'))),
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
            if (val !== null && (!Number.isFinite(val) || val < 0)) throw new Error('Counted quantities must be zero or more.');
            const { error } = await supabase.from('stock_count_items').update({ counted_qty: val }).eq('id', id).select('id').single();
            if (error) throw error;
        }
    }

    clear(footWrap);
    footWrap.appendChild(h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'));
    footWrap.appendChild(h('span', { class: 'grow' }));
    if (editable) {
        const saveBtn = h('button', { class: 'btn', type: 'button' }, 'Save counts');
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            try { await saveCounts(); toast('Counts saved', 'ok'); if (typeof onSaved === 'function') await onSaved(); }
            catch (e) { toast((e && e.message) || 'Failed to save.', 'fail'); }
            finally { saveBtn.disabled = false; }
        });
        const postBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Post count');
        postBtn.addEventListener('click', async () => {
            if (!window.confirm('Post this count? On-hand will be set to the counted quantities.')) return;
            postBtn.disabled = true; postBtn.textContent = 'Posting…';
            try {
                await saveCounts();
                const { error } = await supabase.rpc('post_stock_count', { count_id: count.id });
                if (error) throw error;
                toast('Count posted — stock reconciled', 'ok');
                close();
                if (typeof onSaved === 'function') await onSaved();
            } catch (e) {
                toast((e && e.message) || 'Failed to post count.', 'fail');
                postBtn.disabled = false; postBtn.textContent = 'Post count';
            }
        });
        footWrap.appendChild(saveBtn);
        footWrap.appendChild(postBtn);
    }
}
