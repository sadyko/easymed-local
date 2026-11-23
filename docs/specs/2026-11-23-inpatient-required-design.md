# INPATIENT_REQUIRED_V1 — switches for what is required in «Стационар», and visible marks on empty required fields

Date: 2026-11-23. Branch: `feat/inpatient-required` (from main 3f4aebc9 = v3.27.0). Next migration: 298.

## Owner request (verbatim)

> in the stationary, we have a roadblocks as a unfilled title list, reception doctor filling, and others, we need to make some settings for that so we can switch the setup of the stationary documents lists as a required, not required fields. also in the required fields of the title and other user cannot understand which fields he is not filled, cn we add visual cues for that?

Owner decisions (2026-11-23):

1. «Осмотр приёмного врача» → treating-doctor block becomes a **switch that starts ON** (today's behaviour until the clinic turns it off).
2. Three more blocks get a switch, each starting in today's position: **admitting doctor at placement**, **diagnosis in the first exam**, **discharge summary for a discharge request**.
3. Empty required field on save: **show the marks and ask whether to save anyway** (force save), not a silent save and not a hard refusal.

## What exists today (facts from the code)

| Block | Where | Hard? |
|---|---|---|
| Treating doctor only after an exam: `admissionSetAttending` asserts status ≥ `examined`; `examined` is reached only by publishing `primary` or `intake` (`rpc/inpatient-reviews.js` ~L598–610, L656–670). No treating doctor → `assertCanPrescribe` refuses orders, services, diet (`rpc/inpatient-flow.js` L295). | server | yes |
| Admitting doctor must be chosen at placement: `openAdmissionTitleSheetModal` refuses «Положить» when the doctor list loaded and nothing is picked (`views/title-sheet.js`). Server `admission_admit` already accepts no doctor. | client | yes |
| Diagnosis in «Первичный осмотр»: `isPrimary && !diagnosis` toast in the review editor (`views/admission-modal.js` ~L1256). Server does not check. | client | yes |
| Discharge request needs a published «Выписной эпикриз» when `discharge` is active in `case_doc_types` (`rpc/inpatient.js` ~L1237–1262); the checklist mirrors it in `discharge_gate`. | server | yes |
| Title sheet: 8 fixed required keys (`REQUIRED_KEYS` in `shared/title-sheet-rules.js`: height, weight, temp, bp_sys, bp_dia, pulse, pediculosis, sanitation). Does not block placement; the sheet stays «не заполнен» in the checklist; the screen only toasts «заполнен не до конца» and never names the fields. | both | no |
| Every active document of the clinic set (`case_doc_types`) is required in the checklist and turns red when late. The clinic can rename or remove a document, but cannot keep it as optional. | server | no |

## Design

### 1. Storage — migration `298_inpatient_required.sql`

- `inpatient_settings` — one row (`id INTEGER PRIMARY KEY CHECK (id = 1)`), seeded with today's behaviour:
  - `intake_before_attending INTEGER NOT NULL DEFAULT 1 CHECK (… IN (0,1))`
  - `admitting_at_placement INTEGER NOT NULL DEFAULT 1`
  - `primary_needs_diagnosis INTEGER NOT NULL DEFAULT 1`
  - `discharge_needs_epicrisis INTEGER NOT NULL DEFAULT 1`
  - `title_required INTEGER NOT NULL DEFAULT 1` — the title sheet counts as a required document
  - `title_required_fields TEXT NOT NULL DEFAULT '["height_cm","weight_kg","temp_c","bp_sys","bp_dia","pulse_bpm","pediculosis","sanitation"]'` (JSON array)
  - `updated_at TEXT`, `updated_by INTEGER REFERENCES users(id)`
- `inpatient_settings_log` (`id`, `at`, `user_id`, `field`, `old_value`, `new_value`) — who changed which switch; doc-level changes log here too with `field = 'doc:<kind>:required'` / `'doc:<kind>:sections'`.
- `case_doc_types` gains `required INTEGER NOT NULL DEFAULT 1` and `required_sections TEXT NOT NULL DEFAULT '[]'` (JSON array, subset of the document's sections).
- Every guard that lists tables (test-data wipe plan, schema/backup coverage, branch-sync lists if any) learns the two new tables: settings are clinic configuration → kept by a test-data wipe.
- Settings are read per request, never cached (same rule as `loadCaseDocSet`). A database older than 298 reads defaults = today's behaviour.

### 2. Shared rules — `public/js/shared/inpatient-required.js` (no Russian text; used by server and screen)

- `TITLE_FIELDS` — every title-sheet field a clinic may make required, with its group and where it lives (`sheet` / `patient` / `paper`):
  - patient: `gender, phone, address, national_id, occupation, emergency_contact_name, emergency_contact_phone, blood_type, allergies`
  - admission: `referred_from, delivered_by, mobility, since_onset`
  - measures: `height_cm, weight_kg, temp_c, bp_sys, bp_dia, pulse_bpm`
  - exam: `pediculosis, sanitation`
  - papers: `contract_signed, consent_signed, memo_given` (filled = the tick's timestamp is set)
  - not offered: full name and birth date (read-only identity), BMI (computed), note.
- `DEFAULT_TITLE_REQUIRED` = today's `REQUIRED_KEYS`.
- `missingTitleFields({ sheet, patient }, requiredKeys)` → array of keys.
- `sheetCompleteness(row, keys = REQUIRED_KEYS, patient = null)` keeps its signature for old callers and uses the clinic list when given.
- `missingSections(fields, requiredSections)` — a rich section is empty by `richIsEmpty`, the diagnosis by trimmed text.
- `cleanTitleRequired(keys)` → only known `TITLE_FIELDS` keys, de-duplicated; `cleanRequiredSections(list, allowedSections)` → only sections that document has (`sectionsFor(kind)` from `views/case-doc-a4.js`; the server keeps its own copy of the per-kind section list or imports a shared one — one source, not two drifting copies).

### 3. Server

- `rpc/inpatient-settings.js`:
  - `loadInpatientSettings(db)` → plain object with defaults.
  - `inpatient_settings_get` — readable by everyone who works the ward (`admin, head_doctor, doctor, nurse, senior_nurse`); listed as read-only for the licence gate. Returns the switches, `title_required_fields`, the document list with `required` / `required_sections` / `sections`, and the last 20 log lines (who, when, what).
  - `inpatient_settings_save` — `admin, head_doctor` (same circle as `DOC_TYPE_WRITE_ROLES`). Validates every key; writes only what changed; one log line per changed value; one transaction.
  - `case_doc_type_save` / `case_doc_types_list` also carry `required` and `required_sections`; `loadCaseDocSet` returns them (`required: true`, `requiredSections: []` on an old database).
- Gates read the switches:
  - **Treating doctor** (`intake_before_attending = 0`): `admissionSetAttending` also accepts status `admitted`; the route moves `admitted → active` directly (a transition allowed only while the switch is off); `examined_at/by` stay empty — nobody is recorded as having examined. The same people may assign as today (head doctor, admin, the admitting doctor of this patient). Publishing «Первичный осмотр» while `active` is accepted as a document (no route move) when the switch is off. Turning the switch back on does not move admissions that are already `active`. The implementer must check every reader of `examined_at`/`examined_by` and of the `examined` status (case overview, journals, reports, case-file cover) so an `active` admission without an exam shows correctly.
  - **Admitting doctor at placement**: server unchanged (already optional); the screen honours the switch.
  - **Diagnosis in the first exam**: screen-only check honours the switch (server never required it).
  - **Discharge summary**: `admission_discharge_request` asks for the epicrisis only when `discharge_needs_epicrisis = 1` **and** `discharge` is active in the set; `discharge_gate` in `admission_case_docs` says the same.
- Checklist (`admissionCaseDocs`):
  - A document with `required = 0` → `required: false`, `optional: true`; never `overdue` (shown as pending), never «следующий шаг», not in `progress`, not in `incomplete`.
  - The title item is required only when `title_required = 1`; its `missing` uses the clinic list (sheet + patient + papers).
  - Each item carries `missing_sections` — required sections empty in its current published edition, or in the draft when there is no published one.
  - A published document with empty required sections still counts as written (the author chose «Сохранить как есть»); the row shows the gap in amber.
- Title sheet RPCs (`admission_title_sheet_get` / `_save`) compute `complete`, `missing`, `filled_at` with the clinic list and return `required_fields` for the screen.

### 4. Settings screen — «Настройки → Стационар» (beside «Палаты» / «Койки» in the settings hub)

Visible to `admin` and `head_doctor`. Three cards and a log:

1. **«Что останавливает работу»** — four switches, each with one plain sentence for ON and for OFF:
   - «Лечащий врач — только после осмотра приёмного врача» (OFF: the treating doctor is assigned right after bed placement; the exam stays in the list as a document)
   - «Приёмный врач — обязателен при размещении на койке» (OFF: the nurse may place without one; the head doctor writes the admission exam)
   - «Первичный осмотр — только с диагнозом»
   - «Выписка — только с выписным эпикризом»
2. **«Документы истории болезни»** — «Титульный лист» first, then the clinic's active documents in their order: name · switch «Обязательный» · section chips («Жалобы», «Объективно», «Диагноз», «План», «Текст» — only the sections that document has) that toggle «обязательный раздел».
3. **«Титульный лист — обязательные поля»** — checkboxes grouped as in `TITLE_FIELDS`, labels exactly as on the sheet.
4. **«Кто менял»** — the last 20 log lines.

One «Сохранить»; unsaved changes are warned on leaving like other settings pages.

### 5. Visual cues and «save anyway» — `views/required-marks.js` + CSS

- Required label → red star (`aria-hidden`) plus screen-reader text «обязательно».
- Empty required field → red frame, light red fill, `aria-invalid="true"`, small «Не заполнено» under it. Marks update live as the user types/selects.
- At the top of the form a red line: «Не заполнено: Рост, Пульс, Санобработка». Each name is a button that scrolls to the field and focuses it.
- Marks are screen-only: `@media print` hides them, and the print HTML of the title sheet and documents does not get them.
- **Save with empty required fields** (title sheet «Положить» / «Сохранить», document «Опубликовать» / «Подписать»): an in-app dialog — title «Заполнено не всё», text «Не заполнено: …», buttons «Дописать» (closes, focuses the first empty field) and «Сохранить как есть» (saves). Saving a draft never asks. Never `window.confirm`.
- **Hard blocks** (a switch that is ON: admitting doctor at placement, diagnosis in the first exam) show the same marks but have no «save anyway»: the dialog says what is missing and only offers «Дописать».
- Checklist rows (`views/case-docs.js`): title row «не заполнено: рост, пульс»; document rows amber «пустые разделы: Диагноз»; optional rows say «по желанию» and are never red. Case overview's «Титульный лист не заполнен…» names the missing fields.
- Where it applies: the title-sheet placement window, the title-sheet editor in the case file, every case-document editor (built-in and the clinic's own documents), the treating-doctor and placement doctor pickers.

### 6. Languages, icons

Every new string in ru/uz/en (no Cyrillic in uz/en); `Icon()` only, no emoji.

## Tests

- Migration 298 test (fresh + upgrade; defaults = today).
- `inpatient-settings` RPC: roles, validation of keys/sections, log lines, read-only gate listing.
- Each of the four switches ON and OFF at the server level (attending from `admitted`, primary exam while `active`, discharge request without epicrisis, unchanged admit without doctor).
- Checklist: optional document never overdue/next/counted; title completeness with a custom field list (including a patient field and a paper tick); `missing_sections`.
- Screen: marks helper (live update, jump, print-hidden), force-save dialog (draft never asks; hard block has no «save anyway»), settings page renders and saves, nav/route guards for the new settings tab.
- Existing guard suites updated: wipe plan, RPC coverage, route gate, nav visibility, i18n completeness, release notes when released.

## Not in this change

Department profiles (different sets per department), making the title sheet block placement, hard «cannot save» mode for ordinary fields, changes to printed forms.
