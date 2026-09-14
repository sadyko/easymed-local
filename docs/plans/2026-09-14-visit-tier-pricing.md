# Plan: a service priced by visit number — first, second (within a window), repeat

Owner (2026-09-14):

> "we have services, we need to add them a settings (nullable) for the primary
> visit, secondary, repeat visit and set dates between the first and second.
> for example in the first visit there can be 200000 sum and for second visit of
> this service can be 60000 if patient comes between 1-6 days and repeat visit
> is for example free."

## The rule (one place: `server/services/domain/visit-tier.js`)

- The existing `services.price` is the **first-visit** price. Three new nullable
  columns (migration 127): `price_secondary`, `secondary_days_from` /
  `secondary_days_to` (the window, in days after the previous visit), `price_repeat`.
  A service with all of them empty is priced the old way.
- "Previous visit" = the patient's most recent earlier line of the **same service**
  on a visit that happened (not cancelled / no-show), by the clinic's local calendar
  day. If today is inside the window after it: previous line was a first visit →
  **second** price; it was already second/repeat → **repeat** price. Outside the
  window → first price again (the chain restarts). Same day counts as "too soon"
  unless the window starts at 0.
- Fallbacks: no repeat price → the second price again; no second price but a repeat
  one → straight to repeat; empty «по день» → no upper limit.
- The line remembers its tier (`visit_services.price_tier`). The cashier's
  «create invoice» (billing.js) re-prices from the catalog — it now honours the
  recorded tier over both the catalog and the doctor's own price, which are
  first-visit prices.

**Assumption stated to the owner:** the window is measured from the previous visit
of that service (so a third visit must also be within N days of the second); a
visit later than the window starts over as a first visit.

## Where it shows

- **Service editor** (Настройки → Услуги → услуга): section «Цена по счёту визита»
  with the four fields and a one-paragraph explanation; empty = not used.
- **Booking wizard** (смета): once a patient is attached, `service_price_quote`
  answers per service; a second/repeat line shows a chip «Второй визит» /
  «Повторный визит», the first-visit price crossed out, and the quoted price. The
  tooltip says how many days ago the previous visit was. Detaching the patient
  restores catalog prices. The invoice line description carries «(второй визит)».
- **Existing visit → «Добавить услугу»** goes through the same quote (attach mode).
- **Doctor's workspace → «добавить услугу»** quotes before inserting the line.

## Also in this batch

- `slot-engine.js`: an EMPTY schedule object (`'{}'`, what «Сотрудники» saves for
  a new doctor with no days ticked) now means default 09:00–18:00, not "closed
  every day" — the cause of grey calendar columns and refused bookings the owner
  reported after adding cabinets and doctors.
- `admission-modal.js`: a consultation template now replaces the clinic's untouched
  blank in an inpatient document (before, the blank counted as "already written"
  and the template landed nowhere).
