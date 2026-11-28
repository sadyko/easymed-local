# EasyMed Staff

The employee platform inside EasyMed: a Telegram bot for staff plus the **HR → Посещаемость**
screen. Built in increments; this file records what exists, how to set it up, and what is
deliberately left for later.

| Increment | Scope | State |
|---|---|---|
| 1 | Staff bot, Telegram linking, QR attendance, HR attendance dashboard, corrections, suspicious-attempt log | **built** (2026-11-27) |
| 2 | Role-based bot menus: doctor schedule and statistics from real visits, department head, director | planned |
| 3 | Corporate news: audiences, Telegram delivery, read tracking, reminders (extends `clinic_news`) | planned |
| 4 | HR requests: leave, vacation, sick leave, certificates, with approval and notifications | planned |

## Setting it up at a clinic (external configuration)

1. **Create the bot.** In Telegram, open @BotFather → `/newbot`. It must be a *separate* bot —
   not the patient bot, the referral-doctor bot, the rep bot or the daily-report bot. The app
   refuses any token another clinic bot already uses (two pollers on one token steal each
   other's messages).
2. **HR → Посещаемость → Бот:** paste the token, save, press **Проверить связь** (this stores
   the bot's username, which the QR links need), then switch the bot on.
3. **Точки входа:** add one entrance per building entrance (choose the branch).
4. **Entrance screens.** On a computer, tablet or TV at each entrance, open the entrance's
   **ссылка экрана** in a browser on the clinic network and press F11. The QR code changes
   every 20 seconds (configurable 10–120). The screen needs only the clinic LAN; the *server*
   needs internet for the bot.
5. **Сотрудники и Telegram:** for each employee press **Код подключения** and give them the
   one-time link (valid 15 minutes). They open it in their own Telegram and are linked.
6. Optional: **Настройки → Роли** → row «HR · Посещаемость» to give HR staff who are not
   administrators *Просмотр* or *Изменение*. Until configured, only administrators get in.

No webhook, no public address: the bot uses long polling (outbound HTTPS to
`api.telegram.org` only), like the clinic's other bots.

## How check-in works

1. Employee scans the entrance QR → Telegram opens the bot with
   `/start a_<entrance>_<window>_<signature>`.
2. Server checks, in this order: rate limit, signature, window (current or previous only),
   entrance active, Telegram account linked, employee active, employee allowed at that branch.
   Records the scan (`attendance_scans`, unique per entrance+window+Telegram user).
3. Bot asks «Отметить приход / уход?» with **Подтвердить**. The button is valid for 2 minutes.
4. On confirm, the server decides in a transaction whether it is a check-in or check-out from
   the database state, using **server time**. A second mark within 60 seconds is refused as a
   double scan. An open shift older than 20 hours is closed as «нет ухода» (no invented hours)
   and the scan becomes a check-in.

There is **no check-in button** in the bot menu. Every refusal is written to
`attendance_flags` and shown under **Подозрительное**.

## Security model and its limits

- QR signature: HMAC-SHA256 with a per-entrance secret that never leaves the server; the
  screen receives a ready SVG. 96-bit truncated MAC, constant-time comparison.
- The screen link carries a separate `display_key`, which can only *show* the current code.
  **Новая ссылка экрана** rotates both the screen key and the signing secret.
- Identity is Telegram's `from.id`, bound by an HR-issued one-time code (SHA-256 stored, never
  the code). Phone-number matching is deliberately *not* used for staff.
- Nothing from the message is trusted for time, employee or branch.
- **Known limitation (documented as the spec asks):** a code photographed and sent to a
  colleague works for that colleague until two windows pass (≤ 40 s at the default 20 s).
  Without phone geolocation the server cannot know where a person stands. To make this
  visible, **Подозрительное** lists every QR window used by more than one employee.
  Mitigation if needed later: Telegram location sharing on confirm, or Wi-Fi/LAN presence.
- A static printed QR is **not supported** on purpose: it could be photographed once and used
  forever.

## Data (migration `304_staff_attendance.sql`)

| Table | Purpose |
|---|---|
| `staff_bot_settings`, `staff_bot_state` | bot token (encrypted with `data/.telegram-key`), switch, late-grace minutes, poll offset |
| `staff_telegram_links` | employee ↔ Telegram; one active each way; revoked, never deleted |
| `staff_link_codes` | one-time linking codes (hash only, 15 min) |
| `attendance_locations` | entrances: branch, signing secret, screen key, rotation |
| `attendance_scans` | scanned codes awaiting confirmation; replay guard |
| `attendance_sessions` | shifts: check-in, check-out, `missing_out`, `voided_at` |
| `attendance_events` | append-only log of marks and corrections |
| `attendance_flags` | refusals and suspicious attempts |
| `attendance_corrections` | HR corrections: old/new values, mandatory reason, who |

Schedules come from the existing `users.working_hours` (the employee card); late/early use
`staff_bot_settings.grace_minutes`. All new tables are `keep('staff')` in the test-data wipe.

## API (`POST /api/rpc/<name>`, permission row `hr_attendance`)

| RPC | Level | What |
|---|---|---|
| `attendance_today` | view | day board: statuses, schedule, late/early, open shifts from earlier days |
| `attendance_report` | view | period (≤ 93 days) per employee + shift rows |
| `attendance_session_get` | view | one shift with correction history |
| `attendance_correct` | edit | `create` / `edit` / `void` a shift, reason required |
| `attendance_flags_list` | view | refusals + codes shared by several employees |
| `attendance_locations_list` | view | entrances (screen link only for edit) |
| `attendance_location_save` | edit | create/update an entrance |
| `attendance_location_reset_screen` | edit | new screen link and signing secret |
| `staff_links_list` | view | employees and their Telegram link state |
| `staff_link_code_create` | edit | one-time `t.me/<bot>?start=lnk_…` link |
| `staff_link_revoke` | edit | disconnect an employee's Telegram |
| `staff_bot_settings_get` / `_save` / `staff_bot_clear_token` / `staff_bot_check` | view / edit | bot configuration |

Public, no login, key-protected and rate-limited (30/min per address):
`GET /attendance-screen/:id?k=…` (page) and `GET /api/attendance-screen/:id/qr?k=…` (JSON with SVG).

Read RPCs are in the licence gate's read-only list. The bot writes attendance directly (not
via RPC), so a lapsed licence does not stop check-ins.

## Code map

- `server/services/attendance/tokens.js` — signing, verification, QR SVG
- `server/services/attendance/core.js` — the check-in rules (no Telegram)
- `server/services/staff-bot/` — settings, linking, dialog (`flow.js`), poller (`index.js`)
- `server/services/rpc/attendance.js` — HR screen API
- `server/routes/attendance-screen.js` — entrance screen
- `public/js/admin/views/hr-attendance.js` — HR screen
- Vendored: `public/js/vendor/qrcode-generator-1.4.4.cjs` (MIT)

## Not covered by this install

"All hospitals / holding" views need data from several installs; each clinic runs its own
server. That belongs to the control plane, not to the clinic app, and is out of scope here.
