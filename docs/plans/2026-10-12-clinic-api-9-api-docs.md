# API клиники, шаг 9: документация API для партнёров — одна публичная страница `https://api.easymed.uz/docs` (API_DOCS_V1, CLINIC_API_STEP9_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** партнёры (сайт клиники, Symptex, med24.uz, clinics.uz…) читают документацию API на одной публичной странице `https://api.easymed.uz/docs` — её отдаёт публичный сервер (`public-server/`, шаг 8b), она одна на все клиники и всегда описывает работающий код (решение владельца 21, 2026-10-12). В программе клиники, «Настройки → API и подключения», — только адрес API клиники (уже есть, шаг 7), ссылка «Документация для партнёров» и, в тексте «Скопировать всё», ссылка и команда `curl` для проверки ключа.

**Architecture:**
- **Страница** — `GET /docs` (русская), `/docs/uz`, `/docs/en` на публичном сервере (`routes/docs.js`). HTML целиком в одном ответе: стили внутри, ни скриптов, ни шрифтов, ни картинок со стороны; читается с телефона, печатается, тёмная тема по системе. Кэш 5 минут + ETag.
- **Один источник правды.** Страница строится (`docs/render.js`) из:
  - текста, который пишет человек, — `docs/content.js` (ru / uz / en): разделы, адреса и их параметры, запросы примеров, пояснения к статусам, причинам, ошибкам, событиям;
  - чисел из постоянных сервера — `docs/facts.js` (лимиты, сроки, повторы — ни одного числа руками);
  - словарей кода — права и события (`shared/api-connections.js`), группы услуг (`shared/service-public.js`), статусы (`store/requests.js`), причины (`shared/api-booking.js`), коды ошибок с HTTP-кодом и текстом ответа (`lib/errors.js`), тело уведомления (`webhookBody`) и подпись (`outbox.js signBody` — та же функция, что у клиники);
  - ответов примеров — **записанных ответов настоящего сервера**: `node public-server/scripts/docs-build.mjs` гоняет запросы примеров на настоящие адреса партнёров (стенд в процессе, мир клиники-примера «Шифо») и пишет `docs/generated.js`; там же — переводы подписей прав, событий и групп из словаря программы.
- **Стражи:** `docs/drift.test.js` (адреса сервера = описанные; права, статусы, причины, события, коды ошибок, причины полей — те же списки, что в коде, включая то, что шлёт клиника), `docs/examples.http.test.js` (`generated.js` — ответы сервера сейчас; каждая строка таблицы полей — своим запросом; границы полей пациента; матрица прав; коды тела; CORS), `docs/page-curl.http.test.js` (каждая команда `curl` со страницы, разобранная обратно, на настоящем сервере даёт ответ, показанный под ней — на трёх языках), `docs/render.test.js` (целая, доступная, без ключей, без русского на uz/en), `routes/docs.http.test.js` (адреса, заголовки, перенаправления, настройки службы).
- **Программа клиники:** общий модуль `shared/api-connections.js` получает адрес документации и одну функцию команды `curl` (ею пользуются и страница, и «Скопировать всё»); экран «API и подключения» — ссылку в шапке; окно «Что передать подключению» — ссылку и команду проверки ключа с подстановкой `<ключ>` вместо ключа.

**Tech Stack:** Node 24 ESM, express 5.2 (служба `public-server/`), `node:test`, `node:http` (проверка 304), HTML + CSS без скриптов; экраны программы — модули `public/js/admin` (`h()`, `Icon()`, `tr()`), словарь `i18n-strings.js`.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — решения владельца 1–20; **решение 21** вносит задача 0. Шаг 7 оставил шагу 9 два пункта (план `docs/plans/2026-10-10-clinic-api-7-api-screen.md`, «→ Шаг 9 (документация API)»). План 8b, раздел «Ревью и исправления» → «Для документации API (шаг 9)» и риск 2 («сервер закрывает заявку без уведомления — документация обязана это сказать»).

**Макет** (строение и тон): `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\js\screen-docs.js` — разделы, примеры, `curl`, статусы, ошибки, подпись уведомлений, `hold_until`, `?lang`, целые суммы, UTC+5, `/reference/geo` и `/reference/specialties`. **Где сервер работает не так, как макет, страница описывает сервер** (Р9).

**Память:** `easymed-clinic-api-mockup`, `easymed-ci-locale-trap`, `windows-dynamic-port-fetch-bad-port`, `bash-tool-heredoc-backslashes` (файлы плана — только Write: в них есть `\\` и `\n`), `easymed-shared-tree-hunk-commits`, `node-modules-fragility-easymed-local`.

**Код плана прогнан.** Весь код собран и прогнан в копии дерева `e8f4ead3` и проигран по задачам ещё и на `61591598` (ветка `feat/clinic-api-step8b` после узкой проверки исправлений 8b; выгрузка `git -c core.autocrlf=false archive`, LF, своя копия `node_modules`) — «Проверки плана» в конце.

**Метка кода:** `API_DOCS_V1` — в шапке каждого нового файла и у каждой правки.

**Метка плана и коммитов:** `CLINIC_API_STEP9_V1`. Первая строка сообщения коммита кончается скобкой `(API_DOCS_V1, CLINIC_API_STEP9_V1)`.

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | **Адреса страницы:**<br>• `/docs` — русская;<br>• `/docs/uz`, `/docs/en` — узбекская и английская;<br>• `/docs/ru` и `/docs?lang=uz\|en\|ru` — `301` на свой адрес;<br>• незнакомый `?lang` — русская; `/docs/<другое>` — `404` JSON, как любой неизвестный адрес службы.<br>Без ключа и без `https` за прокси (страница открытая). Переключатель языков вверху, `hreflang`, `canonical`. Язык по `Accept-Language` **не** выбирается. | Решение 21: одна страница на все клиники. **Русский по умолчанию:** разработчики в Узбекистане читают техническую документацию по-русски; язык ошибок API без `?lang` — тоже русский (`lib/errors.js`); у каждой страницы один адрес, который владелец и клиники пересылают — без догадок по браузеру, кэшируется одинаково для всех. `?lang` — как у самих адресов API. Имя клиники `docs` занято (`RESERVED_SLUGS`) — с `/<клиника>/v1/` страница не пересекается. |
| Р2 | **Один источник правды** (что откуда — см. Architecture). Руками на странице нет ни одного числа, кода, статуса, события, права, HTTP-кода и текста ошибки. Числа без постоянной в коде (правила полей пациента, `Access-Control-Max-Age`, ритм обмена клиники) — именованные постоянные `docs/facts.js`, которые страж сверяет **пробой сервера** или **с постоянными программы клиники**. | Требование задачи: «не может разойтись». Новый адрес, код ошибки, статус, событие, право, причина поля или поле ответа без строки на странице — красный тест (проверено поломкой, 11 из 11 — «Проверки плана»). |
| Р3 | **Ответы примеров записывает сервер, а не человек:** `scripts/docs-build.mjs` → `docs/generated.js` (ответы по трём языкам + переводы подписей). Номера заявок (случайные у сервера) записываются номерами страницы (`SAMPLE.ids`), часы — подставные: файл от прогона к прогону не меняется. Страж пересобирает файл в памяти и сравнивает байт в байт. | Три языка × 19 примеров руками — гарантированное расхождение. Изменили ответ партнёрам — тест красный с готовой командой исправления. Запросы примеров (что шлём) пишет человек — в `content.js`. |
| Р4 | **Мир примеров — клиника «Шифо»** (`shifo`) в `test-helpers/docs-world.js`: выдуманные имена и телефоны, сайты и соцсети в зоне `.example` (RFC 2606), часы — понедельник 11.03.2030, 09:00 Ташкента (подставное время тестов 8b). Стенд партнёров 8b (`partner-stand.js`) получает три необязательных параметра: `snapshot`, `slots`, `baseUrl`. | Ни данных клиник, ни данных пациентов на публичной странице. Мир — в `test-helpers`: рабочий код его не берёт (страж `no-test-helpers-in-production`), сервер в работе страницу строит из записанного. |
| Р5 | **Ключей на странице нет:** в командах — переменная оболочки `$EASYMED_KEY`, в тексте — обрезанные `em_live_…` / `em_whsec_…`. Подпись уведомления в примере посчитана секретом `example-secret` (не похож на секрет программы) — проверочный пример для кода партнёра. Страж страницы ищет всё, что похоже на ключ (`KEY_RE`, `SECRET_RE`, `em_…` от 8 знаков), страж репозитория `no-real-api-keys` — как прежде. | Правило шага 7: ключ не лежит в исходниках; публичная страница — тем более. |
| Р6 | **Страница:** HTML5, `lang`, один `h1`, разделы `section` + `h2` с якорями, адреса — `h3`, «Перейти к тексту», таблицы с `th scope="col"` в прокручиваемой обёртке (`role="region"`, `tabindex="0"`), код — `pre tabindex="0"`; сетка `minmax(0,1fr)` (на 320 px ничего не вылезает — проверено), содержание сбоку от 960 px; шкала шрифтов программы; контраст ≥ 4.5:1 в светлой и тёмной теме; `@media print` без навигации, со ссылками в скобках. Заголовки: `Cache-Control: public, max-age=300`, ETag (express), `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Content-Language`. Страница строится при первом запросе языка (~2 мс) и держится в памяти (80–90 КБ на язык). | «Самодостаточная, без CDN, без JS, доступная, с телефона, на печать». Ошибка построения страницы — `500` только у `/docs`, а не падение службы при запуске. Новая страница видна не позже чем через 5 минут после выпуска. |
| Р7 | **Срок не забранной заявки — из настроек службы:** `createPublicServer` получает `uncollectedMaxMs` (из `PUBLIC_UNCOLLECTED_MAX_HOURS`, `index.js`), страница называет его («24 часа» → «48 часов», если поменяли). Адрес в командах и ссылках ответов — `ctx.baseUrl` (`PUBLIC_BASE_URL`). | Страница описывает **этот** сервер, а не умолчание. |
| Р8 | **Программа клиники:**<br>• `shared/api-connections.js`: `API_DOCS_PATH`, `API_DOCS_URL`, `apiDocsUrl(lang)` (`/docs`, `/docs/uz`, `/docs/en`), `curlCommand()` — одна форма команды на страницу и «Скопировать всё»;<br>• шапка «API и подключения» — ссылка-кнопка «Документация для партнёров» (`Icon('Doc')`, новая вкладка, `rel="noopener noreferrer"`) — у любого права и в филиале;<br>• окно «Что передать подключению» — та же ссылка в «Что ещё знать»;<br>• текст «Скопировать всё» — строки «Документация: …» (страница на языке экрана) и «Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): curl …» с подстановкой `<ключ>`; адрес — первый открытый ключу раздел чтения (`clinic`, `branches`, `doctors`, `services`, `packages`), иначе `reference/specialties` (открыт любому ключу). | Решение 21 и пункты шага 7. Правило шага 7 о секрете не меняется: ключ — только своей строкой «Ключ: …» (её копирует сам администратор кнопкой «Скопировать всё»); команду пересылают и вставляют в чаты и терминалы — в ней ключа нет. Команда в одну строку работает в bash, zsh, cmd и PowerShell 7. В Windows PowerShell 5.1 (терминал Windows по умолчанию) curl — это Invoke-WebRequest: там пишут curl.exe; строка «Проверить ключ» говорит это (ревью шага 9, п. 7). |
| Р9 | **Где страница не повторяет макет** (описан сервер):<br>• онлайн-запись — всегда `pending` без `hold_until`; срок держания (30 минут по часам работы клиники) появляется, когда клиника приняла заявку (решения 18–19); «сразу `booked`» нет (шаг 7, пункт 11);<br>• отмена записанной — `booked` с `cancel_requested: true`, пока клиника не отменит визит;<br>• события — все семь словаря шага 7, со статусом и полями, которые шлёт клиника; статусы — с `offered`, `declined`, `expired`, `closed`; причины;<br>• `503` — «клиника временно недоступна», без «не продлена»;<br>• `occurred_at` уведомления — в UTC (так шлёт клиника);<br>• `no_show` партнёрам сейчас не сообщается, `arrived` — только с включённым событием (сказано прямо);<br>• поля пациента — объектом `patient` (верхний уровень тоже принимается — сказано). | Требование задачи: где сервер и макет расходятся, документация — о сервере. Каждое такое место держит страж (примеры и пробы на настоящем сервере, сверка с кодом клиники). |
| Р10 | **nginx (`DEPLOY.md`):** по `http` только `/docs`, `/docs/uz`, `/docs/en` перенаправляются на `https` (`301`); всё прочее по `http` — по-прежнему `444`. Проверка после установки — две строки `curl -sI`. | Ссылку набирают руками; ключей на этих адресах нет. |
| Р11 | **Контакт Easy-Med** на странице — постоянная `DOCS_CONTACT` (`hello@easymed.uz`, этот адрес уже есть в программе). | Вопрос владельцу 1: какой адрес показать разработчикам партнёров. Смена — одна строка. |
| Р12 | **Два сборщика:** А — публичный сервер (задачи 0–5), Б — экраны клиники (задачи 6–7). Общих файлов нет: `shared/api-connections.js` правит только А (задача 1), `i18n-strings.js` — только Б. | Б начинает после задачи 1 и не ждёт страницы: ссылка — постоянный адрес. |

---

## Что шаг 9 закрывает

| Требование | Задача |
|---|---|
| Решение 21: одна публичная страница `https://api.easymed.uz/docs`, одна на все клиники, всегда по коду | 0 (спецификация), 2–5 |
| Решение 21: в программе — адрес API клиники и ссылка на страницу; ссылка и `curl` в «Скопировать всё» | 1, 6, 7 |
| Решение 21: ни страницы документации в программе, ни PDF | 6, 7 (только ссылки; страж: экран не спрашивает свой сервер о документации) |
| Шаг 7, «→ Шаг 9», п. 1: «Документация API» в шапке экрана → ссылка «Документация для партнёров» на публичную страницу | 7 |
| Шаг 7, «→ Шаг 9», п. 2: ссылка на документацию и пример `curl` в «Скопировать всё» | 6 |
| 8b, «Для документации API»: `offer_changed`, `unsupported_encoding`, `too_large`; `offered_start` в accept/decline; уведомления о «другом времени», на которое уже не ответить, не уходят; `Access-Control-Expose-Headers: Retry-After`; `stale` по молчанию и по возрасту данных; `closed`; доставка — 6 попыток или 107 минут, отдых адреса | 2–4 |
| 8b, «Для документации API»: `media_quota` — код канала клиники, партнёру не приходит | 2 (`CLINIC_ONLY_ERRORS`, страж: каждый код `lib/errors.js` — либо у партнёра, либо только у клиники) |
| 8b, риск 2: сервер закрывает заявку без уведомления — документация обязана сказать | 2 (раздел «Заявки», статус `closed`, причины `not_processed`, `not_collected`) |
| Задача: адрес, лимиты, сроки — те, что у сервера; примеры работают; ответы — той формы, что у сервера | 2–5 |

---

## Карта файлов

**Публичный сервер — новые** (`public-server/`):
- `server/docs/facts.js` — числа страницы из постоянных сервера;
- `server/docs/content.js` — текст страницы (ru / uz / en), адреса, параметры, запросы примеров, пояснения;
- `server/docs/generated.js` — **создаёт команда** `node public-server/scripts/docs-build.mjs`: ответы примеров и переводы подписей;
- `server/docs/render.js` — HTML страницы;
- `server/routes/docs.js` — `/docs`, `/docs/uz`, `/docs/en`;
- `server/test-helpers/docs-world.js` — мир клиники-примера «Шифо»;
- `server/test-helpers/docs-run.js` — запросы примеров на стенде, сборка `generated.js`;
- `scripts/docs-build.mjs` — пересборка `generated.js`;
- тесты: `server/docs/drift.test.js`, `server/docs/examples.http.test.js`, `server/docs/render.test.js`, `server/docs/page-curl.http.test.js`, `server/routes/docs.http.test.js`.

**Публичный сервер — правки:** `server/app.js` (адреса страницы, `uncollectedMaxMs`), `server/index.js` (срок из настроек), `server/test-helpers/partner-stand.js` (`snapshot`, `slots`, `baseUrl`), `DEPLOY.md` (nginx, проверка).

**Программа клиники — правки:** `public/js/shared/api-connections.js` (+ тест), `public/js/admin/views/api-ui.js`, `public/js/admin/views/api-connection-new.js`, `public/js/admin/views/api-connections.js`, `public/js/admin/i18n-strings.js`, тесты `public/js/admin/__tests__/api-connection-new.test.mjs`, `api-connections.test.mjs`, `api-connections-i18n-en.test.mjs`.

**Документы:** этот план — `docs/plans/2026-10-12-clinic-api-9-api-docs.md`; решение 21 — в `docs/specs/2026-10-06-clinic-api-design.md`.

Итого: 14 новых файлов (с планом; 5 файлов тестов, 29 тестов) и 14 правок (из них 4 файла тестов, +5 тестов).

---

## Сейчас в коде (сверено 2026-10-12, деревья `e8f4ead3` и `61591598`)

- **Приложение** — `public-server/server/app.js`: общий слой ставит каждому ответу `Cache-Control: no-store` и `X-Content-Type-Options: nosniff`; затем `opsRouter` (`/_health`, `/_metrics`), `/_sync/v1`, `/:slug/v1` (партнёры), `404 not_found`, обработчик ошибок. `index.js` берёт настройки из `config.js` (`uncollectedMaxMs` уходит только в фон `startJobs`).
- **Адреса партнёров** — `routes/partner.js` (`Router.stack` express 5 даёт `route.path` и `route.methods`), 15 маршрутов: `GET /media/:file` (без ключа), `GET /clinic|/branches|/doctors|/services|/packages|/slots`, `GET /reference/geo|/reference/specialties` (любой ключ), `POST /requests`, `POST /appointments`, `GET /requests/:id`, `DELETE /appointments/:id`, `POST /appointments/:id/accept|decline`. Тело — `express.json({ limit: '32kb' })` (`PARTNER_BODY_LIMIT`); body-parser 2.3 разжимает `gzip`, `deflate`, `br`, прочее — `415 unsupported_encoding`.
- **Ошибки** — `lib/errors.js` `ERRORS`: 30 кодов. Партнёр может получить 23; только канал клиники — 7: `invalid_signature`, `licence_invalid`, `licence_outdated`, `clock_skew`, `bad_slug`, `slug_taken`, `media_quota`. Язык текста — `?lang`, без него — русский.
- **Причины полей** — `partner-read.js` (`bad(req, res, поле, причина)`, `not_found` с `field`) и `partner-write.js` (`field(…)`, `pick(…)` → `format` / `not_found`, `prefix + 'name'` → `patient.name` при объекте `patient`). Пределы — числами в коде: имя 120, телефон 32 знака и ≥ 7 цифр, комментарий 1000, `external_id` 1–64 видимых ASCII.
- **Статусы** — `store/requests.js` `PARTNER_STATUSES` (11, с `closed`); причины `closed` — строками в SQL (`not_processed`, `not_collected`); `DECLINE_REASONS` (6) — `shared/api-booking.js`.
- **События** — `shared/api-connections.js` `EVENTS` (7) и `EVENT_INFO`. Что шлёт клиника (`server/services/api/bookings.js`, `visit-events.js`):
  - `request.accepted` — `accepted`;
  - `appointment.created` — `booked`, `doctor_id`, `start`, при переносе `rescheduled`;
  - `booking.confirmed` — `booked`, `doctor_id`, `branch_id`, `start`;
  - `booking.offered_other_time` — `offered`, `doctor_id`, `offered_start`, `offer_until`;
  - `booking.declined` — `declined` или `expired`, `reason`, `doctor_id`, иногда `start`;
  - `appointment.cancelled` — `cancelled`, `doctor_id`;
  - `appointment.arrived` — `arrived`, `doctor_id`; без подписки подключения не уходит вовсе — ни уведомления, ни статуса (`outbox.js PRIVATE_EVENTS`);
  - **«Не пришёл» клиника не отправляет вовсе** (`visit-events.js`: статус меняется без события) — у партнёра статус остаётся `booked`. Статус `no_show` в словаре есть, но сейчас не приходит.
- **Тело уведомления** — `webhookBody` (`shared/api-booking.js`); `occurred_at` — `isoOf(now)`, **UTC** (`2030-03-11T04:12:00Z`); `start`, `offered_start`, `offer_until` — со смещением. Подпись — `outbox.js signBody` (`'sha256=' + HMAC-SHA256`). Доставка (`store/deliveries.js`) шлёт `Content-Type`, `X-EasyMed-Signature`, `X-EasyMed-Event`, `X-EasyMed-Event-Id`, `User-Agent: EasyMed-Webhooks/1`.
- **Ритм обмена клиники** — `server/services/api/public-sync.js`: `POLL_MS` 15 с, `SLOTS_EVERY_MS` 60 с, `HEARTBEAT_MS` 15 мин.
- **Стенд 8b** — `test-helpers/partner-stand.js` `partnerStand()`: клиника `shifo`, снимок и время 8b, ключ — выпущенный в тесте, часы `NOW` (2030-03-11 09:00 Ташкента), `baseUrl` — `https://api.test`. `fixture.js`: `testDb`, `testVendor`, `testClinic`, `serve` (через `control-plane/server/test-helpers/listen.js`).
- **`fetch` и ETag:** `fetch` с `If-None-Match` сам добавляет `Cache-Control: no-cache` (спецификация fetch), и express отвечает 200. Проверка `304` — через `node:http`.
- **Экран шага 7** — `views/api-connections.js` (`PageHead({ title, subtitle, right })` — `right` уже есть в `ui.js`), `views/api-connection-new.js` (`handoverText`, `openHandover`), `views/api-ui.js` (общие кусочки). `h()` сам переводит текст детей и атрибуты `title`, `aria-label`, `placeholder`. `Icon('Doc')` есть в `icon-map.js`. Внешняя ссылка-кнопка — как `views/company-address.js` (`a.btn … target=_blank rel=noopener noreferrer`).
- **Словарь** — переводы подписей прав, событий и групп услуг (`SCOPE_INFO`, `EVENT_INFO`, `PUBLIC_GROUPS`) в `i18n-strings.js` есть все; последний блок — `PUBLIC_API_V1`.
- **`node_modules`** — от корня репозитория (у `public-server/` своих нет).

---

## Правила рабочего дерева (читать до первого шага)

**Дерево** назначает контролёр:
- ветка `feat/clinic-api-step9` от основной линии **после слияния 8b** (в ней есть `public-server/`; сверено на `e8f4ead3` и `61591598` — коммиты после `e8f4ead3` файлов этого плана не трогают). Если основная ушла вперёд, место правки находить `grep -n` по строке из diff;
- клон с `core.autocrlf=false` и своей копией `node_modules`, как `easymed.api7`; ветку не переключать; worktree не создавать — он стирает `node_modules` (память `node-modules-fragility-easymed-local`);
- запущенные серверы (:8000, :8712) и каталог `data/` не трогать.

**Два сборщика в одном клоне** (см. «Порядок»): у каждого файла один хозяин.
- А: всё в `public-server/`, `public/js/shared/api-connections.js` и его тест, `docs/`.
- Б: `public/js/admin/views/api-ui.js`, `api-connection-new.js`, `api-connections.js`, `i18n-strings.js`, тесты экрана.
- `i18n-strings.js`, `public/js/shared/api-connections.js`, `views/api-ui.js` могут править сборщики других шагов в том же клоне — эти файлы коммитить **только своими строками**, точным блобом:
  1. свои добавленные и удалённые строки записать в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/mine/step9-<A|B>-<имя файла>.txt` (добавленная — с `+`, удалённая — с `-`, ровно как в файле);
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
- пушить и ставить тег — это делает контролёр.

**Файлы и коммиты:**
- Файлы — LF. Проверка: `git diff --cached --stat`, `git ls-files --eol <файл>` показывает `i/lf`.
- Новый файл кладётся **целиком** блоком плана — инструментом **Write**, не `cat <<EOF` в bash: оболочка съедает `\\` и `\n` (память `bash-tool-heredoc-backslashes`), а в блоках они есть (команда `curl`, регулярные выражения).
- Правка существующего файла — блоком diff: записать его Write в файл, `git apply --check <файл>`, затем `git apply <файл>`. Не легло (основная ушла вперёд) — внести руками по строкам `+` и `-`.
- Сообщение коммита — Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/step9-<N>.txt`, затем `git commit -F <файл>`; по-русски; первая строка — текст коммита из задачи с хвостом `(API_DOCS_V1, CLINIC_API_STEP9_V1)`; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

**Тесты:**
- Только явными путями, из корня клона: `node --test <файлы>` (сервер, `public/js/shared`), `node --experimental-vm-modules --test <файлы>` (клиентские `.mjs`). Каталог аргументом не передавать (Node 24 на Windows).
- Каждый раз — дважды: как есть и как CI на en-US: `node --import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs --test <файлы>`. Нет файла — восстановить: `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });` (память `easymed-ci-locale-trap`).
- **Порты:** ни одного настоящего. Сервер — только через `listen()` из `control-plane/server/test-helpers/listen.js` (случайный порт 127.0.0.1, без «плохих» для fetch); так же — `scripts/docs-build.mjs`. `index.js` не запускать.
- **Интернет** не нужен и не трогается: стенд и запросы — в процессе.
- **Ключи:** только выпущенные во время теста (`newApiKey`) или строки с `TESTONLY`; на странице — `$EASYMED_KEY`.
- Сторожа каждой задачи А: `node --test server/services/api/no-real-api-keys.test.js server/test-helpers/no-test-helpers-in-production.test.js public-server/server/not-shipped.test.js scripts/build-bundle.test.js`.
- Сторожа каждой задачи Б (клиентские): `node --experimental-vm-modules --test public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/type-scale.test.mjs public/js/admin/__tests__/icons.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs public/js/admin/__tests__/no-import-cycles.test.mjs public/js/admin/__tests__/no-stray-globals.test.mjs` и `node --test server/services/api/no-real-api-keys.test.js`.
- **Полный прогон** делает контролёр («Завершение»).

**Текст:**
- Страница: ru / uz / en в `docs/content.js`; узбекский и английский — без кириллицы, узбекский апостроф — `‘` (U+2018), `’` — в `ma’lumot` (как в словаре программы). Страж — `drift.test.js`, последний тест.
- Экран: каждая новая строка — статья `i18n-strings.js` (блок `API_DOCS_V1` в конце `STRINGS`, у каждой строки хвост `// API_DOCS_V1`); фраза с подстановкой — `trf()` и `{шаблон}`; значки — только `Icon()`; без эмодзи; шрифты — шкала программы.

---

## Порядок и два сборщика

**Сборщик А — публичный сервер:** задачи 0–5. **Сборщик Б — экраны клиники:** задачи 6–7.

Столбец «Нужны до начала» — что должно быть **закоммичено** до начала задачи.

| Задача | Сборщик | Нужны до начала |
|---|---|---|
| 0 План и решение 21 в репозиторий | А | — |
| 1 Адрес документации и команда `curl` — общий модуль | А | 0 |
| 2 Числа и текст страницы, страж «не расходится с кодом» | А | 1 |
| 3 Примеры на настоящем сервере — мир «Шифо», `generated.js`, пробы полей и прав | А | 2 |
| 4 Страница — HTML, доступность, команды со страницы на сервере | А | 3 |
| 5 Адрес `/docs` в приложении, настройки службы, nginx | А | 4 |
| 6 «Скопировать всё» и окно «Что передать» — ссылка и команда проверки | Б | 1 |
| 7 Шапка «API и подключения» — ссылка на документацию | Б | 6 |

Б начинает, как только закоммичена задача 1, и идёт параллельно с А.

---

## Task 0: План и решение 21 в репозиторий

Сборщик А.

**Files:**
- Create: `docs/plans/2026-10-12-clinic-api-9-api-docs.md` — копия этого файла (LF).
- Modify: `docs/specs/2026-10-06-clinic-api-design.md` — решение владельца 21; «Цель» и «Порядок», п. 9.

- [ ] **Step 1:** скопировать план.
- [ ] **Step 2:** решение 21 — diff (Write в файл, `git apply --check`, `git apply`):

```diff
diff --git a/docs/specs/2026-10-06-clinic-api-design.md b/docs/specs/2026-10-06-clinic-api-design.md
--- a/docs/specs/2026-10-06-clinic-api-design.md
+++ b/docs/specs/2026-10-06-clinic-api-design.md
@@ -10,7 +10,7 @@
 
 ## Цель
 
-Клиника заполняет в EasyMed свой профиль, филиалы, публичные профили врачей, услуги и пакеты — на трёх языках и со ссылками на общие справочники. Сайт клиники, Symptex и партнёры (med24.uz, clinics.uz и другие) получают эти данные по ключу через API и присылают заявки и онлайн-записи, которые попадают в CRM с источником этого ключа. Документация API — внутри «Настроек».
+Клиника заполняет в EasyMed свой профиль, филиалы, публичные профили врачей, услуги и пакеты — на трёх языках и со ссылками на общие справочники. Сайт клиники, Symptex и партнёры (med24.uz, clinics.uz и другие) получают эти данные по ключу через API и присылают заявки и онлайн-записи, которые попадают в CRM с источником этого ключа. ~~Документация API — внутри «Настроек».~~ → **изменено владельцем 2026-10-12 (решение 21):** документация API — одна публичная страница `https://api.easymed.uz/docs`; в «Настройках» — ссылка на неё.
 
 ## Решения владельца (2026-10-06)
 
@@ -76,6 +76,14 @@
 
 **Решение контролёра 2026-10-12** (вопрос 2 плана 8b, рекомендованный вариант): допуск часов компьютера клиники — **15 минут**. Часы сбиты сильнее — обмен с публичным сервером встаёт (401 `clock_skew` с временем сервера), пока часы не исправят: так перехваченный запрос клиники нельзя повторить позже. Понятная надпись «часы компьютера неверны» — шаг 8d. Настройка `PUBLIC_SYNC_SKEW_MIN`.
 
+**Решение владельца 2026-10-12 (шаг 9, документация API):**
+
+21. **Документация для партнёров — одна публичная страница `https://api.easymed.uz/docs`** на публичном сервере (служба `public-server/`, шаг 8b), а не страница внутри программы.
+    - Страница одна для всех клиник и всегда описывает работающий сервер: она строится из его кода.
+    - Страницы документации в программе нет, PDF нет.
+    - В программе, «Настройки → API и подключения», — только адрес API клиники и ссылка «Документация для партнёров» на эту страницу; в тексте «Скопировать всё» — ссылка и пример запроса `curl` с адресом клиники и подстановкой вместо ключа.
+    - Языки страницы — русский, узбекский, английский.
+
 ## Правила, без которых не строим (из проверки)
 
 - **Документы печатают прежние имена.** Клиника — `doc_settings.clinic_name`, врач — `users.full_name`, специальность — `users.specialty` (русская). Названия на uz/en добавляются рядом и идут только наружу.
@@ -99,7 +107,7 @@
 6. **Услуги и пакеты** — показ услуг по пяти группам; пакеты: отметка, имя на трёх языках, скидка процентом / суммой / ценой, общая раскладка, фиксация на строке, чек.
 7. **Экран API, ключи, источники CRM** — подключения, ключи (генерация, копирование, шифрование), права, вебхуки, журнал; источник CRM на ключ; удаление старых экранов.
 8. **Публичный сервер и онлайн-запись** — снимок наружу, очередь заявок, удержание и подтверждение (выбор карты регистратором), уведомления партнёрам, остановка при непродлённой лицензии.
-9. **Документация API** — страница в «Настройках».
+9. **Документация API** — ~~страница в «Настройках»~~ → публичная страница `https://api.easymed.uz/docs` и ссылка на неё в «API и подключения» (решение 21).
 
 ## Шаг 1 — существующие ошибки (CLINIC_API_FIX_V1)
 
