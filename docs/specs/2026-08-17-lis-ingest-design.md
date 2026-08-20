# Easy-Med Local — Analyzer Result Ingest (LIS_INGEST_V1) Design

Date: 2026-08-17
Status: approved by user (HL7 listener inside the Node server, BC-20 only for
now, results accepted regardless of the order's stage, no `sample_collected_at`
back-fill, never auto-verified)

## Context

The clinic runs a **Mindray BC-20** auto hematology analyzer. Today its results
are read by a separate Python script (`BC20.py`, launched by `LIS.bat` from
`C:\Users\user\Desktop\corel` on the lab PC) and re-typed into Easy-Med by hand.
The tube already carries an Easy-Med barcode; nothing consumes it.

This spec adds the inbound direction: the analyzer sends its results over the
network, Easy-Med matches them to the order by that barcode, and the lab staff's
job becomes checking and releasing rather than typing.

### What already exists (verified in code, not assumed)

The barcode half of this is **already built and shipping**:

- **Accession barcodes already print.** `views/laboratory.js:29,47` —
  `accession(vs) = 'LAB-' + String(vs.id).padStart(6,'0')`, rendered Code128-B
  by `views/lab-barcode.js` and printed at the «Забор пробы» step. The number
  on the tube is therefore *already* `visit_services.id`, zero-padded.
- **One result row per analyte is already the model.** `views/laboratory.js:22`
  — «Each analyte writes ONE `lab_results` row (parameter = analyte name)».
  This is exactly one HL7 `OBX` segment per row.
- **`lab_results` already carries everything an OBX does.**
  `migrations/006_labs.sql` + `041_lab_handling.sql`: `value`, `numeric_value`,
  `unit`, `reference_range`, `ref_low`, `ref_high`, `flag`, `entered_by`,
  `entered_at`, `verified_by`, `verified_at`.
- **The state machine already has the right landing step.**
  `visit_services.status`: `added → queued → collected → in_progress →
  resulted → completed`. `resulted` is «Проверить и выдать» — a human reviews
  and releases. That is precisely where machine results should arrive.
- **The shipped CBC fixture already uses Mindray channel names.**
  `041_lab_handling.sql` seeds `lab_panel_analytes.code` as `WBC`, `RBC`,
  `HGB`, `HCT`, `PLT`. A Mindray BC sends those same mnemonics in `OBX-3`, so
  the default CBC panel maps with **zero configuration**.
- **`flag = 'critical'` is already wired to a dashboard counter.**
  `views/reports.js:718` counts today's critical results. Auto-imported panics
  light it up for free.
- **The data client is already local.** `public/js/supabase.js` is a shim over
  `/api/db`; no external network is involved. (The "Phase 2 NEXT" note in
  `CLAUDE.md` is stale with respect to the lab module.)

### What the analyzer speaks

Confirmed from vendor and integrator documentation:

- The BC-20 has a **LAN port with bi-directional LIS support over HL7**, and
  USB ports that accept a **barcode reader** — which is how the tube's barcode
  becomes the sample ID.
- Mindray BC-series speak **HL7 v2.3.1 framed in MLLP over TCP/IP**, sending
  **`ORU^R01`** per finished sample.
- The **sample ID is `OBR-3`**. Documented Mindray example:
  `OBR|1||20071207011|00001^Automated Count^99MRC||...`
- Each analyte is one **`OBX`**: `OBX-2` value type, `OBX-3` code, `OBX-5`
  value, `OBX-6` unit, `OBX-7` reference range, `OBX-8` abnormal flag,
  `OBX-11` result status.

### The gaps

1. Nothing listens on the network. Easy-Med has an HTTP server only.
2. Nothing parses HL7.
3. Nothing maps an analyzer channel name to a clinic analyte, nor records that
   a result came from a machine rather than a person.
4. Nothing catches a result that fails to match an order — today it would
   simply be lost.

## Decisions

**D1 — The listener lives inside the Node server, not in a sidecar process.**
Started from `server/index.js` alongside the HTTP server. No Python, no venv,
no second service to install, autostart and monitor, no `.bat` on a desktop.
This matches the project's "`npm start` and everything is local" convention.

**D2 — No new npm dependencies.** `package.json` has exactly three
(`bcryptjs`, `better-sqlite3`, `express`). MLLP is framing bytes around a
payload; HL7 v2 is delimiter-separated text. Both are small, and a hand-written
parser we can read beats a transitive dependency tree in a medical system.

**D3 — Results are never auto-verified.** Ingest writes results and sets
`status = 'resulted'`. `verified_by` / `verified_at` stay NULL, so the order
lands on the existing «Проверить и выдать» step and a human releases it.
*The machine types; a person signs.* This is the central safety property of
this design and must not be relaxed for convenience.

