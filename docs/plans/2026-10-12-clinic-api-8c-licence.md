# API клиники, шаг 8c: сервер лицензий для публичного сервера — отпечаток ключа обмена и отметка оплаты в подписанной лицензии, «Онлайн-запись / API» в панели, подписанный список производителя со срочным отзывом ключей, ключ лицензий под стражем (PUBLIC_LICENCE_V1, CLINIC_API_STEP8C_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** публичный сервер `api.easymed.uz` (шаг 8b) становится пригодным к работе: сервер лицензий (`control-plane/`) вписывает в подписанную лицензию клиники отпечаток её ключа обмена (только когда Easy-Med включил клинике «Онлайн-запись / API») и отметку оплаты, а сам публичный сервер раз в минуту забирает у сервера лицензий подписанный список — какие клиники партнёрам не показывать и какие ключи отозваны срочно, даже если клиника без связи. Установка (машина, DNS, TLS) — не в этом плане: в конце — список для неё.

**Architecture:**
- **Два пути одного решения из панели.** Публичный сервер во время запроса сервер лицензий не спрашивает. Поэтому всё, что Easy-Med решил о клинике, доходит до него:
  - **в лицензии, которую несёт клиника** (ежечасная сверка): `subscription: 'active' | 'unpaid'` и `api_sync_key` (отпечаток принятого ключа обмена, только при включённом переключателе). Клиника 8a молчит, пока в лицензии нет её отпечатка; публичный сервер 8b без отпечатка её не пускает, а `unpaid` прячет от партнёров. Ни 8a, ни 8b для этого менять не нужно;
  - **в списке производителя, который публичный сервер забирает сам** (`GET /cp/v1/public-feed`, токен): `clinics_off` (не оплачено, снята, удалена, онлайн-запись выключена, нет принятого ключа), `sync_keys_revoked`, `partner_keys_revoked`. Так решение доходит и до клиники без связи или с подменённой программой.
- **Подпись** — тот же ключ производителя, что у лицензий, но список подписан над `"easymed-public-feed/v1\n" + canonical(payload)`: подпись списка никогда не сойдётся как подпись лицензии и наоборот. Договор — один модуль `server/services/control/vendor-feed.js`, рядом с `canonical.js` и `licence.js`, его берут обе службы.
- **Лицензия «не оплачено» не продлевает срок:** её `valid_until` — тот же, что у последней выданной (сервер лицензий теперь помнит выданное: `clinics.licence_*`). Лестница блокировки клиники не меняется ни на день.
- **Ключ производителя сверен:** в программу вшит **настоящий** ключ сервера лицензий (с 2026-08-22, коммит `6cd66c5c`); устаревший комментарий о «ключе разработки» исправлен, ключ закреплён стражем; публичный сервер чужим ключом лицензии не проверяет без явного разрешения стенда.

**Tech Stack:** Node 24 ESM, express 5.2, better-sqlite3 13, `node:crypto` (Ed25519, SHA-256), `node:test`; панель — модули без сборки (`control-plane/public/*.js`), `crypto.subtle` в браузере.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — решения владельца 4, 5, 16, 17, 20; дизайн шага 8 `docs/specs/2026-10-11-clinic-api-8-public-server-design.md` — §2 (смягчение «а»: срочный отзыв), §4 (личность клиники), §9 (неоплата), §13 (риски 2 и 6); план 8a, раздел «→ 8c»; план 8b, разделы «Что 8c должен дать 8b» и «Риски» (п. 10).

**Память:** `easymed-licence-lockout`, `easymed-clinic-api-mockup`, `easymed-ci-locale-trap`, `windows-dynamic-port-fetch-bad-port`, `bash-tool-heredoc-backslashes`, `easymed-shared-tree-hunk-commits`, `node-modules-fragility-easymed-local`.

**Код плана прогнан.** Весь код собран и прогнан в копии дерева `e8b4aab4` (основная линия после шага 9; 8b слит в `61591598`; выгрузка `git -c core.autocrlf=false archive`, LF) и проигран по задачам из текста самого плана — «Проверки плана» в конце.

**Метка кода:** `PUBLIC_LICENCE_V1` — в шапке каждого нового файла и у каждой правки.

**Метка плана и коммитов:** `CLINIC_API_STEP8C_V1`. Первая строка сообщения коммита кончается скобкой `(PUBLIC_LICENCE_V1, CLINIC_API_STEP8C_V1)`.

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | **Переключатель «Онлайн-запись / API»** живёт в сервере лицензий (`clinics.api_enabled`, по умолчанию выключен). В лицензию он выходит **присутствием `api_sync_key`**, в список производителя — строкой `clinics_off`. Отдельного поля «включено» в лицензии нет. | Отпечаток в лицензии — ровно тот сигнал, который клиника 8a уже читает (`public-sync.js vendorBlocker`: нет своего отпечатка — «ждём включения», ни одного запроса в сеть) и публичный сервер 8b уже требует (`clinic-auth.js`: нет — `invalid_signature`). Второй флаг мог бы разойтись с первым. |
| Р2 | **Лицензия с 8c:**<br>• `subscription` — всегда (`active` / `unpaid`);<br>• `api_sync_key` — только при включённом переключателе и принятом, не отозванном ключе;<br>• `issued_at` — строго позже прошлой выдачи этой клинике (`issuedAfter`, даже если часы сервера лицензий отстали);<br>• оплачено — 14 дней, как прежде;<br>• **не оплачено** и последняя выданная ещё жива — лицензия `unpaid` **с тем же `valid_until`** (`notAfter` может только укоротить срок); последней нет или она истекла — ничего, как прежде.<br>Без новых полей `signLicence` подписывает прежние шесть ключей (как CLI `make-licence.mjs`). | Решение 17: отметка «не оплачено» — в **подписанной** лицензии, при ближайшей сверке. Лестница блокировки клиники не должна сдвинуться ни на день (память `easymed-licence-lockout`). Публичный сервер берёт самую новую лицензию по `issued_at` (8b `admitClinic`). Старая клиника неизвестные поля пропускает: `verifyLicence` проверяет подпись над всем `payload`, `state.js` читает только `modules` и `valid_until` (тест задачи 4). |
| Р3 | **Отпечаток считает сервер лицензий.** Клиника 8a уже шлёт со сверкой **открытую половину** ключа (`api_sync_public_key`, base64 DER SPKI), не отпечаток. Сервер лицензий считает отпечаток той же формулой (`syncKeyFingerprint` в `sync-identity.js` — одно определение) и хранит **только отпечаток**. Программу клиники ради этого менять не нужно. | Открытая половина — не секрет; по ней сервер лицензий проверяет, что это настоящий ключ Ed25519, а не 32 случайных знака. Закрытая половина клинику не покидает (тест 8a `checkin-sync-key.test.js`). |
| Р4 | **Новый ключ обмена (другой ПК):** первый ключ клиники принимается сам; каждый следующий другой — «ждёт подтверждения» в панели (кнопка **Accept new key**), лицензия пока несёт прежний; отозванный ключ не принимается никогда. Постоянная `NEW_SYNC_KEY_NEEDS_CONFIRMATION` (вопрос владельцу 1). | Копия `install_token` клиники (`control.json`) иначе молча забрала бы её онлайн-записи вместе с именами и телефонами пациентов. Событие редкое: ключ едет с папкой данных при переносе. Доска панели помечает такую клинику «new API key waiting». |
| Р5 | **Список производителя — забирает публичный сервер** (`GET /cp/v1/public-feed`, `Authorization: Bearer <EASYMED_CP_FEED_TOKEN>`; без токена — 404, неверный — 401), раз в минуту. Список подписывается на каждый запрос (`issued_at` — «сейчас»). Публичный сервер хранит последний принятый в своей базе (`vendor_feed`), при запуске проверяет его заново, **старше принятого не берёт**. Сервер лицензий недоступен — **держит последний** (ничего не открывает и ничего не закрывает сверх него); возраст — в `/_metrics` (`feed_age_s`), тревога — у наблюдения. | Работает при клинике без связи и с подменённой программой: список несёт производитель. Тянет публичный сервер — у него нет нового входящего адреса администратора, а сервер лицензий ничего не знает о том, где стоит публичный. «Держать последний» — правило `control-plane/README.md`: день без сервера лицензий незаметен партнёрам; лицензия всё равно ограничивает клинику 14 днями. Повтор перехваченного старого списка не снимет блокировку. |
| Р6 | **Что делает список у публичного сервера:**<br>• клиника в `clinics_off` или с отозванным ключом обмена — партнёрам `503 licence_lapsed` с телефоном клиники («временно недоступна»);<br>• ключ партнёра в `partner_keys_revoked` — `401 key_disabled`, что бы ни присылала клиника;<br>• запрос клиники, подписанный отозванным ключом обмена, — `401 invalid_signature`;<br>• клиника, скрытая от партнёров, говорит с сервером как прежде (события по уже принятым записям доходят — дизайн §9). | Новых кодов ошибок нет — документации шага 9 и её стражу (`drift.test.js`) менять нечего. Слова «временно недоступна», а не «не оплатила» — правило памяти `easymed-licence-lockout`. |
| Р7 | **Ключ партнёра на сервер лицензий не приходит:** панель считает его SHA-256 в браузере (`crypto.subtle`, тот же отпечаток, что `keyHash` клиники), сервер лицензий принимает только 64 hex, а сам ключ (`em_live_…`) отвергает, не сохраняя и не возвращая. Ключ обмена клиники блокируется по отпечатку (32 hex); блокировка принятого ключа сразу убирает его и из следующей лицензии. Снятие блокировки — отметка `removed_at`/`removed_by`, история остаётся. | Решение владельца 5: наружу из клиники — только отпечатки ключей. Срочный отзыв нужен, когда клиника без связи: сама клиника (шаг 7) выключает ключ быстрым каналом за 15 секунд. |
| Р8 | **Ключ производителя.** Сверено 2026-10-12: вшитый в `licence.js` ключ — настоящий ключ сервера лицензий (`6cd66c5c`, «both trust keys are production now»; закрытая половина — только `/etc/easymed-cp/vendor-private.pem`, `docs/HANDOVER.md`). Комментарий в `licence.js` о «ключе разработки» и о предупреждении `DEV_KEY_FINGERPRINT` устарел (проверка удалена тем же коммитом) — исправлен; заметка плана 8b (п. 2 «Что 8c должен дать», риск 10) на нём и основана. Стражи:<br>• `vendor-key.test.js` — отпечаток вшитого ключа = `46de4fe9a62a7f1349bdd3658be1696a`, не ключ разработки `d1deb8cc…` и не заглушка;<br>• публичный сервер — `licence-key.js`: без `PUBLIC_LICENCE_PUBLIC_KEY` вшитый ключ; чужой ключ — только вместе с `PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1` (стенд), иначе служба не запускается; журнал при запуске называет ключ; `/_metrics` — `licence_key`;<br>• сервер лицензий при запуске пишет `Signing key: the production vendor key.` или громкое предупреждение (не отказ: локальная разработка с одноразовым ключом законна, `docs/HANDOVER.md` §5). | Чужой ключ у публичного сервера — «кто держит его закрытую половину, тот любая клиника»: подпишет себе лицензию со своим ключом обмена, пришлёт свой `box_key` и получит данные пациентов из новых онлайн-записей. |
| Р9 | **Порт публичного сервера — 8096**, не 8095 (умолчание `config.js` и `DEPLOY.md`). | На 45.77.242.169 порт 8095 занят сервером лицензий (`easymed-cp`, `docs/HANDOVER.md` «Panel»; план 2026-09-05 проверяет `127.0.0.1:8095/cp/`). С прежним умолчанием служба не запустилась бы (`EADDRINUSE`). Список производителя на той же машине берётся напрямую: `PUBLIC_FEED_URL=http://127.0.0.1:8095/cp/v1/public-feed`. |
| Р10 | **Панель — по-английски, как вся панель** (Modules, Subscription, Retire): карточка **Online booking / API** на странице клиники — переключатель, «что видят партнёры», «что сказано лицензии клиники», ключ обмена (принят / ждёт подтверждения / заблокировать), блокировки ключей партнёров. Доска — причина «new API key waiting». Решения — чистые функции `panel-logic.js` с тестами. | Язык панели — английский во всех экранах; смешивать нельзя. Отметка оплаты в панели уже есть (карточка Subscription: Active / Unpaid + Paid until) — 8c её не трогает, только показывает следствие для партнёров. |
| Р11 | **Кто может:** любой вход в панель — ролей у продавцов нет (`002_vendor_users.sql`), как для модулей и оплаты (вопрос владельцу 2). Кто и когда заблокировал или снял блокировку — в строке `revocations`. | Без ролей нечего сужать; роли — отдельная работа. |
| Р12 | **Данных пациентов на сервере лицензий нет и не будет:** новые колонки и таблица проходят страж `no-patient-data-to-vendor.test.js`; в списке — только номера клиник и отпечатки; сквозной тест проверяет, что в базе сервера лицензий нет ни ключа партнёра, ни открытой половины ключа клиники. | Решение 5 и шапка `001_registry.sql`. |
| Р13 | **Два сборщика:** А — сервер лицензий и общий договор (задачи 0–7), Б — публичный сервер (8–11). Общих файлов нет. Б начинает после задачи 1. | Задача 11 (сквозной прогон) ждёт задач 6 и 10. |

---

## Что 8c закрывает

| Требование | Задача |
|---|---|
| Лицензия: `api_sync_key` (отпечаток из сверки), `subscription` (`active` / `unpaid`), `issued_at` растёт на каждой выдаче; новая лицензия при ближайшей сверке после смены отметки или ключа | 3, 4 |
| Обратная совместимость: старые клиники и старые лицензии без новых полей работают как прежде; проверяющий клиники пропускает незнакомые поля; тесты через границу каталогов (подпись ↔ клиника ↔ публичный сервер) | 3, 4, 11 |
| Сверка несёт ключ обмена — только открытая половина (8a), сервер лицензий хранит только отпечаток; новый ключ записан и помечен в панели | 4, 6, 7 |
| Панель: «Онлайн-запись / API» на клинику, что видят партнёры | 6, 7 |
| Срочный отзыв: подписанный список отозванных ключей партнёров и ключей обмена, который публичный сервер забирает сам — работает при клинике без связи и с подменённой программой; адрес, подпись, хранение, поведение при сбое; панель — добавить и снять | 1, 5, 6, 7, 9, 10 |
| Какой ключ подписывает настоящие лицензии сегодня; публичный сервер проверяет **настоящим** ключом; настройка и страж | 1, 3, 5, 8 |
| Тесты: модульные, HTTP, договор через границу каталогов; страж «нет данных пациентов на сервере лицензий» — зелёный | все; 2, 11 |
| План 8b, «Что 8c должен дать»: п. 1 (лицензия), 2 (ключ производителя), 6 (переключатель), 7 (срочный отзыв) — код; п. 3–5 и 8 — список установки в конце плана | 1–11 |
| Дизайн шага 8: §2 смягчение «а» (срочный отзыв), риск 6 (новый ключ при новом ПК) | 4–10 |

---

## Карта файлов

**Общий договор (дерево клиники) — задача 1:**
- новые: `server/services/control/vendor-feed.js` (список производителя: вид, подпись, проверка), тесты `vendor-feed.test.js`, `vendor-key.test.js`;
- правки: `server/services/control/licence.js` (комментарий о ключе, `vendorPublicKey()`), `server/services/api/sync-identity.js` (`syncKeyFingerprint`) и его тест.

**Сервер лицензий (`control-plane/`) — задачи 2–7:**
- новые: `server/db/migrations/011_public_api.sql` (+ `011.test.js`), `server/services/public-api.js` (+ тест), `server/services/checkin-public-api.test.js`, `server/routes/public-feed.js` (+ тест), `server/routes/admin-public-api.js` (+ тест), `public/panel-api-card.js`, `public/panel-public-api.test.js`;
- правки: `server/services/signing.js` (+ тест), `server/services/checkin.js`, `server/routes/checkin.js`, `server/routes/checkin.route.test.js`, `server/routes/deploy.js` (экспорт двух функций токена), `server/app.js`, `server/index.js`, `server/routes/admin.js`, `public/panel-logic.js`, `public/panel-api.js`, `public/panel-clinic-detail.js`, `public/panel.css`, `server/panel.test.js`, `README.md`.

**Публичный сервер (`public-server/`) — задачи 8–11:**
- новые: `server/licence-key.js` (+ тест), `server/db/migrations/002_vendor_feed.sql`, `server/store/feed.js` (+ тест), `server/test-helpers/feed-fixture.js`, `server/feed.app.test.js`, `server/routes/feed-gate.http.test.js`, `server/e2e.licence.test.js`;
- правки: `server/config.js` (+ тест), `server/index.js`, `server/app.js`, `server/jobs.js`, `server/routes/ops.js`, `server/routes/partner-auth.js`, `server/routes/sync.js`, `server/db/schema.test.js`, `DEPLOY.md`.

**Документы:** этот план — `docs/plans/2026-10-12-clinic-api-8c-licence.md` (задача 0).

Итого: 24 новых файла (с планом; 13 файлов тестов, и один помощник тестов) и 28 правок (из них 6 файлов тестов). Новых тестов — 60.

---

## Сейчас в коде (сверено 2026-10-12, деревья `61591598` и `e8b4aab4`)

- **Шаг 9 уже в основной линии** (`e8b4aab4`): `/docs` на публичном сервере (`routes/docs.js`), `createPublicServer({…, uncollectedMaxMs})`, `DEFAULT_TZ_OFFSET_MIN` в `config.js`, `/docs` в nginx `DEPLOY.md`; страж документации `public-server/server/docs/drift.test.js` сверяет коды ошибок — 8c новых кодов не вводит. Блоки diff этого плана сведены с `e8b4aab4`.

- **Подпись** — `control-plane/server/services/signing.js signLicence({clinicId, clinicName, modules, days=14})`: шесть ключей (`clinic_id`, `clinic_name`, `modules`, `valid_until`, `issued_at`, `nonce`), `issued_at = new Date()`, свой `valid_until` от вызывающего не принимается. Ключ — `EASYMED_SIGNING_KEY`, кэш на путь, `ensureSigningKey()` при запуске.
- **Сверка** — `services/checkin.js checkIn()`: строка `checkins` и `last_seen_at` — в транзакции, подпись — после. `isEntitled(subscription, subscription_until)` (не экспортирована): не оплачено или срок «оплачено до» прошёл — **`licence: null`**, `subscription: 'unpaid'`; клиника доживает выданное. Маршрут `routes/checkin.js` берёт из тела только свои поля — **`api_sync_public_key` пропускает**.
- **Отметка оплаты в панели уже есть:** `clinics.subscription` (`active` | `unpaid`, CHECK) и `subscription_until`, `POST /admin/clinics/:id/subscription`, карточка **Subscription** на странице клиники.
- **Ключ производителя** — `server/services/control/licence.js`: PEM `MCowBQYDK2VwAyEAXaSA2ArkuT/…` — **настоящий** с 2026-08-22 (`6cd66c5c`); отпечаток DER-SHA-256 `46de4fe9a62a7f1349bdd3658be1696a`. Ключ разработки (`…ViIP4qnV…`, отпечаток PEM `d81d431a…` = прежний `DEV_KEY_FINGERPRINT`) в дереве не встречается нигде. Комментарий над PEM всё ещё описывает ключ разработки и «предупреждение при каждом запуске» — устарел.
- **Клиника 8a:** `checkin.js` шлёт `api_sync_public_key` (открытая половина), если файл ключа есть; `public-sync.js vendorBlocker` — `payload.api_sync_key === identity.fingerprint`, иначе `not_enabled` и ни одного запроса; `sync-identity.js` — отпечаток `sha256(DER SPKI).slice(0, 32)`. Файл ключа создаёт такт обмена (`loadSyncIdentity({create:true})`), когда клиника настроила имя в адресе и хоть одно подключение.
- **Публичный сервер 8b:** `clinic-auth.js` — лицензия производителя (`verifyLicence`, ключ — `PUBLIC_LICENCE_PUBLIC_KEY` или вшитый), `api_sync_key` = отпечаток ключа из заголовка; `licence-gate.js subscriptionOf` — `unpaid` только явное; `store/clinics.js admitClinic` — самая новая лицензия по `issued_at`; `partner-auth.js` — `503 licence_lapsed` с телефоном при `unpaid`/истёкшей; ошибки — `lib/errors.js` (30 кодов). `index.js` читает `PUBLIC_LICENCE_PUBLIC_KEY` без всякой проверки, чей он. Порт по умолчанию — **8095**.
- **Сервер лицензий на машине** — `docs/HANDOVER.md`: systemd `easymed-cp`, `/opt/easymed-cp`, **127.0.0.1:8095**, на 45.77.242.169 (план `docs/plans/2026-09-05-control-plane-v2-stage1.md`, шаги установки). Публичный сервер ставится туда же (решение 16) — **конфликт порта 8095**.
- **Панель** — английская; страница клиники `public/panel-clinic-detail.js` (две колонки карточек), доска `panel-clinics-list.js` (причины — `panel-logic.js attentionReasons`), запросы — `panel-api.js`. Ролей нет (`002_vendor_users.sql`). Маршруты администратора — `routes/admin.js` + `ADMIN_ROUTE_TABLE` (состязательный тест: каждый — 401 без входа).
- **Токен-маршрут** — `routes/deploy.js`: `MIN_TOKEN_CHARS = 32`, `bearerToken`, `tokenMatches` (постоянное время) — не экспортированы.
- **Страж данных пациентов** — `server/services/api/no-patient-data-to-vendor.test.js`: в таблицах и колонках сервера лицензий нет `patient|visit|diagnos|appointment|booking|slot|request_id|api_request|crm|…`, в маршрутах — адресов `/appointments`, `/inbox`, `/_sync`, `/slots`, `/patients`.
- **`node_modules`** — от корня репозитория (у `control-plane/` и `public-server/` своих нет).

---

## Правила рабочего дерева (читать до первого шага)

**Дерево** назначает контролёр:
- ветка `feat/clinic-api-step8c` от основной линии `e8b4aab4` (после шага 9). Если основная ушла дальше, место правки находить `grep -n` по строке из diff;
- клон с `core.autocrlf=false` и своей копией `node_modules`, как `easymed.api7`; ветку не переключать; worktree не создавать — он стирает `node_modules` (память `node-modules-fragility-easymed-local`);
- запущенные серверы (:8000, :8712) и каталог `data/` не трогать.

**Два сборщика в одном клоне:** у каждого файла один хозяин — А: `server/services/…` (задача 1), `control-plane/`, `docs/`; Б: `public-server/`. Файлы, которые в том же клоне могут править сборщики других шагов (`public-server/server/app.js`, `index.js`, `DEPLOY.md`), коммитить **только своими строками**, точным блобом:
  1. свои добавленные и удалённые строки записать в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/mine/step8c-<A|B>-<имя файла>.txt` (добавленная — с `+`, удалённая — с `-`, ровно как в файле);
  2. `node C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/exact-blob.mjs <клон> <файл> <mine.txt>` — показать, что ляжет;
  3. то же с `--stage`;
  4. после коммита файл `mine` очистить.
  Если `git diff -U0 -- <файл>` показывает только свои ханки — достаточно `git add <файл>`.

**Перед каждым коммитом:**
1. `git status --short`.
2. `git diff --cached --name-only` пуст. Если нет — кто-то собирает коммит: подождать, ничего не снимать.
3. `git add` — **только файлы задачи, поимённо** (или точным блобом — выше).

**Запрещено:**
- `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`;
- `npm install` где бы то ни было — модули есть;
- пушить и ставить тег — это делает контролёр;
- запускать `control-plane/server/index.js` и `public-server/server/index.js` (они слушают настоящие порты) — только тесты.

**Файлы и коммиты:**
- Файлы — LF. Проверка: `git diff --cached --stat`, `git ls-files --eol <файл>` показывает `i/lf`.
- Новый файл кладётся **целиком** блоком плана — инструментом **Write**, не `cat <<EOF` в bash: оболочка съедает `\\` и `\n` (память `bash-tool-heredoc-backslashes`), а в блоках они есть (`FEED_CONTEXT`, регулярные выражения).
- Правка существующего файла — блоком diff: записать его Write в файл (например, `scratchpad/msgs/step8c-<N>.diff`), `git -c core.autocrlf=false apply --check <файл>`, затем `git -c core.autocrlf=false apply <файл>` (на этой машине системный `core.autocrlf=true` — без `-c` вне клона `git apply` пишет CRLF). Не легло (основная ушла вперёд) — внести руками по строкам `+` и `-`. Блоки diff файлов `.md` — в четырёх обратных кавычках (внутри есть свои ```).
- Сообщение коммита — Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/step8c-<N>.txt`, затем `git commit -F <файл>`; по-русски; первая строка — текст коммита из задачи с хвостом `(PUBLIC_LICENCE_V1, CLINIC_API_STEP8C_V1)`; после пустой строки — абзац «что и почему» своими словами; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

**Тесты:**
- Только явными путями, из корня клона: `node --test <файлы>`. Каталог аргументом не передавать (Node 24 на Windows). **Перед запуском — проверить, что список файлов не пуст** (в команде плана файлы названы поимённо; если собираете список сами — `ls` каждого).
- Каждый раз — дважды: как есть и как CI на en-US: `node --import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs --test <файлы>`. Нет файла — восстановить: `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });` (память `easymed-ci-locale-trap`).
- `LIS_ENABLED=0` — перед командой (`LIS_ENABLED=0 node --test …` в bash; в PowerShell — `$env:LIS_ENABLED='0';`) для задач 4 и 11: они поднимают приложение клиники.
- **Порты:** ни одного настоящего. Серверы тестов — только через `listen()` из `control-plane/server/test-helpers/listen.js` (случайный порт 127.0.0.1).
- **Интернет** не нужен и не трогается: список производителя в тестах забирается с сервера на случайном порту; страж `assertFeedUrlIsTestSafe` не пускает тест на `settings.easymed.uz`.
- **Ключи:** только выпущенные во время теста (одноразовые пары Ed25519, `newApiKey()`) или строки с `TESTONLY`.
- **Сторожа каждой задачи** (входят в команды задач): `server/services/api/no-real-api-keys.test.js server/test-helpers/no-test-helpers-in-production.test.js public-server/server/not-shipped.test.js server/services/api/no-patient-data-to-vendor.test.js` — 7 тестов. Ниже `<СТОРОЖА>` — эти четыре файла.
- **Полный прогон** делает контролёр («Завершение»).

---

## Порядок и два сборщика

**Сборщик А — общий договор и сервер лицензий:** задачи 0–7. **Сборщик Б — публичный сервер:** задачи 8–11.

Столбец «Нужны до начала» — что должно быть **закоммичено** до начала задачи.

| Задача | Сборщик | Нужны до начала |
|---|---|---|
| 0 План в репозиторий | А | — |
| 1 Общий договор: отпечаток ключа обмена, список производителя, страж ключа производителя | А | 0 |
| 2 Сервер лицензий: миграция 011 — переключатель, ключ обмена, выданная лицензия, отзыв | А | 1 |
| 3 Подпись: оплата и отпечаток в лицензии, срок только короче, `issued_at` растёт, подпись списка | А | 2 |
| 4 Сверка: отпечаток из открытой половины, новый ключ ждёт подтверждения, лицензия «не оплачено» с прежним сроком | А | 3 |
| 5 Список производителя `GET /cp/v1/public-feed`, ключ подписи при запуске, README | А | 4 |
| 6 Панель — маршруты: переключатель, принять новый ключ, блокировки ключей | А | 5 |
| 7 Панель — экран: карточка «Online booking / API», доска | А | 6 |
| 8 Публичный сервер: ключ лицензий под стражем, настройки списка, порт 8096 | Б | 1 |
| 9 Публичный сервер: список производителя — база, фон, `/_metrics` | Б | 8 |
| 10 Публичный сервер: список у входа партнёров и в канале клиники | Б | 9 |
| 11 Сквозной прогон трёх служб, `DEPLOY.md` | Б | 6, 10 |

Б начинает, как только закоммичена задача 1, и идёт параллельно с А; к задаче 11 Б ждёт задачу 6.

---

## Task 0: План в репозиторий

Сборщик А.

**Files:**
- Create: `docs/plans/2026-10-12-clinic-api-8c-licence.md` — копия этого файла (LF).

- [ ] **Step 1:** скопировать план; `git ls-files --eol` после `git add` — `i/lf`.
- [ ] **Step 2: коммит** «План шага 8c API клиники: сервер лицензий — отпечаток ключа обмена и отметка оплаты в подписанной лицензии, переключатель «Онлайн-запись / API», подписанный список производителя со срочным отзывом ключей, ключ лицензий под стражем, порт публичного сервера 8096» — один файл.

---

## Task 1: Общий договор — отпечаток ключа обмена, список производителя, страж ключа производителя (PUBLIC_LICENCE_V1)

Сборщик А. После коммита этой задачи начинает сборщик Б.

**Files:**
- Create: `server/services/control/vendor-feed.js` — вид, подпись и проверка списка производителя (общий для сервера лицензий и публичного сервера).
- Create: `server/services/control/vendor-feed.test.js`, `server/services/control/vendor-key.test.js`.
- Modify: `server/services/control/licence.js` — комментарий о ключе (он настоящий), `vendorPublicKey()`.
- Modify: `server/services/api/sync-identity.js` — `syncKeyFingerprint()`; `sync-identity.test.js` — её тест.

- [ ] **Step 1: падающие тесты** — новые файлы целиком:

**Файл `server/services/control/vendor-key.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — СТРАЖ КЛЮЧА ПРОИЗВОДИТЕЛЯ. Какой открытый ключ вшит в
// программу, решает, чьи лицензии принимает каждая клиника и публичный сервер
// api.easymed.uz. Сверено 2026-10-12: вшит НАСТОЯЩИЙ ключ сервера лицензий
// (коммит 6cd66c5c от 2026-08-22, закрытая половина — только на сервере
// лицензий, /etc/easymed-cp/vendor-private.pem); ключ разработки 2026-08-20
// снят тогда же. Замена ключа — сознательный шаг с правкой этого теста.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vendorPublicKey, verifyLicence } from './licence.js';
import { canonical } from './canonical.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fp = (key) => crypto.createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 32);

/** DER-SHA-256 (первые 32 hex) настоящего ключа сервера лицензий. */
const PRODUCTION_VENDOR_KEY_FP = '46de4fe9a62a7f1349bdd3658be1696a';
/** Ключ разработки 2026-08-20 (закрытая половина лежала в песочнице) и заглушка до него. */
const RETIRED_KEY_FPS = ['d1deb8cc45ab46637ab1ecd9ec8a20fd'];
const PLACEHOLDER_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----';

test('в программу вшит настоящий ключ сервера лицензий — не ключ разработки и не заглушка', () => {
  const k = vendorPublicKey();
  assert.equal(k.asymmetricKeyType, 'ed25519');
  assert.equal(fp(k), PRODUCTION_VENDOR_KEY_FP);
  assert.ok(!RETIRED_KEY_FPS.includes(fp(k)));
  assert.notEqual(fp(k), fp(crypto.createPublicKey(PLACEHOLDER_PEM)));
});

test('verifyLicence без ключа в параметрах проверяет именно этим ключом: чужая подпись — bad_signature', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const payload = { clinic_id: 'c-000047', clinic_name: 'X', modules: [], valid_until: '2099-01-01T00:00:00Z', issued_at: '2026-10-12T00:00:00Z', nonce: 'TESTONLY' };
  const doc = JSON.stringify({ payload, sig: crypto.sign(null, Buffer.from(canonical(payload)), other.privateKey).toString('base64') });
  assert.deepEqual(verifyLicence(doc, { clinicId: 'c-000047' }), { ok: false, reason: 'bad_signature' });
  assert.equal(verifyLicence(doc, { clinicId: 'c-000047', publicKey: other.publicKey }).ok, true, 'тот же документ своим ключом — да');
});

test('в исходниках licence.js ровно один открытый ключ, и в шапке нет ссылки на снятую проверку DEV_KEY_FINGERPRINT как на действующую', () => {
  const src = fs.readFileSync(path.join(HERE, 'licence.js'), 'utf8');
  assert.equal((src.match(/BEGIN PUBLIC KEY/g) || []).length, 1);
  assert.match(src, /THIS IS THE PRODUCTION KEY/);
  assert.doesNotMatch(src, /logs a warning at every boot while it is in\s*\n?\s*\/\/\s*place/);
});
```

**Файл `server/services/control/vendor-feed.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — список производителя для публичного сервера: подпись
// своим контекстом (не путается с лицензией), строгий вид, потолки, никогда не
// бросает.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonical } from './canonical.js';
import { verifyLicence } from './licence.js';
import { feedMessage, makeFeedPayload, verifyFeed, FEED_LIMITS, FEED_CONTEXT } from './vendor-feed.js';

const vendor = crypto.generateKeyPairSync('ed25519');
const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);
const signFeed = (payload, key = vendor.privateKey) => JSON.stringify({ payload, sig: crypto.sign(null, feedMessage(payload), key).toString('base64') });
const base = () => makeFeedPayload({ issuedAt: '2026-10-12T10:00:00.000Z', clinicsOff: ['c-000002', 'c-000001', 'c-000002'],
  syncKeysRevoked: [FP], partnerKeysRevoked: [HASH] });

test('makeFeedPayload: вид и версия, списки без повторов и по порядку', () => {
  assert.deepEqual(base(), { kind: 'easymed-public-feed', v: 1, issued_at: '2026-10-12T10:00:00.000Z', clinics_off: ['c-000001', 'c-000002'],
    sync_keys_revoked: [FP], partner_keys_revoked: [HASH] });
});