```

- [ ] **Step 3: коммит** «План шага 9 API клиники: документация для партнёров — одна публичная страница api.easymed.uz/docs из кода публичного сервера, ссылка и команда проверки ключа в программе; решение владельца 21 в спецификации» — файлы: план и спецификация.

---

## Task 1: Адрес документации и команда `curl` — общий модуль (API_DOCS_V1)

Сборщик А. После коммита задачи начинает сборщик Б.

**Files:**
- Modify: `public/js/shared/api-connections.js` — `API_DOCS_PATH`, `API_DOCS_URL`, `API_DOCS_LANGS`, `apiDocsUrl(lang)`, `curlCommand()`.
- Modify: `public/js/shared/api-connections.test.js` — тест `API_DOCS_V1`.

- [ ] **Step 1: падающий тест** — diff к тесту:

```diff
diff --git a/public/js/shared/api-connections.test.js b/public/js/shared/api-connections.test.js
--- a/public/js/shared/api-connections.test.js
+++ b/public/js/shared/api-connections.test.js
@@ -155,3 +155,25 @@ test('DOCTOR_PROFILE_V1: «Свободное время» — на стольк
   assert.match(e.uz, /7, 14 yoki 30/);
   assert.match(e.en, /7, 14 or 30/);
 });
+
+// API_DOCS_V1 — решение владельца 21: документация — одна публичная страница
+// публичного сервера; программа клиники ссылается на неё и даёт пример запроса.
+test('API_DOCS_V1: адрес документации и её языков; curl — подстановка ключа, тело JSON, одна строка для «Скопировать всё»', async () => {
+  const { API_DOCS_URL, API_DOCS_PATH, apiDocsUrl, curlCommand } = await import('./api-connections.js');
+  assert.equal(API_DOCS_PATH, '/docs');
+  assert.equal(API_DOCS_URL, 'https://api.easymed.uz/docs');
+  assert.deepEqual(['ru', 'uz', 'en', 'de', undefined].map((l) => apiDocsUrl(l)),
+    ['https://api.easymed.uz/docs', 'https://api.easymed.uz/docs/uz', 'https://api.easymed.uz/docs/en', 'https://api.easymed.uz/docs', 'https://api.easymed.uz/docs']);
+  assert.equal(curlCommand({ url: 'https://api.easymed.uz/shifo/v1/clinic', key: '<ключ>', oneLine: true }),
+    'curl "https://api.easymed.uz/shifo/v1/clinic" -H "Authorization: Bearer <ключ>"');
+  const post = curlCommand({ method: 'POST', url: 'https://api.easymed.uz/shifo/v1/requests', key: '$EASYMED_KEY', body: { name: "O'g'il", n: 1 } });
+  assert.deepEqual(post.split('\n'), [
+    'curl -X POST "https://api.easymed.uz/shifo/v1/requests" \\',
+    '  -H "Authorization: Bearer $EASYMED_KEY" \\',
+    '  -H "Content-Type: application/json" \\',
+    "  -d '{",
+    '  "name": "O' + "'\\''" + 'g' + "'\\''" + 'il",',
+    '  "n": 1',
+    "}'",
+  ], 'апостроф в теле закрывает и снова открывает одинарные кавычки bash');
+});
```

- [ ] **Step 2:** `node --test public/js/shared/api-connections.test.js` → 11 прежних зелёные, новый красный: `actual: undefined, expected: '/docs'` (`API_DOCS_PATH` ещё нет).
- [ ] **Step 3: модуль** — diff:

```diff
diff --git a/public/js/shared/api-connections.js b/public/js/shared/api-connections.js
--- a/public/js/shared/api-connections.js
+++ b/public/js/shared/api-connections.js
@@ -258,3 +258,33 @@ export function keyExpiryState(expiresAt, now = Date.now()) {
   if (t <= now) return 'expired';
   return t - now <= EXPIRY_WARN_DAYS * 86400000 ? 'soon' : 'ok';
 }
+
+// ---- документация для партнёров (API_DOCS_V1) --------------------------------------
+// Решение владельца 21 (2026-10-12): документация — одна публичная страница
+// публичного сервера, одна на все клиники и всегда по текущему коду
+// (public-server/server/routes/docs.js). В программе клиники — только ссылка на
+// неё и пример запроса в тексте «Скопировать всё».
+export const API_DOCS_PATH = '/docs';
+export const API_DOCS_URL = 'https://' + API_HOST + API_DOCS_PATH;
+export const API_DOCS_LANGS = Object.freeze(['ru', 'uz', 'en']);
+/** Страница на языке lang: русская — /docs, узбекская и английская — /docs/uz, /docs/en. */
+export function apiDocsUrl(lang = 'ru') {
+  return API_DOCS_LANGS.includes(lang) && lang !== 'ru' ? API_DOCS_URL + '/' + lang : API_DOCS_URL;
+}
+
+const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
+/**
+ * Команда curl к API клиники — одна форма на документацию и «Скопировать всё».
+ * key — то, что встанет после «Bearer »: подстановка ($EASYMED_KEY, <ключ>), а
+ * не сам ключ. body — объект, уходит JSON. Многострочная — для bash
+ * (документация); oneLine — в одну строку: GET без тела понимают bash, zsh, cmd
+ * и PowerShell 7. В Windows PowerShell 5.1 (терминал Windows по умолчанию)
+ * «curl» — это Invoke-WebRequest, и строка падает на -H ещё до запроса: там
+ * пишут curl.exe. Команда остаётся «curl» (curl.exe нет на macOS и Linux), а
+ * «Скопировать всё» говорит про curl.exe в строке «Проверить ключ» (ревью шага 9, п. 7).
+ */
+export function curlCommand({ method = 'GET', url, key, body = undefined, oneLine = false } = {}) {
+  const parts = ['curl' + (method === 'GET' ? '' : ' -X ' + method) + ' "' + url + '"', '-H "Authorization: Bearer ' + key + '"'];
+  if (body !== undefined) parts.push('-H "Content-Type: application/json"', '-d ' + shQuote(JSON.stringify(body, null, oneLine ? 0 : 2)));
+  return parts.join(oneLine ? ' ' : ' \\\n  ');
+}
```

- [ ] **Step 4:** `node --test public/js/shared/api-connections.test.js` → **12 тестов** зелёные (и с `force-en.mjs`); сторожа А — зелёные.
- [ ] **Step 5: коммит** «Документация API для партнёров: адрес публичной страницы api.easymed.uz/docs и её языков, одна форма команды curl для страницы и «Скопировать всё» — подстановка вместо ключа, тело JSON с апострофом для bash, одна строка для bash и cmd» — оба файла. *(Коммит `fd6b7632` вышел с этой формулировкой; ревью шага 9, п. 7 уточнило: одна строка работает в bash, zsh, cmd и PowerShell 7, в Windows PowerShell 5.1 — curl.exe, и «Проверить ключ» это говорит — `9e66a223`.)* (точным блобом, если в клоне правят и другие шаги).

---

## Task 2: Числа и текст страницы, страж «документация не расходится с кодом» (API_DOCS_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/docs/facts.js`
- Create: `public-server/server/docs/content.js`
- Create: `public-server/server/docs/drift.test.js`

- [ ] **Step 1: падающий тест** `public-server/server/docs/drift.test.js`:

```js
// API_DOCS_V1 — СТРАЖ «ДОКУМЕНТАЦИЯ НЕ РАСХОДИТСЯ С КОДОМ». Страница /docs
// строится из docs/content.js и словарей кода; здесь — то, что связывает их:
//   • каждый адрес, который сервер партнёров регистрирует, описан, и ничего лишнего;
//   • права, статусы, причины, события, коды ошибок — те же списки, что в коде;
//   • каждая причина поля, которую может вернуть код, — в таблице полей;
//   • события клиники (services/api/bookings.js, visit-events.js) несут те статусы
//     и поля, что написаны в таблице событий;
//   • числа без постоянной в коде (ритм клиники) — те, что у программы клиники;
//   • пример проверки подписи считает ту же подпись, что ставит клиника;
//   • узбекский и английский — без кириллицы, узбекский апостроф — «‘».
// Что сервер на самом деле отвечает на примеры и пробы — docs/examples.http.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { partnerRouter } from '../routes/partner.js';
import { ERRORS } from '../lib/errors.js';
import { PARTNER_STATUSES } from '../store/requests.js';
import { SCOPES, EVENTS, API_DOCS_PATH } from '../../../public/js/shared/api-connections.js';
import { DECLINE_REASONS, PARTNER_STATUS, WEBHOOK_DETAIL_KEYS, EV, webhookBody } from '../../../public/js/shared/api-booking.js';
import { signBody } from '../../../server/services/api/outbox.js';
import { POLL_MS, SLOTS_EVERY_MS } from '../../../server/services/api/public-sync.js';
import * as C from './content.js';
import { CLINIC_RHYTHM } from './facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const REPO = path.resolve(SERVER, '..', '..');
const src = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const literals = (s) => [...s.matchAll(/'([A-Za-z_.]+)'/g)].map((m) => m[1]);

test('адреса: каждый маршрут сервера партнёров описан ровно один раз, описанное — есть у сервера', () => {
  const r = partnerRouter({ db: null, dataDir: '', now: () => 0, offsetMin: 300, baseUrl: 'https://api.easymed.uz' });
  const served = r.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => m.toUpperCase() + ' ' + l.route.path)).sort();
  const documented = C.ENDPOINTS.map((e) => e.method + ' ' + e.path.replace(/\{(\w+)\}/g, ':$1')).sort();
  assert.deepEqual(documented, served);
  const placed = C.SECTIONS.flatMap((s) => s.blocks.filter((b) => b.endpoint).map((b) => b.endpoint)).sort();
  assert.deepEqual(placed, C.ENDPOINTS.map((e) => e.id).sort(), 'каждый адрес — в одном разделе страницы');
  assert.equal(API_DOCS_PATH, '/docs', 'ссылка программы клиники ведёт на адрес страницы (routes/docs.js)');
});

test('примеры: каждый показан на странице, каждый показанный — есть', () => {
  const used = [...C.ENDPOINTS.flatMap((e) => e.examples), ...C.SECTIONS.flatMap((s) => s.blocks.filter((b) => b.example).map((b) => b.example))];
  const ids = C.EXAMPLES.map((x) => x.id);
  assert.deepEqual([...new Set(used)].sort(), [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('права: у каждого права есть адрес, у каждого адреса — права из словаря шага 7', () => {
  for (const e of C.ENDPOINTS) if (e.scopes) for (const s of e.scopes) assert.ok(SCOPES.includes(s), e.id + ': ' + s);
  for (const s of SCOPES) assert.ok(C.ENDPOINTS.some((e) => e.scopes && e.scopes.includes(s)), 'право без адреса: ' + s);
});

test('статусы и причины: те же, что у сервера; причины closed ставит только сервер', () => {
  assert.deepEqual(Object.keys(C.STATUS_TEXT), [...PARTNER_STATUSES]);
  for (const s of Object.values(PARTNER_STATUS)) assert.ok(PARTNER_STATUSES.includes(s), 'статус клиники без строки: ' + s);
  assert.deepEqual(Object.keys(C.REASON_TEXT), [...DECLINE_REASONS, ...C.CLOSED_REASONS]);
  const set = [...new Set([...src('public-server/server/store/requests.js').matchAll(/reason = '(\w+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(set, [...C.CLOSED_REASONS].sort());
  for (const [r, v] of Object.entries(C.REASON_TEXT)) assert.ok(PARTNER_STATUSES.includes(v.status), r);
});

test('события: словарь шага 7; статусы и поля — как их шлёт клиника (bookings.js, visit-events.js)', () => {
  assert.deepEqual(Object.keys(C.EVENT_TEXT), [...EVENTS]);
  for (const [ev, v] of Object.entries(C.EVENT_TEXT)) {
    for (const s of v.statuses) assert.ok(PARTNER_STATUSES.includes(s), ev + ': ' + s);
    for (const f of v.fields) assert.ok(WEBHOOK_DETAIL_KEYS.includes(f), ev + ': ' + f);
  }
  const keysOf = (d) => (d ? d.split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean) : []);
  const found = [];
  const bookings = src('server/services/api/bookings.js');
  for (const m of bookings.matchAll(/event: EV\.(\w+), status(?:: '(\w+)')?,\s*(?:details: \{([^}]*)\})?/g)) found.push([EV[m[1]], m[2], keysOf(m[3])]);
  for (const m of src('server/services/api/visit-events.js').matchAll(/EV\.(\w+), '(\w+)', \{([^}]*)\}/g)) found.push([EV[m[1]], m[2], keysOf(m[3])]);
  assert.ok(found.length >= 14, 'разбор вызовов enqueueEvent/emit сломался: ' + found.length);
  for (const [ev, status, keys] of found) {
    const doc = C.EVENT_TEXT[ev];
    assert.ok(doc, 'событие без строки: ' + ev);
    if (status) assert.ok(doc.statuses.includes(PARTNER_STATUS[status]), ev + ' шлёт ' + PARTNER_STATUS[status]);
    for (const k of keys) assert.ok(doc.fields.includes(k), ev + ' шлёт поле ' + k);
  }
  assert.match(src('server/services/api/outbox.js'), /occurredAt: isoOf\(now\)/, 'occurred_at — в UTC, как написано');
  assert.match(C.WEBHOOK_EXAMPLE.occurredAt, /Z$/);
});

test('коды ошибок: каждый код lib/errors.js — либо в таблице партнёра, либо только у канала клиники; код партнёрских адресов — в таблице', () => {
  const partner = Object.keys(C.ERROR_TEXT);
  assert.deepEqual([...partner, ...C.CLINIC_ONLY_ERRORS].sort(), Object.keys(ERRORS).sort());
  assert.equal(new Set([...partner, ...C.CLINIC_ONLY_ERRORS]).size, Object.keys(ERRORS).length, 'код и там и там');
  const files = ['routes/partner.js', 'routes/partner-auth.js', 'routes/partner-read.js', 'routes/partner-write.js', 'lib/errors.js', 'app.js', 'store/requests.js'];
  for (const f of files) {
    const s = src('public-server/server/' + f);
    const codes = [...s.matchAll(/sendError\([^,]+, [^,]+, '(\w+)'/g), ...s.matchAll(/FieldError\('(\w+)'/g), ...s.matchAll(/error: '(\w+)'/g)].map((m) => m[1]);
    for (const c of codes) assert.ok(partner.includes(c), f + ': код ' + c + ' не описан для партнёров');
  }
});

test('причины полей: каждую, которую может вернуть код чтения и записи, описывает таблица полей', () => {
  const documented = new Set(C.FIELD_ERRORS.map((f) => f.field + '/' + (f.reason || f.code)));
  const docReasons = new Set(C.FIELD_ERRORS.map((f) => f.reason).filter(Boolean));
  const pairs = [];
  const read = src('public-server/server/routes/partner-read.js');
  for (const m of read.matchAll(/\bbad\(req, res, ([^)]*)\)/g)) {
    const [field, ...reasons] = literals(m[1]);
    for (const r of reasons) pairs.push(field + '/' + r);
  }
  for (const m of read.matchAll(/'not_found', \{ field: '(\w+)' \}/g)) pairs.push(m[1] + '/not_found');
  const write = src('public-server/server/routes/partner-write.js');
  const wild = [];
  for (const m of write.matchAll(/\bfield\(([^)]*)\)/g)) {
    const args = m[1].trim();
    const lits = literals(args);
    if (/^prefix \+ '/.test(args)) for (const r of lits.slice(1)) pairs.push('patient.' + lits[0] + '/' + r);
    else if (/^'/.test(args)) for (const r of lits.slice(1)) pairs.push(lits[0] + '/' + r);
    else wild.push(...lits);   // pick(name): field(name, 'format')
  }
  for (const m of write.matchAll(/pick\('(\w+)', (null|[^)]*)\)/g)) {
    pairs.push(m[1] + '/format');
    if (m[2] !== 'null') pairs.push(m[1] + '/not_found');
  }
  assert.ok(pairs.length >= 30, 'разбор кода полей сломался: ' + pairs.length);
  for (const p of pairs) assert.ok(documented.has(p), 'причина поля не описана: ' + p);
  for (const r of wild) assert.ok(docReasons.has(r), 'причина не описана: ' + r);
  for (const f of C.FIELD_ERRORS) {
    assert.ok(f.reason || f.code === 'not_found', f.field);
    for (const ep of Object.keys(f.probes)) assert.ok(C.ENDPOINTS.some((e) => e.id === ep), f.field + ': ' + ep);
  }
});

test('ритм клиники в тексте — тот, что у программы клиники (public-sync.js)', () => {
  assert.equal(CLINIC_RHYTHM.pollSec * 1000, POLL_MS);
  assert.equal(CLINIC_RHYTHM.slotsEveryMin * 60000, SLOTS_EVERY_MS, 'текст говорит «раз в минуту»');
  assert.equal(SLOTS_EVERY_MS, 60000);
});

test('уведомление: тело — webhookBody программы, заголовки — те, что шлёт доставка; пример проверки подписи принимает подпись клиники', () => {
  const raw = JSON.stringify(webhookBody(C.WEBHOOK_EXAMPLE));
  const body = JSON.parse(raw);
  assert.ok(EVENTS.includes(body.event) && C.EVENT_TEXT[body.event].statuses.includes(body.status));
  for (const k of Object.keys(C.WEBHOOK_EXAMPLE.details)) assert.ok(C.EVENT_TEXT[body.event].fields.includes(k), k);
  const sent = src('public-server/server/store/deliveries.js');
  for (const h of ["'Content-Type': 'application/json'", "'X-EasyMed-Signature'", "'X-EasyMed-Event'", "'X-EasyMed-Event-Id'"]) assert.ok(sent.includes(h), h);
  const signatureOk = new Function('require', C.VERIFY_NODE + '\nreturn signatureOk;')((m) => (m === 'node:crypto' ? crypto : null));
  const sig = signBody(C.WEBHOOK_EXAMPLE.secret, raw);
  assert.equal(signatureOk(Buffer.from(raw), sig, C.WEBHOOK_EXAMPLE.secret), true);
  assert.equal(signatureOk(Buffer.from(raw + ' '), sig, C.WEBHOOK_EXAMPLE.secret), false);
  assert.equal(signatureOk(Buffer.from(raw), undefined, C.WEBHOOK_EXAMPLE.secret), false);
  for (const s of ["hash_hmac('sha256', $raw, $secret)", 'hash_equals(', 'HTTP_X_EASYMED_SIGNATURE', "'sha256='"]) assert.ok(C.VERIFY_PHP.includes(s), s);
});

test('тексты: у каждого ru / uz / en; узбекский и английский — без кириллицы; узбекский апостроф — «‘»', () => {
  const bad = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, where + '[' + i + ']'));
    if (!v || typeof v !== 'object') return;
    if (Object.keys(v).join() === 'ru,uz,en') {
      if (!v.ru || !v.uz || !v.en) bad.push(where + ': пусто');
      for (const l of ['uz', 'en']) if (/[Ѐ-ӿ]/.test(v[l])) bad.push(where + ' ' + l + ': ' + v[l]);
      if (/[oOgG]['ʻ]/.test(v.uz)) bad.push(where + ' uz апостроф: ' + v.uz);
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, where + '.' + k);
  };
  for (const [k, v] of Object.entries(C)) walk(v, k);
  assert.deepEqual(bad, []);
});
```

- [ ] **Step 2:** `node --test public-server/server/docs/drift.test.js` → падает при загрузке: `Cannot find module …/docs/content.js`.
- [ ] **Step 3: числа** `public-server/server/docs/facts.js`:

```js
// API_DOCS_V1 — ЧИСЛА ДОКУМЕНТАЦИИ ИЗ КОДА. Каждое число страницы /docs берётся
// здесь из той постоянной, по которой работает сервер, — руками на странице
// чисел нет. Три группы чисел постоянной в коде не имеют (правила полей
// пациента, Max-Age CORS, ритм обмена клиники) — их держит страж
// docs/drift.test.js: пробой настоящего сервера и сверкой с постоянными
// программы клиники (server/services/api/public-sync.js).
import { RATE_LIMITS, KEY_TTLS, KEY_PREFIX, SECRET_PREFIX } from '../../../public/js/shared/api-connections.js';
import { HOLD_MINUTES, OFFER_MINUTES } from '../../../public/js/shared/api-booking.js';
import { BOOKING_DAYS, DEFAULT_BOOKING_DAYS } from '../../../public/js/shared/doctor-public.js';
import { IP_LIMIT_PER_MIN, AUTH_FAIL_LIMIT_PER_MIN, WRITE_LIMIT_PER_MIN, CLINIC_SILENT_MAX_MS } from '../routes/partner-auth.js';
import { PARTNER_BODY_LIMIT } from '../routes/partner.js';
import { STALE_AFTER_MS, STALE_DATA_MS } from '../routes/partner-read.js';
import { SLOT_MIN } from '../lib/slot-check.js';
import { WEBHOOK_TIMEOUT_MS, USER_AGENT } from '../lib/webhook-send.js';
import { RETRY_MINUTES, MAX_ATTEMPTS, DELIVERY_WINDOW_MS, HOST_TRIP_AFTER, HOST_BACKOFF_FIRST_MS, HOST_BACKOFF_MS } from '../store/deliveries.js';
import { ANSWER_TIMEOUT_MS, UNCOLLECTED_MAX_MS, REQUEST_KEEP_MS } from '../store/requests.js';
import { SLUG_ALIAS_DAYS } from '../store/clinics.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Ритм обмена программы клиники (public-sync.js POLL_MS, SLOTS_EVERY_MS: «раз в минуту» в тексте) — сверяет страж. */
export const CLINIC_RHYTHM = Object.freeze({ pollSec: 15, slotsEveryMin: 1 });
/** Поля пациента и номер партнёра (routes/partner-write.js) — границы проверяют пробы стража. */
export const PATIENT_RULES = Object.freeze({ nameMax: 120, phoneMax: 32, phoneDigitsMin: 7, commentMax: 1000, externalMax: 64 });
/** Сколько браузер помнит ответ на предварительный запрос (routes/partner-auth.js Access-Control-Max-Age). */
export const CORS_MAX_AGE_SEC = 600;

/**
 * Числа страницы. base — адрес сервера (ctx.baseUrl), uncollectedMaxMs — срок
 * не забранной заявки из настроек службы (PUBLIC_UNCOLLECTED_MAX_HOURS).
 */
export function docFacts({ base = 'https://api.easymed.uz', uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
  return Object.freeze({
    base, slug: 'shifo', keyPrefix: KEY_PREFIX, secretPrefix: SECRET_PREFIX,
    rateLimits: RATE_LIMITS, writePerMin: WRITE_LIMIT_PER_MIN, authFailPerMin: AUTH_FAIL_LIMIT_PER_MIN, ipPerMin: IP_LIMIT_PER_MIN,
    bodyKb: parseInt(PARTNER_BODY_LIMIT, 10),
    keyTtlMonths: KEY_TTLS.filter((t) => t !== 'never').map((t) => parseInt(t, 10) * (t.endsWith('y') ? 12 : 1)),
    slugAliasDays: SLUG_ALIAS_DAYS, slotMin: SLOT_MIN, bookingDays: BOOKING_DAYS, defaultBookingDays: DEFAULT_BOOKING_DAYS,
    holdMin: HOLD_MINUTES, offerMin: OFFER_MINUTES, answerMin: ANSWER_TIMEOUT_MS / MIN, uncollectedHours: uncollectedMaxMs / HOUR,
    keepDays: REQUEST_KEEP_MS / DAY, staleMin: STALE_AFTER_MS / MIN, staleDataMin: STALE_DATA_MS / MIN, silentDays: CLINIC_SILENT_MAX_MS / DAY,
    webhookTimeoutSec: WEBHOOK_TIMEOUT_MS / 1000, userAgent: USER_AGENT, retryMinutes: RETRY_MINUTES, attempts: MAX_ATTEMPTS,
    windowMin: DELIVERY_WINDOW_MS / MIN, hostTripAfter: HOST_TRIP_AFTER, hostRestFirstSec: HOST_BACKOFF_FIRST_MS / 1000, hostRestMaxSec: HOST_BACKOFF_MS / 1000,
    corsMaxAgeMin: CORS_MAX_AGE_SEC / 60,
    clinicPollSec: CLINIC_RHYTHM.pollSec,
    ...PATIENT_RULES,
  });
}
```

- [ ] **Step 4: текст страницы** `public-server/server/docs/content.js`:

