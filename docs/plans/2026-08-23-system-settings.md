# Plan: Settings → «Система» — activation, subscription, backups, danger zone

Owner's assignment (2026-08-23): grow the updates settings menu into a system section with
(1) an authorization-code section, (2) subscription information, (3) a backup system —
manual + automatic, with a list of old backups and restore-from-backup, and (4) a danger
zone that deletes ALL clinic data. Owner's decisions, locked via direct questions:
- Danger zone = **full factory reset**: wipes everything INCLUDING activation; the clinic
  returns to the first-run screen and needs a fresh EM- code to work again.
- Backups = **daily automatic + manual button**, keep the last 14 daily.

## What already exists (build on it, never beside it)

| Piece | Where | Reuse |
|---|---|---|
| WAL-safe backup with exclusive-create naming | `server/db/backup.js` (`backupBeforeMigrate`, `pruneBackups`) | the same `db.backup()` + `'wx'` pattern for every new backup kind |
| Enrollment (refuses when already enrolled: `already_enrolled`) | `server/services/control/enroll.js`, `licence_enroll` RPC, `views/activation.js` | settings section shows the code field only when NOT enrolled — after a factory reset the first-run screen handles entry |
| Subscription facts | `licence_status` RPC (`state, locked, reason, days_left, modules, clinic_name`) | extend with `clinic_id`, `valid_until`, `last_checkin` |
| Immediate check-in («Проверить обновления») | updates view + ALWAYS_ALLOWED gate | the subscription card's "refresh" is the same button |
| Module vocabulary + request flow | `licensed-modules.js`, `module_request` RPC | modules list in the subscription card |
| Restart convention | launcher restarts the server on **exit code 75** | restore/reset apply on a self-triggered restart |
| Lockout exemption for route `updates` | `admin.js` renderViewInner | all new sections stay reachable while locked — backups and reset must work for a lapsed clinic |

## Design

### A. Server: `server/services/backup.js` (new; the db/ module stays the migration-rollback specialist)

- `listBackups(dataDir)` → `[{name, kind, size, mtimeMs}]`, newest first. Kinds by filename
  prefix: `pre-` (update rollback), `daily-`, `manual-`, `safety-` (pre-restore),
  `final-` (pre-reset). Only `*.db` directly in `data/backups/`; names are validated
  (`/^[A-Za-z0-9._-]+\.db$/`) — a listing must never become a traversal primitive.
- `createBackup(db, dataDir, kind)` → `db.backup()` (async, awaited) onto
  `<kind>-YYYYMMDD-HHmmss.db` claimed with `'wx'` exactly like `backupBeforeMigrate`.
- `scheduleDailyBackups(db, dataDir)` — hourly unref'd timer, each tick wrapped (mirrors
  `scheduleCheckin`): if no `daily-` backup with today's LOCAL date exists, create one,
  then prune. First tick ~5 min after boot so a morning power-on gets its backup.
- **Kind-aware pruning** `pruneBackupsByKind(dir)`: `daily-` keep 14, `manual-` keep 10,
  `safety-`/`final-` keep 5, `pre-` keep 3. Replaces the boot-time `pruneBackups(dir, 3)`
  call — the current call would let daily backups evict update-rollback points and
  vice versa. `pruneBackups` itself stays (tests + the update path use it).
- `requestRestore(db, dataDir, name)` — validate `name` against the real listing (no paths
  accepted), take a `safety-` backup of the CURRENT database first, then atomically write
  `data/pending-action.json` `{action:'restore', backup:name}`. Returns `{ok:true}`;
  the RPC layer replies and then exits 75 (below).
- `requestFactoryReset(db, dataDir, {wipeBackups})` — take a `final-` backup (always, even
  though the admin is deleting on purpose — fat fingers exist), write
  `{action:'factory_reset', wipe_backups}` marker.
- `processPendingAction(dataDir)` — runs in `server/index.js` **before `openDb`**:
  - restore: move `easymed.db` (+`-wal`/`-shm`) aside to `backups/replaced-<ts>.db*`
    (moved, never deleted — the apply-update.ps1 house rule), copy the chosen backup to
    `easymed.db`. Boot then opens it and runs any pending migrations normally (an old
    backup restored under a newer app version migrates forward on this very boot —
    that is the pre-existing, tested update path, not new machinery).
  - factory_reset: delete `easymed.db`+sidecars, `control.json`, `licence.dat`, the
    `storage/` tree (uploaded patient documents are clinic data), `pending-action.json`
    itself, and — only when `wipe_backups` — the `backups/` tree last. Boot continues
    into a virgin install: fresh DB, one-time admin password, first-run enrollment screen.
  - Malformed/unknown marker: rename it aside `.bad` and boot normally — a corrupt
    marker must never brick or wipe a clinic.
  - Marker is deleted LAST (both branches are idempotent; re-running after a crash
    mid-action is safe, losing the intent silently is not).

