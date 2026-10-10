# API клиники, шаг 4: филиалы — профиль здания, часы работы, показ на сайте (BRANCH_PROFILE_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Филиалы» становятся профилем зданий клиники для сайта, Symptex и партнёров:
- название, улица и ориентир на трёх языках;
- город и район из справочника (коды миграции 132);
- карта и маршрут;
- часы работы с предупреждением «каким врачам какое время закроется»;
- «показывать на сайте»;
- синхронизация зданий.

Документы, отчёты, касса и календарь показывают то же, что показывали.

**Architecture:**
- Новые колонки — в той же таблице `branches` (миграция 241, только ADD COLUMN). Часы — прежние `working_hours` / `is_24_7`: их уже читает движок записи (`slot-engine.js clinicWindow`), и он не меняется.
- **Одно место на адрес здания** (Р2). Главное здание держит свой адрес для партнёров, карту и телефон в «Компании» (шаг 3). Остальные здания — в «Филиалах» главного здания. Один общий помощник `overlayOwnBuilding` применяет это правило везде.
- Правила — в чистых общих модулях:
  - `public/js/shared/branch-hours.js` — сетка ⇄ колонки ⇄ движок;
  - `public/js/shared/branch-profile.js` — кто что правит, проверки, синхронизация, «скрытое здание прячет врачей».
  Их читают экран, `/api/db`, синхронизация зданий и RPC.
- Предупреждение о часах считает сервер (RPC `branch_hours_impact`) тем же движком, что слоты записи.
- Экран — своя страница внутри «Настроек» (список → страница здания) вместо общего редактора справочника. Переиспользуются карточки шага 3: `addressCard`, `mapCard`, `triGroup`.

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, `node:test`; клиент — ванильный JS без сборки, поддельный DOM в тестах видов.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — договор:
- «Решения владельца», включая 7–12 от 2026-10-10;
- «Правила, без которых не строим» — «Часы работы филиала»;
- «Порядок», шаг 4.

**Другие источники:**
- Макет — `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\js\screen-branches.js`: окно «Филиал», `geoProblem`, `hoursText`, `triDone`. Также `ref.js` (`geoCascade`, `fullAddress`), `core.js` (`tri()` — «нет перевода»), `mock.css`.
- Проверка влияния — `...\impact-review\02-branches-schedules.md` (все file:line сверены заново, см. «Сейчас в коде»), `01-clinic-identity.md`.
- Аудит соответствия макету (контролёр, 2026-10-10) — три пункта: одно место на адрес здания; скрытое здание прячет врачей; «нет перевода».

Номера строк сверены с деревом 2026-10-10 (HEAD `cb108ca3`). Перед правкой место всё равно находить заново.

**Метка кода:** `BRANCH_PROFILE_V1` — в комментарии каждой своей вставки. В общих файлах — обязательно: по ней коммитятся свои ханки. **Метка плана и его коммитов:** `CLINIC_API_STEP4_V1`.

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | **Колонки (миграция 241, ADD COLUMN):** `name_uz`, `name_en`, `country_code`, `region_code`, `district_code`, `street_ru/uz/en`, `landmark_ru/uz/en`, `maps_url` (тот же CHECK, что у мигр. 240), `show_public` (0/1, по умолчанию 1). Часы — прежние `working_hours` / `is_24_7`. | Те же имена колонок, что у адреса «Компании» (мигр. 240). Поэтому `addressCard` / `mapCard` шага 3 работают со строкой здания без переделки. |
| Р2 | **Одно место на адрес здания** (аудит, пункт 1; решение владельца 11: адрес — «из «Компании»»):<br>• **Главное здание:** адрес для партнёров (коды, улица), карта и телефон — в «Компании» главного здания (`doc_settings`, шаг 3). В «Филиалах» его строка помечена «Это здание» и показывает их оттуда только для чтения, с кнопкой «Изменить в «Компании»». Ориентир, названия здания, часы и показ на сайте — в «Филиалах»: в «Компании» их нет.<br>• **Остальные здания:** всё — в «Филиалах» главного здания (`branches`). Их собственная «Компания» показывает адрес для партнёров, карту и телефон для сайта из своей строки `branches` (она приезжает из главного) — только для чтения. Адрес, телефон и почта ДЛЯ ДОКУМЕНТОВ остаются своими у здания, как в шаге 3.<br>• Возвращается подсказка «Адреса других зданий — в «Филиалах».».<br>• Правило — один помощник `overlayOwnBuilding` (shared). Его зовут список, страница, выгрузка в филиалы, позже API (шаг 8).<br>• Сервер: в главном здании правка адреса, карты и телефона СВОЕЙ строки `branches` — 409 («меняются в «Компании»»). В филиале правка партнёрских колонок `doc_settings` — 409 («ведёт главное здание в «Филиалах»»). | Наоборот нельзя: «Компания» филиала в главное здание не едет — синхронизация идёт только из главного (`catalogue.js`). API клиники собирается в главном. Значит, адрес филиала может жить только в главном. Свой адрес главного — там, где владелец его уже вводит («Компания», шаг 3 и решение 11). |
| Р3 | **Прежнее поле «Адрес»** (`branches.address`, вписанное руками в старом редакторе) больше не правится — третьего адреса у здания не будет.<br>• Прежнее значение видно подсказкой «Прежний адрес из списка: …».<br>• Список показывает его, пока улица для партнёров пуста.<br>• Колонка остаётся (ADD COLUMN only) и пишется `/api/db`, как раньше. | Р2: одно место. Значение не теряется — оно перед глазами, пока его не перенесут в списки и улицу. |
| Р4 | **Названия.** `branches.name` — русское название. Его показывают выбор здания, календарь, касса, отчёты. По нему же:<br>• связываются здания (`rpc/branch-sync.js` проверка дублей, `pairing.js`);<br>• ищется здание при загрузке сотрудников (`section-import-export.js:1006`, `normKey`).<br>`name_uz` / `name_en` — наружу (API) и в списке «Филиалов» на языке интерфейса. Выбор здания, отчёты и прочие экраны — прежнее `name`. | Спецификация: «названия на uz/en … идут только наружу». Двадцать читателей `name` и ключ связи зданий не трогаются. |
| Р5 | **Печать не меняется.** Бланки печатают `doc_settings` здания (`a4-letterhead.js:49-62`, `rpc/clinic.js`, `telegram/render.js:89`). Данных `branches` на печати нет и не было. | Проверено; правило «документы печатают прежние имена» соблюдено без правок. |
| Р6 | **Часы — три способа:**<br>• «Не ограничивать» = `'{}'` — как сейчас у всех зданий;<br>• «Круглосуточно» = `is_24_7 = 1`;<br>• «По дням недели» = все семь дней `{on, from, to}`.<br>Ни одного рабочего дня — отказ: это закрыло бы здание целиком. Чтение — `clinicWindow` без изменений, тест сверяет каждое состояние сетки с движком.<br>Запись (`calendar_book`, `ensure_visit`) часов не проверяет — как сегодня: часы перестают ПРЕДЛАГАТЬ время, а не отказывают. Тест это закрепляет, текст предупреждения говорит это прямо. | «Пусто = без ограничений (как сейчас)». Движок не меняется, поэтому слоты и календарь читают часы так же, как сегодня. |
| Р7 | **Предупреждение.**<br>• RPC `branch_hours_impact` — только счёт, тем же движком (`dayWindow → clinicWindow → clampWindow → windowSegments`).<br>• Врачи — с `users.branch_id` = это здание, работающие (`is_active = 1`), «врач» — по правилу колонок календаря (`room-calendar.js:283`), как у `resourceWindow`.<br>• Зовётся, когда новые часы «По дням недели» и строка уже есть. «Не ограничивать» и «Круглосуточно» никому время не закрывают.<br>• Ворота — право записи в `branches` (`write-grant.js tableWriteAllowed`): нового ключа в `gate-fallbacks` нет. | Спецификация: «перед сохранением экран показывает, каким врачам какое время закроется». Один движок — нет второй правды о том, что свободно. |
| Р8 | **Кто правит.** Главное здание — всё. Филиал — «Филиалы» только видны: 409 сервером на название, телефон, профиль, часы и показ любой строки и на новое здание; RPC — 409. «Филиалы: Изменение» не у администратора правит и часы — описание права теперь это говорит. | Спецификация: «часы правит только главное здание»; «главное здание правит, филиалы читают» (шаг 3, Р10). |
| Р9 | **Синхронизация (`catalogue.js` roster).**<br>• Строка списка сети несёт `phone` и 13 колонок профиля, а также отметку `hours_by_main: 1`. Несёт только главное здание.<br>• Филиал принимает их для ВСЕХ букв, включая свою. Часы своей буквы — только с отметкой.<br>• Ключа нет — местное остаётся: это главная старше шага 4.<br>• Колонки нет — пропуск: база филиала до 241.<br>• Значение, которое база не примет (null, чужой тип, не Яндекс Карты, `show_public` 2, длина), — пропуск, а не падение приёма.<br>• Главное здание уезжает с адресом, картой и телефоном из своей «Компании» (`overlayOwnBuilding`). | Как 9dde74bf шага 3: не писать NULL в NOT NULL, не выгружать несуществующее. Приём справочника — ОДНА транзакция: сбой здесь остановил бы и прайс, и сотрудников. Отметка не даёт старой главной (она шлёт `'{}'` чужого для неё здания) затереть свои часы филиала. |
| Р10 | **«Показывать на сайте»** (`show_public`, по умолчанию 1). Внутри программы не меняет ничего.<br>Скрытое здание прячет и своих врачей (аудит, пункт 2; макет: «его врачи тоже не показываются»):<br>• правило — `branchAllowsDoctor(doctor, branchesById)` в `branch-profile.js`;<br>• данные — `branches.show_public` и `users.branch_id`;<br>• читают шаг 5 (публикация врача) и шаг 8 (API). | Решение и флаг — здесь, чтобы шаги 5 и 8 не придумывали своё. |
| Р11 | **«нет перевода»** у пустых UZ / EN названия и улицы, у ориентира — нет (аудит, пункт 3; макет `core.js tri()` / `noMiss`). Общий компонент уже умеет: `triGroup({ markMissing })` в `0f54eb06` (полировка шага 3). Здесь — использовать (задача 9 проверяет). | Один компонент на «Компанию», «Филиалы» и следующие шаги. |
| Р12 | **Страница вместо окна.** Макет рисует окно 920 px. Здесь — страница в «Настройках»: список → страница здания → «К списку филиалов». Список — карточками. | Карточки шага 3 переиспользуются как есть. На ширине телефона — один столбец без прокрутки внутри окна. Таблица из восьми колонок на телефоне — прокрутка вбок. |
| Р13 | **Прежний облачный адрес `#settings:branches`** (форма `sections.js:711-764` через `admin.js:1260-1262`) ведёт в хаб настроек (`LEGACY_ROUTES`). | После миграции 241 он писал бы `name_uz` / `name_en` и часы мимо предупреждения и проверок. |
| Р14 | **Смешанные версии:**<br>• **старая главная → новый филиал:** профиля в выгрузке нет — местное остаётся. Отметки нет — свои часы филиала не трогаются, как сегодня.<br>• **новая главная → старый филиал:** старый приём читает из строки сети только `letter / name / working_hours / is_24_7` (`catalogue.js:646-672`) — лишние ключи безвредны. Свои часы он не принимает, пока не обновится: до обновления календарь филиала часы его здания не сужает, а главное — сужает. Владельцу — сказать. | Тесты на оба направления, на базах до 241 (`migratedBefore`) и на выгрузке старого вида. |

**Отметки для следующих шагов:**
- **Шаг 5** (публикация врача): врач скрытого здания не публикуется — `branchAllowsDoctor`.
- **Шаг 7:** решение владельца 11 («адрес обязателен при включённом подключении API») касается и показываемых зданий. Здание с `show_public = 1` без полного адреса для партнёров — так же отказ включения.
- **Шаг 8** (API) читает здания так:
  - `branches`, где `active = 1` и `show_public = 1`;
  - главное здание — через `overlayOwnBuilding`;
  - врачи — через `branchAllowsDoctor`.

## Карта файлов

**Создаются:**
- Миграция: `server/db/migrations/241_branch_profile.sql`, `server/db/migrations/241.test.js`.
- Общие модули:
  - `public/js/shared/branch-hours.js` (+ `branch-hours.test.js`) — сетка ⇄ колонки ⇄ движок;
  - `public/js/shared/branch-profile.js` (+ `branch-profile.test.js`) — колонки, проверки, «главное — из «Компании»», «скрытое здание прячет врачей».
- Сервер: `server/services/rpc/branch-hours.js` (+ `branch-hours.test.js`) — RPC `branch_hours_impact`.
- Виды:
  - `public/js/admin/views/week-hours.js` — сетка «день: с — до» (её же берут «Сотрудники»);
  - `public/js/admin/views/branch-hours-card.js` — «Часы работы» и предупреждение;
  - `public/js/admin/views/branch-page.js` — страница здания;
  - `public/js/admin/views/branches-editor.js` — список «Филиалов».
- Тесты: `server/routes/branches-guard.test.js`, `public/js/admin/__tests__/week-hours.test.mjs`, `public/js/admin/__tests__/branches-screen.test.mjs`.

**Меняются:**
- Сервер:
  - `server/db/schema-registry.js` (:481-485);
  - `server/routes/db.js` (рядом с :357-374, :653-698);
  - `server/services/rpc/index.js` (:47, :281-286);
  - `server/services/rpc/clinic.js`;
  - `server/services/branch-sync/catalogue.js` (:24, :409-417, :436-437, :607-674).
- Права и словарь: `public/js/shared/permission-catalog.js` (:382), `public/js/shared/clinic-profile.js`, `public/js/admin/i18n-strings.js`.
- Экраны:
  - `public/js/admin/views/company-address.js`, `documents-settings.js`;
  - `employees.js` (:59, :1513-1526);
  - `settings-hub.js` (:47, :61-66, :302, :667-675, :1149-1191);
  - `public/js/admin.js` (LEGACY_ROUTES :400-431).
- Стили: `public/css/admin-views.css` (в конец).
- Тесты:
  - `server/db/schema-registry.test.js`, `server/db/write-grant.test.js`;
  - `server/services/branch-sync/catalogue.test.js`, `server/services/rpc/clinic.test.js`;
  - `server/routes/company-secondary.test.js`;
  - `public/js/admin/__tests__/company-profile.test.mjs`, `db-query-schema.test.mjs` (BASELINE), `settings-hub-groups.test.mjs` (комментарий).

---

## Сейчас в коде (сверено 2026-10-10)

- **Таблица:**
  - `branches` — M002:1-12 (`working_hours TEXT NOT NULL DEFAULT '{}'`, `is_24_7`, `phone`, `address`, `license_number`, `active`);
  - `letter` — M080:18, `branches_letter_uniq … COLLATE NOCASE` — M080:60.
  - Триггеров нет; в журнале записей между зданиями `branches` нет.
- **Реестр `branches`** — `schema-registry.js:481-485`:
  - чтение без `letter` и `license_number`;
  - запись — администратор и `grant: 'settings.branches'`;
  - `working_hours` не объявлена JSON — клиент шлёт строку (`query-compiler.js:43-47`, :79-81).
  - Право — `permission-catalog.js:382` (`enforced: 'db:branches'`, без `adminDefault`).
- **Редактор:**
  - сегодня — общий справочник `settings-hub.js` `LOOKUP_CONFIG.branches` :667-675: название, телефон, адрес; `select('*')` :1202-1203; сохранение :1443-1445; пустые поля не шлются :1427;
  - карточка связи зданий над списком — :1149-1152, :1166, :1187-1191, только полному доступу;
  - плитка — :302, разводка разделов — `repaint()` :61-66 (образец — «Роли»).
- **Облачная форма** `sections.js:711-764` (`name_ru/uz/en`, `address_*`, `yandex_map_url`, `weekly_hours`):
  - всё ещё открывается адресом `#settings:branches` (`admin.js:1260-1262` → `renderSectionCrud`), её нет в `LEGACY_ROUTES` (`admin.js:400-431`);
  - сохраняет в `/api/db` и затем зовёт облачный шлюз (`section-crud.js:2488-2491`).
- **Движок:** `server/services/rpc/slot-engine.js`.
  - `dayIsOn` :101-106 — `enabled` сильнее `on`, без флага — включён.
  - `dayWindow` :116-152: нет графика или `'{}'` — 09:00–18:00 каждый день, включая воскресенье; дня нет в заполненном — выходной; `to <= from` — выходной; обед — только `lunchEnabled`.
  - `clinicWindow` :159-186: `is_24_7` или `'{}'` / пусто / не JSON — границы нет; дня нет или выключен — ЗАКРЫТО; нет «с» — 0, нет «до» — 24:00; обед здания не читается.
  - `clampWindow` :192-200; `parseHhmm('24:00')` → null.
- **Календарь:** `server/services/rpc/calendar.js`.
  - `resourceWindow` :360-372 — здание врача только из `users.branch_id`: `user_branches` не читается, кабинеты часами здания не сужаются.
  - `calendarSlots` :731, `calendarWindows` :835-889.
  - `calendarBook` :929 проверяет только пересечения (:1044-1052), не часы. `ensure_visit` (`visits.js:92-104 slotConflict`) — тоже.
- **Синхронизация:** `server/services/branch-sync/catalogue.js`.
  - `DOC_SETTINGS_COLUMNS` :48-60; выгрузка `doc_settings` :379-387 (`col in settings` — 9dde74bf).
  - Список сети: выгрузка :409-417 (`letter, name, working_hours, is_24_7`); роль установки читается позже, :436-437.
  - Приём :607-674:
    - строка без строкового имени пропускается (:646);
    - незнакомая буква заводится с `active = 0` (:636);
    - часы — только чужой буквы (:663);
    - имя — любой буквы, включая свою (:670).
  - Тесты списка: `catalogue.test.js:500-578`; помощник `migratedBefore` — :885.
- **`/api/db`:** `server/routes/db.js`.
  - 409 по `MAIN_CLINIC_TABLES` :343-348 — в списке только `role_permissions` и `role_grant_reviews` (`schema-registry.js:1835-1843`), `branches` нет: в филиале здания сегодня правятся, и имя откатывается синхронизацией.
  - `companyBranchRefusal` :660-668 (вызов :357), `geoCodeRefusal` (вызов :366, REFERENCE_LISTS_V1 `cb108ca3`), `companyProfileRefusal` :688-698 (вызов :373), `isSecondary` :653-655.
- **Шаг 3 в дереве:**
  - `clinic-profile.js` (`COMPANY_CLINIC_WIDE` / `COMPANY_BUILDING`, валидаторы, `composeAddress`, `routeUrl`, `storedProfileProblems`);
  - `geo-cascade.js` (режим кодов, «(не используется)»);
  - `company-address.js` (`addressCard` / `mapCard`);
  - `company-fields.js` (`triGroup` с `markMissing` — `0f54eb06`, `labeled`, `fieldErr`);
  - `documents-settings.js` (карточки адреса и карты :166-169, `load()` :368, сохранение только изменённого :418);
  - `rpc/clinic.js` (`building_role`).
- **Сотрудники:** `employees.js` `buildHours` :1513-1526 пишет день `{on, from, to}` (только тронутый день), `DAYS` :59 больше нигде.
- **Права записи:** `write-grant.js tableWriteAllowed` :174 — образец ворот без нового ключа (шаг 3, `f8014383`).
- **Коды географии неизменны** (`cb108ca3`, REFERENCE_LISTS_V1): `/api/db` не даёт менять и стирать код строки справочника и удалять строку бланка (`server/services/geo-codes-guard.js`, `public/js/shared/geo-codes.js`). Поэтому код, сохранённый в `branches`, не «уплывёт». Свои строки клиники с кодом тоже бывают — проверка кода в `branch-profile.js` поэтому только по форме, без сверки со списком бланка.

**Что в заметке проверки влияния устарело:**
- 9dde74bf `branches` не трогал.
- Свой адрес здания с мигр. 240 живёт и в `doc_settings` — отсюда Р2.
- `ensure_visit` вставляет визит на `visits.js:266-267`, откат при отказе — :377-391.
- CRM теперь читает `scheduling_mode` (`crm.js:1806-1811`).
- Импорт сотрудников ищет здание по `normKey(name)` (`section-import-export.js:1006`, :2030), а не точным совпадением.
- `views/visits.js:34` мёртв.

---

## Правила рабочего дерева (читать до первого шага)

**Дерево:** отдельный клон `C:\Users\user\Desktop\implementation workflow\easymed.api`, ветка `feat/clinic-api-step4` (от основной линии `f8014383`, в ней шаг 3).
- В клоне `core.autocrlf=false` и своя копия `node_modules`. Это не worktree; ветку не переключать.
- Origin — локальный `easymed.lisproxy`.

**В клоне работают и другие сборщики.** 2026-10-10 — полировка шагов 2–3 по макету (`CLINIC_PROFILE_V1`, `REFERENCE_LISTS_V1`): коммиты `0f54eb06`, `d8276b20`, `989ebc33`, `387d163c`, `cb108ca3`; в работе бывали незакоммиченные правки `documents-settings.js` и `company-profile.test.mjs`. Поэтому:
- Перед каждым коммитом:
  1. `git status --short`.
  2. `git diff --cached --name-only` должен быть пуст. Если нет — кто-то собирает коммит: подождать, ничего не снимать.
- Для каждого своего файла: `git diff -U0 -- <файл>`. Чужих ханков нет — `git add <файл>`.
- Чужие ханки есть — только свои ханки по метке:
  `git diff -U0 -- F | node <скретчпад>/keep-hunks-v2.mjs BRANCH_PROFILE_V1 > own.patch; git apply --cached --check --unidiff-zero own.patch; git apply --cached --unidiff-zero own.patch`.
  - Это касается общих файлов: `i18n-strings.js`, `admin-views.css`, `documents-settings.js`, `company-address.js`, `company-profile.test.mjs`, `settings-hub.js`, `admin.js`, `routes/db.js`, `schema-registry.js`, `rpc/index.js`.
  - После этого проверить: `git diff --cached -- F` показывает свой блок на месте, `git diff -U0 -- F` — только чужие ханки.
  - Скрипта нет в скретчпаде — восстановить из `docs/plans/2026-09-28-lis-mindray-codes.md` с правкой v2 (память `easymed-shared-tree-hunk-commits`).
- Задачи 10–11 правят те же файлы, что полировка (`company-address.js`, `documents-settings.js`, `company-profile.test.mjs`). Пока у полировки есть незакоммиченные ханки в файле, свои ханки этого файла — только по метке. Не выходит — остановиться и доложить (BLOCKED).

**Запрещено:**
- `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`.
- Трогать запущенные серверы (:8000, :8712) и каталог `data/`.
- Пушить и ставить тег — это делает контролёр.

**Миграция — 241.** Перед созданием — `ls server/db/migrations | tail -4`. Занят — взять следующий свободный, переименовать файл, тест и упоминания. Пропуски не заполнять (`migrate.js`, `migration-order.test.js`).

