// Закупки — «Товары» tab (catalog CRUD) + the shared Принять / Корректировка
// modals. PROCUREMENT_REDESIGN_V1 — extracted from the original single-file
// inventory.js. Catalog writes go through /api/db (allow-listed columns only)
// — on_hand and avg_cost change ONLY through RPCs:
//   receive_stock_lines («Принять»), adjust_stock («Корректировка»),
//   issue_stock_lines («Выдать» — see inventory-sklad.js),
//   dispense_item / void_dispense (visit-bill.js — unrelated, do not touch).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field, checkField } from '../ui.js';
import { fetchGuard, fmtPrice, fmtQty, CATEGORY_LABEL, selStyle, numStyle, isLowStock } from './inventory-shared.js';
import { openSupplierModal } from './inventory-suppliers.js';   // ADD_PRODUCT_EASYMED_V1 — «+ Новый поставщик» из карточки товара

const productRefs = { tbody: null, emptyEl: null, totalEl: null };

export function renderProductsTab(container) {
    productRefs.tbody = h('tbody');
    productRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пока нет товаров — добавьте первый.');
    productRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '');

    const addBtn = h('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: () => openProductModal(null, fetchProductsAndPaint),
    }, Icon('Plus', { size: 14 }), ' Добавить товар');

    const receiveBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: () => openReceiveModal(fetchProductsAndPaint),
    }, Icon('Download', { size: 14 }), ' Принять');

    container.appendChild(h('div', null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' } },
            productRefs.totalEl,
            h('div', { class: 'page-head-actions' }, addBtn, receiveBtn),
        ),
        h('div', { class: 'card' },
            h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Название'),
                    h('th', null, 'Категория'),
                    h('th', null, 'В наличии'),
                    h('th', null, 'Себестоимость'),
                    h('th', null, 'Цена продажи'),
                    h('th', null, 'Статус'),
                    h('th', null, ''),
                )),
                productRefs.tbody,
            ),
            productRefs.emptyEl,
        ),
    ));

    fetchProductsAndPaint();
}

async function fetchProductsAndPaint() {
    const token = ++fetchGuard.token;
    setLoadingRow();
    try {
        const { data, error } = await supabase.from('products')
            .select('*')
            .order('name', { ascending: true })
            .limit(1000);
        if (token !== fetchGuard.token) return;   // a newer fetch already landed
        if (error) {
            toast('Не удалось загрузить товары: ' + (error.message || error), 'fail');
            paintRows([]);
            return;
        }
        paintRows(data || []);
        if (productRefs.totalEl) productRefs.totalEl.textContent = `Товаров: ${(data || []).length}`;
    } catch (e) {
        if (token !== fetchGuard.token) return;
        toast('Не удалось загрузить товары: ' + (e && e.message || e), 'fail');
        paintRows([]);
    }
}

function setLoadingRow() {
    if (!productRefs.tbody) return;
    clear(productRefs.tbody);
    productRefs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '7', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…'),
    ));
    productRefs.emptyEl.style.display = 'none';
}

function paintRows(rows) {
    clear(productRefs.tbody);
    if (!rows || rows.length === 0) {
        productRefs.emptyEl.style.display = '';
        return;
    }
    productRefs.emptyEl.style.display = 'none';
    for (const p of rows) productRefs.tbody.appendChild(productRow(p));
}

function productRow(p) {
    const inactive = !p.active;
    const onHand = Number(p.on_hand) || 0;
    const low = isLowStock(p);

    const adjustBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: (ev) => { ev.stopPropagation(); openAdjustModal(p, fetchProductsAndPaint); },
    }, 'Корректировка');

    return h('tr', {
        class: 'row-click',
        style: { cursor: 'pointer', opacity: inactive ? '0.55' : '' },
        onclick: () => openProductModal(p, fetchProductsAndPaint),
    },
        h('td', { class: 'cell-strong' }, p.name || '—',
            p.code ? h('span', { class: 'muted', style: { marginLeft: '8px', fontWeight: '400' } }, p.code) : null),
        h('td', null, CATEGORY_LABEL[p.procurement_category] || p.procurement_category || '—',
            p.is_drug ? h('span', { style: { marginLeft: '8px' } }, Tag('Препарат', { kind: 'info' })) : null),
        h('td', { class: 'num' }, `${onHand} ${p.base_unit || ''}`.trim()),
        h('td', { class: 'num' }, fmtPrice(p.avg_cost)),
        h('td', { class: 'num' }, fmtPrice(p.sale_price)),
        h('td', null, Tag(p.active ? 'Активен' : 'Неактивен', { kind: p.active ? 'ok' : '', dot: true }),
            low ? h('span', { style: { marginLeft: '8px' } }, Tag('Мало', { kind: 'warn', dot: true })) : null),
        h('td', { style: { textAlign: 'right' } }, adjustBtn),
    );
}

