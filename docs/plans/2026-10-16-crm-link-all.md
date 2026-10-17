# CRM_LINK_ALL_V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every booking door (call centre, calendar, registration wizard, fast registration, «Повторный визит», cashier) reaches the patient's live CRM card, so the card shows the booked/registered services and moves to the right column — and no booked service lands in the visit twice.

**Architecture:** The rules live in `server/services/crm/visit-link.js` (`crmLinkVisit` steps A–G, `deskCloses`, new `crmWonCardLines`) and `server/services/crm/visit-status.js` (new «Подтверждён» branch). The shared mirror `booking-mirror.js` only gets `export` keywords on three existing helpers — no rule change inside it. The server safety net for twin lines (R7b) sits at the `/api/db` door (`routes/db.js` → new `crm/booked-twin.js`). Client doors (`visit-wizard.js`, `fast-registration.js` + `walk-in-booking.js`) get the «now» desk flag (R3) and the «из записи» rows (R7a). The frozen door matrix `tests/crm-doors/` is the acceptance test; each task flips its GAP cells from `test.todo` to real tests.

**Tech Stack:** Node 24 ESM server (`server/`), better-sqlite3, `node:test` (`node --experimental-vm-modules --test`), vanilla-JS admin client (`public/js/admin/`), i18n dictionary `public/js/admin/i18n-strings.js`.

**Spec:** `docs/specs/2026-10-16-crm-link-all-doors-design.md` (D1–D4, R1–R7, G1–G7). Earlier rules: `docs/specs/2026-10-09-crm-unify-design.md`.

---

## Task list

- [ ] Task 0 — Bring the frozen door matrix into the branch (`tests/crm-doors/`)
- [ ] Task 1 — R1 + R2: the patient's live card holds every booking (any day, any role, any age; the desk too)
- [ ] Task 2 — R5: a phone-matched card is linked and shows the visit's services
- [ ] Task 3 — R6: services added to a desk-closed visit appear on its «Пришёл» card
- [ ] Task 4 — R4: calendar «Подтверждён» moves the card forward
- [ ] Task 5 — R3: the wizard's «now» registration is a desk arrival (client + server guard)
- [ ] Task 6 — R7b: server safety net — a registration line replaces the booked line of the same service
- [ ] Task 7 — R7a: «из записи» rows in fast registration and the wizard
- [ ] Task 8 — Full-suite verification (ru + en-US), marker sweep, adversarial re-check

R7b comes before R7a on purpose: the matrix replays the browser's calls of today's screens, so the server net is what flips the two G7 cells; R7a then removes the second insert in the screens themselves (each fix round gets its own re-check — the twin lines defeated four earlier rounds).

---

## Ground rules for every task (read once)

- **Clone:** `C:\Users\user\Desktop\implementation workflow\easymed.crm`, branch `feat/crm-link-all`, `core.autocrlf=false`, own `node_modules`. `origin` is the local `easymed.local` — **never push**, never touch `easymed.local` or `easymed.api5`. Disk C: is nearly full (~2.9 GB): no `git archive` exports, no copies of the repo.
- **Line endings:** LF only. After writing a file run `node -e "const s=require('fs').readFileSync(process.argv[1],'utf8'); if (s.includes('\r')) { console.error('CRLF in', process.argv[1]); process.exit(1); }" <file>`.
- **Marker:** every code comment, test name and commit message of this work carries `CRM_LINK_ALL_V1`.
- **Commits:** `git commit -F <msgfile>` with a Russian message ending in the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Before `git add`: `git diff --cached --name-only` must print nothing. Stage only the files of the task (`git add <paths>`), never `git add -A`.
- **Test commands** (Git Bash; the suite's own runner is `node --experimental-vm-modules --test`):
  - one or more files: `cd "/c/Users/user/Desktop/implementation workflow/easymed.crm" && LIS_ENABLED=0 node --experimental-vm-modules --test <file> [<file> …]`
  - en-US run of the same files: add `--import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs`
  - the door matrix alone takes ~3.5 min: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs` → baseline `ℹ tests 100 · pass 70 · fail 0 · todo 30`.
  - one cell's observed record: `LIS_ENABLED=0 node tests/crm-doors/discover.mjs <id-prefix>` (prints `"<id>": {…},`).
- **Money and privacy invariants — every task keeps all of them** (each task's tests name the ones it touches):
  - I1 a card's STAGE never decides SERVICES (no line is added to or removed from a bill because of a column);
  - I2 closed cards («Пришёл» and every lost column except the seeded «Не пришёл») never reopen and never get a new booking;
  - I3 a phone match never puts the card's own lines into that patient's visit or bill (shared family phones);
  - I4 billed or started visit lines (`invoice_item_id`, status ≠ 'added', children rows, clinic items) are never touched;
  - I5 visits of another building (`sync_origin`) are untouched;
  - I6 one patient — one live visit per day (no second visit);
  - I7 «не бросает»: CRM hooks never fail a booking, a registration or a payment (errors go to the log);
  - I8 nothing about another operator's card leaks into a response.
- **UI rules (Task 7; Task 5 has no visible change):** every new string in ru/uz/en in `public/js/admin/i18n-strings.js` (no Cyrillic in uz/en values), type-scale font sizes already used in the file (12.5px / 13.5px), icons only via `Icon()`, no emoji, works at 360 px (no fixed widths wider than the row; chips wrap).
- **Where the code in this plan comes from:** every code block was run on a throw-away prototype in this clone on 2026-10-16 (then reverted). The prototype is kept for reference only, in scratch: `crm-link-all-prototype.patch` (tracked files) and `crm-link-all-prototype-new-files.tar` (new files) — it carries temporary `CLA_OFF` toggles (`// PROTOTYPE TOGGLE`) used to measure each intermediate state; never apply it as is. The plan, not the patch, is the source of truth.
- **Lesson baked in:** `server/services/crm/booking-mirror.js` has defeated four fix rounds on twin lines. This plan changes NO rule inside it: Task 6 only adds `export` to `vsFree`, `deleteVs`, `relinkHeld`. Any task that finds itself editing a mirror function body must stop and report.

---

## File map

| file | change | task |
|---|---|---|
| `tests/crm-doors/{matrix.test.mjs,scenarios.mjs,scenarios-789.mjs,helpers.mjs,discover.mjs,MATRIX.md}` | create (copy of the frozen matrix, relative import); later tasks add `DECIDED` cells and «now» scenarios | 0–7 |
| `server/services/crm/visit-link.js` | step C′ in `linkTx` (R1, and R2 at the desk — `deskCloses` itself unchanged), phone link in step F (R5), new `crmWonCardLines` + call in `deskArrive` (R6), `deskArrival` comment only (R3) | 1, 2, 3, 5 |
| `server/services/crm/visit-status.js` | 'confirmed' branch (R4) | 4 |
| `server/services/crm/config.js` | `confirmedStageKey(db)` (R4) | 4 |
| `public/js/shared/crm-booked-stage.js` | pure `confirmedStageKeyOf(stages, bookedKey)` (R4) | 4 |
| `server/services/crm/booking-mirror-db.js` | `/api/db` door calls `crmWonCardLines` after the mirror (R6) | 3 |
| `server/services/rpc/billing.js` | `cashier_line_add` calls `crmWonCardLines` (R6) | 3 |
| `server/services/rpc/visits.js` | `ensure_visit` passes `desk` on the book paths when the slot is «now» (R3) | 5 |
| `public/js/admin/views/wizard-desk.js` | create: pure `isDeskNow` + `DESK_NOW_MINUTES` (R3, shared by client and server) | 5 |
| `public/js/admin/views/visit-wizard.js` | sends `desk: true` for a «now» day (R3); «из записи» cart lines (R7a) | 5, 7 |
| `server/services/crm/booked-twin.js` | create: `retireBookedTwin(db, vsId)` (R7b) | 6 |
| `server/services/crm/booking-mirror.js` | `export` on `vsFree`, `deleteVs`, `relinkHeld` only | 6 |
| `server/routes/db.js` | single-row `visit_services` insert calls `retireBookedTwin` before `mirrorAfter` (R7b) | 6 |
| `public/js/admin/views/booked-rows.js` | create: `loadTodayBooking(patientId)` — today's pre-arrival visit and its lines (R7a) | 7 |
| `public/js/admin/views/walk-in-booking.js` | `registerWalkIn` reuses booked rows, removes dropped ones (R7a) | 7 |
| `public/js/admin/views/fast-registration.js` | «из записи» rows (R7a) | 7 |
| `server/test-helpers/crm-link-all.js` | create: door helpers for the new server tests | 1 |
| `server/routes/crm-link-all-{live-card,phone,desk-lines,confirmed,desk-now,twin}.test.js` | create: one test file per rule | 1, 2, 3, 4, 5, 6 |
| `public/js/admin/__tests__/wizard-desk.test.mjs` | create (R3 pure rule); `wizard-booking.test.mjs`, `walk-in-booking.test.mjs`, `fast-registration.test.mjs` — tests appended | 5, 7 |
| 12 existing server tests (table in the Self-review) | expectations changed by D1–D4 | 1, 2, 4, 5 |
| `public/js/admin/i18n-strings.js` | 7 new strings ru/uz/en (Task 5 adds none) | 7 |

---

## Task 0: Bring the frozen door matrix into the branch

**Files:**
- Create: `tests/crm-doors/matrix.test.mjs`, `tests/crm-doors/scenarios.mjs`, `tests/crm-doors/scenarios-789.mjs`, `tests/crm-doors/helpers.mjs`, `tests/crm-doors/discover.mjs`, `tests/crm-doors/MATRIX.md`
- Source: `C:\Users\user\AppData\Local\Temp\claude\c--Users-user-Desktop-ailos-agentic-system\cdaa5eb3-8422-4424-8c3a-38580164abe3\scratchpad\crm-doors\`

Only `matrix.test.mjs` matches the runner's default discovery (`**/*.test.mjs`); the other `.mjs` files are imported by it and are not run on their own. `discover.mjs` is a dev tool (prints a cell) — no test pattern matches it.

- [ ] **Step 1: Copy the files**

```bash
cd "/c/Users/user/Desktop/implementation workflow/easymed.crm"
S=/c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/crm-doors
mkdir -p tests/crm-doors
cp "$S/matrix.test.mjs" "$S/scenarios.mjs" "$S/scenarios-789.mjs" "$S/helpers.mjs" "$S/discover.mjs" "$S/MATRIX.md" tests/crm-doors/
sed -i 's/\r$//' tests/crm-doors/*        # matrix.test.mjs arrives with CRLF (142 lines)
for f in tests/crm-doors/*; do printf "%s " "$f"; tr -cd '\r' < "$f" | wc -c; done   # every count must be 0
```

- [ ] **Step 2: Make the repo import relative** — in `tests/crm-doors/helpers.mjs` replace

```js
export const REPO = process.env.REPO_URL
  || 'file:///C:/Users/user/Desktop/implementation%20workflow/easymed.local/';
```

with

```js
// CRM_LINK_ALL_V1 — the matrix lives in the repo now: by default it tests the tree it sits in.
export const REPO = process.env.REPO_URL || new URL('../../', import.meta.url).href;
```

and in the header comment of `helpers.mjs` replace `// CRM doors evidence matrix — shared helpers (scratch, not part of the repo).` with `// CRM doors evidence matrix — shared helpers (CRM_LINK_ALL_V1 acceptance test, frozen 2026-10-16).`

- [ ] **Step 3: Fix the run instructions in the headers** — in `tests/crm-doors/matrix.test.mjs` replace the two lines

```js
// Run (from this folder):  LIS_ENABLED=0 node --test matrix.test.mjs
// Older tree:              REPO_URL=file:///…/old/ LIS_ENABLED=0 node --test matrix.test.mjs
```

with

```js
// Run (repo root):  LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs
// Older tree:       REPO_URL=file:///…/old/ LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs
// CRM_LINK_ALL_V1 — acceptance test of docs/specs/2026-10-16-crm-link-all-doors-design.md.
```

In `tests/crm-doors/MATRIX.md` replace the line ``Work in progress; updated after each door. Tests: `scratchpad\crm-doors\matrix.test.mjs` `` with ``Frozen 2026-10-16 (CRM_LINK_ALL_V1 acceptance test). Tests: `tests/crm-doors/matrix.test.mjs` `` and the run line `` Run: `LIS_ENABLED=0 node --test matrix.test.mjs`. `` with `` Run (repo root): `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs`. ``

Nothing else changes: the EXPECT table, the scenarios and the GAP todos stay byte-for-byte as frozen.

- [ ] **Step 4: Run it**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -12`
Expected (verified 2026-10-16 in this clone, 3 min 17 s):
```
ℹ tests 100
ℹ pass 70
ℹ fail 0
ℹ todo 30
```
(A failing todo is reported as TODO with its AssertionError text — that is expected: they are the 30 gaps.)

Run the en-US variant once too (same counts): add the `--import …force-en.mjs` flag from the ground rules.

- [ ] **Step 5: Commit**

```bash
git diff --cached --name-only          # must print nothing
git add tests/crm-doors/
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t0.txt <<'EOF'
CRM: замороженная матрица дверей в ветке — tests/crm-doors (70 наблюдаемых клеток, 30 «GAP» как todo), импорт относительный (CRM_LINK_ALL_V1)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t0.txt
```

### How later tasks flip a GAP cell (one mechanism for all tasks)

Task 1 Step 1 adds this block to `tests/crm-doors/matrix.test.mjs` (once); every later task only adds entries to `DECIDED` and, where noted, scenarios.

Below `const EXPECT = { … };` insert:

```js
// ═══ CRM_LINK_ALL_V1 — DECIDED CELLS ═══════════════════════════════════════
// A cell whose rule an owner decision (D1–D4) or a defect fix (G4, G7) changed.
// `cell` replaces EXPECT[id] (today's behaviour above stays as the frozen record);
// `owner` names the OWNER predicate the cell must meet (null — an intermediate cell of a
// later task: the cell is pinned, its GAP stays todo); `rule` cites the decision.
// A GAP todo of a decided cell runs as a REAL test. Each task adds its own cells.
const DECIDED = {
};
```

Add to `OWNER` and `OWNER_TEXT` (D2 needs a «booking» predicate for a later slot today):

```js
  // CRM_LINK_ALL_V1 (D2) — a later slot today is a booking: the card shows the visit and waits in the booked column.
  booked: (o) => o.stage === 'scheduled' && o.lines.some((l) => l.endsWith('/V')),
```
```js
  booked: 'a later slot today stays a booking: «Записан» with the visit on the card (D2)',
```

Replace the loop at the bottom with:

```js
for (const sc of SCENARIOS) {
  const name = `DOOR ${sc.door} / ${sc.state} (${sc.who}) [${sc.id}]: ${sc.desc}`;
  const dec = DECIDED[sc.id] || null;
  test(name, async () => {
    const o = await observe(sc);
    rows.push({ id: sc.id, o });
    assert.deepEqual(o, dec ? dec.cell : EXPECT[sc.id], dec ? `CRM_LINK_ALL_V1 ${dec.rule}: decided cell` : 'today\'s behaviour changed');
    if (dec && dec.owner) assert.ok(OWNER[dec.owner](o), `CRM_LINK_ALL_V1 ${dec.rule}: ${OWNER_TEXT[dec.owner]}`);
  });
  if (sc.gap && dec && dec.owner) {
    test(`GAP→${dec.rule}: DOOR ${sc.door} / ${sc.state} (${sc.who}) [${sc.id}]: ${OWNER_TEXT[dec.owner]}`, async () => {
      const o = await observe(sc);
      assert.ok(OWNER[dec.owner](o), 'CRM_LINK_ALL_V1 decided expectation not met: ' + JSON.stringify(o));
    });
  } else if (sc.gap) {
    test.todo(`GAP: DOOR ${sc.door} / ${sc.state} (${sc.who}) [${sc.id}]: ${OWNER_TEXT[sc.gap.expect]} — ${sc.gap.reason}`, async () => {
      const o = await observe(sc);
      assert.ok(OWNER[sc.gap.expect](o), 'owner expectation not met: ' + JSON.stringify(o));
    });
  }
}
```

(The decided cell is asserted twice — once as the cell, once as the GAP→rule predicate — so the old GAP name keeps a real test in the report.)

---

## Task 1: R1 + R2 — the patient's live card holds every booking (any day, any role, any age; the desk too)

**Decision:** D1. **Gaps:** G1, G2. **Spec:** R1, R2.

**How (decided from the code):** a new step **C′** in `linkTx` (`server/services/crm/visit-link.js`), right after step C. Step C stays exactly as it is (cards that wait for THIS day / that the desk closes today — it may take several, as today). Only when A, B and C found nothing, C′ asks `contactDecision` (`contact-window.js` — the very rule step E uses for the call centre) over the patient's LIVE cards (`liveKeys`: open columns + seeded «Не пришёл»): it picks the one that moved last (`updated_at`, else `created_at`, ties → higher id — the `ORDER BY` inside `contactDecision`); `same` → take it; `reopen` → `reopenLead` first (the trail `prevOf` keeps the stage before the reopen); then F (link, source `'patient'`) and G (forward to the booked column; at the desk «Пришёл»). Because C′ runs before D and E, step E now only sees patients without a live card (`closed` / `new` — today's behaviour). R2 needs no change inside `deskCloses`: at the desk, C′ takes the live card of any age when `deskCloses` took none.

**Plan decisions (the code settles them):**
- C′ only for visits of today or later (`v.day >= today(db)`): booking a past day is a correction of history, not a contact. Test «R1: запись ПРОШЛОГО дня».
- «any age» keeps `contactDecision`'s I-4 rule: an old card that WAITS for a future booking is `same` (no reopen), exactly as step E does today.
- Link source: `'patient'` for C′ (spec R1); `'callcenter'` stays for a pure call-centre user. Nothing on the server reads `crm_booking_links.source` (only writers: `grep -rn "crm_booking_links" server --include=*.js`).
- Two live cards where one waits for THIS day: step C takes that one (as today) and C′ does not run — C′ is a fallback, not a replacement.

**Files:**
- Modify: `server/services/crm/visit-link.js` — import `liveKeys` (:113); header comment (after the «E.» paragraph, :42-47); step C′ after the step-C loop (:466-472); drop `const prevOf = new Map();` from step E (:491; now declared in C′); step F (:513-521)
- Create: `server/test-helpers/crm-link-all.js` (door helpers shared by Tasks 1–6)
- Create: `server/routes/crm-link-all-live-card.test.js`
- Modify: `tests/crm-doors/matrix.test.mjs` — the DECIDED mechanism (section «How later tasks flip a GAP cell») + 13 cells
- Modify (rule changed by D1 — table below): `server/routes/crm-unify-desk-money.test.js`, `server/routes/crm-unify-desk.test.js`, `server/routes/crm-unify-final-status.test.js`, `server/routes/crm-unify-link-guards.test.js`, `server/routes/crm-unify-link.test.js`, `server/services/crm/unify-review-t5t6.test.js`

**Existing tests that encode the old rule.** Found by running all 269 test files that touch these doors (`git ls-files "*.test.js" "*.test.mjs" | xargs grep -l "ensure_visit\|ensureVisit\|calendar_book\|calendarBook\|booking_lines_add\|crmLinkVisit\|crmVisitStatus\|crm_requests\|cashier_line_add\|visit_services"`) against the finished prototype of Tasks 1–6 on 2026-10-16: 3829 pass, 13 CRM failures — the 12 tests whose rule the owner decisions change (listed by task) plus `crm-unify-final-status.test.js:61` (A-I4), broken only by a prototype variant of R4 that this plan drops (Task 4) — and 11 LIS e2e failures that are environmental (`server/lis/real-analyzers.e2e.test.js`, `connect ECONNREFUSED 127.0.0.1:55xx` under `LIS_ENABLED=0` — not CRM). Task 1 changes these nine, each because of D1:

| file:line — test | old rule | new expectation |
|---|---|---|
| `server/routes/crm-unify-desk-money.test.js:395` «C4e: «Новый лид» 90 дней без строк и даты — ни регистрация без стойки, ни запись, ни оплата его не трогают» | a 90-day card ignored by every door | registration without desk → `scheduled`; calendar booking → `scheduled`; payment → `came` |
| `server/routes/crm-unify-desk.test.js:155` «стойка: карточку, ждущую другой день, ни врач с desk, ни регистратура без desk не двигают» | a card waiting for another day is not moved | `['scheduled', TODAY]` for both; the card's line of day D keeps `visit_id = null` |
| `server/routes/crm-unify-desk.test.js:442` «стойка: «Не пришёл» в пределах окна (пришёл на день позже) — «Пришёл»; давний «Не пришёл» — не трогается» | old «Не пришёл» untouched at the desk | case `[10, -10]` → `'came'` (date kept; `discard_empty_visit` returns `no_show` — the trail keeps the stage before the reopen) |
| `server/routes/crm-unify-desk.test.js:527` «R7: desk — только true или "true"; день — только сегодня по местному времени» | non-true desk / tomorrow → card untouched | non-true desk → `'scheduled'`; tomorrow 10:00 → `'scheduled'`; yesterday → `'in_process'` (past day) |
| `server/routes/crm-unify-final-status.test.js:150` «A-P5: пропущенный день давнее окна — поздний приход через мастер визита карточку не поднимает» | old «Не пришёл» stays after wizard + payment | after `ensure_visit` → `scheduled`; after payment → `came` |
| `server/routes/crm-unify-link-guards.test.js:276` «строка без даты не встаёт в запись календаря и booking_lines_add; ensure_visit её берёт» | the fresh card is not moved by a booking for another day | card lines `[[30, null], [40, vid]]`, stage `scheduled` (the undated consultation still stays out of the analysis visit) |
| `server/routes/crm-unify-link.test.js:78` «карточку, ждущую ДРУГОЙ день, сегодняшняя запись не двигает» | not moved | `['scheduled', D]`, link `{request_id: rid, source: 'patient'}`, the D2 line keeps `visit_id = null` |
| `server/services/crm/unify-review-t5t6.test.js:209` «W1b (I-5): давняя карточка после прохода — посторонний приход на стойку её не закрывает» | 200-day «Не пришёл» stays | `'came'` |
| `server/services/crm/unify-review-t5t6.test.js:256` «I-3: «Не пришёл» за окном — запись колл-центра возвращает её в начало и записывает; давний «Не пришёл» запись регистратуры не трогает» | registrar booking leaves the old «Не пришёл» | `'scheduled'`, still one card |

**Invariants touched:** I1 (C′ moves only stage + link; the visit's lines reach the card through the mirror, visit → card), I2 (C′ reads only `liveKeys`), I6 (C′ creates no visit), I7 (C′ runs inside `crmLinkVisit`'s try/catch), I8 (`crmLinkVisit` returns nothing — test «колл-центр … ответ записи о ней молчит»).

- [ ] **Step 1: Shared door helpers** — create `server/test-helpers/crm-link-all.js`:

```js
// CRM_LINK_ALL_V1 — общие шаги серверных тестов плана docs/plans/2026-10-16-crm-link-all.md
// поверх стенда crm-unify-app.js: двери записи и регистрации так, как их зовут экраны.
// Не тестовый файл — его импортируют.
import assert from 'node:assert/strict';
import { at } from './crm-unify-app.js';

export const link = (t, vid) => t.db.prepare('SELECT request_id, source FROM crm_booking_links WHERE visit_id = ?').get(vid) || null;
export const undoOf = (t, vid, rid) => t.db.prepare('SELECT prev_status, set_status FROM crm_booking_undo WHERE visit_id = ? AND request_id = ?').get(vid, rid) || null;
export const vsOf = (t, vid) => t.db.prepare("SELECT id, service_id, doctor_id, created_by FROM visit_services WHERE visit_id = ? AND status <> 'cancelled' ORDER BY id").all(vid);
export const cardLines = (t, rid) => t.db.prepare(`SELECT service_id, scheduled_date, status, visit_id, visit_service_id, visit_service_auto
                                                    FROM crm_request_services WHERE request_id = ? AND status <> 'cancelled' ORDER BY id`).all(rid);
const priceOf = (t, svc) => t.db.prepare('SELECT price FROM services WHERE id = ?').get(svc).price;

/** Строка визита через /api/db, как её вставляют экраны регистратуры (мастер, быстрая регистрация, каталог). */
export async function addVisitLine(t, who, vid, { svc = 30, doctor = 10, quantity = 1 } = {}) {
  const p = priceOf(t, svc);
  const r = await t.dbq(who, { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: vid, service_id: svc, doctor_id: doctor, quantity, unit_price: p, total: p * quantity, price_tier: 'primary', status: 'added' } });
  assert.equal(r.status, 200, r.text);
  return r.json.data.id;
}

