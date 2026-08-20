# Easy-Med Control Plane — Design

**Date:** 2026-08-20
**Status:** approved by owner in session (offline rule, grace length, lock behaviour, statistics scope, update timing, rollout rings)
**Scope:** a vendor-side panel at `settings.easymed.uz`, plus three new modules inside every local Easy-Med install.

---

## Context

Easy-Med Local is a fully offline clinic system: one PC at the clinic runs it, other PCs use it
over the LAN, and no internet is required. That is the product's core promise and this design
must not break it.

But an offline product sold as a subscription needs three things the current build has none of:

1. **The vendor cannot see anything.** No idea which clinics are running, on what version, or
   whether they are in trouble.
2. **The subscription is unenforceable.** Nothing stops a clinic from using every module forever
   without paying.
3. **Updates require a site visit.** New versions, bug fixes and design changes reach a clinic
   only if someone physically goes there.

This spec adds a control plane that solves all three without weakening the offline promise.

## Goal

A clinic keeps working with no internet. The vendor gets licensing, visibility and remote
updates. Patient data never leaves the clinic's computer.

---

## Decisions made with the owner

Recorded verbatim so later work does not relitigate them.

1. **Lapsed subscription locks the functions, not the login.** Staff can still log in and read
   existing records. They cannot create, edit or export. An admin can always reach the
   activation screen — that is the whole reason login stays open.
2. **Grace period: 14 days** from the last successful check-in.
3. **Phone unlock is mandatory.** A clinic with no internet must be able to recover by reading a
   code over the telephone.
4. **The licence is cryptographically signed.** Editing the local database must not unlock
   anything. *(Decided by Claude and accepted: the owner chose the strongest lock available, and
   a lock a database editor can undo in five minutes would make that choice meaningless.)*
5. **Statistics: errors/crashes and revenue volume** to start. The owner will name more later, so
   the collected set must be changeable from the panel without shipping a new version.
6. **No patient personal data ever leaves the clinic.** Owner's explicit instruction. Enforced
   structurally, not by policy — see §6.
7. **Updates are consent-gated and install overnight.** The admin approves; the install happens
   at 03:00. There is no forced channel: the vendor cannot push an update a clinic has not
   approved.
8. **Staged rollout from day one** — releases go to a small ring first and halt automatically on
   failures.
9. **The control plane is a standalone service.** Not bolted onto the existing Easy-Med CORE
   gateway. *(That gateway hung twice in August 2026 and took symptex.uz down with it. If
   licensing rode on it, one hang would start a 14-day countdown on every clinic simultaneously.)*
10. **Pricing shape is not baked into the software.** A licence carries a list of module keys; a
    "tier" is a saved preset of that list in the panel. Tiers, à-la-carte and bundles all work
    without a code change.

---

## 1. Architecture

```
   ┌────────────────────────────────────────────────────────┐
   │  settings.easymed.uz      standalone Node service      │
   │                                                        │
   │  clinics · subscriptions · module entitlements         │
   │  releases · rollout rings · statistics · access requests│
   │  the SIGNING KEY (never leaves this machine)           │
   └───────────────────────┬────────────────────────────────┘
                           │  HTTPS, always initiated by the clinic
                           │  (clinic PCs sit behind home routers and
                           │   can never be reached from outside)
   ┌───────────────────────┴────────────────────────────────┐
   │  clinic PC — Easy-Med Local                            │
   │                                                        │
   │  server/services/control/licence.js   holds + verifies │
   │  server/services/control/checkin.js   the daily call   │
   │  server/services/control/metrics.js   the counters     │
   │  server/services/control/updater.js   version swap     │
   └────────────────────────────────────────────────────────┘
```

**Direction is fixed.** The clinic always calls out; the panel never calls in. This is not a
preference — clinic PCs are on domestic connections with no public address.

**Failure of the control plane must be invisible.** If `settings.easymed.uz` is down for a day,
every clinic keeps working normally, because each holds a licence valid for 14 more days.

### Where the clinic-side code goes

The existing codebase already has the right shape for this. Licensing becomes three small
modules under `server/services/control/`, following the same conventions as
`server/services/rpc/*` (one concern per file, a co-located `*.test.js`, registered in one
place). No new architecture is introduced.

---

## 2. Identity and enrollment

**A clinic is created in the panel first**, which issues a short human-typeable enrollment code:

```
EM-7K4Q-9XZP
```

