# Список анализаторов: в «Добавить прибор» — только выходившие на связь — план реализации (LIS_ANALYZER_LIST_V1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Окно «Добавить прибор» показывает только анализаторы, которые что-то присылали. В таблице — только добавленные и выходившие на связь. Находка ждёт одного нажатия. «На связи» честно на любом разобранном сообщении.

**Architecture:**
- **База:** миграция 228 добавляет `lab_devices.added`, по умолчанию 1, и чинит `last_seen_at` по сообщениям. Новая находка (`discover.js`) заводится с `added = 0`.
- **Приём:** `ingest.js` отмечает прибор на любом разобранном сообщении.
- **Порты:** RPC `lis_listeners` говорит, какие порты слушаются, а какие не поднялись.
- **Экран:** чистый модуль `lab-devices-lists.js` раскладывает приборы по трём местам, а `lab-devices.js` рисует таблицу и окно «Добавить прибор».
- **Панели:** в «Анализатор» — только добавленные приборы.

**Tech Stack:** Node 24 ESM, better-sqlite3, `node:test`, ванильный JS, fake-DOM тесты видов.

**Спецификация:** `docs/specs/2026-09-29-lis-analyzer-list-design.md` (коммит `147133b`).

---

## Правила общего рабочего дерева (читать до первого шага)

- **Кто ещё здесь работает.** В этом дереве и на этой ветке (`feat/stock-own-shelf-suppliers-vat`) сейчас работает агент склада. Ветку не переключать, worktree не создавать, не пушить, тег не ставить.
- **Разрушительные команды запрещены:** `git checkout -- <файл>`, `git restore`, `git stash`, `git reset --hard`. Они стирают чужую незакоммиченную работу.
- **Никогда `git add -A` / `git add .`.** Полный `npm test` не запускать: только свои файлы, явными путями или глобом bash, не каталогом.
- **Номер миграции — 228**, он зарезервирован за этой задачей.
- **Перед каждым коммитом:**
  1. `git log --oneline -3`, `git status --short`;
  2. `git diff --cached --name-only` должен быть пуст; иначе ждать, пока хозяин закоммитит, и не снимать его работу с индекса;
  3. для каждого своего файла `git diff -U0 -- <файл>`.
- **Общие файлы:** `public/js/admin/i18n-strings.js`, `public/js/admin.js`, `server/services/control/gate.js`, `server/services/rpc/index.js`, `server/db/schema-registry.js`.
  - В них каждая своя вставка несёт метку `LIS_ANALYZER_LIST_V1` в добавленной строке: комментарий блока или хвост строки.
  - Индексировать только свои ханки, скриптом `C:\Users\user\AppData\Local\Temp\claude\c--Users-user-Desktop-ailos-agentic-system\cdaa5eb3-8422-4424-8c3a-38580164abe3\scratchpad\keep-hunks.mjs` (уже существует):

```bash
SP="C:/Users/user/AppData/Local/Temp/claude/c--Users-user-Desktop-ailos-agentic-system/cdaa5eb3-8422-4424-8c3a-38580164abe3/scratchpad"
git diff -U0 -- "$F" > "$SP/own-all.patch"
node "$SP/keep-hunks.mjs" LIS_ANALYZER_LIST_V1 < "$SP/own-all.patch" > "$SP/own.patch"
git apply --cached --check --unidiff-zero "$SP/own.patch" && git apply --cached --unidiff-zero "$SP/own.patch"
git diff --cached -- "$F"
```

- **Чужие ханки в необщем файле** — остановиться и доложить.
- **Концы строк:** сохранять те, что у файла. После коммита `git status` без фантомов.
- **Коммиты:** по-русски, в стиле репозитория, с меткой. Последняя строка — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Штампы кэша:**
  - `laboratory.js` импортирует `lab-devices.js?v=lisfields3` → `lisfields4`, и `lab-panels.js?v=panelsv5` → `panelsv6`;
  - `admin.js` импортирует `laboratory.js?v=labwords3` → `labwords4`;
  - `LAB_BUILD` в `lab-panels.js` → `'lab-v15'`.

---

## Карта файлов

| Файл | Что | Задача |
|---|---|---|
| `server/db/migrations/228_lab_device_added.sql` (новый) | колонка `added`, бэкфилл `last_seen_at` | 1 |
| `server/db/migrations/228.test.js` (новый) | тест миграции | 1 |
| `server/db/schema-registry.js` (общий) | `added` в чтении и `update` у `lab_devices` | 1 |
| `server/lis/discover.js` | новая находка `added = 0` | 2 |
| `server/lis/discover.test.js` | тест | 2 |
| `server/lis/ingest.js` | `touchDevice` на любом разобранном сообщении | 2 |
| `server/lis/ingest.test.js` | тесты | 2 |
| `server/lis/index.js` | учёт не поднявшихся портов, `listenerStatus()` | 3 |
| `server/lis/index.test.js` | тест занятого порта | 3 |
| `server/services/rpc/lis.js` | `lisListeners()` | 3 |
| `server/services/rpc/lis.test.js` | тест RPC | 3 |
| `server/services/rpc/index.js` (общий) | регистрация `lis_listeners` | 3 |
| `server/services/control/gate.js` (общий) | `lis_listeners` в `READ_ONLY_RPCS` | 3 |
| `public/js/admin/views/lab-devices-lists.js` (новый) | `splitDevices()`, `portState()` | 4 |
| `public/js/admin/views/lab-devices-lists.test.mjs` (новый) | тесты | 4 |
| `public/js/admin/views/lab-devices.js` | таблица, окно «Добавить прибор», добавление находки | 5 |
| `public/js/admin/__tests__/lab-devices-add.test.mjs` (новый) | тест вида | 5 |
| `public/js/admin/i18n-strings.js` (общий) | новые фразы | 5 |
| `public/js/admin/views/lab-panels.js` | «Анализатор» — только добавленные и привязанный | 6 |
| `public/js/admin/__tests__/lab-panels-device-codes.test.mjs` | фикстуры и тесты списка приборов | 6 |
| `public/js/admin/views/laboratory.js`, `public/js/admin.js` (общий) | штампы | 5, 6 |

---

### Задача 1: миграция 228 и реестр

**Files:**
- Create: `server/db/migrations/228_lab_device_added.sql`
- Test: `server/db/migrations/228.test.js`
- Modify (общий): `server/db/schema-registry.js`, блок `lab_devices:`

- [ ] **Шаг 1: падающий тест** — создать `server/db/migrations/228.test.js`:

