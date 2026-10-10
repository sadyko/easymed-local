# API клиники, шаг 7: экран «API и подключения», ключи, источники CRM (CLINIC_API_STEP7_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Прежний экран «Ключи API» заменяется настоящим экраном «API и подключения». Владелец показал прежний 2026-10-10:
- таблица общего редактора справочников с колонками Название / Ключ / Активен;
- ключ вписывается руками, генератора нет;
- русский текст вперемешку с английским («No ключи api yet — add the first one.», «Add Ключи API»);
- сервер этих ключей не проверяет: это облачная заглушка `api_tokens`.

Владелец: «please fix the api parts too».

На новом экране:
- адрес клиники для подключений `https://api.easymed.uz/<имя>/v1/`;
- подключения: сайт клиники (создаётся сам), Symptex, партнёры;
- у каждого подключения:
  - ключ: выпускает сервер, хранится зашифрованным, администратор открывает и копирует его снова;
  - права;
  - лимит, срок ключа и разрешённые IP;
  - уведомления (вебхук) с секретом;
  - свой источник в CRM;
- журнал изменений без секретов.

Старые экраны «API» и «Публичный сайт» уходят. Экран честно говорит: подключения начнут работать, когда в Easy-Med включат публичный сервер (шаг 8).

**Architecture:**
- Три новые таблицы миграции 242 (только CREATE TABLE): `api_settings`, `api_connections`, `api_journal`.
  - В реестре `/api/db` их нет, как и `telegram_settings`: реестр — белый список, поэтому ни ключа, ни секрета `/api/db` не отдаст по построению.
  - Всё идёт через RPC `server/services/rpc/api-connections.js`.
- Правила полей, прав, событий и адреса — в чистом общем модуле `public/js/shared/api-connections.js`. Его читают экран и сервер.
- Ключи и секреты:
  - выпускает `server/services/api/secret-box.js` (CSPRNG);
  - шифрует AES-256-GCM ключом из файла `<data>/.api-secrets-key`;
  - рядом с шифротекстом хранится SHA-256 ключа — по нему шаг 8 узнаёт ключ, ничего не расшифровывая.
- Источники CRM подключений создаёт и охраняет `server/services/crm/config.js`. Там уже живёт вся защита справочника источников.

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, `node:crypto`, `node:test`. Клиент — ванильный JS без сборки, поддельный DOM в тестах видов.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — договор:
- «Решения владельца» 3, 4, 5, 7;
- решение 11 (2026-10-10, записано в спецификацию коммитом `89420c64` на ветке шага 4): адрес для партнёров обязателен при включённом подключении;
- «Правила, без которых не строим»: CRM, Старое, Каждый шаг;
- «Порядок», шаг 7.

**Другие источники:**
- Макет экранов: `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\js\screen-api.js` (подключения, `keyField`, `setKeys`, окно `conn-key`), `screen-crm.js` (источники из API, карточка заявки), `mock.css`.
- Находки проверки влияния: `...\impact-review\05-crm-booking-guards.md`, `01-clinic-identity.md`. Номера строк в них устарели, ниже они сверены заново.
- Сверка с макетом (координатор, 2026-10-10): всё, чего шаг 7 не строит, названо в разделе «Что шаг 7 оставляет шагам 4, 8 и 9», с номером шага.

Номера строк ниже сверены с деревом 2026-10-10 (HEAD `8a05c306`). Перед правкой место всё равно находить заново.

**Код плана прогнан.** 2026-10-10 код и тесты задач 1–16 применены к копии дерева вне клона (`git archive 8a05c306`):
- тесты задач зелёные;
- зелёные и названные сторожа: `gate-fallbacks`, `client-rpc-coverage`, `migration-order`, `schema-registry-conformance`, `licence-gate`, `branch-sync/catalogue` и `journal`, `write-grant`, `report-access.journals`, `route-gate`, `app-shell`, `db-query-schema`, роли, CRM;
- все таблицы словаря плана проходят `i18n-coverage`, `i18n-uz-quality` и `i18n-server-messages`.

Не прогонялись только дописки задачи 4 в `company-save.test.js` и `clinic.test.js` — их собирает сборщик.

**Метка кода:** `CLINIC_API_STEP7_V1` — в комментарии каждой своей вставки.

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | **Хранение.** Миграция 242 (CREATE TABLE / CREATE INDEX / одна INSERT): `api_settings` (одна строка — имя в адресе), `api_connections`, `api_journal`. В `schema-registry.js` их нет. Между зданиями они не ездят: их нет в `branch-sync/catalogue.js` `TABLES` и `journal.js` `SHIPPED`. | Ключи недостижимы через `/api/db` по построению — тот же приём, что у `telegram_settings` (мигр. 060). Подключения живут в главном здании: публичный сервер шага 8 берёт данные оттуда. |
| Р2 | **`api_tokens` не удаляется и не переносится.** Таблица остаётся в базе, но убирается из реестра `/api/db`, из прав и с экранов (задачи 14–15) и становится недостижимой. | `DROP TABLE` стёр бы то, что клиника могла вписать руками (сервер этих значений никогда не проверял — это не ключи). Перенос превратил бы вписанное руками в «ключ», которого сервер не выпускал. Удалить таблицу можно позже, отдельным решением, когда станет ясно, что в клиниках она пуста. |
| Р3 | **Ключ** — `em_live_` + 32 знака из алфавита в 57 знаков без похожих (`0/O`, `1/l/I`), ≈ 187 бит. Знаки берёт `crypto.randomInt` (без смещения). **Секрет вебхука** — `em_whsec_` + 32 знака. | Ключ иногда диктуют по телефону. Префиксы узнаёт и человек, и сканер секретов (страж `no-real-api-keys`). |
| Р4 | **Что лежит в базе:** `key_hash` (SHA-256, UNIQUE), `key_sealed` (AES-256-GCM), `key_tail` (последние 4 знака — для маски `em_live_••••a91c`). У секрета — `secret_sealed` и `secret_tail`. | Решение владельца 5: ключ открывают снова, поэтому он хранится шифротекстом, а не только отпечатком. По отпечатку ключ узнаётся без расшифровки (шаг 8); UNIQUE не даёт одному ключу двух подключений. |
| Р5 | **Ключ шифрования (KEK)** — файл `<data>/.api-secrets-key` и его копия `.bak`. Пишется с fsync. Его нет ни в базе, ни в резервных копиях (`backup.js` копирует базу и `storage/`, но не файлы каталога данных). Шифротекст помечен отпечатком KEK: `v1.<12 hex>.<base64>`. | Последствия:<br>• копия базы (флешка, резервная копия) ключей не раскрывает;<br>• восстановление на **этом** ПК — всё открывается;<br>• база на **другом** ПК без файла — ключи продолжают **работать** (отпечаток в базе), но показать их нельзя: экран говорит «файл шифрования остался на прежнем компьютере — выпустите новый»;<br>• клинику переносят копированием всей папки данных — файл едет вместе с базой.<br>Отпечаток KEK отличает «чужой компьютер» от «повреждено». Как у `telegram/crypto.js`: от доступа к самому ПК это не защищает. |
| Р6 | **Черновик ключа.** Окно «Новое подключение» показывает ключ ещё **до** создания (макет: «Скопировать», «Сгенерировать новый»). Ключ выпускает сервер и держит в памяти 30 минут для одного администратора (`server/services/api/drafts.js`). При создании браузер называет номер черновика и **не присылает ключ**. | Иначе собранный руками запрос задал бы клинике ключ «em_live_aaaa…». Перезапуск сервера теряет черновики — окно скажет «устарело», и администратор откроет его заново. |
| Р7 | **Права** — строка «API» (`settings.api`) остаётся. `enforced` → `rpc:api_connection_update`, `grantOps` / `grantColumns` по `api_tokens` уходят.<br>• «Просмотр» — подключения, права, источники, журнал. Ключи и секреты скрыты, даже хвост (правило Telegram).<br>• «Изменение» — включить и выключить, название, сайт, контакт.<br>• Только администратор — имя в адресе, новое подключение, права подключения, уведомления, безопасность, ключи и секреты, удаление. | Смысл прежней строки сохранён: «Изменение» переименовывает и отзывает, ключ создаёт администратор (ADMIN_ROWS_GRANTABLE_V1). Права партнёра и адрес, куда уходят события, — тот же уровень доступа, что ключ. Решение владельца 5: ключи видит только администратор. |
| Р8 | **Значения нигде не оседают.** Ключ или секрет уходит ровно в четырёх ответах, и все четыре — администратору: черновик, создание, «Показать / Скопировать», выпуск нового. Журнал хранит кто, что и когда, без значений. Маршрут `/api/rpc` печатает только имя RPC и текст ошибки; тексты ошибок здесь значений не содержат. | Решение владельца 5: «в журналы не пишутся». Тест задачи 8 ищет ключ в ответах списка, в console, в `ops_events`, в журнале, во всей базе и в её резервной копии. |
| Р9 | **Имя в адресе** — `api_settings.slug`, новая таблица, а не `doc_settings`. Правила:<br>• предложение — из `name_en` / `name_uz` «Компании» (шаг 3);<br>• латиница, цифры и дефис, 3–40 знаков; служебные имена (`api`, `www`, `docs`, …) запрещены;<br>• задаёт администратор;<br>• занятость другой клиникой проверит публичный сервер (шаг 8) — экран говорит это прямо. | Решение владельца 7: `https://api.easymed.uz/<клиника>/v1/`. Адрес API — свойство подключений главного здания. `doc_settings` едет в филиалы (шаг 3), а имя в адресе у клиники одно. |
| Р10 | **Подключение «Сайт клиники» создаётся само**, при первом сохранении имени в адресе:<br>• одно на клинику (UNIQUE), не удаляется;<br>• создаётся **выключенным**: ключ ещё никому не передан, а включение требует адреса для партнёров (решение 11);<br>• адрес сайта не хранится в подключении: это поле «Сайт» «Компании» (шаг 3), одно правило проверки (`websiteProblem`);<br>• источник CRM — прежний «Сайт».<br>Окно «Новое подключение» предлагает только Symptex и партнёра. | Макет: «создано автоматически», «удалить его нельзя», «Если сайт делает EasyMed, адрес подставится сам». Одно поле на одно значение: сайт клиники нельзя вписать в двух местах по-разному. |
| Р11 | **Источник CRM у Symptex и партнёра — свой.** Ключ `api_<латиница>`, название = название подключения, источник видимый. Экран CRM показывает его отдельным закрытым списком. Сохранение списка его не удаляет, не переименовывает и не скрывает. **«Сайт»** (или другой источник, на который смотрит включённое или выключенное, но не удалённое подключение) нельзя скрыть или удалить; переименовать можно. | Правило спецификации «API-источники защищены как «Звонок»». Скрытый источник `/api/db` не даёт ставить новым заявкам (`crm/sources.js:41-50`): скрыть «med24.uz» значило бы отказать каждой заявке партнёра. |
| Р12 | **Удаление подключения — архив.**<br>• Ключ и секрет стираются (CHECK миграции не даёт оставить их у удалённого).<br>• Подключение выключается.<br>• Его источник CRM **скрывается, но не удаляется**: прежние заявки сохраняют источник для отчётов, новых с ним не будет.<br>• Строка остаётся ради журнала.<br>Подключение сайта не удаляется. | Удаление строки потеряло бы связь журнала и источника. Удалённый источник выбросил бы заявки партнёра из отчёта по источникам. |
| Р13 | **Решение владельца 11: адрес для партнёров обязателен, пока включено хоть одно подключение.** Адрес — Город / область, Район, Улица RU из «Компании».<br>• Включение подключения (и создание включённого) без полного адреса — отказ 409 `partner_address_required`; экран ведёт в «Компанию».<br>• Пока подключение включено, «Компания» без адреса не сохраняется. Экран показывает звёздочки и сообщения под полями, сервер (`/api/db`) отвечает 400.<br>• Проверка одна — `partnerAddressProblems` в `shared/clinic-profile.js`.<br>• Правило для филиалов, показанных партнёрам, — в разделе «Шагам 4, 8 и 9». | Решение владельца (координатор, 2026-10-10). Правило — рядом с правилами адреса шага 3 (`addressProblems`), чтобы экран и сервер не разошлись. |
| Р14 | **Безопасность подключения** хранится и правится сейчас, а действует с шагом 8. Экран говорит это прямо.<br>• Лимит запросов: 30 / 60 / 120 / 300 в минуту.<br>• Срок ключа: без срока / 3 / 6 месяцев / 1 год. Дата окончания считается от выдачи ключа; за 14 дней экран ставит метку «истекает», после — «истёк».<br>• Разрешённые IP: до 20, IPv4 / IPv6 / CIDR. | Макет, раздел «Безопасность». Шагу 8 остаётся только применять готовые настройки. Напоминание администратору о сроке (уведомление) — шаг 8: до него ключи не работают вовсе. |
| Р15 | **Уведомления (вебхук):**<br>• адрес `https://` с доменным именем в интернете (не IP, не `localhost` / `.local`);<br>• секрет (сгенерировать, скопировать, выпустить новый);<br>• 7 событий: 4 из макета и `booking.confirmed / booking.offered_other_time / booking.declined` для окна онлайн-записи шага 8.<br>Кнопка «Проверить адрес» видна, но **выключена**, с объяснением. Доставка, повторы и журнал доставок — шаг 8. | Пробное уведомление честно отправить может только публичный сервер. С ПК клиники оно ушло бы другой дорогой и с другого адреса, и проверка «прошла» ничего бы не значила. Запрет IP и `localhost` закрывает подделку запросов к сети самого публичного сервера (SSRF); шаг 8 проверяет ещё раз при отправке. |
| Р16 | **«Журнал» карточки** — две части:<br>• «Запросы с этим ключом» — пусто до шага 8, с честной строкой;<br>• «Изменения настроек» — кто, что и когда.<br>На странице — общий журнал изменений. | Макет: «Журнал» — это запросы партнёра по ключу (шаг 8). Журнал изменений без секретов нужен владельцу уже сейчас. |
| Р17 | **Новый ключ — прежний перестаёт подходить сразу.** Отсрочку на 24 часа из макета не делаем. | До шага 8 ключи не проверяются вовсе, отсрочке нечего откладывать. Вопрос отсрочки — шагу 8 (раздел ниже). |
| Р18 | **Старые экраны уходят.** `views/api-settings.js` (облачный, `/api/v1/keys`) и `views/public-site.js` удаляются вместе с тестами. Адрес `#api-settings` — новый экран (`views/api-connections.js`). `#public-site` пересылает в хаб, как прочие мёртвые облачные адреса. По `/api/v1` — 404 `not_found` (тест). | Правило спецификации «Старое». Маршрут `api-settings` уже знают `permissions.js`, `PARENT_OF`, хлебные крошки и `SETTINGS_HUB_LEGACY_KEYS`. |
| Р19 | **Филиал:** экран говорит «настраиваются в главном здании», любая запись RPC — 409. | Подключений в филиале нет (таблицы не едут). |
| Р20 | **Лицензия:** `api_settings_get` и `api_journal_list` — в `READ_ONLY_RPCS`. Остальное — записи: при блокировке 402. | Тот же порядок, что у прочих RPC (`control/gate.js`). |
| Р21 | **Общий редактор справочников хаба** перестаёт собирать английские фразы: «No … yet — add the first one.», «Add …», «Edit …». | Это ровно то, что владелец увидел на прежнем «Ключи API». Тот же редактор рисует все справочники хаба, поэтому чиним класс, а не случай. |
| Р22 | **Копирование.** `navigator.clipboard` работает только на https или localhost. Если его нет, значение выделяется в поле, и экран просит «Скопируйте вручную». | Так уже делает LIS Proxy (`lab-proxy-card.js`): Easy-Med в сети открывают по `http://<ip>:8000`. |

## Что шаг 7 оставляет шагам 4, 8 и 9 (сверка с макетом)

Каждая строка — требование к названному шагу. Его план обязан закрыть её или объяснить отказ.

**→ Шаг 8 (публичный сервер и онлайн-запись):**
1. Применять настройки подключения:
   - `active`;
   - права (`scopes`);
   - лимит `rate_limit` (сверх лимита — 429);
   - срок `key_expires_at` (истёкший — 401);
   - разрешённые IP `ip_allow`.
2. **Немедленный отзыв.** Выключение, новый ключ и удаление (архив) доходят до публичного сервера **сразу** отдельной отправкой. Ждать 15-минутного снимка нельзя: макет обещает «сразу получает ответ 401».
3. Напоминание администратору за 14 дней до окончания срока ключа (уведомление). Экран шага 7 показывает только метку.
4. Доставка уведомлений:
   - подпись `X-EasyMed-Signature` (HMAC-SHA256 секретом подключения);
   - повторы через 1, 5, 10, 30 и 60 минут;
   - журнал доставок во вкладке «Уведомления» (сейчас — строка «уведомлений ещё не было»);
   - кнопка «Проверить адрес» включается.
5. Журнал запросов с ключом во вкладке «Журнал» и `last_used_at`; сейчас — «ещё не было».
6. Занятость имени в адресе другой клиникой; прежний адрес работает 30 дней после смены.
7. Отсрочка прежнего ключа на 24 часа при выпуске нового (макет) — решить в шаге 8.
8. Языки ответа по ключу (макет «Языки ответа»).
9. **Заявка из API:** источник подключения у неё остаётся. Оператор может дополнить список источников, но не может убрать или заменить источник подключения.
   - Правило — в `crm/sources.js` по признаку «заявка пришла через подключение»: колонку этого признака вводит шаг 8.
   - Экран — без кнопки «×» у этого источника.
10. Окно онлайн-записи «Подтвердить / Предложить другое время / Отклонить». Итог уходит партнёру событиями `booking.confirmed / booking.offered_other_time / booking.declined`: они уже есть в словаре событий шага 7.
11. Опция макета «Без галочки запись подтверждается сразу» **не строится**: она противоречит решению владельца 3 (заявка карту не создаёт, регистратор выбирает карту и подтверждает).

**→ Шаг 9 (документация API):**
1. Кнопка «Документация API» в шапке экрана.
2. Ссылка на документацию и пример `curl` в тексте «Скопировать всё». Сейчас там адрес, ключ, секрет, права и строка о публичном сервере.

**→ Шаг 4 (филиалы) — правило решения 11 по зданиям.** Решено здесь, строится тем шагом, который вольётся вторым (см. «Завершение», п. 5):
- Пока включено хоть одно подключение, у каждого филиала с отметкой «показывать на сайте» адрес для партнёров полный: город / область, район, улица RU — та же `partnerAddressProblems`.
- Сохранение такого филиала с неполным адресом — отказ. Включение отметки у филиала с неполным адресом — отказ.
- Включение подключения отказывает, если неполон адрес главного здания («Компания») **или** любого филиала, показанного партнёрам. Сообщение называет здание.
- Главное здание в списке филиалов берёт адрес из «Компании» (единый источник адреса шага 4) — отдельной проверки у него нет.

**→ Сайт, который делает Easy-Med:** подсказка подключения сайта «Если сайт делает Easy-Med, адрес подставится сам» — адрес в «Компании» → «Сайт» вписывают при публикации сайта. Шаг 7 этого не автоматизирует.

---

## Карта файлов

**Создаются:**
- `server/db/migrations/242_clinic_api_connections.sql`, `server/db/migrations/242.test.js`
- `server/test-helpers/api-connection-row.js` — строка подключения для тестов чужих правил
- `server/test-helpers/api-connections-seed.js` — стенд подключений (администратор, полный адрес, свой файл шифрования)
- `public/js/shared/api-connections.js` (+ `api-connections.test.js`) — словарь прав, событий, видов; правила полей, адреса, IP, срока
- `server/services/api/secret-box.js` (+ `secret-box.test.js`) — выпуск, KEK, шифрование, отпечаток
- `server/services/api/no-real-api-keys.test.js` — страж: живых ключей в исходниках нет
- `server/services/api/partner-address.js` (+ `partner-address.test.js`) — решение владельца 11
- `server/services/api/drafts.js` — черновики ключа
- `server/services/api/connections.js` (+ `connections.test.js`, `connections-keys.test.js`) — подключения, журнал, имя в адресе
- `server/services/rpc/api-connections.js` (+ `api-connections.test.js`)
- Тесты маршрутов: `server/routes/api-connections-http.test.js`, `server/routes/api-v1-gone.test.js`
- Экран:
  - `public/js/admin/views/api-ui.js` — общие кусочки экрана: RPC, поле ключа, разделы, журнал, окно;
  - `public/js/admin/views/api-connections.js` — страница;
  - `public/js/admin/views/api-connection-new.js` — «Новое подключение» и «Что передать подключению»;
  - `public/js/admin/views/api-connection-card.js` — карточка подключения.
- Тесты экрана: `public/js/admin/__tests__/api-harness.mjs`, `api-connections.test.mjs`, `api-connection-new.test.mjs`, `api-connection-card.test.mjs`, `settings-hub-lookup-i18n.test.mjs`

**Меняются:**
- Сервер:
  - `server/services/crm/config.js`
  - `server/services/rpc/crm-config.js`
  - `server/services/rpc/index.js`
  - `server/services/control/gate.js`
  - `server/services/rpc/clinic.js`
  - `server/routes/db.js`
- Реестр и права:
  - `server/db/schema-registry.js`
  - `public/js/shared/permission-catalog.js`
  - `public/js/shared/clinic-profile.js`
- Экраны:
  - `public/js/admin/crm-settings-logic.js`
  - `public/js/admin/views/crm-settings.js`
  - `public/js/admin/views/settings-hub.js`
  - `public/js/admin/views/documents-settings.js`
  - `public/js/admin/views/company-address.js`
  - `public/js/admin.js`
  - `public/js/admin/permissions.js`
  - `public/js/admin/i18n.js`
- Словарь: `public/js/admin/i18n-strings.js`
- Стили: `public/css/admin-views.css`
- Тесты:
  - `server/services/crm/config.test.js`
  - `server/services/rpc/crm-config.test.js`
  - `server/routes/company-save.test.js`
  - `server/db/write-grant.test.js`
  - `server/db/schema-registry.test.js`
  - `server/services/admin-rows-grantable.test.js`
  - клиентские: `crm-settings.test.mjs`, `crm-settings-logic.test.js`, `company-profile.test.mjs`, `app-shell.test.mjs`, `route-gate.test.mjs`, `admin-rows-grantable.test.mjs`, `role-reports-settings.test.mjs`, `i18n-coverage.test.mjs`

**Удаляются:** `public/js/admin/views/api-settings.js`, `public/js/admin/views/public-site.js`.

---

## Правила рабочего дерева (читать до первого шага)

**Дерево:** отдельный клон `C:\Users\user\Desktop\implementation workflow\easymed.api7`, ветка `feat/clinic-api-step7` (от `8a05c306`).
- В клоне `core.autocrlf=false` и своя копия `node_modules`. Это не worktree.
- В этом клоне работают только сборщики шага 7. Шаг 4 строится параллельно в `easymed.api` (ветка `feat/clinic-api-step4`).

**Запрещено:**
- `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`;
- трогать запущенные серверы (:8000, :8712) и каталог `data/`;
- пушить и ставить тег — это делает контролёр.

**Перед каждым коммитом:**
1. `git status --short`.
2. `git diff --cached --name-only` должен быть пуст.
3. Добавлять файлы только явными путями: `git add <файл> …`.

**Миграция — 242.** Шаг 4 занимает 241.
- Перед созданием файла — `ls server/db/migrations | tail -4` в этом клоне и в `easymed.api`.
- Номер занят — взять следующий свободный и переименовать файл, тест и упоминания в плане.
- Пропуски не заполнять (`migrate.js` `lateMigrations`, `migration-order.test.js`).
- **Порядок выпуска:** 242 не должна попасть ни на одну базу (:8000, :8712) раньше 241. Иначе 241 выполнится «поздно».
  - Если шаг 7 готов первым — контролёр либо ждёт шаг 4, либо меняет номера местами: кто вливается первым, берёт меньший.

**Файлы и коммиты:**
- Файлы — LF.
- Сообщение коммита — файлом: Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/api7-<N>.txt`, затем `git commit -F <файл>`.
- Сообщение — по-русски, с меткой `(CLINIC_API_STEP7_V1)`; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

**Тесты:**
- Только явными путями, из корня дерева:
  - `node --test <файлы>` — серверные и `public/js/shared/*.test.js`;
  - `node --experimental-vm-modules --test <файлы>` — клиентские `.mjs`.
- Каталог аргументом не передавать (Node 24 на Windows).
- Харнессы экранов задают `localStorage['admin.lang'] = 'ru'` до импорта видов (ловушка локали CI).
- Ключи в тестах — только выпущенные во время теста (`newApiKey()`) или строки с `TESTONLY`. Никаких «настоящих на вид» в исходниках: это проверяет страж задачи 3.

**Текст и вид:**
- Каждая новая строка интерфейса и каждое сообщение сервера — статьёй ru / uz / en в `public/js/admin/i18n-strings.js`.
  - Все статьи шага — **одним блоком в конце `STRINGS`**, перед закрывающей `};`: заголовок `// CLINIC_API_STEP7_V1 — «API и подключения» …`, закрывающий `// /CLINIC_API_STEP7_V1`.
  - Каждая строка — с хвостом `// CLINIC_API_STEP7_V1`.
  - Так блок шага 4 и блок шага 7 при слиянии не задевают друг друга.
- Перед добавлением — `grep -n '^  "<ключ>":' public/js/admin/i18n-strings.js`. Статья есть — не дублировать: в таблицах ниже такие строки помечены «(есть)».
- Узбекский и английский — без кириллицы (`i18n-uz-quality`). Узбекский апостроф — `‘` (U+2018), как в блоке шага 3.
- Русский текст не склеивать с переменными: шаблон `{x}` + `trf()`.
- Размеры шрифта — только шкала 12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40 (`type-scale`).
- Значки — только из `public/js/admin/icon-map.js` через `Icon()`: Globe, Key, Plus, Copy, Refresh, Lock, Shield, Send, Info, Warning, Trash, Edit, Activity, Building, Sparkles, Link, Check, MapPin. Без эмодзи.
- Вёрстка — без фиксированных ширин больше 320 px:
  - сетки `repeat(auto-fit, minmax(…))`;
  - таблицы — в обёртке с `overflow-x: auto` (прокручивается карточка, не страница);
  - на ширине телефона всё в один столбец.

**Полный прогон** делает контролёр после всех задач («Завершение»). Во время работы — только файлы тестов задачи и названные сторожа.

---

## Task 1: Миграция 242 — имя в адресе, подключения, журнал (CLINIC_API_STEP7_V1)

**Files:**
- Create: `server/db/migrations/242_clinic_api_connections.sql`, `server/db/migrations/242.test.js`
- Create: `server/test-helpers/api-connection-row.js`

- [ ] **Step 1: падающий тест** `server/db/migrations/242.test.js`:

```js
// CLINIC_API_STEP7_V1 (мигр. 242) — ПОДКЛЮЧЕНИЯ API: только CREATE TABLE.
//
// Имя в адресе — одна строка; подключение держит ключ и секрет, пока живо, и
// не держит ничего после удаления; один ключ — одно подключение; сайт клиники
// — один; свой источник CRM — у одного подключения; прежняя заглушка
// api_tokens и справочник источников не тронуты.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore242() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig242-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 242)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('242: три таблицы; имя в адресе пустое; api_tokens и crm_sources не тронуты', () => {
  const db = dbBefore242();
  db.prepare("INSERT INTO api_tokens (name, token) VALUES ('Записка', 'вписано руками')").run();
  const sources = db.prepare('SELECT * FROM crm_sources ORDER BY key').all();
  migrate(db);
  assert.deepEqual(db.prepare('SELECT id, slug FROM api_settings').all().map((r) => ({ ...r })), [{ id: 1, slug: '' }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_connections').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_journal').get().n, 0);
  assert.equal(db.prepare('SELECT token FROM api_tokens').get().token, 'вписано руками', 'прежняя заглушка не стёрта');
  assert.deepEqual(db.prepare('SELECT * FROM crm_sources ORDER BY key').all(), sources);
});

test('242: имя в адресе — латиница, цифры, дефис; 3–40; без дефиса по краям; строка одна', () => {
  const db = fresh();
  const set = (v) => db.prepare('UPDATE api_settings SET slug = ? WHERE id = 1').run(v);
  for (const bad of ['ab', 'Klinika', 'klinika_demo', '-klinika', 'klinika-', 'клиника', 'a'.repeat(41)]) {
    assert.throws(() => set(bad), /CHECK/, bad);
  }
  for (const good of ['abc', 'klinika-demo', 'shifo24', '']) set(good);
  assert.throws(() => db.prepare('INSERT INTO api_settings (id) VALUES (2)').run(), /CHECK/);
});

test('242: вид, https, массивы прав и событий, лимит, срок, длины', () => {
  const db = fresh();
  for (const over of [
    { kind: 'robot' },
    { site_url: 'http://med24.uz' },
    { webhook_url: 'http://med24.uz/hook' },
    { scopes: '{"a":1}' },
    { webhook_events: 'нет' },
    { rate_limit: 50 },
    { key_ttl: '2y' },
    { name: '' },
    { contact: 'x'.repeat(121) },
  ]) {
    assert.throws(() => insertConnectionRow(db, over), /CHECK/, JSON.stringify(over));
  }
  assert.ok(insertConnectionRow(db, { site_url: 'https://med24.uz', webhook_url: 'https://med24.uz/hook', rate_limit: 300, key_ttl: '1y' }));
});

test('242: у сайта клиники адреса нет (он в «Компании»); сайт один', () => {
  const db = fresh();
  assert.throws(() => insertConnectionRow(db, { kind: 'site', name: 'Сайт клиники', crm_source_key: 'website', owns_source: 0, site_url: 'https://x.uz' }), /CHECK/);
  insertConnectionRow(db, { kind: 'site', name: 'Сайт клиники', crm_source_key: 'website', owns_source: 0 });
  assert.throws(() => insertConnectionRow(db, { kind: 'site', name: 'Второй', crm_source_key: 'website', owns_source: 0 }), /UNIQUE/);
});

test('242: живое подключение держит ключ и секрет; удалённое — ни того, ни другого, и выключено', () => {
  const db = fresh();
  assert.throws(() => insertConnectionRow(db, { key_hash: '' }), /CHECK/);
  assert.throws(() => insertConnectionRow(db, { secret_sealed: '' }), /CHECK/);
  const id = insertConnectionRow(db);
  const del = (sets) => db.prepare(`UPDATE api_connections SET deleted_at = '2026-10-10T10:00:00Z', ${sets} WHERE id = ?`).run(id);
  assert.throws(() => del("active = 0, key_hash = '', key_sealed = ''"), /CHECK/, 'секрет остался');
  assert.throws(() => del("key_hash = '', key_sealed = '', secret_sealed = ''"), /CHECK/, 'осталось включённым');
  del("active = 0, key_hash = '', key_sealed = '', secret_sealed = ''");
});

test('242: один ключ — одно подключение; свой источник CRM — у одного подключения', () => {
  const db = fresh();
  const hash = 'a'.repeat(64);
  insertConnectionRow(db, { key_hash: hash });
  assert.throws(() => insertConnectionRow(db, { key_hash: hash, crm_source_key: 'api_other', name: 'other' }), /UNIQUE/);
  insertConnectionRow(db, { crm_source_key: 'api_x', name: 'x' });
  assert.throws(() => insertConnectionRow(db, { crm_source_key: 'api_x', name: 'y' }), /UNIQUE/);
});

test('242: журнал — известные действия, детали объектом', () => {
  const db = fresh();
  const add = (action, detail = '{}') => db.prepare('INSERT INTO api_journal (action, detail) VALUES (?, ?)').run(action, detail);
  for (const a of ['slug_saved', 'created', 'updated', 'enabled', 'disabled', 'key_revealed', 'key_regenerated',
    'secret_revealed', 'secret_regenerated', 'deleted']) add(a);
  assert.throws(() => add('key_copied'), /CHECK/);
  assert.throws(() => add('created', '[1]'), /CHECK/);
  assert.throws(() => add('created', 'не json'), /CHECK|JSON|malformed/i);
});
```

- [ ] **Step 2: помощник тестов** `server/test-helpers/api-connection-row.js`:

```js
// CLINIC_API_STEP7_V1 — строка подключения API для тестов ЧУЖИХ правил (миграция,
// CRM, адрес для партнёров): ключ и секрет — заглушки с TESTONLY, мимо
// secret-box. Свой источник CRM, если подключение им владеет, заводится тут же.
import { randomBytes } from 'node:crypto';

export function insertConnectionRow(db, over = {}) {
  const row = {
    kind: 'partner', name: 'med24.uz', crm_source_key: 'api_med24_uz', owns_source: 1, active: 1,
    key_hash: randomBytes(32).toString('hex'), key_sealed: 'v1.TESTONLY.TESTONLY', key_tail: 'TEST',
    secret_sealed: 'v1.TESTONLY.TESTONLY', secret_tail: 'TEST',
    ...over,
  };
  if (row.owns_source && !db.prepare('SELECT 1 FROM crm_sources WHERE key = ?').get(row.crm_source_key)) {
    db.prepare('INSERT INTO crm_sources (key, label, position, is_active) VALUES (?, ?, 90, 1)').run(row.crm_source_key, row.name || 'x');
  }
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO api_connections (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
```

- [ ] **Step 3:** `node --test server/db/migrations/242.test.js` → падает: таблиц нет.
- [ ] **Step 4: миграция** `server/db/migrations/242_clinic_api_connections.sql`:

```sql
-- 242 — CLINIC_API_STEP7_V1 (2026-10-10): ПОДКЛЮЧЕНИЯ API, КЛЮЧИ, ЖУРНАЛ
-- (шаг 7 API клиники, docs/specs/2026-10-06-clinic-api-design.md;
-- план docs/plans/2026-10-10-clinic-api-7-api-screen.md).
--
-- ТОЛЬКО CREATE TABLE / CREATE INDEX и одна INSERT: ни одна таблица не
-- пересобирается. Прежняя заглушка api_tokens (мигр. 012) НЕ удаляется: её
-- значения сервер никогда не проверял, но клиника могла вписать туда что-то
-- руками, и стереть это миграцией — потерять данные без спроса. Она просто
-- больше не видна (реестр /api/db её не знает — задача 15 плана).
--
-- Таблиц этого файла НЕТ в schema-registry.js — как telegram_settings
-- (мигр. 060): реестр — белый список, поэтому /api/db не отдаст ни ключа, ни
-- секрета по построению; всё — через RPC rpc/api-connections.js. Между
-- зданиями они не ездят (их нет в branch-sync/catalogue.js TABLES и в
-- journal.js SHIPPED): подключения живут в главном здании.

-- Имя клиники в адресе https://api.easymed.uz/<slug>/v1/ (решение владельца 7).
-- Одна строка, id = 1, как doc_settings.
CREATE TABLE api_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  slug       TEXT NOT NULL DEFAULT ''
             CHECK (slug = '' OR (length(slug) BETWEEN 3 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'
                                  AND slug NOT GLOB '-*' AND slug NOT GLOB '*-')),
  updated_at TEXT,
  updated_by INTEGER
);
INSERT INTO api_settings (id) VALUES (1);

-- Подключение: сайт клиники (создаётся сам, адрес — в «Компании»), Symptex,
-- партнёр. Ключ и секрет вебхука — ШИФРОТЕКСТОМ (key_sealed, secret_sealed:
-- «v1.<отпечаток KEK>.<base64>», services/api/secret-box.js) и отпечатком
-- ключа (key_hash, SHA-256 hex) для узнавания без расшифровки (шаг 8).
-- Лимит, срок и IP хранятся сейчас, действуют с публичным сервером (шаг 8).
CREATE TABLE api_connections (
  id                 INTEGER PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('site', 'symptex', 'partner')),
  name               TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 64),
  site_url           TEXT NOT NULL DEFAULT '' CHECK (site_url = '' OR site_url LIKE 'https://_%'),
  contact            TEXT NOT NULL DEFAULT '' CHECK (length(contact) <= 120),
  scopes             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  crm_source_key     TEXT NOT NULL,
  owns_source        INTEGER NOT NULL DEFAULT 0 CHECK (owns_source IN (0, 1)),
  key_hash           TEXT NOT NULL DEFAULT '',
  key_sealed         TEXT NOT NULL DEFAULT '',
  key_tail           TEXT NOT NULL DEFAULT '',
  key_issued_at      TEXT,
  key_issued_by_name TEXT NOT NULL DEFAULT '',
  key_ttl            TEXT NOT NULL DEFAULT 'never' CHECK (key_ttl IN ('never', '3m', '6m', '1y')),
  key_expires_at     TEXT,
  rate_limit         INTEGER NOT NULL DEFAULT 60 CHECK (rate_limit IN (30, 60, 120, 300)),
  ip_allow           TEXT NOT NULL DEFAULT '' CHECK (length(ip_allow) <= 1000),
  webhook_url        TEXT NOT NULL DEFAULT '' CHECK (webhook_url = '' OR webhook_url LIKE 'https://_%'),
  webhook_events     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(webhook_events) AND json_type(webhook_events) = 'array'),
  secret_sealed      TEXT NOT NULL DEFAULT '',
  secret_tail        TEXT NOT NULL DEFAULT '',
  last_used_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  created_by         INTEGER,
  created_by_name    TEXT NOT NULL DEFAULT '',
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at         TEXT,
  deleted_by         INTEGER,
  -- Сайт клиники берёт адрес из «Компании» (doc_settings.website): своего нет.
  CHECK (kind <> 'site' OR site_url = ''),
  -- Живое подключение держит ключ и секрет; удалённое (архив) — ни того, ни
  -- другого, и выключено.
  CHECK ((deleted_at IS NULL AND length(key_hash) = 64 AND key_sealed <> '' AND secret_sealed <> '')
      OR (deleted_at IS NOT NULL AND key_hash = '' AND key_sealed = '' AND secret_sealed = '' AND active = 0))
);
CREATE UNIQUE INDEX api_connections_key_hash   ON api_connections (key_hash) WHERE key_hash <> '';
CREATE UNIQUE INDEX api_connections_one_site   ON api_connections (kind) WHERE kind = 'site';
CREATE UNIQUE INDEX api_connections_own_source ON api_connections (crm_source_key) WHERE owns_source = 1;

-- Кто что сделал — БЕЗ значений ключей и секретов (решение владельца 5).
-- user_name — снимок: журнал переживает переименование и удаление сотрудника.
CREATE TABLE api_journal (
  id            INTEGER PRIMARY KEY,
  at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  connection_id INTEGER REFERENCES api_connections(id),
  user_id       INTEGER,
  user_name     TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL CHECK (action IN ('slug_saved', 'created', 'updated', 'enabled', 'disabled',
                  'key_revealed', 'key_regenerated', 'secret_revealed', 'secret_regenerated', 'deleted')),
  detail        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object')
);
CREATE INDEX api_journal_connection ON api_journal (connection_id, id);
```

- [ ] **Step 5:** тест зелёный. Сторожа:
  - `server/db/migration-order.test.js`, `server/db/migrate.test.js`;
  - `server/db/schema-registry-conformance.test.js`;
  - `server/db/migrations/012.test.js`, `077.test.js`.
- [ ] **Step 6: коммит** `242_clinic_api_connections.sql`, `242.test.js`, `api-connection-row.js`:
  «API клиники: таблицы имени в адресе, подключений с зашифрованными ключами и журнала изменений (миграция 242, CLINIC_API_STEP7_V1)».

---

## Task 2: Общий модуль подключений — права, события, поля, адрес, IP, срок (CLINIC_API_STEP7_V1)

**Files:**
- Create: `public/js/shared/api-connections.js`, `public/js/shared/api-connections.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `public/js/shared/api-connections.test.js`:

```js
// CLINIC_API_STEP7_V1 — правила подключений API: одни для экрана и сервера.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, KIND_INFO, READ_SCOPES, WRITE_SCOPES, SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, RATE_LIMITS, KEY_TTLS, KEY_TTL_LABEL,
  DEFAULTS, KEY_PREFIX, SECRET_PREFIX, KEY_ALPHABET, KEY_RE, SECRET_RE, API_MESSAGES,
  normalizeSlug, slugProblem, suggestSlug, apiBaseUrl, siteUrlProblem, webhookUrlProblem, normalizeIpList, ipListProblem,
  scopesProblem, eventsProblem, orderedScopes, normalizeConnection, connectionProblems, maskSecret, apiSourceKey,
  keyExpiresAt, keyExpiryState,
} from './api-connections.js';
import { PROFILE_MESSAGES } from './clinic-profile.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('словарь: три вида, 6 + 3 права, 7 событий (с booking.* для шага 8), лимиты и сроки', () => {
  assert.deepEqual(KINDS, ['site', 'symptex', 'partner']);
  assert.deepEqual(READ_SCOPES, ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots']);
  assert.deepEqual(WRITE_SCOPES, ['requests', 'appointments', 'cancel']);
  assert.deepEqual(EVENTS, ['request.accepted', 'appointment.created', 'booking.confirmed', 'booking.offered_other_time',
    'booking.declined', 'appointment.cancelled', 'appointment.arrived']);
  assert.deepEqual(RATE_LIMITS, [30, 60, 120, 300]);
  assert.deepEqual(KEY_TTLS, ['never', '3m', '6m', '1y']);
  for (const k of KINDS) {
    const d = DEFAULTS[k];
    assert.equal(scopesProblem(d.scopes), '', k + ': права по умолчанию допустимы');
    assert.equal(eventsProblem(d.events), '');
    assert.ok(RATE_LIMITS.includes(d.rate_limit) && KEY_TTLS.includes(d.key_ttl));
  }
  assert.equal(DEFAULTS.partner.key_ttl, '1y');
});

test('ключ и секрет: узнаваемый префикс и 32 знака алфавита без похожих символов', () => {
  assert.equal(KEY_PREFIX, 'em_live_');
  assert.equal(SECRET_PREFIX, 'em_whsec_');
  assert.equal(KEY_ALPHABET.length, 57);
  for (const ch of '0O1lI') assert.ok(!KEY_ALPHABET.includes(ch), ch);
  assert.ok(KEY_RE.test('em_live_' + 'A'.repeat(32)));
  assert.ok(!KEY_RE.test('em_live_' + 'A'.repeat(31)));
  assert.ok(!KEY_RE.test('em_live_' + '0'.repeat(32)));
  assert.ok(SECRET_RE.test('em_whsec_' + 'b'.repeat(32)));
  assert.equal(maskSecret(KEY_PREFIX, 'a91c'), 'em_live_••••a91c');
  assert.equal(maskSecret(KEY_PREFIX, ''), '');
});

test('имя в адресе: нормализация, формат, служебные имена, предложение из названий', () => {
  assert.equal(normalizeSlug('  Shifo '), 'shifo');
  assert.equal(slugProblem('shifo'), '');
  assert.equal(slugProblem('klinika-demo'), '');
  assert.equal(slugProblem('ab'), API_MESSAGES.slugFormat);
  assert.equal(slugProblem('-shifo'), API_MESSAGES.slugFormat);
  assert.equal(slugProblem('shifo_24'), API_MESSAGES.slugFormat);
  assert.equal(slugProblem('api'), API_MESSAGES.slugReserved);
  assert.equal(slugProblem('docs'), API_MESSAGES.slugReserved);
  assert.equal(suggestSlug('Shifo Clinic', 'Shifo klinikasi'), 'shifo-clinic');
  assert.equal(suggestSlug('', 'O‘zbek Med'), 'ozbek-med');
  assert.equal(suggestSlug('Клиника Шифо'), '');
  assert.equal(apiBaseUrl('shifo'), 'https://api.easymed.uz/shifo/v1/');
  assert.equal(apiBaseUrl(''), '');
});

test('сайт — то же правило, что «Сайт» в «Компании»; вебхук — https и доменное имя в интернете', () => {
  assert.equal(siteUrlProblem('https://med24.uz'), '');
  assert.equal(siteUrlProblem('http://med24.uz'), PROFILE_MESSAGES.website);
  assert.equal(webhookUrlProblem(''), '');
  assert.equal(webhookUrlProblem('https://med24.uz/hooks/easymed'), '');
  assert.equal(webhookUrlProblem('http://med24.uz/hooks'), API_MESSAGES.httpRefused);
  for (const bad of ['https://10.0.0.5/hook', 'https://localhost/hook', 'https://printer.local/x', 'https://[::1]/x',
    'https://user:pw@med24.uz/x', 'https://med24', 'ftp://med24.uz']) {
    assert.equal(webhookUrlProblem(bad), API_MESSAGES.webhookUrl, bad);
  }
  assert.equal(webhookUrlProblem('https://med24.uz/' + 'x'.repeat(300)), API_MESSAGES.urlLong);
});

test('разрешённые IP: по одному в строке, IPv4 / IPv6 / CIDR, не больше 20', () => {
  assert.equal(normalizeIpList(' 203.0.113.7, 203.0.113.0/24\n\n2001:db8::1 '), '203.0.113.7\n203.0.113.0/24\n2001:db8::1');
  assert.equal(ipListProblem(''), '');
  assert.equal(ipListProblem('203.0.113.7\n2001:db8::/32'), '');
  assert.equal(ipListProblem('203.0.113.300'), API_MESSAGES.ipFormat);
  assert.equal(ipListProblem('med24.uz'), API_MESSAGES.ipFormat);
  assert.equal(ipListProblem('1:2::3::4'), API_MESSAGES.ipFormat);
  assert.equal(ipListProblem(Array.from({ length: 21 }, (_, i) => '203.0.113.' + i).join('\n')), API_MESSAGES.ipTooMany);
});

test('права: хотя бы одно; запись требует свободного времени; отмена — записи; события — из словаря', () => {
  assert.equal(scopesProblem([]), API_MESSAGES.scopesEmpty);
  assert.equal(scopesProblem(['clinic', 'robots']), API_MESSAGES.scopesUnknown);
  assert.equal(scopesProblem(['clinic', 'clinic']), API_MESSAGES.scopesUnknown);
  assert.equal(scopesProblem(['clinic', 'appointments']), API_MESSAGES.appointmentsNeedSlots);
  assert.equal(scopesProblem(['clinic', 'slots', 'cancel']), API_MESSAGES.cancelNeedsAppointments);
  assert.deepEqual(orderedScopes(['requests', 'clinic', 'slots']), ['clinic', 'slots', 'requests']);
  assert.equal(eventsProblem(['booking.declined']), '');
  assert.equal(eventsProblem(['payment.done']), API_MESSAGES.eventsUnknown);
});

test('подключение: нормализация и проверка целиком и по частям', () => {
  const v = normalizeConnection({ kind: ' partner ', name: ' med24.uz ', site_url: ' HTTPS://med24.uz ', contact: '  Отдел партнёров ',
    scopes: ['clinic'], webhook_url: '', webhook_events: [], rate_limit: '60', key_ttl: '1y', ip_allow: '203.0.113.7,', active: true });
  assert.deepEqual(v, { kind: 'partner', name: 'med24.uz', contact: 'Отдел партнёров', site_url: 'https://med24.uz', webhook_url: '',
    scopes: ['clinic'], webhook_events: [], rate_limit: 60, key_ttl: '1y', ip_allow: '203.0.113.7', active: 1 });
  assert.deepEqual(connectionProblems(v), {});
  assert.deepEqual(Object.keys(connectionProblems({ ...v, name: '', rate_limit: 50, key_ttl: '2y', active: 2 })).sort(),
    ['active', 'key_ttl', 'name', 'rate_limit']);
  assert.deepEqual(connectionProblems({ name: 'x' }, { partial: true }), {});
  assert.deepEqual(Object.keys(connectionProblems({ kind: 'robot' })), ['kind', 'name', 'scopes']);
});

test('источник CRM подключения: api_<латиница>, свободный, до 32 знаков', () => {
  assert.equal(apiSourceKey('med24.uz', 'partner', []), 'api_med24_uz');
  assert.equal(apiSourceKey('Symptex', 'symptex', []), 'api_symptex');
  assert.equal(apiSourceKey('Клиники рядом', 'partner', []), 'api_partner');
  assert.equal(apiSourceKey('med24.uz', 'partner', ['api_med24_uz']), 'api_med24_uz_2');
  assert.ok(apiSourceKey('x'.repeat(80), 'partner', []).length <= 32);
  assert.match(apiSourceKey('x'.repeat(80), 'partner', []), /^[a-z0-9_]{1,32}$/);
});

test('срок ключа: дата от выдачи; конец месяца не перескакивает; метки «истекает» и «истёк»', () => {
  assert.equal(keyExpiresAt('2026-10-10T09:00:00Z', 'never'), null);
  assert.equal(keyExpiresAt('2026-10-10T09:00:00Z', '3m'), '2027-01-10T09:00:00Z');
  assert.equal(keyExpiresAt('2026-08-31T09:00:00Z', '6m'), '2027-02-28T09:00:00Z');
  assert.equal(keyExpiresAt('2026-10-10T09:00:00Z', '1y'), '2027-10-10T09:00:00Z');
  const now = Date.parse('2026-10-10T00:00:00Z');
  assert.equal(keyExpiryState(null, now), 'none');
  assert.equal(keyExpiryState('2026-12-01T00:00:00Z', now), 'ok');
  assert.equal(keyExpiryState('2026-10-20T00:00:00Z', now), 'soon');
  assert.equal(keyExpiryState('2026-10-09T00:00:00Z', now), 'expired');
});

test('каждая подпись, описание и сообщение модуля переведены на ru / uz / en', () => {
  const texts = [
    ...Object.values(API_MESSAGES),
    ...Object.values(KIND_INFO).flatMap((x) => [x.label, x.desc]),
    ...Object.values(SCOPE_INFO).flatMap((x) => [x.label, x.desc]),
    ...Object.values(EVENT_INFO).flatMap((x) => [x.label, x.desc]),
    ...Object.values(KEY_TTL_LABEL), '{n} в минуту',
  ];
  for (const t of texts) {
    const e = STRINGS[t];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + t);
  }
});
```

- [ ] **Step 2:** `node --test public/js/shared/api-connections.test.js` → падает: модуля нет.
- [ ] **Step 3: модуль** `public/js/shared/api-connections.js`:

```js
// CLINIC_API_STEP7_V1 — ПОДКЛЮЧЕНИЯ API: словарь видов, прав и событий; правила
// полей, имени в адресе, IP и срока ключа. Один модуль на экран «API и
// подключения» и сервер (services/api/connections.js): что не пропустит экран,
// то сервер отклонит теми же словами.
//
// Чистый модуль — без window, базы и перевода. Подписи и сообщения — ключи
// словаря (i18n-strings.js): экран переводит их tr(), сервер отдаёт как есть.
import { websiteProblem, normalizeWebsite } from './clinic-profile.js';

export const API_HOST = 'api.easymed.uz';   // решение владельца 7 (2026-10-10)

export const KINDS = Object.freeze(['site', 'symptex', 'partner']);
export const KIND_INFO = Object.freeze({
  site:    { label: 'Сайт клиники', icon: 'Globe', desc: 'Сайт, который Easy-Med делает для клиники, или собственный сайт клиники.' },
  symptex: { label: 'Symptex', icon: 'Sparkles', desc: 'Маркетплейс клиник: карточка клиники, врачи и онлайн-запись.' },
  partner: { label: 'Партнёр', icon: 'Link', desc: 'Площадки вроде med24.uz или clinics.uz: показывают клинику и присылают пациентов.' },
});

export const READ_SCOPES = Object.freeze(['clinic', 'branches', 'doctors', 'services', 'packages', 'slots']);
export const WRITE_SCOPES = Object.freeze(['requests', 'appointments', 'cancel']);
export const SCOPES = Object.freeze([...READ_SCOPES, ...WRITE_SCOPES]);
export const SCOPE_INFO = Object.freeze({
  clinic:       { label: 'О клинике', desc: 'Название, описание, логотипы, контакты, соцсети, карта' },
  branches:     { label: 'Филиалы', desc: 'Город и район (коды из справочника), адрес на трёх языках, телефоны, часы, маршрут' },
  doctors:      { label: 'Врачи', desc: 'Публичный профиль, специальности (коды из справочника), стаж, фото, цены консультаций' },
  services:     { label: 'Услуги и цены', desc: 'Пять групп: консультации, лаборатория, диагностика, процедуры, хирургия' },
  packages:     { label: 'Пакеты услуг', desc: 'Состав, цена без скидки и цена пакета, срок действия' },
  slots:        { label: 'Свободное время', desc: 'Окна по 15 минут на 14 дней вперёд; у врачей с живой очередью — часы приёма' },
  requests:     { label: 'Заявки', desc: 'Пациент оставляет имя и телефон. В CRM появляется карточка заявки.' },
  appointments: { label: 'Запись на приём', desc: 'Пациент выбирает свободное время. В CRM появляется заявка с выбранным временем.' },
  cancel:       { label: 'Отмена записи', desc: 'Пациент отменяет свою запись на сайте или у партнёра.' },
});

// Четыре события макета и три исхода онлайн-записи — их шлёт окно заявки
// шага 8 («Подтвердить / Предложить другое время / Отклонить»).
export const EVENTS = Object.freeze(['request.accepted', 'appointment.created', 'booking.confirmed',
  'booking.offered_other_time', 'booking.declined', 'appointment.cancelled', 'appointment.arrived']);
export const EVENT_INFO = Object.freeze({
  'request.accepted':           { label: 'Заявка принята', desc: 'Администратор взял заявку в работу' },
  'appointment.created':        { label: 'Пациент записан', desc: 'Клиника записала пациента по заявке: время занято' },
  'booking.confirmed':          { label: 'Онлайн-запись подтверждена', desc: 'Администратор подтвердил время, которое выбрал пациент' },
  'booking.offered_other_time': { label: 'Предложено другое время', desc: 'Клиника предложила пациенту другое время вместо выбранного' },
  'booking.declined':           { label: 'Онлайн-запись отклонена', desc: 'Клиника не может принять пациента в выбранное время' },
  'appointment.cancelled':      { label: 'Запись отменена', desc: 'Клиника или пациент отменили запись' },
  'appointment.arrived':        { label: 'Пациент пришёл', desc: 'Регистратура отметила приход пациента' },
});

export const RATE_LIMITS = Object.freeze([30, 60, 120, 300]);
export const KEY_TTLS = Object.freeze(['never', '3m', '6m', '1y']);
export const KEY_TTL_LABEL = Object.freeze({ never: 'Без срока', '3m': '3 месяца', '6m': '6 месяцев', '1y': '1 год' });
const TTL_MONTHS = Object.freeze({ '3m': 3, '6m': 6, '1y': 12 });
export const EXPIRY_WARN_DAYS = 14;

const ALL_EVENTS_BUT_ARRIVED = EVENTS.filter((e) => e !== 'appointment.arrived');
export const DEFAULTS = Object.freeze({
  site:    Object.freeze({ scopes: [...SCOPES], events: [], rate_limit: 120, key_ttl: 'never' }),
  symptex: Object.freeze({ scopes: [...SCOPES], events: [...EVENTS], rate_limit: 300, key_ttl: 'never' }),
  partner: Object.freeze({ scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'],
    events: ALL_EVENTS_BUT_ARRIVED, rate_limit: 60, key_ttl: '1y' }),
});

export const KEY_PREFIX = 'em_live_';
export const SECRET_PREFIX = 'em_whsec_';
// Без 0/O и 1/l/I: ключ иногда диктуют по телефону. 32 знака ≈ 187 бит.
export const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const KEY_BODY_LEN = 32;
export const KEY_RE = new RegExp('^' + KEY_PREFIX + '[' + KEY_ALPHABET + ']{' + KEY_BODY_LEN + '}$');
export const SECRET_RE = new RegExp('^' + SECRET_PREFIX + '[' + KEY_ALPHABET + ']{' + KEY_BODY_LEN + '}$');

export const NAME_MAX = 64;
export const CONTACT_MAX = 120;
export const URL_MAX = 300;
export const IP_MAX = 20;
export const RESERVED_SLUGS = Object.freeze(['api', 'www', 'admin', 'app', 'docs', 'status', 'help', 'support',
  'static', 'cdn', 'assets', 'auth', 'login', 'settings', 'billing', 'v1', 'easymed']);

export const API_MESSAGES = Object.freeze({
  kind:                    'Неизвестный вид подключения.',
  name:                    'Введите название подключения.',
  nameLong:                'Название — не длиннее 64 знаков.',
  contactLong:             'Контакт — не длиннее 120 знаков.',
  httpRefused:             'Адрес должен начинаться с https://. Обычный http не принимаем: по нему заявки шли бы открытым текстом.',
  webhookUrl:              'Введите полный адрес в интернете, например https://partner.uz/hooks/easymed',
  urlLong:                 'Адрес — не длиннее 300 знаков.',
  scopesEmpty:             'Отметьте хотя бы одно право.',
  scopesUnknown:           'Неизвестное право подключения.',
  appointmentsNeedSlots:   'Запись на приём требует права «Свободное время».',
  cancelNeedsAppointments: 'Отмена записи требует права «Запись на приём».',
  eventsUnknown:           'Неизвестное событие уведомлений.',
  rate:                    'Лимит запросов — 30, 60, 120 или 300 в минуту.',
  ttl:                     'Срок действия ключа — без срока, 3 месяца, 6 месяцев или 1 год.',
  ipFormat:                'Разрешённые IP-адреса — по одному в строке, например 203.0.113.7 или 203.0.113.0/24.',
  ipTooMany:               'Не больше 20 разрешённых адресов.',
  active:                  'Неверное значение «Подключение включено».',
  slugFormat:              'Только латинские буквы, цифры и дефис, от 3 до 40 знаков; без дефиса в начале и в конце.',
  slugReserved:            'Это имя занято адресами самого Easy-Med — выберите другое.',
});

// ---- имя в адресе ------------------------------------------------------------
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export function normalizeSlug(v) { return String(v ?? '').trim().toLowerCase(); }
export function slugProblem(v) {
  const s = normalizeSlug(v);
  if (!SLUG_RE.test(s)) return API_MESSAGES.slugFormat;
  return RESERVED_SLUGS.includes(s) ? API_MESSAGES.slugReserved : '';
}
// Предложение из латинских названий «Компании» (name_en, name_uz): первое, из
// которого вышло допустимое имя. Кириллица не транслитерируется — пусто.
export function suggestSlug(...names) {
  for (const n of names) {
    const s = String(n || '').toLowerCase().replace(/[‘’ʻʼ'`]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    if (s && !slugProblem(s)) return s;
  }
  return '';
}
export function apiBaseUrl(slug) {
  const s = normalizeSlug(slug);
  return s && !slugProblem(s) ? 'https://' + API_HOST + '/' + s + '/v1/' : '';
}

// ---- адреса ------------------------------------------------------------------
// Сайт подключения проверяется ТЕМ ЖЕ правилом, что «Сайт» в «Компании»
// (shared/clinic-profile.js): одно правило на одно понятие.
export const siteUrlProblem = (v) => websiteProblem(v);
export function normalizeUrl(v) {
  const s = String(v ?? '').trim();
  return /^https:\/\//i.test(s) ? 'https://' + s.slice(8) : s;
}
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const PUBLIC_HOST_RE = new RegExp('^(?:' + LABEL + '\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$');
const LOCAL_TLD_RE = /\.(?:local|localhost|internal|lan|home|corp|test|invalid|example)$/;
// Вебхук: https и доменное имя в интернете — не IP, не localhost, не .local.
// Отправлять будет публичный сервер (шаг 8): адрес его собственной сети был бы
// подделкой запроса изнутри (SSRF). Шаг 8 проверяет ещё раз при отправке.
export function webhookUrlProblem(v) {
  const s = normalizeUrl(v);
  if (!s) return '';
  if (s.length > URL_MAX) return API_MESSAGES.urlLong;
  if (/^http:\/\//i.test(s)) return API_MESSAGES.httpRefused;
  let u;
  try { u = new URL(s); } catch { return API_MESSAGES.webhookUrl; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password) return API_MESSAGES.webhookUrl;
  if (!PUBLIC_HOST_RE.test(host) || LOCAL_TLD_RE.test(host)) return API_MESSAGES.webhookUrl;
  return '';
}

// ---- разрешённые IP ----------------------------------------------------------
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp('^' + OCTET + '(?:\\.' + OCTET + '){3}(?:\\/(?:3[0-2]|[12]?\\d))?$');
const IPV6_RE = /^[0-9a-f:]{2,39}(?:\/(?:12[0-8]|1[01]\d|[1-9]?\d))?$/i;
function ipv6Ok(s) {
  if (!IPV6_RE.test(s) || !s.includes(':')) return false;
  const addr = s.split('/')[0];
  const doubles = (addr.match(/::/g) || []).length;
  if (doubles > 1) return false;
  const groups = addr.split(':').filter((g) => g !== '');
  return groups.every((g) => g.length <= 4) && (doubles ? groups.length < 8 : groups.length === 8);
}
export function normalizeIpList(v) {
  return String(v ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).join('\n');
}
export function ipListProblem(v) {
  const list = normalizeIpList(v).split('\n').filter(Boolean);
  if (list.length > IP_MAX) return API_MESSAGES.ipTooMany;
  return list.every((s) => IPV4_RE.test(s) || ipv6Ok(s)) ? '' : API_MESSAGES.ipFormat;
}

// ---- права и события -----------------------------------------------------------
export function scopesProblem(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) return API_MESSAGES.scopesEmpty;
  if (scopes.some((s) => !SCOPES.includes(s)) || new Set(scopes).size !== scopes.length) return API_MESSAGES.scopesUnknown;
  if (scopes.includes('appointments') && !scopes.includes('slots')) return API_MESSAGES.appointmentsNeedSlots;
  if (scopes.includes('cancel') && !scopes.includes('appointments')) return API_MESSAGES.cancelNeedsAppointments;
  return '';
}
export function eventsProblem(events) {
  if (!Array.isArray(events) || events.some((e) => !EVENTS.includes(e)) || new Set(events).size !== events.length) {
    return API_MESSAGES.eventsUnknown;
  }
  return '';
}
export const orderedScopes = (list) => SCOPES.filter((s) => (list || []).includes(s));
export const orderedEvents = (list) => EVENTS.filter((e) => (list || []).includes(e));

// ---- подключение целиком ----------------------------------------------------------
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Только присланные поля: правка карточки шлёт изменённое. */
export function normalizeConnection(v = {}) {
  const out = {};
  for (const k of ['kind', 'name', 'contact']) if (own(v, k)) out[k] = String(v[k] ?? '').trim();
  if (own(v, 'site_url')) out.site_url = normalizeWebsite(v.site_url);
  if (own(v, 'webhook_url')) out.webhook_url = normalizeUrl(v.webhook_url);
  for (const k of ['scopes', 'webhook_events']) if (own(v, k)) out[k] = Array.isArray(v[k]) ? v[k].map((x) => String(x)) : v[k];
  if (own(v, 'rate_limit')) out.rate_limit = Number(v.rate_limit);
  if (own(v, 'key_ttl')) out.key_ttl = String(v.key_ttl ?? '');
  if (own(v, 'ip_allow')) out.ip_allow = normalizeIpList(v.ip_allow);
  if (own(v, 'active')) out.active = v.active === true || v.active === 1 ? 1 : v.active === false || v.active === 0 ? 0 : v.active;
  return out;
}
/** { поле: сообщение }. partial — проверить только присланное. */
export function connectionProblems(v, { partial = false } = {}) {
  const p = {};
  const has = (k) => !partial || own(v, k);
  if (has('kind') && !KINDS.includes(v.kind)) p.kind = API_MESSAGES.kind;
  if (has('name')) {
    const n = String(v.name ?? '');
    if (!n) p.name = API_MESSAGES.name; else if (n.length > NAME_MAX) p.name = API_MESSAGES.nameLong;
  }
  if (has('site_url')) { const m = siteUrlProblem(v.site_url || ''); if (m) p.site_url = m; }
  if (has('contact') && String(v.contact ?? '').length > CONTACT_MAX) p.contact = API_MESSAGES.contactLong;
  if (has('scopes')) { const m = scopesProblem(v.scopes); if (m) p.scopes = m; }
  if (has('webhook_url')) { const m = webhookUrlProblem(v.webhook_url || ''); if (m) p.webhook_url = m; }
  if (has('webhook_events')) { const m = eventsProblem(v.webhook_events ?? []); if (m) p.webhook_events = m; }
  if (has('rate_limit') && own(v, 'rate_limit') && !RATE_LIMITS.includes(v.rate_limit)) p.rate_limit = API_MESSAGES.rate;
  if (has('key_ttl') && own(v, 'key_ttl') && !KEY_TTLS.includes(v.key_ttl)) p.key_ttl = API_MESSAGES.ttl;
  if (has('ip_allow') && own(v, 'ip_allow')) { const m = ipListProblem(v.ip_allow); if (m) p.ip_allow = m; }
  if (has('active') && own(v, 'active') && v.active !== 0 && v.active !== 1) p.active = API_MESSAGES.active;
  return p;
}

export function maskSecret(prefix, tail) { return tail ? prefix + '••••' + tail : ''; }

// Источник CRM подключения: api_<латиница названия>, иначе по виду; свободный.
export function apiSourceKey(name, kind, taken = []) {
  const used = new Set(taken);
  const latin = String(name || '').toLowerCase().replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/, '');
  const base = 'api_' + (latin || (kind === 'symptex' ? 'symptex' : 'partner'));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const k = base.slice(0, 32 - String(n).length - 1).replace(/_+$/, '') + '_' + n;
    if (!used.has(k)) return k;
  }
  throw new Error('no free CRM source key');
}

// ---- срок ключа --------------------------------------------------------------------
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export function keyExpiresAt(issuedIso, ttl) {
  const months = TTL_MONTHS[ttl];
  if (!months) return null;
  const d = new Date(issuedIso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
/** 'none' | 'ok' | 'soon' (≤ 14 дней) | 'expired'. */
export function keyExpiryState(expiresAt, now = Date.now()) {
  if (!expiresAt) return 'none';
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return 'none';
  if (t <= now) return 'expired';
  return t - now <= EXPIRY_WARN_DAYS * 86400000 ? 'soon' : 'ok';
}
```

- [ ] **Step 4: словарь.** Открыть блок шага в конце `STRINGS` (заголовок и закрывающий комментарий — см. «Текст и вид») и внести статьи:

| ru | uz | en |
|---|---|---|
| Сайт клиники | Klinika sayti | Clinic website |
| Сайт, который Easy-Med делает для клиники, или собственный сайт клиники. | Easy-Med klinika uchun yaratadigan sayt yoki klinikaning o‘z sayti. | A website Easy-Med builds for the clinic, or the clinic’s own website. |
| Symptex (есть) | | |
| Маркетплейс клиник: карточка клиники, врачи и онлайн-запись. | Klinikalar marketpleysi: klinika kartochkasi, shifokorlar va onlayn yozilish. | A clinic marketplace: the clinic card, doctors and online booking. |
| Партнёр | Hamkor | Partner |
| Площадки вроде med24.uz или clinics.uz: показывают клинику и присылают пациентов. | med24.uz yoki clinics.uz kabi platformalar: klinikani ko‘rsatadi va bemorlarni yuboradi. | Platforms such as med24.uz or clinics.uz: they show the clinic and send patients. |
| О клинике | Klinika haqida | About the clinic |
| Название, описание, логотипы, контакты, соцсети, карта | Nomi, tavsifi, logotiplar, kontaktlar, ijtimoiy tarmoqlar, xarita | Name, description, logos, contacts, social media, map |
| Город и район (коды из справочника), адрес на трёх языках, телефоны, часы, маршрут | Shahar va tuman (ma’lumotnoma kodlari), uch tildagi manzil, telefonlar, ish vaqti, yo‘nalish | City and district (reference codes), address in three languages, phones, hours, directions |
| Публичный профиль, специальности (коды из справочника), стаж, фото, цены консультаций | Ommaviy profil, mutaxassisliklar (ma’lumotnoma kodlari), tajriba, foto, konsultatsiya narxlari | Public profile, specialties (reference codes), experience, photo, consultation prices |
| Услуги и цены | Xizmatlar va narxlar | Services and prices |
| Пять групп: консультации, лаборатория, диагностика, процедуры, хирургия | Beshta guruh: konsultatsiyalar, laboratoriya, diagnostika, muolajalar, jarrohlik | Five groups: consultations, laboratory, diagnostics, procedures, surgery |
| Состав, цена без скидки и цена пакета, срок действия | Tarkibi, chegirmasiz narx va paket narxi, amal qilish muddati | Contents, price without discount and package price, validity |
| Свободное время | Bo‘sh vaqt | Free time slots |
| Окна по 15 минут на 14 дней вперёд; у врачей с живой очередью — часы приёма | 14 kun oldinga 15 daqiqalik oynalar; jonli navbatli shifokorlarda — qabul soatlari | 15-minute slots for 14 days ahead; for live-queue doctors, their reception hours |
| Пациент оставляет имя и телефон. В CRM появляется карточка заявки. | Bemor ismi va telefonini qoldiradi. CRMda ariza kartochkasi paydo bo‘ladi. | The patient leaves a name and phone. A request card appears in the CRM. |
| Пациент выбирает свободное время. В CRM появляется заявка с выбранным временем. | Bemor bo‘sh vaqtni tanlaydi. CRMda tanlangan vaqt bilan ariza paydo bo‘ladi. | The patient picks a free slot. A request with the chosen time appears in the CRM. |
| Отмена записи | Yozilishni bekor qilish | Booking cancellation |
| Пациент отменяет свою запись на сайте или у партнёра. | Bemor saytda yoki hamkorda o‘z yozilishini bekor qiladi. | The patient cancels their booking on the website or with the partner. |
| Заявка принята | Ariza qabul qilindi | Request accepted |
| Администратор взял заявку в работу | Administrator arizani ishga oldi | An administrator took the request on |
| Пациент записан | Bemor yozildi | Patient booked |
| Клиника записала пациента по заявке: время занято | Klinika bemorni ariza bo‘yicha yozdi: vaqt band | The clinic booked the patient from the request: the slot is taken |
| Онлайн-запись подтверждена | Onlayn yozilish tasdiqlandi | Online booking confirmed |
| Администратор подтвердил время, которое выбрал пациент | Administrator bemor tanlagan vaqtni tasdiqladi | An administrator confirmed the time the patient chose |
| Предложено другое время | Boshqa vaqt taklif qilindi | Another time offered |
| Клиника предложила пациенту другое время вместо выбранного | Klinika bemorga tanlangan vaqt o‘rniga boshqa vaqtni taklif qildi | The clinic offered the patient another time instead of the chosen one |
| Онлайн-запись отклонена | Onlayn yozilish rad etildi | Online booking declined |
| Клиника не может принять пациента в выбранное время | Klinika bemorni tanlangan vaqtda qabul qila olmaydi | The clinic cannot see the patient at the chosen time |
| Запись отменена (есть) | | |
| Клиника или пациент отменили запись | Klinika yoki bemor yozilishni bekor qildi | The clinic or the patient cancelled the booking |
| Пациент пришёл | Bemor keldi | Patient arrived |
| Регистратура отметила приход пациента | Registratura bemor kelganini belgiladi | Reception marked the patient as arrived |
| Без срока (есть) | | |
| 3 месяца | 3 oy | 3 months |
| 6 месяцев | 6 oy | 6 months |
| 1 год | 1 yil | 1 year |
| {n} в минуту | daqiqasiga {n} | {n} per minute |
| Неизвестный вид подключения. | Ulanish turi noma’lum. | Unknown connection type. |
| Введите название подключения. | Ulanish nomini kiriting. | Enter the connection name. |
| Название — не длиннее 64 знаков. | Nomi — 64 belgidan oshmasin. | The name must be at most 64 characters. |
| Контакт — не длиннее 120 знаков. | Kontakt — 120 belgidan oshmasin. | The contact must be at most 120 characters. |
| Адрес должен начинаться с https://. Обычный http не принимаем: по нему заявки шли бы открытым текстом. | Manzil https:// bilan boshlanishi kerak. Oddiy http qabul qilinmaydi: unda arizalar ochiq matnda ketardi. | The address must start with https://. Plain http is not accepted: requests would travel as open text. |
| Введите полный адрес в интернете, например https://partner.uz/hooks/easymed | Internetdagi to‘liq manzilni kiriting, masalan https://partner.uz/hooks/easymed | Enter a full internet address, for example https://partner.uz/hooks/easymed |
| Адрес — не длиннее 300 знаков. | Manzil — 300 belgidan oshmasin. | The address must be at most 300 characters. |
| Отметьте хотя бы одно право. | Kamida bitta huquqni belgilang. | Tick at least one permission. |
| Неизвестное право подключения. | Ulanish huquqi noma’lum. | Unknown connection permission. |
| Запись на приём требует права «Свободное время». | Qabulga yozilish uchun «Bo‘sh vaqt» huquqi kerak. | Booking needs the “Free time slots” permission. |
| Отмена записи требует права «Запись на приём». | Yozilishni bekor qilish uchun qabulga yozilish huquqi kerak. | Booking cancellation needs the booking permission. |
| Неизвестное событие уведомлений. | Bildirishnoma hodisasi noma’lum. | Unknown notification event. |
| Лимит запросов — 30, 60, 120 или 300 в минуту. | So‘rovlar chegarasi — daqiqasiga 30, 60, 120 yoki 300. | The request limit is 30, 60, 120 or 300 per minute. |
| Срок действия ключа — без срока, 3 месяца, 6 месяцев или 1 год. | Kalitning amal qilish muddati — muddatsiz, 3 oy, 6 oy yoki 1 yil. | Key validity is no expiry, 3 months, 6 months or 1 year. |
| Разрешённые IP-адреса — по одному в строке, например 203.0.113.7 или 203.0.113.0/24. | Ruxsat etilgan IP-manzillar — har qatorda bittadan, masalan 203.0.113.7 yoki 203.0.113.0/24. | Allowed IP addresses — one per line, for example 203.0.113.7 or 203.0.113.0/24. |
| Не больше 20 разрешённых адресов. | Ruxsat etilgan manzillar 20 tadan oshmasin. | No more than 20 allowed addresses. |
| Неверное значение «Подключение включено». | «Ulanish yoqilgan» qiymati noto‘g‘ri. | Invalid “Connection on” value. |
| Только латинские буквы, цифры и дефис, от 3 до 40 знаков; без дефиса в начале и в конце. | Faqat lotin harflari, raqamlar va chiziqcha, 3 dan 40 gacha belgi; boshida va oxirida chiziqchasiz. | Only Latin letters, digits and hyphens, 3 to 40 characters, with no hyphen at the start or end. |
| Это имя занято адресами самого Easy-Med — выберите другое. | Bu nom Easy-Medning o‘z manzillari uchun band — boshqasini tanlang. | This name is taken by Easy-Med’s own addresses — choose another. |

  «Филиалы», «Врачи», «Пакеты услуг», «Заявки», «Запись на приём» — есть в словаре, не дублировать.
- [ ] **Step 5:** тест зелёный. Сторожа: `public/js/shared/clinic-profile.test.js`, `public/js/admin/__tests__/i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 6: коммит** «API клиники: общий модуль подключений — права, события, имя в адресе, проверка адресов, IP и срока ключа (CLINIC_API_STEP7_V1)».

---

## Task 3: Ключи и секреты — выпуск, ключ шифрования, шифротекст, отпечаток (CLINIC_API_STEP7_V1)

**Files:**
- Create: `server/services/api/secret-box.js`, `server/services/api/secret-box.test.js`
- Create: `server/services/api/no-real-api-keys.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `server/services/api/secret-box.test.js`:

```js
// CLINIC_API_STEP7_V1 — ключи подключений API: выпуск (CSPRNG), KEK в каталоге
// данных, шифротекст с отпечатком KEK, отпечаток ключа для узнавания.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { KEY_RE, SECRET_RE } from '../../../public/js/shared/api-connections.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import {
  KEK_FILE, SECRET_MESSAGES, SecretBoxError, loadKek, kekId, seal, unseal, keyHash, newApiKey, newWebhookSecret, tailOf,
} from './secret-box.js';

const kekPath = () => path.join(tmpDir('em-apikek-'), KEK_FILE);
const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };

test('выпуск: формат, префикс, неповторимость', () => {
  const keys = new Set();
  for (let i = 0; i < 2000; i++) {
    const k = newApiKey();
    assert.match(k, KEY_RE);
    keys.add(k);
  }
  assert.equal(keys.size, 2000);
  assert.match(newWebhookSecret(), SECRET_RE);
  assert.equal(tailOf('em_live_abcdWXYZ'), 'WXYZ');
});

test('KEK: нет файла — null; create — 64 hex и копия .bak; повтор — тот же ключ', () => {
  const p = kekPath();
  assert.equal(loadKek({ kekPath: p }), null);
  const k1 = loadKek({ kekPath: p, create: true });
  assert.equal(k1.length, 32);
  assert.match(fs.readFileSync(p, 'utf8'), /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(p + '.bak', 'utf8'), fs.readFileSync(p, 'utf8'));
  assert.ok(loadKek({ kekPath: p, create: true }).equals(k1));
});

test('KEK: основной пропал или испорчен — читается копия; испорчены оба — отказ, а не новый ключ', () => {
  const p = kekPath();
  const k1 = loadKek({ kekPath: p, create: true });
  fs.unlinkSync(p);
  assert.ok(loadKek({ kekPath: p }).equals(k1), 'пропал основной — копия');
  fs.writeFileSync(p, 'мусор');
  assert.ok(loadKek({ kekPath: p }).equals(k1), 'испорчен основной — копия');
  fs.writeFileSync(p + '.bak', 'мусор');
  const e = refusal(() => loadKek({ kekPath: p, create: true }));
  assert.ok(e instanceof SecretBoxError);
  assert.equal(e.message, SECRET_MESSAGES.kekBroken);
  assert.equal(fs.readFileSync(p, 'utf8'), 'мусор', 'испорченный файл не перезаписан молча');
});

test('шифротекст: v1.<отпечаток KEK>.<…>; значения в нём нет; каждый раз другой; обратно — то же', () => {
  const kek = loadKek({ kekPath: kekPath(), create: true });
  const key = newApiKey();
  const a = seal(key, kek);
  const b = seal(key, kek);
  assert.match(a, new RegExp('^v1\\.' + kekId(kek) + '\\.[A-Za-z0-9+/=]+$'));
  assert.ok(!a.includes(key) && !a.includes(key.slice(8)), 'ключ виден в шифротексте');
  assert.notEqual(a, b, 'одинаковый шифротекст — повторный nonce');
  assert.equal(unseal(a, kek), key);
});

test('чужой KEK — «файл остался на прежнем компьютере»; правка байта — «повреждён»', () => {
  const kek = loadKek({ kekPath: kekPath(), create: true });
  const other = loadKek({ kekPath: kekPath(), create: true });
  const sealed = seal(newApiKey(), kek);
  for (const k of [other, null]) {
    const e = refusal(() => unseal(sealed, k));
    assert.equal(e.status, 409);
    assert.equal(e.message, SECRET_MESSAGES.kekMissing);
  }
  const [v, id, body] = sealed.split('.');
  const bad = v + '.' + id + '.' + (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  assert.equal(refusal(() => unseal(bad, kek)).message, SECRET_MESSAGES.sealBroken);
  assert.equal(refusal(() => unseal('', kek)).message, SECRET_MESSAGES.sealBroken);
});

test('отпечаток ключа: SHA-256 hex, разный у разных ключей', () => {
  const k = newApiKey();
  assert.match(keyHash(k), /^[0-9a-f]{64}$/);
  assert.equal(keyHash(k), keyHash(k));
  assert.notEqual(keyHash(k), keyHash(newApiKey()));
});

test('сообщения переведены', () => {
  for (const m of Object.values(SECRET_MESSAGES)) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
```

- [ ] **Step 2: страж** `server/services/api/no-real-api-keys.test.js`:

```js
// CLINIC_API_STEP7_V1 — живой ключ подключения или секрет вебхука не должен
// лежать в исходниках (тот же урок, что NO_REAL_TOKENS_V1 у Telegram). Тесты
// выпускают ключи во время прогона; строка-образец обязана нести TESTONLY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const KEY_LIKE = /\bem_(?:live|whsec)_[A-Za-z0-9]{32}\b/g;
const SKIP = new Set(['node_modules', '.git', 'data', 'releases', 'versions', 'dist']);
const EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.sql', '.html', '.css']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
    else if (EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

test('ни одного живого на вид ключа API или секрета вебхука в исходниках', () => {
  const offenders = [];
  for (const f of walk(ROOT)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const hit of text.match(KEY_LIKE) || []) {
      if (!hit.includes('TESTONLY')) offenders.push(path.relative(ROOT, f) + ': ' + hit.slice(0, 14) + '…');
    }
  }
  assert.deepEqual(offenders, [], 'похоже на настоящий ключ — замените образцом с TESTONLY:\n  ' + offenders.join('\n  '));
});
```

- [ ] **Step 3:** `node --test server/services/api/secret-box.test.js server/services/api/no-real-api-keys.test.js` → первый падает (нет модуля), страж зелёный.
- [ ] **Step 4: модуль** `server/services/api/secret-box.js`:

```js
// CLINIC_API_STEP7_V1 — КЛЮЧИ И СЕКРЕТЫ ПОДКЛЮЧЕНИЙ API: выпуск, шифрование, отпечаток.
//
// Решение владельца 5: ключ можно открыть и скопировать снова — поэтому он
// хранится не только отпечатком, а ЗАШИФРОВАННЫМ (AES-256-GCM, те же
// encryptToken / decryptToken, что у токена Telegram-бота). Рядом — SHA-256
// ключа: по нему публичный сервер (шаг 8) узнаёт ключ, ничего не расшифровывая.
//
// КЛЮЧ ШИФРОВАНИЯ (KEK) — файл <data>/.api-secrets-key и копия .bak, рядом с
// базой, но НЕ в ней:
//   • копия базы (резервная копия, файл на флешке) ключей не раскрывает: в ней
//     шифротекст и отпечатки (backup.js копирует базу и storage/, а не файлы
//     каталога данных);
//   • восстановление копии на ЭТОМ компьютере — всё открывается;
//   • база на ДРУГОМ компьютере без файла — ключи РАБОТАЮТ (отпечаток в
//     базе), но показать их нельзя; экран говорит это прямо и предлагает
//     выпустить новый. Клинику переносят копированием всей папки данных — тогда
//     файл едет вместе с базой.
// Шифротекст помечен отпечатком KEK: «v1.<12 hex>.<base64>». Чужой KEK
// узнаётся по отпечатку — человек читает «файл остался на прежнем компьютере»,
// а не «повреждено». От того, у кого есть доступ к самому компьютеру, это не
// защищает (честно — как в telegram/crypto.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../control/config.js';
import { encryptToken, decryptToken } from '../telegram/crypto.js';
import { KEY_PREFIX, SECRET_PREFIX, KEY_ALPHABET, KEY_BODY_LEN } from '../../../public/js/shared/api-connections.js';

export const KEK_FILE = '.api-secrets-key';
export const SEAL_VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(msg, status = 409) { super(msg); this.status = status; }
}
export const SECRET_MESSAGES = Object.freeze({
  kekMissing: 'Ключ или секрет нельзя показать на этом компьютере: файл шифрования остался на прежнем компьютере. Выпустите новый и передайте его подключению.',
  kekBroken:  'Файл шифрования ключей API повреждён: новые подключения не создаются, сохранённые ключи не открываются. Обратитесь в поддержку Easy-Med.',
  sealBroken: 'Сохранённый ключ или секрет повреждён. Выпустите новый и передайте его подключению.',
});

// Функция, а не константа: тесты задают свой каталог данных (setDataDir) или
// путь переменной окружения, и рабочий data/ не трогается.
export function defaultKekPath() {
  return process.env.EASYMED_API_KEK_PATH || path.join(getDataDir(), KEK_FILE);
}

/** Buffer — ключ; null — файла нет; false — файл есть, но это не ключ. */
function readKekFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  return /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : false;
}

// tmp → fsync → rename (как lisproxy-settings.js): после сбоя питания файл
// либо прежний, либо новый, но не пустой.
function writeDurable(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/**
 * KEK клиники. Нет ни файла, ни копии — null (или новый, если create).
 * Испорчен основной — копия. Испорчены оба — ОТКАЗ: перегенерировать молча
 * нельзя, это обнулило бы все сохранённые ключи (правило telegram/crypto.js).
 */
export function loadKek({ kekPath = defaultKekPath(), create = false } = {}) {
  const main = readKekFile(kekPath);
  if (main) return main;
  const bak = readKekFile(kekPath + '.bak');
  if (bak) return bak;
  if (main === false || bak === false) throw new SecretBoxError(SECRET_MESSAGES.kekBroken);
  if (!create) return null;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(kekPath), { recursive: true });
  writeDurable(kekPath, key.toString('hex'));
  writeDurable(kekPath + '.bak', key.toString('hex'));
  return key;
}

export const kekId = (kek) => crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12);

export function seal(plain, kek) {
  return SEAL_VERSION + '.' + kekId(kek) + '.' + encryptToken(plain, kek);
}
export function unseal(sealed, kek) {
  const [v, id, body] = String(sealed || '').split('.');
  if (v !== SEAL_VERSION || !id || !body) throw new SecretBoxError(SECRET_MESSAGES.sealBroken);
  if (!kek || id !== kekId(kek)) throw new SecretBoxError(SECRET_MESSAGES.kekMissing);
  try { return decryptToken(body, kek); } catch { throw new SecretBoxError(SECRET_MESSAGES.sealBroken); }
}

export const keyHash = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');

function randomBody() {
  let s = '';
  for (let i = 0; i < KEY_BODY_LEN; i++) s += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return s;
}
export const newApiKey = () => KEY_PREFIX + randomBody();
export const newWebhookSecret = () => SECRET_PREFIX + randomBody();
export const tailOf = (s) => String(s).slice(-4);
```

- [ ] **Step 5: словарь** (в блок шага):

| ru | uz | en |
|---|---|---|
| Ключ или секрет нельзя показать на этом компьютере: файл шифрования остался на прежнем компьютере. Выпустите новый и передайте его подключению. | Kalit yoki sirni bu kompyuterda ko‘rsatib bo‘lmaydi: shifrlash fayli avvalgi kompyuterda qolgan. Yangisini chiqaring va ulanishga topshiring. | The key or secret cannot be shown on this computer: the encryption file stayed on the previous computer. Issue a new one and hand it to the connection. |
| Файл шифрования ключей API повреждён: новые подключения не создаются, сохранённые ключи не открываются. Обратитесь в поддержку Easy-Med. | API kalitlarini shifrlash fayli buzilgan: yangi ulanishlar yaratilmaydi, saqlangan kalitlar ochilmaydi. Easy-Med qo‘llab-quvvatlash xizmatiga murojaat qiling. | The API key encryption file is damaged: new connections cannot be created and saved keys cannot be opened. Contact Easy-Med support. |
| Сохранённый ключ или секрет повреждён. Выпустите новый и передайте его подключению. | Saqlangan kalit yoki sir buzilgan. Yangisini chiqaring va ulanishga topshiring. | The saved key or secret is damaged. Issue a new one and hand it to the connection. |

- [ ] **Step 6:** тесты зелёные. Сторожа: `server/services/telegram/crypto.test.js`, `server/services/telegram/no-real-tokens.test.js`, `scripts/build-bundle.test.js` (каталог данных в выпуск не попадает).
- [ ] **Step 7: коммит** «API клиники: ключи и секреты подключений — выпуск криптостойким генератором, шифрование ключом из каталога данных, отпечаток для узнавания; страж живых ключей в исходниках (CLINIC_API_STEP7_V1)».

---

## Task 4: Адрес для партнёров обязателен, пока включено подключение — сервер (решение владельца 11, CLINIC_API_STEP7_V1)

**Files:**
- Modify: `public/js/shared/clinic-profile.js` (за `addressProblems` ~:140-147; `PROFILE_MESSAGES` :35-48)
- Create: `server/services/api/partner-address.js`, `server/services/api/partner-address.test.js`
- Modify: `server/routes/db.js` (за проверкой `profileRefusal` ~:362-364)
- Modify: `server/services/rpc/clinic.js` (рядом с `building_role` :37)
- Test: `server/routes/company-save.test.js`, `server/services/rpc/clinic.test.js`, `public/js/shared/clinic-profile.test.js`
- Modify: `public/js/admin/i18n-strings.js`

**Сейчас:** `addressProblems` (шаг 3) — «всё или ничего». Пустой адрес проходит, начатый требует город / область, район и улицу RU. Подключений нет — требовать нечего.

- [ ] **Step 1: падающие тесты.**
  - **`clinic-profile.test.js`** (в импорт `./clinic-profile.js` дописать `partnerAddressProblems, PARTNER_ADDRESS_COLUMNS`; `PROFILE_MESSAGES` и `STRINGS` файл уже импортирует):

```js
// CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API, адрес обязателен целиком.
test('адрес для партнёров при включённом API: пустой — тоже отказ; без районов у области — район не нужен', () => {
  assert.deepEqual(Object.keys(partnerAddressProblems({})).sort(), ['region_code', 'street_ru']);
  assert.deepEqual(Object.keys(partnerAddressProblems({ region_code: 'tashkent-city', street_ru: 'ул. Мира, 1' })), ['district_code']);
  assert.deepEqual(partnerAddressProblems({ region_code: 'x', street_ru: 'ул. Мира, 1' }, { districtsAvailable: false }), {});
  assert.deepEqual(partnerAddressProblems({ street_ru: 'пр. Абая, 1' }, { regionsAvailable: false }), {});
  assert.deepEqual(partnerAddressProblems({ region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1' }), {});
  assert.deepEqual(PARTNER_ADDRESS_COLUMNS, ['region_code', 'district_code', 'street_ru']);
  assert.ok(STRINGS[PROFILE_MESSAGES.partnerAddress] && STRINGS[PROFILE_MESSAGES.partnerAddress].uz);
});
```

  - **`server/services/api/partner-address.test.js`:**

```js
// CLINIC_API_STEP7_V1 — решение владельца 11 на сервере: подключение не
// включается без адреса; «Компания» без адреса не сохраняется, пока подключение включено.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import { PROFILE_MESSAGES } from '../../../public/js/shared/clinic-profile.js';
import { ADDRESS_MESSAGES, apiActive, addressAvailability, companyAddressProblems, companyAddressRefusal, requirePartnerAddress } from './partner-address.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };
const FULL = { region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1' };
const setAddr = (db, v) => db.prepare('UPDATE doc_settings SET region_code = ?, district_code = ?, street_ru = ? WHERE id = 1')
  .run(v.region_code || '', v.district_code || '', v.street_ru || '');
const meta = { table: 'doc_settings', op: 'update' };

test('включено ли хоть одно подключение: выключенные и удалённые не в счёт', () => {
  const db = fresh();
  assert.equal(apiActive(db), false);
  const id = insertConnectionRow(db, { active: 0 });
  assert.equal(apiActive(db), false);
  db.prepare('UPDATE api_connections SET active = 1 WHERE id = ?').run(id);
  assert.equal(apiActive(db), true);
});

test('есть ли из чего выбирать — по справочнику мигр. 132: у Узбекистана области с районами, у Казахстана областей нет', () => {
  const db = fresh();
  assert.deepEqual(addressAvailability(db, { country_code: '', region_code: 'tashkent-city' }), { regionsAvailable: true, districtsAvailable: true });
  assert.deepEqual(addressAvailability(db, { country_code: 'KZ' }), { regionsAvailable: false, districtsAvailable: false });
});

test('проверка адреса «Компании» и отказ включения', () => {
  const db = fresh();
  assert.deepEqual(Object.keys(companyAddressProblems(db)).sort(), ['region_code', 'street_ru']);
  const e = (() => { try { requirePartnerAddress(db); } catch (x) { return x; } return null; })();
  assert.equal(e.status, 409);
  assert.equal(e.code, 'partner_address_required');
  assert.equal(e.message, ADDRESS_MESSAGES.enable);
  setAddr(db, FULL);
  assert.deepEqual(companyAddressProblems(db), {});
  requirePartnerAddress(db);
});

test('/api/db: пока подключение включено, правка «Компании» без адреса — отказ с полем; без подключения — как раньше', () => {
  const db = fresh();
  setAddr(db, FULL);
  assert.equal(companyAddressRefusal(db, meta, { values: { street_ru: '' } }), null, 'подключений нет — адрес необязателен');
  insertConnectionRow(db);
  assert.deepEqual(companyAddressRefusal(db, meta, { values: { street_ru: '' } }), { field: 'street_ru', message: PROFILE_MESSAGES.partnerAddress });
  assert.deepEqual(companyAddressRefusal(db, meta, { values: { region_code: '', district_code: '' } }), { field: 'region_code', message: PROFILE_MESSAGES.partnerAddress });
  assert.equal(companyAddressRefusal(db, meta, { values: { phone: '+998 71 200 00 00' } }), null, 'адрес полон — правка телефона проходит');
  assert.equal(companyAddressRefusal(db, { table: 'doc_settings', op: 'select' }, {}), null);
  assert.equal(companyAddressRefusal(db, { table: 'patients', op: 'update' }, { values: {} }), null);
});

test('сообщения переведены', () => {
  for (const m of [ADDRESS_MESSAGES.enable, PROFILE_MESSAGES.partnerAddress]) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
```

  - **`company-save.test.js`** (стенд — `setup()` / `login()` того же файла, он уже отдаёт `t.db`):
    - `UPDATE doc_settings SET region_code = 'tashkent-city', district_code = 'yunusobod', street_ru = 'ул. Мира, 1'`, затем `insertConnectionRow(t.db)` (включённое);
    - `doc_settings` update `{ street_ru: '' }` от администратора → 400, `error.code === 'partner_address_required'`, `error.field === 'street_ru'`;
    - после `UPDATE api_connections SET active = 0` тот же запрос → 200.
  - **`clinic.test.js`:** `getClinicBySlug(db).api_address_required` — `false` по умолчанию, `true` после `insertConnectionRow(db)`.
- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: правка.**

  `clinic-profile.js` — в `PROFILE_MESSAGES`:

```js
  // CLINIC_API_STEP7_V1 — решение владельца 11 (2026-10-10): адрес для партнёров
  // обязателен, пока включено хоть одно подключение API.
  partnerAddress: 'Пока включены подключения API, адрес для партнёров обязателен: город или область, район и улица на русском.',
```

  Сразу за `addressProblems`:

```js
// CLINIC_API_STEP7_V1 — РЕШЕНИЕ ВЛАДЕЛЬЦА 11: пока у клиники включено хоть одно
// подключение API, адрес для партнёров обязателен ЦЕЛИКОМ — город или
// область, район (если у области есть районы) и улица на русском. Не «всё или
// ничего», как addressProblems выше: пустой адрес — тоже отказ. Одно правило
// на экран «Компания», /api/db и включение подключения
// (server/services/api/partner-address.js).
export const PARTNER_ADDRESS_COLUMNS = Object.freeze(['region_code', 'district_code', 'street_ru']);
export function partnerAddressProblems(v, { regionsAvailable = true, districtsAvailable = true } = {}) {
  const row = v || {};
  const p = {};
  if (regionsAvailable && !row.region_code) p.region_code = PROFILE_MESSAGES.region;
  if (row.region_code && districtsAvailable && !row.district_code) p.district_code = PROFILE_MESSAGES.district;
  if (!String(row.street_ru || '').trim()) p.street_ru = PROFILE_MESSAGES.street;
  return p;
}
```

  `server/services/api/partner-address.js`:

```js
// CLINIC_API_STEP7_V1 — РЕШЕНИЕ ВЛАДЕЛЬЦА 11 (2026-10-10): адрес для партнёров
// (город / область, район, улица RU из «Компании») необязателен, пока у клиники
// нет включённых подключений API, и обязателен, как только включено хоть одно:
//   • включение подключения (и создание включённого) без полного адреса —
//     отказ 409 partner_address_required: экран ведёт в «Компанию»;
//   • пока подключение включено, «Компания» без адреса не сохраняется
//     (routes/db.js, 400 с полем).
// Проверка одна — partnerAddressProblems (shared/clinic-profile.js), та же у
// экрана. Филиалы, показанные партнёрам, — правило шага 4 (план шага 7, раздел
// «Шагам 4, 8 и 9»).
import { partnerAddressProblems, PARTNER_ADDRESS_COLUMNS, PROFILE_MESSAGES } from '../../../public/js/shared/clinic-profile.js';

export const ADDRESS_MESSAGES = Object.freeze({
  enable: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.',
  save: PROFILE_MESSAGES.partnerAddress,
});

export function apiActive(db) {
  try { return !!db.prepare('SELECT 1 FROM api_connections WHERE active = 1 AND deleted_at IS NULL LIMIT 1').get(); }
  catch { return false; }   // база до мигр. 242 — подключений нет
}

/** Есть ли из чего выбирать (как availability() экрана, company-address.js). */
export function addressAvailability(db, row) {
  const country = String((row && row.country_code) || 'UZ');
  let regionsAvailable = false;
  let districtsAvailable = false;
  try {
    regionsAvailable = !!db.prepare(`SELECT 1 FROM regions r JOIN countries c ON c.id = r.country_id
      WHERE c.code = ? AND r.code IS NOT NULL AND r.active = 1 LIMIT 1`).get(country);
    if (row && row.region_code) {
      districtsAvailable = !!db.prepare(`SELECT 1 FROM districts d JOIN regions r ON r.id = d.region_id
        WHERE r.code = ? AND d.code IS NOT NULL AND d.active = 1 LIMIT 1`).get(row.region_code);
    }
  } catch { /* справочника нет — требовать можно только улицу */ }
  return { regionsAvailable, districtsAvailable };
}

/** Проблемы адреса «Компании» (с присланными правками поверх сохранённого). */
export function companyAddressProblems(db, values = null) {
  let cur = {};
  try { cur = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {}; } catch { cur = {}; }
  const row = values ? { ...cur, ...values } : cur;
  return partnerAddressProblems(row, addressAvailability(db, row));
}

/** Включение подключения: адрес неполон — отказ 409 с кодом partner_address_required. */
export function requirePartnerAddress(db) {
  if (!Object.keys(companyAddressProblems(db)).length) return;
  const e = new Error(ADDRESS_MESSAGES.enable);
  e.status = 409;
  e.code = 'partner_address_required';
  throw e;
}

/** /api/db: правка doc_settings, пока подключение включено. null — можно; иначе { field, message }. */
export function companyAddressRefusal(db, meta, body) {
  if (!meta || meta.table !== 'doc_settings' || (meta.op !== 'update' && meta.op !== 'upsert')) return null;
  if (!apiActive(db)) return null;
  const v = body && body.values;
  const values = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const problems = companyAddressProblems(db, values);
  const field = PARTNER_ADDRESS_COLUMNS.find((c) => problems[c]);
  return field ? { field, message: ADDRESS_MESSAGES.save } : null;
}
```

  `routes/db.js`:
  - импорт: `import { companyAddressRefusal } from '../services/api/partner-address.js';   // CLINIC_API_STEP7_V1`;
  - сразу за строкой `if (profileRefusal) return …`:

```js
    // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
    // «Компания» без адреса для партнёров не сохраняется (поле — то, что
    // подсветит экран).
    const addressRefusal = companyAddressRefusal(db, compiled.meta, req.body);
    if (addressRefusal) {
      return res.status(400).json({ error: { code: 'partner_address_required', message: addressRefusal.message, field: addressRefusal.field } });
    }
```

  `rpc/clinic.js` — импорт `apiActive` из `../api/partner-address.js`; в объект, рядом с `building_role`:

```js
    // CLINIC_API_STEP7_V1 — решение владельца 11: «Компания» ставит звёздочки
    // и не сохраняет без адреса, пока включено подключение API.
    api_address_required: apiActive(db),
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Пока включены подключения API, адрес для партнёров обязателен: город или область, район и улица на русском. | API ulanishlari yoqilgan ekan, hamkorlar uchun manzil majburiy: shahar yoki viloyat, tuman va ko‘cha rus tilida. | While API connections are on, the partner address is required: city or region, district and street in Russian. |
| Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском. | Ulanishni yoqib bo‘lmaydi: «Kompaniya»da hamkorlar uchun manzil to‘ldirilmagan — shahar yoki viloyat, tuman va ko‘cha rus tilida. | The connection cannot be switched on: the partner address in “Company” is not filled in — city or region, district and street in Russian. |

- [ ] **Step 5:** тесты зелёные. Сторожа:
  - `server/routes/company-secondary.test.js`, `logo-storage.test.js`;
  - `server/i18n-server-messages.test.js`;
  - `public/js/admin/__tests__/company-profile.test.mjs`, `clinic-context.test.mjs`.
- [ ] **Step 6: коммит** «Компания: адрес для партнёров обязателен, пока включено подключение API, — включение без адреса и сохранение без адреса отклоняются (решение владельца 11, CLINIC_API_STEP7_V1)».

---
## Task 5: CRM — источники подключений API защищены (сервер) (CLINIC_API_STEP7_V1)

**Files:**
- Modify: `server/services/crm/config.js` (`listSources` :71-74, `saveSources` :485-536, новые функции рядом)
- Modify: `server/services/rpc/crm-config.js` (`removesAny` :39-44, `crmConfigSave` :75-80)
- Test: `server/services/crm/config.test.js`, `server/services/rpc/crm-config.test.js`
- Modify: `public/js/admin/i18n-strings.js`

**Сейчас:**
- `saveSources` принимает **весь** список: ключ, которого нет в присланном, удаляется, если на нём нет заявок (:485-536).
- Защищены только `call` и `telephony` (`UNDELETABLE_SOURCE_KEYS` :49).
- Скрыть можно любой источник. Скрытый `/api/db` не даёт ставить новым заявкам (`crm/sources.js:41-50`).
- `crmConfigSave` требует «Удаления», если список что-то убирает (`removesAny`).

- [ ] **Step 1: падающие тесты.** В `config.test.js` — импорт `insertConnectionRow` из `../../test-helpers/api-connection-row.js` и `apiSourceUse, ensureApiSource, renameApiSource, archiveApiSource` из `./config.js`:

```js
// CLINIC_API_STEP7_V1 — источники подключений API (правило спецификации «API-источники
// защищены как «Звонок»» и Р11–Р12 плана шага 7).
test('свой источник подключения: список его не удаляет, не переименовывает и не скрывает; он встаёт после присланных', () => {
  const db = fresh();
  const src = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  assert.deepEqual(src, { key: 'api_med24_uz', owns: 1 });
  insertConnectionRow(db, { crm_source_key: src.key });
  // Экран CRM шлёт только свой список — без источника подключения.
  const mine = asInput(listSources(db)).filter((s) => s.key !== src.key);
  const api = saveSources(db, mine).find((s) => s.key === src.key);
  assert.ok(api, 'источник подключения удалён сохранением списка');
  assert.equal(api.position, mine.length + 1);
  // Собранный руками список с переименованием и скрытием — присланное не действует.
  const forged = asInput(listSources(db)).map((s) => (s.key === src.key ? { ...s, label: 'Другое имя', is_active: false } : s));
  const after = saveSources(db, forged).find((s) => s.key === src.key);
  assert.deepEqual([after.label, after.is_active], ['med24.uz', true]);
  assert.deepEqual(after.api, { connection_id: 1, connection_name: 'med24.uz', owned: true, archived: false });
  assert.equal(listSources(db).find((s) => s.key === 'call').api, null);
});

test('«Сайт» у подключения сайта: переименовать можно; скрыть и удалить — 409 с шаблоном', () => {
  const db = fresh();
  ensureApiSource(db, { kind: 'site' });
  insertConnectionRow(db, { kind: 'site', name: 'Сайт клиники', crm_source_key: 'website', owns_source: 0, active: 0 });
  const renamed = saveSources(db, asInput(listSources(db)).map((s) => (s.key === 'website' ? { ...s, label: 'Наш сайт' } : s)));
  assert.equal(renamed.find((s) => s.key === 'website').label, 'Наш сайт');
  const hide = refused(() => saveSources(db, asInput(listSources(db)).map((s) => (s.key === 'website' ? { ...s, is_active: false } : s))));
  assert.equal(hide.status, 409);
  assert.match(hide.message, /нужен подключению «Сайт клиники»/);
  assert.ok(hide.template, 'фраза собрана шаблоном — экран переведёт');
  const del = refused(() => saveSources(db, asInput(listSources(db)).filter((s) => s.key !== 'website')));
  assert.equal(del.status, 409);
});

test('источник для сайта: «Сайт» заводится заново, если его удалили, и становится видимым, если его скрыли', () => {
  const db = fresh();
  db.prepare("UPDATE crm_sources SET is_active = 0 WHERE key = 'website'").run();
  assert.deepEqual(ensureApiSource(db, { kind: 'site' }), { key: 'website', owns: 0 });
  assert.equal(db.prepare("SELECT is_active FROM crm_sources WHERE key = 'website'").get().is_active, 1);
  db.prepare("DELETE FROM crm_sources WHERE key = 'website'").run();
  ensureApiSource(db, { kind: 'site' });
  assert.equal(db.prepare("SELECT label FROM crm_sources WHERE key = 'website'").get().label, 'Сайт');
});

test('архив подключения: свой источник скрыт, но цел и под замком — заявки партнёра остаются в отчётах', () => {
  const db = fresh();
  const { key } = ensureApiSource(db, { kind: 'partner', name: 'clinics.uz' });
  const id = insertConnectionRow(db, { crm_source_key: key, name: 'clinics.uz' });
  lead(db, { source: key });
  db.prepare(`UPDATE api_connections SET deleted_at = '2026-10-10T10:00:00Z', active = 0,
    key_hash = '', key_sealed = '', secret_sealed = '' WHERE id = ?`).run(id);
  archiveApiSource(db, key);
  const row = saveSources(db, asInput(listSources(db)).filter((s) => s.key !== key)).find((s) => s.key === key);
  assert.ok(row, 'источник удалённого подключения удалён');
  assert.equal(row.is_active, false);
  assert.equal(row.api.archived, true);
  assert.equal(apiSourceUse(db).get(key).owned, true);
});

test('переименование подключения переименовывает его источник; ключи двух одноимённых не сталкиваются', () => {
  const db = fresh();
  const a = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  const b = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  assert.notEqual(a.key, b.key);
  renameApiSource(db, a.key, 'med24 (новый)');
  assert.equal(db.prepare('SELECT label FROM crm_sources WHERE key = ?').get(a.key).label, 'med24 (новый)');
});
```

  В `server/services/rpc/crm-config.test.js` — импорт `ensureApiSource` из `../crm/config.js` и `insertConnectionRow` из `../../test-helpers/api-connection-row.js`:

```js
test('CLINIC_API_STEP7_V1: «CRM-канбан: Изменение» без «Удаления» сохраняет список без источника подключения — это не удаление', () => {
  const db = fresh();
  db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run('crm_edit', 'crm_edit', 'registrar');
  db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run('crm_edit',
    JSON.stringify({ sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.crm': 'edit' } }));
  const editor = { id: 3, role: 'registrar', extra_roles: [], custom_role_code: 'crm_edit' };
  const { key } = ensureApiSource(db, { kind: 'partner', name: 'med24.uz' });
  insertConnectionRow(db, { crm_source_key: key });
  const sent = crmConfigGet(db).sources.filter((s) => s.key !== key).map((s) => ({ key: s.key, label: s.label, is_active: s.is_active }));
  assert.ok(crmConfigSave(db, { sources: sent }, editor).sources.some((s) => s.key === key));
  // Настоящее удаление по-прежнему требует «Удаления».
  assert.throws(() => crmConfigSave(db, { sources: sent.filter((s) => s.key !== 'other') }, editor), (e) => e.status === 403);
});
```

- [ ] **Step 2:** `node --test server/services/crm/config.test.js server/services/rpc/crm-config.test.js` → падают: нет функций.
- [ ] **Step 3: правка `config.js`.**
  - Импорт: `import { apiSourceKey } from '../../../public/js/shared/api-connections.js';   // CLINIC_API_STEP7_V1`. В импорте `../server-message.js` уже есть `rpcT`.
  - За `UNDELETABLE_SOURCE_KEYS`:

```js
// CLINIC_API_STEP7_V1 — ИСТОЧНИКИ ПОДКЛЮЧЕНИЙ API (спецификация: «API-источники
// защищены как «Звонок»: сохранение списка источников их не удаляет и не
// переименовывает»). Два вида:
//   СВОЙ (owns_source = 1) — у Symptex и партнёра: создан вместе с
//     подключением и называется как оно. Список его не удаляет, не
//     переименовывает и не скрывает — экран показывает его отдельным закрытым
//     списком и не присылает. Подключение удалили (архив) — источник скрыт, но
//     цел: заявки партнёра остаются в отчёте по источникам.
//   НУЖНЫЙ (owns_source = 0) — «Сайт» у подключения сайта клиники. Источник
//     клиники: переименовать можно; скрыть или удалить — нет, пока подключение
//     не удалено. Скрытый источник /api/db не даёт ставить новым заявкам
//     (crm/sources.js) — скрыть его значило бы отказать каждой заявке сайта.
export function apiSourceUse(db) {
  const out = new Map();
  let rows = [];
  try {
    rows = db.prepare('SELECT id, name, crm_source_key, owns_source, deleted_at FROM api_connections ORDER BY id').all();
  } catch { return out; }   // база до мигр. 242 — подключений нет
  for (const r of rows) {
    if (r.owns_source) {
      out.set(r.crm_source_key, { connection_id: r.id, connection_name: r.name, owned: true, archived: !!r.deleted_at });
    } else if (!r.deleted_at && !out.has(r.crm_source_key)) {
      out.set(r.crm_source_key, { connection_id: r.id, connection_name: r.name, owned: false, archived: false });
    }
  }
  return out;
}
function apiSourceRefusal(label, use) {
  return rpcT(CrmConfigError, 'Источник «{label}» нужен подключению «{name}» в разделе «API» — скрыть или удалить его нельзя, пока подключение есть.',
    { label, name: use.connection_name }, 409);
}
const NEXT_POSITION = '(SELECT COALESCE(MAX(position), 0) + 1 FROM crm_sources)';
/** Источник для нового подключения: «Сайт» у сайта клиники (заводится и показывается, если надо), свой — у остальных. */
export function ensureApiSource(db, { kind, name = '' }) {
  if (kind === 'site') {
    const cur = db.prepare("SELECT is_active FROM crm_sources WHERE key = 'website'").get();
    if (!cur) db.prepare(`INSERT INTO crm_sources (key, label, position, is_active) VALUES ('website', 'Сайт', ${NEXT_POSITION}, 1)`).run();
    else if (!cur.is_active) db.prepare("UPDATE crm_sources SET is_active = 1 WHERE key = 'website'").run();
    return { key: 'website', owns: 0 };
  }
  const taken = db.prepare('SELECT key FROM crm_sources').all().map((r) => r.key);
  const key = apiSourceKey(name, kind, taken);
  const label = String(name || '').trim().slice(0, 64) || key;
  db.prepare(`INSERT INTO crm_sources (key, label, position, is_active) VALUES (?, ?, ${NEXT_POSITION}, 1)`).run(key, label);
  return { key, owns: 1 };
}
/** Подключение переименовали — его источник тоже (свой источник называется как подключение). */
export function renameApiSource(db, key, name) {
  db.prepare('UPDATE crm_sources SET label = ? WHERE key = ?').run(String(name || '').trim().slice(0, 64), key);
}
/** Подключение удалили (архив) — свой источник скрыт, но не удалён. */
export function archiveApiSource(db, key) {
  db.prepare('UPDATE crm_sources SET is_active = 0 WHERE key = ?').run(key);
}
```

  - `listSources`:

```js
export function listSources(db) {
  const use = apiSourceUse(db);   // CLINIC_API_STEP7_V1 — у источника подключения: какое и своё ли
  return db.prepare('SELECT key, label, position, is_active FROM crm_sources ORDER BY position, key')
    .all().map((r) => ({ ...sourceRow(r), api: use.get(r.key) || null }));
}
```

  - `saveSources` (:485-536). Строки-якоря ниже есть и в `saveStages`, и в `saveTags` — править только в `saveSources`:
    1. Первой строкой: `const use = apiSourceUse(db);   // CLINIC_API_STEP7_V1`.
    2. После проверки повторов и **до** проверки «Хотя бы один источник должен быть видимым» (:504):

```js
  // CLINIC_API_STEP7_V1 — свой источник подключения: присланные название и
  // видимость не действуют (они — у подключения); нужный (Сайт у сайта) —
  // не скрывается.
  const curRow = db.prepare('SELECT label, is_active FROM crm_sources WHERE key = ?');
  for (const s of wanted) {
    const u = use.get(s.key);
    if (u && u.owned) {
      const cur = curRow.get(s.key);
      if (cur) { s.label = cur.label; s.is_active = cur.is_active; }
    } else if (u && !s.is_active) {
      throw apiSourceRefusal(s.label, u);
    }
  }
```

    3. Строку `const removed = existing.filter((k) => !seen.has(k));` (:507) заменить:

```js
  // CLINIC_API_STEP7_V1 — свой источник подключения список не удаляет: экран его
  // не присылает (закрытый список); он встаёт после присланных.
  const keptApi = existing.filter((k) => !seen.has(k) && (use.get(k) || {}).owned);
  const removed = existing.filter((k) => !seen.has(k) && !keptApi.includes(k));
```

    4. В цикле `for (const key of removed)` — сразу за проверкой `UNDELETABLE_SOURCE_KEYS` (:516-518):

```js
    const u = use.get(key);   // CLINIC_API_STEP7_V1 — «Сайт» подключения сайта
    if (u) throw apiSourceRefusal(curRow.get(key)?.label || key, u);
```

    5. В транзакции после `for (const s of wanted) upsert.run(s);` (:531):

```js
    // CLINIC_API_STEP7_V1 — оставленные источники подключений — после присланных, в прежнем порядке.
    const setPos = db.prepare('UPDATE crm_sources SET position = ? WHERE key = ?');
    const order = new Map(db.prepare('SELECT key, position FROM crm_sources').all().map((r) => [r.key, r.position]));
    keptApi.sort((a, b) => (order.get(a) - order.get(b)) || a.localeCompare(b))
      .forEach((k, i) => setPos.run(wanted.length + i + 1, k));
```

  **`rpc/crm-config.js`:**

```js
// Удаляет ли сохранение хоть одну существующую строку списка. CLINIC_API_STEP7_V1 —
// `kept(x)`: строки, которые сохранение не удаляет, даже если их не прислали
// (свой источник подключения API, services/crm/config.js).
function removesAny(current, sent, kept = null) {
  if (!Array.isArray(sent)) return false;
  const keep = new Set(sent.map((x) => x && x.key).filter(Boolean));
  return (current || []).some((x) => x && x.key && !keep.has(x.key) && !(kept && kept(x)));
}
```

  В `crmConfigSave` — `removesAny(cur.sources, a.sources, (x) => !!(x.api && x.api.owned))`.
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Источник «{label}» нужен подключению «{name}» в разделе «API» — скрыть или удалить его нельзя, пока подключение есть. | «{label}» manbasi «API» bo‘limidagi «{name}» ulanishiga kerak — ulanish bor ekan, uni yashirib ham, o‘chirib ham bo‘lmaydi. | The source “{label}” is used by the connection “{name}” in “API” — it cannot be hidden or deleted while the connection exists. |

- [ ] **Step 5:** тесты зелёные. Сторожа:
  - `server/services/crm/sources.test.js`, `multi-source-neighbours.test.js`;
  - `server/routes/crm-unify-conversion-history.test.js`;
  - `server/services/rpc/callcenter-multi-source.test.js`;
  - `server/i18n-server-messages.test.js`.
- [ ] **Step 6: коммит** «CRM: источники подключений API под замком — сохранение списка их не удаляет, не переименовывает и не скрывает; «Сайт» сайта клиники не скрыть; удалённое подключение прячет свой источник, не удаляя (CLINIC_API_STEP7_V1)».

---

## Task 6: Подключения — имя в адресе, сайт клиники, черновик, создание, список, журнал (CLINIC_API_STEP7_V1)

**Files:**
- Create: `server/services/api/drafts.js`
- Create: `server/services/api/connections.js`, `server/services/api/connections.test.js`
- Create: `server/test-helpers/api-connections-seed.js` — база с администратором и полным адресом; общий для задач 6–7
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: стенд** `server/test-helpers/api-connections-seed.js` (отдельный файл, а не экспорт из теста: импорт тестового файла запустил бы и его тесты):

```js
// CLINIC_API_STEP7_V1 — стенд подключений API: администратор «Босс», «Компания»
// с латинским названием и полным адресом для партнёров (решение владельца 11),
// свой файл ключа шифрования во временной папке.
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir } from './tmpdir.js';
import { KEK_FILE } from '../services/api/secret-box.js';
import { __clearDraftsForTests } from '../services/api/drafts.js';
import { actorOf } from '../services/api/connections.js';

export function seed({ db = null, kekPath = null } = {}) {
  __clearDraftsForTests();
  const base = db || openDb(':memory:');
  if (!db) migrate(base);
  base.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1, 'boss', 'x', 'Босс', 'admin')").run();
  base.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', name_en = 'Shifo Clinic', region_code = 'tashkent-city',
    district_code = 'yunusobod', street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  return { db: base, actor: actorOf(base, { id: 1 }), kekPath: kekPath || path.join(tmpDir('em-apic-'), KEK_FILE) };
}
export const PARTNER = Object.freeze({ kind: 'partner', name: 'med24.uz', site_url: 'https://med24.uz', contact: 'Отдел партнёров',
  scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'],
  webhook_url: 'https://med24.uz/hooks', webhook_events: ['request.accepted'] });
```

- [ ] **Step 2: падающий тест** `server/services/api/connections.test.js`:

```js
// CLINIC_API_STEP7_V1 — подключения API: имя в адресе, сайт клиники (сам,
// выключенным), черновик ключа, создание, список, журнал без значений.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import { KEY_RE, SECRET_RE, API_MESSAGES } from '../../../public/js/shared/api-connections.js';
import { loadKek, unseal, keyHash } from './secret-box.js';
import { makeDraft, renewDraft, readDraft, __clearDraftsForTests, DRAFT_TTL_MS } from './drafts.js';
import {
  SERVICE_MESSAGES, SITE_NAME, readSlug, saveSlug, slugSuggestion, listConnections, createConnection, listJournal,
} from './connections.js';
import { seed, PARTNER } from '../../test-helpers/api-connections-seed.js';

const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };

test('черновик: одному администратору, 30 минут; ключ и секрет обновляются по отдельности', () => {
  __clearDraftsForTests();
  const d = makeDraft(1, { now: 1000 });
  assert.match(d.key, KEY_RE);
  assert.match(d.secret, SECRET_RE);
  assert.equal(readDraft(d.draft_id, 2, { now: 1000 }), null, 'чужой черновик');
  const r = renewDraft(d.draft_id, 1, 'key', { now: 2000 });
  assert.notEqual(r.key, d.key);
  assert.equal(r.secret, d.secret);
  assert.equal(renewDraft(d.draft_id, 1, 'всё', { now: 2000 }), null);
  assert.equal(readDraft(d.draft_id, 1, { now: 2000 + DRAFT_TTL_MS + 1 }), null, 'просрочен');
});

test('имя в адресе: проверка, предложение из «Компании», журнал «было → стало»; сайт клиники создаётся сам — выключенным, один', () => {
  const { db, actor, kekPath } = seed();
  assert.equal(slugSuggestion(db), 'shifo-clinic');
  assert.equal(refusal(() => saveSlug(db, 'api', actor, { kekPath })).message, API_MESSAGES.slugReserved);
  assert.deepEqual(saveSlug(db, ' Shifo ', actor, { kekPath }), { slug: 'shifo', base_url: 'https://api.easymed.uz/shifo/v1/', site_created: true });
  const [site] = listConnections(db);
  assert.deepEqual([site.kind, site.name, site.active, site.crm_source_key, site.owns_source, site.site_url],
    ['site', SITE_NAME, false, 'website', false, '']);
  assert.match(site.key_mask, /^em_live_••••[A-Za-z0-9]{4}$/);
  assert.equal(saveSlug(db, 'shifo-24', actor, { kekPath }).site_created, false);
  assert.equal(listConnections(db).filter((c) => c.kind === 'site').length, 1);
  assert.equal(readSlug(db), 'shifo-24');
  const j = listJournal(db);
  assert.deepEqual(j.map((x) => x.action), ['slug_saved', 'created', 'slug_saved']);
  assert.deepEqual(j[0].detail, { from: 'shifo', to: 'shifo-24' });
  assert.equal(j[0].user_name, 'Босс');
  assert.deepEqual(j[1].detail, { kind: 'site', auto: true, source: 'website' });
});

test('создание: ключ и секрет — из черновика; в базе — шифротекст и отпечаток; свой источник CRM; журнал без значений', () => {
  const { db, actor, kekPath } = seed();
  saveSlug(db, 'shifo', actor, { kekPath });
  const d = makeDraft(1);
  const out = createConnection(db, PARTNER, actor, { draftId: d.draft_id, kekPath });
  assert.equal(out.key, d.key);
  assert.equal(out.secret, d.secret);
  const c = out.connection;
  assert.deepEqual([c.kind, c.name, c.active, c.crm_source_key, c.crm_source_label, c.owns_source, c.rate_limit, c.key_ttl, c.created_by_name],
    ['partner', 'med24.uz', true, 'api_med24_uz', 'med24.uz', true, 60, '1y', 'Босс']);
  assert.ok(c.key_expires_at > c.key_issued_at, 'срок «1 год» посчитан от выдачи');
  const row = db.prepare('SELECT * FROM api_connections WHERE id = ?').get(c.id);
  assert.equal(row.key_hash, keyHash(d.key));
  assert.equal(unseal(row.key_sealed, loadKek({ kekPath })), d.key);
  assert.equal(unseal(row.secret_sealed, loadKek({ kekPath })), d.secret);
  const rowText = JSON.stringify(row);
  assert.ok(!rowText.includes(d.key) && !rowText.includes(d.secret), 'значение лежит открыто');
  for (const k of ['key_hash', 'key_sealed', 'secret_sealed']) assert.ok(!(k in c), 'список отдаёт ' + k);
  assert.equal(readDraft(d.draft_id, 1), null, 'черновик израсходован');
  const j = JSON.stringify(listJournal(db));
  assert.ok(!j.includes(d.key) && !j.includes(d.secret));
});

test('создание: отказы — нет имени в адресе, устаревший черновик, сайт вручную, неверные поля, адрес не заполнен', () => {
  const { db, actor, kekPath } = seed();
  const d = makeDraft(1);
  assert.equal(refusal(() => createConnection(db, PARTNER, actor, { draftId: d.draft_id, kekPath })).message, SERVICE_MESSAGES.slugFirst);
  saveSlug(db, 'shifo', actor, { kekPath });
  assert.equal(refusal(() => createConnection(db, PARTNER, actor, { draftId: 'нет', kekPath })).message, SERVICE_MESSAGES.draftGone);
  assert.equal(refusal(() => createConnection(db, { ...PARTNER, kind: 'site' }, actor, { draftId: d.draft_id, kekPath })).status, 409);
  assert.equal(refusal(() => createConnection(db, { ...PARTNER, scopes: ['clinic', 'appointments'] }, actor, { draftId: d.draft_id, kekPath })).message,
    API_MESSAGES.appointmentsNeedSlots);
  db.prepare("UPDATE doc_settings SET street_ru = '' WHERE id = 1").run();
  assert.equal(refusal(() => createConnection(db, PARTNER, actor, { draftId: d.draft_id, kekPath })).code, 'partner_address_required');
  const off = createConnection(db, { ...PARTNER, active: false }, actor, { draftId: d.draft_id, kekPath });
  assert.equal(off.connection.active, false, 'выключенное создаётся и без адреса');
});

test('сообщения переведены', () => {
  for (const m of [...Object.values(SERVICE_MESSAGES), SITE_NAME]) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
```

- [ ] **Step 3:** `node --test server/services/api/connections.test.js` → падает: модулей нет.
- [ ] **Step 4: черновики** `server/services/api/drafts.js`:

```js
// CLINIC_API_STEP7_V1 — ЧЕРНОВИК КЛЮЧА для окна «Новое подключение» (Р6 плана).
//
// Макет (одобрен владельцем): ключ виден в окне ДО «Создать подключение», с
// «Скопировать» и «Сгенерировать новый». Выпускает его сервер (CSPRNG), и
// браузер не присылает ключ обратно: при создании он называет черновик, а
// значение берётся отсюда. Иначе собранный руками запрос задал бы клинике ключ
// «em_live_aaaa…».
//
// Память процесса, не база: черновик ещё никому не выдан. 30 минут, одному
// администратору, один раз. Перезапуск сервера черновики теряет — окно скажет
// «устарело», администратор откроет его заново.
import crypto from 'node:crypto';
import { newApiKey, newWebhookSecret } from './secret-box.js';

export const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_DRAFTS = 100;
const drafts = new Map();

function prune(now) { for (const [id, d] of drafts) if (now - d.at > DRAFT_TTL_MS) drafts.delete(id); }
function mine(id, userId, now) {
  prune(now);
  const d = drafts.get(String(id || ''));
  return d && d.userId === userId ? d : null;
}
const view = (id, d) => ({ draft_id: id, key: d.key, secret: d.secret });

export function makeDraft(userId, { now = Date.now() } = {}) {
  prune(now);
  const id = crypto.randomBytes(16).toString('hex');
  drafts.set(id, { userId, key: newApiKey(), secret: newWebhookSecret(), at: now });
  while (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
  return view(id, drafts.get(id));
}
/** «Сгенерировать новый» / «Новый секрет» в окне: та же запись, новое значение. */
export function renewDraft(id, userId, what, { now = Date.now() } = {}) {
  const d = mine(id, userId, now);
  if (!d || (what !== 'key' && what !== 'secret')) return null;
  if (what === 'key') d.key = newApiKey(); else d.secret = newWebhookSecret();
  d.at = now;
  return view(String(id), d);
}
export function readDraft(id, userId, { now = Date.now() } = {}) {
  const d = mine(id, userId, now);
  return d ? { key: d.key, secret: d.secret } : null;
}
export function dropDraft(id) { drafts.delete(String(id || '')); }
export function __clearDraftsForTests() { drafts.clear(); }
```

- [ ] **Step 5: модуль** `server/services/api/connections.js`. Сообщения — **все** сразу, вместе с теми, что понадобятся задаче 7:

```js
// CLINIC_API_STEP7_V1 — ПОДКЛЮЧЕНИЯ API: имя в адресе, подключения, журнал.
//
// База, без проверки прав: ворота стоят на границе RPC (rpc/api-connections.js),
// как у crm/config.js. Значение ключа или секрета появляется здесь при выпуске
// и при «Показать» и уходит только в ответ вызывающему — ни в журнал
// (api_journal: кто / что / когда), ни в console.
import {
  KEY_PREFIX, SECRET_PREFIX, DEFAULTS, normalizeSlug, slugProblem, suggestSlug, apiBaseUrl,
  normalizeConnection, connectionProblems, orderedScopes, orderedEvents, maskSecret, keyExpiresAt,
} from '../../../public/js/shared/api-connections.js';
import { loadKek, seal, unseal, keyHash, newApiKey, newWebhookSecret, tailOf } from './secret-box.js';
import { readDraft, dropDraft } from './drafts.js';
import { requirePartnerAddress } from './partner-address.js';
import { ensureApiSource, renameApiSource, archiveApiSource } from '../crm/config.js';

export class ApiConnectionError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
export const SERVICE_MESSAGES = Object.freeze({
  slugFirst:        'Сначала задайте короткое имя клиники в адресе API.',
  draftGone:        'Окно нового подключения устарело: показанный ключ не сохранён. Закройте окно и откройте его заново — ключ будет другим.',
  siteIsAuto:       'Подключение сайта клиники создаётся само, когда задано имя в адресе.',
  notFound:         'Подключение не найдено — возможно, его удалили. Обновите страницу.',
  siteUrlInCompany: 'Адрес сайта клиники меняется в «Компании», поле «Сайт».',
  siteNoDelete:     'Подключение сайта клиники не удаляется — его можно выключить.',
  confirmKey:       'Подтвердите выпуск нового ключа: прежний перестанет подходить сразу.',
  confirmSecret:    'Подтвердите выпуск нового секрета: прежний перестанет подходить сразу.',
  confirmDelete:    'Подтвердите удаление подключения.',
  badWhat:          'Неизвестно, что открыть: ключ или секрет.',
});
// Название подключения сайта пишется в базу; экран переводит его tr().
export const SITE_NAME = 'Сайт клиники';

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => own(o, k)).map((k) => [k, o[k]]));
function checkOrThrow(problems) {
  const first = Object.values(problems)[0];
  if (first) throw new ApiConnectionError(first);
}

export function actorOf(db, user) {
  const id = Number(user && user.id);
  if (!(id > 0)) return { id: null, name: '' };
  const r = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(id);
  return { id, name: (r && (r.full_name || r.username)) || '' };
}
export function journal(db, { connectionId = null, actor, action, detail = {} }) {
  db.prepare('INSERT INTO api_journal (connection_id, user_id, user_name, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(connectionId, actor.id, actor.name, action, JSON.stringify(detail));
}

// ---- «Компания» (шаг 3) — только чтение; SELECT *: база до мигр. 240 без колонок профиля
function docSettings(db) {
  try { return db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {}; } catch { return {}; }
}
export const slugSuggestion = (db) => { const d = docSettings(db); return suggestSlug(d.name_en, d.name_uz); };
export const companyWebsite = (db) => String(docSettings(db).website || '');
export const clinicName = (db) => String(docSettings(db).clinic_name || '');

// ---- строка подключения: ключ и секрет — шифротекстом и отпечатком ------------
function insertConnection(db, c, kek, actor) {
  const issued = nowIso();
  return Number(db.prepare(`INSERT INTO api_connections (kind, name, site_url, contact, scopes, active,
      crm_source_key, owns_source, key_hash, key_sealed, key_tail, key_issued_at, key_issued_by_name,
      key_ttl, key_expires_at, rate_limit, ip_allow, webhook_url, webhook_events, secret_sealed, secret_tail,
      created_at, created_by, created_by_name, updated_at)
    VALUES (@kind, @name, @site_url, @contact, @scopes, @active, @crm_source_key, @owns_source,
      @key_hash, @key_sealed, @key_tail, @issued, @actor_name, @key_ttl, @key_expires_at, @rate_limit, @ip_allow,
      @webhook_url, @webhook_events, @secret_sealed, @secret_tail, @issued, @actor_id, @actor_name, @issued)`).run({
    kind: c.kind, name: c.name, site_url: c.site_url || '', contact: c.contact || '',
    scopes: JSON.stringify(orderedScopes(c.scopes)), active: c.active ? 1 : 0,
    crm_source_key: c.source.key, owns_source: c.source.owns,
    key_hash: keyHash(c.key), key_sealed: seal(c.key, kek), key_tail: tailOf(c.key),
    issued, actor_name: actor.name, actor_id: actor.id,
    key_ttl: c.key_ttl, key_expires_at: keyExpiresAt(issued, c.key_ttl), rate_limit: c.rate_limit, ip_allow: c.ip_allow || '',
    webhook_url: c.webhook_url || '', webhook_events: JSON.stringify(orderedEvents(c.webhook_events)),
    secret_sealed: seal(c.secret, kek), secret_tail: tailOf(c.secret),
  }).lastInsertRowid);
}

// ---- список -----------------------------------------------------------------
const arr = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
// Наружу — БЕЗ key_hash / key_sealed / secret_sealed: маска и хвост, не больше.
function rowOut(r) {
  return {
    id: r.id, kind: r.kind, name: r.name, site_url: r.site_url, contact: r.contact,
    scopes: arr(r.scopes), active: !!r.active,
    crm_source_key: r.crm_source_key, crm_source_label: r.crm_source_label || r.crm_source_key, owns_source: !!r.owns_source,
    key_mask: maskSecret(KEY_PREFIX, r.key_tail), key_issued_at: r.key_issued_at, key_issued_by_name: r.key_issued_by_name,
    key_ttl: r.key_ttl, key_expires_at: r.key_expires_at, rate_limit: r.rate_limit, ip_allow: r.ip_allow,
    webhook_url: r.webhook_url, webhook_events: arr(r.webhook_events), secret_mask: maskSecret(SECRET_PREFIX, r.secret_tail),
    last_used_at: r.last_used_at, created_at: r.created_at, created_by_name: r.created_by_name,
  };
}
const LIST_SQL = `SELECT c.*, s.label AS crm_source_label FROM api_connections c
  LEFT JOIN crm_sources s ON s.key = c.crm_source_key WHERE c.deleted_at IS NULL`;
export function listConnections(db) {
  return db.prepare(LIST_SQL + " ORDER BY c.kind <> 'site', c.id").all().map(rowOut);
}
export function liveRow(db, id) {
  const n = Number(id);
  const r = Number.isInteger(n) && n > 0
    ? db.prepare('SELECT * FROM api_connections WHERE id = ? AND deleted_at IS NULL').get(n) : null;
  if (!r) throw new ApiConnectionError(SERVICE_MESSAGES.notFound, 404);
  return r;
}
export function getConnection(db, id) {
  const r = db.prepare(LIST_SQL + ' AND c.id = ?').get(Number(id));
  if (!r) throw new ApiConnectionError(SERVICE_MESSAGES.notFound, 404);
  return rowOut(r);
}

// ---- имя в адресе и подключение сайта клиники ---------------------------------
export function readSlug(db) {
  const r = db.prepare('SELECT slug FROM api_settings WHERE id = 1').get();
  return (r && r.slug) || '';
}
// Р10 — подключение сайта клиники: одно, создаётся само ВЫКЛЮЧЕННЫМ (ключ ещё
// никому не передан; включение требует адреса для партнёров — решение 11).
// Адрес сайта — «Сайт» «Компании», в подключении его нет. Источник — «Сайт».
function createSiteConnection(db, actor, kek) {
  const d = DEFAULTS.site;
  const source = ensureApiSource(db, { kind: 'site' });
  const id = insertConnection(db, { kind: 'site', name: SITE_NAME, scopes: d.scopes, active: 0, source,
    key: newApiKey(), secret: newWebhookSecret(), key_ttl: d.key_ttl, rate_limit: d.rate_limit, webhook_events: d.events }, kek, actor);
  journal(db, { connectionId: id, actor, action: 'created', detail: { kind: 'site', auto: true, source: source.key } });
  return id;
}
export function saveSlug(db, value, actor, { kekPath } = {}) {
  const slug = normalizeSlug(value);
  const problem = slugProblem(slug);
  if (problem) throw new ApiConnectionError(problem);
  const from = readSlug(db);
  const needSite = !db.prepare("SELECT 1 FROM api_connections WHERE kind = 'site'").get();
  if (from === slug && !needSite) return { slug, base_url: apiBaseUrl(slug), site_created: false };
  const kek = needSite ? loadKek({ kekPath, create: true }) : null;   // файл — до транзакции
  let siteId = null;
  db.transaction(() => {
    if (from !== slug) {
      db.prepare('UPDATE api_settings SET slug = ?, updated_at = ?, updated_by = ? WHERE id = 1').run(slug, nowIso(), actor.id);
      journal(db, { actor, action: 'slug_saved', detail: { from, to: slug } });
    }
    if (needSite) siteId = createSiteConnection(db, actor, kek);
  })();
  return { slug, base_url: apiBaseUrl(slug), site_created: siteId != null };
}

// ---- новое подключение (Symptex, партнёр) -------------------------------------
const CREATE_FIELDS = ['kind', 'name', 'site_url', 'contact', 'scopes', 'webhook_url', 'webhook_events',
  'rate_limit', 'key_ttl', 'ip_allow', 'active'];
export function createConnection(db, input, actor, { draftId, kekPath } = {}) {
  const a = input || {};
  const d = DEFAULTS[a.kind] || DEFAULTS.partner;
  const v = normalizeConnection({ site_url: '', contact: '', webhook_url: '', webhook_events: [], ip_allow: '',
    rate_limit: d.rate_limit, key_ttl: d.key_ttl, active: true, ...pick(a, CREATE_FIELDS) });
  if (v.kind === 'site') throw new ApiConnectionError(SERVICE_MESSAGES.siteIsAuto, 409);
  checkOrThrow(connectionProblems(v));
  if (!readSlug(db)) throw new ApiConnectionError(SERVICE_MESSAGES.slugFirst, 409);
  if (v.active === 1) requirePartnerAddress(db);   // решение владельца 11
  const draft = readDraft(draftId, actor.id);
  if (!draft) throw new ApiConnectionError(SERVICE_MESSAGES.draftGone, 409);
  const kek = loadKek({ kekPath, create: true });
  let id;
  db.transaction(() => {
    const source = ensureApiSource(db, { kind: v.kind, name: v.name });
    id = insertConnection(db, { ...v, source, key: draft.key, secret: draft.secret }, kek, actor);
    journal(db, { connectionId: id, actor, action: 'created',
      detail: { kind: v.kind, name: v.name, scopes: orderedScopes(v.scopes), source: source.key, active: !!v.active } });
  })();
  dropDraft(draftId);
  return { connection: getConnection(db, id), key: draft.key, secret: draft.secret };
}

// ---- журнал ------------------------------------------------------------------
export function listJournal(db, { connectionId = null, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const one = connectionId != null && connectionId !== '';
  const rows = db.prepare(`SELECT j.*, c.name AS connection_name FROM api_journal j
    LEFT JOIN api_connections c ON c.id = j.connection_id
    ${one ? 'WHERE j.connection_id = ?' : ''} ORDER BY j.id DESC LIMIT ${lim}`).all(...(one ? [Number(connectionId)] : []));
  return rows.map((r) => {
    let detail = {};
    try { detail = JSON.parse(r.detail); } catch { detail = {}; }
    return { id: r.id, at: r.at, connection_id: r.connection_id, connection_name: r.connection_name || '',
      user_name: r.user_name, action: r.action, detail };
  });
}
```

  `unseal`, `renameApiSource`, `archiveApiSource` и сообщения задачи 7 в импорте уже стоят — их зовёт задача 7.
- [ ] **Step 6: словарь** («Сайт клиники» — из задачи 2):

| ru | uz | en |
|---|---|---|
| Сначала задайте короткое имя клиники в адресе API. | Avval API manzilida klinikaning qisqa nomini kiriting. | First set the clinic’s short name in the API address. |
| Окно нового подключения устарело: показанный ключ не сохранён. Закройте окно и откройте его заново — ключ будет другим. | Yangi ulanish oynasi eskirgan: ko‘rsatilgan kalit saqlanmagan. Oynani yoping va qayta oching — kalit boshqacha bo‘ladi. | The new-connection window is out of date: the key shown was not saved. Close the window and open it again — the key will be different. |
| Подключение сайта клиники создаётся само, когда задано имя в адресе. | Klinika sayti ulanishi manzildagi nom kiritilganda o‘zi yaratiladi. | The clinic website connection is created automatically once the address name is set. |
| Подключение не найдено — возможно, его удалили. Обновите страницу. | Ulanish topilmadi — ehtimol, u o‘chirilgan. Sahifani yangilang. | Connection not found — it may have been deleted. Refresh the page. |
| Адрес сайта клиники меняется в «Компании», поле «Сайт». | Klinika sayti manzili «Kompaniya»da, «Sayt» maydonida o‘zgartiriladi. | The clinic website address is changed in “Company”, in the “Website” field. |
| Подключение сайта клиники не удаляется — его можно выключить. | Klinika sayti ulanishini o‘chirib tashlab bo‘lmaydi — uni faqat to‘xtatib qo‘yish mumkin. | The clinic website connection cannot be deleted — it can be switched off. |
| Подтвердите выпуск нового ключа: прежний перестанет подходить сразу. | Yangi kalit chiqarilishini tasdiqlang: avvalgisi darhol yaroqsiz bo‘ladi. | Confirm issuing a new key: the old one stops working at once. |
| Подтвердите выпуск нового секрета: прежний перестанет подходить сразу. | Yangi sir chiqarilishini tasdiqlang: avvalgisi darhol yaroqsiz bo‘ladi. | Confirm issuing a new secret: the old one stops working at once. |
| Подтвердите удаление подключения. | Ulanish o‘chirilishini tasdiqlang. | Confirm deleting the connection. |
| Неизвестно, что открыть: ключ или секрет. | Nimani ochish noma’lum: kalitmi yoki sirmi. | Unknown item to open: key or secret. |

- [ ] **Step 7:** тест зелёный. Сторожа: `server/services/crm/config.test.js`, `server/services/api/partner-address.test.js`.
- [ ] **Step 8: коммит** (с `server/test-helpers/api-connections-seed.js`) «API клиники: имя в адресе, подключение сайта клиники создаётся само и выключенным, черновик ключа на сервере, создание подключения со своим источником CRM, журнал без значений ключей (CLINIC_API_STEP7_V1)».

---

## Task 7: Подключения — правка, включение, показать, новый ключ и секрет, удаление; копия базы и другой компьютер (CLINIC_API_STEP7_V1)

**Files:**
- Modify: `server/services/api/connections.js`
- Create: `server/services/api/connections-keys.test.js`

- [ ] **Step 1: падающий тест** `server/services/api/connections-keys.test.js`:

```js
// CLINIC_API_STEP7_V1 — правка подключения, включение (решение владельца 11),
// показать / новый ключ и секрет, удаление-архив; копия базы ключей не
// раскрывает; на другом компьютере ключ работает, но не показывается.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { createBackup } from '../backup.js';
import { keyExpiresAt } from '../../../public/js/shared/api-connections.js';
import { KEK_FILE, SECRET_MESSAGES, keyHash } from './secret-box.js';
import { makeDraft } from './drafts.js';
import { SERVICE_MESSAGES, saveSlug, createConnection, updateConnection, revealSecret, regenerateSecret,
  deleteConnection, listConnections, listJournal } from './connections.js';
import { seed, PARTNER } from '../../test-helpers/api-connections-seed.js';

const refusal = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('ожидался отказ'); };
function withPartner(s = seed()) {
  saveSlug(s.db, 'shifo', s.actor, { kekPath: s.kekPath });
  const d = makeDraft(1);
  const out = createConnection(s.db, PARTNER, s.actor, { draftId: d.draft_id, kekPath: s.kekPath });
  return { ...s, id: out.connection.id, key: out.key, secret: out.secret };
}

test('правка: только изменённое; название подключения переименовывает его источник; журнал — поля без значений ключей', () => {
  const t = withPartner();
  const c = updateConnection(t.db, t.id, { name: 'med24', contact: 'Отдел партнёров', scopes: [...PARTNER.scopes, 'packages'] }, t.actor);
  assert.equal(c.name, 'med24');
  assert.equal(c.crm_source_label, 'med24', 'источник переименован вместе с подключением');
  const [last] = listJournal(t.db, { connectionId: t.id });
  assert.equal(last.action, 'updated');
  assert.deepEqual(last.detail.fields, ['name', 'scopes'], 'неизменённый контакт в журнал не попал');
  assert.deepEqual(last.detail.scopes, { added: ['packages'], removed: [] });
  assert.deepEqual(last.detail.name, { from: 'med24.uz', to: 'med24' });
  const n = listJournal(t.db).length;
  updateConnection(t.db, t.id, { name: 'med24' }, t.actor);
  assert.equal(listJournal(t.db).length, n, 'без изменений — без записи');
});

test('адрес уведомлений в журнале — без запроса и якоря', () => {
  const t = withPartner();
  updateConnection(t.db, t.id, { webhook_url: 'https://med24.uz/hooks/new?token=abc#x' }, t.actor);
  assert.deepEqual(listJournal(t.db, { connectionId: t.id })[0].detail.webhook_url,
    { from: 'https://med24.uz/hooks', to: 'https://med24.uz/hooks/new' });
});

test('включение: без адреса для партнёров — отказ; выключение — всегда; журнал «включено / выключено»', () => {
  const t = withPartner();
  updateConnection(t.db, t.id, { active: false }, t.actor);
  t.db.prepare("UPDATE doc_settings SET district_code = '' WHERE id = 1").run();
  assert.equal(refusal(() => updateConnection(t.db, t.id, { active: true }, t.actor)).code, 'partner_address_required');
  t.db.prepare("UPDATE doc_settings SET district_code = 'yunusobod' WHERE id = 1").run();
  assert.equal(updateConnection(t.db, t.id, { active: true }, t.actor).active, true);
  assert.deepEqual(listJournal(t.db, { connectionId: t.id }).slice(0, 2).map((x) => x.action), ['enabled', 'disabled']);
});

test('срок ключа: смена срока — дата от выдачи; новый ключ — от новой выдачи', () => {
  const t = withPartner();
  const c = updateConnection(t.db, t.id, { key_ttl: '3m' }, t.actor);
  assert.equal(c.key_ttl, '3m');
  assert.equal(c.key_expires_at, keyExpiresAt(c.key_issued_at, '3m'));
  assert.equal(updateConnection(t.db, t.id, { key_ttl: 'never' }, t.actor).key_expires_at, null);
  updateConnection(t.db, t.id, { key_ttl: '6m' }, t.actor);
  const r = regenerateSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath, confirm: true });
  assert.equal(r.connection.key_expires_at, keyExpiresAt(r.connection.key_issued_at, '6m'));
});

test('сайт клиники: адрес — в «Компании»; удалить нельзя', () => {
  const t = withPartner();
  const site = listConnections(t.db).find((c) => c.kind === 'site');
  assert.equal(refusal(() => updateConnection(t.db, site.id, { site_url: 'https://shifo.uz' }, t.actor)).message, SERVICE_MESSAGES.siteUrlInCompany);
  assert.equal(refusal(() => deleteConnection(t.db, site.id, t.actor, { confirm: true })).message, SERVICE_MESSAGES.siteNoDelete);
});

test('показать: значение из шифротекста, в журнал — «открыт» без значения; новый ключ — прежний не подходит; без подтверждения — отказ', () => {
  const t = withPartner();
  assert.equal(revealSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath }), t.key);
  assert.equal(revealSecret(t.db, t.id, 'secret', t.actor, { kekPath: t.kekPath }), t.secret);
  assert.deepEqual(listJournal(t.db, { connectionId: t.id }).slice(0, 2).map((x) => x.action), ['secret_revealed', 'key_revealed']);
  assert.equal(refusal(() => revealSecret(t.db, t.id, 'всё', t.actor, { kekPath: t.kekPath })).message, SERVICE_MESSAGES.badWhat);
  assert.equal(refusal(() => regenerateSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath })).message, SERVICE_MESSAGES.confirmKey);
  const r = regenerateSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath, confirm: true });
  assert.notEqual(r.value, t.key);
  const row = t.db.prepare('SELECT key_hash FROM api_connections WHERE id = ?').get(t.id);
  assert.equal(row.key_hash, keyHash(r.value));
  assert.notEqual(row.key_hash, keyHash(t.key), 'прежний ключ узнаётся');
  assert.equal(revealSecret(t.db, t.id, 'key', t.actor, { kekPath: t.kekPath }), r.value);
  const s = regenerateSecret(t.db, t.id, 'secret', t.actor, { kekPath: t.kekPath, confirm: true });
  assert.notEqual(s.value, t.secret);
  const text = JSON.stringify(listJournal(t.db));
  for (const v of [t.key, t.secret, r.value, s.value]) assert.ok(!text.includes(v), 'значение в журнале');
});

test('удаление — архив: ключ и секрет стёрты, источник скрыт и цел; второй раз — «не найдено»', () => {
  const t = withPartner();
  assert.equal(refusal(() => deleteConnection(t.db, t.id, t.actor)).message, SERVICE_MESSAGES.confirmDelete);
  deleteConnection(t.db, t.id, t.actor, { confirm: true });
  const row = t.db.prepare('SELECT * FROM api_connections WHERE id = ?').get(t.id);
  assert.deepEqual([row.key_hash, row.key_sealed, row.secret_sealed, row.active], ['', '', '', 0]);
  assert.ok(row.deleted_at);
  assert.equal(t.db.prepare("SELECT is_active FROM crm_sources WHERE key = 'api_med24_uz'").get().is_active, 0);
  assert.ok(!listConnections(t.db).some((c) => c.id === t.id));
  assert.equal(refusal(() => deleteConnection(t.db, t.id, t.actor, { confirm: true })).status, 404);
  assert.equal(listJournal(t.db, { connectionId: t.id })[0].action, 'deleted');
});

test('копия базы ключей не раскрывает: ни значения в файле копии, ни файла шифрования среди копий', async () => {
  const dir = tmpDir('em-apic-backup-');
  const db = openDb(path.join(dir, 'easymed.db'));
  migrate(db);
  // Файл шифрования — в каталоге данных, как в работе (рядом с базой и backups/).
  const t = withPartner(seed({ db, kekPath: path.join(dir, KEK_FILE) }));
  const b = await createBackup(db, dir, 'manual');
  const copy = fs.readFileSync(path.join(dir, 'backups', b.name)).toString('latin1');
  for (const v of [t.key, t.secret]) assert.ok(!copy.includes(v), 'значение в копии базы');
  const listed = fs.readdirSync(path.join(dir, 'backups'), { recursive: true }).map(String);
  assert.ok(!listed.some((f) => f.includes(KEK_FILE)), 'файл шифрования попал в копии');

  // Та же копия на ДРУГОМ компьютере, без файла шифрования.
  const dir2 = tmpDir('em-apic-otherpc-');
  fs.copyFileSync(path.join(dir, 'backups', b.name), path.join(dir2, 'easymed.db'));
  const db2 = openDb(path.join(dir2, 'easymed.db'));
  const kek2 = path.join(dir2, KEK_FILE);
  assert.equal(db2.prepare('SELECT key_hash FROM api_connections WHERE id = ?').get(t.id).key_hash, keyHash(t.key), 'ключ узнаётся по отпечатку');
  const e = refusal(() => revealSecret(db2, t.id, 'key', t.actor, { kekPath: kek2 }));
  assert.deepEqual([e.status, e.message], [409, SECRET_MESSAGES.kekMissing]);
  const fresh = regenerateSecret(db2, t.id, 'key', t.actor, { kekPath: kek2, confirm: true }).value;
  assert.equal(revealSecret(db2, t.id, 'key', t.actor, { kekPath: kek2 }), fresh);
  db.close(); db2.close();
});
```

  Стенд — `server/test-helpers/api-connections-seed.js` (задача 6).
- [ ] **Step 2:** `node --test server/services/api/connections-keys.test.js` → падает: функций нет.
- [ ] **Step 3: дописать в `connections.js`:**

```js
// ---- правка ----------------------------------------------------------------------
const EDITABLE = ['name', 'site_url', 'contact', 'scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow', 'active'];
const JOURNAL_FIELDS = ['name', 'site_url', 'contact', 'scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow'];
// В журнал — адрес без запроса и якоря: партнёры кладут туда токены.
const urlForJournal = (u) => { if (!u) return ''; try { const x = new URL(u); return x.origin + x.pathname; } catch { return ''; } };
function journalDetail(row, sets, changed) {
  const d = { fields: changed };
  if (changed.includes('name')) d.name = { from: row.name, to: sets.name };
  if (changed.includes('scopes')) {
    const a = arr(row.scopes); const b = arr(sets.scopes);
    d.scopes = { added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) };
  }
  if (changed.includes('webhook_url')) d.webhook_url = { from: urlForJournal(row.webhook_url), to: urlForJournal(sets.webhook_url) };
  if (changed.includes('rate_limit')) d.rate_limit = { from: row.rate_limit, to: sets.rate_limit };
  if (changed.includes('key_ttl')) d.key_ttl = { from: row.key_ttl, to: sets.key_ttl };
  return d;
}

/** Правка подключения: только присланное и изменённое; включение — с адресом для партнёров. */
export function updateConnection(db, id, patch, actor) {
  const row = liveRow(db, id);
  const v = normalizeConnection(pick(patch, EDITABLE));
  if (row.kind === 'site' && own(v, 'site_url')) throw new ApiConnectionError(SERVICE_MESSAGES.siteUrlInCompany, 409);
  checkOrThrow(connectionProblems(v, { partial: true }));
  const next = {};
  for (const k of ['name', 'site_url', 'contact', 'webhook_url', 'rate_limit', 'ip_allow']) if (own(v, k)) next[k] = v[k];
  if (own(v, 'scopes')) next.scopes = JSON.stringify(orderedScopes(v.scopes));
  if (own(v, 'webhook_events')) next.webhook_events = JSON.stringify(orderedEvents(v.webhook_events));
  if (own(v, 'key_ttl')) next.key_ttl = v.key_ttl;
  const changed = JOURNAL_FIELDS.filter((k) => own(next, k) && String(next[k]) !== String(row[k]));
  const turnOn = own(v, 'active') && v.active === 1 && row.active === 0;
  const turnOff = own(v, 'active') && v.active === 0 && row.active === 1;
  if (!changed.length && !turnOn && !turnOff) return getConnection(db, row.id);
  if (turnOn) requirePartnerAddress(db);   // решение владельца 11
  const sets = {};
  for (const k of changed) sets[k] = next[k];
  if (changed.includes('key_ttl')) sets.key_expires_at = keyExpiresAt(row.key_issued_at, next.key_ttl);
  if (turnOn || turnOff) sets.active = turnOn ? 1 : 0;
  sets.updated_at = nowIso();
  db.transaction(() => {
    const cols = Object.keys(sets);   // имена колонок — из списков выше, не из запроса
    db.prepare(`UPDATE api_connections SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => sets[c]), row.id);
    if (changed.includes('name') && row.owns_source) renameApiSource(db, row.crm_source_key, sets.name);
    if (changed.length) journal(db, { connectionId: row.id, actor, action: 'updated', detail: journalDetail(row, sets, changed) });
    if (turnOn || turnOff) journal(db, { connectionId: row.id, actor, action: turnOn ? 'enabled' : 'disabled' });
  })();
  return getConnection(db, row.id);
}

// ---- ключ и секрет: показать, выпустить новый ------------------------------------
const WHAT = Object.freeze({
  key:    { col: 'key_sealed', revealed: 'key_revealed', regenerated: 'key_regenerated', confirm: 'confirmKey' },
  secret: { col: 'secret_sealed', revealed: 'secret_revealed', regenerated: 'secret_regenerated', confirm: 'confirmSecret' },
});
function whatOf(what) {
  const w = Object.prototype.hasOwnProperty.call(WHAT, what) ? WHAT[what] : null;
  if (!w) throw new ApiConnectionError(SERVICE_MESSAGES.badWhat);
  return w;
}
/** «Показать» / «Скопировать» (решение владельца 5). KEK не создаётся: для чтения нового ключа шифрования не бывает. */
export function revealSecret(db, id, what, actor, { kekPath } = {}) {
  const w = whatOf(what);
  const row = liveRow(db, id);
  const value = unseal(row[w.col], loadKek({ kekPath }));
  journal(db, { connectionId: row.id, actor, action: w.revealed });
  return value;
}
/** Новый ключ или секрет: прежний не подходит сразу (Р17); срок ключа — от новой выдачи. */
export function regenerateSecret(db, id, what, actor, { kekPath, confirm } = {}) {
  const w = whatOf(what);
  if (confirm !== true) throw new ApiConnectionError(SERVICE_MESSAGES[w.confirm]);
  const row = liveRow(db, id);
  const kek = loadKek({ kekPath, create: true });
  const value = what === 'key' ? newApiKey() : newWebhookSecret();
  const at = nowIso();
  db.transaction(() => {
    if (what === 'key') {
      db.prepare(`UPDATE api_connections SET key_hash = ?, key_sealed = ?, key_tail = ?, key_issued_at = ?,
          key_issued_by_name = ?, key_expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(keyHash(value), seal(value, kek), tailOf(value), at, actor.name, keyExpiresAt(at, row.key_ttl), at, row.id);
    } else {
      db.prepare('UPDATE api_connections SET secret_sealed = ?, secret_tail = ?, updated_at = ? WHERE id = ?')
        .run(seal(value, kek), tailOf(value), at, row.id);
    }
    journal(db, { connectionId: row.id, actor, action: w.regenerated });
  })();
  return { value, connection: getConnection(db, row.id) };
}

// ---- удаление — архив (Р12) ----------------------------------------------------------
export function deleteConnection(db, id, actor, { confirm } = {}) {
  if (confirm !== true) throw new ApiConnectionError(SERVICE_MESSAGES.confirmDelete);
  const row = liveRow(db, id);
  if (row.kind === 'site') throw new ApiConnectionError(SERVICE_MESSAGES.siteNoDelete, 409);
  const at = nowIso();
  db.transaction(() => {
    db.prepare(`UPDATE api_connections SET deleted_at = ?, deleted_by = ?, active = 0, key_hash = '', key_sealed = '',
        key_tail = '', secret_sealed = '', secret_tail = '', updated_at = ? WHERE id = ?`).run(at, actor.id, at, row.id);
    if (row.owns_source) archiveApiSource(db, row.crm_source_key);
    journal(db, { connectionId: row.id, actor, action: 'deleted', detail: { name: row.name } });
  })();
  return { ok: true };
}
```

- [ ] **Step 4:** тесты зелёные (оба файла). Сторожа: `server/services/rpc/backup.test.js`, `server/services/backup.test.js`, `server/services/crm/config.test.js`.
- [ ] **Step 5: коммит** «API клиники: правка и включение подключения (с адресом для партнёров), показать и выпустить новый ключ и секрет, удаление-архив; копия базы ключей не раскрывает, на другом компьютере ключ работает, но не показывается (CLINIC_API_STEP7_V1)».

---

## Task 8: RPC «API и подключения» — права, филиал, лицензия; ключи не просачиваются ни в ответы, ни в журналы, ни в базу (CLINIC_API_STEP7_V1)

**Files:**
- Create: `server/services/rpc/api-connections.js`, `server/services/rpc/api-connections.test.js`
- Create: `server/routes/api-connections-http.test.js`
- Modify: `server/services/rpc/index.js` (импорт — рядом с :76 `lis-proxy`; карта — за :597-598 `lis_proxy_*`)
- Modify: `server/services/control/gate.js` (`READ_ONLY_RPCS`, рядом с :52 `lis_proxy_get`)
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `server/services/rpc/api-connections.test.js`:

```js
// CLINIC_API_STEP7_V1 — RPC «API и подключения»: кто что может (строка «API»,
// settings.api), филиал, лицензия, словарь.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setDataDir } from '../control/config.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { becomeSecondary } from '../branch-sync/identity.js';
import { TABLES } from '../branch-sync/catalogue.js';
import { SHIPPED } from '../branch-sync/journal.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';
import { __clearDraftsForTests } from '../api/drafts.js';
import { RPC } from './index.js';
import {
  RPC_MESSAGES, apiSettingsGet, apiSlugSave, apiConnectionDraft, apiConnectionCreate, apiConnectionUpdate,
  apiConnectionReveal, apiConnectionRegenerate, apiConnectionDelete, apiJournalList,
} from './api-connections.js';

const NAMES = ['api_settings_get', 'api_slug_save', 'api_connection_draft', 'api_connection_create', 'api_connection_update',
  'api_connection_reveal', 'api_connection_regenerate', 'api_connection_delete', 'api_journal_list'];
function seed() {
  setDataDir(tmpDir('em-apic-rpc-'));
  __clearDraftsForTests();
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)');
  u.run(1, 'boss', 'x', 'Босс', 'admin');
  u.run(2, 'reg', 'x', 'Регистратор', 'registrar');
  u.run(3, 'docadm', 'x', 'Врач-админ', 'doctor');
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', name_en = 'Shifo Clinic', region_code = 'tashkent-city',
    district_code = 'yunusobod', street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  for (const [code, level] of [['api_view', 'view'], ['api_edit', 'edit']]) {
    db.prepare('INSERT INTO custom_roles (code, name, base_role) VALUES (?, ?, ?)').run(code, code, 'registrar');
    db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(code,
      JSON.stringify({ sections: ['settings'], levels: {}, grants: { settings: 'view', 'settings.api': level } }));
  }
  return db;
}
const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const DOC_ADMIN = { id: 3, role: 'doctor', extra_roles: ['admin'] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };
const VIEW = { id: 2, role: 'registrar', extra_roles: [], custom_role_code: 'api_view' };
const EDIT = { id: 2, role: 'registrar', extra_roles: [], custom_role_code: 'api_edit' };
const st = (fn) => { try { fn(); return 200; } catch (e) { return e.status || 500; } };
function partner(db, user = ADMIN) {
  apiSlugSave(db, { slug: 'shifo' }, user);
  const d = apiConnectionDraft(db, {}, user);
  return apiConnectionCreate(db, { draft_id: d.draft_id, kind: 'partner', name: 'med24.uz',
    scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'] }, user);
}

test('чтение: без права — 403; «Просмотр» — без масок ключей и секретов; администратор — маски, `can`, адрес', () => {
  const db = seed();
  partner(db);
  assert.equal(st(() => apiSettingsGet(db, {}, REG)), 403);
  const v = apiSettingsGet(db, {}, VIEW);
  assert.deepEqual(v.can, { view: true, edit: false, admin: false });
  assert.ok(v.connections.length === 2 && v.connections.every((c) => c.key_mask === '' && c.secret_mask === ''));
  const a = apiSettingsGet(db, {}, ADMIN);
  assert.deepEqual(a.can, { view: true, edit: true, admin: true });
  assert.ok(a.connections.every((c) => /^em_live_••••/.test(c.key_mask)));
  assert.deepEqual([a.slug, a.base_url, a.public_server, a.building_role, a.clinic_name],
    ['shifo', 'https://api.easymed.uz/shifo/v1/', false, 'main', 'Шифо']);
  assert.deepEqual(a.partner_address_missing, []);
  assert.equal(st(() => apiJournalList(db, {}, VIEW)), 200);
});

test('«Изменение»: включить, выключить, переименовать — да; права, уведомления, безопасность, ключи — только администратор', () => {
  const db = seed();
  const { connection: c } = partner(db);
  assert.equal(apiConnectionUpdate(db, { id: c.id, name: 'med24', active: false }, EDIT).connection.name, 'med24');
  for (const patch of [{ scopes: ['clinic'] }, { webhook_url: 'https://x.uz/h' }, { webhook_events: [] }, { rate_limit: 30 },
    { key_ttl: 'never' }, { ip_allow: '203.0.113.7' }]) {
    assert.equal(st(() => apiConnectionUpdate(db, { id: c.id, ...patch }, EDIT)), 403, JSON.stringify(patch));
  }
  assert.equal(st(() => apiConnectionUpdate(db, { id: c.id, name: 'x' }, VIEW)), 403);
  assert.equal(st(() => apiConnectionUpdate(db, { id: c.id }, EDIT)), 400, 'нечего сохранять');
  for (const fn of [() => apiConnectionReveal(db, { id: c.id, what: 'key' }, EDIT),
    () => apiConnectionRegenerate(db, { id: c.id, what: 'key', confirm: true }, EDIT),
    () => apiConnectionDelete(db, { id: c.id, confirm: true }, EDIT),
    () => apiConnectionDraft(db, {}, EDIT),
    () => apiSlugSave(db, { slug: 'other' }, EDIT)]) assert.equal(st(fn), 403);
});

test('администратор-врач — как администратор (ADMIN_DOCTOR_V1)', () => {
  const db = seed();
  const { connection: c } = partner(db, DOC_ADMIN);
  assert.match(apiConnectionReveal(db, { id: c.id, what: 'key' }, DOC_ADMIN).value, /^em_live_/);
});

test('черновик: обновить ключ — та же запись; создать по чужому или устаревшему черновику нельзя', () => {
  const db = seed();
  apiSlugSave(db, { slug: 'shifo' }, ADMIN);
  const d = apiConnectionDraft(db, {}, ADMIN);
  const r = apiConnectionDraft(db, { draft_id: d.draft_id, renew: 'key' }, ADMIN);
  assert.equal(r.draft_id, d.draft_id);
  assert.notEqual(r.key, d.key);
  const out = apiConnectionCreate(db, { draft_id: d.draft_id, kind: 'symptex', name: 'Symptex', scopes: ['clinic'] }, ADMIN);
  assert.equal(out.key, r.key, 'создан с ОБНОВЛЁННЫМ ключом');
  assert.equal(out.base_url, 'https://api.easymed.uz/shifo/v1/');
  assert.equal(st(() => apiConnectionCreate(db, { draft_id: d.draft_id, kind: 'partner', name: 'x', scopes: ['clinic'] }, ADMIN)), 409);
});

test('филиал: чтение — роль здания и пусто; любая запись — 409', () => {
  const db = seed();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  const s = apiSettingsGet(db, {}, ADMIN);
  assert.deepEqual([s.building_role, s.connections], ['secondary', []]);
  for (const fn of [() => apiSlugSave(db, { slug: 'shifo' }, ADMIN), () => apiConnectionDraft(db, {}, ADMIN),
    () => apiConnectionUpdate(db, { id: 1, name: 'x' }, ADMIN)]) {
    assert.equal(st(fn), 409);
  }
  assert.throws(() => apiSlugSave(db, { slug: 'shifo' }, ADMIN), (e) => e.message === RPC_MESSAGES.mainOnly);
});

test('карта RPC, лицензия, здания, словарь', () => {
  for (const n of NAMES) assert.equal(typeof RPC[n], 'function', n);
  assert.deepEqual(NAMES.filter(isReadOnlyRpc), ['api_settings_get', 'api_journal_list']);
  assert.ok(!TABLES.some((t) => t.name.startsWith('api_')), 'подключения едут справочником в филиал');
  assert.ok(!Object.keys(SHIPPED).some((t) => t.startsWith('api_')), 'подключения едут журналом записей');
  for (const m of Object.values(RPC_MESSAGES)) assert.ok(STRINGS[m] && STRINGS[m].uz && STRINGS[m].en, m);
});
```

- [ ] **Step 2: падающий тест через HTTP** `server/routes/api-connections-http.test.js`:

```js
// CLINIC_API_STEP7_V1 — ключи через настоящее приложение: значение уходит
// только в своих ответах администратору — ни в список, ни в журнал, ни в
// console, ни в ops_events, ни в саму базу; /api/db таблиц подключений не знает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const add = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  add.run('boss', hashPassword('password1'), 'Босс', 'admin');
  add.run('reg', hashPassword('password2'), 'Регистратор', 'registrar');
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', region_code = 'tashkent-city', district_code = 'yunusobod',
    street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, p, body, cookie) => fetch(base + p, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body || {}) });
async function login(base, username, password) {
  const res = await post(base, '/api/auth/login', { username, password });
  return res.headers.get('set-cookie').split(';')[0];
}

test('ключ и секрет — только в своих ответах администратору; нигде больше', async () => {
  const t = await startServer();
  const logs = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error']) {
    orig[m] = console[m];
    console[m] = (...a) => { logs.push(a.map(String).join(' ')); orig[m].apply(console, a); };
  }
  try {
    const boss = await login(t.base, 'boss', 'password1');
    const rpc = async (name, body) => { const r = await post(t.base, '/api/rpc/' + name, body, boss); return { status: r.status, json: await r.json() }; };
    assert.equal((await rpc('api_slug_save', { slug: 'shifo' })).status, 200);
    const draft = (await rpc('api_connection_draft', {})).json.data;
    const created = (await rpc('api_connection_create', { draft_id: draft.draft_id, kind: 'partner', name: 'med24.uz',
      scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'],
      webhook_url: 'https://med24.uz/hooks', webhook_events: ['request.accepted'] })).json.data;
    const K = created.key;
    const S = created.secret;
    assert.match(K, /^em_live_/);
    const id = created.connection.id;
    const list = JSON.stringify((await rpc('api_settings_get', {})).json);
    assert.equal((await rpc('api_connection_reveal', { id, what: 'key' })).json.data.value, K);
    const K2 = (await rpc('api_connection_regenerate', { id, what: 'key', confirm: true })).json.data.value;
    assert.notEqual(K2, K);
    assert.equal((await rpc('api_connection_reveal', { id: 999, what: 'key' })).status, 404);
    const journal = JSON.stringify((await rpc('api_journal_list', {})).json);
    const places = {
      'список': list, 'журнал': journal, 'console': logs.join('\n'),
      'ops_events': JSON.stringify(t.db.prepare('SELECT * FROM ops_events').all()),
      'база': t.db.serialize().toString('latin1'),
    };
    for (const v of [K, K2, S]) for (const [where, hay] of Object.entries(places)) assert.ok(!hay.includes(v), 'значение просочилось: ' + where);
  } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
    t.server.close();
  }
});

test('/api/db не знает таблиц подключений — даже администратору; регистратор без права — 403 на чтение RPC', async () => {
  const t = await startServer();
  try {
    const boss = await login(t.base, 'boss', 'password1');
    for (const table of ['api_connections', 'api_settings', 'api_journal']) {
      const r = await post(t.base, '/api/db', { table, op: 'select', columns: '*' }, boss);
      assert.ok(r.status >= 400 && r.status < 500, table + ': ' + r.status);
    }
    const reg = await login(t.base, 'reg', 'password2');
    assert.equal((await post(t.base, '/api/rpc/api_settings_get', {}, reg)).status, 403);
  } finally { t.server.close(); }
});
```

- [ ] **Step 3:** запуск → падают: RPC нет.
- [ ] **Step 4: модуль** `server/services/rpc/api-connections.js`:

```js
// CLINIC_API_STEP7_V1 — RPC экрана «Настройки → API и подключения»
// (docs/plans/2026-10-10-clinic-api-7-api-screen.md).
//
// Почему RPC, а не /api/db: таблицы api_* намеренно НЕ зарегистрированы в
// schema-registry.js (как telegram_settings) — /api/db их не знает по
// построению. Значения ключей и секретов уходят только в четырёх ответах и
// только администратору: черновик, создание, «Показать / Скопировать»,
// выпуск нового. Маршрут /api/rpc печатает только имя RPC и текст ошибки, а
// тексты ошибок здесь значений не содержат (routes/api-connections-http.test.js).
//
// Права (строка «API» в «Ролях», settings.api; без настройки — только администратор):
//   «Просмотр»  — подключения, права, источники, журнал; ключи и секреты скрыты (даже хвост);
//   «Изменение» — включить и выключить, название, сайт, контакт;
//   администратор — имя в адресе, новое подключение, права подключения,
//     уведомления, безопасность, ключи и секреты, удаление.
// Филиал — только чтение: подключения живут в главном здании (публичный сервер
// шага 8 получает данные оттуда), записи — 409.
import { grantAllowsAdminOr, isAdminUser } from '../grants.js';
import { readIdentity } from '../branch-sync/identity.js';
import { apiBaseUrl } from '../../../public/js/shared/api-connections.js';
import {
  actorOf, readSlug, saveSlug, slugSuggestion, companyWebsite, clinicName, listConnections, listJournal,
  createConnection, updateConnection, revealSecret, regenerateSecret, deleteConnection,
} from '../api/connections.js';
import { makeDraft, renewDraft } from '../api/drafts.js';
import { companyAddressProblems } from '../api/partner-address.js';

export class RpcError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}
const KEY = 'settings.api';
export const RPC_MESSAGES = Object.freeze({
  noAccess:  'Раздел «API» недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли».',
  noEdit:    'Менять подключения API может роль с правом «API: Изменение».',
  adminOnly: 'Это делает только администратор: ключи и секреты, права, уведомления и безопасность подключений, новое подключение и имя в адресе.',
  mainOnly:  'Подключения API настраиваются в главном здании клиники.',
  nothing:   'Нечего сохранять.',
});
// Поля карточки по уровню: «Изменение» — первые; остальное — администратор.
const EDIT_FIELDS = ['name', 'site_url', 'contact', 'active'];
const ADMIN_FIELDS = ['scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow'];

function buildingRole(db) {
  try { return readIdentity(db).role === 'secondary' ? 'secondary' : 'main'; } catch { return 'main'; }
}
function requireView(db, user) {
  if (!grantAllowsAdminOr(db, user, KEY, 'view')) throw new RpcError(RPC_MESSAGES.noAccess, 403);
}
function requireEdit(db, user) {
  requireView(db, user);
  if (!grantAllowsAdminOr(db, user, KEY, 'edit')) throw new RpcError(RPC_MESSAGES.noEdit, 403);
}
function requireAdmin(db, user) {
  requireView(db, user);
  if (!isAdminUser(user)) throw new RpcError(RPC_MESSAGES.adminOnly, 403);
}
function requireMain(db) {
  if (buildingRole(db) === 'secondary') throw new RpcError(RPC_MESSAGES.mainOnly, 409);
}
// Не администратору — без масок: правило Telegram-бота («даже хвост не видит»).
const forViewer = (c, admin) => (admin ? c : { ...c, key_mask: '', secret_mask: '' });

export function apiSettingsGet(db, _args, user) {
  requireView(db, user);
  const admin = isAdminUser(user);
  const slug = readSlug(db);
  return {
    slug,
    base_url: apiBaseUrl(slug),
    slug_suggestion: slug ? '' : slugSuggestion(db),
    public_server: false,   // шаг 8 — публичный сервер ещё не включён
    building_role: buildingRole(db),
    clinic_name: clinicName(db),
    company_website: companyWebsite(db),
    partner_address_missing: Object.keys(companyAddressProblems(db)),   // решение владельца 11
    can: { view: true, edit: grantAllowsAdminOr(db, user, KEY, 'edit'), admin },
    connections: listConnections(db).map((c) => forViewer(c, admin)),
  };
}
export function apiSlugSave(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  return saveSlug(db, args && args.slug, actorOf(db, user));
}
export function apiConnectionDraft(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  const me = actorOf(db, user).id;
  if (a.draft_id && a.renew) { const d = renewDraft(a.draft_id, me, a.renew); if (d) return d; }
  return makeDraft(me);
}
export function apiConnectionCreate(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  const out = createConnection(db, a, actorOf(db, user), { draftId: a.draft_id });
  return { ...out, base_url: apiBaseUrl(readSlug(db)) };
}
export function apiConnectionUpdate(db, args, user) {
  requireEdit(db, user); requireMain(db);
  const a = args || {};
  const patch = {};
  for (const k of [...EDIT_FIELDS, ...ADMIN_FIELDS]) if (Object.prototype.hasOwnProperty.call(a, k)) patch[k] = a[k];
  if (!Object.keys(patch).length) throw new RpcError(RPC_MESSAGES.nothing);
  if (ADMIN_FIELDS.some((k) => k in patch)) requireAdmin(db, user);
  return { connection: forViewer(updateConnection(db, a.id, patch, actorOf(db, user)), isAdminUser(user)) };
}
export function apiConnectionReveal(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  return { value: revealSecret(db, a.id, a.what, actorOf(db, user)) };
}
export function apiConnectionRegenerate(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  return regenerateSecret(db, a.id, a.what, actorOf(db, user), { confirm: a.confirm });
}
export function apiConnectionDelete(db, args, user) {
  requireAdmin(db, user); requireMain(db);
  const a = args || {};
  return deleteConnection(db, a.id, actorOf(db, user), { confirm: a.confirm });
}
export function apiJournalList(db, args, user) {
  requireView(db, user);
  const a = args || {};
  return listJournal(db, { connectionId: a.connection_id ?? null, limit: a.limit });
}
```

  `rpc/index.js` — импорт рядом с `lis-proxy.js`:

```js
import { apiSettingsGet, apiSlugSave, apiConnectionDraft, apiConnectionCreate, apiConnectionUpdate, apiConnectionReveal,
  apiConnectionRegenerate, apiConnectionDelete, apiJournalList } from './api-connections.js';   // CLINIC_API_STEP7_V1
```

  В карте, за `lis_proxy_set`:

```js
  // CLINIC_API_STEP7_V1 — «API и подключения». Чтение (READ_ONLY_RPCS): api_settings_get,
  // api_journal_list; остальное — записи. Значения ключей — только администратору.
  api_settings_get:          (db, args, user) => apiSettingsGet(db, args, user),
  api_slug_save:             (db, args, user) => apiSlugSave(db, args, user),
  api_connection_draft:      (db, args, user) => apiConnectionDraft(db, args, user),
  api_connection_create:     (db, args, user) => apiConnectionCreate(db, args, user),
  api_connection_update:     (db, args, user) => apiConnectionUpdate(db, args, user),
  api_connection_reveal:     (db, args, user) => apiConnectionReveal(db, args, user),
  api_connection_regenerate: (db, args, user) => apiConnectionRegenerate(db, args, user),
  api_connection_delete:     (db, args, user) => apiConnectionDelete(db, args, user),
  api_journal_list:          (db, args, user) => apiJournalList(db, args, user),
```

  `gate.js`, за `'lis_proxy_get'`:
  `'api_settings_get', 'api_journal_list',   // CLINIC_API_STEP7_V1 — подключения API и журнал изменений; чтение`.
- [ ] **Step 5: словарь** («Нечего сохранять.» — есть):

| ru | uz | en |
|---|---|---|
| Раздел «API» недоступен вашей роли. Права выдаёт администратор в «Настройки → Роли». | «API» bo‘limi rolingiz uchun yopiq. Huquqlarni administrator «Sozlamalar → Rollar»da beradi. | The “API” section is not available to your role. The administrator grants rights in “Settings → Roles”. |
| Менять подключения API может роль с правом «API: Изменение». | API ulanishlarini «API: O‘zgartirish» huquqi bor rol o‘zgartira oladi. | API connections can be changed by a role with “API: Edit”. |
| Это делает только администратор: ключи и секреты, права, уведомления и безопасность подключений, новое подключение и имя в адресе. | Buni faqat administrator bajaradi: kalitlar va sirlar, ulanishlarning huquqlari, bildirishnomalari va xavfsizligi, yangi ulanish va manzildagi nom. | Only an administrator does this: keys and secrets, connection permissions, notifications and security, a new connection and the address name. |
| Подключения API настраиваются в главном здании клиники. | API ulanishlari klinikaning bosh binosida sozlanadi. | API connections are set up in the clinic’s main building. |

- [ ] **Step 6:** тесты зелёные. Сторожа:
  - `server/services/gate-fallbacks.test.js` (ворота `settings.api` — `grantAllowsAdminOr`, строка `adminDefault`);
  - `server/services/rpc/client-rpc-coverage.test.js`;
  - `server/routes/licence-gate.test.js`;
  - `server/app-test-hygiene.test.js`;
  - `server/i18n-server-messages.test.js`, `public/js/admin/__tests__/server-messages-i18n.test.mjs`;
  - `server/services/branch-sync/catalogue.test.js`, `journal.test.js`, `sync-e2e.test.js`.
- [ ] **Step 7: коммит** «API клиники: RPC «API и подключения» — просмотр, изменение и администратор; филиал только читает; при блокировке лицензии — только чтение; значения ключей не попадают ни в списки, ни в журналы, ни в базу (CLINIC_API_STEP7_V1)».

---
## Task 9: Экран «CRM-канбан» — «Источники из API» закрытым списком; «Сайт» сайта клиники не скрыть (CLINIC_API_STEP7_V1)

**Files:**
- Modify: `public/js/admin/crm-settings-logic.js` (`shapeConfig` :449-490 — источники)
- Modify: `public/js/admin/views/crm-settings.js` (`adoptConfig` :72-77, `renderCrmSettings` :106, `paint` ~:144, `paintSources` :480-521, новая `apiSourcesCard`)
- Test: `public/js/admin/crm-settings-logic.test.js`, `public/js/admin/__tests__/crm-settings.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

Макет `screen-crm.js` («Источники из API»):
- свой список, название не правится;
- у строки — метка «ключ em_live_••••» и кнопка «Подключение»;
- внизу: «Сайт клиники» пишет в обычный «Сайт», поэтому его здесь нет.

- [ ] **Step 1: падающие тесты.**
  - **`crm-settings-logic.test.js`:**

```js
// CLINIC_API_STEP7_V1 — источник подключения API доезжает до экрана с пометкой.
test('shapeConfig: у источника — api (чей и свой ли) или null', () => {
  const cfg = shapeConfig({ stages: [], sources: [
    { key: 'call', label: 'Звонок', position: 1, is_active: 1 },
    { key: 'api_med24_uz', label: 'med24.uz', position: 2, is_active: 1, api: { connection_id: 3, connection_name: 'med24.uz', owned: true, archived: false } },
  ] });
  assert.equal(cfg.sources[0].api, null);
  assert.deepEqual(cfg.sources[1].api, { connection_id: 3, connection_name: 'med24.uz', owned: true, archived: false });
});
```

  - **`crm-settings.test.mjs`** (стенд файла: `resetServer`, `render(onNavigate)`, `getRespond` / `saveRespond`, `lastSaveBody`, `findTextInputs`, `findButtonByAria`, `saveSourcesBtn`):

```js
// CLINIC_API_STEP7_V1 — источники подключений API.
function withApiSources() {
  const cfg = JSON.parse(JSON.stringify(FULL_CONFIG));
  cfg.sources.push({ key: 'website', label: 'Сайт', position: 3, is_active: 1,
    api: { connection_id: 1, connection_name: 'Сайт клиники', owned: false, archived: false } });
  cfg.sources.push({ key: 'api_med24_uz', label: 'med24.uz', position: 4, is_active: 1,
    api: { connection_id: 3, connection_name: 'med24.uz', owned: true, archived: false } });
  cfg.sources.push({ key: 'api_old', label: 'old.uz', position: 5, is_active: 0,
    api: { connection_id: 4, connection_name: 'old.uz', owned: true, archived: true } });
  getRespond = () => jsonOk(JSON.parse(JSON.stringify(cfg)));
  saveRespond = () => jsonOk(JSON.parse(JSON.stringify(cfg)));
}

test('«Источники из API» — закрытый список: «ключ em_live_••••», «Подключение» ведёт в API; удалённое — помечено и без ссылки', async () => {
  resetServer();
  withApiSources();
  const nav = [];
  const root = await render((view, payload) => nav.push([view, payload]));
  const text = textOf(root);
  for (const s of ['Источники из API', 'ключ em_live_••••', 'подключение удалено', 'поэтому его здесь нет']) assert.ok(text.includes(s), s);
  assert.ok(!findTextInputs(root).some((i) => i.value === 'med24.uz' || i.value === 'old.uz'), 'название источника подключения правится');
  const links = walk(root).filter((n) => n.attrs && n.attrs['data-crm-api-link']);
  assert.deepStrictEqual(links.map((n) => n.attrs['data-crm-api-link']), ['3'], 'ссылка только у живого подключения');
  links[0].click();
  assert.deepStrictEqual(nav, [['api-settings', { connection_id: 3 }]]);
});

test('«Сайт» сайта клиники: «Видна» заблокирована, «Удалить» нет, причина названа; в сохранение уходят только свои источники', async () => {
  resetServer();
  withApiSources();
  const root = await render();
  assert.ok(textOf(root).includes('Нужен подключению «Сайт клиники» в разделе «API»'));
  assert.strictEqual(findButtonByAria(root, 'Удалить').length, 2, 'удалить можно только две колонки — ни одного источника');
  const call = findTextInputs(root).find((i) => i.value === 'Звонок');
  call.value = 'Входящий';
  call.dispatchEvent({ type: 'input' });
  saveSourcesBtn(root).click();
  await tick();
  const sent = lastSaveBody.sources.map((s) => s.key);
  assert.deepStrictEqual(sent, ['call', 'telephony', 'website'], 'источники подключений ушли в список');
});
```

- [ ] **Step 2:** `node --test public/js/admin/crm-settings-logic.test.js` и `node --experimental-vm-modules --test public/js/admin/__tests__/crm-settings.test.mjs` → падают.
- [ ] **Step 3: правка.**

  `crm-settings-logic.js`, в `shapeConfig`, строка `sources:`:

```js
        // CLINIC_API_STEP7_V1 — источник подключения API: чей и свой ли
        // (services/crm/config.js listSources). Своих экран не правит.
        sources: withPositions(sources.map((s) => norm(s, (r) => ({
            api: r.api && typeof r.api === 'object'
                ? { connection_id: Number(r.api.connection_id) || null, connection_name: String(r.api.connection_name || ''),
                    owned: !!r.api.owned, archived: !!r.api.archived }
                : null,
        })))),
```

  `views/crm-settings.js`:
  - импорты: `import { isRouteAllowed } from '../permissions.js';   // CLINIC_API_STEP7_V1` и `import { KEY_PREFIX } from '../../shared/api-connections.js';   // CLINIC_API_STEP7_V1`;
  - `renderCrmSettings(container, { onNavigate } = {})`. Сброс `refs = { root: null, body: null, stages: null, sources: null, tags: null }` в начале функции дополнить полем `onNavigate: onNavigate || null` (и в объявлении `refs` :82 — `onNavigate: null`). Комментарий «No onNavigate…» (:103-105) заменить: `// CLINIC_API_STEP7_V1 — onNavigate снова нужен: «Подключение» у источника из API ведёт в «API и подключения».`;
  - в сохранении источников (:514) поле `api` в запрос не шлётся — оно только для экрана, а тест «источники сохраняются своей кнопкой…» сверяет присланное целиком:
    `const sources = withPositions(state.cfg.sources).map(({ api, ...s }) => ({ ...s, label: String(s.label || '').trim() }));   // CLINIC_API_STEP7_V1 — без api`;
  - в `adoptConfig` — **до** строки `state.baseSources = …`:

```js
    // CLINIC_API_STEP7_V1 — свои источники подключений API — отдельным закрытым
    // списком: экран их не правит и не присылает (сервер их не удаляет).
    state.apiSources = state.cfg.sources.filter((s) => s.api && s.api.owned);
    state.cfg.sources = state.cfg.sources.filter((s) => !(s.api && s.api.owned));
```

  - константа рядом с прочими текстами: `const API_NEEDED_REASON = 'Нужен подключению «{name}» в разделе «API» — скрыть или удалить нельзя.';   // CLINIC_API_STEP7_V1`;
  - в `paintSources`, в цикле строк:

```js
        const protectedRow = UNDELETABLE_SOURCE_KEYS.includes(row.key);
        // CLINIC_API_STEP7_V1 — «Сайт» подключения сайта клиники: не скрыть, не удалить.
        const apiNeeded = !!(row.api && !row.api.owned);
        if (protectedRow) anyProtected = true;
        if (apiNeeded) neededBy.push(row.api.connection_name);
        listBox.appendChild(rowBox({
            move: moveButtons(list, i, onChange),
            name: [labelInput(row), keyChip(row.key)],
            visible: activeToggle(row, apiNeeded ? { locked: true, lockedTitle: trf(API_NEEDED_REASON, { name: row.api.connection_name }) } : undefined),
            actions: protectedRow || apiNeeded ? null : removeButton(row.label, () => onChange(list.filter((_, j) => j !== i))),
        }));
```

    `const neededBy = [];` — рядом с `let anyProtected = false;`. После строки с `UNDELETABLE_SOURCE_REASON`:
    `for (const name of neededBy) box.appendChild(hint(trf(API_NEEDED_REASON, { name }), { marginTop: '6px' }));`.
  - новая карточка; в `paint()` — сразу за `refs.body.appendChild(sourcesCard());`:
    `const apiCard = apiSourcesCard(); if (apiCard) refs.body.appendChild(apiCard);   // CLINIC_API_STEP7_V1`.

```js
// CLINIC_API_STEP7_V1 — «Источники из API» (макет screen-crm.js): свой источник
// подключения Symptex или партнёра. Название — как у подключения; переименовать,
// скрыть и удалить его здесь нельзя; удалённое подключение оставляет его
// скрытым — прежние заявки сохраняют источник для отчётов.
function apiSourcesCard() {
    const rows = state.apiSources || [];
    if (!rows.length) return null;
    const list = h('div', { class: 'crm-set-list' });
    for (const s of rows) {
        const link = !s.api.archived && refs.onNavigate && isRouteAllowed('api-settings')
            ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-crm-api-link': String(s.api.connection_id),
                onclick: () => refs.onNavigate('api-settings', { connection_id: s.api.connection_id }) }, 'Подключение')
            : null;
        list.appendChild(h('div', { class: 'crm-api-src', 'data-crm-api-source': s.key },
            h('span', { class: 'crm-api-src-name' }, s.label),
            keyChip(s.key),
            h('span', { class: 'apic-chip api' }, Icon('Key', { size: 12 }), ' ', trf('ключ {mask}', { mask: KEY_PREFIX + '••••' })),
            s.api.archived ? Tag('подключение удалено') : null,
            link));
    }
    return cardShell('Key', 'Источники из API', h('div', { style: { padding: '18px' } },
        hint('Каждое подключение в «API и подключения» приносит заявки со своим источником. Источник создаётся вместе с подключением и называется как оно. Здесь его нельзя переименовать, скрыть или удалить; заявки, которые уже пришли, сохраняют источник.', { marginBottom: '12px' }),
        list,
        hint('Заявки с сайта клиники приходят с обычным источником «Сайт», поэтому его здесь нет.', { marginTop: '10px' })));
}
```

  - `admin-views.css` (блок шага — задача 10):
    `.crm-api-src { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--ink-100); }`
    `.crm-api-src-name { font-weight: 600; font-size: 13.5px; }`
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Источники из API | API manbalari | Sources from the API |
| Каждое подключение в «API и подключения» приносит заявки со своим источником. Источник создаётся вместе с подключением и называется как оно. Здесь его нельзя переименовать, скрыть или удалить; заявки, которые уже пришли, сохраняют источник. | «API va ulanishlar»dagi har bir ulanish arizalarni o‘z manbasi bilan olib keladi. Manba ulanish bilan birga yaratiladi va uning nomi bilan ataladi. Bu yerda uni qayta nomlab, yashirib yoki o‘chirib bo‘lmaydi; kelib bo‘lgan arizalar manbasini saqlaydi. | Each connection in “API and connections” brings requests with its own source. The source is created with the connection and named after it. Here it cannot be renamed, hidden or deleted; requests that have already arrived keep their source. |
| Заявки с сайта клиники приходят с обычным источником «Сайт», поэтому его здесь нет. | Klinika saytidan arizalar oddiy «Sayt» manbasi bilan keladi, shuning uchun u bu yerda yo‘q. | Requests from the clinic website arrive with the ordinary “Website” source, so it is not listed here. |
| ключ {mask} | kalit {mask} | key {mask} |
| подключение удалено | ulanish o‘chirilgan | connection deleted |
| Нужен подключению «{name}» в разделе «API» — скрыть или удалить нельзя. | «API» bo‘limidagi «{name}» ulanishiga kerak — yashirib ham, o‘chirib ham bo‘lmaydi. | Used by the connection “{name}” in “API” — cannot be hidden or deleted. |
| Подключение (есть) | | |

- [ ] **Step 5:** тесты зелёные. Сторожа:
  - `__tests__/crm-board-config.test.mjs`, `crm-i18n-leaks-en.test.mjs`, `crm-i18n-leaks-uz.test.mjs`;
  - `i18n-coverage.test.mjs`, `type-scale.test.mjs`.
- [ ] **Step 6: коммит** «CRM-канбан: «Источники из API» — закрытый список с ключом и ссылкой на подключение; «Сайт» сайта клиники нельзя скрыть или удалить (CLINIC_API_STEP7_V1)».

---

## Task 10: Экран «API и подключения» — страница: адрес, подключения, журнал (CLINIC_API_STEP7_V1)

**Files:**
- Create: `public/js/admin/views/api-ui.js` — общие кусочки экрана
- Create: `public/js/admin/views/api-connections.js` — страница
- Create: `public/js/admin/__tests__/api-harness.mjs`, `public/js/admin/__tests__/api-connections.test.mjs`
- Modify: `public/css/admin-views.css` (блок шага в конце файла)
- Modify: `public/js/admin/i18n-strings.js`

Окна «Новое подключение» и карточки подключения — задачи 11 и 12. В этой задаче страница зовёт их через `import` из файлов, которых ещё нет. Поэтому задача 10 создаёт обе функции-заглушки, а задачи 11–12 заменяют их содержимое:
- `api-connection-new.js`: `export async function openNewConnection() { return null; }   // CLINIC_API_STEP7_V1 — задача 11`;
- `api-connection-card.js`: `export function openConnectionCard() { return null; }   // CLINIC_API_STEP7_V1 — задача 12`.

- [ ] **Step 1: стенд** `public/js/admin/__tests__/api-harness.mjs`:

```js
// CLINIC_API_STEP7_V1 — стенд экрана «API и подключения»: поддельный DOM (как в
// crm-settings.test.mjs), RPC по имени, буфер обмена, русский язык ДО импорта видов.
export class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); else throw new Error('not a child'); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() { this.selected = true; } remove() {} scrollTo() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
export function mk(t) {
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById: (id) => (id === 'toast' ? toastEl : null),
  querySelector: () => null, querySelectorAll: () => [],
};
const store = new Map([['admin.lang', 'ru']]);   // I18N_LOCALE_PIN_V1 — до импорта видов
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, addEventListener() {},
  easymed: { state: { user: null } }, confirm: () => true, CLINIC: { id: 1, slug: 'local', name: 'Клиника Демо' } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
export const clip = [];
let clipboardOk = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'ru-RU', languages: ['ru-RU'], userAgent: 'node',
  clipboard: { writeText: async (t) => { if (!clipboardOk) throw new Error('denied'); clip.push(t); } } } });
export function setClipboard(ok) { clipboardOk = ok; }

export const calls = [];
const handlers = new Map();
export function onRpc(name, fn) { handlers.set(name, fn); }
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const m = /^\/api\/rpc\/([a-z_]+)/.exec(u);
  if (!m) return { ok: true, status: 200, json: async () => ({ data: {} }) };
  calls.push([m[1], body]);
  const fn = handlers.get(m[1]);
  const r = fn ? await fn(body) : null;
  if (r && r.__error) return { ok: false, status: r.status || 400, json: async () => ({ error: r.__error }) };
  return { ok: true, status: 200, json: async () => ({ data: r }) };
};
export function reset() {
  calls.length = 0; handlers.clear(); clip.length = 0; clipboardOk = true; toastMsg = null;
  document.body.children.length = 0; store.clear(); store.set('admin.lang', 'ru');
}
export const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
export const textOf = (el) => walk(el).map((n) => n._t || '').join('');
export const byAttr = (root, k, v) => walk(root).filter((n) => n.attrs && (v === undefined ? k in n.attrs : n.attrs[k] === v));
export const buttonByText = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n))) || null;
export const lastToast = () => toastMsg;
export const storeValues = () => [...store.values()];
export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
export const modal = (name) => document.body.children.find((n) => n.attrs && n.attrs['data-apic-modal'] === name) || null;
export const rpcNames = () => calls.map((c) => c[0]);

// Образцы значений: 32 знака после префикса и TESTONLY (страж no-real-api-keys).
export const KEY_VALUE = 'em_live_TESTONLYtestonlyTESTONLYtesta91c';
export const SECRET_VALUE = 'em_whsec_TESTONLYtestonlyTESTONLYtest51d0';
const ALL = ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments', 'cancel'];
export function settingsFixture(over = {}) {
  return {
    slug: 'klinika-demo', base_url: 'https://api.easymed.uz/klinika-demo/v1/', slug_suggestion: '', public_server: false,
    building_role: 'main', clinic_name: 'Клиника Демо', company_website: 'https://klinika-demo.uz', partner_address_missing: [],
    can: { view: true, edit: true, admin: true },
    connections: [
      { id: 1, kind: 'site', name: 'Сайт клиники', site_url: '', contact: '', scopes: ALL, active: false,
        crm_source_key: 'website', crm_source_label: 'Сайт', owns_source: false, key_mask: 'em_live_••••s1te',
        key_issued_at: '2026-10-10T09:00:00Z', key_issued_by_name: 'Босс', key_ttl: 'never', key_expires_at: null, rate_limit: 120,
        ip_allow: '', webhook_url: '', webhook_events: [], secret_mask: 'em_whsec_••••s1te', last_used_at: null,
        created_at: '2026-10-10T09:00:00Z', created_by_name: 'Босс' },
      { id: 3, kind: 'partner', name: 'med24.uz', site_url: 'https://med24.uz', contact: 'Отдел партнёров',
        scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'], active: true,
        crm_source_key: 'api_med24_uz', crm_source_label: 'med24.uz', owns_source: true, key_mask: 'em_live_••••a91c',
        key_issued_at: '2026-10-10T09:00:00Z', key_issued_by_name: 'Босс', key_ttl: '1y', key_expires_at: '2027-10-10T09:00:00Z',
        rate_limit: 60, ip_allow: '', webhook_url: 'https://med24.uz/hooks/easymed',
        webhook_events: ['request.accepted', 'appointment.created', 'appointment.cancelled'], secret_mask: 'em_whsec_••••51d0',
        last_used_at: null, created_at: '2026-10-10T09:00:00Z', created_by_name: 'Босс' },
    ],
    ...over,
  };
}
export const JOURNAL = [
  { id: 3, at: '2026-10-10T10:00:00Z', connection_id: 3, connection_name: 'med24.uz', user_name: 'Босс', action: 'key_regenerated', detail: {} },
  { id: 2, at: '2026-10-10T09:30:00Z', connection_id: 3, connection_name: 'med24.uz', user_name: 'Босс', action: 'updated', detail: { fields: ['name', 'scopes'] } },
  { id: 1, at: '2026-10-10T09:00:00Z', connection_id: null, connection_name: '', user_name: 'Босс', action: 'slug_saved', detail: { from: '', to: 'klinika-demo' } },
];
```

- [ ] **Step 2: падающий тест** `public/js/admin/__tests__/api-connections.test.mjs`:

```js
// CLINIC_API_STEP7_V1 — страница «API и подключения»: адрес, подключения, журнал;
// права (`can` от сервера), филиал, честные строки о публичном сервере.
import { test } from 'node:test';
import assert from 'node:assert';
import { mk, reset, onRpc, calls, clip, textOf, byAttr, buttonByText, tick, rpcNames, storeValues,
  settingsFixture, JOURNAL, KEY_VALUE } from './api-harness.mjs';

const { renderApiConnections } = await import('../views/api-connections.js');

async function open(over = {}, ctx = {}) {
  onRpc('api_settings_get', () => settingsFixture(over));
  onRpc('api_journal_list', () => JOURNAL);
  const root = mk('div');
  await renderApiConnections(root, ctx);
  await tick();
  return root;
}

test('администратор: адрес и «Ещё не работает», публичный сервер — прямо; подключения: маска, права, источник, уведомления, «ещё не было», статус; журнал', async () => {
  reset();
  const root = await open();
  const t = textOf(root);
  for (const s of ['API и подключения', 'https://api.easymed.uz/klinika-demo/v1/', 'Ещё не работает', 'Публичный сервер',
    'Ещё не включён', 'em_live_••••a91c', 'Все данные клиники', 'Запись на приём', 'med24.uz/hooks/easymed', 'событий: 3',
    'Не настроены', 'ещё не было', 'Включено', 'Выключено', 'создано автоматически', 'klinika-demo.uz',
    'Выпущен новый ключ', 'Настройки изменены: Название, Права', 'Изменено имя в адресе', 'Данные пациентов наружу не передаются']) {
    assert.ok(t.includes(s), 'нет на экране: ' + s);
  }
  assert.ok(buttonByText(root, /Добавить подключение/));
  assert.ok(!/\b(No|Add|Edit|yet)\b/.test(t), 'английский шаблон на русском экране');
});

test('имени в адресе нет: поле с предложением; неверное — объяснение без запроса; верное — api_slug_save; «Добавить подключение» выключена', async () => {
  reset();
  const root = await open({ slug: '', base_url: '', slug_suggestion: 'klinika-demo', connections: [] });
  const input = byAttr(root, 'id', 'apic-slug')[0];
  assert.equal(input.value, 'klinika-demo');
  assert.ok('disabled' in buttonByText(root, /Добавить подключение/).attrs);
  input.value = '-плохо';
  buttonByText(root, /^Сохранить$/).click();
  await tick();
  assert.ok(!rpcNames().includes('api_slug_save'));
  assert.ok(textOf(root).includes('Только латинские буквы, цифры и дефис'));
  onRpc('api_slug_save', (b) => ({ slug: b.slug, base_url: 'https://api.easymed.uz/' + b.slug + '/v1/', site_created: true }));
  input.value = ' Shifo ';
  buttonByText(root, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'api_slug_save')[1], { slug: 'shifo' });
});

test('«Просмотр»: без «Добавить подключение», ключ «Скрыт», без копирования; имя в адресе не правится', async () => {
  reset();
  const root = await open({ can: { view: true, edit: false, admin: false },
    connections: settingsFixture().connections.map((c) => ({ ...c, key_mask: '', secret_mask: '' })) });
  const t = textOf(root);
  assert.ok(!buttonByText(root, /Добавить подключение/));
  assert.ok(!buttonByText(root, /Изменить имя/));
  assert.ok(t.includes('Скрыт'));
  assert.equal(byAttr(root, 'data-apic-act', 'copy-key').length, 0);
  assert.ok(t.includes('Новое подключение создаёт администратор'));
});

test('филиал: только строка «в главном здании»', async () => {
  reset();
  const root = await open({ building_role: 'secondary', connections: [] });
  assert.ok(textOf(root).includes('Подключения API настраиваются в главном здании клиники.'));
  assert.ok(!buttonByText(root, /Добавить подключение/));
});

test('скопировать ключ из таблицы: api_connection_reveal и буфер; значения нет ни на странице, ни в localStorage', async () => {
  reset();
  const root = await open();
  onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
  byAttr(root, 'data-apic-act', 'copy-key')[1].click();
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'api_connection_reveal')[1], { id: 3, what: 'key' });
  assert.deepEqual(clip, [KEY_VALUE]);
  assert.ok(!textOf(root).includes(KEY_VALUE), 'значение осталось на странице');
  assert.ok(!storeValues().some((v) => v.includes(KEY_VALUE)), 'значение в localStorage');
});

test('адрес для партнёров не заполнен: предупреждение и «Открыть «Компанию»»', async () => {
  reset();
  const nav = [];
  const root = await open({ partner_address_missing: ['region_code', 'street_ru'] }, { onNavigate: (v) => nav.push(v) });
  assert.ok(textOf(root).includes('Адрес для партнёров в «Компании» не заполнен'));
  buttonByText(root, /Открыть «Компанию»/).click();
  assert.deepEqual(nav, ['documents-settings']);
});

test('срок ключа: «Ключ истекает …» за 14 дней и «Ключ истёк»', async () => {
  reset();
  const soon = new Date(Date.now() + 5 * 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  const base = settingsFixture();
  const root = await open({ connections: [{ ...base.connections[1], key_expires_at: soon }, { ...base.connections[1], id: 5, key_expires_at: past }] });
  assert.ok(textOf(root).includes('Ключ истекает'));
  assert.ok(textOf(root).includes('Ключ истёк'));
});

test('сервер старше экрана (data: null): пустой, но целый экран', async () => {
  reset();
  onRpc('api_settings_get', () => null);
  onRpc('api_journal_list', () => null);
  const root = mk('div');
  await renderApiConnections(root, {});
  await tick();
  assert.ok(textOf(root).includes('API и подключения'));
});

test('открыть по ссылке из CRM: страница с payload грузится (карточка — задача 12)', async () => {
  reset();
  await open({}, { payload: { connection_id: 3 } });
  assert.ok(rpcNames().includes('api_settings_get'));
});
```

  Последний тест задача 12 заменяет полным: карточка подключения 3 открыта (`modal('conn')`). Здесь он проверяет только, что страница с `payload` грузится.
- [ ] **Step 3:** `node --experimental-vm-modules --test public/js/admin/__tests__/api-connections.test.mjs` → падает: модуля нет.
- [ ] **Step 4: общие кусочки** `public/js/admin/views/api-ui.js`:

```js
// CLINIC_API_STEP7_V1 — ОБЩИЕ КУСОЧКИ ЭКРАНА «API И ПОДКЛЮЧЕНИЯ»: RPC, поле
// ключа, разделы и поля формы, права и журнал, окно. Их делят страница
// (api-connections.js), «Новое подключение» (api-connection-new.js) и карточка
// подключения (api-connection-card.js).
//
// Значение ключа или секрета живёт только в поле открытого окна — не в
// localStorage, не в адресе страницы, не в console. Скрытое поле держит маску;
// значение экран спрашивает у сервера (api_connection_reveal) только по нажатию
// «Показать» или «Скопировать» — каждое такое открытие сервер пишет в журнал.
// Буфер обмена браузер даёт только защищённой странице (https или localhost):
// в сети Easy-Med открывают по http — тогда значение выделяется для Ctrl+C.
import { supabase } from '../../supabase.js';
import { h, Icon, Tag, toast, fmtDate, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import {
  KINDS, KIND_INFO, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, EVENTS, EVENT_INFO, RATE_LIMITS, KEY_TTLS, KEY_TTL_LABEL,
  NAME_MAX, CONTACT_MAX, keyExpiryState,
} from '../../shared/api-connections.js';

export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const e = new Error(error.message || 'Не удалось выполнить запрос.');
    e.code = error.code || '';
    throw e;
  }
  return data;
}

/** Ответ api_settings_get — с запасными значениями: сервер старше экрана присылает меньше. */
export function shapeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const can = r.can && typeof r.can === 'object' ? r.can : {};
  return {
    slug: String(r.slug || ''), base_url: String(r.base_url || ''), slug_suggestion: String(r.slug_suggestion || ''),
    public_server: !!r.public_server, building_role: r.building_role === 'secondary' ? 'secondary' : 'main',
    clinic_name: String(r.clinic_name || ''), company_website: String(r.company_website || ''),
    partner_address_missing: Array.isArray(r.partner_address_missing) ? r.partner_address_missing : [],
    can: { view: !!can.view, edit: !!can.edit, admin: !!can.admin },
    connections: Array.isArray(r.connections) ? r.connections : [],
  };
}

export async function copyText(text) {
  const cb = (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
  try {
    if (!cb || typeof cb.writeText !== 'function') throw new Error('no clipboard');
    await cb.writeText(text);
    toast(tr('Скопировано'), 'ok');
    return true;
  } catch {
    toast(tr('Скопируйте вручную'), 'info');
    return false;
  }
}

/**
 * Поле ключа, секрета или адреса: значение, «Показать» (если его надо спросить у
 * сервера), «Скопировать», по желанию — «Сгенерировать новый».
 *   value    — известное значение (черновик, только что выпущенный ключ, адрес API);
 *   mask     — маска, пока значение не спрошено;
 *   getValue — спросить значение у сервера (api_connection_reveal).
 */
export function secretField({ label, value = '', mask = '', getValue = null, regen = null }) {
  let known = value || '';
  let shown = !!known;
  const input = h('input', { type: 'text', readonly: 'readonly', class: 'apic-secret cell-mono', spellcheck: 'false',
    translate: 'no', autocomplete: 'off', 'aria-label': label });
  input.value = known || mask;
  input.addEventListener('focus', () => { try { input.select(); } catch { /* выделение — удобство */ } });
  const ensure = async () => { if (!known && getValue) known = await getValue(); return known; };
  const showBtn = getValue ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-apic-act': 'show' }, 'Показать') : null;
  if (showBtn) showBtn.addEventListener('click', async () => {
    if (shown) { shown = false; input.value = mask; showBtn.textContent = tr('Показать'); return; }
    try { input.value = await ensure(); shown = true; showBtn.textContent = tr('Скрыть'); }
    catch (e) { toast(tr(e.message), 'fail'); }
  });
  const copyBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'copy' },
    Icon('Copy', { size: 13 }), ' ', 'Скопировать');
  copyBtn.addEventListener('click', async () => {
    let v;
    try { v = await ensure(); } catch (e) { toast(tr(e.message), 'fail'); return; }
    if (await copyText(v)) return;
    // Буфера нет — значение в поле и выделено: Ctrl+C его копирует.
    input.value = v; shown = true;
    if (showBtn) showBtn.textContent = tr('Скрыть');
    try { input.focus(); input.select(); } catch { /* выделение — удобство */ }
  });
  const regenBtn = regen
    ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-apic-act': 'regen' }, Icon('Refresh', { size: 13 }), ' ', regen.label)
    : null;
  if (regenBtn) regenBtn.addEventListener('click', () => regen.onClick());
  const box = h('div', { class: 'apic-keyfield' }, input, showBtn, copyBtn, regenBtn);
  box.setValue = (v) => { known = v; shown = true; input.value = v; if (showBtn) showBtn.textContent = tr('Скрыть'); };
  box.input = input;
  return box;
}

export function section(title, sub, ...children) {
  return h('section', { class: 'apic-sec' },
    h('h4', { class: 'apic-sec-title' }, title, sub ? h('span', { class: 'apic-sec-sub' }, sub) : null), ...children);
}
export function fieldBox(label, control, error, hint, { required = false, id = null } = {}) {
  return h('div', { class: 'field' + (error ? ' has-error' : '') },
    h('label', id ? { for: id } : null, label, required ? h('span', { class: 'req' }, ' *') : null),
    control,
    hint ? h('div', { class: 'hint' }, hint) : null,
    error ? h('div', { class: 'apic-err', role: 'alert' }, error) : null);
}
export function textInput(id, value, onInput, { disabled = false, placeholder = '', maxlength = 0, inputmode = '' } = {}) {
  const el = h('input', { type: 'text', id, placeholder, disabled, autocomplete: 'off',
    maxlength: maxlength ? String(maxlength) : null, inputmode: inputmode || null });
  el.value = value || '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}
export function checkList(name, keys, info, chosen, onToggle, { disabled = false, cls = '' } = {}) {
  return h('div', { class: 'apic-checks' + (cls ? ' ' + cls : '') }, ...keys.map((k) => {
    const id = 'apic-' + name + '-' + k.replace(/\./g, '-');
    const box = h('input', { type: 'checkbox', id, value: k, disabled, checked: chosen.includes(k) });
    box.addEventListener('change', () => onToggle(k, !!box.checked));
    return h('label', { class: 'apic-check', for: id }, box, h('b', null, info[k].label), h('span', null, info[k].desc));
  }));
}
export function kindPicker(current, onPick, { siteTaken = true } = {}) {
  return h('div', { class: 'apic-kinds', role: 'radiogroup', 'aria-label': 'Кто подключается' }, ...KINDS.map((k) => {
    const K = KIND_INFO[k];
    // Р10 — сайт клиники создаётся сам и один: в окне он виден, но не выбирается.
    const off = k === 'site' && siteTaken;
    const b = h('button', { class: 'apic-kind', type: 'button', role: 'radio', 'aria-checked': String(current === k),
      'data-apic-kind': k, disabled: off },
      h('span', { class: 'apic-ico t-' + k }, Icon(K.icon, { size: 18 })),
      h('span', null, h('b', null, K.label), h('span', { class: 'apic-sub' }, off ? 'Подключение сайта клиники уже есть — оно создаётся само.' : K.desc)));
    if (!off) b.addEventListener('click', () => onPick(k));
    return b;
  }));
}
export function permChips(scopes) {
  const list = Array.isArray(scopes) ? scopes : [];
  const read = READ_SCOPES.filter((k) => list.includes(k));
  const write = WRITE_SCOPES.filter((k) => list.includes(k));
  const chips = [];
  if (read.length === READ_SCOPES.length) chips.push(h('span', { class: 'apic-chip' }, 'Все данные клиники'));
  else for (const k of read) chips.push(h('span', { class: 'apic-chip' }, SCOPE_INFO[k].label));
  for (const k of write) chips.push(h('span', { class: 'apic-chip w' }, SCOPE_INFO[k].label));
  if (!write.length) chips.push(h('span', { class: 'apic-chip ro' }, 'Только просмотр'));
  return h('div', { class: 'apic-chips' }, ...chips);
}
/** Метка срока ключа: за 14 дней — «истекает», после — «истёк». */
export function expiryTag(c, now = Date.now()) {
  const st = keyExpiryState(c.key_expires_at, now);
  if (st === 'expired') return Tag(tr('Ключ истёк'), { kind: 'crit' });
  if (st === 'soon') return Tag(trf('Ключ истекает {date}', { date: fmtDate(c.key_expires_at) }), { kind: 'warn' });
  return null;
}

export const ACTION_LABEL = Object.freeze({
  slug_saved: 'Изменено имя в адресе', created: 'Подключение создано', updated: 'Настройки изменены',
  enabled: 'Подключение включено', disabled: 'Подключение выключено', key_revealed: 'Ключ открыт',
  key_regenerated: 'Выпущен новый ключ', secret_revealed: 'Секрет открыт', secret_regenerated: 'Выпущен новый секрет',
  deleted: 'Подключение удалено',
});
const FIELD_LABEL = Object.freeze({
  name: 'Название', site_url: 'Адрес сайта', contact: 'Контакт', scopes: 'Права', webhook_url: 'Адрес для уведомлений',
  webhook_events: 'События уведомлений', rate_limit: 'Лимит запросов', key_ttl: 'Срок действия ключа', ip_allow: 'Разрешённые IP-адреса',
});
export function actionText(r) {
  const head = tr(ACTION_LABEL[r.action] || r.action);
  const d = r.detail || {};
  if (r.action === 'slug_saved') return head + ': ' + (d.from || '—') + ' → ' + (d.to || '—');
  if (r.action === 'updated' && Array.isArray(d.fields)) return head + ': ' + d.fields.map((f) => tr(FIELD_LABEL[f] || f)).join(', ');
  return head;
}
export function journalTable(rows, { withConnection = true } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return h('div', { class: 'empty' }, 'Изменений пока не было.');
  const tb = h('tbody');
  for (const r of list) {
    tb.appendChild(h('tr', null,
      h('td', { class: 'apic-nowrap' }, fmtDateTime(r.at)),
      h('td', null, r.user_name || '—'),
      withConnection ? h('td', null, r.connection_name || '—') : null,
      h('td', null, actionText(r))));
  }
  return h('div', { class: 'apic-tblwrap' }, h('table', { class: 'tbl apic-tbl' },
    h('thead', null, h('tr', null, h('th', null, 'Когда'), h('th', null, 'Кто'),
      withConnection ? h('th', null, 'Подключение') : null, h('th', null, 'Что сделано'))), tb));
}

/** Окно. Закрытие убирает его из документа — значения в полях уходят вместе с ним. */
export function openModal({ title, body, foot, tabs = null, width = 920, name = '' }) {
  const overlay = h('div', { class: 'modal apic-modal', 'data-apic-modal': name });
  const close = () => { try { document.body.removeChild(overlay); } catch { overlay.remove(); } };
  const card = h('div', { class: 'modal-card apic-modal-card', role: 'dialog', 'aria-modal': 'true',
    style: { width: width + 'px', maxWidth: 'calc(100vw - 32px)' } },
    h('header', { class: 'modal-head' }, h('h2', null, ...title), h('button', { class: 'modal-close', type: 'button', onclick: close }, '×')),
    tabs, body, h('footer', { class: 'modal-foot' }, ...foot));
  overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
  overlay.appendChild(card);
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(overlay);
  return { overlay, close };
}

/** Отказ «нет адреса для партнёров» (решение владельца 11) — с дорогой в «Компанию». */
export function addressBlock(message, onNavigate, onLeave = null) {
  const go = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'open-company' },
    Icon('MapPin', { size: 13 }), ' ', 'Открыть «Компанию»');
  go.addEventListener('click', () => { if (onLeave) onLeave(); if (onNavigate) onNavigate('documents-settings'); });
  return h('div', { class: 'apic-confirm', role: 'alert' }, h('p', null, message), h('div', { class: 'apic-row' }, go));
}

// ---- поля подключения (окно «Новое подключение» и карточка) ---------------------
export function basicsFields(d, errs, { disabled = false, isNew = false, sourceLabel = '', companyWebsite = '' } = {}) {
  const kind = d.kind;
  const name = textInput('apic-f-name', d.name, (v) => { d.name = v; }, { disabled, maxlength: NAME_MAX,
    placeholder: kind === 'partner' ? 'Например, med24.uz' : kind === 'symptex' ? 'Symptex' : 'Сайт клиники' });
  // Р10 — адрес сайта клиники один: поле «Сайт» в «Компании»; здесь он только виден.
  const site = kind === 'site'
    ? h('div', { class: 'apic-readonly cell-mono', translate: 'no' }, companyWebsite || '—')
    : textInput('apic-f-site', d.site_url, (v) => { d.site_url = v; }, { disabled, placeholder: 'https://', inputmode: 'url' });
  const siteHint = kind === 'site'
    ? 'Адрес — из «Компании», поле «Сайт»: меняется там. Если сайт делает Easy-Med, адрес подставится сам.'
    : 'Для справки: где подключение показывает клинику.';
  const contact = kind === 'site' ? null : textInput('apic-f-contact', d.contact, (v) => { d.contact = v; },
    { disabled, maxlength: CONTACT_MAX, placeholder: 'Имя, телефон или почта' });
  const source = isNew
    ? h('p', { class: 'apic-src' }, 'Для заявок этого подключения в CRM появится свой источник с его названием. В настройках CRM его нельзя переименовать, скрыть или удалить.')
    : h('span', { class: 'apic-chip api' }, sourceLabel);
  return h('div', { class: 'apic-grid2' },
    fieldBox('Название', name, errs.name, null, { required: true, id: 'apic-f-name' }),
    fieldBox(kind === 'partner' ? 'Сайт партнёра' : 'Адрес сайта', site, errs.site_url, siteHint, { id: kind === 'site' ? null : 'apic-f-site' }),
    contact ? fieldBox('Контакт у партнёра', contact, errs.contact, 'Кому звонить, если с подключением что-то не так.', { id: 'apic-f-contact' }) : null,
    fieldBox('Источник заявок в CRM', source, null, null));
}
export function accessSections(d, errs, { disabled = false } = {}) {
  const toggle = (k, on) => { d.scopes = on ? [...new Set([...d.scopes, k])] : d.scopes.filter((x) => x !== k); };
  return h('div', null,
    section('Что можно получать', 'данные, которые видит подключение', checkList('read', READ_SCOPES, SCOPE_INFO, d.scopes, toggle, { disabled })),
    section('Что можно отправлять в клинику', 'заявки и записи пациентов', checkList('write', WRITE_SCOPES, SCOPE_INFO, d.scopes, toggle, { disabled, cls: 'three' })),
    errs.scopes ? h('div', { class: 'apic-err', role: 'alert' }, errs.scopes) : null);
}
export function hooksSection(d, errs, { disabled = false, secretEl = null, secretNote = null } = {}) {
  const url = textInput('apic-f-hook', d.webhook_url, (v) => { d.webhook_url = v; },
    { disabled, placeholder: 'https://partner.uz/hooks/easymed', inputmode: 'url' });
  const toggle = (k, on) => { d.webhook_events = on ? [...new Set([...d.webhook_events, k])] : d.webhook_events.filter((x) => x !== k); };
  // Р15 — пробное уведомление честно отправит только публичный сервер (шаг 8):
  // кнопка видна, но выключена, и рядом сказано почему.
  const test = h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled: true, 'data-apic-act': 'hook-test',
    'aria-describedby': 'apic-hook-test-why' }, Icon('Send', { size: 13 }), ' ', 'Проверить адрес');
  return section('Уведомления о заявках (вебхук)', 'Easy-Med сообщает подключению, что стало с его заявкой',
    fieldBox('Адрес для уведомлений', url, errs.webhook_url, 'Пусто — уведомления не отправляем. Принимаем только https://.', { id: 'apic-f-hook' }),
    h('div', { class: 'apic-row' }, test,
      h('span', { class: 'hint', id: 'apic-hook-test-why' }, 'Пробное уведомление можно будет отправить, когда в Easy-Med включат публичный сервер.')),
    checkList('events', EVENTS, EVENT_INFO, d.webhook_events, toggle, { disabled }),
    errs.webhook_events ? h('div', { class: 'apic-err', role: 'alert' }, errs.webhook_events) : null,
    secretEl
      ? h('div', { class: 'field' }, h('label', null, 'Секрет для подписи уведомлений'), secretEl,
          h('div', { class: 'hint' }, 'Каждое уведомление будет подписано этим секретом (заголовок X-EasyMed-Signature): так подключение проверит, что уведомление пришло от клиники.'))
      : secretNote,
    h('dl', { class: 'apic-kv' }, h('dt', null, 'Если адрес не ответит'), h('dd', null, 'Повторим 5 раз: через 1, 5, 10, 30 и 60 минут')),
    h('p', { class: 'apic-note' }, Icon('Info', { size: 16 }), h('span', null, 'Уведомления начнут уходить, когда в Easy-Med включат публичный сервер.')));
}
export function securityFields(d, errs, { disabled = false } = {}) {
  const rate = h('select', { id: 'apic-f-rate', disabled },
    ...RATE_LIMITS.map((n) => h('option', { value: String(n) }, trf('{n} в минуту', { n }))));
  rate.value = String(d.rate_limit);
  rate.addEventListener('change', () => { d.rate_limit = Number(rate.value); });
  const ttl = h('select', { id: 'apic-f-ttl', disabled }, ...KEY_TTLS.map((k) => h('option', { value: k }, KEY_TTL_LABEL[k])));
  ttl.value = d.key_ttl;
  ttl.addEventListener('change', () => { d.key_ttl = ttl.value; });
  const ips = h('textarea', { id: 'apic-f-ips', rows: '3', disabled, placeholder: 'По одному на строку', spellcheck: 'false', translate: 'no' });
  ips.value = d.ip_allow || '';
  ips.addEventListener('input', () => { d.ip_allow = ips.value; });
  return section('Безопасность', '',
    h('div', { class: 'apic-grid2' },
      fieldBox('Лимит запросов', rate, errs.rate_limit, 'Сверх лимита подключение получит ответ «429, подождите».', { id: 'apic-f-rate' }),
      fieldBox('Срок действия ключа', ttl, errs.key_ttl, 'За 14 дней до конца срока здесь появится напоминание.', { id: 'apic-f-ttl' })),
    fieldBox('Разрешённые IP-адреса', ips, errs.ip_allow, 'Необязательно. Пусто — запросы с любого адреса, но только с ключом.', { id: 'apic-f-ips' }),
    h('p', { class: 'apic-note' }, Icon('Info', { size: 16 }),
      h('span', null, 'Лимит, срок ключа и разрешённые адреса начнут действовать, когда в Easy-Med включат публичный сервер. Только HTTPS — всегда.')));
}
export function activeField(d, { disabled = false, ready = true } = {}) {
  const box = h('input', { type: 'checkbox', id: 'apic-f-active', checked: !!d.active, disabled });
  box.addEventListener('change', () => { d.active = !!box.checked; });
  return section('Состояние', '',
    h('label', { class: 'apic-check', for: 'apic-f-active' }, box, h('b', null, 'Подключение включено'),
      h('span', null, 'Выключенное подключение не получает данные и не присылает заявки. Настройки сохраняются, включить можно в любой момент.')),
    ready ? null : h('p', { class: 'apic-note warn' }, Icon('Warning', { size: 16 }),
      h('span', null, 'Адрес для партнёров в «Компании» не заполнен: подключение можно сохранить только выключенным. Заполните адрес и включите его.')));
}
```

- [ ] **Step 5: страница** `public/js/admin/views/api-connections.js`:

```js
// CLINIC_API_STEP7_V1 — Настройки → «API и подключения» (docs/specs/2026-10-06-clinic-api-design.md,
// шаг 7; макет mockups/api-settings/js/screen-api.js; план 2026-10-10-clinic-api-7-api-screen.md).
//
// Заменяет два экрана облачной эпохи: «Ключи API» (общий редактор справочника
// над заглушкой api_tokens — ключ вписывали руками, сервер его не проверял) и
// прежний views/api-settings.js (облачный шлюз /api/v1, офлайн его нет).
//
// Здесь: адрес клиники для подключений (https://api.easymed.uz/<имя>/v1/),
// подключения с ключом, правами, источником CRM и уведомлениями, журнал
// изменений. Чего ещё нет — и экран говорит это прямо: публичного сервера
// (шаг 8). Ключи можно выпустить и передать заранее; работать они начнут,
// когда его включат.
//
// Что можно этому человеку, говорит сервер (`can`): экран не угадывает права.
import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, Tag, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { refreshClinicBrand } from '../clinic-context.js';
import { API_HOST, KIND_INFO, normalizeSlug, slugProblem } from '../../shared/api-connections.js';
import { rpc, shapeSettings, copyText, permChips, expiryTag, journalTable, addressBlock } from './api-ui.js';
import { openNewConnection } from './api-connection-new.js';
import { openConnectionCard } from './api-connection-card.js';

const SUBTITLE = 'Сайт клиники, Symptex и партнёры получают отсюда врачей, свободное время, услуги и цены. Заявки и записи пациентов приходят в CRM с источником своего подключения.';
const PRIVACY = 'Данные пациентов наружу не передаются. Подключения видят только то, что клиника публикует: профиль клиники, врачей, свободное время, услуги и пакеты. Если лицензия Easy-Med закончится, сайт и партнёры перестанут получать данные и отправлять заявки, пока её не продлят.';

const state = { s: shapeSettings(null), journal: [], editSlug: false };
let refs = { root: null, body: null, onNavigate: null };

export async function renderApiConnections(container, { onNavigate = null, payload = null } = {}) {
  clear(container);
  refs = { root: h('div', { class: 'fade-in apic' }), body: h('div', { class: 'apic-stack' }), onNavigate };
  state.editSlug = false;
  container.appendChild(refs.root);
  refs.root.appendChild(PageHead({ title: 'API и подключения', subtitle: SUBTITLE }));
  refs.root.appendChild(refs.body);
  await reload();
  // Ссылка «Подключение» из CRM-канбана: открыть карточку сразу.
  const id = payload && Number(payload.connection_id);
  const c = id ? state.s.connections.find((x) => x.id === id) : null;
  if (c) openCard(c);
}

async function reload() {
  clear(refs.body);
  refs.body.appendChild(h('div', { class: 'muted', style: { padding: '24px' } }, 'Загрузка…'));
  try {
    state.s = shapeSettings(await rpc('api_settings_get', {}));
    const j = await rpc('api_journal_list', { limit: 30 });
    state.journal = Array.isArray(j) ? j : [];
  } catch (e) {
    clear(refs.body);
    refs.body.appendChild(h('div', { class: 'empty', style: { padding: '30px' } },
      trf('Не удалось загрузить подключения: {msg}', { msg: tr(e.message) })));
    return;
  }
  paint();
}
// После изменения: перечитать и обновить window.CLINIC — «Компания» по нему
// ставит звёздочки адреса для партнёров (решение владельца 11).
async function changed() {
  await reload();
  refreshClinicBrand(supabase).catch(() => {});
}
const openCard = (c, tab = 'main') => openConnectionCard({ settings: state.s, connection: c, onChanged: changed, onNavigate: refs.onNavigate, tab });

function paint() {
  clear(refs.body);
  const s = state.s;
  if (s.building_role === 'secondary') {
    refs.body.appendChild(h('p', { class: 'apic-note', role: 'note' }, Icon('Building', { size: 16 }),
      h('span', null, 'Подключения API настраиваются в главном здании клиники.')));
    return;
  }
  refs.body.appendChild(addressCard(s));
  refs.body.appendChild(connectionsCard(s));
  refs.body.appendChild(journalCard());
}

// ---- адрес клиники для подключений ---------------------------------------------------
function addressCard(s) {
  const body = h('div', { class: 'apic-body' });
  if (!s.slug || state.editSlug) body.appendChild(slugEditor(s));
  else {
    const copy = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'copy-url' }, Icon('Copy', { size: 13 }), ' ', 'Скопировать');
    copy.addEventListener('click', () => copyText(s.base_url));
    const edit = s.can.admin
      ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-apic-act': 'slug-edit' }, Icon('Edit', { size: 13 }), ' ', 'Изменить имя')
      : null;
    if (edit) edit.addEventListener('click', () => { state.editSlug = true; paint(); });
    body.appendChild(h('div', { class: 'apic-row' },
      h('span', { class: 'apic-url cell-mono', translate: 'no' }, Icon('Lock', { size: 14 }), ' ', s.base_url), copy, edit));
  }
  if (s.partner_address_missing.length) {
    body.appendChild(addressBlock('Адрес для партнёров в «Компании» не заполнен: пока его нет, подключения нельзя включить.', refs.onNavigate));
  }
  const fact = (icon, dt, dd) => h('div', null, h('dt', null, dt), h('dd', null, Icon(icon, { size: 15 }), h('span', null, dd)));
  body.appendChild(h('dl', { class: 'apic-facts' },
    fact('Shield', 'Защита', 'Только HTTPS, у каждого подключения свой ключ'),
    fact('Warning', 'Публичный сервер', 'Ещё не включён. Ключи можно выпустить и передать заранее: подключения начнут получать данные и присылать заявки, когда в Easy-Med включат публичный сервер.'),
    fact('Send', 'Заявки и записи', 'Будут приходить в CRM «Заявки» с источником своего подключения')));
  body.appendChild(h('p', { class: 'apic-note' }, Icon('Info', { size: 16 }), h('span', null, PRIVACY)));
  return h('section', { class: 'card apic-card', 'data-apic': 'address' },
    h('div', { class: 'card-header' }, h('h3', null, Icon('Globe', { size: 18 }), ' ', 'Адрес клиники для подключений'),
      h('span', { class: 'grow' }), Tag('Ещё не работает', { kind: 'warn', dot: true })),
    body);
}
function slugEditor(s) {
  if (!s.can.admin) return h('p', { class: 'hint' }, 'Имя клиники в адресе ещё не задано — его задаёт администратор.');
  const input = h('input', { type: 'text', id: 'apic-slug', autocomplete: 'off', spellcheck: 'false', translate: 'no', maxlength: '40' });
  input.value = s.slug || s.slug_suggestion || '';
  const err = h('div', { class: 'apic-err', role: 'alert' });
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-apic-act': 'slug-save' }, 'Сохранить');
  save.addEventListener('click', async () => {
    const v = normalizeSlug(input.value);
    const p = slugProblem(v);
    err.textContent = p ? tr(p) : '';
    if (p) return;
    try {
      const r = await rpc('api_slug_save', { slug: v });
      state.editSlug = false;
      toast(tr(r && r.site_created ? 'Адрес сохранён. Подключение «Сайт клиники» создано выключенным — его ключ в карточке подключения.' : 'Адрес сохранён.'), 'success');
      await changed();
    } catch (e) { err.textContent = tr(e.message); }
  });
  const cancel = s.slug ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { state.editSlug = false; paint(); } }, 'Отмена') : null;
  return h('div', { class: 'apic-slug' },
    h('div', { class: 'field' },
      h('label', { for: 'apic-slug' }, 'Короткое имя клиники в адресе'),
      h('div', { class: 'apic-prefix' }, h('span', { translate: 'no' }, 'https://' + API_HOST + '/'), input, h('span', { translate: 'no' }, '/v1/')),
      h('div', { class: 'hint' }, 'Латинские буквы, цифры и дефис, от 3 до 40 знаков. Занято ли имя другой клиникой, проверит публичный сервер, когда его включат.'),
      s.slug && s.connections.length ? h('div', { class: 'hint apic-warn' }, 'Адрес уже передан подключениям: после смены сообщите им новый.') : null,
      err),
    h('div', { class: 'apic-row' }, save, cancel));
}

// ---- подключения ---------------------------------------------------------------------
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const hostPath = (u) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };
function connectionsCard(s) {
  const add = s.can.admin
    ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', 'data-apic-act': 'conn-new', disabled: !s.slug },
        Icon('Plus', { size: 14 }), ' ', 'Добавить подключение')
    : null;
  if (add) add.addEventListener('click', () => openNewConnection({ settings: s, onCreated: changed, onNavigate: refs.onNavigate }));
  const body = h('div', { class: 'apic-body' });
  if (s.can.admin && !s.slug) body.appendChild(h('p', { class: 'hint' }, 'Сначала задайте короткое имя клиники в адресе API.'));
  if (!s.can.admin) body.appendChild(h('p', { class: 'hint' }, 'Новое подключение создаёт администратор: вместе с ним выпускается ключ.'));
  if (!s.connections.length) {
    body.appendChild(h('div', { class: 'empty' }, 'Подключений пока нет.'));
  } else {
    const tb = h('tbody');
    for (const c of s.connections) tb.appendChild(connRow(c, s));
    body.appendChild(h('div', { class: 'apic-tblwrap' }, h('table', { class: 'tbl apic-tbl' },
      h('thead', null, h('tr', null, ...['Подключение', 'Ключ', 'Что разрешено', 'Источник в CRM', 'Уведомления', 'Последний запрос', 'Статус']
        .map((t) => h('th', null, t)))), tb)));
    body.appendChild(h('p', { class: 'hint' }, 'Нажмите на строку, чтобы открыть подключение.'));
  }
  return h('section', { class: 'card apic-card', 'data-apic': 'connections' },
    h('div', { class: 'card-header' }, h('h3', null, Icon('Key', { size: 18 }), ' ', 'Подключения и ключи'), h('span', { class: 'grow' }), add),
    body);
}
function keyCell(c, s) {
  if (!s.can.admin) return h('span', { class: 'muted' }, 'Скрыт');
  const btn = h('button', { class: 'apic-ibtn', type: 'button', 'aria-label': 'Скопировать ключ', title: 'Скопировать ключ', 'data-apic-act': 'copy-key' },
    Icon('Copy', { size: 14 }));
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await rpc('api_connection_reveal', { id: c.id, what: 'key' });
      // Буфера нет — карточка на вкладке «Ключ»: там значение выделяется для Ctrl+C.
      if (!(await copyText(r.value))) openCard(c, 'key');
    } catch (err) { toast(tr(err.message), 'fail'); }
  });
  return h('span', { class: 'apic-nowrap' }, h('span', { class: 'cell-mono', translate: 'no' }, c.key_mask), ' ', btn);
}
function connRow(c, s) {
  const K = KIND_INFO[c.kind] || KIND_INFO.partner;
  const where = c.kind === 'site' ? hostOf(s.company_website) : hostOf(c.site_url);
  const row = h('tr', { class: 'row-click', tabindex: '0', 'data-apic-conn': String(c.id) },
    h('td', null, h('div', { class: 'apic-who' },
      h('span', { class: 'apic-ico t-' + c.kind }, Icon(K.icon, { size: 18 })),
      h('div', null, h('div', { class: 'apic-name' }, c.name),
        h('span', { class: 'apic-sub' }, K.label,
          c.kind === 'site' ? [' · ', 'создано автоматически'] : null,
          where ? [' · ', h('span', { translate: 'no' }, where)] : null)))),
    h('td', null, keyCell(c, s)),
    h('td', null, permChips(c.scopes)),
    h('td', null, h('span', { class: 'apic-chip api' }, c.crm_source_label)),
    h('td', null, c.webhook_url
      ? [h('span', { class: 'cell-mono apic-small', translate: 'no' }, hostPath(c.webhook_url)),
         h('span', { class: 'apic-sub' }, trf('событий: {n}', { n: (c.webhook_events || []).length }))]
      : h('span', { class: 'muted' }, 'Не настроены')),
    h('td', null, c.last_used_at ? fmtDateTime(c.last_used_at) : h('span', { class: 'muted' }, 'ещё не было')),
    h('td', null, Tag(c.active ? 'Включено' : 'Выключено', { kind: c.active ? 'ok' : '', dot: true }), expiryTag(c)));
  row.addEventListener('click', () => openCard(c));
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(c); } });
  return row;
}

// ---- журнал изменений -------------------------------------------------------------------
function journalCard() {
  return h('section', { class: 'card apic-card', 'data-apic': 'journal' },
    h('div', { class: 'card-header' }, h('h3', null, Icon('Activity', { size: 18 }), ' ', 'Журнал изменений')),
    h('div', { class: 'apic-body' }, journalTable(state.journal),
      h('p', { class: 'hint' }, 'В журнале нет ключей и секретов — только кто, что и когда сделал.')));
}
```

- [ ] **Step 6: стили** — в конце `public/css/admin-views.css`:

```css
/* CLINIC_API_STEP7_V1 — «API и подключения» (views/api-*.js) и «Источники из API» в CRM-канбане. */
.apic-stack { display: grid; gap: 16px; }
.apic-body { padding: 16px 18px; display: grid; gap: 12px; }
.apic-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.apic-url { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; background: var(--ink-050, #f4f6f8); font-size: 13.5px; word-break: break-all; }
.apic-prefix { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.apic-prefix span { font-size: 13.5px; color: var(--ink-500); }
.apic-prefix input { flex: 1 1 160px; min-width: 0; }
.apic-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 0; }
.apic-facts dt { font-size: 12.5px; color: var(--ink-500); }
.apic-facts dd { margin: 2px 0 0; font-size: 13.5px; display: flex; gap: 6px; align-items: flex-start; }
.apic-note { display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--info-50); color: var(--ink-700); font-size: 13.5px; }
.apic-note.ok { background: var(--ok-50); }
.apic-note.warn { background: var(--warn-50); }
.apic-tblwrap { overflow-x: auto; border: 1px solid var(--ink-100); border-radius: 10px; }
.apic-tbl td, .apic-tbl th { vertical-align: top; }
.apic-who { display: flex; gap: 10px; align-items: flex-start; }
.apic-name { font-weight: 600; font-size: 13.5px; }
.apic-sub { display: block; font-size: 12.5px; color: var(--ink-500); }
.apic-small { font-size: 12.5px; }
.apic-nowrap { white-space: nowrap; }
.apic-ico { display: inline-grid; place-items: center; width: 34px; height: 34px; flex: 0 0 34px; border-radius: 9px; background: var(--ink-100); color: var(--ink-700); }
.apic-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.apic-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px; background: var(--ink-100); font-size: 12.5px; }
.apic-chip.w { background: var(--primary-50, #e4f3f1); color: var(--primary-700); }
.apic-chip.ro { background: transparent; border: 1px dashed var(--ink-200); color: var(--ink-500); }
.apic-chip.api { background: var(--info-50); color: var(--info-700); }
.apic-ibtn { border: 0; background: transparent; cursor: pointer; padding: 4px; border-radius: 6px; color: var(--ink-500); }
.apic-ibtn:hover { background: var(--ink-100); color: var(--ink-900); }
.apic-ibtn:focus-visible, .apic-kind:focus-visible { outline: 2px solid var(--primary-600); outline-offset: 2px; }
.apic-keyfield { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.apic-secret { flex: 1 1 260px; min-width: 0; font-size: 13.5px; }
.apic-readonly { padding: 6px 10px; border-radius: 8px; background: var(--ink-050, #f4f6f8); font-size: 13.5px; }
.apic-sec { display: grid; gap: 10px; padding: 14px 0; border-top: 1px solid var(--ink-100); }
.apic-sec:first-child { border-top: 0; padding-top: 0; }
.apic-sec-title { margin: 0; font-size: 15px; }
.apic-sec-sub { margin-left: 8px; font-size: 12.5px; font-weight: 400; color: var(--ink-500); }
.apic-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.apic-checks { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
.apic-check { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; padding: 8px 10px; border: 1px solid var(--ink-100); border-radius: 10px; cursor: pointer; }
.apic-check input { grid-row: span 2; margin-top: 2px; }
.apic-check b { font-size: 13.5px; }
.apic-check span { font-size: 12.5px; color: var(--ink-500); }
.apic-kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.apic-kind { display: flex; gap: 10px; align-items: flex-start; text-align: left; padding: 10px 12px; border: 1px solid var(--ink-200); border-radius: 10px; background: var(--white); cursor: pointer; font: inherit; }
.apic-kind[aria-checked="true"] { border-color: var(--primary-600); box-shadow: 0 0 0 1px var(--primary-600); }
.apic-kind[disabled] { cursor: default; opacity: .6; }
.apic-err { font-size: 12.5px; color: var(--crit-700); }
.apic-warn { color: var(--warn-700); }
.apic-src { margin: 0; font-size: 13.5px; color: var(--ink-700); }
.apic-kv { display: grid; grid-template-columns: minmax(120px, 180px) 1fr; gap: 6px 12px; margin: 0; font-size: 13.5px; }
.apic-kv dt { color: var(--ink-500); }
.apic-kv dd { margin: 0; }
.apic-confirm { display: grid; gap: 8px; padding: 12px; border: 1px solid #fecaca; background: var(--crit-50); border-radius: 10px; font-size: 13.5px; }
.apic-confirm p { margin: 0; }
.apic-handover { width: 100%; min-height: 120px; font-size: 12.5px; }
.apic-tabs { padding: 0 18px; overflow-x: auto; }
@media (max-width: 640px) {
  .apic-kv { grid-template-columns: 1fr; }
  .apic-body { padding: 12px; }
}
```

- [ ] **Step 7: словарь** (есть: «Показать», «Скрыть», «Отмена», «Сохранить», «Загрузка…», «Скопировано», «Скопируйте вручную», «Не удалось выполнить запрос.», «Включено», «Выключено», «Когда», «Кто», «Название», «Подключение», «Только просмотр»):

| ru | uz | en |
|---|---|---|
| API и подключения | API va ulanishlar | API and connections |
| Сайт клиники, Symptex и партнёры получают отсюда врачей, свободное время, услуги и цены. Заявки и записи пациентов приходят в CRM с источником своего подключения. | Klinika sayti, Symptex va hamkorlar bu yerdan shifokorlar, bo‘sh vaqt, xizmatlar va narxlarni oladi. Bemorlarning arizalari va yozilishlari CRMga o‘z ulanishi manbasi bilan keladi. | The clinic website, Symptex and partners get doctors, free slots, services and prices from here. Patient requests and bookings arrive in the CRM with their connection’s source. |
| Данные пациентов наружу не передаются. Подключения видят только то, что клиника публикует: профиль клиники, врачей, свободное время, услуги и пакеты. Если лицензия Easy-Med закончится, сайт и партнёры перестанут получать данные и отправлять заявки, пока её не продлят. | Bemorlar ma’lumotlari tashqariga uzatilmaydi. Ulanishlar faqat klinika e’lon qilganini ko‘radi: klinika profili, shifokorlar, bo‘sh vaqt, xizmatlar va paketlar. Easy-Med litsenziyasi tugasa, sayt va hamkorlar u uzaytirilguncha ma’lumot olmaydi va ariza yubormaydi. | Patient data is never sent out. Connections see only what the clinic publishes: the clinic profile, doctors, free slots, services and packages. If the Easy-Med licence ends, the website and partners stop getting data and sending requests until it is renewed. |
| Подключения API настраиваются в главном здании клиники. (задача 8) | | |
| Не удалось загрузить подключения: {msg} | Ulanishlarni yuklab bo‘lmadi: {msg} | Could not load the connections: {msg} |
| Адрес клиники для подключений | Ulanishlar uchun klinika manzili | The clinic’s address for connections |
| Ещё не работает | Hali ishlamaydi | Not working yet |
| Скопировать | Nusxalash | Copy |
| Изменить имя | Nomni o‘zgartirish | Change the name |
| Адрес для партнёров в «Компании» не заполнен: пока его нет, подключения нельзя включить. | «Kompaniya»da hamkorlar uchun manzil to‘ldirilmagan: u bo‘lmaguncha ulanishlarni yoqib bo‘lmaydi. | The partner address in “Company” is not filled in: until it is, connections cannot be switched on. |
| Открыть «Компанию» | «Kompaniya»ni ochish | Open “Company” |
| Защита | Himoya | Protection |
| Только HTTPS, у каждого подключения свой ключ | Faqat HTTPS, har bir ulanishning o‘z kaliti bor | HTTPS only, each connection has its own key |
| Публичный сервер | Ommaviy server | Public server |
| Ещё не включён. Ключи можно выпустить и передать заранее: подключения начнут получать данные и присылать заявки, когда в Easy-Med включат публичный сервер. | Hali yoqilmagan. Kalitlarni oldindan chiqarib, topshirish mumkin: Easy-Med ommaviy serverni yoqqanda ulanishlar ma’lumot olib, ariza yuborishni boshlaydi. | Not switched on yet. Keys can be issued and handed over in advance: connections will start getting data and sending requests once Easy-Med switches the public server on. |
| Заявки и записи | Arizalar va yozilishlar | Requests and bookings |
| Будут приходить в CRM «Заявки» с источником своего подключения | CRM «Arizalar»ga o‘z ulanishi manbasi bilan keladi | Will arrive in CRM “Requests” with their connection’s source |
| Имя клиники в адресе ещё не задано — его задаёт администратор. | Manzildagi klinika nomi hali kiritilmagan — uni administrator kiritadi. | The clinic name in the address is not set yet — the administrator sets it. |
| Адрес сохранён. Подключение «Сайт клиники» создано выключенным — его ключ в карточке подключения. | Manzil saqlandi. «Klinika sayti» ulanishi o‘chirilgan holda yaratildi — uning kaliti ulanish kartochkasida. | Address saved. The “Clinic website” connection was created switched off — its key is in the connection card. |
| Адрес сохранён. | Manzil saqlandi. | Address saved. |
| Короткое имя клиники в адресе | Manzildagi klinikaning qisqa nomi | The clinic’s short name in the address |
| Латинские буквы, цифры и дефис, от 3 до 40 знаков. Занято ли имя другой клиникой, проверит публичный сервер, когда его включат. | Lotin harflari, raqamlar va chiziqcha, 3 dan 40 gacha belgi. Nom boshqa klinika tomonidan band emasligini ommaviy server yoqilganda tekshiradi. | Latin letters, digits and hyphens, 3 to 40 characters. Whether another clinic has taken the name is checked by the public server once it is on. |
| Адрес уже передан подключениям: после смены сообщите им новый. | Manzil ulanishlarga berilgan: o‘zgartirgandan keyin ularga yangisini xabar qiling. | The address has already been given to connections: after changing it, tell them the new one. |
| Добавить подключение | Ulanish qo‘shish | Add a connection |
| Сначала задайте короткое имя клиники в адресе API. (задача 6) | | |
| Новое подключение создаёт администратор: вместе с ним выпускается ключ. | Yangi ulanishni administrator yaratadi: u bilan birga kalit chiqariladi. | A new connection is created by the administrator: a key is issued with it. |
| Подключений пока нет. | Hozircha ulanishlar yo‘q. | No connections yet. |
| Подключения и ключи | Ulanishlar va kalitlar | Connections and keys |
| Ключ (есть) | | |
| Что разрешено | Nimaga ruxsat berilgan | What is allowed |
| Источник в CRM | CRMdagi manba | CRM source |
| Уведомления (есть) | | |
| Последний запрос | Oxirgi so‘rov | Last request |
| Статус (есть) | | |
| Нажмите на строку, чтобы открыть подключение. | Ulanishni ochish uchun qatorni bosing. | Click a row to open the connection. |
| Скрыт | Yashirin | Hidden |
| Скопировать ключ | Kalitni nusxalash | Copy the key |
| создано автоматически | avtomatik yaratilgan | created automatically |
| событий: {n} | hodisalar: {n} | events: {n} |
| Не настроены | Sozlanmagan | Not set up |
| ещё не было | hali bo‘lmagan | none yet |
| Ключ истёк | Kalit muddati tugagan | The key has expired |
| Ключ истекает {date} | Kalit muddati {date} tugaydi | The key expires on {date} |
| Журнал изменений | O‘zgarishlar jurnali | Change log |
| В журнале нет ключей и секретов — только кто, что и когда сделал. | Jurnalda kalitlar va sirlar yo‘q — faqat kim, nima va qachon qilgani. | The log holds no keys or secrets — only who did what and when. |
| Изменений пока не было. | Hozircha o‘zgarishlar bo‘lmagan. | No changes yet. |
| Что сделано | Nima qilindi | What was done |
| Изменено имя в адресе | Manzildagi nom o‘zgartirildi | Address name changed |
| Подключение создано | Ulanish yaratildi | Connection created |
| Настройки изменены | Sozlamalar o‘zgartirildi | Settings changed |
| Подключение включено | Ulanish yoqildi | Connection switched on |
| Подключение выключено | Ulanish o‘chirildi | Connection switched off |
| Ключ открыт | Kalit ochildi | Key opened |
| Выпущен новый ключ | Yangi kalit chiqarildi | New key issued |
| Секрет открыт | Sir ochildi | Secret opened |
| Выпущен новый секрет | Yangi sir chiqarildi | New secret issued |
| Подключение удалено | Ulanish o‘chirib tashlandi | Connection deleted |
| Адрес сайта | Sayt manzili | Website address |
| Контакт | Kontakt | Contact |
| Права | Huquqlar | Permissions |
| Адрес для уведомлений | Bildirishnomalar manzili | Notification address |
| События уведомлений | Bildirishnoma hodisalari | Notification events |
| Лимит запросов | So‘rovlar chegarasi | Request limit |
| Срок действия ключа | Kalitning amal qilish muddati | Key validity |
| Разрешённые IP-адреса | Ruxsat etilgan IP-manzillar | Allowed IP addresses |
| Все данные клиники | Klinikaning barcha ma’lumotlari | All clinic data |
| Кто подключается | Kim ulanmoqda | Who is connecting |
| Подключение сайта клиники уже есть — оно создаётся само. | Klinika sayti ulanishi allaqachon bor — u o‘zi yaratiladi. | The clinic website connection already exists — it is created automatically. |
| Например, med24.uz | Masalan, med24.uz | For example, med24.uz |
| Адрес — из «Компании», поле «Сайт»: меняется там. Если сайт делает Easy-Med, адрес подставится сам. | Manzil — «Kompaniya»dagi «Sayt» maydonidan: u yerda o‘zgartiriladi. Saytni Easy-Med qilsa, manzil o‘zi qo‘yiladi. | The address comes from “Company”, the “Website” field, and is changed there. If Easy-Med builds the website, the address fills in by itself. |
| Для справки: где подключение показывает клинику. | Ma’lumot uchun: ulanish klinikani qayerda ko‘rsatadi. | For reference: where the connection shows the clinic. |
| Имя, телефон или почта | Ism, telefon yoki pochta | Name, phone or email |
| Для заявок этого подключения в CRM появится свой источник с его названием. В настройках CRM его нельзя переименовать, скрыть или удалить. | Bu ulanish arizalari uchun CRMda uning nomi bilan o‘z manbasi paydo bo‘ladi. CRM sozlamalarida uni qayta nomlab, yashirib yoki o‘chirib bo‘lmaydi. | Requests from this connection get their own CRM source named after it. It cannot be renamed, hidden or deleted in the CRM settings. |
| Сайт партнёра | Hamkor sayti | Partner website |
| Контакт у партнёра | Hamkordagi kontakt | Partner contact |
| Кому звонить, если с подключением что-то не так. | Ulanishda muammo bo‘lsa, kimga qo‘ng‘iroq qilish kerak. | Whom to call if something is wrong with the connection. |
| Источник заявок в CRM | CRMdagi arizalar manbasi | CRM source of requests |
| Что можно получать | Nimalarni olish mumkin | What can be received |
| данные, которые видит подключение | ulanish ko‘radigan ma’lumotlar | data the connection sees |
| Что можно отправлять в клинику | Klinikaga nimalarni yuborish mumkin | What can be sent to the clinic |
| заявки и записи пациентов | bemorlarning arizalari va yozilishlari | patient requests and bookings |
| Уведомления о заявках (вебхук) | Arizalar haqida bildirishnomalar (vebxuk) | Request notifications (webhook) |
| Easy-Med сообщает подключению, что стало с его заявкой | Easy-Med ulanishga uning arizasi bilan nima bo‘lganini xabar qiladi | Easy-Med tells the connection what happened to its request |
| Пусто — уведомления не отправляем. Принимаем только https://. | Bo‘sh — bildirishnomalar yuborilmaydi. Faqat https:// qabul qilinadi. | Empty — no notifications are sent. Only https:// is accepted. |
| Проверить адрес | Manzilni tekshirish | Check the address |
| Пробное уведомление можно будет отправить, когда в Easy-Med включат публичный сервер. | Sinov bildirishnomasini Easy-Med ommaviy serverni yoqqanda yuborish mumkin bo‘ladi. | A test notification can be sent once Easy-Med switches the public server on. |
| Секрет для подписи уведомлений | Bildirishnomalarni imzolash uchun sir | Secret for signing notifications |
| Каждое уведомление будет подписано этим секретом (заголовок X-EasyMed-Signature): так подключение проверит, что уведомление пришло от клиники. | Har bir bildirishnoma shu sir bilan imzolanadi (X-EasyMed-Signature sarlavhasi): shunday qilib ulanish bildirishnoma klinikadan kelganini tekshiradi. | Each notification will be signed with this secret (the X-EasyMed-Signature header), so the connection can check it came from the clinic. |
| Если адрес не ответит | Manzil javob bermasa | If the address does not answer |
| Повторим 5 раз: через 1, 5, 10, 30 и 60 минут | 5 marta takrorlaymiz: 1, 5, 10, 30 va 60 daqiqadan keyin | We will retry 5 times: after 1, 5, 10, 30 and 60 minutes |
| Уведомления начнут уходить, когда в Easy-Med включат публичный сервер. | Bildirishnomalar Easy-Med ommaviy serverni yoqqanda yubori boshlaydi. | Notifications will start going out once Easy-Med switches the public server on. |
| Безопасность | Xavfsizlik | Security |
| Сверх лимита подключение получит ответ «429, подождите». | Chegaradan oshganda ulanish «429, kuting» javobini oladi. | Above the limit the connection gets the answer “429, wait”. |
| За 14 дней до конца срока здесь появится напоминание. | Muddat tugashiga 14 kun qolganda bu yerda eslatma paydo bo‘ladi. | A reminder appears here 14 days before the key expires. |
| По одному на строку | Har qatorda bittadan | One per line |
| Необязательно. Пусто — запросы с любого адреса, но только с ключом. | Ixtiyoriy. Bo‘sh — so‘rovlar istalgan manzildan, lekin faqat kalit bilan. | Optional. Empty — requests from any address, but only with the key. |
| Лимит, срок ключа и разрешённые адреса начнут действовать, когда в Easy-Med включат публичный сервер. Только HTTPS — всегда. | Chegara, kalit muddati va ruxsat etilgan manzillar Easy-Med ommaviy serverni yoqqanda kuchga kiradi. Faqat HTTPS — har doim. | The limit, key validity and allowed addresses take effect once Easy-Med switches the public server on. HTTPS only — always. |
| Состояние (есть) | | |
| Выключенное подключение не получает данные и не присылает заявки. Настройки сохраняются, включить можно в любой момент. | O‘chirilgan ulanish ma’lumot olmaydi va ariza yubormaydi. Sozlamalar saqlanadi, istalgan vaqtda yoqish mumkin. | A switched-off connection gets no data and sends no requests. The settings are kept, and it can be switched on at any time. |
| Адрес для партнёров в «Компании» не заполнен: подключение можно сохранить только выключенным. Заполните адрес и включите его. | «Kompaniya»da hamkorlar uchun manzil to‘ldirilmagan: ulanishni faqat o‘chirilgan holda saqlash mumkin. Manzilni to‘ldiring va uni yoqing. | The partner address in “Company” is not filled in: the connection can only be saved switched off. Fill in the address, then switch it on. |

  Строки задач 11–12 (окна) — в их таблицах; здесь — всё, что рисуют страница и `api-ui.js`.
- [ ] **Step 8:** тест зелёный. Последний тест (`payload`) проверяет только загрузку; полная проверка — в задаче 12. Сторожа:
  - `__tests__/i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `type-scale.test.mjs`;
  - `server/services/rpc/client-rpc-coverage.test.js`.
- [ ] **Step 9: коммит** `api-ui.js`, `api-connections.js`, заглушки `api-connection-new.js` и `api-connection-card.js`, `api-harness.mjs`, `api-connections.test.mjs`, `admin-views.css`, `i18n-strings.js`:
  «Настройки: экран «API и подключения» — адрес клиники для подключений, подключения с ключом, правами, источником CRM и уведомлениями, журнал изменений; честно о публичном сервере (CLINIC_API_STEP7_V1)».

---

## Task 11: Окно «Новое подключение» и окно «Что передать подключению» (CLINIC_API_STEP7_V1)

**Files:**
- Modify (заменить заглушку): `public/js/admin/views/api-connection-new.js`
- Create: `public/js/admin/__tests__/api-connection-new.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `public/js/admin/__tests__/api-connection-new.test.mjs`:

```js
// CLINIC_API_STEP7_V1 — «Новое подключение»: ключ и секрет из черновика сервера,
// «Сгенерировать новый», проверки полей до сервера, адрес для партнёров
// (решение владельца 11); «Что передать подключению» — «Скопировать всё».
import { test } from 'node:test';
import assert from 'node:assert';
import { reset, onRpc, calls, clip, textOf, byAttr, buttonByText, tick, modal, rpcNames, settingsFixture,
  KEY_VALUE, SECRET_VALUE } from './api-harness.mjs';

const { openNewConnection, handoverText } = await import('../views/api-connection-new.js');
const KEY2 = 'em_live_TESTONLYtestonlyTESTONLYtest2222';

function draftServer() {
  let n = 0;
  onRpc('api_connection_draft', (b) => (b && b.renew === 'key'
    ? { draft_id: 'd1', key: KEY2, secret: SECRET_VALUE }
    : { draft_id: 'd' + (++n), key: KEY_VALUE, secret: SECRET_VALUE }));
}
const field = (root, id) => byAttr(root, 'id', id)[0];
const type = (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); };

test('ключ и секрет — из черновика сервера; «Сгенерировать новый» — тот же черновик, новый ключ; сайт клиники не выбирается', async () => {
  reset(); draftServer();
  await openNewConnection({ settings: settingsFixture() });
  const m = modal('conn-new');
  assert.ok(m, 'окно не открылось');
  assert.ok(byAttr(m, 'aria-label', 'Ключ доступа')[0].value === KEY_VALUE);
  assert.ok('disabled' in byAttr(m, 'data-apic-kind', 'site')[0].attrs);
  byAttr(m, 'data-apic-act', 'regen')[0].click();
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'api_connection_draft').map((c) => c[1]), [{}, { draft_id: 'd1', renew: 'key' }]);
  assert.equal(byAttr(m, 'aria-label', 'Ключ доступа')[0].value, KEY2);
});

test('проверки до сервера: без названия, запись без «Свободного времени», http в уведомлениях — create не уходит', async () => {
  reset(); draftServer();
  await openNewConnection({ settings: settingsFixture() });
  const m = modal('conn-new');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.ok(textOf(m).includes('Введите название подключения.'));
  type(field(m, 'apic-f-name'), 'med24.uz');
  const slots = field(m, 'apic-read-slots');
  slots.checked = false; slots.dispatchEvent({ type: 'change' });
  type(field(m, 'apic-f-hook'), 'http://med24.uz/hook');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  const t = textOf(m);
  assert.ok(t.includes('Запись на приём требует права «Свободное время».'));
  assert.ok(t.includes('Обычный http не принимаем'));
  assert.ok(!rpcNames().includes('api_connection_create'));
});

test('создание: черновик называется, ключ не отправляется; окно «Что передать» — адрес, ключ, секрет и «Скопировать всё»', async () => {
  reset(); draftServer();
  let created = false;
  onRpc('api_connection_create', (b) => { created = b; return { connection: { ...settingsFixture().connections[1], id: 9, name: b.name }, key: KEY_VALUE, secret: SECRET_VALUE, base_url: 'https://api.easymed.uz/klinika-demo/v1/' }; });
  await openNewConnection({ settings: settingsFixture(), onCreated: () => {} });
  const m = modal('conn-new');
  type(field(m, 'apic-f-name'), 'med24.uz');
  type(field(m, 'apic-f-hook'), 'https://med24.uz/hooks/easymed');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.equal(created.draft_id, 'd1');
  assert.ok(!('key' in created) && !('secret' in created), 'ключ ушёл на сервер из браузера');
  assert.equal(created.kind, 'partner');
  assert.equal(created.active, 1);
  assert.ok(!modal('conn-new'), 'окно создания не закрылось');
  const h = modal('conn-key');
  assert.ok(h, 'нет окна «Что передать»');
  for (const s of ['https://api.easymed.uz/klinika-demo/v1/', 'Authorization: Bearer <ключ>', 'с источником «med24.uz»']) assert.ok(textOf(h).includes(s) || byAttr(h, 'aria-label').some((n) => n.value === s), s);
  buttonByText(h, /Скопировать всё/).click();
  await tick();
  assert.ok(clip[0].includes(KEY_VALUE) && clip[0].includes(SECRET_VALUE) && clip[0].includes('https://api.easymed.uz/klinika-demo/v1/'));
});

test('адрес для партнёров не заполнен: «Подключение включено» снято; включённое — отказ сервера с «Открыть «Компанию»»', async () => {
  reset(); draftServer();
  const nav = [];
  onRpc('api_connection_create', () => ({ __error: { code: 'partner_address_required',
    message: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.' }, status: 409 }));
  await openNewConnection({ settings: settingsFixture({ partner_address_missing: ['street_ru'] }), onNavigate: (v) => nav.push(v) });
  const m = modal('conn-new');
  assert.ok(textOf(m).includes('можно сохранить только выключенным'));
  const active = field(m, 'apic-f-active');
  active.checked = true; active.dispatchEvent({ type: 'change' });
  type(field(m, 'apic-f-name'), 'med24.uz');
  buttonByText(m, /Создать подключение и ключ/).click();
  await tick();
  assert.ok(textOf(m).includes('Подключение нельзя включить'));
  buttonByText(m, /Открыть «Компанию»/).click();
  assert.deepEqual(nav, ['documents-settings']);
});

test('текст «Скопировать всё»: секрет — только когда задан адрес уведомлений', () => {
  const base = { clinic: 'Клиника Демо', baseUrl: 'https://api.easymed.uz/klinika-demo/v1/', key: KEY_VALUE, scopes: ['clinic', 'requests'] };
  const withHook = handoverText({ ...base, secret: SECRET_VALUE });
  const without = handoverText({ ...base, secret: '' });
  assert.ok(withHook.includes(SECRET_VALUE) && !without.includes(SECRET_VALUE));
  assert.ok(withHook.includes('Разрешено: О клинике, Заявки'));
  assert.ok(withHook.includes('публичный сервер'));
});
```

- [ ] **Step 2:** запуск → падает (заглушка).
- [ ] **Step 3: модуль** `public/js/admin/views/api-connection-new.js`:

```js
// CLINIC_API_STEP7_V1 — окна «Новое подключение» и «Что передать подключению»
// (макет screen-api.js: conn-new, conn-key).
//
// Ключ и секрет вебхука видны ещё до создания — их выпускает сервер
// (api_connection_draft, черновик на 30 минут), «Сгенерировать новый» просит
// новый у того же черновика. При создании браузер называет черновик и НЕ
// присылает ключ: значение берёт сервер (Р6 плана). Проверки полей — те же, что
// у сервера (shared/api-connections.js), до запроса. После «Создать» — окно
// «Что передать подключению» с «Скопировать всё».
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { DEFAULTS, READ_SCOPES, WRITE_SCOPES, SCOPE_INFO, normalizeConnection, connectionProblems } from '../../shared/api-connections.js';
import { rpc, secretField, section, fieldBox, kindPicker, basicsFields, accessSections, hooksSection, securityFields,
  activeField, openModal, addressBlock, permChips, copyText } from './api-ui.js';

const KEY_HINT = 'Ключ создан сам. Скопируйте его и передайте вместе с адресом API. Он сохранится, когда вы нажмёте «Создать подключение и ключ»; позже его можно открыть в карточке подключения — видят его только администраторы.';
const defaultsOf = (k) => { const d = DEFAULTS[k] || DEFAULTS.partner; return { scopes: [...d.scopes], webhook_events: [...d.events], rate_limit: d.rate_limit, key_ttl: d.key_ttl }; };

export async function openNewConnection({ settings, onCreated = null, onNavigate = null }) {
  let draft;
  try { draft = await rpc('api_connection_draft', {}); } catch (e) { toast(tr(e.message), 'fail'); return null; }
  const ready = settings.partner_address_missing.length === 0;
  const d = { kind: 'partner', name: '', site_url: '', contact: '', webhook_url: '', ip_allow: '', active: ready, ...defaultsOf('partner') };
  let errs = {};
  let fail = '';   // отказ сервера «нет адреса для партнёров» — с дорогой в «Компанию»
  let m = null;
  const keyBox = secretField({ label: 'Ключ доступа', value: draft.key, regen: { label: 'Сгенерировать новый', onClick: () => renew('key') } });
  const secretBox = secretField({ label: 'Секрет для подписи уведомлений', value: draft.secret, regen: { label: 'Новый секрет', onClick: () => renew('secret') } });
  const body = h('div', { class: 'modal-body apic-modal-body' });

  async function renew(what) {
    try {
      draft = await rpc('api_connection_draft', { draft_id: draft.draft_id, renew: what });
      keyBox.setValue(draft.key);
      secretBox.setValue(draft.secret);
      toast(tr(what === 'key' ? 'Новый ключ сгенерирован' : 'Новый секрет сгенерирован'), 'ok');
    } catch (e) { toast(tr(e.message), 'fail'); }
  }
  function paint() {
    clear(body);
    if (fail) body.appendChild(addressBlock(fail, onNavigate, () => m.close()));
    body.appendChild(section('Кто подключается', '', kindPicker(d.kind, (k) => { Object.assign(d, { kind: k }, defaultsOf(k)); paint(); })));
    body.appendChild(section('Основное', '', basicsFields(d, errs, { isNew: true })));
    body.appendChild(section('Ключ доступа', 'подключение передаёт его в каждом запросе', keyBox, h('p', { class: 'hint' }, KEY_HINT)));
    body.appendChild(accessSections(d, errs));
    body.appendChild(hooksSection(d, errs, { secretEl: secretBox }));
    body.appendChild(securityFields(d, errs));
    body.appendChild(activeField(d, { ready }));
  }
  const createBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'create' },
    Icon('Key', { size: 15 }), ' ', 'Создать подключение и ключ');
  createBtn.addEventListener('click', async () => {
    const v = normalizeConnection({ kind: d.kind, name: d.name, site_url: d.site_url, contact: d.contact, scopes: d.scopes,
      webhook_url: d.webhook_url, webhook_events: d.webhook_events, rate_limit: d.rate_limit, key_ttl: d.key_ttl,
      ip_allow: d.ip_allow, active: d.active });
    errs = connectionProblems(v);
    fail = '';
    paint();
    if (Object.keys(errs).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
    createBtn.disabled = true;
    try {
      const r = await rpc('api_connection_create', { draft_id: draft.draft_id, ...v });
      m.close();
      openHandover({ settings, connection: r.connection, key: r.key, secret: r.secret, baseUrl: r.base_url });
      if (onCreated) onCreated();
    } catch (e) {
      createBtn.disabled = false;
      if (e.code === 'partner_address_required') { fail = e.message; d.active = false; paint(); return; }
      toast(tr(e.message), 'fail');
    }
  });
  paint();
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Отмена');
  m = openModal({ name: 'conn-new', title: [Icon('Plus', { size: 18 }), ' ', tr('Новое подключение')], body,
    foot: [cancel, h('span', { class: 'grow' }), createBtn] });
  cancel.addEventListener('click', () => m.close());
  return m;
}

/** Текст «Скопировать всё»: одним сообщением всё, что нужно подключению. */
export function handoverText({ clinic, baseUrl, key, secret, scopes }) {
  const allowed = [...READ_SCOPES, ...WRITE_SCOPES].filter((k) => (scopes || []).includes(k)).map((k) => tr(SCOPE_INFO[k].label));
  const lines = [trf('Подключение к API клиники «{clinic}»', { clinic }), trf('Адрес API: {url}', { url: baseUrl })];
  if (key) lines.push(trf('Ключ: {key}', { key }));
  lines.push(tr('Передавайте ключ в каждом запросе: Authorization: Bearer <ключ>'));
  if (secret) lines.push(trf('Секрет для проверки уведомлений: {secret}', { secret }));
  lines.push(trf('Разрешено: {list}', { list: allowed.join(', ') }));
  lines.push(tr('Работать начнёт, когда в Easy-Med включат публичный сервер.'));
  return lines.join('\n');
}

/** «Что передать подключению» — после создания и после выпуска нового ключа. */
export function openHandover({ settings, connection: c, key, secret = '', baseUrl, rotated = false }) {
  const withSecret = !!(secret && c.webhook_url);
  const text = handoverText({ clinic: settings.clinic_name, baseUrl, key, secret: withSecret ? secret : '', scopes: c.scopes });
  const area = h('textarea', { class: 'apic-handover cell-mono', readonly: 'readonly', rows: '7', translate: 'no', 'aria-label': 'Текст для отправки' });
  area.value = text;
  const lead = rotated
    ? 'Новый ключ сохранён, прежний больше не подходит. Отправьте подключению новый ключ — проще всего кнопкой «Скопировать всё».'
    : 'Ключ сохранён. Отправьте подключению адрес и ключ — проще всего кнопкой «Скопировать всё». Работать они начнут, когда в Easy-Med включат публичный сервер.';
  const body = h('div', { class: 'modal-body apic-modal-body' },
    h('p', { class: 'apic-note ok' }, Icon('Check', { size: 16 }), h('span', null, lead)),
    fieldBox('Адрес API', secretField({ label: 'Адрес API', value: baseUrl }), null, null),
    fieldBox('Ключ', secretField({ label: 'Ключ', value: key }), null, null),
    withSecret ? fieldBox('Секрет для проверки уведомлений', secretField({ label: 'Секрет для проверки уведомлений', value: secret }), null, null) : null,
    section('Что ещё знать', '', h('dl', { class: 'apic-kv' },
      h('dt', null, 'Разрешено'), h('dd', null, permChips(c.scopes)),
      h('dt', null, 'Заявки в CRM'), h('dd', null, trf('с источником «{label}»', { label: c.crm_source_label })),
      h('dt', null, 'Как передавать ключ'), h('dd', null, h('code', { translate: 'no' }, 'Authorization: Bearer <ключ>')),
      h('dt', null, 'Ключ потом'), h('dd', null, 'Его можно открыть и скопировать в карточке подключения, вкладка «Ключ».'))),
    fieldBox('Текст для отправки', area, null, null));
  const copyAll = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'copy-all' }, Icon('Copy', { size: 15 }), ' ', 'Скопировать всё');
  copyAll.addEventListener('click', async () => {
    if (!(await copyText(text))) { try { area.focus(); area.select(); } catch { /* выделение — удобство */ } }
  });
  const close = h('button', { class: 'btn', type: 'button' }, 'Закрыть');
  const m = openModal({ name: 'conn-key', width: 680, body,
    title: [Icon('Key', { size: 18 }), ' ', rotated ? trf('Новый ключ для «{name}»', { name: c.name }) : trf('Подключение «{name}» создано', { name: c.name })],
    foot: [close, h('span', { class: 'grow' }), copyAll] });
  close.addEventListener('click', () => m.close());
  return m;
}
```

- [ ] **Step 4: словарь** (есть: «Отмена», «Закрыть», «Ключ», «Проверьте выделенные поля.»):

| ru | uz | en |
|---|---|---|
| Новое подключение | Yangi ulanish | New connection |
| Ключ доступа | Kirish kaliti | Access key |
| подключение передаёт его в каждом запросе | ulanish uni har bir so‘rovda yuboradi | the connection sends it with every request |
| Ключ создан сам. Скопируйте его и передайте вместе с адресом API. Он сохранится, когда вы нажмёте «Создать подключение и ключ»; позже его можно открыть в карточке подключения — видят его только администраторы. | Kalit o‘zi yaratildi. Uni nusxalab, API manzili bilan birga topshiring. «Ulanish va kalit yaratish»ni bosganingizda saqlanadi; keyin uni ulanish kartochkasida ochish mumkin — uni faqat administratorlar ko‘radi. | The key was generated for you. Copy it and hand it over together with the API address. It is saved when you press “Create connection and key”; later it can be opened in the connection card — only administrators see it. |
| Сгенерировать новый | Yangisini yaratish | Generate a new one |
| Новый секрет | Yangi sir | New secret |
| Новый ключ сгенерирован | Yangi kalit yaratildi | A new key was generated |
| Новый секрет сгенерирован | Yangi sir yaratildi | A new secret was generated |
| Создать подключение и ключ | Ulanish va kalit yaratish | Create connection and key |
| Основное (есть) | | |
| Подключение к API клиники «{clinic}» | «{clinic}» klinikasi API’siga ulanish | Connection to the API of the clinic “{clinic}” |
| Адрес API: {url} | API manzili: {url} | API address: {url} |
| Ключ: {key} | Kalit: {key} | Key: {key} |
| Передавайте ключ в каждом запросе: Authorization: Bearer <ключ> | Kalitni har bir so‘rovda yuboring: Authorization: Bearer <kalit> | Send the key with every request: Authorization: Bearer <key> |
| Секрет для проверки уведомлений: {secret} | Bildirishnomalarni tekshirish uchun sir: {secret} | Secret for checking notifications: {secret} |
| Разрешено: {list} | Ruxsat etilgan: {list} | Allowed: {list} |
| Работать начнёт, когда в Easy-Med включат публичный сервер. | Easy-Med ommaviy serverni yoqqanda ishlay boshlaydi. | It will start working once Easy-Med switches the public server on. |
| Текст для отправки | Yuborish uchun matn | Text to send |
| Новый ключ сохранён, прежний больше не подходит. Отправьте подключению новый ключ — проще всего кнопкой «Скопировать всё». | Yangi kalit saqlandi, avvalgisi endi yaroqsiz. Ulanishga yangi kalitni yuboring — eng osoni «Hammasini nusxalash» tugmasi. | The new key is saved and the old one no longer works. Send the connection the new key — the “Copy all” button is easiest. |
| Ключ сохранён. Отправьте подключению адрес и ключ — проще всего кнопкой «Скопировать всё». Работать они начнут, когда в Easy-Med включат публичный сервер. | Kalit saqlandi. Ulanishga manzil va kalitni yuboring — eng osoni «Hammasini nusxalash» tugmasi. Ular Easy-Med ommaviy serverni yoqqanda ishlay boshlaydi. | The key is saved. Send the connection the address and the key — the “Copy all” button is easiest. They will start working once Easy-Med switches the public server on. |
| Адрес API | API manzili | API address |
| Секрет для проверки уведомлений | Bildirishnomalarni tekshirish uchun sir | Secret for checking notifications |
| Что ещё знать | Yana nimani bilish kerak | Good to know |
| Разрешено | Ruxsat etilgan | Allowed |
| Заявки в CRM | CRMdagi arizalar | Requests in the CRM |
| с источником «{label}» | «{label}» manbasi bilan | with the source “{label}” |
| Как передавать ключ | Kalitni qanday yuborish kerak | How to send the key |
| Authorization: Bearer <ключ> | Authorization: Bearer <kalit> | Authorization: Bearer <key> |
| Ключ потом | Kalit keyinroq | The key later |
| Его можно открыть и скопировать в карточке подключения, вкладка «Ключ». | Uni ulanish kartochkasida, «Kalit» yorlig‘ida ochib nusxalash mumkin. | It can be opened and copied in the connection card, on the “Key” tab. |
| Скопировать всё | Hammasini nusxalash | Copy all |
| Новый ключ для «{name}» | «{name}» uchun yangi kalit | New key for “{name}” |
| Подключение «{name}» создано | «{name}» ulanishi yaratildi | Connection “{name}” created |

- [ ] **Step 5:** тест зелёный. Сторожа: `api-connections.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `type-scale.test.mjs`, `server/services/rpc/client-rpc-coverage.test.js`, `server/services/api/no-real-api-keys.test.js`.
- [ ] **Step 6: коммит** «API и подключения: окно «Новое подключение» — ключ и секрет выпускает сервер, проверки до отправки, адрес для партнёров; окно «Что передать подключению» со «Скопировать всё» (CLINIC_API_STEP7_V1)».

---

## Task 12: Карточка подключения — вкладки, включение, ключ и секрет, удаление (CLINIC_API_STEP7_V1)

**Files:**
- Modify (заменить заглушку): `public/js/admin/views/api-connection-card.js`
- Create: `public/js/admin/__tests__/api-connection-card.test.mjs`
- Modify: `public/js/admin/__tests__/api-connections.test.mjs` (последний тест — полностью)
- Modify: `public/js/admin/i18n-strings.js`

Вкладки (макет `CONN_TABS`): Основное · Доступ · Уведомления · Ключ · Журнал.
- **Основное:** «Подключение включено», тип и «Создано», название, сайт, контакт, источник, безопасность, удаление.
- **Доступ:** права.
- **Уведомления:** адрес, события, секрет, «Последние уведомления» (пусто до шага 8).
- **Ключ:** маска, «Показать» / «Скопировать», выпущен, действует до, последний запрос, как передавать, «Выпустить новый ключ».
- **Журнал:** «Запросы с этим ключом» (пусто до шага 8) и «Изменения настроек».

- [ ] **Step 1: падающий тест** `public/js/admin/__tests__/api-connection-card.test.mjs`:

```js
// CLINIC_API_STEP7_V1 — карточка подключения: только изменённое; уровни
// (`can`); ключ и секрет — показать, выпустить новый с подтверждением;
// удаление с подтверждением; журнал — запросы (шаг 8) и изменения.
import { test } from 'node:test';
import assert from 'node:assert';
import { reset, onRpc, calls, textOf, byAttr, buttonByText, tick, modal, rpcNames, settingsFixture, KEY_VALUE } from './api-harness.mjs';

const { openConnectionCard } = await import('../views/api-connection-card.js');
const KEY2 = 'em_live_TESTONLYtestonlyTESTONLYtest2222';
const S = settingsFixture();
const P = S.connections[1];
function open(over = {}, conn = P, tab = 'main') {
  const changed = [];
  openConnectionCard({ settings: settingsFixture(over), connection: conn, onChanged: () => changed.push(1), onNavigate: () => {}, tab });
  return { m: modal('conn'), changed };
}
const tabBtn = (m, k) => byAttr(m, 'data-apic-tab', k)[0];
const sent = (name) => calls.filter((c) => c[0] === name).map((c) => c[1]);

test('сохранение шлёт только изменённое: выключить — {id, active:false}; переименовать — {id, name}', async () => {
  reset();
  onRpc('api_connection_update', (b) => ({ connection: { ...P, ...b } }));
  const { m, changed } = open();
  const active = byAttr(m, 'id', 'apic-f-active')[0];
  active.checked = false; active.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(sent('api_connection_update'), [{ id: 3, active: 0 }]);
  assert.equal(changed.length, 1);
  reset();
  onRpc('api_connection_update', (b) => ({ connection: { ...P, ...b } }));
  const t2 = open();
  const name = byAttr(t2.m, 'id', 'apic-f-name')[0];
  name.value = 'med24'; name.dispatchEvent({ type: 'input' });
  buttonByText(t2.m, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(sent('api_connection_update'), [{ id: 3, name: 'med24' }]);
});

test('права: «Доступ» — галочка «Пакеты услуг» уходит упорядоченным списком прав', async () => {
  reset();
  onRpc('api_connection_update', (b) => ({ connection: { ...P, ...b } }));
  const { m } = open();
  tabBtn(m, 'access').click();
  const pk = byAttr(m, 'id', 'apic-read-packages')[0];
  pk.checked = true; pk.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.deepEqual(sent('api_connection_update'), [{ id: 3, scopes: ['clinic', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments'] }]);
});

test('ключ (администратор): «Показать» — api_connection_reveal; «Выпустить новый ключ» — подтверждение, затем окно «Новый ключ для …»', async () => {
  reset();
  onRpc('api_connection_reveal', () => ({ value: KEY_VALUE }));
  onRpc('api_connection_regenerate', () => ({ value: KEY2, connection: { ...P, key_mask: 'em_live_••••2222' } }));
  const { m } = open({}, P, 'key');
  byAttr(m, 'data-apic-act', 'show')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_reveal'), [{ id: 3, what: 'key' }]);
  assert.equal(byAttr(m, 'aria-label', 'Ключ доступа')[0].value, KEY_VALUE);
  buttonByText(m, /Выпустить новый ключ/).click();
  assert.ok(textOf(m).includes('прежний перестанет работать сразу'));
  assert.equal(sent('api_connection_regenerate').length, 0, 'без подтверждения ушёл запрос');
  byAttr(m, 'data-apic-act', 'rotate-yes')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_regenerate'), [{ id: 3, what: 'key', confirm: true }]);
  const h = modal('conn-key');
  assert.ok(h && textOf(h).includes('прежний больше не подходит'));
});

test('секрет: «Новый секрет» — подтверждение, затем новый секрет виден в поле', async () => {
  reset();
  onRpc('api_connection_regenerate', () => ({ value: 'em_whsec_TESTONLYtestonlyTESTONLYtest9999', connection: P }));
  const { m } = open({}, P, 'hooks');
  byAttr(m, 'data-apic-act', 'regen')[0].click();
  byAttr(m, 'data-apic-act', 'secret-yes')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_regenerate'), [{ id: 3, what: 'secret', confirm: true }]);
  assert.equal(byAttr(m, 'aria-label', 'Секрет для подписи уведомлений')[0].value, 'em_whsec_TESTONLYtestonlyTESTONLYtest9999');
});

test('удаление: подтверждение, затем {id, confirm:true}; у сайта клиники удаления нет', async () => {
  reset();
  onRpc('api_connection_delete', () => ({ ok: true }));
  const { m, changed } = open();
  buttonByText(m, /Удалить подключение/).click();
  assert.ok(textOf(m).includes('Ключ и секрет сотрутся'));
  byAttr(m, 'data-apic-act', 'delete-yes')[0].click();
  await tick();
  assert.deepEqual(sent('api_connection_delete'), [{ id: 3, confirm: true }]);
  assert.equal(changed.length, 1);
  reset();
  const site = open({}, S.connections[0]);
  assert.ok(!buttonByText(site.m, /Удалить подключение/));
  assert.ok(textOf(site.m).includes('удалить его нельзя'));
  assert.ok(textOf(site.m).includes('klinika-demo.uz'), 'адрес сайта клиники — из «Компании»');
});

test('«Изменение» без администратора: ключ и секрет скрыты, права и уведомления не правятся, удаления нет; «Сохранить» есть', () => {
  reset();
  const { m } = open({ can: { view: true, edit: true, admin: false } }, { ...P, key_mask: '', secret_mask: '' }, 'key');
  assert.ok(textOf(m).includes('Ключ видит и меняет только администратор.'));
  assert.equal(byAttr(m, 'data-apic-act', 'show').length, 0);
  tabBtn(m, 'access').click();
  assert.ok('disabled' in byAttr(m, 'id', 'apic-read-packages')[0].attrs);
  assert.ok(!buttonByText(m, /Удалить подключение/));
  assert.ok(buttonByText(m, /^Сохранить$/));
});

test('«Просмотр»: поля выключены, «Сохранить» нет', () => {
  reset();
  const { m } = open({ can: { view: true, edit: false, admin: false } }, { ...P, key_mask: '', secret_mask: '' });
  assert.ok('disabled' in byAttr(m, 'id', 'apic-f-name')[0].attrs);
  assert.ok(!buttonByText(m, /^Сохранить$/));
});

test('включение без адреса для партнёров: отказ сервера показан с «Открыть «Компанию»»', async () => {
  reset();
  onRpc('api_connection_update', () => ({ __error: { code: 'partner_address_required',
    message: 'Подключение нельзя включить: в «Компании» не заполнен адрес для партнёров — город или область, район и улица на русском.' }, status: 409 }));
  const { m } = open({}, { ...P, active: false });
  const active = byAttr(m, 'id', 'apic-f-active')[0];
  active.checked = true; active.dispatchEvent({ type: 'change' });
  buttonByText(m, /^Сохранить$/).click();
  await tick();
  assert.ok(textOf(m).includes('Подключение нельзя включить'));
  assert.ok(buttonByText(m, /Открыть «Компанию»/));
});

test('журнал: «Запросы с этим ключом» — честно пусто до публичного сервера; «Изменения настроек» — из api_journal_list', async () => {
  reset();
  onRpc('api_journal_list', (b) => (b && b.connection_id === 3 ? [{ id: 1, at: '2026-10-10T09:00:00Z', user_name: 'Босс', action: 'created', detail: {} }] : []));
  const { m } = open({}, P, 'log');
  await tick();
  assert.ok(textOf(m).includes('Запросов с этим ключом ещё не было'));
  assert.ok(textOf(m).includes('Подключение создано'));
  assert.deepEqual(sent('api_journal_list'), [{ connection_id: 3, limit: 50 }]);
});
```

  В `api-connections.test.mjs` заменить последний тест:

```js
test('открыть по ссылке из CRM: payload.connection_id открывает карточку подключения', async () => {
  reset();
  await open({}, { payload: { connection_id: 3 } });
  const m = document.body.children.find((n) => n.attrs && n.attrs['data-apic-modal'] === 'conn');
  assert.ok(m && textOf(m).includes('med24.uz'));
});
```

- [ ] **Step 2:** запуск → падает (заглушка).
- [ ] **Step 3: модуль** `public/js/admin/views/api-connection-card.js`:

```js
// CLINIC_API_STEP7_V1 — карточка подключения (макет screen-api.js: MODALS.conn,
// keyPanel). Вкладки: Основное · Доступ · Уведомления · Ключ · Журнал.
//
// Сохраняет только ИЗМЕНЁННОЕ и только то, что этому человеку можно (`can` от
// сервера): «Изменение» — включить, название, сайт, контакт; администратор —
// ещё права, уведомления, безопасность. Ключ и секрет — только администратору:
// «Показать» спрашивает сервер (журнал «Ключ открыт»), «Выпустить новый» — после
// подтверждения, прежний перестаёт подходить сразу. Удаление — архив (Р12), с
// подтверждением; подключение сайта клиники не удаляется.
import { h, Icon, Tag, clear, toast, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { KIND_INFO, KEY_TTL_LABEL, normalizeConnection, connectionProblems, orderedScopes, orderedEvents, normalizeIpList } from '../../shared/api-connections.js';
import { rpc, secretField, section, basicsFields, accessSections, hooksSection, securityFields, activeField, openModal,
  addressBlock, journalTable, expiryTag } from './api-ui.js';
import { openHandover } from './api-connection-new.js';

const TABS = [['main', 'Основное'], ['access', 'Доступ'], ['hooks', 'Уведомления'], ['key', 'Ключ'], ['log', 'Журнал']];
const EDIT_FIELDS = ['name', 'site_url', 'contact', 'active'];
const ADMIN_FIELDS = ['scopes', 'webhook_url', 'webhook_events', 'rate_limit', 'key_ttl', 'ip_allow'];
const TAB_OF = { name: 'main', site_url: 'main', contact: 'main', active: 'main', rate_limit: 'main', key_ttl: 'main', ip_allow: 'main',
  scopes: 'access', webhook_url: 'hooks', webhook_events: 'hooks' };
const comparable = (k, v) => (k === 'scopes' ? orderedScopes(v) : k === 'webhook_events' ? orderedEvents(v)
  : k === 'ip_allow' ? normalizeIpList(v) : k === 'active' ? !!v : v);

export function openConnectionCard({ settings, connection: c, onChanged = null, onNavigate = null, tab = 'main' }) {
  const can = settings.can;
  const d = { kind: c.kind, name: c.name, site_url: c.site_url, contact: c.contact, scopes: [...c.scopes], active: c.active,
    webhook_url: c.webhook_url, webhook_events: [...c.webhook_events], rate_limit: c.rate_limit, key_ttl: c.key_ttl, ip_allow: c.ip_allow };
  let current = tab;
  let errs = {};
  let confirm = '';   // 'key' | 'secret' | 'delete'
  let fail = '';
  let journal = null;
  let m = null;
  const reveal = (what) => async () => (await rpc('api_connection_reveal', { id: c.id, what })).value;
  const keyBox = can.admin ? secretField({ label: 'Ключ доступа', mask: c.key_mask, getValue: reveal('key') }) : null;
  const secretBox = can.admin ? secretField({ label: 'Секрет для подписи уведомлений', mask: c.secret_mask, getValue: reveal('secret'),
    regen: { label: 'Новый секрет', onClick: () => { confirm = 'secret'; paint(); } } }) : null;
  const body = h('div', { class: 'modal-body apic-modal-body' });
  const tabs = h('div', { class: 'tabs apic-tabs', role: 'tablist' });

  function confirmBlock(text, act, label, onYes) {
    const yes = h('button', { class: 'btn btn-danger btn-sm', type: 'button', 'data-apic-act': act }, label);
    yes.addEventListener('click', onYes);
    const no = h('button', { class: 'btn btn-sm', type: 'button' }, 'Отмена');
    no.addEventListener('click', () => { confirm = ''; paint(); });
    return h('div', { class: 'apic-confirm', role: 'alertdialog' }, h('p', null, text), h('div', { class: 'apic-row' }, yes, no));
  }
  function paintTabs() {
    clear(tabs);
    for (const [k, l] of TABS) {
      const b = h('button', { class: 'tab' + (current === k ? ' on' : ''), type: 'button', role: 'tab',
        'aria-selected': String(current === k), 'data-apic-tab': k }, l);
      b.addEventListener('click', () => { current = k; confirm = ''; paint(); });
      tabs.appendChild(b);
    }
  }
  function paint() {
    paintTabs();
    clear(body);
    if (fail) body.appendChild(addressBlock(fail, onNavigate, () => m.close()));
    if (current === 'main') paintMain();
    else if (current === 'access') {
      body.appendChild(accessSections(d, errs, { disabled: !can.admin }));
      if (!can.admin) body.appendChild(h('p', { class: 'hint' }, 'Права подключения меняет администратор.'));
    } else if (current === 'hooks') paintHooks();
    else if (current === 'key') paintKey();
    else paintLog();
  }
  function paintMain() {
    if (confirm === 'delete') {
      body.appendChild(confirmBlock(trf('Удалить подключение «{name}»? Ключ и секрет сотрутся и больше не заработают. Заявки, которые уже пришли, останутся в CRM со своим источником.', { name: c.name }),
        'delete-yes', tr('Удалить'), remove));
    }
    body.appendChild(activeField(d, { disabled: !can.edit, ready: settings.partner_address_missing.length === 0 || c.active }));
    const K = KIND_INFO[c.kind] || KIND_INFO.partner;
    body.appendChild(section('Основное', '',
      h('dl', { class: 'apic-kv' },
        h('dt', null, 'Тип'), h('dd', null, K.label, c.kind === 'site' ? [' · ', 'создано автоматически'] : null),
        h('dt', null, 'Создано'), h('dd', null, fmtDateTime(c.created_at), c.created_by_name ? [' · ', c.created_by_name] : null)),
      basicsFields(d, errs, { disabled: !can.edit, sourceLabel: c.crm_source_label, companyWebsite: settings.company_website })));
    body.appendChild(securityFields(d, errs, { disabled: !can.admin }));
  }
  function paintHooks() {
    if (confirm === 'secret') {
      body.appendChild(confirmBlock('Выпустить новый секрет? Прежний перестанет подходить сразу — передайте новый подключению.',
        'secret-yes', tr('Выпустить новый секрет'), () => regenerate('secret')));
    }
    body.appendChild(hooksSection(d, errs, { disabled: !can.admin, secretEl: secretBox,
      secretNote: can.admin ? null : h('p', { class: 'hint' }, 'Секрет видит и меняет только администратор.') }));
    body.appendChild(section('Последние уведомления', '',
      h('div', { class: 'empty' }, 'Уведомлений ещё не было: они пойдут, когда в Easy-Med включат публичный сервер.')));
  }
  function paintKey() {
    if (!can.admin) { body.appendChild(h('p', { class: 'hint' }, 'Ключ видит и меняет только администратор.')); return; }
    const facts = h('dl', { class: 'apic-kv' },
      h('dt', null, 'Выпущен'), h('dd', null, fmtDateTime(c.key_issued_at), c.key_issued_by_name ? [' · ', c.key_issued_by_name] : null),
      h('dt', null, 'Действует до'), h('dd', null, c.key_expires_at ? fmtDateTime(c.key_expires_at) : KEY_TTL_LABEL.never, expiryTag(c)),
      h('dt', null, 'Последний запрос'), h('dd', null, c.last_used_at ? fmtDateTime(c.last_used_at) : 'ещё не было'),
      h('dt', null, 'Как передавать'), h('dd', null, h('code', { translate: 'no' }, 'Authorization: Bearer <ключ>')));
    const rotate = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'data-apic-act': 'rotate' }, Icon('Refresh', { size: 13 }), ' ', 'Выпустить новый ключ');
    rotate.addEventListener('click', () => { confirm = 'key'; paint(); });
    body.appendChild(section('Ключ доступа', '', keyBox,
      h('p', { class: 'hint' }, 'Ключ видят и копируют только администраторы клиники. Если он мог попасть к чужим людям, выпустите новый.'),
      facts,
      confirm === 'key'
        ? confirmBlock('Подключение получит новый ключ, а прежний перестанет работать сразу. Передайте новый ключ подключению.',
            'rotate-yes', tr('Выпустить новый ключ'), () => regenerate('key'))
        : h('div', { class: 'apic-row' }, rotate, h('span', { class: 'hint' }, 'Если ключ потерян или мог попасть к чужим людям.'))));
  }
  async function paintLog() {
    body.appendChild(section('Запросы с этим ключом', '',
      h('div', { class: 'empty' }, 'Запросов с этим ключом ещё не было: они появятся здесь, когда в Easy-Med включат публичный сервер.')));
    const box = h('div', null, h('div', { class: 'muted' }, 'Загрузка…'));
    body.appendChild(section('Изменения настроек', 'без ключей и секретов', box));
    if (journal === null) {
      try { journal = await rpc('api_journal_list', { connection_id: c.id, limit: 50 }); } catch { journal = []; }
    }
    clear(box);
    box.appendChild(journalTable(journal, { withConnection: false }));
  }

  async function regenerate(what) {
    try {
      const r = await rpc('api_connection_regenerate', { id: c.id, what, confirm: true });
      confirm = '';
      if (onChanged) onChanged();
      if (what === 'key') {
        m.close();
        openHandover({ settings, connection: r.connection || c, key: r.value, baseUrl: settings.base_url, rotated: true });
        return;
      }
      secretBox.setValue(r.value);
      paint();
      toast(tr('Новый секрет сохранён — передайте его подключению.'), 'success');
    } catch (e) { toast(tr(e.message), 'fail'); }
  }
  async function remove() {
    try {
      await rpc('api_connection_delete', { id: c.id, confirm: true });
      m.close();
      toast(trf('Подключение «{name}» удалено, ключ стёрт.', { name: c.name }), 'success');
      if (onChanged) onChanged();
    } catch (e) { toast(tr(e.message), 'fail'); }
  }
  async function save() {
    const allowed = can.admin ? [...EDIT_FIELDS, ...ADMIN_FIELDS] : EDIT_FIELDS;
    const patch = {};
    for (const k of allowed) {
      if (c.kind === 'site' && k === 'site_url') continue;
      // Права и события — упорядоченными, IP — по одному в строке: как их хранит сервер.
      if (JSON.stringify(comparable(k, d[k])) !== JSON.stringify(comparable(k, c[k]))) patch[k] = comparable(k, d[k]);
    }
    if (!Object.keys(patch).length) { m.close(); return; }
    const v = normalizeConnection(patch);
    errs = connectionProblems(v, { partial: true });
    fail = '';
    const first = Object.keys(errs)[0];
    if (first) { current = TAB_OF[first] || 'main'; paint(); toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
    try {
      await rpc('api_connection_update', { id: c.id, ...v });
      m.close();
      toast(tr('Сохранено'), 'success');
      if (onChanged) onChanged();
    } catch (e) {
      if (e.code === 'partner_address_required') { fail = e.message; current = 'main'; paint(); return; }
      toast(tr(e.message), 'fail');
    }
  }

  const foot = [];
  if (can.admin && c.kind !== 'site') {
    const del = h('button', { class: 'btn btn-ghost', type: 'button', 'data-apic-act': 'delete', style: { color: 'var(--crit-700)' } },
      Icon('Trash', { size: 15 }), ' ', 'Удалить подключение');
    del.addEventListener('click', () => { confirm = 'delete'; current = 'main'; paint(); });
    foot.push(del);
  } else if (c.kind === 'site') {
    foot.push(h('span', { class: 'hint' }, 'Подключение сайта клиники создано автоматически: удалить его нельзя, выключить можно.'));
  }
  foot.push(h('span', { class: 'grow' }));
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Отмена');
  foot.push(cancel);
  if (can.edit) {
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button', 'data-apic-act': 'save' }, 'Сохранить');
    saveBtn.addEventListener('click', save);
    foot.push(saveBtn);
  }
  paint();
  m = openModal({ name: 'conn', tabs, body, foot,
    title: [h('span', { class: 'apic-ico t-' + c.kind }, Icon((KIND_INFO[c.kind] || KIND_INFO.partner).icon, { size: 16 })), ' ', c.name, ' ',
      Tag(c.active ? 'Включено' : 'Выключено', { kind: c.active ? 'ok' : '', dot: true })] });
  cancel.addEventListener('click', () => m.close());
  return m;
}
```

  `activeField(..., ready: … || c.active)`: у уже включённого подключения строка «адрес не заполнен» не нужна — выключить его можно всегда.
- [ ] **Step 4: словарь** (есть: «Основное», «Доступ», «Уведомления», «Ключ», «Журнал», «Тип», «Удалить», «Отмена», «Сохранить», «Сохранено», «Загрузка…», «Удалить подключение»):

| ru | uz | en |
|---|---|---|
| Права подключения меняет администратор. | Ulanish huquqlarini administrator o‘zgartiradi. | Connection permissions are changed by the administrator. |
| Удалить подключение «{name}»? Ключ и секрет сотрутся и больше не заработают. Заявки, которые уже пришли, останутся в CRM со своим источником. | «{name}» ulanishini o‘chirib tashlaysizmi? Kalit va sir o‘chiriladi va boshqa ishlamaydi. Kelib bo‘lgan arizalar CRMda o‘z manbasi bilan qoladi. | Delete the connection “{name}”? The key and secret will be erased and will never work again. Requests that have already arrived stay in the CRM with their source. |
| Создано | Yaratilgan | Created |
| Выпустить новый секрет? Прежний перестанет подходить сразу — передайте новый подключению. | Yangi sir chiqarilsinmi? Avvalgisi darhol yaroqsiz bo‘ladi — yangisini ulanishga topshiring. | Issue a new secret? The old one stops working at once — hand the new one to the connection. |
| Выпустить новый секрет | Yangi sir chiqarish | Issue a new secret |
| Секрет видит и меняет только администратор. | Sirni faqat administrator ko‘radi va o‘zgartiradi. | Only the administrator sees and changes the secret. |
| Последние уведомления | So‘nggi bildirishnomalar | Recent notifications |
| Уведомлений ещё не было: они пойдут, когда в Easy-Med включат публичный сервер. | Hali bildirishnomalar bo‘lmagan: ular Easy-Med ommaviy serverni yoqqanda yuboriladi. | No notifications yet: they will go out once Easy-Med switches the public server on. |
| Ключ видит и меняет только администратор. | Kalitni faqat administrator ko‘radi va o‘zgartiradi. | Only the administrator sees and changes the key. |
| Выпущен | Chiqarilgan | Issued |
| Действует до (есть) | | |
| Как передавать | Qanday yuborish kerak | How to send |
| Выпустить новый ключ | Yangi kalit chiqarish | Issue a new key |
| Ключ видят и копируют только администраторы клиники. Если он мог попасть к чужим людям, выпустите новый. | Kalitni faqat klinika administratorlari ko‘radi va nusxalaydi. U begonalar qo‘liga tushgan bo‘lishi mumkin bo‘lsa, yangisini chiqaring. | Only clinic administrators see and copy the key. If it may have reached strangers, issue a new one. |
| Подключение получит новый ключ, а прежний перестанет работать сразу. Передайте новый ключ подключению. | Ulanish yangi kalit oladi, avvalgisi esa darhol ishlamay qoladi. Yangi kalitni ulanishga topshiring. | The connection gets a new key and the old one stops working at once. Hand the new key to the connection. |
| Если ключ потерян или мог попасть к чужим людям. | Agar kalit yo‘qolgan yoki begonalar qo‘liga tushgan bo‘lishi mumkin bo‘lsa. | If the key is lost or may have reached strangers. |
| Запросы с этим ключом | Shu kalit bilan so‘rovlar | Requests with this key |
| Запросов с этим ключом ещё не было: они появятся здесь, когда в Easy-Med включат публичный сервер. | Shu kalit bilan hali so‘rovlar bo‘lmagan: ular Easy-Med ommaviy serverni yoqqanda shu yerda paydo bo‘ladi. | No requests with this key yet: they will appear here once Easy-Med switches the public server on. |
| Изменения настроек | Sozlamalardagi o‘zgarishlar | Settings changes |
| без ключей и секретов | kalitlar va sirlarsiz | without keys or secrets |
| Новый секрет сохранён — передайте его подключению. | Yangi sir saqlandi — uni ulanishga topshiring. | The new secret is saved — hand it to the connection. |
| Подключение «{name}» удалено, ключ стёрт. | «{name}» ulanishi o‘chirildi, kalit o‘chirildi. | Connection “{name}” deleted, the key erased. |
| Подключение сайта клиники создано автоматически: удалить его нельзя, выключить можно. | Klinika sayti ulanishi avtomatik yaratilgan: uni o‘chirib tashlab bo‘lmaydi, to‘xtatib qo‘yish mumkin. | The clinic website connection was created automatically: it cannot be deleted, but it can be switched off. |

- [ ] **Step 5:** тесты зелёные (`api-connection-card.test.mjs`, `api-connections.test.mjs`, `api-connection-new.test.mjs`). Сторожа: `i18n-coverage`, `i18n-uz-quality`, `type-scale`, `client-rpc-coverage`.
- [ ] **Step 6: коммит** «API и подключения: карточка подключения — включение, название и контакт, права, уведомления, безопасность, показать и выпустить новый ключ и секрет с подтверждением, удаление-архив, журнал (CLINIC_API_STEP7_V1)».

---

## Task 13: «Компания» — звёздочки и запрет сохранения без адреса, пока включено подключение (решение владельца 11, экран, CLINIC_API_STEP7_V1)

**Files:**
- Modify: `public/js/admin/views/company-address.js` (`addressCard` :42-134 — поля `region`, `district`, улица)
- Modify: `public/js/admin/views/documents-settings.js` (`save()` ~:384-416; монтирование `addressCard`)
- Test: `public/js/admin/__tests__/company-profile.test.mjs`
- Modify: `public/js/admin/i18n-strings.js` — новых строк нет: `PROFILE_MESSAGES.partnerAddress` внесён в задаче 4.

**Сейчас:** адрес проверяется «всё или ничего» и только если его меняли. Флаг `window.CLINIC.api_address_required` приходит с сервера (задача 4) при входе. Страница API обновляет его после каждого изменения (`refreshClinicBrand`, задача 10).

- [ ] **Step 1: падающие тесты** в `company-profile.test.mjs` (стенд файла: `open`, `save`, `fieldBox`, `fieldError`, `triInput`, `triError`, `type`, `lastUpdate`, `labelText`; правка для сохранения — узбекское название: поле телефона в стенде правится иначе):

```js
// CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
// адрес для партнёров обязателен.
test('подключение API включено: звёздочки у города, района и улицы RU; без адреса «Компания» не сохраняется — ошибки под полями', async () => {
    globalThis.window.CLINIC.api_address_required = true;
    try {
        const root = await open();
        const label = (name) => labelText(fieldBox(root, name).children.find((c) => c.tagName === 'LABEL'));
        assert.ok(label('Город / область').includes('*'));
        assert.ok(label('Район').includes('*'));
        assert.ok(textOf(root).includes('Пока включены подключения API, адрес для партнёров обязателен'));
        type(triInput(root, 'Название клиники', 'uz'), 'Shifo');
        await save(root);
        assert.equal(lastUpdate, null, 'сохранение ушло без адреса');
        assert.ok(fieldError(root, 'Город / область'));
        assert.ok(triError(root, 'Улица, дом', 'ru'));
    } finally { globalThis.window.CLINIC.api_address_required = false; }
});

test('подключений нет — адрес необязателен, звёздочек нет (как в шаге 3)', async () => {
    const root = await open();
    assert.ok(!labelText(fieldBox(root, 'Город / область').children.find((c) => c.tagName === 'LABEL')).includes('*'));
    type(triInput(root, 'Название клиники', 'uz'), 'Shifo');
    await save(root);
    assert.ok(lastUpdate && lastUpdate.name_uz === 'Shifo', 'правка названия не прошла');
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/company-profile.test.mjs` → новые падают.
- [ ] **Step 3: правка.**

  `company-address.js`:
  - импорт `PROFILE_MESSAGES` из `../../shared/clinic-profile.js` и `tr` из `../i18n.js`, если их ещё нет;
  - `addressCard(state, { onChange = null, secondary = false, required = false } = {})`;
  - после создания `boxes` и `street`:

```js
    // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
    // город / область, район и улица RU обязательны — звёздочка у подписи и
    // строка над полями. Звёздочка — текст, а не атрибут: поддельный DOM тестов
    // и настоящий показывают её одинаково.
    const marks = [boxes.region, boxes.district].map((b) => {
        const mk = h('span', { class: 'req' });
        b.node.children[0].appendChild(mk);   // <label> поля — первый ребёнок
        return mk;
    });
    const streetMark = h('span', { class: 'req' });
    street.node.firstChild.appendChild(streetMark);   // <legend> группы «Улица, дом»
    const reqNote = h('p', { class: 'cpf-hint cpf-req-note' });
    function setRequired(on) {
        for (const mk of [...marks, streetMark]) mk.textContent = on ? ' *' : '';
        reqNote.textContent = on ? tr(PROFILE_MESSAGES.partnerAddress) : '';
    }
    setRequired(required);
```

  - в разметку `cpf-body` — `reqNote` сразу за первым `cpf-hint`;
  - в возвращаемый объект — `setRequired`.

  `documents-settings.js`:
  - импорт `partnerAddressProblems` из `../../shared/clinic-profile.js`;
  - функция `const apiAddressRequired = () => !!(window.CLINIC && window.CLINIC.api_address_required);   // CLINIC_API_STEP7_V1`;
  - монтирование (:167) `addressCard(state, { onChange: () => renderPreview(), secondary })` → `addressCard(state, { onChange: () => renderPreview(), secondary, required: apiAddressRequired() && !secondary })`;
  - в `save()` — сразу после цикла, который собирает `problems` (перед `showProblems(problems)`):

```js
    // CLINIC_API_STEP7_V1 — решение владельца 11: пока включено подключение API,
    // адрес для партнёров обязателен целиком, что бы ни меняли (сервер, routes/db.js,
    // откажет так же). В филиале подключений нет — правило его не касается.
    if (apiAddressRequired() && !secondary) {
        for (const [k, msg] of Object.entries(partnerAddressProblems(v, refs.geoAvailability()))) problems[k] = msg;
    }
```

  `secondary` — переменная модуля (:130, шаг 3: `secondary = isSecondaryBuilding()` при монтировании).
- [ ] **Step 4:** тесты зелёные. Сторожа:
  - весь `company-profile.test.mjs`, `settings-split.test.mjs`, `clinic-brand.test.mjs`;
  - `i18n-coverage.test.mjs`.
- [ ] **Step 5: коммит** «Компания: пока включено подключение API, у города, района и улицы — звёздочки, и без адреса для партнёров «Компания» не сохраняется (решение владельца 11, CLINIC_API_STEP7_V1)».

---

## Task 14: Подключение экрана и уход старых — «API» в хабе, маршрут, «Публичный сайт» (клиент) (CLINIC_API_STEP7_V1)

**Files:**
- Modify: `public/js/admin.js`:
  - :54 импорт `renderPublicSite`;
  - :87 импорт `renderApiSettings`;
  - :422 `LEGACY_ROUTES['api-settings']`;
  - :706 `PARENT_OF['public-site']`;
  - :1150 `case 'public-site'`;
  - :1238 `case 'api-settings'`;
  - :1311-1328 пункт меню «Публичный сайт».
- Modify: `public/js/admin/views/settings-hub.js`:
  - :22 шапка;
  - :87 `SECTION_GRANT.api_tokens`;
  - :283 плитка «API»;
  - :598-610 `LOOKUP_CONFIG.api_tokens`.
- Modify: `public/js/admin/permissions.js` (:1176-1180 — комментарий)
- Modify: `public/js/admin/i18n.js` (:27, :133, :229 — `sidebar.publicSite`)
- Delete: `public/js/admin/views/api-settings.js`, `public/js/admin/views/public-site.js`
- Test: `public/js/admin/__tests__/app-shell.test.mjs` (:485-491, :907), `route-gate.test.mjs` (:96-103), `admin-rows-grantable.test.mjs` (:77, :117, :137, :178-190), `role-reports-settings.test.mjs` (:189, :303), `i18n-coverage.test.mjs` (:88)
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: тесты под новое поведение.**
  - **`app-shell.test.mjs`:**
    - удалить тест «Публичный сайт» — обычный пункт меню… (:485-491): пункта больше нет;
    - в `DEAD` (:907) убрать `'api-settings': 'settings'` (адрес снова живой); `'public-site'` остаётся (пересылка в хаб);
    - новый тест — **перед** тестом «глушим таймеры экранов, чтобы прогон завершался» (:917). После него переход снова заводит таймеры оболочки, и файл не завершается (проверено: все тесты зелёные, но прогон висит до тайм-аута):

```js
// CLINIC_API_STEP7_V1 — #api-settings снова живой: экран «API и подключения».
test('#api-settings — экран «API и подключения»; «Публичного сайта» в меню нет', async () => {
    await perms_setFull();
    await go('api-settings');
    assert.equal(shell().state.view, 'api-settings');
    const js = read('public/js/admin.js');
    assert.ok(!js.includes('renderPublicSite') && !js.includes("t('sidebar.publicSite'"), '«Публичный сайт» остался в оболочке');
    assert.ok(js.includes("case 'api-settings': return void await renderWithViewOnly(viewRoot, 'settings.api'"));
});
```

  - **`route-gate.test.mjs`:** в `FULL_ACCESS_ONLY`:
    - `'api-settings'`: причина `'CLINIC_API_STEP7_V1 — подключения и ключи API: окно «API» в «Ролях» или администратор'` (комментарий над записью — так же);
    - запись `'public-site'` и её комментарий удалить (подэкрана в `PARENT_OF` больше нет).
  - **`admin-rows-grantable.test.mjs`:**
    - в поддельном `/api/db` (:77) убрать `api_tokens`;
    - (:117) из списка `['roles', 'api_tokens', 'doctor_rates', 'patient_discounts']` убрать `'api_tokens'`;
    - (:137) `assert.equal(sectionLevel('api_tokens'), 'view');` → `assert.equal(perms.isRouteAllowed('api-settings'), true, '«API: Просмотр» открывает экран');`;
    - тест :178-190 заменить:

```js
test('плитка «API» ведёт на экран «API и подключения» — и у не-администратора с «API: Изменение»', async () => {
  const root = mk('div');
  const nav = [];
  perms.setEffectiveFromRole(savedRole('Регистратор', REGISTRAR, { settings: 'view', 'settings.api': 'edit' }));
  try {
    await renderSettingsHub(root, { onNavigate: (r) => nav.push(r) });
    byClass(root, 'set-row-link').find((n) => textOf(n).includes('API')).click();
    await tick();
    assert.deepEqual(nav, ['api-settings']);
    assert.equal(perms.isRouteAllowed('api-settings'), true);
    assert.ok(!textOf(root).includes('Новый ключ создаёт администратор'), 'прежний редактор ключей открылся');
  } finally { perms.setFullAccess('Admin'); }
});
```

  - **`role-reports-settings.test.mjs`:**
    - (:189) `assert.equal(sectionLevel('api_tokens'), 'none');` → `assert.equal(perms.isRouteAllowed('api-settings'), false);`;
    - (:303) из списка убрать `'api_tokens'` (маршрут `api-settings` проверяется строкой :305).
  - **`i18n-coverage.test.mjs`** (:88): строку `'Иванов Иван',  // api-settings curl …` удалить — образец жил только в удалённом `api-settings.js`, а список проверяет сам себя (:448-457).
- [ ] **Step 2:** запуск этих файлов → падают (оболочка ещё старая).
- [ ] **Step 3: правка.**
  - **`admin.js`:**
    - удалить импорт `renderPublicSite` (:54), `case 'public-site'` (:1150), блок пункта меню «Публичный сайт» (:1311-1328, от комментария `PUBLIC_SITE_V1 — the Symptex…` до закрывающей `}` перед `let currentHeaderEl`);
    - импорт :87 → `import { renderApiConnections } from './admin/views/api-connections.js';   // CLINIC_API_STEP7_V1 — «API и подключения» вместо облачного экрана`;
    - `LEGACY_ROUTES`: удалить строку `'api-settings': { view: 'settings' },` (:422); `'public-site'` оставить;
    - `PARENT_OF` (:706): убрать `'public-site': 'settings'`;
    - :1238 → `case 'api-settings': return void await renderWithViewOnly(viewRoot, 'settings.api', (root) => renderApiConnections(root, ctx));   // CLINIC_API_STEP7_V1 — «Просмотр» — в рамке «только просмотр»`.
  - **`settings-hub.js`:**
    - шапка :20-22: из перечня таблиц мигр. 012 убрать `api_tokens` и дописать: `(api_tokens — облачная заглушка, с CLINIC_API_STEP7_V1 недостижима: ключи — экран «API и подключения»)`;
    - `SECTION_GRANT`: удалить `api_tokens: 'settings.api',`;
    - плитка :283 →
      `{ label: 'API', desc: 'Подключения сайта, Symptex и партнёров: ключи, права, уведомления', icon: 'Key', live: true, action: nav('api-settings'), route: 'api-settings' },   // CLINIC_API_STEP7_V1`;
    - `LOOKUP_CONFIG.api_tokens` (:598-610) удалить целиком. Механизм `adminInsertOnly` (:1139-1143) остаётся без пользователей — общий, не трогаем.
  - **`permissions.js`** :1176-1180 — комментарий над `if (view === 'api-settings') return false;`:
    `// CLINIC_API_STEP7_V1 — «API и подключения»: открывает окно «API» в «Ролях» (SETTINGS_ROUTE_TILE выше) или администратор; ненастроенной роли — нет.` Логику не менять.
  - **`i18n.js`:** удалить три строки `publicSite: …` (:27, :133, :229).
  - **`git rm public/js/admin/views/api-settings.js public/js/admin/views/public-site.js`.**
    Перед этим `git grep -n "api-settings.js\|public-site.js" -- public` → вхождения только в `admin.js`, и они уже убраны. Шапка `setup-checklist.test.mjs` упоминает `public-site.js` комментарием — оставить.
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Подключения сайта, Symptex и партнёров: ключи, права, уведомления | Sayt, Symptex va hamkorlar ulanishlari: kalitlar, huquqlar, bildirishnomalar | Website, Symptex and partner connections: keys, permissions, notifications |

- [ ] **Step 5:** тесты зелёные. Сторожа:
  - `__tests__/settings-hub-groups.test.mjs` (подпись «API» прежняя);
  - `role-reports-settings.test.mjs`, `roles-editor.test.mjs`, `roles-save-collect.test.mjs`, `roles-save-truth.test.mjs`;
  - `db-query-schema.test.mjs`, `offline-cloud-calls.test.mjs`, `app-shell.test.mjs`, `route-gate.test.mjs`;
  - `i18n-coverage.test.mjs`;
  - `server/services/rpc/client-rpc-coverage.test.js`.
- [ ] **Step 6: коммит** «Настройки: плитка «API» открывает экран «API и подключения»; облачные экраны «API» и «Публичный сайт» удалены вместе с пунктом меню (CLINIC_API_STEP7_V1)».

---

## Task 15: Сервер — заглушка `api_tokens` вне `/api/db`, строка «API» в «Ролях» — по RPC, по `/api/v1` ничего (CLINIC_API_STEP7_V1)

**Files:**
- Modify: `server/db/schema-registry.js` (:856-862 `api_tokens`)
- Modify: `public/js/shared/permission-catalog.js` (:375-379 `settings.api`)
- Test: `server/db/write-grant.test.js` (:62-75, :115), `server/db/schema-registry.test.js` (:171-187), `server/services/admin-rows-grantable.test.js` (:86-121)
- Create: `server/routes/api-v1-gone.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: тесты.**
  - **`server/routes/api-v1-gone.test.js`:**

```js
// CLINIC_API_STEP7_V1 — спецификация, «Старое»: по прежнему адресу /api/v1 ничего
// не открывается. Остатки gw() облачных экранов (gateway.js) попадают в общий
// ответ «Неизвестный адрес API» (app.js), а не в живой обработчик.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

test('по /api/v1 — 404 not_found и вошедшему администратору; без входа — не 2xx', async () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run('boss', hashPassword('password1'), 'Босс', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'password1' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const [method, p] of [['GET', '/api/v1/keys'], ['POST', '/api/v1/keys'], ['GET', '/api/v1/public-site/branches'],
      ['POST', '/api/v1/appointments'], ['GET', '/api/v1/shifo/v1/doctors']]) {
      const r = await fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 404, method + ' ' + p);
      assert.equal((await r.json()).error.code, 'not_found');
      const anon = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.ok(anon.status >= 400, 'без входа ' + p + ' ответил ' + anon.status);
    }
  } finally { server.close(); }
});
```

  - **`write-grant.test.js`:**
    - тест :62-75 переименовать: «бывшие закрытые строки: без настройки — только администратор»;
    - удалить три строки про `api_tokens` и строку `addGrants(db, 'registrar', { settings: 'edit', 'settings.api': 'edit' });`; строку про `role_permissions` оставить;
    - :115 `assert.equal(writeGrantKey('api_tokens'), 'settings.api');` удалить. Таблиц с ключом плитки станет 24 — проверка `n >= 23` держит.
  - **`schema-registry.test.js`** :186-187 →

```js
  // CLINIC_API_STEP7_V1 — облачная заглушка api_tokens недостижима через /api/db даже администратору.
  assert.ok(!canRead('api_tokens', 'admin'));
  for (const t of ['api_connections', 'api_settings', 'api_journal']) assert.ok(!canRead(t, 'admin'), t + ' в реестре /api/db');
```

    Название теста :171 → `'settings-match tables: admin config, FK embeds; ключи API — не в реестре'`.
  - **`admin-rows-grantable.test.js`:** два теста «API: …» (:86-121) заменить одним:

```js
// CLINIC_API_STEP7_V1 — ключи API живут в «API и подключения» (RPC rpc/api-connections.js);
// облачная заглушка api_tokens /api/db не знает — ни на каком уровне, ни администратору.
test('API: api_tokens через /api/db недостижима — и администратору, и с «API: Изменение»', () => {
  const db = seed();
  try {
    const gone = (e) => e && e.status >= 400 && e.status < 500;
    assert.throws(() => run(db, { table: 'api_tokens', op: 'select', columns: '*' }, ADMIN), gone);
    addGrants(db, 'registrar', { settings: 'view', 'settings.api': 'edit' });
    assert.throws(() => run(db, { table: 'api_tokens', op: 'select', columns: '*' }, REG), gone);
    assert.throws(() => run(db, { table: 'api_tokens', op: 'insert', values: { name: 'k', token: 'x' } }, ADMIN), gone);
  } finally { db.close(); }
});
```

    В тесте «закрытых строк больше нет…» (:52-84) `'settings.api': ['none', 'view', 'edit']` остаётся.
- [ ] **Step 2:** запуск → `write-grant` / `schema-registry` / `admin-rows-grantable` падают (реестр ещё знает `api_tokens`), `api-v1-gone` зелёный (страж закрепляет то, что уже так).
- [ ] **Step 3: правка.**
  - **`schema-registry.js`:** удалить запись `api_tokens` и её комментарий ADMIN_ROWS_GRANTABLE_V1 (:856-862); на их место:

```js
  // CLINIC_API_STEP7_V1 — api_tokens (мигр. 012, облачная заглушка: значение
  // вписывали руками, сервер его не проверял) из реестра убрана — /api/db её не
  // знает. Таблица в базе осталась (план шага 7, Р2). Ключи подключений — в
  // api_connections, тоже вне реестра: только RPC rpc/api-connections.js.
```

  - **`permission-catalog.js`:**
    - комментарий над строкой (:375-378) заменить:

```js
      // CLINIC_API_STEP7_V1 — «API и подключения» (RPC rpc/api-connections.js).
      // «Просмотр» — подключения без ключей; «Изменение» — включить, выключить,
      // переименовать, сайт и контакт. Ключи и секреты, права подключения,
      // уведомления и новое подключение — только администратор (решение владельца 5).
```

    - сама строка:

```js
      { key: 'settings.api', group: 'Системные настройки', label: 'API', desc: 'Подключения сайта, Symptex и партнёров.', levels: ['none', 'view', 'edit'], levelDesc: { view: 'Видит подключения, их права и журнал. Ключи и секреты скрыты.', edit: 'Включает и выключает подключения, меняет название, сайт и контакт. Ключи и секреты, права и уведомления подключений меняет только администратор.' }, adminDefault: true, enforced: 'rpc:api_connection_update' },
```

    Механизм `grantOps` / `read.secret` (`write-grant.js`, `query-compiler.js`) остаётся без пользователей — общий, его удаление не входит в шаг.
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Подключения сайта, Symptex и партнёров. | Sayt, Symptex va hamkorlar ulanishlari. | Website, Symptex and partner connections. |
| Видит подключения, их права и журнал. Ключи и секреты скрыты. | Ulanishlarni, ularning huquqlari va jurnalini ko‘radi. Kalitlar va sirlar yashirin. | Sees the connections, their permissions and the log. Keys and secrets are hidden. |
| Включает и выключает подключения, меняет название, сайт и контакт. Ключи и секреты, права и уведомления подключений меняет только администратор. | Ulanishlarni yoqadi va o‘chiradi, nomi, sayti va kontaktini o‘zgartiradi. Kalitlar va sirlarni, ulanishlarning huquqlari va bildirishnomalarini faqat administrator o‘zgartiradi. | Switches connections on and off, changes the name, website and contact. Keys and secrets, connection permissions and notifications are changed only by the administrator. |

- [ ] **Step 5:** тесты зелёные. Сторожа:
  - `server/db/schema-registry-conformance.test.js`, `star-meets-schema.test.js`;
  - `server/services/grants.test.js`, `gate-fallbacks.test.js`, `report-access.journals.test.js`, `report-access.test.js`;
  - `server/services/branch-sync/catalogue.test.js` (роли едут в филиал);
  - `public/js/admin/__tests__/roles-editor.test.mjs`, `role-reports-settings.test.mjs`, `db-query-schema.test.mjs`;
  - `server/i18n-server-messages.test.js`, `public/js/admin/__tests__/i18n-coverage.test.mjs`.
- [ ] **Step 6: коммит** «Ключи API: облачная заглушка api_tokens недостижима через /api/db, строка «API» в «Ролях» проверяется RPC подключений; по /api/v1 ничего не отвечает (CLINIC_API_STEP7_V1)».

---

## Task 16: Хаб настроек — пустой справочник и заголовок окна по-русски (существующая ошибка, CLINIC_API_STEP7_V1)

**Files:**
- Modify: `public/js/admin/views/settings-hub.js` (:1070-1071 пустой список, :1462 заголовок окна)
- Create: `public/js/admin/__tests__/settings-hub-lookup-i18n.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

**Сейчас** общий редактор справочников хаба собирает английские фразы с русским названием раздела:
- `No ${cfg.title.toLowerCase()} yet — add the first one.` (:1071);
- `'Add ' + cfg.title` / `'Edit ' + cfg.title` (:1462).

Владелец увидел «No ключи api yet — add the first one.» и «Add Ключи API». С уходом «Ключей API» класс остаётся у всех справочников хаба («Филиалы», «Категории пациентов», …).

- [ ] **Step 1: падающий тест** `public/js/admin/__tests__/settings-hub-lookup-i18n.test.mjs`. Стенд — из `admin-rows-grantable.test.mjs`: строки :1-62 (поддельный DOM, `localStorage['admin.lang'] = 'ru'`, `mk`, `walk`, `textOf`, `byClass`, `tick`) и импорты `perms` и `renderSettingsHub` (:84-85). В поддельном fetch строку `const rows = { patient_categories: [...] }[…] || [];` заменить на `const rows = [];` — справочник должен быть пустым.

```js
// CLINIC_API_STEP7_V1 — общий редактор справочников хаба: пустой список и заголовок
// окна — по-русски, без собранных английских фраз («No … yet», «Add …»).
test('пустой справочник и окно «Добавить» — по-русски', async () => {
  perms.setFullAccess('Admin');
  const root = mk('div');
  await renderSettingsHub(root, {});
  byClass(root, 'set-row-link').find((n) => textOf(n).includes('Категории пациентов')).click();
  await tick();
  const t = textOf(root);
  assert.ok(!/\bNo\b|\byet\b/.test(t), 'английский шаблон пустого списка: ' + t.slice(0, 200));
  assert.ok(t.includes('В разделе «Категории пациентов» пока пусто'));
  walk(root).find((n) => n.tagName === 'BUTTON' && String(n.className).includes('btn-primary')).click();
  await tick();
  const modalText = textOf(document.body);
  assert.ok(!/\bAdd\b/.test(modalText), 'заголовок окна по-английски');
  assert.ok(modalText.includes('Добавить: Категории пациентов'));
});
```

  Подпись плитки и `cfg.title` справочника «Категории пациентов» сверить с `LOOKUP_CONFIG.patient_categories` перед запуском. Если `title` другой — взять его в обе строки теста.
- [ ] **Step 2:** запуск → падает.
- [ ] **Step 3: правка** `settings-hub.js`:

```js
    // CLINIC_API_STEP7_V1 — пустой список — русским шаблоном, а не собранной
    // английской фразой с русским названием («No ключи api yet…»).
    const emptyEl = h('div', { class: 'empty', style: { display: 'none' } },
        trf('В разделе «{title}» пока пусто. Нажмите «Добавить», чтобы завести первую запись.', { title: tr(cfg.title) }));
```

  Заголовок окна (:1462):

```js
                    isEdit ? (cfg.editTitle || trf('Изменить: {title}', { title: tr(cfg.title) }))
                           : (cfg.addTitle || trf('Добавить: {title}', { title: tr(cfg.title) }))),   // CLINIC_API_STEP7_V1
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| В разделе «{title}» пока пусто. Нажмите «Добавить», чтобы завести первую запись. | «{title}» bo‘limi hozircha bo‘sh. Birinchi yozuvni qo‘shish uchun «Qo‘shish»ni bosing. | “{title}” is empty so far. Press “Add” to create the first entry. |
| Изменить: {title} | O‘zgartirish: {title} | Edit: {title} |
| Добавить: {title} | Qo‘shish: {title} | Add: {title} |

- [ ] **Step 5:** тест зелёный. Сторожа: `settings-hub-groups.test.mjs`, `admin-rows-grantable.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 6: коммит** «Настройки: пустой справочник и заголовок окна «Добавить / Изменить» — по-русски, без английских шаблонов (CLINIC_API_STEP7_V1)».

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды, после всех задач:**
- как в выпуске: `node --experimental-vm-modules --test` (= `npm test`), из корня дерева;
- как CI на en-US: `node --experimental-vm-modules --import <скретчпад>/force-en.mjs --test`, где `force-en.mjs`:
  `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });`
  (память `easymed-ci-locale-trap`).
- Если файла `force-en.mjs` в скретчпаде нет — создать заново.

**2. Проверка «сломать».** Отдельный агент, только чтение; находки — в `docs/reviews/` или в отчёт. Что пробовать:
- (a) **Секреты:**
  - ключ, секрет и черновик не появляются: в ответах списка и журнала, в console при 4xx/5xx, в `ops_events`, в теле ошибок (`constraintRefusal` отдаёт `detail` SQLite), в `localStorage`, в адресной строке, в выгрузках Excel;
  - в файле базы и резервной копии — только шифротекст;
  - `.api-secrets-key` не попадает ни в `backups/`, ни в выпуск (`build-bundle`);
  - что видит `/api/db` по `api_*` и `api_tokens` с любой ролью.
- (b) **Повтор и подмена ключей:**
  - создать по чужому, устаревшему, израсходованному черновику;
  - прислать `key` в `api_connection_create`;
  - два подключения с одним ключом;
  - прежний ключ после «Выпустить новый» и после удаления (отпечаток стёрт);
  - откат версии на базе с мигр. 242.
- (c) **Права:**
  - «Просмотр», «Изменение» и регистратор без строки против каждого из 9 RPC — включая поля администратора, присланные вместе с полями «Изменения»;
  - администратор-врач;
  - своя роль на основе администратора с «API: Нет»;
  - филиал (409 на каждой записи);
  - заблокированная лицензия (402 на записях, чтение есть).
- (d) **Вебхук:** IP, `localhost`, `.local`, punycode, `https://user:pw@`, порт, длина 301, запрос с токеном (в журнал — без запроса).
- (e) **CRM:**
  - сохранение списка источников старым экраном (без поля `api`) и собранным руками;
  - переименование, скрытие и удаление «Сайта» и своих источников;
  - удаление подключения с заявками и без;
  - объединение заявок (`crm-merge`) с источником подключения;
  - отчёт колл-центра по источникам.
- (f) **Решение владельца 11:**
  - включить без адреса — через экран и прямым RPC;
  - «Компания» без адреса при включённом подключении — через `/api/db` частичным телом;
  - адрес в Казахстане (районов нет);
  - выключить последнее подключение — адрес снова необязателен.
- (g) **Старое:** `#api-settings` и `#public-site` из закладок; `gw()` остатки; `/api/v1/*` — 404.
- (h) **Экран:**
  - 360 px — без горизонтальной прокрутки страницы, таблицы прокручиваются внутри карточки;
  - uz / en — без кириллицы, кроме данных;
  - клавиатура: строка таблицы открывается Enter, окно закрывается Esc, фокус на вкладках.

**3. Проба на тестовой клинике** (:8712, рецепт — память `easymed-dev-prod-workflow`; без тега).
- **Только после того, как на основную линию влита миграция 241 шага 4** (см. «Правила рабочего дерева»: 242 не раньше 241).
- Проверить:
  1. «API» в хабе → экран;
  2. задать имя в адресе → появилось «Сайт клиники», выключенное;
  3. включить без адреса → отказ и «Открыть «Компанию»»;
  4. заполнить адрес в «Компании» → включить;
  5. «Компания» без улицы → не сохраняется;
  6. «Добавить подключение» (партнёр) → «Скопировать всё» → в CRM-канбане появились «Источники из API» с этим партнёром;
  7. «Показать» ключ → журнал «Ключ открыт»;
  8. «Выпустить новый ключ» → окно «Новый ключ для …»;
  9. удалить партнёра → источник скрыт в CRM;
  10. роль с «API: Просмотр» — ключей не видит;
  11. экран на uz.

**4. Пуш и тег.** `git push` ветки (владелец: «после изменений — пушить»). Тег — только по слову владельца. Заметки к выпуску (`RELEASE_NOTES.md` + `release-notes.test.mjs`) — при подготовке выпуска, не в этом плане.

**5. Слияние с шагом 4 — правило решения 11 по зданиям** (раздел «Шагам 4, 8 и 9»). Кто вливается вторым, тот и строит, с названиями колонок шага 4:
- `partnerAddressBlockers(db)` в `server/services/api/partner-address.js`: адрес «Компании» плюс каждый филиал с отметкой «показывать на сайте» — той же `partnerAddressProblems`. Сообщение называет здание.
- `requirePartnerAddress` зовёт её вместо `companyAddressProblems`.
- Сохранение филиала, показанного партнёрам, и включение его отметки при включённом подключении — отказ с полем (страж в сохранении филиала шага 4).
- Тесты: филиал без района при включённом подключении не сохраняется; подключение не включается, пока такой филиал есть; главное здание проверяется только «Компанией».

---

## Вопросы владельцу

Открытых вопросов, которые держат шаг 7, нет. Что решено планом вместо владельца и что он может захотеть пересмотреть (без ответа строится как написано):

1. **Подключение «Сайт клиники» создаётся само — выключенным** (Р10). В макете оно «работает» сразу. По решению 11 включение требует адреса. Кроме того, ключ сайта ещё никому не передан — разумнее, чтобы администратор включил подключение сам, когда передаст ключ разработчику сайта.
2. **Новый ключ — прежний перестаёт подходить сразу** (Р17). Отсрочку на 24 часа из макета вернёт шаг 8, если владелец её захочет. До шага 8 ключи не проверяются вовсе.
3. **Прежняя таблица `api_tokens` остаётся в базе невидимой** (Р2). Удалить её насовсем можно отдельным выпуском, когда станет ясно, что клиники ничего туда не вписывали.
