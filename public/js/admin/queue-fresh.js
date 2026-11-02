// QUEUE_FRESH_V1 (3.21.0) — ЗАВЕРШЁННЫЙ ПРИЁМ НЕ ВИСИТ В ОЧЕРЕДИ.
//
// Кабинет врача («Мои приёмы» и «Мой день») — панель из кэша оболочки: при
// возврате её показывают снова и НЕ перерисовывают (admin.js «Already mounted?
// Show it again — never re-render», страж app-shell.test.mjs). После «Завершить
// приём» врач возвращался к старой копии: строка «Идёт приём / Продолжить»
// висела сверху до F5.
//
// Окно приёма сообщает сюда номер строки и её новый статус сразу после записи
// на сервер (noteLineStatus); кабинет и «Мой день» подписаны (onLineStatus),
// ставят статус у себя и помечают очередь устаревшей. Общего хука «при показе»
// в admin.js нет и не вводится.
//
// Модуль без зависимостей. Импорт — только '../queue-fresh.js' без ?v=: его
// грузят и кабинет, и окно приёма, и экземпляр обязан быть ОДИН (адрес с ?v= —
// второй экземпляр со своими подписчиками, и почта молча не доходит).
const LISTENERS = new Set();

/** Строка визита `lineId` получила статус `status` — сервер его уже записал. */
export function noteLineStatus(lineId, status) {
    if (lineId == null || lineId === '' || !status) return;
    for (const fn of [...LISTENERS]) {
        try { fn(lineId, String(status)); } catch (e) { console.warn('[queue-fresh]', e); }
    }
}

/** Подписка на сообщения; возвращает отписку. */
export function onLineStatus(fn) {
    if (typeof fn !== 'function') return () => {};
    LISTENERS.add(fn);
    return () => { LISTENERS.delete(fn); };
}
