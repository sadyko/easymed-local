// LIVE_REFRESH_V1 (3.22.0, владелец 2026-11-08) — КАКОЕ ИЗМЕНЕНИЕ КАКОМУ ЭКРАНУ ВАЖНО.
//
// Сервер (server/services/live/bus.js) шлёт событие «записано» с именами таблиц и RPC.
// Экран перечитывает себя, только если записано то, что он показывает. Правила — здесь,
// одним списком: их видно целиком, и их проверяет тест (live-relevance.test.mjs), а
// сервер сверяет, что каждую таблицу отсюда он ловит (routes/live.test.js, LIVE_TABLES).
//
// Решаем по ТАБЛИЦАМ, а не по именам RPC: запись RPC база называет сама (временные
// триггеры шины), и новый RPC, выставляющий счёт, будит кассу без правки этого файла.
// Без зависимостей от DOM — модуль читают и браузер, и тесты сервера.

export const LIVE_RELEVANCE = Object.freeze({
    // Касса: счета и их строки, оплаты, возвраты, визиты и услуги («Ждут счёта»),
    // депозиты, смена и движения денег (плашка смены и плитки).
    cashier: Object.freeze({ tables: Object.freeze([
        'invoices', 'invoice_items', 'payments', 'pay_refund_releases',
        'visits', 'visit_services', 'patient_deposits', 'cash_shifts', 'cash_movements',
    ]) }),
    // Кабинет врача — «Мои приёмы» и «Мой день»: визиты и строки, счёт и оплата
    // (касса отпускает строку к осмотру), возврат строки, результаты анализов.
    cabinet: Object.freeze({ tables: Object.freeze([
        'visits', 'visit_services', 'invoices', 'invoice_items', 'payments', 'pay_refund_releases', 'lab_results',
    ]) }),
    // Лаборатория: результаты, строки анализов (новый заказ, статус), оплата (касса
    // отпускает пробу), возврат строки.
    laboratory: Object.freeze({ tables: Object.freeze([
        'lab_results', 'visit_services', 'invoices', 'invoice_items', 'payments', 'pay_refund_releases',
    ]) }),
    // Процедуры: кабинетные (visit_services) и палатные (admission_services), возврат
    // строки; визит — его отмена уводит строку из очереди.
    procedures: Object.freeze({ tables: Object.freeze([
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
