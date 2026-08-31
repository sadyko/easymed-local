// Закупки — «Склад» tab (PROCUREMENT_REDESIGN_V1): the warehouse stock table
// from the cloud design — search/filters, low-stock ⚠, OK/Reorder flags,
// Excel export / шаблон / импорт, and Принять / Выдать / Корректировка.
// Stock is a single pool (products.on_hand); per-department balances arrive
// with «Отделения» in phase 2. «Заказать» is rendered disabled until the
// Заказы на закупку tab ships.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { fetchGuard, loadingCard, fmtPrice, fmtMoney2, fmtQty, selStyle, numStyle, isLowStock } from './inventory-shared.js';
import { openReceiveModal, openAdjustModal } from './inventory-products.js';

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
    const flagSel = filterSelect([['all', 'Все'], ['ok', 'OK'], ['reorder', 'Reorder']], sklad.flag,
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
            toolBtn('Выдать', 'Send', () => openIssueModal(reload)),
            toolBtn('Корректировка', 'Edit', () => openAdjustModal(null, reload)),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openReceiveModal(reload) },
                Icon('Plus', { size: 14 }), ' Принять'),
        ),
        h('div', { style: { overflowX: 'auto' } },
            h('table', { class: 'tbl' },
                h('thead', null,
                    h('tr', null,
                        h('th', null, 'Product'),
                        h('th', null, 'Единица'),
                        h('th', null, 'Поставщик'),
                        h('th', null, 'В наличии'),
                        h('th', null, 'Выдать'),
                        h('th', null, 'Себестоимость'),
                        h('th', null, 'Стоимость'),
                        h('th', null, 'Flag'),
                        h('th', null, ''),
                    ),
                    h('tr', null,
                        h('td', { style: { padding: '6px 10px' } }, searchInp),
                        h('td', { style: { padding: '6px 10px', minWidth: '90px' } }, unitSel),
                        h('td', { style: { padding: '6px 10px', minWidth: '140px' } }, supplierSel),
                        h('td', { style: { padding: '6px 10px', minWidth: '110px' } }, availSel),
                        h('td', null, ''),
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
        return h('tr', null,
            h('td', { class: 'cell-strong' }, p.name || '—'),
            h('td', null, p.base_unit || '—'),
            h('td', null, (p.suppliers && p.suppliers.name) || '—'),
            h('td', { class: 'num' }, low
                ? h('span', { style: { color: 'var(--crit-500)' } }, Icon('Warning', { size: 13 }), ' ' + fmtQty(onHand))
                : fmtQty(onHand)),
            h('td', { class: 'num' }, `${fmtQty(onHand * iu.factor)} ${iu.unit}`.trim()),
            h('td', { class: 'num' }, fmtMoney2(p.avg_cost)),
            h('td', { class: 'num' }, fmtPrice(onHand * (Number(p.avg_cost) || 0))),
            h('td', null, low ? Tag('Reorder', { kind: 'crit' }) : Tag('OK', { kind: 'ok' })),
            h('td', { style: { textAlign: 'right' } },
                h('button', { class: 'btn btn-sm', type: 'button', disabled: true, title: 'Заказы на закупку — во 2-й фазе' }, 'Заказать')),
        );
    }

    // ---- Excel: export current (filtered) view --------------------------
    async function exportExcel() {
        try {
            const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
            const matrix = [
                ['Товар', 'Единица', 'Поставщик', 'В наличии', 'Выдать', 'Себестоимость', 'Стоимость', 'Флаг'],
                ...filtered().map(p => {
                    const iu = issueUnitOf(p);
                    const onHand = Number(p.on_hand) || 0;
                    return [
                        p.name || '', p.base_unit || '', (p.suppliers && p.suppliers.name) || '',
                        onHand, `${fmtQty(onHand * iu.factor)} ${iu.unit}`.trim(),
                        Number(p.avg_cost) || 0, Math.round(onHand * (Number(p.avg_cost) || 0)),
                        isLowStock(p) ? 'Reorder' : 'OK',
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
// ВЫДАТЬ — выдача со склада отделению/сотруднику без визита. Кол-во вводится
// в единицах выдачи (consumption); сервер (issue_stock_lines) конвертирует и
// не даёт уйти в минус.
// ---------------------------------------------------------------------------
function openIssueModal(onDone) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const modal = { products: [], departments: [] };
    const lineObjs = [];
    const linesBody = h('tbody');
    linesBody.appendChild(h('tr', null, h('td', { colspan: '4', style: { textAlign: 'center', padding: '16px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Загрузка товаров…')));

    const addLineBtn = h('button', {
        class: 'btn btn-sm', type: 'button', disabled: true,
        onclick: () => addLine(),
    }, Icon('Plus', { size: 13 }), ' Добавить строку');

    const deptList = h('datalist', { id: 'issue-recipients' });
    const recipientInp = h('input', { type: 'text', required: true, list: 'issue-recipients', placeholder: 'Отделение или сотрудник' });
    const noteInp = h('input', { type: 'text', placeholder: 'Основание (необязательно)' });

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Выдать');
    saveBtn.addEventListener('click', save);

    function addLine() {
        const line = { product: null, qty: '' };
        lineObjs.push(line);
        linesBody.appendChild(buildLineRow(line));
    }

    function buildLineRow(line) {
        const prodSel = h('select', { style: selStyle },
            h('option', { value: '' }, '— Выберите товар —'),
            ...modal.products.map(pr => h('option', { value: String(pr.id) }, pr.name)));
        const hintEl = h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '3px' } }, '');
        const unitEl = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '—');

        function refresh() {
            if (!line.product) { hintEl.textContent = ''; unitEl.textContent = '—'; return; }
            const iu = issueUnitOf(line.product);
            unitEl.textContent = iu.unit || '—';
            const avail = (Number(line.product.on_hand) || 0) * iu.factor;
            hintEl.textContent = trf('Доступно: {qty} {unit}', { qty: fmtQty(avail), unit: iu.unit || '' }).trim();
        }

        prodSel.addEventListener('change', () => {
            const pid = Number(prodSel.value) || null;
            line.product = modal.products.find(pr => pr.id === pid) || null;
            refresh();
        });

        const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: '', style: numStyle });
        qtyInp.addEventListener('input', () => { line.qty = qtyInp.value; });

        const removeBtn = h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать строку',
            onclick: () => {
                const i = lineObjs.indexOf(line);
                if (i >= 0) lineObjs.splice(i, 1);
                tr.remove();
                if (lineObjs.length === 0) addLine();
            },
        }, '×');

        refresh();
        const tr = h('tr', null,
            h('td', null, prodSel, hintEl),
            h('td', { style: { width: '110px' } }, unitEl),
            h('td', { style: { width: '110px' } }, qtyInp),
            h('td', { style: { width: '36px', textAlign: 'center' } }, removeBtn),
        );
        return tr;
    }

    async function save() {
        const recipient = recipientInp.value.trim();
        if (!recipient) { toast('Укажите, кому выдаётся товар.', 'fail'); return; }
        const lines = [];
        for (const line of lineObjs) {
            if (!line.product) continue;
            const qty = Number(line.qty);
            if (!Number.isFinite(qty) || qty <= 0) continue;
            lines.push({ product_id: line.product.id, qty, unit: 'consumption' });
        }
        if (!lines.length) { toast('Добавьте хотя бы одну позицию.', 'fail'); return; }

        saveBtn.disabled = true;
        const prev = saveBtn.textContent;
        saveBtn.textContent = tr('Выдаём…');
        try {
            const note = noteInp.value.trim() || undefined;
            const { error } = await supabase.rpc('issue_stock_lines', { lines, recipient, note });
            if (error) throw error;
            toast('Выдано со склада', 'ok');
            close();
            if (typeof onDone === 'function') onDone();
        } catch (e) {
            toast((e && e.message) || 'Не удалось выдать.', 'fail');
            saveBtn.disabled = false;
            saveBtn.textContent = prev;
        }
    }

    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '680px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Send', { size: 16 }), ' Выдать со склада'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
            h('div', { style: { overflowX: 'auto', border: '1px solid var(--ink-100)', borderRadius: '10px', marginBottom: '10px' } },
                h('table', { class: 'tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Товар'),
                        h('th', null, 'Ед. выдачи'),
                        h('th', null, 'Кол-во'),
                        h('th', null, ''),
                    )),
                    linesBody,
                ),
            ),
            addLineBtn,
            field('Кому', h('div', null, recipientInp, deptList), { required: true }),
            field('Примечание', noteInp),
        ),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Отмена'),
            h('span', { class: 'grow' }),
            saveBtn),
    ));
    document.body.appendChild(overlay);

    (async () => {
        try {
            const [pr, dr] = await Promise.all([
                supabase.from('products')
                    .select('id,name,base_unit,consumption_unit,consumption_factor,on_hand')
                    .eq('active', 1).order('name', { ascending: true }),
                supabase.from('departments').select('name').eq('active', 1).order('name', { ascending: true }),
            ]);
            if (pr.error) throw pr.error;
            modal.products = pr.data || [];
            modal.departments = (dr.error ? [] : dr.data) || [];
            for (const d of modal.departments) deptList.appendChild(h('option', { value: d.name }));
        } catch (e) {
            toast(trf('Не удалось загрузить товары: {msg}', { msg: (e && e.message) || e }), 'fail');
            modal.products = [];
        } finally {
            clear(linesBody);
            addLineBtn.disabled = false;
            if (!modal.products.length) {
                linesBody.appendChild(h('tr', null,
                    h('td', { colspan: '4', style: { textAlign: 'center', padding: '16px', color: 'var(--ink-500)', fontSize: '12.5px' } }, 'Нет активных товаров.')));
            } else {
                addLine();
            }
        }
    })();
}