**D4 — Results are accepted regardless of the order's current stage, and
`sample_collected_at` is NOT back-filled.** If the tube was run before anyone
pressed «Забор пробы», the physical evidence beats the button — parking the
result would strand real data in a tray. The timestamps that matter are the
**result** timestamps: `lab_results.entered_at` (when the analyzer's result
arrived) and `verified_at` (when a human confirmed it). Easy-Med does not
invent a collection time it has no evidence for.

**D5 — The clinic owns reference ranges; the analyzer does not.**
`041_lab_handling.sql` states the rule verbatim: «Reference range values of any
kind» are excluded from seeds, because «ranges depend on the analyser and
method each lab uses». Ingest keeps that rule. When an analyte is mapped and
the clinic has configured a range, the range and the resulting flag come from
`lab_panel_analytes`, resolved by sex/age through the existing logic. Only when
no clinic range is configured does ingest fall back to the device's `OBX-7` /
`OBX-8`. The device's raw range and flag are always retained in the message
inbox for audit.

**D6 — Units and parameter names come from the panel, not the wire.**
`lab_results.parameter` is the analyte **name** (`views/laboratory.js:656`) and
is what the patient card and printed report render. A mapped analyte therefore
writes the clinic's Russian name and unit — «Лейкоциты (WBC)», `10^9/л` — not
Mindray's `WBC` / `10*9/L`. Reports stay in one language.

**D7 — Nothing is ever silently dropped.** Every received message is persisted
raw, with its parse and match outcome. Unmatched messages and unmapped analytes
surface in an «Необработанные» tray in the lab view for manual attachment. A
smudged barcode must cost a click, not a re-run of the patient's blood.

**D8 — Re-running a tube updates, never duplicates.** Upsert keyed on
`(visit_service_id, parameter)`.

**D9 — Range resolution is extracted and shared, not re-derived.**
D5 requires ingest to resolve a clinic reference range by sex and age. That
logic exists today as `refFor` (`views/laboratory.js:584`) and
`matchedNamedRanges` (`:636`) — but they are *private functions inside a
browser module* that imports `supabase.js` and `ui.js`, so the server cannot
call them. Re-implementing them server-side is exactly the failure
`server/services/domain/no-drift.test.js` was written to prevent: «each was
reasonable on its own, and nothing objected when they drifted apart». A lab
reference range silently disagreeing between the entry screen and the importer
is a patient-safety bug, not a tidiness one.

So this work **extracts both functions into a new pure, dependency-free module
`public/js/admin/views/lab-ranges.js`**, imported at runtime by both
`laboratory.js` and `server/lis/ingest.js`, and adds a drift-guard test in the
established style. The module lives under `public/` because the browser can
only load what Express serves; Node imports it by relative path, which needs no
new static mount. This is a targeted improvement to existing code in service of
the current goal — not unrelated refactoring — and it is a prerequisite for
D5, not an optional extra.

## Architecture

```
   BC-20  ──TCP/MLLP──▶  server/lis/mllp-server.js   (framing, ACK/NAK)
                                   │  raw message text
                                   ▼
                         server/lis/hl7.js           (pure parser)
                                   │  {sampleId, observations[]}
                                   ▼
                         server/lis/ingest.js        (match, map, write)
                                   │
                    ┌──────────────┴───────────────┐
                    ▼                              ▼
            lab_results (source='analyzer')   lab_device_messages
            visit_services.status='resulted'  (raw + outcome, always)
                    │
                    ▼
            existing «Проверить и выдать» → human verifies → completed
```

Four modules, each independently testable. One of them
(`lab-ranges.js`, per D9) is an extraction from existing code rather than new
behaviour, and is shared with the browser:

### `server/lis/mllp-server.js` — transport
A `net.createServer` bound to `0.0.0.0`, port from `LIS_PORT` (default
**2575**). Accumulates bytes until the MLLP end block, extracts the payload
between `0x0B` and `0x1C 0x0D`, hands it to ingest, and replies with an HL7
`ACK` (`MSA|AA|<control-id>`) or `NAK` (`MSA|AE`). Handles multiple messages
per connection and messages split across TCP segments. Mirrors the friendly
`EADDRINUSE` handling `server/index.js` already does for the HTTP port, so an
operator who double-starts sees plain language rather than a stack trace.

Caps, because this port is unauthenticated (see Security):
- message size ceiling (256 KB) — oversized input is NAK'd and logged, not buffered
- idle-connection timeout
- optional source-IP allowlist via `LIS_ALLOW_IPS`

