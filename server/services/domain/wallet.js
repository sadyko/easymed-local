// DEPOSIT_WALLET_V1 — баланс пациента: одна формула и две записи в журнал.
//
// Журнал — patient_deposits (миграции 024, 071, 157). Баланс считается из строк
// КАЖДЫЙ раз, а не хранится числом рядом: число рядом с журналом расходится с
// ним на первой же ошибке, а журнал — это и есть объяснение числа.
//
//   received  (+amount)                   — принятый депозит, зачисление, кэшбэк;
//   refunded  (+amount − refund_amount)   — депозит, частично выданный назад;
//   spent     (−amount)                   — оплата счёта с баланса.
//
// Списание и зачисление вызываются ТОЛЬКО внутри транзакции вызывающего
// (record_payment / record_payment_split / refund_payment): платёж и строка
// журнала либо появляются обе, либо ни одной.

export class WalletError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const round2 = (n) => Math.round(n * 100) / 100;

// Ре-ревью п.5 — СТРОКИ БАЛАНСА С ДЕНЬГАМИ ВСТАВЛЯЕТ ТОЛЬКО СЕРВЕР. Триггеры
// миграции 160 пропускают вставку зачисления/списания/кэшбэка и перевод
// депозита в «принят» только пока в ledger_write_token лежит строка, которую
// серверная дверь кладёт на время своей записи и тут же убирает (в той же
// транзакции). Вложенные вызовы безопасны: у каждого своя строка.
export function withLedgerToken(db, fn) {
  // Третья проверка, M3 — только внутри транзакции: иначе разрешение пережило
  // бы сбой между вставкой и удалением и открыло бы журнал для всех.
  if (!db.inTransaction) throw new Error('withLedgerToken: запись баланса только внутри транзакции.');
  const id = db.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run().lastInsertRowid;
  try { return fn(); } finally { db.prepare('DELETE FROM ledger_write_token WHERE id = ?').run(id); }
}

// Сырая сумма журнала — может быть МЕНЬШЕ нуля: откат кэшбэка, который
// пациент уже потратил, не прощается (третья проверка, I3), а ждёт будущих
// зачислений. Экраны и списания видят walletBalance — не меньше нуля.
export function walletRaw(db, patientId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE
             WHEN status = 'received' THEN amount
             WHEN status = 'refunded' THEN amount - COALESCE(refund_amount, 0)
             WHEN status = 'spent'    THEN -amount
             ELSE 0 END), 0) AS b
      FROM patient_deposits WHERE patient_id = ?`).get(patientId);
  return round2(Number(r.b) || 0);
}

// Кэшбэк на балансе, ещё не откаченный: это не деньги пациента, наличными он
// не выдаётся (третья проверка, I2).
export function outstandingCashback(db, patientId) {
  const r = db.prepare(`SELECT COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0) s FROM patient_deposits
                         WHERE patient_id = ? AND kind = 'cashback' AND status IN ('received', 'refunded')`).get(patientId);
  return round2(Number(r.s) || 0);
}

export function walletBalance(db, patientId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE
             WHEN status = 'received' THEN amount
             WHEN status = 'refunded' THEN amount - COALESCE(refund_amount, 0)
             WHEN status = 'spent'    THEN -amount
             ELSE 0 END), 0) AS b
      FROM patient_deposits WHERE patient_id = ?`).get(patientId);
  return round2(Math.max(0, Number(r.b) || 0));
}

// Счёт, созданный приёмом депозита (DEP-…). Оплачивать его балансом или
// возвращать его платёж «на баланс» бессмысленно — это и есть сам баланс.
//
// Ревью C1 — признаков два: строка депозита в ЭТОМ здании (patient_deposits не
// ездит) и номер DEP-… (номер депозита становится номером счёта и ездит с ним).
export function isDepositInvoice(db, invoiceOrId) {
  const inv = typeof invoiceOrId === 'object' && invoiceOrId
    ? invoiceOrId : db.prepare('SELECT id, invoice_number FROM invoices WHERE id = ?').get(invoiceOrId);
  if (!inv) return false;
  if (String(inv.invoice_number || '').startsWith('DEP-')) return true;
  return !!db.prepare("SELECT 1 FROM patient_deposits WHERE invoice_id = ? AND kind = 'deposit' LIMIT 1").get(inv.id);
}

// Ревью C1 — деньги счёта депозита двигают ТОЛЬКО «Принять депозит» и «Вернуть
// депозит» (rpc/deposits.js): они же ведут строку депозита. Возврат его
// платежа через refund_payment выдавал деньги, не трогая депозит, — и
// refund_deposit потом выдавал их второй раз.
export const DEPOSIT_INVOICE_REFUSAL =
  'Это счёт депозита — его деньги принимает и возвращает только кнопка «Вернуть депозит» в разделе «Депозиты» кассы.';

function actorName(user) {
  return String((user && (user.full_name || user.username)) || '');
}

// Оплата счёта с баланса. amount уже округлён вызывающим. Баланс читается
// ВНУТРИ транзакции: два кассира, тратящие один баланс, не уведут его в минус —
// второй увидит строку первого.
export function spendWallet(db, { patientId, invoice, paymentId, amount, user }) {
  if (!patientId) throw new WalletError('У счёта нет пациента — оплатить с баланса нельзя.');
  if (isDepositInvoice(db, invoice)) throw new WalletError(DEPOSIT_INVOICE_REFUSAL);
  const balance = walletBalance(db, patientId);
  if (amount > balance) {
    throw new WalletError(`На балансе пациента только ${balance} — списать ${amount} нельзя.`);
  }
  withLedgerToken(db, () => db.prepare(`
    INSERT INTO patient_deposits
      (patient_id, branch_id, amount, method, status, kind, invoice_id, payment_id, notes,
       created_by, created_by_name, closed_at)
    VALUES (?, ?, ?, 'wallet', 'spent', 'spend', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  `).run(patientId, invoice.branch_id || null, amount, invoice.id, paymentId,
    'Оплата счёта ' + (invoice.invoice_number || ('#' + invoice.id)) + ' с баланса',
    user.id, actorName(user)));
  return round2(balance - amount);
}

// Зачисление на баланс при возврате платежа. paymentId — ВОЗВРАЩЁННЫЙ платёж
// (не строка возврата): по нему видно, откуда пришли деньги.
export function creditWallet(db, { patientId, invoice, paymentId, amount, reason, user }) {
  if (!patientId) throw new WalletError('У счёта нет пациента — зачислить на баланс некому.');
  withLedgerToken(db, () => db.prepare(`
    INSERT INTO patient_deposits
      (patient_id, branch_id, amount, method, status, kind, invoice_id, payment_id, reason, notes,
       created_by, created_by_name, received_by, received_by_name, received_at)
    VALUES (?, ?, ?, 'wallet', 'received', 'credit', ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  `).run(patientId, invoice.branch_id || null, amount, invoice.id, paymentId, reason || null,
    'Возврат по счёту ' + (invoice.invoice_number || ('#' + invoice.id)) + ' зачислен на баланс',
    user.id, actorName(user), user.id, actorName(user)));
  return walletBalance(db, patientId);
}
