# Easy-Med Local — Constant Performers Design

Date: 2026-08-17
Status: approved by user (storage on the rate row, auto-assign by load,
eligibility from the rate list, employee-only share, procedures only)

## Context

Services like физиотерапия and массаж are performed by the same person every
time. Today nothing records that: the registrar cannot name a performer for a
procedure at all, so every procedure line reaches the Процедуры queue
unassigned and is claimed by whoever gets to it first.

Most of the machinery this needs already exists, which is why the change is
small. Before designing, the current state was verified in code:

- **`visit_services.doctor_id` is the performer field.** The name is historical;
  it is what the Процедуры queue scopes on and what the salary report joins.
- **Per-employee, per-service share already works.** `users.service_rates`
  (migration 021) holds a JSON array of
  `{service_id, pct, fix?, price?, branches[]}`, edited in the employee card's
  «Услуги и ставки» tab. `pct` and `fix` are mutually exclusive; `fix` is per
  unit and is not reduced by tax. `users.service_rate_default` is the fallback
  percentage. The whole chain is computed in `server/services/rpc/reports.js`
  (`ITEM_FEE_SQL`) and read for billing through
  `server/services/domain/pricing.js`.
- **The unassigned-pool fallback already works.** `views/procedures.js` shows a
  row with a performer only to that performer (`scopedProviderId()`), and shows
  a row with no performer to everyone with access, who may claim it («Взять»)
  or simply perform it — completing an unassigned row stamps the performer
  (`PROC_UNASSIGNED_V1`).
- **`doctorSalariesReport` has no role filter.** It groups by `vs.doctor_id`
  and joins `users`, so a nurse set as performer earns and reports a share with
  no query change.

Three real gaps remain:

1. Nothing can express "массаж is always performed by X".
2. The visit wizard offers a performer picker only for services with
   `requires_doctor` (`visit-wizard.js`, `schedulePanel` vs `datePanel`);
   procedure services get a date-only panel, so `doctor_id` stays NULL.
3. Only `role = 'doctor'` employees are selectable (`.eq('role','doctor')` when
   the wizard loads candidates), and «Услуги и ставки» opens only for the «Врач»
   employee category — so a nurse or массажист can be neither paid per service
   nor chosen.

### Relationship to the 2026-08-05 procedures spec

`docs/specs/2026-08-05-procedures-module-design.md` has been overtaken by the
code and must not be read as current:

- Routing moved from an `is_procedure` flag to `services.type = 'procedure'` /
  `departments.kind = 'procedure'` (`SERVICE_ROUTING_V2`).
