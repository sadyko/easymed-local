# Control plane v2 — permanent delete, and a panel you can run the business from

Design, 2026-09-05. Successor to `docs/specs/2026-08-20-control-plane-design.md`, which
built the registry and the first panel. That panel shipped two screens (Clinics, Requests)
over an API that had grown to eighteen routes. This one closes the gap and adds the delete
the owner asked for.

## The ask

Two sentences from the owner:

1. "Can we add delete the retired clinic option?"
2. "Make a more appealing dashboard to be able to full control."

Both are reasonable and both were blocked on something real, not on effort.

## Scope decision: installed clinics only

The owner asked, mid-design, whether "live clinics" meant cloud clinics like corelmed. It
does not, and the confusion is worth recording because it will recur.

Two unrelated systems run on 45.77.242.169:

| | EasyMed Cloud | EasyMed Local |
|---|---|---|
| Service | `easymed-api` (FastAPI, :8001) | runs on the clinic's own PC |
| Reached at | easymed.uz | `EasyMed.exe` on a desktop |
| Data | Supabase, in the cloud | the clinic's own disk |
| Licensing | none — access is a login | signed licence, renewed daily at check-in |
| This panel sees it | **no** | **yes** |

The control plane exists because an *installed* copy needs licensing, remote shut-off and
update delivery. A cloud tenant needs none of that. **This panel stays scoped to installed
clinics.** Merging the two fleets into one dashboard was considered and rejected for now: it
needs live Supabase access (those tokens are revoked) and roughly doubles the work.

A consequence to state plainly: the dashboard's "live clinics" number counts installed boxes.
Today that is mostly the owner's own dev and test machines. Three rows — `corelmed`
(c-000001), `Тестовая клиника` (c-000004) and `Dilshods Dev Server` (c-000006) — were created
with enrollment codes that were never claimed and have never checked in. They are placeholders,
not clinics. They are deliberately **not** cleaned up as part of this work; once stage ① ships
the owner retires and deletes them through the new UI, which is a better first exercise of the
button than a hand-edit on production.

## 1 · Permanent delete

### Why there is no delete today

`routes/admin.js` carries an explicit refusal, and it is correct. `nextClinicId()`
(`routes/admin.js:126`) allocates the next id as *highest numeric suffix seen in the clinics
table, plus one*. Delete `c-000009` and the next clinic created is also `c-000009`. The
deleted clinic's signed licence file is still sitting on its old computer, and
`services/control/licence.js` verifies a licence by `clinic_id` — so that stale file would
verify against the new clinic and grant it whatever the old one was entitled to.

`migrations/001_registry.sql` names this exactly and pins the un-guarded behaviour in
`migrations/001.test.js`: deleting and re-inserting the same `clinic_id` is possible today.

### The fix: a tombstone table

`migrations/010_deleted_clinics.sql`:

```sql
CREATE TABLE deleted_clinics (
  clinic_id  TEXT PRIMARY KEY,
  name       TEXT,            -- last known name, so the audit row is readable
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_by TEXT             -- vendor_users.username
);

-- Second line of defence, at the schema level, exactly as 001 is the second
-- line behind "this registry holds no patient data". Application code must
-- consult this table; a trigger means it cannot forget.
CREATE TRIGGER clinics_no_resurrection
BEFORE INSERT ON clinics
WHEN EXISTS (SELECT 1 FROM deleted_clinics WHERE clinic_id = NEW.clinic_id)
BEGIN
  SELECT RAISE(ABORT, 'clinic_id was permanently deleted and can never be reissued');
END;

-- Shown on a retired card ("Retired 31 Aug 2026"). NULL for clinics retired
-- before this migration — rendered as "date unknown", never as today.
ALTER TABLE clinics ADD COLUMN retired_at TEXT;
```

`nextClinicId()` changes to scan `clinics UNION deleted_clinics`, so a deleted number is never
even offered. The trigger catches everything else: a hand-written INSERT, a future route, a
restored backup being replayed.

### `DELETE /cp/v1/admin/clinics/:id`

