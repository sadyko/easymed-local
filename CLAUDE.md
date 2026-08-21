# Easy-Med Local — Project Notes for Claude

## Overview

Standalone, fully LOCAL clinic management system (HIS). One "server PC" at the clinic runs it;
every other PC uses it through a browser over the LAN. **No internet is required to run it.**

This project is the working baseline for the next version. It was copied from `easymed.old`
on 2026-08-20 and put under git for the first time — the previous copy had no history at all.

## Current status — READ THIS, the old notes lied

The predecessor's `CLAUDE.md` claimed "Phase 1 done, Phase 2 next, 45 tests". That was ten
months stale. The real state:

- **Everything through Phase 2 shipped.** Patients, CRM, doctor cabinet, queue board,
  laboratory, procedures, inpatient/beds, cashier + shifts, procurement, documents, reports,
  roles, i18n (UZ/RU/EN), and a Telegram patient bot are all live.
- **1,100 automated tests, all passing.** (`npm test`)
- 97 tables, 72 migrations, ~107,000 lines of code.

Next work: the **control plane** — a panel at `settings.easymed.uz` that licenses clinics,
collects non-PII statistics, and delivers updates. Design in progress; see
`docs/specs/` once it lands.

## Architecture — the one thing to understand first

The app has ~665 database call sites written in Supabase/PostgREST style. Rather than rewrite
them, this project replaced *what they talk to*:

```
  view code (unchanged)     supabase.from('patients').eq('active', 1)
        |
  public/js/supabase.js     shim -> builds a JSON "query descriptor"
        |  POST /api/db
        v
  server/db/query-compiler.js     descriptor -> ONE parameterized SQLite statement
  server/db/schema-registry.js    ALLOW-LIST: which table/column/op/embed, per role
        |
        v
      SQLite (data/easymed.db)
```

**The invariant that must never break:** no SQL text is ever built from a request body.
Identifiers are validated against `schema-registry.js`; all values are bound parameters. No
unfiltered UPDATE/DELETE compiles. Anything the registry does not explicitly permit → 4xx.

Alongside it: `POST /api/rpc/:name` (90+ named server-side handlers in
`server/services/rpc/`), `/api/auth` (sessions in SQLite behind an HttpOnly cookie), and
`/api/storage`.

## Structure

- `server/` — `index.js` (entry), `app.js` (Express factory), `db/` (SQLite + auto-migrations),
  `routes/`, `services/`, `middleware/`
- `public/` — everything the browser loads. `/` = login, `/admin` = the app
- `public/js/admin/views/` — one file per screen (88 of them)
- `data/easymed.db` — the entire clinic dataset. **Gitignored. Contains real patient data.**
- `docs/specs/`, `docs/plans/` — design specs and implementation plans

## Conventions

- Vanilla HTML/CSS/JS ES modules. **No framework, no build step.**
- **No network dependencies.** Never add a CDN import. Vendored libraries live in
  `public/js/vendor/` (e.g. SheetJS for Excel).
- UI language is Russian; strings go through `public/js/admin/i18n-strings.js` (UZ/RU/EN).
- **Never use emojis in the UI.** Icons come from `public/js/admin/icons.js`.
- Migrations: `server/db/migrations/NNN_name.sql`, applied in filename order, `.sql` only.
  Tests sit beside them as `NNN.test.js`.
  **Check the highest existing number before adding one** — the old project collided three
  files on `071_` and two on `058_`, so ordering between them became alphabetical by accident.
- Tests are co-located: `*.test.js` next to what they test. Run everything with `npm test`.

## Running it

    npm start          -> http://localhost:8000
    npm test           -> 1100 tests

`node_modules/` is already present, so no internet is needed. If it ever has to be rebuilt:
`npm ci --ignore-scripts` (better-sqlite3 ships a prebuilt Windows binary; a plain
`npm install` tries to compile it and fails without Visual Studio build tools).

## The test suite has a known environmental flake

`npm test` is green, but roughly **one full run in three reports 2-3 failures**. They are always
in tests that bind a real ephemeral port and use `fetch` (`staff-delete`, `service-templates-role`,
`clinic-after-login`, and friends), always `fetch failed / cause: bad port`, and **never an
assertion failure**.

Characterised on 2026-08-20: the 16 port-binding test files run in isolation passed 6/6 consecutive
times. It only appears under full-suite parallelism, where Node's test runner starts many files at
once and Windows ephemeral-port allocation transiently fails.

**How to apply:** if a run shows failures, check whether they are assertion failures or network
errors. Network errors in port-binding files are the flake — re-run. Anything else is real. Do not
report a suite as green off a single run, and do not chase this flake as a code defect.

Also: **never run `npm test` while another agent is writing files.** A half-written module produces
failures in tests that have nothing to do with it, which reads exactly like a regression.

## Re-running a migration is not "delete its tracking row"

Migrations use plain `CREATE TABLE`, not `CREATE TABLE IF NOT EXISTS` — matching 34 of the 38
table-creating migrations. That is correct, because `migrate()` runs each file exactly once per
install, tracked by filename.

But it means the obvious way to force a migration to re-run —
`DELETE FROM schema_migrations WHERE name='073_licensing.sql'` — **does not work**. The tracking
row goes, the tables stay, and the re-run dies with `table control_state already exists`.

**How to apply:** to genuinely re-run a migration you must undo what it created as well as its
tracking row. For 073 that is `control_state`, `module_requests` and `module_requests_open_uniq`.
Found on 2026-08-21 while testing the pre-migration backup; the backup itself fired correctly
first, which is exactly the situation it exists for — an operator in this position should restore
from `data/backups/` rather than hand-patching the schema.

## Known issues carried over from easymed.old

Recorded so they are not rediscovered the hard way:

1. **`telegram_chats_list` is slow** — 263 logged calls between 660 ms and 1.5 s, polled
   continuously by the chat view. The clearest performance target in the system.
2. **Cloud leftovers in an offline app** — three `window.location.href = 'https://easymed.uz/'`
   dead ends in `public/js/admin.js`, plus Symptex publication flows in `verify-banner.js`,
   `setup-checklist.js`, `sections.js` and `views/public-site.js`.
3. **`accdep.cjs`** at the repo root is a dead one-off patch script for `rpc/deposits.js`.
4. **Three specs were written but never built**: analyzer HL7 ingest (Mindray BC-20),
   constant performers, invoice auto-expiry.
5. **Cache-busting `?v=xxx` suffixes** are still hand-maintained on every import in `admin.js`
   even though `Cache-Control: no-cache` made them unnecessary.
6. `data/` in the old copy held ~280 MB of loose full-PII database backups. They were
   deliberately not carried over.

## Reading the code

The inline comments are unusually good — most explain *the bug that caused that line to exist*.
Since the predecessor had no git history, those comments are the only record of why things are
the way they are. Read them before changing anything, and keep writing them in the same style.
