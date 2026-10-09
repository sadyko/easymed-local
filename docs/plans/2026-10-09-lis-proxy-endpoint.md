# LIS Proxy → Easy-Med: приём результатов и рабочий список (LIS_PROXY_V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Easy-Med становится адресом программы LIS Proxy на лабораторном ПК: принимает результаты BS-200, BC-780 и AutoLumo A1000 тем же приёмом, что и свой порт LIS, и отвечает BS-200 на запрос рабочего списка — ни одно значение не теряется по вине Easy-Med и не ложится чужому пациенту.

**Architecture:** новый вход `POST /api/lisproxy?key=…` (`server/routes/lisproxy.js`) стоит в `app.js` рядом с вебхуками телефонии, до `requirePasswordChanged`. Ключ проверяется до тела; отказ — тот же 404, что у неизвестного адреса. Каждый запрос сначала пишется строкой `lab_device_messages` (тело — `source_body`, мигр. 239), потом разбирается (`server/lis/lisproxy.js`), ответ — 200 на любой исход:
- **значение** превращается в минимальный ORU^R01 провода `forwarder` (`server/lis/lisproxy-form.js`) и идёт в прежний `receiveMessage` / `ingestMessage`, который дописывает ту же строку журнала;
- **рабочий список** считает `worklistLines` в `ingest.js` теми же воротами (`orderSide`, `siblingSides`, `gateRefusal`).

Прибор за прокси — строка `lab_devices` с `via = 'lisproxy'` (`ensureProxyDevice` в `discover.js`). Настройка (включён, ключ) — файл `data/lisproxy.json`. Экран — карточка «LIS Proxy» и правки «Анализаторов».

**Tech Stack:** Node 24 ESM, express 5, better-sqlite3, `node:test`; клиент — ванильный JS без сборки, поддельный DOM в тестах видов.

**Спецификация (договор):** `docs/specs/2026-10-09-lis-proxy-endpoint-design.md`. Решения владельца (1–6) и решения дизайна (Р1–Р25) — там; план их не пересматривает.

**Источники:**
- `C:\Users\user\Desktop\analyzer-research\lisproxy\LISPROXY-EASYMED.md` — §2 — провод (факт), §5 — наладка;
- `…\lisproxy\harness\fixtures.json`, `replay_fixtures.py`, `README.md` — тела запросов настоящей программы и проверка.

**Код этого плана проверен до записи.** Всё, что ниже, собрано в копии дерева в scratchpad (`lpx-proto`, вне клона), и там:
- зелёные все тесты `server/lis/*.test.js` (575 вместе с новыми), RPC, i18n, `type-scale`, `rpc-exists`, `db-query-schema`, `client-rpc-coverage`, тесты экрана «Анализаторы»;
- ключевые тесты проверены «на красное»: каждый падает, если убрать его правку;
- `replay_fixtures.py` против запущенного сервера дал исходы раздела «Завершение».

Номера строк — на коммит `92cd84d`; перед правкой найти место по якорю (текст из блока «Найти»).

---

## Правила дерева (читать до первого шага)

- **Дерево** — изолированный клон `C:\Users\user\Desktop\implementation workflow\easymed.lisproxy`, ветка `feat/lis-proxy`:
  - работаете в нём только вы;
  - ветку не переключать, worktree не создавать (он стирает `node_modules`), тег не ставить никогда;
  - `core.autocrlf=false`, файлы — LF.
- **Запрещено:** `git checkout`, `git restore`, `git stash`, `git reset`, `git switch`, `git merge`, `git add -A`, `git add .`.
- **Перед каждым коммитом:**
  - `git status --short`;
  - `git diff --cached --name-only` пуст прямо перед `git add`;
  - стейджить только файлы задачи, по одному: `git add -- <файл>`;
  - `git diff --cached --stat` — только они.
- **Метка.** Каждая вставка в общих файлах несёт `LIS_PROXY_V1` в комментарии или хвосте строки. Общие файлы:
  - `server/app.js`, `server/db/schema-registry.js`;
  - `server/services/rpc/index.js`, `server/services/control/gate.js`;
  - `public/js/admin/i18n-strings.js`;
  - `server/lis/ingest.js`, `receive.js`, `inbox.js`, `discover.js`, `index.js`, `wire.js`.
- **Сообщение коммита** — файлом:
  - Write в `C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/msg-lisproxy-<N>.txt`;
  - затем `git commit -F <файл>`;
  - по-русски, тема с меткой `(LIS_PROXY_V1)`;
  - последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Тесты** — только явными путями, из корня клона:
  - серверные — `node --test <файлы>`;
  - клиентские `.mjs` — `node --experimental-vm-modules --test <файлы>`;
  - все LIS-тесты разом — `node --test $(ls server/lis/*.test.js)`. НЕ `node --test server/lis/`: на Node 24 под Windows так не запускается ничего полезного.
- **Миграция.** Номер **239**: основная линия кончается на 236, а 237 и 238 заняты неслитой веткой CRM (`docs/plans/2026-10-09-crm-unify.md`).
  - ПРЯМО ПЕРЕД созданием файла: `ls server/db/migrations | tail -6`;
  - 237 и 238 не брать никогда;
  - если 239 занят — следующий свободный (переименовать и `NNN.test.js`), доложить номер.
- **Тексты:**
  - каждый новый русский литерал в `public/js/admin/**` — статья ru / uz / en в начале `STRINGS` (`public/js/admin/i18n-strings.js`), хвост `// LIS_PROXY_V1`;
  - перед добавлением — `grep -n '"<текст>"' public/js/admin/i18n-strings.js`: есть статья — вторую не заводить;
  - uz — латиница, en — без кириллицы;
  - сообщения сервера (`reason:`, `new …Error(`) — тоже в словаре (`server/i18n-server-messages.test.js`).
- **Кегли** — только шкала 12.5 / 13.5 / 15 / 17 / 20 / 24 / 30 / 40 px. **Иконки** — только `Icon()` набора приложения (`icon-map.js`: `Copy`, `Key`, `Link`, `Warning`, `Info`), без эмодзи.
- **Полный набор тестов** во время задач не гонять — его делает контролёр («Завершение»). Тест-стенды экранов ставят `admin.lang = 'ru'` до импорта (ловушка локали CI).

---

## Сторожа репозитория

| Сторож | Файл | Когда обязателен |
|---|---|---|
| route-gate | `public/js/admin/__tests__/route-gate.test.mjs` | правка `public/js/admin.js` (в этом плане её нет — прогнать в «Завершении») |
| db-query-schema | `public/js/admin/__tests__/db-query-schema.test.mjs` | задачи 9–12 (колонки `lab_devices` на экране) |
| schema-registry conformance | `server/db/schema-registry-conformance.test.js`, `server/db/schema-registry.test.js` | задачи 2 (миграция), 9 (реестр) |
| write-grant | `server/db/write-grant.test.js` | задача 9 |
| migration-order | `server/db/migration-order.test.js` | задача 2 |
| i18n | `public/js/admin/__tests__/i18n-coverage.test.mjs`, `i18n-uz-quality.test.mjs`, `english-literals-v3120.test.mjs`, `server/i18n-server-messages.test.js` | задачи 3, 9–12 |
| шкала кеглей | `public/js/admin/__tests__/type-scale.test.mjs` | задачи 10–12 |
| RPC | `public/js/admin/__tests__/rpc-exists.test.mjs`, `server/services/rpc/client-rpc-coverage.test.js`, `server/services/rpc/index.test.js`, `server/routes/licence-gate.test.js` | задачи 9, 10 |
| гигиена тестов и приложения | `server/app-test-hygiene.test.js`, `server/app.test.js`, `server/app.health.test.js` | задачи 2, 13 |
| сборка поставки | `scripts/build-bundle.test.js` | задача 2 (новые файлы в `server/test-helpers` в поставку не идут) |
| инварианты владельца | `server/lis/ingest.test.js`, `receive.test.js`, `sample.test.js`, `match.test.js`, `discover.test.js`, `index.test.js`, `real-analyzers.e2e.test.js`, `server/services/rpc/lis.test.js` | задачи 1, 3, 5–8 |

**Тесты, которые план меняет НАМЕРЕННО:** только `server/lis/real-analyzers.e2e.test.js` (задача 1). Утверждения о прежних правилах не удаляются: к ним добавлены «Добавить» находки и номер «000124» как напечатан, с комментарием `LIS_PROXY_V1, задача 1`. Тесты `server/lis/ingest.test.js` не правятся вовсе: все должны остаться зелёными.

---

## Решения плана (где дизайн оставил выбор исполнению)

| № | Решение | Почему (одна строка) |
|---|---|---|
| П1 | Порядок: вход (2) → прибор (3) → форма (4) → результат (5) → серия (6) → рабочий список (7) → прочие запросы (8) → RPC (9) → экран (10–12) → фикстуры (13). | Результаты работают сквозь задачи 5–6, рабочий список — после 7; проверка настоящей программой — сразу после 7 (пробный период до 2026-10-10 18:51). |
| П2 | Стенд — `server/test-helpers/lisproxy-clinic.js`, тела — копия `fixtures.json` байт в байт (`server/test-helpers/lisproxy-fixtures.json`). | `server/test-helpers` не уходит в поставку (`BUNDLE_EXCLUDES`), а тесты читают тела настоящей программы. |
| П3 | Сид и осмотр базы для `replay_fixtures.py` и настоящей программы — скрипты в scratchpad, не в репозитории. | Это проверка контролёра, не код продукта. |
| П4 | Карточка «LIS Proxy» — свой модуль `public/js/admin/views/lab-proxy-card.js`. | `lab-devices.js` уже 1412 строк; карточка живёт сама (своё чтение, не в опросе). |
| П5 | `recordMessage({ id })` бросает, если строки нет. | Дописать несуществующую строку журнала молча — потеря значения. |
| П6 | Общий список моделей прокси — `public/js/shared/lisproxy-models.js`. | Его читают и сервер (`lis_device_add`), и экран — как `specialty-list.js`. |
| П7 | `?v=` в импортах не трогаем. | NO_STALE_CODE_V1: js отдаётся с `no-cache`, браузер переспрашивает сам. |
| П8 | Заметки к выпуску — не в этом плане. | Выпуск — по слову владельца; `release-notes.test.mjs` правок на каждом коммите не требует. |

---

## Карта файлов

**Новые (сервер):**
- `server/db/migrations/239_lis_proxy.sql`, `server/db/migrations/239.test.js` — задача 2;
- `server/lis/lisproxy-settings.js` (+ `.test.js`) — настройка: файл, ключ, сравнение (задача 2);
- `server/lis/lisproxy.js` — журнал, прибор, результат, рабочий список, прочие запросы (задачи 2, 3, 5, 7, 8);
- `server/routes/lisproxy.js` (+ `.test.js`) — вход (задача 2);
- `server/lis/lisproxy-form.js` (+ `.test.js`) — форма → ORU, мусор, номер, ответ рабочего списка (задача 4);
- `server/lis/lisproxy-device.test.js` — задача 3;
- `server/lis/lisproxy-results.test.js` — задача 5;
- `server/lis/lisproxy-series.test.js` — задача 6;
- `server/lis/lisproxy-worklist.test.js` — задача 7;
- `server/lis/lisproxy-other.test.js` — задача 8;
- `server/lis/lisproxy-fixtures.test.js` — задача 13;
- `server/services/rpc/lis-proxy.js` (+ `.test.js`) — RPC карточки (задача 9);
- `server/test-helpers/lisproxy-clinic.js`, `server/test-helpers/lisproxy-fixtures.json` — стенд (задача 2).

**Новые (клиент):**
- `public/js/shared/lisproxy-models.js` — задача 9;
- `public/js/admin/views/lab-proxy-card.js` — задача 10;
- `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` — задачи 10–12.

**Меняются:**
- `server/lis/real-analyzers.e2e.test.js` (1);
- `server/app.js`, `server/lis/inbox.js` (2);
- `server/lis/discover.js`, `server/lis/index.js` (3);
- `server/lis/wire.js` (4);
- `server/lis/inbox.js`, `server/lis/receive.js`, `server/lis/ingest.js`, `server/services/rpc/lis.js` (5);
- `server/lis/ingest.js` (6, 7);
- `server/services/rpc/index.js`, `server/services/control/gate.js`, `server/services/rpc/lis.js`, `server/db/schema-registry.js` (9);
- `public/js/admin/views/lab-devices.js`, `lab-devices-lists.js` (+ `lab-devices-lists.test.mjs`) (10–12);
- `public/js/admin/i18n-strings.js` (3, 9–12).

---

## Task 1: Три упавших сквозных теста анализаторов — под правила 2026-10-06 (LIS_PROXY_V1)

**Files:**
- Modify (тест, намеренно): `server/lis/real-analyzers.e2e.test.js` (~236-243, ~282-284, ~333-337, ~488-490)

**Сейчас:** `node --test $(ls server/lis/*.test.js)` — 450 / 453. Падают:
- «BS-200: запрос…»;
- «A1000: по сети…»;
- «BS-200 сменил адрес…».

**Причина — не время, а устаревшие утверждения.** Сквозные случаи v3.15.0 (`b6f1628`) проверяют правила до 2026-10-06. Коммит `be799106` («номер только с этикетки», решение владельца п. 4, и N2 «находка не пишет в бланк до «Добавить»») их изменил. `d6864a08` дописал новые случаи и прежние не тронул («прежние случаи не тронуты»):
1. голый `124` теперь «короче 6 цифр», а не «старше 7 дней»; второй BS-200 (`127.0.0.6`) в том же тесте — находка, и он получает N2 вместо «привязана к другому анализатору той же модели»;
2. переадресатор A1000 (`127.0.0.4`) — находка: N2 вместо `applied`;
3. BS-200 с новым адресом (`127.0.0.7`) — находка: N2 вместо «если это тот же анализатор с новым адресом…».

Правки ниже проверены на копии файла: 11 / 11.

- [ ] **Step 1: убедиться, что падают ровно эти три.** Run: `node --test server/lis/real-analyzers.e2e.test.js`. Expected: `ℹ fail 3`, имена — выше.

- [ ] **Step 2: правка А — шаг 5 первого теста.** Найти:
```js
      // 5. Голый номер старого открытого заказа (8 дней) — отказ с причиной, без привязки.
      await bs.send(BS_ORU('124', '2', 'test2', '7.000000'));
      m = last(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
      assert.match(m.detail, /без префикса LAB- указывает на заказ № 124/);
```
Заменить на:
```js
      // 5. LIS_VENDOR_EXACT_V1 (решение владельца 2026-10-06, п. 4) — короткий голый
      //    номер «124» — номер прибора, а не этикетка: в лоток, заказ не ищется
      //    (LIS_PROXY_V1, задача 1: прежняя проверка ждала правило 7 дней).
      await bs.send(BS_ORU('124', '2', 'test2', '7.000000'));
      m = last(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
      assert.match(m.detail, /номер пробы «124» короче 6 цифр/);
      //    Номер с этикетки, как напечатан («000124»), старого открытого заказа
      //    (8 дней) — отказ с причиной, без привязки.
      await bs.send(BS_ORU('000124', '2', 'test2', '7.000000'));
      m = last(db);
      assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
      assert.match(m.detail, /без префикса LAB- указывает на заказ № 124/);
```

- [ ] **Step 3: правка Б — шаг 8 первого теста** (второй BS-200 сперва найден и добавлен). Найти:
```js
        const ack = await bs2.send(BS_ORU('LAB-000002', '2', 'CREA', '88.000000'));
```
Заменить на:
```js
        // LIS_VENDOR_EXACT_V1 (N2) — находка в бланки не пишет до «Добавить»: второй
        // BS-200 сперва найден (запрос) и добавлен — тогда видно правило R2, п. 1
        // (LIS_PROXY_V1, задача 1).
        await bs2.send(BS_QRY('LAB-000002'));
        db.prepare("UPDATE lab_devices SET added = 1 WHERE host = '127.0.0.6'").run();
        const ack = await bs2.send(BS_ORU('LAB-000002', '2', 'CREA', '88.000000'));
```

- [ ] **Step 4: правка В — переадресатор A1000.** Найти:
```js
      assert.equal(last(db).status, 'applied', 'та же модель — та же панель (правило «та же модель»)');
```
Заменить на:
```js
      // LIS_VENDOR_EXACT_V1 (N2) — переадресатор найден сам: до «Добавить» проба в
      // бланк не идёт (LIS_PROXY_V1, задача 1).
      assert.deepEqual([last(db).status, last(db).detail],
        ['unmatched', 'прибор ещё не добавлен — «Анализаторы» → «Добавить прибор» → «Найдены в сети» → «Добавить»']);
      assert.deepEqual(blank(db, 202), {}, 'находка не пишет в бланк');
      db.prepare('UPDATE lab_devices SET added = 1, model_confirmed = 1 WHERE id = ?').run(fdev.id);
      await fwd.send(FWD_ORU('LAB-000202'));
      assert.equal(last(db).status, 'applied', 'та же модель — та же панель (правило «та же модель»)');
```
(Дальше без изменений: `blank(db, 202)` = `390.946`, «Необработанные» пусты. Строку N2 закрывает п. 5 `closeStaleRows`.)

- [ ] **Step 5: правка Г — BS-200 с новым адресом.** Найти:
```js
    const after = await analyzer(lisPort, '127.0.0.7');
    try {
      for (const t of
```
Заменить на:
```js
    const after = await analyzer(lisPort, '127.0.0.7');
    try {
      // LIS_VENDOR_EXACT_V1 (N2) — прибор с новым адресом — находка: лаборатория
      // нажимает «Добавить» (LIS_PROXY_V1, задача 1).
      await after.send(BS_QRY('LAB-000001'));
      db.prepare("UPDATE lab_devices SET added = 1 WHERE host = '127.0.0.7'").run();
      for (const t of
```

- [ ] **Step 6: проверить.** Run:
  - `node --test server/lis/real-analyzers.e2e.test.js` → `ℹ pass 11`, `ℹ fail 0`;
  - `node --test $(ls server/lis/*.test.js)` → `ℹ fail 0` (453 / 453).

- [ ] **Step 7: коммит.** `git add -- server/lis/real-analyzers.e2e.test.js`. Сообщение:
```
Сквозные тесты приёма: прежние случаи — под правила 2026-10-06 (номер только с этикетки, находка до «Добавить») (LIS_PROXY_V1)

Три случая v3.15.0 падали на ветке анализаторов не из-за времени: be799106
изменил правила (голый номер короче 6 цифр — в лоток; находка не пишет до
«Добавить»), а d6864a08 прежние случаи не тронул. Утверждения о прежних
правилах сохранены: номер «000124» как напечатан, «Добавить» у находок.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

---

## Task 2: Вход `/api/lisproxy` — ключ, 404, журнал первым, 200, без сжатия; мигр. 239; стенд (LIS_PROXY_V1)

**Files:**
- Create:
  - `server/db/migrations/239_lis_proxy.sql`, `server/db/migrations/239.test.js`;
  - `server/lis/lisproxy-settings.js`, `server/lis/lisproxy-settings.test.js`;
  - `server/lis/lisproxy.js` (каркас);
  - `server/routes/lisproxy.js`, `server/routes/lisproxy.test.js`;
  - `server/test-helpers/lisproxy-clinic.js`, `server/test-helpers/lisproxy-fixtures.json`.
- Modify:
  - `server/lis/inbox.js` (`recordMessage`, ~57-62) — `sourceBody`;
  - `server/app.js` (импорт ~16, вход после ~117).

- [ ] **Step 1: номер миграции.** Run: `ls server/db/migrations | tail -6`. Expected: последняя — `236_consultation_templates_author.sql`. 237 и 238 не брать.

- [ ] **Step 2: падающий тест миграции.** Create `server/db/migrations/239.test.js`:
```js
// LIS_PROXY_V1 (мигр. 239) — ПРИЁМ ЧЕРЕЗ LIS PROXY: только ADD COLUMN.
//
// Новые колонки есть и пусты у прежних строк; via принимает только NULL и
// 'lisproxy'; таблицы не пересобраны (строки и триггер адреса мигр. 233 на
// месте); смена proxy_ip у строки BS-200 эпоху кодов и подтверждения не трогает.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function dbBefore239() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig239-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 239)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('239: колонки LIS Proxy добавлены, прежние строки не тронуты, via — только NULL или lisproxy', () => {
  const db = dbBefore239();
  db.exec(`INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled) VALUES (7, 'BS-200', 'mindray-bs-200', 'mllp', '10.0.0.40', 2575, 1);
           INSERT INTO lab_device_messages (id, device_id, raw, status) VALUES (9, 7, 'MSH|^~\\&|x', 'applied');`);
  migrate(db);
  for (const c of ['via', 'proxy_name', 'proxy_label', 'proxy_ip']) assert.ok(cols(db, 'lab_devices').includes(c), 'lab_devices.' + c);
  for (const c of ['source_body', 'reply_body']) assert.ok(cols(db, 'lab_device_messages').includes(c), 'lab_device_messages.' + c);
  assert.deepEqual(db.prepare('SELECT name, host, via, proxy_ip FROM lab_devices WHERE id = 7').get(),
    { name: 'BS-200', host: '10.0.0.40', via: null, proxy_ip: null }, 'прежняя строка — как была, via пуст');
  assert.deepEqual(db.prepare('SELECT raw, source_body, reply_body FROM lab_device_messages WHERE id = 9').get(),
    { raw: 'MSH|^~\\&|x', source_body: null, reply_body: null });
  assert.throws(() => db.prepare("UPDATE lab_devices SET via = 'mllp' WHERE id = 7").run(), /CHECK/);
  db.prepare("UPDATE lab_devices SET via = 'lisproxy' WHERE id = 7").run();
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_lab_devices_address_unstamp'").get(),
    'триггер адреса мигр. 233 на месте — таблица не пересобиралась');
});

test('239: смена proxy_ip у строки BS-200 не снимает подтверждения и не растит эпоху (триггер смотрит host и port)', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.exec(`INSERT INTO lab_devices (id, name, profile, transport, host, enabled, via, proxy_name, proxy_ip) VALUES (1, 'bs200', 'mindray-bs-200', 'mllp', '', 1, 'lisproxy', 'bs200', '192.168.1.21');
           INSERT INTO services (id, name, is_lab) VALUES (9, 'Биохимия', 1);
           INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5, 'Биохимия', 9, 1);
           INSERT INTO lab_panel_analytes (panel_id, code, name, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
             VALUES (5, 'GLU', 'Глюкоза', 'GLU', 1, 1, 0);`);
  db.prepare("UPDATE lab_devices SET proxy_ip = '192.168.1.35' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT code_epoch FROM lab_devices WHERE id = 1').get().code_epoch, 0);
  assert.deepEqual(db.prepare('SELECT device_code_confirmed_device_id AS d, device_code_confirmed_epoch AS e FROM lab_panel_analytes WHERE panel_id = 5').get(), { d: 1, e: 0 });
});
```
Run: `node --test server/db/migrations/239.test.js`. Expected: FAIL (колонок нет).

- [ ] **Step 3: миграция.** Create `server/db/migrations/239_lis_proxy.sql`:
```sql
-- 239 — LIS_PROXY_V1 (2026-10-09): ПРИЁМ ЧЕРЕЗ LIS PROXY
-- (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 8).
--
-- LIS Proxy — программа поставщика на лабораторном ПК: говорит с анализатором
-- и на каждое значение шлёт форму POST на /api/lisproxy. Её анализатор — строка
-- lab_devices с via = 'lisproxy'.
--
-- ТОЛЬКО ADD COLUMN (как мигр. 233): таблицы не пересобираются, CHECK
-- мигр. 123 не трогаются, бэкфилла нет, новых таблиц и триггеров нет.

-- Чей прибор: NULL — свой порт LIS (как все строки до этой миграции);
-- 'lisproxy' — анализатор за LIS Proxy. Пишет только сервер (discover.js
-- ensureProxyDevice). Свой порт такие строки не видит (discover.js
-- ensureDevice, lis/index.js — via IS NULL).
ALTER TABLE lab_devices ADD COLUMN via TEXT CHECK (via IS NULL OR via IN ('lisproxy'));

-- Имя анализатора в LIS Proxy (lisResult[name] / order[name]) — по нему и по
-- адресу прибор узнаётся; подпись (-host, обычно имя лабораторного ПК) — для
-- показа и для узнавания после смены адреса; адрес лабораторного ПК. Адрес —
-- НЕ host: триггер мигр. 233 (trg_lab_devices_address_unstamp) на смену host у
-- BS-200 снимает подтверждения, а смена адреса по DHCP у LIS Proxy — не смена
-- прибора. sending_app у таких строк пуст: по нему приём угадывает модель.
ALTER TABLE lab_devices ADD COLUMN proxy_name TEXT;
ALTER TABLE lab_devices ADD COLUMN proxy_label TEXT;
ALTER TABLE lab_devices ADD COLUMN proxy_ip TEXT;

-- Тело запроса LIS Proxy как пришло (форма, percent-encoding): raw держит
-- синтетический ORU^R01, который перечитывают серия, «Привязать» и «Поле
-- анализатора». Ответ Easy-Med (рабочий список — JSON) — для журнала: кто
-- спросил какую пробирку и что ему ответили. Пишет только сервер.
ALTER TABLE lab_device_messages ADD COLUMN source_body TEXT;
ALTER TABLE lab_device_messages ADD COLUMN reply_body TEXT;
```
Run: `node --test server/db/migrations/239.test.js`. Expected: PASS (2).

- [ ] **Step 4: падающий тест настройки.** Create `server/lis/lisproxy-settings.test.js`:
```js
// LIS_PROXY_V1 — настройка LIS Proxy (файл data/lisproxy.json): чтение не
// бросает, включён — только с ключом, ключ — 43 знака base64url, сравнение —
// по SHA-256 за постоянное время.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { readProxySettings, writeProxySettings, newProxyKey, keyMatches, settingsPath } from './lisproxy-settings.js';

test('нет файла, мусор, массив, включён без ключа — выключено', () => {
  const dir = tmpDir('em-lpx-set-');
  assert.deepEqual(readProxySettings(dir), { enabled: false, key: null, changed_at: null, changed_by: null });
  for (const text of ['{не json', '[]', 'null', '{"enabled":true}', '{"enabled":true,"key":"   "}']) {
    fs.writeFileSync(settingsPath(dir), text);
    assert.equal(readProxySettings(dir).enabled, false, text);
  }
});

test('запись и чтение: включён с ключом; кто и когда; BOM не мешает', () => {
  const dir = tmpDir('em-lpx-set-');
  const s = writeProxySettings(dir, { enabled: true, key: 'k-1', changed_by: 7 });
  assert.equal(s.enabled, true);
  assert.equal(s.key, 'k-1');
  assert.equal(s.changed_by, 7);
  assert.match(s.changed_at, /^\d{4}-\d{2}-\d{2}T/);
  fs.writeFileSync(settingsPath(dir), '\uFEFF' + JSON.stringify({ enabled: true, key: 'k-2' }));
  assert.deepEqual([readProxySettings(dir).enabled, readProxySettings(dir).key], [true, 'k-2']);
  assert.equal(writeProxySettings(dir, { enabled: false, key: 'k-2' }).enabled, false, 'выключенный ключ хранит');
  assert.equal(readProxySettings(dir).key, 'k-2');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'временных файлов не осталось');
});

