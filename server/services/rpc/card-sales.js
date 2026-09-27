// CARD_SALE_V1 (владелец, 2026-09-27, B2) — ПРОДАЖА ПОДАРОЧНЫХ КАРТ И
// СЕРТИФИКАТОВ В КАССЕ.
//
// Владелец: продажа карты — настоящая продажа. До этой версии карту заводил
// админ в настройках, и деньги за неё нигде не проходили.
//
// Модель — зеркало депозита (DEPOSIT_REVENUE_V1):
//   • «Продать карту» (sell_card) одной транзакцией создаёт счёт
//     CARD-<буква здания>-<ГГ>-<00001> со строкой «Подарочная карта …» /
//     «Сертификат …» (без услуги и без визита), платёж на ВЕСЬ номинал способом
//     наличные / карта / перевод / эквайринг в смену кассира и саму карту
//     (patient_discounts) — активную, с остатком = номинал. Карта не бывает
//     «продана, но не оплачена»: счёт рождается оплаченным, или ничего нет.
//   • Продажа — ПРИХОД дня: касса, смена, X-отчёт, дашборд, отчёт кассира
//     считают её платёж как любой другой. Погашение картой (способ gift_card)
//     приходом не считается (shared/payment-methods.js) — одни деньги один раз.
//   • Отчёты по СТРОКАМ счетов (выручка по услугам, отчёт владельца) счёт
//     продажи не считают — как DEP- (reports.js NOT_DEPOSIT_INVOICE_SQL):
//     услуга, оплаченная картой, попадёт туда своей строкой при погашении.
//   • Счёт CARD- обычной оплатой, возвратом, балансом и другой картой не
//     трогается (domain/wallet.js moneyDocRefusal); кэшбэка не даёт.
//   • «Вернуть остаток» (refund_card_sale) — только неизрасходованный остаток,
//     целиком, тем же способом, каким продали; карта выключается. Потраченная
//     часть — выручка за оказанные услуги, её не возвращают. Счёт продажи
//     остаётся оплаченным на потраченную часть (или «возврат», если карта не
//     тратилась) — не «частично», иначе касса показывала бы долг, которого нет.
//   • Покупатель — пациент (invoices.patient_id NOT NULL); сама карта — на
//     предъявителя (решение владельца), платить ею может любой пациент.
//   • Карта, заведённая в настройках, — «выдана без оплаты» (промо / подарок
//     клиники): sale_invoice_id NULL, в приход не попадает, через кассу не
//     возвращается.

import { hasAnyRole } from '../roles.js';
import { ensureOpenShift } from './cashier.js';
import { branchLetter, assertOwnBuilding } from './billing.js';
import { CARD_KINDS } from '../domain/cards.js';
import { today as localToday } from '../domain/day.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const SALE_ROLES = ['admin', 'cashier'];
// Способы, которыми карту ПОКУПАЮТ: только новые деньги. С баланса и другой
// картой карту не купить — это перекладывание уже учтённых денег.
const SALE_METHODS = ['cash', 'card', 'transfer', 'acquiring'];
const KIND_RU = { gift_card: 'Подарочная карта', certificate: 'Сертификат' };
const MAX_MONEY = 1e12;
const round2 = (n) => Math.round(n * 100) / 100;
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function requireRole(user, allowed) {
  if (!hasAnyRole(user, allowed)) throw new RpcError('Your role is not allowed to perform this action.', 403);
}
function actorName(user) { return String((user && (user.full_name || user.username)) || ''); }

// CARD-<буква здания>-<ГГ>-<00001> — как nextInvoiceNumber / nextDepositNumber:
// номер становится номером счёта, живёт в том же UNIQUE-индексе и ездит между
// зданиями вместе со счётом, поэтому буква здания обязательна.
export function nextCardSaleNumber(db) {
  const year4 = db.prepare("SELECT strftime('%Y','now') AS y").get().y;
  const letter = branchLetter(db);
  db.prepare('INSERT INTO card_sale_counters (year, next_seq) VALUES (?, 1) ON CONFLICT(year) DO NOTHING').run(year4);
  const seq = db.prepare('SELECT next_seq FROM card_sale_counters WHERE year = ?').get(year4).next_seq;
  db.prepare('UPDATE card_sale_counters SET next_seq = next_seq + 1 WHERE year = ?').run(year4);
  return `CARD-${letter}-${year4.slice(-2)}-${String(seq).padStart(5, '0')}`;
}

