// Закупки — «Товары» tab (catalog CRUD) + the shared Принять / Корректировка
// modals. PROCUREMENT_REDESIGN_V1 — extracted from the original single-file
// inventory.js. on_hand and avg_cost change ONLY through RPCs:
//   receive_stock_lines («Принять»), adjust_stock («Корректировка»),
//   issue_stock_lines («Выдать» — see inventory-sklad.js),
//   dispense_item / void_dispense (visit-bill.js — unrelated, do not touch).
//
// SUPPLIERS_VAT_V1 (2026-09-28) — владелец: «connect the providers to the drug
// products … when adding goods to the procurement we need to hardcode the types
// of the goods, set up price and VAT rate». Карточка товара сохраняется ОДНИМ
// вызовом product_save (товар + все его поставщики, одна транзакция, проверка
// типа и НДС на сервере — rpc/catalog-goods.js); тип — одна из восьми
// категорий без пустого варианта; у товара цена продажи и ставка НДС, у каждого
// поставщика — своя цена закупки без НДС и ставка. «Принять товар» берёт цену и
// НДС строки из связи товара с поставщиком и показывает суммы без НДС, НДС и с
// НДС — ими сверяют счёт-фактуру.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard, fmtPrice, fmtMoney2, fmtQty, CATEGORY_LABEL, selStyle, numStyle, isLowStock, vatSelect, vatText } from './inventory-shared.js';
import { categoryFilter, loadCategories, matchesCategories } from './category-filter.js';   // PROCUREMENT_FILTERS_V1
import { openSupplierModal } from './inventory-suppliers.js';   // ADD_PRODUCT_EASYMED_V1 — «+ Новый поставщик» из карточки товара
import { PRINT_FONT_FACE_CSS } from '../../shared/print-fonts.js';   // ONEST_TYPOGRAPHY_V1 — @font-face для печатных окон
import { GOODS_CATEGORIES, VAT_STANDARD, vatOnNet, linkPriceFor, packOf } from '../../shared/goods-catalog.js';   // SUPPLIERS_VAT_V1; цена связи — ревью F2

const productRefs = { tbody: null, emptyEl: null, totalEl: null, all: [], q: '', cats: [], suppliersOf: new Map() };

// PROCUREMENT_FILTERS_V1 — «Товары» получили поиск (его не было вовсе) и
// отметки категорий (общие с «Складом» и «Сроками годности», запоминаются за
// вошедшим — category-filter.js). Отбор — в браузере по уже загруженному
// каталогу, как на «Складе»; итог «Товаров: N» считается по ОТОБРАННЫМ строкам.
export function filterProducts(rows, { q = '', cats = [] } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return (rows || []).filter((p) => {
        if (!matchesCategories(p, cats)) return false;
        if (needle && !((p.name || '').toLowerCase().includes(needle)
            || (p.code || '').toLowerCase().includes(needle))) return false;
        return true;
    });
}

// SUPPLIERS_VAT_V1 — поставщики товара одной строкой для таблицы «Товары»:
// первые два по имени и «+N», если их больше.
export function suppliersCellText(names) {
    const list = (names || []).filter(Boolean);
    if (!list.length) return '—';
    const head = list.slice(0, 2).join(', ');
    return list.length > 2 ? `${head} +${list.length - 2}` : head;
}

export function renderProductsTab(container) {
    productRefs.tbody = h('tbody');
    productRefs.emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        'Пока нет товаров — добавьте первый.');
    productRefs.totalEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '');
    productRefs.all = [];
    productRefs.q = '';
    productRefs.cats = loadCategories();
    productRefs.suppliersOf = new Map();

    const searchInp = h('input', {
        type: 'text', placeholder: 'Поиск по названию или коду…', 'aria-label': 'Поиск товара',
        style: { width: '240px', maxWidth: '100%', height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit' },
    });
    searchInp.addEventListener('input', () => { productRefs.q = searchInp.value; paintRows(); });

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
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px 16px', flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--ink-100)' } },
                searchInp,
                categoryFilter({ selected: productRefs.cats, onChange: (c) => { productRefs.cats = c; paintRows(); } }),
            ),
            h('div', { style: { overflowX: 'auto' } },
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Название'),
                        h('th', null, 'Категория'),
                        h('th', null, 'В наличии'),
                        h('th', null, 'Себестоимость'),
                        h('th', null, 'Цена продажи'),
                        h('th', null, 'НДС'),
                        h('th', null, 'Поставщики'),
                        h('th', null, 'Статус'),
                        h('th', null, ''),
                    )),
                    productRefs.tbody,
                )),
            productRefs.emptyEl,
        ),
    ));

    fetchProductsAndPaint();
}

