# CRM_LINK_ALL_V1 — every booking door reaches the patient's CRM card (2026-10-16)

## Why

Owner, 2026-10-16: «there was a brief moment where crm and calendar and registration was connected … booked,
confirmed services was available with a status … why it is lost? and it was automatically changed status of the
crm cards» — and: «also consider the fast registration and other dialogue window of the registrations».

Investigation (no code regression; HEAD e8b4aab4 and 2c0b58f9 behave identically). A door-by-door matrix
replaying each window's real `/api/rpc` + `/api/db` calls under real roles (frozen acceptance test,
`tests/crm-doors/` in this branch, copied from the session scratch `crm-doors/`) found 7 gaps in the CRM_UNIFY_V1
rules (`server/services/crm/visit-link.js` crmLinkVisit steps A–G):

| gap | what happens today | code |
|---|---|---|
| G1 | registrar / admin / doctor books ANOTHER day than the card waits for → visit not on the card | visit-link.js C :466-472 (`waitsForDay`), E :486-511 is call-centre only (:492) |
| G2 | an open card older than 72 h is ignored by registrar/admin/doctor bookings and by the desk | `waitsForDay` :258-260, `deskCloses` :320-333 |
| G3 | phone-matched card (no patient before) gets patient + stage but shows no services | step D :474-484, F skips phone :513-515 |
| G4 | fast registration closes the card «Пришёл» but the registered services never show on it | G :528-544 runs before the visit has lines; mirror skips a closed card (booking-mirror.js :429-432, :451) |
| G5 | the registration wizard never sends `desk` → card «Записан» until payment | visit-wizard.js :2678-2695, visit-link.js :342-344 |
| G6 | calendar «Подтверждён» never moves the card | visit-status.js :238 |
| G7 | call centre books via calendar (`booking_lines_add`), the desk registers the same consultation → the visit carries it TWICE (double bill) | booking-lines.js :112 + booking-mirror.js :591-603, :624, :791-797 |

## Owner decisions (2026-10-16, all the recommended option)

- **D1** Any booking of a patient who has an OPEN card joins that card — any day, any role (call centre,
  registrar, admin, doctor). Its services show on the card and the card moves forward to the booked column. A card
  that has not moved within the repeat-contact window (72 h setting) first goes back to the start of the funnel
  (`reopenLead`, history stays inside), then to the booked column — exactly what the call centre's step E does today.
- **D2** A wizard registration for TODAY «now» (live queue / no later time) is a desk arrival → «Пришёл» at once,
  like fast registration. A wizard booking for later today stays «Записан» until the patient comes.
- **D3** Calendar «Подтверждён» moves the card forward to the «Подтверждён» column. Forward only.
- **D4** A card matched to the patient by phone (step D) shows the visit's services. The card's own earlier lines
  never go into that patient's bill from a phone match (shared family phones).
- Defects fixed without a decision: **G4**, **G7**.

Unchanged owner decisions: registrar never works in CRM; walk-ins / desk patients without an open card get NO card;
«Пришёл» and «Отказ» (all won/lost columns except the seeded «Не пришёл») are closed and never reopen; a card's
STAGE never decides SERVICES (money).

## Rules (what to build)

R1 (D1, G1 + G2) — **the patient's live card holds every booking.** In crmLinkVisit, for every role, when no step
A/B card holds the visit: the patient's LIVE card (`contact-window.js liveKeys`: open columns + seeded «Не пришёл»)
holds it. Several live cards → the one that moved last (`updated_at`, else `created_at`), ties → highest id. If that
card did not move within the window → `reopenLead` first. Then link (step F, `crm_booking_links`, source 'patient'),
mirror (the visit's services appear as the card's lines) and step G (forward to the booked column; card date by
`cardDateOf`). No live card → today's behaviour: call centre = step E (new «Звонок» card / closed-in-window rule);
everyone else = no card. A closed card is never reopened and never gets the booking.
The card's pending lines for OTHER days stay pending and untouched (step A is per day, unchanged).

R2 (D1 at the desk, G2) — `deskCloses` takes the patient's live card of ANY age (an old one is first reopened), then
«Пришёл» as today. A live card with no lines and no date still closes (as today within the window).

R3 (D2, G5) — the wizard sends `desk: true` with `ensure_visit` when the visit is for today and is a «now»
registration: the wizard's live-queue / no-slot mode, or a slot that starts no later than 30 minutes from now.
A later slot today = a booking (no desk). The server's `deskArrival` checks stay (registrar/admin, today's local day).

R4 (D3, G6) — `crmVisitStatus` 'confirmed' (calendarBook, the only human door to visits.status): the card that holds
the visit moves FORWARD to the confirmed column = the first ACTIVE open column after the booked column and before the
won column (seeded «Подтверждён» in the clinics); none → no move. Only from the booked column or earlier open
columns; never from a column after it, never from won/lost. Does not bump `updated_at` (server move, I-5 rule).

