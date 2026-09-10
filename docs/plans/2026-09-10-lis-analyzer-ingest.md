# Приём результатов с анализаторов (LIS_INGEST_V1) — план внедрения

> **Для агентов:** реализовывать задача за задачей. Шаги — чекбоксы (`- [ ]`).
> Спецификация: `docs/specs/2026-09-10-lis-analyzer-ingest-design.md`.

**Цель:** анализатор отправляет результаты, Easy-Med находит заказ по номеру пробы
и раскладывает значения по показателям бланка; лаборант проверяет и выдаёт.

**Архитектура:** слушатель MLLP внутри сервера Easy-Med → чистый разбор HL7 →
приём (поиск заказа, сопоставление поле-в-поле, запись) → существующий шаг
«Проверить и выдать». Каждое сообщение сохраняется сырым до разбора. Профиль
анализатора — файл данных, не код. Симулятор говорит тем же протоколом.

**Стек:** Node 24 ESM, better-sqlite3, express, `node --test`. Новых зависимостей
не добавляем: MLLP — это кадрирующие байты, HL7 v2 — текст с разделителями.

**Границы этого плана:** фазы 1–8 спецификации. Переадресатор для лабораторного
ПК (`.bat` у машины, транспорты `serial`/`folder`) — отдельный план после того,
как этот пройдёт сквозную проверку.

---

## Карта файлов

**Создаются в `easymed.local`:**

| Файл | Ответственность |
|---|---|
| `server/db/migrations/123_lis_ingest.sql` | таблицы `lab_devices`, `lab_device_messages`; колонки `lab_panels.device_id`, `lab_panel_analytes.device_code(+_confirmed)`, `lab_results.source` |
| `server/db/migrations/123.test.js` | миграция безопасна на живой базе; журнал филиалов не получает строк; `source` по умолчанию `'manual'`; сопоставление НЕ уезжает в справочнике филиалов |
| `server/lis/hl7.js` | чистый разбор ORU и сборка ACK. Ни базы, ни сети |
| `server/lis/hl7.test.js` | тесты разбора |
| `server/lis/mllp.js` | кадрирование TCP, ACK/NAK, потолок размера |
| `server/lis/mllp.test.js` | тесты транспорта |
| `server/lis/profiles/mindray-bc-20.js` | профиль BC-20 |
| `server/lis/profiles/mindray-bc-5300.js` | профиль BC-5300 (27 каналов со скриншота) |
| `server/lis/profiles/mindray-bs-240.js` | профиль BS-240 (каркас, каналы не подтверждены) |
| `server/lis/profiles/mindray-cl-900i.js` | профиль CL-900i (каркас) |
| `server/lis/profiles/index.js` | реестр: `listProfiles()`, `getProfile(key)` |
| `server/lis/profiles/index.test.js` | форма профилей одинакова у всех |
| `server/lis/inbox.js` | запись каждого сообщения с исходом |
| `server/lis/ingest.js` | поиск заказа, сопоставление, запись, продвижение статуса |
| `server/lis/ingest.test.js` | главный тест: D3/D4/D6/D7 и инварианты 1–4 |
| `server/lis/index.js` | `startLisListeners(db)` — один слушатель на порт |
| `server/services/rpc/lis.js` | RPC устройств и лотка |
| `server/services/rpc/lis.test.js` | роли |
| `public/js/admin/views/lab-devices.js` | вкладка «Анализаторы» + лоток |

**Изменяются в `easymed.local`:**

| Файл | Что |
|---|---|
| `server/db/schema-registry.js` | новые таблицы и колонки в белый список |
| `server/index.js` | вызов `startLisListeners(db)` |
| `server/services/rpc/index.js` | регистрация RPC |
| `public/js/admin/views/laboratory.js` | четвёртый режим `devices` |
| `public/js/admin/views/lab-panels.js` | выбор анализатора у панели + колонка «Поле анализатора» |

**Создаются в `C:\Users\user\Desktop\analyzers` (вне репозитория):**

| Файл | Ответственность |
|---|---|
| `analyzers/package.json` | без зависимостей, `type: module` |
| `analyzers/profiles.js` | те же профили, что у сервера (копия — папка автономна) |
| `analyzers/hl7-build.js` | сборка `ORU^R01` |
| `analyzers/send.js` | отправка по MLLP + приём ACK |
| `analyzers/capture.js` | режим «слушать и записать сырое» |
| `analyzers/server.js` | локальный веб-вид: выбрать машину, ввести значения, «Опубликовать» |
| `analyzers/public/index.html` | сам вид |
| `analyzers/LIS.bat` | запуск вида (форма как у `LIS.bat` владельца) |
| `analyzers/CAPTURE.bat` | запуск захвата |
| `analyzers/README.md` | как пользоваться |

---

## Задача 1: Миграция 123 и реестр схемы

**Файлы:**
- Создать: `server/db/migrations/123_lis_ingest.sql`
- Создать: `server/db/migrations/123.test.js`
- Изменить: `server/db/schema-registry.js`

- [ ] **Шаг 1: Проверить, что 123 свободен**

```bash
cd "/c/Users/user/Desktop/implementation workflow/easymed.local"
git fetch origin && ls server/db/migrations | grep -E "^12[0-9]_" | tail -3
git log origin/main --oneline -3 -- server/db/migrations | head
```

Ожидается: последняя — `122_internal_referral_doctors.sql`. Если в `origin/main`
уже есть `123_*`, взять `124` и переименовать всё ниже соответственно.

- [ ] **Шаг 2: Написать миграцию**

Создать `server/db/migrations/123_lis_ingest.sql`:

```sql
-- LIS_INGEST_V1 — приём результатов с анализаторов.
--
-- Пробирка уже несёт штрихкод Easy-Med (lab-barcode.js, шаг «Забор пробы»), и
-- до сих пор его никто не читал: лаборант перебивал числа с экрана прибора
-- руками. Здесь появляется обратное направление — прибор присылает результат,
-- Easy-Med находит заказ по тому же номеру и раскладывает значения по бланку.
--
-- ЧЕГО ЗДЕСЬ НАМЕРЕННО НЕТ:
--   * никакого UPDATE существующих строк — lab_results журналируется для
--     филиалов (084), и массовая правка означала бы выгрузку каждой тронутой
--     строки соседям под свежими метками, то есть молчаливую потерю их правок.
--     Проверяется 123.test.js.
--   * lab_results.source НЕ добавляется в SHIPPED (branch-sync/journal.js).
--     Список уже исключает entered_by и verified_by: правило установлено —
--     клиническое содержание едет, а КТО и КАК его получил остаётся в здании,
--     где он получен. Происхождение значения — ровно этот класс факта.
--     Поэтому журнальный триггер lab_results НЕ пересобирается.
--   * device_id и сопоставление не попадают в справочник филиалов
--     (branch-sync/catalogue.js): там перечни колонок явные, а анализатор
--     соседнего здания в нашей базе не означает ничего. Пин — в 123.test.js.

-- Анализаторы клиники. Принадлежность ЗДАНИЮ: в справочник филиалов не едут.
CREATE TABLE lab_devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  profile       TEXT NOT NULL,
  transport     TEXT NOT NULL DEFAULT 'mllp'
                  CHECK (transport IN ('mllp','folder','serial')),
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER,
  folder_path   TEXT NOT NULL DEFAULT '',
  serial_port   TEXT NOT NULL DEFAULT '',
  serial_baud   INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Панель кормится одним анализатором. NULL — законно: панель заполняется руками.
ALTER TABLE lab_panels ADD COLUMN device_id INTEGER REFERENCES lab_devices(id);

-- Сопоставление поле-в-поле (решение владельца D3) и доказательство того, что
-- человек строку подтвердил (D4). Приём применяет ТОЛЬКО подтверждённые.
ALTER TABLE lab_panel_analytes ADD COLUMN device_code TEXT NOT NULL DEFAULT '';
ALTER TABLE lab_panel_analytes ADD COLUMN device_code_confirmed INTEGER NOT NULL DEFAULT 0;

-- Происхождение значения. 'manual' по умолчанию — прежние строки сохраняют смысл.
ALTER TABLE lab_results ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

-- Лоток: каждое сообщение, дошедшее до порта, чем бы дело ни кончилось.
-- Инвариант 2: ничего не теряется. Смазанный штрихкод стоит клика, а не
-- повторного забора крови.
CREATE TABLE lab_device_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id        INTEGER REFERENCES lab_devices(id),
  peer             TEXT NOT NULL DEFAULT '',
  raw              TEXT NOT NULL,
  sample_id        TEXT NOT NULL DEFAULT '',
  visit_service_id INTEGER REFERENCES visit_services(id),
  status           TEXT NOT NULL
                     CHECK (status IN ('applied','unmatched','unmapped','rejected','superseded')),
  detail           TEXT NOT NULL DEFAULT '',
  received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolved_at      TEXT
);
CREATE INDEX idx_lab_device_messages_status ON lab_device_messages(status);
CREATE INDEX idx_lab_device_messages_vs ON lab_device_messages(visit_service_id);
```

- [ ] **Шаг 3: Написать тест миграции**

Создать `server/db/migrations/123.test.js`:

