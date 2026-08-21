# Update Delivery (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two developers push to a private GitHub repository; a maintainer tags a release; GitHub builds and signs a bundle; the vendor publishes it to a ring; each clinic's admin approves it and it installs itself at 03:00, rolling back by itself if anything goes wrong.

**Architecture:** GitHub builds. `settings.easymed.uz` decides who gets it and when. The clinic downloads a signed bundle, verifies it, unpacks it beside the running version, and calls the version switcher from Plan 3. **Clinics never talk to GitHub.**

**Tech Stack:** Node 24 ESM, `node:crypto` (Ed25519, already in use), `node:zlib` + a vendored tar reader or `tar.exe` (ships with Windows 10+) — **no new npm dependency**. GitHub Actions for the build. PowerShell for the switch, already built in Plan 3.

**Spec:** `docs/specs/2026-08-20-control-plane-design.md` §7.

---

## Read this first

### Why clinics never talk to GitHub

If a clinic pulled from GitHub it would need repository credentials on its PC — one compromised clinic machine exposes the entire source. It would also remove all control over *who* upgrades *when*, which is the only thing standing between a bad release and every clinic at once.

So GitHub is the build system and `settings.easymed.uz` is the distribution controller. The clinic knows one hostname.

### The two rules that come from having two developers

1. **`main` is what ships.** Work on branches, merge by pull request. A release is a tag on `main`, never a branch build — otherwise "which code is that clinic running?" has no answer.
2. **Tagging is a separate, deliberate act from pushing.** A push must never reach a clinic. Someone decides a commit is a release and tags it. Without that separation an ordinary Tuesday commit lands on fifty clinics overnight.

### What must be true when this is finished

1. **A failed update leaves a working clinic** — not a working *new* version, a working one. Code reverts by repointing; data reverts from the pre-migration backup taken in Plan 3.
2. **No update installs without the admin approving it.** The owner chose consent-always: there is no forced channel, not even for security fixes. If that ever changes it is a product decision, not an implementation detail.
3. **A clinic that never approves stays on its old version indefinitely** and keeps working.
4. **The update client cannot break the clinic by failing.** Every network and disk error is "try again tomorrow".

### Prerequisites — this plan cannot start without them

| Needed | Plan | State |
|---|---|---|
| `EASYMED_DATA_DIR`, data outside the versioned tree | 3 Task 1 | **Done** |
| Database backed up before migrations | 3 Task 2 | **Done** |
| Versioned layout + Windows service | 3 Task 3 | in progress |
| `switch-version.ps1` with health check and auto-rollback | 3 Task 4 | not started |
| Clinic registry, check-in endpoint, `install_token` | 1b | not started |
| **A GitHub remote** | — | **Not created.** `easymed.local` is local-only. |

---

## Context for the implementer

- **`npm test`** baseline **1276 passing, 0 failing**. Known flake: ~1 run in 3 shows 2-3 `fetch failed / bad port` errors in port-binding tests — environmental, never assertion failures. Re-run before believing one.
- **Never `git add -A` or `git add .`** · **Never create a git worktree of this repo** · **Never `npm install`** — restore `node_modules` with `cp -r ../easymed.old/node_modules ./node_modules`.
- **Do not kill processes you did not start.** A live instance runs on port 8000.
- **Never touch the repository's `data/`** — real patient data.
- **Comment style:** comments record *why a line exists*. No git history before 2026-08-20.

---

## File structure

```
.github/workflows/release.yml       CREATE  — tag -> build -> sign -> attach
scripts/build-bundle.mjs            CREATE  — produce + sign a release bundle
scripts/build-bundle.test.js        CREATE
server/services/control/
  updater.js                        CREATE  — the clinic side: check, download, verify, stage
  updater.test.js                   CREATE
  update-schedule.js                CREATE  — consent, the 03:00 window, retry policy
  update-schedule.test.js           CREATE
server/services/rpc/updates.js      CREATE  — update_status, update_approve
server/services/rpc/updates.test.js CREATE
public/js/admin/views/updates.js    CREATE  — the approval screen
control-plane/server/routes/releases.js  CREATE  — which clinic is offered what
control-plane/server/services/rings.js   CREATE  — rings + automatic halt
install/apply-update.ps1            CREATE  — unpack, switch, verify, roll back
docs/RELEASING.md                   CREATE  — the human runbook
```

