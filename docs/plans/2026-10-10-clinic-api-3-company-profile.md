# API клиники, шаг 3: профиль клиники и логотипы (CLINIC_PROFILE_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** «Компания» становится профилем клиники для сайта, Symptex и партнёров. В ней появляются:
- названия и описание на трёх языках;
- адрес главного здания из справочника (коды миграции 132) и улица на трёх языках;
- два прозрачных PNG-логотипа файлами;
- сайт, Telegram и Instagram;
- карта и маршрут.

Документы при этом печатают то же, что печатали.

**Architecture:**
- Профиль живёт в той же единственной строке `doc_settings` (id = 1, миграция 008 — это таблица, не файл). Миграция 240 только добавляет колонки (ADD COLUMN), без пересборки.
- Правила ссылок и адреса — в чистом общем модуле `public/js/shared/clinic-profile.js`. Его читают экран, `/api/db` (страж филиала) и синхронизация зданий.
- Правила логотипов — в `public/js/shared/clinic-logo-rules.js`. Его читают экран до отправки и хранилище после.
- Файлы логотипов лежат в новой корзине хранилища `clinic-logos`.
- Печатная копия квадратного логотипа остаётся data URL в прежней колонке `logo_data_url`. Её уже читают все бланки, PDF Telegram и синхронизация зданий, поэтому ни один читатель не меняется.
- Каскад «Страна → Регион → Район» выносится из окна пациента в отдельный модуль и получает режим «по коду».

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, `node:test`; клиент — ванильный JS без сборки, поддельный DOM в тестах видов.

**Спецификация:** `docs/specs/2026-10-06-clinic-api-design.md` — договор (разделы «Решения владельца», «Правила, без которых не строим», «Порядок» шаг 3).

**Другие источники:**
- Макет экрана — `C:\Users\user\Desktop\EasyMed Clone\mockups\api-settings\js\screen-company.js`, `ref.js` (`geoCascade`, `fullAddress`), `mock.css`.
- Находки проверки влияния — `...\impact-review\01-clinic-identity.md`, `02-branches-schedules.md`.

Номера строк ниже сверены с деревом 2026-10-10 (HEAD `ee05700f`). Перед правкой место всё равно находить заново.

**Метка кода:** `CLINIC_PROFILE_V1` — в комментарии каждой своей вставки (в общих файлах — обязательно, по ней коммитятся свои ханки).

---

## Решения плана

| # | Решение | Почему |
|---|---|---|
| Р1 | Профиль — новые колонки `doc_settings` (миграция 240, ADD COLUMN + одна UPDATE-отметка). | `doc_settings` — таблица из одной строки (008), её уже читают печать, `get_clinic_by_slug`, Telegram и синхронизация. |
| Р2 | Документы печатают `doc_settings.clinic_name` (RU) — как раньше. `name_uz`/`name_en` идут наружу (API, шаги 7–8), под меню — на языке интерфейса и в узбекской строке Telegram. | Правило спецификации «документы печатают прежние имена». |
| Р3 | **Адрес для документов** (`doc_settings.address`) собирается из выбранного (город/область, район, улица RU), пока клиника не исправит его руками (`address_manual = 1`). У клиник, которые уже вписали адрес, миграция ставит `address_manual = 1`: после обновления бланк печатает то же. Собранная пустая строка прежний адрес не стирает. Кнопка «Собрать из списков» возвращает сборку. | Ни один бланк не меняется сам при обновлении. Новая клиника получает адрес из списков без двойного ввода. **Владельцу — вопрос 1 (подтвердить).** |
| Р4 | **Логотипы.** Два PNG-файла с прозрачностью в корзине `clinic-logos`: `square/<ключ>.png` и `portrait/<ключ>.png`. Пути лежат в `logo_square_path` / `logo_portrait_path`. Вместе с квадратным экран делает **печатную копию**: PNG 220 px, не больше 90 000 знаков, те же пределы, что у прежнего единственного логотипа. Копия пишется в прежний `logo_data_url`. | Файл — источник, data URL — производная копия для печати. Её без изменений читают: `rpc/clinic.js` → `window.CLINIC.logo_url`; бланки браузера (`company-branding.js`); PDF Telegram (Chrome печатает из `file://` и не достанет `/api/storage`); синхронизация зданий (файлы между зданиями не ездят). |
| Р5 | Квадратный логотип заменяет прежний и в печати, и в шапке программы: знак меню `#sidebar-logo` показывает его вместо «+», если печатная копия квадратная. Вертикальный идёт только партнёрам и в API. | Решение владельца (макет: «квадратный идёт и в шапку программы, и в печатные документы»). |
| Р6 | **Прежний логотип (base64).** При запуске сервера он копируется файлом `clinic-logos/legacy/logo-<хеш>.<расширение>`. Строку базы копирование не меняет; повторный запуск ничего не пишет: имя файла — по содержимому. Прежний логотип печатается, пока не загружен квадратный. Партнёрам как «квадратный» он не отдаётся: не проверен на форму и прозрачность, всего 220 px. | «Мигрировать безопасно, никогда не терять»: копия-файл переживает замену. Копии хранилища резервное копирование уже включает (`services/backup.js`). |
| Р7 | «Удалить» логотип снимает его с бланков (колонки становятся пустыми строками), а файл остаётся. DELETE в `clinic-logos` сервер отклоняет — как у фото врача и пациента. | Восстановление копии откатывает строки, а файлы только сливает: вчерашняя ссылка обязана открыться (довод `routes/storage.js` про фото). |
| Р8 | **Название рядом с логотипом.** Правило LOGO_WORDMARK_V1 (`public/js/shared/doc-render.js:477-481`) снимается **до** появления квадратного логотипа (задача 2): шапка печатает название всегда. | Правило спецификации «логотип не прячет название». |
| Р9 | **География.** Каскад регистрации пациента выносится в `views/geo-cascade.js` (не копия). Режим `by: 'code'` — значения выпадающих списков = коды из миграции 132. Строки без кода (заведённые клиникой в «Географии») в «Компании» не предлагаются. Регистрация работает как раньше (имена). | Партнёры получают коды. Спецификация: «тот же компонент, что в регистрации». |
| Р10 | **Синхронизация зданий** — по образцу `catalogue.js` (address/phone/email — свои у здания).<br>• Общее для клиники: названия, описание, сайт, Telegram, Instagram (+ уже едущие лицензия, цвет, печатная копия логотипа). Оно едет из главного, в филиале на экране только просмотр. Правку такого поля в филиале `/api/db` отклоняет 409, но лишь если значение **меняется**.<br>• Своё у здания: коды, улица, адрес для документов, карта, телефон, почта.<br>• Пути к файлам логотипов не едут: файлов в филиале нет, филиал печатает копию. | «Главное здание правит, филиалы читают». Тот же 409, что у `MAIN_CLINIC_TABLES` (`routes/db.js:321-343`) и «Моего профиля» (шаг 1). |
| Р11 | Название клиники остаётся необязательным: пустое — запасное «Easy-Med Local». | Закреплено тестом шага 1 (`clinic-brand.test.mjs`, «стёрли название…»). Обязательность нужна API — решит шаг 7. |
| Р12 | Сайт хранится как `https://…`; Telegram и Instagram — как `@имя` (вставленная ссылка урезается до имени). Маршрут не хранится, а вычисляется из ссылки Яндекс Карт (координаты `pt=`/`ll=`, иначе — сама ссылка). Форматы проверяет экран; CHECK в миграции — запасной замок для `/api/db`. | Макет; партнёры строят ссылки сами. |
| Р13 | Заполненный в «Компании» сайт печатается на бланках, которые печатают сайт (без `https://`). Работает через уже существующее `overlayCompanyBranding` (`c.website → s.web`). | «Компания» — источник контактов. **Владельцу — вопрос 2 (подтвердить).** |
| Р14 | Существующая ошибка (найдена при подготовке плана): сохранение «Компании» без логотипа отклоняется. Экран шлёт `logo_data_url: null`, колонка `NOT NULL`, ответ — 400 «Не заполнено обязательное поле doc_settings.logo_data_url.». Проверено HTTP-запросом на чистой базе 2026-10-10. | Чинится первой задачей: без неё не сохранить ничего из этого шага. |

## Карта файлов

**Создаются:**
- `server/db/migrations/240_clinic_profile.sql`, `server/db/migrations/240.test.js`
- `public/js/shared/clinic-profile.js` (+ `clinic-profile.test.js`) — колонки, ссылки, адрес
- `public/js/shared/clinic-logo-rules.js` (+ `clinic-logo-rules.test.js`) — PNG, прозрачность, размеры
- `server/test-helpers/fake-png.js` — PNG-заготовки для тестов
- `server/services/clinic-logo-legacy.js` (+ `.test.js`) — копия прежнего логотипа при запуске
- `public/js/admin/views/geo-cascade.js` (+ `__tests__/geo-cascade.test.mjs`)
- `public/js/admin/views/company-fields.js` — поле на трёх языках, строка ошибки
- `public/js/admin/views/company-address.js` — адрес и карта
- `public/js/admin/views/company-logos.js` — два логотипа
- `public/js/admin/views/company-preview.js` — «Как это увидят пациенты»
- Тесты:
  - `public/js/shared/doc-render.logo-name.test.js`
  - `public/js/admin/__tests__/company-profile.test.mjs`
  - `server/routes/company-save.test.js`
  - `server/routes/logo-storage.test.js`
  - `server/routes/company-secondary.test.js`

**Меняются:**
- Экран и печать:
  - `public/js/admin/views/documents-settings.js`
  - `public/js/admin/views/patient-create-modal.js`
  - `public/js/shared/doc-render.js`
  - `public/js/shared/company-branding.js`
- Сервер:
  - `server/routes/storage.js`
  - `server/routes/db.js`
  - `server/services/rpc/clinic.js`
  - `server/services/branch-sync/catalogue.js`
  - `server/services/telegram/{render,flow,setup,index}.js`
  - `server/index.js`
- Права, реестр, словарь:
  - `server/db/schema-registry.js`
  - `public/js/shared/permission-catalog.js`
  - `public/js/admin/i18n-strings.js`
- Оболочка: `public/js/admin/clinic-context.js`, `public/js/admin.js`
- Стили: `public/css/admin.css`, `public/css/admin-views.css`

---

## Правила общего рабочего дерева (читать до первого шага)

**Дерево.** Дерево и ветку назначает контролёр; по умолчанию — `C:\Users\user\Desktop\implementation workflow\easymed.lisproxy`, ветка `feat/lis-proxy`.
- В этом дереве параллельно работают другие сборщики. На 2026-10-10 — исправление CRM: `server/services/crm/*`, `server/index.js`, тесты CRM.
- Ветку не переключать, worktree не создавать: worktree стирает `node_modules`.
- Не пушить и не ставить тег — это делает контролёр.

**Запрещено:** `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`. Не трогать запущенные серверы (:8000, :8712) и каталог `data/`.

**Перед каждым коммитом:**
1. `git status --short`.
2. `git diff --cached --name-only` должен быть пуст. Если нет — кто-то другой собирает коммит: подождать, ничего не снимать.
3. Для каждого своего файла: `git diff -U0 -- <файл>`. Чужих ханков нет — `git add <файл>`.
4. Чужие ханки есть (общие файлы: `i18n-strings.js`, `admin.js`, `schema-registry.js`, `permission-catalog.js`, `server/index.js`, `routes/db.js`, `routes/storage.js`, `admin.css`, `admin-views.css`) — только свои ханки по метке:
   `git diff -U0 -- F | node keep-hunks-v2.mjs CLINIC_PROFILE_V1 > own.patch; git apply --cached --check --unidiff-zero own.patch; git apply --cached --unidiff-zero own.patch`.
   После этого проверить: `git diff --cached -- F` показывает свой блок на месте, `git diff -U0 -- F` — только чужие ханки. Скрипт — в скретчпаде сессии (память `easymed-shared-tree-hunk-commits`).
5. Не выходит — остановиться и доложить (BLOCKED).

**Миграция — 240.** На 2026-10-10 это следующий свободный номер: основная линия — 237, 238, 239. Перед созданием файла — `ls server/db/migrations | tail -4`. Номер занят — взять следующий свободный и переименовать файл, тест и упоминания в этом плане. Пропуски не заполнять (`migrate.js`, `migration-order.test.js`).

