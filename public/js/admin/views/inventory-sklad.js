// Закупки — «Склад» tab (PROCUREMENT_REDESIGN_V1): the warehouse stock table
// from the cloud design — search/filters, low-stock ⚠, OK/Reorder flags,
// Excel export / шаблон / импорт, and Принять / Выдать / Корректировка.
// Stock is a single pool (products.on_hand); per-department balances arrive
// with «Отделения» in phase 2. «Заказать» is rendered disabled until the
// Заказы на закупку tab ships.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard, loadingCard, fmtPrice, fmtMoney2, fmtQty, selStyle, isLowStock, CATEGORY_LABEL } from './inventory-shared.js';
import { categoryFilter, loadCategories, matchesCategories } from './category-filter.js';   // PROCUREMENT_FILTERS_V1
import { openReceiveModal, openAdjustModal } from './inventory-products.js';
import { openStockIssueModal } from './stock-issue-modal.js';   // STOCK_ISSUE_MODAL_V1 — общий диалог выдачи
import { renderInactiveHoldings } from './inventory-inactive-holdings.js';   // V3120_FIX — подотчёт отключённых
// SUPPLIERS_VAT_V1 — типы товаров, ставки НДС и формат срока годности импорта —
// один список с сервером.
import { GOODS_CATEGORIES, GOODS_CATEGORY_RU, EXPIRY_FORMAT_RU, EXPIRY_EXAMPLE, dmyOfDate, dmyOfParts } from '../../shared/goods-catalog.js';

const sklad = {
    products: [], suppliers: [], linksOf: new Map(),
    q: '', unit: 'all', supplier: 'all', avail: 'all', flag: 'all',
    cats: [],   // PROCUREMENT_FILTERS_V1 — отметки вошедшего (category-filter.js)
    tbody: null, emptyEl: null, summaryEl: null,
};

/**
 * PROCUREMENT_FILTERS_V1 — итоги «Склада» по ОТОБРАННЫМ строкам: сколько
 * позиций, на какую сумму лежит и сколько пора заказать. Владелец: статистика
 * следует за отмеченными категориями — поэтому считается от того же filtered(),
 * что рисует таблицу и уходит в Excel, а не от всего склада.
 */
export function skladSummary(rows) {
    let value = 0, reorder = 0;
    for (const p of rows) {
        value += (Number(p.on_hand) || 0) * (Number(p.avg_cost) || 0);
        if (isLowStock(p)) reorder += 1;
    }
    return { count: rows.length, value, reorder };
}

/**
 * SUPPLIERS_VAT_V1 — отбор «Склада» по поставщику: у товара их может быть
 * несколько (многие ко многим). «Без поставщика» — ни основного, ни связей;
 * конкретный поставщик — основной или любой из связанных.
 * linksOf — Map(id товара → Set id поставщиков).
 */
export function matchesSupplier(p, supplier, linksOf) {
    if (supplier === 'all') return true;
    const linked = (linksOf && linksOf.get(p.id)) || new Set();
    if (supplier === 'none') return !p.supplier_id && linked.size === 0;
    const sid = Number(supplier);
    return p.supplier_id === sid || linked.has(sid);
}

// Единица выдачи: consumption unit если задана, иначе базовая (factor 1).
function issueUnitOf(p) {
    if (p.consumption_unit && Number(p.consumption_factor) > 0) {
        return { unit: p.consumption_unit, factor: Number(p.consumption_factor) };
    }
    return { unit: p.base_unit || '', factor: 1 };
}

// Единица хранения: закупочная упаковка, если она заведена и в ней больше одной
// базовой единицы (Analgin: 100 шт лежат на складе как 10 уп по 10), иначе базовая.
// on_hand ВСЕГДА в базовых единицах, поэтому здесь делим, а не умножаем.
function stockUnitOf(p) {
    const factor = Number(p.pack_factor) > 0 ? Number(p.pack_factor) : 1;
    if (p.purchase_unit && factor > 1) return { unit: p.purchase_unit, factor };
    return { unit: p.base_unit || '', factor: 1 };
}