/** Календарь → каталог услуг (не колл-центр): calendar_book, затем строка /api/db. */
export async function calendarBook(t, who, day, { hour = 12, svc = 30, doctor = 10, pid = 77 } = {}) {
  const b = await t.rpc('calendar_book', who, { patient_id: pid, doctor_id: doctor, service_id: svc, start: at(day, hour), duration_minutes: 30, status: 'scheduled' });
  assert.equal(b.status, 200, b.text);
  const vid = b.json.data.visit.id;
  await addVisitLine(t, who, vid, { svc, doctor });
  return vid;
}

/** Колл-центр в календаре: calendar_book, затем booking_lines_add. */
export async function callcenterBook(t, day, { hour = 12, svc = 30, doctor = 10, pid = 77, who = 'cc' } = {}) {
  const b = await t.rpc('calendar_book', who, { patient_id: pid, doctor_id: doctor, service_id: svc, start: at(day, hour), duration_minutes: 30, status: 'scheduled' });
  assert.equal(b.status, 200, b.text);
  const vid = b.json.data.visit.id;
  const add = await t.rpc('booking_lines_add', who, { visit_id: vid, patient_id: pid, lines: [{ service_id: svc, doctor_id: doctor, scheduled_at: at(day, hour) }] });
  assert.equal(add.status, 200, add.text);
  return vid;
}

/** Быстрая регистрация (walk-in-booking.js): ensure_visit desk:true без book, затем строки /api/db. */
export async function deskRegister(t, who = 'reg', { items = [{ svc: 30, doctor: 10 }], pid = 77 } = {}) {
  const head = items.find((i) => i.doctor) || null;
  const ev = await t.rpc('ensure_visit', who, { patient_id: pid, date: new Date().toISOString(), doctor_id: head ? head.doctor : null, visit_type: 'outpatient', desk: true });
  assert.equal(ev.status, 200, ev.text);
  const vid = ev.json.data.visit.id;
  const ids = [];
  for (const i of items) ids.push(await addVisitLine(t, who, vid, { svc: i.svc, doctor: i.doctor || null }));
  return { vid, ids };
}
```

(`server/test-helpers/no-test-helpers-in-production.test.js` forbids only production code importing `test-helpers/`.)

- [ ] **Step 2: Write the failing tests** — create `server/routes/crm-link-all-live-card.test.js`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R1 + R2: ЖИВАЯ КАРТОЧКА ПАЦИЕНТА ДЕРЖИТ ЛЮБУЮ ЕГО ЗАПИСЬ
// (docs/specs/2026-10-16-crm-link-all-doors-design.md, R1–R7), через настоящие двери
// (/api/rpc, /api/db) под настоящими ролями. Стенд — server/test-helpers/crm-unify-app.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, undoOf, vsOf, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';

const D = localDay(3);
const D2 = localDay(5);

// ─── R1 + R2 (решение D1) ──────────────────────────────────────────────────
test('CRM_LINK_ALL_V1 R1: регистратура записывает на ДРУГОЙ день — живая карточка держит визит, его услуга на карточке, строка своего дня не тронута', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3, date: D });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    const vid = await calendarBook(t, 'reg', D2);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'patient' }, 'визит другого дня не привязан к живой карточке');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id]),
      [[30, D, 'pending', null], [30, D2, 'pending', vid]], 'карточка не показывает услугу визита или тронула строку своего дня');
    const c = t.lead(rid);
    assert.equal(c.status, 'scheduled');
    assert.equal(c.scheduled_date, D2, 'дата карточки — ближайший записанный день (cardDateOf)');
    assert.equal(vsOf(t, vid).length, 1, 'в визите вторая строка');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: карточка без движения дольше окна — сначала в начало воронки, затем «Записан»; след отмены помнит прежнюю ступень', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', updated: daysAgoIso(5) });
    const vid = await calendarBook(t, 'boss', D);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'patient' });
    const c = t.lead(rid);
    assert.equal(c.status, 'scheduled');
    assert.equal(c.scheduled_date, D);
    assert.ok(Date.parse(c.updated_at) > Date.now() - 3600e3, 'запись после окна — контакт: updated_at не сдвинулся');
    assert.deepEqual(undoOf(t, vid, rid), { prev_status: 'recall', set_status: 'scheduled' }, 'discard_empty_visit вернёт не ту ступень');
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, vid]]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: две живые карточки, ни одна не ждёт этот день — визит берёт двигавшаяся последней; при равенстве — больший id', async () => {
  const t = await startCrmApp();
  try {
    const older = addLead(t.db, { updated: daysAgoIso(2) });
    addLine(t.db, older, { svc: 40, day: D2 });
    const newer = addLead(t.db, { updated: daysAgoIso(1) });
    addLine(t.db, newer, { svc: 40, day: D2 });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(link(t, vid).request_id, newer, 'взята не та карточка');
    assert.equal(t.lead(older).status, 'in_process', 'вторая карточка сдвинулась');
  } finally { t.close(); }
  const t2 = await startCrmApp();
  try {
    const same = daysAgoIso(1);
    const a = addLead(t2.db, { updated: same });
    addLine(t2.db, a, { svc: 40, day: D2 });
    const b = addLead(t2.db, { updated: same });
    addLine(t2.db, b, { svc: 40, day: D2 });
    const vid = await calendarBook(t2, 'reg', D);
    assert.equal(link(t2, vid).request_id, b, 'при равном движении — больший id');
  } finally { t2.close(); }
});

test('CRM_LINK_ALL_V1 R1: закрытые карточки («Пришёл», «Обработка остановлена») запись не получают и не открываются; новой карточки нет', async () => {
  const t = await startCrmApp();
  try {
    const came = addLead(t.db, { status: 'came' });
    const stopped = addLead(t.db, { status: 'stopped' });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(link(t, vid), null);
    assert.equal(t.lead(came).status, 'came');
    assert.equal(t.lead(stopped).status, 'stopped');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 2, 'регистратура завела карточку (решение 2)');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_request_services').get().n, 0, 'закрытой карточке приписана услуга');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: давняя «Не пришёл» — живая: запись на будущее возвращает её в начало и ставит «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'no_show', date: localDay(-10), updated: daysAgoIso(10) });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(link(t, vid).request_id, rid);
    assert.equal(t.lead(rid).status, 'scheduled');
    assert.equal(t.lead(rid).scheduled_date, D);
    assert.deepEqual(undoOf(t, vid, rid), { prev_status: 'no_show', set_status: 'scheduled' });
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: запись ПРОШЛОГО дня (правка истории) живую карточку не берёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    addLine(t.db, rid, { svc: 40, day: D2 });
    const vid = await calendarBook(t, 'reg', localDay(-1));
    assert.equal(link(t, vid), null);
    assert.equal(t.lead(rid).status, 'in_process');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: врач записывает «Повторный визит» на другой день — та же карточка; пациента без карточки — нет', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { date: D });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'doc', D2);
    assert.equal(link(t, vid).request_id, rid);
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[40, null], [30, vid]]);
    t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78,'Без Карточки','+998 91 000 00 01')").run();
    const v2 = await calendarBook(t, 'doc', D2, { pid: 78, hour: 15 });
    assert.equal(link(t, v2), null);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests WHERE patient_id = 78').get().n, 0);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R1: колл-центр — та же карточка, что и раньше (C′ до шага E), и ответ записи о ней молчит', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 4, date: D });
    addLine(t.db, rid, { svc: 30, day: D, doctor: 10 });
    const b = await t.rpc('calendar_book', 'cc', { patient_id: 77, doctor_id: 10, service_id: 30, start: at(D2, 12), duration_minutes: 30, status: 'scheduled' });
    assert.equal(b.status, 200, b.text);
    const vid = b.json.data.visit.id;
    const add = await t.rpc('booking_lines_add', 'cc', { visit_id: vid, patient_id: 77, lines: [{ service_id: 30, doctor_id: 10 }] });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'callcenter' });
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, 1, 'колл-центр завёл вторую карточку');
    assert.ok(!JSON.stringify(b.json).includes('"request_id"') && !JSON.stringify(add.json).includes('crm_requests'), 'ответ раскрывает карточку');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R2: стойка закрывает живую карточку ЛЮБОЙ давности — возврат в начало, затем «Пришёл»; дата прежняя', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'recall', date: localDay(-20), updated: daysAgoIso(20) });
    const { vid } = await deskRegister(t, 'reg');
    assert.equal(link(t, vid).request_id, rid);
    assert.equal(t.lead(rid).status, 'came');
    assert.equal(t.lead(rid).scheduled_date, localDay(-20), 'стойка сменила дату карточки');
    assert.deepEqual(undoOf(t, vid, rid), { prev_status: 'recall', set_status: 'came' });
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R2: две карточки — свежая закрывается, старая (другое обращение) остаётся как была', async () => {
  const t = await startCrmApp();
  try {
    const old = addLead(t.db, { status: 'recall', updated: daysAgoIso(30) });
    const fresh = addLead(t.db, {});
    await deskRegister(t, 'reg');
    assert.equal(t.lead(fresh).status, 'came');
    assert.equal(t.lead(old).status, 'recall', 'стойка закрыла и старую карточку: шаг C уже взял свежую, C′ не нужен');
  } finally { t.close(); }
});
```

- [ ] **Step 3: Run — must fail**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-live-card.test.js 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: the tests «ДРУГОЙ день», «без движения дольше окна», «две живые карточки», «давняя «Не пришёл»», «врач … «Повторный визит»» and «R2: стойка закрывает … ЛЮБОЙ давности» FAIL (`link(t, vid)` is `null` / stage unchanged); «закрытые карточки», «ПРОШЛОГО дня», «колл-центр» and «R2: две карточки» PASS already — they pin boundaries that must survive.

- [ ] **Step 4: Implement step C′** — in `server/services/crm/visit-link.js`:

(a) line 113 — replace the import with
```js
import { contactDecision, reopenLead, inWindowSql, windowArg, leadInWindow, firstStageKey, liveKeys } from './contact-window.js';   // CRM_LINK_ALL_V1 — liveKeys (шаг C′)
```

(b) header — after the line `//      (Р5); иначе новая («Звонок», оператор — он же);` insert
```js
//   C′. CRM_LINK_ALL_V1 (решение владельца D1, R1/R2; между C и D) — ни A, ни
//      B, ни C ничего не нашли: ЖИВАЯ карточка пациента (liveKeys — открытые и
//      сидовая «Не пришёл») держит запись любого дня, любой роли, любой
//      давности, и на стойке тоже: двигавшаяся последней; после окна — сначала
//      reopenLead (contactDecision, как у E). Закрытые — никогда. Только запись
//      на сегодня или позже. До E доходит только пациент без живой карточки;
```

(c) right after the step-C loop (the block that ends `    if (take) touched.set(r.id, 'patient');` + `  }`, :466-472) insert
```js

  // C′. CRM_LINK_ALL_V1 (R1, R2; решение владельца D1) — ЖИВАЯ КАРТОЧКА
  //    ПАЦИЕНТА ДЕРЖИТ ЛЮБУЮ ЕГО ЗАПИСЬ: любой день, любая роль, любая
  //    давность, и стойка тоже. Ни A, ни B, ни C не нашли карточку — визит
  //    берёт живая карточка пациента (открытые колонки и сидовая «Не пришёл»,
  //    liveKeys) тем же решением, что шаг E колл-центра (contactDecision):
  //    из нескольких — двигавшаяся последней (updated_at, иначе created_at;
  //    равные — больший id); не двигалась в окне и ничего не ждёт — сначала
  //    возврат в начало воронки (reopenLead, история внутри), потом G.
  //    Закрытые («Пришёл», «Отказ»…) не берутся никогда. Только запись на
  //    сегодня или позже: правка визита прошлого дня — история, не обращение.
  const prevOf = new Map();
  if (!touched.size && v.day >= today(db)) {
    const liveIds = db.prepare(`SELECT id FROM crm_requests WHERE patient_id = ? AND status IN (${holes(liveKeys(db))})`)
      .all(v.patient_id, ...liveKeys(db)).map((r) => r.id);
    const d = liveIds.length ? contactDecision(db, liveIds) : null;
    if (d && (d.action === 'same' || d.action === 'reopen')) {
      if (d.action === 'reopen') {
        prevOf.set(d.lead.id, db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id = ?').get(d.lead.id));
        reopenLead(db, d.lead.id);
      }
      touched.set(d.lead.id, 'live');
    }
  }
```

(d) step E (:490-492) — replace
```js
  //    окне: новой нет, закрытую не трогаем, привязки нет (Р5).
  const prevOf = new Map();
  if (!touched.size && callcenter && !desk) {   // CRM_UNIFY_V1 — !desk
```
with
```js
  //    окне: новой нет, закрытую не трогаем, привязки нет (Р5).
  //    CRM_LINK_ALL_V1 — живую карточку уже взял шаг C′: сюда доходит только
  //    пациент без живой карточки (решение — closed или new).
  if (!touched.size && callcenter && !desk) {   // CRM_UNIFY_V1 — !desk
```

(e) step F (:513-521) — replace the whole block with
```js
  // F. Привязка записи — для C, C′ и E (A держит визит строками, D — только пациент).
  //    CRM_LINK_ALL_V1 — и C′ (source 'patient').
  if (!held) {
    const pick = [...touched].find(([, via]) => ['patient', 'live', 'callcenter', 'created'].includes(via));
    if (pick) {
      const source = callcenter ? 'callcenter' : pick[1] === 'live' ? 'patient' : 'match';   // CRM_LINK_ALL_V1
      db.prepare(`INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source, created_by, created_request)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(v.id, pick[0], source, uid, pick[1] === 'created' ? 1 : 0);
    }
  }
```
Step G needs no change: it handles every `via` except `'created'`, and `prevOf.get(id) || r` already gives the trail the pre-reopen stage.

- [ ] **Step 5: Run the new tests — must pass**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-live-card.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 10`, `ℹ pass 10`, `ℹ fail 0` (verified on the prototype).

- [ ] **Step 6: Update the nine existing tests (D1)** — exact replacements:

`server/routes/crm-unify-desk-money.test.js:394-406` — replace the comment line `// P3 — карточка без строк и без даты «ждёт» прихода только в окне — на ЛЮБОЙ двери.` and the test «C4e: «Новый лид» 90 дней …» with
```js
// P3 — карточка без строк и без даты «ждёт» прихода только в окне — на ЛЮБОЙ двери.
// CRM_LINK_ALL_V1 (решение владельца D1, R1) — правило изменено: живая карточка
// пациента держит ЛЮБУЮ его запись, любой давности. Давняя — сначала в начало
// воронки, затем «Записан»; оплата визита закрывает её «Пришёл».
test('C4e (CRM_LINK_ALL_V1, D1): «Новый лид» 90 дней без строк и даты — регистрация без стойки возвращает его в начало и записывает, оплата закрывает', async () => {
  const t = await startCrmApp(seed);
  try {
    const rid = addLead(t.db, { updated: daysAgoIso(90), name: '90d lead' });
    const { inv } = await walkIn(t, [[50, null]], { desk: false });
    assert.equal(t.lead(rid).status, 'scheduled', 'живая карточка не взяла регистрацию (D1)');
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 10), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    assert.equal(t.lead(rid).status, 'scheduled');
    await pay(t, inv);
    assert.equal(t.lead(rid).status, 'came', 'оплата визита карточки не закрыла её');
  } finally { t.close(); }
});
```

`server/routes/crm-unify-desk.test.js:155-166` — replace the test «стойка: карточку, ждущую другой день, ни врач с desk, ни регистратура без desk не двигают» with
```js
// CRM_LINK_ALL_V1 (решение владельца D1, R1) — правило изменено: живая карточка
// держит любую запись пациента. Врачу desk по-прежнему не верят (не «Пришёл»), но
// сегодняшний визит — запись этой карточки: «Записан», дата — ближайший записанный
// день (сегодня); строка дня D остаётся ждать своего дня.
test('стойка (CRM_LINK_ALL_V1, D1): карточку, ждущую другой день, врач с desk и регистратура без desk записывают, а не закрывают', async () => {
  for (const [who, args] of [['doc', { desk: true }], ['reg', {}]]) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, { assigned: 3, date: D });
      addLine(t.db, rid, { svc: 40, day: D });
      const r = await t.rpc('ensure_visit', who, { patient_id: 77, date: nowIso(), doctor_id: 10, ...args });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', TODAY], who);
      assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[40, null]], who + ': строка дня D взяла сегодняшний визит');
    } finally { t.close(); }
  }
});
```

`server/routes/crm-unify-desk.test.js:443` — replace
```js
  for (const [ago, date, want] of [[0, -1, 'came'], [1, -1, 'came'], [21, -1, 'came'], [10, -10, 'no_show']]) {
```
with
```js
  // CRM_LINK_ALL_V1 (D1, R2) — давний «Не пришёл» — живая карточка: стойка возвращает её
  // в начало и закрывает «Пришёл» (прежде — «не трогается»).
  for (const [ago, date, want] of [[0, -1, 'came'], [1, -1, 'came'], [21, -1, 'came'], [10, -10, 'came']]) {
```

`server/routes/crm-unify-desk.test.js:535` — replace
```js
      assert.equal(t.lead(rid).status, (val === true || val === 'true') ? 'came' : 'in_process', JSON.stringify(val));
```
with
```js
      // CRM_LINK_ALL_V1 (D1) — без desk это запись живой карточки: «Записан» (прежде — не трогалась).
      assert.equal(t.lead(rid).status, (val === true || val === 'true') ? 'came' : 'scheduled', JSON.stringify(val));
```
and `server/routes/crm-unify-desk.test.js:538` — replace
```js
  for (const [date, want] of [[at(localDay(1), 10), 'in_process'], [at(localDay(-1), 10), 'in_process'], [TODAY, 'came'],
```
with
```js
  // CRM_LINK_ALL_V1 (D1) — завтра: запись живой карточки («Записан»); вчера: правка истории — карточку не берёт.
  for (const [date, want] of [[at(localDay(1), 10), 'scheduled'], [at(localDay(-1), 10), 'in_process'], [TODAY, 'came'],
```

`server/routes/crm-unify-final-status.test.js:150` — replace the title line with
```js
// CRM_LINK_ALL_V1 (решение владельца D1, R1) — правило изменено: давний «Не пришёл» — живая
// карточка; регистрация мастером её берёт (в начало, затем «Записан»), оплата закрывает.
test('A-P5 (CRM_LINK_ALL_V1, D1): пропущенный день давнее окна — регистрация мастером берёт давнюю «Не пришёл», оплата закрывает её «Пришёл»', async () => {
```
in its body replace
```js
    const vid = e.json.data.visit.id;
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
```
with
```js
    const vid = e.json.data.visit.id;
    assert.equal(t.lead(rid).status, 'scheduled', 'живая «Не пришёл» не взяла запись (D1)');
    const ins = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
```
and its last assertion `    assert.equal(t.lead(rid).status, 'no_show');` with `    assert.equal(t.lead(rid).status, 'came');`.

`server/routes/crm-unify-link-guards.test.js:286-288` — replace
```js
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, null]], 'строка «когда придёт» встала в чужую запись');
    assert.ok(!vsOf(t.db, vid).some((x) => x.service_id === 30), 'консультация без даты попала в смету анализа');
    assert.equal(t.lead(rid).status, 'in_process');
```
with
```js
    // CRM_LINK_ALL_V1 (D1, R1) — живая карточка держит и эту запись: анализ визита — на
    // карточке, карточка «Записан»; строка «когда придёт» по-прежнему ждёт (не в смете анализа).
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.visit_id]), [[30, null], [40, vid]], 'строка «когда придёт» встала в чужую запись или анализ не на карточке');
    assert.ok(!vsOf(t.db, vid).some((x) => x.service_id === 30), 'консультация без даты попала в смету анализа');
    assert.equal(t.lead(rid).status, 'scheduled');
```

`server/routes/crm-unify-link.test.js:78-86` — replace from the title line of «карточку, ждущую ДРУГОЙ день, сегодняшняя запись не двигает» down to and including `    assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null]);` with
```js
// CRM_LINK_ALL_V1 (решение владельца D1, R1) — правило изменено: запись на другой день — та же
// живая карточка: привязка, «Записан», дата — записанный день; строка своего дня ждёт.
test('карточку, ждущую ДРУГОЙ день, запись на день D держит (CRM_LINK_ALL_V1, D1): «Записан», строка D2 ждёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { date: D2 });
    addLine(t.db, rid, { svc: 40, day: D2 });
    const b = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, start: at(D, 9), duration_minutes: 30 });
    assert.equal(b.status, 200, b.text);
    assert.deepEqual([t.lead(rid).status, t.lead(rid).scheduled_date], ['scheduled', D]);
    assert.deepEqual(t.db.prepare('SELECT request_id, source FROM crm_booking_links WHERE visit_id = ?').get(b.json.data.visit.id), { request_id: rid, source: 'patient' });
    assert.deepEqual(linesOf(t.db, rid).map((l) => l.visit_id), [null]);
```

`server/services/crm/unify-review-t5t6.test.js:209` — replace the title line with
```js
// CRM_LINK_ALL_V1 (решение владельца D1, R2) — правило изменено: «Не пришёл» любой давности —
// живая карточка пациента; стойка возвращает её в начало и закрывает «Пришёл».
test('W1b (CRM_LINK_ALL_V1, D1): давняя карточка после прохода — приход на стойку её закрывает', () => {
```
and `  assert.equal(st(db, rid), 'no_show', 'приход сегодня закрыл карточку двухсотдневной давности');` with `  assert.equal(st(db, rid), 'came', 'живая карточка двухсотдневной давности не взяла приход (D1)');`.

`server/services/crm/unify-review-t5t6.test.js:256` — replace the title line with
```js
// CRM_LINK_ALL_V1 (D1, R1) — вторая половина изменена: запись регистратуры — так же, как колл-центра.
test('I-3 (CRM_LINK_ALL_V1, D1): «Не пришёл» за окном — запись колл-центра и запись регистратуры возвращают её в начало и записывают', () => {
```
and its last two lines
```js
  crmLinkVisit(db2, visit(db2, T), REG);
  assert.equal(st(db2, r2), 'no_show');
```
with
```js
  crmLinkVisit(db2, visit(db2, T), REG);
  assert.equal(st(db2, r2), 'scheduled');
  assert.equal(cards(db2), 1, 'регистратура завела карточку');
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-unify-desk-money.test.js server/routes/crm-unify-desk.test.js server/routes/crm-unify-final-status.test.js server/routes/crm-unify-link-guards.test.js server/routes/crm-unify-link.test.js server/services/crm/unify-review-t5t6.test.js server/routes/crm-link-all-live-card.test.js 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 0`. (The phone test `crm-unify-link.test.js:27` is changed by Task 2, not here — it still passes after Task 1.)

- [ ] **Step 7: Flip the matrix cells** — add the DECIDED mechanism to `tests/crm-doors/matrix.test.mjs` (the block, the `booked` predicate and the new loop from «How later tasks flip a GAP cell»), then put these 13 entries into `DECIDED` (cells verified on the prototype):

```js
  // Task 1 — R1 + R2 (D1)
  '2-S2-reg': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '2-S2-boss': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '2-S3-reg': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '2-S3-boss': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S3-reg': { rule: 'R2 (D1)', owner: 'moved', cell: {"stage":"came","date":"-","lines":[],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-today-S2': { rule: 'R1 (D1) + D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@D:pending/B","30@T:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-today-S2-pay': { rule: 'R1 (D1)', owner: 'came+lines', cell: {"stage":"came","date":"T","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-future-S2': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","30@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-today-S3': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-today-S3-pay': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-future-S3': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D2","lines":["30@D2:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '6-S2-doc': { rule: 'R1 (D1)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/B","c5@D2:pending/V"],"link":"card","cards":1,"visits":2,"vs":["c5"]} },
  '6-S3-doc': { rule: 'R1 (D1)', owner: 'moved', cell: {"stage":"scheduled","date":"D2","lines":["c5@D2:pending/V"],"link":"card","cards":1,"visits":1,"vs":["c5"]} },
```
(`3b-S3-reg` gets its line in Task 3; `4-today-S2` is a 23:00 slot — a booking by D2.)

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 100`, `ℹ pass 83`, `ℹ fail 0`, `ℹ todo 17` (70 observed + 13 decided cells; 13 GAP rows now real).

- [ ] **Step 8: Re-check (try to break it)**
  - `grep -n "prevOf" server/services/crm/visit-link.js` → declared once (C′), used in E and G;
  - a patient with a closed card in window AND an old open card: the open one is taken (`contactDecision` prefers live over closed) — add a throw-away assert in a scratch copy of the «две живые карточки» test if in doubt, do not commit it;
  - `git diff server/services/crm/booking-mirror.js` → empty (lesson: no mirror change in Task 1).

- [ ] **Step 9: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add server/services/crm/visit-link.js server/test-helpers/crm-link-all.js server/routes/crm-link-all-live-card.test.js tests/crm-doors/matrix.test.mjs server/routes/crm-unify-desk-money.test.js server/routes/crm-unify-desk.test.js server/routes/crm-unify-final-status.test.js server/routes/crm-unify-link-guards.test.js server/routes/crm-unify-link.test.js server/services/crm/unify-review-t5t6.test.js
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t1.txt <<'EOF'
CRM: живая карточка пациента держит любую его запись — любой день, любая роль, любая давность, и стойка тоже; давняя сначала возвращается в начало воронки (шаг C′, решение владельца D1; CRM_LINK_ALL_V1 R1, R2)

Девять прежних тестов сменили ожидание по решению D1 (C4e, стойка — другой день, давний «Не пришёл», R7 desk, A-P5, строка без даты, другой день, W1b, I-3); в матрице дверей 13 клеток GAP стали настоящими тестами.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t1.txt
```