**Файлы и коммиты:**
- Файлы — LF.
- Сообщение коммита — файлом: Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msgs/clinic-profile-<N>.txt`, затем `git commit -F <файл>`.
- Сообщение — по-русски, с меткой в скобках; последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

**Тесты:**
- Только явными путями, из корня дерева: `node --test <файлы>` (серверные и `public/js/shared/*.test.js`), `node --experimental-vm-modules --test <файлы>` (клиентские `.mjs`).
- Каталог аргументом не передавать (Node 24 на Windows).
- Харнессы экранов задают `localStorage['admin.lang'] = 'ru'` до импорта видов (ловушка локали CI).

**Текст и вид:**
- Каждая новая строка интерфейса и каждое сообщение сервера — статьёй ru / uz / en в `public/js/admin/i18n-strings.js`, с хвостом `// CLINIC_PROFILE_V1`.
- Перед добавлением — `grep -n '^  "<ключ>":' public/js/admin/i18n-strings.js`: если статья есть, не дублировать.
- Узбекский и английский — без кириллицы (`i18n-uz-quality`).
- Русский текст не склеивать с переменными: шаблон `{x}` + `trf()`.
- Размеры шрифта — только шкала 12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40 (`type-scale`).
- Значки — только из `public/js/admin/icon-map.js` через `Icon()`: Building, MapPin, Globe, Image, Phone, Send, Bot, Camera, Link, Trash, Refresh, Info, Flag. Без эмодзи.
- Вёрстка — без фиксированных ширин больше 320 px: сетки `repeat(auto-fit, minmax(…))`, на ширине телефона всё в один столбец.

**Полный прогон** делает контролёр после всех задач («Завершение»). Во время работы — только файлы тестов задачи и названные сторожа.

---

## Task 1: «Компания» сохраняется без логотипа — существующая ошибка (CLINIC_PROFILE_V1)

**Files:**
- Modify: `public/js/admin/views/documents-settings.js` (`DEFAULTS` :43-46, `removeLogo` ~:193-197, `save()` payload ~:259-267)
- Modify: `public/js/admin/__tests__/settings-split.test.mjs`
- Create: `server/routes/company-save.test.js`

**Сейчас:**
- `doc_settings.logo_data_url` — `TEXT NOT NULL DEFAULT ''` (миграция 008).
- `save()` шлёт `logo_data_url: state.logo_data_url || null`. У клиники без логотипа (в базе `''`) и после «Удалить логотип» уходит `null`.
- `/api/db` отвечает 400 «Не заполнено обязательное поле doc_settings.logo_data_url.».
- Поддельные серверы тестов принимали `null`, поэтому ошибку не ловили.

- [ ] **Step 1: падающий клиентский тест** — в `settings-split.test.mjs`, после теста «сохранение шлёт ТОЛЬКО свои колонки». В `resetServer()` у строки уже `logo_data_url: null`.

```js
// CLINIC_PROFILE_V1 — колонка NOT NULL: «логотипа нет» — пустая строка, не null.
test('«Компания» без логотипа: сохранение шлёт пустую строку, не null', async () => {
  const root = mk('div');
  await renderDocumentsSettings(root, { onNavigate: () => {} });
  findButtonByText(root, /Сохранить/).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lastDocUpdate, 'запрос на обновление ушёл');
  assert.strictEqual(lastDocUpdate.logo_data_url, '', 'null база отклоняет: колонка NOT NULL');
});
```

- [ ] **Step 2: серверный тест договора** `server/routes/company-save.test.js`. Сервер, вход и `post` — по образцу `server/routes/photo-storage.test.js`: `setup()` / `login()`, `listen` из `control-plane/server/test-helpers/listen.js`.

```js
// CLINIC_PROFILE_V1 — договор «Компании» с базой: пустая строка проходит, null — нет.
test('doc_settings: logo_data_url = "" сохраняется, null — 400 с названием колонки', async () => {
  const t = await setup();
  try {
    const cookie = await login(t.base, 'boss');
    const save = (values) => fetch(t.base + '/api/db', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ table: 'doc_settings', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: 1 }] }) });
    assert.equal((await save({ clinic_name: 'Шифо', logo_data_url: '' })).status, 200);
    const bad = await save({ clinic_name: 'Шифо', logo_data_url: null });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /logo_data_url/);
  } finally { t.stop(); }
});
```

- [ ] **Step 3: запуск — клиентский падает** (`null !== ''`), серверный зелёный:
  `node --experimental-vm-modules --test public/js/admin/__tests__/settings-split.test.mjs`, `node --test server/routes/company-save.test.js`.
- [ ] **Step 4: правка** в `documents-settings.js`:

```js
const DEFAULTS = {
    clinic_name: '', address: '', phone: '', email: '', license: '',
    logo_data_url: '', accent_color: '#167873',   // CLINIC_PROFILE_V1 — колонка NOT NULL: «нет логотипа» — ''
};
// removeLogo():
    state.logo_data_url = '';   // CLINIC_PROFILE_V1
// save(), payload:
            logo_data_url:  state.logo_data_url || '',   // CLINIC_PROFILE_V1 — null отклоняет база (NOT NULL)
```

- [ ] **Step 5:** оба теста зелёные. Сторожа: `settings-split`, `clinic-brand`.
- [ ] **Step 6: коммит** `documents-settings.js`, `settings-split.test.mjs`, `company-save.test.js`:
  «Компания: сохранение без логотипа больше не отклоняется — пустая строка вместо null (CLINIC_PROFILE_V1)».

---

## Task 2: Название клиники печатается рядом с логотипом (CLINIC_PROFILE_V1, снимает LOGO_WORDMARK_V1)

**Files:**
- Modify: `public/js/shared/doc-render.js` (:477-491 `hasLogo`/`logoMark`, :516-520 `docHeadHTML`, :533-537 `headerHTML`)
- Create: `public/js/shared/doc-render.logo-name.test.js`

**Сейчас:**
- `hasLogo(s)` прячет название в `headerHTML` и `docHeadHTML`, как только у бланка есть любой логотип. Правило LOGO_WORDMARK_V1 считало логотип надписью.
- Квадратный логотип — знак без надписи. С ним большинство бланков A4 печаталось бы без названия клиники.
- Варианты дизайнера (`views/doc-variants.js` `vHead`) и `a4-letterhead.js` уже печатают название всегда — им не нужно ничего.

- [ ] **Step 1: падающий тест** `public/js/shared/doc-render.logo-name.test.js`:

```js
// CLINIC_PROFILE_V1 — логотип не прячет название (спецификация «Правила, без которых не строим»).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSheetHtml } from './doc-render.js';

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const S = {
  clinicName: 'Клиника Шифо', tagline: '', address: 'Ташкент', phone: '', email: '', web: '',
  accent: '#167873', accentSoft: '#effaf8', ink: '#0b1418', paperBg: '#fff',
  showWatermark: false, showStamp: false, showSignature: false, showQR: false,
  language: 'ru', paperSize: 'A4', fontPair: 'modern', cornerStyle: 'rounded', footerNote: '', legalNote: '', variant: {},
};
// Видимый текст между тегами, а не alt картинки.
const nameShown = (html) => />\s*Клиника Шифо\s*</.test(html);

test('шапка бланка (квитанция, свой бланк): с логотипом название печатается рядом', () => {
  const html = buildSheetHtml({ type: 'custom', s: { ...S, logoUrl: LOGO }, bodyHtml: '<p>тело</p>' });
  assert.ok(html.includes(LOGO), 'логотип на месте');
  assert.ok(nameShown(html), 'название пропало рядом с логотипом');
});

test('двухъярусная шапка (выписка, договор стационара): с логотипом название печатается рядом', () => {
  for (const args of [
    { type: 'custom', bodyHtml: '<p>тело</p>', head: { title: 'Выписка' } },
    { type: 'inpatient_contract', data: null },
  ]) {
    const html = buildSheetHtml({ ...args, s: { ...S, logoUrl: LOGO } });
    assert.ok(html.includes(LOGO), args.type + ': логотип');
    assert.ok(nameShown(html), args.type + ': название');
  }
});

test('без логотипа — как было: знак клиники и название', () => {
  const html = buildSheetHtml({ type: 'custom', s: S, bodyHtml: '<p>тело</p>' });
  assert.ok(nameShown(html));
});
```

- [ ] **Step 2:** `node --test public/js/shared/doc-render.logo-name.test.js`. Первые два теста падают, третий зелёный.
- [ ] **Step 3: правка.**
  - Удалить `hasLogo()`.
  - Заменить комментарий LOGO_WORDMARK_V1 на `CLINIC_PROFILE_V1 — логотип не прячет название: квадратный логотип — знак, а не надпись; название печатается всегда (спецификация, «Правила, без которых не строим»)`.
  - В `docHeadHTML` и `headerHTML` блок названия выводится безусловно. Разметка та же, что сейчас в ветке «без логотипа»: в `docHeadHTML` — `font-size:15px … max-width:28%`, в `headerHTML` — `font-size:17px`.
  - В `logoMark()` у `<img>` поставить `alt=""`: название теперь напечатано рядом.
  - Высоту 64 px и `max-width:300px` не трогать: прежние широкие логотипы печатаются, пока клиника не загрузит квадратный.
- [ ] **Step 4:** тест зелёный. Сторожа — печать:
  - `doc-render.inpatient.test.js`;
  - `__tests__/print-v3120`, `print-auto`, `case-doc-a4`, `a4-sheets`, `admissions-window`, `title-sheet`, `receipt-print`, `fiscal-receipt`;
  - `server/services/telegram/render-branding.test.js`;
  - `public/js/shared/company-branding.test.js`.
- [ ] **Step 5: коммит** «Печать: название клиники рядом с логотипом на всех бланках — логотип больше не прячет название (CLINIC_PROFILE_V1)».

---

## Task 3: Миграция 240 — колонки профиля в doc_settings; реестр; право «Компания» (CLINIC_PROFILE_V1)

**Files:**
- Create: `server/db/migrations/240_clinic_profile.sql`, `server/db/migrations/240.test.js`
- Modify: `server/db/schema-registry.js` (:651-658 `doc_settings`)
- Modify: `public/js/shared/permission-catalog.js` (:380 `settings.company` → `grantColumns.doc_settings`)
- Test: `server/db/schema-registry.test.js` (рядом с :140-145), `server/db/write-grant.test.js` (рядом с :76-84)

- [ ] **Step 1: падающий тест миграции** `server/db/migrations/240.test.js`:

```js
// CLINIC_PROFILE_V1 (мигр. 240) — ПРОФИЛЬ КЛИНИКИ: только ADD COLUMN и одна отметка.
//
// Новые колонки пусты; адрес, который клиника уже вписала, помечен «вручную» —
// после обновления бланк печатает то же; строка doc_settings не пересобрана
// (lab_scope и логотип на месте); CHECK — запасной замок форматов для /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore240() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig240-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 240)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const NEW = ['name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en', 'country_code', 'region_code', 'district_code',
  'street_ru', 'street_uz', 'street_en', 'address_manual', 'website', 'telegram_bot', 'telegram_channel', 'instagram',
  'maps_url', 'logo_square_path', 'logo_portrait_path'];

test('240: колонки профиля добавлены пустыми; вписанный адрес — «вручную»; прежнее не тронуто', () => {
  const db = dbBefore240();
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', address = 'Ташкент, ул. Мира 1',
              logo_data_url = 'data:image/png;base64,AAAA', lab_scope = 'building' WHERE id = 1`).run();
  migrate(db);
  const row = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
  for (const c of NEW) assert.ok(c in row, 'нет колонки ' + c);
  assert.equal(row.address_manual, 1, 'вписанный руками адрес остаётся тем, что печатается');
  for (const c of NEW.filter((x) => x !== 'address_manual')) assert.equal(row[c], '', c + ' пуста');
  assert.deepEqual([row.clinic_name, row.address, row.logo_data_url, row.lab_scope],
    ['Шифо', 'Ташкент, ул. Мира 1', 'data:image/png;base64,AAAA', 'building']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_settings').get().n, 1);
});

test('240: пустой адрес — собирается из списков (address_manual = 0)', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.equal(db.prepare('SELECT address_manual FROM doc_settings WHERE id = 1').get().address_manual, 0);
});

test('240: CHECK — сайт https, бот на «bot», имена через @, карта Яндекса, логотипы в своих папках', () => {
  const db = openDb(':memory:'); migrate(db);
  const set = (col, v) => db.prepare(`UPDATE doc_settings SET ${col} = ? WHERE id = 1`).run(v);
  for (const [col, bad, good, empty] of [
    ['website', 'http://klinika.uz', 'https://klinika.uz', ''],
    ['telegram_bot', '@klinika', '@klinika_bot', ''],
    ['telegram_channel', 'klinika', '@klinika', ''],
    ['instagram', 'klinika', '@klinika.uz', ''],
    ['maps_url', 'https://google.com/maps/x', 'https://yandex.uz/maps/-/CDabc', ''],
    ['logo_square_path', 'portrait/1-a.png', 'square/1-a.png', ''],
    ['logo_portrait_path', 'square/1-a.png', 'portrait/1-a.png', ''],
    ['address_manual', 2, 1, 0],
  ]) {
    assert.throws(() => set(col, bad), /CHECK/, col + ' = ' + bad);
    set(col, good);
    set(col, empty);
  }
});
```

- [ ] **Step 2:** `node --test server/db/migrations/240.test.js` → падает (нет колонок).
- [ ] **Step 3: миграция** `server/db/migrations/240_clinic_profile.sql`:

```sql
-- 240 — CLINIC_PROFILE_V1 (2026-10-10): ПРОФИЛЬ КЛИНИКИ (шаг 3 API клиники,
-- docs/specs/2026-10-06-clinic-api-design.md; план 2026-10-10-clinic-api-3-company-profile.md).
--
-- ТОЛЬКО ADD COLUMN и одна UPDATE-отметка: doc_settings не пересобирается
-- (строка одна, id = 1, миграция 008; lab_scope мигр. 085 на месте).
--
-- Документы печатают ПРЕЖНИЕ поля: clinic_name и address. Новые — рядом:
-- названия и описание на uz/en идут наружу (API) и в интерфейс на этих языках;
-- адрес главного здания — кодами справочника (мигр. 132) и улицей на трёх
-- языках; логотипы — путями к файлам корзины clinic-logos (сами файлы — в
-- хранилище; печатная копия квадратного — прежний logo_data_url).
-- CHECK — запасной замок форматов: экран проверяет то же раньше и понятнее.

ALTER TABLE doc_settings ADD COLUMN name_uz  TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN name_en  TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN about_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN about_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN about_en TEXT NOT NULL DEFAULT '';

-- Адрес этого здания (в главном — главного): коды countries.code /
-- regions.code / districts.code (мигр. 132), улица на трёх языках.
ALTER TABLE doc_settings ADD COLUMN country_code  TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN region_code   TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN district_code TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN street_ru TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN street_uz TEXT NOT NULL DEFAULT '';
ALTER TABLE doc_settings ADD COLUMN street_en TEXT NOT NULL DEFAULT '';
-- 0 — address (то, что печатается) собирается из выбранного; 1 — клиника
-- вписала его руками, и сборка его не трогает.
ALTER TABLE doc_settings ADD COLUMN address_manual INTEGER NOT NULL DEFAULT 0 CHECK (address_manual IN (0, 1));

ALTER TABLE doc_settings ADD COLUMN website TEXT NOT NULL DEFAULT ''
  CHECK (website = '' OR website LIKE 'https://_%');
ALTER TABLE doc_settings ADD COLUMN telegram_bot TEXT NOT NULL DEFAULT ''
  CHECK (telegram_bot = '' OR (telegram_bot GLOB '@?*' AND lower(telegram_bot) GLOB '*bot'));
ALTER TABLE doc_settings ADD COLUMN telegram_channel TEXT NOT NULL DEFAULT ''
  CHECK (telegram_channel = '' OR telegram_channel GLOB '@?*');
ALTER TABLE doc_settings ADD COLUMN instagram TEXT NOT NULL DEFAULT ''
  CHECK (instagram = '' OR instagram GLOB '@?*');
ALTER TABLE doc_settings ADD COLUMN maps_url TEXT NOT NULL DEFAULT ''
  CHECK (maps_url = '' OR maps_url LIKE 'https://yandex.%' OR maps_url LIKE 'https://www.yandex.%' OR maps_url LIKE 'https://maps.yandex.%');

ALTER TABLE doc_settings ADD COLUMN logo_square_path TEXT NOT NULL DEFAULT ''
  CHECK (logo_square_path = '' OR logo_square_path GLOB 'square/?*.png');
ALTER TABLE doc_settings ADD COLUMN logo_portrait_path TEXT NOT NULL DEFAULT ''
  CHECK (logo_portrait_path = '' OR logo_portrait_path GLOB 'portrait/?*.png');

-- Адрес, который клиника уже вписала, остаётся тем, что печатается.
UPDATE doc_settings SET address_manual = 1 WHERE trim(address) <> '';
```

- [ ] **Step 4: реестр и право.**
  - В `schema-registry.js` `doc_settings.read.columns` и `write.update.columns` дописать 19 новых колонок с комментарием `// CLINIC_PROFILE_V1 (mig 240) — профиль клиники`.
  - В `permission-catalog.js` в строке `settings.company` дописать те же 19 колонок в `grantColumns.doc_settings`. `lab_scope` туда не добавлять: его меняет только администратор.
- [ ] **Step 5: тесты реестра и права.**
  - `schema-registry.test.js`: каждая из 19 колонок есть в `readableColumns('doc_settings')` и в `writableColumns('doc_settings', 'update')`.
  - `write-grant.test.js`, в тесте «ключ встаёт вместо администратора…»: после `addGrants(db, 'registrar', { settings: 'edit', 'settings.company': 'edit' })` проходит
    `run(db, { table: 'doc_settings', op: 'update', values: { name_uz: 'Shifo', website: 'https://shifo.uz', logo_square_path: 'square/1-a.png' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG)`.
    Тест :148 (`lab_scope` отклоняется) не трогать.
- [ ] **Step 6:** зелёные `240.test.js`, `schema-registry.test.js`, `write-grant.test.js`. Сторожа:
  - `server/db/migration-order.test.js`, `schema-registry-conformance.test.js`, `star-meets-schema.test.js`;
  - `migrations/008.test.js`, `085.test.js`;
  - `server/services/branch-sync/catalogue.test.js` (форма `doc_settings`).
- [ ] **Step 7: коммит** «Компания: колонки профиля клиники — названия, описание, адрес кодами, ссылки, логотипы (миграция 240, CLINIC_PROFILE_V1)».

---

## Task 4: Общий модуль профиля — колонки, ссылки, адрес (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/shared/clinic-profile.js`, `public/js/shared/clinic-profile.test.js`
- Modify: `public/js/admin/i18n-strings.js` (сообщения модуля)

- [ ] **Step 1: падающий тест** `public/js/shared/clinic-profile.test.js`:

```js
// CLINIC_PROFILE_V1 — правила профиля клиники: одни для экрана, /api/db и синхронизации зданий.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_CLINIC_WIDE, COMPANY_BUILDING, COMPANY_COLUMNS, PROFILE_MESSAGES,
  normalizeWebsite, websiteProblem, normalizeHandle, handleProblem, mapsProblem, routeUrl, telHref,
  composeAddress, printedAddress, addressProblems, companyProblems, normalizeProfile,
} from './clinic-profile.js';
import { STRINGS } from '../admin/i18n-strings.js';
import { writableColumns } from '../../../server/db/schema-registry.js';
import { catalogByKey } from './permission-catalog.js';

test('наборы колонок: общее и своё не пересекаются; всё пишется и по праву «Компания»', () => {
  assert.equal(COMPANY_CLINIC_WIDE.filter((c) => COMPANY_BUILDING.includes(c)).length, 0);
  const upd = writableColumns('doc_settings', 'update');
  const grant = catalogByKey().get('settings.company').grantColumns.doc_settings;
  for (const c of COMPANY_COLUMNS) {
    assert.ok(upd.includes(c), 'реестр не даёт править ' + c);
    assert.ok(grant.includes(c), 'право «Компания» не открывает ' + c);
  }
  assert.ok(!COMPANY_COLUMNS.includes('lab_scope') && !COMPANY_COLUMNS.includes('paper_size'));
});

test('сайт: домен дополняется https://, http:// и мусор — объяснение', () => {
  assert.equal(normalizeWebsite(' klinika.uz '), 'https://klinika.uz');
  assert.equal(normalizeWebsite('HTTPS://Klinika.uz/ru'), 'https://Klinika.uz/ru');
  assert.equal(websiteProblem('klinika.uz'), '');
  assert.equal(websiteProblem(''), '');
  assert.equal(websiteProblem('http://klinika.uz'), PROFILE_MESSAGES.website);
  assert.equal(websiteProblem('klinika'), PROFILE_MESSAGES.website);
});

test('Telegram и Instagram: ссылка урезается до @имени; бот — на «bot»', () => {
  assert.equal(normalizeHandle('https://t.me/klinika_bot/'), '@klinika_bot');
  assert.equal(normalizeHandle('t.me/klinika?start=1'), '@klinika');
  assert.equal(normalizeHandle('https://www.instagram.com/klinika.uz/'), '@klinika.uz');
  assert.equal(normalizeHandle('@@klinika'), '@klinika');
  assert.equal(handleProblem('telegram_bot', '@klinika_bot'), '');
  assert.equal(handleProblem('telegram_bot', '@klinika_demo'), PROFILE_MESSAGES.bot);
  assert.equal(handleProblem('telegram_channel', '@abc'), PROFILE_MESSAGES.telegram, 'Telegram — от 5 знаков');
  assert.equal(handleProblem('instagram', '@klinika.uz'), '');
  assert.equal(handleProblem('instagram', '@кли ника'), PROFILE_MESSAGES.instagram);
});

test('карта и маршрут: только Яндекс; маршрут из pt=/ll=, иначе — сама ссылка', () => {
  assert.equal(mapsProblem('https://yandex.uz/maps/-/CDabc123'), '');
  assert.equal(mapsProblem('https://yandex.ru/maps/org/shifo/123/'), '');
  assert.equal(mapsProblem('https://maps.google.com/x'), PROFILE_MESSAGES.maps);
  assert.equal(routeUrl('https://yandex.uz/maps/?ll=69.2401%2C41.2995&z=16&pt=69.2401,41.2995'),
    'https://yandex.uz/maps/?rtext=~41.2995,69.2401&rtt=auto');
  assert.equal(routeUrl('https://yandex.uz/maps/-/CDabc123'), 'https://yandex.uz/maps/-/CDabc123');
  assert.equal(routeUrl(''), '');
  assert.equal(telHref('+998 71 200-12-00'), 'tel:+998712001200');
  assert.equal(telHref('12'), '');
});

const UZ = { code: 'UZ', name: 'Узбекистан', name_uz: 'O‘zbekiston', name_en: 'Uzbekistan' };
const KZ = { code: 'KZ', name: 'Казахстан', name_uz: 'Qozog‘iston', name_en: 'Kazakhstan' };
const TASH = { code: 'tashkent-city', name: 'город Ташкент', name_uz: 'Toshkent shahri', name_en: 'Tashkent city' };
const YUN = { code: 'yunusobod', name: 'Юнусабадский район', name_uz: 'Yunusobod tumani', name_en: '' };
const STREET = { ru: 'ул. Амира Темура, 12', uz: 'Amir Temur ko‘chasi, 12', en: '' };

test('полный адрес: по-языковой, с русским запасом; страна — только не Узбекистан', () => {
  const parts = { country: UZ, region: TASH, district: YUN, street: STREET };
  assert.equal(composeAddress(parts, 'ru'), 'город Ташкент, Юнусабадский район, ул. Амира Темура, 12');
  assert.equal(composeAddress(parts, 'uz'), 'Toshkent shahri, Yunusobod tumani, Amir Temur ko‘chasi, 12');
  assert.equal(composeAddress(parts, 'en'), 'Tashkent city, Юнусабадский район, ул. Амира Темура, 12');
  assert.equal(composeAddress({ country: KZ, region: null, district: null, street: { ru: 'пр. Абая, 1' } }, 'ru'), 'Казахстан, пр. Абая, 1');
  assert.equal(composeAddress({}, 'ru'), '');
});

test('адрес для документов: ручной — как вписан; собранный пустым прежний не стирает', () => {
  assert.equal(printedAddress({ manual: true, typed: 'Ташкент, ул. Мира 1', composed: 'город Ташкент, …' }), 'Ташкент, ул. Мира 1');
  assert.equal(printedAddress({ manual: false, typed: 'старый', composed: 'город Ташкент, ул. Мира 1' }), 'город Ташкент, ул. Мира 1');
  assert.equal(printedAddress({ manual: false, typed: 'старый', composed: '' }), 'старый');
});

test('адрес — всё или ничего: начатый требует город/область, район и улицу RU', () => {
  assert.deepEqual(addressProblems({ country_code: 'UZ' }), {}, 'страна по умолчанию — не «начат»');
  assert.deepEqual(Object.keys(addressProblems({ street_ru: 'ул. Мира 1' })), ['region_code']);
  assert.deepEqual(Object.keys(addressProblems({ region_code: 'tashkent-city' })).sort(), ['district_code', 'street_ru']);
  assert.deepEqual(Object.keys(addressProblems({ region_code: 'x' }, { districtsAvailable: false })), ['street_ru']);
  assert.deepEqual(addressProblems({ region_code: 'tashkent-city', district_code: 'yunusobod', street_ru: 'ул. Мира 1' }), {});
});

test('проверка профиля целиком и нормализация перед записью', () => {
  const v = normalizeProfile({ website: 'klinika.uz', telegram_bot: 't.me/klinika_bot', instagram: '', maps_url: ' ', clinic_name: ' Шифо ', address_manual: '1' });
  assert.equal(v.website, 'https://klinika.uz');
  assert.equal(v.telegram_bot, '@klinika_bot');
  assert.equal(v.maps_url, '');
  assert.equal(v.clinic_name, 'Шифо');
  assert.equal(v.address_manual, 1);
  assert.deepEqual(companyProblems(v), {});
  assert.deepEqual(Object.keys(companyProblems({ ...v, telegram_bot: '@klinika' })), ['telegram_bot']);
});

test('каждое сообщение модуля переведено на ru / uz / en', () => {
  for (const m of Object.values(PROFILE_MESSAGES)) {
    const e = STRINGS[m];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи словаря: ' + m);
  }
});
```

- [ ] **Step 2:** `node --test public/js/shared/clinic-profile.test.js` → падает (нет модуля).
- [ ] **Step 3: модуль** `public/js/shared/clinic-profile.js`:

```js
// CLINIC_PROFILE_V1 — ПРОФИЛЬ КЛИНИКИ: какие колонки «Компании» общие для
// клиники, какие свои у здания; как проверяются ссылки и собирается адрес.
//
// Чистый модуль — без window, document, базы и перевода. Его читают экран
// «Компания» (views/documents-settings.js и соседи), /api/db (страж филиала,
// routes/db.js) и тесты. Сообщения — ключи словаря (i18n-strings.js): экран
// переводит их tr(), сервер отдаёт как есть.

// ОБЩЕЕ ДЛЯ КЛИНИКИ — меняет главное здание. Филиал получает текстовые поля
// со справочником (branch-sync/catalogue.js DOC_SETTINGS_COLUMNS) и печатает
// копию логотипа; файлов логотипов в филиале нет, пути к ним не едут.
export const COMPANY_CLINIC_WIDE = Object.freeze([
  'clinic_name', 'name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en',
  'license', 'accent_color', 'logo_data_url', 'logo_square_path', 'logo_portrait_path',
  'website', 'telegram_bot', 'telegram_channel', 'instagram',
]);
// СВОЁ У ЗДАНИЯ — как address/phone/email с самого начала (catalogue.js:26-38).
export const COMPANY_BUILDING = Object.freeze([
  'address', 'address_manual', 'phone', 'email',
  'country_code', 'region_code', 'district_code', 'street_ru', 'street_uz', 'street_en', 'maps_url',
]);
export const COMPANY_COLUMNS = Object.freeze([...COMPANY_CLINIC_WIDE, ...COMPANY_BUILDING]);

export const NAME_MAX = 120;
export const ABOUT_MAX = 600;
export const STREET_MAX = 160;

export const PROFILE_MESSAGES = Object.freeze({
  website:   'Адрес сайта должен начинаться с https://, например https://klinika.uz',
  telegram:  'Укажите имя в Telegram через @ (от 5 латинских букв, цифр или _), например @klinika_demo, или ссылку t.me/….',
  bot:       'Имя Telegram-бота заканчивается на «bot», например @klinika_demo_bot.',
  instagram: 'Укажите имя в Instagram через @, например @klinika_demo, или ссылку на профиль.',
  maps:      'Нужна ссылка из Яндекс Карт: откройте клинику в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку (yandex.uz/maps/…).',
  region:    'Выберите город или область.',
  district:  'Выберите район из списка.',
  street:    'Впишите улицу и дом на русском.',
});

// ---- сайт -----------------------------------------------------------------
const WEBSITE_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;
export function normalizeWebsite(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;          // «klinika.uz» → https://klinika.uz
  return s.replace(/^https:\/\//i, 'https://');
}
export function websiteProblem(v) {
  const s = normalizeWebsite(v);
  return !s || WEBSITE_RE.test(s) ? '' : PROFILE_MESSAGES.website;
}

// ---- Telegram / Instagram: храним «@имя» ------------------------------------
const HANDLE_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|instagram\.com)\//i;
export function normalizeHandle(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  s = s.replace(HANDLE_PREFIX, '').replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^@+/, '');
  return s ? '@' + s : '';
}
const TG_RE = /^@[A-Za-z][A-Za-z0-9_]{4,31}$/;   // Telegram: 5–32 знака, с буквы
const IG_RE = /^@[A-Za-z0-9_.]{1,30}$/;
export function handleProblem(kind, v) {
  const s = normalizeHandle(v);
  if (!s) return '';
  if (kind === 'instagram') return IG_RE.test(s) ? '' : PROFILE_MESSAGES.instagram;
  if (!TG_RE.test(s)) return PROFILE_MESSAGES.telegram;
  if (kind === 'telegram_bot' && !/bot$/i.test(s)) return PROFILE_MESSAGES.bot;
  return '';
}

// ---- карта и маршрут ----------------------------------------------------------
const MAPS_RE = /^https:\/\/(?:(?:www\.)?yandex\.(?:uz|ru|com|kz|by)\/maps|maps\.yandex\.(?:uz|ru|com|kz|by))(?:[/?#]|$)/i;
export function mapsProblem(v) {
  const s = String(v || '').trim();
  return !s || MAPS_RE.test(s) ? '' : PROFILE_MESSAGES.maps;
}
// «Маршрут»: координаты из ссылки (pt= / ll= — долгота,широта) → «проложить
// от меня»; ссылка «Поделиться» (yandex.uz/maps/-/…) координат не несёт —
// тогда открывается сама карточка, в ней своя кнопка «Маршрут».
export function routeUrl(maps) {
  const s = String(maps || '').trim();
  if (!s) return '';
  const m = /[?&](?:pt|ll)=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i.exec(s);
  return m ? 'https://yandex.uz/maps/?rtext=~' + m[2] + ',' + m[1] + '&rtt=auto' : s;
}
export function telHref(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  return d.replace(/\D/g, '').length >= 7 ? 'tel:' + d : '';
}

// ---- адрес --------------------------------------------------------------------
// Строки справочника — как их отдаёт база: { code, name, name_uz, name_en }
// (name — русское, миграции 030/132).
export function placeName(row, lang) {
  if (!row) return '';
  return String((lang === 'uz' && row.name_uz) || (lang === 'en' && row.name_en) || row.name || '').trim();
}
// «город Ташкент, Юнусабадский район, ул. Амира Темура, 12» на языке lang;
// часть без перевода — по-русски; страна — только за пределами Узбекистана.
export function composeAddress({ country = null, region = null, district = null, street = null } = {}, lang = 'ru') {
  const st = street || {};
  const streetText = String(st[lang] || st.ru || '').trim();
  return [
    country && country.code && country.code !== 'UZ' ? placeName(country, lang) : '',
    placeName(region, lang), placeName(district, lang), streetText,
  ].filter(Boolean).join(', ');
}
// Что печатается: вписанное руками — как есть; иначе собранное по-русски.
// Собранное пустым (ничего не выбрано) прежний адрес НЕ стирает: пустая
// строка на бланке хуже старой.
export function printedAddress({ manual, typed, composed }) {
  if (manual) return String(typed || '');
  return String(composed || '').trim() || String(typed || '');
}
// Начат ли адрес. Страна в счёт не идёт: её ставит экран (UZ по умолчанию).
export function addressStarted(v) {
  return !!(v.region_code || v.district_code || ['street_ru', 'street_uz', 'street_en'].some((k) => String(v[k] || '').trim()));
}
// Всё или ничего: старую клинику пустой адрес не останавливает, начатый — доводится до конца.
export function addressProblems(v, { regionsAvailable = true, districtsAvailable = true } = {}) {
  const p = {};
  if (!addressStarted(v)) return p;
  if (regionsAvailable && !v.region_code) p.region_code = PROFILE_MESSAGES.region;
  if (v.region_code && districtsAvailable && !v.district_code) p.district_code = PROFILE_MESSAGES.district;
  if (!String(v.street_ru || '').trim()) p.street_ru = PROFILE_MESSAGES.street;
  return p;
}

export function normalizeProfile(v) {
  const out = { ...v };
  out.website = normalizeWebsite(v.website);
  for (const k of ['telegram_bot', 'telegram_channel', 'instagram']) out[k] = normalizeHandle(v[k]);
  for (const k of ['clinic_name', 'name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en',
    'street_ru', 'street_uz', 'street_en', 'maps_url']) out[k] = String(v[k] == null ? '' : v[k]).trim();
  out.address_manual = Number(v.address_manual) ? 1 : 0;
  return out;
}
export function companyProblems(v, geo = {}) {
  const p = { ...addressProblems(v, geo) };
  const w = websiteProblem(v.website); if (w) p.website = w;
  for (const k of ['telegram_bot', 'telegram_channel', 'instagram']) { const m = handleProblem(k, v[k]); if (m) p[k] = m; }
  const mp = mapsProblem(v.maps_url); if (mp) p.maps_url = mp;
  return p;
}
```

- [ ] **Step 4: словарь.** Восемь статей `PROFILE_MESSAGES` в начало `STRINGS`, с комментарием-заголовком `// CLINIC_PROFILE_V1 (2026-10-10) — профиль клиники: проверки «Компании» (shared/clinic-profile.js)`:

| ru | uz | en |
|---|---|---|
| Адрес сайта должен начинаться с https://, например https://klinika.uz | Sayt manzili https:// bilan boshlanishi kerak, masalan https://klinika.uz | The website address must start with https://, for example https://klinika.uz |
| Укажите имя в Telegram через @ (от 5 латинских букв, цифр или _), например @klinika_demo, или ссылку t.me/…. | Telegram nomini @ bilan kiriting (kamida 5 ta lotin harfi, raqam yoki _), masalan @klinika_demo, yoki t.me/… havolasini. | Enter the Telegram name with @ (at least 5 Latin letters, digits or _), for example @klinika_demo, or a t.me/… link. |
| Имя Telegram-бота заканчивается на «bot», например @klinika_demo_bot. | Telegram-bot nomi «bot» bilan tugaydi, masalan @klinika_demo_bot. | A Telegram bot name ends in “bot”, for example @klinika_demo_bot. |
| Укажите имя в Instagram через @, например @klinika_demo, или ссылку на профиль. | Instagram nomini @ bilan kiriting, masalan @klinika_demo, yoki profilga havolani. | Enter the Instagram name with @, for example @klinika_demo, or a link to the profile. |
| Нужна ссылка из Яндекс Карт: откройте клинику в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку (yandex.uz/maps/…). | Yandex Xaritalardan havola kerak: klinikani Yandex Xaritalarda oching, «Ulashish»ni bosing va havolani nusxalang (yandex.uz/maps/…). | A Yandex Maps link is needed: open the clinic in Yandex Maps, press “Share” and copy the link (yandex.uz/maps/…). |
| Выберите город или область. | Shahar yoki viloyatni tanlang. | Choose the city or region. |
| Выберите район из списка. | Ro‘yxatdan tumanni tanlang. | Choose the district from the list. |
| Впишите улицу и дом на русском. | Ko‘cha va uyni rus tilida yozing. | Enter the street and building in Russian. |

- [ ] **Step 5:** тест зелёный. Сторожа: `public/js/admin/__tests__/i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`.
- [ ] **Step 6: коммит** «Профиль клиники: общий модуль — колонки клиники и здания, проверка сайта, Telegram, Instagram, карты, сборка адреса (CLINIC_PROFILE_V1)».

---

## Task 5: Общий модуль логотипов — PNG, прозрачность, размеры (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/shared/clinic-logo-rules.js`, `public/js/shared/clinic-logo-rules.test.js`, `server/test-helpers/fake-png.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: заготовка PNG для тестов** `server/test-helpers/fake-png.js`:

```js
// CLINIC_PROFILE_V1 — PNG для тестов логотипов: сигнатура и чанки настоящие,
// CRC нулевые (clinic-logo-rules.js их не проверяет), картинки внутри нет.
// colorType: 6 — RGBA, 4 — серый+альфа, 2 — RGB (без прозрачности), 3 — палитра.
function chunk(type, data = Buffer.alloc(0)) {
  const c = Buffer.alloc(12 + data.length);
  c.writeUInt32BE(data.length, 0);
  c.write(type, 4, 'ascii');
  data.copy(c, 8);
  return c;
}
export function fakePng(w, h, { colorType = 6, trns = false, pad = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(trns ? [chunk('tRNS', Buffer.from([0, 0]))] : []),
    chunk('IDAT', Buffer.alloc(1 + pad)),
    chunk('IEND'),
  ]);
}
export const pngDataUrl = (buf) => 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
```

- [ ] **Step 2: падающий тест** `public/js/shared/clinic-logo-rules.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pngInfo, logoRefusal, LOGO_TEMPLATES, MAX_LOGO_BYTES } from './clinic-logo-rules.js';
import { fakePng } from '../../../server/test-helpers/fake-png.js';
import { STRINGS } from '../admin/i18n-strings.js';

test('pngInfo: размеры и прозрачность из заголовка; не PNG — null', () => {
  assert.deepEqual(pngInfo(fakePng(512, 512)), { width: 512, height: 512, hasAlpha: true });
  assert.deepEqual(pngInfo(fakePng(600, 800, { colorType: 2 })), { width: 600, height: 800, hasAlpha: false });
  assert.equal(pngInfo(fakePng(300, 300, { colorType: 3, trns: true })).hasAlpha, true, 'палитра с tRNS — прозрачная');
  assert.equal(pngInfo(Buffer.from('GIF89a......................................')), null);
  assert.equal(pngInfo(new Uint8Array(10)), null);
});

test('квадратный: PNG, прозрачный, стороны равны (±2%), 256–2048 px, до 1 МБ', () => {
  const ok = (w, h, o) => logoRefusal({ kind: 'square', name: 'logo.png', bytes: fakePng(w, h, o) });
  assert.equal(ok(512, 512), null);
  assert.equal(ok(512, 520), null, 'в пределах 2%');
  assert.equal(ok(600, 500).code, 'logo_not_square');
  assert.equal(ok(512, 512, { colorType: 2 }).code, 'logo_not_transparent');
  assert.equal(ok(200, 200).code, 'logo_bad_size');
  assert.equal(ok(3000, 3000).code, 'logo_bad_size');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.jpg', bytes: fakePng(512, 512) }).code, 'logo_not_png');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.png', bytes: Buffer.from('not a png at all, really not, no no no no') }).code, 'logo_not_png');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.png', bytes: fakePng(512, 512, { pad: MAX_LOGO_BYTES }) }).code, 'file_too_large');
  assert.equal(logoRefusal({ kind: 'square', name: 'logo.png', bytes: Buffer.alloc(0) }).code, 'file_empty');
});

test('вертикальный: высота больше ширины', () => {
  assert.equal(logoRefusal({ kind: 'portrait', name: 'p.png', bytes: fakePng(600, 800) }), null);
  assert.equal(logoRefusal({ kind: 'portrait', name: 'p.png', bytes: fakePng(800, 800) }).code, 'logo_not_portrait');
});

test('каждый отказ — шаблон словаря на ru / uz / en с теми же {дырками}', () => {
  for (const t of Object.values(LOGO_TEMPLATES)) {
    const e = STRINGS[t];
    assert.ok(e && e.ru && e.uz && e.en, 'нет статьи: ' + t);
    for (const hole of t.match(/\{\w+\}/g) || []) assert.ok(e.uz.includes(hole) && e.en.includes(hole), t + ' теряет ' + hole);
  }
});
```

- [ ] **Step 3:** `node --test public/js/shared/clinic-logo-rules.test.js` → падает.
- [ ] **Step 4: модуль** `public/js/shared/clinic-logo-rules.js`:

```js
// CLINIC_PROFILE_V1 — ЛОГОТИПЫ КЛИНИКИ: что принимается. Чистый модуль: его
// спрашивают экран «Компания» до отправки и хранилище (routes/storage.js)
// после — браузер обойти можно, curl проверку не спрашивает.
//
// Два логотипа, оба — PNG с прозрачностью (решение владельца, 2026-10-06):
// квадратный — шапка программы, печать, карточки у партнёров; вертикальный —
// страница клиники у партнёров. SVG не принимается: хранилище не отдаёт его
// внутри страницы (V3120_FIX M6), а партнёры ждут растр.

export const LOGO_BUCKET = 'clinic-logos';
export const LOGO_KINDS = Object.freeze(['square', 'portrait']);
export const MAX_LOGO_BYTES = 1024 * 1024;
export const MAX_LOGO_MB = 1;
export const LOGO_MIN_SIDE = 256;
export const LOGO_MAX_SIDE = 2048;
export const SQUARE_TOLERANCE = 0.02;
// Печатная копия квадратного (doc_settings.logo_data_url) — те же пределы, что
// у единственного логотипа до шага 3 (views/documents-settings.js: 220 px,
// 90 000 знаков): размер бланков, localStorage и справочника филиалов не растёт.
export const PRINT_COPY_SIDE = 220;
export const PRINT_COPY_MAX_CHARS = 90000;

export const LOGO_TEMPLATES = Object.freeze({
  empty:       'Файл пустой — загружать нечего.',
  tooLarge:    'Логотип {got} МБ — это больше предела в {max} МБ. Сохраните PNG поменьше.',
  notPng:      'Логотип — только PNG с прозрачным фоном.',
  opaque:      'У этого PNG нет прозрачности: фон будет виден белым прямоугольником. Сохраните логотип с прозрачным фоном.',
  badSize:     'Логотип {w}×{h} px. Нужно от {min} до {max} px по каждой стороне.',
  notSquare:   'Квадратный логотип {w}×{h} px — стороны должны быть равны.',
  notPortrait: 'Вертикальный логотип {w}×{h} px — высота должна быть больше ширины.',
});

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (b, o) => b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const ascii4 = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** { width, height, hasAlpha } из заголовка PNG; null — это не PNG. */
export function pngInfo(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (b.length < 33) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
  if (ascii4(b, 12) !== 'IHDR') return null;
  const width = u32(b, 16), height = u32(b, 20), colorType = b[25];
  let hasAlpha = colorType === 4 || colorType === 6;
  // Палитра и RGB прозрачны только с чанком tRNS — он стоит до первого IDAT.
  for (let o = 8; !hasAlpha && o + 8 <= b.length;) {
    const len = u32(b, o), type = ascii4(b, o + 4);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { width, height, hasAlpha };
}

const fail = (code, template, params = {}) => ({ code, template, params });

/** null — годится; иначе { code, template, params } (перевод шаблона, подстановка потом). */
export function logoRefusal({ kind, name, bytes }) {
  const size = bytes ? bytes.length : 0;
  if (!size) return fail('file_empty', LOGO_TEMPLATES.empty);
  if (size > MAX_LOGO_BYTES) {
    return fail('file_too_large', LOGO_TEMPLATES.tooLarge, { got: (size / (1024 * 1024)).toFixed(1), max: String(MAX_LOGO_MB) });
  }
  const info = /\.png$/i.test(String(name || '')) ? pngInfo(bytes) : null;
  if (!info) return fail('logo_not_png', LOGO_TEMPLATES.notPng);
  if (!info.hasAlpha) return fail('logo_not_transparent', LOGO_TEMPLATES.opaque);
  const { width: w, height: h } = info;
  const dims = { w: String(w), h: String(h) };
  if (Math.min(w, h) < LOGO_MIN_SIDE || Math.max(w, h) > LOGO_MAX_SIDE) {
    return fail('logo_bad_size', LOGO_TEMPLATES.badSize, { ...dims, min: String(LOGO_MIN_SIDE), max: String(LOGO_MAX_SIDE) });
  }
  if (kind === 'square' && Math.abs(w - h) > Math.max(w, h) * SQUARE_TOLERANCE) return fail('logo_not_square', LOGO_TEMPLATES.notSquare, dims);
  if (kind === 'portrait' && !(h > w)) return fail('logo_not_portrait', LOGO_TEMPLATES.notPortrait, dims);
  return null;
}

/** Квадратная ли PNG-картинка в data URL (печатная копия) — для знака в шапке программы. */
export function isSquarePngDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return false;
  let bytes;
  try { bytes = typeof Buffer !== 'undefined' ? Buffer.from(m[1].slice(0, 64), 'base64') : Uint8Array.from(atob(m[1].slice(0, 64)), (c) => c.charCodeAt(0)); }
  catch { return false; }
  const info = pngInfo(bytes);
  return !!info && Math.abs(info.width - info.height) <= Math.max(info.width, info.height) * SQUARE_TOLERANCE;
}
```

- [ ] **Step 5: словарь** — статьи `LOGO_TEMPLATES` (`Файл пустой — загружать нечего.` уже есть — не дублировать):

| ru | uz | en |
|---|---|---|
| Логотип {got} МБ — это больше предела в {max} МБ. Сохраните PNG поменьше. | Logotip {got} MB — bu {max} MB chegarasidan katta. Kichikroq PNG saqlang. | The logo is {got} MB, over the {max} MB limit. Save a smaller PNG. |
| Логотип — только PNG с прозрачным фоном. | Logotip faqat shaffof fonli PNG bo‘lishi kerak. | The logo must be a PNG with a transparent background. |
| У этого PNG нет прозрачности: фон будет виден белым прямоугольником. Сохраните логотип с прозрачным фоном. | Bu PNG shaffof emas: fon oq to‘rtburchak bo‘lib ko‘rinadi. Logotipni shaffof fon bilan saqlang. | This PNG has no transparency: its background will show as a white box. Save the logo with a transparent background. |
| Логотип {w}×{h} px. Нужно от {min} до {max} px по каждой стороне. | Logotip {w}×{h} px. Har bir tomoni {min} dan {max} px gacha bo‘lishi kerak. | The logo is {w}×{h} px. Each side must be {min} to {max} px. |
| Квадратный логотип {w}×{h} px — стороны должны быть равны. | Kvadrat logotip {w}×{h} px — tomonlari teng bo‘lishi kerak. | The square logo is {w}×{h} px — the sides must be equal. |
| Вертикальный логотип {w}×{h} px — высота должна быть больше ширины. | Vertikal logotip {w}×{h} px — balandligi enidan katta bo‘lishi kerak. | The portrait logo is {w}×{h} px — the height must be greater than the width. |

- [ ] **Step 6:** тест зелёный. Дописать в него случай `isSquarePngDataUrl` (импорт `isSquarePngDataUrl` из модуля и `pngDataUrl` из `fake-png.js`):
  - `pngDataUrl(fakePng(220, 220))` → true;
  - `pngDataUrl(fakePng(220, 80))` → false;
  - `'data:image/jpeg;base64,AAAA'` → false.

  Сторожа: `i18n-coverage`, `i18n-uz-quality`.
- [ ] **Step 7: коммит** «Логотипы клиники: общий модуль правил — PNG с прозрачностью, квадратный и вертикальный, размеры и вес (CLINIC_PROFILE_V1)».

---

## Task 6: Хранилище — корзина `clinic-logos` (CLINIC_PROFILE_V1)

**Files:**
- Modify: `server/routes/storage.js` (:32 `BUCKETS`, :55 `BUCKET_EXT`, рядом с :158 `photoTarget`, :318 POST, :426 GET, :470 DELETE)
- Create: `server/routes/logo-storage.test.js`
- Modify: `public/js/admin/i18n-strings.js` (сообщения сервера)

**Правило корзины:**
- Путь — ровно `clinic-logos/<square|portrait>/<ключ>.png`: вид логотипа — в пути, как id врача у `doctor-photos`.
- Пишет администратор или тот, кому выдано «Компания: Изменение» (`grantAllowsAdminOr(db, user, 'settings.company', 'edit')`).
- В филиале запись отклоняется 409: логотипы — главного здания.
- Перезаписи нет (`wx`), DELETE — 403 (Р7).
- Читает любой вошедший: логотип печатается на бланках.

- [ ] **Step 1: падающий тест** `server/routes/logo-storage.test.js`.
  - Стенд — копия `setup()` / `login()` / `put` / `get` / `del` из `server/routes/photo-storage.test.js:14-52`.
  - Пользователи: `boss` (admin), `reg` (registrar), `lab` (lab).
  - Плюс `addGrants` из `server/db/write-grant.test.js:19-25`.
  - Плюс `becomeSecondary` из `server/services/branch-sync/identity.js`.

  Случаи:
  1. `boss` кладёт `clinic-logos/square/1-a.png` = `fakePng(512, 512)` → 200. `lab` читает его → 200, `Content-Type: image/png`.
  2. `reg` без права → 403. После `addGrants(db, 'registrar', { settings: 'edit', 'settings.company': 'edit' })` → 200 (другой ключ `2-b.png`).
  3. Отказы правил: `fakePng(512, 512, { colorType: 2 })` → 415 `logo_not_transparent`; `fakePng(600, 500)` в `square/` → 415 `logo_not_square`; `fakePng(800, 600)` в `portrait/` → 415 `logo_not_portrait`; `square/x.jpg` → 415 `logo_not_png`; `fakePng(512, 512, { pad: 1024 * 1024 })` → 413 `file_too_large`. В теле ошибки есть `template` и `params` (перевод на экране).
  4. Неверные пути → 400: `clinic-logos/round/a.png`, `clinic-logos/square/a/b.png`, `clinic-logos/legacy/x.png` (legacy пишет только сервер).
  5. Тот же путь второй раз → 409 `file_exists`. `DELETE` → 403, файл на диске остаётся.
  6. Филиал: `becomeSecondary(db, { letter: 'C', name: 'Чиланзар' })` → POST от `boss` → 409, сообщение «Логотипы клиники меняются в главном здании.».
- [ ] **Step 2:** `node --test server/routes/logo-storage.test.js` → падает (корзины нет — 400).
- [ ] **Step 3: правка** `server/routes/storage.js`:

```js
import { LOGO_BUCKET, LOGO_KINDS, logoRefusal } from '../../public/js/shared/clinic-logo-rules.js';   // CLINIC_PROFILE_V1
import { readIdentity } from '../services/branch-sync/identity.js';   // CLINIC_PROFILE_V1

