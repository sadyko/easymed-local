# Statistics (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each clinic's daily check-in carries a small set of numbers — errors, crashes, revenue volume — chosen by the vendor from the panel, changeable without shipping a release, and structurally incapable of carrying patient data.

**Architecture:** The clinic app compiles in a catalogue of named counters, each a pure function `db → number`. The check-in response names which counters to collect (the `collect` field, already returned by the control plane as a deliberate placeholder); the next check-in request carries `{ stats: { name: number } }`, which rides the existing `checkins.payload` column. The panel picks the set per clinic and shows the latest values.

**Tech Stack:** Nothing new. Node 24 ESM, better-sqlite3, `node:test`.

**Spec:** `docs/specs/2026-08-20-control-plane-design.md` §6. The owner chose **errors/crashes and revenue volume** as the starting set, said more will follow, and gave one absolute instruction: **no patient personal data ever leaves the clinic.**

---

## The two rules that outrank every feature here

1. **The panel can never send a query.** It can only name counters that already exist in the app. A compromised control plane must be *incapable* of exfiltrating patient data, not merely unwilling.
2. **The no-PII guarantee is structural and build-tested.** The payload builder emits only numbers under keys drawn from the catalogue — it has no code path that can serialise a row, a string field, or free text. Two tests enforce it (see Task 2); if they fail, the build fails.

## Context for the implementer — read first

- **`npm test`** from the repository root; baseline **1510 passing, 0 failing**. Known flake: ~1 run in 3 shows 2-3 `fetch failed / bad port` errors in port-binding tests — environmental, never assertion failures. Re-run before believing one.
- **Never `git add -A` or `git add .`** · **Never create a git worktree** · **Never `npm install`** (restore `node_modules` from `../easymed.old` if empty).
- **Do not kill processes you did not start.** The dev instance on port 8000 and a control-plane demo on port 8090 are not yours. Use ports 8220+, kill only PIDs you spawned.
- **Never touch the repository's `data/`** — real patient data, and this machine's working dev licence.
- **Comment style:** comments record *why a line exists*. Strict TDD.
- Migration numbering: check the highest existing number in `server/db/migrations/` before writing; the duplicate-prefix guard refuses collisions.

### Verified facts

| Fact | Where |
|---|---|
| The clinic check-in client already parses the check-in response and ignores unknown fields | `server/services/control/checkin.js` |
| The control plane already returns `collect: []` with a comment marking it for this plan | `control-plane/server/services/checkin.js` |
| `checkins.payload TEXT` already stores arbitrary JSON per check-in | `control-plane/server/db/migrations/001_registry.sql` |
| The error handler and slow-log middleware see every 5xx and every slow request, but only `console`-log them | `server/app.js`, `server/middleware/slow-log.js` |
| Failed logins are throttled in memory, not recorded | `server/services/auth.js` |
| Revenue lives in `invoices` (`total`, `status`) and `payments` (`amount`, `method`, `created_at`) | schema |
| The vocabulary-drift trap and its cure: import shared vocabularies across the repo halves, never re-type them | `SELLABLE_MODULES`, `expectedResponse` precedents |

---

### Task 1: An operational event log the counters can count

**Files:** next-numbered migration `NNN_ops_events.sql` + `NNN.test.js`, `server/services/ops-log.js` + test; modify `server/app.js` (error handler), `server/middleware/slow-log.js`, `server/services/auth.js` (failed logins), `server/index.js` (boot event).

- [ ] Table `ops_events (id INTEGER PK, kind TEXT NOT NULL, route TEXT, at TEXT NOT NULL DEFAULT strftime(...))`. Kinds: `server_error`, `slow_request`, `failed_login`, `boot`. **No message column, no free text** — a `route` is the closest thing to text and it is a path template the client already knows. An error *message* can contain a patient name (a constraint violation echoes values); the schema must make storing one impossible.
- [ ] `server/services/ops-log.js` — `recordEvent(db, kind, route?)`, wrapped so it can NEVER throw: a broken statistics write must not break the request that triggered it. Test that with a closed database handle.
- [ ] Instrument: the app.js error handler (5xx only), slow-log (over its existing threshold), auth failures, and one `boot` event at startup.
- [ ] Prune to 14 days at boot, same `.unref()` pattern as session pruning.
- [ ] Tests: events land with the right kind; a 4xx does NOT record; the recorder never throws; prune keeps the window.

