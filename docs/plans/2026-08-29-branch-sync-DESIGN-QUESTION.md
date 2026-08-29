# Branches as separate installs, synchronised

> **The question in this document is ANSWERED.** The owner decided on
> 2026-08-29: **Route A** (branches talk to each other directly; the vendor
> never sees clinical data) and **Stage 1 only** (non-clinical catalogue, pushed
> out from one main branch). Stage 1 is built — see «What was actually built» at
> the bottom. Everything above that section is kept as written, because it is
> the record of *why* the shape is this shape.
>
> **AMENDED, same day.** The owner then asked for **Route B as well — as an
> option alongside A, not instead of it**: «build Route B as an option alongside
> A. so when we edit the company and add branch, when setup, we activate the
> clinic, and add another option so when activating the clinic generates unique
> key for synchronization, which was created with activated, and generates + add
> a branch». Route B is built — see «Route B, as built» at the very bottom. A is
> still tried first, every time; B only runs when A cannot reach the main branch.

Owner (2026-08-29): «in the branches we should build the local version of the
branch, with the synchronization by settings.easymed.uz based off a key … in the
branches we should fetch the services, patients, laboratory (with payments and
panels) and inputting the results of the lab, and the company information and
the reports for each of the branch»

## What already exists (so we do not rebuild it)

Branches work TODAY inside one install: `branch_id` on 8 tables (users,
patients, visits, invoices, stock_movements, cash_shifts, patient_deposits,
user_branches), a branch picker, and BRANCH_ISOLATION_V1/V2 so staff see only
their branch while admins see all. One database, many branches, one building.

What the owner is asking for is different: **each branch runs its own local
install on its own PC**, and they share data. That is a distributed system, not
a filter.

## THE CONFLICT — decided: Route A

His own founding constraint for the control plane, stated at the start of this
project and never withdrawn:

> statistics and subscription control live at settings.easymed.uz — but
> **«NOT PERSONAL DATA OF THE PATIENTS»**

Everything built since honours it: the check-in sends counters (how many
patients, how much billed), never a name, never a diagnosis. The vendor server
has no patient data on it today, by design.

Syncing patients and lab results BETWEEN branches THROUGH settings.easymed.uz
would put patient records on the vendor's server. That contradicts the rule.

Three ways to have both. **The owner chose A.**

**A. Branches talk to each other directly. ← CHOSEN, 2026-08-29**
settings.easymed.uz only does introductions: it holds the pairing key and each
branch's address, and never sees clinical data. The branches sync over the
clinic's own network or VPN.
*Patient data never leaves the clinic's own machines — the rule holds exactly.*
Cost: the branches must be able to reach each other. Fine on one LAN or with a
VPN between sites; impossible if two branches are on unrelated internet
connections with no VPN.

**B. The vendor server relays, but cannot read.** — *not chosen then; BUILT
later the same day as a fallback, see the bottom of this file.*
Each clinic holds an encryption key the vendor never has; the server stores and
forwards opaque blobs. Works between any two sites with internet.
*The rule holds in substance — the vendor cannot read patient data — but the
bytes do sit on the vendor's disk, and if the clinic loses its key the data is
unrecoverable.*
Cost: real key management, and the owner can never help a clinic recover data.

**C. The vendor server stores it in clear.** — refused.
Simplest to build, and I would not build it. It makes Easy-Med a processor of
medical records for every clinic, changes the legal position entirely, and
breaks the promise the product was designed around.

## The other decisions A or B still need

1. **Direction.** *Settled for Stage 1: one-way.* One branch is the MAIN branch
   and the others receive a copy. Two-way is much harder: two receptionists
   editing the same patient in different buildings must not silently lose one
   edit — that question returns at Stage 2.
2. **What syncs, and what does not.** *Settled for Stage 1:* services, panels,
   company info and price lists — small and rarely changing. Patients (70,119
   rows here today), visits, lab results and payments are large and constantly
   changing, and are explicitly out. Money is the dangerous one: an invoice that
   syncs twice is a real accounting error.
