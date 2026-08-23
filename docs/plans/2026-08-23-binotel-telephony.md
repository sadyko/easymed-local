# Plan: Settings → «Телефония» — standard call-center integration (Binotel)

Owner's assignment (2026-08-23): a settings menu for the standard call-center
integration, built from the Binotel developers documentation (archived copy studied:
web.archive.org/web/20240520185732/http://developers.binotel.ua). This is Phase 1:
credentials, connection proof, call capture into a real table, and the webhook
receivers — NOT the rewrite of the demo call-center screen (`views/callcenter.js`
stays as is; wiring it to the new `calls` table is its own later task).

## The Binotel contract (as documented; field names verbatim)

- **Outbound REST API** (works from an offline LAN clinic — outbound HTTPS only, the
  same posture as the Telegram bot): POST raw JSON to
  `https://api.binotel.com/api/4.0/<method>.json`, body carries `key`, `secret`
  (issued by Binotel support). Methods used here:
  - `stats/all-incoming-calls-since.json` — the polling primitive (cursor = unix
    `timestamp`), and `stats/all-outgoing-calls-since.json`.
  - The unified call structure: `generalCallID`, `startTime` (unix), `callType`
    (0 in / 1 out), `internalNumber`, `externalNumber`, `waitsec`, `billsec`,
    `disposition` (ANSWER/TRANSFER/BUSY/NOANSWER/CANCEL/…), `isNewCall`,
    `employeeData[name/email]`, `pbxNumberData[number/name]`.
- **Webhooks Binotel → clinic** (only possible when the clinic has a public URL —
  say this honestly in the UI; most local installs will run polling-only):
  - `apiCallSettings` (call ringing): POST `{requestType, pbxNumber|internalNumber,
    externalNumber, companyID, callType}` → respond JSON `{name, description,
    customerData[linkToCrmUrl|linkToCrmTitle|…]}` — the patient's name + card link.
  - `apiCallCompleted`: POST `{requestType, callDetails}` → MUST answer exactly
    `{"status":"success"}` or Binotel retries 7 times over 38 hours.
  - Security per docs: accept only from Binotel's listed server IPs (the ~26
    addresses in the docs — compiled into the receiver as a frozen list with the
    source noted), plus our own toggle default OFF.

## Design

### Server (`server/services/telephony/`)

- `binotel.js` — the API client: `binotelCall(method, params, {fetchImpl, timeoutMs})`
  → POST JSON with key/secret merged in; never logs the secret; bounded response
  size; fixed timeout; returns `{ok, data}|{ok:false, reason}` (vocabulary, never
  thrown network errors). DI fetch — tests never touch the network.
- `settings.js` — storage in a `telephony_settings` single-row table (migration
  `076_telephony.sql`): `enabled`, `provider` ('binotel'), `api_key`,
  `api_secret`, `poll_interval_sec` (default 30, min 10), `webhooks_enabled`
  (default 0), `public_base_url` (for building linkToCrmUrl), `last_poll_at`,
  `last_call_at`, `last_error`. Secret handling: RPC GET returns `api_secret_set:
  true/false`, never the value.
- Migration also creates `calls`: `general_call_id` TEXT UNIQUE, `started_at`,
  `call_type`, `external_number`, `internal_number`, `waitsec`, `billsec`,
  `disposition`, `is_new_call`, `patient_id` NULL (matched by phone via the same
  normalisation the CRM phone-match uses — find and REUSE it, never a second
  normaliser), `raw` JSON, `source` ('poll'|'webhook'). UNIQUE on general_call_id
  makes poll+webhook double-delivery idempotent by construction.
- `poller.js` — mirrors the Telegram poller/scheduleCheckin shape: unref'd timer,
  every tick wrapped, re-entrancy-guarded; runs only when `enabled` AND the
  `callcenter` licensed module is granted (same check the UI uses — find it in
  licensed-modules/licence state); cursor = max(startTime) seen, minus a small
  overlap; inserts with ON CONFLICT DO NOTHING; updates last_poll_at/last_error.
  Wired in server/index.js next to startTelegramBot.
- `webhooks.js` + route mount `/api/telephony/binotel` (in app.js BEFORE session
  auth — Binotel has no session): refuses unless `webhooks_enabled`; refuses
  non-allowlisted source IPs (honouring X-Forwarded-For is a spoofing hole — use
  the socket address, document why); `apiCallSettings` → look up patient by
  externalNumber → `{name, customerData:{linkToCrmUrl: <public_base_url>/admin.html#…}}`,
  unknown patient → generic response; `apiCallCompleted` → upsert into `calls`,
  reply exactly `{"status":"success"}`. Body size capped. Tests drive both via
  supertest-style local requests with fake socket addresses.
- RPCs (registered in rpc/index.js, admin-only via hasAnyRole, NORMAL 402 gating —
  telephony is clinical-operations, not licence-recovery): `telephony_settings_get`,
  `telephony_settings_save` (secret only overwritten when a non-empty new value
  arrives), `telephony_test` (calls a cheap stats method with the SAVED or
  just-submitted creds → ok/fail + human Russian reason), `telephony_recent_calls`
  (last 20, for the proof-of-life list).

### Frontend

- `views/telephony-settings.js` + tile «Телефония» in settings-hub (admin-only),
  gated on the `callcenter` licensed module exactly like other module screens
  (locked → the standard request-module screen).
  Sections: (1) Подключение — provider fixed «Binotel», key, secret (masked,
  placeholder «сохранён» when set), «Проверить подключение» button with honest
  result line; (2) Опрос звонков — enable toggle, interval, «последняя проверка /
  последний звонок / последняя ошибка» status; (3) WebHook-и — default-off toggle,
  the exact URL to give Binotel (`<public_base_url>/api/telephony/binotel`),
  the note that this needs the clinic to be reachable from the internet, and the
  IP-allowlist mention; (4) Последние звонки — table of 20 (time, direction,
  number, patient link when matched, duration, disposition in human words).
- Pure decisions (masking, duration/дата formatting, disposition→label map,
  interval validation) in `telephony-logic.js` with co-located tests (pin
  localStorage 'admin.lang'='ru' in fake-DOM tests). All strings tr() ru/uz/en.

## Honest limits (state them in the UI)

- Webhooks need a publicly reachable clinic — most local installs run polling-only;
  the popup-on-ring experience is webhook-territory and therefore absent in
  polling mode (calls appear in the log within ~poll interval).
- Binotel issues key/secret via support@binotel.ua — the screen says this.
- No call management (transfers, click-to-call) in Phase 1.

## Tasks

1. **Server agent**: migration 076, binotel client, settings, poller, webhooks,
   RPCs, tests (TDD; node --test per-file only; temp dirs; never npm install/worktree;
   never touch data/ or kill node processes).
2. **Frontend agent**: settings view + logic file + i18n + settings-hub tile.
3. **Integration (orchestrator)**: full suite, commit, push — then STOP per
   docs/WORKFLOW.md's release gate: the owner decides when this becomes a release.