```js
// 123.test.js — LIS_INGEST_V1: две таблицы, пять колонок и ноль строк в
// журнале филиалов.
//
// Утверждения, ради которых файл существует:
//   1. На чистой установке всё создано и пусто по умолчанию.
//   2. На ЖИВОЙ базе данные целы, а source у прежних строк = 'manual'.
//   3. Журнал филиалов не получает НИ ОДНОЙ строки (см. шапку 084 и 100.test.js).
//   4. source НЕ уезжает соседям: происхождение — факт здания, как entered_by.
//   5. Сопоставление не уезжает в справочнике филиалов: анализатор соседнего
//      здания в нашей базе не означает ничего.
//   6. В файле нет UPDATE и нет пересборки таблиц.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';
import { CATALOGUE } from '../../services/branch-sync/catalogue.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const M123 = '123_lis_ingest.sql';

const cols = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all();
const col = (db, t, n) => cols(db, t).find((c) => c.name === n);
const journalCount = (db) => db.prepare('SELECT COUNT(*) c FROM sync_journal').get().c;

function dbBefore(upTo) {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (f >= upTo) break;
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    })();
  }
  return db;
}

function applyFile(db, file) {
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
  })();
}

/** Клиника накануне обновления: пациент, визит, лабораторный заказ, результат. */
function seedClinic(db) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'lab','x','Лаборант Л.','lab')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-05T09:30:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Общий анализ крови',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_results (id, visit_service_id, parameter, value) VALUES (1,123,'Лейкоциты','6.1')").run();
}

test('123: на чистой установке таблицы и колонки есть, значения по умолчанию верны', () => {
  const db = openDb(':memory:');
  migrate(db);

  assert.ok(cols(db, 'lab_devices').length, 'lab_devices не создана');
  assert.ok(cols(db, 'lab_device_messages').length, 'lab_device_messages не создана');

  const src = col(db, 'lab_results', 'source');
  assert.ok(src, 'lab_results.source не создана');
  assert.equal(src.notnull, 1);
  assert.equal(src.dflt_value, "'manual'");

  const conf = col(db, 'lab_panel_analytes', 'device_code_confirmed');
  assert.equal(conf.notnull, 1);
  assert.equal(conf.dflt_value, '0', 'неподтверждённое сопоставление — состояние по умолчанию');

  assert.ok(col(db, 'lab_panels', 'device_id'), 'lab_panels.device_id не создана');
  db.close();
});

test('123: на живой базе данные целы, у прежнего результата source = manual', () => {
  const db = dbBefore(M123);
  assert.ok(!col(db, 'lab_results', 'source'), 'до 123 колонки быть не должно — иначе тест ничего не проверяет');
  seedClinic(db);

  applyFile(db, M123);

  const r = db.prepare('SELECT * FROM lab_results WHERE id = 1').get();
  assert.equal(r.parameter, 'Лейкоциты');
  assert.equal(r.value, '6.1');
  assert.equal(r.source, 'manual', 'прежний результат обязан остаться «введён человеком»');
  db.close();
});

// ГЛАВНОЕ УТВЕРЖДЕНИЕ ФАЙЛА.
test('123: журнал филиалов не получает НИ ОДНОЙ строки', () => {
  const db = dbBefore(M123);
  seedClinic(db);
  const before = journalCount(db);
  assert.ok(before > 0, 'посев обязан был зажурналиться — иначе «столько же после» ничего не значит');

  applyFile(db, M123);

  assert.equal(journalCount(db), before,
    'миграция породила записи в sync_journal: каждая уедет соседям под свежей меткой и перебьёт там их правки');
  db.close();
});

test('123: происхождение значения НЕ уезжает соседям — это факт здания, как entered_by', () => {
  assert.ok(!SHIPPED.lab_results.includes('source'),
    'source в SHIPPED: список уже исключает entered_by/verified_by — «кто и как получил» остаётся дома');
  // Половина со стороны базы: триггер не пересобирался, значит source в нём нет.
  const db = openDb(':memory:');
  migrate(db);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lab_results_journal_upd'").get();
  if (sql) assert.ok(!/NEW\.source/i.test(sql.sql), 'триггер знает про source — значит он начал уезжать');
  db.close();
});

test('123: сопоставление с анализатором не уезжает в справочнике филиалов', () => {
  const panels = CATALOGUE.find((t) => t.name === 'lab_panels');
  const analytes = CATALOGUE.find((t) => t.name === 'lab_panel_analytes');
  assert.ok(panels && analytes, 'панели обязаны быть в справочнике — иначе тест сторожит не то');
  assert.ok(!panels.columns.includes('device_id'),
    'device_id уехал соседям: анализатор соседнего здания в нашей базе не означает ничего');
  assert.ok(!analytes.columns.includes('device_code'));
  assert.ok(!analytes.columns.includes('device_code_confirmed'));
});

test('123: в файле нет ни одного UPDATE и ни одной пересборки', () => {
  const sql = fs.readFileSync(path.join(DIR, M123), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/^\s*UPDATE\s/im.test(code), 'массовый UPDATE журналируемой таблицы — сетевое событие');
  assert.ok(!/\bDROP\s+TABLE\b/i.test(code));
  assert.ok(!/\bDELETE\b/i.test(code));
});
```

- [ ] **Шаг 4: Прогнать — ожидается падение**

```bash
cd "/c/Users/user/Desktop/implementation workflow/easymed.local"
npx node --test server/db/migrations/123.test.js
```

Ожидается: падение. Если `CATALOGUE` не экспортируется из `catalogue.js` —
посмотреть настоящее имя экспорта (`grep -n "^export" server/services/branch-sync/catalogue.js`)
и поправить импорт в тесте, а не выдумывать его.

- [ ] **Шаг 5: Дополнить реестр схемы**

В `server/db/schema-registry.js`:

1. В `lab_results.read.columns` добавить `'source'`. **В списки записи НЕ
   добавлять** — ставит только сервер, браузер никогда.
2. В `lab_panels`: `read.columns` += `'device_id'`; `write.insert.columns` и
   `write.update.columns` += `'device_id'`.
3. В `lab_panel_analytes`: в `read.columns`, `write.insert.columns` и
   `write.update.columns` добавить `'device_code'` и `'device_code_confirmed'`.
4. Добавить рядом с `lab_panel_analytes` две новые таблицы:

```js
  // LIS_INGEST_V1 — анализаторы клиники. Принадлежность ЗДАНИЮ: в справочник
  // филиалов не едут (пин: 123.test.js).
  lab_devices: {
    read:  { roles: ALL_STAFF, columns: ['id','name','profile','transport','host','port','folder_path','serial_port','serial_baud','enabled','last_seen_at','created_at'] },
    write: { insert: { roles: LAB_SECTION_ROLES, columns: ['name','profile','transport','host','port','folder_path','serial_port','serial_baud','enabled'] },
             update: { roles: LAB_SECTION_ROLES, columns: ['name','profile','transport','host','port','folder_path','serial_port','serial_baud','enabled'] },
             delete: { roles: LAB_SECTION_ROLES } },
    filters: ['id','enabled','transport'],
    embed:   {},
  },

  // LIS_INGEST_V1 — лоток. Пишет ТОЛЬКО сервер: строки здесь — свидетельство о
  // том, что пришло по проводу, и правка их из браузера превратила бы журнал
  // в пересказ. Разрешение идёт через RPC lis_message_resolve.
  lab_device_messages: {
    read:  { roles: ALL_STAFF, columns: ['id','device_id','peer','raw','sample_id','visit_service_id','status','detail','received_at','resolved_at'] },
    write: { insert: { roles: [] }, update: { roles: [] }, delete: { roles: [] } },
    filters: ['id','status','visit_service_id','device_id'],
    embed:   {},
  },
```

Если `LAB_SECTION_ROLES` в файле не объявлена рядом — взять то имя, которым уже
пользуются `lab_panels` и `lab_panel_analytes` (оно там есть, см. их записи).

- [ ] **Шаг 6: Прогнать тесты**

```bash
npx node --test server/db/migrations/123.test.js
npm test 2>&1 | tail -20
```

Ожидается: `123.test.js` зелёный, общий прогон без новых падений.

- [ ] **Шаг 7: Коммит**

```bash
git add server/db/migrations/123_lis_ingest.sql server/db/migrations/123.test.js server/db/schema-registry.js
git commit -m "feat(lis): схема приёма результатов с анализаторов — устройства, лоток, сопоставление, происхождение"
```

---

## Задача 2: Разбор HL7

**Файлы:**
- Создать: `server/lis/hl7.js`
- Создать: `server/lis/hl7.test.js`

- [ ] **Шаг 1: Написать падающий тест**

Создать `server/lis/hl7.test.js`:

```js
// hl7.test.js — чистый разбор. Ни базы, ни сети, ни времени: всё, что здесь
// проверяется, это текст на входе и объект на выходе.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, buildAck } from './hl7.js';

const ORU = [
  'MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1',
  'PID|1||||Иванов^Иван',
  'OBR|1||LAB-000123|00001^Automated Count^99MRC',
  'OBX|1|NM|WBC^Leukocytes^99MRC||6.1|10*9/L|4.0-9.0|N|||F',
  'OBX|2|NM|HGB^Hemoglobin^99MRC||142|g/L|130-160|N|||F',
].join('\r');

test('разбирает ORU: тип, номер сообщения, номер пробы, наблюдения', () => {
  const m = parseMessage(ORU);
  assert.equal(m.type, 'ORU^R01');
  assert.equal(m.controlId, '42');
  assert.equal(m.sampleId, 'LAB-000123');
  assert.equal(m.observations.length, 2);
  assert.deepEqual(m.observations[0], {
    valueType: 'NM', code: 'WBC', value: '6.1',
    unit: '10*9/L', range: '4.0-9.0', abnormal: 'N', status: 'F',
  });
});

test('терпит \\r\\n вместо \\r', () => {
  const m = parseMessage(ORU.split('\r').join('\r\n'));
  assert.equal(m.observations.length, 2, 'сегменты, разделённые CRLF, обязаны разобраться');
});

test('честно читает СВОИ разделители из MSH-2', () => {
  const odd = ORU.replace('MSH|^~\\&|', 'MSH|*~\\&|').split('|').join('|').replace('WBC^Leukocytes', 'WBC*Leukocytes');
  const m = parseMessage(odd);
  assert.equal(m.observations[0].code, 'WBC', 'компонентный разделитель обязан браться из MSH-2, а не быть зашитым');
});

test('пустой OBR-3 — это отсутствие номера пробы, а не пустая строка', () => {
  const m = parseMessage(ORU.replace('LAB-000123', ''));
  assert.equal(m.sampleId, '');
});

test('не-ORU отвергается с причиной', () => {
  assert.throws(() => parseMessage(ORU.replace('ORU^R01', 'ADT^A01')), /ORU/);
});

test('QRY^Q02 узнаётся отдельно — это запрос рабочего списка, а не результат', () => {
  const qry = 'MSH|^~\\&|BC-20|Mindray|||20260910143943||QRY^Q02|7|P|2.3.1';
  assert.throws(() => parseMessage(qry), /QRY\^Q02/);
});

test('ACK и NAK имеют правильную форму и несут номер исходного сообщения', () => {
  assert.match(buildAck('42', 'AA'), /MSA\|AA\|42/);
  assert.match(buildAck('42', 'AE'), /MSA\|AE\|42/);
  assert.match(buildAck('42', 'AA'), /^MSH\|\^~\\&\|/);
});
```

- [ ] **Шаг 2: Прогнать — ожидается падение**

