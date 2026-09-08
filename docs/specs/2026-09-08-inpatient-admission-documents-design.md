# Admission documents (Документы при поступлении) — design

Date: 2026-09-08 · Tag: `INPATIENT_DOCS_V1` · Status: approved by owner ("yes go ahead. build as planned")

## What the owner asked

> "in the dialogue window of the editing patients information we need to add a 3 types of the documents: 1) hospitalization agreement 2) informed consent 3) stationary pamyatka … also we need to add a documents content into a documents section"

Reference sheets (Aurora prototype, three PDFs on the Desktop): the same layout for all three — clinic header (logo, name, Uzbek name, address), title in capitals with an Uzbek subtitle and the date, a row Пациент / Bemor · Отделение · Палата / Койка · Лечащий врач, the text paragraphs, two signature lines (Пациент / Bemor, Врач / Shifokor). The hospitalization dialog shows «ДОКУМЕНТЫ ПРИ ПОСТУПЛЕНИИ» with three buttons.

Owner decision (2026-09-08): **print and record signing** — a tick «подписан» / «выдана» per document, saved with the title sheet; placement is not blocked by unsigned papers.

## Decision: three document types in the existing «Документы» designer

The designer (`views/documents.js` + `views/doc-settings.js` + `shared/doc-render.js`, storage `doc_branding.settings` JSON) already gives every printed form its clinic header, accent, paper size, live preview and the single `printableSheet()` print path. The three admission papers become three more document types there, with their **text editable in the designer** (one text box per document, paragraphs separated by blank lines, defaults = the Aurora wording). Rejected: texts hard-coded in the program (clinics could not change a clause; no "documents content in the documents section").

## Renderer (`public/js/shared/doc-render.js`, shared with the server's PDF path)

- `INPATIENT_DOC_TYPES = ['inpatient_contract', 'inpatient_consent', 'inpatient_memo']`; `INPATIENT_DOC_META[type] = { titleRu, titleUz, textKey }`; `INPATIENT_DOC_DEFAULT_TEXT[textKey]` = the Aurora paragraphs; `inpatientDocText(s, type)` = the clinic's text from settings or the default (so a clinic that never opened the designer still prints the full text).
- `inpatientDocBody(s, d, type)`: `headerHTML(s)` → title (accent colour, capitals) + Uzbek subtitle + date → four fields (blank underline when a value is missing — the attending doctor is normally not assigned yet at placement) → paragraphs → two signature lines → `footerHTML(s)`. Data `d = { patientName, department, ward, bed, doctorName, date }`; without `d` a sample patient renders (designer preview).
- `renderBuiltinBody` dispatches the three types; `titleFor` names them.

## Designer (`views/documents.js`, `views/doc-settings.js`)

- `DOC_TYPES` gains three tabs: «Договор на госпитализацию» · «Информированное согласие» · «Памятка стационара» (A4).
- When one is active, the settings panel shows a card «Текст документа» with one large text box bound to `settings[textKey]`; the live preview re-renders as the clinic types; «Save» stores it with the rest (JSON blob, no migration).
- `DEFAULT_DOC_SETTINGS` carries the three default texts; `DOC_VARIANTS` lists one «Классический» variant each.

## Placement window and case-history title sheet (`views/title-sheet.js`)

A fourth block «Документы при поступлении» in the shared form: three rows — document name · «Печать» · tick «подписан» (memo: «выдана»). «Печать» calls `printableSheet({ type, data })` with the patient's name, department, ward · bed and attending doctor from the current view. The ticks travel in `read().sheet` as `contract_signed`, `consent_signed`, `memo_given` (booleans) and are pre-filled from the saved timestamps.

## Data and server

- Migration `111_admission_title_sheet_papers.sql`: `ALTER TABLE admission_title_sheets ADD COLUMN contract_signed_at TEXT`, `consent_signed_at TEXT`, `memo_given_at TEXT` (plain add-column; safe with existing rows).
- `saveTitleSheet`: a tick sets the timestamp once (kept on later saves), an untick clears it. Same roles as the sheet.
- `sheetView` returns the columns with the sheet; `titleSheetCaseItem` adds `papers: { contract_signed_at, consent_signed_at, memo_given_at }`. Completeness of the sheet is unchanged (measurements only).

## Where signing shows

- Printed title sheet: a line «Документы при поступлении: Договор — подписан 08.09.2026 12:10 · Согласие — подписано … · Памятка — выдана …» (or «не подписан» / «не подписано» / «не выдана»).
- Case-history list: the «Титульный лист» row gets a second line with the same words (`papersSummary()` in `title-sheet-print.js`, used by both).
- Title-sheet editor status line: same summary.

## Tests

1. Renderer: each type renders its RU title, UZ subtitle, the default paragraphs, the clinic's own text when set, the patient's name, blank underline for a missing doctor, both signature labels; unknown data → sample.
2. Designer: `DOC_VARIANTS` and `DEFAULT_DOC_SETTINGS` carry the three types/texts.
3. Server: migration 111 columns; tick sets timestamp once and untick clears it; `admission_case_docs` title item carries `papers`.
4. Client: the form has three «Печать» buttons that call the injected printer with the right type and data; ticks travel in `read()`; printed title sheet and case list show the summary.
5. i18n coverage.

## Out of scope

Blocking placement on unsigned papers (owner chose not to); a signed-scan upload; per-department document sets.