test('подписанный список проверяется; правка любого поля — bad_signature; чужой ключ — bad_signature', () => {
  const ok = verifyFeed(signFeed(base()), { publicKey: vendor.publicKey });
  assert.deepEqual(ok, { ok: true, feed: { issued_at: '2026-10-12T10:00:00.000Z', clinics_off: ['c-000001', 'c-000002'], sync_keys_revoked: [FP], partner_keys_revoked: [HASH] } });
  const doc = JSON.parse(signFeed(base()));
  doc.payload.clinics_off = ['c-000001'];
  assert.deepEqual(verifyFeed(JSON.stringify(doc), { publicKey: vendor.publicKey }), { ok: false, reason: 'bad_signature' });
  const other = crypto.generateKeyPairSync('ed25519');
  assert.deepEqual(verifyFeed(signFeed(base(), other.privateKey), { publicKey: vendor.publicKey }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyFeed(signFeed(base()), {}), { ok: false, reason: 'bad_signature' }, 'без ключа в параметрах — ключ, вшитый в программу');
});

test('список и лицензия не подменяют друг друга, даже подписанные одним ключом', () => {
  const feedDoc = JSON.parse(signFeed(base()));
  const asLicence = verifyLicence(JSON.stringify({ payload: { ...feedDoc.payload, clinic_id: 'c-000001' }, sig: feedDoc.sig }), { publicKey: vendor.publicKey, clinicId: 'c-000001' });
  assert.equal(asLicence.ok, false);
  const plain = verifyLicence(JSON.stringify(feedDoc), { publicKey: vendor.publicKey, clinicId: 'c-000001' });
  assert.equal(plain.reason, 'bad_signature', 'подпись списка — над FEED_CONTEXT + canonical, лицензия — над canonical');
  const licenceSig = crypto.sign(null, Buffer.from(canonical(feedDoc.payload)), vendor.privateKey).toString('base64');
  assert.deepEqual(verifyFeed(JSON.stringify({ payload: feedDoc.payload, sig: licenceSig }), { publicKey: vendor.publicKey }),
    { ok: false, reason: 'bad_signature' }, 'подпись «как у лицензии» над теми же полями списком не считается');
  assert.ok(feedMessage(feedDoc.payload).toString('utf8').startsWith(FEED_CONTEXT));
});

test('строгий вид: чужой kind или v, плохое время, неверные записи — malformed; мусор — malformed, без исключений', () => {
  const bad = [
    { ...base(), kind: 'licence' }, { ...base(), v: 2 }, { ...base(), issued_at: 'вчера' },
    { ...base(), clinics_off: ['../x'] }, { ...base(), sync_keys_revoked: ['AB'.repeat(16)] }, { ...base(), partner_keys_revoked: ['em_live_x'] },
    { ...base(), clinics_off: 'c-1' }, { ...base(), partner_keys_revoked: [HASH, 5] },
  ];
  for (const p of bad) assert.deepEqual(verifyFeed(signFeed(p), { publicKey: vendor.publicKey }), { ok: false, reason: 'malformed' }, JSON.stringify(p).slice(0, 60));
  for (const raw of [null, undefined, '', 'не json', '[]', '{}', '{"payload":null}', JSON.stringify({ payload: base(), sig: 'не base64!' }), Buffer.from('{')]) {
    assert.deepEqual(verifyFeed(raw, { publicKey: vendor.publicKey }), { ok: false, reason: 'malformed' });
  }
});

test('потолки: тело больше 2 МБ — too_large; клиник больше потолка — malformed', () => {
  assert.deepEqual(verifyFeed('x'.repeat(FEED_LIMITS.bytes + 1), { publicKey: vendor.publicKey }), { ok: false, reason: 'too_large' });
  const many = makeFeedPayload({ issuedAt: '2026-10-12T10:00:00.000Z', clinicsOff: Array.from({ length: FEED_LIMITS.clinics + 1 }, (_, i) => 'c-' + i) });
  assert.deepEqual(verifyFeed(signFeed(many), { publicKey: vendor.publicKey }), { ok: false, reason: 'malformed' });
});
```

и diff к тесту личности клиники:

```diff
diff --git a/server/services/api/sync-identity.test.js b/server/services/api/sync-identity.test.js
index e2d9a4d..b35d8c2 100644
--- a/server/services/api/sync-identity.test.js
+++ b/server/services/api/sync-identity.test.js
@@ -9,6 +9,7 @@ import path from 'node:path';
 import { tmpDir } from '../../test-helpers/tmpdir.js';
 import {
   SYNC_KEY_FILE, loadSyncIdentity, signRequest, verifyRequest, sealFor, openSealed, canonicalRequest, SyncIdentityError,
+  syncKeyFingerprint,
 } from './sync-identity.js';
 
 const fresh = () => path.join(tmpDir('em-sync-id-'), SYNC_KEY_FILE);
@@ -59,3 +60,15 @@ test('испорченный файл — копия; испорчены оба
   fs.writeFileSync(p + '.bak', '{"v":1,"sign":"xx","box":"yy"}');
   assert.throws(() => loadSyncIdentity({ keyPath: p, create: true }), SyncIdentityError);
 });
+
+// PUBLIC_LICENCE_V1 — отпечаток присланной открытой половины считается так же,
+// как свой: его вписывает в лицензию сервер лицензий (шаг 8c).
+test('syncKeyFingerprint: открытая половина → тот же отпечаток, что у клиники; ящик, мусор, лишние байты — пусто', () => {
+  const id = loadSyncIdentity({ keyPath: fresh(), create: true });
+  assert.equal(syncKeyFingerprint(id.signPublic), id.fingerprint);
+  assert.match(id.fingerprint, /^[0-9a-f]{32}$/);
+  const longer = Buffer.concat([Buffer.from(id.signPublic, 'base64'), Buffer.from([0])]).toString('base64');
+  for (const bad of [id.boxPublic, '', 'не ключ', null, undefined, 42, {}, longer, 'A'.repeat(201)]) {
+    assert.equal(syncKeyFingerprint(bad), '', String(bad).slice(0, 20));
+  }
+});
```

- [ ] **Step 2:** `node --test server/services/control/vendor-key.test.js server/services/control/vendor-feed.test.js server/services/api/sync-identity.test.js` → все три файла красные при загрузке:
  - `SyntaxError: The requested module './licence.js' does not provide an export named 'vendorPublicKey'`;
  - `ERR_MODULE_NOT_FOUND … vendor-feed.js`;
  - `… './sync-identity.js' does not provide an export named 'syncKeyFingerprint'`.
- [ ] **Step 3: правки** — diff к `licence.js` (смысл комментария: ключ настоящий; экспорт ключа для публичного сервера и проверки списка):

```diff
diff --git a/server/services/control/licence.js b/server/services/control/licence.js
index 35b7044..5560e4d 100644
--- a/server/services/control/licence.js
+++ b/server/services/control/licence.js
@@ -6,22 +6,20 @@ import { canonical } from './canonical.js';
 // Ed25519 is used because node:crypto has it built in: this project has exactly
 // three runtime dependencies and licensing was not going to be the fourth.
 //
-// REPLACE THIS at first release with the real public key printed by
-// `node scripts/make-licence.mjs keygen` (a later task builds that tool). The
-// matching private key must never exist anywhere except the control plane. The
-// placeholder below is a real, valid Ed25519 key whose private half was
-// discarded, so an un-replaced build fails closed: no licence can ever verify
-// against it.
+// PUBLIC_LICENCE_V1 (2026-10-12) — THIS IS THE PRODUCTION KEY. Installed
+// 2026-08-22 (commit 6cd66c5c, "both trust keys are production now"): its
+// private half was generated ON the control-plane server and never left it
+// (/etc/easymed-cp/vendor-private.pem — docs/HANDOVER.md, "Keys"). Every real
+// clinic licence since then is signed with it. The development key that sat
+// here from 2026-08-20 to 2026-08-22, and the boot warning that watched for it
+// (DEV_KEY_FINGERPRINT in server/index.js), are both gone; the older comment
+// that still described them was stale and misled the step-8b plan.
 //
-// Installed 2026-08-20 so the local dev instance is usable: with the discarded
-// placeholder in place, no licence could verify and the whole app sat read-only.
-// Its private half lives in this machine's scratchpad and is worth nothing.
-//
-// Before the first real install the owner must run `make-licence.mjs keygen`,
-// store that private key somewhere deliberate and backed up, and paste its public
-// half here. Shipping THIS key would let anyone holding the throwaway private key
-// license themselves. server/index.js logs a warning at every boot while it is in
-// place — see DEV_KEY_FINGERPRINT there.
+// The same key also verifies, on the public server api.easymed.uz, every clinic
+// licence (public-server/server/clinic-auth.js) and the vendor-signed list of
+// clinics hidden from partners and revoked keys (vendor-feed.js). Its
+// DER-SHA-256 fingerprint is pinned by vendor-key.test.js: replacing it is a
+// deliberate, test-visible act, never a side effect.
 const VENDOR_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
 MCowBQYDK2VwAyEAXaSA2ArkuT/Ci1VjOzeCx/vsYZNiuKwsF1yceOrRCjM=
 -----END PUBLIC KEY-----`;
@@ -32,6 +30,11 @@ function defaultKey() {
   return _defaultKey;
 }
 
+/** PUBLIC_LICENCE_V1 — the compiled-in vendor key, for the public server's own key check and the feed verifier. */
+export function vendorPublicKey() {
+  return defaultKey();
+}
+
 // Deliberately excludes '-' and '_': a base64url signature (as some tools emit)
 // fails here as "malformed" rather than being silently mis-decoded as base64
 // and handed to verify() with the wrong bytes. Checked with a test.
```

diff к `sync-identity.js` (отпечаток присланной открытой половины; не каноническая запись DER — пусто, чтобы три стороны считали одно и то же):

```diff
diff --git a/server/services/api/sync-identity.js b/server/services/api/sync-identity.js
index 98bcad6..27bb31f 100644
--- a/server/services/api/sync-identity.js
+++ b/server/services/api/sync-identity.js
@@ -66,6 +66,25 @@ function shape(signPrivate, boxPrivate) {
   };
 }
 
+/**
+ * PUBLIC_LICENCE_V1 — отпечаток ОТКРЫТОЙ половины ключа подписи, присланной
+ * строкой base64 (DER SPKI): первые 32 hex SHA-256 от DER — та же формула, что
+ * fingerprint выше и keyFingerprint публичного сервера (clinic-auth.js). Им
+ * пользуется сервер лицензий: клиника шлёт открытую половину при сверке
+ * (api_sync_public_key), отпечаток уходит в подписанную лицензию. Не Ed25519,
+ * мусор, не каноническая запись DER, длиннее 200 знаков — ''. Никогда не бросает.
+ */
+export function syncKeyFingerprint(signPublicB64) {
+  const s = typeof signPublicB64 === 'string' ? signPublicB64.trim() : '';
+  if (!s || s.length > 200) return '';
+  try {
+    const raw = Buffer.from(s, 'base64');
+    const key = crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
+    if (key.asymmetricKeyType !== 'ed25519' || !der(key).equals(raw)) return '';
+    return sha256(raw).slice(0, 32);
+  } catch { return ''; }
+}
+
 /**
  * Личность клиники. Нет файла — null (или новая пара, если create).
  * @returns {{signPrivate, boxPrivate, signPublic:string, boxPublic:string, fingerprint:string}|null}
```

и новый модуль договора:

**Файл `server/services/control/vendor-feed.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — СПИСОК ПРОИЗВОДИТЕЛЯ ДЛЯ ПУБЛИЧНОГО СЕРВЕРА: какие клиники
// партнёрам не показывать и какие ключи больше не действуют. Договор двух служб:
// подписывает сервер лицензий (control-plane/server/services/signing.js signFeed,
// отдаёт routes/public-feed.js), проверяет публичный сервер
// (public-server/server/store/feed.js). Живёт здесь, рядом с canonical.js и
// licence.js, по той же причине, что и лицензия: обе стороны берут ОДНО
// определение и проверяются в одном репозитории.
//
// Зачем, если есть лицензия. Лицензию несёт клиника — и только она может её
// предъявить. Клиника без связи (или с подменённой программой) отметку «не
// оплачено» и выключенный API публичному серверу не принесёт, а украденный ключ
// подписи будет работать до конца срока лицензии (до 14 дней). Список несёт
// ПРОИЗВОДИТЕЛЬ: публичный сервер забирает его сам раз в минуту.
//
//   clinics_off          — клиники, которых партнёры не видят (503 «временно
//                          недоступна»): не оплачено, снята, удалена, API
//                          выключен, нет принятого ключа обмена;
//   sync_keys_revoked    — отпечатки ключей подписи клиник (32 hex), которым
//                          канал клиники отвечает 401, а клиника с таким ключом
//                          партнёрам не видна;
//   partner_keys_revoked — SHA-256 ключей партнёров (64 hex) — ответ 401
//                          key_disabled, что бы ни присылала клиника.
//
// ПОДПИСЬ — тем же ключом производителя, что и лицензии, но над другими байтами:
// FEED_CONTEXT + canonical(payload). Лицензия подписана над canonical(payload) —
// начинается с «{», список — с «easymed-public-feed/v1»: подпись одного никогда
// не сойдётся как подпись другого, даже если поля совпадут.
//
// verifyFeed НИКОГДА НЕ БРОСАЕТ: испорченный или чужой список — отказ с причиной,
// публичный сервер держит последний хороший.
import { verify } from 'node:crypto';
import { canonical } from './canonical.js';
import { vendorPublicKey } from './licence.js';

export const FEED_KIND = 'easymed-public-feed';
export const FEED_VERSION = 1;
export const FEED_CONTEXT = 'easymed-public-feed/v1\n';
/** Потолки: тело — 2 МБ, клиник и ключей каждого вида — по 20 тысяч. */
export const FEED_LIMITS = Object.freeze({ bytes: 2_000_000, clinics: 20000, keys: 20000 });

export const CLINIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SYNC_FP_RE = /^[0-9a-f]{32}$/;
export const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Байты, над которыми стоит подпись списка. */
export function feedMessage(payload) {
  return Buffer.from(FEED_CONTEXT + canonical(payload), 'utf8');
}

const sortedUnique = (list) => [...new Set(list)].sort();

/**
 * Полезная часть списка в одном виде на обеих сторонах: списки без повторов и
 * по порядку (canonical() сохраняет порядок массивов — один и тот же список в
 * другом порядке дал бы другую подпись).
 * @param {{issuedAt:string, clinicsOff?:string[], syncKeysRevoked?:string[], partnerKeysRevoked?:string[]}} o
 */
export function makeFeedPayload({ issuedAt, clinicsOff = [], syncKeysRevoked = [], partnerKeysRevoked = [] }) {
  return {
    kind: FEED_KIND,
    v: FEED_VERSION,
    issued_at: issuedAt,
    clinics_off: sortedUnique(clinicsOff),
    sync_keys_revoked: sortedUnique(syncKeysRevoked),
    partner_keys_revoked: sortedUnique(partnerKeysRevoked),
  };
}

function listOk(list, re, max) {
  return Array.isArray(list) && list.length <= max && list.every((x) => typeof x === 'string' && re.test(x));
}

/**
 * Проверить список производителя.
 * @param {string|Buffer|null} raw тело ответа сервера лицензий
 * @param {{publicKey?:import('node:crypto').KeyObject|null}} [opts] null — ключ, вшитый в программу
 * @returns {{ok:true, feed:{issued_at:string, clinics_off:string[], sync_keys_revoked:string[], partner_keys_revoked:string[]}}
 *   | {ok:false, reason:'too_large'|'malformed'|'bad_signature'}}
 */
export function verifyFeed(raw, { publicKey = null } = {}) {
  const text = String(raw ?? '');
  if (Buffer.byteLength(text, 'utf8') > FEED_LIMITS.bytes) return { ok: false, reason: 'too_large' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'malformed' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'malformed' };
  const { payload, sig } = doc;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed' };
  if (payload.kind !== FEED_KIND || payload.v !== FEED_VERSION) return { ok: false, reason: 'malformed' };
  if (typeof payload.issued_at !== 'string' || !Number.isFinite(Date.parse(payload.issued_at))) return { ok: false, reason: 'malformed' };
  if (!listOk(payload.clinics_off, CLINIC_ID_RE, FEED_LIMITS.clinics)
    || !listOk(payload.sync_keys_revoked, SYNC_FP_RE, FEED_LIMITS.keys)
    || !listOk(payload.partner_keys_revoked, KEY_HASH_RE, FEED_LIMITS.keys)) return { ok: false, reason: 'malformed' };
  if (typeof sig !== 'string' || !BASE64_RE.test(sig)) return { ok: false, reason: 'malformed' };
  let good = false;
  try {
    good = verify(null, feedMessage(payload), publicKey || vendorPublicKey(), Buffer.from(sig, 'base64'));
  } catch { return { ok: false, reason: 'malformed' }; }
  if (!good) return { ok: false, reason: 'bad_signature' };
  return {
    ok: true,
    feed: {
      issued_at: payload.issued_at,
      clinics_off: payload.clinics_off.slice(),
      sync_keys_revoked: payload.sync_keys_revoked.slice(),
      partner_keys_revoked: payload.partner_keys_revoked.slice(),
    },
  };
}
```

- [ ] **Step 4:** `node --test server/services/control/vendor-key.test.js server/services/control/vendor-feed.test.js server/services/api/sync-identity.test.js server/services/control/licence.test.js <СТОРОЖА>` → **41 тест** зелёные (и с `force-en.mjs`).
- [ ] **Step 5: коммит** «Общий договор шага 8c: отпечаток присланной открытой половины ключа обмена — одна формула для клиники, сервера лицензий и публичного сервера; подписанный список производителя со своим контекстом подписи, строгим видом и потолками; вшитый ключ — настоящий ключ сервера лицензий (устаревший комментарий о ключе разработки исправлен), страж его отпечатка» — шесть файлов задачи.

---

## Task 2: Сервер лицензий — миграция 011: переключатель, ключ обмена, выданная лицензия, срочный отзыв (PUBLIC_LICENCE_V1)

Сборщик А.

**Files:**
- Create: `control-plane/server/db/migrations/011_public_api.sql`, `control-plane/server/db/migrations/011.test.js`.

- [ ] **Step 1: падающий тест:**

**Файл `control-plane/server/db/migrations/011.test.js`** (целиком):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// PUBLIC_LICENCE_V1 — 011_public_api.sql: переключатель онлайн-записи, отпечаток
// ключа обмена, последняя выданная лицензия, срочный отзыв ключей.

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);

test('011: новая клиника — онлайн-запись выключена, ключа и выданной лицензии нет', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  const row = db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-1');
  assert.equal(row.api_enabled, 0);
  for (const c of ['api_sync_key', 'api_sync_key_accepted_at', 'api_sync_key_seen', 'api_sync_key_seen_at',
    'licence_issued_at', 'licence_valid_until', 'licence_subscription', 'licence_api_sync_key']) assert.equal(row[c], null, c);
  assert.throws(() => db.prepare('UPDATE clinics SET api_enabled = 2 WHERE clinic_id = ?').run('c-1'), /CHECK/);
});

test('011: отзыв — только два вида и только hex своей длины; одна действующая запись на ключ, снятых — сколько угодно', () => {
  const db = freshDb();
  const add = (kind, value) => db.prepare('INSERT INTO revocations (clinic_id, kind, value, created_by) VALUES (?, ?, ?, ?)').run('c-1', kind, value, 'vendor');
  add('partner_key', HASH);
  add('sync_key', FP);
  for (const [kind, value] of [['partner_key', FP], ['sync_key', HASH], ['partner_key', 'CD'.repeat(32)], ['sync_key', 'zz'.repeat(16)],
    ['clinic', FP], ['partner_key', 'em_live_' + 'x'.repeat(56)]]) {
    assert.throws(() => add(kind, value), /CHECK/, kind + ' ' + value);
  }
  assert.throws(() => add('partner_key', HASH), /UNIQUE/);
  db.prepare("UPDATE revocations SET removed_at = '2026-10-12T00:00:00Z' WHERE value = ?").run(HASH);
  add('partner_key', HASH);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revocations WHERE value = ?').get(HASH).n, 2);
});

test('011: удаление клиники не стирает историю её блокировок', () => {
  const db = freshDb();
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP);
  db.prepare("UPDATE clinics SET active = 0 WHERE clinic_id = 'c-1'").run();
  db.prepare("INSERT INTO deleted_clinics (clinic_id, name) VALUES ('c-1', 'Клиника')").run();
  db.prepare("DELETE FROM clinics WHERE clinic_id = 'c-1'").run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n, 1);
});
```

- [ ] **Step 2:** `node --test control-plane/server/db/migrations/011.test.js` → 3 из 3 красные (`AssertionError … api_enabled`: колонки ещё нет).
- [ ] **Step 3: миграция:**

**Файл `control-plane/server/db/migrations/011_public_api.sql`** (целиком):

```sql
-- 011_public_api.sql — PUBLIC_LICENCE_V1, шаг 8c API клиники: сервер лицензий
-- включает клинике онлайн-запись (публичный сервер api.easymed.uz), вписывает в
-- подписанную лицензию отпечаток её ключа обмена и отметку оплаты, ведёт срочный
-- отзыв ключей. Данных пациентов здесь нет и не будет (страж
-- server/services/api/no-patient-data-to-vendor.test.js): только флаг, отпечатки
-- ключей и сроки выданной лицензии.

-- «Онлайн-запись / API» в панели. 0 — лицензия без api_sync_key: обмен клиники
-- (8a) молчит, партнёры клинику не видят (список производителя, clinics_off).
ALTER TABLE clinics ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 0 CHECK (api_enabled IN (0, 1));
-- Принятый отпечаток ключа подписи клиники (32 hex) — он и уходит в лицензию.
ALTER TABLE clinics ADD COLUMN api_sync_key TEXT;
-- Когда ключ принят впервые. Не NULL — у клиники уже был принятый ключ, и
-- новый (другой ПК) ждёт подтверждения в панели, а не принимается сам.
ALTER TABLE clinics ADD COLUMN api_sync_key_accepted_at TEXT;
-- Последний присланный при сверке отпечаток и когда он появился. Отличается от
-- принятого — «новый ключ обмена ждёт подтверждения».
ALTER TABLE clinics ADD COLUMN api_sync_key_seen TEXT;
ALTER TABLE clinics ADD COLUMN api_sync_key_seen_at TEXT;
-- Последняя выданная лицензия: issued_at — нижняя граница следующей (у каждой
-- выдачи issued_at строго больше), valid_until — потолок лицензии «не оплачено»
-- (она не продлевает срок), subscription и api_sync_key — что сейчас сказано
-- клинике (панель показывает, дошло ли включение).
ALTER TABLE clinics ADD COLUMN licence_issued_at TEXT;
ALTER TABLE clinics ADD COLUMN licence_valid_until TEXT;
ALTER TABLE clinics ADD COLUMN licence_subscription TEXT;
ALTER TABLE clinics ADD COLUMN licence_api_sync_key TEXT;

-- Срочный отзыв: ключи партнёров (SHA-256 ключа, 64 hex — самого ключа сервер
-- лицензий не видит) и ключи обмена клиник (отпечаток, 32 hex). Публичный сервер
-- получает действующие записи в подписанном списке производителя
-- (GET /cp/v1/public-feed). Снятие — отметка removed_at, строка остаётся: кто и
-- когда снял блокировку — тоже ответ на вопрос «что случилось».
-- clinic_id без внешнего ключа, как у checkins: удаление клиники не стирает
-- историю её блокировок.
CREATE TABLE revocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('partner_key', 'sync_key')),
  value       TEXT NOT NULL CHECK (
                (kind = 'partner_key' AND length(value) = 64 AND value NOT GLOB '*[^0-9a-f]*')
             OR (kind = 'sync_key'    AND length(value) = 32 AND value NOT GLOB '*[^0-9a-f]*')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_by  TEXT,
  removed_at  TEXT,
  removed_by  TEXT
);
-- Одна действующая запись на ключ; снятых может быть сколько угодно.
CREATE UNIQUE INDEX revocations_live ON revocations (kind, value) WHERE removed_at IS NULL;
CREATE INDEX revocations_clinic ON revocations (clinic_id, created_at DESC);
```

- [ ] **Step 4:** `node --test control-plane/server/db/migrations/011.test.js control-plane/server/db/migrations/001.test.js control-plane/server/db/migrations/010.test.js <СТОРОЖА>` → **33 теста** зелёные; страж данных пациентов — среди них (новые имена его не задевают).
- [ ] **Step 5: коммит** «Сервер лицензий, миграция 011: переключатель «Онлайн-запись / API», принятый и последний присланный отпечаток ключа обмена, последняя выданная лицензия (нижняя граница issued_at и потолок срока «не оплачено»), таблица срочного отзыва ключей партнёров и ключей обмена — только отпечатки, история снятий остаётся» — два файла.

---

## Task 3: Подпись — оплата и отпечаток в лицензии, срок только короче, `issued_at` растёт, подпись списка (PUBLIC_LICENCE_V1)

Сборщик А.

**Files:**
- Modify: `control-plane/server/services/signing.js` — `signLicence({…, subscription, apiSyncKey, notAfter, issuedAfter})`, `signFeed()`, `signingKeyIsProduction()`.
- Modify: `control-plane/server/services/signing.test.js` — пять тестов `PUBLIC_LICENCE_V1`.

- [ ] **Step 1: падающие тесты** — diff:

```diff
diff --git a/control-plane/server/services/signing.test.js b/control-plane/server/services/signing.test.js
index cc70e13..32e0ad2 100644
--- a/control-plane/server/services/signing.test.js
+++ b/control-plane/server/services/signing.test.js
@@ -11,7 +11,8 @@ import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from
 import { canonical } from '../../../server/services/control/canonical.js';
 import { verifyLicence } from '../../../server/services/control/licence.js';
 
-import { signLicence, loadSigningKey, ensureSigningKey } from './signing.js';
+import { signLicence, loadSigningKey, ensureSigningKey, signFeed, signingKeyIsProduction } from './signing.js';
+import { makeFeedPayload, verifyFeed } from '../../../server/services/control/vendor-feed.js';
 
 // --- test helpers -----------------------------------------------------------
 
@@ -330,3 +331,62 @@ test('the signed payload is flat — no field can become an object or array-of-o
   // deeply nested payload — must handle it trivially.
   assert.doesNotThrow(() => canonical(payload));
 });
+
+// --- PUBLIC_LICENCE_V1: payment mark, sync key, issued_at order, the feed -----
+
+test('PUBLIC_LICENCE_V1: subscription and apiSyncKey are signed in — eight keys; the clinic verifier accepts them', () => {
+  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
+  useKey(privateKey);
+  const doc = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: ['crm'], subscription: 'unpaid', apiSyncKey: 'ab'.repeat(16) });
+  assert.deepEqual(Object.keys(doc.payload).sort(),
+    ['api_sync_key', 'clinic_id', 'clinic_name', 'issued_at', 'modules', 'nonce', 'subscription', 'valid_until']);
+  const r = verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-1' });
+  assert.equal(r.ok, true);
+  assert.equal(r.licence.subscription, 'unpaid');
+  assert.equal(r.licence.api_sync_key, 'ab'.repeat(16));
+  const noKey = signLicence({ clinicId: 'c-1', clinicName: 'X', modules: [], subscription: 'active', apiSyncKey: null });
+  assert.equal('api_sync_key' in noKey.payload, false, 'null — no field, the switch is off');
+  assert.equal(noKey.payload.subscription, 'active');
+});
+
+test('PUBLIC_LICENCE_V1: a wrong subscription word or a malformed sync key is a caller bug — refused, never signed', () => {
+  useKey(generateKeyPairSync('ed25519').privateKey);
+  for (const subscription of ['paid', '', 'ACTIVE', null]) {
+    assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], subscription }), /subscription/);
+  }
+  for (const apiSyncKey of ['AB'.repeat(16), 'ab'.repeat(15), 'ab'.repeat(32), 42, {}]) {
+    assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], apiSyncKey }), /apiSyncKey/);
+  }
+});
+
+test('PUBLIC_LICENCE_V1: notAfter only ever shortens valid_until; a malformed one is refused', () => {
+  useKey(generateKeyPairSync('ed25519').privateKey);
+  const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
+  assert.equal(signLicence({ clinicId: 'c-1', modules: [], notAfter: soon }).payload.valid_until, soon);
+  const far = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
+  const capped = Date.parse(signLicence({ clinicId: 'c-1', modules: [], notAfter: far }).payload.valid_until);
+  assert.ok(Math.abs(capped - (Date.now() + 14 * 24 * 3600 * 1000)) < 60_000, 'a later notAfter never lengthens the 14 days');
+  assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], notAfter: 'tomorrow' }), /notAfter/);
+});
+
+test('PUBLIC_LICENCE_V1: issued_at is strictly after issuedAfter even when the vendor clock is behind it', () => {
+  useKey(generateKeyPairSync('ed25519').privateKey);
+  const ahead = new Date(Date.now() + 3_600_000).toISOString();
+  const doc = signLicence({ clinicId: 'c-1', modules: [], issuedAfter: ahead });
+  assert.equal(Date.parse(doc.payload.issued_at), Date.parse(ahead) + 1);
+  const past = new Date(Date.now() - 3_600_000).toISOString();
+  assert.ok(Math.abs(Date.parse(signLicence({ clinicId: 'c-1', modules: [], issuedAfter: past }).payload.issued_at) - Date.now()) < 60_000);
+  assert.throws(() => signLicence({ clinicId: 'c-1', modules: [], issuedAfter: 'yesterday' }), /issuedAfter/);
+});
+
+test('PUBLIC_LICENCE_V1: signFeed verifies with the shared feed verifier; a throwaway key is not the production key', () => {
+  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
+  useKey(privateKey);
+  const payload = makeFeedPayload({ issuedAt: new Date().toISOString(), clinicsOff: ['c-1'], partnerKeysRevoked: ['cd'.repeat(32)] });
+  const doc = signFeed(payload);
+  const r = verifyFeed(JSON.stringify(doc), { publicKey });
+  assert.equal(r.ok, true);
+  assert.deepEqual(r.feed.clinics_off, ['c-1']);
+  assert.equal(verifyLicence(JSON.stringify(doc), { publicKey, clinicId: 'c-1' }).ok, false, 'a feed is never a licence');
+  assert.equal(signingKeyIsProduction(), false);
+});
```

- [ ] **Step 2:** `node --test control-plane/server/services/signing.test.js` → красный при загрузке: `SyntaxError: The requested module './signing.js' does not provide an export named 'signFeed'`.
- [ ] **Step 3: подпись** — diff (новые поля добавляются только по просьбе — без них прежние шесть ключей, как у CLI; `notAfter` только укорачивает):

```diff
diff --git a/control-plane/server/services/signing.js b/control-plane/server/services/signing.js
index e795786..3e7d415 100644
--- a/control-plane/server/services/signing.js
+++ b/control-plane/server/services/signing.js
@@ -12,8 +12,12 @@
 // see its own header comment.
 
 import fs from 'node:fs';
-import { createPrivateKey, sign, randomBytes } from 'node:crypto';
+import { createPrivateKey, createPublicKey, sign, randomBytes } from 'node:crypto';
 import { canonical } from '../../../server/services/control/canonical.js';
+// PUBLIC_LICENCE_V1 — список производителя для публичного сервера: те же байты
+// подписи, что проверяет public-server/server/store/feed.js, — одно определение.
+import { feedMessage } from '../../../server/services/control/vendor-feed.js';
+import { vendorPublicKey } from '../../../server/services/control/licence.js';
 
 const DAY_MS = 24 * 60 * 60 * 1000;
 
@@ -111,6 +115,21 @@ export function ensureSigningKey() {
   getSigningKey(); // throws with a clear message if unset, unreadable, or unparseable
 }
 
+/**
+ * PUBLIC_LICENCE_V1 — is the configured private key the half of the public key
+ * compiled into every clinic (server/services/control/licence.js)? If not, every
+ * licence and every public-server feed this process signs is rejected — by
+ * every real clinic and by api.easymed.uz — silently, two weeks later. The
+ * entry point logs a loud warning when this is false (a local dev control plane
+ * with a throwaway key is legitimate, so it is a warning, not a refusal).
+ * Compares public halves only; key material never leaves this function.
+ * @returns {boolean}
+ */
+export function signingKeyIsProduction() {
+  const der = (k) => k.export({ format: 'der', type: 'spki' });
+  return der(createPublicKey(getSigningKey())).equals(der(vendorPublicKey()));
+}
+
 // clinic_id is the identity a signed licence is FOR. Get it wrong and the
 // licence is either useless (verifies for nobody) or ambiguous. Never
 // coerced — a number or object here is a caller bug to reject, not a value to
@@ -168,7 +187,7 @@ function normaliseModules(modules) {
   return Array.from(set).sort();
 }
 
