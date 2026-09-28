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
import { supabase } from '../../supabase.js';
import { h, Icon } from '../ui.js';
import { tr } from '../i18n.js';
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
    try {
        const args = { reachable: true };
        if (place && place.visit_id) args.visit_id = place.visit_id;
        else if (place && place.admission_id) args.admission_id = place.admission_id;
        const { data, error } = await supabase.rpc('holdings_list', args);
        if (!error && data && Array.isArray(data.holdings)) {
            rows = data.holdings;
            if (typeof data.warehouse_allowed === 'boolean') warehouse = data.warehouse_allowed;
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
    return { own, items, rows, warehouse };
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
export async function openShelfRequest({ before = null, onDone = null } = {}) {
    if (typeof before === 'function') before();
    const { openStockRequestDialog } = await import('./stock-requests-ui.js');
    return openStockRequestDialog({ departmentId: ownDepartmentId(), onDone });
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
