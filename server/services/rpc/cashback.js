// CASHBACK_SERVER_V2 (ре-ревью денег, 2026-09-26) — кэшбэк начисляет ОПЛАТА.
//
// История. Облачный экран (views/cashback.js) читал колонки правил, которых
// офлайн нет, и сам вставлял строку баланса — кэшбэк офлайн не начислялся
// никогда. Первый серверный вариант (дверь credit_cashback, её звало окно
// визита) ре-ревью отверг: дверь можно было звать снова после отката
// (накрутка), а касса и оплата частями её не звали вовсе.
//
// Теперь правило живёт в оплате:
//   • начисляется внутри record_payment / record_payment_split, в ту же
//     транзакцию, в момент, когда счёт СТАНОВИТСЯ оплаченным — с любого
//     экрана оплаты;
//   • только свои счета пациента: не приехавшие из филиала (их оплатить здесь
//     нельзя и так), не счёт депозита (DEP-), не счёт плательщика;
//   • ОДИН РАЗ ЗА ЖИЗНЬ СЧЁТА: любая строка кэшбэка этого счёта, в каком бы
//     она ни была статусе, запрещает следующую. Поэтому «вернуть и оплатить
//     снова» кэшбэк не множит, а потраченный кэшбэк не накрутить;
//   • база — новые деньги: платежи способами, которые считаются приходом
//     (shared/payment-methods.js, без баланса и карты), каждый — за вычетом
//     своих возвратов (REFUND#id, любым способом), не больше суммы счёта;
//   • правило — действующее с наибольшим процентом (решение владельца,
//     см. план); процент 0..100 охраняет база (мигр. 160);
//   • CASHBACK_BY_GROUP_V1 (владелец, 2026-09-27) — правило выбирается по
//     ГРУППЕ пациента (cashbackRuleFor ниже, мигр. 165);
//   • возврат откатывает кэшбэк пропорционально возвращённому, но не больше,
//     чем осталось на балансе: потраченное уже ушло в услуги;
//   • задним числом не начисляется: счета, оплаченные до этой версии,
//     кэшбэка не получают.

import { walletBalance, withLedgerToken } from '../domain/wallet.js';
import { NON_CASH_INFLOW } from '../../../public/js/shared/payment-methods.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Новые деньги по счёту: приходные платежи за вычетом их собственных возвратов.
export function cashbackBase(db, invoice) {
  const skip = NON_CASH_INFLOW.map(() => '?').join(',');
  const pays = db.prepare(`SELECT id, amount FROM payments WHERE invoice_id = ? AND amount > 0 AND method NOT IN (${skip})`)
    .all(invoice.id, ...NON_CASH_INFLOW);
  const refundedOf = db.prepare("SELECT COALESCE(SUM(-amount), 0) s FROM payments WHERE amount < 0 AND (notes = ? OR notes LIKE ?)");
  let base = 0;
  for (const p of pays) {
    const tag = 'REFUND#' + p.id;
    base += Math.max(0, Number(p.amount) - Number(refundedOf.get(tag, tag + ' %').s || 0));
  }
  return round2(Math.max(0, Math.min(base, Number(invoice.total_amount) || 0)));
}

// CASHBACK_BY_GROUP_V1 — какое правило действует для пациента.
//   • у пациента есть группа, и у группы есть ДЕЙСТВУЮЩЕЕ правило — только
//     правила группы (наибольший процент). Правило группы с 0 % — явное «этой
//     группе кэшбэка нет»: общее правило его не перебивает;
//   • иначе (группы нет или у неё нет правил) — правила «для всех»
//     (category_id IS NULL), наибольший процент. Старые правила — «для всех».
export function cashbackRuleFor(db, patientId) {
  const p = patientId ? db.prepare('SELECT category_id FROM patients WHERE id = ?').get(patientId) : null;
  const cat = p && p.category_id != null ? p.category_id : null;
  if (cat != null) {
    const own = db.prepare('SELECT * FROM cashback_rules WHERE active = 1 AND category_id = ? ORDER BY percent DESC, id LIMIT 1').get(cat);
    if (own) return own;
  }
  return db.prepare('SELECT * FROM cashback_rules WHERE active = 1 AND category_id IS NULL ORDER BY percent DESC, id LIMIT 1').get() || null;
}