test('ключ: 43 знака base64url, каждый раз новый', () => {
  const a = newProxyKey();
  const b = newProxyKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('keyMatches: только точное совпадение; не строка, пусто, массив — нет', () => {
  assert.equal(keyMatches('abc', 'abc'), true);
  assert.equal(keyMatches('abd', 'abc'), false);
  assert.equal(keyMatches('abc ', 'abc'), false);
  assert.equal(keyMatches('', 'abc'), false);
  assert.equal(keyMatches('abc', null), false);
  assert.equal(keyMatches(['abc'], 'abc'), false);
  assert.equal(keyMatches(undefined, 'abc'), false);
  assert.equal(keyMatches('a'.repeat(5000), 'abc'), false, 'длинная строка не бросает');
});

test('settingsPath — файл в папке данных здания', () => {
  assert.equal(path.basename(settingsPath('X')), 'lisproxy.json');
});
```
Run: `node --test server/lis/lisproxy-settings.test.js`. Expected: FAIL (модуля нет).

- [ ] **Step 5: модуль настройки.** Create `server/lis/lisproxy-settings.js`:
```js
// LIS_PROXY_V1 — настройка приёма LIS Proxy: включён ли и ключ
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 1, Р1, Р2).
//
// Файл data/lisproxy.json, а не таблица: миграции этой работы — только ADD
// COLUMN, таблицы настроек у лаборатории нет, а секрет пары филиалов уже живёт
// так же (branch-sync/pairing.js) — у здания свой, в /api/db и в синхронизацию
// зданий не попадает. Чтение НИКОГДА не бросает: испорченный файл — «выключено»
// (прокси получит 404, а не 500).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAtomic } from '../services/control/checkin.js';

export const SETTINGS_FILE = 'lisproxy.json';
const OFF = Object.freeze({ enabled: false, key: null, changed_at: null, changed_by: null });

export function settingsPath(dataDir) { return path.join(dataDir, SETTINGS_FILE); }

/** { enabled, key, changed_at, changed_by }; включён — только с ключом. */
export function readProxySettings(dataDir) {
  let raw;
  try { raw = fs.readFileSync(settingsPath(dataDir), 'utf8'); } catch { return { ...OFF }; }
  let v;
  try { v = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { return { ...OFF }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...OFF };
  const key = typeof v.key === 'string' && v.key.trim() ? v.key.trim() : null;
  return {
    enabled: v.enabled === true && !!key,
    key,
    changed_at: typeof v.changed_at === 'string' ? v.changed_at : null,
    changed_by: Number.isInteger(v.changed_by) ? v.changed_by : null,
  };
}

/** Записать настройку целиком (tmp + rename) и вернуть её прочитанной. */
export function writeProxySettings(dataDir, { enabled = false, key = null, changed_by = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const rec = { enabled: enabled === true, key: key || null, changed_at: new Date().toISOString(), changed_by: Number.isInteger(changed_by) ? changed_by : null };
  writeAtomic(settingsPath(dataDir), JSON.stringify(rec, null, 2));
  return readProxySettings(dataDir);
}

/** Ключ: 32 случайных байта, base64url — 43 знака без + / = (безопасен в кавычках cmd и в TOML). */
export function newProxyKey() { return randomBytes(32).toString('base64url'); }

/**
 * Ключ из адреса совпал с сохранённым. Сравниваются SHA-256 обеих строк через
 * timingSafeEqual: время не зависит ни от длины, ни от того, сколько знаков
 * совпало (обычное === выходит на первом несовпавшем знаке).
 */
export function keyMatches(given, stored) {
  if (typeof given !== 'string' || typeof stored !== 'string' || !given || !stored) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(stored, 'utf8').digest();
  return timingSafeEqual(a, b);
}
```
Run: `node --test server/lis/lisproxy-settings.test.js`. Expected: PASS (5).

- [ ] **Step 6: `recordMessage` пишет тело запроса.** В `server/lis/inbox.js` найти:
```js
export function recordMessage(db, { deviceId = null, peer = '', raw, sampleId = '', visitServiceId = null, status, detail = '', kind = 'result', resolved = false, disputes = null }) {
  return db.prepare(`INSERT INTO lab_device_messages
      (device_id, peer, raw, sample_id, visit_service_id, status, detail, kind, resolved_at, disputes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END, ?)`)
    .run(deviceId, peer, String(raw == null ? '' : raw), sampleId, visitServiceId, status, detail, kind, resolved ? 1 : 0, disputes).lastInsertRowid;
}
```
Заменить на:
```js
export function recordMessage(db, { deviceId = null, peer = '', raw, sampleId = '', visitServiceId = null, status, detail = '', kind = 'result', resolved = false, disputes = null, sourceBody = null }) {
  return db.prepare(`INSERT INTO lab_device_messages
      (device_id, peer, raw, sample_id, visit_service_id, status, detail, kind, resolved_at, disputes, source_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END, ?, ?)`)
    .run(deviceId, peer, String(raw == null ? '' : raw), sampleId, visitServiceId, status, detail, kind, resolved ? 1 : 0, disputes, sourceBody).lastInsertRowid;   // LIS_PROXY_V1 — source_body: тело запроса LIS Proxy как пришло
}
```

- [ ] **Step 7: каркас разбора.** Create `server/lis/lisproxy.js`:
```js
// LIS_PROXY_V1 — запрос LIS Proxy: журнал, прибор, результат, рабочий список
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 2–6).
//
// Прокси шлёт каждое значение ОДИН раз и не повторяет, а анализатору уже
// ответил «принято». Поэтому: сначала строка журнала (тело как пришло —
// source_body), потом всё остальное дописывает ЭТУ ЖЕ строку, и ответ — 200 на
// любой исход (маршрут server/routes/lisproxy.js). Результат идёт в прежний
// приём (receive.js → ingest.js) синтетическим ORU^R01 (lisproxy-form.js).
import { recordMessage } from './inbox.js';

/** Журнал строки, пока запрос не разобран: если процесс упал посреди — строка так и скажет. */
export const JOURNAL_PENDING = 'LIS Proxy: запрос сохранён, разбор не завершён';

const OK = Object.freeze({ type: 'text', body: 'OK' });
const empty = () => ({ type: 'json', body: {} });
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

export const methodOf = (body) => str(obj(body).method).trim();

/** Ответ, когда разбор сорвался: прокси ждёт 2xx, и тело ему всё равно. */
export function fallbackReply(method) { return method === 'apiResultSave' ? OK : empty(); }

/** Строка журнала — ПЕРВОЙ, до прибора и разбора. Бросает — маршрут отвечает 500. */
export function journalProxyRequest(db, { peer = '', body = '', method = '', note = '' } = {}) {
  return recordMessage(db, {
    peer, raw: '', status: 'rejected', detail: note || JOURNAL_PENDING,
    kind: method === 'apiResultSave' ? 'result' : 'query', sourceBody: String(body == null ? '' : body),
  });
}

/** Разбор сорвался после журнала: строка говорит почему (по возможности); ответ — всё равно 200. */
export function failJournal(db, id, err) {
  try {
    db.prepare("UPDATE lab_device_messages SET status = 'rejected', resolved_at = NULL, detail = ? WHERE id = ?")
      .run('LIS Proxy: ошибка разбора — ' + String((err && err.message) || err), id);
  } catch { /* журнал уже записан; причина — по возможности */ }
}

/**
 * Разобрать запрос, уже записанный в журнал строкой id. Задачи 3–8 плана
 * наполняют разбор; пока — только ответ.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {} } = {}) {
  return fallbackReply(methodOf(body));
}
```

- [ ] **Step 8: вход.** Create `server/routes/lisproxy.js`:
```js
// LIS_PROXY_V1 — вход LIS Proxy: POST /api/lisproxy?key=…
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 1–2).
//
// Стоит в app.js рядом с вебхуками телефонии — ДО requirePasswordChanged и без
// requireAuth: у программы на лабораторном ПК нет сессии. Свой гейт — ключ в
// строке запроса (прокси сохраняет её в api_url), проверка ДО разбора тела.
// Выключено, нет ключа, не тот, не POST, лишний путь — тот же 404, что у
// неизвестного адреса API (образец — services/telephony/webhooks.js): ничего не
// пишется, прибор не заводится. Лицензия не проверяется (решение владельца 5).
//
// Прокси шлёт каждый запрос ОДИН раз и не повторяет: строка журнала — первой,
// ответ — 200 на любой исход; 500 — только если не записался сам журнал.
import express, { Router } from 'express';
import { readProxySettings, keyMatches } from '../lis/lisproxy-settings.js';
import { journalProxyRequest, handleProxyRequest, failJournal, fallbackReply, methodOf } from '../lis/lisproxy.js';

// Байт в байт как ответ app.js на неизвестный адрес API — отказ не должен
// выдавать, что приёмник здесь есть.
export const NOT_FOUND = Object.freeze({ error: Object.freeze({ code: 'not_found', message: 'Неизвестный адрес API.' }) });
const INTERNAL = Object.freeze({ error: Object.freeze({ code: 'internal', message: 'Ошибка сервера. Повторите позже.' }) });

// Свой разборщик формы: ключи в скобках, как в PHP (lisResult[R][res]) → объект;
// verify сохраняет тело как пришло — для журнала (source_body). 100 КБ — одно
// значение или один номер пробирки, никогда не набор данных.
const parseForm = express.urlencoded({ extended: true, limit: '100kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } });

/** Адрес отправителя — сокет, никогда не X-Forwarded-For (его пишет сам отправитель). */
export function peerOf(req) {
  const s = String((req.socket && req.socket.remoteAddress) || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} dataDir  папка данных здания (data/lisproxy.json)
 * @param {{handle?: Function}} [opts]  шов для тестов; в работе — handleProxyRequest
 */
export function lisProxyRoutes(db, dataDir, { handle = handleProxyRequest } = {}) {
  const r = Router();

  const gate = (req, res, next) => {
    const s = readProxySettings(dataDir);
    const key = req.query ? req.query.key : undefined;
    if (!s.enabled || typeof key !== 'string' || !keyMatches(key, s.key)) return res.status(404).json(NOT_FOUND);
    next();
  };
  // Тело, которое не разобралось, — тоже запрос с ключом: строка журнала и 200 (Р25).
  const parse = (req, res, next) => parseForm(req, res, (err) => {
    if (err) { req.lisProxyParseError = err; req.body = {}; }
    next();
  });

  r.post('/', gate, parse, (req, res) => {
    const peer = peerOf(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const method = methodOf(body);
    const pe = req.lisProxyParseError;
    let id;
    try {
      id = journalProxyRequest(db, { peer, body: req.rawBody ?? '', method,
        note: pe ? 'LIS Proxy: тело запроса не разобрано — ' + (pe.type || pe.message) : '' });
    } catch (e) {
      // Тело в журнал консоли не попадает никогда — только причина.
      console.warn('[lisproxy] журнал не записан:', e && e.message);
      return res.status(500).json(INTERNAL);
    }
    let out = fallbackReply(method);
    if (!pe) {
      try { out = handle(db, { id, peer, body }) || out; }
      catch (e) { failJournal(db, id, e); }
    }
    send(res, out);
  });

  r.use((req, res) => res.status(404).json(NOT_FOUND));
  return r;
}

/**
 * Ответ прокси. Никогда не сжатый (Р5): прокси шлёт Accept-Encoding: gzip, а
 * compress.js жмёт JSON от 1 КБ — рабочий список на 8+ тестов; распакует ли
 * прокси gzip, не проверено, а испорченный JSON — анализатор без заказа.
 * compress.js ответ с Content-Encoding не трогает.
 */
function send(res, out) {
  res.status(200).set('Content-Encoding', 'identity').set('Cache-Control', 'no-store');
  if (out.type === 'text') return res.type('text/plain; charset=utf-8').send(String(out.body));
  return res.type('application/json; charset=utf-8').send(JSON.stringify(out.body));
}
```

- [ ] **Step 9: вход — в приложение.** В `server/app.js`:
  - найти `import { branchSyncRoutes } from './routes/branch-sync.js';   // BRANCH_SYNC_V1`; ниже добавить строку:
```js
import { lisProxyRoutes } from './routes/lisproxy.js';   // LIS_PROXY_V1
```
  - найти `  app.use('/api/telephony/binotel', telephonyWebhooks(db));`; ниже добавить:
```js

  // LIS_PROXY_V1 — LIS Proxy (программа поставщика на лабораторном ПК) шлёт
  // результаты анализаторов и запросы рабочего списка формой POST. Здесь же и
  // по той же причине, что вебхуки выше: сессии у неё нет. Свой гейт — ключ в
  // строке запроса; отказ — тот же 404, что у неизвестного адреса.
  // Лицензионного модуля нет (решение владельца 2026-10-09, п. 5) — как у порта LIS.
  app.use('/api/lisproxy', lisProxyRoutes(db, dataDir));
```

- [ ] **Step 10: тела настоящей программы.** Run:
```
cp "/c/Users/user/Desktop/analyzer-research/lisproxy/harness/fixtures.json" server/test-helpers/lisproxy-fixtures.json
```
Проверить: `cmp` с исходником молчит; в файле нет `\r`.

- [ ] **Step 11: стенд.** Create `server/test-helpers/lisproxy-clinic.js`:
```js
// LIS_PROXY_V1 — стенд тестов LIS Proxy (docs/plans/2026-10-09-lis-proxy-endpoint.md).
// Настоящая база (все миграции), настоящее приложение (createApp с явной папкой
// данных — app-test-hygiene), запросы как у программы: те же заголовки, тела —
// байт в байт из lisproxy-fixtures.json (копия analyzer-research\lisproxy\
// harness\fixtures.json, снятой с настоящего lisproxyd.exe 2026-10-09).
// Не тестовый файл — его импортируют; в поставку не идёт (BUNDLE_EXCLUDES).
import fs from 'node:fs';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { writeProxySettings } from '../lis/lisproxy-settings.js';

export const FIXTURES = JSON.parse(fs.readFileSync(new URL('./lisproxy-fixtures.json', import.meta.url), 'utf8'));

/** Тело запроса фикстуры по группе и id. */
export function fixture(group, id) {
  const f = (FIXTURES[group] || []).find((x) => x.id === id);
  if (!f || typeof f.body !== 'string') throw new Error('нет фикстуры ' + group + '/' + id);
  return f.body;
}

/** Заголовки каждого запроса программы (§2.1 документа). */
export const PROXY_HEADERS = Object.freeze({
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Mozilla/5.0',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip',
});

export const DEV_KEY = 'DEVKEY';

export function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/**
 * Приложение с LIS Proxy. settings: true — data/lisproxy.json с enabled и key;
 * false — файла нет (приём выключен).
 */
export async function startProxyApp(db, { enabled = true, key = DEV_KEY, settings = true } = {}) {
  const dataDir = licensedDataDir();
  if (settings) writeProxySettings(dataDir, { enabled, key });
  const server = await listen(createApp(db, { dataDir }));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    server, base, dataDir,
    url: base + '/api/lisproxy?key=' + encodeURIComponent(key),
    close: () => new Promise((r) => server.close(r)),
  };
}

/** POST как у прокси. */
export function post(url, body, headers = PROXY_HEADERS) {
  return fetch(url, { method: 'POST', headers, body });
}

export const rows = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id').all();
export const lastRow = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
/** Лоток экрана: неразобранные и не принятые (lab-devices.js reload). */
export const tray = (db) => db.prepare("SELECT * FROM lab_device_messages WHERE resolved_at IS NULL AND status <> 'applied' ORDER BY id").all();
export const blank = (db, vsId) => Object.fromEntries(db.prepare('SELECT parameter, value FROM lab_results WHERE visit_service_id = ? ORDER BY id')
  .all(vsId).map((r) => [r.parameter, r.value]));
export const device = (db, name) => db.prepare("SELECT * FROM lab_devices WHERE via = 'lisproxy' AND proxy_name = ?").get(name);

/**
 * Клиника под номера фикстур. Иванов (03.02.1990, муж.):
 *   № 123 «Биохимия» и № 124 «Мочевина» — одна пробирка, один визит (D3);
 *   № 555 «Общий анализ крови»; № 777 «Витамин B12».
 * Каримова (жен.): № 130 «Биохимия» — не оплачен; № 131 — отменён;
 *   № 900001 «Биохимия» — открытый свежий заказ с номером «как номер пациента».
 * Петров (без даты рождения, пол «другой»): № 132 «Биохимия».
 */
export function seedOrders(db) {
  const now = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
  db.exec(`
    INSERT INTO patients (id, full_name, date_of_birth, gender) VALUES
      (3, 'Иванов Иван', '1990-02-03', 'male'), (4, 'Каримова Азиза', '1985-11-20', 'female'), (5, 'Петров Пётр', NULL, 'other');
    INSERT INTO visits (id, patient_id, visit_date, status) VALUES
      (55, 3, ${now}, 'scheduled'), (58, 3, ${now}, 'scheduled'), (59, 3, ${now}, 'scheduled'),
      (56, 4, ${now}, 'scheduled'), (57, 5, ${now}, 'scheduled');
    INSERT INTO services (id, name, is_lab, specimen) VALUES
      (9, 'Биохимия', 1, 'Сыворотка'), (10, 'Витамин B12', 1, 'Сыворотка'), (11, 'Общий анализ крови', 1, 'Кровь'),
      (12, 'Мочевина', 1, 'Сыворотка'), (13, 'Общий анализ мочи', 1, 'Моча');
    INSERT INTO visit_services (id, visit_id, service_id, status, created_at) VALUES
      (123, 55, 9, 'queued', ${now}), (124, 55, 12, 'queued', ${now}),
      (555, 58, 11, 'queued', ${now}), (777, 59, 10, 'queued', ${now}),
      (130, 56, 9, 'added', ${now}), (131, 56, 9, 'cancelled', ${now}), (900001, 56, 9, 'queued', ${now}),
      (132, 57, 9, 'queued', ${now});
  `);
}

/** Прибор за LIS Proxy (добавленный — если не сказано иначе). */
export function addProxyDevice(db, { id = null, name, label = '', ip = '127.0.0.1', profile = '', added = 1, enabled = 1 } = {}) {
  return Number(db.prepare(`INSERT INTO lab_devices (id, name, profile, transport, host, port, enabled, discovered, added, model_confirmed, via, proxy_name, proxy_label, proxy_ip)
                            VALUES (?, ?, ?, 'mllp', '', NULL, ?, 1, ?, ?, 'lisproxy', ?, ?, ?)`)
    .run(id, name, profile, enabled, added, profile ? 1 : 0, name, label || null, ip).lastInsertRowid);
}

/**
 * Панель услуги на приборе; строки [code, name, deviceCode, confirmed = 1] —
 * подтверждены для этого прибора и его эпохи (так пишет экран, ревью R5/R6).
 */
export function bindPanel(db, { id, serviceId, deviceId, name, lines }) {
  db.prepare('INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (?, ?, ?, ?)').run(id, name, serviceId, deviceId);
  lines.forEach(([code, label, deviceCode, confirmed = 1], i) => db.prepare(`INSERT INTO lab_panel_analytes
      (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, device_code_confirmed_device_id, device_code_confirmed_epoch)
      VALUES (?, ?, ?, '', ?, ?, ?, ?, (SELECT code_epoch FROM lab_devices WHERE id = ?))`)
    .run(id, code, label, i + 1, deviceCode, confirmed ? 1 : 0, confirmed ? deviceId : null, deviceId));
}

/** Три анализатора владельца за LIS Proxy (решение 6) — имена и подписи как в фикстурах. */
export const PROXY_DEVICES = Object.freeze([
  Object.freeze({ id: 1, name: 'bs200', label: 'LAB-PC-1', profile: 'mindray-bs-200' }),
  Object.freeze({ id: 2, name: 'bc780x', label: 'LABPC', profile: 'mindray-bc-780' }),
  Object.freeze({ id: 3, name: 'lumo', label: 'LAB-PC-2', profile: 'autobio-autolumo-a1000' }),
]);

/**
 * Клиника для фикстур и replay_fixtures.py: заказы (seedOrders), три прибора
 * LIS Proxy с адреса ip, панели с подтверждёнными кодами GLU / WBC, HGB / 214.
 */
export function seedLisProxyClinic(db, { devices = PROXY_DEVICES, ip = '127.0.0.1' } = {}) {
  seedOrders(db);
  for (const d of devices) addProxyDevice(db, { ...d, ip });
  bindPanel(db, { id: 5, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU']] });
  bindPanel(db, { id: 7, serviceId: 11, deviceId: 2, name: 'ОАК', lines: [['WBC', 'Лейкоциты', 'WBC'], ['HGB', 'Гемоглобин', 'HGB']] });
  bindPanel(db, { id: 6, serviceId: 10, deviceId: 3, name: 'Витамин B12', lines: [['B12', 'Витамин B12', '214']] });
}
```

- [ ] **Step 12: тест входа.** Create `server/routes/lisproxy.test.js`:
```js
// LIS_PROXY_V1 — вход LIS Proxy: ключ, 404 как у неизвестного адреса, журнал
// раньше всего, 200 на любой исход, 500 — только без журнала, ответ не сжат.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { writeProxySettings } from '../lis/lisproxy-settings.js';
import { lisProxyRoutes, NOT_FOUND } from './lisproxy.js';
import { JOURNAL_PENDING } from '../lis/lisproxy.js';
import { freshDb, startProxyApp, post, fixture, rows, PROXY_HEADERS, DEV_KEY } from '../test-helpers/lisproxy-clinic.js';

const RESULT = fixture('results', 'bs200_glu');
const ORDER = fixture('orders', 'bs200_order');

test('приём выключен (файла нет), выключен с ключом, нет ключа, не тот, ключ массивом, ключ в теле, GET, лишний путь — тот же 404, что у неизвестного адреса; ничего не записано', async () => {
  const db = freshDb();
  const off = await startProxyApp(db, { settings: false });
  const on = await startProxyApp(db, { enabled: true });
  const disabled = await startProxyApp(db, { enabled: false });
  try {
    const unknown = await fetch(on.base + '/api/definitely-not-here', { method: 'POST', headers: PROXY_HEADERS, body: RESULT });
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.text();
    assert.equal(unknownBody, JSON.stringify(NOT_FOUND), 'тело 404 — как у app.js');
    const tries = [
      [off.url, RESULT],
      [disabled.url, RESULT],
      [on.base + '/api/lisproxy', RESULT],
      [on.base + '/api/lisproxy?key=WRONG', RESULT],
      [on.base + '/api/lisproxy?key=' + DEV_KEY + '&key=' + DEV_KEY, RESULT],
      [on.base + '/api/lisproxy', RESULT + '&key=' + DEV_KEY],
      [on.base + '/api/lisproxy/x?key=' + DEV_KEY, RESULT],
    ];
    for (const [url, body] of tries) {
      const res = await post(url, body);
      assert.equal(res.status, 404, url);
      assert.equal(await res.text(), unknownBody, url);
    }
    const get = await fetch(on.url);
    assert.equal(get.status, 404);
    assert.equal(await get.text(), unknownBody);
    assert.deepEqual(rows(db), [], 'журнал пуст');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 0, 'прибор не заведён');
  } finally { await off.close(); await on.close(); await disabled.close(); db.close(); }
});

test('ключ верный: строка журнала с телом как пришло; результат — 200 «OK», запрос — 200 {}; без сессии (до requirePasswordChanged)', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    const r1 = await post(app.url, RESULT);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), 'OK');
    const r2 = await post(app.url, ORDER);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), {});
    const [a, b] = rows(db);
    assert.equal(a.source_body, RESULT, 'тело — байт в байт');
    assert.equal(a.kind, 'result');
    assert.equal(a.peer, '127.0.0.1');
    assert.equal(b.source_body, ORDER);
    assert.equal(b.kind, 'query');
  } finally { await app.close(); db.close(); }
});

/** Маршрут один, с подменённым разбором — для «журнал раньше всего» и ответа. */
async function bareRouter(db, handle) {
  const dataDir = tmpDir('em-lpx-route-');
  writeProxySettings(dataDir, { enabled: true, key: DEV_KEY });
  const app = express();
  app.use('/api', express.json({ limit: '100kb' }));   // как в app.js: общий разборщик JSON стоит раньше
  app.use('/api/lisproxy', lisProxyRoutes(db, dataDir, { handle }));
  const server = await listen(app);
  return { url: 'http://127.0.0.1:' + server.address().port + '/api/lisproxy?key=' + DEV_KEY, close: () => new Promise((r) => server.close(r)) };
}

test('разбор упал после журнала — 200, строка журнала «ошибка разбора», тело сохранено', async () => {
  const db = freshDb();
  const app = await bareRouter(db, () => { throw new Error('сбой'); });
  try {
    const res = await post(app.url, RESULT);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'OK');
    const [row] = rows(db);
    assert.equal(row.status, 'rejected');
    assert.equal(row.detail, 'LIS Proxy: ошибка разбора — сбой');
    assert.equal(row.source_body, RESULT);
  } finally { await app.close(); db.close(); }
});

test('журнал не записался — 500 «Ошибка сервера», и только тогда', async () => {
  const db = freshDb();
  db.exec("CREATE TRIGGER lpx_boom BEFORE INSERT ON lab_device_messages BEGIN SELECT RAISE(ABORT, 'диск'); END;");
  let called = false;
  const app = await bareRouter(db, () => { called = true; return { type: 'text', body: 'OK' }; });
  try {
    const res = await post(app.url, RESULT);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } });
    assert.equal(called, false, 'без журнала разбора нет');
  } finally { await app.close(); db.close(); }
});

test('строка журнала пишется ДО разбора: разбор видит её «не завершён»', async () => {
  const db = freshDb();
  let seen = null;
  const app = await bareRouter(db, (d, { id }) => { seen = d.prepare('SELECT status, detail, source_body FROM lab_device_messages WHERE id = ?').get(id); return { type: 'text', body: 'OK' }; });
  try {
    await post(app.url, RESULT);
    assert.deepEqual(seen, { status: 'rejected', detail: JOURNAL_PENDING, source_body: RESULT });
  } finally { await app.close(); db.close(); }
});

test('ответ больше 1 КБ при Accept-Encoding: gzip — не сжат (Content-Encoding: identity), JSON читается', async () => {
  const db = freshDb();
  const big = {};
  for (let i = 0; i < 30; i++) big[String(i)] = { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'T' + i };
  const app = await startProxyApp(db);
  const bare = await bareRouter(db, () => ({ type: 'json', body: big }));
  try {
    // Через настоящее приложение: compress.js стоит первым и сжал бы такой JSON.
    const realApp = await post(app.url, ORDER);
    assert.equal(realApp.headers.get('content-encoding'), 'identity');
    const res = await post(bare.url, ORDER);
    assert.equal(res.headers.get('content-encoding'), 'identity');
    const text = await res.text();
    assert.ok(text.length > 1024);
    assert.deepEqual(JSON.parse(text), big);
  } finally { await app.close(); await bare.close(); db.close(); }
});

test('тело не формой (JSON) — тоже запрос с ключом: строка журнала и 200 {}', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    const res = await fetch(app.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"x":1}' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
    assert.equal(rows(db).length, 1);
  } finally { await app.close(); db.close(); }
});
```

- [ ] **Step 13: прогнать.** Run: `node --test server/routes/lisproxy.test.js server/lis/lisproxy-settings.test.js server/db/migrations/239.test.js`. Expected: PASS (7 + 5 + 2). Сторожа: `node --test server/app.test.js server/app.health.test.js server/app-test-hygiene.test.js server/db/migration-order.test.js server/db/schema-registry-conformance.test.js scripts/build-bundle.test.js server/lis/receive.test.js server/lis/ingest.test.js` → `ℹ fail 0`.

- [ ] **Step 14: коммит.**
```
git add -- server/db/migrations/239_lis_proxy.sql server/db/migrations/239.test.js server/lis/lisproxy-settings.js server/lis/lisproxy-settings.test.js server/lis/lisproxy.js server/lis/inbox.js server/routes/lisproxy.js server/routes/lisproxy.test.js server/app.js server/test-helpers/lisproxy-clinic.js server/test-helpers/lisproxy-fixtures.json
```
Тема: `LIS Proxy: вход /api/lisproxy — ключ, 404 как у неизвестного адреса, журнал первым, 200 на любой исход, ответ без сжатия; мигр. 239 (LIS_PROXY_V1)`.

---

## Task 3: Прибор LIS Proxy — кто он; свой порт и слушатели строк прокси не видят; «на связи» на каждом запросе (LIS_PROXY_V1)

**Files:**
- Modify:
  - `server/lis/discover.js` — запросы `ensureDevice` `:188`, `:252`, `:286-290`, `:298`; в конец — `ensureProxyDevice`;
  - `server/lis/index.js:305`;
  - `server/lis/lisproxy.js`;
  - `public/js/admin/i18n-strings.js` (три причины — сторож `server/i18n-server-messages.test.js` читает `reason:`).
- Create: `server/lis/lisproxy-device.test.js`

- [ ] **Step 1: падающий тест.** Create `server/lis/lisproxy-device.test.js`:
```js
// LIS_PROXY_V1 — прибор за LIS Proxy: кто он (имя + адрес, подпись при смене
// адреса), смена адреса не снимает подтверждения BS-200, свой порт и прокси
// не берут чужих строк, слушатели строк прокси не видят, «на связи» — на
// каждом запросе с ключом.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ensureDevice, ensureProxyDevice, MAX_PROXY_FOUND } from './discover.js';
import { startLisListeners, stopLisListeners, listenerStatus } from './index.js';
import { freshDb, addProxyDevice, bindPanel, startProxyApp, post, fixture, device, rows } from '../test-helpers/lisproxy-clinic.js';

test('новый прибор LIS Proxy — находка без модели; адрес без «::ffff:», подпись запомнены; host и sending_app пусты', () => {
  const db = freshDb();
  const r = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '::ffff:192.168.1.21' });
  assert.equal(r.reason, 'заведён по первому запросу LIS Proxy');
  const d = r.device;
  assert.deepEqual([d.name, d.profile, d.transport, d.host, d.port, d.enabled, d.discovered, d.added, d.via, d.proxy_name, d.proxy_label, d.proxy_ip, d.sending_app],
    ['bs200', '', 'mllp', '', null, 1, 1, 0, 'lisproxy', 'bs200', 'LAB-PC-1', '192.168.1.21', null]);
});

test('тот же адрес и то же имя (регистр не важен) — та же строка; новая подпись запоминается', () => {
  const db = freshDb();
  const id = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '10.0.0.5' }).device.id;
  const r = ensureProxyDevice(db, { name: 'BS200', label: 'LAB-PC-1b', ip: '10.0.0.5' });
  assert.equal(r.device.id, id);
  assert.equal(r.moved, null);
  assert.equal(r.device.proxy_label, 'LAB-PC-1b');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_devices').get().c, 1);
});

test('адрес лабораторного ПК сменился (DHCP): та же строка, адрес переписан; подтверждения BS-200 и эпоха кодов целы', () => {
  const db = freshDb();
  const id = addProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '192.168.1.21', profile: 'mindray-bs-200' });
  db.exec("INSERT INTO services (id, name, is_lab) VALUES (9, 'Биохимия', 1)");
  bindPanel(db, { id: 5, serviceId: 9, deviceId: id, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU']] });
  const r = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '192.168.1.35' });
  assert.equal(r.device.id, id);
  assert.deepEqual(r.moved, { from: '192.168.1.21', to: '192.168.1.35' });
  assert.equal(r.device.proxy_ip, '192.168.1.35');
  assert.equal(r.device.code_epoch, 0, 'эпоха не выросла');
  assert.deepEqual(db.prepare('SELECT device_code_confirmed_device_id AS d, device_code_confirmed_epoch AS e FROM lab_panel_analytes').get(), { d: id, e: 0 });
});

test('новый адрес и другая подпись, или две строки с тем же именем и подписью — новая находка, а не склейка', () => {
  const db = freshDb();
  const a = addProxyDevice(db, { name: 'bs200', label: 'LAB-PC-1', ip: '10.0.0.5' });
  const other = ensureProxyDevice(db, { name: 'bs200', label: 'LAB-PC-2', ip: '10.0.0.6' });
  assert.notEqual(other.device.id, a);
  assert.equal(other.device.name, 'bs200 (LAB-PC-2)', 'имя занято — с подписью');
  addProxyDevice(db, { name: 'bc780x', label: 'LABPC', ip: '10.0.0.7' });
  addProxyDevice(db, { name: 'bc780x', label: 'LABPC', ip: '10.0.0.8' });
  const third = ensureProxyDevice(db, { name: 'bc780x', label: 'LABPC', ip: '10.0.0.9' });
  assert.equal(third.moved, null);
  assert.equal(third.device.added, 0, 'двусмысленно — новая находка');
});

test('пустое имя — прибора нет; предел — 20 находок LIS Proxy, свой порт считает свои', () => {
  const db = freshDb();
  assert.deepEqual(ensureProxyDevice(db, { name: '  ', ip: '10.0.0.5' }), { device: null, moved: null, reason: 'LIS Proxy не прислал имя анализатора' });
  for (let i = 0; i < MAX_PROXY_FOUND; i++) ensureProxyDevice(db, { name: 'a' + i, ip: '10.0.0.5' });
  const over = ensureProxyDevice(db, { name: 'lishniy', ip: '10.0.0.5' });
  assert.equal(over.device, null);
  assert.match(over.reason, /предел найденных приборов LIS Proxy/);
  const mllp = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.77', port: 2575 });
  assert.ok(mllp.created, 'находки прокси не съедают предел своего порта');
});

test('свой порт не берёт строку LIS Proxy: MLLP «Mindray» не забирает прибор прокси с именем «Mindray» (шаг 2 — по имени)', () => {
  const db = freshDb();
  const pid = addProxyDevice(db, { name: 'Mindray', added: 0 });
  const r = ensureDevice(db, { sendingApp: 'Mindray', sendingFacility: 'BS-200E', peer: '10.0.0.9', port: 2575 });
  assert.ok(r.device && r.created && r.device.id !== pid);
  assert.deepEqual(db.prepare('SELECT host, proxy_ip FROM lab_devices WHERE id = ?').get(pid), { host: '', proxy_ip: '127.0.0.1' });
});

test('прибор прокси не берёт строку своего порта с тем же именем и адресом', () => {
  const db = freshDb();
  const own = ensureDevice(db, { sendingApp: 'bs200', peer: '127.0.0.1', port: 2575 }).device;
  const r = ensureProxyDevice(db, { name: 'bs200', ip: '127.0.0.1' });
  assert.notEqual(r.device.id, own.id);
  assert.equal(r.device.via, 'lisproxy');
});

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '0.0.0.0', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

test('слушатели пропускают строки LIS Proxy: ни порта, ни звонка', async () => {
  const db = freshDb();
  const lisPort = await freePort();
  const p1 = await freePort();
  const prev = process.env.LIS_PORT;
  process.env.LIS_PORT = String(lisPort);
  db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, dial, via, proxy_name, proxy_ip)
              VALUES ('p1', '', 'mllp', '', ?, 1, 1, 1, 0, 'lisproxy', 'p1', '127.0.0.1'),
                     ('p2', '', 'mllp', '127.0.0.1', ?, 1, 1, 1, 1, 'lisproxy', 'p2', '127.0.0.1')`).run(p1, p1);
  try {
    await startLisListeners(db, { log: () => {} });
    const st = listenerStatus();
    assert.ok(st.listening.includes(lisPort), 'порт LIS по умолчанию слушается');
    assert.ok(!st.listening.includes(p1), 'порт строки прокси не слушается');
    assert.deepEqual(st.dialing, [], 'строке прокси не звоним');
  } finally {
    await stopLisListeners();
    if (prev === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prev;
    db.close();
  }
});

test('«на связи» и прибор в журнале — на каждом запросе с ключом: и в лотке, и рабочий список, и мусор; с неверным ключом — нет', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    await post(app.url, fixture('results', 'bs200_patient_number_as_barcode'));
    await post(app.url, fixture('orders', 'cl_garbage_all'));
    await post(app.url, fixture('results', 'bc20_take_mode'));
    await post(app.base + '/api/lisproxy?key=WRONG', fixture('results', 'bc780_wbc'));
    for (const name of ['bs200', 'cl900i', 'bc20x']) {
      const d = device(db, name);
      assert.ok(d && d.last_seen_at, name + ' на связи');
    }
    assert.equal(device(db, 'bc780x'), undefined, 'неверный ключ прибор не заводит');
    assert.ok(rows(db).every((m) => m.device_id != null), 'у каждой строки журнала — прибор');
  } finally { await app.close(); db.close(); }
});
```
Run: `node --test server/lis/lisproxy-device.test.js`. Expected: FAIL (`ensureProxyDevice` нет).

- [ ] **Step 2: свой порт — только свои строки.** В `server/lis/discover.js` четыре правки.
  - (`:188`) найти `const byHost = db.prepare('SELECT * FROM lab_devices WHERE host = ? ORDER BY id').all(ip);`, заменить на:
```js
    const byHost = db.prepare('SELECT * FROM lab_devices WHERE host = ? AND via IS NULL ORDER BY id').all(ip);   // LIS_PROXY_V1 — строки LIS Proxy своему порту не видны
