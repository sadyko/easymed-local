# API клиники, шаг 8b: публичный сервер api.easymed.uz — служба `public-server/` (PUBLIC_SERVER_V1, CLINIC_API_STEP8B_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** построить сам публичный сервер `api.easymed.uz` — отдельную службу `public-server/` в этом репозитории. Она:
- говорит с клиникой ровно тем протоколом `/_sync/v1/*`, который сторона клиники (шаг 8a) уже говорит с поддельным сервером `server/test-helpers/fake-public-server.js`;
- узнаёт клинику по подписанной лицензии и подписи запроса, без общих секретов;
- отдаёт партнёрам последний снимок клиники по документации макета (`/clinic`, `/branches`, `/doctors`, `/slots`, `/services`, `/packages`, `/reference/*`);
- принимает заявки «перезвоните» и онлайн-записи, запечатывает данные пациента ключом клиники и стирает их, как только клиника приняла;
- проверяет ключ партнёра по отпечатку, права, IP, сайт, срок; держит лимиты (429 + `Retry-After`);
- отвечает партнёрам 503, когда лицензия клиники истекла или в ней стоит «не оплачено»;
- доставляет уведомления, подписанные клиникой: повторы, защита от подделки запроса изнутри (SSRF), журнал доставок для клиники;
- закрывает заявки, на которые клиника не ответит;
- даёт `/_health` и `/_metrics` для наблюдения.

Ставит службу на 45.77.242.169 шаг 8c (описание установки — `public-server/DEPLOY.md`, задача 11). До 8c клиники с сервером не говорят: обмен 8a молчит, пока в лицензии нет отпечатка ключа клиники.

**Architecture:**
- **Служба** — `public-server/`:
  - Node 24 ESM, express 5, better-sqlite3, своя база `public.db` (миграция `001`, 10 таблиц);
  - свой `package.json`; `node_modules` в разработке — от корня репозитория, как у `control-plane/`;
  - общие модули программы берутся из `server/` и `public/js/shared/` того же коммита: проверка лицензии, подпись и ящик, словари прав и событий, справочники, правила разбора заявки.
- **Канал клиники** — `routes/sync.js`:
  - сырое тело → проверка (`clinic-auth.js`) → клиника (`store/clinics.js`);
  - затем ключи, снимок, время, файлы, события, очередь.
- **Партнёры** — `routes/partner*.js`:
  - слои входа (`partner-auth.js`) → чтение снимка (`partner-read.js`) → заявки (`partner-write.js`);
  - заявки и очередь — `store/requests.js`.
- **Фон** — `jobs.js`: доставка уведомлений (`store/deliveries.js` + `lib/webhook-send.js` + `lib/net-guard.js`) и уборка.
- **Приложение** — `app.js` (`createPublicServer`); запуск — `index.js`.

**Tech Stack:** Node 24 ESM, express 5.2, better-sqlite3 13, `node:crypto` (Ed25519, X25519 + AES-256-GCM — через `sync-identity.js` клиники, SHA-256, HMAC — подпись клиники проверяет партнёр), `node:net` BlockList, `node:https`, `node:test`.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md`. Договор:
- решения владельца 4, 5, 6, 7, 16, 17, 18, 19;
- «Правила» → «Онлайн-запись», «Сервер», «Каждый шаг».

**Дизайн шага 8:** `docs/specs/2026-10-11-clinic-api-8-public-server-design.md`:
- §1 — что хранит и чего не хранит;
- §2 — клиника без связи, `stale`, 7 суток;
- §3, §4, §7, §8, §9, §10 — протокол;
- §12 — ответы владельца, §13 — риски.

**Вход от 8a:** план `docs/plans/2026-10-11-clinic-api-8a-clinic-side.md`, раздел «Что 8a оставляет 8b, 8c и 8d» → 8b, пункты 1–11. Плюс два открытых пункта 8a:
- заявки, которые клиника забрала, но не открыла или не ответила, закрыть для партнёра по сроку;
- `/slots` с пометкой `stale`.

**Образец протокола** — `server/test-helpers/fake-public-server.js`. Совместимость проверяет сквозной прогон задачи 12: настоящий обмен клиники (`syncOnce`) против настоящего сервера в одном процессе.

**Макет:** `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\js\`:
- `screen-docs.js` — адреса, статусы, ошибки 400 `field` / 404 / 409 `slot_taken` / 429 `Retry-After` / 503, `?lang`, целые суммы, UTC+5;
- `screen-api.js` — права, IP, лимиты, срок ключа, повторы уведомлений.

**Память:** `easymed-clinic-api-mockup`, `symptex-gateway-fragility` (зависший шлюз ронял сайт — сроки, отдельный процесс, потолок памяти), `easymed-clinic-api-research`, `windows-dynamic-port-fetch-bad-port`.

**Код плана прогнан.** Весь код собран и прогнан в копии дерева `d6f4f9f3`:
- песочница `scratchpad/plan8b/tree`, выгрузка `git -c core.autocrlf=false archive` (LF), своя копия `node_modules`;
- план проигран по задачам на чистой копии (см. «Проверки плана»).

**Метка кода:** `PUBLIC_SERVER_V1` — в шапке каждого нового файла.

**Метка плана и коммитов:** `CLINIC_API_STEP8B_V1`. Сообщение коммита кончается скобкой `(PUBLIC_SERVER_V1, CLINIC_API_STEP8B_V1)`.

**Ответы на вопросы плана (2026-10-12):** вопрос 1 — владелец выбрал **сутки** (решение 20 спецификации, а не рекомендованные 7 суток): не забранная клиникой заявка через сутки закрыта для партнёра (`closed`, `not_collected`), шифротекст стёрт; вопрос 2 — **15 минут** (решение контролёра). Оба срока — именованные постоянные `config.js` (`DEFAULT_UNCOLLECTED_MAX_HOURS`, `DEFAULT_SYNC_SKEW_MIN`) с настройками `PUBLIC_UNCOLLECTED_MAX_HOURS`, `PUBLIC_SYNC_SKEW_MIN`. Правило «клиника молчит 7 суток — 503» не меняется. Блоки кода ниже — по ответам (см. «Вопросы владельцу»).

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | **Отдельная служба `public-server/` со своим `package.json`** (express, better-sqlite3; без bcryptjs — паролей у службы нет).<br>• В разработке `node_modules` берутся от корня (разрешение модулей идёт вверх по папкам), как у `control-plane/` (его README).<br>• На сервере — `npm ci --omit=dev` внутри `public-server/`.<br>• Код ставится выгрузкой репозитория целиком: служба импортирует `server/services/control/licence.js`, `server/services/api/sync-identity.js`, `secret-box.js` (`keyHash`), `public/js/shared/*`. | Дизайн §1 (А): один репозиторий — один протокол, одни справочники, одна проверка подписи. Свой `package.json` — честный список зависимостей для установки на другой машине и отдельного процесса (решение 16: свой потолок памяти). Выпуск программы клиники службу не берёт (разрешающий список `scripts/build-bundle.mjs`; страж `not-shipped.test.js`). |
| Р2 | **Хранилище — SQLite** (WAL, `foreign_keys`, **`secure_delete`**, `busy_timeout`). Одна миграция `001_public_server.sql`, 10 таблиц:<br>• `clinics`, `slug_aliases`, `connections`, `media`;<br>• `requests`, `inbox`, `events_seen`;<br>• `deliveries`, `delivery_log`, `access_log`.<br>Страж `schema.test.js` сверяет каждую колонку со списком и не пускает колонки «пациента, ключа, секрета». | Как `control-plane/`. `secure_delete` затирает стёртую строку очереди (шифротекст) на странице базы. Уборка делает `wal_checkpoint(TRUNCATE)`. Решение 16: меньше данных — меньше риска. |
| Р3 | **Личность клиники** (`clinic-auth.js`), по порядку:<br>1. лицензия подписана производителем (`verifyLicence` программы) и выдана этой клинике;<br>2. отпечаток присланного ключа = `payload.api_sync_key`;<br>3. время запроса — в пределах ±15 минут (`PUBLIC_SYNC_SKEW_MIN`, решение контролёра 2026-10-12; отказ 401 `clock_skew` с `server_time`);<br>4. подпись запроса.<br>Решает **самая новая лицензия** (по `issued_at`):<br>• более старая лицензия с другим ключом — 401 `licence_outdated`;<br>• ключи, снимок и время с `generated_at` старше сохранённого не применяются. | Дизайн §4 (А): без общих секретов и без вопросов к серверу лицензий. Клиника сама выбирает, какой `licence.dat` приложить: старая лицензия без «не оплачено» иначе обходила бы решение 17. Окно часов и «не старше» не дают проиграть перехваченный `PUT /keys` и включить обратно выключенный ключ. |
| Р4 | **Состояние лицензии — одна функция** `licence-gate.js`: `subscriptionOf` (только явное `payload.subscription === 'unpaid'`) и `licenceStanding`.<br>• `lapsed` (срок вышел) — 503 `licence_lapsed` партнёрам и каналу клиники (§10);<br>• `unpaid` — 503 партнёрам, канал клиники открыт: события по уже принятым записям доходят (§9, рекомендация). | Решения 4 и 17. Шов для 8c: если поле назовут иначе — меняется одна функция и её тест. Неизвестное слово — «active»: назвать платящую клинику неплательщиком хуже (правило `easymed-licence-lockout`). Текст партнёру — «Клиника временно недоступна. Позвоните в клинику.» и телефон клиники, не «не оплатила». |
| Р5 | **Данные пациента.**<br>• Проверяются правилами разбора клиники (`parseInboxItem`): имя ≤ 120, телефон ≤ 32 знаков и ≥ 7 цифр, комментарий ≤ 1000.<br>• Запечатываются `sealFor(box_key)` в миг приёма. Открытыми не лежат нигде: ни в `requests`, ни в `inbox.data`, ни в журнале, ни в ответах.<br>• Строка очереди стирается **целиком** при `POST /inbox/ack`, как у поддельного сервера 8a.<br>• Статус заявки без данных пациента живёт 90 дней. | Решения 5 и 16, дизайн §1. Тот же код запечатывания, что открывает клиника (`sync-identity.js`): тест задачи 4 открывает элемент ключом клиники и прогоняет его через `parseInboxItem` клиники. |
| Р6 | **Статус ведёт клиника**: её события, тело `webhookBody` — `status`, `reason`, `start`, `offered_start`, `offer_until`. Сервер пишет только своё:<br>• приём — `new` или `pending` без `hold_until`;<br>• `held` из подтверждения → `hold_until`;<br>• отмена пациентом: ждущая или с предложением — сразу `cancelled` (клиника освобождает время без события); записанная — остаётся `booked` с `cancel_requested`, пока клиника не отменит визит;<br>• согласие на другое время → `pending` на новом времени; отказ → `cancelled`.<br>Позднее «истекло» или отказ клиники не перебивает отмену партнёра. | Дизайн §6, §7; `bookings.js` 8a: `partnerCancel` и `partnerDeclineOffer` событий не шлют, `partnerAcceptOffer` сообщает срок через `held`. Клиника, вернувшись после обрыва, сначала истекает удержания и только потом читает очередь — без этого правила партнёр увидел бы «истекло» после своей отмены. |
| Р7 | **Закрытие без ответа** — новый статус `closed` с `reason`:<br>• `not_processed` — клиника забрала онлайн-запись (подтвердила курсор), но 30 минут не держит время и молчит (не открылось её ключом — риск 6 дизайна; не смогла принять);<br>• `not_collected` — клиника не забрала заявку за сутки (решение владельца 20, `PUBLIC_UNCOLLECTED_MAX_HOURS`): строка очереди с шифротекстом стёрта. Элементы очереди без данных пациента (отмена, ответ на другое время) ждут клинику 7 суток.<br>Уведомления нет: подписать его может только клиника (решение 5), партнёр видит статус в `GET /requests/{id}`. Позднее событие клиники сильнее закрытия. | Открытый пункт 8a. 30 минут: клиника отвечает в том же такте (срок — в `held` того же подтверждения, отказ — событием через миллисекунды). Сутки — решение владельца 20 (вопрос 1): предел, сколько запечатанные данные лежат вне Узбекистана (решение 16). «Клиника молчит 7 суток — 503» (дизайн §2) — отдельное правило и не меняется; до этой границы ждут элементы без данных пациента — иначе клиника, выключенная на выходные, не узнала бы об отмене визита. «Перезвоните» неудачу приёма не различить — 8a не сообщает пропуски (риск 3). |
| Р8 | **409 `slot_taken`**:<br>• по присланному времени — приём N минут требует `ceil(N/15)` свободных окон подряд без разрыва;<br>• плюс своя очередь — ждущие записи с живым или ещё не назначенным сроком и встречные предложения.<br>День за пределами присланного (клиника давно молчит) — запись принимается. | Дизайн §5: «сервер — первая линия», правду говорит клиника. Решение 19: запись принимается и при клинике без связи. |
| Р9 | **`stale` и `as_of`**:<br>• `as_of` — когда клиника последний раз была на связи (опрос очереди каждые 15 с);<br>• `stale: true` — клиника молчит дольше 10 минут. | 8a шлёт неизменное время не чаще раза в 15 минут (`HEARTBEAT_MS`). Возраст присланного делал бы `stale` почти всегда, а пока клиника опрашивает очередь, её изменения доходят за такт. |
| Р10 | **Вход партнёра** (`partner-auth.js`), по порядку:<br>1. потолок по IP — 1200 в минуту (до поиска клиники: перебор имён в адресе тоже упирается в лимит);<br>2. клиника по имени в адресе;<br>3. https;<br>4. состояние клиники — 503;<br>5. ключ: SHA-256 от `Bearer` среди отпечатков (`keyHash` клиники); выключен — `key_disabled`, истёк — `key_expired`; неверные ключи — не больше 30 в минуту с IP;<br>6. «Разрешённые IP» (`net.BlockList`, неверная запись — никого);<br>7. сайт: предварительный запрос CORS — если сайт есть у любого включённого подключения; сам запрос — только с сайта своего ключа, чужой — 403;<br>8. лимит ключа (`rate_limit`) и записи (30 в минуту) — 429 + `Retry-After`;<br>9. права раздела — 403 `forbidden_scope`.<br>Канал клиники: 600 запросов в минуту с IP — **до** чтения тела (чужой без подписи не заставит принимать мегабайты), затем 600 в минуту на клинику. | Дизайн §9, макет «Безопасность». Скользящее окно из двух отрезков по минуте — три числа на ключ, память не растёт (машина общая). Запрос с ключом с чужого сайта браузер отправил бы, даже не дав прочесть ответ, — поэтому отказ, а не просто без CORS. |
| Р11 | **Ответы партнёрам — белый список полей** (`partner-read.js`):<br>• `?lang` — `ru`, `uz` или `en`: название строкой; без параметра — все три; пустой перевод — русский;<br>• адрес собирается из кодов функцией программы `composeAddress`;<br>• суммы — целые; время — `+05:00` (`PUBLIC_TZ_OFFSET_MIN`); время партнёра без смещения (`2030-03-12T10:00`) — время Ташкента, а не пояс машины сервера (`msOfPartner`);<br>• ошибки — `{error:{code, message, field?, reason?}}`, текст на языке `?lang`. | Макет «Документация API». Чего нет в белом списке, партнёр не получит, даже если новая версия клиники пришлёт больше. |
| Р12 | **Справочники — из программы.**<br>• Коды и порядок — `geo-codes.js`;<br>• названия ru / uz / en — разбор текста миграции 132 программы (`reference.js`; тест сверяет все 7 / 14 / 206 кодов);<br>• специальности — `specialty-list.js`. | Решение 6, дизайн §1. В `geo-codes.js` названий нет — они записаны в миграции 132 построчно, и `geo-codes.test.js` держит модуль и миграцию вместе. |
| Р13 | **Файлы снимка** — `/<клиника>/v1/media/<sha256>.<ext>`:<br>• без ключа (картинку на сайте браузер грузит без заголовков);<br>• только файл, на который ссылается текущий снимок;<br>• приём — отпечаток и сигнатура вида сверяются;<br>• отдача — `nosniff`, `Content-Security-Policy: default-src 'none'`. | Макет: логотип и фото — ссылками в ответах. |
| Р14 | **События и доставка уведомлений.**<br>• Принимается **каждое** событие с номером, даже испорченное.<br>• Тело хранится байт в байт.<br>• Доставка: первая попытка и повторы через 1, 5, 10, 30, 60 минут (всего 6); 10 секунд; без перенаправлений; только код ответа.<br>• SSRF: все адреса имени — публичные (ни частных, ни петлевых, ни локальных, ни служебных, ни 169.254.169.254, ни адресов самой машины `PUBLIC_SELF_IPS`); проверка — в функции `lookup` самого соединения (подмена DNS между проверкой и соединением ничего не даёт).<br>• Тело стирается, как только доставка кончилась.<br>• Журнал попыток — для клиники (8d). | 8a шлёт события строго по порядку и повторяет непринятое с головы (`pushEvents`): одно отвергнутое навсегда остановило бы все следующие. Дизайн §8, макет «Если адрес не ответил — 1, 5, 10, 30, 60». На 45.77.242.169 соседи (n8n, шлюз) слушают и на публичном адресе. |
| Р15 | **Журнал запросов партнёров** (30 дней).<br>• Пишется: метод, путь — из списка известных адресов, иначе `/?`; параметры — только известные и только верного вида; код ответа, подключение, IP, время.<br>• Тел нет.<br>• Клиника получает в `GET /_sync/v1/inbox`: `last_used` — всегда; `access` и `deliveries` — только если попросит (`access_after`, `deliveries_after`). | Дизайн §1, §8; пункт 9 «→ 8b». Клиника 8a этих параметров не шлёт — ей ничего лишнего не уходит. Экраны журнала строит 8d. |
| Р16 | **Имя в адресе.**<br>• Занято другой клиникой или её прежним именем в течение 30 дней — `409 slug_taken`.<br>• Своё прежнее имя работает 30 дней.<br>• Вернуть своё прежнее — можно. | Макет: «старый адрес работает ещё 30 дней»; пункт 10 «→ 8b». |
| Р17 | **Клиника молчит 7 суток** — партнёрам `503 clinic_offline`. | Дизайн §2, смягчение «б»: выключенный в клинике ключ иначе работал бы по старым правам. |
| Р18 | **Против зависаний и для общей машины.**<br>• Запрос партнёра не ждёт ни клинику, ни сеть — только свою базу.<br>• Сроки сервера: заголовки 10 с, запрос 20 с, keep-alive 5 с.<br>• Фон — таймеры `unref`, такт не перекрывает себя и не бросает.<br>• `/_health` без ключа; `/_metrics` только с токеном, только числа.<br>• `DEPLOY.md`: отдельный пользователь, `MemoryMax=256M`, свой upstream nginx, `access_log off`. | Память `symptex-gateway-fragility`, решение 16. |
| Р19 | **Тесты.**<br>• Подставные часы 2030 года.<br>• Порт — только `listen()` из `control-plane/server/test-helpers/listen.js`.<br>• Ключи — выпущенные во время теста.<br>• Сквозной прогон: настоящая клиника (`bookingSeed` + `syncOnce`) ↔ настоящий сервер ↔ партнёр (`fetch`) — в поясе процесса (прогнан в Ташкенте, UTC и Нью-Йорке).<br>• Стражи:<br>&nbsp;&nbsp;– схема;<br>&nbsp;&nbsp;– «данных пациента нет открытыми» — ячейки базы, байты файлов базы, журнал процесса, ответы;<br>&nbsp;&nbsp;– «журнал без тел» — исходники;<br>&nbsp;&nbsp;– «не уезжает в клиники». | Пункт 11 «→ 8b». Правила рабочего дерева (порты, ключи, время). |

### Протокол клиники — где дизайн пришлось истолковать

| # | Место | Как сделано |
|---|---|---|
| П1 | `stale` «старше 10 минут» | По молчанию клиники, а не по возрасту присланного (Р9). |
| П2 | 503 каналу клиники | `lapsed` — да (§10), `unpaid` — нет (§9, рекомендация) (Р4). |
| П3 | Какая лицензия решает | Самая новая по `issued_at`; старая с другим ключом — 401 `licence_outdated` (Р3). 8c обязан ставить `issued_at` (так уже делает `signLicence`). |
| П4 | Повтор запросов клиники | Окно часов ±15 минут (401 `clock_skew` + `server_time`) и «не старше сохранённого» для ключей, снимка, времени (Р3). |
| П5 | Испорченное событие | Принимается (`accepted`), ничего не меняет (Р14). |
| П6 | Отмена и ответ партнёра | Сервер сам ставит `cancelled` / `pending`, клиника молчит; позднее «истекло» не перебивает отмену (Р6). |
| П7 | Заявка без ответа | Статус `closed` (`not_processed`, `not_collected`) — расширение словаря статусов §7 (Р7). |
| П8 | Журналы для 8d | `access_after` / `deliveries_after` в `GET /inbox`, `last_used` всегда (Р15). |
| П9 | Сайт (CORS) | Предварительный запрос — по любому включённому подключению; запрос — только сайт своего ключа (Р10). |
| П10 | `/slots` | Без `date` — все дни (`days`); с `consultation` / `service_id` — только подходящие начала; живая очередь — `hours` и `queue_now` (Р8). |
| П11 | Языки ответа по ключу (макет «Языки ответа») | В подключениях шага 7 такого поля нет — только `?lang`; ограничение по ключу — 8d (пункт 6 «→ 8d» плана 8a). |

## Что 8b закрывает

**Пункты 1–11 «→ 8b» плана 8a:**

| Пункт | Задача |
|---|---|
| 1. Адреса партнёров (`/clinic` … `/reference/*`, `POST /requests`, `POST /appointments` → `pending` без `hold_until`, `GET /requests/{id}`, `DELETE`, `accept` / `decline`) | 9, 10 |
| 2. `?lang`, пустой перевод — русский, целые суммы, UTC+5 | 1 (время), 9 |
| 3. Ключ по отпечатку, права 403, выключен / истёк 401, IP, лимит 429 + `Retry-After`, CORS | 6, 9 |
| 4. Лицензия → 503 `licence_lapsed`; «не оплачено» → 503 партнёрам, канал клиники открыт | 2, 5, 9 |
| 5. Подпись запроса, отпечаток = `payload.api_sync_key` | 2 |
| 6. Запечатать при приёме, стереть при подтверждении курсора, статус 90 дней | 4, 11 |
| 7. 409 `slot_taken` по снимку и очереди; без отсечения «клиника без связи»; `stale`; `held` → `hold_until` | 4, 9, 10 |
| 8. Доставка: готовые тело и подпись, 2xx за 10 с, 1/5/10/30/60, SSRF перед каждой отправкой | 8 |
| 9. Журнал запросов (30 дней) и итоги доставок — клинике (`access`, `deliveries`) | 4, 5, 9 |
| 10. Имя в адресе: `slug_taken`, прежнее — 30 дней | 3, 11 |
| 11. Сквозной тест с настоящей клиникой в процессе | 12 |

**Открытые пункты 8a:**
- заявка, которую клиника забрала и не открыла или не ответила, закрывается сроком — 4 (`closeOverdue`), 11 (таймер);
- `/slots` `stale` — 9.

---

## Карта файлов

Все файлы — новые, в `public-server/`. Существующие файлы репозитория **не меняются**.

- **Каркас:**
  - `public-server/package.json`;
  - `public-server/DEPLOY.md` (установка для 8c).
- **`public-server/server/`:**
  - `config.js`, `config.test.js`;
  - `licence-gate.js`, `licence-gate.test.js`;
  - `clinic-auth.js`, `clinic-auth.test.js`;
  - `app.js`, `app.test.js`, `jobs.js`, `index.js`;
  - `e2e.clinic.test.js`, `no-plaintext.guard.test.js`, `not-shipped.test.js`.
- **`server/db/`:**
  - `connection.js`, `migrate.js`;
  - `migrations/001_public_server.sql`;
  - `schema.test.js`.
- **`server/lib/`:**
  - `time.js`, `errors.js`, `rate-limit.js`, `net-guard.js`;
  - `webhook-send.js`, `reference.js`, `slot-check.js`;
  - у каждого — `*.test.js`.
- **`server/store/`:**
  - `clinics.js`, `media.js`, `clinics.test.js`;
  - `requests.js`, `logs.js`, `requests.test.js`;
  - `deliveries.js`, `deliveries.test.js`.
- **`server/routes/`:**
  - `sync.js`, `sync.http.test.js`;
  - `partner.js`, `partner-auth.js`, `partner-read.js`, `partner-write.js`;
  - `partner-read.http.test.js`, `partner-write.http.test.js`;
  - `ops.js`.
- **`server/test-helpers/`:** `fixture.js`, `partner-stand.js`.

Всего — 52 файла: 21 файл тестов (84 теста), 26 модулей, 2 стенда, миграция, `package.json`, `DEPLOY.md`.

---

## Сейчас в коде (сверено 2026-10-11, дерево `d6f4f9f3`)

- **Протокол клиники** — `server/services/api/public-sync.js`.
  - `call()` подписывает `SYNC_PREFIX + p` **вместе с query**: `/_sync/v1/inbox?after=…`. Значит, сервер сверяет подпись по `req.originalUrl`, а nginx не должен переписывать путь.
  - Как клиника понимает ответы: 401 и 403 → `unauthorized`; 503 → `paused`; 409 → `error.code`; прочее не-2xx → `server_error`.
  - Такт: ключи → снимок (`media/check`, `media/<sha>`, `snapshot`) → события → очередь (+ `ack`) → время → события.
  - Ключи, снимок и время уходят, только если изменились, и не реже раза в 15 минут (`HEARTBEAT_MS`). Очередь опрашивается каждый такт.
  - `pushEvents` шлёт непринятые с головы, по порядку.
- **Поддельный сервер** — `server/test-helpers/fake-public-server.js`: образец ответов — `{ok}`, `{missing}`, `{accepted}`, `{items}`. Подтверждение стирает элементы до курсора целиком.
- **Личность** — `server/services/api/sync-identity.js`:
  - `verifyRequest(signPublic, {method, path, time, body}, sig)`;
  - `sealFor(box_key, obj)` и `openSealed`;
  - отпечаток — первые 32 hex SHA-256 от DER (SPKI).
- **Лицензия:**
  - `server/services/control/licence.js` — `verifyLicence(raw, {publicKey, clinicId})`, никогда не бросает; ключ производителя вшит в программу;
  - `control-plane/server/services/signing.js` — `signLicence`, полезная нагрузка: `clinic_id, clinic_name, modules, valid_until, issued_at, nonce`. `api_sync_key` и `subscription` добавит 8c.
- **Правила заявки** — `public/js/shared/api-booking.js`:
  - `parseInboxItem`: `public_id` — `^rq_[A-Za-z0-9]{6,37}$`; `external_id` — `^[\x21-\x7e]{1,64}$`; язык `''|ru|uz|en`; пациент; `start`; `consultation` или `service_id`;
  - `PARTNER_STATUS`, `webhookBody`, `localIso`, `isoOf`.
- **Ответы клиники на действия партнёра** — `server/services/api/bookings.js`:
  - `partnerCancel` (ждущая, с предложением, новая, взятая — без события);
  - `partnerDeclineOffer` (без события);
  - `partnerAcceptOffer` (новый срок — в `held`);
  - `intakeRequest` (без события);
  - `intakeAppointment` (`pending` + `held`, иначе событие отказа).
- **Что шлёт клиника** — `server/services/api/snapshot.js`:
  - `buildSnapshot`: клиника, здания, врачи, услуги, пакеты; файлы — `media/<sha>.<ext>`;
  - `buildSlots`: `{generated_at, slot_minutes, doctors:{id:{reception:'booking', days:[{date, from, to, starts[], free}]} | {reception:'live_queue', hours, queue_now}}}`;
  - `buildKeys`: `{generated_at, connections:[{id, kind, active, key_hash, scopes, rate_limit, key_expires_at, ip_allow[], origins[]}]}` и `box_key`.
- **Словари и правила** — `public/js/shared/`:
  - `api-connections.js`: `SCOPES`, `EVENTS`, `KEY_RE`, `webhookUrlProblem`, `slugProblem`, `normalizeSlug`;
  - `service-public.js` — `API_GROUPS`;
  - `consultation-price.js` — `CONSULT_API_KINDS`;
  - `clinic-profile.js` — `composeAddress`;
  - `geo-codes.js` — коды без названий;
  - `specialty-list.js` — `SPECIALTY_ROWS` (120 строк со слагами);
  - названия географии — `server/db/migrations/132_geography_names.sql`.
- **Отпечаток ключа** — `server/services/api/secret-box.js` `keyHash` (SHA-256 hex) — тот, что хранит шаг 7.
- **Стенды тестов:**
  - `server/test-helpers/api-booking-seed.js` `bookingSeed`: подключение med24.uz с правами без «Отмены записи» и ключом на год от **сегодня** — сквозной прогон в 2030 году ставит все права и снимает срок;
  - `localAt`;
  - `tmpdir.js` (`tmpDir`, `closeOnExit`), `fake-png.js`;
  - `control-plane/server/test-helpers/listen.js` — «плохие» порты fetch на этой машине.
- **Выпуск программы** — `scripts/build-bundle.mjs`: `ALLOWLIST` — `server`, `public`, `phone`, `install`, `package*.json`, `node_modules`. Новая папка в выпуск не попадает.
- **`node_modules` корня** — express 5.2.1, better-sqlite3 13 (собран для Windows); `control-plane/` своих модулей не держит (README).

---

## Правила рабочего дерева (читать до первого шага)

**Дерево** назначает контролёр:
- ветка `feat/clinic-api-step8b` от основной линии (`d6f4f9f3` или новее);
- клон с `core.autocrlf=false` и своей копией `node_modules`, как `easymed.api7`;
- ветку не переключать; worktree не создавать — он стирает `node_modules` (память `node-modules-fragility-easymed-local`);
- запущенные серверы (:8000, :8712) и каталог `data/` не трогать.

**Два сборщика в одном клоне** (см. «Порядок»):
- Все файлы плана — новые, и у каждого один хозяин-сборщик. Общих файлов у сборщиков нет.
- `public-server/server/routes/partner.js` создаёт и меняет только сборщик Б (задачи 9 и 10).
- Если в клоне работают сборщики другого шага, свой коммит собирается только из своих файлов — `git add <файл>` по одному.
- Свои строки в чужом файле в этом плане не понадобятся. Если всё же понадобятся — точным блобом, как в плане 8a: `scratchpad/exact-blob.mjs`, или `keep-hunks-v2.mjs` по метке `PUBLIC_SERVER_V1` (память `easymed-shared-tree-hunk-commits`).

**Перед каждым коммитом:**
1. `git status --short`.
2. `git diff --cached --name-only` пуст. Если нет — кто-то собирает коммит: подождать, ничего не снимать.
3. `git add` — **только файлы задачи, поимённо**.

**Запрещено:**
- `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`;
- `npm install` в `public-server/` — модули берутся от корня (README `control-plane/`);
- пушить и ставить тег — это делает контролёр.

**Файлы и коммиты:**
- Файлы — LF. Проверка: `git diff --cached --stat`, и `git ls-files --eol public-server` показывает `i/lf`.
- Файл задачи кладётся **целиком** блоком плана (Write).
- Изменение существующего файла (одно — задача 10, свой же `partner.js`):
  1. записать diff в файл;
  2. `git apply --check <файл>`, затем `git apply <файл>`.
- Сообщение коммита:
  - пишется Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/step8b-<N>.txt`, затем `git commit -F <файл>`;
  - по-русски; первая строка — текст коммита из задачи с хвостом `(PUBLIC_SERVER_V1, CLINIC_API_STEP8B_V1)`; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- В коммит — только названные файлы задачи.

**Тесты:**
- Только явными путями, из корня клона: `node --test <файлы>`. Каталог аргументом не передавать (Node 24 на Windows).
- Каждый раз — дважды:
  - как есть;
  - как CI на en-US: `node --import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs --test <файлы>`. Нет файла — восстановить: `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });` (память `easymed-ci-locale-trap`).
- `LIS_ENABLED=0` — в командах задачи 12: она поднимает модули клиники, хотя приём анализаторов и не трогает. На полный прогон его не ставить — см. «Завершение».
- **Порты:** ни одного настоящего порта. Сервер в тестах — только `listen()` из `control-plane/server/test-helpers/listen.js` (случайный порт без «плохих» для fetch; память `windows-dynamic-port-fetch-bad-port`). `index.js` в тестах не запускается.
- **Время:** подставное — 2030 год (`NOW` стенда). Сквозной прогон берёт смещение пояса процесса, потому что клиника в том же процессе считает дни в нём.
- **Ключи:** только выпущенные во время теста (`newApiKey`) или строки с `TESTONLY` (страж `server/services/api/no-real-api-keys.test.js`).
- Каждая задача кончается своими тестами и стражами:
  - `node --test server/services/api/no-real-api-keys.test.js`;
  - `node --test server/test-helpers/no-test-helpers-in-production.test.js`;
  - с задачи 1 — ещё `node --test public-server/server/not-shipped.test.js scripts/build-bundle.test.js`.
- **Полный прогон** делает контролёр («Завершение»).

**Текст:**
- Сообщения сервера — коды и тексты словаря `lib/errors.js` (ru / uz / en; узбекский и английский — без кириллицы, узбекский апостроф — `‘`).
- Словарь программы `i18n-strings.js` этот план **не трогает**: экранов в 8b нет.
- В журнал процесса — только коды, типы ошибок и стеки без первой строки (`safeStack`). Никогда — тело, запрос, `err.message` (страж задачи 12).

---

## Порядок и два сборщика

**Сборщик А — ядро и протокол** (задачи 0–5, 11, 12): каркас, личность клиники, клиники, заявки и очередь, канал клиники, приложение и фон, сквозной прогон и стражи.

**Сборщик Б — партнёры и уведомления** (задачи 6–10): лимиты и адреса, справочники и время, доставка уведомлений, вход партнёра и чтение, заявки от партнёров.

Столбец «Нужны до начала» — что должно быть **закоммичено** до начала задачи.

| Задача | Сборщик | Нужны до начала |
|---|---|---|
| 0 План в репозиторий | А | — |
| 1 Каркас службы | А | 0 |
| 2 Личность клиники и лицензия | А | 1 |
| 3 Клиники: лицензия, ключи, снимок, имя в адресе, время, файлы | А | 2 |
| 4 Заявки и очередь | А | 3 |
| 5 Канал клиники `/_sync/v1` | А | 4 |
| 6 Лимиты и адреса | Б | 1 |
| 7 Справочники и свободное время | Б | 1 |
| 8 Уведомления: отправка и доставка | Б | 4, 6 |
| 9 Вход партнёра и чтение | Б | 3, 4, 6, 7 |
| 10 Заявки и онлайн-запись от партнёров | Б | 9 |
| 11 Приложение, фон, наблюдение, запуск, `DEPLOY.md` | А | 5, 8, 10 |
| 12 Сквозной прогон с настоящей клиникой и стражи | А | 11 |

Работа идёт так:
- Б начинает задачи 6 и 7, как только закоммичена задача 1; задачи 8 и 9 — после задач 3 и 4 сборщика А.
- А тем временем делает задачи 2–5, затем ждёт задачу 10 и собирает приложение (11) и сквозной прогон (12).

---

## Task 0: План в репозиторий

Сборщик А.

**Files:**
- Create: `docs/plans/2026-10-11-clinic-api-8b-public-server.md` — копия этого файла (LF).

- [ ] **Step 1:** скопировать файл.
- [ ] **Step 2: коммит** «План шага 8b API клиники: публичный сервер api.easymed.uz — служба public-server/, протокол клиники 8a, адреса партнёров, лицензия и 503, запечатанные заявки со стиранием при приёме, доставка уведомлений, два сборщика».

---

## Task 1: Каркас службы — package.json, настройки, база и страж схемы, время, ошибки (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/package.json`
- Create: `public-server/server/config.js`, `public-server/server/config.test.js`
- Create: `public-server/server/db/connection.js`, `public-server/server/db/migrate.js`, `public-server/server/db/migrations/001_public_server.sql`, `public-server/server/db/schema.test.js`
- Create: `public-server/server/lib/time.js`, `public-server/server/lib/time.test.js`
- Create: `public-server/server/lib/errors.js`, `public-server/server/lib/errors.test.js`
- Create: `public-server/server/not-shipped.test.js`

- [ ] **Step 1: `package.json`** `public-server/package.json`:

```json
{
  "name": "easymed-public-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "start": "node server/index.js",
    "test": "node --experimental-vm-modules --test"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.2",
    "express": "^5.2.1"
  }
}
```

`npm install` здесь **не запускать**: модули берутся от корня.

- [ ] **Step 2: падающие тесты** — пять файлов.

`public-server/server/config.test.js`:

```js
// PUBLIC_SERVER_V1 — настройки: умолчания для работы за nginx на той же
// машине, переопределение переменными, неверное значение — отказ запуска.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readConfig, DEFAULT_UNCOLLECTED_MAX_HOURS, DEFAULT_SYNC_SKEW_MIN } from './config.js';

const ROOT = path.resolve('/srv/public-server');

test('умолчания: слушает только 127.0.0.1:8095, за nginx (loopback), только https, Ташкент UTC+5', () => {
  const c = readConfig({}, { root: ROOT });
  assert.equal(c.port, 8095);
  assert.equal(c.bind, '127.0.0.1');
  assert.equal(c.dataDir, path.join(ROOT, 'data'));
  assert.equal(c.baseUrl, 'https://api.easymed.uz');
  assert.equal(c.trustProxy, 'loopback');
  assert.equal(c.requireHttps, true);
  assert.equal(c.offsetMin, 300);
  assert.equal(c.syncSkewMs, 15 * 60000);
  assert.equal(c.uncollectedMaxMs, 24 * 3600000);
  assert.deepEqual(c.selfIps, []);
  assert.equal(c.metricsToken, '');
  assert.equal(c.webhooks, true);
  assert.equal(c.licenceKeyPath, '');
});

test('переопределение переменными окружения', () => {
  const c = readConfig({
    PUBLIC_PORT: '9001', PUBLIC_BIND: '0.0.0.0', PUBLIC_DATA_DIR: '/var/lib/easymed-public', PUBLIC_BASE_URL: 'https://api.test/',
    PUBLIC_TRUST_PROXY: '0', PUBLIC_REQUIRE_HTTPS: '0', PUBLIC_TZ_OFFSET_MIN: '0', PUBLIC_SYNC_SKEW_MIN: '60', PUBLIC_UNCOLLECTED_MAX_HOURS: '48',
    PUBLIC_SELF_IPS: '45.77.242.169, 10.0.0.5', PUBLIC_METRICS_TOKEN: 'm', PUBLIC_WEBHOOKS: '0', PUBLIC_LICENCE_PUBLIC_KEY: '/etc/k.pem',
  }, { root: ROOT });
  assert.equal(c.port, 9001);
  assert.equal(c.bind, '0.0.0.0');
  assert.equal(c.dataDir, path.resolve('/var/lib/easymed-public'));
  assert.equal(c.baseUrl, 'https://api.test');
  assert.equal(c.trustProxy, false);
  assert.equal(c.requireHttps, false);
  assert.equal(c.offsetMin, 0);
  assert.equal(c.syncSkewMs, 3600000);
  assert.equal(c.uncollectedMaxMs, 48 * 3600000);
  assert.deepEqual(c.selfIps, ['45.77.242.169', '10.0.0.5']);
  assert.equal(c.metricsToken, 'm');
  assert.equal(c.webhooks, false);
  assert.equal(c.licenceKeyPath, '/etc/k.pem');
});

test('неверное значение — отказ с именем переменной', () => {
  assert.throws(() => readConfig({ PUBLIC_PORT: 'восемь' }, { root: ROOT }), /PUBLIC_PORT/);
  assert.throws(() => readConfig({ PUBLIC_TZ_OFFSET_MIN: '5000' }, { root: ROOT }), /PUBLIC_TZ_OFFSET_MIN/);
  assert.throws(() => readConfig({ PUBLIC_BASE_URL: 'api.easymed.uz' }, { root: ROOT }), /PUBLIC_BASE_URL/);
  assert.throws(() => readConfig({ PUBLIC_UNCOLLECTED_MAX_HOURS: '0' }, { root: ROOT }), /PUBLIC_UNCOLLECTED_MAX_HOURS/);
});

test('сроки владельца и контролёра — именованные постоянные, одно место на каждый', () => {
  // Решение владельца 20 (2026-10-12): не забранная клиникой заявка ждёт сутки,
  // затем закрыта для партнёра (closed / not_collected), шифротекст стёрт.
  assert.equal(DEFAULT_UNCOLLECTED_MAX_HOURS, 24);
  // Решение контролёра (2026-10-12): допуск часов клиники — 15 минут.
  assert.equal(DEFAULT_SYNC_SKEW_MIN, 15);
});
```

`public-server/server/db/schema.test.js`:

```js
// PUBLIC_SERVER_V1 — страж схемы: в базе публичного сервера нет колонок для
// данных пациента, ключей и секретов. Каждая колонка каждой таблицы — по
// списку; новая колонка требует правки списка (и мысли, что в ней будет).
// Данные пациента — только inbox.sealed (шифротекст), см. 001_public_server.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

const EXPECTED = {
  clinics: ['clinic_id', 'slug', 'key_fp', 'box_key', 'licence_issued_at', 'licence_valid_until', 'licence_subscription',
    'first_seen_at', 'last_seen_at', 'keys_at', 'snapshot', 'snapshot_at', 'slots', 'slots_at'],
  slug_aliases: ['slug', 'clinic_id', 'until_at'],
  connections: ['clinic_id', 'id', 'kind', 'active', 'key_hash', 'scopes', 'rate_limit', 'key_expires_at', 'ip_allow', 'origins', 'last_used_at'],
  media: ['clinic_id', 'sha256', 'ext', 'bytes', 'stored_at'],
  requests: ['id', 'clinic_id', 'connection_id', 'kind', 'external_id', 'doctor_id', 'branch_id', 'service_id', 'package_id',
    'consultation', 'start_at', 'duration_min', 'status', 'reason', 'hold_until', 'offered_start', 'offer_until',
    'cancel_requested_at', 'created_at', 'delivered_at', 'answered_at', 'updated_at'],
  inbox: ['cursor', 'clinic_id', 'type', 'request_id', 'connection_id', 'received_at', 'data', 'sealed'],
  events_seen: ['clinic_id', 'seq', 'received_at'],
  deliveries: ['id', 'clinic_id', 'connection_id', 'request_id', 'event_id', 'event', 'url', 'body', 'signature', 'attempts',
    'state', 'next_at', 'last_code', 'last_error', 'created_at', 'updated_at'],
  delivery_log: ['id', 'clinic_id', 'delivery_id', 'connection_id', 'request_id', 'event_id', 'event', 'attempt', 'code',
    'error', 'at', 'next_at', 'final'],
  access_log: ['id', 'clinic_id', 'connection_id', 'at', 'method', 'path', 'status', 'ip', 'ms'],
  schema_migrations: ['name', 'applied_at'],
};

test('миграции ложатся на пустую базу и повторно ничего не делают', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db);
  assert.deepEqual(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name), ['001_public_server.sql']);
  assert.equal(db.pragma('secure_delete', { simple: true }), 1, 'стёртое затирается');
  db.close();
});

test('каждая таблица — ровно со своими колонками; колонок пациента, ключа и секрета нет', () => {
  const db = openDb(':memory:');
  migrate(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, Object.keys(EXPECTED).sort());
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.deepEqual(cols, EXPECTED[t], t);
    if (t === 'schema_migrations') continue;
    for (const c of cols) {
      assert.ok(!/patient|name$|phone|comment|secret|password|token|^key$|api_key/i.test(c) || c === 'key_hash' || c === 'key_fp',
        t + '.' + c + ' похоже на поле пациента, ключа или секрета');
    }
  }
  db.close();
});
```

`public-server/server/lib/time.test.js`:

```js
// PUBLIC_SERVER_V1 — местное время клиники для партнёров (UTC+5) и обратно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localParts, addDays, minutesOf, hhmmOf, localMsOf, partnerTime, msOf, isoOf, msOfPartner } from './time.js';

const T = Date.parse('2030-03-12T05:00:00Z');   // 10:00 в Ташкенте

test('мгновение → местные дата и время Ташкента', () => {
  assert.deepEqual(localParts(T, 300), { date: '2030-03-12', hhmm: '10:00', minutes: 600, seconds: 0 });
  assert.deepEqual(localParts(Date.parse('2030-03-11T20:30:00Z'), 300).date, '2030-03-12', 'после 19:00 UTC — уже завтра');
  assert.equal(partnerTime('2030-03-12T05:00:00Z', 300), '2030-03-12T10:00:00+05:00');
  assert.equal(partnerTime('', 300), null);
});

test('местные дата и время → мгновение (обратно)', () => {
  assert.equal(localMsOf('2030-03-12', '10:00', 300), T);
  assert.equal(isoOf(localMsOf('2030-03-12', '10:00', 0)), '2030-03-12T10:00:00Z');
});

test('время партнёра: со смещением — как есть; без смещения — Ташкент, не пояс сервера; мусор — null', () => {
  assert.equal(msOfPartner('2030-03-12T10:00:00+05:00', 300), T);
  assert.equal(msOfPartner('2030-03-12T05:00:00Z', 300), T);
  assert.equal(msOfPartner('2030-03-12T10:00', 300), T);
  assert.equal(msOfPartner('2030-03-12T10:00:00', 300), T);
  for (const bad of ['2030-03-12', '2030-02-30T10:00', '2030-03-12T25:00', 'завтра', '', null, '1700000000000']) {
    assert.equal(msOfPartner(bad, 300), null, String(bad));
  }
});

test('дни и минуты', () => {
  assert.equal(addDays('2030-02-27', 2), '2030-03-01');
  assert.equal(addDays('2030-12-31', 1), '2031-01-01');
  assert.equal(minutesOf('08:15'), 495);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf('8:15'), null);
  assert.equal(hhmmOf(495), '08:15');
  assert.equal(msOf('нет'), null);
});
```

`public-server/server/lib/errors.test.js`:

```js
// PUBLIC_SERVER_V1 — словарь ошибок: у каждого кода статус и три языка;
// узбекский и английский — без кириллицы; стек без сообщения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, sendError, safeStack, langOf } from './errors.js';

test('у каждого кода — статус и текст на ru / uz / en; uz и en без кириллицы', () => {
  for (const [code, e] of Object.entries(ERRORS)) {
    assert.ok(e.status >= 400 && e.status < 600, code);
    for (const l of ['ru', 'uz', 'en']) assert.ok(String(e[l] || '').length > 3, code + ' ' + l);
    assert.ok(!/[а-яё]/i.test(e.uz) && !/[а-яё]/i.test(e.en), code + ': кириллица в uz/en');
  }
  for (const c of ['slot_taken', 'rate_limited', 'licence_lapsed', 'forbidden_scope', 'invalid_key', 'not_found', 'invalid_field']) assert.ok(ERRORS[c], c);
});

test('ответ ошибкой: код, текст на языке ?lang, поля сверх кода, заголовки', () => {
  const sent = {};
  const res = {
    set(k, v) { sent.headers = { ...(sent.headers || {}), [k]: v }; return this; },
    status(s) { sent.status = s; return this; },
    json(b) { sent.body = b; return this; },
  };
  sendError({ query: { lang: 'uz' } }, res, 'rate_limited', {}, { 'Retry-After': 7 });
  assert.equal(sent.status, 429);
  assert.equal(sent.headers['Retry-After'], '7');
  assert.equal(sent.body.error.code, 'rate_limited');
  assert.equal(sent.body.error.message, ERRORS.rate_limited.uz);
  sendError({ query: {} }, res, 'invalid_field', { field: 'start', reason: 'past' });
  assert.deepEqual(sent.body.error, { code: 'invalid_field', message: ERRORS.invalid_field.ru, field: 'start', reason: 'past' });
  sendError({ query: {} }, res, 'нет такого');
  assert.equal(sent.status, 500);
  assert.equal(sent.body.error.code, 'internal');
  assert.equal(langOf({ query: { lang: 'EN' } }), 'en');
  assert.equal(langOf({ query: { lang: 'de' } }), null);
});

test('стек без первой строки — сообщение с присланным в журнал не попадает', () => {
  let err;
  try { JSON.parse('{"name":"ИМЯ_ПАЦИЕНТА"'); } catch (e) { err = e; }
  assert.ok(String(err.message).length > 0);
  assert.ok(!safeStack(err).includes('ИМЯ_ПАЦИЕНТА'));
});
```

`public-server/server/not-shipped.test.js`:

```js
// PUBLIC_SERVER_V1 — публичный сервер — служба Easy-Med, а не часть программы
// клиники: выпуск программы (scripts/build-bundle.mjs, разрешающий список) его
// не берёт, и клиники его не получают.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectEntries, ALLOWLIST } from '../../scripts/build-bundle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('выпуск программы клиники не берёт public-server/', () => {
  assert.ok(!ALLOWLIST.includes('public-server'));
  assert.ok(!selectEntries(REPO).includes('public-server'));
});
```

- [ ] **Step 3:** `node --test public-server/server/config.test.js public-server/server/db/schema.test.js public-server/server/lib/time.test.js public-server/server/lib/errors.test.js public-server/server/not-shipped.test.js` → четыре файла падают: `ERR_MODULE_NOT_FOUND` (`config.js`, `connection.js`, `time.js`, `errors.js`). `not-shipped.test.js` — зелёный сразу: он закрепляет, что выпуск программы не возьмёт новую папку.

- [ ] **Step 4: модули.**

`public-server/server/config.js`:

```js
// PUBLIC_SERVER_V1 — настройки публичного сервера: только из переменных
// окружения (systemd-служба задаёт их в EnvironmentFile, DEPLOY.md). Неверное
// значение — отказ запуска с именем переменной, а не тихое умолчание.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Сроки, выбранные владельцем и контролёром (2026-10-12), — одно место на
// каждый; переменная окружения меняет его без правки кода:
//   • DEFAULT_UNCOLLECTED_MAX_HOURS — решение владельца 20: онлайн-запись или
//     «перезвоните», которую клиника не забрала, ждёт сутки; потом заявка
//     закрыта для партнёра (closed / not_collected), шифротекст стёрт
//     (store/requests.js closeOverdue). Переменная PUBLIC_UNCOLLECTED_MAX_HOURS.
//     Отдельное правило «клиника молчит 7 суток — партнёрам 503» этим не
//     меняется (routes/partner-auth.js).
//   • DEFAULT_SYNC_SKEW_MIN — решение контролёра: часы клиники не дальше
//     15 минут от сервера (clinic-auth.js). Переменная PUBLIC_SYNC_SKEW_MIN.
export const DEFAULT_UNCOLLECTED_MAX_HOURS = 24;
export const DEFAULT_SYNC_SKEW_MIN = 15;

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: ожидается целое число от ${min} до ${max}`);
  return n;
}

function trustProxyOf(raw) {
  const s = String(raw == null ? 'loopback' : raw).trim();
  if (s === '' || s === '0' || s === 'false') return false;
  return s;
}

/**
 * @returns {{port:number, bind:string, dataDir:string, baseUrl:string, licenceKeyPath:string, trustProxy:(string|false),
 *   requireHttps:boolean, offsetMin:number, syncSkewMs:number, uncollectedMaxMs:number, selfIps:string[], metricsToken:string,
 *   webhooks:boolean}}
 */
export function readConfig(env = process.env, { root = SERVICE_ROOT } = {}) {
  const dataRaw = String(env.PUBLIC_DATA_DIR || '').trim();
  const base = String(env.PUBLIC_BASE_URL || 'https://api.easymed.uz').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(base)) throw new Error('PUBLIC_BASE_URL: ожидается адрес вида https://api.easymed.uz');
  return {
    port: int(env, 'PUBLIC_PORT', 8095, 1, 65535),
    bind: String(env.PUBLIC_BIND || '127.0.0.1').trim(),
    dataDir: dataRaw ? path.resolve(root, dataRaw) : path.join(root, 'data'),
    baseUrl: base,
    licenceKeyPath: String(env.PUBLIC_LICENCE_PUBLIC_KEY || '').trim(),
    trustProxy: trustProxyOf(env.PUBLIC_TRUST_PROXY),
    requireHttps: String(env.PUBLIC_REQUIRE_HTTPS ?? '1').trim() !== '0',
    offsetMin: int(env, 'PUBLIC_TZ_OFFSET_MIN', 300, -720, 840),
    syncSkewMs: int(env, 'PUBLIC_SYNC_SKEW_MIN', DEFAULT_SYNC_SKEW_MIN, 1, 1440) * 60000,
    uncollectedMaxMs: int(env, 'PUBLIC_UNCOLLECTED_MAX_HOURS', DEFAULT_UNCOLLECTED_MAX_HOURS, 1, 720) * 3600000,
    selfIps: String(env.PUBLIC_SELF_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    metricsToken: String(env.PUBLIC_METRICS_TOKEN || '').trim(),
    webhooks: String(env.PUBLIC_WEBHOOKS ?? '1').trim() !== '0',
  };
}
```

`public-server/server/db/connection.js`:

```js
// PUBLIC_SERVER_V1 — одна база на процесс (better-sqlite3, как control-plane/).
//
//   • WAL — много читающих и один пишущий: партнёры читают, клиники пишут.
//   • secure_delete — стёртая строка очереди (шифротекст данных пациента)
//     затирается нулями на странице базы, а не остаётся «свободным местом»
//     до перезаписи (решение владельца 16: меньше данных — меньше риска).
//   • busy_timeout — короткое ожидание замка вместо мгновенной ошибки.
import Database from 'better-sqlite3';

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.pragma('busy_timeout = 2000');
  return db;
}
```

`public-server/server/db/migrate.js`:

```js
// PUBLIC_SERVER_V1 — миграции публичного сервера: те же правила, что у
// control-plane/server/db/migrate.js (имя NNN_имя.sql, номер не повторяется,
// каждый файл — в своей транзакции). Своя копия, а не импорт: публичный сервер
// и сервер лицензий — разные службы, и общего кода о базе у них нет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const NAME_RE = /^\d{3,}_[\w.-]+\.sql$/;

function files(dir) {
  const list = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Map();
  for (const f of list) {
    if (!NAME_RE.test(f)) throw new Error('Bad migration filename (expected NNN_name.sql): ' + f);
    const n = Number(f.slice(0, f.indexOf('_')));
    if (seen.has(n)) throw new Error('Duplicate migration number: ' + seen.get(n) + ' and ' + f);
    seen.set(n, f);
  }
  return list;
}

export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const f of files(dir)) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    })();
  }
}
```

`public-server/server/db/migrations/001_public_server.sql`:

```sql
-- PUBLIC_SERVER_V1 — публичный сервер api.easymed.uz (шаг 8b API клиники).
--
-- ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ (дизайн шага 8, §1; решения владельца 5 и 16):
--   • имени, телефона, комментария пациента открытым текстом — данные
--     пациента лежат ТОЛЬКО в inbox.sealed, запечатанными ключом-ящиком
--     клиники (сервер их открыть не может), и строка очереди стирается целиком,
--     как только клиника подтвердила курсор;
--   • ключей API и секретов вебхуков — только SHA-256 ключа (connections.key_hash);
--   • install_token клиники, карт пациентов, визитов, сотрудников (кроме
--     показанных врачей в снимке).
-- Страж: server/db/schema.test.js сверяет колонки каждой таблицы со списком.

-- Клиника: личность — из подписанной лицензии (самой новой из виденных),
-- снимок и время — последние присланные.
CREATE TABLE clinics (
  clinic_id            TEXT PRIMARY KEY,
  slug                 TEXT,
  key_fp               TEXT NOT NULL,
  box_key              TEXT,
  licence_issued_at    TEXT,
  licence_valid_until  TEXT,
  licence_subscription TEXT NOT NULL DEFAULT 'active' CHECK (licence_subscription IN ('active', 'unpaid')),
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  keys_at              TEXT,
  snapshot             TEXT,
  snapshot_at          TEXT,
  slots                TEXT,
  slots_at             TEXT
);
CREATE UNIQUE INDEX clinics_slug ON clinics (slug) WHERE slug IS NOT NULL;

-- Прежнее имя в адресе работает 30 дней после смены (макет «API и подключения»).
CREATE TABLE slug_aliases (
  slug      TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  until_at  TEXT NOT NULL
);

-- Подключения клиники (быстрый канал PUT /keys): отпечаток ключа, права, лимиты.
CREATE TABLE connections (
  clinic_id      TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  id             INTEGER NOT NULL CHECK (id > 0),
  kind           TEXT NOT NULL,
  active         INTEGER NOT NULL CHECK (active IN (0, 1)),
  key_hash       TEXT NOT NULL CHECK (length(key_hash) = 64),
  scopes         TEXT NOT NULL DEFAULT '[]',
  rate_limit     INTEGER NOT NULL CHECK (rate_limit > 0),
  key_expires_at TEXT,
  ip_allow       TEXT NOT NULL DEFAULT '[]',
  origins        TEXT NOT NULL DEFAULT '[]',
  last_used_at   TEXT,
  PRIMARY KEY (clinic_id, id)
);
CREATE UNIQUE INDEX connections_key ON connections (clinic_id, key_hash);

-- Файлы снимка (логотипы, фото показанных врачей): байты — на диске, по отпечатку.
CREATE TABLE media (
  clinic_id TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  sha256    TEXT NOT NULL CHECK (length(sha256) = 64),
  ext       TEXT NOT NULL CHECK (ext IN ('png', 'jpg', 'jpeg', 'webp')),
  bytes     INTEGER NOT NULL,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (clinic_id, sha256)
);

-- Заявка партнёра — статус для GET /requests/{id}, БЕЗ данных пациента; живёт 90 дней.
CREATE TABLE requests (
  id                  TEXT PRIMARY KEY,
  clinic_id           TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  connection_id       INTEGER NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('request', 'appointment')),
  external_id         TEXT,
  doctor_id           INTEGER,
  branch_id           INTEGER,
  service_id          INTEGER,
  package_id          INTEGER,
  consultation        TEXT,
  start_at            TEXT,
  duration_min        INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('new', 'accepted', 'pending', 'offered', 'booked', 'declined',
                        'expired', 'cancelled', 'arrived', 'no_show', 'closed')),
  reason              TEXT,
  hold_until          TEXT,
  offered_start       TEXT,
  offer_until         TEXT,
  cancel_requested_at TEXT,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  answered_at         TEXT,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX requests_external ON requests (clinic_id, connection_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX requests_status ON requests (clinic_id, status);

-- Очередь заявок клинике (GET /_sync/v1/inbox). sealed — данные пациента,
-- запечатанные box_key клиники; строка стирается при подтверждении курсора.
CREATE TABLE inbox (
  cursor        INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL REFERENCES clinics (clinic_id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('request.new', 'appointment.new', 'appointment.cancel', 'offer.accept', 'offer.decline')),
  request_id    TEXT NOT NULL,
  connection_id INTEGER NOT NULL,
  received_at   TEXT NOT NULL,
  data          TEXT NOT NULL DEFAULT '{}',
  sealed        TEXT
);
CREATE INDEX inbox_clinic ON inbox (clinic_id, cursor);

-- Принятые события клиники (POST /_sync/v1/events) — повтор того же seq ничего не меняет.
CREATE TABLE events_seen (
  clinic_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (clinic_id, seq)
);

-- Уведомления партнёрам: тело и подпись — готовые от клиники (данных пациента нет);
-- тело стирается, как только доставка кончилась (доставлено или попытки вышли).
CREATE TABLE deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL,
  connection_id INTEGER,
  request_id    TEXT,
  event_id      TEXT NOT NULL,
  event         TEXT NOT NULL,
  url           TEXT NOT NULL,
  body          TEXT,
  signature     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  next_at       TEXT,
  last_code     INTEGER,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX deliveries_due ON deliveries (state, next_at);

-- Журнал доставок для клиники (8d — вкладка «Уведомления»): попытка за попыткой, без тел.
CREATE TABLE delivery_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL,
  delivery_id   INTEGER,
  connection_id INTEGER,
  request_id    TEXT,
  event_id      TEXT,
  event         TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  code          INTEGER,
  error         TEXT,
  at            TEXT NOT NULL,
  next_at       TEXT,
  final         TEXT
);
CREATE INDEX delivery_log_clinic ON delivery_log (clinic_id, id);

-- Журнал запросов партнёров (30 дней): метод, путь без лишнего, ответ — без тел.
CREATE TABLE access_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id     TEXT NOT NULL,
  connection_id INTEGER,
  at            TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INTEGER NOT NULL,
  ip            TEXT,
  ms            INTEGER
);
CREATE INDEX access_log_clinic ON access_log (clinic_id, id);
CREATE INDEX access_log_at ON access_log (at);
```

`public-server/server/lib/time.js`:

```js
// PUBLIC_SERVER_V1 — время для партнёров: местное время клиники со смещением
// (документация API: «время — Ташкент, UTC+5»). Смещение — настройка
// PUBLIC_TZ_OFFSET_MIN (300); тесты ставят смещение своего процесса, потому что
// клиника в том же процессе считает дни и часы в нём. Внутри — мгновения UTC.
import { isoOf, localIso } from '../../../public/js/shared/api-booking.js';

export { isoOf, localIso };

const p2 = (n) => String(n).padStart(2, '0');

/** Мгновение из строки; неверное — null. */
export const msOf = (v) => { const t = Date.parse(String(v == null ? '' : v)); return Number.isFinite(t) ? t : null; };

/** Местные дата, 'ЧЧ:ММ' и минуты от полуночи мгновения ms. */
export function localParts(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
    minutes,
    seconds: d.getUTCSeconds(),
  };
}

/** 'YYYY-MM-DD' + n дней. */
export function addDays(dayIso, n) {
  const [y, m, d] = String(dayIso).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

/** 'ЧЧ:ММ' → минуты от полуночи; неверное — null. */
export function minutesOf(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Минуты от полуночи → 'ЧЧ:ММ'. */
export const hhmmOf = (minutes) => `${p2(Math.floor(minutes / 60))}:${p2(minutes % 60)}`;

/** Местные дата и 'ЧЧ:ММ' → мгновение UTC. */
export function localMsOf(dayIso, hhmm, offsetMin) {
  const [y, m, d] = String(dayIso).split('-').map(Number);
  return Date.UTC(y, m - 1, d) + minutesOf(hhmm) * 60000 - offsetMin * 60000;
}

/**
 * Время от партнёра: со смещением или Z — как есть; без смещения
 * ('2030-03-12T09:00') — местное время клиники (документация: «время —
 * Ташкент»), а не пояс машины сервера. Неверное — null.
 */
export function msOfPartner(v, offsetMin) {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    if (minutesOf(m[2]) == null || Number(m[3] || 0) > 59) return null;
    const t = localMsOf(m[1], m[2], offsetMin) + Number(m[3] || 0) * 1000;
    return localParts(t, offsetMin).date === m[1] ? t : null;
  }
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? msOf(s) : null;
}

/** Мгновение-строка (UTC из базы) → местное со смещением; пусто — null. */
export function partnerTime(iso, offsetMin) {
  const ms = msOf(iso);
  return ms == null ? null : localIso(ms, offsetMin);
}
```

`public-server/server/lib/errors.js`:

```js
// PUBLIC_SERVER_V1 — ОШИБКИ ПУБЛИЧНОГО СЕРВЕРА: код — договор с партнёром и
// клиникой (документация API, «Ошибки и лимиты»), текст — пояснение на языке
// ?lang (по умолчанию русский). Тело ошибки: { error: { code, message, field?, reason? } }.
//
// ЖУРНАЛ БЕЗ ТЕЛ ЗАПРОСОВ (решение владельца 16): в текст ошибки и в журнал
// процесса никогда не попадает присланное — ни тело, ни его кусок. У ошибки
// разбора JSON сообщение содержит кусок тела (Node 24: «Unexpected token … "Иван…"»),
// поэтому журнал пишет только тип ошибки, а стек — без первой строки (safeStack).
export const ERRORS = Object.freeze({
  bad_request:        { status: 400, ru: 'Запрос составлен неверно.', uz: 'So‘rov noto‘g‘ri tuzilgan.', en: 'The request is malformed.' },
  bad_json:           { status: 400, ru: 'Тело запроса — не JSON.', uz: 'So‘rov tanasi JSON emas.', en: 'The request body is not valid JSON.' },
  invalid_field:      { status: 400, ru: 'Поле заполнено неверно — см. field и reason.', uz: 'Maydon noto‘g‘ri to‘ldirilgan — field va reason ga qarang.', en: 'A field is invalid — see field and reason.' },
  https_required:     { status: 400, ru: 'Только HTTPS.', uz: 'Faqat HTTPS.', en: 'HTTPS only.' },
  bad_slug:           { status: 400, ru: 'Имя клиники в адресе записано неверно.', uz: 'Manzildagi klinika nomi noto‘g‘ri yozilgan.', en: 'The clinic name in the address is invalid.' },
  invalid_key:        { status: 401, ru: 'Ключа нет или он неверный.', uz: 'Kalit yo‘q yoki noto‘g‘ri.', en: 'The key is missing or invalid.' },
  key_disabled:       { status: 401, ru: 'Ключ выключен клиникой.', uz: 'Kalit klinika tomonidan o‘chirilgan.', en: 'The key has been disabled by the clinic.' },
  key_expired:        { status: 401, ru: 'Срок действия ключа истёк.', uz: 'Kalitning amal qilish muddati tugagan.', en: 'The key has expired.' },
  invalid_signature:  { status: 401, ru: 'Подпись запроса клиники не сходится.', uz: 'Klinika so‘rovining imzosi mos kelmadi.', en: 'The clinic request signature does not match.' },
  licence_invalid:    { status: 401, ru: 'Лицензия клиники не прошла проверку.', uz: 'Klinika litsenziyasi tekshiruvdan o‘tmadi.', en: 'The clinic licence failed verification.' },
  licence_outdated:   { status: 401, ru: 'Прислана устаревшая лицензия клиники.', uz: 'Klinikaning eskirgan litsenziyasi yuborildi.', en: 'An outdated clinic licence was presented.' },
  clock_skew:         { status: 401, ru: 'Часы компьютера клиники расходятся с сервером.', uz: 'Klinika kompyuterining soati server bilan mos emas.', en: 'The clinic computer clock is out of sync with the server.' },
  forbidden_scope:    { status: 403, ru: 'У ключа нет доступа к этому разделу.', uz: 'Kalitga bu bo‘limga ruxsat berilmagan.', en: 'The key has no access to this section.' },
  ip_not_allowed:     { status: 403, ru: 'Запрос с этого IP-адреса не разрешён для ключа.', uz: 'Bu IP-manzildan so‘rov kalit uchun ruxsat etilmagan.', en: 'Requests from this IP address are not allowed for the key.' },
  origin_not_allowed: { status: 403, ru: 'Запрос с этого сайта не разрешён для ключа.', uz: 'Bu saytdan so‘rov kalit uchun ruxsat etilmagan.', en: 'Requests from this site are not allowed for the key.' },
  not_found:          { status: 404, ru: 'Не найдено или скрыто клиникой.', uz: 'Topilmadi yoki klinika tomonidan yashirilgan.', en: 'Not found or hidden by the clinic.' },
  clinic_not_found:   { status: 404, ru: 'Клиники с таким адресом нет.', uz: 'Bunday manzilli klinika yo‘q.', en: 'No clinic at this address.' },
  slot_taken:         { status: 409, ru: 'Это время уже занято — запросите /slots заново.', uz: 'Bu vaqt band — /slots ni qayta so‘rang.', en: 'This time is already taken — request /slots again.' },
  slug_taken:         { status: 409, ru: 'Это имя в адресе занято другой клиникой.', uz: 'Manzildagi bu nom boshqa klinika tomonidan band.', en: 'This address name is taken by another clinic.' },
  not_cancellable:    { status: 409, ru: 'Эту запись отменить уже нельзя.', uz: 'Bu yozuvni endi bekor qilib bo‘lmaydi.', en: 'This appointment can no longer be cancelled.' },
  not_offered:        { status: 409, ru: 'Клиника не предлагала другое время по этой записи.', uz: 'Klinika bu yozuv bo‘yicha boshqa vaqt taklif qilmagan.', en: 'The clinic has not offered another time for this appointment.' },
  offer_expired:      { status: 409, ru: 'Срок ответа на предложенное время истёк.', uz: 'Taklif qilingan vaqtga javob berish muddati tugagan.', en: 'The time to answer the offered slot has passed.' },
  too_large:          { status: 413, ru: 'Запрос слишком большой.', uz: 'So‘rov juda katta.', en: 'The request is too large.' },
  rate_limited:       { status: 429, ru: 'Превышен лимит запросов — подождите столько секунд, сколько в Retry-After.', uz: 'So‘rovlar chegarasi oshdi — Retry-After dagi soniyalar qadar kuting.', en: 'Rate limit exceeded — wait as many seconds as Retry-After says.' },
  internal:           { status: 500, ru: 'Ошибка сервера.', uz: 'Server xatosi.', en: 'Server error.' },
  licence_lapsed:     { status: 503, ru: 'Клиника временно недоступна. Позвоните в клинику.', uz: 'Klinika vaqtincha mavjud emas. Klinikaga qo‘ng‘iroq qiling.', en: 'The clinic is temporarily unavailable. Please call the clinic.' },
  clinic_offline:     { status: 503, ru: 'Клиника временно недоступна. Позвоните в клинику.', uz: 'Klinika vaqtincha mavjud emas. Klinikaga qo‘ng‘iroq qiling.', en: 'The clinic is temporarily unavailable. Please call the clinic.' },
});

export const LANGS = Object.freeze(['ru', 'uz', 'en']);

/** Язык ответа из ?lang; пусто или чужое — null. */
export function langOf(req) {
  const l = String((req && req.query && req.query.lang) || '').trim().toLowerCase();
  return LANGS.includes(l) ? l : null;
}

/**
 * Ответ ошибкой. extra — поля сверх кода (field, reason, phone, server_time…):
 * только значения, выбранные сервером, — никогда не присланное партнёром.
 */
export function sendError(req, res, code, extra = {}, headers = {}) {
  const e = ERRORS[code] || ERRORS.internal;
  const lang = langOf(req) || 'ru';
  for (const [k, v] of Object.entries(headers)) res.set(k, String(v));
  return res.status(e.status).json({ error: { code: ERRORS[code] ? code : 'internal', message: e[lang], ...extra } });
}

/** Стек без первой строки: сообщение ошибки может нести кусок присланного. */
export function safeStack(err) {
  return String((err && err.stack) || '').split('\n').slice(1, 8).join('\n');
}

/**
 * Последний обработчик express: разбор JSON и размер тела — ошибка партнёра с
 * кодом; прочее — 500. В журнал — только тип, код и стек без сообщения.
 */
export function errorHandler(log = console) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return sendError(req, res, 'bad_json');
    if (err && err.type === 'entity.too.large') return sendError(req, res, 'too_large');
    const status = Number(err && (err.status || err.statusCode));
    if (status >= 400 && status < 500) {
      log.warn('[public-server] client error', status, (err && (err.type || err.code)) || '');
      return sendError(req, res, 'bad_request');
    }
    log.error('[public-server] server error', (err && err.name) || 'Error', (err && err.code) || '', '\n' + safeStack(err));
    return sendError(req, res, 'internal');
  };
}
```

- [ ] **Step 5:** команда шага 3 → зелёная, **13 тестов**; то же с `--import …force-en.mjs`. Сторожа: `node --test server/services/api/no-real-api-keys.test.js server/test-helpers/no-test-helpers-in-production.test.js scripts/build-bundle.test.js`.
- [ ] **Step 6: коммит** «Публичный сервер, каркас: служба public-server/ со своим package.json (модули — от корня, как control-plane), настройки из окружения с отказом запуска на неверном, база SQLite с затиранием стёртого и стражем колонок (данных пациента, ключей и секретов нет), местное время Ташкента для партнёров, словарь ошибок ru/uz/en без тел в журнале; выпуск программы клиники службу не берёт».

---

## Task 2: Личность клиники и лицензия — шов 8c «не оплачено», проверка подписи, стенд тестов (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/licence-gate.js`, `public-server/server/licence-gate.test.js`
- Create: `public-server/server/clinic-auth.js`, `public-server/server/clinic-auth.test.js`
- Create: `public-server/server/test-helpers/fixture.js`

- [ ] **Step 1: стенд тестов** `public-server/server/test-helpers/fixture.js`. Это свой «производитель» — пара Ed25519 и подпись лицензии тем же `canonical()`, что у программы. Личность клиники — настоящий `sync-identity.js`. Ещё в стенде: подписанные запросы и сервер на случайном порту:

```js
// PUBLIC_SERVER_V1 — стенд тестов публичного сервера: свой «производитель»
// (пара Ed25519 вместо настоящего ключа лицензий), подписанная им лицензия с
// отпечатком ключа клиники (так её подпишет шаг 8c), личность клиники из
// настоящего sync-identity.js, база во временной папке, подписанные запросы
// клиники и сервер на случайном порту (listen — без «плохих» портов fetch).
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { canonical } from '../../../server/services/control/canonical.js';
import { loadSyncIdentity, signRequest, SYNC_KEY_FILE } from '../../../server/services/api/sync-identity.js';
import { tmpDir, closeOnExit } from '../../../server/test-helpers/tmpdir.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { errorHandler } from '../lib/errors.js';

export const CLINIC_ID = 'c-000777';
export const NOW = Date.parse('2030-03-11T04:00:00Z');   // 09:00 в Ташкенте

export function testVendor() {
  return crypto.generateKeyPairSync('ed25519');
}

export function signTestLicence(vendor, payload) {
  const sig = crypto.sign(null, Buffer.from(canonical(payload), 'utf8'), vendor.privateKey).toString('base64');
  return JSON.stringify({ payload, sig });
}

/** Клиника: личность (ключи в своей временной папке) и лицензия с отпечатком её ключа. */
export function testClinic(vendor, { clinicId = CLINIC_ID, validUntil = '2030-04-01T00:00:00Z', issuedAt = '2030-03-10T00:00:00Z',
  subscription = undefined, identity = null } = {}) {
  const id = identity || loadSyncIdentity({ keyPath: path.join(tmpDir('em-pub-clinic-'), SYNC_KEY_FILE), create: true });
  const payload = { clinic_id: clinicId, clinic_name: 'Шифо', modules: [], valid_until: validUntil, issued_at: issuedAt,
    nonce: crypto.randomBytes(4).toString('hex'), api_sync_key: id.fingerprint, ...(subscription ? { subscription } : {}) };
  return { clinicId, identity: id, licence: signTestLicence(vendor, payload), payload };
}

export function testDb() {
  const dir = tmpDir('em-pub-db-');
  const file = path.join(dir, 'public.db');
  const db = openDb(file);
  closeOnExit(db);
  migrate(db);
  return { db, dir, file };
}

/** Заголовки подписанного запроса клиники — ровно как их ставит public-sync.js call(). */
export function signedHeaders(clinic, { method, path: p, body = '', time }) {
  return {
    'Content-Type': 'application/json',
    'X-EasyMed-Clinic': clinic.clinicId,
    'X-EasyMed-Key': clinic.identity.signPublic,
    'X-EasyMed-Time': time,
    'X-EasyMed-Signature': signRequest(clinic.identity, { method, path: p, time, body }),
    'X-EasyMed-Licence': Buffer.from(clinic.licence, 'utf8').toString('base64'),
  };
}

/** Сервер на случайном порту с одним маршрутизатором и обработчиком ошибок. */
export async function serve(mount, router, { trustProxy = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(mount, router);
  app.use(errorHandler());
  const server = await listen(app);
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/** Подписанный запрос клиники к серверу стенда. body — объект (JSON) или Buffer. */
export async function syncCall(base, clinic, method, p, body, { time, type = 'application/json' } = {}) {
  const raw = body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = { ...signedHeaders(clinic, { method, path: p, body: raw, time }), 'Content-Type': type };
  const res = await fetch(base + p, { method, headers, body: raw === '' ? undefined : raw });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, headers: res.headers };
}
```

- [ ] **Step 2: падающие тесты.**

`public-server/server/licence-gate.test.js`:

```js
// PUBLIC_SERVER_V1 — шов 8c: состояние оплаты из подписанной лицензии.
import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionOf, licenceStanding } from './licence-gate.js';

const NOW = Date.parse('2030-03-11T04:00:00Z');

test('слово оплаты: только явное «unpaid» — неоплата; остальное — «active»', () => {
  assert.equal(subscriptionOf({ subscription: 'unpaid' }), 'unpaid');
  for (const p of [{ subscription: 'active' }, {}, { subscription: 'suspended' }, null]) assert.equal(subscriptionOf(p), 'active');
});

test('состояние: срок вышел — lapsed; «не оплачено» в сроке — unpaid; иначе active', () => {
  assert.equal(licenceStanding({ licence_valid_until: '2030-04-01T00:00:00Z', licence_subscription: 'active' }, NOW), 'active');
  assert.equal(licenceStanding({ licence_valid_until: '2030-04-01T00:00:00Z', licence_subscription: 'unpaid' }, NOW), 'unpaid');
  assert.equal(licenceStanding({ licence_valid_until: '2030-03-11T03:59:59Z', licence_subscription: 'active' }, NOW), 'lapsed');
  assert.equal(licenceStanding({ licence_valid_until: null }, NOW), 'lapsed');
  assert.equal(licenceStanding(null, NOW), 'lapsed');
});
```

`public-server/server/clinic-auth.test.js`:

```js
// PUBLIC_SERVER_V1 — личность клиники: лицензия производителя с отпечатком её
// ключа, время и подпись запроса. Подделка любой части — отказ с кодом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyClinicRequest, keyFingerprint } from './clinic-auth.js';
import { testVendor, testClinic, signedHeaders, NOW } from './test-helpers/fixture.js';

const vendor = testVendor();
const opts = { licencePublicKey: vendor.publicKey, now: NOW };
const time = new Date(NOW).toISOString();
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
const req = (clinic, { method = 'PUT', url = '/_sync/v1/keys', body = '{"a":1}', at = time, headers = {} } = {}) => ({
  method, url, body: Buffer.from(body), headers: { ...lower(signedHeaders(clinic, { method, path: url, body, time: at })), ...headers },
});

test('настоящая клиника: лицензия, отпечаток, время и подпись сходятся', () => {
  const c = testClinic(vendor, { subscription: 'unpaid' });
  const r = verifyClinicRequest(req(c), opts);
  assert.equal(r.ok, true);
  assert.equal(r.clinicId, c.clinicId);
  assert.equal(r.fingerprint, c.identity.fingerprint);
  assert.equal(keyFingerprint(c.identity.signPublic), c.identity.fingerprint, 'отпечаток считается так же, как в клинике');
  assert.deepEqual(r.licence, { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'unpaid' });
  const q = verifyClinicRequest(req(c, { method: 'GET', url: '/_sync/v1/inbox?after=12', body: '' }), opts);
  assert.equal(q.ok, true, 'путь подписан вместе с query, тело пустое');
});

test('подделка любой части — отказ', () => {
  const c = testClinic(vendor);
  const other = testClinic(vendor);
  const strange = testClinic(testVendor());
  const cases = [
    ['чужая подпись производителя', verifyClinicRequest(req(strange), opts), 'licence_invalid'],
    ['лицензия другой клиники', verifyClinicRequest(req(c, { headers: { 'x-easymed-clinic': 'c-000778' } }), opts), 'licence_invalid'],
    ['ключ не тот, что в лицензии', verifyClinicRequest(req(c, { headers: { 'x-easymed-key': other.identity.signPublic } }), opts), 'invalid_signature'],
    ['подменили тело', verifyClinicRequest({ ...req(c), body: Buffer.from('{"a":2}') }, opts), 'invalid_signature'],
    ['подменили путь', verifyClinicRequest({ ...req(c), url: '/_sync/v1/snapshot' }, opts), 'invalid_signature'],
    ['подменили метод', verifyClinicRequest({ ...req(c), method: 'POST' }, opts), 'invalid_signature'],
    ['нет лицензии', verifyClinicRequest(req(c, { headers: { 'x-easymed-licence': '' } }), opts), 'licence_invalid'],
    ['мусор в id клиники', verifyClinicRequest(req(c, { headers: { 'x-easymed-clinic': '../x' } }), opts), 'invalid_signature'],
  ];
  for (const [why, r, code] of cases) assert.deepEqual([why, r.ok, r.code], [why, false, code]);
});

test('часы клиники дальше допуска — clock_skew со временем сервера; в допуске — да', () => {
  const c = testClinic(vendor);
  const late = verifyClinicRequest(req(c, { at: new Date(NOW - 16 * 60000).toISOString() }), opts);
  assert.equal(late.code, 'clock_skew');
  assert.equal(late.server_time, '2030-03-11T04:00:00Z');
  assert.equal(verifyClinicRequest(req(c, { at: new Date(NOW + 14 * 60000).toISOString() }), opts).ok, true);
  assert.equal(verifyClinicRequest(req(c, { at: new Date(NOW - 50 * 60000).toISOString() }), { ...opts, skewMs: 3600000 }).ok, true);
});
```

- [ ] **Step 3:** `node --test public-server/server/licence-gate.test.js public-server/server/clinic-auth.test.js` → падают: `ERR_MODULE_NOT_FOUND` (`licence-gate.js`, `clinic-auth.js`).
- [ ] **Step 4: модули.**

`public-server/server/licence-gate.js`:

```js
// PUBLIC_SERVER_V1 — СОСТОЯНИЕ ЛИЦЕНЗИИ КЛИНИКИ ДЛЯ ПАРТНЁРОВ. ОДНО МЕСТО.
//
// Решение владельца 4: лицензия не продлена — партнёры получают 503.
// Решение владельца 17: и с ПЕРВОЙ отметки «не оплачено» в панели, не дожидаясь
// конца срока. Отметку сервер лицензий вписывает в ПОДПИСАННУЮ лицензию (шаг 8c,
// предложение — payload.subscription: 'active' | 'unpaid'); клиника кладёт
// licence.dat в каждый запрос как есть (8a). Неподписанное слово из control.json
// сюда не доходит и не годится: его клиника могла бы подменить.
//
// ШОВ ДЛЯ 8c: если 8c назовёт поле иначе — меняется ТОЛЬКО subscriptionOf
// (и тест licence-gate.test.js). Неизвестное значение — 'active': называть
// платящую клинику неплательщиком хуже (правило easymed-licence-lockout).
//
//   'active' — партнёры видят клинику;
//   'unpaid' — партнёрам 503, канал клиники /_sync/v1 открыт (события по уже
//              принятым записям должны дойти до партнёров — дизайн §9);
//   'lapsed' — срок лицензии вышел: партнёрам 503 и каналу клиники 503 (§10).
export function subscriptionOf(payload) {
  return payload && payload.subscription === 'unpaid' ? 'unpaid' : 'active';
}

/** @param {{licence_valid_until?:string, licence_subscription?:string}} clinic строка clinics */
export function licenceStanding(clinic, nowMs) {
  const until = Date.parse(String((clinic && clinic.licence_valid_until) || ''));
  if (!Number.isFinite(until) || until <= nowMs) return 'lapsed';
  return clinic.licence_subscription === 'unpaid' ? 'unpaid' : 'active';
}
```

`public-server/server/clinic-auth.js`:

```js
// PUBLIC_SERVER_V1 — КТО ПИШЕТ: проверка запроса клиники к /_sync/v1/*.
//
// Дизайн шага 8, §4 (вариант А) и §10. Заголовки каждого запроса клиники
// (services/api/public-sync.js call()):
//   X-EasyMed-Clinic    — id клиники;
//   X-EasyMed-Time      — ISO-время клиники;
//   X-EasyMed-Key       — открытая половина её ключа подписи Ed25519 (base64 DER SPKI);
//   X-EasyMed-Signature — Ed25519 от «МЕТОД\nПУТЬ+query\nВРЕМЯ\nsha256(тело)»;
//   X-EasyMed-Licence   — base64 licence.dat, байт в байт.
// Порядок проверки — от дешёвого к дорогому, и подпись производителя ДО того,
// как поверить хоть одному полю лицензии:
//   1. лицензия подписана производителем и выдана этой клинике (verifyLicence —
//      тот же код, что в программе клиники);
//   2. отпечаток присланного ключа (первые 32 hex SHA-256 от DER — как его
//      считает sync-identity.js) = payload.api_sync_key лицензии (шаг 8c);
//   3. время клиники не дальше PUBLIC_SYNC_SKEW_MIN от часов сервера — подпись
//      старого запроса нельзя проиграть заново через сутки;
//   4. подпись запроса этим ключом.
// Общих секретов нет; сервер лицензий во время работы не спрашивается.
import crypto from 'node:crypto';
import { verifyLicence } from '../../server/services/control/licence.js';
import { verifyRequest } from '../../server/services/api/sync-identity.js';
import { subscriptionOf } from './licence-gate.js';
import { isoOf } from './lib/time.js';
import { DEFAULT_SYNC_SKEW_MIN } from './config.js';

/** Допуск часов клиники — 15 минут (решение контролёра 2026-10-12; config.js). */
export const DEFAULT_SKEW_MS = DEFAULT_SYNC_SKEW_MIN * 60000;
const CLINIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LICENCE_MAX = 16384;

/** Отпечаток открытого ключа подписи: первые 32 hex SHA-256 от DER (SPKI); не Ed25519 — ''. */
export function keyFingerprint(signPublicB64) {
  try {
    const der = Buffer.from(String(signPublicB64 || ''), 'base64');
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return '';
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  } catch { return ''; }
}

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * @param {{method:string, url:string, headers:object, body:Buffer}} req url — путь с query, как пришёл (originalUrl)
 * @param {{licencePublicKey?:import('node:crypto').KeyObject|null, now:number, skewMs?:number}} opts
 * @returns {{ok:true, clinicId:string, fingerprint:string, licence:{issued_at:string, valid_until:string, subscription:string}}
 *   | {ok:false, code:string, server_time?:string}}
 */
export function verifyClinicRequest({ method, url, headers, body }, { licencePublicKey = null, now, skewMs = DEFAULT_SKEW_MS }) {
  const h = (k) => String((headers && headers[k]) || '');
  const clinicId = h('x-easymed-clinic');
  if (!CLINIC_ID_RE.test(clinicId)) return fail('invalid_signature');
  const lic = h('x-easymed-licence');
  if (!lic || lic.length > LICENCE_MAX) return fail('licence_invalid');
  const v = verifyLicence(Buffer.from(lic, 'base64').toString('utf8'), { publicKey: licencePublicKey, clinicId });
  if (!v.ok) return fail('licence_invalid');
  const fingerprint = keyFingerprint(h('x-easymed-key'));
  if (!fingerprint || v.licence.api_sync_key !== fingerprint) return fail('invalid_signature');
  const time = h('x-easymed-time');
  const t = Date.parse(time);
  if (!Number.isFinite(t) || Math.abs(t - now) > skewMs) return fail('clock_skew', { server_time: isoOf(now) });
  const ok = verifyRequest(h('x-easymed-key'), { method: String(method).toUpperCase(), path: url, time, body: body || Buffer.alloc(0) },
    h('x-easymed-signature'));
  if (!ok) return fail('invalid_signature');
  return {
    ok: true, clinicId, fingerprint,
    licence: {
      issued_at: String(v.licence.issued_at || ''),
      valid_until: String(v.licence.valid_until || ''),
      subscription: subscriptionOf(v.licence),
    },
  };
}
```

- [ ] **Step 5:** команда шага 3 → зелёная, **5 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 6: коммит** «Публичный сервер, личность клиники: лицензия производителя с отпечатком ключа клиники, окно часов ±15 минут и подпись запроса — без общих секретов; состояние оплаты из подписанной лицензии — одна функция (шов для 8c): «не оплачено» — партнёрам 503, канал клиники открыт; срок вышел — 503 всем».

---

## Task 3: Клиники на сервере — самая новая лицензия, ключи отпечатками, снимок и имя в адресе, время, файлы (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/store/clinics.js`, `public-server/server/store/media.js`
- Create: `public-server/server/store/clinics.test.js`

- [ ] **Step 1: падающий тест** `public-server/server/store/clinics.test.js`:

```js
// PUBLIC_SERVER_V1 — клиники: самая новая лицензия решает, ключи заменяются
// целиком (неверное поле не роняет список), имя в адресе — занятость и 30 дней
// прежнему, старое присланное не откатывает новое; файлы снимка.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { admitClinic, saveKeys, saveSnapshot, saveSlots, resolveSlug, snapshotOf, connectionByHash, originAllowedForClinic, markUsed, clinicRow }
  from './clinics.js';
import { missingMedia, putMedia, mediaFile, gcMedia } from './media.js';
import { testDb, testVendor, testClinic, NOW } from '../test-helpers/fixture.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const auth = (c, licence = {}) => ({ clinicId: c.clinicId, fingerprint: c.identity.fingerprint,
  licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active', ...licence } });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keysBody = (c, conns, at = NOW) => ({ generated_at: isoOf(at), box_key: c.identity.boxPublic, connections: conns });
const conn = (over = {}) => ({ id: 3, kind: 'partner', active: true, key_hash: hash('k3'), scopes: ['clinic', 'doctors'], rate_limit: 60,
  key_expires_at: null, ip_allow: [], origins: ['https://med24.uz'], ...over });
const snap = (slug, at = NOW) => ({ version: 1, generated_at: isoOf(at), slug, clinic: { name: { ru: 'Шифо' } }, branches: [], doctors: [], services: [], packages: [] });

test('лицензия: первая записывается; новее — заменяет; старее с тем же ключом — только «виделись»; старее с чужим ключом — отказ', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  assert.equal(admitClinic(db, auth(c), NOW).ok, true);
  admitClinic(db, auth(c, { issued_at: '2030-03-11T00:00:00Z', subscription: 'unpaid' }), NOW + 1000);
  assert.equal(clinicRow(db, c.clinicId).licence_subscription, 'unpaid');
  const back = admitClinic(db, auth(c, { issued_at: '2030-03-09T00:00:00Z', subscription: 'active' }), NOW + 2000);
  assert.equal(back.ok, true);
  assert.equal(back.clinic.licence_subscription, 'unpaid', 'старая лицензия без отметки не снимает «не оплачено» (решение 17)');
  assert.equal(back.clinic.last_seen_at, isoOf(NOW + 2000));
  const stolen = testClinic(vendor);
  const r = admitClinic(db, { ...auth(stolen, { issued_at: '2030-03-09T00:00:00Z' }), clinicId: c.clinicId }, NOW);
  assert.deepEqual(r, { ok: false, code: 'licence_outdated' });
});

test('новый ключ клиники в новой лицензии — прежний ящик забыт до нового PUT /keys', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  saveKeys(db, c.clinicId, keysBody(c, [conn()]), NOW);
  assert.equal(clinicRow(db, c.clinicId).box_key, c.identity.boxPublic);
  const fresh = testClinic(vendor);
  admitClinic(db, { ...auth(fresh, { issued_at: '2030-03-12T00:00:00Z' }), clinicId: c.clinicId }, NOW);
  const row = clinicRow(db, c.clinicId);
  assert.equal(row.key_fp, fresh.identity.fingerprint);
  assert.equal(row.box_key, null);
});

test('ключи: список заменяется целиком, «последний запрос» переживает замену, мусор не роняет список', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  assert.deepEqual(saveKeys(db, c.clinicId, keysBody(c, [conn(), conn({ id: 4, key_hash: hash('k4') })]), NOW), { ok: true, connections: 2 });
  markUsed(db, c.clinicId, 3, NOW);
  saveKeys(db, c.clinicId, keysBody(c, [conn({ active: false, scopes: ['clinic', 'чужое'], key_expires_at: 'не дата', origins: ['javascript:x', 'https://Med24.uz'] }),
    { id: 9, key_hash: 'нет' }], NOW + 1000), NOW + 1000);
  const k = connectionByHash(db, c.clinicId, hash('k3'));
  assert.equal(k.active, 0);
  assert.deepEqual(k.scopes, ['clinic']);
  assert.equal(k.key_expires_at, '1970-01-01T00:00:00Z', 'неверный срок — истёк');
  assert.deepEqual(k.origins, ['https://med24.uz']);
  assert.equal(k.last_used_at, isoOf(NOW));
  assert.equal(connectionByHash(db, c.clinicId, hash('k4')), null, 'удалённое подключение исчезло');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM connections').get().n, 1, 'подключение без отпечатка пропущено');
  assert.deepEqual(saveKeys(db, c.clinicId, keysBody(c, [conn()], NOW), NOW + 2000), { ok: true, ignored: true }, 'старое не откатывает новое');
  assert.equal(connectionByHash(db, c.clinicId, hash('k3')).active, 0);
  assert.deepEqual(saveKeys(db, c.clinicId, { ...keysBody(c, []), box_key: 'мусор' }, NOW), { error: 'bad_request' });
  assert.equal(originAllowedForClinic(db, c.clinicId, 'https://med24.uz'), false, 'выключенное подключение сайт не открывает');
});

test('имя в адресе: занятость другой клиникой, прежнее имя 30 дней, своё прежнее — можно вернуть', () => {
  const { db } = testDb();
  const a = testClinic(vendor);
  const b = testClinic(vendor, { clinicId: 'c-000778' });
  admitClinic(db, auth(a), NOW);
  admitClinic(db, auth(b), NOW);
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('shifo'), NOW), { ok: true });
  assert.deepEqual(saveSnapshot(db, b.clinicId, snap('shifo'), NOW), { error: 'slug_taken' });
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('shifo-med', NOW + 1000), NOW + 1000), { ok: true });
  assert.equal(resolveSlug(db, 'shifo', NOW + 2000).clinic_id, a.clinicId, 'прежнее имя ещё работает');
  assert.equal(resolveSlug(db, 'SHIFO-MED', NOW + 2000).clinic_id, a.clinicId);
  assert.deepEqual(saveSnapshot(db, b.clinicId, snap('shifo'), NOW + 3000), { error: 'slug_taken' }, 'прежнее имя 30 дней занято');
  const later = NOW + 31 * 86400000;
  assert.equal(resolveSlug(db, 'shifo', later), null);
  assert.deepEqual(saveSnapshot(db, b.clinicId, snap('shifo', later), later), { ok: true });
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('api', later), later), { error: 'bad_slug' });
  assert.deepEqual(saveSnapshot(db, a.clinicId, { slug: 'x' }, later), { error: 'bad_request' });
  assert.deepEqual(saveSnapshot(db, a.clinicId, snap('shifo-med', NOW), later), { ok: true, ignored: true });
  assert.equal(snapshotOf(clinicRow(db, a.clinicId)).clinic.name.ru, 'Шифо');
});

test('время: сохраняется, старое не откатывает новое', () => {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  assert.deepEqual(saveSlots(db, c.clinicId, { generated_at: isoOf(NOW), slot_minutes: 15, doctors: {} }, NOW), { ok: true });
  assert.deepEqual(saveSlots(db, c.clinicId, { generated_at: isoOf(NOW - 1000), doctors: {} }, NOW), { ok: true, ignored: true });
  assert.deepEqual(saveSlots(db, c.clinicId, { doctors: [] }, NOW), { error: 'bad_request' });
});

test('файлы: только чего нет; отпечаток и вид сверяются; партнёр получает только файл из текущего снимка; уборка', () => {
  const { db, dir } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, auth(c), NOW);
  const png = fakePng(64, 64);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  assert.deepEqual(missingMedia(db, c.clinicId, [sha, 'мусор']), [sha]);
  assert.deepEqual(putMedia(db, dir, c.clinicId, sha, 'png', Buffer.from('<html>'), NOW), { error: 'bad_request' }, 'отпечаток не тот');
  assert.deepEqual(putMedia(db, dir, c.clinicId, sha, 'jpg', png, NOW), { error: 'bad_request' }, 'PNG под видом JPEG');
  assert.deepEqual(putMedia(db, dir, c.clinicId, sha, 'png', png, NOW), { ok: true });
  assert.deepEqual(missingMedia(db, c.clinicId, [sha]), []);
  assert.equal(mediaFile(db, dir, clinicRow(db, c.clinicId), sha, 'png'), null, 'в снимке его ещё нет');
  saveSnapshot(db, c.clinicId, { ...snap('shifo'), clinic: { logo: { square: 'media/' + sha + '.png' } } }, NOW);
  const f = mediaFile(db, dir, clinicRow(db, c.clinicId), sha, 'png');
  assert.equal(f.type, 'image/png');
  assert.deepEqual(fs.readFileSync(f.file), png);
  saveSnapshot(db, c.clinicId, snap('shifo', NOW + 1000), NOW + 1000);
  assert.deepEqual(gcMedia(db, dir, NOW + 2 * 86400000), { rows: 1, files: 1 });
  assert.equal(fs.existsSync(f.file), false);
});
```

- [ ] **Step 2:** `node --test public-server/server/store/clinics.test.js` → падает: `ERR_MODULE_NOT_FOUND` (`store/clinics.js`).
- [ ] **Step 3: модули.**

`public-server/server/store/clinics.js`:

```js
// PUBLIC_SERVER_V1 — КЛИНИКИ НА ПУБЛИЧНОМ СЕРВЕРЕ: кто (лицензия), что
// показывает партнёрам (снимок, время), кому (подключения — отпечатки ключей).
//
// ЛИЦЕНЗИЯ — САМАЯ НОВАЯ ИЗ ВИДЕННЫХ (по issued_at). Клиника сама выбирает,
// какой licence.dat приложить; положи она старую лицензию без отметки «не
// оплачено» — решение владельца 17 обходилось бы. Поэтому состояние и
// отпечаток ключа берутся из самой новой лицензии: старая лицензия доказывает
// личность, только если её ключ — тот же, что в новой (иначе 401
// licence_outdated: ключ клиники сменили, старый больше не говорит за неё).
//
// ВСЁ, ЧТО ПРИСЛАЛА КЛИНИКА, — НЕ СТАРШЕ ПРЕЖНЕГО: ключи, снимок и время с
// generated_at раньше сохранённого не применяются (повтор перехваченного старого
// запроса не включит обратно выключенный ключ). Часы клиники при этом не дальше
// PUBLIC_SYNC_SKEW_MIN от сервера (clinic-auth.js), так что после исправления
// часов клиники обновления ждут не дольше этого допуска.
import crypto from 'node:crypto';
import { SCOPES, normalizeSlug, slugProblem } from '../../../public/js/shared/api-connections.js';
import { isoOf, msOf } from '../lib/time.js';

export const SLUG_ALIAS_DAYS = 30;
const DAY = 86400000;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const ORIGIN_RE = /^https?:\/\/[^\s/]+$/i;
const MAX_CONNECTIONS = 200;

export const clinicRow = (db, clinicId) => db.prepare('SELECT * FROM clinics WHERE clinic_id = ?').get(clinicId) || null;

/**
 * Клиника прошла проверку подписи (clinic-auth.js) — записать её и лицензию.
 * @returns {{ok:true, clinic:object} | {ok:false, code:'licence_outdated'}}
 */
export function admitClinic(db, auth, now) {
  const at = isoOf(now);
  const row = clinicRow(db, auth.clinicId);
  const presented = msOf(auth.licence.issued_at) || 0;
  if (!row) {
    db.prepare(`INSERT INTO clinics (clinic_id, key_fp, licence_issued_at, licence_valid_until, licence_subscription, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(auth.clinicId, auth.fingerprint, auth.licence.issued_at, auth.licence.valid_until, auth.licence.subscription, at, at);
    return { ok: true, clinic: clinicRow(db, auth.clinicId) };
  }
  const stored = msOf(row.licence_issued_at) || 0;
  if (presented >= stored) {
    // Новый ключ клиники (ПК заменили) — прежний ящик больше не её: новые
    // заявки ждут, пока клиника пришлёт новый box_key (PUT /keys, тот же такт).
    const box = row.key_fp === auth.fingerprint ? row.box_key : null;
    db.prepare(`UPDATE clinics SET key_fp = ?, box_key = ?, licence_issued_at = ?, licence_valid_until = ?, licence_subscription = ?,
                last_seen_at = ? WHERE clinic_id = ?`)
      .run(auth.fingerprint, box, auth.licence.issued_at, auth.licence.valid_until, auth.licence.subscription, at, auth.clinicId);
    return { ok: true, clinic: clinicRow(db, auth.clinicId) };
  }
  if (row.key_fp !== auth.fingerprint) return { ok: false, code: 'licence_outdated' };
  db.prepare('UPDATE clinics SET last_seen_at = ? WHERE clinic_id = ?').run(at, auth.clinicId);
  return { ok: true, clinic: clinicRow(db, auth.clinicId) };
}

/** Присланное не старше сохранённого (повтор старого запроса не откатывает). */
const notOlder = (generatedAt, storedAt) => !storedAt || (msOf(generatedAt) || 0) >= (msOf(storedAt) || 0);

function boxKeyOk(b64) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(b64 || ''), 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'x25519';
  } catch { return false; }
}

const strings = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

/**
 * Одно подключение из PUT /keys. Неверное поле не роняет весь список (иначе
 * клиника не смогла бы выключить ни один ключ): права — только известные;
 * неверный срок — «истёк»; неверный отпечаток — подключение пропускается
 * (таким ключом не войти всё равно). IP проверяются при запросе: неверная
 * запись — ключ не пускается ни с какого адреса (routes/partner-auth.js).
 */
function connectionOf(c) {
  const id = Number(c && c.id);
  const hash = String((c && c.key_hash) || '').toLowerCase();
  if (!Number.isInteger(id) || id <= 0 || !KEY_HASH_RE.test(hash)) return null;
  const rate = Number(c.rate_limit);
  const exp = c.key_expires_at == null || c.key_expires_at === '' ? null : msOf(c.key_expires_at);
  return {
    id, kind: String(c.kind || '').slice(0, 16), active: c.active === true || c.active === 1 ? 1 : 0, key_hash: hash,
    scopes: JSON.stringify(SCOPES.filter((s) => strings(c.scopes).includes(s))),
    rate_limit: Number.isInteger(rate) && rate > 0 && rate <= 10000 ? rate : 60,
    key_expires_at: c.key_expires_at == null || c.key_expires_at === '' ? null : isoOf(exp == null ? 0 : exp),
    ip_allow: JSON.stringify(strings(c.ip_allow).slice(0, 50)),
    origins: JSON.stringify(strings(c.origins).filter((o) => ORIGIN_RE.test(o)).map((o) => o.toLowerCase()).slice(0, 10)),
  };
}

/** PUT /_sync/v1/keys — список подключений заменяется целиком. */
export function saveKeys(db, clinicId, body, now) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.connections) || body.connections.length > MAX_CONNECTIONS) return { error: 'bad_request' };
  if (!boxKeyOk(body.box_key)) return { error: 'bad_request' };
  const row = clinicRow(db, clinicId);
  if (!notOlder(body.generated_at, row.keys_at)) return { ok: true, ignored: true };
  const list = body.connections.map(connectionOf).filter(Boolean);
  if (new Set(list.map((c) => c.key_hash)).size !== list.length || new Set(list.map((c) => c.id)).size !== list.length) return { error: 'bad_request' };
  const used = new Map(db.prepare('SELECT id, last_used_at FROM connections WHERE clinic_id = ?').all(clinicId).map((r) => [r.id, r.last_used_at]));
  db.transaction(() => {
    db.prepare('UPDATE clinics SET box_key = ?, keys_at = ? WHERE clinic_id = ?').run(String(body.box_key), isoOf(msOf(body.generated_at) || now), clinicId);
    db.prepare('DELETE FROM connections WHERE clinic_id = ?').run(clinicId);
    const ins = db.prepare(`INSERT INTO connections (clinic_id, id, kind, active, key_hash, scopes, rate_limit, key_expires_at, ip_allow, origins, last_used_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of list) {
      ins.run(clinicId, c.id, c.kind, c.active, c.key_hash, c.scopes, c.rate_limit, c.key_expires_at, c.ip_allow, c.origins, used.get(c.id) || null);
    }
  })();
  return { ok: true, connections: list.length };
}

/**
 * PUT /_sync/v1/snapshot — снимок и имя в адресе. Имя занято другой клиникой
 * (или её прежним именем в течение 30 дней) — slug_taken. Своё прежнее имя
 * работает ещё SLUG_ALIAS_DAYS дней (макет: «старый адрес работает 30 дней»).
 */
export function saveSnapshot(db, clinicId, snap, now) {
  if (!snap || typeof snap !== 'object' || typeof snap.clinic !== 'object' || snap.clinic === null) return { error: 'bad_request' };
  for (const k of ['branches', 'doctors', 'services', 'packages']) if (snap[k] != null && !Array.isArray(snap[k])) return { error: 'bad_request' };
  const slug = normalizeSlug(snap.slug);
  if (slugProblem(slug)) return { error: 'bad_slug' };
  const row = clinicRow(db, clinicId);
  if (!notOlder(snap.generated_at, row.snapshot_at)) return { ok: true, ignored: true };
  const at = isoOf(now);
  const owner = db.prepare('SELECT clinic_id FROM clinics WHERE slug = ? AND clinic_id <> ?').get(slug, clinicId);
  const alias = db.prepare('SELECT clinic_id FROM slug_aliases WHERE slug = ? AND clinic_id <> ? AND until_at > ?').get(slug, clinicId, at);
  if (owner || alias) return { error: 'slug_taken' };
  db.transaction(() => {
    if (row.slug && row.slug !== slug) {
      db.prepare('INSERT OR REPLACE INTO slug_aliases (slug, clinic_id, until_at) VALUES (?, ?, ?)')
        .run(row.slug, clinicId, isoOf(now + SLUG_ALIAS_DAYS * DAY));
    }
    db.prepare('DELETE FROM slug_aliases WHERE slug = ?').run(slug);
    db.prepare('UPDATE clinics SET slug = ?, snapshot = ?, snapshot_at = ? WHERE clinic_id = ?')
      .run(slug, JSON.stringify(snap), isoOf(msOf(snap.generated_at) || now), clinicId);
  })();
  return { ok: true };
}

/** PUT /_sync/v1/slots — свободное время («1» — свободно), без имён. */
export function saveSlots(db, clinicId, slots, now) {
  if (!slots || typeof slots !== 'object' || !slots.doctors || typeof slots.doctors !== 'object' || Array.isArray(slots.doctors)) return { error: 'bad_request' };
  const row = clinicRow(db, clinicId);
  if (!notOlder(slots.generated_at, row.slots_at)) return { ok: true, ignored: true };
  db.prepare('UPDATE clinics SET slots = ?, slots_at = ? WHERE clinic_id = ?').run(JSON.stringify(slots), isoOf(msOf(slots.generated_at) || now), clinicId);
  return { ok: true };
}

/** Клиника по имени в адресе — текущему или прежнему (30 дней); нет — null. */
export function resolveSlug(db, slug, now) {
  const s = normalizeSlug(slug);
  if (slugProblem(s)) return null;
  const row = db.prepare('SELECT * FROM clinics WHERE slug = ?').get(s);
  if (row) return row;
  const alias = db.prepare('SELECT clinic_id FROM slug_aliases WHERE slug = ? AND until_at > ?').get(s, isoOf(now));
  return alias ? clinicRow(db, alias.clinic_id) : null;
}

// Разобранные снимок и время — в памяти по (клиника, дата сборки): снимок
// большой клиники — сотни килобайт, разбирать его на каждый запрос незачем.
const CACHE_MAX = 32;
const cache = new Map();
function parsedOf(clinic, kind) {
  const text = clinic && clinic[kind];
  if (!text) return null;
  const key = clinic.clinic_id + ':' + kind + ':' + clinic[kind + '_at'];
  if (cache.has(key)) return cache.get(key);
  let v = null;
  try { v = JSON.parse(text); } catch { v = null; }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, v);
  return v;
}
export const snapshotOf = (clinic) => parsedOf(clinic, 'snapshot');
export const slotsOf = (clinic) => parsedOf(clinic, 'slots');

/** Подключение по отпечатку ключа в этой клинике; нет — null. */
export function connectionByHash(db, clinicId, keyHash) {
  const c = db.prepare('SELECT * FROM connections WHERE clinic_id = ? AND key_hash = ?').get(clinicId, keyHash);
  if (!c) return null;
  const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
  return { ...c, scopes: arr(c.scopes), ip_allow: arr(c.ip_allow), origins: arr(c.origins) };
}

/** Активные подключения клиники, разрешившие этот сайт (CORS до ключа — предварительный запрос браузера). */
export function originAllowedForClinic(db, clinicId, origin) {
  const o = String(origin || '').toLowerCase();
  if (!o) return false;
  return db.prepare('SELECT origins FROM connections WHERE clinic_id = ? AND active = 1').all(clinicId)
    .some((r) => { try { return JSON.parse(r.origins).includes(o); } catch { return false; } });
}

/** «Последний запрос» подключения — не чаще раза в минуту на подключение (лишние записи в базу). */
export function markUsed(db, clinicId, connectionId, now) {
  db.prepare(`UPDATE connections SET last_used_at = ? WHERE clinic_id = ? AND id = ?
              AND (last_used_at IS NULL OR last_used_at <= ?)`).run(isoOf(now), clinicId, connectionId, isoOf(now - 60000));
}

```

`public-server/server/store/media.js`:

```js
// PUBLIC_SERVER_V1 — ФАЙЛЫ СНИМКА: логотипы клиники и фото показанных врачей.
//
// Клиника шлёт только то, чего у сервера нет (POST /media/check), файлом по
// отпечатку (PUT /media/<sha256>.<ext>). Байты — на диске <data>/media/<sha256>
// (одинаковый файл двух клиник лежит один раз), строка media — «этот файл
// прислала эта клиника». Партнёр получает файл по ссылке без ключа (картинку
// на сайте браузер грузит без заголовков), но только файл, на который
// ссылается ТЕКУЩИЙ снимок клиники.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoOf } from '../lib/time.js';

export const MEDIA_MAX_BYTES = 2 * 1024 * 1024;   // как snapshot.js клиники
export const MEDIA_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });
const SHA_RE = /^[0-9a-f]{64}$/;
const KEEP_UNREFERENCED_MS = 86400000;

const mediaDir = (dataDir) => path.join(dataDir, 'media');

/** Байты похожи на объявленный вид (не HTML под видом картинки). */
export function looksLike(ext, buf) {
  if (ext === 'png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === 'jpg' || ext === 'jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === 'webp') return buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** POST /media/check — каких из присланных отпечатков у этой клиники нет. */
export function missingMedia(db, clinicId, hashes) {
  const list = Array.isArray(hashes) ? [...new Set(hashes.map((h) => String(h).toLowerCase()).filter((h) => SHA_RE.test(h)))].slice(0, 500) : [];
  const has = db.prepare('SELECT 1 FROM media WHERE clinic_id = ? AND sha256 = ?');
  return list.filter((h) => !has.get(clinicId, h));
}

/** PUT /media/<sha256>.<ext>. → {ok} | {error:'bad_request'|'too_large'} */
export function putMedia(db, dataDir, clinicId, sha, ext, buf, now) {
  if (!SHA_RE.test(sha) || !MEDIA_TYPES[ext] || !Buffer.isBuffer(buf) || !buf.length) return { error: 'bad_request' };
  if (buf.length > MEDIA_MAX_BYTES) return { error: 'too_large' };
  if (crypto.createHash('sha256').update(buf).digest('hex') !== sha || !looksLike(ext, buf)) return { error: 'bad_request' };
  const dir = mediaDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sha);
  if (!fs.existsSync(file)) {
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }
  db.prepare('INSERT OR REPLACE INTO media (clinic_id, sha256, ext, bytes, stored_at) VALUES (?, ?, ?, ?, ?)')
    .run(clinicId, sha, ext, buf.length, isoOf(now));
  return { ok: true };
}

/** Файл для партнёра: прислан этой клиникой и есть в её текущем снимке. → {file, type} | null */
export function mediaFile(db, dataDir, clinic, sha, ext) {
  if (!clinic || !SHA_RE.test(sha) || !MEDIA_TYPES[ext]) return null;
  const row = db.prepare('SELECT ext FROM media WHERE clinic_id = ? AND sha256 = ?').get(clinic.clinic_id, sha);
  if (!row || row.ext !== ext) return null;
  if (!String(clinic.snapshot || '').includes('"media/' + sha + '.' + ext + '"')) return null;
  const file = path.join(mediaDir(dataDir), sha);
  return fs.existsSync(file) ? { file, type: MEDIA_TYPES[ext] } : null;
}

/** Уборка: строки, на которые снимок не ссылается дольше суток, и файлы без строк. */
export function gcMedia(db, dataDir, now) {
  const old = isoOf(now - KEEP_UNREFERENCED_MS);
  const rows = db.prepare('SELECT m.clinic_id, m.sha256, m.ext, c.snapshot FROM media m JOIN clinics c ON c.clinic_id = m.clinic_id WHERE m.stored_at < ?').all(old);
  const del = db.prepare('DELETE FROM media WHERE clinic_id = ? AND sha256 = ?');
  let rowsGone = 0;
  for (const r of rows) {
    if (!String(r.snapshot || '').includes('"media/' + r.sha256 + '.' + r.ext + '"')) { del.run(r.clinic_id, r.sha256); rowsGone += 1; }
  }
  let filesGone = 0;
  const dir = mediaDir(dataDir);
  if (fs.existsSync(dir)) {
    const still = db.prepare('SELECT 1 FROM media WHERE sha256 = ? LIMIT 1');
    for (const f of fs.readdirSync(dir)) {
      if (SHA_RE.test(f) && !still.get(f)) { fs.rmSync(path.join(dir, f), { force: true }); filesGone += 1; }
    }
  }
  return { rows: rowsGone, files: filesGone };
}
```

- [ ] **Step 4:** тест зелёный — **6 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 5: коммит** «Публичный сервер, клиники: решает самая новая лицензия (старая без «не оплачено» не снимает отметку, старая с чужим ключом — отказ), подключения отпечатками заменяются целиком (неверное поле не роняет список), имя в адресе — занятость и 30 дней прежнему, старое присланное не откатывает новое, файлы снимка по отпечатку и только из текущего снимка».

---

## Task 4: Заявки и очередь — запечатывание при приёме, курсор и стирание, held, статус по событиям клиники, отмена и другое время, закрытие без ответа (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/store/requests.js`, `public-server/server/store/logs.js`
- Create: `public-server/server/store/requests.test.js`

- [ ] **Step 1: падающий тест** `public-server/server/store/requests.test.js`. Совместимость с клиникой: элемент очереди открывается её ключом (`openSealed`) и проходит её разбор (`parseInboxItem`):

```js
// PUBLIC_SERVER_V1 — заявки и очередь: данные пациента только запечатанными и
// их открывает разбор клиники (parseInboxItem); подтверждение курсора стирает
// элементы целиком; held — срок держания; события клиники ведут статус;
// отмена и ответ на другое время; закрытие без ответа.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, requestRow, inboxItems, ackInbox, queueOverlaps, partnerCancel, partnerAnswerOffer, applyEvents,
  closeOverdue, purgeRequests, newRequestId } from './requests.js';
import { admitClinic, saveKeys, clinicRow } from './clinics.js';
import { openSealed } from '../../../server/services/api/sync-identity.js';
import { parseInboxItem } from '../../../public/js/shared/api-booking.js';
import { testDb, testVendor, testClinic, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const START = Date.parse('2030-03-12T05:00:00Z');
const PATIENT = { name: 'Абдурахмонов Фаррух', phone: '+998901234567', comment: 'Ребёнок 5 лет' };

function setup() {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, { clinicId: c.clinicId, fingerprint: c.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  saveKeys(db, c.clinicId, { generated_at: isoOf(NOW), box_key: c.identity.boxPublic, connections: [] }, NOW);
  return { db, c, clinic: () => clinicRow(db, c.clinicId) };
}
const appt = (s, over = {}) => createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'appointment', externalId: 'med-1', lang: 'ru',
  doctorId: 7, consultation: 'initial', startAt: isoOf(START), durationMin: 30, patient: PATIENT, now: NOW, ...over });
const event = (seq, row, ev, status, extra = {}, hook = {}) => ({ seq, event: ev, status,
  body: JSON.stringify({ event_id: 'ev_' + seq, event: ev, request_id: row.id, external_id: 'med-1', status, occurred_at: isoOf(NOW), ...extra }),
  webhook_url: '', signature: '', ...hook });

test('номер заявки — как ждёт клиника', () => {
  for (let i = 0; i < 50; i += 1) assert.match(newRequestId(), /^rq_[A-Za-z0-9]{24}$/);
});

test('приём: статус без данных пациента; в очереди — запечатанные, их открывает и разбирает клиника; повтор external_id — та же заявка', () => {
  const s = setup();
  const r = appt(s);
  assert.equal(r.created, true);
  assert.equal(r.row.status, 'pending');
  assert.equal(r.row.hold_until, null, 'срок держания назначит клиника (решение 19)');
  const stored = JSON.stringify(s.db.prepare('SELECT * FROM requests').all()) + JSON.stringify(s.db.prepare('SELECT type, data FROM inbox').all());
  for (const mark of ['Абдурахмонов', '998901234567', 'Ребёнок']) assert.ok(!stored.includes(mark), 'открытым лежит: ' + mark);
  const [it] = inboxItems(s.db, s.c.clinicId, '');
  assert.equal(it.cursor, '1');
  const opened = { ...it, patient: openSealed(s.c.identity, it.sealed) };
  delete opened.sealed;
  const p = parseInboxItem(opened);
  assert.equal(p.ok, true, 'разбор клиники принимает элемент: ' + p.problem);
  assert.deepEqual(p.value.patient, PATIENT);
  assert.equal(p.value.start_at, isoOf(START));
  assert.equal(p.value.consultation, 'initial');
  const again = appt(s);
  assert.deepEqual([again.created, again.row.id], [false, r.row.id]);
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).length, 1);
  s.db.prepare('UPDATE clinics SET box_key = NULL').run();
  assert.deepEqual(appt(s, { externalId: 'med-9' }), { error: 'clinic_offline' });
});

test('«перезвоните»: разбор клиники принимает; доставка = ответ (событий клиника не шлёт)', () => {
  const s = setup();
  const r = createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'request', patient: PATIENT, serviceId: 301, now: NOW });
  assert.equal(r.row.status, 'new');
  const [it] = inboxItems(s.db, s.c.clinicId, 0);
  assert.equal(parseInboxItem({ ...it, patient: openSealed(s.c.identity, it.sealed) }).ok, true);
  ackInbox(s.db, s.c.clinicId, it.cursor, [], NOW + 1000);
  const row = requestRow(s.db, s.c.clinicId, r.row.id);
  assert.equal(row.delivered_at, isoOf(NOW + 1000));
  assert.equal(row.answered_at, isoOf(NOW + 1000));
});

test('подтверждение курсора: элементы до курсора стёрты целиком; held — срок держания; чужое и мусор не действуют', () => {
  const s = setup();
  const a = appt(s).row;
  const b = appt(s, { externalId: 'med-2', startAt: isoOf(START + 3600000) }).row;
  assert.deepEqual(ackInbox(s.db, s.c.clinicId, 'x', [], NOW), { error: 'bad_request' });
  const r = ackInbox(s.db, s.c.clinicId, '1', [{ request_id: a.id, hold_until: '2030-03-11T04:30:00Z' }, { request_id: 'rq_чужой', hold_until: 'нет' }], NOW + 1000);
  assert.deepEqual(r, { ok: true, deleted: 1 });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE sealed IS NOT NULL').get().n, 1, 'второй ещё ждёт');
  const ra = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([ra.hold_until, ra.delivered_at, ra.answered_at], ['2030-03-11T04:30:00Z', isoOf(NOW + 1000), isoOf(NOW + 1000)]);
  assert.equal(requestRow(s.db, s.c.clinicId, b.id).delivered_at, null);
  ackInbox(s.db, s.c.clinicId, '2', [], NOW + 2000);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
});

test('занятость своей очередью: ждущая и предложенная держат, истёкшая — нет', () => {
  const s = setup();
  const a = appt(s).row;
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START + 15 * 60000, 15, NOW), true);
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START + 30 * 60000, 15, NOW), false, 'сразу после — свободно');
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 8, START, 15, NOW), false, 'другой врач');
  s.db.prepare("UPDATE requests SET hold_until = ? WHERE id = ?").run(isoOf(NOW - 1000), a.id);
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START, 15, NOW), false, 'срок вышел');
  s.db.prepare("UPDATE requests SET status = 'offered', offered_start = ?, offer_until = ? WHERE id = ?").run(isoOf(START + 7200000), isoOf(NOW + 60000), a.id);
  assert.equal(queueOverlaps(s.db, s.c.clinicId, 7, START + 7200000, 15, NOW), true);
});

test('отмена пациентом: ждущая — сразу cancelled; записанная — ждёт клинику; повтор — без нового элемента; отказанную — нельзя', () => {
  const s = setup();
  const a = appt(s).row;
  assert.equal(partnerCancel(s.db, a, NOW).row.status, 'cancelled');
  assert.deepEqual(inboxItems(s.db, s.c.clinicId, 0).map((i) => i.type), ['appointment.new', 'appointment.cancel']);
  const b = appt(s, { externalId: 'med-2' }).row;
  s.db.prepare("UPDATE requests SET status = 'booked' WHERE id = ?").run(b.id);
  const r = partnerCancel(s.db, requestRow(s.db, s.c.clinicId, b.id), NOW);
  assert.equal(r.row.status, 'booked');
  assert.ok(r.row.cancel_requested_at);
  partnerCancel(s.db, r.row, NOW);
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).filter((i) => i.type === 'appointment.cancel').length, 2, 'повтор — без нового элемента');
  s.db.prepare("UPDATE requests SET status = 'declined' WHERE id = ?").run(b.id);
  assert.deepEqual(partnerCancel(s.db, requestRow(s.db, s.c.clinicId, b.id), NOW), { error: 'not_cancellable' });
});

test('другое время: согласие в срок — pending на новом времени; после срока — offer_expired; отказ — cancelled', () => {
  const s = setup();
  const a = appt(s).row;
  assert.deepEqual(partnerAnswerOffer(s.db, a, true, NOW), { error: 'not_offered' });
  const offered = isoOf(START + 7200000);
  s.db.prepare("UPDATE requests SET status = 'offered', offered_start = ?, offer_until = ?, delivered_at = ?, answered_at = ? WHERE id = ?")
    .run(offered, isoOf(NOW + 60000), isoOf(NOW), isoOf(NOW), a.id);
  const row = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual(partnerAnswerOffer(s.db, row, true, NOW + 61000), { error: 'offer_expired' });
  const ok = partnerAnswerOffer(s.db, row, true, NOW + 1000).row;
  assert.deepEqual([ok.status, ok.start_at, ok.offered_start, ok.delivered_at, ok.answered_at], ['pending', offered, null, null, null]);
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).at(-1).type, 'offer.accept');
  const b = appt(s, { externalId: 'med-2', startAt: isoOf(START + 86400000) }).row;
  s.db.prepare("UPDATE requests SET status = 'offered', offered_start = ?, offer_until = ? WHERE id = ?").run(offered, isoOf(NOW + 60000), b.id);
  assert.equal(partnerAnswerOffer(s.db, requestRow(s.db, s.c.clinicId, b.id), false, NOW).row.status, 'cancelled');
  assert.equal(inboxItems(s.db, s.c.clinicId, 0).at(-1).type, 'offer.decline');
});

test('события клиники: статус, повтор seq, испорченное принято без действия, уведомление — только с адресом и подписью', () => {
  const s = setup();
  const a = appt(s).row;
  const sig = 'sha256=' + 'a'.repeat(64);
  const offer = event(1, a, 'booking.offered_other_time', 'offered', { offered_start: '2030-03-12T12:00:00+05:00', offer_until: '2030-03-11T09:30:00+05:00' },
    { webhook_url: 'https://med24.uz/hooks', signature: sig });
  const r = applyEvents(s.db, s.c.clinicId, [
    offer,
    { seq: 2, event: 'booking.confirmed', body: '{испорчено' },
    { seq: 'x' },
    event(3, a, 'booking.declined', 'declined', { reason: 'slot_taken' }, { webhook_url: 'http://10.0.0.1/x', signature: sig }),
  ], NOW);
  assert.deepEqual(r.accepted, [1, 2, 3]);
  const row = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([row.status, row.reason, row.offered_start, row.offer_until], ['declined', 'slot_taken', null, null]);
  const d = s.db.prepare('SELECT * FROM deliveries').all();
  assert.equal(d.length, 1, 'адрес http и частный IP в очередь доставки не встаёт');
  assert.equal(d[0].url, 'https://med24.uz/hooks');
  assert.equal(d[0].body, offer.body, 'тело — байт в байт как подписала клиника');
  assert.equal(d[0].connection_id, 3);
  assert.deepEqual(applyEvents(s.db, s.c.clinicId, [event(1, a, 'booking.confirmed', 'booked')], NOW).accepted, [1]);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'declined', 'повтор seq ничего не меняет');
  applyEvents(s.db, s.c.clinicId, [event(4, a, 'booking.confirmed', 'booked', { start: '2030-03-12T10:00:00+05:00', branch_id: 1 })], NOW);
  const b = requestRow(s.db, s.c.clinicId, a.id);
  assert.deepEqual([b.status, b.reason, b.start_at, b.branch_id], ['booked', null, '2030-03-12T05:00:00Z', 1]);
});

test('отменённое партнёром не превращается в «истекло» от клиники, не дошедшей до отмены', () => {
  const s = setup();
  const a = appt(s).row;
  partnerCancel(s.db, a, NOW);
  applyEvents(s.db, s.c.clinicId, [event(1, a, 'booking.declined', 'expired', { reason: 'expired' })], NOW + 1000);
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'cancelled');
});

test('закрытие без ответа: забрала и молчит 30 минут — not_processed; не забрала сутки (решение владельца 20) — not_collected, шифротекст стёрт', () => {
  const s = setup();
  const quiet = appt(s).row;
  const held = appt(s, { externalId: 'med-2', startAt: isoOf(START + 3600000) }).row;
  const callback = createRequest(s.db, { clinic: s.clinic(), connectionId: 3, kind: 'request', patient: PATIENT, now: NOW }).row;
  ackInbox(s.db, s.c.clinicId, '3', [{ request_id: held.id, hold_until: isoOf(NOW + 1800000) }], NOW);
  assert.deepEqual(closeOverdue(s.db, NOW + 29 * 60000), { not_processed: 0, not_collected: 0 });
  assert.deepEqual(closeOverdue(s.db, NOW + 31 * 60000), { not_processed: 1, not_collected: 0 });
  const q = requestRow(s.db, s.c.clinicId, quiet.id);
  assert.deepEqual([q.status, q.reason], ['closed', 'not_processed']);
  assert.equal(requestRow(s.db, s.c.clinicId, held.id).status, 'pending');
  assert.equal(requestRow(s.db, s.c.clinicId, callback.id).status, 'new');
  const late = appt(s, { externalId: 'med-3', startAt: isoOf(START + 7200000) }).row;
  assert.deepEqual(closeOverdue(s.db, NOW + 86400000 - 1000), { not_processed: 0, not_collected: 0 }, 'сутки ещё не прошли');
  assert.deepEqual(closeOverdue(s.db, NOW + 86400000 + 1000, { uncollectedMaxMs: 48 * 3600000 }), { not_processed: 0, not_collected: 0 },
    'срок — настройка PUBLIC_UNCOLLECTED_MAX_HOURS');
  assert.deepEqual(closeOverdue(s.db, NOW + 86400000 + 1000), { not_processed: 0, not_collected: 1 });
  assert.deepEqual([requestRow(s.db, s.c.clinicId, late.id).status, requestRow(s.db, s.c.clinicId, late.id).reason], ['closed', 'not_collected']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  applyEvents(s.db, s.c.clinicId, [event(9, quiet, 'booking.declined', 'declined', { reason: 'slot_taken' })], NOW + 32 * 60000);
  assert.equal(requestRow(s.db, s.c.clinicId, quiet.id).status, 'declined', 'позднее слово клиники сильнее закрытия');
});

test('без данных пациента — отмена пациентом записанного визита — ждёт клинику 7 суток: решение 20 — о заявках с шифротекстом', () => {
  const s = setup();
  const a = appt(s).row;
  ackInbox(s.db, s.c.clinicId, '1', [{ request_id: a.id, hold_until: isoOf(NOW + 1800000) }], NOW);
  s.db.prepare("UPDATE requests SET status = 'booked' WHERE id = ?").run(a.id);
  partnerCancel(s.db, requestRow(s.db, s.c.clinicId, a.id), NOW);
  assert.deepEqual(closeOverdue(s.db, NOW + 3 * 86400000), { not_processed: 0, not_collected: 0 });
  assert.deepEqual(inboxItems(s.db, s.c.clinicId, 0).map((i) => [i.type, i.sealed]), [['appointment.cancel', undefined]],
    'клиника, выключенная на выходные, всё равно узнает об отмене визита');
  closeOverdue(s.db, NOW + 7 * 86400000 + 1000);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'клиника молчит 7 суток — элемент снят');
  assert.equal(requestRow(s.db, s.c.clinicId, a.id).status, 'booked');
});

test('уборка: статусы старше 90 дней, номера событий старше 30 дней', () => {
  const s = setup();
  appt(s);
  applyEvents(s.db, s.c.clinicId, [{ seq: 1, event: 'x', body: '' }], NOW);
  assert.deepEqual(purgeRequests(s.db, NOW + 31 * 86400000), { requests: 0, events: 1 });
  assert.deepEqual(purgeRequests(s.db, NOW + 91 * 86400000), { requests: 1, events: 0 });
});
```

- [ ] **Step 2:** `node --test public-server/server/store/requests.test.js` → падает: `ERR_MODULE_NOT_FOUND` (`store/requests.js`).
- [ ] **Step 3: модули.**

`public-server/server/store/logs.js`:

```js
// PUBLIC_SERVER_V1 — ЖУРНАЛЫ ДЛЯ КЛИНИКИ: запросы партнёров с ключом и
// попытки доставки уведомлений. Без тел запросов и ответов — метод, путь с
// разрешёнными параметрами, код ответа, подключение, IP, время (дизайн §1).
// Хранятся 30 дней; клиника забирает их в очереди (GET /_sync/v1/inbox с
// access_after / deliveries_after — экраны журнала строит 8d).
import { isoOf } from '../lib/time.js';

export const LOG_KEEP_DAYS = 30;
const DAY = 86400000;
const PAGE_MAX = 200;

export function recordAccess(db, { clinicId, connectionId = null, at, method, path, status, ip = null, ms = null }) {
  db.prepare('INSERT INTO access_log (clinic_id, connection_id, at, method, path, status, ip, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clinicId, connectionId, at, String(method).slice(0, 8), String(path).slice(0, 300), status, ip ? String(ip).slice(0, 64) : null, ms);
}

/** Записи журнала запросов клиники после номера after (по возрастанию). */
export function accessSince(db, clinicId, after, limit = PAGE_MAX) {
  return db.prepare(`SELECT id, connection_id, at, method, path, status, ip, ms FROM access_log
                     WHERE clinic_id = ? AND id > ? ORDER BY id LIMIT ?`).all(clinicId, Number(after) || 0, Math.min(limit, PAGE_MAX));
}

export function appendDeliveryLog(db, e) {
  db.prepare(`INSERT INTO delivery_log (clinic_id, delivery_id, connection_id, request_id, event_id, event, attempt, code, error, at, next_at, final)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.clinicId, e.deliveryId ?? null, e.connectionId ?? null, e.requestId ?? null, e.eventId ?? null, e.event, e.attempt, e.code ?? null,
      e.error ?? null, e.at, e.nextAt ?? null, e.final ?? null);
}

/** Попытки доставки клиники после номера after (по возрастанию). */
export function deliveryLogSince(db, clinicId, after, limit = PAGE_MAX) {
  return db.prepare(`SELECT id, delivery_id, connection_id, request_id, event_id, event, attempt, code, error, at, next_at, final FROM delivery_log
                     WHERE clinic_id = ? AND id > ? ORDER BY id LIMIT ?`).all(clinicId, Number(after) || 0, Math.min(limit, PAGE_MAX));
}

export function purgeLogs(db, now) {
  const old = isoOf(now - LOG_KEEP_DAYS * DAY);
  return {
    access: db.prepare('DELETE FROM access_log WHERE at < ?').run(old).changes,
    deliveries: db.prepare('DELETE FROM delivery_log WHERE at < ?').run(old).changes,
  };
}
```

`public-server/server/store/requests.js`:

```js
// PUBLIC_SERVER_V1 — ЗАЯВКИ ПАРТНЁРОВ И ОЧЕРЕДЬ КЛИНИКЕ.
//
// Заявка партнёра — две строки:
//   • requests — статус для GET /requests/{id}: номер, подключение, врач, время,
//     статус, даты. БЕЗ данных пациента. Живёт 90 дней (дизайн §1);
//   • inbox — элемент очереди клинике: данные пациента ЗАПЕЧАТАНЫ ключом-ящиком
//     клиники (sealFor — X25519 + AES-256-GCM, тот же код, что открывает
//     клиника), сервер их открыть не может. Строка стирается ЦЕЛИКОМ, как только
//     клиника подтвердила курсор (решение владельца 16), — так же, как это делает
//     поддельный сервер стенда 8a (server/test-helpers/fake-public-server.js).
//
// Статус ведёт клиника (её события), сервер лишь записывает своё:
//   • приём: «перезвоните» — new, онлайн-запись — pending (решение 19: и когда
//     клиника не на связи; срок держания назначает клиника при приёме и
//     сообщает в подтверждении очереди — held → hold_until);
//   • ответ партнёра: отмена, согласие и отказ на другое время;
//   • ЗАКРЫТИЕ БЕЗ ОТВЕТА (closed) — 8a оставил это серверу:
//       not_processed — клиника забрала онлайн-запись, но за 30 минут не держит
//         время и ничего не ответила (не открылось её ключом — ключ сменили;
//         клиника не смогла принять) — партнёру «позвоните в клинику»;
//       not_collected — клиника не забрала заявку за сутки (решение владельца 20,
//         2026-10-12; настройка PUBLIC_UNCOLLECTED_MAX_HOURS): шифротекст стёрт.
//     Элементы очереди БЕЗ данных пациента (отмена пациентом, ответ на другое
//     время) решение 20 не касается: они ждут клинику 7 суток — столько, сколько
//     партнёры ещё видят молчащую клинику (дальше — 503, routes/partner-auth.js),
//     иначе клиника, выключенная на выходные, не узнала бы об отмене визита.
//     Уведомления об этом нет: подписать его может только клиника (решение 5),
//     партнёр видит статус в GET /requests/{id}. Пришедшее позже событие клиники
//     сильнее закрытия — клиника правда.
import crypto from 'node:crypto';
import { sealFor } from '../../../server/services/api/sync-identity.js';
import { EVENTS, webhookUrlProblem } from '../../../public/js/shared/api-connections.js';
import { isoOf, msOf } from '../lib/time.js';
import { DEFAULT_UNCOLLECTED_MAX_HOURS } from '../config.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const ANSWER_TIMEOUT_MS = 30 * 60000;
/** Не забранная заявка с шифротекстом — сутки (решение владельца 20; config.js). */
export const UNCOLLECTED_MAX_MS = DEFAULT_UNCOLLECTED_MAX_HOURS * HOUR;
/** Элемент очереди без данных пациента — 7 суток (не короче срока заявок). */
export const PLAIN_ITEM_MAX_MS = 7 * DAY;
export const REQUEST_KEEP_MS = 90 * DAY;
export const EVENTS_SEEN_KEEP_MS = 30 * DAY;
export const INBOX_PAGE = 100;
export const BODY_MAX = 16384;

/** Статусы для партнёра (дизайн §7 + closed этого сервера). */
export const PARTNER_STATUSES = Object.freeze(['new', 'accepted', 'pending', 'offered', 'booked', 'declined', 'expired',
  'cancelled', 'arrived', 'no_show', 'closed']);
const NEW_TYPES = Object.freeze(['request.new', 'appointment.new']);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Номер заявки: rq_ + 24 знака латиницы и цифр (клиника ждёт ^rq_[A-Za-z0-9]{6,37}$). */
export function newRequestId() {
  let s = 'rq_';
  for (let i = 0; i < 24; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export const requestRow = (db, clinicId, id) => db.prepare('SELECT * FROM requests WHERE id = ? AND clinic_id = ?').get(String(id), clinicId) || null;
/** Заявка подключения по номеру партнёра (повтор отправки); нет — null. */
export const requestByExternal = (db, clinicId, connectionId, externalId) =>
  db.prepare('SELECT * FROM requests WHERE clinic_id = ? AND connection_id = ? AND external_id = ?').get(clinicId, connectionId, externalId) || null;

function enqueue(db, { clinicId, type, requestId, connectionId, now, data = {}, sealed = null }) {
  db.prepare('INSERT INTO inbox (clinic_id, type, request_id, connection_id, received_at, data, sealed) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(clinicId, type, requestId, connectionId, isoOf(now), JSON.stringify(data), sealed);
}

/**
 * Приём заявки партнёра. Данные пациента запечатываются здесь и открытыми не
 * хранятся нигде. Повтор с тем же external_id того же подключения — та же заявка.
 * @param {{clinic:object, connectionId:number, kind:'request'|'appointment', externalId?:string, lang?:string,
 *   doctorId?:number, branchId?:number, serviceId?:number, packageId?:number, consultation?:string,
 *   startAt?:string, durationMin?:number, patient:{name:string, phone:string, comment:string}, now:number}} a
 * @returns {{created:boolean, row:object} | {error:'clinic_offline'}}
 */
export function createRequest(db, a) {
  const clinicId = a.clinic.clinic_id;
  if (a.externalId) {
    const existing = requestByExternal(db, clinicId, a.connectionId, a.externalId);
    if (existing) return { created: false, row: existing };
  }
  if (!a.clinic.box_key) return { error: 'clinic_offline' };
  const id = newRequestId();
  const at = isoOf(a.now);
  const sealed = sealFor(a.clinic.box_key, { name: a.patient.name, phone: a.patient.phone, comment: a.patient.comment || '' });
  const appt = a.kind === 'appointment';
  const data = {
    external_id: a.externalId || '', lang: a.lang || '', doctor_id: a.doctorId || null, branch_id: a.branchId || null,
    service_id: a.serviceId || null, package_id: a.packageId || null,
    ...(appt ? { consultation: a.consultation || '', start: a.startAt } : {}),
  };
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO requests (id, clinic_id, connection_id, kind, external_id, doctor_id, branch_id, service_id, package_id,
                    consultation, start_at, duration_min, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, clinicId, a.connectionId, a.kind, a.externalId || null, a.doctorId || null, a.branchId || null, a.serviceId || null,
          a.packageId || null, appt ? (a.consultation || null) : null, appt ? a.startAt : null, appt ? a.durationMin : null,
          appt ? 'pending' : 'new', at, at);
      enqueue(db, { clinicId, type: appt ? 'appointment.new' : 'request.new', requestId: id, connectionId: a.connectionId, now: a.now, data, sealed });
    })();
  } catch (e) {
    // Два одинаковых запроса партнёра в одну миллисекунду: второй получает первую заявку.
    if (a.externalId && String(e && e.code).startsWith('SQLITE_CONSTRAINT')) {
      const existing = requestByExternal(db, clinicId, a.connectionId, a.externalId);
      if (existing) return { created: false, row: existing };
    }
    throw e;
  }
  return { created: true, row: requestRow(db, clinicId, id) };
}

/**
 * Время врача занято своей очередью: онлайн-запись ждёт клинику (pending, срок
 * держания не вышел или ещё не назначен) или встречное предложение ждёт
 * партнёра. Первая линия против двух партнёров на одно время в пределах такта;
 * правду скажет клиника при приёме (slot_taken).
 */
export function queueOverlaps(db, clinicId, doctorId, startMs, durationMin, now) {
  const end = startMs + durationMin * 60000;
  const rows = db.prepare(`SELECT status, start_at, duration_min, hold_until, offered_start, offer_until FROM requests
                           WHERE clinic_id = ? AND doctor_id = ? AND kind = 'appointment' AND status IN ('pending', 'offered')`).all(clinicId, doctorId);
  return rows.some((r) => {
    const live = r.status === 'pending' ? (r.hold_until == null || msOf(r.hold_until) > now) : msOf(r.offer_until) > now;
    const s = msOf(r.status === 'pending' ? r.start_at : r.offered_start);
    const d = (Number(r.duration_min) || 15) * 60000;
    return live && s != null && s < end && startMs < s + d;
  });
}

const touch = (db, id, fields, now) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE requests SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), isoOf(now), id);
};

/**
 * DELETE /appointments/{id} — пациент отменил у партнёра. Ждущая или с
 * предложением — сразу «cancelled» (клиника освободит время без события);
 * записанная — остаётся «booked», пока клиника не отменит визит (событие
 * appointment.cancelled) или не решит вручную (визит уже в работе).
 * @returns {{row:object} | {error:'not_cancellable'}}
 */
export function partnerCancel(db, row, now) {
  if (row.status === 'cancelled' || (row.status === 'booked' && row.cancel_requested_at)) return { row };
  if (!['pending', 'offered', 'booked'].includes(row.status)) return { error: 'not_cancellable' };
  db.transaction(() => {
    const fields = { cancel_requested_at: isoOf(now) };
    if (row.status !== 'booked') Object.assign(fields, { status: 'cancelled', hold_until: null, offered_start: null, offer_until: null });
    touch(db, row.id, fields, now);
    enqueue(db, { clinicId: row.clinic_id, type: 'appointment.cancel', requestId: row.id, connectionId: row.connection_id, now });
  })();
  return { row: requestRow(db, row.clinic_id, row.id) };
}

/**
 * POST /appointments/{id}/accept|decline — ответ партнёра на «другое время».
 * Согласие — снова pending на предложенном времени (срок держания назначит
 * клиника при приёме ответа и сообщит в held); отказ — cancelled.
 * @returns {{row:object} | {error:'not_offered'|'offer_expired'}}
 */
export function partnerAnswerOffer(db, row, accept, now) {
  if (row.status !== 'offered') return { error: 'not_offered' };
  if (accept && !(msOf(row.offer_until) > now)) return { error: 'offer_expired' };
  db.transaction(() => {
    if (accept) {
      touch(db, row.id, { status: 'pending', start_at: row.offered_start, offered_start: null, offer_until: null, hold_until: null,
        delivered_at: null, answered_at: null }, now);
    } else {
      touch(db, row.id, { status: 'cancelled', offered_start: null, offer_until: null, hold_until: null }, now);
    }
    enqueue(db, { clinicId: row.clinic_id, type: accept ? 'offer.accept' : 'offer.decline', requestId: row.id, connectionId: row.connection_id, now });
  })();
  return { row: requestRow(db, row.clinic_id, row.id) };
}

/** GET /_sync/v1/inbox — элементы после курсора, по порядку, как их ждёт parseInboxItem клиники. */
export function inboxItems(db, clinicId, after, limit = INBOX_PAGE) {
  return db.prepare('SELECT * FROM inbox WHERE clinic_id = ? AND cursor > ? ORDER BY cursor LIMIT ?')
    .all(clinicId, Number(after) || 0, Math.min(limit, INBOX_PAGE))
    .map((r) => {
      let data = {};
      try { data = JSON.parse(r.data); } catch { data = {}; }
      return {
        cursor: String(r.cursor), type: r.type, public_id: r.request_id, connection_id: r.connection_id, received_at: r.received_at, data,
        ...(r.sealed ? { sealed: r.sealed } : {}),
      };
    });
}

/**
 * POST /_sync/v1/inbox/ack {cursor, held} — клиника применила всё до курсора.
 * Элементы до курсора стираются ЦЕЛИКОМ вместе с шифротекстом (решение 16);
 * held — заявки, которые клиника держит, и до какого мгновения (решения 18–19).
 * @returns {{ok:true, deleted:number} | {error:'bad_request'}}
 */
export function ackInbox(db, clinicId, cursor, held, now) {
  const c = Number(cursor);
  if (!Number.isInteger(c) || c < 0) return { error: 'bad_request' };
  const at = isoOf(now);
  let deleted = 0;
  db.transaction(() => {
    const delivered = db.prepare(`SELECT request_id FROM inbox WHERE clinic_id = ? AND cursor <= ? AND type IN ('request.new', 'appointment.new', 'offer.accept')`)
      .all(clinicId, c);
    const mark = db.prepare(`UPDATE requests SET delivered_at = COALESCE(delivered_at, ?),
                               answered_at = CASE WHEN kind = 'request' THEN COALESCE(answered_at, ?) ELSE answered_at END
                             WHERE id = ? AND clinic_id = ?`);
    for (const r of delivered) mark.run(at, at, r.request_id, clinicId);
    const hold = db.prepare(`UPDATE requests SET hold_until = ?, answered_at = COALESCE(answered_at, ?), updated_at = ?
                             WHERE id = ? AND clinic_id = ? AND status = 'pending'`);
    for (const h of Array.isArray(held) ? held.slice(0, 1000) : []) {
      const until = msOf(h && h.hold_until);
      if (until != null && h && typeof h.request_id === 'string') hold.run(isoOf(until), at, at, h.request_id, clinicId);
    }
    deleted = db.prepare('DELETE FROM inbox WHERE clinic_id = ? AND cursor <= ?').run(clinicId, c).changes;
  })();
  return { ok: true, deleted };
}

/** Статус заявки по событию клиники (тело — белый список webhookBody клиники). */
function applyStatus(db, clinicId, body, now) {
  const row = typeof body.request_id === 'string' ? requestRow(db, clinicId, body.request_id) : null;
  if (!row || !PARTNER_STATUSES.includes(body.status)) return row;
  const at = isoOf(now);
  // Партнёр уже отменил, а клиника, не дойдя до отмены в очереди, отпустила время
  // («истекло» / отказ): для партнёра заявка остаётся отменённой.
  if (row.cancel_requested_at && row.status === 'cancelled' && ['declined', 'expired'].includes(body.status)) {
    touch(db, row.id, { answered_at: row.answered_at || at }, now);
    return row;
  }
  const iso = (v) => { const t = msOf(v); return t == null ? null : isoOf(t); };
  const fields = { status: body.status, answered_at: row.answered_at || at,
    reason: ['declined', 'expired'].includes(body.status) ? String(body.reason || '').slice(0, 32) || null : null };
  if (body.start) fields.start_at = iso(body.start) || row.start_at;
  if (Number.isInteger(body.doctor_id) && body.doctor_id > 0) fields.doctor_id = body.doctor_id;
  if (Number.isInteger(body.branch_id) && body.branch_id > 0) fields.branch_id = body.branch_id;
  if (body.status === 'offered') Object.assign(fields, { offered_start: iso(body.offered_start), offer_until: iso(body.offer_until), hold_until: null });
  else Object.assign(fields, { offered_start: null, offer_until: null });
  if (body.status !== 'pending' && body.status !== 'offered') fields.hold_until = null;
  touch(db, row.id, fields, now);
  return requestRow(db, clinicId, row.id);
}

const SIGNATURE_RE = /^sha256=[0-9a-f]{64}$/;

/**
 * POST /_sync/v1/events — события клиники по порядку. Принимается КАЖДОЕ
 * событие с номером, даже испорченное: клиника шлёт события строго по порядку и
 * повторяет непринятое каждый такт, так что одно отвергнутое навсегда
 * остановило бы все следующие (public-sync.js pushEvents).
 * Есть адрес и подпись клиники — уведомление встаёт в очередь доставки.
 * @returns {{accepted:number[]}}
 */
export function applyEvents(db, clinicId, events, now) {
  const accepted = [];
  const at = isoOf(now);
  const seen = db.prepare('SELECT 1 FROM events_seen WHERE clinic_id = ? AND seq = ?');
  for (const e of Array.isArray(events) ? events.slice(0, 500) : []) {
    const seq = Number(e && e.seq);
    if (!Number.isInteger(seq) || seq <= 0) continue;
    if (seen.get(clinicId, seq)) { accepted.push(seq); continue; }
    db.transaction(() => {
      db.prepare('INSERT INTO events_seen (clinic_id, seq, received_at) VALUES (?, ?, ?)').run(clinicId, seq, at);
      const raw = typeof e.body === 'string' && e.body.length <= BODY_MAX ? e.body : '';
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      if (!body || typeof body !== 'object' || !EVENTS.includes(e.event) || body.event !== e.event) return;
      const row = applyStatus(db, clinicId, body, now);
      const url = String(e.webhook_url || '');
      const signature = String(e.signature || '');
      if (!url || !SIGNATURE_RE.test(signature) || webhookUrlProblem(url)) return;
      db.prepare(`INSERT INTO deliveries (clinic_id, connection_id, request_id, event_id, event, url, body, signature, next_at, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(clinicId, row ? row.connection_id : null, String(body.request_id || '') || null, String(body.event_id || '').slice(0, 64), e.event,
          url, raw, signature, at, at, at);
    })();
    accepted.push(seq);
  }
  return { accepted };
}

/**
 * Фон: закрыть то, на что клиника не ответит. → {not_processed, not_collected}
 * uncollectedMaxMs — срок не забранной заявки с шифротекстом (config.js
 * uncollectedMaxMs, PUBLIC_UNCOLLECTED_MAX_HOURS); элементы без данных пациента
 * ждут PLAIN_ITEM_MAX_MS, но не меньше этого срока.
 */
export function closeOverdue(db, now, { uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
  const at = isoOf(now);
  const sealedBefore = isoOf(now - uncollectedMaxMs);
  const plainBefore = isoOf(now - Math.max(PLAIN_ITEM_MAX_MS, uncollectedMaxMs));
  let notProcessed = 0;
  let notCollected = 0;
  db.transaction(() => {
    notProcessed = db.prepare(`UPDATE requests SET status = 'closed', reason = 'not_processed', updated_at = ?
                               WHERE kind = 'appointment' AND status = 'pending' AND delivered_at IS NOT NULL AND answered_at IS NULL
                                 AND hold_until IS NULL AND delivered_at <= ?`).run(at, isoOf(now - ANSWER_TIMEOUT_MS)).changes;
    // plainBefore не позже sealedBefore (срок без данных — не короче), поэтому
    // кандидаты — всё, что старше sealedBefore.
    const old = db.prepare('SELECT cursor, clinic_id, type, request_id, received_at FROM inbox WHERE received_at <= ?').all(sealedBefore);
    const close = db.prepare(`UPDATE requests SET status = 'closed', reason = 'not_collected', updated_at = ?
                              WHERE id = ? AND clinic_id = ? AND status IN ('new', 'pending')`);
    const del = db.prepare('DELETE FROM inbox WHERE cursor = ?');
    for (const it of old) {
      if (NEW_TYPES.includes(it.type)) {
        if (it.received_at > sealedBefore) continue;
        notCollected += close.run(at, it.request_id, it.clinic_id).changes;
      } else if (it.received_at > plainBefore) continue;
      del.run(it.cursor);
    }
  })();
  return { not_processed: notProcessed, not_collected: notCollected };
}

/** Фон: статусы старше 90 дней и номера событий старше 30 дней. */
export function purgeRequests(db, now) {
  return {
    requests: db.prepare('DELETE FROM requests WHERE updated_at < ?').run(isoOf(now - REQUEST_KEEP_MS)).changes,
    events: db.prepare('DELETE FROM events_seen WHERE received_at < ?').run(isoOf(now - EVENTS_SEEN_KEEP_MS)).changes,
  };
}
```

- [ ] **Step 4:** тест зелёный — **11 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 5: коммит** «Публичный сервер, заявки и очередь: данные пациента запечатываются ключом клиники в миг приёма и стираются целиком при подтверждении курсора; срок держания — от клиники (held); статус ведут события клиники, каждое событие с номером принимается, уведомление — только с её адресом и подписью; отмена и ответ на другое время; закрытие без ответа: not_processed через 30 минут, not_collected через 7 дней».

---

## Task 5: Канал клиники `/_sync/v1/*` — ровно протокол поддельного сервера 8a (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/routes/sync.js`
- Create: `public-server/server/routes/sync.http.test.js`

- [ ] **Step 1: падающий тест** `public-server/server/routes/sync.http.test.js`:

```js
// PUBLIC_SERVER_V1 — канал клиники по HTTP: подписанные запросы стенда, ответы
// протокола §10 (те же, что у поддельного сервера 8a), лицензия и лимит.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncRouter } from './sync.js';
import { createRequest } from '../store/requests.js';
import { clinicRow } from '../store/clinics.js';
import { recordAccess } from '../store/logs.js';
import { testDb, testVendor, testClinic, serve, syncCall, NOW } from '../test-helpers/fixture.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { openSealed } from '../../../server/services/api/sync-identity.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const time = isoOf(NOW);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function stand(over = {}) {
  const { db, dir } = testDb();
  const ctx = { db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false, ...over };
  const srv = await serve('/_sync/v1', syncRouter(ctx));
  return { db, dir, ctx, ...srv };
}
const keys = (c, at = NOW) => ({ generated_at: isoOf(at), box_key: c.identity.boxPublic, connections: [{ id: 3, kind: 'partner', active: true,
  key_hash: hash('k'), scopes: ['clinic'], rate_limit: 60, key_expires_at: null, ip_allow: [], origins: [] }] });
const snapshot = (slug) => ({ version: 1, generated_at: time, slug, clinic: { name: { ru: 'Шифо' } }, branches: [], doctors: [], services: [], packages: [] });

test('ключи, снимок, время, файлы, события — ответы протокола; чужое имя — 409 slug_taken', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const call = (m, p, b, o) => syncCall(s.base, c, m, p, b, { time, ...o });
  assert.deepEqual((await call('PUT', '/_sync/v1/keys', keys(c))).json, { ok: true });
  assert.deepEqual((await call('PUT', '/_sync/v1/snapshot', snapshot('shifo'))).json, { ok: true });
  assert.deepEqual((await call('PUT', '/_sync/v1/slots', { generated_at: time, slot_minutes: 15, doctors: {} })).json, { ok: true });
  const png = fakePng(32, 32);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  assert.deepEqual((await call('POST', '/_sync/v1/media/check', { hashes: [sha] })).json, { missing: [sha] });
  assert.deepEqual((await call('PUT', '/_sync/v1/media/' + sha + '.png', png, { type: 'image/png' })).json, { ok: true });
  assert.deepEqual((await call('POST', '/_sync/v1/media/check', { hashes: [sha] })).json, { missing: [] });
  assert.equal((await call('PUT', '/_sync/v1/media/' + sha + '.png', Buffer.from('чужое'), { type: 'image/png' })).status, 400);
  assert.deepEqual((await call('POST', '/_sync/v1/events', { events: [{ seq: 5, event: 'booking.confirmed', body: '{}' }] })).json, { accepted: [5] });
  const other = testClinic(vendor, { clinicId: 'c-000778' });
  const taken = await syncCall(s.base, other, 'PUT', '/_sync/v1/snapshot', snapshot('shifo'), { time });
  assert.deepEqual([taken.status, taken.json.error.code], [409, 'slug_taken']);
  assert.equal((await call('PUT', '/_sync/v1/snapshot', Buffer.from('{не json'))).status, 400, 'не JSON — 400');
  assert.equal((await call('GET', '/_sync/v1/nothing')).status, 404);
  assert.equal(clinicRow(s.db, c.clinicId).slug, 'shifo');
});

test('очередь: элементы по курсору с запечатанным пациентом; подтверждение стирает; last_used и журналы для 8d — по просьбе', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const call = (m, p, b) => syncCall(s.base, c, m, p, b, { time });
  await call('PUT', '/_sync/v1/keys', keys(c));
  const made = createRequest(s.db, { clinic: clinicRow(s.db, c.clinicId), connectionId: 3, kind: 'request',
    patient: { name: 'ИМЯ_ПАЦИЕНТА', phone: '+998901112233', comment: '' }, now: NOW });
  recordAccess(s.db, { clinicId: c.clinicId, connectionId: 3, at: time, method: 'GET', path: '/shifo/v1/doctors', status: 200 });
  s.db.prepare('UPDATE connections SET last_used_at = ?').run(time);
  const inbox = await call('GET', '/_sync/v1/inbox?after=');
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.items.length, 1);
  assert.equal(inbox.json.items[0].public_id, made.row.id);
  assert.equal(openSealed(c.identity, inbox.json.items[0].sealed).name, 'ИМЯ_ПАЦИЕНТА');
  assert.deepEqual(inbox.json.last_used, { 3: time });
  assert.equal(inbox.json.access, undefined, 'клиника 8a журналов не просит — их нет');
  const more = await call('GET', '/_sync/v1/inbox?after=0&access_after=0&deliveries_after=0');
  assert.equal(more.json.access.length, 1);
  assert.deepEqual(more.json.deliveries, []);
  assert.deepEqual((await call('POST', '/_sync/v1/inbox/ack', { cursor: inbox.json.items[0].cursor, held: [] })).json, { ok: true });
  assert.deepEqual((await call('GET', '/_sync/v1/inbox?after=' + inbox.json.items[0].cursor)).json.items, []);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'шифротекст стёрт при подтверждении');
});

test('отказы: подпись, часы, срок лицензии — 503; «не оплачено» канал не закрывает; лимит — 429 с Retry-After', async (t) => {
  const s = await stand();
  t.after(s.close);
  const c = testClinic(vendor);
  const forged = await fetch(s.base + '/_sync/v1/keys', { method: 'PUT', headers: { 'X-EasyMed-Clinic': c.clinicId }, body: '{}' });
  assert.equal(forged.status, 401);
  const skew = await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', keys(c), { time: isoOf(NOW - 3600000) });
  assert.deepEqual([skew.status, skew.json.error.code, skew.json.error.server_time], [401, 'clock_skew', time]);
  const lapsed = testClinic(vendor, { clinicId: 'c-000779', validUntil: '2030-03-01T00:00:00Z' });
  const l = await syncCall(s.base, lapsed, 'GET', '/_sync/v1/inbox?after=', undefined, { time });
  assert.deepEqual([l.status, l.json.error.code], [503, 'licence_lapsed']);
  const unpaid = testClinic(vendor, { clinicId: 'c-000780', subscription: 'unpaid' });
  assert.equal((await syncCall(s.base, unpaid, 'GET', '/_sync/v1/inbox?after=', undefined, { time })).status, 200);

  const limited = await stand({ limiter: { hit: () => ({ ok: false, retryAfterSec: 12 }) } });
  t.after(limited.close);
  const r = await syncCall(limited.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time });
  assert.deepEqual([r.status, r.headers.get('retry-after'), r.json.error.code], [429, '12', 'rate_limited']);
});

test('только https: без него канал не открывается', async (t) => {
  const s = await stand({ requireHttps: true });
  t.after(s.close);
  const c = testClinic(vendor);
  const r = await syncCall(s.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time });
  assert.deepEqual([r.status, r.json.error.code], [400, 'https_required']);
});
```

- [ ] **Step 2:** `node --test public-server/server/routes/sync.http.test.js` → падает: `ERR_MODULE_NOT_FOUND` (`routes/sync.js`).
- [ ] **Step 3: модуль** `public-server/server/routes/sync.js`:

```js
// PUBLIC_SERVER_V1 — КАНАЛ КЛИНИКИ /_sync/v1/* (дизайн шага 8, §10).
//
// Ровно тот протокол, на котором сторона клиники (services/api/public-sync.js)
// прогнана против поддельного сервера (server/test-helpers/fake-public-server.js):
//   PUT  /keys           {generated_at, box_key, connections:[…]}        → {ok}
//   POST /media/check    {hashes:[sha256…]}                              → {missing:[…]}
//   PUT  /media/<sha256>.<ext>  байты файла                              → {ok}
//   PUT  /snapshot       {version, generated_at, slug, clinic, …}        → {ok} | 409 slug_taken
//   PUT  /slots          {generated_at, slot_minutes, doctors:{…}}       → {ok}
//   POST /events         {events:[{seq, event, status, body, webhook_url, signature}]} → {accepted:[seq…]}
//   GET  /inbox?after=<курсор>                                           → {items:[…], last_used:{…}}
//   POST /inbox/ack      {cursor, held:[{request_id, hold_until}]}       → {ok}
// Ответы-отказы: 401 (подпись, ключ, лицензия, часы), 503 licence_lapsed
// (срок лицензии вышел), 409 slug_taken, 429 (с Retry-After).
//
// Сверх протокола 8a — для экранов журнала 8d (клиника 8a их не просит, и
// ничего лишнего ей не уходит): GET /inbox?…&access_after=<id> добавляет
// access (журнал запросов с ключом), &deliveries_after=<id> — deliveries
// (попытки доставки уведомлений); last_used — «последний запрос» подключений.
//
// ТЕЛО ЧИТАЕТСЯ СЫРЫМ: подпись клиники — от sha256 точных байтов тела, поэтому
// сначала байты (express.raw, не больше 4 МБ), потом проверка, потом разбор.
import express from 'express';
import { verifyClinicRequest } from '../clinic-auth.js';
import { licenceStanding } from '../licence-gate.js';
import { admitClinic, saveKeys, saveSnapshot, saveSlots } from '../store/clinics.js';
import { missingMedia, putMedia } from '../store/media.js';
import { inboxItems, ackInbox, applyEvents } from '../store/requests.js';
import { accessSince, deliveryLogSince } from '../store/logs.js';
import { sendError } from '../lib/errors.js';

export const SYNC_LIMIT_PER_MIN = 600;
const BODY_LIMIT = '4mb';
const MEDIA_RE = /^([0-9a-f]{64})\.([a-z]{3,4})$/;

/**
 * @param {{db, dataDir:string, now:()=>number, licencePublicKey?:object|null, skewMs?:number, requireHttps?:boolean,
 *   limiter?:{hit:(key:string, limit:number, now:number)=>{ok:boolean, retryAfterSec?:number}}}} ctx
 */
export function syncRouter(ctx) {
  const r = express.Router();
  // Потолок по IP — ДО чтения тела: чужой без подписи не заставит сервер
  // принимать мегабайты в память раз за разом.
  r.use((req, res, next) => {
    if (!ctx.limiter) return next();
    const ip = String(req.ip || '').replace(/^::ffff:(?=\d{1,3}(?:\.\d{1,3}){3}$)/i, '');
    const hit = ctx.limiter.hit('syncip:' + ip, SYNC_LIMIT_PER_MIN, ctx.now());
    return hit.ok ? next() : sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
  });
  r.use(express.raw({ type: () => true, limit: BODY_LIMIT }));
  r.use((req, res, next) => {
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    const now = ctx.now();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const auth = verifyClinicRequest({ method: req.method, url: req.originalUrl, headers: req.headers, body },
      { licencePublicKey: ctx.licencePublicKey || null, now, skewMs: ctx.skewMs });
    if (!auth.ok) return sendError(req, res, auth.code, auth.server_time ? { server_time: auth.server_time } : {});
    const adm = admitClinic(ctx.db, auth, now);
    if (!adm.ok) return sendError(req, res, adm.code);
    if (licenceStanding(adm.clinic, now) === 'lapsed') return sendError(req, res, 'licence_lapsed');
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('sync:' + auth.clinicId, SYNC_LIMIT_PER_MIN, now);
      if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
    }
    req.clinic = adm.clinic;
    req.raw = body;
    return next();
  });

  const parse = (req) => { try { return JSON.parse(req.raw.length ? req.raw.toString('utf8') : '{}'); } catch { return undefined; } };
  const withJson = (fn) => (req, res) => {
    const body = parse(req);
    if (body === undefined) return sendError(req, res, 'bad_json');
    const out = fn(req, body, ctx.now());
    if (out && out.error) return sendError(req, res, out.error);
    return res.json(out && out.payload ? out.payload : { ok: true });
  };

  r.put('/keys', withJson((req, body, now) => saveKeys(ctx.db, req.clinic.clinic_id, body, now)));
  r.put('/snapshot', withJson((req, body, now) => saveSnapshot(ctx.db, req.clinic.clinic_id, body, now)));
  r.put('/slots', withJson((req, body, now) => saveSlots(ctx.db, req.clinic.clinic_id, body, now)));
  r.post('/media/check', withJson((req, body) => ({ payload: { missing: missingMedia(ctx.db, req.clinic.clinic_id, body.hashes) } })));
  r.put('/media/:file', (req, res) => {
    const m = MEDIA_RE.exec(String(req.params.file || ''));
    if (!m) return sendError(req, res, 'bad_request');
    const out = putMedia(ctx.db, ctx.dataDir, req.clinic.clinic_id, m[1], m[2], req.raw, ctx.now());
    return out.error ? sendError(req, res, out.error) : res.json({ ok: true });
  });
  r.post('/events', withJson((req, body, now) => ({ payload: applyEvents(ctx.db, req.clinic.clinic_id, body.events, now) })));
  r.get('/inbox', (req, res) => {
    const id = req.clinic.clinic_id;
    const out = { items: inboxItems(ctx.db, id, req.query.after) };
    out.last_used = Object.fromEntries(ctx.db.prepare('SELECT id, last_used_at FROM connections WHERE clinic_id = ? AND last_used_at IS NOT NULL')
      .all(id).map((c) => [String(c.id), c.last_used_at]));
    if (req.query.access_after !== undefined) out.access = accessSince(ctx.db, id, req.query.access_after);
    if (req.query.deliveries_after !== undefined) out.deliveries = deliveryLogSince(ctx.db, id, req.query.deliveries_after);
    return res.json(out);
  });
  r.post('/inbox/ack', withJson((req, body, now) => ackInbox(ctx.db, req.clinic.clinic_id, body.cursor, body.held, now)));
  r.use((req, res) => sendError(req, res, 'not_found'));
  return r;
}
```

- [ ] **Step 4:** тест зелёный — **4 теста** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 5: коммит** «Публичный сервер, канал клиники /_sync/v1: ключи, снимок с занятостью имени, время, файлы, события, очередь с курсором и подтверждением — ровно протокол поддельного сервера 8a; тело читается сырым для подписи; срок лицензии вышел — 503, «не оплачено» — канал открыт; для журналов 8d — access и deliveries по просьбе клиники».

---

## Task 6: Лимиты и адреса — скользящее окно, «Разрешённые IP», публичные адреса для уведомлений (PUBLIC_SERVER_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/lib/rate-limit.js`, `public-server/server/lib/rate-limit.test.js`
- Create: `public-server/server/lib/net-guard.js`, `public-server/server/lib/net-guard.test.js`

- [ ] **Step 1: падающие тесты.**

`public-server/server/lib/rate-limit.test.js`:

```js
// PUBLIC_SERVER_V1 — лимит в минуту: до лимита — да, сверх — отказ с
// Retry-After; окно скользит; ключи независимы; корзины не растут без конца.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from './rate-limit.js';

const T0 = Date.parse('2030-03-11T04:00:00Z');   // ровно начало минуты

test('до лимита — да, сверх — отказ с Retry-After до конца минуты', () => {
  const l = createLimiter();
  for (let i = 0; i < 60; i += 1) assert.equal(l.hit('k', 60, T0 + i * 100).ok, true, 'запрос ' + (i + 1));
  const no = l.hit('k', 60, T0 + 10000);
  assert.deepEqual(no, { ok: false, retryAfterSec: 50 });
  assert.equal(l.hit('другой', 60, T0 + 10000).ok, true, 'ключи независимы');
});

test('окно скользит: в начале следующей минуты прошлая ещё весит, потом отпускает', () => {
  const l = createLimiter();
  for (let i = 0; i < 60; i += 1) l.hit('k', 60, T0 + 59000);
  const early = l.hit('k', 60, T0 + 60000 + 500);
  assert.equal(early.ok, false, 'через полсекунды после смены минуты прошлые 60 ещё почти все в окне');
  assert.ok(early.retryAfterSec >= 1 && early.retryAfterSec <= 60);
  assert.equal(l.hit('k', 60, T0 + 60000 + 500 + early.retryAfterSec * 1000).ok, true, 'через Retry-After — можно');
  assert.equal(l.hit('k', 60, T0 + 180000).ok, true, 'через две минуты — с чистого листа');
});

test('корзины не растут без конца', () => {
  const l = createLimiter({ maxBuckets: 100 });
  for (let i = 0; i < 1000; i += 1) l.hit('ip' + i, 10, T0);
  assert.ok(l.size() <= 100);
  l.sweep(T0 + 3 * 60000);
  assert.equal(l.size(), 0);
});
```

`public-server/server/lib/net-guard.test.js`:

```js
// PUBLIC_SERVER_V1 — адреса: «Разрешённые IP» (адрес и подсеть, IPv4 и IPv6,
// неверная запись — никого); уведомления — только на публичные адреса, и
// проверка — в самом подключении (DNS rebinding).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ipAllowed, clientIp, isPublicAddress, blockedList, guardedLookup, SsrfError } from './net-guard.js';

test('«Разрешённые IP»: пусто — все; адрес и подсеть; IPv6; запись с ошибкой — никого', () => {
  assert.equal(ipAllowed([], '198.51.100.1'), true);
  assert.equal(ipAllowed(['203.0.113.7'], '203.0.113.7'), true);
  assert.equal(ipAllowed(['203.0.113.7'], '::ffff:203.0.113.7'), true, 'IPv4 в записи IPv6');
  assert.equal(ipAllowed(['203.0.113.7'], '203.0.113.8'), false);
  assert.equal(ipAllowed(['203.0.113.0/24'], '203.0.113.200'), true);
  assert.equal(ipAllowed(['2001:db8::/32'], '2001:db8::5'), true);
  assert.equal(ipAllowed(['2001:db8::/32'], '2001:db9::5'), false);
  assert.equal(ipAllowed(['203.0.113.7', 'мусор'], '203.0.113.7'), false, 'неверная запись не расширяет доступ');
  assert.equal(ipAllowed(['203.0.113.0/33'], '203.0.113.7'), false);
  assert.equal(ipAllowed(['203.0.113.7'], ''), false);
  assert.equal(clientIp('::ffff:10.1.2.3'), '10.1.2.3');
});

test('публичный адрес: частные, петлевые, локальные, метаданные облака, служебные — нет; адрес самой машины — нет', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', 'не ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '45.77.242.169', '2a00:1450:4001:80b::200e']) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress('45.77.242.169', blockedList(['45.77.242.169'])), false, 'сам себе — нет');
});

const lookupOf = (addrs) => guardedLookup({ resolve: async () => addrs });
const call = (fn, opts) => new Promise((resolve) => fn('hook.partner.uz', opts, (err, a, f) => resolve({ err, a, f })));

test('lookup подключения: публичное — отдаёт; хоть один частный — отказ; пусто — отказ; ошибка DNS — отказ', async () => {
  const ok = await call(lookupOf([{ address: '8.8.8.8', family: 4 }]), {});
  assert.deepEqual([ok.err, ok.a, ok.f], [null, '8.8.8.8', 4]);
  const all = await call(lookupOf([{ address: '8.8.8.8', family: 4 }, { address: '2a00:1450:4001:80b::200e', family: 6 }]), { all: true });
  assert.equal(all.a.length, 2);
  const mixed = await call(lookupOf([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), {});
  assert.ok(mixed.err instanceof SsrfError);
  assert.equal(mixed.err.code, 'blocked_address');
  assert.equal((await call(lookupOf([]), {})).err.code, 'no_address');
  const broken = guardedLookup({ resolve: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal((await call(broken, {})).err.code, 'dns_failed');
});
```

- [ ] **Step 2:** `node --test public-server/server/lib/rate-limit.test.js public-server/server/lib/net-guard.test.js` → падают: `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: модули.**

`public-server/server/lib/rate-limit.js`:

```js
// PUBLIC_SERVER_V1 — ЛИМИТЫ ЗАПРОСОВ: скользящее окно в минуту (дизайн §9).
//
// Окно — два соседних отрезка по минуте с весом (оценка «сколько было за
// последние 60 секунд»): на ключ хватает трёх чисел, а не списка отметок, —
// память не растёт от потока запросов с тысячи адресов. Корзин не больше
// maxBuckets: при переполнении сначала уходят старые, потом — десятая часть
// подряд (лимит на время забывается, но процесс не падает от нехватки памяти:
// машина общая — решение 16).
//
// hit(key, limit, now) → {ok:true, remaining} | {ok:false, retryAfterSec}
// Retry-After — через сколько секунд оценка опустится ниже лимита.
export const WINDOW_MS = 60000;

export function createLimiter({ windowMs = WINDOW_MS, maxBuckets = 50000 } = {}) {
  const buckets = new Map();

  function sweep(now) {
    for (const [k, b] of buckets) if (now - b.start >= 2 * windowMs) buckets.delete(k);
    if (buckets.size >= maxBuckets) {
      let n = Math.ceil(maxBuckets / 10);
      for (const k of buckets.keys()) { buckets.delete(k); if (--n <= 0) break; }
    }
  }

  function hit(key, limit, now) {
    const winStart = Math.floor(now / windowMs) * windowMs;
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxBuckets) sweep(now);
      b = { start: winStart, curr: 0, prev: 0 };
      buckets.set(key, b);
    }
    if (b.start !== winStart) {
      b.prev = b.start === winStart - windowMs ? b.curr : 0;
      b.curr = 0;
      b.start = winStart;
    }
    const elapsed = now - winStart;
    const estimate = b.prev * (1 - elapsed / windowMs) + b.curr;
    if (estimate + 1 > limit) {
      const waitMs = b.curr + 1 > limit
        ? windowMs - elapsed
        : windowMs * (1 - (limit - 1 - b.curr) / b.prev) - elapsed;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    b.curr += 1;
    return { ok: true, remaining: Math.max(0, Math.floor(limit - estimate - 1)) };
  }

  return { hit, sweep, size: () => buckets.size };
}
```

`public-server/server/lib/net-guard.js` — IPv4 внутри IPv6 `net.BlockList` сверяет с правилами IPv4 сам. Правило `::ffff:0:0/96` закрыло бы все публичные IPv4 — проверено при подготовке плана:

```js
// PUBLIC_SERVER_V1 — АДРЕСА: кто пришёл (IP партнёра, «Разрешённые IP») и
// куда можно ходить (уведомления партнёрам — защита от подделки запроса
// изнутри, SSRF).
//
// УВЕДОМЛЕНИЕ уходит на адрес, который вписал администратор клиники. Если бы
// сервер слал куда угодно, адрес https://localhost:5678/… или имя, которое
// резолвится в 10.x / 127.x / 169.254.169.254 (метаданные облака), открыл бы
// наружу службы этой машины — а на 45.77.242.169 живут Symptex, n8n и старый
// шлюз (решение 16). Поэтому:
//   • все адреса, в которые резолвится имя, — публичные (ни одного частного,
//     петлевого, локального, служебного, многоадресного, документационного,
//     ни адреса самой машины — PUBLIC_SELF_IPS);
//   • проверка — В САМОМ ПОДКЛЮЧЕНИИ (guardedLookup — функция lookup сокета):
//     соединение идёт ровно на проверенный адрес, и подмена ответа DNS между
//     «проверили» и «подключились» (DNS rebinding) ничего не даёт.
import dns from 'node:dns';
import net from 'node:net';

export class SsrfError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv4 внутри IPv6 (::ffff:a.b.c.d) BlockList сверяет с правилами IPv4 сам —
// отдельное правило ::ffff:0:0/96 закрыло бы и все публичные IPv4.
const V6_BLOCKED = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

/** Список запрещённых адресов; selfIps — адреса этой машины. */
export function blockedList(selfIps = []) {
  const list = new net.BlockList();
  for (const [a, p] of V4_BLOCKED) list.addSubnet(a, p, 'ipv4');
  for (const [a, p] of V6_BLOCKED) list.addSubnet(a, p, 'ipv6');
  for (const ip of selfIps) {
    const fam = net.isIP(ip);
    if (fam) list.addAddress(ip, fam === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** Адрес публичный: IP и не в запрещённом списке. */
export function isPublicAddress(ip, list = blockedList()) {
  const fam = net.isIP(String(ip || ''));
  if (!fam) return false;
  return !list.check(String(ip), fam === 6 ? 'ipv6' : 'ipv4');
}

/** IP клиента: '::ffff:203.0.113.7' → '203.0.113.7'. */
export function clientIp(raw) {
  const s = String(raw || '').trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}

/**
 * «Разрешённые IP» подключения: пусто — с любого адреса; иначе адрес — в
 * одном из адресов или подсетей. Неверная запись в списке — ключ не пускается
 * ни с какого адреса: молча выкинуть её значило бы расширить доступ.
 */
export function ipAllowed(entries, ip) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return true;
  const who = clientIp(ip);
  const fam = net.isIP(who);
  if (!fam) return false;
  const allow = new net.BlockList();
  for (const e of list) {
    const [addr, prefix, extra] = String(e).trim().split('/');
    const f = net.isIP(addr);
    if (!f || extra !== undefined) return false;
    const type = f === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) { allow.addAddress(addr, type); continue; }
    const p = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || p > (f === 6 ? 128 : 32)) return false;
    allow.addSubnet(addr, p, type);
  }
  return allow.check(who, fam === 6 ? 'ipv6' : 'ipv4');
}

/** Все адреса имени (A и AAAA). */
export const resolveAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Функция lookup для сокета: резолвит, проверяет КАЖДЫЙ адрес и отдаёт
 * сокету только проверенные. Хоть один запрещённый — отказ целиком.
 */
export function guardedLookup({ resolve = resolveAll, list = blockedList() } = {}) {
  return (hostname, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    const opts = typeof options === 'object' && options ? options : {};
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((addrs) => {
        const all = (Array.isArray(addrs) ? addrs : []).filter((a) => a && net.isIP(a.address));
        if (!all.length) throw new SsrfError('no_address');
        if (all.some((a) => !isPublicAddress(a.address, list))) throw new SsrfError('blocked_address');
        const out = all.map((a) => ({ address: a.address, family: net.isIP(a.address) }));
        if (opts.all) done(null, out);
        else done(null, out[0].address, out[0].family);
      })
      .catch((e) => done(e instanceof SsrfError ? e : new SsrfError('dns_failed')));
  };
}
```

- [ ] **Step 4:** тесты зелёные — **6 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 5: коммит** «Публичный сервер, лимиты и адреса: скользящее окно в минуту с Retry-After и ограниченной памятью; «Разрешённые IP» — адрес и подсеть, IPv4 и IPv6, неверная запись — никого; для уведомлений — только публичные адреса, проверка в самом соединении (DNS rebinding), адреса самой машины — запрещены».

---

## Task 7: Справочники и свободное время — из программы и по присланному (PUBLIC_SERVER_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/lib/reference.js`, `public-server/server/lib/reference.test.js`
- Create: `public-server/server/lib/slot-check.js`, `public-server/server/lib/slot-check.test.js`

- [ ] **Step 1: падающие тесты.**

`public-server/server/lib/reference.test.js`:

```js
// PUBLIC_SERVER_V1 — справочники для партнёров — ровно справочники программы:
// все коды географии модуля с тремя названиями из миграции 132 и в порядке
// бланка; все специальности со слагами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { geoReference, specialtiesReference, regionRow, districtRow, countryRow, parseGeoSql } from './reference.js';
import { GEO_COUNTRY_CODES, GEO_REGION_CODES, GEO_DISTRICT_CODES } from '../../../public/js/shared/geo-codes.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

const cyr = /[а-яё]/i;

test('география: 7 стран, 14 регионов, 206 районов — коды модуля, порядок бланка, три названия у каждого', () => {
  const g = geoReference();
  assert.deepEqual(g.countries.map((c) => c.code), [...GEO_COUNTRY_CODES]);
  assert.deepEqual(g.cities.map((c) => c.slug), [...GEO_REGION_CODES]);
  assert.deepEqual(g.cities.flatMap((c) => c.districts.map((d) => d.slug)), [...GEO_DISTRICT_CODES]);
  for (const item of [...g.countries, ...g.cities, ...g.cities.flatMap((c) => c.districts)]) {
    assert.ok(item.name.ru && item.name.uz && item.name.en, JSON.stringify(item));
    assert.ok(!cyr.test(item.name.uz) && !cyr.test(item.name.en), 'кириллица в uz/en: ' + JSON.stringify(item.name));
  }
  const tash = g.cities.find((c) => c.slug === 'tashkent-city');
  assert.equal(tash.name.ru, 'город Ташкент');
  assert.ok(tash.districts.some((d) => d.slug === 'yunusobod'));
});

test('строки для адреса — в виде базы программы', () => {
  assert.deepEqual(Object.keys(regionRow('tashkent-city')).sort(), ['code', 'name', 'name_en', 'name_uz']);
  assert.equal(districtRow('mirobod').name, 'Мирабадский район');
  assert.equal(countryRow('UZ').name_en, 'Uzbekistan');
  assert.equal(regionRow('нет'), null);
});

test('разбор понимает кавычку внутри названия', () => {
  const g = parseGeoSql("UPDATE regions SET code = 'x', name_uz = 'O''zbek', name_en = 'X' WHERE name = 'Икс';\n");
  assert.equal(g.regions.get('x').name_uz, "O'zbek");
});

test('специальности: все строки программы со слагом и тремя названиями', () => {
  const s = specialtiesReference().specialties;
  assert.equal(s.length, SPECIALTY_ROWS.length);
  assert.ok(s.length >= 120);
  for (const r of s) assert.ok(r.slug && r.name.ru && r.name.uz && r.name.en, r.slug);
  assert.equal(new Set(s.map((r) => r.slug)).size, s.length, 'слаг повторяется');
});
```

`public-server/server/lib/slot-check.test.js`:

```js
// PUBLIC_SERVER_V1 — свободное время по присланному: N окон подряд без разрыва,
// прошедшее сегодня — занято, за пределами присланного — решит клиника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayWindows, slotState, windowsNeeded } from './slot-check.js';
import { localMsOf } from './time.js';

const OFF = 300;
const NOW = localMsOf('2030-03-11', '09:00', OFF);
const day = { date: '2030-03-12', from: '09:00', to: '12:00', starts: ['09:00', '09:15', '09:30', '09:45', '11:00', '11:15'], free: '110111' };
const slots = { generated_at: '2030-03-11T03:59:00Z', slot_minutes: 15, doctors: { 7: { reception: 'booking', days: [day] } } };
const doctor = { id: 7, booking_days: 14 };
const at = (d, hhmm) => localMsOf(d, hhmm, OFF);

test('окна подряд: 30 минут — два свободных окна без разрыва', () => {
  assert.equal(windowsNeeded(30), 2);
  assert.equal(windowsNeeded(null), 1);
  assert.equal(windowsNeeded(20), 2);
  assert.deepEqual(dayWindows(day, null, { now: NOW, offsetMin: OFF }).map((w) => w.free), [true, true, false, true, true, true]);
  assert.deepEqual(dayWindows(day, 2, { now: NOW, offsetMin: OFF }).map((w) => w.start), ['09:00', '11:00'], '09:45 + 11:00 — разрыв, не подряд');
});

test('сегодня прошедшее — занято', () => {
  const today = { ...day, date: '2030-03-11' };
  assert.deepEqual(dayWindows(today, null, { now: at('2030-03-11', '09:20'), offsetMin: OFF }).map((w) => w.free), [false, false, false, true, true, true]);
});

test('начало записи: свободно / занято / вне присланного — решит клиника', () => {
  const o = { now: NOW, offsetMin: OFF };
  assert.equal(slotState(slots, doctor, at('2030-03-12', '09:00'), 2, o), 'free');
  assert.equal(slotState(slots, doctor, at('2030-03-12', '09:15'), 2, o), 'taken', '09:30 занято');
  assert.equal(slotState(slots, doctor, at('2030-03-12', '10:00'), 1, o), 'taken', 'не начало сетки — не рабочее');
  assert.equal(slotState(slots, doctor, at('2030-03-13', '10:00'), 1, o), 'taken', 'в пределах присланного дня нет — врач не работает');
  assert.equal(slotState(slots, doctor, at('2030-03-26', '10:00'), 1, o), 'unknown', 'за пределами присланных 14 дней');
  assert.equal(slotState(slots, { id: 8, booking_days: 14 }, at('2030-03-12', '09:00'), 1, o), 'unknown', 'нет времени врача');
});
```

- [ ] **Step 2:** `node --test public-server/server/lib/reference.test.js public-server/server/lib/slot-check.test.js` → падают: `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: модули.**

`public-server/server/lib/reference.js`:

```js
// PUBLIC_SERVER_V1 — СПРАВОЧНИКИ ДЛЯ ПАРТНЁРОВ: /reference/geo и
// /reference/specialties (макет «Документация API», раздел «Справочники»).
//
// Решение владельца 6: справочники зашиты в программу и одни на все клиники.
// Публичный сервер берёт их ОТТУДА ЖЕ, а не из снимка клиники:
//   • коды и порядок географии — public/js/shared/geo-codes.js;
//   • названия на ru / uz / en — из текста миграции 132 программы (там они
//     записаны построчно; geo-codes.test.js держит модуль и миграцию вместе);
//   • специальности — public/js/shared/specialty-list.js.
// Разбор миграции проверяет reference.test.js: каждый код модуля получил три
// названия, лишних нет — разойтись с программой справочники не могут.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO_COUNTRY_CODES, GEO_REGION_DISTRICTS } from '../../../public/js/shared/geo-codes.js';
import { SPECIALTY_ROWS } from '../../../public/js/shared/specialty-list.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEO_MIGRATION = path.resolve(HERE, '../../../server/db/migrations/132_geography_names.sql');

const Q = "'((?:[^']|'')*)'";
const unq = (s) => s.replace(/''/g, "'");

/** Названия из миграции 132: Map(code → {code, name, name_uz, name_en}) по странам, регионам, районам. */
export function parseGeoSql(sql) {
  const countries = new Map();
  for (const m of sql.matchAll(new RegExp(`^UPDATE countries SET name_uz = ${Q}, name_en = ${Q} WHERE code = ${Q} OR name = ${Q};$`, 'gm'))) {
    countries.set(unq(m[3]), { code: unq(m[3]), name: unq(m[4]), name_uz: unq(m[1]), name_en: unq(m[2]) });
  }
  const regions = new Map();
  for (const m of sql.matchAll(new RegExp(`^UPDATE regions SET code = ${Q}, name_uz = ${Q}, name_en = ${Q} WHERE name = ${Q};$`, 'gm'))) {
    regions.set(unq(m[1]), { code: unq(m[1]), name: unq(m[4]), name_uz: unq(m[2]), name_en: unq(m[3]) });
  }
  const districts = new Map();
  const re = new RegExp(`^UPDATE districts SET code = ${Q}, name_uz = ${Q}, name_en = ${Q}, kind = ${Q} WHERE name = ${Q} AND region_id = \\(SELECT id FROM regions WHERE name = ${Q}\\);$`, 'gm');
  for (const m of sql.matchAll(re)) districts.set(unq(m[1]), { code: unq(m[1]), name: unq(m[5]), name_uz: unq(m[2]), name_en: unq(m[3]) });
  return { countries, regions, districts };
}

let geo = null;
/** Справочник географии (читается один раз). */
export function geoRows() {
  if (!geo) geo = parseGeoSql(fs.readFileSync(GEO_MIGRATION, 'utf8'));
  return geo;
}

const tri = (row) => ({ ru: row.name, uz: row.name_uz || row.name, en: row.name_en || row.name });

/** GET /reference/geo — страны и города/области Узбекистана с районами, в порядке бланка. */
export function geoReference() {
  const g = geoRows();
  return {
    countries: GEO_COUNTRY_CODES.filter((c) => g.countries.has(c)).map((c) => ({ code: c, name: tri(g.countries.get(c)) })),
    cities: GEO_REGION_DISTRICTS.filter(([r]) => g.regions.has(r)).map(([r, districts]) => ({
      slug: r, name: tri(g.regions.get(r)),
      districts: districts.filter((d) => g.districts.has(d)).map((d) => ({ slug: d, name: tri(g.districts.get(d)) })),
    })),
  };
}

/** GET /reference/specialties. */
export function specialtiesReference() {
  return { specialties: SPECIALTY_ROWS.map((r) => ({ slug: r.slug, name: { ru: r.ru, uz: r.uz || r.ru, en: r.en || r.ru } })) };
}

/** Строки для адреса (shared/clinic-profile.js composeAddress): {code, name, name_uz, name_en} или null. */
export const countryRow = (code) => geoRows().countries.get(String(code || '')) || null;
export const regionRow = (code) => geoRows().regions.get(String(code || '')) || null;
export const districtRow = (code) => geoRows().districts.get(String(code || '')) || null;
```

`public-server/server/lib/slot-check.js`:

```js
// PUBLIC_SERVER_V1 — СВОБОДНОЕ ВРЕМЯ ПО ПОСЛЕДНЕМУ ПРИСЛАННОМУ.
//
// Клиника шлёт по врачу дни: окно, начала по 15 минут и строку свободы
// ('1' — свободно) — services/api/snapshot.js buildSlots, тот же движок, что
// календарь. Приём длиной N минут требует ceil(N/15) окон подряд: начала идут
// одно за другим без разрыва и все свободны (документация: «consultation=initial
// — останутся только начала, после которых свободно столько окон, сколько
// длится приём»). Сегодняшнее прошедшее — не свободно.
//
// Сервер — первая линия (409 slot_taken); правду говорит клиника при приёме.
// День за пределами присланного (клиника давно не на связи, а срок записи
// сдвинулся) — 'unknown': запись принимается, решит клиника (решение 19).
import { addDays, localParts, minutesOf, hhmmOf, msOf } from './time.js';

export const SLOT_MIN = 15;
export const DEFAULT_MINUTES = 15;

export const windowsNeeded = (minutes) => Math.max(1, Math.ceil((Number(minutes) > 0 ? Number(minutes) : DEFAULT_MINUTES) / SLOT_MIN));

/** Начало i дня свободно для n окон подряд; nowMin — минуты «сейчас» (только для сегодняшнего дня), иначе null. */
function fits(day, i, n, nowMin) {
  const first = minutesOf(day.starts[i]);
  if (first == null || (nowMin != null && first < nowMin)) return false;
  for (let k = 0; k < n; k += 1) {
    if (day.starts[i + k] !== hhmmOf(first + k * SLOT_MIN) || String(day.free || '')[i + k] !== '1') return false;
  }
  return true;
}

/**
 * Окна дня для партнёра. n — сколько окон подряд нужно (null — каждое окно
 * со своей свободой). С n — только подходящие начала.
 */
export function dayWindows(day, n, { now, offsetMin }) {
  const today = localParts(now, offsetMin);
  const nowMin = day.date === today.date ? today.minutes : (day.date < today.date ? Infinity : null);
  const starts = Array.isArray(day.starts) ? day.starts : [];
  if (n == null) return starts.map((s, i) => ({ start: s, free: fits(day, i, 1, nowMin) }));
  return starts.map((s, i) => ({ start: s, free: fits(day, i, n, nowMin) })).filter((w) => w.free);
}

/**
 * Свободно ли начало startMs у врача на n окон по присланному времени.
 * @returns {'free'|'taken'|'unknown'}
 */
export function slotState(slots, doctor, startMs, n, { now, offsetMin }) {
  const d = slots && slots.doctors ? slots.doctors[String(doctor.id)] : null;
  const at = localParts(startMs, offsetMin);
  const generated = msOf(slots && slots.generated_at);
  const horizon = Number(doctor.booking_days) > 0 ? Number(doctor.booking_days) : 14;
  if (!d || generated == null) return 'unknown';
  const covered = addDays(localParts(generated, offsetMin).date, horizon - 1);
  if (at.date > covered) return 'unknown';
  const day = (Array.isArray(d.days) ? d.days : []).find((x) => x.date === at.date);
  if (!day) return 'taken';
  const i = (day.starts || []).indexOf(at.hhmm);
  if (i < 0) return 'taken';
  const today = localParts(now, offsetMin);
  return fits(day, i, n, day.date === today.date ? today.minutes : null) ? 'free' : 'taken';
}
```

- [ ] **Step 4:** тесты зелёные — **7 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 5: коммит** «Публичный сервер, справочники и время: география и специальности для партнёров — из программы (коды geo-codes.js, названия миграции 132, specialty-list.js); свободное время по присланному — N окон подряд без разрыва, прошедшее сегодня занято, день за пределами присланного решит клиника».

---

## Task 8: Уведомления партнёрам — отправка с проверкой адреса и доставка с повторами 1/5/10/30/60 (PUBLIC_SERVER_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/lib/webhook-send.js`, `public-server/server/lib/webhook-send.test.js`
- Create: `public-server/server/store/deliveries.js`, `public-server/server/store/deliveries.test.js`

- [ ] **Step 1: падающие тесты.** Отправка проверяется подделкой `request` и настоящим `https.request` с охраной `lookup`, которая отказывает **до** соединения. Порт не открывается.

`public-server/server/lib/webhook-send.test.js`:

```js
// PUBLIC_SERVER_V1 — отправка уведомления: адрес проверяется ещё раз; тело и
// подпись уходят как есть; имя, ведущее во внутреннюю сеть, — отказ ДО
// соединения; ответ — только код.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { httpsSend, checkWebhookUrl, makeSender } from './webhook-send.js';
import { guardedLookup } from './net-guard.js';

test('адрес: только https и доменное имя в интернете', () => {
  assert.equal(checkWebhookUrl('https://med24.uz/hooks'), '');
  for (const bad of ['http://med24.uz/hooks', 'https://127.0.0.1/x', 'https://localhost/x', 'https://srv.local/x', 'https://u:p@med24.uz/', 'мусор', '']) {
    assert.equal(checkWebhookUrl(bad), 'bad_url', bad);
  }
});

function fakeRequest(status, seen) {
  return (opts) => {
    const req = new EventEmitter();
    seen.opts = opts;
    req.end = (payload) => {
      seen.payload = payload.toString('utf8');
      setImmediate(() => { const res = new EventEmitter(); res.statusCode = status; res.resume = () => {}; res.destroy = () => {}; req.emit('response', res); });
    };
    req.destroy = () => {};
    return req;
  };
}

test('тело и подпись клиники уходят как есть; ответ — код', async () => {
  const seen = {};
  const body = '{"event":"booking.confirmed","request_id":"rq_x"}';
  const r = await httpsSend({ url: 'https://med24.uz/hooks?x=1', body, headers: { 'X-EasyMed-Signature': 'sha256=ab' }, request: fakeRequest(204, seen) });
  assert.deepEqual(r, { status: 204 });
  assert.equal(seen.payload, body);
  assert.equal(seen.opts.hostname, 'med24.uz');
  assert.equal(seen.opts.path, '/hooks?x=1');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['X-EasyMed-Signature'], 'sha256=ab');
  assert.equal(seen.opts.headers['Content-Length'], Buffer.byteLength(body));
  assert.equal(seen.opts.agent, false);
});

test('имя ведёт во внутреннюю сеть — отказ до соединения (настоящий https.request с охраной lookup)', async () => {
  const lookup = guardedLookup({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  const r = await httpsSend({ url: 'https://hook.partner.uz/x', body: '{}', lookup, timeoutMs: 3000 });
  assert.deepEqual(r, { status: 0, error: 'blocked_address' });
  const meta = guardedLookup({ resolve: async () => [{ address: '169.254.169.254', family: 4 }] });
  assert.deepEqual(await httpsSend({ url: 'https://hook.partner.uz/x', body: '{}', lookup: meta, timeoutMs: 3000 }), { status: 0, error: 'blocked_address' });
});

test('неверный адрес — отказ без запроса; зависший партнёр — timeout', async () => {
  assert.deepEqual(await httpsSend({ url: 'http://med24.uz/x', body: '{}' }), { status: 0, error: 'bad_url' });
  const hang = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => {}; return req; };
  assert.deepEqual(await httpsSend({ url: 'https://med24.uz/x', body: '{}', request: hang, timeoutMs: 50 }), { status: 0, error: 'timeout' });
});

test('настоящая отправка фона: адрес самой машины (PUBLIC_SELF_IPS) — тоже отказ', async () => {
  const send = makeSender({ selfIps: ['45.77.242.169'], timeoutMs: 3000, resolve: async () => [{ address: '45.77.242.169', family: 4 }] });
  assert.deepEqual(await send({ url: 'https://hook.partner.uz/x', body: '{}', headers: {} }), { status: 0, error: 'blocked_address' });
});
```

`public-server/server/store/deliveries.test.js`:

```js
// PUBLIC_SERVER_V1 — доставка уведомлений: тело и подпись клиники как есть,
// повторы 1/5/10/30/60 минут, шесть попыток, тело стирается по итогу, журнал
// попыток для клиники.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverDue, purgeDeliveries, RETRY_MINUTES } from './deliveries.js';
import { applyEvents } from './requests.js';
import { admitClinic } from './clinics.js';
import { deliveryLogSince } from './logs.js';
import { testDb, testVendor, testClinic, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';

const vendor = testVendor();
const SIG = 'sha256=' + 'b'.repeat(64);

function setup(url = 'https://med24.uz/hooks') {
  const { db } = testDb();
  const c = testClinic(vendor);
  admitClinic(db, { clinicId: c.clinicId, fingerprint: c.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  const body = JSON.stringify({ event_id: 'ev_1', event: 'request.accepted', request_id: 'rq_abcdef', external_id: 'x', status: 'accepted', occurred_at: isoOf(NOW) });
  applyEvents(db, c.clinicId, [{ seq: 1, event: 'request.accepted', status: 'accepted', body, webhook_url: url, signature: SIG }], NOW);
  return { db, c, body };
}

test('доставлено с первого раза: тело и подпись клиники как есть, тело стёрто, в журнале — попытка', async () => {
  const s = setup();
  const sent = [];
  const r = await deliverDue(s.db, { now: NOW, send: async (m) => { sent.push(m); return { status: 200 }; } });
  assert.deepEqual(r, { attempts: 1, delivered: 1, failed: 0, retrying: 0 });
  assert.equal(sent[0].url, 'https://med24.uz/hooks');
  assert.equal(sent[0].body, s.body);
  assert.equal(sent[0].headers['X-EasyMed-Signature'], SIG);
  assert.equal(sent[0].headers['X-EasyMed-Event'], 'request.accepted');
  assert.equal(sent[0].headers['X-EasyMed-Event-Id'], 'ev_1');
  const d = s.db.prepare('SELECT * FROM deliveries').get();
  assert.deepEqual([d.state, d.body, d.attempts, d.last_code], ['delivered', null, 1, 200]);
  const log = deliveryLogSince(s.db, s.c.clinicId, 0);
  assert.deepEqual(log.map((l) => [l.attempt, l.code, l.final, l.request_id]), [[1, 200, 'delivered', 'rq_abcdef']]);
  assert.deepEqual(await deliverDue(s.db, { now: NOW + 3600000, send: async () => ({ status: 200 }) }), { attempts: 0, delivered: 0, failed: 0, retrying: 0 });
});

test('не отвечает: повторы через 1, 5, 10, 30, 60 минут, после шестой попытки — не доставлено', async () => {
  const s = setup();
  let t = NOW;
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await deliverDue(s.db, { now: t, send: async () => ({ status: 503 }) });
    assert.equal(r.attempts, 1, 'попытка ' + (i + 1));
    const d = s.db.prepare('SELECT * FROM deliveries').get();
    codes.push(d.state);
    if (i < 5) {
      assert.equal(d.next_at, isoOf(t + RETRY_MINUTES[i] * 60000));
      assert.equal((await deliverDue(s.db, { now: t + RETRY_MINUTES[i] * 60000 - 1000, send: async () => ({ status: 200 }) })).attempts, 0, 'раньше срока не шлём');
      t += RETRY_MINUTES[i] * 60000;
    }
  }
  assert.deepEqual(codes, ['pending', 'pending', 'pending', 'pending', 'pending', 'failed']);
  const d = s.db.prepare('SELECT * FROM deliveries').get();
  assert.deepEqual([d.attempts, d.body, d.next_at], [6, null, null]);
  assert.equal(deliveryLogSince(s.db, s.c.clinicId, 0).at(-1).final, 'failed');
});

test('сбой отправки и негодный адрес в строке — не роняют волну; негодный — сразу не доставлено', async () => {
  const s = setup();
  s.db.prepare("INSERT INTO deliveries (clinic_id, event_id, event, url, body, signature, next_at, created_at, updated_at) VALUES (?, 'ev_2', 'request.accepted', 'http://10.0.0.1/x', '{}', ?, ?, ?, ?)")
    .run(s.c.clinicId, SIG, isoOf(NOW), isoOf(NOW), isoOf(NOW));
  const r = await deliverDue(s.db, { now: NOW, send: async () => { throw new Error('сеть'); } });
  assert.deepEqual(r, { attempts: 2, delivered: 0, failed: 1, retrying: 1 });
  assert.equal(s.db.prepare("SELECT last_error FROM deliveries WHERE event_id = 'ev_2'").get().last_error, 'bad_url');
  assert.equal(s.db.prepare("SELECT last_error FROM deliveries WHERE event_id = 'ev_1'").get().last_error, 'send_failed');
});

test('уборка: законченные старше 30 дней', async () => {
  const s = setup();
  await deliverDue(s.db, { now: NOW, send: async () => ({ status: 204 }) });
  assert.equal(purgeDeliveries(s.db, NOW + 29 * 86400000), 0);
  assert.equal(purgeDeliveries(s.db, NOW + 31 * 86400000), 1);
});
```

- [ ] **Step 2:** `node --test public-server/server/lib/webhook-send.test.js public-server/server/store/deliveries.test.js` → падают: `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: модули.**

`public-server/server/lib/webhook-send.js`:

```js
// PUBLIC_SERVER_V1 — ОТПРАВКА ОДНОГО УВЕДОМЛЕНИЯ ПАРТНЁРУ.
//
// Тело и подпись (X-EasyMed-Signature: sha256=…) — готовые от клиники: сервер
// их не меняет и подделать не может (дизайн §4). Здесь — только доставка:
//   • адрес проверяется ЕЩЁ РАЗ перед каждой отправкой (тем же правилом, что
//     экран шага 7: https, доменное имя в интернете — webhookUrlProblem);
//   • соединение — только на публичный адрес, проверенный в самом подключении
//     (net-guard.js guardedLookup — SSRF и DNS rebinding);
//   • 10 секунд на всё, перенаправления не выполняются, ответ не читается
//     (нужен только код), тело ответа нигде не сохраняется.
import https from 'node:https';
import { webhookUrlProblem } from '../../../public/js/shared/api-connections.js';
import { guardedLookup, blockedList } from './net-guard.js';

export const WEBHOOK_TIMEOUT_MS = 10000;
export const USER_AGENT = 'EasyMed-Webhooks/1';

/** '' — адрес годится; иначе код. Пустой адрес для экрана — «без уведомлений», для отправки — негодный. */
export function checkWebhookUrl(url) {
  const s = String(url || '').trim();
  return !s || webhookUrlProblem(s) ? 'bad_url' : '';
}

const SSRF_CODES = new Set(['blocked_address', 'no_address', 'dns_failed']);
function errorCode(e) {
  const c = String((e && e.code) || '');
  if (SSRF_CODES.has(c)) return c;
  if (/CERT|TLS|SSL|SELF_SIGNED|ERR_SSL/i.test(c)) return 'tls';
  return 'connect';
}

/**
 * POST одного уведомления. Никогда не бросает.
 * @returns {Promise<{status:number, error?:string}>} status 0 — ответа не было (error — почему)
 */
export function httpsSend({ url, headers = {}, body = '', timeoutMs = WEBHOOK_TIMEOUT_MS, lookup, request = https.request }) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { finish({ status: 0, error: 'timeout' }); if (req) req.destroy(); }, timeoutMs);
    if (timer.unref) timer.unref();
    if (checkWebhookUrl(url)) { finish({ status: 0, error: 'bad_url' }); return; }
    const u = new URL(url);
    const payload = Buffer.from(String(body), 'utf8');
    try {
      req = request({
        protocol: 'https:', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', servername: u.hostname,
        headers: { 'User-Agent': USER_AGENT, ...headers, 'Content-Length': payload.length }, lookup, agent: false, timeout: timeoutMs,
      });
    } catch { finish({ status: 0, error: 'connect' }); return; }
    req.on('response', (res) => { finish({ status: Number(res.statusCode) || 0 }); res.resume(); res.destroy(); });
    req.on('timeout', () => { finish({ status: 0, error: 'timeout' }); req.destroy(); });
    req.on('error', (e) => finish({ status: 0, error: errorCode(e) }));
    req.end(payload);
  });
}

/**
 * Настоящая отправка для фона доставки: охрана адресов с адресами этой машины
 * (PUBLIC_SELF_IPS) в запрещённом списке.
 */
export function makeSender({ selfIps = [], timeoutMs = WEBHOOK_TIMEOUT_MS, resolve = undefined } = {}) {
  const lookup = guardedLookup({ list: blockedList(selfIps), ...(resolve ? { resolve } : {}) });
  return (msg) => httpsSend({ ...msg, timeoutMs, lookup });
}
```

`public-server/server/store/deliveries.js`:

```js
// PUBLIC_SERVER_V1 — ДОСТАВКА УВЕДОМЛЕНИЙ ПАРТНЁРАМ (дизайн §8).
//
// Строку deliveries кладёт приём событий клиники (store/requests.js
// applyEvents): адрес, готовое тело и подпись клиники. Здесь — попытки:
//   • 2xx — доставлено;
//   • иначе повтор через 1, 5, 10, 30 и 60 минут (макет: «Повторяем 5 раз»),
//     после шестой неудачной попытки — «не доставлено»;
//   • негодный адрес — сразу «не доставлено» (лучше он не станет);
//   • тело уведомления стирается, как только доставка кончилась: хранить его
//     дальше незачем (в нём нет данных пациента, но и пользы нет).
// Каждая попытка — строка журнала доставок для клиники (8d: вкладка «Уведомления»).
import { appendDeliveryLog } from './logs.js';
import { checkWebhookUrl } from '../lib/webhook-send.js';
import { isoOf } from '../lib/time.js';

export const RETRY_MINUTES = Object.freeze([1, 5, 10, 30, 60]);
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
export const DELIVERY_KEEP_MS = 30 * 86400000;

function record(db, d, r, now, out) {
  const attempt = d.attempts + 1;
  const ok = r.status >= 200 && r.status < 300;
  const final = ok ? 'delivered' : attempt >= MAX_ATTEMPTS || r.error === 'bad_url' ? 'failed' : null;
  const nextAt = final ? null : isoOf(now + RETRY_MINUTES[attempt - 1] * 60000);
  const at = isoOf(now);
  db.transaction(() => {
    db.prepare(`UPDATE deliveries SET attempts = ?, state = ?, next_at = ?, last_code = ?, last_error = ?, updated_at = ?,
                  body = CASE WHEN ? = 1 THEN NULL ELSE body END WHERE id = ?`)
      .run(attempt, final || 'pending', nextAt, r.status || null, r.error || null, at, final ? 1 : 0, d.id);
    appendDeliveryLog(db, { clinicId: d.clinic_id, deliveryId: d.id, connectionId: d.connection_id, requestId: d.request_id, eventId: d.event_id,
      event: d.event, attempt, code: r.status || null, error: r.error || null, at, nextAt, final });
  })();
  out.attempts += 1;
  if (final === 'delivered') out.delivered += 1;
  else if (final === 'failed') out.failed += 1;
  else out.retrying += 1;
}

/**
 * Одна волна доставки: подошедшие по времени, не больше limit, по parallel
 * одновременно. send({url, headers, body}) → {status, error?} (lib/webhook-send.js
 * makeSender в работе; в тестах — подделка).
 * @returns {Promise<{attempts:number, delivered:number, failed:number, retrying:number}>}
 */
export async function deliverDue(db, { now = Date.now(), send, limit = 20, parallel = 4 } = {}) {
  const due = db.prepare("SELECT * FROM deliveries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT ?").all(isoOf(now), limit);
  const out = { attempts: 0, delivered: 0, failed: 0, retrying: 0 };
  const one = async (d) => {
    if (checkWebhookUrl(d.url)) return { status: 0, error: 'bad_url' };
    try {
      return await send({ url: d.url, body: d.body || '', headers: {
        'Content-Type': 'application/json', 'X-EasyMed-Signature': d.signature, 'X-EasyMed-Event': d.event, 'X-EasyMed-Event-Id': d.event_id,
      } });
    } catch { return { status: 0, error: 'send_failed' }; }
  };
  for (let i = 0; i < due.length; i += parallel) {
    const batch = due.slice(i, i + parallel);
    const results = await Promise.all(batch.map(one));
    batch.forEach((d, k) => record(db, d, results[k] || { status: 0, error: 'send_failed' }, now, out));
  }
  return out;
}

/** Уборка: законченные доставки старше 30 дней. */
export function purgeDeliveries(db, now) {
  return db.prepare("DELETE FROM deliveries WHERE state <> 'pending' AND updated_at < ?").run(isoOf(now - DELIVERY_KEEP_MS)).changes;
}
```

- [ ] **Step 4:** тесты зелёные — **9 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 5: коммит** «Публичный сервер, уведомления: тело и подпись клиники уходят как есть, адрес проверяется перед каждой отправкой, соединение — только на публичный адрес, 10 секунд, без перенаправлений; повторы через 1, 5, 10, 30, 60 минут, шесть попыток, тело стирается по итогу, журнал попыток для клиники».

---

## Task 9: Вход партнёра и чтение — ключ по отпечатку, права, IP, сайт, лимиты, 503, снимок по документации, файлы, журнал запросов (PUBLIC_SERVER_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/routes/partner-auth.js`, `public-server/server/routes/partner-read.js`, `public-server/server/routes/partner.js`
- Create: `public-server/server/test-helpers/partner-stand.js`
- Create: `public-server/server/routes/partner-read.http.test.js`

- [ ] **Step 1: стенд** `public-server/server/test-helpers/partner-stand.js`. Клиника «Шифо»: снимок, время, подключение med24.uz с ключом, выпущенным во время теста. Часы двигает тест:

```js
// PUBLIC_SERVER_V1 — стенд адресов партнёров: клиника «Шифо» (shifo) со
// снимком, временем и подключением med24.uz (ключ выпущен во время теста),
// часы стенда двигает тест, лимиты — настоящие.
import { newApiKey, keyHash } from '../../../server/services/api/secret-box.js';
import { admitClinic, saveKeys, saveSnapshot, saveSlots } from '../store/clinics.js';
import { partnerRouter } from '../routes/partner.js';
import { createLimiter } from '../lib/rate-limit.js';
import { testDb, testVendor, testClinic, serve, NOW } from './fixture.js';
import { isoOf } from '../lib/time.js';

export const OFFSET = 300;
const t3 = (ru, uz = '', en = '') => ({ ru, uz, en });
const WEEK = { mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'], thu: ['08:00', '18:00'], fri: ['08:00', '18:00'], sat: ['09:00', '15:00'], sun: null };

export function snapshotFixture(at = NOW) {
  return {
    version: 1, generated_at: isoOf(at), slug: 'shifo',
    clinic: { name: t3('Шифо', 'Shifo'), about: t3('Семейная клиника'), country: 'UZ', city: 'tashkent-city', district: 'yunusobod',
      street: t3('ул. Мира, 1', 'Mira ko‘chasi, 1'), phone: '+998712000000', site: 'https://shifo.uz', telegram_bot: '@shifo_bot',
      telegram_channel: '', instagram: '', logo: { square: null, portrait: null }, map_url: '', route_url: '' },
    branches: [
      { id: 1, name: t3('Главный корпус', 'Bosh bino'), city: 'tashkent-city', district: 'yunusobod', street: t3('ул. Мира, 1'),
        landmark: t3('напротив парка'), phone: '+998712000000', hours: WEEK, open_24_7: false, map_url: '', route_url: '' },
      { id: 2, name: t3('Филиал'), city: 'tashkent-city', district: 'mirobod', street: t3('ул. Нукус, 5'), landmark: t3(''),
        phone: '', hours: WEEK, open_24_7: false, map_url: '', route_url: '' },
    ],
    doctors: [
      { id: 7, name: t3('Петров Пётр Петрович', 'Petrov Pyotr', 'Petrov Pyotr'), title: t3(''), bio: t3('Педиатр'), specialties: ['pediatr'],
        experience_years: 6, languages: ['ru', 'uz'], photo: null, branch_ids: [1], reception: 'booking', booking_days: 14,
        consultations: [{ type: 'initial', name: t3('Первичный приём', 'Birlamchi qabul'), price: 150000, minutes: 30 },
          { type: 'repeat', name: t3('Повторный приём', 'Takroriy qabul'), price: 98000, minutes: 15 }],
        services: [{ service_id: 301, price: 45000 }] },
      { id: 8, name: t3('Каримова Нигора'), title: t3(''), bio: t3(''), specialties: ['terapevt'], experience_years: null, languages: ['ru'],
        photo: null, branch_ids: [2], reception: 'live_queue', booking_days: 14, consultations: [], services: [] },
    ],
    services: [
      { id: 301, group: 'lab', name: t3('Общий анализ крови', 'Umumiy qon tahlili', 'Complete blood count'), price: 45000, minutes: 10 },
      { id: 302, group: 'diagnostics', name: t3('УЗИ брюшной полости', 'Qorin bo‘shlig‘i UTT'), price: 180000, minutes: 20 },
    ],
    packages: [
      { id: 4, name: t3('Check-up базовый', 'Check-up asosiy'), price_full: 345000, price: 293000, discount_percent: 15.1, valid_until: '2030-06-01',
        items: [{ service_id: 301, price_full: 45000, price: 38200 }] },
      { id: 5, name: t3('Старый пакет'), price_full: 100, price: 90, discount_percent: 10, valid_until: '2030-03-01', items: [] },
    ],
  };
}

export function slotsFixture(at = NOW) {
  return {
    generated_at: isoOf(at), slot_minutes: 15, doctors: {
      7: { reception: 'booking', days: [{ date: '2030-03-12', from: '09:00', to: '10:30', starts: ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15'], free: '111011' }] },
      8: { reception: 'live_queue', hours: { mon: ['08:00', '14:00'], sat: ['08:00', '12:00'] }, queue_now: 3 },
    },
  };
}

export const SCOPES_ALL = ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments', 'cancel'];

/** Стенд: { base, db, key, clock, setClock, conn(over), close, clinicId }. */
export async function partnerStand({ scopes = SCOPES_ALL, connection = {}, requireHttps = false, trustProxy = false, limiter = createLimiter() } = {}) {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const clinic = testClinic(vendor);
  let clock = NOW;
  admitClinic(db, { clinicId: clinic.clinicId, fingerprint: clinic.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  const key = newApiKey();
  const conn = (over = {}) => ({ id: 3, kind: 'partner', active: true, key_hash: keyHash(key), scopes, rate_limit: 60, key_expires_at: null,
    ip_allow: [], origins: ['https://med24.uz'], ...connection, ...over });
  let keysAt = NOW;
  const setConnection = (over) => {
    keysAt += 1000;
    saveKeys(db, clinic.clinicId, { generated_at: isoOf(keysAt), box_key: clinic.identity.boxPublic, connections: [conn(over)] }, keysAt);
  };
  setConnection({});
  saveSnapshot(db, clinic.clinicId, snapshotFixture(), NOW);
  saveSlots(db, clinic.clinicId, slotsFixture(), NOW);
  const ctx = { db, dataDir: dir, now: () => clock, offsetMin: OFFSET, baseUrl: 'https://api.test', requireHttps, limiter };
  const srv = await serve('/:slug/v1', partnerRouter(ctx), { trustProxy });
  const get = (p, { headers = {}, auth = true } = {}) =>
    fetch(srv.base + p, { headers: { ...(auth ? { Authorization: 'Bearer ' + key } : {}), ...headers } });
  const send = (method, p, body, { headers = {}, auth = true } = {}) => fetch(srv.base + p, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    ...srv, db, dir, key, clinic, clinicId: clinic.clinicId, vendor, ctx, get, send, setConnection,
    clock: () => clock, setClock: (t) => { clock = t; },
  };
}
```

- [ ] **Step 2: падающий тест** `public-server/server/routes/partner-read.http.test.js`:

```js
// PUBLIC_SERVER_V1 — адреса партнёров, чтение и вход: ответы по документации
// макета (?lang, адрес из справочника, as_of, stale), ключ по отпечатку, права,
// IP, сайт, лимиты с Retry-After, 503 при лицензии и молчащей клинике, файлы
// снимка без ключа, журнал запросов без присланного.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { partnerStand } from '../test-helpers/partner-stand.js';
import { NOW } from '../test-helpers/fixture.js';
import { admitClinic, saveSnapshot, clinicRow } from '../store/clinics.js';
import { putMedia } from '../store/media.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { isoOf } from '../lib/time.js';

const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });

test('клиника, филиалы, врачи, услуги, пакеты: ?lang, пустой перевод — русский, адрес из справочника, as_of', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const clinic = await json(await s.get('/shifo/v1/clinic?lang=uz'));
  assert.equal(clinic.status, 200);
  assert.equal(clinic.body.name, 'Shifo');
  assert.equal(clinic.body.about, 'Семейная клиника', 'пустой узбекский — русский');
  assert.equal(clinic.body.address, 'Toshkent shahri, Yunusobod tumani, Mira ko‘chasi, 1');
  assert.equal(clinic.body.as_of, '2030-03-11T09:00:00+05:00');
  const all = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual(all.body.name, { ru: 'Шифо', uz: 'Shifo', en: 'Шифо' });
  assert.equal(all.body.address.ru, 'город Ташкент, Юнусабадский район, ул. Мира, 1');
  const br = await json(await s.get('/shifo/v1/branches?district=mirobod&lang=ru'));
  assert.deepEqual(br.body.branches.map((b) => b.id), [2]);
  assert.deepEqual(br.body.branches[0].hours.sun, null);
  const docs = await json(await s.get('/shifo/v1/doctors?specialty=pediatr&lang=en'));
  assert.deepEqual(docs.body.doctors.map((d) => d.id), [7]);
  assert.equal(docs.body.doctors[0].consultations[0].price, 150000);
  assert.equal(docs.body.doctors[0].consultations[0].name, 'Первичный приём', 'пустой английский — русский');
  assert.deepEqual((await json(await s.get('/shifo/v1/doctors?district=mirobod'))).body.doctors.map((d) => d.id), [8]);
  const svc = await json(await s.get('/shifo/v1/services?group=lab'));
  assert.deepEqual(svc.body.services.map((x) => [x.id, x.group, x.price]), [[301, 'lab', 45000]]);
  assert.equal((await s.get('/shifo/v1/services?group=chto')).status, 400);
  const pk = await json(await s.get('/shifo/v1/packages'));
  assert.deepEqual(pk.body.packages.map((p) => p.id), [4], 'истёкший пакет не приходит');
  assert.equal((await s.get('/shifo/v1/doctors?lang=de')).status, 400);
});

test('свободное время: окна дня, приём N окон подряд, без даты — все дни, живая очередь, stale через 10 минут', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const day = await json(await s.get('/shifo/v1/slots?doctor_id=7&date=2030-03-12'));
  assert.deepEqual(day.body.slots.map((w) => [w.start, w.free]), [['09:00', true], ['09:15', true], ['09:30', true], ['09:45', false], ['10:00', true], ['10:15', true]]);
  assert.equal(day.body.stale, false);
  const fit = await json(await s.get('/shifo/v1/slots?doctor_id=7&date=2030-03-12&consultation=initial'));
  assert.deepEqual(fit.body.slots.map((w) => w.start), ['09:00', '09:15', '10:00'], '30 минут — два свободных окна подряд');
  const days = await json(await s.get('/shifo/v1/slots?doctor_id=7'));
  assert.deepEqual(days.body.days.map((d) => d.date), ['2030-03-12']);
  const live = await json(await s.get('/shifo/v1/slots?doctor_id=8'));
  assert.deepEqual([live.body.reception, live.body.queue_now, live.body.hours.mon], ['live_queue', 3, ['08:00', '14:00']]);
  assert.equal((await s.get('/shifo/v1/slots?doctor_id=99')).status, 404);
  assert.equal((await s.get('/shifo/v1/slots')).status, 400);
  assert.equal((await s.get('/shifo/v1/slots?doctor_id=7&consultation=repeat')).status, 200);
  s.setClock(NOW + 11 * 60000);
  const old = await json(await s.get('/shifo/v1/slots?doctor_id=7&date=2030-03-12'));
  assert.equal(old.body.stale, true, 'клиника молчит дольше 10 минут — последнее известное с пометкой');
  assert.equal(old.body.as_of, '2030-03-11T09:00:00+05:00');
});

test('справочники — любым ключом, с ?lang', async (t) => {
  const s = await partnerStand({ scopes: ['clinic'] });
  t.after(s.close);
  const geo = await json(await s.get('/shifo/v1/reference/geo?lang=en'));
  assert.equal(geo.body.cities.find((c) => c.slug === 'tashkent-city').name, 'Tashkent city');
  const sp = await json(await s.get('/shifo/v1/reference/specialties'));
  assert.ok(sp.body.specialties.find((x) => x.slug === 'pediatr').name.uz);
});

test('ключ: нет, чужой, выключен, истёк — 401 своим кодом; права — 403; клиники нет — 404', async (t) => {
  const s = await partnerStand({ scopes: ['clinic', 'doctors'] });
  t.after(s.close);
  const code = async (res) => (await res.json()).error.code;
  assert.equal(await code(await s.get('/shifo/v1/clinic', { auth: false })), 'invalid_key');
  assert.equal(await code(await s.get('/shifo/v1/clinic', { auth: false, headers: { Authorization: 'Bearer em_live_TESTONLYxxxxxxxxxxxxxxxxxxxxxxxxx' } })), 'invalid_key');
  const scoped = await json(await s.get('/shifo/v1/services'));
  assert.deepEqual([scoped.status, scoped.body.error.code, scoped.body.error.scope], [403, 'forbidden_scope', 'services']);
  assert.equal((await s.get('/nikto/v1/clinic')).status, 404);
  s.setConnection({ active: false });
  const off = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([off.status, off.body.error.code], [401, 'key_disabled']);
  s.setConnection({ key_expires_at: isoOf(NOW - 1000) });
  assert.equal(await code(await s.get('/shifo/v1/clinic')), 'key_expired');
});

test('«Разрешённые IP» (за nginx — X-Forwarded-For) и сайт (CORS): чужой — 403; свой — да, с Access-Control-Allow-Origin', async (t) => {
  const s = await partnerStand({ trustProxy: 'loopback', connection: { ip_allow: ['203.0.113.0/24'] } });
  t.after(s.close);
  assert.equal((await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 200);
  const deny = await json(await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '198.51.100.9' } }));
  assert.deepEqual([deny.status, deny.body.error.code], [403, 'ip_not_allowed']);
  const site = await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '203.0.113.7', Origin: 'https://med24.uz' } });
  assert.deepEqual([site.status, site.headers.get('access-control-allow-origin')], [200, 'https://med24.uz']);
  const evil = await json(await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-For': '203.0.113.7', Origin: 'https://evil.example' } }));
  assert.deepEqual([evil.status, evil.body.error.code, evil.headers.get('access-control-allow-origin')], [403, 'origin_not_allowed', null]);
  const pre = await fetch(s.base + '/shifo/v1/appointments', { method: 'OPTIONS', headers: { Origin: 'https://med24.uz', 'Access-Control-Request-Method': 'POST' } });
  assert.deepEqual([pre.status, pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers')],
    [204, 'https://med24.uz', 'Authorization, Content-Type']);
  assert.equal((await fetch(s.base + '/shifo/v1/clinic', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('лимит ключа: сверх rate_limit в минуту — 429 с Retry-After; неверные ключи с одного IP — тоже', async (t) => {
  const s = await partnerStand({ connection: { rate_limit: 30 } });
  t.after(s.close);
  for (let i = 0; i < 30; i += 1) assert.equal((await s.get('/shifo/v1/clinic')).status, 200, 'запрос ' + (i + 1));
  const over = await json(await s.get('/shifo/v1/clinic'));
  assert.deepEqual([over.status, over.body.error.code], [429, 'rate_limited']);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  let last;
  for (let i = 0; i < 31; i += 1) last = await s.get('/shifo/v1/clinic', { auth: false });
  assert.equal(last.status, 429, 'перебор ключей с одного адреса');
});

test('503: «не оплачено» в лицензии, срок вышел, клиника молчит 7 суток — «временно недоступна» с телефоном клиники', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const auth = (licence) => ({ clinicId: s.clinicId, fingerprint: s.clinic.identity.fingerprint, licence });
  admitClinic(s.db, auth({ issued_at: '2030-03-10T12:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'unpaid' }), NOW);
  const unpaid = await json(await s.get('/shifo/v1/doctors'));
  assert.deepEqual([unpaid.status, unpaid.body.error.code, unpaid.body.error.phone], [503, 'licence_lapsed', '+998712000000']);
  assert.ok(!/оплат/i.test(unpaid.body.error.message), 'не «не оплатила» — «временно недоступна»');
  admitClinic(s.db, auth({ issued_at: '2030-03-10T13:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' }), NOW);
  assert.equal((await s.get('/shifo/v1/doctors')).status, 200, 'продлили — снова видна');
  s.setClock(Date.parse('2030-04-01T00:00:01Z'));
  assert.equal((await json(await s.get('/shifo/v1/doctors'))).body.error.code, 'licence_lapsed');
  s.db.prepare("UPDATE clinics SET licence_valid_until = '2031-01-01T00:00:00Z'").run();
  s.setClock(NOW + 8 * 86400000);
  assert.equal((await json(await s.get('/shifo/v1/doctors'))).body.error.code, 'clinic_offline');
});

test('файлы снимка: без ключа, только из текущего снимка, вид не угадывается; прежнее имя клиники 30 дней', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const png = fakePng(16, 16);
  const sha = crypto.createHash('sha256').update(png).digest('hex');
  putMedia(s.db, s.dir, s.clinicId, sha, 'png', png, NOW);
  assert.equal((await fetch(s.base + '/shifo/v1/media/' + sha + '.png')).status, 404, 'в снимке ещё нет');
  const snap = JSON.parse(clinicRow(s.db, s.clinicId).snapshot);
  saveSnapshot(s.db, s.clinicId, { ...snap, generated_at: isoOf(NOW + 1000), slug: 'shifo-med', clinic: { ...snap.clinic, logo: { square: 'media/' + sha + '.png', portrait: null } } }, NOW + 1000);
  const clinic = await json(await s.get('/shifo-med/v1/clinic'));
  assert.equal(clinic.body.logo.square, 'https://api.test/shifo-med/v1/media/' + sha + '.png');
  const img = await fetch(s.base + '/shifo/v1/media/' + sha + '.png');
  assert.deepEqual([img.status, img.headers.get('content-type'), img.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
});

test('журнал запросов: известный путь и параметры верного вида; присланное сверх — нет', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  await s.get('/shifo/v1/doctors?lang=ru&specialty=pediatr&name=ИМЯ_ПАЦИЕНТА');
  await s.get('/shifo/v1/ИМЯ_В_ПУТИ');
  await s.get('/shifo/v1/clinic', { auth: false });
  const rows = s.db.prepare('SELECT connection_id, method, path, status FROM access_log ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.connection_id, r.path, r.status]), [
    [3, '/shifo/v1/doctors?lang=ru&specialty=pediatr', 200],
    [3, '/shifo/v1/?', 404],
    [null, '/shifo/v1/clinic', 401],
  ]);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM access_log').all()).includes('ИМЯ'));
  assert.ok(s.db.prepare('SELECT last_used_at FROM connections').get().last_used_at, '«последний запрос» отмечен');
});

test('только https: за nginx — X-Forwarded-Proto: https; иначе 400', async (t) => {
  const s = await partnerStand({ requireHttps: true, trustProxy: 'loopback' });
  t.after(s.close);
  assert.equal((await s.get('/shifo/v1/clinic')).status, 400);
  assert.equal((await s.get('/shifo/v1/clinic', { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
});
```

- [ ] **Step 3:** `node --test public-server/server/routes/partner-read.http.test.js` → падает: `ERR_MODULE_NOT_FOUND` (`routes/partner.js`).
- [ ] **Step 4: модули.**

`public-server/server/routes/partner-auth.js`:

```js
// PUBLIC_SERVER_V1 — ВХОД ПАРТНЁРА: клиника по имени в адресе, её состояние,
// ключ, права, IP, сайт (CORS), лимиты, журнал запросов.
//
// Порядок — от дешёвого к дорогому и от общего к частному:
//   1. общий потолок по IP — до всего (перебор имён и ключей, поток мусора);
//   2. клиника по имени в адресе (прежнее имя — 30 дней) — иначе 404;
//   3. только https (за nginx — X-Forwarded-Proto, PUBLIC_TRUST_PROXY);
//   4. клиника доступна: лицензия не истекла и не «не оплачено» (решения 4 и
//      17) — иначе 503 licence_lapsed; клиника не выходила на связь 7 суток —
//      503 clinic_offline (выключенный в ней ключ мог бы работать по старым
//      правам — дизайн §2, смягчение «б»). Текст — «временно недоступна», не
//      «не оплатила» (правило easymed-licence-lockout); телефон клиники — в ответе;
//   5. ключ: SHA-256 от Bearer ищется среди отпечатков клиники (решение 5 —
//      самого ключа сервер не знает); выключен / истёк — 401 со своим кодом;
//      неверные ключи с одного IP — не больше 30 в минуту;
//   6. «Разрешённые IP» подключения — 403; сайт (Origin) не из адресов
//      подключения — 403 (браузер с чужого сайта не пошлёт запрос с ключом);
//   7. лимит ключа в минуту (rate_limit подключения) и записи — не больше 30 в
//      минуту — 429 с Retry-After;
//   8. права раздела — 403 forbidden_scope.
// Журнал запросов (30 дней): путь — по списку известных адресов, параметры — по
// списку и по виду значения; присланного сверх этого в журнал не попадает.
import { KEY_RE } from '../../../public/js/shared/api-connections.js';
import { API_GROUPS } from '../../../public/js/shared/service-public.js';
import { keyHash } from '../../../server/services/api/secret-box.js';
import { resolveSlug, connectionByHash, originAllowedForClinic, markUsed, snapshotOf } from '../store/clinics.js';
import { recordAccess } from '../store/logs.js';
import { licenceStanding } from '../licence-gate.js';
import { ipAllowed, clientIp } from '../lib/net-guard.js';
import { sendError } from '../lib/errors.js';
import { isoOf, msOf } from '../lib/time.js';

export const IP_LIMIT_PER_MIN = 1200;
export const AUTH_FAIL_LIMIT_PER_MIN = 30;
export const WRITE_LIMIT_PER_MIN = 30;
export const CLINIC_SILENT_MAX_MS = 7 * 86400000;

const RQ = 'rq_[A-Za-z0-9]{6,37}';
const KNOWN_PATHS = [
  /^\/(clinic|branches|doctors|services|packages|slots|requests|appointments)$/,
  /^\/reference\/(geo|specialties)$/,
  new RegExp(`^\\/requests\\/${RQ}$`),
  new RegExp(`^\\/appointments\\/${RQ}(\\/(accept|decline))?$`),
];
const QUERY_RULES = {
  lang: /^(ru|uz|en)$/, doctor_id: /^\d{1,9}$/, service_id: /^\d{1,9}$/, branch_id: /^\d{1,9}$/, date: /^\d{4}-\d{2}-\d{2}$/,
  consultation: /^(initial|repeat)$/, group: new RegExp('^(' + API_GROUPS.join('|') + ')$'), specialty: /^[a-z0-9-]{1,60}$/,
  district: /^[a-z0-9-]{1,60}$/, city: /^[a-z0-9-]{1,60}$/,
};

/** Путь для журнала: известный адрес — как есть, иначе «/?»; параметры — только известные и только верного вида. */
export function logPath(slug, req) {
  const p = String(req.path || '');
  const known = KNOWN_PATHS.some((re) => re.test(p)) ? p : '/?';
  const q = Object.entries(QUERY_RULES)
    .filter(([k, re]) => typeof req.query[k] === 'string' && re.test(req.query[k]))
    .map(([k]) => k + '=' + req.query[k]);
  return '/' + slug + '/v1' + known + (q.length ? '?' + q.join('&') : '');
}

const phoneOf = (clinic) => { const s = snapshotOf(clinic); return String((s && s.clinic && s.clinic.phone) || ''); };

/** Потолок по IP, клиника по имени в адресе, https, состояние клиники, журнал запросов. */
export function clinicGate(ctx) {
  return (req, res, next) => {
    const now = ctx.now();
    req.ipAddr = clientIp(req.ip);
    // Потолок — до поиска клиники: перебор имён в адресе тоже упирается в лимит.
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('ip:' + req.ipAddr, IP_LIMIT_PER_MIN, now);
      if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
    }
    const clinic = resolveSlug(ctx.db, req.params.slug, now);
    if (!clinic) return sendError(req, res, 'clinic_not_found');
    req.clinic = clinic;
    const origin = req.get('origin');
    if (origin && originAllowedForClinic(ctx.db, clinic.clinic_id, origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    if (req.method !== 'OPTIONS' && !/^\/media\//.test(req.path)) {
      const t0 = Date.now();
      const path = logPath(clinic.slug, req);   // сейчас, пока путь — внутри маршрутизатора
      res.on('finish', () => {
        try {
          recordAccess(ctx.db, { clinicId: clinic.clinic_id, connectionId: req.conn ? req.conn.id : null, at: isoOf(ctx.now()),
            method: req.method, path, status: res.statusCode, ip: req.ipAddr, ms: Date.now() - t0 });
        } catch { /* журнал не роняет ответ */ }
      });
    }
    if (ctx.requireHttps && !req.secure) return sendError(req, res, 'https_required');
    if (licenceStanding(clinic, now) !== 'active') return sendError(req, res, 'licence_lapsed', { phone: phoneOf(clinic) });
    if (now - (msOf(clinic.last_seen_at) || 0) > CLINIC_SILENT_MAX_MS) return sendError(req, res, 'clinic_offline', { phone: phoneOf(clinic) });
    return next();
  };
}

/** Предварительный запрос браузера (CORS): ключа в нём нет — сайт должен быть у одного из включённых подключений клиники. */
export function preflight(ctx) {
  return (req, res, next) => {
    if (req.method !== 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin || !originAllowedForClinic(ctx.db, req.clinic.clinic_id, origin)) return sendError(req, res, 'origin_not_allowed');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Max-Age', '600');
    return res.status(204).end();
  };
}

/** Ключ, IP, сайт, лимиты. */
export function requireKey(ctx) {
  return (req, res, next) => {
    const now = ctx.now();
    const clinic = req.clinic;
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
    const key = m ? m[1] : '';
    const conn = KEY_RE.test(key) ? connectionByHash(ctx.db, clinic.clinic_id, keyHash(key)) : null;
    if (!conn) {
      if (ctx.limiter) {
        const hit = ctx.limiter.hit('authfail:' + req.ipAddr, AUTH_FAIL_LIMIT_PER_MIN, now);
        if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
      }
      return sendError(req, res, 'invalid_key');
    }
    req.conn = conn;
    if (!conn.active) return sendError(req, res, 'key_disabled');
    if (conn.key_expires_at && (msOf(conn.key_expires_at) || 0) <= now) return sendError(req, res, 'key_expired');
    if (!ipAllowed(conn.ip_allow, req.ipAddr)) return sendError(req, res, 'ip_not_allowed');
    const origin = req.get('origin');
    if (origin && !conn.origins.includes(String(origin).toLowerCase())) return sendError(req, res, 'origin_not_allowed');
    if (ctx.limiter) {
      const hit = ctx.limiter.hit('key:' + clinic.clinic_id + ':' + conn.id, conn.rate_limit, now);
      if (!hit.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': hit.retryAfterSec });
      if (req.method === 'POST' || req.method === 'DELETE') {
        const w = ctx.limiter.hit('write:' + clinic.clinic_id + ':' + conn.id, WRITE_LIMIT_PER_MIN, now);
        if (!w.ok) return sendError(req, res, 'rate_limited', {}, { 'Retry-After': w.retryAfterSec });
      }
    }
    markUsed(ctx.db, clinic.clinic_id, conn.id, now);
    return next();
  };
}

/** Права раздела: хоть одно из названных. */
export const scope = (...names) => (req, res, next) =>
  (names.some((n) => req.conn.scopes.includes(n)) ? next() : sendError(req, res, 'forbidden_scope', { scope: names[0] }));
```

`public-server/server/routes/partner-read.js`:

```js
// PUBLIC_SERVER_V1 — ЧТЕНИЕ ДЛЯ ПАРТНЁРОВ: /clinic, /branches, /doctors,
// /services, /packages, /slots, /reference/* (макет «Документация API»).
//
// Отдаётся ПОСЛЕДНИЙ СНИМОК клиники (дизайн §2), поле as_of — когда клиника в
// последний раз была на связи (её изменения доходят за такт, так что данные
// свежи на этот миг). Ответ — белый список полей: чего нет в этом файле, партнёр
// не получит, даже если новая версия программы клиники пришлёт больше.
//
// ?lang=ru|uz|en — каждое название одной строкой; без параметра — все три;
// пустой перевод — русский. Суммы — целые (так их шлёт клиника). Время —
// Ташкент со смещением. Адрес собирается из кодов справочника той же функцией,
// что в программе (shared/clinic-profile.js composeAddress).
import { composeAddress } from '../../../public/js/shared/clinic-profile.js';
import { API_GROUPS } from '../../../public/js/shared/service-public.js';
import { CONSULT_API_KINDS } from '../../../public/js/shared/consultation-price.js';
import { snapshotOf, slotsOf } from '../store/clinics.js';
import { countryRow, regionRow, districtRow, geoReference, specialtiesReference } from '../lib/reference.js';
import { dayWindows, windowsNeeded, SLOT_MIN } from '../lib/slot-check.js';
import { sendError, langOf } from '../lib/errors.js';
import { localParts, msOf, partnerTime } from '../lib/time.js';
import { scope } from './partner-auth.js';

export const STALE_AFTER_MS = 10 * 60000;
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MEDIA_REF_RE = /^media\/[0-9a-f]{64}\.(png|jpg|jpeg|webp)$/;

const str = (v) => String(v == null ? '' : v);
/** Название на трёх языках → строка языка (пустое — русское) или объект трёх. */
export function tri(v, lang) {
  const o = v && typeof v === 'object' ? v : {};
  const ru = str(o.ru);
  if (lang) return str(o[lang]) || ru;
  return { ru, uz: str(o.uz) || ru, en: str(o.en) || ru };
}
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

function address(p, lang) {
  const parts = { country: countryRow(p.country), region: regionRow(p.city), district: districtRow(p.district), street: p.street || {} };
  if (lang) return composeAddress(parts, lang);
  return { ru: composeAddress(parts, 'ru'), uz: composeAddress(parts, 'uz'), en: composeAddress(parts, 'en') };
}

function hours(h) {
  const out = {};
  for (const d of WEEK) out[d] = Array.isArray(h && h[d]) && h[d].length === 2 ? [str(h[d][0]), str(h[d][1])] : null;
  return out;
}

function namesDeep(v, lang) {
  if (Array.isArray(v)) return v.map((x) => namesDeep(x, lang));
  if (v && typeof v === 'object') {
    if ('ru' in v && Object.keys(v).every((k) => ['ru', 'uz', 'en'].includes(k))) return tri(v, lang);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, namesDeep(x, lang)]));
  }
  return v;
}

/** @param ctx {{db, now, offsetMin, baseUrl}} */
export function readRoutes(r, ctx) {
  const mediaUrl = (clinic, ref) => (MEDIA_REF_RE.test(str(ref)) ? ctx.baseUrl + '/' + clinic.slug + '/v1/' + ref : null);
  const asOf = (clinic) => partnerTime(clinic.last_seen_at, ctx.offsetMin);
  const stale = (clinic) => ctx.now() - (msOf(clinic.last_seen_at) || 0) > STALE_AFTER_MS;
  const bad = (req, res, field, reason) => sendError(req, res, 'invalid_field', { field, reason });
  const langOk = (req, res) => {
    if (req.query.lang !== undefined && !langOf(req)) { bad(req, res, 'lang', 'unknown'); return false; }
    return true;
  };
  const snap = (req, res) => {
    const s = snapshotOf(req.clinic);
    if (!s) { sendError(req, res, 'not_found'); return null; }
    return s;
  };

  r.get('/clinic', scope('clinic'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const c = s.clinic || {};
    res.json({
      name: tri(c.name, lang), about: tri(c.about, lang), country: str(c.country), city: str(c.city), district: str(c.district),
      street: tri(c.street, lang), address: address(c, lang), phone: str(c.phone), site: str(c.site),
      telegram_bot: str(c.telegram_bot), telegram_channel: str(c.telegram_channel), instagram: str(c.instagram),
      logo: { square: mediaUrl(req.clinic, c.logo && c.logo.square), portrait: mediaUrl(req.clinic, c.logo && c.logo.portrait) },
      map_url: str(c.map_url), route_url: str(c.route_url), as_of: asOf(req.clinic),
    });
  });

  r.get('/branches', scope('branches'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const { city, district } = req.query;
    const list = (s.branches || []).filter((b) => (!city || b.city === city) && (!district || b.district === district));
    res.json({
      branches: list.map((b) => ({
        id: b.id, name: tri(b.name, lang), city: str(b.city), district: str(b.district), street: tri(b.street, lang),
        landmark: tri(b.landmark, lang), address: address({ country: 'UZ', ...b }, lang), phone: str(b.phone), hours: hours(b.hours),
        open_24_7: !!b.open_24_7, map_url: str(b.map_url), route_url: str(b.route_url),
      })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/doctors', scope('doctors'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const branchId = req.query.branch_id === undefined ? null : posInt(req.query.branch_id);
    if (req.query.branch_id !== undefined && !branchId) return bad(req, res, 'branch_id', 'format');
    const { specialty, district, city } = req.query;
    const branches = new Map((s.branches || []).map((b) => [b.id, b]));
    const inArea = (d) => (d.branch_ids || []).some((id) => {
      const b = branches.get(id);
      return b && (!district || b.district === district) && (!city || b.city === city);
    });
    const list = (s.doctors || []).filter((d) => (!branchId || (d.branch_ids || []).includes(branchId))
      && (!specialty || (d.specialties || []).includes(specialty)) && (!(district || city) || inArea(d)));
    res.json({
      doctors: list.map((d) => ({
        id: d.id, name: tri(d.name, lang), title: tri(d.title, lang), bio: tri(d.bio, lang), specialties: (d.specialties || []).map(str),
        experience_years: d.experience_years == null ? null : int(d.experience_years), languages: (d.languages || []).map(str),
        photo: mediaUrl(req.clinic, d.photo), branch_ids: (d.branch_ids || []).map(Number), reception: d.reception === 'live_queue' ? 'live_queue' : 'booking',
        booking_days: int(d.booking_days),
        consultations: (d.consultations || []).filter((c) => CONSULT_API_KINDS.includes(c.type))
          .map((c) => ({ type: c.type, name: tri(c.name, lang), price: int(c.price), minutes: int(c.minutes) })),
        services: (d.services || []).map((x) => ({ service_id: int(x.service_id), price: int(x.price) })),
      })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/services', scope('services'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const group = req.query.group;
    if (group !== undefined && !API_GROUPS.includes(group)) return bad(req, res, 'group', 'unknown');
    const lang = langOf(req);
    res.json({
      services: (s.services || []).filter((x) => !group || x.group === group)
        .map((x) => ({ id: x.id, group: str(x.group), name: tri(x.name, lang), price: int(x.price), minutes: x.minutes == null ? null : int(x.minutes) })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/packages', scope('packages'), (req, res) => {
    if (!langOk(req, res)) return;
    const s = snap(req, res);
    if (!s) return;
    const lang = langOf(req);
    const today = localParts(ctx.now(), ctx.offsetMin).date;
    res.json({
      packages: (s.packages || []).filter((p) => !p.valid_until || str(p.valid_until) >= today).map((p) => ({
        id: p.id, name: tri(p.name, lang), price_full: int(p.price_full), price: int(p.price), discount_percent: Number(p.discount_percent) || 0,
        valid_until: p.valid_until || null, items: (p.items || []).map((i) => ({ service_id: int(i.service_id), price_full: int(i.price_full), price: int(i.price) })),
      })),
      as_of: asOf(req.clinic),
    });
  });

  r.get('/slots', scope('slots'), (req, res) => {
    const s = snap(req, res);
    if (!s) return;
    const doctorId = posInt(req.query.doctor_id);
    if (!doctorId) return bad(req, res, 'doctor_id', req.query.doctor_id === undefined ? 'required' : 'format');
    const doctor = (s.doctors || []).find((d) => d.id === doctorId);
    if (!doctor) return sendError(req, res, 'not_found', { field: 'doctor_id' });
    const date = req.query.date;
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return bad(req, res, 'date', 'format');
    const all = slotsOf(req.clinic);
    const mine = all && all.doctors ? all.doctors[String(doctorId)] : null;
    const meta = { as_of: asOf(req.clinic), stale: stale(req.clinic) };
    if (doctor.reception === 'live_queue') {
      return res.json({ doctor_id: doctorId, reception: 'live_queue', hours: hours(mine && mine.hours),
        queue_now: mine && mine.queue_now != null ? int(mine.queue_now) : null, ...meta });
    }
    let minutes = null;
    if (req.query.consultation !== undefined) {
      const c = (doctor.consultations || []).find((x) => x.type === req.query.consultation);
      if (!c) return bad(req, res, 'consultation', 'not_offered');
      minutes = c.minutes;
    } else if (req.query.service_id !== undefined) {
      const svc = (s.services || []).find((x) => x.id === posInt(req.query.service_id));
      if (!svc) return sendError(req, res, 'not_found', { field: 'service_id' });
      minutes = svc.minutes;
    }
    const n = req.query.consultation !== undefined || req.query.service_id !== undefined ? windowsNeeded(minutes) : null;
    const days = (mine && Array.isArray(mine.days) ? mine.days : []).filter((d) => !date || d.date === date)
      .map((d) => ({ date: d.date, slots: dayWindows(d, n, { now: ctx.now(), offsetMin: ctx.offsetMin }) }));
    if (date) return res.json({ doctor_id: doctorId, date, slot_minutes: SLOT_MIN, slots: days.length ? days[0].slots : [], ...meta });
    return res.json({ doctor_id: doctorId, slot_minutes: SLOT_MIN, days, ...meta });
  });

  r.get('/reference/geo', (req, res) => {
    if (!langOk(req, res)) return;
    res.json(namesDeep(geoReference(), langOf(req)));
  });
  r.get('/reference/specialties', (req, res) => {
    if (!langOk(req, res)) return;
    res.json(namesDeep(specialtiesReference(), langOf(req)));
  });
}
```

`public-server/server/routes/partner.js`. Это версия задачи 9 — пока без заявок; их добавит задача 10:

```js
// PUBLIC_SERVER_V1 — АДРЕСА ПАРТНЁРОВ https://api.easymed.uz/<клиника>/v1/…
// (решение владельца 7). Порядок слоёв — routes/partner-auth.js; чтение —
// partner-read.js; заявки и запись — partner-write.js.
//
// Файлы снимка (/media/<sha256>.<ext>) — без ключа: картинку на сайте партнёра
// браузер грузит без заголовков. Отдаётся только файл из текущего снимка
// клиники (store/media.js), с запретом угадывать вид и исполнять что-либо.
import express from 'express';
import { clinicGate, preflight, requireKey } from './partner-auth.js';
import { readRoutes } from './partner-read.js';
import { mediaFile } from '../store/media.js';
import { sendError } from '../lib/errors.js';

export const PARTNER_BODY_LIMIT = '32kb';

/**
 * @param {{db, dataDir:string, now:()=>number, offsetMin:number, baseUrl:string, requireHttps?:boolean,
 *   limiter?:{hit:(key:string, limit:number, now:number)=>{ok:boolean, retryAfterSec?:number}}}} ctx
 */
export function partnerRouter(ctx) {
  const r = express.Router({ mergeParams: true });
  r.use(clinicGate(ctx));
  r.use(preflight(ctx));
  r.get('/media/:file', (req, res) => {
    const m = /^([0-9a-f]{64})\.([a-z]{3,4})$/.exec(String(req.params.file || ''));
    const f = m ? mediaFile(ctx.db, ctx.dataDir, req.clinic, m[1], m[2]) : null;
    if (!f) return sendError(req, res, 'not_found');
    res.set('Content-Type', f.type);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'");
    return res.sendFile(f.file);
  });
  r.use(express.json({ limit: PARTNER_BODY_LIMIT }));
  r.use(requireKey(ctx));
  readRoutes(r, ctx);
  r.use((req, res) => sendError(req, res, 'not_found'));
  return r;
}
```

- [ ] **Step 5:** тест зелёный — **10 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 6: коммит** «Публичный сервер, вход партнёра и чтение: клиника по имени в адресе (прежнее — 30 дней), ключ по отпечатку, выключен и истёк — 401 своим кодом, права 403, «Разрешённые IP», сайт (CORS), лимиты с Retry-After, 503 «временно недоступна» с телефоном при неоплате, истёкшей лицензии и молчании 7 суток; /clinic, /branches, /doctors, /services, /packages, /slots (stale), /reference/* по документации с ?lang и адресом из справочника; файлы снимка без ключа; журнал запросов без присланного».

---

## Task 10: Заявки и онлайн-запись от партнёров — приём, 409 slot_taken, статус, отмена, другое время (PUBLIC_SERVER_V1)

Сборщик Б.

**Files:**
- Create: `public-server/server/routes/partner-write.js`
- Create: `public-server/server/routes/partner-write.http.test.js`
- Modify: `public-server/server/routes/partner.js` (файл задачи 9; вставки — строки 11 и 38)

- [ ] **Step 1: падающий тест** `public-server/server/routes/partner-write.http.test.js`:

```js
// PUBLIC_SERVER_V1 — заявки и онлайн-запись от партнёров: приём (данные
// пациента — только запечатанными), повтор external_id, проверки полей с field
// и reason, 409 slot_taken по присланному времени и своей очереди, статус,
// отмена, ответ на другое время, лимит записей.
import test from 'node:test';
import assert from 'node:assert/strict';
import { partnerStand, slotsFixture } from '../test-helpers/partner-stand.js';
import { NOW } from '../test-helpers/fixture.js';
import { applyEvents, ackInbox } from '../store/requests.js';
import { openSealed } from '../../../server/services/api/sync-identity.js';
import { isoOf } from '../lib/time.js';

const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });
const PATIENT = { name: 'ИМЯ_ПАЦИЕНТА', phone: '+998901234567', comment: 'КОММЕНТАРИЙ' };
const appt = (over = {}) => ({ doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:00:00+05:00', patient: PATIENT, external_id: 'med-1', ...over });

test('онлайн-запись: 201 pending без hold_until; пациент — только запечатанным; повтор external_id — та же заявка (200)', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const r = await json(await s.send('POST', '/shifo/v1/appointments', appt()));
  assert.equal(r.status, 201);
  assert.match(r.body.request_id, /^rq_[A-Za-z0-9]{24}$/);
  assert.deepEqual([r.body.status, r.body.external_id, r.body.start, r.body.hold_until], ['pending', 'med-1', '2030-03-12T09:00:00+05:00', undefined]);
  assert.ok(!JSON.stringify(r.body).includes('ИМЯ_ПАЦИЕНТА'), 'данные пациента обратно не уходят');
  const item = s.db.prepare('SELECT * FROM inbox').get();
  assert.ok(!item.data.includes('ИМЯ') && !item.sealed.includes('ИМЯ'));
  assert.deepEqual(openSealed(s.clinic.identity, item.sealed), PATIENT, 'открыть может только клиника');
  const again = await json(await s.send('POST', '/shifo/v1/appointments', appt()));
  assert.deepEqual([again.status, again.body.request_id], [200, r.body.request_id]);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1);
});

test('время: занятое в присланном — 409; своё ждущее — 409; рядом свободное — 201; прошедшее, вне сетки, вне срока записи — 400', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const code = async (body) => { const r = await json(await s.send('POST', '/shifo/v1/appointments', body)); return [r.status, r.body.error ? r.body.error.code : r.body.status, r.body.error && r.body.error.field, r.body.error && r.body.error.reason]; };
  assert.deepEqual(await code(appt({ start: '2030-03-12T09:30:00+05:00', external_id: 'a1' })), [409, 'slot_taken', undefined, undefined], '09:45 занято — 30 минут не помещаются');
  assert.deepEqual(await code(appt({ external_id: 'a2' })), [201, 'pending', undefined, undefined]);
  assert.deepEqual(await code(appt({ start: '2030-03-12T09:15:00+05:00', external_id: 'a3' })), [409, 'slot_taken', undefined, undefined], 'перекрывает ждущую a2');
  assert.deepEqual(await code(appt({ consultation: 'repeat', start: '2030-03-12T10:15:00+05:00', external_id: 'a4' })), [201, 'pending', undefined, undefined]);
  assert.deepEqual(await code(appt({ start: '2030-03-11T08:00:00+05:00', external_id: 'a5' })), [400, 'invalid_field', 'start', 'past']);
  assert.deepEqual(await code(appt({ start: '2030-03-12T09:05:00+05:00', external_id: 'a6' })), [400, 'invalid_field', 'start', 'grid']);
  assert.deepEqual(await code(appt({ consultation: 'repeat', start: '2030-03-12T10:00', external_id: 'a10' })), [201, 'pending', undefined, undefined],
    'без смещения — время Ташкента, а не пояс машины сервера');
  assert.deepEqual(await code(appt({ start: 1900000000000, external_id: 'a11' })), [400, 'invalid_field', 'start', 'format']);
  assert.deepEqual(await code(appt({ start: '2030-03-26T09:00:00+05:00', external_id: 'a7' })), [400, 'invalid_field', 'start', 'horizon']);
  assert.deepEqual(await code(appt({ start: '2030-03-24T09:00:00+05:00', external_id: 'a8' })), [409, 'slot_taken', undefined, undefined],
    'день в пределах присланного, но его нет — врач не работает');
  // Клиника не на связи 5 дней: присланное время кончается 19-го — 24-е решит клиника (решение 19).
  s.db.prepare('UPDATE clinics SET slots = ?, slots_at = ?').run(JSON.stringify({ ...slotsFixture(), generated_at: '2030-03-06T04:00:00Z' }), '2030-03-06T04:00:00Z');
  assert.deepEqual(await code(appt({ start: '2030-03-24T09:00:00+05:00', external_id: 'a9' })), [201, 'pending', undefined, undefined],
    'день за пределами присланного времени — решит клиника');
});

test('поля: врач, вид приёма, услуга, пациент, номер партнёра — 400/404 с field и reason, без присланного значения', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const err = async (body) => { const r = await json(await s.send('POST', '/shifo/v1/appointments', body)); return [r.status, r.body.error.code, r.body.error.field, r.body.error.reason]; };
  assert.deepEqual(await err(appt({ doctor_id: 99 })), [404, 'not_found', 'doctor_id', undefined]);
  assert.deepEqual(await err(appt({ doctor_id: 8 })), [400, 'invalid_field', 'doctor_id', 'live_queue']);
  assert.deepEqual(await err(appt({ doctor_id: undefined })), [400, 'invalid_field', 'doctor_id', 'required']);
  assert.deepEqual(await err(appt({ consultation: 'vip' })), [400, 'invalid_field', 'consultation', 'unknown']);
  assert.deepEqual(await err(appt({ consultation: '', service_id: 999 })), [404, 'not_found', 'service_id', undefined]);
  assert.deepEqual(await err(appt({ patient: { name: 'Имя', phone: '12' } })), [400, 'invalid_field', 'patient.phone', 'format']);
  assert.deepEqual(await err(appt({ patient: { phone: '+998901234567' } })), [400, 'invalid_field', 'patient.name', 'required']);
  assert.deepEqual(await err(appt({ external_id: 'с пробелом' })), [400, 'invalid_field', 'external_id', 'format']);
  const raw = await json(await s.send('POST', '/shifo/v1/appointments', '{"patient":{"name":"ИМЯ_ПАЦИЕНТА"'));
  assert.deepEqual([raw.status, raw.body.error.code], [400, 'bad_json']);
  assert.ok(!JSON.stringify(raw.body).includes('ИМЯ'));
  const svc = await json(await s.send('POST', '/shifo/v1/appointments', appt({ consultation: '', service_id: 302, start: '2030-03-12T10:00:00+05:00' })));
  assert.equal(svc.status, 201, 'запись на услугу (20 минут — два окна)');
});

test('«перезвоните»: 201 new; без телефона — 400; врач не из снимка — 404', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const r = await json(await s.send('POST', '/shifo/v1/requests', { name: 'ИМЯ_ПАЦИЕНТА', phone: '+998901234567', service_id: 301, comment: 'после 18:00', external_id: 'cb-1' }));
  assert.deepEqual([r.status, r.body.status, r.body.type, r.body.service_id], [201, 'new', 'request', 301]);
  assert.deepEqual(openSealed(s.clinic.identity, s.db.prepare('SELECT sealed FROM inbox').get().sealed).comment, 'после 18:00');
  const bad = await json(await s.send('POST', '/shifo/v1/requests', { name: 'Имя' }));
  assert.deepEqual([bad.status, bad.body.error.field], [400, 'phone']);
  assert.equal((await s.send('POST', '/shifo/v1/requests', { name: 'Имя', phone: '+998901234567', doctor_id: 99 })).status, 404);
});

test('статус, отмена, другое время — только своё подключение; права', async (t) => {
  const s = await partnerStand();
  t.after(s.close);
  const id = (await json(await s.send('POST', '/shifo/v1/appointments', appt()))).body.request_id;
  ackInbox(s.db, s.clinicId, '1', [{ request_id: id, hold_until: isoOf(NOW + 1800000) }], NOW);
  const st = await json(await s.get('/shifo/v1/requests/' + id));
  assert.deepEqual([st.body.status, st.body.hold_until], ['pending', '2030-03-11T09:30:00+05:00']);
  assert.equal((await s.get('/shifo/v1/requests/rq_neznayu12345')).status, 404);
  const ev = (seq, event, status, extra) => ({ seq, event, status, webhook_url: '', signature: '',
    body: JSON.stringify({ event_id: 'ev_' + seq, event, request_id: id, external_id: 'med-1', status, occurred_at: isoOf(NOW), ...extra }) });
  applyEvents(s.db, s.clinicId, [ev(1, 'booking.offered_other_time', 'offered', { offered_start: '2030-03-12T10:00:00+05:00', offer_until: '2030-03-11T09:30:00+05:00' })], NOW);
  const off = await json(await s.get('/shifo/v1/requests/' + id));
  assert.deepEqual([off.body.status, off.body.offered_start, off.body.offer_until], ['offered', '2030-03-12T10:00:00+05:00', '2030-03-11T09:30:00+05:00']);
  const acc = await json(await s.send('POST', '/shifo/v1/appointments/' + id + '/accept'));
  assert.deepEqual([acc.status, acc.body.status, acc.body.start], [200, 'pending', '2030-03-12T10:00:00+05:00']);
  const again = await json(await s.send('POST', '/shifo/v1/appointments/' + id + '/decline'));
  assert.deepEqual([again.status, again.body.error.code], [409, 'not_offered']);
  const del = await json(await s.send('DELETE', '/shifo/v1/appointments/' + id));
  assert.deepEqual([del.status, del.body.status], [200, 'cancelled']);
  assert.deepEqual(s.db.prepare('SELECT type FROM inbox ORDER BY cursor').all().map((r) => r.type), ['offer.accept', 'appointment.cancel']);
  const no = await json(await s.send('DELETE', '/shifo/v1/appointments/' + id + 'x'));
  assert.equal(no.status, 404);
});

test('права записи: без «Отмена записи» — 403; лимит записей 30 в минуту — 429', async (t) => {
  const s = await partnerStand({ scopes: ['clinic', 'slots', 'requests', 'appointments'], connection: { rate_limit: 300 } });
  t.after(s.close);
  const id = (await json(await s.send('POST', '/shifo/v1/appointments', appt()))).body.request_id;
  const del = await json(await s.send('DELETE', '/shifo/v1/appointments/' + id));
  assert.deepEqual([del.status, del.body.error.code, del.body.error.scope], [403, 'forbidden_scope', 'cancel']);
  let last;
  for (let i = 0; i < 30; i += 1) last = await s.send('POST', '/shifo/v1/requests', { name: 'Имя', phone: '+99890123456' + (i % 10), external_id: 'x' + i });
  assert.equal(last.status, 429, 'тридцать первая запись за минуту');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});
```

- [ ] **Step 2:** `node --test public-server/server/routes/partner-write.http.test.js` → падает: 404 на `POST /appointments` (`assert … 404 !== 201`) — адресов записи ещё нет.
- [ ] **Step 3: модуль** `public-server/server/routes/partner-write.js`:

```js
// PUBLIC_SERVER_V1 — ЗАЯВКИ И ОНЛАЙН-ЗАПИСЬ ОТ ПАРТНЁРОВ (макет «Документация
// API», раздел «Заявки и онлайн-запись»; дизайн шага 8, §2, §3, §6, §7):
//   POST   /requests                     «перезвоните»            → 201 {request_id, status:'new'}
//   POST   /appointments                 запись на время           → 201 {request_id, status:'pending'}
//   GET    /requests/{id}                статус заявки (любой)
//   DELETE /appointments/{id}            отмена пациентом
//   POST   /appointments/{id}/accept     согласие на другое время
//   POST   /appointments/{id}/decline    отказ от другого времени
//
// Данные пациента (имя, телефон, комментарий) проверяются теми же правилами,
// что разбор очереди в клинике (shared/api-booking.js parseInboxItem), и
// запечатываются ключом клиники сразу (store/requests.js) — открытыми не лежат
// нигде и в ответ не возвращаются. Ошибка поля — 400 с field и reason, без
// присланного значения.
//
// Онлайн-запись принимается и когда клиника не на связи (решение 19): ответ
// pending без hold_until — срок назначит клиника при приёме. Время проверяется
// по последнему присланному и своей очереди (409 slot_taken) — первая линия;
// правду скажет клиника. Повтор с тем же external_id — та же заявка (200).
import { CONSULT_API_KINDS } from '../../../public/js/shared/consultation-price.js';
import { snapshotOf, slotsOf } from '../store/clinics.js';
import { createRequest, requestRow, requestByExternal, queueOverlaps, partnerCancel, partnerAnswerOffer } from '../store/requests.js';
import { slotState, windowsNeeded } from '../lib/slot-check.js';
import { sendError } from '../lib/errors.js';
import { localParts, addDays, msOfPartner, isoOf, partnerTime } from '../lib/time.js';
import { scope } from './partner-auth.js';

const EXTERNAL_RE = /^[\x21-\x7e]{1,64}$/;
const LANGS = ['', 'ru', 'uz', 'en'];
const RQ_RE = /^rq_[A-Za-z0-9]{6,37}$/;
const str = (v) => String(v == null ? '' : v).trim();
const posInt = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

class FieldError extends Error {
  constructor(code, extra) { super(code); this.code = code; this.extra = extra; }
}
const field = (name, reason) => new FieldError('invalid_field', { field: name, reason });
const missing = (name) => new FieldError('not_found', { field: name });

/** Имя, телефон, комментарий — правила разбора очереди клиники. */
function patientOf(p, prefix) {
  const name = str(p.name);
  const phone = str(p.phone);
  const comment = str(p.comment);
  if (!name) throw field(prefix + 'name', 'required');
  if (name.length > 120) throw field(prefix + 'name', 'too_long');
  if (!phone) throw field(prefix + 'phone', 'required');
  if (phone.length > 32 || phone.replace(/\D/g, '').length < 7) throw field(prefix + 'phone', 'format');
  if (comment.length > 1000) throw field(prefix + 'comment', 'too_long');
  return { name, phone, comment };
}

/** Общее для обоих видов: номер партнёра, язык, врач/услуга/пакет из снимка. */
function common(b, s) {
  const externalId = str(b.external_id);
  if (externalId && !EXTERNAL_RE.test(externalId)) throw field('external_id', 'format');
  const lang = str(b.lang).toLowerCase();
  if (!LANGS.includes(lang)) throw field('lang', 'unknown');
  const pick = (name, list) => {
    if (b[name] == null || b[name] === '') return null;
    const id = posInt(b[name]);
    if (!id) throw field(name, 'format');
    if (list && !list.some((x) => x.id === id)) throw missing(name);
    return id;
  };
  return {
    externalId, lang,
    doctorId: pick('doctor_id', s.doctors || []), serviceId: pick('service_id', s.services || []),
    packageId: pick('package_id', s.packages || []), branchId: pick('branch_id', null),
  };
}

/** Заявка для партнёра — без данных пациента; время — Ташкент. */
export function publicRequest(row, offsetMin) {
  const t = (v) => partnerTime(v, offsetMin);
  const out = { request_id: row.id, external_id: row.external_id || '', type: row.kind, status: row.status };
  if (row.reason) out.reason = row.reason;
  for (const k of ['doctor_id', 'branch_id', 'service_id', 'package_id']) if (row[k]) out[k] = row[k];
  if (row.consultation) out.consultation = row.consultation;
  if (row.start_at) out.start = t(row.start_at);
  if (row.status === 'pending' && row.hold_until) out.hold_until = t(row.hold_until);
  if (row.status === 'offered') { out.offered_start = t(row.offered_start); out.offer_until = t(row.offer_until); }
  if (row.status === 'booked' && row.cancel_requested_at) out.cancel_requested = true;
  out.created_at = t(row.created_at);
  out.updated_at = t(row.updated_at);
  return out;
}

/** @param ctx {{db, now, offsetMin}} */
export function writeRoutes(r, ctx) {
  const handle = (fn) => (req, res) => {
    try { return fn(req, res); } catch (e) {
      if (e instanceof FieldError) return sendError(req, res, e.code, e.extra);
      throw e;
    }
  };
  const bodyOf = (req) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new FieldError('bad_request', {});
    return req.body;
  };
  const snap = (req) => {
    const s = snapshotOf(req.clinic);
    if (!s) throw new FieldError('not_found', {});
    return s;
  };
  const created = (res, out, row) => res.status(out.created ? 201 : 200).json(publicRequest(row, ctx.offsetMin));

  r.post('/requests', scope('requests'), handle((req, res) => {
    const b = bodyOf(req);
    const s = snap(req);
    const p = b.patient && typeof b.patient === 'object' ? b.patient : b;
    const patient = patientOf({ name: p.name, phone: p.phone, comment: p.comment ?? b.comment }, b.patient ? 'patient.' : '');
    const c = common(b, s);
    const out = createRequest(ctx.db, { clinic: req.clinic, connectionId: req.conn.id, kind: 'request', ...c, patient, now: ctx.now() });
    if (out.error) return sendError(req, res, out.error, { phone: String((s.clinic && s.clinic.phone) || '') });
    return created(res, out, out.row);
  }));

  r.post('/appointments', scope('appointments'), handle((req, res) => {
    const now = ctx.now();
    const b = bodyOf(req);
    const s = snap(req);
    const c = common(b, s);
    if (!c.doctorId) throw field('doctor_id', 'required');
    const doctor = s.doctors.find((d) => d.id === c.doctorId);
    if (doctor.reception === 'live_queue') throw field('doctor_id', 'live_queue');
    let minutes;
    let consultation = '';
    if (str(b.consultation)) {
      consultation = str(b.consultation);
      if (!CONSULT_API_KINDS.includes(consultation)) throw field('consultation', 'unknown');
      const ct = (doctor.consultations || []).find((x) => x.type === consultation);
      if (!ct) throw field('consultation', 'not_offered');
      minutes = ct.minutes;
    } else if (c.serviceId) {
      minutes = s.services.find((x) => x.id === c.serviceId).minutes;
    } else {
      throw field('consultation', 'required');
    }
    const startMs = msOfPartner(b.start, ctx.offsetMin);
    if (startMs == null) throw field('start', b.start == null ? 'required' : 'format');
    if (startMs <= now) throw field('start', 'past');
    const at = localParts(startMs, ctx.offsetMin);
    if (at.minutes % 15 !== 0 || at.seconds !== 0 || startMs % 1000 !== 0) throw field('start', 'grid');
    const horizon = Number(doctor.booking_days) > 0 ? Number(doctor.booking_days) : 14;
    if (at.date > addDays(localParts(now, ctx.offsetMin).date, horizon - 1)) throw field('start', 'horizon');
    const patient = patientOf(b.patient && typeof b.patient === 'object' ? { ...b.patient, comment: b.patient.comment ?? b.comment } : {}, 'patient.');
    if (c.externalId) {
      const again = requestByExternal(ctx.db, req.clinic.clinic_id, req.conn.id, c.externalId);
      if (again) return res.status(200).json(publicRequest(again, ctx.offsetMin));
    }
    const n = windowsNeeded(minutes);
    const durationMin = Math.min(480, Math.max(5, Number(minutes) > 0 ? Number(minutes) : 15));
    if (slotState(slotsOf(req.clinic), doctor, startMs, n, { now, offsetMin: ctx.offsetMin }) === 'taken'
      || queueOverlaps(ctx.db, req.clinic.clinic_id, doctor.id, startMs, durationMin, now)) {
      return sendError(req, res, 'slot_taken');
    }
    const out = createRequest(ctx.db, { clinic: req.clinic, connectionId: req.conn.id, kind: 'appointment', ...c, consultation,
      startAt: isoOf(startMs), durationMin, patient, now });
    if (out.error) return sendError(req, res, out.error, { phone: String((s.clinic && s.clinic.phone) || '') });
    return created(res, out, out.row);
  }));

  const own = (req, kind = null) => {
    const id = String(req.params.id || '');
    const row = RQ_RE.test(id) ? requestRow(ctx.db, req.clinic.clinic_id, id) : null;
    if (!row || row.connection_id !== req.conn.id || (kind && row.kind !== kind)) throw new FieldError('not_found', {});
    return row;
  };

  r.get('/requests/:id', scope('requests', 'appointments'), handle((req, res) => res.json(publicRequest(own(req), ctx.offsetMin))));

  r.delete('/appointments/:id', scope('cancel'), handle((req, res) => {
    const out = partnerCancel(ctx.db, own(req, 'appointment'), ctx.now());
    return out.error ? sendError(req, res, out.error) : res.json(publicRequest(out.row, ctx.offsetMin));
  }));

  for (const [action, accept] of [['accept', true], ['decline', false]]) {
    r.post('/appointments/:id/' + action, scope('appointments'), handle((req, res) => {
      const out = partnerAnswerOffer(ctx.db, own(req, 'appointment'), accept, ctx.now());
      return out.error ? sendError(req, res, out.error) : res.json(publicRequest(out.row, ctx.offsetMin));
    }));
  }
}
```

- [ ] **Step 4: подключить** — diff к `partner.js` (записать в файл, `git apply --check`, `git apply`):

```diff
diff --git a/public-server/server/routes/partner.js b/public-server/server/routes/partner.js
--- a/public-server/server/routes/partner.js
+++ b/public-server/server/routes/partner.js
@@ -8,6 +8,7 @@
 import express from 'express';
 import { clinicGate, preflight, requireKey } from './partner-auth.js';
 import { readRoutes } from './partner-read.js';
+import { writeRoutes } from './partner-write.js';
 import { mediaFile } from '../store/media.js';
 import { sendError } from '../lib/errors.js';
 
@@ -34,6 +35,7 @@ export function partnerRouter(ctx) {
   r.use(express.json({ limit: PARTNER_BODY_LIMIT }));
   r.use(requireKey(ctx));
   readRoutes(r, ctx);
+  writeRoutes(r, ctx);
   r.use((req, res) => sendError(req, res, 'not_found'));
   return r;
 }
```

- [ ] **Step 5:** `node --test public-server/server/routes/partner-write.http.test.js public-server/server/routes/partner-read.http.test.js` → зелёные, **16 тестов** (и с `force-en.mjs`). Сторожа — как в задаче 1.
- [ ] **Step 6: коммит** «Публичный сервер, заявки и онлайн-запись от партнёров: «перезвоните» и запись на время с проверкой полей правилами клиники (400 с field и reason, без присланного значения), данные пациента — только запечатанными, повтор external_id — та же заявка, 409 slot_taken по присланному времени и своей очереди, запись при клинике без связи — pending без срока; статус, отмена пациентом, согласие и отказ на другое время; записи — не больше 30 в минуту».

---

## Task 11: Приложение, фон, наблюдение, запуск, установка — app.js, jobs.js, /_health и /_metrics, index.js, DEPLOY.md (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/routes/ops.js`, `public-server/server/jobs.js`, `public-server/server/app.js`, `public-server/server/index.js`
- Create: `public-server/server/app.test.js`
- Create: `public-server/DEPLOY.md`

- [ ] **Step 1: падающий тест** `public-server/server/app.test.js`:

```js
// PUBLIC_SERVER_V1 — приложение целиком: служебные адреса, канал клиники и
// адреса партнёров на своих местах; /_health без ключа; /_metrics только с
// токеном и только числа; фон: уборка закрывает и стирает, доставка не
// перекрывает себя.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicServer } from './app.js';
import { runMaintenance, startJobs } from './jobs.js';
import { testDb, testVendor, testClinic, syncCall, NOW } from './test-helpers/fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { createRequest } from './store/requests.js';
import { clinicRow } from './store/clinics.js';
import { isoOf } from './lib/time.js';

async function up(over = {}) {
  const { db, dir } = testDb();
  const vendor = testVendor();
  const { app, ctx } = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, requireHttps: false,
    trustProxy: false, version: '0.1.0', ...over });
  const server = await listen(app);
  return { db, dir, vendor, ctx, base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('/_health — без ключа, только «жив»; /_metrics — без токена нет, с токеном — числа', async (t) => {
  const s = await up({ metricsToken: 'm-TESTONLY' });
  t.after(s.close);
  const h = await fetch(s.base + '/_health');
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(await h.json()).sort(), ['status', 'uptime_s', 'version']);
  assert.equal((await fetch(s.base + '/_metrics')).status, 401);
  assert.equal((await fetch(s.base + '/_metrics', { headers: { Authorization: 'Bearer wrong-TESTONLY' } })).status, 401);
  const m = await (await fetch(s.base + '/_metrics', { headers: { Authorization: 'Bearer m-TESTONLY' } })).json();
  assert.equal(m.clinics, 0);
  assert.ok(Object.values(m).every((v) => v === null || ['number', 'string'].includes(typeof v)), 'только числа и время');
  const off = await up();
  t.after(off.close);
  assert.equal((await fetch(off.base + '/_metrics', { headers: { Authorization: 'Bearer m-TESTONLY' } })).status, 404, 'без токена в настройках — адреса нет');
});

test('маршруты: канал клиники и адреса партнёров не путаются; неизвестное — 404 JSON', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = testClinic(s.vendor);
  const r = await syncCall(s.base, c, 'GET', '/_sync/v1/inbox?after=', undefined, { time: isoOf(NOW) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items, []);
  const p = await fetch(s.base + '/shifo/v1/clinic');
  assert.deepEqual([p.status, (await p.json()).error.code], [404, 'clinic_not_found']);
  const x = await fetch(s.base + '/nothing');
  assert.deepEqual([x.status, x.headers.get('cache-control'), (await x.json()).error.code], [404, 'no-store', 'not_found']);
});

test('уборка: закрывает не забранное за сутки (решение владельца 20), стирает шифротекст; срок — из настроек; повтор — ничего', async (t) => {
  const s = await up();
  t.after(s.close);
  const c = testClinic(s.vendor);
  await syncCall(s.base, c, 'PUT', '/_sync/v1/keys', { generated_at: isoOf(NOW), box_key: c.identity.boxPublic, connections: [] }, { time: isoOf(NOW) });
  createRequest(s.db, { clinic: clinicRow(s.db, c.clinicId), connectionId: 3, kind: 'request', patient: { name: 'Имя', phone: '+998901234567', comment: '' }, now: NOW });
  const HOUR = 3600000;
  assert.equal(runMaintenance(s.db, s.dir, NOW + 23 * HOUR, s.ctx.limiter).not_collected, 0, 'сутки ещё не прошли');
  const jobs = startJobs({ db: s.db, dataDir: s.dir, now: () => NOW + 25 * HOUR, send: async () => ({ status: 200 }), webhooks: false,
    uncollectedMaxMs: 48 * HOUR, maintainEveryMs: 1e9 });
  try {
    assert.equal(jobs.maintainTick().not_collected, 0, 'фон берёт срок из настройки PUBLIC_UNCOLLECTED_MAX_HOURS');
  } finally { jobs.stop(); }
  const r = runMaintenance(s.db, s.dir, NOW + 25 * HOUR, s.ctx.limiter);
  assert.equal(r.not_collected, 1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
  assert.equal(runMaintenance(s.db, s.dir, NOW + 25 * HOUR).not_collected, 0);
});

test('фон: доставка не перекрывает себя, сбой — в состояние, не наружу', async () => {
  const { db, dir } = testDb();
  let release;
  const slow = new Promise((r) => { release = r; });
  const logs = [];
  const jobs = startJobs({ db, dataDir: dir, now: () => NOW, send: async () => { await slow; return { status: 200 }; }, deliverEveryMs: 1e9, maintainEveryMs: 1e9,
    log: { error: (...a) => logs.push(a.join(' ')) } });
  try {
    db.prepare("INSERT INTO deliveries (clinic_id, event_id, event, url, body, signature, next_at, created_at, updated_at) VALUES ('c', 'e', 'request.accepted', 'https://med24.uz/h', '{}', 's', ?, ?, ?)")
      .run(isoOf(NOW), isoOf(NOW), isoOf(NOW));
    const first = jobs.deliverTick();
    assert.equal(await jobs.deliverTick(), null, 'второй такт, пока идёт первый, — пропуск');
    release();
    assert.equal((await first).delivered, 1);
    db.close();
    assert.equal(jobs.maintainTick(), null);
    assert.equal(jobs.status().last_error, 'maintenance');
    assert.equal(logs.length, 1);
  } finally { jobs.stop(); }
});
```

- [ ] **Step 2:** `node --test public-server/server/app.test.js` → падает: `ERR_MODULE_NOT_FOUND` (`app.js`).
- [ ] **Step 3: модули.**

`public-server/server/routes/ops.js`:

```js
// PUBLIC_SERVER_V1 — НАБЛЮДЕНИЕ: /_health для проверки снаружи (8c: проверка
// каждую минуту и сообщение при сбое) и /_metrics для команды Easy-Med.
//
// /_health — без ключа и без подробностей: жив ли процесс и отвечает ли база.
// /_metrics — только с PUBLIC_METRICS_TOKEN (нет токена — адреса нет): числа,
// без единого имени, номера заявки или адреса партнёра.
import crypto from 'node:crypto';
import express from 'express';
import { sendError } from '../lib/errors.js';
import { isoOf } from '../lib/time.js';

const sameToken = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Числа для наблюдения. */
export function metrics(db, now, jobs = null) {
  const n = (sql, ...args) => db.prepare(sql).get(...args).n;
  const day = isoOf(now - 86400000);
  return {
    at: isoOf(now),
    clinics: n('SELECT COUNT(*) AS n FROM clinics'),
    clinics_live_5m: n('SELECT COUNT(*) AS n FROM clinics WHERE last_seen_at >= ?', isoOf(now - 5 * 60000)),
    inbox_waiting: n('SELECT COUNT(*) AS n FROM inbox'),
    inbox_oldest_at: db.prepare('SELECT MIN(received_at) AS t FROM inbox').get().t,
    requests_24h: n('SELECT COUNT(*) AS n FROM requests WHERE created_at >= ?', day),
    closed_24h: n("SELECT COUNT(*) AS n FROM requests WHERE status = 'closed' AND updated_at >= ?", day),
    deliveries_pending: n("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'pending'"),
    deliveries_failed_24h: n("SELECT COUNT(*) AS n FROM deliveries WHERE state = 'failed' AND updated_at >= ?", day),
    access_24h: n('SELECT COUNT(*) AS n FROM access_log WHERE at >= ?', day),
    errors_5xx_24h: n('SELECT COUNT(*) AS n FROM access_log WHERE at >= ? AND status >= 500', day),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    jobs: jobs ? jobs.status() : null,
  };
}

/** @param ctx {{db, now:()=>number, version:string, metricsToken?:string, jobs?:{status:()=>object}}} */
export function opsRouter(ctx) {
  const r = express.Router();
  r.get('/_health', (req, res) => {
    try { ctx.db.prepare('SELECT 1').get(); } catch { return res.status(503).json({ status: 'db_error' }); }
    return res.json({ status: 'ok', version: ctx.version, uptime_s: Math.round(process.uptime()) });
  });
  r.get('/_metrics', (req, res) => {
    if (!ctx.metricsToken) return sendError(req, res, 'not_found');
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || ''));
    if (!m || !sameToken(m[1], ctx.metricsToken)) return sendError(req, res, 'invalid_key');
    return res.json(metrics(ctx.db, ctx.now(), ctx.jobs || null));
  });
  return r;
}
```

`public-server/server/jobs.js`:

```js
// PUBLIC_SERVER_V1 — ФОН: доставка уведомлений (каждые 5 секунд) и уборка
// (каждую минуту). Таймеры unref, такт не перекрывает себя и никогда не
// бросает наружу (по образцу опроса телефонии клиники): упавший такт пишет
// в журнал тип ошибки и стек без сообщения и ждёт следующего.
//
// Уборка — это и обязанности перед партнёрами, и минимизация данных:
//   • закрыть то, на что клиника не ответит (store/requests.js closeOverdue):
//     не забранное за сутки — решение владельца 20, срок из настройки
//     PUBLIC_UNCOLLECTED_MAX_HOURS (config.js uncollectedMaxMs);
//   • статусы старше 90 дней, журналы старше 30 дней, законченные доставки,
//     прежние имена в адресе после 30 дней, файлы без снимка;
//   • wal_checkpoint(TRUNCATE) — стёртые страницы не задерживаются в журнале WAL.
import { closeOverdue, purgeRequests, UNCOLLECTED_MAX_MS } from './store/requests.js';
import { purgeLogs } from './store/logs.js';
import { purgeDeliveries, deliverDue } from './store/deliveries.js';
import { gcMedia } from './store/media.js';
import { safeStack } from './lib/errors.js';
import { isoOf } from './lib/time.js';

export function runMaintenance(db, dataDir, now, limiter = null, { uncollectedMaxMs = UNCOLLECTED_MAX_MS } = {}) {
  const closed = closeOverdue(db, now, { uncollectedMaxMs });
  const purged = purgeRequests(db, now);
  const logs = purgeLogs(db, now);
  const deliveries = purgeDeliveries(db, now);
  const aliases = db.prepare('DELETE FROM slug_aliases WHERE until_at <= ?').run(isoOf(now)).changes;
  const media = gcMedia(db, dataDir, now);
  if (limiter) limiter.sweep(now);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { ...closed, ...purged, logs, deliveries, aliases, media };
}

/**
 * @param {{db, dataDir:string, now?:()=>number, send:(msg:object)=>Promise<{status:number, error?:string}>, webhooks?:boolean,
 *   limiter?:object, uncollectedMaxMs?:number, deliverEveryMs?:number, maintainEveryMs?:number, log?:Console}} o
 */
export function startJobs({ db, dataDir, now = () => Date.now(), send, webhooks = true, limiter = null, uncollectedMaxMs = UNCOLLECTED_MAX_MS,
  deliverEveryMs = 5000, maintainEveryMs = 60000, log = console }) {
  const state = { deliveries_at: null, maintenance_at: null, last_error: '', last_error_at: null };
  let delivering = false;
  const fail = (what, e) => {
    state.last_error = what;
    state.last_error_at = isoOf(now());
    log.error('[public-server] фон:', what, (e && e.name) || 'Error', '\n' + safeStack(e));
  };
  async function deliverTick() {
    if (delivering) return null;
    delivering = true;
    try {
      const r = await deliverDue(db, { now: now(), send });
      state.deliveries_at = isoOf(now());
      return r;
    } catch (e) { fail('delivery', e); return null; } finally { delivering = false; }
  }
  function maintainTick() {
    try {
      const r = runMaintenance(db, dataDir, now(), limiter, { uncollectedMaxMs });
      state.maintenance_at = isoOf(now());
      return r;
    } catch (e) { fail('maintenance', e); return null; }
  }
  const timers = [];
  if (webhooks) timers.push(setInterval(() => { deliverTick(); }, deliverEveryMs));
  timers.push(setInterval(maintainTick, maintainEveryMs));
  for (const t of timers) if (t.unref) t.unref();
  return {
    deliverTick, maintainTick,
    status: () => ({ ...state, webhooks }),
    stop() { for (const t of timers) clearInterval(t); },
  };
}
```

`public-server/server/app.js`:

```js
// PUBLIC_SERVER_V1 — ПРИЛОЖЕНИЕ ПУБЛИЧНОГО СЕРВЕРА api.easymed.uz (шаг 8b).
//
//   /_health, /_metrics     — наблюдение (routes/ops.js);
//   /_sync/v1/*             — канал клиники (routes/sync.js; дизайн §10);
//   /<клиника>/v1/*         — партнёры (routes/partner.js; макет «Документация API»).
// Имя клиники не может начинаться с «_» (shared/api-connections.js slugProblem),
// поэтому служебные адреса с ним не пересекаются.
//
// Без журнала запросов процесса: ни тел, ни заголовков, ни адресов с
// параметрами в журнал systemd не попадает (решение владельца 16). Журнал
// запросов партнёров — в базе, без тел (store/logs.js).
import express from 'express';
import { syncRouter } from './routes/sync.js';
import { partnerRouter } from './routes/partner.js';
import { opsRouter } from './routes/ops.js';
import { createLimiter } from './lib/rate-limit.js';
import { errorHandler, sendError } from './lib/errors.js';
import { DEFAULT_SKEW_MS } from './clinic-auth.js';

/**
 * @param {{db, dataDir:string, now?:()=>number, licencePublicKey?:object|null, offsetMin?:number, baseUrl?:string,
 *   requireHttps?:boolean, trustProxy?:(string|boolean), skewMs?:number, metricsToken?:string, version?:string,
 *   limiter?:object, log?:Console}} o
 * @returns {{app:import('express').Express, ctx:object}}
 */
export function createPublicServer({ db, dataDir, now = () => Date.now(), licencePublicKey = null, offsetMin = 300,
  baseUrl = 'https://api.easymed.uz', requireHttps = true, trustProxy = 'loopback', skewMs = DEFAULT_SKEW_MS, metricsToken = '',
  version = '0.0.0', limiter = createLimiter(), log = console }) {
  const ctx = { db, dataDir, now, licencePublicKey, offsetMin, baseUrl, requireHttps, skewMs, metricsToken, version, limiter, jobs: null };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(opsRouter(ctx));
  app.use('/_sync/v1', syncRouter(ctx));
  app.use('/:slug/v1', partnerRouter(ctx));
  app.use((req, res) => sendError(req, res, 'not_found'));
  app.use(errorHandler(log));
  return { app, ctx };
}
```

`public-server/server/index.js`. Запуск на порту — только на сервере (8c). В тестах он не поднимается, проверка — `node --check` и пути отказа (шаг 5):

```js
// PUBLIC_SERVER_V1 — ЗАПУСК ПУБЛИЧНОГО СЕРВЕРА (systemd-служба
// easymed-public, DEPLOY.md). Настройки — из окружения (config.js); неверная —
// отказ запуска. Слушает только 127.0.0.1 за nginx (TLS — у nginx).
//
// Против зависаний (память symptex-gateway-fragility): у сервера свои сроки на
// заголовки и тело запроса, у фона — свои 10 секунд на уведомление; запрос
// партнёра никогда не ждёт ни клинику, ни сеть — только свою базу.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import { readConfig, SERVICE_ROOT } from './config.js';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createPublicServer } from './app.js';
import { startJobs } from './jobs.js';
import { makeSender } from './lib/webhook-send.js';

let cfg;
try { cfg = readConfig(); } catch (e) {
  console.error('Публичный сервер не запущен: ' + e.message);
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(SERVICE_ROOT, 'package.json'), 'utf8')).version;
fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });

let licencePublicKey = null;
if (cfg.licenceKeyPath) {
  try { licencePublicKey = createPublicKey(fs.readFileSync(cfg.licenceKeyPath, 'utf8')); } catch {
    console.error('Публичный сервер не запущен: PUBLIC_LICENCE_PUBLIC_KEY — не открытый ключ Ed25519 (' + cfg.licenceKeyPath + ')');
    process.exit(1);
  }
}

const db = openDb(path.join(cfg.dataDir, 'public.db'));
migrate(db);
const { app, ctx } = createPublicServer({
  db, dataDir: cfg.dataDir, licencePublicKey, offsetMin: cfg.offsetMin, baseUrl: cfg.baseUrl, requireHttps: cfg.requireHttps,
  trustProxy: cfg.trustProxy, skewMs: cfg.syncSkewMs, metricsToken: cfg.metricsToken, version,
});
const jobs = startJobs({ db, dataDir: cfg.dataDir, send: makeSender({ selfIps: cfg.selfIps }), webhooks: cfg.webhooks, limiter: ctx.limiter,
  uncollectedMaxMs: cfg.uncollectedMaxMs });
ctx.jobs = jobs;

const server = app.listen(cfg.port, cfg.bind, () => {
  console.log('Easy-Med public server ' + version + ' is running on ' + cfg.bind + ':' + cfg.port + ' (data: ' + cfg.dataDir + ')');
  if (!licencePublicKey) console.log('Licence key: the vendor key compiled into the app (server/services/control/licence.js).');
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('Публичный сервер не запущен: порт ' + cfg.port + ' занят — возможно, служба уже работает.');
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  jobs.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 4: установка для 8c** `public-server/DEPLOY.md`:

````markdown
# Публичный сервер api.easymed.uz — как он ставится (PUBLIC_SERVER_V1)

Это описание для шага 8c. Сам шаг 8b на сервер ничего не ставит.

## Где и почему так

- **Машина** — 45.77.242.169 (Vultr, Сингапур), решение владельца 16. На ней уже работают Symptex, n8n и старый шлюз.
  - В августе 2026 нехватка памяти уже роняла symptex.uz (память `symptex-gateway-fragility`).
  - Поэтому служба — **отдельный процесс** под **отдельным пользователем**, с **жёстким потолком памяти**: её падение не роняет соседей, а их падение — её.
- **Данные пациента**:
  - хранятся только запечатанными ключом клиники и стираются, как только клиника подтвердила приём;
  - не забранные клиникой — стираются через сутки, заявка закрывается для партнёра (решение владельца 20, `PUBLIC_UNCOLLECTED_MAX_HOURS`);
  - журнал запросов — без тел;
  - резервные копии базы держать не дольше суток (столько же живёт не забранная заявка) и не копировать их за пределы машины без шифрования.
- **Код** — выгрузка репозитория целиком (как у `control-plane/`). Служба берёт справочники и проверку подписи из `server/` и `public/js/shared/` того же коммита.

## Пользователь, папки, зависимости

```bash
sudo useradd --system --home /var/lib/easymed-public --shell /usr/sbin/nologin easymed-public
sudo install -d -o easymed-public -g easymed-public -m 700 /var/lib/easymed-public
sudo install -d -o root -g root -m 755 /opt/easymed-public
# код: выгрузка тега/коммита в /opt/easymed-public/repo (git archive | tar -x), владелец root, только чтение
cd /opt/easymed-public/repo/public-server && sudo npm ci --omit=dev   # better-sqlite3 для Linux x64, Node 24
```

## Настройки — `/etc/easymed-public.env`

Права на файл: владелец `root`, режим `640`, группа `easymed-public`.

```ini
PUBLIC_PORT=8095
PUBLIC_BIND=127.0.0.1
PUBLIC_DATA_DIR=/var/lib/easymed-public
PUBLIC_BASE_URL=https://api.easymed.uz
PUBLIC_TRUST_PROXY=loopback
PUBLIC_REQUIRE_HTTPS=1
PUBLIC_TZ_OFFSET_MIN=300
# допуск часов компьютера клиники, минуты (решение контролёра 2026-10-12)
PUBLIC_SYNC_SKEW_MIN=15
# сколько не забранная клиникой заявка ждёт, часы; потом закрыта для партнёра, шифротекст стёрт (решение владельца 20)
PUBLIC_UNCOLLECTED_MAX_HOURS=24
# адреса самой машины — уведомления туда не уходят никогда (защита соседних служб)
PUBLIC_SELF_IPS=45.77.242.169
# токен для /_metrics (пусто — адреса нет)
PUBLIC_METRICS_TOKEN=
PUBLIC_WEBHOOKS=1
# пусто — открытый ключ производителя, вшитый в программу (server/services/control/licence.js)
PUBLIC_LICENCE_PUBLIC_KEY=
```

## Служба — `/etc/systemd/system/easymed-public.service`

```ini
[Unit]
Description=Easy-Med public API server (api.easymed.uz)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=easymed-public
Group=easymed-public
WorkingDirectory=/opt/easymed-public/repo/public-server
EnvironmentFile=/etc/easymed-public.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --max-old-space-size=160 server/index.js
Restart=on-failure
RestartSec=5
# потолок памяти и процессора — соседям (Symptex, n8n) ничего не грозит
MemoryHigh=200M
MemoryMax=256M
MemorySwapMax=0
CPUQuota=50%
TasksMax=64
LimitNOFILE=4096
# изоляция
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths=/var/lib/easymed-public
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
```

## nginx — отдельный server и свой upstream

Только на этот процесс, мимо старого шлюза. Вопрос 2 (Cloudflare) решает 8c. Если включат прокси Cloudflare, `PUBLIC_TRUST_PROXY` и `set_real_ip_from` нужно настроить на адреса Cloudflare. Иначе «Разрешённые IP» и лимиты будут считать адреса Cloudflare, а не партнёров.

```nginx
upstream easymed_public { server 127.0.0.1:8095; keepalive 16; }
server {
  listen 443 ssl http2;
  server_name api.easymed.uz;
  ssl_certificate     /etc/letsencrypt/live/api.easymed.uz/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.easymed.uz/privkey.pem;
  client_max_body_size 5m;
  access_log off;                       # без адресов с параметрами и IP в журнале nginx; журнал запросов — в базе службы
  location / {
    proxy_pass http://easymed_public;   # без пути после адреса: путь и query доходят байт в байт (подпись клиники)
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_connect_timeout 3s;
    proxy_read_timeout 25s;
    proxy_send_timeout 25s;
  }
}
server { listen 80; server_name api.easymed.uz; return 444; }   # http не принимаем: ключ уже ушёл бы открытым
```

## Проверка после установки

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now easymed-public
curl -s https://api.easymed.uz/_health                     # {"status":"ok",...}
systemctl show easymed-public -p MemoryCurrent -p MemoryMax
journalctl -u easymed-public --since "10 min ago"          # тел запросов и данных пациентов здесь нет
```

Наблюдение — 8c:
- `/_health` раз в минуту, сообщение в Telegram при сбое;
- `/_metrics` с токеном: очередь заявок, не доставленные уведомления, клиники на связи.
````

- [ ] **Step 5: проверки.**
  - `node --test public-server/server/app.test.js` → зелёный, **4 теста** (и с `force-en.mjs`);
  - `node --check public-server/server/index.js`;
  - отказ запуска без порта, из корня клона, в Git Bash:
    - `PUBLIC_PORT=abc node public-server/server/index.js` → строка «Публичный сервер не запущен: PUBLIC_PORT…», код выхода 1;
    - `PUBLIC_DATA_DIR="$(mktemp -d)" PUBLIC_LICENCE_PUBLIC_KEY=/nonexistent.pem node public-server/server/index.js` → «…PUBLIC_LICENCE_PUBLIC_KEY — не открытый ключ Ed25519…», код 1.
  - Сторожа — как в задаче 1.
- [ ] **Step 6: коммит** «Публичный сервер, приложение и запуск: /_health без ключа, /_metrics с токеном и только числами, канал клиники и адреса партнёров на своих местах, фон доставки и уборки (закрытие без ответа, сроки хранения, прежние имена, файлы без снимка, сброс WAL) с таймерами unref; запуск с настройками из окружения и сроками против зависаний; DEPLOY.md — отдельный пользователь, MemoryMax 256M, свой upstream nginx без журнала адресов».

---

## Task 12: Сквозной прогон с настоящей клиникой в процессе и стражи данных пациента (PUBLIC_SERVER_V1)

Сборщик А.

**Files:**
- Create: `public-server/server/e2e.clinic.test.js`
- Create: `public-server/server/no-plaintext.guard.test.js`

- [ ] **Step 1: сквозной прогон.** Участники:
  - клиника — `bookingSeed` 8a, её обмен `syncOnce`, её `confirmBooking` / `offerOtherTime` / `acceptRequest`;
  - сервер — `createPublicServer` на `listen()`;
  - партнёр — `fetch` с ключом клиники.

Файл `public-server/server/e2e.clinic.test.js`:

```js
// PUBLIC_SERVER_V1 — СКВОЗНОЙ ПРОГОН: НАСТОЯЩАЯ КЛИНИКА ↔ НАСТОЯЩИЙ ПУБЛИЧНЫЙ
// СЕРВЕР ↔ ПАРТНЁР. Обе стороны в одном процессе, сервер — на случайном порту
// (listen), клиника говорит с ним настоящим обменом шага 8a
// (server/services/api/public-sync.js syncOnce) по протоколу §10 — тем же, что
// проверял поддельный сервер 8a. Партнёр — настоящими запросами с ключом,
// выпущенным клиникой. Часы общие и подставные (2030 год).
//
// Сценарий: снимок и время доходят до партнёра; две записи на одно время —
// вторая получает 409 на сервере; клиника принимает первую и держит время
// (held → hold_until у партнёра), шифротекст стёрт; регистратор подтверждает —
// «booked» и уведомление, подписанное секретом подключения; пациент отменяет у
// партнёра — визит отменён календарём клиники, «cancelled»; другое время —
// согласие партнёра доходит до клиники и снова держится; «перезвоните» —
// «взять в работу»; «не оплачено» в подписанной лицензии — партнёрам 503, канал
// клиники открыт. И всё это — без данных пациента в базе сервера и в журнале.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bookingSeed, localAt } from '../../server/test-helpers/api-booking-seed.js';
import { tmpDir } from '../../server/test-helpers/tmpdir.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { loadSyncIdentity, SYNC_KEY_FILE } from '../../server/services/api/sync-identity.js';
import { syncOnce } from '../../server/services/api/public-sync.js';
import { confirmBooking, offerOtherTime, acceptRequest } from '../../server/services/api/bookings.js';
import { SCOPES } from '../../public/js/shared/api-connections.js';
import { createPublicServer } from './app.js';
import { deliverDue } from './store/deliveries.js';
import { testDb, testVendor, signTestLicence } from './test-helpers/fixture.js';
import { localIso } from './lib/time.js';

process.env.LIS_ENABLED = '0';
const NOW = localAt('2030-03-11', '09:00');
const OFFSET = -new Date(NOW).getTimezoneOffset();   // клиника в этом процессе считает в его поясе
const MARKS = ['ИМЯ_ПЕРВОГО', 'ИМЯ_ВТОРОГО', 'ИМЯ_ТРЕТЬЕГО', 'ИМЯ_ЧЕТВЁРТОГО', '998901111111', '998902222222', '998903333333',
  '998904444444', 'КОММЕНТАРИЙ_ПАЦИЕНТА'];

test('настоящая клиника и настоящий публичный сервер: запись, держание, подтверждение, отмена, другое время, заявка, неоплата — без данных пациента на сервере', async (t) => {
  const logged = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...a) => { logged.push(a.map(String).join(' ')); orig[m](...a); };
  }
  t.after(() => { for (const m of Object.keys(orig)) console[m] = orig[m]; });

  // ── клиника ──
  const s = bookingSeed();
  // Все права (и «Отмена записи»); срок ключа — без срока: часы прогона — 2030 год, а ключ партнёра выпущен на год от сегодня.
  s.db.prepare('UPDATE api_connections SET scopes = ?, key_expires_at = NULL WHERE id = ?').run(JSON.stringify([...SCOPES]), s.connId);
  const dataDir = tmpDir('em-pub-e2e-');
  const keyPath = path.join(dataDir, SYNC_KEY_FILE);
  const identity = loadSyncIdentity({ keyPath, create: true });
  const vendor = testVendor();
  const licence = (issuedAt, subscription) => fs.writeFileSync(path.join(dataDir, 'licence.dat'), signTestLicence(vendor, {
    clinic_id: 'c-000777', clinic_name: 'Шифо', modules: [], valid_until: '2030-04-01T00:00:00Z', issued_at: issuedAt, nonce: issuedAt,
    api_sync_key: identity.fingerprint, ...(subscription ? { subscription } : {}) }));
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ clinic_id: 'c-000777' }));
  licence('2030-03-10T00:00:00Z');

  // ── публичный сервер ──
  let clock = NOW;
  const pub = testDb();
  const { app } = createPublicServer({ db: pub.db, dataDir: pub.dir, now: () => clock, licencePublicKey: vendor.publicKey, offsetMin: OFFSET,
    baseUrl: 'https://api.test', requireHttps: false, trustProxy: false, version: 'e2e' });
  const server = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sync = async () => {
    const r = await syncOnce(s.db, dataDir, { fetchImpl: globalThis.fetch, env: { EASYMED_PUBLIC_URL: base }, now: () => clock, keyPath,
      kekPath: s.kekPath, storageDir: path.join(dataDir, 'storage') });
    clock += 15000;
    return r;
  };
  const partner = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + s.key, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const clinicRequest = (publicId) => s.db.prepare('SELECT * FROM api_requests WHERE public_id = ?').get(publicId);
  const serverRequest = (id) => pub.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

  // 1. Снимок, время и ключи доходят до партнёра.
  assert.deepEqual(await sync(), { ok: true, applied: 0, sent: 0 });
  const docs = await partner('GET', '/shifo/v1/doctors?lang=ru');
  assert.equal(docs.status, 200);
  assert.ok(docs.body.doctors.some((d) => d.id === 7 && d.name === 'Петров Пётр Петрович'));
  const slots = await partner('GET', '/shifo/v1/slots?doctor_id=7&date=2030-03-12&consultation=initial');
  assert.ok(slots.body.slots.some((w) => w.start === '10:00'), 'клиника отдала 10:00 свободным');

  // 2. Две записи на одно время: вторая — 409 на сервере, не доходя до клиники.
  const START = localAt('2030-03-12', '10:00');
  const book = (ext, name, phone, startMs = START) => partner('POST', '/shifo/v1/appointments', { doctor_id: 7, consultation: 'initial',
    start: localIso(startMs, OFFSET), patient: { name, phone, comment: 'КОММЕНТАРИЙ_ПАЦИЕНТА' }, external_id: ext });
  const first = await book('med-1', 'ИМЯ_ПЕРВОГО', '+998901111111');
  assert.deepEqual([first.status, first.body.status, first.body.hold_until], [201, 'pending', undefined]);
  const second = await book('med-2', 'ИМЯ_ВТОРОГО', '+998902222222');
  assert.deepEqual([second.status, second.body.error.code], [409, 'slot_taken']);
  const id1 = first.body.request_id;

  // 3. Клиника забирает: держит время, срок — серверу (held); шифротекст стёрт.
  assert.equal((await sync()).applied, 1);
  assert.equal(clinicRequest(id1).status, 'pending');
  assert.equal(clinicRequest(id1).patient_name, 'ИМЯ_ПЕРВОГО', 'клиника открыла запечатанное своим ключом');
  assert.equal(serverRequest(id1).hold_until, clinicRequest(id1).hold_until);
  assert.equal(pub.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0, 'шифротекст стёрт при подтверждении курсора');
  const held = await partner('GET', '/shifo/v1/requests/' + id1);
  assert.equal(held.body.hold_until, localIso(Date.parse(clinicRequest(id1).hold_until), OFFSET));

  // 4. Регистратор подтверждает: «booked» и подписанное клиникой уведомление.
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'ИМЯ_ПЕРВОГО', '+998901111111')").run();
  const confirmed = await confirmBooking(s.db, { id: clinicRequest(id1).id, patientId: 1 }, s.reg, { now: clock, kekPath: s.kekPath });
  await sync();
  assert.equal((await partner('GET', '/shifo/v1/requests/' + id1)).body.status, 'booked');
  const sent = [];
  const fake = async (m) => { sent.push(m); return { status: 200 }; };
  const wave = await deliverDue(pub.db, { now: clock, send: fake });
  assert.ok(wave.delivered >= 1);
  const hook = sent.find((m) => JSON.parse(m.body).event === 'booking.confirmed');
  assert.equal(hook.url, 'https://med24.uz/hooks');
  assert.equal(hook.headers['X-EasyMed-Signature'], 'sha256=' + crypto.createHmac('sha256', s.secret).update(hook.body).digest('hex'),
    'партнёр проверит подпись секретом клиники — сервер её не ставил и подделать не может');

  // 5. Пациент отменяет у партнёра: визит отменён календарём клиники.
  const del = await partner('DELETE', '/shifo/v1/appointments/' + id1);
  assert.deepEqual([del.status, del.body.status, del.body.cancel_requested], [200, 'booked', true]);
  await sync();
  assert.equal(s.db.prepare('SELECT status FROM visits WHERE id = ?').get(confirmed.visit.id).status, 'cancelled');
  assert.equal((await partner('GET', '/shifo/v1/requests/' + id1)).body.status, 'cancelled');

  // 6. Другое время: клиника предлагает, партнёр соглашается, клиника снова держит.
  const third = await book('med-3', 'ИМЯ_ТРЕТЬЕГО', '+998903333333', localAt('2030-03-12', '11:00'));
  assert.equal(third.status, 201);
  await sync();
  const OTHER = localAt('2030-03-12', '12:00');
  offerOtherTime(s.db, { id: clinicRequest(third.body.request_id).id, start: new Date(OTHER).toISOString() }, s.reg, { now: clock, kekPath: s.kekPath });
  await sync();
  const offered = await partner('GET', '/shifo/v1/requests/' + third.body.request_id);
  assert.deepEqual([offered.body.status, offered.body.offered_start], ['offered', localIso(OTHER, OFFSET)]);
  const accepted = await partner('POST', '/shifo/v1/appointments/' + third.body.request_id + '/accept');
  assert.deepEqual([accepted.status, accepted.body.status, accepted.body.start], [200, 'pending', localIso(OTHER, OFFSET)]);
  await sync();
  assert.equal(clinicRequest(third.body.request_id).status, 'pending');
  assert.equal(Date.parse(clinicRequest(third.body.request_id).start_at), OTHER);
  assert.equal(serverRequest(third.body.request_id).hold_until, clinicRequest(third.body.request_id).hold_until, 'срок держания — от клиники');

  // 7. «Перезвоните»: в CRM клиники; «взять в работу» — партнёру «accepted».
  const cb = await partner('POST', '/shifo/v1/requests', { name: 'ИМЯ_ЧЕТВЁРТОГО', phone: '+998904444444', comment: 'КОММЕНТАРИЙ_ПАЦИЕНТА', external_id: 'cb-1' });
  assert.deepEqual([cb.status, cb.body.status], [201, 'new']);
  await sync();
  acceptRequest(s.db, { id: clinicRequest(cb.body.request_id).id }, s.reg, { now: clock, kekPath: s.kekPath });
  await sync();
  assert.equal((await partner('GET', '/shifo/v1/requests/' + cb.body.request_id)).body.status, 'accepted');

  // 8. Данных пациента нет ни в одной ячейке базы сервера, ни в её файлах, ни в журнале процесса.
  pub.db.pragma('wal_checkpoint(TRUNCATE)');
  const cells = [];
  for (const { name } of pub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of pub.db.prepare(`SELECT * FROM ${name}`).all()) cells.push(...Object.values(row).map(String));
  }
  const files = fs.readdirSync(pub.dir).filter((f) => f.startsWith('public.db')).map((f) => fs.readFileSync(path.join(pub.dir, f)));
  for (const mark of MARKS) {
    assert.ok(!cells.some((c) => c.includes(mark)), 'в базе сервера: ' + mark);
    assert.ok(!files.some((b) => b.includes(Buffer.from(mark, 'utf8'))), 'в файле базы сервера: ' + mark);
    assert.ok(!logged.some((l) => l.includes(mark)), 'в журнале процесса: ' + mark);
  }

  // 9. «Не оплачено» в подписанной лицензии (8c): партнёрам 503, канал клиники открыт.
  licence('2030-03-11T05:00:00Z', 'unpaid');
  assert.equal((await sync()).ok, true, 'клиника продолжает обмен — события по принятым записям дойдут');
  const off = await partner('GET', '/shifo/v1/doctors');
  assert.deepEqual([off.status, off.body.error.code], [503, 'licence_lapsed']);
  licence('2030-03-09T00:00:00Z');
  await sync();
  assert.equal((await partner('GET', '/shifo/v1/doctors')).status, 503, 'старая лицензия без отметки «не оплачено» не снимает её');
});
```

- [ ] **Step 2: стражи** `public-server/server/no-plaintext.guard.test.js`:

```js
// PUBLIC_SERVER_V1 — СТРАЖИ РЕШЕНИЯ ВЛАДЕЛЬЦА 16 (сервер в Сингапуре, правовой
// риск принят): данных пациента на сервере — только шифротекст, и тела
// запросов не попадают ни в журнал процесса, ни в ответы.
//
//   1. Поток партнёра со всем, что может прийти: верные запись и заявка,
//      испорченный JSON, неверные поля, слишком большое тело, мусорный адрес
//      и параметры — метки пациента не находятся ни в одной ячейке базы, ни в
//      байтах её файлов, ни в журнале процесса, ни в ответах сервера.
//   2. Исходники: ни один вызов журнала не получает тело, запрос, данные
//      пациента или сообщение ошибки (у ошибки разбора JSON в сообщении — кусок тела).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicServer } from './app.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { keyHash, newApiKey } from '../../server/services/api/secret-box.js';
import { admitClinic, saveKeys, saveSnapshot, saveSlots } from './store/clinics.js';
import { snapshotFixture, slotsFixture } from './test-helpers/partner-stand.js';
import { testDb, testVendor, testClinic, NOW } from './test-helpers/fixture.js';
import { isoOf } from './lib/time.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'ИМЯ_ПАЦИЕНТА_СТРАЖ';
const PHONE = '998907654321';
const NOTE = 'ДИАГНОЗ_СТРАЖ';

test('поток партнёра с данными пациента: в базе, её файлах, журнале и ответах — только шифротекст', async (t) => {
  const logged = [];
  const log = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) log[m] = (...a) => logged.push(a.map(String).join(' '));
  const orig = {};
  for (const m of Object.keys(log)) { orig[m] = console[m]; console[m] = log[m]; }
  t.after(() => { for (const m of Object.keys(orig)) console[m] = orig[m]; });

  const { db, dir } = testDb();
  const vendor = testVendor();
  const clinic = testClinic(vendor);
  admitClinic(db, { clinicId: clinic.clinicId, fingerprint: clinic.identity.fingerprint,
    licence: { issued_at: '2030-03-10T00:00:00Z', valid_until: '2030-04-01T00:00:00Z', subscription: 'active' } }, NOW);
  const key = newApiKey();
  saveKeys(db, clinic.clinicId, { generated_at: isoOf(NOW), box_key: clinic.identity.boxPublic, connections: [{ id: 3, kind: 'partner', active: true,
    key_hash: keyHash(key), scopes: ['clinic', 'doctors', 'slots', 'requests', 'appointments', 'cancel'], rate_limit: 300, key_expires_at: null, ip_allow: [], origins: [] }] }, NOW);
  saveSnapshot(db, clinic.clinicId, snapshotFixture(), NOW);
  saveSlots(db, clinic.clinicId, slotsFixture(), NOW);
  const { app } = createPublicServer({ db, dataDir: dir, now: () => NOW, licencePublicKey: vendor.publicKey, offsetMin: 300, baseUrl: 'https://api.test',
    requireHttps: false, trustProxy: false, log });
  const server = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const answers = [];
  const send = async (method, p, body, type = 'application/json') => {
    const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': type }, body });
    answers.push(res.status + ' ' + await res.text());
    return res.status;
  };
  const patient = { name: NAME, phone: '+' + PHONE, comment: NOTE };
  assert.equal(await send('POST', '/shifo/v1/appointments', JSON.stringify({ doctor_id: 7, consultation: 'initial', start: '2030-03-12T09:00:00+05:00', patient })), 201);
  assert.equal(await send('POST', '/shifo/v1/requests', JSON.stringify({ ...patient, external_id: 'g-1' })), 201);
  assert.equal(await send('POST', '/shifo/v1/appointments', '{"patient":{"name":"' + NAME + '","phone":"' + PHONE), 400);
  assert.equal(await send('POST', '/shifo/v1/appointments', JSON.stringify({ doctor_id: 7, consultation: 'initial', start: NAME, patient })), 400);
  assert.equal(await send('POST', '/shifo/v1/appointments', JSON.stringify({ doctor_id: 7, consultation: 'initial', start: '2030-03-12T10:00:00+05:00',
    patient: { name: NAME, phone: NOTE } })), 400);
  assert.equal(await send('POST', '/shifo/v1/requests', JSON.stringify({ ...patient, pad: 'x'.repeat(40000) })), 413);
  assert.equal(await send('POST', '/shifo/v1/requests', NAME, 'text/plain'), 400);
  assert.equal(await send('GET', '/shifo/v1/' + encodeURIComponent(NAME) + '?name=' + encodeURIComponent(NAME) + '&phone=' + PHONE), 404);
  assert.equal(await send('POST', '/_sync/v1/events', JSON.stringify({ events: [{ seq: 1, body: NAME }] })), 401);

  db.pragma('wal_checkpoint(TRUNCATE)');
  const cells = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of db.prepare(`SELECT * FROM ${name}`).all()) cells.push(...Object.values(row).map(String));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE sealed IS NOT NULL').get().n, 2, 'обе заявки — шифротекстом');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('public.db')).map((f) => fs.readFileSync(path.join(dir, f)));
  for (const mark of [NAME, PHONE, NOTE]) {
    assert.ok(!cells.some((c) => c.includes(mark)), 'в базе: ' + mark);
    assert.ok(!files.some((b) => b.includes(Buffer.from(mark, 'utf8'))), 'в файле базы: ' + mark);
    assert.ok(!logged.some((l) => l.includes(mark)), 'в журнале процесса: ' + mark);
    assert.ok(!answers.some((a) => a.includes(mark)), 'в ответе сервера: ' + mark);
  }
});

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'test-helpers' && e.name !== 'node_modules') sources(p, out); }
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

test('исходники: вызовы журнала не получают тело, запрос, пациента и сообщение ошибки; журнала запросов процесса нет', () => {
  const offenders = [];
  for (const file of sources(HERE)) {
    const rel = path.relative(HERE, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\b(?:console|log)\.(?:log|info|warn|error|debug)\(/.test(line)) {
        if (/req\.|\bbody\b|\braw\b|patient|sealed|query|headers/.test(line)) offenders.push(rel + ':' + (i + 1) + ' — запрос/тело в журнале');
        if (/\.message\b/.test(line) && rel !== 'index.js') offenders.push(rel + ':' + (i + 1) + ' — сообщение ошибки в журнале');
      }
      if (/\bmorgan\b|express\.logger/.test(line)) offenders.push(rel + ':' + (i + 1) + ' — журнал запросов процесса');
    });
  }
  assert.deepEqual(offenders, []);
  assert.ok(sources(HERE).length >= 15, 'страж видит исходники');
});
```

- [ ] **Step 3:** `LIS_ENABLED=0 node --test public-server/server/e2e.clinic.test.js public-server/server/no-plaintext.guard.test.js` → зелёные, **3 теста**; то же с `--import …force-en.mjs`. Прогон должен проходить в любом поясе: при подготовке плана он прогнан в Ташкенте, `TZ=UTC` и `TZ=America/New_York`.
- [ ] **Step 4: стражи проверены на поломке** — только посмотреть и вернуть, не коммитить:
  - в `lib/errors.js` `errorHandler` журналит `err.message` → `no-plaintext.guard.test.js`, тест «исходники», падает;
  - в `store/requests.js` `createRequest` кладёт `who: a.patient.name` в `data` → тест «поток партнёра» падает: «в базе: ИМЯ_ПАЦИЕНТА_СТРАЖ».

  Вернуть файлы (Write прежнего блока плана), тесты снова зелёные.
- [ ] **Step 5: вся служба и сторона клиники 8a.**
  - `LIS_ENABLED=0 node --test` — все 21 файл `public-server/**/*.test.js` явными путями (список — `git ls-files 'public-server/*.test.js'`) → **84 теста** зелёные;
  - сторона клиники не тронута: `LIS_ENABLED=0 node --test server/services/api/public-sync.test.js server/services/api/public-sync.e2e.test.js server/services/api/no-patient-data-to-vendor.test.js`;
  - сторожа — как в задаче 1.
- [ ] **Step 6: коммит** «Публичный сервер, сквозной прогон и стражи: настоящая клиника (обмен 8a) и настоящий сервер в одном процессе — запись, 409 второму партнёру, держание с held, подтверждение с уведомлением, подписанным клиникой, отмена пациентом, другое время, «перезвоните», «не оплачено» — 503 партнёрам при открытом канале клиники; данных пациента нет ни в базе, ни в её файлах, ни в журнале, ни в ответах; журнал без тел — и в исходниках».

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды**, после всех задач и когда другие сборщики клона не пишут:
- как в выпуске: `node --experimental-vm-modules --test` из корня клона;
- как CI на en-US: `node --experimental-vm-modules --import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs --test`.

`LIS_ENABLED=0` на весь набор **не ставить**: тесты приёма анализаторов (`server/lis/*.test.js`) поднимают слушатель на своём порте и с этой переменной падают (35 красных при подготовке плана). Тесты, которым приём мешает, выключают его сами — это держит страж `server/lis-port-hygiene.test.js`; сквозной прогон задачи 12 ставит `LIS_ENABLED = '0'` в своём коде.

Красное в чужой области — сначала проверить, не чужая ли это недописанная правка, и прогнать файл отдельно (нагрузочные осечки — «Проверки плана»).

**2. Проверка «сломать».** Отдельный агент, только чтение; находки — в отчёт. Что пробовать:
- **(a) Личность и лицензия:**
  - подпись другим ключом;
  - лицензия чужой клиники или чужого производителя;
  - старая лицензия с прежним ключом после смены ключа;
  - старая лицензия без «не оплачено» после неоплаченной;
  - запрос со временем на 16 минут назад;
  - тот же подписанный `PUT /keys` повторно (не откатывает);
  - путь с query, переписанный по дороге (подпись не сходится).
- **(b) Данные пациента:**
  - тела `POST /requests` и `POST /appointments` с метками — ни в одной таблице, ни в файлах `public.db*`, ни в журнале процесса, ни в ответах, ни в `access_log`;
  - испорченный JSON;
  - тело больше 32 КБ;
  - метки в пути и в параметрах;
  - после `ack` строк `inbox` с шифротекстом нет;
  - `closeOverdue` через сутки (решение 20) закрывает и стирает не забранное; отмена пациентом (без данных пациента) ждёт клинику 7 суток.
- **(c) Очередь и статусы:**
  - `ack` с курсором чужой клиники и с мусором;
  - `held` чужой заявки;
  - событие с чужим `request_id`;
  - испорченное событие в голове очереди (следующие проходят);
  - отмена партнёром ждущей, записанной, с работой (остаётся `booked`), уже отменённой;
  - согласие после `offer_until`;
  - позднее «истекло» после отмены;
  - `closed` → позднее событие клиники.
- **(d) Ключ и лимиты:**
  - ключ другой клиники по чужому имени в адресе;
  - выключенный, истёкший;
  - IP вне списка, неверная запись в списке;
  - чужой `Origin` с верным ключом;
  - 31 запись в минуту;
  - перебор ключей с одного IP;
  - 1201 запрос с одного IP;
  - `Retry-After` всегда ≥ 1.
- **(e) Уведомления:**
  - адрес на `localhost`, `10.x`, `169.254.169.254`, `[::1]`, на имя, резолвящееся в частный адрес, в адрес самой машины (`PUBLIC_SELF_IPS`), в смесь публичного и частного;
  - `http://`;
  - перенаправление 302 на внутренний адрес (не выполняется);
  - зависший партнёр (10 с);
  - шесть неудач — `failed`, тело стёрто.
- **(f) Имя в адресе:**
  - чужое имя; прежнее имя другой клиники в течение 30 дней;
  - `_sync`, `api`, `v1` как имя.
- **(g) Время и 409:**
  - две записи на одно время подряд;
  - запись поверх присланного «занято»;
  - приём 30 минут на окно перед разрывом;
  - сегодня в прошедшее окно;
  - день за пределами присланного при молчащей клинике;
  - `stale` через 10 минут молчания.
- **(h) Устойчивость:**
  - база недоступна — `/_health` 503, фон пишет код, не падает;
  - 50 000 разных IP — память лимитера ограничена;
  - большой снимок 4 МБ;
  - файл 2 МБ + 1 байт.

**3. Проба без сервера.** Ставит службу 8c. Здесь контролёр:
- запускает задачи 11–12 на чистом клоне;
- открывает `public-server/DEPLOY.md` и сверяет его с машиной 45.77.242.169 (что уже занято: порты, nginx, пользователи) — только чтение, без изменений на машине.

**4. Пуш.** `git push` ветки (владелец: «после изменений — пушить»). Тег не ставится: служба не входит в выпуск программы клиники.

---

## Вопросы владельцу

Каждый — простыми словами, с вариантами, рекомендацией и примером. **Ответы 2026-10-12:** вопрос 1 — **А, сутки** (владелец, решение 20 спецификации); вопрос 2 — **А, 15 минут** (решение контролёра). Код построен по ответам; смена — одна постоянная в `config.js` или настройка окружения.

**Вопрос 1. Сколько ждать клинику, которая не забирает онлайн-записи?** Решение 19 — запись принимается, даже если ПК клиники выключен. Всё это время имя и телефон пациента лежат на сервере в Сингапуре — запечатанными, сервер их прочесть не может.
- **А — выбрано владельцем 2026-10-12 (решение 20), так построено:** сутки. Меньше всего данных вне Узбекистана. Но клиника, выключенная на выходные, потеряет пятничные вечерние записи — партнёр получит «клиника не получила заявку».
- **Б (рекомендовал план):** 7 суток — тот же срок, после которого партнёры и так видят «клиника временно недоступна» (дизайн §2). Выходные и праздники клиника переживает без потерь.
- **В:** 30 суток. Почти ничего не теряется, но данные пациентов дольше всего лежат за рубежом.
- *Пример:* клиника закрылась на Навруз с 20 по 24 марта, ПК выключен. За это время med24 прислал 6 записей. При А все 6 закрыты, партнёр видит «не получила». При Б 25 марта утром все 6 приходят в CRM: прошедшие — «не подтверждено вовремя», карточки остаются, чтобы позвонить.
- Срок — постоянная `DEFAULT_UNCOLLECTED_MAX_HOURS` в `config.js` (24) и настройка `PUBLIC_UNCOLLECTED_MAX_HOURS`; `store/requests.js` (`UNCOLLECTED_MAX_MS`, `closeOverdue`) и фон (`jobs.js`) берут его оттуда. Отмена пациентом и ответ на другое время (данных пациента нет) ждут клинику 7 суток (`PLAIN_ITEM_MAX_MS`).

**Вопрос 2. Часы компьютера клиники сбиты — что делать?** Сервер отвергает запросы клиники, если её часы расходятся с настоящим временем больше чем на 15 минут: так перехваченный запрос нельзя повторить позже.
- **А (рекомендую, так построено; решение контролёра 2026-10-12):** 15 минут. Если часы на ПК клиники сбиты (например, Windows стоит на московском поясе, а время подвели руками), обмен с сервером встаёт, пока часы не исправят. Экран «API» сейчас скажет «нет связи: unauthorized»; понятная надпись «часы компьютера неверны» — в 8d.
- **Б:** 24 часа. Работает при любых сбитых часах, но перехваченный запрос можно повторить в течение суток — например, снова включить ключ, который клиника только что выключила.
- *Пример:* в клинике «Шифо» часы ПК спешат на 2 часа. При А онлайн-записи не доходят, пока администратор не поправит часы (или Easy-Med по телефону). При Б всё работает, но у защиты ключей окно — сутки.
- Срок — постоянная `DEFAULT_SYNC_SKEW_MIN` в `config.js` (её же берёт `clinic-auth.js`) и настройка `PUBLIC_SYNC_SKEW_MIN`.

**Сообщить владельцу (решено, не вопросы):**
- **Заявку, на которую клиника не ответила, сервер закрывает сам** — статус «закрыта» с причиной: «клиника не смогла прочитать заявку» (через 30 минут) или «клиника не получила» (через сутки — решение 20). Уведомления партнёру об этом нет — подписать его может только клиника (решение 5); партнёр видит статус по номеру заявки.
- **Неоплата:** партнёры видят «клиника временно недоступна» и телефон клиники. Клиника, приложившая старую лицензию без отметки, отметку не снимет.
- **Клиника, не выходившая на связь 7 суток**, — партнёрам «временно недоступна»: выключенный в ней ключ не работает по старым правам.
- **Прежний адрес клиники** (`/shifo/` → `/shifo-med/`) работает 30 дней; занять его другая клиника за это время не может.
- **Логотип и фото врачей** доступны по ссылке без ключа — их показывают на сайтах партнёров, — но только те, что клиника публикует сейчас.

---

## Что 8c должен дать 8b

1. **Лицензия:**
   - `payload.api_sync_key` — отпечаток ключа клиники: первые 32 hex SHA-256 от DER (SPKI), как в `sync-identity.js`;
   - `payload.subscription: 'active' | 'unpaid'` — в **подписанной** лицензии, новая лицензия при ближайшей сверке после смены отметки;
   - `issued_at` у каждой выдачи растёт (так делает `signLicence`) — публичный сервер по нему выбирает самую новую лицензию.
   - Если поле оплаты назовут иначе — правится `licence-gate.js subscriptionOf` и его тест.
2. **Ключ производителя:**
   - по умолчанию сервер проверяет лицензии ключом, вшитым в программу (`server/services/control/licence.js`). Перед первой настоящей клиникой там должен стоять настоящий ключ (заметка `DEV_KEY_FINGERPRINT` в `server/index.js`);
   - иначе — путь к PEM в `PUBLIC_LICENCE_PUBLIC_KEY`.
3. **Установка по `public-server/DEPLOY.md`:**
   - пользователь `easymed-public`, `/etc/easymed-public.env`, systemd-служба с `MemoryMax=256M`;
   - `npm ci --omit=dev` на Linux (Node 24);
   - nginx: свой `server` для `api.easymed.uz`, `proxy_pass` без пути, `access_log off`;
   - TLS (Let's Encrypt), DNS `api.easymed.uz` — вопрос 2 дизайна: Cloudflare или напрямую. При Cloudflare — `PUBLIC_TRUST_PROXY` и `set_real_ip_from` на его адреса;
   - `PUBLIC_SELF_IPS=45.77.242.169` (и прочие адреса машины), `PUBLIC_METRICS_TOKEN`.
4. **Наблюдение:**
   - `/_health` раз в минуту и сообщение в Telegram при сбое;
   - `/_metrics`: очередь, `inbox_oldest_at`, `deliveries_failed_24h`, `errors_5xx_24h`.
5. **Резервные копии `public.db`:** не дольше суток (столько живёт не забранная заявка — решение 20), зашифрованными, не за пределы машины без шифрования. В них — шифротекст не забранных заявок.
6. **Переключатель «публичный сервер» на клинику** в панели — это и есть `api_sync_key` в лицензии.
7. **Срочный отзыв ключа партнёра из панели** при клинике без связи: у 8b админ-адреса нет. Предложение для 8c — подписанный производителем список отозванных отпечатков, который сервер принимает своим адресом. Решает план 8c.
8. **Проба на тестовой клинике :8712** — сквозной обмен с настоящим сервером.

---

## Риски

1. **Часы клиники сбиты больше чем на 15 минут** — обмен встаёт (401 `clock_skew`), онлайн-записи до клиники не доходят и через сутки закрываются для партнёра (решение 20). Экран 8a пишет «нет связи: unauthorized». Вопрос 2 решён: 15 минут (решение контролёра 2026-10-12); понятная надпись — 8d.
2. **Сервер закрывает заявку без уведомления** (`closed`) — партнёр узнаёт об этом, только спросив `GET /requests/{id}`. Документация шага 9 обязана это сказать.
3. **«Перезвоните», не открывшаяся ключом клиники, остаётся `new`** до уборки через 90 дней: 8a не сообщает пропуски в подтверждении. Лечение — `skipped` в `POST /inbox/ack` (8d, «Не входит»). С онлайн-записью этого нет: её закрывает `not_processed`.
4. **Продление по телефону** (разблокировка без новой лицензии): программа клиники работает, а партнёры видят 503 после `valid_until` подписанной лицензии.
5. **Остатки на диске.** `secure_delete` и сброс WAL убирают шифротекст из файлов базы, но не из блоков файловой системы и не из резервных копий. Копии — 8c, не дольше суток (решение 20).
6. **Одна база и один процесс на все клиники**; лимиты — в памяти процесса. Второй процесс за nginx разделил бы лимиты пополам. Потолок памяти 256 МБ; кэш снимков (32) и корзины лимитов (50 000) ограничены.
7. **nginx переписывает путь или query** (`proxy_pass` с путём, нормализация `%`-кодирования) — подпись клиники не сходится, обмен — 401. `DEPLOY.md`: `proxy_pass` без пути.
8. **Cloudflare** (вопрос 2 дизайна): IP партнёров станут адресами Cloudflare, пока не настроены `set_real_ip_from` и `PUBLIC_TRUST_PROXY`. Тогда «Разрешённые IP» и лимиты считают не того.
9. **Справочник географии — разбор текста миграции 132.** Новая форма строки в миграции выпала бы молча, но `reference.test.js` сверяет все коды модуля с разобранными и краснеет при расхождении.
10. **Ключ производителя в программе — пока ключ разработки** (`DEV_KEY_FINGERPRINT`). До замены тот, у кого есть его закрытая половина, мог бы подписать лицензию и для публичного сервера. Замена — до первой настоящей клиники (8c).

---

## Не входит

| Что | Почему |
|---|---|
| Установка на 45.77.242.169, DNS, TLS, nginx, наблюдение, резервные копии | 8c (`DEPLOY.md` — его вход). |
| Поле оплаты и отпечаток ключа в лицензии, переключатель в панели, срочный отзыв ключа | 8c (раздел «Что 8c должен дать 8b»). |
| Экраны клиники: журнал запросов, «Последний запрос», доставки, «Проверить адрес», «часы компьютера неверны» | 8d. Сервер уже отдаёт `access`, `deliveries` (по просьбе) и `last_used`. |
| Клиника сообщает пропущенные элементы в подтверждении (`skipped:[public_id]`), чтобы «перезвоните», не открывшаяся ключом, закрывалась сразу | 8d (сторона клиники). Сервер 8b закрывает только онлайн-записи — сроком. |
| Языки ответа по ключу | В подключениях шага 7 поля нет; `?lang` работает (8d — пункт 6 плана 8a). |
| Отсрочка прежнего ключа на 24 часа | Вопрос 6 дизайна — не задавался, «сразу». |
| Уведомление партнёру о закрытии заявки сервером | Подписать может только клиника (решение 5). |
| Документация API | Шаг 9: статусы (с `closed`), ошибки (`field`, `reason`), протокол — в этом плане и дизайне. |
| Пакет в онлайн-записи | Номер пакета принимается и передаётся клинике (8a хранит его); цену пакета на строку ставит только клиника. |

---

## Проверки плана (сделаны при его подготовке)

- **Весь код плана собран и прогнан** в копии дерева `d6f4f9f3`:
  - песочница `scratchpad/plan8b/tree`;
  - выгрузка — `git -c core.autocrlf=false archive`, LF;
  - `node_modules` — копия модулей основного дерева.
- **Служба:** 84 теста в 21 файле — зелёные и как есть, и с `force-en.mjs`. `node --check` — все 49 файлов `.js` службы.
- **Сквозной прогон** (настоящая клиника 8a ↔ настоящий сервер) зелёный в трёх поясах: Ташкент, `TZ=UTC`, `TZ=America/New_York` (переход на летнее время).
- **Стражи проверены на поломке** (задача 12, шаг 4): журнал с `err.message` и имя пациента в `inbox.data` — оба стража краснеют, возврат — зелёные.
- **Полный набор репозитория с файлами плана** (`node --experimental-vm-modules --test`): как в выпуске — 10 592 теста: 10 583 зелёных, 0 красных, 1 пропущен, 8 todo (todo — CRM_TWIN_LINE шага 8a); как CI на en-US (`force-en.mjs`) — то же самое. Первый прогон с `LIS_ENABLED=0` на весь набор дал 35 красных — все в `server/lis/*`: этим тестам нужен слушатель; без переменной они зелёные (отсюда правило в «Завершении»).
- **План проигран по задачам** на чистой копии `d6f4f9f3` (`scratchpad/plan8b/replay`, скрипт `replay8b.mjs`) ровно как велит текст: блоки файлов — из самого плана, diff задачи 10 — `git apply`, после каждой задачи — её тесты. Все 12 задач зелёные по своим командам (задача 1 — вместе со сторожами, 44 теста; задача 10 — 16; задача 12 — вместе со стороной клиники 8a, 24 теста). Итог проигрыша совпадает с песочницей файл в файл — 52 файла; `node --check` — все 49 файлов `.js` проигрыша.
- **Находки прогона, исправленные в плане:**
  - `net.BlockList` с правилом `::ffff:0:0/96` закрывал все публичные IPv4 — правило убрано: адреса IPv4 внутри IPv6 BlockList сверяет с правилами IPv4 сам;
  - ключ партнёра со стенда 8a выпущен на год от сегодняшнего дня, а часы прогона — 2030 год: сервер честно отвечал 401 `key_expired` — сквозной прогон снимает срок ключа;
  - пустой адрес уведомления для экрана — «без уведомлений», для отправки — негодный (`checkWebhookUrl`);
  - самопроверка: время записи без смещения (`2030-03-12T10:00`) `Date.parse` читал бы в поясе машины сервера (на Linux — UTC, сдвиг на 5 часов) — теперь это время Ташкента (`msOfPartner`, тесты задач 1 и 10);
  - самопроверка: потолок по IP стоял после поиска клиники — перебор имён в адресе шёл без лимита; потолок перенесён в начало входа;
  - самопроверка: канал клиники читал тело до 4 МБ до проверки подписи без всякого потолка — добавлен потолок по IP до чтения тела.
- **Спецификация и дизайн — у каждого пункта задача или строка «Не входит»:**
  - решения 4 → 2, 9; 5 → 9 (отпечаток), 8 (подпись клиники); 6 → 7; 7 → 9; 16 → 1, 4, 11, 12; 17 → 2, 3, 9, 12; 18–19 → 4, 10;
  - дизайн §1 → 1, 4; §2 → 9 (`stale`, 7 суток), 10; §3 → 4, 5; §4 → 2, 3; §7 → 4; §8 → 8; §9 → 6, 9; §10 → 5; §13 риск 1 → 12.