async function fetchProductsAndPaint() {
    const token = ++fetchGuard.token;
    setLoadingRow();
    try {
        const pr = await supabase.from('products').select('*').order('name', { ascending: true }).limit(1000);
        // SUPPLIERS_VAT_V1 — у кого товар закупают (многие ко многим). Ревью
        // M6 — связи ИМЕННО этих товаров: первые 5000 связей на всю клинику
        // (миграция 222 заводит связь на каждую пару из истории приходов)
        // оставляли товары сверх них без поставщиков.
        const ids = (pr.data || []).map((p) => p.id);
        const lk = pr.error || !ids.length ? { data: [] }
            : await supabase.from('item_suppliers').select('product_id, supplier_id, suppliers(name)').in('product_id', ids).limit(100000);
        if (token !== fetchGuard.token) return;   // a newer fetch already landed
        if (pr.error) {
            toast(trf('Не удалось загрузить товары: {msg}', { msg: pr.error.message || pr.error }), 'fail');
            productRefs.all = [];
            paintRows();
            return;
        }
        productRefs.all = pr.data || [];
        const map = new Map();
        for (const l of ((lk && !lk.error && lk.data) || [])) {
            const name = l.suppliers && l.suppliers.name;
            if (!name) continue;
            if (!map.has(l.product_id)) map.set(l.product_id, []);
            map.get(l.product_id).push(name);
        }
        for (const list of map.values()) list.sort((a, b) => a.localeCompare(b, 'ru'));
        productRefs.suppliersOf = map;
        paintRows();
    } catch (e) {
        if (token !== fetchGuard.token) return;
        toast(trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || e }), 'fail');
        productRefs.all = [];
        paintRows();
    }
}

