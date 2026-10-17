# CRM_ONE_WAY_V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A booked service exists only as a visit line. The CRM card holds wishes and pointers ("booked lines") into the visit; the two-way copy mirror (`mirrorVisit`, CRM_CALENDAR_MIRROR_V1) is retired, so cancel / restore / move can no longer double a bill or lose a service.

**Architecture:** One new module `server/services/crm/one-way.js` holds every rule O1–O7 (attach a wish, a wish's line yields to a human line, adoption, O3 remove/release, O4 release, O5 restore, O6 follow). `booking-mirror.js` keeps only the shared helpers (pricing, "free line", same-service keys, card date, «Отказ»). Every door that called `mirrorVisit` calls the one-way function that matches what it did (door table below). The funnel fixes of round 3 (O10) live in `visit-status.js`. The upgrade repair (O8) is a one-off like `unify-repair.js`. The card UI (`views/crm.js`) stops re-inserting lines on save, locks the day/doctor of booked lines and acts on the visit for add/remove.

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, vanilla-JS SPA (`public/js/admin/`), `node:test` (`node --experimental-vm-modules --test`), dictionary `public/js/admin/i18n-strings.js` (ru/uz/en), Playwright (own server, random port, temp data dir).

**Spec (the contract):** `docs/specs/2026-10-17-crm-one-way-booking-design.md` (O1–O10). Display links and P-1…P-7: `docs/specs/2026-10-16-crm-link-all-doors-design.md` (Revision 2/2b) — unchanged (O9).

---

## Ground rules (read once)

- **Clone:** `C:\Users\user\Desktop\implementation workflow\easymed.crm`, branch `feat/crm-link-all`, base `c20fb960`, `core.autocrlf=false`, own `node_modules`. **Never push.** Never touch `easymed.local`, `easymed.api5`, `:8000`, `:8712`. Disk C: ~1 GB free: no repo copies; delete temp dirs.
- **LF only**; marker **CRM_ONE_WAY_V1** in every comment, test title and commit message of this work.
- **Commits:** Russian message in `scratchpad/msgs/crm-oneway-<n>.txt`, ending `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; `git diff --cached --name-only` empty before `git add <named files>`; `git commit -F <file>`.
- **Runs (narrow only — the owner runs the whole suite):** `scratchpad/crm-one-way/run.sh <set> <ru|en> <tag>` with sets `wide` (all CRM server tests: `server/services/crm/*.test.js`, `server/routes/crm-*.test.js`, visits/calendar/callcenter/cashier-head/crm-merge/visit-lines RPC tests, `server/services/api/*.test.js`, migrations 246/247, `crm-lines-scope`), `money` (cashier*/billing*), `matrix` (`tests/crm-doors/matrix.test.mjs`), `client` (crm/fast-registration/walk-in/wizard/room-calendar/service-picker harnesses), `repros` (ported repros), `files "<list>"`. `LIS_ENABLED=0` always; en-US = `--import …/scratchpad/force-en.mjs`.
- **Progress:** `scratchpad/crm-one-way/PROGRESS.md` after every step.
- **Money check in every scenario test:** compare `visit_services` rows (id, service, quantity, unit_price, status) and invoice totals before/after; only the single intended line may appear or disappear.

---

## Data model (CRM_ONE_WAY_V1)

| card line (`crm_request_services`, status `pending`) | `visit_id` | `visit_service_id` | `released_from_visit_id` |
|---|---|---|---|
| **wish** (dated or undated) | NULL | NULL | NULL |
| **released wish** (O3/O4: booking cancelled or its visit line removed elsewhere) | NULL | NULL | the visit; `scheduled_date` NULL |
| **booked line** | V | X (X.visit_id = V) | NULL |

`visit_service_auto = 1` keeps its meaning from migration 187: **the visit line X was made by the CRM for this wish** (O1 insert). It is what lets X yield to a human line of the same service (wish yields) and to the registration screen's line (R7b).

New columns (migration 246, rewritten): `crm_request_services.released_from_visit_id INTEGER`, `crm_request_services.released_vs_id INTEGER` (the visit line to point back at on O5 restore; no FK, like `visit_service_id` in 187). Repair log tables `crm_one_way_repair` (one row: done_at, summary) and `crm_one_way_repair_log` (one row per change). The 246 trigger `crm_requests_patient_display_links` is dropped (`DROP TRIGGER IF EXISTS` — dev databases of this branch ran the old file).

### Resolved readings of the spec (decided here; each is the conservative reading)

1. **O2/O8 "mirror-made card lines (visit_service_auto = 1)" — the column means the opposite.** In the code, `visit_service_auto = 1` marks a card line that is an **operator's wish** whose *visit line* the mirror made (`mirrorVisitTx` step 2 `linkLine.run(id, 1, …)`). Card lines the mirror *copied from the visit* (step 3 insert, `mirrorCashierLine`) carry `visit_service_auto = 0`. Deleting `auto = 1` lines would delete operator-created lines, which O8 forbids. So: O2 stops the step-3 / cashier copies (auto = 0 copies); O8 deletes only lines identifiable as copies (rule in Task 5); `auto = 1` lines are kept as booked lines (they ARE the one-way model).
2. **O10 "live booking … or that shows arrival".** Read as: a live booking is a visit that still awaits the patient — status `scheduled`/`confirmed`, day ≥ today, and not already an arrival (`status = 'arrived'` or `cameSurely`). An arrival is history. The literal reading ("an arrived visit is live") keeps the card «Записан» in round-3 repro G1c (`zz-r3-funnel` G1c) — the acceptance requires G1c to pass.
3. **O6 "the CRM moves no line"** also applies to the card window: a booked line's day, doctor, service and visit cannot be changed from the card (server refusal + locked fields). Moving a booking is done in the calendar (lines move with the visit); removing a service from a booking is the card's × (O3). This is what makes the three move-path twin todos real tests (Task 3).
4. **O3 remove of a shared visit line** (two cards point at one line): the line is deleted only when no OTHER live card line points at it — the other card's booking still wants it (today's step-1 rule; no money moves).
5. **Adoption is kept** (`adoptPendingLine`, CRM_UNIFY_V1 A-C2): a human line landing in a visit is pointed at by the holding card's same-service wish dated that day or undated — never by a released wish. It never inserts a visit line; it stops the next registration from billing the same consultation again.
6. **Wish yields is kept** (`yieldAutoLine` / `replaceAutoTwins` / `pruneAutoLinesOnInvoice` / R7b): when a human line of the same service lands next to a still-free O1-made line, the O1 line is withdrawn and the wish points at the human line (its quantity, package, price). This is O1's "a wish never produces a second line next to a same-service line", applied when the human line comes second.
7a. **O1 "a free line of the same service" includes a line the SAME card already points at** (amended after the repro classification, risk R1): two identical wishes of one card, cards after a merge, or a released wish dated onto a day where the card already booked that service point at the one line — 150 000, not 300 000 (round-8a repro `zz-s8y-verify-1-0` control; the "same card = two lines" rule was tried in e0e6f44e and reverted in 9140fbe6). Two analyses of one day are entered by the registrar as visit lines, not as wishes.
7b. **The call-centre report** (`rpc/callcenter.js` «Что спрашивают», «Спрос по группам») counted the mirror's copies of the call centre's calendar bookings (`booking_lines_add`). Without copies (O2) it counts the card lines plus the visit lines of the card's call-centre bookings (`crm_booking_links.source = 'callcenter'`) that no card line points at — each visit line once.
7c. **Card date on any move** (repro F-9): `crmDisplayLinkMoved` becomes `crmBookingMoved` — every open card that holds the moved visit (any link kind or a booked line, same patient) gets `cardDateOf`, quietly (no stage change, no `updated_at`). `followVisitMove` no longer calls `touchRequest`.
7. **Card edit attach validates the patient:** a card line written through `/api/db` with a `visit_id` is attached (O1) only if the visit is the card patient's own-building live visit; otherwise its `visit_id` is cleared (the old mirror inserted lines into any visit id the browser sent).