One transaction. Refuses, with a distinct message for each case:

| Condition | Response |
|---|---|
| clinic not found | 404 |
| `active = 1` | 409 — "Retire this clinic before deleting it." |
| has filials (`parent_clinic_id = :id`) | 409 — "This clinic has N filials. Delete or reassign them first." |

That third check is not optional politeness. `foreign_keys = ON`
(`server/db/connection.js:17`) and `clinics.parent_clinic_id REFERENCES clinics(clinic_id)`
carries no `ON DELETE` clause, so deleting a parent with filials raises a raw
`SQLITE_CONSTRAINT_FOREIGNKEY`. Without the check the owner sees a database error string.

On success:

- `DELETE FROM clinics WHERE clinic_id = ?` — `clinic_modules`, `relay_tokens` and
  `relay_blobs` all declare `ON DELETE CASCADE` and are cleaned up by the engine.
- `INSERT INTO deleted_clinics (...)`.
- `checkins` is **kept**. It has no foreign key precisely so history survives a deleted row
  (`migrations/001_registry.sql`: "that is what you look at when someone disputes a bill").
- `module_requests` is likewise kept; `GET /requests` already LEFT JOINs for this case.

### In the panel

`Delete permanently` appears in a card's ••• menu **only when the clinic is already retired**,
so it is always a two-step decision. The confirmation dialog states what is kept — the check-in
history, and the id, reserved forever — and requires the clinic's name to be typed. Retired
clinics live behind a `Show retired` toggle, so the option is rarely on screen by accident.

## 2 · The panel

Six screens behind the existing left rail. Layout and density were chosen by the owner against
mockups (`.superpowers/brainstorm/`): a **card board**, not a table, with **rich** cards.

### Visual system

Warm clinical, from the owner's reference: cream ground `#FAF6EF`, white cards, soft amber
accent `#F2C14E`, ink `#2A2621`. Semantic states are muted, never alarm-red: `#5B8C6E` ok,
`#D98E4A` warning, `#C4645A` danger. 13px card radius, generous padding. Inline SVG line
icons, matching the existing rail mark; **no emoji anywhere**. Panel stays in **English** —
the owner chose not to translate it.

`panel.css` grows a `:root` token block; every screen reads tokens, never literals.

### Clinics — the board

Cards, three across on a wide screen, responsive down to one. Grouped into bands:

1. **Needs attention** — quiet for >7 days, subscription ending within 30 days, or a reported
   failure on its current release. Amber ring.
2. **Live**
3. **Retired** — dimmed, behind the toggle.

Each card carries: status dot, name, id, filial line ("filial of test for sodiq" / "2 filials"),
version with a `current` / `N behind` / `far behind` chip, subscription, last seen, a stats
strip (patients, visits today, billed today) and module chips. ••• menu: Open, Unlock code,
Hold on version, Retire — or, when retired, Open and Delete permanently.

The stats strip renders **`—`, never `0`**, for a clinic that has no figure to show. Three
distinct situations produce that: a clinic that has never enrolled (three such rows exist
today), one whose `collect_set` excludes that counter, and one running a version older than
the counter itself — `metrics.js` skips unknown names silently by design. A zero here would
read as "this clinic billed nothing today", which is a different and alarming claim.

Above the board: search, a **Compact** toggle that strips cards to name/version/last-seen for a
larger fleet, `Show retired`, and `+ New clinic`.

### Dashboard

Four tiles (live, gone quiet, open module requests, how many are on the newest version), the
rollout progress of the newest release, the attention cards, and a fleet totals strip —
patients, visits today, billed today, summed across clinics.

### Updates

Every release with its ring, halted state and reported success/failure counts. Publish to
ring 0 → 1 → 2 in one click each, and a prominent **Stop this release**. All four routes
(`POST /releases`, `/publish`, `/halt`, `/unhalt`) already exist and have never had a screen —
0.7.2 and 0.8.0 were published from a shell.

### Branches

Parent clinics with filials nested beneath, each showing sync state and last exchange, and a
vendor-side re-issue of a filial's activation code.