function setLoadingRow() {
    if (!productRefs.tbody) return;
    clear(productRefs.tbody);
    productRefs.tbody.appendChild(h('tr', null,
        h('td', { colspan: '9', style: { textAlign: 'center', padding: '24px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка…'),
    ));
    productRefs.emptyEl.style.display = 'none';
}

function paintRows() {
    if (!productRefs.tbody) return;
    clear(productRefs.tbody);
    const rows = filterProducts(productRefs.all, { q: productRefs.q, cats: productRefs.cats });
    // Итог — по отобранному: владелец просил, чтобы статистика следовала за
    // отмеченными категориями.
    if (productRefs.totalEl) productRefs.totalEl.textContent = trf('Товаров: {n}', { n: rows.length });
    if (!rows || rows.length === 0) {
        productRefs.emptyEl.textContent = tr(productRefs.all.length ? 'Ничего не найдено.' : 'Пока нет товаров — добавьте первый.');
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
        h('td', null, vatText(p.vat_rate)),
        h('td', { class: 'muted', style: { fontSize: '12.5px' } }, suppliersCellText(productRefs.suppliersOf.get(p.id))),
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

// SUPPLIERS_VAT_V1 — тип товара: ровно восемь, пустого варианта нет. У нового
// товара по умолчанию «Медикаменты» (как было), у сохранённого — его тип.
export function categorySelect(value) {
    const current = GOODS_CATEGORIES.includes(value) ? value : 'medicines';
    const sel = h('select', { style: selStyle, 'aria-label': 'Категория' },
        ...GOODS_CATEGORIES.map((key) => h('option', { value: key, selected: key === current }, CATEGORY_LABEL[key])));
    sel.value = current;
    return sel;
}

/**
 * Аргументы product_save из карточки. suppliers — только если список связей
 * загружен (linksLoaded): не загрузился — связи не отправляются и сервер их не
 * трогает, а не стирает.
 */
export function productSavePayload({ id = null, name, category, baseUnit, stockUnit, packFactor, salePrice, vat, active, linked, linksLoaded }) {
    const payload = {
        name: String(name || '').trim(),
        procurement_category: category,
        base_unit: baseUnit,
        purchase_unit: stockUnit,
        pack_factor: packFactor,
        sale_price: salePrice,
        vat_rate: vat === undefined ? null : vat,
        active: !!active,
    };
    if (id != null) payload.id = id;
    if (linksLoaded) {
        payload.suppliers = (linked || []).map((l) => ({
            supplier_id: l.supplier_id,
            last_price: l.last_price == null || l.last_price === '' ? null : Number(l.last_price),
            vat_rate: l.vat_rate === undefined ? null : l.vat_rate,
            pack_factor: l.pack_factor == null || l.pack_factor === '' ? null : Number(l.pack_factor),
            purchase_unit: l.purchase_unit || null,
        }));
    }
    return payload;
}

/**
 * Карточка товара. onSaved(product) получает сохранённый товар (ответ сервера).
 * opts.presetSupplier — { id, name }: новый товар сразу привязан к этому
 * поставщику (кнопка «Новый товар» в карточке поставщика).
 */
export function openProductModal(p, onSaved, opts = {}) {
    const isEdit = !!p;

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    // компактно: панели без своих верхних отступов (их даёт grid-gap .modal-body)
    const panelStyle = { background: 'var(--ink-25, #f8fafa)', border: '1px solid var(--ink-100)', borderRadius: '12px', padding: '12px 14px' };
    const cap = (t) => h('div', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)', marginBottom: '8px' } }, t);
    const hint = (t) => h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '2px 0 6px' } }, t);

    // ---- Name + Категория + Активен ----
    const nameInp = h('input', { type: 'text', required: true, value: p ? (p.name || '') : '', placeholder: 'e.g. Перчатки нитриловые М' });
    const categorySel = categorySelect(p ? p.procurement_category : 'medicines');
    const activeChk = h('input', { type: 'checkbox', checked: p ? !!p.active : true });

    // ---- Единицы измерения ----
    const dispenseUnitSel = unitSelect(p ? p.base_unit : 'шт');
    const stockUnitSel    = unitSelect(p ? (p.purchase_unit || p.base_unit) : 'шт');
    const packFactorInp   = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.pack_factor != null) ? String(p.pack_factor) : '1',
        style: { ...numStyle, width: '90px' } });
    const packEq = h('span', { style: { fontSize: '13.5px', color: 'var(--ink-700)' } }, dispenseUnitSel.value);
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

    // ---- Цена продажи и НДС ----
    // SUPPLIERS_VAT_V1 — цена продажи С НДС; ставка — 12 %, 0 % или «без НДС».
    // Налог строки товара в отчётах — внутри цены, как у услуги: × ставка / 100
    // (решение владельца 2026-09-29: из 100 при 12 % — 12 налога и 88).
    const priceInp = h('input', { type: 'number', min: '0', step: 'any',
        value: (p && p.sale_price != null) ? String(p.sale_price) : '', placeholder: '0',
        style: { ...numStyle, width: '140px' } });
    let productVat = p ? (p.vat_rate == null ? null : Number(p.vat_rate)) : VAT_STANDARD;
    const productVatSel = vatSelect(productVat, (v) => { productVat = v; });
    const pricePanel = h('div', { style: panelStyle },
        cap('Цена продажи и НДС'),
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } }, 'Цена продажи (списание пациенту), сум'),
            priceInp,
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-700)' } }, 'НДС'),
            productVatSel),
        hint('Цена продажи — с НДС: счёт пациента не меняется, а в отчётах налог — внутри цены, как у услуг (из 100 при 12 % — 12 налога и 88).'),
    );

    // ---- Поставщики этого товара (item_suppliers) ----
    let allSuppliers = [];
    // [{ supplier_id, name, last_price, vat_rate, purchase_unit, pack_factor }]
    const linked = [];
    // Список связей загружен (у нового товара — пуст и верен сразу). Не
    // загрузился — связи при сохранении не отправляются.
    let linksLoaded = !isEdit;
    const linkedEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const linkedEmpty = h('div', { class: 'muted', style: { fontSize: '12.5px' } },
        'Поставщики не привязаны — найдите ниже или создайте нового.');
    if (opts.presetSupplier && opts.presetSupplier.id) {
        linked.push({ supplier_id: opts.presetSupplier.id, name: opts.presetSupplier.name || '', last_price: null,
            vat_rate: productVat, purchase_unit: null, pack_factor: null });
    }

    function paintLinked() {
        clear(linkedEl);
        if (!linked.length) { linkedEl.appendChild(isEdit && !linksLoaded ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Загрузка…') : linkedEmpty); return; }
        for (const ln of linked) {
            // ОДНА строка: имя · Цена без НДС [цена] сум · НДС [ставка] · 1 [ед] = [N] шт ×
            const priceInp2 = h('input', { type: 'number', min: '0', step: 'any', placeholder: 'цена',
                value: ln.last_price != null ? String(ln.last_price) : '', style: { ...numStyle, width: '96px', flex: '0 0 auto' } });
            priceInp2.addEventListener('input', () => { ln.last_price = priceInp2.value === '' ? null : Number(priceInp2.value); });
            const vSel = vatSelect(ln.vat_rate, (v) => { ln.vat_rate = v; }, { minWidth: '86px', flex: '0 0 auto' });
            const uSel = unitSelect(ln.purchase_unit || stockUnitSel.value, '104px');
            uSel.style.flex = '0 0 auto';
            uSel.addEventListener('change', () => { ln.purchase_unit = uSel.value; });
            const fInp = h('input', { type: 'number', min: '0', step: 'any',
                value: ln.pack_factor != null ? String(ln.pack_factor) : (packFactorInp.value || '1'), style: { ...numStyle, width: '60px', flex: '0 0 auto' } });
            fInp.addEventListener('input', () => { ln.pack_factor = fInp.value === '' ? null : Number(fInp.value); });
            const lbl = (t) => h('span', { class: 'muted', style: { fontSize: '12.5px', flex: '0 0 auto', whiteSpace: 'nowrap' } }, t);
            linkedEl.appendChild(h('div', {
                class: 'row',
                style: { gap: '7px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px',
                         background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)', borderRadius: '10px' },
            },
                h('span', { style: { fontWeight: 700, color: 'var(--primary-700)', minWidth: '60px', flex: '1 1 140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ln.name),
                lbl('Цена без НДС'), priceInp2, lbl('сум'),
                lbl('НДС'), vSel,
                lbl('· 1'), uSel,
                h('span', { style: { flex: '0 0 auto' } }, '='), fInp,
                lbl(dispenseUnitSel.value),
                h('button', {
                    type: 'button', title: 'Отвязать', 'aria-label': 'Отвязать',
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
            fontFamily: 'inherit', fontSize: '13.5px', background: 'var(--white, #fff)',
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
    const linkNew = (s) => {
        linked.push({ supplier_id: s.id, name: s.name, last_price: null, vat_rate: productVat, purchase_unit: stockUnitSel.value, pack_factor: Number(packFactorInp.value) || 1 });
    };
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
                style: { padding: '9px 12px', cursor: 'pointer', fontSize: '13.5px' },
                onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                onmousedown: (e) => {
                    e.preventDefault();
                    linkNew(s);
                    supSearch.value = ''; supResults.style.display = 'none'; paintLinked();
                },
            }, s.name, s.phone ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' · ' + s.phone) : null));
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
        onclick: () => openSupplierModal(null, async (saved) => {
            // связываем только что созданного поставщика (ответ сервера; без него — самый свежий id)
            await loadSuppliers();
            const created = saved && saved.id ? saved : allSuppliers.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
            if (created && !linked.some(l => l.supplier_id === created.id)) {
                linkNew(created);
                paintLinked();
            }
        }, { withProducts: false }),
    }, Icon('Plus', { size: 13 }), ' Новый поставщик');

    const suppliersPanel = h('div', { style: panelStyle },
        cap('Поставщики этого товара'),
        hint('Цена закупки — без НДС, за единицу закупки; НДС — ставка этого поставщика. «Принять товар» подставляет их сам.'),
        linkedEl,
        h('div', { style: { marginTop: '10px' } }, supSearchWrap, supResults),
        h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginTop: '10px', borderTop: '1px dashed var(--ink-150, var(--ink-200))', paddingTop: '10px' } },
            h('span', { class: 'muted', style: { flex: 1, fontSize: '12.5px' } }, 'Нет нужного поставщика в списке?'),
            newSupplierBtn),
    );

    // подтягиваем существующие связи поставщиков (режим редактирования)
    if (isEdit) {
        (async () => {
            try {
                const { data, error } = await supabase.from('item_suppliers')
                    .select('id, supplier_id, last_price, vat_rate, purchase_unit, pack_factor, suppliers(name)')
                    .eq('product_id', p.id);
                if (error) throw error;
                for (const r of (data || [])) {
                    linked.push({ supplier_id: r.supplier_id, name: (r.suppliers && r.suppliers.name) || ('#' + r.supplier_id),
                        last_price: r.last_price, vat_rate: r.vat_rate == null ? null : Number(r.vat_rate),
                        purchase_unit: r.purchase_unit, pack_factor: r.pack_factor });
                }
                linksLoaded = true;
            } catch (e) {
                // Карточка работает и без связей, но сохранять их тогда нельзя —
                // иначе «Сохранить» стёр бы всех поставщиков товара. Привязка
                // тоже закрыта: новая связь молча не сохранилась бы.
                linksLoaded = false;
                supSearch.disabled = true;
                newSupplierBtn.disabled = true;
                clear(linkedEl);
                linkedEl.appendChild(h('div', { style: { fontSize: '12.5px', color: 'var(--crit-700)' } },
                    'Поставщики не загрузились — при сохранении связи с ними не изменятся.'));
                return;
            }
            paintLinked();
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
        for (const ln of linked) {
            if (ln.last_price != null && !(Number.isFinite(Number(ln.last_price)) && Number(ln.last_price) >= 0)) {
                toast(trf('Цена закупки у поставщика «{name}» — неотрицательное число.', { name: ln.name }), 'fail'); return;
            }
        }

        saveBtn.disabled = true;
        const prevLabel = saveBtn.textContent;
        saveBtn.textContent = isEdit ? tr('Сохраняем…') : tr('Добавляем…');
        try {
            const baseUnit = dispenseUnitSel.value;
            const payload = productSavePayload({
                id: isEdit ? p.id : null, name, category: categorySel.value, baseUnit, stockUnit: stockUnitSel.value,
                packFactor, salePrice: price, vat: productVat, active: activeChk.checked, linked, linksLoaded,
            });
            const { data, error } = await supabase.rpc('product_save', payload);
            if (error) throw error;
            toast('Сохранено', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved(data && data.product ? data.product : null, data);
        } catch (e) {
            toast((e && e.message) || 'Не удалось сохранить товар.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel;
        }
    }

    const bodyChildren = [
        field('Название', nameInp, { required: true }),
        h('div', { class: 'row', style: { gap: '12px', alignItems: 'flex-end' } },
            h('div', { style: { flex: 1 } }, field('Категория', categorySel, { required: true })),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', paddingBottom: '12px', cursor: 'pointer', whiteSpace: 'nowrap' } },
                activeChk, 'Активен'),
        ),
        unitsPanel,
        pricePanel,
        suppliersPanel,
    ];
    if (isEdit) {
        bodyChildren.push(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '10px' } },
            trf('В наличии: {qty} {unit} · себестоимость {cost}. Остаток меняется через «Принять» / «Корректировка».', { qty: fmtQty(p.on_hand), unit: p.base_unit || '', cost: fmtPrice(p.avg_cost) })));
    }

    // modal-compact ОБЯЗАТЕЛЕН: без него глобальное правило (MODAL_COMPACT_OPTOUT_V1)
    // растягивает карточку почти на весь экран (!important).
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '760px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, isEdit ? 'Товар' : 'Новый товар'),
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
// { product, unit:'purchase', qty, unitCost, vat }. Вся математика на сервере
// (receive_stock_lines) — суммы в строке и внизу только для отображения.
//
// SUPPLIERS_VAT_V1 — цена строки БЕЗ НДС за единицу закупки (как в
// счёте-фактуре поставщика) и ставка НДС строки. Поставщик строки подставляет
// свою последнюю цену и ставку (связь item_suppliers); без связи — ставка
// товара. Сервер считает НДС строки и себестоимость с НДС.
// -----------------------------------------------------------------------------

/** Суммы строки прихода для показа: без НДС, НДС и с НДС. */
export function receiptLineMoney(ln) {
    const net = Math.round((Number(ln.qty) || 0) * (Number(ln.unitCost) || 0) * 100) / 100;
    const vat = vatOnNet(net, ln.vat);
    return { net, vat, gross: Math.round((net + vat) * 100) / 100 };
}

/**
 * Цена и НДС строки по умолчанию: связь с поставщиком, иначе товар.
 * Ревью F2 — строка прихода считается в единице закупки ТОВАРА (упаковка
 * товара), а цена связи — за единицу закупки СВЯЗИ: у поставщика «кор = 100
 * таб» по 9 000, у товара «уп = 10 таб» — строка получает 900 за уп.
 */
export function receiptDefaults(product, supplierId, links) {
    const link = supplierId ? (links || []).find((l) => l.product_id === product.id && l.supplier_id === supplierId) : null;
    if (link) {
        return { unitCost: linkPriceFor(link, product, packOf(product.pack_factor) || 1), vat: link.vat_rate == null ? null : Number(link.vat_rate) };
    }
    const vat = product.vat_rate == null ? null : Number(product.vat_rate);
    const pack = Number(product.pack_factor) > 0 ? Number(product.pack_factor) : 1;
    // Себестоимость на складе — с НДС; цена строки — без него.
    const gross = Number(product.avg_cost) > 0 ? Number(product.avg_cost) * pack : null;
    const unitCost = gross == null ? null : Math.round(gross / (1 + (vat || 0) / 100) * 100) / 100;
    return { unitCost, vat };
}

export function openReceiveModal(onSaved) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const st = { products: [], suppliers: [], links: [], linksLoaded: new Set(), lines: [] };   // ревью M6 — связи по товару

    const linesEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const linesEmpty = h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '6px 2px' } },
        'Найдите товар в поиске выше — он появится здесь строкой прихода.');
    const netEl = h('span', { style: { fontWeight: 700 } }, '0');
    const vatEl = h('span', { style: { fontWeight: 700 } }, '0');
    const totalEl = h('span', { style: { fontWeight: 800 } }, '0');

    const genBatch = () => {
        const d = new Date();
        const ymd = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
        return ymd + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    };

    function refreshTotal() {
        let net = 0, vat = 0, gross = 0;
        for (const ln of st.lines) {
            const m = receiptLineMoney(ln);
            net += m.net; vat += m.vat; gross += m.gross;
            if (ln._grossEl) ln._grossEl.textContent = fmtMoney2(m.gross);
        }
        netEl.textContent = fmtMoney2(net);
        vatEl.textContent = fmtMoney2(vat);
        totalEl.textContent = fmtMoney2(gross);
    }

    function applyDefaults(ln) {
        const d = receiptDefaults(ln.product, ln.supplierId, st.links);
        ln.unitCost = d.unitCost;
        ln.vat = d.vat;
    }

    function supplierSelect(ln) {
        const sel = h('select', { style: { ...selStyle, width: 'auto', minWidth: '140px', maxWidth: '180px', flex: '0 0 auto' }, 'aria-label': 'Поставщик' },
            h('option', { value: '' }, 'Выберите поставщика…'),
            ...st.suppliers.map(s => h('option', { value: String(s.id), selected: String(ln.supplierId || '') === String(s.id) }, s.name)));
        sel.addEventListener('change', () => {
            ln.supplierId = sel.value ? Number(sel.value) : null;
            // Поставщик со своей ценой и ставкой — подставляем их.
            const link = st.links.find((l) => l.product_id === ln.product.id && l.supplier_id === ln.supplierId);
            if (link) { applyDefaults(ln); paintLines(); }
        });
        return sel;
    }

    function paintLines() {
        clear(linesEl);
        if (!st.lines.length) { linesEl.appendChild(linesEmpty); refreshTotal(); return; }
        const lbl = (t) => h('span', { class: 'muted', style: { fontSize: '12.5px', flex: '0 0 auto', whiteSpace: 'nowrap' } }, t);
        for (const ln of st.lines) {
            const supSel = supplierSelect(ln);
            const newSupBtn = h('button', {
                class: 'btn btn-sm', type: 'button', title: 'Новый поставщик', 'aria-label': 'Новый поставщик',
                style: { background: 'var(--warn-50, #fdf3e1)', borderColor: 'var(--warn-200, #f2d9a6)', color: 'var(--warn-800, #8a6116)', fontWeight: 700, padding: '4px 8px', flex: '0 0 auto' },
                onclick: () => openSupplierModal(null, async (saved) => {
                    await loadSuppliers();
                    const created = saved && saved.id ? saved : st.suppliers.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
                    if (created) ln.supplierId = created.id;
                    paintLines();
                }, { withProducts: false }),
            }, '+');
            const batchInp = h('input', { type: 'text', placeholder: 'серия №', value: ln.batchNo || '',
                style: { ...selStyle, width: '100px', flex: '0 0 auto' } });
            batchInp.addEventListener('input', () => { ln.batchNo = batchInp.value; });
            const regenBtn = h('button', {
                type: 'button', title: 'Сгенерировать номер партии', 'aria-label': 'Сгенерировать номер партии',
                style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', flex: '0 0 auto', display: 'flex' },
                onclick: () => { ln.batchNo = genBatch(); batchInp.value = ln.batchNo; },
            }, Icon('Refresh', { size: 14 }));
            const expInp = h('input', { type: 'date', value: ln.expiry || '',
                style: { ...selStyle, width: '132px', flex: '0 0 auto' } });
            expInp.addEventListener('input', () => { ln.expiry = expInp.value; });
            const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: ln.qty != null ? String(ln.qty) : '1',
                'aria-label': 'Количество', style: { ...numStyle, width: '72px', flex: '0 0 auto' } });
            qtyInp.addEventListener('input', () => { ln.qty = qtyInp.value === '' ? null : Number(qtyInp.value); refreshTotal(); });
            const costInp = h('input', { type: 'number', min: '0', step: 'any', value: ln.unitCost != null ? String(ln.unitCost) : '',
                placeholder: 'цена', 'aria-label': 'Цена без НДС', style: { ...numStyle, width: '100px', flex: '0 0 auto' } });
            costInp.addEventListener('input', () => { ln.unitCost = costInp.value === '' ? null : Number(costInp.value); refreshTotal(); });
            const vatSel = vatSelect(ln.vat, (v) => { ln.vat = v; refreshTotal(); }, { flex: '0 0 auto' });
            ln._grossEl = h('span', { style: { fontWeight: 700, minWidth: '90px', textAlign: 'right', flex: '0 0 auto' } }, '0');

            const unitLabel = ln.product.purchase_unit || ln.product.base_unit || '';
            linesEl.appendChild(h('div', {
                style: { display: 'flex', flexDirection: 'column', gap: '7px', padding: '9px 12px',
                         border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'var(--white, #fff)' },
            },
                h('div', { class: 'row', style: { gap: '7px', alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', { style: { minWidth: '120px', flex: '1 1 160px', overflow: 'hidden' } },
                        h('span', { style: { display: 'block', fontWeight: 700, fontSize: '13.5px', color: 'var(--ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, ln.product.name),
                        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, unitLabel),
                        h('span', { style: { marginLeft: '6px' } }, Tag(CATEGORY_LABEL[ln.product.procurement_category] || ln.product.procurement_category || '—', { kind: 'info' }))),
                    lbl('Поставщик'), supSel, newSupBtn,
                    lbl('Партия / серия №'), batchInp, regenBtn,
                    h('span', { style: { flex: '0 0 auto', display: 'flex', color: 'var(--ink-400)' } }, Icon('Clock', { size: 13 })),
                    lbl('Срок годности'), expInp,
                    h('button', {
                        type: 'button', title: 'Убрать строку', 'aria-label': 'Убрать строку',
                        style: { border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ink-400)', fontWeight: 700, flex: '0 0 auto' },
                        onclick: () => { st.lines.splice(st.lines.indexOf(ln), 1); paintLines(); },
                    }, '×')),
                h('div', { class: 'row', style: { gap: '7px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
                    lbl('Кол-во'), qtyInp, lbl(unitLabel),
                    lbl('× цена без НДС'), costInp, lbl('сум'),
                    lbl('НДС'), vatSel,
                    lbl('= с НДС'), ln._grossEl),
            ));
        }
        refreshTotal();
    }

    async function addLineFor(p) {
        // Ревью M6 — связи этого товара с поставщиками (цена и ставка по
        // умолчанию) — до строки: окно берёт их по товару, а не первыми 5000
        // на всю клинику.
        await loadLinksFor(p.id);
        const ln = { product: p, supplierId: p.supplier_id || null, batchNo: '', expiry: '', qty: 1, unitCost: null, vat: null };
        applyDefaults(ln);
        st.lines.push(ln);
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
                style: { padding: '9px 12px', cursor: 'pointer', fontSize: '13.5px' },
                onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                onmousedown: (e) => { e.preventDefault(); addLineFor(p); prodSearch.value = ''; prodResults.style.display = 'none'; },
            }, p.name, h('span', { class: 'muted', style: { fontSize: '12.5px' } },
                ' · ', CATEGORY_LABEL[p.procurement_category] || '', ' · ' + (p.base_unit || '') + ' · ', trf('остаток {n}', { n: fmtQty(p.on_hand) }))));
        }
    }
    prodSearch.addEventListener('input', paintProdResults);
    const searchWrap = h('div', { style: { position: 'relative', flex: 1 } },
        h('span', { style: { position: 'absolute', left: '11px', top: '21px', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'flex', pointerEvents: 'none' } }, Icon('Search', { size: 15 })),
        prodSearch, prodResults);

    const newProductBtn = h('button', {
        class: 'btn', type: 'button', style: { flex: '0 0 auto' },
        onclick: () => openProductModal(null, async (saved) => {
            await loadProducts();
            const created = saved && saved.id ? st.products.find((x) => x.id === saved.id) || saved
                : st.products.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
            if (created) { st.linksLoaded.delete(created.id); await addLineFor(created); }
        }),
    }, Icon('Plus', { size: 14 }), ' Новый товар');

    async function loadProducts() {
        const { data, error } = await supabase.from('products').select('*').eq('active', 1).order('name').limit(1000);
        if (error) { toast(trf('Товары не загрузились: {msg}', { msg: error.message }), 'fail'); return; }
        st.products = data || [];
    }
    async function loadSuppliers() {
        const { data } = await supabase.from('suppliers').select('id,name').eq('active', 1).order('name');
        st.suppliers = data || [];
    }
    // SUPPLIERS_VAT_V1 — цена и НДС поставщика для строк по умолчанию.
    // Ревью M6 — связи ОДНОГО товара, когда его строка появляется в окне: прежде
    // окно брало первые 5000 связей на всю клинику, и у товаров сверх них цены
    // поставщика по умолчанию не было.
    async function loadLinksFor(productId) {
        const id = Number(productId);
        if (!id || st.linksLoaded.has(id)) return;
        st.linksLoaded.add(id);
        try {
            const { data, error } = await supabase.from('item_suppliers')
                .select('product_id, supplier_id, last_price, vat_rate, pack_factor').eq('product_id', id);
            if (error) throw error;
            st.links = st.links.filter((l) => Number(l.product_id) !== id).concat(data || []);
        } catch (e) { st.linksLoaded.delete(id); }
    }
    (async () => { await Promise.all([loadProducts(), loadSuppliers()]); paintLines(); })();

    // ---- печать этикеток (name · партия · годен до · Nx) ----
    /* i18n-exempt-start: печать этикеток — печатный документ */
    /* type-scale-exempt-start: печатный документ — семейство Onest, размеры остаются его выверенными метриками (дизайн-док 2026-08-31) */
    function printLabels() {
        if (!st.lines.length) { toast('Нет строк для этикеток.', 'fail'); return; }
        const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        const cells = st.lines.map(ln => `
<div style="border:1px dashed #999;border-radius:6px;padding:8px 10px;width:220px;font:12px/1.45 'Onest',system-ui;">
  <div style="font-weight:700;">${esc(ln.product.name)}</div>
  ${ln.batchNo ? `<div>Партия: <b>${esc(ln.batchNo)}</b></div>` : ''}
  ${ln.expiry ? `<div>Годен до: <b>${esc(ln.expiry.split('-').reverse().join('.'))}</b></div>` : ''}
  <div>Кол-во: <b>${esc(ln.qty)} ${esc(ln.product.purchase_unit || ln.product.base_unit || '')}</b></div>
</div>`).join('');
        const w = window.open('', '_blank', 'width=760,height=900');
        if (!w) { toast('Браузер заблокировал окно печати.', 'fail'); return; }
        w.document.write(`<!DOCTYPE html><html><head><title>Этикетки</title><style>${PRINT_FONT_FACE_CSS}</style></head>
<body onload="(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(()=>print())" style="display:flex;flex-wrap:wrap;gap:10px;padding:16px;">${cells}</body></html>`);
        w.document.close();
    }
    /* type-scale-exempt-end */
    /* i18n-exempt-end */

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Приход');
    saveBtn.addEventListener('click', save);

    async function save() {
        if (!st.lines.length) { toast('Добавьте хотя бы один товар.', 'fail'); return; }
        for (const ln of st.lines) {
            if (!(Number(ln.qty) > 0)) { toast(trf('Кол-во должно быть больше нуля: {name}', { name: ln.product.name }), 'fail'); return; }
            if (!(Number(ln.unitCost) >= 0) || ln.unitCost === null) { toast(trf('Укажите цену за единицу: {name}', { name: ln.product.name }), 'fail'); return; }
        }
        saveBtn.disabled = true; saveBtn.textContent = tr('Проводим…');
        try {
            const { error } = await supabase.rpc('receive_stock_lines', { lines: receiveLinesPayload(st.lines) });
            if (error) throw error;
            toast('Приход проведён — остатки обновлены.', 'ok');
            close();
            if (typeof onSaved === 'function') await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось провести приход.', 'fail');
            saveBtn.disabled = false; saveBtn.textContent = tr('Приход');
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '1180px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', { style: { margin: 0 } }, 'Принять товар'),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, 'Фиксирует приход; остаток обновляется автоматически.')),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { overflowY: 'auto' } },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } }, searchWrap, newProductBtn),
            h('div', null,
                h('div', { style: { fontSize: '12.5px', fontWeight: 700, color: 'var(--ink-800)', margin: '2px 0 8px' } }, 'Товары ', h('span', { style: { color: 'var(--crit-500, #ef4444)' } }, '*')),
                h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '0 0 8px' } },
                    'Цена — за единицу закупки без НДС, как в счёте-фактуре поставщика; себестоимость на складе считается с НДС.'),
                linesEl),
            h('div', { style: { textAlign: 'right', fontSize: '13.5px', color: 'var(--ink-700)' } },
                h('span', null, 'Без НДС:'), ' ', netEl, ' · ', h('span', null, 'НДС:'), ' ', vatEl,
                ' · ', h('span', null, 'Итого с НДС:'), ' ', totalEl, ' UZS'),
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

/** Строки receive_stock_lines из строк окна: цена без НДС и ставка строки. */
export function receiveLinesPayload(lines) {
    return (lines || []).map(ln => ({
        product_id: ln.product.id, unit: 'purchase',
        qty: Number(ln.qty), unit_cost: Number(ln.unitCost),
        vat_rate: ln.vat === undefined ? null : ln.vat,
        supplier_id: ln.supplierId || null,
        batch_no: ln.batchNo || null,
        expiry_date: ln.expiry || null,
    }));
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

    const infoEl = h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } }, '');
    function refreshInfo() {
        infoEl.textContent = current
            ? trf('Сейчас в наличии: {n} {unit}', { n: fmtQty(Number(current.on_hand) || 0), unit: current.base_unit || '' }).trim()
            : tr('Выберите товар.');
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
                toast(trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || e }), 'fail');
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
        saveBtn.textContent = tr('Проводим…');
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
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '-6px', marginBottom: '4px' } }, 'Плюс — добавить, минус — списать.'),
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