**Файлы и коммиты:**
- Файлы — LF.
- Сообщение коммита — файлом:
  - Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/branch-profile-<N>.txt`;
  - затем `git commit -F <файл>`.
- Сообщение — по-русски, с меткой в скобках; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

**Тесты:**
- Только явными путями, из корня клона:
  - `node --test <файлы>` — серверные и `public/js/shared/*.test.js`;
  - `node --experimental-vm-modules --test <файлы>` — клиентские `.mjs`.
- Каталог аргументом не передавать (Node 24 на Windows).
- Харнессы экранов задают `localStorage['admin.lang'] = 'ru'` до импорта видов (ловушка локали CI).

**Текст и вид:**
- Каждая новая строка интерфейса и каждое сообщение сервера — статьёй ru / uz / en в `i18n-strings.js`, с хвостом `// BRANCH_PROFILE_V1`.
- Перед добавлением — `grep -n '^  "<ключ>":' public/js/admin/i18n-strings.js`: статья есть — не дублировать.
- Узбекский и английский — без кириллицы (`i18n-uz-quality`).
- Русский текст не склеивать с переменными: шаблон `{x}` + `trf()`.
- Данные клиники (названия, адреса, имена врачей) — `document.createTextNode`, не через `tr()`.
- Размеры шрифта — только 12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40 (`type-scale`).
- Значки — только `Icon()` из `icon-map.js`: Building, MapPin, Phone, Clock, Flag, Globe, Info, Warning, Lock, Plus, ChevronLeft, Check. Без эмодзи.
- Вёрстка — без фиксированных ширин больше 320 px. Сетки — `repeat(auto-fill, minmax(min(100%, …px), 1fr))`; на ширине телефона — один столбец.

**Полный прогон** делает контролёр после всех задач («Завершение»). Во время работы — только файлы тестов задачи и названные сторожа.

**Ответы владельца** (когда придут) — вписать блоком сюда, с номерами задач, которые они меняют. Исходные вопросы остаются внизу, для истории (как в плане шага 3).

---

## Task 1: Миграция 241 — профиль здания в branches (BRANCH_PROFILE_V1)

**Files:**
- Create: `server/db/migrations/241_branch_profile.sql`, `server/db/migrations/241.test.js`

- [ ] **Step 1: падающий тест** `server/db/migrations/241.test.js`:

```js
// BRANCH_PROFILE_V1 (мигр. 241) — ПРОФИЛЬ ЗДАНИЯ: только ADD COLUMN.
//
// Новые колонки пусты, «показывать на сайте» — 1; прежние поля, буквы зданий
// и часы не тронуты; строк столько же. CHECK — запасной замок для /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore241() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig241-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 241)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const TEXT = ['name_uz', 'name_en', 'country_code', 'region_code', 'district_code',
  'street_ru', 'street_uz', 'street_en', 'landmark_ru', 'landmark_uz', 'landmark_en', 'maps_url'];
const WH = JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' } });

test('241: колонки профиля здания добавлены пустыми, «на сайте» — 1; прежнее и буквы не тронуты', () => {
  const db = dbBefore241();
  db.prepare("UPDATE branches SET name = 'Главный корпус', phone = '+998712000000', address = 'ул. Мира, 1', working_hours = ?, is_24_7 = 0 WHERE letter = 'A'").run(WH);
  db.prepare("INSERT INTO branches (name, letter, active, is_24_7) VALUES ('Стационар', 'C', 0, 1)").run();
  const before = db.prepare('SELECT * FROM branches ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM branches ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => {
    for (const c of TEXT) assert.equal(row[c], '', c + ' пуста');
    assert.equal(row.show_public, 1, 'прежние здания видны на сайте, как в макете');
    for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k);
  });
});

test('241: CHECK — карта только Яндекса, «на сайте» — 0 или 1', () => {
  const db = openDb(':memory:'); migrate(db);
  const set = (col, v) => db.prepare(`UPDATE branches SET ${col} = ? WHERE letter = 'A'`).run(v);
  for (const [col, bad, good, back] of [
    ['maps_url', 'https://maps.google.com/x', 'https://yandex.uz/maps/-/CDabc', ''],
    ['show_public', 2, 0, 1],
  ]) {
    assert.throws(() => set(col, bad), /CHECK/, col + ' = ' + bad);
    set(col, good);
    set(col, back);
  }
});
```

- [ ] **Step 2:** `node --test server/db/migrations/241.test.js` → падает (нет колонок).
- [ ] **Step 3: миграция** `server/db/migrations/241_branch_profile.sql`:

```sql
-- 241 — BRANCH_PROFILE_V1 (2026-10-10): ПРОФИЛЬ ЗДАНИЯ КЛИНИКИ (шаг 4 API
-- клиники, docs/specs/2026-10-06-clinic-api-design.md; план
-- docs/plans/2026-10-10-clinic-api-4-branches.md).
--
-- ТОЛЬКО ADD COLUMN, бэкфилла нет: branches не пересобирается (буква здания и
-- её UNIQUE-индекс мигр. 080 на месте), здания после обновления работают так
-- же. Часы работы — прежние working_hours / is_24_7 (мигр. 002): их читает
-- движок записи (slot-engine.js clinicWindow), и он не меняется.
--
-- name остаётся тем, что показывает программа (выбор здания, календарь,
-- касса, отчёты) и по чему связываются здания. Новое — рядом и наружу (сайт,
-- Symptex, партнёры): названия uz/en; адрес для партнёров — кодами
-- справочника (мигр. 132), улица и ориентир на трёх языках; карта; «показывать
-- на сайте». Адрес для партнёров, карта и телефон ГЛАВНОГО здания живут в его
-- «Компании» (doc_settings, мигр. 240) — в его строке здесь они не правятся
-- (shared/branch-profile.js OWN_FROM_COMPANY): одно место на здание.
-- CHECK — запасной замок для /api/db: экран и сервер проверяют то же раньше.

ALTER TABLE branches ADD COLUMN name_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN name_en TEXT NOT NULL DEFAULT '';

-- Адрес для партнёров: коды countries.code / regions.code / districts.code
-- (мигр. 132), улица и ориентир на трёх языках.
ALTER TABLE branches ADD COLUMN country_code  TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN region_code   TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN district_code TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN street_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN street_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN street_en TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN landmark_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN landmark_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN landmark_en TEXT NOT NULL DEFAULT '';

ALTER TABLE branches ADD COLUMN maps_url TEXT NOT NULL DEFAULT ''
  CHECK (maps_url = '' OR maps_url LIKE 'https://yandex.%' OR maps_url LIKE 'https://www.yandex.%' OR maps_url LIKE 'https://maps.yandex.%');

-- 1 — здание видно на сайте клиники, в Symptex и у партнёров; 0 — скрыто, и
-- его врачи тоже (shared/branch-profile.js branchAllowsDoctor). Внутри
-- программы не меняет ничего.
ALTER TABLE branches ADD COLUMN show_public INTEGER NOT NULL DEFAULT 1 CHECK (show_public IN (0, 1));
```

- [ ] **Step 4:** тест зелёный. Сторожа:
  - `server/db/migration-order.test.js`, `server/db/migrate.test.js`;
  - `server/db/migrations/002.test.js`, `080.test.js`, `099.test.js`;
  - `server/services/branch-sync/identity.test.js`, `letters.test.js`.
- [ ] **Step 5: коммит** «Филиалы: колонки профиля здания — названия UZ/EN, адрес кодами справочника, улица и ориентир на трёх языках, карта, показ на сайте (миграция 241, BRANCH_PROFILE_V1)».

---

## Task 2: Реестр и право «Филиалы» — профиль читается и пишется; базовая линия запросов (BRANCH_PROFILE_V1)

**Files:**
- Modify: `server/db/schema-registry.js` (:481-485)
- Modify: `public/js/shared/permission-catalog.js` (:382 — `desc`, `levelDesc`)
- Modify: `public/js/admin/__tests__/db-query-schema.test.mjs` (BASELINE :545-548)
- Test: `server/db/schema-registry.test.js`, `server/db/write-grant.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающие тесты.**
  - `schema-registry.test.js` (в импорте уже есть `readableColumns`, `writableColumns`):

```js
// BRANCH_PROFILE_V1 (mig 241) — профиль здания читают все, пишет право «Филиалы».
test('branches: профиль здания (мигр. 241) — в чтении, вставке и правке; name_ru нет', () => {
  const cols = ['name_uz', 'name_en', 'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz',
    'street_en', 'landmark_ru', 'landmark_uz', 'landmark_en', 'maps_url', 'show_public'];
  for (const c of cols) {
    assert.ok(readableColumns('branches').includes(c), 'чтение ' + c);
    assert.ok(writableColumns('branches', 'insert').includes(c), 'вставка ' + c);
    assert.ok(writableColumns('branches', 'update').includes(c), 'правка ' + c);
  }
  assert.ok(!readableColumns('branches').includes('name_ru'), 'RU — это name (db-query-schema.test.mjs:721-743 держит это)');
});
```

  - `write-grant.test.js` (помощники `seed` / `addGrants` / `run` / `refused` / `REG` — в файле):

```js
// BRANCH_PROFILE_V1 — «Филиалы: Изменение» пишет профиль здания и часы; без права — отказ.
test('регистратура с «Филиалы: Изменение» правит профиль здания и часы', () => {
  const db = seed();
  try {
    const CASHIER = { id: 52, role: 'cashier', extra_roles: [] };
    assert.throws(() => run(db, { table: 'branches', op: 'update', values: { name_uz: 'X' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, CASHIER), refused);
    addGrants(db, 'registrar', { settings: 'view', 'settings.branches': 'edit' });
    run(db, { table: 'branches', op: 'update', values: { name_uz: 'Bosh bino', street_ru: 'ул. Мира, 1', show_public: 0, working_hours: '{}' },
      filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG);
    const r = db.prepare('SELECT name_uz, street_ru, show_public FROM branches WHERE id = 1').get();
    assert.deepEqual({ ...r }, { name_uz: 'Bosh bino', street_ru: 'ул. Мира, 1', show_public: 0 });
  } finally { db.close(); }
});
```

- [ ] **Step 2:** `node --test server/db/schema-registry.test.js server/db/write-grant.test.js` → новые падают.
- [ ] **Step 3: реестр** — строки :481-485 заменить:

```js
  // BRANCH_PROFILE_V1 (mig 241) — профиль здания для сайта и партнёров:
  // названия uz/en, адрес кодами справочника (мигр. 132) с улицей и ориентиром
  // на трёх языках, карта, показ на сайте. name остаётся тем, что показывает
  // программа. Пишет то же право «Филиалы»; в филиале общее не меняется, у
  // своего здания главного адрес, карта и телефон — в «Компании» (routes/db.js,
  // 409); формат — shared/branch-profile.js storedBranchProblems.
  branches: { read:{roles:ALL_STAFF, columns:['id','name','phone','address','is_24_7','working_hours','active','created_at',
                'name_uz','name_en','country_code','region_code','district_code','street_ru','street_uz','street_en',
                'landmark_ru','landmark_uz','landmark_en','maps_url','show_public']},   // BRANCH_PROFILE_V1 (mig 241)
              write:{ grant:'settings.branches',
                      insert:{roles:['admin'],columns:['name','phone','address','license_number','is_24_7','working_hours',
                        'name_uz','name_en','country_code','region_code','district_code','street_ru','street_uz','street_en',
                        'landmark_ru','landmark_uz','landmark_en','maps_url','show_public']},   // BRANCH_PROFILE_V1
                      update:{roles:['admin'],columns:['name','phone','address','license_number','is_24_7','working_hours','active',
                        'name_uz','name_en','country_code','region_code','district_code','street_ru','street_uz','street_en',
                        'landmark_ru','landmark_uz','landmark_en','maps_url','show_public']},   // BRANCH_PROFILE_V1
                      delete:{roles:[]} },
              filters:['id','active'], embed:{} },
```

- [ ] **Step 4: право.** В строке `settings.branches` (`permission-catalog.js:382`) — только тексты, ключ и уровни прежние:
  - `desc: 'Здания клиники: адреса, карта, часы работы, показ на сайте.'`
  - `levelDesc: { edit: 'Заводит и правит здания: названия, адреса, телефоны, карту, часы работы, показ на сайте. Часы ограничивают время приёма врачей здания. Связь зданий — только администратор.' }`.

  Хвост строки — `// BRANCH_PROFILE_V1 — часы закрывают время врачам: роль должна знать, что выдаёт`.
- [ ] **Step 5: базовая линия** `db-query-schema.test.mjs`. Из `BASELINE` убрать две строки:
  - `"public/js/admin/setup-checklist.js | branches | column \"name_en\""`;
  - `"public/js/admin/setup-checklist.js | branches | column \"name_uz\""`.

  Колонки теперь есть, записи устарели («ЭТОТ СПИСОК МОЖЕТ ТОЛЬКО СОКРАЩАТЬСЯ»). `name_ru` и `district` остаются.
- [ ] **Step 6: словарь:**

| ru | uz | en |
|---|---|---|
| Здания клиники: адреса, карта, часы работы, показ на сайте. | Klinika binolari: manzillar, xarita, ish vaqti, saytda ko‘rsatish. | Clinic buildings: addresses, map, working hours, showing on the website. |
| Заводит и правит здания: названия, адреса, телефоны, карту, часы работы, показ на сайте. Часы ограничивают время приёма врачей здания. Связь зданий — только администратор. | Binolarni qo‘shadi va tahrirlaydi: nomlar, manzillar, telefonlar, xarita, ish vaqti, saytda ko‘rsatish. Ish vaqti bino shifokorlarining qabul vaqtini cheklaydi. Binolarni bog‘lash — faqat administrator. | Adds and edits buildings: names, addresses, phones, map, working hours, showing on the website. Working hours limit the appointment time of the building’s doctors. Linking buildings is administrator only. |

- [ ] **Step 7:** тесты зелёные. Сторожа:
  - сервер: `server/db/schema-registry-conformance.test.js`, `star-meets-schema.test.js`, `server/services/grants.test.js`, `server/services/gate-fallbacks.test.js`;
  - клиент: `public/js/admin/__tests__/db-query-schema.test.mjs`, `role-reports-settings.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 8: коммит** «Филиалы: профиль здания читается всеми и пишется правом «Филиалы»; описание права говорит про часы (BRANCH_PROFILE_V1)».

---

## Task 3: Общий модуль часов здания — сетка ⇄ колонки ⇄ движок записи (BRANCH_PROFILE_V1)

**Files:**
- Create: `public/js/shared/branch-hours.js`, `public/js/shared/branch-hours.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `public/js/shared/branch-hours.test.js`:

```js
// BRANCH_PROFILE_V1 — часы здания: сетка экрана ⇄ колонки branches ⇄ движок
// записи. Движок (slot-engine.js clinicWindow) не меняется — тест сверяет с ним
// каждое состояние сетки, поэтому слоты читают часы так же, как сегодня.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WEEK, blankDays, readBranchHours, writeBranchHours, hoursProblem, storedHoursProblem, hoursGroups, HOURS_MESSAGES } from './branch-hours.js';
import { clinicWindow, WEEKDAY_KEYS } from '../../../server/services/rpc/slot-engine.js';
import { STRINGS } from '../admin/i18n-strings.js';

const engine = (cols) => WEEK.map((k) => clinicWindow(cols, WEEKDAY_KEYS.indexOf(k)));

test('«Не ограничивать» и «Круглосуточно» — движок не ставит границы ни в один день', () => {
  assert.deepEqual(writeBranchHours({ mode: 'none', days: blankDays() }), { working_hours: '{}', is_24_7: 0 });
  assert.deepEqual(writeBranchHours({ mode: 'allday', days: blankDays() }), { working_hours: '{}', is_24_7: 1 });
  for (const mode of ['none', 'allday']) {
    assert.deepEqual(engine(writeBranchHours({ mode, days: blankDays() })), WEEK.map(() => undefined), mode);
  }
});

test('по дням недели: пишутся все семь дней; неотмеченный — закрыт, часы дня — окно', () => {
  const days = blankDays();
  days.sat = { on: true, from: '09:00', to: '15:00' };
  const cols = writeBranchHours({ mode: 'week', days });
  assert.deepEqual(Object.keys(JSON.parse(cols.working_hours)), WEEK);
  assert.equal(cols.is_24_7, 0);
  const w = engine(cols);
  assert.deepEqual(w.slice(0, 5), [0, 1, 2, 3, 4].map(() => ({ from: 540, to: 1080 })));
  assert.deepEqual(w[5], { from: 540, to: 900 });
  assert.equal(w[6], null, 'воскресенье закрыто');
  assert.equal(storedHoursProblem(cols.working_hours), '');
});

test('прочитанное и записанное обратно — то же окно движка (и для старой формы с enabled)', () => {
  for (const [wh, is24] of [
    ['{}', 0], ['', 0], ['не json', 0], ['{}', 1],
    [JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' }, tue: { enabled: false, from: '08:00', to: '17:00' } }), 0],
    [JSON.stringify({ mon: { on: true, from: '10:00', to: '19:00' }, sun: { on: true, from: '10:00', to: '14:00' } }), 0],
    [JSON.stringify({ wed: { from: '07:30', to: '12:00' } }), 0],   // без флага — день включён (dayIsOn)
  ]) {
    const back = writeBranchHours(readBranchHours(wh, is24));
    assert.deepEqual(engine(back), engine({ working_hours: wh, is_24_7: is24 }), wh + ' / ' + is24);
  }
});

test('экран: ни одного рабочего дня — объяснение; конец раньше начала — объяснение с днём', () => {
  const days = blankDays();
  for (const k of WEEK) days[k] = { ...days[k], on: false };
  assert.deepEqual(hoursProblem({ mode: 'week', days }), { template: HOURS_MESSAGES.noDay, day: null });
  days.tue = { on: true, from: '18:00', to: '09:00' };
  assert.deepEqual(hoursProblem({ mode: 'week', days }), { template: HOURS_MESSAGES.order, day: 'tue' });
  days.tue = { on: true, from: '09:00', to: '18:00' };
  assert.equal(hoursProblem({ mode: 'week', days }), null);
  assert.equal(hoursProblem({ mode: 'none', days }), null);
});

test('сервер: в базу — только то, что пишет экран (семь дней, ровно on/from/to)', () => {
  const good = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;
  for (const ok of [good, '{}', '']) assert.equal(storedHoursProblem(ok), '');
  const o = JSON.parse(good);
  for (const bad of [
    JSON.stringify({ mon: o.mon }),                                           // не все дни
    JSON.stringify({ ...o, mon: { ...o.mon, enabled: false } }),              // «enabled» движок прочёл бы раньше «on»
    JSON.stringify({ ...o, mon: { on: 'да', from: '09:00', to: '18:00' } }),
    JSON.stringify({ ...o, mon: { on: true, from: '9:00', to: '18:00' } }),
    JSON.stringify({ ...o, mon: { on: true, from: '18:00', to: '09:00' } }),
    JSON.stringify(Object.fromEntries(WEEK.map((k) => [k, { on: false, from: '09:00', to: '18:00' }]))),   // ни одного рабочего дня
    '[1,2]', 'не json', 42,
  ]) assert.equal(storedHoursProblem(bad), HOURS_MESSAGES.stored, String(bad));
});

test('список: подряд идущие дни с одинаковыми часами — одной группой', () => {
  const days = blankDays();
  days.sat = { on: true, from: '09:00', to: '15:00' };
  assert.deepEqual(hoursGroups({ mode: 'week', days }), [
    { from: 'mon', to: 'fri', hours: '09:00–18:00' },
    { from: 'sat', to: 'sat', hours: '09:00–15:00' },
  ]);
  assert.deepEqual(hoursGroups({ mode: 'none', days }), []);
});

test('каждое сообщение модуля переведено на ru / uz / en с теми же {дырками}', () => {
  for (const m of Object.values(HOURS_MESSAGES)) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
    for (const hole of m.match(/\{\w+\}/g) || []) assert.ok(e.uz.includes(hole) && e.en.includes(hole), m + ' теряет ' + hole);
  }
});
```

- [ ] **Step 2:** `node --test public/js/shared/branch-hours.test.js` → падает (нет модуля).
- [ ] **Step 3: модуль** `public/js/shared/branch-hours.js`:

```js
// BRANCH_PROFILE_V1 — ЧАСЫ РАБОТЫ ЗДАНИЯ: сетка экрана «Филиалы» ⇄ колонки
// branches.working_hours / is_24_7, ровно в том виде, в каком их читает движок
// записи (server/services/rpc/slot-engine.js clinicWindow):
//   • is_24_7 = 1 — границы нет («Круглосуточно»);
//   • '{}' или пусто — границы нет («Не ограничивать», как у всех зданий до шага 4);
//   • заполненный распорядок — день без отметки ЗАКРЫТ для каждого врача этого
//     здания, часы дня сужают его окно (rpc/calendar.js resourceWindow).
// Экран пишет все семь дней {on, from, to}: какой день закрыт — видно в самой
// строке, а не по отсутствию ключа. Обеда у здания нет — движок его не читает.
//
// Чистый модуль: его читают экран, /api/db (storedHoursProblem) и RPC
// branch_hours_impact. Сообщения — ключи словаря.

export const WEEK = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const HOURS_MODES = Object.freeze(['none', 'week', 'allday']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEYS = 'from,on,to';

export const HOURS_MESSAGES = Object.freeze({
  noDay:  'Отметьте хотя бы один рабочий день или выберите «Не ограничивать».',
  order:  '{day}: время окончания должно быть позже начала.',
  stored: 'Часы работы здания записаны неверно: нужны все семь дней недели, у каждого — отметка и время «с» и «до», и хотя бы один рабочий день.',
});

const defaultDay = (k) => ({ on: k !== 'sat' && k !== 'sun', from: '09:00', to: '18:00' });
/** Пн–Пт 09:00–18:00, суббота и воскресенье — выходные: с этого начинается сетка. */
export function blankDays() { return Object.fromEntries(WEEK.map((k) => [k, defaultDay(k)])); }

// Как dayIsOn в slot-engine.js: enabled сильнее on; без флага — день включён.
function dayOn(e) {
  if (!e || typeof e !== 'object') return false;
  if ('enabled' in e) return !!e.enabled;
  if ('on' in e) return !!e.on;
  return true;
}
function parseObject(raw) {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; } catch { return null; }
}

/** Колонки строки → { mode, days } для сетки. */
export function readBranchHours(workingHours, is24) {
  const days = blankDays();
  if (is24 === true || Number(is24) === 1) return { mode: 'allday', days };
  const o = parseObject(workingHours);
  if (!o || !WEEK.some((k) => k in o)) return { mode: 'none', days };
  for (const k of WEEK) {
    const e = o[k];
    const on = dayOn(e);
    // Как clinicWindow: у включённого дня без «с» — полночь, без «до» — конец
    // суток (сетка покажет 23:59: поле времени не умеет 24:00).
    const from = e && HHMM.test(e.from) ? e.from : (on ? '00:00' : days[k].from);
    const to = e && HHMM.test(e.to) ? e.to : (on ? '23:59' : days[k].to);
    days[k] = { on, from, to };
  }
  return { mode: 'week', days };
}

/** { mode, days } → колонки для записи. */
export function writeBranchHours({ mode, days } = {}) {
  if (mode === 'allday') return { working_hours: '{}', is_24_7: 1 };
  if (mode !== 'week') return { working_hours: '{}', is_24_7: 0 };
  const out = {};
  for (const k of WEEK) {
    const d = (days && days[k]) || defaultDay(k);
    out[k] = { on: !!d.on, from: String(d.from || ''), to: String(d.to || '') };
  }
  return { working_hours: JSON.stringify(out), is_24_7: 0 };
}

/** Ошибка сетки: null или { template, day } (day — ключ дня; подпись переводит экран). */
export function hoursProblem({ mode, days } = {}) {
  if (mode !== 'week') return null;
  let anyOn = false;
  for (const k of WEEK) {
    const d = days && days[k];
    if (!d || !d.on) continue;
    anyOn = true;
    if (!HHMM.test(d.from) || !HHMM.test(d.to) || d.to <= d.from) return { template: HOURS_MESSAGES.order, day: k };
  }
  return anyOn ? null : { template: HOURS_MESSAGES.noDay, day: null };
}

/** Сервер: значение branches.working_hours перед записью. '' — годится. */
export function storedHoursProblem(raw) {
  if (raw === '' || raw === '{}') return '';
  if (typeof raw !== 'string') return HOURS_MESSAGES.stored;
  const o = parseObject(raw);
  if (!o || Object.keys(o).length !== WEEK.length || !WEEK.every((k) => k in o)) return HOURS_MESSAGES.stored;
  let anyOn = false;
  for (const k of WEEK) {
    const e = o[k];
    // Ровно on / from / to: лишний «enabled» движок прочёл бы раньше «on».
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join(',') !== DAY_KEYS) return HOURS_MESSAGES.stored;
    if (typeof e.on !== 'boolean' || !HHMM.test(e.from) || !HHMM.test(e.to)) return HOURS_MESSAGES.stored;
    if (e.on) { anyOn = true; if (e.to <= e.from) return HOURS_MESSAGES.stored; }
  }
  return anyOn ? '' : HOURS_MESSAGES.stored;
}

/** Для списка: подряд идущие дни с одинаковыми часами — одной группой. */
export function hoursGroups({ mode, days } = {}) {
  if (mode !== 'week') return [];
  const groups = [];
  for (const k of WEEK) {
    const d = days[k];
    const hours = d && d.on ? d.from + '–' + d.to : '';
    const last = groups[groups.length - 1];
    if (last && last.hours === hours) last.to = k; else groups.push({ from: k, to: k, hours });
  }
  return groups.filter((g) => g.hours);
}
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Отметьте хотя бы один рабочий день или выберите «Не ограничивать». | Kamida bitta ish kunini belgilang yoki «Cheklamaslik»ni tanlang. | Tick at least one working day or choose “No limit”. |
| {day}: время окончания должно быть позже начала. | {day}: tugash vaqti boshlanish vaqtidan keyin bo‘lishi kerak. | {day}: the end time must be later than the start time. |
| Часы работы здания записаны неверно: нужны все семь дней недели, у каждого — отметка и время «с» и «до», и хотя бы один рабочий день. | Binoning ish vaqti noto‘g‘ri yozilgan: haftaning barcha yetti kuni kerak, har birida belgi hamda «dan» va «gacha» vaqti, kamida bitta ish kuni bo‘lsin. | The building’s working hours are recorded incorrectly: all seven weekdays are needed, each with a tick and “from” and “to” times, and at least one working day. |

- [ ] **Step 5:** тест зелёный. Сторожа: `server/services/rpc/slot-engine.test.js`, `i18n-coverage`, `i18n-uz-quality`.
- [ ] **Step 6: коммит** «Часы здания: общий модуль — сетка недели в колонках так, как их читает движок записи; «пусто — без ограничений», как сейчас (BRANCH_PROFILE_V1)».

---

## Task 4: Общий модуль профиля здания — кто что правит, проверки, «главное — из «Компании»», «скрытое здание прячет врачей» (BRANCH_PROFILE_V1)

**Files:**
- Create: `public/js/shared/branch-profile.js`, `public/js/shared/branch-profile.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `public/js/shared/branch-profile.test.js`:

```js
// BRANCH_PROFILE_V1 — профиль здания: колонки, проверки, одно место на адрес
// здания, «скрытое здание прячет врачей», что синхронизация может записать.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_PROFILE_COLUMNS, BRANCH_SYNC_COLUMNS, BRANCH_MAIN_COLUMNS, BRANCH_LOCAL_COLUMNS, BRANCH_EDIT_COLUMNS,
  OWN_FROM_COMPANY, BRANCH_MESSAGES, LANDMARK_MAX,
  normalizeBranch, branchProblems, storedBranchProblems, syncableBranchValue, overlayOwnBuilding, branchAllowsDoctor,
} from './branch-profile.js';
import { PROFILE_MESSAGES, COMPANY_BUILDING } from './clinic-profile.js';
import { HOURS_MESSAGES } from './branch-hours.js';
import { readableColumns, writableColumns } from '../../../server/db/schema-registry.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('колонки: главное и своё у установки не пересекаются; всё читается и пишется по реестру', () => {
  assert.equal(BRANCH_MAIN_COLUMNS.filter((c) => BRANCH_LOCAL_COLUMNS.includes(c)).length, 0);
  for (const c of BRANCH_EDIT_COLUMNS) {
    assert.ok(readableColumns('branches').includes(c), 'не читается ' + c);
    assert.ok(writableColumns('branches', 'update').includes(c), 'не пишется ' + c);
  }
  for (const c of BRANCH_PROFILE_COLUMNS) assert.ok(writableColumns('branches', 'insert').includes(c), 'не вставляется ' + c);
  assert.deepEqual(BRANCH_SYNC_COLUMNS, ['phone', ...BRANCH_PROFILE_COLUMNS]);
  assert.ok(!BRANCH_EDIT_COLUMNS.includes('letter') && !BRANCH_EDIT_COLUMNS.includes('address'), 'буква — дело связи зданий; прежний адрес не правится (Р3)');
  for (const c of OWN_FROM_COMPANY) assert.ok(COMPANY_BUILDING.includes(c), c + ' — своё у здания в «Компании» (шаг 3)');
});