// -----------------------------------------------------------------------------
// ADD / EDIT MODAL — p == null -> добавление; p задан -> редактирование.
// -----------------------------------------------------------------------------
// ADD_PRODUCT_EASYMED_V1 — карточка товара в дизайне easymed: Name* →
// Категория + Активен → карточка «Единицы измерения» (единица ВЫДАЧИ пациенту
// + единица СКЛАДА с коэффициентом) → карточка «Поставщики этого товара»
// (поиск, привязанные строки с ценой закупки и упаковкой, «+ Новый поставщик»).
// Маппинг на локальную модель: выдача -> base_unit (в ней ведётся остаток и
// списывается расход), склад/закупка -> purchase_unit + pack_factor.
// Связи поставщиков -> item_suppliers (+ products.supplier_id = первый).
const UNIT_OPTIONS = [
    ['шт', 'шт — штука'], ['мл', 'мл — миллилитр'], ['мг', 'мг — миллиграмм'],
    ['г', 'г — грамм'], ['таб', 'таб — таблетка'], ['амп', 'амп — ампула'],
    ['фл', 'фл — флакон'], ['уп', 'уп — упаковка'], ['кор', 'кор — коробка'],
    ['л', 'л — литр'], ['пач', 'пач — пачка'], ['пар', 'пар — пара'], ['компл', 'компл — комплект'],
];
function unitSelect(value, minWidth = '150px') {
    const val = value || 'шт';
    const known = UNIT_OPTIONS.some(([u]) => u === val);
    return h('select', { style: { ...selStyle, width: 'auto', minWidth } },
        ...(!known ? [h('option', { value: val, selected: true }, val)] : []),
        ...UNIT_OPTIONS.map(([u, label]) => h('option', { value: u, selected: u === val }, label)));
}

