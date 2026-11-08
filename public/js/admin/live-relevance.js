// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — КАКОЕ ИЗМЕНЕНИЕ КАКОМУ ЭКРАНУ ВАЖНО.
//
// Сервер (server/services/live/bus.js, routes/live.js) шлёт событие «записано» с именами
// таблиц. Экран перечитывает себя, только если записано то, что он показывает. Правила —
// здесь, одним списком: их видно целиком, и их проверяет тест (__tests__/live.test.mjs),
// а сервер сверяет, что каждую таблицу отсюда он ловит (routes/live.test.js, LIVE_TABLES).
//
// Решаем по ТАБЛИЦАМ, а не по именам RPC: запись RPC база называет сама (временные
// триггеры шины), и новый RPC, выставляющий счёт, будит кассу без правки этого файла.
// Без зависимостей от DOM — модуль читают и браузер, и тесты сервера.
//
// РЕВЬЮ 3.22.0 (M3) — НАГРУЗКА В БОЛЬШОЙ КЛИНИКЕ. Правила клиники-широкие («кто-то
// где-то записал визит»), а экранов открыто тридцать: без меры каждое сохранение будило
// бы все разом. Поэтому у каждого экрана:
//   • minIntervalMs — не чаще одного перечитывания за это время (отложенное выполняется
//     после, ничего не теряется). Касса и «Мои приёмы» — 2 с: владельцу важно, чтобы
//     кассир сразу видел новый счёт, а врач — направленного пациента; лаборатория и
//     процедуры — 3 с; «Мой день» — 20 с: это сводка дня с деньгами врача (отчёт в пуле
//     потоков), а не рабочий список;
//   • и общий для всех разброс LIVE_SPREAD_MS (0–2 с) поверх тишины live.js: экраны
//     клиники перечитываются не в одну и ту же секунду.
// «Мой день» — своё, более узкое правило (cabinetDay): без результатов анализов — каждое
// сообщение анализатора будило бы кабинеты всех врачей. «Мои приёмы» результатов не
// читают вовсе (строка анализа меняет статус в visit_services — его правило ловит).

/** Разброс перечитывания поверх тишины, мс: 0…LIVE_SPREAD_MS, у каждого экрана свой. */
export const LIVE_SPREAD_MS = 2000;

export const LIVE_RELEVANCE = Object.freeze({
    // Касса: счета и их строки, оплаты, возвраты, визиты и услуги («Ждут счёта»),
    // депозиты, смена и движения денег (плашка смены и плитки).
    cashier: Object.freeze({ minIntervalMs: 2000, tables: Object.freeze([
        'invoices', 'invoice_items', 'payments', 'pay_refund_releases',
        'visits', 'visit_services', 'patient_deposits', 'cash_shifts', 'cash_movements',
    ]) }),
    // «Мои приёмы»: визиты и строки, счёт и оплата (касса отпускает строку к осмотру),
    // возврат строки.
    cabinet: Object.freeze({ minIntervalMs: 2000, tables: Object.freeze([
        'visits', 'visit_services', 'invoices', 'invoice_items', 'payments', 'pay_refund_releases',
    ]) }),
    // «Мой день» (дашборд врача): визиты и строки дня, счёт и оплата (заработок),
    // возврат строки. Не чаще раза в 20 с.
    cabinetDay: Object.freeze({ minIntervalMs: 20000, tables: Object.freeze([
        'visits', 'visit_services', 'invoices', 'payments', 'pay_refund_releases',
    ]) }),
    // Лаборатория: результаты, строки анализов (новый заказ, статус), оплата (касса
    // отпускает пробу), возврат строки.
    laboratory: Object.freeze({ minIntervalMs: 3000, tables: Object.freeze([
        'lab_results', 'visit_services', 'invoices', 'invoice_items', 'payments', 'pay_refund_releases',
    ]) }),
    // Процедуры: кабинетные (visit_services) и палатные (admission_services), возврат
    // строки; визит — его отмена уводит строку из очереди.
    procedures: Object.freeze({ minIntervalMs: 3000, tables: Object.freeze([
        'visit_services', 'admission_services', 'pay_refund_releases', 'visits',
    ]) }),
});

/**
 * Предикат экрана: true, если изменение его касается. Сброс («могло измениться
 * всё»: перезапуск сервера, долгий обрыв) касается всех.
 * @param {string} screen ключ LIVE_RELEVANCE
 * @returns {(change: {tables?: string[], rpc?: string[], reset?: boolean}) => boolean}
 */
export function liveRelevant(screen) {
    const rule = LIVE_RELEVANCE[screen];
    const set = new Set(rule ? rule.tables : []);
    return (change) => {
        if (!change || typeof change !== 'object') return false;
        if (change.reset === true) return true;
        return Array.isArray(change.tables) && change.tables.some((t) => set.has(t));
    };
}