test('главное здание: адрес для партнёров, карта и телефон — из его «Компании»; остальное — из строки', () => {
  const row = { id: 1, name: 'Главный корпус', street_ru: 'не отсюда', phone: 'старый', landmark_ru: 'у парка', show_public: 1 };
  const company = { country_code: 'UZ', region_code: 'tashkent-city', district_code: 'mirobod', street_ru: 'ул. Мира, 1',
    street_uz: '', street_en: '', maps_url: 'https://yandex.uz/maps/-/CDm', phone: '+998 71 200 12 00', clinic_name: 'Шифо' };
  const v = overlayOwnBuilding(row, company);
  assert.deepEqual(OWN_FROM_COMPANY.map((c) => v[c]), OWN_FROM_COMPANY.map((c) => company[c]));
  assert.equal(v.landmark_ru, 'у парка', 'ориентир — из «Филиалов»');
  assert.equal(v.name, 'Главный корпус', 'название здания — не название клиники');
  assert.ok(!('clinic_name' in v));
  assert.equal(overlayOwnBuilding(row, null), row);
  assert.equal(overlayOwnBuilding(row, []), row);
  assert.equal(overlayOwnBuilding(row, { phone: '+1' }).street_ru, 'не отсюда', 'база до 240: колонок «Компании» нет — строка как есть');
});

test('скрытое здание прячет своих врачей; врач без здания и врач открытого здания — нет', () => {
  const branches = new Map([[5, { id: 5, show_public: 0 }], [6, { id: 6, show_public: 1 }]]);
  assert.equal(branchAllowsDoctor({ branch_id: 5 }, branches), false);
  assert.equal(branchAllowsDoctor({ branch_id: '5' }, branches), false);
  assert.equal(branchAllowsDoctor({ branch_id: 6 }, branches), true);
  assert.equal(branchAllowsDoctor({ branch_id: null }, branches), true, 'врач без здания этим правилом не прячется');
  assert.equal(branchAllowsDoctor({ branch_id: 99 }, branches), true, 'здания нет в списке — прятать нечем');
});

test('нормализация: пробелы по краям, отметки — 0/1', () => {
  const v = normalizeBranch({ name: ' Юнусабад ', street_ru: ' ул. Мира, 1 ', maps_url: ' ', phone: ' +998 ', show_public: true, active: '0', is_24_7: false });
  assert.deepEqual([v.name, v.street_ru, v.maps_url, v.phone], ['Юнусабад', 'ул. Мира, 1', '', '+998']);
  assert.deepEqual([v.show_public, v.active, v.is_24_7], [1, 0, 0]);
});

test('экран: название RU обязательно; адрес — всё или ничего; карта — только Яндекс', () => {
  assert.deepEqual(branchProblems({ name: 'Юнусабад' }), {});
  assert.equal(branchProblems({ name: ' ' }).name, BRANCH_MESSAGES.name);
  assert.equal(branchProblems({ name: 'X', street_ru: 'ул. Мира, 1' }).region_code, PROFILE_MESSAGES.region);
  assert.equal(branchProblems({ name: 'X', maps_url: 'https://maps.google.com/x' }).maps_url, PROFILE_MESSAGES.maps);
  assert.deepEqual(branchProblems({ name: 'X', region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1',
    maps_url: 'https://yandex.uz/maps/-/CDabc' }), {});
});

test('сервер: формат карты, часов, отметок и кодов; неприсланное не проверяется', () => {
  assert.deepEqual(storedBranchProblems({ name: 'Любое', phone: 'что угодно' }), {});
  assert.equal(storedBranchProblems({ maps_url: 'https://maps.google.com/x' }).maps_url, PROFILE_MESSAGES.maps);
  assert.equal(storedBranchProblems({ maps_url: ' https://yandex.uz/maps/-/CDabc' }).maps_url, PROFILE_MESSAGES.maps, 'сервер не приводит за экран');
  assert.equal(storedBranchProblems({ working_hours: '{"mon":{"enabled":true}}' }).working_hours, HOURS_MESSAGES.stored);
  assert.equal(storedBranchProblems({ show_public: 2 }).show_public, BRANCH_MESSAGES.flag);
  assert.equal(storedBranchProblems({ is_24_7: 'да' }).is_24_7, BRANCH_MESSAGES.flag);
  assert.equal(storedBranchProblems({ district_code: '"><b>' }).district_code, BRANCH_MESSAGES.code);
  assert.deepEqual(storedBranchProblems({ maps_url: '', working_hours: '{}', show_public: true, is_24_7: 0, active: 1,
    region_code: 'tashkent-city', district_code: '' }), {});
  assert.deepEqual(storedBranchProblems([{ maps_url: 'x' }]), {}, 'пачку перебирает вызывающий (routes/db.js)');
});

test('синхронизация: приехавшее значение пишется, только если база его примет', () => {
  assert.equal(syncableBranchValue('name_uz', 'Yunusobod'), true);
  assert.equal(syncableBranchValue('name_uz', null), false, 'null в NOT NULL уронил бы приём');
  assert.equal(syncableBranchValue('name_uz', 5), false);
  assert.equal(syncableBranchValue('name_uz', 'x'.repeat(121)), false);
  assert.equal(syncableBranchValue('landmark_ru', 'x'.repeat(LANDMARK_MAX)), true);
  assert.equal(syncableBranchValue('phone', '+998 71 200 12 00'), true);
  assert.equal(syncableBranchValue('maps_url', 'https://maps.google.com/x'), false, 'CHECK миграции 241 уронил бы приём');
  assert.equal(syncableBranchValue('maps_url', ''), true);
  assert.equal(syncableBranchValue('show_public', 0), true);
  assert.equal(syncableBranchValue('show_public', 2), false);
  assert.equal(syncableBranchValue('show_public', '1'), false);
  assert.equal(syncableBranchValue('region_code', 'tashkent-city'), true);
  assert.equal(syncableBranchValue('region_code', 'a b'), false);
});

test('каждое сообщение модуля переведено на ru / uz / en', () => {
  for (const m of Object.values(BRANCH_MESSAGES)) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
  }
});
```

- [ ] **Step 2:** `node --test public/js/shared/branch-profile.test.js` → падает (нет модуля).
- [ ] **Step 3: модуль** `public/js/shared/branch-profile.js`:

```js
// BRANCH_PROFILE_V1 — ПРОФИЛЬ ЗДАНИЯ («Филиалы», шаг 4 API клиники): какие
// колонки branches правит только главное здание, какие свои у установки; одно
// место на адрес здания; «скрытое здание прячет врачей»; проверки записи и
// приёма синхронизации.
//
// Чистый модуль — без window, document, базы и перевода. Его читают экран
// «Филиалы» (views/branch-page.js, branches-editor.js), «Компания» филиала,
// /api/db (routes/db.js), синхронизация зданий (branch-sync/catalogue.js), RPC
// branch_hours_impact, а позже API (шаг 8) и публикация врача (шаг 5).
//
// ИМЕНА. branches.name — русское название: его показывает вся программа, по
// нему связываются здания и ищется здание при загрузке сотрудников. name_uz /
// name_en — рядом, наружу и в списке «Филиалов» на языке интерфейса.
//
// ОДНО МЕСТО НА АДРЕС ЗДАНИЯ. Главное здание держит адрес для партнёров, карту
// и телефон в своей «Компании» (doc_settings, шаг 3; решение владельца 11) —
// overlayOwnBuilding подставляет их в его строку. Остальные здания — в своих
// строках branches, их правит главное здание, синхронизация везёт их всем.
// Прежнее branches.address (вписанное руками в старом редакторе) больше не
// правится: третьего адреса у здания нет.
import { NAME_MAX, STREET_MAX, addressProblems, mapsProblem, storedProfileProblems } from './clinic-profile.js';
import { storedHoursProblem } from './branch-hours.js';

export const LANDMARK_MAX = 160;
const PHONE_MAX = 64;

/** Колонки миграции 241. */
export const BRANCH_PROFILE_COLUMNS = Object.freeze([
  'name_uz', 'name_en', 'country_code', 'region_code', 'district_code',
  'street_ru', 'street_uz', 'street_en', 'landmark_ru', 'landmark_uz', 'landmark_en',
  'maps_url', 'show_public',
]);
/** Едут в филиалы со списком сети, кроме name и часов (они ехали и раньше). */
export const BRANCH_SYNC_COLUMNS = Object.freeze(['phone', ...BRANCH_PROFILE_COLUMNS]);
/** Правит только главное здание: в филиале — 409 (routes/db.js). */
export const BRANCH_MAIN_COLUMNS = Object.freeze(['name', 'phone', ...BRANCH_PROFILE_COLUMNS, 'working_hours', 'is_24_7']);
/** Свои у каждой установки, как сегодня: между зданиями не ездят. address экран не правит (Р3). */
export const BRANCH_LOCAL_COLUMNS = Object.freeze(['address', 'active']);
/** Что правит страница здания. */
export const BRANCH_EDIT_COLUMNS = Object.freeze([...BRANCH_MAIN_COLUMNS, 'active']);
/** Главное здание: это берётся из его «Компании», в его строке branches не правится. */
export const OWN_FROM_COMPANY = Object.freeze([
  'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en', 'maps_url', 'phone',
]);

export const BRANCH_MESSAGES = Object.freeze({
  name:              'Введите название на русском.',
  mainOnly:          'Названия, телефоны, адреса для партнёров, карты, часы работы и показ на сайте зданий меняются в главном здании.',
  newMainOnly:       'Новое здание заводится в главном здании.',
  ownInCompany:      'Адрес для партнёров, карта и телефон этого здания меняются в «Компании».',
  partnerInBranches: 'Адрес для партнёров и карту этого здания ведёт главное здание — в «Филиалах».',
  flag:              'Отметка записана неверно: нужно 0 или 1.',
  code:              'Код из справочника записан неверно.',
});

const TEXT = ['name', 'name_uz', 'name_en', 'phone', 'address', 'street_ru', 'street_uz', 'street_en',
  'landmark_ru', 'landmark_uz', 'landmark_en', 'maps_url'];
const FLAGS = ['show_public', 'is_24_7', 'active'];
const CODES = ['country_code', 'region_code', 'district_code'];
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;   // countries / regions / districts.code (мигр. 132)
const TEXT_MAX = {
  name: NAME_MAX, name_uz: NAME_MAX, name_en: NAME_MAX, phone: PHONE_MAX,
  street_ru: STREET_MAX, street_uz: STREET_MAX, street_en: STREET_MAX,
  landmark_ru: LANDMARK_MAX, landmark_uz: LANDMARK_MAX, landmark_en: LANDMARK_MAX,
};

export function normalizeBranch(v) {
  const out = { ...v };
  for (const k of TEXT) if (k in out) out[k] = String(out[k] == null ? '' : out[k]).trim();
  for (const k of FLAGS) if (k in out) out[k] = Number(out[k]) ? 1 : 0;
  return out;
}

/** Экран: название RU, адрес для партнёров «всё или ничего» (как «Компания»), карта. */
export function branchProblems(v, geo = {}) {
  const p = { ...addressProblems(v, geo) };
  if (!String(v.name || '').trim()) p.name = BRANCH_MESSAGES.name;
  const mp = mapsProblem(v.maps_url); if (mp) p.maps_url = mp;
  return p;
}

/** Сервер: значения ровно в том виде, в каком их пишут в базу; проверяются только присланные. */
export function storedBranchProblems(values) {
  const p = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return p;
  const given = (k) => Object.prototype.hasOwnProperty.call(values, k) && values[k] != null;
  if (given('maps_url')) { const m = storedProfileProblems({ maps_url: values.maps_url }).maps_url; if (m) p.maps_url = m; }
  if (given('working_hours')) { const m = storedHoursProblem(values.working_hours); if (m) p.working_hours = m; }
  for (const k of FLAGS) if (given(k) && ![0, 1, true, false].includes(values[k])) p[k] = BRANCH_MESSAGES.flag;
  for (const k of CODES) {
    if (given(k) && values[k] !== '' && !(typeof values[k] === 'string' && CODE_RE.test(values[k]))) p[k] = BRANCH_MESSAGES.code;
  }
  return p;
}

/**
 * Синхронизация: можно ли записать приехавшее значение. Нельзя — пропустить,
 * а не уронить приём (справочник принимается ОДНОЙ транзакцией: catalogue.js).
 */
export function syncableBranchValue(col, v) {
  if (col === 'show_public') return v === 0 || v === 1;
  if (typeof v !== 'string') return false;
  if (TEXT_MAX[col] && v.length > TEXT_MAX[col]) return false;
  return !Object.keys(storedBranchProblems({ [col]: v })).length;
}

/**
 * Строка ГЛАВНОГО здания так, как её видят пациенты и партнёры: адрес для
 * партнёров, карта и телефон — из его «Компании» (company = строка
 * doc_settings), остальное — из самой строки. Колонки, которой у «Компании»
 * нет (база до 240), не подменяются. Зовут: список и страница «Филиалов»,
 * выгрузка в филиалы (catalogue.js), API (шаг 8).
 */
export function overlayOwnBuilding(row, company) {
  if (!row || !company || typeof company !== 'object' || Array.isArray(company)) return row;
  const out = { ...row };
  for (const c of OWN_FROM_COMPANY) if (c in company && company[c] != null) out[c] = company[c];
  return out;
}

/**
 * Не прячет ли врача его здание. Скрытое здание (show_public = 0) прячет и
 * своих врачей — макет «Филиалы» (решение владельца 2026-10-06: «его врачи
 * тоже не показываются»). Здание врача — users.branch_id, как у часов и
 * календаря (rpc/calendar.js resourceWindow). Врач без здания и врач здания,
 * которого нет в списке, этим правилом не прячутся. Остальные условия
 * публикации врача (переключатель администратора) — шаг 5; API — шаг 8.
 */
export function branchAllowsDoctor(doctor, branchesById) {
  const id = doctor && doctor.branch_id;
  if (id == null || id === '') return true;
  const b = branchesById instanceof Map ? branchesById.get(Number(id)) : null;
  return !b || Number(b.show_public) !== 0;
}
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Введите название на русском. | Nomini rus tilida kiriting. | Enter the name in Russian. |
| Названия, телефоны, адреса для партнёров, карты, часы работы и показ на сайте зданий меняются в главном здании. | Binolarning nomlari, telefonlari, hamkorlar uchun manzillari, xaritalari, ish vaqti va saytda ko‘rsatilishi bosh binoda o‘zgartiriladi. | Building names, phones, addresses for partners, maps, working hours and showing on the website are changed in the main building. |
| Новое здание заводится в главном здании. | Yangi bino bosh binoda qo‘shiladi. | A new building is added in the main building. |
| Адрес для партнёров, карта и телефон этого здания меняются в «Компании». | Bu binoning hamkorlar uchun manzili, xaritasi va telefoni «Kompaniya»da o‘zgartiriladi. | This building’s address for partners, map and phone are changed in “Company”. |
| Адрес для партнёров и карту этого здания ведёт главное здание — в «Филиалах». | Bu binoning hamkorlar uchun manzili va xaritasini bosh bino yuritadi — «Filiallar»da. | The main building keeps this building’s address for partners and map — in “Branches”. |
| Отметка записана неверно: нужно 0 или 1. | Belgi noto‘g‘ri yozilgan: 0 yoki 1 bo‘lishi kerak. | The flag is recorded incorrectly: it must be 0 or 1. |
| Код из справочника записан неверно. | Ma’lumotnoma kodi noto‘g‘ri yozilgan. | The reference-list code is recorded incorrectly. |

- [ ] **Step 5:** тест зелёный. Сторожа: `public/js/shared/clinic-profile.test.js`, `i18n-coverage`, `i18n-uz-quality`.
- [ ] **Step 6: коммит** «Профиль здания: общий модуль — главное здание правит, адрес главного — из «Компании», скрытое здание прячет врачей, проверки записи и синхронизации (BRANCH_PROFILE_V1)».

---

## Task 5: /api/db — формат профиля здания; в филиале «Филиалы» не правятся; адрес своего здания главного — только в «Компании» (BRANCH_PROFILE_V1)

**Files:**
- Modify: `server/routes/db.js` (импорт рядом с :10; вызов — сразу за блоком `profileRefusal` :373-374; помощники — за `companyProfileRefusal` :688-698)
- Create: `server/routes/branches-guard.test.js`
- Modify: `public/js/admin/i18n-strings.js` (если статьи задачи 4 уже есть — ничего)

- [ ] **Step 1: падающий тест** `server/routes/branches-guard.test.js`. Стенд — как `server/routes/company-secondary.test.js:23-40`:

```js
// BRANCH_PROFILE_V1 — /api/db и «Филиалы»: формат проверяется в любом здании;
// в филиале название, телефон, профиль, часы и показ на сайте любого здания не
// меняются (приезжают из главного, catalogue.js roster), новое здание не
// заводится; в главном адрес для партнёров, карта и телефон СВОЕГО здания —
// только в «Компании» (одно место на здание). Отказ — только если значение меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { becomeSecondary } from '../services/branch-sync/identity.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { BRANCH_MESSAGES } from '../../public/js/shared/branch-profile.js';
import { PROFILE_MESSAGES } from '../../public/js/shared/clinic-profile.js';
import { HOURS_MESSAGES, writeBranchHours, blankDays } from '../../public/js/shared/branch-hours.js';

async function startServer({ secondary = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE branches SET name = 'Главный корпус', name_uz = 'Bosh bino', phone = '+998712000000' WHERE letter = 'A'").run();
  if (secondary) becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  else db.prepare("INSERT INTO branches (name, letter) VALUES ('Чиланзар', 'C')").run();
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, stop() { server.close(); db.close(); } };
}
async function loginAs(base) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const post = (base, cookie, body) => fetch(base + '/api/db', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
const idOf = (db, letter) => db.prepare('SELECT id FROM branches WHERE letter = ?').get(letter).id;
const update = (base, cookie, id, values) => post(base, cookie, { table: 'branches', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const WEEK_HOURS = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;

test('филиал: название, телефон, профиль, часы и показ любого здания — 409; база не тронута', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    for (const [letter, values] of [
      ['A', { name: 'Другое' }], ['A', { name_uz: 'Boshqa' }], ['C', { street_ru: 'ул. Новая, 1' }],
      ['C', { working_hours: WEEK_HOURS }], ['C', { is_24_7: true }], ['A', { show_public: 0 }],
      ['C', { maps_url: 'https://yandex.uz/maps/-/CDx' }], ['C', { phone: '+998901112233' }], ['C', { landmark_ru: 'у парка' }],
    ]) {
      const res = await update(t.base, cookie, idOf(t.db, letter), values);
      assert.equal(res.status, 409, letter + ' ' + JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.code, 'conflict');
      assert.equal(error.message, BRANCH_MESSAGES.mainOnly);
    }
    const a = t.db.prepare("SELECT * FROM branches WHERE letter = 'A'").get();
    const c = t.db.prepare("SELECT * FROM branches WHERE letter = 'C'").get();
    assert.deepEqual([a.name, a.name_uz, a.show_public, c.street_ru, c.working_hours, c.is_24_7, c.phone],
      ['Главный корпус', 'Bosh bino', 1, '', '{}', 0, '']);
  } finally { t.stop(); }
});

test('филиал: «работает» и прежний адрес сохраняются; неизменённое общее не мешает', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    const c = idOf(t.db, 'C');
    const res = await update(t.base, cookie, c, { name: 'Чиланзар', is_24_7: false, phone: '', address: 'ул. Филиальная, 8', active: 1 });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(t.db.prepare('SELECT address FROM branches WHERE id = ?').get(c).address, 'ул. Филиальная, 8');
  } finally { t.stop(); }
});

test('филиал: новое здание не заводится; общее без отбора по одному id — 409', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    let res = await post(t.base, cookie, { table: 'branches', op: 'insert', values: { name: 'Новый' } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, BRANCH_MESSAGES.newMainOnly);
    res = await post(t.base, cookie, { table: 'branches', op: 'update', values: { name_en: 'All' }, filters: [{ col: 'active', op: 'eq', val: 1 }] });
    assert.equal(res.status, 409);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM branches WHERE name_en = 'All'").get().n, 0);
  } finally { t.stop(); }
});

test('главное здание: чужое здание правится целиком; своё — без адреса, карты и телефона (они в «Компании»)', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const c = idOf(t.db, 'C');
    let res = await update(t.base, cookie, c, { name_en: 'Chilonzor branch', phone: '+998901112233', region_code: 'tashkent-city',
      street_ru: 'ул. Бунёдкор, 5', landmark_uz: 'Metro qarshisida', maps_url: 'https://yandex.uz/maps/-/CDc', show_public: 0,
      working_hours: WEEK_HOURS, is_24_7: 0 });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.deepEqual(Object.values(t.db.prepare('SELECT name_en, phone, show_public, working_hours FROM branches WHERE id = ?').get(c)),
      ['Chilonzor branch', '+998901112233', 0, WEEK_HOURS]);

    const a = idOf(t.db, 'A');
    for (const values of [{ street_ru: 'ул. Мира, 1' }, { phone: '+998900000000' }, { maps_url: 'https://yandex.uz/maps/-/CDa' }]) {
      res = await update(t.base, cookie, a, values);
      assert.equal(res.status, 409, JSON.stringify(values));
      assert.equal((await res.json()).error.message, BRANCH_MESSAGES.ownInCompany);
    }
    res = await update(t.base, cookie, a, { phone: '+998712000000', name_en: 'Main building', landmark_ru: 'У парка', working_hours: WEEK_HOURS });
    assert.equal(res.status, 200, 'телефон как был — не отказ; ориентир, названия и часы своего здания — здесь');
    res = await post(t.base, cookie, { table: 'branches', op: 'insert', values: { name: 'Юнусабад', name_uz: 'Yunusobod', working_hours: '{}' } });
    assert.ok(res.ok, 'новое здание заводит главное');
  } finally { t.stop(); }
});

test('формат — в любом здании: чужая карта, старая форма часов, отметка 2, разметка в коде — 400 с объяснением', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const c = idOf(t.db, 'C');
    for (const [values, field, message] of [
      [{ maps_url: 'https://maps.google.com/x' }, 'maps_url', PROFILE_MESSAGES.maps],
      [{ working_hours: JSON.stringify({ mon: { enabled: true, from: '09:00', to: '18:00' } }) }, 'working_hours', HOURS_MESSAGES.stored],
      [{ show_public: 2 }, 'show_public', BRANCH_MESSAGES.flag],
      [{ district_code: '"><script>' }, 'district_code', BRANCH_MESSAGES.code],
    ]) {
      const res = await update(t.base, cookie, c, values);
      assert.equal(res.status, 400, JSON.stringify(values));
      const { error } = await res.json();
      assert.equal(error.field, field);
      assert.equal(error.message, message);
    }
    const ins = await post(t.base, cookie, { table: 'branches', op: 'insert', values: { name: 'X', maps_url: 'http://yandex.uz/maps' } });
    assert.equal(ins.status, 400, 'вставка проверяется так же');
  } finally { t.stop(); }
});
```

- [ ] **Step 2:** `node --test server/routes/branches-guard.test.js` → падает (сегодня всё проходит с 200).
- [ ] **Step 3: правка** `server/routes/db.js`.
  - Импорт рядом с :10: `import { BRANCH_MAIN_COLUMNS, OWN_FROM_COMPANY, BRANCH_MESSAGES, storedBranchProblems } from '../../public/js/shared/branch-profile.js';   // BRANCH_PROFILE_V1`.
  - Сразу за блоком `profileRefusal` (:373-374):

```js
    // BRANCH_PROFILE_V1 — «ФИЛИАЛЫ»: КТО ЧТО ПРАВИТ (shared/branch-profile.js).
    //   • филиал: название, телефон, профиль, часы, показ на сайте любого здания
    //     приходят из главного (catalogue.js roster) — правка здесь откатилась
    //     бы синхронизацией, тот же призрак, что закрывает 409 выше; новое
    //     здание заводит главное;
    //   • главное: адрес для партнёров, карта и телефон СВОЕГО здания живут в
    //     «Компании» (одно место на здание) — в строке branches их не правят.
    // Отказ — только если значение МЕНЯЕТСЯ: экран, приславший неизменённое,
    // сохраняет своё.
    const branchRefusal = branchWriteRefusal(db, compiled.meta, req.body);
    if (branchRefusal) return res.status(409).json({ error: { code: 'conflict', message: branchRefusal } });
    // BRANCH_PROFILE_V1 — формат: карта, часы, отметки, коды — те же правила, что у экрана.
    const branchFormat = branchFormatRefusal(compiled.meta, req.body);
    if (branchFormat) return res.status(400).json({ error: { code: 'bad_request', message: branchFormat.message, field: branchFormat.field } });
```

  - Помощники — за `companyProfileRefusal`:

```js
// BRANCH_PROFILE_V1 — см. вызов в POST. null — запись можно выполнять.
const flat = (v) => (v === true ? '1' : v === false ? '0' : String(v == null ? '' : v));
// Строка, которую правят: только отбор ровно по одному id (так пишут экраны).
function targetBranch(db, body) {
  const f = body && Array.isArray(body.filters) ? body.filters : [];
  if (f.length !== 1 || !f[0] || f[0].col !== 'id' || f[0].op !== 'eq') return null;
  return db.prepare('SELECT * FROM branches WHERE id = ?').get(f[0].val) || null;
}
function branchWriteRefusal(db, meta, body) {
  if (!meta || meta.table !== 'branches' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const secondary = isSecondary(db);
  if (meta.op !== 'update') return secondary ? BRANCH_MESSAGES.newMainOnly : null;
  const values = body && body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const guarded = secondary ? BRANCH_MAIN_COLUMNS : OWN_FROM_COMPANY;
  const touched = guarded.filter((c) => Object.prototype.hasOwnProperty.call(values, c));
  if (!touched.length) return null;
  const cur = targetBranch(db, body);
  if (!secondary) {
    let own = null;
    try { own = readIdentity(db).branch_id; } catch { own = null; }
    if (cur && (own == null || Number(cur.id) !== Number(own))) return null;   // чужое здание — правит главное
  }
  if (cur && !touched.some((c) => flat(values[c]) !== flat(cur[c]))) return null;
  return secondary ? BRANCH_MESSAGES.mainOnly : BRANCH_MESSAGES.ownInCompany;
}
function branchFormatRefusal(meta, body) {
  if (!meta || meta.table !== 'branches' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  for (const row of Array.isArray(v) ? v : [v]) {
    const problems = storedBranchProblems(row);
    const field = Object.keys(problems)[0];
    if (field) return { field, message: problems[field] };
  }
  return null;
}
```

  `readIdentity` в `db.js` уже импортирован (его зовёт `isSecondary`). Проверить `grep -n "readIdentity" server/routes/db.js`; нет — добавить импорт из `../services/branch-sync/identity.js` с меткой.