```js
// API_DOCS_V1 — ДОКУМЕНТАЦИЯ API ДЛЯ ПАРТНЁРОВ: текст и устройство страницы
// /docs (решение владельца 21, 2026-10-12: одна публичная страница на все
// клиники, всегда по работающему коду).
//
// Здесь — только то, что пишет человек: пояснения на ru / uz / en, какие адреса
// в каком разделе, какие запросы показать примером. Всё, что знает код, страница
// берёт из кода, а не отсюда:
//   • числа (лимиты, сроки, повторы) — docs/facts.js из постоянных сервера;
//   • права, события, группы услуг — словари программы (shared/api-connections.js,
//     shared/service-public.js), переводы их подписей — docs/generated.js;
//   • статусы — store/requests.js PARTNER_STATUSES, причины — DECLINE_REASONS;
//   • коды ошибок, HTTP-коды и тексты — lib/errors.js ERRORS;
//   • ответы примеров — то, что сервер ответил на эти запросы (docs/generated.js,
//     `node public-server/scripts/docs-build.mjs`);
//   • тело уведомления — shared/api-booking.js webhookBody, подпись — та же
//     функция, что у клиники (services/api/outbox.js signBody).
// Страж docs/drift.test.js не даёт этому файлу разойтись с кодом: адреса
// сервера, права, статусы, причины, события, коды ошибок и причины полей — все
// здесь. Каждая строка таблицы полей проверена настоящим сервером
// (docs/examples.http.test.js), каждая команда страницы — тоже, вместе с ответом
// под ней (docs/page-curl.http.test.js).
//
// Разметка текста: `код`, [ссылка](#якорь | mailto:…), {{число}} из docs/facts.js —
// {{имя:единица}} с падежом (sec, min, hour, day, time, attempt — render.js
// UNITS), {{имя|or}} — список через «или».
export const L = (ru, uz, en) => Object.freeze({ ru, uz, en });

/** Контакт Easy-Med для разработчиков партнёров (вопрос владельцу плана шага 9). */
export const DOCS_CONTACT = 'hello@easymed.uz';
/** Клиника примеров и номера её заявок на странице (настоящие номера сервер выдаёт случайно). */
export const SAMPLE = Object.freeze({
  base: 'https://api.easymed.uz', slug: 'shifo', keyVar: '$EASYMED_KEY',
  ids: Object.freeze({ callback: 'rq_Shf7Qk2Lm9Xc4Vb8Nz3Wd5Ta', appointment: 'rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce' }),
});

export const PAGE = Object.freeze({
  title: L('API Easy-Med — документация для партнёров', 'Easy-Med API — hamkorlar uchun hujjatlar', 'Easy-Med API — documentation for partners'),
  description: L('Как получать врачей, свободное время, услуги и цены клиник Easy-Med и присылать заявки и онлайн-записи.',
    'Easy-Med klinikalarining shifokorlari, bo‘sh vaqti, xizmatlari va narxlarini olish hamda ariza va onlayn yozilish yuborish.',
    'How to get the doctors, free time, services and prices of Easy-Med clinics and send requests and online bookings.'),
  lead: L('Сайт клиники, Symptex и партнёры получают отсюда данные клиник Easy-Med — врачей, свободное время, услуги и цены — и присылают заявки и онлайн-записи пациентов. Страница одна для всех клиник и всегда описывает работающий сервер.',
    'Klinika sayti, Symptex va hamkorlar bu yerdan Easy-Med klinikalarining ma’lumotlarini — shifokorlar, bo‘sh vaqt, xizmatlar va narxlarni — oladi hamda bemorlarning arizalari va onlayn yozilishlarini yuboradi. Sahifa barcha klinikalar uchun bitta va har doim ishlayotgan serverni tavsiflaydi.',
    'A clinic website, Symptex and partners get the data of Easy-Med clinics here — doctors, free time, services and prices — and send patients’ requests and online bookings. One page for all clinics, always describing the live server.'),
  skip: L('Перейти к тексту', 'Matnga o‘tish', 'Skip to content'),
  toc: L('Содержание', 'Mundarija', 'Contents'),
  langs: L('Язык страницы', 'Sahifa tili', 'Page language'),
  request: L('Запрос', 'So‘rov', 'Request'),
  response: L('Ответ', 'Javob', 'Response'),
  trimmed: L('Ответ сокращён: в настоящем — все строки.', 'Javob qisqartirilgan: haqiqiysida barcha qatorlar bor.', 'Response shortened: the real one has every row.'),
  scope: L('Право', 'Huquq', 'Scope'),
  anyKey: L('любой ключ', 'istalgan kalit', 'any key'),
  noKey: L('без ключа', 'kalitsiz', 'no key'),
  orWord: L('или', 'yoki', 'or'),
  params: L('Параметры', 'Parametrlar', 'Parameters'),
  paramHead: [L('Параметр', 'Parametr', 'Parameter'), L('Где', 'Qayerda', 'In'), L('Обязателен', 'Majburiy', 'Required'), L('Значение', 'Qiymat', 'Value')],
  where: { query: L('адрес', 'manzil', 'query'), body: L('тело', 'tana', 'body'), path: L('путь', 'yo‘l', 'path') },
  yes: L('да', 'ha', 'yes'),
  no: L('нет', 'yo‘q', 'no'),
  footer: L('Ключ, права и адрес клиники выдаёт сама клиника. Вопросы по API — [{{contact}}](mailto:{{contact}}).',
    'Kalit, huquqlar va klinika manzilini klinikaning o‘zi beradi. API bo‘yicha savollar — [{{contact}}](mailto:{{contact}}).',
    'The clinic itself issues the key, scopes and clinic address. Questions about the API — [{{contact}}](mailto:{{contact}}).'),
  hookRequest: L('Запрос на ваш адрес', 'Sizning manzilingizga so‘rov', 'The request to your address'),
  langName: Object.freeze({ ru: 'Русский', uz: 'O‘zbekcha', en: 'English' }),
  vector: L('Подпись примера посчитана секретом `{{secret}}` — проверьте на нём свой код.', 'Misol imzosi `{{secret}}` siri bilan hisoblangan — kodingizni shunda tekshiring.', 'The sample signature uses the secret `{{secret}}` — test your code on it.'),
});

/** Лимиты: подписи строк; числа — docs/facts.js. */
export const LIMIT_ROWS = Object.freeze([
  [L('Запросов одним ключом', 'Bitta kalit bilan so‘rovlar', 'Requests per key'), L('{{rateLimits|or}} в минуту — столько, сколько клиника выбрала подключению', 'daqiqasiga {{rateLimits|or}} — klinika ulanishga qancha tanlagan bo‘lsa', '{{rateLimits|or}} a minute — whatever the clinic chose for the connection')],
  [L('Заявок и записей (`POST`, `DELETE`) одним ключом', 'Bitta kalit bilan arizalar va yozuvlar (`POST`, `DELETE`)', 'Requests and bookings (`POST`, `DELETE`) per key'), L('{{writePerMin}} в минуту', 'daqiqasiga {{writePerMin}}', '{{writePerMin}} a minute')],
  [L('Неверных ключей с одного IP', 'Bitta IP dan noto‘g‘ri kalitlar', 'Wrong keys from one IP'), L('{{authFailPerMin}} в минуту', 'daqiqasiga {{authFailPerMin}}', '{{authFailPerMin}} a minute')],
  [L('Всех запросов с одного IP', 'Bitta IP dan barcha so‘rovlar', 'All requests from one IP'), L('{{ipPerMin}} в минуту', 'daqiqasiga {{ipPerMin}}', '{{ipPerMin}} a minute')],
  [L('Тело запроса', 'So‘rov tanasi', 'Request body'), L('{{bodyKb}} КБ', '{{bodyKb}} KB', '{{bodyKb}} KB')],
]);

/** Таблицы, которые страница собирает из словарей кода. */
export const TABLE_HEAD = Object.freeze({
  scopes: [L('Право', 'Huquq', 'Scope'), L('Раздел', 'Bo‘lim', 'Section'), L('Что открывает', 'Nimani ochadi', 'What it opens'), L('Адреса', 'Manzillar', 'Endpoints')],
  groups: [L('Код', 'Kod', 'Code'), L('Группа', 'Guruh', 'Group')],
  statuses: [L('Статус', 'Holat', 'Status'), L('У чего', 'Nimada', 'Applies to'), L('Что значит', 'Ma’nosi', 'Meaning')],
  reasons: [L('Причина', 'Sabab', 'Reason'), L('Статус', 'Holat', 'Status'), L('Что значит', 'Ma’nosi', 'Meaning')],
  events: [L('Событие', 'Hodisa', 'Event'), L('Когда', 'Qachon', 'When'), L('Статус', 'Holat', 'Status'), L('Поля сверх общих', 'Umumiydan tashqari maydonlar', 'Fields beyond the common ones')],
  errors: [L('HTTP', 'HTTP', 'HTTP'), L('Код', 'Kod', 'Code'), L('Текст ответа', 'Javob matni', 'Message'), L('Что делать', 'Nima qilish kerak', 'What to do')],
  fields: [L('Поле', 'Maydon', 'Field'), L('Причина', 'Sabab', 'Reason'), L('Где', 'Qayerda', 'Where'), L('Что не так', 'Nima noto‘g‘ri', 'What is wrong')],
  limits: [L('Что', 'Nima', 'What'), L('Сколько', 'Qancha', 'How much')],
});
export const KIND_TEXT = Object.freeze({
  request: L('заявка «перезвоните»', '«qayta qo‘ng‘iroq» arizasi', 'callback request'),
  appointment: L('онлайн-запись', 'onlayn yozilish', 'online booking'),
  both: L('обе', 'ikkalasi', 'both'),
});

// ---- адреса ----------------------------------------------------------------------------
const qLang = { name: 'lang', in: 'query', req: false, value: L('`ru`, `uz` или `en`', '`ru`, `uz` yoki `en`', '`ru`, `uz` or `en`') };
const patient = [
  { name: 'patient.name', in: 'body', req: true, value: L('имя пациента, до {{nameMax}} знаков', 'bemor ismi, {{nameMax}} belgigacha', 'patient’s name, up to {{nameMax}} characters') },
  { name: 'patient.phone', in: 'body', req: true, value: L('телефон, до {{phoneMax}} знаков и хотя бы {{phoneDigitsMin}} цифр, лучше `+998…`', 'telefon, {{phoneMax}} belgigacha va kamida {{phoneDigitsMin}} ta raqam, yaxshisi `+998…`', 'phone, up to {{phoneMax}} characters with at least {{phoneDigitsMin}} digits, preferably `+998…`') },
  { name: 'patient.comment', in: 'body', req: false, value: L('комментарий, до {{commentMax}} знаков', 'izoh, {{commentMax}} belgigacha', 'comment, up to {{commentMax}} characters') },
];
const common = [
  { name: 'external_id', in: 'body', req: false, value: L('ваш номер заявки: до {{externalMax}} видимых латинских знаков, без пробелов', 'arizaning sizdagi raqami: {{externalMax}} tagacha ko‘rinadigan lotin belgisi, bo‘sh joysiz', 'your own request number: up to {{externalMax}} visible Latin characters, no spaces') },
  { name: 'lang', in: 'body', req: false, value: L('язык пациента: `ru`, `uz` или `en`', 'bemor tili: `ru`, `uz` yoki `en`', 'the patient’s language: `ru`, `uz` or `en`') },
];
const pathId = { name: 'id', in: 'path', req: true, value: L('`request_id` из ответа на заявку', 'ariza javobidagi `request_id`', 'the `request_id` from the request response') };

export const ENDPOINTS = Object.freeze([
  { id: 'geo', section: 'refs', method: 'GET', path: '/reference/geo', scopes: [], examples: ['geo'],
    summary: L('Страны и города / области Узбекистана с районами: код и название на трёх языках. Эти коды приходят в полях `country`, `city`, `district`.',
      'Mamlakatlar va O‘zbekistonning shahar / viloyatlari tumanlari bilan: kod va uch tildagi nom. Bu kodlar `country`, `city`, `district` maydonlarida keladi.',
      'Countries and the cities / regions of Uzbekistan with their districts: code and name in three languages. These codes come in the `country`, `city`, `district` fields.'),
    params: [qLang] },
  { id: 'specialties', section: 'refs', method: 'GET', path: '/reference/specialties', scopes: [], examples: ['specialties'],
    summary: L('Специальности врачей: код и название на трёх языках.', 'Shifokor mutaxassisliklari: kod va uch tildagi nom.', 'Doctor specialties: code and name in three languages.'),
    params: [qLang] },
  { id: 'clinic', section: 'clinic', method: 'GET', path: '/clinic', scopes: ['clinic'], examples: ['clinic'],
    summary: L('Карточка клиники: название, описание, адрес главного здания (страна, город и район — кодами справочника, полный адрес — строкой), телефон, сайт, Telegram, Instagram, логотипы, карта и маршрут.',
      'Klinika kartochkasi: nomi, tavsifi, bosh bino manzili (mamlakat, shahar va tuman — ma’lumotnoma kodlari, to‘liq manzil — satr), telefon, sayt, Telegram, Instagram, logotiplar, xarita va yo‘nalish.',
      'The clinic card: name, description, main building address (country, city and district as reference codes, the full address as a string), phone, website, Telegram, Instagram, logos, map and directions.'),
    params: [qLang],
    notes: [L('`logo.square` и `logo.portrait` — ссылки на файлы или `null`, если логотипа нет.', '`logo.square` va `logo.portrait` — fayllarga havolalar yoki logotip bo‘lmasa `null`.', '`logo.square` and `logo.portrait` are file links, or `null` when there is no logo.')] },
  { id: 'branches', section: 'clinic', method: 'GET', path: '/branches', scopes: ['branches'], examples: ['branches'],
    summary: L('Филиалы: название, город и район кодами, улица и ориентир, полный адрес, телефон, часы работы, карта и маршрут.',
      'Filiallar: nomi, shahar va tuman kodlari, ko‘cha va mo‘ljal, to‘liq manzil, telefon, ish soatlari, xarita va yo‘nalish.',
      'Branches: name, city and district codes, street and landmark, full address, phone, working hours, map and directions.'),
    params: [
      { name: 'city', in: 'query', req: false, value: L('код города из `/reference/geo`', '`/reference/geo` dagi shahar kodi', 'a city code from `/reference/geo`') },
      { name: 'district', in: 'query', req: false, value: L('код района из `/reference/geo`', '`/reference/geo` dagi tuman kodi', 'a district code from `/reference/geo`') },
      qLang],
    notes: [L('`hours` — по дням недели (`mon` … `sun`): `["08:00", "18:00"]` или `null` — выходной. `open_24_7: true` — круглосуточно.',
      '`hours` — hafta kunlari bo‘yicha (`mon` … `sun`): `["08:00", "18:00"]` yoki `null` — dam olish kuni. `open_24_7: true` — kecha-kunduz.',
      '`hours` — per weekday (`mon` … `sun`): `["08:00", "18:00"]`, or `null` for a day off. `open_24_7: true` means round the clock.')] },
  { id: 'media', section: 'clinic', method: 'GET', path: '/media/{file}', scopes: null, examples: [],
    summary: L('Файл снимка — логотип или фото врача. Ссылки приходят готовыми в `/clinic` и `/doctors`.', 'Surat fayli — logotip yoki shifokor fotosi. Havolalar `/clinic` va `/doctors` da tayyor keladi.', 'A snapshot file — a logo or a doctor photo. The links come ready-made in `/clinic` and `/doctors`.'),
    params: [{ name: 'file', in: 'path', req: true, value: L('`<sha256>.<png|jpg|webp>` из ссылки', 'havoladagi `<sha256>.<png|jpg|webp>`', '`<sha256>.<png|jpg|webp>` from the link') }],
    notes: [L('Ключ не нужен: картинку на вашем сайте браузер загрузит сам. Кэш — сутки; новый файл — новая ссылка.',
      'Kalit kerak emas: rasmni saytingizda brauzer o‘zi yuklaydi. Kesh — bir sutka; yangi fayl — yangi havola.',
      'No key needed: the browser loads the picture on your site by itself. Cached for a day; a new file gets a new link.')] },
  { id: 'doctors', section: 'doctors', method: 'GET', path: '/doctors', scopes: ['doctors'], examples: ['doctors'],
    summary: L('Врачи, которых клиника показывает: ФИО, должность, о враче, специальности, стаж, языки приёма, фото, филиалы, как принимает и цены.',
      'Klinika ko‘rsatadigan shifokorlar: F.I.Sh., lavozimi, shifokor haqida, mutaxassisliklari, tajribasi, qabul tillari, fotosi, filiallari, qanday qabul qilishi va narxlar.',
      'The doctors the clinic shows: full name, title, about, specialties, experience, languages, photo, branches, how they see patients and prices.'),
    params: [
      { name: 'branch_id', in: 'query', req: false, value: L('номер филиала из `/branches`', '`/branches` dagi filial raqami', 'a branch number from `/branches`') },
      { name: 'specialty', in: 'query', req: false, value: L('код специальности из `/reference/specialties`', '`/reference/specialties` dagi mutaxassislik kodi', 'a specialty code from `/reference/specialties`') },
      { name: 'district', in: 'query', req: false, value: L('код района: врачи филиалов этого района', 'tuman kodi: shu tumandagi filiallar shifokorlari', 'a district code: doctors of the branches in that district') },
      { name: 'city', in: 'query', req: false, value: L('код города', 'shahar kodi', 'a city code') },
      qLang],
    notes: [
      L('`specialties` — коды справочника, первая — основная (не больше четырёх).', '`specialties` — ma’lumotnoma kodlari, birinchisi — asosiysi (to‘rttagacha).', '`specialties` — reference codes, the first one is the main one (up to four).'),
      L('`reception`: `booking` — по записи на время, `live_queue` — живая очередь (записи на время нет).', '`reception`: `booking` — vaqtga yozilish bo‘yicha, `live_queue` — jonli navbat (vaqtga yozilish yo‘q).', '`reception`: `booking` — by appointment, `live_queue` — walk-in queue (no timed booking).'),
      L('`booking_days` — на сколько дней вперёд открыта запись: {{bookingDays|or}}.', '`booking_days` — yozilish necha kun oldinga ochiq: {{bookingDays|or}}.', '`booking_days` — how many days ahead booking is open: {{bookingDays|or}}.'),
      L('`consultations` — виды приёма `initial` (первичный) и `repeat` (повторный) с ценой и длительностью в минутах; `services` — услуги группы «Консультации», которые ведёт врач, с его ценой.',
        '`consultations` — `initial` (birlamchi) va `repeat` (takroriy) qabul turlari narxi va daqiqalardagi davomiyligi bilan; `services` — shifokor olib boradigan «Konsultatsiyalar» guruhi xizmatlari uning narxi bilan.',
        '`consultations` — the visit types `initial` and `repeat` with price and length in minutes; `services` — services of the “Consultations” group the doctor provides, at the doctor’s price.')] },
  { id: 'slots', section: 'doctors', method: 'GET', path: '/slots', scopes: ['slots'], examples: ['slots-day', 'slots-fit', 'slots-live'],
    summary: L('Свободное время врача: окна по {{slotMin:min}}.', 'Shifokorning bo‘sh vaqti: {{slotMin:min}}lik oynalar.', 'A doctor’s free time in {{slotMin}}-minute windows.'),
    params: [
      { name: 'doctor_id', in: 'query', req: true, value: L('номер врача из `/doctors`', '`/doctors` dagi shifokor raqami', 'a doctor number from `/doctors`') },
      { name: 'date', in: 'query', req: false, value: L('`ГГГГ-ММ-ДД`; без даты — все дни, на которые открыта запись', '`YYYY-OO-KK`; sanasiz — yozilish ochiq bo‘lgan barcha kunlar', '`YYYY-MM-DD`; without it — every day open for booking') },
      { name: 'consultation', in: 'query', req: false, value: L('`initial` или `repeat`: только начала, где поместится этот приём', '`initial` yoki `repeat`: faqat shu qabul sig‘adigan boshlanishlar', '`initial` or `repeat`: only the starts where this visit fits') },
      { name: 'service_id', in: 'query', req: false, value: L('номер услуги: только начала, где она поместится', 'xizmat raqami: faqat u sig‘adigan boshlanishlar', 'a service number: only the starts where it fits') }],
    notes: [
      L('С `consultation` или `service_id` остаются только начала, после которых свободно столько окон подряд, сколько длится приём; без них — каждое окно с `free`.',
        '`consultation` yoki `service_id` bilan faqat qabul davomiyligicha ketma-ket bo‘sh oynalar bor boshlanishlar qoladi; ularsiz — har bir oyna `free` bilan.',
        'With `consultation` or `service_id` only the starts followed by enough free windows for the whole visit remain; without them every window comes with `free`.'),
      L('Сегодняшнее прошедшее время — не свободно. Свободное время — подсказка: окончательно его проверяет клиника, принимая запись.',
        'Bugungi o‘tgan vaqt — bo‘sh emas. Bo‘sh vaqt — maslahat: uni yozuvni qabul qilayotgan klinika yakuniy tekshiradi.',
        'Earlier today is never free. Free time is a hint: the clinic checks it for good when it takes the booking.'),
      L('`stale: true` — клиника молчит дольше {{staleMin:min}} или её данные старше {{staleDataMin:min}}: показывайте время с оговоркой; запись всё равно принимается.',
        '`stale: true` — klinika {{staleMin:min}}dan ko‘proq jim yoki ma’lumotlari {{staleDataMin:min}}dan eski: vaqtni izoh bilan ko‘rsating; yozilish baribir qabul qilinadi.',
        '`stale: true` — the clinic has been silent for over {{staleMin:min}} or its data is older than {{staleDataMin:min}}: show the time with a caveat; bookings are still accepted.'),
      L('Живая очередь: времени нет — `hours` (часы приёма) и `queue_now` (сколько ждут сейчас; `null`, если клиника очередь не показывает).',
        'Jonli navbat: vaqt yo‘q — `hours` (qabul soatlari) va `queue_now` (hozir nechta kishi kutmoqda; klinika navbatni ko‘rsatmasa `null`).',
        'Walk-in queue: no times — `hours` (reception hours) and `queue_now` (how many are waiting now; `null` if the clinic does not show the queue).')] },
  { id: 'services', section: 'services', method: 'GET', path: '/services', scopes: ['services'], examples: ['services'],
    summary: L('Услуги с ценами по пяти группам.', 'Beshta guruh bo‘yicha xizmatlar narxlari bilan.', 'Services with prices in five groups.'),
    params: [{ name: 'group', in: 'query', req: false, value: L('код группы — таблица ниже', 'guruh kodi — quyidagi jadval', 'a group code — see the table below') }, qLang],
    notes: [L('`minutes` — длительность, если клиника её указала, иначе `null`.', '`minutes` — klinika ko‘rsatgan bo‘lsa davomiylik, aks holda `null`.', '`minutes` — the length if the clinic set it, otherwise `null`.')],
    table: 'groups' },
  { id: 'packages', section: 'services', method: 'GET', path: '/packages', scopes: ['packages'], examples: ['packages'],
    summary: L('Пакеты услуг: состав, цена без скидки, цена пакета, скидка, срок действия.', 'Xizmat paketlari: tarkibi, chegirmasiz narx, paket narxi, chegirma, amal qilish muddati.', 'Service packages: contents, full price, package price, discount, validity.'),
    params: [qLang],
    notes: [L('Истёкшие пакеты не приходят; пакет с услугой, скрытой клиникой, не приходит вовсе. В `items` — цена каждой услуги в пакете.',
      'Muddati o‘tgan paketlar kelmaydi; klinika yashirgan xizmati bor paket umuman kelmaydi. `items` da — har bir xizmatning paketdagi narxi.',
      'Expired packages are not returned; a package with a service the clinic hid is not returned at all. `items` holds each service’s price inside the package.')] },
  { id: 'requests-create', section: 'booking', method: 'POST', path: '/requests', scopes: ['requests'], examples: ['request-new'],
    summary: L('Заявка без времени — «перезвоните мне». В CRM клиники появляется карточка заявки; ответ — `201` и статус `new`.',
      'Vaqtsiz ariza — «menga qayta qo‘ng‘iroq qiling». Klinika CRM ida ariza kartochkasi paydo bo‘ladi; javob — `201` va `new` holati.',
      'A request without a time — “call me back”. A request card appears in the clinic CRM; the response is `201` with status `new`.'),
    params: [...patient,
      { name: 'doctor_id', in: 'body', req: false, value: L('врач, к которому хочет пациент', 'bemor xohlagan shifokor', 'the doctor the patient wants') },
      { name: 'service_id', in: 'body', req: false, value: L('услуга', 'xizmat', 'a service') },
      { name: 'package_id', in: 'body', req: false, value: L('пакет', 'paket', 'a package') },
      { name: 'branch_id', in: 'body', req: false, value: L('филиал', 'filial', 'a branch') },
      ...common],
    notes: [L('Поля пациента можно прислать и на верхнем уровне: `name`, `phone`, `comment`.', 'Bemor maydonlarini yuqori darajada ham yuborish mumkin: `name`, `phone`, `comment`.', 'The patient fields may also come at the top level: `name`, `phone`, `comment`.')] },
  { id: 'appointments-create', section: 'booking', method: 'POST', path: '/appointments', scopes: ['appointments'], examples: ['appointment-new', 'error-slot-taken'],
    summary: L('Онлайн-запись на свободное время. Ответ — `201` и `pending`: заявка ждёт клинику.', 'Bo‘sh vaqtga onlayn yozilish. Javob — `201` va `pending`: ariza klinikani kutmoqda.', 'An online booking for a free time. The response is `201` with `pending`: the booking waits for the clinic.'),
    params: [
      { name: 'doctor_id', in: 'body', req: true, value: L('врач с `reception: booking`', '`reception: booking` bo‘lgan shifokor', 'a doctor with `reception: booking`') },
      { name: 'consultation', in: 'body', req: false, value: L('`initial` или `repeat` — вид приёма; нужен он или `service_id`', '`initial` yoki `repeat` — qabul turi; u yoki `service_id` kerak', '`initial` or `repeat` — the visit type; this or `service_id` is required') },
      { name: 'service_id', in: 'body', req: false, value: L('услуга вместо вида приёма', 'qabul turi o‘rniga xizmat', 'a service instead of a visit type') },
      { name: 'start', in: 'body', req: true, value: L('начало из `/slots`: `2030-03-12T09:45:00+05:00`', '`/slots` dagi boshlanish: `2030-03-12T09:45:00+05:00`', 'a start from `/slots`: `2030-03-12T09:45:00+05:00`') },
      ...patient,
      { name: 'branch_id', in: 'body', req: false, value: L('для справки: визит заводится в здании, где работает врач', 'ma’lumot uchun: tashrif shifokor ishlaydigan binoda ochiladi', 'for reference only: the visit is created in the doctor’s building') },
      { name: 'package_id', in: 'body', req: false, value: L('пакет; его цену клиника поставит сама', 'paket; uning narxini klinika o‘zi qo‘yadi', 'a package; the clinic applies its price itself') },
      ...common],
    notes: [
      L('`start` — на сетке {{slotMin:min}}, в будущем и не дальше `booking_days` врача.', '`start` — {{slotMin:min}}lik to‘rda, kelajakda va shifokorning `booking_days` dan uzoq emas.', '`start` must sit on the {{slotMin}}-minute grid, in the future and within the doctor’s `booking_days`.'),
      L('Клиника, приняв заявку, держит время {{holdMin:min}} по своим часам работы и сообщает срок — он появится в `hold_until` ([статус заявки](#ep-request-status)). Запись принимается и тогда, когда клиника не на связи: срок держания идёт от приёма заявки клиникой.',
        'Klinika arizani qabul qilgach, vaqtni o‘z ish soatlari bo‘yicha {{holdMin:min}} band qilib turadi va muddatni xabar qiladi — u `hold_until` da paydo bo‘ladi ([ariza holati](#ep-request-status)). Klinika aloqada bo‘lmaganda ham yozilish qabul qilinadi: band qilish muddati arizani klinika qabul qilgan paytdan boshlanadi.',
        'Once the clinic takes the booking it holds the time for {{holdMin:min}} of its working hours and reports the deadline — it appears in `hold_until` ([request status](#ep-request-status)). Bookings are accepted even while the clinic is offline: the hold starts when the clinic takes the booking.'),
      L('`409 slot_taken` — время занято по последнему, что прислала клиника, или другой ждущей записью: запросите `/slots` заново.',
        '`409 slot_taken` — klinika oxirgi yuborgan ma’lumot bo‘yicha yoki boshqa kutayotgan yozuv bilan vaqt band: `/slots` ni qayta so‘rang.',
        '`409 slot_taken` — the time is taken according to what the clinic sent last, or by another waiting booking: request `/slots` again.')] },
  { id: 'request-status', section: 'booking', method: 'GET', path: '/requests/{id}', scopes: ['requests', 'appointments'], examples: ['request-held', 'request-offered'],
    summary: L('Статус заявки или записи. Только присланные этим же подключением; чужие и неизвестные — `404`.', 'Ariza yoki yozuv holati. Faqat shu ulanish yuborganlari; boshqalarniki va noma’lumlari — `404`.', 'The status of a request or booking. Only those sent by the same connection; others and unknown ones get `404`.'),
    params: [pathId],
    notes: [L('Статус хранится {{keepDays:day}} после последнего изменения. Данных пациента в ответе нет.', 'Holat oxirgi o‘zgarishdan keyin {{keepDays:day}} saqlanadi. Javobda bemor ma’lumotlari yo‘q.', 'The status is kept for {{keepDays:day}} after the last change. The response has no patient data.')] },
  { id: 'offer-accept', section: 'booking', method: 'POST', path: '/appointments/{id}/accept', scopes: ['appointments'], examples: ['offer-accept'],
    summary: L('Пациент согласен на время, которое предложила клиника.', 'Bemor klinika taklif qilgan vaqtga rozi.', 'The patient agrees to the time the clinic offered.'),
    params: [pathId, { name: 'offered_start', in: 'body', req: false, value: L('время предложения, на которое вы отвечаете, — как в `offered_start` статуса', 'siz javob berayotgan taklif vaqti — holatdagi `offered_start` kabi', 'the offered time you are answering — as in the status `offered_start`') }],
    notes: [L('Согласие — снова `pending` на новом времени: клиника снова держит его и сообщит `hold_until`.', 'Rozilik — yangi vaqtda yana `pending`: klinika uni yana band qiladi va `hold_until` ni xabar qiladi.', 'Accepting makes it `pending` again at the new time: the clinic holds it again and reports `hold_until`.')] },
  { id: 'offer-decline', section: 'booking', method: 'POST', path: '/appointments/{id}/decline', scopes: ['appointments'], examples: [],
    summary: L('Пациент отказался от предложенного времени — запись `cancelled`.', 'Bemor taklif qilingan vaqtdan voz kechdi — yozuv `cancelled`.', 'The patient declines the offered time — the booking becomes `cancelled`.'),
    params: [pathId, { name: 'offered_start', in: 'body', req: false, value: L('как у согласия', 'rozilikdagi kabi', 'as for accepting') }] },
  { id: 'appointments-cancel', section: 'booking', method: 'DELETE', path: '/appointments/{id}', scopes: ['cancel'], examples: ['appointment-cancel'],
    summary: L('Пациент отменил запись у вас.', 'Bemor yozuvni sizda bekor qildi.', 'The patient cancelled the booking with you.'),
    params: [pathId],
    notes: [
      L('Ждущая и с предложением — сразу `cancelled`, время свободно.', 'Kutayotgan va taklifli yozuv — darhol `cancelled`, vaqt bo‘shaydi.', 'A waiting or offered booking becomes `cancelled` at once and the time is free.'),
      L('Записанная (`booked`) остаётся `booked` с `cancel_requested: true`, пока клиника не отменит визит: тогда `cancelled` и уведомление `appointment.cancelled`. Если пациент уже в клинике, решает клиника.',
        'Yozilgan (`booked`) yozuv klinika tashrifni bekor qilmaguncha `cancel_requested: true` bilan `booked` bo‘lib qoladi: shunda `cancelled` va `appointment.cancelled` bildirishnomasi. Bemor allaqachon klinikada bo‘lsa, klinika hal qiladi.',
        'A booked one stays `booked` with `cancel_requested: true` until the clinic cancels the visit: then `cancelled` and the `appointment.cancelled` notification. If the patient is already at the clinic, the clinic decides.'),
      L('Повтор отмены — тот же ответ; из других статусов — `409 not_cancellable`.', 'Bekor qilishni takrorlash — o‘sha javob; boshqa holatlardan — `409 not_cancellable`.', 'Repeating a cancellation gives the same answer; from other statuses — `409 not_cancellable`.')] },
]);

// ---- примеры: запросы (ответы — docs/generated.js) ---------------------------------------
// {lang} в пути и теле — язык страницы; {callback} / {appointment} — номер заявки из
// ответа примера с saveAs; значение L(…) в теле — на языке страницы.
const PATIENT_EXAMPLE = { name: 'Aziza Karimova', phone: '+998901234567', comment: L('Удобно после 18:00', '18:00 dan keyin qulay', 'Best after 18:00') };
export const EXAMPLES = Object.freeze([
  { id: 'geo', method: 'GET', path: '/reference/geo?lang={lang}', trim: { countries: 2, cities: 1, 'cities.districts': 2 } },
  { id: 'specialties', method: 'GET', path: '/reference/specialties?lang={lang}', trim: { specialties: 3 } },
  { id: 'clinic', method: 'GET', path: '/clinic?lang={lang}' },
  { id: 'branches', method: 'GET', path: '/branches?lang={lang}' },
  { id: 'doctors', method: 'GET', path: '/doctors?lang={lang}' },
  { id: 'slots-day', method: 'GET', path: '/slots?doctor_id=7&date=2030-03-12',
    title: L('Окна дня', 'Kun oynalari', 'Windows of a day') },
  { id: 'slots-fit', method: 'GET', path: '/slots?doctor_id=7&date=2030-03-12&consultation=initial',
    title: L('Только начала, где поместится первичный приём (30 минут)', 'Faqat birlamchi qabul (30 daqiqa) sig‘adigan boshlanishlar', 'Only the starts where a first visit (30 minutes) fits') },
  { id: 'slots-live', method: 'GET', path: '/slots?doctor_id=8', title: L('Врач с живой очередью', 'Jonli navbatli shifokor', 'A walk-in queue doctor') },
  { id: 'services', method: 'GET', path: '/services?lang={lang}' },
  { id: 'packages', method: 'GET', path: '/packages?lang={lang}' },
  { id: 'request-new', method: 'POST', path: '/requests', saveAs: 'callback',
    body: { patient: PATIENT_EXAMPLE, service_id: 301, external_id: 'cb-1001', lang: '{lang}' } },
  { id: 'appointment-new', method: 'POST', path: '/appointments', saveAs: 'appointment',
    body: { doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:45:00+05:00', branch_id: 1,
      patient: { name: 'Aziza Karimova', phone: '+998901234567' }, external_id: 'bk-2002', lang: '{lang}' } },
  { id: 'error-slot-taken', method: 'POST', path: '/appointments?lang={lang}',
    title: L('Время занято', 'Vaqt band', 'The time is taken'),
    body: { doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:30:00+05:00', patient: { name: 'Aziza Karimova', phone: '+998901234567' },
      external_id: 'bk-2003' } },
  { id: 'request-held', method: 'GET', path: '/requests/{appointment}',
    title: L('Клиника приняла запись и держит время', 'Klinika yozuvni qabul qildi va vaqtni band qilib turibdi', 'The clinic took the booking and holds the time') },
  { id: 'request-offered', method: 'GET', path: '/requests/{appointment}',
    title: L('Клиника предложила другое время', 'Klinika boshqa vaqt taklif qildi', 'The clinic offered another time') },
  { id: 'offer-accept', method: 'POST', path: '/appointments/{appointment}/accept', body: { offered_start: '2030-03-12T10:00:00+05:00' } },
  { id: 'appointment-cancel', method: 'DELETE', path: '/appointments/{appointment}' },
  { id: 'error-field', method: 'POST', path: '/requests?lang={lang}', title: L('Поле заполнено неверно', 'Maydon noto‘g‘ri to‘ldirilgan', 'A field is invalid'),
    body: { patient: { name: 'Aziza Karimova', phone: '12' } } },
  { id: 'error-key', method: 'GET', path: '/clinic?lang={lang}', key: 'wrong', curl: false,
    title: L('Ключ неверный', 'Kalit noto‘g‘ri', 'The key is wrong') },
]);

// ---- статусы, причины, события, ошибки -------------------------------------------------
export const STATUS_TEXT = Object.freeze({
  new: { kind: 'request', text: L('Заявка «перезвоните» пришла, клиника её ещё не взяла.', '«Qayta qo‘ng‘iroq» arizasi keldi, klinika uni hali olmagan.', 'The callback request has arrived; the clinic has not taken it yet.') },
  accepted: { kind: 'request', text: L('Администратор взял заявку в работу и свяжется с пациентом.', 'Administrator arizani ishga oldi va bemor bilan bog‘lanadi.', 'An administrator took the request on and will contact the patient.') },
  pending: { kind: 'appointment', text: L('Онлайн-запись ждёт подтверждения. Когда клиника примет заявку, время держится до `hold_until`.', 'Onlayn yozilish tasdiqlashni kutmoqda. Klinika arizani qabul qilgach, vaqt `hold_until` gacha band turadi.', 'The online booking awaits confirmation. Once the clinic takes it, the time is held until `hold_until`.') },
  offered: { kind: 'appointment', text: L('Клиника предложила другое время — `offered_start`; ответ ждёт до `offer_until`.', 'Klinika boshqa vaqt taklif qildi — `offered_start`; javob `offer_until` gacha kutiladi.', 'The clinic offered another time — `offered_start`; it waits for an answer until `offer_until`.') },
  booked: { kind: 'both', text: L('Пациент записан, визит создан; `start` — время визита.', 'Bemor yozildi, tashrif yaratildi; `start` — tashrif vaqti.', 'The patient is booked and the visit created; `start` is the visit time.') },
  declined: { kind: 'appointment', text: L('Клиника отказала, причина — в `reason`. Время свободно.', 'Klinika rad etdi, sababi — `reason` da. Vaqt bo‘sh.', 'The clinic declined; the reason is in `reason`. The time is free.') },
  expired: { kind: 'appointment', text: L('Не подтверждено вовремя (`reason: expired`).', 'O‘z vaqtida tasdiqlanmadi (`reason: expired`).', 'Not confirmed in time (`reason: expired`).') },
  cancelled: { kind: 'both', text: L('Отменено — пациентом через вас или клиникой.', 'Bekor qilindi — siz orqali bemor yoki klinika tomonidan.', 'Cancelled — by the patient through you, or by the clinic.') },
  arrived: { kind: 'both', text: L('Пациент пришёл. Только если клиника включила подключению событие `appointment.arrived`: это врачебная тайна.', 'Bemor keldi. Faqat klinika ulanishga `appointment.arrived` hodisasini yoqqan bo‘lsa: bu shifokorlik siri.', 'The patient arrived. Only if the clinic enabled the `appointment.arrived` event for the connection: it is medical confidentiality.') },
  no_show: { kind: 'both', text: L('Пациент не пришёл. Сейчас партнёрам не сообщается: после дня визита статус остаётся `booked`.', 'Bemor kelmadi. Hozircha hamkorlarga xabar qilinmaydi: tashrif kunidan keyin holat `booked` bo‘lib qoladi.', 'The patient did not come. Not reported to partners for now: after the visit day the status stays `booked`.') },
  closed: { kind: 'both', text: L('Закрыто сервером: клиника не ответила, причина — в `reason`. Уведомления нет; пусть пациент позвонит в клинику.', 'Server yopdi: klinika javob bermadi, sababi — `reason` da. Bildirishnoma yo‘q; bemor klinikaga qo‘ng‘iroq qilsin.', 'Closed by the server: the clinic did not answer; the reason is in `reason`. There is no notification; the patient should call the clinic.') },
});

/** Причины для closed ставит сервер (store/requests.js closeOverdue); остальные — клиника (DECLINE_REASONS). */
export const CLOSED_REASONS = Object.freeze(['not_processed', 'not_collected']);
export const REASON_TEXT = Object.freeze({
  slot_taken: { status: 'declined', text: L('Время уже занято — предложите пациенту другое из `/slots`.', 'Vaqt band — bemorga `/slots` dan boshqasini taklif qiling.', 'The time is already taken — offer the patient another one from `/slots`.') },
  doctor_unavailable: { status: 'declined', text: L('Врач в это время не принимает.', 'Shifokor bu vaqtda qabul qilmaydi.', 'The doctor does not see patients at that time.') },
  not_bookable: { status: 'declined', text: L('Запись к этому врачу или на эту услугу через API не открыта либо время дальше срока записи врача.', 'Bu shifokorga yoki bu xizmatga API orqali yozilish ochilmagan yoki vaqt shifokorning yozilish muddatidan uzoq.', 'Booking this doctor or service via the API is not open, or the time is beyond the doctor’s booking window.') },
  duplicate: { status: 'declined', text: L('Повтор уже принятой заявки.', 'Allaqachon qabul qilingan arizaning takrori.', 'A repeat of a request already taken.') },
  expired: { status: 'expired', text: L('Клиника не подтвердила вовремя или приём уже прошёл, пока клиника была не на связи.', 'Klinika o‘z vaqtida tasdiqlamadi yoki klinika aloqada bo‘lmaganida qabul vaqti o‘tib ketdi.', 'The clinic did not confirm in time, or the visit time passed while the clinic was offline.') },
  other: { status: 'declined', text: L('Другая причина — пусть пациент позвонит в клинику.', 'Boshqa sabab — bemor klinikaga qo‘ng‘iroq qilsin.', 'Another reason — the patient should call the clinic.') },
  not_processed: { status: 'closed', text: L('Клиника получила онлайн-запись, но за {{answerMin:min}} не ответила.', 'Klinika onlayn yozilishni oldi, lekin {{answerMin:min}} ichida javob bermadi.', 'The clinic received the booking but did not answer within {{answerMin:min}}.') },
  not_collected: { status: 'closed', text: L('Клиника не забрала заявку за {{uncollectedHours:hour}} (компьютер выключен или нет интернета); данные пациента стёрты с сервера.', 'Klinika arizani {{uncollectedHours:hour}} ichida olmadi (kompyuter o‘chiq yoki internet yo‘q); bemor ma’lumotlari serverdan o‘chirildi.', 'The clinic did not collect the request within {{uncollectedHours:hour}} (computer off or no internet); the patient data was erased from the server.') },
});

/** Статусы и поля уведомлений по событиям — как их шлёт клиника (services/api/bookings.js, visit-events.js). */
export const EVENT_TEXT = Object.freeze({
  'request.accepted': { statuses: ['accepted'], fields: [] },
  'appointment.created': { statuses: ['booked'], fields: ['doctor_id', 'start', 'rescheduled'] },
  'booking.confirmed': { statuses: ['booked'], fields: ['doctor_id', 'branch_id', 'start'] },
  'booking.offered_other_time': { statuses: ['offered'], fields: ['doctor_id', 'offered_start', 'offer_until'] },
  'booking.declined': { statuses: ['declined', 'expired'], fields: ['reason', 'doctor_id', 'start'] },
  'appointment.cancelled': { statuses: ['cancelled'], fields: ['doctor_id'] },
  'appointment.arrived': { statuses: ['arrived'], fields: ['doctor_id'] },
});
/** Пример уведомления: тело собирает webhookBody программы клиники, подпись — её signBody. */
export const WEBHOOK_EXAMPLE = Object.freeze({
  url: 'https://partner.example/hooks/easymed', secret: 'example-secret',
  eventId: 'ev_5f1c2a9be03d7a64c81e0f22', event: 'booking.confirmed', publicId: SAMPLE.ids.appointment, externalId: 'bk-2002',
  status: 'booked', occurredAt: '2030-03-11T04:12:00Z', details: { doctor_id: 7, branch_id: 1, start: '2030-03-12T10:00:00+05:00' },
});
export const VERIFY_NODE = [
  "const crypto = require('node:crypto');",
  '',
  'function signatureOk(rawBody, header, secret) {',
  "  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');",
  "  const a = Buffer.from(expected);",
  "  const b = Buffer.from(String(header || ''));",
  '  return a.length === b.length && crypto.timingSafeEqual(a, b);',
  '}',
].join('\n');
export const VERIFY_PHP = [
  '$raw = file_get_contents(\'php://input\');',
  '$expected = \'sha256=\' . hash_hmac(\'sha256\', $raw, $secret);',
  '$ok = hash_equals($expected, $_SERVER[\'HTTP_X_EASYMED_SIGNATURE\'] ?? \'\');',
].join('\n');

/** Коды lib/errors.js, которые видит только канал клиники (/_sync/v1), — партнёру не приходят. */
export const CLINIC_ONLY_ERRORS = Object.freeze(['invalid_signature', 'licence_invalid', 'licence_outdated', 'clock_skew', 'bad_slug', 'slug_taken', 'media_quota']);
export const ERROR_TEXT = Object.freeze({
  bad_request: L('Тело — не объект JSON. Пришлите объект `{…}`.', 'Tana JSON obyekti emas. `{…}` obyektini yuboring.', 'The body is not a JSON object. Send an object `{…}`.'),
  bad_json: L('Тело не разбирается как JSON — проверьте кавычки и запятые.', 'Tana JSON sifatida o‘qilmaydi — qo‘shtirnoq va vergullarni tekshiring.', 'The body does not parse as JSON — check quotes and commas.'),
  invalid_field: L('Поле `field` неверно по причине `reason` — таблица полей ниже.', '`field` maydoni `reason` sababi bilan noto‘g‘ri — maydonlar jadvali quyida.', 'The `field` is invalid for the `reason` — see the field table below.'),
  https_required: L('Запрос пришёл по http — только https.', 'So‘rov http orqali keldi — faqat https.', 'The request came over http — https only.'),
  invalid_key: L('Нет заголовка `Authorization: Bearer …` или ключ неверный — сверьте ключ с клиникой.', '`Authorization: Bearer …` sarlavhasi yo‘q yoki kalit noto‘g‘ri — kalitni klinika bilan solishtiring.', 'No `Authorization: Bearer …` header, or the key is wrong — check the key with the clinic.'),
  key_disabled: L('Клиника выключила подключение — обратитесь в клинику.', 'Klinika ulanishni o‘chirdi — klinikaga murojaat qiling.', 'The clinic switched the connection off — contact the clinic.'),
  key_expired: L('Срок ключа вышел — попросите у клиники новый.', 'Kalit muddati tugadi — klinikadan yangisini so‘rang.', 'The key has expired — ask the clinic for a new one.'),
  forbidden_scope: L('Ключу не открыт раздел из поля `scope` — попросите клинику включить это право.', 'Kalitga `scope` maydonidagi bo‘lim ochilmagan — klinikadan bu huquqni yoqishni so‘rang.', 'The key has no access to the section in `scope` — ask the clinic to enable that scope.'),
  ip_not_allowed: L('Запрос не с разрешённого IP — сообщите клинике адрес своего сервера.', 'So‘rov ruxsat etilgan IP dan emas — klinikaga serveringiz manzilini ayting.', 'The request is not from an allowed IP — give the clinic your server’s address.'),
  origin_not_allowed: L('Запрос из браузера с сайта, которого нет в подключении, — сообщите клинике адрес сайта.', 'Ulanishda yo‘q saytdan brauzer so‘rovi — klinikaga sayt manzilini ayting.', 'A browser request from a site that is not in the connection — give the clinic the site address.'),
  not_found: L('Нет такого адреса, врача, услуги или заявки либо клиника их скрыла; поле `field` подскажет, что именно. Обновите списки.', 'Bunday manzil, shifokor, xizmat yoki ariza yo‘q yoki klinika ularni yashirgan; `field` maydoni nimaligini aytadi. Ro‘yxatlarni yangilang.', 'No such endpoint, doctor, service or request, or the clinic hid it; `field` tells which. Refresh your lists.'),
  clinic_not_found: L('Нет клиники с таким именем в адресе — сверьте адрес с клиникой.', 'Manzilda bunday nomli klinika yo‘q — manzilni klinika bilan solishtiring.', 'No clinic with that name in the address — check the address with the clinic.'),
  slot_taken: L('Время занято — запросите `/slots` заново и предложите другое.', 'Vaqt band — `/slots` ni qayta so‘rang va boshqasini taklif qiling.', 'The time is taken — request `/slots` again and offer another.'),
  not_cancellable: L('Запись уже не отменить: она отклонена, истекла, закрыта или пациент пришёл.', 'Yozuvni endi bekor qilib bo‘lmaydi: u rad etilgan, muddati o‘tgan, yopilgan yoki bemor kelgan.', 'The booking can no longer be cancelled: it was declined, expired, closed or the patient came.'),
  not_offered: L('Клиника не предлагала другое время или ответ уже дан.', 'Klinika boshqa vaqt taklif qilmagan yoki javob allaqachon berilgan.', 'The clinic has not offered another time, or the answer was already given.'),
  offer_changed: L('Клиника уже предложила другое время — запросите заявку и ответьте на новое.', 'Klinika allaqachon boshqa vaqt taklif qildi — arizani so‘rang va yangisiga javob bering.', 'The clinic has already offered a different time — fetch the request and answer the new offer.'),
  offer_expired: L('Срок ответа вышел — запишите пациента заново.', 'Javob muddati tugadi — bemorni qaytadan yozing.', 'The time to answer has passed — book the patient again.'),
  too_large: L('Тело больше {{bodyKb}} КБ.', 'Tana {{bodyKb}} KB dan katta.', 'The body is larger than {{bodyKb}} KB.'),
  unsupported_encoding: L('Тело сжато неизвестным способом — пришлите без `Content-Encoding`.', 'Tana noma’lum usulda siqilgan — `Content-Encoding` siz yuboring.', 'The body is compressed in an unknown way — send it without `Content-Encoding`.'),
  rate_limited: L('Лимит запросов — повторите через столько секунд, сколько в `Retry-After`.', 'So‘rovlar chegarasi — `Retry-After` dagi soniyadan keyin takrorlang.', 'Rate limit — retry after as many seconds as `Retry-After` says.'),
  internal: L('Ошибка сервера — повторите позже; если повторяется, напишите в Easy-Med.', 'Server xatosi — keyinroq takrorlang; takrorlansa, Easy-Med ga yozing.', 'Server error — retry later; if it keeps happening, write to Easy-Med.'),
  licence_lapsed: L('Клиника временно недоступна для подключений — покажите пациенту телефон клиники из поля `phone`.', 'Klinika ulanishlar uchun vaqtincha mavjud emas — bemorga `phone` maydonidagi klinika telefonini ko‘rsating.', 'The clinic is temporarily unavailable to connections — show the patient the clinic phone from `phone`.'),
  clinic_offline: L('Клиника давно не выходила на связь или ещё не подключилась — покажите пациенту телефон из поля `phone`.', 'Klinika uzoq vaqt aloqaga chiqmagan yoki hali ulanmagan — bemorga `phone` maydonidagi telefonni ko‘rsating.', 'The clinic has not been online for a long time or is not connected yet — show the patient the phone from `phone`.'),
});

/**
 * Причины полей: { field, reason, code?, text, probes:{ endpoint: {path} | {body} } }.
 * Пробы — запросы, которыми страж показывает эту ошибку на настоящем сервере
 * (body — поверх тела примера адреса).
 */
const READS = ['geo', 'specialties', 'clinic', 'branches', 'doctors', 'services', 'packages'];
const readLang = Object.fromEntries(READS.map((ep) => [ep, { path: ENDPOINTS.find((e) => e.id === ep).path + '?lang=de' }]));
const both = (body) => ({ 'requests-create': { body }, 'appointments-create': { body } });
const P_OK = '+998901234567';
export const FIELD_ERRORS = Object.freeze([
  { field: 'lang', reason: 'unknown', text: L('не `ru`, `uz` и не `en`', '`ru`, `uz` ham, `en` ham emas', 'not `ru`, `uz` or `en`'), probes: { ...readLang, ...both({ lang: 'de' }) } },
  { field: 'doctor_id', reason: 'required', text: L('не указан', 'ko‘rsatilmagan', 'missing'), probes: { slots: { path: '/slots' }, 'appointments-create': { body: { doctor_id: undefined } } } },
  { field: 'doctor_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: { slots: { path: '/slots?doctor_id=seven' }, ...both({ doctor_id: 'seven' }) } },
  { field: 'doctor_id', code: 'not_found', text: L('такого врача клиника не показывает', 'klinika bunday shifokorni ko‘rsatmaydi', 'the clinic shows no such doctor'), probes: { slots: { path: '/slots?doctor_id=99' }, ...both({ doctor_id: 99 }) } },
  { field: 'doctor_id', reason: 'live_queue', text: L('у врача живая очередь — записи на время нет', 'shifokorda jonli navbat — vaqtga yozilish yo‘q', 'the doctor has a walk-in queue — no timed booking'), probes: { 'appointments-create': { body: { doctor_id: 8 } } } },
  { field: 'branch_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: { doctors: { path: '/doctors?branch_id=main' }, ...both({ branch_id: -1 }) } },
  { field: 'service_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: both({ service_id: 'x' }) },
  { field: 'service_id', code: 'not_found', text: L('такой услуги клиника не показывает', 'klinika bunday xizmatni ko‘rsatmaydi', 'the clinic shows no such service'), probes: { slots: { path: '/slots?doctor_id=7&service_id=999' }, 'requests-create': { body: { service_id: 999 } }, 'appointments-create': { body: { consultation: undefined, service_id: 999 } } } },
  { field: 'package_id', reason: 'format', text: L('не целое положительное число', 'butun musbat son emas', 'not a positive integer'), probes: both({ package_id: 'x' }) },
  { field: 'package_id', code: 'not_found', text: L('такого пакета клиника не показывает', 'klinika bunday paketni ko‘rsatmaydi', 'the clinic shows no such package'), probes: both({ package_id: 99 }) },
  { field: 'group', reason: 'unknown', text: L('нет такой группы услуг', 'bunday xizmat guruhi yo‘q', 'no such service group'), probes: { services: { path: '/services?group=xray' } } },
  { field: 'date', reason: 'format', text: L('не `ГГГГ-ММ-ДД`', '`YYYY-OO-KK` emas', 'not `YYYY-MM-DD`'), probes: { slots: { path: '/slots?doctor_id=7&date=12.03.2030' } } },
  { field: 'consultation', reason: 'required', text: L('нет ни `consultation`, ни `service_id`', '`consultation` ham, `service_id` ham yo‘q', 'neither `consultation` nor `service_id`'), probes: { 'appointments-create': { body: { consultation: undefined } } } },
  { field: 'consultation', reason: 'unknown', text: L('не `initial` и не `repeat`', '`initial` ham, `repeat` ham emas', 'not `initial` or `repeat`'), probes: { 'appointments-create': { body: { consultation: 'vip' } } } },
  { field: 'consultation', reason: 'not_offered', text: L('врач такой вид приёма не ведёт', 'shifokor bunday qabul turini o‘tkazmaydi', 'the doctor does not offer this visit type'), probes: { slots: { path: '/slots?doctor_id=7&consultation=repeat' }, 'appointments-create': { body: { consultation: 'repeat' } } } },
  { field: 'start', reason: 'required', text: L('не указано', 'ko‘rsatilmagan', 'missing'), probes: { 'appointments-create': { body: { start: undefined } } } },
  { field: 'start', reason: 'format', text: L('не время вида `2030-03-12T09:45:00+05:00`', '`2030-03-12T09:45:00+05:00` ko‘rinishidagi vaqt emas', 'not a time like `2030-03-12T09:45:00+05:00`'), probes: { 'appointments-create': { body: { start: 'tomorrow' } } } },
  { field: 'start', reason: 'past', text: L('время уже прошло', 'vaqt o‘tib ketgan', 'the time has passed'), probes: { 'appointments-create': { body: { start: '2030-03-11T08:00:00+05:00' } } } },
  { field: 'start', reason: 'grid', text: L('не на сетке {{slotMin:min}}', '{{slotMin:min}}lik to‘rda emas', 'not on the {{slotMin}}-minute grid'), probes: { 'appointments-create': { body: { start: '2030-03-12T09:50:00+05:00' } } } },
  { field: 'start', reason: 'horizon', text: L('дальше срока записи врача (`booking_days`)', 'shifokorning yozilish muddatidan (`booking_days`) uzoq', 'beyond the doctor’s `booking_days`'), probes: { 'appointments-create': { body: { start: '2030-03-26T09:00:00+05:00' } } } },
  { field: 'patient.name', reason: 'required', text: L('имени нет', 'ism yo‘q', 'no name'), probes: both({ patient: { phone: P_OK } }) },
  { field: 'patient.name', reason: 'too_long', text: L('длиннее {{nameMax}} знаков', '{{nameMax}} belgidan uzun', 'longer than {{nameMax}} characters'), probes: both({ patient: { name: 'x'.repeat(121), phone: P_OK } }) },
  { field: 'patient.phone', reason: 'required', text: L('телефона нет', 'telefon yo‘q', 'no phone'), probes: both({ patient: { name: 'Aziza' } }) },
  { field: 'patient.phone', reason: 'format', text: L('меньше {{phoneDigitsMin}} цифр или длиннее {{phoneMax}} знаков', '{{phoneDigitsMin}} raqamdan kam yoki {{phoneMax}} belgidan uzun', 'fewer than {{phoneDigitsMin}} digits or longer than {{phoneMax}} characters'), probes: both({ patient: { name: 'Aziza', phone: '12' } }) },
  { field: 'patient.comment', reason: 'too_long', text: L('длиннее {{commentMax}} знаков', '{{commentMax}} belgidan uzun', 'longer than {{commentMax}} characters'), probes: both({ patient: { name: 'Aziza', phone: P_OK, comment: 'x'.repeat(1001) } }) },
  { field: 'external_id', reason: 'format', text: L('пробел, кириллица или длиннее {{externalMax}} знаков', 'bo‘sh joy, kirill harflari yoki {{externalMax}} belgidan uzun', 'a space, Cyrillic or longer than {{externalMax}} characters'), probes: both({ external_id: 'has space' }) },
  { field: 'offered_start', reason: 'format', text: L('не время', 'vaqt emas', 'not a time'), probes: { 'offer-accept': { body: { offered_start: 'tomorrow' } }, 'offer-decline': { body: { offered_start: 'tomorrow' } } } },
]);

// ---- разделы страницы ------------------------------------------------------------------
export const SECTIONS = Object.freeze([
  { id: 'start', title: L('Начало работы', 'Boshlash', 'Getting started'), blocks: [
    { p: L('Каждая клиника — свой адрес: `{{base}}/<клиника>/v1/`. Короткое имя клиники в адресе, ключ и права выдаёт сама клиника: в программе Easy-Med это «Настройки → API и подключения», кнопка «Скопировать всё». В примерах клиника — `{{slug}}`, ключ лежит в переменной `EASYMED_KEY`.',
      'Har bir klinikaning o‘z manzili bor: `{{base}}/<klinika>/v1/`. Manzildagi qisqa nom, kalit va huquqlarni klinikaning o‘zi beradi: Easy-Med dasturida bu «Sozlamalar → API va ulanishlar», «Hammasini nusxalash» tugmasi. Misollarda klinika — `{{slug}}`, kalit `EASYMED_KEY` o‘zgaruvchisida.',
      'Every clinic has its own address: `{{base}}/<clinic>/v1/`. The clinic itself issues the short name in the address, the key and the scopes: in the Easy-Med program it is “Settings → API and connections”, the “Copy all” button. In the examples the clinic is `{{slug}}` and the key is in the `EASYMED_KEY` variable.') },
    { code: L('export EASYMED_KEY="{{keyPrefix}}…"', 'export EASYMED_KEY="{{keyPrefix}}…"', 'export EASYMED_KEY="{{keyPrefix}}…"') },
    { example: 'clinic', response: false },
    { kv: [
      [L('Адрес', 'Manzil', 'Address'), L('`{{base}}/<клиника>/v1/`. После смены имени клиники прежний адрес работает ещё {{slugAliasDays:day}}.', '`{{base}}/<klinika>/v1/`. Klinika nomi o‘zgargach, eski manzil yana {{slugAliasDays:day}} ishlaydi.', '`{{base}}/<clinic>/v1/`. After the clinic renames itself the old address keeps working for {{slugAliasDays:day}}.')],
      [L('Ключ', 'Kalit', 'Key'), L('В каждом запросе: `Authorization: Bearer {{keyPrefix}}…`. У каждого подключения свой ключ; выключенный или заменённый клиникой ключ перестаёт подходить за {{clinicPollSec:sec}}, если клиника на связи.', 'Har bir so‘rovda: `Authorization: Bearer {{keyPrefix}}…`. Har bir ulanishning o‘z kaliti bor; klinika o‘chirgan yoki almashtirgan kalit, klinika aloqada bo‘lsa, {{clinicPollSec:sec}} ichida yaroqsiz bo‘ladi.', 'In every request: `Authorization: Bearer {{keyPrefix}}…`. Each connection has its own key; a key the clinic switched off or replaced stops working within {{clinicPollSec:sec}} if the clinic is online.')],
      [L('Только HTTPS', 'Faqat HTTPS', 'HTTPS only'), L('Запросы по http не принимаются.', 'http orqali so‘rovlar qabul qilinmaydi.', 'Requests over http are refused.')],
      [L('Формат', 'Format', 'Format'), L('JSON в UTF-8. Тело запроса — `Content-Type: application/json`, не больше {{bodyKb}} КБ.', 'UTF-8 dagi JSON. So‘rov tanasi — `Content-Type: application/json`, {{bodyKb}} KB dan oshmasin.', 'JSON in UTF-8. Request bodies use `Content-Type: application/json`, at most {{bodyKb}} KB.')],
      [L('Язык', 'Til', 'Language'), L('`?lang=ru`, `uz` или `en` — каждое название одной строкой; без параметра — объектом `{"ru", "uz", "en"}`. Пустой перевод заменяется русским. Тот же параметр выбирает язык текста ошибок (без него — русский).', '`?lang=ru`, `uz` yoki `en` — har bir nom bitta satr; parametrsiz — `{"ru", "uz", "en"}` obyekti. Bo‘sh tarjima ruscha bilan almashtiriladi. Shu parametr xato matni tilini ham tanlaydi (usiz — ruscha).', '`?lang=ru`, `uz` or `en` — every name as one string; without it — an object `{"ru", "uz", "en"}`. An empty translation falls back to Russian. The same parameter picks the language of error messages (Russian without it).')],
      [L('Время', 'Vaqt', 'Time'), L('Ташкент, UTC+5: `2030-03-12T09:45:00+05:00`. Время без смещения (`2030-03-12T09:45`) читается как ташкентское. Даты — `ГГГГ-ММ-ДД`, часы — `ЧЧ:ММ`. Только `occurred_at` уведомлений — в UTC.', 'Toshkent, UTC+5: `2030-03-12T09:45:00+05:00`. Siljishsiz vaqt (`2030-03-12T09:45`) Toshkent vaqti deb o‘qiladi. Sanalar — `YYYY-OO-KK`, soatlar — `SS:DD`. Faqat bildirishnomalardagi `occurred_at` — UTC da.', 'Tashkent, UTC+5: `2030-03-12T09:45:00+05:00`. A time without an offset (`2030-03-12T09:45`) is read as Tashkent time. Dates are `YYYY-MM-DD`, clock times `HH:MM`. Only the `occurred_at` of notifications is in UTC.')],
      [L('Суммы', 'Summalar', 'Amounts'), L('В сумах, целыми числами: `150000`.', 'So‘mda, butun sonlar bilan: `150000`.', 'In Uzbek som, as integers: `150000`.')],
      [L('Свежесть', 'Yangilik', 'Freshness'), L('Сервер отдаёт то, что клиника прислала последним: изменения доходят за {{clinicPollSec:sec}}, свободное время обновляется раз в минуту. `as_of` — когда клиника последний раз была на связи. Клиника молчит {{silentDays:day}} — ответ `503 clinic_offline`.', 'Server klinika oxirgi yuborganini beradi: o‘zgarishlar {{clinicPollSec:sec}} ichida yetib keladi, bo‘sh vaqt har daqiqada yangilanadi. `as_of` — klinika oxirgi marta qachon aloqada bo‘lgani. Klinika {{silentDays:day}} jim bo‘lsa — `503 clinic_offline` javobi.', 'The server serves what the clinic sent last: changes arrive within {{clinicPollSec:sec}}, free time is refreshed every minute. `as_of` is when the clinic was last online. If the clinic is silent for {{silentDays:day}} — `503 clinic_offline`.')],
      [L('Новые поля', 'Yangi maydonlar', 'New fields'), L('В ответах могут появляться новые поля — пропускайте незнакомые.', 'Javoblarda yangi maydonlar paydo bo‘lishi mumkin — notanishlarini o‘tkazib yuboring.', 'New fields may appear in responses — skip the ones you do not know.')],
      [L('Примеры', 'Misollar', 'Examples'), L('Команды — для bash (Linux, macOS, Git Bash). Ответы — настоящие ответы сервера для клиники-примера «Шифо».', 'Buyruqlar — bash uchun (Linux, macOS, Git Bash). Javoblar — «Shifo» namunaviy klinikasi uchun serverning haqiqiy javoblari.', 'Commands are for bash (Linux, macOS, Git Bash). Responses are the server’s real answers for the sample clinic “Shifo”.')],
    ] },
  ] },
  { id: 'access', title: L('Ключ, права и лимиты', 'Kalit, huquqlar va chegaralar', 'Key, scopes and limits'), blocks: [
    { p: L('Клиника выбирает, какие разделы открыть каждому подключению. Запрос к закрытому разделу — `403 forbidden_scope`, в поле `scope` — нужное право. Справочники открыты любому ключу, файлы снимка — без ключа.', 'Klinika har bir ulanishga qaysi bo‘limlarni ochishni tanlaydi. Yopiq bo‘limga so‘rov — `403 forbidden_scope`, `scope` maydonida — kerakli huquq. Ma’lumotnomalar istalgan kalitga ochiq, surat fayllari — kalitsiz.', 'The clinic chooses which sections each connection may use. A request to a closed section gets `403 forbidden_scope` with the needed scope in `scope`. Reference lists are open to any key, snapshot files need no key.') },
    { table: 'scopes' },
    { p: L('Ключ проверяется в каждом запросе:', 'Kalit har bir so‘rovda tekshiriladi:', 'The key is checked on every request:') },
    { list: [
      L('нет ключа или он неверный — `401 invalid_key`; с одного IP — не больше {{authFailPerMin}} неверных ключей в минуту;', 'kalit yo‘q yoki noto‘g‘ri — `401 invalid_key`; bitta IP dan daqiqasiga {{authFailPerMin}} tadan ortiq noto‘g‘ri kalit bo‘lmaydi;', 'no key or a wrong key — `401 invalid_key`; at most {{authFailPerMin}} wrong keys a minute from one IP;'),
      L('клиника выключила подключение — `401 key_disabled`; срок ключа вышел — `401 key_expired` (срок ставит клиника: без срока или {{keyTtlMonths|or}} месяцев);', 'klinika ulanishni o‘chirdi — `401 key_disabled`; kalit muddati tugadi — `401 key_expired` (muddatni klinika qo‘yadi: muddatsiz yoki {{keyTtlMonths|or}} oy);', 'the clinic switched the connection off — `401 key_disabled`; the key expired — `401 key_expired` (the clinic sets the term: none or {{keyTtlMonths|or}} months);'),
      L('у подключения заданы «Разрешённые IP» — запрос с другого адреса получает `403 ip_not_allowed`;', 'ulanishda «Ruxsat etilgan IP-manzillar» berilgan — boshqa manzildan so‘rov `403 ip_not_allowed` oladi;', 'the connection has “Allowed IP addresses” — a request from another address gets `403 ip_not_allowed`;'),
      L('запрос из браузера с сайта, которого нет в подключении (заголовок `Origin`), — `403 origin_not_allowed`.', 'ulanishda yo‘q saytdan brauzer so‘rovi (`Origin` sarlavhasi) — `403 origin_not_allowed`.', 'a browser request from a site not in the connection (the `Origin` header) — `403 origin_not_allowed`.'),
    ] },
    { p: L('Ключ в коде страницы видят все посетители сайта. Держите ключ на своём сервере; если запросы идут из браузера, попросите клинику дать такому подключению только чтение.', 'Sahifa kodidagi kalitni saytning barcha tashrif buyuruvchilari ko‘radi. Kalitni o‘z serveringizda saqlang; so‘rovlar brauzerdan ketsa, klinikadan bunday ulanishga faqat o‘qish huquqini berishni so‘rang.', 'Every visitor of a site can see a key in the page code. Keep the key on your server; if requests come from a browser, ask the clinic to give that connection read-only scopes.') },
    { p: L('Из браузера: предварительный запрос `OPTIONS` разрешает методы `GET, POST, DELETE` и заголовки `Authorization, Content-Type` и запоминается на {{corsMaxAgeMin:min}}; заголовок `Retry-After` скрипту виден.', 'Brauzerdan: `OPTIONS` dastlabki so‘rovi `GET, POST, DELETE` usullari va `Authorization, Content-Type` sarlavhalariga ruxsat beradi va {{corsMaxAgeMin:min}} eslab qolinadi; `Retry-After` sarlavhasi skriptga ko‘rinadi.', 'From a browser: the `OPTIONS` preflight allows the `GET, POST, DELETE` methods and the `Authorization, Content-Type` headers and is cached for {{corsMaxAgeMin:min}}; the script can read `Retry-After`.') },
    { table: 'limits' },
    { p: L('Сверх лимита — `429 rate_limited` и заголовок `Retry-After`: через сколько секунд повторить. Окно скользящее — последние 60 секунд.', 'Chegaradan oshsa — `429 rate_limited` va `Retry-After` sarlavhasi: necha soniyadan keyin takrorlash. Oyna siljuvchi — oxirgi 60 soniya.', 'Over the limit — `429 rate_limited` with a `Retry-After` header: how many seconds to wait. The window slides over the last 60 seconds.') },
  ] },
  { id: 'refs', title: L('Справочники', 'Ma’lumotnomalar', 'Reference lists'), blocks: [
    { p: L('Город, район и специальность приходят кодами. Коды и названия на трёх языках общие для всех клиник Easy-Med, код не меняется никогда. Загружайте справочники раз в сутки и храните у себя.', 'Shahar, tuman va mutaxassislik kodlar bilan keladi. Kodlar va uch tildagi nomlar barcha Easy-Med klinikalari uchun umumiy, kod hech qachon o‘zgarmaydi. Ma’lumotnomalarni sutkada bir marta yuklab, o‘zingizda saqlang.', 'City, district and specialty come as codes. The codes and their names in three languages are shared by all Easy-Med clinics; a code never changes. Load the lists once a day and keep them on your side.') },
    { endpoint: 'geo' }, { endpoint: 'specialties' },
  ] },
  { id: 'clinic', title: L('Клиника и филиалы', 'Klinika va filiallar', 'Clinic and branches'), blocks: [
    { endpoint: 'clinic' }, { endpoint: 'branches' }, { endpoint: 'media' },
  ] },
  { id: 'doctors', title: L('Врачи и свободное время', 'Shifokorlar va bo‘sh vaqt', 'Doctors and free time'), blocks: [
    { endpoint: 'doctors' }, { endpoint: 'slots' },
  ] },
  { id: 'services', title: L('Услуги и пакеты', 'Xizmatlar va paketlar', 'Services and packages'), blocks: [
    { endpoint: 'services' }, { endpoint: 'packages' },
  ] },
  { id: 'booking', title: L('Заявки и онлайн-запись', 'Arizalar va onlayn yozilish', 'Requests and online booking'), blocks: [
    { p: L('Всё, что присылает подключение, попадает в CRM клиники с источником этого подключения. Имя, телефон и комментарий пациента уходят только в клинику — зашифрованными её ключом; обратно приходят номер заявки `request_id` и её статус.', 'Ulanish yuborgan hamma narsa klinika CRM iga shu ulanish manbai bilan tushadi. Bemor ismi, telefoni va izohi faqat klinikaga — uning kaliti bilan shifrlangan holda boradi; orqaga ariza raqami `request_id` va uning holati qaytadi.', 'Everything a connection sends lands in the clinic CRM with that connection as the source. The patient’s name, phone and comment go only to the clinic — encrypted with its key; what comes back is the request number `request_id` and its status.') },
    { list: [
      L('`external_id` — ваш номер. Повтор с тем же `external_id` с того же ключа возвращает ту же заявку (`200`): при обрыве связи повторять безопасно.', '`external_id` — sizdagi raqam. Shu kalitdan shu `external_id` bilan takrorlash o‘sha arizani qaytaradi (`200`): aloqa uzilsa, takrorlash xavfsiz.', '`external_id` is your number. Repeating with the same `external_id` from the same key returns the same request (`200`): retrying after a dropped connection is safe.'),
      L('Заявки принимаются и тогда, когда клиника не на связи: заявка ждёт её {{uncollectedHours:hour}}.', 'Klinika aloqada bo‘lmaganda ham arizalar qabul qilinadi: ariza uni {{uncollectedHours:hour}} kutadi.', 'Requests are accepted even while the clinic is offline: a request waits for it for up to {{uncollectedHours:hour}}.'),
      L('Клиника не ответит — сервер закроет заявку сам (`closed`) без уведомления: подписать его может только клиника. Пока статус не итоговый, спрашивайте [статус](#ep-request-status) раз в несколько минут.', 'Klinika javob bermasa — server arizani o‘zi yopadi (`closed`), bildirishnomasiz: uni faqat klinika imzolay oladi. Holat yakuniy bo‘lmaguncha [holatni](#ep-request-status) bir necha daqiqada bir so‘rang.', 'If the clinic does not answer, the server closes the request itself (`closed`) without a notification: only the clinic can sign one. Until the status is final, ask for the [status](#ep-request-status) every few minutes.'),
    ] },
    { endpoint: 'requests-create' }, { endpoint: 'appointments-create' }, { endpoint: 'request-status' },
    { p: L('Клиника может предложить другое время: статус `offered`, ответ ждёт {{offerMin:min}} — до `offer_until`. Пришлите в теле `offered_start` — время, на которое отвечаете: если клиника успела предложить другое, ответ `409 offer_changed`. Согласие после `offer_until` — `409 offer_expired`.', 'Klinika boshqa vaqt taklif qilishi mumkin: holat `offered`, javob {{offerMin:min}} — `offer_until` gacha kutiladi. Tanada `offered_start` ni — javob berayotgan vaqtni yuboring: klinika boshqasini taklif qilib ulgurgan bo‘lsa, javob `409 offer_changed`. `offer_until` dan keyingi rozilik — `409 offer_expired`.', 'The clinic may offer another time: status `offered`, waiting {{offerMin:min}} for an answer — until `offer_until`. Send `offered_start` in the body — the time you are answering: if the clinic has offered another one meanwhile, the response is `409 offer_changed`. Accepting after `offer_until` gives `409 offer_expired`.') },
    { endpoint: 'offer-accept' }, { endpoint: 'offer-decline' }, { endpoint: 'appointments-cancel' },
  ] },
  { id: 'statuses', title: L('Статусы заявки', 'Ariza holatlari', 'Request statuses'), blocks: [
    { list: [
      L('«Перезвоните»: `new` → `accepted` → `booked` (записали на визит) → `cancelled` или `arrived`.', '«Qayta qo‘ng‘iroq»: `new` → `accepted` → `booked` (tashrifga yozildi) → `cancelled` yoki `arrived`.', 'Callback: `new` → `accepted` → `booked` (a visit was booked) → `cancelled` or `arrived`.'),
      L('Онлайн-запись: `pending` → `booked`, `offered`, `declined` или `expired`; `offered` → `pending` (согласие) или `cancelled`; `booked` → `cancelled` или `arrived`.', 'Onlayn yozilish: `pending` → `booked`, `offered`, `declined` yoki `expired`; `offered` → `pending` (rozilik) yoki `cancelled`; `booked` → `cancelled` yoki `arrived`.', 'Online booking: `pending` → `booked`, `offered`, `declined` or `expired`; `offered` → `pending` (accepted) or `cancelled`; `booked` → `cancelled` or `arrived`.'),
      L('Без ответа клиники: `new` или `pending` → `closed`.', 'Klinika javobisiz: `new` yoki `pending` → `closed`.', 'Without an answer from the clinic: `new` or `pending` → `closed`.'),
    ] },
    { table: 'statuses' },
    { table: 'reasons' },
  ] },
  { id: 'hooks', title: L('Уведомления', 'Bildirishnomalar', 'Notifications'), blocks: [
    { p: L('Если у подключения есть адрес для уведомлений, Easy-Med присылает на него `POST` при каждом событии, которое выбрала клиника. Адрес — только https и доменное имя в интернете.', 'Ulanishda bildirishnomalar manzili bo‘lsa, Easy-Med unga klinika tanlagan har bir hodisada `POST` yuboradi. Manzil — faqat https va internetdagi domen nomi.', 'If the connection has a notification address, Easy-Med sends it a `POST` on every event the clinic selected. The address must be https with a public domain name.') },
    { webhook: true },
    { p: L('Тело — JSON в одну строку; общие поля: `event_id`, `event`, `request_id`, `external_id`, `status`, `occurred_at` (UTC). Данных пациента в уведомлениях нет.', 'Tana — bir qatorli JSON; umumiy maydonlar: `event_id`, `event`, `request_id`, `external_id`, `status`, `occurred_at` (UTC). Bildirishnomalarda bemor ma’lumotlari yo‘q.', 'The body is single-line JSON; the common fields are `event_id`, `event`, `request_id`, `external_id`, `status`, `occurred_at` (UTC). Notifications carry no patient data.') },
    { table: 'events' },
    { p: L('Подпись: `X-EasyMed-Signature: sha256=<hex>` — HMAC-SHA256 тела секретом подключения (`{{secretPrefix}}…`, его даёт клиника). Подписывает клиника — сервер Easy-Med подделать уведомление не может. Проверяйте подпись по телу байт в байт, до разбора JSON:', 'Imzo: `X-EasyMed-Signature: sha256=<hex>` — tananing ulanish siri (`{{secretPrefix}}…`, uni klinika beradi) bilan HMAC-SHA256. Klinika imzolaydi — Easy-Med serveri bildirishnomani soxtalashtira olmaydi. Imzoni JSON ni o‘qishdan oldin, tanaga baytma-bayt tekshiring:', 'Signature: `X-EasyMed-Signature: sha256=<hex>` — HMAC-SHA256 of the body with the connection secret (`{{secretPrefix}}…`, from the clinic). The clinic signs — the Easy-Med server cannot forge a notification. Check the signature against the raw body byte for byte, before parsing JSON:') },
    { verify: 'node' }, { verify: 'php' },
    { list: [
      L('Ответьте любым `2xx` за {{webhookTimeoutSec:sec}}. Тело ответа не читается, перенаправления не выполняются.', '{{webhookTimeoutSec:sec}} ichida istalgan `2xx` bilan javob bering. Javob tanasi o‘qilmaydi, yo‘naltirishlar bajarilmaydi.', 'Answer with any `2xx` within {{webhookTimeoutSec:sec}}. The response body is ignored; redirects are not followed.'),
      L('Нет ответа или не `2xx` — повторы через {{retryMinutes}} минут: всего {{attempts:attempt}}, не дольше {{windowMin:min}} от события. Адрес, который {{hostTripAfter:time}} подряд не принимает соединение, отдыхает от {{hostRestFirstSec}} до {{hostRestMaxSec:sec}}: уведомления к нему ждут, попытки не тратятся.', 'Javob bo‘lmasa yoki `2xx` bo‘lmasa — {{retryMinutes}} daqiqadan keyin takrorlanadi: jami {{attempts:attempt}}, hodisadan {{windowMin:min}}dan oshmaydi. Ketma-ket {{hostTripAfter:time}} ulanishni qabul qilmagan manzil {{hostRestFirstSec}} dan {{hostRestMaxSec:sec}}gacha dam oladi: unga bildirishnomalar kutadi, urinishlar sarflanmaydi.', 'No answer or not `2xx` — retries after {{retryMinutes}} minutes: {{attempts:attempt}} in all, no later than {{windowMin:min}} after the event. An address that refuses the connection {{hostTripAfter:time}} in a row rests for {{hostRestFirstSec}} to {{hostRestMaxSec:sec}}: its notifications wait and no attempts are spent.'),
      L('Уведомления могут прийти не по порядку и дважды: узнавайте событие по `event_id`, а точный статус — в [статусе заявки](#ep-request-status).', 'Bildirishnomalar tartibsiz va ikki marta kelishi mumkin: hodisani `event_id` bo‘yicha taniy oling, aniq holatni esa [ariza holatida](#ep-request-status) ko‘ring.', 'Notifications may arrive out of order or twice: recognise an event by `event_id` and read the exact status from the [request status](#ep-request-status).'),
      L('Уведомления нет, когда заявку закрывает сервер (`closed`), и о «другом времени», на которое вы уже не можете ответить (вы отменили или отказались).', 'Server arizani yopganda (`closed`) va siz endi javob bera olmaydigan «boshqa vaqt» haqida (siz bekor qildingiz yoki rad etdingiz) bildirishnoma bo‘lmaydi.', 'There is no notification when the server closes a request (`closed`), nor about “another time” you can no longer answer (you cancelled or declined).'),
    ] },
  ] },
  { id: 'errors', title: L('Ошибки', 'Xatolar', 'Errors'), blocks: [
    { p: L('Ошибка — HTTP-код и тело `{"error": {"code", "message", …}}`; текст `message` — на языке `?lang`. Поля сверх кода: `field` и `reason` — какое поле и что с ним, `scope` — нужное право, `phone` — телефон клиники.', 'Xato — HTTP kodi va `{"error": {"code", "message", …}}` tanasi; `message` matni — `?lang` tilida. Koddan tashqari maydonlar: `field` va `reason` — qaysi maydon va unda nima bor, `scope` — kerakli huquq, `phone` — klinika telefoni.', 'An error is an HTTP code and a body `{"error": {"code", "message", …}}`; the `message` text follows `?lang`. Fields beyond the code: `field` and `reason` — which field and what is wrong, `scope` — the scope needed, `phone` — the clinic phone.') },
    { example: 'error-field' }, { example: 'error-key' },
    { table: 'errors' },
    { table: 'fields' },
  ] },
]);
```