3. **Offline.** These installs are offline-first by design. A branch that was
   disconnected for a day must catch up without a human resolving conflicts by
   hand. *Stage 1 satisfies this trivially: the receiver pulls whenever it can,
   and an unreachable main branch is a calm "try later", never an error state.*
4. **Reports per branch.** Straightforward once the data is there; it is the
   data-sharing that is hard, not the reporting. Still Stage 3.

## Honest sizing

Parts 1–3 of the owner's message (Subscription screen, System screen, Company)
are a session's work and were done then.

This part is not. A correct two-way sync of medical and financial records across
sites is weeks of work, and the failure modes are the expensive kind: a
duplicated invoice, a lab result attached to the wrong patient, an edit silently
lost. It should be built in stages, smallest first:

- **Stage 1 — DONE (2026-08-29).** One-way, non-clinical: company info,
  services, lab panels, price lists pushed from a main branch to the others.
  Low risk, immediately useful, and it proves the pairing and transport.
- **Stage 2** — patients, one direction, with a real merge rule for the same
  person registered twice.
- **Stage 3** — visits, lab results, payments. Only after 1 and 2 have run in a
  real clinic for a while.

---

# What was actually built (Stage 1, BRANCH_SYNC_V1)

## The shape

```
MAIN branch                                    SECONDARY branch
(one PC, one install)                          (another PC, another install)

  Настройки → Филиалы                            Настройки → Филиалы
  «Сделать главным филиалом»                     «Подключить к главному»
        │                                                │
        │  ключ EMB1-…  ── owner carries it ──────────►  │
        │  (group + address + shared secret)             │
        ▼                                                ▼
  data/branch-sync.json                          data/branch-sync.json
  {role:'main', …}                               {role:'secondary', …}

  GET /api/branch-sync/catalogue  ◄──── PULL, signed with the shared secret
        │                                (HMAC-SHA256 over group + timestamp + path,
        │                                 compared in constant time)
        └── справочник only ──────────────────────────►  one transaction,
                                                         after a DB snapshot
```

Nothing reaches settings.easymed.uz. The vendor is not in this loop at all.

A **pull**, not a push, deliberately: the receiver decides when (a clinic syncs
outside consulting hours), no branch needs an inbound port opened to the
internet, and the direction of the data matches the direction of trust — the
branch that will be changed is the one that asks, and the one that takes its own
snapshot first.

## What syncs — exactly these tables and columns, and why

The list is compiled into `server/services/branch-sync/catalogue.js`. The
exporter can emit nothing else: it is a fixed list, not a filter over "whatever
happens to be in the table". Same guarantee style as STATS_V1's counter
catalogue, and it is pinned by a test that seeds a marker patient (name,
complaint, invoice number, invoice line, lab note) into the source database and
asserts the marker appears nowhere in the transferred bytes.

| Table | Columns | Why it is in |
|---|---|---|
| `doc_settings` (id=1) | `clinic_name, license, logo_data_url, accent_color, paper_size, show_watermark, footer_note, legal_note` | The clinic's identity — `rpc/clinic.js get_clinic_by_slug` builds `window.CLINIC` from it, and every print form is signed by it |
| `services` | `name, code, price, tax_rate, duration_minutes, requires_doctor, active, is_lab, specimen, result_unit, ref_low, ref_high, ref_text, type, type_id, category_id, department_id, tube_color` | The price list. `services.price` is the only price column in this schema that belongs to the catalogue |
| `lab_panels` | `name, code, modality, has_narrative, service_id, core_panel_id, active` | The panels |
| `lab_panel_analytes` | `panel_id, code, name, unit, value_type, value_options, decimals, ref_low, ref_high, ref_text, ref_low_m, ref_high_m, ref_low_f, ref_high_f, group_label, sort_order, ref_ranges, active` | The analytes **including reference ranges** — what the owner asked for |
| `service_types` | `name, code, billing_mode, active` | FK parent of `services.type_id` |
| `service_categories` | `code, name, parent_id, description, active` | FK parent of `services.category_id`; self-referencing, so `parent_id` is set in a second pass once every category has a local id |
| `departments` | `name, code, kind, active` | FK parent of `services.department_id`. `foreign_keys` is ON (`db/connection.js`), so a service could not be inserted without it. Non-clinical: a name, a code, a kind. Staff are NOT carried — only the departments themselves |