```bash
npx node --test server/lis/hl7.test.js
```

Ожидается: `Cannot find module './hl7.js'`.

- [ ] **Шаг 3: Написать разбор**

Создать `server/lis/hl7.js`:

```js
// LIS_INGEST_V1 — разбор HL7 v2.3.1. ЧИСТЫЙ: ни базы, ни сети, ни времени.
//
// Своей зависимости здесь нет намеренно (решение спецификации): HL7 v2 — это
// текст с разделителями, а разбор, который мы можем прочитать целиком, в
// медицинской системе лучше дерева транзитивных зависимостей.
//
// Разделители НЕ зашиты: они объявлены в MSH-2 самим отправителем, и прибор,
// выбравший другие, обязан быть понят.

const SEG = /\r\n?|\n/;

/** Разбирает сообщение. Бросает Error с внятной причиной — её увидит лоток. */
export function parseMessage(text) {
  const segments = String(text || '').split(SEG).filter((s) => s.trim() !== '');
  if (!segments.length) throw new Error('пустое сообщение');

  const msh = segments[0];
  if (!msh.startsWith('MSH')) throw new Error('первый сегмент не MSH');

  // MSH-1 — сам символ на 4-й позиции; MSH-2 — следующие четыре служебных.
  const fieldSep = msh[3];
  const enc = msh.slice(4, msh.indexOf(fieldSep, 4));
  const compSep = enc[0] || '^';
  const repSep = enc[1] || '~';
  const escChar = enc[2] || '\\';
  const subSep = enc[3] || '&';

  const fields = (seg) => seg.split(fieldSep);
  const comp = (v) => String(v == null ? '' : v).split(compSep);

  const mshF = fields(msh);
  const type = comp(mshF[8] || '').slice(0, 2).filter(Boolean).join('^');
  const controlId = mshF[9] || '';

  if (type === 'QRY^Q02') {
    // Прибор спрашивает рабочий список для отсканированной пробирки. Полезно
    // позже (спецификация, «Вне объёма»); сегодня узнаём и внятно отклоняем,
    // чтобы дверь осталась открытой, а сообщение не разобралось как результат.
    throw new Error('QRY^Q02 — запрос рабочего списка, исходящее направление пока не поддержано');
  }
  if (type !== 'ORU^R01') throw new Error('ожидался ORU^R01, получен ' + (type || '<пусто>'));

  let sampleId = '';
  const observations = [];
  for (const seg of segments.slice(1)) {
    const f = fields(seg);
    if (seg.startsWith('OBR')) {
      if (!sampleId) sampleId = (f[3] || '').trim();
    } else if (seg.startsWith('OBX')) {
      observations.push({
        valueType: (f[2] || '').trim(),
        code: comp(f[3])[0].trim(),
        value: (f[5] || '').trim(),
        unit: comp(f[6])[0].trim(),
        range: (f[7] || '').trim(),
        abnormal: (f[8] || '').trim(),
        status: (f[11] || '').trim(),
      });
    }
  }

  return { type, controlId, sampleId, observations, sep: { fieldSep, compSep, repSep, escChar, subSep } };
}

/** ACK (`AA`) или NAK (`AE`). Номер исходного сообщения обязателен: по нему
 *  прибор понимает, на что ему ответили. */
export function buildAck(controlId, code) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return [
    `MSH|^~\\&|EASYMED|CLINIC|||${stamp}||ACK|${controlId || '1'}|P|2.3.1`,
    `MSA|${code}|${controlId || ''}`,
  ].join('\r');
}
```

- [ ] **Шаг 4: Прогнать — ожидается зелёный**

```bash
npx node --test server/lis/hl7.test.js
```

Ожидается: все тесты пройдены. Если тест «свои разделители» падает — причина в
подготовке строки в самом тесте, а не в разборе: собрать сообщение с `*` как
компонентным разделителем целиком, а не заменой.

- [ ] **Шаг 5: Коммит**

```bash
git add server/lis/hl7.js server/lis/hl7.test.js
git commit -m "feat(lis): разбор HL7 ORU — свои разделители, CRLF, отдельное узнавание QRY"
```

---

## Задача 3: Транспорт MLLP

**Файлы:**
- Создать: `server/lis/mllp.js`
- Создать: `server/lis/mllp.test.js`

Порт в тестах берётся через `server.listen(0)` — динамический. Ограничение
Windows про запрещённые порты `fetch` здесь не действует: это сырой `net`, а не
HTTP-клиент.

- [ ] **Шаг 1: Написать падающий тест**

Создать `server/lis/mllp.test.js`:

```js
// mllp.test.js — кадрирование и ответ. Приём подменён заглушкой: этот файл
// проверяет провод, а не смысл сообщения.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startMllpServer, VT, FS, CR } from './mllp.js';

const frame = (s) => Buffer.concat([Buffer.from([VT]), Buffer.from(s, 'utf8'), Buffer.from([FS, CR])]);

function connect(port) {
  return new Promise((res, rej) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => res(sock));
    sock.on('error', rej);
  });
}

/** Ждёт ОДИН кадр ответа. */
function readFrame(sock) {
  return new Promise((res) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf(FS);
      if (end !== -1) res(buf.slice(1, end).toString('utf8'));
    });
  });
}

async function withServer(onMessage, fn, opts = {}) {
  const srv = await startMllpServer({ port: 0, onMessage, ...opts });
  try { await fn(srv.port); } finally { await srv.close(); }
}

test('одно сообщение: приходит целиком, в ответ ACK', async () => {
  const seen = [];
  await withServer(async (text) => { seen.push(text); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame('MSH|^~\\&|X|||||||ORU^R01|7|P|2.3.1'));
    assert.match(await reply, /MSA\|AA\|7/);
    sock.end();
  });
  assert.equal(seen.length, 1);
});

test('сообщение, разорванное между записями, собирается', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    const f = frame('MSH|^~\\&|X|||||||ORU^R01|8|P|2.3.1');
    sock.write(f.slice(0, 10));
    sock.write(f.slice(10));
    await reply;
    sock.end();
  });
  assert.equal(seen.length, 1, 'разрыв по TCP-сегментам не должен терять сообщение');
});

test('два сообщения в одном соединении', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.write(Buffer.concat([
      frame('MSH|^~\\&|X|||||||ORU^R01|1|P|2.3.1'),
      frame('MSH|^~\\&|X|||||||ORU^R01|2|P|2.3.1'),
    ]));
    await new Promise((r) => setTimeout(r, 120));
    sock.end();
  });
  assert.equal(seen.length, 2);
});

test('слишком большое сообщение отвергается и не копится в памяти', async () => {
  const seen = [];
  await withServer(async (t) => { seen.push(t); return 'AA'; }, async (port) => {
    const sock = await connect(port);
    sock.write(Buffer.concat([Buffer.from([VT]), Buffer.alloc(2048, 0x41)]));
    await new Promise((r) => setTimeout(r, 120));
    sock.end();
  }, { maxBytes: 1024 });
  assert.equal(seen.length, 0, 'перебор размера не должен доходить до приёма');
});

test('приём бросил — в ответ NAK, соединение живо', async () => {
  await withServer(async () => { throw new Error('база недоступна'); }, async (port) => {
    const sock = await connect(port);
    const reply = readFrame(sock);
    sock.write(frame('MSH|^~\\&|X|||||||ORU^R01|9|P|2.3.1'));
    assert.match(await reply, /MSA\|AE\|9/, 'прибор, повторяющий при NAK, здесь помощник');
    sock.end();
  });
});
```

- [ ] **Шаг 2: Прогнать — ожидается падение**

```bash
npx node --test server/lis/mllp.test.js
```

- [ ] **Шаг 3: Написать транспорт**

Создать `server/lis/mllp.js`:

```js
// LIS_INGEST_V1 — MLLP: кадрирование HL7 поверх TCP.
//
// Кадр: 0x0B <текст> 0x1C 0x0D. Прибор может прислать кадр кусками, может
// прислать два кадра в одной записи, и обязан получить ответ до того, как
// пошлёт следующий.
//
// Порт неаутентифицирован — анализаторы не умеют логиниться (спецификация,
// «Безопасность»). Отсюда потолок размера и тайм-аут простоя: это единственное,
// чем можно ограничить того, кто не представился.
import net from 'node:net';
import { buildAck } from './hl7.js';

export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

const DEFAULT_MAX_BYTES = 256 * 1024;
const IDLE_MS = 5 * 60 * 1000;

/**
 * @param {object} o
 * @param {number} o.port          0 — занять свободный (тесты)
 * @param {(text:string, peer:string)=>Promise<'AA'|'AE'>} o.onMessage
 * @param {number} [o.maxBytes]
 * @param {(msg:string)=>void} [o.log]
 */
export function startMllpServer({ port, onMessage, maxBytes = DEFAULT_MAX_BYTES, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      const peer = sock.remoteAddress || '';
      let buf = Buffer.alloc(0);
      let overflow = false;
      sock.setTimeout(IDLE_MS, () => sock.destroy());

      sock.on('data', async (chunk) => {
        if (overflow) return;
        buf = Buffer.concat([buf, chunk]);

        if (buf.length > maxBytes) {
          // Не копим: тот, кто не представился, не должен уметь съесть память.
          overflow = true;
          log(`LIS: сообщение больше ${maxBytes} байт от ${peer} — соединение закрыто`);
          buf = Buffer.alloc(0);
          sock.destroy();
          return;
        }

        for (;;) {
          const start = buf.indexOf(VT);
          if (start === -1) break;
          const end = buf.indexOf(FS, start + 1);
          if (end === -1) break;   // кадр ещё не пришёл целиком

          const text = buf.slice(start + 1, end).toString('utf8');
          buf = buf.slice(end + 1 < buf.length && buf[end + 1] === CR ? end + 2 : end + 1);

          let code = 'AE';
          let controlId = '';
          try {
            const m = /\|([^|]*)\|[PDT]\|2\.\d/.exec(text.split(/\r\n?|\n/)[0] || '');
            controlId = (m && m[1]) || '';
          } catch { /* номер сообщения не обязателен для ответа */ }

          try {
            code = (await onMessage(text, peer)) || 'AE';
          } catch (e) {
            code = 'AE';
            log('LIS: приём отказал — ' + (e && e.message ? e.message : e));
          }

          const ack = buildAck(controlId, code);
          sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(ack, 'utf8'), Buffer.from([FS, CR])]));
        }
      });

      sock.on('error', () => sock.destroy());
    });

    server.on('error', (e) => {
      // Тот же дружелюбный разбор, что server/index.js делает для HTTP-порта:
      // оператор, запустивший второй раз, должен увидеть слова, а не стек.
      if (e && e.code === 'EADDRINUSE') {
        reject(new Error(`LIS: порт ${port} уже занят — вероятно, Easy-Med уже запущен`));
      } else reject(e);
    });

    server.listen(port, '0.0.0.0', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
```

