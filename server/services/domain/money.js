// INVOICE_TRUTH_V1 — the one definition of an invoice's settlement state.
//
// The paid/partial/unpaid ladder was written out by hand in record_payment,
// record_payment_split and refund_payment. Three copies of one rule is three
// chances for them to drift, and drift is invisible until the money is wrong.
//
// Rule: no module derives an invoice status or an "is this still owed" filter
// for itself. It calls in here.

import { createHash } from 'node:crypto';

// Settlement state implied by the amounts, plus the status the invoice is
// coming FROM (some states are sticky).
//
// DEBT_STICKY_V2 — an invoice parked as «Оставить как долг» keeps that mark
// while it is only part-paid. The old amount-only ladder turned it into
// 'partial' on the first instalment, so the arrangement the cashier recorded
// disappeared from the Долг chip the moment the patient paid anything towards
// it. Paying it off in full still settles it to 'paid', and the money was never
// affected either way — both statuses are outstanding (see below).
export function invoiceStatusFor(totalAmount, paidAmount, fromStatus = null) {
  if (paidAmount >= totalAmount) return 'paid';
  if (fromStatus === 'debt') return 'debt';
  return paidAmount > 0 ? 'partial' : 'unpaid';
}

// Statuses that still represent money the clinic is owed.
//
// 'debt' belongs here: mark_invoice_debt exists precisely to record that the
// patient will pay later. Leaving it out (as the dashboard and the reports
// overview both did) meant pressing «Оставить как долг» erased the debt from
// every management figure while the cashier's own chips still counted it.
export const OUTSTANDING_STATUSES = ['unpaid', 'partial', 'debt'];

// SQL fragment: "this invoice is still owed". Inlined rather than bound because
// the list is a fixed constant, never client input.
export function outstandingWhere(col = 'status') {
  return `${col} IN (${OUTSTANDING_STATUSES.map((s) => `'${s}'`).join(',')})`;
}

// V3120_FIX (MAJOR) — КЛЮЧ ПОВТОРА ДЕНЕЖНОЙ ОПЕРАЦИИ (миграция 193).
//
// record_payment, record_payment_split, refund_payment, sell_card,
// create_deposit, refund_deposit и cash_move принимают необязательный
// `idempotency_key` — случайную строку, которую экран кладёт в форму (тот же
// формат, что у выдачи со склада, procurement.js). Первая операция пишет
// квитанцию В СВОЕЙ ТРАНЗАКЦИИ (idemRemember), повтор с тем же ключом получает
// сохранённый ответ с repeated: true и ничего не двигает (idemReplay). Ключ,
// занятый другой операцией, — отказ 409. Ключ не того вида молча не действует
// (как у склада): старые экраны его не присылают вовсе.
export const IDEM_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function idemKeyOf(args) {
  const k = args && args.idempotency_key;
  return typeof k === 'string' && IDEM_KEY_RE.test(k) ? k : null;
}

export class IdempotencyError extends Error {
  constructor(msg, status = 409) { super(msg); this.status = status; }
}

// V3120_FINAL (I1, мигр. 213) — ОТПЕЧАТОК ФОРМЫ. Квитанция отвечает на повтор,
// только если форма та же: sha256 канонического JSON аргументов (ключи
// объектов по алфавиту, на любой глубине; порядок массивов — как есть) без
// самого ключа повтора. Тот же ключ с другой суммой, способом или разбивкой —
// отказ 409, а не чужая квитанция: иначе остаток оплаты, отправленный из того
// же окна после удачной первой части, «принимался» без денег.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map((x) => canonical(x === undefined ? null : x)).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
export function idemFingerprint(args) {
  const rest = { ...(args || {}) };
  delete rest.idempotency_key;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

const IDEM_KEY_TAKEN = 'Этот ключ повтора уже использован другой операцией — обновите окно и повторите.';

export function idemReplay(db, rpc, args) {
  const key = idemKeyOf(args);
  if (!key) return null;
  const row = db.prepare('SELECT rpc, result, fingerprint FROM money_idempotency WHERE key = ?').get(key);
  if (!row) return null;
  if (row.rpc !== rpc) {
    throw new IdempotencyError(IDEM_KEY_TAKEN);
  }
  // Квитанция без отпечатка записана до мигр. 213 — сверяется, как прежде.
  if (row.fingerprint != null && row.fingerprint !== idemFingerprint(args)) {
    throw new IdempotencyError(IDEM_KEY_TAKEN);
  }
  try { return { ...JSON.parse(row.result), repeated: true }; } catch { return { repeated: true }; }
}

export function idemRemember(db, rpc, args, user, result) {
  const key = idemKeyOf(args);
  if (!key) return result;
  db.prepare('INSERT INTO money_idempotency (key, rpc, user_id, result, fingerprint) VALUES (?, ?, ?, ?, ?)')
    .run(key, rpc, (user && user.id) || null, JSON.stringify(result), idemFingerprint(args));
  return result;
}
