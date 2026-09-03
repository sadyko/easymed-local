# HANDOVER — Easy-Med Local, for a new development machine

Written 2026-08-22. Everything here was verified by running it, not by recalling it.
Read `CLAUDE.md` first — it is the living project brief; this file is the map and the
what-is-where. If they ever disagree, trust the code and say so in a commit.

## 1. What this repository is

Two products in one repo, deliberately, so their shared cryptographic contract can never drift:

```
easymed-local/
├─ server/                  CLINIC APP backend — Node 24 ESM, Express 5, better-sqlite3
│  ├─ index.js              entry (npm start). EASYMED_DATA_DIR decides where data lives
│  ├─ app.js                Express factory; every route mounts here
│  ├─ db/                   SQLite + auto-migrations (NNN_name.sql, applied by filename order,
│  │                        duplicate-number guard; tests co-located as NNN.test.js)
│  ├─ routes/               auth, db (allow-list query compiler), rpc, storage, users
│  ├─ services/rpc/         ~90 named RPC handlers (billing, labs, inpatient, telegram, updates…)
│  └─ services/control/     THE LICENSING CORE — see §3
├─ public/                  CLINIC APP frontend — vanilla ES modules, NO build step, NO framework
│  ├─ admin.html + js/admin/ the app; views/ = one file per screen; i18n UZ/RU/EN
│  └─ js/supabase.js        NOT Supabase — a local shim; ~665 legacy call sites talk to /api/db
├─ control-plane/           VENDOR SERVER — registry, licence signing, check-in, panel
│  ├─ server/index.js       entry; REFUSES to boot without EASYMED_SIGNING_KEY (by design)
│  ├─ server/db/            its own SQLite (registry.db) + migrations 001-004
│  ├─ server/services/      signing, enrollment, checkin (rings/offers), vendor-auth, rings
│  ├─ server/routes/        /cp/v1/enroll, /cp/v1/checkin (public), /cp/v1/admin/* (session)
│  └─ public/               the vendor panel (login, clinics, modules, subscriptions, releases)
├─ scripts/                 make-licence.mjs (break-glass CLI), build-bundle.mjs (release
│                           bundles), check-tag-version.mjs (CI gate)
├─ install/                 EasyMed.exe launcher + clinic-package builder + recover.cmd
│                           (install-service.ps1 is RETIRED — see §7.1)
├─ .github/workflows/       ci.yml (PRs), release.yml (tag v* → signed bundle → GitHub Release)
├─ docs/                    WORKFLOW.md, RELEASING.md, ONBOARDING.md, plans/, specs/
└─ data/                    GITIGNORED. Patient records + this machine's licence identity.
                            Never committed (verified across all history), never copied between
                            machines. A fresh clone creates its own empty one on first start.
```

The database schema: 97+ tables, 76 migrations in `server/db/migrations/`. The control plane's
registry is separate: 4 migrations in `control-plane/server/db/migrations/`.

## 2. Module status (honest)

| Module | Status |
|---|---|
| Clinic app (patients, CRM, labs, cashier, inpatient, procurement, reports, Telegram bot) | done, in daily dev use |
| Licensing core (signed licences, lock ladder, phone unlock, module gating) | **done** |
| Control plane (registry, signing, enrollment, check-in, vendor panel) | **done, deployed, live** |
| Statistics (vendor-chosen counters, no-PII by construction) | **done** |
| Supervised install (Windows service, versioned layout, rollback switch) | done in code; **service registration never executed with real admin rights** |
| Update delivery (bundle → CI → rings → consent → install → auto-rollback) | **done**; v0.1.1 built and signature-verified end to end |
| Clinic-side enrollment-code entry screen | **done** — first-run branch of the activation screen (ENROLLMENT_SCREEN_V1) |

## 3. The licensing system, as actually implemented

- **Identity:** `data/control.json` — `clinic_id`, `install_token`, `unlock_secret`,
  `subscription`. **Licence:** `data/licence.dat` — `{payload, sig}`, Ed25519 over
  `canonical(payload)` (`server/services/control/canonical.js` — the ONE serialiser both signer
  and verifier use; never write a second).