```js
// LIS_ANALYZER_LIST_V1 (мигр. 228) — прибор «добавлен» или «найден, ждёт
// нажатия»; «на связи» — по самому позднему сообщению прибора.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SQL = fs.readFileSync(path.join(DIR, '228_lab_device_added.sql'), 'utf8');
// Бэкфилл — второе предложение файла: повторный накат проверяется им одним
// (ALTER TABLE второй раз не выполнить, и миграции второй раз не катятся).
const BACKFILL = SQL.slice(SQL.indexOf('UPDATE lab_devices'));

function dbBefore228() {
  const db = openDb(':memory:');
  const tmp = tmpDir('mig228-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 228)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}

test('228: колонка added, по умолчанию 1 — всё, что заводит человек, уже добавлено', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const id = db.prepare("INSERT INTO lab_devices (name, profile, transport, port) VALUES ('Руками','mindray-bc-5300','mllp',2575)").run().lastInsertRowid;
    assert.equal(db.prepare('SELECT added FROM lab_devices WHERE id = ?').get(id).added, 1);
    assert.throws(() => db.prepare("INSERT INTO lab_devices (name, added) VALUES ('Мусор', 2)").run(), /CHECK/);
  } finally { db.close(); }
});

test('228: существующие приборы остаются добавленными; «на связи» — по самому позднему сообщению', () => {
  const db = dbBefore228();
  try {
    const dev = db.prepare('INSERT INTO lab_devices (id, name, last_seen_at) VALUES (?, ?, ?)');
    dev.run(1, 'Без отметки, но слал', null);
    dev.run(2, 'Отметка старее сообщений', '2026-09-10T17:56:20Z');
    dev.run(3, 'Отметка новее сообщений', '2026-09-20T10:00:00Z');
    dev.run(4, 'Ни разу не выходил на связь', null);
    const msg = db.prepare("INSERT INTO lab_device_messages (device_id, peer, raw, status, received_at) VALUES (?, '127.0.0.1', 'MSH|', 'unmatched', ?)");
    msg.run(1, '2026-09-11T08:00:00Z'); msg.run(1, '2026-09-12T08:00:00Z');
    msg.run(2, '2026-09-14T08:02:50Z');
    msg.run(3, '2026-09-15T08:00:00Z');

    db.exec(SQL);
    const seen = (id) => db.prepare('SELECT last_seen_at, added FROM lab_devices WHERE id = ?').get(id);
    assert.equal(seen(1).last_seen_at, '2026-09-12T08:00:00Z');
    assert.equal(seen(2).last_seen_at, '2026-09-14T08:02:50Z', '«kjkj» слал до 14.09, а выглядел молчащим с 10.09');
    assert.equal(seen(3).last_seen_at, '2026-09-20T10:00:00Z', 'более свежая отметка не откатывается назад');
    assert.equal(seen(4).last_seen_at, null, 'кто не выходил на связь — тот и не выходил');
    for (const id of [1, 2, 3, 4]) assert.equal(seen(id).added, 1, 'из таблицы ничего не выпадает само');

    const before = db.prepare('SELECT id, last_seen_at, added FROM lab_devices ORDER BY id').all();
    db.exec(BACKFILL);
    assert.deepEqual(db.prepare('SELECT id, last_seen_at, added FROM lab_devices ORDER BY id').all(), before, 'повторный бэкфилл ничего не меняет');
  } finally { db.close(); }
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/db/migrations/228.test.js`
Expected: FAIL — `ENOENT … 228_lab_device_added.sql`.

- [ ] **Шаг 3: реализация** — создать `server/db/migrations/228_lab_device_added.sql`:

```sql
-- LIS_ANALYZER_LIST_V1 (2026-09-29) — В «ДОБАВИТЬ ПРИБОР» ТОЛЬКО ТЕ, КТО ВЫХОДИЛ НА СВЯЗЬ.
--
-- Решения владельца (2026-09-28/29): окно «Добавить прибор» показывает
-- анализаторы, которые действительно что-то присылали; таблица — только
-- выходившие на связь; новая находка ждёт одного нажатия «Добавить», а её
-- результаты тем временем сохраняются (приём от этой колонки не зависит).
--
-- added = 1 — прибор в клинике (таблица или «Ждут первого сообщения»);
-- added = 0 — найден сам и ждёт нажатия. По умолчанию 1: всё, что заводит
-- человек, и все строки, существовавшие до миграции, уже добавлены — из
-- таблицы само ничего не выпадает. 0 ставит только сервер (discover.js).
ALTER TABLE lab_devices ADD COLUMN added INTEGER NOT NULL DEFAULT 1 CHECK (added IN (0, 1));

-- «На связи» ставилась только когда проба ложилась в бланк; прибор, чьи пробы
-- не находили заказ, выглядел молчащим неделями. Чиним прошлое: самое позднее
-- сообщение прибора — его последняя связь, если оно позже отметки. Повторный
-- накат ничего не меняет: условие уже не выполняется.
UPDATE lab_devices
   SET last_seen_at = (SELECT MAX(m.received_at) FROM lab_device_messages m WHERE m.device_id = lab_devices.id)
 WHERE EXISTS (SELECT 1 FROM lab_device_messages m
                WHERE m.device_id = lab_devices.id
                  AND (lab_devices.last_seen_at IS NULL OR m.received_at > lab_devices.last_seen_at));
```

In `server/db/schema-registry.js`, in the `lab_devices:` block, replace the `read:` line with:

```js
    read:  { roles: ALL_STAFF, columns: ['id','name','profile','transport','host','port','folder_path','serial_port','serial_baud','enabled','last_seen_at','created_at','discovered','added'] },   // discovered: LIS_AUTODISCOVER_V1 (mig 124) — ставит только сервер; added: LIS_ANALYZER_LIST_V1 (мигр. 228)
```

and replace the `update:` line with:

```js
             update: { roles: LAB_SECTION_ROLES, columns: ['name','profile','transport','host','port','folder_path','serial_port','serial_baud','enabled','discovered','added'] },   // added: LIS_ANALYZER_LIST_V1 — «Добавить» переводит находку в таблицу
```

(`insert` колонку не получает: по умолчанию 1.)

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test server/db/migrations/228.test.js server/db/migrations/123.test.js`
Expected: PASS.

- [ ] **Шаг 5: коммит** (`228_*` — `git add`; `schema-registry.js` — через `keep-hunks.mjs`)

```bash
git add -- server/db/migrations/228_lab_device_added.sql server/db/migrations/228.test.js
# server/db/schema-registry.js — свои ханки (метка LIS_ANALYZER_LIST_V1)
git commit -m "Анализаторы: признак «добавлен» у прибора и «на связи» по самому позднему сообщению (LIS_ANALYZER_LIST_V1, мигр. 228)"
```

---

### Задача 2: находка ждёт нажатия; «на связи» на любом разобранном сообщении

**Files:**
- Modify: `server/lis/discover.js` (INSERT в конце `ensureDevice`)
- Modify: `server/lis/ingest.js` (после `const base = …`; убрать два поздних `touchDevice`)
- Test: `server/lis/discover.test.js`, `server/lis/ingest.test.js`

- [ ] **Шаг 1: падающие тесты**

В конец `server/lis/discover.test.js`:

```js
// LIS_ANALYZER_LIST_V1 — находка ждёт нажатия «Добавить» (решение владельца
// 2026-09-29); строка, заведённая человеком, уже добавлена.
test('новая находка заводится «не добавленной», заведённый руками — добавлен', () => {
  const db = fresh();
  const out = ensureDevice(db, { sendingApp: 'BC-5300', peer: '10.0.0.12', port: 2575 });
  assert.equal(out.created, true);
  assert.equal(out.device.added, 0, 'находка ждёт одного нажатия в «Добавить прибор»');
  const id = db.prepare("INSERT INTO lab_devices (name, profile) VALUES ('Руками', 'mindray-bs-240')").run().lastInsertRowid;
  assert.equal(db.prepare('SELECT added FROM lab_devices WHERE id = ?').get(id).added, 1);
  db.close();
});
```

В конец `server/lis/ingest.test.js`:

```js
// ── LIS_ANALYZER_LIST_V1 — «на связи» на любом разобранном сообщении ────────
const lastSeen = (db) => db.prepare('SELECT last_seen_at FROM lab_devices WHERE id = 1').get().last_seen_at;

