# API клиники, шаги 1–2: существующие ошибки и справочники (CLINIC_API_FIX_V1, REFERENCE_LISTS_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** убрать 11 ошибок, найденных проверкой влияния, и расширить справочник специальностей до 121 с экраном «Справочники» — до начала работ по API клиники.

**Architecture:** точечные правки в существующих файлах, каждая — с тестом, который сначала падает. Без новых таблиц; одна новая RPC не нужна. Справочник специальностей — `public/js/shared/specialty-list.js` (зашит в программу, из medcore не читается — решение владельца GEO_HARDCODE_V1 / SPECIALTIES_CLONED_V1). Экран «Справочники» — только просмотр, данные: таблицы `countries` / `regions` / `districts` (миграция 132: `code`, `name_uz`, `name_en`) и `SPECIALTY_ROWS`.

**Tech Stack:** Node 24 ESM, better-sqlite3, express, `node:test`; клиент — ванильный JS без сборки, поддельный DOM в тестах видов.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — договор. Технические находки с файлами и строками: `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\impact-review\0*.md` (номера строк — на коммит `03c13db`; перед правкой найти место заново).

---

## Правила общего рабочего дерева (читать до первого шага)

- Дерево `C:\Users\user\Desktop\implementation workflow\easymed.local`, ветка `feat/stock-own-shelf-suppliers-vat`. Ветку не переключать, worktree не создавать (worktree стирает `node_modules`), не пушить, тег не ставить.
- **Запрещено:** `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`. Не трогать сервер dev и каталог `data/`.
- **Перед каждым коммитом:** `git status --short`; `git diff --cached --name-only` пуст; для каждого своего файла `git diff -U0 -- <файл>` — только свои ханки. Есть чужие ханки — остановиться и доложить (статус BLOCKED).
- Каждая своя вставка в общих файлах (`public/js/admin/i18n-strings.js`, `public/js/admin.js`, `server/db/schema-registry.js`, `public/js/shared/permission-catalog.js`) несёт метку задачи (`CLINIC_API_FIX_V1` или `REFERENCE_LISTS_V1`) в комментарии блока или хвосте строки.
- Миграций в этих шагах нет. Если без миграции не обойтись — остановиться и доложить (номер будет 237+).
- Файлы — LF. Сообщение коммита — файлом: Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-<задача>.txt`, затем `git commit -F <файл>`. По-русски, с меткой в скобках, последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Тесты — только явными путями, из корня дерева: `node --test <файлы>` (серверные), `node --experimental-vm-modules --test <файлы>` (клиентские `.mjs`). Тест-харнессы экранов задают `admin.lang` = `'ru'` (ловушка локали CI: `easymed-ci-locale-trap`).
- Любой новый текст интерфейса — с переводом ru / uz / en в `public/js/admin/i18n-strings.js` (тест `i18n-coverage.test.mjs`); сообщения сервера — в словаре (`server/i18n-server-messages.test.js`).
- Полный прогон делает контролёр после всех задач (в т. ч. в английской среде).

---

## Task 1: Карточка сотрудника не стирает узбекские названия и коды специальностей (CLINIC_API_FIX_V1)

**Files:**
- Modify: `server/routes/users.js` (`writeSpecialties`, ~451-455)
- Modify: `public/js/admin/views/employees.js` (сборка тела сохранения, ~950-951)
- Test: `server/routes/users.test.js` (или новый `server/routes/users.specialties.test.js`), `public/js/admin/__tests__/employees-*.test.mjs` (подходящий)

**Сейчас:** админское сохранение пишет в `user_specialties` только `specialty_slug` + `name_ru`, `name_uz` становится NULL; названия вне канонического списка теряют slug. Карточка отправляет список специальностей при каждом сохранении (даже если меняли только зарплату).

- [ ] **Step 1: падающий серверный тест.** Врач со специальностью «Кардиолог» (slug `kardiolog`, name_uz `Kardiolog`) в `user_specialties`. Админ `PATCH /api/users/:id` с `specialties: ['Кардиолог']` → в `user_specialties` строка `kardiolog / Кардиолог / Kardiolog`. Сейчас `name_uz` NULL — тест падает.
- [ ] **Step 2: падающий клиентский тест.** Открыть карточку, поменять только поле зарплаты/телефона, сохранить → тело запроса НЕ содержит `specialties` (и `specialty`). Поменять специальность → содержит.
- [ ] **Step 3: правка.** `writeSpecialties` находит строку в `SPECIALTY_ROWS` (через `canonicalSpecialty` из `public/js/shared/specialty-list.js` — сервер уже импортирует этот модуль для отчётов) и пишет `specialty_slug`, `name_ru`, `name_uz`; для значения вне списка — slug NULL, `name_ru` как есть, `name_uz` NULL (как сейчас для таких). Карточка добавляет `specialties`/`specialty` в тело, только если список отличается от загруженного.
- [ ] **Step 4:** оба теста зелёные; прогнать файлы тестов карточки (`employees-*`, `employee-editor-save-reenable`) и `users*.test.js`.
- [ ] **Step 5: коммит** «Карточка сотрудника больше не стирает узбекские названия специальностей (CLINIC_API_FIX_V1)».

## Task 2: Карточка и «Мой профиль» не затирают друг друга (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin/views/doctor-profile.js` (сбор тела ~217-235)
- Modify: `server/services/rpc/doctor-profile.js` (`update_my_doctor_profile` ~198)
- Modify: `public/js/admin/views/employees.js` (`profileSection` / сбор `public_profile`)
- Test: `public/js/admin/__tests__/doctor-profile-save.test.mjs`, `server/services/rpc/doctor-profile.test.js`, клиентский тест карточки