- [ ] **Step 4:** тест зелёный. Сторожа:
  - `server/routes/company-secondary.test.js`, `staff-sync-readonly.test.js`, `branch-sync.test.js`;
  - `server/db/write-grant.test.js`, `server/i18n-server-messages.test.js`, `server/app-test-hygiene.test.js`;
  - клиентский `settings-hub-groups.test.mjs` (прежний редактор сохраняет неизменённое).
- [ ] **Step 5: коммит** «Филиалы: в филиале здания не правятся и не заводятся — их ведёт главное; адрес, карта и телефон своего здания главного — только в «Компании»; формат профиля проверяет сервер (BRANCH_PROFILE_V1)».

---

## Task 6: RPC branch_hours_impact — каким врачам какое время закроется, тем же движком (BRANCH_PROFILE_V1)

**Files:**
- Create: `server/services/rpc/branch-hours.js`, `server/services/rpc/branch-hours.test.js`
- Modify: `server/services/rpc/index.js` (импорт — за :47; вход — за `calendar_book` :286)
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `server/services/rpc/branch-hours.test.js`:

```js
// BRANCH_PROFILE_V1 — «каким врачам какое время закроется»: ровно то, что
// календарь перестаёт предлагать (тот же движок slot-engine.js), и только врачам
// этого здания (users.branch_id, как resourceWindow).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarSlots, calendarBook } from './calendar.js';
import { becomeSecondary } from '../branch-sync/identity.js';
import { branchHoursImpact, lostHours, IMPACT_DENIED } from './branch-hours.js';
import { writeBranchHours, blankDays } from '../../../public/js/shared/branch-hours.js';
import { BRANCH_MESSAGES } from '../../../public/js/shared/branch-profile.js';
import { STRINGS } from '../../../public/js/admin/i18n-strings.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const REG = { id: 2, role: 'registrar', extra_roles: [] };
function nextMonday() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  return d;
}
const MON = nextMonday();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY = iso(MON);
const at = (hh) => new Date(MON.getFullYear(), MON.getMonth(), MON.getDate(), hh, 0, 0, 0).toISOString();
const MON_FRI = () => writeBranchHours({ mode: 'week', days: blankDays() });   // Пн–Пт 09–18, Сб и Вс закрыты

function seed({ patient = true } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO branches (id, name, working_hours) VALUES (5, 'Юнусабад', '{}'), (6, 'Чиланзар', '{}')").run();
  const add = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours, branch_id, specialty, is_active)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  add.run(1, 'boss', 'x', 'Админ', 'admin', 0, '', null, '', 1);
  add.run(2, 'reg', 'x', 'Регистратор', 'registrar', 0, '', 5, '', 1);
  add.run(7, 'petrov', 'x', 'Петров П. П.', 'doctor', 1, JSON.stringify({ mon: { on: true, from: '08:00', to: '20:00' } }), 5, '', 1);
  add.run(8, 'karimov', 'x', 'Каримов Р.', 'doctor', 1, '', 5, '', 1);     // графика нет — 09:00–18:00 каждый день
  add.run(9, 'aliev', 'x', 'Алиев А.', 'doctor', 1, '', 6, '', 1);         // другое здание
  add.run(10, 'old', 'x', 'Уволенный', 'doctor', 1, '', 5, '', 0);         // не работает
  add.run(11, 'uzi', 'x', 'Узистов У.', 'registrar', 0, '', 5, 'УЗИ', 1);  // специальность — в календаре он врач (room-calendar.js:283)
  if (patient) db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Иванов Иван')").run();
  return db;
}
function addGrants(db, role, grants) {   // как server/db/write-grant.test.js
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('предупреждение называет ровно то время, которое календарь перестаёт предлагать', () => {
  const db = seed();
  try {
    assert.deepEqual(calendarSlots(db, { doctor_id: 7, date: DAY }, REG).window, { from: '08:00', to: '20:00', breaks: [] });
    const next = MON_FRI();
    const petrov = branchHoursImpact(db, { branch_id: 5, ...next }, ADMIN).doctors.find((d) => d.id === 7);
    assert.deepEqual(petrov, { id: 7, name: 'Петров П. П.', lost: [{ day: 'mon', from: '08:00', to: '09:00' }, { day: 'mon', from: '18:00', to: '20:00' }] });
    db.prepare('UPDATE branches SET working_hours = ?, is_24_7 = ? WHERE id = 5').run(next.working_hours, next.is_24_7);
    assert.deepEqual(calendarSlots(db, { doctor_id: 7, date: DAY }, REG).window, { from: '09:00', to: '18:00', breaks: [] });
  } finally { db.close(); }
});

test('врач без графика теряет выходные; другое здание, уволенный и не врачи — не в списке', () => {
  const db = seed();
  try {
    const { doctors } = branchHoursImpact(db, { branch_id: 5, ...MON_FRI() }, ADMIN);
    assert.deepEqual(doctors.map((d) => d.name), ['Каримов Р.', 'Петров П. П.', 'Узистов У.']);
    assert.deepEqual(doctors[0].lost, [{ day: 'sat', from: '09:00', to: '18:00' }, { day: 'sun', from: '09:00', to: '18:00' }]);
  } finally { db.close(); }
});

test('часы шире прежних, «Круглосуточно» и «Не ограничивать» — никто ничего не теряет', () => {
  const db = seed();
  try {
    db.prepare('UPDATE branches SET working_hours = ? WHERE id = 5').run(MON_FRI().working_hours);
    for (const next of [{ working_hours: '{}', is_24_7: 0 }, { working_hours: '{}', is_24_7: 1 }, MON_FRI()]) {
      assert.deepEqual(branchHoursImpact(db, { branch_id: 5, ...next }, ADMIN).doctors, [], JSON.stringify(next));
    }
  } finally { db.close(); }
});

test('обед врача не считается потерей: он и так не принимал', () => {
  const doc = JSON.stringify({ mon: { enabled: true, from: '09:00', to: '19:00', lunchEnabled: true, lunchFrom: '13:00', lunchTo: '14:00' } });
  const days = blankDays(); days.mon = { on: true, from: '12:00', to: '18:00' };
  assert.deepEqual(lostHours(doc, { working_hours: '{}', is_24_7: 0 }, writeBranchHours({ mode: 'week', days })),
    [{ day: 'mon', from: '09:00', to: '12:00' }, { day: 'mon', from: '18:00', to: '19:00' }]);
});

test('часы здания не запрещают запись — только перестают её предлагать (как сегодня; так и сказано в предупреждении)', async () => {
  const db = seed();
  try {
    db.prepare('UPDATE branches SET working_hours = ? WHERE id = 5').run(MON_FRI().working_hours);
    const starts = calendarSlots(db, { doctor_id: 7, date: DAY, duration_minutes: 30 }, REG).slots.map((s) => s.start);
    assert.ok(!starts.includes('19:00'), '19:00 не предлагается');
    const out = await calendarBook(db, { patient_id: 3, doctor_id: 7, start: at(19) }, REG);
    assert.equal(out.created, true, 'calendar_book проверяет только занятость (calendar.js:1044-1052)');
  } finally { db.close(); }
});

test('права: администратор и «Филиалы: Изменение»; остальным — 403; в филиале — 409', () => {
  const db = seed();
  try {
    assert.throws(() => branchHoursImpact(db, { branch_id: 5, ...MON_FRI() }, REG), (e) => e.status === 403 && e.message === IMPACT_DENIED);
    addGrants(db, 'registrar', { settings: 'view', 'settings.branches': 'edit' });
    assert.equal(branchHoursImpact(db, { branch_id: 5, ...MON_FRI() }, REG).doctors.length, 3);
  } finally { db.close(); }
  const sec = seed({ patient: false });   // филиалом становится установка без выданных номеров карт
  try {
    becomeSecondary(sec, { letter: 'C', name: 'Чиланзар' });
    assert.throws(() => branchHoursImpact(sec, { branch_id: 5, ...MON_FRI() }, ADMIN), (e) => e.status === 409 && e.message === BRANCH_MESSAGES.mainOnly);
  } finally { sec.close(); }
});

test('новое здание или неизвестный id — врачей нет; часы не в том виде — 400', () => {
  const db = seed();
  try {
    assert.deepEqual(branchHoursImpact(db, { working_hours: MON_FRI().working_hours }, ADMIN), { doctors: [] });
    assert.deepEqual(branchHoursImpact(db, { branch_id: 999, ...MON_FRI() }, ADMIN), { doctors: [] });
    assert.throws(() => branchHoursImpact(db, { branch_id: 5, working_hours: '{"mon":{"enabled":true}}', is_24_7: 0 }, ADMIN), (e) => e.status === 400);
  } finally { db.close(); }
});

test('отказ переведён на ru / uz / en', () => {
  const e = STRINGS[IMPACT_DENIED];
  assert.ok(e && e.ru && e.uz && e.en);
});
```

- [ ] **Step 2:** `node --test server/services/rpc/branch-hours.test.js` → падает (нет модуля).
  - Если тест записи на 19:00 упадёт не из-за модуля (например, `calendarBook` требует ещё что-то для записи), это находка про сегодняшнее поведение. Остановиться и доложить: текст предупреждения опирается на неё.
- [ ] **Step 3: модуль** `server/services/rpc/branch-hours.js`:

```js
// BRANCH_PROFILE_V1 — «КАКИМ ВРАЧАМ КАКОЕ ВРЕМЯ ЗАКРОЕТСЯ» до сохранения часов
// здания (спецификация, «Часы работы филиала»).
//
// Считает ТОТ ЖЕ движок, что слоты записи (slot-engine.js): окно врача на день
// (dayWindow — график из «Сотрудников», обед, умолчание 09:00–18:00), суженное
// часами здания (clinicWindow → clampWindow), минус обед (windowSegments).
// Было окно с прежними часами, стало с новыми — разница и есть потерянное время.
//
// Чьё время: врачи, у которых в «Сотрудниках» выбрано это здание
// (users.branch_id) — ровно те, чьё окно сужает rpc/calendar.js resourceWindow;
// «врач» — как колонка календаря (views/room-calendar.js:283: is_doctor, роль
// doctor или специальность). Уволенные (is_active = 0) — нет.
//
// Ничего не пишет. Ворота — право записи в branches (реестр + плитка «Филиалы»,
// db/write-grant.js tableWriteAllowed): кто не может сохранить часы, тому и
// считать незачем. В филиале — 409: часы правит главное здание.
import { WEEKDAY_KEYS, dayWindow, clinicWindow, clampWindow, windowSegments, formatHhmm } from './slot-engine.js';
import { tableWriteAllowed } from '../../db/write-grant.js';
import { readIdentity } from '../branch-sync/identity.js';
import { WEEK, storedHoursProblem } from '../../../public/js/shared/branch-hours.js';
import { BRANCH_MESSAGES } from '../../../public/js/shared/branch-profile.js';

export class RpcError extends Error {
  constructor(message, status = 400, code = null) { super(message); this.status = status; if (code) this.code = code; }
}

export const IMPACT_DENIED = 'Часы работы зданий меняет администратор или тот, кому выдано изменение «Филиалов».';

/** Отрезки a минус отрезки b (минуты от полуночи). */
function minus(a, b) {
  const out = [];
  for (const s of a) {
    let pieces = [{ from: s.from, to: s.to }];
    for (const t of b) {
      const next = [];
      for (const p of pieces) {
        if (t.to <= p.from || t.from >= p.to) { next.push(p); continue; }
        if (t.from > p.from) next.push({ from: p.from, to: t.from });
        if (t.to < p.to) next.push({ from: t.to, to: p.to });
      }
      pieces = next;
    }
    out.push(...pieces.filter((p) => p.to > p.from));
  }
  return out;
}

/** Потерянное время врача по дням недели (пн → вс): [{ day, from, to }]. */
export function lostHours(doctorHours, before, after) {
  const lost = [];
  for (const day of WEEK) {
    const wd = WEEKDAY_KEYS.indexOf(day);
    const own = dayWindow(doctorHours, wd);
    const was = windowSegments(clampWindow(own, clinicWindow(before, wd)));
    const now = windowSegments(clampWindow(own, clinicWindow(after, wd)));
    for (const p of minus(was, now)) lost.push({ day, from: formatHhmm(p.from), to: formatHhmm(p.to) });
  }
  return lost;
}

export function branchHoursImpact(db, args, user) {
  const a = args || {};
  if (!tableWriteAllowed('branches', 'update', user, db)) throw new RpcError(IMPACT_DENIED, 403, 'forbidden');
  let secondary = false;
  try { secondary = readIdentity(db).role === 'secondary'; } catch { secondary = false; }
  if (secondary) throw new RpcError(BRANCH_MESSAGES.mainOnly, 409, 'conflict');
  const wh = a.working_hours == null ? '{}' : a.working_hours;
  const bad = storedHoursProblem(wh);
  if (bad) throw new RpcError(bad, 400, 'bad_request');
  const id = Number(a.branch_id);
  if (!Number.isInteger(id) || id <= 0) return { doctors: [] };   // новое здание — врачей у него ещё нет
  const before = db.prepare('SELECT working_hours, is_24_7 FROM branches WHERE id = ?').get(id);
  if (!before) return { doctors: [] };
  const after = { working_hours: wh, is_24_7: a.is_24_7 ? 1 : 0 };
  const rows = db.prepare(`SELECT id, full_name, working_hours FROM users
     WHERE branch_id = ? AND is_active = 1
       AND (is_doctor = 1 OR lower(role) = 'doctor' OR trim(coalesce(specialty, '')) <> '')
     ORDER BY full_name, id`).all(id);
  const doctors = [];
  for (const u of rows) {
    const lost = lostHours(u.working_hours, before, after);
    if (lost.length) doctors.push({ id: u.id, name: u.full_name || '', lost });
  }
  return { doctors };
}
```

  Порядок проверок важен для `index.test.js`. Он зовёт каждый RPC с `{}` от администратора: часов нет → `'{}'` → годится → нет id → `{ doctors: [] }`, без исключения.
- [ ] **Step 4: регистрация** `server/services/rpc/index.js`:
  - импорт за :47 — `import { branchHoursImpact } from './branch-hours.js';   // BRANCH_PROFILE_V1`;
  - за `calendar_book` (:286):

```js
  // BRANCH_PROFILE_V1 — «каким врачам какое время закроется» до сохранения
  // часов здания: тот же движок, что слоты. Только считает, ничего не пишет;
  // ворота — право записи в branches (реестр). В READ_ONLY_RPCS не входит:
  // при просроченной лицензии сохранить часы всё равно нельзя.
  branch_hours_impact:       (db, args, user) => branchHoursImpact(db, args, user),
```

- [ ] **Step 5: словарь:**

| ru | uz | en |
|---|---|---|
| Часы работы зданий меняет администратор или тот, кому выдано изменение «Филиалов». | Binolarning ish vaqtini administrator yoki «Filiallar»ni o‘zgartirish huquqi berilgan xodim o‘zgartiradi. | Building working hours are changed by the administrator or by someone granted “Branches” edit rights. |

- [ ] **Step 6:** тест зелёный. Сторожа:
  - `server/services/rpc/index.test.js`, `client-rpc-coverage.test.js`, `slot-engine.test.js`, `calendar.test.js`, `calendar-cross-branch.test.js`, `visits.test.js`;
  - `server/services/gate-fallbacks.test.js` (новых ворот с ключом нет), `server/i18n-server-messages.test.js`.
- [ ] **Step 7: коммит** «Часы здания: RPC «каким врачам какое время закроется» — тот же движок, что слоты; только врачи этого здания; ворота — право записи «Филиалов» (BRANCH_PROFILE_V1)».

---

## Task 7: Синхронизация зданий — профиль, телефон и часы своего здания приходят из главного; разные версии не ломаются (BRANCH_PROFILE_V1)

**Files:**
- Modify: `server/services/branch-sync/catalogue.js` (:24 импорт; :409-417 выгрузка; :436-437 роль; :607-674 приём)
- Test: `server/services/branch-sync/catalogue.test.js` (:500-515 — ожидание; новые тесты в конец файла, после `migratedBefore` :885)

- [ ] **Step 1: падающие тесты.**
  - Существующий тест «справочник несёт список сети…» (:500): ожидание заменить так (определить прямо перед `assert`):

```js
  // BRANCH_PROFILE_V1 — строка сети несёт и профиль здания, и отметку «часы решает главное».
  const BLANK = { phone: '', name_uz: '', name_en: '', country_code: '', region_code: '', district_code: '', street_ru: '', street_uz: '',
    street_en: '', landmark_ru: '', landmark_uz: '', landmark_en: '', maps_url: '', show_public: 1, hours_by_main: 1 };
  assert.deepEqual(out.roster, [
    { letter: 'A', name: 'Heal point', working_hours: WH, is_24_7: 0, ...BLANK },
    { letter: 'C', name: 'Клиника на Чиланзаре', working_hours: '{}', is_24_7: 0, ...BLANK },
  ], 'строка без буквы — не узел сети, соседям ни к чему');
```

  - Над тестом «часы приезжают ЧУЖОМУ зданию и не трогают СВОЁ…» (:517) — строка комментария, сам тест не менять: `// BRANCH_PROFILE_V1 — это выгрузка главной ДО шага 4 (без hours_by_main): свои часы филиала она не трогает (Р14).`
  - В конец файла (импорты добавить наверх):
    - `import { BRANCH_PROFILE_COLUMNS } from '../../../public/js/shared/branch-profile.js';   // BRANCH_PROFILE_V1`;
    - `import { writeBranchHours, blankDays } from '../../../public/js/shared/branch-hours.js';   // BRANCH_PROFILE_V1`.

```js
// ===========================================================================
// BRANCH_PROFILE_V1 (мигр. 241) — профиль зданий едет со списком сети. Его
// правит главное здание; филиал принимает для ВСЕХ букв, включая свою. Часы
// своего здания — тоже из главного, но только от главной шага 4
// (hours_by_main). Главное здание едет с адресом, картой и телефоном из своей
// «Компании» (одно место на здание).
// ===========================================================================
const WEEK_HOURS = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;
const C_PROFILE = { phone: '+998 71 222 33 44', name_uz: 'Chilonzor filiali', name_en: 'Chilonzor branch', country_code: 'UZ',
  region_code: 'tashkent-city', district_code: 'chilonzor', street_ru: 'ул. Бунёдкор, 5', street_uz: 'Bunyodkor ko‘chasi, 5',
  street_en: '5 Bunyodkor St', landmark_ru: 'Напротив метро', landmark_uz: 'Metro qarshisida', landmark_en: 'Opposite the metro',
  maps_url: 'https://yandex.uz/maps/-/CDchil', show_public: 0 };
function mainWithBranches() {
  const db = fresh();
  db.prepare("UPDATE branches SET name = 'Главный корпус', name_uz = 'Bosh bino' WHERE letter = 'A'").run();
  db.prepare("INSERT INTO branches (name, letter) VALUES ('Чиланзар', 'C')").run();
  const sets = Object.keys(C_PROFILE).map((k) => `"${k}" = @${k}`).join(', ');
  db.prepare(`UPDATE branches SET ${sets}, working_hours = @wh WHERE letter = 'C'`).run({ ...C_PROFILE, wh: WEEK_HOURS });
  return db;
}

test('строка сети несёт профиль здания и отметку «часы решает главное»', () => {
  const c = exportCatalogue(mainWithBranches()).roster.find((r) => r.letter === 'C');
  assert.deepEqual(c, { letter: 'C', name: 'Чиланзар', working_hours: WEEK_HOURS, is_24_7: 0, ...C_PROFILE, hours_by_main: 1 });
});

test('главное здание едет с адресом, картой и телефоном из своей «Компании», названия — из «Филиалов»', () => {
  const src = mainWithBranches();
  src.prepare(`UPDATE doc_settings SET phone = '+998 71 200 12 00', region_code = 'tashkent-city', district_code = 'mirobod',
    street_ru = 'ул. Мира, 1', maps_url = 'https://yandex.uz/maps/-/CDmain' WHERE id = 1`).run();
  src.prepare("UPDATE branches SET phone = 'старый', street_ru = 'не отсюда' WHERE letter = 'A'").run();
  const a = exportCatalogue(src).roster.find((r) => r.letter === 'A');
  assert.deepEqual([a.phone, a.region_code, a.street_ru, a.maps_url], ['+998 71 200 12 00', 'tashkent-city', 'ул. Мира, 1', 'https://yandex.uz/maps/-/CDmain']);
  assert.equal(a.name_uz, 'Bosh bino');
});

test('филиал принимает профиль всех зданий, включая своё, и часы своего — от главной шага 4', () => {
  const dst = fresh();
  becomeSecondary(dst, { letter: 'C', name: 'Чиланзар' });
  dst.prepare("UPDATE branches SET address = 'ул. Своя, 1' WHERE letter = 'C'").run();
  const summary = apply(dst, exportCatalogue(mainWithBranches()));
  assert.ok(summary.roster >= 2);
  const c = dst.prepare("SELECT * FROM branches WHERE letter = 'C'").get();
  for (const [k, v] of Object.entries(C_PROFILE)) assert.equal(c[k], v, k);
  assert.equal(c.working_hours, WEEK_HOURS, 'часы своего здания решает главное');
  assert.equal(c.address, 'ул. Своя, 1', 'прежний адрес — свой у установки, не едет');
  assert.equal(dst.prepare("SELECT name_uz FROM branches WHERE letter = 'A'").get().name_uz, 'Bosh bino');
  assert.equal(apply(dst, exportCatalogue(mainWithBranches())).roster || 0, 0, 'повтор ничего не меняет');
});

test('незнакомая буква заводится сразу с профилем (active = 0, как и прежде)', () => {
  const dst = fresh();
  becomeSecondary(dst, { letter: 'D', name: 'Сергели' });
  apply(dst, exportCatalogue(mainWithBranches()));
  const c = dst.prepare("SELECT * FROM branches WHERE letter = 'C'").get();
  assert.deepEqual([c.active, c.name_en, c.show_public], [0, 'Chilonzor branch', 0]);
});

test('мусор в профиле не роняет приём: значение, которое база не примет, пропущено, остальное принято', () => {
  const cat = exportCatalogue(seedMain(mainWithBranches()));
  Object.assign(cat.roster.find((r) => r.letter === 'C'),
    { name_uz: null, name_en: 42, maps_url: 'https://maps.google.com/x', show_public: 2, street_ru: 'x'.repeat(500) });
  const dst = receiver();
  becomeSecondary(dst, { letter: 'C', name: 'Чиланзар' });
  assert.doesNotThrow(() => apply(dst, cat));
  const row = dst.prepare("SELECT * FROM branches WHERE letter = 'C'").get();
  assert.deepEqual([row.name_uz, row.name_en, row.maps_url, row.show_public, row.street_ru], ['', '', '', 1, '']);
  assert.equal(row.landmark_ru, 'Напротив метро', 'остальное профиля принято');
  assert.ok(dst.prepare("SELECT 1 FROM services WHERE code = 'S-CARD'").get(), 'и прайс тоже');
});

test('выгрузка главной ДО шага 4 (без профиля и отметки): профиль и свои часы филиала не тронуты', () => {
  const dst = fresh();
  becomeSecondary(dst, { letter: 'C', name: 'Чиланзар' });
  dst.prepare("UPDATE branches SET name_uz = 'Chilonzor filiali', working_hours = ? WHERE letter = 'C'").run(WEEK_HOURS);
  apply(dst, { roster: [{ letter: 'A', name: 'Главный корпус', working_hours: '{}', is_24_7: 0 },
    { letter: 'C', name: 'Чиланзар', working_hours: '{}', is_24_7: 1 }] });
  assert.deepEqual({ ...dst.prepare("SELECT name_uz, working_hours, is_24_7 FROM branches WHERE letter = 'C'").get() },
    { name_uz: 'Chilonzor filiali', working_hours: WEEK_HOURS, is_24_7: 0 });
});

test('главное здание с базой до 241 → новый филиал: профиля в выгрузке нет, приём не падает', () => {
  const oldMain = migratedBefore(241);
  oldMain.prepare("INSERT INTO branches (name, letter) VALUES ('Чиланзар', 'C')").run();
  const cat = exportCatalogue(oldMain);
  for (const col of BRANCH_PROFILE_COLUMNS) assert.equal(col in cat.roster.find((r) => r.letter === 'C'), false, col);
  const dst = fresh();
  becomeSecondary(dst, { letter: 'C', name: 'C' });
  dst.prepare("UPDATE branches SET name_uz = 'Chilonzor filiali' WHERE letter = 'C'").run();
  assert.doesNotThrow(() => apply(dst, cat));
  assert.equal(dst.prepare("SELECT name_uz FROM branches WHERE letter = 'C'").get().name_uz, 'Chilonzor filiali');
});

test('новое главное здание → филиал с базой до 241: профиль пропущен, имена и часы приняты; холостой прогон видит то же', () => {
  const oldBranch = migratedBefore(241);
  becomeSecondary(oldBranch, { letter: 'C', name: 'C' });
  const dry = applyCatalogue(oldBranch, exportCatalogue(mainWithBranches()), { dryRun: true });
  const summary = apply(oldBranch, exportCatalogue(mainWithBranches()));
  assert.equal(summary.roster, dry.roster);
  assert.deepEqual({ ...oldBranch.prepare("SELECT name, working_hours FROM branches WHERE letter = 'C'").get() }, { name: 'Чиланзар', working_hours: WEEK_HOURS });
});

test('филиал не отдаёт ни профиля, ни отметки — главное правит только главное', () => {
  const db = fresh();
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  for (const r of exportCatalogue(db).roster) assert.deepEqual(Object.keys(r).sort(), ['is_24_7', 'letter', 'name', 'working_hours']);
});
```

