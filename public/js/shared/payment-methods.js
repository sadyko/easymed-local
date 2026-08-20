// INVOICE_METHOD_COLUMN_V1 — способ оплаты: словарь + отображение.
//
// Lives in public/js/shared/ because BOTH runtimes use it — the browser for the
// «Счета» report (views/reports-export.js) and the server for the invoices_full
// report (services/rpc/reports.js). There are two invoice reports with
// byte-identical column labels; one vocabulary is what stops them printing the
// same payment two different ways. Same arrangement as shared/doc-render.js,
// which server/services/telegram/render.js already imports.
//
// Pure module (no DOM, no ui.js, no node built-ins) so it loads in both and the
// rules are unit-tested. The vocabulary is the set of methods the cashier can
// actually take — see views/cashier-desk.js, which still carries its own copy
// for its many local uses.

export const METHOD_RU = {
    cash:      'Наличные',
    card:      'Карта',
    transfer:  'Перевод',
    acquiring: 'Эквайринг',
    // DEPOSIT_REVENUE_V1 — оплата с депозитного баланса пациента.
    wallet:    'Кошелёк',
};

// DEPOSIT_REVENUE_V1 — «кошелёк» это НЕ новые деньги.
//
// Депозит признаётся выручкой в момент, когда касса взяла наличные: тогда же
// создаётся счёт депозита и платёж по нему. Когда пациент потом расплачивается
// этим балансом за услуги, деньги в клинику НЕ приходят второй раз — они уже
// пришли. Платёж «кошелёк» лишь закрывает счёт услуги.
//
// Поэтому он исключается везде, где считают ПРИХОД: выручка отчётов, «собрано
// за сегодня» на дашборде и итог смены. В ящик он не попадает и так — там
// только наличные, — но в общую сумму смены попал бы, и касса на пересчёте
// увидела бы деньги, которых при ней никто не приносил.
export const NON_CASH_INFLOW = ['wallet'];

export function countsAsInflow(method) {
    return !NON_CASH_INFLOW.includes(String(method || ''));
}

// SQL-фрагмент для тех же запросов на сервере: «это приход».
export const INFLOW_SQL = "method NOT IN ('wallet')";

// Vocabulary order — fixed, so an invoice always reads the same way no matter
// what order the payment rows came back in, and so the column sorts sensibly in
// Excel. Anything unknown is appended after the known ones, in first-seen order.
const ORDER = Object.keys(METHOD_RU);

// One invoice, one cell: every DISTINCT method that paid it.
//
// A single invoice can carry several payments with different methods
// (record_payment_split — часть наличными, часть картой), so this is a set and
// not a value. An unpaid invoice yields '' — printing a default like «Наличные»
// there would report money that never moved.
//
// An unrecognised method is shown raw rather than dropped: a payment the map
// has not learned about yet is still a real payment, and hiding it would
// silently understate how the invoice was settled.
export function formatMethods(methods) {
    if (!Array.isArray(methods)) return '';
    const seen = [];
    for (const m of methods) {
        if (typeof m !== 'string') continue;
        const key = m.trim();
        if (!key || seen.includes(key)) continue;
        seen.push(key);
    }
    if (!seen.length) return '';
    const known = ORDER.filter((k) => seen.includes(k));
    const unknown = seen.filter((k) => !Object.prototype.hasOwnProperty.call(METHOD_RU, k));
    return [...known.map((k) => METHOD_RU[k]), ...unknown].join(', ');
}