function anyCashback(db, invoiceId) {
  return db.prepare("SELECT * FROM patient_deposits WHERE kind = 'cashback' AND invoice_id = ? ORDER BY id LIMIT 1").get(invoiceId);
}

// Зовут record_payment / record_payment_split, когда счёт стал оплаченным.
export function creditCashbackOnPaid(db, invoice, user) {
  if (!invoice) return 0;
  // Третья проверка, I1 — счёт оценивается ОДИН раз, при первой полной оплате,
  // при любом исходе; «вернуть 1, оплатить 1» старый счёт не переоценит.
  if (invoice.cashback_evaluated_at) return 0;
  db.prepare("UPDATE invoices SET cashback_evaluated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND cashback_evaluated_at IS NULL").run(invoice.id);
  if (!invoice.patient_id || invoice.payer_id || invoice.sync_origin != null) return 0;
  if (String(invoice.invoice_number || '').startsWith('DEP-')) return 0;
  if (String(invoice.invoice_number || '').startsWith('CARD-')) return 0;   // CARD_SALE_V1 — продажа карты не услуга
  if (anyCashback(db, invoice.id)) return 0;   // один раз за жизнь счёта
  const rule = cashbackRuleFor(db, invoice.patient_id);   // CASHBACK_BY_GROUP_V1
  if (!rule || !(Number(rule.percent) > 0)) return 0;
  const base = cashbackBase(db, invoice);
  // Третья проверка, M1 — начисление вниз, откат вверх: округление не дарит.
  const amount = Math.floor(base * Math.min(100, Number(rule.percent)) / 100 + 1e-9);
  if (amount <= 0) return 0;
  withLedgerToken(db, () => db.prepare(`INSERT INTO patient_deposits
      (patient_id, branch_id, amount, method, status, kind, invoice_id, cashback_base, notes,
       created_by, created_by_name, received_by, received_by_name, received_at)
    VALUES (?, ?, ?, 'cashback', 'received', 'cashback', ?, ?, ?, ?, 'Cashback', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(invoice.patient_id, invoice.branch_id || null, amount, invoice.id, base,
      `Кэшбэк ${rule.percent}% («${rule.name || ''}») со счёта ${invoice.invoice_number || invoice.id} · cashback:${invoice.id}`,
      user.id, user.id, String(user.full_name || user.username || '')));
  return amount;
}

// Зовёт refund_payment после каждого возврата: кэшбэк должен соответствовать
// тому, что по счёту осталось новых денег.
export function adjustCashbackAfterRefund(db, invoice) {
  const cb = anyCashback(db, invoice.id);
  if (!cb || !(Number(cb.cashback_base) > 0)) return 0;
  const base0 = Number(cb.cashback_base);
  const now = cashbackBase(db, invoice);
  // Третья проверка, I3 + M1 — откат ВСЕГДА полный (вверх): если кэшбэк уже
  // потрачен, журнал баланса уходит в минус, баланс показывается нулём, и долг
  // закрывают будущие зачисления. Прежде недостача прощалась.
  const clawTotal = Math.min(Number(cb.amount),
    Math.ceil(Number(cb.amount) * (base0 - Math.min(now, base0)) / base0 - 1e-9));
  const extra = round2(clawTotal - (Number(cb.refund_amount) || 0));
  if (extra <= 0) return 0;
  const owed = round2(Math.max(0, extra - walletBalance(db, cb.patient_id)));
  withLedgerToken(db, () => db.prepare(`UPDATE patient_deposits SET status = 'refunded', refund_amount = ?, reason = ?,
                closed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .run(clawTotal, 'Возврат по счёту ' + (invoice.invoice_number || invoice.id)
      + (owed > 0 ? ` — ${owed} кэшбэка уже потрачено: долг баланса, закроется будущими зачислениями` : ''), cb.id));
  return extra;
}