- [ ] **Step 2:** `node --test server/services/branch-sync/catalogue.test.js` → новые и изменённый падают.
- [ ] **Step 3: правка** `catalogue.js`.
  - Импорт за :24: `import { BRANCH_SYNC_COLUMNS, syncableBranchValue, overlayOwnBuilding } from '../../../public/js/shared/branch-profile.js';   // BRANCH_PROFILE_V1`.
  - Строки :436-437 (`const identity = …` и `const isMain = …`) перенести целиком (с их комментарием) ВЫШЕ блока списка сети, и читать в них ещё `branch_id`:

```js
  // BRANCH_PROFILE_V1 — роль и СВОЯ строка установки нужны уже списку сети
  // ниже: профиль зданий отдаёт только главное, и своё здание главного едет с
  // адресом, картой и телефоном из его «Компании».
  const identity = db.prepare('SELECT role, branch_id FROM branch_identity WHERE id = 1').get();
  const isMain = !identity || identity.role !== 'secondary';
  const ownBranchId = identity ? identity.branch_id : null;
```

  - Выгрузка списка сети (:409-417):

```js
  out.roster = db.prepare(
    "SELECT * FROM branches WHERE letter IS NOT NULL AND letter <> '' ORDER BY letter"
  ).all().map((raw) => {
    // BRANCH_PROFILE_V1 — главное здание: адрес для партнёров, карта и телефон
    // — из его «Компании» (shared/branch-profile.js overlayOwnBuilding).
    const r = isMain && ownBranchId != null && raw.id === ownBranchId ? overlayOwnBuilding(raw, settings) : raw;
    const entry = { letter: r.letter, name: r.name || '', working_hours: r.working_hours || '', is_24_7: r.is_24_7 ? 1 : 0 };
    // BRANCH_PROFILE_V1 — профиль здания и «часы решает главное» отдаёт только
    // главное. Колонки, которой у этой базы нет (до мигр. 241), в строке нет
    // вовсе: «не знаю» — отсутствующий ключ, а не null (как 9dde74bf).
    if (isMain) {
      for (const col of BRANCH_SYNC_COLUMNS) if (col in r && r[col] != null) entry[col] = r[col];
      entry.hours_by_main = 1;
    }
    return entry;
  });
```

  - Приём (:607-674). Прочитать строку целиком; профиль и часы своей буквы — по правилам Р9. Сразу за `const mine = letterOfIdentity(db);`, перед циклом `for (const entry of payload.roster)`, вставить:

```js
    // BRANCH_PROFILE_V1 — ЧАСЫ СВОЕГО ЗДАНИЯ РЕШАЕТ ГЛАВНОЕ (спецификация:
    // «часы правит только главное здание»). Главная шага 4 помечает это в каждой
    // строке (hours_by_main); главная старше её не помечает — и тогда свои
    // часы филиала, как и прежде, не трогаются (выгрузка старой главной шлёт за
    // наше здание то, что знает она, — обычно '{}').
    // ПРОФИЛЬ ЗДАНИЯ — только присланные ключи (старая главная их не шлёт —
    // местное остаётся), только колонки, которые у этой базы уже есть (филиал
    // до мигр. 241), и только значения, которые база примет: null, чужой тип,
    // ссылка не на Яндекс Карты пропускаются, а не роняют приём.
    const profileChanges = (entry, row) => {
      const out = {};
      for (const col of BRANCH_SYNC_COLUMNS) {
        if (!(col in entry) || !(col in row)) continue;
        if (!syncableBranchValue(col, entry[col])) continue;
        if (!sameValue(entry[col], row[col])) out[col] = entry[col];
      }
      return out;
    };
    const writeProfile = (letter, changes) => {
      const keys = Object.keys(changes);
      if (!keys.length) return;
      // Имена колонок — из константы, значения — параметрами (тот же инвариант, что у TABLES).
      db.prepare(`UPDATE branches SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE letter = ? COLLATE NOCASE`)
        .run(...keys.map((k) => changes[k]), letter);
    };
```

  В цикле:
  - `const row = db.prepare('SELECT * FROM branches WHERE letter = ? COLLATE NOCASE').get(entry.letter);   // BRANCH_PROFILE_V1 — вся строка`.
  - В ветке незнакомой буквы, после `adopt.run(...)` и прежнего `hours.run(...)`:

```js
          const fresh = db.prepare('SELECT * FROM branches WHERE letter = ? COLLATE NOCASE').get(entry.letter);   // BRANCH_PROFILE_V1
          if (fresh) writeProfile(entry.letter, profileChanges(entry, fresh));
```

  - Для известной буквы — вместо прежнего `wantHours` и проверки «ничего не изменилось»:

```js
      const ownHours = entry.hours_by_main === 1;   // BRANCH_PROFILE_V1
      const wantHours = ('working_hours' in entry) && letter && (letter !== mine || ownHours)
        && (!sameValue(entry.working_hours || '', row.working_hours || '')
          || !sameValue(entry.is_24_7 ? 1 : 0, row.is_24_7 ? 1 : 0));
      const profile = profileChanges(entry, row);   // BRANCH_PROFILE_V1
      if (row.name === name && !wantHours && !Object.keys(profile).length) continue;
      summary.roster = (summary.roster || 0) + 1;
      summary.changed += 1;
      if (!dryRun) {
        if (row.name !== name) rename.run(name, entry.letter);
        if (wantHours) hours.run(entry.working_hours || '', entry.is_24_7 ? 1 : 0, entry.letter);
        writeProfile(entry.letter, profile);   // BRANCH_PROFILE_V1
      }
```

- [ ] **Step 4:** тесты зелёные. Сторожа (явными путями):
  - `server/services/branch-sync/`: `sync-e2e.test.js`, `relay.test.js`, `relay-e2e.test.js`, `relay-crypto.test.js`, `cross-branch.test.js`, `records-e2e.test.js`, `identity.test.js`, `journal.test.js`;
  - `server/services/rpc/`: `calendar.test.js`, `calendar-cross-branch.test.js`, `branch-sync.test.js`;
  - `server/services/report-access.journals.test.js` — настоящие `exportCatalogue` / `applyCatalogue` между версиями; он поймал смешанные версии в шаге 3.
- [ ] **Step 5: коммит** «Синхронизация зданий: профиль, телефон и часы своего здания приходят из главного; главное здание — с адресом из «Компании»; старые главная и филиал не ломаются (BRANCH_PROFILE_V1)».

---

## Task 8: Сетка «день недели: с — до» — одна на «Сотрудников» и «Филиалы» (BRANCH_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/week-hours.js`, `public/js/admin/__tests__/week-hours.test.mjs`
- Modify: `public/js/admin/views/employees.js` (:59 `DAYS` — удалить; :1513-1526 `buildHours`; импорт)
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `__tests__/week-hours.test.mjs`. Поддельный DOM — копия `company-profile.test.mjs:21-149`: `FakeNode`, `FakeText`, `makeStyle`, `descendants`, `matches`, `mkEl`, `globalThis.document` / `localStorage` (`admin.lang = 'ru'`) / `window`. Затем:

```js
import fs from 'node:fs';
const { weekHoursGrid, WEEK_DAYS } = await import('../views/week-hours.js');

test('семь строк; отмеченный день — время открыто, неотмеченный — закрыто; подписи времени', () => {
  const g = weekHoursGrid({ mon: { on: true, from: '08:00', to: '17:00' } });
  assert.deepEqual(Object.keys(g.rows), WEEK_DAYS.map(([k]) => k));
  assert.equal(g.rows.mon.chk.checked, true);
  assert.deepEqual([g.rows.mon.from.value, g.rows.mon.to.value, g.rows.mon.from.disabled], ['08:00', '17:00', false]);
  assert.equal(g.rows.tue.chk.checked, false);
  assert.deepEqual([g.rows.tue.from.value, g.rows.tue.from.disabled], ['09:00', true]);
  assert.equal(g.rows.mon.from.getAttribute('aria-label'), 'Пн, с');
  assert.equal(g.rows.mon.to.getAttribute('aria-label'), 'Пн, до');
});

test('изменение дня — onChange(ключ, { on, from, to }); время открывается вместе с днём', () => {
  const calls = [];
  const g = weekHoursGrid({}, { onChange: (k, e) => calls.push([k, e]) });
  g.rows.sat.chk.checked = true;
  g.rows.sat.chk.dispatchEvent({ type: 'change', target: g.rows.sat.chk });
  assert.deepEqual(calls, [['sat', { on: true, from: '09:00', to: '18:00' }]]);
  assert.equal(g.rows.sat.from.disabled, false);
});

test('замок: всё выключено; снятый замок возвращает правило «время — у отмеченных»', () => {
  const g = weekHoursGrid({ mon: { on: true, from: '09:00', to: '18:00' } }, { disabled: true });
  assert.ok(Object.values(g.rows).every((r) => r.chk.disabled && r.from.disabled && r.to.disabled));
  g.setDisabled(false);
  assert.equal(g.rows.mon.from.disabled, false);
  assert.equal(g.rows.tue.from.disabled, true);
});

test('«Сотрудники» берут ту же сетку — своей больше нет', () => {
  const src = fs.readFileSync(new URL('../views/employees.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ weekHoursGrid \} from '\.\/week-hours\.js'/);
  assert.doesNotMatch(src, /type: 'time'/);
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/week-hours.test.mjs` → падает.
- [ ] **Step 3: модуль** `views/week-hours.js` — перенос `buildHours` из `employees.js:1513-1526`, с замком и подписями времени:

```js
// BRANCH_PROFILE_V1 — сетка «день недели: работает, с — до». Одна на
// программу: рабочее время сотрудника («Сотрудники», employees.js) и часы
// здания («Филиалы», branch-hours-card.js). Сетка ничего не решает сама:
// каждое изменение дня — onChange(ключ, { on, from, to }); что записать,
// решает экран (сотрудник — тронутый день поверх прежнего графика, как
// всегда; здание — все семь дней).
import { h } from '../ui.js';
import { tr, trf } from '../i18n.js';

export const WEEK_DAYS = Object.freeze([['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']]);
const OFF = Object.freeze({ on: false, from: '09:00', to: '18:00' });

export function weekHoursGrid(days, { onChange = null, disabled = false } = {}) {
    const wrap = h('div', { class: 'wkh-grid', style: { display: 'grid', gap: '6px' } });
    const rows = {};
    let locked = !!disabled;
    for (const [key, label] of WEEK_DAYS) {
        const d = (days && days[key]) || OFF;
        const chk = h('input', { type: 'checkbox' });
        chk.checked = !!d.on;
        const from = h('input', { type: 'time', value: d.from || '09:00', style: { width: '110px' } });
        const to = h('input', { type: 'time', value: d.to || '18:00', style: { width: '110px' } });
        from.setAttribute('aria-label', trf('{day}, с', { day: tr(label) }));
        to.setAttribute('aria-label', trf('{day}, до', { day: tr(label) }));
        const paint = () => { chk.disabled = locked; from.disabled = locked || !chk.checked; to.disabled = locked || !chk.checked; };
        const commit = () => { paint(); if (typeof onChange === 'function') onChange(key, { on: chk.checked, from: from.value, to: to.value }); };
        chk.addEventListener('change', commit);
        from.addEventListener('change', commit);
        to.addEventListener('change', commit);
        paint();
        rows[key] = { chk, from, to, paint };
        wrap.appendChild(h('div', { class: 'wkh-row', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0', flexWrap: 'wrap' } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', width: '80px', cursor: 'pointer' } },
                chk, h('span', { style: { fontWeight: 600, fontSize: '13.5px' } }, label)),
            from, h('span', { class: 'muted' }, '—'), to));
    }
    return { node: wrap, rows, setDisabled(v) { locked = !!v; for (const r of Object.values(rows)) r.paint(); } };
}
```

- [ ] **Step 4: `employees.js`.**
  - Импорт рядом с остальными видами: `import { weekHoursGrid } from './week-hours.js';   // BRANCH_PROFILE_V1 — сетка дней одна на программу`.
  - Удалить `const DAYS = …` (:59) — его читала только `buildHours` (проверить `grep -n "DAYS" public/js/admin/views/employees.js`).
  - Тело `buildHours`:

```js
function buildHours(emp, markDirty) {
    // BRANCH_PROFILE_V1 — сетка вынесена в week-hours.js (её же берут «Филиалы»).
    // Пишется, как и прежде, тронутый день поверх прежнего графика.
    return weekHoursGrid(emp.working_hours, {
        onChange: (key, entry) => markDirty({ working_hours: { ...emp.working_hours, [key]: entry } }),
    }).node;
}
```

- [ ] **Step 5: словарь:**

| ru | uz | en |
|---|---|---|
| {day}, с | {day}, dan | {day}, from |
| {day}, до | {day}, gacha | {day}, to |

- [ ] **Step 6:** тесты зелёные. Сторожа:
  - `__tests__/`: `employees-card-save.test.mjs`, `employees-profile-save.test.mjs`, `employees-managed.test.mjs`, `employee-branch.test.mjs`;
  - `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 7: коммит** «Сетка «день недели: с — до» — один модуль на «Сотрудников» и «Филиалы»; у полей времени — подписи для читалки экрана (BRANCH_PROFILE_V1)».

---

## Task 9: «нет перевода» — в общем поле на трёх языках (проверка; сделано полировкой шага 3) (BRANCH_PROFILE_V1)

Аудит, пункт 3: пометка — в общем компоненте, чтобы её получили «Компания», «Филиалы» и следующие шаги.
- Сделано коммитом `0f54eb06` (полировка шага 3, `CLINIC_PROFILE_V1`): `triGroup(…, { markMissing: true })` в `public/js/admin/views/company-fields.js`.
  - Класс `.cpf-miss`, текст «нет перевода», только UZ / EN.
  - Пропадает с первым знаком; одни пробелы — пусто.
  - В «Компании» включена у названий, описания и улицы (`company-address.js`).
- Эта задача ничего не пишет. Она проверяет, что пометка есть, до задач 12–13: они на неё опираются. Название филиала — `markMissing: true`, ориентир — без неё.

- [ ] **Step 1:** `git log --oneline -- public/js/admin/views/company-fields.js | head -3` показывает `0f54eb06`, и `grep -n "markMissing" public/js/admin/views/company-fields.js public/js/admin/views/company-address.js` находит опцию и улицу.
- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/company-profile.test.mjs` — зелёный, включая тест полировки «нет перевода» (~:914).
- [ ] **Step 3:** если `0f54eb06` в ветке нет — остановиться и доложить (BLOCKED). Не переписывать по памяти: интерфейс `markMissing` уже зафиксирован полировкой.

Коммита у задачи нет.

---

## Task 10: Карточки адреса и карты «Компании» — заголовок, подсказка и замок от вызывающего; подсказка «Адреса других зданий — в «Филиалах».» возвращена (BRANCH_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/company-address.js` (`addressCard`, `mapCard`)
- Create: `public/js/admin/__tests__/branches-screen.test.mjs` (харнесс экрана «Филиалы», им пользуются задачи 10, 12–15)
- Modify: `public/js/admin/i18n-strings.js` (статья подсказки — заменить на дополненную)

- [ ] **Step 1: харнесс и падающий тест** `__tests__/branches-screen.test.mjs`.
  - Скопировать из `company-profile.test.mjs`:
    - :18-149 — поддельный DOM и глобалы, `admin.lang = 'ru'` до импорта;
    - `GEO` :154-161;
    - помощники :230-278 и :534-558 (`settle`, `textOf`, `labelText`, `isCtrl`, `triInput`, `fieldBox`, `fieldInput`, `fieldError`, `type`, `buttons`, `buttonByText`, `save`, `toastText`, `geoSel`, `selectedValue`, `choose`, `fullAddr`, `triError`, `routeDd`);
    - `isOff` :796.
  - Поддельный сервер:

```js
const { BRANCH_PROFILE_COLUMNS } = await import('../../shared/branch-profile.js');
const BLANK_ROW = { name: '', phone: '', address: '', license_number: '', is_24_7: 0, working_hours: '{}', active: 1,
  created_at: '2026-01-01T00:00:00Z', ...Object.fromEntries(BRANCH_PROFILE_COLUMNS.map((c) => [c, c === 'show_public' ? 1 : ''])) };
let branchRows = [];      // строки branches «на сервере»
let companyRow = null;    // строка doc_settings (список «Филиалов» читает её для своего здания)
let writes = [];          // [{ op, values, filters }]
let impactCalls = [];     // тела branch_hours_impact
let impactReply = { data: { doctors: [] } };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/rpc/branch_hours_impact')) {
        impactCalls.push(JSON.parse(opts.body || '{}'));
        if (impactReply.error) return { ok: false, status: impactReply.status || 500, json: async () => ({ error: impactReply.error }) };
        return ok({ data: impactReply.data });
    }
    if (u.startsWith('/api/rpc/')) return ok({ data: null });
    if (u.startsWith('/api/db')) {
        let desc = {};
        try { desc = JSON.parse(opts.body || '{}'); } catch (_) { /* пусто */ }
        const op = desc.op || 'select';
        if (desc.table === 'branches') {
            if (op === 'select') return ok({ data: branchRows.map((r) => ({ ...r })) });
            writes.push({ op, values: desc.values, filters: desc.filters || [] });
            if (op === 'update') {
                const id = (desc.filters || []).find((f) => f.col === 'id').val;
                const r = branchRows.find((x) => x.id === id);
                Object.assign(r, desc.values);
                return ok({ data: { ...r } });
            }
            const r = { ...BLANK_ROW, ...desc.values, id: 100 + branchRows.length };
            branchRows.push(r);
            return ok({ data: { ...r } });
        }
        if (desc.table === 'doc_settings') return ok({ data: companyRow ? { ...companyRow } : null });
        if (GEO[desc.table]) {
            let rows = GEO[desc.table].filter((r) => r.active);
            for (const f of desc.filters || []) if (f.op === 'eq' && f.col !== 'active') rows = rows.filter((r) => String(r[f.col]) === String(f.val));
            return ok({ data: rows.map((r) => ({ ...r })) });
        }
        return ok({ data: op === 'select' ? [] : null, count: 0 });
    }
    return ok({});
};
```

  - Тест задачи 10:

```js
// ===========================================================================
// Задача 10 — карточки шага 3 с заголовком, подсказкой и замком от вызывающего.
// ===========================================================================
const { addressCard, mapCard } = await import('../views/company-address.js');

test('адрес: свой заголовок, подсказка, замок, узел после улицы; без опций — как в «Компании» и с подсказкой про «Филиалы»', async () => {
    const st = { country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1', street_uz: '', street_en: '', maps_url: '' };
    const after = mkEl('p'); after.textContent = 'после улицы';
    const a = addressCard(st, { title: 'Адрес для партнёров и сайта', hint: 'Своя подсказка.', disabled: true, after });
    const root = mkEl('div'); root.appendChild(a.node);
    await a.load(); await settle(40);
    assert.match(textOf(root), /Своя подсказка\./);
    for (const l of ['Страна', 'Город / область', 'Район']) assert.ok(isOff(geoSel(root, l)), l + ' выключен');
    assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod', 'сохранённое видно и под замком');
    assert.ok(isOff(triInput(root, 'Улица, дом', 'ru')));
    assert.ok(descendants(a.node).includes(after));

    const plain = addressCard({ ...st }, {});
    assert.match(textOf(plain.node), /Адреса других зданий — в «Филиалах»\./, 'подсказка шага 3 возвращена');

    const m = mapCard({ maps_url: '' }, { label: 'Ссылка на филиал в Яндекс Картах', hint: 'Подсказка карты.', disabled: true });
    const mr = mkEl('div'); mr.appendChild(m.node); m.load();
    assert.ok(isOff(fieldInput(mr, 'Ссылка на филиал в Яндекс Картах')));
    assert.match(textOf(mr), /Подсказка карты\./);
    const mDefault = mkEl('div'); mDefault.appendChild(mapCard({ maps_url: '' }).node);
    assert.ok(fieldInput(mDefault, 'Ссылка на клинику в Яндекс Картах'), 'без опций — подпись «Компании»');
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/branches-screen.test.mjs` → падает.
- [ ] **Step 3: правка** `company-address.js`.
  - Подпись: `export function addressCard(state, { onChange = null, secondary = false, title = '', hint = '', disabled = false, after = null } = {})`.
  - В `mountGeo()` — после трёх `boxes.*.put(...)`:

```js
        // BRANCH_PROFILE_V1 — замок от вызывающего («Филиалы»: своё здание
        // главного и филиал; «Компания» филиала): списки видны, выбрать нельзя.
        if (disabled) for (const s of [mine.countrySel, mine.regionSel, mine.districtSel]) { s.disabled = true; s.setAttribute('disabled', ''); }
```

  - В `triGroup('Улица, дом', …)` добавить `disabled,   // BRANCH_PROFILE_V1` (`markMissing: true` там уже есть — `0f54eb06`).
  - Заголовок — `title || (secondary ? 'Адрес этого здания для партнёров и сайта' : 'Адрес для партнёров и сайта')`.
  - Подсказка — `hint || 'Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. На бланках печатается «Адрес в документах» из «Реквизитов» — эти списки его не меняют. Адреса других зданий — в «Филиалах».'`. Хвост — `// BRANCH_PROFILE_V1 — подсказка шага 3 «Адреса других зданий — в «Филиалах»» возвращена (аудит макета)`.
  - После `street.node` — `...[].concat(after || []),   // BRANCH_PROFILE_V1 — «Филиалы»: ориентир, прежний адрес`.
  - `mapCard(state, { onChange = null, label = '', hint = '', disabled = false } = {})`:
    - у `inp` — `disabled` в `h()` и `inp.disabled = disabled;`;
    - подпись — `label || 'Ссылка на клинику в Яндекс Картах'`;
    - подсказка — `hint || <прежний текст>`.
- [ ] **Step 4: словарь.** Статью «Страна, город и район — … эти списки его не меняют.» заменить статьёй с дописанным хвостом. Прежний ключ больше нигде не нужен: `grep -rn "эти списки его не меняют" public/js`.

| ru | uz | en |
|---|---|---|
| Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. На бланках печатается «Адрес в документах» из «Реквизитов» — эти списки его не меняют. Адреса других зданий — в «Филиалах». | Mamlakat, shahar va tuman — bemorni ro‘yxatga olishdagi kabi ro‘yxatlardan; hamkorlar ularning kodlarini oladi. Blankalarda «Klinika rekvizitlari»dagi «Hujjatlardagi manzil» bosiladi — bu ro‘yxatlar uni o‘zgartirmaydi. Boshqa binolarning manzillari — «Filiallar»da. | Country, city and district come from the lists, as in patient registration; partners receive their codes. Forms print the “Address on documents” from “Clinic details” — these lists do not change it. Addresses of the other buildings are in “Branches”. |

- [ ] **Step 5:** тест зелёный. Сторожа: `company-profile.test.mjs` (вся «Компания» — как была), `geo-cascade.test.mjs`, `i18n-coverage`, `i18n-uz-quality`.
- [ ] **Step 6: коммит** (свои ханки `company-address.js` и словаря — по метке) «Карточки адреса и карты: заголовок, подсказка и замок задаёт экран; в «Компании» вернулась подсказка «Адреса других зданий — в «Филиалах»» (BRANCH_PROFILE_V1)».

---

## Task 11: «Компания» филиала — адрес для партнёров, карта и телефон для сайта из «Филиалов» главного здания (BRANCH_PROFILE_V1)

**Р2 для филиала.** Адрес филиала для сайта ведёт главное здание. Его «Компания» показывает этот адрес из своей строки `branches`, которая приезжает со списком сети, — только для чтения. Свой адрес, телефон и почта для документов остаются своими.

Полировка шага 3 правит те же файлы — свои ханки только по метке.

**Files:**
- Modify: `server/services/rpc/clinic.js` (`own_branch_id`), Test: `server/services/rpc/clinic.test.js`
- Modify: `public/js/shared/clinic-profile.js` (`COMPANY_PRINT`, `COMPANY_PARTNER`)
- Modify: `server/routes/db.js` (`companyBranchRefusal` :660-668; текст `COMPANY_MAIN_ONLY` :659)
- Modify: `public/js/admin/views/documents-settings.js` (`COMPANY_MAIN_ONLY`; `mount` :166-169; `load` :368; `renderPatientPreview` :486; `save` :418; подсказка телефона в `buildForm`)
- Test: `server/routes/company-secondary.test.js`, `public/js/admin/__tests__/company-profile.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающие тесты.**
  - `clinic.test.js` (импорты `openDb`, `migrate`, `becomeSecondary` в файле есть — их зовёт тест `building_role` :60):

```js
// BRANCH_PROFILE_V1 — строка branches этого здания: «Филиалы» помечают её «Это здание»,
// «Компания» филиала берёт из неё адрес для партнёров, карту и телефон для сайта.
test('get_clinic_by_slug: own_branch_id — строка этого здания (главное — A, филиал — своя буква)', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.equal(getClinicBySlug(db, {}, null).own_branch_id, db.prepare("SELECT id FROM branches WHERE letter = 'A'").get().id);
  becomeSecondary(db, { letter: 'C', name: 'Чиланзар' });
  assert.equal(getClinicBySlug(db, {}, null).own_branch_id, db.prepare("SELECT id FROM branches WHERE letter = 'C'").get().id);
  db.close();
});
```

  - `company-secondary.test.js`:
    - константу `COMPANY_MAIN_ONLY` (:21) заменить новым текстом (Step 4);
    - тест «филиал: адрес, телефон, почта, коды, улица и карта своего здания сохраняются» переписать в два:

```js
test('филиал: адрес, телефон и почта для документов сохраняются', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    const res = await save(t.base, cookie, { address: 'ул. Филиальная, 7', phone: '+998901112233', email: 'c@luch.uz' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const r = row(t.db);
    assert.deepEqual([r.address, r.phone, r.email], ['ул. Филиальная, 7', '+998901112233', 'c@luch.uz']);
  } finally { t.stop(); }
});

