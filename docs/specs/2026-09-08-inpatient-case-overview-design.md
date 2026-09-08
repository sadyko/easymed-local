# Case overview (Обзор госпитализации) — design

Date: 2026-09-08 · Tag: `CASE_OVERVIEW_V1` · Status: approved by owner ("yes")

## What the owner asked

> "here is the list of the hospitalized patients. when pressed, it should open the dashboard like window for the chief doctor/or doctor with general information about patient status/diet/diagnosis and the overview of the patient. prescription made/services provided/ operation status/ diagnosis is set or etc. also when patient pressed it should open a cabinet like documents section."
>
> "in the header navigation between the patients for the doctors … list of the patients → pressed opens a patients dashboard and main action → opens the documents to fill for the doctor. but in the dashboard we can see status of the patient, services prescription, and discharge button with generating the payments."

Reference: Aurora `Госпитализации.html` → `InpCard` (full-screen case card: header with patient, № истории, days, ward · bed, attending, allergy warning; tabs).

## Decision: one case screen, two tabs, shared header

- Route `case-overview` (new) = the doctor's dashboard. Route `case-file` (existing documents cabinet) = the «Документы» tab. Both render the same **header** (`caseHead` in `views/case-overview.js`).
- Rows in «Пациенты» and in «Госпитализации» open `case-overview`. The patient's name/avatar and the «Документы» tab open `case-file`. The main action «Заполнить историю болезни» opens `case-file` on the next document due (`next_kind` of the checklist).
- Header navigation between patients: «‹» «›» + «N из M» over the ward list (in-bed admissions ordered by ward, bed). A plain doctor with assigned patients cycles through their own; head doctor / admin / nurses through everyone.
- Rejected: dashboard as a pop-up over the list (the owner removed that dialog earlier; it cannot host the documents cabinet).

## Server: `admission_overview { admission_id }` (`rpc/case-overview.js`)

Read roles = case-history read roles. Returns, assembled from existing tables (no schema change):

- `admission` (cover: no, status, department, admitted_at, ward · bed, attending, planned/actual discharge, outcome, days in ward), `patient` (name, mrn, dob, gender, allergies, blood type).
- `title_sheet`: complete flag, measurements, BMI.
- `diagnosis`: `referral` (admission_diagnosis), `clinical` (latest current published primary examination), `outcome`.
- `diet`: current table (code, name, since) or null; `meals_today` counts by status.
- `orders`: `active` count by kind, `today: { due, given, refused, missed, held }`, `list` (first five active: name, dose, route, freq).
- `services`: totals (count, billed, unbilled billable, sums) and `list` (first six: name, qty, total, invoiced, performed_at).
- `operation`: `state` `none | planned | done`, `at` (protocol publish time) — derived from published anesthesia/preop/operation documents and surgery services on the admission.
- `bill`: accommodation (`stay_units`, current net), invoices (`total`, `paid`, `debt`, list).
- `docs`: `progress`, `next_kind`, `overdue`.
- `discharge`: status, requested_at, planned_at, outcome, discharged_at.
- `neighbours`: `{ prev: {id, full_name} | null, next: …, index, total, mine }`.

## Server: discharge request with the bill

`admission_discharge_request` gains `generate_bill` (boolean, the dashboard sends `true`). In the same transaction, after the request is accepted: bill the accommodation up to now (skip when no new days), gather every unbilled billable `admission_services` row into one hospitalization invoice (`billing.js` → new exported `buildAdmissionInvoice(db, admissionId, ids, user)`, the role-free half of `createInvoiceForAdmission`). Returns `bill: { invoice_number, total_amount, items, accommodation_units } | null`. The senior nurse's discharge screen sees the invoice as today.

## Client

- `views/case-overview.js`: `renderCaseOverview(container, { payload, onNavigate })`, `caseHead(ov, { active, onNavigate, onReload })`, block builders. Blocks: Статус · Диагноз · Состояние при поступлении · Питание · Назначения · Услуги · Операция · Счёт · История болезни · Выписка; each with a link («Открыть») to the screen where the work is done (documents, treatment sheet, diet modal, cashier).
- `admission-modal.js`: `goToCaseOverview(admissionId, onNavigate)`; `openAdmissionDischargeRequestModal` accepts `generateBill` and shows «Счёт № … на … сум передан в кассу».
- `case-workspace.js`: loads the overview too, renders `caseHead(…, { active: 'documents' })` above the rail; `payload.kind` opens that document.
- `admissions.js` (`inWardCard`) and `ward-beds.js` (`admissionsTable` rows) navigate to `case-overview`.
- `admin.js`: route, `CRUMBS['case-overview']`, parent map.

## Tests

Server: overview shape and derivations (diagnosis, diet, orders today, services, operation states, bill, neighbours for doctor vs head doctor, days); discharge with bill (accommodation + services → invoice; nothing → null; still refused without epicrisis); roles.
Client: row click → `case-overview`; header (name, days, nav arrows → prev/next ids, avatar → `case-file`, main action → `case-file` with `kind`); blocks render; discharge modal sends `generate_bill`; case-file shows the head; i18n.

## Out of scope

Vitals charting, transfers between beds, OR module (operation status is derived, not managed), obstetrics.
