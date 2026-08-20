# Control Plane Service (Plan 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner turns a clinic's modules on and off from a web page, extends or ends a subscription with a date, and sees who has asked for what — instead of running a CLI and hand-delivering files. Every clinic is uniquely identified so two clinics can never be confused.

**Architecture:** A small, deliberately boring Node service at `settings.easymed.uz` holds the clinic registry, the module entitlements and the Ed25519 signing key. Clinics call it once a day; it answers with a freshly signed 14-day licence and collects anything the clinic wants to tell it. The existing Platform Console gets a new page that drives it.

**Tech Stack:** Node 24 ESM, Express 5, better-sqlite3 — the same three dependencies the clinic app uses. No new technology. The vendor panel is vanilla ES modules, matching `platform-console/`.

**Spec:** `docs/specs/2026-08-20-control-plane-design.md` §1, §2, §3, §8.

---

## Read this before anything else

### The one thing that must never happen

**If this service is down, no clinic may notice.** Every clinic holds a licence valid for 14 more days, so a day of downtime is invisible. But that only holds if the clinic-side client treats every failure — timeout, 500, garbage response, DNS failure, expired TLS — as "try again tomorrow" and nothing else. A check-in client that throws on a bad response would take down every clinic in the country the first time the service returned a 502.

### Deviation from the spec, and why

Spec §8 says "Node + Express + Postgres". **This plan uses SQLite instead**, and that is a deliberate change:

- The scale is tens to hundreds of clinics checking in once a day. That is a few hundred writes per day — three orders of magnitude below where SQLite becomes the limiting factor.
- The team just built a 97-table SQLite application. Same idioms, same migration mechanism, same tooling, nothing new to learn or operate.
- Backup becomes copying one file, which matters for the thing holding your entire customer registry.
- Postgres earns its keep at thousands of clinics or with more than one app server. Neither is true, and moving later is a contained job because nothing in this design depends on SQLite specifically.

If the owner prefers Postgres, the only changes are `connection.js` and the SQL dialect in migrations.

### What already exists and must not be rebuilt

| Thing | Where | State |
|---|---|---|
| Signed licence format, verification | `server/services/control/licence.js`, `canonical.js` | Done, tested |
| Licence signing, enrollment, unlock codes | `scripts/make-licence.mjs` | Done — **this plan turns it into a service** |
| Clinic identity (`clinic_id`, `unlock_secret`) | `data/control.json` | Done, enforced (`wrong_clinic`) |
| Vendor panel shell, auth, clinics list, tariffs, payments, `upgrade_requests` | `platform-console/` (dump of the live site) | Live — **extend it, do not duplicate it** |
| Module vocabulary | `SELLABLE_MODULES` in `server/services/rpc/licence.js` | `crm`, `telegram`, `marketing` |

`marketing` is in the vocabulary but is **not sellable** — no NAV entry, route shows "coming soon". The panel must not offer it until that changes.

---

## Context for the implementer

- Work in `C:\Users\user\Desktop\implementation workflow\easymed.local` on branch `feat/licensing-core` unless told otherwise. The new service lives in a new top-level `control-plane/` directory in this same repo — it ships separately but is versioned together, so the licence format cannot drift between the two halves.
- **`npm test`** baseline **1259 passing**. Known flake: ~1 run in 3 shows 2-3 `fetch failed / bad port` errors in port-binding tests. Environmental, never assertion failures.
- **Never `git add -A` or `git add .`** · **Never create a git worktree of this repo** · **Never `npm install`** if `node_modules` is empty — restore with `cp -r ../easymed.old/node_modules ./node_modules`.
- **Do not kill processes you did not start.** A live instance runs on port 8000.
- **Comment style:** comments record *why a line exists*. No git history before 2026-08-20.
- **No secrets in the repo.** The signing key, any real clinic data, and any `.env` must be gitignored. `.gitignore` already covers `vendor-private.pem`, `control-*.json`, `licence-*.dat` — extend it as needed.

---

## File structure