function openProductModal(p, onSaved) {
    const isEdit = !!p;

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // компактно: панели без своих верхних отступов (их даёт grid-gap .modal-body)
    const panelStyle = { background: 'var(--ink-25, #f8fafa)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '12px 14px' };
    const cap = (t) => h('div', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)', marginBottom: '8px' } }, t);
    const hint = (t) => h('div', { class: 'muted', style: { fontSize: '11.5px', margin: '2px 0 6px' } }, t);

    // ---- Name + Категория + Активен ----
    const nameInp = h('input', { type: 'text', required: true, value: p ? (p.name || '') : '', placeholder: 'e.g. Перчатки нитриловые М' });
    const categorySel = h('select', { style: selStyle },
        h('option', { value: '' }, 'Выберите категорию…'),
        ...Object.entries(CATEGORY_LABEL).map(([key, label]) =>
            h('option', { value: key, selected: (p ? p.procurement_category : 'medicines') === key }, label)));
    const activeChk = h('input', { type: 'checkbox', checked: p ? !!p.active : true });

    // ---- Единицы измерения ----
    const dispenseUnitSel = unitSelect(p ? p.base_unit : 'шт');
    const stockUnitSel    = unitSelect(p ? (p.purchase_unit || p.base_unit) : 'шт');
    const packFactorInp   = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.pack_factor != null) ? String(p.pack_factor) : '1',
        style: { ...numStyle, width: '90px' } });
    const packEq = h('span', { style: { fontSize: '13px', color: 'var(--ink-700)' } }, dispenseUnitSel.value);
    dispenseUnitSel.addEventListener('change', () => { packEq.textContent = dispenseUnitSel.value; });

    const unitsPanel = h('div', { style: panelStyle },
        cap('Единицы измерения'),
        h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-800)' } }, 'Единица ВЫДАЧИ пациенту'),
        hint('Самая мелкая единица (мл, шт-таблетка…) — в ней списывается расход.'),
        dispenseUnitSel,
        h('div', { style: { borderTop: '1px solid var(--ink-100)', margin: '10px 0' } }),
        h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-800)' } }, 'Единица СКЛАДА и закупки'),
        hint('В ней вы закупаете и видите остаток (флакон, упаковка…).'),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('span', { style: { fontWeight: 700 } }, '1'), stockUnitSel,
            h('span', null, '='), packFactorInp, packEq),
        hint('Если закупаете в той же единице, что и выдаёте — оставьте 1.'),
    );

    // ---- Поставщики этого товара (item_suppliers) ----
    let allSuppliers = [];
    const linked = [];   // [{ supplier_id, name, last_price, purchase_unit, pack_factor, _rowId? }]
    const linkedEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const linkedEmpty = h('div', { class: 'muted', style: { fontSize: '12px' } },
        'Поставщики не привязаны — найдите ниже или создайте нового.');

    function paintLinked() {
        clear(linkedEl);
        if (!linked.length) { linkedEl.appendChild(linkedEmpty); return; }
        for (const ln of linked) {
            // ОДНА строка: имя (ellipsis) · Цена закупки [цена] сум · 1 [ед] = [N] шт ×
            const priceInp = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'цена',
                value: ln.last_price != null ? String(ln.last_price) : '', style: { ...numStyle, width: '96px', flex: '0 0 auto' } });
            priceInp.addEventListener('input', () => { ln.last_price = priceInp.value === '' ? null : Number(priceInp.value); });
            const uSel = unitSelect(ln.purchase_unit || stockUnitSel.value, '104px');
            uSel.style.flex = '0 0 auto';
            uSel.addEventListener('change', () => { ln.purchase_unit = uSel.value; });
            const fInp = h('input', { type: 'number', min: '0', step: 'any',
                value: ln.pack_factor != null ? String(ln.pack_factor) : '1', style: { ...numStyle, width: '60px', flex: '0 0 auto' } });
            fInp.addEventListener('input', () => { ln.pack_factor = fInp.value === '' ? 1 : Number(fInp.value); });
            const lbl = (t) => h('span', { class: 'muted', style: { fontSize: '12px', flex: '0 0 auto', whiteSpace: 'nowrap' } }, t);
            linkedEl.appendChild(h('div', {
                class: 'row',
                style: { gap: '7px', alignItems: 'center', flexWrap: 'nowrap', padding: '8px 12px',
                         background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)', borderRadius: '10px' },
            },
                h('span', { style: { fontWeight: 700, color: 'var(--primary-700)', minWidth: '60px', flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ln.name),
                lbl('Цена закупки'), priceInp,
                lbl('сум · 1'), uSel,
                h('span', { style: { flex: '0 0 auto' } }, '='), fInp,
                lbl(dispenseUnitSel.value),
                h('button', {
                    type: 'button', title: 'Отвязать',
                    style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', fontWeight: 700, flex: '0 0 auto' },
                    onclick: () => { linked.splice(linked.indexOf(ln), 1); paintLinked(); },
                }, '×'),
            ));
        }
    }

    // Поле поиска — на всю ширину, с иконкой и фокус-подсветкой (как в easymed).
    const supSearch = h('input', {
        type: 'text', placeholder: 'Поиск поставщика по названию или телефону…',
        style: {
            width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 34px',
            border: '1px solid var(--ink-200)', borderRadius: '10px',
            fontFamily: 'inherit', fontSize: '13px', background: 'var(--white, #fff)',
            outline: 'none', transition: 'border-color .12s, box-shadow .12s',
        },
    });
    supSearch.addEventListener('focus', () => { supSearch.style.borderColor = 'var(--primary-400, #4bb39a)'; supSearch.style.boxShadow = '0 0 0 3px var(--primary-50, #f2faf8)'; });
    supSearch.addEventListener('blur',  () => { supSearch.style.borderColor = 'var(--ink-200)'; supSearch.style.boxShadow = 'none'; });
    const supSearchWrap = h('div', { style: { position: 'relative' } },
        h('span', { style: { position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'flex', pointerEvents: 'none' } },
            Icon('Search', { size: 14 })),
        supSearch);
    const supResults = h('div', { style: { display: 'none', border: '1px solid var(--ink-150, var(--ink-200))', borderRadius: '10px', marginTop: '4px', overflow: 'hidden', background: 'var(--white, #fff)' } });
    function paintResults() {
        clear(supResults);
        const q = supSearch.value.trim().toLowerCase();
        const pool = allSuppliers.filter(s => !linked.some(l => l.supplier_id === s.id))
            .filter(s => !q || (s.name || '').toLowerCase().includes(q) || (s.phone || '').includes(q))
            .slice(0, 8);
        if (!q && !pool.length) { supResults.style.display = 'none'; return; }
        supResults.style.display = '';
        if (!pool.length) { supResults.appendChild(h('div', { class: 'muted', style: { padding: '9px 12px', fontSize: '12.5px' } }, 'Не найдено')); return; }
        for (const s of pool) {
            supResults.appendChild(h('div', {
                style: { padding: '9px 12px', cursor: 'pointer', fontSize: '13px' },
                onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                onmousedown: (e) => {
                    e.preventDefault();
                    linked.push({ supplier_id: s.id, name: s.name, last_price: null, purchase_unit: stockUnitSel.value, pack_factor: Number(packFactorInp.value) || 1 });
                    supSearch.value = ''; supResults.style.display = 'none'; paintLinked();
                },
            }, s.name, s.phone ? h('span', { class: 'muted', style: { fontSize: '12px' } }, ' · ' + s.phone) : null));
        }
    }
    supSearch.addEventListener('input', paintResults);
    supSearch.addEventListener('focus', paintResults);
    supSearch.addEventListener('blur', () => setTimeout(() => { supResults.style.display = 'none'; }, 150));

    async function loadSuppliers() {
        try {
            const { data } = await supabase.from('suppliers').select('id,name,phone').eq('active', 1).order('name');
            allSuppliers = data || [];
        } catch (e) { allSuppliers = []; }
    }
    loadSuppliers();

    const newSupplierBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        style: { background: 'var(--warn-50, #fdf3e1)', borderColor: 'var(--warn-200, #f2d9a6)', color: 'var(--warn-800, #8a6116)', fontWeight: 700 },
        onclick: () => openSupplierModal(null, async () => {
            // связываем только что созданного поставщика (самый свежий id)
            await loadSuppliers();
            const newest = allSuppliers.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
            if (newest && !linked.some(l => l.supplier_id === newest.id)) {
                linked.push({ supplier_id: newest.id, name: newest.name, last_price: null, purchase_unit: stockUnitSel.value, pack_factor: Number(packFactorInp.value) || 1 });
                paintLinked();
            }
        }),
    }, Icon('Plus', { size: 13 }), ' Новый поставщик');

    const suppliersPanel = h('div', { style: panelStyle },
        cap('Поставщики этого товара'),
        linkedEl,
        h('div', { style: { marginTop: '10px' } }, supSearchWrap, supResults),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '10px', borderTop: '1px dashed var(--ink-150, var(--ink-200))', paddingTop: '10px' } },
            h('span', { class: 'muted', style: { flex: 1, fontSize: '12px' } }, 'Нет нужного поставщика в списке?'),
            newSupplierBtn),
    );

    // Цена продажи — в easymed её нет в этой форме, но локальный биллинг
    // списаний берёт цену отсюда; одна компактная строка внизу.
    const priceInp = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.sale_price != null) ? String(p.sale_price) : '', placeholder: '0',
        style: { ...numStyle, width: '140px' } });

    // подтягиваем существующие связи поставщиков (режим редактирования)
    if (isEdit) {
        (async () => {
            try {
                const { data } = await supabase.from('item_suppliers')
                    .select('id, supplier_id, last_price, purchase_unit, pack_factor, suppliers(name)')
                    .eq('product_id', p.id);
                for (const r of (data || [])) {
                    linked.push({ _rowId: r.id, supplier_id: r.supplier_id, name: (r.suppliers && r.suppliers.name) || ('#' + r.supplier_id),
                        last_price: r.last_price, purchase_unit: r.purchase_unit, pack_factor: r.pack_factor });
                }
                paintLinked();
            } catch (e) { /* карточка работает и без связей */ }
        })();
    }
    paintLinked();

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, isEdit ? 'Сохранить' : 'Добавить');
    saveBtn.addEventListener('click', save);

    async function save() {
        const name = nameInp.value.trim();
        if (!name) { toast('Укажите название товара.', 'fail'); return; }
        const packFactor = packFactorInp.value === '' ? 1 : Number(packFactorInp.value);
        if (!Number.isFinite(packFactor) || packFactor <= 0) { toast('Укажите корректный коэффициент упаковки.', 'fail'); return; }
        const price = priceInp.value === '' ? (p && p.sale_price != null ? Number(p.sale_price) : 0) : Number(priceInp.value);
        if (!Number.isFinite(price) || price < 0) { toast('Укажите корректную цену продажи.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = isEdit ? 'Сохраняем…' : 'Добавляем…';
        try {
            const baseUnit = dispenseUnitSel.value;
            const payload = {
                name,
                procurement_category: categorySel.value || 'medicines',
                base_unit:            baseUnit,
                unit:                 baseUnit,
                purchase_unit:        stockUnitSel.value,
                pack_factor:          packFactor,
                sale_price:           price,
                supplier_id:          linked.length ? linked[0].supplier_id : null,
                active:               activeChk.checked ? 1 : 0,
            };

            const { data: saved, error } = isEdit
                ? await supabase.from('products').update(payload).eq('id', p.id).select().single()
                : await supabase.from('products').insert(payload).select().single();
            if (error) throw error;
            const productId = isEdit ? p.id : saved.id;

            // синхронизируем item_suppliers с привязанными строками
            const { data: existRows } = await supabase.from('item_suppliers')
                .select('id, supplier_id').eq('product_id', productId);
            const exist = existRows || [];
            for (const ex of exist) {
                if (!linked.some(l => l.supplier_id === ex.supplier_id)) {
                    await supabase.from('item_suppliers').delete().eq('id', ex.id);
                }
            }
            for (const ln of linked) {
                const row = { last_price: ln.last_price, purchase_unit: ln.purchase_unit || stockUnitSel.value, pack_factor: ln.pack_factor || 1 };
                const ex = exist.find(x => x.supplier_id === ln.supplier_id);
                if (ex) await supabase.from('item_suppliers').update(row).eq('id', ex.id);
                else await supabase.from('item_suppliers').insert({ product_id: productId, supplier_id: ln.supplier_id, ...row });
            }

            toast('Сохранено', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось сохранить товар.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    const bodyChildren = [
        field('Name', nameInp, { required: true }),
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-end' } },
            h('div', { style: { flex: 1 } }, field('Категория', categorySel)),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', paddingBottom: '12px', cursor: 'pointer', whiteSpace: 'nowrap' } },
                activeChk, 'Активен'),
        ),
        unitsPanel,
        suppliersPanel,
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', marginTop: '14px' } },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)', flex: 1 } }, 'Цена продажи (списание пациенту), сум'),
            priceInp),
    ];
    if (isEdit) {
        bodyChildren.push(h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '10px' } },
            `В наличии: ${fmtQty(p.on_hand)} ${p.base_unit || ''} · себестоимость ${fmtPrice(p.avg_cost)}. Остаток меняется через «Принять» / «Корректировка».`));
    }

    // modal-compact ОБЯЗАТЕЛЕН: без него глобальное правило (MODAL_COMPACT_OPTOUT_V1)
    // растягивает карточку почти на весь экран (!important).
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '720px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, isEdit ? 'Товар' : 'Add product'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            ...bodyChildren,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    nameInp.focus();
}