- [ ] **Шаг 4: Прогнать — ожидается зелёный**

```bash
npx node --test server/lis/mllp.test.js
```

- [ ] **Шаг 5: Коммит**

```bash
git add server/lis/mllp.js server/lis/mllp.test.js
git commit -m "feat(lis): транспорт MLLP — кадрирование, ACK/NAK, потолок размера, тайм-аут"
```

---

## Задача 4: Профили анализаторов

**Файлы:**
- Создать: `server/lis/profiles/mindray-bc-20.js`, `mindray-bc-5300.js`, `mindray-bs-240.js`, `mindray-cl-900i.js`, `index.js`
- Создать: `server/lis/profiles/index.test.js`

- [ ] **Шаг 1: Написать падающий тест**

Создать `server/lis/profiles/index.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { listProfiles, getProfile } from './index.js';

test('все профили одной формы — иначе экран и приём читали бы разное', () => {
  const all = listProfiles();
  assert.ok(all.length >= 4);
  for (const p of all) {
    assert.equal(typeof p.key, 'string');
    assert.ok(p.key.length, 'ключ профиля обязателен: он лежит в lab_devices.profile');
    assert.equal(typeof p.model, 'string');
    assert.ok(Array.isArray(p.transports) && p.transports.length);
    assert.ok(Array.isArray(p.channels));
    for (const c of p.channels) {
      assert.ok(c.code, p.key + ': у канала нет кода');
      assert.ok(c.name, p.key + ': у канала ' + c.code + ' нет имени');
    }
    const codes = p.channels.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length, p.key + ': повторяющийся код канала');
  }
});

test('BC-5300 несёт все 27 каналов со скриншота владельца', () => {
  const p = getProfile('mindray-bc-5300');
  assert.equal(p.channels.length, 27);
  for (const code of ['WBC', 'NEU%', 'RBC', 'HGB', 'PLT', 'PCT', 'RDW-SD']) {
    assert.ok(p.channels.some((c) => c.code === code), 'нет канала ' + code);
  }
});

test('неизвестный ключ — это null, а не исключение: устройство могло остаться от снятого профиля', () => {
  assert.equal(getProfile('нет-такого'), null);
});
```

- [ ] **Шаг 2: Прогнать — ожидается падение**

```bash
npx node --test server/lis/profiles/index.test.js
```

- [ ] **Шаг 3: Написать профиль BC-20**

Создать `server/lis/profiles/mindray-bc-20.js`:

```js
// LIS_INGEST_V1 — Mindray BC-20, гематология, 3-diff.
//
// Основание: приложение C руководства оператора (analyzer-manuals/Mindray/) —
// «LAN Port supports HL7 protocol», двунаправленный LIS, плюс старый «15ID».
// САМИ КОДЫ КАНАЛОВ НЕ ПОДТВЕРЖДЕНЫ: подробный протокол Mindray не публикует
// («contact Mindray Customer Service Department or your local distributor»).
// Здесь стоят общепринятые мнемоники BC-серии. Расхождение не ломает приём —
// незнакомый код попадает в лоток, и лаборант сопоставляет его один раз.
export default {
  key: 'mindray-bc-20',
  vendor: 'Mindray',
  model: 'BC-20',
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  channels: [
    { code: 'WBC',   name: 'Лейкоциты',                 unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM#',  name: 'Лимфоциты, абс.',           unit: '10^9/л',  type: 'numeric' },
    { code: 'MID#',  name: 'Средние клетки, абс.',      unit: '10^9/л',  type: 'numeric' },
    { code: 'GRA#',  name: 'Гранулоциты, абс.',         unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM%',  name: 'Лимфоциты, %',              unit: '%',       type: 'numeric' },
    { code: 'MID%',  name: 'Средние клетки, %',         unit: '%',       type: 'numeric' },
    { code: 'GRA%',  name: 'Гранулоциты, %',            unit: '%',       type: 'numeric' },
    { code: 'RBC',   name: 'Эритроциты',                unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',   name: 'Гемоглобин',                unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',   name: 'Гематокрит',                unit: '%',       type: 'numeric' },
    { code: 'MCV',   name: 'Средний объём эритроцита',  unit: 'фл',      type: 'numeric' },
    { code: 'MCH',   name: 'Среднее содержание Hb',     unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',  name: 'Средняя концентрация Hb',   unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                   unit: '%',       type: 'numeric' },
    { code: 'PLT',   name: 'Тромбоциты',                unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',   name: 'Средний объём тромбоцита',  unit: 'фл',      type: 'numeric' },
    { code: 'PDW',   name: 'PDW',                       unit: '',        type: 'numeric' },
    { code: 'PCT',   name: 'Тромбокрит',                unit: '%',       type: 'numeric' },
  ],
};
```

- [ ] **Шаг 4: Написать профиль BC-5300**

Создать `server/lis/profiles/mindray-bc-5300.js`. Ровно 27 каналов — состав снят
со скриншота ПО производителя, присланного владельцем 2026-09-10:

```js
// LIS_INGEST_V1 — Mindray BC-5300, гематология, 5-diff.
//
// Состав каналов снят со СКРИНШОТА ПО производителя (владелец, 2026-09-10):
// экран «Проб за сегодня», режим WB / CBC+DIFF. Порядок и написание — как на
// экране. Каналы со звёздочкой (ALY, LIC) прибор помечает «только для исслед.
// целей, не для диагностики» — они здесь есть, потому что прибор их присылает;
// брать их в панель или нет, решает клиника.
export default {
  key: 'mindray-bc-5300',
  vendor: 'Mindray',
  model: 'BC-5300',
  kind: 'hematology',
  transports: ['mllp'],
  defaultPort: 2575,
  channels: [
    { code: 'WBC',    name: 'Лейкоциты',                unit: '10^9/л',  type: 'numeric' },
    { code: 'NEU%',   name: 'Нейтрофилы, %',            unit: '%',       type: 'numeric' },
    { code: 'LYM%',   name: 'Лимфоциты, %',             unit: '%',       type: 'numeric' },
    { code: 'MON%',   name: 'Моноциты, %',              unit: '%',       type: 'numeric' },
    { code: 'EOS%',   name: 'Эозинофилы, %',            unit: '%',       type: 'numeric' },
    { code: 'BAS%',   name: 'Базофилы, %',              unit: '%',       type: 'numeric' },
    { code: 'NEU#',   name: 'Нейтрофилы, абс.',         unit: '10^9/л',  type: 'numeric' },
    { code: 'LYM#',   name: 'Лимфоциты, абс.',          unit: '10^9/л',  type: 'numeric' },
    { code: 'MON#',   name: 'Моноциты, абс.',           unit: '10^9/л',  type: 'numeric' },
    { code: 'EOS#',   name: 'Эозинофилы, абс.',         unit: '10^9/л',  type: 'numeric' },
    { code: 'BAS#',   name: 'Базофилы, абс.',           unit: '10^9/л',  type: 'numeric' },
    { code: 'ALY%',   name: 'Атипичные лимфоциты, %',   unit: '%',       type: 'numeric' },
    { code: 'LIC%',   name: 'Крупные незрелые клетки, %', unit: '%',     type: 'numeric' },
    { code: 'ALY#',   name: 'Атипичные лимфоциты, абс.', unit: '10^9/л', type: 'numeric' },
    { code: 'LIC#',   name: 'Крупные незрелые клетки, абс.', unit: '10^9/л', type: 'numeric' },
    { code: 'RBC',    name: 'Эритроциты',               unit: '10^12/л', type: 'numeric' },
    { code: 'HGB',    name: 'Гемоглобин',               unit: 'г/л',     type: 'numeric' },
    { code: 'HCT',    name: 'Гематокрит',               unit: '%',       type: 'numeric' },
    { code: 'MCV',    name: 'Средний объём эритроцита', unit: 'фл',      type: 'numeric' },
    { code: 'MCH',    name: 'Среднее содержание Hb',    unit: 'пг',      type: 'numeric' },
    { code: 'MCHC',   name: 'Средняя концентрация Hb',  unit: 'г/л',     type: 'numeric' },
    { code: 'RDW-CV', name: 'RDW-CV',                   unit: '%',       type: 'numeric' },
    { code: 'RDW-SD', name: 'RDW-SD',                   unit: 'фл',      type: 'numeric' },
    { code: 'PLT',    name: 'Тромбоциты',               unit: '10^9/л',  type: 'numeric' },
    { code: 'MPV',    name: 'Средний объём тромбоцита', unit: 'фл',      type: 'numeric' },
    { code: 'PDW',    name: 'PDW',                      unit: '',        type: 'numeric' },
    { code: 'PCT',    name: 'Тромбокрит',               unit: '%',       type: 'numeric' },
  ],
};
```

- [ ] **Шаг 5: Написать каркасы BS-240 и CL-900i**

Создать `server/lis/profiles/mindray-bs-240.js`:

```js
// LIS_INGEST_V1 — Mindray BS-240, биохимия.
//
// Транспорт: TCP/IP, HL7 v2.3.1 ЛИБО ASTM E1394-97 («BS-230/BS-240 LIS
// Interface Manual»; в открытом доступе документа нет). Здесь заявлен только
// HL7 — ASTM будет вторым транспортом за тем же приёмом, когда понадобится.
//
// КАНАЛЫ ПУСТЫ НАМЕРЕННО. У биохимического анализатора набор тестов задаёт сама
// клиника (какие реагенты закуплены), поэтому угаданный список был бы вреднее
// пустого: он предложил бы лаборанту сопоставить то, чего прибор не шлёт.
// Пришедший код попадёт в лоток как несопоставленный, и лаборант добавит его
// показателем панели — это и есть штатный путь до получения документации.
export default {
  key: 'mindray-bs-240',
  vendor: 'Mindray',
  model: 'BS-240',
  kind: 'chemistry',
  transports: ['mllp'],
  defaultPort: 2575,
  channels: [],
};
```