At first run the local install shows an activation screen. The admin types the code. The install
posts it to `settings.easymed.uz` and receives back:

- a permanent `clinic_id`
- a long random `install_token` used to authenticate every later check-in
- the first signed licence

The token is stored in `data/control.json`, outside the app directory so it survives updates.

**Copy-the-whole-folder detection.** If someone clones an entire install onto a second PC, both
copies hold the same token. Each check-in therefore reports a machine fingerprint (hash of
hostname + first non-loopback MAC). A changed fingerprint **raises a flag in the panel; it does
not auto-lock** — legitimate hardware replacement and network-adapter changes would otherwise
lock innocent clinics. The vendor decides what to do about a flag.

**Re-enrollment** (PC replaced, disk died): the vendor issues a new code from the panel, which
revokes the old install token.

---

## 3. The licence — one mechanism, three outcomes

**The licence is a dead-man's switch that the server silently re-arms every day.**

A licence is a small signed document held at `data/licence.dat`:

```json
{
  "clinic_id":   "c-000047",
  "clinic_name": "Nurafshon Med",
  "modules":     ["crm", "telegram", "marketing"],
  "valid_until": "2026-09-03T00:00:00Z",
  "issued_at":   "2026-08-20T03:14:00Z",
  "nonce":       "…"
}
```

signed with **Ed25519**. The public key is compiled into the app; the private key exists only on
the control plane. Ed25519 is available in Node's built-in `node:crypto` — **this adds no new
dependency**, which matters in a project that deliberately has three.

Every successful check-in returns a fresh licence stamped `valid_until = today + 14 days`.
Everything else follows from that:

| Situation | What happens | Clinic experience |
|---|---|---|
| Paid, online | Re-armed daily; always ~14 days ahead | Never sees anything |
| Paid, internet down | Counts down from last check-in; locks at day 14 | Warnings from day 7, then phone unlock |
| Stopped paying | Server declines to re-arm; same countdown | Warnings naming the subscription, then activation screen |
| Database edited to add a module | Signature no longer matches the contents; the file is ignored entirely and the clinic is treated as unlicensed | Modules lock |

No separate "disable this clinic" action is needed. The vendor stops re-arming and it happens by
itself.

### Clock tampering

Expiry by date invites setting the PC clock backwards. The install therefore records the highest
timestamp it has ever seen (from its own clock and from every server response). If system time is
ever found to be **earlier than that high-water mark**, the install uses the recorded value for
all licence maths and reports the discrepancy on the next check-in. Winding the clock back cannot
extend a licence.

### Replay

An old licence file cannot help an attacker — an older licence expires sooner. A licence from a
different clinic is rejected because `clinic_id` must match the enrolled identity.

---

## 4. The lock ladder

### Two different locks — do not confuse them

The system has two distinct locked states, and they must not be conflated in implementation:

| | **Module not bought** (§5) | **Subscription lapsed** (this section) |
|---|---|---|
| Cause | Clinic pays, but this module is not in `modules[]` | No valid licence for 14 days |
| Scope | That one module | Every module |
| Reads elsewhere | Normal | Still allowed |
| Writes elsewhere | Normal | **Blocked everywhere** |
| What the user sees | The sales screen in §5 | The activation screen |
| Way out | Request it; vendor adds the module | Pay, or phone unlock |

A lapsed subscription is therefore *not* "every module unpurchased" — it additionally blocks
writes system-wide and changes the screen the user lands on. The two checks are separate
conditions at the same gate.

### The countdown

A paying clinic whose router died must **never** be told it has not paid. The two countdowns look
identical mechanically but must read completely differently.

| Days since last check-in | Cannot reach server | Subscription unpaid |
|---|---|---|
| 1–6 | nothing | nothing |
| 7–10 | quiet grey banner: *no connection to Easy-Med for N days — check the internet* | *subscription expires in N days*, with vendor phone number |
| 11–13 | daily dismissible warning, counting down | daily warning, counting down |
| 14+ | **functions lock**, unlock code shown | **functions lock**, activation screen shown |

### What "locked" means precisely

| Action | Locked state |
|---|---|
| Log in | Allowed — all roles, normally |
| Open a patient card, read history, read past results | Allowed |
| Create / edit / delete anything | **Blocked** |
| Export to Excel | **Blocked** |
| Reach the activation screen | Allowed — admin, always |

Enforcement is **server-side**, in the two places every write already passes through:
`routes/db.js` (insert/update/upsert/delete) and `routes/rpc.js` (every mutating RPC). Blocking
in the browser alone would be decoration. Reads continue to compile normally.

