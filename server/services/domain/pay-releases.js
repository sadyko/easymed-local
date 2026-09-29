// PAY_REFUND_V1 (владелец, 2026-09-27) — «возврат забирает и долю врача».
//
// Когда касса отпускает строки со счёта (отмена счёта, «убрать строку из
// счёта»), ссылка строки на счёт стирается, и строка становится
// невыставленной работой — её доля врачу платится по цене будущего счёта.
// Если по этому счёту БЫЛИ возвраты, это неправда: деньги пациенту вернули, и
// работа врачу не оплачивается, пока её не выставят и не оплатят снова. Здесь
// эта отметка ставится (миграция 162); читает её reports.js (выплата врачу).
//
// Отметка ставится ТОЛЬКО если у счёта есть возврат (отрицательный платёж).
// Обычная отмена неоплаченного счёта ничего не пишет: сделанная работа
// остаётся оплачиваемой, как решено ревью C1 (26.09).

/** Были ли по счёту возвраты. */
export function invoiceHadRefund(db, invoiceId) {
  return !!db.prepare('SELECT 1 FROM payments WHERE invoice_id = ? AND amount < 0 LIMIT 1').get(invoiceId);
}

/**
 * Запомнить, что строки ушли со счёта с возвратом.
 * @param {'out'|'in'} kind  out — visit_services, in — admission_services
 * @param {number[]} lineIds строки, отпущенные со счёта
 */
// BILLING_AUDIT_FIX_V1 (B1) — `always`: строку вернули пациенту строкой
// (refund_invoice_line). Отметка ставится и без отрицательного платежа —
// частично оплаченный счёт мог просто уменьшиться на неё, денег возвращать
// было нечего, а работа всё равно ушла со счёта как возвращённая.
export function markRefundRelease(db, { invoiceId, kind, lineIds, always = false }) {
  if (!lineIds || !lineIds.length) return 0;
  if (!always && !invoiceHadRefund(db, invoiceId)) return 0;
  const ins = db.prepare('INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES (?, ?, ?)');
  for (const id of lineIds) ins.run(kind, id, invoiceId);
  return lineIds.length;
}

// FINAL_MONEY_FIX_V1 (I1) — какие из этих строк отпущены со счёта с
// возвратом и ещё не выставлены заново: пациенту за них вернули, и касса не
// выставляет их снова по умолчанию (create_invoice_for_visit, окно визита).
export function refundedLineIds(db, kind, lineIds) {
  const ids = (lineIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const holes = ids.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT prr.line_id AS id FROM pay_refund_releases prr
                      WHERE prr.kind = ? AND prr.line_id IN (${holes}) ORDER BY prr.line_id`)
    .all(kind, ...ids).map((r) => r.id);
}

// FINAL_MONEY_FIX_V1 (M1) — строку выставили заново: прежняя отметка больше
// не про неё. Иначе обычная отмена НОВОГО неоплаченного счёта (возвратов по
// нему не было) читала старую отметку, и сделанная работа не платилась.
// Если новый счёт тоже вернут и отменят — отметку поставит его отмена.
export function clearRefundRelease(db, kind, lineIds) {
  const ids = (lineIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return 0;
  const del = db.prepare('DELETE FROM pay_refund_releases WHERE kind = ? AND line_id = ?');
  let n = 0;
  for (const id of ids) n += del.run(kind, id).changes;
  return n;
}

// V3120_FINAL — строка стационара, отпущенная со счёта С ВОЗВРАТОМ и ещё не
// выставленная заново, — НЕ «к оплате». Так решает касса (отмена счёта после
// полного возврата отпускает строки, и выставлять их снова по умолчанию не
// предлагают), так же читает журнал госпитализаций (он считает только живые
// счета). Остаток госпитализации, обзор, акт и доначисление проживания
// исключают её тем же условием. Выставили заново (buildAdmissionInvoice) —
// отметка снимается (clearRefundRelease), и строка снова обычная.
// REFERRAL_BILL_V1 (2026-09-29) — то же условие и для строк визита (kind
// 'out'): «Ждут счёта» в кассе (cashier_unbilled) не показывает строку,
// отпущенную с возвратом, — она в «Возвратах и отменах», как и у refundedLineIds.
// kind — только из двух слов, в SQL не попадает ничего другого.
export function notRefundReleasedSql(alias, kind = 'in') {
  const k = kind === 'out' ? 'out' : 'in';
  return `NOT EXISTS (SELECT 1 FROM pay_refund_releases prr_x WHERE prr_x.kind = '${k}' AND prr_x.line_id = ${alias}.id)`;
}
export function refundReleasedSql(alias) {
  return `EXISTS (SELECT 1 FROM pay_refund_releases prr_x WHERE prr_x.kind = 'in' AND prr_x.line_id = ${alias}.id)`;
}