export function sellCard(db, args, user) {
  requireRole(user, SALE_ROLES);
  const a = args || {};
  const kind = a.kind === undefined || a.kind === null ? 'gift_card' : a.kind;
  if (!CARD_KINDS.includes(kind)) throw new RpcError('Вид карты: подарочная карта или сертификат.', 400);
  const amount = a.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || round2(amount) <= 0 || amount > MAX_MONEY) {
    throw new RpcError('Укажите номинал карты — положительную сумму.', 400);
  }
  const face = round2(amount);
  const method = a.method;
  if (!SALE_METHODS.includes(method)) {
    throw new RpcError('Укажите способ оплаты карты: наличные, карта, перевод или эквайринг.', 400);
  }
  if (!isPositiveInt(a.patient_id)) throw new RpcError('Выберите покупателя — пациента, на которого оформляется продажа.', 400);
  const validFrom = a.valid_from ? String(a.valid_from).slice(0, 10) : null;
  const validUntil = a.valid_until ? String(a.valid_until).slice(0, 10) : null;
  if ((validFrom && !isYmd(validFrom)) || (validUntil && !isYmd(validUntil))) {
    throw new RpcError('Срок действия — дата в виде ГГГГ-ММ-ДД.', 400);
  }
  if (validFrom && validUntil && validUntil < validFrom) throw new RpcError('Срок действия: «по» раньше «с».', 400);
  const name = String(a.name || '').trim().slice(0, 120);
  const note = String(a.note || '').trim().slice(0, 500);

  const run = db.transaction(() => {
    const patient = db.prepare('SELECT id, branch_id FROM patients WHERE id = ?').get(a.patient_id);
    if (!patient) throw new RpcError('Покупатель не найден.', 400);
    if (validUntil && validUntil < localToday(db)) throw new RpcError('Срок действия карты уже истёк — проверьте дату «по».', 400);
    const shiftId = ensureOpenShift(db, user).id;
    const number = nextCardSaleNumber(db);
    const label = KIND_RU[kind] + ' ' + number + (name ? ' «' + name + '»' : '');
    const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') n").get().n;
    // cashback_evaluated_at — продажа карты кэшбэк не даёт и оценке не подлежит.
    const invoiceId = db.prepare(`
      INSERT INTO invoices (invoice_number, visit_id, patient_id, branch_id, subtotal, discount_amount,
                            total_amount, paid_amount, status, created_by, paid_at, cashback_evaluated_at)
      VALUES (?, NULL, ?, ?, ?, 0, ?, ?, 'paid', ?, ?, ?)`)
      .run(number, patient.id, patient.branch_id || null, face, face, face, user.id, now, now).lastInsertRowid;
    db.prepare(`INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total)
                VALUES (?, NULL, ?, 1, ?, ?)`).run(invoiceId, label, face, face);
    db.prepare(`INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
                VALUES (?, ?, ?, ?, ?, ?)`).run(invoiceId, face, method, user.id, shiftId, 'Продажа карты ' + number);
    const cardId = db.prepare(`
      INSERT INTO patient_discounts (name, kind, percent, amount, active, valid_from, valid_until, note,
                                     sale_invoice_id, sale_number)
      VALUES (?, ?, 0, ?, 1, ?, ?, ?, ?, ?)`)
      .run(name || (KIND_RU[kind] + ' ' + number), kind, face, validFrom, validUntil,
        note || ('Продана в кассе: ' + actorName(user)), invoiceId, number).lastInsertRowid;
    return {
      card: db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(cardId),
      invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId),
    };
  });
  return run.immediate();
}