**Сейчас:** «Мой профиль» отправляет все ключи профиля при каждом сохранении — правка администратора, сделанная после открытия экрана врачом, откатывается. Админ отправляет весь `public_profile`. RPC не обновляет `updated_at`.

- [ ] **Step 1: падающие тесты.** (a) «Мой профиль»: загрузить профиль, поменять только биографию RU, сохранить → в `p` только `bio_ru` (плюс специальности/условия, только если менялись). (b) карточка: поменять только `bio_uz` → в `public_profile` только `bio_uz`. (c) RPC: после сохранения `updated_at` строки врача изменился.
- [ ] **Step 2: правка.** Оба экрана запоминают загруженные значения и отправляют только отличающиеся ключи (фото — как сейчас, только новое). Пустой набор изменений — сохранение не отправляется, сообщение «Нет изменений». Сервер: `update_my_doctor_profile` принимает частичный набор (уже по PROFILE_KEYS) и пишет `updated_at = now`. Специальности и условия в RPC — только если переданы.
- [ ] **Step 3:** тесты зелёные; прогнать `doctor-profile*`, `159.test.js`, `users.public-profile.test.js`, `employees-*`.
- [ ] **Step 4: коммит** «Карточка сотрудника и «Мой профиль» сохраняют только изменённые поля (CLINIC_API_FIX_V1)».

## Task 3: «Ведёт» и «Бесплатно» читаются верно (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin/views/consultation-types.js` (~323), `public/js/admin/views/service-picker-modal.js` (~253, ~498), `public/js/admin/views/service-workspace.js` (~1433)
- Test: клиентский тест на каждый экран (новый `consultation-flags.test.mjs` или в существующих `consultation-types`/`service-picker-*`)

**Сейчас:** база отдаёт 0/1, экраны сравнивают с `false`/`true`: снятая «Ведёт» возвращается отмеченной, «Бесплатно» — снятой; окно записи может предлагать консультацию, которую врач не ведёт.

- [ ] **Step 1: падающие тесты.** Строка `doctor_consultation_prices { available: 0, is_free: 1 }` → окно «Консультации врачей» показывает «Ведёт» снятой и «Бесплатно» отмеченной; окно записи этому врачу эту консультацию не предлагает; в рабочем месте врача — так же.
- [ ] **Step 2: правка.** Одна маленькая функция приведения (`isOn(v)`: `v === true || v === 1 || v === '1'`) в общем модуле (например, `public/js/shared/flags.js`) и её использование во всех четырёх местах. Не трогать `crm.js:1839` (там уже верно) — но можно перевести на ту же функцию.
- [ ] **Step 3:** тесты зелёные; прогнать `service-picker-*`, `picker-invoice`, `walk-in-booking`, `crm-card`.
- [ ] **Step 4: коммит** «Консультации врачей: «Ведёт» и «Бесплатно» читаются верно (CLINIC_API_FIX_V1)».