const BUCKETS = new Set(['clinic-docs', 'telegram-media', 'patient-photos', 'doctor-photos', LOGO_BUCKET]);   // CLINIC_PROFILE_V1
// BUCKET_EXT:
  [LOGO_BUCKET]: new Set(['.png']),   // CLINIC_PROFILE_V1

// CLINIC_PROFILE_V1 — ЛОГОТИП КЛИНИКИ УЗНАЁТСЯ ПО ПУТИ, как фото врача:
//   clinic-logos/square/<ключ>.png    — квадратный (шапка, печать, карточки)
//   clinic-logos/portrait/<ключ>.png  — вертикальный (страница клиники у партнёров)
// Вид логотипа — в пути, поэтому правило «квадратный — квадратный» проверяется
// по тому месту, куда файл ложится, а не по слову в теле запроса.
// clinic-logos/legacy/… пишет только сервер (services/clinic-logo-legacy.js).
export function logoTarget(bucket, rest) {
  if (bucket !== LOGO_BUCKET) return null;
  const s = segmentsOf(rest);
  return (s.length === 2 && LOGO_KINDS.includes(s[0]) && s[1]) ? { kind: s[0] } : null;
}
const LOGO_DENIED = 'Логотипы клиники меняет администратор или тот, кому выдано изменение «Компании».';
const LOGO_MAIN_ONLY = 'Логотипы клиники меняются в главном здании.';
const LOGO_NO_DELETE = 'Логотип не удаляется — новая загрузка заменяет прежний, а «Удалить» в «Компании» снимает его с бланков.';
```

  Внутри `storageRoutes`:

```js
  // CLINIC_PROFILE_V1 — кто кладёт логотип клиники: не в филиале (логотипы
  // главного здания приезжают к нему печатной копией), администратор или
  // «Компания: Изменение» — тот же ключ, что пишет doc_settings.
  function logoDenial(req) {
    const user = req.user;
    if (!user) return { status: 401, code: 'unauthorized', message: 'Требуется вход.' };
    if (!db) return { status: 403, code: 'forbidden', message: LOGO_DENIED };
    try { if (readIdentity(db).role === 'secondary') return { status: 409, code: 'conflict', message: LOGO_MAIN_ONLY }; }
    catch { /* строки нет — установка не филиал */ }
    try { if (grantAllowsAdminOr(db, user, 'settings.company', 'edit')) return null; } catch { /* права не прочитались — отказ */ }
    return { status: 403, code: 'forbidden', message: LOGO_DENIED };
  }