```
control-plane/
  package.json                    CREATE  — its own, same 3 deps
  server/
    index.js                      CREATE  — entry
    app.js                        CREATE  — Express factory
    db/
      connection.js               CREATE
      migrate.js                  CREATE  — reuse the clinic app's approach
      migrations/001_registry.sql CREATE  — clinics, entitlements, checkins, requests
    services/
      signing.js                  CREATE  — the key lives here and nowhere else
      signing.test.js             CREATE
      clinics.js                  CREATE  — register, entitle, subscribe
      clinics.test.js             CREATE
      enrollment.js               CREATE  — codes -> identity
      enrollment.test.js          CREATE
    routes/
      enroll.js                   CREATE  — POST /api/v1/enroll
      checkin.js                  CREATE  — POST /api/v1/checkin
      admin.js                    CREATE  — the panel's API
      checkin.test.js             CREATE
      enroll.test.js              CREATE
  public/                         CREATE  — the vendor page (vanilla ES modules)
    clinics.js, clinics.css
  README.md                       CREATE  — how to run and deploy it

server/services/control/
  checkin.js                      CREATE  — the CLINIC side of the daily call
  checkin.test.js                 CREATE
```

---

### Task 1: The registry — where a clinic becomes a unique thing

**Files:** `control-plane/package.json`, `control-plane/server/db/{connection,migrate}.js`, `control-plane/server/db/migrations/001_registry.sql`, `control-plane/server/db/migrations/001.test.js`

The schema is the whole design; get it right and the rest follows.

- [ ] **Step 1: Write the failing test** — `control-plane/server/db/migrations/001.test.js`

Cover, with real inserts against a migrated in-memory database:

1. A clinic row requires a unique `clinic_id`; inserting the same id twice throws. **This is the "don't confuse clinics" guarantee — pin it first.**
2. `enrollment_code` is unique and nullable (it is consumed at enrollment and cleared).
3. `install_token` is unique — two installs cannot share one.
4. An entitlement row is `(clinic_id, module_key)` unique: a module cannot be granted twice.
5. Deleting a clinic removes its entitlements (`ON DELETE CASCADE`) but **not** its check-in history (history is evidence; keep it with the clinic id as plain text).
6. `subscription_until` is nullable — a clinic in trial or unpaid has none.
7. A check-in row records `clinic_id`, `at`, `version`, `fingerprint`, and a JSON `payload`.

- [ ] **Step 2: Run it, watch it fail**

- [ ] **Step 3: Write the migration** — `001_registry.sql`

```sql
-- CONTROL_PLANE_V1 — the vendor's registry of clinics.
--
-- This database is the answer to "who is running Easy-Med, on what, paying for
-- what". It holds NO patient data of any kind and must never grow a column that
-- could: the clinic side is physically incapable of sending any (see the
-- statistics plan), and this schema is the second line of that guarantee.

CREATE TABLE clinics (
  -- The identity everything else hangs off. Generated by us, never reused, and
  -- baked into every signed licence — a licence for one clinic is rejected by
  -- another with `wrong_clinic`, which is what makes two clinics unconfusable.
  clinic_id        TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  contact_phone    TEXT,
  contact_name     TEXT,

  -- Consumed at first run, then cleared. Short enough to read down a phone.
  enrollment_code  TEXT UNIQUE,
  -- Issued at enrollment; authenticates every later check-in.
  install_token    TEXT UNIQUE,
  -- Shared secret for telephone unlock codes. Also held by the clinic.
  unlock_secret    TEXT NOT NULL,

  -- 'active' | 'unpaid'. Drives the WORDING the clinic sees, and whether the
  -- licence gets re-armed at all.
  subscription     TEXT NOT NULL DEFAULT 'active',
  -- Paid up to. NULL means no end date recorded yet. When today passes this,
  -- check-in stops re-arming and the clinic's own 14-day ladder takes over.
  subscription_until TEXT,

  -- Last thing we know about them, updated on every check-in.
  last_seen_at     TEXT,
  last_version     TEXT,
  last_fingerprint TEXT,

  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  active           INTEGER NOT NULL DEFAULT 1
);

-- One row per module a clinic may use. A row's PRESENCE is the grant; there is
-- no `enabled` boolean, because a boolean invites the question "what does false
-- mean" and the answer is always "delete the row".
CREATE TABLE clinic_modules (
  clinic_id   TEXT NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL,
  granted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  granted_by  TEXT,
  PRIMARY KEY (clinic_id, module_key)
);

-- Evidence, not state. Deliberately NOT cascaded from clinics: if a clinic is
-- deleted the history of what it did stays, keyed by the plain id, because that
-- is what you look at when someone disputes a bill.
CREATE TABLE checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id    TEXT NOT NULL,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  version      TEXT,
  fingerprint  TEXT,
  payload      TEXT
);
CREATE INDEX checkins_clinic_at ON checkins (clinic_id, at DESC);

-- «Подключить модуль» leads, carried up by check-in.
CREATE TABLE module_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id    TEXT NOT NULL,
  module_key   TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  status       TEXT NOT NULL DEFAULT 'open',   -- open | granted | declined
  handled_at   TEXT,
  notes        TEXT
);
CREATE INDEX module_requests_open ON module_requests (status, received_at DESC);
```

