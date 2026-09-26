// DEPOSIT_WALLET_V1 — оплата только что выставленных счетов «с баланса»
// пациента прямо из мастера записи и калькулятора услуг.
//
// Владелец: «push to the deposit so on the next service it can be paid».
// Деньги двигает сервер (record_payment / record_payment_split, billing.js):
// он же пересчитывает баланс внутри транзакции и откажет, если его не хватает.
// Здесь — только раскладка по счетам: счета идут по порядку, каждому — не
// больше его остатка и не больше того, что осталось потратить.
//
// Чистый модуль без DOM: мастер и калькулятор зовут одну функцию, и
// «показанное в смете» не расходится с «проведённым в кассе».

import { supabase } from '../supabase.js';
import { hasActorRole } from './permissions.js';

// Кто может списывать баланс: те же роли, что у кассы (billing.js PAYMENT_ROLES).
export const STORED_VALUE_ROLES = ['admin', 'cashier'];
export function canSpendStoredValue() { return hasActorRole(STORED_VALUE_ROLES); }

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Баланс пациента с сервера (та же цифра, что в карточке и в кассе).
export async function loadPatientBalance(patientId) {
    if (!patientId) return 0;
    try {
        const { data, error } = await supabase.rpc('deposit_balance', { patient_id: Number(patientId) });
        if (error) return 0;
        return Math.max(0, Number(data && data.balance) || 0);
    } catch (_) { return 0; }
}

/**
 * Раскладка: сколько с баланса ляжет на каждый счёт. Чистая функция.
 * @param {Array<{id:number,total_amount:number,paid_amount?:number}>} invoices
 * @param {{wallet?:number}} caps — сколько можно потратить с баланса
 * @returns {Array<{invoice_id:number, tenders:Array<{method:string,amount:number}>}>}
 */
export function planStoredValue(invoices, { wallet = 0 } = {}) {
    let walletLeft = r2(Math.max(0, wallet));
    const out = [];
    for (const inv of invoices || []) {
        if (!inv || !inv.id) continue;
        const due = r2(Math.max(0, Number(inv.total_amount || 0) - Number(inv.paid_amount || 0)));
        if (due <= 0) continue;
        const tenders = [];
        const w = r2(Math.min(walletLeft, due));
        if (w > 0) { tenders.push({ method: 'wallet', amount: w }); walletLeft = r2(walletLeft - w); }
        if (tenders.length) out.push({ invoice_id: inv.id, tenders });
    }
    return out;
}

/**
 * Проводит раскладку на сервере. Возвращает { wallet, errors, invoices }:
 * сколько списано с баланса, тексты отказов сервера и обновлённые счета.
 */
export async function payFromStoredValue(invoices, caps) {
    const plan = planStoredValue(invoices, caps);
    const res = { wallet: 0, errors: [], invoices: {} };
    for (const step of plan) {
        const t = step.tenders;
        const { data, error } = t.length === 1
            ? await supabase.rpc('record_payment', { invoice_id: step.invoice_id, amount: t[0].amount, method: t[0].method, ...(t[0].card_id ? { card_id: t[0].card_id } : {}) })
            : await supabase.rpc('record_payment_split', { invoice_id: step.invoice_id, tenders: t });
        if (error) { res.errors.push(error.message || String(error)); continue; }
        for (const x of t) if (x.method === 'wallet') res.wallet = r2(res.wallet + x.amount);
        if (data && data.invoice) res.invoices[step.invoice_id] = data.invoice;
    }
    return res;
}