---

### Task 1: The release bundle

**Files:** `scripts/build-bundle.mjs`, `scripts/build-bundle.test.js`

A bundle is a `.tar.gz` of the application plus a signed manifest. The signature uses the **same Ed25519 mechanism and the same `canonical()` serialiser** as the licence — one signing concept in this system, not two.

```json
{
  "version":    "2.4.0",
  "released":   "2026-09-01T00:00:00Z",
  "notes_ru":   "Ускорен список чатов. Исправлена печать направлений.",
  "migrations": ["073_licensing.sql", "074_lab_index.sql"],
  "min_from":   "2.0.0",
  "sha256":     "<of the tarball>"
}
```

- [ ] **Tests first.** Cover: a bundle round-trips (build, verify, unpack, files match); a tampered tarball fails `sha256`; a tampered manifest fails the signature; a bundle signed with the wrong key is refused; `min_from` newer than the installed version is refused; **`data/`, `.git/` and `*.db` are never included** — assert on the actual tar contents, because this is how a build machine leaks a clinic database into a release.
- [ ] Exclude by allow-list, not deny-list: name the directories that go in (`server`, `public`, `install`, `node_modules`, `package.json`, `package-lock.json`). A deny-list silently ships whatever gets added next year.
- [ ] Reuse `canonical()` from `server/services/control/canonical.js`. Do not write a second serialiser — the licence work already removed one duplicate of exactly this kind, and the divergence would only surface when an update refused to install.

---

### Task 2: Building it in GitHub Actions

**Files:** `.github/workflows/release.yml`, `docs/RELEASING.md`

- [ ] Triggers on a tag matching `v*`, on `main` only. **Never on push.**
- [ ] Checks out, verifies `package.json`'s version matches the tag (refuse if not — a mismatch is how "which version is that?" becomes unanswerable), installs dependencies, runs `npm test`, and **fails the release if the suite fails**.
- [ ] Signs with a private key from a repository secret (`EASYMED_RELEASE_KEY`). **This may be a different key from the licence signing key**; decide and document it. Two keys means a leaked build key cannot mint licences — worth the extra care.
- [ ] Attaches the bundle and manifest to a GitHub Release.
- [ ] `docs/RELEASING.md`: how a maintainer cuts a release, in plain steps, including what to write in `notes_ru` — a clinic manager reads it, so "fixed a null pointer" is useless and "печать направлений больше не обрывается" is not.

**Note the flake:** this suite fails roughly one run in three on Windows with ephemeral-port errors. On Linux CI that should not occur — but if it does, a flaky gate that blocks releases is worse than no gate. Add a single retry for the test step and **report whether it was needed**.

---

### Task 3: Deciding who gets what

**Files:** `control-plane/server/routes/releases.js`, `control-plane/server/services/rings.js` + tests

Extends Plan 1b's check-in response with an `update` block.

- [ ] Releases table: version, notes, url, sha256, manifest, published-to-ring, halted.
- [ ] Rings: `0` the vendor's own install, `1` two or three friendly clinics, `2` everyone. A clinic has a ring; a release is published ring by ring, manually promoted.
- [ ] **Automatic halt:** if failure reports from a ring exceed a threshold, the release freezes and no further clinic is offered it. Test the threshold arithmetic explicitly — an off-by-one here means either it never halts or it halts on the first clinic.
- [ ] **Pinning:** a clinic can be held on a version and is never offered anything newer.
- [ ] Check-in returns at most one offer, the newest the clinic is eligible for.
- [ ] A clinic already on that version is offered nothing.