R5 (D4, G3) — a phone-matched card (step D) is linked to the visit (crm_booking_links, source 'phone') and the
mirror writes the visit's services onto it (visit → card only). The card's pre-existing lines are NOT put into the
visit by this booking (no step A for a card that became the patient's in this same call). Later doors treat it as an
ordinary patient card (today's behaviour after a patient link).

R6 (G4) — services added to the visit that closed the card at the desk (fast registration, wizard «now», later
cashier lines on that visit) appear on the card that holds the visit, as done lines linked by visit_service_id.
The card stays «Пришёл». Only the card that holds this visit; never another card.

R7 (G7) — **no second copy of a booked service.**
(a) Fast registration and the wizard, for a patient who has a pre-arrival visit TODAY (calendar or CRM booking),
show that visit's services as ready rows («из записи», with the booking status «Записан» / «Подтверждён») — the
registrar registers them, can add extras, can remove a booked row (it is removed from the visit as the calendar
would). Registration reuses the booked visit (as today) and does not insert a second line for a booked row.
(b) Server safety net: when a registration door inserts a visit_services line on a pre-arrival or today's own
visit, and that visit already has an unbilled 'added' line for the same service from a booking (calendar
`booking_lines_add`, CRM mirror, call-centre card) with the same doctor (or none), the insert reuses the existing
line instead of adding a second row. Real repeats (quantity) are untouched; billed/started lines are never touched.

## Acceptance

- The matrix test (`tests/crm-doors/matrix.test.mjs`): its 30 «GAP: …» todo cells become real passing tests with the
  decided expectations; its 70 «today's behaviour» cells stay green except those that encode a rule changed by D1–D4
  (each such change listed in the plan with the decision that changes it).
- `server/services/crm/booking-mirror-twin.test.js` CRM_TWIN_LINE todos: any that R7 resolves become real tests.
- Full suite green in ru and en-US (force-en preload). ru/uz/en for every new UI string, type-scale fonts, `Icon()`
  only, no emoji, 360 px.
- Marker CRM_LINK_ALL_V1 in code comments, tests and commit messages.

## Revision 2 (controller decision, 2026-10-16, after the money review of Tasks 1–3) — SHOW, DON'T COPY

The money review (`scratchpad/crm-link-review/tree/server/routes/zz-money-*.test.js`) proved three double-bill
paths, all born from COPYING a booking's services onto the card as card lines: the copy-mirror
(booking-mirror.js) then treats them as the card's own lines — adopts them into the next visit (F5: a C′ booking
dragged onto the card's wish day → 2 consultations, 200 000), returns them to waiting on cancel and re-adopts them
(F2: 2 consultations / 140 000 instead of 40 000), and 'done' rows written before arrival count as arrival
evidence (F1: a CRM cancel leaves the line in the bill, 140 000 instead of 100 000; F4: blocks the homeFor merge,
200 000). The copy-mirror has defeated four fix rounds before (CRM_TWIN_LINE). So the new doors do not copy:

- **Display links.** Links written by the new rules — C′ (`crm_booking_links.source = 'patient'`, R1/R2) and the
  phone match (`'phone'`, R5) — are DISPLAY-ONLY: `requestOfVisit` and every other copy-mirror lookup ignore them,
  so no visit line is copied onto the card and no card line is adopted into the visit because of them. They still
  drive the funnel: stage forward (G), card date (`cardDateOf`), arrival / «Не пришёл» / cancel / «Подтверждён»
  moves, the no-show sweep and the arrival catch-up — stage and date only, never services.
- **R6 replaced.** `crmWonCardLines` (Task 3) is removed: no 'done' rows. The services of a desk-closed visit show
  through the card's booking list (below).
- **The card shows its bookings read-only.** New RPC `crm_card_bookings(request_id)` — caller must be able to see
  the card (same row scope as crm_requests) — returns every live or past visit linked to the card by ANY link or
  line: day/time, doctor, visit status, and its services (name, quantity, line status; no prices). The CRM card shows
  them in a section «Записи пациента» with status chips (Записан / Подтверждён / Пришёл / Не пришёл / Отменён) and
  «Открыть в календаре». Editing a booking happens in the calendar; the card's own lines (wishes, call-centre
  bookings made from the card) keep working exactly as today.
- **Copy-mirror unchanged** for the links it already served (call-centre bookings and step-C matches). Its
  pre-existing twin paths (zz-money-mech: cancel → re-adopt, on old code too) remain the separate CRM_TWIN_LINE
  item, which must be designed and fixed before CRM_UNIFY_V1 / CRM_LINK_ALL_V1 are released.
- **Kept:** Task 4 (R4), Task 5 (R3), Task 6 (R7b booked-twin) — re-reviewed.
- **Task 7 (R7a) re-planned** with the interplay fix: a booked row arriving for a service already in the
  registration table is attached to that row (no second row), as the wizard already does; Task 6 never deletes a
  booked line whose id the screen is invoicing.