```
  - (`:252`) найти ``const hostless = db.prepare("SELECT * FROM lab_devices WHERE discovered = 1 AND (host IS NULL OR host = '') ORDER BY id").all();``, заменить на:
```js
    const hostless = db.prepare("SELECT * FROM lab_devices WHERE discovered = 1 AND (host IS NULL OR host = '') AND via IS NULL ORDER BY id").all();   // LIS_PROXY_V1
```
  - (`:286-290`) найти
```js
                                  AND COALESCE(port, ?) = ?
                                ORDER BY id`).all(DEFAULT_PORT, listenPort)
```
  заменить на
```js
                                  AND COALESCE(port, ?) = ?
                                  AND via IS NULL
                                ORDER BY id`).all(DEFAULT_PORT, listenPort)   // LIS_PROXY_V1 — via IS NULL
```
  - (`:298`) найти `const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE discovered = 1').get().c;`, заменить на:
```js
  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE discovered = 1 AND via IS NULL').get().c;   // LIS_PROXY_V1 — у LIS Proxy свой предел
```

- [ ] **Step 3: прибор LIS Proxy.** В конец `server/lis/discover.js` добавить:
```js

// ═══ LIS_PROXY_V1 — ПРИБОР ЗА LIS PROXY ═════════════════════════════════════
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 4.1, Р7, Р8.)
//
// LIS Proxy не называет модель и не шлёт HL7: в запросе только имя анализатора,
// как его записали в прокси (lisResult[name] / order[name]), подпись (-host,
// обычно имя лабораторного ПК) и адрес отправителя. Строка такого прибора —
// via = 'lisproxy'; имя, подпись и адрес — в proxy_name, proxy_label,
// proxy_ip. host и sending_app пусты: по host триггер мигр. 233 снимает
// подтверждения BS-200, по sending_app приём угадывает модель — а модель здесь
// выбирает только человек («Добавить»).
//
// Кто прибор:
//   1. строка LIS Proxy с тем же именем (без учёта регистра) и тем же адресом;
//   2. иначе — РОВНО ОДНА строка с тем же именем и той же подписью: адрес
//      лабораторного ПК сменился (DHCP) — proxy_ip переписывается, подтверждения
//      и эпоха кодов целы (триггер смотрит host и port);
//   3. иначе — новая находка (discovered = 1, added = 0, модель пустая): ждёт
//      «Добавить» с выбором модели. Два ПК с одинаковыми именем и подписью —
//      видимая лишняя строка, а не склейка двух приборов (как шаг 2 выше).
export const PROXY_VIA = 'lisproxy';
/** Предел находок LIS Proxy — свой, как MAX_DISCOVERED у своего порта. */
export const MAX_PROXY_FOUND = 20;

/**
 * @param {{name?:string, label?:string, ip?:string}} o
 * @returns {{device: object|null, moved: {from:string, to:string}|null, reason: string}}
 */
export function ensureProxyDevice(db, { name = '', label = '', ip = '' } = {}) {
  const key = appKey(name);
  const lab = String(label == null ? '' : label).trim();
  const addr = String(ip == null ? '' : ip).replace(/^::ffff:/, '').trim();
  if (!key) return { device: null, moved: null, reason: 'LIS Proxy не прислал имя анализатора' };
  const fresh = (id) => db.prepare('SELECT * FROM lab_devices WHERE id = ?').get(id);
  const rows = db.prepare('SELECT * FROM lab_devices WHERE via = ? ORDER BY id').all(PROXY_VIA)
    .filter((d) => appKey(d.proxy_name) === key);
  const here = rows.find((d) => String(d.proxy_ip == null ? '' : d.proxy_ip).trim() === addr);
  if (here) {
    if (lab && lab !== String(here.proxy_label == null ? '' : here.proxy_label)) {
      db.prepare('UPDATE lab_devices SET proxy_label = ? WHERE id = ?').run(lab, here.id);
    }
    return { device: fresh(here.id), moved: null, reason: 'по адресу и имени' };
  }
  const same = rows.filter((d) => appKey(d.proxy_label) === appKey(lab));
  if (same.length === 1) {
    const from = String(same[0].proxy_ip == null ? '' : same[0].proxy_ip);
    db.prepare('UPDATE lab_devices SET proxy_ip = ? WHERE id = ?').run(addr, same[0].id);
    return { device: fresh(same[0].id), moved: { from, to: addr }, reason: 'адрес сменился' };
  }
  const found = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE via = ? AND discovered = 1').get(PROXY_VIA).c;
  if (found >= MAX_PROXY_FOUND) return { device: null, moved: null, reason: 'достигнут предел найденных приборов LIS Proxy (' + MAX_PROXY_FOUND + ')' };
  const base = String(name).trim();
  const taken = db.prepare('SELECT COUNT(*) c FROM lab_devices WHERE name = ?').get(base).c > 0;
  const shown = taken ? base + ' (' + (lab || addr || '#' + (found + 1)) + ')' : base;
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, via, proxy_name, proxy_label, proxy_ip)
                         VALUES (?, '', 'mllp', '', NULL, 1, 1, 0, ?, ?, ?, ?)`)
    .run(shown, PROXY_VIA, base, lab || null, addr || null).lastInsertRowid;
  return { device: fresh(id), moved: null, reason: 'заведён по первому запросу LIS Proxy' };
}
```

- [ ] **Step 4: слушатели.** В `server/lis/index.js:305` найти:
```js
  const devices = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND transport = 'mllp'").all();
```
заменить на:
```js
  const devices = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND transport = 'mllp' AND via IS NULL").all();   // LIS_PROXY_V1 — у строки LIS Proxy нечего слушать и некому звонить