### Money

Clinics ordered by subscription end date, next 30 days flagged, with billed / collected /
outstanding per clinic from the counters they already report.

## 3 · Server changes

New:

- `DELETE /admin/clinics/:id` (above).
- `POST /admin/clinics/:id/reissue-code` — vendor-authenticated wrapper over
  `reissueEnrollmentCode()`. The existing `/cp/v1/branch/:id/reissue` is clinic-facing: it
  authenticates with the *parent's* install token, which the vendor does not hold.

`GET /admin/clinics` gains `parent_clinic_id`, `filial_count`, `ring`, `pinned_version`,
`retired_at`, `latest_stats`, `latest_stats_at`.

That last pair needs care. `latestStats()` (`routes/admin.js`) iterates a clinic's check-ins
newest-first until it finds one carrying stats — per clinic. Called in the list loop that is
today O(1) per row, it becomes N scans. It is rewritten as **one grouped query** over
`checkins`, joined once. The existing per-clinic version stays for `GET /clinics/:id`.

Dashboard totals and band assignment are computed **client-side** from `/admin/clinics` and
`/admin/releases`. No aggregate endpoint: two fetches the panel already makes are enough at
this fleet size, and an endpoint would be a second place for "what counts as gone quiet" to
be defined. `panel-logic.js` — already pure and already tested — is where those rules live.

## 4 · How it is built and shipped

Plain ES modules and hand-written CSS, exactly as the panel is today. **No build step, no
framework, no new dependency.** This is not nostalgia: `/opt/easymed-cp` is not a git checkout,
and deployment is `scp` the changed files plus `systemctl restart easymed-cp`. A bundler would
put a build artefact between the repo and the server with nothing to verify it.

Screens stay one file each (`panel-dashboard.js`, `panel-updates.js`, `panel-branches.js`,
`panel-money.js`, alongside the existing four), with every decision delegated to pure functions
in `panel-logic.js`. `panel-clinic-detail.js` is 16 KB and gaining a ring/pin section; its
unlock-code tool moves to `panel-unlock.js` in the same pass.

## 5 · Testing

- **Migration 010** — a `010.test.js` alongside its siblings, pinning: the trigger rejects a
  re-insert of a deleted id; `nextClinicId` skips deleted ids; the migration is idempotent.
- **The delete route** — the refusals (live clinic, clinic with filials, unknown id); the
  cascade (modules, relay tokens, relay blobs gone); the survivals (check-ins, module requests
  present); and the resurrection attempt: delete `c-000009`, create a clinic, assert it is
  **not** `c-000009` and that force-inserting the old id aborts.
- **`panel-logic.js`** — band assignment, "N behind", stat formatting, retired-date fallback,
  as pure-function tests in the existing file.
- Full suite green before any deploy: `node --test $(find control-plane -name "*.test.js" ...)`.
  452 tests pass today (2026-09-05); the directory-argument form of `node --test` is broken on
  Windows/Node 24, so the file list is explicit.

## 6 · Order of work

| Stage | Contents | Usable on its own |
|---|---|---|
| ① | migration 010, delete route, tombstone guard, the card board, visual tokens | yes — delete works, board replaces the table |
| ② | Dashboard, Updates screen, per-clinic ring and pin | yes — publishing stops being a shell task |
| ③ | Branches, Money | yes |

Each stage ends green and is deployed by the recipe in `easymed-local-repo` notes: back up
(`cp -a` plus `db.backup()`), `scp` the files, restart, then curl probes on 127.0.0.1:8095.

## Out of scope

- Cloud (`easymed-api`) clinics — decided above.
- Undoing a retire. There is no un-retire route today and this design does not add one;
  reversing a retire remains a deliberate server-side action.
- Undoing a delete. The tombstone makes the id permanently unusable by design, so a deleted
  clinic cannot be restored under its old identity even from a backup.
- Hashing credentials at rest. `relay_tokens` argues this correctly: `install_token` would
  have to be hashed first, and that is its own piece of work.
