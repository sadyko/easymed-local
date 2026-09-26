// CARD_BALANCE_V1 — подарочные карты и сертификаты с остатком.
//
// Владелец: «amount should be set». Карта — это хранимые деньги, а не скидка:
// номинал задают при выпуске (patient_discounts.amount), остаток
// (patient_discounts.remaining, миграция 158) уменьшается с каждой оплатой и
// возвращается при возврате платежа. Раньше карта была скидкой на полную сумму
// с КАЖДОГО визита до конца срока.
//
// Оплата картой — способ 'gift_card' (payments), каждое движение остатка —
// строка card_ledger (−списание / +возврат) со ссылкой на платёж. Списание и
// возврат вызываются ТОЛЬКО внутри транзакции вызывающего (record_payment /
// record_payment_split / refund_payment): платёж и остаток меняются вместе.

import { today as localToday } from './day.js';
import { isDepositInvoice, DEPOSIT_INVOICE_REFUSAL } from './wallet.js';

export class CardError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export const CARD_KINDS = ['gift_card', 'certificate'];
const KIND_RU = { gift_card: 'Подарочная карта', certificate: 'Сертификат' };
const round2 = (n) => Math.round(n * 100) / 100;

function ruDay(ymd) {
  const s = String(ymd || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) : s;
}

function loadCard(db, cardId) {
  if (!Number.isInteger(cardId) || cardId <= 0) throw new CardError('Выберите карту или сертификат.');
  const card = db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(cardId);
  if (!card || !CARD_KINDS.includes(card.kind)) throw new CardError('Карта или сертификат не найдены.');
  return card;
}

// Сколько этой картой можно заплатить по ЭТОМУ счёту: остаток, срок, группа
// пациента и услуги карты (как у скидок, discount-rules.js). Отказ — по-русски.
function spendableOn(db, card, invoice) {
  const name = (KIND_RU[card.kind] || 'Карта') + ' «' + (card.name || card.id) + '»';
  if (!card.active) throw new CardError(name + ': использование выключено в настройках.');
  const today = localToday(db);   // местный день клиники, как у скидок
  const from = String(card.valid_from || '').slice(0, 10);
  const until = String(card.valid_until || '').slice(0, 10);
  if (from && from > today) throw new CardError(name + ' действует с ' + ruDay(from) + '.');
  if (until && until < today) throw new CardError(name + ': срок истёк ' + ruDay(until) + '.');
  const remaining = round2(Number(card.remaining) || 0);
  if (remaining <= 0) throw new CardError(name + ': остаток 0 — карта исчерпана.');
  if (card.category_id != null) {
    const p = invoice.patient_id ? db.prepare('SELECT category_id FROM patients WHERE id = ?').get(invoice.patient_id) : null;
    if (!p || Number(p.category_id) !== Number(card.category_id)) {
      throw new CardError(name + ' — только для другой группы пациентов.');
    }
  }
  let scope = [];
  try { scope = JSON.parse(card.service_ids || '[]'); } catch { scope = []; }
  scope = (Array.isArray(scope) ? scope : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  let cap = Infinity;
  if (scope.length) {
    // Карта на отдельные услуги платит только за них: строки счёта после их
    // собственной скидки. Скидка счёта сверху (ручная/группы) здесь не
    // делится по строкам — потолок чуть выше, но не выше суммы счёта.
    const r = db.prepare(`SELECT COALESCE(SUM(total - COALESCE(discount_amount, 0)), 0) s FROM invoice_items
                           WHERE invoice_id = ? AND service_id IN (${scope.map(() => '?').join(',')})`).get(invoice.id, ...scope);
    const scoped = round2(Number(r.s) || 0);
    if (scoped <= 0) throw new CardError(name + ' действует на другие услуги — в этом счёте их нет.');
    // Ревью I3 — то, что ЭТА карта уже заплатила по ЭТОМУ счёту (списания
    // минус возвраты по журналу), из потолка вычитается: иначе три оплаты по
    // 50 закрывали услугу за 100. Две части одной оплаты частями видят друг
    // друга — журнал пишется в той же транзакции.
    const spent = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM card_ledger WHERE discount_id = ? AND invoice_id = ?').get(card.id, invoice.id).s;
    cap = round2(Math.max(0, scoped + Number(spent || 0)));
  }
  return { name, remaining, cap };
}

// Оплата счёта картой. amount уже округлён вызывающим.
export function spendCard(db, { cardId, invoice, paymentId, amount, user }) {
  if (isDepositInvoice(db, invoice)) throw new CardError(DEPOSIT_INVOICE_REFUSAL);   // ревью C1
  const card = loadCard(db, cardId);
  const { name, remaining, cap } = spendableOn(db, card, invoice);
  if (amount > remaining) throw new CardError(`${name}: на карте осталось ${remaining} — списать ${amount} нельзя.`);
  if (amount > cap) throw new CardError(`${name} оплачивает только свои услуги: не больше ${cap} по этому счёту.`);
  // Условие в самом UPDATE — второй кассир с той же картой не уведёт остаток в
  // минус, даже если прочитал его раньше (CHECK remaining >= 0 — последняя
  // стена, миграция 158).
  const r = db.prepare('UPDATE patient_discounts SET remaining = ROUND(remaining - ?, 2) WHERE id = ? AND remaining >= ?')
    .run(amount, card.id, amount);
  if (r.changes !== 1) throw new CardError(`${name}: остаток изменился — откройте оплату заново.`);
  const after = db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(card.id).remaining;
  db.prepare(`INSERT INTO card_ledger (discount_id, invoice_id, payment_id, amount, remaining_after, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(card.id, invoice.id, paymentId, -amount, after,
      'Оплата счёта ' + (invoice.invoice_number || ('#' + invoice.id)), user.id);
  return after;
}

// Карта, которой заплачен платёж (по журналу): возврат идёт на неё же.
export function cardOfPayment(db, paymentId) {
  const row = db.prepare('SELECT discount_id FROM card_ledger WHERE payment_id = ? AND amount < 0 ORDER BY id LIMIT 1').get(paymentId);
  return row ? row.discount_id : null;
}

// Возврат платежа картой — на ту же карту. Выключенная или истёкшая карта
// деньги всё равно получает обратно: это её остаток, а не новая оплата.
export function returnToCard(db, { paymentId, refundPaymentId, invoice, amount, user }) {
  const cardId = cardOfPayment(db, paymentId);
  if (!cardId) throw new CardError('Не найдена карта, которой оплачен этот платёж.');
  db.prepare('UPDATE patient_discounts SET remaining = ROUND(COALESCE(remaining, 0) + ?, 2) WHERE id = ?').run(amount, cardId);
  const after = db.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(cardId).remaining;
  db.prepare(`INSERT INTO card_ledger (discount_id, invoice_id, payment_id, amount, remaining_after, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(cardId, invoice.id, refundPaymentId, amount, after,
      'Возврат по счёту ' + (invoice.invoice_number || ('#' + invoice.id)), user.id);
  return { card_id: cardId, remaining: after };
}