- [ ] **Step 5:** `node --test public-server/server/docs/drift.test.js` → **10 тестов** (после ревью шага 9 — **12**: переходы статусов, цифры руками) зелёные (и с `force-en.mjs`); сторожа А — зелёные.
- [ ] **Step 6: проверка поломкой** (ничего не коммитить, после — вернуть файл как был, `git diff --stat` пуст по этим файлам): в `routes/partner-read.js` перед `r.get('/reference/geo'` вписать `r.get('/news', scope('clinic'), (req, res) => res.json({}));` → тест «адреса» красный; в `lib/errors.js` добавить код `holiday` → тест «коды ошибок» красный. Вернуть оба файла правкой назад (не `git checkout`).
- [ ] **Step 7: коммит** «Документация API: текст страницы на ru / uz / en и её числа из постоянных сервера; страж — адреса сервера партнёров, права, статусы, причины, события (как их шлёт клиника), коды ошибок, причины полей и ритм клиники — те же, что в коде; пример проверки подписи принимает подпись клиники» — три файла.

---

## Task 3: Примеры на настоящем сервере — мир «Шифо», `generated.js`, пробы полей и прав (API_DOCS_V1)

Сборщик А.

**Files:**
- Modify: `public-server/server/test-helpers/partner-stand.js` — параметры `snapshot`, `slots`, `baseUrl`.
- Create: `public-server/server/test-helpers/docs-world.js`
- Create: `public-server/server/test-helpers/docs-run.js`
- Create: `public-server/scripts/docs-build.mjs`
- Create: `public-server/server/docs/generated.js` — **командой** (шаг 6).
- Create: `public-server/server/docs/examples.http.test.js`