```

  В POST — до общей проверки расширения:

```js
    // CLINIC_PROFILE_V1 — логотип клиники: путь → здание и право → PNG с прозрачностью.
    if (req.params.bucket === LOGO_BUCKET) {
      const target = logoTarget(req.params.bucket, req.params.rest);
      if (!target) return badPath(res);
      const d = logoDenial(req);
      if (d) return refuse(res, d.status, d.code, d.message);
      const bad = logoRefusal({ kind: target.kind, name: path.basename(abs), bytes: body });
      if (bad) {
        return res.status(bad.code === 'file_too_large' ? 413 : 415)
          .json({ error: { code: bad.code, message: refusalText(bad), template: bad.template, params: bad.params } });
      }
    }
```

  Остальные места:
  - Условие общей проверки расширения — дописать `&& req.params.bucket !== LOGO_BUCKET`.
  - `noOverwrite` — дописать `|| req.params.bucket === LOGO_BUCKET`.
  - В GET — `if (req.params.bucket === LOGO_BUCKET && !logoTarget(req.params.bucket, req.params.rest)) return badPath(res);`.
  - В DELETE, первой проверкой после `safeResolve` — `if (req.params.bucket === LOGO_BUCKET) return refuse(res, 403, 'forbidden', LOGO_NO_DELETE);`.
- [ ] **Step 4: словарь** — три сообщения сервера:

| ru | uz | en |
|---|---|---|
| Логотипы клиники меняет администратор или тот, кому выдано изменение «Компании». | Klinika logotiplarini administrator yoki «Kompaniya»ni o‘zgartirish huquqi berilgan xodim o‘zgartiradi. | Clinic logos are changed by the administrator or by someone granted “Company” edit rights. |
| Логотипы клиники меняются в главном здании. | Klinika logotiplari bosh binoda o‘zgartiriladi. | Clinic logos are changed in the main building. |
| Логотип не удаляется — новая загрузка заменяет прежний, а «Удалить» в «Компании» снимает его с бланков. | Logotip o‘chirilmaydi — yangi yuklash eskisini almashtiradi, «Kompaniya»dagi «O‘chirish» esa uni blankalardan olib tashlaydi. | A logo is not deleted — a new upload replaces the old one, and “Delete” in “Company” takes it off the forms. |

- [ ] **Step 5:** тест зелёный. Сторожа: `server/routes/storage.test.js`, `storage-v3120.test.js`, `photo-storage.test.js`, `server/i18n-server-messages.test.js`.
- [ ] **Step 6: коммит** «Хранилище: корзина логотипов клиники — квадратный и вертикальный PNG, право «Компании», в филиале — главного здания (CLINIC_PROFILE_V1)».

---

## Task 7: Прежний логотип сохраняется файлом при запуске (CLINIC_PROFILE_V1)

**Files:**
- Create: `server/services/clinic-logo-legacy.js`, `server/services/clinic-logo-legacy.test.js`
- Modify: `server/index.js` (сразу за блоком `crmUnifyRepair`, ~:186-193 — файл правит и сборщик CRM: только свой ханк по метке)

- [ ] **Step 1: падающий тест** `server/services/clinic-logo-legacy.test.js`:

```js
// CLINIC_PROFILE_V1 — прежний логотип «Компании» (data URL) не теряется:
// при запуске он ложится файлом в хранилище, строка базы не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { fakePng, pngDataUrl } from '../test-helpers/fake-png.js';
import { becomeSecondary } from './branch-sync/identity.js';
import { preserveLegacyLogo } from './clinic-logo-legacy.js';

function seed(values = {}) {
  const db = openDb(':memory:'); migrate(db);
  const sets = Object.keys(values).map((k) => `${k} = @${k}`).join(', ');
  if (sets) db.prepare(`UPDATE doc_settings SET ${sets} WHERE id = 1`).run(values);
  return db;
}
const legacyDir = (storage) => path.join(storage, 'clinic-logos', 'legacy');

test('data URL без квадратного — файл с теми же байтами; строка как была; повтор ничего не пишет', () => {
  const png = fakePng(220, 90);
  const db = seed({ logo_data_url: pngDataUrl(png) });
  const storage = tmpDir('em-legacy-logo-');
  const first = preserveLegacyLogo(db, storage);
  assert.match(first.kept, /^legacy\/logo-[0-9a-f]{16}\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(storage, 'clinic-logos', first.kept)), png);
  assert.equal(db.prepare('SELECT logo_data_url FROM doc_settings').get().logo_data_url, pngDataUrl(png));
  const second = preserveLegacyLogo(db, storage);
  assert.equal(second.already, true);
  assert.equal(fs.readdirSync(legacyDir(storage)).length, 1);
});

test('квадратный уже загружен, логотипа нет, филиал, не data URL — ничего не пишется и не падает', () => {
  for (const db of [
    seed({ logo_data_url: pngDataUrl(fakePng(220, 220)), logo_square_path: 'square/1-a.png' }),
    seed({}),
    (() => { const d = seed({ logo_data_url: pngDataUrl(fakePng(220, 90)) }); becomeSecondary(d, { letter: 'C', name: 'Чиланзар' }); return d; })(),
    seed({ logo_data_url: 'не картинка' }),
  ]) {
    const storage = tmpDir('em-legacy-logo-');
    assert.doesNotThrow(() => preserveLegacyLogo(db, storage));
    assert.equal(fs.existsSync(legacyDir(storage)), false);
  }
});

test('index.js вызывает сохранение после миграций', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = src.indexOf('preserveLegacyLogo(db');
  assert.ok(at > src.indexOf('migrate(db);'), 'вызов должен стоять после migrate(db)');
});
```

- [ ] **Step 2:** `node --test server/services/clinic-logo-legacy.test.js` → падает.
- [ ] **Step 3: модуль** `server/services/clinic-logo-legacy.js`:

```js
// CLINIC_PROFILE_V1 — ПРЕЖНИЙ ЛОГОТИП НЕ ТЕРЯЕТСЯ.
//
// До шага 3 логотип «Компании» жил одной строкой data URL в
// doc_settings.logo_data_url. Теперь эта колонка — печатная копия
// квадратного логотипа: первая же загрузка квадратного её перепишет. Чтобы
// прежний логотип пережил замену, при каждом запуске (после миграций) он
// ложится файлом clinic-logos/legacy/logo-<sha256:16>.<расширение>.
//
// Строка базы не меняется. Имя — по содержимому, поэтому повтор ничего не
// пишет, а другой прежний логотип (восстановили копию) получит свой файл.
// Копирует только главное здание (или установка без филиалов): у филиала
// logo_data_url — копия главного, и оригинал лежит там. Пока квадратный
// загружен, logo_data_url — его копия, копировать нечего.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readIdentity } from './branch-sync/identity.js';
import { LOGO_BUCKET } from '../../public/js/shared/clinic-logo-rules.js';

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' };

export function preserveLegacyLogo(db, storageDir) {
  let row;
  try { row = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get(); } catch { return { kept: null }; }
  if (!row || !row.logo_data_url || row.logo_square_path) return { kept: null };
  try { if (readIdentity(db).role === 'secondary') return { kept: null }; } catch { /* нет строки — не филиал */ }
  const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(row.logo_data_url));
  if (!m) return { kept: null };
  const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  if (!bytes.length) return { kept: null };
  const name = 'logo-' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + (EXT[m[1].toLowerCase()] || '.bin');
  const rel = 'legacy/' + name;
  const abs = path.join(storageDir, LOGO_BUCKET, 'legacy', name);
  if (fs.existsSync(abs)) return { kept: rel, already: true };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes, { flag: 'wx' });
  return { kept: rel, already: false };
}
```

- [ ] **Step 4: `server/index.js`.**
  - Импорт рядом с остальными: `import { preserveLegacyLogo } from './services/clinic-logo-legacy.js';   // CLINIC_PROFILE_V1`.
  - Сразу за блоком `crmUnifyRepair`:

