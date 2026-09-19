# Doctor share with a volume tier — design (DOCTOR_TIER_V1)

**Date:** 2026-09-19 · **Status:** design; the three money decisions were taken by the owner in conversation, the rest are defaults the owner did not object to. Implementation plan follows once the owner has read this.

## Owner's ask

> By default a doctor gets 30 % of a service. If the doctor performs that type of service more than a certain number of times (say 25), the share becomes 40 %.

Owner's answers to the three questions that change the money (2026-09-19):

1. «apply only above the threshold services» — the higher percent applies to the services above the threshold, not to the whole month.
2. «per exact service, one consultation type (not by group or category)» — counting is per `services.id`.
3. «both» — a service counts toward the threshold whether or not it is paid yet.

## The rule in plain words

For each doctor and each exact service, the lines of one calendar month are numbered in the order they were performed. Lines numbered **above** the threshold are paid at the tier percent, never below the doctor's personal percent. Lines up to the threshold are paid at the personal percent. Numbering is computed live from the lines that count today, in (visit date, line id) order; a late payment of an earlier visit takes its place by date and later lines shift by one, so the line marked «ступень» can change and a weekly report can change after the fact. The month's total for a same-priced service does not change. Nothing changes for any clinic until a service has a threshold.

Example: threshold 25, personal share 30 %, tier 40 %. In September Dr A performs «Приём кардиолога» 31 times. Lines 1–25 pay 30 %, lines 26–31 pay 40 %. October starts again from 1.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Period | calendar month of the **visit date**, local time (the reports' `localDate()` helper) |
| 2 | Scope | the exact service (`services.id`) — owner |
| 3 | Which lines get the tier | only lines numbered above the threshold — owner |
| 4 | Which lines count | a line counts once it is **paid** or once the doctor has **started or finished** it (`visit_services.status` in `in_progress`, `completed`), whichever comes first. For a lab line "started" means the **sample is collected** (`collected`) — the lab's own status ladder (migration 041) runs `added → queued → collected → in_progress → resulted → completed`, and work on the line is under way from `collected`; `resulted` counts too, `queued` (waiting for the draw) does not. A registered line that is neither paid nor started does not count yet. A line removed by invoice cancellation is gone (`CANCEL_MEANS_CANCEL_V1` deletes not-started lines on void) — owner («both») |
| 5 | "More than 25" | strictly more: line 26 is the first at the tier |
| 6 | Tier vs personal rate | effective percent = MAX(personal, tier); the tier never lowers anyone |
| 7 | Number of steps | one step per service; a second step would be two more columns, not a redesign |
| 8 | Quantity | a line with quantity 3 is 3 units; a line straddling the threshold is split proportionally |

## How pay is computed today (unchanged parts)

- Personal rate per doctor per service: `users.service_rates` `{service_id, pct, fix?, branches}` (`DOC_RATE_JSON_V1`), fallback `users.service_rate_default`, then 0.
- Formula `DOCTOR_SHARE_AFTER_TAX_V1`: share = (line total − prorated invoice discount − VAT) × percent; fixed-rate lines: fix × quantity. Single server source: `ITEM_PCT_SQL` / `ITEM_FEE_SQL` in `server/services/rpc/reports.js`; client mirror `serviceShare()` in `public/js/admin/views/doctor-dashboard.js`, pinned by tests to equal the report.
- The salary report pays only lines of invoices with `status = 'paid'`, by invoice date, doctor taken from the linked `visit_services` row (`ITEM_DOCTOR_JOIN`).
- `users.salary_percent` (employee card «Percentage (%)») is not read by the pay arithmetic; the tier attaches to the per-service rate.

## Data — migration 140 (ADD COLUMN only)

```sql
ALTER TABLE services ADD COLUMN doctor_tier_from    INTEGER NOT NULL DEFAULT 0;  -- 0 = no tier
ALTER TABLE services ADD COLUMN doctor_tier_percent REAL    NOT NULL DEFAULT 0;
```

- Branch sync: both columns JOIN the catalogue sync in the fixed column list of `server/services/branch-sync/catalogue.js`, next to `default_doctor_percent` — clinic-wide pay policy travels with the price list (same deliberate asymmetry as migration 081).
- `server/db/schema-registry.js`: readable by all staff, writable by the roles that edit services.
- Services Excel export/import (`section-import-export.js`): two more columns.
- Claim number 140 after `git pull`; two machines have collided on migration numbers before.

## Server — one ranking, one place

`server/services/rpc/reports.js`:

- **`TIER_RANK_SQL`** — a CTE over `visit_services` joined to `visits` and (left) `invoice_items`/`invoices`:
  - `counted` = invoice `status = 'paid'` OR `vs.status IN ('in_progress','completed')`;
  - partition by `(vs.doctor_id, vs.service_id, month of visits.visit_date, local)`, order by `(visits.visit_date, vs.id)`;
  - `running = SUM(quantity) OVER (partition … order …)` over counted lines only;
  - `units_above = CASE WHEN tier_from > 0 THEN MAX(0, MIN(quantity, running − tier_from)) ELSE 0 END`.
  - The rank covers the **whole month**, never just the report's date range.
- `ITEM_DOCTOR_JOIN` additionally carries `MIN(vs.id) AS visit_service_id` so the ranked row joins by visit-service id (still one row per invoice item).
- `ITEM_FEE_SQL`, percentage branch: `net × (base × (qty − above)/qty + MAX(base, tier) × above/qty) / 100`, where `base` is today's `ITEM_PCT_SQL`. Fixed-rate branch unchanged.
- **New RPC `doctor_tier_positions({ doctor_id, month })`** registered in the `RPC` map of `server/services/rpc/index.js`. Returns, for that doctor and month, one row per counted line of a tiered service: `{ visit_service_id, service_id, units, units_above, tier_from, tier_percent, count_so_far }`. It uses the same `TIER_RANK_SQL`; the cabinet never re-derives positions.
- SQLite 3.53 (better-sqlite3 13) supports the window functions; verified on the dev box.

## Client — the cabinet mirrors the arithmetic, not the ranking

- `doctor-dashboard.js`: `tierShare(line, rate, pos)` next to `serviceShare()` — pure function; with `pos.units_above = 0` it equals `serviceShare()`.
- `consultation.js`, «Зарплата» tab: after `state.dash.services` is loaded, call `doctor_tier_positions` once per month touched by the chosen period and attach the positions; `computeSalary()` sums `tierShare`. One progress line per tiered service: «Приём кардиолога — 18 из 25 в сентябре · с 26-й доля 40 %»; lines paid at the tier carry a small marker.
- `reports-export.js` (Excel) keeps using the service default — pre-existing gap, out of scope.

## UI — where the two settings live

- Service editor and the services section form (`sections.js`, group «Цена, налог и длительность»), directly under «Доля врача по умолчанию, %»:
  - «Порог, услуг в месяц» — integer ≥ 0, 0 = нет ступени;
  - «Доля выше порога, %» — 0–100.
  - Validation: if one is set the other must be; help text: «Начиная со следующей после порога услуги в календарном месяце доля врача — максимум из личной и этой».
- «Зарплата врачей» bulk screen (`doctor-pay.js`): not in this version.
- Salary report: no new column; «Средний % врача» reflects the mix. Optional note row: «ступень применена: <врач> — <услуга>, <n> строк».

## Tests (patterns already in the repo)

`reports.doctor-share.test.js` style, seeded through the real migrations:

- 25 counted lines → all at 30 %; the 26th at 40 %; lines 1–25 unchanged.
- A paid line still in status `added` counts; an unpaid `added` line does not; an unpaid `in_progress` line counts.
- Voiding an invoice deletes its not-started lines and the numbering closes up.
- A doctor at 45 % stays at 45 % above the threshold.
- A fixed-rate line ignores the tier and does not disturb the numbering of percent lines (fixed lines count as units in the numbering, since the threshold measures volume, but are paid at their fixed sum).
- Quantity 3 straddling the threshold (running 24 → 27 with threshold 25): 1 unit at base, 2 at tier.
- 30 September / 1 October: the count resets.
- A weekly report inside a month already above the threshold shows the tier rate.
- `doctor_tier_positions` returns the same `units_above` the report used (same seed, both asserted).
- Migration test: defaults 0 change no existing number; the whole existing doctor-share suite passes untouched.
- Branch-sync catalogue test: the two columns travel.
- `doctor-dashboard.test.mjs`: `tierShare` with `units_above = 0` equals `serviceShare`; with a split matches the report's number.

## Risks named

- Ties in the ordering: `visit_date` then `vs.id` — deterministic.
- The clinic's pay-first flow: a paid line the doctor has not seen yet counts (decision 4) — consistent with the report paying it.
- Changing the threshold mid-month re-ranks that month live. Reports are always computed live from current settings (changing a personal rate today changes old reports the same way); the cabinet line makes it visible.
- Performance: one window over a month per doctor/service — trivial at clinic scale; `idx_visits_doctor_date` exists; add `idx_visit_services_doctor_service` only if the report measurably slows.

## Out of scope

Per-doctor overrides of the tier, several steps, bulk-setting the tier, counting per service type, personal rates in the Excel export.

## Rollout

Branch `feat/doctor-tier-percent` → tests first → review → owner tests on the test clinic → owner tags. Defaults of 0 mean no behaviour change on install.
