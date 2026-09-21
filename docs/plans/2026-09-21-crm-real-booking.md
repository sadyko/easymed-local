# CRM booking = real visit; «Пришёл» = arrived — design + plan (CRM_REAL_BOOKING_V1)

**Date:** 2026-09-21 · **Owner's decisions (2026-09-21):** D1 yes — a call-centre booking holds a real calendar slot; D2 yes — «Пришёл» means the patient physically arrived. Context: `docs/plans/2026-09-20-crm-calendar-integration-decisions.md`.

## Design

**Data.** `crm_request_services.visit_id INTEGER REFERENCES visits(id)` (+ index) — migration 142. A request can span several days, so the link lives on the LINE, not on the request. Registry: `visit_id` readable, filterable, writable by admin/registrar/callcenter (same as the row). Not shipped by branch sync.

**Server.**
- `ENSURE_ROLES` (`rpc/visits.js`) and `BOOK_ROLES` (`rpc/calendar.js`) gain `callcenter`, so the operator can ask for free slots and book through the same door as everyone else.
- `settleCrmForVisit` is split: on visit CREATION (`ensure_visit`, all three call sites) → `settleCrmOnBooking`: the matching lines (patient + day) get `visit_id`, the parent moves forward to the «Записан» stage (`scheduledStageKey(db)` = seeded `scheduled`, else the last open stage before won); lines stay `pending` so the registrar's prefill (`pendingCrmLines`) still finds them. The won-flip leaves `ensure_visit`.
- New hook `crmVisitStatus(db, { visitId, from, to })` in `server/services/crm/visit-status.js`, called from `calendarBook` right after its transaction — the ONLY chokepoint every status change passes through (calendar pills, visit modal, doctor's room, service-attach auto-promote). `arrived` → lines of that visit `done`, parent → won only when no pending line remains; `no_show` → parent → `noShowStageKey`; `cancelled` → clear `visit_id`, parent back to «Записан»/first open, clear `scheduled_date` when no dated line remains. Forward-only guards; never throws (the funnel may never refuse a booking).

**Card (crm.js).** The schedule sheet («Даты приёма») gains a time control per line: on date/doctor change `loadSlotDay(doctor_id, date, duration)` → `freeStartMinutes` → a `<select>` of free starts (fallback: a free time input when the server refuses); `picked[]` gains `start_iso`. «Сохранить и записать» → `persist()` (lines exist) → one `ensure_visit` per distinct day with `book: { doctor_id, service_id, start, duration_minutes }` (`slot_taken` → `bookErrorText` + `askEmergencyReason` retry; `forgetSlots()` after success) → `visit_id` written to each line. Lines without a doctor keep date-only behaviour (no `book`). A patient is already mandatory on this path (quick registration first). `saveLines` preserves lines that carry a `visit_id` (today it cancels-and-reinserts every pending line). The blind no-show sweep is narrowed to requests with no linked live visit; the conversion path no longer sets «Пришёл» (D2).

**Calendar (room-calendar.js).** Visits booked this way appear with no extra work (they are ordinary `visits` rows). Add a «колл-центр» badge on the block and a «Заявка №N» line in the appointment modal, from one `crm_request_services … in('visit_id', ids)` query.

**Guards.** `booking-doors.test.mjs`: `crm.js` is a visit-wizard-class door — must use `ensure_visit` with `book:`, must not call `calendar_book`/`calendar_slots` directly (slots via `loadSlotDay` from the picker module, which is the only allowed caller), no `from('visits')` writes.

## Tasks

- **T1** migration 142 + registry (+ `142.test.js`).
- **T2** server: `scheduledStageKey`, `settleCrmOnBooking` replaces the creation-time won-flip; roles; `visits.test.js` rewritten (creation → «Записан», line carries `visit_id`, 3-day, tomorrow, empty stages, never resurrect lost).
- **T3** server: `crm/visit-status.js` hook in `calendarBook` (+ tests; `calendar.test.js` untouched and green).
- **T4** client: the card books a real slot (time picker, `ensure_visit`+`book` per day, `visit_id` write-back, preserve booked lines) + `crm-card.test.mjs`.
- **T5** client: narrowed sweep, conversion without «Пришёл», `crm-lines.js` parent-flip behind the arrival rule + tests.
- **T6** guards (`booking-doors`, `wizard-booking` lists) + calendar badge/modal line + tests.
- **T7** whole suite, adversarial review, merge, release 3.4.0 together with CALLCENTER_OPERATOR_V1.