```

- [ ] **Step 5: прибор — на каждом запросе.** В `server/lis/lisproxy.js`:
  - строку `import { recordMessage } from './inbox.js';` заменить на:
```js
import { recordMessage, touchDevice } from './inbox.js';
import { ensureProxyDevice } from './discover.js';
```
  - функцию `handleProxyRequest` целиком заменить на:
```js
/**
 * Разобрать запрос, уже записанный в журнал строкой id. Задачи 5–8 плана
 * наполняют разбор; пока — прибор и ответ.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {} } = {}) {
  const b = obj(body);
  const method = methodOf(b);
  const who = method === 'apiResultSave' ? obj(b.lisResult) : obj(b.order);
  if (str(who.name).trim()) resolveDevice(db, id, { name: str(who.name), label: str(who.host), peer });
  return fallbackReply(method);
}

/** Прибор запроса: найти или завести (discover.js), записать в журнал, «на связи» — на каждом запросе. */
function resolveDevice(db, id, { name, label, peer }) {
  const r = ensureProxyDevice(db, { name, label, ip: peer });
  if (r.device) {
    db.prepare('UPDATE lab_device_messages SET device_id = ? WHERE id = ?').run(r.device.id, id);
    touchDevice(db, r.device.id);
  }
  return r;
}
const movedNote = (m) => (m ? '; адрес LIS Proxy сменился: ' + (m.from || '—') + ' → ' + (m.to || '—') : '');
```
(`movedNote` начнёт работать в задаче 5.)

- [ ] **Step 6: словарь причин.** `server/i18n-server-messages.test.js` требует статью у литерала после `reason:`. Сразу после `export const STRINGS = {` в `public/js/admin/i18n-strings.js` добавить:
```js
  // LIS_PROXY_V1 (2026-10-09) — причины прибора LIS Proxy (server/lis/discover.js ensureProxyDevice)
  "LIS Proxy не прислал имя анализатора": {"en":"LIS Proxy did not send the analyzer name","ru":"LIS Proxy не прислал имя анализатора","uz":"LIS Proxy analizator nomini yubormadi"},   // LIS_PROXY_V1
  "адрес сменился": {"en":"the address changed","ru":"адрес сменился","uz":"manzil o‘zgardi"},   // LIS_PROXY_V1
  "заведён по первому запросу LIS Proxy": {"en":"registered from the first LIS Proxy request","ru":"заведён по первому запросу LIS Proxy","uz":"LIS Proxy’ning birinchi so‘rovi bo‘yicha ro‘yxatga olindi"},   // LIS_PROXY_V1
```
(«по адресу и имени» в словаре уже есть.)

- [ ] **Step 7: прогнать.** Run:
  - `node --test server/lis/lisproxy-device.test.js server/routes/lisproxy.test.js` → PASS (9 + 7);
  - сторожа: `node --test server/lis/discover.test.js server/lis/index.test.js server/lis/dial.test.js server/lis/real-analyzers.e2e.test.js server/i18n-server-messages.test.js` и `node --experimental-vm-modules --test public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs` → `ℹ fail 0`.

- [ ] **Step 8: коммит.** `git add --` `server/lis/discover.js server/lis/index.js server/lis/lisproxy.js server/lis/lisproxy-device.test.js public/js/admin/i18n-strings.js`. Тема: `LIS Proxy: прибор — имя и адрес ПК, смена адреса не снимает подтверждения; свой порт и слушатели строк прокси не видят (LIS_PROXY_V1)`.

---

## Task 4: Форма → ORU^R01: экранирование, число и текст, мусор, номер пробирки (LIS_PROXY_V1)

**Files:**
- Modify: `server/lis/wire.js` — `export` у `trimZeros` (`:246`) и `isNoResult` (`:276`)
- Create: `server/lis/lisproxy-form.js`, `server/lis/lisproxy-form.test.js`

- [ ] **Step 1: падающий тест.** Create `server/lis/lisproxy-form.test.js`:
```js
// LIS_PROXY_V1 — форма LIS Proxy → ORU и ответ рабочего списка (чистые функции).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readResult, pickMessageSample, wireDecision } from './wire.js';
import { parseMessage, mshOf } from './hl7.js';
import { guessProfile } from './discover.js';
import {
  escapeHl7, proxyValue, proxyNorms, junkReason, normaliseProxyBarcode, buildOru, hl7Stamp,
  dottedDate, sexCode, biomaterialOf, worklistEntries, PROXY_APP, PROXY_NOT_TUBE,
} from './lisproxy-form.js';

test('escapeHl7: | ^ ~ \\ & — escape-последовательности, перевод строки — пробел', () => {
  assert.equal(escapeHl7('a|b^c~d\\e&f'), 'a\\F\\b\\S\\c\\R\\d\\E\\e\\T\\f');
  assert.equal(escapeHl7('x\r\ny\rz'), 'x y z');
  assert.equal(escapeHl7(null), '');
});

test('proxyValue: запятая → точка, %f BS-200 без хвостовых нулей, NM только у простого числа', () => {
  assert.deepEqual(proxyValue('5.100000'), { value: '5.1', type: 'NM' });
  assert.deepEqual(proxyValue('5.000000'), { value: '5', type: 'NM' });
  assert.deepEqual(proxyValue('5,1'), { value: '5.1', type: 'NM' });
  assert.deepEqual(proxyValue('0.50'), { value: '0.50', type: 'NM' }, 'гематология — как пришло');
  assert.deepEqual(proxyValue('132'), { value: '132', type: 'NM' });
  assert.deepEqual(proxyValue('-1.5'), { value: '-1.5', type: 'NM' });
  assert.deepEqual(proxyValue('<0.5'), { value: '<0.5', type: 'ST' });
  assert.deepEqual(proxyValue('1,2,3'), { value: '1,2,3', type: 'ST' });
  assert.deepEqual(proxyValue('CBC+DIFF'), { value: 'CBC+DIFF', type: 'ST' });
  assert.equal(proxyNorms('3.900000-6.100000'), '3.9-6.1');
  assert.equal(proxyNorms('4.00-10.00'), '4.00-10.00');
});

test('мусор: пустое и «*», служебные строки Mindray, код с пробелом и не число, «нет результата»; настоящее значение — нет', () => {
  assert.match(junkReason({ code: 'IS', res: '' }), /пустое значение/);
  assert.match(junkReason({ code: 'GLU', res: '***' }), /пустое значение/);
  assert.match(junkReason({ code: 'Take Mode', res: 'O' }), /служебная строка прибора «Take Mode»/);
  assert.match(junkReason({ code: 'Test Mode', res: 'CBC+DIFF' }), /служебная строка/);
  assert.match(junkReason({ code: 'is', res: '1' }), /служебная строка/);
  assert.match(junkReason({ code: 'Ref Group', res: 'General' }), /служебная строка/);
  assert.match(junkReason({ code: 'GLU', res: '-268435455.000000' }), /нет результата «-268435455.000000» \(GLU\)/);
  assert.match(junkReason({ code: 'GLU', res: '-100000000' }), /нет результата/);
  assert.equal(junkReason({ code: 'GLU', res: '5.1' }), null);
  assert.equal(junkReason({ code: 'Some Ratio', res: '1,5' }), null, 'код с пробелом и число — значение');
  assert.equal(junkReason({ code: '214', res: '28.4' }), null);
});

test('штрихкод: LAB- как есть, обрезка AutoLumo — только у AutoLumo, прочее — не номер пробирки с причиной', () => {
  assert.deepEqual(normaliseProxyBarcode(' lab-000123 '), { ok: true, barcode: 'LAB-000123', restored: false, shown: 'lab-000123' });
  assert.equal(normaliseProxyBarcode('LAB-1234567').barcode, 'LAB-1234567');
  assert.deepEqual(normaliseProxyBarcode('B-000777', { autolumo: true }), { ok: true, barcode: 'LAB-000777', restored: true, shown: 'B-000777' });
  assert.equal(normaliseProxyBarcode('-1234567', { autolumo: true }).barcode, 'LAB-1234567');
  const cut = normaliseProxyBarcode('B-000777');
  assert.equal(cut.ok, false);
  assert.match(cut.why, /обрезанную этикетку AutoLumo/);
  for (const [raw, re] of [
    ['900001', /номер пациента или места/], ['12345678', /номер пациента или места/], ['PATNUM9', /проверьте настройку штрихкода/],
    ['Therapy^^12', /BC-20\/BC-5300 путают поле/], ['6690-2^WBC^LN', /BC-20\/BC-5300/], ['', /\(пусто\) — анализатор не передал номер пробы/],
    ['LAB-123', /проверьте настройку штрихкода/], ['ORU^R01', /путают поле/], ['ALL', /проверьте настройку/],
  ]) {
    const r = normaliseProxyBarcode(raw, { autolumo: true });
    assert.equal(r.ok, false, raw);
    assert.ok(r.why.startsWith(PROXY_NOT_TUBE + ': ' + (raw || '(пусто)')), r.why);
    assert.match(r.why, re, raw);
  }
});

test('buildOru: провод forwarder, номер из OBR-3, код одним компонентом, модели по MSH-3 нет; экранирование не ломает поля', () => {
  const now = new Date(2026, 9, 9, 20, 21, 10);
  const raw = buildOru({ code: 'GLU', res: '5.100000', unit: 'mmol/L', norms: '3.900000-6.100000', flag: 'N', barcode: 'LAB-000123', controlId: '41', now });
  assert.equal(raw, [
    'MSH|^~\\&|LISPROXY|LabPC|||20261009202110||ORU^R01|41|P|2.3.1||||0||UNICODE',
    'PID|1',
    'OBR|1||LAB-000123',
    'OBX|1|NM|GLU||5.1|mmol/L|3.9-6.1|N|||F',
  ].join('\r'));
  assert.doesNotThrow(() => parseMessage(raw));
  const head = mshOf(raw);
  assert.deepEqual(wireDecision({ profile: null, facility: head.facility, app: head.app }), { wire: 'forwarder', conflict: false });
  assert.equal(guessProfile({ app: PROXY_APP, facility: head.facility }), null);
  const { obrs, observations } = readResult(raw, 'forwarder');
  assert.equal(pickMessageSample(obrs, 'forwarder').value, 'LAB-000123');
  assert.deepEqual([observations[0].code, observations[0].value, observations[0].valueType, observations[0].unit, observations[0].range, observations[0].abnormal, observations[0].status],
    ['GLU', '5.1', 'NM', 'mmol/L', '3.9-6.1', 'N', 'F']);
  const odd = buildOru({ code: 'A|B', res: 'x^y', unit: '10^9/L', barcode: '', now });
  const o = readResult(odd, 'forwarder').observations[0];
  assert.deepEqual([o.code, o.value, o.unit, o.status], ['A\\F\\B', 'x\\S\\y', '10\\S\\9/L', 'F'], 'поля на месте, OBX-11 — F');
  assert.equal(pickMessageSample(readResult(odd, 'forwarder').obrs, 'forwarder').sampleId, '', 'не номер пробирки — OBR-3 пуст');
  assert.equal(hl7Stamp(now), '20261009202110');
});

test('рабочий список: dd.MM.yyyy, пол 1/0/пусто, биоматериал, все ключи в каждой записи', () => {
  assert.equal(dottedDate('1990-02-03'), '03.02.1990');
  assert.equal(dottedDate('1990-02-03T00:00:00Z'), '03.02.1990');
  assert.equal(dottedDate('03.02.1990'), '03.02.1990');
  assert.equal(dottedDate(null), '');
  assert.equal(dottedDate('вчера'), '');
  assert.deepEqual([sexCode('male'), sexCode('female'), sexCode('other'), sexCode(undefined)], ['1', '0', '', '']);
  assert.deepEqual([biomaterialOf('Моча'), biomaterialOf('Плазма'), biomaterialOf('Сыворотка'), biomaterialOf('Кровь'), biomaterialOf(null)],
    ['urine', 'plasma', 'serum', 'serum', 'serum']);
  assert.deepEqual(worklistEntries({ barcode: 'LAB-000123', codes: ['GLU', 'UREA'], patient: { date_of_birth: '1990-02-03', gender: 'male' }, specimen: 'Сыворотка' }), {
    0: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' },
    1: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'UREA' },
  });
  assert.deepEqual(worklistEntries({ barcode: 'LAB-000001', codes: [] }), {});
});
```
Run: `node --test server/lis/lisproxy-form.test.js`. Expected: FAIL (модуля нет).

- [ ] **Step 2: два `export` в `wire.js` (поведение не меняется).**
  - `function trimZeros(v) {` (`:246`) → `export function trimZeros(v) {   // LIS_PROXY_V1 — export: значение BS-200 через LIS Proxy (lisproxy-form.js)`;
  - `function isNoResult(v) {` (`:276`) → `export function isNoResult(v) {   // LIS_PROXY_V1 — export: «нет результата» от LIS Proxy — справка (lisproxy-form.js)`.

- [ ] **Step 3: модуль формы.** Create `server/lis/lisproxy-form.js`:
```js
// LIS_PROXY_V1 — форма LIS Proxy → то, что понимает приём Easy-Med. ЧИСТЫЙ
// модуль: ни базы, ни сети (docs/specs/2026-10-09-lis-proxy-endpoint-design.md,
// разделы 3.2–3.5 и 5).
//
// Прокси шлёт одно значение в запросе (apiResultSave). Приём Easy-Med — HL7 до
// самого низа: сырое сообщение перечитывают серия, «Привязать», «Поле
// анализатора». Поэтому значение превращается в минимальный ORU^R01 и идёт тем
// же входом, что у своего порта (receive.js), — правила владельца не дублируются.
import { decimalPoint, trimZeros, isNoResult, FORWARDER_FACILITY } from './wire.js';

/** MSH-3 синтетического сообщения: постоянное. Имя анализатора в прокси — свободный текст, а модель по MSH-3 угадывает приём (discover.js guessProfile). */
export const PROXY_APP = 'LISPROXY';
/** Начало журнала у строки, которая не результат и не беда: мусор прибора, лишний показатель гематологии. Такие строки разрешены сразу и не в ленте (rpc/lis.js lisRecent). */
export const PROXY_QUIET_PREFIX = 'LIS Proxy, справка: ';
/** Начало причины «не номер пробирки» (лоток; ingest.js — та же стена у строк LIS Proxy). */
export const PROXY_NOT_TUBE = 'LIS Proxy прислал не штрихкод пробирки';
/** Служебные строки Mindray, которые прокси шлёт как значения (BC-20/BC-5300: Take Mode, Test Mode; BC-780: IS). Сравнение — без учёта регистра. */
export const PROXY_SERVICE_CODES = Object.freeze(['TAKE MODE', 'TEST MODE', 'BLOOD MODE', 'REF GROUP', 'REMARK', 'AGE', 'IS']);

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const SIX_DECIMALS = /^-?\d+\.\d{6}$/;
const t = (v) => String(v == null ? '' : v).trim();

/** Разделители HL7 в поле — escape-последовательности; перевод строки (граница сегмента) — пробел. */
export function escapeHl7(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/&/g, '\\T\\')
    .replace(/~/g, '\\R\\')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Значение и его тип (OBX-2). Одна десятичная запятая без точки — точка
 * («5,1» → «5.1», ПК с русскими настройками); число ровно с шестью знаками после
 * точки (%f программы BS-200: «5.100000») — без хвостовых нулей, как делает с
 * BS-200 свой порт (wire.js trimZeros); NM — только простое число.
 */
export function proxyValue(res) {
  let v = decimalPoint(t(res));
  if (SIX_DECIMALS.test(v)) v = trimZeros(v);
  return { value: v, type: PLAIN_NUMBER.test(v) ? 'NM' : 'ST' };
}

/** Норма прибора: числа с шестью знаками — без хвостовых нулей («3.900000-6.100000» → «3.9-6.1»). */
export function proxyNorms(norms) {
  return t(norms).replace(/-?\d+\.\d{6}(?!\d)/g, (n) => trimZeros(n));
}

/**
 * Причина «это не результат» или null. Такая строка журнала разрешается сразу:
 * без лотка, без серии (раздел 3.4).
 */
export function junkReason({ code, res } = {}) {
  const c = t(code);
  const v = t(res);
  if (!v || /^\*+$/.test(v)) return 'пустое значение' + (c ? ' («' + c + '»)' : '');
  if (PROXY_SERVICE_CODES.includes(c.toUpperCase())) return 'служебная строка прибора «' + c + '»';
  if (/\s/.test(c) && !PLAIN_NUMBER.test(decimalPoint(v))) return 'служебная строка прибора «' + c + '»';
  if (isNoResult(v)) return 'прибор: нет результата «' + v + '»' + (c ? ' (' + c + ')' : '');
  return null;
}

const LAB_LABEL = /^LAB-(\d{6,})$/i;
// AutoLumo (тип AsServerAutoLumoA1860ASTM) отдаёт только последние 8 знаков
// номера: «LAB-000777» → «B-000777», «LAB-1234567» → «-1234567».
const AUTOLUMO_CUT = [/^B-(\d{6})$/i, /^-(\d{7})$/];

/**
 * Номер пробирки из поля barcode прокси (раздел 3.5).
 * @param {string} raw
 * @param {{autolumo?: boolean}} [o]  модель строки прибора — AutoLumo A1000
 * @returns {{ok:true, barcode:string, restored:boolean, shown:string} | {ok:false, barcode:'', restored:false, shown:string, why:string}}
 */
export function normaliseProxyBarcode(raw, { autolumo = false } = {}) {
  const s = t(raw);
  const lab = LAB_LABEL.exec(s);
  if (lab) return { ok: true, barcode: 'LAB-' + lab[1], restored: false, shown: s };
  const cut = AUTOLUMO_CUT.map((re) => re.exec(s)).find(Boolean);
  if (cut && autolumo) return { ok: true, barcode: 'LAB-' + cut[1], restored: true, shown: s };
  return { ok: false, barcode: '', restored: false, shown: s, why: notTubeReason(s, !!cut) };
}

function notTubeReason(s, looksCut) {
  const head = PROXY_NOT_TUBE + ': ' + (s || '(пусто)');
  if (!s) return head + ' — анализатор не передал номер пробы';
  if (s.includes('^')) return head + ' — проверьте тип анализатора в LIS Proxy (BC-20/BC-5300 путают поле)';
  if (/^\d+$/.test(s)) {
    return head + ' — похоже на номер пациента или места, а не пробирки: на анализаторе сканируйте этикетку LAB- в поле штрихкода,'
      + ' номер пациента не заполняйте; пробу привяжите кнопкой «Привязать»';
  }
  if (looksCut) return head + ' — похоже на обрезанную этикетку AutoLumo: если это AutoLumo A1000, выберите эту модель у прибора в «Анализаторах»';
  return head + ' — проверьте настройку штрихкода на анализаторе и тип анализатора в LIS Proxy; если это проба вашего заказа — нажмите «Привязать»';
}

const pad = (n) => String(n).padStart(2, '0');
/** MSH-7: местное время ПК — как у ответа прибору (hl7.js). */
export function hl7Stamp(d = new Date()) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/**
 * Одно значение — одно ORU^R01 провода forwarder (wire.js: MSH-4 = LabPC; номер
 * — OBR-3, код — OBX-3, значение — OBX-5 целиком). barcode — уже нормализованный
 * номер «LAB-…» или '' (не номер пробирки). Код — одним компонентом: сравнение
 * идёт по компоненту 1 или 2 (match.js), а текст лотка показывает OBX-3 целиком.
 */
export function buildOru({ code = '', res = '', unit = '', norms = '', flag = '', barcode = '', controlId = '1', now = new Date() } = {}) {
  const v = proxyValue(res);
  return [
    'MSH|^~\\&|' + PROXY_APP + '|' + FORWARDER_FACILITY + '|||' + hl7Stamp(now) + '||ORU^R01|' + escapeHl7(controlId) + '|P|2.3.1||||0||UNICODE',
    'PID|1',
    'OBR|1||' + escapeHl7(t(barcode)),
    'OBX|1|' + v.type + '|' + escapeHl7(t(code)) + '||' + escapeHl7(v.value) + '|' + escapeHl7(t(unit)) + '|' + escapeHl7(proxyNorms(norms))
      + '|' + escapeHl7(t(flag)) + '|||F',
  ].join('\r');
}

/** Дата рождения для прокси — только dd.MM.yyyy (другие виды прокси портит); нет даты — ''. */
export function dottedDate(v) {
  const s = t(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return iso[3] + '.' + iso[2] + '.' + iso[1];
  return /^\d{2}\.\d{2}\.\d{4}$/.test(s) ? s : '';
}
/** Пол для прокси: «1» → M, «0» → F, прочее — пусто. */
export function sexCode(gender) { return gender === 'male' ? '1' : gender === 'female' ? '0' : ''; }
/** Биоматериал BS-200: serum / plasma / urine — по полю «Биоматериал» услуги; иначе сыворотка. */
export function biomaterialOf(specimen) {
  const s = t(specimen).toLowerCase();
  if (/моч|urine/.test(s)) return 'urine';
  if (/плазм|plasma/.test(s)) return 'plasma';
  return 'serum';
}

/**
 * Ответ apiOrderGet: {"0": {...}, "1": {...}} — по записи на код; каждый ключ в
 * каждой записи обязателен (иначе прокси ничего не шлёт анализатору). Имён нет
 * (решение владельца 2): clientId — номер пробирки.
 */
export function worklistEntries({ barcode, codes = [], patient = {}, specimen = '' } = {}) {
  const out = {};
  codes.forEach((code, i) => {
    out[String(i)] = {
      clientId: barcode,
      surname: '',
      name: '',
      date_birth: dottedDate(patient && patient.date_of_birth),
      sex: sexCode(patient && patient.gender),
      biomaterial_code: biomaterialOf(specimen),
      code,
    };
  });
  return out;
}
```

- [ ] **Step 4: прогнать.** Run: `node --test server/lis/lisproxy-form.test.js server/lis/wire.test.js server/lis/sample.test.js`. Expected: `ℹ fail 0` (6 новых).

- [ ] **Step 5: коммит.** `git add --` `server/lis/wire.js server/lis/lisproxy-form.js server/lis/lisproxy-form.test.js`. Тема: `LIS Proxy: форма → ORU^R01 — экранирование, число и текст, мусор прибора, номер пробирки (LIS_PROXY_V1)`.

---

## Task 5: Результат через прежний приём — одна строка журнала, голые цифры не ищут заказ, мусор — справка (LIS_PROXY_V1)

**Files:**
- Modify:
  - `server/lis/inbox.js` (`recordMessage` — `id`);
  - `server/lis/receive.js` (`:105`, `:118`, `:136`, `:150`);
  - `server/lis/ingest.js` (импорт ~35, `record` `:924-928`, `device` `:941`, стена перед `pick.foreign` `:1011`);
  - `server/lis/lisproxy.js`;
  - `server/services/rpc/lis.js` (`lisRecent` `:89-112`, импорт ~19).
- Create: `server/lis/lisproxy-results.test.js`

- [ ] **Step 1: падающий тест.** Create `server/lis/lisproxy-results.test.js`:
```js
// LIS_PROXY_V1 — результат через LIS Proxy (apiResultSave): одна строка журнала
// на запрос, прежний приём, номер — только этикетка, мусор — справка,
// восстановление обрезанного номера AutoLumo, находка и выключенный прибор.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestMessage } from './ingest.js';
import { buildOru, PROXY_QUIET_PREFIX, PROXY_NOT_TUBE } from './lisproxy-form.js';
import { journalProxyRequest, handleProxyRequest } from './lisproxy.js';
import { lisRecent, lisMessageAttach } from '../services/rpc/lis.js';
import {
  freshDb, seedLisProxyClinic, addProxyDevice, startProxyApp, post, fixture, rows, lastRow, tray, blank,
} from '../test-helpers/lisproxy-clinic.js';

const LAB = { role: 'lab' };
const order = (db, id) => db.prepare('SELECT status FROM visit_services WHERE id = ?').get(id).status;

async function withClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db);
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('BS-200, LAB-000123, GLU — 200 «OK»; одна строка журнала (тело как пришло, сырое — ORU), 5.1 в бланке, заказ «результаты внесены», не выдан', async () => {
  await withClinic(async (db, app) => {
    const body = fixture('results', 'bs200_glu');
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'OK');
    assert.equal(rows(db).length, 1, 'одна строка на запрос');
    const m = lastRow(db);
    assert.equal(m.source_body, body);
    assert.ok(m.raw.startsWith('MSH|^~\\&|LISPROXY|LabPC|'), m.raw);
    assert.deepEqual([m.status, m.device_id, m.visit_service_id, m.sample_id, m.kind], ['applied', 1, 123, 'LAB-000123', 'result']);
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    assert.equal(order(db, 123), 'resulted');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_results WHERE verified_at IS NOT NULL OR verified_by IS NOT NULL').get().c, 0, 'автовыдачи нет');
  });
});

test('голые цифры — никогда не номер заказа: «900001» при открытом свежем заказе № 900001 другого пациента — лоток, бланк не тронут', async () => {
  await withClinic(async (db, app) => {
    assert.equal((await post(app.url, fixture('results', 'bs200_bare_digits'))).status, 200);
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['unmatched', null, '900001']);
    assert.ok(m.detail.startsWith(PROXY_NOT_TUBE + ': 900001 — похоже на номер пациента'), m.detail);
    assert.ok(m.raw.includes('\rOBR|1||\r'), 'в сыром номера нет');
    assert.deepEqual(blank(db, 900001), {});
    assert.equal(order(db, 900001), 'queued');
    for (const id of ['bs200_patient_number_as_barcode', 'lumo_numeric_id']) {
      await post(app.url, fixture('results', id));
      assert.equal(lastRow(db).status, 'unmatched', id);
      assert.equal(lastRow(db).visit_service_id, null, id);
    }
    assert.equal(tray(db).length, 3);
  });
});

test('«Привязать» строку с чужим номером к заказу № 123 — номер назвал человек: значение в бланке', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_bare_digits'));
    const r = lisMessageAttach(db, { id: lastRow(db).id, visit_service_id: 123 }, LAB);
    assert.equal(r.status, 'applied');
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
  });
});

test('стена приёма: прибор LIS Proxy и ORU с голыми цифрами в OBR-3 — заказ не ищется (кроме номера от человека)', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const raw = buildOru({ code: 'GLU', res: '5.1', barcode: '900001' });
  ingestMessage(db, raw, '127.0.0.1', 1);
  const m = lastRow(db);
  assert.deepEqual([m.status, m.visit_service_id], ['unmatched', null]);
  assert.ok(m.detail.startsWith(PROXY_NOT_TUBE + ': 900001'), m.detail);
  assert.deepEqual(blank(db, 900001), {});
  db.close();
});

test('BC-20/BC-5300 путают поле: «Therapy^^12», «6690-2^WBC^LN», пусто — лоток с причиной о прокси (номер проверяется раньше «Добавить»)', async () => {
  await withClinic(async (db, app) => {
    for (const [id, re] of [['bc20_pv1_dept_as_barcode', /Therapy\^\^12 — проверьте тип анализатора в LIS Proxy \(BC-20\/BC-5300 путают поле\)/],
      ['bc20_loinc_as_barcode', /6690-2\^WBC\^LN/], ['bc20_empty_barcode', /\(пусто\) — анализатор не передал номер пробы/]]) {
      assert.equal((await post(app.url, fixture('results', id))).status, 200);
      const m = lastRow(db);
      assert.equal(m.status, 'unmatched', id);
      assert.match(m.detail, re, id);
    }
  });
});

test('мусор (IS пусто, Take Mode, Test Mode, «нет результата») — строка журнала разрешена сразу: без лотка, без ленты, сырое пусто', async () => {
  await withClinic(async (db, app) => {
    for (const id of ['bc780_junk_IS_empty', 'bc20_take_mode', 'bc20_test_mode']) {
      assert.equal(await (await post(app.url, fixture('results', id))).text(), 'OK', id);
      const m = lastRow(db);
      assert.ok(m.detail.startsWith(PROXY_QUIET_PREFIX), m.detail);
      assert.ok(m.resolved_at, id + ' разрешена');
      assert.equal(m.raw, '');
    }
    await post(app.url, fixture('results', 'bs200_glu').replace('5.100000', '-268435455.000000'));
    assert.match(lastRow(db).detail, /нет результата «-268435455.000000» \(GLU\)/);
    assert.deepEqual(tray(db), []);
    assert.deepEqual(lisRecent(db, { limit: 50 }, LAB), [], 'в ленте «Последние результаты» их нет');
    assert.deepEqual(blank(db, 123), {});
  });
});

test('AutoLumo: «B-000777» — восстановлен до LAB-000777, 28.4 в строке кода 214; у BS-200 тот же номер — в лоток', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'lumo_truncated_barcode'));
    const m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id, m.sample_id], ['applied', 777, 'LAB-000777']);
    assert.deepEqual(blank(db, 777), { 'Витамин B12': '28.4' });
    await post(app.url, fixture('results', 'bs200_glu').replace('LAB-000123', 'B-000777'));
    assert.match(lastRow(db).detail, /похоже на обрезанную этикетку AutoLumo/);
  });
});

test('находка (не добавлена) — N2: в бланк не пишет, заказ назван; выключенный прибор — в лоток с причиной', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_glu').replace('bs200', 'bs200new'));
    let m = lastRow(db);
    assert.deepEqual([m.status, m.visit_service_id], ['unmatched', 123]);
    assert.match(m.detail, /прибор ещё не добавлен/);
    db.prepare('UPDATE lab_devices SET enabled = 0 WHERE id = 1').run();
    await post(app.url, fixture('results', 'bs200_glu'));
    m = lastRow(db);
    assert.equal(m.status, 'unmatched');
    assert.match(m.detail, /прибор выключен в «Анализаторах»/);
    assert.deepEqual(blank(db, 123), {});
  });
});

test('запись сорвалась внутри приёма — 200 «OK», та же строка «rejected» с причиной, тело сохранено', async () => {
  await withClinic(async (db, app) => {
    db.exec("CREATE TRIGGER lpx_no_results BEFORE INSERT ON lab_results BEGIN SELECT RAISE(ABORT, 'диск полон'); END;");
    const body = fixture('results', 'bs200_glu');
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.equal(rows(db).length, 1);
    const m = lastRow(db);
    assert.equal(m.status, 'rejected');
    assert.match(m.detail, /ошибка записи: диск полон/);
    assert.equal(m.source_body, body);
  });
});

test('значение: «5,1» — число 5.1 (запятая — точка), «<0.5» — текст', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_glu').replace('5.100000', '5%2C1'));
    assert.deepEqual(db.prepare('SELECT value, numeric_value FROM lab_results WHERE visit_service_id = 123').get(), { value: '5.1', numeric_value: 5.1 });
    await post(app.url, fixture('results', 'lumo_truncated_barcode').replace('28.4', '%3C0.5'));
    assert.deepEqual(db.prepare('SELECT value, numeric_value FROM lab_results WHERE visit_service_id = 777').get(), { value: '<0.5', numeric_value: null });
  });
});

test('адрес LIS Proxy сменился — та же строка прибора, в журнале строки — откуда и куда', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const body = { method: 'apiResultSave', lisResult: { name: 'bs200', host: 'LAB-PC-1', barcode: 'LAB-000123', code: 'GLU', R: { res: '5.1', unit: '', norms: '', flag: '' } } };
  const id = journalProxyRequest(db, { peer: '192.168.1.35', body: 'x', method: 'apiResultSave' });
  assert.deepEqual(handleProxyRequest(db, { id, peer: '192.168.1.35', body }), { type: 'text', body: 'OK' });
  const m = lastRow(db);
  assert.equal(m.device_id, 1);
  assert.equal(m.status, 'applied');
  assert.match(m.detail, /адрес LIS Proxy сменился: 127\.0\.0\.1 → 192\.168\.1\.35/);
  db.close();
});

test('прибор не заведён (предел находок) — лоток «прибор не заведён», в приём не идёт', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  for (let i = 0; i < 20; i++) addProxyDevice(db, { name: 'f' + i, added: 0 });
  const body = { method: 'apiResultSave', lisResult: { name: 'newcomer', host: '', barcode: 'LAB-000555', code: 'WBC', R: { res: '4.63' } } };
  const id = journalProxyRequest(db, { peer: '127.0.0.1', body: 'x', method: 'apiResultSave' });
  handleProxyRequest(db, { id, peer: '127.0.0.1', body });
  const m = lastRow(db);
  assert.deepEqual([m.status, m.device_id, m.visit_service_id], ['unmatched', null, null]);
  assert.match(m.detail, /^LIS Proxy: прибор не заведён — достигнут предел/);
  assert.deepEqual(blank(db, 555), {});
  db.close();
});
```
Run: `node --test server/lis/lisproxy-results.test.js`. Expected: FAIL (разбора результата ещё нет).

- [ ] **Step 2: `recordMessage` дописывает готовую строку.** В `server/lis/inbox.js` в `recordMessage`:
  - в список параметров добавить первым `id = null, `;
  - первой строкой тела (до `return db.prepare(\`INSERT …`) вставить:
```js
  // LIS_PROXY_V1 — id: строка журнала уже записана (вход LIS Proxy пишет запрос
  // ДО разбора — server/lis/lisproxy.js); приём дописывает ЕЁ, а не заводит
  // вторую. source_body (тело запроса как пришло) после вставки не меняется.
  if (id != null) {
    const r = db.prepare(`UPDATE lab_device_messages SET device_id = ?, peer = ?, raw = ?, sample_id = ?, visit_service_id = ?, status = ?, detail = ?, kind = ?,
                            resolved_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') END, disputes = ? WHERE id = ?`)
      .run(deviceId, peer, String(raw == null ? '' : raw), sampleId, visitServiceId, status, detail, kind, resolved ? 1 : 0, disputes, id);
    if (r.changes !== 1) throw new Error('строка журнала № ' + id + ' не найдена');
    return id;
  }
```

- [ ] **Step 3: `receiveMessage` передаёт строку журнала.** В `server/lis/receive.js`:
  - (`:105`) `export function receiveMessage(db, text, { peer = '', deviceId = null } = {}) {` → `export function receiveMessage(db, text, { peer = '', deviceId = null, journalId = null } = {}) {   // LIS_PROXY_V1 — journalId: строка журнала LIS Proxy, записанная до разбора`;
  - (`:118` и `:136`) в обоих объектах `recordMessage(db, {` первой строкой добавить `      id: journalId,   // LIS_PROXY_V1`;
  - (`:150`) `const code = ingestMessage(db, text, peer, deviceId);` → `const code = ingestMessage(db, text, peer, deviceId, journalId != null ? { journalId } : {});   // LIS_PROXY_V1`.

- [ ] **Step 4: приём — строка журнала, прибор прокси, стена.** В `server/lis/ingest.js`:
  - после `import { getProfile } from './profiles/index.js';` добавить:
```js
import { PROXY_NOT_TUBE } from './lisproxy-form.js';   // LIS_PROXY_V1
```
  - (`:924-928`) найти
```js
  const record = (o) => {
    const id = recordMessage(db, manual ? { ...o, detail: o.detail ? o.detail + '; ' + MANUAL : MANUAL } : o);
```
  заменить на
```js
  const record = (o) => {
    const row = manual ? { ...o, detail: o.detail ? o.detail + '; ' + MANUAL : MANUAL } : o;
    // LIS_PROXY_V1 — запрос LIS Proxy уже в журнале (записан до разбора): приём дописывает ту же строку.
    const id = recordMessage(db, opts.journalId != null ? { ...row, id: opts.journalId } : row);
```
  - (`:941`) найти `  const device = deviceId ? db.prepare('SELECT profile, added FROM lab_devices WHERE id = ?').get(deviceId) : null;`, заменить на:
```js
  const device = deviceId ? db.prepare('SELECT profile, added, via FROM lab_devices WHERE id = ?').get(deviceId) : null;   // via: LIS_PROXY_V1
  // LIS_PROXY_V1 — прибор за LIS Proxy (мигр. 239): прокси шлёт по значению в запросе, номер — только этикетка.
  const proxy = !!(device && device.via === 'lisproxy');
```
  - (перед `:1011`) найти
```js
  // LIS_REAL_ANALYZERS_V1 (ревью R1, пп. 2 и 8) — в поле номера не этикетка
  // Easy-Med и не голые цифры («2^15», «QC1», «lab_2», «LAB-123»): номера нет.
```
  и вставить ПЕРЕД ним:
```js
  // LIS_PROXY_V1 (решение владельца 2026-10-09, п. 3) — у прибора за LIS Proxy номер
  // пробы — только этикетка LAB-: тип BS-200 прокси кладёт в поле штрихкода номер
  // пациента (PID-2), и правило голых цифр ниже заполнило бы бланк ДРУГОГО
  // пациента. Вход прокси (lisproxy.js) такое сюда не пускает; это стена на
  // случай любого другого пути. Номер, названный человеком («Привязать»), — как прежде.
  if (proxy && !manual && !pick.lab) {
    record({ ...base, status: 'unmatched', detail: PROXY_NOT_TUBE + ': ' + (pick.sampleId || '(пусто)') + ' — заказ не ищется; пробу привяжите кнопкой «Привязать»' });
    return 'AA';
  }
```

- [ ] **Step 5: разбор результата.** В `server/lis/lisproxy.js`:
  - импорты заменить на:
```js
import { recordMessage, touchDevice } from './inbox.js';
import { receiveMessage } from './receive.js';
import { ensureProxyDevice } from './discover.js';
import { buildOru, junkReason, normaliseProxyBarcode, PROXY_QUIET_PREFIX } from './lisproxy-form.js';
```
  - после `JOURNAL_PENDING` добавить:
```js
/** Модель, у которой прокси обрезает номер до 8 знаков (Р10). */
export const AUTOLUMO = 'autobio-autolumo-a1000';
```
  - `handleProxyRequest` заменить на:
```js
/**
 * Разобрать запрос, уже записанный в журнал строкой id. Задачи 7–8 плана
 * наполняют разбор запросов; пока у них — прибор и ответ.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {}, now = new Date() } = {}) {
  const b = obj(body);
  const method = methodOf(b);
  if (method === 'apiResultSave') return handleResult(db, { id, peer, body: b, now });
  const who = obj(b.order);
  if (str(who.name).trim()) resolveDevice(db, id, { name: str(who.name), label: str(who.host), peer });
  return fallbackReply(method);
}
```
  - в конец файла добавить:
```js

/** apiResultSave — одно значение (раздел 3). */
function handleResult(db, { id, peer, body, now }) {
  const r = obj(body.lisResult);
  const R = obj(r.R);
  const f = { code: str(r.code), res: str(R.res), unit: str(R.unit), norms: str(R.norms), flag: str(R.flag) };
  const sent = str(r.barcode).trim();
  const who = resolveDevice(db, id, { name: str(r.name), label: str(r.host), peer });
  const deviceId = who.device ? who.device.id : null;
  const note = movedNote(who.moved);

  // Мусор прибора: строка разрешена сразу — без лотка, без серии, не в ленте (Р13).
  const junk = junkReason(f);
  if (junk) {
    recordMessage(db, { id, deviceId, peer, raw: '', sampleId: sent, status: 'unmatched', detail: PROXY_QUIET_PREFIX + junk + note, resolved: true });
    return OK;
  }
  // Прибора нет (имя пустое, предел находок) — в лоток, в приём не идёт (Р12):
  // приём без прибора пишет в панель с кодами производителя.
  if (!who.device) {
    recordMessage(db, { id, deviceId: null, peer, raw: buildOru({ ...f, controlId: String(id), now }), sampleId: sent, status: 'unmatched',
      detail: 'LIS Proxy: прибор не заведён — ' + who.reason + ' — значения не записаны' });
    return OK;
  }
  // Не номер пробирки — в лоток с причиной; заказ не ищется (решение владельца 3, Р11).
  const bc = normaliseProxyBarcode(sent, { autolumo: who.device.profile === AUTOLUMO });
  const raw = buildOru({ ...f, barcode: bc.ok ? bc.barcode : '', controlId: String(id), now });
  if (!bc.ok) {
    recordMessage(db, { id, deviceId, peer, raw, sampleId: sent, status: 'unmatched', detail: bc.why + note });
    return OK;
  }
  // Прежний вход своего порта: «прибор выключен», N2, ворота, D4/D6/D7, серия.
  receiveMessage(db, raw, { peer, deviceId, journalId: id });
  if (note) {
    db.prepare("UPDATE lab_device_messages SET detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || ? END WHERE id = ?")
      .run(note.slice(2), note, id);
  }
  return OK;
}
```

- [ ] **Step 6: лента без справок.** В `server/services/rpc/lis.js`:
  - отдельной строкой после `import { hasAnyRole } from '../roles.js';   // ЭФФЕКТИВНЫЕ роли, …` добавить:
```js
import { PROXY_QUIET_PREFIX } from '../../lis/lisproxy-form.js';   // LIS_PROXY_V1
```
  - в `lisRecent` найти
```js
     WHERE m.kind = 'result'   -- LIS_REAL_ANALYZERS_V1_SERVICE: утренний контроль (тридцать тестов на два уровня) не вытесняет пробы пациентов
     ORDER BY m.id DESC
     LIMIT ?`).all(limit);
```
  заменить на
```js
     WHERE m.kind = 'result'   -- LIS_REAL_ANALYZERS_V1_SERVICE: утренний контроль (тридцать тестов на два уровня) не вытесняет пробы пациентов
       AND substr(COALESCE(m.detail, ''), 1, ?) <> ?   -- LIS_PROXY_V1 (Р13): справка LIS Proxy (мусор прибора, лишний показатель) — не в ленте
     ORDER BY m.id DESC
     LIMIT ?`).all(PROXY_QUIET_PREFIX.length, PROXY_QUIET_PREFIX, limit);
```

- [ ] **Step 7: прогнать.** Run:
  - `node --test server/lis/lisproxy-results.test.js` → PASS (12);
  - сторожа: `node --test $(ls server/lis/*.test.js) server/services/rpc/lis.test.js server/routes/lisproxy.test.js` → `ℹ fail 0` (все пины `ingest.test.js` зелёные).

- [ ] **Step 8: коммит.** `git add --` `server/lis/inbox.js server/lis/receive.js server/lis/ingest.js server/lis/lisproxy.js server/services/rpc/lis.js server/lis/lisproxy-results.test.js`. Тема: `LIS Proxy: результат через прежний приём — одна строка журнала, голые цифры не ищут заказ, мусор — справка (LIS_PROXY_V1)`.

---

## Task 6: Серия всегда и по строке прибора; лишний показатель гематологии — справка (LIS_PROXY_V1)

**Files:**
- Modify: `server/lis/ingest.js` (импорты, `oneTest` `:1125`, разбор заказа после `seriesOn` `:1153`, `who` `:1213`, финальная запись `:1272`)
- Create: `server/lis/lisproxy-series.test.js`

- [ ] **Step 1: падающий тест.** Create `server/lis/lisproxy-series.test.js`:
```js
// LIS_PROXY_V1 — серия у строк LIS Proxy всегда и по строке прибора; лишний
// показатель гематологии — справка, незнакомый тест BS-200 — лоток (как свой порт).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SERIES_PENDING_PREFIX } from './inbox.js';
import { PROXY_QUIET_PREFIX } from './lisproxy-form.js';
import { freshDb, seedLisProxyClinic, addProxyDevice, bindPanel, startProxyApp, post, fixture, lastRow, tray, blank, rows } from '../test-helpers/lisproxy-clinic.js';

async function withClinic(fn) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db);
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}

test('BC-780 по значению в запросе: WBC — «ждём остальные», HGB — серия принята, обе строки applied, лоток пуст', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bc780_wbc'));
    const first = lastRow(db);
    assert.equal(first.status, 'unmapped');
    assert.ok(first.detail.startsWith(SERIES_PENDING_PREFIX), first.detail);
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63' });
    await post(app.url, fixture('results', 'bc780_hgb'));
    assert.equal(lastRow(db).status, 'applied');
    assert.equal(lastRow(db).detail, 'серия из 2 сообщений принята');
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63', 'Гемоглобин': '132' });
    assert.deepEqual(rows(db).map((m) => m.status), ['applied', 'applied']);
    assert.deepEqual(tray(db), []);
  });
});

test('BC-780: показатель, которого нет в панели (P-LCR), — справка, разрешена; серия не страдает', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bc780_wbc'));
    await post(app.url, fixture('results', 'bc780_wbc').replace('WBC', 'P-LCR').replace('4.63', '31.2'));
    const extra = lastRow(db);
    assert.equal(extra.detail, PROXY_QUIET_PREFIX + 'не использованы: P-LCR');
    assert.ok(extra.resolved_at, 'не в лотке');
    await post(app.url, fixture('results', 'bc780_hgb'));
    assert.equal(lastRow(db).status, 'applied');
    assert.deepEqual(tray(db), []);
  });
});

test('BC-780: неподтверждённая строка панели — лоток (D4), не справка', async () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  db.prepare("UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE panel_id = 7 AND device_code = 'HGB'").run();
  const app = await startProxyApp(db);
  try {
    await post(app.url, fixture('results', 'bc780_hgb'));
    const m = lastRow(db);
    assert.equal(m.resolved_at, null);
    assert.match(m.detail, /не подтверждено: HGB/);
    assert.deepEqual(blank(db, 555), {});
  } finally { await app.close(); db.close(); }
});

test('BS-200: незнакомый тест — лоток, как на своём порту', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('results', 'bs200_glu').replace('code]=GLU', 'code]=CREA'));
    const m = lastRow(db);
    assert.equal(m.resolved_at, null);
    assert.match(m.detail, /не использованы: CREA/);
  });
});

test('серия — по строке прибора: HGB второго BC-780 той же пробирки — своя серия, «ждущую» строку первого прибора не принимает', async () => {
  await withClinic(async (db, app) => {
    const second = addProxyDevice(db, { name: 'bc780y', label: 'LABPC2', profile: 'mindray-bc-780' });
    await post(app.url, fixture('results', 'bc780_wbc'));
    const first = lastRow(db);
    await post(app.url, fixture('results', 'bc780_hgb').replace('bc780x', 'bc780y').replace('LABPC', 'LABPC2'));
    const m = lastRow(db);
    assert.equal(m.device_id, second);
    assert.equal(m.status, 'applied', 'бланк полон — HGB принят (та же модель — та же панель)');
    assert.equal(m.detail, '', 'серия из одного сообщения — как одно сообщение (match.js seriesOutcome)');
    const still = db.prepare('SELECT status, detail FROM lab_device_messages WHERE id = ?').get(first.id);
    assert.equal(still.status, 'unmapped');
    assert.ok(still.detail.startsWith(SERIES_PENDING_PREFIX), 'строка первого прибора — в своей серии');
  });
});

test('две услуги одной пробирки (D3) через LIS Proxy: Глюкоза и Мочевина — каждая в свою, лоток пуст', async () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  bindPanel(db, { id: 8, serviceId: 12, deviceId: 1, name: 'Мочевина', lines: [['UREA', 'Мочевина', 'UREA']] });
  const app = await startProxyApp(db);
  try {
    await post(app.url, fixture('results', 'bs200_glu'));
    await post(app.url, fixture('results', 'bs200_glu').replace('code]=GLU', 'code]=UREA').replace('5.100000', '4.200000'));
    assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    assert.deepEqual(blank(db, 124), { 'Мочевина': '4.2' });
    assert.deepEqual(tray(db), []);
  } finally { await app.close(); db.close(); }
});
```
Run: `node --test server/lis/lisproxy-series.test.js`. Expected: FAIL — HGB даёт «не пришли: Лейкоциты (WBC)», P-LCR — в лотке.

- [ ] **Step 2: правка приёма.** В `server/lis/ingest.js`:
  - импорт `import { PROXY_NOT_TUBE } from './lisproxy-form.js';   // LIS_PROXY_V1` заменить на:
```js
import { PROXY_NOT_TUBE, PROXY_QUIET_PREFIX } from './lisproxy-form.js';   // LIS_PROXY_V1
import { unusedText } from './match.js';   // LIS_PROXY_V1 — справка гематологии
```
  - (`:1125`) найти `  const oneTest = !!(profile && profile.oneTestPerMessage);`, заменить на:
```js
  // LIS_PROXY_V1 — LIS Proxy шлёт одно значение в запросе при любой модели: серия всегда.
  const oneTest = proxy || !!(profile && profile.oneTestPerMessage);
  // LIS_PROXY_V1 (Р14) — гематология за LIS Proxy: лишний показатель — справка, а не лоток.
  const heme = !!(profile && profile.kind === 'hematology');
```
  - (`:1152-1153`) найти
```js
      const plan = tube.plans[k];
      const seriesOn = oneTest && plan.fills.length > 0;
```
  и добавить сразу после:
```js
      // LIS_PROXY_V1 (Р14) — гематология через LIS Proxy: значение, которое ничего не
      // заполнило и ни на что не претендует (не подтверждено, не повтор) — только
      // «не использованы». На своём порту такие строки — справка в принятом
      // сообщении (правило владельца 2026-09-28); по одному значению в запросе
      // каждая была бы строкой лотка на каждую пробирку. Строка — разрешённая
      // справка; бланк судит серия. BS-200 и AutoLumo — как свой порт: в лоток.
      if (proxy && heme && !fanned && k === 0 && !plan.fills.length && !plan.unconfirmed.length && !plan.repeats.length && plan.unused.length) {
        Object.assign(report, { status: 'unmapped', detail: PROXY_QUIET_PREFIX + unusedText(plan.unused), pending: false, open: true, quiet: true });
        return;
      }
```
  - (`:1213`) найти `        const who = { orderId: O.id, deviceId, perInstrument: !!s.pi, profileKey: device.profile };   // ревью R2, п. 1; R4, п. A`, заменить на:
```js
        const who = { orderId: O.id, deviceId, perInstrument: proxy || !!s.pi, profileKey: device.profile };   // ревью R2, п. 1; R4, п. A; LIS_PROXY_V1 — серия LIS Proxy — по строке прибора
```
  - (`:1272`) найти `    const id = record({ ...base, visitServiceId: linked, status, detail, disputes: disputes.length ? JSON.stringify(disputes) : null });`, заменить на:
```js
    const quiet = !fanned && !!reports[0].quiet;   // LIS_PROXY_V1 (Р14) — справка разрешена сразу
    const id = record({ ...base, visitServiceId: linked, status, detail, disputes: disputes.length ? JSON.stringify(disputes) : null, resolved: quiet });
```

- [ ] **Step 3: прогнать.** Run:
  - `node --test server/lis/lisproxy-series.test.js` → PASS (6);
  - сторожа: `node --test $(ls server/lis/*.test.js) server/services/rpc/lis.test.js` → `ℹ fail 0`. Особо: серии `ingest.test.js:559-930` и `real-analyzers.e2e.test.js` — ветки не прокси не меняются.

- [ ] **Step 4: коммит.** `git add --` `server/lis/ingest.js server/lis/lisproxy-series.test.js`. Тема: `LIS Proxy: серия всегда и по строке прибора; лишний показатель гематологии — справка (LIS_PROXY_V1)`.

---

## Task 7: Рабочий список `apiOrderGet` (LIS_PROXY_V1)

**Files:**
- Modify:
  - `server/lis/ingest.js` — в конец: `worklistLines`;
  - `server/lis/lisproxy.js`.
- Create: `server/lis/lisproxy-worklist.test.js`

- [ ] **Step 1: падающий тест.** Create `server/lis/lisproxy-worklist.test.js`:
```js
// LIS_PROXY_V1 — рабочий список (apiOrderGet): те же ворота, что у результата;
// только подтверждённые коды; пробирка — все услуги визита этого прибора;
// dd.MM.yyyy, пол 1/0; мусорный номер — {}; журнал с ответом; касса не держится.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worklistLines } from './ingest.js';
import { freshDb, seedLisProxyClinic, bindPanel, addProxyDevice, startProxyApp, post, fixture, lastRow, rows } from '../test-helpers/lisproxy-clinic.js';

const ask = (barcode, name = 'bs200', host = 'LAB-PC-1') =>
  'method=apiOrderGet&order[name]=' + name + '&order[host]=' + host + '&order[barcode]=' + encodeURIComponent(barcode);

async function withClinic(fn, extra = () => {}) {
  const db = freshDb();
  seedLisProxyClinic(db);
  extra(db);
  const app = await startProxyApp(db);
  try { await fn(db, app); } finally { await app.close(); db.close(); }
}
const json = async (res) => { assert.equal(res.status, 200); return res.json(); };

test('BS-200, LAB-000123: одна запись на подтверждённый код; clientId — номер пробирки, имён нет, дата dd.MM.yyyy, пол «1», сыворотка', async () => {
  await withClinic(async (db, app) => {
    const reply = await json(await post(app.url, fixture('orders', 'bs200_order')));
    assert.deepEqual(reply, { 0: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' } });
    const m = lastRow(db);
    assert.deepEqual([m.kind, m.status, m.visit_service_id, m.sample_id, m.device_id, !!m.resolved_at], ['query', 'unmatched', null, 'LAB-000123', 1, true]);
    assert.equal(m.reply_body, JSON.stringify(reply));
    assert.equal(m.detail, 'LIS Proxy: рабочий список по пробирке LAB-000123 — отдано тестов: 1 (GLU)');
    assert.equal(m.source_body, fixture('orders', 'bs200_order'));
  });
});

test('пробирка — все услуги визита этого прибора (D3): Глюкоза и Мочевина, порядок панели, без повторов; неподтверждённая строка не отдаётся', async () => {
  await withClinic(async (db, app) => {
    const reply = await json(await post(app.url, ask('LAB-000123')));
    assert.deepEqual(Object.values(reply).map((e) => e.code), ['GLU', 'UREA']);
  }, (db) => {
    bindPanel(db, { id: 8, serviceId: 12, deviceId: 1, name: 'Мочевина', lines: [['UREA', 'Мочевина', 'UREA'], ['GLU2', 'Глюкоза ещё раз', 'glu'], ['CREA', 'Креатинин', 'CREA', 0]] });
  });
});

test('ворота: не оплачен, отменён, выдан, нет панели, панель другой модели, ничего не подтверждено — {} с причиной в журнале', async () => {
  await withClinic(async (db, app) => {
    const cases = [
      [ask('LAB-000130'), /заказ ещё не оплачен/],
      [ask('LAB-000131'), /заказ отменён/],
      [ask('LAB-000555'), /кормится анализатором другой модели/],
      [ask('LAB-000999'), /заказ по номеру пробы не найден/],
    ];
    for (const [body, re] of cases) {
      assert.deepEqual(await json(await post(app.url, body)), {}, body);
      assert.match(lastRow(db).detail, re, body);
    }
    db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, verified_at) VALUES (123, 'Глюкоза', '5.1', strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
    assert.deepEqual(await json(await post(app.url, ask('LAB-000123'))), {});
    assert.match(lastRow(db).detail, /результат заказа уже выдан/);
    db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed = 0 WHERE panel_id = 5').run();
    assert.deepEqual(await json(await post(app.url, ask('LAB-000132'))), {});
    assert.match(lastRow(db).detail, /нет подтверждённых кодов этого прибора/);
  });
});

test('прибор не добавлен, выключен, мусорный номер (ORU^R01, QRY^Q02, ALL, N, метка времени, пусто) — {}', async () => {
  await withClinic(async (db, app) => {
    for (const id of ['cl_garbage_msh9', 'cl_garbage_qry', 'cl_garbage_all', 'cl_garbage_n', 'cl_garbage_timestamp', 'cl_garbage_empty']) {
      assert.deepEqual(await json(await post(app.url, fixture('orders', id))), {}, id);
    }
    assert.match(lastRow(db).detail, /прибор ещё не добавлен/, 'cl900i — находка');
    db.prepare("UPDATE lab_devices SET added = 1, profile = 'mindray-cl-900i' WHERE proxy_name = 'cl900i'").run();
    for (const id of ['cl_garbage_msh9', 'cl_garbage_all', 'cl_garbage_timestamp', 'cl_garbage_empty']) {
      assert.deepEqual(await json(await post(app.url, fixture('orders', id))), {}, id);
      assert.match(lastRow(db).detail, /не штрихкод пробирки/, id);
    }
    db.prepare('UPDATE lab_devices SET enabled = 0 WHERE id = 1').run();
    assert.deepEqual(await json(await post(app.url, fixture('orders', 'bs200_order'))), {});
    assert.match(lastRow(db).detail, /прибор выключен/);
  });
});

test('AutoLumo: «B-000777» — восстановлен, код 214; «B-000123» — LAB-000123 в журнале, панель другой модели — {}', async () => {
  await withClinic(async (db, app) => {
    const reply = await json(await post(app.url, ask('B-000777', 'lumo', 'LAB-PC-2')));
    assert.deepEqual(reply, { 0: { clientId: 'LAB-000777', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: '214' } });
    assert.deepEqual(await json(await post(app.url, fixture('orders', 'lumo_order_truncated'))), {});
    assert.equal(lastRow(db).sample_id, 'LAB-000123');
    assert.match(lastRow(db).detail, /кормится анализатором другой модели/);
  });
});

test('пол и дата: женщина — «0», без даты и пол «другой» — пустые, в журнале — предупреждение; моча — urine', async () => {
  await withClinic(async (db, app) => {
    const r1 = await json(await post(app.url, ask('LAB-000132')));
    assert.deepEqual([r1[0].date_birth, r1[0].sex], ['', '']);
    assert.match(lastRow(db).detail, /дата рождения не указана — прибор получит пустую дату/);
    db.prepare("UPDATE visit_services SET status = 'queued' WHERE id = 130").run();
    db.prepare("UPDATE services SET specimen = 'Моча' WHERE id = 9").run();
    const r2 = await json(await post(app.url, ask('LAB-000130')));
    assert.deepEqual([r2[0].date_birth, r2[0].sex, r2[0].biomaterial_code], ['20.11.1985', '0', 'urine']);
  });
});

test('строка рабочего списка не держит кассу: не привязана к заказу', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('orders', 'bs200_order'));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM lab_device_messages WHERE visit_service_id = 123').get().c, 0);
  });
});

test('BS-200: подтверждение для другой строки прибора (номер теста свой у каждого) — не отдаётся', () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const other = addProxyDevice(db, { name: 'bs200b', label: 'LAB-PC-9', profile: 'mindray-bs-200' });
  assert.match(worklistLines(db, { deviceId: other, orderId: 123 }).why, /привязана к другому анализатору той же модели/);
  db.prepare('UPDATE lab_panel_analytes SET device_code_confirmed_device_id = ? WHERE panel_id = 5').run(other);
  assert.deepEqual(worklistLines(db, { deviceId: 1, orderId: 123 }), { ok: false, why: 'у панели нет подтверждённых кодов этого прибора' });
  db.close();
});

test('рабочий список больше 1 КБ (12 тестов) — JSON целиком, без gzip', async () => {
  await withClinic(async (db, app) => {
    const res = await post(app.url, ask('LAB-000123'));
    assert.equal(res.headers.get('content-encoding'), 'identity');
    const reply = await res.json();
    assert.equal(Object.keys(reply).length, 12);
    assert.ok(JSON.stringify(reply).length > 1024);
  }, (db) => {
    const lines = [];
    for (let i = 1; i <= 11; i++) lines.push(['T' + i, 'Тест ' + i, 'T' + i]);
    db.prepare('DELETE FROM lab_panel_analytes WHERE panel_id = 5').run();
    db.prepare('DELETE FROM lab_panels WHERE id = 5').run();
    bindPanel(db, { id: 5, serviceId: 9, deviceId: 1, name: 'Биохимия', lines: [['GLU', 'Глюкоза', 'GLU'], ...lines] });
  });
});

test('журнал: каждый запрос рабочего списка — своя разрешённая строка с ответом', async () => {
  await withClinic(async (db, app) => {
    await post(app.url, fixture('orders', 'bs200_order'));
    await post(app.url, fixture('orders', 'cl_garbage_all'));
    assert.deepEqual(rows(db).map((m) => [m.kind, !!m.resolved_at, m.reply_body != null]), [['query', true, true], ['query', true, true]]);
  });
});
```
Run: `node --test server/lis/lisproxy-worklist.test.js`. Expected: FAIL (`worklistLines` нет).

- [ ] **Step 2: ворота рабочего списка — в приёме.** В конец `server/lis/ingest.js` добавить:
```js

// ═══ LIS_PROXY_V1 — РАБОЧИЙ СПИСОК ДЛЯ LIS PROXY (apiOrderGet) ═══════════════
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 5; решение
// владельца 2026-10-09, п. 1 — отменяет «только результаты» 2026-10-01, §7.)
//
// Здесь, а не во входе прокси: тесты на пробирку отдаются по ТЕМ ЖЕ воротам,
// по которым приём потом примет результат, — одно правило, а не копия. Только
// чтение: ничего не пишет.
//   — заказ есть и лабораторный; ворота лаборатории (gateRefusal: не оплачен,
//     отменён, возврат); не выдан (D7: выданный приём всё равно не перепишет);
//   — orderSide: панель услуги привязана к этому прибору или к прибору той же
//     модели (у BS-200 — только к своему), подтверждения BS-200 — для этого
//     прибора и его эпохи;
//   — коды — только подтверждённые человеком (D4), по порядку панели; потом —
//     открытых оплаченных невыданных заказов того же визита, которые кормит этот
//     прибор (D3, решение владельца 2026-10-06, п. 2): без них анализатор не
//     прогонит тесты других услуг пробирки. Повторы кода — один раз.
// @returns {{ok:true, codes:string[], patient:{date_of_birth:string|null, gender:string|null}, specimen:string}
//          | {ok:false, why:string}}
export function worklistLines(db, { deviceId, orderId } = {}) {
  const order = orderId ? db.prepare(`SELECT vs.*, s.is_lab, s.name AS service_name, s.specimen FROM visit_services vs
                                        JOIN services s ON s.id = vs.service_id WHERE vs.id = ?`).get(orderId) : null;
  if (!order) return { ok: false, why: 'заказ по номеру пробы не найден' };
  if (!order.is_lab) return { ok: false, why: 'услуга «' + (order.service_name || order.service_id) + '» не помечена как лабораторная' };
  const gate = gateRefusal(order);
  if (gate) return { ok: false, why: gate };
  if (order.status === 'completed' || isReleased(db, order.id)) return { ok: false, why: 'результат заказа уже выдан' };
  const sender = deviceId ? db.prepare('SELECT profile, name FROM lab_devices WHERE id = ?').get(deviceId) : null;
  if (!sender) return { ok: false, why: 'прибор не найден' };
  const ctx = { deviceId, sender, profile: getProfile(sender.profile), messageModel: null };
  const own = orderSide(db, order, ctx);
  if (!own.ok) return { ok: false, why: own.detail };
  const sides = [own, ...siblingSides(db, order, ctx).filter((s) => !s.closed)];
  const seen = new Set();
  const codes = [];
  for (const s of sides) {
    for (const a of s.analytes.filter(confirmedCode)) {
      const code = String(a.device_code).trim();
      if (seen.has(codeKey(code))) continue;
      seen.add(codeKey(code));
      codes.push(code);
    }
  }
  if (!codes.length) return { ok: false, why: 'у панели нет подтверждённых кодов этого прибора' };
  const patient = db.prepare('SELECT p.date_of_birth, p.gender FROM visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = ?').get(order.visit_id)
    || { date_of_birth: null, gender: null };
  return { ok: true, codes, patient, specimen: order.specimen || '' };
}
```

- [ ] **Step 3: разбор запроса.** В `server/lis/lisproxy.js`:
  - добавить импорты:
```js
import { worklistLines } from './ingest.js';
import { worklistEntries } from './lisproxy-form.js';
```
  - в `handleProxyRequest` после строки `if (method === 'apiResultSave') return handleResult(db, { id, peer, body: b, now });` добавить:
```js
  if (method === 'apiOrderGet') return handleOrder(db, { id, peer, body: b });
```
  - в конец файла добавить:
```js

/** apiOrderGet — рабочий список одной пробирки (раздел 5). Не найдено — {}. */
function handleOrder(db, { id, peer, body }) {
  const o = obj(body.order);
  const sent = str(o.barcode).trim();
  const who = resolveDevice(db, id, { name: str(o.name), label: str(o.host), peer });
  const d = who.device;
  let reply = {};
  let why = '';
  let sampleId = sent;
  if (!d) why = 'прибор не заведён — ' + who.reason;
  else if (Number(d.added) !== 1) why = 'прибор ещё не добавлен — «Добавить прибор» → «Найдены в сети» → «Добавить»';
  else if (Number(d.enabled) !== 1) why = 'прибор выключен в «Анализаторах»';
  else {
    const bc = normaliseProxyBarcode(sent, { autolumo: d.profile === AUTOLUMO });
    if (!bc.ok) why = bc.why;
    else {
      sampleId = bc.barcode;
      const w = worklistLines(db, { deviceId: d.id, orderId: Number(bc.barcode.slice(4)) });
      if (!w.ok) why = w.why;
      else reply = worklistEntries({ barcode: bc.barcode, codes: w.codes, patient: w.patient, specimen: w.specimen });
      if (w.ok && !(w.patient && w.patient.date_of_birth)) why = 'дата рождения не указана — прибор получит пустую дату';
    }
  }
  const codes = Object.values(reply).map((e) => e.code);
  const detail = 'LIS Proxy: рабочий список по пробирке ' + (sampleId || '(пусто)')
    + (codes.length ? ' — отдано тестов: ' + codes.length + ' (' + codes.join(', ') + ')' + (why ? '; ' + why : '') : ' — ничего не отдано: ' + why)
    + movedNote(who.moved);
  // Запрос — не проба: строка разрешена, к заказу не привязана (строка лотка при
  // заказе держит кассу — billing.js), «запросы N» у прибора считает lis_service_counts.
  recordMessage(db, { id, deviceId: d ? d.id : null, peer, raw: '', sampleId, status: 'unmatched', detail, kind: 'query', resolved: true });
  db.prepare('UPDATE lab_device_messages SET reply_body = ? WHERE id = ?').run(JSON.stringify(reply), id);
  return { type: 'json', body: reply };
}
```

- [ ] **Step 4: прогнать.** Run:
  - `node --test server/lis/lisproxy-worklist.test.js` → PASS (10);
  - сторожа: `node --test $(ls server/lis/*.test.js) server/routes/lisproxy.test.js` → `ℹ fail 0`.

- [ ] **Step 5: коммит.** `git add --` `server/lis/ingest.js server/lis/lisproxy.js server/lis/lisproxy-worklist.test.js`. Тема: `LIS Proxy: рабочий список apiOrderGet — те же ворота, что у результата, только подтверждённые коды, без имён (LIS_PROXY_V1)`.

> **После задачи 7 — контрольная точка контролёра:** результат и рабочий список работают сквозь. Если на часах раньше **2026-10-10 18:51**, сразу выполнить «Проверку настоящей программой» из раздела «Завершение» (шаги C3–C4), не дожидаясь экрана. Иначе — только C3 (`replay_fixtures.py`) в конце.

---

## Task 8: `apiBarcodeListGet` и незнакомый `method` — `{}` и строка журнала (LIS_PROXY_V1)

**Files:**
- Modify: `server/lis/lisproxy.js`
- Create: `server/lis/lisproxy-other.test.js`

- [ ] **Step 1: падающий тест.** Create `server/lis/lisproxy-other.test.js`:
```js
// LIS_PROXY_V1 — apiBarcodeListGet (пакетная загрузка выключена) и незнакомый
// method: {} и строка журнала, не ошибка; в лоток не идут.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, startProxyApp, post, fixture, lastRow, tray, device } from '../test-helpers/lisproxy-clinic.js';

test('apiBarcodeListGet — 200 {}, строка журнала «пакетная загрузка выключена», прибор найден и на связи', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    const res = await post(app.url, fixture('lists', 'cl_barcode_list'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
    const m = lastRow(db);
    assert.deepEqual([m.kind, !!m.resolved_at, m.reply_body], ['query', true, '{}']);
    assert.match(m.detail, /пакетная загрузка выключена/);
    assert.ok(device(db, 'cl900i').last_seen_at);
    assert.deepEqual(tray(db), []);
  } finally { await app.close(); db.close(); }
});

test('незнакомый method — 200 {}, строка журнала, не ошибка; без имени — без прибора', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  try {
    const body = fixture('unknown', 'unknown_method');
    const res = await post(app.url, body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
    const m = lastRow(db);
    assert.equal(m.detail, 'LIS Proxy: незнакомый запрос «apiSomethingNew» — ответ {}');
    assert.deepEqual([m.kind, m.device_id, m.source_body, !!m.resolved_at], ['query', null, body, true]);
    assert.deepEqual(tray(db), []);
  } finally { await app.close(); db.close(); }
});
```
Run: `node --test server/lis/lisproxy-other.test.js`. Expected: FAIL (строка остаётся «не завершён», `reply_body` пуст).

- [ ] **Step 2: последние запросы.** В `server/lis/lisproxy.js` функцию `handleProxyRequest` заменить на:
```js
/**
 * Разобрать запрос, уже записанный в журнал строкой id.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {}, now = new Date() } = {}) {
  const b = obj(body);
  const method = methodOf(b);
  if (method === 'apiResultSave') return handleResult(db, { id, peer, body: b, now });
  if (method === 'apiOrderGet') return handleOrder(db, { id, peer, body: b });
  if (method === 'apiBarcodeListGet') {
    return quietQuery(db, { id, peer, who: obj(b.order), detail: 'LIS Proxy: запрос всех проб (apiBarcodeListGet) — пакетная загрузка выключена, ответ {}' });
  }
  return quietQuery(db, { id, peer, who: b.order ? obj(b.order) : obj(b.lisResult),
    detail: 'LIS Proxy: незнакомый запрос «' + (method || '(нет method)') + '» — ответ {}' });
}
```
и в конец файла добавить:
```js

/** apiBarcodeListGet и незнакомый method: {} и строка журнала (Р19). */
function quietQuery(db, { id, peer, who: w, detail }) {
  const name = str(w.name).trim();
  const who = name ? resolveDevice(db, id, { name, label: str(w.host), peer }) : { device: null, moved: null };
  recordMessage(db, { id, deviceId: who.device ? who.device.id : null, peer, raw: '', sampleId: '', status: 'unmatched',
    detail: detail + movedNote(who.moved), kind: 'query', resolved: true });
  db.prepare("UPDATE lab_device_messages SET reply_body = '{}' WHERE id = ?").run(id);
  return empty();
}
```

- [ ] **Step 3: итог `server/lis/lisproxy.js`.** Файл целиком теперь такой (сверить; расхождение — исправить):
```js
// LIS_PROXY_V1 — запрос LIS Proxy: журнал, прибор, результат, рабочий список
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 2–6).
//
// Прокси шлёт каждое значение ОДИН раз и не повторяет, а анализатору уже
// ответил «принято». Поэтому: сначала строка журнала (тело как пришло —
// source_body), потом всё остальное дописывает ЭТУ ЖЕ строку, и ответ — 200 на
// любой исход (маршрут server/routes/lisproxy.js). Результат идёт в прежний
// приём (receive.js → ingest.js) синтетическим ORU^R01 (lisproxy-form.js).
import { recordMessage, touchDevice } from './inbox.js';
import { receiveMessage } from './receive.js';
import { ensureProxyDevice } from './discover.js';
import { buildOru, junkReason, normaliseProxyBarcode, PROXY_QUIET_PREFIX } from './lisproxy-form.js';
import { worklistLines } from './ingest.js';
import { worklistEntries } from './lisproxy-form.js';

/** Журнал строки, пока запрос не разобран: если процесс упал посреди — строка так и скажет. */
export const JOURNAL_PENDING = 'LIS Proxy: запрос сохранён, разбор не завершён';
/** Модель, у которой прокси обрезает номер до 8 знаков (Р10). */
export const AUTOLUMO = 'autobio-autolumo-a1000';

const OK = Object.freeze({ type: 'text', body: 'OK' });
const empty = () => ({ type: 'json', body: {} });
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

export const methodOf = (body) => str(obj(body).method).trim();

/** Ответ, когда разбор сорвался: прокси ждёт 2xx, и тело ему всё равно. */
export function fallbackReply(method) { return method === 'apiResultSave' ? OK : empty(); }

/** Строка журнала — ПЕРВОЙ, до прибора и разбора. Бросает — маршрут отвечает 500. */
export function journalProxyRequest(db, { peer = '', body = '', method = '', note = '' } = {}) {
  return recordMessage(db, {
    peer, raw: '', status: 'rejected', detail: note || JOURNAL_PENDING,
    kind: method === 'apiResultSave' ? 'result' : 'query', sourceBody: String(body == null ? '' : body),
  });
}

/** Разбор сорвался после журнала: строка говорит почему (по возможности); ответ — всё равно 200. */
export function failJournal(db, id, err) {
  try {
    db.prepare("UPDATE lab_device_messages SET status = 'rejected', resolved_at = NULL, detail = ? WHERE id = ?")
      .run('LIS Proxy: ошибка разбора — ' + String((err && err.message) || err), id);
  } catch { /* журнал уже записан; причина — по возможности */ }
}

/**
 * Разобрать запрос, уже записанный в журнал строкой id.
 * @returns {{type:'text'|'json', body:any}}
 */
export function handleProxyRequest(db, { id, peer = '', body = {}, now = new Date() } = {}) {
  const b = obj(body);
  const method = methodOf(b);
  if (method === 'apiResultSave') return handleResult(db, { id, peer, body: b, now });
  if (method === 'apiOrderGet') return handleOrder(db, { id, peer, body: b });
  if (method === 'apiBarcodeListGet') {
    return quietQuery(db, { id, peer, who: obj(b.order), detail: 'LIS Proxy: запрос всех проб (apiBarcodeListGet) — пакетная загрузка выключена, ответ {}' });
  }
  return quietQuery(db, { id, peer, who: b.order ? obj(b.order) : obj(b.lisResult),
    detail: 'LIS Proxy: незнакомый запрос «' + (method || '(нет method)') + '» — ответ {}' });
}

/** Прибор запроса: найти или завести (discover.js), записать в журнал, «на связи» — на каждом запросе. */
function resolveDevice(db, id, { name, label, peer }) {
  const r = ensureProxyDevice(db, { name, label, ip: peer });
  if (r.device) {
    db.prepare('UPDATE lab_device_messages SET device_id = ? WHERE id = ?').run(r.device.id, id);
    touchDevice(db, r.device.id);
  }
  return r;
}
const movedNote = (m) => (m ? '; адрес LIS Proxy сменился: ' + (m.from || '—') + ' → ' + (m.to || '—') : '');

/** apiResultSave — одно значение (раздел 3). */
function handleResult(db, { id, peer, body, now }) {
  const r = obj(body.lisResult);
  const R = obj(r.R);
  const f = { code: str(r.code), res: str(R.res), unit: str(R.unit), norms: str(R.norms), flag: str(R.flag) };
  const sent = str(r.barcode).trim();
  const who = resolveDevice(db, id, { name: str(r.name), label: str(r.host), peer });
  const deviceId = who.device ? who.device.id : null;
  const note = movedNote(who.moved);

  // Мусор прибора: строка разрешена сразу — без лотка, без серии, не в ленте (Р13).
  const junk = junkReason(f);
  if (junk) {
    recordMessage(db, { id, deviceId, peer, raw: '', sampleId: sent, status: 'unmatched', detail: PROXY_QUIET_PREFIX + junk + note, resolved: true });
    return OK;
  }
  // Прибора нет (имя пустое, предел находок) — в лоток, в приём не идёт (Р12):
  // приём без прибора пишет в панель с кодами производителя.
  if (!who.device) {
    recordMessage(db, { id, deviceId: null, peer, raw: buildOru({ ...f, controlId: String(id), now }), sampleId: sent, status: 'unmatched',
      detail: 'LIS Proxy: прибор не заведён — ' + who.reason + ' — значения не записаны' });
    return OK;
  }
  // Не номер пробирки — в лоток с причиной; заказ не ищется (решение владельца 3, Р11).
  const bc = normaliseProxyBarcode(sent, { autolumo: who.device.profile === AUTOLUMO });
  const raw = buildOru({ ...f, barcode: bc.ok ? bc.barcode : '', controlId: String(id), now });
  if (!bc.ok) {
    recordMessage(db, { id, deviceId, peer, raw, sampleId: sent, status: 'unmatched', detail: bc.why + note });
    return OK;
  }
  // Прежний вход своего порта: «прибор выключен», N2, ворота, D4/D6/D7, серия.
  receiveMessage(db, raw, { peer, deviceId, journalId: id });
  if (note) {
    db.prepare("UPDATE lab_device_messages SET detail = CASE WHEN COALESCE(detail, '') = '' THEN ? ELSE detail || ? END WHERE id = ?")
      .run(note.slice(2), note, id);
  }
  return OK;
}

/** apiOrderGet — рабочий список одной пробирки (раздел 5). Не найдено — {}. */
function handleOrder(db, { id, peer, body }) {
  const o = obj(body.order);
  const sent = str(o.barcode).trim();
  const who = resolveDevice(db, id, { name: str(o.name), label: str(o.host), peer });
  const d = who.device;
  let reply = {};
  let why = '';
  let sampleId = sent;
  if (!d) why = 'прибор не заведён — ' + who.reason;
  else if (Number(d.added) !== 1) why = 'прибор ещё не добавлен — «Добавить прибор» → «Найдены в сети» → «Добавить»';
  else if (Number(d.enabled) !== 1) why = 'прибор выключен в «Анализаторах»';
  else {
    const bc = normaliseProxyBarcode(sent, { autolumo: d.profile === AUTOLUMO });
    if (!bc.ok) why = bc.why;
    else {
      sampleId = bc.barcode;
      const w = worklistLines(db, { deviceId: d.id, orderId: Number(bc.barcode.slice(4)) });
      if (!w.ok) why = w.why;
      else reply = worklistEntries({ barcode: bc.barcode, codes: w.codes, patient: w.patient, specimen: w.specimen });
      if (w.ok && !(w.patient && w.patient.date_of_birth)) why = 'дата рождения не указана — прибор получит пустую дату';
    }
  }
  const codes = Object.values(reply).map((e) => e.code);
  const detail = 'LIS Proxy: рабочий список по пробирке ' + (sampleId || '(пусто)')
    + (codes.length ? ' — отдано тестов: ' + codes.length + ' (' + codes.join(', ') + ')' + (why ? '; ' + why : '') : ' — ничего не отдано: ' + why)
    + movedNote(who.moved);
  // Запрос — не проба: строка разрешена, к заказу не привязана (строка лотка при
  // заказе держит кассу — billing.js), «запросы N» у прибора считает lis_service_counts.
  recordMessage(db, { id, deviceId: d ? d.id : null, peer, raw: '', sampleId, status: 'unmatched', detail, kind: 'query', resolved: true });
  db.prepare('UPDATE lab_device_messages SET reply_body = ? WHERE id = ?').run(JSON.stringify(reply), id);
  return { type: 'json', body: reply };
}

/** apiBarcodeListGet и незнакомый method: {} и строка журнала (Р19). */
function quietQuery(db, { id, peer, who: w, detail }) {
  const name = str(w.name).trim();
  const who = name ? resolveDevice(db, id, { name, label: str(w.host), peer }) : { device: null, moved: null };
  recordMessage(db, { id, deviceId: who.device ? who.device.id : null, peer, raw: '', sampleId: '', status: 'unmatched',
    detail: detail + movedNote(who.moved), kind: 'query', resolved: true });
  db.prepare("UPDATE lab_device_messages SET reply_body = '{}' WHERE id = ?").run(id);
  return empty();
}
```

- [ ] **Step 4: прогнать.** Run: `node --test server/lis/lisproxy-other.test.js server/lis/lisproxy-results.test.js server/lis/lisproxy-worklist.test.js server/lis/lisproxy-series.test.js server/lis/lisproxy-device.test.js server/routes/lisproxy.test.js`. Expected: `ℹ fail 0`.

- [ ] **Step 5: коммит.** `git add --` `server/lis/lisproxy.js server/lis/lisproxy-other.test.js`. Тема: `LIS Proxy: apiBarcodeListGet и незнакомый запрос — {} и строка журнала (LIS_PROXY_V1)`.

---

## Task 9: RPC карточки, «Добавить» прибор прокси — три модели, реестр, словарь сервера (LIS_PROXY_V1)

**Files:**
- Create:
  - `public/js/shared/lisproxy-models.js`;
  - `server/services/rpc/lis-proxy.js`, `server/services/rpc/lis-proxy.test.js`.
- Modify:
  - `server/services/rpc/index.js` (импорт ~75, карта ~593);
  - `server/services/control/gate.js` (`READ_ONLY_RPCS`, после `'lis_service_counts'`);
  - `server/services/rpc/lis.js` (`lisDeviceAdd` `:542-575`, константы ~577-580);
  - `server/db/schema-registry.js` (`lab_devices` `:1280`, `:1301`);
  - `public/js/admin/i18n-strings.js`.

- [ ] **Step 1: падающий тест.** Create `server/services/rpc/lis-proxy.test.js`:
```js
// LIS_PROXY_V1 — карточка «LIS Proxy»: включить / выключить / сменить ключ;
// адрес с ключом — только админу и лаборанту; «Добавить» прибор прокси —
// только BS-200, BC-780, AutoLumo A1000; через RPC-маршрут настоящего приложения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDataDir } from '../control/config.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readProxySettings, keyMatches } from '../../lis/lisproxy-settings.js';
import { lisProxyGet, lisProxySet, proxyState } from './lis-proxy.js';
import { lisDeviceAdd } from './lis.js';
import { RPC } from './index.js';
import { freshDb, addProxyDevice, startProxyApp, post, fixture } from '../../test-helpers/lisproxy-clinic.js';

const ADMIN = { id: 1, role: 'admin' };
const LAB = { id: 2, role: 'lab' };
const DOCTOR = { id: 3, role: 'doctor' };
const CASHIER = { id: 4, role: 'cashier' };

test('по умолчанию выключено; включение создаёт ключ; адреса — по адресам ПК и порту; выключение ключ хранит; «сменить ключ» — новый', () => {
  const dir = tmpDir('em-lpx-rpc-');
  setDataDir(dir);
  const db = freshDb();
  assert.deepEqual(lisProxyGet(db, {}, LAB).enabled, false);
  const on = lisProxySet(db, { enabled: true }, LAB);
  assert.equal(on.enabled, true);
  assert.match(on.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(on.can_manage, true);
  assert.equal(readProxySettings(dir).changed_by, 2);
  const st = proxyState(dir, { port: 8123, addresses: ['192.168.1.10', '10.0.0.2'] });
  assert.deepEqual(st.urls, ['http://192.168.1.10:8123/api/lisproxy?key=' + on.key, 'http://10.0.0.2:8123/api/lisproxy?key=' + on.key]);
  const off = lisProxySet(db, { enabled: false }, ADMIN);
  assert.deepEqual([off.enabled, off.key, off.urls], [false, null, []]);
  assert.equal(readProxySettings(dir).key, on.key, 'ключ хранится');
  assert.equal(lisProxySet(db, { enabled: true }, ADMIN).key, on.key, 'включили снова — тот же адрес');
  const rotated = lisProxySet(db, { rotate: true }, ADMIN);
  assert.notEqual(rotated.key, on.key);
  assert.equal(keyMatches(on.key, readProxySettings(dir).key), false, 'старый ключ больше не подходит');
  db.close();
});

test('роли: адрес с ключом и правка — админ и лаборант; врач видит только «включён»; касса — 403; аргументы проверяются', () => {
  setDataDir(tmpDir('em-lpx-rpc-'));
  const db = freshDb();
  lisProxySet(db, { enabled: true }, ADMIN);
  const doc = lisProxyGet(db, {}, DOCTOR);
  assert.deepEqual([doc.enabled, doc.key, doc.urls, doc.can_manage], [true, null, [], false]);
  assert.throws(() => lisProxyGet(db, {}, CASHIER), (e) => e.status === 403);
  assert.throws(() => lisProxySet(db, { enabled: false }, DOCTOR), (e) => e.status === 403);
  assert.throws(() => lisProxySet(db, { enabled: 'да' }, ADMIN), /включить или выключить/);
  assert.throws(() => lisProxySet(db, {}, ADMIN), /Нечего менять/);
  assert.throws(() => lisProxySet(db, { rotate: 1 }, ADMIN), /Нечего менять/);
  db.close();
});

test('карта RPC: lis_proxy_get — чтение (лицензия), lis_proxy_set — запись', () => {
  assert.equal(typeof RPC.lis_proxy_get, 'function');
  assert.equal(typeof RPC.lis_proxy_set, 'function');
  assert.equal(isReadOnlyRpc('lis_proxy_get'), true);
  assert.equal(isReadOnlyRpc('lis_proxy_set'), false);
});

test('ключ сменили — старый адрес сразу 404, новый — 200', async () => {
  const db = freshDb();
  const app = await startProxyApp(db);
  setDataDir(app.dataDir);
  try {
    const before = await post(app.url, fixture('lists', 'cl_barcode_list'));
    assert.equal(before.status, 200);
    const { key } = lisProxySet(db, { rotate: true }, ADMIN);
    assert.equal((await post(app.url, fixture('lists', 'cl_barcode_list'))).status, 404);
    assert.equal((await post(app.base + '/api/lisproxy?key=' + key, fixture('lists', 'cl_barcode_list'))).status, 200);
  } finally { await app.close(); db.close(); }
});

test('«Добавить» прибор LIS Proxy: модель обязательна и одна из трёх; «общий HL7» — отказ; прибор своего порта — как прежде', () => {
  const db = freshDb();
  const id = addProxyDevice(db, { name: 'bs200', added: 0 });
  for (const args of [{ id, name: 'BS-200' }, { id, name: 'BS-200', generic: true }, { id, name: 'BS-200', profile: 'mindray-cl-900i' }]) {
    assert.throws(() => lisDeviceAdd(db, args, LAB), (e) => e.code === 'proxy_model_required' && /только BS-200, BC-780 и AutoLumo A1000/.test(e.message), JSON.stringify(args));
  }
  const ok = lisDeviceAdd(db, { id, name: 'BS-200 (лаб. ПК 1)', profile: 'mindray-bs-200' }, LAB);
  assert.deepEqual([ok.added, ok.profile, ok.model_confirmed], [1, 'mindray-bs-200', 1]);
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, enabled, discovered, added) VALUES (50, 'Анализатор 10.0.0.9', '', 'mllp', '10.0.0.9', 1, 1, 0)").run();
  assert.equal(lisDeviceAdd(db, { id: 50, name: 'Другой', generic: true }, LAB).added, 1, 'свой порт — «общий HL7» как прежде');
  db.close();
});
```
Run: `node --test server/services/rpc/lis-proxy.test.js`. Expected: FAIL (модуля нет).

- [ ] **Step 2: общий список моделей.** Create `public/js/shared/lisproxy-models.js`:
```js
// LIS_PROXY_V1 — модели, которые Easy-Med принимает через LIS Proxy (решение
// владельца 2026-10-09, п. 6): BS-200, BC-780, AutoLumo A1000. Типы прокси для
// BC-20 / BC-5300 путают поле штрихкода, тип CL-900i результатов не передаёт —
// эти приборы идут в Easy-Med напрямую. Один список на сервер (rpc/lis.js
// lis_device_add) и экран (lab-devices.js «Добавить»).
export const PROXY_MODELS = Object.freeze(['mindray-bs-200', 'mindray-bc-780', 'autobio-autolumo-a1000']);

/** Строка прибора — за LIS Proxy (мигр. 239, lab_devices.via). */
export const isProxyDevice = (d) => !!d && d.via === 'lisproxy';
```

- [ ] **Step 3: RPC.** Create `server/services/rpc/lis-proxy.js`:
```js
// LIS_PROXY_V1 — карточка «LIS Proxy» на экране «Анализаторы»: включить,
// выключить, адрес с ключом для лабораторных ПК, сменить ключ
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, разделы 1 и 7, Р20).
//
// Адрес с ключом — пропуск на запись значений прибора. Видят и меняют его
// администратор и лаборант (они настраивают лабораторные ПК); прочие роли
// раздела лаборатории видят только «включён / выключен». Настройка — файл
// data/lisproxy.json (server/lis/lisproxy-settings.js); RPC не видят req, папку
// данных берут из control/config.js (как лицензия).
import { hasAnyRole } from '../roles.js';
import { LAB_SECTION_ROLES } from '../../db/schema-registry.js';
import { getDataDir } from '../control/config.js';
import { lanAddresses } from '../branch-sync/pairing.js';
import { readProxySettings, writeProxySettings, newProxyKey } from '../../lis/lisproxy-settings.js';

class LisProxyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Кто видит адрес с ключом и меняет его (Р20). */
export const PROXY_KEY_ROLES = Object.freeze(['admin', 'lab']);

/**
 * Состояние для экрана: адреса — по каждому адресу этого ПК в сети, порт —
 * веб-порт Easy-Med (тот же, что печатает server/index.js при запуске).
 */
export function proxyState(dataDir, { port = Number(process.env.PORT || 8000), addresses = lanAddresses() } = {}) {
  const s = readProxySettings(dataDir);
  const urls = s.enabled ? addresses.map((ip) => 'http://' + ip + ':' + port + '/api/lisproxy?key=' + s.key) : [];
  return { enabled: s.enabled, key: s.enabled ? s.key : null, port, addresses, urls, changed_at: s.changed_at };
}

/** lis_proxy_get — чтение (READ_ONLY_RPCS). */
export function lisProxyGet(db, args, user) {
  if (!hasAnyRole(user, LAB_SECTION_ROLES)) throw new LisProxyError('Недостаточно прав', 403);
  const st = proxyState(getDataDir());
  if (hasAnyRole(user, PROXY_KEY_ROLES)) return { ...st, can_manage: true };
  return { enabled: st.enabled, key: null, port: st.port, addresses: [], urls: [], changed_at: st.changed_at, can_manage: false };
}

/**
 * lis_proxy_set — { enabled?: boolean, rotate?: true }. Первое включение
 * создаёт ключ; rotate — новый ключ (старый адрес перестаёт работать сразу:
 * файл читается на каждом запросе). Выключение ключ хранит.
 */
export function lisProxySet(db, args, user) {
  if (!hasAnyRole(user, PROXY_KEY_ROLES)) throw new LisProxyError('Недостаточно прав', 403);
  const a = args || {};
  if (a.enabled !== undefined && typeof a.enabled !== 'boolean') throw new LisProxyError('Укажите: включить или выключить LIS Proxy');
  if ((a.rotate !== undefined && a.rotate !== true) || (a.enabled === undefined && a.rotate !== true)) {
    throw new LisProxyError('Нечего менять: укажите «включить», «выключить» или «сменить ключ»');
  }
  const dir = getDataDir();
  const cur = readProxySettings(dir);
  const enabled = a.enabled === undefined ? cur.enabled : a.enabled;
  const key = a.rotate === true || !cur.key ? newProxyKey() : cur.key;
  writeProxySettings(dir, { enabled, key, changed_by: user && Number.isInteger(user.id) ? user.id : null });
  return lisProxyGet(db, {}, user);
}
```

- [ ] **Step 4: регистрация и лицензия.**
  - `server/services/rpc/index.js`:
    - после `import { lisDeviceAdd } from './lis.js';   // LIS_VENDOR_EXACT_V1 — D2: …` добавить `import { lisProxyGet, lisProxySet } from './lis-proxy.js';   // LIS_PROXY_V1 — карточка «LIS Proxy»`;
    - после строки `  lis_device_add:           (db, args, user) => lisDeviceAdd(db, args, user),   // LIS_VENDOR_EXACT_V1 — D2: запись, НЕ в READ_ONLY_RPCS` добавить:
```js
  lis_proxy_get:            (db, args, user) => lisProxyGet(db, args, user),   // LIS_PROXY_V1 — чтение (gate.js)
  lis_proxy_set:            (db, args, user) => lisProxySet(db, args, user),   // LIS_PROXY_V1 — запись, НЕ в READ_ONLY_RPCS
```
  - `server/services/control/gate.js`: после строки `  'lis_service_counts',   // LIS_REAL_ANALYZERS_V1_SERVICE — …; чтение` добавить:
```js
  'lis_proxy_get',   // LIS_PROXY_V1 — включён ли LIS Proxy и адрес для лабораторных ПК; чтение
```

- [ ] **Step 5: «Добавить» прибор прокси.** В `server/services/rpc/lis.js`:
  - после `import { PROXY_QUIET_PREFIX } from '../../lis/lisproxy-form.js';   // LIS_PROXY_V1` добавить:
```js
import { PROXY_MODELS } from '../../../public/js/shared/lisproxy-models.js';   // LIS_PROXY_V1
```
  - в `lisDeviceAdd` найти `    const dev = db.prepare('SELECT id, profile, added FROM lab_devices WHERE id = ?').get(id);`, заменить на:
```js
    const dev = db.prepare('SELECT id, profile, added, via FROM lab_devices WHERE id = ?').get(id);   // via: LIS_PROXY_V1
```
  - там же найти `    const values = { name, added: 1 };` и вставить ПЕРЕД ним:
```js
    // LIS_PROXY_V1 (решение владельца 2026-10-09, п. 6; Р21) — прибор за LIS Proxy:
    // прокси модель не сообщает, и через него принимаются только BS-200, BC-780 и
    // AutoLumo A1000 — модель обязательна и одна из трёх; «общий HL7» — нет.
    if (dev.via === 'lisproxy' && (generic || !PROXY_MODELS.includes(profile))) {
      const err = new LisError(PROXY_MODEL_REQUIRED);
      err.code = 'proxy_model_required';   // экран показывает отказ его словами
      throw err;
    }
```
  - после строки `const NOT_ADDED = '…';` добавить:
```js
// LIS_PROXY_V1 — Р21: тот же текст показывает экран (lab-devices.js), один ключ словаря.
const PROXY_MODEL_REQUIRED = 'Через LIS Proxy Easy-Med принимает только BS-200, BC-780 и AutoLumo A1000 — выберите одну из этих моделей.';
```

- [ ] **Step 6: реестр.** В `server/db/schema-registry.js`, `lab_devices`:
  - в `read.columns` найти хвост `'sending_app','dial','sending_facility','code_epoch'] },` и заменить на:
```js
'sending_app','dial','sending_facility','code_epoch','via','proxy_name','proxy_label','proxy_ip'] },   // LIS_PROXY_V1 (мигр. 239) — via, proxy_*: прибор за LIS Proxy; пишет только сервер, в insert/update их нет
```
  - `    filters: ['id','enabled','transport','profile'],` → `    filters: ['id','enabled','transport','profile','via'],   // via: LIS_PROXY_V1`.

  `insert` и `update` не меняются: `via` и `proxy_*` пишет только сервер.

- [ ] **Step 7: словарь сервера.** В начало `STRINGS` (`public/js/admin/i18n-strings.js`) добавить:
```js
  // LIS_PROXY_V1 (2026-10-09) — сообщения сервера: lis_proxy_set, lis_device_add (rpc/lis-proxy.js, rpc/lis.js)
  "Укажите: включить или выключить LIS Proxy": {"en":"Say whether to turn LIS Proxy on or off","ru":"Укажите: включить или выключить LIS Proxy","uz":"LIS Proxy’ni yoqish yoki o‘chirishni ko‘rsating"},   // LIS_PROXY_V1
  "Нечего менять: укажите «включить», «выключить» или «сменить ключ»": {"en":"Nothing to change: say «turn on», «turn off» or «change the key»","ru":"Нечего менять: укажите «включить», «выключить» или «сменить ключ»","uz":"O‘zgartiradigan narsa yo‘q: «yoqish», «o‘chirish» yoki «kalitni almashtirish»ni ko‘rsating"},   // LIS_PROXY_V1
  "Через LIS Proxy Easy-Med принимает только BS-200, BC-780 и AutoLumo A1000 — выберите одну из этих моделей.": {"en":"Through LIS Proxy Easy-Med accepts only the BS-200, BC-780 and AutoLumo A1000 — choose one of these models.","ru":"Через LIS Proxy Easy-Med принимает только BS-200, BC-780 и AutoLumo A1000 — выберите одну из этих моделей.","uz":"LIS Proxy orqali Easy-Med faqat BS-200, BC-780 va AutoLumo A1000 ni qabul qiladi — shulardan birini tanlang."},   // LIS_PROXY_V1
```

- [ ] **Step 8: прогнать.** Run:
  - `node --test server/services/rpc/lis-proxy.test.js server/services/rpc/lis.test.js server/services/rpc/index.test.js server/services/rpc/client-rpc-coverage.test.js server/routes/licence-gate.test.js server/db/schema-registry-conformance.test.js server/db/schema-registry.test.js server/db/write-grant.test.js server/i18n-server-messages.test.js` → `ℹ fail 0`;
  - `node --experimental-vm-modules --test public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/db-query-schema.test.mjs` → `ℹ fail 0`.

- [ ] **Step 9: коммит.** `git add --` `public/js/shared/lisproxy-models.js server/services/rpc/lis-proxy.js server/services/rpc/lis-proxy.test.js server/services/rpc/index.js server/services/control/gate.js server/services/rpc/lis.js server/db/schema-registry.js public/js/admin/i18n-strings.js`. Тема: `LIS Proxy: RPC карточки (включить, адрес, сменить ключ), «Добавить» — три модели, реестр (LIS_PROXY_V1)`.

---

## Task 10: Карточка «LIS Proxy» на экране «Анализаторы» (LIS_PROXY_V1)

**Files:**
- Create:
  - `public/js/admin/views/lab-proxy-card.js`;
  - `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs`.
- Modify:
  - `public/js/admin/views/lab-devices.js` (импорты ~26, карточки ~137-152);
  - `public/js/admin/i18n-strings.js`.

- [ ] **Step 1: падающий тест.** Create `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` (стенд — копия `lab-devices-add.test.mjs`; задачи 11–12 допишут тесты в конец):
```js
// LIS_PROXY_V1 (2026-10-09) — Лаборатория → «Анализаторы» и LIS Proxy:
// карточка (включить, адрес с ключом, сменить ключ; роли), строки приборов
// за прокси, «Добавить» и «Изменить» такого прибора, «один анализатор — один
// приёмник», группы строк лотка (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 7).
import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — копия из __tests__/lab-devices-add.test.mjs.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
const fakeLocalStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта экрана
let CONFIRM = true;
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } }, CLINIC: { id: 'c-1' },
  confirm: () => CONFIRM, prompt: () => null,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);
const findButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findButtons(root).find((b) => re.test(textOf(b)));

// --- fake сервер -----------------------------------------------------------
const NOW = new Date().toISOString();
const PROFILES = [
  { key: 'mindray-bs-200', vendor: 'Mindray', model: 'BS-200', channels: [] },
  { key: 'mindray-bc-780', vendor: 'Mindray', model: 'BC-780', channels: [] },
  { key: 'autobio-autolumo-a1000', vendor: 'Autobio', model: 'AutoLumo A1000', channels: [] },
  { key: 'mindray-cl-900i', vendor: 'Mindray', model: 'CL-900i', channels: [] },
];
const PROXY_BS = { id: 1, name: 'bs200', profile: 'mindray-bs-200', transport: 'mllp', host: '', port: null, enabled: 1, added: 1, discovered: 1, model_confirmed: 1,
  last_seen_at: NOW, via: 'lisproxy', proxy_name: 'bs200', proxy_label: 'LAB-PC-1', proxy_ip: '192.168.1.21' };
const PROXY_FOUND = { id: 2, name: 'lumo', profile: '', transport: 'mllp', host: '', port: null, enabled: 1, added: 0, discovered: 1, model_confirmed: 0,
  last_seen_at: NOW, via: 'lisproxy', proxy_name: 'lumo', proxy_label: 'LAB-PC-2', proxy_ip: '192.168.1.22' };
const MLLP_BS = { id: 3, name: 'BS-200 напрямую', profile: 'mindray-bs-200', transport: 'mllp', host: '10.0.0.40', port: 2575, enabled: 1, added: 1, discovered: 0, model_confirmed: 1, last_seen_at: NOW };
let DEVICES = [];
let MESSAGES = [];
let COUNTS = [];
let PROXY = null;
let writes = [];
let rpcCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') { writes.push(body); return { ok: true, json: async () => ({ data: [] }) }; }
    if (body && body.table === 'lab_devices') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(DEVICES)) }) };
    if (body && body.table === 'lab_device_messages') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(MESSAGES)) }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') return { ok: true, json: async () => ({ data: PROFILES }) };
    if (name === 'lis_listeners') return { ok: true, json: async () => ({ data: { listening: [2575], failed: [], now: NOW } }) };
    if (name === 'lis_service_counts') return { ok: true, json: async () => ({ data: COUNTS }) };
    if (name === 'lis_proxy_get') return { ok: true, json: async () => ({ data: PROXY }) };
    if (name === 'lis_proxy_set') {
      PROXY = { ...PROXY, enabled: body.enabled === undefined ? PROXY.enabled : body.enabled, key: body.rotate ? 'NEWKEY' : PROXY.key };
      PROXY.urls = PROXY.enabled ? ['http://192.168.1.10:8000/api/lisproxy?key=' + PROXY.key] : [];
      return { ok: true, json: async () => ({ data: PROXY }) };
    }
    if (name === 'lis_message_dismiss') return { ok: true, json: async () => ({ data: { ok: true } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');
const { proxyUrls } = await import('../views/lab-proxy-card.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function reset({ devices = [PROXY_BS], proxy = { enabled: true, key: 'K1', port: 8000, addresses: ['192.168.1.10'], urls: ['http://192.168.1.10:8000/api/lisproxy?key=K1'], can_manage: true } } = {}) {
  DEVICES = devices; MESSAGES = []; COUNTS = []; PROXY = proxy; writes = []; rpcCalls = []; toastMsg = null; CONFIRM = true;
}
async function mount() {
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();
  await tick();
  return root;
}

test('карточка: включён — адрес с ключом и «Копировать»; «Сменить ключ» спрашивает и меняет', async () => {
  reset();
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('LIS Proxy'));
  assert.ok(text.includes('http://192.168.1.10:8000/api/lisproxy?key=K1'), 'адрес с ключом виден');
  assert.ok(findButtonByText(root, /Копировать/), 'есть «Копировать»');
  findButtonByText(root, /Сменить ключ/).click();
  await tick();
  const set = rpcCalls.find((c) => c.name === 'lis_proxy_set');
  assert.deepStrictEqual(set && set.args, { rotate: true });
  assert.ok(textOf(root).includes('key=NEWKEY'), 'новый адрес на экране');
});

test('карточка: выключен — «Включить» включает; «Сменить ключ» без согласия ничего не делает', async () => {
  reset({ proxy: { enabled: false, key: null, port: 8000, addresses: [], urls: [], can_manage: true } });
  const root = await mount();
  assert.ok(textOf(root).includes('Выключен — LIS Proxy получает ответ «адрес не найден», и его результаты теряются.'));
  findButtonByText(root, /^\s*Включить\s*$/).click();
  await tick();
  assert.deepStrictEqual(rpcCalls.find((c) => c.name === 'lis_proxy_set').args, { enabled: true });
  CONFIRM = false;
  rpcCalls = [];
  findButtonByText(root, /Сменить ключ/).click();
  await tick();
  assert.equal(rpcCalls.filter((c) => c.name === 'lis_proxy_set').length, 0);
});

test('карточка: врач — без адреса и без кнопок', async () => {
  reset({ proxy: { enabled: true, key: null, port: 8000, addresses: [], urls: [], can_manage: false } });
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('Адрес для LIS Proxy видят и меняют администратор и лаборант.'));
  assert.ok(!text.includes('/api/lisproxy?key='));
  assert.ok(!findButtonByText(root, /Сменить ключ/));
});

test('адрес: от сервера; адресов нет — по адресу страницы, но не localhost', () => {
  const st = { enabled: true, key: 'K', port: 8000, urls: [] };
  assert.deepStrictEqual(proxyUrls({ ...st, urls: ['http://a/x'] }, { hostname: '10.0.0.5' }), ['http://a/x']);
  assert.deepStrictEqual(proxyUrls(st, { hostname: '10.0.0.5' }), ['http://10.0.0.5:8000/api/lisproxy?key=K']);
  assert.deepStrictEqual(proxyUrls(st, { hostname: 'localhost' }), []);
  assert.deepStrictEqual(proxyUrls(st, { hostname: '127.0.0.1' }), []);
  assert.deepStrictEqual(proxyUrls({ ...st, enabled: false }, { hostname: '10.0.0.5' }), []);
});
```
Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-devices-lisproxy.test.mjs`. Expected: FAIL (нет `lab-proxy-card.js`).

- [ ] **Step 2: карточка.** Create `public/js/admin/views/lab-proxy-card.js`:
```js
// LIS_PROXY_V1 — карточка «LIS Proxy» на экране Лаборатория → «Анализаторы»
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 7).
//
// LIS Proxy — программа поставщика на лабораторном ПК: передаёт Easy-Med
// результаты BS-200, BC-780 и AutoLumo A1000 и берёт рабочий список для BS-200.
// Здесь её включают, копируют адрес для каждого лабораторного ПК и меняют ключ.
// Адрес с ключом — пропуск на запись значений прибора: его видят и меняют
// администратор и лаборант (сервер — rpc/lis-proxy.js), прочие видят только
// «включён / выключен».
import { h, Icon, Tag, toast, clear } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';

// Ключи словаря, а не собранные строки: tr() ищет строку целиком.
const INTRO = 'Приём через LIS Proxy: программа на лабораторном ПК передаёт Easy-Med результаты BS-200, BC-780 и AutoLumo A1000 и получает рабочий список для BS-200.';
const OFF_NOTE = 'Выключен — LIS Proxy получает ответ «адрес не найден», и его результаты теряются.';
const PASTE_NOTE = 'Вставьте этот адрес в LIS Proxy на каждом лабораторном ПК (в кавычках, после -api).';
const ROTATE_Q = 'Сменить ключ? Старый адрес перестанет работать: на каждом лабораторном ПК вставьте новый адрес в LIS Proxy, иначе его результаты будут теряться.';
const ROTATED = 'Ключ сменён — обновите адрес на лабораторных ПК';
const NO_ADDR = 'Адрес этого компьютера в сети не определился. Откройте Easy-Med с другого компьютера по адресу в сети — здесь появится готовый адрес для LIS Proxy.';
const ROLE_NOTE = 'Адрес для LIS Proxy видят и меняют администратор и лаборант.';

/**
 * Адреса для показа. Сервер даёт по адресу на каждую сетевую карту ПК;
 * не дал (адресов нет) — адрес, с которого открыт Easy-Med, если это не
 * localhost (лабораторному ПК localhost бесполезен).
 */
export function proxyUrls(st, loc = (typeof window !== 'undefined' && window.location) || null) {
    if (!st || !st.enabled || !st.key) return [];
    if (Array.isArray(st.urls) && st.urls.length) return st.urls;
    const host = String((loc && loc.hostname) || '');
    if (!host || host === 'localhost' || host.startsWith('127.') || host === '::1' || host === '[::1]') return [];
    return ['http://' + host + ':' + (st.port || 8000) + '/api/lisproxy?key=' + st.key];
}

const small = { fontSize: '12.5px' };

/** Нарисовать карточку в card и прочитать настройку. */
export async function mountProxyCard(card) {
    const state = { st: null, error: null, busy: false };

    async function load() {
        const { data, error } = await supabase.rpc('lis_proxy_get', {});
        state.st = error ? null : data;
        state.error = error ? (error.message || String(error)) : null;
        paint();
    }

    async function change(args, okKey) {
        if (state.busy) return;   // двойное нажатие — один вызов
        state.busy = true;
        const { data, error } = await supabase.rpc('lis_proxy_set', args);
        state.busy = false;
        if (error) { toast(trf('Не удалось изменить LIS Proxy: {msg}', { msg: error.message || error }), 'fail'); return; }
        state.st = data;
        if (okKey) toast(tr(okKey));
        paint();
    }

    function urlRow(url) {
        const code = h('code', { class: 'cell-mono', translate: 'no', style: {
            display: 'block', flex: '1 1 260px', padding: '6px 10px', background: 'var(--ink-050, #f4f6f8)', borderRadius: '6px',
            fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' } }, url);
        const copy = h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => copyText(url) },
            Icon('Copy', { size: 13 }), ' ', tr('Копировать'));
        return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap', marginTop: '6px' } }, code, copy);
    }

    async function copyText(text) {
        const cb = (typeof navigator !== 'undefined' && navigator && navigator.clipboard) || null;
        try {
            if (!cb || typeof cb.writeText !== 'function') throw new Error('no clipboard');
            await cb.writeText(text);
            toast(tr('Скопировано'), 'ok');
        } catch {
            toast(tr('Скопируйте вручную'), 'info');
        }
    }

    function paint() {
        clear(card);
        const st = state.st;
        card.appendChild(h('div', { class: 'card-header' },
            h('h3', null, Icon('Link', { size: 15 }), ' ', 'LIS Proxy'),
            h('span', { class: 'grow' }),
            st ? Tag(st.enabled ? tr('включён') : tr('выключен'), { kind: st.enabled ? 'success' : '' }) : null,
            st && st.can_manage
                ? h('button', { class: 'btn btn-sm ' + (st.enabled ? 'btn-outline' : 'btn-primary'), type: 'button', style: { marginLeft: '8px' },
                    onclick: () => change({ enabled: !st.enabled }) }, st.enabled ? tr('Выключить') : tr('Включить'))
                : null));
        const body = h('div', { style: { padding: '0 14px 14px' } });
        card.appendChild(body);
        body.appendChild(h('p', { class: 'muted', style: small }, tr(INTRO)));
        if (state.error) {
            body.appendChild(h('p', { class: 'muted', style: small }, trf('Не удалось прочитать настройку LIS Proxy: {msg}', { msg: state.error })));
            return;
        }
        if (!st) return;
        if (!st.can_manage) { body.appendChild(h('p', { class: 'muted', style: small }, tr(ROLE_NOTE))); return; }
        if (!st.enabled) { body.appendChild(h('p', { class: 'muted', style: small }, tr(OFF_NOTE))); return; }
        const urls = proxyUrls(st);
        body.appendChild(h('div', { style: { fontWeight: 600, marginTop: '6px' } }, tr('Адрес для LIS Proxy')));
        if (!urls.length) body.appendChild(h('p', { class: 'muted', style: small }, tr(NO_ADDR)));
        for (const url of urls) body.appendChild(urlRow(url));
        body.appendChild(h('p', { class: 'muted', style: { ...small, marginTop: '6px' } }, tr(PASTE_NOTE)));
        body.appendChild(h('div', { style: { marginTop: '8px' } },
            h('button', { class: 'btn btn-outline btn-sm', type: 'button',
                onclick: () => { if (window.confirm(tr(ROTATE_Q))) change({ rotate: true }, ROTATED); } },
                Icon('Key', { size: 13 }), ' ', tr('Сменить ключ'))));
    }

    paint();
    await load();
    return { reload: load };
}
```

- [ ] **Step 3: карточка — на экран.** В `public/js/admin/views/lab-devices.js`:
  - после `import { peerNotes, hasUnreadableText } from './lab-devices-lists.js?v=lists4';` добавить:
```js
// LIS_PROXY_V1 — карточка «LIS Proxy».
import { mountProxyCard } from './lab-proxy-card.js';
```
  - найти
```js
    const guideCard = h('div', { class: 'card' });
    // LAB_COMPACT_V1
```
  и вставить между ними `    const proxyCard = h('div', { class: 'card' });   // LIS_PROXY_V1 — карточка «LIS Proxy»`;
  - найти
```js
    grid.appendChild(devicesCard);
    grid.appendChild(formCard);
```
  и вставить между ними `    grid.appendChild(proxyCard);   // LIS_PROXY_V1`;
  - найти
```js
    container.appendChild(grid);
    paintGuide();
```
  и добавить после:
```js
    // LIS_PROXY_V1 — карточка читает свою настройку сама (lis_proxy_get) и в живой опрос не входит.
    mountProxyCard(proxyCard).catch(() => {});
```

- [ ] **Step 4: словарь карточки.** В начало `STRINGS` добавить:
```js
  // LIS_PROXY_V1 (2026-10-09) — экран «Анализаторы»: карточка «LIS Proxy» (views/lab-proxy-card.js)
  "Приём через LIS Proxy: программа на лабораторном ПК передаёт Easy-Med результаты BS-200, BC-780 и AutoLumo A1000 и получает рабочий список для BS-200.": {"en":"Receiving through LIS Proxy: the program on the lab PC sends Easy-Med the results of the BS-200, BC-780 and AutoLumo A1000 and fetches the worklist for the BS-200.","ru":"Приём через LIS Proxy: программа на лабораторном ПК передаёт Easy-Med результаты BS-200, BC-780 и AutoLumo A1000 и получает рабочий список для BS-200.","uz":"LIS Proxy orqali qabul qilish: laboratoriya kompyuteridagi dastur Easy-Med’ga BS-200, BC-780 va AutoLumo A1000 natijalarini yuboradi va BS-200 uchun ish ro‘yxatini oladi."},   // LIS_PROXY_V1
  "Выключен — LIS Proxy получает ответ «адрес не найден», и его результаты теряются.": {"en":"Off — LIS Proxy gets a “not found” answer and its results are lost.","ru":"Выключен — LIS Proxy получает ответ «адрес не найден», и его результаты теряются.","uz":"O‘chirilgan — LIS Proxy «manzil topilmadi» javobini oladi va uning natijalari yo‘qoladi."},   // LIS_PROXY_V1
  "Вставьте этот адрес в LIS Proxy на каждом лабораторном ПК (в кавычках, после -api).": {"en":"Paste this address into LIS Proxy on every lab PC (in quotes, after -api).","ru":"Вставьте этот адрес в LIS Proxy на каждом лабораторном ПК (в кавычках, после -api).","uz":"Ushbu manzilni har bir laboratoriya kompyuteridagi LIS Proxy’ga qo‘ying (qo‘shtirnoq ichida, -api dan keyin)."},   // LIS_PROXY_V1
  "Сменить ключ? Старый адрес перестанет работать: на каждом лабораторном ПК вставьте новый адрес в LIS Proxy, иначе его результаты будут теряться.": {"en":"Change the key? The old address will stop working: paste the new address into LIS Proxy on every lab PC, or its results will be lost.","ru":"Сменить ключ? Старый адрес перестанет работать: на каждом лабораторном ПК вставьте новый адрес в LIS Proxy, иначе его результаты будут теряться.","uz":"Kalit almashtirilsinmi? Eski manzil ishlamay qoladi: har bir laboratoriya kompyuterida LIS Proxy’ga yangi manzilni qo‘ying, aks holda uning natijalari yo‘qoladi."},   // LIS_PROXY_V1
  "Ключ сменён — обновите адрес на лабораторных ПК": {"en":"Key changed — update the address on the lab PCs","ru":"Ключ сменён — обновите адрес на лабораторных ПК","uz":"Kalit almashtirildi — laboratoriya kompyuterlarida manzilni yangilang"},   // LIS_PROXY_V1
  "Адрес этого компьютера в сети не определился. Откройте Easy-Med с другого компьютера по адресу в сети — здесь появится готовый адрес для LIS Proxy.": {"en":"This computer’s network address could not be found. Open Easy-Med from another computer by its network address — the ready address for LIS Proxy will appear here.","ru":"Адрес этого компьютера в сети не определился. Откройте Easy-Med с другого компьютера по адресу в сети — здесь появится готовый адрес для LIS Proxy.","uz":"Bu kompyuterning tarmoqdagi manzili aniqlanmadi. Easy-Med’ni boshqa kompyuterdan tarmoq manzili orqali oching — bu yerda LIS Proxy uchun tayyor manzil paydo bo‘ladi."},   // LIS_PROXY_V1
  "Адрес для LIS Proxy видят и меняют администратор и лаборант.": {"en":"Only an administrator or a lab technician sees and changes the address for LIS Proxy.","ru":"Адрес для LIS Proxy видят и меняют администратор и лаборант.","uz":"LIS Proxy uchun manzilni administrator va laborant ko‘radi va o‘zgartiradi."},   // LIS_PROXY_V1
  "Адрес для LIS Proxy": {"en":"Address for LIS Proxy","ru":"Адрес для LIS Proxy","uz":"LIS Proxy uchun manzil"},   // LIS_PROXY_V1
  "Сменить ключ": {"en":"Change the key","ru":"Сменить ключ","uz":"Kalitni almashtirish"},   // LIS_PROXY_V1
  "Не удалось изменить LIS Proxy: {msg}": {"en":"Could not change LIS Proxy: {msg}","ru":"Не удалось изменить LIS Proxy: {msg}","uz":"LIS Proxy’ni o‘zgartirib bo‘lmadi: {msg}"},   // LIS_PROXY_V1
  "Не удалось прочитать настройку LIS Proxy: {msg}": {"en":"Could not read the LIS Proxy setting: {msg}","ru":"Не удалось прочитать настройку LIS Proxy: {msg}","uz":"LIS Proxy sozlamasini o‘qib bo‘lmadi: {msg}"},   // LIS_PROXY_V1
```

- [ ] **Step 5: прогнать.** Run:
  - `node --experimental-vm-modules --test public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` → PASS (4);
  - сторожа: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-devices-add.test.mjs public/js/admin/__tests__/lab-devices-real.test.mjs public/js/admin/__tests__/lab-devices-tray.test.mjs public/js/admin/__tests__/lab-devices-vendor.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs public/js/admin/__tests__/type-scale.test.mjs public/js/admin/__tests__/rpc-exists.test.mjs` и `node --test server/services/rpc/client-rpc-coverage.test.js` → `ℹ fail 0`.

- [ ] **Step 6: коммит.** `git add --` `public/js/admin/views/lab-proxy-card.js public/js/admin/views/lab-devices.js public/js/admin/__tests__/lab-devices-lisproxy.test.mjs public/js/admin/i18n-strings.js`. Тема: `Анализаторы: карточка «LIS Proxy» — включить, адрес с ключом, сменить ключ (LIS_PROXY_V1)`.

---

## Task 11: Приборы за LIS Proxy на экране — таблица, «Найдены в сети», «Добавить», «Изменить»; один анализатор — один приёмник (LIS_PROXY_V1)

**Files:**
- Modify:
  - `public/js/admin/views/lab-devices-lists.js` (`splitDevices` `:16`, `serviceSummary` `:277-284`, `connectionOf` `:313-317`, конец файла);
  - `public/js/admin/views/lab-devices-lists.test.mjs` (конец);
  - `public/js/admin/views/lab-devices.js`;
  - `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` (конец);
  - `public/js/admin/i18n-strings.js`.

- [ ] **Step 1: падающие тесты правил.** В конец `public/js/admin/views/lab-devices-lists.test.mjs` добавить:
```js

// ── LIS_PROXY_V1 — прибор за LIS Proxy ──────────────────────────────────────
import { isProxyDevice, proxyAddress, bothPaths, BOTH_PATHS_WINDOW_MS } from './lab-devices-lists.js';

const PX = { id: 1, via: 'lisproxy', transport: 'mllp', host: '', proxy_name: 'bs200', proxy_label: 'LAB-PC-1', proxy_ip: '192.168.1.21' };

test('LIS Proxy: подключение — подпись и адрес ПК; запросы без подсказки «выключите запрос»', () => {
  assert.equal(isProxyDevice(PX), true);
  assert.equal(isProxyDevice({ via: null }), false);
  assert.deepEqual(connectionOf(PX), { key: 'через LIS Proxy · {label} ({ip})', params: { label: 'LAB-PC-1', ip: '192.168.1.21' } });
  assert.deepEqual(connectionOf({ ...PX, proxy_label: null }), { key: 'через LIS Proxy · {ip}', params: { ip: '192.168.1.21' } });
  assert.equal(serviceSummary({ device_id: 1, qc: 0, calibration: 0, query: QUERY_HINT_MIN + 5 }, { proxy: true }).queryHint, false);
  assert.equal(serviceSummary({ device_id: 1, qc: 0, calibration: 0, query: QUERY_HINT_MIN + 5 }).queryHint, true, 'свой порт — как прежде');
  assert.equal(proxyAddress(PX), 'LAB-PC-1 (192.168.1.21)');
  assert.equal(proxyAddress({ ...PX, proxy_label: '' }), '192.168.1.21');
});

test('LIS Proxy: одна модель за сутки и напрямую, и через прокси — в списке; давняя или другая модель — нет', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const recent = '2026-10-09T11:00:00Z';
  const old = new Date(now - BOTH_PATHS_WINDOW_MS - 1000).toISOString();
  const direct = { id: 2, profile: 'mindray-bs-200', last_seen_at: recent };
  const proxy = { ...PX, profile: 'mindray-bs-200', last_seen_at: recent };
  assert.deepEqual(bothPaths([direct, proxy], now), ['mindray-bs-200']);
  assert.deepEqual(bothPaths([{ ...direct, last_seen_at: old }, proxy], now), []);
  assert.deepEqual(bothPaths([{ ...direct, profile: 'mindray-bc-20' }, proxy], now), []);
  assert.deepEqual(bothPaths([proxy], now), []);
});
```
Run: `node --experimental-vm-modules --test public/js/admin/views/lab-devices-lists.test.mjs`. Expected: FAIL (`proxyAddress` нет).

- [ ] **Step 2: правила.** В `public/js/admin/views/lab-devices-lists.js`:
  - найти
```js
/** @returns {{table:object[], found:object[], waiting:object[]}} */
export function splitDevices(devices = []) {
```
  и вставить ПЕРЕД ними:
```js
import { isProxyDevice } from '../../shared/lisproxy-models.js';   // LIS_PROXY_V1
export { isProxyDevice };

```
  - `export function serviceSummary(c) {` → `export function serviceSummary(c, { proxy = false } = {}) {   // LIS_PROXY_V1 — proxy: прибор за LIS Proxy`;
  - `    return { parts, queryHint: Number(c.query) >= QUERY_HINT_MIN };` →
```js
    // LIS_PROXY_V1 — через LIS Proxy рабочий список отдаётся (решение владельца 2026-10-09, п. 1):
    // подсказка «Easy-Med заказов не отдаёт, выключите запрос» у такого прибора была бы неправдой.
    return { parts, queryHint: !proxy && Number(c.query) >= QUERY_HINT_MIN };
```
  - в `connectionOf` после `    if (!d || d.transport !== 'mllp') return null;` добавить:
```js
    // LIS_PROXY_V1 — прибор за LIS Proxy: подпись (обычно имя лабораторного ПК) и его адрес.
    if (isProxyDevice(d)) {
        return d.proxy_label
            ? P('через LIS Proxy · {label} ({ip})', { label: d.proxy_label, ip: d.proxy_ip || '—' })
            : P('через LIS Proxy · {ip}', { ip: d.proxy_ip || '—' });
    }
```
  - в конец файла добавить:
```js

// ── LIS_PROXY_V1 — прибор за LIS Proxy ───────────────────────────────────────
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 7.)

/** «Адрес» находки LIS Proxy: «подпись (адрес)» или адрес. */
export function proxyAddress(d) {
    if (!d) return '—';
    const ip = d.proxy_ip || '—';
    return d.proxy_label ? d.proxy_label + ' (' + ip + ')' : ip;
}

/** Сколько времени прибор считается «слышанным» для предупреждения «один анализатор — один приёмник». */
export const BOTH_PATHS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Модели, которые за сутки присылали и напрямую (свой порт), и через LIS Proxy.
 * Один анализатор на двух путях — результаты придут дважды (§0 п. 10 документа).
 * @returns {string[]} ключи профилей, по алфавиту
 */
export function bothPaths(devices = [], now = Date.now()) {
    const heard = (d) => !!d && !!d.profile && !!d.last_seen_at && now - Date.parse(d.last_seen_at) <= BOTH_PATHS_WINDOW_MS;
    const direct = new Set(devices.filter((d) => heard(d) && !isProxyDevice(d)).map((d) => d.profile));
    return [...new Set(devices.filter((d) => heard(d) && isProxyDevice(d) && direct.has(d.profile)).map((d) => d.profile))].sort();
}
```

- [ ] **Step 3: падающие тесты экрана.** В конец `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` добавить:
```js

test('таблица: прибор за LIS Proxy — «через LIS Proxy · подпись (адрес)»; подсказки «Easy-Med заказов не отдаёт» нет', async () => {
  reset();
  COUNTS = [{ device_id: 1, qc: 0, calibration: 0, query: 12 }];
  const root = await mount();
  // Только таблица приборов: инструкция ниже (свёрнута, но в документе) про свой порт говорит «Easy-Med заказов не отдаёт».
  const text = textOf(walk(root).find((n) => n.tagName === 'TABLE'));
  assert.ok(text.includes('через LIS Proxy · LAB-PC-1 (192.168.1.21)'), text);
  assert.ok(text.includes('запросы 12'), text);
  assert.ok(!text.includes('Easy-Med заказов не отдаёт'));
  assert.ok(!text.includes('любой адрес'));
});

test('одна модель напрямую и через LIS Proxy — предупреждение «один анализатор — один приёмник»', async () => {
  reset({ devices: [PROXY_BS, MLLP_BS] });
  const root = await mount();
  assert.ok(textOf(root).includes('BS-200 присылает результаты и напрямую, и через LIS Proxy.'));
});

test('«Найдены в сети»: «LIS Proxy · имя», «подпись (адрес)»; «Добавить» — только три модели, без «общего HL7»; без модели — отказ словами', async () => {
  reset({ devices: [PROXY_BS, PROXY_FOUND] });
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const text = textOf(root);
  assert.ok(text.includes('LIS Proxy · lumo'));
  assert.ok(text.includes('LAB-PC-2 (192.168.1.22)'));
  findButtons(root).find((b) => /^\s*(<svg[\s\S]*?<\/svg>)?\s*Добавить\s*$/.test(textOf(b))).click();
  await tick();
  const sel = walk(root).find((n) => n.tagName === 'SELECT');
  const values = walk(sel).filter((n) => n.tagName === 'OPTION').map((o) => o.attrs.value ?? o.value);
  assert.deepStrictEqual(values, ['', 'mindray-bs-200', 'mindray-bc-780', 'autobio-autolumo-a1000']);
  assert.ok(textOf(root).includes('LIS Proxy не сообщает модель анализатора'));
  sel.value = '';
  findButtons(root).filter((b) => /Добавить/.test(textOf(b))).pop().click();
  await tick();
  assert.equal(toastMsg, 'Через LIS Proxy Easy-Med принимает только BS-200, BC-780 и AutoLumo A1000 — выберите одну из этих моделей.');
  assert.ok(!rpcCalls.some((c) => c.name === 'lis_device_add'));
});

test('«Изменить» прибор LIS Proxy: ни адреса, ни порта, ни звонка; сохраняются имя, модель, «включён»', async () => {
  reset();
  const root = await mount();
  findButtonByText(root, /Изменить/).click();
  await tick();
  assert.ok(!walk(root).some((n) => n.tagName === 'INPUT' && n.attrs.type === 'number'), 'поля порта нет');
  assert.ok(textOf(root).includes('Подключение: через LIS Proxy — адрес лабораторного ПК меняется сам, править его не нужно.'));
  walk(root).find((n) => n.tagName === 'SELECT').value = 'mindray-bs-200';
  findButtonByText(root, /Сохранить/).click();
  await tick(60);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, JSON.stringify(writes) + ' ' + toastMsg);
  assert.deepStrictEqual(Object.keys(upd.values).sort(), ['enabled', 'model_confirmed', 'name', 'profile']);
  assert.ok(!rpcCalls.some((c) => c.name === 'lis_restart'), 'слушателей у прибора прокси нет');
});
```
Run: `node --experimental-vm-modules --test public/js/admin/__tests__/lab-devices-lisproxy.test.mjs`. Expected: FAIL (4 новых).

- [ ] **Step 4: экран.** В `public/js/admin/views/lab-devices.js`:
  - импорт `import { mountProxyCard } from './lab-proxy-card.js';` из задачи 10 дополнить двумя строками ниже:
```js
import { isProxyDevice, proxyAddress, bothPaths } from './lab-devices-lists.js?v=lists4';   // LIS_PROXY_V1
import { PROXY_MODELS } from '../../shared/lisproxy-models.js';   // LIS_PROXY_V1
```
  - после строки `const MODEL_REQUIRED = 'Выберите модель анализатора: …';` добавить:
```js
// LIS_PROXY_V1 — прибор за LIS Proxy (решение владельца 2026-10-09, п. 6). Тот же текст — у отказа сервера (rpc/lis.js).
const PROXY_MODEL_REQUIRED = 'Через LIS Proxy Easy-Med принимает только BS-200, BC-780 и AutoLumo A1000 — выберите одну из этих моделей.';
const PROXY_ADOPT_HINT = 'LIS Proxy не сообщает модель анализатора — выберите её: BS-200, BC-780 или AutoLumo A1000.';
const PROXY_FORM_NOTE = 'Подключение: через LIS Proxy — адрес лабораторного ПК меняется сам, править его не нужно.';
const BOTH_PATHS_NOTE = '{model} присылает результаты и напрямую, и через LIS Proxy. Если это один и тот же анализатор — оставьте один путь, иначе результаты придут дважды.';
```
  - в `devicesSig` найти строку `            split.table.map((d) => [d.id, d.name, d.profile, d.discovered, d.model_confirmed, d.transport, d.host, d.port, d.enabled,` и добавить после неё строку `                d.via, d.proxy_label, d.proxy_ip,   // LIS_PROXY_V1`;
  - там же после `            peerNotesSig(peerNotesNow(true)),   // LIS_VENDOR_EXACT_V1 — D14: беды соединений` добавить:
```js
            bothPaths(state.devices, serverNow()),   // LIS_PROXY_V1 — один анализатор, два пути
```
  - в `paintDevices` после `        if (noisy.length) devicesCard.appendChild(peerNotesBlock(noisy));` добавить:
```js
        // LIS_PROXY_V1 — одна модель слышна и напрямую, и через LIS Proxy: один анализатор — один приёмник.
        const both = bothPaths(state.devices, serverNow());
        if (both.length) {
            devicesCard.appendChild(peerNotesBlock(both.map((key) => {
                const p = profileOf(key);
                return { kind: 'warn', key: BOTH_PATHS_NOTE, params: { model: p ? p.model : key }, hintKey: null };
            })));
        }
```
  - `            const sum = serviceSummary(countsOf(d));` → `            const sum = serviceSummary(countsOf(d), { proxy: isProxyDevice(d) });   // LIS_PROXY_V1 — через прокси рабочий список отдаётся`;
  - найти
```js
                    conn && !dials ? h('div', { class: 'cell-mono muted', style: { fontSize: '12.5px' } }, d.host || tr('любой адрес')) : null,
```
  и заменить на
```js
                    conn && !dials && !isProxyDevice(d) ? h('div', { class: 'cell-mono muted', style: { fontSize: '12.5px' } }, d.host || tr('любой адрес')) : null,   // LIS_PROXY_V1 — у прокси адрес в строке выше
```
  - в `addWindowSig` найти
```js
            split.found.map((d) => [d.id, d.name, d.sending_app, d.host, d.port, d.enabled, d.profile, livenessText(d.last_seen_at, serverNow()).text]),
```
  и заменить на
```js
            split.found.map((d) => [d.id, d.name, d.sending_app, d.host, d.port, d.enabled, d.profile, livenessText(d.last_seen_at, serverNow()).text,
                d.via, d.proxy_name, d.proxy_label, d.proxy_ip]),   // LIS_PROXY_V1
```
  - в `paintAddWindow`:
    - `                    h('td', { style: { fontWeight: 600 } }, d.sending_app || d.name),` →
```js
                    // LIS_PROXY_V1 — находка LIS Proxy: «LIS Proxy · имя в прокси».
                    h('td', { style: { fontWeight: 600 } }, isProxyDevice(d) ? 'LIS Proxy · ' + (d.proxy_name || d.name) : (d.sending_app || d.name)),
```
    - `                    h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, d.host || tr('адрес неизвестен')),` →
```js
                    h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, isProxyDevice(d) ? proxyAddress(d) : (d.host || tr('адрес неизвестен'))),   // LIS_PROXY_V1
```
  - в `openAdopt`:
    - найти
```js
        const guessed = String(d.profile || '').trim();
        const profSel = h('select', null,
            h('option', { value: '', selected: !guessed ? true : null }, guessed ? tr('модель не определена') : tr('— выберите модель —')),
            ...state.profiles.map((p) => h('option', { value: p.key, selected: p.key === d.profile ? true : null }, p.vendor + ' ' + p.model)),
            state.profiles.length ? h('option', { value: GENERIC_MODEL }, tr(GENERIC_LABEL)) : null);
```
    заменить на
```js
        const guessed = String(d.profile || '').trim();
        // LIS_PROXY_V1 — находка LIS Proxy: модель не угадывается, выбор — из трёх (решение владельца 6), «общего HL7» нет.
        const proxy = isProxyDevice(d);
        const models = proxy ? state.profiles.filter((p) => PROXY_MODELS.includes(p.key)) : state.profiles;
        const profSel = h('select', null,
            h('option', { value: '', selected: !guessed ? true : null }, guessed ? tr('модель не определена') : tr('— выберите модель —')),
            ...models.map((p) => h('option', { value: p.key, selected: p.key === d.profile ? true : null }, p.vendor + ' ' + p.model)),
            state.profiles.length && !proxy ? h('option', { value: GENERIC_MODEL }, tr(GENERIC_LABEL)) : null);
```
    - найти
```js
            profileOf(d.profile)
                ? tr('Модель подобрана по тому, как прибор себя назвал, — проверьте её.')
                : tr('Модель по имени прибора не определилась — выберите её сами.')));
```
    заменить на
```js
            proxy ? tr(PROXY_ADOPT_HINT)   // LIS_PROXY_V1
            : profileOf(d.profile)
                ? tr('Модель подобрана по тому, как прибор себя назвал, — проверьте её.')
                : tr('Модель по имени прибора не определилась — выберите её сами.')));
```
    - `            if (!choice && !guessed) { toast(tr(MODEL_REQUIRED), 'warn'); profSel.focus(); return; }` →
```js
            if (!choice && (!guessed || proxy)) { toast(tr(proxy ? PROXY_MODEL_REQUIRED : MODEL_REQUIRED), 'warn'); profSel.focus(); return; }   // LIS_PROXY_V1 — proxy
```
    - после `                if (error.code === 'model_required') { toast(tr(MODEL_REQUIRED), 'warn'); profSel.focus(); return; }` добавить:
```js
                if (error.code === 'proxy_model_required') { toast(tr(PROXY_MODEL_REQUIRED), 'warn'); profSel.focus(); return; }   // LIS_PROXY_V1
```
  - в начале `openForm` найти
```js
    function openForm(device, { fromAdd = false } = {}) {
        state.formMode = 'edit';   // LIS_ANALYZER_LIST_V1
```
  и заменить на
```js
    function openForm(device, { fromAdd = false } = {}) {
        if (isProxyDevice(device)) { openProxyForm(device, { fromAdd }); return; }   // LIS_PROXY_V1
        state.formMode = 'edit';   // LIS_ANALYZER_LIST_V1
```
  - перед комментарием `    // Ревью M3 — форма, открытая из окна «Добавить прибор», возвращает туда` вставить:
```js
    // LIS_PROXY_V1 — «Изменить» прибор за LIS Proxy: название, модель (одна из трёх),
    // «включён». Адреса, порта и звонка у него нет: адрес лабораторного ПК прокси
    // сообщает сам (lab_devices.proxy_ip), слушать и звонить нечего.
    function openProxyForm(device, { fromAdd = false } = {}) {
        state.formMode = 'edit';
        state.backToAdd = fromAdd;
        formCard.style.display = '';
        clear(formCard);
        state.dialNodes.add = [];
        const nameInp = h('input', { type: 'text', value: device.name || '' });
        const models = state.profiles.filter((p) => PROXY_MODELS.includes(p.key));
        const profSel = h('select', null,
            h('option', { value: '', selected: !device.profile ? true : null }, tr('— выберите модель —')),
            ...models.map((p) => h('option', { value: p.key, selected: p.key === device.profile ? true : null }, p.vendor + ' ' + p.model)));
        const enabledInp = h('input', { type: 'checkbox', checked: device.enabled ? true : null });
        const conn = connectionOf(device);
        formCard.appendChild(h('div', { class: 'card-header' }, h('h3', null, trf('Анализатор: {name}', { name: device.name }))));
        const body = h('div', { class: 'ld-form' });
        body.appendChild(h('div', { class: 'ld-form-fields' }, field(tr('Название'), nameInp), field(tr('Модель'), profSel)));
        body.appendChild(h('div', { class: 'ld-form-notes muted' },
            conn ? h('p', null, trf(conn.key, conn.params)) : null,
            h('p', null, tr(PROXY_FORM_NOTE))));
        body.appendChild(h('label', { class: 'ld-form-check' }, enabledInp, h('span', null, tr('Включён — слушать этот прибор'))));
        body.appendChild(h('div', { class: 'ld-form-foot' },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, tr('Сохранить')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: leaveForm }, tr('Отмена')),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => removeDevice(device) }, tr('Удалить'))));
        formCard.appendChild(body);
        nameInp.focus();

        async function save() {
            const name = nameInp.value.trim();
            if (!name) { toast(tr('Укажите название прибора'), 'warn'); return; }
            if (!profSel.value) { toast(tr(PROXY_MODEL_REQUIRED), 'warn'); profSel.focus(); return; }
            // Только эти поля: transport, host, port, dial у строки прокси не трогаются.
            const res = await supabase.from('lab_devices').update({ name, profile: profSel.value, enabled: enabledInp.checked ? 1 : 0, model_confirmed: 1 }).eq('id', device.id);
            if (res.error) { toast(trf('Не удалось сохранить прибор: {msg}', { msg: res.error.message || res.error }), 'fail'); return; }
            toast(tr('Прибор сохранён'));
            const back = state.backToAdd;
            await reload();
            if (back) openAddWindow(); else closeForm();
        }
    }

```

- [ ] **Step 5: словарь приборов.** В начало `STRINGS` добавить:
```js
  // LIS_PROXY_V1 (2026-10-09) — экран «Анализаторы»: приборы за LIS Proxy (views/lab-devices.js, lab-devices-lists.js)
  "через LIS Proxy · {label} ({ip})": {"en":"via LIS Proxy · {label} ({ip})","ru":"через LIS Proxy · {label} ({ip})","uz":"LIS Proxy orqali · {label} ({ip})"},   // LIS_PROXY_V1
  "через LIS Proxy · {ip}": {"en":"via LIS Proxy · {ip}","ru":"через LIS Proxy · {ip}","uz":"LIS Proxy orqali · {ip}"},   // LIS_PROXY_V1
  "{model} присылает результаты и напрямую, и через LIS Proxy. Если это один и тот же анализатор — оставьте один путь, иначе результаты придут дважды.": {"en":"{model} sends results both directly and through LIS Proxy. If it is the same analyzer, keep one route, or the results will arrive twice.","ru":"{model} присылает результаты и напрямую, и через LIS Proxy. Если это один и тот же анализатор — оставьте один путь, иначе результаты придут дважды.","uz":"{model} natijalarni ham to‘g‘ridan-to‘g‘ri, ham LIS Proxy orqali yubormoqda. Agar bu bitta analizator bo‘lsa — bitta yo‘lni qoldiring, aks holda natijalar ikki marta keladi."},   // LIS_PROXY_V1
  "LIS Proxy не сообщает модель анализатора — выберите её: BS-200, BC-780 или AutoLumo A1000.": {"en":"LIS Proxy does not report the analyzer model — choose it: BS-200, BC-780 or AutoLumo A1000.","ru":"LIS Proxy не сообщает модель анализатора — выберите её: BS-200, BC-780 или AutoLumo A1000.","uz":"LIS Proxy analizator modelini aytmaydi — uni tanlang: BS-200, BC-780 yoki AutoLumo A1000."},   // LIS_PROXY_V1
  "Подключение: через LIS Proxy — адрес лабораторного ПК меняется сам, править его не нужно.": {"en":"Connection: via LIS Proxy — the lab PC’s address updates itself; no need to edit it.","ru":"Подключение: через LIS Proxy — адрес лабораторного ПК меняется сам, править его не нужно.","uz":"Ulanish: LIS Proxy orqali — laboratoriya kompyuteri manzili o‘zi yangilanadi, uni tahrirlash shart emas."},   // LIS_PROXY_V1
```

- [ ] **Step 6: прогнать.** Run:
  - `node --experimental-vm-modules --test public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` → PASS;
  - сторожа задачи 10 → `ℹ fail 0`;
  - плюс `public/js/admin/__tests__/db-query-schema.test.mjs`.

- [ ] **Step 7: коммит.** `git add --` `public/js/admin/views/lab-devices-lists.js public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/views/lab-devices.js public/js/admin/__tests__/lab-devices-lisproxy.test.mjs public/js/admin/i18n-strings.js`. Тема: `Анализаторы: приборы за LIS Proxy в таблице, находках, «Добавить» и «Изменить»; один анализатор — один приёмник (LIS_PROXY_V1)`.

---

## Task 12: Лоток — группы строк прибора LIS Proxy; инструкция «Через LIS Proxy» (LIS_PROXY_V1)

**Files:**
- Modify:
  - `public/js/admin/views/lab-devices-lists.js` (конец) и его тест;
  - `public/js/admin/views/lab-devices.js` (лоток ~1302, `attach` ~1348-1386, `dismiss` ~1390-1395, инструкция ~1206);
  - `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs`;
  - `public/js/admin/i18n-strings.js`.

- [ ] **Step 1: падающие тесты.**
  - в конец `public/js/admin/views/lab-devices-lists.test.mjs` добавить:
```js

import { groupProxyTray, PROXY_GROUP_WINDOW_MS } from './lab-devices-lists.js';

test('LIS Proxy: лоток — строки одного прибора прокси с тем же номером и состоянием за 10 минут — одной группой; прочие — как были', () => {
  const t = (min) => new Date(Date.parse('2026-10-09T12:00:00Z') - min * 60000).toISOString();
  const m = (id, device_id, sample_id, min, detail = 'x', status = 'unmatched') => ({ id, device_id, sample_id, status, detail, received_at: t(min) });
  const rows = [m(9, 1, '1', 0, 'a'), m(8, 1, '1', 2, 'b'), m(7, 9, '1', 3), m(6, 1, '1', 5, 'a'), m(5, 1, '2', 6), m(4, 1, '1', 0 + PROXY_GROUP_WINDOW_MS / 60000 + 1)];
  const g = groupProxyTray(rows, [PX, { id: 9 }]);
  assert.deepEqual(g.map((x) => [x.id, x.ids, x.count, x.details]), [
    [9, [9, 8, 6], 3, ['a', 'b']],
    [7, [7], 1, ['x']],
    [5, [5], 1, ['x']],
    [4, [4], 1, ['x']],
  ]);
});
```
  - в конец `public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` добавить:
```js

test('лоток: строки одного прибора LIS Proxy с тем же номером за 10 минут — одной строкой «значений: 3»; «Отклонить» — все', async () => {
  reset();
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  MESSAGES = [
    { id: 13, device_id: 1, sample_id: '1', status: 'unmatched', detail: 'LIS Proxy прислал не штрихкод пробирки: 1 — a', received_at: at(10), resolved_at: null, raw: '' },
    { id: 12, device_id: 1, sample_id: '1', status: 'unmatched', detail: 'LIS Proxy прислал не штрихкод пробирки: 1 — b', received_at: at(20), resolved_at: null, raw: '' },
    { id: 11, device_id: 1, sample_id: '1', status: 'unmatched', detail: 'LIS Proxy прислал не штрихкод пробирки: 1 — a', received_at: at(30), resolved_at: null, raw: '' },
    { id: 10, device_id: 3, sample_id: '7', status: 'unmatched', detail: 'другое', received_at: at(40), resolved_at: null, raw: '' },
  ];
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('значений: 3'), text);
  assert.ok(text.includes('ещё причин: 1'));
  const dismissButtons = findButtons(root).filter((b) => /Отклонить/.test(textOf(b)));
  assert.equal(dismissButtons.length, 2, 'группа и строка своего порта');
  dismissButtons[0].click();
  await tick(60);
  assert.deepStrictEqual(rpcCalls.filter((c) => c.name === 'lis_message_dismiss').map((c) => c.args.id), [13, 12, 11]);
});
```
  Run: `node --experimental-vm-modules --test public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/__tests__/lab-devices-lisproxy.test.mjs`. Expected: FAIL.

- [ ] **Step 2: правило группы.** В конец `public/js/admin/views/lab-devices-lists.js` добавить:
```js

/** Окно группы строк лотка одного прибора LIS Proxy. */
export const PROXY_GROUP_WINDOW_MS = 10 * 60 * 1000;

/**
 * LIS_PROXY_V1 (Р22) — прокси шлёт значение запросом, и контроль, находка до
 * «Добавить» или чужой номер — это 20–30 строк лотка на одну пробирку. Строки
 * одного прибора LIS Proxy с тем же номером пробы и тем же состоянием, пришедшие
 * в пределах 10 минут от самой новой строки группы, — одной строкой:
 * { ...самая новая, ids, count, details } (details — разные причины, новые первыми).
 * Прочие строки — как были (count 1). Порядок — как на входе (новые первыми).
 */
export function groupProxyTray(rows = [], devices = []) {
    const proxyIds = new Set((devices || []).filter(isProxyDevice).map((d) => d.id));
    const out = [];
    const open = new Map();
    for (const m of rows || []) {
        if (!m) continue;
        const detail = m.detail || '';
        if (!proxyIds.has(m.device_id)) { out.push({ ...m, ids: [m.id], count: 1, details: [detail] }); continue; }
        const key = m.device_id + '|' + (m.sample_id || '') + '|' + m.status;
        const t = Date.parse(m.received_at);
        const g = open.get(key);
        if (g && Number.isFinite(t) && Number.isFinite(g.newest) && g.newest - t <= PROXY_GROUP_WINDOW_MS) {
            g.ids.push(m.id);
            g.count += 1;
            if (!g.details.includes(detail)) g.details.push(detail);
            continue;
        }
        const ng = { ...m, ids: [m.id], count: 1, details: [detail], newest: t };
        open.set(key, ng);
        out.push(ng);
    }
    return out;
}
```

- [ ] **Step 3: лоток на экране.** В `public/js/admin/views/lab-devices.js`:
  - импорт `import { isProxyDevice, proxyAddress, bothPaths } from './lab-devices-lists.js?v=lists4';   // LIS_PROXY_V1` → `import { isProxyDevice, proxyAddress, bothPaths, groupProxyTray } from './lab-devices-lists.js?v=lists4';   // LIS_PROXY_V1`;
  - `        for (const m of previewRows(tray, 'tray')) {   // LD_LAYOUT_V1` → `        for (const m of previewRows(groupProxyTray(tray, state.devices), 'tray')) {   // LD_LAYOUT_V1; LIS_PROXY_V1 — группы строк прибора LIS Proxy (Р22)`;
  - после строки `                    staleRest != null ? trf('серия не дошла до конца: {rest}', { rest: staleRest }) : (m.detail || '—'),` добавить:
```js
                    // LIS_PROXY_V1 (Р22) — группа строк одного прибора LIS Proxy: сколько значений и сколько ещё причин.
                    m.count > 1
                        ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                            trf('значений: {n}', { n: m.count }),
                            m.details && m.details.length > 1 ? h('span', null, ' · ', trf('ещё причин: {n}', { n: m.details.length - 1 })) : null)
                        : null,
```
  - в `attach` найти `        const { data, error } = await supabase.rpc('lis_message_attach', { id: m.id, visit_service_id: vsId });` и заменить на:
```js
        // LIS_PROXY_V1 (Р22) — группа строк прибора LIS Proxy: номер один, строки — по очереди.
        const ids = Array.isArray(m.ids) && m.ids.length ? m.ids : [m.id];
        if (ids.length > 1) {
            let ok = 0;
            for (const id of ids) {
                const r = await supabase.rpc('lis_message_attach', { id, visit_service_id: vsId });
                if (r.error) { toast(r.error.message || String(r.error.code || r.error), 'warn'); break; }
                if (r.data && r.data.ok) ok += 1;
            }
            toast(trf('Привязано: {ok} из {n}', { ok, n: ids.length }), ok === ids.length ? 'ok' : 'warn');
            await reload();
            return;
        }
        const { data, error } = await supabase.rpc('lis_message_attach', { id: ids[0], visit_service_id: vsId });
```
  - в `dismiss` найти
```js
        if (!window.confirm(tr('Отклонить это сообщение? Оно останется в базе, но перестанет требовать внимания.'))) return;
        const { error } = await supabase.rpc('lis_message_dismiss', { id: m.id });
        if (error) { toast(trf('Не удалось отклонить сообщение: {msg}', { msg: error.message || error }), 'fail'); return; }
        await reload();
```
  и заменить на
```js
        // LIS_PROXY_V1 (Р22) — группа строк прибора LIS Proxy: одно подтверждение на все.
        const ids = Array.isArray(m.ids) && m.ids.length ? m.ids : [m.id];
        const question = ids.length > 1
            ? trf('Отклонить {n} сообщений? Они останутся в базе, но перестанут требовать внимания.', { n: ids.length })
            : tr('Отклонить это сообщение? Оно останется в базе, но перестанет требовать внимания.');
        if (!window.confirm(question)) return;
        for (const id of ids) {
            const { error } = await supabase.rpc('lis_message_dismiss', { id });
            if (error) { toast(trf('Не удалось отклонить сообщение: {msg}', { msg: error.message || error }), 'fail'); break; }
        }
        await reload();
```

- [ ] **Step 4: инструкция.** В `paintGuide` найти `        body.appendChild(h('p', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Важно')));` и вставить ПЕРЕД ней:
```js
        // LIS_PROXY_V1 — «Через LIS Proxy» (§5 документа LISPROXY-EASYMED.md).
        body.appendChild(h('p', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Через LIS Proxy (BS-200, BC-780, AutoLumo A1000)')));
        body.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '8px' } },
            tr('LIS Proxy — программа поставщика на лабораторном ПК. Она говорит с анализатором сама и передаёт Easy-Med каждое значение отдельно; для BS-200 она же загружает из Easy-Med список тестов по пробирке.')));
        body.appendChild(h('ol', { style: { paddingLeft: '20px', marginBottom: '8px' } },
            step(tr('В карточке «LIS Proxy» выше нажмите «Включить», затем «Копировать» — это адрес для LIS Proxy.')),
            step(tr('На лабораторном ПК закройте старую программу LIS этого анализатора: один анализатор — один приёмник. Если анализатор подключён к Easy-Med напрямую — отключите прямой путь.')),
            h('li', { style: { marginBottom: '6px' } },
                tr('В LIS Proxy (командная строка администратора) добавьте анализатор. Имя выберите один раз и не меняйте — по нему Easy-Med узнаёт прибор; -host — имя этого ПК, у каждого ПК своё; -timeout — всегда 100:'),
                commandBox('lisproxy add <name> -class <class> -ip <ip> -port <port> -host <pc> -api "<url>" -timeout 100')),
            step(tr('Тип в LIS Proxy: BS-200 — AsServerMindrayBS200, порт 5150 (на BS-200 в настройках хоста — адрес лабораторного ПК, не 127.0.0.1); BC-780 — AsClientMindrayBC780 с адресом и портом LIS самого BC-780; AutoLumo A1000 — AsServerAutoLumoA1860ASTM (на приборе: протокол ASTM, «As client», адрес ПК). BC-20, BC-5300 и CL-900i через LIS Proxy не подключайте — только напрямую.')),
            step(tr('Прогоните одну пробу. В «Добавить прибор» → «Найдены в сети» появится «LIS Proxy · <имя>»: нажмите «Добавить» и выберите модель, затем в «Панелях» выберите этот прибор у панели и подтвердите коды.')),
            step(tr('BS-200 загружает тесты сам: отсканируйте пробирку оплаченного заказа и запросите список — на экране прибора вместо имени будет номер пробирки.'))));
        body.appendChild(h('ul', { style: { paddingLeft: '20px', fontSize: '12.5px', marginBottom: '12px' } },
            h('li', { style: { marginBottom: '4px' } }, tr('В поле штрихкода на анализаторе — только этикетка LAB-. Номер пациента, номер места и голые цифры через LIS Proxy в бланк не ложатся — такие пробы ждут в «Необработанных».')),
            h('li', { style: { marginBottom: '4px' } }, tr('AutoLumo: номер пробы не короче 8 знаков (этикетка LAB-000123 подходит); короче — LIS Proxy его теряет.')),
            h('li', null, tr('В журнале LIS Proxy «Response Code : 404» — адрес устарел: скопируйте его здесь снова. «Response Code : 0» — Easy-Med был выключен: эти результаты потеряны, прогоните пробирки ещё раз.'))));

```

- [ ] **Step 5: словарь лотка и инструкции.** В начало `STRINGS` добавить:
```js
  // LIS_PROXY_V1 (2026-10-09) — экран «Анализаторы»: группы лотка и инструкция «Через LIS Proxy» (views/lab-devices.js)
  "значений: {n}": {"en":"values: {n}","ru":"значений: {n}","uz":"qiymatlar: {n}"},   // LIS_PROXY_V1
  "ещё причин: {n}": {"en":"more reasons: {n}","ru":"ещё причин: {n}","uz":"yana sabablar: {n}"},   // LIS_PROXY_V1
  "Отклонить {n} сообщений? Они останутся в базе, но перестанут требовать внимания.": {"en":"Dismiss {n} messages? They stay in the database but stop needing attention.","ru":"Отклонить {n} сообщений? Они останутся в базе, но перестанут требовать внимания.","uz":"{n} ta xabar rad etilsinmi? Ular bazada qoladi, lekin endi e’tibor talab qilmaydi."},   // LIS_PROXY_V1
  "Привязано: {ok} из {n}": {"en":"Attached: {ok} of {n}","ru":"Привязано: {ok} из {n}","uz":"Bog‘landi: {ok} / {n}"},   // LIS_PROXY_V1
  "Через LIS Proxy (BS-200, BC-780, AutoLumo A1000)": {"en":"Via LIS Proxy (BS-200, BC-780, AutoLumo A1000)","ru":"Через LIS Proxy (BS-200, BC-780, AutoLumo A1000)","uz":"LIS Proxy orqali (BS-200, BC-780, AutoLumo A1000)"},   // LIS_PROXY_V1
  "LIS Proxy — программа поставщика на лабораторном ПК. Она говорит с анализатором сама и передаёт Easy-Med каждое значение отдельно; для BS-200 она же загружает из Easy-Med список тестов по пробирке.": {"en":"LIS Proxy is the supplier’s program on the lab PC. It talks to the analyzer itself and sends Easy-Med each value separately; for the BS-200 it also downloads the test list for a tube from Easy-Med.","ru":"LIS Proxy — программа поставщика на лабораторном ПК. Она говорит с анализатором сама и передаёт Easy-Med каждое значение отдельно; для BS-200 она же загружает из Easy-Med список тестов по пробирке.","uz":"LIS Proxy — laboratoriya kompyuteridagi yetkazib beruvchi dasturi. U analizator bilan o‘zi gaplashadi va Easy-Med’ga har bir qiymatni alohida yuboradi; BS-200 uchun u Easy-Med’dan probirka bo‘yicha testlar ro‘yxatini ham yuklaydi."},   // LIS_PROXY_V1
  "В карточке «LIS Proxy» выше нажмите «Включить», затем «Копировать» — это адрес для LIS Proxy.": {"en":"In the «LIS Proxy» card above, press «Enable», then «Copy» — that is the address for LIS Proxy.","ru":"В карточке «LIS Proxy» выше нажмите «Включить», затем «Копировать» — это адрес для LIS Proxy.","uz":"Yuqoridagi «LIS Proxy» kartochkasida «Yoqish»ni, so‘ng «Nusxalash»ni bosing — bu LIS Proxy uchun manzil."},   // LIS_PROXY_V1
  "На лабораторном ПК закройте старую программу LIS этого анализатора: один анализатор — один приёмник. Если анализатор подключён к Easy-Med напрямую — отключите прямой путь.": {"en":"On the lab PC, close the analyzer’s old LIS program: one analyzer, one receiver. If the analyzer is connected to Easy-Med directly, turn the direct route off.","ru":"На лабораторном ПК закройте старую программу LIS этого анализатора: один анализатор — один приёмник. Если анализатор подключён к Easy-Med напрямую — отключите прямой путь.","uz":"Laboratoriya kompyuterida ushbu analizatorning eski LIS dasturini yoping: bitta analizator — bitta qabul qiluvchi. Agar analizator Easy-Med’ga to‘g‘ridan-to‘g‘ri ulangan bo‘lsa — to‘g‘ridan-to‘g‘ri yo‘lni o‘chiring."},   // LIS_PROXY_V1
  "В LIS Proxy (командная строка администратора) добавьте анализатор. Имя выберите один раз и не меняйте — по нему Easy-Med узнаёт прибор; -host — имя этого ПК, у каждого ПК своё; -timeout — всегда 100:": {"en":"In LIS Proxy (administrator command prompt), add the analyzer. Choose the name once and never change it — Easy-Med recognises the device by it; -host is this PC’s name, different on every PC; -timeout is always 100:","ru":"В LIS Proxy (командная строка администратора) добавьте анализатор. Имя выберите один раз и не меняйте — по нему Easy-Med узнаёт прибор; -host — имя этого ПК, у каждого ПК своё; -timeout — всегда 100:","uz":"LIS Proxy’da (administrator buyruq satri) analizatorni qo‘shing. Nomni bir marta tanlang va o‘zgartirmang — Easy-Med qurilmani shu nom bo‘yicha taniydi; -host — shu kompyuter nomi, har bir kompyuterda o‘ziniki; -timeout — doim 100:"},   // LIS_PROXY_V1
  "Тип в LIS Proxy: BS-200 — AsServerMindrayBS200, порт 5150 (на BS-200 в настройках хоста — адрес лабораторного ПК, не 127.0.0.1); BC-780 — AsClientMindrayBC780 с адресом и портом LIS самого BC-780; AutoLumo A1000 — AsServerAutoLumoA1860ASTM (на приборе: протокол ASTM, «As client», адрес ПК). BC-20, BC-5300 и CL-900i через LIS Proxy не подключайте — только напрямую.": {"en":"Type in LIS Proxy: BS-200 — AsServerMindrayBS200, port 5150 (on the BS-200 host settings, the lab PC’s address, not 127.0.0.1); BC-780 — AsClientMindrayBC780 with the BC-780’s own LIS address and port; AutoLumo A1000 — AsServerAutoLumoA1860ASTM (on the device: ASTM protocol, «As client», the PC’s address). Do not connect the BC-20, BC-5300 or CL-900i through LIS Proxy — directly only.","ru":"Тип в LIS Proxy: BS-200 — AsServerMindrayBS200, порт 5150 (на BS-200 в настройках хоста — адрес лабораторного ПК, не 127.0.0.1); BC-780 — AsClientMindrayBC780 с адресом и портом LIS самого BC-780; AutoLumo A1000 — AsServerAutoLumoA1860ASTM (на приборе: протокол ASTM, «As client», адрес ПК). BC-20, BC-5300 и CL-900i через LIS Proxy не подключайте — только напрямую.","uz":"LIS Proxy’dagi tur: BS-200 — AsServerMindrayBS200, port 5150 (BS-200 da xost sozlamalarida — laboratoriya kompyuteri manzili, 127.0.0.1 emas); BC-780 — AsClientMindrayBC780, BC-780 ning o‘z LIS manzili va porti bilan; AutoLumo A1000 — AsServerAutoLumoA1860ASTM (qurilmada: ASTM protokoli, «As client», kompyuter manzili). BC-20, BC-5300 va CL-900i ni LIS Proxy orqali ulamang — faqat to‘g‘ridan-to‘g‘ri."},   // LIS_PROXY_V1
  "Прогоните одну пробу. В «Добавить прибор» → «Найдены в сети» появится «LIS Proxy · <имя>»: нажмите «Добавить» и выберите модель, затем в «Панелях» выберите этот прибор у панели и подтвердите коды.": {"en":"Run one sample. «LIS Proxy · <name>» will appear in «Add a device» → «Found on the network»: press «Add» and choose the model, then in «Panels» pick this device for the panel and confirm the codes.","ru":"Прогоните одну пробу. В «Добавить прибор» → «Найдены в сети» появится «LIS Proxy · <имя>»: нажмите «Добавить» и выберите модель, затем в «Панелях» выберите этот прибор у панели и подтвердите коды.","uz":"Bitta namunani o‘tkazing. «Qurilma qo‘shish» → «Tarmoqda topilganlar»da «LIS Proxy · <nom>» paydo bo‘ladi: «Qoʻshish»ni bosing va modelni tanlang, so‘ng «Panellar»da panel uchun shu qurilmani tanlang va kodlarni tasdiqlang."},   // LIS_PROXY_V1
  "BS-200 загружает тесты сам: отсканируйте пробирку оплаченного заказа и запросите список — на экране прибора вместо имени будет номер пробирки.": {"en":"The BS-200 downloads the tests itself: scan the tube of a paid order and request the list — the device screen shows the tube number instead of a name.","ru":"BS-200 загружает тесты сам: отсканируйте пробирку оплаченного заказа и запросите список — на экране прибора вместо имени будет номер пробирки.","uz":"BS-200 testlarni o‘zi yuklaydi: to‘langan buyurtma probirkasini skanerlang va ro‘yxatni so‘rang — qurilma ekranida ism o‘rniga probirka raqami bo‘ladi."},   // LIS_PROXY_V1
  "В поле штрихкода на анализаторе — только этикетка LAB-. Номер пациента, номер места и голые цифры через LIS Proxy в бланк не ложатся — такие пробы ждут в «Необработанных».": {"en":"Only the LAB- label goes in the analyzer’s barcode field. A patient number, a position number or bare digits never reach a blank through LIS Proxy — such samples wait in «Unprocessed».","ru":"В поле штрихкода на анализаторе — только этикетка LAB-. Номер пациента, номер места и голые цифры через LIS Proxy в бланк не ложатся — такие пробы ждут в «Необработанных».","uz":"Analizatordagi shtrix-kod maydonida — faqat LAB- yorlig‘i. Bemor raqami, joy raqami va oddiy raqamlar LIS Proxy orqali blankaga tushmaydi — bunday namunalar «Qayta ishlanmagan»larda kutadi."},   // LIS_PROXY_V1
  "AutoLumo: номер пробы не короче 8 знаков (этикетка LAB-000123 подходит); короче — LIS Proxy его теряет.": {"en":"AutoLumo: the sample ID must be at least 8 characters (the LAB-000123 label is fine); LIS Proxy loses shorter ones.","ru":"AutoLumo: номер пробы не короче 8 знаков (этикетка LAB-000123 подходит); короче — LIS Proxy его теряет.","uz":"AutoLumo: namuna raqami 8 belgidan qisqa bo‘lmasin (LAB-000123 yorlig‘i mos keladi); qisqarog‘ini LIS Proxy yo‘qotadi."},   // LIS_PROXY_V1
  "В журнале LIS Proxy «Response Code : 404» — адрес устарел: скопируйте его здесь снова. «Response Code : 0» — Easy-Med был выключен: эти результаты потеряны, прогоните пробирки ещё раз.": {"en":"If the LIS Proxy log says «Response Code : 404», the address is out of date: copy it here again. «Response Code : 0» means Easy-Med was off: those results are lost, run the tubes again.","ru":"В журнале LIS Proxy «Response Code : 404» — адрес устарел: скопируйте его здесь снова. «Response Code : 0» — Easy-Med был выключен: эти результаты потеряны, прогоните пробирки ещё раз.","uz":"LIS Proxy jurnalida «Response Code : 404» — manzil eskirgan: uni shu yerdan qayta nusxalang. «Response Code : 0» — Easy-Med o‘chiq bo‘lgan: bu natijalar yo‘qolgan, probirkalarni qayta o‘tkazing."},   // LIS_PROXY_V1
```

- [ ] **Step 6: прогнать.** Run:
  - `node --experimental-vm-modules --test public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/__tests__/lab-devices-lisproxy.test.mjs` → PASS (`lab-devices-lisproxy` — 9);
  - сторожа задачи 10 (в том числе `lab-devices-tray.test.mjs` — лоток своего порта не изменился) → `ℹ fail 0`.

- [ ] **Step 7: коммит.** `git add --` `public/js/admin/views/lab-devices-lists.js public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/views/lab-devices.js public/js/admin/__tests__/lab-devices-lisproxy.test.mjs public/js/admin/i18n-strings.js`. Тема: `Анализаторы: лоток группирует строки прибора LIS Proxy; инструкция «Через LIS Proxy» (LIS_PROXY_V1)`.

---

## Task 13: Все фикстуры настоящей программы — тестами `node --test` (LIS_PROXY_V1)

**Files:**
- Create: `server/lis/lisproxy-fixtures.test.js`

- [ ] **Step 1: тест.** Create `server/lis/lisproxy-fixtures.test.js`:
```js
// LIS_PROXY_V1 — КАЖДАЯ запись harness\fixtures.json (тела, снятые с настоящего
// lisproxyd.exe 2026-10-09) через настоящее приложение: статус, ответ, строка
// журнала, бланк — по «expect» фикстуры и дизайну
// (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 10). Клиника —
// seedLisProxyClinic: № 123 Биохимия (GLU) на bs200, № 555 ОАК (WBC, HGB) на
// bc780x, № 777 B12 (214) на lumo; № 900001 — открытый свежий заказ другого
// пациента. Каждая запись — со свежей базой, кроме серии BC-780 (две подряд).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROXY_QUIET_PREFIX, PROXY_NOT_TUBE } from './lisproxy-form.js';
import { NOT_FOUND } from '../routes/lisproxy.js';
import { FIXTURES, freshDb, seedLisProxyClinic, startProxyApp, post, rows, lastRow, tray, blank } from '../test-helpers/lisproxy-clinic.js';

async function run(ids, check) {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db);
  try {
    const out = [];
    for (const [group, id] of ids) {
      const f = FIXTURES[group].find((x) => x.id === id);
      const res = await post(app.url, f.body);
      out.push({ status: res.status, text: await res.text(), row: lastRow(db), body: f.body });
    }
    await check(db, out, app);
  } finally { await app.close(); db.close(); }
}

const EXPECT = {
  results: {
    bs200_glu: (db, [r]) => {
      assert.equal(r.text, 'OK');
      assert.deepEqual([r.row.status, r.row.visit_service_id], ['applied', 123]);
      assert.deepEqual(blank(db, 123), { 'Глюкоза': '5.1' });
    },
    bs200_patient_number_as_barcode: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.visit_service_id], ['unmatched', null]);
      assert.ok(r.row.detail.startsWith(PROXY_NOT_TUBE + ': PATNUM9'));
    },
    bs200_bare_digits: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.visit_service_id], ['unmatched', null]);
      assert.deepEqual(blank(db, 900001), {}, 'открытый свежий заказ № 900001 другого пациента не тронут');
    },
    bc780_wbc: (db, [r]) => {
      assert.equal(r.row.visit_service_id, 555);
      assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63' });
    },
    bc780_hgb: (db, [r]) => {
      assert.equal(r.row.visit_service_id, 555);
      assert.deepEqual(blank(db, 555), { 'Гемоглобин': '132' });
    },
    bc780_junk_IS_empty: (db, [r]) => quiet(db, r),
    bc20_take_mode: (db, [r]) => quiet(db, r),
    bc20_test_mode: (db, [r]) => quiet(db, r),
    bc20_pv1_dept_as_barcode: (db, [r]) => {
      assert.equal(r.row.status, 'unmatched');
      assert.match(r.row.detail, /Therapy\^\^12 — проверьте тип анализатора в LIS Proxy/);
    },
    bc20_loinc_as_barcode: (db, [r]) => assert.equal(r.row.status, 'unmatched'),
    bc20_empty_barcode: (db, [r]) => assert.match(r.row.detail, /\(пусто\)/),
    lumo_truncated_barcode: (db, [r]) => {
      assert.deepEqual([r.row.status, r.row.sample_id], ['applied', 'LAB-000777']);
      assert.deepEqual(blank(db, 777), { 'Витамин B12': '28.4' });
    },
    lumo_numeric_id: (db, [r]) => assert.deepEqual([r.row.status, r.row.visit_service_id], ['unmatched', null]),
  },
  orders: {
    bs200_order: (db, [r]) => assert.deepEqual(JSON.parse(r.text),
      { 0: { clientId: 'LAB-000123', surname: '', name: '', date_birth: '03.02.1990', sex: '1', biomaterial_code: 'serum', code: 'GLU' } }),
    // Панель № 123 кормит BS-200 — у AutoLumo тот же номер ничего не получает; номер восстановлен.
    lumo_order_truncated: (db, [r]) => { assert.equal(r.text, '{}'); assert.equal(r.row.sample_id, 'LAB-000123'); },
  },
};
function quiet(db, r) {
  assert.ok(r.row.detail.startsWith(PROXY_QUIET_PREFIX), r.row.detail);
  assert.ok(r.row.resolved_at);
  assert.deepEqual(tray(db), []);
}

for (const group of ['results', 'orders', 'lists', 'unknown']) {
  for (const f of FIXTURES[group]) {
    test(`фикстура ${group}/${f.id}: 200, строка журнала с телом как пришло — ${f.expect}`, async () => {
      await run([[group, f.id]], async (db, out) => {
        const [r] = out;
        assert.equal(r.status, 200, 'на любой исход — 200');
        assert.equal(rows(db).length, 1, 'одна строка журнала');
        assert.equal(r.row.source_body, r.body, 'тело — байт в байт');
        if (group !== 'results') {
          assert.equal(r.row.kind, 'query');
          assert.ok(r.row.resolved_at, 'запрос — не в лотке');
          if (!(EXPECT[group] && EXPECT[group][f.id])) assert.equal(r.text, '{}');
        }
        const check = EXPECT[group] && EXPECT[group][f.id];
        if (check) await check(db, out);
      });
    });
  }
}

test('фикстуры BC-780 подряд: WBC, мусор IS, HGB — серия принята, лоток пуст', async () => {
  await run([['results', 'bc780_wbc'], ['results', 'bc780_junk_IS_empty'], ['results', 'bc780_hgb']], async (db, out) => {
    assert.equal(out[2].row.status, 'applied');
    assert.deepEqual(blank(db, 555), { 'Лейкоциты': '4.63', 'Гемоглобин': '132' });
    assert.deepEqual(tray(db), []);
  });
});

test('фикстуры auth: без ключа и с неверным ключом — тот же 404, что у неизвестного адреса; ничего не записано', async () => {
  const db = freshDb();
  seedLisProxyClinic(db);
  const app = await startProxyApp(db);
  try {
    const body = FIXTURES.results[0].body;
    for (const url of [app.base + '/api/lisproxy', app.base + '/api/lisproxy?key=WRONG']) {
      const res = await post(url, body);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), JSON.stringify(NOT_FOUND));
    }
    assert.deepEqual(rows(db), []);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM lab_devices WHERE last_seen_at IS NOT NULL").get().c, 0);
  } finally { await app.close(); db.close(); }
});

test('фикстуры покрыты все: в файле нет группы без теста', () => {
  assert.deepEqual(Object.keys(FIXTURES).filter((k) => k !== '_about').sort(), ['auth', 'lists', 'orders', 'results', 'unknown']);
  assert.deepEqual(FIXTURES.auth.map((a) => a.id), ['no_key', 'wrong_key']);
});
```

- [ ] **Step 2: прогнать.** Run: `node --test server/lis/lisproxy-fixtures.test.js`. Expected: PASS (26). Падение здесь — расхождение кода с дизайном: чинить код, а не ожидание.

- [ ] **Step 3: все LIS-тесты.** Run: `node --test $(ls server/lis/*.test.js)`. Expected: `ℹ fail 0`.

- [ ] **Step 4: коммит.** `git add -- server/lis/lisproxy-fixtures.test.js`. Тема: `LIS Proxy: все фикстуры настоящей программы — тестами node --test (LIS_PROXY_V1)`.

---

## Завершение (контролёр)

Переменные:
- `SP` = `C:\Users\user\AppData\Local\Temp\claude\c--Users-user-Desktop-ailos-agentic-system\cdaa5eb3-8422-4424-8c3a-38580164abe3\scratchpad`;
- `REPO` = `C:\Users\user\Desktop\implementation workflow\easymed.lisproxy`.

В Git Bash (команды C3–C4) задать так:
```
SP=/c/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad
REPO="/c/Users/user/Desktop/implementation workflow/easymed.lisproxy"
```

### C1. Весь набор — как в выпуске и как CI

Из корня клона:
1. `node --experimental-vm-modules --test` (= `npm test`, ~11 мин);
2. `node --experimental-vm-modules --import "C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad/force-en.mjs" --test` — английская локаль, как Ubuntu CI.

Ожидается `ℹ fail 0` в обоих. Известные помехи — не регрессия этой работы:
- **«bad port»** у HTTP-теста на этом ПК (динамические порты 1024–14999, память `windows-dynamic-port-fetch-bad-port`) — перезапустить этот файл отдельно;
- **`case-docs.test.js` «ДНЕВНИК ПИШУТ КАЖДЫЙ ДЕНЬ»** падает вечером (часы);
- **`branch-sync/journal.test.js` N1** — редкая помеха.

Любое другое падение — разобрать до пуша.

### C2. Проверка, которая пытается сломать (adversarial review)

Отдельный агент-рецензент с этим планом, спецификацией и `git diff 92cd84d..HEAD`. Задание — найти, как:
- пройти без ключа или угадать его по времени ответа; получить что-то кроме 404 без ключа (тело, заголовки, размер);
- положить значение чужому пациенту: голые цифры, `B-…` у не-AutoLumo, два ПК с одинаковым именем и подписью, «Привязать», серия по чужой строке прибора, D3;
- потерять значение: ответ не 200 при записанном журнале, вторая строка вместо дописанной, исключение до журнала;
- получить рабочий список неоплаченного, отменённого, выданного или чужого (другой прибор BS-200) заказа; увидеть имя пациента в ответе или в журнале прокси;
- сломать свой порт: `ensureDevice` берёт строку прокси, слушатели слушают её порт;
- обойти роли карточки (ключ врачу, кассе), записать `via` / `proxy_*` через `/api/db`;
- поймать пропуск в i18n или кегле.

Каждая находка — тест и правка отдельным коммитом с меткой `(LIS_PROXY_V1, ревью)`. Потом снова C1.

### C3. `replay_fixtures.py` против запущенного сервера (проверено на прототипе плана)

1. **Сид** — Write в `SP\lpx-replay-seed.mjs`:
```js
// LIS_PROXY_V1 — засеять папку данных для replay_fixtures.py и проверки настоящим
// lisproxyd.exe (план docs/plans/2026-10-09-lis-proxy-endpoint.md, «Завершение»).
// Запуск: node lpx-replay-seed.mjs <корень дерева easymed> <папка данных> [ключ]
// Папка данных — НОВАЯ, во временной папке (не data/ дерева). Создаёт
// easymed.db (все миграции + клиника стенда: № 123 GLU на bs200, № 555 WBC/HGB
// на bc780x, № 777 214 на lumo; приборы — с адреса 127.0.0.1) и lisproxy.json.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, dataDir, key = 'DEVKEY'] = process.argv.slice(2);
if (!root || !dataDir) { console.error('usage: node lpx-replay-seed.mjs <repo root> <data dir> [key]'); process.exit(2); }
if (fs.existsSync(path.join(dataDir, 'easymed.db'))) { console.error('В папке уже есть easymed.db — возьмите новую папку'); process.exit(2); }
fs.mkdirSync(dataDir, { recursive: true });
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { openDb } = await imp('server/db/connection.js');
const { migrate } = await imp('server/db/migrate.js');
const { seedLisProxyClinic } = await imp('server/test-helpers/lisproxy-clinic.js');
const { writeProxySettings } = await imp('server/lis/lisproxy-settings.js');

const db = openDb(path.join(dataDir, 'easymed.db'));
migrate(db);
seedLisProxyClinic(db);
db.close();
writeProxySettings(dataDir, { enabled: true, key });
console.log('засеяно:', dataDir, '— ключ', key);
```
и `SP\lpx-inspect.mjs`:
```js
// Show the LIS Proxy journal and blanks of a seeded data dir: node lpx-inspect.mjs <repo root> <data dir>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, dataDir] = process.argv.slice(2);
const { openDb } = await import(pathToFileURL(path.join(root, 'server/db/connection.js')).href);
const db = openDb(path.join(dataDir, 'easymed.db'));
for (const m of db.prepare('SELECT m.id, d.proxy_name AS dev, m.kind, m.status, m.visit_service_id AS vs, m.sample_id, CASE WHEN m.resolved_at IS NULL THEN 0 ELSE 1 END AS res, substr(m.detail, 1, 90) AS detail FROM lab_device_messages m LEFT JOIN lab_devices d ON d.id = m.device_id ORDER BY m.id').all()) console.log(JSON.stringify(m));
console.log('blanks', JSON.stringify(db.prepare('SELECT visit_service_id AS vs, parameter, value FROM lab_results ORDER BY id').all()));
console.log('tray', db.prepare("SELECT COUNT(*) c FROM lab_device_messages WHERE resolved_at IS NULL AND status <> 'applied'").get().c);
db.close();
```
2. **Запуск** (Git Bash, из корня клона):
   - `node "$SP/lpx-replay-seed.mjs" "$REPO" "$SP/lpx-data" DEVKEY`;
   - сервер: `EASYMED_DATA_DIR="$SP/lpx-data" PORT=8790 LIS_ENABLED=0 node server/index.js > "$SP/lpx-server.log" 2>&1 &`. Порт 8790 — не dev (:8000), не тестовая клиника (:8712); `LIS_ENABLED=0` — порт 2575 держит тестовая клиника;
   - ждать `curl -s http://127.0.0.1:8790/api/health` → `{"ok":true}`.
3. **Прогон:** `cd /c/Users/user/Desktop/analyzer-research/lisproxy/harness && python replay_fixtures.py "http://127.0.0.1:8790/api/lisproxy?key=DEVKEY"`.

   Ожидается (так и было на прототипе):
   - все `results` — `200 OK`;
   - `bs200_order` — `{"0":{"clientId":"LAB-000123","surname":"","name":"","date_birth":"03.02.1990","sex":"1","biomaterial_code":"serum","code":"GLU"}}`;
   - остальные `orders`, `lists`, `unknown` — `200 {}`;
   - `auth` — оба `404` с телом неизвестного адреса.
4. **Осмотр:** `node "$SP/lpx-inspect.mjs" "$REPO" "$SP/lpx-data"`.

   Строки журнала:

   | Строки | Что ожидается |
   |---|---|
   | 1 | `applied` № 123 |
   | 2, 3 | `unmatched`, без заказа (PATNUM9, 900001) |
   | 4, 5 | `applied` № 555 («принято серией (сообщение № 5)», «серия из 2 сообщений принята») |
   | 6–8 | справки, разрешены |
   | 9–11 | `unmatched` «не штрихкод пробирки» |
   | 12 | `applied` № 777, `LAB-000777` |
   | 13 | `unmatched` 12345678 |
   | 14 | `query`, «отдано тестов: 1 (GLU)» |
   | 15 | `query` lumo `LAB-000123`, «кормится анализатором другой модели» |
   | 16–21 | `query` cl900i, «прибор ещё не добавлен» |
   | 22 | `query`, пакетная загрузка |
   | 23 | `query`, незнакомый запрос |

   Бланки: № 123 Глюкоза 5.1, № 555 Лейкоциты 4.63 и Гемоглобин 132, № 777 Витамин B12 28.4. Лоток — 6.
5. **Остановить сервер:** PowerShell `Get-NetTCPConnection -LocalPort 8790 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }`.

### C4. Настоящая программа (только пока пробный период: до 2026-10-10 18:51)

По `C:\Users\user\Desktop\analyzer-research\lisproxy\harness\README.md` §2. **Только копия `lisproxyd.exe` во временной папке, никогда не `C:\Program Files\lisproxy\lisproxyd.exe`**: запуск оттуда запирает файл, и `install.bat` ломается наполовину.

1. **Подготовка:**
   - `mkdir "$SP/lisproxy-copy"`, туда — `lisproxyd.exe` и `lisproxy.exe` из `C:\Program Files\lisproxy\`;
   - `harness\real-proxy\lab-template.toml` → `$SP/lisproxy-copy/lab.toml`, `EASYMED_URL` → `http://127.0.0.1:8790/api/lisproxy?key=DEVKEY`.
2. **Свежая база:**
   - `node "$SP/lpx-replay-seed.mjs" "$REPO" "$SP/lpx-data-real" DEVKEY`;
   - сервер, как в C3, с `EASYMED_DATA_DIR="$SP/lpx-data-real"`.

   Приборы сида совпадут с прокси по адресу `127.0.0.1` и имени (`bs200`, `bc780x`, `lumo`); подписи из шаблона обновятся сами.
3. **Копия прокси:**
   - `"$SP/lisproxy-copy/lisproxyd.exe" -config "$SP/lisproxy-copy/lab.toml"` (в фоне);
   - `lisproxy -addr http://127.0.0.1:18091 admin set-password` и `… login`. Если пароль спрашивается интерактивно и в этом окне его не ввести — выполнить два шага в отдельном окне PowerShell вручную. Без входа нет `logs`, но приём проверяется по базе;
   - `lisproxy -addr http://127.0.0.1:18091 logs bs200` — смотреть ответы Easy-Med.
4. **BS-200:** `python real-proxy\hl7client.py 15150 real-proxy\msgs_bs200.txt`. Ожидается:
   - ACK (вид поставщика);
   - в базе — № 123 Глюкоза 5.1 `applied`;
   - на запрос — `QCK^Q02` с `QAK|SR|OK|` и `DSR^Q03`: DSP-1 = `LAB-000123`, DSP-4 = `19900203000000`, DSP-5 = `M`, DSP-26 = `serum`, DSP-29 = `GLU^^^`.
5. **BC-780:** `python real-proxy\fake_haem.py 15103 BC-780`, затем `lisproxy -addr http://127.0.0.1:18091 start bc780x`. Ожидается:
   - № 555 Лейкоциты и Гемоглобин;
   - серия принята;
   - служебные строки (Take Mode, Test Mode, IS) — справки;
   - прочие показатели — «LIS Proxy, справка: не использованы: …»;
   - лоток не растёт.
6. **AutoLumo:** `python real-proxy\astmclient.py 15170 LAB-000777 LAB-000777`. Ожидается:
   - № 777 214 `applied` (номер `B-000777` восстановлен);
   - на запрос — RSP с `^LAB-000777^` и `^214^1`.
7. **Большой рабочий список (без gzip):**
   - добавить к панели № 5 ещё 11 подтверждённых кодов (`node -e` с `bindPanel` из стенда: удалить панель 5, создать заново с `GLU` + `T1…T11`, как в тесте задачи 7);
   - в копию `msgs_bs200.txt` оставить только блок `QRY^Q02`, отправить её `hl7client.py`.

   Ожидается: DSR несёт DSP-29…DSP-40, в `logs` нет ошибки JSON.
8. **Уборка:**
   - убить копию: `netstat -ano | findstr 18091` → `taskkill /PID … /F`;
   - убить сервер 8790;
   - проверить, что настоящая служба отвечает: `lisproxy status`.

   Результат каждого шага — в отчёт. После 18:51 10.10 C4 пропускается; доложить, что не проверено на программе.

### C5. Пуш, без тега

- `git push origin feat/lis-proxy` (`origin` = `C:/Users/user/Desktop/implementation workflow/easymed.local`).
- **Тег не ставить, `--tags` не пушить** (выпуск — только по слову владельца).
- Миграция: если эта ветка выйдет раньше ветки CRM, её 237 и 238 придётся перенумеровать выше 239 (`migration-order.test.js`; память `easymed-migration-number-collisions`). Сказать об этом в отчёте.

### C6. Отчёт

- хэши коммитов;
- итог C1–C4 (числа тестов в обеих локалях);
- находки C2 и их правки;
- что не проверено на настоящей программе;
- вопросы владельцу (ниже).

---

## Вопросы владельцу (только то, что решает владелец)

1. **Контроль качества и чужие номера через LIS Proxy.**
   - По решению 3 короткий голый номер идёт в «Необработанные». Через прокси он приходит у контроля: у BS-200 в поле штрихкода — номер теста, у BC-780 — номер файла контроля. Свой порт отличает контроль по заголовку, прокси заголовка не передаёт.
   - Примерно: BS-200 — 15 тестов × 2 уровня ≈ 30 строк в день; BC-780 — около 25 показателей × 2–3 уровня ≈ 50–75 строк. На экране это 4–5 сгруппированных строк в день, которые надо «Отклонить».
   - Варианты:
     - **А (сделано сейчас, по решению 3)** — в лоток, сгруппированно;
     - **Б** — голые номера короче 6 цифр от прокси — справкой, без лотка (как контроль на своём порту);
     - **В** — выключить на анализаторах отправку контроля в LIS, если такая настройка есть.
2. **Рабочий список на своём порту.** Решение 1 включает рабочий список только через LIS Proxy; свой порт (BS-240, CL-900i) по-прежнему отвечает «заказов нет». Включать ли его и там — отдельной работой позже?
