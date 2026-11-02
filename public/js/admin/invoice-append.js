// INVOICE_APPEND_V1 (решение владельца 2026-11-02) — услуги, добавленные, пока
// счёт пациента не оплачен, ложатся В ТОТ ЖЕ СЧЁТ: create_invoice_for_visit
// дописывает их и отвечает { invoice, appended: true } (server/services/rpc/
// billing.js appendToVisitInvoice). Экран говорит об этом одной фразой —
// «Добавлено в счёт № … — новая сумма …», — одной на все двери: мастер визита,
// быстрая регистрация, калькулятор, окно визита и «Счёт визита».
import { trf } from './i18n.js';

const fmtSum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** true — ответ сервера дописал строки в уже выставленный счёт. */
export function isAppended(res) {
    return !!(res && res.appended && res.invoice);
}

/** «Добавлено в счёт № INV-A-26-00012 — новая сумма 150 000 сум» или '' (новый счёт). */
export function invoiceAppendNote(res) {
    if (!isAppended(res)) return '';
    const inv = res.invoice;
    return trf('Добавлено в счёт № {no} — новая сумма {sum} сум', {
        no: inv.invoice_number || String(inv.id),
        sum: fmtSum(inv.total_amount),
    });
}

/**
 * Скидка НОВОЙ части дописанного счёта: свои скидки её позиций (пакет) и
 * rest_discount (ручная / группа). Экран с итогом своих строк (быстрая
 * регистрация) показывает её, а не скидку всего счёта.
 */
export function appendedPartDiscount(res) {
    const items = (res && Array.isArray(res.items)) ? res.items : [];
    const own = items.reduce((s, it) => s + (Number(it && it.discount_amount) || 0), 0);
    return Math.round((own + (Number(res && res.rest_discount) || 0)) * 100) / 100;
}