### B. Server: RPCs + gate (in `server/services/rpc/`, registered in `index.js` there)

- `backup_list` (admin) → listing + `data_dir` free-space note if cheaply available.
- `backup_create` (admin) → manual backup, returns the new entry.
- `backup_restore {name, password}` (admin) — bcrypt re-check of the CALLER's password
  (session alone is not enough for destroying newer data), then `requestRestore`,
  reply `{ok:true, restarting:true}`, then `setTimeout(() => process.exit(75), 500)` so
  the response flushes before the launcher restarts us.
- `factory_reset {password, confirm, wipe_backups}` (admin) — bcrypt re-check AND
  server-side `confirm === 'УДАЛИТЬ'` (the client repeats the same check; the server one
  is the real one), then `requestFactoryReset`, reply, exit 75 the same way.
- Gate: add all four to `ALWAYS_ALLOWED_RPCS` — a licence-lapsed clinic must still be
  able to save its data and a decommissioned one to erase itself; admin-and-password
  checks live in the handlers. (`backup_list` fits the READ_ONLY set's letter but
  travels with its three siblings for one findable block + one comment.)
- `licence_status` gains `clinic_id` (control.json), `valid_until` (licence payload via
  controlState), `last_checkin` (state the check-in already records).

### C. Frontend: Settings → «Система» (route stays `updates` — deep links + lockout exemption)

`settings-hub.js` label «Обновления» → «Система». `views/updates.js` becomes four cards;
every scheduling/formatting DECISION goes to pure functions in `updates-logic.js` or a new
`system-logic.js` with co-located tests (localStorage `admin.lang`='ru' pinned in fake-DOM
tests — the CI locale rule):

1. **Обновления** — the existing card, unchanged.
2. **Активация и подписка** — clinic name + ID, status badge (ok/notice/warn/locked with
   the reason wording the ladder already distinguishes), valid-until + days left, last
   check-in, modules list (enabled ✓ / «Запросить» via `module_request`). When NOT
   enrolled: the EM- code entry (same `licence_enroll` flow as activation.js — extract the
   shared piece rather than copy it).
3. **Резервные копии** — «Создать копию сейчас», then the table: date, kind (human words:
   «перед обновлением», «ежедневная», «ручная»…), size, and «Восстановить» per row.
   Restore modal: explains that everything AFTER that date disappears, that a safety copy
   of the current state is made first, asks for the admin password, warns the system will
   restart. After the RPC returns `restarting`, show a "restarting…" overlay and poll
   `/api/health` until it answers, then reload.
4. **Опасная зона** — red-bordered card at the bottom. One button «Удалить все данные
   клиники». Modal: bullet list of what dies (patients, visits, billing, documents,
   activation — "the clinic will need a NEW activation code"), checkbox «также удалить все
   резервные копии» (default OFF), type «УДАЛИТЬ», admin password, then the same
   restart-overlay flow ending on the first-run screen.

All strings through `tr()` (ru/uz/en) in `i18n-strings.js`; icons from `icons.js`
(shield/database/alert-triangle style, no emojis).

## Honest limits (say them in the UI where they matter)

- Backups cover the **database** (the WAL-safe copy). Files uploaded to `storage/` are not
  inside a `.db` backup — restoring an old backup keeps today's storage files; a factory
  reset deletes them. The backups card says this in one quiet line.
- In dev (`npm start`) exit-75 just stops the process — the restart overlay tells you to
  start it again. Under the launcher (test clinic) the restart is automatic. Under the
  Windows service the SCM restart depends on recovery settings — same known seam as
  HANDOVER §7.
- Keeping backups after a factory reset (checkbox OFF) deliberately leaves patient data in
  `backups/` — recovery-from-mistake beats clean-disk by default; the checkbox is the
  clean-disk path and its label says so.

## Tasks

1. **backup service** (TDD): `server/services/backup.js` + tests; swap boot prune call to
   kind-aware; wire `scheduleDailyBackups` + `processPendingAction` into `index.js`.
2. **RPCs + gate** (TDD): four RPCs, password re-checks, gate additions, `licence_status`
   extensions; tests including 402-gate behavior while locked.
3. **frontend**: the four cards + logic-file tests + i18n.
4. **integration**: full `npm test`; manual boot: create → list → restore → verify DB
   swapped + safety copy exists; factory reset → verify virgin first-run; then commit,
   push — and STOP: the owner decides per docs/WORKFLOW.md's release gate whether this
   becomes a release visible to clinics.

Sequential subagents, same checkout (never worktree this repo), never two test runs at
once, port-flake note applies.