### `server/lis/hl7.js` — parser (pure)
Splits segments on `\r` (tolerating `\r\n`), fields on `|`, components on `^`,
honouring the encoding characters declared in `MSH-2`. Exposes:

- `parseMessage(text)` → `{ type, controlId, sampleId, observations[] }`
- `buildAck(controlId, code)` → ACK/NAK text

Rejects anything whose `MSH-9` is not `ORU^R01`. `QRY^Q02` (the analyzer asking
Easy-Med for a worklist) is recognised and NAK'd with a clear reason rather
than being parsed as a result — see Future work.

Only observations with `OBX-11` of `F` (final) or empty are written.
Preliminary (`P`) and unobtainable (`X`) results are recorded in the inbox but
never written to `lab_results`.

### `public/js/admin/views/lab-ranges.js` — shared range resolution (D9)
`refFor` and `matchedNamedRanges` moved verbatim out of `laboratory.js`, with
no behaviour change. Pure: no imports, no DOM, no browser globals, so Node and
the browser both load it. `laboratory.js` imports them instead of defining
them; `ingest.js` imports the same functions to satisfy D5.

### `server/lis/ingest.js` — matching, mapping, writing
Runs in one better-sqlite3 transaction per message.

**Matching.** `OBR-3` → strip a `LAB-` prefix (case-insensitive) and leading
zeros → integer → `visit_services.id`. Bare digits are accepted too, since a
barcode reader may or may not transmit the prefix. The order must exist and be
a lab service; otherwise the message is stored `unmatched` and nothing is
written.

**Mapping.** `OBX-3` code → analyte, resolved in order:
1. `lab_device_map` (device + device code → analyte code) — the override table
2. `lab_panel_analytes.code` on the panel linked to this order's service
3. unmapped → recorded in the inbox, no row written

Step 2 is why the shipped CBC needs no configuration.

**Value.** `OBX-5` is stored verbatim in `value`. `numeric_value` is populated
only when `OBX-2` is `NM` and the text parses as a finite number — so `<0.01`
and `>1000` keep their meaning as text with `numeric_value` NULL.

**Flag** (per D5), constrained to the existing
`CHECK (flag IN ('normal','high','low','abnormal','critical'))`:
- clinic range configured → compute: below `ref_low` → `low`, above `ref_high`
  → `high`, otherwise `normal`
- no clinic range → map `OBX-8`: `N`/empty → `normal`, `L` → `low`,
  `H` → `high`, `LL`/`HH`/`AA` → `critical`, anything else → `abnormal`

`LL`/`HH` mapping to `critical` deliberately feeds the existing panic counter
in `views/reports.js:718`.

**Writing.** Per D8, upsert on `(visit_service_id, parameter)`; `entered_by`
NULL with `source = 'analyzer'` (the row was not entered by a user, and
inventing a fake one would corrupt the staff audit trail); then
`visit_services.status = 'resulted'`. Per D3, verification fields are untouched.
Per D4, `sample_collected_at` is untouched.

## Schema — `migrations/065_lis_ingest.sql`

```sql
-- Provenance. Default 'manual' so every existing row keeps its meaning.
ALTER TABLE lab_results ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Channel-name overrides, for when the BC-20's mnemonics differ from the
-- clinic's analyte codes. Empty on a fresh install: the CBC fixture matches
-- by code already.
CREATE TABLE lab_device_map (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  device       TEXT NOT NULL DEFAULT 'BC-20',
  device_code  TEXT NOT NULL,
  analyte_code TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX idx_lab_device_map_code ON lab_device_map(device, device_code);

-- The inbox (D7). Every message that reaches the port, whatever happens next.
CREATE TABLE lab_device_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device           TEXT NOT NULL DEFAULT 'BC-20',
  peer             TEXT,
  raw              TEXT NOT NULL,
  sample_id        TEXT,
  visit_service_id INTEGER REFERENCES visit_services(id),
  status           TEXT NOT NULL
                     CHECK (status IN ('applied','unmatched','unmapped','rejected')),
  detail           TEXT NOT NULL DEFAULT '',
  received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolved_at      TEXT
);
CREATE INDEX idx_lab_device_messages_status ON lab_device_messages(status);
```

`schema-registry.js` gains read entries for both new tables (`ALL_STAFF` read;
`lab_device_map` writable by `admin`/`lab`) and `source` is added to the
`lab_results` read column list. `lab_results` write columns are **not**
extended with `source` — only the server sets it, never the browser.

## UI

Deliberately small; the existing workflow is not redesigned.