export function refundCardSale(db, args, user) {
  requireRole(user, SALE_ROLES);
  const a = args || {};
  if (!isPositiveInt(a.card_id)) throw new RpcError('Выберите карту.', 400);
  const reason = String(a.reason || '').trim().slice(0, 300);

  const run = db.transaction(() => {
    const card = db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(a.card_id);
    if (!card || !CARD_KINDS.includes(card.kind)) throw new RpcError('Карта не найдена.', 400);
    if (!card.sale_invoice_id) {
      throw new RpcError('Карта выдана без оплаты (заведена в настройках) — денег за неё не брали, возвращать нечего. Выключите её в настройках.', 400);
    }
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(card.sale_invoice_id);
    if (!inv) throw new RpcError('Счёт продажи карты не найден.', 400);
    assertOwnBuilding(db, inv, 'Счёт продажи карты');
    const sale = db.prepare('SELECT * FROM payments WHERE invoice_id = ? AND amount > 0 ORDER BY id LIMIT 1').get(inv.id);
    if (!sale) throw new RpcError('По счёту продажи нет платежа — возвращать нечего.', 400);
    if (db.prepare('SELECT 1 FROM payments WHERE invoice_id = ? AND amount < 0 LIMIT 1').get(inv.id)) {
      throw new RpcError('Остаток этой карты уже возвращён.', 400);
    }
    const rest = round2(Number(card.remaining) || 0);
    if (rest <= 0) {
      throw new RpcError('Карта полностью потрачена — возвращают только неизрасходованный остаток, а его нет.', 400);
    }

    const shiftId = ensureOpenShift(db, user).id;
    const number = inv.invoice_number || ('#' + inv.id);
    const refundId = db.prepare(`INSERT INTO payments (invoice_id, amount, method, cashier_id, shift_id, notes)
                                 VALUES (?, ?, ?, ?, ?, ?)`)
      .run(inv.id, -rest, sale.method, user.id, shiftId,
        'Возврат остатка карты ' + number + (reason ? ' — ' + reason : '')).lastInsertRowid;
    // Условие в самом UPDATE — параллельная оплата этой картой не проскочит
    // между чтением остатка и возвратом (как spendCard).
    const upd = db.prepare('UPDATE patient_discounts SET remaining = 0, active = 0 WHERE id = ? AND remaining = ?').run(card.id, rest);
    if (upd.changes !== 1) throw new RpcError('Остаток карты изменился — откройте возврат заново.', 409);
    db.prepare(`INSERT INTO card_ledger (discount_id, invoice_id, payment_id, amount, remaining_after, note, created_by)
                VALUES (?, ?, ?, ?, 0, ?, ?)`)
      .run(card.id, inv.id, refundId, -rest, 'Возврат остатка при возврате продажи ' + number, user.id);

    // Счёт продажи: остаётся оплаченным на потраченную часть; нетронутая карта —
    // «возврат» целиком. total уменьшается вместе с paid — иначе счёт стал бы
    // «частично оплачен», и касса показывала бы долг, которого нет.
    const kept = round2(Number(inv.paid_amount) - rest);
    if (kept <= 0) {
      db.prepare(`UPDATE invoices SET paid_amount = 0, status = 'refunded', paid_at = NULL,
                  voided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(inv.id);
    } else {
      db.prepare('UPDATE invoices SET paid_amount = ?, total_amount = ?, subtotal = ? WHERE id = ?').run(kept, kept, kept, inv.id);
      db.prepare('UPDATE invoice_items SET unit_price = ?, total = ? WHERE invoice_id = ?').run(kept, kept, inv.id);
    }
    return {
      refunded: rest,
      method: sale.method,
      card: db.prepare('SELECT * FROM patient_discounts WHERE id = ?').get(card.id),
      invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id),
    };
  });
  return run.immediate();
}

// Список карт и сертификатов для кассы: проданные (номер CARD-, покупатель,
// способ) и выданные без оплаты. Промокоды — не карты, их здесь нет.
export function listCardSales(db, args, user) {
  requireRole(user, SALE_ROLES);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.kind, d.amount, d.remaining, d.active, d.valid_from, d.valid_until, d.note,
           d.created_at, d.sale_invoice_id, d.sale_number,
           i.status AS sale_status, i.created_at AS sold_at,
           p.id AS buyer_id, p.full_name AS buyer_name, p.mrn AS buyer_mrn,
           (SELECT method FROM payments WHERE invoice_id = d.sale_invoice_id AND amount > 0 ORDER BY id LIMIT 1) AS sale_method,
           (SELECT COALESCE(SUM(-amount), 0) FROM payments WHERE invoice_id = d.sale_invoice_id AND amount < 0) AS refunded
      FROM patient_discounts d
      LEFT JOIN invoices i ON i.id = d.sale_invoice_id
      LEFT JOIN patients p ON p.id = i.patient_id
     WHERE d.kind IN ('gift_card', 'certificate')
     ORDER BY d.id DESC LIMIT 500`).all();
  return { rows };
}