---

## Task 2: R5 — a phone-matched card is linked and shows the visit's services

**Decision:** D4. **Gap:** G3. **Spec:** R5.

**How (decided from the code):** step D (`phoneLeadFor` — the strict single-owner phone rule) is unchanged; it still writes only `patient_id` and the stage. The one change is step F: a `'phone'` take now writes `crm_booking_links` with source `'phone'`. With the link, `requestOfVisit` finds the card, so the mirror's step 3 (`booking-mirror.js` — unchanged) writes every service of the visit onto the card (visit → card only), and the arrival rule (`crmVisitStatus`, `linked`) closes it on arrival. The card's own earlier lines are NOT put into the visit by this call: step A ran before step D, while the card still had no patient (spec: «no step A for a card that became the patient's in this same call»). Later doors see an ordinary patient card (accepted by the spec).

**Plan decision (the code settles it):** the mirror may *adopt* a pending phone-card line of the SAME service (`adoptPendingLine`, step 3) — it links the card line to the registrar's existing visit line; no visit line is added, so no money moves (I3 holds). A different service of the card stays pending outside the visit (test «её строка в визит не идёт»).

**Files:**
- Modify: `server/services/crm/visit-link.js` — header (:30-41, the «D.» paragraph), step D comment (:474-476), step F (the block written in Task 1)
- Create: `server/routes/crm-link-all-phone.test.js`
- Modify: `tests/crm-doors/matrix.test.mjs` (3 DECIDED cells)
- Modify (rule changed by D4): `server/routes/crm-unify-link.test.js:27`

**Existing tests that encode the old rule:**

| file:line — test | old rule | new expectation |
|---|---|---|
| `server/routes/crm-unify-link.test.js:27` «по телефону: лид из звонка без пациента получает пациента — и только его; строки и визит не трогаются» | no `crm_booking_links` row for a phone match | one row `{request_id: rid, source: 'phone'}`; the card's line keeps `visit_id = null`; the visit has 0 lines (calendar booking without a service) |

Unchanged and still green (they pin the money side of the phone rule): `crm-unify-desk.test.js:468` «R5: по телефону на стойке — та же граница; строки карточки по телефону в визит не идут», `crm-unify-link-guards.test.js:25/55/82/96/108/121/134` (single owner, family numbers, second number), `:502`/`:523`/`:537` (A-C1 names).

**Invariants touched:** I3 (the card's other lines stay out of the visit and the bill — tests 1 and 2 below), I8.

- [ ] **Step 1: Write the failing tests** — create `server/routes/crm-link-all-phone.test.js`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R5 (решение владельца D4, дефект G3): КАРТОЧКА ПО ТЕЛЕФОНУ
// ВИДИТ ВИЗИТ. Шаг D (visit-link.js) нашёл единственную карточку без пациента на основной
// номер записанного: теперь — и привязка записи (source 'phone'), и услуги визита строками
// карточки (визит → карточка). Её прежние строки в визит и счёт этой записью не идут
// (общий семейный номер — не общий счёт).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead, addLine, linesOf } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, calendarBook, deskRegister } from '../test-helpers/crm-link-all.js';

const D = localDay(3);

test('CRM_LINK_ALL_V1 R5: календарь регистратуры — карточка по телефону получает пациента, привязку и услугу визита; её строка в визит не идёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    addLine(t.db, rid, { svc: 40, day: D });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(t.lead(rid).patient_id, 77);
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'phone' });
    assert.deepEqual(linesOf(t.db, rid).map((l) => [l.service_id, l.status, l.visit_id]), [[40, 'pending', null], [30, 'pending', vid]],
      'карточка не показывает услугу визита или её строка взяла визит');
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30], 'строка карточки по телефону попала в визит (общий номер — не общий счёт)');
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R5: стойка — карточка по телефону закрывается «Пришёл» с привязкой; её строка на сегодня в визит и счёт не идёт', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { patient: null, phone: '+998 90 909 26 38', name: '' });
    addLine(t.db, rid, { svc: 40, day: localDay(0) });
    const { vid, ids } = await deskRegister(t, 'reg');
    assert.deepEqual(link(t, vid), { request_id: rid, source: 'phone' });
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(vsOf(t, vid).map((x) => x.service_id), [30], 'анализ карточки по телефону встал в визит');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 100000, 'в счёт попало чужое');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R5: номер у двух карт (семья) — ни пациента, ни привязки, ни строк', async () => {
  const t = await startCrmApp();
  try {
    t.db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (78, 'Мама Тест', '+998 90 909 26 38')").run();
    const rid = addLead(t.db, { patient: null, phone: '909092638', name: '909092638' });
    const vid = await calendarBook(t, 'reg', D);
    assert.equal(t.lead(rid).patient_id, null);
    assert.equal(link(t, vid), null);
    assert.deepEqual(linesOf(t.db, rid), []);
  } finally { t.close(); }
});
```

- [ ] **Step 2: Run — must fail**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-phone.test.js 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: the first two FAIL (`link(t, vid)` is `null`), «номер у двух карт» PASSES (boundary).

- [ ] **Step 3: Implement** — in `server/services/crm/visit-link.js`:

(a) header, the «D.» paragraph — replace the lines
```js
//      Второй номер записанного (phone_secondary) заявок не
//      ищет: обычно это номер родственника. Пишется ТОЛЬКО patient_id и ступень:
//      ни строк, ни visit_id, ни привязки. Но следующая дверь (ensure_visit,
//      booking_lines_add) уже видит карточку пациента и ведёт её строки в его
//      счёт — поэтому единственность номера и есть защита денег;
```
with
```js
//      Второй номер записанного (phone_secondary) заявок не
//      ищет: обычно это номер родственника. Пишется patient_id и ступень; строк
//      и visit_id этот вызов карточке не даёт. CRM_LINK_ALL_V1 (решение
//      владельца D4, R5) — и привязка записи (F, source 'phone'): по ней
//      зеркало пишет услуги ВИЗИТА в карточку (визит → карточка). Следующая
//      дверь (ensure_visit, booking_lines_add) уже видит карточку пациента и
//      ведёт её строки в его счёт — поэтому единственность номера и есть защита денег;
```
and the line `//   F. привязка записи (crm_booking_links) — для C и E, не для телефона;` with
```js
//   F. привязка записи (crm_booking_links) — для C, C′, E и (CRM_LINK_ALL_V1, R5) телефона;
```

(b) step D comment — after the three lines `  // D. По телефону — одна заявка, только patient_id (на стойке — тем же` … `  //    здесь, ни на стойке: правило денег (общий номер — не общий счёт).` add
```js
  //    CRM_LINK_ALL_V1 (R5; решение D4) — но ВИЗИТ карточка видит: привязка
  //    записи (шаг F, source 'phone'), и зеркало пишет услуги визита в
  //    карточку (визит → карточка). Её прежние строки в визит не идут: шаг A
  //    этого вызова прошёл до того, как карточка стала карточкой пациента.
```

(c) step F — replace the block from Task 1 with
```js
  // F. Привязка записи — для C, C′, D и E (A держит визит строками).
  //    CRM_LINK_ALL_V1 — и C′ (source 'patient'), и телефон D (source 'phone', R5).
  if (!held) {
    const pick = [...touched].find(([, via]) => ['patient', 'live', 'phone', 'callcenter', 'created'].includes(via));
    if (pick) {
      const source = pick[1] === 'phone' ? 'phone' : callcenter ? 'callcenter' : pick[1] === 'live' ? 'patient' : 'match';   // CRM_LINK_ALL_V1
      db.prepare(`INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source, created_by, created_request)
                  VALUES (?, ?, ?, ?, ?)`)
        .run(v.id, pick[0], source, uid, pick[1] === 'created' ? 1 : 0);
    }
  }
```