// BRANCH_PROFILE_V1 — адрес филиала для партнёров ведёт главное здание в «Филиалах» (одно место на здание).
test('филиал: коды, улица и карта в «Компании» — 409; неизменённые — не мешают', async () => {
  const t = await startServer({ secondary: true });
  try {
    const cookie = await loginAs(t.base);
    for (const values of [{ region_code: 'tashkent-city' }, { street_ru: 'ул. Филиальная, 7' }, { maps_url: 'https://yandex.uz/maps/-/CDbranch' }]) {
      const res = await save(t.base, cookie, values);
      assert.equal(res.status, 409, JSON.stringify(values));
      assert.equal((await res.json()).error.message, BRANCH_MESSAGES.partnerInBranches);
    }
    const ok = await save(t.base, cookie, { street_ru: '', address: 'ул. Филиальная, 8' });
    assert.equal(ok.status, 200, 'улица как была (пусто) — не отказ');
  } finally { t.stop(); }
});
```

    Импорт: `import { BRANCH_MESSAGES } from '../../public/js/shared/branch-profile.js';`.
  - `company-profile.test.mjs`:
    - в поддельный сервер, перед `geoTables`, — `if (desc.table === 'branches') return ok({ data: ownBranchRow ? { ...ownBranchRow } : null });`;
    - объявление `let ownBranchRow = null;` — рядом с `let docRow`.
    - Тест — после теста задачи 14 шага 3 (~:832):

```js
// BRANCH_PROFILE_V1 — «Компания» филиала: адрес для партнёров, карта и телефон для сайта —
// из «Филиалов» главного здания (своя строка branches), только видны.
test('филиал: адрес для партнёров, карта и телефон для сайта — из «Филиалов», только видны; уходит только своё для документов', async () => {
    ownBranchRow = { id: 7, name: 'Чиланзар', phone: '+998 71 222 33 44', country_code: 'UZ', region_code: 'tashkent-city',
        district_code: 'yunusobod', street_ru: 'ул. Бунёдкор, 5', street_uz: '', street_en: '', maps_url: 'https://yandex.uz/maps/-/CDchil' };
    globalThis.window.CLINIC.own_branch_id = 7;
    try {
        const root = await openAs('secondary', { street_ru: 'своё из шага 3', region_code: '' });
        for (const l of ['Страна', 'Город / область', 'Район']) assert.ok(isOff(geoSel(root, l)), l);
        assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod');
        assert.equal(triInput(root, 'Улица, дом', 'ru').value, 'ул. Бунёдкор, 5', 'из «Филиалов», не из своей «Компании»');
        assert.ok(isOff(triInput(root, 'Улица, дом', 'ru')));
        assert.ok(isOff(fieldInput(root, 'Ссылка на клинику в Яндекс Картах')));
        assert.match(textOf(root), /ведёт главное здание в «Филиалах»/);
        assert.ok(previewLinks(root).some((l) => l.text === 'Позвонить' && l.href === 'tel:+998712223344'), 'предпросмотр — телефон из «Филиалов»');
        type(fieldInput(root, 'Адрес в документах'), 'ул. Филиальная, 7');
        await save(root);
        assert.deepEqual(lastUpdate, { address: 'ул. Филиальная, 7' });
    } finally { ownBranchRow = null; delete globalThis.window.CLINIC.own_branch_id; }
});
```

- [ ] **Step 2:** запуск → новые падают:
  `node --test server/services/rpc/clinic.test.js server/routes/company-secondary.test.js`, `node --experimental-vm-modules --test public/js/admin/__tests__/company-profile.test.mjs`.
- [ ] **Step 3: сервер.**
  - `rpc/clinic.js`, в объект — рядом с `building_role`:

```js
    // BRANCH_PROFILE_V1 — строка branches ЭТОГО здания: «Филиалы» помечают её
    // «Это здание», «Компания» филиала показывает из неё адрес для партнёров.
    own_branch_id: (() => { try { return readIdentity(db).branch_id ?? null; } catch { return null; } })(),
```

  - `clinic-profile.js` — `COMPANY_BUILDING` собрать из двух частей, порядок прежний:

```js
// BRANCH_PROFILE_V1 (шаг 4) — СВОЁ У ЗДАНИЯ делится на две части:
//   • для документов (COMPANY_PRINT) — правится в «Компании» каждого здания;
//   • для партнёров и сайта (COMPANY_PARTNER) — у главного здания это и есть
//     его адрес для сайта; в филиале не правится: адрес филиала ведёт главное
//     здание в «Филиалах», и «Компания» филиала показывает его оттуда.
export const COMPANY_PRINT = Object.freeze(['address', 'phone', 'email']);
export const COMPANY_PARTNER = Object.freeze(['country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en', 'maps_url']);
export const COMPANY_BUILDING = Object.freeze([...COMPANY_PRINT, ...COMPANY_PARTNER]);
```

  - `routes/db.js`:
    - `COMPANY_MAIN_ONLY` — новый текст (Step 4);
    - в импорт из `clinic-profile.js` добавить `COMPANY_PARTNER`;
    - в `companyBranchRefusal` — вместо последних двух строк:

```js
  const has = (c) => Object.prototype.hasOwnProperty.call(values, c);
  if (COMPANY_CLINIC_WIDE.some((c) => has(c) && !same(values[c], cur[c]))) return COMPANY_MAIN_ONLY;
  // BRANCH_PROFILE_V1 — адрес для партнёров и карту филиала ведёт главное
  // здание в «Филиалах» (одно место на здание): здесь они только видны.
  if (COMPANY_PARTNER.some((c) => has(c) && !same(values[c], cur[c]))) return BRANCH_MESSAGES.partnerInBranches;
  return null;
```

- [ ] **Step 4: экран** `documents-settings.js`.
  - Импорт: `COMPANY_PRINT, COMPANY_PARTNER` из `clinic-profile.js`.
  - `COMPANY_MAIN_ONLY` — тот же новый текст, что в `db.js`.
  - В `refs` — `building: {}   // BRANCH_PROFILE_V1 — своя строка branches в филиале`.
  - В `mount()` строки `refs.address = …` / `refs.map = …` заменить:

```js
    // BRANCH_PROFILE_V1 — в филиале адрес для партнёров, карту и телефон для
    // сайта ведёт главное здание в «Филиалах» (одно место на здание): карточки
    // показывают СВОЮ строку branches (приезжает со списком сети), только видно.
    const partner = secondary ? refs.building : state;
    refs.address = addressCard(partner, { onChange: () => renderPreview(), secondary, disabled: secondary,
        hint: secondary ? 'Адрес для партнёров, карту и телефон для сайта этого здания ведёт главное здание в «Филиалах». Здесь они только видны.' : '' });
    refs.map = mapCard(partner, { onChange: () => renderPreview(), disabled: secondary });
```

  - Подсказка под телефоном в `buildForm`:
    `h('p', { class: 'cpf-hint' }, secondary ? 'Печатается на документах этого здания. Сайт и партнёры получают телефон из «Филиалов» главного здания.' : 'У пациентов это кнопка «Позвонить».')`.
  - В `load()` — после `setState(data)` / `refs.loaded`, до `applyStateToControls()`: `if (secondary) await loadBuilding();   // BRANCH_PROFILE_V1`. Функция — рядом с `load()`:

```js
// BRANCH_PROFILE_V1 — своя строка branches (window.CLINIC.own_branch_id). Тот же
// объект, что держат карточки адреса и карты, — меняется на месте.
async function loadBuilding() {
    for (const k of Object.keys(refs.building)) delete refs.building[k];
    const id = typeof window !== 'undefined' && window.CLINIC ? window.CLINIC.own_branch_id : null;
    if (id == null) return;
    try {
        const { data } = await supabase.from('branches').select('*').eq('id', id).maybeSingle();
        if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(refs.building, data);
    } catch (_) { /* не прочиталось — карточки пустые; править их здесь всё равно нельзя */ }
}
```

  - `renderPatientPreview()` — источник предпросмотра:

```js
    // BRANCH_PROFILE_V1 — в филиале пациенты видят адрес, карту и телефон из «Филиалов».
    const src = secondary
        ? { ...state, ...Object.fromEntries(COMPANY_PARTNER.map((c) => [c, refs.building[c] || ''])), phone: refs.building.phone || '' }
        : state;
    refs.patientEl.appendChild(patientPreview(src, { lang: refs.previewLang, parts, logo }));
```

  - `save()`: `changedValues(secondary ? COMPANY_PRINT : COMPANY_COLUMNS)` (было `COMPANY_BUILDING`), с хвостом `// BRANCH_PROFILE_V1 — филиал шлёт только своё для документов`.
- [ ] **Step 5: словарь.** Статью прежнего `COMPANY_MAIN_ONLY` заменить новой; добавить две подсказки:

| ru | uz | en |
|---|---|---|
| Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании. Здесь — адрес, телефон и почта для документов этого здания. | Nomi, tavsifi, logotiplar, sayt va ijtimoiy tarmoqlar, litsenziya va firma rangi bosh binoda o‘zgartiriladi. Bu yerda — shu binoning hujjatlar uchun manzili, telefoni va pochtasi. | The name, description, logos, website and social media, licence and brand colour are changed in the main building. Here — this building’s address, phone and email for documents. |
| Адрес для партнёров, карту и телефон для сайта этого здания ведёт главное здание в «Филиалах». Здесь они только видны. | Bu binoning hamkorlar uchun manzili, xaritasi va sayt uchun telefonini bosh bino «Filiallar»da yuritadi. Bu yerda ular faqat ko‘rinadi. | The main building keeps this building’s address for partners, map and website phone in “Branches”. Here they are view-only. |
| Печатается на документах этого здания. Сайт и партнёры получают телефон из «Филиалов» главного здания. | Shu binoning hujjatlarida bosiladi. Sayt va hamkorlar telefonni bosh binoning «Filiallar» bo‘limidan oladi. | Printed on this building’s documents. The website and partners get the phone from “Branches” in the main building. |

- [ ] **Step 6:** тесты зелёные. Сторожа:
  - сервер: `server/routes/branches-guard.test.js`, `server/services/branch-sync/catalogue.test.js` (`COMPANY_BUILDING` прежний), `server/i18n-server-messages.test.js`;
  - клиент: `__tests__/clinic-brand.test.mjs`, `settings-split.test.mjs`, `public/js/shared/clinic-profile.test.js`, `i18n-coverage`, `i18n-uz-quality`.
- [ ] **Step 7: коммит** (по метке — в файлах полировки) ««Компания» филиала: адрес для партнёров, карта и телефон для сайта — из «Филиалов» главного здания, только просмотр; своё для документов — как было (BRANCH_PROFILE_V1)».

---

## Task 12: Страница здания — название на трёх языках, телефон для пациентов, «Работает», сохранение; филиал и своё здание (BRANCH_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/branch-page.js`
- Test: `public/js/admin/__tests__/branches-screen.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`

Экран ещё не подключён к «Настройкам» (задача 15): приложение работает по-старому.

- [ ] **Step 1: падающие тесты** в `branches-screen.test.mjs`:

```js
// ===========================================================================
// Задачи 12–14 — страница здания.
// ===========================================================================
const { renderBranchPage } = await import('../views/branch-page.js');
const { BRANCH_MESSAGES } = await import('../../shared/branch-profile.js');
async function openPage(row, opts = {}) {
    branchRows = row ? [{ ...BLANK_ROW, ...row }] : [];
    writes = []; impactCalls = []; impactReply = { data: { doctors: [] } };
    const t = document.getElementById('toast'); if (t) t.textContent = '';
    let done = 0;
    const root = mkEl('div');
    await renderBranchPage(root, { row: row ? branchRows[0] : null, onDone: () => { done++; }, onBack: () => {}, ...opts });
    await settle(80);
    return { root, done: () => done };
}

test('новый филиал: без названия RU — объяснение, запроса нет; с названием — вставка без «active»', async () => {
    const { root, done } = await openPage(null);
    const add = buttonByText(root, /^Добавить$/);
    assert.ok(add, 'у нового — «Добавить»');
    add.click(); await settle(60);
    assert.equal(writes.length, 0);
    assert.equal(triError(root, 'Название филиала', 'ru'), 'Введите название на русском.');
    type(triInput(root, 'Название филиала', 'ru'), 'Юнусабад');
    type(triInput(root, 'Название филиала', 'uz'), 'Yunusobod filiali');
    add.click(); await settle(60);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].op, 'insert');
    assert.deepEqual([writes[0].values.name, writes[0].values.name_uz], ['Юнусабад', 'Yunusobod filiali']);
    assert.ok(!('active' in writes[0].values), 'вставка active не принимает');
    assert.equal(done(), 1);
    assert.match(toastText(), /Филиал сохранён/);
});

test('прежний филиал: поля показывают строку; уходит только изменённое, по id', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', name_uz: 'Yunusobod', phone: '+998 71 200 12 00' });
    assert.equal(triInput(root, 'Название филиала', 'ru').value, 'Юнусабад');
    assert.equal(triInput(root, 'Название филиала', 'uz').value, 'Yunusobod');
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad branch');
    await save(root);
    assert.equal(writes[0].op, 'update');
    assert.deepEqual(writes[0].values, { name_en: 'Yunusabad branch' });
    assert.deepEqual(writes[0].filters, [{ col: 'id', op: 'eq', val: 5 }]);
});

test('ничего не меняли — «Нет изменений», запроса нет', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    await save(root);
    assert.equal(writes.length, 0);
    assert.match(toastText(), /Нет изменений/);
});

test('телефон для пациентов и «Работает»', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    fieldInput(root, 'Телефон для пациентов').value = '+998 90 111 22 33';   // phoneInput читается при сохранении
    const act = fieldInput(root, 'Работает');
    act.checked = false; act.dispatchEvent({ type: 'change', target: act });
    await save(root);
    assert.equal(writes[0].values.phone.replace(/\D/g, ''), '998901112233');
    assert.equal(writes[0].values.active, 0);
});

test('своё здание главного: телефон — из «Компании», только виден; кнопка ведёт в «Компанию»; уходит только своё «Филиалов»', async () => {
    const nav = [];
    const { root } = await openPage({ id: 1, name: 'Главный корпус', phone: 'старый' },
        { own: true, company: { phone: '+998 71 200 12 00' }, onNavigate: (r) => nav.push(r) });
    const ph = fieldInput(root, 'Телефон для пациентов');
    assert.ok(isOff(ph));
    assert.equal(ph.value.replace(/\D/g, ''), '998712001200');
    buttonByText(root, /Изменить в «Компании»/).click();
    assert.deepEqual(nav, ['documents-settings']);
    type(triInput(root, 'Название филиала', 'uz'), 'Bosh bino');
    await save(root);
    assert.deepEqual(writes[0].values, { name_uz: 'Bosh bino' });
});

test('филиал: всё только видно, вверху объяснение, кнопки сохранения нет', async () => {
    const { root } = await openPage({ id: 5, name: 'Главный корпус' }, { secondary: true });
    assert.ok(textOf(root).includes(BRANCH_MESSAGES.mainOnly));
    for (const l of ['ru', 'uz', 'en']) assert.ok(isOff(triInput(root, 'Название филиала', l)), l);
    assert.ok(isOff(fieldInput(root, 'Телефон для пациентов')) && isOff(fieldInput(root, 'Работает')));
    assert.equal(buttonByText(root, /^Сохранить$/), null);
    assert.match(textOf(root), /Только просмотр/);
});

test('«Филиалы: Просмотр» — всё только видно', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { readOnly: true });
    assert.equal(buttonByText(root, /^Сохранить$/), null);
    assert.ok(isOff(triInput(root, 'Название филиала', 'ru')));
});

test('«К списку филиалов»: без изменений — сразу; с несохранённым — спрашивает', async () => {
    let backs = 0; const asked = [];
    globalThis.window.confirm = (t) => { asked.push(t); return false; };
    try {
        const { root } = await openPage({ id: 5, name: 'Юнусабад' }, { onBack: () => { backs++; } });
        buttonByText(root, /К списку филиалов/).click();
        assert.deepEqual([backs, asked.length], [1, 0]);
        type(triInput(root, 'Название филиала', 'en'), 'X');
        buttonByText(root, /К списку филиалов/).click();
        assert.equal(backs, 1, 'отказ — остаёмся');
        assert.match(asked[0], /не сохранён/);
    } finally { delete globalThis.window.confirm; }
});
```

- [ ] **Step 2:** запуск → падают (нет вида).
- [ ] **Step 3: вид** `views/branch-page.js`:

```js
// BRANCH_PROFILE_V1 — СТРАНИЦА ЗДАНИЯ в «Филиалах» (шаг 4 API клиники; план
// docs/plans/2026-10-10-clinic-api-4-branches.md, задачи 12–14).
//
// Название здания на трёх языках (RU — branches.name: его показывает вся
// программа, по нему связываются здания; UZ / EN — сайту и партнёрам),
// телефон для пациентов, «Работает»; адрес для партнёров с ориентиром, карта,
// «показывать на сайте» (задача 13); часы работы (задача 14).
//
// ОДНО МЕСТО НА АДРЕС ЗДАНИЯ (Р2):
//   • своё здание главного (own) — адрес для партнёров, карта и телефон живут
//     в «Компании» (doc_settings, шаг 3): здесь только видны, кнопка ведёт туда;
//   • остальные здания — всё здесь (branches), правит главное здание;
//   • в филиале (secondary) — всё только видно: ведёт главное здание.
// Сохраняется только изменённое (как «Компания», ревью C1 шага 3).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, checkField } from '../ui.js';
import { tr } from '../i18n.js';
import { phoneInput } from '../phone-input.js?v=ph1';
import { triGroup, labeled } from './company-fields.js';
import { NAME_MAX } from '../../shared/clinic-profile.js';
import { BRANCH_EDIT_COLUMNS, OWN_FROM_COMPANY, BRANCH_MESSAGES, normalizeBranch, branchProblems, overlayOwnBuilding } from '../../shared/branch-profile.js';

export const BRANCH_DEFAULTS = Object.freeze({
    name: '', name_uz: '', name_en: '', phone: '', address: '', active: 1,
    country_code: '', region_code: '', district_code: '', street_ru: '', street_uz: '', street_en: '',
    landmark_ru: '', landmark_uz: '', landmark_en: '', maps_url: '', show_public: 1,
    working_hours: '{}', is_24_7: 0,
});
const ADDRESS_COLUMNS = ['country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en'];
const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);

function card(icon, title, ...body) {
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon(icon, { size: 16 }), ' ', title)),
        h('div', { class: 'cpf-body' }, ...body));
}
function askDiscard() {
    const text = tr('Филиал изменён, но не сохранён. Вернуться к списку? Изменения пропадут.');
    return (typeof window !== 'undefined' && typeof window.confirm === 'function') ? window.confirm(text) : true;
}

export async function renderBranchPage(container, {
    row = null, company = null, own = false, readOnly = false, secondary = false,
    onDone = null, onBack = null, onNavigate = null,
} = {}) {
    const isNew = !row || !row.id;
    const lockAll = readOnly || secondary;    // филиал или «Просмотр» — только видно
    const lockCompany = lockAll || own;       // своё здание главного: адрес, карта, телефон — в «Компании»
    const state = { ...BRANCH_DEFAULTS, ...(own ? overlayOwnBuilding(row, company) : (row || {})) };
    const errs = {};
    let availability = () => ({});            // задача 13 — доступность списков адреса
    let busy = false;

    const name = triGroup('Название филиала', { ru: state.name, uz: state.name_uz, en: state.name_en }, {
        key: 'bname', cellLabel: 'Название', max: NAME_MAX, disabled: lockAll, markMissing: true,
        hint: 'RU — так филиал называется во всей программе, в отчётах и при связи зданий. UZ и EN получают сайт и партнёры.',
        onInput: (l, v) => { state[l === 'ru' ? 'name' : 'name_' + l] = v; },
    });
    errs.name = name.inputs.ru.err;
    const activeChk = h('input', { type: 'checkbox' });
    activeChk.checked = Number(state.active) !== 0;
    activeChk.disabled = lockAll;
    activeChk.addEventListener('change', () => { state.active = activeChk.checked ? 1 : 0; });

    const phone = phoneInput('phone', '+998 71 200 12 00', { value: state.phone });
    phone.disabled = lockCompany;
    const phoneBox = labeled('Телефон для пациентов', phone, { key: 'bphone', hint: 'У пациентов это кнопка «Позвонить».' });

    const cards = [
        card('Building', 'Название', name.node, isNew ? null : checkField('Работает', activeChk)),
        card('Phone', 'Телефон', phoneBox.node),
    ];

    const collect = () => {
        state.phone = phone.value;
        return normalizeBranch(state);
    };
    const pick = (v) => Object.fromEntries(BRANCH_EDIT_COLUMNS.map((c) => [c, v[c]]));
    let loaded = pick(collect());
    const editable = lockAll ? [] : BRANCH_EDIT_COLUMNS.filter((c) => !(own && OWN_FROM_COMPANY.includes(c)) && !(isNew && c === 'active'));
    const changedOf = (v) => {
        const out = {};
        for (const c of editable) if (isNew || !same(v[c], loaded[c])) out[c] = v[c];
        return out;
    };
    const dirty = () => { const v = pick(collect()); return BRANCH_EDIT_COLUMNS.some((c) => !same(v[c], loaded[c])); };

    function problemsFor(v, keys) {
        const all = branchProblems(v, availability());
        const addrTouched = keys.some((k) => ADDRESS_COLUMNS.includes(k));
        const out = {};
        for (const [k, msg] of Object.entries(all)) {
            const mine = k === 'name' ? (isNew || keys.includes('name')) : (keys.includes(k) || (addrTouched && ADDRESS_COLUMNS.includes(k)));
            if (mine) out[k] = msg;
        }
        return out;
    }
    function showProblems(p) {
        for (const [k, e] of Object.entries(errs)) {
            const m = p[k];
            if (Array.isArray(m)) e.set(m[0], m[1]); else e.set(m || '');
        }
    }

    const saveBtn = lockAll ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => save() },
        Icon('Check', { size: 14 }), ' ', isNew ? 'Добавить' : 'Сохранить');
    async function save() {
        if (busy || lockAll) return;
        const v = collect();
        const payload = changedOf(v);
        const keys = Object.keys(payload);
        if (!keys.length) { showProblems({}); toast(tr('Нет изменений'), 'info'); return; }
        const problems = problemsFor(v, keys);
        showProblems(problems);
        if (Object.keys(problems).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
        busy = true; saveBtn.disabled = true;
        try {
            const q = isNew ? supabase.from('branches').insert(payload) : supabase.from('branches').update(payload).eq('id', row.id);
            const { error } = await q.select().single();
            if (error) throw error;
            loaded = pick(v);
            toast(tr('Филиал сохранён'), 'ok');
            if (typeof onDone === 'function') await onDone();
        } catch (e) {
            toast(tr((e && e.message) || 'Не удалось сохранить.'), 'fail');
        } finally { busy = false; saveBtn.disabled = false; }
    }

    const back = h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
        onclick: () => { if (busy) return; if (lockAll || !dirty() || askDiscard()) { if (typeof onBack === 'function') onBack(); } } },
        Icon('ChevronLeft', { size: 14 }), ' ', 'К списку филиалов');
    const title = isNew ? h('h1', { class: 'page-title' }, 'Новый филиал')
        : h('h1', { class: 'page-title' }, document.createTextNode(state.name || '—'));
    const actions = lockAll ? h('span', { class: 'muted' }, Icon('Lock', { size: 14 }), ' ', 'Только просмотр') : saveBtn;
    const notes = [];
    if (secondary) {
        notes.push(h('p', { class: 'cpf-note', role: 'note' }, Icon('Building', { size: 16 }), h('span', null, BRANCH_MESSAGES.mainOnly)));
    } else if (own) {
        notes.push(h('div', { class: 'cpf-note brf-own', role: 'note' }, Icon('Info', { size: 16 }),
            h('span', null, 'Адрес для партнёров, телефон и карта этого здания — из «Компании»: там их и меняйте.'),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => { if (typeof onNavigate === 'function') onNavigate('documents-settings'); } }, 'Изменить в «Компании»')));
    }
    clear(container);
    container.appendChild(h('div', { class: 'fade-in brf-page' },
        back,
        h('div', { class: 'page-head' },
            h('div', null, title, h('p', { class: 'page-subtitle' },
                'Название и адрес на трёх языках, карта, часы работы и показ на сайте. Эти данные получат сайт клиники, Symptex и партнёры.')),
            h('div', { class: 'page-head-actions' }, actions)),
        ...notes,
        h('div', { class: 'cpf-stack' }, ...cards)));
}
```

- [ ] **Step 4: CSS** в конец `admin-views.css` — блок `/* BRANCH_PROFILE_V1 — «Филиалы» … */` (задачи 13–15 дописывают в него):

```css
/* ===========================================================================
   BRANCH_PROFILE_V1 — «Филиалы» (views/branches-editor.js, branch-page.js,
   branch-hours-card.js). Префикс .brf-. Только токены приложения и шкала
   шрифтов; на ширине телефона — один столбец.
   ========================================================================= */
.brf-page .cpf-stack { max-width: 880px; }
.brf-own { flex-wrap: wrap; align-items: center; }
.brf-own > span { flex: 1 1 220px; min-width: 0; }
```

- [ ] **Step 5: словарь:**