-function computeValidUntil(days) {
+function computeValidUntil(days, notAfter) {
   const n = Number(days);
   // NaN is a bug (a typo'd config, an unparsed form field), not a testing
   // tool — it must never reach new Date(), which would turn it into an
@@ -185,9 +204,36 @@ function computeValidUntil(days) {
   if (Number.isNaN(until.getTime())) {
     throw new Error(`signLicence: days ${n} works out to a date outside what a computer can represent.`);
   }
+  // PUBLIC_LICENCE_V1 — notAfter can only SHORTEN a licence, never lengthen it:
+  // the "unpaid" licence carries the payment mark to the public server without
+  // re-arming the clinic's 14 days (services/public-api.js licenceTerms). It is
+  // still not an API for choosing an expiry: the result is min(days, notAfter).
+  if (notAfter !== undefined && notAfter !== null) {
+    const cap = typeof notAfter === 'string' ? Date.parse(notAfter) : NaN;
+    if (!Number.isFinite(cap)) throw new Error(`signLicence: notAfter must be an ISO date string, got ${JSON.stringify(notAfter)}.`);
+    if (cap < until.getTime()) return new Date(cap).toISOString();
+  }
   return until.toISOString();
 }
 
+// PUBLIC_LICENCE_V1 — issued_at strictly increases per clinic: the public
+// server keeps the NEWEST licence it has seen (by issued_at) and refuses older
+// ones with another key (licence_outdated). Two issues in the same millisecond,
+// or a vendor clock stepped backwards, must still produce a strictly later
+// issued_at than the last one this clinic was given.
+function computeIssuedAt(issuedAfter) {
+  let t = Date.now();
+  if (issuedAfter !== undefined && issuedAfter !== null) {
+    const last = typeof issuedAfter === 'string' ? Date.parse(issuedAfter) : NaN;
+    if (!Number.isFinite(last)) throw new Error(`signLicence: issuedAfter must be an ISO date string, got ${JSON.stringify(issuedAfter)}.`);
+    if (last >= t) t = last + 1;
+  }
+  return new Date(t).toISOString();
+}
+
+const SUBSCRIPTIONS = new Set(['active', 'unpaid']);
+const SYNC_KEY_FP_RE = /^[0-9a-f]{32}$/;
+
 /**
  * Sign a licence document for one clinic. Byte-compatible with
  * scripts/make-licence.mjs's `issue` command: both build the same six-key
@@ -200,9 +246,21 @@ function computeValidUntil(days) {
  * @param {string}  [args.clinicName]
  * @param {string[]} [args.modules]
  * @param {number}  [args.days=14]
+ * @param {'active'|'unpaid'} [args.subscription] PUBLIC_LICENCE_V1 — the payment mark, signed (owner decision 17:
+ *   the public server hides an unpaid clinic from partners). Omitted — the classic six-key payload, as the CLI signs.
+ * @param {string|null} [args.apiSyncKey] PUBLIC_LICENCE_V1 — the clinic's accepted sync-key fingerprint (32 hex);
+ *   present only when online booking is switched on for the clinic. Omitted/null — no field.
+ * @param {string}  [args.notAfter]    PUBLIC_LICENCE_V1 — valid_until is min(now + days, notAfter); can only shorten.
+ * @param {string}  [args.issuedAfter] PUBLIC_LICENCE_V1 — the last issued_at given to this clinic; the new one is later.
  * @returns {{payload: object, sig: string}}
  */
-export function signLicence({ clinicId, clinicName, modules, days = 14 }) {
+export function signLicence({ clinicId, clinicName, modules, days = 14, subscription, apiSyncKey, notAfter, issuedAfter }) {
+  if (subscription !== undefined && !SUBSCRIPTIONS.has(subscription)) {
+    throw new Error(`signLicence: subscription must be "active" or "unpaid", got ${JSON.stringify(subscription)}.`);
+  }
+  if (apiSyncKey !== undefined && apiSyncKey !== null && (typeof apiSyncKey !== 'string' || !SYNC_KEY_FP_RE.test(apiSyncKey))) {
+    throw new Error('signLicence: apiSyncKey must be 32 lowercase hex characters.');
+  }
   const payload = {
     clinic_id:   normaliseClinicId(clinicId),
     clinic_name: normaliseClinicName(clinicName),
@@ -211,11 +269,17 @@ export function signLicence({ clinicId, clinicName, modules, days = 14 }) {
     // passed in — any other field on the caller's object (including a
     // `valid_until` of its own) is simply ignored by the destructuring above.
     // Accepting a caller-supplied expiry would turn this function into an API
-    // for forging licences of any length.
-    valid_until: computeValidUntil(days),
-    issued_at:   new Date().toISOString(),
+    // for forging licences of any length. (notAfter can only shorten it.)
+    valid_until: computeValidUntil(days, notAfter),
+    issued_at:   computeIssuedAt(issuedAfter),
     nonce:       randomBytes(8).toString('hex'), // matches the CLI's nonce shape; makes every issuance unique
   };
+  // PUBLIC_LICENCE_V1 — two optional fields. A clinic's verifier signs-checks
+  // the whole payload and ignores fields it does not know (licence.js returns
+  // the payload; state.js reads only modules and valid_until), so an old clinic
+  // takes such a licence exactly like a six-key one.
+  if (subscription !== undefined) payload.subscription = subscription;
+  if (apiSyncKey !== undefined && apiSyncKey !== null) payload.api_sync_key = apiSyncKey;
 
   const key = getSigningKey();
   let sig;
@@ -229,3 +293,22 @@ export function signLicence({ clinicId, clinicName, modules, days = 14 }) {
   }
   return { payload, sig };
 }
+
+/**
+ * PUBLIC_LICENCE_V1 — sign the public-server feed (clinics hidden from partners,
+ * revoked keys). Same vendor key as licences, different bytes:
+ * feedMessage() prefixes the FEED_CONTEXT, so a feed signature can never be
+ * passed off as a licence signature or the other way round
+ * (server/services/control/vendor-feed.js). The payload comes from
+ * makeFeedPayload() — this function signs, it does not decide.
+ * @param {object} payload
+ * @returns {{payload: object, sig: string}}
+ */
+export function signFeed(payload) {
+  const key = getSigningKey();
+  try {
+    return { payload, sig: sign(null, feedMessage(payload), key).toString('base64') };
+  } catch {
+    throw new Error('signFeed: failed to sign the feed with the configured key.');
+  }
+}
```

- [ ] **Step 4:** `node --test control-plane/server/services/signing.test.js <СТОРОЖА>` → **45 тестов** зелёные (прежний «ровно шесть ключей» — среди них).
- [ ] **Step 5: коммит** «Подпись лицензии: подписанная отметка оплаты и отпечаток ключа обмена — по просьбе (без них прежние шесть ключей), срок только короче (notAfter — для лицензии «не оплачено»), issued_at строго позже прошлой выдачи даже при отставших часах; подпись списка производителя своим контекстом; проверка, что ключ подписи — настоящий» — два файла.

---

## Task 4: Сверка — отпечаток из открытой половины, новый ключ ждёт подтверждения, лицензия «не оплачено» с прежним сроком (PUBLIC_LICENCE_V1)

Сборщик А.

**Files:**
- Create: `control-plane/server/services/public-api.js` — решения: принять ли ключ, какую лицензию выдать, что видят партнёры, запомнить выданное.
- Create: `control-plane/server/services/public-api.test.js`, `control-plane/server/services/checkin-public-api.test.js`.
- Modify: `control-plane/server/services/checkin.js` — `apiSyncPublicKey`, экспорт `isEntitled`, лицензия по `licenceTerms`.
- Modify: `control-plane/server/routes/checkin.js` — поле `api_sync_public_key`.
- Modify: `control-plane/server/routes/checkin.route.test.js` — приёмочный тест: неоплаченная клиника получает лицензию `unpaid` **с тем же сроком** и запирается в тот же день.

- [ ] **Step 1: падающие тесты** — новые файлы:

**Файл `control-plane/server/services/public-api.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — решения сервера лицензий для публичного сервера: какую
// лицензию выдать, какой ключ обмена принять, что видят партнёры.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode } from './enrollment.js';
import {
  licenceTerms, noteSyncKey, acceptPendingSyncKey, syncKeyPending, partnersSee, recordIssued, isRevoked, isoSeconds,
  NEW_SYNC_KEY_NEEDS_CONFIRMATION,
} from './public-api.js';

const FP1 = '11'.repeat(16);
const FP2 = '22'.repeat(16);
const NOW = Date.parse('2026-10-12T10:00:00Z');
const LIVE = '2026-10-20T10:00:00.000Z';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  return db;
}
const row = (db) => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-1');

test('licenceTerms: оплачено — active, ключ только при включённом API; не оплачено — тот же срок или ничего', () => {
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: false, apiSyncKey: FP1, now: NOW }), { subscription: 'active', apiSyncKey: null });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: true, apiSyncKey: FP1, lastIssuedAt: '2026-10-12T09:00:00.000Z', now: NOW }),
    { subscription: 'active', apiSyncKey: FP1, issuedAfter: '2026-10-12T09:00:00.000Z' });
  assert.deepEqual(licenceTerms({ entitled: true, apiEnabled: true, apiSyncKey: 'не отпечаток', now: NOW }), { subscription: 'active', apiSyncKey: null });
  assert.deepEqual(licenceTerms({ entitled: false, apiEnabled: true, apiSyncKey: FP1, lastValidUntil: LIVE, now: NOW }),
    { subscription: 'unpaid', apiSyncKey: FP1, notAfter: LIVE });
  assert.equal(licenceTerms({ entitled: false, apiEnabled: true, apiSyncKey: FP1, lastValidUntil: '2026-10-12T09:59:59Z', now: NOW }), null, 'срок вышел');
  assert.equal(licenceTerms({ entitled: false, apiEnabled: true, apiSyncKey: FP1, lastValidUntil: null, now: NOW }), null, 'не выдавали после 8c');
  assert.equal(licenceTerms({ entitled: false, apiEnabled: false, apiSyncKey: null, lastValidUntil: 'мусор', now: NOW }), null);
});

test('noteSyncKey: первый ключ принимается сам; тот же — без записи; другой — ждёт подтверждения', () => {
  assert.equal(NEW_SYNC_KEY_NEEDS_CONFIRMATION, true, 'вопрос владельцу 1 — построено с подтверждением');
  const db = freshDb();
  assert.deepEqual(noteSyncKey(db, row(db), '', NOW), { apiSyncKey: null, changed: false });
  assert.equal(row(db).api_sync_key_seen, null, 'нет ключа — ничего не пишется');
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW), { apiSyncKey: FP1, changed: true });
  let r = row(db);
  assert.deepEqual([r.api_sync_key, r.api_sync_key_seen, r.api_sync_key_accepted_at, r.api_sync_key_seen_at],
    [FP1, FP1, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z']);
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW + 3600000), { apiSyncKey: FP1, changed: false });
  assert.equal(row(db).api_sync_key_seen_at, '2026-10-12T10:00:00Z', 'тот же ключ — «появился» не сдвигается');
  assert.deepEqual(noteSyncKey(db, row(db), FP2, NOW + 7200000), { apiSyncKey: FP1, changed: true });
  r = row(db);
  assert.deepEqual([r.api_sync_key, r.api_sync_key_seen, r.api_sync_key_seen_at], [FP1, FP2, '2026-10-12T12:00:00Z']);
  assert.equal(syncKeyPending(db, r), true);
});

test('noteSyncKey: отозванный ключ не принимается никогда — даже первым', () => {
  const db = freshDb();
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP1);
  assert.deepEqual(noteSyncKey(db, row(db), FP1, NOW), { apiSyncKey: null, changed: true });
  assert.deepEqual([row(db).api_sync_key, row(db).api_sync_key_seen], [null, FP1]);
  assert.equal(syncKeyPending(db, row(db)), false, 'отозванный не «ждёт подтверждения»');
  assert.equal(isRevoked(db, 'sync_key', FP1), true);
  assert.equal(isRevoked(db, 'sync_key', FP2), false);
  assert.equal(isRevoked(db, 'sync_key', ''), false);
});

test('acceptPendingSyncKey: только тот, что видел человек, и не отозванный', () => {
  const db = freshDb();
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP1, NOW), { error: 'not_pending' });
  noteSyncKey(db, row(db), FP1, NOW);
  noteSyncKey(db, row(db), FP2, NOW);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP1, NOW), { error: 'changed' }, 'клиника с тех пор прислала другой');
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-1', 'sync_key', ?)").run(FP2);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP2, NOW), { error: 'revoked' });
  db.prepare('UPDATE revocations SET removed_at = ?').run(isoSeconds(NOW));
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP2, NOW + 1000), { ok: true });
  assert.deepEqual([row(db).api_sync_key, row(db).api_sync_key_accepted_at], [FP2, '2026-10-12T10:00:01Z']);
  assert.deepEqual(acceptPendingSyncKey(db, 'c-1', FP2, NOW), { error: 'not_pending' });
  assert.deepEqual(acceptPendingSyncKey(db, 'c-нет', FP2, NOW), { error: 'not_pending' });
});

test('partnersSee: снята, не оплачено, выключено, нет ключа — скрыта; иначе видна', () => {
  const c = { active: 1, api_enabled: 1, api_sync_key: FP1 };
  assert.equal(partnersSee(c, { entitled: true }), 'visible');
  assert.equal(partnersSee({ ...c, active: 0 }, { entitled: true }), 'retired');
  assert.equal(partnersSee(c, { entitled: false }), 'unpaid');
  assert.equal(partnersSee({ ...c, api_enabled: 0 }, { entitled: true }), 'off');
  assert.equal(partnersSee({ ...c, api_sync_key: null }, { entitled: true }), 'no_key');
});

test('recordIssued: запоминает выданное; испорченное или сбой базы — не бросает', () => {
  const db = freshDb();
  recordIssued(db, 'c-1', { issued_at: '2026-10-12T10:00:00.000Z', valid_until: LIVE, subscription: 'unpaid', api_sync_key: FP1 });
  const r = row(db);
  assert.deepEqual([r.licence_issued_at, r.licence_valid_until, r.licence_subscription, r.licence_api_sync_key],
    ['2026-10-12T10:00:00.000Z', LIVE, 'unpaid', FP1]);
  recordIssued(db, 'c-1', { issued_at: 5, valid_until: {} });
  assert.equal(row(db).licence_issued_at, null);
  assert.doesNotThrow(() => recordIssued({ prepare() { throw new Error('база закрыта'); } }, 'c-1', {}));
});
```

**Файл `control-plane/server/services/checkin-public-api.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — сверка с настоящей подписью (ключ — одноразовый, свой на
// прогон) и настоящим проверяющим клиники: отпечаток ключа обмена, переключатель
// онлайн-записи, отметка оплаты, порядок issued_at, старая клиника без ключа.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode, redeemEnrollmentCode } from './enrollment.js';
import { checkIn } from './checkin.js';
import { signLicence } from './signing.js';
import { verifyLicence } from '../../../server/services/control/licence.js';

const vendor = crypto.generateKeyPairSync('ed25519');
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-8c-key-'));
const keyFile = path.join(keyDir, 'vendor-private.pem');
fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
test.before(() => { process.env.EASYMED_SIGNING_KEY = keyFile; });
test.after(() => { delete process.env.EASYMED_SIGNING_KEY; fs.rmSync(keyDir, { recursive: true, force: true }); });

/** Открытая половина ключа подписи клиники — так её шлёт сверка 8a (base64 DER SPKI) — и её отпечаток. */
function syncKey() {
  const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return { b64: pub.toString('base64'), fp: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32) };
}

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const code = createEnrollmentCode(db, { clinicId: 'c-000047', name: 'Шифо' });
  const token = redeemEnrollmentCode(db, { code }).install_token;
  const call = (body = {}) => checkIn(db, { installToken: token, ...body }, { signLicence });
  const row = () => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get('c-000047');
  const verified = (licence) => verifyLicence(JSON.stringify(licence), { publicKey: vendor.publicKey, clinicId: 'c-000047' });
  return { db, call, row, verified };
}

test('старая клиника (ключа не шлёт): лицензия как прежде плюс подписанное «active», без api_sync_key — проверяющий клиники принимает', () => {
  const s = setup();
  const r = s.call({ version: '3.16.0' });
  assert.equal(r.subscription, 'active');
  const v = s.verified(r.licence);
  assert.equal(v.ok, true);
  assert.equal(v.licence.subscription, 'active');
  assert.equal('api_sync_key' in v.licence, false);
  assert.deepEqual([s.row().licence_subscription, s.row().licence_api_sync_key], ['active', null]);
  assert.equal(s.row().licence_valid_until, r.licence.payload.valid_until);
});

test('переключатель: ключ принят сразу, но в лицензию идёт только при включённой онлайн-записи', () => {
  const s = setup();
  const k = syncKey();
  const off = s.call({ apiSyncPublicKey: k.b64 });
  assert.equal('api_sync_key' in off.licence.payload, false, 'выключено — поля нет, обмен клиники молчит');
  assert.deepEqual([s.row().api_sync_key, s.row().api_sync_key_seen], [k.fp, k.fp]);
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const on = s.call({ apiSyncPublicKey: k.b64 });
  assert.equal(s.verified(on.licence).licence.api_sync_key, k.fp);
  assert.equal(s.row().licence_api_sync_key, k.fp);
  s.db.prepare("UPDATE clinics SET api_enabled = 0 WHERE clinic_id = 'c-000047'").run();
  assert.equal('api_sync_key' in s.call({ apiSyncPublicKey: k.b64 }).licence.payload, false, 'выключили — со следующей сверки поля нет');
});

test('новый ПК — новый ключ ждёт подтверждения: лицензия несёт прежний, пока его не примут в панели', () => {
  const s = setup();
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const a = syncKey();
  const b = syncKey();
  s.call({ apiSyncPublicKey: a.b64 });
  const r = s.call({ apiSyncPublicKey: b.b64 });
  assert.equal(r.licence.payload.api_sync_key, a.fp);
  assert.deepEqual([s.row().api_sync_key, s.row().api_sync_key_seen], [a.fp, b.fp]);
  s.db.prepare("UPDATE clinics SET api_sync_key = ? WHERE clinic_id = 'c-000047'").run(b.fp);   // «Принять новый ключ»
  assert.equal(s.call({ apiSyncPublicKey: b.b64 }).licence.payload.api_sync_key, b.fp);
});

test('отозванный ключ обмена не попадает в лицензию, даже если остался принятым', () => {
  const s = setup();
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const a = syncKey();
  s.call({ apiSyncPublicKey: a.b64 });
  s.db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-000047', 'sync_key', ?)").run(a.fp);
  assert.equal('api_sync_key' in s.call({ apiSyncPublicKey: a.b64 }).licence.payload, false);
});

test('не оплачено после оплаченной сверки: подписанное «unpaid», тот же срок, ключ обмена на месте; срок вышел — лицензии нет', () => {
  const s = setup();
  s.db.prepare("UPDATE clinics SET api_enabled = 1 WHERE clinic_id = 'c-000047'").run();
  const k = syncKey();
  const paid = s.call({ apiSyncPublicKey: k.b64 });
  s.db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = 'c-000047'").run();
  const unpaid = s.call({ apiSyncPublicKey: k.b64 });
  assert.equal(unpaid.subscription, 'unpaid');
  const v = s.verified(unpaid.licence);
  assert.deepEqual([v.ok, v.licence.subscription, v.licence.api_sync_key, v.licence.valid_until],
    [true, 'unpaid', k.fp, paid.licence.payload.valid_until]);
  assert.ok(Date.parse(v.licence.issued_at) > Date.parse(paid.licence.payload.issued_at));
  assert.equal(s.call({ apiSyncPublicKey: k.b64 }).licence.payload.valid_until, paid.licence.payload.valid_until, 'и при следующей — не дальше');
  s.db.prepare("UPDATE clinics SET licence_valid_until = '2020-01-01T00:00:00.000Z' WHERE clinic_id = 'c-000047'").run();
  assert.equal(s.call({ apiSyncPublicKey: k.b64 }).licence, null, 'последняя выданная уже истекла — как прежде, ничего');
  s.db.prepare("UPDATE clinics SET subscription = 'active' WHERE clinic_id = 'c-000047'").run();
  const back = s.call({ apiSyncPublicKey: k.b64 });
  assert.equal(back.licence.payload.subscription, 'active');
  assert.ok(Date.parse(back.licence.payload.valid_until) > Date.now() + 13 * 86400000, 'оплатили — снова 14 дней');
});

test('issued_at строго растёт от сверки к сверке — и когда часы производителя отстали', () => {
  const s = setup();
  const seen = [];
  for (let i = 0; i < 5; i += 1) seen.push(Date.parse(s.call().licence.payload.issued_at));
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1], 'выдача ' + i);
  const ahead = new Date(Date.now() + 3600000).toISOString();
  s.db.prepare("UPDATE clinics SET licence_issued_at = ? WHERE clinic_id = 'c-000047'").run(ahead);
  assert.equal(Date.parse(s.call().licence.payload.issued_at), Date.parse(ahead) + 1);
});

test('мусор вместо ключа не роняет сверку; в базе — только отпечаток, открытой половины целиком нет', () => {
  const s = setup();
  for (const junk of ['не ключ', 42, { a: 1 }, 'A'.repeat(5000), syncKey().b64.replace(/A/g, 'B')]) {
    const r = s.call({ apiSyncPublicKey: junk });
    assert.ok(r && r.licence, String(junk).slice(0, 12));
  }
  const k = syncKey();
  s.call({ apiSyncPublicKey: k.b64 });
  const dump = JSON.stringify(s.db.prepare('SELECT * FROM clinics').all()) + JSON.stringify(s.db.prepare('SELECT * FROM checkins').all());
  assert.ok(!dump.includes(k.b64), 'открытая половина целиком не хранится');
  assert.ok(dump.includes(k.fp));
});
```

и diff к приёмочному тесту маршрута (поведение меняется сознательно: «нет лицензии» → «лицензия `unpaid` с прежним сроком»; суть выключателя мёртвого человека — тот же день блокировки — теперь проверяется прямо):

```diff
diff --git a/control-plane/server/routes/checkin.route.test.js b/control-plane/server/routes/checkin.route.test.js
index bcb046a..774df33 100644
--- a/control-plane/server/routes/checkin.route.test.js
+++ b/control-plane/server/routes/checkin.route.test.js
@@ -124,22 +124,35 @@ test('acceptance: a paid clinic is re-armed, an unpaid one is not, and a lapsed
   assert.equal(state1.locked, false, 'result 2e: the clinic-side verifier must report unlocked');
   assert.deepEqual(state1.modules, ['crm'], 'result 2f: modules must be exactly [\'crm\']');
 
-  // --- 3. subscription = 'unpaid' -> no fresh licence, subscription:'unpaid'
+  // --- 3. subscription = 'unpaid' -> NOT re-armed, subscription:'unpaid'.
+  //        PUBLIC_LICENCE_V1 (step 8c, owner decision 17): the answer now
+  //        carries an "unpaid" licence — the payment mark, signed, for the
+  //        public server — with the SAME valid_until as the last paid one. The
+  //        dead-man's switch is untouched: the clinic still locks on that day.
   db.prepare("UPDATE clinics SET subscription = 'unpaid' WHERE clinic_id = ?").run('c-000047');
   const res2 = await checkin(server, { install_token: installToken });
   assert.equal(res2.status, 200, 'result 3a: an unpaid clinic still gets a 200 (it is not an auth failure)');
   const body2 = await res2.json();
-  assert.equal(body2.licence, null, 'result 3b: no fresh licence for an unpaid clinic');
+  assert.equal(body2.licence.payload.subscription, 'unpaid', 'result 3b: the payment mark is in the signed licence');
+  assert.equal(body2.licence.payload.valid_until, body1.licence.payload.valid_until, 'result 3b: NOT re-armed — the same valid_until');
+  assert.ok(body2.licence.payload.issued_at > body1.licence.payload.issued_at, 'result 3b: a newer issue');
   assert.equal(body2.subscription, 'unpaid', 'result 3c: the response must say unpaid');
+  fs.writeFileSync(path.join(dir, 'licence.dat'), JSON.stringify(body2.licence));
+  assert.deepEqual([controlState(clinicDb, dir).locked, controlState(clinicDb, dir).modules], [false, ['crm']],
+    'result 3d: the clinic takes the unpaid licence like any other — its own ladder decides');
+  assert.equal(controlState(clinicDb, dir, new Date(Date.parse(body1.licence.payload.valid_until) + 1000)).locked, true,
+    'result 3e: and it still locks the day the last PAID licence runs out');
 
   // --- 4. subscription_until = yesterday, subscription = 'active' -> still -
-  //        no fresh licence. Paid-until in the past is not paid.
+  //        not re-armed. Paid-until in the past is not paid.
   db.prepare("UPDATE clinics SET subscription = 'active', subscription_until = ? WHERE clinic_id = ?")
     .run(isoDaysFromToday(-1), 'c-000047');
   const res3 = await checkin(server, { install_token: installToken });
   assert.equal(res3.status, 200, 'result 4a: still a 200, not an auth failure');
   const body3 = await res3.json();
-  assert.equal(body3.licence, null, 'result 4b: a lapsed subscription_until must not re-arm, even though the column says active');
+  assert.equal(body3.licence.payload.valid_until, body1.licence.payload.valid_until,
+    'result 4b: a lapsed subscription_until must not re-arm, even though the column says active');
+  assert.equal(body3.licence.payload.subscription, 'unpaid', 'result 4b: the signed mark says unpaid');
   assert.equal(body3.subscription, 'unpaid', 'result 4c: the response must show money wording, not the raw active column');
 });
 
```

- [ ] **Step 2:** `node --test control-plane/server/services/public-api.test.js control-plane/server/services/checkin-public-api.test.js control-plane/server/routes/checkin.route.test.js` →
  - `public-api.test.js` — красный при загрузке (`ERR_MODULE_NOT_FOUND … public-api.js`);
  - `checkin-public-api.test.js` — 6 из 7 красные (`AssertionError`: нет `subscription` в лицензии, ключ не записан; зелёный — «отозванный ключ не попадает в лицензию»: до этой задачи отпечатка в лицензии нет вовсе);
  - `checkin.route.test.js` — 1 из 11 красный: `TypeError: Cannot read properties of null (reading 'payload')` (лицензии «не оплачено» ещё нет).
- [ ] **Step 3: решения** — новый модуль:

**Файл `control-plane/server/services/public-api.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — СЕРВЕР ЛИЦЕНЗИЙ И ПУБЛИЧНЫЙ СЕРВЕР (шаг 8c API клиники).
//
// Публичный сервер api.easymed.uz узнаёт клинику по её ПОДПИСАННОЙ лицензии
// (public-server/server/clinic-auth.js) и сервера лицензий во время работы не
// спрашивает. Поэтому всё, что Easy-Med решает о клинике в панели, доходит до
// него двумя путями:
//   • в лицензии, которую несёт клиника (ежечасная сверка):
//       subscription  — 'active' | 'unpaid' (решение владельца 17);
//       api_sync_key  — отпечаток принятого ключа обмена, только когда в панели
//                       включено «Онлайн-запись / API». Нет поля — обмен клиники
//                       молчит (8a public-sync.js vendorBlocker), публичный
//                       сервер её не пускает (invalid_signature);
//   • в списке производителя, который публичный сервер забирает сам
//     (routes/public-feed.js) — на случай клиники без связи или с подменённой
//     программой.
//
// ЛИЦЕНЗИЯ «НЕ ОПЛАЧЕНО» НЕ ПРОДЛЕВАЕТ СРОК. Неоплаченная клиника, как и прежде,
// доживает выданное (лестница блокировки клиники не меняется — память
// easymed-licence-lockout); новая лицензия лишь переносит отметку на публичный
// сервер, с тем же valid_until, что у последней выданной. Нет записи о выданной
// (клиника не сверялась после 8c) или срок уже вышел — лицензии нет, как прежде.
//
// НОВЫЙ КЛЮЧ ОБМЕНА (другой ПК). Первый присланный ключ принимается сам: до него
// у клиники онлайн-записи не было. Каждый следующий другой — «ждёт подтверждения»
// в панели (NEW_SYNC_KEY_NEEDS_CONFIRMATION, вопрос владельцу 1 плана 8c): копия
// install_token не должна молча забирать онлайн-записи клиники вместе с данными
// пациентов. Отозванный ключ не принимается никогда.
import { SYNC_FP_RE, KEY_HASH_RE } from '../../../server/services/control/vendor-feed.js';

export { SYNC_FP_RE, KEY_HASH_RE };

/** Вопрос владельцу 1 (план 8c): false — новый ключ принимается сам, как первый. */
export const NEW_SYNC_KEY_NEEDS_CONFIRMATION = true;