1. **Provenance badge** in the result modal and printed report — an
   auto-imported value is marked «из анализатора». A verifying human should
   know which numbers a machine produced.
2. **«Необработанные» tray** in the lab view: `lab_device_messages` where
   status is not `applied`, with the raw message viewable and an action to
   attach it to an order (re-runs ingest with an explicit `visit_service_id`)
   or dismiss it. Resolving stamps `resolved_at`.

## Error handling

| Situation | Behaviour |
|---|---|
| Malformed / non-ORU message | NAK, stored `rejected` with the reason |
| Oversized message | NAK, connection closed, logged |
| Unknown or unreadable sample ID | Stored `unmatched`, appears in the tray |
| Order exists but is not a lab service | Stored `unmatched` with that reason |
| Some analytes unmapped | Mapped ones applied; message stored `unmapped` listing the rest |
| Preliminary (`P`) / unobtainable (`X`) result status | Recorded, not written |
| DB error mid-message | Transaction rolls back; NAK so the analyzer can resend |

An `ACK` is only ever sent after the transaction commits. An analyzer that
retries on NAK is a feature here, not a nuisance.

## Security

This port accepts unauthenticated TCP on the clinic LAN — an honest trade-off,
because analyzers cannot authenticate. Mitigations:

- The listener can **only** write `lab_results` and flip a `visit_services`
  status. It cannot touch users, sessions, invoices, payments or prices.
- It can never verify a result (D3) — the maximum damage a hostile message can
  do is put wrong numbers in front of a human whose job is to check them.
- Optional `LIS_ALLOW_IPS` allowlist; message size ceiling; idle timeout.
- Every message is retained raw with its peer address, so any anomaly is
  reconstructable after the fact.
- The port is separate from the HTTP port and can be firewalled independently.
- `LIS_ENABLED=0` disables the listener entirely for clinics not using it.

## Testing

Buildable and verifiable **without the analyzer** — this is what makes the plan
safe to execute before anyone touches clinic hardware.

- `server/lis/hl7.test.js` — pure parser: well-formed ORU, split segments,
  `\r\n`, custom encoding chars, missing `OBR-3`, non-ORU types, ACK shape.
- `server/lis/ingest.test.js` — against a fresh migrated DB: match by
  `LAB-000123` and by bare digits; unknown sample → `unmatched`; mapped vs
  unmapped analytes; clinic range wins over device range (D5); panel name/unit
  used (D6); `<0.01` keeps text with NULL `numeric_value`; re-run updates
  rather than duplicates (D8); `verified_by` stays NULL (D3);
  `sample_collected_at` untouched (D4).
- `server/lis/mllp-server.test.js` — framing, message split across writes, two
  messages on one connection, oversize rejection, ACK/NAK content.
- `migrations/065.test.js` — matching the existing per-migration test pattern;
  pins that `source` defaults to `'manual'` for pre-existing rows.
- `lab-ranges.test.js` — the extracted helpers (D9), pinning sex-specific and
  named age/phase ranges, so the move is provably behaviour-preserving.
- `lab-ranges-drift.test.js` — guard in the `DOMAIN_DRIFT_GUARD_V1` style:
  reads `laboratory.js` and `server/lis/ingest.js` and fails if either
  re-derives range selection instead of importing it. When it fires, the fix is
  to import — not to add an exemption.
- `scripts/fake-analyzer.js` — replays a captured or synthetic ORU at the port,
  for end-to-end checks and for the clinic to test with before going live.

## Open questions — to resolve on the bench, not in this spec

These block **field validation**, not implementation:

1. Is LIS/HL7 enabled on the BC-20, and what IP:port is it currently sending to?
2. Is that destination the lab PC running `BC20.py`? **If so this replaces it** —
   the analyzer sends to one destination only. The lab PC must stay in place
   until the new path is proven.
3. Is the analyzer on the same LAN as `192.168.100.10`?
4. One raw sample message, to pin the exact channel mnemonics — Mindray naming
   varies by model, and any difference is a `lab_device_map` row, not a code
   change.

## Out of scope

- Any analyzer other than the BC-20. The design is kept generic via
  `lab_device_map.device` so a second device is an addition, not a rewrite.
- ASTM E1381/E1394 transport (some biochemistry analyzers) — a second
  transport module behind the same ingest, when needed.
- **Outbound worklists.** The BC-20's LIS support is bi-directional: it can ask
  Easy-Med which tests to run for a scanned barcode (`QRY^Q02`). Genuinely
  useful later — the parser recognises and cleanly rejects it today so the door
  stays open.
- Auto-verification and auto-release. Excluded by D3, permanently.