| ru | uz | en |
|---|---|---|
| Название филиала | (есть) | |
| RU — так филиал называется во всей программе, в отчётах и при связи зданий. UZ и EN получают сайт и партнёры. | RU — filial butun dasturda, hisobotlarda va binolarni bog‘lashda shu nom bilan ataladi. UZ va EN ni sayt va hamkorlar oladi. | RU is the branch name across the program, in reports and when linking buildings. The website and partners receive UZ and EN. |
| Телефон для пациентов | Bemorlar uchun telefon | Phone for patients |
| К списку филиалов | Filiallar ro‘yxatiga | Back to branches |
| Новый филиал | Yangi filial | New branch |
| Название и адрес на трёх языках, карта, часы работы и показ на сайте. Эти данные получат сайт клиники, Symptex и партнёры. | Uch tildagi nom va manzil, xarita, ish vaqti va saytda ko‘rsatish. Bu ma’lumotlarni klinika sayti, Symptex va hamkorlar oladi. | Name and address in three languages, map, working hours and showing on the website. The clinic website, Symptex and partners receive this data. |
| Адрес для партнёров, телефон и карта этого здания — из «Компании»: там их и меняйте. | Bu binoning hamkorlar uchun manzili, telefoni va xaritasi — «Kompaniya»dan: ularni o‘sha yerda o‘zgartiring. | This building’s address for partners, phone and map come from “Company” — change them there. |
| Изменить в «Компании» | «Kompaniya»da o‘zgartirish | Change in “Company” |
| Филиал сохранён | Filial saqlandi | Branch saved |
| Филиал изменён, но не сохранён. Вернуться к списку? Изменения пропадут. | Filial o‘zgartirildi, lekin saqlanmadi. Ro‘yxatga qaytasizmi? O‘zgarishlar yo‘qoladi. | The branch has unsaved changes. Go back to the list? The changes will be lost. |

  «Название», «Телефон», «Работает», «Добавить», «Сохранить», «Только просмотр», «Нет изменений», «Проверьте выделенные поля.», «Не удалось сохранить.», «У пациентов это кнопка «Позвонить».» в словаре уже есть.
- [ ] **Step 6:** тесты зелёные. Сторожа: `db-query-schema.test.mjs` (новый `select`), `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 7: коммит** «Филиалы: страница здания — название на трёх языках, телефон для пациентов, «Работает»; своё здание главного — телефон из «Компании»; в филиале — только просмотр (BRANCH_PROFILE_V1)».

---

## Task 13: Страница здания — адрес для партнёров с ориентиром, карта и маршрут, «показывать на сайте» (BRANCH_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/branch-page.js`
- Test: `public/js/admin/__tests__/branches-screen.test.mjs`
- Modify: `public/css/admin-views.css`, `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающие тесты:**

```js
test('адрес для партнёров: коды, улица и ориентир на трёх языках; прежний адрес не трогается', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', address: 'Юнусабад-4' });
    assert.equal(selectedValue(geoSel(root, 'Страна')), 'UZ');
    assert.match(textOf(root), /Прежний адрес из списка: Юнусабад-4/);
    await choose(geoSel(root, 'Город / область'), 'tashkent-city');
    await choose(geoSel(root, 'Район'), 'yunusobod');
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Амира Темура, 12');
    type(triInput(root, 'Ориентир', 'ru'), 'Напротив парка');
    type(triInput(root, 'Ориентир', 'uz'), 'Bog‘ qarshisida');
    assert.equal(fullAddr(root, 'ru'), 'город Ташкент, Юнусабадский район, ул. Амира Темура, 12');
    await save(root);
    const v = writes[0].values;
    assert.deepEqual([v.country_code, v.region_code, v.district_code, v.street_ru, v.landmark_ru, v.landmark_uz],
        ['UZ', 'tashkent-city', 'yunusobod', 'ул. Амира Темура, 12', 'Напротив парка', 'Bog‘ qarshisida']);
    assert.ok(!('address' in v), 'прежний адрес экран не пишет (Р3)');
});

test('начатый адрес доводится до конца; ориентир — не адрес', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    type(triInput(root, 'Ориентир', 'ru'), 'Напротив парка');
    await save(root);
    assert.deepEqual(writes[0].values, { landmark_ru: 'Напротив парка' });
    writes.length = 0;
    type(triInput(root, 'Улица, дом', 'ru'), 'ул. Мира, 1');
    await save(root);
    assert.equal(writes.length, 0);
    assert.equal(fieldError(root, 'Город / область'), 'Выберите город или область.');
});

test('карта филиала: не Яндекс — объяснение; Яндекс — маршрут и запись', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    const maps = fieldInput(root, 'Ссылка на филиал в Яндекс Картах');
    type(maps, 'https://maps.google.com/x');
    await save(root);
    assert.equal(writes.length, 0);
    assert.match(fieldError(root, 'Ссылка на филиал в Яндекс Картах'), /Нужна ссылка из Яндекс Карт/);
    type(maps, 'https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29');
    assert.ok(textOf(routeDd(root)).includes('https://yandex.uz/maps/?rtext=~41.29,69.24&rtt=auto'));
    await save(root);
    assert.equal(writes[0].values.maps_url, 'https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29');
});

test('«Показывать филиал на сайте и у партнёров»: включено по умолчанию; снятая отметка — show_public 0; врачи — тоже', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    const pub = fieldInput(root, 'Показывать филиал на сайте и у партнёров');
    assert.equal(pub.checked, true);
    assert.match(textOf(root), /его врачей там тоже не покажут/);
    pub.checked = false; pub.dispatchEvent({ type: 'change', target: pub });
    await save(root);
    assert.deepEqual(writes[0].values, { show_public: 0 });
});

test('своё здание главного: адрес и карта — из «Компании», только видны; ориентир правится', async () => {
    const { root } = await openPage({ id: 1, name: 'Главный корпус' }, { own: true, company: { country_code: 'UZ',
        region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира, 1', street_uz: '', street_en: '',
        maps_url: 'https://yandex.uz/maps/-/CDm', phone: '+998712001200' } });
    assert.equal(selectedValue(geoSel(root, 'Район')), 'yunusobod');
    assert.ok(isOff(geoSel(root, 'Район')) && isOff(triInput(root, 'Улица, дом', 'ru')) && isOff(fieldInput(root, 'Ссылка на филиал в Яндекс Картах')));
    assert.equal(fullAddr(root, 'ru'), 'город Ташкент, Юнусабадский район, ул. Мира, 1');
    type(triInput(root, 'Ориентир', 'ru'), 'Напротив парка');
    await save(root);
    assert.deepEqual(writes[0].values, { landmark_ru: 'Напротив парка' });
});

test('филиал: адрес, ориентир, карта и показ на сайте — только видны', async () => {
    const { root } = await openPage({ id: 5, name: 'Главный корпус', country_code: 'UZ', region_code: 'tashkent-city', district_code: 'yunusobod' }, { secondary: true });
    for (const l of ['Страна', 'Город / область', 'Район']) assert.ok(isOff(geoSel(root, l)), l);
    assert.ok(isOff(triInput(root, 'Улица, дом', 'ru')) && isOff(triInput(root, 'Ориентир', 'uz')));
    assert.ok(isOff(fieldInput(root, 'Ссылка на филиал в Яндекс Картах')) && isOff(fieldInput(root, 'Показывать филиал на сайте и у партнёров')));
});

test('«нет перевода» — у пустых UZ / EN названия и улицы филиала; у ориентира — нет', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад', name_uz: 'Yunusobod' });
    const miss = (label, lang) => { const c = triInput(root, label, lang); const m = descendants(c._parent).find((n) => matches(n, '.cpf-miss')); return !!m && !m.hidden; };
    assert.deepEqual([miss('Название филиала', 'uz'), miss('Название филиала', 'en'), miss('Улица, дом', 'uz'), miss('Ориентир', 'uz')],
        [false, true, true, false]);
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
    assert.equal(miss('Название филиала', 'en'), false);
});
```

- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: правка** `branch-page.js`.
  - Импорты:
    - `import { tr, trf } from '../i18n.js';`
    - `import { addressCard, mapCard } from './company-address.js';   // BRANCH_PROFILE_V1 — те же карточки, что «Компания»`
    - `LANDMARK_MAX` — в импорт из `branch-profile.js`.
  - Сразу за `phoneBox`:

```js
    // ---- адрес для партнёров, ориентир, карта, показ на сайте (задача 13) ----
    const landmark = triGroup('Ориентир', { ru: state.landmark_ru, uz: state.landmark_uz, en: state.landmark_en }, {
        key: 'landmark', max: LANDMARK_MAX, disabled: lockAll,   // без «нет перевода»: ориентир необязателен (макет: noMiss)
        hint: 'Необязательно. Например: «напротив парка», «вход со двора».',
        onInput: (l, v) => { state['landmark_' + l] = v; },
    });
    // Р3 — прежний адрес, вписанный руками в старом списке, больше не правится:
    // виден, пока его не перенесут в списки и улицу.
    const legacy = !own && String(state.address || '').trim()
        ? h('p', { class: 'cpf-hint' }, document.createTextNode(trf('Прежний адрес из списка: {address}', { address: state.address })))
        : null;
    const address = addressCard(state, {
        title: 'Адрес для партнёров и сайта', disabled: lockCompany, after: [landmark.node, legacy].filter(Boolean),
        hint: 'Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. Ориентир помогает пациенту найти вход.',
    });
    Object.assign(errs, address.errs);
    availability = () => address.availability();
    const map = mapCard(state, { label: 'Ссылка на филиал в Яндекс Картах', disabled: lockCompany,
        hint: 'Найдите здание в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку. У каждого здания своя ссылка.' });
    errs.maps_url = map.err;
    const pubChk = h('input', { type: 'checkbox' });
    pubChk.checked = Number(state.show_public) !== 0;
    pubChk.disabled = lockAll;
    pubChk.addEventListener('change', () => { state.show_public = pubChk.checked ? 1 : 0; });
    const pubCard = card('Globe', 'Сайт и партнёры', checkField('Показывать филиал на сайте и у партнёров', pubChk),
        h('p', { class: 'cpf-hint' }, 'Скрытый филиал работает в программе как обычно, но не виден пациентам на сайте и у партнёров; его врачей там тоже не покажут.'));
```

  - В `cards` за карточкой телефона: `address.node, map.node, pubCard,`.
  - В самом конце `renderBranchPage` (после `container.appendChild`): `map.load(); await address.load();   // BRANCH_PROFILE_V1 — списки адреса грузятся уже с сохранёнными кодами`.
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Ориентир | Mo‘ljal | Landmark |
| Необязательно. Например: «напротив парка», «вход со двора». | Ixtiyoriy. Masalan: «bog‘ qarshisida», «kirish hovli tomondan». | Optional. For example: “opposite the park”, “entrance from the yard”. |
| Прежний адрес из списка: {address} | Ro‘yxatdagi avvalgi manzil: {address} | Previous address from the list: {address} |
| Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. Ориентир помогает пациенту найти вход. | Mamlakat, shahar va tuman — bemorni ro‘yxatga olishdagi kabi ro‘yxatlardan; hamkorlar ularning kodlarini oladi. Mo‘ljal bemorga kirishni topishga yordam beradi. | Country, city and district come from the lists, as in patient registration; partners receive their codes. The landmark helps the patient find the entrance. |
| Ссылка на филиал в Яндекс Картах | Yandex Xaritalardagi filial havolasi | Link to the branch in Yandex Maps |
| Найдите здание в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку. У каждого здания своя ссылка. | Binoni Yandex Xaritalarda toping, «Ulashish»ni bosing va havolani nusxalang. Har bir binoning o‘z havolasi bor. | Find the building in Yandex Maps, press “Share” and copy the link. Each building has its own link. |
| Сайт и партнёры | Sayt va hamkorlar | Website and partners |
| Показывать филиал на сайте и у партнёров | Filialni saytda va hamkorlarda ko‘rsatish | Show the branch on the website and to partners |
| Скрытый филиал работает в программе как обычно, но не виден пациентам на сайте и у партнёров; его врачей там тоже не покажут. | Yashirilgan filial dasturda odatdagidek ishlaydi, lekin saytda va hamkorlarda bemorlarga ko‘rinmaydi; uning shifokorlari ham u yerda ko‘rsatilmaydi. | A hidden branch works in the program as usual but is not shown to patients on the website or by partners; its doctors are not shown there either. |

- [ ] **Step 5:** тесты зелёные. Сторожа: `company-profile.test.mjs`, `geo-cascade.test.mjs`, `db-query-schema`, `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 6: коммит** «Филиалы: адрес для партнёров кодами справочника, улица и ориентир на трёх языках, карта и маршрут, «показывать на сайте» (скрытое здание прячет и врачей) (BRANCH_PROFILE_V1)».

---

## Task 14: Страница здания — часы работы и предупреждение «эти врачи потеряют часы приёма» (BRANCH_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/branch-hours-card.js`
- Modify: `public/js/admin/views/branch-page.js`
- Test: `public/js/admin/__tests__/branches-screen.test.mjs`
- Modify: `public/css/admin-views.css`, `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающие тесты** (импорт `writeBranchHours`, `blankDays` из `../../shared/branch-hours.js`):

```js
const { writeBranchHours, blankDays } = await import('../../shared/branch-hours.js');
const hoursMode = (root, label) => descendants(root).find((n) => matches(n, '.brf-mode') && labelText(n).startsWith(label));
const modeInput = (root, label) => descendants(hoursMode(root, label)).find((n) => n.tagName === 'INPUT');
async function pickMode(root, label) { const r = modeInput(root, label); r.checked = true; r.dispatchEvent({ type: 'change', target: r }); await settle(10); }
const dayRow = (root, day) => descendants(root).find((n) => matches(n, '.wkh-row') && labelText(n).startsWith(day));
const dayCtrls = (root, day) => descendants(dayRow(root, day)).filter((n) => n.tagName === 'INPUT');   // [отметка, с, до]
function setDay(root, day, { on, from, to }) {
    const [chk, f, t] = dayCtrls(root, day);
    if (on !== undefined) { chk.checked = on; chk.dispatchEvent({ type: 'change', target: chk }); }
    if (from !== undefined) { f.value = from; f.dispatchEvent({ type: 'change', target: f }); }
    if (to !== undefined) { t.value = to; t.dispatchEvent({ type: 'change', target: t }); }
}
const hoursCardNode = (root) => descendants(root).find((n) => matches(n, '.card') && descendants(n).some((c) => matches(c, '.brf-modes')));

test('«Не ограничивать» → «По дням недели»: Пн–Пт 09–18, суббота до 15; никого не задело — записано сразу', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    assert.equal(modeInput(root, 'Не ограничивать').checked, true);
    assert.equal(descendants(root).find((n) => matches(n, '.wkh-grid')).hidden, true, 'сетка спрятана');
    await pickMode(root, 'По дням недели');
    setDay(root, 'Сб', { on: true, to: '15:00' });
    await save(root);
    const days = blankDays(); days.sat = { on: true, from: '09:00', to: '15:00' };
    const want = writeBranchHours({ mode: 'week', days });
    assert.deepEqual(impactCalls, [{ branch_id: 5, working_hours: want.working_hours, is_24_7: 0 }]);
    assert.deepEqual(writes[0].values, { working_hours: want.working_hours });
});

test('кто-то теряет время — сначала предупреждение со списком; «Вернуться к часам» — ничего не записано; «Сохранить всё равно» — записано', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    impactReply = { data: { doctors: [{ id: 8, name: 'Каримов Р.', lost: [{ day: 'sat', from: '09:00', to: '18:00' }, { day: 'sun', from: '09:00', to: '18:00' }] }] } };
    await pickMode(root, 'По дням недели');
    await save(root);
    assert.equal(writes.length, 0);
    const panel = descendants(root).find((n) => matches(n, '.brf-impact'));
    assert.ok(panel, 'нет предупреждения');
    assert.equal(panel.attrs.role, 'alertdialog');
    assert.match(labelText(panel), /Эти врачи потеряют часы приёма/);
    assert.match(labelText(panel), /Каримов Р\. — Сб 09:00–18:00, Вс 09:00–18:00/);
    assert.match(labelText(panel), /Уже записанные пациенты не отменяются/);
    buttonByText(root, /Вернуться к часам/).click(); await settle(30);
    assert.equal(writes.length, 0);
    assert.equal(descendants(root).find((n) => matches(n, '.brf-impact')), undefined);
    await save(root);
    buttonByText(root, /Сохранить всё равно/).click(); await settle(60);
    assert.equal(writes.length, 1);
    assert.equal(impactCalls.length, 2);
});

test('«Круглосуточно» и «Не ограничивать» никому время не закрывают — без проверки', async () => {
    const wk = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;
    let { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: wk });
    assert.equal(modeInput(root, 'По дням недели').checked, true);
    await pickMode(root, 'Круглосуточно'); await save(root);
    assert.equal(impactCalls.length, 0);
    assert.deepEqual(writes[0].values, { working_hours: '{}', is_24_7: 1 });
    ({ root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: wk }));
    await pickMode(root, 'Не ограничивать'); await save(root);
    assert.equal(impactCalls.length, 0);
    assert.deepEqual(writes[0].values, { working_hours: '{}' });
});

test('ни одного рабочего дня или конец раньше начала — объяснение, без проверки и записи', async () => {
    const { root } = await openPage({ id: 5, name: 'Юнусабад' });
    await pickMode(root, 'По дням недели');
    for (const d of ['Пн', 'Вт', 'Ср', 'Чт', 'Пт']) setDay(root, d, { on: false });
    await save(root);
    assert.equal(impactCalls.length + writes.length, 0);
    assert.match(labelText(hoursCardNode(root)), /Отметьте хотя бы один рабочий день/);
    setDay(root, 'Пн', { on: true, from: '18:00', to: '09:00' });
    await save(root);
    assert.equal(impactCalls.length + writes.length, 0);
    assert.match(labelText(hoursCardNode(root)), /Пн: время окончания должно быть позже начала\./);
});

test('часы не трогали — проверки нет; проверка не удалась — записи нет, объяснение', async () => {
    const wk = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;
    let { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: wk });
    type(triInput(root, 'Название филиала', 'en'), 'Yunusabad');
    await save(root);
    assert.equal(impactCalls.length, 0);
    ({ root } = await openPage({ id: 5, name: 'Юнусабад' }));
    impactReply = { status: 500, error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } };
    await pickMode(root, 'По дням недели');
    await save(root);
    assert.equal(writes.length, 0);
    assert.match(toastText(), /Не удалось проверить, у кого из врачей закроется время/);
});

test('новый филиал с часами — без проверки (врачей у него ещё нет), часы уходят со вставкой', async () => {
    const { root } = await openPage(null);
    type(triInput(root, 'Название филиала', 'ru'), 'Сергели');
    await pickMode(root, 'По дням недели');
    buttonByText(root, /^Добавить$/).click(); await settle(60);
    assert.equal(impactCalls.length, 0);
    assert.equal(writes[0].values.working_hours, writeBranchHours({ mode: 'week', days: blankDays() }).working_hours);
});

test('филиал: часы только видны — переключатели и сетка выключены', async () => {
    const wk = writeBranchHours({ mode: 'week', days: blankDays() }).working_hours;
    const { root } = await openPage({ id: 5, name: 'Юнусабад', working_hours: wk }, { secondary: true });
    for (const l of ['Не ограничивать', 'По дням недели', 'Круглосуточно']) assert.ok(isOff(modeInput(root, l)), l);
    assert.ok(dayCtrls(root, 'Пн').every(isOff));
});
```

- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: вид** `views/branch-hours-card.js`:

```js
// BRANCH_PROFILE_V1 — «Часы работы» здания: три способа и сетка дней;
// предупреждение «эти врачи потеряют часы приёма» до сохранения (спецификация,
// «Часы работы филиала»). Что считать — сервер (RPC branch_hours_impact), здесь
// только показ и выбор человека.
import { h, Icon, clear } from '../ui.js';
import { tr } from '../i18n.js';
import { weekHoursGrid, WEEK_DAYS } from './week-hours.js';
import { fieldErr } from './company-fields.js';

export const DAY_LABEL = Object.freeze(Object.fromEntries(WEEK_DAYS));
const MODES = [
    ['none', 'Не ограничивать', 'Врачи этого здания принимают по своему графику из «Сотрудников». Так сейчас у всех зданий.'],
    ['week', 'По дням недели', 'Вне этих часов врачам этого здания запись не предлагается. Часы ограничивают врачей, у которых в «Сотрудниках» выбрано это здание.'],
    ['allday', 'Круглосуточно', 'Например, стационар или дежурная лаборатория.'],
];
let seq = 0;

/** Потерянное время врача одной строкой: «Пн 18:00–20:00, Сб 09:00–15:00». */
export function lostText(lost) {
    return (lost || []).map((l) => tr(DAY_LABEL[l.day] || l.day) + ' ' + l.from + '–' + l.to).join(', ');
}

/**
 * hours — { mode, days } экрана (меняется на месте). askImpact(doctors) →
 * Promise<boolean>: «Сохранить всё равно» — true; «Вернуться к часам» или
 * любая правка часов, пока вопрос открыт, — false.
 */
export function hoursCard(hours, { disabled = false, onChange = null } = {}) {
    const name = 'brf-hours-' + (++seq);
    const err = fieldErr(null);
    const impactSlot = h('div');
    let pending = null;
    function clearImpact() {
        clear(impactSlot);
        if (pending) { const p = pending; pending = null; p(false); }
    }
    const changed = () => { err.set(''); clearImpact(); if (typeof onChange === 'function') onChange(); };
    const grid = weekHoursGrid(hours.days, {
        disabled: disabled || hours.mode !== 'week',
        onChange: (key, entry) => { hours.days[key] = entry; changed(); },
    });
    const radios = {};
    const modes = h('div', { class: 'brf-modes', role: 'radiogroup', 'aria-label': 'Часы работы' },
        ...MODES.map(([mode, label, hint]) => {
            const r = h('input', { type: 'radio', name, value: mode });
            r.disabled = disabled;
            r.addEventListener('change', () => { if (!r.checked) return; hours.mode = mode; paint(); changed(); });
            radios[mode] = r;
            return h('label', { class: 'brf-mode' }, r, h('b', null, label), h('span', null, hint));
        }));
    function paint() {
        for (const [m, r] of Object.entries(radios)) r.checked = hours.mode === m;
        grid.node.hidden = hours.mode !== 'week';
        grid.setDisabled(disabled || hours.mode !== 'week');
    }
    function askImpact(doctors) {
        clearImpact();
        return new Promise((resolve) => {
            pending = resolve;
            const done = (v) => { pending = null; clear(impactSlot); resolve(v); };
            const headId = name + '-impact';
            impactSlot.appendChild(h('div', { class: 'brf-impact', role: 'alertdialog', 'aria-labelledby': headId },
                h('p', { class: 'brf-impact-head', id: headId }, Icon('Warning', { size: 16 }), ' ', 'Эти врачи потеряют часы приёма'),
                h('ul', null, ...doctors.map((d) => h('li', null,
                    h('b', null, document.createTextNode(d.name || '—')), document.createTextNode(' — ' + lostText(d.lost))))),
                h('p', { class: 'cpf-hint' }, 'Уже записанные пациенты не отменяются; новых записей на это время программа не предложит. Считается по врачам, приписанным к этому зданию в «Сотрудниках».'),
                h('div', { class: 'cpf-row' },
                    h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => done(true) }, 'Сохранить всё равно'),
                    h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => done(false) }, 'Вернуться к часам'))));
        });
    }
    paint();
    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Clock', { size: 16 }), ' ', 'Часы работы')),
        h('div', { class: 'cpf-body' }, modes, grid.node, err.node, impactSlot));
    return { node, err, askImpact, clearImpact, paint };
}
```

- [ ] **Step 4: `branch-page.js`.**
  - Импорты:
    - `import { hoursCard, DAY_LABEL } from './branch-hours-card.js';   // BRANCH_PROFILE_V1`;
    - `import { readBranchHours, writeBranchHours, hoursProblem } from '../../shared/branch-hours.js';`.
  - За `pubCard`:

```js
    // ---- часы работы (задача 14) ----
    const hours = readBranchHours(state.working_hours, state.is_24_7);
    const hoursUi = hoursCard(hours, { disabled: lockAll });
    errs.hours = hoursUi.err;
```

  - В `cards` — `hoursUi.node` перед `pubCard`.
  - В `collect()` — первой строкой: `Object.assign(state, writeBranchHours(hours));   // BRANCH_PROFILE_V1 — сетка → колонки`.
  - В `problemsFor()` — перед `return out`:

```js
        // BRANCH_PROFILE_V1 — часы проверяются, если их меняли.
        if (keys.includes('working_hours') || keys.includes('is_24_7')) {
            const hp = hoursProblem(hours);
            if (hp) out.hours = [hp.template, hp.day ? { day: tr(DAY_LABEL[hp.day]) } : undefined];
        }
```

  - В `save()` — первой строкой внутри `try`:

```js
            // BRANCH_PROFILE_V1 — «каким врачам какое время закроется» — до записи
            // (спецификация). Только новые часы «По дням недели» могут закрыть
            // время; у нового здания врачей ещё нет.
            if (!isNew && hours.mode === 'week' && (keys.includes('working_hours') || keys.includes('is_24_7'))) {
                if (!(await confirmHours(v))) return;
            }
```

  - Функция — рядом с `save()`:

```js
    async function confirmHours(v) {
        const { data, error } = await supabase.rpc('branch_hours_impact', { branch_id: row.id, working_hours: v.working_hours, is_24_7: v.is_24_7 });
        if (error) {
            toast(trf('Не удалось проверить, у кого из врачей закроется время: {msg}', { msg: tr(error.message || '') }), 'fail');
            return false;
        }
        const doctors = data && Array.isArray(data.doctors) ? data.doctors : [];
        return doctors.length ? hoursUi.askImpact(doctors) : true;
    }
```

- [ ] **Step 5: CSS** (в блок BRANCH_PROFILE_V1):