- [ ] **Step 4: Run the new tests — must pass**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-phone.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 3`, `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 5: Update the existing test (D4)** — `server/routes/crm-unify-link.test.js:27`: replace the title line with
```js
// CRM_LINK_ALL_V1 (решение владельца D4, R5) — правило изменено: карточка по телефону ещё и
// привязана к записи (source 'phone') — её видно в записи; её строки и счёт не трогаются.
test('по телефону (CRM_LINK_ALL_V1, D4): лид из звонка без пациента получает пациента и привязку записи; его строки и счёт не трогаются', async () => {
```
and its last assertion
```js
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM crm_booking_links WHERE visit_id = ?').get(vid).n, 0);
```
with
```js
    assert.deepEqual(t.db.prepare('SELECT request_id, source FROM crm_booking_links WHERE visit_id = ?').get(vid), { request_id: rid, source: 'phone' });
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-unify-link.test.js server/routes/crm-unify-link-guards.test.js server/routes/crm-unify-desk.test.js server/routes/crm-unify-desk-money.test.js server/services/crm/new-patient-link.test.js server/routes/crm-link-all-phone.test.js server/routes/crm-link-all-live-card.test.js 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: Flip the matrix cells** — add to `DECIDED` in `tests/crm-doors/matrix.test.mjs`:

```js
  // Task 2 — R5 (D4)
  '2-S1p-reg': { rule: 'R5 (D4)', owner: 'lines', cell: {"stage":"scheduled","date":"D","lines":["30@D:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-today-S1p': { rule: 'R5 (D4) + D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S1p-reg': { rule: 'R5 (D4)', owner: 'moved', cell: {"stage":"came","date":"-","lines":[],"link":"card","cards":1,"visits":1,"vs":[30]} },
```
(`3b-S1p-reg` gets its done line in Task 3, which also raises its owner predicate to `lines`.)

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 100`, `ℹ pass 86`, `ℹ fail 0`, `ℹ todo 14`.

- [ ] **Step 7: Re-check (try to break it)** — a family number must still link nothing: run `crm-unify-link-guards.test.js` alone and read the names of the passing phone tests (`--test-name-pattern="телефону"`); `git diff server/services/crm/booking-mirror.js` → empty.

- [ ] **Step 8: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add server/services/crm/visit-link.js server/routes/crm-link-all-phone.test.js server/routes/crm-unify-link.test.js tests/crm-doors/matrix.test.mjs
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t2.txt <<'EOF'
CRM: карточка, найденная по телефону, привязана к записи и показывает услуги визита; её прежние строки в визит и счёт не идут (решение владельца D4; CRM_LINK_ALL_V1 R5)

Тест «по телефону: лид из звонка без пациента…» сменил ожидание по решению D4 (привязка source 'phone'); в матрице дверей ещё 3 клетки стали настоящими тестами.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t2.txt
```

---

## Task 3: R6 — services added to a desk-closed visit appear on its «Пришёл» card

**Decision:** none needed (defect G4). **Spec:** R6.

**How (decided from the code):** the mirror deliberately never writes a closed card (`booking-mirror.js` step 3, :429-432 and :451) — and the lesson forbids touching it. So R6 is a new, separate function in `visit-link.js`, **`crmWonCardLines(db, visitId)`**: for the card that HOLDS this visit (`requestOfVisit` — by its lines, else by `crm_booking_links`; one card, never another), only when that card is in the won column (`wonStageKey`) and the visit is of today's local day, own building, not cancelled/no-show: every visit line that is a service (`lineKey`), not a clinic item, not from another building, and not yet referenced by any card line gets a card line `status 'done'`, `visit_id`, `visit_service_id`, `visit_service_auto = 0`, `scheduled_date` = the visit day. Nothing is written to `visit_services` or invoices (I1, I4); the card stays «Пришёл» (I2); 'done' only for a service that is in the visit (the existing invariant).

Callers (each after the mirror, so a line the mirror just linked or replaced is skipped as «referenced»):
1. `deskArrive` (end) — lines already in the visit when the desk registers (an existing day visit);
2. the `/api/db` door — `booking-mirror-db.js` `mirrorAfter`, `visit_services` branch, after its `mirrorVisit` loop (fast registration, wizard «now», doctor/visit window inserts);
3. `cashier_line_add` — `billing.js` after `mirrorCashierLine` (`mirrorCashierLine` skips a closed card too).

**Plan decisions (the code settles them):**
- «Only today's visit»: the desk, the wizard «now» and the cashier act on today's visit; editing a visit of an earlier day must not rewrite an old «Пришёл» card (test «ПРОШЛОГО дня»).
- A line removed from the visit later leaves its 'done' card line in place — the same as today's 'done' lines of step A; not in scope of R6.
- Until Task 6 lands, the G7 twin (call-centre calendar booking + desk line of the same service) shows twice on the card as well (R6 faithfully mirrors the visit's two lines). The matrix pins that intermediate cell with `owner: null` (GAP stays todo) and Task 6 replaces it.

**Files:**
- Modify: `server/services/crm/visit-link.js` — import `lineKey` (:115); header paragraph «РЕГИСТРАЦИЯ НА СТОЙКЕ» (:64-98); `crmWonCardLines` after `deskArrive` (:388-407) and its call at the end of `deskArrive`
- Modify: `server/services/crm/booking-mirror-db.js:24` (import) and `:203` (call)
- Modify: `server/services/rpc/billing.js:11` (import) and `:1689` (call)
- Create: `server/routes/crm-link-all-desk-lines.test.js`
- Modify: `tests/crm-doors/matrix.test.mjs` (DECIDED: 7 new, 2 raised, 1 intermediate)

**Existing tests that encode the old rule:** none — the prototype run of all 269 door test files found no test asserting that a desk-closed card stays without lines.

**Invariants touched:** I1, I2 (only the won card that holds THIS visit; «Отказ» and an old «Пришёл» untouched — test 3), I4 (no visit line or invoice touched — test 1 compares the ids and the bill), I5 (`sync_origin` visits and lines skipped), I7 (try/catch, returns 0).

- [ ] **Step 1: Write the failing tests** — create `server/routes/crm-link-all-desk-lines.test.js`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R6 (дефект G4): УСЛУГИ ВИЗИТА, ЗАКРЫВШЕГО КАРТОЧКУ НА СТОЙКЕ,
// — НА КАРТОЧКЕ. Быстрая регистрация закрывает карточку в «Пришёл» раньше, чем в визите
// появляются строки; теперь каждая строка-услуга этого визита (вставленная стойкой,
// мастером «сейчас» или кассой) — строка карточки 'done' с visit_service_id. Только карточка,
// держащая этот визит; карточка остаётся «Пришёл»; деньги не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, daysAgoIso, addLead } from '../test-helpers/crm-unify-app.js';
import { link, vsOf, cardLines, addVisitLine, deskRegister } from '../test-helpers/crm-link-all.js';

const TODAY = localDay(0);

test('CRM_LINK_ALL_V1 R6: быстрая регистрация звонившего — «Пришёл», и обе услуги визита на карточке строками done', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg', { items: [{ svc: 30, doctor: 10 }, { svc: 40 }] });
    assert.equal(t.lead(rid).status, 'came');
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.scheduled_date, l.status, l.visit_id, l.visit_service_id, l.visit_service_auto]),
      [[30, TODAY, 'done', vid, ids[0], 0], [40, TODAY, 'done', vid, ids[1], 0]]);
    assert.deepEqual(vsOf(t, vid).map((x) => x.id), ids, 'строки визита изменились (R6 — только визит → карточка)');
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 140000);
    assert.equal(cardLines(t, rid).length, 2, 'счёт завёл на карточке лишние строки');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6: касса добавляет услугу к счёту визита стойки — и она на карточке «Пришёл»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const { vid, ids } = await deskRegister(t, 'reg');
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const add = await t.rpc('cashier_line_add', 'boss', { invoice_id: inv.json.data.invoice.id, service_id: 40, doctor_id: null });
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.status]), [[30, 'done'], [40, 'done']]);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6: только карточка, держащая визит, — «Пришёл» прошлого визита и «Отказ» не трогаются', async () => {
  const t = await startCrmApp();
  try {
    const past = addLead(t.db, { status: 'came', updated: daysAgoIso(9) });
    const refused = addLead(t.db, { status: 'stopped' });
    const fresh = addLead(t.db, {});
    const { vid } = await deskRegister(t, 'reg');
    assert.equal(link(t, vid).request_id, fresh);
    assert.deepEqual(cardLines(t, fresh).map((l) => l.service_id), [30]);
    assert.deepEqual(cardLines(t, past), [], 'карточке прошлого прихода приписана сегодняшняя услуга');
    assert.deepEqual(cardLines(t, refused), [], '«Отказу» приписана услуга');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R6: услуга, добавленная к визиту ПРОШЛОГО дня, на карточку «Пришёл» не пишется', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'came' });
    const y = localDay(-1);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(at(y, 10)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    await addVisitLine(t, 'reg', vid, { svc: 40, doctor: null });
    assert.deepEqual(cardLines(t, rid), []);
  } finally { t.close(); }
});
```

- [ ] **Step 2: Run — must fail**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-desk-lines.test.js 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: the first three FAIL (the card has no lines), «ПРОШЛОГО дня» PASSES (boundary). Verified at HEAD.

- [ ] **Step 3: Implement `crmWonCardLines`** — in `server/services/crm/visit-link.js`:

(a) line 115 — replace the import with
```js
import { visitRow, requestOfVisit, isCallcenterUser, PRE_ARRIVAL, cardDateOf, mirrorVisit, lineKey } from './booking-mirror.js';   // CRM_LINK_ALL_V1 — lineKey (crmWonCardLines)
```

(b) end of `deskArrive` (:404-409) — replace
```js
      } catch { /* сборка без 186 — возвращать будет нечего */ }
    }
  })();
}

/** @returns {boolean} взял ли визит хоть одну строку (шаг A) */
```
with
```js
      } catch { /* сборка без 186 — возвращать будет нечего */ }
    }
  })();
  crmWonCardLines(db, v.id);   // CRM_LINK_ALL_V1 (R6) — услуги, уже лежащие в визите, — на карточку
}

/**
 * CRM_LINK_ALL_V1 (R6, дефект G4) — УСЛУГИ ВИЗИТА, ЗАКРЫВШЕГО КАРТОЧКУ, — НА
 * КАРТОЧКЕ. Стойка (быстрая регистрация, мастер «сейчас») закрывает карточку
 * в «Пришёл» раньше, чем в визите появляются строки; зеркало закрытую карточку
 * не пишет (booking-mirror.js шаг 3), и карточка оставалась пустой. Здесь —
 * только карточка, которая ДЕРЖИТ этот визит (requestOfVisit: строкой или
 * привязкой), только в конверсии (wonStageKey) и только визит сегодняшнего
 * местного дня своего здания: каждая строка визита-услуги, на которую не
 * ссылается ни одна строка заявки, получает строку карточки 'done' с
 * visit_service_id (инвариант: 'done' — только услуга, которая в визите).
 * Карточка остаётся «Пришёл»; другие карточки не трогаются никогда; деньги не
 * меняются (визит → карточка). Зовут: стойка (deskArrive), дверь /api/db после
 * сверки (booking-mirror-db.js), касса (cashier_line_add). Не бросает.
 * @returns {number} сколько строк карточки заведено
 */
export function crmWonCardLines(db, visitId) {
  try {
    const v = visitRow(db, visitId);
    if (!v || v.sync_origin != null || !v.patient_id || v.day !== today(db)) return 0;
    if (!PRE_ARRIVAL.includes(v.status) && !ARRIVED_STATUSES.includes(v.status)) return 0;
    const rid = requestOfVisit(db, v.id);
    if (!rid) return 0;
    const card = db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid);
    if (!card || card.status !== wonStageKey(db)) return 0;
    const held = db.prepare('SELECT 1 FROM crm_request_services WHERE visit_service_id = ? LIMIT 1');
    const add = db.prepare(`INSERT INTO crm_request_services
                              (request_id, service_id, consultation_type_id, scheduled_date, status, doctor_id, visit_id, visit_service_id, visit_service_auto)
                            VALUES (?, ?, ?, ?, 'done', ?, ?, ?, 0)`);
    return db.transaction(() => {
      let n = 0;
      for (const x of db.prepare(`SELECT * FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'
                                     AND clinic_item_id IS NULL AND sync_origin IS NULL ORDER BY id`).all(v.id)) {
        if (!lineKey(x) || held.get(x.id)) continue;
        add.run(rid, x.service_id ?? null, x.service_id != null ? null : x.consultation_type_id, v.day, x.doctor_id || null, v.id, x.id);
        n++;
      }
      return n;
    })();
  } catch (e) {
    console.error('[crm-link] услуги визита', visitId, 'не показаны на карточке:', e && e.message);   // CRM_LINK_ALL_V1
    return 0;
  }
}

/** @returns {boolean} взял ли визит хоть одну строку (шаг A) */
```

(c) header — in the «РЕГИСТРАЦИЯ НА СТОЙКЕ» paragraph, after the line `//   при первом счёте — при любом статусе строки заявки).` add
```js
//   CRM_LINK_ALL_V1 (R6, дефект G4) — карточка «Пришёл», которую закрыла
//   стойка, видит услуги ЭТОГО визита: crmWonCardLines пишет каждую строку
//   визита строкой карточки 'done' (визит → карточка; деньги не меняются) — в
//   конце deskArrive, после сверки двери /api/db и после cashier_line_add.
```

- [ ] **Step 4: Call it from the `/api/db` door and the cashier**

`server/services/crm/booking-mirror-db.js:24` — after `import { canEditCrm } from './visibility.js';` add
```js
import { crmWonCardLines } from './visit-link.js';   // CRM_LINK_ALL_V1 (R6)
```
and at `:203` replace
```js
      for (const v of ctx.visits) mirrorVisit(db, v, { actorId });
      return;
    }

    if (meta.table === 'crm_request_services') {
```
with
```js
      for (const v of ctx.visits) mirrorVisit(db, v, { actorId });
      // CRM_LINK_ALL_V1 (R6) — визит, закрывший карточку на стойке: его услуги — на карточке.
      for (const v of ctx.visits) crmWonCardLines(db, v);
      return;
    }

    if (meta.table === 'crm_request_services') {
```

`server/services/rpc/billing.js:11` — after the `../crm/booking-mirror.js` import line add
```js
import { crmWonCardLines } from '../crm/visit-link.js';   // CRM_LINK_ALL_V1 (R6)
```
and after `:1689` (`    mirrorCashierLine(db, out.line.id);                       // ревью — строка в счёте тоже доходит до заявки`) add
```js
    crmWonCardLines(db, visitId);                             // CRM_LINK_ALL_V1 (R6) — и до карточки «Пришёл» этого визита
```
(No import cycle: `visit-link.js` imports `booking-mirror.js`, `visit-status.js`, `contact-window.js`, `config.js`, `tasks-follow.js`, `roles.js`, `domain/day.js`, `crm-phone-match.js` — none of them imports `billing.js` or `booking-mirror-db.js`; the prototype app loaded and ran with these imports.)

- [ ] **Step 5: Run the new tests — must pass**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-desk-lines.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`.

Then the neighbours that exercise the desk, the mirror and the cashier:
Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-unify-desk.test.js server/routes/crm-unify-desk-money.test.js server/routes/crm-calendar-mirror.test.js server/routes/crm-lines-v3120-final.test.js server/routes/crm-unify-final-status.test.js server/services/crm/booking-mirror-twin.test.js server/services/rpc/billing.test.js server/routes/crm-link-all-live-card.test.js server/routes/crm-link-all-phone.test.js 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail|todo)"`
Expected: `ℹ fail 0` (the twin file keeps its 6 todos).

- [ ] **Step 6: Flip the matrix cells** — add to `DECIDED`, and REPLACE the Task 1/2 entries of `3b-S3-reg` and `3b-S1p-reg` by the ones below:

```js
  // Task 3 — R6 (G4)
  '3b-S1-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S1-boss': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S2-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"D","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '3a-S1p-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3a-S3p-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3c-S2-reg': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"D","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '7-fast-S2T-other': { rule: 'R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"T","lines":["30@T:done/V","40@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30,40]} },
  '3b-S3-reg': { rule: 'R2 (D1) + R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '3b-S1p-reg': { rule: 'R5 (D4) + R6 (G4)', owner: 'lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  // intermediate until Task 6 (R7b): the G7 twin is in the visit twice, so R6 shows it twice on the card too — its GAP stays todo
  '7-fast-S2Tcal-same': { rule: 'R6 (G4), before R7b', owner: null, cell: {"stage":"came","date":"T","lines":["30@T:done/V","30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30,30]} },
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 100`, `ℹ pass 93`, `ℹ fail 0`, `ℹ todo 7`.

- [ ] **Step 7: Re-check (try to break it)**
  - money: the R6 tests assert the visit line ids and the invoice total unchanged — re-read that they compare ids, not counts;
  - the mirror twin file still has exactly 6 todos and no failures (`booking-mirror-twin.test.js`);
  - `git diff server/services/crm/booking-mirror.js` → empty.

- [ ] **Step 8: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add server/services/crm/visit-link.js server/services/crm/booking-mirror-db.js server/services/rpc/billing.js server/routes/crm-link-all-desk-lines.test.js tests/crm-doors/matrix.test.mjs
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t3.txt <<'EOF'
CRM: карточка «Пришёл», закрытая стойкой, показывает услуги своего визита — строки done со ссылкой на строку визита; деньги не меняются (дефект G4; CRM_LINK_ALL_V1 R6)

Новая crmWonCardLines (visit-link.js) — в конце стойки, после сверки двери /api/db и после cashier_line_add; зеркало записи не менялось. В матрице дверей ещё 7 клеток стали настоящими тестами.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t3.txt
```

---

## Task 4: R4 — calendar «Подтверждён» moves the card forward

**Decision:** D3. **Gap:** G6. **Spec:** R4.

**How (decided from the code):** `crmVisitStatus` (`visit-status.js`) is the only place a visit status reaches the cards, and `calendar_book` (`rpc/calendar.js:1251`) calls it for every status change of a visit (VISITS_ONE_DOOR_V1). Today it returns early for 'confirmed' (:238). New branch for `to === 'confirmed'`: the cards that hold the visit — by their lines (`parents`) and by `crm_booking_links` (`linked`, now also loaded for 'confirmed') — move to the **«Колонка подтверждения»**: the first ACTIVE open column after the booked column (`scheduledStageKey`) and before the won column. The column rule is a pure function next to the booked-column rule (`public/js/shared/crm-booked-stage.js` `confirmedStageKeyOf`) and a server wrapper (`config.js` `confirmedStageKey`; empty/unreadable stage table → the seed `'approved'`, as `scheduledStageKey` falls back to `'scheduled'`). Only cards in the booked column or an open column before it move; never from a column after it, never from won/lost or the seeded «Не пришёл». The write uses the `quiet` statement: `updated_at` does not move (a calendar mark is a server move, I-5) and the date is kept. A visit of another building (`sync_origin`) moves nothing (I5).

**Plan decisions (the code settles them):**
- A brand-new visit created directly as 'confirmed' is not moved: in `calendar_book` `crmVisitStatus` runs before `crmLinkVisit` (:1251 vs :1261), so no card holds it yet; `crmLinkVisit`'s G then puts the card in the booked column. The human «Подтверждён» is a mark on an existing booking (room-calendar.js:1014, visit-booking.js:69) — that path is covered.
- Cancel of a confirmed booking keeps today's A-I4 rule (the card stays in «Подтверждён», its date is cleared — `crm-unify-final-status.test.js:61` «P3 (A-I4)…» stays green). The prototype tried a «back to the first column» variant; it broke that reviewed rule and was dropped — do NOT extend the cancel undo.

**Files:**
- Modify: `public/js/shared/crm-booked-stage.js` — `confirmedStageKeyOf` after `bookedStageKey` (:47-52)
- Modify: `server/services/crm/config.js` — import (:16); `SEED_CONFIRMED_STAGE`, `confirmedStageKey` after `scheduledStageKey` (:257-262)
- Modify: `server/services/crm/visit-status.js` — import (:34); doc comment (:217); early return (:238); `linked` load (:273); new branch before `if (now === 'no_show') {` (:336)
- Create: `server/routes/crm-link-all-confirmed.test.js`
- Modify (rule changed by D3): `server/services/crm/visit-status.test.js:313`
- Modify: `tests/crm-doors/matrix.test.mjs` (1 cell)

**Existing tests that encode the old rule:**

| file:line — test | old rule | new expectation |
|---|---|---|
| `server/services/crm/visit-status.test.js:313` «подтверждение и перенос заявку не трогают: конверсия — это приход» | 'confirmed' leaves the card in «Записан» | card `'approved'`; its line stays `'pending'` (confirmation is still not an arrival) |

**Invariants touched:** I1 (only the stage; lines untouched — the existing assertion `line(db, lid).status === 'pending'` stays), I2 (won/lost/«Не пришёл» never move — test 3), I5 (test 5).

- [ ] **Step 1: Write the failing tests** — create `server/routes/crm-link-all-confirmed.test.js`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R4 (решение владельца D3, дефект G6): «ПОДТВЕРЖДЁН» В
// КАЛЕНДАРЕ ДВИГАЕТ КАРТОЧКУ ВПЕРЁД — в «Колонку подтверждения» (первая видимая открытая
// после «Колонки записи» и до «Пришёл»). Только вперёд, только из «Колонки записи» и колонок
// до неё; updated_at и дата не меняются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, at, addLead, addLine } from '../test-helpers/crm-unify-app.js';
import { callcenterBook } from '../test-helpers/crm-link-all.js';
import { confirmedStageKeyOf } from '../../public/js/shared/crm-booked-stage.js';
import { crmVisitStatus } from '../services/crm/visit-status.js';

const D = localDay(3);
const SEED = [
  { key: 'in_process', position: 1, is_active: 1, kind: 'open' },
  { key: 'recall', position: 2, is_active: 1, kind: 'open' },
  { key: 'scheduled', position: 3, is_active: 1, kind: 'open' },
  { key: 'approved', position: 4, is_active: 1, kind: 'open' },
  { key: 'came', position: 5, is_active: 1, kind: 'won' },
  { key: 'no_show', position: 6, is_active: 1, kind: 'lost' },
];
const mark = (t, vid, status) => {
  const v = t.db.prepare('SELECT visit_date FROM visits WHERE id = ?').get(vid);
  return t.rpc('calendar_book', 'reg', { visit_id: vid, start: v.visit_date, status });
};

test('CRM_LINK_ALL_V1 R4: confirmedStageKeyOf — первая видимая открытая после колонки записи и до «Пришёл»', () => {
  assert.equal(confirmedStageKeyOf(SEED, 'scheduled'), 'approved');
  assert.equal(confirmedStageKeyOf(SEED.map((s) => (s.key === 'approved' ? { ...s, is_active: 0 } : s)), 'scheduled'), null, 'скрытая колонка не цель');
  assert.equal(confirmedStageKeyOf(SEED.map((s) => (s.key === 'approved' ? { ...s, position: 9 } : s)), 'scheduled'), null, 'колонка после «Пришёл» не цель');
  assert.equal(confirmedStageKeyOf(SEED, 'approved'), null, 'после колонки записи ничего нет');
  assert.equal(confirmedStageKeyOf(SEED, null), null);
  assert.equal(confirmedStageKeyOf([...SEED, { key: 'agreed', position: 3.5, is_active: 1, kind: 'open' }], 'scheduled'), 'agreed');
});

test('CRM_LINK_ALL_V1 R4: «Подтверждён» на записи колл-центра — карточка в «Подтверждён»; дата и updated_at прежние', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const vid = await callcenterBook(t, D);
    const before = t.lead(rid);
    assert.equal(before.status, 'scheduled');
    const r = await mark(t, vid, 'confirmed');
    assert.equal(r.status, 200, r.text);
    const c = t.lead(rid);
    assert.equal(c.status, 'approved');
    assert.equal(c.scheduled_date, before.scheduled_date);
    assert.equal(c.updated_at, before.updated_at, 'отметка календаря — не контакт (I-5)');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R4: только вперёд — «Пришёл», «Не пришёл» и колонка после записи не двигаются; карточка до записи — двигается', async () => {
  const t = await startCrmApp();
  try {
    const came = addLead(t.db, { status: 'came' });
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (77, 10, ?, 'scheduled', 2)").run(at(D, 9)).lastInsertRowid);
    addLine(t.db, came, { svc: 30, day: D, visit: vid });
    const recall = addLead(t.db, { status: 'recall' });
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, recall);
    const r = await mark(t, vid, 'confirmed');
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(came).status, 'came');
    assert.equal(t.lead(recall).status, 'approved', 'карточка до колонки записи не подтвердилась');
    t.db.prepare("UPDATE crm_requests SET status = 'no_show' WHERE id = ?").run(recall);
    await mark(t, vid, 'scheduled');
    await mark(t, vid, 'confirmed');
    assert.equal(t.lead(recall).status, 'no_show', '«Не пришёл» поднята отметкой «Подтверждён»');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R4: подтверждённую запись отменили — карточка остаётся «Подтверждён», дата стёрта (правило A-I4 не меняется)', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { assigned: 3 });
    const vid = await callcenterBook(t, D);
    await mark(t, vid, 'confirmed');
    assert.equal(t.lead(rid).status, 'approved');
    const r = await mark(t, vid, 'cancelled');
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'approved');
    assert.equal(t.lead(rid).scheduled_date, null, 'дата отменённого приёма осталась — наутро проход унёс бы карточку в «Не пришёл»');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R4: визит соседнего здания — «Подтверждён» карточку не двигает', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, { status: 'scheduled' });
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, sync_origin) VALUES (77, 10, ?, 'confirmed', 'B')").run(at(D, 9)).lastInsertRowid);
    t.db.prepare("INSERT INTO crm_booking_links (visit_id, request_id, source) VALUES (?, ?, 'match')").run(vid, rid);
    crmVisitStatus(t.db, { visitId: vid, from: 'scheduled', to: 'confirmed' });
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});
```

- [ ] **Step 2: Run — must fail**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-confirmed.test.js 2>&1 | grep -E "^(✔|✖)|SyntaxError|^ℹ (pass|fail)"`
Expected: the file FAILS to load — `SyntaxError: The requested module '../../public/js/shared/crm-booked-stage.js' does not provide an export named 'confirmedStageKeyOf'` (verified at HEAD).

- [ ] **Step 3: The column rule** — `public/js/shared/crm-booked-stage.js`, after `bookedStageKey` (:47-52) insert:

```js

/**
 * CRM_LINK_ALL_V1 (R4; решение владельца D3) — «КОЛОНКА ПОДТВЕРЖДЕНИЯ»: первая
 * ВИДИМАЯ открытая колонка ПОСЛЕ «Колонки записи» и ДО конверсии (у клиник —
 * сидовая «Подтверждён»). null — такой нет: отметка «Подтверждён» в календаре
 * карточку тогда не двигает.
 */
export function confirmedStageKeyOf(stages, bookedKey) {
  const list = ordered(stages);
  const wonAt = list.findIndex((s) => s.kind === 'won');
  const before = wonAt >= 0 ? list.slice(0, wonAt) : list;
  const at = bookedKey ? before.findIndex((s) => s.key === bookedKey) : -1;
  if (at < 0) return null;
  const next = before.slice(at + 1).find((s) => s.kind === 'open' && isActive(s));
  return next ? next.key : null;
}
```

`server/services/crm/config.js:16` — replace the import with
```js
import { bookedStageKey, bookedStageCandidates, conversionRefusal, confirmedStageKeyOf } from '../../../public/js/shared/crm-booked-stage.js';   // CRM_LINK_ALL_V1 — confirmedStageKeyOf
```
and after `scheduledStageKey` (:257-262) insert
```js

/** CRM_LINK_ALL_V1 (R4) — сидовая «Подтверждён» (миграция 077). */
export const SEED_CONFIRMED_STAGE = 'approved';

/**
 * CRM_LINK_ALL_V1 (R4; решение владельца D3) — «КОЛОНКА ПОДТВЕРЖДЕНИЯ»: одно
 * правило с экраном (public/js/shared/crm-booked-stage.js confirmedStageKeyOf) —
 * первая видимая открытая колонка после «Колонки записи» и до «Пришёл».
 * Пустой или нечитаемый справочник — сидовая «Подтверждён» (как scheduledStageKey).
 * null — некуда: отметка «Подтверждён» карточку не двигает.
 */
export function confirmedStageKey(db) {
  let stages = [];
  try { stages = listStages(db); } catch (e) { stages = []; }
  if (!stages.length) return SEED_CONFIRMED_STAGE;
  return confirmedStageKeyOf(stages, scheduledStageKey(db));
}
```

- [ ] **Step 4: The 'confirmed' branch** — `server/services/crm/visit-status.js`:

(a) :34 — replace the import with
```js
import { openStageKeys, wonStageKey, noShowStageKey, scheduledStageKey, windowHours, SEED_NO_SHOW_STAGE, confirmedStageKey } from './config.js';   // CRM_UNIFY_V1 — windowHours · CRM_LINK_ALL_V1 — confirmedStageKey
```
(b) :217 — replace ` * Всё остальное ('scheduled', 'confirmed' и возврат назад) заявку не трогает.` with
```js
 *   confirmed  — CRM_LINK_ALL_V1 (решение владельца D3, R4): карточка, которая
 *                держит визит, едет ВПЕРЁД в «Колонку подтверждения» (config.js
 *                confirmedStageKey) — только из «Колонки записи» и колонок до неё.
 *                Приходом это не является: строки ждут.
 *
 * Всё остальное ('scheduled' и возврат назад) заявку не трогает.
```
(c) :238 — replace
```js
    if (!ARRIVED_STATUSES.includes(now) && now !== 'no_show' && now !== 'cancelled') return;
```
with
```js
    // CRM_LINK_ALL_V1 (R4) — и 'confirmed': «Подтверждён» в календаре двигает карточку вперёд.
    if (!ARRIVED_STATUSES.includes(now) && now !== 'no_show' && now !== 'cancelled' && now !== 'confirmed') return;
```
(d) :273 — replace
```js
    if (ARRIVED_STATUSES.includes(now) || now === 'no_show' || now === 'cancelled') {
```
with
```js
    if (ARRIVED_STATUSES.includes(now) || now === 'no_show' || now === 'cancelled' || now === 'confirmed') {   // CRM_LINK_ALL_V1 — и подтверждение
```
(e) right before `    if (now === 'no_show') {` (:336) insert
```js
    // CRM_LINK_ALL_V1 (R4; решение владельца D3) — «ПОДТВЕРЖДЁН» В КАЛЕНДАРЕ
    // ДВИГАЕТ КАРТОЧКУ ВПЕРЁД, в «Колонку подтверждения» (config.js
    // confirmedStageKey): карточки, чьи строки держат визит, и привязанные к нему
    // записью. Только из «Колонки записи» и открытых колонок до неё; из колонки
    // после неё, из «Пришёл» и проигрышных — никогда. Дата не меняется.
    // updated_at не двигается (переход по отметке календаря, I-5). Визит
    // соседнего здания — не наш (I5).
    if (now === 'confirmed') {
      if (visit.sync_origin != null) return;
      const confirmed = confirmedStageKey(db);
      const confAt = confirmed ? open.indexOf(confirmed) : -1;
      const bookedAt = scheduled ? open.indexOf(scheduled) : -1;
      if (confAt < 0 || bookedAt < 0) return;
      for (const p of withLinked()) {
        const at = open.indexOf(p.status);
        if (at < 0 || at > bookedAt || at >= confAt) continue;
        writeParent(quiet, p, confirmed, p.scheduled_date);
      }
      return;
    }

```
(`open`, `scheduled`, `quiet`, `withLinked` are already defined above in the same function; the early `if (!parents.length && !linked.length && !ARRIVED_STATUSES.includes(now)) return;` covers a visit no card holds.)

- [ ] **Step 5: Run the new tests — must pass**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-confirmed.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`.

- [ ] **Step 6: Update the existing test (D3)** — `server/services/crm/visit-status.test.js:313`: replace the title line with
```js
// CRM_LINK_ALL_V1 (решение владельца D3, R4) — правило изменено: «Подтверждён» двигает карточку
// вперёд в «Подтверждён»; приходом оно по-прежнему не является — строка ждёт.
test('подтверждение (CRM_LINK_ALL_V1, D3): карточка — в «Подтверждён», но это не приход: строка ждёт', () => {
```
and
```js
  assert.equal(reqRow(db, rid).status, 'scheduled',
    '«подтверждён по телефону» объявлено приходом: человек всё ещё дома');
```
with
```js
  assert.equal(reqRow(db, rid).status, 'approved', '«Подтверждён» в календаре не дошёл до карточки (D3)');
```
(the following `assert.equal(line(db, lid).status, 'pending');` stays — confirmation is not an arrival).

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/services/crm/visit-status.test.js server/services/crm/visit-status.local-day.test.js server/services/crm/config.test.js server/services/rpc/crm-config.test.js server/routes/crm-unify-final-status.test.js server/services/crm/no-show.test.js server/routes/crm-link-all-confirmed.test.js public/js/admin/__tests__/crm-settings-logic.test.mjs 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 0`. (If `crm-settings-logic.test.mjs` does not exist, drop it: `ls public/js/admin/__tests__ | grep -i crm-settings`.)

- [ ] **Step 7: Flip the matrix cell** — add to `DECIDED`:

```js
  // Task 4 — R4 (D3)
  '8-S2-confirmed': { rule: 'R4 (D3)', owner: 'approved', cell: {"stage":"approved","date":"D","lines":["30@D:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 100`, `ℹ pass 94`, `ℹ fail 0`, `ℹ todo 6`.

- [ ] **Step 8: Re-check (try to break it)** — a card already in «Подтверждён» whose visit is confirmed again stays (`at >= confAt`); a clinic that hid «Подтверждён» → `confirmedStageKey` null → nothing moves (pure test 1, case 2); `node -e "import('./public/js/shared/crm-booked-stage.js').then(m=>console.log(typeof m.confirmedStageKeyOf))"` → `function` (the board imports this module too: no DOM/DB in it).

- [ ] **Step 9: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add public/js/shared/crm-booked-stage.js server/services/crm/config.js server/services/crm/visit-status.js server/routes/crm-link-all-confirmed.test.js server/services/crm/visit-status.test.js tests/crm-doors/matrix.test.mjs
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t4.txt <<'EOF'
CRM: «Подтверждён» в календаре двигает карточку вперёд в «Колонку подтверждения» — только из «Записан» и колонок до неё, без движения updated_at (решение владельца D3; CRM_LINK_ALL_V1 R4)

Тест «подтверждение и перенос заявку не трогают» сменил ожидание по решению D3; отмена подтверждённой записи — по-прежнему правило A-I4. В матрице дверей клетка 8-S2-confirmed стала настоящим тестом.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t4.txt
```

---

## Task 5: R3 — the wizard's «now» registration is a desk arrival (client + server guard)

**Decision:** D2. **Gap:** G5. **Spec:** R3.

**How (decided from the code):** «now vs a later slot» is settled by what the wizard already computes per day in `createVisit` (`visit-wizard.js` :2648-2695): `timedHead = headTimedLine(lines)` is `null` exactly in the wizard's live-queue / no-slot mode (no doctor line with a time: services «на дату» (`dateOnly`), live-queue doctors); otherwise `timedHead.when` is the slot start. One pure rule, **`isDeskNow({ dayIso, todayIso, headStartMs, nowMs })`** in a new `public/js/admin/views/wizard-desk.js`: the day is today AND (no slot, OR the slot starts no later than `DESK_NOW_MINUTES = 30` minutes from now — a slot already begun counts). The wizard adds `desk: true` to `ensure_visit` when it holds. A later slot today stays a booking.

Server side, `ensure_visit` today drops `desk` whenever `book` is present (:282-292 vs :332/:404). R3 keeps `deskArrival` (registrar/admin, today's local day) unchanged and adds one guard in `ensure_visit`: with `book`, `desk` counts only if `book.startMs <= Date.now() + DESK_NOW_MINUTES * 60000` (the same constant, imported from `wizard-desk.js` — the server already imports from `public/js` for `crm-phone-match.js`). Without `book` nothing changes.

**Plan decisions (the code settles them):**
- Doctors open the same wizard («Направить на услуги»): they may send `desk`; the server ignores it (`deskArrival` roles) — test «близкий слот … от врача и колл-центра».
- No new UI string and no visible change in the wizard: the arrival shows on the CRM board.

**Files:**
- Create: `public/js/admin/views/wizard-desk.js`, `public/js/admin/__tests__/wizard-desk.test.mjs`
- Modify: `public/js/admin/views/visit-wizard.js` — import (after :53); `evArgs.desk` after the `book` block (:2693-2694)
- Modify: `server/services/rpc/visits.js` — import (:20); doc comment (:150); `deskBooked` after `parseBook` (:219); the two `crmLinkVisit` calls on the book paths (:332, :404)
- Modify: `server/services/crm/visit-link.js` — `deskArrival` comment (:339-340)
- Create: `server/routes/crm-link-all-desk-now.test.js`
- Modify: `public/js/admin/__tests__/wizard-booking.test.mjs` (2 tests appended)
- Modify (rule changed by D2): `server/routes/crm-unify-desk.test.js:131`
- Modify: `tests/crm-doors/helpers.mjs` (`wizardRegister` `desk` option); create `tests/crm-doors/scenarios-link-all.mjs`; switch the scenario import of `tests/crm-doors/matrix.test.mjs` and `tests/crm-doors/discover.mjs`; DECIDED: 4 GAP cells + 7 new scenarios

**Existing tests that encode the old rule:**

| file:line — test | old rule | new expectation |
|---|---|---|
| `server/routes/crm-unify-desk.test.js:131` «стойка: колл-центру, врачу, будущему дню и записи на время desk не верят; без desk сегодня — «Записан»» | case 4: `desk` + `book` at 09:00 today is never an arrival | case 4 uses a slot 3 hours ahead (always «later», or already tomorrow) → `'scheduled'`; the near-slot arrival is covered by the new `crm-link-all-desk-now.test.js` |

**Invariants touched:** I6 (the wizard's `ensure_visit` reuses the day visit as before), I7.

- [ ] **Step 1: Write the failing pure test** — create `public/js/admin/__tests__/wizard-desk.test.mjs`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R3 (решение владельца D2): «СЕЙЧАС» У СТОЙКИ — одно
// правило мастера визита и сервера (views/wizard-desk.js isDeskNow, DESK_NOW_MINUTES).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeskNow, DESK_NOW_MINUTES } from '../views/wizard-desk.js';

const NOW = new Date(2030, 2, 12, 10, 0, 0, 0).getTime();
const TODAY = '2030-03-12';

test('CRM_LINK_ALL_V1 R3: сегодня без слота (живая очередь, услуги без времени) — «сейчас»', () => {
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: null, nowMs: NOW }), true);
});

test('CRM_LINK_ALL_V1 R3: слот не позже чем через 30 минут (и уже начавшийся) — «сейчас»; позже — запись', () => {
  assert.equal(DESK_NOW_MINUTES, 30);
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: NOW + 30 * 60000, nowMs: NOW }), true);
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: NOW - 90 * 60000, nowMs: NOW }), true, 'записан на 08:30, пришёл в 10:00');
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: NOW + 31 * 60000, nowMs: NOW }), false);
});

test('CRM_LINK_ALL_V1 R3: другой день — никогда не «сейчас»; мусор — нет', () => {
  assert.equal(isDeskNow({ dayIso: '2030-03-13', todayIso: TODAY, headStartMs: null, nowMs: NOW }), false);
  assert.equal(isDeskNow({ dayIso: '2030-03-11', todayIso: TODAY, headStartMs: null, nowMs: NOW }), false);
  assert.equal(isDeskNow({ dayIso: '', todayIso: TODAY, nowMs: NOW }), false);
  assert.equal(isDeskNow({ dayIso: TODAY, todayIso: TODAY, headStartMs: 'x', nowMs: NOW }), false);
  assert.equal(isDeskNow(), false);
});
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test public/js/admin/__tests__/wizard-desk.test.mjs 2>&1 | grep -E "ERR_MODULE_NOT_FOUND|^ℹ (pass|fail)"`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `views/wizard-desk.js`.

- [ ] **Step 2: The rule** — create `public/js/admin/views/wizard-desk.js`:

```js
// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16) — R3, РЕШЕНИЕ ВЛАДЕЛЬЦА D2: «СЕЙЧАС» У СТОЙКИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Регистрация мастером визита на СЕГОДНЯ «сейчас» — это приход к стойке, как
// быстрая регистрация: карточка CRM сразу в «Пришёл». «Сейчас» — день визита
// сегодня И (у дня нет слота — живая очередь, услуги без времени — ИЛИ слот
// начинается не позже чем через DESK_NOW_MINUTES минут). Слот позже сегодня —
// запись: карточка «Записан», пока пациент не придёт.
//
// Одно правило на двух сторонах: экран (visit-wizard.js) решает, слать ли
// desk: true, сервер (server/services/rpc/visits.js ensure_visit) — верить ли
// ему у записи на время. Чистая функция: без DOM, без базы.
export const DESK_NOW_MINUTES = 30;

/**
 * @param {{dayIso: string, todayIso: string, headStartMs?: number|null, nowMs: number}} p
 *   dayIso — местный день визита 'YYYY-MM-DD'; todayIso — сегодняшний местный
 *   день; headStartMs — начало слота дня (null — слота нет); nowMs — сейчас.
 * @returns {boolean}
 */
export function isDeskNow({ dayIso, todayIso, headStartMs = null, nowMs } = {}) {
  if (!dayIso || !todayIso || String(dayIso).slice(0, 10) !== String(todayIso).slice(0, 10)) return false;
  if (headStartMs == null) return true;
  const start = Number(headStartMs);
  const now = Number(nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return false;
  return start <= now + DESK_NOW_MINUTES * 60000;
}
```

Run the Step 1 command again → `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 3: Write the failing server test** — create `server/routes/crm-link-all-desk-now.test.js`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R3 (решение владельца D2, дефект G5): МАСТЕР НА СЕГОДНЯ
// «СЕЙЧАС» — ПРИХОД К СТОЙКЕ. Без слота (живая очередь, услуги без времени) мастер шлёт
// ensure_visit с desk: true — как быстрая регистрация; со слотом — тоже, если слот начинается
// не позже чем через 30 минут: сервер проверяет это сам (DESK_NOW_MINUTES, wizard-desk.js).
// Слот позже — запись. Роль и сегодняшний день проверяет шаг связи (deskArrival).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, addLead } from '../test-helpers/crm-unify-app.js';
import { link } from '../test-helpers/crm-link-all.js';

const local = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
/** Слот через `min` минут — того же местного дня? Иначе проверка о другом (около полуночи). */
const sameDay = (min) => local(Date.now() + min * 60000) === local(Date.now());
const ensure = (t, who, startIso, extra = {}) => t.rpc('ensure_visit', who, { patient_id: 77, date: startIso, doctor_id: 10, visit_type: 'outpatient',
  book: { doctor_id: 10, service_id: 30, start: startIso, duration_minutes: 30 }, desk: true, ...extra });

test('CRM_LINK_ALL_V1 R3: запись на время с desk — слот через 10 минут: «Пришёл»', { skip: !sameDay(40) && 'около полуночи слот уходит в другой день' }, async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const start = new Date(Date.now() + 10 * 60000).toISOString();
    const r = await ensure(t, 'reg', start);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
    assert.equal(link(t, r.json.data.visit.id).request_id, rid);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R3: запись на время с desk — слот уже начался (записан на 20 минут раньше): «Пришёл»', { skip: !sameDay(-20) && 'сразу после полуночи слот во вчерашнем дне' }, async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const r = await ensure(t, 'reg', new Date(Date.now() - 20 * 60000).toISOString());
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'came');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R3: запись на время с desk — слот через 3 часа (или завтра): запись, «Записан»', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const r = await ensure(t, 'reg', new Date(Date.now() + 3 * 3600e3).toISOString());
    assert.equal(r.status, 200, r.text);
    assert.equal(t.lead(rid).status, 'scheduled');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R3: близкий слот с desk от врача и колл-центра — не приход (deskArrival не меняется)', { skip: !sameDay(40) && 'около полуночи' }, async () => {
  for (const who of ['doc', 'cc']) {
    const t = await startCrmApp();
    try {
      const rid = addLead(t.db, {});
      const r = await ensure(t, who, new Date(Date.now() + 10 * 60000).toISOString());
      assert.equal(r.status, 200, r.text);
      assert.equal(t.lead(rid).status, 'scheduled', who);
    } finally { t.close(); }
  }
});
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-desk-now.test.js 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: «через 10 минут» and «уже начался» FAIL (`'scheduled'` ≠ `'came'`); «через 3 часа» and «от врача и колл-центра» PASS (verified at HEAD).

- [ ] **Step 4: Server guard** — `server/services/rpc/visits.js`:

(a) after `:20` `import { crmLinkVisit } from '../crm/visit-link.js';   // CRM_UNIFY_V1` add
```js
import { DESK_NOW_MINUTES } from '../../../public/js/admin/views/wizard-desk.js';   // CRM_LINK_ALL_V1 (R3) — одно правило «сейчас» с мастером
```
(b) `:150` — replace `//         desk?: true (CRM_UNIFY_V1 — регистрация на стойке, только без book),` with
```js
//         desk?: true (CRM_UNIFY_V1 — регистрация на стойке; CRM_LINK_ALL_V1 (R3) — с book
//                      верится, только если слот начинается не позже чем через 30 минут),
```
(c) after `:219` `  const book = parseBook(args && args.book);` add
```js
  // CRM_LINK_ALL_V1 (R3; решение D2) — мастер на сегодня «сейчас» шлёт desk и с
  // записью на время: верим, только если слот начинается не позже чем через
  // DESK_NOW_MINUTES минут (то же правило, что у экрана, wizard-desk.js).
  // Остальное (роль, сегодняшний день) проверяет шаг связи (deskArrival).
  const deskBooked = desk && !!book && book.startMs <= Date.now() + DESK_NOW_MINUTES * 60000;
```
(d) `:332` and `:404` — in both lines replace `crmLinkVisit(db, out.visit.id, user, { undated: true });   // CRM_UNIFY_V1` with
```js
crmLinkVisit(db, out.visit.id, user, { undated: true, desk: deskBooked });   // CRM_UNIFY_V1 · CRM_LINK_ALL_V1 (R3)
```
(keep each line's indentation: 4 spaces at :332, 2 spaces at :404).

`server/services/crm/visit-link.js:339-340` — replace
```js
 * Колл-центру, врачу, будущему и прошедшему дню — нет. Без book решает дверь
 * (ensure_visit передаёт desk только без записи на время).
```
with
```js
 * Колл-центру, врачу, будущему и прошедшему дню — нет. Без book решает дверь;
 * с book ensure_visit передаёт desk, только если слот начинается не позже чем
 * через 30 минут (CRM_LINK_ALL_V1 R3 — мастер визита «сейчас», wizard-desk.js).
```

Run the Step 3 command again → `ℹ pass 4`, `ℹ fail 0` (or `skipped` near midnight).

- [ ] **Step 5: Update the existing test (D2)** — `server/routes/crm-unify-desk.test.js:131-137`: replace
```js
test('стойка: колл-центру, врачу, будущему дню и записи на время desk не верят; без desk сегодня — «Записан»', async () => {
  for (const [who, date, extra] of [
    ['cc', nowIso(), {}],
    ['doc', nowIso(), {}],
    ['reg', at(D, 10), {}],
    ['reg', at(TODAY, 9), { book: { doctor_id: 10, service_id: 30, start: at(TODAY, 9), duration_minutes: 30 } }],
  ]) {
```
with
```js
// CRM_LINK_ALL_V1 (решение владельца D2, R3) — правило изменено: запись на время СЕГОДНЯ со
// слотом не позже чем через 30 минут (и уже начавшимся) — тоже приход к стойке (мастер «сейчас»);
// слот позже — запись. Слот через 3 часа — всегда «позже» (или уже завтра).
test('стойка: колл-центру, врачу, будущему дню и записи на время позже 30 минут desk не верят; без desk сегодня — «Записан»', async () => {
  const later = new Date(Date.now() + 3 * 3600e3).toISOString();
  for (const [who, date, extra] of [
    ['cc', nowIso(), {}],
    ['doc', nowIso(), {}],
    ['reg', at(D, 10), {}],
    ['reg', later, { book: { doctor_id: 10, service_id: 30, start: later, duration_minutes: 30 } }],
  ]) {
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-unify-desk.test.js server/services/rpc/visits.test.js server/services/rpc/visits.local-day.test.js server/routes/crm-link-all-desk-now.test.js 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 0`.

- [ ] **Step 6: The wizard sends desk** — `public/js/admin/views/visit-wizard.js`:

(a) after `:53` `import { pendingCrmLines } from '../crm-lines.js';` add
```js
import { isDeskNow } from './wizard-desk.js';   // CRM_LINK_ALL_V1 (R3) — «сейчас» у стойки: одно правило с сервером
```
(b) in `createVisit`, right after the `if (timedHead) { … }` block (its last two lines are `                    if (emgReason) { evArgs.book.emergency = true; evArgs.book.emergency_reason = emgReason; }` and `                }`, :2693-2694) insert
```js
                // CRM_LINK_ALL_V1 (R3; решение владельца D2) — регистрация на СЕГОДНЯ «сейчас»
                // (живая очередь, услуги без времени или слот не позже чем через 30 минут) —
                // приход к стойке, как быстрая регистрация: карточка CRM сразу «Пришёл».
                // Слот позже сегодня — запись («Записан»). Сервер верит desk только
                // регистратуре и администратору и проверяет слот сам (ensure_visit).
                if (isDeskNow({ dayIso: day, todayIso: isoDay(Date.now()), headStartMs: timedHead ? new Date(timedHead.when).getTime() : null, nowMs: Date.now() })) {
                    evArgs.desk = true;
                }
```
(`day` is the loop's local `'YYYY-MM-DD'` key (`lineDay`); `isoDay(ms)` is the wizard's own local-day helper, :1442.)

- [ ] **Step 7: Client tests for the wizard** — append to `public/js/admin/__tests__/wizard-booking.test.mjs`:

```js

// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (R3; решение владельца D2) — МАСТЕР НА СЕГОДНЯ «СЕЙЧАС» — ПРИХОД
// К СТОЙКЕ. День без слота (услуга без врача «на дату», живая очередь) на сегодня
// — ensure_visit уходит с desk: true, как у быстрой регистрации; запись на другой
// день — без desk. Правило — views/wizard-desk.js (isDeskNow), сервер проверяет сам.
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 R3: мастер — анализ без врача на сегодня: ensure_visit с desk: true и без book', async () => {
  seed({});
  DB.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, { presetServiceIds: [22] });
  await flush(20);
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до ensure_visit: ' + JSON.stringify(TOASTS));
  assert.equal(ev.body.desk, true, 'регистрация «сейчас» не сказала серверу, что пациент у стойки');
  assert.ok(!ev.body.book, 'анализ без врача ушёл записью на время');
});

test('CRM_LINK_ALL_V1 R3: мастер — приём со слотом: desk уходит ровно тогда, когда слот сегодня и не позже чем через 30 минут', async () => {
  const { isDeskNow } = await import('../views/wizard-desk.js');
  await openWizardReady();
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev && ev.body.book, 'мастер не дошёл до записи с book: ' + JSON.stringify(TOASTS));
  const start = Date.parse(ev.body.book.start);
  const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const want = isDeskNow({ dayIso: ymd(start), todayIso: ymd(Date.now()), headStartMs: start, nowMs: Date.now() });
  assert.equal(ev.body.desk === true, want, 'desk: ' + ev.body.desk + ', слот ' + ev.body.book.start);
  if (!want) assert.ok(!('desk' in ev.body), 'запись позже сегодня или на другой день ушла как приход к стойке');
});
```
(The second test is clock-independent: `openWizardReady` auto-picks the first free slot, today within 30 minutes or later; the test asserts the wizard follows the rule either way. The harness prints `[wizard] invoice print: TypeError …` — pre-existing noise.)

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/wizard-desk.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/wizard-templates.test.mjs public/js/admin/__tests__/crm-lines.test.mjs 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 103`, `ℹ pass 103`, `ℹ fail 0` (verified on the prototype). Before Step 6 the first new wizard test fails (`desk` undefined).

- [ ] **Step 8: The matrix replays the new wizard** — (a) `tests/crm-doors/helpers.mjs`, `wizardRegister` — replace its first three lines
```js
export async function wizardRegister(t, who, whenIso, { book = true, pay = false, svc = 30, doctor = 10, pid = PID } = {}) {
  const ev = ok(await t.rpc('ensure_visit', who, { patient_id: pid, date: whenIso, doctor_id: doctor, visit_type: 'outpatient',
    referral_source_id: null, branch_id: 1, notes: null,
```
with
```js
export async function wizardRegister(t, who, whenIso, { book = true, pay = false, desk = false, svc = 30, doctor = 10, pid = PID } = {}) {
  // CRM_LINK_ALL_V1 (R3) — desk: true — мастер на сегодня «сейчас» (visit-wizard.js, wizard-desk.js isDeskNow).
  const ev = ok(await t.rpc('ensure_visit', who, { patient_id: pid, date: whenIso, doctor_id: doctor, visit_type: 'outpatient',
    referral_source_id: null, branch_id: 1, notes: null, ...(desk ? { desk: true } : {}),
```
(the frozen scenarios call it without `desk` — exactly today's wizard on a 23:00 slot, which D2 keeps a booking).

(b) create `tests/crm-doors/scenarios-link-all.mjs`:
```js
// CRM_LINK_ALL_V1 — scenarios added by the plan docs/plans/2026-10-16-crm-link-all.md
// (appended to SCENARIOS from scenarios-789.mjs). They have no frozen «today's
// behaviour» cell: their expectation lives only in DECIDED (matrix.test.mjs).
import {
  TODAY, PID, nowIso,
  seedS1, seedS2, seedS3, seedPhoneCard, wizardRegister, createPatient,
} from './helpers.mjs';
import { SCENARIOS } from './scenarios-789.mjs';

const add = (id, door, state, who, desc, run, gap = null) => SCENARIOS.push({ id, door, state, who, desc, run, gap });
const pickCard = (t, pid = PID) => { const c = t.db.prepare('SELECT id FROM crm_requests WHERE patient_id = ? ORDER BY id DESC').get(pid); return c ? c.id : null; };

// ─── Task 5 — R3 (D2): the wizard's «now» registration is a desk arrival ─────
// «now» = live-queue / no-slot mode: ensure_visit WITHOUT book, desk: true (visit-wizard.js createVisit).
const st = {
  S1: (t) => ({ rid: seedS1(t) }),
  S2: async (t) => seedS2(t),
  S3: (t) => ({ rid: seedS3(t) }),
  S4: () => ({ rid: null }),
  S1p: (t) => ({ rid: seedS1(t, { patient: null }) }),
};
for (const [state, seed] of Object.entries(st)) {
  add(`4-now-${state}`, 4, state, 'reg', 'wizard TODAY «now» (no slot / live queue) — desk arrival (R3)', async (t) => {
    const s = await seed(t);
    const { vid } = await wizardRegister(t, 'reg', nowIso(), { book: false, desk: true });
    return { ...s, rid: s.rid || pickCard(t), vid };
  });
}
add('5-S1p-crm-wizard-now', 5, 'S1p', 'reg', 'QPM from the CRM card → convert → wizard TODAY «now» (R3)', async (t) => {
  const rid = seedPhoneCard(t);
  const pid = await createPatient(t, 'reg');
  const up = await t.dbq('reg', { table: 'crm_requests', op: 'update', values: { patient_id: pid }, filters: [{ col: 'id', op: 'eq', val: rid }] });
  if (up.status !== 200) throw new Error(up.text);
  const { vid } = await wizardRegister(t, 'reg', nowIso(), { pid, book: false, desk: true });
  return { rid, vid, pid };
});
add('7-wiz-S2T-now', 7, 'S2T', 'reg', 'call centre booked TODAY 23:00 from the card; the patient comes early — wizard «now» (R3)', async (t) => {
  const s = await seedS2(t, TODAY, { hour: 23 });
  const { vid } = await wizardRegister(t, 'reg', nowIso(), { book: false, desk: true });
  return { ...s, vid };
});

export { SCENARIOS };
```
(No matrix scenario sends `desk` WITH a slot: whether 23:00 is «later» depends on the clock — that guard is tested with clock-relative slots in `crm-link-all-desk-now.test.js`.)

(c) `tests/crm-doors/matrix.test.mjs` — replace `import { SCENARIOS } from './scenarios-789.mjs';` with `import { SCENARIOS } from './scenarios-link-all.mjs';   // CRM_LINK_ALL_V1 — the frozen doors + the plan's scenarios`; the same replacement in `tests/crm-doors/discover.mjs`.

(d) add to `DECIDED` (cells verified on the prototype; the four GAP cells keep today's cell — a 23:00 slot is a booking by D2):
```js
  // Task 5 — R3 (D2)
  '4-today-S1': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '5-S1p-crm-wizard': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2T-same': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2T-earlier': { rule: 'D2: a slot later today is a booking', owner: 'booked', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
  '4-now-S1': { rule: 'R3 (D2) + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-now-S2': { rule: 'R3 (D2) + R6', owner: 'came+lines', cell: {"stage":"came","date":"D","lines":["30@D:pending/B","30@T:done/V"],"link":"card","cards":1,"visits":2,"vs":[30]} },
  '4-now-S3': { rule: 'R3 (D2) + R2 + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '4-now-S4': { rule: 'R3 (D2): no card — still no card (owner decision 2)', owner: 'nodup', cell: {"stage":null,"date":null,"lines":[],"link":"none","cards":0,"visits":1,"vs":[30]} },
  '4-now-S1p': { rule: 'R3 (D2) + R5 + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '5-S1p-crm-wizard-now': { rule: 'R3 (D2) + R6', owner: 'came+lines', cell: {"stage":"came","date":"-","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2T-now': { rule: 'R3 (D2)', owner: 'came+lines', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"none","cards":1,"visits":1,"vs":[30]} },
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 107`, `ℹ pass 105`, `ℹ fail 0`, `ℹ todo 2` (70 + 30 + 7 new; only the two G7 twin GAPs left).

- [ ] **Step 9: Re-check (try to break it)** — a doctor's wizard «now»: `deskArrival` still refuses (`crm-unify-desk.test.js:131` case 'doc' + new test 4); slot exactly at now+30 → arrival, now+31 → booking (pure test 2); `grep -n "deskBooked\|desk" server/services/rpc/visits.js` → `desk` reaches `crmLinkVisit` on the book paths only through `deskBooked`.

- [ ] **Step 10: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add public/js/admin/views/wizard-desk.js public/js/admin/__tests__/wizard-desk.test.mjs public/js/admin/views/visit-wizard.js public/js/admin/__tests__/wizard-booking.test.mjs server/services/rpc/visits.js server/services/crm/visit-link.js server/routes/crm-link-all-desk-now.test.js server/routes/crm-unify-desk.test.js tests/crm-doors/helpers.mjs tests/crm-doors/scenarios-link-all.mjs tests/crm-doors/matrix.test.mjs tests/crm-doors/discover.mjs
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t5.txt <<'EOF'
CRM: регистрация мастером визита на сегодня «сейчас» (без слота или слот не позже чем через 30 минут) — приход к стойке, карточка сразу «Пришёл»; слот позже — запись (решение владельца D2; CRM_LINK_ALL_V1 R3)

Одно правило экрана и сервера — views/wizard-desk.js isDeskNow; ensure_visit верит desk с записью на время только для близкого слота, роли и день проверяет deskArrival, как прежде. Тест стойки «записи на время desk не верят» сменил ожидание по решению D2. Матрица дверей: 4 клетки мастера — запись по D2, 7 новых сценариев «сейчас».

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t5.txt
```

---

## Task 6: R7b — server safety net: a registration line replaces the booked line of the same service

**Decision:** none needed (defect G7). **Spec:** R7(b).

**Root cause (re-confirmed in code):** `booking_lines_add` inserts the call centre's line with `insertBookingLine` (`booking-lines.js:112`); the mirror then links it to a card line with `visit_service_auto = 0` (`booking-mirror.js` step 3, :456-459). Every existing «the registrar's line takes the place of the booked line» path — `autoLineFor`/`yieldAutoLine` (:591-614), `replaceAutoTwins` (:624-634), `pruneAutoLinesOnInvoice` (:791-814) — only yields lines with `visit_service_auto = 1`. So the desk's own line of the same consultation becomes a second row.

**How (decided from the code — door, not mirror):** a new module `server/services/crm/booked-twin.js`, `retireBookedTwin(db, vsId)`, called by the `/api/db` door (`routes/db.js`) right after a single-row `visit_services` insert and BEFORE `mirrorAfter`: if the visit already holds a **booking line X** of the same service, the new line Y takes its place — every card line that held X moves to Y (`relinkHeld`, auto = 0) and X is deleted (`deleteVs`). The mirror never changes; it only gets `export` on `vsFree`, `relinkHeld`, `deleteVs` (no body change). After the replacement Y is an ordinary desk line (created by the registrar, auto 0), so a second insert of the same service is a real second row (real repeats untouched).

X is a booking line only if ALL hold: same visit; own building (`sync_origin` null on visit and line); visit pre-arrival (`scheduled`/`confirmed`) — or `arrived` on today's local day; X inserted before Y (`id` smaller); X `'added'`, no invoice item, `vsFree` (no results/documents/queue ticket, not a clinic item); quantity 1 on both; `sameService(X, Y)` (same key; for a doctor service the same doctor, or X without a doctor); and X came from a booking: created by a **pure call-centre user** (`isCallcenterUser` — `booking_lines_add`) **or** held by a card line with `visit_service_auto = 1` (a CRM-mirror line). Y must be `'added'`, unbilled, quantity 1.

**Plan decisions (the code settles them):**
- «The insert reuses the existing line» is implemented as «the existing booking line yields to the inserted line»: one row remains either way, but the screens already hold the id the insert returned and pass it straight to `create_invoice_for_visit` (`walk-in-booking.js:291-296`, `visit-wizard.js:2809`); answering an insert with another row's id would need a special `/api/db` response and would drop the desk's own price tier / package / payer. The yield direction is the one the mirror has always used for its own lines (`yieldAutoLine`).
- A registrar's own calendar booking line (not call centre, not mirror) is NOT replaced by the net: nothing distinguishes it from a deliberate second line by the same desk. The screens close that hole (Task 7 shows the booked row instead of inserting a second one). Test «строку регистратуры … не заменяет».
- A billed or started booking line (prepayment) is never touched (I4): the desk line stays a second row; Task 7 shows such a booked row read-only so the desk does not add it again.
- The six `CRM_TWIN_LINE` todos in `server/services/crm/booking-mirror-twin.test.js:111-116` stay todo: they are bodiless `test.todo(name)` descriptions of two-card cancel/reschedule twins INSIDE the mirror (`regAdd` there writes `visit_services` directly, not through `/api/db`); none is a registration-door twin, so R7 resolves none of them (verified: same 6 todos on the prototype).

**Files:**
- Modify: `server/services/crm/booking-mirror.js` — `export` on `vsFree` (:99), `relinkHeld` (:247), `deleteVs` (:252) only
- Create: `server/services/crm/booked-twin.js`
- Modify: `server/routes/db.js` — import (:30); call after the evidence block (:581-583), before `mirrorAfter` (:584)
- Create: `server/routes/crm-link-all-twin.test.js`
- Modify: `tests/crm-doors/matrix.test.mjs` (2 cells; replaces the Task 3 intermediate)

**Existing tests that encode the old rule:** none (the prototype run of the 269 door test files: no failure from R7b).

**Invariants touched:** I4 (billed/started lines untouched — test 4), I5 (test 6), I6, I7 (try/catch, returns null — test 6).

- [ ] **Step 1: Write the failing tests** — create `server/routes/crm-link-all-twin.test.js`:

```js
// CRM_LINK_ALL_V1 (2026-10-16) — R7b (дефект G7): ВТОРОЙ КОПИИ ЗАПИСАННОЙ УСЛУГИ НЕТ.
// Колл-центр записал на сегодня в календаре (booking_lines_add), регистратура оформила ту же
// услугу — дверь /api/db: строка регистратуры занимает место строки записи (crm/booked-twin.js).
// Повтор, другой врач, количество, счёт и работа — не трогаются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startCrmApp, localDay, addLead } from '../test-helpers/crm-unify-app.js';
import { vsOf, cardLines, addVisitLine, callcenterBook, deskRegister } from '../test-helpers/crm-link-all.js';
import { retireBookedTwin } from '../services/crm/booked-twin.js';

const TODAY = localDay(0);

test('CRM_LINK_ALL_V1 R7b: запись колл-центра на сегодня, стойка оформила ту же консультацию — в визите одна строка, её id у экрана, строка карточки на ней', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const booked = vsOf(t, bid);
    assert.equal(booked.length, 1);
    const { vid, ids } = await deskRegister(t, 'reg');
    assert.equal(vid, bid, 'второй визит на день (I6)');
    assert.deepEqual(vsOf(t, vid).map((x) => x.id), ids, 'в визите две консультации или не та строка');
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_service_id]), [[30, 'done', ids[0]]]);
    const inv = await t.rpc('create_invoice_for_visit', 'reg', { visit_id: vid, visit_service_ids: ids, discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    assert.equal(Number(t.db.prepare('SELECT total_amount FROM invoices WHERE visit_id = ?').get(vid).total_amount), 100000, 'двойной счёт');
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: мастер на записанный слот — одна строка в визите и на карточке', async () => {
  const t = await startCrmApp();
  try {
    const rid = addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const y = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((x) => x.id), [y]);
    assert.deepEqual(cardLines(t, rid).map((l) => [l.service_id, l.status, l.visit_service_id]), [[30, 'pending', y]]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: настоящий повтор, другой врач и количество 2 — не заменяются', async () => {
  const t = await startCrmApp();
  try {
    t.db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (11,'doc2','x','Петров','doctor',1)").run();
    addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const y1 = await addVisitLine(t, 'reg', bid);
    const y2 = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((x) => x.id), [y1, y2], 'второй приём того же дня регистратуры поглощён');
    const other = await addVisitLine(t, 'reg', bid, { doctor: 11 });
    assert.ok(vsOf(t, bid).some((x) => x.id === other), 'консультация другого врача поглощена');
  } finally { t.close(); }
  const t2 = await startCrmApp();
  try {
    addLead(t2.db, {});
    const bid = await callcenterBook(t2, TODAY, { hour: 23 });
    const x = vsOf(t2, bid)[0].id;
    const y = await addVisitLine(t2, 'reg', bid, { quantity: 2 });
    assert.deepEqual(vsOf(t2, bid).map((r) => r.id), [x, y], 'количество 2 заменило строку записи');
  } finally { t2.close(); }
});

test('CRM_LINK_ALL_V1 R7b: строка записи в счёте — не трогается (I4)', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const bid = await callcenterBook(t, TODAY, { hour: 23 });
    const x = vsOf(t, bid)[0].id;
    const inv = await t.rpc('create_invoice_for_visit', 'kassa', { visit_id: bid, visit_service_ids: [x], discount_amount: 0, payer_id: null });
    assert.equal(inv.status, 200, inv.text);
    const y = await addVisitLine(t, 'reg', bid);
    assert.deepEqual(vsOf(t, bid).map((r) => r.id), [x, y]);
    assert.ok(t.db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(x).invoice_item_id != null);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: строку регистратуры (не колл-центр, не зеркало) вставка не заменяет — её закрывает экран (R7a)', async () => {
  const t = await startCrmApp();
  try {
    addLead(t.db, {});
    const ev = await t.rpc('calendar_book', 'reg', { patient_id: 77, doctor_id: 10, service_id: 30, start: new Date(Date.now() + 3 * 3600e3).toISOString(), duration_minutes: 30, status: 'scheduled' });
    assert.equal(ev.status, 200, ev.text);
    const vid = ev.json.data.visit.id;
    const x = await addVisitLine(t, 'reg', vid);
    const y = await addVisitLine(t, 'reg', vid);
    assert.deepEqual(vsOf(t, vid).map((r) => r.id), [x, y]);
  } finally { t.close(); }
});

test('CRM_LINK_ALL_V1 R7b: визит соседнего здания и мусор — ничего не делает и не бросает', async () => {
  const t = await startCrmApp();
  try {
    assert.equal(retireBookedTwin(t.db, 999999), null);
    assert.equal(retireBookedTwin(t.db, 'x'), null);
    const vid = Number(t.db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, sync_origin) VALUES (77, 10, ?, 'scheduled', 'B')").run(new Date().toISOString()).lastInsertRowid);
    const ins = t.db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 30, 10, 1, 100000, 100000, 'added', ?)");
    ins.run(vid, 3);
    const y = Number(ins.run(vid, 2).lastInsertRowid);
    assert.equal(retireBookedTwin(t.db, y), null);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ?').get(vid).n, 2);
  } finally { t.close(); }
});
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-twin.test.js 2>&1 | grep -E "ERR_MODULE_NOT_FOUND|^ℹ (pass|fail)"`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` for `services/crm/booked-twin.js`.

- [ ] **Step 2: Export three mirror helpers (no body change)** — `server/services/crm/booking-mirror.js`:
  - `:99` `function vsFree(db, vs) {` → `export function vsFree(db, vs) {   // CRM_LINK_ALL_V1 — экспорт для crm/booked-twin.js (правило не меняется)`
  - `:247` `function relinkHeld(db, fromId, toId) {` → `export function relinkHeld(db, fromId, toId) {   // CRM_LINK_ALL_V1 — экспорт для crm/booked-twin.js`
  - `:252` `function deleteVs(db, id) {` → `export function deleteVs(db, id) {   // CRM_LINK_ALL_V1 — экспорт для crm/booked-twin.js`

Check: `git diff --stat server/services/crm/booking-mirror.js` → `3 insertions(+), 3 deletions(-)`.

- [ ] **Step 3: The net** — create `server/services/crm/booked-twin.js`:

```js
// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16) — R7b, ДЕФЕКТ G7: ВТОРОЙ КОПИИ ЗАПИСАННОЙ УСЛУГИ НЕТ
// ═══════════════════════════════════════════════════════════════════════════
//
// Колл-центр записал пациента на сегодня в календаре (booking_lines_add) —
// строка визита 'added' стоит в смете. Пациент пришёл, регистратура оформила
// ту же консультацию (быстрая регистрация, мастер визита) — дверь /api/db
// вставила ВТОРУЮ строку той же услуги: визит держал её дважды, касса брала
// дважды. Замену строки зеркала (visit_service_auto = 1) строкой регистратуры
// делало и раньше зеркало (booking-mirror.js yieldAutoLine); строку
// booking_lines_add (зеркало связывает её с auto = 0) — не делал никто.
//
// ПРАВИЛО (одна дверь — /api/db, routes/db.js, сразу после вставки одной
// строки visit_services и ДО сверки зеркала): новая строка регистратуры Y
// занимает место строки записи X той же услуги, а X уходит. Строки заявки,
// державшие X, переходят на Y (relinkHeld). Касса видит одну строку — ту, что
// поставила регистратура (её цена, пакет, плательщик), и её id уже у экрана.
//
// X — СТРОКА ЗАПИСИ, только если всё сразу:
//   • тот же визит, своё здание (sync_origin пуст), визит до прихода или уже
//     «Пришёл»; до прихода — любой день, «Пришёл» — только сегодня;
//   • заведена раньше Y (id меньше), 'added', без счёта, без детей (результаты,
//     документы, талон), не товар — vsFree; количество 1 у обеих;
//   • та же услуга (sameService: тот же ключ; у услуги с врачом — тот же врач,
//     или у X врача нет);
//   • её поставила ЗАПИСЬ: завёл пользователь «только колл-центр»
//     (isCallcenterUser — booking_lines_add), или её держит строка заявки как
//     строку зеркала (visit_service_auto = 1).
// После замены строка Y — строка регистратуры (auto = 0, завёл регистратор):
// вторая вставка той же услуги — настоящий повтор, и он остаётся вторым.
// Выставленное, оплаченное и начатое не трогается никогда. Не бросает.
import { visitRow, PRE_ARRIVAL, lineKey, sameService, isCallcenterUser, vsFree, relinkHeld, deleteVs } from './booking-mirror.js';
import { today } from '../domain/day.js';

function creatorIsCallcenter(db, userId) {
  if (!userId) return false;
  const u = db.prepare('SELECT role, extra_roles FROM users WHERE id = ?').get(userId);
  if (!u) return false;
  let extra = u.extra_roles;
  if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { extra = []; } }
  return isCallcenterUser({ role: u.role, extra_roles: Array.isArray(extra) ? extra : [] });
}

/**
 * @param {object} db
 * @param {number} vsId — только что вставленная строка visit_services (Y)
 * @returns {number|null} id ушедшей строки записи (X) или null
 */
export function retireBookedTwin(db, vsId) {
  try {
    const y = db.prepare('SELECT * FROM visit_services WHERE id = ?').get(Number(vsId));
    if (!y || !lineKey(y) || y.status !== 'added' || y.invoice_item_id != null) return null;
    if (y.clinic_item_id != null || y.sync_origin != null || Number(y.quantity || 1) !== 1) return null;
    const v = visitRow(db, y.visit_id);
    if (!v || v.sync_origin != null) return null;
    const pre = PRE_ARRIVAL.includes(v.status);
    if (!pre && !(v.status === 'arrived' && v.day === today(db))) return null;
    const autoHeld = db.prepare(`SELECT 1 FROM crm_request_services
                                  WHERE visit_service_id = ? AND visit_service_auto = 1 AND status <> 'cancelled' LIMIT 1`);
    const x = db.prepare(`SELECT * FROM visit_services
                           WHERE visit_id = ? AND id < ? AND status = 'added' AND invoice_item_id IS NULL
                             AND clinic_item_id IS NULL AND sync_origin IS NULL AND COALESCE(quantity, 1) = 1
                           ORDER BY id`).all(v.id, y.id)
      .find((c) => sameService(db, c, y) && vsFree(db, c) && (creatorIsCallcenter(db, c.created_by) || !!autoHeld.get(c.id)));
    if (!x) return null;
    db.transaction(() => {
      relinkHeld(db, x.id, y.id);
      deleteVs(db, x.id);
    })();
    return Number(x.id);
  } catch (e) {
    console.error('[crm-twin] строка записи для', vsId, 'не разобрана:', e && e.message);   // CRM_LINK_ALL_V1
    return null;
  }
}
```

- [ ] **Step 4: Call it from the door** — `server/routes/db.js`:

(a) after `:30` `import { mirrorBefore, mirrorAfter } from '../services/crm/booking-mirror-db.js';` add
```js
import { retireBookedTwin } from '../services/crm/booked-twin.js';   // CRM_LINK_ALL_V1 (R7b)
```
(b) the single-row insert path (:581-584) — replace
```js
        if (meta.table === 'visit_services' && hasEvidenceStatus(req.body)) {
          crmServiceEvidence(db, [Number(info.lastInsertRowid)]);
        }
        mirrorAfter(db, mirror, meta, req.body, req.user, { insertedId: Number(info.lastInsertRowid) });   // CRM_CALENDAR_MIRROR_V1
```
with
```js
        if (meta.table === 'visit_services' && hasEvidenceStatus(req.body)) {
          crmServiceEvidence(db, [Number(info.lastInsertRowid)]);
        }
        // CRM_LINK_ALL_V1 (R7b, дефект G7) — строка регистратуры занимает место строки
        // записи той же услуги (колл-центр, зеркало CRM): второй копии в визите нет.
        // До сверки зеркала: сверка видит уже одну строку.
        if (meta.table === 'visit_services') retireBookedTwin(db, Number(info.lastInsertRowid));
        mirrorAfter(db, mirror, meta, req.body, req.user, { insertedId: Number(info.lastInsertRowid) });   // CRM_CALENDAR_MIRROR_V1
```
(The multi-row path (`meta.multi`, the Excel importer) is not touched. The response still re-reads the inserted row by `rowid` — Y — which is the row that stays.)

- [ ] **Step 5: Run the new tests — must pass**

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/routes/crm-link-all-twin.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`.

Then the twin/mirror/desk neighbours:
Run: `LIS_ENABLED=0 node --experimental-vm-modules --test server/services/crm/booking-mirror-twin.test.js server/routes/crm-calendar-mirror.test.js server/routes/crm-calendar-v3120.test.js server/routes/crm-lines-v3120-final.test.js server/routes/crm-unify-desk.test.js server/routes/crm-unify-desk-money.test.js server/routes/crm-unify-link-guards.test.js server/routes/crm-link-all-desk-lines.test.js server/services/rpc/money-desk.v3120.test.js 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail|todo)"`
Expected: `ℹ fail 0`, `ℹ todo 6` (the CRM_TWIN_LINE todos, unchanged).

- [ ] **Step 6: Flip the matrix cells** — in `DECIDED`, REPLACE the Task 3 intermediate entry of `7-fast-S2Tcal-same` and add `7-wiz-S2Tcal-same`:

```js
  // Task 6 — R7b (G7)
  '7-fast-S2Tcal-same': { rule: 'R7b (G7)', owner: 'nodup', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '7-wiz-S2Tcal-same': { rule: 'R7b (G7)', owner: 'nodup', cell: {"stage":"scheduled","date":"T","lines":["30@T:pending/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 107`, `ℹ pass 107`, `ℹ fail 0`, `ℹ todo 0` — all 30 GAP cells are real tests now.

- [ ] **Step 7: Re-check (try to break it)** — this is the fifth round on twin lines; check each earlier failure mode by hand against the prototype tests:
  - two cards sharing one visit line (V3120_FINAL `relinkHeld` moves ALL non-cancelled card lines) — `crm-lines-v3120-final.test.js` green;
  - merge of two cards then a desk line — `server/services/rpc/crm-merge.test.js`, `crm-merge-review.test.js`, `crm-merge-coverage.test.js` green (run them);
  - a line with a queue ticket / result is never deleted (`vsFree`) — covered by `money-desk.v3120.test.js`;
  - `git diff server/services/crm/booking-mirror.js` shows ONLY the three `export` keywords.

- [ ] **Step 8: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add server/services/crm/booking-mirror.js server/services/crm/booked-twin.js server/routes/db.js server/routes/crm-link-all-twin.test.js tests/crm-doors/matrix.test.mjs
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t6.txt <<'EOF'
CRM: строка регистратуры занимает место строки записи той же услуги (колл-центр в календаре, зеркало CRM) — второй копии в визите и в счёте нет; повтор, другой врач, количество, счёт и работа не трогаются (дефект G7; CRM_LINK_ALL_V1 R7b)

Новая crm/booked-twin.js — в двери /api/db до сверки зеркала; в booking-mirror.js только export трёх помощников, правило зеркала не менялось. Матрица дверей: все 30 клеток GAP — настоящие тесты.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t6.txt
```

---

## Task 7: R7a — «из записи» rows in fast registration and the wizard

**Decision:** none needed (defect G7). **Spec:** R7(a).

**What «из записи» rows are (decided from the code):** one loader for both windows, `public/js/admin/views/booked-rows.js` `loadTodayBooking(patientId)`: the patient's visit of TODAY's local day (`visit_date` within the local day bounds), own building (`sync_origin` null), status `scheduled`/`confirmed` — at most one by I6 — and its lines with status `'added'` that are services (`service_id` or `consultation_type_id`, not clinic items). Each row: `vsId`, service / consultation type, doctor, quantity, the line's own `unit_price`, `billed` (has `invoice_item_id`), name, and the booked time (`scheduled_at`, else the visit time, as local `'YYYY-MM-DDTHH:MM'`). Reads only `/api/db` tables the registrar already reads (`visits`, `visit_services` with the `services` / `consultation_types` embeds of the schema registry) — no CRM table (the existing test «окно быстрой регистрации не пишет в CRM само» stays green).

How the windows use them:
- **Fast registration:** when a patient is picked (`usePatient` — search strip, duplicate dialog «use existing»), unbilled booked rows are added to the table with a chip «из записи · Записан/Подтверждён» (`Icon('Calendar')`, 12.5px, wraps at 360 px); the doctor of a booked row is locked (the line already exists with that doctor — to change it, remove the row and add the service again); its price is the line's own price. Billed booked rows are NOT table rows (they must not be invoiced again); one muted line under the table names them («По записи уже в счёте: …»). Removing a booked row records its `vsId`; «Сменить» clears booked rows. `registerWalkIn` gets `bookedVsId` per line, `dropVsIds` and `bookedVisitId`: drops first (`booking_line_remove` — the calendar's own door, refuses billed/started lines), then `ensure_visit` (which returns the same day visit), booked lines are NOT inserted — their ids go straight into `create_invoice_for_visit` and `issue_queue_numbers`; a successful drop is removed from `dropVsIds`, so a retry after a later failure does not drop twice; a booked visit that is not the visit `ensure_visit` returned → refusal before any line.
- **Wizard:** `prefillFromBooking()` (before `prefillFromCrm`, only when the wizard opens for today) puts unbilled booked CATALOG services into the cart with `booked: { vsId, visitId, status, when }` — doctor and time of the booking, quantity of the line (no quantity stepper for a booked line), chip in the estimate rail. `prefillFromCrm` already skips a service that is in the cart, so the CRM line of the same booking is not added twice. In `createVisit`: a booked line whose time was not changed keeps the booking's slot — it is not a `timedHead` (no `book`, no slot re-check in `gateDaySlots`) but its time decides «now» for R3 (`deskHead = timedHead || bookedHead`); booked lines are not inserted, their ids go into the day's invoice and the route list; removed booked lines are dropped with `booking_line_remove` before the first write. A consultation-by-type booked line (not a catalog service) is not shown in the wizard cart — it stays in the visit and waits for the cashier («Ждут счёта»); fast registration shows it (consult pick object).

**Plan decisions (the code settles them):**
- The booked doctor is locked in fast registration and the booked quantity is locked in the wizard: changing either would make the screen and the existing line disagree (the line is not re-inserted).
- Drops are applied at save time, not on click: «Отмена» leaves the booking untouched.
- No new server code in this task; R7b (Task 6) stays the safety net for old cached screens.

**Files:**
- Create: `public/js/admin/views/booked-rows.js`
- Modify: `public/js/admin/views/walk-in-booking.js` — header doc (:44), signature (:185), drops after the surgery check (:195), visit check after `answer.busy` (:235), `serviceIds` (:240), the line loop (:258-262)
- Modify: `public/js/admin/views/fast-registration.js` — import (:73), state (:189-192), `bookedNote` (:295), services block (:307), `rowPrice` (:404), `doctorCell` (:466), name cell (:514), `removeLine` (:570), `clearBookedRows`/`showBookedRows` + `usePatient` (:636-652), `bookServices` lines (:788)
- Modify: `public/js/admin/views/visit-wizard.js` — import, `wiz.dropBooked`, `prefillFromBooking`, `removeCartLine` (2 call sites), rail chip, `bookedKeepsSlot`, `gateDaySlots`, `createVisit` (drops, heads, booked lines)
- Modify: `public/js/admin/i18n-strings.js` — 7 entries
- Modify: `public/js/admin/__tests__/walk-in-booking.test.mjs` (2 tests), `public/js/admin/__tests__/fast-registration.test.mjs` (harness + 4 tests), `public/js/admin/__tests__/wizard-booking.test.mjs` (1 test)
- Modify: `tests/crm-doors/scenarios-link-all.mjs` (3 scenarios replaying the NEW screens), `tests/crm-doors/matrix.test.mjs` (3 cells)

**Existing tests that encode the old rule:** none (all 103 tests of the six wizard/registration client files and the i18n guards pass on the prototype, ru and en-US).

**Invariants touched:** I4 (billed booked rows never re-invoiced; drops go through `booking_line_remove`, which refuses billed/started lines), I6, I7 (a failed booking load is a warning toast, the window still works).

- [ ] **Step 1: Write the failing walk-in tests** — append to `public/js/admin/__tests__/walk-in-booking.test.mjs`:

```js

// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (R7a; дефект G7) — СТРОКИ «ИЗ ЗАПИСИ». Пациент записан на
// сегодня: строки записи уже в визите дня. Регистрация их не вставляет второй
// раз — счёт выставляется на них; убранная регистратором строка записи
// снимается с визита (booking_line_remove) ДО визита.
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 R7a: строка «из записи» не вставляется второй раз — счёт на строку записи; убранная снимается до визита', async () => {
  seed();
  const at = new Date(); at.setHours(23, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (?, ?, ?, 'scheduled', 1)").run(PATIENT, DOCTOR, at.toISOString()).lastInsertRowid);
  const ins = DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by) VALUES (?, ?, ?, 1, ?, ?, 'added', 'primary', 1)");
  const keep = Number(ins.run(vid, CONSULT, DOCTOR, 100000, 100000).lastInsertRowid);
  const drop = Number(ins.run(vid, LAB, null, 40000, 40000).lastInsertRowid);
  const drops = [drop];
  const out = await registerWalkIn({
    patientId: PATIENT,
    lines: [{ service: svc(CONSULT), doctorId: DOCTOR, bookedVsId: keep, bookedUnitPrice: 100000 }],
    dropVsIds: drops, bookedVisitId: vid, createdBy: USER.id,
  });
  assert.equal(out.visit.id, vid, 'регистрация завела второй визит');
  assert.deepEqual(all('SELECT id FROM visit_services WHERE visit_id = ? ORDER BY id', vid).map((r) => r.id), [keep], 'вторая строка или убранная строка осталась');
  assert.deepEqual(drops, [], 'снятая строка осталась в списке — повтор снимал бы её второй раз');
  assert.equal(out.items.length, 1);
  assert.equal(out.invoice.total_amount, 100000);
  assert.deepEqual(out.lines.map((l) => l.visitServiceId), [keep]);
});

test('CRM_LINK_ALL_V1 R7a: строка «из записи» другого визита — отказ словами, счёта нет', async () => {
  seed();
  await assert.rejects(registerWalkIn({
    patientId: PATIENT,
    lines: [{ service: svc(CONSULT), doctorId: DOCTOR, bookedVsId: 999, bookedUnitPrice: 1 }],
    bookedVisitId: 12345, createdBy: USER.id,
  }), /другой визит/);
  assert.equal(countOf('invoices'), 0);
  assert.equal(countOf('visit_services'), 0);
});
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test --test-name-pattern="CRM_LINK_ALL_V1" public/js/admin/__tests__/walk-in-booking.test.mjs 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: both FAIL (a second line is inserted; no refusal).

- [ ] **Step 2: The loader** — create `public/js/admin/views/booked-rows.js`:

```js
// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (2026-10-16) — R7a, ДЕФЕКТ G7: «ИЗ ЗАПИСИ» — ЗАПИСАННЫЕ УСЛУГИ
// СЕГОДНЯШНЕГО ВИЗИТА — ГОТОВЫЕ СТРОКИ РЕГИСТРАЦИИ
// ═══════════════════════════════════════════════════════════════════════════
//
// Пациента записали на сегодня (календарь, колл-центр, карточка CRM): в его
// визите дня уже стоят строки услуг 'added'. Быстрая регистрация и мастер визита
// вставляли ту же услугу второй строкой — визит и счёт держали её дважды. Окна
// регистрации теперь показывают эти строки сами («из записи», со статусом
// записи) и регистрируют ИХ: второй строки не вставляют, счёт выставляют на
// строку записи. Убранная регистратором строка записи снимается с визита так
// же, как это делает календарь (booking_line_remove).
//
// Одно чтение на оба окна. Без DOM. Бросает при отказе сервера (пустой ответ
// неотличим от «записи нет»).
import { supabase } from '../../supabase.js';

const isPosInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const pad = (n) => String(n).padStart(2, '0');

/** Границы МЕСТНОГО дня `now` в ISO (visits.visit_date хранится в UTC ISO). */
export function localDayBounds(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const next = new Date(d); next.setDate(next.getDate() + 1);
  return { from: d.toISOString(), to: next.toISOString() };
}

/** ISO-мгновение → местное 'YYYY-MM-DDTHH:MM' (так мастер визита хранит время строки). */
export function localSlot(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Запись пациента на СЕГОДНЯ: визит своего здания «Записан»/«Подтверждён» и его
 * строки-услуги «в смете» ('added', не товар).
 * @returns {Promise<{visit: {id:number, status:string, visit_date:string}|null,
 *   rows: Array<{vsId:number, serviceId:number|null, consultationTypeId:number|null, doctorId:number|null,
 *                quantity:number, unitPrice:number, billed:boolean, name:string, service:object|null,
 *                consultation:object|null, when:string|null}>}>}
 */
export async function loadTodayBooking(patientId, { now = new Date() } = {}) {
  if (!isPosInt(patientId)) return { visit: null, rows: [] };
  const { from, to } = localDayBounds(now);
  const { data: visits, error } = await supabase.from('visits').select('id, status, visit_date')
    .eq('patient_id', Number(patientId)).in('status', ['scheduled', 'confirmed']).is('sync_origin', null)
    .gte('visit_date', from).lt('visit_date', to).order('id').limit(1);
  if (error) throw new Error(error.message || String(error));
  const visit = (visits || [])[0] || null;
  if (!visit) return { visit: null, rows: [] };
  const { data: lines, error: lErr } = await supabase.from('visit_services')
    .select('id, service_id, consultation_type_id, doctor_id, quantity, unit_price, status, invoice_item_id, clinic_item_id, scheduled_at, services(id, name, price, tax_rate, type), consultation_types(id, name, name_ru, name_uz, price)')
    .eq('visit_id', visit.id).eq('status', 'added').order('id');
  if (lErr) throw new Error(lErr.message || String(lErr));
  const rows = (lines || [])
    .filter((l) => l.clinic_item_id == null && (l.service_id != null || l.consultation_type_id != null))
    .map((l) => {
      const svc = l.services || null;
      const ct = l.consultation_types || null;
      return {
        vsId: Number(l.id),
        serviceId: l.service_id != null ? Number(l.service_id) : null,
        consultationTypeId: l.service_id == null && l.consultation_type_id != null ? Number(l.consultation_type_id) : null,
        doctorId: isPosInt(l.doctor_id) ? Number(l.doctor_id) : null,
        quantity: Number(l.quantity) || 1,
        unitPrice: Number(l.unit_price) || 0,
        billed: l.invoice_item_id != null,
        name: (svc && svc.name) || (ct && (ct.name_ru || ct.name)) || '',
        service: svc,
        consultation: ct,
        when: localSlot(l.scheduled_at || visit.visit_date),
      };
    });
  return { visit, rows };
}

/** Подпись строки «из записи»: статус записи словами (переводит вызывающий через tr). */
export function bookedStatusLabel(status) {
  return status === 'confirmed' ? 'Подтверждён' : 'Записан';
}
```
(`visits` filters `patient_id`, `status`, `visit_date`, `sync_origin` and the `visit_services` embeds `services`, `consultation_types` are in `server/db/schema-registry.js` (:306, :396-399); the client query builder supports `in/is/gte/lt` (`public/js/db-client.js:10`). The two Cyrillic literals are existing dictionary keys «Записан», «Подтверждён».)

- [ ] **Step 3: `registerWalkIn` registers booked rows** — `public/js/admin/views/walk-in-booking.js`:

(a) header doc :44 — replace ` * lines: [{ service: {id, price, requires_doctor, name}, doctorId: number|null }]` with
```js
 * lines: [{ service: {id, price, requires_doctor, name}, doctorId: number|null,
 *           bookedVsId?: number, bookedUnitPrice?: number }]
 *   CRM_LINK_ALL_V1 (R7a) — bookedVsId: строка «из записи» — она УЖЕ в визите дня
 *   (views/booked-rows.js): её не вставляют второй раз, в счёт идёт она сама.
 * dropVsIds: [visit_service_id] — строки записи, которые регистратор убрал: они
 *   снимаются с визита (booking_line_remove, как в календаре) ДО визита; снятая
 *   удаляется из массива — повтор нажатия её не снимает второй раз.
 * bookedVisitId: визит записи, которому принадлежат bookedVsId.
```
(b) :185 — the signature becomes
```js
export async function registerWalkIn({ patientId, lines, dropVsIds = [], bookedVisitId = null, referralSourceId = null, createdBy = null, actorRole = null, now = () => new Date() } = {}) {
```
(c) after :194-195 (`    const noBed = await surgeryBedRefusal(pid, items.map((l) => l.service));` / `    if (noBed) throw new Error(noBed);`) insert
```js

    // CRM_LINK_ALL_V1 (R7a) — строки записи, которые регистратор убрал, снимаются
    // с визита до всего остального — той же дверью, что в календаре
    // (booking_line_remove: только «в смете», без счёта и работы).
    const drops = Array.isArray(dropVsIds) ? dropVsIds : [];
    for (const id of drops.slice()) {
        if (!isPosInt(id)) continue;
        const { error } = await supabase.rpc('booking_line_remove', { visit_service_id: Number(id) });
        if (error) throw new Error(trf('Услугу из записи снять не удалось: {msg}', { msg: msgOf(error) }));
        drops.splice(drops.indexOf(id), 1);
    }
```
(d) after :234-235 (`    const answer = readEnsureVisit(ev);` / `    if (answer.busy) throw new Error(answer.text);`) insert
```js
    // CRM_LINK_ALL_V1 (R7a) — строки «из записи» принадлежат визиту записи; визит дня
    // у пациента один (ensure_visit), иначе это уже не та запись.
    if (items.some((l) => isPosInt(l.bookedVsId)) && isPosInt(bookedVisitId) && Number(bookedVisitId) !== Number(visit.id)) {
        throw new Error(tr('Запись пациента на сегодня — другой визит. Откройте визит из календаря.'));
    }
```
(e) :240 — replace the `serviceIds` line with
```js
    // CRM_LINK_ALL_V1 (R7a) — строки «из записи» уже в визите со своей ценой: тариф не спрашивают.
    const serviceIds = [...new Set(items.filter((l) => !isConsultPick(l.service) && !isPosInt(l.bookedVsId)).map((l) => Number(l.service.id)))];
```
(f) in the line loop, right after `        const ident = lineIdentity(svc);` (:262) insert
```js
        // CRM_LINK_ALL_V1 (R7a) — строка «из записи»: второй строки нет, в счёт идёт она.
        if (isPosInt(line.bookedVsId)) {
            const bookedId = Number(line.bookedVsId);
            const unit = Number(line.bookedUnitPrice);
            vsIds.push(bookedId);
            saved.push({ visitServiceId: bookedId, serviceId: ident.service_id, consultationTypeId: ident.consultation_type_id,
                doctorId: lineDoctorOf(line), unitPrice: Number.isFinite(unit) ? unit : (Number(svc.price) || 0), tier: null });
            continue;
        }
```
(`saved` keeps the order of `vsIds`, so the invoice items still line up with the table rows — `fast-registration.js` `savedLine`.)

Run the Step 1 command → `ℹ pass 2`.

- [ ] **Step 4: i18n** — in `public/js/admin/i18n-strings.js`, right after `export const STRINGS = {` insert
```js
  // CRM_LINK_ALL_V1 (R7a) — строки «из записи» в быстрой регистрации и мастере визита (views/booked-rows.js)
  "из записи": {"en":"from the booking","ru":"из записи","uz":"yozuvdan"},   // CRM_LINK_ALL_V1
  "По записи уже в счёте: {names}": {"en":"Already on an invoice from the booking: {names}","ru":"По записи уже в счёте: {names}","uz":"Yozuv bo‘yicha allaqachon hisobda: {names}"},   // CRM_LINK_ALL_V1
  "Услугу из записи снять не удалось: {msg}": {"en":"Could not remove the booked service: {msg}","ru":"Услугу из записи снять не удалось: {msg}","uz":"Yozuvdagi xizmatni olib tashlab bo‘lmadi: {msg}"},   // CRM_LINK_ALL_V1
  "Запись пациента на сегодня не загрузилась: {msg}": {"en":"The patient’s booking for today did not load: {msg}","ru":"Запись пациента на сегодня не загрузилась: {msg}","uz":"Bemorning bugungi yozuvi yuklanmadi: {msg}"},   // CRM_LINK_ALL_V1
  "Врач записи — чтобы сменить, уберите строку и добавьте услугу заново": {"en":"The booking’s doctor — to change it, remove the row and add the service again","ru":"Врач записи — чтобы сменить, уберите строку и добавьте услугу заново","uz":"Yozuv shifokori — o‘zgartirish uchun qatorni olib tashlang va xizmatni qayta qo‘shing"},   // CRM_LINK_ALL_V1
  "Запись пациента на сегодня — другой визит. Откройте визит из календаря.": {"en":"The patient’s booking for today is a different visit. Open the visit from the calendar.","ru":"Запись пациента на сегодня — другой визит. Откройте визит из календаря.","uz":"Bemorning bugungi yozuvi — boshqa tashrif. Tashrifni kalendardan oching."},   // CRM_LINK_ALL_V1
  "Из записи на сегодня: {names}": {"en":"From today’s booking: {names}","ru":"Из записи на сегодня: {names}","uz":"Bugungi yozuvdan: {names}"},   // CRM_LINK_ALL_V1
```
(uz/en values contain no Cyrillic; every `{hole}` is kept — `i18n-coverage.test.mjs` checks both.)

- [ ] **Step 5: Write the failing fast-registration tests** — `public/js/admin/__tests__/fast-registration.test.mjs`:

(a) harness — after `let crmLines = [];` add
```js
// CRM_LINK_ALL_V1 (R7a) — запись пациента на сегодня: чем отвечают выборки visits и visit_services.
let visitRows = [];
let vsRows = [];
```
in the select mapping after `      : table === 'crm_request_services' ? crmLines` add
```js
      : table === 'visits' ? visitRows
      : table === 'visit_services' ? vsRows
```
and in `reset()` after `  crmRequests = []; crmLines = [];` add `  visitRows = []; vsRows = [];`.

(b) append the tests:
```js

// ===========================================================================
// CRM_LINK_ALL_V1 (R7a; дефект G7) — СТРОКИ «ИЗ ЗАПИСИ». У найденного пациента
// запись на сегодня: её строки встают в таблицу сами, с подписью и статусом
// записи; сохранение не вставляет их второй раз, счёт — на строки записи;
// убранная строка записи снимается с визита до визита; строка, уже стоящая в
// счёте, — только подписью под таблицей.
// ===========================================================================
const KARIMOVA = { id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза', middle_name: '', phone: '+998901112233', date_of_birth: '1990-04-01' };
const todayAt = (hh) => { const d = new Date(); d.setHours(hh, 0, 0, 0); return d.toISOString(); };
async function pickKarimova(dlg) {
  dlg.searchInput.value = 'Кари';
  dlg.searchInput.fireInput();
  await tick(600);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  await tick(80);
}

test('CRM_LINK_ALL_V1 R7a: запись на сегодня — строка «из записи» в таблице; сохранение не вставляет её второй раз, счёт — на строку записи', async () => {
  reset();
  patientRows = [KARIMOVA];
  visitRows = [{ id: 77, status: 'scheduled', visit_date: todayAt(23) }];
  vsRows = [{ id: 555, service_id: 1, consultation_type_id: null, doctor_id: 7, quantity: 1, unit_price: 112000, status: 'added', invoice_item_id: null, clinic_item_id: null, scheduled_at: null, services: { id: 1, name: 'Приём терапевта', price: 112000 } }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  await pickKarimova(dlg);
  assert.equal(rowsOf(dlg).filter((r) => textOf(r).includes('Приём терапевта')).length, 1, 'строка записи не встала в таблицу');
  assert.ok(textOf(dlg.table).includes('из записи') && textOf(dlg.table).includes('Записан'), 'нет подписи «из записи · Записан»');
  calls.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(120);
  assert.equal(calls.filter((c) => c.kind === 'insert' && c.table === 'visit_services').length, 0, 'строка записи вставлена второй раз');
  const inv = calls.find((c) => c.kind === 'rpc' && c.name === 'create_invoice_for_visit');
  assert.ok(inv, 'счёт не выставлен');
  assert.deepEqual(inv.body.visit_service_ids, [555], 'счёт не на строку записи');
  dlg.close();
});

test('CRM_LINK_ALL_V1 R7a: убранная строка записи снимается с визита (booking_line_remove) ДО визита; новая строка вставляется', async () => {
  reset();
  patientRows = [KARIMOVA];
  visitRows = [{ id: 77, status: 'confirmed', visit_date: todayAt(23) }];
  vsRows = [{ id: 555, service_id: 1, consultation_type_id: null, doctor_id: 7, quantity: 1, unit_price: 112000, status: 'added', invoice_item_id: null, clinic_item_id: null, scheduled_at: null, services: { id: 1, name: 'Приём терапевта', price: 112000 } }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  await pickKarimova(dlg);
  assert.ok(textOf(dlg.table).includes('Подтверждён'), 'статус записи не показан');
  dlg.state.removeLine(0);
  dlg.state.addLine(SERVICES[1], null);
  calls.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(120);
  const names = calls.filter((c) => c.kind === 'rpc').map((c) => c.name);
  assert.ok(names.indexOf('booking_line_remove') >= 0 && names.indexOf('booking_line_remove') < names.indexOf('ensure_visit'),
    'строка записи не снята до визита: ' + names.join(', '));
  assert.deepEqual(calls.find((c) => c.name === 'booking_line_remove').body, { visit_service_id: 555 });
  const ins = calls.filter((c) => c.kind === 'insert' && c.table === 'visit_services');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].body.service_id, 2);
  dlg.close();
});

test('CRM_LINK_ALL_V1 R7a: строка записи уже в счёте — в таблице её нет, подпись под таблицей её называет', async () => {
  reset();
  patientRows = [KARIMOVA];
  visitRows = [{ id: 77, status: 'scheduled', visit_date: todayAt(23) }];
  vsRows = [{ id: 556, service_id: 2, consultation_type_id: null, doctor_id: null, quantity: 1, unit_price: 40000, status: 'added', invoice_item_id: 9, clinic_item_id: null, scheduled_at: null, services: { id: 2, name: 'Общий анализ крови', price: 40000 } }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  await pickKarimova(dlg);
  assert.equal(dlg.state.rows.length, 0, 'строка в счёте встала в таблицу — её выставили бы второй раз');
  const note = walk(dlg.card).find((n) => n.attrs && n.attrs['data-booked-billed'] !== undefined);
  assert.ok(note && note.textContent.includes('Общий анализ крови'), 'подписи о строке в счёте нет');
  dlg.close();
});

test('CRM_LINK_ALL_V1 R7a: «Сменить» убирает строки записи прежнего пациента', async () => {
  reset();
  patientRows = [KARIMOVA];
  visitRows = [{ id: 77, status: 'scheduled', visit_date: todayAt(23) }];
  vsRows = [{ id: 555, service_id: 1, consultation_type_id: null, doctor_id: 7, quantity: 1, unit_price: 112000, status: 'added', invoice_item_id: null, clinic_item_id: null, scheduled_at: null, services: { id: 1, name: 'Приём терапевта', price: 112000 } }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  await pickKarimova(dlg);
  assert.equal(dlg.state.rows.length, 1);
  btnByText(dlg.card, 'Сменить').click();
  await tick(20);
  assert.equal(dlg.state.rows.length, 0, 'строки записи прежнего пациента остались');
  assert.deepEqual(dlg.state.dropBooked, []);
  dlg.close();
});
```
(The fake `ensure_visit` answers `{ visit: { id: 77 } }`, the same id as the booked visit, so the «другой визит» check passes.)

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test --test-name-pattern="CRM_LINK_ALL_V1" public/js/admin/__tests__/fast-registration.test.mjs 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: all four FAIL (no booked rows are loaded yet).

- [ ] **Step 6: Fast registration shows and registers booked rows** — `public/js/admin/views/fast-registration.js`:

(a) after :73 `import { registerWalkIn, walkInRoleRefusal, walkInLinesRefusal } from './walk-in-booking.js?v=wib1';` add
```js
import { loadTodayBooking, bookedStatusLabel } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»
```
(b) state (:189-192) — replace
```js
        stalled: false,
        addLine, applyTemplate, removeLine,
```
with
```js
        stalled: false,
        // CRM_LINK_ALL_V1 (R7a) — запись пациента на сегодня: визит записи и строки,
        // которые регистратор убрал (снимутся с визита при сохранении).
        bookedVisitId: null,
        dropBooked: [],
        addLine, applyTemplate, removeLine,
```
(c) before :295 `    const discountLine = h('div', {` insert
```js
    // CRM_LINK_ALL_V1 (R7a) — строки записи, уже стоящие в счёте: в таблице их нет
    // (выставлять их второй раз нельзя), но регистратор должен их видеть.
    const bookedNote = h('div', {
        class: 'muted', 'data-booked-billed': '',
        style: { display: 'none', padding: '8px 14px 0', fontSize: '12.5px', overflowWrap: 'anywhere' },
    });
```
and :307 `        table, discountLine);` → `        table, bookedNote, discountLine);`
(d) `rowPrice` — after :404 `        if (line && Number.isFinite(Number(line.unitPrice))) return Number(line.unitPrice);` add
```js
        // CRM_LINK_ALL_V1 (R7a) — строка «из записи»: её цена уже в визите.
        if (row && row.booked && Number.isFinite(Number(row.booked.unitPrice))) return Number(row.booked.unitPrice);
```
(e) `doctorCell` — after :466 `        if (state.result) sel.disabled = true;` add
```js
        // CRM_LINK_ALL_V1 (R7a) — врач строки «из записи» — врач записи: строка уже в визите.
        if (row.booked) { sel.disabled = true; sel.title = tr('Врач записи — чтобы сменить, уберите строку и добавьте услугу заново'); }
```
(f) name cell — replace :514 `                h('td', { class: 'cell-strong' }, row.service.name || '—',` with
```js
                h('td', { class: 'cell-strong' }, row.service.name || '—',
                    // CRM_LINK_ALL_V1 (R7a) — строка уже в визите записи: подпись и статус записи.
                    row.booked ? h('div', { 'data-booked-row': String(row.booked.vsId), class: 'muted', style: { fontWeight: '400', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' } },
                        Icon('Calendar', { size: 12 }), tr('из записи') + ' · ' + tr(bookedStatusLabel(row.booked.status))) : null,
```
(g) `removeLine` (:570) — replace
```js
    function removeLine(i) {
        state.rows.splice(i, 1);
```
with
```js
    function removeLine(i) {
        // CRM_LINK_ALL_V1 (R7a) — строка «из записи» снимется с визита при сохранении.
        const gone = state.rows[i];
        if (gone && gone.booked) state.dropBooked.push(gone.booked.vsId);
        state.rows.splice(i, 1);
```
(h) `usePatient` (:636) — replace
```js
    async function usePatient(p, { load = false } = {}) {
        if (!p) {
```
with
```js
    /** CRM_LINK_ALL_V1 (R7a) — убрать строки «из записи» прежнего пациента. */
    function clearBookedRows() {
        state.rows = state.rows.filter((r) => !r.booked);
        state.dropBooked = [];
        state.bookedVisitId = null;
        bookedNote.textContent = '';
        bookedNote.style.display = 'none';
        paintTable();
    }

    /**
     * CRM_LINK_ALL_V1 (R7a; дефект G7) — ЗАПИСЬ НА СЕГОДНЯ — ГОТОВЫЕ СТРОКИ. Визит
     * дня пациента уже держит строки записи: они встают в таблицу «из записи», и
     * сохранение регистрирует ИХ (второй строки нет, счёт — на них). Строки, уже
     * стоящие в счёте, — только подписью под таблицей.
     */
    async function showBookedRows(patientId) {
        let b;
        try { b = await loadTodayBooking(patientId); }
        catch (e) {
            toast(trf('Запись пациента на сегодня не загрузилась: {msg}', { msg: (e && e.message) || e }), 'warn');
            return;
        }
        if (!b || !b.visit || !state.patient || state.patient.id !== patientId) return;
        state.bookedVisitId = b.visit.id;
        for (const r of b.rows) {
            if (r.billed) continue;
            const service = r.consultationTypeId != null
                ? { id: 'c|' + (r.doctorId || '') + '|' + r.consultationTypeId, __consult: true, consultation_type_id: r.consultationTypeId,
                    __consultDoctorId: r.doctorId, name: r.name, price: r.unitPrice, requires_doctor: 1 }
                : ((state.catalog || []).find((s) => Number(s.id) === r.serviceId) || r.service);
            if (!service) continue;
            const row = addLine(service, r.doctorId ? { id: r.doctorId } : null);
            if (row) row.booked = { vsId: r.vsId, status: b.visit.status, unitPrice: r.unitPrice };
        }
        const billed = b.rows.filter((r) => r.billed).map((r) => r.name).filter(Boolean);
        if (billed.length) {
            bookedNote.textContent = trf('По записи уже в счёте: {names}', { names: billed.join(', ') });
            bookedNote.style.display = '';
        }
        paintTable();
    }

    async function usePatient(p, { load = false } = {}) {
        clearBookedRows();   // CRM_LINK_ALL_V1 (R7a)
        if (!p) {
```
and at the end of `usePatient` (:651-652) replace
```js
        setPatientFormEnabled(false);
        return chosen;
```
with
```js
        setPatientFormEnabled(false);
        await showBookedRows(chosen.id);   // CRM_LINK_ALL_V1 (R7a)
        return chosen;
```
(i) `bookServices` (:788) — replace
```js
                lines: state.rows.map((r) => ({ service: r.service, doctorId: r.doctorId, packageId: r.package ? r.package.id : null })),
```
with
```js
                // CRM_LINK_ALL_V1 (R7a) — строки «из записи» регистрируются как есть, убранные снимаются.
                lines: state.rows.map((r) => ({ service: r.service, doctorId: r.doctorId, packageId: r.package ? r.package.id : null,
                    bookedVsId: r.booked ? r.booked.vsId : null, bookedUnitPrice: r.booked ? r.booked.unitPrice : null })),
                dropVsIds: state.dropBooked,
                bookedVisitId: state.bookedVisitId,
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 0` (fast registration 32 tests, verified on the prototype).

- [ ] **Step 7: Write the failing wizard test** — append to `public/js/admin/__tests__/wizard-booking.test.mjs`:

```js

// ═══════════════════════════════════════════════════════════════════════════
// CRM_LINK_ALL_V1 (R7a; дефект G7) — МАСТЕР: СТРОКИ «ИЗ ЗАПИСИ». У пациента
// запись на сегодня — её строка встаёт в смету сама, с подписью; мастер не
// вставляет её второй раз и слот записи заново не занимает (book: не уходит).
// ═══════════════════════════════════════════════════════════════════════════
test('CRM_LINK_ALL_V1 R7a: мастер — строка записи на сегодня «из записи»: второй строки нет, слот записи не перезаписывается', async () => {
  const { isDeskNow } = await import('../views/wizard-desk.js');
  seed({});
  DB.prepare('UPDATE services SET requires_doctor = 1 WHERE id = 21').run();
  const slot = new Date(); slot.setHours(23, 0, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status, created_by) VALUES (3, 7, ?, 30, 'scheduled', 1)").run(slot.toISOString()).lastInsertRowid);
  const vs = Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, price_tier, created_by) VALUES (?, 21, 7, 1, 100000, 100000, 'added', 'primary', 1)").run(vid).lastInsertRowid);
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, {});
  await flush(30);
  const ov = document.body.children.find(isWizard);
  assert.ok(ov && walk(ov).some((n) => n.attrs && n.attrs['data-booked-line'] === String(vs)), 'строка записи не встала в смету «из записи»: ' + JSON.stringify(TOASTS));
  await pressUntilCreate();
  const ev = RPC.find((c) => c.name === 'ensure_visit');
  assert.ok(ev, 'мастер не дошёл до ensure_visit: ' + JSON.stringify(TOASTS));
  assert.ok(!ev.body.book, 'мастер заново занимает слот записи');
  const today = isoOf(new Date());
  assert.equal(ev.body.desk === true, isDeskNow({ dayIso: today, todayIso: today, headStartMs: slot.getTime(), nowMs: Date.now() }), 'desk не по правилу «сейчас» для слота записи');
  assert.deepEqual(DB.prepare('SELECT id FROM visit_services WHERE visit_id = ? ORDER BY id').all(vid).map((r) => r.id), [vs], 'строка записи вставлена второй раз');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits WHERE patient_id = 3').get().n, 1, 'второй визит на день');
});
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test --test-name-pattern="R7a" public/js/admin/__tests__/wizard-booking.test.mjs 2>&1 | grep -E "^(✔|✖)|^ℹ (pass|fail)"`
Expected: FAIL («строка записи не встала в смету»).

- [ ] **Step 8: The wizard registers booked lines** — `public/js/admin/views/visit-wizard.js` (line numbers are HEAD's; Task 5 added 1 line after :53 and 8 lines after :2694 — find each spot by the quoted text):

(a) after the Task 5 import `import { isDeskNow } from './wizard-desk.js';   // CRM_LINK_ALL_V1 (R3) — «сейчас» у стойки: одно правило с сервером` add
```js
import { loadTodayBooking, bookedStatusLabel } from './booked-rows.js';   // CRM_LINK_ALL_V1 (R7a) — строки «из записи»
```
(b) in `const wiz = {`, replace `        cart: [],            // [{ svc, qty }]` with
```js
        cart: [],            // [{ svc, qty }]
        dropBooked: [],      // CRM_LINK_ALL_V1 (R7a) — visit_service_id строк «из записи», которые убрали
```
(c) replace `    await prefillFromCrm();` (the call after the preset block, :752) with
```js
    await prefillFromBooking();   // CRM_LINK_ALL_V1 (R7a) — сначала то, что уже в визите записи
    await prefillFromCrm();
```
(d) right before `    async function prefillFromCrm() {` (:760) insert
```js
    // CRM_LINK_ALL_V1 (R7a; дефект G7) — ЗАПИСЬ НА СЕГОДНЯ — ГОТОВЫЕ СТРОКИ. Визит
    // дня пациента уже держит строки записи (календарь, колл-центр, карточка CRM):
    // они встают в смету «из записи», и мастер регистрирует ИХ — второй строки той
    // же услуги не вставляет (createVisit). Только сегодня и только услуги
    // каталога; консультация по виду приёма остаётся в визите и ждёт кассу.
    async function prefillFromBooking() {
        const dayIso = String(wiz.when || '').slice(0, 10);
        if (!patient.id || dayIso !== isoDay(Date.now())) return;
        let b;
        try { b = await loadTodayBooking(patient.id); }
        catch (e) {
            toast(trf('Запись пациента на сегодня не загрузилась: {msg}', { msg: (e && e.message) || e }), 'warn');
            return;
        }
        if (!b || !b.visit) return;
        const names = [];
        for (const r of b.rows) {
            if (r.billed || r.serviceId == null) continue;
            const svc = wiz.services.find(sv => Number(sv.id) === r.serviceId);
            if (!svc || wiz.cart.some(c => String(c.svc.id) === String(svc.id))) continue;
            const d0 = new Date(); d0.setHours(0, 0, 0, 0);
            const line = { svc, qty: r.quantity || 1, doctorId: r.doctorId, when: r.when, ui: { day: d0.getTime(), pickDoc: false },
                booked: { vsId: r.vsId, visitId: b.visit.id, status: b.visit.status, when: r.when } };
            if (!svc.requires_doctor) { line.dateOnly = true; line.when = isoDay(d0.getTime()) + 'T00:00'; line.booked.when = line.when; }
            wiz.cart.push(line);
            names.push(svc.name);
        }
        if (!names.length) return;
        refreshTiers();
        paint();
        toast(trf('Из записи на сегодня: {names}', { names: names.join(', ') }), 'ok');
    }

    /** CRM_LINK_ALL_V1 (R7a) — убрать строку сметы; строка «из записи» снимется с визита при записи. */
    function removeCartLine(c) {
        if (c && c.booked) wiz.dropBooked.push(c.booked.vsId);
        wiz.cart = wiz.cart.filter(x => x !== c);
    }

```
(the cart line is built directly, not with `addToCart`: `addToCart` auto-picks a doctor and a free slot asynchronously and would overwrite the booking's doctor and time).

(e) catalog «убрать» (:1021) — replace
```js
                            onclick: () => { wiz.cart = wiz.cart.filter(x => x !== inCart); repaintRail(); repaintCatalog(); },
```
with
```js
                            onclick: () => { removeCartLine(inCart); repaintRail(); repaintCatalog(); },   // CRM_LINK_ALL_V1 (R7a)
```
(f) estimate rail line (:2133-2134) — replace
```js
                    h('span', { style: { flex: 1, minWidth: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.svc.name),
                    ...(isMultiQty(c.svc) ? [
```
with
```js
                    h('span', { style: { flex: 1, minWidth: 0, fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.svc.name),
                    // CRM_LINK_ALL_V1 (R7a) — строка уже в визите записи: подпись и статус записи.
                    c.booked ? h('span', { 'data-booked-line': String(c.booked.vsId), style: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12.5px', fontWeight: 700, color: 'var(--primary-700)', background: 'var(--primary-50, #e8f3f2)', borderRadius: '999px', padding: '1px 7px', whiteSpace: 'nowrap' } },
                        Icon('Calendar', { size: 12 }), tr('из записи') + ' · ' + tr(bookedStatusLabel(c.booked.status))) : null,
                    ...(isMultiQty(c.svc) && !c.booked ? [
```
and the rail «✕» (:2143) — replace
```js
                        onclick: () => { wiz.cart = wiz.cart.filter(x => x !== c); repaintRail(); if (wiz.step === 1) paint(); },
```
with
```js
                        onclick: () => { removeCartLine(c); repaintRail(); if (wiz.step === 1) paint(); },   // CRM_LINK_ALL_V1 (R7a)
```
(g) before `    /** Строка дня, которая ЗАНИМАЕТ ВРЕМЯ ВРАЧА: с врачом, со слотом, не живая очередь. */` (:1356) insert
```js
    /** CRM_LINK_ALL_V1 (R7a) — строка «из записи» с прежним временем: её слот уже занят записью. */
    function bookedKeepsSlot(c) {
        return !!(c && c.booked && c.when === c.booked.when);
    }

```
(h) `gateDaySlots` (:1380) — replace `            const head = headTimedLine(lines);` with
```js
            const head = headTimedLine(lines.filter(c => !bookedKeepsSlot(c)));   // CRM_LINK_ALL_V1 (R7a) — слот записи уже её
```
(i) `createVisit` — right after `            if (noBed) { toast(noBed, 'fail'); wiz.creating = false; repaintRail(); return; }` (:2614) insert
```js
            // CRM_LINK_ALL_V1 (R7a) — убранные строки записи снимаются с визита, как в
            // календаре (booking_line_remove), до первой записи мастера.
            for (const id of wiz.dropBooked.slice()) {
                const { error: dropErr } = await supabase.rpc('booking_line_remove', { visit_service_id: Number(id) });
                if (dropErr) { toast(trf('Услугу из записи снять не удалось: {msg}', { msg: dropErr.message || dropErr }), 'fail'); wiz.creating = false; repaintRail(); return; }
                wiz.dropBooked.splice(wiz.dropBooked.indexOf(id), 1);
            }
```
replace
```js
                const timedHead = headTimedLine(lines);
                const emgReason = emergencyByDay.get(day) || null;
```
with
```js
                // CRM_LINK_ALL_V1 (R7a) — строка «из записи» с прежним временем слот не
                // занимает заново (он уже её); «сейчас» ли это — решает и её время.
                const timedHead = headTimedLine(lines.filter(c => !bookedKeepsSlot(c)));
                const bookedHead = headTimedLine(lines.filter(c => bookedKeepsSlot(c)));
                const emgReason = emergencyByDay.get(day) || null;
```
replace the Task 5 condition line
```js
                if (isDeskNow({ dayIso: day, todayIso: isoDay(Date.now()), headStartMs: timedHead ? new Date(timedHead.when).getTime() : null, nowMs: Date.now() })) {
```
with
```js
                const deskHead = timedHead || bookedHead;   // CRM_LINK_ALL_V1 (R7a)
                if (isDeskNow({ dayIso: day, todayIso: isoDay(Date.now()), headStartMs: deskHead ? new Date(deskHead.when).getTime() : null, nowMs: Date.now() })) {
```
and in the line loop replace
```js
                const vsIds = [];
                const coveredVsIds = [];   // COVERAGE_SPLIT_V1 — строки за счёт контрагента
                for (const c of lines) {
                    const row = {
```
with
```js
                const vsIds = [];
                const coveredVsIds = [];   // COVERAGE_SPLIT_V1 — строки за счёт контрагента
                for (const c of lines) {
                    // CRM_LINK_ALL_V1 (R7a) — строка «из записи» уже в этом визите: второй не вставляем.
                    if (c.booked && Number(c.booked.visitId) === Number(visit.id)) {
                        const bid = Number(c.booked.vsId);
                        vsIds.push(bid);
                        visitsWithLines.add(visit.id);
                        lineByVsId.set(bid, c);
                        const bDoc0 = c.doctorId ? wiz.doctors.find(x => String(x.id) === String(c.doctorId)) : null;
                        booked.push({
                            visit_service_id: bid,
                            visit,
                            service: { id: c.svc.id, name: c.svc.name, room_id: c.svc.room_id ?? null, department_id: c.svc.department_id ?? null },
                            doctor: c.doctorId ? { id: Number(c.doctorId), name: (bDoc0 && (bDoc0.full_name || bDoc0.username)) || '' } : null,
                            price: cartLinePrice(c),
                            scheduled_at: c.when ? new Date(c.when).toISOString() : null,
                        });
                        if (isCovered(c)) coveredVsIds.push(bid);
                        continue;
                    }
                    const row = {
```
(A booked line of another visit — impossible by I6 — falls through to a normal insert, which R7b then guards.)

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs public/js/admin/__tests__/wizard-desk.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/crm-i18n-leaks-en.test.mjs public/js/admin/__tests__/crm-i18n-leaks-uz.test.mjs public/js/admin/__tests__/crm-lines.test.mjs public/js/admin/__tests__/wizard-templates.test.mjs 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"`
Expected: `ℹ tests 123`, `ℹ pass 123`, `ℹ fail 0`. The same three registration files with the en-US preload (`--import …force-en.mjs`): `ℹ tests 89`, `ℹ pass 89`, `ℹ fail 0` (both verified on the prototype).

- [ ] **Step 9: The matrix replays the NEW screens** — append to `tests/crm-doors/scenarios-link-all.mjs`, before `export { SCENARIOS };` (and extend its import list with `TODAY_SLOT, calendarPickerBook, invoiceAndPay`):

```js
// ─── Task 7 — R7a: the screens register the booked row instead of inserting a second one ───
const ok = (r, what) => { if (r.status !== 200) throw new Error(what + ': ' + r.text); return r.json.data; };
const bookedLine = (t, vid) => t.db.prepare("SELECT id FROM visit_services WHERE visit_id = ? AND status = 'added' ORDER BY id").get(vid).id;
async function S2Tcal(t) {
  const rid = seedS1(t);
  const { vid } = await calendarPickerBook(t, 'cc', TODAY, { hour: 23 });
  return { rid, bid: vid };
}
add('7-fast-S2Tcal-r7a', 7, 'S2Tcal', 'reg', 'call centre booked TODAY in the calendar; NEW fast registration registers the «из записи» row (no insert, invoice on the booked line)', async (t) => {
  const s = await S2Tcal(t);
  const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: nowIso(), doctor_id: 10, visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null, desk: true }), 'ensure_visit desk');
  ok(await t.rpc('create_invoice_for_visit', 'reg', { visit_id: ev.visit.id, visit_service_ids: [bookedLine(t, s.bid)], discount_amount: 0, payer_id: null }), 'invoice');
  return { ...s, vid: ev.visit.id };
});
add('7-fast-S2Tcal-r7a-drop', 7, 'S2Tcal', 'reg', 'NEW fast registration: the registrar removes the booked row (booking_line_remove before ensure_visit) and registers a blood test instead', async (t) => {
  const s = await S2Tcal(t);
  ok(await t.rpc('booking_line_remove', 'reg', { visit_service_id: bookedLine(t, s.bid) }), 'booking_line_remove');
  const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: nowIso(), doctor_id: null, visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null, desk: true }), 'ensure_visit desk');
  const r = await t.dbq('reg', { table: 'visit_services', op: 'insert', returning: true, single: 'single',
    values: { visit_id: ev.visit.id, service_id: 40, quantity: 1, unit_price: 40000, total: 40000, price_tier: 'primary', status: 'added' } });
  if (r.status !== 200) throw new Error(r.text);
  ok(await t.rpc('create_invoice_for_visit', 'reg', { visit_id: ev.visit.id, visit_service_ids: [r.json.data.id], discount_amount: 0, payer_id: null }), 'invoice');
  return { ...s, vid: ev.visit.id };
});
add('7-wiz-S2Tcal-r7a', 7, 'S2Tcal', 'reg', 'NEW wizard at the booked slot: the «из записи» line is not inserted again; paid', async (t) => {
  const s = await S2Tcal(t);
  const ev = ok(await t.rpc('ensure_visit', 'reg', { patient_id: PID, date: TODAY_SLOT(), doctor_id: 10, visit_type: 'outpatient', referral_source_id: null, branch_id: 1, notes: null,
    book: { doctor_id: 10, service_id: 30, start: TODAY_SLOT(), duration_minutes: 30 } }), 'ensure_visit');
  await invoiceAndPay(t, 'reg', ev.visit.id, [bookedLine(t, s.bid)]);
  return { ...s, vid: ev.visit.id };
});
```
and add to `DECIDED` in `tests/crm-doors/matrix.test.mjs`:
```js
  // Task 7 — R7a (G7): the new screens' call sequences
  '7-fast-S2Tcal-r7a': { rule: 'R7a (G7)', owner: 'nodup', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
  '7-fast-S2Tcal-r7a-drop': { rule: 'R7a (G7)', owner: 'came+lines', cell: {"stage":"came","date":"T","lines":["40@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[40]} },
  '7-wiz-S2Tcal-r7a': { rule: 'R7a (G7)', owner: 'nodup', cell: {"stage":"came","date":"T","lines":["30@T:done/V"],"link":"card","cards":1,"visits":1,"vs":[30]} },
```

Run: `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8`
Expected: `ℹ tests 110`, `ℹ pass 110`, `ℹ fail 0`, `ℹ todo 0`.

- [ ] **Step 10: Look at it** — this task changes screens: open the test clinic (:8712 per the owner's workflow — only if the controller runs it; never touch `easymed.local`) or at least render the fast-registration dialog at 360 px width in a browser and check: the chip wraps under the name, the locked doctor select shows its title, the «уже в счёте» line wraps (`overflowWrap: 'anywhere'`), no emoji, icons via `Icon()`.

- [ ] **Step 11: Re-check (try to break it)** — a patient with TWO bookings today is impossible (I6), but a booked visit of another building must not show (`.is('sync_origin', null)`); a billed booked line must never reach `create_invoice_for_visit` (test 3); a drop that fails (billed in between) stops the save before `ensure_visit` with the server's words.

- [ ] **Step 12: Commit**

```bash
git diff --cached --name-only   # must print nothing
git add public/js/admin/views/booked-rows.js public/js/admin/views/walk-in-booking.js public/js/admin/views/fast-registration.js public/js/admin/views/visit-wizard.js public/js/admin/i18n-strings.js public/js/admin/__tests__/walk-in-booking.test.mjs public/js/admin/__tests__/fast-registration.test.mjs public/js/admin/__tests__/wizard-booking.test.mjs tests/crm-doors/scenarios-link-all.mjs tests/crm-doors/matrix.test.mjs
cat > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t7.txt <<'EOF'
CRM: быстрая регистрация и мастер визита показывают услуги сегодняшней записи строками «из записи» (статус записи) и регистрируют их — второй строки нет, счёт на строку записи; убранная строка снимается с визита, как в календаре (дефект G7; CRM_LINK_ALL_V1 R7a)

Новый views/booked-rows.js — одно чтение на оба окна; строки, уже стоящие в счёте, — подписью под таблицей. Новые тексты — ru/uz/en. Матрица дверей: 3 сценария новых окон.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
git commit -F /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-t7.txt
```

---

## Task 8: Full-suite verification (ru + en-US), marker sweep, adversarial re-check

**Files:** none (fixes found here are committed separately, each with its own re-check).

- [ ] **Step 1: Marker and line-ending sweep**

```bash
cd "/c/Users/user/Desktop/implementation workflow/easymed.crm"
for f in $(git diff --name-only d630e34e -- server public tests); do grep -q "CRM_LINK_ALL_V1" "$f" || echo "no marker: $f"; done
for f in $(git diff --name-only d630e34e); do [ -f "$f" ] && [ "$(tr -cd '\r' < "$f" | wc -c)" != "0" ] && echo "CRLF: $f"; done
git diff d630e34e --stat -- server/services/crm/booking-mirror.js     # expect: 1 file changed, 3 insertions(+), 3 deletions(-)
```
Expected: no output from the two loops; the mirror shows only the three `export` lines.

- [ ] **Step 2: Full suite, ru** — `LIS_ENABLED=0 node --experimental-vm-modules --test > /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/crm-link-all-suite-ru.log 2>&1; tail -12 /c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/crm-link-all-suite-ru.log`
Expected: `ℹ fail` equals the environmental failures only — under `LIS_ENABLED=0` the LIS listener is off (`server/lis/index.js:297`), so the 11 tests of `server/lis/real-analyzers.e2e.test.js` fail with `connect ECONNREFUSED 127.0.0.1:55xx` (seen identically on the prototype run). List the failing files with `grep -n "^not ok\|✖" … | head` and check each one is that file; anything else is a regression of this branch and goes back to the task that owns the file.

- [ ] **Step 3: Full suite, en-US** — the same command with `--import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs` (log `crm-link-all-suite-en.log`). Expected: the same failure set as Step 2 (memory: tests green on a ru-RU box can fail on en-US because `i18n.js` reads `navigator.language` — every new UI string is in the dictionary, so none should).

- [ ] **Step 4: The acceptance test, alone** — `LIS_ENABLED=0 node --experimental-vm-modules --test tests/crm-doors/matrix.test.mjs 2>&1 | tail -8` → `ℹ tests 110`, `ℹ pass 110`, `ℹ fail 0`, `ℹ todo 0` (no «GAP:» todo left); and `server/services/crm/booking-mirror-twin.test.js` → 3 pass, 6 todo (unchanged, see Task 6).

- [ ] **Step 5: Adversarial re-check (a fresh reviewer, not the implementer)** — give the reviewer the spec, this plan and `git diff d630e34e`, and ask them to break the money/privacy invariants with new throw-away tests (not committed unless they find a bug):
  - I1/I3 — a family phone (two cards on one number, mother and son): no card line of the son ever reaches the mother's visit or bill, at any door (calendar, desk, wizard «now», cashier);
  - I2 — «Пришёл»/«Отказ» cards never change stage or get lines from another visit (R1 C′, R4, R6);
  - I4 — a prepaid booking line: R7b and R7a never delete, re-bill or re-price it;
  - I5 — a `sync_origin` visit: no link, no lines, no stage move (C′ starts after the `sync_origin` return in `crmLinkVisit`; R4, R6, R7b check it);
  - I6 — every door ends with one live visit per day (the matrix `visits` column);
  - I7 — make a CRM hook throw (e.g. `DROP TABLE crm_booking_undo` in a test DB, or a broken `crm_stages`): bookings, registrations and payments still succeed (`crm-unify-link-guards.test.js:351` pattern);
  - I8 — responses of `ensure_visit`, `calendar_book`, `booking_lines_add` never carry another operator's card;
  - twin lines (fifth round): two cards sharing one visit line + desk registration; card merge after R7b; cancel and rebook with a desk line — compare with `crm-lines-v3120-final.test.js` and the `CRM_TWIN_LINE` todos.

- [ ] **Step 6: Test clinic (owner workflow)** — only on the controller's word: run the branch against the test clinic on :8712 and click the four doors (calendar booking for another day, fast registration of a called patient, wizard «now», calendar «Подтверждён»), watching the CRM board. Never tag, never release, never push (`origin` is the local `easymed.local`).

- [ ] **Step 7: Report** — counts of Steps 2–4, the reviewer's findings and their fix commits.

---

## Self-review (spec ↔ plan)

| spec item | where |
|---|---|
| R1 (D1, G1 + G2): live card holds every booking; moved-last pick; reopen after window; link source 'patient'; mirror; G; no live card → today's behaviour; closed never | Task 1 (step C′), tests «ДРУГОЙ день», «без движения дольше окна», «две живые карточки», «закрытые», «давняя «Не пришёл»», «колл-центр» |
| R1: the card's pending lines for OTHER days stay untouched | Task 1 test 1 (`[30, D, 'pending', null]`), `crm-unify-desk.test.js:155` new expectation |
| R2 (D1 at the desk, G2): desk takes the live card of any age, reopen first, then «Пришёл»; a lineless/dateless card still closes | Task 1 tests «R2 …» (two), matrix `3b-S3-reg`, `crm-unify-desk.test.js:442` |
| R3 (D2, G5): wizard sends desk for today «now» (no slot / ≤ 30 min); later slot = booking; server checks stay | Task 5 (`wizard-desk.js`, wizard, `ensure_visit` guard), matrix `4-now-*`, `7-wiz-S2T-now`, 4 D2 cells |
| R4 (D3, G6): 'confirmed' → first active open column after booked and before won; forward only; no `updated_at` bump | Task 4 |
| R5 (D4, G3): phone card linked (source 'phone'), mirror writes the visit's services; its own lines not put into the visit | Task 2 |
| R6 (G4): services of the desk-closing visit appear as done lines on the card holding it; card stays «Пришёл»; never another card | Task 3 |
| R7a (G7): fast registration + wizard show today's booked lines «из записи» with status; register them; extras; remove = removed from the visit as the calendar does; no second line | Task 7 |
| R7b (G7): server net — a registration insert does not leave a second copy of a booked unbilled line (same service, same doctor or none); repeats (quantity) and billed/started lines untouched | Task 6 |
| Acceptance: 30 GAP todos → real tests; changed observed cells listed with their decision | Tasks 1–7 «Flip the matrix cells» (13 + 3 + 7 + 1 + 4 + 2 = 30); no observed (non-GAP) cell changes — verified on the prototype (all 26 changed cells are GAP cells) |
| Acceptance: `booking-mirror-twin.test.js` CRM_TWIN_LINE todos that R7 resolves | none resolves — Task 6 «Plan decisions» (bodiless todos about mirror-internal two-card reschedules) |
| Acceptance: full suite ru + en-US; ru/uz/en strings; type scale; `Icon()`; no emoji; 360 px | Task 8, Task 7 Step 4/10 |
| Marker CRM_LINK_ALL_V1 in code, tests, commits | every step; Task 8 Step 1 sweep |

**Existing tests this plan changes (12; all found by running the 269 door test files on the finished prototype):**

| task | file:line — test | decision |
|---|---|---|
| 1 | `server/routes/crm-unify-desk-money.test.js:395` «C4e: «Новый лид» 90 дней без строк и даты — ни регистрация без стойки, ни запись, ни оплата его не трогают» | D1 |
| 1 | `server/routes/crm-unify-desk.test.js:155` «стойка: карточку, ждущую другой день, ни врач с desk, ни регистратура без desk не двигают» | D1 |
| 1 | `server/routes/crm-unify-desk.test.js:442` «стойка: «Не пришёл» в пределах окна (пришёл на день позже) — «Пришёл»; давний «Не пришёл» — не трогается» | D1 (R2) |
| 1 | `server/routes/crm-unify-desk.test.js:527` «R7: desk — только true или "true"; день — только сегодня по местному времени» | D1 |
| 1 | `server/routes/crm-unify-final-status.test.js:150` «A-P5: пропущенный день давнее окна — поздний приход через мастер визита карточку не поднимает» | D1 |
| 1 | `server/routes/crm-unify-link-guards.test.js:276` «строка без даты не встаёт в запись календаря и booking_lines_add; ensure_visit её берёт» | D1 |
| 1 | `server/routes/crm-unify-link.test.js:78` «карточку, ждущую ДРУГОЙ день, сегодняшняя запись не двигает» | D1 |
| 1 | `server/services/crm/unify-review-t5t6.test.js:209` «W1b (I-5): давняя карточка после прохода — посторонний приход на стойку её не закрывает» | D1 (R2) |
| 1 | `server/services/crm/unify-review-t5t6.test.js:256` «I-3: «Не пришёл» за окном — запись колл-центра возвращает её в начало и записывает; давний «Не пришёл» запись регистратуры не трогает» | D1 |
| 2 | `server/routes/crm-unify-link.test.js:27` «по телефону: лид из звонка без пациента получает пациента — и только его; строки и визит не трогаются» | D4 |
| 4 | `server/services/crm/visit-status.test.js:313` «подтверждение и перенос заявку не трогают: конверсия — это приход» | D3 |
| 5 | `server/routes/crm-unify-desk.test.js:131` «стойка: колл-центру, врачу, будущему дню и записи на время desk не верят; без desk сегодня — «Записан»» | D2 |

(`crm-unify-desk.test.js` changes in three places of Task 1 and one of Task 5. Plus the frozen matrix itself, whose 30 GAP rows become real tests.)

**Kept on purpose (the prototype briefly changed them, the plan does not):** `server/routes/crm-unify-final-status.test.js:61` «P3 (A-I4): отменённая запись карточки в «Подтверждён» — дата стёрта, проход «Не пришёл» её не трогает» — R4 must not extend the cancel undo to «Подтверждён».

**Out of scope (noted, not built):** removing a visit line after R6 leaves its 'done' card line (same as today's 'done' lines); a registrar's own calendar booking + the same desk line from an OLD cached screen stays a twin (R7a closes it on the current screens); a consultation-by-type booked line is not shown in the wizard cart (it stays in the visit for the cashier); the six `CRM_TWIN_LINE` mirror todos.

**Controller decisions needed:** none — every open detail of the spec was settled from the code (see «Plan decisions» in Tasks 1–7). One deviation from the spec's literal wording to glance at: R7b «the insert reuses the existing line» is built as «the booked line yields to the inserted line» (Task 6) — same outcome (one row, booked service once in the bill), because the screens already hold the inserted row's id for the invoice.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-10-16-crm-link-all.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task (superpowers:subagent-driven-development), a review between tasks; each task's «Re-check» step is that review's checklist.
2. **Inline Execution** — superpowers:executing-plans, batch execution with checkpoints after Tasks 1, 3, 6 and 7.

Every task leaves the suite green (verified state by state on a toggled prototype: after Task 1 the matrix is 83 pass / 17 todo, after 2 → 86/14, after 3 → 93/7, after 4 → 94/6, after 5 → 105/2 of 107, after 6 → 107/0, after 7 → 110/0).