### Phone unlock

The lock screen shows a short challenge derived from `clinic_id` and the current period. The
clinic reads it to the vendor by telephone; the vendor enters it in the panel, which returns a
response code computed with the signing key. Typing it in grants a further 14 days offline. Codes
are single-use and period-bound, so yesterday's code does not work today.

---

## 5. The locked-module screen

Hitting a module the clinic has not bought is **not an error**. It is the best sales surface in
the product: someone is asking for the feature at the exact moment they want it.

```
Модуль не подключён                          ← small, grey, calm

Все звонки и заявки — в одном списке         ← the outcome, not the module name

Call-центр собирает обращения пациентов,     ← one concrete sentence
ведёт их до записи и показывает, кто
перезвонил, а кто нет.

        [ Подключить модуль ]

Заявка уйдёт вашему менеджеру Easy-Med.
Обычно отвечаем в тот же рабочий день.
```

| Module | Headline | One-liner |
|---|---|---|
| Call-центр | Все звонки и заявки — в одном списке | Собирает обращения пациентов, ведёт их до записи и показывает, кто перезвонил, а кто нет. |
| Telegram-бот | Пациент забирает анализы сам, в Telegram | Бот узнаёт пациента по номеру телефона и отправляет готовые результаты. Регистратура перестаёт распечатывать и обзванивать. |
| Маркетинг | Видно, откуда приходят пациенты | Считает источники обращений и повторные визиты, чтобы вы платили за рекламу, которая действительно приводит людей. |

After clicking, the button locks so the vendor is not spammed:
*Заявка отправлена 20 августа. Ваш менеджер свяжется с вами.*

Trilingual, through the existing `i18n-strings.js`:

| | RU | EN | UZ |
|---|---|---|---|
| Label | Модуль не подключён | Not included in your plan | Modul ulanmagan |
| CTA | Подключить модуль | Enable this module | Modulni ulash |
| Foot | Заявка уйдёт вашему менеджеру. Обычно отвечаем в тот же рабочий день. | Sent to your Easy-Med manager. We usually reply the same working day. | Ariza Easy-Med menejeringizga yuboriladi. Odatda o'sha ish kunida javob beramiz. |

The request rides the next check-in and appears in the panel's requests inbox. If the clinic is
offline it queues and sends when connectivity returns.

### Where the gate lives

The app already asks *"is this module allowed for this role?"* in `permissions.js` /
`isModuleAllowed()` before painting the sidebar and before routing. **Licensing becomes a second
question at that same checkpoint.** This is why the feature lands in a handful of files instead
of all 88 view modules.

Locked modules stay **visible but marked** in the sidebar. Hiding them would hide what the clinic
could buy.

---

## 6. Statistics

### The extensibility requirement

The owner will name more metrics later. If the metric list were hard-coded, each new metric would
require shipping a new version to every clinic. Instead:

- The app compiles in a **catalogue of named counters**, each a pure function `db → number`.
- The check-in response tells the install **which** counters to collect.
- Adding a metric the panel already knows about costs one click, not a release.
- Adding a genuinely new counter still requires a release — but the catalogue is designed to be
  populated generously up front.

The panel can never send a query. It can only name counters that already exist in the app. A
compromised control plane therefore cannot exfiltrate patient data.

### Starting catalogue

**Errors and crashes** (owner-selected). The plumbing already exists — `middleware/slow-log.js`
and the error handler in `app.js` already record exactly this:

- server errors in the last 24h, by route
- unhandled crashes / restarts
- slow queries over 500 ms, by RPC name (this would immediately surface the known
  `telegram_chats_list` problem across the whole fleet)
- failed logins

**Revenue volume** (owner-selected) — amounts only, never per-patient or per-service:

- total billed per day
- total collected per day, split by payment method
- unpaid balance outstanding

**Always sent, because licensing and updates cannot work without them:** installed version, last
boot time, machine fingerprint, licence state.

### The no-PII guarantee, enforced structurally

Every counter is typed to return a **number**. The check-in payload builder accepts only numbers
and keys drawn from the catalogue — it has no code path that can serialise a database row, a
string field or free text.

Two tests enforce it, and they fail the build:

1. Every counter in the catalogue, run against a seeded database, returns a `number`.
2. A check-in payload built from a database seeded with recognisable patient names
   (`ZZTESTPATIENT`) contains no occurrence of that string, and contains no string values outside
   the enumerated key set.