```js
  // CLINIC_PROFILE_V1 — прежний логотип «Компании» (data URL) — файлом в
  // хранилище, до того как его заменит квадратный. Строка не меняется; сбой —
  // предупреждение, а не отказ запуска; повтор при следующем запуске.
  try { preserveLegacyLogo(db, path.join(DATA_DIR, 'storage')); }
  catch (e) { console.warn('[legacy-logo]', e && e.message); }
```

- [ ] **Step 5:** тест зелёный. Сторожа: `server/index.datadir.test.js`, `server/app-test-hygiene.test.js`.
- [ ] **Step 6: коммит** (свой ханк `server/index.js` по метке) «Прежний логотип клиники сохраняется файлом при запуске — замена квадратным его не теряет (CLINIC_PROFILE_V1)».

---

## Task 8: Запись клиники, сайт на бланке, в PDF Telegram — только встроенный логотип (CLINIC_PROFILE_V1)

**Files:**
- Modify: `server/services/rpc/clinic.js` (:17-50), `public/js/shared/company-branding.js` (:57-75 `overlayCompanyBranding`), `server/services/telegram/render.js` (:80-90 `loadServerDocSettings`)
- Test: `server/services/rpc/clinic.test.js`, `public/js/shared/company-branding.test.js`, `server/services/telegram/render-branding.test.js`

- [ ] **Step 1: падающие тесты.**
  - (a) `clinic.test.js`: после `UPDATE doc_settings SET clinic_name='Шифо', name_uz='Shifo', name_en='Shifo Clinic', website='https://shifo.uz'` запись клиники содержит `name: 'Шифо'`, `name_ru: 'Шифо'`, `name_uz: 'Shifo'`, `name_en: 'Shifo Clinic'`, `website: 'https://shifo.uz'`. При пустых — `name_uz`/`name_en`/`website` равны `null`.
  - (b) `company-branding.test.js`: `overlayCompanyBranding({}, { name: 'Шифо', website: 'https://shifo.uz/' }).web === 'shifo.uz'`. Существующий тест с `'shifo.uz'` не трогать.
  - (c) `render-branding.test.js`: `seed({ company: { logo_data_url: '/api/storage/clinic-logos/square/1-a.png' } })` → в `loadServerDocSettings(db)` поля `logoUrl` и `logoDataUrl` пусты. Причина: Chrome печатает из `file://` и такой адрес не достанет.
  - (d) там же: с `LOGO_NEW` (data URL) — `buildSheetHtml({ type: 'custom', s, bodyHtml: '<p>x</p>' })` содержит и `LOGO_NEW`, и видимое название (`/>\s*Новая\s*</`) — правило задачи 2 доходит до PDF.
- [ ] **Step 2:** `node --test server/services/rpc/clinic.test.js public/js/shared/company-branding.test.js server/services/telegram/render-branding.test.js` → (a), (b), (c) падают.
- [ ] **Step 3: правка.**

  `rpc/clinic.js` — в возвращаемый объект:

```js
    // CLINIC_PROFILE_V1 — названия на трёх языках и сайт. name — по-прежнему
    // то, что печатается (clinic_name, запасное 'Easy-Med Local'); name_uz /
    // name_en идут наружу и в интерфейс на этих языках (shared/company-branding.js
    // печатает name_ru || name — то же clinic_name).
    name_ru: settings.clinic_name || null,
    name_uz: settings.name_uz || null,
    name_en: settings.name_en || null,
    website: settings.website || null,
```

  `company-branding.js`, в `overlayCompanyBranding`:

```js
    // CLINIC_PROFILE_V1 — сайт на бланке — без схемы и косой черты в конце.
    if (c.website)           s.web        = String(c.website).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
```

  `telegram/render.js`, `loadServerDocSettings`:

```js
  const s = resolveDocSettings({ ...SERVER_DOC_BASE, ...brand }, getClinicBySlug(db));
  // CLINIC_PROFILE_V1 — в PDF уходит только ВСТРОЕННЫЙ логотип (data:image/…).
  // Chrome печатает из file://: адрес /api/storage/… он не достанет (вход,
  // другой источник), и в PDF встал бы битый квадрат. Печатная копия
  // квадратного логотипа — data URL всегда (Р4); это замок на будущее.
  for (const k of ['logoUrl', 'logoDataUrl']) if (s[k] && !/^data:image\//i.test(String(s[k]))) s[k] = null;
  return s;
```

- [ ] **Step 4:** тесты зелёные. Сторожа:
  - `server/services/telegram/*.test.js` (явными путями);
  - `server/services/rpc/client-rpc-coverage.test.js`;
  - `__tests__/title-sheet.test.mjs`, `admissions-window.test.mjs`.
- [ ] **Step 5: коммит** «Запись клиники: названия на трёх языках и сайт; сайт на бланке без https://; в PDF Telegram — только встроенный логотип (CLINIC_PROFILE_V1)».

---

## Task 9: Каскад «Страна → Регион → Район» — один модуль для регистрации и «Компании» (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/geo-cascade.js`, `public/js/admin/__tests__/geo-cascade.test.mjs`
- Modify: `public/js/admin/views/patient-create-modal.js` (:1460-1537 — функция уезжает; импорт и реэкспорт)

**Сейчас:**
- `geoCascade()` живёт в конце окна заведения пациента и пишет в `patients.*` русские имена.
- `registration.js:31-41` реэкспортирует её оттуда.
- Загрузка списков ждёт массив: чужой ответ (поддельный сервер `settings-split` отдаёт строку `doc_settings` на любой `/api/db`) уронил бы `[...rows]`.
- Попутная находка, в шаге не чинится — доложить. В режиме имён страна по умолчанию — `'Uzbekistan'`, а в базе `'Узбекистан'` (мигр. 030). Регистрация страну не предвыбирает.

- [ ] **Step 1: падающий тест** `__tests__/geo-cascade.test.mjs`.
  - Поддельный DOM: классы `FakeNode` / `FakeText` / `makeStyle` / `descendants` / `matches` / `mkEl` из `__tests__/clinic-brand.test.mjs:21-110` (у них есть `options` / `selectedIndex`). Плюс `globalThis.document` и `localStorage['admin.lang'] = 'ru'` до импорта.
  - `fetch('/api/db')` разбирает `desc.table` и фильтр `desc.filters`:

```js
const GEO = {
  countries: [{ id: 1, name: 'Узбекистан', name_uz: 'O‘zbekiston', name_en: 'Uzbekistan', code: 'UZ', active: 1 },
              { id: 2, name: 'Казахстан', name_uz: 'Qozog‘iston', name_en: 'Kazakhstan', code: 'KZ', active: 1 },
              { id: 9, name: 'Своя страна', name_uz: null, name_en: null, code: null, active: 1 }],
  regions:   [{ id: 14, country_id: 1, name: 'город Ташкент', name_uz: 'Toshkent shahri', name_en: 'Tashkent city', code: 'tashkent-city', active: 1 }],
  districts: [{ id: 101, region_id: 14, name: 'Юнусабадский район', name_uz: 'Yunusobod tumani', name_en: 'Yunusabad district', code: 'yunusobod', active: 1 },
              { id: 102, region_id: 14, name: 'Свой район', code: null, active: 1 }],
};
```

  Случаи:
  1. `geoCascade({ by: 'code', onChange })` + `preset({ country: 'UZ', region: 'tashkent-city', district: 'yunusobod' })`; `await geo.ready`.
     - значения стран — `['', 'UZ', 'KZ']` («Своя страна» без кода не предложена);
     - выбраны `UZ` / `tashkent-city` / `yunusobod`;
     - `geo.selected().district.name_uz === 'Yunusobod tumani'`;
     - `onChange` вызван с теми же строками;
     - районы без кода не предложены.
  2. Режим по умолчанию (имена): значения — русские имена, «Своя страна» предложена — регистрация как была.
  3. Регион выбран, район пуст (`preset({ country: 'UZ', region: 'tashkent-city' })`, режим кода) → список районов загружен (2 опции: пустая + `yunusobod`).
  4. `/api/db` отвечает объектом вместо массива → списки пустые, исключения нет.
- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/geo-cascade.test.mjs` → падает (модуля нет).
- [ ] **Step 3: модуль** `views/geo-cascade.js` — перенос `geoCascade` из `patient-create-modal.js:1460-1537` с тремя добавлениями. Код целиком:

```js
// GEO_HARDCODE_V1 / CLINIC_PROFILE_V1 — каскад «Страна → Регион → Район» из
// справочника (миграции 030, 132). ОДИН на программу: окно заведения пациента
// хранит ИМЕНА (patients.country / region / district — текст, как всегда),
// «Компания» — КОДЫ (doc_settings.country_code / region_code / district_code:
// партнёры получают коды). Вынесен из patient-create-modal.js; поведение
// регистрации не изменилось.
import { supabase } from '../../supabase.js';
import { h, clear } from '../ui.js';
import { tr, getLang } from '../i18n.js';

export function geoCascade({ by = 'name', onChange = null } = {}) {
    const byCode = by === 'code';
    const valueOf = (r) => (byCode ? r.code : r.name);
    const countrySel  = h('select', { name: 'country'  });
    const regionSel   = h('select', { name: 'region'   });
    const districtSel = h('select', { name: 'district' });
    const rowsById = new Map();

    // Подпись — на языке интерфейса (uz / en из мигр. 132); значение — имя или код.
    const label = (r) => { const l = getLang(); return (l === 'uz' && r.name_uz) || (l === 'en' && r.name_en) || r.name; };
    function paintSelect(sel, rows, placeholder, selected) {
        clear(sel);
        sel.appendChild(h('option', { value: '' }, placeholder));
        // CLINIC_PROFILE_V1 — в режиме кодов строка без кода не предлагается:
        // партнёр её не прочтёт (её завела клиника в «Географии»).
        const usable = rows.filter((r) => r && (!byCode || r.code));
        for (const r of [...usable].sort((a, b) => label(a).localeCompare(label(b), 'ru'))) {
            const opt = h('option', { value: valueOf(r) }, label(r));
            opt.dataset.id = r.id;
            rowsById.set(String(r.id), r);
            if (selected && selected === valueOf(r)) opt.selected = true;
            sel.appendChild(opt);
        }
    }
    function rowOf(sel) {
        const o = sel.options ? sel.options[sel.selectedIndex] : null;
        const id = o && o.dataset ? (o.dataset.id || '') : '';
        return id ? (rowsById.get(String(id)) || null) : null;
    }
    const selectedId = (sel) => { const r = rowOf(sel); return r ? r.id : ''; };
    const selected = () => ({ country: rowOf(countrySel), region: rowOf(regionSel), district: rowOf(districtSel) });
    const fire = () => {
        if (typeof onChange !== 'function') return;
        try { onChange(selected()); } catch (e) { console.warn('[geo-cascade]', e); }
    };
    const load = async (table, filter) => {
        try {
            let q = supabase.from(table).select(byCode ? 'id, name, name_uz, name_en, code' : 'id, name, name_uz, name_en')
                .eq('active', true).order('name');
            if (filter) q = q.eq(filter[0], filter[1]);
            const { data, error } = await q;
            if (error) return [];
            return Array.isArray(data) ? data : [];   // CLINIC_PROFILE_V1 — не массив — пустой список, не исключение
        } catch (e) { return []; }
    };
    const regionsPh   = (n) => (n ? tr('Выберите регион') : tr('Регионы не заведены — Настройки → География'));
    const districtsPh = (n) => (n ? tr('Выберите район') : tr('Районы не заведены — Настройки → География'));

    paintSelect(countrySel,  [], tr('Загрузка…'));
    paintSelect(regionSel,   [], tr('Сначала выберите страну'));
    paintSelect(districtSel, [], tr('Сначала выберите регион'));

    countrySel.addEventListener('change', async () => {
        paintSelect(regionSel,   [], tr('Загрузка…'));
        paintSelect(districtSel, [], tr('Сначала выберите регион'));
        const cid = selectedId(countrySel);
        const regs = cid ? await load('regions', ['country_id', cid]) : [];
        paintSelect(regionSel, regs, regionsPh(regs.length));
        fire();
    });
    regionSel.addEventListener('change', async () => {
        paintSelect(districtSel, [], tr('Загрузка…'));
        const rid = selectedId(regionSel);
        const dists = rid ? await load('districts', ['region_id', rid]) : [];
        paintSelect(districtSel, dists, districtsPh(dists.length));
        fire();
    });
    districtSel.addEventListener('change', fire);

    // PATIENT_FORM_ONE_V1 — режим правки: выбор по сохранённым значениям, как
    // только соответствующий список приехал. ready — для экранов и тестов.
    const want = { country: '', region: '', district: '' };
    const ready = (async () => {
        const countries = await load('countries', null);
        paintSelect(countrySel, countries,
            countries.length ? tr('Выберите страну') : tr('Список стран не загрузился — обновите страницу'),
            want.country || (byCode ? 'UZ' : 'Uzbekistan'));
        const cid = selectedId(countrySel);
        if (cid) {
            const regs = await load('regions', ['country_id', cid]);
            paintSelect(regionSel, regs, regionsPh(regs.length), want.region);
            const rid = selectedId(regionSel);
            // CLINIC_PROFILE_V1 — в «Компании» районы нужны и тогда, когда район ещё не выбран.
            if (rid && (want.district || byCode)) {
                const dists = await load('districts', ['region_id', rid]);
                paintSelect(districtSel, dists, districtsPh(dists.length), want.district);
            }
        }
        fire();
    })();

    return { countrySel, regionSel, districtSel, ready, selected,
        preset: ({ country, region, district } = {}) => { want.country = country || ''; want.region = region || ''; want.district = district || ''; } };
}
```

- [ ] **Step 4: `patient-create-modal.js`.** Удалить тело `geoCascade` (:1460-1537 вместе с комментарием-заголовком над ней). Наверху, к импортам:

```js
// CLINIC_PROFILE_V1 — каскад вынесен в geo-cascade.js (им пользуется и «Компания»); имя и адрес экспорта прежние.
import { geoCascade } from './geo-cascade.js';
export { geoCascade };
```

  Импорты `clear` / `getLang` в окне не трогать, если они нужны остальному коду. Это проверит `node --check`.
- [ ] **Step 5:** тест зелёный; `node --check public/js/admin/views/patient-create-modal.js`. Сторожа:
  - `__tests__/patient-create-modal.test.mjs`, `fast-registration.test.mjs`;
  - `db-query-schema.test.mjs` (новый `select` с `code`);
  - `i18n-coverage.test.mjs`.
- [ ] **Step 6: коммит** «Каскад «Страна → Регион → Район» — отдельный модуль: регистрация хранит имена, «Компания» — коды справочника (CLINIC_PROFILE_V1)».

---

## Task 10: «Компания» — названия и описание на трёх языках, сайт и соцсети (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/company-fields.js`, `public/js/admin/__tests__/company-profile.test.mjs`
- Modify: `public/js/admin/views/documents-settings.js` (`DEFAULTS`, `buildForm` :102-140, `applyStateToControls` :142-151, `load` :217-238, `save` :247-284)
- Modify: `public/js/admin/__tests__/settings-split.test.mjs` (:228-261)
- Modify: `public/css/admin-views.css` (в конец), `public/js/admin/i18n-strings.js`

**Экран после задачи:**
- **Карточка «Реквизиты клиники»:**
  - «Название клиники» — три поля RU / UZ / EN; RU — это `clinic_name`, подсказка «RU печатается на документах…»;
  - «Коротко о клинике» — три поля textarea, до 600 знаков;
  - дальше как было: Адрес (пока прежнее поле), Телефон, Электронная почта, Номер лицензии, Фирменный цвет, Логотип (пока прежний).
- **Карточка «Сайт и соцсети»** (`Icon('Globe')`):
  - «Сайт» — подсказка «Можно без https:// — допишем сами.»;
  - «Telegram-бот» — «Бот для записи и вопросов пациентов. Имя заканчивается на bot.»;
  - «Telegram-канал» — «Новости и акции клиники.»;
  - «Instagram» — «Можно вставить ссылку — оставим только имя.»;
  - под каждым полем — строка ошибки.
- **Сохранение:**
  - нормализует (`normalizeProfile`) и проверяет (`companyProblems`);
  - при ошибках — текст под полями, тост «Проверьте выделенные поля.», запрос не уходит;
  - иначе шлёт **ровно** `COMPANY_COLUMNS`. Колонки, которые экран ещё не показывает, уходят как загружены.

- [ ] **Step 1: харнесс и падающие тесты** `__tests__/company-profile.test.mjs`.
  - Поддельный DOM — как в задаче 9; `localStorage['admin.lang'] = 'ru'`; `globalThis.window = { CLINIC: { id: 1, name: 'Клиника «Шифо»', building_role: 'main' }, location: { hostname: 'localhost' }, … }`.
  - `fetch`:
    - `/api/db` + `table: 'doc_settings'` — `select` отдаёт `docRow`, `update` записывает `lastUpdate = desc.values` и сливает в `docRow`;
    - `countries` / `regions` / `districts` — `GEO` из задачи 9 с фильтрами;
    - `POST /api/storage/…` — пишет `uploads.push({ url, type: opts.headers['Content-Type'] })` и отдаёт `{ data: { path } }`;
    - `/api/rpc/get_clinic_by_slug` — `{ data: window.CLINIC }`.
  - `docRow` — строка после миграции 240: `clinic_name: 'Клиника «Шифо»'`, `address: 'Ташкент, ул. Мира 1'`, `address_manual: 1`, остальные колонки `COMPANY_COLUMNS` пустые, `accent_color: '#167873'`.
  - Помощники:
    - `triInput(root, label, lang)` — ячейка `.docprof-tricell`, в чьей метке есть `label` и тег `RU|UZ|EN`, → её `INPUT`/`TEXTAREA`;
    - `fieldInput(root, label)` — `.field`, чья метка начинается с `label`, → её `INPUT`;
    - `type(el, v)` — `el.value = v; el.dispatchEvent({ type: 'input', target: el, currentTarget: el })`;
    - `save()` — клик по кнопке «Сохранить» + `await settle(60)`.

  Случаи:
  1. Поля RU/UZ/EN «Название клиники» показывают `clinic_name` / `name_uz` / `name_en`. Ввели `Shifo` в UZ и `Shifo Clinic` в EN, «Коротко о клинике» RU — «Семейная клиника.» → сохранение: `name_uz === 'Shifo'`, `name_en === 'Shifo Clinic'`, `about_ru === 'Семейная клиника.'`, `clinic_name` прежнее.
  2. Ссылки: «Сайт» `shifo.uz`, «Telegram-бот» `https://t.me/shifo_clinic_bot`, «Instagram» `https://instagram.com/shifo.uz/` → `website === 'https://shifo.uz'`, `telegram_bot === '@shifo_clinic_bot'`, `instagram === '@shifo.uz'`.
  3. «Telegram-бот» `@shifo` → запроса нет (`lastUpdate` остался `null`); под полем текст «Имя Telegram-бота заканчивается на «bot»…».
  4. `Object.keys(lastUpdate).sort()` равно `[...COMPANY_COLUMNS].sort()`; `address === 'Ташкент, ул. Мира 1'`, `address_manual === 1` (не тронуты).

  В `settings-split.test.mjs`:
  - тест «только сведения о клинике»: заменить подсчёт **всех** `SELECT`/`TEXTAREA` на проверку именно настроек шаблона —
    `nodes.filter((n) => n.tagName === 'SELECT' && walk(n).some((o) => o.tagName === 'OPTION' && /^(A4|A5|Letter)$/.test(textOf(o)))).length === 0` и
    `nodes.filter((n) => n.tagName === 'TEXTAREA' && /Спасибо за визит|Электронный документ/.test(String(n.value) + textOf(n))).length === 0`.
    Причина: у экрана появились свои списки (адрес) и текстовые поля (описание).
  - тест «сохранение шлёт ТОЛЬКО свои колонки»: ожидание — `[...COMPANY_COLUMNS].sort()` (импорт из `../../shared/clinic-profile.js`), плюс проверка, что `paper_size`, `show_watermark`, `footer_note`, `legal_note`, `lab_scope` в теле нет.