/** Время в виде, каким его пишет схема (strftime …%SZ, без миллисекунд). */
export function isoSeconds(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Действует ли запись отзыва этого вида на это значение. */
export function isRevoked(db, kind, value) {
  if (!value) return false;
  return !!db.prepare('SELECT 1 FROM revocations WHERE kind = ? AND value = ? AND removed_at IS NULL').get(kind, value);
}

/**
 * Сверка принесла отпечаток ключа обмена клиники. Записать, когда он появился;
 * принять, если это первый ключ клиники (или подтверждение выключено).
 * Внутри транзакции сверки: только простые UPDATE, неверный отпечаток — ничего.
 * @param {{clinic_id:string, api_sync_key:?string, api_sync_key_accepted_at:?string, api_sync_key_seen:?string, api_sync_key_seen_at:?string}} clinic
 * @param {string} fp '' — клиника ключа не прислала (старая версия, API не настроен)
 * @returns {{apiSyncKey: string|null, changed: boolean}} принятый ключ после записи; changed — пришёл не тот, что в прошлый раз
 */
export function noteSyncKey(db, clinic, fp, now = new Date()) {
  const accepted = clinic.api_sync_key || null;
  if (!SYNC_FP_RE.test(String(fp || ''))) return { apiSyncKey: accepted, changed: false };
  const at = isoSeconds(now);
  const changed = clinic.api_sync_key_seen !== fp;
  const seenAt = changed ? at : (clinic.api_sync_key_seen_at || at);
  const revoked = isRevoked(db, 'sync_key', fp);
  const accept = !revoked && fp !== accepted && (!clinic.api_sync_key_accepted_at || !NEW_SYNC_KEY_NEEDS_CONFIRMATION);
  if (accept) {
    db.prepare('UPDATE clinics SET api_sync_key = ?, api_sync_key_accepted_at = ?, api_sync_key_seen = ?, api_sync_key_seen_at = ? WHERE clinic_id = ?')
      .run(fp, at, fp, seenAt, clinic.clinic_id);
    return { apiSyncKey: fp, changed };
  }
  if (changed || !clinic.api_sync_key_seen_at) {
    db.prepare('UPDATE clinics SET api_sync_key_seen = ?, api_sync_key_seen_at = ? WHERE clinic_id = ?').run(fp, seenAt, clinic.clinic_id);
  }
  return { apiSyncKey: accepted, changed };
}

/** Новый ключ ждёт подтверждения: пришёл, не принят, не отозван. */
export function syncKeyPending(db, clinic) {
  const seen = clinic.api_sync_key_seen || null;
  return !!seen && seen !== (clinic.api_sync_key || null) && !isRevoked(db, 'sync_key', seen);
}

/**
 * «Принять новый ключ» в панели. fingerprint — тот, что видел человек: если с
 * тех пор клиника прислала другой, ничего не принимается.
 * @returns {{ok:true} | {error:'not_pending'|'changed'|'revoked'}}
 */
export function acceptPendingSyncKey(db, clinicId, fingerprint, now = new Date()) {
  const c = db.prepare('SELECT clinic_id, api_sync_key, api_sync_key_seen FROM clinics WHERE clinic_id = ?').get(clinicId);
  if (!c || !c.api_sync_key_seen || c.api_sync_key_seen === c.api_sync_key) return { error: 'not_pending' };
  if (c.api_sync_key_seen !== fingerprint) return { error: 'changed' };
  if (isRevoked(db, 'sync_key', fingerprint)) return { error: 'revoked' };
  db.prepare('UPDATE clinics SET api_sync_key = ?, api_sync_key_accepted_at = ? WHERE clinic_id = ?').run(fingerprint, isoSeconds(now), clinicId);
  return { ok: true };
}

/**
 * Какую лицензию выдать при сверке. null — никакой (как прежде для неоплаченной).
 * @param {{entitled:boolean, apiEnabled:boolean, apiSyncKey:?string, lastIssuedAt:?string, lastValidUntil:?string, now?:number}} o
 * @returns {null | {subscription:'active'|'unpaid', apiSyncKey:string|null, notAfter?:string, issuedAfter?:string}}
 */
export function licenceTerms({ entitled, apiEnabled, apiSyncKey, lastIssuedAt = null, lastValidUntil = null, now = Date.now() }) {
  const key = apiEnabled && SYNC_FP_RE.test(String(apiSyncKey || '')) ? apiSyncKey : null;
  const issuedAfter = typeof lastIssuedAt === 'string' && Number.isFinite(Date.parse(lastIssuedAt)) ? lastIssuedAt : undefined;
  if (entitled) return { subscription: 'active', apiSyncKey: key, ...(issuedAfter ? { issuedAfter } : {}) };
  const cap = typeof lastValidUntil === 'string' ? Date.parse(lastValidUntil) : NaN;
  if (!Number.isFinite(cap) || cap <= now) return null;
  return { subscription: 'unpaid', apiSyncKey: key, notAfter: lastValidUntil, ...(issuedAfter ? { issuedAfter } : {}) };
}

/**
 * Запомнить выданную лицензию: нижняя граница следующего issued_at, потолок
 * лицензии «не оплачено» и что сейчас сказано клинике. Никогда не бросает —
 * лицензия уже подписана и уходит клинике.
 */
export function recordIssued(db, clinicId, payload) {
  const s = (v) => (typeof v === 'string' ? v : null);
  const p = payload && typeof payload === 'object' ? payload : {};
  try {
    db.prepare('UPDATE clinics SET licence_issued_at = ?, licence_valid_until = ?, licence_subscription = ?, licence_api_sync_key = ? WHERE clinic_id = ?')
      .run(s(p.issued_at), s(p.valid_until), s(p.subscription), s(p.api_sync_key), clinicId);
  } catch (e) {
    console.warn('[control-plane] could not record the issued licence:', e && e.message);
  }
}

/**
 * Что видят партнёры (и что публичный сервер получает в списке производителя):
 *   'visible' — видят;
 *   'retired' | 'unpaid' | 'off' (онлайн-запись выключена) | 'no_key' (нет
 *   принятого ключа обмена) — «клиника временно недоступна».
 * @param {{active:number|boolean, api_enabled:number|boolean, api_sync_key:?string}} clinic
 */
export function partnersSee(clinic, { entitled }) {
  if (!clinic.active) return 'retired';
  if (!entitled) return 'unpaid';
  if (!clinic.api_enabled) return 'off';
  if (!clinic.api_sync_key) return 'no_key';
  return 'visible';
}
```

diff к сверке (отпечаток считается вне транзакции, записывается в ней, рядом с `last_fingerprint`; подпись — как прежде, после фиксации):

```diff
diff --git a/control-plane/server/services/checkin.js b/control-plane/server/services/checkin.js
index cc1d0ea..1e72cb1 100644
--- a/control-plane/server/services/checkin.js
+++ b/control-plane/server/services/checkin.js
@@ -40,6 +40,11 @@ import { COUNTER_NAMES } from '../../../server/services/control/metrics.js';
 // file's job is DB plumbing (read the clinic's ring/pin, read the releases
 // table, count outcomes); rings.js's job is deciding what those facts mean.
 import { offerFor, shouldHalt } from './rings.js';
+// PUBLIC_LICENCE_V1 (step 8c of the clinic API) — the clinic's sync key for the
+// public server, the online-booking switch and the payment mark in the signed
+// licence. The fingerprint formula is the clinic's own (one definition).
+import { syncKeyFingerprint } from '../../../server/services/api/sync-identity.js';
+import { noteSyncKey, isRevoked, licenceTerms, recordIssued } from './public-api.js';
 
 // Advisory bounds, mirroring enrollment.js's own MAX_FINGERPRINT_LEN (same
 // reasoning: these are evidence, not credentials, so an absurd value is
@@ -255,7 +260,9 @@ function normaliseUpdateResult(input) {
 // in the registry) is treated as NOT entitled: fail closed, the same way the
 // rest of this project treats "can't tell" as "locked" rather than guessing
 // in the clinic's favour.
-function isEntitled(subscription, subscriptionUntil, now = new Date()) {
+// Exported (PUBLIC_LICENCE_V1) for the public-server feed and the panel's "what
+// partners see" — the same rule decides re-arming and partner visibility.
+export function isEntitled(subscription, subscriptionUntil, now = new Date()) {
   if (subscription !== 'active') return false;
   if (subscriptionUntil === null || subscriptionUntil === undefined || subscriptionUntil === '') return true;
   const until = parseDateOnly(subscriptionUntil);
@@ -280,10 +287,15 @@ function isEntitled(subscription, subscriptionUntil, now = new Date()) {
  *   update attempt succeeded. Optional forever, same as `stats` — an old clinic that never sends this checks in
  *   exactly as before. Never verified/interpreted beyond version+ok (see normaliseUpdateResult); only ever used to
  *   move this file's own outcome counters and, via rings.js:shouldHalt, to freeze a release from further offers.
+ * @param {*} [args.apiSyncPublicKey] PUBLIC_LICENCE_V1 — the OPEN half of the clinic's public-server signing key
+ *   (base64 DER SPKI, sent since 8a). Only its fingerprint is stored. Optional forever; garbage is ignored.
  * @param {object} [hooks]
- * @param {function({clinicId:string, clinicName:string, modules:string[]}): {payload:object, sig:string}} [hooks.signLicence]
- *   Called ONLY when the clinic is currently entitled to a fresh licence
- *   (rule 5), and ONLY after the check-in below has already committed (rule
+ * @param {function({clinicId:string, clinicName:string, modules:string[], subscription:string, apiSyncKey:?string,
+ *   notAfter?:string, issuedAfter?:string}): {payload:object, sig:string}} [hooks.signLicence]
+ *   Called when the clinic is entitled to a fresh licence (rule 5) — or, since
+ *   PUBLIC_LICENCE_V1, when it is unpaid but its last licence is still live: an
+ *   "unpaid" licence with the SAME valid_until (services/public-api.js
+ *   licenceTerms). ONLY after the check-in below has already committed (rule
  *   2) — if it throws, the throw propagates straight to the caller, but the
  *   checkins row (and everything else this call wrote) is already durable.
  * @returns {{licence: object|null, subscription: 'active'|'unpaid', collect: string[], update: object|null} | null}
@@ -295,7 +307,7 @@ function isEntitled(subscription, subscriptionUntil, now = new Date()) {
  *   for the single newest release this clinic is eligible for (rings.js:offerFor),
  *   or null when there is nothing to offer.
  */
-export function checkIn(db, { installToken, version, fingerprint, moduleRequests, stats, updateResult } = {}, { signLicence } = {}) {
+export function checkIn(db, { installToken, version, fingerprint, moduleRequests, stats, updateResult, apiSyncPublicKey } = {}, { signLicence } = {}) {
   const token = normaliseToken(installToken);
   if (!token) return null; // malformed/missing — never worth a DB round-trip, same outward shape as "unknown"
 
@@ -309,6 +321,8 @@ export function checkIn(db, { installToken, version, fingerprint, moduleRequests
   const normStats = normaliseStats(stats);
   // UPDATE_DELIVERY_V1 — same reasoning: pure, outside the transaction.
   const normUpdateResult = normaliseUpdateResult(updateResult);
+  // PUBLIC_LICENCE_V1 — pure too: '' for absent or garbage, never a throw.
+  const syncFp = syncKeyFingerprint(apiSyncPublicKey);
 
   // ATOMICITY — as with enrollment.js's own transaction, this is not about
   // concurrent-request locking: better-sqlite3 is fully synchronous and Node
@@ -322,7 +336,9 @@ export function checkIn(db, { installToken, version, fingerprint, moduleRequests
     // same identifying SELECT, not a second query) purely so rings.js:offerFor
     // has what it needs; neither column affects rule 1's identification/entitlement logic.
     const clinic = db.prepare(
-      `SELECT clinic_id, name, subscription, subscription_until, last_fingerprint, collect_set, ring, pinned_version
+      `SELECT clinic_id, name, subscription, subscription_until, last_fingerprint, collect_set, ring, pinned_version,
+              api_enabled, api_sync_key, api_sync_key_accepted_at, api_sync_key_seen, api_sync_key_seen_at,
+              licence_issued_at, licence_valid_until
        FROM clinics WHERE install_token = ? AND active = 1`
     ).get(token);
     // Rule 1 — unknown, inactive, and (handled above) malformed tokens are
@@ -367,6 +383,12 @@ export function checkIn(db, { installToken, version, fingerprint, moduleRequests
        WHERE clinic_id = ?`
     ).run(normVersion, normFingerprint, clinic.clinic_id);
 
+    // PUBLIC_LICENCE_V1 — the sync key: recorded (and accepted if it is the
+    // clinic's first), like last_fingerprint, inside this same transaction.
+    // A revoked key never reaches a licence, whatever the columns say.
+    const sync = noteSyncKey(db, clinic, syncFp);
+    const apiSyncKey = sync.apiSyncKey && !isRevoked(db, 'sync_key', sync.apiSyncKey) ? sync.apiSyncKey : null;
+
     // Rule 6 — deduplicated per (clinic_id, module_key) while status='open'.
     // No unique index enforces this in THIS schema (unlike the clinic-side
     // module_requests_open_uniq partial index) — the SELECT-then-INSERT below
@@ -494,6 +516,10 @@ export function checkIn(db, { installToken, version, fingerprint, moduleRequests
       modules,
       collectSet: clinic.collect_set,
       update,
+      apiEnabled: !!clinic.api_enabled,
+      apiSyncKey,
+      licenceIssuedAt: clinic.licence_issued_at,
+      licenceValidUntil: clinic.licence_valid_until,
     };
   });
 
@@ -513,9 +539,19 @@ export function checkIn(db, { installToken, version, fingerprint, moduleRequests
   // its licence renewal below either.
   pruneCheckins(db);
   const eligible = isEntitled(recorded.subscription, recorded.subscriptionUntil);
-  const licence = eligible && signLicence
-    ? signLicence({ clinicId: recorded.clinicId, clinicName: recorded.clinicName, modules: recorded.modules })
+  // PUBLIC_LICENCE_V1 — entitled: re-armed for 14 days, as always, now also
+  // saying "active" and (switch on) the accepted sync key. Unpaid with a live
+  // last licence: an "unpaid" licence capped at that licence's valid_until —
+  // the payment mark reaches the public server, the clinic's own countdown is
+  // untouched. Unpaid otherwise: nothing, as before.
+  const terms = licenceTerms({
+    entitled: eligible, apiEnabled: recorded.apiEnabled, apiSyncKey: recorded.apiSyncKey,
+    lastIssuedAt: recorded.licenceIssuedAt, lastValidUntil: recorded.licenceValidUntil,
+  });
+  const licence = terms && signLicence
+    ? signLicence({ clinicId: recorded.clinicId, clinicName: recorded.clinicName, modules: recorded.modules, ...terms })
     : null;
+  if (licence) recordIssued(db, recorded.clinicId, licence.payload);
 
   return {
     licence,
```

diff к маршруту:

```diff
diff --git a/control-plane/server/routes/checkin.js b/control-plane/server/routes/checkin.js
index ab5cee9..1dcd009 100644
--- a/control-plane/server/routes/checkin.js
+++ b/control-plane/server/routes/checkin.js
@@ -22,7 +22,10 @@ export function checkinRoutes(db) {
   const r = Router();
 
   r.post('/', (req, res) => {
-    const { install_token, version, fingerprint, module_requests, stats, update_result } = req.body || {};
+    // PUBLIC_LICENCE_V1 — api_sync_public_key (the clinic sends it since 8a) is
+    // the OPEN half of its public-server signing key; checkIn() keeps only its
+    // fingerprint. A private key never travels here.
+    const { install_token, version, fingerprint, module_requests, stats, update_result, api_sync_public_key } = req.body || {};
 
     // signLicence runs INSIDE checkIn(), but only AFTER the check-in itself
     // has already committed (see checkIn's own doc comment) — so if it throws
@@ -44,6 +47,7 @@ export function checkinRoutes(db) {
       moduleRequests: module_requests,
       stats,
       updateResult: update_result,
+      apiSyncPublicKey: api_sync_public_key,
     }, { signLicence });
 
     if (!result) {
```

- [ ] **Step 4:** `LIS_ENABLED=0 node --test control-plane/server/services/public-api.test.js control-plane/server/services/checkin-public-api.test.js control-plane/server/services/checkin.test.js control-plane/server/routes/checkin.route.test.js server/services/control/offline-lockout.test.js server/services/control/checkin-sync-key.test.js <СТОРОЖА>` → **117 тестов** зелёные. Прежние тесты «неоплаченной — лицензии нет» (`checkin.test.js`, `offline-lockout.test.js`) зелёные без правок: в них клиника не сверялась после 8c, выданного срока нет — лицензии нет, как прежде.
- [ ] **Step 5: коммит** «Сверка: отпечаток ключа обмена считается из присланной открытой половины и хранится только он; первый ключ клиники принимается сам, другой ждёт подтверждения, отозванный — никогда; лицензия несёт подписанную отметку оплаты и (при включённой онлайн-записи) отпечаток; неоплаченная клиника с живой лицензией получает «unpaid» с тем же сроком — день блокировки не сдвигается» — шесть файлов.

---

## Task 5: Список производителя `GET /cp/v1/public-feed`, ключ подписи при запуске, README (PUBLIC_LICENCE_V1)

Сборщик А.

**Files:**
- Create: `control-plane/server/routes/public-feed.js`, `control-plane/server/routes/public-feed.test.js`.
- Modify: `control-plane/server/routes/deploy.js` — экспорт `bearerToken`, `tokenMatches` (одни правила токена на два адреса).
- Modify: `control-plane/server/app.js` — адрес списка (над входом продавца, как `/cp/v1/deploy`).
- Modify: `control-plane/server/index.js` — `Signing key: the production vendor key.` или громкое предупреждение.
- Modify: `control-plane/README.md` — раздел о списке и `EASYMED_CP_FEED_TOKEN`.

- [ ] **Step 1: падающий тест:**

**Файл `control-plane/server/routes/public-feed.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — GET /cp/v1/public-feed: без токена адреса нет, чужой
// токен — 401, свой — подписанный список, который проверяет общий проверяющий
// (vendor-feed.js), с клиниками, скрытыми от партнёров, и действующими отзывами.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createEnrollmentCode } from '../services/enrollment.js';
import { createApp } from '../app.js';
import { listen } from '../test-helpers/listen.js';
import { publicFeedRoutes, buildFeedPayload, PUBLIC_FEED_MOUNT } from './public-feed.js';
import { verifyFeed } from '../../../server/services/control/vendor-feed.js';

const TOKEN = 'TESTONLY-feed-token-0123456789abcdef';
const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);
const vendor = crypto.generateKeyPairSync('ed25519');
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-feed-key-'));
const keyFile = path.join(keyDir, 'vendor-private.pem');
fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
test.before(() => { process.env.EASYMED_SIGNING_KEY = keyFile; });
test.after(() => { delete process.env.EASYMED_SIGNING_KEY; fs.rmSync(keyDir, { recursive: true, force: true }); });

/** Реестр: видна партнёрам только c-000001; прочие — каждая по своей причине. */
function registry() {
  const db = openDb(':memory:');
  migrate(db);
  const add = (id, sql = '') => {
    createEnrollmentCode(db, { clinicId: id, name: id });
    db.prepare(`UPDATE clinics SET api_enabled = 1, api_sync_key = ? ${sql} WHERE clinic_id = ?`).run(FP, id);
  };
  add('c-000001');
  add('c-000002', ", subscription = 'unpaid'");
  add('c-000003', ", subscription_until = '2020-01-01'");
  add('c-000004', ', api_enabled = 0');
  add('c-000005', ', api_sync_key = NULL');
  add('c-000006', ', active = 0');
  db.prepare("INSERT INTO deleted_clinics (clinic_id, name) VALUES ('c-000009', 'удалена')").run();
  db.prepare("INSERT INTO revocations (clinic_id, kind, value) VALUES ('c-000001', 'partner_key', ?), ('c-000001', 'sync_key', ?)").run(HASH, FP);
  db.prepare("INSERT INTO revocations (clinic_id, kind, value, removed_at) VALUES ('c-000001', 'partner_key', ?, '2026-10-12T00:00:00Z')").run('ef'.repeat(32));
  return db;
}

async function serve(db, env) {
  const app = express();
  app.use(PUBLIC_FEED_MOUNT, publicFeedRoutes(db, { env, now: () => new Date('2026-10-12T10:00:00.000Z') }));
  const server = await listen(app);
  return { base: 'http://127.0.0.1:' + server.address().port + PUBLIC_FEED_MOUNT, close: () => new Promise((r) => server.close(r)) };
}

test('buildFeedPayload: скрыты не оплаченные, с прошедшим сроком, выключенные, без ключа, снятые и удалённые; отзывы — только действующие', () => {
  const p = buildFeedPayload(registry(), new Date('2026-10-12T10:00:00.000Z'));
  assert.deepEqual(p, {
    kind: 'easymed-public-feed', v: 1, issued_at: '2026-10-12T10:00:00.000Z',
    clinics_off: ['c-000002', 'c-000003', 'c-000004', 'c-000005', 'c-000006', 'c-000009'],
    sync_keys_revoked: [FP], partner_keys_revoked: [HASH],
  });
});

test('нет токена в окружении или он короче 32 знаков — 404; чужой токен — 401; свой — подписанный список, no-store', async (t) => {
  const db = registry();
  for (const env of [{}, { EASYMED_CP_FEED_TOKEN: 'short' }]) {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    const s = await serve(db, env);
    console.error = orig;
    t.after(s.close);
    const r = await fetch(s.base, { headers: { Authorization: 'Bearer ' + TOKEN } });
    assert.equal(r.status, 404);
    assert.equal(errors.length, env.EASYMED_CP_FEED_TOKEN ? 1 : 0, 'короткий токен — громкая строка в журнале');
  }
  const s = await serve(db, { EASYMED_CP_FEED_TOKEN: TOKEN });
  t.after(s.close);
  for (const auth of [undefined, 'Bearer wrong-TESTONLY', 'Basic ' + TOKEN]) {
    const r = await fetch(s.base, { headers: auth ? { Authorization: auth } : {} });
    assert.equal(r.status, 401, String(auth));
  }
  const ok = await fetch(s.base, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const v = verifyFeed(await ok.text(), { publicKey: vendor.publicKey });
  assert.equal(v.ok, true);
  assert.deepEqual(v.feed.partner_keys_revoked, [HASH]);
  assert.ok(!v.feed.clinics_off.includes('c-000001'));
  assert.equal((await fetch(s.base, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN } })).status, 404);
});

test('в приложении: адрес на месте, вход продавца ему не нужен и ничего не даёт', async (t) => {
  const db = registry();
  process.env.EASYMED_CP_FEED_TOKEN = TOKEN;
  const app = createApp(db);
  delete process.env.EASYMED_CP_FEED_TOKEN;
  const server = await listen(app);
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + PUBLIC_FEED_MOUNT)).status, 401);
  const r = await fetch(base + PUBLIC_FEED_MOUNT, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(r.status, 200);
  assert.equal(verifyFeed(await r.text(), { publicKey: vendor.publicKey }).ok, true);
});
```

- [ ] **Step 2:** `node --test control-plane/server/routes/public-feed.test.js` → красный при загрузке (`ERR_MODULE_NOT_FOUND … public-feed.js`).
- [ ] **Step 3: маршрут:**

**Файл `control-plane/server/routes/public-feed.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — GET /cp/v1/public-feed: подписанный список производителя
// для публичного сервера api.easymed.uz (server/services/control/vendor-feed.js).
//
// Публичный сервер забирает его сам, раз в минуту (public-server/server/jobs.js),
// с токеном EASYMED_CP_FEED_TOKEN — тем же, что у него в PUBLIC_FEED_TOKEN. Так
// решение в панели («не оплачено», «онлайн-запись выключена», «заблокировать
// ключ») доходит до партнёров за минуту — даже если клиника без связи или её
// программа подменена: лицензию несёт клиника, этот список — производитель.
//
// Что в нём (только номера клиник и отпечатки ключей — ни имён, ни данных
// пациентов; страж server/services/api/no-patient-data-to-vendor.test.js):
//   clinics_off — каждая клиника реестра, которую партнёры видеть не должны
//                 (services/public-api.js partnersSee ≠ 'visible'), и каждая
//                 удалённая (deleted_clinics) — её последняя лицензия может
//                 быть ещё жива;
//   sync_keys_revoked, partner_keys_revoked — действующие записи revocations.
//
// Подписывается при каждом запросе: issued_at — «сейчас», по нему публичный
// сервер видит, насколько свеж его список (/_metrics feed_age_s), и не берёт
// список старше уже принятого.
//
// Без токена в окружении (или короче 32 знаков) адреса нет — 404, как у
// /cp/v1/deploy. Неверный токен — 401. Тела у запроса нет.
import { Router } from 'express';
import { bearerToken, tokenMatches, MIN_TOKEN_CHARS } from './deploy.js';
import { signFeed } from '../services/signing.js';
import { isEntitled } from '../services/checkin.js';
import { partnersSee } from '../services/public-api.js';
import { makeFeedPayload } from '../../../server/services/control/vendor-feed.js';

export const PUBLIC_FEED_MOUNT = '/cp/v1/public-feed';
const NOT_FOUND_BODY = { error: { code: 'not_found', message: 'Unknown API endpoint.' } };

/** Полезная часть списка — из реестра, на миг now. */
export function buildFeedPayload(db, now = new Date()) {
  const clinicsOff = db.prepare(
    'SELECT clinic_id, active, subscription, subscription_until, api_enabled, api_sync_key FROM clinics',
  ).all()
    .filter((c) => partnersSee(c, { entitled: isEntitled(c.subscription, c.subscription_until, now) }) !== 'visible')
    .map((c) => c.clinic_id)
    .concat(db.prepare('SELECT clinic_id FROM deleted_clinics').all().map((r) => r.clinic_id));
  const live = (kind) => db.prepare('SELECT value FROM revocations WHERE kind = ? AND removed_at IS NULL').all(kind).map((r) => r.value);
  return makeFeedPayload({
    issuedAt: now.toISOString(),
    clinicsOff,
    syncKeysRevoked: live('sync_key'),
    partnerKeysRevoked: live('partner_key'),
  });
}

function configuredToken(env) {
  const raw = String(env.EASYMED_CP_FEED_TOKEN || '').trim();
  return raw.length >= MIN_TOKEN_CHARS ? raw : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{env?:object, now?:()=>Date}} [opts]
 */
export function publicFeedRoutes(db, { env = process.env, now = () => new Date() } = {}) {
  const r = Router();
  const token = configuredToken(env);
  if (!token && String(env.EASYMED_CP_FEED_TOKEN || '').trim()) {
    console.error(`[control-plane] EASYMED_CP_FEED_TOKEN is shorter than ${MIN_TOKEN_CHARS} characters and is being IGNORED — ${PUBLIC_FEED_MOUNT} will answer 404 and the public server cannot learn about unpaid clinics or revoked keys.`);
  }
  r.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!token) return res.status(404).json(NOT_FOUND_BODY);
    if (!tokenMatches(bearerToken(req.headers.authorization), token)) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'A valid feed token is required.' } });
    }
    return next();
  });
  r.get('/', (req, res) => res.json(signFeed(buildFeedPayload(db, now()))));
  r.use((req, res) => res.status(404).json(NOT_FOUND_BODY));
  return r;
}
```

diff к `deploy.js`:

```diff
diff --git a/control-plane/server/routes/deploy.js b/control-plane/server/routes/deploy.js
index 9969f9c..8fca30d 100644
--- a/control-plane/server/routes/deploy.js
+++ b/control-plane/server/routes/deploy.js
@@ -133,7 +133,9 @@ function configuredToken(env = process.env) {
 // `Authorization: Bearer <token>` and nothing else. The scheme is compared
 // case-insensitively (RFC 7235 says it is case-insensitive) but the token
 // itself never is.
-function bearerToken(header) {
+// Exported (PUBLIC_LICENCE_V1) for routes/public-feed.js — the same bearer
+// rules for the second token-guarded endpoint, never a second copy.
+export function bearerToken(header) {
   const m = /^Bearer[ \t]+(\S+)$/i.exec(String(header || ''));
   return m ? m[1] : null;
 }
@@ -152,7 +154,7 @@ function bearerToken(header) {
  * published format), so a wrong-length guess still pays for one full
  * comparison before being refused.
  */
-function tokenMatches(given, expected) {
+export function tokenMatches(given, expected) {
   const a = Buffer.from(String(given ?? ''), 'utf8');
   const b = Buffer.from(expected, 'utf8');
   if (a.length !== b.length) {
```

diff к `app.js`:

```diff
diff --git a/control-plane/server/app.js b/control-plane/server/app.js
index b6a6207..5cd9088 100644
--- a/control-plane/server/app.js
+++ b/control-plane/server/app.js
@@ -9,6 +9,7 @@ import { deployRoutes, DEPLOY_MOUNT } from './routes/deploy.js';
 import { relayRoutes, RELAY_MOUNT } from './routes/relay.js';   // BRANCH_SYNC_RELAY_V1
 import { relayTokenRouter, RELAY_TOKEN_MOUNT } from './routes/relay-token.js';   // BRANCH_IDENTITY_V1
 import { branchRouter } from './routes/branch.js';   // BRANCH_SELF_SERVICE_V1
+import { publicFeedRoutes, PUBLIC_FEED_MOUNT } from './routes/public-feed.js';   // PUBLIC_LICENCE_V1
 
 // control-plane/server/app.js -> control-plane/ -> control-plane/public
 const CONTROL_PLANE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
@@ -62,6 +63,12 @@ export function createApp(db) {
   // stores bytes it cannot read.
   app.use(RELAY_MOUNT, relayRoutes(db));
 
+  // PUBLIC_LICENCE_V1 — the public server's feed (clinics hidden from partners,
+  // revoked keys), a bearer-token GET with no body. Above attachVendorUser for
+  // the reason deploy is: a vendor session must buy nothing here. See
+  // routes/public-feed.js.
+  app.use(PUBLIC_FEED_MOUNT, publicFeedRoutes(db));
+
   app.use('/cp', express.json({ limit: '100kb' }));
   // VENDOR_LOGIN_V1 — resolves the vendor session cookie into req.vendorUser
   // for every /cp route, in one place. /cp/v1/enroll and /cp/v1/checkin never
```

diff к `index.js` (не запускать — только `node --check control-plane/server/index.js`):

```diff
diff --git a/control-plane/server/index.js b/control-plane/server/index.js
index d794979..1c17499 100644
--- a/control-plane/server/index.js
+++ b/control-plane/server/index.js
@@ -3,7 +3,7 @@ import path from 'node:path';
 import { fileURLToPath } from 'node:url';
 import { openDb } from './db/connection.js';
 import { migrate } from './db/migrate.js';
-import { ensureSigningKey } from './services/signing.js';
+import { ensureSigningKey, signingKeyIsProduction } from './services/signing.js';
 import { bootstrapVendorAdmin } from './services/vendor-auth.js';
 import { createApp } from './app.js';
 
@@ -35,6 +35,20 @@ try {
   process.exit(1);
 }
 
+// PUBLIC_LICENCE_V1 — a key that is not the production one is fine on a dev
+// machine and a disaster on settings.easymed.uz: no real clinic and not the
+// public server would accept anything this process signs. Said loudly, once.
+if (!signingKeyIsProduction()) {
+  console.warn('');
+  console.warn('  WARNING: EASYMED_SIGNING_KEY is NOT the production vendor key compiled into');
+  console.warn('  every clinic (server/services/control/licence.js). Real clinics and the public');
+  console.warn('  server api.easymed.uz will reject every licence and feed this process signs.');
+  console.warn('  Expected only on a development machine.');
+  console.warn('');
+} else {
+  console.log('Signing key: the production vendor key.');
+}
+
 const db = openDb(path.join(DATA_DIR, 'registry.db'));
 migrate(db);
 const firstRunPassword = bootstrapVendorAdmin(db);
```

diff к README:

````diff
diff --git a/control-plane/README.md b/control-plane/README.md
index bd886ce..56f5768 100644
--- a/control-plane/README.md
+++ b/control-plane/README.md
@@ -140,6 +140,40 @@ database (migration `005_relay_blobs.sql`), not on disk, so there is no nginx
 | `EASYMED_CP_MAX_RELAY_BYTES` | 12 MB | The largest encrypted catalogue accepted |
 | `EASYMED_CP_RELAY_RETENTION_DAYS` | 30 | A blob untouched (neither uploaded nor downloaded) for this long is deleted. Swept on every upload — there is no scheduler |
 
+## Online booking and the public server (`/cp/v1/public-feed`)
+
+PUBLIC_LICENCE_V1 (step 8c of the clinic API). The public server
+`api.easymed.uz` (`public-server/`) never calls this service while serving a
+request: it recognises a clinic by its **signed licence**, which since 8c can
+carry two more fields —
+
+- `subscription: 'active' | 'unpaid'` — the payment mark (owner decision 17:
+  partners stop seeing a clinic at the first "unpaid"). An unpaid clinic whose
+  last licence is still live gets an "unpaid" licence with the **same**
+  `valid_until`: the mark reaches the public server, the clinic's own 14-day
+  countdown is untouched;
+- `api_sync_key` — the fingerprint of the clinic's own signing key for the
+  public server, only while **Online booking / API** is switched on for the
+  clinic in the panel. Without it the clinic's exchange stays silent.
+
+A licence travels with the clinic, so a clinic that is offline (or runs
+modified software) could keep presenting an old one. For that, the public
+server also pulls a **vendor-signed feed** from `GET /cp/v1/public-feed` once a
+minute: clinics partners must not see (unpaid, retired, deleted, switched off,
+no accepted key) and revoked keys (partner keys by SHA-256, clinic sync keys by
+fingerprint — added in the clinic's page of the panel). It holds clinic ids and
+key fingerprints only. Signed with the licence key over different bytes
+(`server/services/control/vendor-feed.js`), so a feed can never pass as a
+licence.
+
+| Variable | Default | Notes |
+|---|---|---|
+| `EASYMED_CP_FEED_TOKEN` | none | The same string as `PUBLIC_FEED_TOKEN` on the public server. Without it the endpoint answers 404 and the public server cannot learn about unpaid clinics or revoked keys. Minimum 32 characters; a shorter one is ignored, with a loud line in the log |
+
+At boot the control plane says whether `EASYMED_SIGNING_KEY` is the production
+key compiled into every clinic (`Signing key: the production vendor key.`) or
+warns loudly that it is not — expected only on a development machine.
+
 ## Development
 
 From the repository root:
````

- [ ] **Step 4:** `node --check control-plane/server/index.js` и `node --test control-plane/server/routes/public-feed.test.js control-plane/server/routes/deploy.test.js control-plane/server/panel.test.js <СТОРОЖА>` → **34 теста** зелёные (страж данных пациентов проверяет и новый адрес).
- [ ] **Step 5: коммит** «Список производителя для публичного сервера: GET /cp/v1/public-feed с токеном EASYMED_CP_FEED_TOKEN (без него адреса нет) — подписанные на каждый запрос клиники, скрытые от партнёров (не оплачено, снята, удалена, выключено, нет ключа), и действующие отзывы ключей; правила токена — общие с выпуском; при запуске сервер лицензий говорит, настоящий ли ключ подписи» — шесть файлов.

---

## Task 6: Панель — маршруты: переключатель, принять новый ключ, блокировки ключей (PUBLIC_LICENCE_V1)

Сборщик А.

**Files:**
- Create: `control-plane/server/routes/admin-public-api.js` — четыре маршрута на роутере `admin.js` (за тем же `requireVendor`), блок `api` карточки клиники.
- Create: `control-plane/server/routes/admin-public-api.test.js`.
- Modify: `control-plane/server/routes/admin.js` — таблица маршрутов, `api` в `GET /clinics/:id`, `api_enabled` и `api_key_pending` в `GET /clinics`, регистрация маршрутов.

- [ ] **Step 1: падающий тест:**

**Файл `control-plane/server/routes/admin-public-api.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — панель через HTTP: переключатель онлайн-записи, новый ключ
// обмена (принять), срочный отзыв ключей; ключ партнёра целиком не принимается.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/vendor-auth.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../services/enrollment.js';
import { checkIn } from '../services/checkin.js';
import { signLicence } from '../services/signing.js';
import { createApp } from '../app.js';
import { listen } from '../test-helpers/listen.js';
import { newApiKey, keyHash } from '../../../server/services/api/secret-box.js';

const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-admin-api-key-'));
const keyFile = path.join(keyDir, 'vendor-private.pem');
fs.writeFileSync(keyFile, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
test.before(() => { process.env.EASYMED_SIGNING_KEY = keyFile; });
test.after(() => { delete process.env.EASYMED_SIGNING_KEY; fs.rmSync(keyDir, { recursive: true, force: true }); });

function syncKey() {
  const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return { b64: pub.toString('base64'), fp: crypto.createHash('sha256').update(pub).digest('hex').slice(0, 32) };
}

async function harness(t) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)').run('vendor', hashPassword('secret123'), 'Vendor');
  const token = redeemEnrollmentCode(db, { code: createEnrollmentCode(db, { clinicId: 'c-1', name: 'Шифо' }) }).install_token;
  const server = await listen(createApp(db));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/cp/v1';
  const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vendor', password: 'secret123' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (method, p, body) => {
    const res = await fetch(base + '/admin' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const checkin = (b64) => checkIn(db, { installToken: token, ...(b64 ? { apiSyncPublicKey: b64 } : {}) }, { signLicence });
  return { db, call, checkin };
}

test('карточка клиники: блок «Online booking / API» — выключено, ключа нет, лицензии 8c нет, блокировок нет', async (t) => {
  const s = await harness(t);
  const d = await s.call('GET', '/clinics/c-1');
  assert.deepEqual(d.body.clinic.api, { enabled: false, sync_key: null, sync_key_accepted_at: null, sync_key_seen: null, sync_key_seen_at: null,
    key_pending: false, seen_key_revoked: false, partners_see: 'off', licence: null, revocations: [] });
  const list = await s.call('GET', '/clinics');
  assert.deepEqual([list.body.clinics[0].api_enabled, list.body.clinics[0].api_key_pending], [false, false]);
});

test('переключатель: только true/false; включили — «нет ключа», пока клиника его не прислала; потом — видна, и лицензия это говорит', async (t) => {
  const s = await harness(t);
  for (const enabled of ['yes', 1, null, undefined]) assert.equal((await s.call('POST', '/clinics/c-1/api', { enabled })).status, 400);
  assert.equal((await s.call('POST', '/clinics/c-нет/api', { enabled: true })).status, 404);
  const on = await s.call('POST', '/clinics/c-1/api', { enabled: true });
  assert.deepEqual([on.status, on.body.api.enabled, on.body.api.partners_see], [200, true, 'no_key']);
  assert.match(on.body.note, /within a minute/);
  const k = syncKey();
  s.checkin(k.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.partners_see, d.licence.subscription, d.licence.api_sync_key], [k.fp, 'visible', 'active', k.fp]);
  const off = await s.call('POST', '/clinics/c-1/api', { enabled: false });
  assert.equal(off.body.api.partners_see, 'off');
});

test('новый ПК: ключ ждёт подтверждения, доска это показывает; принять можно только тот, что на экране', async (t) => {
  const s = await harness(t);
  const a = syncKey();
  const b = syncKey();
  s.checkin(a.b64);
  s.checkin(b.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.sync_key_seen, d.key_pending], [a.fp, b.fp, true]);
  assert.equal((await s.call('GET', '/clinics')).body.clinics[0].api_key_pending, true);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: 'не отпечаток' })).status, 400);
  const wrong = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: a.fp });
  assert.deepEqual([wrong.status, wrong.body.error.code], [409, 'conflict']);
  const ok = await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp });
  assert.deepEqual([ok.status, ok.body.api.sync_key, ok.body.api.key_pending], [200, b.fp, false]);
  assert.equal((await s.call('POST', '/clinics/c-1/api/accept-key', { fingerprint: b.fp })).status, 409, 'ждущего больше нет');
});

test('блокировка ключа партнёра: только SHA-256; сам ключ — отказ без следа; повтор — «уже»; снять — один раз', async (t) => {
  const s = await harness(t);
  const key = newApiKey();
  const raw = await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value: key, note: 'утёк' });
  assert.equal(raw.status, 400);
  assert.match(raw.body.error.message, /SHA-256 of the key, not the key itself/, 'узнан именно ключ, а не «неверный отпечаток»');
  assert.ok(!JSON.stringify(raw.body).includes(key), 'ключ не возвращается в ответе');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM revocations').get().n, 0);
  for (const value of ['ab'.repeat(16), 'zz'.repeat(32), '', 42]) {
    assert.equal((await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value })).status, 400);
  }
  assert.equal((await s.call('POST', '/clinics/c-1/revocations', { kind: 'clinic', value: keyHash(key) })).status, 400);
  const add = await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value: keyHash(key).toUpperCase(), note: '  med24: ключ утёк  ' });
  assert.equal(add.status, 201);
  assert.match(add.body.note, /even while the clinic is offline/);
  assert.deepEqual(add.body.api.revocations.map((r) => [r.kind, r.value, r.note, r.created_by]), [['partner_key', keyHash(key), 'med24: ключ утёк', 'vendor']]);
  const again = await s.call('POST', '/clinics/c-1/revocations', { kind: 'partner_key', value: keyHash(key) });
  assert.deepEqual([again.status, again.body.already, again.body.id], [200, true, add.body.id]);
  assert.equal((await s.call('DELETE', '/clinics/c-1/revocations/' + add.body.id)).status, 200);
  assert.equal((await s.call('DELETE', '/clinics/c-1/revocations/' + add.body.id)).status, 404);
  const row = s.db.prepare('SELECT removed_at, removed_by FROM revocations WHERE id = ?').get(add.body.id);
  assert.ok(row.removed_at && row.removed_by === 'vendor', 'снятие помнится: кто и когда');
});

