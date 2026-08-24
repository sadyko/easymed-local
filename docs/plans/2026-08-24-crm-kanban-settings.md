# Plan: Settings reorganisation + CRM kanban settings (stages, sources, telephony routing)

Owner's assignment (2026-08-24), two parts:

**A. Regroup the settings hub** into two new groups, moving tiles out of «Основное»:
- **«Системные настройки»** — CRM-канбан, Телефония, Telegram-бот, API
- **«Настройки Easy-Med»** — Компания, Система

**B. Build the CRM kanban settings screen** that group needs, with three jobs:
1. **The kanban itself** — the columns: name, colour, order, active/hidden.
2. **Sources** — where a lead came from (call, Instagram, telephony, …).
3. **Routing** — read the statuses the telephony provider reports and decide which
   column a lead lands in. Owner's words: *"we have a telephony, its a one source,
   and there is statuses coming from Binotel — we need to read the statuses and
   setup where the lead card will go."*

## What exists today (the constraint that shapes everything)

`crm_requests` (migration 046) hardcodes BOTH vocabularies in CHECK constraints:
- `status IN ('in_process','recall','scheduled','approved','came','no_show','stopped','not_qualified')`
- `source IN ('call','instagram','telegram','website','walk_in','referral','other')`

and `views/crm.js` repeats them as `STATUSES` (key, Russian label, colour kind) and
`SOURCES`. So "configurable" means replacing two hardcoded lists in two places, and
SQLite cannot drop a CHECK — the 046 table-rebuild pattern is the only way.

Also fixed in code and NOT free to rename: `CONVERT_STATUS = 'came'` (the only path
that registers a patient), `ACTIVE_STATUSES`, `LOST_STATUSES` (funnel metrics).
Those are BEHAVIOURS, not labels — see "kind" below.

## Design

### Migration `077_crm_config.sql`

- `crm_stages`: `key` TEXT PK, `label` TEXT, `color` TEXT (a token name from the
  existing set: info/warn/purple/teal/ok/crit/none — NOT free hex, so the board keeps
  the house palette), `position` INTEGER, `is_active` INTEGER DEFAULT 1,
  `kind` TEXT CHECK IN ('open','won','lost') — the behaviour the code keys off:
  `won` is the conversion column (today 'came'), `lost` feeds LOST_STATUSES, `open`
  feeds ACTIVE_STATUSES. Seeded with today's 8 rows, same keys, same order, same
  colours → the board looks identical the moment this ships.
  - Exactly one `won` stage is allowed (a partial unique index). The conversion flow
    registers a patient; two of them would be a fork with no owner.
  - A stage that has leads cannot be deleted — only deactivated (`is_active = 0`),
    so the board stops offering it while existing cards keep a valid status.
- `crm_sources`: `key` TEXT PK, `label`, `position`, `is_active`. Seeded with today's
  7 + a new `telephony` row (the Binotel one the routing below needs).
- `crm_call_routing`: `provider` TEXT (only 'binotel' today), `disposition` TEXT,
  `action` TEXT CHECK IN ('create','ignore'), `stage_key` REFERENCES crm_stages(key),
  PK (provider, disposition). Seeded from the vendor's documented vocabulary:
  ANSWER/TRANSFER → create in the `open` stage that is first by position (today
  «В обработке»); NOANSWER/BUSY/CANCEL → create in «Перезвонить»; ONLINE and every
  SMS-*/VM-*/fax code → `ignore` (not a lead). Every seed row is a DEFAULT the owner
  can change, never a hard rule.
- Rebuild `crm_requests` the 046 way: same columns, but `status`/`source` lose their
  CHECK constraints and gain `REFERENCES crm_stages(key)` / `crm_sources(key)`.
  Data copied verbatim — every existing value has a seeded row, verified by the
  migration's own test.

### Server

- `server/services/crm/config.js`: `listStages/listSources/listRouting`,
  `saveStages` (accepts the whole ordered array — reorder + rename + recolour in one
  transaction, since that is how the screen edits it), `saveSources`, `saveRouting`.
  Guards: at least one active stage; exactly one `won`; a stage with leads may be
  deactivated but not deleted; keys are `[a-z0-9_]{1,32}` (they end up in URLs and
  CHECK-free columns).
- RPCs `crm_config_get` (everything the board and the settings screen both need, one
  call) and `crm_config_save` (admin-only via hasAnyRole; normal 402 gating).
- **Telephony → lead**: in `services/telephony/poller.js` and `webhooks.js`, after a
  call is recorded, look up `crm_call_routing` for its `disposition`; on `create`,
  insert a `crm_requests` row with `source='telephony'`, the routed `stage_key`,
  `full_name` from the matched patient (or the number), and the call's number —
  unless a lead for that phone already exists in an `open` stage, which would turn a
  chatty patient into a wall of duplicate cards. The call row and the lead are linked
  (`crm_requests.call_id`) so the card can show "from a call at 14:32".

### Frontend

- `views/settings-hub.js`: two new groups per part A. «Основное» keeps Пациенты,
  Категории, Документы, Скидки. New tile «CRM-канбан» → `nav('crm-settings')`.
- `views/crm-settings.js` — three cards:
  1. **Колонки канбана** — drag-free ordering (↑/↓ buttons, the pattern the lookup
     editors already use), inline label edit, colour picker limited to the house
     tokens, active toggle, «Добавить колонку». The `won` column is marked
     «конверсия» and cannot be deleted or deactivated.
  2. **Источники** — same list shape, simpler (label + active).
  3. **Звонки → карточки** — one row per Binotel disposition, in plain Russian
     («Не ответили», «Занято», …), each with: create a lead / ignore, and which
     column it lands in. A short honest line that this only applies while the
     Телефония module is connected and polling.
- `crm-settings-logic.js` — pure: validation (unique keys, one `won`, non-empty
  labels), reordering, the disposition→Russian map, colour vocabulary. Tests
  co-located; fake-DOM tests pin `admin.lang='ru'`.
- `views/crm.js`: `STATUSES`/`SOURCES` become the config fetched via `crm_config_get`,
  with today's arrays kept ONLY as the fallback if the RPC fails (a settings screen
  must never be able to blank the board). `CONVERT_STATUS` becomes "the `won` stage".

## Order of work

1. Settings hub regroup (part A) — small, ships on its own, owner can see it immediately.
2. Migration + server config + RPCs.
3. Settings screen + crm.js reading the config.
4. Telephony routing (needs 2 and the telephony module).

Part A first and separately on purpose: it is what the owner asked to *see*, and it
does not depend on any of B.