Создать `server/lis/profiles/mindray-cl-900i.js` — тем же образом, с
`key: 'mindray-cl-900i'`, `model: 'CL-900i'`, `kind: 'immunoassay'`,
`channels: []` и комментарием: транспорт не подтверждён, каналы задаёт набор
реагентов клиники.

- [ ] **Шаг 6: Написать реестр**

Создать `server/lis/profiles/index.js`:

```js
// LIS_INGEST_V1 — реестр профилей. Добавить анализатор = добавить файл и одну
// строку здесь. Профиль — данные, не код: это причина, по которой новая машина
// не переписывает движок.
import bc20 from './mindray-bc-20.js';
import bc5300 from './mindray-bc-5300.js';
import bs240 from './mindray-bs-240.js';
import cl900i from './mindray-cl-900i.js';

const ALL = [bc20, bc5300, bs240, cl900i];
const BY_KEY = new Map(ALL.map((p) => [p.key, p]));

export function listProfiles() { return ALL; }

/** null, а не исключение: устройство могло остаться от снятого профиля, и
 *  экран обязан показать его строкой «профиль не найден», а не упасть. */
export function getProfile(key) { return BY_KEY.get(key) || null; }
```

- [ ] **Шаг 7: Прогнать и закоммитить**

```bash
npx node --test server/lis/profiles/index.test.js
git add server/lis/profiles
git commit -m "feat(lis): профили анализаторов — BC-20, BC-5300 (27 каналов), каркасы BS-240 и CL-900i"
```

---

## Задача 5: Приём и лоток

Ядро. Здесь держатся решения владельца D3/D4/D6/D7 и инварианты 1–4.

**Файлы:**
- Создать: `server/lis/inbox.js`
- Создать: `server/lis/ingest.js`
- Создать: `server/lis/ingest.test.js`

- [ ] **Шаг 1: Написать падающий тест**

Создать `server/lis/ingest.test.js`:

```js
// ingest.test.js — главный тест подсистемы. Каждое утверждение здесь — это
// решение владельца или инвариант безопасности пациента, а не удобство.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ingestMessage } from './ingest.js';

const MSG = (sampleId, obx) => [
  `MSH|^~\\&|BC-5300|Mindray|||20260910143943||ORU^R01|42|P|2.3.1`,
  `OBR|1||${sampleId}|00001^Automated Count^99MRC`,
  ...obx,
].join('\r');

const OBX = (n, code, value, opts = {}) =>
  `OBX|${n}|${opts.type || 'NM'}|${code}^^99MRC||${value}|${opts.unit || '10*9/L'}|${opts.range || ''}|${opts.flag || ''}|||${opts.status || 'F'}`;

/** Клиника с одним анализатором, одной панелью и одним оплаченным заказом. */
function seed(db, { confirmed = 1, refLow = null, refHigh = null } = {}) {
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'lab','x','Лаборант','lab')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (55,3,'2026-09-10T09:00:00Z','scheduled')").run();
  db.prepare("INSERT INTO services (id, name, is_lab) VALUES (9,'Общий анализ крови',1)").run();
  db.prepare("INSERT INTO visit_services (id, visit_id, service_id, status) VALUES (123,55,9,'in_progress')").run();
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, port) VALUES (1,'Гематология','mindray-bc-5300','mllp',2575)").run();
  db.prepare("INSERT INTO lab_panels (id, name, service_id, device_id) VALUES (5,'ОАК',9,1)").run();
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed, ref_low, ref_high)
              VALUES (5,'WBC','Лейкоциты','10^9/л',1,'WBC',?,?,?)`).run(confirmed, refLow, refHigh);
  db.prepare(`INSERT INTO lab_panel_analytes (panel_id, code, name, unit, sort_order, device_code, device_code_confirmed)
              VALUES (5,'HGB','Гемоглобин','г/л',2,'HGB',1)`).run();
}

function fresh(opts) {
  const db = openDb(':memory:');
  migrate(db);
  seed(db, opts);
  return db;
}

const results = (db) => db.prepare('SELECT * FROM lab_results WHERE visit_service_id = 123 ORDER BY id').all();
const message = (db) => db.prepare('SELECT * FROM lab_device_messages ORDER BY id DESC LIMIT 1').get();
const order = (db) => db.prepare('SELECT * FROM visit_services WHERE id = 123').get();

test('совпадение по LAB-000123: значения легли, заказ ждёт проверки', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142', { unit: 'g/L' })]), '127.0.0.1');
  assert.equal(code, 'AA');

  const rows = results(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].parameter, 'Лейкоциты', 'имя обязано браться из панели, а не из провода (инвариант 4)');
  assert.equal(rows[0].unit, '10^9/л', 'единица тоже из панели: отчёт остаётся на одном языке');
  assert.equal(rows[0].value, '6.1');
  assert.equal(rows[0].numeric_value, 6.1);
  assert.equal(rows[0].source, 'analyzer');
  assert.equal(rows[0].entered_by, null, 'строку не вводил человек — выдуманный пользователь испортил бы журнал персонала');
  assert.equal(order(db).status, 'resulted');
  assert.equal(message(db).status, 'applied');
  db.close();
});

test('голые цифры тоже принимаются — сканер может не передавать префикс', () => {
  const db = fresh();
  ingestMessage(db, MSG('000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(results(db).length, 1);
  db.close();
});

// ИНВАРИАНТ 1 — машина печатает, подписывает человек.
test('приём НИКОГДА не выдаёт результат', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  const r = results(db)[0];
  assert.equal(r.verified_by, null);
  assert.equal(r.verified_at, null);
  assert.notEqual(order(db).status, 'completed', 'автовыдачи нет и не будет');
  db.close();
});

test('время забора не подставляется задним числом', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(order(db).sample_collected_at, null, 'Easy-Med не выдумывает время, которого не наблюдал');
  db.close();
});

// РЕШЕНИЕ D4 — подсказка разрешена, тихое применение нет.
test('неподтверждённое сопоставление НЕ применяется, даже когда код совпал', () => {
  const db = fresh({ confirmed: 0 });
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1'), OBX(2, 'HGB', '142')]), '127.0.0.1');

  const rows = results(db);
  assert.equal(rows.length, 1, 'применён обязан быть ТОЛЬКО подтверждённый показатель');
  assert.equal(rows[0].parameter, 'Гемоглобин');
  assert.equal(message(db).status, 'unmapped');
  assert.match(message(db).detail, /WBC/, 'лоток обязан назвать, какой именно канал не применён');
  db.close();
});

// ИНВАРИАНТ 3 — референсы принадлежат клинике.
test('диапазон клиники бьёт диапазон прибора', () => {
  const db = fresh({ refLow: 4, refHigh: 9 });
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '12.0', { range: '0-100', flag: 'N' })]), '127.0.0.1');
  const r = results(db)[0];
  assert.equal(r.flag, 'high', 'прибор сказал «норма» по СВОЕМУ диапазону — считать обязаны по диапазону клиники');
  db.close();
});

test('без диапазона клиники берётся флаг прибора, LL — это критическое', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '0.4', { flag: 'LL' })]), '127.0.0.1');
  assert.equal(results(db)[0].flag, 'critical', 'паника обязана зажечь существующий счётчик критических');
  db.close();
});

test('«<0.01» остаётся текстом, число не выдумывается', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '<0.01')]), '127.0.0.1');
  const r = results(db)[0];
  assert.equal(r.value, '<0.01');
  assert.equal(r.numeric_value, null, 'у «меньше чем» нет числового значения — иначе смысл теряется');
  db.close();
});

test('предварительный результат (P) записан в лоток, но не в бланк', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1', { status: 'P' })]), '127.0.0.1');
  assert.equal(results(db).length, 0);
  assert.ok(message(db), 'сообщение всё равно обязано сохраниться');
  db.close();
});

// РЕШЕНИЕ D6 — машина побеждает в черновике.
test('значение анализатора замещает набранное руками в НЕвыданном бланке', () => {
  const db = fresh();
  db.prepare("INSERT INTO lab_results (visit_service_id, parameter, value, source, entered_by) VALUES (123,'Лейкоциты','9.9','manual',7)").run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');

  const rows = results(db).filter((r) => r.parameter === 'Лейкоциты');
  assert.equal(rows.length, 1, 'повторный прогон обязан обновлять, а не плодить строки');
  assert.equal(rows[0].value, '6.1');
  assert.equal(rows[0].source, 'analyzer');
  db.close();
});

// РЕШЕНИЕ D7 — выданный результат машина молча не переписывает.
test('по выданному бланку сообщение помечается superseded и в бланк не идёт', () => {
  const db = fresh();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  db.prepare("UPDATE lab_results SET verified_by = 7, verified_at = '2026-09-10T10:00:00Z' WHERE visit_service_id = 123").run();
  db.prepare("UPDATE visit_services SET status = 'completed' WHERE id = 123").run();

  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '7.7')]), '127.0.0.1');

  assert.equal(results(db)[0].value, '6.1', 'выданный отчёт пациента не переписывается молча');
  assert.equal(message(db).status, 'superseded');
  assert.equal(order(db).status, 'completed', 'выданный заказ не откатывается назад');
  db.close();
});

// ИНВАРИАНТ 2 — ничего не теряется.
test('неизвестный номер пробы → unmatched, сырое сообщение сохранено', () => {
  const db = fresh();
  const code = ingestMessage(db, MSG('LAB-999999', [OBX(1, 'WBC', '6.1')]), '10.0.0.9');
  assert.equal(code, 'AA', 'ACK: сообщение принято и сохранено — повторять прибору незачем');
  const m = message(db);
  assert.equal(m.status, 'unmatched');
  assert.equal(m.peer, '10.0.0.9');
  assert.match(m.raw, /LAB-999999/, 'сырое сообщение обязано лежать целиком');
  assert.equal(results(db).length, 0);
  db.close();
});

test('панель без анализатора → unmapped: клиника ещё не сказала, кто её кормит', () => {
  const db = fresh();
  db.prepare('UPDATE lab_panels SET device_id = NULL WHERE id = 5').run();
  ingestMessage(db, MSG('LAB-000123', [OBX(1, 'WBC', '6.1')]), '127.0.0.1');
  assert.equal(message(db).status, 'unmapped');
  assert.equal(results(db).length, 0);
  db.close();
});

