// OWN_SHELF_ONLY_V1 (2026-09-28) — «ВЫДАЮ СО СВОИХ ПОЛОК»: ОДИН ИСТОЧНИК ПРАВДЫ
// ДЛЯ ЧЕТЫРЁХ ЭКРАНОВ ВЫДАЧИ.
//
// Владелец: «when requesting procurement in the cabinet of the doctor or nurse
// (as entered as a nurse or doctor) we don't need to see the items that we have
// in the procurement overall. Also in the doctor's cabinet or in the
// procedures, items should be dispensed from their shelf not from the
// procurement overall. Also in the stationary too.» Решение: со склада
// напрямую выдают только администратор и склад.
//
// Сервер это уже знает (rpc/inventory.js planSources — склад в конце цепочки
// только у них), и экранам остаётся не обещать того, чего сервер не сделает:
// окно выдачи, вкладка медсестры «Выдать пациенту», консоль койки «Товары для
// пациента» и счёт визита показывают врачу и медсестре ТОЛЬКО их полки
// (подотчёт → кабинет → отдел) и «Своё: N», без общего складского остатка.
// Пустые полки — «На ваших полках ничего нет — запросите у склада» и кнопка
// заявки (тот же диалог, что «Мои запасы» → «Запросить»).
//
// КТО ВИДИТ СКЛАД, РЕШАЕТ СЕРВЕР: holdings_list { reachable } отвечает
// warehouse_allowed. Роль вошедшего спрашивается только тогда, когда ответа
// нет (сервер не ответил) — тем же списком, что у сервера.
//
// Ревью F5 — правило «только со своих полок» — переключатель клиники,
// ВЫКЛЮЧЕННЫЙ по умолчанию (stock-policy.js, экран «Закупки» → «Только со
// своих полок»). Выключен — сервер отвечает warehouse_allowed = true и врачу,
// и медсестре (склад добирает, как в 3.12.1), а число склада им не показывает
// (warehouse_visible = false): экраны пишут «есть на складе» / «нет на складе».
// Отказ own_shelf_short и «Запросить у склада» случаются только при включённом.
import { supabase } from '../../supabase.js';
import { h, Icon } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { hasActorRole, ownDepartmentId } from '../permissions.js';

/** Кому склад — источник при выдаче пациенту (зеркало inventory.js WAREHOUSE_DISPENSE_ROLES). */
export const WAREHOUSE_DISPENSE_ROLES = Object.freeze(['admin', 'inventory']);

/**
 * Свои полки для этой выдачи и можно ли брать со склада.
 * `place` — { visit_id } | { admission_id } | null (без места — свои полки
 * вообще: подотчёт, свой кабинет, свой отдел).
 * → { own: Map<product_id, базовых единиц>, items: Map<product_id, товар>,
 *     rows: строки holdings_list, warehouse: boolean }
 * Товар из полок — { id, name, unit (базовая), price, sale_price, is_drug,
 * consumption_unit, consumption_factor, active } — ровно столько, сколько
 * нужно окну выдачи, без обращения к каталогу склада.
 */
export async function loadShelves(place) {
    const own = new Map();
    const items = new Map();
    let rows = [];
    let warehouse = null;
    let warehouseVisible = null;   // ревью M2 — видит ли число склада
    let inStock = null;            // ревью M2 — берёт, но числа не видит: что на складе есть
    try {
        const args = { reachable: true };
        if (place && place.visit_id) args.visit_id = place.visit_id;
        else if (place && place.admission_id) args.admission_id = place.admission_id;
        const { data, error } = await supabase.rpc('holdings_list', args);
        if (!error && data && Array.isArray(data.holdings)) {
            rows = data.holdings;
            if (typeof data.warehouse_allowed === 'boolean') warehouse = data.warehouse_allowed;
            if (typeof data.warehouse_visible === 'boolean') warehouseVisible = data.warehouse_visible;
            if (Array.isArray(data.warehouse_in_stock)) inStock = new Set(data.warehouse_in_stock.map(Number));
            for (const hd of rows) {
                const id = Number(hd.product_id);
                own.set(id, Math.round(((own.get(id) || 0) + (Number(hd.qty_base) || 0)) * 1e6) / 1e6);
                if (!items.has(id)) {
                    items.set(id, {
                        id, name: hd.product_name || '', unit: hd.base_unit || '',
                        price: Number(hd.sale_price) || 0, sale_price: Number(hd.sale_price) || 0,
                        is_drug: !!hd.is_drug, active: hd.active !== false,
                        consumption_unit: hd.consumption_unit || '', consumption_factor: Number(hd.consumption_factor) || 1,
                    });
                }
            }
        }
    } catch { /* нет ответа — полки пусты, склад решит роль ниже */ }
    if (warehouse === null) warehouse = hasActorRole(WAREHOUSE_DISPENSE_ROLES);
    // Старый сервер флага «видит» не присылал: число видели те же, кто брал.
    if (warehouseVisible === null) warehouseVisible = warehouse;
    return { own, items, rows, warehouse, warehouseVisible, inStock: inStock || new Set() };
}

/**
 * Ревью M2 — СКЛАД В ПОДПИСИ ТОВАРА: одно правило на четыре экрана выдачи.
 *   null                          — склад этому человеку не источник;
 *   { visible: true, qty, has }   — источник, и число видно (как прежде);
 *   { visible: false, has }       — источник, а числа не видно (своя роль на
 *                                   основе администратора или склада с
 *                                   «Закупки: Нет»): «есть на складе» /
 *                                   «нет на складе», без количества.
 * В подпись никогда не попадают null и NaN: пустое число склада — 0.
 */