- [ ] **Step 1: падающий тест** `public-server/server/docs/examples.http.test.js`:

```js
// API_DOCS_V1 — СТРАЖ «ПРИМЕРЫ СТРАНИЦЫ РАБОТАЮТ». Настоящий сервер партнёров
// в процессе (стенд, случайный порт 127.0.0.1, мир клиники «Шифо»):
//   • docs/generated.js — то, что сервер отвечает сейчас (иначе: пересобрать
//     `node public-server/scripts/docs-build.mjs`), подписи — из словаря программы;
//   • каждая строка таблицы полей воспроизводится своим запросом, границы полей
//     пациента — те, что написаны;
//   • права: без права адреса — 403 с этим правом, с любым из названных — не 403;
//     справочники — любому ключу, файлы — без ключа;
//   • коды тела, CORS и Max-Age — как написано.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildGenerated, GENERATED_FILE, docsStand, exampleRequest, sendExample, resolve, WRONG_KEY, NO_LIMITS } from '../test-helpers/docs-run.js';
import { DOCS_ORIGIN } from '../test-helpers/docs-world.js';
import { EXAMPLES, ENDPOINTS, FIELD_ERRORS } from './content.js';
import { LABELS } from './generated.js';
import { PATIENT_RULES, CORS_MAX_AGE_SEC, docFacts } from './facts.js';
import { SCOPES, SCOPE_INFO, EVENT_INFO } from '../../../public/js/shared/api-connections.js';
import { PUBLIC_GROUPS } from '../../../public/js/shared/service-public.js';

test('docs/generated.js — ответы сервера сейчас (иначе: node public-server/scripts/docs-build.mjs)', async () => {
  assert.equal(await buildGenerated(), fs.readFileSync(GENERATED_FILE, 'utf8'),
    'ответы партнёрам или примеры изменились — пересоберите: node public-server/scripts/docs-build.mjs');
  const labels = [...Object.values(SCOPE_INFO).flatMap((v) => [v.label, v.desc]), ...Object.values(EVENT_INFO).flatMap((v) => [v.label, v.desc]),
    ...PUBLIC_GROUPS.map((g) => g.label)];
  for (const l of labels) assert.ok(LABELS[l] && LABELS[l].uz && LABELS[l].en, 'нет перевода подписи: ' + l);
});

test('таблица полей: каждая строка — тем запросом, что в её пробах, на каждом названном адресе', async (t) => {
  const s = await docsStand({ limiter: NO_LIMITS });
  t.after(s.close);
  const appt = EXAMPLES.find((x) => x.id === 'appointment-new');
  const own = await sendExample(s, exampleRequest({ ...appt, body: { ...appt.body, start: '2030-03-13T14:00:00+05:00', external_id: 'probe-own' } }, 'ru', {}));
  assert.equal(own.status, 201);
  const bodyOf = { 'requests-create': EXAMPLES.find((x) => x.id === 'request-new').body, 'appointments-create': appt.body, 'offer-accept': {}, 'offer-decline': {} };
  let n = 0;
  for (const f of FIELD_ERRORS) {
    for (const [ep, probe] of Object.entries(f.probes)) {
      const e = ENDPOINTS.find((x) => x.id === ep);
      const req = probe.path
        ? { method: 'GET', path: probe.path }
        : { method: e.method, path: e.path.replace('{id}', own.body.request_id), body: resolve({ ...bodyOf[ep], ...probe.body }, 'ru', {}) };
      const r = await sendExample(s, req);
      const want = f.reason ? [400, 'invalid_field', f.field, f.reason] : [404, 'not_found', f.field, undefined];
      assert.deepEqual([r.status, r.body.error && r.body.error.code, r.body.error && r.body.error.field, r.body.error && r.body.error.reason], want,
        ep + ' ' + f.field + '/' + (f.reason || f.code));
      n += 1;
    }
  }
  assert.ok(n >= 50, 'проб меньше, чем строк: ' + n);
});

test('поля пациента и номер партнёра: граница — та, что написана (на границе — принято, за ней — 400)', async (t) => {
  const s = await docsStand();
  t.after(s.close);
  const R = PATIENT_RULES;
  const send = (body) => sendExample(s, { method: 'POST', path: '/requests', body });
  const okPhone = '+' + '9'.repeat(R.phoneMax - 1);
  const cases = [
    [{ patient: { name: 'x'.repeat(R.nameMax), phone: okPhone, comment: 'x'.repeat(R.commentMax) }, external_id: 'e'.repeat(R.externalMax) }, 201],
    [{ patient: { name: 'Aziza', phone: '+' + '9'.repeat(R.phoneMax) }, external_id: 'p1' }, 400],
    [{ patient: { name: 'Aziza', phone: '1'.repeat(R.phoneDigitsMin) }, external_id: 'p2' }, 201],
    [{ patient: { name: 'Aziza', phone: '1'.repeat(R.phoneDigitsMin - 1) }, external_id: 'p3' }, 400],
    [{ patient: { name: 'Aziza', phone: okPhone }, external_id: 'e'.repeat(R.externalMax + 1) }, 400],
  ];
  for (const [body, status] of cases) assert.equal((await send(body)).status, status, JSON.stringify(body).slice(0, 80));
});

test('права: без права адреса — 403 с этим правом; с любым из названных — не 403; справочники — любому ключу; файлы — без ключа', async (t) => {
  const s = await docsStand({ limiter: NO_LIMITS });
  t.after(s.close);
  const call = (e, headers = {}) => fetch(s.base + '/shifo/v1' + e.path.replace('{id}', 'rq_unknown1').replace('{file}', 'a'.repeat(64) + '.png')
    + (e.id === 'slots' ? '?doctor_id=7' : ''), { method: e.method, headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json', ...headers },
    body: e.method === 'POST' ? '{}' : undefined });
  for (const e of ENDPOINTS) {
    if (e.scopes === null) {
      const r = await fetch(s.base + '/shifo/v1' + e.path.replace('{file}', 'a'.repeat(64) + '.png'));
      assert.equal(r.status, 404, e.id + ': без ключа — не 401 (файла нет — 404)');
      continue;
    }
    const others = SCOPES.filter((x) => !e.scopes.includes(x));
    s.setConnection({ scopes: e.scopes.length ? others : ['cancel'], rate_limit: 300 });
    const denied = await call(e);
    if (e.scopes.length) {
      const body = await denied.json();
      assert.deepEqual([denied.status, body.error.code, body.error.scope], [403, 'forbidden_scope', e.scopes[0]], e.id);
    } else assert.notEqual(denied.status, 403, e.id + ': любой ключ');
    for (const sc of e.scopes) {
      s.setConnection({ scopes: [sc], rate_limit: 300 });
      assert.notEqual((await call(e)).status, 403, e.id + ' с правом ' + sc);
    }
  }
});

test('тело и браузер: bad_json, bad_request, too_large, unsupported_encoding; CORS — методы, заголовки, Max-Age, Retry-After', async (t) => {
  const s = await docsStand();
  t.after(s.close);
  const post = (body, headers = {}) => fetch(s.base + '/shifo/v1/requests', { method: 'POST', body,
    headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json', ...headers } }).then(async (r) => [r.status, (await r.json()).error.code]);
  assert.deepEqual(await post('{"patient":'), [400, 'bad_json']);
  assert.deepEqual(await post('[]'), [400, 'bad_request']);
  const kb = docFacts().bodyKb;
  assert.deepEqual(await post(JSON.stringify({ patient: { name: 'x', phone: '+998901234567', comment: 'x'.repeat(kb * 1024) } })), [413, 'too_large']);
  assert.deepEqual(await post(zlib.deflateSync('{}'), { 'Content-Encoding': 'compress' }), [415, 'unsupported_encoding']);
  const pre = await fetch(s.base + '/shifo/v1/doctors', { method: 'OPTIONS', headers: { Origin: DOCS_ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-max-age'), String(CORS_MAX_AGE_SEC));
  assert.match(pre.headers.get('access-control-allow-methods'), /^GET, POST, DELETE\b/);
  assert.equal(pre.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  const get = await fetch(s.base + '/shifo/v1/doctors', { headers: { Authorization: 'Bearer ' + s.key, Origin: DOCS_ORIGIN } });
  assert.equal(get.headers.get('access-control-expose-headers'), 'Retry-After');
  const other = await fetch(s.base + '/shifo/v1/doctors', { headers: { Authorization: 'Bearer ' + s.key, Origin: 'https://other.example' } });
  assert.deepEqual([other.status, (await other.json()).error.code], [403, 'origin_not_allowed']);
  const wrong = await fetch(s.base + '/shifo/v1/clinic', { headers: { Authorization: 'Bearer ' + WRONG_KEY } });
  assert.equal(wrong.status, 401);
});
```

- [ ] **Step 2:** `node --test public-server/server/docs/examples.http.test.js` → падает при загрузке: `Cannot find module …/test-helpers/docs-run.js`.
- [ ] **Step 3: стенд** — diff к `partner-stand.js`:

```diff
diff --git a/public-server/server/test-helpers/partner-stand.js b/public-server/server/test-helpers/partner-stand.js
--- a/public-server/server/test-helpers/partner-stand.js
+++ b/public-server/server/test-helpers/partner-stand.js
@@ -56,8 +56,13 @@ export function slotsFixture(at = NOW) {
 
 export const SCOPES_ALL = ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments', 'cancel'];
 
-/** Стенд: { base, db, key, clock, setClock, conn(over), close, clinicId }. */
-export async function partnerStand({ scopes = SCOPES_ALL, connection = {}, requireHttps = false, trustProxy = false, limiter = createLimiter() } = {}) {
+/**
+ * Стенд: { base, db, key, clock, setClock, conn(over), close, clinicId }.
+ * API_DOCS_V1 — snapshot, slots, baseUrl: мир примеров документации
+ * (test-helpers/docs-world.js) вместо мира тестов 8b.
+ */
+export async function partnerStand({ scopes = SCOPES_ALL, connection = {}, requireHttps = false, trustProxy = false, limiter = createLimiter(),
+  snapshot = snapshotFixture(), slots = slotsFixture(), baseUrl = 'https://api.test' } = {}) {
   const { db, dir } = testDb();
   const vendor = testVendor();
   const clinic = testClinic(vendor);
@@ -73,9 +78,9 @@ export async function partnerStand({ scopes = SCOPES_ALL, connection = {}, requi
     saveKeys(db, clinic.clinicId, { generated_at: isoOf(keysAt), box_key: clinic.identity.boxPublic, connections: [conn(over)] }, keysAt);
   };
   setConnection({});
-  saveSnapshot(db, clinic.clinicId, snapshotFixture(), NOW);
-  saveSlots(db, clinic.clinicId, slotsFixture(), NOW);
-  const ctx = { db, dataDir: dir, now: () => clock, offsetMin: OFFSET, baseUrl: 'https://api.test', requireHttps, limiter };
+  saveSnapshot(db, clinic.clinicId, snapshot, NOW);
+  saveSlots(db, clinic.clinicId, slots, NOW);
+  const ctx = { db, dataDir: dir, now: () => clock, offsetMin: OFFSET, baseUrl, requireHttps, limiter };
   const srv = await serve('/:slug/v1', partnerRouter(ctx), { trustProxy });
   const get = (p, { headers = {}, auth = true } = {}) =>
     fetch(srv.base + p, { headers: { ...(auth ? { Authorization: 'Bearer ' + key } : {}), ...headers } });
```

- [ ] **Step 4: мир примеров** `public-server/server/test-helpers/docs-world.js`:

```js
// API_DOCS_V1 — МИР ПРИМЕРОВ ДОКУМЕНТАЦИИ: клиника «Шифо» (shifo), её снимок и
// свободное время. На них публичный сервер отвечает примерам страницы /docs:
// ответы примеров не пишутся руками — их записывает
// `node public-server/scripts/docs-build.mjs` (server/docs/generated.js), а
// страж docs/examples.http.test.js спрашивает сервер заново и сверяет.
//
// Часы — NOW стенда: понедельник 11.03.2030, 09:00 в Ташкенте. Имена, телефоны
// и адреса — выдуманные; сайты и соцсети — в зоне .example (RFC 2606).
import { NOW } from './fixture.js';
import { isoOf } from '../lib/time.js';

export const DOCS_ORIGIN = 'https://partner.example';
const t3 = (ru, uz, en) => ({ ru, uz, en });
const LOGO = 'media/cea9dd816d60f34c6a18f35350e00ab868d8fe002be2c51886fdae50bf9df0f7.png';
const PHOTO = 'media/ce1ef52a4851e3b88f63ee8ad2b89acb885be028fb05f09dd99e35483f1dee1f.webp';
const WORKDAY = ['08:00', '18:00'];
const WEEK = { mon: WORKDAY, tue: WORKDAY, wed: WORKDAY, thu: WORKDAY, fri: WORKDAY, sat: ['09:00', '15:00'], sun: null };
const MAP = 'https://yandex.uz/maps/?pt=69.2797,41.3111&z=17';
const ROUTE = 'https://yandex.uz/maps/?rtext=~41.3111,69.2797&rtt=auto';

export function docsSnapshot(at = NOW) {
  return {
    version: 1, generated_at: isoOf(at), slug: 'shifo',
    clinic: {
      name: t3('Клиника «Шифо»', '«Shifo» klinikasi', 'Shifo Clinic'),
      about: t3('Семейная клиника: взрослые и дети, анализы, УЗИ.', 'Oilaviy klinika: kattalar va bolalar, tahlillar, UTT.',
        'Family clinic: adults and children, lab tests, ultrasound.'),
      country: 'UZ', city: 'tashkent-city', district: 'yunusobod',
      street: t3('ул. Амира Темура, 1', 'Amir Temur ko‘chasi, 1', '1 Amir Temur Street'),
      phone: '+998712000000', site: 'https://shifo.example', telegram_bot: '@shifo_example_bot', telegram_channel: '@shifo_example',
      instagram: '@shifo.example', logo: { square: LOGO, portrait: null }, map_url: MAP, route_url: ROUTE,
    },
    branches: [
      { id: 1, name: t3('Главный корпус', 'Bosh bino', 'Main building'), city: 'tashkent-city', district: 'yunusobod',
        street: t3('ул. Амира Темура, 1', 'Amir Temur ko‘chasi, 1', '1 Amir Temur Street'),
        landmark: t3('напротив парка', 'bog‘ qarshisida', 'opposite the park'), phone: '+998712000000', hours: WEEK, open_24_7: false,
        map_url: MAP, route_url: ROUTE },
      { id: 2, name: t3('Филиал «Мирабад»', '«Mirobod» filiali', 'Mirobod branch'), city: 'tashkent-city', district: 'mirobod',
        street: t3('ул. Нукус, 5', 'Nukus ko‘chasi, 5', '5 Nukus Street'), landmark: t3('', '', ''), phone: '+998712000001',
        hours: { ...WEEK, sat: null }, open_24_7: false, map_url: '', route_url: '' },
    ],
    doctors: [
      { id: 7, name: t3('Каримов Азиз Рустамович', 'Karimov Aziz Rustamovich', 'Aziz Karimov'),
        title: t3('Врач высшей категории', 'Oliy toifali shifokor', 'Senior physician'),
        bio: t3('Детский врач, 12 лет практики.', 'Bolalar shifokori, 12 yillik tajriba.', 'Paediatrician, 12 years of practice.'),
        specialties: ['pediatr'], experience_years: 12, languages: ['ru', 'uz'], photo: PHOTO, branch_ids: [1], reception: 'booking', booking_days: 14,
        // Только первичный приём: на нём страж показывает 400 consultation / not_offered для repeat.
        consultations: [{ type: 'initial', name: t3('Первичный приём', 'Birlamchi qabul', 'First visit'), price: 150000, minutes: 30 }],
        services: [{ service_id: 303, price: 80000 }] },
      { id: 8, name: t3('Юсупова Нигора Алишеровна', 'Yusupova Nigora Alisherovna', 'Nigora Yusupova'), title: t3('', '', ''),
        bio: t3('Терапевт.', 'Terapevt.', 'General practitioner.'), specialties: ['terapevt'], experience_years: 8, languages: ['ru', 'uz', 'en'],
        photo: null, branch_ids: [2], reception: 'live_queue', booking_days: 14, consultations: [], services: [] },
    ],
    services: [
      { id: 301, group: 'lab', name: t3('Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count'), price: 45000, minutes: 10 },
      { id: 302, group: 'diagnostics', name: t3('УЗИ брюшной полости', 'Qorin bo‘shlig‘i UTT', 'Abdominal ultrasound'), price: 180000, minutes: 20 },
      { id: 303, group: 'consultations', name: t3('Консультация по анализам', 'Tahlillar bo‘yicha maslahat', 'Test results consultation'),
        price: 80000, minutes: 15 },
    ],
    packages: [
      { id: 4, name: t3('Check-up базовый', 'Check-up asosiy', 'Basic check-up'), price_full: 225000, price: 191250, discount_percent: 15,
        valid_until: '2030-06-30', items: [{ service_id: 301, price_full: 45000, price: 38250 }, { service_id: 302, price_full: 180000, price: 153000 }] },
    ],
  };
}

export function docsSlots(at = NOW) {
  return {
    generated_at: isoOf(at), slot_minutes: 15, doctors: {
      7: { reception: 'booking', days: [
        { date: '2030-03-12', from: '09:00', to: '10:30', starts: ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15'], free: '110111' },
        { date: '2030-03-13', from: '14:00', to: '15:00', starts: ['14:00', '14:15', '14:30', '14:45'], free: '1111' },
      ] },
      8: { reception: 'live_queue', hours: { mon: ['08:00', '14:00'], tue: ['08:00', '14:00'], wed: ['08:00', '14:00'], thu: ['08:00', '14:00'],
        fri: ['08:00', '14:00'], sat: null, sun: null }, queue_now: 3 },
    },
  };
}
```

- [ ] **Step 5: примеры на стенде** `public-server/server/test-helpers/docs-run.js`:

