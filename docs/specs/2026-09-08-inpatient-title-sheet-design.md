# Inpatient title sheet (Титульный лист истории болезни) — design

Date: 2026-09-08 · Tag: `TITLE_SHEET_V1` · Status: approved by owner (design), implementation next

## What the owner asked

> "when request of hospitalization is accepted and patient is admitting to the bed, nurse should collect the title list, with personal information and anthropometric data of the patient, and it goes as a title list when history is collected."

Follow-up decisions (owner, 2026-09-08):

- **Timing:** the sheet is collected in the same step as the bed. Nurse picks the bed, then the sheet opens, pre-filled from the patient card; «Положить» saves both at once. Blank measurements are allowed (patient can't be weighed yet) and finished later from the case file.
- **Measurements:** height, weight, BMI (computed), temperature, blood pressure, pulse, plus the nurse's admission hygiene checks (pediculosis/scabies examination, sanitary treatment) and blood group/Rh confirmation.

## What exists today (and is reused)

- «Положить на койку» — `openAdmissionBedPicker` (`admission-modal.js`): a bed board that ends with one RPC, `admission_admit` (`rpc/inpatient.js`), which runs in a single transaction: checks → `admissionTransition('ordered'→'admitted')` → bed occupied → transfer row.
- The case history is a **set of 11 regulated documents** in `admission_reviews` (migration 104, `CASE_DOC_SET` in `rpc/inpatient-reviews.js`), rendered by `case-docs.js` (list) and `case-workspace.js` (A4 editor via `buildReviewEditor`). «Собрать историю» = `admission_case_file_save` → snapshot `{cover, documents, gaps}` into `visit_documents` (`doc_type='case_file'`); `caseFilePrintHtml` prints a thin cover (number, department, ward·bed, DOB, dates, attending).
- Personal data lives in `patients` (full_name, date_of_birth, gender, phone, address, national_id, occupation, emergency_contact_name/phone, blood_type — free text like `O(I) Rh+` —, allergies). `patient_vitals` has height/weight columns but the inpatient section never used it.
- Clinic letterhead for on-screen A4 documents: `a4-letterhead.js` (`clinicLetterheadData`, `a4Sheet`), data from `window.CLINIC`.

## Decision: the sheet is its own record

Chosen over (a) a twelfth entry in the doctors' document set (measurements would be free text in `body`, nurses would need the doctors' write rule) and (b) spreading fields over `patient_vitals` + new `admissions` columns (nothing would say "the sheet is complete"; vitals have no admission link).

Personal data is **never copied**: the sheet shows it from the patient card and writes corrections back to the card, so the card and the sheet cannot disagree.

## Data

Migration `110_admission_title_sheets.sql` — a plain `CREATE TABLE` (no table rebuild: see the v1.1.0 lesson, migration 109 foreign-key failure at clinic startup).

```sql
CREATE TABLE admission_title_sheets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_id  INTEGER NOT NULL UNIQUE REFERENCES admissions(id),
  referred_from TEXT NOT NULL DEFAULT '',            -- «Кем направлен»
  height_cm     REAL,                                -- 30–250
  weight_kg     REAL,                                -- 1–400
  temp_c        REAL,                                -- 30–45
  bp_sys        INTEGER,                             -- 40–300
  bp_dia        INTEGER,                             -- 20–200, < bp_sys
  pulse_bpm     INTEGER,                             -- 20–250
  pediculosis   TEXT NOT NULL DEFAULT '' CHECK (pediculosis IN ('', 'none', 'found')),
  sanitation    TEXT NOT NULL DEFAULT '' CHECK (sanitation IN ('', 'full', 'partial', 'none')),
  note          TEXT NOT NULL DEFAULT '',
  filled_by     INTEGER REFERENCES users(id),
  filled_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT
);
```

BMI is **computed, not stored** (`weight_kg / (height_cm/100)²`, one decimal) — a stored copy would drift the first time a value is corrected.