test('проба со смазанным штрихкодом (unmatched) всё равно отмечает прибор «на связи»', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-999999', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'unmatched');
  assert.ok(lastSeen(db), 'прибор говорил — значит, он на связи («kjkj» выглядел молчащим неделю)');
  db.close();
});

test('проба без привязанной панели (unmapped) отмечает прибор; мусор (rejected) — нет', () => {
  const db = fresh();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1', 1);
  assert.equal(message(db).status, 'unmapped');
  assert.ok(lastSeen(db));
  db.close();

  const db2 = fresh();
  ingestMessage(db2, 'это не HL7', '127.0.0.1', 1);
  assert.equal(message(db2).status, 'rejected');
  assert.equal(lastSeen(db2), null, 'неразобранное не доказывает, что говорил анализатор');
  db2.close();
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/lis/discover.test.js server/lis/ingest.test.js`
Expected: FAIL: `out.device.added` = 1 (not 0), and `lastSeen(db)` = null for unmatched/unmapped.

- [ ] **Шаг 3: реализация**

В `server/lis/discover.js` заменить

```js
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered)
                         VALUES (?, ?, 'mllp', ?, ?, 1, 1)`)
```

на

```js
  // LIS_ANALYZER_LIST_V1 — находка ждёт одного нажатия «Добавить» в окне
  // «Добавить прибор» (added = 0; решение владельца 2026-09-29). Приём от
  // этого не зависит: пробы найденного прибора сохраняются и ложатся в бланки
  // по тем же правилам.
  const id = db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added)
                         VALUES (?, ?, 'mllp', ?, ?, 1, 1, 0)`)
```

В `server/lis/ingest.js` сразу после строки `  const base = { deviceId, peer, raw, sampleId: msg.sampleId };` добавить:

```js
  // LIS_ANALYZER_LIST_V1 — «на связи» на ЛЮБОМ разобранном сообщении известного
  // прибора. Раньше отметка ставилась, только когда проба ложилась в бланк:
  // прибор, чьи пробы не находили заказ, выглядел молчащим неделями («kjkj» —
  // «молчит с 10.09», а слал до 14.09). Мусор (rejected, выше) прибор не
  // отмечает: неразобранное не доказывает, что говорил анализатор.
  touchDevice(db, deviceId);
```

и удалить ставшие лишними вызовы: `    touchDevice(db, deviceId);` в ветке `superseded` (перед её `return 'AA';`) и `  touchDevice(db, deviceId);` перед последним `  return 'AA';` функции.

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test server/lis/*.test.js server/services/rpc/lis.test.js`
Expected: PASS все (закреплённый тест «успешный приём отмечает, что прибор на связи» — тоже).

- [ ] **Шаг 5: коммит** (файлы не общие)

```bash
git add -- server/lis/discover.js server/lis/discover.test.js server/lis/ingest.js server/lis/ingest.test.js
git commit -m "Анализаторы: находка ждёт «Добавить»; «на связи» — на любом разобранном сообщении, а не только на лёгшей пробе (LIS_ANALYZER_LIST_V1)"
```

---

### Задача 3: какие порты слушаются — RPC `lis_listeners`

**Files:**
- Modify: `server/lis/index.js`
- Test: `server/lis/index.test.js`
- Modify: `server/services/rpc/lis.js`, `server/services/rpc/lis.test.js`
- Modify (общие): `server/services/rpc/index.js`, `server/services/control/gate.js`

- [ ] **Шаг 1: падающие тесты**

В `server/lis/index.test.js`: в импорты наверху добавить (если чего-то нет) `import net from 'node:net';` и `listenerStatus` в импорт из `./index.js`. Для базы использовать `openDb`/`migrate`, как делает сам файл. В конец файла:

```js
// LIS_ANALYZER_LIST_V1 — порт, который не поднялся, виден экрану, а не только
// в журнале сервера: строка «порт N не слушается» у ждущего прибора.
test('занятый порт виден как «не слушается», а не пропадает молча', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '0.0.0.0', r));
  const busy = blocker.address().port;
  const prev = process.env.LIS_PORT;
  process.env.LIS_PORT = String(busy);
  const db = openDb(':memory:');
  migrate(db);
  try {
    await startLisListeners(db, { log: () => {} });
    const st = listenerStatus();
    assert.ok(st.failed.some((f) => f.port === busy && f.error), JSON.stringify(st));
    assert.ok(!st.listening.includes(busy));
  } finally {
    await stopLisListeners();
    await new Promise((r) => blocker.close(r));
    if (prev === undefined) delete process.env.LIS_PORT; else process.env.LIS_PORT = prev;
    db.close();
  }
});
```

В `server/services/rpc/lis.test.js` расширить импорт из `./lis.js` на `lisListeners` и добавить `import { isReadOnlyRpc } from '../control/gate.js';`, если его нет. В конец:

```js
test('LIS_ANALYZER_LIST_V1: какие порты слушаются — только лаборатории, чистое чтение', () => {
  const db = fresh();
  assert.throws(() => lisListeners(db, {}, { role: 'reception' }), /прав/);
  const out = lisListeners(db, {}, LAB);
  assert.ok(Array.isArray(out.listening), JSON.stringify(out));
  assert.ok(Array.isArray(out.failed));
  assert.equal(isReadOnlyRpc('lis_listeners'), true, 'экран читает это и при просроченной лицензии');
  db.close();
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test server/lis/index.test.js server/services/rpc/lis.test.js`
Expected: FAIL — `listenerStatus` / `lisListeners` не экспортированы.

- [ ] **Шаг 3: реализация**

В `server/lis/index.js`:
1. Строку `let running = [];` заменить на:

```js
let running = [];
// LIS_ANALYZER_LIST_V1 — порты, которые не поднялись (занял кто-то другой):
// экран «Анализаторы» говорит это у ждущего прибора, а не только журнал.
let failed = [];
```

2. В `startLisListeners` сразу после `  await stopLisListeners();` добавить `  failed = [];`.
3. В `catch (e)` цикла по портам, перед строкой `      log('LIS: ' + (e && e.message ? e.message : e));`, добавить:

```js
      failed.push({ port, error: e && e.message ? e.message : String(e) });
```

4. В конец файла:

```js
/**
 * LIS_ANALYZER_LIST_V1 — какие порты слушаются прямо сейчас и какие не
 * поднялись. Для строки «порт N слушается» у ждущего прибора в окне
 * «Добавить прибор» — это и есть проверка связи с нашей стороны.
 */
export function listenerStatus() {
  return { listening: running.map((s) => s.port), failed: failed.map((f) => ({ ...f })) };
}
```

В `server/services/rpc/lis.js` строку `import { startLisListeners } from '../../lis/index.js';` заменить на `import { startLisListeners, listenerStatus } from '../../lis/index.js';` и в конец файла добавить:

```js
/**
 * LIS_ANALYZER_LIST_V1 — какие порты слушаются прямо сейчас и какие не
 * поднялись. Экран показывает это у приборов, которые ждут первого сообщения:
 * «порт 2575 слушается» — с нашей стороны всё готово, дело в настройке прибора;
 * «порт 5100 не слушается» — его заняла другая программа.
 */
export function lisListeners(db, args, user) {
  guard(user);
  return listenerStatus();
}
```

