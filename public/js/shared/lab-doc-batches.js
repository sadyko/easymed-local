// LAB_DOC_SPLIT_V1 (решение владельца 2026-11-07, п. 8) — ДОКУМЕНТЫ АНАЛИЗОВ ВИЗИТА.
//
// Было (LAB_DOC_ONE_PER_VISIT_V1): один документ «Результаты анализов» на визит
// со всеми его анализами. Лаборатория подтверждает часть заказа (ОАК готов
// утром, гормоны — к вечеру) — и пациент ждал, пока будет готово всё, или
// получал документ с пустыми строками.
//
// Стало: анализы, подтверждённые ВМЕСТЕ («Проверить и выдать» строки или
// «Подтвердить» карточки — одна отметка verified_at на всех), — отдельный
// документ «выдан». Ещё не подтверждённые анализы визита — свой документ
// «готовится» (готово N из M), пока их не подтвердят: тогда они становятся
// следующим отдельным документом. Каждый заказ — ровно в одном документе:
// выданное не повторяется. Всё подтвердили разом — документ один, как прежде.
// Выданные до обновления без отметки времени — один документ визита.
// Отменённые и возвращённые строки — не документ.
//
// Источник — уже существующие поля строки заказа (status, verified_at):
// хранить новое не нужно. Правило одно для карты пациента, раздела
// «Документы» и окна выбора печати. Модуль чистый: без DOM, сети и импортов.
export const ISSUED_LEGACY = '';
const SKIP = new Set(['cancelled', 'canceled', 'refunded']);

/**
 * @param {Array<{id:number, visitId:any, status:string, verifiedAt?:string|null}>} orders
 *        лабораторные строки заказа (одного или нескольких визитов)
 * @param {{hasResult:(id:number)=>boolean}} o
 * @returns {Array<{key:string, visitId:any, kind:'issued'|'pending', verifiedAt:string|null,
 *                  orderIds:number[], ready:number, total:number, complete:boolean}>}
 *   по визиту (как пришли), внутри — выданные по времени подтверждения, «готовится» — последним
 */
export function labDocBatches(orders, { hasResult = () => false } = {}) {
    const visits = new Map();
    for (const x of orders || []) {
        if (!x || x.id == null || SKIP.has(x.status)) continue;
        const vk = x.visitId == null ? '' : String(x.visitId);
        if (!visits.has(vk)) visits.set(vk, { visitId: x.visitId, list: [] });
        visits.get(vk).list.push(x);
    }
    const out = [];
    for (const { visitId, list } of visits.values()) {
        const issued = new Map();
        const pending = [];
        for (const x of [...list].sort((a, b) => Number(a.id) - Number(b.id))) {
            if (x.status === 'completed') {
                const k = x.verifiedAt ? String(x.verifiedAt) : ISSUED_LEGACY;
                if (!issued.has(k)) issued.set(k, []);
                issued.get(k).push(x);
            } else {
                pending.push(x);
            }
        }
        const doc = (kind, verifiedAt, xs) => {
            const orderIds = xs.map((x) => Number(x.id));
            const ready = orderIds.filter((id) => hasResult(id)).length;
            return {
                key: 'v' + (visitId == null ? '' : visitId) + ':' + kind + ':' + (verifiedAt == null ? '' : verifiedAt),
                visitId, kind, verifiedAt, orderIds, ready, total: orderIds.length,
                complete: orderIds.length > 0 && ready === orderIds.length,
            };
        };
        const stamps = [...issued.keys()].sort();
        for (const k of stamps) out.push(doc('issued', k, issued.get(k)));
        if (pending.length) out.push(doc('pending', null, pending));
    }
    return out;
}