- **Enrollment:** vendor creates a clinic in the panel → one-use code `EM-XXXX-XXXX`
  (alphabet excludes I/O/0/1 — codes are read aloud) → `POST /cp/v1/enroll {code, fingerprint}`
  → identity + first licence. Server side: `control-plane/server/services/enrollment.js`.
  Clinic side: the first-run activation screen (`views/activation.js` renderEnrollment →
  `licence_enroll` RPC → `server/services/control/enroll.js`, which verifies the returned
  licence against the compiled-in key BEFORE writing `control.json`/`licence.dat`).
  The script path below still works for break-glass.
- **Branches (BRANCH_SELF_SERVICE_V1 / BRANCH_REISSUE_V1):** the MAIN clinic creates its own
  branch — `POST /cp/v1/branch {install_token, name}` → `{clinic_id, name, enrollment_code}`;
  the branch is a SEPARATE clinics row (own subscription, own install_token, `parent_clinic_id`
  = the caller). That code is one-use, and the branch key the main clinic shows has the code
  baked into it — so a REINSTALLED branch PC could never activate again. The way back:
  `POST /cp/v1/branch/:clinic_id/reissue {install_token}` — same auth (the parent's install_token
  in the BODY, not a header), same `{clinic_id, name, enrollment_code}` response, fresh code —
  and it clears the branch's `install_token`: one branch, one PC, so the old install goes dark
  instead of two machines sharing one licence. 401 = bad/missing token; 404 = not yours /
  unknown / retired (one answer for all three, so nobody can probe other clinics' ids).
  Creates no rows, changes nothing else on the row (subscription, unlock_secret, modules).
  `control-plane/server/routes/branch.js`, `services/enrollment.js` reissueEnrollmentCode().
- **Staying licensed:** `server/services/control/checkin.js` calls
  `POST https://settings.easymed.uz/cp/v1/checkin` daily; a paid clinic gets a fresh 14-day
  licence (the dead-man's switch — the vendor stops re-arming, the clinic lapses by itself).
  Every failure mode = "try again tomorrow"; a good licence is never overwritten by a bad one.
- **Lapse behaviour:** login and reads keep working; writes return 402; admin always reaches
  the activation screen. Wording distinguishes "unpaid" from "offline" — never accuse a paying
  clinic whose router died.
- **Phone unlock:** `server/services/control/unlock.js` (HMAC over `clinicId:challenge`,
  10-char response, 5 tries/hour). The panel computes the response in the clinic's detail page;
  the CLI `scripts/make-licence.mjs unlock` is the break-glass path. Both import the same
  function — deliberately never two implementations.
- **Keys (locations only):**
  - Licence signing (private): control-plane server only — `/etc/easymed-cp/vendor-private.pem`
    (root, 0600). Public half: embedded in `server/services/control/licence.js`.
  - Release signing (private): GitHub Actions secret `EASYMED_RELEASE_KEY` + the owner's offline
    backup (`Documents/easymed-keys/` on the owner's machine — not in any repo). Public half:
    embedded in `server/services/control/updater.js`.
  - Two separate keypairs on purpose: a leaked build key cannot mint licences.
  - Release PUBLISHING (not signing): `EASYMED_CP_DEPLOY_TOKEN` — the same string in the GitHub
    Actions secret of that name and in the control plane's environment. Not a key: it only lets
    CI call `POST /cp/v1/deploy/release`. Rotate by changing it in both places; nothing else is
    affected, and a leaked one still cannot forge an update (clinics check the signature).
- **Panel:** `https://settings.easymed.uz/cp/` — served by the control plane itself
  (systemd unit `easymed-cp` on the vendor server, `/opt/easymed-cp`, its own private Node 24
  runtime at `/opt/node24`, port 8095 bound to 127.0.0.1 behind nginx). Vendor login is the
  control plane's own session auth — **no Supabase anywhere in this product**.

## 4. How a clinic receives updates from this repo

1. Developers merge PRs into `main` (nothing ships from a merge).
2. The owner bumps `package.json` version, tags `vX.Y.Z`, pushes the tag.
3. `release.yml`: verifies the tag is on `main` and matches `package.json`, runs the full suite,
   builds `easymed-X.Y.Z.tar.gz` + a signed manifest via `scripts/build-bundle.mjs`
   (allow-listed contents — `data/`, `.git/`, keys physically cannot be included), attaches both
   to a GitHub Release.
4. **The same CI run publishes it** — `POST /cp/v1/deploy/release` on the control plane, bearer
   `EASYMED_CP_DEPLOY_TOKEN` (publish-only, nothing else): the tar lands in
   `EASYMED_CP_RELEASES_DIR` (nginx serves that directory at `/releases/`) and the release is
   registered and published to **ring 2 = every clinic** in one call. A failed upload fails the
   workflow; re-running it is idempotent (same version + same bundle = no-op, a different bundle
   under the same version is refused). This hand-off exists because the repo is private, so a
   clinic PC cannot pull from GitHub and must never hold credentials for it —
   `control-plane/server/routes/deploy.js` explains the whole trade-off. Rings still exist in the
   schema and the panel for narrowing or halting BY HAND; nothing is published by hand any more.
   Two failed installs auto-halt a release — with staging gone, that is the only automatic brake.
5. Each clinic's daily check-in returns the offer; the clinic **admin consents and picks the
   hour** (consent names the version — a newer offer voids old consent).
6. At the chosen hour, entirely inside the clinic's own Node process
   (`server/services/control/updater.js`, `applyUpdate()`): download (same-origin only) →
   verify signature BEFORE unpacking → unpack into `versions/<v>/` → WAL-safe DB snapshot →
   repoint the `current` junction (`fs.symlinkSync(..., 'junction')`, no admin rights) →
   write `data/update-result.json` as plain JSON → `process.exit(75)`, which the launcher
   treats as "relaunch" → outcome reported on the next check-in.

   No PowerShell, no service, no elevation. `install/apply-update.ps1` and
   `install/switch-version.ps1` were deleted 2026-08-24 — every defect that made updating
   painful lived in them (see `docs/plans/2026-08-24-node-native-updates.md`). There is no
   automatic rollback: it health-checked the OLD process on a launcher install, so it
   vouched for switches it never verified. The way back is `recover.cmd` in the clinic
   package root — a double-click that repoints `current` at the previous version, which is
   still on disk.

Proven: `v0.1.1`'s CI-signed manifest verifies against the clinic-embedded public key.

## 5. Fresh-machine setup (exact)

```
git clone https://github.com/sadyko/easymed-local.git
cd easymed-local
npm ci --ignore-scripts      # NOT plain npm install — it compiles better-sqlite3 and fails
npm test                     # ~1,880 tests; must end "fail 0" (see flake note below)
npm start                    # http://localhost:8000 — first run creates an empty data/ and
                             # prints a one-time admin password (shown once)
```

To run the control plane locally (optional — the real one is deployed):
```
cd control-plane
node ../scripts/make-licence.mjs keygen        # THROWAWAY dev key — never the production one
set EASYMED_SIGNING_KEY=<path to that .pem>
set CP_PORT=8091
node server/index.js                           # prints a one-time vendor password
```

**Env vars / files NOT in git** (create per machine; values never live in chat or the repo):

| Name | Used by | Dev value |
|---|---|---|
| `data/control.json` + `data/licence.dat` | clinic app licensing | obtained by enrolling against the panel (or hand-issued with a throwaway key via `scripts/make-licence.mjs`) |
| `EASYMED_DATA_DIR` | clinic app | unset in dev (defaults to `./data`) |
| `EASYMED_CONTROL_URL` | clinic check-in | unset (defaults to `https://settings.easymed.uz`) |
| `EASYMED_SIGNING_KEY` | control plane only | path to a throwaway keygen PEM |
| `EASYMED_CP_DATA_DIR`, `CP_PORT`, `CP_BIND` | control plane | defaults fine in dev |
| `EASYMED_RELEASE_KEY` | GitHub Actions only | already set as a repo secret; never needed locally |
| `EASYMED_CP_DEPLOY_TOKEN` | control plane **and** GitHub Actions (same value) | unset in dev — without it `POST /cp/v1/deploy/release` answers 404 and is invisible. Min 32 chars; shorter is ignored |
| `EASYMED_CP_RELEASES_DIR` | control plane | unset in dev (defaults to `control-plane/releases`). On the server it MUST be the directory nginx serves at `/releases/` |
| `EASYMED_CP_RELEASES_URL_BASE`, `EASYMED_CP_MAX_BUNDLE_BYTES` | control plane | defaults fine (`/releases`, 32 MB) |
| `EASYMED_CP_URL` | GitHub Actions only | optional; CI defaults to `https://settings.easymed.uz` |

## 6. Conventions (the short version — CLAUDE.md has the long one)

- Vanilla ES modules, no build step, no framework, no CDN imports, no emojis in UI (lucide-style
  inline SVG icons). UI strings through `i18n-strings.js` via `tr()` — **never `t()`** for
  literals, they read different tables.
- Tests: `node --test`, co-located `*.test.js`. Single file: `node --test path/to/file.test.js`.
  Whole suite only via `npm test`. TDD is the norm: failing test first.
- **Comments record WHY a line exists** — usually the bug that forced it. The project had no git
  history before 2026-08-20; comments are the archaeology. Keep writing them.
- Migrations: next free `NNN_`, never reuse or rename an applied one (`migrate.js` refuses
  duplicates; renaming an applied migration re-runs it — one of them contains a DELETE).
- Never `git add -A`. Branches + PRs into `main`; only tags release (docs/WORKFLOW.md).
- Known flake: ~1 full-suite run in 3 shows 2-3 `fetch failed / bad port` errors in
  port-binding tests — Windows ephemeral-port contention, never an assertion failure. Re-run.
  On THIS original machine only, `clinic-after-login.test.mjs` can fail on a CRLF checkout
  artifact; it does not reproduce on clean clones or CI.

## 7. Known gaps / TODO

1. **The Windows service was never once successfully registered** — the dev account had no
   administrator rights, so the SCM-reports-Running question ("Error 1053" class) was never
   answered. **Closed by abandonment, 2026-08-24:** every real install is the clinic package
   (copy the folder, double-click `EasyMed.exe`), and updating no longer needs elevation for
   anything, so `install/install-service.ps1` is RETIRED — the file carries a header saying
   so. If a service is ever genuinely wanted, that is a fresh decision to take on a machine
   that can prove it works.
2. GitHub free plan refuses branch/tag rulesets on private repos — protection is convention
   until GitHub Pro (or a public repo, which this must never be).
3. `marketing` module: in the licence vocabulary, deliberately not sellable (no screen exists —
   a clinic that bought it would see "coming soon"). Comments in `licensed-modules.js` explain.
4. The old dev folder may carry a stale name (`easymed.local` vs a planned `easymed.dev`);
   folder name is cosmetic — the repo name is the identity.
5. Cloud-era leftovers in the clinic app (easymed.uz redirect dead-ends, Symptex publication
   stubs) — listed in CLAUDE.md's "known issues".
6. ~~**Launcher-mode updates apply on the NEXT window restart, not immediately**~~ — **fixed
   2026-08-24.** The old `apply-update.ps1` stopped and started the Windows *service*; a
   launcher install has none, so the junction moved and the running node kept serving the
   old version from memory until somebody closed the window (usually the next morning).
   `applyUpdate()` now ends with `process.exit(75)`, which the launcher already treats as
   "relaunch", so a clinic is running the new version seconds after the switch.
7. The first-run **welcome-tour modal pops up OVER the activation screen** (seen driving the
   real app on 2026-08-22): a locked, never-enrolled install offers "Начать тур" on top of the
   code-entry form. Cosmetic, pre-existing, but a confusing first impression for a clinic
   mid-activation.