### Deliberately left out

- **Everything clinical:** `patients`, `visits`, `visit_services`, `lab_results`,
  `invoices`, `invoice_items`, `payments`, `patient_deposits`, `admissions`,
  `cash_shifts`, `crm_requests`… Stage 2/3.
- **`doc_settings.address` / `.phone` / `.email`.** The owner said "company
  information", and these are in that row — but they are the *branch's own*
  contact details, printed at the top of every document that branch issues.
  Copying the main branch's address onto the second branch's letterhead would
  send patients to the wrong building. Per-branch address and phone already have
  a home: the `branches` table, which exists for exactly this. **This is the one
  place where what is built is narrower than the owner's words, and it needs his
  yes.**
- **`consultation_types.price`, `wards.price_per_day`, `beds.price_per_*`,
  `products.sale_price`, `doctor_rates.percent`, `doctor_consultation_prices`.**
  They carry money but are not the price list: ward and bed rates belong to the
  building, stock prices to that branch's own inventory, and doctor rates are
  staff pay. Adding any of them is a one-line change to `TABLES` when the owner
  asks.
- **`users`, `user_branches`, `roles`, `role_permissions`.** Staff accounts are
  not catalogue, and copying logins between buildings is a security decision, not
  a sync decision.

## The three rules of applying a catalogue

1. **Rows arrive under the RECEIVER's own ids.** `branch_sync_map` (migration
   079) records "main branch row 7 = our row 512". Carrying the main branch's
   ids across would silently rewrite the meaning of every invoice line the
   receiving branch has already issued — that is the whole reason the map table
   exists, and the reasoning is written into the migration itself.
2. **Nothing is ever deleted.** A row the main branch does not have is left
   exactly as it is: the branch may already have invoices against it, and hiding
   it (`active = 0`) would stop the branch selling something it really performs.
   Retiring a service still works — the main branch sets `active = 0` itself and
   that arrives as an ordinary update.
3. **Adopt before insert.** A branch that already typed its own price list would
   otherwise end up with two of everything on the first sync. An unmatched
   incoming row looks for a local row with the same `code` (or, with no code, the
   same name); it adopts only when there is exactly ONE unclaimed candidate.
   Ambiguity inserts a new row rather than guessing which of two identically
   named services to reprice. This also handles what every pair of fresh installs
   has in common: the six seeded service types, the six seeded departments and
   the seeded LAB-CBC service, which are the same rows with different ids.

Before anything is applied: a full database snapshot via
`services/backup.js createBackup(db, dataDir, 'safety')` — the same copy the
restore flow takes, listed on Настройки → Данные клиники, pruned by kind. Then
one transaction: the whole catalogue or none of it. A dry run (the same code with
writing switched off) decides first whether anything would change at all, so a
sync with nothing to do takes no snapshot and writes nothing.

## Deviations from the brief, and why

1. **The pairing key is minted by the MAIN BRANCH, not by
   settings.easymed.uz.** Route A says the vendor is "only an introducer", and
   for Stage 1 the introduction carries nothing the key cannot carry itself: the
   group id, the main branch's address and the shared secret all fit inside the
   key the owner has to move by hand anyway. Taking the vendor out of the loop
   makes pairing work in a clinic with no internet at all — the property this
   whole product exists for — and means the vendor's server never learns even a
   clinic's LAN address. The introducer's place is kept open: the pairing record
   stores `source: 'manual'`, and a vendor-issued key would change nothing about
   the transport. It becomes worth building when two branches sit on unrelated
   connections and need address DISCOVERY, which is the only thing a directory
   actually buys.