This is the difference between a promise and a guarantee, and it is what makes the owner's
instruction real.

---

## 7. Updates and distribution

**Clinics never talk to GitHub.** GitHub is the build system; `settings.easymed.uz` is the
distribution controller. Direct pulls would put repository credentials on every clinic PC — one
compromised machine exposing the entire source — and would surrender all control over who
upgrades when.

```
  git tag v2.4.0
        │
        ▼
  GitHub Actions ── builds a bundle, signs it with the release key
        │
        ▼
  settings.easymed.uz ── decides WHO gets it and WHEN
        │
        ▼
  clinic PC ── asks once a day: "anything new for me?"
```

### A release

A bundle is a zip of the application plus a manifest and a signature:

```json
{
  "version":    "2.4.0",
  "released":   "2026-09-01T00:00:00Z",
  "notes_ru":   "Ускорен список чатов. Исправлена печать направлений.",
  "migrations": ["073_control_plane.sql", "074_lab_index.sql"],
  "min_from":   "2.0.0",
  "sha256":     "…"
}
```

Signed with the same Ed25519 mechanism as the licence. The install verifies before unpacking, so
a spoofed update server achieves nothing.

### Prerequisite — a supervised install layout

**This must be built before updates and does not exist today.** Easy-Med currently runs as
`npm start` in a console window; `SETUP.md` still lists autostart as "a later phase". A running
Node process on Windows cannot replace its own files.

```
C:\EasyMed\
  current            → junction to versions\2.4.0
  versions\2.3.1\
  versions\2.4.0\
  data\                the database, licence and storage — OUTSIDE the versioned tree
```

The app runs as a **Windows service** pointing at `C:\EasyMed\current\server\index.js`, with the
data directory supplied as `EASYMED_DATA_DIR`. Updating means swapping what `current` points at
and restarting the service.

**Consequence for the code:** `data/` is currently resolved relative to the application root
(`server/index.js`). It must become configurable via `EASYMED_DATA_DIR`, defaulting to today's
behaviour so development is unaffected.

### The install sequence, at 03:00