В `server/services/rpc/index.js` (общий) в строке импорта из `'./lis.js'` добавить `lisListeners` в список и дописать в хвост её комментария `, LIS_ANALYZER_LIST_V1`. Сразу после строки `  lis_device_codes:         (db, args, user) => lisDeviceCodes(db, args, user),` вставить:

```js
  // LIS_ANALYZER_LIST_V1 — какие порты слушаются: строка у ждущего прибора
  // в «Добавить прибор». Чистое чтение (gate.js).
  lis_listeners:            (db, args, user) => lisListeners(db, args, user),
```

В `server/services/control/gate.js` (общий) сразу после строки `  'lis_device_codes',` вставить:

```js
  // LIS_ANALYZER_LIST_V1 — какие порты слушаются; чистое чтение.
  'lis_listeners',
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test server/lis/index.test.js server/lis/mllp.test.js server/services/rpc/lis.test.js public/js/admin/__tests__/rpc-exists.test.mjs`
Expected: PASS.

- [ ] **Шаг 5: коммит** (`server/lis/index.js`, `index.test.js`, `rpc/lis.js`, `lis.test.js` — `git add`; `rpc/index.js` и `gate.js` — через `keep-hunks.mjs`)

```bash
git add -- server/lis/index.js server/lis/index.test.js server/services/rpc/lis.js server/services/rpc/lis.test.js
# server/services/rpc/index.js и server/services/control/gate.js — свои ханки (метка LIS_ANALYZER_LIST_V1)
git commit -m "Анализаторы: RPC lis_listeners — какие порты слушаются и какие не поднялись (LIS_ANALYZER_LIST_V1)"
```

---

### Задача 4: чистое правило «кто где стоит» — `lab-devices-lists.js`

**Files:**
- Create: `public/js/admin/views/lab-devices-lists.js`
- Test: `public/js/admin/views/lab-devices-lists.test.mjs`

- [ ] **Шаг 1: падающие тесты** — создать `public/js/admin/views/lab-devices-lists.test.mjs`:

```js
// lab-devices-lists.test.mjs — где стоит прибор на экране «Анализаторы»
// (LIS_ANALYZER_LIST_V1). Чистое правило: список на входе, раскладка на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDevices, portState } from './lab-devices-lists.js';

const D = (id, added, last_seen_at, extra = {}) => ({ id, name: 'П' + id, added, last_seen_at, port: 2575, ...extra });

test('три места: таблица, «Найдены в сети», «Ждут первого сообщения»', () => {
  const s = splitDevices([
    D(1, 1, '2026-09-28T13:52:09Z'),   // добавлен и говорил — таблица
    D(2, 0, '2026-09-29T08:00:00Z'),   // найден сам — ждёт «Добавить»
    D(3, 1, null),                     // добавлен руками, молчит — ждёт сообщения
  ]);
  assert.deepEqual(s.table.map((d) => d.id), [1]);
  assert.deepEqual(s.found.map((d) => d.id), [2]);
  assert.deepEqual(s.waiting.map((d) => d.id), [3]);
});

test('сервер до миграции 228 (added нет) — прибор не пропадает из таблицы', () => {
  const s = splitDevices([{ id: 7, name: 'Старый', last_seen_at: '2026-09-10T17:56:20Z' }]);
  assert.deepEqual(s.table.map((d) => d.id), [7]);
});

test('порт ждущего прибора: слушается, не поднялся, выключен, неизвестно', () => {
  const st = { listening: [2575], failed: [{ port: 5100, error: 'порт 5100 уже занят' }] };
  assert.deepEqual(portState({ port: 2575 }, st), { kind: 'listening', port: 2575 });
  assert.deepEqual(portState({ port: 5100 }, st), { kind: 'failed', port: 5100, error: 'порт 5100 уже занят' });
  assert.deepEqual(portState({ port: 6000 }, st), { kind: 'off', port: 6000 });
  assert.deepEqual(portState({ port: 2575 }, null), { kind: 'unknown', port: 2575 });
  assert.equal(portState({}, st).port, 2575, 'порт не задан — значит, порт по умолчанию');
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test public/js/admin/views/lab-devices-lists.test.mjs`
Expected: FAIL — модуль не найден.

- [ ] **Шаг 3: реализация** — создать `public/js/admin/views/lab-devices-lists.js`:

```js
// LIS_ANALYZER_LIST_V1 — ГДЕ СТОИТ ПРИБОР на экране «Анализаторы». Чистые
// функции: ни DOM, ни словаря, ни сети. Тот же приём, что у lab-devices-live.js:
// проверять надо правило, а не разметку.
//
// Три состояния (решения владельца 2026-09-28/29):
//   найден, не добавлен          added = 0                     → «Добавить прибор» → «Найдены в сети»
//   добавлен, ждёт сообщения     added = 1, last_seen_at пуст  → «Добавить прибор» → «Ждут первого сообщения»
//   добавлен и выходил на связь  added = 1, last_seen_at есть  → таблица
// Нет поля added (сервер старее миграции 228) — прибор считается добавленным:
// из таблицы ничего не должно пропадать само.

/** @returns {{table:object[], found:object[], waiting:object[]}} */
export function splitDevices(devices = []) {
    const table = [], found = [], waiting = [];
    for (const d of devices) {
        const added = d.added == null ? true : Number(d.added) === 1;
        if (!added) found.push(d);
        else if (d.last_seen_at) table.push(d);
        else waiting.push(d);
    }
    return { table, found, waiting };
}

/**
 * Слушается ли порт прибора прямо сейчас (lis_listeners). Проверка связи с
 * НАШЕЙ стороны: «слушается» — Easy-Med готов, дело в настройке прибора;
 * «не поднялся» — порт занят другой программой; «выключен» — прибор или приём
 * выключены; «неизвестно» — ответа сервера ещё нет.
 * @returns {{kind:'listening'|'failed'|'off'|'unknown', port:number, error?:string}}
 */
export function portState(device, status) {
    const port = Number(device && device.port) || 2575;
    if (!status) return { kind: 'unknown', port };
    if ((status.listening || []).includes(port)) return { kind: 'listening', port };
    const f = (status.failed || []).find((x) => Number(x.port) === port);
    if (f) return { kind: 'failed', port, error: f.error || '' };
    return { kind: 'off', port };
}
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs`
Expected: PASS.

- [ ] **Шаг 5: коммит** (файлы новые)

```bash
git add -- public/js/admin/views/lab-devices-lists.js public/js/admin/views/lab-devices-lists.test.mjs
git commit -m "Анализаторы: правило «кто где стоит» — таблица, найденные, ждущие — чистым модулем (LIS_ANALYZER_LIST_V1)"
```

---

### Задача 5: экран «Анализаторы» — таблица и окно «Добавить прибор»

**Files:**
- Modify: `public/js/admin/views/lab-devices.js`
- Modify: `public/js/admin/views/laboratory.js` (штамп `lisfields4`), `public/js/admin.js` (общий, штамп `labwords4`)
- Modify (общий): `public/js/admin/i18n-strings.js`
- Test: `public/js/admin/__tests__/lab-devices-add.test.mjs` (новый)

- [ ] **Шаг 1: падающий тест вида** — создать `public/js/admin/__tests__/lab-devices-add.test.mjs`.

Шапка и импорты:

```js
// LIS_ANALYZER_LIST_V1 (2026-09-29) — Лаборатория → «Анализаторы»: таблица и
// окно «Добавить прибор».
//
// Владелец: «list of the analyzers when adding a dynamic list, which will be
// empty if analyzer not plugged or connected … (which shouldn't be there if
// its not connected)». Таблица — только выходившие на связь; находка ждёт
// одного нажатия «Добавить»; пусто — окно объясняет, как подключить.
import { test } from 'node:test';
import assert from 'node:assert';
```

Дальше **дословно** скопировать строки 13–78 из `public/js/admin/__tests__/lab-devices-tray.test.mjs`: от `// Fake-DOM harness — copied from …` до `document.getElementById = (id) => (id === 'toast' ? toastEl : null);` включительно.

Затем фикстуры, fake-сервер и тесты:

```js
const findButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findButtons(root).find((b) => re.test(textOf(b)));

// --- fake сервер -----------------------------------------------------------
let DEVICES = [];
let writes = [];
let rpcCalls = [];
const PROFILES = [{ key: 'mindray-bc-5300', vendor: 'Mindray', model: 'BC-5300', channelsSource: 'screenshot', defaultPort: 2575, channels: [] }];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') { writes.push(body); return { ok: true, json: async () => ({ data: [] }) }; }
    if (body && body.table === 'lab_devices') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(DEVICES)) }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') return { ok: true, json: async () => ({ data: PROFILES }) };
    if (name === 'lis_listeners') return { ok: true, json: async () => ({ data: { listening: [2575], failed: [] } }) };
    if (name === 'lis_restart') return { ok: true, json: async () => ({ data: { ok: true, listeners: 1 } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const HEARD = { id: 1, name: 'kjkj', profile: 'mindray-bc-5300', transport: 'mllp', host: '', port: 2575, enabled: 1, added: 1, discovered: 0, last_seen_at: '2026-09-14T08:02:50Z' };
const FOUND = { id: 5, name: 'BC-5300', profile: 'mindray-bc-5300', transport: 'mllp', host: '127.0.0.1', port: 2575, enabled: 1, added: 0, discovered: 1, last_seen_at: '2026-09-29T08:00:00Z' };
const WAITING = { id: 4, name: 'jjjj', profile: 'mindray-bc-5300', transport: 'mllp', host: '', port: 2575, enabled: 1, added: 1, discovered: 0, last_seen_at: null };

async function mount() {
  writes = []; rpcCalls = []; toastMsg = null;
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();   // живой опрос тесту не нужен
  return root;
}

test('таблица — только добавленные и выходившие на связь; кнопка называет число найденных', async () => {
  DEVICES = [HEARD, FOUND, WAITING];
  const root = await mount();
  const table = walk(root).find((n) => n.tagName === 'TABLE');
  const text = textOf(table);
  assert.ok(text.includes('kjkj'), 'выходивший на связь — в таблице');
  assert.ok(!text.includes('jjjj'), 'ни разу не выходивший — не в таблице');
  assert.ok(!text.includes('BC-5300'), 'находка — не в таблице, пока не нажали «Добавить»');
  assert.ok(findButtonByText(root, /Добавить прибор · найдено 1/), 'кнопка говорит, что есть находка');
});

test('окно «Добавить прибор»: находка с «Добавить», ждущий со строкой о порте, ручной путь', async () => {
  DEVICES = [HEARD, FOUND, WAITING];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const text = textOf(root);
  assert.ok(text.includes('Найдены в сети'));
  assert.ok(text.includes('127.0.0.1'), 'адрес находки виден');
  assert.ok(text.includes('Ждут первого сообщения'));
  assert.ok(text.includes('порт 2575 слушается — ждём первое сообщение'), 'проверка связи с нашей стороны');
  assert.ok(findButtonByText(root, /Анализатор не появился\? Добавить по адресу/), 'ручной путь остаётся');
});

test('«Добавить» у находки переводит её в таблицу: added = 1, модель подтверждена', async () => {
  DEVICES = [HEARD, FOUND];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const addRow = findButtons(root).find((b) => /^\s*(<svg[\s\S]*?<\/svg>)?\s*Добавить\s*$/.test(textOf(b)));
  assert.ok(addRow, 'у находки есть кнопка «Добавить»');
  addRow.click();
  await tick();
  const save = findButtons(root).filter((b) => /Добавить/.test(textOf(b))).pop();
  save.click();
  await tick(60);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, 'записано: ' + JSON.stringify(writes));
  assert.strictEqual(upd.values.added, 1);
  assert.strictEqual(upd.values.discovered, 0, 'человек проверил модель — пометка «найден сам» снята');
  assert.strictEqual(upd.values.name, 'BC-5300');
  assert.ok(JSON.stringify(upd.filters || []).includes('5'), 'обновлена именно находка: ' + JSON.stringify(upd.filters));
});

test('ничего не подключено — окно пусто и объясняет, как подключить', async () => {
  DEVICES = [HEARD];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const text = textOf(root);
  assert.ok(text.includes('Ни один анализатор пока не выходил на связь.'));
  assert.ok(text.includes('порт 2575, протокол HL7'), 'сказано, что настроить на приборе');
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test public/js/admin/__tests__/lab-devices-add.test.mjs`
Expected: FAIL — в таблице есть «jjjj», нет «найдено 1», нет «Найдены в сети».

- [ ] **Шаг 3: реализация в `public/js/admin/views/lab-devices.js`**

3.1. После строки `import { liveness } from './lab-devices-live.js';   // …` добавить:

```js
import { splitDevices, portState } from './lab-devices-lists.js';   // LIS_ANALYZER_LIST_V1 — таблица / найдены / ждут
```

3.2. Строку `    const state = { devices: [], profiles: [], messages: [], recent: [], loadError: null };` заменить на:

```js
    // LIS_ANALYZER_LIST_V1 — listeners: какие порты слушаются (lis_listeners);
    // formMode: что открыто под таблицей ('add' | 'adopt' | 'edit' | null) —
    // живой опрос перерисовывает окно «Добавить прибор», но не форму, в которой печатают.
    const state = { devices: [], profiles: [], messages: [], recent: [], loadError: null, listeners: null, formMode: null };
```

3.3. В `reload()`:
- в `Promise.all` добавить пятым элементом `supabase.rpc('lis_listeners', {}),`;
- деструктуризацию `const [devRes, msgRes, profRes, recentRes] =` сделать `const [devRes, msgRes, profRes, recentRes, lisRes] =`;
- после `state.recent = recentRes.data || [];` добавить `state.listeners = (lisRes && lisRes.data) || null;   // LIS_ANALYZER_LIST_V1`;
- после `paintTray();` добавить `if (state.formMode === 'add') paintAddWindow();   // LIS_ANALYZER_LIST_V1 — список живой`.

3.4. В `paintDevices()`:
- в начале функции, после `clear(devicesCard);`, добавить `const split = splitDevices(state.devices);   // LIS_ANALYZER_LIST_V1`;
- кнопку `h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openForm(null) }, Icon('Plus', { size: 13 }), ' ', tr('Добавить прибор'))` заменить на:

```js
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: openAddWindow },
                Icon('Plus', { size: 13 }), ' ',
                split.found.length ? trf('Добавить прибор · найдено {n}', { n: split.found.length }) : tr('Добавить прибор'))));
```

- блок `if (!state.devices.length) { … tr('Приборов пока нет — …') … return; }` заменить на:

```js
        // LIS_ANALYZER_LIST_V1 — в таблице только добавленные и выходившие на
        // связь (решение владельца 2026-09-28). Находки и молчащие — в окне
        // «Добавить прибор».
        if (!split.table.length) {
            devicesCard.appendChild(h('div', { class: 'empty', style: { padding: '26px 20px' } },
                h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, tr('Подключённых анализаторов нет.')),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    split.found.length
                        ? trf('Найдено новых: {n} — откройте «Добавить прибор».', { n: split.found.length })
                        : tr('Откройте «Добавить прибор»: там появится анализатор, как только пришлёт первую пробу.'))));
            return;
        }
```

- в цикле `for (const d of state.devices) {` заменить `state.devices` на `split.table`.

3.5. Вложенную в `openForm` функцию `async function remove(dev) { … }` вынести на уровень `mountLabDevices` под именем `removeDevice(dev)`, тело то же. В `openForm` кнопку «Удалить» переключить на `removeDevice(device)`.

3.6. В `openForm(device)`:
- первой строкой тела добавить `state.formMode = 'edit';   // LIS_ANALYZER_LIST_V1`;
- сразу после `formCard.appendChild(notReady);` добавить:

```js
        // LIS_ANALYZER_LIST_V1 — честная строка ручного пути: прибор-сервер
        // (программа LIS звонит ему сама) пока не поддержан.
        if (!device) {
            formCard.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px' } },
                tr('Анализаторы, которые сами ждут звонка от программы LIS (например, Mindray BC-3600), пока не поддерживаются: такой прибор не отправит результаты сам.')));
        }
```

- в `save()` строки `            closeForm();\n            await reload();` заменить на:

```js
            closeForm();
            await reload();
            // LIS_ANALYZER_LIST_V1 — новый прибор по адресу ждёт первого
            // сообщения: показать его там, где он теперь стоит.
            if (!device) openAddWindow();
```

3.7. В `closeForm()` первой строкой тела добавить `state.formMode = null;   // LIS_ANALYZER_LIST_V1`.

3.8. Сразу перед `    function closeForm() {` добавить функции окна:

```js
    // ---------- окно «Добавить прибор» (LIS_ANALYZER_LIST_V1) ----------
    //
    // Владелец (2026-09-28): «list of the analyzers when adding a dynamic list,
    // which will be empty if analyzer not plugged or connected». Здесь только те,
    // кто что-то присылал и ждёт нажатия «Добавить»; добавленные руками, но ещё
    // молчащие — ниже, со строкой о порте. Ручной путь — ссылкой внизу.

    function openAddWindow() {
        state.formMode = 'add';
        formCard.style.display = '';
        paintAddWindow();
    }

    function paintAddWindow() {
        clear(formCard);
        const split = splitDevices(state.devices);
        formCard.appendChild(h('div', { class: 'card-header' },
            h('h3', null, tr('Добавить анализатор')),
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: closeForm }, tr('Закрыть'))));

        formCard.appendChild(h('div', { style: { fontWeight: 600, margin: '4px 0 8px' } }, tr('Найдены в сети')));
        if (!split.found.length) {
            formCard.appendChild(h('div', { class: 'empty', style: { padding: '18px 16px' } },
                h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, tr('Ни один анализатор пока не выходил на связь.')),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    trf('На анализаторе в настройках связи (LIS) укажите адрес {ip}, порт 2575, протокол HL7 и отправьте пробу — анализатор появится здесь сам.', { ip: hostForGuide() }))));
        } else {
            const tb = h('tbody');
            for (const d of split.found) {
                const p = profileOf(d.profile);
                const live = livenessText(d.last_seen_at);
                tb.appendChild(h('tr', null,
                    h('td', { style: { fontWeight: 600 } }, d.name),
                    h('td', { class: 'muted' }, p ? p.vendor + ' ' + p.model : tr('модель не определена')),
                    h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } }, d.host || tr('адрес неизвестен')),
                    h('td', null, live.kind === 'idle'
                        ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, live.text)
                        : Tag(live.text, { kind: live.kind })),
                    h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openAdopt(d) }, Icon('Plus', { size: 13 }), ' ', tr('Добавить')),
                        ' ',
                        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => removeDevice(d) }, tr('Удалить')))));
            }
            formCard.appendChild(h('table', { class: 'list' },
                h('thead', null, h('tr', null,
                    h('th', null, tr('Как назвался')), h('th', null, tr('Модель')), h('th', null, tr('Адрес')),
                    h('th', null, tr('Связь')), h('th', null, ''))),
                tb));
        }

        if (split.waiting.length) {
            formCard.appendChild(h('div', { style: { fontWeight: 600, margin: '14px 0 8px' } }, tr('Ждут первого сообщения')));
            const tb = h('tbody');
            for (const d of split.waiting) {
                const ps = portState(d, state.listeners);
                const portText = ps.kind === 'listening' ? trf('порт {port} слушается — ждём первое сообщение', { port: ps.port })
                    : ps.kind === 'failed' ? trf('порт {port} не слушается: {error}', { port: ps.port, error: ps.error })
                    : ps.kind === 'off' ? trf('порт {port} сейчас не слушается', { port: ps.port })
                    : '';
                tb.appendChild(h('tr', null,
                    h('td', { style: { fontWeight: 600 } }, d.name),
                    h('td', { class: 'cell-mono', style: { fontSize: '12.5px' } },
                        d.transport === 'mllp'
                            ? trf('{host}:{port}', { host: d.host || tr('любой адрес'), port: d.port || 2575 })
                            : tr(TRANSPORT_LABEL[d.transport] || d.transport)),
                    h('td', null, portText ? Tag(portText, { kind: ps.kind === 'listening' ? '' : 'warn' }) : null),
                    h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openForm(d) }, Icon('Edit', { size: 13 }), ' ', tr('Изменить')),
                        ' ',
                        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => removeDevice(d) }, tr('Удалить')))));
            }
            formCard.appendChild(h('table', { class: 'list' }, tb));
        }

        formCard.appendChild(h('div', { style: { marginTop: '12px' } },
            h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openForm(null) },
                tr('Анализатор не появился? Добавить по адресу'))));
    }

    // «Добавить» у находки: название подставлено, модель — догадка по имени;
    // человек проверяет и нажимает — прибор уходит в таблицу. Пометка «найден
    // сам — проверьте модель» снимается: модель проверил человек.
    function openAdopt(d) {
        state.formMode = 'adopt';
        clear(formCard);
        const nameInp = h('input', { type: 'text', value: d.name || '' });
        const profSel = h('select', null,
            h('option', { value: '', selected: !d.profile ? true : null }, tr('модель не определена')),
            ...state.profiles.map((p) => h('option', { value: p.key, selected: p.key === d.profile ? true : null }, p.vendor + ' ' + p.model)));
        formCard.appendChild(h('div', { class: 'card-header' }, h('h3', null, trf('Добавить «{name}»', { name: d.name }))));
        formCard.appendChild(h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap', marginBottom: '10px' } },
            field(tr('Название'), nameInp), field(tr('Модель'), profSel)));
        formCard.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px' } },
            profileOf(d.profile)
                ? tr('Модель подобрана по тому, как прибор себя назвал, — проверьте её.')
                : tr('Модель по имени прибора не определилась — выберите её сами.')));
        formCard.appendChild(h('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: save }, tr('Добавить')),
            h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: openAddWindow }, tr('Назад'))));

        async function save() {
            const name = nameInp.value.trim();
            if (!name) { toast(tr('Укажите название прибора'), 'warn'); return; }
            const { error } = await supabase.from('lab_devices')
                .update({ name, profile: profSel.value, added: 1, discovered: 0 }).eq('id', d.id);
            if (error) { toast(trf('Не удалось добавить прибор: {msg}', { msg: error.message || error }), 'fail'); return; }
            toast(trf('Прибор «{name}» добавлен', { name }));
            closeForm();
            await reload();
        }
    }
```

