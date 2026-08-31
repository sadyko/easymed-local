# Service editor: the published dialog, rebuilt for the local system

Approved by the owner 2026-08-31. Reference: the «Своя услуга клиники» editor in
the published EasyMed (corelmed.easymed.uz, `section-crud.js` CUSTOM_CLINIC_V4),
which clinic staff already know. Two deliberate improvements over the reference,
both chosen by the owner explicitly:

1. **Performers are ticked BEFORE the first save.** The published dialog says
   «Сначала сохраните услугу, затем откройте её снова» — a workaround for its
   backend, not a feature. Here: one dialog, one save.
2. **One editor everywhere.** The generic settings form for services is replaced;
   any place that creates a service opens this editor. (Today that is exactly one
   place — `sections.js` `services` → section-crud — so "everywhere" is cheap.)

## The dialog

Two columns, mirroring the published layout.

**Left — what it is:**
- Название (required)
- Раздел — routing, maps onto the EXISTING `services.type` enum:
  консультация→`consultation`, лаборатория→`lab`, процедура→`procedure`,
  диагностика→`imaging`, рентген→`radiology`, другое→`other`. No schema change.
- Тип / Категория / Отделение — comboboxes over `service_types` /
  `service_categories` / `departments`: pick existing OR type a new name
  («Выберите или впишите новую…»); a typed value is created on save.
- Кабинет — dropdown over `rooms` (nullable). Feeds the diagnostics queue.
- Lab-only block (specimen, unit, ref ranges, tube colour — the existing
  columns), visible ONLY when Раздел = лаборатория.

**Right — money and time:**
- Цена (required), НДС % (default 12), Длительность (мин, default 30)
- «Услугу оказывает специалист (врач / медсестра)» — `requires_doctor`
- «Доля исполнителя по умолчанию, %» — NEW column `default_doctor_percent`

**Below — performers:**
- «Врач» toggle switches the staff list between doctors and other staff.
  Doctors are detected by `is_doctor` — NEVER by role text or specialty
  (the invariant that broke six filters once already).
- Ticking a person writes a `{pct: <service default>}` entry for this service
  into `users.service_rates` — the SAME store the employee card edits and
  `reports.js` doctor-pay already reads, so pay reports work unchanged.
  Per-person overrides stay on the employee card; this dialog sets membership
  and the default only.
- If «оказывает специалист» is on, at least one performer is required —
  published behaviour, kept.
- Code, Активна stay (small, bottom).

## Data changes — migration 081

- `services.default_doctor_percent REAL NOT NULL DEFAULT 0`
- `services.room_id INTEGER REFERENCES rooms(id)` (nullable)

**Branch-sync asymmetry, deliberate:** `default_doctor_percent` JOINS the
catalogue sync (clinic-wide pay policy travels with the price list);
`room_id` does NOT (a room in building A means nothing in building B — the
receiving branch keeps its own NULL/local value). Both recorded as comments in
`catalogue.js`'s fixed column list, which is the guarantee-by-construction that
nothing else leaks.

## Shape

- `public/js/admin/service-editor-logic.js` — testable decisions: field
  visibility per раздел, combobox create-vs-pick resolution, performer gating,
  the `service_rates` merge (must not clobber a person's OTHER services' rates).
- `public/js/admin/views/service-editor.js` — the dialog. All strings tr()'d
  ru/uz/en; the repo-wide i18n guard enforces this at build time.
- RPC: one `service_save` that, in ONE transaction: resolves/creates the three
  combobox values, inserts/updates the service, merges performer entries into
  `users.service_rates`. Partial saves must be impossible — a service without
  its performers after a crash is the published system's bug reborn.
- `sections.js` `services` keeps its LIST (columns, search); only the add/edit
  form is replaced by this editor.

## Out of scope, deliberately

- Per-doctor share editing inside the dialog (employee card owns it).
- The medcore shared-catalog picker («Add service» from a central catalogue) —
  separate feature, separate decision.
- Any change to billing/invoices: `default_doctor_percent` feeds the existing
  pay pipeline only.

## Risks named

- `users.service_rates` is JSON edited from two places once this ships (employee
  card + this dialog). The merge in `service_save` must be read-modify-write on
  the SAME transaction and touch only this service's key.
- Migration 081 lands on databases where 080 just arrived in v0.4.6; nothing in
  081 depends on branch state — it is two ADD COLUMNs, safe on any 0.4.x.
