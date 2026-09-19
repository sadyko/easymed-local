# CRM ↔ пациент ↔ визит ↔ календарь — what is wired, what was fixed, what the owner must decide

**Date:** 2026-09-20 · **Owner's ask:** "actualize the creating patient, visit and the calendar and kanban of CRM working with each other".

## How the four pieces are wired today (after CRM_LINKS_V1)

The CRM board and the appointment calendar are two separate worlds joined by one thread: the patient card. An operator takes a lead, finds or creates the patient (now through the same `savePatient` door as the front desk, with the duplicate check), picks services and gives each a date and a doctor. Those dates are saved **on the lead only** (`crm_request_services`): no visit is created and no calendar slot is held. When the patient shows up and the registrar books them (calendar, visit wizard, fast registration), the system now offers the lead's services for that day, marks those lines done and moves the card to the «won» column. Stages are read from the funnel settings everywhere, so renaming or adding a column no longer breaks the links. Registering a patient at the desk links every open lead with the same phone to that card.

## Fixed in CRM_LINKS_V1 (branch `fix/crm-links`)

1. «Записать на дату» now sets the card's date and moves it to «Записан».
2. Patient creation from a card goes through the standard door (duplicate check, branch stamp, phone linking of all open leads).
3. Booking from the calendar or the fast window picks up the lead's services for that day and closes them afterwards.
4. Funnel stage keys come from Настройки → CRM, not from lists baked into the code (eight places).
5. The call-centre report shows stage and source labels from the same settings.
6. The integration test reads the same table the screens read.

## Decisions for the owner (each changes how the clinic works, so nothing is built yet)

### D1. Should a call-centre booking hold a real slot in the calendar?
Today the operator's date is a wish written on the lead; the calendar does not see it, and two operators can sell the same hour. Options:
- **(a) Yes — a booking is a visit.** «Сохранить и записать» on the card creates the visit through the same door as the calendar (`ensure_visit` with `book`), so it appears on the calendar with the doctor and time. Requires a patient card first (the card's quick registration already exists), and a time, not just a day. Recommended: this is what "working with each other" means, and the plumbing exists.
- **(b) No — keep soft dates**, and add a "call-centre bookings for today" panel to the calendar so the desk sees them. Cheaper, but the double-selling stays.

### D2. What does «Пришёл» mean?
Today the card moves to «Пришёл» when a visit is **booked**, not when the patient **arrives**; cancelling the visit wizard after conversion still leaves the card converted. Options:
- **(a) «Пришёл» = physically arrived**: the card moves to «Записан» when a real visit exists and to «Пришёл» when the registrar marks arrival in the calendar (visit status «arrived»); the no-show sweep follows the visit's «no_show». Recommended together with D1(a). Conversion percentage becomes honest.
- **(b) Keep today's meaning** (booked = came) and rename the column «Записан к врачу».

### D3. «Подтверждён» column
Nothing ever moves a card there automatically. Keep it as a manual column for the confirmation call, or remove it from the default funnel, or wire it to a logged reminder call (Binotel/onlinePBX call record) — say which.

### D4. Where does the front desk see "who the call centre booked for today"?
Today only the registrar who opens the right patient on the right day sees it. Options: a small panel on the calendar screen (recommended), a line on the registrar's home, or nothing (if D1(a) is chosen the bookings simply appear on the calendar).

## What happens after the decisions
D1(a)+D2(a) ≈ two working days: booking door on the card (time picker, `ensure_visit` with `book`), arrival-driven stage moves (server, keyed on visit status), the sweep moved to the server on visit no-shows, tests against the real server. D1(b)/D2(b) ≈ half a day.
