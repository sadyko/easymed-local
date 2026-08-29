# Branches as separate installs, synchronised

> **The question in this document is ANSWERED.** The owner decided on
> 2026-08-29: **Route A** (branches talk to each other directly; the vendor
> never sees clinical data) and **Stage 1 only** (non-clinical catalogue, pushed
> out from one main branch). Stage 1 is built — see «What was actually built» at
> the bottom. Everything above that section is kept as written, because it is
> the record of *why* the shape is this shape.

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

**B. The vendor server relays, but cannot read.** — not chosen.
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