```js
// API_DOCS_V1 — ПРИМЕРЫ ДОКУМЕНТАЦИИ НА НАСТОЯЩЕМ СЕРВЕРЕ. Запросы примеров
// (docs/content.js EXAMPLES) уходят настоящим адресам партнёров стенда с миром
// клиники «Шифо» (docs-world.js) — так же, как их отправит curl со страницы.
// Ответы записывает `node public-server/scripts/docs-build.mjs` в
// server/docs/generated.js; страж docs/examples.http.test.js спрашивает заново
// и сверяет файл с тем, что сервер отвечает сейчас.
//
// Номера заявок сервер выдаёт случайно — в записанное они попадают номерами
// страницы (SAMPLE.ids), чтобы файл не менялся от прогона к прогону.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partnerStand } from './partner-stand.js';
import { docsSnapshot, docsSlots, DOCS_ORIGIN } from './docs-world.js';
import { NOW } from './fixture.js';
import { EXAMPLES, SAMPLE } from '../docs/content.js';
import { ackInbox, applyEvents } from '../store/requests.js';
import { isoOf } from '../lib/time.js';
import { webhookBody } from '../../../public/js/shared/api-booking.js';
import { SCOPE_INFO, EVENT_INFO, API_DOCS_LANGS } from '../../../public/js/shared/api-connections.js';
import { PUBLIC_GROUPS } from '../../../public/js/shared/service-public.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';

export const GENERATED_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'generated.js');
export const WRONG_KEY = 'em_live_wrong';

/** Стенд партнёров с миром примеров: адрес сервера — как на странице, сайт подключения — partner.example. */
export const docsStand = (over = {}) => partnerStand({ snapshot: docsSnapshot(), slots: docsSlots(), baseUrl: SAMPLE.base,
  connection: { origins: [DOCS_ORIGIN] }, ...over });
/** Лимиты не мешают пробам: их проверяют тесты 8b (partner-read / partner-write). */
export const NO_LIMITS = Object.freeze({ hit: () => ({ ok: true, remaining: 1 }) });

const isTri = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).join() === 'ru,uz,en';
/** Значение примера на языке lang: {lang} и {имя} номера заявки в строках, L(…) — строка языка. */
export function resolve(v, lang, ids) {
  if (typeof v === 'string') return v.replace(/\{([a-z]+)\}/g, (m, k) => (k === 'lang' ? lang : ids[k] || m));
  if (Array.isArray(v)) return v.map((x) => resolve(x, lang, ids));
  if (isTri(v)) return v[lang];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, lang, ids)]));
  return v;
}

/** Длинные списки — первыми n строками: { countries: 2, 'cities.districts': 2 }. */
export function trimmed(value, spec = {}) {
  const cut = (v, keys, n) => {
    if (!v || typeof v !== 'object') return v;
    const [k, ...rest] = keys;
    if (!Array.isArray(v[k])) return v;
    return { ...v, [k]: rest.length ? v[k].map((x) => cut(x, rest, n)) : v[k].slice(0, n) };
  };
  return Object.entries(spec).reduce((v, [p, n]) => cut(v, p.split('.'), n), value);
}

const swapIds = (v, map) => {
  if (typeof v === 'string') return map.has(v) ? map.get(v) : v;
  if (Array.isArray(v)) return v.map((x) => swapIds(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swapIds(x, map)]));
  return v;
};

// Что клиника делает между примерами (её шаги обмена с сервером, 8a) и сколько
// проходит времени: страница показывает утро одного понедельника.
const MIN = 60000;
export const CLINIC_STEPS = Object.freeze({
  // 09:01 — клиника забрала очередь и держит время онлайн-записи 30 минут.
  'request-held': (s, ids) => {
    s.setClock(NOW + MIN);
    const c = s.db.prepare('SELECT MAX(cursor) AS c FROM inbox WHERE clinic_id = ?').get(s.clinicId).c;
    ackInbox(s.db, s.clinicId, String(c), [{ request_id: ids.appointment, hold_until: isoOf(NOW + 31 * MIN) }], NOW + MIN);
  },
  // 09:05 — регистратор предложил 10:00 вместо 09:45; ответ ждут 30 минут.
  'request-offered': (s, ids) => {
    s.setClock(NOW + 5 * MIN);
    const body = webhookBody({ eventId: 'ev_0a1b2c3d4e5f60718293a4b5', event: 'booking.offered_other_time', publicId: ids.appointment, externalId: 'bk-2002',
      status: 'offered', occurredAt: isoOf(NOW + 5 * MIN), details: { doctor_id: 7, offered_start: '2030-03-12T10:00:00+05:00', offer_until: '2030-03-11T09:35:00+05:00' } });
    applyEvents(s.db, s.clinicId, [{ seq: 1, event: body.event, status: 'offered', body: JSON.stringify(body), webhook_url: '', signature: '' }], NOW + 5 * MIN);
  },
  'offer-accept': (s) => s.setClock(NOW + 7 * MIN),   // 09:07 — пациент согласился
  'appointment-cancel': (s) => s.setClock(NOW + 10 * MIN),   // 09:10 — пациент передумал
});

/** Запрос примера: метод, путь от /<клиника>/v1, тело, ключ. */
export function exampleRequest(ex, lang, ids) {
  return { method: ex.method, path: resolve(ex.path, lang, ids), body: ex.body === undefined ? undefined : resolve(ex.body, lang, ids),
    wrongKey: ex.key === 'wrong' };
}

/** Отправить запрос примера на стенд → { status, body }. */
export async function sendExample(s, req) {
  const headers = { Authorization: 'Bearer ' + (req.wrongKey ? WRONG_KEY : s.key) };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(s.base + '/' + SAMPLE.slug + '/v1' + req.path, { method: req.method, headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body) });
  return { status: res.status, body: await res.json() };
}

/** Все примеры на языке lang, по порядку, на свежем стенде → { id: {status, body} } с номерами страницы. */
export async function runExamples(lang) {
  const s = await docsStand();
  try {
    const ids = {};
    const real = new Map();
    const out = {};
    for (const ex of EXAMPLES) {
      if (CLINIC_STEPS[ex.id]) CLINIC_STEPS[ex.id](s, ids);
      const r = await sendExample(s, exampleRequest(ex, lang, ids));
      if (ex.saveAs && r.body.request_id) {
        ids[ex.saveAs] = r.body.request_id;
        real.set(r.body.request_id, SAMPLE.ids[ex.saveAs]);
      }
      out[ex.id] = { status: r.status, body: trimmed(r.body, ex.trim) };
    }
    return swapIds(out, real);
  } finally { await s.close(); }
}

/** Переводы подписей словарей программы, которые показывает страница: русская подпись → {uz, en}. */
export function docLabels() {
  const ru = [...Object.values(SCOPE_INFO).flatMap((v) => [v.label, v.desc]), ...Object.values(EVENT_INFO).flatMap((v) => [v.label, v.desc]),
    ...PUBLIC_GROUPS.map((g) => g.label)];
  return Object.fromEntries(ru.map((k) => {
    const e = STRINGS[k];
    if (!e || !e.uz || !e.en) throw new Error('нет перевода в i18n-strings.js: ' + k);
    return [k, { uz: e.uz, en: e.en }];
  }));
}

/** Текст server/docs/generated.js. */
export async function buildGenerated() {
  const responses = {};
  for (const lang of API_DOCS_LANGS) responses[lang] = await runExamples(lang);
  return [
    '// API_DOCS_V1 — СОЗДАН `node public-server/scripts/docs-build.mjs`; руками не править.',
    '//',
    '// RESPONSES — что публичный сервер ответил на запросы примеров документации',
    '// (docs/content.js EXAMPLES) для клиники-примера «Шифо» (test-helpers/docs-world.js);',
    '// LABELS — переводы подписей прав, событий и групп услуг из словаря программы',
    '// (public/js/admin/i18n-strings.js): страница говорит теми же словами, что экран',
    '// клиники. Страж docs/examples.http.test.js пересобирает файл и сверяет.',
    'export const LABELS = ' + JSON.stringify(docLabels(), null, 2) + ';',
    '',
    'export const RESPONSES = ' + JSON.stringify(responses, null, 2) + ';',
    '',
  ].join('\n');
}
```

`public-server/scripts/docs-build.mjs`:

```js
// API_DOCS_V1 — пересобрать public-server/server/docs/generated.js: ответы
// примеров документации (настоящий сервер в этом процессе, мир клиники «Шифо»,
// случайный порт 127.0.0.1 — test-helpers/docs-run.js) и переводы подписей из
// словаря программы. Запускать из корня репозитория после правки ответов
// партнёрам, примеров (docs/content.js) или подписей прав и событий:
//   node public-server/scripts/docs-build.mjs
// Страж docs/examples.http.test.js краснеет, пока файл не пересобран.
import fs from 'node:fs';
import path from 'node:path';
import { buildGenerated, GENERATED_FILE } from '../server/test-helpers/docs-run.js';

const text = await buildGenerated();
fs.writeFileSync(GENERATED_FILE, text);
console.log('docs: ' + path.relative(process.cwd(), GENERATED_FILE).replace(/\\/g, '/') + ' — ' + text.length + ' знаков');
```

- [ ] **Step 6: записать ответы** — из корня клона: `node public-server/scripts/docs-build.mjs` → `docs: public-server/server/docs/generated.js — 44264 знаков`. Файл тот же у всех: `certutil -hashfile public-server\server\docs\generated.js SHA256` (или `sha256sum`) → `2062a09c3c4887c4dd93ca3a4fff358596f9ae9317478425189025ef6116bddb`. Другое — значит, ответы сервера в клоне отличаются от сверенных: остановиться и сообщить контролёру. Вид ответа — например, `RESPONSES.ru['appointment-new']`:

```json
"appointment-new": {
  "status": 201,
  "body": {
    "request_id": "rq_Shf3Pr6Yt1Gh8Jk2Mn5Bv9Ce",
    "external_id": "bk-2002",
    "type": "appointment",
    "status": "pending",
    "doctor_id": 7,
    "branch_id": 1,
    "consultation": "initial",
    "start": "2030-03-12T09:45:00+05:00",
    "created_at": "2030-03-11T09:00:00+05:00",
    "updated_at": "2030-03-11T09:00:00+05:00"
  }
}
```

- [ ] **Step 7:** `node --test public-server/server/docs/examples.http.test.js public-server/server/routes/partner-read.http.test.js public-server/server/routes/partner-write.http.test.js` → **24 теста** зелёные (5 новых и 19 тестов 8b — стенд с новыми параметрами работает по-прежнему); с `force-en.mjs` и с `TZ=UTC` (`set TZ=UTC` в cmd) — то же; сторожа А — зелёные (`docs-world.js` — в `test-helpers`, рабочий код его не берёт).
- [ ] **Step 8: коммит** «Документация API: примеры на настоящем сервере — мир клиники-примера «Шифо», запросы примеров по порядку с шагами клиники между ними, ответы записывает node public-server/scripts/docs-build.mjs (server/docs/generated.js, номера заявок и часы — постоянные), переводы подписей — из словаря программы; страж — файл совпадает с ответами сервера, каждая строка таблицы полей воспроизводится своим запросом, границы полей пациента, матрица прав, коды тела, CORS» — шесть файлов.

---

## Task 4: Страница — HTML, доступность, команды со страницы на сервере (API_DOCS_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/docs/render.js`
- Create: `public-server/server/docs/render.test.js`
- Create: `public-server/server/docs/page-curl.http.test.js`

- [ ] **Step 1: падающие тесты** `public-server/server/docs/render.test.js`:

```js
// API_DOCS_V1 — страница документации сама по себе: целая (ничего со стороны,
// без скриптов), доступная (язык, заголовки, якоря, таблицы, фокус), с
// телефона и на печать, без ключей и чисел мимо docs/facts.js; на узбекском и
// английском — ни одного русского слова вне примеров.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDocs, DOCS_PAGE_LANGS, withUnit, listOf } from './render.js';
import { SECTIONS, ENDPOINTS, PAGE, SAMPLE } from './content.js';
import { KEY_RE, SECRET_RE } from '../../../public/js/shared/api-connections.js';

const pages = Object.fromEntries(DOCS_PAGE_LANGS.map((l) => [l, renderDocs({ lang: l })]));
const textOf = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<[^>]+>/g, ' ');

test('единицы и списки: падеж по числу на трёх языках', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 24, 107].map((n) => withUnit(n, 'hour', 'ru')),
    ['1 час', '2 часа', '5 часов', '11 часов', '21 час', '24 часа', '107 часов']);
  assert.deepEqual([withUnit(1, 'min', 'en'), withUnit(30, 'min', 'en'), withUnit(30, 'min', 'uz')], ['1 minute', '30 minutes', '30 daqiqa']);
  assert.equal(listOf([1, 5, 10, 30, 60], 'ru'), '1, 5, 10, 30 и 60');
  assert.equal(listOf([7, 14, 30], 'uz', true), '7, 14 yoki 30');
  assert.equal(listOf([3, 6, 12], 'en', true), '3, 6 or 12');
});

test('целая страница: язык, заголовок, канонический адрес и переводы; ни скриптов, ни файлов со стороны', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.ok(html.startsWith('<!doctype html><html lang="' + lang + '">'), lang);
    assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
    assert.ok(html.includes('<title>' + PAGE.title[lang] + '</title>'));
    assert.ok(html.includes('<link rel="canonical" href="' + SAMPLE.base + (lang === 'ru' ? '/docs' : '/docs/' + lang) + '">'));
    for (const l of DOCS_PAGE_LANGS) assert.ok(html.includes('hreflang="' + l + '"'));
    assert.ok(!/<script|<img|<iframe|<link rel="stylesheet"|@import|url\(/i.test(html), lang + ': что-то грузится со стороны');
    for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      assert.ok(/^(#[a-z0-9-]+|\/docs(\/(uz|en))?|mailto:[^"]+|https:\/\/api\.easymed\.uz\/docs(\/(uz|en))?)$/.test(m[1]), lang + ': ссылка ' + m[1]);
    }
    assert.ok(!html.includes('{{'), lang + ': число без docs/facts.js');
  }
});

test('доступность: один h1, разделы с h2 и якорем, адреса с h3, все якоря есть, таблицы и код — с клавиатуры', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.equal((html.match(/<h1>/g) || []).length, 1);
    assert.ok(html.includes('<a class="skip" href="#main">') && html.includes('<main id="main">'));
    assert.match(html, new RegExp('<a href="/docs' + (lang === 'ru' ? '' : '/' + lang) + '" hreflang="' + lang + '" lang="' + lang + '" aria-current="page">'));
    for (const s of SECTIONS) assert.ok(html.includes('<section id="' + s.id + '" aria-labelledby="' + s.id + '-h"><h2 id="' + s.id + '-h">'), s.id);
    for (const e of ENDPOINTS) assert.ok(html.includes('<h3 id="ep-' + e.id + '-h">'), e.id);
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'id повторяется');
    for (const m of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(m[1]), lang + ': якоря нет — #' + m[1]);
    assert.ok(!/<pre(?! tabindex="0")/.test(html), 'код прокручивается с клавиатуры');
    assert.ok(!/<div class="tw"(?! role="region" tabindex="0" aria-label=")/.test(html), 'таблица прокручивается с клавиатуры');
    assert.ok(!/<th(?=[\s>])(?! scope="col")/.test(html), 'заголовок столбца — scope');
  }
});

test('телефон и печать: колонка сужается до экрана, широкое прокручивается внутри, печать без навигации', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(pages.ru)[1];
  for (const s of ['grid-template-columns:minmax(0,1fr)', '.tw{overflow-x:auto', 'pre{', 'overflow:auto', '@media print{', 'nav.toc,.skip{display:none}',
    '@media (prefers-color-scheme:dark)', 'td code{overflow-wrap:normal}']) assert.ok(css.includes(s), s);
  for (const px of css.match(/font[^;}]*?(\d+(?:\.\d+)?)px/g) || []) {
    assert.ok(/(12\.5|13\.5|15|17|20|24|30)px/.test(px), 'размер не со шкалы: ' + px);
  }
});

test('ни ключа, ни секрета: только переменная $EASYMED_KEY и обрезанные em_live_… / em_whsec_…', () => {
  for (const html of Object.values(pages)) {
    for (const w of html.split(/[\s"'<>`]+/)) assert.ok(!KEY_RE.test(w) && !SECRET_RE.test(w), 'похоже на ключ: ' + w.slice(0, 12));
    assert.ok(!/\bem_(?:live|whsec)_[A-Za-z0-9]{8,}/.test(html));
    assert.ok(html.includes('Bearer ' + SAMPLE.keyVar));
  }
});