## Task 4: CRM показывает цену консультации врача, а не общую (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin/views/crm.js` (~1833-1881)
- Test: `public/js/admin/__tests__/crm-card.test.mjs` (или новый)

**Сейчас:** в окне заявки цена консультации всегда из `consultation_types.price`, даже когда у врача своя строка цены. Касса берёт цену врача (`consultationFor`, `server/services/domain/pricing.js:170-184`).

- [ ] **Step 1: падающий тест.** Тип «Первичный приём» 100 000; у врача строка 150 000 → карточка заявки показывает 150 000. У другого врача строки нет → 100 000 (как касса сейчас). Строка с `is_free: 1` → «Бесплатно» (0).
- [ ] **Step 2: правка.** В CRM — то же правило, что `consultationFor`: строка врача → её цена (или 0 при `is_free`), иначе цена типа. Правило «нет строки — консультация не предлагается» (окно записи) не трогать — это решение владельца, вне шага.
- [ ] **Step 3:** тесты зелёные; `crm-*`, `service-picker-crm`.
- [ ] **Step 4: коммит** «CRM: цена консультации — врача, как в кассе (CLINIC_API_FIX_V1)».

## Task 5: «Мой профиль» во втором здании не теряет правки (CLINIC_API_FIX_V1)

**Files:**
- Modify: `server/services/rpc/doctor-profile.js` (`update_my_doctor_profile`)
- Modify: `public/js/admin/views/doctor-profile.js` (показ ответа)
- Test: `server/services/rpc/doctor-profile.test.js`

**Сейчас:** админское сохранение сотрудника, пришедшего из главного здания, отказывает (409, `server/routes/users.js:~633`, проверка «не свой»); RPC врача сохраняет, а часовая синхронизация каталога затирает правку.

- [ ] **Step 1: падающий тест.** Врач — запись, пришедшая из главного здания (тот же признак, что проверяет `users.js:~633`) → `update_my_doctor_profile` отвечает 409 с переводимым сообщением «Профиль врача меняется в главном здании» и ничего не пишет. Свой врач — сохраняется как раньше.
- [ ] **Step 2: правка.** Та же проверка, что в админском сохранении (вынести в общий помощник, если она одна строка — повторить с ссылкой). Экран показывает сообщение и не делает вид, что сохранил.
- [ ] **Step 3:** тесты зелёные; `staff-sync-readonly.test.js`, `catalogue.test.js`.
- [ ] **Step 4: коммит** «Мой профиль во втором здании: сохранение отказывает, а не теряется при синхронизации (CLINIC_API_FIX_V1)».

## Task 6: CRM не ставит время врачу с живой очередью (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin/views/crm.js` (запись из заявки ~2388, ~2484-2527)
- Test: `public/js/admin/__tests__/crm-*.test.mjs` (подходящий) или новый

**Сейчас:** окно визита и выбор услуг пропускают выбор времени для врачей `users.scheduling_mode = 'live_queue'` (`visit-wizard.js:~711-716, ~2664-2690`, `service-picker-modal.js:~2147-2174`); CRM записывает таким врачам на время.

- [ ] **Step 1: падающий тест.** Врач с `scheduling_mode: 'live_queue'`: запись из карточки заявки не открывает выбор времени и создаёт визит так же, как окно визита для живой очереди (дата без времени / очередь). Врач `schedulable` — как сейчас.
- [ ] **Step 2: правка.** Повторить в CRM путь окна визита для живой очереди (тот же вызов и те же параметры — найти в `visit-wizard.js`), без собственной логики.
- [ ] **Step 3:** тесты зелёные; `crm-*`, `crm-calendar-mirror.test.js`, `wizard-booking`, `walk-in-booking`.
- [ ] **Step 4: коммит** «CRM: врачу с живой очередью запись без времени, как в окне визита (CLINIC_API_FIX_V1)».