- [ ] **Step 2:** `node --experimental-vm-modules --test public/js/admin/__tests__/company-profile.test.mjs public/js/admin/__tests__/settings-split.test.mjs` → падают.
- [ ] **Step 3: `views/company-fields.js`:**

```js
// CLINIC_PROFILE_V1 — поля «Компании»: группа на трёх языках (вид — как в
// «Моём профиле»: .docprof-trigroup складывается в столбец на узком экране)
// и строка ошибки под полем. Метка — литерал вызывающего, перевод — в h().
import { h } from '../ui.js';
import { tr, trf } from '../i18n.js';

const LANG_TAG = { ru: 'RU', uz: 'UZ', en: 'EN' };

export function fieldErr() {
    const node = h('div', { class: 'co-err', role: 'alert' });
    node.hidden = true;
    return {
        node,
        set(msg, params) { node.textContent = msg ? (params ? trf(msg, params) : tr(msg)) : ''; node.hidden = !msg; },
    };
}

export function triGroup(label, values, { textarea = false, max = 0, onInput = null } = {}) {
    const inputs = {};
    const cells = ['ru', 'uz', 'en'].map((lng) => {
        const ctrl = textarea
            ? h('textarea', { rows: '3', class: 'docprof-ta', maxlength: max ? String(max) : null })
            : h('input', { type: 'text', class: 'docprof-in', maxlength: max ? String(max) : null, autocomplete: 'off' });
        ctrl.value = (values && values[lng]) || '';
        if (onInput) ctrl.addEventListener('input', () => onInput(lng, ctrl.value));
        const err = fieldErr();
        inputs[lng] = { ctrl, err };
        return h('div', { class: 'docprof-tricell' },
            h('label', { class: 'docprof-trilabel' }, h('span', { class: 'co-lang' }, LANG_TAG[lng]), ' ', label),
            ctrl, err.node);
    });
    return { node: h('div', { class: 'docprof-trigroup' }, ...cells), inputs };
}
```

- [ ] **Step 4: `documents-settings.js`.**
  - `DEFAULTS` — все `COMPANY_COLUMNS`: строки `''`, `address_manual: 0`, `accent_color: '#167873'`.
  - `load()`: `state = { ...DEFAULTS, ...(data || {}) }`. Если в строке нет `address_manual` (старая строка, поддельный сервер) — `state.address_manual = String(state.address || '').trim() ? 1 : 0`. Так прежний адрес считается вписанным руками.
  - `buildForm()` — по описанию экрана выше. Названия: `triGroup('Название клиники', { ru: state.clinic_name, uz: state.name_uz, en: state.name_en }, { max: NAME_MAX, onInput: (l, v) => { state[l === 'ru' ? 'clinic_name' : 'name_' + l] = v; renderPreview(); } })`. Описание — то же с `about_<l>`, `textarea: true`, `max: ABOUT_MAX`.
  - Карточка «Сайт и соцсети» — `field(label, input)` + `fieldErr()` у каждого поля. Значения пишутся в `state.website` / `telegram_bot` / `telegram_channel` / `instagram` на `input`.
  - `applyStateToControls()` раскладывает значения по новым полям.
  - `save()`:

```js
        const v = normalizeProfile(state);                           // CLINIC_PROFILE_V1
        const problems = companyProblems(v, geoAvailability());       // geoAvailability: задача 11; до неё — () => ({})
        showProblems(problems);
        if (Object.keys(problems).length) { toast(tr('Проверьте выделенные поля.'), 'fail'); return; }
        const payload = {};
        for (const c of COMPANY_COLUMNS) payload[c] = v[c] == null ? DEFAULTS[c] : v[c];
        payload.logo_data_url = v.logo_data_url || '';                // задача 1: NOT NULL
        payload.accent_color = v.accent_color || '#167873';
```

  `showProblems(p)` — каждому полю его `err.set(p[key] || '')`. Ключи: `website`, `telegram_bot`, `telegram_channel`, `instagram`, далее `maps_url`, `region_code`, `district_code`, `street_ru` (задача 11). Проверка — до `btn.disabled = true` / `paintSaveBtn`.
  - Подзаголовок страницы: «Название, описание, адрес, логотипы, контакты и ссылки клиники. Эти данные видят пациенты на сайте клиники, в Symptex и у партнёров.»
- [ ] **Step 5: CSS** в конец `admin-views.css`:

```css
/* CLINIC_PROFILE_V1 — «Компания»: метка языка, строка ошибки под полем. */
.co-lang { display: inline-block; min-width: 22px; padding: 0 4px; border-radius: 4px; background: var(--ink-50); color: var(--ink-600); font-size: 12.5px; font-weight: 700; text-align: center; }
.co-err { color: var(--danger); font-size: 12.5px; margin-top: 4px; }
.co-hint { color: var(--ink-500); font-size: 12.5px; margin-top: 4px; }
```

- [ ] **Step 6: словарь.** Все новые строки экрана (ru / uz / en):
  - заголовки карточек и подписи полей;
  - подсказки;
  - «Проверьте выделенные поля.»;
  - новый подзаголовок.

  Образцы терминов:
  - «Коротко о клинике» — Klinika haqida qisqacha — About the clinic;
  - «Сайт и соцсети» — Sayt va ijtimoiy tarmoqlar — Website and social media;
  - «Telegram-бот» — Telegram-bot — Telegram bot;
  - «Telegram-канал» — Telegram-kanal — Telegram channel;
  - «RU печатается на документах. UZ и EN видят партнёры и программа на узбекском и английском.» — «RU hujjatlarda bosiladi. UZ va EN ni hamkorlar hamda dasturning o‘zbekcha va inglizcha ko‘rinishi ko‘rsatadi.» — «RU is printed on documents. UZ and EN are shown to partners and in the Uzbek and English interface.».
- [ ] **Step 7:** тесты зелёные. Сторожа:
  - `clinic-brand.test.mjs`: вход, название под меню, «стёрли название» — запасное;
  - `role-reports-settings.test.mjs`, `settings-hub-groups.test.mjs`, `route-gate.test.mjs`;
  - `i18n-coverage`, `i18n-uz-quality`, `type-scale`, `db-query-schema`;
  - `server/db/write-grant.test.js`.
- [ ] **Step 8: коммит** «Компания: название и описание на трёх языках, сайт, Telegram и Instagram с проверкой формата (CLINIC_PROFILE_V1)».

---

## Task 11: «Компания» — адрес главного здания и адрес для документов, карта и маршрут (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/company-address.js`
- Modify: `public/js/admin/views/documents-settings.js` (прежнее поле «Адрес» уходит из «Реквизитов»; две новые карточки; `geoAvailability`)
- Test: `public/js/admin/__tests__/company-profile.test.mjs`
- Modify: `public/css/admin-views.css`, `public/js/admin/i18n-strings.js`

**Экран:**
- **Карточка «Адрес главного здания»** (`Icon('MapPin')`). В филиале — «Адрес этого здания», см. задачу 14.
  - Подсказка: «Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. Адреса других зданий — в «Филиалах».»
  - Строка из трёх списков «Страна» / «Город / область» / «Район» — `geoCascade({ by: 'code' })`.
  - «Улица, дом» RU/UZ/EN (до 160 знаков).
  - «Полный адрес — так его получат партнёры»: три строки `composeAddress` (RU/UZ/EN) и строка «Коды» (`country · region · district`).
  - Поле «Адрес в документах» (`state.address`), подсказка: «Так адрес печатается на бланках. Собирается из списков и улицы, пока вы не исправите его вручную.»
  - В ручном режиме — пометка «Вписан вручную» и кнопка «Собрать из списков» (`Icon('Refresh')`).
- **Карточка «Карта и маршрут»** (`Icon('Flag')`):
  - «Ссылка на клинику в Яндекс Картах», подсказка: «Найдите клинику в Яндекс Картах, нажмите «Поделиться» и скопируйте ссылку. Это адрес этого здания; у других зданий ссылки свои.»
  - Строка «Кнопка «Маршрут»» — `routeUrl` и ссылка «Открыть маршрут» (`target=_blank rel=noopener`), либо «Появится, когда будет ссылка на карту.».

- [ ] **Step 1: падающие тесты** в `company-profile.test.mjs` (`await geo.ready` — через `settle(80)` после открытия):
  1. Новая клиника: `docRow.address = ''`, `address_manual: 0`. Выбрали «город Ташкент» → «Юнусабадский район», ввели «Улица, дом» RU — «ул. Амира Темура, 12», UZ — «Amir Temur ko‘chasi, 12».
     - Поле «Адрес в документах» показывает «город Ташкент, Юнусабадский район, ул. Амира Темура, 12».
     - Блок «Полный адрес» в UZ — «Toshkent shahri, Yunusobod tumani, Amir Temur ko‘chasi, 12».
     - Сохранение: `country_code 'UZ'`, `region_code 'tashkent-city'`, `district_code 'yunusobod'`, `street_ru`/`street_uz` как введены, `address` — собранный, `address_manual 0`.
  2. Прежняя клиника: `address: 'Ташкент, ул. Мира 1'`, `address_manual: 1`, кодов нет. Сохранили, ничего не трогая → `address === 'Ташкент, ул. Мира 1'`, `address_manual === 1`, коды пусты, ошибок нет.
  3. Ручной режим: выбрали район и улицу, затем вписали в «Адрес в документах» «Ташкент, Юнусабад-4» → смена улицы адрес не меняет, `address_manual === 1`. «Собрать из списков» → адрес снова собранный, `address_manual === 0`.
  4. Начатый адрес: только улица RU → запроса нет, под «Город / область» — «Выберите город или область.». Регион без района → «Выберите район из списка.».
  5. Карта: `https://maps.google.com/x` → запроса нет, текст ошибки под полем. Ссылка `https://yandex.uz/maps/?ll=69.24%2C41.29&pt=69.24,41.29` → строка маршрута — `https://yandex.uz/maps/?rtext=~41.29,69.24&rtt=auto`, ссылка «Открыть маршрут» ведёт туда же; сохранение — `maps_url` как введена.
- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: `views/company-address.js`.** Две функции:
  - `addressCard(state, { onChange, secondary = false })` → `{ node, errs, availability }`;
  - `mapCard(state, { onChange })` → `{ node, err }`.

  Ядро:

```js
// CLINIC_PROFILE_V1 — «Компания»: адрес здания из справочника и адрес для документов.
import { h, Icon, clear, field } from '../ui.js';
import { tr } from '../i18n.js';
import { geoCascade } from './geo-cascade.js';
import { triGroup, fieldErr } from './company-fields.js';
import { composeAddress, printedAddress, routeUrl, STREET_MAX } from '../../shared/clinic-profile.js';

export function addressCard(state, { onChange = null, secondary = false } = {}) {
    let parts = { country: null, region: null, district: null };
    const streetOf = () => ({ ru: state.street_ru, uz: state.street_uz, en: state.street_en });
    const printInp = h('input', { type: 'text', autocomplete: 'off' });
    const manualNote = h('span', { class: 'co-hint' });
    const resetBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { state.address_manual = 0; recompose(); } },
        Icon('Refresh', { size: 14 }), ' ', 'Собрать из списков');
    const fullDl = h('dl', { class: 'co-kv' });
    const changed = () => { if (typeof onChange === 'function') onChange(); };

    function paintManual() {
        const manual = !!Number(state.address_manual);
        manualNote.textContent = manual ? tr('Вписан вручную') : '';
        resetBtn.hidden = !manual;
    }
    function paintFull() {
        clear(fullDl);
        for (const [lng, tag] of [['ru', 'RU'], ['uz', 'UZ'], ['en', 'EN']]) {
            fullDl.appendChild(h('dt', null, h('span', { class: 'co-lang' }, tag)));
            fullDl.appendChild(h('dd', null, document.createTextNode(composeAddress({ ...parts, street: streetOf() }, lng) || '—')));
        }
        fullDl.appendChild(h('dt', null, 'Коды'));
        fullDl.appendChild(h('dd', { class: 'co-mono' }, document.createTextNode(
            [state.country_code || '—', state.region_code || '—', state.district_code || '—'].join(' · '))));
    }
    function recompose() {
        const composed = composeAddress({ ...parts, street: streetOf() }, 'ru');
        state.address = printedAddress({ manual: !!Number(state.address_manual), typed: state.address, composed });
        printInp.value = state.address || '';
        paintFull(); paintManual(); changed();
    }
    const geo = geoCascade({ by: 'code', onChange: (sel) => {
        parts = sel;
        state.country_code = sel.country ? sel.country.code : '';
        state.region_code = sel.region ? sel.region.code : '';
        state.district_code = sel.district ? sel.district.code : '';
        recompose();
    } });
    geo.preset({ country: state.country_code || 'UZ', region: state.region_code, district: state.district_code });
    printInp.value = state.address || '';
    printInp.addEventListener('input', () => { state.address = printInp.value; state.address_manual = 1; paintManual(); paintFull(); changed(); });
    const street = triGroup('Улица, дом', streetOf(), { max: STREET_MAX, onInput: (l, v) => { state['street_' + l] = v; recompose(); } });
    const errs = { region_code: fieldErr(), district_code: fieldErr(), street_ru: street.inputs.ru.err };
    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('MapPin', { size: 16 }), ' ',
            secondary ? 'Адрес этого здания' : 'Адрес главного здания')),
        h('div', { class: 'card-pad', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
            h('p', { class: 'co-hint' }, 'Страна, город и район — из списков, как при регистрации пациента; партнёры получают их коды. Адреса других зданий — в «Филиалах».'),
            h('div', { class: 'co-geo' },
                field('Страна', geo.countrySel),
                h('div', null, field('Город / область', geo.regionSel), errs.region_code.node),
                h('div', null, field('Район', geo.districtSel), errs.district_code.node)),
            street.node,
            h('div', null, h('p', { class: 'co-hint' }, 'Полный адрес — так его получат партнёры'), fullDl),
            h('div', null, field('Адрес в документах', printInp),
                h('p', { class: 'co-hint' }, 'Так адрес печатается на бланках. Собирается из списков и улицы, пока вы не исправите его вручную.'),
                h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, manualNote, resetBtn))));
    paintFull(); paintManual();
    return {
        node, errs, geo,
        availability: () => ({ regionsAvailable: geo.regionSel.options.length > 1, districtsAvailable: geo.districtSel.options.length > 1 }),
    };
}
```

  `mapCard` — поле ссылки (`fieldErr`), строка маршрута, перерисовка на `input`. Подписи «Позвонить»/«Маршрут» здесь не нужны.
- [ ] **Step 4: `documents-settings.js`.**
  - Убрать поле «Адрес» из «Реквизитов».
  - Вставить `addressCard` и `mapCard` в левую колонку, под «Реквизитами».
  - `geoAvailability = () => address.availability()`.
  - `showProblems` раскладывает `region_code` / `district_code` / `street_ru` / `maps_url`.
  - Колонка страны «Страна» отправляется кодом (`UZ` по умолчанию); в проверку «начат ли адрес» страна не входит (Р3, задача 4).
- [ ] **Step 5: CSS:**

```css
/* CLINIC_PROFILE_V1 — «Компания»: списки адреса и пары «подпись — значение». */
.co-geo { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.co-kv { display: grid; grid-template-columns: minmax(0, 96px) minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 13.5px; }
.co-kv dt { color: var(--ink-500); }
.co-kv dd { margin: 0; color: var(--ink-900); overflow-wrap: anywhere; }
.co-mono { font-family: var(--font-mono); font-size: 12.5px; overflow-wrap: anywhere; }
```

- [ ] **Step 6: словарь:**
  - «Адрес главного здания», «Адрес этого здания», «Город / область», «Улица, дом»;
  - «Полный адрес — так его получат партнёры», «Коды», «Адрес в документах», «Вписан вручную», «Собрать из списков»;
  - «Карта и маршрут», «Ссылка на клинику в Яндекс Картах», «Кнопка «Маршрут»», «Открыть маршрут», «Появится, когда будет ссылка на карту.»;
  - обе подсказки.

  Образцы:
  - «Адрес в документах» — Hujjatlardagi manzil — Address on documents;
  - «Собрать из списков» — Ro‘yxatlardan yig‘ish — Build from the lists;
  - «Карта и маршрут» — Xarita va yo‘nalish — Map and route.
- [ ] **Step 7:** тесты зелёные. Сторожа: `geo-cascade`, `settings-split`, `clinic-brand`, `db-query-schema`, `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 8: коммит** «Компания: адрес главного здания из справочника (коды) и улица на трёх языках; адрес в документах собирается, пока не вписан вручную; карта и маршрут (CLINIC_PROFILE_V1)».

---

## Task 12: «Компания» — два логотипа (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/company-logos.js`
- Modify: `public/js/admin/views/documents-settings.js` (прежний логотип уходит: поле «Логотип», `resizeImageToDataUrl`, `onLogoPick`, `removeLogo`, `paintThumb`; новая карточка)
- Test: `public/js/admin/__tests__/company-profile.test.mjs`
- Modify: `public/css/admin-views.css`, `public/js/admin/i18n-strings.js`

**Карточка «Логотипы»** (`Icon('Image')`). Две плитки сеткой `repeat(auto-fit, minmax(220px, 1fr))`.