// -----------------------------------------------------------------------------
// ПРИНЯТЬ — multi-line, unit-aware, cost-tracked receiving. Каждая строка:
// { product, unit:'base'|'purchase', qty, unitCost }. Вся математика на
// сервере (receive_stock_lines) — подсказка в строке только для отображения.
// -----------------------------------------------------------------------------
export function openReceiveModal(onSaved) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const st = { products: [], suppliers: [], lines: [] };

    const linesEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const linesEmpty = h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '6px 2px' } },
        'Найдите товар в поиске выше — он появится здесь строкой прихода.');
    const totalEl = h('span', { style: { fontWeight: 800 } }, '0');

    const genBatch = () => {
        const d = new Date();
        const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        return ymd + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    };

    function refreshTotal() {
        const t = st.lines.reduce((s, ln) => s + (Number(ln.qty) || 0) * (Number(ln.unitCost) || 0), 0);
        totalEl.textContent = fmtPrice(t);
    }

    function supplierSelect(ln) {
        const sel = h('select', { style: { ...selStyle, width: 'auto', minWidth: '140px', maxWidth: '160px', flex: '0 0 auto' } },
            h('option', { value: '' }, 'Выберите поставщика…'),
            ...st.suppliers.map(s => h('option', { value: String(s.id), selected: String(ln.supplierId || '') === String(s.id) }, s.name)));
        sel.addEventListener('change', () => { ln.supplierId = sel.value ? Number(sel.value) : null; });
        return sel;
    }

    function paintLines() {
        clear(linesEl);
        if (!st.lines.length) { linesEl.appendChild(linesEmpty); refreshTotal(); return; }
        const lbl = (t) => h('span', { class: 'muted', style: { fontSize: '11.5px', flex: '0 0 auto', whiteSpace: 'nowrap' } }, t);
        for (const ln of st.lines) {
            const supSel = supplierSelect(ln);
            const newSupBtn = h('button', {
                class: 'btn btn-sm', type: 'button', title: 'Новый поставщик',
                style: { background: 'var(--warn-50, #fdf3e1)', borderColor: 'var(--warn-200, #f2d9a6)', color: 'var(--warn-800, #8a6116)', fontWeight: 700, padding: '4px 8px', flex: '0 0 auto' },
                onclick: () => openSupplierModal(null, async () => {
                    await loadSuppliers();
                    const newest = st.suppliers.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
                    if (newest) ln.supplierId = newest.id;
                    paintLines();
                }),
            }, '+');
            const batchInp = h('input', { type: 'text', placeholder: 'серия №', value: ln.batchNo || '',
                style: { ...selStyle, width: '100px', flex: '0 0 auto' } });
            batchInp.addEventListener('input', () => { ln.batchNo = batchInp.value; });
            const regenBtn = h('button', {
                type: 'button', title: 'Сгенерировать номер партии',
                style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', flex: '0 0 auto', display: 'flex' },
                onclick: () => { ln.batchNo = genBatch(); batchInp.value = ln.batchNo; },
            }, Icon('Refresh', { size: 14 }));
            const expInp = h('input', { type: 'date', value: ln.expiry || '',
                style: { ...selStyle, width: '132px', flex: '0 0 auto' } });
            expInp.addEventListener('input', () => { ln.expiry = expInp.value; });
            const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: ln.qty != null ? String(ln.qty) : '1',
                style: { ...numStyle, width: '72px', flex: '0 0 auto' } });
            qtyInp.addEventListener('input', () => { ln.qty = qtyInp.value === '' ? null : Number(qtyInp.value); refreshTotal(); });
            const costInp = h('input', { type: 'number', min: '0', step: 'any', value: ln.unitCost != null ? String(ln.unitCost) : '',
                placeholder: 'цена', style: { ...numStyle, width: '96px', flex: '0 0 auto' } });
            costInp.addEventListener('input', () => { ln.unitCost = costInp.value === '' ? null : Number(costInp.value); refreshTotal(); });

            const unitLabel = ln.product.purchase_unit || ln.product.base_unit || '';
            linesEl.appendChild(h('div', {
                class: 'row',
                style: { gap: '7px', alignItems: 'center', flexWrap: 'nowrap', padding: '9px 12px',
                         border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'var(--white, #fff)' },
            },
                h('span', { style: { minWidth: '90px', flex: '1 1 auto', overflow: 'hidden' } },
                    h('span', { style: { display: 'block', fontWeight: 700, fontSize: '13px', color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ln.product.name),
                    h('span', { class: 'muted', style: { fontSize: '11.5px' } }, unitLabel)),
                lbl('Поставщик'), supSel, newSupBtn,
                lbl('Партия / серия №'), batchInp, regenBtn,
                h('span', { style: { flex: '0 0 auto', display: 'flex', color: 'var(--ink-400)' } }, Icon('Clock', { size: 13 })),
                lbl('Срок годности'), expInp,
                qtyInp, costInp,
                h('button', {
                    type: 'button', title: 'Убрать строку',
                    style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', fontWeight: 700, flex: '0 0 auto' },
                    onclick: () => { st.lines.splice(st.lines.indexOf(ln), 1); paintLines(); },
                }, '×'),
            ));
        }
        refreshTotal();
    }

    function addLineFor(p) {
        st.lines.push({ product: p, supplierId: p.supplier_id || null, batchNo: '', expiry: '',
            qty: 1, unitCost: p.avg_cost != null && p.avg_cost > 0 ? p.avg_cost * (p.pack_factor > 0 ? p.pack_factor : 1) : null });
        paintLines();
    }

    // ---- поиск товара (комбобокс сверху, как в easymed) ----
    const prodSearch = h('input', {
        type: 'text', placeholder: 'Поиск товара — выберите, чтобы добавить…',
        style: { width: '100%', boxSizing: 'border-box', padding: '11px 12px 11px 34px',
                 border: '1px solid var(--ink-200)', borderRadius: '12px', fontFamily: 'inherit',
                 fontSize: '13.5px', outline: 'none', transition: 'border-color .12s, box-shadow .12s' },
    });
    prodSearch.addEventListener('focus', () => { prodSearch.style.borderColor = 'var(--primary-400, #4bb39a)'; prodSearch.style.boxShadow = '0 0 0 3px var(--primary-50, #f2faf8)'; paintProdResults(); });
    prodSearch.addEventListener('blur', () => { prodSearch.style.borderColor = 'var(--ink-200)'; prodSearch.style.boxShadow = 'none'; setTimeout(() => { prodResults.style.display = 'none'; }, 150); });
    const prodResults = h('div', {
        style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 40,
                 maxHeight: '240px', overflow: 'auto', background: 'var(--white, #fff)',
                 border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' },
    });
    function paintProdResults() {
        clear(prodResults);
        const q = prodSearch.value.trim().toLowerCase();
        const pool = st.products.filter(p => !q || (p.name || '').toLowerCase().includes(q)).slice(0, 10);
        if (!pool.length) { prodResults.style.display = q ? '' : 'none'; if (q) prodResults.appendChild(h('div', { class: 'muted', style: { padding: '10px 12px', fontSize: '12.5px' } }, 'Не найдено')); return; }
        prodResults.style.display = '';
        for (const p of pool) {
            prodResults.appendChild(h('div', {
                style: { padding: '9px 12px', cursor: 'pointer', fontSize: '13px' },
                onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                onmousedown: (e) => { e.preventDefault(); addLineFor(p); prodSearch.value = ''; prodResults.style.display = 'none'; },
            }, p.name, h('span', { class: 'muted', style: { fontSize: '12px' } }, ' · ' + (p.base_unit || '') + ' · остаток ' + fmtQty(p.on_hand))));
        }
    }
    prodSearch.addEventListener('input', paintProdResults);
    const searchWrap = h('div', { style: { position: 'relative', flex: 1 } },
        h('span', { style: { position: 'absolute', left: '11px', top: '21px', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'flex', pointerEvents: 'none' } }, Icon('Search', { size: 15 })),
        prodSearch, prodResults);

    const newProductBtn = h('button', {
        class: 'btn', type: 'button', style: { flex: '0 0 auto' },
        onclick: () => openProductModal(null, async () => {
            await loadProducts();
            const newest = st.products.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
            if (newest) addLineFor(newest);
        }),
    }, Icon('Plus', { size: 14 }), ' Новый товар');

    async function loadProducts() {
        const { data, error } = await supabase.from('products').select('*').eq('active', 1).order('name').limit(1000);
        if (error) { toast('Товары не загрузились: ' + error.message, 'fail'); return; }
        st.products = data || [];
    }
    async function loadSuppliers() {
        const { data } = await supabase.from('suppliers').select('id,name').eq('active', 1).order('name');
        st.suppliers = data || [];
    }
    (async () => { await Promise.all([loadProducts(), loadSuppliers()]); paintLines(); })();

    // ---- печать этикеток (name · партия · годен до · Nx) ----
    function printLabels() {
        if (!st.lines.length) { toast('Нет строк для этикеток.', 'fail'); return; }
        const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        const cells = st.lines.map(ln => `
<div style="border:1px dashed #999;border-radius:6px;padding:8px 10px;width:220px;font:12px/1.45 system-ui;">
  <div style="font-weight:700;">${esc(ln.product.name)}</div>
  ${ln.batchNo ? `<div>Партия: <b>${esc(ln.batchNo)}</b></div>` : ''}
  ${ln.expiry ? `<div>Годен до: <b>${esc(ln.expiry.split('-').reverse().join('.'))}</b></div>` : ''}
  <div>Кол-во: <b>${esc(ln.qty)} ${esc(ln.product.purchase_unit || ln.product.base_unit || '')}</b></div>
</div>`).join('');
        const w = window.open('', '_blank', 'width=760,height=900');
        if (!w) { toast('Браузер заблокировал окно печати.', 'fail'); return; }
        w.document.write(`<!DOCTYPE html><html><head><title>Этикетки</title></head>
<body onload="print()" style="display:flex;flex-wrap:wrap;gap:10px;padding:16px;">${cells}</body></html>`);
        w.document.close();
    }

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Приход');
    saveBtn.addEventListener('click', save);

    async function save() {
        if (!st.lines.length) { toast('Добавьте хотя бы один товар.', 'fail'); return; }
        for (const ln of st.lines) {
            if (!(Number(ln.qty) > 0)) { toast('Кол-во должно быть больше нуля: ' + ln.product.name, 'fail'); return; }
            if (!(Number(ln.unitCost) >= 0)) { toast('Укажите цену за единицу: ' + ln.product.name, 'fail'); return; }
        }
        saveBtn.disabled = true; saveBtn.textContent = 'Проводим…';
        try {
            const { error } = await supabase.rpc('receive_stock_lines', {
                lines: st.lines.map(ln => ({
                    product_id: ln.product.id, unit: 'purchase',
                    qty: Number(ln.qty), unit_cost: Number(ln.unitCost),
                    supplier_id: ln.supplierId || null,
                    batch_no: ln.batchNo || null,
                    expiry_date: ln.expiry || null,
                })),
            });
            if (error) throw error;
            toast('Приход проведён — остатки обновлены.', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось провести приход.', 'fail');
            saveBtn.disabled = false; saveBtn.textContent = 'Приход';
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '1180px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', { style: { margin: 0 } }, 'Принять товар'),
                h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } }, 'Фиксирует приход; остаток обновляется автоматически.')),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, searchWrap, newProductBtn),
            h('div', null,
                h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-800)', margin: '2px 0 8px' } }, 'Товары ', h('span', { style: { color: 'var(--crit-500, #ef4444)' } }, '*')),
                linesEl),
            h('div', { style: { textAlign: 'right', fontSize: '13px', color: 'var(--ink-700)' } }, 'Итого: ', totalEl, ' UZS'),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: printLabels }, Icon('Print', { size: 14 }), ' Печать этикеток'),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    prodSearch.focus();
}

