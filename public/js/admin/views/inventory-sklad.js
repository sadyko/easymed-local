// Закупки — «Склад» tab (PROCUREMENT_REDESIGN_V1): the warehouse stock table
// from the cloud design — search/filters, low-stock ⚠, OK/Reorder flags,
// Excel export / шаблон / импорт, and Принять / Выдать / Корректировка.
// Stock is a single pool (products.on_hand); per-department balances arrive
// with «Отделения» in phase 2. «Заказать» is rendered disabled until the
// Заказы на закупку tab ships.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard, loadingCard, fmtPrice, fmtMoney2, fmtQty, selStyle, isLowStock } from './inventory-shared.js';
import { openReceiveModal, openAdjustModal } from './inventory-products.js';
import { openStockIssueModal } from './stock-issue-modal.js';   // STOCK_ISSUE_MODAL_V1 — общий диалог выдачи

const sklad = {
    products: [], suppliers: [],
    q: '', unit: 'all', supplier: 'all', avail: 'all', flag: 'all',
    tbody: null, emptyEl: null,
};

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

    let products = [], suppliers = [], loadError = null;
    try {
        const [pr, sr] = await Promise.all([
            supabase.from('products').select('*, suppliers(id,name)').order('name', { ascending: true }).limit(1000),
            supabase.from('suppliers').select('id,name').eq('active', 1).order('name', { ascending: true }),
        ]);
        if (pr.error) throw pr.error;
        products = pr.data || [];
        suppliers = (sr.error ? [] : sr.data) || [];
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
    sklad.tbody = h('tbody');
    sklad.emptyEl = h('div', { class: 'empty', style: { display: 'none' } }, 'Ничего не найдено.');

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
            toolBtn('Шаблон', 'Doc', downloadTemplate),
            toolBtn('Импорт из Excel', 'ArrowUp', () => openImportModal(reload)),
            toolBtn('Выдать', 'Send', () => openStockIssueModal({ onDone: reload })),   // STOCK_ISSUE_MODAL_V1
            toolBtn('Корректировка', 'Edit', () => openAdjustModal(null, reload)),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReceiveModal(reload) },
                Icon('Plus', { size: 14 }), ' Принять'),
        ),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null,
                    h('tr', null,
                        h('th', null, 'Товар'),
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

    // ---- rows ------------------------------------------------------------
    function filtered() {
        const q = sklad.q.trim().toLowerCase();
        return sklad.products.filter(p => {
            const onHand = Number(p.on_hand) || 0;
            const low = isLowStock(p);
            if (q && !(p.name || '').toLowerCase().includes(q)) return false;
            if (sklad.unit !== 'all' && p.base_unit !== sklad.unit) return false;
            if (sklad.supplier === 'none' && p.supplier_id) return false;
            if (sklad.supplier !== 'all' && sklad.supplier !== 'none' && p.supplier_id !== Number(sklad.supplier)) return false;
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
        if (!rows.length) { sklad.emptyEl.style.display = ''; return; }
        sklad.emptyEl.style.display = 'none';
        for (const p of rows) sklad.tbody.appendChild(productRow(p));
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
            h('td', null, p.base_unit || '—'),
            h('td', null, (p.suppliers && p.suppliers.name) || '—'),
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
                ['Товар', 'Единица', 'Поставщик', 'В наличии', 'В ед. выдачи', 'Себестоимость', 'Стоимость', 'Флаг'],
                ...filtered().map(p => {
                    const iu = issueUnitOf(p);
                    const su = stockUnitOf(p);
                    const onHand = Number(p.on_hand) || 0;
                    return [
                        p.name || '', p.base_unit || '', (p.suppliers && p.suppliers.name) || '',
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

    // ---- Excel: import template -----------------------------------------
    async function downloadTemplate() {
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const matrix = [
                ['Название*', 'Единица', 'Кол-во', 'Себестоимость', 'Мин. остаток', 'Поставщик'],
                ['Парацетамол 500мг', 'шт', 100, 1500, 10, 'ООО Медснаб'],
            ];
            const ws = XLSX.utils.aoa_to_sheet(matrix);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Импорт');
            XLSX.writeFile(wb, 'shablon-import-tovarov.xlsx');
        } catch (e) {
            toast(trf('Не удалось сформировать шаблон: {msg}', { msg: (e && e.message) || e }), 'fail');
        }
    }
}

// ---------------------------------------------------------------------------
// ИМПОРТ ИЗ EXCEL — клиент читает книгу (vendored SheetJS), маппит колонки
// шаблона, сервер (import_products_excel) делает всё в одной транзакции.
// ---------------------------------------------------------------------------
const HEADER_MAP = {
    'название': 'name', 'единица': 'unit', 'кол-во': 'qty', 'количество': 'qty',
    'себестоимость': 'unit_cost', 'мин. остаток': 'reorder_level', 'мин остаток': 'reorder_level',
    'поставщик': 'supplier',
};

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
            const wb = XLSX.read(await file.arrayBuffer());
            const ws = wb.Sheets[wb.SheetNames[0]];
            const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            if (!matrix.length) throw new Error('Файл пуст.');
            const headers = matrix[0].map(x => String(x).toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim());
            const keys = headers.map(hd => HEADER_MAP[hd] || null);
            if (!keys.includes('name')) throw new Error('Не найдена колонка «Название» — скачайте «Шаблон».');
            const rows = [];
            for (const cells of matrix.slice(1)) {
                if (!cells || cells.every(c => String(c).trim() === '')) continue;
                const row = {};
                keys.forEach((k, ci) => { if (k) row[k] = cells[ci]; });
                rows.push(row);
            }
            if (!rows.length) throw new Error('В файле нет строк данных.');
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
            // Numbers go to the server untouched: importProductsExcel is the single
            // validator (it accepts a comma decimal and spacer whitespace, and rejects
            // anything else naming the row). Coercing here would turn a typo'd cell
            // into NaN -> null and import the row silently with no stock.
            const cell = v => (v === undefined || v === null) ? '' : v;
            const rows = parsedRows.map(r => ({
                name: r.name === undefined ? '' : String(r.name),
                unit: r.unit === undefined ? '' : String(r.unit),
                qty: cell(r.qty),
                unit_cost: cell(r.unit_cost),
                reorder_level: cell(r.reorder_level),
                supplier: r.supplier === undefined ? '' : String(r.supplier),
            }));
            const { data, error } = await supabase.rpc('import_products_excel', { rows });
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

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '520px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('ArrowUp', { size: 16 }), ' Импорт из Excel'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '10px' } },
                'Колонки шаблона: Название*, Единица, Кол-во, Себестоимость, Мин. остаток, Поставщик. ',
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