export function warehouseStock(shelves, productId, onHand) {
    if (!shelves || !shelves.warehouse) return null;
    if (shelves.warehouseVisible) {
        const n = Number(onHand);
        const qty = onHand == null || !Number.isFinite(n) ? 0 : n;
        return { visible: true, qty, has: qty > 0 };
    }
    return { visible: false, qty: null, has: !!(shelves.inStock && shelves.inStock.has(Number(productId))) };
}

/** «есть на складе» / «нет на складе» — склад без числа. */
export function warehouseWord(ws) {
    return ws && ws.has ? tr('есть на складе') : tr('нет на складе');
}

/** Товары своих полок в порядке каталога: препараты первыми, дальше по имени. */
export function shelfItems(shelves) {
    return [...(shelves && shelves.items ? shelves.items.values() : [])]
        .sort((a, b) => (Number(!!b.is_drug) - Number(!!a.is_drug)) || String(a.name).localeCompare(String(b.name), 'ru'));
}

/** «Своё: 2,5» — число своих полок, как его пишет окно выдачи. */
export const fmtShelfQty = (n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

/**
 * Открыть заявку на склад — тот же диалог, что «Мои запасы» → «Запросить»
 * (себе или своему отделу). `before` — закрыть окно, которое стоит выше
 * диалога заявки (окно выдачи живёт на этаже 135, заявка — на общем 100).
 */
export async function openShelfRequest({ before = null, onDone = null, lines = null } = {}) {
    if (typeof before === 'function') before();
    const { openStockRequestDialog } = await import('./stock-requests-ui.js');
    // Ревью F4 — `lines` [{ product_id, qty }]: заявка открывается уже с тем, чего
    // не хватило (количество — в единице заявки, единице расхода).
    return openStockRequestDialog({ departmentId: ownDepartmentId(), onDone, lines: Array.isArray(lines) ? lines : [] });
}

// ---------------------------------------------------------------------------
// OWN_SHELF_ONLY_V1 (ревью F4) — ОТКАЗ «НЕТ НА ВАШИХ ПОЛКАХ» — С ДЕЙСТВИЕМ.
//
// План обещал: отказ с кодом own_shelf_short предлагает «Запросить у склада».
// Ни один экран код не читал — человек видел красную плашку и искал заявку
// сам. Теперь двери выдачи (счёт визита, консоль койки, вкладка медсестры,
// окно выдачи, лист назначений) показывают отказ окном: слова сервера и
// кнопка «Запросить у склада», которая открывает заявку уже с этим товаром и
// нехваткой (сервер кладёт их в params отказа: product_id, request_qty).
// ---------------------------------------------------------------------------
/** Код отказа сервера (inventory.js OWN_SHELF_SHORT). */
export const OWN_SHELF_SHORT = 'own_shelf_short';

/** Это отказ «нет на ваших полках»? */
export function isOwnShelfShort(err) {
    return !!(err && err.code === OWN_SHELF_SHORT);
}

/** Что запросить у склада по отказу: [{ product_id, qty }] или []. */
export function ownShelfRequestLines(err) {
    const p = (err && err.params) || {};
    const id = Number(p.product_id);
    if (!Number.isInteger(id) || id <= 0) return [];
    const qty = Number(p.request_qty);
    return [{ product_id: id, qty: Number.isFinite(qty) && qty > 0 ? qty : null }];
}

/**
 * Окно отказа: слова сервера (на языке экрана — шаблон и его подстановки) и
 * «Запросить у склада». `before` — закрыть окно, из которого выдавали (оно
 * стоит выше диалога заявки); `onDone` — после поданной заявки.
 */
export function showOwnShelfRefusal(err, { before = null, onDone = null } = {}) {
    const overlay = h('div', { class: 'modal', style: { zIndex: '140' }, 'data-own-shelf-refusal': '' });
    const close = () => overlay.remove();
    const params = (err && err.params) || {};
    const text = err && err.template ? trf(err.template, params) : tr((err && err.message) || '');
    const requestBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-shelf-request': '',
        onclick: () => openShelfRequest({ before: () => { close(); if (typeof before === 'function') before(); }, onDone, lines: ownShelfRequestLines(err) }) },
        Icon('Send', { size: 13 }), ' ', tr('Запросить у склада'));
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', role: 'alertdialog', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Warning', { size: 16 }), ' ', tr('Нет на ваших полках')),
            h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            h('p', { style: { margin: 0 } }, text),
            h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '8px 0 0' } },
                tr('Выдают пациенту со своих полок: личный подотчёт, кабинет, отдел. Склад выдаёт по заявке.'))),
        h('footer', { class: 'modal-foot' },
            h('button', { class: 'btn', type: 'button', onclick: close }, tr('Закрыть')),
            h('span', { class: 'grow' }),
            requestBtn)));
    document.body.appendChild(overlay);
    return { close };
}

/** Кнопка «Запросить у склада». */
export function shelfRequestButton(opts = {}) {
    return h('button', { class: 'btn btn-sm btn-outline', type: 'button', 'data-shelf-request': '', onclick: () => openShelfRequest(opts) },
        Icon('Send', { size: 13 }), ' ', tr('Запросить у склада'));
}

/** Пустые свои полки: слова и кнопка заявки. */
export function emptyShelvesNotice(opts = {}) {
    return h('div', { class: 'empty', 'data-empty-shelves': '', style: { padding: '18px', display: 'grid', gap: '10px', justifyItems: 'center', textAlign: 'center' } },
        h('p', null, tr('На ваших полках ничего нет — запросите у склада')),
        h('p', { class: 'muted', style: { fontSize: '12.5px', margin: 0 } },
            tr('Выдают пациенту со своих полок: личный подотчёт, кабинет, отдел. Склад выдаёт по заявке.')),
        shelfRequestButton(opts));
}
