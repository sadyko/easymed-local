# Telegram document bot — design

TELEGRAM_BOT_V1 · 2026-08-17

## Problem

Patients have no way to get their own documents without coming to the desk.
The clinic previously ran a separate Windows binary for this
(`D:\server\telegram_Bot`, .NET + Npgsql + Telegram.Bot, no source on disk).
Its flow: the patient typed a **clinic-issued password**, the bot wrote the
chat id into `Patients."chatBotId"`, and it returned **lab results only**,
rendering them through a second local service at `http://127.0.0.1:5003/`.

That design has three costs Easy-Med Local should not inherit:

1. **Two processes to keep alive** on a clinic PC — the bot and the renderer.
   The local rewrite exists to be one `npm start`.
2. **A manual password step** at the desk for every patient.
3. **Seven bot tokens and a Postgres password in plaintext** in a
   world-readable `TelegramBot.dll.config`.

## What we are building

A Telegram bot, configured from Settings, that identifies a patient by the
phone number Telegram itself verified and hands them their documents as
branded PDFs — automatically when a document becomes ready, and on demand
from a menu.

### Decisions taken

| Question | Decision |
|---|---|
| What the patient receives | **PDF**, generated server-side |
| Document kinds | Lab results, consultation + diagnostic conclusions, invoices/receipts, staff-uploaded files |
| Identification | **Telegram-verified phone alone**, unlocking every patient record on that number |
| Trigger | **Both** — auto-push when ready, plus browse on demand |
| Where the bot runs | **In-process**, inside the Express server |

### Consequences of the identity decision

Phone-alone access was chosen deliberately: in practice one number covers a
whole family, and any confirmation step is friction at the moment of care.
The accepted risks, recorded here rather than argued again:

- Anyone holding the handset sees every diagnosis registered to that number.
- A reassigned mobile number silently grants access to the previous owner's
  records.

Mitigations, all of them zero-friction for the patient: a full delivery audit
log, an admin **Unlink** button, and a per-chat rate limit.

## Dependencies

**None added.** The project stays on `bcryptjs`, `better-sqlite3`, `express`.

- The Telegram Bot API is HTTPS + multipart — Node's global `fetch` covers it.
- PDF generation uses the Chrome already installed on the machine via its own
  `--headless --print-to-pdf` CLI flag. No puppeteer, no Chromium download.
  (Verified present: Chrome 151 and Edge 151.)

Only outbound HTTPS to `api.telegram.org` is required. Long polling means no
inbound port and no exposure of the clinic server to the internet — the one
place this feature departs from "no network dependencies" in CLAUDE.md, and
it departs no further than it must.

## Data model — migration `060_telegram_bot.sql`

### `telegram_settings` (singleton, `id = 1`)

Bot enable flag, `bot_token_enc`, cached bot username from `getMe`, per-kind
release toggles, push on/off, optional Chrome path override.

**Deliberately absent from `schema-registry.js`.** The registry is an
allow-list, so omission makes the token unreachable through `/api/db` by
construction rather than by a rule someone has to remember. All access goes
through admin-only RPC, and the token never travels to the browser.

### `telegram_links`

`chat_id` ↔ **phone**, plus Telegram user id and display name, `linked_at`,
`revoked_at`. Unique on `chat_id` among non-revoked rows.

The link stores **a phone, not a patient id**. Patients are re-resolved by
phone on every request, so a newly registered family member on that number is
covered with no sync job, and a patient whose number changes drops off
automatically. This falls directly out of the phone-alone decision.

### `telegram_deliveries`

Audit log and outbox in one table: chat, patient, `doc_kind`, `doc_ref`,
`trigger` (`push` | `pull`), status, attempts, error, timestamps.

A partial unique index on `(chat_id, doc_kind, doc_ref) WHERE trigger='push'`
makes an automatic send **exactly-once forever**, surviving restarts.

### `telegram_state`

Key/value: the `getUpdates` offset and the push scan watermarks.

## Components

### `server/services/telegram/`

Started from `server/index.js` beside `autoCloseStaleShifts`. A supervised
long-poll loop catches every error and retries with backoff; nothing
originating at Telegram can throw into Express.

- `crypto.js` — AES-256-GCM at rest, key in `data/.telegram-key`
- `api.js` — minimal Telegram client over `fetch`
- `settings.js` — read/write settings, `getMe` connection test
- `poll.js` — long poll, offset persisted so a restart never replays
- `flow.js` — the patient conversation
- `documents.js` — resolve patients by phone, list and build documents
- `render.js` — HTML → PDF through Chrome

On token storage, honestly: a key file beside the database defends against a
copied `.db`, not against someone who has the machine. It is still far better
than the plaintext config it replaces.

### Patient flow

`/start` → a `request_contact` keyboard button → the patient taps and Telegram
sends their verified number → patient picker if several match → visit list →
document → PDF.

**The load-bearing security check:** on receiving a contact, assert
`message.contact.user_id === message.from.id`. Telegram will happily deliver a
*saved contact card for a third party*, so without this assertion anyone can
forward someone else's contact and impersonate them. The old password-based
bot never faced this; a phone-share bot lives or dies on it.

### Shared renderer

`buildSheetHtml()` is already DOM-free but sits in a module importing
`supabase`, `ui`, and `tenant-tables`. Extract it and `renderDesignedVariant`
into **`public/js/shared/doc-render.js`**, importing nothing and taking
`settings` as an argument. `doc-settings.js` keeps `printableSheet` /
`loadDocSettings` and re-exports, so **every existing Print button is
untouched**.

Node imports that same file — the project is already `"type": "module"`. One
renderer for both paths means a Telegram PDF cannot drift from the printed
document.

### Push pipeline

A 30-second tick scans state transitions that already exist: `lab_results.
verified_at` going non-null, and conclusions being signed. Matches insert a
`pending` delivery; the drainer renders, sends, and records the outcome with
backoff.

**Invoices and receipts are pull-only.** Pushing a bill to a patient's phone
the moment it is raised is noise at best.

### Admin UI

Settings tile → `telegram-settings.js`, admin-only, served by an RPC module
matching the existing `server/services/rpc/` pattern:

- Token field is **write-only** — shows the last 4 characters and a Replace
  button, never returns the token
- **Test connection** → `getMe` → shows `@botusername`, a `t.me` deep link and
  a QR to print for the waiting room
- Linked accounts, with matched-patient counts and Unlink
- Delivery log with visible errors — the audit trail

Language: Russian, matching the rest of the admin UI and the patient-facing
strings already in the app.

## Testing

`node --test`, in the existing style: injected fake Telegram transport,
in-memory DB.

- Contact spoofing (`contact.user_id !== from.id`) is rejected
- Phone matching agrees with `crm-phone-match.js`, which the bot imports
  rather than reimplements
- Push is exactly-once across restarts
- One phone fans out to every matching patient
- A revoked link blocks delivery
- `telegram_settings` is unreachable through `/api/db`
- Settings RPC is admin-only; the token never crosses the wire
- Renderer smoke test, skipped when Chrome is absent

## Out of scope

Webhooks (polling only, so no inbound port), multi-clinic/multi-token,
patient uploads, and live chat with staff.

## Delivery order

1. **Token section** — migration, encryption, admin-only RPC, settings UI,
   connection test. Independently useful and verifiable.
2. Bot worker, linking flow, patient menu.
3. Shared renderer extraction + PDF.
4. Push pipeline.
5. Linked-accounts and delivery-log UI.
