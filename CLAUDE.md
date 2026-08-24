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
- **1,418 automated tests, all passing.** (`npm test`)
- 97 tables, 72 migrations, ~107,000 lines of code.

**Licensing is done and enforced** (Plan 1a, `docs/plans/2026-08-20-licensing-core.md`).
A clinic verifies an Ed25519-signed licence, unbought modules show an offer screen instead of
opening, and a lapsed clinic can log in and read but cannot write. Editing `licence.dat` locks the
app rather than unlocking it; winding the PC clock back does not extend anything; a corrupt or
missing licence locks but never stops the app starting. Telephone unlock works with no internet.

**The control plane is most of the way there** (`docs/plans/2026-08-20-control-plane-service.md`):
registry with unique clinic ids, licence signing, enrollment over the wire, the daily check-in, and
the clinic-side client that calls it. Granting a module in the vendor's database reaches the clinic
on its next check-in with no file carried by hand. **Still to build: the vendor panel page.**

**Supervised install is done** (`docs/plans/2026-08-20-supervised-install.md`): `EASYMED_DATA_DIR`,
pre-migration database backups, the Windows service installer and a version switcher that rolls
itself back on a failed health check. Untested end-to-end because this machine has no
administrator rights — service registration needs one pass on a box that does.

**Statistics is done** (`docs/plans/2026-08-22-statistics.md`): a PII-proof event log
(`ops_events`, no free text by schema), a compiled-in counter catalogue whose payload builder can
emit only finite numbers under known names, and the wiring — the vendor ticks counters in the
panel, the clinic reports them within two check-ins, no release shipped. The guarantee is a
build-gate test: a marker patient seeded clinic-side is asserted absent from every control-plane
table.

**Update delivery is done** (`docs/plans/2026-08-20-update-delivery.md`): signed release bundles
(allow-listed, leak-tested), CI that turns a tag on `main` into a release, rings with automatic
halt on failures, a clinic-side updater (consent names a version, the clinic picks its local hour,
cross-host downloads refused, verify-before-unpack), an apply script with exact rules for when the
database may be touched (almost never), and the approval screen — reachable even by a
licence-lapsed clinic, deliberately. The developer workflow is `docs/WORKFLOW.md`; releasing is
`docs/RELEASING.md`; onboarding a second developer is `docs/ONBOARDING.md`.

### What remains before the first real clinic

1. **The GitHub remote does not exist.** Create `easymed-local` (private), push this branch, add
   the `EASYMED_RELEASE_KEY` secret and the rulesets per `docs/RELEASING.md`. The first real tag
   is also the first real validation of `.github/workflows/release.yml`.
2. **One pass on a machine with administrator rights**: register the real Windows service
   (`install/install-service.ps1`) and confirm SCM reports it — the known "Error 1053" question.
3. **Replace the development licence key** (`node scripts/make-licence.mjs keygen`) — the server
   warns at every boot until then — and generate the release keypair for CI.
4. **Deploy the control plane** to the server behind `settings.easymed.uz/cp/` (own nginx
   upstream, never through the CORE gateway), generating the production signing key there.

### The development licence key

This working copy carries a **development** Ed25519 key in
`server/services/control/licence.js` and a matching `data/licence.dat` for clinic `dev-local`.
Without it the app sits read-only, because the shipped placeholder key can verify nothing by
design. **It must be replaced before any clinic install** — `node scripts/make-licence.mjs keygen`
— and the server prints a loud warning at every boot until it is.

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

## The dev -> GitHub -> clinics workflow (docs/WORKFLOW.md is the full version)

This folder (`easymed.local`) is the DEV SERVER. Its sibling `easymed.clinic` is the
TEST CLINIC — a real launcher package that receives changes only as signed releases;
never edit files there. Two or three machines push to this repo, so the ordering is
absolute:

1. **Sync first, before any change:** `git switch main && git pull` — someone else may
   have pushed since yesterday. Building on a stale checkout loses their work in a merge.
2. Make the change here, `npm test`, look at the actual screen.
3. **STOP AND WAIT FOR THE OWNER TO TEST IT ON DEV** (localhost:8000). The owner's rule,
   stated 2026-08-24: automated tests passing is not the same as the change being right,
   and the dev server is where they look. Do not push until they say it is good.
4. Review the diff (`git status` / `git diff` — no data/, no *.db, no keys), then push,
   and check CI went green on GitHub.
5. **STOP AND ASK THE OWNER AGAIN** before anything release-shaped: no version bump, no
   tagging, no publishing in the panel, nothing that makes the change visible to clinics,
   until the owner says yes to that specific version. Pushing to GitHub is safe by
   itself — clinics can only ever receive a tagged, signed, ring-published release.
   Before tagging, run the Windows-only gate the update pipeline has no other cover for:
   `node --test server/services/control/apply-spawn.smoke.test.js` (see CONTRIBUTING.md).
6. The owner verifies on the test clinic first (restart its window -> check-in offers
   the update within ~a minute -> consent -> applies -> reopen window), and only then
   decides whether to widen the release to real clinics.

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