// -----------------------------------------------------------------------------
// КОРРЕКТИРОВКА — знаковая ручная правка остатка, причина обязательна.
// p == null (кнопка на Складе) -> модалка сама даёт выбрать товар.
// -----------------------------------------------------------------------------
export function openAdjustModal(p, onSaved) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let current = p || null;

    const infoEl = h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } }, '');
    function refreshInfo() {
        infoEl.textContent = current
            ? `Сейчас в наличии: ${Number(current.on_hand) || 0} ${current.base_unit || ''}`.trim()
            : 'Выберите товар.';
    }

    const prodSel = p ? null : h('select', { style: selStyle }, h('option', { value: '' }, '— Выберите товар —'));
    if (prodSel) {
        (async () => {
            try {
                const { data, error } = await supabase.from('products')
                    .select('id,name,base_unit,on_hand')
                    .eq('active', 1)
                    .order('name', { ascending: true });
                if (error) throw error;
                const list = data || [];
                for (const pr of list) prodSel.appendChild(h('option', { value: String(pr.id) }, pr.name));
                prodSel.addEventListener('change', () => {
                    const pid = Number(prodSel.value) || null;
                    current = list.find(x => x.id === pid) || null;
                    refreshInfo();
                });
            } catch (e) {
                toast('Не удалось загрузить товары: ' + ((e && e.message) || e), 'fail');
            }
        })();
    }

    const qtyInp = h('input', { type: 'number', step: 'any', required: true, value: '' });
    const noteInp = h('input', { type: 'text', required: true, value: '' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Провести');
    saveBtn.addEventListener('click', save);

    async function save() {
        if (!current) { toast('Выберите товар.', 'fail'); return; }
        const qty = Number(qtyInp.value);
        if (!Number.isFinite(qty) || qty === 0) { toast('Введите ненулевое количество.', 'fail'); return; }
        const note = noteInp.value.trim();
        if (!note) { toast('Причина корректировки обязательна.', 'fail'); return; }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = 'Проводим…';
        try {
            const { error } = await supabase.rpc('adjust_stock', { product_id: current.id, qty, note });
            if (error) throw error;

            toast('Остаток скорректирован', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось скорректировать.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    refreshInfo();
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '400px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Edit', { size: 16 }), ' Корректировка', p ? ` — ${p.name || ''}` : ''),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            prodSel ? field('Товар', prodSel, { required: true }) : null,
            infoEl,
            field('Кол-во', qtyInp, { required: true }),
            h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '-6px', marginBottom: '4px' } }, 'Плюс — добавить, минус — списать.'),
            field('Причина', noteInp, { required: true }),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);
    (p ? qtyInp : (prodSel || qtyInp)).focus();
}
