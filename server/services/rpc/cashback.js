// CASHBACK_SERVER_V1 (ревью I4, 2026-09-26) — кэшбэк начисляет СЕРВЕР.
//
// Раньше начисление жило в браузере (views/cashback.js): оно читало облачные
// колонки правил (cashback_percent, min_purchase, …), которых в офлайн-схеме
// нет, и вставляло строку patient_deposits напрямую. Ревью денег нашло две
// беды: база кэшбэка исключала только облачный способ 'deposit', то есть
// оплата балансом и картой приносила кэшбэк, а «вернуть на баланс и оплатить
// снова» — дважды; и строку баланса мог вставить любой клиент.
//
// Правило теперь одно и здесь:
//   • правило — действующая строка cashback_rules с наибольшим процентом
//     (офлайн у правила есть только name / percent / active);
//   • база — ПРИХОД по счёту: платежи способами, которые считаются новыми
//     деньгами (shared/payment-methods.js), за вычетом их возвратов. Баланс и
//     карта — не новые деньги, кэшбэка с них нет;
//   • один кэшбэк на счёт: строка kind = 'cashback', invoice_id = счёт;
//   • возврат, после которого счёт уже не оплачен целиком, откатывает кэшбэк
//     (reverseCashback, зовёт refund_payment) — столько, сколько осталось на
//     балансе: потраченное уже ушло в услуги и назад не вынимается.
//
// Кто зовёт: окно визита после полной оплаты (как и раньше). Права — касса и
// админ, как у оплаты.

import { hasAnyRole } from '../roles.js';
import { walletBalance } from '../domain/wallet.js';
import { NON_CASH_INFLOW } from '../../../public/js/shared/payment-methods.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ROLES = ['admin', 'cashier'];
const round2 = (n) => Math.round(n * 100) / 100;

function activeCashback(db, invoiceId) {
  return db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' AND invoice_id = ? AND status = 'received'").get(invoiceId);
}

export function creditCashback(db, args, user) {
  if (!hasAnyRole(user, ROLES)) throw new RpcError('Your role is not allowed to perform this action.', 403);
  const invoiceId = args && args.invoice_id;
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) throw new RpcError('invoice_id must be a positive integer.', 400);

  return db.transaction(() => {
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw new RpcError('invoice not found.', 400);
    if (inv.status !== 'paid' || !inv.patient_id || inv.payer_id) return { credited: 0 };
    if (String(inv.invoice_number || '').startsWith('DEP-')) return { credited: 0 };   // предоплата — не покупка
    if (activeCashback(db, inv.id)) return { credited: 0 };

    const rule = db.prepare('SELECT * FROM cashback_rules WHERE active = 1 AND percent > 0 ORDER BY percent DESC, id LIMIT 1').get();
    if (!rule) return { credited: 0 };

    const skip = NON_CASH_INFLOW.map(() => '?').join(',');
    const base = round2(Math.max(0, db.prepare(`SELECT COALESCE(SUM(amount), 0) s FROM payments
                                                WHERE invoice_id = ? AND method NOT IN (${skip})`).get(inv.id, ...NON_CASH_INFLOW).s));
    const amount = Math.round(base * Math.min(100, Number(rule.percent)) / 100);
    if (amount <= 0) return { credited: 0 };

    db.prepare(`INSERT INTO patient_deposits
                  (patient_id, branch_id, amount, method, status, kind, invoice_id, notes,
                   created_by, created_by_name, received_by, received_by_name, received_at)
                VALUES (?, ?, ?, 'cashback', 'received', 'cashback', ?, ?, ?, 'Cashback', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
      .run(inv.patient_id, inv.branch_id || null, amount, inv.id,
        `Кэшбэк ${rule.percent}% со счёта ${inv.invoice_number || inv.id} · cashback:${inv.id}`,
        user.id, user.id, String(user.full_name || user.username || ''));
    return { credited: amount, percent: Number(rule.percent) };
  })();
}

// Зовёт refund_payment внутри своей транзакции, когда счёт перестал быть
// оплаченным целиком.
export function reverseCashback(db, invoice, user) {
  const cb = activeCashback(db, invoice.id);
  if (!cb) return 0;
  const claw = round2(Math.min(Number(cb.amount) || 0, walletBalance(db, cb.patient_id)));
  db.prepare(`UPDATE patient_deposits SET status = 'refunded', refund_amount = ?, reason = ?,
                closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .run(claw, 'Возврат по счёту ' + (invoice.invoice_number || invoice.id)
      + (claw < cb.amount ? ` — снято ${claw} из ${cb.amount}, остальное уже потрачено` : ''), cb.id);
  return claw;
}