test('блокировка ключа обмена: принятый ключ уходит из лицензии, клиника скрыта; тот же ключ больше не «ждёт подтверждения»', async (t) => {
  const s = await harness(t);
  await s.call('POST', '/clinics/c-1/api', { enabled: true });
  const k = syncKey();
  s.checkin(k.b64);
  const blocked = await s.call('POST', '/clinics/c-1/revocations', { kind: 'sync_key', value: k.fp, note: 'ПК украден' });
  assert.equal(blocked.status, 201);
  assert.deepEqual([blocked.body.api.sync_key, blocked.body.api.partners_see, blocked.body.api.seen_key_revoked, blocked.body.api.key_pending],
    [null, 'no_key', true, false]);
  const next = s.checkin(k.b64);
  assert.equal('api_sync_key' in next.licence.payload, false, 'следующая лицензия — без ключа');
  const fresh = syncKey();
  s.checkin(fresh.b64);
  const d = (await s.call('GET', '/clinics/c-1')).body.clinic.api;
  assert.deepEqual([d.sync_key, d.key_pending], [null, true], 'новый ключ после кражи — только подтверждением');
});
```

- [ ] **Step 2:** `node --test control-plane/server/routes/admin-public-api.test.js` → 5 из 5 красные (`AssertionError`: у карточки клиники нет блока `api`; маршрутов нет — 404).
- [ ] **Step 3: маршруты:**

**Файл `control-plane/server/routes/admin-public-api.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — панель: «Online booking / API» клиники и срочный отзыв ключей.
//
// Маршруты регистрируются на ТОМ ЖЕ роутере, что admin.js (registerPublicApiRoutes),
// после его requireVendor; их таблица входит в ADMIN_ROUTE_TABLE — состязательный
// тест admin.test.js проверяет, что каждый отвечает 401 без входа.
//
//   POST   /clinics/:id/api                 {enabled}       — переключатель онлайн-записи
//   POST   /clinics/:id/api/accept-key      {fingerprint}   — принять новый ключ обмена (новый ПК)
//   POST   /clinics/:id/revocations         {kind, value, note} — заблокировать ключ
//   DELETE /clinics/:id/revocations/:rid                    — снять блокировку
//
// Ключ партнёра сюда не приходит: панель считает его SHA-256 в браузере
// (panel-logic.js sha256Hex) и шлёт отпечаток. Сам ключ, присланный по ошибке,
// отвергается и нигде не сохраняется и не пишется в журнал (решение владельца 5:
// наружу из клиники — только отпечатки ключей).
import { isEntitled } from '../services/checkin.js';
import {
  partnersSee, syncKeyPending, acceptPendingSyncKey, isRevoked, isoSeconds, SYNC_FP_RE, KEY_HASH_RE,
} from '../services/public-api.js';
import { KEY_RE } from '../../../public/js/shared/api-connections.js';

export const PUBLIC_API_ROUTE_TABLE = [
  { method: 'POST', path: '/clinics/:id/api' },
  { method: 'POST', path: '/clinics/:id/api/accept-key' },
  { method: 'POST', path: '/clinics/:id/revocations' },
  { method: 'DELETE', path: '/clinics/:id/revocations/:rid' },
];

export const SWITCH_NOTE = "Partners: within a minute (the public server's feed). The clinic's own exchange: from its next check-in (hourly).";
export const REVOKE_NOTE = 'Takes effect on the public server within a minute — even while the clinic is offline.';
const NOTE_MAX = 200;

const CLINIC_COLUMNS = `clinic_id, active, subscription, subscription_until, api_enabled, api_sync_key, api_sync_key_accepted_at,
  api_sync_key_seen, api_sync_key_seen_at, licence_issued_at, licence_valid_until, licence_subscription, licence_api_sync_key`;

/**
 * Блок «Online booking / API» для GET /clinics/:id и ответов этих маршрутов.
 * partners_see — то же правило, что решает список производителя (routes/public-feed.js).
 */
export function apiViewOf(db, c, now = new Date()) {
  return {
    enabled: !!c.api_enabled,
    sync_key: c.api_sync_key || null,
    sync_key_accepted_at: c.api_sync_key_accepted_at || null,
    sync_key_seen: c.api_sync_key_seen || null,
    sync_key_seen_at: c.api_sync_key_seen_at || null,
    key_pending: syncKeyPending(db, c),
    seen_key_revoked: isRevoked(db, 'sync_key', c.api_sync_key_seen),
    partners_see: partnersSee(c, { entitled: isEntitled(c.subscription, c.subscription_until, now) }),
    licence: c.licence_issued_at ? {
      issued_at: c.licence_issued_at, valid_until: c.licence_valid_until,
      subscription: c.licence_subscription, api_sync_key: c.licence_api_sync_key,
    } : null,
    revocations: db.prepare(
      'SELECT id, kind, value, note, created_at, created_by FROM revocations WHERE clinic_id = ? AND removed_at IS NULL ORDER BY id DESC',
    ).all(c.clinic_id),
  };
}

const clinicOf = (db, id) => db.prepare(`SELECT ${CLINIC_COLUMNS} FROM clinics WHERE clinic_id = ?`).get(id);
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

/** @param {import('express').Router} r роутер admin.js, уже за requireVendor */
export function registerPublicApiRoutes(r, db) {
  r.post('/clinics/:id/api', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return fail(res, 400, 'bad_request', 'enabled must be true or false.');
    db.prepare('UPDATE clinics SET api_enabled = ? WHERE clinic_id = ?').run(enabled ? 1 : 0, c.clinic_id);
    return res.json({ ok: true, note: SWITCH_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.post('/clinics/:id/api/accept-key', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const fingerprint = String((req.body && req.body.fingerprint) || '');
    if (!SYNC_FP_RE.test(fingerprint)) return fail(res, 400, 'bad_request', 'fingerprint must be the 32-character key fingerprint shown on this page.');
    const out = acceptPendingSyncKey(db, c.clinic_id, fingerprint);
    if (out.error === 'not_pending') return fail(res, 409, 'conflict', 'No new key is waiting for this clinic.');
    if (out.error === 'changed') return fail(res, 409, 'conflict', 'The clinic has sent another key since this page was loaded — reload the page and check again.');
    if (out.error === 'revoked') return fail(res, 409, 'conflict', 'This key is blocked. Unblock it first if it really is the clinic.');
    return res.json({ ok: true, note: SWITCH_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.post('/clinics/:id/revocations', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const { kind, value, note } = req.body || {};
    if (kind !== 'partner_key' && kind !== 'sync_key') return fail(res, 400, 'bad_request', 'kind must be "partner_key" or "sync_key".');
    const raw = typeof value === 'string' ? value.trim() : '';
    if (KEY_RE.test(raw)) {
      // The key itself, not its fingerprint. Refused, never stored, never echoed.
      return fail(res, 400, 'bad_request', 'Send the SHA-256 of the key, not the key itself — the panel computes it in your browser.');
    }
    const v = raw.toLowerCase();
    if (!(kind === 'partner_key' ? KEY_HASH_RE : SYNC_FP_RE).test(v)) {
      return fail(res, 400, 'bad_request', kind === 'partner_key'
        ? 'value must be the SHA-256 of the partner key (64 hex characters).'
        : 'value must be the sync key fingerprint (32 hex characters).');
    }
    if (note !== undefined && note !== null && typeof note !== 'string') return fail(res, 400, 'bad_request', 'note must be text.');
    const text = typeof note === 'string' && note.trim() ? note.trim().slice(0, NOTE_MAX) : null;
    const existing = db.prepare('SELECT id FROM revocations WHERE kind = ? AND value = ? AND removed_at IS NULL').get(kind, v);
    if (existing) return res.json({ ok: true, already: true, id: existing.id, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
    const id = db.transaction(() => {
      const info = db.prepare('INSERT INTO revocations (clinic_id, kind, value, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.clinic_id, kind, v, text, isoSeconds(), req.vendorUser.username);
      // The accepted sync key blocked — it leaves the next licence too; a new
      // key from the clinic then waits for "Accept new key".
      if (kind === 'sync_key' && c.api_sync_key === v) db.prepare('UPDATE clinics SET api_sync_key = NULL WHERE clinic_id = ?').run(c.clinic_id);
      return Number(info.lastInsertRowid);
    })();
    return res.status(201).json({ ok: true, id, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });

  r.delete('/clinics/:id/revocations/:rid', (req, res) => {
    const c = clinicOf(db, req.params.id);
    if (!c) return fail(res, 404, 'not_found', 'Clinic not found.');
    const row = db.prepare('SELECT id FROM revocations WHERE id = ? AND clinic_id = ? AND removed_at IS NULL').get(Number(req.params.rid) || 0, c.clinic_id);
    if (!row) return fail(res, 404, 'not_found', 'This block is not active for this clinic.');
    db.prepare('UPDATE revocations SET removed_at = ?, removed_by = ? WHERE id = ?').run(isoSeconds(), req.vendorUser.username, row.id);
    return res.json({ ok: true, note: REVOKE_NOTE, api: apiViewOf(db, clinicOf(db, c.clinic_id)) });
  });
}
```

diff к `admin.js`:

```diff
diff --git a/control-plane/server/routes/admin.js b/control-plane/server/routes/admin.js
index 63968a1..6c5dc03 100644
--- a/control-plane/server/routes/admin.js
+++ b/control-plane/server/routes/admin.js
@@ -11,6 +11,10 @@ import { COUNTERS, COUNTER_NAMES } from '../../../server/services/control/metric
 // versions numerically per segment ("0.10.0" is newer than "0.9.0") is exactly
 // the kind of function that goes subtly wrong when re-typed.
 import { compareVersions } from '../../../scripts/build-bundle.mjs';
+// PUBLIC_LICENCE_V1 — "Online booking / API" and emergency key revocation
+// (step 8c): routes on this same router, behind the same requireVendor.
+import { PUBLIC_API_ROUTE_TABLE, registerPublicApiRoutes, apiViewOf } from './admin-public-api.js';
+import { syncKeyPending } from '../services/public-api.js';
 
 // CONTROL_PLANE_V1 — the vendor's own admin API, behind vendor login. This is
 // the part of the control plane the owner actually touches: today they would
@@ -85,6 +89,7 @@ export const ADMIN_ROUTE_TABLE = [
   { method: 'POST', path: '/releases/:id/unhalt' },
   { method: 'POST', path: '/clinics/:id/ring' },
   { method: 'POST', path: '/clinics/:id/pin' },
+  ...PUBLIC_API_ROUTE_TABLE,
 ];
 
 function bad(res, message) {
@@ -303,7 +308,7 @@ export function adminRoutes(db) {
   r.get('/clinics', (req, res) => {
     const rows = db.prepare(
       `SELECT clinic_id, name, subscription, subscription_until, last_seen_at, last_version,
-              active, retired_at, parent_clinic_id, ring, pinned_version
+              active, retired_at, parent_clinic_id, ring, pinned_version, api_enabled, api_sync_key, api_sync_key_seen
        FROM clinics ORDER BY name COLLATE NOCASE`
     ).all();
 
@@ -339,6 +344,9 @@ export function adminRoutes(db) {
       latest_stats: statsByClinic.get(c.clinic_id)?.stats ?? null,
       latest_stats_at: statsByClinic.get(c.clinic_id)?.at ?? null,
       versions_behind: versionsBehind(offerable, c.last_version),
+      // PUBLIC_LICENCE_V1 — the board flags "new API key waiting" (panel-logic.js attentionReasons).
+      api_enabled: !!c.api_enabled,
+      api_key_pending: syncKeyPending(db, c),
     }));
     res.json({ clinics });
   });
@@ -346,7 +354,9 @@ export function adminRoutes(db) {
   r.get('/clinics/:id', (req, res) => {
     const c = db.prepare(
       `SELECT clinic_id, name, contact_phone, contact_name, subscription, subscription_until,
-              last_seen_at, last_version, last_fingerprint, active, created_at, collect_set
+              last_seen_at, last_version, last_fingerprint, active, created_at, collect_set,
+              api_enabled, api_sync_key, api_sync_key_accepted_at, api_sync_key_seen, api_sync_key_seen_at,
+              licence_issued_at, licence_valid_until, licence_subscription, licence_api_sync_key
        FROM clinics WHERE clinic_id = ?`
     ).get(req.params.id);
     if (!c) return notFound(res, 'Clinic not found.');
@@ -384,6 +394,8 @@ export function adminRoutes(db) {
         collect_set: parsedCollectSet(c.collect_set),
         latest_stats: latest ? latest.stats : null,
         latest_stats_at: latest ? latest.at : null,
+        // PUBLIC_LICENCE_V1 — "Online booking / API": switch, sync key, what partners see, blocks.
+        api: apiViewOf(db, c),
       },
       checkins,
     });
@@ -802,5 +814,8 @@ export function adminRoutes(db) {
     res.json({ ok: true, note: NEXT_CHECKIN_NOTE });
   });
 
+  // --- online booking / API and key revocation (PUBLIC_LICENCE_V1) -------------
+  registerPublicApiRoutes(r, db);
+
   return r;
 }
```

- [ ] **Step 4:** `node --test control-plane/server/routes/admin-public-api.test.js control-plane/server/routes/admin.test.js control-plane/server/panel.test.js <СТОРОЖА>` → **95 тестов** зелёные (состязательный тест `admin.test.js` проверяет и четыре новых маршрута: без входа — 401).
- [ ] **Step 5: коммит** «Панель, маршруты «Online booking / API»: переключатель онлайн-записи, «принять новый ключ» только тот, что видел человек, срочные блокировки ключей партнёров (только SHA-256 — сам ключ отвергается без следа) и ключей обмена (принятый уходит из следующей лицензии), снятие с историей; карточка клиники говорит, что видят партнёры и что сказано её лицензии; доска знает о новом ключе» — три файла.

---

## Task 7: Панель — экран: карточка «Online booking / API», доска (PUBLIC_LICENCE_V1)

Сборщик А.

**Files:**
- Create: `control-plane/public/panel-api-card.js` — карточка.
- Create: `control-plane/public/panel-public-api.test.js`.
- Modify: `control-plane/public/panel-logic.js` — слова «что видят партнёры», короткий отпечаток, строка лицензии, разбор вставленного ключа, `sha256Hex`, причина доски.
- Modify: `control-plane/public/panel-api.js` — четыре вызова.
- Modify: `control-plane/public/panel-clinic-detail.js` — место карточки, обновление после оплаты и снятия.
- Modify: `control-plane/public/panel.css` — два тона значка (контраст ≥ 4.5:1: 5.04 и 5.04), моноширинный отпечаток.
- Modify: `control-plane/server/panel.test.js` — модуль карточки отдаётся как вся панель.

- [ ] **Step 1: падающие тесты:**

**Файл `control-plane/public/panel-public-api.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — решения карточки «Online booking / API»: слова «что видят
// партнёры», короткий отпечаток, строка лицензии, разбор вставленного ключа и
// его SHA-256 в браузере — тот же, что считает клиника; новый ключ на доске.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  partnersSeeText, shortFp, licenceLine, revocationInput, sha256Hex, PARTNER_KEY_RE, attentionReasons,
} from './panel-logic.js';
import { KEY_RE } from '../../public/js/shared/api-connections.js';
import { newApiKey, keyHash } from '../../server/services/api/secret-box.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('что видят партнёры: каждый код сервера — своя фраза и тон; незнакомый — «перезагрузите»', () => {
  assert.deepEqual(partnersSeeText('visible'), { label: 'Partners see this clinic', tone: 'ok' });
  for (const [code, tone] of [['off', 'muted'], ['no_key', 'warn'], ['unpaid', 'danger'], ['retired', 'danger']]) {
    assert.equal(partnersSeeText(code).tone, tone);
    assert.match(partnersSeeText(code).label, /^Hidden from partners/);
  }
  assert.match(partnersSeeText('unpaid').label, /temporarily unavailable/, 'слова партнёров — «временно недоступна», не «не оплатила»');
  assert.equal(partnersSeeText('что-то').tone, 'danger');
});

test('короткий отпечаток и строка лицензии', () => {
  assert.equal(shortFp('46de4fe9a62a7f1349bdd3658be1696a'), '46de4fe9…696a');
  assert.equal(shortFp(null), '—');
  assert.match(licenceLine(null), /has not checked in since/);
  assert.equal(licenceLine({ issued_at: '2026-10-12T10:05:00.000Z', subscription: 'unpaid', api_sync_key: '46de4fe9a62a7f1349bdd3658be1696a' }),
    "Clinic's licence, issued 12 Oct 2026 10:05 UTC: unpaid, online booking on (key 46de4fe9…696a).");
  assert.match(licenceLine({ issued_at: '2026-10-12T10:05:00.000Z', subscription: 'active', api_sync_key: null }), /paid, online booking off\.$/);
});

test('вставленное: ключ партнёра — считать отпечаток здесь; отпечаток — как есть (строчными); прочее — нет', () => {
  const key = newApiKey();
  assert.deepEqual(revocationInput('  ' + key + ' '), { kind: 'key', value: key });
  assert.deepEqual(revocationInput('AB'.repeat(32)), { kind: 'hash', value: 'ab'.repeat(32) });
  for (const bad of ['', 'em_live_short', 'ab'.repeat(16), null, 42]) assert.deepEqual(revocationInput(bad), { kind: 'bad' });
  assert.equal(PARTNER_KEY_RE.source, KEY_RE.source, 'вид ключа в панели = вид ключа программы (shared/api-connections.js)');
});

test('SHA-256 в браузере — тот же отпечаток, по которому публичный сервер узнаёт ключ (keyHash клиники)', async () => {
  const key = newApiKey();
  assert.equal(await sha256Hex(key), keyHash(key));
});

test('доска: новый ключ обмена — причина «нужно внимание»', () => {
  const live = { last_seen_at: new Date().toISOString(), subscription: 'active', subscription_until: null, versions_behind: 0, active: true };
  assert.deepEqual(attentionReasons(live), []);
  assert.deepEqual(attentionReasons({ ...live, api_key_pending: true }), ['new API key waiting']);
});

test('страница клиники подключает карточку; ключ партнёра не уходит на сервер — только sha256Hex', () => {
  const detail = fs.readFileSync(path.join(HERE, 'panel-clinic-detail.js'), 'utf8');
  assert.match(detail, /import \{ renderApiCard \} from '\.\/panel-api-card\.js'/);
  assert.match(detail, /id="dt-api-card"/);
  const card = fs.readFileSync(path.join(HERE, 'panel-api-card.js'), 'utf8');
  assert.match(card, /parsed\.kind === 'key' \? await sha256Hex\(parsed\.value\) : parsed\.value/);
  assert.doesNotMatch(card, /addRevocation\([^)]*parsed\.value\s*[,}]/, 'сырое значение не уходит в addRevocation');
});
```

```diff
diff --git a/control-plane/server/panel.test.js b/control-plane/server/panel.test.js
index 54624f8..c3afda9 100644
--- a/control-plane/server/panel.test.js
+++ b/control-plane/server/panel.test.js
@@ -317,3 +317,14 @@ test('a 401 from the admin API carries the standard {error:{code,message}} shape
   assert.equal(body.error.code, 'unauthorized');
   assert.ok(body.error.message);
 });
+
+// PUBLIC_LICENCE_V1 — the "Online booking / API" card is a module of its own;
+// it must be served exactly like the rest of the panel (no session, no-cache).
+test('static: GET /cp/panel-api-card.js serves the card module with no-cache', async (t) => {
+  const { server } = await harness(t);
+  const res = await fetch(`http://127.0.0.1:${server.address().port}/cp/panel-api-card.js`);
+  assert.equal(res.status, 200);
+  assert.match(res.headers.get('content-type') || '', /javascript/);
+  assert.equal(res.headers.get('cache-control'), 'no-cache');
+  assert.match(await res.text(), /export function renderApiCard/);
+});
```

- [ ] **Step 2:** `node --test control-plane/public/panel-public-api.test.js control-plane/server/panel.test.js` →
  - `panel-public-api.test.js` — красный при загрузке: `… './panel-logic.js' does not provide an export named 'PARTNER_KEY_RE'`;
  - `panel.test.js` — 1 из 10 красный (`/cp/panel-api-card.js` — 404).
- [ ] **Step 3: решения карточки** — diff к `panel-logic.js`:

```diff
diff --git a/control-plane/public/panel-logic.js b/control-plane/public/panel-logic.js
index 3160c32..081bcd6 100644
--- a/control-plane/public/panel-logic.js
+++ b/control-plane/public/panel-logic.js
@@ -222,6 +222,11 @@ export function attentionReasons(clinic, now = new Date()) {
     out.push('far behind on updates');
   }
 
+  // PUBLIC_LICENCE_V1 — the clinic's online-booking key changed (a new computer,
+  // a reinstall — or a copied install_token). Nothing happens until a human
+  // accepts it on the clinic's page, so the board must say so.
+  if (clinic.api_key_pending) out.push('new API key waiting');
+
   return out;
 }
 
@@ -281,3 +286,58 @@ export function formatRetiredAt(iso) {
   if (Number.isNaN(d.getTime())) return 'date unknown';
   return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
 }
+
+// --- PUBLIC_LICENCE_V1: the "Online booking / API" card ----------------------
+//
+// What partners (med24.uz, Symptex, the clinic's own site) get for this clinic,
+// in the owner's words. The code comes from the server (services/public-api.js
+// partnersSee — the same rule that builds the public server's feed).
+const PARTNERS_SEE = {
+  visible: { label: 'Partners see this clinic', tone: 'ok' },
+  off:     { label: 'Hidden from partners — online booking is switched off', tone: 'muted' },
+  no_key:  { label: "Hidden from partners — waiting for the clinic's API key", tone: 'warn' },
+  unpaid:  { label: 'Hidden from partners — they get "temporarily unavailable" (unpaid)', tone: 'danger' },
+  retired: { label: 'Hidden from partners — clinic retired', tone: 'danger' },
+};
+export function partnersSeeText(code) {
+  return PARTNERS_SEE[code] || { label: 'Unknown — reload the page', tone: 'danger' };
+}
+
+/** "46de4fe9…696a" — enough to read out on the phone and compare. */
+export function shortFp(fp) {
+  if (typeof fp !== 'string' || !fp) return '—';
+  return fp.length > 12 ? fp.slice(0, 8) + '…' + fp.slice(-4) : fp;
+}
+
+/** What the clinic's computer was last told, in one line. */
+export function licenceLine(licence) {
+  if (!licence || !licence.issued_at) return 'No licence issued with these settings yet — the clinic has not checked in since.';
+  const paid = licence.subscription === 'unpaid' ? 'unpaid' : 'paid';
+  const api = licence.api_sync_key ? `online booking on (key ${shortFp(licence.api_sync_key)})` : 'online booking off';
+  return `Clinic's licence, issued ${formatRetiredAt(licence.issued_at)} ${String(licence.issued_at).slice(11, 16)} UTC: ${paid}, ${api}.`;
+}
+
+// The partner-key shape, mirrored from public/js/shared/api-connections.js
+// KEY_RE (the panel is served from control-plane/public and cannot import it).
+// panel-public-api.test.js pins the two sources equal.
+export const PARTNER_KEY_RE = new RegExp('^em_live_[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789]{32}$');
+const HASH_RE = /^[0-9a-fA-F]{64}$/;
+
+/**
+ * What the owner pasted into "Block a partner key": the key itself (to be
+ * hashed HERE, in the browser — the key never travels to the server), its
+ * SHA-256, or neither.
+ * @returns {{kind:'key', value:string} | {kind:'hash', value:string} | {kind:'bad'}}
+ */
+export function revocationInput(text) {
+  const v = typeof text === 'string' ? text.trim() : '';
+  if (PARTNER_KEY_RE.test(v)) return { kind: 'key', value: v };
+  if (HASH_RE.test(v)) return { kind: 'hash', value: v.toLowerCase() };
+  return { kind: 'bad' };
+}
+
+/** SHA-256 hex of a string, in the browser (crypto.subtle) — the same digest as the clinic's keyHash(). */
+export async function sha256Hex(text) {
+  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
+  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
+}
```

вызовы — diff к `panel-api.js`:

```diff
diff --git a/control-plane/public/panel-api.js b/control-plane/public/panel-api.js
index 9e134a0..739cfc2 100644
--- a/control-plane/public/panel-api.js
+++ b/control-plane/public/panel-api.js
@@ -70,6 +70,12 @@ export const cp = {
   counters: () => request('GET', '/admin/counters'),
   setCollect: (id, names) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/collect`, { names }),
 
+  // PUBLIC_LICENCE_V1 — "Online booking / API" and key revocation (routes/admin-public-api.js)
+  setApi: (id, enabled) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/api`, { enabled }),
+  acceptSyncKey: (id, fingerprint) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/api/accept-key`, { fingerprint }),
+  addRevocation: (id, payload) => request('POST', `/admin/clinics/${encodeURIComponent(id)}/revocations`, payload),
+  removeRevocation: (id, rid) => request('DELETE', `/admin/clinics/${encodeURIComponent(id)}/revocations/${encodeURIComponent(rid)}`),
+
   requests: () => request('GET', '/admin/requests'),
   grantRequest: (id) => request('POST', `/admin/requests/${encodeURIComponent(id)}/grant`, {}),
 };
```

карточка:

**Файл `control-plane/public/panel-api-card.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — the "Online booking / API" card on a clinic's page.
//
//   • the switch — online booking on the public server api.easymed.uz for this
//     clinic (partners within a minute, the clinic's own exchange from its next
//     hourly check-in);
//   • what partners see right now, and what the clinic's licence last said;
//   • the clinic's API key: accepted, or a NEW one waiting (a new computer, a
//     reinstall — or someone with a copy of the clinic's token): accept only
//     after confirming with the clinic; block the current one if the computer
//     was stolen;
//   • emergency blocks of partner keys — works even while the clinic is
//     offline. The key is hashed HERE, in the browser (panel-logic.js
//     sha256Hex): only its SHA-256 goes to the server.
//
// Every decision is a pure function in panel-logic.js; this file paints and
// calls the API. Every dynamic value goes through esc().

import { cp, ApiError } from './panel-api.js';
import { esc, toast, fmtDateTime } from './panel-dom.js';
import { partnersSeeText, shortFp, licenceLine, revocationInput, sha256Hex } from './panel-logic.js';

/**
 * @param {HTMLElement} box   the card element (class "card")
 * @param {{id:string, api:object}} clinic  from GET /admin/clinics/:id — clinic.api is replaced after each change
 */
export function renderApiCard(box, clinic) {
  if (!box || !clinic.api) return;
  paint();

  function paint() {
    const api = clinic.api;
    const see = partnersSeeText(api.partners_see);
    const keyLine = api.sync_key
      ? `<span class="api-fp" title="${esc(api.sync_key)}">${esc(shortFp(api.sync_key))}</span> <span class="muted">accepted ${esc(fmtDateTime(api.sync_key_accepted_at))}</span>`
      : '<span class="muted">none accepted</span>';
    const pending = api.key_pending ? `
      <div class="legacy-note">New key from ${esc(fmtDateTime(api.sync_key_seen_at))}:
        <span class="api-fp" title="${esc(api.sync_key_seen)}">${esc(shortFp(api.sync_key_seen))}</span>.
        A new computer or a reinstall? Call the clinic before accepting — until then online booking keeps the old key.</div>
      <div class="form-actions"><button class="btn primary small" id="api-accept" type="button">Accept new key</button></div>` : '';
    const seenBlocked = api.seen_key_revoked
      ? '<div class="legacy-note">The key this clinic sends is blocked. Its exchange with the public server is refused.</div>' : '';
    const rows = api.revocations.map((r) => `
      <tr data-rid="${esc(String(r.id))}">
        <td>${r.kind === 'partner_key' ? 'Partner key' : 'Clinic API key'}</td>
        <td class="muted api-fp" title="${esc(r.value)}">${esc(shortFp(r.value))}</td>
        <td>${esc(r.note || '—')}</td>
        <td class="muted">${esc(fmtDateTime(r.created_at))} · ${esc(r.created_by || '—')}</td>
        <td><button class="btn small" type="button" data-unblock>Unblock</button></td>
      </tr>`).join('');
    box.innerHTML = `
      <h2>Online booking / API</h2>
      <div class="module-row">
        <span class="module-name">Online booking / API</span>
        <label class="switch"><input type="checkbox" id="api-switch" ${api.enabled ? 'checked' : ''} aria-label="Online booking / API"><span class="track"></span></label>
      </div>
      <div><span class="badge ${esc(see.tone)}">${esc(see.label)}</span></div>
      <div class="next-checkin-note">${esc(licenceLine(api.licence))}</div>

      <h3 class="stats-subhead">Clinic's API key</h3>
      <div class="form-actions">${keyLine}
        ${api.sync_key ? '<button class="btn danger small" id="api-block-sync" type="button">Block this key</button>' : ''}</div>
      ${pending}${seenBlocked}

      <h3 class="stats-subhead">Blocked keys</h3>
      ${rows ? `<div class="table-wrap"><table class="t"><thead><tr><th>Kind</th><th>Key</th><th>Why</th><th>Blocked</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="sub">Nothing blocked.</div>'}
      <div class="form-row" style="margin-top:12px">
        <label for="api-block-input">Block a partner key — paste the key (em_live_…) or its SHA-256</label>
        <input id="api-block-input" autocomplete="off" spellcheck="false">
      </div>
      <div class="form-row">
        <label for="api-block-note">Why (seen by your team only)</label>
        <input id="api-block-note" maxlength="200">
      </div>
      <div class="form-actions"><button class="btn danger" id="api-block-go" type="button">Block partner key</button></div>
      <div class="form-err" id="api-err"></div>
      <div class="next-checkin-note">Blocks reach the public server within a minute — even while the clinic is offline. The key itself never leaves this browser: only its SHA-256 is sent.</div>
    `;
    wire();
  }

  async function act(run, okNote) {
    const err = box.querySelector('#api-err');
    if (err) err.textContent = '';
    box.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    try {
      const res = await run();
      if (res && res.api) clinic.api = res.api;
      toast((res && res.note) || okNote, 'ok');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      toast(e.message || 'Could not save.', 'err');
    }
    paint();
  }

  function wire() {
    const sw = box.querySelector('#api-switch');
    sw.addEventListener('change', () => act(() => cp.setApi(clinic.id, sw.checked), 'Saved.'));

    const accept = box.querySelector('#api-accept');
    if (accept) {
      accept.addEventListener('click', () => {
        if (!confirm(`Accept the new key ${shortFp(clinic.api.sync_key_seen)} for "${clinic.name}"? Do this only after the clinic confirmed it moved to a new computer.`)) return;
        act(() => cp.acceptSyncKey(clinic.id, clinic.api.sync_key_seen), 'Accepted.');
      });
    }

    const blockSync = box.querySelector('#api-block-sync');
    if (blockSync) {
      blockSync.addEventListener('click', () => {
        if (!confirm(`Block the API key ${shortFp(clinic.api.sync_key)}? Partners stop seeing "${clinic.name}" within a minute; a new key from the clinic will need your approval.`)) return;
        act(() => cp.addRevocation(clinic.id, { kind: 'sync_key', value: clinic.api.sync_key, note: 'blocked from the panel' }), 'Blocked.');
      });
    }

    const input = box.querySelector('#api-block-input');
    box.querySelector('#api-block-go').addEventListener('click', async () => {
      const parsed = revocationInput(input.value);
      const note = box.querySelector('#api-block-note').value;
      if (parsed.kind === 'bad') {
        box.querySelector('#api-err').textContent = 'Paste the partner key (em_live_…) or its SHA-256 (64 characters 0-9, a-f).';
        return;
      }
      input.value = '';   // the key leaves the page now — never kept in the DOM
      const value = parsed.kind === 'key' ? await sha256Hex(parsed.value) : parsed.value;
      act(() => cp.addRevocation(clinic.id, { kind: 'partner_key', value, note }), 'Blocked.');
    });

    box.querySelectorAll('tr[data-rid] [data-unblock]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rid = btn.closest('tr').dataset.rid;
        if (!confirm('Unblock this key? It works again within a minute, if the clinic still has it switched on.')) return;
        act(() => cp.removeRevocation(clinic.id, rid), 'Unblocked.');
      });
    });
  }
}
```

место на странице клиники — diff:

```diff
diff --git a/control-plane/public/panel-clinic-detail.js b/control-plane/public/panel-clinic-detail.js
index 9ef23dd..e37c364 100644
--- a/control-plane/public/panel-clinic-detail.js
+++ b/control-plane/public/panel-clinic-detail.js
@@ -15,6 +15,7 @@ import {
   subscriptionBadge, subscriptionUntilPayload, codeGroups,
   counterCheckedState, statsRows, retireConfirmText,
 } from './panel-logic.js';
+import { renderApiCard } from './panel-api-card.js';   // PUBLIC_LICENCE_V1
 
 const FALLBACK_NOTE = "Changes apply at this clinic's next check-in — not instantly.";
 