Not in the schema registry: the table is reached only through RPCs (same as `admission_reviews`), and the registry-conformance test only checks names the registry lists. Not in branch-sync `SHIPPED`: the inpatient section lives in one building.

**Completeness rule** (server, one function `sheetCompleteness(row)` → `{complete, missing[]}`): complete when `height_cm, weight_kg, temp_c, bp_sys, bp_dia, pulse_bpm` are all present and `pediculosis` and `sanitation` are answered. `referred_from`, `note`, blood group and allergies are not required (they can be legitimately unknown).

## Server (RPCs in a new `rpc/title-sheet.js`)

- `admission_title_sheet_get { admission_id }` → `{ admission (cover fields), patient (personal fields), sheet (row or null), bmi, complete, missing, due_at }`. Roles: `READ_ROLES` of the case file (admin, doctor, head_doctor, nurse, senior_nurse).
- `admission_title_sheet_save { admission_id, sheet: {...}, patient: {...} }` → validates ranges with worded errors naming the field («Рост: укажите от 30 до 250 см»), upserts the sheet row (sets `filled_by/filled_at` when it becomes complete for the first time, `updated_at` always), updates the **allowed** patient fields only (`gender, phone, address, national_id, occupation, emergency_contact_name, emergency_contact_phone, blood_type, allergies`; `full_name` and `date_of_birth` are read-only here — identity is corrected in the patient card), returns the `get` shape. Roles: `nurse, senior_nurse, admin`. Refused for admissions in `ordered` (no bed yet) or `cancelled`.
- `admission_admit` gains an optional `title_sheet: { sheet, patient }`. When present, the same transaction calls the internal save **after** the transition (so the status check inside the save passes). A validation error therefore leaves the patient **not placed** — one operation, one outcome.
- `admission_case_docs` prepends a synthetic item `kind: 'title'` (`group: 'nurse'`, `required: true`, `due_rule: 'clock'`, 2 hours from placement like consent/intake; `state`: `published` when complete (`published_at = filled_at`), `draft` when a partial row exists, `overdue`/`pending` when no row by the clock). It is counted in `progress` and `discharge_gate.incomplete` but is **excluded from `next_kind`**: "next" is the doctor's one prominent action, and the sheet is the nurse's. `CASE_DOC_SET`/`KINDS` are untouched, so `admission_review_save` still refuses `kind: 'title'`.
- `admission_case_file` adds `title_sheet` (the `get` shape minus roles) to the snapshot; the assembled file — and therefore the paper — carries the sheet as it was at assembly.

## Client

- **Bed picker becomes two steps.** `openAdmissionBedPicker` submit label becomes «Далее»; on a chosen bed it closes and opens `openAdmissionTitleSheetModal({ admission, bed, onDone, onBack })` (new `views/title-sheet.js`). «Назад» reopens the picker. «Положить» calls `admission_admit` with `title_sheet`. Width 820 so the A4 sheet (794 px) fits.
- **The form** (`titleSheetForm({ data, onChange })`, shared by the modal and the case-file editor) is rendered inside `a4Sheet({ title: 'Титульный лист' })`:
  - *Пациент* — ФИО, дата рождения (read-only, hint «исправляется в карточке пациента»); пол (select), телефон, адрес, паспорт / ID, место работы, контактное лицо, телефон контактного лица, группа крови и резус (text, placeholder `O(I) Rh+`), аллергии.
  - *Поступление* — auto: дата и время, отделение, палата · койка, плановая / экстренная, диагноз при направлении (`admission_diagnosis`), жалобы (`chief_complaint`); editable «Кем направлен».
  - *Осмотр медсестры* — рост (см), вес (кг), ИМТ (computed live, read-only), температура (°C), АД (two inputs), пульс; radio groups «Осмотр на педикулёз / чесотку»: не выявлено / выявлено; «Санитарная обработка»: полная / частичная / не проводилась; примечание. Unanswered radios are the "blank" state.
  - Numeric fields accept comma or dot; the browser's own validation is not relied on — the server's worded error is shown in a toast, and the offending field gets `aria-invalid`.
