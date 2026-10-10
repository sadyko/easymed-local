# API клиники, шаг 5: публичный профиль врача — показ, специальности, языки, фото, приём, что увидят партнёры, цены консультаций (DOCTOR_PROFILE_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Публичный профиль» в карточке сотрудника становится тем, что про врача получат сайт клиники, Symptex и партнёры:
- переключатель «Показывать врача» (только администратор) и «заполнен на N%»;
- ФИО, учёная степень и биография на трёх языках с пометкой «нет перевода»;
- до четырёх специальностей по коду (рядом — UZ, EN и код; повтор отклоняется);
- языки приёма, «Работает врачом с <год>», фото для партнёров из карточки;
- приём «по записи» / «живая очередь», «Запись открыта на 7 / 14 / 30 дней», «Показывать, сколько человек в очереди»;
- «Что увидят партнёры» в обоих режимах;
- цены консультаций (решение владельца 8) и услуги-консультации врача из прайса (решение 12);
- колонка «Сайт и партнёры» в списке сотрудников.

Документы, отчёты и касса печатают то же, что печатали (`users.full_name`, `users.specialty`).

**Architecture:**
- Миграция 243 — только ADD COLUMN и один индекс: `users` (показ, языки, «работает с», срок записи, счётчик очереди), `consultation_types` (английское название, длительность приёма, вид для партнёров `initial` / `repeat`). Бэкфилл — только новой колонки «работает с» из прежнего стажа.
- Правила — в двух чистых общих модулях, их читают экраны, сервер и (в шаге 8) API:
  - `public/js/shared/doctor-public.js` — языки, «работает с» и стаж, заполненность, кому можно показываться, «скрытое здание прячет врача» (`branchAllowsDoctor` шага 4);
  - `public/js/shared/consultation-price.js` — ведёт ли врач вид консультации, по какой цене, сколько длится (одно правило на кассу, окно записи, CRM, «Повторный визит», карточку и API).
- «Что увидят партнёры» считает сервер — RPC `doctor_public_preview` тем же движком, что запись (`calendar.js`: новый `doctorDayWindows`), той же доской очереди (`queue.js`: `boardGroups`), тем же правилом цены. Шаг 8 берёт эти функции для `/doctors` и `/slots`.
- Раздел карточки — свой модуль `views/doctor-public-pane.js` (+ вывод `views/doctor-public-preview.js`); состояние по-прежнему держит карточка (`employees.js`), в PATCH уходят только изменённые поля (CLINIC_API_FIX_V1).
- Права: показ — только администратор (сервер 403); врач главного здания в филиале — только просмотр (сервер 409, решение 10).

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, `node:test`; клиент — ванильный JS без сборки, поддельный DOM в тестах видов.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — договор:
- «Решения владельца» 4, 8, 10, 12;
- «Правила, без которых не строим»: документы печатают прежние имена; карточка и «Мой профиль» — один профиль, каждый сохраняет только изменённое; публикацию врача меняет только администратор;
- «Порядок», шаг 5.

**Другие источники:**
- Макет (одобрен владельцем — договор для экрана) — `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\js\screen-doctor.js` (`publicPane`, `slotPreview`, `completeness`, `specialtyRows`, список `SCREENS.employees`), `data.js`, `core.js` (`tri()` — «нет перевода»), `screen-docs.js` (что получают партнёры: `consultations[].type` initial/repeat и `minutes`, `/slots?consultation=initial`, `reception`, `queue_now`), `screen-branches.js` («его врачи тоже не показываются»), `mock.css`.
- Проверка влияния — `...\impact-review\03-doctors.md` (номера строк сверены заново, см. «Сейчас в коде»).
- Аудит соответствия макету — `<скретчпад>\audit-step5-doctor.json` (44 пункта) и `<скретчпад>\audit-critic.md` (B5, B6, C2, C3).

Номера строк сверены с деревом шага 4 (`easymed.api`, ветка `feat/clinic-api-step4`, HEAD `f60948ea`, перепроверено на `48be102b` — ревью шага 4 правило `branch-profile.js`, `routes/db.js`, `branch-hours.js`; места этого плана не сдвинулись) 2026-10-10. Шаг 7 (`easymed.api7`, HEAD `4dff7cb9`, перепроверено на `b860073a` — ревью шага 7 и слияние шага 4 в шаг 7; из файлов этого плана ревью тронуло только хвосты `i18n-strings.js` и `admin-views.css`) сверен на столкновения. Перед правкой место всё равно находить заново (`grep -n`).

**Метка кода:** `DOCTOR_PROFILE_V1` — в комментарии каждой своей вставки; в общих файлах обязательно. **Метка плана и его коммитов:** `CLINIC_API_STEP5_V1` (сообщение коммита кончается скобкой `(DOCTOR_PROFILE_V1, CLINIC_API_STEP5_V1)`).

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | **Колонки (мигр. 243, ADD COLUMN):**<br>• `users.is_public` 0/1, по умолчанию 0;<br>• `users.languages` — JSON-список `ru` / `uz` / `en`, по умолчанию `'[]'`;<br>• `users.practice_since` — год «работает врачом с»;<br>• `users.booking_days` 7 / 14 / 30, по умолчанию 14 (макет `data.js days: 14`);<br>• `users.show_queue_count` 0/1, по умолчанию 0;<br>• `consultation_types.name_en`, `duration_minutes` (5..480, по умолчанию 30), `api_kind` (`''` / `initial` / `repeat`, у каждого значения — не больше одного вида: частичный UNIQUE-индекс).<br>CHECK — запасной замок для `/api/db` и синхронизации. | Аудит B5: у консультации не было ни длины, ни признака «первичный / повторный», а документация API (`screen-docs.js:54-55`) их отдаёт. 30 минут — столько окно записи и сегодня ставит консультации (`service-picker-modal.js:491`). По умолчанию скрыт — наружу никто не уходит без слова администратора (Р19). |
| Р2 | **«Работает врачом с <год>» вместо «Стаж (лет)»** (макет `screen-doctor.js:93`).<br>• Новая колонка `practice_since`; миграция заполняет её из прежнего стажа: год обновления минус стаж (бэкфилл НОВОЙ колонки, как мигр. 231).<br>• `experience_years` остаётся и пишется вместе с годом (`withExperience`): её читают филиалы на старой версии и прежние экраны.<br>• Пришёл только стаж (экран старой версии) — год считается из стажа.<br>• Стаж на сайте — полных лет от года, растёт сам («Стаж на сайте, лет: N.»). | Макет — по умолчанию. Фиксированное число лет устаревает каждый январь. Прежняя колонка не трогается — старые читатели не ломаются. |
| Р3 | **Показ врача.**<br>• Меняет только администратор: `PATCH`/`POST /api/users` с другим значением `is_public` от не-администратора — 403. Отказ — только если значение МЕНЯЕТСЯ (как охрана «Филиалов» шага 4 в `routes/db.js`).<br>• Показываемый врач — с ФИО на русском и хотя бы одной специальностью: сервер (карточка и «Мой профиль») — 400 «Чтобы показывать врача, …».<br>• Переключатель без ФИО на русском не включается — «Сначала заполните ФИО» (макет `:147`).<br>• Сохранение держит ФИО на русском, только если врача показывают или ФИО правили и стёрли. | Макет требует ФИО RU при каждом сохранении (`:158`). Отступление: у существующих врачей `full_name_ru` часто пуст, и сохранение оклада держалось бы на поле, которое врач заполняет в «Моём профиле» — против EMPLOYEE_CARD_SAVE_V1 («держит только тронутое»). |
| Р4 | **Кто виден партнёрам** — одна функция `doctorPublicState` (`shared/doctor-public.js`): врач по `is_doctor` (не по роли и специальности — инвариант проекта), работает, `is_public = 1`, здание не скрыто (`branchAllowsDoctor`, шаг 4). Её читают список сотрудников, карточка и шаг 8. | «Скрытое здание прячет и своих врачей» (макет `screen-branches.js:65`; шаг 4, Р10). |
| Р5 | **Специальности — один список** (`user_specialties`), один компонент в двух разделах: «Должность» (как было; там же у не-врачей) и «Публичный профиль» (макет `:91`). Рядом с выбранной — UZ, EN и код из `SPECIALTY_ROWS`; повтор отклоняется у поля «Эта специальность уже выбрана.» (макет `:55`). То же с «приёмом»: `scheduling_mode` правится и во «Должности», и карточками в профиле (макет: «та же настройка»). | Два редактора одного значения работают с одним состоянием карточки — расхождения нет. Сервер повтор и так отбрасывает — отказ у поля делает это видимым. |
| Р6 | **Цена консультации — одно правило** (`shared/consultation-price.js`; решения владельца 8 и 13):<br>• строка врача с ценой — её цена; «Бесплатно» — 0;<br>• строка врача с пустой ценой (не «Бесплатно») — **0**, как сейчас, везде, в том числе партнёрам (решение 13, ответ владельца на вопрос 1 — «Keep charging 0»); правило отдаёт признак `empty`, карточка пишет «0 сум · цена не введена»;<br>• строки нет — общая цена вида (решение 8);<br>• «Ведёт»: строка — её отметка; строки нет — ведёт врач (`is_doctor`); вид выключен — никто.<br>Подписи «Консультаций врачей» и карточки говорят прямо: пустая цена и «Бесплатно» — 0, впишите цену.<br>Читают касса (`pricing.js consultationFor`), окно записи, CRM, «Повторный визит», карточка, API. Окно записи и CRM больше не прячут консультацию врача без своей строки. | Решение 8: «общая цена типа консультации везде; окно записи такую консультацию больше не прячет». Решение 13: пустая цена в строке врача — 0, общая цена вида — только врачу без строки. Касса так и считает сегодня (`pricing.js` :180) — для неё правка без смены денег. Сегодня три ответа (касса, окно, CRM — проверка влияния 03). |
| Р7 | **Длина и вид консультации для партнёров** — колонки `consultation_types` (Р1), правятся в «Настройки → Виды консультаций» (тот же справочник). Движок записи берёт длину вида, когда передан `consultation_type_id` (`calendar_slots`, `calendar_book`); окно записи — вместо зашитых 30. Окно для партнёров — 15 минут у всех (макет `:100`, «Одинаково для всех врачей»). | Аудит B5 / C2: длина консультации не хранилась, движок падал на 15 минут. Шаг 8 отвечает на `/slots?consultation=initial` по `api_kind`. |
| Р8 | **«Запись открыта на 7 / 14 / 30 дней»** — у каждого врача (макет `:101`). Текст права «Свободное время» шага 7 («на 14 дней вперёд») правится после слияния (задача 18). | Аудит B6: макет противоречил сам себе; экран врача — подробнее и новее. |
| Р9 | **«Что увидят партнёры»** — RPC `doctor_public_preview` (только чтение, в `READ_ONLY_RPCS`):<br>• семь дней с завтрашнего (макет `nextDays(7)`), окна по 15 минут, занятое — визиты (`doctorDayWindows`, тот же движок);<br>• часы приёма по дням недели — для живой очереди;<br>• «сейчас ждут приёма» — доска очереди (`boardGroups`), ждущие и ждущие оплаты (Р20);<br>• консультации с ценами и минутами, услуги-консультации (Р10).<br>Показано по сохранённому графику (подсказка говорит это). Ворота — «Сотрудники: Просмотр». | Один движок — нет второй правды о свободном времени. Шаг 8 берёт те же функции. |
| Р10 | **Решение 12: услуги прайса группы «Консультации» у врачей.** Связь «кто оказывает» — уже есть: `users.service_rates` (окно услуги «Исполнители», вкладка «Услуги и ставки»; её читают касса, окно записи, CRM, оплата врача). Новой таблицы нет. Карточка показывает такие услуги врача с ценой (своя — из ставки, иначе каталог) и отметкой «На сайте» / «Не показывается» (`services.online_booking`). Экран «Услуги» — шаг 6. | Вторая таблица связей разошлась бы с той, по которой клиника уже работает. |
| Р11 | **Фото для партнёров из карточки:** «Загрузить фото» кладёт файл сразу в `doctor-photos/doctors/<id врача>/` (правило CLINIC_API_FIX_V1 не меняется), в PATCH уходит `public_profile.photo_url`. Ворота хранилища: сам врач, «Настройки: Изменение» или «Сотрудники: Изменение». Новому сотруднику — после сохранения (нет id для папки). | Макет `:88`; проверка влияния 03: «admin card can't upload». |
| Р12 | **Решение 10 — филиал только смотрит.** Уже есть: карточка (`managed`) и «Мой профиль» — только просмотр, `PATCH` и RPC — 409. Новое: загрузка фото врача главного здания в филиале — 409. Новые колонки едут с сотрудником из главного (`catalogue.js`). | Без 409 файл лёг бы в филиале и пропал из профиля при следующей синхронизации. |
| Р13 | **Список сотрудников:** колонки макета «Специальность», «Приём», «Сайт и партнёры» добавляются между «Категорией» и «Ролью»; «Роль» и «Телефон» с их фильтрами остаются; на узкой ширине таблица прокручивается в своей карточке. Слова показа — «На сайте» / «Скрыт с сайта» (+ «филиал скрыт»), как в списке «Филиалов» шага 4. | Список — для всего персонала: роль и телефон с фильтрами (EMP_COL_FILTERS_V1) нужны каждый день; макет показывал только врачей. Одни слова на «Филиалы» и «Сотрудников». |
| Р14 | **Раздел — по порядку макета** внутри существующей карточки 1080 px: показ → фото → ФИО → специальности → степень → «работает с» и языки → биография → «Приём пациентов» с «Что увидят партнёры» → «Цены консультаций» → «Консультации из прайса» → соцсети и списки (были в карточке, макет их не рисует; убрать — потерять). | Макет — договор; построенное не теряется. |
| Р15 | **«нет перевода»** — `triGroup({ markMissing })` шага 3 у ФИО и биографии; у учёной степени — без пометки (макет `tri(..., { noMiss: true })`). | Один компонент на «Компанию», «Филиалы», врача. |
| Р16 | **«Мой профиль»** (это же профиль): языки приёма, «Работает врачом с» вместо «Стаж (лет)», строка «показывается / не показывается — показ включает администратор». Показ врач не меняет (ключа нет в `PROFILE_KEYS` — 400). | Правило «один профиль»; показ — администратор. |
| Р17 | **Смешанные версии.** Колонки сотрудника едут в филиал (`catalogue.js`, `users`):<br>• главная старше шага 5 — ключей нет, местное остаётся (`present`-фильтр приёма);<br>• филиал старше — его код ключей не знает и пропускает;<br>• прежний стаж пишется вместе с годом — старый филиал показывает верный стаж.<br>`consultation_types` между зданиями не ездят — у каждого здания свои виды. | Как Р9 / Р14 шага 4: приём справочника — одна транзакция, ничего не должно её ронять. |
| Р18 | **Тесты не занимают порт анализаторов** (задача 0b, маркер `LIS_TEST_PORT_V1`). `server/services/rpc/index.test.js` зовёт каждый RPC как администратор, в том числе `lis_restart` (`rpc/lis.js:130-133` → `startLisListeners(db)`), — и слушает настоящий `0.0.0.0:2575` (LIS_PORT по умолчанию), тот же порт, что у Easy-Med, запущенного на этой машине. Файл выключает приём (`LIS_ENABLED = '0'`) и проверяет, что обход ничего не слушает. Страж `server/lis-port-hygiene.test.js` не даёт появиться новому такому файлу: дошёл до `startLisListeners` (имя `startLisListeners` / `lisRestart` / `lisDeviceDelete`, RPC `lis_restart` / `lis_device_delete`, обход всей карты RPC с вызовом, запуск `server/index.js` дочерним процессом) — обязан задать `LIS_ENABLED` или `LIS_PORT`. | Найдено grep'ом по всем `server/**/*.test.js` (2026-10-10): нарушитель один — `rpc/index.test.js`; `lis/index.test.js`, `lis/lisproxy-device.test.js`, `lis/real-analyzers.e2e.test.js` ставят свой `LIS_PORT`, `rpc/lis.test.js` — `LIS_ENABLED = '0'` (отказы 400/403/404 падают раньше запуска); `server/index.js` запускает приём только как главный модуль (`isMain` :118-121, вызов :260), тестов, запускающих его процессом, нет; `createApp` приём не поднимает. Правило сторожа — по образцу `server/app-test-hygiene.test.js`. |
| Р19 | **После обновления все врачи скрыты** (`is_public` по умолчанию 0); администратор включает каждого. *Решено контролёром, владелец может пересмотреть* (был вопрос 2, вариант A). | Наружу не уходит ни один врач без слова администратора; API всё равно заработает только в шаге 8. Вариант B (сразу показывать врачей с ФИО RU и специальностью) — одна строка в миграции 243: `UPDATE users SET is_public = 1 WHERE …`; до выпуска поменять можно. |
| Р20 | **«Сейчас ждут приёма» — все с талоном к врачу, кого ещё не приняли, включая неоплативших** (`waiting_count + unpaid_count` доски очереди, `doctorQueueWaiting`). *Решено контролёром, владелец может пересмотреть* (был вопрос 3, вариант A). | Пациент, который смотрит на очередь, будет стоять и за тем, кто сейчас платит. Вариант B (только оплатившие) — одно слагаемое в `doctorQueueWaiting` (задача 11) и одно ожидание в её тесте. |

**Отметки для следующих шагов:**
- **Шаг 6** («Услуги»): вкладка «Консультации» — врачи с `doctorPublicState` и `doctorConsultations`; строку с `empty` показывать как карточка — «0 сум · цена не введена» (решение 13); услуги группы «Консультации» без исполнителя (`service_rates` пуст) партнёры не увидят ни у кого — экрану сказать это.
- **Шаг 8** (API): `/doctors` — `doctorIsPublic`, `doctorConsultations`, `doctorConsultServices`, `experienceYears(practice_since)`, `readLanguages`; `/slots` — `doctorDayWindows(db, { durationMin: consultMinutes(вид api_kind) })` на `booking_days` вперёд; живая очередь — `hours` и `doctorQueueWaiting` при `show_queue_count`; фото — нужен открытый маршрут (сегодня `/api/storage` за входом).

## Карта файлов

**Создаются:**
- Миграция: `server/db/migrations/243_doctor_public_profile.sql`, `server/db/migrations/243.test.js`.
- Общие модули: `public/js/shared/doctor-public.js` (+ `.test.js`), `public/js/shared/consultation-price.js` (+ `.test.js`).
- Сервер: `server/services/rpc/doctor-public.js` (+ `.test.js`), `server/routes/consultation-types-guard.test.js`.
- Виды: `public/js/admin/views/doctor-public-pane.js`, `public/js/admin/views/doctor-public-preview.js`.
- Страж тестов (задача 0b): `server/lis-port-hygiene.test.js`.

**Меняются:**
- Документы: `docs/specs/2026-10-06-clinic-api-design.md` (решение владельца 13, задача 0).
- Сервер: `server/db/schema-registry.js` (:542-597 users, :707-709 consultation_types); `server/routes/users.js`; `server/routes/storage.js` (:204-205, :317-352); `server/routes/db.js` (за блоком `branchFormat`); `server/services/rpc/doctor-profile.js`; `server/services/domain/pricing.js` (:170-184); `server/services/rpc/calendar.js` (:136-143, :345-357, :754, :956-958); `server/services/rpc/queue.js` (:281-393); `server/services/rpc/index.js` (:48, :292); `server/services/control/gate.js` (:168); `server/services/branch-sync/catalogue.js` (:220).
- Права и словарь: `public/js/shared/permission-catalog.js` (:356), `public/js/admin/i18n-strings.js` (в конец).
- Экраны: `views/employees.js`, `views/doctor-profile.js`, `views/service-picker-modal.js`, `views/crm.js`, `views/service-workspace.js`, `views/consultation-types.js`, `views/settings-hub.js` (:651-658).
- Стили: `public/css/admin-views.css` (в конец).
- После слияния шага 7: `public/js/shared/api-connections.js` (:28).
- Тесты: `server/services/rpc/index.test.js` (задача 0b), `server/db/schema-registry.test.js`, `server/db/write-grant.test.js`, `server/services/rpc/doctor-profile.test.js`, `server/routes/users.public-profile.test.js`, `server/routes/photo-storage.test.js`, `server/services/branch-sync/catalogue.test.js`, `server/services/rpc/billing.audit-fix.test.js`, `server/services/rpc/calendar.test.js`, `server/services/rpc/queue-board.v3120.test.js`; клиентские `consultation-flags.test.mjs`, `crm-card.test.mjs`, `employees-specialties-save.test.mjs`, `employees-profile-save.test.mjs`, `doctor-profile-save.test.mjs`.

---

## Сейчас в коде (сверено 2026-10-10)

- **Профиль врача в базе** — мигр. 159: `users.full_name_ru/uz/en`, `academic_title_*`, `bio_*`, четыре `*_entries` (JSON), `experience_years`, `instagram_url`, `telegram_url`, `photo_url`. Показа, языков, «работает с», срока записи и счётчика очереди нет.
- **Белый список профиля** — `server/services/rpc/doctor-profile.js`: `PROFILE_KEYS` :51; `cleanValue` :59-119 (незнакомый ключ уходит в ветку ссылок :82-118 — новые ключи требуют своих веток); `cleanProfileFields` :187-195; `publicProfileOf` :199-214; `updateMyDoctorProfile` :220-287 (409 врачу главного здания — :234-238; запись только колонок из PRAGMA — :248-261; `updated_at` — :278-280).
- **Карточка сотрудника, сервер** — `server/routes/users.js`: `parseEmployeeFields` :37-196 (публичный профиль — :121-124 через `cleanProfileFields`; дальше `branch_id` :126); `employeeView` :383-413 (`public_profile` :396); POST :625-679; PATCH :681-815 (409 главной клиники — :689-690; защиты не-администратора — :713-752; разбор полей — :761-766; запись одной транзакцией — :803-806). `isAdminUser`, `forbid`, `bad` — в файле. Специальности — `parseSpecialties` :441-459, `writeSpecialties` :488-506, `readSpecialties` :507-510.
- **Карточка сотрудника, экран** — `public/js/admin/views/employees.js`:
  - список: шапка :201, фильтры :202-205, строки :249-294 (`colspan: '6'` — :265, :298, :326), загрузка зданий `select('id, name')` — :303;
  - разделы :331-350 («Публичный профиль» — `doctorOnly`); `openEditor` :399; состояние `emp` :401-450; `profilePatch` :452; `profileAtOpen` / `profileSame` :458-463 (числом сравнивается только `experience_years`); `managed` :498; `acc` / `readOnly` :500-501;
  - `profileSection` :636-659: ФИО / степень / биография — простые поля без «нет перевода», «Стаж (лет)» с `max 80`, Instagram / Telegram, списки только для чтения, фото только показывается;
  - `renderBody` :705; `specialtiesField` :722-744 (значения — русские названия; повтор не отклоняется, сервер молча его отбрасывает — `users.js` :450); «Приём услуг» во «Должности» — :769-770; раздел профиля — :782-783;
  - `save` :933; проверка процентов :946-955; `payload` :957-982; специальности — только изменённые :994; профиль — только изменённое :997-999.
- **«Мой профиль»** — `public/js/admin/views/doctor-profile.js`: колонки загрузки :110-124; только просмотр врачу главного здания :170-181; «Стаж (лет)» :195-198; `collectAll` :332-356 (стаж — :347-348).
- **Цена консультации** — `server/services/domain/pricing.js consultationFor` :170-184: строка врача — её цена (`is_free` → 0, пустая → 0), строки нет — цена вида; «Ведёт» и активность вида не читаются (это касса: строка визита уже есть).
- **Окно записи** — `public/js/admin/views/service-picker-modal.js`: `consultPriceFor` :245-250 (нет строки → 0); врачи :411-414 (`u.is_doctor === true` — из базы приходит 1, поэтому врач-администратор без специальности сюда не попадает); строки консультаций :462-498 — только по строкам с «Ведёт» (:483), длительность зашита 30 (:491); сетка мастеров `SLOT_STEP_MIN = 30` :3432.
- **CRM** — `public/js/admin/views/crm.js`: `consultPriceOf` :1781-1786 (как касса); врачи консультации `doctorsForService` :1787-1792 — только со строкой «Ведёт», иначе все; каталог врачей :2075-2077 (`role = 'doctor'`); строки цен :2096-2110.
- **«Повторный визит»** — `public/js/admin/views/service-workspace.js` :1422-1438: виды — только со строкой «Ведёт», цена без строки — 0.
- **«Консультации врачей»** — `public/js/admin/views/consultation-types.js`: окно врача :303-437, «Save» переписывает все строки врача и пишет `price: null` для пустой цены (:372-396) — то есть после первого «Save» у врача есть строки с пустой ценой; подсказка :426-427; карточка видов `renderDefaults` :104-197 — мёртвая (не вызывается).
- **Виды консультаций** — `public/js/admin/views/settings-hub.js` `LOOKUP_CONFIG.consultation_types` :651-658 (только `name` и `price`; `name_ru`, которое читают касса и окно записи, при переименовании не меняется); сохранение справочника :1393-1437, `beforeSave` может дописать поля (образец — `referral_sources` :832-838); пустая строка не уходит (:1416).
- **Реестр** — `server/db/schema-registry.js`: `users` :542-597 (запись — пусто: пишут `routes/users.js` и RPC; `json` :593-594); `consultation_types` :707-709; `doctor_consultation_prices` :1077-1087. Право `settings.consultation_types` — `permission-catalog.js:356` (`grantColumns`).
- **Движок записи** — `server/services/rpc/slot-engine.js` (`DEFAULT_DURATION_MIN = 15` :55, `slotStarts` :240-254); `server/services/rpc/calendar.js`: `loadBusy` :251-292, `resolveDuration` :345-357 (явная → услуга → 15), `resourceWindow` :360-372 (здание врача — `users.branch_id`), `calendarSlots` :731-813, `calendarBook` :929 (длительность — :956-958).
- **Очередь** — `server/services/rpc/queue.js`: ключ врача `doc:<id>:<день>` (шапка :6-7); `queueBoard` :281-393 — проверка раздела и подсчёт в одной функции; `waiting_count` / `unpaid_count` :381-382.
- **Хранилище** — `server/routes/storage.js`: путь фото `doctors/<id>/<ключ>` (`photoTarget` :164-174); право `doctorPhotoDenial` :317-324 (сам врач или `canEditSection('settings')`); `photoGate` :344-352; текст отказа :204-205.
- **Синхронизация** — `server/services/branch-sync/catalogue.js`: `users` :167-312, колонки профиля :206-220 (`photo_url` не едет — :206-210); приём таблиц — только присланные ключи (`present` :800).
- **Шаг 4 в дереве:** `branchAllowsDoctor` (`public/js/shared/branch-profile.js`), `triGroup({ markMissing })` (`views/company-fields.js`), `WEEK_DAYS` (`views/week-hours.js`), RPC `branch_hours_impact` (`index.js:292`), `show_public` у зданий.
- **Шаг 1 сделан:** частичные сохранения обоих экранов, флаги 0/1 через `isOn` (`shared/flags.js`), фото только из своей папки, 409 «Моего профиля» врачу главного здания.

**Что в заметке проверки влияния устарело:**
- Право на загрузку фото — `storage.js:317-324` (не :296-303); реестр `users` — :542 (не :524).
- «Консультации врачей» пишут строки на :372-396 (не :366-384) и пишут `price: null` для пустой цены — отсюда вопрос 1 (ответ владельца — решение 13: такая строка — 0).
- Список видов консультаций правится не в «Консультациях врачей» (`renderDefaults` мёртв), а в «Настройки → Виды консультаций».
- Окно записи берёт врача по `is_doctor === true`, а база отдаёт 1.

---

## Правила рабочего дерева (читать до первого шага)

**Дерево** назначает контролёр: ветка `feat/clinic-api-step5` от основной линии ПОСЛЕ слияния шагов 4 и 7. Номера строк в плане — по дереву шага 4; где файл менял и шаг 7, сказано у задачи.
- Ветку не переключать; worktree не создавать (стирает `node_modules`).
- Если в клоне работают другие сборщики — свои ханки только по метке: `git diff -U0 -- F | node <скретчпад>/keep-hunks-v2.mjs DOCTOR_PROFILE_V1 > own.patch; git apply --cached --check --unidiff-zero own.patch; git apply --cached --unidiff-zero own.patch` (скрипт — из `docs/plans/2026-09-28-lis-mindray-codes.md` с правкой v2).

**Перед каждым коммитом:**
1. `git status --short`.
2. `git diff --cached --name-only` пуст. Если нет — кто-то собирает коммит: подождать, ничего не снимать.
3. Для каждого своего файла `git diff -U0 -- <файл>`: чужих ханков нет — `git add <файл>`; есть — по метке (см. выше).

**Запрещено:** `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`. Не трогать запущенные серверы (:8000, :8712) и каталог `data/`. Пушить и ставить тег — контролёр.

**Миграция — 243** (241 — шаг 4, 242 — шаг 7). Перед созданием — `ls server/db/migrations | tail -6`. Занят — следующий свободный номер, переименовать файл, тест и упоминания. Пропуски не заполнять.

**Файлы и коммиты:**
- Файлы — LF.
- Сообщение коммита — Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/doctor-profile-<N>.txt`, затем `git commit -F <файл>`.
- По-русски; первая строка — текст коммита из задачи с хвостом `(DOCTOR_PROFILE_V1, CLINIC_API_STEP5_V1)`; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- В коммит — только названные файлы задачи.

**Тесты:**
- Только явными путями, из корня клона: `node --test <файлы>` — серверные и `public/js/shared/*.test.js`; `node --experimental-vm-modules --test <файлы>` — клиентские `.mjs`.
- Каталог аргументом не передавать (Node 24 на Windows).
- Харнессы экранов задают `localStorage['admin.lang'] = 'ru'` до импорта видов (ловушка локали CI).

**Текст и вид:**
- Каждая новая строка интерфейса и каждое сообщение сервера — статьёй ru / uz / en в `i18n-strings.js` (в конец, блоком с комментарием `// DOCTOR_PROFILE_V1`).
- Перед добавлением — `grep -n '^  "<ключ>":' public/js/admin/i18n-strings.js`: статья есть — не дублировать. Уже есть (шаги 3–4 и раньше): «нет перевода», «ФИО», «Учёная степень», «Специальности», «Специальность», «Публичный профиль», «Сайт и партнёры», «Приём», «На сайте», «Скрыт с сайта», «По записи», «Живая очередь», «Бесплатно», «Первичный приём», «Повторный приём», «Длительность, мин», «Название (RU)» / «(UZ)» / «(EN)», «{n} мин», «{sum} сум», «Загрузка…», «Не удалось загрузить фото», «Не удалось загрузить фото: {msg}», «Профиль врача меняется в главном здании.», «Нужно войти в систему.», «Врач не найден.», «Добавить специальность», «Убрать», «Консультации врачей», «Образование», «Опыт работы», «Сертификаты», «Повышения квалификаций», «Пока пусто — врач заполняет в «Моём профиле».», дни «Пн»…«Вс». «Скрыт» шага 7 этим шагом не используется.
- Узбекский и английский — без кириллицы (`i18n-uz-quality`).
- Русский текст не склеивать с переменными: шаблон `{x}` + `trf()`.
- Данные клиники и врача (имена, названия, коды, время) — `document.createTextNode`, не через `tr()`.
- Размеры шрифта — только 12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40 (`type-scale`).
- Значки — только `Icon()`: User, Image, Calendar, Patients, Clock, Edit, Building, Globe. Без эмодзи.
- Вёрстка — без фиксированных ширин больше 320 px; сетки `repeat(auto-fill, minmax(min(100%, …px), 1fr))`; на ширине телефона — один столбец.

**Полный прогон** делает контролёр после всех задач («Завершение»). Во время работы — только файлы тестов задачи и названные сторожа.

**Ответы владельца** (когда придут) — вписать блоком сюда, с номерами задач, которые они меняют.

**Ответы и решения на 2026-10-10 (уже учтены в задачах):**
- Вопрос 1 → **решение владельца 13** («Keep charging 0»): пустая цена в строке врача «Консультаций врачей» (не «Бесплатно») — 0, как сейчас, везде, в том числе партнёрам; общая цена вида — только врачу без строки (решение 8). Задачи 0, 4, 9, 10, 12, 14, 15; Р6.
- Вопрос 2 → вариант A, *решено контролёром* (Р19): после обновления все врачи скрыты. Задача 1.
- Вопрос 3 → вариант A, *решено контролёром* (Р20): в «сейчас ждут» — и неоплатившие. Задача 11.
- Контролёр добавил задачу 0b (Р18): тесты не занимают порт анализаторов 2575.

---

## Task 0: План в репозиторий

**Files:**
- Create: `docs/plans/2026-10-10-clinic-api-5-doctor-profile.md` (копия этого файла)
- Modify: `docs/specs/2026-10-06-clinic-api-design.md` (решение владельца 13 — за пунктом 12)

- [ ] **Step 1:** скопировать этот план в `docs/plans/2026-10-10-clinic-api-5-doctor-profile.md` (LF).
- [ ] **Step 2: решение 13 в спецификацию.** `grep -n "^12\. \*\*Услуги прайса" docs/specs/2026-10-06-clinic-api-design.md` → одна строка (сейчас :38, раздел «Решения владельца 2026-10-10 после проверки по макету»). Сразу за ней вставить:

```markdown
13. **Пустая цена в строке врача «Консультаций врачей»** (не «Бесплатно») — 0, как сейчас, везде, в том числе партнёрам. Общая цена вида — только врачу без строки (решение 8).
```

  Проверка: `grep -n "^13\. " docs/specs/2026-10-06-clinic-api-design.md` → одна строка, следующая за пунктом 12; файл — LF (`git diff -- docs/specs/2026-10-06-clinic-api-design.md` — одна добавленная строка).
- [ ] **Step 3: коммит** (оба файла) «План шага 5 API клиники: публичный профиль врача; решение владельца 13 — пустая цена в строке врача — 0».

---

## Task 0b: Тесты не занимают порт анализаторов 2575 (LIS_TEST_PORT_V1)

Только сервер и тесты. Маркер вставок — `LIS_TEST_PORT_V1` (в `keep-hunks-v2.mjs` — эта метка, не `DOCTOR_PROFILE_V1`); коммит, как все, кончается `(DOCTOR_PROFILE_V1, CLINIC_API_STEP5_V1)` — задача входит в план шага 5 (Р18).

**Files:**
- Create: `server/lis-port-hygiene.test.js`
- Modify: `server/services/rpc/index.test.js` (импорты :18-26; за блоком `DATA_DIR` :32-34; тест обхода :55-75)

**Что найдено** (grep по `server/**/*.test.js`, 2026-10-10, дерево шага 4 `48be102b`; шаг 7 новых таких файлов не добавляет):

| Файл | Как доходит до `startLisListeners` | Порт |
|---|---|---|
| `server/services/rpc/index.test.js` | обход `Object.keys(RPC)` → `getRpc(name)(db, {}, admin)` → `lis_restart` (администратор в `LAB_SECTION_ROLES`) → `startLisListeners(db)` | **ничего — слушает настоящий 0.0.0.0:2575** |
| `server/lis/index.test.js` | `startLisListeners`, `lisRestart`, `lisDeviceDelete` | свой `LIS_PORT` в каждом тесте / `withLis` |
| `server/lis/lisproxy-device.test.js` | `startLisListeners` | свой `LIS_PORT` |
| `server/lis/real-analyzers.e2e.test.js` | `startLisListeners`, `lisDeviceDelete` | свой `LIS_PORT` в `withClinic` |
| `server/services/rpc/lis.test.js` | `lisDeviceDelete` | `LIS_ENABLED = '0'` (`withLisOff`); отказы 400/403/404 падают до запуска |

Не доходят: HTTP-тесты (`createApp` приём не поднимает; `lis_restart` / `lis_device_delete` по HTTP никто не зовёт), `server/index.js` (приём — только главным модулем, `isMain` :118-121, вызов :260; `index.datadir.test.js` берёт лишь `resolveDataDir`), дочерние процессы (`tmpdir.test.js` запускает `node -e`, `apply-update` / `updater` / `boot-confirm` только пишут файлы `index.js`). Остальные файлы с `getRpc(name)` зовут RPC по своим именам, обхода всей карты у них нет.

- [ ] **Step 1: падающий страж** `server/lis-port-hygiene.test.js`:

```js
// LIS_TEST_PORT_V1 (CLINIC_API_STEP5_V1, 2026-10-10) — ТЕСТ НЕ ЗАНИМАЕТ ПОРТ
// АНАЛИЗАТОРОВ ЭТОЙ МАШИНЫ.
//
// startLisListeners слушает 0.0.0.0 на LIS_PORT, по умолчанию 2575, — на этот
// же порт анализаторы шлют результаты Easy-Med, запущенному на этой машине
// (у разработчика он запущен почти всегда). Тест, дошедший до приёма без
// своего порта, забирал 2575 у работающей программы, а при занятом порте
// проверял не то. Так было с services/rpc/index.test.js: обход зовёт КАЖДЫЙ
// обработчик, в том числе lis_restart.
//
// Правило: файл, который может дойти до startLisListeners, задаёт в коде
// LIS_ENABLED (приём выключен) или LIS_PORT (свой свободный порт). Дойти можно:
//   • именем startLisListeners / lisRestart / lisDeviceDelete (импорт, вызов);
//   • RPC 'lis_restart' / 'lis_device_delete' по имени (getRpc, /api/rpc/…);
//   • обходом всей карты RPC с вызовом обработчиков;
//   • запуском server/index.js дочерним процессом.
// Проверяется правило, а не поведение приёма (для него — lis/index.test.js).
// Образец — app-test-hygiene.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

function testFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') testFiles(p, out); }
        else if (/\.test\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

// Комментарии не в счёт: в них эти имена и объясняются.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const REACH = [
    ['startLisListeners / lisRestart / lisDeviceDelete', (c) => /\b(?:startLisListeners|lisRestart|lisDeviceDelete)\b/.test(c)],
    ['RPC lis_restart / lis_device_delete по имени', (c) => /['"`/](?:lis_restart|lis_device_delete)['"`]/.test(c)],
    ['обход всей карты RPC с вызовом обработчиков', (c) => /Object\.(?:keys|entries|values)\(\s*RPC\s*\)/.test(c)
        && /(?:getRpc\(\s*[A-Za-z_$][\w$]*\s*\)|RPC\[\s*[A-Za-z_$][\w$]*\s*\])\s*\(/.test(c)],
    ['запуск server/index.js дочерним процессом', (c) => /\b(?:spawn|spawnSync|fork|execFile|execFileSync|exec|execSync)\s*\((?:[^()]|\([^()]*\))*?(?:\([^()]*)?index\.js/.test(c)],
];
const SETS_PORT = /process\.env\.LIS_(?:ENABLED|PORT)\s*=(?!=)|process\.env\[\s*['"]LIS_(?:ENABLED|PORT)['"]\s*\]\s*=(?!=)|\bLIS_(?:ENABLED|PORT)\s*:/;

/** Почему файл может дойти до приёма анализаторов; [] — не может. */
export function reachesLis(code) {
    return REACH.filter(([, hit]) => hit(code)).map(([why]) => why);
}
/** Задаёт ли файл LIS_ENABLED или LIS_PORT (присваиванием или в env дочернего процесса). */
export function setsLisPort(code) {
    return SETS_PORT.test(code);
}

const rel = (file) => path.relative(HERE, file).split(path.sep).join('/');

test('ни один тест не поднимает приём анализаторов на порте этой машины', () => {
    const offenders = [];
    for (const file of testFiles(HERE)) {
        if (path.basename(file) === SELF) continue;
        const code = codeOf(fs.readFileSync(file, 'utf8'));
        const why = reachesLis(code);
        if (why.length && !setsLisPort(code)) offenders.push(rel(file) + ' — ' + why.join('; '));
    }
    assert.deepEqual(offenders, [], [
        'Эти тесты доходят до startLisListeners без своего порта и занимают 0.0.0.0:2575 —',
        'порт анализаторов Easy-Med, запущенного на этой машине:',
        ...offenders.map((o) => '  ' + o),
        'Выключите приём: process.env.LIS_ENABLED = \'0\' (и верните в test.after),',
        'или, если тест проверяет сам приём, — свой свободный порт в process.env.LIS_PORT.',
    ].join('\n'));
});

test('страж узнаёт все пути к приёму и не путает с ними безобидное', () => {
    assert.deepEqual(reachesLis("import { lisRestart } from './lis.js';"), ['startLisListeners / lisRestart / lisDeviceDelete']);
    assert.deepEqual(reachesLis("await post(base, cookie, '/api/rpc/lis_restart', {});"), ['RPC lis_restart / lis_device_delete по имени']);
    assert.deepEqual(reachesLis('for (const name of Object.keys(RPC)) await getRpc(name)(db, {}, admin);'), ['обход всей карты RPC с вызовом обработчиков']);
    assert.deepEqual(reachesLis("spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env });"), ['запуск server/index.js дочерним процессом']);
    assert.deepEqual(reachesLis('const known = new Set(Object.keys(RPC));'), [], 'имена карты без вызова — не обход');
    assert.deepEqual(reachesLis("await getRpc('backup_create')(db, {}, admin);"), [], 'RPC по своему имени — не обход');
    assert.deepEqual(reachesLis("fs.writeFileSync(path.join(root, 'server', 'index.js'), '//');"), [], 'файл index.js не запуск');
    assert.equal(setsLisPort("process.env.LIS_ENABLED = '0';"), true);
    assert.equal(setsLisPort('process.env.LIS_PORT = String(port);'), true);
    assert.equal(setsLisPort("spawn(node, args, { env: { ...process.env, LIS_ENABLED: '0' } });"), true);
    assert.equal(setsLisPort("if (process.env.LIS_ENABLED === '0') return;"), false, 'сравнение — не установка');
    assert.equal(codeOf('// await lisRestart(db)\nconst x = 1;').includes('lisRestart'), false, 'комментарий не в счёт');
});

test('страж смотрит на настоящие файлы: известные пути к приёму найдены', () => {
    const files = testFiles(HERE);
    assert.ok(files.length > 50, 'тестов найдено ' + files.length + ' — обход сломан');
    const reaching = files.filter((f) => path.basename(f) !== SELF && reachesLis(codeOf(fs.readFileSync(f, 'utf8'))).length).map(rel);
    for (const known of ['services/rpc/index.test.js', 'services/rpc/lis.test.js', 'lis/index.test.js',
        'lis/lisproxy-device.test.js', 'lis/real-analyzers.e2e.test.js']) {
        assert.ok(reaching.includes(known), known + ' не узнан стражем: ' + reaching.join(', '));
    }
});
```

- [ ] **Step 2:** `node --test server/lis-port-hygiene.test.js` → первый тест падает ровно с одной строкой: `services/rpc/index.test.js — обход всей карты RPC с вызовом обработчиков`; второй и третий — зелёные. Падает другой файл — это новый нарушитель: исправить его так же (Step 3) и назвать в отчёте.
- [ ] **Step 3: правка `server/services/rpc/index.test.js`.**
  - Импорт за :26: `import { listenerStatus } from '../../lis/index.js';   // LIS_TEST_PORT_V1`.
  - Сразу за строкой `test.after(() => { setDataDir(null); … });` (:34):

```js
// LIS_TEST_PORT_V1 (CLINIC_API_STEP5_V1) — обход зовёт и lis_restart, а он
// поднимает настоящий приём анализаторов на 0.0.0.0:2575 (LIS_PORT по
// умолчанию) — порт Easy-Med, запущенного на этой машине. Здесь проверяется
// проводка, а не приём: он выключен на весь файл (страж — lis-port-hygiene.test.js).
const PREV_LIS_ENABLED = process.env.LIS_ENABLED;
process.env.LIS_ENABLED = '0';
test.after(() => { if (PREV_LIS_ENABLED === undefined) delete process.env.LIS_ENABLED; else process.env.LIS_ENABLED = PREV_LIS_ENABLED; });
```

  - В тесте обхода, за строкой `assert.ok(fs.existsSync(path.join(DATA_DIR, 'backups')), …);`:

```js
  // LIS_TEST_PORT_V1 — lis_restart прошёл, но ничего не слушает и не пытался слушать.
  const lis = listenerStatus();
  assert.deepEqual([lis.listening, lis.failed], [[], []], 'обход поднял приём анализаторов: ' + JSON.stringify(lis));
```

- [ ] **Step 4:** `node --test server/lis-port-hygiene.test.js server/services/rpc/index.test.js` → зелёные.
- [ ] **Step 5: проверка, что прежние файлы приёма не задеты:** `node --test server/lis/index.test.js server/lis/lisproxy-device.test.js server/lis/real-analyzers.e2e.test.js server/services/rpc/lis.test.js server/app-test-hygiene.test.js` → зелёные. Перепроверка поиска (только чтение): `git grep -lE "startLisListeners|lisRestart|lisDeviceDelete|lis_restart|lis_device_delete|Object\.(keys|entries|values)\(RPC\)" -- "server/*.test.js"` (в путях git `*` захватывает и подпапки) — сегодня восемь файлов: пять из таблицы выше, `lis/dial.test.js` и `lis/mllp.test.js` (имена только в комментариях), `services/rpc/client-rpc-coverage.test.js` (имена карты без вызова). Новый файл в выдаче — разобрать так же.
- [ ] **Step 6: коммит** (`server/lis-port-hygiene.test.js`, `server/services/rpc/index.test.js`) «Тесты: обход всех RPC больше не занимает порт анализаторов 2575 — приём выключен на файл; страж не пускает новый тест к приёму без своего LIS_PORT или LIS_ENABLED (LIS_TEST_PORT_V1)».

---

## Task 1: Миграция 243 — профиль врача для партнёров и длина консультации (DOCTOR_PROFILE_V1)

**Files:**
- Create: `server/db/migrations/243_doctor_public_profile.sql`, `server/db/migrations/243.test.js`

- [ ] **Step 1: падающий тест** `server/db/migrations/243.test.js`:

```js
// DOCTOR_PROFILE_V1 (мигр. 243) — ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА: только ADD COLUMN и
// один индекс; бэкфилл — только новой колонки «работает с» из прежнего стажа.
// Прежние колонки, строки и их число не тронуты; CHECK и UNIQUE — запасной
// замок для /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore243() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig243-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 243)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('243: врачи скрыты, языков нет, запись на 14 дней, очередь не показывается; «работает с» — из стажа; прежнее не тронуто', () => {
  const db = dbBefore243();
  const ins = db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor, experience_years) VALUES (?, 'x', ?, 'doctor', 1, ?)");
  ins.run('d12', 'Врач Двенадцать', 12);
  ins.run('dnull', 'Врач Без стажа', null);
  const before = db.prepare('SELECT * FROM users ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal(after.length, before.length);
  const year = Number(db.prepare("SELECT strftime('%Y', 'now', 'localtime') AS y").get().y);
  after.forEach((row, i) => {
    for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k);
    assert.deepEqual([row.is_public, row.languages, row.booking_days, row.show_queue_count], [0, '[]', 14, 0]);
  });
  const by = (u) => after.find((r) => r.username === u);
  assert.equal(by('d12').practice_since, year - 12);
  assert.equal(by('dnull').practice_since, null);
});

test('243: виды консультаций — 30 минут, без вида для партнёров, name_en пуст; прежнее не тронуто', () => {
  const db = dbBefore243();
  db.prepare("INSERT INTO consultation_types (name, name_ru, price) VALUES ('Первичный', 'Первичный приём', 100000)").run();
  const before = db.prepare('SELECT * FROM consultation_types ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM consultation_types ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => {
    for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k);
    assert.deepEqual([row.duration_minutes, row.api_kind, row.name_en], [30, '', null]);
  });
});

test('243: CHECK и единственность вида для партнёров — запасной замок', () => {
  const db = openDb(':memory:'); migrate(db);
  const uid = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('d', 'x', 'doctor')").run().lastInsertRowid;
  const setU = (col, v) => db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(v, uid);
  for (const [col, bad, good] of [['is_public', 2, 1], ['booking_days', 10, 30], ['show_queue_count', 5, 1], ['practice_since', 1800, 2015]]) {
    assert.throws(() => setU(col, bad), /CHECK/, col + ' = ' + bad);
    setU(col, good);
  }
  const ct = (name, kind, min = 30) => db.prepare('INSERT INTO consultation_types (name, api_kind, duration_minutes) VALUES (?, ?, ?)').run(name, kind, min);
  assert.throws(() => ct('A', 'first'), /CHECK/);
  assert.throws(() => ct('B', '', 4), /CHECK/);
  assert.throws(() => ct('C', '', 481), /CHECK/);
  ct('Первичный', 'initial');
  ct('Повторный', 'repeat');
  ct('Онлайн', '');
  ct('Ещё один', '');
  assert.throws(() => ct('Второй первичный', 'initial'), /UNIQUE/);
});
```

- [ ] **Step 2:** `node --test server/db/migrations/243.test.js` → падает (нет колонок).
- [ ] **Step 3: миграция** `server/db/migrations/243_doctor_public_profile.sql`:

```sql
-- 243 — DOCTOR_PROFILE_V1 (2026-10-10): ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА ДЛЯ САЙТА,
-- SYMPTEX И ПАРТНЁРОВ (шаг 5 API клиники, docs/specs/2026-10-06-clinic-api-design.md;
-- план docs/plans/2026-10-10-clinic-api-5-doctor-profile.md).
--
-- ТОЛЬКО ADD COLUMN и один индекс. Бэкфилл — только НОВОЙ колонки
-- practice_since из прежнего стажа (как мигр. 231: новая колонка из старой);
-- прежние колонки не трогаются. Документы по-прежнему печатают
-- users.full_name и users.specialty.
--
-- users:
--   is_public        — 1: врач виден на сайте клиники, в Symptex и у партнёров.
--                      Меняет только администратор (routes/users.js). По
--                      умолчанию 0 — наружу никто не уходит, пока
--                      администратор не включит.
--   languages        — языки приёма: JSON-список из 'ru' / 'uz' / 'en'.
--   practice_since   — год «работает врачом с»: стаж на сайте растёт сам.
--                      experience_years остаётся и пишется вместе с ним
--                      (shared/doctor-public.js withExperience).
--   booking_days     — на сколько дней вперёд партнёры видят время: 7 / 14 / 30.
--   show_queue_count — живая очередь: показывать партнёрам, сколько ждут.
-- consultation_types:
--   name_en          — название вида на английском (наружу).
--   duration_minutes — сколько длится приём этого вида; 30 — столько окно
--                      записи ставило консультации до шага 5.
--   api_kind         — 'initial' / 'repeat' для партнёров
--                      (/slots?consultation=initial, шаг 8): у каждого
--                      значения — не больше одного вида.
-- CHECK — запасной замок для /api/db и синхронизации: экран и сервер
-- проверяют то же раньше.

ALTER TABLE users ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1));
ALTER TABLE users ADD COLUMN languages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN practice_since INTEGER CHECK (practice_since IS NULL OR practice_since BETWEEN 1940 AND 2200);
ALTER TABLE users ADD COLUMN booking_days INTEGER NOT NULL DEFAULT 14 CHECK (booking_days IN (7, 14, 30));
ALTER TABLE users ADD COLUMN show_queue_count INTEGER NOT NULL DEFAULT 0 CHECK (show_queue_count IN (0, 1));

-- Стаж, введённый раньше, — от года обновления.
UPDATE users SET practice_since = CAST(strftime('%Y', 'now', 'localtime') AS INTEGER) - experience_years
 WHERE experience_years IS NOT NULL AND experience_years BETWEEN 0 AND 80;

ALTER TABLE consultation_types ADD COLUMN name_en TEXT;
ALTER TABLE consultation_types ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480);
ALTER TABLE consultation_types ADD COLUMN api_kind TEXT NOT NULL DEFAULT '' CHECK (api_kind IN ('', 'initial', 'repeat'));
CREATE UNIQUE INDEX consultation_types_api_kind_uniq ON consultation_types(api_kind) WHERE api_kind <> '';
```

- [ ] **Step 4:** тест зелёный. Сторожа: `server/db/migration-order.test.js`, `server/db/migrate.test.js`, `server/db/migrations/159.test.js`, `024.test.js`, `032.test.js`, `server/services/rpc/doctor-profile.test.js`.
- [ ] **Step 5: коммит** «Врачи: колонки публичного профиля — показ, языки, «работает с», срок записи, счётчик очереди; у видов консультаций — английское название, длительность и вид для партнёров (миграция 243)».

---

## Task 2: Реестр и право «Консультации врачей» — новые колонки читаются и пишутся (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/db/schema-registry.js` (:542-597 `users`, :707-709 `consultation_types`)
- Modify: `public/js/shared/permission-catalog.js` (:356)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `server/db/schema-registry.test.js`, `server/db/write-grant.test.js`

> Шаг 7 меняет `schema-registry.js` у `api_tokens` (~:853) и `permission-catalog.js` у `settings.api` — другие места.

- [ ] **Step 1: падающие тесты.**
  - `schema-registry.test.js` (в импорте уже есть `REGISTRY`, `readableColumns`, `writableColumns`, `jsonColumns`):

```js
// DOCTOR_PROFILE_V1 (мигр. 243) — профиль врача для партнёров читается; пишут только свои двери.
test('users: показ, языки, «работает с», срок записи, счётчик очереди — в чтении, languages — JSON; через /api/db не пишутся', () => {
  const upd = REGISTRY.users.write.update.columns || [];   // у users запись пуста целиком: пишут routes/users.js и RPC
  for (const c of ['is_public', 'languages', 'practice_since', 'booking_days', 'show_queue_count']) {
    assert.ok(readableColumns('users').includes(c), 'чтение ' + c);
    assert.ok(!upd.includes(c), c + ' пишут routes/users.js и RPC, не /api/db');
  }
  assert.ok(jsonColumns('users').includes('languages'));
});

test('consultation_types: английское название, длительность и вид для партнёров — в чтении, вставке и правке', () => {
  for (const c of ['name_en', 'duration_minutes', 'api_kind']) {
    assert.ok(readableColumns('consultation_types').includes(c), 'чтение ' + c);
    assert.ok(writableColumns('consultation_types', 'insert').includes(c), 'вставка ' + c);
    assert.ok(writableColumns('consultation_types', 'update').includes(c), 'правка ' + c);
  }
});
```

  - `write-grant.test.js` (помощники `seed` / `addGrants` / `run` / `refused` / `REG` — в файле):

```js
// DOCTOR_PROFILE_V1 — «Консультации врачей: Изменение» задаёт длительность, вид для партнёров и английское название.
test('регистратура с «Консультации врачей: Изменение» пишет длительность, вид для партнёров и английское название', () => {
  const db = seed();
  try {
    const id = db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Первичный приём', 100000)").run().lastInsertRowid;
    const upd = (values) => run(db, { table: 'consultation_types', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] }, REG);
    assert.throws(() => upd({ duration_minutes: 45 }), refused);
    addGrants(db, 'registrar', { settings: 'view', 'settings.consultation_types': 'edit' });
    upd({ duration_minutes: 45, api_kind: 'initial', name_en: 'Initial visit' });
    assert.deepEqual({ ...db.prepare('SELECT duration_minutes, api_kind, name_en FROM consultation_types WHERE id = ?').get(id) },
      { duration_minutes: 45, api_kind: 'initial', name_en: 'Initial visit' });
  } finally { db.close(); }
});
```

- [ ] **Step 2:** `node --test server/db/schema-registry.test.js server/db/write-grant.test.js` → новые падают.
- [ ] **Step 3: реестр `users`.** В списке чтения строку `'is_local'],` (:582) заменить:

```js
                'is_local',
                // DOCTOR_PROFILE_V1 (мигр. 243) — показ врача на сайте и у
                // партнёров, языки приёма, «работает с», срок записи для
                // партнёров, счётчик очереди. Читают карточка сотрудника и «Мой
                // профиль»; пишут routes/users.js и update_my_doctor_profile.
                'is_public','languages','practice_since','booking_days','show_queue_count'],
```

  В `json` (:593-594) после `'education_entries','experience_entries','certifications_entries','prof_dev_entries',` дописать `'languages',` и хвост строки `// DOCTOR_PROFILE_V1 — языки приёма списком`.
- [ ] **Step 4: реестр `consultation_types`** — строки :707-709 заменить:

```js
  // DOCTOR_PROFILE_V1 (мигр. 243) — английское название, длительность приёма
  // вида и вид для партнёров (initial / repeat). Формат и единственность
  // вида — routes/db.js (consultTypeFormatRefusal / consultKindRefusal);
  // CHECK и UNIQUE — запасной замок.
  consultation_types: { read:{roles:ALL_STAFF,columns:['id','name','name_ru','name_uz','sort_order','price','active','created_at',
                'name_en','duration_minutes','api_kind']},   // DOCTOR_PROFILE_V1
    write:{ grant:'settings.consultation_types',
            insert:{roles:['admin'],columns:['name','name_ru','name_uz','sort_order','price','active','name_en','duration_minutes','api_kind']},
            update:{roles:['admin'],columns:['name','name_ru','name_uz','sort_order','price','active','name_en','duration_minutes','api_kind']},
            delete:{roles:[]}},
    filters:['id','active'], embed:{} },
```

- [ ] **Step 5: право** (`permission-catalog.js:356`, строка `settings.consultation_types`): `grantColumns` → `{ consultation_types: ['name', 'name_ru', 'name_uz', 'sort_order', 'active', 'name_en', 'duration_minutes', 'api_kind'] }`; `levelDesc.edit` → `'Заводит и переименовывает виды консультаций, задаёт длительность приёма и вид для партнёров. Цены — с действием «Цены и проценты».'`; хвост строки `// DOCTOR_PROFILE_V1 — длительность и вид для партнёров`.
- [ ] **Step 6: словарь:**

| ru | uz | en |
|---|---|---|
| Заводит и переименовывает виды консультаций, задаёт длительность приёма и вид для партнёров. Цены — с действием «Цены и проценты». | Konsultatsiya turlarini qo‘shadi va nomini o‘zgartiradi, qabul davomiyligi va hamkorlar uchun turini belgilaydi. Narxlar — «Narx va foizlar» amali bilan. | Adds and renames consultation kinds, sets the visit length and the partner type. Prices — with the «Prices and percentages» action. |

- [ ] **Step 7:** тесты зелёные. Сторожа: `server/db/schema-registry-conformance.test.js`, `star-meets-schema.test.js`, `server/services/grants.test.js`, `server/services/gate-fallbacks.test.js`; клиент: `public/js/admin/__tests__/db-query-schema.test.mjs`, `role-reports-settings.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 8: коммит** «Врачи и виды консультаций: новые колонки профиля читаются, виды консультаций — с длительностью и видом для партнёров; право «Консультации врачей» говорит об этом».

---

## Task 3: Общий модуль публичного профиля врача (DOCTOR_PROFILE_V1)

**Files:**
- Create: `public/js/shared/doctor-public.js`, `public/js/shared/doctor-public.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `public/js/shared/doctor-public.test.js`:

```js
// DOCTOR_PROFILE_V1 — публичный профиль врача: языки, «работает с» и стаж,
// заполненность, кому можно показываться, кого прятать.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCTOR_LANGS, BOOKING_DAYS, DEFAULT_BOOKING_DAYS, PUBLIC_SLOT_MIN, PREVIEW_DAYS, PRACTICE_SINCE_MIN,
  DOCTOR_PUBLIC_MESSAGES, COMPLETENESS_LABELS,
  normalizeLanguages, readLanguages, languagesProblem, cleanPracticeSince, experienceYears, shownPracticeSince, withExperience,
  profileCompleteness, publicationProblem, doctorPublicState, doctorIsPublic,
} from './doctor-public.js';
import { STRINGS } from '../admin/i18n-strings.js';

const NOW = new Date(2026, 9, 10);

test('постоянные — как в макете: три языка, запись на 7/14/30 (по умолчанию 14), окно 15 минут, превью на 7 дней', () => {
  assert.deepEqual(DOCTOR_LANGS, ['ru', 'uz', 'en']);
  assert.deepEqual(BOOKING_DAYS, [7, 14, 30]);
  assert.equal(DEFAULT_BOOKING_DAYS, 14);
  assert.equal(PUBLIC_SLOT_MIN, 15);
  assert.equal(PREVIEW_DAYS, 7);
  assert.equal(PRACTICE_SINCE_MIN, 1940);
});

test('языки приёма: порядок ru, uz, en без повторов; чужой код и не список — нет; пустой — «нужен хотя бы один»', () => {
  assert.deepEqual(normalizeLanguages(['en', 'ru', 'en']), ['ru', 'en']);
  assert.deepEqual(normalizeLanguages('["uz"]'), ['uz']);
  assert.equal(normalizeLanguages(['de']), null);
  assert.equal(normalizeLanguages('ru'), null);
  assert.deepEqual(readLanguages('мусор'), []);
  assert.deepEqual(readLanguages(null), []);
  assert.deepEqual(readLanguages(['uz', 'ru']), ['ru', 'uz']);
  assert.equal(languagesProblem(['ru', 'uz']), null);
  assert.equal(languagesProblem([]), DOCTOR_PUBLIC_MESSAGES.oneLanguage);
  assert.equal(languagesProblem(['fr']), DOCTOR_PUBLIC_MESSAGES.languages);
});

test('«работает врачом с»: целый год 1940..текущий; пусто — снять; стаж растёт сам', () => {
  assert.deepEqual(cleanPracticeSince('2014', NOW), { value: 2014 });
  assert.deepEqual(cleanPracticeSince('', NOW), { value: null });
  assert.deepEqual(cleanPracticeSince(null, NOW), { value: null });
  for (const bad of [1939, 2027, 2014.5, 'abc']) {
    assert.deepEqual(cleanPracticeSince(bad, NOW), { problem: DOCTOR_PUBLIC_MESSAGES.since }, String(bad));
  }
  assert.equal(experienceYears(2014, NOW), 12);
  assert.equal(experienceYears(2014, new Date(2030, 0, 1)), 16, 'через четыре года стаж больше на четыре');
  assert.equal(experienceYears(null, NOW), null);
  assert.equal(shownPracticeSince({ practice_since: 2010, experience_years: 3 }, NOW), 2010, 'год сильнее прежнего стажа');
  assert.equal(shownPracticeSince({ practice_since: null, experience_years: 12 }, NOW), 2014, 'строка главной старой версии — год из стажа');
  assert.equal(shownPracticeSince({}, NOW), null);
});

test('стаж и год пишутся вместе: пришёл год — стаж из него; пришёл только стаж (экран старой версии) — год из стажа', () => {
  assert.deepEqual(withExperience({ practice_since: 2014, bio_ru: 'x' }, NOW), { practice_since: 2014, bio_ru: 'x', experience_years: 12 });
  assert.deepEqual(withExperience({ practice_since: null }, NOW), { practice_since: null, experience_years: null });
  assert.deepEqual(withExperience({ experience_years: 12 }, NOW), { experience_years: 12, practice_since: 2014 });
  assert.deepEqual(withExperience({ experience_years: null }, NOW), { experience_years: null, practice_since: null });
  assert.deepEqual(withExperience({ bio_ru: 'x' }, NOW), { bio_ru: 'x' });
});

test('заполненность — семь проверок макета: ФИО ×3, специальность, биография ×3', () => {
  const full = { full_name_ru: 'Иванов', full_name_uz: 'Ivanov', full_name_en: 'Ivanov', bio_ru: 'а', bio_uz: 'b', bio_en: 'c' };
  assert.deepEqual(profileCompleteness(full, 1), { pct: 100, missing: [] });
  assert.deepEqual(profileCompleteness({ ...full, full_name_en: ' ', bio_en: '' }, 2), { pct: 71, missing: ['ФИО EN', 'биография EN'] });
  assert.deepEqual(profileCompleteness({}, 0), { pct: 0, missing: ['ФИО RU', 'ФИО UZ', 'ФИО EN', 'специальность', 'биография RU', 'биография UZ', 'биография EN'] });
});

test('показываемый врач — с ФИО на русском и специальностью; скрытому можно всё', () => {
  assert.equal(publicationProblem({ is_public: 0, full_name_ru: '', specialties: 0 }), null);
  assert.equal(publicationProblem({ is_public: 1, full_name_ru: ' ', specialties: 2 }), DOCTOR_PUBLIC_MESSAGES.nameRu);
  assert.equal(publicationProblem({ is_public: true, full_name_ru: 'Иванов', specialties: 0 }), DOCTOR_PUBLIC_MESSAGES.specialty);
  assert.equal(publicationProblem({ is_public: 1, full_name_ru: 'Иванов', specialties: 1 }), null);
});

test('кого видят партнёры: врач по is_doctor, работает, включён, его здание не скрыто', () => {
  const branches = new Map([[5, { id: 5, show_public: 0 }], [6, { id: 6, show_public: 1 }]]);
  const doc = { is_doctor: 1, is_active: 1, is_public: 1, branch_id: 6 };
  assert.equal(doctorPublicState(doc, branches), 'shown');
  assert.equal(doctorIsPublic(doc, branches), true);
  assert.equal(doctorPublicState({ ...doc, is_public: 0 }, branches), 'off');
  assert.equal(doctorPublicState({ ...doc, branch_id: 5 }, branches), 'branch_hidden');
  assert.equal(doctorPublicState({ ...doc, is_active: false }, branches), 'inactive');
  assert.equal(doctorPublicState({ ...doc, is_doctor: 0, role: 'doctor', specialty: 'Кардиолог' }, branches), 'not_doctor',
    'врач — по is_doctor, не по роли и специальности');
  assert.equal(doctorPublicState({ ...doc, is_doctor: true, is_public: true, is_active: true }, branches), 'shown', 'булевы из /api/users — тоже');
});

test('каждое сообщение и подпись заполненности переведены на ru / uz / en', () => {
  for (const m of [...Object.values(DOCTOR_PUBLIC_MESSAGES), ...COMPLETENESS_LABELS]) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
  }
});
```

- [ ] **Step 2:** `node --test public/js/shared/doctor-public.test.js` → падает (нет модуля).
- [ ] **Step 3: модуль** `public/js/shared/doctor-public.js`:

```js
// DOCTOR_PROFILE_V1 — ПУБЛИЧНЫЙ ПРОФИЛЬ ВРАЧА (шаг 5 API клиники): что видят
// пациенты на сайте клиники, в Symptex и у партнёров.
//
// Чистый модуль — без window, document, базы и перевода. Его читают карточка
// сотрудника («Публичный профиль», views/doctor-public-pane.js), список
// сотрудников, «Мой профиль», routes/users.js, rpc/doctor-profile.js,
// rpc/doctor-public.js, а в шаге 8 — API.
//
// Правила (спецификация «Правила, без которых не строим»; макет screen-doctor.js):
//   • показ врача меняет только администратор;
//   • показываемый врач — с ФИО на русском и хотя бы одной специальностью;
//   • документы печатают users.full_name и users.specialty — здесь их нет;
//   • скрытое здание прячет своих врачей (shared/branch-profile.js, шаг 4).
import { branchAllowsDoctor } from './branch-profile.js';

export const DOCTOR_LANGS = Object.freeze(['ru', 'uz', 'en']);
/** «Запись открыта на» (макет screen-doctor.js:101). */
export const BOOKING_DAYS = Object.freeze([7, 14, 30]);
export const DEFAULT_BOOKING_DAYS = 14;
/** Окно для партнёров — 15 минут у всех врачей (макет: «Одинаково для всех врачей»). */
export const PUBLIC_SLOT_MIN = 15;
/** «Что увидят партнёры» — семь дней, начиная с завтрашнего (макет nextDays(7)). */
export const PREVIEW_DAYS = 7;
export const PRACTICE_SINCE_MIN = 1940;

export const DOCTOR_PUBLIC_MESSAGES = Object.freeze({
  adminOnly:   'Показ врача на сайте и у партнёров меняет администратор.',
  nameRu:      'Чтобы показывать врача, введите ФИО на русском.',
  specialty:   'Чтобы показывать врача, выберите специальность.',
  oneLanguage: 'Нужен хотя бы один язык приёма.',
  languages:   'Языки приёма — только русский, узбекский и английский.',
  since:       'Год начала работы врачом — от 1940 до текущего года.',
  bookingDays: 'Запись открывается на 7, 14 или 30 дней вперёд.',
  flag:        'Отметка записана неверно: нужно «да» или «нет».',
});

const yearOf = (now) => (now instanceof Date ? now : new Date(now == null ? Date.now() : now)).getFullYear();

/** Языки → ['ru','uz','en'] в этом порядке, без повторов; не список или чужой код → null. */
export function normalizeLanguages(v) {
  let list = v;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { return null; } }
  if (!Array.isArray(list) || !list.every((x) => DOCTOR_LANGS.includes(x))) return null;
  return DOCTOR_LANGS.filter((l) => list.includes(l));
}
/** Сохранённое (TEXT JSON или массив) → массив; мусор → []. Для чтения. */
export function readLanguages(v) { return normalizeLanguages(v) || []; }
/** Присланный список: null — годен. */
export function languagesProblem(v) {
  const list = normalizeLanguages(v);
  if (!list) return DOCTOR_PUBLIC_MESSAGES.languages;
  if (!list.length) return DOCTOR_PUBLIC_MESSAGES.oneLanguage;
  return null;
}

/** «Работает врачом с»: '' / null — снять; целый год 1940..текущий. { value } или { problem }. */
export function cleanPracticeSince(v, now = new Date()) {
  if (v == null || v === '') return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < PRACTICE_SINCE_MIN || n > yearOf(now)) return { problem: DOCTOR_PUBLIC_MESSAGES.since };
  return { value: n };
}
/** Стаж на сайте — полных лет от года начала работы (растёт сам). */
export function experienceYears(since, now = new Date()) {
  if (since == null || since === '') return null;
  const n = Number(since);
  return Number.isInteger(n) ? Math.max(0, yearOf(now) - n) : null;
}
/** Год, который показывает экран: свой — иначе из прежнего стажа (строка главной старой версии). */
export function shownPracticeSince(profile, now = new Date()) {
  const p = profile || {};
  if (p.practice_since != null && p.practice_since !== '') return Number(p.practice_since);
  if (p.experience_years != null && p.experience_years !== '') return yearOf(now) - Number(p.experience_years);
  return null;
}
/**
 * Стаж и «работает с» — одно значение в двух колонках: прежний стаж
 * (users.experience_years — его читают филиалы старой версии и прежние экраны)
 * пишется вместе с годом. Пришёл год — стаж из него; пришёл только стаж
 * (экран старой версии) — год из стажа.
 */
export function withExperience(values, now = new Date()) {
  const out = { ...values };
  if ('practice_since' in out) out.experience_years = experienceYears(out.practice_since, now);
  else if ('experience_years' in out) out.practice_since = out.experience_years == null ? null : yearOf(now) - Number(out.experience_years);
  return out;
}

/** Заполненность — семь проверок макета (completeness): ФИО ×3, специальность, биография ×3. */
const MISS = Object.freeze({
  full_name_ru: 'ФИО RU', full_name_uz: 'ФИО UZ', full_name_en: 'ФИО EN',
  bio_ru: 'биография RU', bio_uz: 'биография UZ', bio_en: 'биография EN',
});
const SPECIALTY_MISS = 'специальность';
export const COMPLETENESS_LABELS = Object.freeze([...Object.values(MISS), SPECIALTY_MISS]);
export function profileCompleteness(profile, specialtiesCount) {
  const p = profile || {};
  const filled = (k) => String(p[k] == null ? '' : p[k]).trim() !== '';
  const missing = [];
  for (const k of ['full_name_ru', 'full_name_uz', 'full_name_en']) if (!filled(k)) missing.push(MISS[k]);
  if (!(Number(specialtiesCount) > 0)) missing.push(SPECIALTY_MISS);
  for (const k of ['bio_ru', 'bio_uz', 'bio_en']) if (!filled(k)) missing.push(MISS[k]);
  return { pct: Math.round(((7 - missing.length) / 7) * 100), missing };
}

/** Показываемый врач — с ФИО на русском и специальностью. null — можно. */
export function publicationProblem({ is_public, full_name_ru, specialties }) {
  if (!(is_public === true || Number(is_public) === 1)) return null;
  if (!String(full_name_ru == null ? '' : full_name_ru).trim()) return DOCTOR_PUBLIC_MESSAGES.nameRu;
  if (!(Number(specialties) > 0)) return DOCTOR_PUBLIC_MESSAGES.specialty;
  return null;
}

/**
 * Что с показом врача: 'shown' | 'off' | 'branch_hidden' | 'inactive' | 'not_doctor'.
 * Врач — по is_doctor, не по роли и специальности (инвариант проекта).
 * Скрытое здание прячет своих врачей (branchAllowsDoctor, шаг 4). Флаги — и
 * числами из базы, и булевыми из /api/users.
 */
export function doctorPublicState(doctor, branchesById) {
  const d = doctor || {};
  const on = (v) => v === true || Number(v) === 1;
  if (!on(d.is_doctor)) return 'not_doctor';
  if (d.is_active === false || (d.is_active != null && Number(d.is_active) === 0)) return 'inactive';
  if (!on(d.is_public)) return 'off';
  if (!branchAllowsDoctor(d, branchesById)) return 'branch_hidden';
  return 'shown';
}
export const doctorIsPublic = (doctor, branchesById) => doctorPublicState(doctor, branchesById) === 'shown';
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Показ врача на сайте и у партнёров меняет администратор. | Shifokorni saytda va hamkorlarda ko‘rsatishni administrator o‘zgartiradi. | Only the administrator turns showing the doctor on the website and to partners on or off. |
| Чтобы показывать врача, введите ФИО на русском. | Shifokorni ko‘rsatish uchun F.I.Sh.ni rus tilida kiriting. | To show the doctor, enter the full name in Russian. |
| Чтобы показывать врача, выберите специальность. | Shifokorni ko‘rsatish uchun mutaxassislikni tanlang. | To show the doctor, choose a specialty. |
| Нужен хотя бы один язык приёма. | Kamida bitta qabul tili kerak. | At least one consultation language is required. |
| Языки приёма — только русский, узбекский и английский. | Qabul tillari faqat rus, o‘zbek va ingliz tillari bo‘lishi mumkin. | Consultation languages can only be Russian, Uzbek and English. |
| Год начала работы врачом — от 1940 до текущего года. | Shifokorlik boshlangan yil — 1940-yildan joriy yilgacha. | The year the doctor started practising must be between 1940 and the current year. |
| Запись открывается на 7, 14 или 30 дней вперёд. | Yozilish 7, 14 yoki 30 kun oldinga ochiladi. | Booking opens 7, 14 or 30 days ahead. |
| Отметка записана неверно: нужно «да» или «нет». | Belgi noto‘g‘ri yozilgan: «ha» yoki «yo‘q» bo‘lishi kerak. | The flag is recorded incorrectly: it must be “yes” or “no”. |
| ФИО RU | F.I.Sh. RU | Full name RU |
| ФИО UZ | F.I.Sh. UZ | Full name UZ |
| ФИО EN | F.I.Sh. EN | Full name EN |
| специальность | mutaxassislik | specialty |
| биография RU | tarjimai hol RU | biography RU |
| биография UZ | tarjimai hol UZ | biography UZ |
| биография EN | tarjimai hol EN | biography EN |

- [ ] **Step 5:** тест зелёный. Сторожа: `public/js/shared/branch-profile.test.js`, `public/js/admin/__tests__/i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 6: коммит** «Публичный профиль врача: общий модуль — языки, «работает с» и стаж, заполненность, кто виден партнёрам, скрытое здание прячет врача».

---

## Task 4: Общий модуль цены и длины консультации (решение владельца 8) (DOCTOR_PROFILE_V1)

**Files:**
- Create: `public/js/shared/consultation-price.js`, `public/js/shared/consultation-price.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающий тест** `public/js/shared/consultation-price.test.js`:

```js
// DOCTOR_PROFILE_V1 — консультация врача: ведёт ли, по какой цене (решения
// владельца 8 и 13), сколько длится, вид для партнёров. Одно правило на кассу,
// окно записи, CRM, «Повторный визит», карточку и API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSULT_API_KINDS, CONSULT_MINUTES_DEFAULT, CONSULT_MESSAGES,
  consultPrice, consultOffered, consultMinutes, consultNames, consultRowOf, doctorConsultations, consultTypeProblem, prepareConsultTypeSave,
} from './consultation-price.js';
import { STRINGS } from '../admin/i18n-strings.js';

const CT = { id: 5, name: 'Первичный', name_ru: 'Первичный приём', name_uz: 'Dastlabki qabul', price: 100000, active: 1, duration_minutes: 30, api_kind: 'initial', sort_order: 1 };

test('цена: своя — её; «Бесплатно» — 0; 0 — настоящая цена; строка с пустой ценой — 0 (решение 13); строки нет — общая цена вида (решение 8)', () => {
  assert.deepEqual(consultPrice(CT, { price: 150000, is_free: 0 }), { price: 150000, own: true, empty: false });
  assert.deepEqual(consultPrice(CT, { price: 150000, is_free: 1 }), { price: 0, own: true, empty: false });
  assert.deepEqual(consultPrice(CT, { price: null, is_free: 1 }), { price: 0, own: true, empty: false }, '«Бесплатно» — не «цена не введена»');
  assert.deepEqual(consultPrice(CT, { price: '0', is_free: 0 }), { price: 0, own: true, empty: false });
  assert.deepEqual(consultPrice(CT, null), { price: 100000, own: false, empty: false });
  assert.deepEqual(consultPrice(CT, { price: null, is_free: 0 }), { price: 0, own: true, empty: true }, 'пустая цена в строке врача — 0, не общая цена вида');
  assert.deepEqual(consultPrice(CT, { price: '', is_free: '0' }), { price: 0, own: true, empty: true });
  assert.deepEqual(consultPrice(CT, { price: 'abc', is_free: 0 }), { price: 0, own: true, empty: true });
  assert.deepEqual(consultPrice({ price: -5 }, null), { price: 0, own: false, empty: false }, 'отрицательной цены не бывает');
  assert.deepEqual(consultPrice(null, { price: 70000 }), { price: 70000, own: true, empty: false });
});

test('ведёт ли: строка — её «Ведёт»; строки нет — врач (is_doctor) ведёт; вид выключен — никто', () => {
  assert.equal(consultOffered(CT, { available: 1 }), true);
  assert.equal(consultOffered(CT, { available: 0 }), false);
  assert.equal(consultOffered(CT, null, { is_doctor: 1 }), true);
  assert.equal(consultOffered(CT, null, { is_doctor: true }), true);
  assert.equal(consultOffered(CT, null, { is_doctor: 0, role: 'doctor' }), false, 'по is_doctor, не по роли');
  assert.equal(consultOffered(CT, null), true, 'врач не назван (кабинет самого врача) — решает строка');
  assert.equal(consultOffered({ ...CT, active: 0 }, { available: 1 }), false);
  assert.equal(consultOffered({ ...CT, active: undefined }, null), true, 'экран не спросил active — вид включён');
  assert.equal(consultOffered(null, { available: 1 }), false);
});

test('длительность: из вида; пусто или вне 5..480 — 30', () => {
  assert.equal(consultMinutes({ duration_minutes: 45 }), 45);
  for (const v of [null, 0, 4, 481, 'x']) assert.equal(consultMinutes({ duration_minutes: v }), CONSULT_MINUTES_DEFAULT, String(v));
  assert.equal(consultMinutes(null), 30);
});

test('название: своё у врача на каждом языке, иначе вида', () => {
  assert.deepEqual(consultNames(CT, { name_ru: 'Приём кардиолога', name_en: ' ' }), { ru: 'Приём кардиолога', uz: 'Dastlabki qabul', en: '' });
  assert.deepEqual(consultNames({ name: 'Старое' }, null), { ru: 'Старое', uz: '', en: '' });
});

test('строка врача по виду: из нескольких — с большим id, как касса (ORDER BY id DESC)', () => {
  const rows = [{ id: 7, doctor_id: 3, consultation_type_id: 5, price: 170000 }, { id: 4, doctor_id: 3, consultation_type_id: 5, price: 150000 },
    { id: 9, doctor_id: 4, consultation_type_id: 5, price: 1 }];
  assert.equal(consultRowOf(rows, 3, 5).price, 170000);
  assert.equal(consultRowOf([...rows].reverse(), 3, 5).price, 170000);
  assert.equal(consultRowOf(rows, 3, 6), null);
});

test('консультации врача — по порядку видов, только те, что ведёт: цена, своя ли, минуты, вид для партнёров', () => {
  const REPEAT = { id: 6, name_ru: 'Повторный приём', name_uz: 'Takroriy qabul', price: 60000, active: 1, api_kind: 'repeat', duration_minutes: 15, sort_order: 2 };
  const OFF = { id: 7, name_ru: 'Онлайн', price: 50000, active: 0, sort_order: 3 };
  const rows = [{ id: 1, doctor_id: 3, consultation_type_id: 5, price: 150000, available: 1, is_free: 0 }];
  assert.deepEqual(doctorConsultations([REPEAT, CT, OFF], rows, { id: 3, is_doctor: 1 }), [
    { consultation_type_id: 5, api_kind: 'initial', name: { ru: 'Первичный приём', uz: 'Dastlabki qabul', en: '' }, price: 150000, own: true, empty: false, minutes: 30 },
    { consultation_type_id: 6, api_kind: 'repeat', name: { ru: 'Повторный приём', uz: 'Takroriy qabul', en: '' }, price: 60000, own: false, empty: false, minutes: 15 },
  ]);
  assert.deepEqual(doctorConsultations([REPEAT, CT], [{ id: 2, doctor_id: 3, consultation_type_id: 5, available: 0 }], { id: 3, is_doctor: 1 })
    .map((c) => c.consultation_type_id), [6], '«Ведёт» снято — нет');
  assert.deepEqual(doctorConsultations([CT], [{ id: 3, doctor_id: 3, consultation_type_id: 5, price: null, available: 1, is_free: 0 }], { id: 3, is_doctor: 1 })
    .map((c) => [c.price, c.own, c.empty]), [[0, true, true]], 'строка с пустой ценой — 0 и «цена не введена» (решение 13)');
});

test('вид консультации перед записью: длительность целым 5..480, вид для партнёров — initial / repeat / пусто', () => {
  assert.equal(consultTypeProblem({ duration_minutes: 45, api_kind: 'initial' }), null);
  assert.equal(consultTypeProblem({ name: 'X' }), null, 'неприсланное не проверяется');
  assert.deepEqual(consultTypeProblem({ duration_minutes: 4 }), { field: 'duration_minutes', message: CONSULT_MESSAGES.minutes });
  assert.deepEqual(consultTypeProblem({ duration_minutes: 30.5 }), { field: 'duration_minutes', message: CONSULT_MESSAGES.minutes });
  assert.deepEqual(consultTypeProblem({ api_kind: 'first' }), { field: 'api_kind', message: CONSULT_MESSAGES.kind });
  assert.equal(consultTypeProblem({ api_kind: '' }), null);
  assert.deepEqual(CONSULT_API_KINDS, ['initial', 'repeat']);
});

test('окно «Виды консультаций»: name_ru — как name; пустая длительность не уходит; «—» снимает вид для партнёров', () => {
  const p = { name: 'Первичный приём', price: 100000, duration_minutes: 0 };
  assert.equal(prepareConsultTypeSave(p), null);
  assert.deepEqual(p, { name: 'Первичный приём', name_ru: 'Первичный приём', price: 100000, api_kind: '' });
  assert.equal(prepareConsultTypeSave({ name: 'Повторный', duration_minutes: 3, api_kind: 'repeat' }), CONSULT_MESSAGES.minutes);
});

test('сообщения переведены на ru / uz / en', () => {
  for (const m of Object.values(CONSULT_MESSAGES)) { const e = STRINGS[m]; assert.ok(e && e.ru && e.uz && e.en, m); }
});
```

- [ ] **Step 2:** `node --test public/js/shared/consultation-price.test.js` → падает (нет модуля).
- [ ] **Step 3: модуль** `public/js/shared/consultation-price.js`:

```js
// DOCTOR_PROFILE_V1 — КОНСУЛЬТАЦИЯ ВРАЧА: ВЕДЁТ ЛИ, ПО КАКОЙ ЦЕНЕ, СКОЛЬКО
// ДЛИТСЯ. Одно правило на кассу (server/services/domain/pricing.js
// consultationFor), окно записи (views/service-picker-modal.js), CRM
// (views/crm.js), «Повторный визит» кабинета (views/service-workspace.js),
// карточку сотрудника (rpc/doctor-public.js) и API (шаг 8).
//
// Решение владельца 8 (2026-10-10): у врача нет строки цены по виду — общая
// цена вида везде; окно записи такую консультацию больше не прячет.
// Решение владельца 13 (2026-10-10): строка врача с пустой ценой (не
// «Бесплатно»; «Консультации врачей» пишут такую строку, когда цену не ввели)
// — 0, как и до шага 5, везде, в том числе партнёрам. Признак empty — чтобы
// карточка сказала «цена не введена». «Бесплатно» — 0; введённый 0 — 0.
//
// «Ведёт ли»: строка врача — её «Ведёт» (available); строки нет — ведёт, если
// это врач (is_doctor), а не любой сотрудник со специальностью. Вид выключен
// (active = 0) — не ведёт никто. Касса цену считает и без «ведёт»: строка
// визита уже есть.
//
// Чистый модуль — без DOM, базы и перевода.
import { isOn } from './flags.js';

export const CONSULT_API_KINDS = Object.freeze(['initial', 'repeat']);
/** Столько окно записи ставило консультации до шага 5 (service-picker-modal.js). */
export const CONSULT_MINUTES_DEFAULT = 30;
export const CONSULT_MINUTES_MIN = 5;
export const CONSULT_MINUTES_MAX = 480;

export const CONSULT_MESSAGES = Object.freeze({
  minutes:   'Длительность приёма — целое число минут от 5 до 480.',
  kind:      'Для партнёров — «Первичный приём», «Повторный приём» или ничего.',
  kindTaken: 'Этот вид для партнёров уже выбран у другой консультации — сначала снимите его там.',
});

const money = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null);

/**
 * Цена консультации врача: { price, own, empty }.
 *   own   — у врача есть строка этого вида (своя цена, «Бесплатно» или пустая);
 *   empty — строка есть, цену не ввели и «Бесплатно» не отметили: это 0 (решение 13).
 * Строки нет — общая цена вида (решение 8).
 */
export function consultPrice(ct, dc) {
  if (dc) {
    if (isOn(dc.is_free)) return { price: 0, own: true, empty: false };
    const own = money(dc.price);
    return { price: own ?? 0, own: true, empty: own === null };
  }
  return { price: money(ct && ct.price) ?? 0, own: false, empty: false };
}

/** Ведёт ли врач этот вид. doctor не передан — решает строка (нет строки — ведёт). */
export function consultOffered(ct, dc, doctor = null) {
  if (!ct) return false;
  if (ct.active !== undefined && ct.active !== null && !isOn(ct.active)) return false;
  if (dc) return isOn(dc.available);
  return !doctor || isOn(doctor.is_doctor);
}

/** Длительность вида, минут; не задана или вне пределов — 30. */
export function consultMinutes(ct) {
  const n = Math.round(Number(ct && ct.duration_minutes));
  return Number.isFinite(n) && n >= CONSULT_MINUTES_MIN && n <= CONSULT_MINUTES_MAX ? n : CONSULT_MINUTES_DEFAULT;
}

/** Название на трёх языках: своё у врача, иначе вида. */
export function consultNames(ct, dc) {
  const pick = (...vs) => { for (const v of vs) { const s = String(v == null ? '' : v).trim(); if (s) return s; } return ''; };
  return {
    ru: pick(dc && dc.name_ru, ct && ct.name_ru, ct && ct.name),
    uz: pick(dc && dc.name_uz, ct && ct.name_uz),
    en: pick(dc && dc.name_en, ct && ct.name_en),
  };
}

/** Строка врача по виду: из нескольких — с большим id (как consultationFor: ORDER BY id DESC); без id — последняя. */
export function consultRowOf(rows, doctorId, typeId) {
  let best = null;
  for (const r of rows || []) {
    if (!r || String(r.doctor_id) !== String(doctorId) || String(r.consultation_type_id) !== String(typeId)) continue;
    if (!best || best.id == null || r.id == null || Number(r.id) > Number(best.id)) best = r;
  }
  return best;
}

/** Консультации, которые врач ведёт, — по порядку видов: цена, своя ли, введена ли, минуты, вид для партнёров. */
export function doctorConsultations(types, rows, doctor) {
  const order = (t) => (t.sort_order == null ? Number.MAX_SAFE_INTEGER : Number(t.sort_order));
  const list = [...(types || [])].sort((a, b) => (order(a) - order(b)) || (Number(a.id) - Number(b.id)));
  const out = [];
  for (const ct of list) {
    const dc = consultRowOf(rows, doctor && doctor.id, ct.id);
    if (!consultOffered(ct, dc, doctor)) continue;
    const p = consultPrice(ct, dc);
    out.push({
      consultation_type_id: Number(ct.id),
      api_kind: CONSULT_API_KINDS.includes(ct.api_kind) ? ct.api_kind : '',
      name: consultNames(ct, dc), price: p.price, own: p.own, empty: p.empty, minutes: consultMinutes(ct),
    });
  }
  return out;
}

/** Вид консультации перед записью (/api/db): только присланное. { field, message } | null. */
export function consultTypeProblem(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(values, k) && values[k] != null;
  if (has('duration_minutes')) {
    const n = Number(values.duration_minutes);
    if (!Number.isInteger(n) || n < CONSULT_MINUTES_MIN || n > CONSULT_MINUTES_MAX) return { field: 'duration_minutes', message: CONSULT_MESSAGES.minutes };
  }
  if (has('api_kind') && values.api_kind !== '' && !CONSULT_API_KINDS.includes(values.api_kind)) return { field: 'api_kind', message: CONSULT_MESSAGES.kind };
  return null;
}

/**
 * Окно «Настройки → Виды консультаций» (settings-hub.js beforeSave): name —
 * русское название, name_ru держится тем же (его читают касса и окно записи);
 * пустая длительность (форма шлёт 0) не уходит — остаётся прежняя; «—» в
 * «Для партнёров» не уходит вовсе — значит снять. Возвращает текст отказа или null.
 */
export function prepareConsultTypeSave(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'name')) payload.name_ru = payload.name;
  if (payload.duration_minutes === 0) delete payload.duration_minutes;
  if (!('api_kind' in payload)) payload.api_kind = '';
  const p = consultTypeProblem(payload);
  return p ? p.message : null;
}
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Длительность приёма — целое число минут от 5 до 480. | Qabul davomiyligi — 5 dan 480 gacha butun daqiqa. | The visit length must be a whole number of minutes from 5 to 480. |
| Для партнёров — «Первичный приём», «Повторный приём» или ничего. | Hamkorlar uchun — «Dastlabki qabul», «Takroriy qabul» yoki hech narsa. | For partners: “Initial appointment”, “Follow-up visit” or nothing. |
| Этот вид для партнёров уже выбран у другой консультации — сначала снимите его там. | Hamkorlar uchun bu tur boshqa konsultatsiyada tanlangan — avval uni o‘sha yerda olib tashlang. | This partner type is already set on another consultation — remove it there first. |

- [ ] **Step 5:** тест зелёный. Сторожа: `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 6: коммит** «Консультации: общее правило — ведёт ли врач, цена (строки нет — общая цена вида, решение владельца 8; пустая цена в строке — 0, решение 13), длительность и вид для партнёров».

---

## Task 5: «Мой профиль» на сервере — языки, «работает с», показываемый врач не теряет ФИО и специальности (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/services/rpc/doctor-profile.js`
- Test: `server/services/rpc/doctor-profile.test.js`

- [ ] **Step 1: падающие тесты** — в конец `doctor-profile.test.js` (в импорт добавить `import { DOCTOR_PUBLIC_MESSAGES } from '../../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1`):

```js
// ===========================================================================
// DOCTOR_PROFILE_V1 (мигр. 243) — языки приёма и «работает врачом с» — часть
// профиля (правят и «Мой профиль», и карточка); показ — не поле профиля;
// показываемый врач не стирает себе ФИО на русском и специальности.
// ===========================================================================
const YEAR = new Date().getFullYear();

test('DOCTOR_PROFILE_V1: в белом списке — языки и «работает с», показа нет', () => {
  for (const k of ['languages', 'practice_since']) assert.ok(PROFILE_KEYS.includes(k), k);
  assert.ok(!PROFILE_KEYS.includes('is_public'));
});

test('DOCTOR_PROFILE_V1: языки приёма — список ru/uz/en в порядке; пустой и чужой — отказ, ничего не записано', () => {
  const db = seed();
  updateMyDoctorProfile(db, { p: { languages: ['uz', 'ru'] } }, doc);
  assert.equal(db.prepare('SELECT languages FROM users WHERE id = 2').get().languages, '["ru","uz"]');
  assert.throws(() => updateMyDoctorProfile(db, { p: { languages: [] } }, doc), (e) => e.status === 400 && e.message === DOCTOR_PUBLIC_MESSAGES.oneLanguage);
  assert.throws(() => updateMyDoctorProfile(db, { p: { languages: ['de'] } }, doc), (e) => e.status === 400 && e.message === DOCTOR_PUBLIC_MESSAGES.languages);
  assert.equal(db.prepare('SELECT languages FROM users WHERE id = 2').get().languages, '["ru","uz"]');
});

test('DOCTOR_PROFILE_V1: «работает с» пишет и стаж; прежний стаж (экран старой версии) пишет и год', () => {
  const db = seed();
  const out = updateMyDoctorProfile(db, { p: { practice_since: YEAR - 9 } }, doc);
  assert.deepEqual(out.saved, ['practice_since'], 'saved — то, что прислано');
  assert.deepEqual({ ...db.prepare('SELECT practice_since, experience_years FROM users WHERE id = 2').get() }, { practice_since: YEAR - 9, experience_years: 9 });
  updateMyDoctorProfile(db, { p: { experience_years: 4 } }, doc);
  assert.deepEqual({ ...db.prepare('SELECT practice_since, experience_years FROM users WHERE id = 2').get() }, { practice_since: YEAR - 4, experience_years: 4 });
  assert.throws(() => updateMyDoctorProfile(db, { p: { practice_since: 1900 } }, doc), (e) => e.status === 400 && e.message === DOCTOR_PUBLIC_MESSAGES.since);
  assert.throws(() => updateMyDoctorProfile(db, { p: { practice_since: YEAR + 1 } }, doc), (e) => e.status === 400);
});

test('DOCTOR_PROFILE_V1: показываемый врач — без пустого ФИО на русском и пустого списка специальностей; скрытому — можно', () => {
  const db = seed();
  updateMyDoctorProfile(db, { p: { full_name_ru: 'Врач Один' }, specialties: ['kardiolog'] }, doc);
  db.prepare('UPDATE users SET is_public = 1 WHERE id = 2').run();
  assert.throws(() => updateMyDoctorProfile(db, { p: { full_name_ru: '' } }, doc), (e) => e.status === 400 && e.message === DOCTOR_PUBLIC_MESSAGES.nameRu);
  assert.throws(() => updateMyDoctorProfile(db, { p: {}, specialties: [] }, doc), (e) => e.status === 400 && e.message === DOCTOR_PUBLIC_MESSAGES.specialty);
  assert.equal(db.prepare('SELECT full_name_ru FROM users WHERE id = 2').get().full_name_ru, 'Врач Один');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_specialties WHERE user_id = 2').get().n, 1);
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: { bio_ru: 'Кардиолог' } }, doc), 'остальное правится как раньше');
  db.prepare('UPDATE users SET is_public = 0 WHERE id = 2').run();
  assert.doesNotThrow(() => updateMyDoctorProfile(db, { p: { full_name_ru: '' } }, doc));
});

test('DOCTOR_PROFILE_V1: показ — не поле профиля: врач сам себя не показывает', () => {
  const db = seed();
  assert.throws(() => updateMyDoctorProfile(db, { p: { is_public: 1 } }, doc), (e) => e.status === 400);
  assert.equal(db.prepare('SELECT is_public FROM users WHERE id = 2').get().is_public, 0);
});
```

- [ ] **Step 2:** `node --test server/services/rpc/doctor-profile.test.js` → новые падают.
- [ ] **Step 3: правка** `server/services/rpc/doctor-profile.js`.
  - Импорт за :37: `import { languagesProblem, normalizeLanguages, readLanguages, cleanPracticeSince, withExperience, publicationProblem } from '../../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1`.
  - Строку `PROFILE_KEYS` (:51) заменить:

```js
// DOCTOR_PROFILE_V1 (мигр. 243) — языки приёма и «работает врачом с» — часть
// профиля: их правят и «Мой профиль», и карточка сотрудника (одно правило).
// Показ врача (is_public) сюда НЕ входит — его меняет только администратор
// (routes/users.js); прислать его в профиле — отказ, как любой чужой ключ.
const PUBLIC_KEYS = ['languages', 'practice_since'];
export const PROFILE_KEYS = Object.freeze([...TEXT_KEYS, ...ENTRY_KEYS, 'experience_years', ...URL_KEYS, ...PUBLIC_KEYS]);
```

  - В `cleanValue`, сразу перед `if (key === 'experience_years') {` (:76):

```js
  // DOCTOR_PROFILE_V1 — языки приёма: список из ru / uz / en, хотя бы один.
  if (key === 'languages') {
    const problem = languagesProblem(v);
    if (problem) throw new RpcError(problem, 400);
    return JSON.stringify(normalizeLanguages(v));
  }
  // DOCTOR_PROFILE_V1 — год «работает врачом с»: целый, 1940..текущий; пусто — снять.
  if (key === 'practice_since') {
    const c = cleanPracticeSince(v);
    if (c.problem) throw new RpcError(c.problem, 400);
    return c.value;
  }
```

  - В `publicProfileOf`, перед `} else if (k === 'experience_years') {` (:207):

```js
    } else if (k === 'languages') {   // DOCTOR_PROFILE_V1 — списком
      out[k] = readLanguages(v);
    } else if (k === 'practice_since') {   // DOCTOR_PROFILE_V1
      out[k] = v == null ? null : Number(v);
```

  - Новая функция за `publicProfileOf`:

```js
// DOCTOR_PROFILE_V1 — сколько специальностей у сотрудника: строки списка, а у
// записанного до списка — одна колонка users.specialty.
export function specialtyCountOf(db, userId) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM user_specialties WHERE user_id = ?').get(userId).n;
  if (n) return n;
  const u = db.prepare('SELECT specialty FROM users WHERE id = ?').get(userId);
  return u && String(u.specialty || '').trim() ? 1 : 0;
}
```

  - В `updateMyDoctorProfile`:
    - :223 — `SELECT id, is_doctor, is_local, is_public, full_name_ru FROM users WHERE id = ?` (хвост `// DOCTOR_PROFILE_V1 — показ и ФИО для проверки ниже`);
    - сразу за `const condRows = …` (:246):

```js
  // DOCTOR_PROFILE_V1 — показываемый врач не стирает себе ФИО на русском и не
  // остаётся без специальностей: показ меняет администратор, а не врач.
  if (Number(me.is_public) === 1) {
    const name = 'full_name_ru' in values ? values.full_name_ru : me.full_name_ru;
    const specCount = specRows ? specRows.length : specialtyCountOf(db, uid);
    const problem = publicationProblem({ is_public: 1, full_name_ru: name, specialties: specCount });
    if (problem) throw new RpcError(problem, 400);
  }
  // DOCTOR_PROFILE_V1 — «работает с» и прежний стаж пишутся вместе; saved — то, что прислано.
  const write = withExperience(values);
```

    - блок записи профиля (:256-261) заменить:

```js
    const writeKeys = Object.keys(write).filter((k) => cols.has(k));   // DOCTOR_PROFILE_V1 — с выведенной парой
    if (writeKeys.length) {
      // Имена колонок — только из белого списка PROFILE_KEYS и проверены по
      // PRAGMA выше: в SQL не попадает ни одного имени от клиента.
      const sql = 'UPDATE users SET ' + writeKeys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?';
      db.prepare(sql).run(...writeKeys.map((k) => write[k]), uid);
    }
```

- [ ] **Step 4:** тесты зелёные. Сторожа: `server/db/migrations/159.test.js`, `server/routes/users.public-profile.test.js`, `server/routes/staff-sync-readonly.test.js`, `server/i18n-server-messages.test.js`, клиентский `public/js/admin/__tests__/doctor-profile-save.test.mjs`.
- [ ] **Step 5: коммит** «Мой профиль: языки приёма и «работает врачом с» хранятся и пишут стаж; показываемый врач не стирает ФИО на русском и специальности; показ — не поле профиля».

---

## Task 6: Карточка сотрудника на сервере — показ только администратором, проверка показываемого, срок записи, счётчик очереди (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/routes/users.js`
- Test: `server/routes/users.public-profile.test.js`

- [ ] **Step 1: падающие тесты** — в конец `users.public-profile.test.js` (в импорт добавить `import { DOCTOR_PUBLIC_MESSAGES } from '../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1`):

```js
// ===========================================================================
// DOCTOR_PROFILE_V1 (мигр. 243) — показ врача на сайте и у партнёров меняет
// только администратор; показываемый — с ФИО на русском и специальностью;
// срок записи — 7/14/30; «работает с» пишет и стаж; карточка всё это отдаёт.
// ===========================================================================
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}
async function loginAs(base, username) {
  const res = await req(base, 'POST', '/api/auth/login', { username, password: 'password1' });
  return res.headers.get('set-cookie').split(';')[0];
}

test('DOCTOR_PROFILE_V1: без ФИО на русском и специальности врача не показать; с ними — показ включается; стереть их у показываемого нельзя', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const patch = (body) => req(base, 'PATCH', '/api/users/' + docId, body, admin);
    let res = await patch({ is_public: true });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.nameRu);
    res = await patch({ is_public: true, public_profile: { full_name_ru: 'Иванов Иван' } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.specialty);
    assert.equal(db.prepare('SELECT is_public FROM users WHERE id = ?').get(docId).is_public, 0, 'отказ ничего не пишет');
    res = await patch({ is_public: true, public_profile: { full_name_ru: 'Иванов Иван' }, specialties: [{ name: 'Кардиолог', slug: 'kardiolog' }] });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).user.is_public, true);
    res = await patch({ public_profile: { full_name_ru: '' } });
    assert.equal(res.status, 400, 'показываемому нельзя стереть ФИО на русском');
    res = await patch({ specialties: [] });
    assert.equal(res.status, 400, 'и все специальности');
    res = await patch({ salary_fixed: 3000000 });
    assert.equal(res.status, 200, 'проверка не держит сохранение оклада');
  } finally { server.close(); db.close(); }
});

test('DOCTOR_PROFILE_V1: показ меняет только администратор — «Сотрудники: Изменение» получает 403; неизменённое проходит', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    db.prepare("INSERT INTO users (username, password_hash, full_name, role, is_doctor) VALUES ('chief', ?, 'Главврач', 'doctor', 1)").run(hashPassword('password1'));
    addGrants(db, 'doctor', { settings: 'view', 'settings.employees': 'edit' });
    const chief = await loginAs(base, 'chief');
    let res = await req(base, 'PATCH', '/api/users/' + docId, { is_public: true }, chief);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.message, DOCTOR_PUBLIC_MESSAGES.adminOnly);
    res = await req(base, 'PATCH', '/api/users/' + docId, { is_public: false, booking_days: 30 }, chief);
    assert.equal(res.status, 200, 'значение не меняется — не отказ; срок записи правит и не администратор');
    assert.equal(db.prepare('SELECT booking_days, is_public FROM users WHERE id = ?').get(docId).booking_days, 30);
  } finally { server.close(); db.close(); }
});

test('DOCTOR_PROFILE_V1: срок записи 7/14/30, отметки — да/нет, языки, «работает с»; карточка отдаёт их', async () => {
  const { db, server, base, docId } = await startServer();
  try {
    const admin = await loginAdmin(base);
    const patch = (body) => req(base, 'PATCH', '/api/users/' + docId, body, admin);
    for (const [body, msg] of [
      [{ booking_days: 10 }, DOCTOR_PUBLIC_MESSAGES.bookingDays], [{ show_queue_count: 1 }, DOCTOR_PUBLIC_MESSAGES.flag],
      [{ is_public: 'да' }, DOCTOR_PUBLIC_MESSAGES.flag], [{ public_profile: { languages: [] } }, DOCTOR_PUBLIC_MESSAGES.oneLanguage],
      [{ public_profile: { practice_since: 1800 } }, DOCTOR_PUBLIC_MESSAGES.since],
    ]) {
      const res = await patch(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.message, msg);
    }
    const year = new Date().getFullYear();
    const res = await patch({ booking_days: 7, show_queue_count: true, public_profile: { practice_since: year - 6, languages: ['uz', 'ru'] } });
    assert.equal(res.status, 200, await res.clone().text());
    const row = db.prepare('SELECT booking_days, show_queue_count, practice_since, experience_years, languages FROM users WHERE id = ?').get(docId);
    assert.deepEqual({ ...row }, { booking_days: 7, show_queue_count: 1, practice_since: year - 6, experience_years: 6, languages: '["ru","uz"]' });
    const list = await (await req(base, 'GET', '/api/users', null, admin)).json();
    const card = list.users.find((u) => u.id === docId);
    assert.deepEqual([card.is_public, card.booking_days, card.show_queue_count], [false, 7, true]);
    assert.deepEqual(card.public_profile.languages, ['ru', 'uz']);
    assert.equal(card.public_profile.practice_since, year - 6);
  } finally { server.close(); db.close(); }
});
```

- [ ] **Step 2:** `node --test server/routes/users.public-profile.test.js` → новые падают.
- [ ] **Step 3: правка** `server/routes/users.js`.
  - Импорт :9 → `import { cleanProfileFields, publicProfileOf, specialtyCountOf } from '../services/rpc/doctor-profile.js';   // DOCTOR_PROFILE_V1 — specialtyCountOf`; за :11 — `import { BOOKING_DAYS, DEFAULT_BOOKING_DAYS, DOCTOR_PUBLIC_MESSAGES, publicationProblem, withExperience } from '../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1`.
  - В `parseEmployeeFields` блок `public_profile` (:121-124) заменить и сразу за ним дописать:

```js
  if (body.public_profile !== undefined) {
    // DOCTOR_PROFILE_V1 — «работает с» и прежний стаж пишутся вместе (withExperience).
    try { Object.assign(fields, withExperience(cleanProfileFields(body.public_profile, ownerId))); }   // CLINIC_API_FIX_V1 — фото только из папки владельца
    catch (e) { return { ok: false, message: e.message }; }
  }

  // DOCTOR_PROFILE_V1 (мигр. 243) — показ врача на сайте и у партнёров, срок
  // записи для партнёров, счётчик живой очереди. Кто вправе менять показ,
  // решает маршрут (только администратор, publicationRefusal); здесь — формат.
  for (const key of ['is_public', 'show_queue_count']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, message: DOCTOR_PUBLIC_MESSAGES.flag };
    fields[key] = body[key] ? 1 : 0;
  }
  if (body.booking_days !== undefined) {
    const n = Number(body.booking_days);
    if (!BOOKING_DAYS.includes(n)) return { ok: false, message: DOCTOR_PUBLIC_MESSAGES.bookingDays };
    fields.booking_days = n;
  }
```

  - В `employeeView` за `public_profile: publicProfileOf(u),` (:396):

```js
    // DOCTOR_PROFILE_V1 (мигр. 243) — показ на сайте и у партнёров, срок записи, счётчик очереди.
    is_public: Number(u.is_public) === 1,
    booking_days: BOOKING_DAYS.includes(Number(u.booking_days)) ? Number(u.booking_days) : DEFAULT_BOOKING_DAYS,
    show_queue_count: Number(u.show_queue_count) === 1,
```

  - Помощник — перед `const ADMIN_DELETE_REFUSAL` (:888):

```js
// DOCTOR_PROFILE_V1 — ПОКАЗ ВРАЧА НА САЙТЕ И У ПАРТНЁРОВ.
//   • меняет только администратор (спецификация, «Правила»): отказ — только
//     если значение МЕНЯЕТСЯ (карточка шлёт неизменённое — не беда);
//   • показываемый врач — с ФИО на русском и хотя бы одной специальностью
//     (макет «Публичный профиль»). Проверяется, когда запрос трогает показ, ФИО
//     на русском или специальности: правка оклада у давнего врача не держится.
// row — строка до правки (null у нового), ef — разобранные поля, specsList —
// присланный список специальностей (undefined — не присылали).
function publicationRefusal(db, actor, row, ef, specsList) {
  const was = !!row && Number(row.is_public) === 1;
  if (ef.is_public !== undefined && (ef.is_public === 1) !== was && !isAdminUser(actor)) {
    return { status: 403, message: DOCTOR_PUBLIC_MESSAGES.adminOnly };
  }
  if (ef.is_public === undefined && !('full_name_ru' in ef) && specsList === undefined) return null;
  const isPublic = ef.is_public !== undefined ? ef.is_public : (was ? 1 : 0);
  const name = 'full_name_ru' in ef ? ef.full_name_ru : (row ? row.full_name_ru : '');
  const specs = specsList !== undefined ? specsList.length : (row ? specialtyCountOf(db, row.id) : 0);
  const problem = publicationProblem({ is_public: isPublic, full_name_ru: name, specialties: specs });
  return problem ? { status: 400, message: problem } : null;
}
```

  - В POST — сразу за `if (specs.list) ef.specialty = primarySpecialtyName(specs.list);` (:661):

```js
    const pubRefusal = publicationRefusal(db, req.user, null, ef, specs.list);   // DOCTOR_PROFILE_V1
    if (pubRefusal) return pubRefusal.status === 403 ? forbid(res, pubRefusal.message) : bad(res, pubRefusal.message);
```

  - В PATCH — сразу за `if (specs.list) ef.specialty = primarySpecialtyName(specs.list);` (:766):

```js
    const pubRefusal = publicationRefusal(db, req.user, user, ef, specs.list);   // DOCTOR_PROFILE_V1
    if (pubRefusal) return pubRefusal.status === 403 ? forbid(res, pubRefusal.message) : bad(res, pubRefusal.message);
```

- [ ] **Step 4:** тесты зелёные. Сторожа: `server/routes/users.test.js`, `users.inpatient.test.js`, `staff-sync-readonly.test.js`, `server/services/admin-rows-grantable.test.js`, `server/i18n-server-messages.test.js`, `server/app-test-hygiene.test.js`.
- [ ] **Step 5: коммит** «Карточка сотрудника: показ врача на сайте и у партнёров меняет только администратор; без ФИО на русском и специальности врача не показать; срок записи, счётчик очереди, языки и «работает с» хранятся».

---

## Task 7: Хранилище — фото врача из карточки сотрудника; в филиале фото врача главного здания — 409 (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/routes/storage.js` (:204-205, :317-324, :343-352)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `server/routes/photo-storage.test.js`

- [ ] **Step 1: падающие тесты** — в конец `photo-storage.test.js`:

```js
// ---------------------------------------------------------------------------
// DOCTOR_PROFILE_V1 — фото врача для партнёров загружают и из карточки
// сотрудника: роль с «Сотрудники: Изменение» (не только «Настройки»). В
// филиале фото врача главного здания — 409 (решение владельца 10): правка
// пропала бы при следующей синхронизации.
// ---------------------------------------------------------------------------
function addGrants(db, role, grants) {
  const row = db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role);
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), ...grants };
  if (row) db.prepare('UPDATE role_permissions SET permissions = ? WHERE role = ?').run(JSON.stringify(perms), role);
  else db.prepare('INSERT INTO role_permissions (role, permissions) VALUES (?, ?)').run(role, JSON.stringify(perms));
}

test('DOCTOR_PROFILE_V1: фото врача из карточки — «Сотрудники: Изменение» может, без права — 403', async () => {
  const s = await setup();
  try {
    let cookie = await login(s.base, 'doc2');
    assert.equal((await put(s.base, cookie, doctorPhoto(s.ids.doc), Buffer.from('X'))).status, 403, 'чужое фото без права');
    addGrants(s.db, 'doctor', { settings: 'view', 'settings.employees': 'edit' });
    cookie = await login(s.base, 'doc2');
    const up = await put(s.base, cookie, doctorPhoto(s.ids.doc, '1757000000001-abc124-portret.jpg'), Buffer.from('JPEG'));
    assert.equal(up.status, 200, JSON.stringify(await up.json().catch(() => ({}))));
  } finally { s.stop(); }
});

test('DOCTOR_PROFILE_V1: фото врача главного здания в филиале не загружается — 409, файла нет', async () => {
  const s = await setup();
  try {
    s.db.prepare('UPDATE users SET is_local = 0 WHERE id = ?').run(s.ids.doc);
    const cookie = await login(s.base, 'boss');
    const p = doctorPhoto(s.ids.doc);
    const res = await put(s.base, cookie, p, Buffer.from('X'));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.message, 'Профиль врача меняется в главном здании.');
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'storage', ...p.split('/'))), 'файл всё же записан');
  } finally { s.stop(); }
});
```

- [ ] **Step 2:** `node --test server/routes/photo-storage.test.js` → новые падают.
- [ ] **Step 3: правка** `server/routes/storage.js`.
  - Текст отказа (:204-205) заменить:

```js
// DOCTOR_PROFILE_V1 — чужое фото ставит и тот, кому выдано изменение «Сотрудников» (карточка сотрудника).
const DOCTOR_PHOTO_DENIED = 'Своё фото врач меняет сам — в «Моём профиле». Чужое ставит администратор или тот, кому выдано изменение «Сотрудников».';
// DOCTOR_PROFILE_V1 — решение владельца 10: тот же ответ, что у профиля врача (routes/users.js, rpc/doctor-profile.js).
const DOCTOR_MAIN_ONLY = 'Профиль врача меняется в главном здании.';
```

  - В `doctorPhotoDenial` последнюю строку (:323) заменить:

```js
    // DOCTOR_PROFILE_V1 — фото для партнёров ставят и из карточки сотрудника:
    // её пишет «Сотрудники: Изменение» (routes/users.js), и путь фото — её поле.
    return canEditSection(db, user, 'settings') || grantAllowsAdminOr(db, user, 'settings.employees', 'edit') ? null : DOCTOR_PHOTO_DENIED;
```

  - В `photoGate` — сразу за `if (!target) return badPath(res);` (:346):

```js
    // DOCTOR_PROFILE_V1 — решение владельца 10: в филиале фото врача главного
    // здания (users.is_local = 0, строка приехала синхронизацией) не меняется —
    // как и весь его профиль (409 в routes/users.js и rpc/doctor-profile.js).
    if (write && target.kind === 'doctor' && db) {
      const row = db.prepare('SELECT is_local FROM users WHERE id = ?').get(target.doctorId);
      if (row && row.is_local === 0) return refuse(res, 409, 'conflict', DOCTOR_MAIN_ONLY);
    }
```

- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Своё фото врач меняет сам — в «Моём профиле». Чужое ставит администратор или тот, кому выдано изменение «Сотрудников». | Shifokor o‘z suratini o‘zi «Mening profilim»da almashtiradi. Boshqasinikini administrator yoki «Xodimlar»ni o‘zgartirish huquqi berilgan xodim qo‘yadi. | A doctor changes their own photo in “My profile”. Someone else’s photo is set by the administrator or by whoever may edit “Employees”. |

- [ ] **Step 5:** тесты зелёные. Сторожа: `server/routes/storage.test.js`, `storage-v3120.test.js`, `logo-storage.test.js`, `server/i18n-server-messages.test.js`.
- [ ] **Step 6: коммит** «Фото врача: загружается и из карточки сотрудника (право «Сотрудники: Изменение»); в филиале фото врача главного здания — только в главном».

---

## Task 8: Синхронизация зданий — показ и профиль врача для партнёров едут с сотрудником (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/services/branch-sync/catalogue.js` (:220)
- Test: `server/services/branch-sync/catalogue.test.js` (в конец)

- [ ] **Step 1: падающий тест** — в конец `catalogue.test.js`:

```js
// ===========================================================================
// DOCTOR_PROFILE_V1 (мигр. 243) — показ врача, языки, «работает с», срок
// записи и счётчик очереди едут с сотрудником: филиал показывает того же
// врача (только для просмотра — решение владельца 10). Главная старше шага 5
// этих ключей не шлёт — местное остаётся.
// ===========================================================================
const DOC_PUBLIC = ['is_public', 'languages', 'practice_since', 'booking_days', 'show_queue_count'];
test('показ врача и его профиль для партнёров приезжают в филиал; главная старой версии их не трогает', () => {
  const main = seedStaff(seedMain(fresh()));
  main.prepare(`UPDATE users SET is_public = 1, languages = '["ru","uz"]', practice_since = 2014, booking_days = 30, show_queue_count = 1
                 WHERE username = 'ivanov'`).run();
  const branch = staffReceiver();
  apply(branch, exportCatalogue(main));
  const pick = () => ({ ...branch.prepare(`SELECT ${DOC_PUBLIC.join(', ')} FROM users WHERE username = 'ivanov'`).get() });
  assert.deepEqual(pick(), { is_public: 1, languages: '["ru","uz"]', practice_since: 2014, booking_days: 30, show_queue_count: 1 });

  branch.prepare("UPDATE users SET booking_days = 7 WHERE username = 'ivanov'").run();
  const old = exportCatalogue(main);
  for (const r of old.users) for (const k of DOC_PUBLIC) delete r[k];
  assert.doesNotThrow(() => apply(branch, old));
  assert.equal(pick().booking_days, 7, 'ключа нет — отправитель старый, местное остаётся');
});
```

- [ ] **Step 2:** `node --test server/services/branch-sync/catalogue.test.js` → новый падает (колонок нет в выгрузке).
- [ ] **Step 3: правка** `catalogue.js` — строку `'experience_years', 'instagram_url', 'telegram_url',` (:220) заменить:

```js
      'experience_years', 'instagram_url', 'telegram_url',
      // DOCTOR_PROFILE_V1 (мигр. 243) — показ врача на сайте и у партнёров,
      // языки приёма, «работает с», срок записи и счётчик очереди: филиал
      // видит того же врача (правит его только главное — решение владельца
      // 10). Главная старше шага 5 этих ключей не шлёт — приём пропускает
      // отсутствующие (present), местное остаётся.
      'is_public', 'languages', 'practice_since', 'booking_days', 'show_queue_count',
```

- [ ] **Step 4:** тест зелёный; «выгрузка отдаёт ровно перечисленные колонки» — зелёный (он сверяет с этим же списком). Сторожа (явными путями): `server/services/branch-sync/sync-e2e.test.js`, `relay.test.js`, `relay-e2e.test.js`, `cross-branch.test.js`, `records-e2e.test.js`, `identity.test.js`; `server/routes/users.public-profile.test.js`; `server/services/report-access.journals.test.js`.
- [ ] **Step 5: коммит** «Синхронизация зданий: показ врача и его профиль для партнёров едут с сотрудником; главная старой версии их не трогает».

---

## Task 9: Касса и движок записи — цена консультации по общему правилу, длительность вида консультации (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/services/domain/pricing.js` (:1-3 импорт, :170-184)
- Modify: `server/services/rpc/calendar.js` (:136-143 импорт, :345-357, :754, :956-958)
- Test: `server/services/rpc/billing.audit-fix.test.js`, `server/services/rpc/calendar.test.js`

- [ ] **Step 1: падающие тесты.**
  - В конец `billing.audit-fix.test.js` (помощники `seed` / `addLine` / `DOC` / `registrar` / `createInvoiceForVisit` — в файле):

```js
// DOCTOR_PROFILE_V1 — решения владельца 8 и 13: касса считает по общему
// правилу (shared/consultation-price.js). Строка врача с пустой ценой
// («Консультации врачей» пишут её, когда цену не ввели) — 0, как и до шага 5;
// вид без строки врача — общая цена вида. Страж: касса так считает и сейчас —
// тест держит правило при переходе кассы на consultPrice.
test('DOCTOR_PROFILE_V1: строка врача с пустой ценой — 0 (решение 13), вид без строки — общая цена (решение 8)', () => {
  const { db, vid } = seed();
  const ct = db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Первичный приём', 100000)").run().lastInsertRowid;
  const ct2 = db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Повторный приём', 60000)").run().lastInsertRowid;
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (?, ?, NULL, 1, 0)').run(DOC, ct);
  const a = addLine(db, vid, { service_id: null, consultation_type_id: ct, doctor_id: DOC, unit_price: 1 });
  const b = addLine(db, vid, { service_id: null, consultation_type_id: ct2, doctor_id: DOC, unit_price: 1 });
  const out = createInvoiceForVisit(db, { visit_id: vid, visit_service_ids: [a, b] }, registrar);
  assert.deepEqual(out.items.map((i) => i.unit_price).sort((x, y) => x - y), [0, 60000], 'пустая цена — 0, а не 100 000; вид без строки — 60 000');
  assert.equal(out.invoice.total_amount, 60000);
});
```

  - В конец `calendar.test.js` (помощники `freshDb` / `DAY` / `at` / `registrar` — в файле):

```js
// DOCTOR_PROFILE_V1 (мигр. 243) — консультация по виду приёма длится столько,
// сколько у вида (по умолчанию 30 — как окно записи ставило её раньше); без
// вида и услуги — прежние 15; явная длительность сильнее.
test('DOCTOR_PROFILE_V1: длительность консультации — из вида приёма', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO consultation_types (id, name, price, duration_minutes) VALUES (5, 'Первичный приём', 100000, 45)").run();
  db.prepare("INSERT INTO consultation_types (id, name, price) VALUES (6, 'Повторный приём', 60000)").run();
  assert.equal(calendarSlots(db, { doctor_id: 7, date: DAY, consultation_type_id: 5 }, registrar).duration_minutes, 45);
  assert.equal(calendarSlots(db, { doctor_id: 7, date: DAY, consultation_type_id: 6 }, registrar).duration_minutes, 30);
  assert.equal(calendarSlots(db, { doctor_id: 7, date: DAY }, registrar).duration_minutes, 15);
  assert.equal(calendarSlots(db, { doctor_id: 7, date: DAY, consultation_type_id: 5, duration_minutes: 20 }, registrar).duration_minutes, 20);
  const out = await calendarBook(db, { patient_id: 3, doctor_id: 7, start: at(10), consultation_type_id: 5 }, registrar);
  assert.equal(out.visit.duration_minutes, 45);
});
```

- [ ] **Step 2:** `node --test server/services/rpc/billing.audit-fix.test.js server/services/rpc/calendar.test.js` → тест длительности падает; тест цены кассы — зелёный уже сейчас (страж решения 13: касса и до шага 5 брала за пустую цену 0). Красный тест цены здесь — значит, кто-то поменял кассу: остановиться и сказать контролёру.
- [ ] **Step 3: правка `pricing.js`.**
  - Импорт за :3: `import { consultPrice } from '../../../public/js/shared/consultation-price.js';   // DOCTOR_PROFILE_V1 — одно правило цены консультации`.
  - В `consultationFor` три строки расчёта цены (`let price;` … `else price = …`) заменить:

```js
  // DOCTOR_PROFILE_V1 — одно правило на кассу, окно записи, CRM, карточку и API
  // (shared/consultation-price.js): своя цена, «Бесплатно» — 0, строка с пустой
  // ценой — 0 (решение владельца 13), строки нет — общая цена вида (решение 8).
  const price = consultPrice(ct, dc).price;
```

  Шапка функции (:162-169, «is_free → 0, пустая → 0») верна и остаётся; в её конец дописать строку `// DOCTOR_PROFILE_V1 — правило вынесено в shared/consultation-price.js (решения владельца 8 и 13).`
- [ ] **Step 4: правка `calendar.js`.**
  - Импорт за :143: `import { consultMinutes } from '../../../public/js/shared/consultation-price.js';   // DOCTOR_PROFILE_V1 — длительность вида консультации`.
  - `resolveDuration` (:344-357) заменить:

```js
/** Длительность записи: явная, иначе из услуги, иначе из вида консультации (DOCTOR_PROFILE_V1), иначе 15. */
function resolveDuration(db, { serviceId, consultationTypeId = null, explicit }) {
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const n = Math.round(Number(explicit));
    if (!Number.isFinite(n) || n < 5) throw new RpcError('Длительность приёма — не меньше 5 минут.', 400);
    if (n > 24 * 60) throw new RpcError('Длительность приёма должна быть меньше суток.', 400);
    return n;
  }
  if (serviceId) {
    const svc = db.prepare('SELECT duration_minutes FROM services WHERE id = ?').get(serviceId);
    return serviceDurationMinutes(svc, DEFAULT_DURATION_MIN);
  }
  // DOCTOR_PROFILE_V1 (мигр. 243) — консультация по виду приёма: длительность
  // вида (по умолчанию 30 — столько окно записи ставило консультации). Раньше
  // здесь было 15 — консультация без услуги длилась как самая короткая услуга.
  if (consultationTypeId) {
    const ct = db.prepare('SELECT duration_minutes FROM consultation_types WHERE id = ?').get(consultationTypeId);
    if (ct) return consultMinutes(ct);
  }
  return DEFAULT_DURATION_MIN;
}
```

  - `calendarSlots`, :754 → две строки:

```js
  const consultationTypeId = optId(a.consultation_type_id, 'consultation_type_id');   // DOCTOR_PROFILE_V1
  const durationMin = resolveDuration(db, { serviceId, consultationTypeId, explicit: a.duration_minutes });
```

  - `calendarBook`, :956-958 → :

```js
  const consultationTypeId = optId(a.consultation_type_id, 'consultation_type_id');   // DOCTOR_PROFILE_V1
  const durationMin = a.duration_minutes === undefined && existing
    ? Math.max(5, Number(existing.duration_minutes) || DEFAULT_DURATION_MIN)
    : resolveDuration(db, { serviceId, consultationTypeId, explicit: a.duration_minutes });
```

  - В шапках `calendarSlots` (:726) и `calendarBook` (:909) в перечне args дописать `consultation_type_id?` с хвостом `// DOCTOR_PROFILE_V1`.
- [ ] **Step 5:** тесты зелёные. Сторожа: `server/services/domain/pricing.test.js`, `server/services/rpc/billing.final-money.test.js`, `cashier.test.js`, `cashier-unbilled.test.js`, `calendar-cross-branch.test.js`, `slot-engine.test.js` (если есть: `ls server/services/rpc | grep slot`), `server/routes/crm-calendar-mirror.test.js`.
- [ ] **Step 6: коммит** «Касса: цена консультации — по общему правилу (строки нет — общая цена вида, решение владельца 8; пустая цена в строке — 0, решение 13); запись по виду консультации длится столько, сколько у вида».

---

## Task 10: «Виды консультаций» — длительность, вид для партнёров, названия на трёх языках; «Консультации врачей» говорят, что пустая цена — 0 (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/routes/db.js` (импорт рядом с :11; вызов — сразу за блоком `branchFormat` :389-390; помощники — за `branchFormatRefusal` :762-771)
- Create: `server/routes/consultation-types-guard.test.js`
- Modify: `public/js/admin/views/settings-hub.js` (импорт; `LOOKUP_CONFIG.consultation_types` :651-658)
- Modify: `public/js/admin/views/consultation-types.js` (:16, :426-427)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/consultation-flags.test.mjs`

> Шаг 7 правит в `settings-hub.js` строку плитки «API» (:280), `api_tokens` (~:595) и заголовки окна справочника (~:1450) — не эти места. В `routes/db.js` шаг 7 вставляет свою проверку за `profileRefusal`; шаг 5 — за `branchFormat` шага 4.

- [ ] **Step 1: падающие тесты.**
  - `server/routes/consultation-types-guard.test.js`:

```js
// DOCTOR_PROFILE_V1 — «Виды консультаций» через /api/db: длительность 5..480
// минут, «для партнёров» — initial / repeat / пусто, и одно значение — у одного
// вида. Отказ называет поле.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { CONSULT_MESSAGES } from '../../public/js/shared/consultation-price.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
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

test('длительность и вид для партнёров проверяются; одно значение — у одного вида; свой — не занят', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const a = t.db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Первичный приём', 100000)").run().lastInsertRowid;
    const b = t.db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Повторный приём', 60000)").run().lastInsertRowid;
    const upd = (id, values) => post(t.base, cookie, { table: 'consultation_types', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
    let res = await upd(a, { duration_minutes: 4 });
    assert.equal(res.status, 400);
    let j = await res.json();
    assert.deepEqual([j.error.field, j.error.message], ['duration_minutes', CONSULT_MESSAGES.minutes]);
    res = await upd(a, { api_kind: 'first' });
    assert.equal(res.status, 400);
    res = await upd(a, { duration_minutes: 45, api_kind: 'initial' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    res = await upd(b, { api_kind: 'initial' });
    assert.equal(res.status, 409);
    j = await res.json();
    assert.deepEqual([j.error.field, j.error.message], ['api_kind', CONSULT_MESSAGES.kindTaken]);
    res = await upd(a, { api_kind: 'initial', name_en: 'Initial visit' });
    assert.equal(res.status, 200, 'свой же вид — не занят');
    res = await post(t.base, cookie, { table: 'consultation_types', op: 'insert', values: { name: 'Ещё первичный', api_kind: 'initial' } });
    assert.equal(res.status, 409, 'вставка проверяется так же');
    res = await upd(b, { api_kind: 'repeat' });
    assert.equal(res.status, 200);
    assert.deepEqual(t.db.prepare('SELECT api_kind FROM consultation_types WHERE id IN (?, ?) ORDER BY id').all(a, b).map((r) => r.api_kind), ['initial', 'repeat']);
  } finally { t.stop(); }
});
```

  - В конец `consultation-flags.test.mjs` (помощники `openDoctorDialog` / `seedPrices` — в файле):

```js
// ─── DOCTOR_PROFILE_V1 — «Виды консультаций» и «Консультации врачей» ─────────
test('DOCTOR_PROFILE_V1: «Консультации врачей» — пустая цена подсказывает 0; подпись говорит, что пустая цена и «Бесплатно» — 0 (решение владельца 13)', async () => {
    seedPrices();
    const { row, dlg } = await openDoctorDialog();
    assert.equal(row('Повторный приём').price.getAttribute('placeholder'), '0', 'подсказка — то, что возьмёт касса, а не общая цена вида');
    assert.ok(dlg.textContent.includes('Пустая цена — 0, как и «Бесплатно»'), dlg.textContent.slice(-400));
    assert.ok(dlg.textContent.includes('Общая цена вида — только у врача, которого здесь ещё не сохраняли.'), dlg.textContent.slice(-400));
});

test('DOCTOR_PROFILE_V1: «Виды консультаций» правят названия RU/UZ/EN, длительность и вид для партнёров', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../views/settings-hub.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('    consultation_types: {'), src.indexOf('    // ---- Управление персоналом'));
    for (const k of ["key: 'name_uz'", "key: 'name_en'", "key: 'duration_minutes'", "key: 'api_kind'"]) assert.ok(block.includes(k), k);
    assert.match(block, /beforeSave: \(p\) => prepareConsultTypeSave\(p\)/);
});
```

- [ ] **Step 2:** `node --test server/routes/consultation-types-guard.test.js` и `node --experimental-vm-modules --test public/js/admin/__tests__/consultation-flags.test.mjs` → новые падают.
- [ ] **Step 3: правка `routes/db.js`.**
  - Импорт рядом с :11: `import { CONSULT_API_KINDS, CONSULT_MESSAGES, consultTypeProblem } from '../../public/js/shared/consultation-price.js';   // DOCTOR_PROFILE_V1`.
  - Сразу за строкой `if (branchFormat) return res.status(400)…` (:390):

```js
    // DOCTOR_PROFILE_V1 — «Виды консультаций»: длительность приёма и вид для
    // партнёров — те же правила, что у экрана (shared/consultation-price.js);
    // одно значение «для партнёров» — у одного вида (UNIQUE мигр. 243 — запасной замок).
    const consultFormat = consultTypeFormatRefusal(compiled.meta, req.body);
    if (consultFormat) return res.status(400).json({ error: { code: 'bad_request', message: consultFormat.message, field: consultFormat.field } });
    const consultKind = consultKindRefusal(db, compiled.meta, req.body);
    if (consultKind) return res.status(409).json({ error: { code: 'conflict', message: consultKind, field: 'api_kind' } });
```

  - Помощники — за `branchFormatRefusal`:

```js
// DOCTOR_PROFILE_V1 — см. вызов в POST. null — запись можно выполнять.
function consultTypeFormatRefusal(meta, body) {
  if (!meta || meta.table !== 'consultation_types' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  for (const row of Array.isArray(v) ? v : [v]) {
    const p = consultTypeProblem(row);
    if (p) return p;
  }
  return null;
}
function consultKindRefusal(db, meta, body) {
  if (!meta || meta.table !== 'consultation_types' || !['insert', 'update', 'upsert'].includes(meta.op)) return null;
  const v = body && body.values;
  const kinds = (Array.isArray(v) ? v : [v]).map((r) => r && r.api_kind).filter((k) => CONSULT_API_KINDS.includes(k));
  if (!kinds.length) return null;
  if (new Set(kinds).size !== kinds.length) return CONSULT_MESSAGES.kindTaken;
  const f = body && Array.isArray(body.filters) ? body.filters : [];
  const self = f.length === 1 && f[0] && f[0].col === 'id' && f[0].op === 'eq' ? Number(f[0].val) : null;
  if (meta.op !== 'insert' && self == null) return CONSULT_MESSAGES.kindTaken;   // один вид «для партнёров» не ставят пачке строк
  for (const k of kinds) {
    if (db.prepare('SELECT 1 FROM consultation_types WHERE api_kind = ? AND id <> ?').get(k, self == null ? -1 : self)) return CONSULT_MESSAGES.kindTaken;
  }
  return null;
}
```

- [ ] **Step 4: правка `settings-hub.js`.**
  - Импорт рядом с :46: `import { prepareConsultTypeSave } from '../../shared/consultation-price.js';   // DOCTOR_PROFILE_V1`.
  - `LOOKUP_CONFIG.consultation_types` (:651-658) заменить:

```js
    consultation_types: {
        table: 'consultation_types', title: 'Виды консультаций', icon: 'Flask',
        // DOCTOR_PROFILE_V1 (мигр. 243) — названия на трёх языках (наружу),
        // длительность приёма вида (её берут окно записи и движок, 30 — как
        // раньше) и вид для партнёров (initial / repeat — /slots API, шаг 8).
        // name — русское; name_ru, которое читают касса и окно записи, держится
        // тем же (prepareConsultTypeSave). «—» в «Для партнёров» — снять.
        columns: [{ key: 'name', label: 'Название' }, { key: 'price', label: 'Цена' }, { key: 'duration_minutes', label: 'Длительность, мин' }],
        fields: [
            { key: 'name', label: 'Название (RU)', type: 'text', required: true },
            { key: 'name_uz', label: 'Название (UZ)', type: 'text' },
            { key: 'name_en', label: 'Название (EN)', type: 'text' },
            { key: 'price', label: 'Цена', type: 'number' },
            { key: 'duration_minutes', label: 'Длительность, мин', type: 'number' },
            { key: 'api_kind', label: 'Для партнёров', type: 'select', options: [['initial', 'Первичный приём'], ['repeat', 'Повторный приём']] },
        ],
        beforeSave: (p) => prepareConsultTypeSave(p),
    },
```

- [ ] **Step 5: правка `consultation-types.js`** (окно цен врача).
  - :340 `placeholder: '0'` **не трогать**: пустая цена — 0 (решение владельца 13), подсказка показывает ровно то, что возьмёт касса.
  - Подпись :426-427 (`'Цена и название — для этого врача. «Free» = бесплатно. Пустое название = название типа.'`) заменить текстом `'Цена и название — для этого врача. Пустая цена — 0, как и «Бесплатно»: касса, окно записи и партнёры возьмут 0, поэтому впишите цену. Общая цена вида — только у врача, которого здесь ещё не сохраняли. Пустое название — название вида.'` с хвостом `// DOCTOR_PROFILE_V1 — решения владельца 8 и 13`. Прежнюю статью словаря (`i18n-strings.js`, «…«Free» = бесплатно…») не удалять — её мог читать кто-то ещё; `grep -rn "«Free» = бесплатно" public/js` после правки → только словарь.
  - Шапку файла (:16, «No row … = defaults») дополнить строкой `// DOCTOR_PROFILE_V1 — строки нет — общая цена вида (решение 8); строка с пустой ценой — 0 (решение 13). «Save» пишет строку на каждый вид — после него общая цена этому врачу не подставляется.`
- [ ] **Step 6: словарь:**

| ru | uz | en |
|---|---|---|
| Для партнёров | Hamkorlar uchun | For partners |
| Цена и название — для этого врача. Пустая цена — 0, как и «Бесплатно»: касса, окно записи и партнёры возьмут 0, поэтому впишите цену. Общая цена вида — только у врача, которого здесь ещё не сохраняли. Пустое название — название вида. | Narx va nom — shu shifokor uchun. Bo‘sh narx — 0, «Bepul» kabi: kassa, yozilish oynasi va hamkorlar 0 oladi, shuning uchun narxni yozing. Turning umumiy narxi — faqat bu yerda hali saqlanmagan shifokorga. Bo‘sh nom — tur nomi. | Price and name are for this doctor. An empty price is 0, the same as “Free”: the cashier, the booking window and partners will charge 0, so type a price. The kind’s general price applies only to a doctor not yet saved here. An empty name means the kind’s name. |

- [ ] **Step 7:** тесты зелёные. Сторожа: `server/db/write-grant.test.js`, `server/i18n-server-messages.test.js`; клиент: `db-query-schema.test.mjs`, `settings-hub-groups.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 8: коммит** «Виды консультаций: длительность приёма, вид для партнёров (первичный / повторный, у каждого — один вид), названия на трёх языках; «Консультации врачей» прямо говорят, что пустая цена — 0, как «Бесплатно» (решение владельца 13)».

---

## Task 11: «Что увидят партнёры» — окна по 15 минут тем же движком, очередь, консультации и услуги врача (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `server/services/rpc/calendar.js` (импорт; новая функция за `resourceWindow` :372)
- Modify: `server/services/rpc/queue.js` (:281-393)
- Create: `server/services/rpc/doctor-public.js`, `server/services/rpc/doctor-public.test.js`
- Modify: `server/services/rpc/index.js` (:48, :292), `server/services/control/gate.js` (:168)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `server/services/rpc/queue-board.v3120.test.js`

> Шаг 7 вставляет в `gate.js` строку за `'lis_proxy_get'` (:52), в `index.js` — импорт за :76 и записи за `lis_proxy_set`. Шаг 5 — в других местах.

- [ ] **Step 1: падающие тесты.**
  - В конец `queue-board.v3120.test.js` (помощники `freshDb` / `visit` / `line` / `DAY` / `REG` — в файле; в импорт добавить `boardGroups, doctorQueueWaiting`):

```js
// DOCTOR_PROFILE_V1 — «сейчас ждут приёма» у врача — та же доска: ждут и ждут
// оплаты (талон есть, не приняты; Р20 плана). Принимаемый, другой
// врач и лаборатория не считаются. Доска экрана не изменилась.
test('DOCTOR_PROFILE_V1: сколько ждут приёма у врача — с той же доски', () => {
  const db = freshDb();
  const a = visit(db, 1, `${DAY}T09:00:00Z`);
  const b = visit(db, 2, `${DAY}T09:05:00Z`);
  const c = visit(db, 3, `${DAY}T09:10:00Z`);
  const d = visit(db, 4, `${DAY}T09:15:00Z`);
  line(db, a, { key: `doc:2:${DAY}`, no: 1, status: 'in_progress' });
  line(db, b, { key: `doc:2:${DAY}`, no: 2, status: 'queued' });
  line(db, c, { key: `doc:2:${DAY}`, no: 3, status: 'added' });
  line(db, d, { svc: 3, doctor: null, key: `lab:${DAY}`, no: 1 });
  assert.equal(doctorQueueWaiting(db, 2, DAY), 2);
  assert.equal(doctorQueueWaiting(db, 99, DAY), 0);
  assert.deepEqual(boardGroups(db, DAY), queueBoard(db, { day: DAY }, REG).groups);
  db.close();
});
```

  - `server/services/rpc/doctor-public.test.js`:

```js
// DOCTOR_PROFILE_V1 — «Что увидят партнёры» карточки врача: окна по 15 минут
// тем же движком, что запись (график, часы здания, занятое), часы приёма по
// дням, очередь, консультации с ценой (решение 8) и услуги-консультации врача
// (решение 12). Ничего не пишет; ворота — «Сотрудники: Просмотр».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { doctorPublicPreview, PREVIEW_DENIED } from './doctor-public.js';
import { doctorDayWindows } from './calendar.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { today } from '../domain/day.js';

const admin = { id: 1, role: 'admin', extra_roles: [] };
const cashier = { id: 2, role: 'cashier', extra_roles: [] };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dayIso, n) => { const [y, m, d] = dayIso.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
function nextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  return d;
}
const WH = JSON.stringify({ mon: { on: true, from: '09:00', to: '10:00' }, tue: { on: true, from: '13:00', to: '14:00' } });

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours, scheduling_mode, booking_days, show_queue_count, service_rates)
              VALUES (7, 'doc', 'x', 'Петров П.П.', 'doctor', 1, ?, 'schedulable', 30, 1, ?)`)
    .run(WH, JSON.stringify([{ service_id: 501, pct: 10 }, { service_id: 502, pct: 10, price: 90000 }, { service_id: 503, pct: 5 }]));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, name_uz, price, type, active, online_booking) VALUES (501, 'Консультация невролога', 'Nevrolog konsultatsiyasi', 120000, 'consultation', 1, 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type, active, online_booking) VALUES (502, 'Повторная консультация невролога', 80000, 'consultation', 1, 0)").run();
  db.prepare("INSERT INTO services (id, name, price, type, active) VALUES (503, 'Общий анализ крови', 45000, 'lab', 1)").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active, duration_minutes, api_kind) VALUES (5, 'Первичный', 'Первичный приём', 100000, 1, 1, 30, 'initial')").run();
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, sort_order, active, duration_minutes, api_kind) VALUES (6, 'Повторный', 'Повторный приём', 60000, 2, 1, 15, 'repeat')").run();
  db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (7, 5, 150000, 1, 0)').run();
  return db;
}

test('день врача сеткой по 15 минут: график и занятое; приём на 30 минут — только где свободны два окна подряд', () => {
  const db = seed();
  const MON = nextMonday();
  db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, duration_minutes, status) VALUES (3, 7, ?, 15, 'scheduled')")
    .run(new Date(MON.getFullYear(), MON.getMonth(), MON.getDate(), 9, 15).toISOString());
  const day = doctorDayWindows(db, { doctorId: 7, dayIso: iso(MON) });
  assert.equal(day.weekday, 'mon');
  assert.deepEqual(day.window, { from: '09:00', to: '10:00' });
  assert.deepEqual(day.windows, [{ start: '09:00', free: true }, { start: '09:15', free: false }, { start: '09:30', free: true }, { start: '09:45', free: true }]);
  const long = doctorDayWindows(db, { doctorId: 7, dayIso: iso(MON), durationMin: 30 });
  assert.deepEqual(long.windows.map((w) => w.free), [false, false, true, false], '09:00 — второе окно занято; 09:45 — выходит за конец дня');
  const wed = doctorDayWindows(db, { doctorId: 7, dayIso: addDays(iso(MON), 2) });
  assert.deepEqual([wed.window, wed.windows], [null, []], 'в среду врач не принимает');
});

test('превью: семь дней с завтрашнего, часы по дням, срок записи, очередь, консультации и услуги-консультации', () => {
  const db = seed();
  const out = doctorPublicPreview(db, { doctor_id: 7 }, admin);
  assert.equal(out.days.length, 7);
  assert.equal(out.days[0].date, addDays(today(db), 1));
  assert.deepEqual([out.scheduling_mode, out.booking_days, out.show_queue_count, out.slot_minutes, out.queue_now], ['schedulable', 30, true, 15, 0]);
  assert.deepEqual(out.hours.mon, ['09:00', '10:00']);
  assert.deepEqual(out.hours.tue, ['13:00', '14:00']);
  assert.equal(out.hours.wed, null);
  assert.deepEqual(out.consultations.map((c) => [c.consultation_type_id, c.price, c.own, c.minutes, c.api_kind]),
    [[5, 150000, true, 30, 'initial'], [6, 60000, false, 15, 'repeat']], 'без своей строки — общая цена (решение 8)');
  assert.equal(out.initial_minutes, 30);
  assert.deepEqual(out.services, [
    { service_id: 501, name: { ru: 'Консультация невролога', uz: 'Nevrolog konsultatsiyasi', en: '' }, price: 120000, own: false, online: true },
    { service_id: 502, name: { ru: 'Повторная консультация невролога', uz: '', en: '' }, price: 90000, own: true, online: false },
  ], 'только группа «Консультации»; своя цена — из «Услуг и ставок»');
});

test('ворота: «Сотрудники: Просмотр» или администратор; кассир — 403; неизвестный врач — 400', () => {
  const db = seed();
  assert.throws(() => doctorPublicPreview(db, { doctor_id: 7 }, cashier), (e) => e.status === 403 && e.message === PREVIEW_DENIED);
  const row = db.prepare("SELECT permissions FROM role_permissions WHERE role = 'cashier'").get();
  const perms = row ? JSON.parse(row.permissions) : { sections: [], levels: {} };
  perms.grants = { ...(perms.grants || {}), settings: 'view', 'settings.employees': 'view' };
  if (row) db.prepare("UPDATE role_permissions SET permissions = ? WHERE role = 'cashier'").run(JSON.stringify(perms));
  else db.prepare("INSERT INTO role_permissions (role, permissions) VALUES ('cashier', ?)").run(JSON.stringify(perms));
  assert.doesNotThrow(() => doctorPublicPreview(db, { doctor_id: 7 }, cashier));
  assert.throws(() => doctorPublicPreview(db, { doctor_id: 999 }, admin), (e) => e.status === 400);
});

test('зарегистрирован и только читает (идёт и при просроченной лицензии)', () => {
  assert.equal(typeof getRpc('doctor_public_preview'), 'function');
  assert.equal(isReadOnlyRpc('doctor_public_preview'), true);
});
```

- [ ] **Step 2:** `node --test server/services/rpc/queue-board.v3120.test.js server/services/rpc/doctor-public.test.js` → новые падают.
- [ ] **Step 3: правка `queue.js`.** `queueBoard` (:281-393) разделить: проверка раздела остаётся в `queueBoard`, подсчёт уходит в `boardGroups`.
  1. Над `export function queueBoard` вставить заголовок новой функции:

```js
// DOCTOR_PROFILE_V1 — доска без проверки раздела: её читают экран «Очередь»
// (queueBoard ниже, с проверкой) и «Что увидят партнёры» карточки врача
// (rpc/doctor-public.js) — одна арифметика очереди.
export function boardGroups(db, day) {
```

  2. Строки :287-390 (`// V3120_FIX (PERF) — ДОСКУ ДВИЖЕТ ДЕНЬ ВИЗИТА…` … `(KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || x.label.localeCompare(y.label, 'ru'));`) перенести сюда дословно, без изменений.
  3. Закрыть функцию: `  return out;` и `}`.
  4. `queueBoard` и новую `doctorQueueWaiting` записать так:

```js
export function queueBoard(db, args, user) {
  if (!canViewSection(db, user, BOARD_KEY)) {
    throw new RpcError('Раздел «Очередь» вам не выдан.', 403);
  }
  const a = args || {};
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(a.day || '')) ? String(a.day) : today(db);
  return { day, groups: boardGroups(db, day) };
}

/**
 * DOCTOR_PROFILE_V1 — сколько ждут приёма у врача в этот день (живая очередь;
 * макет «Сейчас в очереди»): талон в очереди врача есть, ещё не приняты — и
 * ждущие, и ждущие оплаты (Р20 плана шага 5: решено контролёром).
 */
export function doctorQueueWaiting(db, doctorId, day) {
  const key = 'doc:' + Number(doctorId) + ':' + day;
  const g = boardGroups(db, day).find((x) => x.key === key);
  return g ? g.waiting_count + g.unpaid_count : 0;
}
```

  Прежняя строка `return { day, groups: out };` (:392) уходит вместе со старым телом — её заменяет `return { day, groups: boardGroups(db, day) };` выше.
- [ ] **Step 4: правка `calendar.js`.**
  - Импорт за строкой `import { consultMinutes } …` (задача 9): `import { WEEKDAY_KEYS } from './slot-engine.js';   // DOCTOR_PROFILE_V1` и `import { PUBLIC_SLOT_MIN } from '../../../public/js/shared/doctor-public.js';   // DOCTOR_PROFILE_V1 — окно для партнёров`.
  - За `resourceWindow` (:372):

```js
/**
 * DOCTOR_PROFILE_V1 — ОКНА ДЛЯ ПАРТНЁРОВ: день врача сеткой по 15 минут
 * (макет «Что увидят партнёры», документация API /slots). Тот же движок, что
 * calendar_slots: окно врача (график, обед), суженное часами здания
 * (resourceWindow), занятое — его визиты (loadBusy). free — можно ли НАЧАТЬ с
 * этого окна приём длиной durationMin (15 — свободно само окно; 30 — два
 * подряд). Прошедшее сегодня — не свободно. Ничего не пишет; читают превью
 * карточки сотрудника (rpc/doctor-public.js) и, в шаге 8, /slots API.
 */
export function doctorDayWindows(db, { doctorId, dayIso, durationMin = PUBLIC_SLOT_MIN, now = Date.now() }) {
  const midnight = localMidnight(dayIso);
  const dayStartMs = midnight.getTime();
  const dayEndMs = dayStartMs + 24 * 3600 * 1000;
  const out = { date: dayIso, weekday: WEEKDAY_KEYS[midnight.getDay()], window: null, windows: [] };
  const doctor = db.prepare('SELECT id, working_hours, branch_id FROM users WHERE id = ?').get(doctorId);
  if (!doctor) return out;
  const win = resourceWindow(db, { doctor, room: null, dayIso });
  if (!win) return out;
  out.window = { from: formatHhmm(win.from), to: formatHhmm(win.to) };
  const segments = windowSegments(win);
  const clampMin = (ms) => Math.max(0, Math.min(24 * 60, Math.round((ms - dayStartMs) / 60000)));
  const busy = loadBusy(db, { doctorId, roomId: null, fromMs: dayStartMs, toMs: dayEndMs, excludeVisitId: null })
    .map((b) => ({ from: clampMin(b.startMs), to: clampMin(b.endMs) })).filter((b) => b.to > b.from);
  const minStartMin = (now >= dayStartMs && now < dayEndMs) ? minutesOfLocal(now) : null;
  const all = slotStarts({ segments, busy: [], durationMin: PUBLIC_SLOT_MIN, stepMin: PUBLIC_SLOT_MIN });
  const free = new Set(slotStarts({ segments, busy, durationMin, stepMin: PUBLIC_SLOT_MIN, minStartMin }));
  out.windows = all.map((t) => ({ start: formatHhmm(t), free: free.has(t) }));
  return out;
}
```

- [ ] **Step 5: RPC** `server/services/rpc/doctor-public.js`:

```js
// DOCTOR_PROFILE_V1 — «ЧТО УВИДЯТ ПАРТНЁРЫ» для карточки сотрудника (макет
// screen-doctor.js slotPreview, «Цены консультаций»): свободные окна врача на
// семь дней с завтрашнего, часы приёма по дням недели, сколько ждут сейчас,
// консультации с ценами и минутами, услуги-консультации врача из прайса
// (решение владельца 12).
//
// Всё считает то, что будет отдавать API (шаг 8): движок записи
// (calendar.js doctorDayWindows), правило цены консультации
// (shared/consultation-price.js), доска очереди (queue.js), правило цены
// строки услуги (domain/pricing.js doctorPriceFor).
//
// Только чтение (READ_ONLY_RPCS). Ворота — «Сотрудники: Просмотр» или
// администратор, как у списка сотрудников (routes/users.js).
import { grantAllowsAdminOr } from '../grants.js';
import { doctorDayWindows } from './calendar.js';
import { doctorQueueWaiting } from './queue.js';
import { today } from '../domain/day.js';
import { doctorPriceFor } from '../domain/pricing.js';
import { PREVIEW_DAYS, PUBLIC_SLOT_MIN, BOOKING_DAYS, DEFAULT_BOOKING_DAYS } from '../../../public/js/shared/doctor-public.js';
import { doctorConsultations } from '../../../public/js/shared/consultation-price.js';
import { categoryOf } from '../../../public/js/shared/service-categories.js';
import { isOn } from '../../../public/js/shared/flags.js';

export class RpcError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const PREVIEW_DENIED = 'Раздел «Сотрудники» вашей роли не выдан.';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (dayIso, n) => { const [y, m, d] = dayIso.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
function jsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Консультации, которые врач ведёт: по общему правилу (решение владельца 8). */
export function doctorConsultOffer(db, doctorId) {
  const doctor = db.prepare('SELECT id, is_doctor FROM users WHERE id = ?').get(doctorId) || { id: doctorId, is_doctor: 0 };
  const types = db.prepare('SELECT * FROM consultation_types').all();
  const rows = db.prepare('SELECT * FROM doctor_consultation_prices WHERE doctor_id = ? ORDER BY id').all(doctorId);
  return doctorConsultations(types, rows, doctor);
}

/**
 * Решение владельца 12: услуги прайса группы «Консультации», которые врач
 * оказывает (users.service_rates — та же связь, что у кассы, окна записи, CRM и
 * оплаты врача). Цена — своя у врача, иначе каталог; online — показ услуги
 * (services.online_booking).
 */
export function doctorConsultServices(db, doctorId) {
  const u = db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doctorId);
  const ids = [...new Set(jsonArray(u && u.service_rates).map((r) => Number(r && r.service_id)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT id, name, name_uz, name_en, price, type, is_lab, online_booking FROM services
                            WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids);
  return rows.filter((s) => categoryOf(s) === 'Консультации').map((s) => {
    const own = doctorPriceFor(db, Number(doctorId), s.id);
    return {
      service_id: s.id, name: { ru: s.name || '', uz: s.name_uz || '', en: s.name_en || '' },
      price: own != null ? own : Math.max(0, Number(s.price) || 0), own: own != null, online: isOn(s.online_booking),
    };
  });
}

export function doctorPublicPreview(db, args, user) {
  if (!user) throw new RpcError('Нужно войти в систему.', 401);
  if (!grantAllowsAdminOr(db, user, 'settings.employees', 'view')) throw new RpcError(PREVIEW_DENIED, 403);
  const id = Number(args && args.doctor_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Врач не найден.', 400);
  const doc = db.prepare('SELECT id, scheduling_mode, booking_days, show_queue_count FROM users WHERE id = ?').get(id);
  if (!doc) throw new RpcError('Врач не найден.', 400);
  const first = addDays(today(db), 1);
  const days = [];
  const hours = {};
  for (let i = 0; i < PREVIEW_DAYS; i += 1) {
    const day = doctorDayWindows(db, { doctorId: id, dayIso: addDays(first, i) });
    days.push({ date: day.date, weekday: day.weekday, windows: day.windows });
    hours[day.weekday] = day.window ? [day.window.from, day.window.to] : null;
  }
  const consultations = doctorConsultOffer(db, id);
  const initial = consultations.find((c) => c.api_kind === 'initial');
  return {
    doctor_id: id,
    scheduling_mode: doc.scheduling_mode === 'live_queue' ? 'live_queue' : 'schedulable',
    booking_days: BOOKING_DAYS.includes(Number(doc.booking_days)) ? Number(doc.booking_days) : DEFAULT_BOOKING_DAYS,
    show_queue_count: Number(doc.show_queue_count) === 1,
    slot_minutes: PUBLIC_SLOT_MIN,
    days, hours,
    queue_now: doctorQueueWaiting(db, id, today(db)),
    consultations,
    services: doctorConsultServices(db, id),
    initial_minutes: initial ? initial.minutes : null,
  };
}
```

- [ ] **Step 6: подключение.**
  - `index.js`: импорт за :48 — `import { doctorPublicPreview } from './doctor-public.js';   // DOCTOR_PROFILE_V1`; запись — сразу за `branch_hours_impact` (:292):

```js
  // DOCTOR_PROFILE_V1 — «Что увидят партнёры» карточки врача (views/doctor-public-pane.js):
  // окна по 15 минут тем же движком, что запись, часы приёма, очередь, цены
  // консультаций и услуги-консультации. Только чтение (READ_ONLY_RPCS);
  // ворота — «Сотрудники: Просмотр».
  doctor_public_preview:     (db, args, user) => doctorPublicPreview(db, args, user),
```

  - `gate.js`: строку `'calendar_slots', 'calendar_windows',` (:168) дополнить следующей:

```js
  // DOCTOR_PROFILE_V1 — «Что увидят партнёры» карточки врача: окна, часы,
  // очередь, цены. Чистое чтение тем же движком, что calendar_slots.
  'doctor_public_preview',
```

- [ ] **Step 7: словарь:**

| ru | uz | en |
|---|---|---|
| Раздел «Сотрудники» вашей роли не выдан. | Sizning rolingizga «Xodimlar» bo‘limi berilmagan. | Your role has no access to “Employees”. |

- [ ] **Step 8:** тесты зелёные. Сторожа: `server/services/rpc/queue.test.js`, `queue-board.test.js`, `calendar.test.js`, `calendar-cross-branch.test.js`, `index.test.js`, `client-rpc-coverage.test.js`, `branch-hours.test.js`; `server/i18n-server-messages.test.js`; лицензионные: `ls server/services/control | grep -i gate` — тест ворот, если есть.
- [ ] **Step 9: коммит** «Что увидят партнёры: окна врача по 15 минут тем же движком, что запись, часы приёма, очередь, консультации с ценами и услуги-консультации (RPC только для чтения)».

---

## Task 12: Окно записи, CRM и «Повторный визит» — консультация врача без своей строки по общей цене (решение владельца 8) (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/service-picker-modal.js` (импорт; :245-250, :411-414, :462-498)
- Modify: `public/js/admin/views/crm.js` (импорт; :1773, :1781-1792, :2075, :2096-2110)
- Modify: `public/js/admin/views/service-workspace.js` (импорт; :1422-1438)
- Test: `public/js/admin/__tests__/consultation-flags.test.mjs`, `public/js/admin/__tests__/crm-card.test.mjs`

- [ ] **Step 1: падающие тесты.**
  - В конец `consultation-flags.test.mjs`:

```js
// ─── DOCTOR_PROFILE_V1 — решение владельца 8: своей строки нет — общая цена ───
test('DOCTOR_PROFILE_V1: окно записи — врач (is_doctor) без своих строк получает оба вида по общей цене; «Ведёт» снятое по-прежнему прячет', async () => {
    seedPrices();
    DB.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12, 'doc3', 'x', 'Сидоров Сидор', 'doctor', 1)").run();
    DB.prepare("UPDATE users SET role = 'doctor', is_doctor = 1 WHERE id = 12").run();
    try {
        document.body.children = [];
        const picks = [];
        openServicePickerModal({ onPick: (p) => picks.push(p) });
        const box = await until(() => modals().find((m) => m.textContent.includes('Сидоров Сидор') && m.textContent.includes('Повторный приём')));
        assert.ok(box, 'окно записи не открылось');
        const sidorovRows = () => colRows(box, 'Услуги').filter((r) => r.textContent.includes('Сидоров Сидор'));
        await until(() => sidorovRows().length >= 2, 3000);
        const rows = sidorovRows();
        assert.equal(rows.length, 2, 'у врача без строк — оба вида: ' + rows.map((r) => r.textContent).join(' | '));
        assert.match(rows.find((r) => r.textContent.includes('Первичный приём')).textContent, /80\s000/);
        assert.match(rows.find((r) => r.textContent.includes('Повторный приём')).textContent, /60\s000/);
        assert.ok(!colRows(box, 'Услуги').some((r) => r.textContent.includes('Иванов Иван') && r.textContent.includes('Первичный приём')),
            '«Ведёт» снято (available = 0) — вид не предлагается');
        rows.find((r) => r.textContent.includes('Первичный приём')).dispatch('click');
        box.querySelectorAll('button').find((b) => /Готово/.test(b.textContent)).dispatch('click');
        await until(() => picks.length);
        assert.equal(picks[0].service.price, 80000);
        assert.equal(picks[0].service.duration_minutes, 30, 'длительность вида (мигр. 243, по умолчанию 30)');
        assert.equal(picks[0].doctor && picks[0].doctor.id, 12);
    } finally {
        DB.prepare("UPDATE users SET role = 'registrar', is_doctor = 0 WHERE id = 12").run();
    }
});

// DOCTOR_PROFILE_V1 — решение владельца 13: строка врача с пустой ценой — 0, как в
// кассе; общая цена вида — только виду, по которому у врача строки нет.
test('DOCTOR_PROFILE_V1: окно записи — строка врача с пустой ценой — 0 (решение 13), вид без строки — общая цена', async () => {
    seedPrices();
    DB.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (12, 'doc3', 'x', 'Сидоров Сидор', 'doctor', 1)").run();
    DB.prepare("UPDATE users SET role = 'doctor', is_doctor = 1 WHERE id = 12").run();
    DB.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free) VALUES (12, ?, NULL, 1, 0)').run(LED);
    try {
        document.body.children = [];
        const picks = [];
        openServicePickerModal({ onPick: (p) => picks.push(p) });
        const box = await until(() => modals().find((m) => m.textContent.includes('Сидоров Сидор') && m.textContent.includes('Повторный приём')));
        assert.ok(box, 'окно записи не открылось');
        const sidorovRows = () => colRows(box, 'Услуги').filter((r) => r.textContent.includes('Сидоров Сидор'));
        await until(() => sidorovRows().length >= 2, 3000);
        assert.match(sidorovRows().find((r) => r.textContent.includes('Первичный приём')).textContent, /80\s000/, 'вид без строки — общая цена');
        sidorovRows().find((r) => r.textContent.includes('Повторный приём')).dispatch('click');
        box.querySelectorAll('button').find((b) => /Готово/.test(b.textContent)).dispatch('click');
        await until(() => picks.length);
        assert.equal(picks[0].service.price, 0, 'пустая цена в строке врача — 0, а не общие 60 000');
    } finally {
        DB.prepare('DELETE FROM doctor_consultation_prices WHERE doctor_id = 12').run();
        DB.prepare("UPDATE users SET role = 'registrar', is_doctor = 0 WHERE id = 12").run();
    }
});

test('DOCTOR_PROFILE_V1: «Повторный визит» у врача без своих строк — оба вида', async () => {
    seedPrices();
    document.body.children = [];
    const container = new El('div');
    const ctx = { container, visitServiceId: 902, visitId: 1902, patient: { id: 77, lastName: 'Пациент', firstName: 'Тест', mrn: 'P-77', __service: { id: 902, name: 'Приём', doctorId: PETROV, doctorName: 'Петров Пётр' } } };
    WS.activateWorkspace(ctx);
    container.appendChild(WS.soapForm(ctx));
    const btn = container.querySelector('[data-revisit-btn]');
    btn.dispatch('click');
    await btn._pending;
    const dlg = await until(() => modals().pop());
    const values = dlg.querySelectorAll('option').map((o) => o.getAttribute('value'));
    assert.ok(values.includes(String(NOT_LED)) && values.includes(String(LED)), 'своей строки нет — виды ведутся по общей цене: ' + values.join(','));
});
```

  - `crm-card.test.mjs`, тест «цена консультации: из двух строк врача — последняя, пустая — 0, …» (:2209) **не менять**: его `['170000 сум', '0 сум', '130000 сум']` — это и есть решение владельца 13 (строка врача 32 с пустой ценой — «0 сум»). После правки CRM он обязан остаться зелёным.
  - В конец `crm-card.test.mjs`:

```js
// DOCTOR_PROFILE_V1 — решение владельца 8: консультацию ведёт и врач (is_doctor)
// без своей строки цены; врач с «Ведёт» снятым — нет.
test('DOCTOR_PROFILE_V1: окно дат предлагает консультацию и врачу без своей строки, но не тому, у кого «Ведёт» снято', async () => {
  VISITS = [];
  SERVICES = [DOC_SVC];
  const NOROW = { id: 34, full_name: 'Каримов Карим', specialty: 'терапевт', service_rates: null, is_doctor: 1 };
  const OFF = { id: 35, full_name: 'Юсупов Юсуф', specialty: 'терапевт', service_rates: null, is_doctor: 1 };
  DOCTORS = [DOCTOR, NOROW, OFF];
  CONSULTS = [{ id: 5, name: 'Первичный', name_ru: 'Первичный приём', price: 80000 }];
  CONSULT_PRICES = [{ id: 1, doctor_id: 31, consultation_type_id: 5, price: 150000, available: 1, is_free: 0 },
    { id: 2, doctor_id: 35, consultation_type_id: 5, price: null, available: 0, is_free: 0 }];
  const { sheet } = await doctorSheet({ lines: [{ id: 903, service_id: null, consultation_type_id: 5, scheduled_date: '', status: 'pending', doctor_id: null, visit_id: null }] });
  await tick(60);
  const names = doctorSelects(sheet)[0].children.map(textOf).join(' | ');
  assert.ok(/Петров Пётр/.test(names) && /Каримов Карим/.test(names), names);
  assert.ok(!/Юсупов/.test(names), '«Ведёт» снято, а врач предложен: ' + names);
  SERVICES = []; REQ_LINES = []; DOCTORS = []; CONSULTS = []; CONSULT_PRICES = [];
  window.easymed.state.user = null;
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/consultation-flags.test.mjs public/js/admin/__tests__/crm-card.test.mjs` → новые падают (у Сидорова без строк окно записи сейчас ничего не предлагает); прежний тест цен CRM — зелёный.
- [ ] **Step 3: окно записи** (`service-picker-modal.js`).
  - Импорт за :50: `import { consultPrice, consultOffered, consultMinutes } from '../../shared/consultation-price.js';   // DOCTOR_PROFILE_V1`.
  - `consultPriceFor` (:245-250) заменить:

```js
    function consultPriceFor(doctorId, ct) {
        // DOCTOR_PROFILE_V1 — решения владельца 8 и 13: правило кассы (shared/consultation-price.js) —
        // своя цена врача, «Бесплатно» и пустая цена — 0, строки нет — общая цена вида.
        return consultPrice(ct, state.docConsult[doctorId + '|' + ct.id] || null).price;
    }
```

  - Отбор врачей (:412-413): `u.is_doctor === true ||` → `u.is_doctor === true || isOn(u.is_doctor) ||` с хвостом `// DOCTOR_PROFILE_V1 — база отдаёт флаг числом 1`.
  - Запрос видов (:469): колонки `'id, name, name_ru, name_uz, name_en, price, sort_order, active, duration_minutes'`; комментарий над ним (:466-468) → `// DOCTOR_PROFILE_V1 (мигр. 243) — у вида есть английское название и длительность приёма.`
  - Цикл строк консультаций — от `const consultRows = [];` до закрывающей скобки `for (const _k in state.docConsult) { … }` (:481-497) заменить:

```js
            const consultRows = [];
            // DOCTOR_PROFILE_V1 — решение владельца 8: консультация врача без своей
            // строки цены больше не прячется — она по общей цене вида, у каждого
            // врача (is_doctor). Строка с «Ведёт» снятым — прячет, как прежде.
            for (const _ct2 of state.consultationTypes) {
                for (const _doc of state.doctors) {
                    const _dc2 = state.docConsult[_doc.id + '|' + _ct2.id] || null;
                    if (!consultOffered(_ct2, _dc2, _doc)) continue;
                    consultRows.push({
                        id: 'c|' + _doc.id + '|' + _ct2.id,
                        name: consultNameFor(_doc.id, _ct2),
                        price: consultPrice(_ct2, _dc2).price,
                        duration_minutes: consultMinutes(_ct2),   // DOCTOR_PROFILE_V1 — длительность вида (было 30 для всех)
                        __consult: true, consultation_type_id: _ct2.id, __ct: _ct2, core_service_id: null,
                        // CLINIC_API_FIX_V1 — номер врача — тот же, что у врача из базы (_doc.id, число).
                        __consultDoctorId: _doc.id, __consultDocName: _doc.full_name || _doc.name || '',
                    });
                }
            }
```

  Переменные `_ctById` / `_docById` (:479-480) больше не нужны — удалить.
- [ ] **Step 4: CRM** (`crm.js`).
  - Импорт рядом с импортом `isOn`: `import { consultPrice, consultOffered } from '../../shared/consultation-price.js';   // DOCTOR_PROFILE_V1`.
  - Строку `let consultDoctors = new Map(); …` (:1773) удалить.
  - `consultPriceOf` и ветку консультации в `doctorsForService` (:1781-1792) заменить:

```js
        function consultPriceOf(p) {
            // DOCTOR_PROFILE_V1 — правило кассы целиком (shared/consultation-price.js):
            // своя цена, «Бесплатно» и пустая цена — 0 (решение 13), строки нет — общая цена вида (решение 8).
            const dc = p && p.doctor_id != null ? consultRows.get(String(p.doctor_id) + '|' + String(p.consultation_type_id)) : null;
            const ct = consultTypes.find((c) => String(c.id) === String(p && p.consultation_type_id));
            return consultPrice(ct || null, dc || null).price;
        }
        function doctorsForService(svcId, p = null) {
            if (p && p.service_id == null && p.consultation_type_id != null) {
                // DOCTOR_PROFILE_V1 — решение владельца 8: ведёт тот, у кого «Ведёт»
                // отмечено, и врач (is_doctor) без своей строки; «Ведёт» снято — нет.
                const ct = consultTypes.find((c) => String(c.id) === String(p.consultation_type_id)) || { id: p.consultation_type_id };
                const pool = docCatalog.filter((d) => consultOffered(ct, consultRows.get(String(d.id) + '|' + String(p.consultation_type_id)) || null, d));
                return pool.length ? pool : docCatalog;
            }
```

  (дальше функция — как была: `const assigned = docCatalog.filter(…)`).
  - Каталог врачей (:2075): колонки `'id, full_name, specialty, service_rates, scheduling_mode, is_doctor'` с хвостом `// DOCTOR_PROFILE_V1 — кто врач, по is_doctor`.
  - В `consultPricesP` (:2096-2110) удалить строки, собиравшие `m` / `consultDoctors` (`const m = new Map();`, `if (!isOn(r.available)) continue;`, три строки `const k …` / `if (!m.has(k)) …` / `m.get(k).add(…)`, `consultDoctors = m;`); `rows` и `consultRows = rows;` остаются.
- [ ] **Step 5: «Повторный визит»** (`service-workspace.js`).
  - Импорт рядом с импортом `isOn`: `import { consultPrice as consultPriceRule, consultOffered } from '../../shared/consultation-price.js';   // DOCTOR_PROFILE_V1`.
  - Запрос видов (:1427): колонки `'id, name_ru, name_uz, sort_order, active, price'` (хвост `// DOCTOR_PROFILE_V1 — общая цена вида`).
  - Строки `consultTypes = (ctData || []).filter(…)` (:1436) и `const consultPrice = …` (:1439) заменить:

```js
        // DOCTOR_PROFILE_V1 — решение владельца 8: строки нет — вид ведётся по
        // общей цене; «Ведёт» снято — нет (shared/consultation-price.js).
        consultTypes = (ctData || []).filter((ct) => consultOffered(ct, docConsult[ct.id] || null));
```

```js
    const consultPrice = (ct) => consultPriceRule(ct, docConsult[ct.id] || null).price;   // DOCTOR_PROFILE_V1 — правило кассы
```

- [ ] **Step 6:** тесты зелёные. Сторожа: `service-picker-crm.test.mjs`, `service-picker-groups.test.mjs`, `picker-invoice.test.mjs`, `walk-in-booking.test.mjs`, `wizard-booking.test.mjs`, `crm-i18n-leaks-en.test.mjs`, `crm-i18n-leaks-uz.test.mjs`, `db-query-schema.test.mjs`, `rpc-exists.test.mjs`.
- [ ] **Step 7: коммит** «Окно записи, CRM и «Повторный визит»: консультация врача без своей строки цены больше не прячется — по общей цене вида (решение владельца 8); пустая цена в строке — 0, как в кассе (решение 13); длительность — из вида консультации».

---

## Task 13: Карточка — список специальностей: UZ, EN и код рядом; повтор отклоняется (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/employees.js` (`specialtiesField` :722-744; константа у начала файла)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/employees-specialties-save.test.mjs`

- [ ] **Step 1: падающие тесты** — в конец `employees-specialties-save.test.mjs`:

```js
// DOCTOR_PROFILE_V1 — рядом со специальностью — её узбекское и английское
// названия и код справочника (по коду партнёры ищут врача); одна специальность
// дважды не выбирается — отказ у поля, а не молчаливый пропуск сервером.
test('DOCTOR_PROFILE_V1: у выбранной специальности — UZ, EN и код; меняется вместе с выбором', async () => {
  const card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  const names = byClass(card, 'spec-names');
  assert.equal(names.length, 2);
  assert.match(textOf(names[0]), /Kardiolog/);
  assert.match(textOf(names[0]), /Cardiologist/);
  assert.match(textOf(names[0]), /kardiolog/);
  pick(specSelects(card)[1], 'Невролог');
  assert.match(textOf(byClass(card, 'spec-names')[1]), /Nevrolog/, 'названия следуют за выбором');
});

test('DOCTOR_PROFILE_V1: повтор специальности отклоняется у поля и не уходит на сервер', async () => {
  const card = await openCard('dr.cardio');
  await tab(card, 'Должность');
  pick(specSelects(card)[1], 'Кардиолог');
  assert.equal(specSelects(card)[1].value, 'Терапевт', 'повтор встал в список');
  assert.match(textOf(byClass(card, 'spec-err')[0]), /Эта специальность уже выбрана\./);
  await save(card);
  assert.ok(!('specialties' in onlyWrite()), 'отклонённый повтор ушёл на сервер');
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/employees-specialties-save.test.mjs` → новые падают.
- [ ] **Step 3: правка** `employees.js`.
  - Под импортами: `const SPEC_TAKEN = 'Эта специальность уже выбрана.';   // DOCTOR_PROFILE_V1 — макет «Публичный профиль»`.
  - `specialtiesField` (:722-744) заменить:

```js
        function specialtiesField() {
            const list = () => { if (!Array.isArray(emp.specialties)) emp.specialties = []; if (!emp.specialties.length) emp.specialties.push(emp.specialty || ''); return emp.specialties; };
            // CLINIC_API_FIX_V1 — правка НА МЕСТЕ: строки на экране держат этот же
            // массив (`rows` в paint), и новый массив терял вторую правку того же
            // списка и «Добавить специальность» после правки.
            // DOCTOR_PROFILE_V1 — заполненность «Публичного профиля» следит за списком.
            const commit = () => { const rows = list(); rows.forEach((v, i) => { rows[i] = String(v || '').trim(); }); emp.specialty = rows[0] || ''; markDirty({ specialty: emp.specialty, specialties: rows }); if (paneRepaint) paneRepaint(); };
            const box = h('div', { class: 'spec-list' });
            // DOCTOR_PROFILE_V1 — повтор отклоняется у поля (макет «Эта специальность уже выбрана.»).
            const err = h('div', { class: 'cpf-err spec-err', role: 'alert' });
            err.hidden = true;
            const say = (msg) => { err.textContent = msg ? tr(msg) : ''; err.hidden = !msg; };
            // DOCTOR_PROFILE_V1 — рядом с выбранной — её узбекское и английское названия и
            // код справочника: по коду партнёры ищут врача (макет specialtyRows).
            const namesOf = (val) => {
                const canon = SPECIALTY_ROWS.find((r) => r.ru === canonicalSpecialty(val));
                if (!canon) {
                    return h('span', { class: 'spec-names muted' }, String(val || '').trim()
                        ? 'Нет в справочнике — партнёры не найдут врача по ней'
                        : 'Названия на узбекском и английском подставятся из справочника');
                }
                return h('span', { class: 'spec-names' },
                    h('span', null, h('span', { class: 'cpf-lang' }, 'UZ'), ' ', document.createTextNode(canon.uz)),
                    h('span', null, h('span', { class: 'cpf-lang' }, 'EN'), ' ', document.createTextNode(canon.en)),
                    h('code', null, document.createTextNode(canon.slug)));
            };
            const paint = () => {
                clear(box);
                const rows = list();
                rows.forEach((val, i) => {
                    const s2 = h('select', { 'aria-label': i === 0 ? 'Основная специальность' : 'Дополнительная' },
                        ...specialtyOptions(val).map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
                    const names = h('div', { class: 'spec-names-slot' }, namesOf(val));
                    s2.addEventListener('change', () => {
                        const v = String(s2.value || '').trim();
                        if (v && rows.some((x, j) => j !== i && String(x || '').trim() === v)) { s2.value = rows[i] || ''; say(SPEC_TAKEN); return; }
                        say('');
                        rows[i] = s2.value; commit();
                        clear(names); names.appendChild(namesOf(rows[i]));
                    });
                    const rm = i > 0 ? h('button', { type: 'button', class: 'icon-btn sm', title: tr('Убрать'), 'aria-label': tr('Убрать'),
                        onclick: () => { rows.splice(i, 1); commit(); paint(); } }, Icon('X', { size: 14 })) : null;
                    box.appendChild(h('div', { class: 'spec-row' },
                        h('span', { class: 'spec-cap' }, i === 0 ? 'Основная' : 'Дополнительная'), s2, rm, names));
                });
                if (rows.length < MAX_SPEC) box.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm spec-add',
                    onclick: () => { rows.push(''); paint(); } }, Icon('Plus', { size: 14 }), ' ', tr('Добавить специальность')));
                box.appendChild(err);
            };
            paint();
            return field(trf('Специальность (основная — первая, до {n})', { n: MAX_SPEC }), box);
        }
```

  - В `openEditor` рядом с `const profilePatch = {};` (:452): `let paneRepaint = null;   // DOCTOR_PROFILE_V1 — перерисовка заполненности «Публичного профиля» (задача 14)`.
- [ ] **Step 4: стили** — в конец `public/css/admin-views.css`:

```css
/* DOCTOR_PROFILE_V1 — список специальностей карточки: подпись, названия UZ / EN и код справочника. */
.spec-row { flex-wrap: wrap; }
.spec-cap { flex: 0 0 100%; font-size: 12.5px; color: var(--ink-500); }
.spec-names-slot { flex: 0 0 100%; min-width: 0; }
.spec-names { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; font-size: 12.5px; color: var(--ink-600); }
.spec-names code { font-size: 12.5px; color: var(--ink-500); }
.spec-err { margin-top: 4px; }
/* /DOCTOR_PROFILE_V1 — список специальностей */
```

- [ ] **Step 5: словарь:**

| ru | uz | en |
|---|---|---|
| Эта специальность уже выбрана. | Bu mutaxassislik allaqachon tanlangan. | This specialty is already selected. |
| Основная | Asosiy | Primary |
| Дополнительная | Qo‘shimcha | Additional |
| Основная специальность | Asosiy mutaxassislik | Primary specialty |
| Названия на узбекском и английском подставятся из справочника | O‘zbekcha va inglizcha nomlar ma’lumotnomadan olinadi | The Uzbek and English names come from the reference list |
| Нет в справочнике — партнёры не найдут врача по ней | Ma’lumotnomada yo‘q — hamkorlar shifokorni u bo‘yicha topa olmaydi | Not in the reference list — partners will not find the doctor by it |

- [ ] **Step 6:** тесты зелёные. Сторожа: `employees-card-save.test.mjs`, `employees-managed.test.mjs`, `specialty-pickers-sorted.test.mjs`, `employee-editor-save-reenable.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `type-scale.test.mjs`.
- [ ] **Step 7: коммит** «Карточка сотрудника: у специальности — названия на узбекском и английском и код справочника; одну специальность дважды не выбрать».

---

## Task 14: Карточка — «Публичный профиль» по макету: показ, заполненность, фото, ФИО / степень / биография с «нет перевода», «работает с», языки (DOCTOR_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/doctor-public-pane.js`
- Modify: `public/js/admin/views/employees.js` (импорты; `openEditor` :401-463; `profileSection` :633-659 — удалить; раздел профиля :782-783; `save` :946-999; загрузка зданий :303)
- Modify: `public/css/admin-views.css` (в конец), `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/employees-profile-save.test.mjs`

> Блоки «Приём пациентов» (с «Что увидят партнёры»), «Цены консультаций» и «Консультации из прайса» вставляет в этот раздел задача 15 — между биографией и соцсетями.

- [ ] **Step 1: харнесс и падающие тесты** `employees-profile-save.test.mjs`.
  - Строки фикстур и подменённого `fetch` (:83-104) заменить:

```js
const YEAR = new Date().getFullYear();   // DOCTOR_PROFILE_V1
const DOC = person(90, 'dr.karimov', { public_profile: PROFILE, branch_id: 1, scheduling_mode: 'schedulable', is_public: false, booking_days: 14, show_queue_count: false });
// Строка без public_profile (сервер его не прислал) — раздел открывается пустым.
const BARE = person(91, 'dr.bare', {});
// DOCTOR_PROFILE_V1 — показываемый врач без специальности, его филиал скрыт с сайта.
const PUB = person(92, 'dr.pub', { specialty: '', specialties: [], is_public: true, branch_id: 2, public_profile: { ...PROFILE } });
// DOCTOR_PROFILE_V1 — показываемый врач открытого филиала.
const SHOWN = person(93, 'dr.shown', { is_public: true, branch_id: 1, public_profile: { ...PROFILE } });
// DOCTOR_PROFILE_V1 — ответ doctor_public_preview (rpc/doctor-public.js).
const PREVIEW = {
  doctor_id: 90, scheduling_mode: 'schedulable', booking_days: 14, show_queue_count: false, slot_minutes: 15,
  days: [
    { date: '2026-10-12', weekday: 'mon', windows: [{ start: '09:00', free: true }, { start: '09:15', free: false }, { start: '09:30', free: true }] },
    { date: '2026-10-13', weekday: 'tue', windows: [] },
  ],
  hours: { mon: ['09:00', '09:45'], tue: null },
  queue_now: 3,
  consultations: [
    { consultation_type_id: 5, api_kind: 'initial', name: { ru: 'Первичный приём', uz: '', en: '' }, price: 150000, own: true, empty: false, minutes: 30 },
    { consultation_type_id: 6, api_kind: 'repeat', name: { ru: 'Повторный приём', uz: '', en: '' }, price: 0, own: true, empty: false, minutes: 15 },
    { consultation_type_id: 7, api_kind: '', name: { ru: 'Онлайн-консультация', uz: '', en: '' }, price: 120000, own: false, empty: false, minutes: 30 },
    // решение владельца 13 — строка врача с пустой ценой: партнёры получат 0
    { consultation_type_id: 8, api_kind: '', name: { ru: 'Консультация по анализам', uz: '', en: '' }, price: 0, own: true, empty: true, minutes: 20 },
  ],
  services: [{ service_id: 501, name: { ru: 'Консультация невролога', uz: '', en: '' }, price: 120000, own: false, online: true }],
  initial_minutes: 30,
};

const writes = [];
const uploads = [];   // DOCTOR_PROFILE_V1 — файлы фото в хранилище
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || 'GET';
  if (u === '/api/users' && method === 'GET') return { ok: true, json: async () => ({ users: [DOC, BARE, PUB, SHOWN] }) };
  if (u.startsWith('/api/users')) { writes.push({ u, method, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/rpc/doctor_public_preview') return { ok: true, json: async () => ({ data: PREVIEW }) };
  if (u.startsWith('/api/storage/')) { uploads.push(u); return { ok: true, json: async () => ({}) }; }
  if (u === '/api/db') {
    const desc = opts.body ? JSON.parse(opts.body) : {};
    let rows = [];
    if (desc.table === 'branches') rows = [{ id: 1, name: 'Чиланзар', show_public: 1 }, { id: 2, name: 'Юнусабад', show_public: 0 }];
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};
```

  - В `openCard` за `writes.length = 0;` — `uploads.length = 0;`.
  - В `openProfileTab` строку `years: …` (:137) заменить:

```js
    since: tags(card, 'input').find((i) => i.attrs.type === 'number' && i.attrs.min === '1940'),   // DOCTOR_PROFILE_V1 — «Работает врачом с»
    name: Object.fromEntries(['ru', 'uz', 'en'].map((l) => [l, tags(card, 'input').find((i) => String(i.attrs.id || '').startsWith('cpf-dpp-fio-' + l))])),
```

  - Тест «поля профиля трогали, но вернули…»: строки `type(s.years, ''); type(s.years, '12');` → `type(s.since, ''); type(s.since, String(YEAR - 12));`.
  - Тест «стаж изменили — уходит только experience_years числом» заменить:

```js
test('DOCTOR_PROFILE_V1: «работает врачом с» — из прежнего стажа; изменили — уходит practice_since числом; стаж на сайте пересчитан', async () => {
  const s = await openProfileTab('dr.karimov');
  assert.equal(s.since.value, String(YEAR - 12));
  assert.match(textOf(s.card), /Стаж на сайте, лет: 12\./);
  type(s.since, String(YEAR - 13));
  assert.match(textOf(s.card), /Стаж на сайте, лет: 13\./);
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { practice_since: YEAR - 13 });
});
```

  - В конец файла:

```js
// ===========================================================================
// DOCTOR_PROFILE_V1 — «Публичный профиль» по макету: показ, заполненность,
// фото, «нет перевода», языки.
// ===========================================================================
const toastText = () => { const t = document.body.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop(); return t ? t._t : ''; };
const switchOf = (card) => tags(card, 'button').find((b) => b.attrs.role === 'switch');
const langBtn = (card, label) => tags(card, 'button').find((b) => b.className === 'dpp-lang' && textOf(b).trim() === label);

test('DOCTOR_PROFILE_V1: показ — администратор включает, уходит is_public; заполненность называет, чего не хватает', async () => {
  const s = await openProfileTab('dr.karimov');
  const sw = switchOf(s.card);
  assert.equal(sw.attrs['aria-checked'], 'false');
  assert.match(textOf(s.card), /Профиль заполнен на 71%: не хватает — ФИО EN, биография EN\./);
  sw.click();
  assert.equal(sw.attrs['aria-checked'], 'true');
  assert.equal(toastText(), 'Врач будет виден. Пустые переводы партнёры покажут на русском.');
  await save(s.card);
  const body = onlyWrite();
  assert.equal(body.is_public, true);
  assert.ok(!('public_profile' in body), 'показ — не поле профиля');
});

test('DOCTOR_PROFILE_V1: без ФИО на русском врача не показать — «Сначала заполните ФИО», переключатель на месте', async () => {
  const s = await openProfileTab('dr.bare');
  const sw = switchOf(s.card);
  sw.click();
  assert.equal(sw.attrs['aria-checked'], 'false');
  assert.equal(toastText(), 'Сначала заполните ФИО');
});

test('DOCTOR_PROFILE_V1: показываемый без специальности — сохранение держится, ошибка у специальностей', async () => {
  const s = await openProfileTab('dr.pub');
  type(s.bio.en, 'Cardiologist.');
  await save(s.card);
  assert.equal(writes.length, 0, 'ушло на сервер без специальности');
  assert.match(textOf(s.card), /Чтобы показывать врача, выберите специальность\./);
});

test('DOCTOR_PROFILE_V1: ФИО на русском стёрли — «Введите ФИО на русском.», не уходит', async () => {
  const s = await openProfileTab('dr.karimov');
  type(s.name.ru, '');
  await save(s.card);
  assert.equal(writes.length, 0);
  assert.match(textOf(s.card), /Введите ФИО на русском\./);
});

test('DOCTOR_PROFILE_V1: «нет перевода» — у пустых UZ / EN ФИО и биографии; у степени — нет', async () => {
  const s = await openProfileTab('dr.karimov');
  const marks = walk(s.card).filter((n) => n.className === 'cpf-miss' && !n.hidden);
  assert.equal(marks.length, 2, 'ФИО EN и биография EN');
});

test('DOCTOR_PROFILE_V1: языки приёма — уходят списком; последний язык не снимается', async () => {
  const s = await openProfileTab('dr.karimov');
  langBtn(s.card, 'RU').click();
  langBtn(s.card, 'UZ').click();
  langBtn(s.card, 'RU').click();
  langBtn(s.card, 'UZ').click();
  assert.equal(toastText(), 'Нужен хотя бы один язык');
  assert.equal(langBtn(s.card, 'UZ').attrs['aria-pressed'], 'true');
  await save(s.card);
  assert.deepEqual(onlyWrite().public_profile, { languages: ['uz'] });
});

test('DOCTOR_PROFILE_V1: фото из карточки — файл в папку врача, в PATCH — photo_url', async () => {
  const s = await openProfileTab('dr.karimov');
  const file = tags(s.card, 'input').find((i) => i.attrs.type === 'file');
  file.dispatchEvent({ type: 'change', target: { files: [new File(['jpeg'], 'portret.jpg', { type: 'image/jpeg' })] } });
  await flush();
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].startsWith('/api/storage/doctor-photos/doctors/90/'), uploads[0]);
  await save(s.card);
  assert.ok(onlyWrite().public_profile.photo_url.startsWith('/api/storage/doctor-photos/doctors/90/'));
});

test('DOCTOR_PROFILE_V1: филиал врача скрыт с сайта — карточка говорит, что партнёры его не увидят', async () => {
  const s = await openProfileTab('dr.pub');
  assert.match(textOf(s.card), /Филиал врача скрыт с сайта/);
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/employees-profile-save.test.mjs` → новые и изменённые падают.
- [ ] **Step 3: раздел** `public/js/admin/views/doctor-public-pane.js`:

```js
// DOCTOR_PROFILE_V1 — «ПУБЛИЧНЫЙ ПРОФИЛЬ» КАРТОЧКИ СОТРУДНИКА (шаг 5 API
// клиники; макет screen-doctor.js publicPane): как врача видят пациенты на
// сайте клиники, в Symptex и у партнёров.
//
// Раздел рисует и сообщает правки; состояние держит карточка (views/employees.js):
//   • ctx.profile — emp.public_profile; ctx.setProfile(k, v) — правка поля
//     профиля (в PATCH уходят только изменённые — CLINIC_API_FIX_V1);
//   • ctx.emp — is_public, scheduling_mode, booking_days, show_queue_count,
//     branch_id; ctx.setField(patch) — их правка;
//   • ctx.specialtiesNode() — тот же список специальностей, что во «Должности»;
//   • ctx.errors — отказы сохранения по полям (publicPaneProblems), живут
//     между перерисовками раздела.
// Показ меняет только администратор (ctx.isAdmin; сервер — 403, routes/users.js).
// Данные врача и клиники — текстом (createTextNode), не через tr().
import { h, Icon, clear, toast, field } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { uploadFile } from '../storage.js';
import { triGroup, fieldErr } from './company-fields.js';
import { photoRefusal, ALLOWED_PHOTO_EXT } from '../../shared/patient-file-limits.js?v=pph1';
import { downscalePhoto } from '../../shared/photo-downscale.js?v=pph1';
import { DOCTOR_LANGS, PRACTICE_SINCE_MIN, DOCTOR_PUBLIC_MESSAGES, profileCompleteness,
    experienceYears, readLanguages, shownPracticeSince, cleanPracticeSince } from '../../shared/doctor-public.js';
import { branchAllowsDoctor } from '../../shared/branch-profile.js';

const LANG_TAG = Object.freeze({ ru: 'RU', uz: 'UZ', en: 'EN' });
const PHOTO_BUCKET = 'doctor-photos';
let seq = 0;

/** Тексты экрана — ключи словаря. */
export const PANE_MESSAGES = Object.freeze({
    needName:    'Сначала заполните ФИО',
    incomplete:  'Врач будет виден. Пустые переводы партнёры покажут на русском.',
    nameRu:      'Введите ФИО на русском.',
    oneLanguage: 'Нужен хотя бы один язык',
});

/**
 * Что держит сохранение карточки (макет: «Введите ФИО на русском.»,
 * «Чтобы показывать врача, выберите специальность.»):
 *   • ФИО на русском — у показываемого врача; у остальных — только если его
 *     правили и оставили пустым (EMPLOYEE_CARD_SAVE_V1: нетронутое не держит
 *     сохранение оклада);
 *   • специальность — у показываемого врача;
 *   • «работает врачом с» — если правили.
 * Возвращает { поле: сообщение }.
 */
export function publicPaneProblems({ isPublic, profile, profileAtOpen, touched = [], specialtiesCount = 0 }) {
    const p = {};
    const t = new Set(touched);
    const ru = String((profile && profile.full_name_ru) || '').trim();
    const wasRu = String((profileAtOpen && profileAtOpen.full_name_ru) || '').trim();
    if (!ru && (isPublic || (t.has('full_name_ru') && wasRu))) p.full_name_ru = PANE_MESSAGES.nameRu;
    if (isPublic && !(specialtiesCount > 0)) p.specialties = DOCTOR_PUBLIC_MESSAGES.specialty;
    if (t.has('practice_since')) {
        const c = cleanPracticeSince(profile && profile.practice_since);
        if (c.problem) p.practice_since = c.problem;
    }
    return p;
}

function section(title, sub, ...body) {
    return h('section', { class: 'dpp-sec' }, h('h4', null, title), sub ? h('p', { class: 'cpf-hint' }, sub) : null, ...body);
}
function errLine(msg) {
    const e = fieldErr(null);
    if (msg) e.set(msg);
    return e.node;
}

export function doctorPublicPane(ctx) {
    const { emp, profile: pp, isEdit, readOnly, isAdmin, doctorId, errors = {} } = ctx;
    const root = h('div', { class: 'dpp' });

    // ---- показ на сайте и у партнёров (только администратор) ----
    const sw = h('button', { type: 'button', class: 'dpp-switch', role: 'switch', 'aria-label': 'Показывать врача' });
    sw.disabled = !!readOnly || !isAdmin;
    const swSub = h('span', { class: 'cpf-hint' });
    const paintSwitch = () => {
        sw.setAttribute('aria-checked', emp.is_public ? 'true' : 'false');
        const c = profileCompleteness(pp, ctx.specialtiesCount());
        const lead = emp.is_public ? tr('Врач виден пациентам.') : tr('Врач скрыт: партнёры не видят ни профиль, ни свободное время.');
        const fill = c.missing.length
            ? trf('Профиль заполнен на {pct}%: не хватает — {list}.', { pct: c.pct, list: c.missing.map((m) => tr(m)).join(', ') })
            : trf('Профиль заполнен на {pct}%.', { pct: c.pct });
        swSub.textContent = lead + ' ' + fill;
    };
    sw.addEventListener('click', () => {
        if (sw.disabled) return;
        if (!emp.is_public && !String(pp.full_name_ru || '').trim()) { toast(PANE_MESSAGES.needName, 'fail'); return; }
        const on = !emp.is_public;
        ctx.setField({ is_public: on });
        paintSwitch();
        if (on && profileCompleteness(pp, ctx.specialtiesCount()).missing.length) toast(PANE_MESSAGES.incomplete, 'info');
    });
    root.appendChild(h('div', { class: 'dpp-switch-row' }, sw,
        h('div', { class: 'dpp-switch-text' }, h('b', null, 'Показывать врача на сайте и у партнёров'), swSub)));
    if (!readOnly && !isAdmin) root.appendChild(h('p', { class: 'cpf-hint' }, DOCTOR_PUBLIC_MESSAGES.adminOnly));
    if (!branchAllowsDoctor({ branch_id: emp.branch_id }, ctx.branchesById)) {
        root.appendChild(h('p', { class: 'cpf-note dpp-note-warn', role: 'note' }, Icon('Building', { size: 16 }),
            h('span', null, 'Филиал врача скрыт с сайта — врача партнёры не увидят, пока филиал скрыт.')));
    }
    paintSwitch();

    // ---- фото для партнёров ----
    const photo = h('div', { class: 'dpp-photo' });
    const paintPhoto = () => {
        clear(photo);
        if (pp.photo_url) photo.appendChild(h('img', { src: pp.photo_url, alt: '' }));
        else photo.appendChild(document.createTextNode(ctx.initials || ''));
    };
    paintPhoto();
    const fileInp = h('input', { type: 'file', accept: ALLOWED_PHOTO_EXT.join(','), 'aria-label': 'Загрузить фото' });
    fileInp.hidden = true;
    const photoBtn = h('button', { type: 'button', class: 'btn btn-outline btn-sm' }, Icon('Image', { size: 14 }), ' ', 'Загрузить фото');
    photoBtn.disabled = !!readOnly || !isEdit;
    const photoStatus = h('span', { class: 'cpf-hint', role: 'status' });
    photoBtn.addEventListener('click', () => fileInp.click());
    fileInp.addEventListener('change', async (e) => {
        const f = e && e.target && e.target.files && e.target.files[0];
        if (!f || !doctorId) return;
        const small = await downscalePhoto(f);
        const bad = photoRefusal({ name: small.name || f.name, size: small.size });
        if (bad) { toast(trf(bad.template, bad.params), 'fail'); return; }
        photoBtn.disabled = true;
        photoStatus.textContent = tr('Загрузка…');
        try {
            const file = small instanceof File ? small : new File([small], 'photo.jpg', { type: small.type || 'image/jpeg' });
            // Путь — папка ЭТОГО врача (CLINIC_API_FIX_V1: сервер примет фото только оттуда).
            const { path } = await uploadFile(PHOTO_BUCKET, file, 'doctors/' + doctorId + '/');
            const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
            const url = (data && data.publicUrl) || '';
            if (!url) throw new Error(tr('Не удалось загрузить фото'));
            ctx.setProfile('photo_url', url);
            paintPhoto();
            photoStatus.textContent = tr('Фото загружено — сохраните сотрудника.');
        } catch (err) {
            photoStatus.textContent = '';
            toast(trf('Не удалось загрузить фото: {msg}', { msg: tr(String((err && err.message) || err)) }), 'fail');
        } finally {
            photoBtn.disabled = !!readOnly;
        }
    });
    root.appendChild(h('div', { class: 'dpp-photo-row' }, photo,
        h('div', { class: 'dpp-photo-acts' }, h('div', { class: 'dpp-row' }, photoBtn, fileInp),
            h('p', { class: 'cpf-hint' }, isEdit ? 'Портрет на светлом фоне, лицо по центру. JPG или PNG от 600×600 px.' : 'Фото можно загрузить после сохранения сотрудника.'),
            photoStatus)));

    // ---- ФИО, специальности, учёная степень ----
    const fio = triGroup('ФИО', { ru: pp.full_name_ru, uz: pp.full_name_uz, en: pp.full_name_en }, {
        key: 'dpp-fio', markMissing: true, disabled: !!readOnly, max: 200,
        hint: 'Имя на сайте и у партнёров. В документах печатается ФИО из «Личных данных».',
        onInput: (lng, v) => { ctx.setProfile('full_name_' + lng, v); paintSwitch(); },
    });
    if (errors.full_name_ru) fio.inputs.ru.err.set(errors.full_name_ru);
    root.appendChild(fio.node);
    root.appendChild(h('div', { class: 'dpp-block' }, h('p', { class: 'dpp-h5' }, 'Специальности'), ctx.specialtiesNode(),
        errLine(errors.specialties),
        h('p', { class: 'cpf-hint' }, 'Выбор из общего справочника (120 специальностей, встроен в программу). Партнёры получают код специальности и ищут врача по нему: «pediatr» — это «Педиатр», «Pediatr» и «Pediatrician» сразу.')));
    root.appendChild(triGroup('Учёная степень', { ru: pp.academic_title_ru, uz: pp.academic_title_uz, en: pp.academic_title_en }, {
        key: 'dpp-deg', disabled: !!readOnly, max: 200, onInput: (lng, v) => ctx.setProfile('academic_title_' + lng, v),
    }).node);

    // ---- «работает врачом с» и языки приёма ----
    const thisYear = new Date().getFullYear();
    const since = h('input', { type: 'number', min: String(PRACTICE_SINCE_MIN), max: String(thisYear), step: '1', placeholder: '2015', class: 'docprof-in', id: 'dpp-since-' + (++seq) });
    const shown = shownPracticeSince(pp);
    since.value = shown == null ? '' : String(shown);
    since.disabled = !!readOnly;
    const sinceHint = h('p', { class: 'cpf-hint' });
    const paintSince = () => {
        const y = since.value === '' ? null : experienceYears(Number(since.value));
        sinceHint.textContent = y == null ? '' : trf('Стаж на сайте, лет: {n}.', { n: y });
    };
    since.addEventListener('input', () => { ctx.setProfile('practice_since', since.value === '' ? null : Number(since.value)); paintSince(); });
    paintSince();
    const sinceErr = fieldErr(since);
    if (errors.practice_since) sinceErr.set(errors.practice_since);
    const langBox = h('div', { class: 'dpp-langs', role: 'group', 'aria-label': 'Языки приёма' });
    for (const l of DOCTOR_LANGS) {
        const b = h('button', { type: 'button', class: 'dpp-lang', 'aria-pressed': readLanguages(pp.languages).includes(l) ? 'true' : 'false' }, LANG_TAG[l]);
        b.disabled = !!readOnly;
        b.addEventListener('click', () => {
            const cur = readLanguages(pp.languages);
            const on = cur.includes(l);
            if (on && cur.length === 1) { toast(PANE_MESSAGES.oneLanguage, 'fail'); return; }
            ctx.setProfile('languages', DOCTOR_LANGS.filter((x) => (x === l ? !on : cur.includes(x))));
            b.setAttribute('aria-pressed', on ? 'false' : 'true');
        });
        langBox.appendChild(b);
    }
    root.appendChild(h('div', { class: 'dpp-grid2' },
        h('div', { class: 'field' }, h('label', { for: since.getAttribute('id') }, 'Работает врачом с'), since, sinceHint, sinceErr.node),
        h('div', { class: 'field' }, h('span', { class: 'dpp-label' }, 'Языки приёма'), langBox, h('p', { class: 'cpf-hint' }, 'На каких языках врач говорит с пациентом.'))));

    // ---- биография ----
    root.appendChild(triGroup('Биография', { ru: pp.bio_ru, uz: pp.bio_uz, en: pp.bio_en }, {
        key: 'dpp-bio', textarea: true, markMissing: true, disabled: !!readOnly, max: 5000,
        onInput: (lng, v) => { ctx.setProfile('bio_' + lng, v); paintSwitch(); },
    }).node);

    // ---- соцсети и опыт (как было: списки правит врач в «Моём профиле») ----
    const ptxt = (k, ph) => {
        const i = h('input', { type: 'text', class: 'docprof-in', placeholder: ph });
        i.value = pp[k] || '';
        i.disabled = !!readOnly;
        i.addEventListener('input', () => ctx.setProfile(k, i.value));
        return i;
    };
    const LISTS = [['education_entries', 'Образование'], ['experience_entries', 'Опыт работы'],
        ['certifications_entries', 'Сертификаты'], ['prof_dev_entries', 'Повышения квалификаций']];
    const entryLine = (e) => [e && (e.ru || e.title || ''), e && (e.year || [e.year_from, e.year_to].filter(Boolean).join('–'))].filter(Boolean).join(' · ');
    root.appendChild(section('Соцсети, образование и опыт', '',
        h('div', { class: 'dpp-grid2' }, field('Instagram', ptxt('instagram_url', 'https://instagram.com/…')), field('Telegram', ptxt('telegram_url', 'https://t.me/…'))),
        ...LISTS.map(([k, label]) => {
            const list = Array.isArray(pp[k]) ? pp[k] : [];
            return field(label, list.length
                ? h('div', { class: 'dpp-entries' }, ...list.map((e) => h('div', null, document.createTextNode(entryLine(e) || '—'))))
                : h('div', { class: 'cpf-hint' }, 'Пока пусто — врач заполняет в «Моём профиле».'));
        })));

    if (typeof ctx.onRepaint === 'function') ctx.onRepaint(paintSwitch);
    return root;
}
```

- [ ] **Step 4: правка `employees.js`.**
  - Импорты (под :22):

```js
import { doctorPublicPane, publicPaneProblems } from './doctor-public-pane.js';   // DOCTOR_PROFILE_V1 — «Публичный профиль» по макету
import { doctorPublicState, shownPracticeSince } from '../../shared/doctor-public.js';   // DOCTOR_PROFILE_V1
import { isRouteAllowed } from '../permissions.js';   // DOCTOR_PROFILE_V1 — «Изменить в «Консультации врачей»» только тому, кому она открыта
```

  - Состояние `emp`: в значения по умолчанию (:401-413) дописать `is_public: false, booking_days: 14, show_queue_count: false,   // DOCTOR_PROFILE_V1`; в ветку `...(user ? {` (:414-449) — `is_public: !!user.is_public, booking_days: Number(user.booking_days) || 14, show_queue_count: !!user.show_queue_count,   // DOCTOR_PROFILE_V1`.
  - Сразу за `const profileAtOpen = { ...emp.public_profile };` (:458):

```js
    // DOCTOR_PROFILE_V1 — точка отсчёта года «работает с» — то, что раздел покажет
    // (год из прежнего стажа у строки главной старой версии): показанное и
    // не тронутое не уходит.
    profileAtOpen.practice_since = shownPracticeSince(emp.public_profile);
    // DOCTOR_PROFILE_V1 — показ, срок записи и счётчик очереди, с которыми карточка открылась.
    const opened = { is_public: !!emp.is_public, booking_days: Number(emp.booking_days) || 14, show_queue_count: !!emp.show_queue_count };
    const paneErrors = {};   // DOCTOR_PROFILE_V1 — отказы сохранения по полям «Публичного профиля»
    let previewPromise = null;
    // DOCTOR_PROFILE_V1 — «Что увидят партнёры» и цены: один запрос на открытие карточки.
    const loadPreview = () => {
        if (!isEdit) return Promise.resolve(null);
        if (!previewPromise) {
            previewPromise = supabase.rpc('doctor_public_preview', { doctor_id: user.id })
                .then(({ data, error }) => (error || !data || typeof data !== 'object' || Array.isArray(data) ? false : data), () => false);
        }
        return previewPromise;
    };
```

  - `profileSame` (:460): `if (k === 'experience_years')` → `if (k === 'experience_years' || k === 'practice_since')` с хвостом `// DOCTOR_PROFILE_V1 — год тоже числом`.
  - Функцию `profileSection` (:633-659, с комментарием над ней) удалить — её поля переехали в `doctor-public-pane.js`.
  - Раздел профиля в `renderBody` (:782-783) заменить:

```js
        } else if (active === 'profile') {
            // DOCTOR_PROFILE_V1 — раздел макета «Публичный профиль» (views/doctor-public-pane.js).
            body.append(head('Публичный профиль', 'Как врача видят пациенты на сайте клиники, в Symptex и у партнёров. Врач правит это же в «Моём профиле».'),
                doctorPublicPane({
                    emp, profile: emp.public_profile, isEdit, readOnly, isAdmin: acc.admin,
                    doctorId: isEdit ? user.id : null, errors: paneErrors,
                    initials: initials([emp.last_name, emp.first_name].filter(Boolean).join(' ') || emp.username || ''),
                    setProfile: (k, v) => { emp.public_profile[k] = v; profilePatch[k] = v; markDirty({}); },
                    setField: (patch) => markDirty(patch),
                    specialtiesNode: () => specialtiesField(),
                    specialtiesCount: () => (emp.specialties || []).filter((v) => String(v || '').trim()).length,
                    branchesById: new Map(branches.map((b) => [Number(b.id), b])),
                    loadPreview,
                    onRepaint: (fn) => { paneRepaint = fn; },
                    openConsultations: isRouteAllowed('consultation-types') ? () => {
                        close();
                        const nav = typeof window !== 'undefined' && window.easymed && window.easymed.navigate;
                        if (typeof nav === 'function') nav('consultation-types');
                    } : null,
                }));
```

  - В `save()` — сразу за проверкой процентов (`if (acc.money) { … }`, :946-955):

```js
        // DOCTOR_PROFILE_V1 — публичный профиль врача: ФИО на русском и
        // специальность у показываемого, год «работает с» — у поля, до отправки
        // (сервер проверит то же: routes/users.js).
        if (emp.is_doctor) {
            for (const k of Object.keys(paneErrors)) delete paneErrors[k];
            Object.assign(paneErrors, publicPaneProblems({
                isPublic: !!emp.is_public, profile: emp.public_profile, profileAtOpen, touched: Object.keys(profilePatch),
                specialtiesCount: (emp.specialties || []).filter((v) => String(v || '').trim()).length,
            }));
            const firstKey = Object.keys(paneErrors)[0];
            if (firstKey) { active = 'profile'; renderRail(); renderBody(); toast(paneErrors[firstKey], 'fail'); return; }
        }
```

  - Сразу за `if (Object.keys(profileChanged).length) payload.public_profile = profileChanged;` (:999):

```js
        // DOCTOR_PROFILE_V1 — показ, срок записи и счётчик очереди — только
        // изменённое (показ меняет только администратор: у остальных
        // переключатель выключен, сервер ответил бы 403).
        if (!!emp.is_public !== opened.is_public) payload.is_public = !!emp.is_public;
        if (!!emp.show_queue_count !== opened.show_queue_count) payload.show_queue_count = !!emp.show_queue_count;
        if (Number(emp.booking_days) !== opened.booking_days) payload.booking_days = Number(emp.booking_days);
```

  - Загрузка зданий (:303): `select('id, name')` → `select('id, name, show_public')`, хвост `// DOCTOR_PROFILE_V1 — скрытое здание прячет врача (карточка и список)`.

- [ ] **Step 5: стили** — в конец `public/css/admin-views.css`:

```css
/* ===========================================================================
   DOCTOR_PROFILE_V1 — «Публичный профиль» карточки сотрудника
   (views/doctor-public-pane.js, doctor-public-preview.js). Префикс .dpp-.
   Только токены приложения и шкала шрифтов; на ширине телефона — один
   столбец, без прокрутки вбок.
   ========================================================================= */
.dpp { display: grid; gap: 16px; min-width: 0; }
.dpp-switch-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border: 1px solid var(--ink-100); border-radius: 10px; }
.dpp-switch-text { display: grid; gap: 2px; min-width: 0; }
.dpp-switch-text b { font-size: 13.5px; color: var(--ink-900); }
.dpp-switch { position: relative; flex: none; width: 40px; height: 22px; margin-top: 1px; padding: 0; border: 0; border-radius: 999px; background: var(--ink-200); cursor: pointer; }
.dpp-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--white); box-shadow: 0 1px 2px rgba(11, 20, 24, .2); transition: transform var(--dur-1) var(--ease-out); }
.dpp-switch[aria-checked="true"] { background: var(--primary-600); }
.dpp-switch[aria-checked="true"]::after { transform: translateX(18px); }
.dpp-switch:disabled { cursor: default; opacity: .6; }
.dpp-switch:focus-visible, .dpp-lang:focus-visible, .dpp-mode:focus-visible, .dpp-day:focus-visible { outline: 2px solid var(--primary-500); outline-offset: 2px; }
.cpf-note.dpp-note-warn { background: var(--warn-50); color: var(--warn-700); }
.dpp-photo-row { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
.dpp-photo { display: grid; place-items: center; width: 84px; height: 84px; flex: none; border-radius: 50%; overflow: hidden; background: var(--primary-50); color: var(--primary-700); font-size: 24px; font-weight: 600; }
.dpp-photo img { width: 100%; height: 100%; object-fit: cover; }
.dpp-photo-acts { display: grid; gap: 6px; flex: 1 1 220px; min-width: 0; }
.dpp-block { display: grid; gap: 6px; min-width: 0; }
.dpp-h5, .dpp-label { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--ink-900); }
.dpp-grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 12px 16px; }
.dpp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.dpp-langs { display: flex; flex-wrap: wrap; gap: 8px; }
.dpp-lang { min-width: 46px; height: 30px; padding: 0 10px; border: 1px solid var(--ink-200); border-radius: 7px; background: var(--white); color: var(--ink-600); font: 600 12.5px var(--font-sans); cursor: pointer; }
.dpp-lang[aria-pressed="true"] { border-color: var(--primary-600); background: var(--primary-600); color: var(--white); }
.dpp-lang:disabled { cursor: default; opacity: .6; }
.dpp-sec { display: grid; gap: 12px; padding-top: 14px; border-top: 1px solid var(--ink-100); min-width: 0; }
.dpp-sec > h4 { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink-900); }
.dpp-entries { display: grid; gap: 2px; font-size: 13.5px; }
/* /DOCTOR_PROFILE_V1 — «Публичный профиль» (задача 14; приём и превью — задача 15) */
```

- [ ] **Step 6: словарь:**

| ru | uz | en |
|---|---|---|
| Как врача видят пациенты на сайте клиники, в Symptex и у партнёров. Врач правит это же в «Моём профиле». | Bemorlar shifokorni klinika saytida, Symptexda va hamkorlarda shunday ko‘radi. Shifokor buni «Mening profilim»da tahrirlaydi. | How patients see the doctor on the clinic website, in Symptex and at partners. The doctor edits the same in “My profile”. |
| Показывать врача | Shifokorni ko‘rsatish | Show the doctor |
| Показывать врача на сайте и у партнёров | Shifokorni saytda va hamkorlarda ko‘rsatish | Show the doctor on the website and to partners |
| Врач виден пациентам. | Shifokor bemorlarga ko‘rinadi. | Patients can see the doctor. |
| Врач скрыт: партнёры не видят ни профиль, ни свободное время. | Shifokor yashirilgan: hamkorlar na profilni, na bo‘sh vaqtni ko‘radi. | The doctor is hidden: partners see neither the profile nor the free time. |
| Профиль заполнен на {pct}%: не хватает — {list}. | Profil {pct}% to‘ldirilgan: yetishmaydi — {list}. | The profile is {pct}% complete: missing — {list}. |
| Профиль заполнен на {pct}%. | Profil {pct}% to‘ldirilgan. | The profile is {pct}% complete. |
| Сначала заполните ФИО | Avval F.I.Sh.ni to‘ldiring | Fill in the full name first |
| Врач будет виден. Пустые переводы партнёры покажут на русском. | Shifokor ko‘rinadi. Bo‘sh tarjimalar o‘rniga hamkorlar ruscha matnni ko‘rsatadi. | The doctor will be visible. Partners will show Russian where a translation is empty. |
| Филиал врача скрыт с сайта — врача партнёры не увидят, пока филиал скрыт. | Shifokorning filiali saytdan yashirilgan — filial yashirin ekan, hamkorlar shifokorni ko‘rmaydi. | The doctor’s branch is hidden from the website — partners will not see the doctor while the branch is hidden. |
| Загрузить фото | Surat yuklash | Upload a photo |
| Портрет на светлом фоне, лицо по центру. JPG или PNG от 600×600 px. | Och fonda portret, yuz markazda. JPG yoki PNG, 600×600 px dan. | A portrait on a light background, face centred. JPG or PNG, 600×600 px or larger. |
| Фото можно загрузить после сохранения сотрудника. | Suratni xodim saqlangandan keyin yuklash mumkin. | You can upload a photo after saving the employee. |
| Фото загружено — сохраните сотрудника. | Surat yuklandi — xodimni saqlang. | Photo uploaded — save the employee. |
| Имя на сайте и у партнёров. В документах печатается ФИО из «Личных данных». | Saytda va hamkorlardagi ism. Hujjatlarda «Shaxsiy ma’lumotlar»dagi F.I.Sh. chop etiladi. | The name on the website and at partners. Documents print the full name from “Personal details”. |
| Введите ФИО на русском. | F.I.Sh.ni rus tilida kiriting. | Enter the full name in Russian. |
| Выбор из общего справочника (120 специальностей, встроен в программу). Партнёры получают код специальности и ищут врача по нему: «pediatr» — это «Педиатр», «Pediatr» и «Pediatrician» сразу. | Umumiy ma’lumotnomadan tanlanadi (dasturga o‘rnatilgan 120 ta mutaxassislik). Hamkorlar mutaxassislik kodini oladi va shifokorni u bo‘yicha qidiradi: «pediatr» kodi ruscha, o‘zbekcha va inglizcha nomlarni birdaniga qamraydi. | Chosen from the shared reference list (120 specialties built into the program). Partners receive the specialty code and search by it: “pediatr” covers the Russian, Uzbek and English names at once. |
| Работает врачом с | Shifokorlik boshlangan yil | Practising since |
| Стаж на сайте, лет: {n}. | Saytdagi staj, yil: {n}. | Experience shown on the website, years: {n}. |
| Языки приёма | Qabul tillari | Consultation languages |
| На каких языках врач говорит с пациентом. | Shifokor bemor bilan qaysi tillarda gaplashadi. | Which languages the doctor speaks with patients. |
| Нужен хотя бы один язык | Kamida bitta til kerak | At least one language is required |
| Биография | Tarjimai hol | Biography |
| Соцсети, образование и опыт | Ijtimoiy tarmoqlar, ta’lim va tajriba | Social media, education and experience |

- [ ] **Step 7:** тесты зелёные. Сторожа: все `public/js/admin/__tests__/employees-*.test.mjs` (`employees-card-save`, `employees-default-rate`, `employees-inpatient-rates`, `employees-managed`, `employees-rates-honest`, `employees-rates-mode`, `employees-referral-tab`, `employees-specialties-save`), `employee-branch.test.mjs`, `employee-editor-save-reenable.test.mjs`, `db-query-schema.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `english-literals-v3120.test.mjs`, `icons.test.mjs`, `type-scale.test.mjs`, `rpc-exists.test.mjs`.
- [ ] **Step 8: коммит** «Карточка сотрудника, «Публичный профиль» по макету: показ (только администратор) с заполненностью, фото для партнёров, ФИО / степень / биография на трёх языках с «нет перевода», специальности, «работает врачом с», языки приёма».

---

## Task 15: Карточка — «Приём пациентов», «Что увидят партнёры», цены консультаций, консультации из прайса (DOCTOR_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/doctor-public-preview.js`
- Modify: `public/js/admin/views/doctor-public-pane.js` (импорты; блоки между биографией и соцсетями; хвост функции)
- Modify: `public/css/admin-views.css` (в конец), `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/employees-profile-save.test.mjs`

- [ ] **Step 1: падающие тесты** — в конец `employees-profile-save.test.mjs`:

```js
test('DOCTOR_PROFILE_V1: «по записи» — окна и занятое, сколько свободно, срок записи уходит числом', async () => {
  const s = await openProfileTab('dr.karimov');
  const slots = walk(s.card).filter((n) => n.className === 'dpp-slot' || n.className === 'dpp-slot busy');
  assert.deepEqual(slots.map((n) => [textOf(n).trim(), n.className]), [['09:00', 'dpp-slot'], ['09:15', 'dpp-slot busy'], ['09:30', 'dpp-slot']]);
  assert.match(textOf(s.card), /Свободно 2 из 3 окон\./);
  assert.match(textOf(s.card), /первичный приём на 30 мин показываем, только если подряд свободно окон: 2\./);
  const days = tags(s.card, 'select').find((x) => x.children.some((o) => o.attrs && o.attrs.value === '30'));
  days.value = '30';
  days.dispatchEvent({ type: 'change' });
  await save(s.card);
  const body = onlyWrite();
  assert.deepEqual([body.booking_days, body.scheduling_mode], [30, 'schedulable']);
});

test('DOCTOR_PROFILE_V1: «Живая очередь» — часы приёма, «сейчас ждут» по отметке; уходят scheduling_mode и show_queue_count', async () => {
  const s = await openProfileTab('dr.karimov');
  tags(s.card, 'button').find((b) => b.attrs.role === 'radio' && textOf(b).includes('Живая очередь')).click();
  assert.match(textOf(s.card), /Живая очередь\./);
  assert.match(textOf(s.card), /09:00–09:45/);
  assert.doesNotMatch(textOf(s.card), /Сейчас ждут приёма/);
  const chk = tags(s.card, 'input').find((i) => i.attrs.type === 'checkbox' && String(i.attrs.id || '').startsWith('dpp-qc'));
  chk.checked = true;
  chk.dispatchEvent({ type: 'change' });
  assert.match(textOf(s.card), /Сейчас ждут приёма: 3 чел\./);
  await save(s.card);
  const body = onlyWrite();
  assert.deepEqual([body.scheduling_mode, body.show_queue_count], ['live_queue', true]);
});

test('DOCTOR_PROFILE_V1: цены консультаций — своя, «Бесплатно», общая, пустая — «0 сум · цена не введена»; консультации из прайса — с отметкой «На сайте»', async () => {
  const s = await openProfileTab('dr.karimov');
  const txt = textOf(s.card);
  const [prices] = tags(s.card, 'dl').filter((d) => d.className === 'dpp-price');
  assert.deepEqual(tags(prices, 'dd').map((d) => textOf(d).trim()), ['150 000 сум', 'Бесплатно', '120 000 сум', '0 сум'],
    'пустая цена в строке врача — «0 сум», не «Бесплатно» и не пусто (решение владельца 13)');
  assert.match(txt, /Онлайн-консультация[\s\S]*общая цена[\s\S]*120 000 сум/);
  assert.match(txt, /Консультация по анализам[\s\S]*цена не введена/);
  assert.deepEqual(tags(prices, 'dd').filter((d) => d.className === 'dpp-zero').length, 1, 'пустая цена выделена');
  assert.match(txt, /Пустая цена и «Бесплатно» — 0: чтобы брать деньги, впишите цену в «Консультациях врачей»\./);
  assert.match(txt, /Консультация невролога[\s\S]*На сайте/);
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/employees-profile-save.test.mjs` → новые падают (блоков нет).
- [ ] **Step 3: вывод** `public/js/admin/views/doctor-public-preview.js`:

```js
// DOCTOR_PROFILE_V1 — «ЧТО УВИДЯТ ПАРТНЁРЫ» И ЦЕНЫ В КАРТОЧКЕ ВРАЧА (макет
// screen-doctor.js slotPreview, «Цены консультаций»). Данные — RPC
// doctor_public_preview: тот же движок записи, то же правило цены, что у кассы
// и будущего API (шаг 8). Здесь только вывод.
//   data === undefined — ещё грузится; null — сотрудник не сохранён;
//   false — сервер не ответил.
// Время, даты и названия — данными (createTextNode).
import { h, clear } from '../ui.js';
import { tr, trf, getLang, monthName } from '../i18n.js';
import { WEEK_DAYS } from './week-hours.js';
import { groupThousands } from '../../shared/money-input.js';

const sum = (n) => trf('{sum} сум', { sum: groupThousands(String(Math.round(Number(n) || 0))) });
const nameIn = (name) => (name && (name[getLang()] || name.ru)) || '—';
const dayLabel = (key) => (WEEK_DAYS.find(([k]) => k === key) || [key, ''])[1];

function pending(box, data, afterSave, failed) {
    if (data === undefined) { box.appendChild(h('p', { class: 'cpf-hint' }, 'Загрузка…')); return true; }
    if (data === null) { box.appendChild(h('p', { class: 'cpf-hint' }, afterSave)); return true; }
    if (data === false) { box.appendChild(h('p', { class: 'cpf-hint' }, failed)); return true; }
    return false;
}

/** «Что увидят партнёры»: по записи — семь дней и окна по 15 минут; живая очередь — часы и «сейчас ждут». */
export function renderPartnerPreview(box, data, { mode = 'schedulable', showQueue = false } = {}) {
    clear(box);
    if (pending(box, data, 'Что увидят партнёры — после сохранения сотрудника.', 'Не удалось загрузить, что увидят партнёры.')) return;
    if (mode === 'live_queue') {
        const kv = h('dl', { class: 'dpp-kv' });
        for (const [key, label] of WEEK_DAYS) {
            const hrs = data.hours && data.hours[key];
            if (!Array.isArray(hrs)) continue;
            kv.append(h('dt', null, label), h('dd', null, document.createTextNode(hrs[0] + '–' + hrs[1])));
        }
        const soft = h('div', { class: 'dpp-soft' },
            h('p', null, h('b', null, 'Живая очередь.'), ' ', 'Партнёры показывают часы приёма и кнопку «Оставить заявку»; время пациент не выбирает.'),
            kv.children.length ? kv : h('p', null, 'Часов приёма нет — врач не принимает ни в один день.'));
        if (showQueue) {
            soft.appendChild(h('p', { class: 'cpf-hint' },
                trf('Сейчас ждут приёма: {n} чел. Партнёры обновляют это число раз в минуту.', { n: Number(data.queue_now) || 0 })));
        }
        box.appendChild(soft);
        return;
    }
    const days = Array.isArray(data.days) ? data.days : [];
    let sel = Math.max(0, days.findIndex((d) => Array.isArray(d.windows) && d.windows.length));
    const chips = h('div', { class: 'dpp-days', role: 'group', 'aria-label': 'Дни для записи' });
    const slots = h('div', { class: 'dpp-day-slots' });
    const paint = () => {
        clear(chips);
        clear(slots);
        days.forEach((d, i) => {
            const off = !Array.isArray(d.windows) || !d.windows.length;
            const parts = String(d.date || '').split('-').map(Number);
            const chip = h('button', { type: 'button', class: 'dpp-day' + (i === sel ? ' on' : '') + (off ? ' off' : ''), 'aria-pressed': i === sel ? 'true' : 'false' },
                h('b', null, dayLabel(d.weekday)), h('span', null, document.createTextNode(parts[2] + ' ' + monthName(parts[1] - 1))));
            if (off) chip.disabled = true;
            else chip.addEventListener('click', () => { sel = i; paint(); });
            chips.appendChild(chip);
        });
        const d = days[sel];
        const wins = d && Array.isArray(d.windows) ? d.windows : [];
        if (!wins.length) { slots.appendChild(h('p', { class: 'cpf-hint' }, 'В этот день врач не принимает.')); return; }
        slots.appendChild(h('div', { class: 'dpp-slots' },
            ...wins.map((w) => h('span', { class: 'dpp-slot' + (w.free ? '' : ' busy') }, document.createTextNode(w.start)))));
        const min = Number(data.initial_minutes) || 0;
        slots.appendChild(h('p', { class: 'cpf-hint' },
            trf('Свободно {free} из {total} окон.', { free: wins.filter((w) => w.free).length, total: wins.length }), ' ',
            min > 15
                ? trf('Приём длится столько, сколько указано у вида консультации: первичный приём на {min} мин показываем, только если подряд свободно окон: {n}.', { min, n: Math.ceil(min / 15) })
                : tr('Приём длится столько, сколько указано у вида консультации.')));
    };
    paint();
    box.append(chips, slots);
}

/**
 * Цены консультаций врача — то, что получат партнёры (решения владельца 8 и 13):
 * своя цена; «Бесплатно»; общая цена вида (строки нет); пустая цена в строке —
 * «0 сум · цена не введена» (empty), чтобы администратор видел, что партнёрам уйдёт 0.
 */
export function renderConsultPrices(box, list) {
    clear(box);
    if (pending(box, list, 'Цены консультаций — после сохранения сотрудника.', 'Не удалось загрузить цены консультаций.')) return;
    if (!Array.isArray(list) || !list.length) {
        box.appendChild(h('p', { class: 'cpf-hint' }, 'Врач не ведёт ни одной консультации — отметьте их в «Консультациях врачей».'));
        return;
    }
    const dl = h('dl', { class: 'dpp-price' });
    for (const c of list) {
        const note = c.empty ? tr('цена не введена') : (c.own ? null : tr('общая цена'));
        const shown = c.empty || Number(c.price) > 0 ? sum(c.price) : tr('Бесплатно');
        dl.append(
            h('dt', null, document.createTextNode(nameIn(c.name)),
                h('span', { class: 'dpp-sub' }, trf('{n} мин', { n: c.minutes }), note ? [' · ', note] : null)),
            h('dd', c.empty ? { class: 'dpp-zero' } : null, shown));
    }
    box.appendChild(dl);
}

/** Услуги прайса группы «Консультации», которые оказывает врач (решение владельца 12). */
export function renderConsultServices(box, list) {
    clear(box);
    if (pending(box, list, 'Консультации из прайса — после сохранения сотрудника.', 'Не удалось загрузить услуги врача.')) return;
    if (!Array.isArray(list) || !list.length) {
        box.appendChild(h('p', { class: 'cpf-hint' }, 'За врачом нет услуг из группы «Консультации».'));
        return;
    }
    const dl = h('dl', { class: 'dpp-price' });
    for (const s of list) {
        dl.append(
            h('dt', null, document.createTextNode(nameIn(s.name)),
                h('span', { class: 'dpp-sub' }, s.online ? tr('На сайте') : tr('Не показывается'), s.own ? [' · ', tr('своя цена врача')] : null)),
            h('dd', null, Number(s.price) > 0 ? sum(s.price) : tr('Бесплатно')));
    }
    box.appendChild(dl);
}
```

- [ ] **Step 4: раздел** `doctor-public-pane.js`.
  - Импорты: в импорт из `doctor-public.js` добавить `BOOKING_DAYS, DEFAULT_BOOKING_DAYS`; под ним — `import { renderPartnerPreview, renderConsultPrices, renderConsultServices } from './doctor-public-preview.js';   // DOCTOR_PROFILE_V1 — приём, превью, цены`.
  - Под `const PHOTO_BUCKET = …`: `const DAY_LABEL = Object.freeze({ 7: '7 дней вперёд', 14: '14 дней вперёд', 30: '30 дней вперёд' });`.
  - В шапку модуля (за строкой про `ctx.errors`) дописать: `//   • ctx.loadPreview() — ответ doctor_public_preview (null — сотрудник не сохранён, false — сервер не ответил).`
  - Между блоком «биография» и блоком «соцсети и опыт» вставить:

```js
    // ---- приём пациентов и что увидят партнёры ----
    const MODES = [['schedulable', 'Calendar', 'По записи', 'Пациент выбирает свободное время. Окна по 15 минут.'],
        ['live_queue', 'Patients', 'Живая очередь', 'Пациент приходит в часы приёма, порядок — по приходу.']];
    const modeBtns = {};
    const modeBox = h('div', { class: 'dpp-modes', role: 'radiogroup', 'aria-label': 'Как принимает' });
    const receptionBody = h('div', { class: 'dpp-reception' });
    const previewBox = h('div', { class: 'dpp-preview', 'aria-live': 'polite' });
    let preview;   // ответ doctor_public_preview: undefined — грузится; null — не сохранён; false — сервер не ответил
    const queueMode = () => emp.scheduling_mode === 'live_queue';
    const paintPreview = () => renderPartnerPreview(previewBox, preview, { mode: queueMode() ? 'live_queue' : 'schedulable', showQueue: !!emp.show_queue_count });
    function paintReception() {
        for (const [k, b] of Object.entries(modeBtns)) b.setAttribute('aria-checked', (k === 'live_queue') === queueMode() ? 'true' : 'false');
        clear(receptionBody);
        if (!queueMode()) {
            const cur = BOOKING_DAYS.includes(Number(emp.booking_days)) ? Number(emp.booking_days) : DEFAULT_BOOKING_DAYS;
            const days = h('select', { class: 'docprof-in', id: 'dpp-days-' + (++seq) },
                ...BOOKING_DAYS.map((n) => h('option', { value: String(n), selected: cur === n }, DAY_LABEL[n])));
            days.value = String(cur);
            days.disabled = !!readOnly;
            days.addEventListener('change', () => ctx.setField({ booking_days: Number(days.value) }));
            receptionBody.appendChild(h('div', { class: 'dpp-grid2' },
                h('div', { class: 'field' }, h('span', { class: 'dpp-label' }, 'Длина окна'),
                    h('span', { class: 'dpp-fixed' }, Icon('Clock', { size: 14 }), ' ', '15 минут'), h('p', { class: 'cpf-hint' }, 'Одинаково для всех врачей.')),
                h('div', { class: 'field' }, h('label', { for: days.getAttribute('id') }, 'Запись открыта на'), days,
                    h('p', { class: 'cpf-hint' }, 'Дальше этого срока партнёры время не видят.'))));
        } else {
            const chk = h('input', { type: 'checkbox', id: 'dpp-qc-' + (++seq) });
            chk.checked = !!emp.show_queue_count;
            chk.disabled = !!readOnly;
            chk.addEventListener('change', () => { ctx.setField({ show_queue_count: chk.checked }); paintPreview(); });
            receptionBody.appendChild(h('label', { class: 'dpp-check', for: chk.getAttribute('id') }, chk,
                h('b', null, 'Показывать, сколько человек сейчас в очереди'), h('span', null, 'Число пациентов, которые пришли к врачу и ждут приёма.')));
        }
        paintPreview();
    }
    for (const [k, icon, title, sub] of MODES) {
        const b = h('button', { type: 'button', class: 'dpp-mode', role: 'radio' }, Icon(icon, { size: 18 }), h('span', null, h('b', null, title), h('span', null, sub)));
        b.disabled = !!readOnly;
        b.addEventListener('click', () => { ctx.setField({ scheduling_mode: k }); paintReception(); });
        modeBtns[k] = b;
        modeBox.appendChild(b);
    }
    root.appendChild(section('Приём пациентов', 'Та же настройка, что «Приём услуг» в «Должности»: «по записи» или «живая очередь».',
        modeBox, receptionBody,
        h('div', null, h('p', { class: 'dpp-h5' }, 'Что увидят партнёры'), previewBox),
        h('p', { class: 'cpf-hint' }, 'Часы приёма берутся из «Рабочего времени» врача и часов работы филиала. Показано по сохранённому графику.')));

    // ---- цены консультаций (решение 8) и консультации из прайса (решение 12) ----
    const pricesBox = h('div');
    const servicesBox = h('div');
    root.appendChild(section('Цены консультаций', 'Из раздела «Консультации врачей».', pricesBox,
        h('div', { class: 'dpp-row' },
            ctx.openConsultations ? h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => ctx.openConsultations() },
                Icon('Edit', { size: 14 }), ' ', 'Изменить в «Консультации врачей»') : null,
            h('span', { class: 'cpf-hint' }, 'Партнёры получают эти цены вместе с профилем врача. Пустая цена и «Бесплатно» — 0: чтобы брать деньги, впишите цену в «Консультациях врачей».'))));
    root.appendChild(section('Консультации из прайса', 'Услуги группы «Консультации», которые оказывает врач: кто оказывает услугу — в окне услуги и во вкладке «Услуги и ставки». Партнёры увидят их в профиле врача, если у услуги включена онлайн-запись.', servicesBox));
```

  - Перед строкой `if (typeof ctx.onRepaint === 'function') ctx.onRepaint(paintSwitch);` вставить:

```js
    // DOCTOR_PROFILE_V1 — приём и превью: сначала «Загрузка…», потом ответ doctor_public_preview.
    paintReception();
    renderConsultPrices(pricesBox, undefined);
    renderConsultServices(servicesBox, undefined);
    if (typeof ctx.loadPreview === 'function') {
        Promise.resolve(ctx.loadPreview()).then((data) => {
            preview = data && typeof data === 'object' && !Array.isArray(data) ? data : (data === false ? false : null);
            paintPreview();
            renderConsultPrices(pricesBox, preview ? preview.consultations : preview);
            renderConsultServices(servicesBox, preview ? preview.services : preview);
        });
    }
```

- [ ] **Step 5: стили** — в конец `public/css/admin-views.css`:

```css
/* DOCTOR_PROFILE_V1 — «Приём пациентов», «Что увидят партнёры», цены (views/doctor-public-preview.js). */
.dpp-modes { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 10px; }
.dpp-mode { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--ink-200); border-radius: 10px; background: var(--white); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dpp-mode[aria-checked="true"] { border-color: var(--primary-600); background: var(--primary-50); }
.dpp-mode:disabled { cursor: default; }
.dpp-mode b { display: block; font-size: 13.5px; font-weight: 600; color: var(--ink-900); }
.dpp-mode span span { font-size: 12.5px; color: var(--ink-500); line-height: 1.4; }
.dpp-fixed { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 8px; background: var(--ok-50); color: var(--ok-700); font-size: 13.5px; font-weight: 500; }
.dpp-check { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; padding: 10px 12px; border: 1px solid var(--ink-100); border-radius: 10px; cursor: pointer; }
.dpp-check input { grid-row: span 2; margin: 2px 0 0; accent-color: var(--primary-600); }
.dpp-check b { font-size: 13.5px; font-weight: 600; color: var(--ink-900); }
.dpp-check span { font-size: 12.5px; color: var(--ink-500); line-height: 1.4; }
.dpp-preview, .dpp-day-slots { display: grid; gap: 10px; min-width: 0; }
.dpp-days { display: flex; flex-wrap: wrap; gap: 6px; }
.dpp-day { display: grid; min-width: 72px; padding: 6px 10px; border: 1px solid var(--ink-200); border-radius: 8px; background: var(--white); color: var(--ink-700); font: 500 12.5px var(--font-sans); text-align: center; cursor: pointer; }
.dpp-day b { font-size: 13.5px; color: var(--ink-900); }
.dpp-day.on { border-color: var(--primary-600); background: var(--primary-50); }
.dpp-day:disabled { opacity: .55; cursor: default; }
.dpp-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 6px; }
.dpp-slot { display: grid; place-items: center; height: 32px; border: 1px solid var(--primary-200); border-radius: 7px; color: var(--primary-700); font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dpp-slot.busy { border-color: var(--ink-100); background: var(--ink-50); color: var(--ink-400); text-decoration: line-through; font-weight: 500; }
.dpp-soft { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--primary-200); border-radius: 10px; background: var(--primary-50); }
.dpp-soft p { margin: 0; font-size: 13.5px; color: var(--ink-800); }
.dpp-kv { display: grid; grid-template-columns: minmax(0, 120px) minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: 13.5px; }
.dpp-kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.dpp-price { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; margin: 0; padding: 12px 14px; border: 1px solid var(--ink-100); border-radius: 10px; }
.dpp-price dt { font-size: 13.5px; color: var(--ink-700); overflow-wrap: anywhere; }
.dpp-price dd { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--ink-900); text-align: right; font-variant-numeric: tabular-nums; }
.dpp-sub { display: block; font-size: 12.5px; font-weight: 400; color: var(--ink-500); }
.dpp-price dd.dpp-zero { color: var(--warn-700); }   /* решение владельца 13: пустая цена — 0, партнёрам тоже */
/* /DOCTOR_PROFILE_V1 — приём и превью */
```

- [ ] **Step 6: словарь:**

| ru | uz | en |
|---|---|---|
| Приём пациентов | Bemorlarni qabul qilish | Seeing patients |
| Та же настройка, что «Приём услуг» в «Должности»: «по записи» или «живая очередь». | «Lavozim»dagi «Xizmatlar qabuli» bilan bir xil sozlama: «yozilish bo‘yicha» yoki «jonli navbat». | The same setting as “Service intake” in “Position”: by appointment or walk-in queue. |
| Как принимает | Qanday qabul qiladi | How the doctor sees patients |
| Пациент выбирает свободное время. Окна по 15 минут. | Bemor bo‘sh vaqtni tanlaydi. Oynalar 15 daqiqadan. | The patient picks a free time. 15-minute slots. |
| Пациент приходит в часы приёма, порядок — по приходу. | Bemor qabul soatlarida keladi, navbat — kelish tartibida. | The patient comes during reception hours; the order is by arrival. |
| Длина окна | Oyna uzunligi | Slot length |
| 15 минут | 15 daqiqa | 15 minutes |
| Одинаково для всех врачей. | Barcha shifokorlar uchun bir xil. | The same for all doctors. |
| Запись открыта на | Yozilish ochiq muddati | Booking open for |
| 7 дней вперёд | 7 kun oldinga | 7 days ahead |
| 14 дней вперёд | 14 kun oldinga | 14 days ahead |
| 30 дней вперёд | 30 kun oldinga | 30 days ahead |
| Дальше этого срока партнёры время не видят. | Bu muddatdan keyingi vaqtni hamkorlar ko‘rmaydi. | Partners do not see times beyond this. |
| Показывать, сколько человек сейчас в очереди | Hozir navbatda nechta odam borligini ko‘rsatish | Show how many people are in the queue now |
| Число пациентов, которые пришли к врачу и ждут приёма. | Shifokorga kelib, qabulni kutayotgan bemorlar soni. | The number of patients who have come to the doctor and are waiting. |
| Что увидят партнёры | Hamkorlar nimani ko‘radi | What partners will see |
| Часы приёма берутся из «Рабочего времени» врача и часов работы филиала. Показано по сохранённому графику. | Qabul soatlari shifokorning «Ish vaqti» va filialning ish soatlaridan olinadi. Saqlangan jadval bo‘yicha ko‘rsatilgan. | Reception hours come from the doctor’s “Working time” and the branch’s working hours. Shown from the saved schedule. |
| Цены консультаций | Konsultatsiya narxlari | Consultation prices |
| Из раздела «Консультации врачей». | «Shifokor konsultatsiyalari» bo‘limidan. | From “Doctor consultations”. |
| Изменить в «Консультации врачей» | «Shifokor konsultatsiyalari»da o‘zgartirish | Change in “Doctor consultations” |
| Партнёры получают эти цены вместе с профилем врача. Пустая цена и «Бесплатно» — 0: чтобы брать деньги, впишите цену в «Консультациях врачей». | Hamkorlar bu narxlarni shifokor profili bilan birga oladi. Bo‘sh narx va «Bepul» — 0: pul olish uchun narxni «Shifokor konsultatsiyalari»da yozing. | Partners receive these prices with the doctor’s profile. An empty price and “Free” both mean 0: to charge, type a price in “Doctor consultations”. |
| Консультации из прайса | Narxlar ro‘yxatidagi konsultatsiyalar | Consultations from the price list |
| Услуги группы «Консультации», которые оказывает врач: кто оказывает услугу — в окне услуги и во вкладке «Услуги и ставки». Партнёры увидят их в профиле врача, если у услуги включена онлайн-запись. | «Konsultatsiyalar» guruhidagi shifokor ko‘rsatadigan xizmatlar: xizmatni kim ko‘rsatishi xizmat oynasida va «Xizmatlar va stavkalar» bo‘limida belgilanadi. Xizmatda onlayn yozilish yoqilgan bo‘lsa, hamkorlar ularni shifokor profilida ko‘radi. | Services of the “Consultations” group that the doctor provides: who provides a service is set in the service window and on the “Services and rates” tab. Partners see them in the doctor’s profile if online booking is on for the service. |
| Что увидят партнёры — после сохранения сотрудника. | Hamkorlar nimani ko‘rishi — xodim saqlangandan keyin. | What partners will see appears after the employee is saved. |
| Не удалось загрузить, что увидят партнёры. | Hamkorlar nimani ko‘rishini yuklab bo‘lmadi. | Could not load what partners will see. |
| Живая очередь. | Jonli navbat. | Walk-in queue. |
| Партнёры показывают часы приёма и кнопку «Оставить заявку»; время пациент не выбирает. | Hamkorlar qabul soatlarini va «Ariza qoldirish» tugmasini ko‘rsatadi; bemor vaqtni tanlamaydi. | Partners show the reception hours and a “Leave a request” button; the patient does not pick a time. |
| Часов приёма нет — врач не принимает ни в один день. | Qabul soatlari yo‘q — shifokor hech bir kunda qabul qilmaydi. | No reception hours — the doctor does not see patients on any day. |
| Сейчас ждут приёма: {n} чел. Партнёры обновляют это число раз в минуту. | Hozir qabulni kutmoqda: {n} kishi. Hamkorlar bu sonni har daqiqada yangilaydi. | Waiting now: {n} people. Partners refresh this number every minute. |
| Дни для записи | Yozilish kunlari | Booking days |
| В этот день врач не принимает. | Bu kuni shifokor qabul qilmaydi. | The doctor does not see patients on this day. |
| Свободно {free} из {total} окон. | {total} ta oynadan {free} tasi bo‘sh. | {free} of {total} slots free. |
| Приём длится столько, сколько указано у вида консультации: первичный приём на {min} мин показываем, только если подряд свободно окон: {n}. | Qabul konsultatsiya turida ko‘rsatilgancha davom etadi: {min} daqiqalik dastlabki qabulni faqat ketma-ket {n} ta oyna bo‘sh bo‘lsa ko‘rsatamiz. | A visit lasts as long as its consultation kind says: a {min}-minute initial visit is shown only where {n} slots in a row are free. |
| Приём длится столько, сколько указано у вида консультации. | Qabul konsultatsiya turida ko‘rsatilgancha davom etadi. | A visit lasts as long as its consultation kind says. |
| Цены консультаций — после сохранения сотрудника. | Konsultatsiya narxlari — xodim saqlangandan keyin. | Consultation prices appear after the employee is saved. |
| Не удалось загрузить цены консультаций. | Konsultatsiya narxlarini yuklab bo‘lmadi. | Could not load the consultation prices. |
| Врач не ведёт ни одной консультации — отметьте их в «Консультациях врачей». | Shifokor birorta ham konsultatsiya o‘tkazmaydi — ularni «Shifokor konsultatsiyalari»da belgilang. | The doctor has no consultations — tick them in “Doctor consultations”. |
| общая цена | umumiy narx | general price |
| цена не введена | narx kiritilmagan | no price entered |
| Консультации из прайса — после сохранения сотрудника. | Narxlar ro‘yxatidagi konsultatsiyalar — xodim saqlangandan keyin. | Consultations from the price list appear after the employee is saved. |
| Не удалось загрузить услуги врача. | Shifokor xizmatlarini yuklab bo‘lmadi. | Could not load the doctor’s services. |
| За врачом нет услуг из группы «Консультации». | Shifokorda «Konsultatsiyalar» guruhidan xizmat yo‘q. | The doctor has no services from the “Consultations” group. |
| Не показывается | Ko‘rsatilmaydi | Not shown |
| своя цена врача | shifokorning o‘z narxi | the doctor’s own price |

- [ ] **Step 7:** тесты зелёные. Сторожа: все `employees-*.test.mjs`, `employee-branch.test.mjs`, `db-query-schema.test.mjs`, `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `english-literals-v3120.test.mjs`, `icons.test.mjs`, `type-scale.test.mjs`, `rpc-exists.test.mjs`.
- [ ] **Step 8: коммит** «Карточка врача: приём «по записи» / «живая очередь», запись на 7 / 14 / 30 дней, счётчик очереди, «Что увидят партнёры», цены консультаций (решение 8; пустая цена — «0 сум · цена не введена», решение 13) и консультации из прайса (решение 12)».

---

## Task 16: Список сотрудников — «Специальность», «Приём», «Сайт и партнёры» (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/employees.js` (:197-207, :249-294, :265, :298, :326; новая функция у `staffLabel` :67)
- Modify: `public/css/admin-views.css` (в конец), `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/employees-profile-save.test.mjs`

- [ ] **Step 1: падающий тест** — в конец `employees-profile-save.test.mjs`:

```js
test('DOCTOR_PROFILE_V1: список — специальность, приём, «Сайт и партнёры»; скрытый филиал прячет врача', async () => {
  document.body.children.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const head = tags(container, 'th').map((t) => textOf(t).trim());
  for (const col of ['Специальность', 'Приём', 'Сайт и партнёры', 'Роль', 'Телефон']) assert.ok(head.includes(col), col);
  const rowOf = (u) => tags(container, 'tr').find((r) => textOf(r).includes('@' + u));
  assert.match(textOf(rowOf('dr.karimov')), /Кардиолог[\s\S]*По записи[\s\S]*Скрыт с сайта/);
  assert.match(textOf(rowOf('dr.shown')), /На сайте/);
  assert.match(textOf(rowOf('dr.pub')), /Скрыт с сайта[\s\S]*филиал скрыт/);
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/employees-profile-save.test.mjs` → новый падает.
- [ ] **Step 3: правка** `employees.js`.
  - За `staffLabel` (:67):

```js
// DOCTOR_PROFILE_V1 — колонки макета в списке: специальности строки (из списка, у
// записанного до него — одна колонка) и показ на сайте и у партнёров — теми же
// словами, что список «Филиалов» (шаг 4).
const specNamesOf = (u) => (Array.isArray(u.specialties) && u.specialties.length
    ? u.specialties.map((s) => (s && typeof s === 'object' ? s.name : s)) : (u.specialty ? [u.specialty] : [])).filter(Boolean);
function publicTag(u, branchesById) {
    const state = doctorPublicState(u, branchesById);
    if (state === 'shown') return h('span', { class: 'emp-pub on' }, Icon('Globe', { size: 12 }), ' ', 'На сайте');
    return h('span', { class: 'emp-pub' }, 'Скрыт с сайта', state === 'branch_hidden' ? h('span', { class: 'dpp-sub' }, 'филиал скрыт') : null);
}
```

  - Шапка (:201) и строка фильтров (:202-205):

```js
                h('tr', null, h('th', null, 'Имя'), h('th', null, 'Категория'),
                    h('th', null, 'Специальность'), h('th', null, 'Приём'), h('th', null, 'Сайт и партнёры'),   // DOCTOR_PROFILE_V1 — колонки макета
                    h('th', null, 'Роль'), h('th', null, 'Телефон'), h('th', null, 'Статус'), h('th', null, '')),
                h('tr', { class: 'filter-row', style: { background: 'var(--ink-25, #f6f8f9)' } },
                    h('th', null, nameFlt), h('th', null, staffFlt), h('th', null), h('th', null), h('th', null),   // DOCTOR_PROFILE_V1
                    h('th', null, roleFlt), h('th', null, phoneFlt), h('th', null),
                    h('th', { style: { textAlign: 'right' } }, resetBtn)),
```

  - Таблицу (:197-207) обернуть: `h('div', { class: 'emp-table-wrap' }, h('table', { class: 'tbl' }, …))` (хвост `// DOCTOR_PROFILE_V1 — колонок больше: на узком экране прокрутка внутри карточки`).
  - `colspan: '6'` → `colspan: '9'` в трёх местах (:265, :298, :326), хвост `// DOCTOR_PROFILE_V1`.
  - В `renderRows`, перед `for (const u of rows) {`: `const branchesById = new Map(branches.map((b) => [Number(b.id), b]));   // DOCTOR_PROFILE_V1`.
  - В строке сотрудника — сразу за ячейкой категории (`h('td', null, u.staff_type ? … : (u.is_doctor ? 'Врачи' : '—')),`):

```js
                // DOCTOR_PROFILE_V1 — специальность, приём, показ на сайте и у партнёров (у не-врача — «—»).
                h('td', null, document.createTextNode(specNamesOf(u).map((n) => tr(n)).join(', ') || '—')),
                h('td', null, u.is_doctor ? (u.scheduling_mode === 'live_queue' ? 'Живая очередь' : 'По записи') : '—'),
                h('td', null, u.is_doctor ? publicTag(u, branchesById) : '—'),
```

  - Здания уже грузятся с `show_public` (задача 14).
- [ ] **Step 4: стили** — в конец `admin-views.css`:

```css
/* DOCTOR_PROFILE_V1 — список сотрудников: показ на сайте; таблица прокручивается внутри карточки. */
.emp-table-wrap { overflow-x: auto; }
.emp-pub { display: inline-grid; gap: 2px; font-size: 12.5px; color: var(--ink-500); }
.emp-pub.on { display: inline-flex; align-items: center; gap: 4px; color: var(--ok-700); font-weight: 600; }
/* /DOCTOR_PROFILE_V1 — список сотрудников */
```

- [ ] **Step 5: словарь:**

| ru | uz | en |
|---|---|---|
| филиал скрыт | filial yashirilgan | branch hidden |

- [ ] **Step 6:** тесты зелёные. Сторожа: все `employees-*.test.mjs`, `i18n-coverage.test.mjs`, `type-scale.test.mjs`, `db-query-schema.test.mjs`.
- [ ] **Step 7: коммит** «Сотрудники: в списке — специальность, приём и «Сайт и партнёры»; врач скрытого филиала помечен».

---

## Task 17: «Мой профиль» — языки приёма, «Работает врачом с», строка о показе (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/doctor-profile.js` (импорт; :110-124; :181; :195-198; :347-348)
- Modify: `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/doctor-profile-save.test.mjs`

- [ ] **Step 1: падающие тесты** — в конец `doctor-profile-save.test.mjs`:

```js
// DOCTOR_PROFILE_V1 — «Мой профиль»: языки приёма, «Работает врачом с», строка о показе.
test('DOCTOR_PROFILE_V1: «работает с» — из стажа; изменили — уходит practice_since; языки — переключателями', async () => {
    const YEAR = new Date().getFullYear();
    const s = await openProfile();
    const since = tagsOf(s.container, 'input').find((i) => i.attrs.type === 'number' && i.attrs.min === '1940');
    assert.ok(since, 'нет поля «Работает врачом с»');
    assert.equal(since.value, String(YEAR - 12));
    since.value = String(YEAR - 14);
    tagsOf(s.container, 'button').find((b) => b.className === 'dpp-lang' && b.textContent.trim() === 'UZ').click();
    await s.save();
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(rpcCalls[0].p, { practice_since: YEAR - 14, languages: ['uz'] });
});

test('DOCTOR_PROFILE_V1: строка о показе — включает администратор', async () => {
    let s = await openProfile();
    assert.ok(s.container.textContent.includes('Профиль пока не показывается на сайте клиники и у партнёров — показ включает администратор.'));
    s = await openProfile({ user: { ...DOC_ROW, is_public: 1 } });
    assert.ok(s.container.textContent.includes('Профиль показывается на сайте клиники и у партнёров. Показ включает и выключает администратор.'));
});

test('DOCTOR_PROFILE_V1: последний язык не снимается', async () => {
    const s = await openProfile({ user: { ...DOC_ROW, languages: ['ru'] } });
    tagsOf(s.container, 'button').find((b) => b.className === 'dpp-lang' && b.textContent.trim() === 'RU').click();
    assert.equal(toastText(), 'Нужен хотя бы один язык');
    await s.save();
    assert.equal(rpcCalls.length, 0);
});
```

- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/doctor-profile-save.test.mjs` → новые падают.
- [ ] **Step 3: правка** `doctor-profile.js`.
  - Импорт за :12: `import { DOCTOR_LANGS, PRACTICE_SINCE_MIN, experienceYears, readLanguages, shownPracticeSince } from '../../shared/doctor-public.js';   // DOCTOR_PROFILE_V1`.
  - Колонки загрузки (:124): `+ 'is_local')` → `+ 'is_local, '` и строкой ниже `+ 'languages, practice_since, is_public')   // DOCTOR_PROFILE_V1 — языки, «работает с», показ (только видно)`.
  - Сразу за блоком `if (managed) { … }` (:181):

```js
    // DOCTOR_PROFILE_V1 — показ на сайте и у партнёров включает администратор
    // (карточка сотрудника); врач его здесь только видит.
    root.appendChild(h('p', { class: 'docprof-hint docprof-pub', role: 'note' }, Number(st.user.is_public) === 1
        ? 'Профиль показывается на сайте клиники и у партнёров. Показ включает и выключает администратор.'
        : 'Профиль пока не показывается на сайте клиники и у партнёров — показ включает администратор.'));
```

  - Поле стажа (:195-198) заменить:

```js
    // DOCTOR_PROFILE_V1 — «Работает врачом с» вместо «Стаж (лет)»: стаж на сайте
    // растёт сам; у строки главной старой версии год — из прежнего стажа.
    const thisYear = new Date().getFullYear();
    const sinceInp = h('input', { type: 'number', min: String(PRACTICE_SINCE_MIN), max: String(thisYear), step: '1', class: 'docprof-in', placeholder: '2015' });
    const shownSince = shownPracticeSince(st.user);
    sinceInp.value = shownSince == null ? '' : String(shownSince);
    scalarInputs.practice_since = sinceInp;
    const sinceHint = h('div', { class: 'docprof-hint' });
    const paintSince = () => {
        const y = sinceInp.value === '' ? null : experienceYears(Number(sinceInp.value));
        sinceHint.textContent = y == null ? '' : trf('Стаж на сайте, лет: {n}.', { n: y });
    };
    sinceInp.addEventListener('input', paintSince);
    paintSince();
    idFields.appendChild(h('div', { class: 'field' }, h('label', null, 'Работает врачом с'), sinceInp, sinceHint));
    // DOCTOR_PROFILE_V1 — языки приёма (макет «Публичный профиль»): хотя бы один.
    st.languages = readLanguages(st.user.languages);
    const langBox = h('div', { class: 'dpp-langs', role: 'group', 'aria-label': 'Языки приёма' });
    for (const l of DOCTOR_LANGS) {
        const b = h('button', { type: 'button', class: 'dpp-lang', 'aria-pressed': st.languages.includes(l) ? 'true' : 'false' }, LANG_LBL[l]);
        b.addEventListener('click', () => {
            const on = st.languages.includes(l);
            if (on && st.languages.length === 1) { toast('Нужен хотя бы один язык', 'fail'); return; }
            st.languages = DOCTOR_LANGS.filter((x) => (x === l ? !on : st.languages.includes(x)));
            b.setAttribute('aria-pressed', on ? 'false' : 'true');
        });
        langBox.appendChild(b);
    }
    idFields.appendChild(h('div', { class: 'field' }, h('label', null, 'Языки приёма'), langBox,
        h('div', { class: 'docprof-hint' }, 'На каких языках врач говорит с пациентом.')));
```

  - В `collectAll` строки :347-348 заменить:

```js
        // DOCTOR_PROFILE_V1 — год «работает с» (стаж сервер пишет сам) и языки приёма.
        const yrs = scalarInputs.practice_since.value.trim();
        p.practice_since = yrs === '' ? null : Number(yrs);
        p.languages = [...(st.languages || [])];
```

  - В шапке `const st = { … }` (:62-72) дописать `languages: [],   // DOCTOR_PROFILE_V1 — языки приёма`; комментарий `const scalarInputs = {};    // experience_years` → `// practice_since (DOCTOR_PROFILE_V1)`.
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Профиль показывается на сайте клиники и у партнёров. Показ включает и выключает администратор. | Profil klinika saytida va hamkorlarda ko‘rsatiladi. Ko‘rsatishni administrator yoqadi va o‘chiradi. | Your profile is shown on the clinic website and to partners. The administrator turns this on and off. |
| Профиль пока не показывается на сайте клиники и у партнёров — показ включает администратор. | Profil hozircha klinika saytida va hamkorlarda ko‘rsatilmaydi — ko‘rsatishni administrator yoqadi. | Your profile is not shown on the clinic website or to partners yet — the administrator turns this on. |

- [ ] **Step 5:** тесты зелёные. Сторожа: `doctor-profile-save.test.mjs` целиком (прежние тесты «Нет изменений», «только bio_ru» — зелёные: год и языки в точке отсчёта), `i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `db-query-schema.test.mjs`.
- [ ] **Step 6: коммит** «Мой профиль: языки приёма, «Работает врачом с» вместо стажа, строка о показе на сайте (его включает администратор)».

---

## Task 18: После слияния шага 7 — право «Свободное время» говорит про срок записи врача (DOCTOR_PROFILE_V1)

**Files:**
- Modify: `public/js/shared/api-connections.js` (:28, файл шага 7)
- Modify: `public/js/admin/i18n-strings.js`

> Делается, только когда шаг 7 в основной линии (`ls public/js/shared/api-connections.js`). Нет файла — задачу пропустить и сказать контролёру.

- [ ] **Step 1:** `grep -n "Окна по 15 минут на 14 дней вперёд" public/js/shared/api-connections.js` → одна строка (`SCOPE_INFO.slots.desc`).
- [ ] **Step 2: правка** — `desc` строки `slots` заменить: `'Окна по 15 минут на столько дней вперёд, на сколько открыта запись у врача (7, 14 или 30); у врачей с живой очередью — часы приёма'`, хвост `// DOCTOR_PROFILE_V1 — срок записи у каждого врача (Р8)`.
- [ ] **Step 3: словарь:**

| ru | uz | en |
|---|---|---|
| Окна по 15 минут на столько дней вперёд, на сколько открыта запись у врача (7, 14 или 30); у врачей с живой очередью — часы приёма | Shifokorda yozilish qancha kunga ochiq bo‘lsa (7, 14 yoki 30), shuncha kun oldinga 15 daqiqalik oynalar; jonli navbatli shifokorlarda — qabul soatlari | 15-minute slots as many days ahead as the doctor’s booking is open (7, 14 or 30); for walk-in queue doctors, their reception hours |

- [ ] **Step 4:** тесты: `node --test public/js/shared/api-connections.test.js`; `node --experimental-vm-modules --test public/js/admin/__tests__/api-connections.test.mjs public/js/admin/__tests__/api-connection-new.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`.
- [ ] **Step 5: коммит** «API и подключения: «Свободное время» — на столько дней, на сколько открыта запись у врача».

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды, после всех задач и когда другие сборщики клона не пишут.**
- Как в выпуске: `npm test` (= `node --experimental-vm-modules --test`), из корня клона.
- Как CI на en-US: `node --experimental-vm-modules --import file:///C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs --test`.
  - Файла нет — восстановить: `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });` (память `easymed-ci-locale-trap`).
- Красное в чужой области — сначала проверить, не чужая ли это недописанная правка.

**2. Проверка «сломать».** Отдельный агент, только чтение; находки — в отчёт. Что пробовать:
- (a) **Показ:** не-администратор (свои роли на основе admin, «Сотрудники: Изменение», врач с правом) меняет `is_public` через `PATCH` / `POST` — булевы, 0/1, строкой; неизменённое значение; «Мой профиль» с `is_public`; показ без ФИО RU / без специальностей / стереть их у показываемого — в карточке, RPC, Excel-импорте сотрудников.
- (b) **Один профиль:** карточка и «Мой профиль» открыты одновременно — правки языков, года, ФИО не затирают друг друга; «работает с» и стаж всегда согласованы (`practice_since` + `experience_years`); стаж из экрана старой версии.
- (c) **Решения 8 и 13 везде:** врач без строк (общая цена вида), строка с пустой ценой (**0** — и в кассе, и в окне записи, и в CRM, и в «Повторном визите», и в карточке «0 сум · цена не введена», и в превью для партнёров), «Бесплатно» (0), «Ведёт» снято, вид выключен, две строки врача — касса, окно записи (обе формы окна), CRM (цена и выбор врача), «Повторный визит», карточка — одна цена; ни один экран не подставляет общую цену вида в строку с пустой ценой; врач-администратор (`is_doctor = 1`, роль `admin`, без специальности) — в окне записи.
- (j) **Порт анализаторов:** пока идёт `npm test`, запущенный на машине Easy-Med продолжает принимать на 2575 (`netstat -ano | findstr :2575` — один слушатель, PID запущенной программы); страж `lis-port-hygiene.test.js` ловит новый тест с `lis_restart` без `LIS_ENABLED` / `LIS_PORT`.
- (d) **Длина и вид:** `calendar_slots` / `calendar_book` с видом без длительности, с 5 / 480; два вида с `initial` через `/api/db` (пачкой, upsert, без отбора по id); справочник «Виды консультаций» снимает «Для партнёров»; переименование вида — `name_ru` следует.
- (e) **Превью:** врач без графика, выходные, обед, часы здания (24/7, «не ограничивать», закрытый день), врач только в `user_branches`, отменённые и неявочные визиты, сегодня после конца приёма; живая очередь — ждущие, неоплаченные, приглашённые, другой врач, лаборатория; кассир без права — 403.
- (f) **Фото:** путь чужого врача, `..`, не тот бакет, роль без права; филиал — врач главного здания (409), свой врач филиала (можно); новый сотрудник (кнопки нет).
- (g) **Синхронизация:** новая главная → новый филиал (все пять колонок), старая главная → новый филиал (местное остаётся), мусор в `booking_days` / `is_public` (CHECK) — приём справочника не падает? (проверить, что главная такого не отдаёт).
- (h) **Языки и вид:** экран на uz / en без кириллицы, кроме данных; «нет перевода» у ФИО и биографии, не у степени; дни и месяцы в превью; ширина 360 px — без прокрутки вбок (кроме таблицы списка внутри карточки); значки — только `Icon`.
- (i) **Документы:** печать визита, рецепта, счёта, чека, выписки — `users.full_name` и `users.specialty`, как раньше.

**3. Проба на тестовой клинике** (:8712, рецепт — память `easymed-dev-prod-workflow`; без тега):
1. «Настройки → Виды консультаций»: «Первичный приём» — 30 мин, «Для партнёров: Первичный приём»; «Повторный приём» — 15 мин, «Повторный».
2. Врач без строк в «Консультациях врачей»: окно записи предлагает обе консультации по общей цене. Затем открыть его окно в «Консультациях врачей», вписать цену только «Повторному приёму» и сохранить: «Первичный приём» у него теперь **0** везде (касса, окно записи, карточка — «0 сум · цена не введена»); подпись окна говорит об этом прямо.
3. Карточка врача → «Публичный профиль»: включить показ без ФИО RU (отказ), заполнить ФИО, специальности (повтор — отказ), языки, «работает с», фото, биографию; показ включить.
4. «Что увидят партнёры»: окна на неделю совпадают с календарём записи; живая очередь — часы и «сейчас ждут».
5. Список сотрудников: колонки и «Скрыт с сайта» у врача скрытого филиала.
6. «Мой профиль» того же врача: языки и год — те же; строка о показе.
7. Интерфейс на узбекском и английском.

**4. Пуш и тег.** `git push` ветки (владелец: «после изменений — пушить»). Тег — только по слову владельца. Заметки к выпуску (`RELEASE_NOTES.md` + `release-notes.test.mjs`) — при подготовке выпуска.

---

## Вопросы владельцу

Открытых вопросов нет. Вопрос 1 закрыт ответом владельца (решение 13, Р6); вопросы 2 и 3 решил контролёр (Р19, Р20) — владелец может пересмотреть, цена смены — в строках Р.

**Сообщить владельцу (решено, не вопросы):**
- **Решение 13 — пустая цена в «Консультациях врачей» — 0, как сейчас, везде, в том числе партнёрам.** Окно цен врача при «Save» пишет строку на каждый вид; где цену не ввели и «Бесплатно» не отметили, остаётся пустая цена — касса, окно записи, CRM, «Повторный визит» и партнёры берут за неё **0**. Пример: «Первичный приём» 100 000; Каримову в его окне вписали цену только «Повторному приёму» и сохранили → его «Первичный приём» — **0** везде, партнёры получат «0 сум»; чтобы брать 100 000, вписать 100 000 в его строку. Общая цена вида (100 000) достаётся только врачу, которого в этом окне ни разу не сохраняли. Подпись окна и карточка врача («0 сум · цена не введена») говорят это прямо — стоит пройтись по врачам в «Консультациях врачей» и вписать цены.
- **Решено контролёром (Р19, владелец может пересмотреть):** после обновления все врачи скрыты; администратор включает каждого. Пример: 12 врачей, у 9 заполнены ФИО на русском и специальность → партнёрам не уходит никто, пока администратор не включит 9 переключателей. Иначе (сразу показывать этих 9) — одна строка в миграции 243, до выпуска.
- **Решено контролёром (Р20, владелец может пересмотреть):** «Сейчас ждут приёма» считает всех с талоном к врачу, кого ещё не приняли, и неоплативших тоже. Пример: 2 оплатили и ждут, 1 с талоном идёт в кассу, 1 в кабинете → партнёры видят **3** (только оплатившие — было бы **2**).
- Решение 8 в действии: окно записи и CRM теперь предлагают консультации каждого врача (категория «Врачи») по общей цене вида, даже если в «Консультациях врачей» у него ничего не настроено. Пример: 3 вида × 20 врачей — до 60 строк в группе «Консультации». Убрать консультацию у врача — снять «Ведёт».
- Тесты больше не занимают порт анализаторов 2575 на машине, где запущен Easy-Med (Р18): раньше прогон тестов мог на время забрать порт у работающей программы.
- «Стаж (лет)» стал «Работает врачом с <год>»: год посчитан при обновлении (2026 минус стаж) — проверить в карточках врачей; дальше стаж растёт сам.
- Длительность консультации задаётся в «Настройки → Виды консультаций» (по умолчанию 30 минут, как раньше); там же — какой вид партнёры получают как «первичный» и «повторный».
- Окна для партнёров — 15 минут у всех врачей (как в макете); 30-минутный первичный приём партнёры увидят только там, где свободны два окна подряд.
- «Что увидят партнёры» показывает сохранённый график: после правки «Рабочего времени» — сначала сохранить.
- Фото для партнёров загружается из карточки сотрудника (администратор или «Сотрудники: Изменение») и из «Моего профиля»; в филиале фото врача главного здания меняется только в главном.
- Показ врача включает только администратор; врач видит в «Моём профиле», показывают ли его.
- Врач скрытого с сайта филиала скрыт вместе с ним — карточка об этом говорит.
- Филиал на старой версии покажет показ и языки врача только после обновления.

## Не входит

| Что | Почему |
|---|---|
| Сам API: `/doctors`, `/slots`, `/requests`, снимок наружу, открытый адрес фото | Шаг 8; этот шаг готовит функции (`doctorIsPublic`, `doctorConsultations`, `doctorConsultServices`, `doctorDayWindows`, `doctorQueueWaiting`). |
| Экран «Услуги»: вкладка «Консультации» с врачами, переключатель показа услуги, предупреждение «услуга без исполнителя» | Шаг 6 (решение 12 — экранная сторона). |
| «нет перевода» в «Моём профиле» | В макете «Моего профиля» нет; его поля — свои (ФИО по частям, степень списком). |
| Отдельная длина окна для партнёров у врача | Макет: «Длина окна 15 минут — одинаково для всех врачей». |
| Своя длительность консультации у врача | Макет и документация API: длительность — у вида («сколько указано в услуге»). |
| «Что увидят партнёры» по несохранённому графику | Превью считает сервер тем же движком, что запись; подсказка говорит «по сохранённому графику». |
| Съёмка фото веб-камерой в карточке | В макете только «Загрузить фото»; камера есть в «Моём профиле». |
| «Болезни и симптомы» в карточке | В макете карточки нет; правятся в «Моём профиле» (решение 10 — только главное здание — уже соблюдено 409). |
| Ограничение консультаций по `user_branches` | Здание врача — `users.branch_id` (ответ владельца A в шаге 4, вопрос 1). |
| CRM: каталог врачей по `role = 'doctor'` (врач-администратор в CRM не виден) | Прежняя граница CRM, не часть решения 8; шаг 5 добавляет только `is_doctor` в колонки для правила «ведёт». Сказать контролёру как отдельную находку. |
| Удаление колонки `experience_years` и поля «Стаж (лет)» из базы | Только ADD COLUMN; колонку читают филиалы старой версии. |
| «Предложить другое время» / «Отклонить» и прочие пункты CRM из аудита | Шаги 7–8 (аудит-критик, раздел A). |
| Плашки «новое» у полей макета | Пометка для проверки макета владельцем, не часть экрана. |
| Общая цена вида для строки врача с пустой ценой | Решение владельца 13: такая строка — 0 везде, в том числе партнёрам; общая цена — только врачу без строки (решение 8). |
| Перевод существующих строк с пустой ценой в «общую цену» или в цену вида | Решение 13 оставляет 0; цены вписывает клиника (подпись окна и карточка говорят это). |
| Звёздочка «обязательно» у ФИО RU | ФИО RU обязательно только у показываемого врача и при стирании (Р3); отказ называет поле у самого поля. |
| Текст права «Свободное время» до слияния шага 7 | Файла `api-connections.js` в дереве шага 4 нет — задача 18 после слияния. |
