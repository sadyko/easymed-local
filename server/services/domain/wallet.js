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
export function isDepositInvoice(db, invoiceId) {
  return !!db.prepare("SELECT 1 FROM patient_deposits WHERE invoice_id = ? AND kind = 'deposit' LIMIT 1").get(invoiceId);
}

function actorName(user) {
  return String((user && (user.full_name || user.username)) || '');
}

// Оплата счёта с баланса. amount уже округлён вызывающим. Баланс читается
// ВНУТРИ транзакции: два кассира, тратящие один баланс, не уведут его в минус —
// второй увидит строку первого.
export function spendWallet(db, { patientId, invoice, paymentId, amount, user }) {
  if (!patientId) throw new WalletError('У счёта нет пациента — оплатить с баланса нельзя.');
  if (isDepositInvoice(db, invoice.id)) {
    throw new WalletError('Это счёт самого депозита — оплатить его с баланса нельзя.');
  }
  const balance = walletBalance(db, patientId);
  if (amount > balance) {
    throw new WalletError(`На балансе пациента только ${balance} — списать ${amount} нельзя.`);
  }
  db.prepare(`
    INSERT INTO patient_deposits
      (patient_id, branch_id, amount, method, status, kind, invoice_id, payment_id, notes,
       created_by, created_by_name, closed_at)
    VALUES (?, ?, ?, 'wallet', 'spent', 'spend', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  `).run(patientId, invoice.branch_id || null, amount, invoice.id, paymentId,
    'Оплата счёта ' + (invoice.invoice_number || ('#' + invoice.id)) + ' с баланса',
    user.id, actorName(user));
  return round2(balance - amount);
}

// Зачисление на баланс при возврате платежа. paymentId — ВОЗВРАЩЁННЫЙ платёж
// (не строка возврата): по нему видно, откуда пришли деньги.
export function creditWallet(db, { patientId, invoice, paymentId, amount, reason, user }) {
  if (!patientId) throw new WalletError('У счёта нет пациента — зачислить на баланс некому.');
  db.prepare(`
    INSERT INTO patient_deposits
      (patient_id, branch_id, amount, method, status, kind, invoice_id, payment_id, reason, notes,
       created_by, created_by_name, received_by, received_by_name, received_at)
    VALUES (?, ?, ?, 'wallet', 'received', 'credit', ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  `).run(patientId, invoice.branch_id || null, amount, invoice.id, paymentId, reason || null,
    'Возврат по счёту ' + (invoice.invoice_number || ('#' + invoice.id)) + ' зачислен на баланс',
    user.id, actorName(user), user.id, actorName(user));
  return walletBalance(db, patientId);
}
