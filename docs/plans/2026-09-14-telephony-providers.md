# Plan: provider cards in Телефония — Binotel stays, onlinePBX joins

Owner (2026-09-14):

> "make in the telephony settings section a cards of the companies (now we have
> binotel with their settings) and we will add another (onlinePBX
> https://onlinepbx.evateam.ru/docs/docs/DOC-000120) i will provide you keys. so
> flow should be exactly like that. for example we in the binotel adding keys and
> ip and system automatically loads the cards."

## What the screen becomes

Настройки → Телефония opens with a row of **provider tiles**: Binotel, every
onlinePBX card the clinic added, and a dashed «Добавить провайдера». One tile is
open at a time; its settings render below it. Binotel keeps its three cards
(Подключение / Опрос звонков / WebHook-и) untouched. An onlinePBX card has two:
Подключение (name, domain, API key, default extension, «Проверить», «Сохранить»)
and Опрос звонков (toggle that saves on click, interval, last poll / last call /
last error, «Удалить провайдера»). «Звонки → заявки» and «Последние звонки» stay
shared below the tiles — the call log gains an «АТС» column.

The flow is Binotel's flow: type the keys → «Проверить подключение» proves them
against the vendor before anything is saved → «Сохранить» → switch polling on →
calls appear in the log within a minute and become leads by the shared rules.

## Storage — only ADD COLUMN / CREATE TABLE (migration 126)

- `telephony_settings` (migration 076) is **not touched**: it remains the Binotel
  card, with its poller, its webhooks and its RPCs.
- New table `telephony_providers`: one row per non-Binotel provider — `kind`
  (CHECK, today only `onlinepbx`), `name`, `enabled`, `config` (public JSON:
  `domain`, `default_extension`), `secret` (JSON, server-only: `auth_key` typed
  by the admin plus the `key_id`/`key` pair the vendor issues), `poll_interval_sec`,
  `last_poll_at`, `last_call_at`, `last_error`.
- `calls` gains `provider` (default `'binotel'` — true for every existing row)
  and `provider_id` (FK, ON DELETE SET NULL: deleting a card keeps its calls).

## Server

- `telephony/onlinepbx.js` — the vendor client, written from the vendor's own
  machine-readable spec (`https://api2.onlinepbx.ru/documentation/json`, HTTP API
  2.10.1): `POST /{domain}/auth.json {auth_key}` → `{key_id,key}` once; every
  later call carries `x-pbx-authentication: key_id:key`; `{isNotAuth:true}` means
  re-auth exactly once and retry (frequent auth breaks the vendor's sessions);
  `mongo_history/search.json` for history (7-day window), `call/now.json` for
  click-to-call. `normalizePbxCall()` maps a vendor call into the `calls`
  vocabulary Binotel established (call_type 0/1, ANSWER/NOANSWER/CANCEL,
  waitsec/billsec) so the log, the patient match and the lead routing never learn
  a second language.
- `telephony/providers.js` — the registry: `saveProvider` (an empty secret keeps
  the saved one, a changed `auth_key` drops the cached pair, poll interval clamped
  10–3600, enabling requires domain + key), `deleteProvider`, `testProvider`
  (auth if needed, then a real history read for the last minute), poll bookkeeping.
- `telephony/poller.js` — one tick polls Binotel as before, then every enabled
  provider with **its own cursor** (`MAX(started_at)` of its own calls, minus the
  overlap); one provider's failure is its `last_error` and nobody else's problem.
  `recordCall()` accepts a raw Binotel call or an already-normalised row and
  stamps `provider`/`provider_id`. `nextDelayMs()` is the fastest enabled interval.
- RPCs (admin-only, NORMAL-gated like the rest of telephony):
  `telephony_providers_list` → `{kinds, providers}` (secrets as `secret_set`),
  `telephony_provider_save`, `telephony_provider_delete`, `telephony_provider_test`.

## Lead routing

Rules stay keyed by `(provider='binotel', disposition)` and apply to every
provider, because every provider's outcomes are translated into that one
vocabulary before they reach `leadFromCall`. The screen says so under the
routing card once a second provider exists. A per-provider rule set is a data
change, not a screen change, if a vendor ever needs one.

## Not in this step

- onlinePBX **webhooks** (DOC-000071): the doc page is an EvaTeam app shell that
  cannot be fetched; polling covers the log. The receiver is added once the
  payload is known (owner to paste the page text or a sample body).
- Click-to-call from the patient card via `call/now.json` — the client function
  exists (`pbxCallNow`), the button does not yet.

## Verified live (2026-09-14, the owner's account)

`auth.json` issues the pair; `mongo_history/search.json` answered 3 250 calls for six
days (2.1 MB — the client's body cap is 16 MB for that reason, and a tick normally
re-reads only the two-minute overlap). Real shapes differ from the spec's sketch in
two ways the normaliser now honours: an inbound call's `destination_number` is the
queue or the last dialled extension, and WHO answered is the `events[type=user]`
entry with `answered_stamp`; and `accountcode` is only inbound/outbound here, so an
unanswered call's outcome comes from `hangup_cause` (USER_BUSY → BUSY,
ORIGINATOR_CANCEL → CANCEL, else NOANSWER). The first poll on the dev box filed 283
calls of the last 24 hours, 5 matched to patients, and the shared routing rules made
leads of them — the same day-one behaviour Binotel has.
