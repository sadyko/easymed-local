# Invoice auto-expiry (INVOICE_EXPIRE_V1) — design

**Date:** 2026-08-12
**Status:** approved direction (void + delete services), spec pending user review

## Problem

In the outpatient flow, registration creates a visit, its `visit_services`
lines, an `unpaid` invoice, and per-destination-per-day queue tickets. When a
patient registers but never pays, those rows linger forever: the cashier's
«НЕ ОПЛАЧЕН» list accumulates days-old bills, and the patient's visit stays
open with pending services. The queue is registration-based, so stale
registrations must not survive into the next day.

## Decision (user-approved)

If an outpatient invoice is still fully unpaid at the end of the day it was
created, it **expires automatically on the next day**:

- the invoice is **voided** (`status = 'void'`) — it stays in the database as
  a record that the patient registered and walked away;
- its `invoice_items` are **kept** — they document what the voided bill was for;
- its `visit_services` lines are **deleted** (queue tickets `queue_key` /
  `queue_no` die with the rows) — same treatment as the existing
  `removeUnpaidService` flow gives unpaid lines;
- if the visit is left with no service lines at all, the visit is marked
  `no_show` (only from active statuses `scheduled` / `confirmed` / `arrived`).

Rejected alternative: hard-deleting invoice + items + visit. Cleaner lists,
but the clinic loses all trace of walk-away patients and the ability to
report on them. Rejected by user in favour of void-with-trace.

## What is NOT touched

| Case | Why it survives |
| --- | --- |
| Invoices created today | Not yet expired — the cashier may still collect. |
| `partial` invoices | Money was accepted; voiding requires a refund first (same rule as manual `void_invoice`). |
| `debt` invoices | Explicit cashier decision to keep the balance open. |
| `paid`, `void`, `refunded` | Nothing to do. |
| Inpatient invoices (`admission_id IS NOT NULL`) | Admissions have their own billing lifecycle (BED_CONSOLE_V1). |
| Invoices with any linked service line `in_progress` / `completed` | Work was actually performed; the bill must be resolved manually (pay / debt / refund), so the whole invoice is skipped. |
| Unbilled `visit_services` (no `invoice_item_id`) on the same visit | Out of scope — the sweep is invoice-driven. Such lines also keep the visit from being marked `no_show`. |

## Mechanism

New exported function `expireStaleUnpaidInvoices(db)` in
`server/services/rpc/cashier.js` (next to `autoCloseStaleShifts` and
`voidInvoice`, which it mirrors):

1. Candidates:
   `status = 'unpaid' AND paid_amount <= 0 AND admission_id IS NULL AND
   date(created_at, 'localtime') < date('now', 'localtime')`.
2. Skip any candidate with a linked `visit_services` row in
   `in_progress` / `completed` (linked via its `invoice_items`).
3. For the rest, in **one transaction**:
   - `UPDATE invoices SET status = 'void'`;
   - `DELETE FROM visit_services WHERE invoice_item_id IN
     (SELECT id FROM invoice_items WHERE invoice_id = ?)`;
   - for each affected visit: if no `visit_services` remain, set
     `visits.status = 'no_show'` (only when currently
     `scheduled` / `confirmed` / `arrived`).
4. Returns `{ expired: <count> }`; the sweep is idempotent.

### Trigger — same pattern as SHIFT_AUTOCLOSE_V1

- `server/index.js`: call inside the existing startup `setTimeout` and hourly
  `setInterval` alongside `autoCloseStaleShifts` (covers midnight rollover
  while the server runs, and catches up at start if the clinic PC was off
  overnight).
- Lazy catch-up: also called at the top of the `cashier_invoices` RPC, so the
  first cashier screen load of a new day is always clean even between ticks.

Alternatives considered: an exact-midnight timer (fragile — a local clinic PC
is usually off at midnight) and a purely lazy RPC-driven sweep (stale rows
would persist in doctor-facing views until a cashier opens the desk). The
startup + hourly + lazy combination is the established local pattern.

## UI impact

None required. The cashier list already renders `void` under the «ОТМЕНЁН»
chip and its counters only show void/refunded invoices created **today**
(`cashierInvoices` date filter), so yesterday's auto-voided bills drop out of
the cashier screen entirely while remaining in the database for history and
reports. Doctor queue and patient card clean up because the service lines are
gone.

## Tests (in `server/services/rpc/cashier.test.js`, marker INVOICE_EXPIRE_V1)

1. Yesterday's unpaid outpatient invoice → voided, its service lines deleted,
   visit marked `no_show`.
2. Today's unpaid invoice → untouched.
3. `partial` and `debt` invoices from yesterday → untouched.
4. Inpatient invoice (`admission_id` set) → untouched.
5. Invoice with an `in_progress` / `completed` line → fully skipped.
6. Visit that still has other (e.g. paid) service lines → visit **not**
   marked `no_show`; those lines intact.
7. Running the sweep twice → second run is a no-op.