## Task 7: Документы Telegram — с текущим логотипом и названием (CLINIC_API_FIX_V1)

**Files:**
- Modify: `server/services/telegram/render.js` (~73-83), при необходимости `public/js/shared/doc-render.js` (~483)
- Test: `server/services/telegram/*.test.js` (новый `render-branding.test.js`)

**Сейчас:** настройки для PDF собираются из сохранённой копии `doc_branding` (там старые название/логотип компании) поверх `doc_settings`, а не наоборот. Печать из браузера (`public/js/admin/views/doc-settings.js` `applyCompanyBranding` ~150-171) кладёт данные компании сверху.

- [ ] **Step 1: падающий тест.** `doc_branding.settings` хранит старый логотип A и название «Старая», `doc_settings` — логотип B и «Новая» → настройки, переданные в рендер PDF, содержат B и «Новая».
- [ ] **Step 2: правка.** В `render.js` — тот же порядок, что `applyCompanyBranding`: оформление из `doc_branding`, поля компании (название, адрес, телефон, почта, лицензия, логотип, цвет) — из `doc_settings` поверх.
- [ ] **Step 3:** тесты зелёные; `telegram/*.test.js`, `print-v3120`, `fiscal-receipt`.
- [ ] **Step 4: коммит** «Telegram: документы с текущими логотипом и названием клиники (CLINIC_API_FIX_V1)».

## Task 8: Название клиники под меню — сразу после входа и после «Компании» (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin.js` (~2751-2754, путь входа по форме), `public/js/admin/views/documents-settings.js` (после сохранения ~234-265)
- Test: `public/js/admin/__tests__/clinic-context.test.mjs` или новый

- [ ] **Step 1: падающие тесты.** (a) после входа по форме `.brand-sub` содержит название клиники без перезагрузки; (b) после сохранения «Компании» с новым названием `.brand-sub` и `window.CLINIC.name` — новые.
- [ ] **Step 2: правка.** Одна функция «обновить бренд» (перечитать `get_clinic_by_slug`, обновить `window.CLINIC` и `.brand-sub`), вызывать после `boot()`, после входа по форме и после сохранения «Компании».
- [ ] **Step 3:** тесты зелёные; `settings-split`, `app-shell`.
- [ ] **Step 4: коммит** «Название клиники под меню обновляется после входа и после «Компании» (CLINIC_API_FIX_V1)».

## Task 9: Импорт Excel соблюдает правило «онлайн-записи» (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin/views/section-import-export.js` (~511-516)
- Test: `public/js/admin/__tests__/full-export.test.mjs` или новый `import-online-booking.test.mjs`

**Сейчас:** окно услуги не даёт включить `online_booking` без узбекского названия (`server/services/rpc/service-save.js:~126-129`); импорт пишет флаг напрямую.

- [ ] **Step 1: падающий тест.** Строка импорта: `online_booking = 1`, `name_uz` пуст → услуга сохраняется с `online_booking = 0`, в итогах импорта предупреждение «онлайн-запись не включена: нет названия на узбекском» с номером строки. С `name_uz` — включается.
- [ ] **Step 2: правка** в импорте; текст — через словарь.
- [ ] **Step 3:** тесты зелёные; `full-export`, `131.test.js`, `service-save.test.js`.
- [ ] **Step 4: коммит** «Импорт Excel: онлайн-запись — только с узбекским названием, как в окне услуги (CLINIC_API_FIX_V1)».

## Task 10: «пакет» в чеке — только у пакета со скидкой (CLINIC_API_FIX_V1)

**Files:**
- Modify: `public/js/admin/views/receipt-print.js` (~394-401)
- Test: `public/js/admin/__tests__/print-v3120.test.mjs` или `fiscal-receipt.test.mjs`