### Task 2: The counter catalogue and the payload that cannot lie

**Files:** `server/services/control/metrics.js` + `metrics.test.js`.

- [ ] `COUNTERS` — a null-prototype map of name → `{ describe, run(db) → number }`. Starting set:
  - `errors_24h`, `slow_requests_24h`, `failed_logins_24h`, `boots_7d` — from `ops_events`
  - `billed_today`, `collected_today`, `collected_today_cash`, `collected_today_card`, `unpaid_total` — from `invoices`/`payments`, **sums and counts only**, local day boundary (match how the queue computes "today")
  - `patients_total`, `visits_today` — cheap usage signals; counts only
- [ ] `buildStatsPayload(db, requestedNames)` — runs only names present in `COUNTERS`, silently skips unknown ones (the panel may know a counter this older install does not — that must not error), coerces every result through `Number()`, drops anything non-finite. **The return type is `{ [name]: number }` and nothing else can escape it.**
- [ ] **The two build-gate tests (rule 2):**
  1. Every counter in the catalogue, run against a seeded database, returns a finite `number`.
  2. Seed a database with a patient named `ZZTESTPATIENT_UNIQUE_9Q4`, a phone, and a lab result containing that string; run `buildStatsPayload` with **every** catalogue name; `JSON.stringify` the result; assert the marker string is absent and every value is a number and every key is in the catalogue.
- [ ] A counter that throws (corrupt table) yields no entry for that name — never a crash, never a string error in the payload. Test it.

### Task 3: Wire it end to end, and let the vendor choose

**Files:** clinic side — modify `server/services/control/checkin.js` + test. Control plane — next migration adds `clinics.collect_set TEXT` (JSON array, default the starting set); modify `control-plane/server/services/checkin.js` + routes/admin.js + panel (clinic detail: a "Statistics" card showing the latest reported numbers and when; a counter-picker editing `collect_set`); tests throughout.

- [ ] Clinic: remember the `collect` list from the last response (in `control_state`), build the stats payload at the next check-in, send it as `stats`. **A failure building stats must never block the check-in itself** — licensing outranks telemetry. Test with a catalogue forced to throw.
- [ ] Control plane: return `collect` from `clinics.collect_set`; validate stored names against the catalogue vocabulary **imported from the clinic app's `metrics.js`** (one repo, one vocabulary — the drift trap again); store incoming `stats` in the existing `checkins.payload`.
- [ ] Reject garbage stats without failing the check-in: non-numbers dropped, unknown keys dropped, bounded size. A malformed stat costs a data point; a rejected check-in costs a licence renewal. Same reasoning as module_requests.
- [ ] Panel: clinic detail shows the latest stats with their `at` timestamp and a plain sentence when a clinic has never reported; a checkbox list edits `collect_set` (with the same "applies at next check-in" note).
- [ ] **Acceptance test, end to end through real HTTP:** enrol a clinic, set its collect set from the admin API, run two clinic check-ins against the real control plane (the first learns the set, the second reports), then read the clinic via the admin API and assert the numbers arrived — and that the ZZTESTPATIENT marker seeded in the clinic DB appears nowhere in any control-plane table. That last assertion is the owner's instruction, proven at the far end of the wire.

---

## Definition of done

- [ ] The vendor ticks counters in the panel; the clinic starts reporting them within two check-ins; no release shipped
- [ ] Every reported value is a number under a catalogue key — proven by the marker test at both ends
- [ ] A statistics failure never breaks a request, a boot, or a check-in
- [ ] An older install silently skips counters it does not know
- [ ] `ops_events` holds kinds and route templates only — no free text, by schema
- [ ] Suite green, roughly 35+ new tests

## Out of scope

Fleet-wide dashboards and charts (the per-clinic card is enough to start); alerting; any counter beyond the catalogue above — add counters in later releases, generously.