---

### Task 4: The clinic side — check, consent, stage

**Files:** `server/services/control/updater.js`, `update-schedule.js`, `server/services/rpc/updates.js`, plus tests

- [ ] Check-in brings back an offer; store it. **Never act on it without consent.**
- [ ] `update_status` RPC → the offer, the notes, whether it is approved, when it will install.
- [ ] `update_approve` RPC → **admin only, via `hasAnyRole`, not `user.role`.** A clinic admin whose primary role is cashier or doctor holds admin through `extra_roles`; a primary-role check locks out exactly the person who approves. This bug has already occurred twice in this project.
- [ ] Approval records who and when. It is a consent record — it may be asked about later.
- [ ] The installer runs in the 03:00–04:00 window. If the PC is off, it runs at the next opportunity in that window — **never mid-morning**, which is the entire point.
- [ ] Download to a temp file, verify `sha256`, verify the manifest signature, unpack to `<root>\versions\<version>\`, and only then hand over to `apply-update.ps1`. **Verify before unpacking, never after.**
- [ ] Every failure is "try again tomorrow" and is reported on the next check-in. Test: no network, half a download, wrong hash, wrong signature, disk full, an already-existing version directory.

---

### Task 5: Applying it

**Files:** `install/apply-update.ps1`

- [ ] Preconditions: the staged version exists, the service is running, the health endpoint answers now.
- [ ] Call `switch-version.ps1` from Plan 3 — it already stops, repoints, starts, health-checks and rolls the code back on failure. **Do not reimplement any of that here.**
- [ ] After a successful switch, wait for the new version to finish migrating and answer health. Migrations run at boot and back themselves up first (Plan 3 Task 2).
- [ ] **If health fails after the switch:** roll the code back via `switch-version.ps1`, then decide about the database. Restoring it destroys anything entered since the backup — which at 03:00 is usually nothing, but "usually" is not "always". **Restore only if the old version cannot start against the migrated database**, and record loudly what was restored and from where.
- [ ] Write an outcome file the app reports on its next check-in: version attempted, result, and what was rolled back.

---

### Task 6: The approval screen

**Files:** `public/js/admin/views/updates.js`, i18n strings, CSS

Russian, no emojis, `tr()` for literal strings (**not `t()`** — different function, different lookup table; that mistake has already shipped once here).

- [ ] Shows: current version, the offered version, `notes_ru`, and one button — «Обновить сегодня ночью».
- [ ] After approval: «Обновление установится сегодня в 3:00. Компьютер должен быть включён.» That last sentence matters more than it looks — an update that silently never happens because the PC was off is a support call.
- [ ] A quiet banner when an update is waiting, in the style of the licence banner.
- [ ] After an update: a short "what changed" note on first login.
- [ ] If the last attempt failed and rolled back, say so plainly, with the version and the date. A clinic must not discover from the vendor that its update failed.

---

## Definition of done

- [ ] A tag on `main` produces a signed bundle attached to a GitHub Release
- [ ] The bundle contains no `data/`, no `.git/`, no `*.db` — asserted on real tar contents
- [ ] A clinic is offered an update only if its ring has it, it is not pinned, and it is not already on it
- [ ] Nothing installs without an admin approving it
- [ ] Installation happens between 03:00 and 04:00, never during a working day
- [ ] A tampered bundle, a wrong signature or a wrong hash is refused before unpacking
- [ ] A failed update leaves the clinic on the previous version, working, and says so on the next check-in
- [ ] A halted release stops being offered
- [ ] A clinic that never approves keeps working indefinitely

## Out of scope

| Not here | Where |
|---|---|
| Statistics | Plan 2 |
| Subscriptions, module entitlements | Plan 1b |
| The Windows service and versioned layout | Plan 3 |
| Downgrading to an older version on request | later — the mechanism exists via `switch-version.ps1`, the policy does not |
