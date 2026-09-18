# Plan: departments — head, team, rooms, supplies (DEPARTMENTS_V1)

Owner (2026-09-18): «Build Department Settings, Room Linking, and Procurement
Dispensing … Create department → Assign head → Link rooms → Form department →
Dispense supplies → Track department resources.»

Answers to the gap questions (2026-09-18):

1. Head — a doctor or a nurse only. 2. No head history. 3. No new kinds; the
department is a name for grouping, dispensing and statistics. 4. No specialty
field. 5. Wards too — «2nd floor can have stationary department in which there
is wards and beds». 6. Both doors: requisition and direct issue; procurement
can issue to a room, cabinet, department or nurse. 7. No returns — «just
dispense items and fact check for using for the patient». 8. Admin sees all;
a nurse sees what her room / department holds and her own. 9. The flow: form
department → select team → confirm cabinets → the floor plan (#rooms-setup).

## What already exists (the audit)

- `departments (id, name, code, kind, active)` — 15 rows in the test clinic.
  Настройки → Отделы is a generic three-column CRUD in `settings-hub.js`.
  `sections.js` has a richer cloud-era config (head_user_id, floor_id, names in
  three languages) whose columns the offline database does not have.
- `rooms.department_id`, `wards.department_id` (migration 108) — one department
  per room, set on the floor-plan screen (`rooms-setup.js`).
- `users.department_id`, `users.position`, `users.is_doctor`, roles.
- `stock_holdings (holder_type staff|room|department, holder_id, product_id, qty)`
  (migration 128) + `stock_movements.holder_type/holder_id`. `issue_stock_lines`
  moves warehouse → holder; `dispense_from_holding` moves holder → patient
  (visit_services / admission_services). `holdings_list` reads balances.
- Requisitions: `purchase_requisitions` (department_id, requested_by, status),
  items; `approve_requisition_and_issue` deducts the warehouse but — written
  before migration 128 — does NOT credit the department's holding; and the
  client's `create_requisition` RPC is NOT implemented on this server (the
  «Новая заявка» button in Закупки returns «RPC not implemented»).
- Permissions: sections + the grants matrix (`permission-catalog.js`,
  `server/services/grants.js`).

## Data (migration 138 — ADD COLUMN / CREATE TABLE only)

- `departments.head_user_id INTEGER` (nullable, references users).
- `department_events (id, department_id, kind, actor_id, details TEXT, created_at)`
  — the activity history: created, updated, head_changed, member_added,
  member_removed, room_assigned, room_removed, issued, requisition_created.
- `stock_issue_receipts (key TEXT PRIMARY KEY, result TEXT, created_at)` — an
  idempotency key for `issue_stock_lines`: the same key returns the stored
  result instead of deducting twice.

## Server (server/services/rpc/departments.js, registered in index.js)

- `department_list` → rows with head, member count, room+ward count, held
  product count. Visible to holders of the settings section / grant; a plain
  member gets only their own department (the card link).
- `department_card {department_id}` → overview, members (with position and
  role), rooms and wards grouped by floor, holdings, issues (movements
  reference_type='issue' for the holder), usage for patients (movements
  reference_type in visit/admission for the holder, with the patient's name),
  events, open requisitions.
- `department_form {id?, name, code?, kind, active, head_user_id?, member_ids[],
  rooms:[{type:'room'|'ward', id, reassign:bool}]}` — one transaction: create or
  update the department; head must be a doctor or a nurse (is_doctor or role
  doctor/head_doctor/nurse/senior_nurse) and is always a member; members are
  `users.department_id` — a member who belongs to another department moves
  ONLY when sent with `reassign:true` (the screen asked); a room/ward owned by
  another department moves only with `reassign:true`; rooms no longer in the
  list are released (department_id NULL). Events written for every change.
  Roles: admin, or grant `settings.departments` ≥ edit.
- `department_member_set {department_id, user_id, on:bool, reassign?}`,
  `department_room_set {department_id, type, id, on:bool, reassign?}`,
  `department_head_set {department_id, user_id|null}` — the card's small edits,
  same rules.
- `issue_stock_lines` gains `idempotency_key` and writes a `department_events`
  row when the holder is a department. Grant row `procurement.issue`
  (fallback roles admin, inventory).
- `create_requisition {p_department, p_notes, p_lines}` — implemented: number
  `REQ-YYYYMMDD-NNN`, status 'submitted', items in base units. Roles as the
  registry says (admin, inventory, doctor, nurse). Event on the department.
- `approve_requisition_and_issue` — when the requisition names a department,
  the issue credits the department's holding and the movement carries the
  holder (the same move as `issue_stock_lines`).

## Client

- Route `departments` (+ sub-route `departments/<id>` for a card). Settings hub
  tile «Отделы» opens it. Breadcrumb, PARENT_OF, view switch, isRouteAllowed:
  settings (or grant `settings.departments` ≥ view).
- `views/departments.js`: list (Отдел · Вид · Руководитель · Помещения ·
  Команда · Статус), «Сформировать отдел», wizard (Отдел → Команда →
  Помещения → Проверка → «Сформировать отдел»), card with tabs Обзор /
  Помещения / Команда / Снабжение / История. After forming: the card + a link
  «Расставить на плане» → `rooms-setup`.
- `views/stock-issue-modal.js`: the issue dialog with product search, several
  lines, available stock, the consumption unit, a note, a review step
  («Подтвердить выдачу»), an idempotency key per opening; the holder is fixed
  when opened from a department and picked when opened from Склад (which now
  uses this dialog instead of its own).
- Requisition from the card: the existing «Новая заявка» dialog logic, department
  fixed.
- Permission catalogue: `settings` gets window `settings.departments`
  (view/edit); `procurement` gets action `procurement.issue` (none/edit).
- i18n: every new Russian literal in ru/uz/en.

## Tests

- `departments.test.js`: form (create, head rule, member reassign rule, room
  reassign rule, release of removed rooms, events), card shape (holdings,
  issues, usage), permissions (nurse sees own card only; registrar refused).
- `procurement.test.js` additions: idempotency key returns the same result and
  deducts once; requisition create + approve credits the department holding.
- `roles-editor.test.mjs` unchanged; `grants.test.js` catalogue honesty covers
  the two new rows automatically.
- Browser probe on a copy of the database: form «Кардиология-2» with a head, a
  team and rooms; reassign warning; dispense 2 lines; history and balance.

## Out of scope

Batches/expiry on issues, returns to the warehouse, head history, specialty,
new department kinds, department-level valuation.