- [ ] **Step 1: падающий тест.** Строка счёта с `package_id` шаблона с `discount_percent = 0` → в чеке нет «пакет "X"»; с `discount_percent = 15` → есть, как сейчас.
- [ ] **Step 2: правка** (до отметки «пакет» из шага 6).
- [ ] **Step 3:** тесты зелёные; печатные тесты.
- [ ] **Step 4: коммит** «Чек: «пакет» — только у пакета со скидкой (CLINIC_API_FIX_V1)».

## Task 11: Фото врача — только из своей папки (CLINIC_API_FIX_V1)

**Files:**
- Modify: `server/services/rpc/doctor-profile.js` (~88-94)
- Test: `server/services/rpc/doctor-profile.test.js`, при необходимости `photo-storage.test.js`

- [ ] **Step 1: падающий тест.** Врач 5 сохраняет `photo_url` с путём `doctors/7/...` → отказ (400, переводимое сообщение); `doctors/5/...` → принимается; путь с `..` → отказ.
- [ ] **Step 2: правка:** путь обязан начинаться с `/api/storage/doctor-photos/doctors/<id врача>/` и не содержать `..`.
- [ ] **Step 3:** тесты зелёные.
- [ ] **Step 4: коммит** «Фото врача — только из его собственной папки (CLINIC_API_FIX_V1)».

## Task 12: Специальности — 121 (REFERENCE_LISTS_V1)

**Files:**
- Modify: `public/js/shared/specialty-list.js` (`SPECIALTY_ROWS`)
- Modify: `public/js/admin/i18n-strings.js` (переводы новых названий)
- Modify: `public/js/admin/__tests__/specialties-cloned.test.mjs`

**Владелец (2026-10-06):** «add another 50+». Сохраняемое значение — по-прежнему русское название; документы и отчёты не меняются.

68 новых строк (slug — латиница по образцу существующих; uz — латиница с ‘; en):

