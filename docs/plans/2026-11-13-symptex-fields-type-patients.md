# SYMPTEX_FIELDS_V1, part 2: clinic type, doctor's patients, refused-access note

Date: 2026-11-13. Branch: `rc/3.24.0` on top of `fix/symptex-fields` (3a2c951b).

## Why

Owner, 2026-11-13: what a clinic fills in must reach the partner sites (Symptex first), complete and correct. A field-by-field check found:

- **The clinic type was empty on Symptex** because EasyMed has no such setting.
- **Branches were missing** because the clinic had removed the «Филиалы» access from the «symptex» key on 2026-11-04. Nobody noticed for 8 days.

Owner's decisions:

1. Add the clinic type to EasyMed. Symptex's four types: Клиника, Диагностический центр, Лаборатория, Детская клиника.
2. Add a children/adult option to the doctor, since EasyMed has none.
3. The changes must not affect existing clinics' settings.
4. In this update, «Настройки → API» shows what a partner can't receive with its access.

## Design

**Migration 285.** Two new columns. Both default to the empty string, so every existing clinic and doctor stays "not set", and partners receive `""` exactly as before:

- `doc_settings.clinic_type`: `''`, `clinic`, `diagnostics`, `lab` or `children`.
- `users.patients_age`: `''`, `adults`, `children` or `all`.

Each column has a CHECK on its values.

**Clinic type.**
- **Screen:** «Настройки документов» gets a «Тип клиники» select. Its empty option is «Не указан».
- **Branches:** the type is clinic-wide (`COMPANY_CLINIC_WIDE`, branch-sync `DOC_SETTINGS_COLUMNS`). A branch building receives it and doesn't edit it.
- **Writes:** `/api/db` only accepts a listed value (`storedProfileProblems`).
- **Partners:** the snapshot `clinic.type` carries it, and the public `/clinic` returns `type`. An older snapshot gives `""`.

**Doctor's patients.**
- **Screens:** «Принимает» appears in «Мой профиль» and in the employee card's public pane. The choices are взрослых, детей, or взрослых и детей; the empty option is «Не указано».
- **Saving:** one rule in `PROFILE_KEYS` and `cleanValue` covers both save paths.
- **Partners:** the snapshot carries `doctors[].patients`, and the public `/doctors` returns `patients`. An older snapshot gives `""`.

**Refused-access note.**
- **What it says:** for an active connection, the list row and the card's main tab say «Не передаётся: …», naming every read scope the key lacks.
- **Where it applies:** only EasyMed's own screen changes; the public server doesn't.

**Partner docs.** `content.js` describes both new fields in ru, uz and en. `generated.js` is rebuilt with `node public-server/scripts/docs-build.mjs`.

## Public-server files touched

The api.easymed.uz deploy kit must be rebuilt after this:

- `public-server/server/routes/partner-read.js`
- `public-server/server/docs/content.js`
- `public-server/server/docs/generated.js`
- `public-server/server/test-helpers/*`
