# CRM doors × states — evidence matrix (HEAD e8b4aab4)

Frozen 2026-10-16 (CRM_LINK_ALL_V1 acceptance test). Tests: `tests/crm-doors/matrix.test.mjs`
(scenarios in `scenarios.mjs`, helpers in `helpers.mjs`). Run (repo root): `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs`.

States: S1 = call card ≤72h, no date, no lines · S1p = same but phone only (no patient) ·
S2 = card booked by call centre from the card for day D (+3) with consultation 30 / doctor 10 ·
S3 = open card, last activity 5 days ago · S4 = no card.

CRM_LINK_ALL_V1, редакция 2 («показывать, а не копировать», docs/specs/2026-10-16-crm-link-all-doors-design.md):
the frozen EXPECT cells stay as the record of HEAD e8b4aab4; a cell whose rule a decision changed lives in
`DECIDED` (matrix.test.mjs) with the observed cell and the owner predicate it must meet. Links of step C′ and the
phone match are display-only — the card no longer gets copied lines (`lines` stays the card's own lines); what the
card SHOWS is read from RPC `crm_card_bookings` («Записи пациента») into a non-enumerable `view`, and the display
predicates `shown` / `booked+shown` / `came+shown` replace `lines` / `booked` / `came+lines` for those cells.

Cell legend: lines = what the card shows (svc@day:status/visit; V = this door's visit, B = S2 booking) ·
link = crm_booking_links row for V → card · stage = card's final stage · dup = second visit / duplicate line.

## UI call sequences (cited)
- DOOR 1 CRM card «Сохранить и записать» (crm.js:3004): UPDATE crm_requests {scheduled_date, status:'scheduled'}
  crm.js:2389/2394 (new card INSERT crm.js:2411) → INSERT crm_request_services crm.js:2494 → rpc ensure_visit
  {date, doctor_id, book:{…}} crm.js:2831-2847 → UPDATE crm_request_services {visit_id} by request_id+day+pending crm.js:2920.
- DOOR 2 calendar slot → service picker (room-calendar.js:693/708 → service-picker-modal.js:3014 wizSave):
  rpc calendar_book {patient_id, doctor_id, service_id, start, duration_minutes, status:'scheduled'} spm.js:3065/3637
  (day_visit_busy → add_to_day_visit:true spm.js:3646) → callcenter: rpc booking_lines_add spm.js:3102;
  admin/registrar/doctor: /api/db INSERT visit_services spm.js:3128.
- DOOR 3 fast registration → registerWalkIn (walk-in-booking.js:185-333): rpc ensure_visit {date: now ISO,
  doctor_id, visit_type, branch_id, notes:null, desk:true} WIB:212-224 → /api/db INSERT visit_services WIB:267-283 →
  rpc create_invoice_for_visit WIB:291-296 → issue_queue_numbers WIB:315. (a) new patient: /api/db INSERT patients
  data.js:564 → rpc crm_link_new_patient data.js:583 → chain. (b) existing from search strip: reads only → chain.
  (c) «use existing» in duplicate dialog: loadPatientById (read) → chain (server-identical to b).
- DOOR 4 wizard createVisit (visit-wizard.js:2564): rpc ensure_visit {date, doctor_id, visit_type, branch_id,
  [book]} — never desk — visit-wizard.js:2686-2695 → /api/db INSERT visit_services :2773 → (optional)
  create_invoice_for_visit :2809. Prefill of CRM lines only for TODAY (crm-lines.js:66/71 via :775).
- DOOR 5 quick-patient window (quick-patient-modal.js:345-404): INSERT patients + crm_link_new_patient; no visit.
  From the CRM card: UPDATE crm_requests {patient_id} crm.js:1521, then wizard (crm.js:1340-1349) or schedule sheet.
- DOOR 6 «Повторный визит» (service-workspace.js:1425 → :1576): rpc calendar_book {patient_id, doctor_id,
  service_id:null, start, duration_minutes, status:'scheduled'} → UPDATE visits {visit_kind:'repeat'} :1589 →
  INSERT visit_services {consultation_type_id, …} :1594.
- DOOR 8 calendar marks: rpc calendar_book {visit_id, start, status} room-calendar.js:1014-1015 / visit-booking.js:69;
  move = {visit_id, start} rcal.js:1174-1189; cancel = {visit_id, start, status:'cancelled'} rcal.js:1063.
- DOOR 9 cashier: create_invoice_for_visit (cashier-line-fix.js:599) → record_payment (cashier-desk.js:1961);
  add line only to an existing invoice: rpc cashier_line_add {invoice_id, service_id, doctor_id} clf.js:413.

## Matrix
(filled per door below)

### DOOR 1 — CRM card booking (cc and admin identical)
| state | lines on card | link | final stage | dup |
|---|---|---|---|---|
| S1 | 30@D pending/V | — (held by line, step A) | Записан, date D | no |
| S2 (+ D2 on same card) | 30@D/B + 30@D2/V | — (lines) | Записан, date D | no (2 visits = 2 days) |
| S3 | 30@D/V | — | Записан | no |
| S4 (new card) | 30@D/V | — | Записан | no |
OK everywhere — the card itself writes the lines, ensure_visit step A takes them.

### DOOR 2 — calendar slot → service picker
| state | who | lines on card | link | final stage | dup |
|---|---|---|---|---|---|
| S1 | cc / reg / admin | 30@D/V | card | Записан D | no |
| S2 (+ booking for D2) | cc | 30@D/B + 30@D2/V | card (step E same) | Записан D | no |
| S2 (+ booking for D2) | reg / admin | 30@D/B only — **D2 visit not on card** | none | Записан D (unchanged) | 2nd visit not on card — **GAP-1** |
| S2 same day D, other doctor (day_visit_busy → add_to_day_visit) | reg | 30@D/V + 40@D/V | — (lines) | Записан | no |
| S3 | cc | 30@D/V | card (E reopen → G) | Записан D | no |
| S3 | reg / admin | none | none | В обработке (unchanged) | **GAP-2** |
| S4 | cc | 30@D/V (new «Звонок» card, E new) | card | Записан | — |
| S4 | reg / admin | no card (walk-in rule) | — | — | OK |
| S1p (phone-only card) | reg | none (step D patient_id only) | none | Записан D | **GAP-3 (partial: moves, shows nothing)** |
Code: GAP-1/2 = visit-link.js:466-472 step C takes an open card only if waitsForDay(:253-266) (line/date that day, or no lines+no date inside 72h); step E (72h window, :486-511) only `callcenter && !desk` (:492, isCallcenterUser booking-mirror.js:673 = callcenter without registrar/doctor/admin). GAP-3 = step D (:474-484) writes only patient_id+stage, F excludes 'phone' (:513-515) → mirror has no requestOfVisit → no lines.

### DOOR 3 — fast registration (registrar; admin same)
| sub-path / state | lines on card | link | final stage | dup |
|---|---|---|---|---|
| (b) existing, S1 | **none** (visit has 30) | card | Пришёл | no — **GAP-4** |
| (b) existing, S1p phone card | **none** | none (phone) | Пришёл (patient_id set) | **GAP-4** |
| (b) existing, S2 (booked for D, comes today) | 30@D/B pending only — today's visit **not shown** | card | Пришёл, date D | 2 visits (today + D booking stays) — **GAP-4** |
| (b) existing, S3 (5 days) | none | none | В обработке (unchanged) | **GAP-2 (desk)** |
| (b) existing, S4 | no card | — | — | OK (walk-in rule) |
| (a) NEW patient, S1p (phone card ≤72h) | **none** | card | Пришёл (crm_link_new_patient linked it) | **GAP-4** |
| (a) NEW patient, S3p (phone card 5 days) | **none** | card | Пришёл (crm_link_new_patient bumps updated_at → in window) | **GAP-4** |
| (a) NEW patient, S4 | no card | — | — | OK |
| (c) «use existing», S2 | = (b) S2 (server-identical) | card | Пришёл | **GAP-4** |
GAP-4 code: visit-link.js:528-544 step G (desk) sets «Пришёл» before the visit has lines; deskArrive's mirrorVisit
(:388-389) runs on an empty visit; the desk lines come afterwards via /api/db visit_services → mirrorVisit step 3
(booking-mirror.js:429-432, 451) ignores a closed card ⇒ the card closes but never shows what was registered.
GAP-2 (desk) code: deskCloses visit-link.js:320-333 refuses an open card >72h not waiting today; E never at desk (:492).

### DOOR 4 — registration wizard (registrar)
| state | today, no payment | today + invoice + cash | future day D2 |
|---|---|---|---|
| S1 | 30@T pending/V · link · **Записан** (not Пришёл) — **GAP-5** | 30@T **done**/V · link · Пришёл — OK | 30@D2/V · link · Записан D2 — OK |
| S1p phone card | no lines · no link · Записан T (patient_id set) — **GAP-3+5** | (not run) | — |
| S2 (booked D) | today's visit **not on card**; card Записан D — **GAP-1+5** | paid today, card **stays Записан D** — **GAP-1+5** | D2 visit not on card — **GAP-1** |
| S3 (5 days) | not on card, В обработке — **GAP-2** | paid, still В обработке — **GAP-2** | not on card — **GAP-2** |
| S4 | no card — OK | no card — OK | no card — OK |
No duplicates anywhere (one visit per day; 2 visits only where 2 days are involved).
GAP-5 code: visit-wizard.js:2678-2695 builds ensure_visit args without `desk` → deskArrival false
(visit-link.js:342-344) → step G puts the card in «Записан» (:546-549); arrival only via money/work (visit-status.js:435-451).

### DOOR 7 — call-centre booking for TODAY (S2T), then registration — reuses the booked visit? YES (always 1 visit)
| path | lines on card | link | final stage | dup |
|---|---|---|---|---|
| fast reg, same consultation (booked from the CRM card → mirror line auto=1) | 30@T **done**/V | — (lines) | Пришёл | no (registrar line replaces the mirror line) — OK |
| fast reg, different service 40 | 30@T done/V only — 40 **not on card** | — | Пришёл | no — **GAP-4** |
| fast reg, same consultation, booking made in the CALENDAR by the call centre (booking_lines_add, auto=0) | 30@T done/V | card | Пришёл | **visit has consultation 30 TWICE** — **GAP-7** |
| wizard at the booked slot, no payment | 30@T pending/V | — | **Записан** — **GAP-5** | no |
| wizard at the booked slot + cash | 30@T done/V | — | Пришёл | no — OK |
| wizard at an earlier time (booking moved) | 30@T pending/V | — | Записан — **GAP-5** | no |
| wizard, booking made in the calendar by the call centre | 30@T ×2 pending/V | card | Записан | **visit and card both have 30 twice** — **GAP-7 (+5)** |
GAP-7 code: booking_lines_add inserts via insertBookingLine (booking-lines.js:112), the mirror links it with
visit_service_auto = 0; replaceAutoTwins (:624)/yieldAutoLine (:603)/autoLineFor (booking-mirror.js:591-596) only yield lines with auto = 1,
pruneAutoLinesOnInvoice likewise ⇒ the registrar's own line of the same service is a second line (2nd card line via
mirror step 3 when the card is still open). ensure_visit's day-visit rule (visits.js:225-231/260-267) itself is fine.

### DOOR 8 — calendar marks (registrar)
| action | lines on card | link | final stage | dup |
|---|---|---|---|---|
| «Подтверждён» on S2 booking | 30@D pending/V | — | **Записан (not Подтверждён)** | no — **GAP-6 (owner question)** |
| «Пришёл» on S2T booking | 30@T done/V | — | Пришёл | OK |
| «Не пришёл» on S2 booking | 30@D pending/V | — | Не пришёл | OK |
| move D → D2 | 30@D2 pending/V | — | Записан, date D2 | OK |
| cancel | 30@D pending (unbooked) | — | В обработке, date cleared | OK |
| «Пришёл» on registrar calendar visit of S1 card (link) | 30@T done/V | card | Пришёл | OK |
| cancel registrar calendar visit of S1 card | 30@D pending (unbooked) | card | В обработке | OK |
GAP-6 code: visit-status.js:238 — crmVisitStatus returns for 'confirmed'; no code maps it to «Подтверждён» (approved).

### DOOR 9 — cashier
| action | lines on card | link | final stage | dup |
|---|---|---|---|---|
| S2T: invoice + cash | 30@T done/V | — | Пришёл | OK |
| S2 (future D): invoice + cash | 30@D pending/V | — | Записан (prepayment ≠ arrival, owner rule) | OK |
| S2T: invoice → cashier_line_add 40 → cash | 30@T done/V + 40@T done/V | — | Пришёл | OK (mirrorCashierLine) |
| registrar calendar visit of S1 card, cash | 30@T done/V | card | Пришёл | OK |


## GAP list (code reasons)
- **GAP-1** booking/registration by registrar / admin / doctor for ANOTHER day than the one the live card waits for
  (doors 2, 4 today+future, 6) → visit never reaches the card (no link, no lines, stage unchanged; paying today does not
  close it either). visit-link.js:466-472 step C takes an open card only if waitsForDay (:253-266); step E (72h window,
  :486-511) runs only for `callcenter && !desk` (:492; isCallcenterUser booking-mirror.js:673).
- **GAP-2** open card older than 72h (S3): registrar/admin/doctor booking (doors 2, 4, 6) and the desk (door 3) leave it
  untouched — waitsForDay needs the window when the card has no lines/date (:258-260); deskCloses (:320-333) the same;
  only the call centre gets reopenLead (E). (Owner rule «after 72h an open card goes back to the first column» is
  implemented for calls and call-centre bookings only.)
- **GAP-3** phone-only card (S1p, unknown caller): any booking door moves the card (patient_id + stage) but it shows
  nothing — step D (:474-484) writes patient_id only, F skips 'phone' (:513-515). Deliberate money rule (family phone).
- **GAP-4** fast registration (all sub-paths a/b/c) closes the card to «Пришёл» but the registered services never
  appear on the card: step G desk (:528-544) closes the card before the visit has lines; deskArrive's mirror (:388-389)
  runs on an empty visit; the desk lines arrive later via /api/db visit_services → mirrorVisit step 3 drops a closed
  card (booking-mirror.js:429-432, :451). Same for an extra service at the desk on a call-centre booking (7-fast-other).
- **GAP-5** registration wizard used at the desk TODAY (and QPM → convert → wizard) never sends `desk`
  (visit-wizard.js:2678-2695) → card goes to «Записан», not «Пришёл»; «Пришёл» only after payment/work
  (visit-status.js arriveBy :435-451). With a booking for another day (S2) even payment today leaves it «Записан D».
- **GAP-6** calendar «Подтверждён» does not move the card to «Подтверждён»: crmVisitStatus returns for 'confirmed'
  (visit-status.js:238). Not an owner decision either way — question for the owner.
- **GAP-7** duplicate line: call centre booked TODAY via the CALENDAR (booking_lines_add → insertBookingLine,
  booking-lines.js:112, linked visit_service_auto=0); registration (fast or wizard) of the same service adds a second
  line — yieldAutoLine/autoLineFor (booking-mirror.js:591-603) and pruneAutoLinesOnInvoice (:791-797) only replace auto=1 mirror lines. Wizard: card shows it twice too.
- Reuse of the booked visit (door 7): OK — ensure_visit day-visit rule (visits.js:225-231, 260-267) always returns the
  call-centre visit; no second visit for the same day in any door.


## Compact matrix (✓ = card shows the visit's services as lines; link = crm_booking_links; stage = final)
| door \ state | S1 call ≤72h | S2 booked D by CC | S3 open, 5 days | S4 no card |
|---|---|---|---|---|
| 1 CRM card (cc, admin) | ✓ · lines hold it · Записан | ✓ (2nd day on same card) · Записан | ✓ · Записан | new card ✓ · Записан |
| 2 calendar — cc | ✓ · link · Записан | ✓ · link · Записан | ✓ · link · (reopen→) Записан | new «Звонок» card ✓ |
| 2 calendar — reg/admin | ✓ · link · Записан | ✗ D2 visit not on card · Записан D (GAP-1) | ✗ untouched · В обработке (GAP-2) | no card (OK) |
| 3 fast reg a/b/c (reg, admin) | ✗ no lines · link · Пришёл (GAP-4) | ✗ today not shown · link · Пришёл (GAP-4) | ✗ untouched (GAP-2) | no card (OK) |
| 4 wizard today, no pay | ✓ · link · Записан (GAP-5) | ✗ · Записан D (GAP-1+5) | ✗ (GAP-2) | no card |
| 4 wizard today + cash | ✓ done · Пришёл | ✗ · stays Записан D (GAP-1+5) | ✗ (GAP-2) | no card |
| 4 wizard future D2 | ✓ · link · Записан D2 | ✗ (GAP-1) | ✗ (GAP-2) | no card |
| 5 quick-patient | S1p: patient linked, no visit; → wizard today ✓ · Записан (GAP-5) | — | — | patient only |
| 6 «Повторный визит» (doctor) | ✓ c5 · link · Записан D2 | ✗ (GAP-1) | ✗ (GAP-2) | no card |
| 7 S2 for TODAY → registration | reuses the booked visit (1 visit). Fast reg: line done · Пришёл; extra service not on card (GAP-4); if the CC booked in the CALENDAR → consultation twice in the visit (GAP-7). Wizard: reuses/moves · Записан until paid (GAP-5); CC calendar booking → twice in visit AND card (GAP-7) | | | |
| 8 calendar marks on S2 | Подтверждён → card stays Записан (GAP-6); Пришёл → done · Пришёл; Не пришёл → Не пришёл; move → line+date D2; cancel → line unbooked · В обработке | | | |
| 9 cashier | today: invoice+cash → done · Пришёл; future D: prepayment → Записан (owner rule); cashier_line_add → line on card · done | | | |
| S1p phone-only card | calendar reg → patient_id + Записан, no lines (GAP-3); fast reg existing → Пришёл, no lines (GAP-3/4); fast reg NEW patient → crm_link_new_patient links → Пришёл, no lines (GAP-4); wizard today → Записан, no lines (GAP-3+5) | | | |
No second visit for the same day in any door (ensure_visit / calendar_book day-visit rule).

## Runs (2026-10-16)
- HEAD e8b4aab4: `LIS_ENABLED=0 node --test matrix.test.mjs` → tests 100 · pass 70 · fail 0 · todo 30 (all 30 GAP
  todos fail the owner expectation = real gaps). Log: run-head.txt.
- 2c0b58f9 (git archive export, removed after): identical — 70 pass with the SAME observed cells, 30 GAP todos.
  Nothing regressed between 10-10 and HEAD; the gaps are the CRM_UNIFY_V1 rules themselves.
