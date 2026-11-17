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

// LAB_DOC_NOT_READY_V1 (решение владельца, 3.25.0) — «ВНЕСЁН, НО НЕ ПОДТВЕРЖДЁН» — «НЕ ГОТОВ».
//
// Владелец: «the saved laboratory analyses (but not confirmed) are available in the
// documents section». Сохранение листа (rpc save_lab_results) ставит строке 'resulted'
// и снимает отметку проверки; «Проверить и выдать» / «Подтвердить» лаборатории ставят
// 'completed' и verified_at. Документ анализа ВЫДАН, когда строка подтверждена
// ('completed') или на ней стоит отметка проверки; иначе он «Не готов»: в списках он
// есть (видно, что анализ делается), но без значений, и не открывается и не печатается.
//
// ОДНО правило на всех: лента «Документов» и карта пациента (сервер не отдаёт
// значений не подтверждённого), архив пациента и окно печати, история болезни
// (пометка «не проверено», как у «Вставить результаты» кабинета врача).
// Лаборатория, кабинет врача, бот и «Мои направления» правилом не меняются.
/** Документ анализа строки выдан? status, verified_at — поля строки заказа (visit_services). */
export function labDocIssued(status, verifiedAt) {
    return status === 'completed' || !!verifiedAt;
}

/**
 * @param {Array<{id:number, visitId:any, status:string, verifiedAt?:string|null}>} orders
 *        лабораторные строки заказа (одного или нескольких визитов)
 * @param {{hasResult:(id:number)=>boolean}} o
 * @returns {Array<{key:string, visitId:any, kind:'issued'|'pending', verifiedAt:string|null,
 *                  orderIds:number[], ready:number, total:number, complete:boolean, printable:boolean}>}
 *   по визиту (как пришли), внутри — выданные по времени подтверждения, «готовится» — последним.
 *   complete — у каждого заказа документа есть результат; printable (LAB_DOC_NOT_READY_V1) —
 *   документ можно открыть и напечатать: выдан и complete.
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
            if (labDocIssued(x.status, x.verifiedAt)) {   // LAB_DOC_NOT_READY_V1 — то же правило, что у всех
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
            const complete = orderIds.length > 0 && ready === orderIds.length;
            return {
                key: 'v' + (visitId == null ? '' : visitId) + ':' + kind + ':' + (verifiedAt == null ? '' : verifiedAt),
                visitId, kind, verifiedAt, orderIds, ready, total: orderIds.length,
                complete,
                printable: kind === 'issued' && complete,   // LAB_DOC_NOT_READY_V1 — «готовится» не печатается
            };
        };
        const stamps = [...issued.keys()].sort();
        for (const k of stamps) out.push(doc('issued', k, issued.get(k)));
        if (pending.length) out.push(doc('pending', null, pending));
    }
    return out;
}