- **Case file**: `CASE_DOC_TITLE.title = 'Титульный лист'`; the list shows it first (server order −1). `case-workspace.paintPane` branches on `kind === 'title'` to `buildTitleSheetEditor(...)` which returns the same shape as `buildReviewEditor` (`{ title, icon, fields, submitLabel: 'Сохранить', submit, secondaryLabel: 'Печать', secondary }`) — no other change in the workspace. Nurses can already open the case file (`READ_ROLES`).
- **Print**: `titleSheetPrintHtml({ cover, patient, sheet, bmi, letterhead })` in `title-sheet.js` produces the A4 section: clinic letterhead (name, legal name, address, phone, logo — `clinicLetterheadData`), «История болезни № …», the three blocks as label/value rows, signature line «Заполнила: <nurse> · <time>» (or «Титульный лист не заполнен» when there is no row). Used (a) by the «Печать» button alone and (b) by `caseFilePrintHtml` **in place of the current cover**; the missing-documents list stays at the bottom of that first page.
- **Admissions already in beds** (placed before this version) have no row: the case file shows the sheet as pending/overdue and the nurse fills it there. No backfill.

## Errors

- Impossible value → the RPC refuses with the field named; in the bed step the patient is not placed and the modal stays open on the sheet.
- Network failure mid-way cannot half-place: one RPC, one transaction.
- Role refusal reuses the existing pattern («… — недоступно вашей роли. Это делает: медсестра, старшая медсестра, администратор.»).

## Translations

All new UI strings get ru/uz/en entries in `i18n-strings.js` (coverage test).

## Tests

Server (`rpc/title-sheet.test.js`, `rpc/inpatient-reviews.test.js` additions, `migrations/110.test.js`):
1. Save validates each numeric range and `bp_dia < bp_sys` with worded errors; comma decimals accepted.
2. Completeness: partial row → `complete:false` with `missing` keys; full row → `complete:true`, `filled_by/filled_at` set once.
3. Patient write-back updates only the allowed fields; `full_name`/`date_of_birth` in the payload are ignored.
4. Roles: nurse/senior_nurse/admin save; doctor is refused; cashier refused; everyone in `READ_ROLES` can `get`.
5. `admission_admit` with an invalid sheet leaves status `ordered` and the bed free; with a valid one places the patient and creates the row in the same call.
6. `admission_case_docs` lists `title` first with the right state for: no row + fresh placement (pending), no row + 3 h (overdue), partial (draft), complete (published); `next_kind` never equals `title`; `progress.total` counts it.
7. `admission_review_save` with `kind:'title'` is still refused.
8. `admission_case_file` snapshot carries `title_sheet`.
9. Migration 110 applies on a database that already has admissions, reviews and beds with referencing rows (the v1.1.0 guard pattern).

Client (`__tests__/title-sheet.test.mjs`, additions to `inpatient-route.test.mjs`, `case-*.test.mjs`):
10. Bed picker: choosing a bed and pressing «Далее» opens the sheet with the patient's data pre-filled; «Назад» returns to the board; «Положить» sends `admission_admit` with `title_sheet`.
11. BMI updates live from height/weight; comma input accepted.
12. Case file lists «Титульный лист» first; opening it renders the form on the A4 sheet with «Сохранить» and «Печать».
13. `caseFilePrintHtml` starts with the letterhead and the title-sheet blocks; the gaps list is still present.
14. End-to-end route: nurse places with a sheet → head doctor's exam → … unchanged afterwards.
15. i18n coverage.

## Out of scope (named, not forgotten)

- Mirroring height/weight/temperature into `patient_vitals` for the outpatient cabinet — possible follow-up, one INSERT on completion.
- Department profiles (DEPARTMENT_PROFILE_V2) — unchanged.
- Release notes and the release itself — on the owner's word, as always.