| slug | ru | uz | en |
|---|---|---|---|
| angiolog | Ангиолог | Angiolog | Angiologist |
| audiolog-surdolog | Аудиолог-сурдолог | Audiolog-surdolog | Audiologist |
| bariatricheskiy-hirurg | Бариатрический хирург | Bariatrik jarroh | Bariatric Surgeon |
| vertebrolog | Вертебролог | Vertebrolog | Vertebrologist |
| virusolog | Вирусолог | Virusolog | Virologist |
| kt-mrt | Врач КТ и МРТ | KT va MRT shifokori | CT and MRI Radiologist |
| vrach-lfk | Врач ЛФК | DJT shifokori | Exercise Therapy Physician |
| vrach-laborant | Врач-лаборант | Laboratoriya shifokori | Clinical Laboratory Physician |
| gepatolog | Гепатолог | Gepatolog | Hepatologist |
| geriatr | Гериатр | Geriatr | Geriatrician |
| ginekolog-endokrinolog | Гинеколог-эндокринолог | Ginekolog-endokrinolog | Gynecologic Endocrinologist |
| defektolog | Дефектолог | Defektolog | Defectologist |
| detskiy-allergolog | Детский аллерголог | Bolalar allergologi | Pediatric Allergist |
| detskiy-gastroenterolog | Детский гастроэнтеролог | Bolalar gastroenterologi | Pediatric Gastroenterologist |
| detskiy-gematolog | Детский гематолог | Bolalar gematologi | Pediatric Hematologist |
| detskiy-ginekolog | Детский гинеколог | Bolalar ginekologi | Pediatric Gynecologist |
| detskiy-dermatolog | Детский дерматолог | Bolalar dermatologi | Pediatric Dermatologist |
| detskiy-infeksionist | Детский инфекционист | Bolalar infeksionisti | Pediatric Infectious Disease Specialist |
| detskiy-kardiolog | Детский кардиолог | Bolalar kardiologi | Pediatric Cardiologist |
| detskiy-lor | Детский ЛОР | Bolalar LOR shifokori | Pediatric ENT |
| detskiy-nefrolog | Детский нефролог | Bolalar nefrologi | Pediatric Nephrologist |
| detskiy-onkolog | Детский онколог | Bolalar onkologi | Pediatric Oncologist |
| detskiy-oftalmolog | Детский офтальмолог | Bolalar oftalmologi | Pediatric Ophthalmologist |
| detskiy-psihiatr | Детский психиатр | Bolalar psixiatri | Child Psychiatrist |
| detskiy-psiholog | Детский психолог | Bolalar psixologi | Child Psychologist |
| detskiy-pulmonolog | Детский пульмонолог | Bolalar pulmonologi | Pediatric Pulmonologist |
| detskiy-revmatolog | Детский ревматолог | Bolalar revmatologi | Pediatric Rheumatologist |
| detskiy-travmatolog-ortoped | Детский травматолог-ортопед | Bolalar travmatolog-ortopedi | Pediatric Orthopedist |
| detskiy-urolog-androlog | Детский уролог-андролог | Bolalar urolog-andrologi | Pediatric Urologist-Andrologist |
| detskiy-endokrinolog | Детский эндокринолог | Bolalar endokrinologi | Pediatric Endocrinologist |
| implantolog | Имплантолог | Implantolog | Dental Implantologist |
| kardiolog-aritmolog | Кардиолог-аритмолог | Kardiolog-aritmolog | Cardiac Electrophysiologist |
| kinezioterapevt | Кинезиотерапевт | Kinezioterapevt | Kinesiotherapist |
| kosmetolog | Косметолог | Kosmetolog | Cosmetologist |
| manualnyy-terapevt | Мануальный терапевт | Manual terapevt | Manual Therapist |
| massazhist | Массажист | Massajchi | Massage Therapist |
| medicinskiy-psiholog | Медицинский психолог | Tibbiy psixolog | Clinical Psychologist |
| mikrobiolog | Микробиолог | Mikrobiolog | Microbiologist |
| neonatolog | Неонатолог | Neonatolog | Neonatologist |
| nutriciolog | Нутрициолог | Nutritsiolog | Nutritionist |
| onkoginekolog | Онкогинеколог | Onkoginekolog | Gynecologic Oncologist |
| onkolog-mammolog | Онколог-маммолог | Onkolog-mammolog | Breast Oncologist |
| osteopat | Остеопат | Osteopat | Osteopath |
| oftalmohirurg | Офтальмохирург | Oftalmojarroh | Ophthalmic Surgeon |
| parazitolog | Паразитолог | Parazitolog | Parasitologist |
| parodontolog | Пародонтолог | Parodontolog | Periodontist |
| profpatolog | Профпатолог | Kasb kasalliklari shifokori | Occupational Medicine Physician |
| radioterapevt | Радиотерапевт | Radioterapevt | Radiation Oncologist |
| seksolog | Сексолог | Seksolog | Sexologist |
| somnolog | Сомнолог | Somnolog | Sleep Medicine Specialist |
| sportivnyy-vrach | Спортивный врач | Sport shifokori | Sports Medicine Physician |
| stomatolog-gigienist | Стоматолог-гигиенист | Stomatolog-gigiyenist | Dental Hygienist |
| stomatolog-ortoped | Стоматолог-ортопед | Stomatolog-ortoped | Prosthodontist |
| stomatolog-terapevt | Стоматолог-терапевт | Stomatolog-terapevt | Restorative Dentist |
| toksikolog | Токсиколог | Toksikolog | Toxicologist |
| torakalnyy-hirurg | Торакальный хирург | Torakal jarroh | Thoracic Surgeon |
| transfuziolog | Трансфузиолог | Transfuziolog | Transfusiologist |
| triholog | Трихолог | Trixolog | Trichologist |
| foniatr | Фониатр | Foniatr | Phoniatrist |
| ftiziatr | Фтизиатр | Ftiziatr | Phthisiatrician (TB Specialist) |
| himioterapevt | Химиотерапевт | Ximioterapevt | Medical Oncologist (Chemotherapy) |
| hirurg-onkolog | Хирург-онколог | Jarroh-onkolog | Surgical Oncologist |
| chelyustno-licevoy-hirurg | Челюстно-лицевой хирург | Yuz-jag‘ jarrohi | Maxillofacial Surgeon |
| embriolog | Эмбриолог | Embriolog | Embryologist |
| endodontist | Эндодонтист | Endodontist | Endodontist |
| endoskopist | Эндоскопист | Endoskopist | Endoscopist |
| epileptolog | Эпилептолог | Epileptolog | Epileptologist |

