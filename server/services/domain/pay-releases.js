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
export function markRefundRelease(db, { invoiceId, kind, lineIds }) {
  if (!lineIds || !lineIds.length) return 0;
  if (!invoiceHadRefund(db, invoiceId)) return 0;
  const ins = db.prepare('INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES (?, ?, ?)');
  for (const id of lineIds) ins.run(kind, id, invoiceId);
  return lineIds.length;
}
