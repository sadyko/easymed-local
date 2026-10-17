# CRM_ONE_WAY_V1 — a booking's services live only in the visit (2026-10-17)

## Why

Four review rounds on the CRM ↔ calendar link (CRM_LINK_ALL_V1, docs/specs/2026-10-16-crm-link-all-doors-design.md)
kept finding the same family: double bills and lost services around cancel, restore and move. Every one comes from
the TWO-WAY copy mirror (CRM_CALENDAR_MIRROR_V1, booking-mirror.js, since 2026-09-27, released since 3.12): a
booked service exists twice — as a card line (crm_request_services) and as a visit line (visit_services) — and the
mirror keeps re-syncing the copies. Proven cases (repros in the session scratch `crm-link-review/`):
- M1: call-centre consultation (doctor 10) cancelled, registrar rebooks the same day with doctor 11 → the visit holds
  both, 200 000 instead of 100 000, and doctor 10 is credited a consultation he never gave.
- M2 / B1 / C2: a cancelled consultation re-appears in an analysis-only visit that day (phantom 100 000).
- C1: cancel + rebook the same consultation → two consultations.
- Move-path twins (booking-mirror-twin.test.js todos): ×2 injection becomes 3, ×10 course becomes 11, a moved
  consultation lands next to another card's booked one, a shared line moved onto a booked day → two.
- M8: a mistaken cancel then «Записан» again → the visit comes back empty.
- G1a/G1b: a restore after cancels overwrites a human's later move or a no-show.

**Owner, 2026-10-17:** «Fix the root first» and, after a cancel, «Back to the card, no date»: a booking's services
live only in the visit; the card shows them; after a cancel the card keeps its services as a plain list WITHOUT a
date; nothing is added to any visit automatically until the operator books again.

## Model

- **Wish** — a card line with no visit (`visit_id` NULL): service, optional date, optional doctor. It is what the
  call centre noted («хочет консультацию в пятницу»).
- **Booked line** — a card line that points at ONE visit line (`visit_id` + `visit_service_id`). Two cards may point
  at the same visit line (site + call for one consultation) — that line is still billed once.
- **Visit line** — the only place a booked service exists for money, the calendar, the cashier and the doctor.

## Rules

- **O1 Booking takes wishes, never doubles them.** When a visit is booked or registered (every door, through
  crmLinkVisit step A), the card's DATED wishes for that day (and, at registration with the `undated` option, the
  card's never-booked undated wishes) attach to it: if the visit already has a free line of the same service
  (public/js/shared/same-service.js rule) the wish points at it; otherwise exactly one visit line is inserted for it.
  A wish never produces a second line next to a same-service line.
  *Reviews r4/r5:* same service matches both ways (a side with no doctor matches any doctor), but a line of a service
  that needs a doctor is shared only by wishes whose named doctors agree, and a doctor-less line is claimed by at most
  one named doctor (two named doctors = two consultations). A CRM line with a named doctor yields only to a line of
  the same doctor (R7b rule).
- **O2 Nothing is copied from the visit to the card.** No mirror-made card lines (`visit_service_auto = 1`) are
  created any more. The card shows the visit's services through «Записи пациента» (crm_card_bookings, already
  built) and its booked lines.
- **O3 Card edits act on the visit.** Adding a service to a booking from the card = one visit line on that visit
  (+ a booked line pointing at it); removing it = removing that visit line when it is free (not billed, not
  started), and the booked line is cancelled. A visit line removed elsewhere (calendar, registration, cashier) turns
  the booked lines that pointed at it into UNDATED wishes (O4 rule), never deletes them.
- **O4 Cancel = back to the card without a date.** When a visit is cancelled, every booked line pointing into it
  becomes an undated wish (`scheduled_date`, `visit_id`, `visit_service_id` NULL; `released_from_visit_id` = that
  visit). The cancelled visit's own lines stay in it untouched (history; never moved, never billed). A released wish
  is NEVER taken automatically — not by a same-day booking (it has no date) and not by the registration's `undated`
  option (the release marker excludes it) — until the operator dates it or books it again (any operator edit of
  the line clears the marker).
