# CRM: несколько источников — в фильтре доски и у самой заявки — план реализации (CRM_MULTI_SOURCE_V1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** у заявки CRM может быть несколько источников («Instagram и по совету знакомых»). Фильтр доски отмечает несколько источников сразу. Отчёты считают заявку в каждом её источнике, а итоги — по заявкам.

**Architecture:**
- **База:** миграция 231 добавляет `crm_requests.sources` (TEXT, JSON-массив ключей в порядке выбора) и бэкфилл `json_array(source)`. `source` остаётся «главным» = `sources[0]`.
- **Правило чтения одно:** `sources`, если это непустой массив, иначе `[source]`, иначе `['other']`.
  - на JS — `leadSources()` в `public/js/admin/crm-sources.js`: им читают экран и сервер (проверка записи, слияние, выгрузка);
  - на SQL — `leadSourcesSql()` в `server/services/crm/sources.js`: для `json_each` в отчёте колл-центра;
  - одна таблица примеров проверяет обе.
- **Запись:** `routes/db.js` вызывает `crmSourcesWrite()` после `crmAssignRefusal`:
  - проверяет `sources`;
  - ставит `source = sources[0]`;
  - запись одного `source` делает его главным; у правки остальные источники заявки остаются за ним (ревью M2, см. ниже);
  - тело правится на месте и перекомпилируется тем же `compile()`.
- **Экран** (`views/crm.js`):
  - фильтр — массив `state.sources`;
  - чипы считают заявку в каждом источнике;
  - карточка окна — множественный выбор в порядке нажатий, последний не снимается;
  - теги, таблица, Excel — все источники;
  - «Отчёт» — по источникам плюс строка «Всего» по заявкам.
- **Соседи:**
  - `lead-from-call.js` и `booking-mirror.js` пишут только `source`, правило чтения их понимает;
  - `crm-merge.js` даёт оставленной заявке объединение источников, главный — её собственный;
  - `config.js`: источник, стоящий у заявки хотя бы вторым, не удаляется, как и главный.

**Tech Stack:** Node 24 ESM, better-sqlite3 (JSON1), `node:test`, ванильный JS, поддельный DOM (`crm-harness.mjs`).

**Спецификация:** `docs/specs/2026-09-29-crm-multi-source-design.md` (коммит `4231006`).

---

## Правила общего рабочего дерева (читать до первого шага)

- В этом дереве и на этой ветке (`feat/stock-own-shelf-suppliers-vat`) может коммитить агент ROLES_SAVE_TRUTH_V1. Ветку не переключать, worktree не создавать, не пушить, тег не ставить.
- Запрещено: `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`.
- Перед каждым коммитом:
  1. `git log --oneline -3`, `git status --short`;
  2. `git diff --cached --name-only` пуст — иначе ждать;
  3. индексировать только свои файлы, по именам.
- **Общие файлы:** `public/js/admin/i18n-strings.js`, `public/js/admin.js`, `server/db/schema-registry.js`, `server/routes/db.js`.
  - Каждая своя вставка несёт метку `CRM_MULTI_SOURCE_V1` в добавленной строке.
  - Если `git diff -- F` показывает только свои ханки — обычный `git add -- F`. Иначе:

```bash
SP="C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad"
git diff -U0 -- "$F" | node "$SP/keep-hunks-v2.mjs" CRM_MULTI_SOURCE_V1 > "$SP/own.patch"
git apply --cached --check --unidiff-zero "$SP/own.patch" && git apply --cached --unidiff-zero "$SP/own.patch"
git diff --cached -- "$F"     # свой блок, у своего якоря
git diff -U0 -- "$F"          # остались только чужие ханки
```