export async function renderSkladTab(container) {
    clear(container);
    container.appendChild(loadingCard());
    const token = ++fetchGuard.token;

    let products = [], suppliers = [], links = [], loadError = null;
    try {
        const [pr, sr, lk] = await Promise.all([
            supabase.from('products').select('*, suppliers(id,name)').order('name', { ascending: true }).limit(1000),
            supabase.from('suppliers').select('id,name').eq('active', 1).order('name', { ascending: true }),
            supabase.from('item_suppliers').select('product_id, supplier_id').limit(5000),   // SUPPLIERS_VAT_V1
        ]);
        if (pr.error) throw pr.error;
        products = pr.data || [];
        suppliers = (sr.error ? [] : sr.data) || [];
        links = (lk && !lk.error && lk.data) || [];
    } catch (e) { loadError = e; }
    if (token !== fetchGuard.token) return;

    clear(container);
    if (loadError) {
        toast(trf('Не удалось загрузить склад: {msg}', { msg: (loadError && loadError.message) || loadError }), 'fail');
        container.appendChild(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'Не удалось загрузить остатки.')));
        return;
    }

    sklad.products = products.filter(p => p.active);
    sklad.suppliers = suppliers;
    sklad.linksOf = new Map();
    for (const l of links) {
        if (!sklad.linksOf.has(l.product_id)) sklad.linksOf.set(l.product_id, new Set());
        sklad.linksOf.get(l.product_id).add(l.supplier_id);
    }
    sklad.tbody = h('tbody');
    sklad.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Ничего не найдено.');
    sklad.cats = loadCategories();
    sklad.summaryEl = h('span', { class: 'muted sklad-summary', style: { fontSize: '12.5px' } });

    const reload = () => renderSkladTab(container);

    // ---- filter controls -------------------------------------------------
    const inputStyle = { width: '100%', height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '12.5px', fontFamily: 'inherit' };
    const smallSel = { ...selStyle, height: '30px', fontSize: '12.5px' };

    const searchInp = h('input', { type: 'text', placeholder: 'Поиск…', value: sklad.q, style: inputStyle });
    searchInp.addEventListener('input', () => { sklad.q = searchInp.value; paintRows(); });

    function filterSelect(options, value, onChange) {
        const sel = h('select', { style: smallSel },
            ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
        sel.addEventListener('change', () => onChange(sel.value));
        return sel;
    }
    const units = [...new Set(sklad.products.map(p => p.base_unit).filter(Boolean))].sort();

    // Drop a filter whose value vanished from the fresh data (deactivated
    // supplier, unit no longer used): the select would fall back to showing
    // «Все …» while filtered() kept applying the stale value.
    if (sklad.unit !== 'all' && !units.includes(sklad.unit)) sklad.unit = 'all';
    if (sklad.supplier !== 'all' && sklad.supplier !== 'none'
        && !sklad.suppliers.some(s => String(s.id) === String(sklad.supplier))) sklad.supplier = 'all';

    const unitSel = filterSelect([['all', 'Все ед.'], ...units.map(u => [u, u])], sklad.unit,
        v => { sklad.unit = v; paintRows(); });
    const supplierSel = filterSelect(
        [['all', 'Все поставщики'], ['none', 'Без поставщика'], ...sklad.suppliers.map(s => [String(s.id), s.name])],
        sklad.supplier, v => { sklad.supplier = v; paintRows(); });
    const availSel = filterSelect(
        [['all', 'Все'], ['in', 'В наличии'], ['low', 'Заканчивается'], ['out', 'Нет в наличии']],
        sklad.avail, v => { sklad.avail = v; paintRows(); });
    const flagSel = filterSelect([['all', 'Все'], ['ok', 'Хватает'], ['reorder', 'Пора заказать']], sklad.flag,
        v => { sklad.flag = v; paintRows(); });

    // ---- toolbar ---------------------------------------------------------
    const toolBtn = (label, icon, onclick) =>
        h('button', { class: 'btn btn-sm', type: 'button', onclick }, Icon(icon, { size: 14 }), ' ' + label);

    const card = h('div', { class: 'card' },
        h('div', { class: 'card-header', style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('h3', null, Icon('Layers', { size: 15 }), ' Остатки на складе'),
            h('span', { class: 'grow' }),
            toolBtn('Excel', 'Download', exportExcel),
            toolBtn('Шаблон', 'Doc', downloadImportTemplate),
            toolBtn('Импорт из Excel', 'ArrowUp', () => openImportModal(reload)),
            toolBtn('Выдать', 'Send', () => openStockIssueModal({ onDone: reload })),   // STOCK_ISSUE_MODAL_V1
            toolBtn('Корректировка', 'Edit', () => openAdjustModal(null, reload)),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReceiveModal(reload) },
                Icon('Plus', { size: 14 }), ' Принять'),
        ),
        // PROCUREMENT_FILTERS_V1 — отметки категорий и итоги по отобранному.
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px 16px', flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--ink-100)' } },
            categoryFilter({ selected: sklad.cats, onChange: (c) => { sklad.cats = c; paintRows(); } }),
            h('span', { class: 'grow' }),
            sklad.summaryEl,
        ),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null,
                    h('tr', null,
                        h('th', null, 'Товар'),
                        h('th', null, 'Категория'),
                        h('th', null, 'Единица'),
                        h('th', null, 'Поставщик'),
                        h('th', null, 'В наличии'),
                        h('th', null, 'Себестоимость'),
                        h('th', null, 'Стоимость'),
                        h('th', null, 'Остаток'),
                        h('th', null, ''),
                    ),
                    h('tr', null,
                        h('td', { style: { padding: '6px 10px' } }, searchInp),
                        h('td', null, ''),
                        h('td', { style: { padding: '6px 10px', minWidth: '90px' } }, unitSel),
                        h('td', { style: { padding: '6px 10px', minWidth: '140px' } }, supplierSel),
                        h('td', { style: { padding: '6px 10px', minWidth: '110px' } }, availSel),
                        h('td', null, ''),
                        h('td', null, ''),
                        h('td', { style: { padding: '6px 10px', minWidth: '90px' } }, flagSel),
                        h('td', null, ''),
                    ),
                ),
                sklad.tbody,
            ),
        ),
        sklad.emptyEl,
    );

    container.appendChild(card);
    paintRows();
    // V3120_FIX — под складом: что числится за отключёнными сотрудниками
    // (вернуть на склад / передать). Нет таких строк — блока нет.
    renderInactiveHoldings(container, reload);

    // ---- rows ------------------------------------------------------------
    function filtered() {
        const q = sklad.q.trim().toLowerCase();
        return sklad.products.filter(p => {
            const onHand = Number(p.on_hand) || 0;
            const low = isLowStock(p);
            if (q && !(p.name || '').toLowerCase().includes(q)) return false;
            if (!matchesCategories(p, sklad.cats)) return false;
            if (sklad.unit !== 'all' && p.base_unit !== sklad.unit) return false;
            if (!matchesSupplier(p, sklad.supplier, sklad.linksOf)) return false;
            if (sklad.avail === 'in' && !(onHand > 0)) return false;
            if (sklad.avail === 'low' && !(onHand > 0 && low)) return false;
            if (sklad.avail === 'out' && onHand > 0) return false;
            if (sklad.flag === 'ok' && low) return false;
            if (sklad.flag === 'reorder' && !low) return false;
            return true;
        });
    }

    function paintRows() {
        clear(sklad.tbody);
        const rows = filtered();
        const sum = skladSummary(rows);
        sklad.summaryEl.textContent = trf('Позиций: {n} · на сумму {sum} · пора заказать: {reorder}',
            { n: sum.count, sum: fmtPrice(sum.value), reorder: sum.reorder });
        if (!rows.length) { sklad.emptyEl.style.display = ''; return; }
        sklad.emptyEl.style.display = 'none';
        for (const p of rows) sklad.tbody.appendChild(productRow(p));
    }

    // Поставщик строки: основной и «+N», если товар берут ещё у кого-то.
    function supplierCell(p) {
        const main = (p.suppliers && p.suppliers.name) || '';
        const others = [...(sklad.linksOf.get(p.id) || [])].filter((id) => id !== p.supplier_id).length;
        if (!main) return others ? `+${others}` : '—';
        return others ? `${main} +${others}` : main;
    }

    function productRow(p) {
        const onHand = Number(p.on_hand) || 0;
        const low = isLowStock(p);
        const iu = issueUnitOf(p);
        // STOCK_ONE_COLUMN_V1 — «В наличии» показывает остаток так, как его считает
        // кладовщик: сверху упаковками («10 уп»), под ними мелким серым «= 100 шт» —
        // сколько это в единицах выдачи. Вторая строка появляется, только если ей
        // есть что добавить: без упаковки и без своей единицы выдачи она напечатала
        // бы ту же цифру второй раз. Отдельная колонка «Выдать» показывала только
        // это второе число под заголовком, который читался как действие.
        const su = stockUnitOf(p);
        const stockText = `${fmtQty(onHand / su.factor)} ${su.unit}`.trim();
        const subText = (su.factor > 1 || iu.factor !== 1)
            ? `= ${fmtQty(onHand * iu.factor)} ${iu.unit}`.trim()
            : '';
        return h('tr', null,
            h('td', { class: 'cell-strong' }, p.name || '—'),
            h('td', null, CATEGORY_LABEL[p.procurement_category] || p.procurement_category || '—'),
            h('td', null, p.base_unit || '—'),
            h('td', null, supplierCell(p)),
            h('td', { class: 'num' },
                h('div', null, low
                    ? h('span', { style: { color: 'var(--crit-500)' } }, Icon('Warning', { size: 13 }), ' ' + stockText)
                    : stockText),
                subText
                    ? h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: '400' } }, subText)
                    : null),
            h('td', { class: 'num' }, fmtMoney2(p.avg_cost)),
            h('td', { class: 'num' }, fmtPrice(onHand * (Number(p.avg_cost) || 0))),
            h('td', null, low ? Tag('Пора заказать', { kind: 'crit' }) : Tag('Хватает', { kind: 'ok' })),
            h('td', { style: { textAlign: 'right' } },
                h('button', { class: 'btn btn-sm', type: 'button', disabled: true, title: 'Заказы на закупку — во 2-й фазе' }, 'Заказать')),
        );
    }

    // ---- Excel: export current (filtered) view --------------------------
    async function exportExcel() {
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const matrix = [
                ['Товар', 'Категория', 'Единица', 'Поставщик', 'В наличии', 'В ед. выдачи', 'Себестоимость', 'Стоимость', 'Флаг'],
                ...filtered().map(p => {
                    const iu = issueUnitOf(p);
                    const su = stockUnitOf(p);
                    const onHand = Number(p.on_hand) || 0;
                    return [
                        p.name || '', CATEGORY_LABEL[p.procurement_category] || p.procurement_category || '',
                        p.base_unit || '', (p.suppliers && p.suppliers.name) || '',
                        `${fmtQty(onHand / su.factor)} ${su.unit}`.trim(), `${fmtQty(onHand * iu.factor)} ${iu.unit}`.trim(),
                        Number(p.avg_cost) || 0, Math.round(onHand * (Number(p.avg_cost) || 0)),
                        isLowStock(p) ? 'Пора заказать' : 'Хватает',
                    ];
                }),
            ];
            const ws = XLSX.utils.aoa_to_sheet(matrix);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Склад');
            XLSX.writeFile(wb, `sklad-${new Date().toISOString().slice(0, 10)}.xlsx`);
        } catch (e) {
            toast(trf('Не удалось сформировать Excel: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    }
}

// ---------------------------------------------------------------------------
// ИМПОРТ ИЗ EXCEL — клиент читает книгу (vendored SheetJS), маппит колонки
// шаблона, сервер (import_products_excel) делает всё в одной транзакции.
//
// SUPPLIERS_VAT_V1 (2026-09-28) — владелец: «in the importing of the Excel we
// need to add an expiration date with a hardcoded format, so the user won't
// make mistakes». В шаблоне — категория, НДС, цена продажи, партия и «Срок
// годности (ДД.ММ.ГГГГ)»; второй лист «Подсказки» — допустимые типы, ставки и
// формат с примером. Настоящую дату-ячейку Excel экран превращает в ДД.ММ.ГГГГ
// сам (dmyOfDate); текст уходит на сервер как есть, и проверяет его сервер —
// ровно ДД.ММ.ГГГГ, настоящая дата, не прошедшая (goods-catalog.js
// parseExpiryDmy), с номером строки в отказе.
//
// Ревью F3 — «НДС» разделён на две колонки: «НДС прихода» (ставка этого
// прихода и связи с поставщиком) и «НДС продажи» (ставка товара). Одна колонка
// на оба смысла давала строке прихода «без НДС» сбросить ставку продажи
// товара. Прежний заголовок «НДС» уходит на сервер как есть, и сервер
// отказывает словами о двух колонках.
// ---------------------------------------------------------------------------
/* i18n-exempt-start: контракт файла импорта — заголовки, примеры и допустимые значения, которые человек пишет в Excel буквально */
export const IMPORT_COLUMNS = [
    'Название*', 'Категория*', 'Единица', 'Кол-во', 'Цена закупки без НДС', 'НДС прихода', 'Цена продажи', 'НДС продажи',
    'Мин. остаток', 'Поставщик', 'Партия', `Срок годности (${EXPIRY_FORMAT_RU})`,
];
const IMPORT_EXAMPLE = ['Парацетамол 500мг', 'Медикаменты', 'шт', 100, 1500, '12%', 2500, '12%', 10, 'ООО Медснаб', 'A-2601', EXPIRY_EXAMPLE];
// Ревью M5 — заголовок читается через headerKey(): регистр, «ё», звёздочка,
// подсказка в скобках («(ДД.ММ.ГГГГ)», «(сум)», «(%)») и хвост «, %» / «, сум»
// не делают его другим. Всё, что и после этого ни во что не ложится, —
// отказ с именем колонки (importRowsFromMatrix): прежде такая колонка молча
// выбрасывалась, и «НДС, %» или «Годен до (ДД.ММ.ГГГГ)» теряли ставку и срок.
const HEADER_MAP = {
    'название': 'name', 'наименование': 'name', 'название товара': 'name', 'наименование товара': 'name',
    'категория': 'category', 'категория товара': 'category', 'тип товара': 'category', 'тип': 'category',
    'единица': 'unit', 'единица измерения': 'unit', 'ед.': 'unit', 'ед': 'unit', 'ед. изм.': 'unit', 'ед. изм': 'unit', 'ед изм': 'unit',
    'кол-во': 'qty', 'количество': 'qty',
    'цена закупки без ндс': 'unit_cost', 'цена закупки': 'unit_cost', 'закупочная цена': 'unit_cost', 'себестоимость': 'unit_cost',
    'ндс прихода': 'receipt_vat_rate', 'ставка ндс прихода': 'receipt_vat_rate', 'ндс закупки': 'receipt_vat_rate',
    'цена продажи': 'sale_price', 'продажная цена': 'sale_price',
    'ндс продажи': 'sale_vat_rate', 'ставка ндс продажи': 'sale_vat_rate',
    'мин. остаток': 'reorder_level', 'мин остаток': 'reorder_level', 'минимальный остаток': 'reorder_level',
    'поставщик': 'supplier',
    'партия': 'batch_no', 'партия / серия': 'batch_no', 'серия / партия': 'batch_no', 'серия': 'batch_no', 'номер партии': 'batch_no',
    'срок годности': 'expiry_date', 'годен до': 'expiry_date',
};
// Прежняя единая колонка «НДС» (ревью F3) — отказ словами о двух колонках.
const RETIRED_VAT_HEADERS = new Set(['ндс', 'ставка ндс']);

/** Ревью M5 — заголовок колонки в том виде, в каком его ищут в HEADER_MAP. */
export function headerKey(raw) {
    return String(raw == null ? '' : raw).toLowerCase().replace(/ё/g, 'е').replace(/\*/g, '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/,\s*(%|сум|uzs|дд\.мм\.гггг)\s*$/, ' ')
        .replace(/%/g, ' ')
        .replace(/\s+/g, ' ').trim();
}
function importHints() {
    return [
        ['Колонка', 'Что писать'],
        ['Название*', 'Точное название товара. Совпало с товаром в каталоге — товар обновится, нет — будет создан.'],
        ['Категория*', 'Одна из: ' + GOODS_CATEGORIES.map((k) => GOODS_CATEGORY_RU[k]).join(', ') + '. Для нового товара обязательна.'],
        ['НДС прихода', '12%, 0% или без НДС — ставка этого прихода, как в счёте-фактуре. Только в строке с «Кол-во». Ставку продажи существующего товара не меняет.'],
        ['НДС продажи', '12%, 0% или без НДС — ставка товара в карточке. Пусто — не меняется (новый товар берёт «НДС прихода», без него — без НДС).'],
        ['Цена закупки без НДС', 'Цена за единицу без НДС, как в счёте-фактуре. Себестоимость на складе будет с НДС.'],
        [`Срок годности (${EXPIRY_FORMAT_RU})`, `Только ${EXPIRY_FORMAT_RU}, например ${EXPIRY_EXAMPLE}, или дата-ячейка Excel. Прошедшая или несуществующая дата — отказ.`],
        ['Партия', 'Номер партии или серии. Партия и срок — только в строке с «Кол-во».'],
    ];
}
/* i18n-exempt-end */

export async function downloadImportTemplate() {
    try {
        const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet([IMPORT_COLUMNS, IMPORT_EXAMPLE]);
        // Срок годности в примере — ТЕКСТ «31.12.2027»: так формат виден, как есть.
        const expCell = XLSX.utils.encode_cell({ r: 1, c: IMPORT_COLUMNS.length - 1 });
        if (ws[expCell]) { ws[expCell].t = 's'; ws[expCell].z = '@'; }
        ws['!cols'] = IMPORT_COLUMNS.map((c) => ({ wch: Math.max(12, c.length + 2) }));
        XLSX.utils.book_append_sheet(wb, ws, 'Импорт');
        const hints = XLSX.utils.aoa_to_sheet(importHints());
        hints['!cols'] = [{ wch: 28 }, { wch: 100 }];
        XLSX.utils.book_append_sheet(wb, hints, 'Подсказки');
        XLSX.writeFile(wb, 'shablon-import-tovarov.xlsx');
    } catch (e) {
        toast(trf('Не удалось сформировать шаблон: {msg}', { msg: (e && e.message) || e }), 'fail');
    }
}

/**
 * Ревью M4 — лист книги → строки ячеек, дата-ячейки — «ДД.ММ.ГГГГ» ровно как
 * написаны. Книга читается ЧИСЛАМИ (cellDates: false, cellNF: true): у
 * дата-ячейки — число Excel и формат даты, и день берётся из частей Excel
 * (SSF.parse_date_code), а не из Date, у которого «+12 часов» переносили
 * «28.09.2026 18:00» на 29.09. Число без формата даты остаётся числом —
 * сервер его отклонит («нужен ДД.ММ.ГГГГ»).
 */
export function sheetMatrix(XLSX, ws) {
    for (const addr of Object.keys(ws || {})) {
        if (addr[0] === '!') continue;
        const c = ws[addr];
        if (!c) continue;
        let dmy = null;
        if (c.t === 'n' && c.z && XLSX.SSF.is_date(c.z)) dmy = dmyOfParts(XLSX.SSF.parse_date_code(c.v));
        else if (c.t === 'd' && c.v instanceof Date) dmy = dmyOfDate(c.v);
        // Формат даты уходит вместе с числом: sheet_to_json иначе прочтёт
        // текст «28.09.2026» как число даты и отдаст пусто.
        if (dmy) { c.t = 's'; c.v = dmy; delete c.w; delete c.z; }
    }
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

/** Буква колонки Excel: 0 → A, 25 → Z, 26 → AA. */
function columnLetter(i) {
    let n = i + 1; let out = '';
    while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
    return out;
}

/** Ячейка срока годности → то, что уходит на сервер: дата-ячейка → «ДД.ММ.ГГГГ». */
export function expiryCellValue(v) {
    if (v instanceof Date) return dmyOfDate(v) || '';
    if (v === undefined || v === null) return '';
    return typeof v === 'number' ? v : String(v).trim();
}

/**
 * Строки импорта из листа (массив строк ячеек, первая — заголовок).
 * Числа и тексты уходят как есть — их проверяет сервер (importProductsExcel —
 * единственный проверяющий); дата-ячейка срока — ДД.ММ.ГГГГ.
 */
export function importRowsFromMatrix(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) throw new Error(tr('Файл пуст.'));
    const raw = (matrix[0] || []).map((x) => (x == null ? '' : String(x).trim()));
    const keys = raw.map((hd) => HEADER_MAP[headerKey(hd)] || null);
    if (!keys.includes('name')) throw new Error(tr('Не найдена колонка «Название» — скачайте «Шаблон».'));
    // Ревью M5 — строгий формат: каждая подписанная колонка должна лечь в
    // шаблон, одна колонка — один раз, данные без заголовка — отказ.
    const firstOf = new Map();
    raw.forEach((hd, ci) => {
        const hk = headerKey(hd);
        if (!hk) {
            if (matrix.slice(1).some((cells) => cells && cells[ci] !== undefined && cells[ci] !== null && String(cells[ci]).trim() !== '')) {
                throw new Error(trf('В колонке {col} есть данные, но нет заголовка — подпишите её по «Шаблону» или удалите.', { col: columnLetter(ci) }));
            }
            return;
        }
        if (RETIRED_VAT_HEADERS.has(hk)) {
            throw new Error(trf('Колонка «{name}» теперь разделена — «НДС продажи» (ставка товара) и «НДС прихода» (ставка этого прихода). Скачайте новый «Шаблон».', { name: hd }));
        }
        const k = keys[ci];
        if (!k) throw new Error(trf('Колонка «{name}» не распознана — в шаблоне такой нет. Допустимо: {list}. Скачайте «Шаблон».', { name: hd, list: IMPORT_COLUMNS.join(', ') }));
        if (firstOf.has(k)) throw new Error(trf('Колонка «{name}» повторяет колонку «{first}» — оставьте одну.', { name: hd, first: firstOf.get(k) }));
        firstOf.set(k, hd);
    });
    const rows = [];
    for (const cells of matrix.slice(1)) {
        if (!cells || cells.every(c => String(c).trim() === '')) continue;
        const row = {};
        keys.forEach((k, ci) => { if (k) row[k] = cells[ci]; });
        rows.push(row);
    }
    if (!rows.length) throw new Error(tr('В файле нет строк данных.'));
    // Numbers go to the server untouched: importProductsExcel is the single
    // validator (it accepts a comma decimal and spacer whitespace, and rejects
    // anything else naming the row). Coercing here would turn a typo'd cell
    // into NaN -> null and import the row silently with no stock.
    const cell = v => (v === undefined || v === null) ? '' : v;
    const text = v => (v === undefined || v === null) ? '' : String(v);
    return rows.map(r => ({
        name: text(r.name),
        category: text(r.category),
        unit: text(r.unit),
        qty: cell(r.qty),
        unit_cost: cell(r.unit_cost),
        receipt_vat_rate: cell(r.receipt_vat_rate),
        sale_price: cell(r.sale_price),
        sale_vat_rate: cell(r.sale_vat_rate),
        vat_rate: cell(r.vat_rate),
        reorder_level: cell(r.reorder_level),
        supplier: text(r.supplier),
        batch_no: text(r.batch_no),
        expiry_date: expiryCellValue(r.expiry_date),
    }));
}

function openImportModal(onDone) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let parsedRows = null;

    const fileInp = h('input', { type: 'file', accept: '.xlsx,.xls' });
    const previewEl = h('div', { style: { marginTop: '10px' } });
    const importBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Импортировать');

    fileInp.addEventListener('change', async () => {
        parsedRows = null;
        importBtn.disabled = true;
        clear(previewEl);
        const file = fileInp.files && fileInp.files[0];
        if (!file) return;
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            // Ревью M4 — книга читается числами с форматами: дата-ячейку
            // (46387 с форматом даты) превращает в ДД.ММ.ГГГГ sheetMatrix — день,
            // как написан, со временем или без.
            const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false, cellNF: true });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = importRowsFromMatrix(sheetMatrix(XLSX, ws));
            parsedRows = rows;
            importBtn.disabled = false;
            previewEl.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                trf('Строк к импорту: {n}. Совпадение — по точному названию товара; новые товары будут созданы.', { n: rows.length })));
        } catch (e) {
            previewEl.appendChild(h('div', { style: { color: 'var(--crit-700)', fontSize: '12.5px' } },
                trf('Ошибка чтения файла: {msg}', { msg: (e && e.message) || e })));
        }
    });

    importBtn.addEventListener('click', async () => {
        if (!parsedRows) return;
        importBtn.disabled = true;
        const prev = importBtn.textContent;
        importBtn.textContent = tr('Импортируем…');
        try {
            const { data, error } = await supabase.rpc('import_products_excel', { rows: parsedRows });
            if (error) throw error;
            toast(trf('Импорт готов: создано {created}, обновлено {updated}, приходов {received}.', { created: data.created, updated: data.updated, received: data.received }), 'ok');
            close();
            if (typeof onDone === 'function') onDone();
        } catch (e) {
            toast((e && e.message) || 'Импорт не выполнен.', 'fail');
            importBtn.disabled = false;
            importBtn.textContent = prev;
        }
    });

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('ArrowUp', { size: 16 }), ' Импорт из Excel'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } },
                'Колонки шаблона: Название*, Категория*, Единица, Кол-во, Цена закупки без НДС, НДС прихода, Цена продажи, НДС продажи, Мин. остаток, Поставщик, Партия, Срок годности (ДД.ММ.ГГГГ). Допустимые значения — на листе «Подсказки» шаблона.'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '6px' } },
                'Категория — одна из восьми; НДС прихода и НДС продажи — 12%, 0% или «без НДС»; срок годности — только ДД.ММ.ГГГГ, например 31.12.2027.'),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
                'Импорт — всё или ничего: ошибка в любой строке отменяет весь файл.'),
            field('Файл', fileInp),
            previewEl,
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            importBtn),
    ));
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// ВЫДАТЬ — STOCK_ISSUE_MODAL_V1: диалог переехал в views/stock-issue-modal.js и
// стал общим с карточкой отдела (поиск товара, несколько строк, остаток,
// проверка перед отправкой, квитанция от двойного списания). Здесь он
// открывается с выбором получателя; из карточки отдела — с получателем уже
// подставленным. Одна дверь, один вызов issue_stock_lines.
// ---------------------------------------------------------------------------