2. **The snapshot is `services/backup.js`, not `db/backup.js`.** The brief named
   `db/backup.js`; that module is the migration-rollback specialist and its own
   comment reserves the `pre-` kind for the update path. `services/backup.js` is
   the same `db.backup()` implementation with the clinic-facing kinds and
   retention, and `'safety'` means exactly "about to do something risky". No
   second backup implementation was written.

## Files

- `server/db/migrations/079_branch_sync.sql` + `079.test.js`
- `server/services/branch-sync/pairing.js` (+ `pairing.test.js`)
- `server/services/branch-sync/catalogue.js` (+ `catalogue.test.js`)
- `server/services/branch-sync/pull.js` (+ `pull.test.js`)
- `server/services/branch-sync/sync-e2e.test.js` — two real installs, two ports
- `server/routes/branch-sync.js` — the main branch's serving endpoint
- `server/services/rpc/branch-sync.js` — the five RPCs
- `public/js/admin/branch-sync-logic.js` (+ `__tests__/branch-sync-logic.test.mjs`)
- `public/js/admin/views/branch-sync.js` — the card on Настройки → Филиалы
- wiring: `server/app.js`, `server/services/rpc/index.js`,
  `server/services/control/gate.js`, `public/js/admin/views/settings-hub.js`,
  `public/js/admin/i18n-strings.js`, `public/css/admin-views.css`

## Known limits of Stage 1

- **One secret per group.** Every branch shares it, so revoking one branch's
  access means re-issuing the key for all of them. Acceptable while the only
  thing the secret unlocks is a read of the non-clinical catalogue.
- **Plain HTTP on the clinic's own network.** The secret never travels (only an
  HMAC of it does) and the payload is a price list — but on a network the clinic
  does not control this wants HTTPS or a VPN. Say so when the first multi-site
  clinic is set up.
- **No automatic schedule.** Synchronising is a button. A timer is a small
  addition once the owner has watched the button behave for a while.