`connection.js` and `migrate.js`: copy the clinic app's versions verbatim, including the duplicate-prefix guard. Do not improve them — sameness is the point.

- [ ] **Step 4-6:** Watch it pass · `npm test` in `control-plane/` · commit.

---

### Task 2: The signing service

**Files:** `control-plane/server/services/signing.js`, `signing.test.js`

- [ ] **Step 1: Failing test.** Cover: a licence signed here verifies with the clinic app's `verifyLicence` (import it directly across directories — that cross-check is the point of keeping both halves in one repo); the payload carries exactly `clinic_id, clinic_name, modules, valid_until, issued_at, nonce`; two licences for the same clinic differ (`nonce`); `valid_until` is 14 days out; a missing key file is a clear error, not a crash.

- [ ] **Step 2-3: Implement.** The private key is read from a path given by `EASYMED_SIGNING_KEY` and **never** logged, returned by any endpoint, or written to the database. Add a startup check that refuses to boot without it — a control plane that silently cannot sign is worse than one that will not start, because clinics keep checking in and quietly lapse.

- [ ] **Step 4-6:** Pass · commit.

---

### Task 3: Enrollment — a clinic becomes known

**Files:** `control-plane/server/services/enrollment.js` + test, `control-plane/server/routes/enroll.js` + test

- [ ] Generate an enrollment code (`EM-XXXX-XXXX`, the unlock alphabet, no ambiguous characters).
- [ ] `POST /api/v1/enroll {code, fingerprint}` → validates, consumes the code (clears it — **single use, prove it with a test**), issues `install_token` + `unlock_secret` + `clinic_id`, records the fingerprint, returns them plus a first licence.
- [ ] A wrong, reused, or unknown code returns the **same** generic failure. Different messages let someone probe which codes exist.
- [ ] Rate-limit by IP.
- [ ] **Test the whole loop:** enroll → write the response to a `control.json` → the clinic app's `controlState` reads it as enrolled and unlocked.

---

### Task 4: Check-in — the daily call

**Files:** `control-plane/server/routes/checkin.js` + test

`POST /api/v1/checkin` with `{ install_token, version, fingerprint, module_requests: [...] }` →
`{ licence, subscription, collect: [...] }`.

- [ ] Unknown or inactive token → 401, and **nothing else** — never a hint about which clinics exist.
- [ ] Records a `checkins` row every time, whatever else happens. Absence of check-ins is how you spot a clinic in trouble.
- [ ] Updates `last_seen_at`, `last_version`, `last_fingerprint`.
- [ ] **A changed fingerprint is recorded and flagged, never auto-locked.** Hardware gets replaced; locking an innocent clinic is worse than a duplicated install.
- [ ] Re-arms the licence **only if** `subscription = 'active'` and `subscription_until` is in the future (or null). Otherwise returns the current entitlements with no fresh `valid_until` and `subscription: 'unpaid'`, so the clinic's ladder shows money wording.
- [ ] Carries up `module_requests`, deduplicated per `(clinic_id, module_key)` while `status='open'`.
- [ ] **Idempotent:** the same check-in twice must not create two leads.

---

### Task 5: The clinic side of the call

**Files:** `server/services/control/checkin.js` + test, wired into `server/index.js`

