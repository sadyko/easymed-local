# Easy-Med Local — Procedures Module Design

Date: 2026-08-05
Status: approved by user (assigned-performer scoping, is_procedure flag routing)

## Context

Procedures are services performed by nurses/doctors in the procedure room
(injections, IV drips, manipulations). Today a registered service either goes
to the doctor cabinet or (if `is_lab`) to the Laboratory worklist. The user's
requirement: **a service registered as a procedure must route to a Procedures
queue, not to the doctor** — with the same work-process logic as cloud
easymed.uz.

The parked cloud view `public/js/admin/views/procedures.js` is the reference
implementation of that logic: statuses, payment gate, per-performer scoping,
product dispensing. This spec adapts it to the local backend, following the
same conversion pattern used for the Laboratory module.

## Decisions (made with user)

1. **Queue scoping — assigned performer** (cloud parity): the registrar picks
   a performer when registering a procedure service; each performer sees only
   their own queue; admin sees all assigned rows. Unassigned rows are hidden
   everywhere, so the UI must require a performer at registration.
2. **Routing — `is_procedure` flag on services**, mirroring the existing
   `is_lab` pattern (not department-based routing, not a type enum).

## User-facing behavior

- New sidebar screen **"Процедуры"** — the procedures work queue.
- Registrar registers a visit and adds services as today. A service marked
  "Procedure" routes to the Procedures queue with its assigned performer.
  It does **not** appear in the doctor cabinet's work queue.
- Statuses (identical to cloud): `added` (Назначено — направлен, ждёт оплаты)
  → `queued` (В очереди) → `in_progress` (Выполняется) → `completed`
  (Выполнено).
- **Payment gate:** Start/Complete actions are disabled while the visit's
  invoice is unpaid — same rule and mechanism as the Laboratory worklist
  (`added` renders as "awaiting payment"; the existing billing flow advances
  rows after payment exactly as it does for labs today).
- Completing a procedure records performer and timestamp, and optionally
  dispenses used products (syringes, IV materials) via the existing item
  picker, writing `stock_movements` so inventory is deducted.
- Search and status filter chips as in the parked view.

## Data model — migration `016_procedures.sql`

```sql
ALTER TABLE services       ADD COLUMN is_procedure INTEGER NOT NULL DEFAULT 0;
ALTER TABLE visit_services ADD COLUMN verified_at  TEXT;
ALTER TABLE visit_services ADD COLUMN verified_by  INTEGER REFERENCES users(id);
```

- `verified_at` / `verified_by` use the cloud column names so the parked view
  maps over with minimal edits; the labs module may adopt them later (out of
  scope here).
- `visit_services.status` is free-form TEXT already using these exact values —
  no constraint change.
- New columns are registered in the compat layer's schema registry.
- Per-migration test `016.test.js` follows the existing pattern (columns
  exist, defaults correct, migration idempotent under the runner).

## Component changes

### Settings → Services (`views/services.js`)
- "Procedure" checkbox in the service form next to "Lab test"; checking one
  unchecks the other (UI-level mutual exclusivity only — the DB does not
  enforce it).
- "Procedure" badge in the services list, like the existing "Lab" tag.

### Registration (service picker)
- `visit_services.doctor_id` is the performer field (already exists). When a
  procedure service is added to a visit, the picker must require selecting a
  performer from active users with role `nurse` or `doctor`. If the picker
  already supports per-service doctor selection, this is a required-field
  tweak; otherwise a performer dropdown is added for procedure rows.

### Procedures worklist (`views/procedures.js`, adapted from parked cloud view)
- Strip cloud-isms: `company_id`, `window.CLINIC`, RLS assumptions,
  department-kind routing check.
- Filter: rows whose service has `is_procedure = 1` and `doctor_id` not null.
- Scope: performer sees own rows (`doctor_id = current user`); admin sees all.
- Actions: Start (`queued` → `in_progress`), Complete (→ `completed`, sets
  `verified_at` = now, `verified_by` = current user), both gated on payment.
- Product dispensing via `item-picker-modal` on completion (optional step).

### Doctor cabinet exclusion
- The doctor's own work queue (consultation/visit views) excludes rows whose
  service is `is_procedure = 1` — that is the core routing requirement. The
  exact filter location (consultation.js / visits.js) is confirmed during
  implementation planning.

### Wiring
- Router + sidebar entry for the Procedures screen.
- `role_permissions`: add `procedures` section — `admin`: admin, `nurse`:
  editor, `doctor`: editor. Registrar and cashier get no access. Delivered as
  an UPDATE in migration 016 (permissions live in the DB).

## Enforcement level

Like every converted module, status transitions and the payment gate are
enforced in the UI; the compat layer provides generic authenticated table
access with role checks from `role_permissions`. No bespoke server routes.

## Error handling

- Load/update failures surface through the existing toast pattern (as in the
  parked view and Laboratory).
- Completion with product dispensing performs the stock write first and only
  then marks completed; a dispensing failure leaves the row `in_progress` and
  shows a toast, so no procedure is marked done with unrecorded materials.

## Testing

- `016.test.js` — migration/schema test (pattern of 002–015 tests).
- Smoke path (manual acceptance): create procedure service → register visit
  with it + performer → invoice paid → performer sees row, starts, completes
  with product dispensing → stock decremented, `verified_*` recorded → row
  absent from doctor cabinet queue.

## Out of scope (YAGNI)

- Multi-session course tracking beyond `quantity`.
- Department-based routing/teams; diagnostics (PACS) routing.
- Printed procedure sheets; labs adopting `verified_*` columns.

## Success criteria

1. A service with the Procedure checkbox never appears in the doctor cabinet
   queue and always appears in the Procedures queue of its assigned performer.
2. The performer cannot start/complete before the invoice is paid.
3. Completion records who performed it and when; dispensed products reduce
   stock.
4. Admin sees the full assigned queue; nurses/doctors see only their own.
5. Existing labs, billing, and doctor flows are unaffected (all current tests
   still pass).