- [ ] **Step 1: падающий тест** в `specialties-cloned.test.mjs`: 121 строка, slug уникален и ASCII, у каждой ru/uz/en, перевод в словаре; все 68 slug из таблицы присутствуют с указанными ru/uz/en; пример «значение вне списка» заменить с «Косметолог» (теперь в списке) на «Гирудотерапевт» (не в списке). Существующие тесты про Иглотерапевта/Нейрофизиолога не ломать.
- [ ] **Step 2: правка.** Новые строки — на алфавитные места по русскому названию (`localeCompare(…, 'ru')`) среди существующих; порядок существующих 53 не менять (Подолог остаётся последним). Тест проверяет: каждая новая строка стоит между соседями, которые по этому сравнению не больше и не меньше её. Переводы в `i18n-strings.js` (формат как у существующих специальностей, метка `REFERENCE_LISTS_V1`). Комментарий над списком: «121 — 53 + 68 по слову владельца 2026-10-06 (REFERENCE_LISTS_V1)».
- [ ] **Step 3:** тесты зелёные; `i18n-coverage`, `i18n-uz-quality`, `specialties-cloned`, `doctor-profile-save`, отчёты по специальностям (`reports.doctor-lines`), `employees-*`.
- [ ] **Step 4: коммит** «Специальности: 121 — добавлены 68 со slug, uz и en (REFERENCE_LISTS_V1)».

## Task 13: Экран «Справочники» — только просмотр (REFERENCE_LISTS_V1)

**Files:**
- Create: `public/js/admin/views/reference-lists.js`
- Modify: `public/js/admin/views/settings-hub.js` (плитка), `public/js/admin.js` (маршрут, `PARENT_OF`, отрисовка), `public/js/shared/permission-catalog.js` (если плитке нужно право — по образцу плиток «Настроек» только для чтения), `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/reference-lists.test.mjs`, `route-gate.test.mjs` (новая запись), `db-query-schema` (колонки запросов)

**Экран (по макету «Справочники»):** вкладки «Города и районы» и «Специальности». Слева регионы Узбекистана (название ru, под ним uz · en, число районов), справа районы выбранного региона: код, RU, UZ, EN. «Специальности»: код, RU, UZ, EN (из `SPECIALTY_ROWS`). Подсказка: «Общие списки: одинаковые у всех клиник и партнёров; партнёры получают коды. Список обновляется вместе с программой». Ничего не редактируется. «География» в «Настройках» остаётся как есть.

- [ ] **Step 1: падающие тесты.** Экран строит вкладки; «Города и районы» показывает 14 регионов с кодами из `regions.code`; выбор «город Ташкент» показывает 12 районов с `code`, `name_uz`, `name_en`; «Специальности» — 121 строка. Запросы к `/api/db` называют только колонки, которые есть в реестре (`db-query-schema`). Маршрут проходит `route-gate`.
- [ ] **Step 2: реализация** по образцу существующих экранов «Настроек» (найти похожий вид только для чтения); если реестр не отдаёт `code` / `name_uz` / `name_en` для `regions` / `districts` / `countries` — добавить их в список чтения (метка `REFERENCE_LISTS_V1`), без записи.
- [ ] **Step 3:** тесты зелёные; `route-gate`, `settings-hub-groups`, `i18n-coverage`, `db-query-schema`, `schema-registry*`.
- [ ] **Step 4: коммит** «Настройки → «Справочники»: города, районы и специальности с кодами, только просмотр (REFERENCE_LISTS_V1)».

---

## Завершение (контролёр)

- Полный набор тестов: `npm test` (как в выпуске) и прогон с английской локалью (предзагрузка force-en, см. память `easymed-ci-locale-trap`).
- Отдельная проверка, которая пытается сломать результат (adversarial review) по всем задачам.
- `git push` ветки (владелец: «после изменений — пушить»); тег — только по слову владельца.
- Заметки к выпуску (`RELEASE_NOTES.md` + `release-notes.test.mjs`) — при подготовке выпуска, не в этом плане.