3.9. В `public/js/admin/views/laboratory.js` — `lab-devices.js?v=lisfields3` → `lab-devices.js?v=lisfields4`. В `public/js/admin.js` (общий) — `laboratory.js?v=labwords3` → `laboratory.js?v=labwords4`, и в конец этой строки дописать ` · LIS_ANALYZER_LIST_V1`.

3.10. В `public/js/admin/i18n-strings.js` (общий) после строки с ключом `"Вернуться к списку"` вставить блок. Каждый ключ сначала проверить `grep -n '"<ключ>"'`; уже существующий («Закрыть», «Добавить», «Удалить», «Адрес», «Назад», «Модель», «Название» и т. п.) второй раз не добавлять.

```js
  // LIS_ANALYZER_LIST_V1 (2026-09-29) — «Добавить прибор»: только выходившие на связь
  "Добавить прибор · найдено {n}": {"en":"Add a device · found {n}","ru":"Добавить прибор · найдено {n}","uz":"Qurilma qo‘shish · topildi {n}"},
  "Подключённых анализаторов нет.": {"en":"No connected analyzers.","ru":"Подключённых анализаторов нет.","uz":"Ulangan analizatorlar yo‘q."},
  "Найдено новых: {n} — откройте «Добавить прибор».": {"en":"New ones found: {n} — open «Add a device».","ru":"Найдено новых: {n} — откройте «Добавить прибор».","uz":"Yangi topilganlar: {n} — «Qurilma qo‘shish»ni oching."},
  "Откройте «Добавить прибор»: там появится анализатор, как только пришлёт первую пробу.": {"en":"Open «Add a device»: an analyzer appears there as soon as it sends its first sample.","ru":"Откройте «Добавить прибор»: там появится анализатор, как только пришлёт первую пробу.","uz":"«Qurilma qo‘shish»ni oching: analizator birinchi namunani yuborishi bilan u yerda paydo bo‘ladi."},
  "Добавить анализатор": {"en":"Add an analyzer","ru":"Добавить анализатор","uz":"Analizator qo‘shish"},
  "Найдены в сети": {"en":"Found on the network","ru":"Найдены в сети","uz":"Tarmoqda topilganlar"},
  "Ни один анализатор пока не выходил на связь.": {"en":"No analyzer has contacted Easy-Med yet.","ru":"Ни один анализатор пока не выходил на связь.","uz":"Hozircha birorta analizator bog‘lanmagan."},
  "На анализаторе в настройках связи (LIS) укажите адрес {ip}, порт 2575, протокол HL7 и отправьте пробу — анализатор появится здесь сам.": {"en":"On the analyzer, in its LIS connection settings, enter address {ip}, port 2575, protocol HL7, and send a sample — the analyzer will appear here by itself.","ru":"На анализаторе в настройках связи (LIS) укажите адрес {ip}, порт 2575, протокол HL7 и отправьте пробу — анализатор появится здесь сам.","uz":"Analizatorning aloqa (LIS) sozlamalarida {ip} manzilini, 2575 portini va HL7 protokolini kiriting, so‘ng namuna yuboring — analizator shu yerda o‘zi paydo bo‘ladi."},
  "модель не определена": {"en":"model not identified","ru":"модель не определена","uz":"model aniqlanmadi"},
  "адрес неизвестен": {"en":"address unknown","ru":"адрес неизвестен","uz":"manzil noma’lum"},
  "Как назвался": {"en":"Name it gave","ru":"Как назвался","uz":"O‘zini qanday atagan"},
  "Ждут первого сообщения": {"en":"Waiting for the first message","ru":"Ждут первого сообщения","uz":"Birinchi xabarni kutmoqda"},
  "порт {port} слушается — ждём первое сообщение": {"en":"port {port} is listening — waiting for the first message","ru":"порт {port} слушается — ждём первое сообщение","uz":"{port} port tinglanmoqda — birinchi xabar kutilmoqda"},
  "порт {port} не слушается: {error}": {"en":"port {port} is not listening: {error}","ru":"порт {port} не слушается: {error}","uz":"{port} port tinglanmayapti: {error}"},
  "порт {port} сейчас не слушается": {"en":"port {port} is not listening right now","ru":"порт {port} сейчас не слушается","uz":"{port} port hozir tinglanmayapti"},
  "Анализатор не появился? Добавить по адресу": {"en":"Analyzer did not appear? Add it by address","ru":"Анализатор не появился? Добавить по адресу","uz":"Analizator paydo bo‘lmadimi? Manzil bo‘yicha qo‘shish"},
  "Добавить «{name}»": {"en":"Add «{name}»","ru":"Добавить «{name}»","uz":"«{name}»ni qo‘shish"},
  "Модель подобрана по тому, как прибор себя назвал, — проверьте её.": {"en":"The model was guessed from the name the analyzer gave — please check it.","ru":"Модель подобрана по тому, как прибор себя назвал, — проверьте её.","uz":"Model analizator o‘zini qanday ataganiga qarab tanlandi — uni tekshiring."},
  "Модель по имени прибора не определилась — выберите её сами.": {"en":"The model could not be identified from the analyzer's name — choose it yourself.","ru":"Модель по имени прибора не определилась — выберите её сами.","uz":"Model analizator nomidan aniqlanmadi — uni o‘zingiz tanlang."},
  "Не удалось добавить прибор: {msg}": {"en":"Could not add the device: {msg}","ru":"Не удалось добавить прибор: {msg}","uz":"Qurilmani qo‘shib bo‘lmadi: {msg}"},
  "Прибор «{name}» добавлен": {"en":"Device «{name}» added","ru":"Прибор «{name}» добавлен","uz":"«{name}» qurilmasi qo‘shildi"},
  "Анализаторы, которые сами ждут звонка от программы LIS (например, Mindray BC-3600), пока не поддерживаются: такой прибор не отправит результаты сам.": {"en":"Analyzers that wait for the LIS program to call them (for example, Mindray BC-3600) are not supported yet: such a device will not send results by itself.","ru":"Анализаторы, которые сами ждут звонка от программы LIS (например, Mindray BC-3600), пока не поддерживаются: такой прибор не отправит результаты сам.","uz":"LIS dasturi o‘ziga qo‘ng‘iroq qilishini kutadigan analizatorlar (masalan, Mindray BC-3600) hozircha qo‘llab-quvvatlanmaydi: bunday qurilma natijalarni o‘zi yubormaydi."},
```

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test public/js/admin/__tests__/lab-devices-add.test.mjs public/js/admin/__tests__/lab-devices-tray.test.mjs public/js/admin/views/lab-devices.test.mjs public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/__tests__/lab-panels-mode.test.mjs public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs public/js/admin/__tests__/english-literals-v3120.test.mjs public/js/admin/__tests__/icons.test.mjs public/js/admin/__tests__/rpc-exists.test.mjs`
Expected: PASS.

Если локатор теста цепляет не тот элемент (кнопок «Добавить…» несколько), разрешено сузить поиск внутри карточки окна. Проверки при этом не меняются: об этом написать в отчёте.

- [ ] **Шаг 5: коммит** (`lab-devices.js`, `laboratory.js`, новый тест — `git add`; `admin.js`, `i18n-strings.js` — через `keep-hunks.mjs`)

```bash
git add -- public/js/admin/views/lab-devices.js public/js/admin/views/laboratory.js public/js/admin/__tests__/lab-devices-add.test.mjs
# public/js/admin.js и public/js/admin/i18n-strings.js — свои ханки (метка LIS_ANALYZER_LIST_V1)
git commit -m "Анализаторы: в таблице — только выходившие на связь; «Добавить прибор» — найденные, ждущие и ручной путь по адресу (LIS_ANALYZER_LIST_V1)"
```

---

### Задача 6: «Анализатор» у панели — только добавленные и привязанный

**Files:**
- Modify: `public/js/admin/views/lab-panels.js` (чтение `lab_devices`, список `devSel`, `LAB_BUILD`)
- Modify: `public/js/admin/views/laboratory.js` (штамп `panelsv6`)
- Test: `public/js/admin/__tests__/lab-panels-device-codes.test.mjs`

- [ ] **Шаг 1: падающие тесты**

В `public/js/admin/__tests__/lab-panels-device-codes.test.mjs`:
- в фикстуре `DEVICES` первому прибору добавить `added: 1`, вторым элементом добавить находку `{ id: 2, name: 'Найденный BC-5300', profile: 'mindray-bc-5300', enabled: 1, added: 0 }`;
- в конец файла:

```js
// LIS_ANALYZER_LIST_V1 — у панели выбирают из ДОБАВЛЕННЫХ приборов: находка,
// которую ещё не добавили, не выглядит выбранным прибором. Уже привязанный
// показывается всегда — иначе привязка молча стала бы «— нет —».
const deviceSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT'
  && walk(n).some((o) => o.tagName === 'OPTION' && textOf(o) === '— нет —'));

