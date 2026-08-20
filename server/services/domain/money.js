// INVOICE_TRUTH_V1 — the one definition of an invoice's settlement state.
//
// The paid/partial/unpaid ladder was written out by hand in record_payment,
// record_payment_split and refund_payment. Three copies of one rule is three
// chances for them to drift, and drift is invisible until the money is wrong.
//
// Rule: no module derives an invoice status or an "is this still owed" filter
// for itself. It calls in here.

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