### Owner and controller decisions after the first hand-back (2026-10-17)

- **R2 (owner) — call-centre services in the calendar come back to the card after a cancel.** A service the call
  centre adds to a booking in the calendar (`booking_lines_add` by a pure call-centre user, on a visit the card holds
  by a booked line or a call-centre / step-C link), or ANY service added to a booking the card holds through a
  call-centre link (`crm_booking_links.source = 'callcenter'`: registrar's line via /api/db, cashier line), becomes a
  **booked line of that card** when added (`one-way.js bookLinesOnCard`: a pointer to the visit line, not a copy —
  one visit line, one bill). O4 then releases it undated on cancel, like the card's own lines. A registrar's own
  calendar booking (step C `match`, C′) stays history-only (`crm_card_bookings`); display links never give lines (O9).
  Tests: `crm-one-way.test.js` R2 test, M1/M7 scenarios; the cells and tests that expected these lines before
  CRM_ONE_WAY_V1 expect them again (table below).
- **Partner «arrived» (owner).** A partner is told «arrived» only after a payment or a started service — never on a
  free, unpaid desk registration (`api/visit-events.js` already uses `cameSurely`). The ported repro
  `server/services/api/crm-one-way-tw-s8z-deskarrive.test.js` asserts it (not arrived the same day or the next day;
  a started service → arrived).
- **R4 (controller) — one cancel rule for every link kind.** After all of a card's bookings are cancelled, its stage and
  date follow the O10 trail for EVERY link kind (`match`, call-centre, display, a booked line): back to the stage and
  date before them only if the card is still in the stage those bookings set; otherwise only the date is recomputed
  (`cardDateOf`). No trail at all: a display link — nothing (P-3); otherwise (a card the booking itself created) — the
  old rule (first open column, date erased). The trail of a card's bookings includes visits held by its booked lines.
  Test: `crm-one-way.test.js` R4 test.
- **Restore guard.** `calendar_book` re-links a restored (cancelled → scheduled/confirmed) visit only when a card holds
  it, so a restore never creates a call-centre card (step E).

---

## Responsibility map — `server/services/crm/booking-mirror.js` (and its satellites)

| # | Responsibility today | Verdict | Where it goes |
|---|---|---|---|
| 1 | `PRE_ARRIVAL`, `visitRow`, `isPreArrival`, `arrivedByEvidence`, `beforeArrival` | kept | booking-mirror.js (shared helpers; `beforeArrival` exported for one-way.js) |
| 2 | `vsFree`, `visitHasWork`, `dayVisitMovableFor` | kept | booking-mirror.js |
| 3 | `requestOfVisit` (lines, else non-display link) | kept | step B of crmLinkVisit, adoption scope, O6 gate |
| 4 | `lineKey`, `matchKey`, `sameService` | kept | O1 compares with `sameBookedService` (shared/same-service.js — equal to `sameService` in every cell, `crm-link-all-twin.test.js`) |
| 5 | `bookingLineRefusal`, `priceFor`, `insertBookingLine` | kept | O1 insert, O3 add, `booking_lines_add` |
| 6 | `relinkHeld`, `deleteVs` | kept | R7b, prune, wish yields |
| 7 | `cardDateOf` | kept, changed (O10) | links and lines count only visits of the card's patient |
| 8 | `touchRequest` (card stage/date from its lines) | kept | after a card-edit attach (O3 add) and after O6 follow |
| 9 | `mirrorVisit` (reconcile entry, called by 14 doors) | **retired** | each door calls the one-way rule it needs (door table) |
| 10 | step 1 — cancelled card line → delete its free visit line | **replaced by O3** | `removeFromBooking` — only at the card's own edit (/api/db) and card merge, never on a later pass (round-3 M8: restore emptied the visit) |
| 11 | step 2a — visit line vanished → card line cancelled | **replaced by O3** | `releaseOrphans` — the booked line becomes a released undated wish |
| 12 | step 2b — card changed the service → replace the visit line | **replaced by O3** | refused at /api/db (`bookedLineEditRefusal`); remove (×) + add instead |
| 13 | step 2c — card moved the line to another day → move the visit line | **obsolete (O6)** | refused; the calendar moves bookings |
| 14 | step 2d — `homeFor` + insert one visit line | **replaced by O1** | `attachWish` (`wishHome`) in crmLinkVisit step A |
| 15 | step 3 — copy a visit line into a new card line | **obsolete (O2)** | — (the card shows the visit via `crm_card_bookings`) |
| 16 | step 3 — `autoLineFor`/`yieldAutoLine` (mirror line yields to the registrar's) | kept (reading 6) | `wishYields` |
| 17 | step 3 / cashier — `adoptPendingLine` | kept (reading 5) | `adoptWishes` (+ never a released wish) |
| 18 | after arrival — `placeHeldLines` | **replaced by O1** | attach happens at step A; `attachHeldLines` attaches legacy "held without visit line" rows at arrival |
| 19 | after arrival — `replaceAutoTwins` | kept | `wishYields` |
| 20 | `mirrorReschedule` (calendar move → card lines' day/doctor; free lines follow the doctor; reprice own) | kept as **O6 follow** | `followVisitMove` |
| 21 | `isCallcenterUser`, `cancellableBookingsOf`, `isRefusalStage`, `isEmptyBooking` | kept (O9) | `cancellableBookingsOf` + patient filter (O10 read-time privacy) |
| 22 | `visitsOfLines` | kept | mirrorBefore |
| 23 | `isOwnLine`, `repriceOwn`, `repriceOwnLine` | kept | O6 follow reprices only O1-made lines |
| 24 | `syncLineFromVisit` (visit line's service/doctor replaced → booked line follows) | kept (**O7**) | billing doors |
| 25 | `pruneAutoLinesOnInvoice` | kept (reading 6) | `issueVisitInvoice` |
| 26 | `mirrorCashierLine` (copy a cashier line into the card) | **obsolete (O2)** except adoption | `onVisitLinesAdded` |
| 27 | visit-status.js `releaseCancelledLines` / `settleCopy` (d6630801: drop echo / bare / carry) | **replaced by O4** | `releaseCancelled` (every pending line → released undated wish) |
| 28 | visit-status.js `settleStaleCopies` (stale pointers of the old cancel) | **obsolete** | `attachWish` overwrites any stale pointer; O8 repair clears them |
| 29 | visit-status.js arrival `placeHeldLines` | **replaced** | `attachHeldLines` (same money effect, legacy rows only) |
| 30 | booking-mirror-db.js `mirrorBefore` refusals (read-only CRM, insert status, 'done' guard, unpaid work, `lockedLineRefusal`), `cancelVisits` (last service of a booked day cancels the empty booking), «Отказ», tasks follow | kept | + `bookedLineEditRefusal`, + snapshot for marker clearing |
| 31 | booking-mirror-db.js `mirrorAfter` doctor follow (visit line doctor → card line doctor) | kept (**O7**) | |
| 32 | booking-mirror-db.js `mirrorAfter` card doctor change → free visit line follows + reprice | **obsolete (O7, reading 3)** | refused for booked lines |
| 33 | booked-twin.js `retireBookedTwin` (R7b) | kept | unchanged |
| 34 | display-links.js | kept (O9) | unchanged |
| 35 | (hidden) the mirror's copies fed the call-centre report «Что спрашивают» | **replaced** (reading 7b) | `rpc/callcenter.js` reads the booking's visit lines |
| 36 | (hidden) the copies kept a lineless card's date in step with a moved booking (`touchRequest`) | **replaced** (reading 7c) | `crmBookingMoved` for every link kind |

### Door table — every `mirrorVisit` / mirror call and its replacement

| Door (file) | Today | CRM_ONE_WAY_V1 |
|---|---|---|
| `ensure_visit` ×3 (`rpc/visits.js:297,340,412`) | crmLinkVisit + mirrorVisit | crmLinkVisit only (step A attaches) |
| `discard_empty_visit` (`rpc/visits.js:485`) | lines → visit_id NULL | also `visit_service_id`/auto cleared |
| `calendar_book` day-visit move (`rpc/calendar.js:1109`) | crmLinkVisit + mirrorVisit | crmLinkVisit only |
| `calendar_book` existing (`:1267-1271`) | crmVisitStatus; mirrorReschedule + crmDisplayLinkMoved; mirrorVisit | crmVisitStatus (O4/O5 inside); followVisitMove + crmDisplayLinkMoved; **no reconcile** |
| `calendar_book` new | crmLinkVisit; crmVisitStatus | unchanged |
| `booking_lines_add` (`rpc/booking-lines.js:122`) | crmLinkVisit + mirrorVisit (copies the lines into the card) | crmLinkVisit + `adoptWishes(V, added)` — no copies (O2) |
| `booking_line_remove` (`:149`) | mirrorVisit (card line cancelled) | `releaseOrphans(V)` (O3) |
| `remove_own_visit_line` (`rpc/visit-lines.js:75`) | mirrorVisit | `releaseOrphans(V)` |
| `/api/db` visit_services insert/upsert (`booking-mirror-db.js:203`) | retireBookedTwin; mirrorVisit | retireBookedTwin; `onVisitLinesAdded(V, ids)` = wishYields + adoptWishes |
| `/api/db` visit_services update/delete | mirrorVisit | doctor/service follow (O7); `releaseOrphans(V)` |
| `/api/db` card line insert/update (`:238`) | mirrorVisit | refusal for booked-line moves; `removeFromBooking` for cancelled; `attachCardLines` for lines given a `visit_id`; marker clearing |
| cashier line remove (`rpc/billing.js:1213,1246`) | card line cancelled; mirrorVisit | `releaseVisitLine(vsId)` in the transaction (O3) |
| cashier line add (`rpc/billing.js:1688-1689`) | mirrorVisit + mirrorCashierLine | `onVisitLinesAdded(V, [id])` |
| first invoice (`rpc/billing.js:457`) | pruneAutoLinesOnInvoice | unchanged |
| service/doctor change (`rpc/billing.js:1346,1586,1989`) | syncLineFromVisit | unchanged (O7) |
| card merge (`rpc/crm-merge.js:384`) | mirrorVisit on touched visits | `removeFromBooking` for the duplicate lines it cancelled |
| API booking recovery (`api/bookings.js:476`) | crmLinkVisit + mirrorVisit | crmLinkVisit only |
| desk (`crm/visit-link.js deskArrive`) | mirrorVisit, then arrival rule | arrival rule only (attach happened in step A) |
| arrival (`crm/visit-status.js` arrived) | placeHeldLines | `attachHeldLines` (not on catch-up) |
| cancel (`crm/visit-status.js` cancelled) | releaseCancelledLines | `releaseCancelled` (O4) + O10 trail |
| restore cancelled → scheduled/confirmed | nothing (the final mirrorVisit rebuilt/deleted lines) | `restoreReleased` (O5), then crmLinkVisit (stage) |

---

## File map

- Create `server/services/crm/one-way.js` — O1/O3/O4/O5/O6/O7 rules (functions named in the tables above).
- Create `server/services/crm/one-way.test.js` — unit-level rules on an in-memory DB.
- Create `server/services/crm/one-way-repair.js` + `one-way-repair.test.js` — O8.
- Create `server/routes/crm-one-way.test.js` — door scenarios through the real app (`test-helpers/crm-unify-app.js`, `crm-link-all.js`) incl. M1, M2, C1, M7, M8, O3 add/remove, O5, move refusal; every scenario compares visit_services and invoices.
- Rewrite `server/db/migrations/246_crm_card_patient_links.sql` → `246_crm_one_way.sql` + `246.test.js`.
- Modify `server/services/crm/booking-mirror.js` (retire rows 9–20, 26), `booking-mirror-db.js`, `visit-link.js`, `visit-status.js`, `no-show.js` (patient filter), `rpc/visits.js`, `rpc/calendar.js`, `rpc/booking-lines.js`, `rpc/visit-lines.js`, `rpc/billing.js`, `rpc/crm-merge.js`, `api/bookings.js`, `rpc/crm-card-bookings.js` (released visits stay listed), `db/schema-registry.js` (read `released_from_visit_id`), `server/index.js` (repair at start).
- Modify `server/services/crm/booking-mirror-twin.test.js` (todos → tests; changed expectations).
- Modify client `public/js/admin/views/crm.js` (card lines), `public/js/admin/i18n-strings.js`, client harness `public/js/admin/__tests__/crm-card.test.mjs`.
- Port repros into `server/routes/crm-one-way-r1-*.test.js`, `crm-one-way-r2-*.test.js`, `crm-one-way-r3-*.test.js`, `server/services/crm/crm-one-way-tw-*.test.js` / `server/services/api/crm-one-way-tw-*.test.js` (paths keep the repros' relative imports).
- Modify `tests/crm-doors/matrix.test.mjs` EXPECT only where a cell expected a mirror copy.

---

## Tasks

- [x] **Task 0 — Plan, baseline.** This file; baseline runs `base0` of `wide`, `matrix`, `money`, `client` (ru) recorded in PROGRESS.md. Commit the plan.
- [x] **Task 1 — Migration 246 (one-way schema), registry.**
- [x] **Task 2 — `one-way.js` rules (unit tests first).**
- [x] **Task 3 — Retire the mirror: every door rewired; twin todos → real tests; door scenarios (M1, M2, C1, M7, M8, O3, O5); existing tests and matrix cells adjusted (list below).**
- [x] **Task 4 — O10 funnel: trail per booking, live booking, read-time privacy (G1a–e, TRIG-a).**
- [x] **Task 5 — O8 upgrade repair (one-off, logged).**
- [x] **Task 6 — Port all repros (r1, r2, r3, crm-twin-repros) with one-way expectations / obsolete list.**
- [x] **Task 7 — Card UI: wishes and booked lines, O3 add/remove from the card, released wishes, ru/uz/en; client harness; Playwright at 360 px.**
- [x] **Task 8 — Verification (narrow sets ru + en-US), counts in this plan, PROGRESS.md.**

---

### Task 1 — Migration 246 (one-way schema), registry

**Files:** delete `server/db/migrations/246_crm_card_patient_links.sql`; create `server/db/migrations/246_crm_one_way.sql`; rewrite `server/db/migrations/246.test.js`; modify `server/db/schema-registry.js` (crm_request_services read columns).

- [ ] Step 1 — failing test `246.test.js`:

```js
// CRM_ONE_WAY_V1 (мигр. 246, переписана до выпуска) — разметка отпущенных строк, журнал разового исправления,
// триггер прежней 246 снят (O10: приватность — при чтении).
test('мигр. 246: колонки отпуска строки, журнал исправления; триггера смены пациента нет', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare('PRAGMA table_info(crm_request_services)').all().map((c) => c.name);
  assert.ok(cols.includes('released_from_visit_id') && cols.includes('released_vs_id'));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crm_one_way_repair'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crm_one_way_repair_log'").get());
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'crm_requests_patient_display_links'").get(), undefined);
  // смена пациента привязки не снимает (77 → 78 → 77 не теряет привязку C′)
  … insert card 77, visit 77, link 'patient'; UPDATE patient 78; UPDATE patient 77 → link still there.
});
test('мигр. 246 поверх прежней 246 (база ветки): триггер снят, колонки есть', () => { … create the old trigger by hand, mark the old name applied, migrate → trigger gone });
```

- [ ] Step 2 — run `run.sh files ru t1 "server/db/migrations/246.test.js"` → FAIL (no columns).
- [ ] Step 3 — `246_crm_one_way.sql`:

```sql
-- CRM_ONE_WAY_V1 (2026-10-17) — услуги записи живут только в визите. …(header: why, columns, no FK on purpose)
DROP TRIGGER IF EXISTS crm_requests_patient_display_links;
ALTER TABLE crm_request_services ADD COLUMN released_from_visit_id INTEGER;
ALTER TABLE crm_request_services ADD COLUMN released_vs_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_crm_req_services_released ON crm_request_services(released_from_visit_id);
CREATE TABLE IF NOT EXISTS crm_one_way_repair (id INTEGER PRIMARY KEY CHECK (id = 1), done_at TEXT, summary TEXT);
INSERT OR IGNORE INTO crm_one_way_repair (id, done_at, summary) VALUES (1, NULL, NULL);
CREATE TABLE IF NOT EXISTS crm_one_way_repair_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, line_id INTEGER, request_id INTEGER, visit_id INTEGER, visit_service_id INTEGER,
  action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
```
  On a branch DB that already applied the old 246, `ALTER … ADD COLUMN` is new too (the old file only made the trigger) — no collision.
- [ ] Step 4 — registry read columns of `crm_request_services` += `released_from_visit_id` (not writable).
- [ ] Step 5 — run 246.test.js, 247.test.js, `server/db/migration-order.test.js`, `server/db/schema-registry*.test.js` → PASS. Commit `crm-oneway-1`.

### Task 2 — `server/services/crm/one-way.js` (rules, unit tests first)

**Files:** create `one-way.js`, `one-way.test.js`.

Functions (all never throw except where noted; each runs inside the caller's transaction or opens its own):

```js
export function sameAsWish(db, wish, x)            // sameBookedService(lineOf(wish), lineOf(x), { needsDoctor })
export function wishHome(db, v, line)              // O1 target: unheld same-service line → line held only by OTHER cards → null
export function attachWish(db, v, line, { actorId }) // O1: point (auto 0) or insert one line (auto 1); refusal/foreign → null, line untouched
export function attachWishes(db, v, lines, opts)   // loop; returns count attached
export function attachHeldLines(db, visitId, opts) // legacy: visit_id = V AND visit_service_id IS NULL → attachWish
export function wishYields(db, visitId)            // ex replaceAutoTwins/yieldAutoLine (pre-arrival or arrived, own building)
export function adoptWishes(db, visitId, vsIds)    // ex adoptPendingLine, + released_from_visit_id IS NULL
export function onVisitLinesAdded(db, visitId, vsIds) // wishYields + adoptWishes + touchRequest
export function removeFromBooking(db, pairs)       // O3 card remove: [{lineId, vsId}] → delete free vs if no other live holder
export function releaseOrphans(db, visitId)        // O3 elsewhere: booked lines whose vs is gone/cancelled/moved → released wish
export function releaseVisitLine(db, vsId)         // O3 for one removed line (cashier), before/after the DELETE
export function releaseCancelled(db, visitId)      // O4
export function restoreReleased(db, visitId)       // O5
export function followVisitMove(db, visitId, { oldDoctorId }) // O6 (ex mirrorReschedule)
export function bookedLineEditRefusal(db, ids, values) // O6/O3: change of day/doctor/service/visit of a booked line → message
export function attachCardLines(db, lineIds, opts) // card edit: lines with visit_id and no vs → validate patient/visit → attachWish, else clear visit_id
```

Release = `UPDATE crm_request_services SET released_from_visit_id = V, released_vs_id = <X if X is V's live line else NULL>, scheduled_date = NULL, visit_id = NULL, visit_service_id = NULL WHERE id = ?` (`visit_service_auto` kept so O5 restores it). Restore = released wish with `visit_id IS NULL AND (scheduled_date IS NULL OR '') AND released_from_visit_id = V` and `released_vs_id` a live line of V → `visit_id = V, visit_service_id = released_vs_id, scheduled_date = V's day, released_* = NULL`.

- [ ] Step 1 — failing unit tests in `one-way.test.js` (in-memory DB, `migrate`, users/services/patients seeded like `booking-mirror-twin.test.js` `clinic()`):
  1. `attachWish` inserts exactly one 'added' line for a wish (price = catalogue), card line → booked (auto 1, day = visit day).
  2. a registrar's same-service line already in the visit → the wish points at it, no insert (auto 0); visit_services unchanged.
  3. two wishes of ONE card for the same service (glucose fasting + 2 h) → two lines.
  4. two cards, same consultation (doctor 7) → one line, both point at it.
  5. consultation wish for doctor 7 vs a doctor-8 line → insert (different booking, review I1).
  6. surgery wish (`type = 'other'`) → not attached, card line unchanged.
  7. `releaseCancelled`: booked lines → released (day NULL, visit NULL, vs NULL, marker V, released_vs_id X); the visit's lines unchanged.
  8. `restoreReleased`: points back at X with the visit's day; an operator-dated released line (marker cleared) is not restored.
  9. `releaseOrphans`: vs deleted → released, marker V, released_vs_id NULL; other card lines untouched.
  10. `removeFromBooking`: free vs deleted; vs held by another card's live line → kept; billed vs → kept.
  11. `wishYields`: O1 line ×1 + registrar line ×2 of the same service → the O1 line deleted, the wish points at the ×2 line (2 units).
  12. `adoptWishes`: undated wish adopts the registrar's line; a released wish never does.
  13. `bookedLineEditRefusal`: day/doctor/service/visit change of a booked line → refusal text; same values → null; wish → null.
- [ ] Step 2 — run → FAIL (module missing).
- [ ] Step 3 — implement `one-way.js` (move code of `yieldAutoLine`, `autoLineFor`, `replaceAutoTwins`, `adoptPendingLine`, `mirrorReschedule` from booking-mirror.js; write the rest).
- [ ] Step 4 — run → PASS (ru, en). Commit `crm-oneway-2` (module unused yet; nothing else changes).

### Task 3 — Retire the mirror; every door rewired

**Files:** booking-mirror.js, booking-mirror-db.js, visit-link.js, visit-status.js, rpc/visits.js, rpc/calendar.js, rpc/booking-lines.js, rpc/visit-lines.js, rpc/billing.js, rpc/crm-merge.js, api/bookings.js, routes/db.js (if the insert path needs the ids), booking-mirror-twin.test.js, new `server/routes/crm-one-way.test.js`, plus the existing tests listed under "Existing tests whose expectations change".

- [ ] Step 1 — failing tests:
  - `booking-mirror-twin.test.js`: the five CRM_TWIN_LINE todos become tests (one-way expectations below) and the four passing tests change per O2/O4 (below). Helper `regAdd` no longer calls `mirrorVisit`; it calls `onVisitLinesAdded` (what `/api/db` does).
  - `server/routes/crm-one-way.test.js` (real app): **M1** call-centre consultation doctor 10 cancelled, registrar rebooks the same day with doctor 11 → the new visit holds only doctor 11's consultation, 100 000; **M2** cancelled consultation does not appear in an analysis-only visit that day; **C1** cancel + rebook the same consultation by the registrar → one consultation; **M8** registrar consultation on a 'match' visit, cancel, «Записан» again → the visit keeps its line and the card points at it again (O5); **M7** call centre adds services in the calendar to a 'match' visit, cancel → the card has no copies before or after (O2), the visit's lines unchanged; **O3 add** — card adds an analysis to its booking (insert with visit_id) → one visit line + booked line; **O3 remove** — card × on a booked consultation → the free line leaves the visit, empty booking is cancelled; **O3 elsewhere** — calendar removes the line → card line is a released undated wish; **O4** — cancel → released wishes; a same-day rebooking and a desk registration (`undated`) do not take them; after the operator dates one, the next booking takes it; **move refusal** — /api/db update of a booked line's day/doctor/visit → 400 with the message, nothing changes. Each test snapshots `visit_services` + `invoices` before/after.
- [ ] Step 2 — run → FAIL.
- [ ] Step 3 — implement:
  - visit-link.js step A: select per live card (P-6 skip kept) `pending` lines with (`visit_id IS NULL` or dead visit or (`visit_id = V AND visit_service_id IS NULL`)) and (`date(scheduled_date) = V.day` or, with `undated` on live cards, `scheduled_date` empty AND `released_from_visit_id IS NULL`) → `attachWishes`; `settleStaleCopies` call removed; `deskArrive` without `mirrorVisit`.
  - visit-status.js: arrival → `attachHeldLines` (not on catch-up) then the 'done' rule; cancel → `releaseCancelled`; `from = 'cancelled'` and `to ∈ {scheduled, confirmed}` → `restoreReleased` (the stage move is crmLinkVisit's, called by calendar_book for a restore); `releaseCancelledLines`, `settleCopy`, `settleStaleCopies` deleted.
  - doors per the door table; booking-mirror.js: delete `mirrorVisit`, `mirrorVisitTx`, `placeHeldLines`, `homeFor`, `adoptPendingLine`, `autoLineFor`, `yieldAutoLine`, `replaceAutoTwins`, `mirrorReschedule`, `mirrorCashierLine`; header rewritten (CRM_ONE_WAY_V1: what stayed and why).
  - booking-mirror-db.js: `mirrorBefore` adds `bookedLineEditRefusal` after `lockedLineRefusal`, snapshots target rows (`ctx.before`), collects `{lineId, vsId}` of lines being cancelled (`ctx.removed`); `mirrorAfter`: visit_services insert → `onVisitLinesAdded`; update → O7 follow (doctor; service via `syncLineFromVisit`) + `releaseOrphans`; delete → `releaseOrphans`; card insert/update → `removeFromBooking(ctx.removed)`, `attachCardLines`, marker clearing (`released_* = NULL` where day/doctor/service changed), `cancelVisits` as today.
  - calendar.js restore: `existing.status = 'cancelled'` and the new status is scheduled/confirmed → after `crmVisitStatus` call `crmLinkVisit(db, id, user)` (step B finds the holding card; step G moves it forward as at booking).
- [ ] Step 4 — run the new tests, `wide`, `money`, `matrix` (ru); adjust ONLY the expectations listed below (each edit carries a `CRM_ONE_WAY_V1 (O…)` comment); any other failure is a bug to fix, not an expectation to change.
- [ ] Step 5 — run the same sets in en-US. Commit `crm-oneway-3`.

#### Twin tests (booking-mirror-twin.test.js) — one-way expectations

| test | before | CRM_ONE_WAY_V1 |
|---|---|---|
| one card, two glucose lines (registrar), cancel + rebook | new visit has 2 | **0 in the new visit; both stay in the cancelled one** — the registrar's lines were never the card's (O2: no copies), the cancelled visit keeps its lines (O4) |
| registrar ×2 injection (call booking), site card wants injection (later), cancel + rebook | 2 | **1** (the site card's wish, catalogue price) — the ×2 line stays in the cancelled visit (O4); nothing doubled |
| package line, site card wants the same analysis, cancel + rebook | the package line | **one line, catalogue price** — the package line stays in the cancelled visit (O4), the site's wish books one line (O1) |
| two cards, one consultation, cancel 15:00, rebook 10:00 | 1 | **1**, held by the site card's wish; the call card's line is a released undated wish (O4) |
| todo 1 — site (earlier) wants injection, registrar ×2 on the call booking, cancel + rebook | was 3 | **1, never 3** (O4 + O1) |
| todo 2 — site wants analysis, package line on the call booking, cancel + rebook | was both | **one line** (O1); the package line stays with the cancelled visit |
| todo 3 — card moves a ×10 course onto a day where another card holds ×1 | was 11 | **move refused** («Перенос записи — в календаре»), ×10 stays on its visit, ×1 on the other (O6); via the calendar instead → ×10 moves with its visit, still one line, 10 units |
| todo 4 — card B's consultation moved onto card A's booked day (and after merging A and B) | was 2 | move refused; remove (×) + add on A's day → **1 consultation** (O3 remove + O1 point); merge → one line (removeFromBooking of the duplicate) |
| todo 5 — a shared line (two duplicate cards) moved by one of them onto a booked day | was 2 | move refused; remove (×) keeps the shared line (other card holds it), add on the booked day points at the existing line → **each day one line** |

#### Existing tests whose expectations change (Task 3, definitive — from the ru/en runs)

| file | tests | O-rule | change |
|---|---|---|---|
| `server/services/crm/booking-mirror-twin.test.js` | 4 tests + 5 todos | O2, O4, O6, O3 | table above; `regAdd` calls `onVisitLinesAdded` (what /api/db does) instead of `mirrorVisit` |
| `server/routes/crm-calendar-mirror.test.js` | 2, 2б, 13 | O2 | calendar / registrar lines are not copied into the card; the card shows them via `crm_card_bookings` |
| same | 4 | O6 | the card's move of a booked line → 409; the visit is moved in the calendar instead and the card lines follow (day) |
| same | 7 | O3, O2, O4 | a line removed in the calendar → the card line is a released undated wish; a re-added calendar line is not copied, the released line does not sit on it |
| same | 8, R-C1, R-M1 | O6 | doctor / service change of a booked line from the card → 409 (R-M1 keeps the reverse: `change_unpaid_service` → the card line follows, O7) |
| same | R-I1, R-I3 (этот день) | O2 | the registrar's second line is not copied into the card |
| `server/routes/crm-link-all-display.test.js` | «запись колл-центра из живой карточки … по-прежнему зеркалится» | O2 | no card line; `crm_card_bookings` lists the booking with its service |
| `server/routes/crm-link-all-twin.test.js` | two R7b tests | O2 | card line assertions → «no copy on the card»; money assertions (one line, 100 000) unchanged |
| `server/routes/crm-link-all-twin-line.test.js` | three «база до правки» tests | O2 | the legacy row is built by the helper itself (no copies exist to rewind); money expectations unchanged — step A skips a line released by the old cancel |
| `server/routes/crm-unify-final-status.test.js` | two A-C2 tests | O2 | the analysis is not copied (2 card lines, not 3); `mirrorCashierLine` → `onVisitLinesAdded` (adoption kept) |
| `server/routes/crm-unify-link.test.js` | booking_lines_add … находит открытую карточку | O2 | the link stays, no card copy |
| `server/routes/crm-link-all-review2.test.js` | two PRIV-3 tests | O10 | display links survive a patient change; `crm_card_bookings` still hides the other patient's visit |
| `server/services/crm/visit-status.test.js` | отмена одного дня из трёх | O4 | the cancelled day's line is undated, the card date is the remaining day (2026-08-10, not 08-09) |
| `server/services/rpc/cashier-head.test.js` | CRM: смена врача … добавленная кассой строка … | O2, O3 | the cashier's line is not copied; the cashier removing a booked line → the card line is a released undated wish |
| `server/db/migrations/246.test.js` | rewritten | O10 | no trigger; columns; repair tables; old-246 database upgrade |
| `tests/crm-doors/matrix.test.mjs` | 13 cells (`ONE_WAY` map) | O2 ×11, O4 ×1, O3 (R2) ×1 | only the `lines` column; owner `booked` → `booked+shown` for 4-today-S1 and 5-S1p-crm-wizard; `vs`, stage, date, link unchanged in every cell. After R2 the call-centre calendar cells (2-S1…S4-cc, 7-*-S2Tcal-same, 7-*-S2Tcal-r7a) expect their original lines again (booked lines, not copies); 7-fast-S2Tcal-r7a-drop: the booked line removed by the registrar waits undated (O3) |
| after R2 | `crm-calendar-mirror` 2, 7, 13; `crm-link-all-display` «запись колл-центра из живой карточки»; `crm-link-all-twin` R7b ×2; `crm-unify-link` booking_lines_add | R2 | back to booked lines on the card (pointers): 2 and 13 as before CRM_ONE_WAY_V1 (13 removes through the card's cross, O3); 7 — the re-added calendar line is a booked line, removed in the calendar it waits undated (O3) |

Kept green by code, not by changing the test: `crm-calendar-mirror` R-I5 (a pre-arrival visit with an invoice gets no new line from a wish — it sits at arrival), R-M8 (call-centre report, reading 7b), `crm-unify-desk-money` C2c/C2g (unplaceable and frozen wishes hold the visit; arrival places them), `visits.test.js` CRM_REAL_BOOKING_V1 ×9 (a wish without a service still holds the visit).

### Task 4 — O10 funnel

**Files:** visit-status.js (cancel branch), booking-mirror.js `cardDateOf` / `cancellableBookingsOf`, no-show.js sweep `bookingsOf`, visit-status.js `liftMissed` links, `server/routes/crm-one-way-funnel.test.js`.

- [ ] Step 1 — failing tests = round-3 funnel repros ported as real tests: G1a (human move survives), G1b (no-show not erased), G1c (arrived booking is history: human date returns), G1d/G1e (a past unmarked 'scheduled' visit is not a live booking), TRIG-a (77 → 78 → 77 keeps the display link; cancel returns the card), TRIG-c (patient merge keeps it), and the privacy read filter (card moved to 78 → its date, no-show sweep and «Отказ» ignore 77's visits).
- [ ] Step 2 — run → FAIL.
- [ ] Step 3 — implement: `LIVE_BOOKING_SQL(alias)` = status scheduled/confirmed, local day ≥ today, no arrival (`status <> 'arrived'`, no paid invoice, no evidence line); used by `lineBooked`, `otherLink`, P-4 `otherAhead`; trail = this visit's entries + entries of the card's other LIVE bookings; restore only if the card still stands in the stage the booking set (kept rule); without restore this visit's entries move to the earliest other live display booking of the card (keeps G-1b), else are deleted; patient filters: `cardDateOf` (links and lines join `x.patient_id = r.patient_id`), sweep `bookingsOf`, `cancellableBookingsOf`, `liftMissed` links.
- [ ] Step 4 — run funnel tests + `wide` + `matrix` (ru, en). Commit `crm-oneway-4`.

### Task 5 — O8 upgrade repair

**Files:** create `server/services/crm/one-way-repair.js`, `one-way-repair.test.js`; modify `server/index.js` (after `crmUnifyRepair`, before the no-show schedule).

**Revised in review r4 (controller decision, items 1, 5, 6): the repair deletes nothing** — rules as implemented
(`server/services/crm/one-way-repair.js`, migration 248 `legacy_copy` / `released_held`):
1. Lines pointing at a visit line, by origin. *Copy* = `visit_service_auto = 0`, created 0–2 s after its visit line,
   and the visit is NOT held by a call-centre link of this card. Live visit: copy → `legacy_copy = 1` (`marked_copy`;
   a later cancel cancels it), anything else → kept as a booked line (`kept_booked`, log only; a later cancel
   releases it undated). Cancelled visit: copy → `status = 'cancelled'` (`cancelled_copy`), else released undated
   (`released`). Pointer-only line into a cancelled visit: copy → `cancelled_copy`, same day → `released_stale`,
   another day → pointer cleared (`cleared_stale`). Pointer into a live visit with no hold → `cleared_moved`; held
   visit ≠ pointer's visit → `released_cross`. 'done' copies → log only (`kept_done`).
2. Pending line holding a cancelled visit without a visit line → released with `released_held = 1` (`released`).
3. Dated pointer-less wish whose card has a cancelled booking that day (`crm_booking_undo` / `crm_booking_links`)
   → released undated with `released_from_visit_id` = that visit (`released_dated`). A booking linked to the card only for display (C′, phone —
   `patient` / `phone` links) is not evidence: such links never took card lines (O9). Review r5: only a wish whose
   service was in the cancelled visit (a visit line of that visit with the same service key) and that was created
   before the cancel (`created_at` ≤ the cancelled visit's `updated_at`, which `calendar_book` sets on cancel; if that
   is empty, the booking time from its trail or link; no time → not released); never when the card holds a live booking
   that day.
4. Never: deleting rows, visit_services, invoices, payments, card stages/dates; lines with status 'cancelled'.
Tests: `one-way-repair.test.js` (4), `server/routes/crm-one-way-r4-o8.test.js` (H2, H3) and the old-database upgrade
`server/routes/crm-one-way-r4-o8-old.test.js` (5, needs `CRM_O8_OLD_DB` = the review's `r4/olddb` or `r4/v316db`).

*Superseded first version (kept for the record):*
Rules (one transaction; `crm_one_way_repair.done_at` set at the end; a second call does nothing):
1. **Mirror copies → deleted** (log `deleted_copy`): pending/done card line with `visit_service_auto = 0`, `visit_id = vs.visit_id`, created **0–2 s after its visit line** (`julianday(l.created_at) - julianday(vs.created_at)` in [0, 2/86400]) — the step-3 / cashier copy is inserted in the same request as the visit line; an operator's line is saved by the card window (always without a visit) and can only come later. Ambiguous lines (older, or later than 2 s) are kept as booked lines and logged `kept_ambiguous`.
2. **Booked lines of a cancelled visit → released undated wishes** (log `released`): pending, `visit_id` = a cancelled visit.
3. **Stale pointers of the old cancel** (log `cleared_stale`): pending, `visit_id IS NULL`, `visit_service_id` into a cancelled visit: pointer cleared; if the line's day is still the cancelled visit's day → released (O4); if the operator gave it another day → a plain dated wish.
4. Never: visit_services, invoices, payments, card stages; lines with status 'cancelled'; operator lines (rule 1 only deletes 0–2 s copies).
- [ ] Step 1 — failing tests: each rule + run-once + "no visit_services/invoices change" snapshot + an operator line attached to a registrar line minutes later is kept.
- [ ] Step 2–4 — implement, run (ru, en), commit `crm-oneway-5`.

### Task 6 — Port the repros

**Files:** `server/routes/crm-one-way-r1-<name>.test.js` (from `crm-link-review/repros-r1`), `crm-one-way-r2-<name>.test.js` (`repros-r2`), `crm-one-way-r3-<name>.test.js` (`tree3/server/routes/zz-r3-*`), `server/services/crm/crm-one-way-tw-<name>.test.js` and `server/services/api/crm-one-way-tw-<name>.test.js` (`crm-twin-repros`).

- [ ] Step 1 — copy each file (titles prefixed `CRM_ONE_WAY_V1 —`), fix imports of retired functions (`mirrorVisit` → `onVisitLinesAdded` where the repro simulated `/api/db`; `crmWonCardLines` → obsolete).
- [ ] Step 2 — run `repros` set; for each failing test decide per the classification (`scratchpad/crm-one-way/REPRO-CLASSIFY.md`): one-way expectation (edit with the O-rule in a comment) or obsolete (delete the test; listed in the table below with the reason).
- [ ] Step 3 — run (ru, en); commit `crm-oneway-6`.

#### Repro outcome table (Task 6)

Classification of every repro test: `scratchpad/crm-one-way/REPRO-CLASSIFY.md` (172 tests). Ported files keep the
original assertions unless a row below says otherwise; every changed assertion carries a `CRM_ONE_WAY_V1 (O…)`
comment; every removed test leaves a `CRM_ONE_WAY_V1 — УБРАН: <reason>` line in the ported file.

| set → ported to | tests | outcome |
|---|---|---|
| r1 `repros-r1/*` → `server/routes/crm-one-way-r1-*.test.js` (12 files) | 40 | pass as-is except: **F2b** (funnel-a) and **ZZ-WON E1** (money-wonlines-edges) — CHANGE O2/P-7: the desk-closed card has no copied line, it shows the visit in `crm_card_bookings`; **B8** (funnel-b) — CHANGE: `crmWonCardLines` assert removed (function removed in ред. 2), the sync-visit no-op stays |
| r1 obsolete | 3 | **E1** (`zz-funnel-e`, file not ported) — its premise (paid invoice without a payments row) fails on every build; superseded by r2 `f2-r1e` (ported). **ZZ-MONEY B1** (`zz-money-billed`, not ported) — asserted on the card copy `ml` of the visit line, which O2 no longer creates. **ZZ-WON E2** — exercised `crmWonCardLines` (removed) |
| r2 `repros-r2/*` → `server/routes/crm-one-way-r2-*.test.js` (14 files) | 79 | pass as-is (F-9 needs reading 7c — card date follows a moved `match` booking quietly); **M2-S2** — the wizard's booked row has no date field since fix S2 (bea1f11d), so the repro now asserts that (still one analysis for the patient) |
| r2 obsolete | 4 | **M2-I3-residual** — asserted the opposite of owner decision D4/R5 (a phone-matched card becomes the patient's card; its wish of another day sits in that day's booking) — not a one-way change. **M2-S1** — its precondition (the screen lets a second ЭКГ row through) was removed by fix S1 (ff71a63f); the S1-control stays. **M2-S2c ×2** — the booked row of the wizard has no doctor field since fix S2c (bea1f11d) |
| r3 `repros-r3/zz-r3-funnel` → `crm-one-way-r3-funnel.test.js` | 8 | G1a, G1b, G1c, G1d, G1e, TRIG-a, TRIG-c pass (O10, Task 4); **TRIG-b** obsolete — measured the cost of the 246 trigger, which is dropped. Plus a new O10 read-privacy test |
| r3 `zz-r3-money` → `crm-one-way-r3-money.test.js` | 8 | M1, M2, M8 ×2, M8-ctl ×3 pass (M1/M2/M8/M8-ctl-match failed before); **M7** — owner decision R2: the operator's calendar consultation is a booked line of the card, the cancel returns it undated (the repro's own assertion, title updated); **M6** obsolete (refuted in the review: no write path for a visit line's quantity) |
| r3 `zz-r3-same` → `crm-one-way-r3-same.test.js` | 1 | pass (`sameService` stays exported) |
| 8a `crm-twin-repros` → `server/services/api/crm-one-way-tw-*.test.js` | donesticky, verify-2-0, s8z-cardsave, s8z-mergeline, s8z-verify-api-flow-0-0, s8z-deskarrive | pass as ported; **s8z-deskarrive** rewritten per the owner's decision (a free unpaid desk registration is not «arrived» for the partner; a started service is) |
| 8a `zz-s8y-verify-1-0` → `server/services/crm/crm-one-way-tw-verify-1-0.test.js` | 3 | two cards / merged — CHANGE O6: the /api/db door refuses the move of a booked line (`BOOKED_LINE_LOCKED`), each day keeps one consultation; control (one card, two identical wishes) — one consultation (reading 7a; failed under the first one-way draft, finding R1) |
| 8a obsolete | mergedcard, mergedsvc, shared, shared-log, verify-0-0, verify-0-1, verify-0-1b, verify-1-1, verify-2-1 | each moved a booked card line with raw SQL and then called `mirrorVisit` to make the mirror carry its visit line — both the move (O6, refused) and the reconcile (retired) no longer exist. Their money questions (one line per day, ×N and packages kept, shared line, merge) are answered by `booking-mirror-twin.test.js` (todos 3–5 and the merge variant) and `crm-one-way-tw-verify-1-0`. verify-2-1 pinned a since-fixed buggy outcome |

### Task 7 — Card UI

**Files:** `public/js/admin/views/crm.js` (loading lines, `paintPicked`, `saveLines`, schedule sheet, `bookDays`), `public/js/admin/i18n-strings.js`, `server/services/rpc/crm-card-bookings.js`, `public/js/admin/__tests__/crm-card.test.mjs`.

- [ ] Step 1 — failing client tests (fake supabase of `crm-card.test.mjs`): saving a card without edits sends no insert and no cancel of existing wishes; an edited wish is updated in place (same id); a removed booked line is cancelled by id; a new service dated on a booked day is inserted with that booking's `visit_id`; a booked line shows «Записан: …» and its date/doctor inputs are disabled with «Перенос записи — в календаре»; a released wish shows «Запись отменена — назначьте дату заново»; «Применить ко всем» skips booked lines.
- [ ] Step 2 — server: `crm_card_bookings` also lists visits named by `released_from_visit_id` (so a cancelled booking stays visible as «Отменён»); test in `crm-link-all-card-bookings.test.js` style.
- [ ] Step 3 — implement; i18n ru/uz/en for every new string; type scale (12.5 / 13.5 px), `Icon()`, no emoji.
- [ ] Step 4 — client harness + server test (ru, en); Playwright on an own server (random port, temp data dir, removed after): card with a booked line + a wish + a released wish at 360 px and 1280 px, screenshot check (no horizontal scroll). Commit `crm-oneway-7`.

### Task 8 — Verification (done 2026-10-17)

Narrow sets only (the owner runs the whole suite); `LIS_ENABLED=0`; en-US with the force-en preload; disk guard 120 MB.

| set | ru | en-US |
|---|---|---|
| wide CRM (`server/services/crm/*`, `server/routes/crm-*` incl. all ported repros, visits/calendar/callcenter/cashier-head/crm-merge/visit-lines, `server/services/api/*`, migrations 246/247, crm-lines-scope) | 1125: 1123 pass, 0 fail, 2 todo (not twin todos) | same |
| door matrix `tests/crm-doors/matrix.test.mjs` | 110/110 | 110/110 |
| money (cashier*, billing*) | 243/243 | 243/243 |
| client harnesses (crm*, fast-registration, walk-in, wizard, room-calendar, service-picker-crm) | 417/417 (room-calendar re-run 31/31 after the R2 fix) | 417/417 |
| server guards (i18n-server-messages, app-test-hygiene, build-bundle, migration-order) | 38/38 | 38/38 |
| UI guards (i18n-coverage, i18n-uz-quality, icons, server-messages-i18n, type-scale) | 43/43 | 43/43 |

- Twin file: 9 real tests (the 5 CRM_TWIN_LINE todos and 4 older tests), 0 todo.
- Ported repros passing: r1 37, r2 75, round-3 16 (money 8, same 1, funnel 7 + 1 new O10 privacy test), 8a 18 — 146; obsolete with reasons in the repro table: r1 3, r2 4, round-3 2, 8a 9 files.
- New rule tests: `one-way.test.js` 13, `crm-one-way.test.js` 13, `one-way-repair.test.js` 3, `246.test.js` 2.
- Playwright (own server, random port, in-memory DB, temp licensed data dir): card lines at 360 px (ru/uz/en) and 1280 px — locked day of a booked line with «Перенос записи — в календаре», released note, no emoji, type scale, `Icon()`; rows wrap at 360 px. The modal's form column overflows by ~33 px at 360 px on HEAD too (pre-existing, not part of this work).
- Marker sweep: every changed or new file carries CRM_ONE_WAY_V1; no code calls `mirrorVisit`, `mirrorCashierLine`, `placeHeldLines`, `settleStaleCopies`, `mirrorReschedule`, `releaseCancelledLines` or `crmWonCardLines`.

### Adversarial review r4 of 065bc16a (2026-10-17) — fixes, test-first

Every repro of the review is a real test in the clone; each item was committed separately (messages
`crm-oneway-r4-<n>`).

| item | rule | change | tests |
|---|---|---|---|
| 2 | O5 | A mistaken cancel can be undone by **any** status, «Пришёл» included. `restoreReleased` runs before the arrival rule (`visit-status.js`). Before this, a cancelled → arrived visit left the delivered service as «назначьте новую дату» and the card never closed. | H1 (`crm-one-way-r4-money-a`), `one-way.test.js` |
| 4 | O5 / I5 | A line that held the visit **without** a visit line is released with `released_held = 1` (migration 248). A restore makes it hold the visit again, so the arrival places it. A line released because a human removed its visit line (O3) is not brought back. | M5 (`-money-c`), `one-way.test.js` |
| 3 | O1 | "Same service" now works both ways. A doctor-less side matches any doctor in `sameAsWish`, adoption and yield. The visit line's doctor never changes, and the own doctor's line is taken first. | M1, D1, S1 (`-money-b`), `one-way.test.js` |
| 7 | O10 / R4 | A cancel recomputes or clears the card date **only** when that date is the cancelled booking's day. That day includes the day the booking was moved from in the same `calendar_book` call (`fromVisitDate`), found by the falsification check. | F1 (`-funnel`), `crm-one-way.test.js` (2) |
| 8 | UI i18n | The card's refusal toasts translate the server text too (`tr` inside `trf`; 3 sites in `crm.js`). | `crm-card.test.mjs`: real save with a door refusal, uz and en |
| 1+5+6 | O8 | The repair **deletes nothing** (controller decision). Rules are in Task 5, "Revised in review r4". A cancelled booking linked only for display (C′, phone) is not evidence for rule 3 (falsification check). | `one-way-repair.test.js` (4), H2/H3 (`-o8`), old databases (`-o8-old`, 5 tests, `CRM_O8_OLD_DB`) |
| P1 | privacy | Passes unchanged; ported. | `-privacy` |
| optional | UI | In «Даты приёма», the service rows and «Одна дата для всех» wrap at 360 px; the 1280 px layout is unchanged. | `crm-card.test.mjs`; Playwright `crm-one-way/ui/sheet-ui.mjs` (scratchpad) at 360 px ru/uz/en: nothing past the sheet's edge |

Known limit (by decision): O8 can only use the 0–2 s rule to tell a mirror copy from an operator wish. In the
review's old-D database, the operator's analysis wish (saved 1 s after the registrar line) is therefore marked
`legacy_copy`. The repair keeps it, but a later cancel of that registrar booking cancels it instead of releasing it.

Verification after r4 (narrow sets; `LIS_ENABLED=0`; disk guard 120 MB):

| set | ru | en-US |
|---|---|---|
| wide CRM (incl. every ported repro, migrations 246–248) | 1145: 1138 pass, 0 fail, 5 skipped (old-database test without `CRM_O8_OLD_DB`), 2 todo | same |
| door matrix | 110/110 | 110/110 |
| money (cashier*, billing*) | 243/243 | 243/243 |
| client harnesses | 419/419 | 419/419 |
| server guards | 38/38 | 38/38 |
| UI guards | 43/43 | 43/43 |
| repro ports (`crm-one-way-r*`, services/crm and services/api ports) | 161: 156 pass, 5 skipped (same file) | same |
| O8 upgrade of the review's old databases (`CRM_O8_OLD_DB` = `r4/olddb`; `r4/v316db`) | 5/5; 5/5 | 5/5; 5/5 |

### Adversarial review r5 of 0ee5356f (2026-10-17) — fixes, test-first

| item | rule | change | tests |
|---|---|---|---|
| 1 (money) | O1 | A visit line of a service that needs a doctor is shared only by wishes whose named doctors agree (the same doctor, or none named). A doctor-less line is claimed by at most one named doctor; a wish naming another doctor gets its own line (`wishHome`). | R5-SYM-a/b (`crm-one-way-r5-same`), `one-way.test.js` |
| 2 | O1 / R7b | A CRM line with a named doctor yields only to a line of the same doctor, or when it has no doctor itself — the `retireBookedTwin` rule. Yield is one-way again; adoption stays symmetric. | R5-SYM-c, `one-way.test.js` |
| 3 | O8 rule 3 | Release only a wish whose service was in the cancelled visit and that was created before the cancel. | R5-RD-a (`crm-one-way-r5-o8`), `one-way-repair.test.js` |
| 4 | O8 rule 3 | Never release when the card holds a live booking that day. | R5-RD-b, `one-way-repair.test.js` |

Re-checked and passing as ported: R5-UC, R5-DATE-a, R5-RD-c, R5-LC. The narrow-run script now gives every run its
own temp dir (TEMP/TMP), so it never deletes another suite's em-* dirs in %TEMP%.

Verification after r5 (narrow sets; `LIS_ENABLED=0`; disk guard 120 MB):

| set | ru | en-US |
|---|---|---|
| wide CRM (incl. every ported repro) | 1160: 1149 pass, 0 fail, 9 skipped (old-database tests without `CRM_O8_OLD_DB`), 2 todo | same |
| door matrix | 110/110 | 110/110 |
| money (cashier*, billing*) | 243/243 | 243/243 |
| client harnesses | 419/419 | 419/419 |
| server guards | 38/38 | 38/38 |
| UI guards | 43/43 | 43/43 |
| repro ports | 174: 165 pass, 9 skipped (same files) | same |
| O8 on the review's old databases (`crm-one-way-r4-o8-old` + `crm-one-way-r5-o8-all`; `r4/olddb`; `r4/v316db`) | 9/9; 9/9 | 9/9; 9/9 |

---

## Self-review

- Spec coverage: O1 (Task 2 attachWish, Task 3 step A), O2 (Task 3 — copies removed at booking_lines_add, step 3, cashier), O3 (Task 2/3 removeFromBooking, releaseOrphans, attachCardLines, refusal; Task 7 UI), O4 (releaseCancelled, step A filter), O5 (restoreReleased + calendar restore), O6 (followVisitMove, refusal), O7 (attachHeldLines/'done', syncLineFromVisit, doctor follow), O8 (Task 5), O9 (unchanged code paths; matrix), O10 (Task 1 trigger, Task 4). Acceptance: twin todos (Task 3 table), repros (Task 6), matrix 110/110 (Task 3/4), money snapshots (every scenario), ru/en (every task), UI (Task 7).
- Readings 1–7 above are the only places where the spec text and the code disagreed; none moves money.