test('«Анализатор» у панели: находка, которую не добавили, не предлагается', async () => {
  setEffectiveFromRole(LAB_SEEDED);
  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick(80);
  const labels = walk(deviceSelect(root)).filter((n) => n.tagName === 'OPTION').map((o) => textOf(o));
  assert.ok(labels.includes('Гематология'), labels.join(' | '));
  assert.ok(!labels.includes('Найденный BC-5300'), 'ненажатая находка не в списке');
});

test('«Анализатор» у панели: уже привязанный прибор виден, даже если он не добавлен', async () => {
  const was = PANELS[0].device_id;
  PANELS[0].device_id = 2;
  try {
    setEffectiveFromRole(LAB_SEEDED);
    const root = mk('div');
    await renderLaboratory(root, { payload: { sub: 'panels' } });
    await tick(80);
    const labels = walk(deviceSelect(root)).filter((n) => n.tagName === 'OPTION').map((o) => textOf(o));
    assert.ok(labels.includes('Найденный BC-5300'), 'привязка не превращается молча в «— нет —»: ' + labels.join(' | '));
  } finally { PANELS[0].device_id = was; }
});
```

- [ ] **Шаг 2: убедиться, что падает**

Run: `node --test public/js/admin/__tests__/lab-panels-device-codes.test.mjs`
Expected: FAIL в первом новом тесте — «Найденный BC-5300» в списке.

- [ ] **Шаг 3: реализация** в `public/js/admin/views/lab-panels.js`:

1. В чтении приборов `supabase.from('lab_devices').select('id, name, profile, enabled')` → `supabase.from('lab_devices').select('id, name, profile, enabled, added')`.
2. Строку `            ...state.devices.map(d => h('option', { value: String(d.id), selected: Number(p.device_id) === d.id },` заменить на:

```js
            // LIS_ANALYZER_LIST_V1 — только добавленные приборы (находка ждёт
            // «Добавить» на экране «Анализаторы») плюс уже привязанный.
            ...state.devices.filter(d => d.added == null || Number(d.added) === 1 || Number(p.device_id) === d.id)
                .map(d => h('option', { value: String(d.id), selected: Number(p.device_id) === d.id },
```

Скобки хвоста выражения сохранить: прежний `.map(...)` закрывался `)))),` — пересчитать.

3. `export const LAB_BUILD = 'lab-v14';` → `export const LAB_BUILD = 'lab-v15';`, в комментарий дописать `; v15 — в «Анализатор» только добавленные (LIS_ANALYZER_LIST_V1)`.
4. В `public/js/admin/views/laboratory.js` — `lab-panels.js?v=panelsv5` → `lab-panels.js?v=panelsv6`.

- [ ] **Шаг 4: убедиться, что проходит**

Run: `node --test public/js/admin/__tests__/lab-panels-device-codes.test.mjs public/js/admin/__tests__/lab-panels-mode.test.mjs public/js/admin/views/lab-device-codes.test.mjs`
Expected: PASS.

- [ ] **Шаг 5: коммит** (файлы не общие)

```bash
git add -- public/js/admin/views/lab-panels.js public/js/admin/views/laboratory.js public/js/admin/__tests__/lab-panels-device-codes.test.mjs
git commit -m "Панели: «Анализатор» — только добавленные приборы и уже привязанный (LIS_ANALYZER_LIST_V1)"
```

---

### Задача 7: проверка целиком (координатор)

- [ ] **Шаг 1:**

```bash
node --test server/lis/*.test.js server/lis/profiles/*.test.js server/services/rpc/lis.test.js server/db/migrations/228.test.js server/db/migrations/123.test.js \
  public/js/admin/views/lab-devices-lists.test.mjs public/js/admin/views/lab-devices.test.mjs public/js/admin/views/lab-device-codes.test.mjs \
  public/js/admin/__tests__/lab-devices-add.test.mjs public/js/admin/__tests__/lab-devices-tray.test.mjs \
  public/js/admin/__tests__/lab-panels-mode.test.mjs public/js/admin/__tests__/lab-panels-device-codes.test.mjs \
  public/js/admin/__tests__/i18n-coverage.test.mjs public/js/admin/__tests__/i18n-uz-quality.test.mjs \
  public/js/admin/__tests__/english-literals-v3120.test.mjs public/js/admin/__tests__/icons.test.mjs public/js/admin/__tests__/rpc-exists.test.mjs \
  server/i18n-server-messages.test.js
```

- [ ] **Шаг 2: сквозная проверка** на копии базы разработки: миграция 228, находка ждёт `added = 0`, «Добавить», таблица. Затем перезапуск :8000, но только когда ни у кого в дереве нет недописанной миграции.
- [ ] **Шаг 3: полный `npm test`** — когда не пишет ни один агент.

---

## Самопроверка плана по спецификации

| Раздел спецификации | Задача |
|---|---|
| Миграция 228: `added`, бэкфилл, повторный накат; реестр | 1 |
| Находка `added = 0` | 2 |
| «На связи» на любом разобранном; `rejected` — нет | 2 |
| `lis_listeners`, `READ_ONLY_RPCS` | 3 |
| Три состояния, строка о порте | 4 |
| Таблица только выходивших; кнопка со счётчиком; окно: найдены / пусто с подсказкой / ждущие / ручной путь; «Добавить» → `added = 1`; честная строка о приборе-сервере | 5 |
| Панели: только добавленные и привязанный | 6 |
| Приём от `added` не зависит (ни одна задача не меняет `ingest.js`, кроме отметки связи) | 2 |
| Тесты и ручная проверка | 1–7 |
