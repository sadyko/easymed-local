// JOURNALS_V1_REGISTER (2026-10-02) — ДЕНЬГИ И ДИАГНОЗ ГОСПИТАЛИЗАЦИИ: ОДНО ПРАВИЛО.
//
// «Сумму оплаты» и диагноз госпитализации читают вкладка «Стационар →
// Госпитализации» (rpc/admissions-register.js) и отчёт «Реестр стационарных
// пациентов» (rpc/reports.js). Две копии подзапроса разошлись бы молча: в
// одном месте отменённый счёт считался бы оплатой, в другом нет. Поэтому
// фрагменты SQL живут здесь, а оба места их только зовут. Алиас — таблица
// admissions в запросе вызывающего.

/** Оплачено по счетам госпитализации: всё, кроме отменённых и возвращённых (DEBT_FLOW_V1). */
export const ADMISSION_PAID_TOTAL_SQL = (a) => `(SELECT COALESCE(SUM(afi.paid_amount), 0) FROM invoices afi
   WHERE afi.admission_id = ${a}.id AND afi.status NOT IN ('void', 'refunded'))`;

/** Метка последней оплаты по тем же счетам; возврат (минус) — не оплата. UTC, день считает вызывающий. */
// JOURNALS_V1_RJ1 (ревью, п. 10a) — и платёж, возвращённый ЦЕЛИКОМ, — не оплата.
// Возврат кассы — отрицательная строка payments с пометкой «REFUND#<платёж>»
// (одна или с хвостом « LINE#…» / « SWAP#…»); граница пометки — как у
// refundedOfPayment (billing.js): REFUND#1 не цепляет REFUND#10.
export const ADMISSION_LAST_PAID_AT_SQL = (a) => `(SELECT MAX(afp.paid_at) FROM payments afp
   JOIN invoices afv ON afv.id = afp.invoice_id
   WHERE afv.admission_id = ${a}.id AND afv.status NOT IN ('void', 'refunded') AND afp.amount > 0
     AND afp.amount - (SELECT COALESCE(SUM(-afr.amount), 0) FROM payments afr
           WHERE afr.amount < 0 AND (afr.notes = 'REFUND#' || afp.id OR afr.notes LIKE 'REFUND#' || afp.id || ' %')) > 0.005)`;

/** Последний опубликованный непустой диагноз осмотра (ADMISSIONS_REGISTER_V2). */
export const ADMISSION_REVIEW_DIAGNOSIS_SQL = (a) => `(SELECT afr.diagnosis FROM admission_reviews afr
   WHERE afr.admission_id = ${a}.id AND afr.published_at IS NOT NULL
     AND afr.diagnosis IS NOT NULL AND TRIM(afr.diagnosis) <> ''
   ORDER BY afr.published_at DESC, afr.id DESC LIMIT 1)`;

/** Диагноз госпитализации словом: при поступлении, иначе последний опубликованный осмотра. */
export function admissionDiagnosisText(admissionDiagnosis, reviewDiagnosis) {
  return String(admissionDiagnosis || '').trim() || String(reviewDiagnosis || '').trim() || '';
}