```css
.brf-modes { display: grid; gap: 8px; }
.brf-mode { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; padding: 10px 12px; border: 1px solid var(--ink-100); border-radius: 10px; background: var(--white); cursor: pointer; }
.brf-mode:has(input:checked) { border-color: var(--primary-200); background: var(--primary-50); }
.brf-mode input { grid-row: span 2; margin: 2px 0 0; accent-color: var(--primary-600); }
.brf-mode b { font-size: 13.5px; font-weight: 600; color: var(--ink-900); }
.brf-mode span { font-size: 12.5px; color: var(--ink-500); line-height: 1.4; }
.brf-impact { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--warn-500); border-radius: 10px; background: var(--warn-50); min-width: 0; }
.brf-impact-head { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13.5px; font-weight: 600; color: var(--warn-700); }
.brf-impact ul { display: grid; gap: 4px; margin: 0; padding-left: 18px; font-size: 13.5px; color: var(--ink-900); overflow-wrap: anywhere; }
```

- [ ] **Step 6: словарь** («Часы работы», «По дням недели», «Круглосуточно», «Сохранить всё равно», «Пн» … «Вс» — есть):

| ru | uz | en |
|---|---|---|
| Не ограничивать | Cheklamaslik | No limit |
| Врачи этого здания принимают по своему графику из «Сотрудников». Так сейчас у всех зданий. | Bu bino shifokorlari «Xodimlar»dagi o‘z jadvali bo‘yicha qabul qiladi. Hozir barcha binolarda shunday. | This building’s doctors see patients on their own schedules from “Staff”. This is how all buildings work now. |
| Вне этих часов врачам этого здания запись не предлагается. Часы ограничивают врачей, у которых в «Сотрудниках» выбрано это здание. | Bu soatlardan tashqari bu bino shifokorlariga qabul taklif qilinmaydi. Soatlar «Xodimlar»da shu bino tanlangan shifokorlarni cheklaydi. | Outside these hours no appointment times are offered for this building’s doctors. The hours limit the doctors who have this building selected in “Staff”. |
| Например, стационар или дежурная лаборатория. | Masalan, statsionar yoki navbatchi laboratoriya. | For example, an inpatient ward or an on-call laboratory. |
| Эти врачи потеряют часы приёма | Bu shifokorlar qabul soatlarini yo‘qotadi | These doctors will lose appointment hours |
| Уже записанные пациенты не отменяются; новых записей на это время программа не предложит. Считается по врачам, приписанным к этому зданию в «Сотрудниках». | Allaqachon yozilgan bemorlar bekor qilinmaydi; bu vaqtga yangi yozuvlarni dastur taklif qilmaydi. «Xodimlar»da shu binoga biriktirilgan shifokorlar bo‘yicha hisoblanadi. | Patients already booked are not cancelled; the program will not offer new bookings at these times. Counted for the doctors assigned to this building in “Staff”. |
| Вернуться к часам | Soatlarga qaytish | Back to the hours |
| Не удалось проверить, у кого из врачей закроется время: {msg} | Qaysi shifokorlarning vaqti yopilishini tekshirib bo‘lmadi: {msg} | Could not check which doctors would lose time: {msg} |

- [ ] **Step 7:** тесты зелёные. Сторожа:
  - сервер: `server/services/rpc/client-rpc-coverage.test.js` (`branch_hours_impact` в RPC);
  - клиент: `week-hours.test.mjs`, `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 8: коммит** «Филиалы: часы работы — «не ограничивать», по дням недели, круглосуточно; перед сохранением — каким врачам какое время закроется (BRANCH_PROFILE_V1)».

---

## Task 15: Список «Филиалов» и подключение — плитка открывает новый экран; прежний облачный адрес ведёт в хаб (BRANCH_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/branches-editor.js`
- Modify:
  - `public/js/admin/views/settings-hub.js` (импорт рядом с :47; `repaint()` :61-66; плитка :302; `LOOKUP_CONFIG.branches` :667-675 — удалить; слот карточки связи в `renderEditor` :1149-1152, :1166, :1187-1191 — удалить);
  - `public/js/admin.js` (`LEGACY_ROUTES` :400-431);
  - `public/js/admin/__tests__/settings-hub-groups.test.mjs` (:216 — комментарий);
  - `public/css/admin-views.css`, `public/js/admin/i18n-strings.js`.
- Test: `public/js/admin/__tests__/branches-screen.test.mjs`

- [ ] **Step 1: падающие тесты:**

```js
// ===========================================================================
// Задача 15 — список «Филиалов».
// ===========================================================================
import fs from 'node:fs';   // (в шапку файла, к остальным импортам)
const { renderBranchesEditor } = await import('../views/branches-editor.js');
const { setLang } = await import('../i18n.js');
async function openList(rows, { role = 'main', own = null, readOnly = false, company = null } = {}) {
    branchRows = rows.map((r, i) => ({ ...BLANK_ROW, id: i + 1, ...r }));
    companyRow = company; writes = []; impactCalls = []; impactReply = { data: { doctors: [] } };
    globalThis.window.CLINIC.building_role = role;
    if (own == null) delete globalThis.window.CLINIC.own_branch_id; else globalThis.window.CLINIC.own_branch_id = own;
    const nav = []; let backs = 0;
    const root = mkEl('div');
    await renderBranchesEditor(root, { onBack: () => { backs++; }, onNavigate: (r) => nav.push(r), readOnly });
    await settle(80);
    return { root, nav, backs: () => backs };
}
const items = (root) => descendants(root).filter((n) => matches(n, '.brf-item'));
const SAT_15 = (() => { const d = blankDays(); d.sat = { on: true, from: '09:00', to: '15:00' }; return writeBranchHours({ mode: 'week', days: d }).working_hours; })();

test('список: название на языке интерфейса, часы, карта, показ на сайте, «Работает»', async () => {
    const rows = [
        { name: 'Юнусабад', name_uz: 'Yunusobod filiali', street_ru: 'ул. Мира, 1', landmark_ru: 'у парка', working_hours: SAT_15, maps_url: 'https://yandex.uz/maps/-/CDx' },
        { name: 'Стационар', is_24_7: 1, show_public: 0, active: 0, address: 'Старый адрес' },
    ];
    let { root } = await openList(rows);
    const [a, b] = items(root).map(labelText);
    assert.match(a, /Юнусабад/);
    assert.match(a, /ул\. Мира, 1, у парка/);
    assert.match(a, /Пн–Пт 09:00–18:00, Сб 09:00–15:00/);
    assert.match(a, /Есть карта/);
    assert.match(a, /На сайте/);
    assert.match(b, /Круглосуточно/);
    assert.match(b, /Скрыт с сайта/);
    assert.match(b, /Отключён/);
    assert.match(b, /Нет карты/);
    assert.match(b, /Старый адрес/, 'пока улицы нет — прежний адрес');
    assert.ok(buttonByText(root, /Добавить филиал/));
    setLang('uz');
    try { ({ root } = await openList(rows)); assert.match(labelText(items(root)[0]), /Yunusobod filiali/); }
    finally { setLang('ru'); }
});

test('своё здание главного — «Это здание», адрес и телефон из «Компании»; страница открывается своим', async () => {
    const { root, nav } = await openList([{ name: 'Главный корпус', phone: 'старый' }, { name: 'Чиланзар' }],
        { own: 1, company: { id: 1, phone: '+998 71 200 12 00', street_ru: 'ул. Мира, 1', country_code: 'UZ', region_code: '', district_code: '', street_uz: '', street_en: '', maps_url: '' } });
    const t = labelText(items(root)[0]);
    assert.match(t, /Это здание/);
    assert.match(t, /\+998 71 200 12 00/);
    assert.match(t, /ул\. Мира, 1/);
    items(root)[0].click(); await settle(80);
    assert.ok(buttonByText(root, /Изменить в «Компании»/), 'страница своего здания');
    buttonByText(root, /Изменить в «Компании»/).click();
    assert.deepEqual(nav, ['documents-settings']);
});

test('строка → страница → «К списку филиалов»; после сохранения — снова список с новым значением', async () => {
    const { root } = await openList([{ name: 'Юнусабад' }]);
    items(root)[0].click(); await settle(80);
    assert.ok(buttonByText(root, /К списку филиалов/));
    type(triInput(root, 'Название филиала', 'uz'), 'Yunusobod');
    await save(root);
    await settle(80);
    assert.equal(items(root).length, 1, 'вернулись к списку');
    assert.equal(branchRows[0].name_uz, 'Yunusobod');
});

test('филиал: «Добавить филиал» нет, вверху объяснение; «Просмотр»: «Только просмотр»', async () => {
    let { root } = await openList([{ name: 'Главный корпус' }], { role: 'secondary', own: 1 });
    assert.equal(buttonByText(root, /Добавить филиал/), null);
    assert.ok(textOf(root).includes(BRANCH_MESSAGES.mainOnly));
    ({ root } = await openList([{ name: 'Главный корпус' }], { readOnly: true }));
    assert.equal(buttonByText(root, /Добавить филиал/), null);
    assert.match(textOf(root), /Только просмотр/);
});

test('прежний облачный адрес #settings:branches ведёт в хаб настроек; общего редактора у «Филиалов» больше нет', () => {
    const shell = fs.readFileSync(new URL('../../admin.js', import.meta.url), 'utf8');
    const legacy = shell.slice(shell.indexOf('const LEGACY_ROUTES = {'), shell.indexOf('function navigate('));
    assert.match(legacy, /'settings:branches':\s*\{\s*view:\s*'settings'\s*\}/);
    const hub = fs.readFileSync(new URL('../views/settings-hub.js', import.meta.url), 'utf8');
    assert.match(hub, /state\.section === 'branches'\) await renderBranchesEditor\(/);
    const lookup = hub.slice(hub.indexOf('const LOOKUP_CONFIG = {'));
    assert.doesNotMatch(lookup.slice(0, lookup.indexOf('\n};')), /\n    branches: \{/);
});
```

- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: вид** `views/branches-editor.js`:

```js
// BRANCH_PROFILE_V1 — «ФИЛИАЛЫ»: здания клиники списком и страница здания
// (branch-page.js). Заменяет общий редактор справочника (settings-hub.js
// LOOKUP_CONFIG.branches: название, телефон, адрес) и облачную форму
// #settings:branches (admin.js LEGACY_ROUTES уводит её в хаб).
//
// Своё здание (window.CLINIC.own_branch_id) помечено «Это здание»; в главном
// его адрес для партнёров, карта и телефон — из «Компании» (overlayOwnBuilding).
// Название — на языке интерфейса (name_uz / name_en, иначе RU); вся остальная
// программа показывает прежнее name (решение плана Р4).
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag } from '../ui.js';
import { tr, getLang } from '../i18n.js';
import { hasRestriction, actorIsAdmin } from '../permissions.js';
import { renderBranchPage } from './branch-page.js';
import { DAY_LABEL } from './branch-hours-card.js';
import { placeName } from '../../shared/clinic-profile.js';
import { BRANCH_MESSAGES, overlayOwnBuilding } from '../../shared/branch-profile.js';
import { readBranchHours, hoursGroups } from '../../shared/branch-hours.js';

const clinic = () => (typeof window !== 'undefined' && window.CLINIC) || {};

/** «Пн–Пт 09:00–18:00, Сб 09:00–15:00» / «Круглосуточно» / «Без ограничений». */
export function hoursText(row) {
    const hrs = readBranchHours(row.working_hours, row.is_24_7);
    if (hrs.mode === 'allday') return tr('Круглосуточно');
    if (hrs.mode === 'none') return tr('Без ограничений');
    return hoursGroups(hrs).map((g) => tr(DAY_LABEL[g.from]) + (g.to !== g.from ? '–' + tr(DAY_LABEL[g.to]) : '') + ' ' + g.hours).join(', ');
}

const line = (icon, text) => h('span', { class: 'brf-line' }, Icon(icon, { size: 14 }), h('span', null, document.createTextNode(text)));
function chips(row) {
    const done = { ru: row.name && row.street_ru, uz: row.name_uz && row.street_uz, en: row.name_en && row.street_en };
    return h('span', { class: 'brf-chips' }, ...['ru', 'uz', 'en'].map((l) => {
        const on = !!String(done[l] || '').trim();
        return h('span', { class: 'brf-chip' + (on ? ' on' : ''), title: on ? 'Есть перевод' : 'Нет перевода' }, document.createTextNode(l.toUpperCase()));
    }));
}
function itemEl(row, { own, onOpen }) {
    const off = Number(row.active) === 0;
    const shown = Number(row.show_public ?? 1) !== 0;
    const addr = [row.street_ru, row.landmark_ru].filter((s) => String(s || '').trim()).join(', ') || row.address || '—';
    return h('button', { type: 'button', class: 'brf-item' + (off ? ' brf-off' : ''), onclick: onOpen },
        h('span', { class: 'brf-head' },
            h('b', null, document.createTextNode(placeName(row, getLang()) || '—')),
            own ? Tag('Это здание') : null,
            Tag(off ? 'Отключён' : 'Работает', { kind: off ? '' : 'ok' }),
            Tag(shown ? 'На сайте' : 'Скрыт с сайта', { kind: shown ? 'ok' : '' })),
        line('MapPin', addr),
        line('Phone', row.phone || '—'),
        line('Clock', hoursText(row)),
        h('span', { class: 'brf-line' }, Icon('Flag', { size: 14 }), h('span', null, row.maps_url ? 'Есть карта' : 'Нет карты')),
        chips(row));
}

export async function renderBranchesEditor(container, { onBack = null, onNavigate = null, readOnly = false, renderSyncCard = null } = {}) {
    const secondary = clinic().building_role === 'secondary';
    const ownId = clinic().own_branch_id;
    let company = null;
    async function showList() {
        clear(container);
        const listBox = h('div', { class: 'brf-list' });
        const addBtn = readOnly
            ? h('span', { class: 'muted' }, Icon('Lock', { size: 14 }), ' ', 'Только просмотр')
            : secondary ? null
            : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => showPage(null, false) }, Icon('Plus', { size: 14 }), ' ', 'Добавить филиал');
        // ROLE_REPORTS_SETTINGS_V1 (ревью C1) — связь зданий зовёт админские RPC: только полному доступу.
        const syncSlot = typeof renderSyncCard === 'function' && (!hasRestriction() || actorIsAdmin()) ? h('div') : null;
        container.appendChild(h('div', { class: 'fade-in' },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', style: { marginBottom: '14px' },
                onclick: () => { if (typeof onBack === 'function') onBack(); } }, Icon('ChevronLeft', { size: 14 }), ' ', 'К плиткам настроек'),
            h('div', { class: 'page-head' },
                h('div', null, h('h1', { class: 'page-title' }, 'Филиалы'),
                    h('p', { class: 'page-subtitle' }, 'Здания клиники. Название, адрес, карта и часы работы на трёх языках получат сайт клиники, Symptex и партнёры.')),
                addBtn ? h('div', { class: 'page-head-actions' }, addBtn) : null),
            secondary ? h('p', { class: 'cpf-note', role: 'note' }, Icon('Building', { size: 16 }), h('span', null, BRANCH_MESSAGES.mainOnly)) : null,
            syncSlot,
            listBox));
        if (syncSlot) renderSyncCard(syncSlot).catch((e) => console.warn('[branch-sync] card failed:', e && e.message));
        let rows = [];
        try {
            const { data, error } = await supabase.from('branches').select('*').order('name').limit(500);
            if (error) throw error;
            rows = Array.isArray(data) ? data : [];
        } catch (e) { toast(tr('Не удалось загрузить филиалы.') + ' ' + tr((e && e.message) || ''), 'fail'); }
        company = null;
        if (!secondary && ownId != null) {
            try {
                const { data } = await supabase.from('doc_settings').select('*').eq('id', 1).maybeSingle();
                company = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
            } catch (_) { company = null; }
        }
        if (!rows.length) listBox.appendChild(h('p', { class: 'muted' }, 'Филиалов пока нет.'));
        for (const r of rows) {
            const own = ownId != null && Number(r.id) === Number(ownId);
            const shown = own && !secondary ? overlayOwnBuilding(r, company) : r;
            listBox.appendChild(itemEl(shown, { own, onOpen: () => showPage(r, own) }));
        }
    }
    async function showPage(row, own) {
        await renderBranchPage(container, { row, own: !!own && !secondary, company, readOnly, secondary,
            onBack: showList, onDone: showList, onNavigate });
    }
    await showList();
}
```

- [ ] **Step 4: подключение.**
  - `settings-hub.js`:
    - импорт — `import { renderBranchesEditor } from './branches-editor.js';   // BRANCH_PROFILE_V1`;
    - в `repaint()` — за веткой `roles`:

```js
    else if (state.section === 'branches') await renderBranchesEditor(refs.container, { onBack: backToHub, onNavigate: refs.onNavigate, readOnly: state.readOnly, renderSyncCard: renderBranchSyncCard });   // BRANCH_PROFILE_V1
```

    - удалить `LOOKUP_CONFIG.branches` (:667-675) вместе с заголовком-комментарием «Управление филиалами»;
    - в `renderEditor` удалить слот карточки связи (:1149-1152, `syncSlot,` :1166, блок :1187-1191) — он был только для `branches`;
    - плитка :302 — `desc: 'Адреса, карты и часы работы зданий'`.
  - `admin.js` `LEGACY_ROUTES`, рядом с прочими `settings:*`:

```js
    // BRANCH_PROFILE_V1 — облачная форма филиала (sections.js) писала бы name_uz /
    // name_en и часы мимо предупреждения о врачах; здания — в «Филиалах» хаба.
    'settings:branches': { view: 'settings' },
```

  - `settings-hub-groups.test.mjs:216`, комментарий: «Филиалы — не переход, а экран «Филиалы» внутри хаба (branches-editor.js, BRANCH_PROFILE_V1)». Проверки теста не трогать.
- [ ] **Step 5: CSS** (в блок BRANCH_PROFILE_V1):

```css
.brf-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; min-width: 0; }
.brf-item { display: grid; gap: 6px; align-content: start; width: 100%; min-width: 0; padding: 14px 16px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--white); color: var(--ink-900); font: inherit; text-align: left; cursor: pointer; }
.brf-item:hover { border-color: var(--primary-200); }
.brf-item:focus-visible { outline: 2px solid var(--primary-500); outline-offset: 2px; }
.brf-off { opacity: .65; }
.brf-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.brf-head b { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.brf-line { display: flex; align-items: flex-start; gap: 6px; min-width: 0; font-size: 13.5px; color: var(--ink-600); overflow-wrap: anywhere; }
.brf-line > svg { flex: none; margin-top: 2px; }
.brf-chips { display: flex; gap: 4px; }
.brf-chip { padding: 0 6px; border: 1px solid var(--ink-100); border-radius: 4px; font-size: 12.5px; font-weight: 700; color: var(--ink-400); }
.brf-chip.on { border-color: var(--ok-500); background: var(--ok-50); color: var(--ok-700); }
```

- [ ] **Step 6: словарь:**

| ru | uz | en |
|---|---|---|
| Здания клиники. Название, адрес, карта и часы работы на трёх языках получат сайт клиники, Symptex и партнёры. | Klinika binolari. Uch tildagi nom, manzil, xarita va ish vaqtini klinika sayti, Symptex va hamkorlar oladi. | The clinic’s buildings. The clinic website, Symptex and partners receive the name, address, map and working hours in three languages. |
| Это здание | Shu bino | This building |
| Отключён | O‘chirilgan | Off |
| На сайте | Saytda | On the website |
| Скрыт с сайта | Saytdan yashirilgan | Hidden from the website |
| Без ограничений | Cheklovsiz | No limit |
| Есть карта | Xarita bor | Map added |
| Нет карты | Xarita yo‘q | No map |
| Есть перевод | Tarjima bor | Translated |
| Нет перевода | Tarjima yo‘q | Not translated |
| Не удалось загрузить филиалы. | Filiallarni yuklab bo‘lmadi. | Could not load the branches. |
| Филиалов пока нет. | Hozircha filiallar yo‘q. | No branches yet. |
| Адреса, карты и часы работы зданий | Binolarning manzillari, xaritalari va ish vaqti | Building addresses, maps and working hours |

- [ ] **Step 7:** тесты зелёные. Сторожа:
  - `__tests__/settings-hub-groups.test.mjs` («Филиалы» открываются внутри хаба, читается `branches`, «Main Branch», «К плиткам настроек»);
  - `__tests__/role-reports-settings.test.mjs`, `route-gate.test.mjs`, `app-shell.test.mjs`, `branch-sync-view.test.mjs`, `branch-sync-logic.test.mjs`;
  - `__tests__/reports-hub-audit.test.mjs`, `inpatient-section.test.mjs`, `lab-panels-mode.test.mjs` (`LEGACY_ROUTES`);
  - `i18n-coverage`, `i18n-uz-quality`, `type-scale`, `db-query-schema`;
  - `scripts/build-bundle.test.js`.
- [ ] **Step 8: коммит** «Филиалы: список зданий карточками — название на языке интерфейса, адрес, телефон, часы, карта, показ на сайте; «Это здание»; прежняя облачная форма ведёт в хаб (BRANCH_PROFILE_V1)».

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды, после всех задач и когда другие сборщики клона не пишут.**
- Как в выпуске: `node --experimental-vm-modules --test` (= `npm test`), из корня клона.
- Как CI на en-US: `node --experimental-vm-modules --import C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs --test`.
  - Файла нет — восстановить: `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });` (память `easymed-ci-locale-trap`).
- Красное в чужой области — сначала проверить, не чужая ли это недописанная правка полировки.

**2. Проверка «сломать».** Отдельный агент, только чтение; находки — в отчёт. Что пробовать:
- (a) **Филиал:**
  - сменить название, телефон, профиль, часы, показ любого здания через `/api/db` — частичными и полными телами, булевыми и 0/1, отбором не по одному id, вставкой;
  - RPC `branch_hours_impact` в филиале;
  - убедиться, что «работает» и прежний адрес сохраняются, а синхронизация не затирает своё для документов в «Компании».
- (b) **Одно место на адрес:**
  - главное здание — правка `street_ru` / `phone` / `maps_url` своей строки `branches` через `/api/db` (должен быть 409);
  - «Компания» филиала — правка кодов, улицы, карты (409);
  - список, страница и выгрузка в филиалы показывают одно и то же для главного здания;
  - ни один экран не рисует второй адрес здания.
- (c) **Синхронизация:**
  - старая главная (выгрузка без профиля и отметки) → свои часы и профиль филиала не тронуты;
  - новая главная → свои часы приняты;
  - мусор (null, числа, Google-ссылка, `show_public` 2, длинные строки) не роняет приём и прайс;
  - незнакомая буква заводится с профилем; холостой прогон считает то же;
  - база до 241 с обеих сторон;
  - филиал не отдаёт профиль.
- (d) **Часы ↔ движок:**
  - каждое состояние сетки → `clinicWindow` то же, что в базе;
  - старые формы показываются верно;
  - «enabled» через `/api/db` отклоняется; ни одного рабочего дня отклоняется экраном и сервером;
  - `24:00` / `23:59`.
- (e) **Предупреждение:**
  - набор врачей — уволенные, не врачи, другое здание, врач только в `user_branches`, врач без графика (воскресенье), обед;
  - переходы: 24/7 → по дням, по дням → не ограничивать (без вызова), отказ RPC;
  - правка часов при открытом вопросе — сохранение не повисает;
  - текст честен: `calendar_book` по-прежнему записывает в закрытое время.
- (f) **Показ:** выбор здания, календарь, касса, отчёты и печать показывают прежнее `name`; печать не изменилась ни на одном бланке.
- (g) **Языки:** экран на uz / en без кириллицы, кроме данных клиники; дни недели в списке и предупреждении; «нет перевода» у UZ / EN названия и улицы, не у ориентира.
- (h) **Ширина телефона, 360 px:** нет горизонтальной прокрутки; список, страница и сетка дней — в один столбец.
- (i) **Права:** «Филиалы: Изменение» не у администратора сохраняет профиль и часы и получает предупреждение; «Просмотр» — только читает; кассир — 403.
- (j) **Прежний адрес:** `#settings:branches` ведёт в хаб.

**3. Проба на тестовой клинике** (:8712, рецепт — память `easymed-dev-prod-workflow`; без тега):
1. Открыть «Настройки → Филиалы»: своё здание — «Это здание», адрес и телефон — из «Компании».
2. Завести второе здание:
   - три языка, город и район, улица, ориентир, карта;
   - часы Пн–Пт 09–18, Сб 09–15.
3. Врачу этого здания (в «Сотрудниках») выбрать здание и график до 20:00 → сохранить часы → предупреждение называет его и время.
4. Календарь: суббота — до 15:00, воскресенье закрыто.
5. Скрыть здание с сайта.
6. Интерфейс на узбекском — название здания в списке на узбекском.
7. Если у тестовой клиники нет филиала-установки, синхронизацию не проверять: её покрывают тесты.

**4. Пуш и тег.** `git push` ветки (владелец: «после изменений — пушить»). Тег — только по слову владельца. Заметки к выпуску (`RELEASE_NOTES.md` + `release-notes.test.mjs`) — при подготовке выпуска, не в этом плане.

---

## Вопросы владельцу

1. **Врачи, у которых в «Сотрудниках» не выбрано здание.** Часы работы здания их сегодня не ограничивают. Так считает запись: здание врача — только поле «Филиал» его карточки. Это касается и врачей, приписанных зданию лишь списком «Филиалы» сотрудника. Предупреждение и календарь в этом шаге работают так же. Варианты:
   - **A (в плане):** как сегодня — часы здания ограничивают только врачей с выбранным зданием. Подсказка под часами говорит это прямо.
   - **B:** врачей без здания ограничивать часами главного здания. Это меняет запись у тех, кто уже работает; строится отдельным шагом с тем же предупреждением.

**Сообщить владельцу (решено, не вопросы):**
- Адрес для партнёров, карта и телефон главного здания вводятся в «Компании». Адреса остальных зданий — в «Филиалах» главного здания. В «Компании» филиала они только видны. Одно место на каждое здание.
- Телефон главного здания для сайта — тот же, что печатается на бланках («Компания»).
- Филиал на старой версии программы применит часы своего здания только после обновления. До того календарь филиала часы его здания не сужает, а главное здание — сужает.
- Скрытое с сайта здание прячет и своих врачей. Применяется, когда появится публикация врачей (шаг 5) и API (шаг 8).
- Прежнее поле «Адрес» в списке филиалов больше не правится. Его значение видно на странице здания, пока его не перенесут в списки и улицу.