This is where the "if the service is down, no clinic notices" rule is enforced.

- [ ] Runs at boot (after a short delay) and every 24 hours; `setInterval(...).unref()`.
- [ ] Reads `control.json` for the token, sends version + fingerprint + unsent `module_requests`.
- [ ] On success: writes the new `licence.dat` **atomically** (write to a temp file, then rename — a power cut mid-write must not leave a truncated licence, though `verifyLicence` would treat that as unlicensed and lock, which is safe but needless), marks requests `sent_at`, stores `subscription`.
- [ ] **On any failure, does nothing at all except log.** Test the lot: timeout, connection refused, 500, HTML instead of JSON, valid JSON with a licence for the wrong clinic, a licence signed with the wrong key. **None may throw, and none may replace a good licence with a bad one.**
- [ ] Never blocks boot. Never blocks a request.
- [ ] Configurable endpoint via `EASYMED_CONTROL_URL`, defaulting to `https://settings.easymed.uz`; if unset **and** unreachable, the clinic runs on its licence file exactly as it does today — which is the hand-delivered fallback, still working.

---

### Task 6: The panel page

**Files:** `control-plane/server/routes/admin.js` + test, `control-plane/public/clinics.js`, `clinics.css`

Match `platform-console/`'s house style: vanilla ES modules, `h()`-style DOM, no framework, no emojis.

**Clinics list:** name, clinic id, subscription state, paid-until, modules as chips, version, last seen (red when older than 3 days), fingerprint flag.

**Per clinic:**
- [ ] Toggle each sellable module — writes `clinic_modules`, takes effect at the clinic's next check-in. **Show that plainly**: "Applies at the clinic's next check-in (within 24 hours)." A vendor who thinks a toggle is instant will phone the clinic and be confused.
- [ ] Set `subscription_until` (a date) and `subscription` (active/unpaid).
- [ ] Issue an enrollment code for a new install; show it once, big, copyable.
- [ ] **Compute a telephone unlock code** from the clinic's `unlock_secret` and a challenge typed in — reuse `expectedResponse` from the clinic app's `unlock.js`, imported, never reimplemented. It was duplicated once already and the duplication was removed for exactly this reason.
- [ ] `marketing` must **not** be offerable until it ships. Read `SELLABLE_MODULES` and exclude it explicitly, with a comment.

**Requests inbox:** open `module_requests` with clinic, module, date; granting one adds the entitlement and marks it granted in a single transaction.

**Access:** vendor staff only. Reuse the existing console's auth if this is served behind it; otherwise a simple session with a strong shared credential is acceptable for v1 — **say which you chose and why in the README**.

---

### Task 7: Deployment

**Files:** `control-plane/README.md`

- [ ] How to run it, where the signing key lives, how to back it up (it is the one irreplaceable thing), how to back up the registry database.
- [ ] **Why it is not behind the CORE gateway:** that gateway hung twice in August 2026 and took `symptex.uz` down with it. If it took check-in down too, every clinic would begin a 14-day countdown simultaneously. State this so nobody consolidates them later for tidiness.
- [ ] TLS, and what happens when the certificate expires (clinics fail closed to their local licence — which is fine for 14 days and a disaster on day 15).

---

## Definition of done

- [ ] Two clinics can never be confused: unique `clinic_id`, unique `install_token`, and a licence for one rejected by the other
- [ ] The owner can turn a module on from a web page, and it reaches the clinic on the next check-in
- [ ] The owner can set a paid-until date; passing it lapses the clinic automatically
- [ ] «Подключить модуль» requests reach the inbox
- [ ] A telephone unlock code computed in the panel is accepted by the clinic
- [ ] **Every check-in failure mode leaves the clinic working on its existing licence** — tested for timeouts, 500s, HTML, wrong-clinic and wrong-key licences
- [ ] The signing key is never logged, returned, or committed
- [ ] Hand-delivered licence files still work as the fallback

## Out of scope

| Not here | Where |
|---|---|
| Statistics collection | Plan 2 |
| Release bundles, update delivery, rollout rings | Plan 4 |
| Windows service and versioned install | Plan 3 |
| Billing, invoices, payment capture | later — the panel records a date, the money happens elsewhere |