@@ -102,6 +103,8 @@ export async function renderClinicDetail(root, clinicId) {
             <div class="form-err" id="dt-sub-err"></div>
           </div>
 
+          <div class="card" id="dt-api-card"></div>
+
           <div class="card">
             <h2>Retire</h2>
             ${clinic.active
@@ -135,12 +138,20 @@ export async function renderClinicDetail(root, clinicId) {
     paintModules();
     paintStats();
     paintCheckins();
+    renderApiCard(root.querySelector('#dt-api-card'), clinic);   // PUBLIC_LICENCE_V1
     wireSubscriptionForm();
     wireRetire();
     wireUnlock();
     wireStats();
   }
 
+  // PUBLIC_LICENCE_V1 — the server decides "what partners see" (payment, retire,
+  // switch, key); after a change elsewhere on this page, ask it again. A failed
+  // refresh keeps the old card — the next page load is correct anyway.
+  async function refreshApi() {
+    try { clinic.api = (await cp.clinic(clinic.id)).clinic.api; } catch { /* keep what we have */ }
+  }
+
   // --- modules ---------------------------------------------------------
 
   function paintModules() {
@@ -287,6 +298,7 @@ export async function renderClinicDetail(root, clinicId) {
         const res = await cp.setSubscription(clinic.id, payload);
         clinic.subscription = payload.subscription;
         clinic.subscription_until = payload.subscription_until;
+        await refreshApi();   // PUBLIC_LICENCE_V1 — "what partners see" follows the payment mark
         ok.textContent = res.note || 'Saved.';
         // The header badge is drawn from `clinic` at initial paint() time only —
         // repaint so it reflects the just-saved subscription immediately rather
@@ -317,6 +329,7 @@ export async function renderClinicDetail(root, clinicId) {
       try {
         const res = await cp.retire(clinic.id);
         clinic.active = false;
+        await refreshApi();   // PUBLIC_LICENCE_V1
         toast(res.note || 'Clinic retired.', 'ok');
         paint();
       } catch (e) {
```

стили — diff:

```diff
diff --git a/control-plane/public/panel.css b/control-plane/public/panel.css
index b8403c6..f955a4c 100644
--- a/control-plane/public/panel.css
+++ b/control-plane/public/panel.css
@@ -333,3 +333,13 @@ table.t td.num { text-align: right; font-variant-numeric: tabular-nums; }
                       border-radius: 8px; padding: 9px 12px; font-size: 13px; color: var(--ink);
                       font-family: ui-monospace, Menlo, Consolas, monospace; user-select: all;
                       overflow-wrap: break-word; }
+
+/* --- PUBLIC_LICENCE_V1: "Online booking / API" card ---------------------- */
+/* Two more badge tones; both pairs are ≥ 4.5:1 (amber-ink on attention-ring,
+   ink-2 on bg-3 — the same tokens the board and inputs already use). The
+   badge may wrap here: its sentence is longer than a status word. */
+.badge.warn  { background: var(--attention-ring); color: var(--amber-ink); white-space: normal; }
+.badge.muted { background: var(--bg-3); color: var(--ink-2); white-space: normal; }
+#dt-api-card .badge { white-space: normal; line-height: 1.4; }
+.api-fp { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
+#dt-api-card .muted { color: var(--ink-3); }
```

- [ ] **Step 4:** `node --check control-plane/public/panel-api-card.js`, `node --check control-plane/public/panel-clinic-detail.js`; `node --test control-plane/public/panel-public-api.test.js control-plane/public/panel-logic.test.js control-plane/server/panel.test.js <СТОРОЖА>` → **66 тестов** зелёные.
- [ ] **Step 5: коммит** «Панель, карточка «Online booking / API» на странице клиники: переключатель, что видят партнёры, что сказано лицензии клиники, ключ обмена — принят, новый ждёт подтверждения (звонок клинике до «Accept»), заблокировать; блокировки ключей партнёров — ключ превращается в SHA-256 в браузере и на сервер не уходит; доска — «new API key waiting»» — семь файлов.

---

## Task 8: Публичный сервер — ключ лицензий под стражем, настройки списка, порт 8096 (PUBLIC_LICENCE_V1)

Сборщик Б. Нужна задача 1.

**Files:**
- Create: `public-server/server/licence-key.js`, `public-server/server/licence-key.test.js`.
- Modify: `public-server/server/config.js` — `DEFAULT_PORT` 8096, `PUBLIC_ALLOW_FOREIGN_LICENCE_KEY`, `PUBLIC_FEED_URL`, `PUBLIC_FEED_TOKEN`, `PUBLIC_FEED_EVERY_SEC`; `config.test.js`.
- Modify: `public-server/server/index.js` — ключ только через `resolveLicenceKey` (не запускать — `node --check`).

- [ ] **Step 1: падающие тесты:**

**Файл `public-server/server/licence-key.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — страж ключа лицензий публичного сервера: по умолчанию —
// вшитый ключ производителя (настоящий, server/services/control/vendor-key.test.js);
// чужой — только с явным разрешением стенда; запуск идёт через эту проверку.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLicenceKey, keyFingerprint32 } from './licence-key.js';
import { vendorPublicKey } from '../../server/services/control/licence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pem = (key) => key.export({ format: 'pem', type: 'spki' });
const fileOf = (text) => () => text;

test('без PUBLIC_LICENCE_PUBLIC_KEY — вшитый ключ производителя', () => {
  const r = resolveLicenceKey({});
  assert.deepEqual(r, { key: null, source: 'compiled', fingerprint: keyFingerprint32(vendorPublicKey()) });
  assert.equal(r.fingerprint, '46de4fe9a62a7f1349bdd3658be1696a', 'настоящий ключ сервера лицензий (2026-08-22)');
});

test('файл с тем же ключом, что вшит, — тот же «вшитый»; чужой — отказ запуска с именем переменной; со стендовым разрешением — свой', () => {
  assert.equal(resolveLicenceKey({ path: '/etc/k.pem', readFile: fileOf(pem(vendorPublicKey())) }).source, 'compiled');
  const stand = crypto.generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => resolveLicenceKey({ path: '/etc/k.pem', readFile: fileOf(pem(stand)) }), /PUBLIC_LICENCE_PUBLIC_KEY.*PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1/s);
  const r = resolveLicenceKey({ path: '/etc/k.pem', allowForeign: true, readFile: fileOf(pem(stand)) });
  assert.deepEqual([r.source, r.fingerprint], ['override', keyFingerprint32(stand)]);
  assert.equal(r.key.asymmetricKeyType, 'ed25519');
});

test('не ключ, ключ не Ed25519, нет файла — отказ запуска с именем переменной', () => {
  const x = crypto.generateKeyPairSync('x25519').publicKey;
  for (const readFile of [fileOf('мусор'), fileOf(pem(x)), () => { throw Object.assign(new Error('нет'), { code: 'ENOENT' }); }]) {
    assert.throws(() => resolveLicenceKey({ path: '/etc/k.pem', allowForeign: true, readFile }), /PUBLIC_LICENCE_PUBLIC_KEY: не открытый ключ Ed25519/);
  }
});

test('запуск службы берёт ключ только через resolveLicenceKey — без своего createPublicKey в обход стража', () => {
  const src = fs.readFileSync(path.join(HERE, 'index.js'), 'utf8');
  assert.match(src, /resolveLicenceKey\(\{ path: cfg\.licenceKeyPath, allowForeign: cfg\.allowForeignLicenceKey \}\)/);
  assert.doesNotMatch(src, /createPublicKey/);
});
```

```diff
diff --git a/public-server/server/config.test.js b/public-server/server/config.test.js
index 2a76a1c..27103c1 100644
--- a/public-server/server/config.test.js
+++ b/public-server/server/config.test.js
@@ -7,9 +7,9 @@ import { readConfig, DEFAULT_UNCOLLECTED_MAX_HOURS, DEFAULT_SYNC_SKEW_MIN } from
 
 const ROOT = path.resolve('/srv/public-server');
 
-test('умолчания: слушает только 127.0.0.1:8095, за nginx (loopback), только https, Ташкент UTC+5', () => {
+test('умолчания: слушает только 127.0.0.1:8096 (8095 на машине — у сервера лицензий), за nginx (loopback), только https, Ташкент UTC+5', () => {
   const c = readConfig({}, { root: ROOT });
-  assert.equal(c.port, 8095);
+  assert.equal(c.port, 8096);
   assert.equal(c.bind, '127.0.0.1');
   assert.equal(c.dataDir, path.join(ROOT, 'data'));
   assert.equal(c.baseUrl, 'https://api.easymed.uz');
@@ -22,6 +22,11 @@ test('умолчания: слушает только 127.0.0.1:8095, за nginx
   assert.equal(c.metricsToken, '');
   assert.equal(c.webhooks, true);
   assert.equal(c.licenceKeyPath, '');
+  // PUBLIC_LICENCE_V1 — чужой ключ лицензий запрещён; список производителя — с сервера лицензий раз в минуту, без токена — не забирается.
+  assert.equal(c.allowForeignLicenceKey, false);
+  assert.equal(c.feedUrl, 'https://settings.easymed.uz/cp/v1/public-feed');
+  assert.equal(c.feedToken, '');
+  assert.equal(c.feedEveryMs, 60000);
 });
 
 test('переопределение переменными окружения', () => {
@@ -29,6 +34,8 @@ test('переопределение переменными окружения',
     PUBLIC_PORT: '9001', PUBLIC_BIND: '0.0.0.0', PUBLIC_DATA_DIR: '/var/lib/easymed-public', PUBLIC_BASE_URL: 'https://api.test/',
     PUBLIC_TRUST_PROXY: '0', PUBLIC_REQUIRE_HTTPS: '0', PUBLIC_TZ_OFFSET_MIN: '0', PUBLIC_SYNC_SKEW_MIN: '60', PUBLIC_UNCOLLECTED_MAX_HOURS: '48',
     PUBLIC_SELF_IPS: '45.77.242.169, 10.0.0.5', PUBLIC_METRICS_TOKEN: 'm', PUBLIC_WEBHOOKS: '0', PUBLIC_LICENCE_PUBLIC_KEY: '/etc/k.pem',
+    PUBLIC_ALLOW_FOREIGN_LICENCE_KEY: '1', PUBLIC_FEED_URL: 'http://127.0.0.1:8095/cp/v1/public-feed', PUBLIC_FEED_TOKEN: ' f-TESTONLY ',
+    PUBLIC_FEED_EVERY_SEC: '30',
   }, { root: ROOT });
   assert.equal(c.port, 9001);
   assert.equal(c.bind, '0.0.0.0');
@@ -43,6 +50,10 @@ test('переопределение переменными окружения',
   assert.equal(c.metricsToken, 'm');
   assert.equal(c.webhooks, false);
   assert.equal(c.licenceKeyPath, '/etc/k.pem');
+  assert.equal(c.allowForeignLicenceKey, true);
+  assert.equal(c.feedUrl, 'http://127.0.0.1:8095/cp/v1/public-feed');
+  assert.equal(c.feedToken, 'f-TESTONLY');
+  assert.equal(c.feedEveryMs, 30000);
 });
 
 test('неверное значение — отказ с именем переменной', () => {
@@ -50,6 +61,8 @@ test('неверное значение — отказ с именем пере
   assert.throws(() => readConfig({ PUBLIC_TZ_OFFSET_MIN: '5000' }, { root: ROOT }), /PUBLIC_TZ_OFFSET_MIN/);
   assert.throws(() => readConfig({ PUBLIC_BASE_URL: 'api.easymed.uz' }, { root: ROOT }), /PUBLIC_BASE_URL/);
   assert.throws(() => readConfig({ PUBLIC_UNCOLLECTED_MAX_HOURS: '0' }, { root: ROOT }), /PUBLIC_UNCOLLECTED_MAX_HOURS/);
+  assert.throws(() => readConfig({ PUBLIC_FEED_URL: 'settings.easymed.uz/cp/v1/public-feed' }, { root: ROOT }), /PUBLIC_FEED_URL/);
+  assert.throws(() => readConfig({ PUBLIC_FEED_EVERY_SEC: '5' }, { root: ROOT }), /PUBLIC_FEED_EVERY_SEC/);
 });
 
 test('сроки владельца и контролёра — именованные постоянные, одно место на каждый', () => {
```

- [ ] **Step 2:** `node --test public-server/server/licence-key.test.js public-server/server/config.test.js` →
  - `licence-key.test.js` — красный при загрузке (`ERR_MODULE_NOT_FOUND … licence-key.js`);
  - `config.test.js` — 3 из 4 красные (`8095 !== 8096`, нет `feedUrl`, нет отказа на `PUBLIC_FEED_URL`).
- [ ] **Step 3:** страж ключа:

**Файл `public-server/server/licence-key.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — КАКИМ КЛЮЧОМ ПУБЛИЧНЫЙ СЕРВЕР ПРОВЕРЯЕТ ЛИЦЕНЗИИ КЛИНИК И
// СПИСОК ПРОИЗВОДИТЕЛЯ.
//
// По умолчанию — ключом, вшитым в программу (server/services/control/licence.js).
// Сверено 2026-10-12: это НАСТОЯЩИЙ ключ сервера лицензий (с 2026-08-22, коммит
// 6cd66c5c; страж — server/services/control/vendor-key.test.js), и им подписана
// каждая настоящая лицензия. Заметка плана 8b «вшит ключ разработки» устарела.
//
// PUBLIC_LICENCE_PUBLIC_KEY (путь к PEM) — только для стенда. Чужой ключ здесь —
// это «кто держит его закрытую половину, тот любая клиника»: подпишет себе
// лицензию с отпечатком своего ключа обмена, пришлёт свой box_key и получит
// данные пациентов из новых онлайн-записей. Поэтому ключ, отличный от вшитого,
// принимается только вместе с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1, иначе служба
// не запускается. Тот же ключ, что вшит, — просто «вшитый».
import fs from 'node:fs';
import crypto from 'node:crypto';
import { vendorPublicKey } from '../../server/services/control/licence.js';

/** Отпечаток открытого ключа: первые 32 hex SHA-256 от DER (SPKI). */
export function keyFingerprint32(key) {
  return crypto.createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 32);
}

/**
 * @param {{path?:string, allowForeign?:boolean, readFile?:typeof fs.readFileSync}} [o]
 * @returns {{key: import('node:crypto').KeyObject|null, source:'compiled'|'override', fingerprint:string}}
 *   key null — вшитый ключ (verifyLicence и verifyFeed берут его сами)
 * @throws {Error} с именем переменной: файл — не открытый ключ Ed25519; чужой ключ без разрешения
 */
export function resolveLicenceKey({ path = '', allowForeign = false, readFile = fs.readFileSync } = {}) {
  const compiled = keyFingerprint32(vendorPublicKey());
  if (!path) return { key: null, source: 'compiled', fingerprint: compiled };
  let key;
  try { key = crypto.createPublicKey(readFile(path, 'utf8')); } catch { key = null; }
  if (!key || key.asymmetricKeyType !== 'ed25519') throw new Error('PUBLIC_LICENCE_PUBLIC_KEY: не открытый ключ Ed25519 (' + path + ')');
  const fingerprint = keyFingerprint32(key);
  if (fingerprint === compiled) return { key: null, source: 'compiled', fingerprint };
  if (!allowForeign) {
    throw new Error('PUBLIC_LICENCE_PUBLIC_KEY: ключ ' + fingerprint + ' — не ключ производителя (' + compiled + '). '
      + 'Чужим ключом служба проверяет лицензии только на стенде: PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1.');
  }
  return { key, source: 'override', fingerprint };
}
```

diff к `config.js`:

```diff
diff --git a/public-server/server/config.js b/public-server/server/config.js
index 5d6836f..4989b5b 100644
--- a/public-server/server/config.js
+++ b/public-server/server/config.js
@@ -21,6 +21,18 @@ export const DEFAULT_SYNC_SKEW_MIN = 15;
 /** Смещение времени ответов — Ташкент, UTC+5 (PUBLIC_TZ_OFFSET_MIN); документация называет его отсюда (API_DOCS_V1). */
 export const DEFAULT_TZ_OFFSET_MIN = 300;
 
+// PUBLIC_LICENCE_V1 (шаг 8c):
+//   • DEFAULT_PORT — 8096, не 8095: на 45.77.242.169 порт 8095 уже занят
+//     сервером лицензий (easymed-cp, docs/HANDOVER.md, «Panel»), и служба с
+//     прежним умолчанием не запустилась бы (EADDRINUSE);
+//   • список производителя (клиники, скрытые от партнёров, отозванные ключи) —
+//     GET <PUBLIC_FEED_URL> с токеном PUBLIC_FEED_TOKEN (= EASYMED_CP_FEED_TOKEN
+//     сервера лицензий), раз в PUBLIC_FEED_EVERY_SEC секунд. Нет токена — список
+//     не забирается (журнал службы говорит об этом при запуске).
+export const DEFAULT_PORT = 8096;
+export const DEFAULT_FEED_URL = 'https://settings.easymed.uz/cp/v1/public-feed';
+export const DEFAULT_FEED_EVERY_SEC = 60;
+
 function int(env, name, def, min, max) {
   const raw = env[name];
   if (raw == null || String(raw).trim() === '') return def;
@@ -38,14 +50,16 @@ function trustProxyOf(raw) {
 /**
  * @returns {{port:number, bind:string, dataDir:string, baseUrl:string, licenceKeyPath:string, trustProxy:(string|false),
  *   requireHttps:boolean, offsetMin:number, syncSkewMs:number, uncollectedMaxMs:number, selfIps:string[], metricsToken:string,
- *   webhooks:boolean}}
+ *   webhooks:boolean, allowForeignLicenceKey:boolean, feedUrl:string, feedToken:string, feedEveryMs:number}}
  */
 export function readConfig(env = process.env, { root = SERVICE_ROOT } = {}) {
   const dataRaw = String(env.PUBLIC_DATA_DIR || '').trim();
   const base = String(env.PUBLIC_BASE_URL || 'https://api.easymed.uz').trim().replace(/\/+$/, '');
   if (!/^https?:\/\/[^\s/]+$/.test(base)) throw new Error('PUBLIC_BASE_URL: ожидается адрес вида https://api.easymed.uz');
+  const feedUrl = String(env.PUBLIC_FEED_URL || DEFAULT_FEED_URL).trim();
+  if (!/^https?:\/\/[^\s/]+\/\S*$/.test(feedUrl)) throw new Error('PUBLIC_FEED_URL: ожидается адрес вида https://settings.easymed.uz/cp/v1/public-feed');
   return {
-    port: int(env, 'PUBLIC_PORT', 8095, 1, 65535),
+    port: int(env, 'PUBLIC_PORT', DEFAULT_PORT, 1, 65535),
     bind: String(env.PUBLIC_BIND || '127.0.0.1').trim(),
     dataDir: dataRaw ? path.resolve(root, dataRaw) : path.join(root, 'data'),
     baseUrl: base,
@@ -58,5 +72,10 @@ export function readConfig(env = process.env, { root = SERVICE_ROOT } = {}) {
     selfIps: String(env.PUBLIC_SELF_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
     metricsToken: String(env.PUBLIC_METRICS_TOKEN || '').trim(),
     webhooks: String(env.PUBLIC_WEBHOOKS ?? '1').trim() !== '0',
+    // PUBLIC_LICENCE_V1 — чужой ключ лицензий только на стенде (licence-key.js).
+    allowForeignLicenceKey: String(env.PUBLIC_ALLOW_FOREIGN_LICENCE_KEY || '').trim() === '1',
+    feedUrl,
+    feedToken: String(env.PUBLIC_FEED_TOKEN || '').trim(),
+    feedEveryMs: int(env, 'PUBLIC_FEED_EVERY_SEC', DEFAULT_FEED_EVERY_SEC, 10, 3600) * 1000,
   };
 }
```

diff к `index.js` (точным блобом, если в клоне его правит шаг 9):

```diff
diff --git a/public-server/server/index.js b/public-server/server/index.js
index 6734aa5..9fe0eb6 100644
--- a/public-server/server/index.js
+++ b/public-server/server/index.js
@@ -7,8 +7,8 @@
 // партнёра никогда не ждёт ни клинику, ни сеть — только свою базу.
 import fs from 'node:fs';
 import path from 'node:path';
-import { createPublicKey } from 'node:crypto';
 import { readConfig, SERVICE_ROOT } from './config.js';
+import { resolveLicenceKey } from './licence-key.js';
 import { openDb } from './db/connection.js';
 import { migrate } from './db/migrate.js';
 import { createPublicServer } from './app.js';
@@ -23,13 +23,14 @@ try { cfg = readConfig(); } catch (e) {
 const version = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8')).version;
 fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
 
-let licencePublicKey = null;
-if (cfg.licenceKeyPath) {
-  try { licencePublicKey = createPublicKey(fs.readFileSync(cfg.licenceKeyPath, 'utf8')); } catch {
-    console.error('Публичный сервер не запущен: PUBLIC_LICENCE_PUBLIC_KEY — не открытый ключ Ed25519 (' + cfg.licenceKeyPath + ')');
-    process.exit(1);
-  }
+// PUBLIC_LICENCE_V1 — ключ лицензий: вшитый ключ производителя, чужой — только
+// на стенде с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1 (licence-key.js).
+let licence;
+try { licence = resolveLicenceKey({ path: cfg.licenceKeyPath, allowForeign: cfg.allowForeignLicenceKey }); } catch (e) {
+  console.error('Публичный сервер не запущен: ' + e.message);
+  process.exit(1);
 }
+const licencePublicKey = licence.key;
 
 const db = openDb(path.join(cfg.dataDir, 'public.db'));
 migrate(db);
@@ -43,7 +44,8 @@ ctx.jobs = jobs;
 
 const server = app.listen(cfg.port, cfg.bind, () => {
   console.log('Easy-Med public server ' + version + ' is running on ' + cfg.bind + ':' + cfg.port + ' (data: ' + cfg.dataDir + ')');
-  if (!licencePublicKey) console.log('Licence key: the vendor key compiled into the app (server/services/control/licence.js).');
+  if (licence.source === 'compiled') console.log('Licence key: the production vendor key compiled into the app (' + licence.fingerprint + ').');
+  else console.warn('WARNING: licence key ' + licence.fingerprint + ' is NOT the production vendor key — a test stand only (PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1).');
 });
 server.requestTimeout = 20000;
 server.headersTimeout = 10000;
```

- [ ] **Step 4:** `node --check public-server/server/index.js`; `node --test public-server/server/licence-key.test.js public-server/server/config.test.js <СТОРОЖА>` → **15 тестов** зелёные.
- [ ] **Step 5: коммит** «Публичный сервер: лицензии проверяются вшитым ключом производителя (сверено — настоящий), чужой ключ — только на стенде с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1, иначе служба не запускается, журнал называет ключ; настройки списка производителя; порт по умолчанию 8096 — 8095 на машине занят сервером лицензий» — пять файлов.

---

## Task 9: Публичный сервер — список производителя: база, фон, `/_metrics` (PUBLIC_LICENCE_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/db/migrations/002_vendor_feed.sql`, `public-server/server/store/feed.js`, `public-server/server/test-helpers/feed-fixture.js`.
- Create: `public-server/server/store/feed.test.js`, `public-server/server/feed.app.test.js`.
- Modify: `public-server/server/db/schema.test.js` — новая таблица в списке колонок, вторая миграция.
- Modify: `public-server/server/app.js` (`ctx.feed`, `ctx.licenceKeySource`), `jobs.js` (такт списка), `routes/ops.js` (поля `/_metrics`), `index.js` (такт с токеном; без токена — строка в журнале).

- [ ] **Step 1: падающие тесты** — стенд и тесты:

**Файл `public-server/server/test-helpers/feed-fixture.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — стенд тестов: список производителя, подписанный тестовым
// «производителем» (пара из fixture.js testVendor) — так его подписывает сервер
// лицензий (control-plane/server/services/signing.js signFeed).
import crypto from 'node:crypto';
import { feedMessage, makeFeedPayload } from '../../../server/services/control/vendor-feed.js';

/** @returns {string} тело ответа GET /cp/v1/public-feed */
export function signTestFeed(vendor, { issuedAt, clinicsOff = [], syncKeysRevoked = [], partnerKeysRevoked = [] }) {
  const payload = makeFeedPayload({ issuedAt, clinicsOff, syncKeysRevoked, partnerKeysRevoked });
  return JSON.stringify({ payload, sig: crypto.sign(null, feedMessage(payload), vendor.privateKey).toString('base64') });
}
```

**Файл `public-server/server/store/feed.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — список производителя на публичном сервере: принимается
// только подписанный и не старше принятого; переживает перезапуск; сбой сети —
// прежний список; страж тестов не пускает на настоящий сервер лицензий.
import test from 'node:test';
import assert from 'node:assert/strict';
import { testDb, testVendor, NOW } from '../test-helpers/fixture.js';
import { signTestFeed } from '../test-helpers/feed-fixture.js';
import {
  emptyFeed, loadFeed, applyFeedText, pullFeed, feedBlocksClinic, feedRevokedPartnerKey, feedRevokedSyncKey, feedMetrics,
  assertFeedUrlIsTestSafe,
} from './feed.js';

const FP = 'ab'.repeat(16);
const HASH = 'cd'.repeat(32);
const at = (ms) => new Date(ms).toISOString();

test('принят подписанный: в памяти и в базе; старше принятого — outdated; тот же — без записи; чужая подпись — отказ, прежний остаётся', () => {
  const { db } = testDb();
  const vendor = testVendor();
  const h = emptyFeed();
  const doc = signTestFeed(vendor, { issuedAt: at(NOW), clinicsOff: ['c-000777'], syncKeysRevoked: [FP], partnerKeysRevoked: [HASH] });
  assert.deepEqual(applyFeedText(db, h, doc, { publicKey: vendor.publicKey, now: NOW }), { ok: true, changed: true });
  assert.deepEqual([h.issued_at, [...h.clinicsOff], [...h.syncKeysRevoked], [...h.partnerKeysRevoked], h.error], [at(NOW), ['c-000777'], [FP], [HASH], '']);
  assert.equal(db.prepare('SELECT issued_at FROM vendor_feed').get().issued_at, at(NOW));
  assert.deepEqual(applyFeedText(db, h, doc, { publicKey: vendor.publicKey, now: NOW + 1000 }), { ok: true, changed: false });
  const older = signTestFeed(vendor, { issuedAt: at(NOW - 60000) });
  assert.deepEqual(applyFeedText(db, h, older, { publicKey: vendor.publicKey, now: NOW }), { ok: false, error: 'outdated' });
  assert.equal(h.clinicsOff.has('c-000777'), true, 'повтор старого списка блокировку не снимает');
  const forged = signTestFeed(testVendor(), { issuedAt: at(NOW + 60000) });
  assert.deepEqual(applyFeedText(db, h, forged, { publicKey: vendor.publicKey, now: NOW }), { ok: false, error: 'bad_signature' });
  assert.deepEqual([h.issued_at, h.error], [at(NOW), 'bad_signature']);
  const newer = signTestFeed(vendor, { issuedAt: at(NOW + 60000) });
  assert.deepEqual(applyFeedText(db, h, newer, { publicKey: vendor.publicKey, now: NOW + 60000 }), { ok: true, changed: true });
  assert.deepEqual([h.clinicsOff.size, h.error], [0, ''], 'новый список снимает блокировки, которых в нём нет');
});

test('перезапуск: последний принятый — из базы, проверенный заново; испорченная строка — пустой список', () => {
  const { db } = testDb();
  const vendor = testVendor();
  applyFeedText(db, emptyFeed(), signTestFeed(vendor, { issuedAt: at(NOW), partnerKeysRevoked: [HASH] }), { publicKey: vendor.publicKey, now: NOW });
  const again = loadFeed(db, { publicKey: vendor.publicKey });
  assert.deepEqual([again.issued_at, [...again.partnerKeysRevoked]], [at(NOW), [HASH]]);
  db.prepare("UPDATE vendor_feed SET doc = replace(doc, 'cdcd', 'eeee')").run();
  const tampered = loadFeed(db, { publicKey: vendor.publicKey });
  assert.deepEqual([tampered.issued_at, tampered.partnerKeysRevoked.size, tampered.error], [null, 0, 'stored_bad_signature']);
  assert.equal(loadFeed(testDb().db, { publicKey: vendor.publicKey }).issued_at, null, 'пустая база — пустой список');
});

test('решения по списку: клиника скрыта по номеру или по отозванному ключу обмена; ключ партнёра — по отпечатку', () => {
  const h = emptyFeed();
  h.clinicsOff = new Set(['c-1']);
  h.syncKeysRevoked = new Set([FP]);
  h.partnerKeysRevoked = new Set([HASH]);
  assert.equal(feedBlocksClinic(h, { clinic_id: 'c-1', key_fp: 'x' }), true);
  assert.equal(feedBlocksClinic(h, { clinic_id: 'c-2', key_fp: FP }), true);
  assert.equal(feedBlocksClinic(h, { clinic_id: 'c-2', key_fp: 'x' }), false);
  assert.equal(feedBlocksClinic(null, { clinic_id: 'c-1' }), false, 'нет списка — ничего не скрыто');
  assert.equal(feedRevokedPartnerKey(h, HASH), true);
  assert.equal(feedRevokedPartnerKey(undefined, HASH), false);
  assert.equal(feedRevokedSyncKey(h, FP), true);
});

test('pullFeed: токен в заголовке, без перенаправлений; сбой сети, не 200, слишком большое — причина и прежний список', async () => {
  const { db } = testDb();
  const vendor = testVendor();
  const h = emptyFeed();
  const seen = [];
  const good = signTestFeed(vendor, { issuedAt: at(NOW), clinicsOff: ['c-9'] });
  const ok = async (url, opts) => { seen.push({ url, opts }); return new Response(good, { status: 200 }); };
  const r = await pullFeed(db, h, { url: 'https://cp.test/cp/v1/public-feed', token: 'f-TESTONLY', publicKey: vendor.publicKey, fetchImpl: ok, now: NOW });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.deepEqual([seen[0].url, seen[0].opts.method, seen[0].opts.headers.Authorization, seen[0].opts.redirect, seen[0].opts.body],
    ['https://cp.test/cp/v1/public-feed', 'GET', 'Bearer f-TESTONLY', 'error', undefined]);
  const cases = [
    [async () => { throw new TypeError('fetch failed'); }, 'unreachable'],
    [async () => new Response('{}', { status: 401 }), 'http_401'],
    [async () => new Response('x'.repeat(2_000_001), { status: 200 }), 'too_large'],
    [async () => new Response('не json', { status: 200 }), 'malformed'],
  ];
  for (const [fetchImpl, error] of cases) {
    assert.deepEqual(await pullFeed(db, h, { url: 'https://cp.test/f', token: 't', publicKey: vendor.publicKey, fetchImpl, now: NOW + 5000 }), { ok: false, error });
    assert.deepEqual([h.error, h.checked_at, [...h.clinicsOff]], [error, '2030-03-11T04:00:05Z', ['c-9']]);
  }
});

test('страж тестов: настоящий сервер лицензий из теста без подставного fetch — отказ; свой адрес или свой fetch — можно', () => {
  assert.throws(() => assertFeedUrlIsTestSafe('https://settings.easymed.uz/cp/v1/public-feed', globalThis.fetch), /refusing to reach the production control plane/);
  assert.throws(() => assertFeedUrlIsTestSafe('https://settings.easymed.uz/cp/v1/public-feed', undefined), /refusing/);
  assert.doesNotThrow(() => assertFeedUrlIsTestSafe('https://settings.easymed.uz/cp/v1/public-feed', async () => null));
  assert.doesNotThrow(() => assertFeedUrlIsTestSafe('http://127.0.0.1:9/cp/v1/public-feed', globalThis.fetch));
});

test('feedMetrics: только числа и время; возраст — от issued_at', () => {
  const h = emptyFeed();
  assert.deepEqual(feedMetrics(h, NOW), { feed_issued_at: null, feed_age_s: null, feed_checked_at: null, feed_error: '',
    feed_clinics_off: 0, feed_sync_keys_revoked: 0, feed_partner_keys_revoked: 0 });
  h.issued_at = at(NOW - 90000);
  h.clinicsOff = new Set(['a', 'b']);
  assert.deepEqual([feedMetrics(h, NOW).feed_age_s, feedMetrics(h, NOW).feed_clinics_off], [90, 2]);
});
```

**Файл `public-server/server/feed.app.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — фон забирает список производителя по HTTP (свой «сервер
// лицензий» на случайном порту), служба держит его после перезапуска, /_metrics
// показывает его свежесть и каким ключом проверяются лицензии.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPublicServer } from './app.js';
import { startJobs } from './jobs.js';
import { testDb, testVendor, NOW } from './test-helpers/fixture.js';
import { signTestFeed } from './test-helpers/feed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const TOKEN = 'f-TESTONLY-0123456789abcdef0123456789';

async function fakeControlPlane(vendor, body) {
  const app = express();
  const seen = [];
  app.get('/cp/v1/public-feed', (req, res) => {
    seen.push(req.get('authorization'));
    if (req.get('authorization') !== 'Bearer ' + TOKEN) return res.status(401).json({ error: { code: 'unauthorized' } });
    return res.type('application/json').send(body());
  });
  const server = await listen(app);
  return { url: 'http://127.0.0.1:' + server.address().port + '/cp/v1/public-feed', seen, close: () => new Promise((r) => server.close(r)) };
}

test('фон забирает список; /_metrics — свежесть и ключ; после перезапуска список тот же', async (t) => {
  const { db, dir } = testDb();
  const vendor = testVendor();
  let issued = NOW;
  const cp = await fakeControlPlane(vendor, () => signTestFeed(vendor, { issuedAt: new Date(issued).toISOString(), clinicsOff: ['c-000777'] }));
  t.after(cp.close);
  const s = createPublicServer({ db, dataDir: dir, now: () => NOW + 30000, licencePublicKey: vendor.publicKey, requireHttps: false,
    trustProxy: false, metricsToken: 'm-TESTONLY', licenceKeySource: 'override' });
  const jobs = startJobs({ db, dataDir: dir, now: () => NOW + 30000, send: async () => ({ status: 200 }), webhooks: false,
    maintainEveryMs: 3600000, feedEveryMs: 3600000, feed: { holder: s.ctx.feed, url: cp.url, token: TOKEN, publicKey: vendor.publicKey } });
  t.after(() => jobs.stop());
  s.ctx.jobs = jobs;
  assert.deepEqual(await jobs.feedTick(), { ok: true, changed: true });
  assert.deepEqual(cp.seen, ['Bearer ' + TOKEN]);
  assert.equal(s.ctx.feed.clinicsOff.has('c-000777'), true);
  const server = await listen(s.app);
  t.after(() => new Promise((r) => server.close(r)));
  const m = await (await fetch('http://127.0.0.1:' + server.address().port + '/_metrics', { headers: { Authorization: 'Bearer m-TESTONLY' } })).json();
  assert.deepEqual([m.feed_issued_at, m.feed_age_s, m.feed_clinics_off, m.feed_error, m.licence_key, m.jobs.feed],
    [new Date(NOW).toISOString(), 30, 1, '', 'override', true]);
  const again = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  assert.equal(again.ctx.feed.clinicsOff.has('c-000777'), true, 'перезапуск: последний принятый список — из базы');
  issued = NOW - 60000;
  assert.deepEqual(await jobs.feedTick(), { ok: false, error: 'outdated' });
});

test('неверный токен у сервера лицензий — причина http_401, партнёрам ничего не меняется', async (t) => {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const cp = await fakeControlPlane(vendor, () => signTestFeed(vendor, { issuedAt: new Date(NOW).toISOString() }));
  t.after(cp.close);
  const s = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  const jobs = startJobs({ db, dataDir: dir, now: () => NOW, send: async () => ({ status: 200 }), webhooks: false, maintainEveryMs: 3600000,
    feedEveryMs: 3600000, feed: { holder: s.ctx.feed, url: cp.url, token: 'wrong-TESTONLY', publicKey: vendor.publicKey } });
  t.after(() => jobs.stop());
  assert.deepEqual(await jobs.feedTick(), { ok: false, error: 'http_401' });
  assert.deepEqual([s.ctx.feed.issued_at, s.ctx.feed.error], [null, 'http_401']);
});
```

```diff
diff --git a/public-server/server/db/schema.test.js b/public-server/server/db/schema.test.js
index 01b8a25..c638115 100644
--- a/public-server/server/db/schema.test.js
+++ b/public-server/server/db/schema.test.js
@@ -23,6 +23,8 @@ const EXPECTED = {
   delivery_log: ['id', 'clinic_id', 'delivery_id', 'connection_id', 'request_id', 'event_id', 'event', 'attempt', 'code',
     'error', 'at', 'next_at', 'final'],
   access_log: ['id', 'clinic_id', 'connection_id', 'at', 'method', 'path', 'status', 'ip', 'ms'],
+  // PUBLIC_LICENCE_V1 — последний принятый список производителя (номера клиник и отпечатки ключей).
+  vendor_feed: ['id', 'issued_at', 'doc', 'received_at'],
   schema_migrations: ['name', 'applied_at'],
 };
 
@@ -30,7 +32,7 @@ test('миграции ложатся на пустую базу и повтор
   const db = openDb(':memory:');
   migrate(db);
   migrate(db);
-  assert.deepEqual(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name), ['001_public_server.sql']);
+  assert.deepEqual(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name), ['001_public_server.sql', '002_vendor_feed.sql']);
   assert.equal(db.pragma('secure_delete', { simple: true }), 1, 'стёртое затирается');
   db.close();
 });
```

- [ ] **Step 2:** `node --test public-server/server/store/feed.test.js public-server/server/feed.app.test.js public-server/server/db/schema.test.js` →
  - `feed.test.js` — красный при загрузке (`ERR_MODULE_NOT_FOUND … store/feed.js`);
  - `feed.app.test.js` — 2 из 2 красные: `TypeError: jobs.feedTick is not a function` (`feed-fixture.js` уже лежит — он берёт только `vendor-feed.js` задачи 1);
  - `schema.test.js` — 2 из 2 красные (нет `vendor_feed`, одна миграция).
- [ ] **Step 3:** миграция и хранилище:

**Файл `public-server/server/db/migrations/002_vendor_feed.sql`** (целиком):

```sql
-- PUBLIC_LICENCE_V1 — последний принятый список производителя (шаг 8c): клиники,
-- которых партнёры не видят, и отозванные ключи. Документ хранится целиком, с
-- подписью — при запуске он проверяется заново (store/feed.js loadFeed), так что
-- правка строки руками ничего не даёт. Одна строка. В документе — номера клиник
-- и отпечатки ключей, ни данных пациентов, ни самих ключей.
CREATE TABLE vendor_feed (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  issued_at   TEXT NOT NULL,
  doc         TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

**Файл `public-server/server/store/feed.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — СПИСОК ПРОИЗВОДИТЕЛЯ НА ПУБЛИЧНОМ СЕРВЕРЕ (шаг 8c).
//
// Лицензию несёт клиника — и только когда выходит на связь. Решение Easy-Med в
// панели (не оплачено, онлайн-запись выключена, ключ партнёра или ключ обмена
// клиники заблокирован) доходит сюда вторым путём, мимо клиники: служба сама
// забирает подписанный список с сервера лицензий (GET /cp/v1/public-feed, раз в
// PUBLIC_FEED_EVERY_SEC, jobs.js) и проверяет подпись тем же ключом
// производителя, что и лицензии (server/services/control/vendor-feed.js).
//
// ЧТО ОН ДЕЛАЕТ (routes/partner-auth.js, routes/sync.js):
//   • клиника в clinics_off или с отозванным ключом обмена — партнёрам 503
//     licence_lapsed «временно недоступна» (как при неоплате);
//   • ключ партнёра в partner_keys_revoked — 401 key_disabled, что бы ни
//     присылала клиника в PUT /keys;
//   • запрос клиники, подписанный отозванным ключом обмена, — 401
//     invalid_signature.
//
// ЕСЛИ СПИСКА НЕТ ИЛИ ОН СТАРЫЙ — держим последний хороший (и после перезапуска:
// он лежит в базе, vendor_feed, и проверяется заново). Сервер лицензий
// недоступен — партнёры этого не замечают (правило control-plane/README.md:
// день без сервера лицензий незаметен); его возраст видно в /_metrics
// (feed_age_s), наблюдение 8c поднимает тревогу. Список старше уже принятого
// не берётся (outdated): повтор перехваченного старого списка не снимет
// блокировку. Пустой список при первом запуске — ничего не блокирует.
import { verifyFeed, FEED_LIMITS } from '../../../server/services/control/vendor-feed.js';
import { isoOf, msOf } from '../lib/time.js';

export const FEED_TIMEOUT_MS = 10000;
export const PROD_FEED_HOST = 'settings.easymed.uz';

/** Пустой список: ничего не скрыто, ничего не отозвано. */
export function emptyFeed() {
  return {
    issued_at: null, received_at: null, checked_at: null, error: '',
    clinicsOff: new Set(), syncKeysRevoked: new Set(), partnerKeysRevoked: new Set(),
  };
}

function fill(holder, feed, receivedAt) {
  holder.issued_at = feed.issued_at;
  holder.received_at = receivedAt;
  holder.clinicsOff = new Set(feed.clinics_off);
  holder.syncKeysRevoked = new Set(feed.sync_keys_revoked);
  holder.partnerKeysRevoked = new Set(feed.partner_keys_revoked);
}

/** Последний принятый список из базы, проверенный заново; нет или испорчен — пустой. */
export function loadFeed(db, { publicKey = null } = {}) {
  const holder = emptyFeed();
  let row = null;
  try { row = db.prepare('SELECT doc, received_at FROM vendor_feed WHERE id = 1').get() || null; } catch { row = null; }
  if (!row) return holder;
  const v = verifyFeed(row.doc, { publicKey });
  if (v.ok) fill(holder, v.feed, row.received_at);
  else holder.error = 'stored_' + v.reason;
  return holder;
}

/**
 * Присланный текст: подпись производителя, вид, не старше принятого. Новее —
 * в базу и в память (holder меняется на месте: ctx.feed остаётся тем же объектом).
 * @returns {{ok:true, changed:boolean} | {ok:false, error:string}}
 */
export function applyFeedText(db, holder, text, { publicKey = null, now }) {
  holder.checked_at = isoOf(now);
  const v = verifyFeed(text, { publicKey });
  if (!v.ok) { holder.error = v.reason; return { ok: false, error: v.reason }; }
  const t = msOf(v.feed.issued_at);
  const cur = msOf(holder.issued_at);
  if (cur !== null && t < cur) { holder.error = 'outdated'; return { ok: false, error: 'outdated' }; }
  holder.error = '';
  if (cur !== null && t === cur) return { ok: true, changed: false };
  const at = isoOf(now);
  db.prepare('INSERT OR REPLACE INTO vendor_feed (id, issued_at, doc, received_at) VALUES (1, ?, ?, ?)').run(v.feed.issued_at, String(text), at);
  fill(holder, v.feed, at);
  return { ok: true, changed: true };
}

// Тот же страж, что у клиники (control/prod-guard.js, api/public-sync.js): тест,
// забывший подставить адрес или fetchImpl, не уходит на настоящий сервер лицензий.
export function assertFeedUrlIsTestSafe(url, fetchImpl) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  if (fetchImpl && fetchImpl !== globalThis.fetch) return;
  let host = '';
  try { host = new URL(String(url)).hostname; } catch { host = ''; }
  if (host === PROD_FEED_HOST) {
    throw new Error('refusing to reach the production control plane from inside a test process — pass a local feed URL or a fetchImpl');
  }
}

async function readCapped(res, maxBytes) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) { const t = await res.text(); return Buffer.byteLength(t, 'utf8') > maxBytes ? null : t; }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* бросаем ответ всё равно */ } return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Забрать список с сервера лицензий. Никогда не бросает (кроме стража тестов):
 * сбой — причина в holder.error, прежний список остаётся.
 * @param {{url:string, token:string, publicKey?:object|null, fetchImpl?:typeof fetch, now:number, timeoutMs?:number}} o
 */
export async function pullFeed(db, holder, { url, token, publicKey = null, fetchImpl = globalThis.fetch, now, timeoutMs = FEED_TIMEOUT_MS }) {
  assertFeedUrlIsTestSafe(url, fetchImpl);
  const fail = (error) => { holder.checked_at = isoOf(now); holder.error = error; return { ok: false, error }; };
  let res;
  try {
    // redirect: 'error' — токен не уходит туда, куда его не посылали.
    res = await fetchImpl(url, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch { return fail('unreachable'); }
  if (!res.ok) return fail('http_' + res.status);
  let text = null;
  try { text = await readCapped(res, FEED_LIMITS.bytes); } catch { return fail('unreachable'); }
  if (text === null) return fail('too_large');
  try { return applyFeedText(db, holder, text, { publicKey, now }); } catch { return fail('store_failed'); }
}

/** Клиника скрыта от партнёров списком: в clinics_off или её ключ обмена отозван. */
export function feedBlocksClinic(holder, clinic) {
  if (!holder || !clinic) return false;
  return holder.clinicsOff.has(clinic.clinic_id) || holder.syncKeysRevoked.has(clinic.key_fp);
}
export const feedRevokedPartnerKey = (holder, keyHash) => !!holder && holder.partnerKeysRevoked.has(keyHash);
export const feedRevokedSyncKey = (holder, fp) => !!holder && holder.syncKeysRevoked.has(fp);

/** Для /_metrics: только числа и время. */
export function feedMetrics(holder, now) {
  const h = holder || emptyFeed();
  const issued = msOf(h.issued_at);
  return {
    feed_issued_at: h.issued_at,
    feed_age_s: issued === null ? null : Math.max(0, Math.round((now - issued) / 1000)),
    feed_checked_at: h.checked_at,
    feed_error: h.error,
    feed_clinics_off: h.clinicsOff.size,
    feed_sync_keys_revoked: h.syncKeysRevoked.size,
    feed_partner_keys_revoked: h.partnerKeysRevoked.size,
  };
}
```

diff к `app.js` (точным блобом, если в клоне его правит шаг 9):

```diff
diff --git a/public-server/server/app.js b/public-server/server/app.js
index d2a3fbf..2e2f1c4 100644
--- a/public-server/server/app.js
+++ b/public-server/server/app.js
@@ -19,18 +19,22 @@ import { createLimiter } from './lib/rate-limit.js';
 import { errorHandler, sendError } from './lib/errors.js';
 import { DEFAULT_SKEW_MS } from './clinic-auth.js';
 import { floorInboxCursor, UNCOLLECTED_MAX_MS } from './store/requests.js';
+import { loadFeed } from './store/feed.js';
 
 /**
  * @param {{db, dataDir:string, now?:()=>number, licencePublicKey?:object|null, offsetMin?:number, baseUrl?:string,
  *   requireHttps?:boolean, trustProxy?:(string|boolean), skewMs?:number, metricsToken?:string, version?:string,
- *   limiter?:object, log?:Console, uncollectedMaxMs?:number}} o
+ *   limiter?:object, log?:Console, uncollectedMaxMs?:number, feed?:object, licenceKeySource?:('compiled'|'override')}} o
+ *   feed — список производителя (store/feed.js); по умолчанию — последний принятый из базы.
  * @returns {{app:import('express').Express, ctx:object}}
  */
 export function createPublicServer({ db, dataDir, now = () => Date.now(), licencePublicKey = null, offsetMin = 300,
   baseUrl = 'https://api.easymed.uz', requireHttps = true, trustProxy = 'loopback', skewMs = DEFAULT_SKEW_MS, metricsToken = '',
-  version = '0.0.0', limiter = createLimiter(), log = console, uncollectedMaxMs = UNCOLLECTED_MAX_MS }) {
+  version = '0.0.0', limiter = createLimiter(), log = console, uncollectedMaxMs = UNCOLLECTED_MAX_MS, feed = null, licenceKeySource = 'compiled' }) {
   // uncollectedMaxMs — срок не забранной заявки из настроек: документация называет его (API_DOCS_V1).
-  const ctx = { db, dataDir, now, licencePublicKey, offsetMin, baseUrl, requireHttps, skewMs, metricsToken, version, limiter, uncollectedMaxMs, jobs: null };
+  const ctx = { db, dataDir, now, licencePublicKey, offsetMin, baseUrl, requireHttps, skewMs, metricsToken, version, limiter, uncollectedMaxMs, jobs: null,
+    // PUBLIC_LICENCE_V1 — клиники, скрытые от партнёров, и отозванные ключи (store/feed.js).
+    feed: feed || loadFeed(db, { publicKey: licencePublicKey }), licenceKeySource };
   // Курсоры очереди не идут назад после восстановления базы (ревью 8b, C3).
   floorInboxCursor(db, now());
   const app = express();
```

diff к `jobs.js`:

```diff
diff --git a/public-server/server/jobs.js b/public-server/server/jobs.js
index bd11669..b51549a 100644
--- a/public-server/server/jobs.js
+++ b/public-server/server/jobs.js
@@ -1,5 +1,6 @@
-// PUBLIC_SERVER_V1 — ФОН: доставка уведомлений (каждые 5 секунд) и уборка
-// (каждую минуту). Таймеры unref, такт не перекрывает себя и никогда не
+// PUBLIC_SERVER_V1 — ФОН: доставка уведомлений (каждые 5 секунд), уборка
+// (каждую минуту) и — PUBLIC_LICENCE_V1 — список производителя с сервера
+// лицензий (раз в PUBLIC_FEED_EVERY_SEC). Таймеры unref, такт не перекрывает себя и никогда не
 // бросает наружу (по образцу опроса телефонии клиники): упавший такт пишет
 // в журнал тип ошибки и стек без сообщения и ждёт следующего.
 //
@@ -16,6 +17,7 @@ import { purgeDeliveries, deliverDue } from './store/deliveries.js';
 import { gcMedia } from './store/media.js';
 import { safeStack } from './lib/errors.js';
 import { isoOf } from './lib/time.js';
+import { pullFeed } from './store/feed.js';
 
 export function runMaintenance(db, dataDir, now, limiter = null, { uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
   const closed = closeOverdue(db, now, { uncollectedMaxMs });
@@ -31,12 +33,15 @@ export function runMaintenance(db, dataDir, now, limiter = null, { uncollectedMa
 
 /**
  * @param {{db, dataDir:string, now?:()=>number, send:(msg:object)=>Promise<{status:number, error?:string}>, webhooks?:boolean,
- *   limiter?:object, uncollectedMaxMs?:number, deliverEveryMs?:number, maintainEveryMs?:number, log?:Console}} o
+ *   limiter?:object, uncollectedMaxMs?:number, deliverEveryMs?:number, maintainEveryMs?:number, log?:Console,
+ *   feed?:{holder:object, url:string, token:string, publicKey?:object|null, fetchImpl?:typeof fetch}|null, feedEveryMs?:number}} o
+ *   feed — PUBLIC_LICENCE_V1: забирать список производителя (store/feed.js); null — не забирать.
  */
 export function startJobs({ db, dataDir, now = () => Date.now(), send, webhooks = true, limiter = null, uncollectedMaxMs = UNCOLLECTED_MAX_MS,
-  deliverEveryMs = 5000, maintainEveryMs = 60000, log = console }) {
-  const state = { deliveries_at: null, maintenance_at: null, last_error: '', last_error_at: null };
+  deliverEveryMs = 5000, maintainEveryMs = 60000, log = console, feed = null, feedEveryMs = 60000 }) {
+  const state = { deliveries_at: null, maintenance_at: null, feed_at: null, last_error: '', last_error_at: null };
   let delivering = false;
+  let pulling = false;
   const fail = (what, e) => {
     state.last_error = what;
     state.last_error_at = isoOf(now());
@@ -58,13 +63,29 @@ export function startJobs({ db, dataDir, now = () => Date.now(), send, webhooks
       return r;
     } catch (e) { fail('maintenance', e); return null; }
   }
+  // PUBLIC_LICENCE_V1 — список производителя: такт не перекрывает себя; сбой
+  // сети или подписи — причина в feed.holder.error, прежний список остаётся.
+  async function feedTick() {
+    if (!feed || pulling) return null;
+    pulling = true;
+    try {
+      const r = await pullFeed(db, feed.holder, { url: feed.url, token: feed.token, publicKey: feed.publicKey || null,
+        fetchImpl: feed.fetchImpl || globalThis.fetch, now: now() });
+      state.feed_at = isoOf(now());
+      return r;
+    } catch (e) { fail('feed', e); return null; } finally { pulling = false; }
+  }
   const timers = [];
   if (webhooks) timers.push(setInterval(() => { deliverTick(); }, deliverEveryMs));
   timers.push(setInterval(maintainTick, maintainEveryMs));
+  if (feed) {
+    timers.push(setTimeout(() => { feedTick(); }, 1000));   // первый — сразу после запуска
+    timers.push(setInterval(() => { feedTick(); }, feedEveryMs));
+  }
   for (const t of timers) if (t.unref) t.unref();
   return {
-    deliverTick, maintainTick,
-    status: () => ({ ...state, webhooks }),
+    deliverTick, maintainTick, feedTick,
+    status: () => ({ ...state, webhooks, feed: !!feed }),
     stop() { for (const t of timers) clearInterval(t); },
   };
 }
```

diff к `routes/ops.js`:

```diff
diff --git a/public-server/server/routes/ops.js b/public-server/server/routes/ops.js
index 6769568..91b5f07 100644
--- a/public-server/server/routes/ops.js
+++ b/public-server/server/routes/ops.js
@@ -8,6 +8,7 @@ import crypto from 'node:crypto';
 import express from 'express';
 import { sendError } from '../lib/errors.js';
 import { isoOf } from '../lib/time.js';
+import { feedMetrics } from '../store/feed.js';
 
 const sameToken = (a, b) => {
   const x = Buffer.from(String(a));
@@ -19,7 +20,7 @@ const sameToken = (a, b) => {
  * Числа для наблюдения. extra — счётчики процесса (ревью 8b, C6 и C8):
  * пропущенные уведомления (очередь клиники полна) и не записанные в журнал запросы.
  */
-export function metrics(db, now, jobs = null, { counters = null, accessJournal = null } = {}) {
+export function metrics(db, now, jobs = null, { counters = null, accessJournal = null, feed = null, licenceKeySource = 'compiled' } = {}) {
   const skipped = accessJournal ? accessJournal.stats() : {};
   const n = (sql, ...args) => db.prepare(sql).get(...args).n;
   const day = isoOf(now - 86400000);
@@ -42,6 +43,10 @@ export function metrics(db, now, jobs = null, { counters = null, accessJournal =
     access_skipped_over_key_day: skipped.over_key_day || 0,
     access_skipped_over_total: skipped.over_total || 0,
     access_skipped_over_clinic: skipped.over_clinic || 0,   // бюджет журнала клиники выбран (проверка исправлений 8b, F)
+    // PUBLIC_LICENCE_V1 — свежесть списка производителя (тревога наблюдения: feed_age_s > 600)
+    // и каким ключом проверяются лицензии ('compiled' — вшитым ключом производителя).
+    ...feedMetrics(feed, now),
+    licence_key: licenceKeySource,
     jobs: jobs ? jobs.status() : null,
   };
 }
@@ -57,7 +62,8 @@ export function opsRouter(ctx) {
     if (!ctx.metricsToken) return sendError(req, res, 'not_found');
     const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
     if (!m || !sameToken(m[1], ctx.metricsToken)) return sendError(req, res, 'invalid_key');
-    return res.json(metrics(ctx.db, ctx.now(), ctx.jobs || null, { counters: ctx.counters || null, accessJournal: ctx.accessJournal || null }));
+    return res.json(metrics(ctx.db, ctx.now(), ctx.jobs || null, { counters: ctx.counters || null, accessJournal: ctx.accessJournal || null,
+      feed: ctx.feed || null, licenceKeySource: ctx.licenceKeySource || 'compiled' }));
   });
   return r;
 }
```

diff к `index.js`:

```diff
diff --git a/public-server/server/index.js b/public-server/server/index.js
index 9fe0eb6..da164df 100644
--- a/public-server/server/index.js
+++ b/public-server/server/index.js
@@ -37,9 +37,14 @@ migrate(db);
 const { app, ctx } = createPublicServer({
   db, dataDir: cfg.dataDir, licencePublicKey, offsetMin: cfg.offsetMin, baseUrl: cfg.baseUrl, requireHttps: cfg.requireHttps,
   trustProxy: cfg.trustProxy, skewMs: cfg.syncSkewMs, metricsToken: cfg.metricsToken, version, uncollectedMaxMs: cfg.uncollectedMaxMs,
+  licenceKeySource: licence.source,
 });
+// PUBLIC_LICENCE_V1 — список производителя: без токена не забирается (и это
+// видно в журнале и в /_metrics: feed_issued_at пуст).
+const feed = cfg.feedToken ? { holder: ctx.feed, url: cfg.feedUrl, token: cfg.feedToken, publicKey: licencePublicKey } : null;
+if (!feed) console.warn('WARNING: PUBLIC_FEED_TOKEN is not set — unpaid clinics and revoked keys reach this server only through clinic licences.');
 const jobs = startJobs({ db, dataDir: cfg.dataDir, send: makeSender({ selfIps: cfg.selfIps }), webhooks: cfg.webhooks, limiter: ctx.limiter,
-  uncollectedMaxMs: cfg.uncollectedMaxMs });
+  uncollectedMaxMs: cfg.uncollectedMaxMs, feed, feedEveryMs: cfg.feedEveryMs });
 ctx.jobs = jobs;
 
 const server = app.listen(cfg.port, cfg.bind, () => {
```

- [ ] **Step 4:** `node --check public-server/server/index.js`; `node --test public-server/server/store/feed.test.js public-server/server/db/schema.test.js public-server/server/app.test.js public-server/server/feed.app.test.js <СТОРОЖА>` → **22 теста** зелёные (`app.test.js`: в `/_metrics` по-прежнему только числа и время).
- [ ] **Step 5: коммит** «Публичный сервер: список производителя — забирается фоном раз в минуту с токеном, принимается только подписанный ключом производителя и не старше принятого, переживает перезапуск в базе (проверяется заново), сбой сети или подписи — держим последний; /_metrics — его возраст, причина сбоя, размеры и каким ключом проверяются лицензии» — десять файлов.

---

## Task 10: Публичный сервер — список у входа партнёров и в канале клиники (PUBLIC_LICENCE_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/routes/feed-gate.http.test.js`.
- Modify: `public-server/server/routes/partner-auth.js` — 503 по списку, 401 `key_disabled` по отозванному ключу партнёра.
- Modify: `public-server/server/routes/sync.js` — 401 `invalid_signature` отозванному ключу обмена.

- [ ] **Step 1: падающий тест:**

**Файл `public-server/server/routes/feed-gate.http.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — список производителя у входа: клиника, скрытая списком, —
// партнёрам 503 «временно недоступна» с телефоном; отозванный ключ партнёра —
// 401 key_disabled; запрос клиники отозванным ключом обмена — 401; скрытая
// клиника сама по-прежнему говорит с сервером (события по принятым записям).
import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerStand } from '../test-helpers/partner-stand.js';
import { signTestFeed } from '../test-helpers/feed-fixture.js';
import { testDb, testVendor, testClinic, syncCall, NOW } from '../test-helpers/fixture.js';
import { createPublicServer } from '../app.js';
import { emptyFeed, applyFeedText } from '../store/feed.js';
import { keyHash } from '../../../server/services/api/secret-box.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { isoOf } from '../lib/time.js';

let tick = 0;
/** Подписанный список стенда, принятый в holder стенда (через проверку подписи). */
function feedFor(db, vendor, lists) {
  const h = emptyFeed();
  tick += 1;
  const r = applyFeedText(db, h, signTestFeed(vendor, { issuedAt: new Date(NOW + tick).toISOString(), ...lists }), { publicKey: vendor.publicKey, now: NOW });
  assert.equal(r.ok, true);
  return h;
}
const json = async (res) => ({ status: res.status, body: await res.json() });

test('партнёр: клиника в clinics_off или с отозванным ключом обмена — 503 с телефоном; ключ партнёра отозван — 401 key_disabled', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  assert.equal((await s.get('/shifo/v1/clinic')).status, 200);
  s.ctx.feed = feedFor(s.db, s.vendor, { clinicsOff: [s.clinicId] });
  const off = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([off.status, off.body.error.code, off.body.error.phone], [503, 'licence_lapsed', '+998712000000']);
  assert.equal(off.body.error.message, 'Клиника временно недоступна. Позвоните в клинику.', 'не «не оплатила»');
  s.ctx.feed = feedFor(s.db, s.vendor, { syncKeysRevoked: [s.clinic.identity.fingerprint] });
  assert.equal((await s.get('/shifo/v1/doctors')).status, 503);
  s.ctx.feed = feedFor(s.db, s.vendor, { partnerKeysRevoked: [keyHash(s.key)] });
  const revoked = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([revoked.status, revoked.body.error.code], [401, 'key_disabled']);
  assert.equal((await s.send('POST', '/shifo/v1/requests', { name: 'ТЕСТ', phone: '+998901234567' })).status, 401, 'и запись — тоже');
  s.ctx.feed = feedFor(s.db, s.vendor, { partnerKeysRevoked: ['ef'.repeat(32)], clinicsOff: ['c-000001'] });
  assert.equal((await s.get('/shifo/v1/clinic')).status, 200, 'чужие записи списка этой клинике не мешают');
});

test('канал клиники: отозванный ключ обмена — 401 invalid_signature; клиника, скрытая от партнёров, говорит с сервером как прежде', async (t) => {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const s = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  const server = await listen(s.app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const c = testClinic(vendor);
  const call = () => syncCall(base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) });
  assert.equal((await call()).status, 200);
  s.ctx.feed = feedFor(db, vendor, { clinicsOff: [c.clinicId] });
  assert.equal((await call()).status, 200, 'не оплачено / выключено — события по принятым записям доходят');
  s.ctx.feed = feedFor(db, vendor, { syncKeysRevoked: [c.identity.fingerprint] });
  const r = await call();
  assert.deepEqual([r.status, r.json.error.code], [401, 'invalid_signature']);
  const other = testClinic(vendor, { clinicId: 'c-000778' });
  assert.equal((await syncCall(base, other, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) })).status, 200, 'другие клиники — как прежде');
});
```

- [ ] **Step 2:** `node --test public-server/server/routes/feed-gate.http.test.js` → 2 из 2 красные (`TypeError: Cannot read properties of undefined (reading 'code')` — партнёр получает 200 вместо ошибки).
- [ ] **Step 3:** diff к `partner-auth.js`:

```diff
diff --git a/public-server/server/routes/partner-auth.js b/public-server/server/routes/partner-auth.js
index 21ba66c..a804e8e 100644
--- a/public-server/server/routes/partner-auth.js
+++ b/public-server/server/routes/partner-auth.js
@@ -31,6 +31,7 @@ import { resolveSlug, connectionByHash, originAllowedForClinic, markUsed, snapsh
 import { recordAccess } from '../store/logs.js';
 import { createAccessJournal } from '../store/access-journal.js';
 import { licenceStanding } from '../licence-gate.js';
+import { feedBlocksClinic, feedRevokedPartnerKey } from '../store/feed.js';
 import { ipAllowed, clientIp } from '../lib/net-guard.js';
 import { sendError } from '../lib/errors.js';
 import { isoOf, msOf } from '../lib/time.js';
@@ -133,7 +134,12 @@ export function clinicGate(ctx) {
       });
     }
     if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
-    if (licenceStanding(clinic, now) !== 'active') return sendError(req, res, 'licence_lapsed', { phone: phoneOf(clinic) });
+    // PUBLIC_LICENCE_V1 — и по списку производителя (store/feed.js): не оплачено,
+    // выключено, снята, ключ обмена отозван — даже если клиника без связи и
+    // предъявила бы старую лицензию. Ответ тот же: «временно недоступна».
+    if (licenceStanding(clinic, now) !== 'active' || feedBlocksClinic(ctx.feed, clinic)) {
+      return sendError(req, res, 'licence_lapsed', { phone: phoneOf(clinic) });
+    }
     if (now - (msOf(clinic.last_seen_at) || 0) > CLINIC_SILENT_MAX_MS) return sendError(req, res, 'clinic_offline', { phone: phoneOf(clinic) });
     return next();
   };
@@ -168,7 +174,9 @@ export function requireKey(ctx) {
       return sendError(req, res, 'invalid_key');
     }
     req.conn = conn;
-    if (!conn.active) return sendError(req, res, 'key_disabled');
+    // PUBLIC_LICENCE_V1 — срочный отзыв из панели производителя (store/feed.js):
+    // ключ выключен, что бы ни присылала клиника в PUT /keys.
+    if (!conn.active || feedRevokedPartnerKey(ctx.feed, conn.key_hash)) return sendError(req, res, 'key_disabled');
     if (conn.key_expires_at && (msOf(conn.key_expires_at) || 0) <= now) return sendError(req, res, 'key_expired');
     if (!ipAllowed(conn.ip_allow, req.ipAddr)) return sendError(req, res, 'ip_not_allowed');
     const origin = req.get('origin');
```

diff к `sync.js`:

```diff
diff --git a/public-server/server/routes/sync.js b/public-server/server/routes/sync.js
index 41a034c..dfd5501 100644
--- a/public-server/server/routes/sync.js
+++ b/public-server/server/routes/sync.js
@@ -37,6 +37,7 @@ import { admitClinic, admissionOf, saveKeys, saveSnapshot, saveSlots, parseBound
 import { missingMedia, putMedia, MEDIA_MAX_BYTES } from '../store/media.js';
 import { inboxItems, ackInbox, applyEvents } from '../store/requests.js';
 import { accessSince, deliveryLogSince } from '../store/logs.js';
+import { feedRevokedSyncKey } from '../store/feed.js';
 import { sendError } from '../lib/errors.js';
 
 export const SYNC_LIMIT_PER_MIN = 600;
@@ -67,6 +68,9 @@ export function syncRouter(ctx) {
     const now = ctx.now();
     const auth = verifyClinicHeaders({ headers: req.headers }, { licencePublicKey: ctx.licencePublicKey || null, now, skewMs: ctx.skewMs });
     if (!auth.ok) return sendError(req, res, auth.code, auth.server_time ? { server_time: auth.server_time } : {});
+    // PUBLIC_LICENCE_V1 — ключ обмена отозван в панели производителя (ПК украден):
+    // лицензия с его отпечатком ещё жива, но говорить за клинику он больше не может.
+    if (feedRevokedSyncKey(ctx.feed, auth.fingerprint)) return sendError(req, res, 'invalid_signature');
     const pre = admissionOf(ctx.db, auth);
     if (!pre.ok) return sendError(req, res, pre.code);
     if (licenceStanding(pre.licence, now) === 'lapsed') return sendError(req, res, 'licence_lapsed');
```

- [ ] **Step 4:** `node --test public-server/server/routes/feed-gate.http.test.js public-server/server/routes/partner-read.http.test.js public-server/server/routes/partner-write.http.test.js public-server/server/routes/sync.http.test.js <СТОРОЖА>` → **38 тестов** зелёные.
- [ ] **Step 5: коммит** «Публичный сервер у входа: клиника из списка производителя или с отозванным ключом обмена — партнёрам «временно недоступна» с телефоном, ключ партнёра из списка — key_disabled, что бы ни присылала клиника, запрос клиники отозванным ключом обмена — invalid_signature; скрытая клиника по-прежнему говорит с сервером» — три файла.

---

## Task 11: Сквозной прогон трёх служб, `DEPLOY.md` (PUBLIC_LICENCE_V1)

Сборщик Б. Нужны задачи 6 и 10.

**Files:**
- Create: `public-server/server/e2e.licence.test.js` — настоящий сервер лицензий (приложение и панель по HTTP), настоящая клиника (сверка и обмен 8a), настоящий публичный сервер.
- Modify: `public-server/DEPLOY.md` — порт 8096, список производителя (обе службы), проверки после установки, наблюдение, включение клиники.

- [ ] **Step 1: сквозной тест:**

**Файл `public-server/server/e2e.licence.test.js`** (целиком):

```js
// PUBLIC_LICENCE_V1 — СКВОЗНОЙ ПРОГОН ТРЁХ СЛУЖБ ЧЕРЕЗ ГРАНИЦЫ КАТАЛОГОВ: НАСТОЯЩИЙ
// СЕРВЕР ЛИЦЕНЗИЙ (control-plane/, приложение целиком на случайном порту, панель
// по HTTP) ↔ НАСТОЯЩАЯ КЛИНИКА (сверка server/services/control/checkin.js и обмен
// 8a public-sync.js) ↔ НАСТОЯЩИЙ ПУБЛИЧНЫЙ СЕРВЕР (public-server/, список
// производителя store/feed.js). Подпись — одноразовым ключом «производителя»:
// сервер лицензий подписывает (EASYMED_SIGNING_KEY), клиника и публичный сервер
// проверяют его открытой половиной. Часы — настоящие (лицензию подписывает
// настоящее время). Ни интернета, ни настоящих портов.
//
// Сценарий: обмен молчит, пока Easy-Med не включил онлайн-запись → включили — в
// лицензии отпечаток ключа клиники, партнёр видит клинику → срочный отзыв ключа
// партнёра и снятие → «не оплачено»: партнёрам 503 по списку, ещё до сверки, и
// по лицензии, даже без списка; срок клиники не продлён → оплатили → новый ПК:
// новый ключ ждёт подтверждения, принят → ключ обмена отозван: канал закрыт,
// партнёрам 503. На сервере лицензий — ни ключа партнёра, ни открытой половины
// ключа клиники, только отпечатки.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed } from '../../server/test-helpers/api-booking-seed.js';
import { tmpDir } from '../../server/test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../../server/services/api/sync-identity.js';
import { syncOnce } from '../../server/services/api/public-sync.js';
import { runCheckin, __setPublicKeyForTests as checkinKey } from '../../server/services/control/checkin.js';
import { controlState, __setPublicKeyForTests as stateKey } from '../../server/services/control/state.js';
import { keyHash } from '../../server/services/api/secret-box.js';
import { openDb as openCpDb } from '../../control-plane/server/db/connection.js';
import { migrate as migrateCp } from '../../control-plane/server/db/migrate.js';
import { createApp as createControlPlane } from '../../control-plane/server/app.js';
import { createEnrollmentCode, redeemEnrollmentCode } from '../../control-plane/server/services/enrollment.js';
import { signLicence } from '../../control-plane/server/services/signing.js';
import { hashPassword } from '../../control-plane/server/services/vendor-auth.js';
import { createPublicServer } from './app.js';
import { emptyFeed, pullFeed } from './store/feed.js';
import { testDb } from './test-helpers/fixture.js';

process.env.LIS_ENABLED = '0';
const FEED_TOKEN = 'TESTONLY-feed-token-0123456789abcdef';

test('сервер лицензий ↔ клиника ↔ публичный сервер: переключатель, отзыв ключей, «не оплачено», новый ПК — по подписанной лицензии и списку производителя', async (t) => {
  // ── «производитель»: одноразовая пара; закрытая — серверу лицензий, открытая — клинике и публичному серверу ──
  const vendor = crypto.generateKeyPairSync('ed25519');
  const keyDir = tmpDir('em-8c-vendor-');
  const keyFile = path.join(keyDir, 'vendor-private.pem');
  fs.writeFileSync(keyFile, vendor.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  process.env.EASYMED_SIGNING_KEY = keyFile;
  checkinKey(vendor.publicKey);
  stateKey(vendor.publicKey);
  t.after(() => { delete process.env.EASYMED_SIGNING_KEY; checkinKey(null); stateKey(null); });

  // ── сервер лицензий: реестр, продавец, клиника зачислена ──
  const cp = openCpDb(':memory:');
  migrateCp(cp);
  cp.prepare('INSERT INTO vendor_users (username, password_hash, full_name) VALUES (?,?,?)').run('vendor', hashPassword('secret123'), 'Vendor');
  const enrolled = redeemEnrollmentCode(cp, { code: createEnrollmentCode(cp, { clinicId: 'c-000777', name: 'Шифо' }) },
    { beforeCommit: ({ clinicId, clinicName, modules }) => signLicence({ clinicId, clinicName, modules }) });
  process.env.EASYMED_CP_FEED_TOKEN = FEED_TOKEN;
  const cpApp = createControlPlane(cp);
  delete process.env.EASYMED_CP_FEED_TOKEN;
  const cpServer = await listen(cpApp);
  t.after(() => new Promise((r) => cpServer.close(r)));
  const cpBase = 'http://127.0.0.1:' + cpServer.address().port;
  const login = await fetch(cpBase + '/cp/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vendor', password: 'secret123' }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const panel = async (method, p, body) => {
    const res = await fetch(cpBase + '/cp/v1/admin' + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  // ── клиника: стенд онлайн-записи 8a, файлы сверки на «диске клиники» ──
  const s = bookingSeed();
  const dataDir = tmpDir('em-8c-clinic-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777', install_token: enrolled.install_token, subscription: 'active' }));
  fs.writeFileSync(path.join(dataDir, 'licence.dat'), JSON.stringify(enrolled.licence));
  const licence = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'licence.dat'), 'utf8')).payload;
  const checkin = () => runCheckin(s.db, dataDir, { endpoint: cpBase });

  // ── публичный сервер ──
  const pub = testDb();
  const ps = createPublicServer({ db: pub.db, dataDir: pub.dir, licencePublicKey: vendor.publicKey, requireHttps: false, trustProxy: false });
  const pubServer = await listen(ps.app);
  t.after(() => new Promise((r) => pubServer.close(r)));
  const pubBase = 'http://127.0.0.1:' + pubServer.address().port;
  const sync = () => syncOnce(s.db, dataDir, { fetchImpl: globalThis.fetch, env: { EASYMED_PUBLIC_URL: pubBase }, keyPath, kekPath: s.kekPath,
    storageDir: path.join(dataDir, 'storage') });
  const pull = () => pullFeed(pub.db, ps.ctx.feed, { url: cpBase + '/cp/v1/public-feed', token: FEED_TOKEN, publicKey: vendor.publicKey, now: Date.now() });
  const partner = async (p) => {
    const res = await fetch(pubBase + p, { headers: { Authorization: 'Bearer ' + s.key } });
    return { status: res.status, body: await res.json() };
  };

  // 1. Онлайн-запись не включена: ключ клиники создан и уходит со сверкой, но лицензия без отпечатка — обмен молчит.
  assert.deepEqual(await sync(), { ok: false, reason: 'not_enabled' });
  const identity = loadSyncIdentity({ keyPath });
  await checkin();
  assert.equal('api_sync_key' in licence(), false);
  assert.equal(licence().subscription, 'active', 'подписанная отметка оплаты — с первой сверки после 8c');
  assert.equal((await panel('GET', '/clinics/c-000777')).body.clinic.api.sync_key, identity.fingerprint, 'первый ключ принят сам');
  assert.deepEqual(await sync(), { ok: false, reason: 'not_enabled' });

  // 2. Включили в панели: со сверкой — отпечаток в лицензии, обмен пошёл, партнёр видит клинику.
  assert.equal((await panel('POST', '/clinics/c-000777/api', { enabled: true })).status, 200);
  await checkin();
  assert.equal(licence().api_sync_key, identity.fingerprint);
  assert.equal((await sync()).ok, true);
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);
  assert.deepEqual(await pull(), { ok: true, changed: true });
  assert.equal((await partner('/shifo/v1/clinic')).status, 200, 'видимая клиника не в clinics_off');

  // 3. Срочный отзыв ключа партнёра (панель шлёт SHA-256) — через минуту у публичного сервера; снятие — так же.
  const blocked = await panel('POST', '/clinics/c-000777/revocations', { kind: 'partner_key', value: keyHash(s.key), note: 'ключ утёк' });
  assert.equal(blocked.status, 201);
  await pull();
  assert.deepEqual([(await partner('/shifo/v1/clinic')).body.error.code], ['key_disabled']);
  assert.equal((await panel('DELETE', '/clinics/c-000777/revocations/' + blocked.body.id)).status, 200);
  await pull();
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);

  // 4. «Не оплачено» (решение 17): партнёрам 503 по списку — ещё до сверки клиники.
  const paidUntil = licence().valid_until;
  assert.equal((await panel('POST', '/clinics/c-000777/subscription', { subscription: 'unpaid', subscription_until: null })).status, 200);
  await pull();
  const unpaid = await partner('/shifo/v1/clinic');
  assert.deepEqual([unpaid.status, unpaid.body.error.code], [503, 'licence_lapsed']);
  //    Сверка: подписанное «unpaid», срок прежний, отпечаток на месте; обмен клиники открыт.
  await checkin();
  assert.deepEqual([licence().subscription, licence().valid_until, licence().api_sync_key], ['unpaid', paidUntil, identity.fingerprint]);
  assert.equal((await sync()).ok, true, 'канал клиники открыт: события по принятым записям дойдут');
  //    Публичный сервер без списка (сервер лицензий недоступен с запуска) — 503 всё равно, по лицензии.
  ps.ctx.feed = emptyFeed();
  assert.equal((await partner('/shifo/v1/clinic')).status, 503);
  //    Сама клиника работает до конца оплаченного срока и запирается в тот же день, что и раньше.
  assert.equal(controlState(s.db, dataDir).locked, false);
  assert.equal(controlState(s.db, dataDir, new Date(Date.parse(paidUntil) + 1000)).locked, true);

  // 5. Оплатили: сверка — снова «active» на 14 дней; партнёр снова видит клинику.
  await panel('POST', '/clinics/c-000777/subscription', { subscription: 'active', subscription_until: null });
  await checkin();
  assert.equal(licence().subscription, 'active');
  await sync();
  await pull();
  assert.equal((await partner('/shifo/v1/clinic')).status, 200);

  // 6. Новый ПК (папка данных без файла ключа): новый ключ ждёт подтверждения, лицензия несёт прежний — обмен молчит.
  fs.rmSync(keyPath);
  fs.rmSync(keyPath + '.bak');
  assert.deepEqual(await sync(), { ok: false, reason: 'not_enabled' });
  const fresh = loadSyncIdentity({ keyPath });
  await checkin();
  assert.equal(licence().api_sync_key, identity.fingerprint);
  const pending = (await panel('GET', '/clinics/c-000777')).body.clinic.api;
  assert.deepEqual([pending.key_pending, pending.sync_key_seen], [true, fresh.fingerprint]);
  assert.equal((await panel('GET', '/clinics')).body.clinics[0].api_key_pending, true);
  assert.equal((await panel('POST', '/clinics/c-000777/api/accept-key', { fingerprint: fresh.fingerprint })).status, 200);
  await checkin();
  assert.equal(licence().api_sync_key, fresh.fingerprint);
  assert.equal((await sync()).ok, true);
  assert.equal(pub.db.prepare('SELECT key_fp FROM clinics').get().key_fp, fresh.fingerprint, 'публичный сервер узнал новый ключ из новой лицензии');

  // 7. Ключ обмена отозван (ПК украден): канал отвечает 401, партнёры — 503, следующая лицензия — без отпечатка.
  assert.equal((await panel('POST', '/clinics/c-000777/revocations', { kind: 'sync_key', value: fresh.fingerprint })).status, 201);
  await pull();
  assert.deepEqual(await sync(), { ok: false, reason: 'unauthorized' });
  assert.equal((await partner('/shifo/v1/clinic')).status, 503);
  await checkin();
  assert.equal('api_sync_key' in licence(), false);

  // 8. На сервере лицензий — только отпечатки: ни ключа партнёра, ни открытой половины ключа клиники.
  const dump = ['clinics', 'checkins', 'revocations'].map((tbl) => JSON.stringify(cp.prepare('SELECT * FROM ' + tbl).all())).join('\n');
  for (const secret of [s.key, s.secret, identity.signPublic, fresh.signPublic]) assert.ok(!dump.includes(secret));
  assert.ok(dump.includes(keyHash(s.key)) && dump.includes(fresh.fingerprint));
});
```

- [ ] **Step 2:** `LIS_ENABLED=0 node --test public-server/server/e2e.licence.test.js public-server/server/e2e.clinic.test.js <СТОРОЖА>` → **10 тестов** зелёные (и с `force-en.mjs`). Это проверка собранного, а не красный шаг: по отдельности каждая часть уже прошла свой красный тест. Проверка, что тест ловит поломки, — «Проверки плана», 14 поломок.
- [ ] **Step 3: установка** — diff к `DEPLOY.md` (точным блобом, если в клоне его правит шаг 9 — он добавляет туда `/docs`):

````diff
diff --git a/public-server/DEPLOY.md b/public-server/DEPLOY.md
index 6cb5b3b..cb38644 100644
--- a/public-server/DEPLOY.md
+++ b/public-server/DEPLOY.md
@@ -47,7 +47,8 @@ sudoedit /etc/easymed-public.env    # вставить строки ниже
 ```
 
 ```ini
-PUBLIC_PORT=8095
+# 8096: порт 8095 на этой машине — у сервера лицензий (easymed-cp, docs/HANDOVER.md)
+PUBLIC_PORT=8096
 PUBLIC_BIND=127.0.0.1
 PUBLIC_DATA_DIR=/var/lib/easymed-public
 PUBLIC_BASE_URL=https://api.easymed.uz
@@ -63,8 +64,26 @@ PUBLIC_SELF_IPS=45.77.242.169
 # токен для /_metrics (пусто — адреса нет)
 PUBLIC_METRICS_TOKEN=
 PUBLIC_WEBHOOKS=1
-# пусто — открытый ключ производителя, вшитый в программу (server/services/control/licence.js)
+# пусто — открытый ключ производителя, вшитый в программу (server/services/control/licence.js) —
+# НАСТОЯЩИЙ ключ сервера лицензий (8c сверил: 46de4fe9…696a). Другой ключ служба примет только
+# вместе с PUBLIC_ALLOW_FOREIGN_LICENCE_KEY=1 — это стенд, не api.easymed.uz (licence-key.js)
 PUBLIC_LICENCE_PUBLIC_KEY=
+# список производителя (не оплачено, выключено, отозванные ключи) — PUBLIC_LICENCE_V1, шаг 8c.
+# Сервер лицензий на этой же машине (easymed-cp, 127.0.0.1:8095) — берём напрямую, без DNS и TLS.
+PUBLIC_FEED_URL=http://127.0.0.1:8095/cp/v1/public-feed
+# тот же токен, что EASYMED_CP_FEED_TOKEN у easymed-cp (не короче 32 знаков: openssl rand -hex 24)
+PUBLIC_FEED_TOKEN=
+PUBLIC_FEED_EVERY_SEC=60
+```
+
+На сервере лицензий (`easymed-cp`) — та же строка токена в его окружении, затем перезапуск:
+
+```bash
+sudo systemctl edit easymed-cp     # [Service] Environment=EASYMED_CP_FEED_TOKEN=<тот же токен>
+sudo systemctl restart easymed-cp
+curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8095/cp/v1/public-feed                                   # 401
+curl -s -H "Authorization: Bearer <токен>" http://127.0.0.1:8095/cp/v1/public-feed | head -c 200; echo   # {"payload":{"kind":"easymed-public-feed",...
+journalctl -u easymed-cp --since "5 min ago" | grep "Signing key"                                           # Signing key: the production vendor key.
 ```
 
 ## Служба — `/etc/systemd/system/easymed-public.service`
@@ -125,7 +144,7 @@ sudo nginx -t && sudo systemctl reload nginx
 ```
 
 ```nginx
-upstream easymed_public { server 127.0.0.1:8095; keepalive 16; }
+upstream easymed_public { server 127.0.0.1:8096; keepalive 16; }
 server {
   listen 443 ssl http2;
   server_name api.easymed.uz;
@@ -162,11 +181,23 @@ curl -sI https://api.easymed.uz/docs | head -1             # HTTP/2 200 — до
 curl -sI http://api.easymed.uz/docs | grep -i ^location    # location: https://api.easymed.uz/docs
 systemctl show easymed-public -p MemoryCurrent -p MemoryMax
 journalctl -u easymed-public --since "10 min ago"          # тел запросов и данных пациентов здесь нет
+journalctl -u easymed-public --since "10 min ago" | grep "Licence key"   # Licence key: the production vendor key compiled into the app (46de4fe9a62a7f1349bdd3658be1696a).
+curl -s -H "Authorization: Bearer <PUBLIC_METRICS_TOKEN>" http://127.0.0.1:8096/_metrics | grep -o '"feed_[a-z_]*":[^,]*'   # feed_age_s меньше 120, feed_error ""
 ```
 
+- Строки `WARNING: licence key … is NOT the production vendor key` и `WARNING: PUBLIC_FEED_TOKEN is not set` на api.easymed.uz быть не должно.
+
 Наблюдение — 8c:
 - `/_health` раз в минуту, сообщение в Telegram при сбое;
-- `/_metrics` с токеном: очередь заявок, не доставленные уведомления, клиники на связи.
+- `/_metrics` с токеном: очередь заявок, не доставленные уведомления, клиники на связи;
+- PUBLIC_LICENCE_V1: `feed_age_s` больше 600 (список производителя не обновлялся 10 минут) или `feed_error` не пустой — сообщение: отметка «не оплачено» и срочный отзыв ключей не доходят до партнёров, пока клиника сама не принесёт лицензию.
+
+### Включение клиники (PUBLIC_LICENCE_V1)
+
+1. Клиника настроила «API и подключения» (имя в адресе, хоть одно подключение) — её экран «API» пишет «ждём включения Easy-Med».
+2. Панель `settings.easymed.uz/cp/` → клиника → карточка **Online booking / API** → переключатель. Строка «Clinic's API key» показывает принятый ключ (первый принимается сам).
+3. Не позже чем через час (ближайшая сверка) в лицензии клиники — отпечаток ключа; через 15 секунд обмен пошёл, строка карточки «Clinic's licence…» говорит «online booking on». Проверка: `curl -s -H "Authorization: Bearer <ключ партнёра>" https://api.easymed.uz/<имя клиники>/v1/clinic` → 200.
+4. Выключение — тот же переключатель: партнёрам «временно недоступна» в пределах минуты (список производителя), обмен клиники замолкает со следующей сверки.
 
 ## Восстановление базы из копии
 
````

- [ ] **Step 4: коммит** «Сквозной прогон трёх служб через границы каталогов: сервер лицензий и панель по HTTP, сверка и обмен настоящей клиники, публичный сервер со списком производителя — переключатель, отзыв ключей, «не оплачено» по списку до сверки и по лицензии без списка, срок клиники не продлён, новый ПК, отозванный ключ обмена, на сервере лицензий только отпечатки; DEPLOY.md — порт 8096, список производителя у обеих служб, проверки, наблюдение, включение клиники» — два файла.

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды**, когда сборщики клона не пишут: `node --experimental-vm-modules --test` из корня клона и то же с `--import …/force-en.mjs`. `LIS_ENABLED=0` на весь набор не ставить (план 8b, «Завершение»).

**2. Проверка «сломать»** — отдельный агент, только чтение и временные правки в своей копии дерева. Каждая правка должна сделать красным названный тест (при подготовке плана — 14 из 14):

| Правка | Красный |
|---|---|
| убрать `feedBlocksClinic` из `partner-auth.js` | `feed-gate.http.test.js` |
| убрать `feedRevokedPartnerKey` из `partner-auth.js` | `feed-gate.http.test.js` |
| убрать проверку отозванного ключа обмена в `sync.js` | `feed-gate.http.test.js`, `e2e.licence.test.js` |
| принимать список старше принятого (`store/feed.js`) | `feed.test.js` |
| `licence-key.js` пускает чужой ключ без разрешения | `licence-key.test.js` |
| `signLicence` не укорачивает срок по `notAfter` | `checkin-public-api.test.js`, `checkin.route.test.js` |
| `signLicence` не сдвигает `issued_at` за прошлую выдачу | `checkin-public-api.test.js` |
| новый ключ обмена принимается сам | `public-api.test.js`, `admin-public-api.test.js` |
| отозванный ключ обмена принимается | `public-api.test.js` |
| сырой ключ партнёра не узнаётся в панели (`KEY_RE`) | `admin-public-api.test.js` |
| удалённые клиники не попадают в `clinics_off` | `public-feed.test.js` |
| пустой `FEED_CONTEXT` (подпись списка = подпись лицензии) | `vendor-feed.test.js` |
| вернуть в `licence.js` ключ разработки | `vendor-key.test.js`, `licence-key.test.js` |
| карточка шлёт ключ партнёра без `sha256Hex` | `panel-public-api.test.js` |

**3. Глазами** — сервер лицензий локально с одноразовым ключом (`docs/HANDOVER.md` §5: `make-licence.mjs keygen`, `EASYMED_SIGNING_KEY`, `CP_PORT=8091`, свободный порт, не 8095): страница клиники — карточка «Online booking / API» (переключатель, значок, строка лицензии, блокировка вставленным ключом — в запросе браузера `value` из 64 hex), доска — «new API key waiting» после сверки с другим ключом. Ширина 390 и 1280.

**4. Ревью** — `superpowers:requesting-code-review` (безопасность: токен списка, подмена списка, сырой ключ, клиника с чужим ключом); затем слияние, пуш — по слову владельца. Тег не нужен для служб; клиникам — см. «Что остаётся для установки», п. 7.

**5. Ответы владельца** на вопросы 1–2 — вписать в спецификацию (`docs/specs/2026-10-06-clinic-api-design.md`) решениями 22–23; ответ «Б» на вопрос 1 — одна постоянная `NEW_SYNC_KEY_NEEDS_CONFIRMATION = false` и правка тестов, которые закрепляют подтверждение (`public-api.test.js`, `checkin-public-api.test.js`, `admin-public-api.test.js`, `e2e.licence.test.js` шаг 6).

---

## Вопросы владельцу

**Вопрос 1. Клиника поставила программу на новый компьютер, и у неё сменился ключ онлайн-записи. Принимать новый ключ сразу или после подтверждения в панели?** Ключ онлайн-записи — это то, чем публичный сервер узнаёт клинику и чем запечатаны имена и телефоны пациентов в новых онлайн-записях.
- **А (рекомендую, так построено):** после подтверждения. В панели у клиники появляется «новый ключ ждёт подтверждения», на доске — пометка; сотрудник Easy-Med звонит клинике, убеждается, что это она, и нажимает «Accept new key». Пока не нажал, онлайн-запись клиники работает по старому ключу (на новом компьютере — «ждём Easy-Med»). Защищает от того, кто скопировал файл `control.json` клиники: без подтверждения его компьютер не начнёт получать записи пациентов.
- **Б:** сразу, только с пометкой в панели. Меньше звонков, но копия `control.json` в чужих руках — это перехват новых онлайн-записей до тех пор, пока кто-то не заметит пометку.
- *Пример:* в «Шифо» сгорел ПК регистратуры, папку данных восстановили без файла ключа. При А администратор звонит в Easy-Med, через минуту ключ принят, через час (сверка) онлайн-запись снова идёт; записи, присланные партнёрами за это время, ждут (сутки — решение 20), но открыть их можно было только старым ключом — они теряются при любом варианте. При Б — то же, но без звонка.
- Переключение — одна постоянная (`NEW_SYNC_KEY_NEEDS_CONFIRMATION`).

**Вопрос 2. Кто в панели Easy-Med может включать онлайн-запись клинике и срочно блокировать ключи?**
- **А (рекомендую, так построено):** любой, у кого есть вход в панель, — как сейчас для модулей и оплаты (ролей в панели нет). В каждой блокировке видно, кто и когда её поставил или снял.
- **Б:** только владелец — нужны роли в панели (отдельная работа, не 8c).
- *Пример:* в субботу партнёр сообщает, что его ключ утёк. При А дежурный сотрудник блокирует ключ сам за минуту. При Б ждут владельца.

**Сообщить владельцу (решено, не вопросы):**
- **Настоящие лицензии подписаны настоящим ключом** — тем, что сгенерирован на сервере лицензий 22 августа и никогда его не покидал. Предупреждение плана 8b «в программе ключ разработки» было ошибкой по устаревшему комментарию; комментарий исправлен, ключ закреплён тестом.
- **«Не оплачено» больше не ждёт конца лицензии для партнёров:** партнёры получают «клиника временно недоступна» в пределах минуты после отметки в панели (список производителя) и, кроме того, с ближайшей сверки клиники (лицензия «не оплачено»). Сама программа клиники запирается в тот же день, что и раньше, — срок не продлевается и не сокращается.
- **Онлайн-запись включается клинике в панели** — карточка «Online booking / API» на странице клиники; по умолчанию выключена у всех. Включение доходит до партнёров за минуту, до самой клиники — со сверки (до часа).
- **Срочная блокировка ключа партнёра** работает, даже если компьютер клиники выключен. Ключ можно вставить в панель целиком — в Easy-Med он не уходит, только его отпечаток.
- **Порт публичного сервера — 8096:** 8095 на той же машине занят сервером лицензий.
- Панель, как и раньше, — по-английски.

---

## Что остаётся для установки (контролёр с владельцем; не код)

1. **Слить 8c** в основную линию (после ревью), пуш — по слову владельца.
2. **Сервер лицензий на 45.77.242.169** (`/opt/easymed-cp`, как план `2026-09-05-control-plane-v2-stage1.md`): копия `/opt/easymed-cp` и `registry.db` перед правкой → обновить код **выгрузкой всего репозитория** нужного коммита (`git -c core.autocrlf=false archive`), не по файлам: сервер лицензий импортирует код и вне `control-plane/` — с 8c ещё `server/services/control/vendor-feed.js` и `public/js/shared/{api-connections,clinic-profile}.js`, а `server/services/control/checkin.js` с 8a берёт `server/services/api/sync-identity.js`; `data/` и окружение службы не трогать → `EASYMED_CP_FEED_TOKEN` (`openssl rand -hex 24`) в окружение службы → `systemctl restart easymed-cp` (миграция 011 — при запуске) → в журнале `Signing key: the production vendor key.` → `curl 127.0.0.1:8095/cp/v1/public-feed` без токена — 401, с токеном — список.
3. **DNS** `api.easymed.uz` → 45.77.242.169 — вопрос 2 дизайна шага 8 (Cloudflare или напрямую) ещё не отвечен; рекомендация дизайна — напрямую, без прокси Cloudflare.
4. **TLS** — Let's Encrypt на машине для `api.easymed.uz`.
5. **Публичный сервер по `public-server/DEPLOY.md`:** пользователь, `/opt/easymed-public`, `npm ci --omit=dev`, `/etc/easymed-public.env` (`PUBLIC_PORT=8096`, `PUBLIC_FEED_URL=http://127.0.0.1:8095/cp/v1/public-feed`, `PUBLIC_FEED_TOKEN` = тот же токен, `PUBLIC_METRICS_TOKEN`, `PUBLIC_SELF_IPS=45.77.242.169`, `PUBLIC_LICENCE_PUBLIC_KEY` пусто), systemd (`MemoryMax=256M`), nginx (upstream `127.0.0.1:8096`), проверки: `/_health`, строка `Licence key: the production vendor key … (46de4fe9…)`, `/_metrics` — `feed_age_s` < 120, `feed_error` пуст. Перед этим — `ss -ltnp | grep 8096` пусто.
6. **Наблюдение:** `/_health` раз в минуту и `/_metrics` (`feed_age_s` > 600 или `feed_error`) — сообщение в Telegram. **Резервные копии `public.db`** — не дольше суток, зашифрованные (план 8b, «Что 8c должен дать», п. 5).
7. **Клиникам нужна версия с 8a/8b:** обмен с публичным сервером и `api_sync_public_key` в сверке есть только на основной линии (8a, 8b — не тегированы). Клиники на v3.16.0 ключа не шлют — включить им онлайн-запись нельзя, пока не выйдет выпуск (тег — по слову владельца; память `easymed-release-means-tag`).
8. **Проба на тестовой клинике :8712** (у неё 8a/8b стоят): «API и подключения» настроены → панель: её клиника → Online booking / API → включить → дождаться сверки (или перезапуск) → экран «API» клиники «работает» → `curl -H "Authorization: Bearer <ключ партнёра>" https://api.easymed.uz/<имя>/v1/clinic` — 200; отметка «Unpaid» в панели — через минуту 503, вернуть «Active».
9. Дальше — клиники по одной, по решению владельца.

---

## Риски

1. **Лицензия «не оплачено» может укоротить лицензию, выданную вручную** (`scripts/make-licence.mjs`, путь на случай недоступной панели): срок берётся из последней лицензии, выданной сервером лицензий. Раньше неоплаченная клиника доживала любую свою лицензию. Если клинике когда-нибудь выдавали лицензию руками на больший срок и затем отметили «не оплачено», она запрётся по сроку последней автоматической лицензии.
2. **Лицензия, выданная вручную, — без `subscription` и `api_sync_key`:** такая клиника молчит для онлайн-записи до ближайшей обычной сверки. `make-licence.mjs` эти поля не знает (не входит в 8c).
3. **Список производителя держится «последним хорошим»:** пока сервер лицензий недоступен, новые отметки «не оплачено» и новые блокировки до публичного сервера не доходят (только через лицензии клиник на связи). Видно по `feed_age_s`; наблюдение (установка, п. 6) обязано поднимать тревогу.
4. **Подтверждение нового ключа удлиняет окно, в котором онлайн-записи запечатаны старым ключом** (вопрос 1): записи, присланные до подтверждения, открыть может только старый компьютер.
5. **Один ключ производителя на лицензии и список.** Кто владеет `/etc/easymed-cp/vendor-private.pem`, тот может всё — как и до 8c для лицензий. Контекст подписи защищает только от подмены одного документа другим.
6. **Часы сервера лицензий шагнули назад:** список с более ранним `issued_at` не берётся (`outdated`), пока часы не догонят принятый; лицензии от этого защищены (`issuedAfter`). Видно в `/_metrics` (`feed_error: outdated`).
7. **Обе службы на одной машине** (решение 16): её остановка — партнёры не видят ни одной клиники; клиники работают (лицензия на 14 дней).
8. **Экран карточки проверен тестами решений и подачи файла, но не браузерным прогоном** — «Завершение», п. 3.
9. **Клиника с устаревшей программой** (без 8a) ключ не шлёт; панель покажет «waiting for the clinic's API key» — включение ничего не даст до обновления.
10. **Строка `api_sync_key` в лицензии появляется только при включённом переключателе;** выключение не отзывает уже выданную клинике лицензию — до её замены (≤ 1 ч) обмен клиники продолжается, но партнёры клинику не видят уже через минуту (список).
11. **Ключ партнёра, заблокированный Easy-Med, получает тот же ответ, что выключенный клиникой** (`401 key_disabled`, текст «Ключ выключен клиникой» — так его описывает и документация шага 9). Партнёр звонит в клинику, клиника — в Easy-Med. Свой код ошибки потребовал бы правки документации и её стража — не в 8c.

---

## Не входит

| Что | Почему |
|---|---|
| Установка: машина, DNS, TLS, nginx, systemd, наблюдение, резервные копии | Нужен владелец; список — «Что остаётся для установки». |
| Роли в панели | Вопрос 2, вариант Б. |
| Новые поля в `scripts/make-licence.mjs` | Риск 2; путь на крайний случай. |
| Надписи экрана клиники «новый ключ ждёт подтверждения Easy-Med», «клиника скрыта: не оплачено» | 8d: экран 8a говорит «ждём включения» (`not_enabled`) — правда, но общая. |
| Автоматический отзыв прежнего ключа при принятии нового | Прежний перестаёт работать сам, как только публичный сервер увидит новую лицензию (`licence_outdated`); украденный — кнопкой «Block this key». |
| Сообщение в Telegram продавцу о новом ключе или блокировке | Наблюдение — установка, п. 6; уведомления панели — позже. |
| Отсрочка прежнего ключа партнёра 24 часа | Решение «сразу» (шаг 7). |

---

## Проверки плана (сделаны при его подготовке)

- **Весь код собран и прогнан** сначала в копии дерева `61591598`, затем — когда в основную линию легли коммиты шага 9 — заново в копии `e8b4aab4`: план наложен из собственного текста по задачам, четыре блока diff (`public-server/server/config.js`, `app.js`, `index.js`, `DEPLOY.md` — их правил шаг 9) сведены руками, блоки в плане — сведённые. Песочница `scratchpad/plan8c/tree` (свой git, коммит на задачу), выгрузка `git -c core.autocrlf=false archive` (LF), `node_modules` основного дерева — ссылкой (junction; основное дерево не тронуто). Ни одного запроса в интернет, ни одного настоящего порта. После проверок песочница удалена (место на диске); весь код — в этом плане, скрипты проверок — `scratchpad/plan8c/*.mjs`.
- **Затронутые наборы целиком** (на `e8b4aab4` + план): все тесты `control-plane/`, `public-server/` (с документацией шага 9 — `public-server/server/docs/*.test.js`), `server/services/control/`, `server/services/api/`, `public/js/shared/api-connections.test.js` и сторожа — 102 файла, 1189 тестов: 1187 зелёных, 2 todo, 0 красных — и как есть, и с `force-en.mjs`. Ещё 84 файла тестов программы клиники, которые берут изменённые модули (`licence.js`, `sync-identity.js`, `control-plane/server/…`, `public-server/server/…`), — 756 из 756 зелёные. (`scripts/build-bundle.test.js` в песочнице краснеет на «allow-listed entries contain no symlinks/junctions» из-за ссылки `node_modules` самой песочницы — в клоне со своей копией модулей этого нет.)
- **План проигран по задачам** (`scratchpad/plan8c/replay.mjs`): после каждой задачи — её команда из шага «зелёные», как есть и с `force-en.mjs`, числа совпали с планом: 41, 33, 45, 117, 34, 95, 66, 15, 22, 38, 10.
- **Красный сначала** (`scratchpad/plan8c/redfirst.mjs`): тесты каждой задачи на коде предыдущей — отказы, записанные в шагах 2.
- **План проигран из собственного текста** (`scratchpad/plan8c/replay-text.mjs`): блоки новых файлов — Write, блоки diff — `git apply` по порядку задач на чистой выгрузке `e8b4aab4`; итог совпал с песочницей байт в байт; файлов, которые меняет план (кроме самого плана), — 51: 23 новых блоком и 28 правок — 29 блоками diff.
- **Поломки** (`scratchpad/plan8c/mutate.mjs`) — 14 из 14 ловятся (таблица в «Завершении»). При подготовке одна поломка не ловилась (сырой ключ партнёра отвергался и без своей проверки — как «неверный отпечаток»); тест `admin-public-api.test.js` усилен проверкой текста отказа.
- **Ключ производителя сверен:** PEM в `licence.js` — `MCowBQYDK2VwAyEAXaSA2ArkuT/…`, отпечаток DER-SHA-256 `46de4fe9a62a7f1349bdd3658be1696a`, SHA-256 PEM `6990891f…`; ключ разработки — `…ViIP4qnV…`, SHA-256 PEM `d81d431a…` (= прежний `DEV_KEY_FINGERPRINT`), DER `d1deb8cc…`; замена — `6cd66c5c` (2026-08-22) «both trust keys are production now»; ключа разработки в деревьях `61591598` и `e8b4aab4` нет.
- **Контраст новых значков панели:** `--amber-ink` на `--attention-ring` — 5.04:1, `--ink-2` на `--bg-3` — 5.04:1.