- **Номер миграции — 231.** Свободен в дереве и в `origin/main`; выше 219 (последний выпуск).
- Файлы — LF. Сообщения коммитов — файлом (`git commit -F`), по-русски, с `(CRM_MULTI_SOURCE_V1)` и строкой `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Тесты — только явными путями: `node --experimental-vm-modules --test <файл>`. Полный прогон делает контролёр.
- **Штамп кэша:** `admin.js` импортирует `views/crm.js?v=rst1` → `?v=msrc1`.

---

## Карта файлов

| Файл | Что | Задача |
|---|---|---|
| `public/js/admin/crm-sources.js` (новый) | `leadSources`, `toggleLeadSource`, `leadHasAnySource`, `sourceTally`, `MAX_LEAD_SOURCES` | 1 |
| `public/js/admin/crm-sources.test.mjs` (новый) | чистые правила экрана | 1 |
| `server/services/crm/sources.js` (новый) | `leadSourcesSql`, `sourceEachSql`, `crmSourcesWrite`, `unionLeadSources`, `CrmSourcesError` | 1, 3 |
| `server/services/crm/sources.test.js` (новый) | одна таблица примеров: JS и SQL | 1 |
| `server/db/migrations/231_crm_request_sources.sql` (новый) | колонка + бэкфилл | 2 |
| `server/db/migrations/231.test.js` (новый) | бэкфилл, повторный накат, пустой `source` | 2 |
| `server/db/schema-registry.js` (общий) | `sources` в чтении/записи, `json: ['sources']` | 2 |
| `server/routes/db.js` (общий) | проверка и штамп `source = sources[0]` | 3 |
| `server/routes/crm-multi-source.test.js` (новый) | реестр через HTTP | 3 |
| `server/services/rpc/callcenter.js` | по источникам / конверсия через `json_each`, выгрузка | 4 |
| `server/services/rpc/callcenter-multi-source.test.js` (новый) | отчёт | 4 |
| `server/services/rpc/crm-merge.js` | объединение источников | 5 |
| `server/services/crm/config.js` | удаление источника: считается и `sources` | 5 |
| `server/services/crm/multi-source-neighbours.test.js` (новый) | звонок, зеркало, слияние, справочник | 5 |
| `public/js/admin/views/crm.js` | фильтр, чипы, теги, таблица, Excel, окно, «Отчёт» | 6 |
| `public/js/admin/__tests__/crm-multi-source.test.mjs` (новый) | экран | 6 |
| `public/js/admin/i18n-strings.js` (общий) | новые фразы ru/uz/en | 3, 6 |
| `public/js/admin.js` (общий) | штамп `msrc1` | 6 |

---

### Задача 1: правило чтения — JS и SQL, одна таблица примеров

**Файлы:** `public/js/admin/crm-sources.js`, `public/js/admin/crm-sources.test.mjs`, `server/services/crm/sources.js` (часть SQL), `server/services/crm/sources.test.js`.

- [ ] **1.1** Тест `server/services/crm/sources.test.js`: таблица `EXAMPLES` → `{ source, sources, want }`. Строки:
  - `['a','b']` → `['a','b']`;
  - JSON-строка `'["a","b"]'` → `['a','b']`;
  - `[]` → `[source]`;
  - `NULL` → `[source]`;
  - битый JSON → `[source]`;
  - `{}` (не массив) → `[source]`;
  - `['', 5]` → `[source]`;
  - `['a','a','b']` → `['a','b']`;
  - пустой `source` и нет `sources` → `['other']`.

  Для каждой: `leadSources(row)` === `want`. Та же строка, вставленная в `crm_requests` (FK выключены на время вставки) и прочитанная через `SELECT DISTINCT je.value FROM crm_requests r, json_each(leadSourcesSql('r')) je WHERE … ORDER BY je.key`, даёт тот же список.
- [ ] **1.2** Тест `public/js/admin/crm-sources.test.mjs`:
  - `toggleLeadSource`: добавляет в конец; снимает; последний не снимает (`refused: 'last'`); больше 10 не добавляет (`'max'`);
  - `leadHasAnySource`: пустой фильтр — да, пересечение — да;
  - `sourceTally`: заявка с двумя источниками — в обоих; `won` по предикату.
- [ ] **1.3** Прогнать оба — падают (нет модулей).
- [ ] **1.4** Написать `crm-sources.js` и SQL-часть `sources.js`.
- [ ] **1.5** Прогнать:

```bash
node --experimental-vm-modules --test server/services/crm/sources.test.js public/js/admin/crm-sources.test.mjs
```

- [ ] **1.6** Коммит: «CRM, источники: одно правило чтения (sources → [source] → ['other']) на JS и на SQL, одна таблица примеров (CRM_MULTI_SOURCE_V1)».

### Задача 2: миграция 231 и реестр

**Файлы:** `server/db/migrations/231_crm_request_sources.sql`, `server/db/migrations/231.test.js`, `server/db/schema-registry.js`.

- [ ] **2.1** Тест `231.test.js`: база до 231 (копия `.sql` < 231 во временный каталог, как в `226.test.js`) С ДАННЫМИ.
  - Заявки `call`, `instagram`, `telephony`; строка услуги и задача на заявке.
  - Заявка с пустым `source` — FK выключены на время вставки.

  Проверки после `migrate`:
  - `sources = '["call"]'` и т. д.;
  - число строк, `id`, строки услуг и задачи на месте;
  - у пустого `source` — `sources IS NULL`;
  - повторный бэкфилл (UPDATE из файла) даёт `changes = 0`, данные те же;
  - повторный `migrate(db)` ничего не делает.
- [ ] **2.2** Тест реестра: `readableColumns('crm_requests')` содержит `sources`, `writableColumns(… 'insert'|'update')` тоже, `jsonColumns` = `['sources']`.
- [ ] **2.3** Прогнать — падает.
- [ ] **2.4** Миграция: `ALTER TABLE crm_requests ADD COLUMN sources TEXT;` + `UPDATE … SET sources = json_array(source) WHERE sources IS NULL AND source IS NOT NULL AND source <> ''`. Таблица НЕ пересобирается.
- [ ] **2.5** Реестр: `sources` в `read.columns`, `write.insert.columns`, `write.update.columns`; `json: ['sources']`. Метка в каждой правленой строке.
- [ ] **2.6** Прогнать:

```bash
node --experimental-vm-modules --test server/db/migrations/231.test.js server/db/migration-order.test.js
```

- [ ] **2.7** Коммит (реестр — общий файл, проверить ханки).

### Задача 3: запись — проверка `sources` и `source = sources[0]`

**Файлы:** `server/services/crm/sources.js` (`crmSourcesWrite`, `CrmSourcesError`), `server/routes/db.js`, `server/routes/crm-multi-source.test.js`, `public/js/admin/i18n-strings.js`.

- [ ] **3.1** Тест `crm-multi-source.test.js` (HTTP, `createApp` + `listen`, вход оператором, регистратурой, врачом):
  - вставка с `sources: ['instagram','referral']` → в базе `source = 'instagram'`, `sources = '["instagram","referral"]'`; ответ `returning` несёт массив;
  - правка `sources: ['referral','call']` → `source = 'referral'`;
  - правка одного `source: 'telegram'` → `sources = '["telegram"]'`;
  - отказы 400 (база не тронута): `[]`, `['nope']`, `['call','call']`, 11 ключей, `'call'` (не массив), `[5]`;
  - скрытый источник: новой заявке — 400; заявке, у которой он уже стоит, — 200;
  - роли как у `source`: оператор колл-центра и регистратура пишут, врач — 403; врач читает `sources`.
- [ ] **3.2** Прогнать — падает.
- [ ] **3.3** `crmSourcesWrite(db, meta, body, user)`:
  - таблица `crm_requests`, операции insert/update/upsert, строка или массив строк;
  - `sources` есть → проверить, `row.sources = keys`, `row.source = keys[0]`;
  - есть только непустой `source` → `row.sources = [row.source]`;
  - вернуть `true`, если тело правилось.

  Отказы — `CrmSourcesError` (с шаблоном `rpcT` там, где в фразе ключ). Скрытый ключ разрешён, только если он уже стоит у КАЖДОЙ заявки правки: строки выбираются `compile(select id,source,sources, те же filters)`.
- [ ] **3.4** `routes/db.js`: после `crmAssignRefusal` — вызов. Правка тела → перекомпиляция. `CrmSourcesError` → 400 `errorBody('bad_request', e)`.
- [ ] **3.5** Фразы отказов — в `i18n-strings.js` (ru/uz/en, uz латиницей, в en без кириллицы).
- [ ] **3.6** Прогнать:

```bash
node --experimental-vm-modules --test server/routes/crm-multi-source.test.js server/routes/callcenter-role.test.js server/routes/crm-head.test.js server/i18n-server-messages.test.js
```

- [ ] **3.7** Коммит.

### Задача 4: отчёт колл-центра через `json_each`

**Файлы:** `server/services/rpc/callcenter.js`, `server/services/rpc/callcenter-multi-source.test.js`.

- [ ] **4.1** Тест. Заявки:
  - A `sources ['instagram','referral']`, «Пришёл»;
  - B только `source 'instagram'` (как от звонка/зеркала), в работе;
  - C `telephony` через `leadFromCall`-подобную вставку.

  Проверки:
  - `bySource`: instagram 2, referral 1, telephony 1;
  - `sourceConv`: instagram 2/1, referral 1/1;
  - `kpi.total` = 3 (по заявкам, не 4);
  - выгрузка: строка A — «Instagram, Рекомендация».
- [ ] **4.2** Прогнать — падает.
- [ ] **4.3** `bySource` и `sourceConv` — `FROM crm_requests r, json_each(leadSourcesSql('r')) src`, `COUNT(DISTINCT r.id)`; «пришли» — `COUNT(DISTINCT CASE WHEN r.status = ? THEN r.id END)`. Выгрузка — `leadSources(x)` → подписи через запятую.
- [ ] **4.4** Прогнать:

```bash
node --experimental-vm-modules --test server/services/rpc/callcenter-multi-source.test.js server/services/rpc/callcenter.test.js server/services/rpc/callcenter-shift.test.js
```

- [ ] **4.5** Коммит.

### Задача 5: соседи — звонок, зеркало, слияние, справочник

**Файлы:** `server/services/rpc/crm-merge.js`, `server/services/crm/config.js`, `server/services/crm/sources.js` (`unionLeadSources`), `server/services/crm/multi-source-neighbours.test.js`.

- [ ] **5.1** Тест:
  - звонок → заявка: `recordCall` заводит заявку с `source 'telephony'`, `sources NULL`, `leadSources` → `['telephony']`;
  - зеркало записи: запись колл-центра без заявки заводит заявку `source 'call'`, `leadSources` → `['call']` (через тот же путь, что `crm-calendar-mirror.test.js`, или прямым вызовом);
  - слияние:
    - оставленная `['instagram']` + влитая `['referral','call']` → `sources ['instagram','referral','call']`, `source 'instagram'`;
    - влитая только со `source` — её ключ тоже в объединении;
    - объединение не длиннее 10;
  - справочник: удалить источник, который стоит у заявки только вторым, — 409.
- [ ] **5.2** Прогнать — падает (слияние, справочник).
- [ ] **5.3** `unionLeadSources(cards)` (порядок: оставленная, затем влитые по дате; без повторов; ≤ 10). В `crmMergeLeads` — `sources` в UPDATE, `source` не меняется.
- [ ] **5.4** `saveSources`: счётчик заявок — `source = ? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(sources) THEN sources END) WHERE value = ?)`.
- [ ] **5.5** Прогнать:

```bash
node --experimental-vm-modules --test server/services/crm/multi-source-neighbours.test.js server/services/rpc/crm-merge.test.js server/services/rpc/crm-merge-review.test.js server/services/crm/lead-from-call.test.js server/services/crm/config.test.js server/routes/crm-calendar-mirror.test.js
```

- [ ] **5.6** Коммит.

### Задача 6: экран доски и окна заявки

**Файлы:** `public/js/admin/views/crm.js`, `public/js/admin/__tests__/crm-multi-source.test.mjs`, `public/js/admin/i18n-strings.js`, `public/js/admin.js`.

- [ ] **6.1** Тест (стенд `crm-harness.mjs`). Заявки:
  - 1: `sources ['instagram','referral']`;
  - 2: `source 'instagram'`;
  - 3: `source 'call'`.

  Проверки:
  - **чипы фильтра:** «Все · 3», Instagram · 2, Рекомендация · 1, Звонок · 1;
  - **фильтр по нескольким:** отметить Рекомендация + Звонок → карточки 1 и 3; «Все» снимает;
  - **карточка доски:** два тега источника (`data-lead-source`);
  - **таблица:** «Instagram, Рекомендация»;
  - **Excel:** подменить `import` нельзя — проверить через экспортируемую `sourcesText()`, или колонку в `aoa`, вынесенную в чистую функцию `excelRows()`;
  - **окно заявки:**
    - чипы `data-src-pick` с `aria-pressed`;
    - снять Instagram → остаётся Рекомендация;
    - снять последний → тост «Нужен хотя бы один источник.», выбор цел;
    - добавить Звонок;
    - «Сохранить» → в `update` ушли `sources ['referral','call']`, `source 'referral'`;
  - **новая заявка:** стартует с источника по умолчанию, `insert` несёт `sources [default]`;
  - **«Отчёт»:** заявка 1 в строках Instagram и Рекомендация; «Всего» = 3 (не 4).
- [ ] **6.2** Прогнать — падает.
- [ ] **6.3** `crm.js`:
  - `state.sources` (массив) вместо `state.source`;
  - `inSource` через `leadHasAnySource`;
  - `paintFilters` через `sourceTally`, чипы `data-src-chip` + `aria-pressed`, выбранный чип виден и при нуле;
  - теги карточки — по тегу на источник;
  - таблица и Excel — `sourcesText(r)`;
  - `requestModal`: `srcChosen` — массив по правилу чтения, выбор через `toggleLeadSource`, скрытые источники заявки остаются в выборе, подсказка «первый — главный»;
  - `payload.sources` + `payload.source = sources[0]`;
  - `leadHintLine` принимает массив;
  - `reportModal` — `sourceTally` + строка «Всего» по заявкам.
- [ ] **6.4** Новые фразы — в `i18n-strings.js`.
- [ ] **6.5** Штамп `admin.js`: `views/crm.js?v=msrc1`.
- [ ] **6.6** Прогнать:

```bash
node --experimental-vm-modules --test public/js/admin/__tests__/crm-multi-source.test.mjs public/js/admin/__tests__/crm-card.test.mjs public/js/admin/__tests__/crm-tags.test.mjs public/js/admin/__tests__/crm-search.test.mjs public/js/admin/__tests__/crm-dedup.test.mjs public/js/admin/__tests__/crm-tasks.test.mjs public/js/admin/__tests__/crm-board-config.test.mjs public/js/admin/__tests__/crm-lines.test.mjs public/js/admin/__tests__/crm-duplicates.test.mjs public/js/admin/__tests__/crm-lead-calls.test.mjs public/js/admin/__tests__/crm-board-width.test.mjs public/js/admin/__tests__/booking-doors.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs
```

- [ ] **6.7** Коммит (`i18n-strings.js`, `admin.js` — общие: проверить ханки).

### Задача 7 (по возможности): живая проверка

- [ ] Копия базы разработки через `rec-harness.mjs` (сначала `migrate(db)` на копии — это и проверка миграции 231 на настоящих данных).
- [ ] Снимки: окно заявки с двумя источниками, ряд фильтров с двумя отмеченными. Снимки — в каталог сессии, не в репозиторий.

---

## Покрытие обязательных тестов спецификации

| № | Что | Где |
|---|---|---|
| 1 | миграция 231: бэкфилл, повторный накат, пустой `source` | `server/db/migrations/231.test.js` |
| 2 | реестр: штамп, отказы, сброс `sources`, роли | `server/routes/crm-multi-source.test.js` |
| 3 | правило чтения — одна таблица примеров для JS и SQL | `server/services/crm/sources.test.js` (+ `public/js/admin/crm-sources.test.mjs`) |
| 4 | экран | `public/js/admin/__tests__/crm-multi-source.test.mjs` |
| 5 | `callcenter_report` | `server/services/rpc/callcenter-multi-source.test.js` |
| 6 | звонок, зеркало, слияние | `server/services/crm/multi-source-neighbours.test.js` |
| 7 | переводы | `i18n-coverage`, `i18n-uz-quality`, `i18n-server-messages` |

---

## Ревью (2026-09-29): исправлено M1 и M2

- **M1** — фильтр доски. Отмеченный источник пропадал из ряда, если в новом периоде у него нет заявок: доска пустая, ни один чип не отмечен. Теперь `srcOrder` = видимые ключи, затем ключи счёта, затем отмеченные (`state.sources`), без повторов. Отмеченный рисуется всегда, с нулём, и снимается. Тест — `crm-multi-source.test.mjs`, «ревью M1».
- **M2** — запись одного `source` (вкладка со старым `crm.js` шлёт его при каждом сохранении). Раньше `sources` сбрасывался в `[source]` и молча терял остальные источники, а скрытый ключ проходил без проверки. Теперь:
  - ключ проходит ту же проверку, что `sources`;
  - у вставки `sources = [source]`;
  - у правки он первым, источники заявки за ним, без повтора, не больше 10;
  - правка сразу нескольких заявок с разными источниками — 400 «Главный источник меняют у одной заявки за раз.».

  Тесты — `server/routes/crm-multi-source.test.js`. Спецификация поправлена.
- **Оставлено известным:** M3 (ответ `returning` у вставки несёт `sources` строкой; правило чтения понимает и её) и мелочи ревью.
- Штамп `crm.js?v=msrc3`.