test('неразбираемое сообщение → rejected и NAK', () => {
  const db = fresh();
  const code = ingestMessage(db, 'это не HL7', '127.0.0.1');
  assert.equal(code, 'AE');
  assert.equal(message(db).status, 'rejected');
  db.close();
});
```

- [ ] **Шаг 2: Прогнать — ожидается падение**

```bash
npx node --test server/lis/ingest.test.js
```

- [ ] **Шаг 3: Написать лоток**

Создать `server/lis/inbox.js`:

```js
// LIS_INGEST_V1 — лоток. Инвариант 2: каждое сообщение, дошедшее до порта,
// сохраняется сырым, чем бы дело ни кончилось. Смазанный штрихкод обязан
// стоить клика, а не повторного забора крови.
export function recordMessage(db, { deviceId = null, peer = '', raw, sampleId = '', visitServiceId = null, status, detail = '' }) {
  return db.prepare(`INSERT INTO lab_device_messages
      (device_id, peer, raw, sample_id, visit_service_id, status, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(deviceId, peer, raw, sampleId, visitServiceId, status, detail).lastInsertRowid;
}

export function touchDevice(db, deviceId) {
  if (!deviceId) return;
  db.prepare("UPDATE lab_devices SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(deviceId);
}

export function resolveMessage(db, id) {
  db.prepare("UPDATE lab_device_messages SET resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(id);
}
```

- [ ] **Шаг 4: Написать приём**

Создать `server/lis/ingest.js`:

```js
// LIS_INGEST_V1 — приём: найти заказ, применить ПОДТВЕРЖДЁННОЕ сопоставление,
// записать, продвинуть статус до «Проверить и выдать».
//
// Здесь держатся решения владельца и инварианты; менять поведение этого файла
// без правки docs/specs/2026-09-10-lis-analyzer-ingest-design.md нельзя.
import { parseMessage } from './hl7.js';
import { recordMessage, touchDevice } from './inbox.js';

/** 'LAB-000123' → 123. Голые цифры принимаются: сканер может не слать префикс. */
export function parseSampleId(raw) {
  const s = String(raw || '').trim().replace(/^lab[-_]?/i, '');
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Флаг прибора → наш словарь. LL/HH намеренно ведут в 'critical': они кормят
 *  существующий счётчик критических результатов на панели отчётов. */
function flagFromDevice(abnormal) {
  switch (String(abnormal || '').toUpperCase()) {
    case '': case 'N': return 'normal';
    case 'L': return 'low';
    case 'H': return 'high';
    case 'LL': case 'HH': case 'AA': return 'critical';
    default: return 'abnormal';
  }
}

/** Инвариант 3: диапазон клиники бьёт диапазон прибора. */
function flagFromClinic(num, low, high) {
  if (num == null) return null;
  if (low != null && num < low) return 'low';
  if (high != null && num > high) return 'high';
  return 'normal';
}

/**
 * Принимает ОДНО сообщение. Возвращает 'AA' или 'AE' — то, что уйдёт прибору.
 * Всё внутри одной транзакции: ACK отправляется только после коммита.
 */
export function ingestMessage(db, raw, peer = '', deviceId = null) {
  let msg;
  try {
    msg = parseMessage(raw);
  } catch (e) {
    recordMessage(db, { deviceId, peer, raw, status: 'rejected', detail: e.message });
    return 'AE';
  }

  const vsId = parseSampleId(msg.sampleId);
  const base = { deviceId, peer, raw, sampleId: msg.sampleId };

  const order = vsId
    ? db.prepare(`SELECT vs.*, s.is_lab FROM visit_services vs
                    JOIN services s ON s.id = vs.service_id
                   WHERE vs.id = ?`).get(vsId)
    : null;

  if (!order) {
    recordMessage(db, { ...base, status: 'unmatched', detail: 'заказ по номеру пробы не найден' });
    return 'AA';   // сохранено, повторять прибору незачем
  }
  if (!order.is_lab) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmatched', detail: 'услуга не лабораторная' });
    return 'AA';
  }

  const panel = db.prepare('SELECT * FROM lab_panels WHERE service_id = ? AND active = 1 ORDER BY id LIMIT 1').get(order.service_id);
  if (!panel) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmapped', detail: 'у услуги нет панели' });
    return 'AA';
  }
  if (!panel.device_id) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmapped',
      detail: 'панель «' + panel.name + '» не привязана к анализатору' });
    return 'AA';
  }
  if (deviceId && panel.device_id !== deviceId) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'unmatched',
      detail: 'панель кормится другим анализатором' });
    return 'AA';
  }

  // D7 — выданный бланк молча не переписывается.
  const released = db.prepare('SELECT COUNT(*) c FROM lab_results WHERE visit_service_id = ? AND verified_at IS NOT NULL').get(order.id).c;
  if (released > 0) {
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'superseded',
      detail: 'результат уже выдан; новый результат требует подтверждения человеком' });
    touchDevice(db, deviceId);
    return 'AA';
  }

  const analytes = db.prepare('SELECT * FROM lab_panel_analytes WHERE panel_id = ? AND active = 1').all(panel.id);
  // D4 — применяются ТОЛЬКО подтверждённые сопоставления.
  const byCode = new Map(analytes
    .filter((a) => a.device_code && a.device_code_confirmed)
    .map((a) => [a.device_code.toUpperCase(), a]));

  const unapplied = [];
  let applied = 0;

  const run = db.transaction(() => {
    for (const obs of msg.observations) {
      const status = (obs.status || 'F').toUpperCase();
      if (status !== 'F') { unapplied.push(obs.code + ' (статус ' + status + ')'); continue; }

      const a = byCode.get(String(obs.code || '').toUpperCase());
      if (!a) { unapplied.push(obs.code); continue; }

      const num = obs.valueType === 'NM' && /^-?\d+(\.\d+)?$/.test(obs.value) ? parseFloat(obs.value) : null;
      const flag = flagFromClinic(num, a.ref_low, a.ref_high) || flagFromDevice(obs.abnormal);
      // Инвариант 4: имя и единица — из панели. Инвариант 3: диапазон — тоже.
      const range = a.ref_text || (a.ref_low != null && a.ref_high != null ? `${a.ref_low}-${a.ref_high}` : obs.range || '');

      const existing = db.prepare('SELECT id FROM lab_results WHERE visit_service_id = ? AND parameter = ?').get(order.id, a.name);
      if (existing) {
        // D6 — машина побеждает в ЧЕРНОВИКЕ (выданное отсеяно выше).
        db.prepare(`UPDATE lab_results SET value = ?, numeric_value = ?, unit = ?, reference_range = ?,
                      ref_low = ?, ref_high = ?, flag = ?, source = 'analyzer',
                      entered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE id = ?`)
          .run(obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag, existing.id);
      } else {
        db.prepare(`INSERT INTO lab_results
                      (visit_service_id, parameter, value, numeric_value, unit, reference_range, ref_low, ref_high, flag, entered_by, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'analyzer')`)
          .run(order.id, a.name, obs.value, num, a.unit || '', range, a.ref_low, a.ref_high, flag);
      }
      applied++;
    }

    if (applied > 0 && order.status !== 'completed') {
      // Инвариант 1: до «resulted», и ни шагом дальше. verified_* не трогаем.
      // sample_collected_at не подставляем: времени забора мы не наблюдали.
      db.prepare("UPDATE visit_services SET status = 'resulted' WHERE id = ?").run(order.id);
    }

    recordMessage(db, {
      ...base,
      visitServiceId: order.id,
      status: unapplied.length ? 'unmapped' : 'applied',
      detail: unapplied.length ? 'не применены: ' + unapplied.join(', ') : '',
    });
  });

  try {
    run();
  } catch (e) {
    // Транзакция откатилась. NAK — прибор пришлёт снова.
    recordMessage(db, { ...base, visitServiceId: order.id, status: 'rejected', detail: 'ошибка записи: ' + e.message });
    return 'AE';
  }

  touchDevice(db, deviceId);
  return 'AA';
}
```

- [ ] **Шаг 5: Прогнать до зелёного**

```bash
npx node --test server/lis/ingest.test.js
```

Каждое падение читать как утверждение о безопасности, а не как придирку теста.
Тест правится только если доказано, что он требует НЕ того, что написано в
спецификации.

- [ ] **Шаг 6: Коммит**

```bash
git add server/lis/ingest.js server/lis/inbox.js server/lis/ingest.test.js
git commit -m "feat(lis): приём результатов — поиск заказа, подтверждённое сопоставление, лоток, защита выданного"
```

---

## Задача 6: Поднять слушатели

**Файлы:**
- Создать: `server/lis/index.js`
- Изменить: `server/index.js`

- [ ] **Шаг 1: Написать запуск**

Создать `server/lis/index.js`:

```js
// LIS_INGEST_V1 — поднять слушатели по включённым устройствам.
//
// ОДИН слушатель на ЗАНЯТЫЙ ПОРТ, а не один на устройство: два прибора,
// настроенных на 2575, иначе подрались бы за него, и второй молча не поднялся
// бы. Устройство определяется по адресу отправителя; если адрес не задан и
// приборов на порту несколько — сообщение сохраняется без устройства и видно
// в лотке.
import { startMllpServer } from './mllp.js';
import { ingestMessage } from './ingest.js';

let running = [];

export async function startLisListeners(db, { log = console.log } = {}) {
  await stopLisListeners();
  if (process.env.LIS_ENABLED === '0') { log('LIS: выключен через LIS_ENABLED=0'); return []; }

  const devices = db.prepare("SELECT * FROM lab_devices WHERE enabled = 1 AND transport = 'mllp'").all();
  const byPort = new Map();
  for (const d of devices) {
    const port = d.port || 2575;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port).push(d);
  }

  for (const [port, list] of byPort) {
    try {
      const srv = await startMllpServer({
        port,
        log,
        onMessage: async (text, peer) => {
          const ip = String(peer || '').replace(/^::ffff:/, '');
          let device = list.find((d) => d.host && d.host === ip);
          if (!device && list.length === 1) device = list[0];
          return ingestMessage(db, text, ip, device ? device.id : null);
        },
      });
      running.push(srv);
      log(`LIS: порт ${srv.port} слушает (${list.map((d) => d.name).join(', ')})`);
    } catch (e) {
      // Не роняем приложение: неподнявшийся слушатель — это неработающий
      // анализатор, а не неработающая клиника.
      log('LIS: ' + (e && e.message ? e.message : e));
    }
  }
  return running;
}

export async function stopLisListeners() {
  const old = running;
  running = [];
  for (const s of old) { try { await s.close(); } catch { /* уже закрыт */ } }
}
```

- [ ] **Шаг 2: Подключить в `server/index.js`**

Рядом с `schedulePolling(...)` (TELEPHONY_V1) добавить импорт и вызов:

```js
import { startLisListeners } from './lis/index.js';   // LIS_INGEST_V1
```

и после старта HTTP-сервера:

```js
// LIS_INGEST_V1 — слушатели анализаторов. Не await: неподнявшийся порт не
// должен задерживать старт клиники.
startLisListeners(db).catch((e) => console.log('LIS: ' + e.message));
```

Точное место посмотреть по соседям: как именно вызывается `schedulePolling` и
что там передаётся (`db`), — повторить ту же форму.

- [ ] **Шаг 3: Проверить, что приложение стартует**

```bash
npm test 2>&1 | tail -20
node -e "import('./server/lis/index.js').then(m=>console.log(Object.keys(m)))"
```

Ожидается: тесты без новых падений; экспорт печатается.

- [ ] **Шаг 4: Коммит**

```bash
git add server/lis/index.js server/index.js
git commit -m "feat(lis): слушатели поднимаются при старте — один на порт, устройство по адресу"
```

---

## Задача 7: RPC устройств и лотка

**Файлы:**
- Создать: `server/services/rpc/lis.js`
- Создать: `server/services/rpc/lis.test.js`
- Изменить: `server/services/rpc/index.js`

- [ ] **Шаг 1: Написать RPC**

Создать `server/services/rpc/lis.js`:

```js
// LIS_INGEST_V1 — RPC для экрана «Анализаторы».
//
// Устройства читаются и правятся через обычный /api/db (они в реестре схемы).
// Здесь только то, чего таблицей не выразить: список профилей, перезапуск
// слушателей и разрешение строки лотка.
import { listProfiles } from '../../lis/profiles/index.js';
import { startLisListeners } from '../../lis/index.js';
import { ingestMessage } from '../../lis/ingest.js';
import { resolveMessage } from '../../lis/inbox.js';

const LAB_ROLES = ['admin', 'lab'];

class LisError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const guard = (user) => {
  if (!user || !LAB_ROLES.includes(user.role)) throw new LisError('Недостаточно прав', 403);
};

/** Профили для выпадающих списков экрана и редактора панелей. */
export function lisProfiles(db, args, user) {
  guard(user);
  return listProfiles().map((p) => ({
    key: p.key, vendor: p.vendor, model: p.model, kind: p.kind,
    transports: p.transports, defaultPort: p.defaultPort || 2575,
    channels: p.channels,
  }));
}

/** Перечитать устройства и поднять слушатели заново — после правки настроек. */
export async function lisRestart(db, args, user) {
  guard(user);
  const running = await startLisListeners(db);
  return { ok: true, listeners: running.length };
}

/**
 * Привязать сообщение из лотка к заказу вручную (D2: номер набирают руками,
 * значит опечатка — штатное событие). Повторный приём с явным заказом.
 */
export function lisMessageAttach(db, args, user) {
  guard(user);
  const id = Number(args && args.id);
  const vsId = Number(args && args.visit_service_id);
  if (!id || !vsId) throw new LisError('Нужны id сообщения и id заказа');

  const msg = db.prepare('SELECT * FROM lab_device_messages WHERE id = ?').get(id);
  if (!msg) throw new LisError('Сообщение не найдено', 404);

  // Подменяем номер пробы на выбранный человеком и прогоняем тот же приём —
  // второй путь записи означал бы второй набор правил.
  const retagged = msg.raw.replace(/^(OBR\|[^|]*\|[^|]*\|)[^|]*/m, `$1${vsId}`);
  const code = ingestMessage(db, retagged, msg.peer, msg.device_id);
  resolveMessage(db, id);
  return { ok: code === 'AA', code };
}

export function lisMessageDismiss(db, args, user) {
  guard(user);
  const id = Number(args && args.id);
  if (!id) throw new LisError('Нужен id сообщения');
  resolveMessage(db, id);
  return { ok: true };
}
```

- [ ] **Шаг 2: Зарегистрировать**

В `server/services/rpc/index.js` — импорт рядом с телефонией:

```js
import { lisProfiles, lisRestart, lisMessageAttach, lisMessageDismiss } from './lis.js';   // LIS_INGEST_V1
```

и в карту обработчиков (рядом с `telephony_settings_get`):

```js
  lis_profiles:         (db, args, user) => lisProfiles(db, args, user),
  lis_restart:          (db, args, user) => lisRestart(db, args, user),
  lis_message_attach:   (db, args, user) => lisMessageAttach(db, args, user),
  lis_message_dismiss:  (db, args, user) => lisMessageDismiss(db, args, user),
```

- [ ] **Шаг 3: Написать тест ролей**

Создать `server/services/rpc/lis.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { lisProfiles, lisMessageDismiss } from './lis.js';

const db = () => { const d = openDb(':memory:'); migrate(d); return d; };

test('лаборант видит профили, регистратор — нет', () => {
  const d = db();
  assert.ok(lisProfiles(d, {}, { role: 'lab' }).length >= 4);
  assert.throws(() => lisProfiles(d, {}, { role: 'reception' }), /прав/);
  assert.throws(() => lisProfiles(d, {}, null), /прав/);
  d.close();
});

test('разрешение строки лотка требует id', () => {
  const d = db();
  assert.throws(() => lisMessageDismiss(d, {}, { role: 'lab' }), /id/);
  d.close();
});
```

- [ ] **Шаг 4: Прогнать и закоммитить**

```bash
npx node --test server/services/rpc/lis.test.js
git add server/services/rpc/lis.js server/services/rpc/lis.test.js server/services/rpc/index.js
git commit -m "feat(lis): RPC — профили, перезапуск слушателей, привязка и отклонение сообщений"
```

---

## Задача 8: Симулятор в `C:\Users\user\Desktop\analyzers`

Отдельная папка ВНЕ репозитория. Свой `git init` — она не часть поставки Easy-Med.

- [ ] **Шаг 1: Создать папку и манифест**

```bash
mkdir -p "/c/Users/user/Desktop/analyzers/public"
cd "/c/Users/user/Desktop/analyzers"
git init -q
```

Создать `package.json`:

```json
{
  "name": "analyzers",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Симулятор лабораторных анализаторов для Easy-Med — говорит настоящим HL7/MLLP",
  "scripts": {
    "start": "node server.js",
    "capture": "node capture.js"
  }
}
```

- [ ] **Шаг 2: Профили**

Скопировать четыре профиля и реестр из `easymed.local/server/lis/profiles/` в
`analyzers/profiles.js` одним файлом (папка обязана работать без репозитория):

```bash
cd "/c/Users/user/Desktop/analyzers"
node -e "
const fs=require('fs');
const dir='C:/Users/user/Desktop/implementation workflow/easymed.local/server/lis/profiles/';
const files=['mindray-bc-20.js','mindray-bc-5300.js','mindray-bs-240.js','mindray-cl-900i.js'];
let out='// Копия профилей Easy-Med. Папка обязана работать без репозитория.\n';
out+='// Расхождение с server/lis/profiles/ означает, что симулятор проверяет не то,\n';
out+='// что выполняет сервер — сверять при каждом изменении профиля.\n';
let names=[];
for(const f of files){
  let src=fs.readFileSync(dir+f,'utf8');
  const name=f.replace(/[-.]/g,'_').replace(/_js$/,'');
  src=src.replace('export default','const '+name+' =');
  out+=src+'\n';
  names.push(name);
}
out+='export const PROFILES=['+names.join(',')+'];\n';
out+='export const getProfile=(k)=>PROFILES.find(p=>p.key===k)||null;\n';
fs.writeFileSync('profiles.js',out);
console.log('profiles.js записан');
"
```

- [ ] **Шаг 3: Сборка сообщения**

Создать `analyzers/hl7-build.js`:

```js
// Собирает настоящий ORU^R01 — тот же, что шлёт прибор. Частного короткого
// пути к Easy-Med у симулятора нет намеренно: если ЭТО легло правильно,
// ляжет и настоящее.
export function buildOru({ model = 'BC-5300', sampleId, values, controlId = String(Date.now() % 100000) }) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const segs = [
    `MSH|^~\\&|${model}|Mindray|||${stamp}||ORU^R01|${controlId}|P|2.3.1`,
    `OBR|1||${sampleId}|00001^Automated Count^99MRC|||${stamp}`,
  ];
  values.forEach((v, i) => {
    segs.push(`OBX|${i + 1}|NM|${v.code}^^99MRC||${v.value}|${v.unit || ''}|${v.range || ''}|${v.flag || 'N'}|||F`);
  });
  return segs.join('\r');
}
```

- [ ] **Шаг 4: Отправка**

Создать `analyzers/send.js`:

```js
import net from 'node:net';

const VT = 0x0b, FS = 0x1c, CR = 0x0d;

/** Отправляет один кадр и ждёт ACK. Возвращает текст ответа. */
export function sendMllp({ host = '127.0.0.1', port = 2575, message, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(message, 'utf8'), Buffer.from([FS, CR])]));
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('прибор не дождался ответа за ' + timeoutMs + ' мс')); }, timeoutMs);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf(FS);
      if (end !== -1) { clearTimeout(timer); sock.end(); resolve(buf.slice(1, end).toString('utf8')); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
```

- [ ] **Шаг 5: Захват**

Создать `analyzers/capture.js`:

```js
// Режим «слушать и записать». Ради одного: когда прибор в клинике ведёт себя
// не так, инженер получает СЫРЫЕ байты, а не пожатие плечами.
import net from 'node:net';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 2575);
const OUT = process.argv[3] || `capture-${new Date().toISOString().slice(0, 10)}.txt`;
const VT = 0x0b, FS = 0x1c, CR = 0x0d;

net.createServer((sock) => {
  const peer = sock.remoteAddress;
  console.log('подключился', peer);
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    fs.appendFileSync(OUT, `\n===== ${new Date().toISOString()} ${peer} =====\n${chunk.toString('utf8')}\n--- HEX ---\n${chunk.toString('hex')}\n`);
    for (;;) {
      const s = buf.indexOf(VT), e = buf.indexOf(FS, s + 1);
      if (s === -1 || e === -1) break;
      const text = buf.slice(s + 1, e).toString('utf8');
      buf = buf.slice(e + 2);
      console.log('--- сообщение ---\n' + text.split('\r').join('\n'));
      const ack = `MSH|^~\\&|CAPTURE|||||||ACK|1|P|2.3.1\rMSA|AA|1`;
      sock.write(Buffer.concat([Buffer.from([VT]), Buffer.from(ack, 'utf8'), Buffer.from([FS, CR])]));
    }
  });
}).listen(PORT, '0.0.0.0', () => console.log(`Захват на порту ${PORT}. Пишу в ${OUT}. Ctrl+C — стоп.`));
```

- [ ] **Шаг 6: Вид**

Создать `analyzers/server.js` — локальный HTTP на 3100, отдаёт `public/index.html`,
`GET /api/profiles` возвращает `PROFILES`, `POST /api/publish` принимает
`{ profile, sampleId, host, port, values }`, собирает через `buildOru`,
отправляет через `sendMllp` и возвращает `{ ok, ack }`. Без зависимостей —
`node:http`, `JSON.parse` тела.

Создать `analyzers/public/index.html` — одна страница: выпадающий список машин,
поле «Номер пробы» (по умолчанию `LAB-000123`), поля адреса и порта Easy-Med
(`127.0.0.1` / `2575`), таблица каналов выбранной машины с полем значения у
каждого, кнопка «Опубликовать» и область ответа, куда печатается ACK. Никаких
эмодзи; вид простой, это инструмент разработки.

- [ ] **Шаг 7: `.bat` в форме, привычной владельцу**

Создать `analyzers/LIS.bat`:

```bat
@echo off
REM Симулятор анализаторов для Easy-Med.
REM Открывает вид в браузере: выбрать машину, ввести значения, опубликовать.
cd /d "%~dp0"
start "" http://127.0.0.1:3100
node server.js
pause
```

Создать `analyzers/CAPTURE.bat`:

```bat
@echo off
REM Захват: слушает порт 2575 и пишет всё пришедшее в файл.
REM Запускать на лабораторном ПК, когда нужно узнать, ЧТО именно шлёт прибор.
cd /d "%~dp0"
node capture.js 2575
pause
```

- [ ] **Шаг 8: Проверить сквозь**

```bash
cd "/c/Users/user/Desktop/analyzers" && node -e "
import('./hl7-build.js').then(async ({buildOru})=>{
  const m=buildOru({sampleId:'LAB-000123',values:[{code:'WBC',value:'6.1',unit:'10*9/L'}]});
  console.log(m.split('\r').join('\n'));
});"
```

Ожидается: печатается корректный ORU с MSH, OBR и одним OBX.

- [ ] **Шаг 9: README и коммит**

Создать `analyzers/README.md`: что это, как запустить (`LIS.bat`), как захватить
(`CAPTURE.bat`), и предупреждение, что `profiles.js` — копия серверных профилей
и обязана с ними сходиться.

```bash
cd "/c/Users/user/Desktop/analyzers"
git add -A && git commit -q -m "feat: симулятор анализаторов — HL7/MLLP, вид, захват, .bat"
```

---

## Задача 9: Вкладка «Анализаторы»

**Файлы:**
- Создать: `public/js/admin/views/lab-devices.js`
- Изменить: `public/js/admin/views/laboratory.js`

- [ ] **Шаг 1: Добавить режим в `laboratory.js`**

1. В `MODES` добавить четвёртым: `{ key: 'devices', label: 'Анализаторы' }`.
2. В `renderLaboratory` расширить разбор подпути:
   `state.mode = ((sub === 'panels' || sub === 'stats' || sub === 'devices') && canEditLabPanels()) ? sub : 'queue';`
3. В `paintMode()` добавить ветку:
   `else if (state.mode === 'devices') await mountLabDevices(refs.panelsHost);`
4. Импорт рядом с `mountLabPanels`:
   `import { mountLabDevices } from './lab-devices.js';   // LIS_INGEST_V1`
5. В объект подсказок (где лежит `panels: 'Панели исследований…'`) добавить:
   `devices: 'Анализаторы клиники: подключение, состояние и необработанные сообщения.'`

- [ ] **Шаг 2: Написать экран**

Создать `public/js/admin/views/lab-devices.js`. Идиомы брать из `lab-panels.js`
(тот же `h`, `Icon`, `toast`, `clear`, тот же `supabase` шим). Экран содержит:

- `mountLabDevices(container)` — единственный экспорт.
- Карточка «Анализаторы»: таблица `name · model · подключение · состояние ·
  последнее сообщение`, кнопка «Добавить». Состояние считается от
  `last_seen_at`: пусто → «сообщений не было»; меньше часа → «получает
  результаты»; иначе → «молчит с <дата>». Молчание показывается предупреждающим
  тоном — оно и есть тот отказ, который иначе длится неделю.
- Форма устройства: имя, профиль (из `lis_profiles`), транспорт, адрес, порт
  (по умолчанию `defaultPort` профиля), включён. Выбор транспорта `serial` или
  `folder` сохраняется, но под полем печатается «транспорт пока не
  поддерживается — будет в следующей поставке».
- Сохранение — обычной записью в `lab_devices` через `supabase.from(...)`,
  затем `rpc('lis_restart')`, чтобы слушатель поднялся без перезапуска клиники.
- Карточка «Необработанные»: `lab_device_messages` где `resolved_at is null` и
  `status <> 'applied'`, колонки `received_at · sample_id · status · detail`,
  раскрытие сырого текста, кнопки «Привязать к заказу» (спрашивает номер заказа,
  зовёт `lis_message_attach`) и «Отклонить» (`lis_message_dismiss`).

- [ ] **Шаг 3: Проверить руками**

```bash
npm start
```

Открыть `http://127.0.0.1:8000/admin#labs/devices`. Ожидается: вкладка есть,
устройство заводится, после сохранения в консоли сервера появляется
`LIS: порт 2575 слушает (…)`.

- [ ] **Шаг 4: Коммит**

```bash
git add public/js/admin/views/lab-devices.js public/js/admin/views/laboratory.js
git commit -m "feat(lis): вкладка «Анализаторы» — устройства, состояние связи, лоток необработанных"
```

---

## Задача 10: Сопоставление в редакторе панелей

**Файлы:**
- Изменить: `public/js/admin/views/lab-panels.js`

- [ ] **Шаг 1: Выбор анализатора у панели**

В форме панели (рядом с полем услуги) добавить `<select>` «Анализатор» со
списком из `lab_devices` плюс пункт «— нет —» (значение `''` → `device_id`
пишется `null`). Сохранять вместе с остальными полями панели.

- [ ] **Шаг 2: Колонка «Поле анализатора» у показателя**

В таблице показателей добавить колонку. Её содержимое зависит от панели:

- анализатор не выбран → прочерк и подсказка «выберите анализатор панели»;
- выбран → `<select>` с каналами профиля (`lis_profiles` → `channels`) плюс
  «— не выбрано —».

Строка, у которой `device_code_confirmed = 0`, но `device_code` не пуст,
рисуется приглушённо с пометкой «предложено» и кнопкой «Подтвердить». Ручное
изменение значения в списке считается подтверждением (человек выбрал сам).

- [ ] **Шаг 3: Предзаполнение подсказками**

При выборе анализатора для панели: для каждого показателя без `device_code`
искать канал, у которого `code` совпадает с `lab_panel_analytes.code` без учёта
регистра. Нашёлся → проставить `device_code` и `device_code_confirmed = 0`.
Ничего не нашлось — оставить пустым.

- [ ] **Шаг 4: Запретить сохранение с неподтверждёнными строками**

Это единственное место, где решение владельца D4 держится технически. В функции
сохранения панели, ДО записи:

```js
// D4 — подсказка разрешена, тихое применение нет. Панель с непод­тверждёнными
// строками сохранить нельзя: иначе «предложено» тихо стало бы «применяется».
const unconfirmed = rows.filter((r) => r.device_code && !r.device_code_confirmed);
if (unconfirmed.length) {
    toast('Подтвердите поля анализатора: ' + unconfirmed.map((r) => r.name).join(', '), 'error');
    return;
}
```

- [ ] **Шаг 5: Проверить руками**

Открыть `#labs/panels`, выбрать панель, назначить анализатор. Ожидается:
подсказки проставились приглушённо; попытка сохранить даёт сообщение со списком
неподтверждённых; после подтверждения всех строк панель сохраняется.

- [ ] **Шаг 6: Сквозной проход**

1. `npm start` в `easymed.local`.
2. Завести пациента, визит и лабораторную услугу; довести заказ до «Забор пробы»
   и запомнить номер `LAB-…` со штрихкода.
3. `LIS.bat` в `C:\Users\user\Desktop\analyzers`.
4. Выбрать BC-5300, ввести номер пробы и значения, «Опубликовать».
5. Ожидается: ACK в виде симулятора; заказ в очереди перешёл в «Проверить и
   выдать»; в бланке стоят значения с пометкой «из анализатора».
6. Выдать результат и убедиться, что он попал в карту пациента.

- [ ] **Шаг 7: Коммит**

```bash
git add public/js/admin/views/lab-panels.js
git commit -m "feat(lis): сопоставление поле-в-поле в редакторе панелей — подсказка, подтверждение, запрет сохранения"
```

---

## Проверка полноты

| Требование спецификации | Задача |
|---|---|
| Миграция 123, реестр схемы | 1 |
| Разбор HL7, узнавание `QRY^Q02` | 2 |
| MLLP, ACK/NAK, потолок, тайм-аут | 3 |
| Профили как данные; BC-20, BC-5300, BS-240, CL-900i | 4 |
| Поиск заказа по `LAB-…` и голым цифрам | 5 |
| D3/D4 — только подтверждённое сопоставление | 5, 10 |
| D6 — машина побеждает в черновике | 5 |
| D7 — выданное не переписывается | 5 |
| Инварианты 1–5 | 5 (1–4), 1 + 3 (5) |
| Лоток, ничего не теряется | 5, 9 |
| Один слушатель на порт | 6 |
| Экран «Анализаторы» + состояние связи | 9 |
| Симулятор, `.bat`, захват | 8 |
| Сквозная проверка | 10, шаг 6 |