1. Download the bundle · verify signature · verify the archive unpacks cleanly
2. **Back up the database** to `data/backups/pre-2.4.0.db`
3. Unpack to `versions\2.4.0\`
4. Point `current` at it · restart the service
5. Migrations run on boot (existing `migrate()` behaviour, unchanged)
6. Self-check: `/api/health` plus one smoke query
7. Report the outcome on the next check-in

**If any step fails:** point `current` back at the previous version, **restore the database
backup**, restart, report the failure. The clinic wakes up to a working system either way.

That database backup *is* the rollback story. Reverting code is trivial; reverting a migration is
not, so the design never tries — it restores instead.

### Skipped versions already work

A clinic jumping 2.1 → 2.4 receives every intervening migration in the bundle, and the existing
`migrate()` applies whatever is not yet recorded, in filename order. No new machinery.

> **Carried-over hazard:** the predecessor collided three migrations on `071_` and two on `058_`,
> making their relative order alphabetical by accident. With remote updates this becomes far more
> dangerous. The plan must add a **duplicate-prefix guard** to `migrate()` that refuses to start.

### Rollout rings

| Ring | Who | Purpose |
|---|---|---|
| 0 | the vendor's own test install | catches the obvious |
| 1 | 2–3 friendly clinics | catches the real-world |
| 2 | everyone else | the rollout |

The panel assigns each clinic a ring and publishes a release ring by ring. **Automatic halt:** if
failure reports from a ring exceed a threshold, the release freezes and no further clinic is
offered it. Ring promotion is manual — the vendor decides when ring 1 has been healthy long
enough.

---

## 8. The panel

A deliberately boring Node + Express + Postgres service on its own host.

**Clinics** — list with name, version, last seen, subscription state, entitled modules, ring,
fingerprint flags. Actions: change modules, extend or end a subscription, issue an unlock code,
pin a version, assign a ring, re-enroll.

**Releases** — register a build, write Russian release notes, publish to a ring, watch success
and failure counts, halt a rollout.

**Requests inbox** — the "Подключить модуль" leads, each showing clinic, module and date. This is
the sales queue.

**Statistics** — per clinic and across the fleet: revenue volume, error rates, version spread,
who has gone quiet. A clinic whose usage is falling is about to cancel; this is the earliest
possible warning.

**Access:** vendor staff only, with its own login. No clinic ever sees this panel.

---

## 9. Invariants — what must never happen

These are the acceptance criteria that outrank every feature in this document.

1. **A control-plane failure must never stop the clinical app from starting.** Every check-in path
   is wrapped so that a network error, a malformed response, a corrupt licence file or an
   unreachable server logs a warning and nothing more. A clinic must never be unable to register a
   patient because the vendor's server had a bad day.
2. **No patient-identifying data leaves the clinic.** Enforced by §6, tested in the build.
3. **An update must never leave a clinic unable to start.** Any failure restores both code and
   database.
4. **The admin can always reach the activation screen** — otherwise a clinic that wants to pay
   cannot.
5. **Licence checks are read-only with respect to clinical data.** Nothing in this feature may
   modify a patient, visit, invoice or result.

---

## 10. Testing

| Area | Cases |
|---|---|
| Licence | valid signature accepted · tampered contents rejected · wrong `clinic_id` rejected · expired rejected · clock wound back does not extend · missing file behaves as unlicensed |
| Lock ladder | day 6/7/13/14 states · unpaid vs unreachable produce different messages · writes blocked and reads allowed while locked · admin still reaches activation |
| Phone unlock | valid code grants 14 days · yesterday's code refused · another clinic's code refused |
| Check-in | server down · timeout · 500 · malformed JSON · **none may crash or block the app** |
| Statistics | every counter returns a number · payload contains no patient string · panel-selected subset is honoured |
| Updates | happy path · bad signature refused · truncated download · failed migration restores code **and** database · skipped versions apply all migrations in order |
| Rollout | ring targeting · automatic halt on failure threshold · pinned clinic never offered a release |

Written test-first, in the project's existing `node:test` style with co-located `*.test.js`.

---

## 11. Build order

One design, four implementation plans. Each is independently shippable and leaves the system
working.

| # | Plan | Contents | Depends on |
|---|---|---|---|
| 1 | **Spine and licensing** | enrollment, signed licence, daily check-in, lock ladder, locked-module screen, phone unlock, panel skeleton with clinics and modules | — |
| 2 | **Statistics** | counter catalogue, panel-selected collection, no-PII tests, panel dashboards | 1 |
| 3 | **Supervised install** | `EASYMED_DATA_DIR`, versioned directory layout, Windows service, migration duplicate-prefix guard | — (can run in parallel with 1) |
| 4 | **Updates** | release bundles and signing, GitHub Actions build, distribution API, overnight installer with rollback, rollout rings and automatic halt | 1 and 3 |

Plan 1 is the one that earns money and is the hardest to retrofit. Plan 3 has no dependency on
the others and can be built alongside.

---

## 12. Stated risks

Recorded because the owner accepted them knowingly.

1. **A locked clinic cannot export its own records.** The owner chose this. Two things follow.
   First, it does not actually retain the data: `data/easymed.db` is an ordinary file on the
   clinic's own computer and can be copied and opened with free tools in minutes, so the lock
   applies pressure without preventing access. Second, medical record retention rules in
   Uzbekistan may bear on refusing a clinic access to its own patient records — a question for
   the owner's lawyer, not for this document.
2. **Revenue figures leave the clinic.** Amounts only, no patient or service detail, but some
   clinic owners will object to their software vendor seeing their turnover. Worth being explicit
   about in the contract rather than discovered later.
3. **No forced update channel.** A clinic that never approves an update stays on an old version
   indefinitely, including through a security fix. The owner chose consent-always. If this becomes
   a problem, adding a critical channel later is a panel change plus a clinic-side release.
4. **The fingerprint flag is advisory.** A determined operator can run two copies from one
   licence until a human notices the flag in the panel.

---

## 13. Open questions

Not blocking plan 1; to be settled before the plans that need them.

- **Billing.** Does the panel record payments and issue invoices, or only reflect a subscription
  state the owner sets by hand after being paid elsewhere? Plan 1 assumes the latter — a manual
  "paid until" date — which is the smaller build and is not a dead end.
- **The full module list.** §5 covers the three modules the owner named. The remaining candidates
  visible in the code are Laboratory, Ward & beds, Procurement, PACS, owner-level reports and
  multi-branch. Which are sold separately versus included in the core is a pricing decision, and
  the licence format already supports any answer.
- **Check-in frequency.** Design assumes once daily plus once at boot. Cheap to make configurable
  from the panel if a reason appears.