test('узбекская и английская страницы: русского текста нет нигде, кроме названия языка в переключателе', () => {
  for (const lang of ['uz', 'en']) {
    const words = textOf(pages[lang]).match(/\S*[А-Яа-яЁё]\S*/g) || [];
    assert.deepEqual([...new Set(words)], ['Русский'], lang);
  }
});
```

`public-server/server/docs/page-curl.http.test.js`:

```js
// API_DOCS_V1 — СТРАЖ «КОМАНДА СО СТРАНИЦЫ ДАЁТ ОТВЕТ СО СТРАНИЦЫ». Из готовой
// страницы /docs (ru, uz, en) достаются блоки примеров: команда curl и ответ
// под ней. Команда разбирается обратно и уходит на настоящий сервер партнёров
// (стенд, случайный порт 127.0.0.1, мир клиники «Шифо»), по порядку страницы, с
// шагами клиники между ними; ответ сервера обязан совпасть с показанным.
import test from 'node:test';
import assert from 'node:assert/strict';
import { docsStand, exampleRequest, sendExample, trimmed, resolve, CLINIC_STEPS } from '../test-helpers/docs-run.js';
import { renderDocs, DOCS_PAGE_LANGS } from './render.js';
import { EXAMPLES, SAMPLE } from './content.js';

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Команда curl страницы → { method, url, headers, body }. */
export function parseCurl(text) {
  const flat = text.replace(/ \\\n\s*/g, ' ');
  const m = /^curl(?: -X ([A-Z]+))? "([^"]+)"/.exec(flat);
  assert.ok(m, 'не команда curl: ' + text.slice(0, 80));
  const d = /-d '([\s\S]*)'$/.exec(flat);
  return { method: m[1] || 'GET', url: m[2], headers: [...flat.matchAll(/-H "([^"]+)"/g)].map((x) => x[1]),
    body: d ? JSON.parse(d[1].replace(/'\\''/g, "'")) : undefined };
}

/** Блоки примеров страницы по порядку: id, команда (или строка «МЕТОД путь»), код и тело ответа. */
function pageExamples(html) {
  return [...html.matchAll(/<div class="ex" data-example="([\w-]+)">([\s\S]*?)<\/div>/g)].map(([, id, inner]) => {
    const pres = [...inner.matchAll(/<pre tabindex="0"><code>([\s\S]*?)<\/code><\/pre>/g)].map((x) => unescape(x[1]));
    const status = /· (\d{3})<\/p>/.exec(inner);
    const line = /<p class="ex-h">[^<]*<code>([A-Z]+) ([^<]+)<\/code><\/p>/.exec(inner);
    const curl = pres[0] && pres[0].startsWith('curl') ? pres[0] : null;
    return { id, curl, line: line ? { method: line[1], path: unescape(line[2]) } : null,
      status: status ? Number(status[1]) : null, body: status ? JSON.parse(pres[pres.length - 1]) : null };
  });
}

const swap = (v, map) => JSON.parse(Object.entries(map).reduce((s, [a, b]) => s.split(a).join(b), JSON.stringify(v)));

test('разбор команды: метод, адрес, заголовки и тело с апострофом', () => {
  const c = parseCurl('curl -X POST "https://x/y" \\\n  -H "A: b" \\\n  -d \'{\n  "n": "O\'\\\'\'g"\n}\'');
  assert.deepEqual(c, { method: 'POST', url: 'https://x/y', headers: ['A: b'], body: { n: "O'g" } });
});

for (const lang of DOCS_PAGE_LANGS) {
  test('страница ' + lang + ': каждая команда curl на настоящем сервере даёт показанный под ней ответ', async (t) => {
    const base = SAMPLE.base;
    const blocks = pageExamples(renderDocs({ lang, base }));
    assert.deepEqual([...new Set(blocks.map((b) => b.id))].sort(), EXAMPLES.map((x) => x.id).sort(), 'каждый пример — на странице');
    const s = await docsStand();
    t.after(s.close);
    const realOf = {};    // номер страницы → настоящий
    const pageOf = {};    // настоящий → номер страницы
    let ran = 0;
    for (const b of blocks) {
      if (b.status === null) continue;   // «Начало работы»: только команда, ответ — в разделе адреса
      const ex = EXAMPLES.find((x) => x.id === b.id);
      if (CLINIC_STEPS[ex.id]) CLINIC_STEPS[ex.id](s, Object.fromEntries(Object.entries(SAMPLE.ids).map(([k, v]) => [k, realOf[v]])));
      let req;
      if (b.curl) {
        const c = parseCurl(b.curl);
        const prefix = base + '/' + SAMPLE.slug + '/v1';
        assert.ok(c.url.startsWith(prefix), c.url);
        assert.ok(c.headers.includes('Authorization: Bearer ' + SAMPLE.keyVar), 'ключ в команде — только переменная');
        if (c.body !== undefined) assert.ok(c.headers.includes('Content-Type: application/json'));
        const want = exampleRequest(ex, lang, SAMPLE.ids);
        assert.deepEqual({ method: c.method, path: c.url.slice(prefix.length), body: c.body }, { method: want.method, path: want.path, body: want.body },
          ex.id + ': команда — запрос примера');
        req = { method: c.method, path: swap(c.url.slice(prefix.length), realOf), body: c.body, wrongKey: false };
      } else {
        assert.ok(b.line, ex.id + ': нет строки запроса');
        req = { method: b.line.method, path: swap(b.line.path, realOf), body: resolve(ex.body, lang, {}), wrongKey: ex.key === 'wrong' };
      }
      const r = await sendExample(s, req);
      if (ex.saveAs && r.body.request_id) { realOf[SAMPLE.ids[ex.saveAs]] = r.body.request_id; pageOf[r.body.request_id] = SAMPLE.ids[ex.saveAs]; }
      assert.equal(r.status, b.status, ex.id + ': код ответа');
      assert.deepEqual(trimmed(swap(r.body, { ...pageOf, [SAMPLE.base]: base }), ex.trim), b.body, ex.id + ': тело ответа');
      ran += 1;
    }
    assert.equal(ran, EXAMPLES.length);
  });
}
```

- [ ] **Step 2:** `node --test public-server/server/docs/render.test.js public-server/server/docs/page-curl.http.test.js` → оба падают при загрузке: `Cannot find module …/docs/render.js`.
- [ ] **Step 3: страница** `public-server/server/docs/render.js`:

```js
// API_DOCS_V1 — СТРАНИЦА ДОКУМЕНТАЦИИ: HTML из текста (docs/content.js), чисел
// (docs/facts.js), словарей кода и записанных ответов сервера
// (docs/generated.js). Одна страница на язык, целиком в одном ответе: стили —
// внутри, ни скриптов, ни шрифтов, ни картинок со стороны (работает без JS и
// без интернета, печатается, читается с телефона). Ни данных клиник, ни ключей,
// ни данных пациентов: клиника — пример «Шифо», ключ — переменная оболочки.
import { SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, curlCommand } from '../../../public/js/shared/api-connections.js';
import { DECLINE_REASONS, webhookBody } from '../../../public/js/shared/api-booking.js';
import { API_GROUPS, PUBLIC_GROUPS } from '../../../public/js/shared/service-public.js';
import { signBody } from '../../../server/services/api/outbox.js';
import { ERRORS } from '../lib/errors.js';
import { PARTNER_STATUSES } from '../store/requests.js';
import { docFacts } from './facts.js';
import { LABELS, RESPONSES } from './generated.js';
import {
  PAGE, SAMPLE, DOCS_CONTACT, SECTIONS, ENDPOINTS, EXAMPLES, STATUS_TEXT, REASON_TEXT, CLOSED_REASONS, EVENT_TEXT, ERROR_TEXT,
  CLINIC_ONLY_ERRORS, FIELD_ERRORS, LIMIT_ROWS, TABLE_HEAD, KIND_TEXT, WEBHOOK_EXAMPLE, VERIFY_NODE, VERIFY_PHP,
} from './content.js';

export const DOCS_PAGE_LANGS = Object.freeze(['ru', 'uz', 'en']);
const DOCS_PATH = { ru: '/docs', uz: '/docs/uz', en: '/docs/en' };

const UNITS = {
  sec: { ru: ['секунда', 'секунды', 'секунд'], uz: 'soniya', en: ['second', 'seconds'] },
  min: { ru: ['минута', 'минуты', 'минут'], uz: 'daqiqa', en: ['minute', 'minutes'] },
  hour: { ru: ['час', 'часа', 'часов'], uz: 'soat', en: ['hour', 'hours'] },
  day: { ru: ['день', 'дня', 'дней'], uz: 'kun', en: ['day', 'days'] },
  time: { ru: ['раз', 'раза', 'раз'], uz: 'marta', en: ['time', 'times'] },
  attempt: { ru: ['попытка', 'попытки', 'попыток'], uz: 'urinish', en: ['attempt', 'attempts'] },
};
const AND = { ru: ['и', 'или'], uz: ['va', 'yoki'], en: ['and', 'or'] };

/** Число с единицей: 24 часа, 1 минута, 5 urinish, 2 times. */
export function withUnit(n, unit, lang) {
  const u = UNITS[unit];
  if (!u) throw new Error('docs: нет единицы ' + unit);
  if (lang === 'uz') return n + ' ' + u.uz;
  if (lang === 'en') return n + ' ' + u.en[n === 1 ? 0 : 1];
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return n + ' ' + u.ru[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
}
/** Список: «1, 5, 10, 30 и 60» / «3, 6 или 12». */
export function listOf(arr, lang, or = false) {
  const word = AND[lang][or ? 1 : 0];
  return arr.length < 2 ? arr.join('') : arr.slice(0, -1).join(', ') + ' ' + word + ' ' + arr[arr.length - 1];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderDocs({ lang = 'ru', base = SAMPLE.base, uncollectedMaxMs } = {}) {
  if (!DOCS_PAGE_LANGS.includes(lang)) throw new Error('docs: нет языка ' + lang);
  const facts = { ...docFacts({ base, ...(uncollectedMaxMs ? { uncollectedMaxMs } : {}) }), contact: DOCS_CONTACT, secret: WEBHOOK_EXAMPLE.secret };
  const fill = (s) => String(s).replace(/\{\{([a-zA-Z]+)(?::([a-z]+))?(\|or)?\}\}/g, (m, k, unit, or) => {
    if (!(k in facts)) throw new Error('docs: нет числа ' + k);
    const v = facts[k];
    if (Array.isArray(v)) return listOf(v, lang, !!or);
    return unit ? withUnit(v, unit, lang) : String(v);
  });
  const t = (l) => fill(l[lang]);
  // Текст: `код`, [ссылка](#якорь | mailto:…); всё прочее экранируется.
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((#[a-z0-9-]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  const ti = (l) => inline(t(l));
  const label = (ru) => (lang === 'ru' ? ru : (LABELS[ru] && LABELS[ru][lang]) || ru);
  const code = (s) => '<code>' + esc(s) + '</code>';
  const pre = (s) => '<pre tabindex="0"><code>' + esc(s) + '</code></pre>';
  const table = (head, rows, name) => '<div class="tw" role="region" tabindex="0" aria-label="' + esc(name) + '"><table>'
    + '<thead><tr>' + head.map((h) => '<th scope="col">' + ti(h) + '</th>').join('') + '</tr></thead><tbody>'
    + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  const epOf = (id) => ENDPOINTS.find((e) => e.id === id);
  // В таблицах путь переносится только после «/».
  const epName = (e) => '<code>' + esc(e.method + ' ' + e.path).split('/').join('/<wbr>') + '</code>';
  const epLink = (e) => '<a href="#ep-' + e.id + '">' + epName(e) + '</a>';
  const toPage = (json) => JSON.stringify(json, null, 2).split(SAMPLE.base).join(base);
  const url = (p) => base + '/' + SAMPLE.slug + '/v1' + p;
  const resolve = (v) => {
    if (typeof v === 'string') return v.replace(/\{([a-z]+)\}/g, (m, k) => (k === 'lang' ? lang : SAMPLE.ids[k] || m));
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object' && Object.keys(v).join() === 'ru,uz,en') return v[lang];
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    return v;
  };

  function example(id, { response = true } = {}) {
    const ex = EXAMPLES.find((x) => x.id === id);
    const r = RESPONSES[lang] && RESPONSES[lang][id];
    if (!ex || !r) throw new Error('docs: нет примера ' + id);
    const path = resolve(ex.path);
    const head = ex.title ? ti(ex.title) + ' — ' : '';
    let out = '<div class="ex" data-example="' + ex.id + '">';
    if (ex.curl === false) out += '<p class="ex-h">' + head + code(ex.method + ' ' + path) + '</p>';
    else {
      out += '<p class="ex-h">' + head + esc(t(PAGE.request)) + '</p>'
        + pre(curlCommand({ method: ex.method, url: url(path), key: SAMPLE.keyVar, body: ex.body === undefined ? undefined : resolve(ex.body) }));
    }
    if (response) {
      out += '<p class="ex-h">' + esc(t(PAGE.response)) + ' · ' + r.status + '</p>' + pre(toPage(r.body));
      if (ex.trim) out += '<p class="note">' + ti(PAGE.trimmed) + '</p>';
    }
    return out + '</div>';
  }

  function endpoint(id) {
    const e = epOf(id);
    const access = e.scopes === null ? esc(t(PAGE.noKey)) : !e.scopes.length ? esc(t(PAGE.anyKey))
      : e.scopes.map((s) => code(s) + ' — ' + esc(label(SCOPE_INFO[s].label))).join(' ' + esc(t(PAGE.orWord)) + ' ');
    const m = e.method.toLowerCase();
    let out = '<section class="ep" id="ep-' + e.id + '" aria-labelledby="ep-' + e.id + '-h">'
      + '<h3 id="ep-' + e.id + '-h"><span class="m m-' + m + '">' + e.method + '</span> ' + code(e.path) + '</h3>'
      + '<p class="meta">' + esc(t(PAGE.scope)) + ': ' + access + '</p><p>' + ti(e.summary) + '</p>';
    if (e.params && e.params.length) {
      out += table(PAGE.paramHead, e.params.map((p) => [code(p.name), esc(t(PAGE.where[p.in])), esc(t(p.req ? PAGE.yes : PAGE.no)), ti(p.value)]),
        t(PAGE.params) + ' ' + e.method + ' ' + e.path);
    }
    if (e.notes) out += '<ul class="notes">' + e.notes.map((n) => '<li>' + ti(n) + '</li>').join('') + '</ul>';
    if (e.table) out += generated(e.table);
    for (const x of e.examples) out += example(x);
    return out + '</section>';
  }

  function generated(name) {
    const head = TABLE_HEAD[name];
    const title = t(head[0]);
    if (name === 'scopes') {
      return table(head, SCOPES.map((s) => [code(s), esc(label(SCOPE_INFO[s].label)), esc(label(SCOPE_INFO[s].desc)),
        ENDPOINTS.filter((e) => e.scopes && e.scopes.includes(s)).map(epLink).join('<br>')]), title);
    }
    if (name === 'groups') return table(head, API_GROUPS.map((g) => [code(g), esc(label(PUBLIC_GROUPS.find((x) => x.api === g).label))]), title);
    if (name === 'statuses') {
      return table(head, PARTNER_STATUSES.map((s) => [code(s), esc(t(KIND_TEXT[STATUS_TEXT[s].kind])), ti(STATUS_TEXT[s].text)]), title);
    }
    if (name === 'reasons') {
      return table(head, [...DECLINE_REASONS, ...CLOSED_REASONS].map((r) => [code(r), code(REASON_TEXT[r].status), ti(REASON_TEXT[r].text)]), title);
    }
    if (name === 'events') {
      return table(head, EVENTS.map((ev) => [code(ev), '<strong>' + esc(label(EVENT_INFO[ev].label)) + '</strong><br>' + esc(label(EVENT_INFO[ev].desc)),
        EVENT_TEXT[ev].statuses.map(code).join(', '), EVENT_TEXT[ev].fields.map(code).join(', ') || '—']), title);
    }
    if (name === 'errors') {
      return table(head, Object.keys(ERRORS).filter((c) => !CLINIC_ONLY_ERRORS.includes(c))
        .map((c) => [String(ERRORS[c].status), code(c), esc(ERRORS[c][lang]), ti(ERROR_TEXT[c])]), title);
    }
    if (name === 'fields') {
      return table(head, FIELD_ERRORS.map((f) => [code(f.field), f.reason ? code(f.reason) : code('404 ' + f.code),
        Object.keys(f.probes).map((id) => epLink(epOf(id))).join('<br>'), ti(f.text)]), title);
    }
    if (name === 'limits') return table(head, LIMIT_ROWS.map(([a, b]) => [ti(a), ti(b)]), title);
    throw new Error('docs: нет таблицы ' + name);
  }

  function webhook() {
    const raw = JSON.stringify(webhookBody(WEBHOOK_EXAMPLE));
    const lines = ['POST ' + WEBHOOK_EXAMPLE.url, 'Content-Type: application/json', 'User-Agent: ' + facts.userAgent,
      'X-EasyMed-Event: ' + WEBHOOK_EXAMPLE.event, 'X-EasyMed-Event-Id: ' + WEBHOOK_EXAMPLE.eventId,
      'X-EasyMed-Signature: ' + signBody(WEBHOOK_EXAMPLE.secret, raw), '', raw];
    return '<div class="ex"><p class="ex-h">' + esc(t(PAGE.hookRequest)) + '</p>' + pre(lines.join('\n')) + '<p class="note">' + ti(PAGE.vector) + '</p></div>';
  }

  function block(b) {
    if (b.p) return '<p>' + ti(b.p) + '</p>';
    if (b.list) return '<ul>' + b.list.map((x) => '<li>' + ti(x) + '</li>').join('') + '</ul>';
    if (b.kv) return '<dl class="kv">' + b.kv.map(([k, v]) => '<dt>' + ti(k) + '</dt><dd>' + ti(v) + '</dd>').join('') + '</dl>';
    if (b.code) return pre(t(b.code));
    if (b.table) return generated(b.table);
    if (b.endpoint) return endpoint(b.endpoint);
    if (b.example) return example(b.example, { response: b.response !== false });
    if (b.webhook) return webhook();
    if (b.verify) return '<p class="ex-h">' + (b.verify === 'node' ? 'Node.js' : 'PHP') + '</p>' + pre(b.verify === 'node' ? VERIFY_NODE : VERIFY_PHP);
    throw new Error('docs: неизвестный блок ' + Object.keys(b).join());
  }

  const langNav = DOCS_PAGE_LANGS.map((l) => '<li><a href="' + DOCS_PATH[l] + '" hreflang="' + l + '" lang="' + l + '"'
    + (l === lang ? ' aria-current="page"' : '') + '>' + esc(PAGE.langName[l]) + '</a></li>').join('');
  const alternates = DOCS_PAGE_LANGS.map((l) => '<link rel="alternate" hreflang="' + l + '" href="' + esc(base + DOCS_PATH[l]) + '">').join('');
  const toc = SECTIONS.map((s) => '<li><a href="#' + s.id + '">' + esc(t(s.title)) + '</a></li>').join('');
  const body = SECTIONS.map((s) => '<section id="' + s.id + '" aria-labelledby="' + s.id + '-h"><h2 id="' + s.id + '-h">' + esc(t(s.title)) + '</h2>'
    + s.blocks.map(block).join('') + '</section>').join('');
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">'
    + '<title>' + esc(t(PAGE.title)) + '</title><meta name="description" content="' + esc(t(PAGE.description)) + '">'
    + '<link rel="canonical" href="' + esc(base + DOCS_PATH[lang]) + '">' + alternates + '<style>' + CSS + '</style></head><body>'
    + '<a class="skip" href="#main">' + esc(t(PAGE.skip)) + '</a>'
    + '<header class="top"><span class="brand">Easy-Med API v1</span><nav class="langs" aria-label="' + esc(t(PAGE.langs)) + '"><ul>' + langNav + '</ul></nav></header>'
    + '<div class="wrap"><nav class="toc" aria-label="' + esc(t(PAGE.toc)) + '"><p class="toc-h">' + esc(t(PAGE.toc)) + '</p><ol>' + toc + '</ol></nav>'
    + '<main id="main"><h1>' + esc(t(PAGE.title)) + '</h1><p class="lead">' + ti(PAGE.lead) + '</p>' + body + '</main></div>'
    + '<footer><p>' + ti(PAGE.footer) + '</p></footer></body></html>\n';
}

// Шкала размеров программы (12.5 / 13.5 / 15 / 17 / 20 / 24 / 30); цвета — с
// контрастом не ниже 4.5:1 в светлой и тёмной теме.
const CSS = [
  ':root{--bg:#ffffff;--fg:#1b2230;--muted:#4f586a;--line:#d5dbe5;--soft:#f2f5f9;--accent:#0a58a8;--code-bg:#111821;--code-fg:#e8edf3;--get:#0a6a39;--post:#0a58a8;--delete:#a3242a}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0e131a;--fg:#e5e9f0;--muted:#a9b2c1;--line:#2b3442;--soft:#171f2a;--accent:#7ab8ff;--code-bg:#080c11;--code-fg:#e8edf3;--get:#6ad596;--post:#7ab8ff;--delete:#ff9196}}',
  '*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}',
  'a{color:var(--accent)}a:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
  '.skip{position:absolute;left:-9999px;top:8px;background:var(--bg);color:var(--fg);padding:8px 12px;z-index:10}.skip:focus{left:8px}',
  'header.top{border-bottom:1px solid var(--line);padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}',
  '.brand{font-weight:700;font-size:17px}.langs ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}',
  '.langs a{display:inline-block;padding:6px 12px;min-height:36px;border:1px solid var(--line);border-radius:8px;text-decoration:none}',
  '.langs a[aria-current]{background:var(--accent);border-color:var(--accent);color:var(--bg)}',
  '.wrap{max-width:1180px;margin:0 auto;padding:0 16px 40px;display:grid;gap:32px;grid-template-columns:minmax(0,1fr)}',
  '@media (min-width:960px){.wrap{grid-template-columns:220px minmax(0,1fr)}nav.toc{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto}}',
  '.toc-h{font-weight:700;margin:16px 0 4px}nav.toc ol{padding-left:20px;margin:0}nav.toc li{margin:4px 0}main{min-width:0}',
  'h1{font-size:30px;line-height:1.25;margin:24px 0 8px}h2{font-size:24px;line-height:1.3;margin:40px 0 12px;padding-top:16px;border-top:1px solid var(--line)}',
  'h3{font-size:17px;margin:4px 0 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}.lead{font-size:17px;color:var(--muted)}',
  'code{font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}',
  'pre{background:var(--code-bg);color:var(--code-fg);padding:12px 14px;border-radius:8px;overflow:auto;margin:6px 0 16px;max-height:560px}',
  'pre code{background:none;padding:0;color:inherit;white-space:pre;overflow-wrap:normal}',
  '.m{font:700 12.5px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:5px 8px;border-radius:6px;border:1px solid currentColor}',
  '.m-get{color:var(--get)}.m-post{color:var(--post)}.m-delete{color:var(--delete)}',
  '.ep{border:1px solid var(--line);border-radius:10px;padding:16px;margin:20px 0}.meta,.note{color:var(--muted);font-size:13.5px}.meta{margin:0 0 8px}',
  '.ex-h{font-size:13.5px;font-weight:600;color:var(--muted);margin:16px 0 0}',
  '.tw{overflow-x:auto;margin:8px 0 16px;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:13.5px}',
  'th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{background:var(--soft);font-weight:600}tbody tr:last-child td{border-bottom:0}td code{overflow-wrap:normal}',
  'dl.kv{display:grid;grid-template-columns:minmax(0,1fr);gap:2px 16px}@media (min-width:640px){dl.kv{grid-template-columns:150px minmax(0,1fr)}}',
  'dl.kv dt{font-weight:600}dl.kv dd{margin:0 0 10px}',
  'footer{border-top:1px solid var(--line);padding:16px;color:var(--muted);font-size:13.5px;max-width:1180px;margin:0 auto}',
  '@media print{.langs,nav.toc,.skip{display:none}.wrap{display:block}body{font-size:12.5px;background:#fff;color:#000}',
  'pre{white-space:pre-wrap;max-height:none;border:1px solid #888;background:#fff;color:#000}pre code{white-space:pre-wrap;word-break:break-all}',
  'h2,h3{break-after:avoid}.ep,pre,table{break-inside:avoid}a[href^="http"]::after{content:" (" attr(href) ")"}}',
].join('');
```

- [ ] **Step 4:** `node --test public-server/server/docs/render.test.js public-server/server/docs/page-curl.http.test.js` → **10 тестов** (после полировки таблиц и ревью шага 9 — **12**) зелёные (и с `force-en.mjs`); сторожа А — зелёные.
- [ ] **Step 5: посмотреть глазами** — сохранить три страницы и открыть в браузере (Chrome, Edge):
  - `node --input-type=module -e "import { renderDocs } from './public-server/server/docs/render.js'; import fs from 'node:fs'; for (const l of ['ru','uz','en']) fs.writeFileSync(process.env.TEMP + '/easymed-docs-' + l + '.html', renderDocs({ lang: l }));"` — из корня клона;
  - ширина 1280 и 390 (инструменты разработчика, режим телефона), светлая и тёмная тема, «Печать» → предпросмотр: ничего не вылезает по ширине, таблицы прокручиваются внутри рамки, код — тоже;
  - файлы после просмотра удалить (`%TEMP%\easymed-docs-*.html`).
- [ ] **Step 6: коммит** «Документация API: страница — HTML из текста, чисел и словарей кода и записанных ответов сервера, на ru / uz / en; без скриптов и файлов со стороны, с телефона и на печать, тёмная тема; страж — каждая команда curl со страницы на настоящем сервере даёт показанный под ней ответ, ключей нет, на uz и en нет русского» — три файла.

---

## Task 5: Адрес `/docs` в приложении, срок из настроек службы, nginx (API_DOCS_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/routes/docs.js`
- Create: `public-server/server/routes/docs.http.test.js`
- Modify: `public-server/server/app.js`, `public-server/server/index.js`, `public-server/DEPLOY.md`

- [ ] **Step 1: падающий тест** `public-server/server/routes/docs.http.test.js`:

```js
// API_DOCS_V1 — /docs в приложении публичного сервера: страница без ключа на
// трёх языках, свои заголовки кэша и защиты, перенаправления на один адрес,
// адрес сервера и срок не забранной заявки — из настроек службы; адреса
// клиник и служебные адреса не задеты.
import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createPublicServer } from '../app.js';
import { testDb, testVendor, NOW } from '../test-helpers/fixture.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { DOCS_CSP, DOCS_CACHE_SECONDS } from './docs.js';
import { API_DOCS_URL, apiDocsUrl } from '../../../public/js/shared/api-connections.js';

async function up(over = {}) {
  const { db, dir } = testDb();
  const { app } = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: testVendor().publicKey, requireHttps: true, trustProxy: false,
    version: '0.1.0', log: { warn() {}, error() {} }, ...over });
  const server = await listen(app);
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}
const get = (s, p, headers = {}) => fetch(s.base + p, { headers, redirect: 'manual' });
// fetch с If-None-Match сам добавляет Cache-Control: no-cache (спецификация fetch) — проверка ETag идёт через node:http.
const status = (url, headers) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

test('/docs, /docs/uz, /docs/en — страница без ключа, даже по http за прокси; свои заголовки; HEAD и ETag', async (t) => {
  const s = await up();
  t.after(s.close);
  for (const [p, lang] of [['/docs', 'ru'], ['/docs/', 'ru'], ['/docs/uz', 'uz'], ['/docs/en', 'en']]) {
    const r = await get(s, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=' + DOCS_CACHE_SECONDS);
    assert.equal(r.headers.get('content-security-policy'), DOCS_CSP);
    assert.equal(r.headers.get('content-language'), lang);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.ok((await r.text()).startsWith('<!doctype html><html lang="' + lang + '">'), p);
  }
  const head = await fetch(s.base + '/docs/en', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const etag = (await get(s, '/docs')).headers.get('etag');
  assert.ok(etag);
  assert.equal(await status(s.base + '/docs', { 'If-None-Match': etag }), 304, 'та же страница — 304');
});

test('один адрес на страницу: /docs/ru и ?lang — перенаправление; чужой язык — 404', async (t) => {
  const s = await up();
  t.after(s.close);
  for (const [p, to] of [['/docs/ru', '/docs'], ['/docs?lang=uz', '/docs/uz'], ['/docs?lang=EN', '/docs/en'], ['/docs?lang=ru', '/docs']]) {
    const r = await get(s, p);
    assert.deepEqual([r.status, r.headers.get('location')], [301, to], p);
  }
  assert.equal((await get(s, '/docs?lang=de')).status, 200, 'незнакомый ?lang — русская страница');
  const de = await get(s, '/docs/de');
  assert.deepEqual([de.status, (await de.json()).error.code], [404, 'not_found']);
});

test('адрес сервера и срок не забранной заявки — из настроек службы; ссылка программы клиники ведёт сюда', async (t) => {
  const s = await up({ baseUrl: 'https://api.staging.example', uncollectedMaxMs: 48 * 3600000 });
  t.after(s.close);
  const html = await (await get(s, '/docs')).text();
  assert.ok(html.includes('https://api.staging.example/shifo/v1/clinic?lang=ru'), 'команды — на адрес этого сервера');
  assert.ok(html.includes('https://api.staging.example/shifo/v1/media/'), 'ссылки в ответах — на адрес этого сервера');
  assert.ok(!html.includes('https://api.easymed.uz'), 'чужого адреса нет');
  assert.ok(html.includes('48 часов'), 'срок — PUBLIC_UNCOLLECTED_MAX_HOURS');
  assert.ok(!html.includes('24 часа'));
  assert.equal(new URL(API_DOCS_URL).pathname, '/docs');
  for (const l of ['uz', 'en']) assert.equal((await get(s, new URL(apiDocsUrl(l)).pathname)).status, 200);
});

test('адреса клиник и служебные не задеты: /docs/v1/… — клиники «docs» нет; /_health; неизвестное — 404 JSON без кэша', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = await get(s, '/docs/v1/clinic');
  assert.deepEqual([c.status, (await c.json()).error.code], [404, 'clinic_not_found']);
  assert.equal((await get(s, '/_health')).status, 200);
  const x = await get(s, '/docsx');
  assert.deepEqual([x.status, x.headers.get('cache-control')], [404, 'no-store']);
});
```

- [ ] **Step 2:** `node --test public-server/server/routes/docs.http.test.js` → падает при загрузке: `Cannot find module …/routes/docs.js`.
- [ ] **Step 3: адреса страницы** `public-server/server/routes/docs.js`:

```js
// API_DOCS_V1 — ДОКУМЕНТАЦИЯ ДЛЯ ПАРТНЁРОВ: https://api.easymed.uz/docs
// (решение владельца 21, 2026-10-12). Одна страница на все клиники, всегда по
// коду этого сервера (docs/render.js). Без ключа, без данных клиник.
//
//   /docs            — по-русски (язык разработчиков в Узбекистане и язык
//                      ошибок API по умолчанию — одна ссылка, которую все шлют);
//   /docs/uz, /docs/en — узбекская и английская;
//   /docs/ru, /docs?lang=uz|en — перенаправление на свой адрес (у каждой
//                      страницы один адрес; ?lang — как у адресов API).
// Имя клиники «docs» занято (shared/api-connections.js RESERVED_SLUGS), так что с
// адресами клиник /<клиника>/v1/ страница не пересекается.
//
// Страница строится при первом запросе языка (~2 мс) и держится в памяти
// процесса (80–90 КБ на язык); кэш браузера — 5 минут с проверкой по ETag:
// после выпуска новая страница видна не позже чем через 5 минут. Ошибка
// построения — 500 только у этого адреса, служба запускается и без страницы.
import express from 'express';
import { renderDocs, DOCS_PAGE_LANGS } from '../docs/render.js';

export const DOCS_CACHE_SECONDS = 300;
export const DOCS_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @param ctx {{baseUrl:string, uncollectedMaxMs?:number}} */
export function docsRouter(ctx) {
  const r = express.Router();
  const pages = new Map();
  const page = (lang) => {
    if (!pages.has(lang)) pages.set(lang, renderDocs({ lang, base: ctx.baseUrl, uncollectedMaxMs: ctx.uncollectedMaxMs }));
    return pages.get(lang);
  };
  const send = (req, res, lang) => {
    const html = page(lang);
    res.set('Cache-Control', 'public, max-age=' + DOCS_CACHE_SECONDS);
    res.set('Content-Security-Policy', DOCS_CSP);
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Language', lang);
    res.type('html').send(html);
  };
  const other = (l) => DOCS_PAGE_LANGS.includes(l) && l !== 'ru';
  r.get('/docs', (req, res) => {
    const q = String(req.query.lang || '').toLowerCase();
    if (other(q)) return res.redirect(301, '/docs/' + q);
    if (q === 'ru') return res.redirect(301, '/docs');
    return send(req, res, 'ru');
  });
  r.get('/docs/:lang', (req, res, next) => {
    const l = String(req.params.lang || '');
    if (l === 'ru') return res.redirect(301, '/docs');
    if (!other(l)) return next();
    return send(req, res, l);
  });
  return r;
}
```

- [ ] **Step 4: подключить** — diff к `app.js` и `index.js`:

```diff
diff --git a/public-server/server/app.js b/public-server/server/app.js
--- a/public-server/server/app.js
+++ b/public-server/server/app.js
@@ -2,6 +2,7 @@
 //
 //   /_health, /_metrics     — наблюдение (routes/ops.js);
 //   /_sync/v1/*             — канал клиники (routes/sync.js; дизайн §10);
+//   /docs, /docs/uz, /docs/en — документация для партнёров (routes/docs.js; API_DOCS_V1);
 //   /<клиника>/v1/*         — партнёры (routes/partner.js; макет «Документация API»).
 // Имя клиники не может начинаться с «_» (shared/api-connections.js slugProblem),
 // поэтому служебные адреса с ним не пересекаются.
@@ -13,21 +14,23 @@ import express from 'express';
 import { syncRouter } from './routes/sync.js';
 import { partnerRouter } from './routes/partner.js';
 import { opsRouter } from './routes/ops.js';
+import { docsRouter } from './routes/docs.js';
 import { createLimiter } from './lib/rate-limit.js';
 import { errorHandler, sendError } from './lib/errors.js';
 import { DEFAULT_SKEW_MS } from './clinic-auth.js';
-import { floorInboxCursor } from './store/requests.js';
+import { floorInboxCursor, UNCOLLECTED_MAX_MS } from './store/requests.js';
 
 /**
  * @param {{db, dataDir:string, now?:()=>number, licencePublicKey?:object|null, offsetMin?:number, baseUrl?:string,
  *   requireHttps?:boolean, trustProxy?:(string|boolean), skewMs?:number, metricsToken?:string, version?:string,
- *   limiter?:object, log?:Console}} o
+ *   limiter?:object, log?:Console, uncollectedMaxMs?:number}} o
  * @returns {{app:import('express').Express, ctx:object}}
  */
 export function createPublicServer({ db, dataDir, now = () => Date.now(), licencePublicKey = null, offsetMin = 300,
   baseUrl = 'https://api.easymed.uz', requireHttps = true, trustProxy = 'loopback', skewMs = DEFAULT_SKEW_MS, metricsToken = '',
-  version = '0.0.0', limiter = createLimiter(), log = console }) {
-  const ctx = { db, dataDir, now, licencePublicKey, offsetMin, baseUrl, requireHttps, skewMs, metricsToken, version, limiter, jobs: null };
+  version = '0.0.0', limiter = createLimiter(), log = console, uncollectedMaxMs = UNCOLLECTED_MAX_MS }) {
+  // uncollectedMaxMs — срок не забранной заявки из настроек: документация называет его (API_DOCS_V1).
+  const ctx = { db, dataDir, now, licencePublicKey, offsetMin, baseUrl, requireHttps, skewMs, metricsToken, version, limiter, uncollectedMaxMs, jobs: null };
   // Курсоры очереди не идут назад после восстановления базы (ревью 8b, C3).
   floorInboxCursor(db, now());
   const app = express();
@@ -39,6 +42,7 @@ export function createPublicServer({ db, dataDir, now = () => Date.now(), licenc
     next();
   });
   app.use(opsRouter(ctx));
+  app.use(docsRouter(ctx));
   app.use('/_sync/v1', syncRouter(ctx));
   app.use('/:slug/v1', partnerRouter(ctx));
   app.use((req, res) => sendError(req, res, 'not_found'));
```

```diff
diff --git a/public-server/server/index.js b/public-server/server/index.js
--- a/public-server/server/index.js
+++ b/public-server/server/index.js
@@ -35,7 +35,7 @@ const db = openDb(path.join(cfg.dataDir, 'public.db'));
 migrate(db);
 const { app, ctx } = createPublicServer({
   db, dataDir: cfg.dataDir, licencePublicKey, offsetMin: cfg.offsetMin, baseUrl: cfg.baseUrl, requireHttps: cfg.requireHttps,
-  trustProxy: cfg.trustProxy, skewMs: cfg.syncSkewMs, metricsToken: cfg.metricsToken, version,
+  trustProxy: cfg.trustProxy, skewMs: cfg.syncSkewMs, metricsToken: cfg.metricsToken, version, uncollectedMaxMs: cfg.uncollectedMaxMs,
 });
 const jobs = startJobs({ db, dataDir: cfg.dataDir, send: makeSender({ selfIps: cfg.selfIps }), webhooks: cfg.webhooks, limiter: ctx.limiter,
   uncollectedMaxMs: cfg.uncollectedMaxMs });
```

- [ ] **Step 5: установка** — diff к `DEPLOY.md`:

````diff
diff --git a/public-server/DEPLOY.md b/public-server/DEPLOY.md
--- a/public-server/DEPLOY.md
+++ b/public-server/DEPLOY.md
@@ -145,7 +145,12 @@ server {
     proxy_send_timeout 25s;
   }
 }
-server { listen 80; server_name api.easymed.uz; return 444; }   # http не принимаем: ключ уже ушёл бы открытым
+server {
+  listen 80;
+  server_name api.easymed.uz;
+  location ~ ^/docs(/(uz|en))?/?$ { return 301 https://$host$request_uri; }   # документация — открытая страница: http ведёт на https
+  location / { return 444; }            # остальное по http не принимаем: ключ уже ушёл бы открытым
+}
 ```
 
 ## Проверка после установки
@@ -153,6 +158,8 @@ server { listen 80; server_name api.easymed.uz; return 444; }   # http не пр
 ```bash
 sudo systemctl daemon-reload && sudo systemctl enable --now easymed-public
 curl -s https://api.easymed.uz/_health                     # {"status":"ok",...}
+curl -sI https://api.easymed.uz/docs | head -1             # HTTP/2 200 — документация для партнёров (API_DOCS_V1)
+curl -sI http://api.easymed.uz/docs | grep -i ^location    # location: https://api.easymed.uz/docs
 systemctl show easymed-public -p MemoryCurrent -p MemoryMax
 journalctl -u easymed-public --since "10 min ago"          # тел запросов и данных пациентов здесь нет
 ```
````

- [ ] **Step 6:** `node --check public-server/server/index.js` → без вывода; `node --test public-server/server/routes/docs.http.test.js public-server/server/app.test.js public-server/server/e2e.clinic.test.js` → **11 тестов** зелёные (4 новых; приложение — 5 и сквозной прогон 8b — 2, как прежде; на `e8f4ead3` сквозной прогон был одним тестом — 10); с `force-en.mjs` — то же; сторожа А — зелёные.
- [ ] **Step 7: все тесты службы** — из корня клона (bash): `node --test $(git ls-files -co --exclude-standard public-server | grep '\.test\.js$')` → **161 тест** в 28 файлах (132 теста 8b + 29 новых; на `e8f4ead3` — 160; после полировки таблиц и ревью шага 9 — **165**), зелёные и с `force-en.mjs`.
- [ ] **Step 8: коммит** «Документация API: адрес https://api.easymed.uz/docs на публичном сервере — русская по умолчанию, /docs/uz и /docs/en, один адрес на страницу (/docs/ru и ?lang — 301), без ключа, кэш 5 минут с ETag, CSP без скриптов; адрес сервера и срок не забранной заявки — из настроек службы; nginx: http /docs ведёт на https» — пять файлов.

---

## Task 6: «Скопировать всё» и окно «Что передать» — ссылка на документацию и команда проверки ключа (API_DOCS_V1)

Сборщик Б. Нужна задача 1.

**Files:**
- Modify: `public/js/admin/views/api-ui.js` — `docsLink(variant)`.
- Modify: `public/js/admin/views/api-connection-new.js` — `probePath`, строки «Документация» и «Проверить ключ», ссылка в окне.
- Modify: `public/js/admin/i18n-strings.js` — блок `API_DOCS_V1`.
- Modify: `public/js/admin/__tests__/api-connection-new.test.mjs`

- [ ] **Step 1: падающие тесты** — diff к `api-connection-new.test.mjs`:

```diff
diff --git a/public/js/admin/__tests__/api-connection-new.test.mjs b/public/js/admin/__tests__/api-connection-new.test.mjs
--- a/public/js/admin/__tests__/api-connection-new.test.mjs
+++ b/public/js/admin/__tests__/api-connection-new.test.mjs
@@ -6,7 +6,7 @@ import assert from 'node:assert';
 import { reset, onRpc, calls, clip, textOf, byAttr, buttonByText, tick, modal, rpcNames, settingsFixture,
   KEY_VALUE, SECRET_VALUE } from './api-harness.mjs';
 
-const { openNewConnection, handoverText } = await import('../views/api-connection-new.js');
+const { openNewConnection, handoverText, openHandover, probePath } = await import('../views/api-connection-new.js');
 const KEY2 = 'em_live_TESTONLYtestonlyTESTONLYtest2222';
 
 function draftServer() {
@@ -118,3 +118,34 @@ test('создание включённого: филиал на сайте бе
   buttonByText(m, /Открыть «Филиалы»/).click();
   assert.deepEqual(nav, [['settings', { section: 'branches' }]]);
 });
+
+// API_DOCS_V1 — решение владельца 21: в «Скопировать всё» — ссылка на публичную
+// документацию и команда проверки ключа. В команде — подстановка «<ключ>», сам
+// ключ — только своей строкой «Ключ: …», как в шаге 7.
+test('API_DOCS_V1: «Скопировать всё» — ссылка на документацию и команда проверки; в команде — <ключ>, не ключ', () => {
+  const base = { clinic: 'Клиника Демо', baseUrl: 'https://api.easymed.uz/klinika-demo/v1/', key: KEY_VALUE, secret: '' };
+  const lines = handoverText({ ...base, scopes: ['doctors', 'slots', 'appointments'] }).split('\n');
+  assert.ok(lines.includes('Документация: https://api.easymed.uz/docs'));
+  const cmd = lines.filter((l) => l.startsWith('Проверить ключ'));
+  assert.deepEqual(cmd, ['Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): curl "https://api.easymed.uz/klinika-demo/v1/doctors" -H "Authorization: Bearer <ключ>"']);
+  assert.ok(lines.includes('Ключ: ' + KEY_VALUE), 'ключ — своей строкой');
+  assert.equal(lines.filter((l) => l.includes(KEY_VALUE)).length, 1, 'ключ — только в строке «Ключ»');
+  assert.ok(handoverText({ ...base, scopes: ['requests'] }).includes('/klinika-demo/v1/reference/specialties"'), 'без права чтения — справочник: он открыт любому ключу');
+  assert.ok(handoverText({ ...base, scopes: ['clinic', 'doctors'] }).includes('/klinika-demo/v1/clinic"'));
+  assert.equal(probePath(['packages', 'branches']), 'branches', 'порядок — как права на экране');
+  assert.ok(handoverText({ ...base, baseUrl: 'https://api.easymed.uz/klinika-demo/v1', scopes: ['clinic'] }).includes('/v1/clinic"'), 'адрес без «/» в конце');
+});
+
+test('API_DOCS_V1: окно «Что передать» — «Документация для партнёров» открывает публичную страницу в новой вкладке', () => {
+  reset();
+  const fx = settingsFixture();
+  openHandover({ settings: fx, connection: fx.connections[1], key: KEY_VALUE, baseUrl: fx.base_url });
+  const m = modal('conn-key');
+  const a = byAttr(m, 'data-apic-act', 'docs');
+  assert.equal(a.length, 1);
+  assert.deepEqual([a[0].tagName, a[0].attrs.href, a[0].attrs.target, a[0].attrs.rel, a[0].attrs.title],
+    ['A', 'https://api.easymed.uz/docs', '_blank', 'noopener noreferrer', 'Откроется в новой вкладке']);
+  assert.ok(textOf(a[0]).includes('Документация для партнёров'));
+  const text = byAttr(m, 'aria-label', 'Текст для отправки')[0].value;
+  assert.ok(text.includes('Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): curl "https://api.easymed.uz/klinika-demo/v1/clinic" -H "Authorization: Bearer <ключ>"'));
+});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/api-connection-new.test.mjs` → 6 прежних зелёные, 2 новых красные: в тексте нет строки «Документация: …» (`The expression evaluated to a falsy value`), в окне нет ссылки (`0 !== 1`).
- [ ] **Step 3: ссылка** — diff к `api-ui.js`:

```diff
diff --git a/public/js/admin/views/api-ui.js b/public/js/admin/views/api-ui.js
--- a/public/js/admin/views/api-ui.js
+++ b/public/js/admin/views/api-ui.js
@@ -11,11 +11,11 @@
 // в сети Easy-Med открывают по http — тогда значение выделяется для Ctrl+C.
 import { supabase } from '../../supabase.js';
 import { h, Icon, Tag, toast, fmtDate, fmtDateTime } from '../ui.js';
-import { tr, trf } from '../i18n.js';
+import { tr, trf, getLang } from '../i18n.js';
 import { isRouteAllowed, settingsTileAllows } from '../permissions.js';   // CLINIC_API_STEP7_V1 (ревью слияния №2) — дорога к адресу по праву
 import {
   KINDS, KIND_INFO, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, RATE_LIMITS, KEY_TTLS, KEY_TTL_LABEL,
-  NAME_MAX, CONTACT_MAX, keyExpiryState,
+  NAME_MAX, CONTACT_MAX, keyExpiryState, apiDocsUrl,
 } from '../../shared/api-connections.js';
 
 export async function rpc(name, args = {}) {
@@ -46,6 +46,16 @@ export function shapeSettings(raw) {
   };
 }
 
+/**
+ * API_DOCS_V1 — ссылка на документацию для партнёров (решение владельца 21): одна
+ * публичная страница api.easymed.uz/docs на языке экрана, в новой вкладке. Своей
+ * страницы документации в программе нет.
+ */
+export function docsLink(variant = 'outline') {
+  return h('a', { class: 'btn btn-' + variant + ' btn-sm', href: apiDocsUrl(getLang()), target: '_blank', rel: 'noopener noreferrer',
+    'data-apic-act': 'docs', title: 'Откроется в новой вкладке' }, Icon('Doc', { size: 14 }), ' ', 'Документация для партнёров');
+}
+
 export async function copyText(text) {
   const cb = (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
   try {
```

- [ ] **Step 4: текст и окно** — diff к `api-connection-new.js`:

```diff
diff --git a/public/js/admin/views/api-connection-new.js b/public/js/admin/views/api-connection-new.js
--- a/public/js/admin/views/api-connection-new.js
+++ b/public/js/admin/views/api-connection-new.js
@@ -8,10 +8,10 @@
 // у сервера (shared/api-connections.js), до запроса. После «Создать» — окно
 // «Что передать подключению» с «Скопировать всё».
 import { h, Icon, clear, toast } from '../ui.js';
-import { tr, trf } from '../i18n.js';
-import { DEFAULTS, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, normalizeConnection, connectionProblems } from '../../shared/api-connections.js';
+import { tr, trf, getLang } from '../i18n.js';
+import { DEFAULTS, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, normalizeConnection, connectionProblems, apiDocsUrl, curlCommand } from '../../shared/api-connections.js';
 import { rpc, secretField, section, fieldBox, kindPicker, basicsFields, accessSections, hooksSection, securityFields,
-  activeField, openModal, addressBlock, isAddressRefusal, permChips, copyText } from './api-ui.js';
+  activeField, openModal, addressBlock, isAddressRefusal, permChips, copyText, docsLink } from './api-ui.js';
 
 const KEY_HINT = 'Ключ создан сам. Скопируйте его и передайте вместе с адресом API. Он сохранится, когда вы нажмёте «Создать подключение и ключ»; позже его можно открыть в карточке подключения — видят его только администраторы.';
 const defaultsOf = (k) => { const d = DEFAULTS[k] || DEFAULTS.partner; return { scopes: [...d.scopes], webhook_events: [...d.events], rate_limit: d.rate_limit, key_ttl: d.key_ttl }; };
@@ -78,7 +78,20 @@ export async function openNewConnection({ settings, onCreated = null, onNavigate
   return m;
 }
 
-/** Текст «Скопировать всё»: одним сообщением всё, что нужно подключению. */
+// API_DOCS_V1 — первый запрос для проверки ключа: раздел, который ключу открыт
+// (иначе 403), без обязательных параметров; справочник открыт любому ключу.
+const PROBE_PATHS = Object.freeze({ clinic: 'clinic', branches: 'branches', doctors: 'doctors', services: 'services', packages: 'packages' });
+export function probePath(scopes) {
+  const s = READ_SCOPES.find((k) => PROBE_PATHS[k] && (scopes || []).includes(k));
+  return s ? PROBE_PATHS[s] : 'reference/specialties';
+}
+
+/**
+ * Текст «Скопировать всё»: одним сообщением всё, что нужно подключению.
+ * API_DOCS_V1 (решение владельца 21) — ссылка на документацию на языке экрана и
+ * команда проверки ключа. В команде — подстановка «<ключ>», а не сам ключ: ключ
+ * одной строкой выше, а команду пересылают и вставляют в терминалы и чаты.
+ */
 export function handoverText({ clinic, baseUrl, key, secret, scopes }) {
   const allowed = [...READ_SCOPES, ...WRITE_SCOPES].filter((k) => (scopes || []).includes(k)).map((k) => tr(SCOPE_INFO[k].label));
   const lines = [trf('Подключение к API клиники «{clinic}»', { clinic }), trf('Адрес API: {url}', { url: baseUrl })];
@@ -86,6 +99,9 @@ export function handoverText({ clinic, baseUrl, key, secret, scopes }) {
   lines.push(tr('Передавайте ключ в каждом запросе: Authorization: Bearer <ключ>'));
   if (secret) lines.push(trf('Секрет для проверки уведомлений: {secret}', { secret }));
   lines.push(trf('Разрешено: {list}', { list: allowed.join(', ') }));
+  lines.push(trf('Документация: {url}', { url: apiDocsUrl(getLang()) }));
+  const url = String(baseUrl || '').replace(/\/?$/, '/') + probePath(scopes);
+  lines.push(trf('Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): {cmd}', { cmd: curlCommand({ url, key: tr('<ключ>'), oneLine: true }) }));
   lines.push(tr('Работать начнёт, когда в Easy-Med включат публичный сервер.'));
   return lines.join('\n');
 }
@@ -94,7 +110,7 @@ export function handoverText({ clinic, baseUrl, key, secret, scopes }) {
 export function openHandover({ settings, connection: c, key, secret = '', baseUrl, rotated = false }) {
   const withSecret = !!(secret && c.webhook_url);
   const text = handoverText({ clinic: settings.clinic_name, baseUrl, key, secret: withSecret ? secret : '', scopes: c.scopes });
-  const area = h('textarea', { class: 'apic-handover cell-mono', readonly: 'readonly', rows: '7', translate: 'no', 'aria-label': 'Текст для отправки' });
+  const area = h('textarea', { class: 'apic-handover cell-mono', readonly: 'readonly', rows: '9', translate: 'no', 'aria-label': 'Текст для отправки' });
   area.value = text;
   const lead = rotated
     ? 'Новый ключ сохранён, прежний больше не подходит. Отправьте подключению новый ключ — проще всего кнопкой «Скопировать всё».'
@@ -110,7 +126,8 @@ export function openHandover({ settings, connection: c, key, secret = '', baseUr
       // («Сайт клиники», «Сайт»): tr() до подстановки в фразу.
       h('dt', null, 'Заявки в CRM'), h('dd', null, trf('с источником «{label}»', { label: tr(c.crm_source_label) })),
       h('dt', null, 'Как передавать ключ'), h('dd', null, h('code', { translate: 'no' }, 'Authorization: Bearer <ключ>')),
-      h('dt', null, 'Ключ потом'), h('dd', null, 'Его можно открыть и скопировать в карточке подключения, вкладка «Ключ».'))),
+      h('dt', null, 'Ключ потом'), h('dd', null, 'Его можно открыть и скопировать в карточке подключения, вкладка «Ключ».'),
+      h('dt', null, 'Документация'), h('dd', null, docsLink('ghost')))),
     fieldBox('Текст для отправки', area, null, null));
   const copyAll = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'copy-all' }, Icon('Copy', { size: 15 }), ' ', 'Скопировать всё');
   copyAll.addEventListener('click', async () => {
```

- [ ] **Step 5: словарь** — блок вставить в `public/js/admin/i18n-strings.js` **последним в `STRINGS`**, перед закрывающей `};` (перед вставкой — `grep -n '^  "Документация для партнёров":' public/js/admin/i18n-strings.js`: статьи быть не должно):

```js
  // API_DOCS_V1 — документация для партнёров: ссылка на публичную страницу api.easymed.uz/docs и команда проверки ключа в «Скопировать всё» (решение владельца 21)
  "Документация для партнёров": {"en":"Documentation for partners","ru":"Документация для партнёров","uz":"Hamkorlar uchun hujjatlar"},   // API_DOCS_V1
  "Откроется в новой вкладке": {"en":"Opens in a new tab","ru":"Откроется в новой вкладке","uz":"Yangi varaqda ochiladi"},   // API_DOCS_V1
  "Документация: {url}": {"en":"Documentation: {url}","ru":"Документация: {url}","uz":"Hujjatlar: {url}"},   // API_DOCS_V1
  "Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): {cmd}": {"en":"Check the key (in Windows PowerShell, type curl.exe instead of curl): {cmd}","ru":"Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): {cmd}","uz":"Kalitni tekshirish (Windows PowerShell oynasida curl o‘rniga curl.exe yozing): {cmd}"},   // API_DOCS_V1 — ревью шага 9, п. 7
  "<ключ>": {"en":"<key>","ru":"<ключ>","uz":"<kalit>"},   // API_DOCS_V1
  // /API_DOCS_V1
```

- [ ] **Step 6:** `node --experimental-vm-modules --test public/js/admin/__tests__/api-connection-new.test.mjs public/js/admin/__tests__/api-connection-card.test.mjs` → зелёные (`api-connection-new` — **8 тестов**; после ревью шага 9, п. 7 — **9**: тест статьи словаря с подсказкой curl.exe, `9e66a223`); с `force-en.mjs` — то же; сторожа Б — зелёные.
- [ ] **Step 7: коммит** «API и подключения: в «Скопировать всё» — ссылка на документацию для партнёров на языке экрана и команда проверки ключа curl с подстановкой <ключ> (ключ — только своей строкой); раздел — первый открытый ключу, иначе справочник; в окне «Что передать» — ссылка «Документация для партнёров» в новой вкладке» — четыре файла (`i18n-strings.js` и `api-ui.js` — точным блобом, если в клоне правят и другие шаги).

---

## Task 7: Шапка «API и подключения» — ссылка «Документация для партнёров» (API_DOCS_V1)

Сборщик Б. Нужна задача 6.

**Files:**
- Modify: `public/js/admin/views/api-connections.js`
- Modify: `public/js/admin/__tests__/api-connections.test.mjs`
- Modify: `public/js/admin/__tests__/api-connections-i18n-en.test.mjs`

- [ ] **Step 1: падающие тесты** — diff к обоим тестам:

```diff
diff --git a/public/js/admin/__tests__/api-connections.test.mjs b/public/js/admin/__tests__/api-connections.test.mjs
--- a/public/js/admin/__tests__/api-connections.test.mjs
+++ b/public/js/admin/__tests__/api-connections.test.mjs
@@ -306,3 +306,18 @@ test('«Компания: Просмотр»: кнопки нет — строк
     assert.ok(textOf(root).includes('Адрес для партнёров заполняет администратор или тот, кому выдано изменение «Компании».'));
   } finally { perms.setFullAccess('Admin'); }
 });
+
+// API_DOCS_V1 — решение владельца 21: документация — публичная страница
+// api.easymed.uz/docs; экран даёт на неё ссылку в шапке, своей страницы нет.
+test('API_DOCS_V1: в шапке — «Документация для партнёров» в новой вкладке; у администратора, на «Просмотре» и в филиале', async () => {
+  for (const over of [{}, { can: { view: true, edit: false, admin: false } }, { building_role: 'secondary' }]) {
+    reset();
+    const root = await open(over);
+    const a = byAttr(root, 'data-apic-act', 'docs');
+    assert.equal(a.length, 1, JSON.stringify(over));
+    assert.deepEqual([a[0].tagName, a[0].attrs.href, a[0].attrs.target, a[0].attrs.rel, a[0].className],
+      ['A', 'https://api.easymed.uz/docs', '_blank', 'noopener noreferrer', 'btn btn-outline btn-sm']);
+    assert.ok(textOf(a[0]).includes('Документация для партнёров'));
+    assert.ok(!rpcNames().some((n) => /doc/i.test(n)), 'документацию программа у своего сервера не спрашивает');
+  }
+});
```

```diff
diff --git a/public/js/admin/__tests__/api-connections-i18n-en.test.mjs b/public/js/admin/__tests__/api-connections-i18n-en.test.mjs
--- a/public/js/admin/__tests__/api-connections-i18n-en.test.mjs
+++ b/public/js/admin/__tests__/api-connections-i18n-en.test.mjs
@@ -10,7 +10,7 @@ import { mk, walk, onRpc, reset, tick, settingsFixture, KEY_VALUE, SECRET_VALUE
 localStorage.setItem('admin.lang', 'en');   // после стенда (он ставит 'ru'), до видов: язык выбирается при загрузке i18n.js
 const { getLang } = await import('../i18n.js');
 const { renderApiConnections } = await import('../views/api-connections.js');
-const { openNewConnection, openHandover } = await import('../views/api-connection-new.js');
+const { openNewConnection, openHandover, handoverText } = await import('../views/api-connection-new.js');
 const { openConnectionCard } = await import('../views/api-connection-card.js');
 
 const CYR = /[А-Яа-яЁё]/;
@@ -80,3 +80,21 @@ test('en: отказ «филиал на сайте без адреса» — п
   assert.ok(text.includes('Open “Branches”'));
   document.body.children.length = 0;
 });
+
+// API_DOCS_V1 — на английском экране ссылка ведёт на английскую страницу
+// документации, а «Скопировать всё» — с английскими строками и «<key>».
+test('en: документация — английская страница; «Скопировать всё» — Documentation и Check the key с <key>', async () => {
+  reset();
+  const fx = fixture();
+  onRpc('api_settings_get', () => fx);
+  onRpc('api_journal_list', () => []);
+  const root = mk('div');
+  await renderApiConnections(root, {});
+  await tick();
+  const a = walk(root).find((n) => n.attrs && n.attrs['data-apic-act'] === 'docs');
+  assert.deepEqual([a.attrs.href, a.attrs.title], ['https://api.easymed.uz/docs/en', 'Opens in a new tab']);
+  const text = handoverText({ clinic: 'Clinic Demo', baseUrl: fx.base_url, key: KEY_VALUE, secret: '', scopes: ['clinic'] });
+  assert.ok(text.includes('Documentation: https://api.easymed.uz/docs/en'));
+  assert.ok(text.includes('Check the key (in Windows PowerShell, type curl.exe instead of curl): curl "https://api.easymed.uz/klinika-demo/v1/clinic" -H "Authorization: Bearer <key>"'));
+  assert.ok(!/[А-Яа-яЁё]/.test(text), 'кириллица в тексте для отправки: ' + text);
+});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/api-connections.test.mjs public/js/admin/__tests__/api-connections-i18n-en.test.mjs` → два красных: в шапке нет ссылки (`0 !== 1`), английская страница — `Cannot read properties of undefined (reading 'attrs')`.
- [ ] **Step 3: ссылка в шапке** — diff:

```diff
diff --git a/public/js/admin/views/api-connections.js b/public/js/admin/views/api-connections.js
--- a/public/js/admin/views/api-connections.js
+++ b/public/js/admin/views/api-connections.js
@@ -17,7 +17,7 @@ import { h, Icon, PageHead, Tag, clear, toast, fmtDateTime } from '../ui.js';
 import { tr, trf } from '../i18n.js';
 import { refreshClinicBrand } from '../clinic-context.js';
 import { API_HOST, KIND_INFO, normalizeSlug, slugProblem } from '../../shared/api-connections.js';
-import { rpc, shapeSettings, copyText, secretField, permChips, expiryTag, journalTable, addressBlock } from './api-ui.js';
+import { rpc, shapeSettings, copyText, secretField, permChips, expiryTag, journalTable, addressBlock, docsLink } from './api-ui.js';
 import { openNewConnection } from './api-connection-new.js';
 import { openConnectionCard } from './api-connection-card.js';
 
@@ -32,7 +32,8 @@ export async function renderApiConnections(container, { onNavigate = null, paylo
   refs = { root: h('div', { class: 'fade-in apic' }), body: h('div', { class: 'apic-stack' }), onNavigate };
   state.editSlug = false;
   container.appendChild(refs.root);
-  refs.root.appendChild(PageHead({ title: 'API и подключения', subtitle: SUBTITLE }));
+  // API_DOCS_V1 — документация для партнёров: публичная страница, не экран программы (решение владельца 21).
+  refs.root.appendChild(PageHead({ title: 'API и подключения', subtitle: SUBTITLE, right: docsLink() }));
   refs.root.appendChild(refs.body);
   // CLINIC_API_STEP7_V1 (ревью №3) — оболочка держит экран в кэше и второй раз его
   // не рисует: следующий переход с connection_id приходит сюда. Список
```

- [ ] **Step 4:** те же тесты → зелёные: `api-connections` — **19 тестов** (по коду — **21**: сборщик Б добавил два теста сверх плана — рамка «только просмотр» не глотает ссылку, правила CSS телефона; `878671e1`), `api-connections-i18n-en` — **3 теста**; с `force-en.mjs` — то же; плюс `api-connection-new.test.mjs`, `api-connection-card.test.mjs` и сторожа Б — зелёные.
- [ ] **Step 5: коммит** «API и подключения: в шапке экрана — ссылка «Документация для партнёров» на публичную страницу api.easymed.uz/docs на языке экрана, в новой вкладке — у любого права и в филиале; своей страницы документации в программе нет (решение владельца 21)» — три файла.

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды**, когда сборщики клона не пишут: `node --experimental-vm-modules --test` из корня клона и то же с `--import …/force-en.mjs`. `LIS_ENABLED=0` на весь набор не ставить (план 8b, «Завершение»).

**2. Проверка «сломать»** — отдельный агент, только чтение и временные правки в своей копии дерева. Каждая правка кода должна сделать красным названный страж (так было при подготовке плана — 11 из 11):

| Правка | Красный |
|---|---|
| новый адрес партнёров (`r.get('/news', …)` в `partner-read.js`) | `drift.test.js` |
| новая причина поля (`field('start', 'weekend')` в `partner-write.js`) | `drift.test.js` |
| новый код в `ERRORS` | `drift.test.js` |
| новое поле ответа `/clinic` | `examples.http.test.js` (и `page-curl`) |
| предел имени 120 → 100 | `examples.http.test.js` |
| `Access-Control-Max-Age` 600 → 300 | `examples.http.test.js` |
| `request.accepted` шлёт другой статус (`bookings.js`) | `drift.test.js` |
| `appointment.cancelled` шлёт новое поле (`visit-events.js`) | `drift.test.js` |
| новый статус в `PARTNER_STATUSES` | `drift.test.js` |
| новая причина `closed` в `requests.js` | `drift.test.js` |
| `/packages` — под правом `services` | `examples.http.test.js` |

Плюс: ключ, похожий на настоящий, в `content.js` — `render.test.js` и `no-real-api-keys` красные; русское слово в узбекском тексте — `drift.test.js` красный.

**3. Глазами** — страница в браузере (задача 4, шаг 5) на 390 и 1280, светлая и тёмная тема, печать; экран «API и подключения» на тестовой клинике `:8712`: ссылка в шапке открывает публичную страницу в новой вкладке; «Скопировать всё» — строки «Документация» и «Проверить ключ». До шага 8c страница по адресу `https://api.easymed.uz/docs` ещё не открывается — это ожидаемо (службу ставит 8c).

**4. Ревью** — `superpowers:requesting-code-review`; затем слияние, пуш и тег — по слову владельца.

**5. Для 8c:** после установки службы — две проверки из `DEPLOY.md` (`curl -sI https://api.easymed.uz/docs`, перенаправление с `http`).

---

## Ревью шага 9 (2026-10-12)

Ревью выгрузки `878671e1` (отчёт контролёра `scratchpad/step9-review-report.md`, повторы `zz-d9-*`): 7 подтверждённых находок (3 важных, 4 мелких), 6 опровергнутых. До ревью, по просьбе контролёра, — полировка таблиц на телефоне: уже 600 px строка таблицы — блоком, над значением — подпись столбца (`data-label`, только CSS); на широком экране и в печати — таблица (`23ee01e4`).

| # | Находка | Исправление | Коммит |
|---|---|---|---|
| 1 | **Важное.** «Статусы заявки» пропускали переходы сервера: `offered` → `expired`, `declined`, снова `offered`; «перезвоните» `new` → `booked` сразу. `expired` винил клинику и тогда, когда пациент не ответил на другое время. | Переходы — данные `content.js FLOWS`; страница рисует их по строке на статус-источник. `expired` — и «пациент не ответил до `offer_until`». Страж `drift.test.js` «переходы статусов»: каждый переход кода есть на странице — действия клиники (`bookingActions`), истечение (`expireDue`), запись по карточке и судьба визита (`visit-events.js`), ответы партнёра (`partnerCancel`, `partnerAnswerOffer`), закрытие сервером (`closeOverdue`). | `82322dfa` |
| 2 | **Важное.** Страница обещала закрытие любой заявки без ответа, а забранная «перезвоните» живёт `new` / `accepted` до стирания через 90 дней (так задумано, 8b Р7). | Только текст: сервер закрывает лишь `not_collected` и `not_processed`; забранная «перезвоните» — без срока, пока по ней не запишут визит (клиника ищет запись 30 дней — `CLINIC_LIMITS.callbackBookDays`, страж сверяет с `RECHECK_CALLBACK_DAYS`); итоговые статусы и когда перестать спрашивать; уведомления; `404` после 90 дней. | `82322dfa` |
| 3 | **Важное.** Страж событий не видел `emit(…, EV.x, 'статус')` без полей; порог `>= 14` равнялся сегодняшнему счёту. | Разбор — с необязательными полями, во всех рабочих файлах `server/services`; число разобранных обязано равняться числу вызовов `enqueueEvent` / `emit`. Мутация ревью (`no_show` как `appointment.cancelled`) — красная в двух стражах. | `82322dfa` |
| 4 | Поля пациента на верхнем уровне `POST /requests` возвращаются в ошибке как `name`, `phone`, `comment`. | Заметка у адреса; вторая строка поля в таблице (`FIELD_ERRORS.top`); страж записывает обе пары; пробы стража — и верхним уровнем. | `82322dfa` |
| 5 | `/slots` без `date` отдаёт `days: [{date, slots}]` — на странице этого не было. | Заметка на трёх языках и пример `slots-days` (`generated.js` пересобран). | `82322dfa` |
| 6 | Числа словами в тексте («сутки», «60 секунд», «пяти», «четырёх», «UTC+5», «раз в минуту»); `Allow-Methods` проверялся по началу. | Из кода: `MEDIA_MAX_AGE_SEC` (`routes/partner.js`; проба стража по настоящему файлу), `WINDOW_MS` (таблица лимитов «в минуту» — страж: окно — минута), `API_GROUPS.length`, специальности (`snapshot.js` — страж), `DEFAULT_TZ_OFFSET_MIN` (`config.js`), обновление свободного времени (`SLOTS_EVERY_MS`). `Allow-Methods` — ровно `GET, POST, DELETE, OPTIONS`. Страж «цифр руками в тексте нет». | `82322dfa` |
| 7 | Сборщик Б. Строка «Проверить ключ» падала в Windows PowerShell 5.1 (`curl` — это Invoke-WebRequest). | «Проверить ключ (в Windows PowerShell пишите curl.exe вместо curl): curl …» на трёх языках; команда остаётся `curl` (на macOS и Linux `curl.exe` нет); описание `curlCommand`, Р8 и блоки задач 1, 6, 7 поправлены. | `9e66a223` |

**Проверка поломкой:** 8 мутаций кода — окно лимитов 30 с, литерал кэша мимо постоянной, `PATCH` в `Allow-Methods`, лишний переход в `expireDue`, `partnerCancel`, `bookingActions`, `closeOverdue`, новая причина поля — каждая красная. Повторы ревью (35 файлов, 110 тестов; утверждавшие дефект — перевёрнуты) зелёные как есть и на en-US.

**Счёт тестов после ревью:** `drift.test.js` — 12, `render.test.js` — 8 (с `page-curl` — 12), все тесты службы — **165 в 28 файлах** (161 плана + 1 полировки + 3 ревью); `api-connection-new` — 9, `api-connections` — 21, `api-connections-i18n-en` — 3, общий модуль `api-connections` — 12. Блоки кода задач 2–5 описывают код до полировки и ревью; итоговый код — в репозитории.

---

## Вопросы владельцу

**Вопрос 1. Какой адрес Easy-Med показать разработчикам партнёров внизу страницы?** Страница публичная: её читают программисты med24, clinics.uz и других. Внизу написано: «Ключ, права и адрес клиники выдаёт сама клиника. Вопросы по API — …».
- **А (рекомендую, так построено):** `hello@easymed.uz` — этот адрес уже есть в программе (окно «Обновить тариф»). Ничего заводить не нужно.
- **Б:** отдельный адрес для разработчиков (например, `api@easymed.uz`) — письма партнёров не смешиваются с письмами клиник, но адрес надо завести и читать.
- **В:** Telegram поддержки — быстрее, но ссылка на чат на публичной странице приведёт туда и случайных людей.
- *Пример:* программист med24 получил `401 key_disabled` и не понимает почему — он пишет на этот адрес, а мы отвечаем «клиника выключила подключение, свяжитесь с клиникой».
- Смена — одна строка (`DOCS_CONTACT` в `public-server/server/docs/content.js`), страница обновится при выпуске.

**Сообщить владельцу (решено, не вопросы):**
- Страница открыта всем, как и решено: в ней нет данных ни одной клиники и ни одного пациента — примеры показывают выдуманную клинику «Шифо» на март 2030 года.
- По умолчанию страница русская; узбекская и английская — по кнопке вверху. Программа клиники даёт ссылку на страницу на языке своего экрана.
- Страница честно говорит, что партнёр **не** узнаёт: «не пришёл» сейчас партнёрам не сообщается вовсе (статус остаётся «записан»); «пришёл» — только если клиника сама включила подключению это событие (врачебная тайна); заявку, на которую клиника не ответила, сервер закрывает без уведомления — партнёр видит это, спросив статус.
- В тексте «Скопировать всё» появились две строки: ссылка на документацию и команда проверки ключа. Сам ключ в команду не подставляется — только словом «<ключ>»: команду часто пересылают в чатах. В Windows PowerShell строка подсказывает писать curl.exe вместо curl (ревью шага 9, п. 7).
- Заявку «перезвоните», которую клиника уже забрала, сервер сам не закрывает: она остаётся «новая» или «в работе», пока по ней не запишут визит. Страница говорит партнёрам, какие статусы итоговые и когда перестать спрашивать статус (ревью шага 9, п. 2).

---

## Риски

1. **Ответы партнёрам меняются — нужно пересобрать примеры.** Любая правка ответа делает `examples.http.test.js` красным с готовой командой `node public-server/scripts/docs-build.mjs`; забыть нельзя, но это лишний шаг в каждой будущей правке адресов партнёров.
2. **Страница описывает поведение программы клиники текущего выпуска** (какие события и поля шлёт клиника, держание 30 минут, ритм обмена). Клиника на старой версии ведёт себя по своей версии. Страж сверяет страницу с кодом клиники **этого** репозитория.
3. **`no_show` в словаре статусов есть, но не приходит** (`visit-events.js` меняет статус без события). Страница говорит это прямо. Если «не пришёл» начнут отправлять каким-либо событием, покраснеет страж событий (`no_show` не указан ни у одного события в `EVENT_TEXT`) — строку статуса поправят вместе с таблицей событий.
4. **`occurred_at` уведомления — в UTC**, а дизайн шага 8 (§7) обещал «ташкентское со смещением». Страница описывает код (страж держит `occurredAt: isoOf(now)` в `outbox.js`). Менять ли время в уведомлении — отдельное решение, не шаг 9.
5. **Ключ из браузера:** запрос без заголовка `Origin` проходит с любого места, поэтому ключ, вписанный в JavaScript сайта, может взять кто угодно. Страница советует держать ключ на своём сервере и давать «браузерным» подключениям только чтение. Ограничить это на сервере (например, ключи «только для браузера») — 8d или позже.
6. **Песочницы для партнёров нет:** попробовать API можно только с ключом настоящей клиники. Примеры страницы — настоящие ответы, но на выдуманной клинике, которой на сервере нет.
7. **`PUBLIC_TZ_OFFSET_MIN` не 300** — страница всё равно говорит «Ташкент, UTC+5», примеры — `+05:00`. Смещение — Узбекистана, меняться не должно.
8. **Кэш 5 минут:** после выпуска службы старую страницу ещё до 5 минут видят те, кто открывал её раньше.
9. **Даты примеров — 2030 год** (подставные часы тестов). Это видно как пример, но может удивить.

---

## Не входит

| Что | Почему |
|---|---|
| Страница документации внутри программы, PDF | Решение 21. |
| Файл OpenAPI (Swagger), библиотеки для партнёров | Не просили; страница — единственный договор. |
| Песочница (тестовая клиника для партнёров) | Риск 6; отдельное решение. |
| Языки ответа по ключу, журнал запросов и доставок на экране, «Проверить адрес» | 8d. |
| Отправлять партнёрам «не пришёл», время уведомления по Ташкенту | Риски 3–4: смена поведения, не документации. |
| Установка службы, DNS, TLS | 8c (`DEPLOY.md` — его вход; правка nginx этого шага — в нём). |

---

## Проверки плана (сделаны при его подготовке)

- **Весь код собран и прогнан** в копии дерева `e8f4ead3` (ветка `feat/clinic-api-step8b`): песочница `scratchpad/plan9/tree`, выгрузка `git -c core.autocrlf=false archive` (LF), своя копия `node_modules`; ни одного запроса в интернет, ни одного настоящего порта.
- **План проигран по задачам** на чистой копии (`scratchpad/plan9/replay.cjs`) ровно как велит текст: блоки файлов — из самого плана, diff — `git apply --check` и `git apply`, блок словаря — перед последней `};`, `generated.js` — командой задачи 3. Перед реализацией тесты задачи красные так, как написано в шагах 2; после — зелёные как есть и с `force-en.mjs`:
  - задача 1 — 12; задача 2 — 10; задача 3 — 24; задача 4 — 10; задача 5 — 10; задача 6 — 8; задача 7 — 22;
  - сторожа А (32 теста) и Б (46) — зелёные после каждой задачи;
  - все тесты службы — **160 в 28 файлах** (131 тест 8b + 29 новых);
  - **проигрыш повторён на `61591598`** (три коммита узкой проверки 8b: `public-sync.js`, сквозной прогон, план 8b) — все блоки легли, `generated.js` — тот же sha256, задачи зелёные; задача 5 — 11 тестов, все тесты службы — 161 (132 + 29);
  - `generated.js` — 44 264 знака, sha256 тот, что в задаче 3; итог проигрыша совпадает с песочницей **файл в файл** (27 файлов).
- **Шире своих файлов:** `server/services/api/*.test.js` и `public/js/shared/*.test.js` — 376 зелёных, 0 красных (2 пропуска — прежние); тесты экранов API, оболочки, хаба настроек и клиентские сторожа — 190 зелёных. Примеры и `/docs` — зелёные и в `TZ=UTC`. Полный набор репозитория не гонялся: в `easymed.api5` в это время шёл полный прогон, а тесты приёма анализаторов занимают свой порт.
- **Проверка поломкой — 11 из 11** правок кода сделали красным свой страж (таблица в «Завершении», `scratchpad/plan9/mutate.mjs`).
- **Глазами:** Chromium (Playwright) на ширине 320, 360, 390 и 1280, светлая и тёмная тема — ширина документа равна ширине окна (ничего не вылезает), таблицы и код прокручиваются внутри рамки; на 1280 содержание сбоку, на телефоне — один столбец. Страница: ru 89 КБ, uz 78 КБ, en 77 КБ; строится за ~2 мс.
- **Находки самопроверки, исправленные в плане:**
  - `fetch` с `If-None-Match` сам добавляет `Cache-Control: no-cache` — express честно отвечал 200; проверка `304` переведена на `node:http`;
  - пробы таблицы полей (55 запросов) упирались в лимит записей 30 в минуту — у проб и матрицы прав стенд без лимитов (`NO_LIMITS`; лимиты проверяют тесты 8b);
  - проверка `<th scope="col">` срабатывала на `<thead>` — выражение уточнено и проверено поломкой;
  - коды в узких столбцах таблиц рвались посреди слова (`appointme|nts`) — `td code{overflow-wrap:normal}`, пути переносятся только после `/`;
  - запись файлов через `cat <<EOF` съела `\\` в команде `curl` и тесте — в «Правила рабочего дерева» добавлено: новые файлы — только Write;
  - `Content-Encoding: compress` → `415 unsupported_encoding` (body-parser 2.3 разжимает `gzip`, `deflate`, `br`); «Время держится N минут» и прочие числа — с падежом по числу (`{{имя:единица}}`), чтобы смена постоянной не дала «24 часов».
- **Найдено в коде и сказано на странице (не исправлялось — не шаг 9):** «не пришёл» партнёрам не уходит вовсе; `occurred_at` уведомления — в UTC, хотя дизайн 8 (§7) обещал Ташкент; ключ без заголовка `Origin` работает откуда угодно (риски 3–5).
- **Спецификация и задача — у каждого пункта задача или строка «Не входит»** (таблица «Что шаг 9 закрывает»); макет — строение и тон сохранены, расхождения с сервером — Р9.