- Its decision 1 ("unassigned rows are hidden everywhere, so the UI must require
  a performer at registration") was deliberately reversed by
  `PROC_UNASSIGNED_V1`, because procedures rarely need a named doctor and the
  hidden rows disappeared from every queue.

This spec keeps the reversed behaviour: a performer is **optional**, and its
absence means the shared pool.

## Decisions (made with user)

1. **Storage: the employee's rate row, edited from both sides.** One source of
   truth, with an editing surface on both the employee card and the service
   card.
2. **Assignment: auto-assign to the least-loaded constant performer**, with the
   registrar free to override.
3. **Eligibility: having the service in the rate list.** «Услуги и ставки» opens
   to every employee category; a row there means "this person performs this
   service".
4. **Share: employee-only.** No service-level default share; the existing
   precedence chain is unchanged.
5. **Scope: procedure-type services only.** Consultations, lab and imaging keep
   today's behaviour exactly.

## User-facing behavior

**Settings → Сотрудники → (employee) → «Услуги и ставки»**
Available for every employee category, not just «Врач». Each service row gains a
«Постоянный исполнитель» checkbox next to the existing price and percentage
fields. Ticking the row alone means "can perform this, chosen manually"; ticking
постоянный as well means "assign this to them automatically".

**Settings → Услуги → (service) → «Исполнители»**
Lists the employees who have this service in their rate list, marking the
constant ones, and allows adding or removing them. Edits write back to those
employees' rate rows — the same data as above, seen from the other side.

**Registration (visit wizard)**
Adding a procedure-type service now shows a performer field beside the date.
When the service has constant performers, the least-loaded one is pre-selected;
the registrar may pick anyone else eligible, or «— не назначать —» to send the
line to the shared pool deliberately. Services with `requires_doctor` keep the
existing doctor picker and scheduler, unchanged.

**Процедуры**
Unchanged in substance. A row assigned to someone shows only to them; an
unassigned row shows to everyone with access, who can claim or perform it. The
only addition is a label marking a performer as постоянный.

**Зарплата / доля**
Unchanged. Once `doctor_id` is set, the existing calculation applies whatever
the performer's role.

## Data model — no migration

`users.service_rates` is a TEXT column holding JSON, so the new key needs no
DDL:

```json
{ "service_id": 42, "pct": 40, "fix": 0, "price": 0, "branches": [1], "constant": 1 }
```

A rate row written before this feature has no `constant` key, which reads as
"eligible, not constant" — existing data and the current test suite are
unaffected by construction.

The row now carries three facts that cannot drift apart, because there is
nowhere for them to drift to:

| Fact | Expressed by |
|---|---|
| may perform this service | the row exists |
| what they earn for it | `pct` or `fix` |
| assigned automatically | `constant` |

`constant` is coerced to 0/1 server-side in `server/routes/users.js`, alongside
the existing clamping of `pct` and validation of `fix`/`price`.

## Component changes

### New — `server/services/domain/performers.js`

The single answer to "who performs this service", in the same spirit as
`pricing.js` ("no handler reads `users.service_rates` for money itself"). No
view or route derives performer eligibility on its own.

- `performersFor(db, serviceId, { branchId })` → eligible employees with
  `full_name`, `role`, `constant`, and their current open-work count.
- `pickPerformer(db, serviceId, { branchId })` → the auto-assignment, or `null`
  when the service has no constant performer.

Rules:

- **Eligible** = a rate row for this service exists, on a user with
  `is_active = 1`, whose row's `branches` is empty (all branches) or contains
  the visit's branch.
- **Load** = count of that user's `visit_services` rows in status
  `('added','queued','in_progress')` **across all services, not just this one**
  — the question being answered is "who is free", and a массажист already
  holding six unrelated procedures is not. It is work currently in hand rather
  than a daily quota, so it self-corrects as people clear their queue.
- **Pick** = among constant performers only, `ORDER BY open_count ASC, user_id
  ASC`. The `user_id` tie-break keeps the choice deterministic and testable.
- Corrupt or non-JSON `service_rates` is skipped, not fatal — the same
  `json_valid()` guard `pricing.js` and `reports.js` already use.

### New RPC — `service_performers`

Registered in `server/services/rpc/index.js` and reached through the existing
`POST /api/rpc/:name` route. Takes `{ service_id, branch_id }`, returns the full
eligible list with a `suggested` flag on the auto-pick.

One round trip: the client prefills `suggested` and renders the rest as the
override list. The decision lives server-side where it can be tested, and other
call sites (a doctor adding a procedure mid-consult, the admission modal) can
adopt the same RPC later without re-deriving the rule.

### `server/routes/users.js`

Accept `constant` on incoming `service_rates` entries and persist it as 0/1.

### `public/js/admin/views/employee-editor.js`

- Open the «Услуги и ставки» tab to all employee categories. The gate is on that
  tab only — the neighbouring Лицензия and Реферальные вознаграждения sections
  stay doctor-only, since widening those is not asked for and carries its own
  meaning.
- Add the «Постоянный исполнитель» checkbox per service row and include
  `constant` when building the `service_rates` payload.

### `public/js/admin/views/services.js`

New «Исполнители» block on the service card. It reads the current performers
from `service_performers`; **adding** one needs the full staff list, so the
picker reads active employees the same way the section already loads staff
elsewhere, and is not limited to those who happen to have a rate row. Saving
writes the rate row (with its `constant` flag, and a share the admin fills in
there) back onto the chosen employee through the existing employee update path —
so a performer added here is immediately visible in that employee's «Услуги и
ставки» tab, and vice versa.

### `public/js/admin/views/visit-wizard.js`

For procedure-type services, replace the date-only panel with date + performer.
Candidates come from `service_performers`, constant ones listed first, with
«— не назначать —» as an explicit option. The `requires_doctor` branch and its
`.eq('role','doctor')` load are left alone.

### `public/js/admin/views/procedures.js`

Label a постоянный performer in the row subtitle. No behavioural change.

## Enforcement level

As with every converted module, the flow is enforced in the UI; the compat layer
provides generic authenticated table access with role checks from
`role_permissions`. The one piece deliberately placed server-side is the
performer decision itself, because it is arithmetic over other people's data and
must give the same answer to every caller.

## Error handling

- A failed `service_performers` call leaves the performer field empty with a
  toast; the line is still bookable and lands in the shared pool. Auto-assign is
  a convenience and must never block registration.
- A constant performer who becomes inactive or loses the rate row simply stops
  being eligible; existing `visit_services` rows keep their `doctor_id` and
  their recorded share.

## Testing

Domain-level, following how `server/services/domain/pricing.test.js` covers its
module:

- `performers.test.js` — least-loaded selection; deterministic tie-break;
  branch narrowing (empty `branches` = all); inactive users excluded;
  no constant performer → `null`; non-constant eligible users never auto-picked;
  corrupt `service_rates` tolerated.
- `users.test.js` — `constant` round-trips and is coerced to 0/1.
- `reports` — a **nurse** performer earns and reports a share. This is the case
  that would regress silently, since it depends on `doctorSalariesReport` having
  no role filter.

Manual acceptance: mark a nurse as constant performer of массаж with 40% →
register a visit with массаж → the wizard pre-selects her → invoice paid → the
row appears in her Процедуры queue and nobody else's → she performs it → the
salary report shows her with the correct доля.

## Out of scope (YAGNI)

- A service-level default share (explicitly declined — share stays on the
  employee).
- Constant performers for consultation, lab or imaging services.
- Scheduling, capacity, shift or absence awareness. "Least loaded" counts open
  work only; it does not know who is on holiday.
- Auto-assignment on `visit_services` inserts made outside the wizard. Those
  inserts go through the generic schema-registry query compiler, and hooking
  every insert would mean special-casing that compiler. Such rows land
  unassigned in the shared pool, which is correct under the fallback rule; the
  affected call sites can adopt the RPC later.
- Renaming `visit_services.doctor_id` to something honest like `performer_id`. It
  is referenced across reports, billing, the doctor workspace and several views;
  the rename is worth doing but is not this change.

## Success criteria

1. An employee of any category can be given a service with a percentage or a
   fixed sum, and be marked its constant performer, from either the employee
   card or the service card — with both screens showing the same state.
2. Adding such a service in the visit wizard pre-selects the least-loaded
   constant performer, and the registrar can override it or clear it.
3. A service with no constant performer behaves exactly as today: the line goes
   unassigned and every user with access to Процедуры sees it, can claim it, and
   can confirm it performed.
4. A nurse who performs a procedure appears in the salary report with the share
   configured on her rate row.
5. Consultation, lab and imaging registration is unchanged, and all existing
   tests still pass.