- **Branch `reports`** (part 4 of the owner's message) are untouched: they need
  Stage 2/3 data before there is anything to report.

---

# Route B, as built (BRANCH_SYNC_RELAY_V1, 2026-08-29)

Route A stayed exactly as it was. Route B is a **fallback underneath it**, for
the one situation A cannot cover: two branches on unrelated internet
connections, with no VPN, that simply cannot see each other.

## The shape

```
MAIN branch                    settings.easymed.uz              SECOND branch
                               (holds bytes it cannot read)

 catalogue.js exporter                                          Синхронизировать
   (the SAME fixed list)                                              сейчас
        |                                                               |
   AES-256-GCM seal                                            1. try DIRECT ──┐
   with the group key                                             (Route A)    |
        |                                                               |      |
        └── PUT /cp/v1/relay/<id> ──► [ relay_blobs.bytes ]              | unreachable
            Bearer <install_token>     one row per group                 |      |
                                              |                          |      ▼
                                              └── GET ◄──────────── 2. RELAY (B)
                                                                         |
                                                                  open + verify tag
                                                                         |
                                                        snapshot, then ONE transaction
```

The key never touches the middle column. It is generated **when the clinic is
activated** and reaches the second branch **only inside the pairing key the
owner carries by hand**.

## Where the key lives, and where it does not

| | |
|---|---|
| Born | `services/control/enroll.js`, at activation, right after `control.json` and `licence.dat` — the owner's own instruction |
| Stored | `data/sync-group.json` — `{group_id, key, created_at}`, beside the licence, in the gitignored data directory an update never touches |
| In use | copied into `data/branch-sync.json` as `group_key` when the install becomes the main branch; arrives there from the pairing key on the second branch |
| Travels | inside the `EMB1-…` pairing key, hand-carried. Nowhere else |
| Never | the enrollment request, the daily check-in, the stats payload, the screen status RPC, a log line |

**An install enrolled before this change is not stranded**: `ensureSyncGroup()`
mints one lazily the first time the Branches screen issues or accepts a key. An
already-paired branch keeps working on Route A, and the screen says plainly that
the fallback needs a re-issued pairing key.

## The crypto, exactly

- **AES-256-GCM.** Not CBC/CTR: a blob corrupted or swapped on the vendor's disk
  must be refused *whole*, and GCM's tag makes that one operation rather than a
  second mechanism bolted on.
- **32-byte key**, `randomBytes(32)`, base64url on disk.
- **12-byte IV, fresh random per upload.** Never derived, never reused —
  repeating an IV under one key breaks GCM outright. Pinned by a test that
  publishes the same catalogue twice and asserts the bytes differ.
- **16-byte tag**, full length, verified before anything is decompressed or
  parsed. `decipher.final()` throwing *is* the check; everything else is
  downstream of it.
- **AAD = the 4-byte format marker `EMR1`**, so a v1 blob cannot be replayed as
  some future v2.
- **gzip before encrypt** (`node:zlib`) — the catalogue carries the clinic logo
  as a data-URL. Decompression is bounded (`maxOutputLength`) even though the
  tag has already proved the blob is ours.
- **Blob address = `HMAC-SHA256(group key, "easymed/branch-sync/relay-id/v1")`**,
  truncated to 16 bytes. Deliberately *not* the `group_id` the owner sees on
  screen: the address is the only handle anyone could use to ask the vendor for
  a blob, so it is derived from a 256-bit secret — unguessable, and yielding
  nothing about the key. A re-issued key moves the group to a new address for
  free, orphaning the old blob for the retention sweep.
- **No new dependency.** `node:crypto` and `node:zlib` only.

## What the vendor stores, and what it can tell

Control-plane migration **`005_relay_blobs.sql`**. The clinic app's own chain is
untouched — no new clinic migration; 079 is still the highest there.

One row per branch group: `relay_id`, `clinic_id`, `bytes` (BLOB), `size`,
`updated_at`, `read_at`. There is deliberately **no column that could hold a
service, a price, a patient, or anything decrypted** — that guarantee is a
property of the schema, and `005.test.js` asserts the column list so adding one
has to be argued for.

`routes/relay.js` authenticates with the clinic's `install_token` — the same
credential and the same lookup as the daily check-in, with one generic 401 for
missing, malformed, unknown and deactivated, so nobody can probe which tokens
are live. Mounted above the 100kb JSON parser (like `/cp/v1/deploy`) so it
authenticates *before* buffering megabytes, and above `attachVendorUser` so a
vendor panel session buys nothing. `express.raw` in, BLOB out; the payload is
never parsed, transcoded or inspected.

**The vendor can see:** which install uploaded or downloaded, when, how many
bytes, and that some set of installs share one relay id.
**The vendor cannot see:** anything inside — not a service name, not a price,
not even the clinic's own name.

**Retention:** a blob untouched — neither uploaded nor downloaded — for 30 days
is deleted. Counted from the last touch, never the upload alone, so a clinic
whose price list has not changed in six weeks but reads its copy daily is not
swept away. Run on every upload; there is no scheduler to forget.

## How A-then-B decides, and what the owner sees

The receiving branch always tries the direct pull first. The fallback runs only
for reachability failures — `offline`, `server_error`, `not_main`,
`bad_response`, `too_large`.

**The exclusions are the point.** `unauthorized` and `clock_skew` never fall
back: those are real faults the owner must fix, and quietly serving him
yesterday's copy would hide exactly the breakage he opened the screen to find.
`not_paired` / `not_secondary` never fall back either — there is nothing to
fetch.

| Outcome | The line on Настройки → Филиалы |
|---|---|
| Never synced | «Синхронизации ещё не было.» |
| Direct | «Синхронизировано 29.08.2026 09:00 — **напрямую**.» + what changed |
| Relayed | «… — **через сервер Easy-Med (зашифровано)**. Копия главного филиала от 28.08.2026 06:15.» + what changed |
| Both failed | the direct reason first (it is the one to fix), then «Резервный канал тоже не сработал: …» |
| Key mismatch | «Ключи филиалов не совпадают… получите новый ключ подключения» — the relay reason leads, because it knows something the direct path does not |
| Nothing published | «На сервере пока нет копии справочника. Включите отправку копии в главном филиале.» — a sentence about the *other* machine |
| No key | «У этого филиала нет ключа синхронизации…» |

Naming the route even on success is deliberate: a clinic paying for a VPN
between two buildings must be able to see that its catalogue has quietly been
going through the vendor for six months.

## Consent, and the honest warning

- **Main branch: off by default.** It is the side that sends bytes out of the
  clinic, and that is the owner's decision to make, not a default.
- **Second branch: on by default.** It sends nothing, only reads, and only after
  the direct path failed — and if the main branch never consented, there is
  nothing there to read.
- The card carries, permanently and not as an after-the-fact apology:
  «Easy-Med не хранит ваш ключ синхронизации и не может прочитать переданные
  данные — а значит, не сможет и восстановить их, если ключ будет потерян.»
- **Re-issuing the key** rotates the encryption key *and* the Route A signing
  secret together, so "this will disconnect every branch" is true rather than
  half-true. The confirm dialog says so, and says the old key cannot be
  recovered by anyone, Easy-Med included.

## Who uploads, and when

A pull cannot work here — the branch that needs the copy is by definition the
one that cannot reach the main branch — so the main branch publishes ahead of
time: `scheduleRelayPublish()` in `server/index.js`, 90 s after boot (behind the
check-in) and every 6 hours, uploading only when the catalogue's content hash
changed or the copy is over a day old. Plus a manual «Отправить копию сейчас»,
which always uploads: a button that decides nothing needed doing reads as a
broken button.

## Honest limits of Route B

- **A relayed catalogue is a COPY, not today's data.** Its age is on screen for
  exactly that reason.
- **Lose the key and the data is unrecoverable. The vendor cannot help.** That
  is the price of the vendor not being able to read it, and it is stated in the
  UI before the owner relies on it.
- **Re-issuing the key does not instantly cut a branch off if the main branch is
  also unreachable.** The branch keeps reading the *old* blob until retention
  removes it — frozen, never updated again, with its age visible. Direct sync is
  refused immediately, because the signing secret rotated too. Pinned by a test
  so nobody meets it by surprise.
- **Unpairing does not delete the blob.** It expires with retention (30 days).
  The vendor still cannot read it; a branch still holding the key could read a
  stale catalogue until then.
- **Metadata is real.** The vendor learns that two installs belong to one group
  and how often they sync. Not what is in the catalogue.
- **One key per group**, like Route A's one secret per group: revoking one
  branch means re-keying all of them.
- **Stage 1 only, unchanged.** Route B moves the SAME catalogue Route A moves —
  it reuses `catalogue.js`'s exporter verbatim and adds no second payload
  builder. Patients, visits, lab results and money are still Stage 2/3 and are
  in neither route.

## Files (Route B)

- `server/services/branch-sync/sync-group.js` — the key at activation, wired in
  `server/services/control/enroll.js`
- `server/services/branch-sync/relay-crypto.js` (+ `relay-crypto.test.js`)
- `server/services/branch-sync/relay.js` (+ `relay.test.js`) — transport,
  background publish, scheduler
- `server/services/branch-sync/relay-e2e.test.js` — two installs and a real
  control plane, three ports
- `control-plane/server/db/migrations/005_relay_blobs.sql` + `005.test.js`
- `control-plane/server/routes/relay.js` + `relay.route.test.js`
- extended: `pairing.js` (group key inside the pairing key, `relayEnabled`,
  rotation), `services/rpc/branch-sync.js` (the fallback + 3 RPCs),
  `public/js/admin/branch-sync-logic.js`, `views/branch-sync.js`
- wiring: `server/index.js`, `services/rpc/index.js`,
  `control-plane/server/app.js`, `i18n-strings.js`, `control-plane/README.md`
