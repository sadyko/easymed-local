# One "new patient" window everywhere a patient is created inside a flow (QUICK_PATIENT_V1)

**Date:** 2026-09-21 · **Owner:** "the linking patient, and the creating patient in the linking, in the calendar and in the calculator should add a new patient by flow of fast registration" (screenshot: the calculator's «Привязать пациента» → «Новый пациент» mini form with five fields).

## Design

- New module `public/js/admin/views/quick-patient-modal.js` → `openQuickPatientModal({ onCreated, onNavigate, title = 'Новый пациент' })`: gate `canCreatePatient()` / `openAccessDeniedDialog()`; a wide card (`modal-card fr-card`, z-index above the catalogue picker and its attach modal); body = `buildPatientFields(body, { layout: 'compact', withSearchStrip: false })` — exactly the «Реквизиты пациента» block of «Быстрая регистрация» (ФИО, дата рождения, пол, телефон, паспорт, резидентство, область, адрес, тип скидки); a hint «Полная анкета — в карте пациента»; footer «Отмена» / primary «Создать пациента» (Enter). Save = `collect()` → `savePatient(payload)`; on `DUPLICATE_PATIENT` the standard duplicate dialog: «Открыть существующего» → `onCreated(existing)` (link the found card), «Создать принудительно» → `savePatient(payload, { force: true })`. Returns the shaped patient to `onCreated`, then closes.
- **Calculator / calendar** (`service-picker-modal.js`, attach step): the inline «Новый пациент» mini form is replaced by the quick window; the created patient is attached (`attachPatient(p)`). The footer «Создать пациента» (`onCreatePatient`, the full form) stays as the door to the full анкета.
- **CRM card** (`crm.js` `patientRegistrationModal`): replaced by the quick window; the card's `finishRegistration(row)` runs as `onCreated`.
- «Быстрая регистрация» keeps rendering the block inline (it is the same builder).

## Tasks
- **Q1** the module + tests (fake DOM; gate; compact labels; save → `savePatient`; duplicate → use existing; Enter).
- **Q2** picker attach step uses it (+ `service-picker-attach.test.mjs`); z-index pin.
- **Q3** CRM card uses it (+ `crm-card.test.mjs` adjusted: registration issues no direct insert, duplicate → link).
- Ship in 3.4.0 together with CALLCENTER_OPERATOR_V1 and CRM_REAL_BOOKING_V1.