- **O5 Restore = put it back.** When a cancelled visit becomes live again (mistaken cancel), wishes released from it
  that are still undated and unchanged point at their visit lines again (which never moved).
- **O6 Moves need no CRM work.** Moving a visit (day, time, doctor) moves its lines (calendar code); booked lines
  follow automatically because they point at the visit lines. The CRM moves no line and copies nothing; the card
  date is recomputed (cardDateOf).
- **O7 Statuses flow one way.** A booked line's status follows its visit line (done when the service is done or the
  visit arrived; cancelled per O3/O4). Arrival is judged by the visit (status, payment, started service), never by
  card lines. No CRM path inserts, deletes or edits a visit line except O1 (one line per wish) and O3 (the card's own
  add/remove of a free line).
- **O8 Upgrade repair (one-off, logged, conservative).** Existing mirror-made card lines (auto = 1) that point at a
  visit line are deleted (the display shows the visit). Booked lines whose visit is cancelled become released
  undated wishes (O4). A line an operator created is never deleted. Counts go to a repair log; the one-off runs once.
  *Revised 2026-10-17 (controller decision on adversarial review r4, items 1, 5, 6) — the repair DELETES NOTHING.*
  On real old databases the 0–2 s "copy" rule deleted a call-centre calendar line (a booked line of the card by
  owner decision R2) and an operator wish saved 1 s after the registrar line. Now: (a) lines that point at a visit
  line stay booked lines and are marked by origin — a call-centre-held visit (R2) or an operator wish older than the
  visit line is released undated by a later cancel; a copy on a registrar/'match'-held visit (only the 0–2 s rule
  decides this) gets `legacy_copy = 1` and a later cancel cancels it instead of releasing it; (b) a dated wish with no
  pointer whose card has evidence of a cancelled booking that day (`crm_booking_undo` or `crm_booking_links` to a
  cancelled visit on that date) becomes a released undated wish (`released_from_visit_id` = that visit). Every row
  decided on is logged; visit lines and invoices are never touched; still once, in one transaction (migration 248).
  *Review r5:* (b) releases only a wish whose service was in that cancelled visit and that existed before the cancel,
  and never when the card holds a live booking that day.
- **O9 Unchanged:** display links and CRM_LINK_ALL rules P-1…P-7 (they never copy); «Отказ» cancels call-centre
  bookings (cancellableBookingsOf); owner decisions (registrar never works in CRM; no card for walk-ins;
  «Пришёл»/«Отказ» closed forever; 72-hour window; «Не пришёл» reopenable); a card's STAGE never decides SERVICES.
- **O10 Funnel fixes from round 3.** Restore a card's stage from the trail only if the card is still in the stage
  that booking set (never overwrite a human move or a no-show); a cancelled booking's trail entry is removed on
  cancel; a «live booking» is a visit not cancelled / no-show whose day is today or later, or that shows arrival —
  a past, unmarked 'scheduled' visit is not live. The display-link cleanup on patient change is done at READ time
  (crm_card_bookings and every stage rule already require the card's patient = the visit's patient), so the
  migration-246 trigger is dropped (it lost links on 77→78→77 and scanned visits on every patient write); 246/247
  never left this branch and may be rewritten/renumbered.

## Acceptance

- Every CRM_TWIN_LINE todo in server/services/crm/booking-mirror-twin.test.js becomes a real passing test under the
  one-way expectations (one line billed once; quantities and packages kept on the visit line).
- All earlier repros pass with one-way expectations: scratch `crm-link-review/repros-r1`, `repros-r2`, the round-3
  set `crm-link-review/tree3/server/routes/zz-r3-*` (M1, M2, M7, M8, G1a–e, TRIG-a), and the 8a-era collection
  `crm-twin-repros/` — each either passes or is shown obsolete because the copy no longer exists (named in the plan).
- Door matrix tests/crm-doors 110/110 (predicates adjusted to one-way where a cell expected mirror copies).
- No money moves: every scenario compares visit_services rows and invoice totals before/after.
- Full suite green in ru and en-US. ru/uz/en for any new UI text; marker CRM_ONE_WAY_V1.