- **Квадратная плитка «Квадратный, 1:1»:**
  - подсказка: «Шапка программы, печатные документы, карточки у партнёров. PNG с прозрачным фоном, рекомендуем от 512×512 px.»;
  - поле на «клетке» (`.co-logo-box` — видно прозрачность): файл `logo_square_path`. Если файла нет, но есть `logo_data_url` — прежний логотип с пометкой «Прежний логотип — печатается, пока не загружен квадратный.». Иначе — «Нет файла».
- **Вертикальная плитка «Вертикальный»:**
  - подсказка: «Знак над названием — для страницы клиники у партнёров. PNG с прозрачным фоном, рекомендуем от 600×800 px.»
- **Кнопки:** «Загрузить» / «Заменить» (`Icon('Image')`, скрытый `<input type=file accept="image/png">`) и «Удалить» (`Icon('Trash')`).
- **Под плитками:** `Icon('Info')` + «Только PNG с прозрачным фоном — клетка под логотипом показывает, где фон прозрачный. Квадратный логотип идёт и в шапку программы, и в печатные документы.»

- [ ] **Step 1: падающие тесты** в `company-profile.test.mjs`.
  - Файл-подделка: `fileOf(buf, name = 'logo.png') → { name, type: 'image/png', size: buf.length, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }`.
  - Выбор файла — `input.files = [file]; input.dispatchEvent({ type: 'change', target: input })`.
  - Перед тестами — `logoDeps.printCopy = async () => 'data:image/png;base64,UFJJTlQ='; logoDeps.now = () => 1760000000000;`.

  Случаи:
  1. `docRow.logo_data_url = 'data:image/png;base64,T0xE'`, квадратного нет → в квадратной плитке картинка с этим `src` и пометка «Прежний логотип…».
  2. Квадратный `fakePng(512, 512)`:
     - ушла загрузка `POST /api/storage/clinic-logos/square/1760000000000-<6 знаков>.png`, тип `image/png`;
     - сохранение: `logo_square_path` — тот же путь, `logo_data_url === 'data:image/png;base64,UFJJTlQ='`.
  3. JPG / непрозрачный / `600×500` → загрузки нет, тост с переведённым отказом (`Логотип — только PNG…` и т. д.), `state` не изменился.
  4. Вертикальный `fakePng(600, 800)` → `logo_portrait_path` = `portrait/…png`, `logo_data_url` не меняется.
  5. «Удалить» у квадратного → сохранение: `logo_square_path === ''`, `logo_data_url === ''`. У вертикального — только `logo_portrait_path === ''`.
  6. `printCopy` вернул строку длиннее 90 000 знаков → загрузки нет, тост «Не удалось подготовить логотип для печати…».
- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: `views/company-logos.js`:**

```js
// CLINIC_PROFILE_V1 — «Компания»: два логотипа клиники.
// Файлы — в корзине clinic-logos (правила — shared/clinic-logo-rules.js, их же
// проверяет хранилище). У квадратного — печатная копия в doc_settings.logo_data_url
// (220 px PNG, прозрачность сохраняется): её печатают бланки, PDF Telegram и
// филиалы. Файл не удаляется: «Удалить» снимает логотип с бланков.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { LOGO_BUCKET, logoRefusal, PRINT_COPY_SIDE, PRINT_COPY_MAX_CHARS } from '../../shared/clinic-logo-rules.js';

export async function makePrintCopy(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, PRINT_COPY_SIDE / Math.max(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k));
    cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    try { if (bmp.close) bmp.close(); } catch (e) { /* уже закрыт */ }
    return cv.toDataURL('image/png');
}
// Точка подмены для тестов: в поддельном DOM нет canvas и createImageBitmap.
export const logoDeps = { printCopy: makePrintCopy, now: () => Date.now() };

export const logoSrc = (p) => (p ? supabase.storage.from(LOGO_BUCKET).getPublicUrl(p).data.publicUrl : '');

export async function pickLogo(kind, file, state) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bad = logoRefusal({ kind, name: file.name, bytes });
    if (bad) { toast(trf(bad.template, bad.params), 'fail'); return false; }
    let copy = null;
    if (kind === 'square') {
        try { copy = await logoDeps.printCopy(file); } catch (e) { copy = null; }
        if (!copy || copy.length > PRINT_COPY_MAX_CHARS) {
            toast(tr('Не удалось подготовить логотип для печати — сохраните PNG попроще или поменьше.'), 'fail');
            return false;
        }
    }
    const objPath = kind + '/' + logoDeps.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png';
    const { error } = await supabase.storage.from(LOGO_BUCKET).upload(objPath, file, { upsert: false });
    if (error) { toast(trf('Не удалось загрузить логотип: {msg}', { msg: error.message || '' }), 'fail'); return false; }
    state['logo_' + kind + '_path'] = objPath;
    if (copy) state.logo_data_url = copy;
    return true;
}

export function dropLogo(kind, state) {
    state['logo_' + kind + '_path'] = '';
    if (kind === 'square') state.logo_data_url = '';   // снимается с бланков; файл остаётся (Р7)
}
```

  `logosCard(state, { onChange, disabled })` — две плитки. После `pickLogo` / `dropLogo` плитки перерисовываются и вызывается `onChange()` (перерисовать предпросмотры). При `disabled` (филиал, задача 14) кнопки выключены:

```js
const HINT = {
    square: 'Шапка программы, печатные документы, карточки у партнёров. PNG с прозрачным фоном, рекомендуем от 512×512 px.',
    portrait: 'Знак над названием — для страницы клиники у партнёров. PNG с прозрачным фоном, рекомендуем от 600×800 px.',
};
export function logosCard(state, { onChange = null, disabled = false } = {}) {
    const grid = h('div', { class: 'co-logos' });
    const changed = () => { paint(); if (typeof onChange === 'function') onChange(); };
    function tile(kind) {
        const sq = kind === 'square';
        const path = state['logo_' + kind + '_path'];
        const legacy = sq && !path && state.logo_data_url ? state.logo_data_url : '';
        const src = path ? logoSrc(path) : legacy;
        const input = h('input', { type: 'file', accept: 'image/png', hidden: true });
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.value = '';   // тот же файл можно выбрать снова
            if (file && await pickLogo(kind, file, state)) changed();
        });
        const up = h('button', { class: 'btn btn-outline btn-sm', type: 'button', disabled, onclick: () => input.click() },
            Icon('Image', { size: 14 }), ' ', (path || legacy) ? 'Заменить' : 'Загрузить');
        const del = (path || legacy)
            ? h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled, onclick: () => { dropLogo(kind, state); changed(); } },
                Icon('Trash', { size: 14 }), ' ', 'Удалить')
            : null;
        return h('div', { class: 'co-logo' },
            h('b', null, sq ? 'Квадратный, 1:1' : 'Вертикальный'),
            h('div', { class: 'co-logo-box' }, src ? h('img', { src, alt: '' }) : h('span', { class: 'muted' }, 'Нет файла')),
            legacy ? h('span', { class: 'co-hint' }, 'Прежний логотип — печатается, пока не загружен квадратный.') : null,
            h('span', { class: 'co-hint' }, HINT[kind]),
            h('div', { class: 'row', style: { gap: '8px' } }, up, del, input));
    }
    function paint() { clear(grid); grid.appendChild(tile('square')); grid.appendChild(tile('portrait')); }
    paint();
    const node = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Image', { size: 16 }), ' ', 'Логотипы')),
        h('div', { class: 'card-pad', style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, grid,
            h('p', { class: 'co-hint' }, Icon('Info', { size: 14 }), ' ',
                'Только PNG с прозрачным фоном — клетка под логотипом показывает, где фон прозрачный. Квадратный логотип идёт и в шапку программы, и в печатные документы.')));
    return { node, paint };
}
```

  Подсказки `HINT` — литералы, которые `h()` переводит при выводе (`i18n-coverage` найдёт их как ключи словаря).
- [ ] **Step 4: `documents-settings.js`.**
  - Убрать прежний логотип: поле «Логотип» из «Реквизитов», `resizeImageToDataUrl`, `onLogoPick`, `removeLogo`, `paintThumb`, `refs.thumbWrap`.
  - Вставить `logosCard` под «Карта и маршрут».
  - Печатный предпросмотр («Как это выглядит») берёт `state.logo_data_url` — как раньше.
- [ ] **Step 5: CSS:**

```css
/* CLINIC_PROFILE_V1 — логотип на «клетке»: видно, где фон прозрачный. */
.co-logos { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.co-logo { display: grid; gap: 8px; align-content: start; min-width: 0; }
.co-logo-box { display: grid; place-items: center; aspect-ratio: 1 / 1; max-height: 180px; border: 1px solid var(--ink-200); border-radius: 10px;
  background-color: #fff;
  background-image: linear-gradient(45deg, #e9eef0 25%, transparent 25%), linear-gradient(-45deg, #e9eef0 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e9eef0 75%), linear-gradient(-45deg, transparent 75%, #e9eef0 75%);
  background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0; }
.co-logo-box img { max-width: 86%; max-height: 86%; object-fit: contain; }
```

- [ ] **Step 6: словарь:**
  - «Логотипы», «Квадратный, 1:1», «Вертикальный», «Нет файла»;
  - обе подсказки, пометка «Прежний логотип…», заметка про прозрачность;
  - «Не удалось подготовить логотип для печати — сохраните PNG попроще или поменьше.», «Не удалось загрузить логотип: {msg}».

  «Загрузить» / «Заменить» / «Удалить» в словаре уже есть.
- [ ] **Step 7:** тесты зелёные. Сторожа: `logo-storage.test.js`, `settings-split`, `clinic-brand`, `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 8: коммит** «Компания: два логотипа — квадратный (шапка и печать) и вертикальный (партнёры), PNG с прозрачностью; прежний печатается до замены (CLINIC_PROFILE_V1)».

---

## Task 13: «Компания» — «Как это увидят пациенты»: RU / UZ / EN, «Позвонить», «Маршрут» (CLINIC_PROFILE_V1)

**Files:**
- Create: `public/js/admin/views/company-preview.js`
- Modify: `public/js/admin/views/documents-settings.js` (правая колонка: две карточки предпросмотра)
- Test: `public/js/admin/__tests__/company-profile.test.mjs`
- Modify: `public/js/admin/i18n-strings.js`, `public/css/admin-views.css`

**Правая колонка:**
- **«Как это выглядит в документах»** — прежний печатный предпросмотр (`renderPreview`), заголовок уточнён. Логотип и название рядом — как на бланке после задачи 2.
- **«Как это увидят пациенты»** (`Icon('Image')`) — переключатель RU / UZ / EN (`.segmented`, кнопки с `aria-pressed`). Ниже:
  - квадратный логотип (файл, иначе печатная копия) и название на выбранном языке (иначе RU);
  - полный адрес на этом языке (`composeAddress`);
  - описание на этом языке или пометка «Нет описания на этом языке — партнёры покажут русское.»;
  - кнопки-ссылки:
    - «Позвонить» — `href = telHref(phone)`;
    - «Маршрут» — `routeUrl(maps_url)`, `target=_blank rel=noopener`;
    - Telegram-бот — `https://t.me/<имя без @>`;
    - Instagram — `https://instagram.com/<имя без @>`;
    - «Сайт».

  Ссылки без данных не рисуются. Подписи кнопок — **на языке предпросмотра**, не интерфейса: «Позвонить / Маршрут / Сайт», «Qo‘ng‘iroq qilish / Yo‘nalish / Sayt», «Call / Route / Website». Это текстовые узлы `document.createTextNode`, без `tr()` (`h()` перевёл бы их на язык интерфейса).
  - Под карточкой подсказка: «Так данные клиники выглядят на сайте клиники, в Symptex и у партнёров. Каждый показывает их в своём стиле, данные одинаковые.»

- [ ] **Step 1: падающие тесты:**
  1. Переключили на UZ → название `Shifo`, адрес «Toshkent shahri, Yunusobod tumani, …», кнопка с текстом `Qo‘ng‘iroq qilish` и `href` `tel:+998712001200`.
  2. EN без `name_en` → RU-название; без `about_en` → пометка.
  3. Без карты кнопки «Маршрут» нет; с картой — `href` равен `routeUrl(...)`.
  4. Правая колонка не задаёт ширину больше 380 px. Обе колонки — элементы `.col` с `minWidth: '320px'` и `flexWrap: 'wrap'` у родителя (как сейчас), то есть на ширине телефона складываются в одну.
- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: `views/company-preview.js`** — функция `patientPreview(state, { lang, parts, logo })` → узел. Переключатель живёт в `documents-settings.js` (`state.__previewLang`, перерисовка обеих карточек на `onChange`). Слова кнопок:

```js
// Подписи — на языке ПРЕДПРОСМОТРА (так их увидит пациент), не интерфейса.
const WORDS = {
    ru: { call: 'Позвонить', route: 'Маршрут', site: 'Сайт' },
    uz: { call: 'Qo‘ng‘iroq qilish', route: 'Yo‘nalish', site: 'Sayt' },
    en: { call: 'Call', route: 'Route', site: 'Website' },
};
```

  Литералы «Позвонить» / «Маршрут» / «Сайт» нужны и словарю (`i18n-coverage` требует статью для каждого кириллического литерала). «Позвонить» и «Сайт» уже есть, «Маршрут» — добавить: Yo‘nalish / Route.
- [ ] **Step 4: CSS** — кнопки предпросмотра — `.btn .btn-outline .btn-sm` (готовые классы), обёртка:
  `.co-pbtns { display: flex; flex-wrap: wrap; gap: 8px; }` и `.co-preview-head { display: flex; align-items: center; gap: 12px; min-width: 0; }`.
- [ ] **Step 5: словарь:** «Как это увидят пациенты», «Как это выглядит в документах», «Нет описания на этом языке — партнёры покажут русское.», подсказка под карточкой, «Маршрут», «Язык».
- [ ] **Step 6:** тесты зелёные. Сторожа: `i18n-coverage`, `i18n-uz-quality`, `type-scale`.
- [ ] **Step 7: коммит** «Компания: предпросмотр «Как это увидят пациенты» на трёх языках — «Позвонить», «Маршрут», Telegram, Instagram, сайт (CLINIC_PROFILE_V1)».

---

## Task 14: Филиал — общее для клиники приходит из главного здания и здесь не правится (CLINIC_PROFILE_V1)

**Files:**
- Modify: `server/services/branch-sync/catalogue.js` (:26-52 `DOC_SETTINGS_COLUMNS` и комментарий)
- Modify: `server/routes/db.js` (рядом с :321-343, за стражем `MAIN_CLINIC_TABLES`; `isSecondary` :613)
- Modify: `server/services/rpc/clinic.js` (`building_role`)
- Modify: `public/js/admin/views/documents-settings.js` (+ карточки: режим просмотра)
- Test: `server/services/branch-sync/catalogue.test.js` (:86-89, :313-317), Create: `server/routes/company-secondary.test.js`, `company-profile.test.mjs`, `server/services/rpc/clinic.test.js`
- Modify: `public/js/admin/i18n-strings.js`

- [ ] **Step 1: падающие тесты.**
  - **`catalogue.test.js`:**
    - выгрузка содержит `name_uz`, `name_en`, `about_ru`, `about_uz`, `about_en`, `website`, `telegram_bot`, `telegram_channel`, `instagram`;
    - в «запрещённый» список :89 дописать `country_code`, `region_code`, `district_code`, `street_ru`, `street_uz`, `street_en`, `maps_url`, `address_manual`, `logo_square_path`, `logo_portrait_path`;
    - приём в филиал с базой до 240 (`ALTER TABLE doc_settings DROP COLUMN name_uz` — по образцу :313) не падает, остальное принято;
    - каждая колонка `DOC_SETTINGS_COLUMNS` из профиля входит в `COMPANY_CLINIC_WIDE`, и ни одна из `COMPANY_BUILDING` не едет.
  - **`company-secondary.test.js`** (стенд — `server/routes/staff-sync-readonly.test.js:23-40`, `startServer({ secondary: true })`). Админ филиала, `POST /api/db` `doc_settings` update:
    - `{ clinic_name: 'Другое' }` → 409, сообщение `COMPANY_MAIN_ONLY`;
    - `{ address: 'ул. Филиальная, 7', phone: '+998901112233', street_ru: 'ул. Филиальная, 7' }` → 200;
    - `{ clinic_name: <текущее>, address: 'X' }` → 200 (общее не меняется — старый экран сохраняет своё);
    - `{ logo_square_path: 'square/1-a.png' }` → 409.

    Главное здание: `{ clinic_name: 'Другое' }` → 200.
  - **`clinic.test.js`:** `building_role` — `'main'` по умолчанию, `'secondary'` после `becomeSecondary`.
  - **`company-profile.test.mjs`:** `window.CLINIC.building_role = 'secondary'`:
    - поля «Название клиники» (все три), «Коротко о клинике», «Номер лицензии», «Фирменный цвет», «Сайт и соцсети» выключены (`disabled`);
    - кнопки логотипов выключены;
    - вверху заметка «Название, описание, логотипы…»;
    - заголовок адреса — «Адрес этого здания»;
    - сохранение шлёт ровно `COMPANY_BUILDING`.
- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: правка.**

  `catalogue.js`:

```js
export const DOC_SETTINGS_COLUMNS = [
  'clinic_name', 'license', 'logo_data_url', 'accent_color',
  'paper_size', 'show_watermark', 'footer_note', 'legal_note',
  'lab_scope',
  // CLINIC_PROFILE_V1 (мигр. 240) — профиль КЛИНИКИ: названия и описание на
  // трёх языках, сайт, Telegram, Instagram. Адрес здания (коды, улица, адрес
  // для документов, карта) — свой у каждого здания, как address/phone/email
  // выше. Пути к файлам логотипов не едут: файлов в филиале нет, а печатает
  // он копию квадратного (logo_data_url, строкой выше).
  'name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en',
  'website', 'telegram_bot', 'telegram_channel', 'instagram',
];
```

  `routes/db.js` — импорт `import { COMPANY_CLINIC_WIDE } from '../../public/js/shared/clinic-profile.js';   // CLINIC_PROFILE_V1`. Сразу за стражем `MAIN_CLINIC_TABLES`:

```js
    // CLINIC_PROFILE_V1 — «КОМПАНИЯ» В ФИЛИАЛЕ: общее для клиники (название,
    // описание, логотипы, сайт и соцсети, лицензия, цвет) приходит из главного
    // здания (branch-sync/catalogue.js), и правка здесь откатилась бы ближайшей
    // синхронизацией — тот же призрак, что закрывает 409 выше. Отказ — только
    // если общее поле МЕНЯЕТСЯ: экран, приславший название как было, сохраняет
    // адрес и телефон своего здания.
    const companyRefusal = companyBranchRefusal(db, compiled.meta, req.body);
    if (companyRefusal) return res.status(409).json({ error: { code: 'conflict', message: companyRefusal } });
```

  Рядом с `isSecondary`:

```js
const COMPANY_MAIN_ONLY = 'Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании. Здесь — адрес, телефон, почта и карта этого здания.';
function companyBranchRefusal(db, meta, body) {   // CLINIC_PROFILE_V1
  if (!meta || meta.table !== 'doc_settings' || meta.op !== 'update') return null;
  if (!isSecondary(db)) return null;
  const values = body && body.values && !Array.isArray(body.values) ? body.values : {};
  const cur = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};
  const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
  const changes = COMPANY_CLINIC_WIDE.some((c) => Object.prototype.hasOwnProperty.call(values, c) && !same(values[c], cur[c]));
  return changes ? COMPANY_MAIN_ONLY : null;
}
```

  `rpc/clinic.js`:

```js
import { readIdentity } from '../branch-sync/identity.js';   // CLINIC_PROFILE_V1
// … в объекте:
    // CLINIC_PROFILE_V1 — «Компания» в филиале показывает общее только для просмотра.
    building_role: (() => { try { return readIdentity(db).role; } catch { return 'main'; } })(),
```

  Экран:
  - `const secondary = !!(window.CLINIC && window.CLINIC.building_role === 'secondary');`;
  - в филиале — заметка `role="note"` с `Icon('Building')` наверху (вид — как `docprof-managed` в `doctor-profile.js:171-182`);
  - поля `COMPANY_CLINIC_WIDE` получают `disabled`; `logosCard(..., { disabled: true })`;
  - `addressCard(..., { secondary: true })` даёт заголовок «Адрес этого здания»;
  - в `save()` набор колонок — `secondary ? COMPANY_BUILDING : COMPANY_COLUMNS`.
- [ ] **Step 4: словарь:**

| ru | uz | en |
|---|---|---|
| Название, описание, логотипы, сайт и соцсети, лицензия и фирменный цвет меняются в главном здании. Здесь — адрес, телефон, почта и карта этого здания. | Nomi, tavsifi, logotiplar, sayt va ijtimoiy tarmoqlar, litsenziya va firma rangi bosh binoda o‘zgartiriladi. Bu yerda — shu binoning manzili, telefoni, pochtasi va xaritasi. | The name, description, logos, website and social media, licence and brand colour are changed in the main building. Here — this building’s address, phone, email and map. |

  Тот же текст — заметка экрана (одна статья).
- [ ] **Step 5:** тесты зелёные. Сторожа:
  - `server/services/branch-sync/sync-e2e.test.js`, `relay.test.js`, `relay-e2e.test.js`, `relay-crypto.test.js`;
  - `server/routes/staff-sync-readonly.test.js`, `branch-sync.test.js`;
  - `server/i18n-server-messages.test.js`, `logo-storage.test.js`.
- [ ] **Step 6: коммит** «Филиал: названия, описание, ссылки и логотипы клиники приходят из главного здания и здесь только видны; адрес, телефон и карта — свои у здания (CLINIC_PROFILE_V1)».

---

## Task 15: Шапка программы — квадратный логотип и название на языке интерфейса (CLINIC_PROFILE_V1)

**Files:**
- Modify: `server/services/rpc/clinic.js` (`logo_mark_url`)
- Modify: `public/js/admin/clinic-context.js` (`paintClinicBrand`, ~:118-126)
- Modify: `public/js/admin.js` (рядом с :2766 — подписка на смену языка)
- Modify: `public/css/admin.css` (за :444 `.brand-mark svg`)
- Test: `server/services/rpc/clinic.test.js`, `public/js/admin/__tests__/clinic-context.test.mjs`, `clinic-brand.test.mjs`

**Сейчас:**
- Знак меню `#sidebar-logo` (`public/admin.html:45-49`) — статичный «+», он же сворачивает меню (`admin.js:2971-2975`).
- Под меню `.brand-sub` — `clinic.name` (RU) на любом языке интерфейса.

- [ ] **Step 1: падающие тесты.**
  - **`clinic.test.js`:** `logo_mark_url`:
    - печатная копия квадратная (`pngDataUrl(fakePng(220, 220))`) → равен ей;
    - широкая (`fakePng(220, 80)`) → `null`;
    - JPEG data URL → `null`;
    - пусто → `null`.
  - **`clinic-context.test.mjs`** — свой мини-DOM: `document.querySelector('.brand-sub')`, `document.getElementById('sidebar-logo')`, `document.documentElement.lang`, `createElement`.
    1. `lang = 'uz'`, `CLINIC = { name: 'Шифо', name_uz: 'Shifo' }` → `.brand-sub` = `Shifo`.
    2. `lang = 'en'` без `name_en` → `Шифо`.
    3. `logo_mark_url` задан → у `#sidebar-logo` класс `has-logo` и дочерний `img.brand-logo` с этим `src`.
    4. Затем без `logo_mark_url` → картинки нет, класса нет.
- [ ] **Step 2:** запуск → падают.
- [ ] **Step 3: правка.**

  `rpc/clinic.js`:

```js
import { isSquarePngDataUrl } from '../../../public/js/shared/clinic-logo-rules.js';   // CLINIC_PROFILE_V1
// … в объекте:
    // CLINIC_PROFILE_V1 — знак в шапке программы: печатная копия логотипа, если
    // она КВАДРАТНАЯ (квадратный логотип или прежний квадратный). Широкий
    // прежний логотип в знак 30×30 не помещается — тогда знак остаётся «+».
    logo_mark_url: isSquarePngDataUrl(settings.logo_data_url) ? settings.logo_data_url : null,
```

  `clinic-context.js`:

```js
// CLINIC_PROFILE_V1 — название под меню — на языке интерфейса, если клиника его
// вписала («Компания», UZ / EN); иначе прежнее (то, что печатается).
export function clinicNameFor(clinic, lang) {
    if (!clinic) return '';
    return (lang === 'uz' && clinic.name_uz) || (lang === 'en' && clinic.name_en) || clinic.name || '';
}
function uiLang() {
    return (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'ru';
}
// CLINIC_PROFILE_V1 — квадратный логотип клиники в знаке меню. Элемент тот же
// (#sidebar-logo сворачивает меню), «+» прячет CSS (.has-logo svg).
function paintBrandMark(clinic) {
    const mark = typeof document.getElementById === 'function' ? document.getElementById('sidebar-logo') : null;
    if (!mark) return;
    const src = clinic && clinic.logo_mark_url;
    let img = typeof mark.querySelector === 'function' ? mark.querySelector('img.brand-logo') : null;
    if (!src) {
        if (img) img.remove();
        mark.classList.remove('has-logo');
        return;
    }
    if (!img) {
        img = document.createElement('img');
        img.className = 'brand-logo';
        img.setAttribute('alt', '');
        mark.appendChild(img);
    }
    img.setAttribute('src', src);
    mark.classList.add('has-logo');
}
```

  В `paintClinicBrand()`: `sub.textContent = clinicNameFor(clinic, uiLang())` вместо `clinic.name`; в конце — `paintBrandMark(window.CLINIC)`.

  `admin.js` — за вызовом `paintClinicBrand()` в `boot()` (~:2766):
  `onLangChange(() => paintClinicBrand());   // CLINIC_PROFILE_V1 — название под меню на новом языке`. Импорт `onLangChange` уже есть (:32).

  `admin.css`:

```css
/* CLINIC_PROFILE_V1 — квадратный логотип клиники в знаке меню (тот же элемент сворачивает меню). */
.brand-mark.has-logo { background: var(--white); border: 1px solid var(--ink-100); overflow: hidden; }
.brand-mark.has-logo:hover { background: var(--white); }
.brand-mark.has-logo svg { display: none; }
.brand-mark.has-logo img { width: 100%; height: 100%; object-fit: contain; display: block; }
```

- [ ] **Step 4:** тесты зелёные. Сторожа:
  - `clinic-brand.test.mjs` (имя под меню после входа и после «Компании»);
  - `app-shell.test.mjs`, `type-scale.test.mjs`.
- [ ] **Step 5: коммит** «Шапка программы: квадратный логотип клиники в знаке меню; название под меню — на языке интерфейса (CLINIC_PROFILE_V1)».

---

## Task 16: Telegram — узбекское название в приветствии и описании бота; описание следует за переименованием (CLINIC_PROFILE_V1)

**Files:**
- Modify: `server/services/telegram/setup.js` (:40-66 `descriptions`, `clinicName`, `setupBot`)
- Modify: `server/services/telegram/flow.js` (:107-131 `clinicName`, `greeting`)
- Modify: `server/services/telegram/index.js` (`loop`, блок `PUSH_INTERVAL_MS` ~:105-110)
- Test: `server/services/telegram/greeting.test.js`

**Сейчас:**
- Приветствие и описание бота двуязычные (uz сверху, ru ниже), но обе строки берут `doc_settings.clinic_name`.
- Описание бота ставится только при вводе токена (`rpc/telegram.js:98`). После переименования клиники в «Компании» пациент видит в Telegram старое название, пока администратор не введёт токен заново.

- [ ] **Step 1: падающие тесты** в `greeting.test.js`. Стенд — `seed()` и `harness()` из файла.
  1. `UPDATE doc_settings SET name_uz = 'Novo Medika'` → в `greeting(db)` узбекская строка содержит «Novo Medika», русская — «Novo Medics». Без `name_uz` — обе «Novo Medics», как было.
  2. `setupBot(db, 'T', h.deps)` → `setMyDescription` с текстом, где узбекская часть — «Novo Medika», русская — «Novo Medics».
  3. `syncBotDescription(db, 'T', h.deps)`:
     - первый вызов шлёт `setMyDescription` и `setMyShortDescription`;
     - второй с теми же названиями не шлёт ничего;
     - после `UPDATE doc_settings SET clinic_name = 'Другая'` шлёт снова.
     - Сбой Telegram (`fetchImpl` → `{ ok: false, status: 500 }`) — отпечаток не записан, следующий вызов повторяет.
- [ ] **Step 2:** `node --test server/services/telegram/greeting.test.js` → падает.
- [ ] **Step 3: правка** `setup.js`:

```js
// CLINIC_PROFILE_V1 — названия для бота: RU — то, что печатается (clinic_name);
// UZ — узбекское из «Компании», иначе то же RU. SELECT * — база до мигр. 240
// колонки name_uz не знает, и бот не должен терять название из-за этого.
export function clinicNames(db) {
  try {
    const r = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get() || {};
    const ru = r.clinic_name || '';
    return { ru, uz: r.name_uz || ru };
  } catch { return { ru: '', uz: '' }; }
}

function descriptions({ ru, uz }) {
  const nameRu = ru || 'klinika';
  const nameUz = uz || ru || 'klinika';
  return {
    long: [
      'Bu — «' + nameUz + '» klinikasining rasmiy boti.',
      'Tahlil natijalari, shifokor xulosalari va hisob-fakturalarni shu yerdan olasiz.',
      'Boshlash uchun telefon raqamingizni yuboring.',
      '',
      'Это официальный бот клиники «' + nameRu + '».',
      'Результаты анализов, заключения врачей и счета — здесь.',
      'Чтобы начать, отправьте свой номер телефона.',
    ].join('\n'),
    short: 'Hujjatlaringiz · Ваши документы — ' + nameRu,
  };
}

const DESCRIBED_KEY = 'bot_description';   // telegram_state: отпечаток описания, которое Telegram уже принял
const fingerprint = (d) => d.long.slice(0, 512) + '\n--\n' + d.short.slice(0, 120);
function readDescribed(db) { try { const r = db.prepare('SELECT value FROM telegram_state WHERE key = ?').get(DESCRIBED_KEY); return r ? r.value : ''; } catch { return ''; } }
function writeDescribed(db, v) {
  db.prepare(`INSERT INTO telegram_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(DESCRIBED_KEY, v);
}

// CLINIC_PROFILE_V1 — описание бота следует за названием клиники. Цикл бота
// зовёт это на каждом проходе рассылки (index.js): то же описание — ни одного
// запроса; другое — два запроса и новый отпечаток. Сбой — отпечаток прежний,
// следующий проход повторит.
export async function syncBotDescription(db, token, deps = {}) {
  const d = descriptions(clinicNames(db));
  const fp = fingerprint(d);
  if (readDescribed(db) === fp) return { changed: false };
  await setMyDescription(token, d.long.slice(0, 512), '', deps);
  await setMyShortDescription(token, d.short.slice(0, 120), '', deps);
  writeDescribed(db, fp);
  return { changed: true };
}
```

  В `setupBot`:
  - `descriptions(clinicNames(db))` вместо `descriptions(clinicName(db))`;
  - после успешных шагов `description` и `short_description` — `writeDescribed(db, fingerprint(d))`;
  - прежнюю `clinicName` удалить.

  `flow.js`:
  - `import { clinicNames } from './setup.js';   // CLINIC_PROFILE_V1`;
  - в `greeting(db)` — `const { ru, uz } = clinicNames(db);`: узбекская строка с `uz`, русская с `ru`, пустые — как было;
  - прежнюю `clinicName` удалить. Проверить, что `setup.js` не импортирует `flow.js` (цикла импорта нет).

  `index.js`:
  - импорт — `import { syncBotDescription } from './setup.js';   // CLINIC_PROFILE_V1`;
  - в блоке `if (Date.now() - lastPush > PUSH_INTERVAL_MS)` после `runPushScan`:

```js
      // CLINIC_PROFILE_V1 — переименовали клинику в «Компании» — описание бота следом.
      try { await syncBotDescription(db, cfg.token); }
      catch (e) { console.warn('[telegram] description:', (e && e.message) || e); }
```

- [ ] **Step 4:** тесты зелёные. Сторожа: `server/services/telegram/flow.test.js`, `flow-relink.test.js`, `no-real-tokens.test.js`, `render-branding.test.js`, `server/routes/rpc-telegram.test.js`.
- [ ] **Step 5: коммит** «Telegram: узбекское название клиники в приветствии и описании бота; описание обновляется само после переименования (CLINIC_PROFILE_V1)».

---

## Завершение (контролёр)

**1. Полный набор тестов — дважды, после всех задач и когда другие сборщики не пишут:**
- как в выпуске: `node --experimental-vm-modules --test` (= `npm test`), из корня дерева;
- как CI на en-US:
  `node --experimental-vm-modules --import <скретчпад>/force-en.mjs --test`,
  где `force-en.mjs`:
  `Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', languages: ['en-US', 'en'], userAgent: 'Node.js' } });`
  (память `easymed-ci-locale-trap`).
- Красное в чужой области — сначала проверить, не чужая ли это недописанная миграция или ханк.

**2. Проверка «сломать».** Отдельный агент, только чтение; находки — в `docs/reviews/` или в отчёт. Что пробовать:
- (a) **Филиал:**
  - сменить название / сайт / логотип через `/api/db` частичными и полными телами — в том числе старым экраном, который шлёт неизменённое название;
  - убедиться, что адрес и телефон филиала сохраняются, а синхронизация не затирает их.
- (b) **Хранилище:**
  - SVG или JPEG под именем `.png`;
  - PNG с поддельным IHDR (огромные размеры, ширина 0);
  - палитра без tRNS;
  - `..` и `%2F` в пути;
  - `legacy/` через HTTP;
  - DELETE;
  - повторная загрузка на тот же путь;
  - запись ролью без «Компании».
- (c) **Прежний логотип:**
  - не теряется после загрузки квадратного и после «Удалить»;
  - повторный запуск не плодит файлы;
  - восстановленная копия с другим логотипом получает свой файл.
- (d) **Адрес для документов:**
  - не стирается ни при каком сочетании выбора;
  - ручной не перезаписывается;
  - прежние клиники после обновления печатают то же.
- (e) **Печать:**
  - название рядом с логотипом на каждом типе бланка (A4, A5, чек 58 мм, накладные);
  - широкий прежний логотип не выталкивает реквизиты за край;
  - PDF Telegram с логотипом.
- (f) **Языки:**
  - экран на uz/en без кириллицы (кроме данных клиники);
  - предпросмотр показывает подписи кнопок на языке предпросмотра.
- (g) **Ширина телефона:** 360 px — нет горизонтальной прокрутки, три поля языков и три списка адреса — в столбец.
- (h) **Права:** роль с «Компания: Изменение» без администратора сохраняет всё, включая логотипы; роль с «Просмотр» — ничего.

**3. Проба на тестовой клинике** (:8712, рецепт — память `easymed-dev-prod-workflow`; без тега):
- открыть «Компанию»;
- заполнить три языка, адрес списками, сайт / Telegram / Instagram, карту;
- загрузить оба логотипа;
- распечатать чек, счёт, заключение, выписку стационара — название рядом с логотипом;
- отправить документ в Telegram;
- проверить знак меню и название под меню на uz;
- прежний логотип клиники до замены — печатается.

**4. Пуш и тег.** `git push` ветки (владелец: «после изменений — пушить»). Тег — только по слову владельца. Заметки к выпуску (`RELEASE_NOTES.md` + `release-notes.test.mjs`) — при подготовке выпуска, не в этом плане.

---

## Вопросы владельцу

1. **Адрес на бланках — собирать из списков или вписывать руками?** В «Компании» адрес главного здания выбирается списками (Страна → Город / область → Район) и улицей. На бланках печатается отдельная строка «Адрес в документах». Варианты:
   - **A (в плане, рекомендую):** строка собирается из выбранного сама — «город Ташкент, Юнусабадский район, ул. Амира Темура, 12» — пока клиника не исправит её руками. Кнопка «Собрать из списков» возвращает сборку. У клиник, которые уже вписали адрес, после обновления на бланках ничего не меняется («Ташкент, ул. Амира Темура, 12» остаётся, пока не нажмут кнопку).
   - **B:** строка на бланке всегда вписывается руками, списки — только для партнёров. Адрес приходится вводить дважды.
   - **C:** строка всегда собирается, исправить руками нельзя. У прежних клиник бланк сменится сам, как только выберут район.
2. **Сайт клиники на бланках.** Заполненный в «Компании» сайт печатается там, где бланк печатает сайт (шапка, счета), без `https://`, например «shifo.uz». Так в плане. Если на медицинских документах сайт не нужен — скажите: оставим его только для партнёров. Дизайнер «Документов» по-прежнему может задать свой текст переключателем «Данные клиники из раздела «Компания»».
