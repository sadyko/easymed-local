# Фаза 2: пациенты и клинические записи ездят между филиалами

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ НАВЫК — superpowers:subagent-driven-development
> (рекомендуется) или superpowers:executing-plans. Шаги отмечаются `- [ ]`.

**Цель:** пациент, заведённый в одном филиале, виден во всех; лабораторная
очередь и результаты — тоже.

**Архитектура:** у каждой синхронизируемой строки появляется `uid` — глобально
уникальный и неизменный. Триггеры БД пишут журнал изменений (`sync_journal`) с
гибридными логическими часами. Филиал выкладывает ХВОСТ своего журнала на тот же
шифрованный релей, что уже возит справочник, и забирает чужие. Приём переводит
`uid` в собственные локальные `id`, сливает поколоночно по правилу «последняя
правка побеждает» и никогда не удаляет строку, которую правили позже.

**Стек:** Node 24, better-sqlite3, node:test. Транспорт — существующий
`relay.js` (AES-256-GCM + gzip через settings.easymed.uz).

---

## Что входит и что НЕ входит

**Входит** (ровно то, что нужно для списка пациентов и лабораторной очереди):
`patients`, `visits`, `visit_services`, `lab_results`.

**НЕ входит, намеренно:**

- `invoices`, `payments`, `cash_movements` — Фаза 3. Требование владельца:
  тестовая клиника должна отработать на Фазе 2 прежде, чем деньги поедут.
- `users`, `roles`, `role_permissions` — они однонаправленные (главная →
  филиалы) и поедут расширением списка справочника, а не журналом. Отдельная
  задача, не смешивать с двусторонним потоком.
- `rooms`, `wards`, `beds`, `floors`, `service_queue_tickets` — решение
  владельца: «which is clinics own».

**Почему `visit_services` входит, хотя это на первый взгляд про деньги:** на
`visit_services.status` построена ЛАБОРАТОРНАЯ ОЧЕРЕДЬ
(`public/js/admin/views/laboratory.js`: ordered → collected → in_progress →
completed). Без неё «лабораторная очередь между филиалами» невозможна. Денежные
поля строки (`unit_price`, `total`, `invoice_item_id`) при этом НЕ переносятся —
см. Задачу 5.

---

## Структура файлов

| Файл | Ответственность |
|---|---|
| `server/db/migrations/083_sync_uid.sql` | колонка `uid` на четырёх таблицах, засев для существующих строк, уникальные индексы |
| `server/db/migrations/083.test.js` | что засев ничего не потерял и `uid` не повторяется |
| `server/db/migrations/084_sync_journal.sql` | таблица `sync_journal` + триггеры INSERT/UPDATE/DELETE на четырёх таблицах |
| `server/db/migrations/084.test.js` | что журнал пишется САМ, в обход прикладного кода |
| `server/services/branch-sync/hlc.js` | гибридные логические часы: строковая метка, сравнимая лексикографически |
| `server/services/branch-sync/hlc.test.js` | порядок при разошедшихся часах |
| `server/services/branch-sync/journal.js` | чтение хвоста журнала, отметка «докуда отдано», сборка порции |
| `server/services/branch-sync/journal.test.js` | границы порции, отметки, пустой хвост |
| `server/services/branch-sync/records.js` | ПРИЁМ: uid→локальный id, поколоночное слияние, правило удалений |
| `server/services/branch-sync/records.test.js` | слияние, конфликты, удаления, ссылки на неприехавшие строки |
| `server/services/branch-sync/relay-crypto.js` (правка) | адрес блоба ДЛЯ УЗЛА, а не для группы |
| `server/services/branch-sync/relay.js` (правка) | выложить/забрать журнальные блобы |
| `server/services/rpc/branch-sync.js` (правка) | обмен записями в том же вызове, что и справочник |

---

## Задача 1: колонка `uid`

**Файлы:**
- Создать: `server/db/migrations/083_sync_uid.sql`
- Создать: `server/db/migrations/083.test.js`

- [ ] **Шаг 1: миграция**

```sql
-- 083_sync_uid.sql — BRANCH_RECORDS_V1: глобальная личность строки.
--
-- Локальный id — счётчик ВНУТРИ базы: пациент №500 есть в каждом филиале и это
-- разные люди. Пока базы не встречались, это безвредно; в тот момент, когда
-- они встретятся, каждая ссылка «визит → пациент» должна пережить границу.
-- uid переживает, локальный id — нет.
--
-- Почему не переиспользуем branch_sync_map (079): та карта односторонняя и
-- рассчитана на один пишущий узел (главный отдаёт справочник). Здесь пишут все.
--
-- TEXT, а не BLOB: uid попадает в JSON выгрузки, и hex-строка не требует
-- кодирования на каждом шаге.
ALTER TABLE patients        ADD COLUMN uid TEXT;
ALTER TABLE visits          ADD COLUMN uid TEXT;
ALTER TABLE visit_services  ADD COLUMN uid TEXT;
ALTER TABLE lab_results     ADD COLUMN uid TEXT;

-- Засев для строк, которые уже есть. lower(hex(randomblob(16))) — 128 бит из
-- ГСЧ SQLite: столкновение невероятнее, чем потеря базы.
UPDATE patients       SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE visits         SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE visit_services SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
UPDATE lab_results    SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;

-- UNIQUE, а не просто INDEX: приём ищет строку по uid, и два совпадения
-- означали бы, что одна запись приехала дважды под разными локальными id —
-- молча выбрать любую из них хуже, чем упасть.
CREATE UNIQUE INDEX idx_patients_uid       ON patients(uid);
CREATE UNIQUE INDEX idx_visits_uid         ON visits(uid);
CREATE UNIQUE INDEX idx_visit_services_uid ON visit_services(uid);
CREATE UNIQUE INDEX idx_lab_results_uid    ON lab_results(uid);

-- Новые строки получают uid сами: прикладной код о нём знать не обязан, а
-- строка без uid не поедет никуда и обнаружится через недели.
CREATE TRIGGER patients_uid_autogen AFTER INSERT ON patients
  WHEN NEW.uid IS NULL
  BEGIN UPDATE patients SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER visits_uid_autogen AFTER INSERT ON visits
  WHEN NEW.uid IS NULL
  BEGIN UPDATE visits SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER visit_services_uid_autogen AFTER INSERT ON visit_services
  WHEN NEW.uid IS NULL
  BEGIN UPDATE visit_services SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
CREATE TRIGGER lab_results_uid_autogen AFTER INSERT ON lab_results
  WHEN NEW.uid IS NULL
  BEGIN UPDATE lab_results SET uid = lower(hex(randomblob(16))) WHERE id = NEW.id; END;
```

- [ ] **Шаг 2: тест**

```js
// 083.test.js — BRANCH_RECORDS_V1: uid есть у всех и ни у кого не повторяется.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const TABLES = ['patients', 'visits', 'visit_services', 'lab_results'];

test('083: у каждой существующей строки появляется uid', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run();
  for (const t of TABLES) {
    const missing = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE uid IS NULL`).get().n;
    assert.equal(missing, 0, t + ': строка без uid никуда не поедет');
  }
  db.close();
});

test('083: новая строка получает uid без участия прикладного кода', () => {
  const db = openDb(':memory:');
  migrate(db);
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Петров Пётр')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  assert.match(uid, /^[0-9a-f]{32}$/, 'uid проставлен триггером: ' + uid);
  db.close();
});

test('083: uid уникален — две записи под одним uid означали бы двойной приём', () => {
  const db = openDb(':memory:');
  migrate(db);
  const a = db.prepare("INSERT INTO patients (full_name) VALUES ('А')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(a).uid;
  db.prepare("INSERT INTO patients (full_name) VALUES ('Б')").run();
  assert.throws(
    () => db.prepare('UPDATE patients SET uid = ? WHERE full_name = ?').run(uid, 'Б'),
    /UNIQUE/,
    'база обязана отказать, а не выбрать одну из двух молча');
  db.close();
});
```

- [ ] **Шаг 3: прогнать — должно упасть**

Запустить: `node --test server/db/migrations/083.test.js`
Ожидается: FAIL — «no such column: uid».

- [ ] **Шаг 4: прогнать после миграции — должно пройти**

Запустить: `node --test server/db/migrations/083.test.js`
Ожидается: 3 из 3 PASS.

- [ ] **Шаг 5: реестр колонок**

`server/db/schema-registry.js` управляет тем, какие колонки видит `/api/db`.
Добавить `uid` в разрешённые для четырёх таблиц НЕЛЬЗЯ: наружу он не нужен, а
лишняя колонка в ответе — лишняя поверхность. Проверить, что реестр не
перечисляет колонки через `SELECT *`:

Запустить: `grep -n "SELECT \*" server/db/schema-registry.js`
Ожидается: пусто (реестр — явный список колонок, `uid` в нём нет).

**Что эта проверка НЕ доказывает** (ревью Задачи 1): `uid` всё же доходит до
клиента через RPC, отдающие строку целиком — `rpc/visits.js:110` (`SELECT *`),
`rpc/billing.js`, `rpc/inpatient.js`, `rpc/inventory.js`. Вред низкий: случайный
непрозрачный id, только для сотрудников. Записано, чтобы никто не строил на
«uid не покидает сервер».

- [ ] **Шаг 6: коммит**

```bash
git add server/db/migrations/083_sync_uid.sql server/db/migrations/083.test.js
git commit -m "feat(sync): глобальный uid у пациентов, визитов, услуг и результатов"
```

---

## Задача 2: гибридные логические часы

**Файлы:**
- Создать: `server/services/branch-sync/hlc.js`
- Создать: `server/services/branch-sync/hlc.test.js`

- [ ] **Шаг 1: тест**

```js
// hlc.test.js — BRANCH_RECORDS_V1: порядок событий, переживающий разные часы.
//
// Сравнивать updated_at нельзя: часы двух зданий расходятся, а переведённые
// назад часы одного филиала ОТМЕНЯЛИ БЫ правки другого — молча и задним
// числом. Гибридные часы дают порядок, который не ломается от этого.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStamp, compareStamps } from './hlc.js';

test('метка растёт даже когда часы стоят на месте', () => {
  const clock = () => 1000;
  let state = null;
  const a = nextStamp(state, 'B', clock); state = a;
  const b = nextStamp(state, 'B', clock);
  assert.equal(compareStamps(b.stamp, a.stamp) > 0, true, 'вторая метка больше первой');
});

test('метка растёт, когда часы перевели НАЗАД', () => {
  let now = 5000;
  const clock = () => now;
  let state = nextStamp(null, 'B', clock);
  now = 1000;                       // кто-то поправил время на машине
  const after = nextStamp(state, 'B', clock);
  assert.equal(compareStamps(after.stamp, state.stamp) > 0, true,
    'иначе правки после перевода часов проиграли бы старым');
});

test('метки сравниваются лексикографически — как строки в SQL ORDER BY', () => {
  const clock = () => 2000;
  const a = nextStamp(null, 'B', clock);
  const b = nextStamp(a, 'B', clock);
  const sorted = [b.stamp, a.stamp].sort();
  assert.deepEqual(sorted, [a.stamp, b.stamp],
    'порядок строк обязан совпадать с порядком событий: журнал читают SQL-ом');
});

test('узел входит в метку — две машины в одну миллисекунду не сольются', () => {
  const clock = () => 3000;
  const b = nextStamp(null, 'B', clock);
  const c = nextStamp(null, 'C', clock);
  assert.notEqual(b.stamp, c.stamp);
});
```

- [ ] **Шаг 2: прогнать — должно упасть**

Запустить: `node --test server/services/branch-sync/hlc.test.js`
Ожидается: FAIL — «Cannot find module './hlc.js'».

- [ ] **Шаг 3: реализация**

```js
// BRANCH_RECORDS_V1 — гибридные логические часы.
//
// Метка: <миллисекунды в hex, 12 знаков>-<счётчик в hex, 4 знака>-<буква узла>.
// Ширина фиксирована, поэтому лексикографическое сравнение строк совпадает с
// хронологическим — журнал можно читать обычным ORDER BY, без разбора.
//
// Счётчик существует ради двух случаев, и оба реальны: несколько правок в одну
// миллисекунду и часы, переведённые назад. Во втором случае физическое время
// не растёт, и единственное, что удерживает порядок, — счётчик.
//
// Буква узла в хвосте: две машины, изменившие разные строки в одну и ту же
// миллисекунду, обязаны получить разные метки, иначе одна из правок исчезнет
// при слиянии.

const MS_HEX = 12;
const CNT_HEX = 4;
const MAX_CNT = 0xffff;

/**
 * @param {{ms:number, cnt:number}|null} state предыдущее состояние часов
 * @param {string} node буква филиала
 * @param {() => number} [clock]
 * @returns {{stamp:string, ms:number, cnt:number}}
 */
export function nextStamp(state, node, clock = Date.now) {
  const wall = Math.max(0, Math.floor(clock()));
  const prevMs = state && Number.isFinite(state.ms) ? state.ms : 0;
  const prevCnt = state && Number.isFinite(state.cnt) ? state.cnt : 0;

  let ms = wall;
  let cnt = 0;
  if (wall <= prevMs) {
    // Часы не ушли вперёд — держим порядок счётчиком.
    ms = prevMs;
    cnt = prevCnt + 1;
    if (cnt > MAX_CNT) { ms = prevMs + 1; cnt = 0; }
  }
  const stamp = ms.toString(16).padStart(MS_HEX, '0')
    + '-' + cnt.toString(16).padStart(CNT_HEX, '0')
    + '-' + String(node || '?').toUpperCase();
  return { stamp, ms, cnt };
}

/** Отрицательное / 0 / положительное — как у любого компаратора. */
export function compareStamps(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  return x < y ? -1 : x > y ? 1 : 0;
}
```

- [ ] **Шаг 4: прогнать — должно пройти**

Запустить: `node --test server/services/branch-sync/hlc.test.js`
Ожидается: 4 из 4 PASS.

- [ ] **Шаг 5: коммит**

```bash
git add server/services/branch-sync/hlc.js server/services/branch-sync/hlc.test.js
git commit -m "feat(sync): гибридные логические часы для порядка правок между филиалами"
```

---

## Задача 3: журнал изменений

**Файлы:**
- Создать: `server/db/migrations/084_sync_journal.sql`
- Создать: `server/db/migrations/084.test.js`

- [ ] **Шаг 1: миграция**

```sql
-- 084_sync_journal.sql — BRANCH_RECORDS_V1: что изменилось и когда.
--
-- ВНИМАНИЕ. Любой массовый UPDATE этих четырёх таблиц теперь сетевое событие:
-- каждая тронутая строка уедет соседям целиком. Служебные правки ограничивайте
-- WHERE (например, WHERE phone <> trim(phone)) или временно снимайте журнальные
-- триггеры вокруг них. И никогда не удаляйте из этих таблиц с foreign_keys =
-- OFF: удаление зажурналится, а осиротевшие дети — нет.
--
-- Журнал НЕ засевается для уже существующих строк: холодного соседа (без строки
-- в sync_peers) отправитель кормит из самих таблиц (Задача 4). Засев в миграции
-- добавил бы по строке на каждую запись на каждой клинике навсегда.
--
-- Пишется ТРИГГЕРАМИ, а не прикладным кодом. Это не стилистика: путей, которыми
-- строка меняется, в этом проекте десятки (RPC, импорт, ручные правки), и
-- дописать журнал в каждый — значит однажды забыть. Триггер обойти нельзя.
--
-- Побочная выгода, которую стоит назвать вслух: у большинства этих таблиц не
-- было аудиторского следа вообще.
CREATE TABLE sync_journal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- локальный порядок отдачи
  tbl        TEXT NOT NULL,
  uid        TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('put', 'del')),
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- seq — это rowid (INTEGER PRIMARY KEY AUTOINCREMENT): отдельный индекс по нему
-- дублировал бы rowid. AUTOINCREMENT обязателен: приём вычищает хвост журнала,
-- и без него следующий seq мог бы оказаться НИЖЕ sent_seq соседа — местная
-- правка никогда бы не уехала. Сжатие — по (tbl, uid): у строки, изменённой сто
-- раз, отдавать надо последнее состояние, а не сто записей.
CREATE INDEX idx_sync_journal_row ON sync_journal(tbl, uid);

-- ВСТАВКА ЧИТАЕТ СТРОКУ, А НЕ NEW. В AFTER INSERT триггере NEW.uid — значение,
-- КАК ВСТАВИЛИ: NULL, потому что приложение uid не задаёт. Триггер
-- *_uid_autogen (083) чинит СТРОКУ, но соседний AFTER INSERT триггер этого
-- UPDATE в своём NEW не увидит ни при каком порядке срабатывания, а порядок
-- AFTER-триггеров SQLite не определяет вовсе (на деле — обратный порядку
-- создания, и patients_mrn_autogen в этом репозитории пересоздавали уже
-- дважды: 034, 080). Записать NEW.uid значило бы NOT NULL constraint failed на
-- КАЖДОЙ регистрации пациента (проверено ревью Задачи 1). Поэтому — SELECT из
-- самой таблицы, и только если uid уже есть; если нет, строку зажурналит
-- UPDATE uid-триггера через *_journal_upd мгновением позже. Один INSERT даёт
-- ДВЕ записи журнала — это нормально, buildBatch уплотняет по (tbl, uid).
--
-- ТО ЖЕ ПРАВИЛО ДЛЯ UPDATE. patients_mrn_autogen тоже делает UPDATE строки из
-- своего AFTER INSERT; сработай он РАНЬШЕ uid-триггера — *_journal_upd с
-- NEW.uid записал бы NULL и уронил регистрацию. Проверено в обоих порядках:
-- с SELECT из таблицы — зелено, с NEW.uid — падает. Порядок, напомню, не
-- определён и в этом репозитории уже менялся. *_journal_del получает
-- WHEN OLD.uid IS NOT NULL — достижимого NULL там не построить, это страховка.
--
-- op='put', а не 'insert'/'update': принимающей стороне разница не нужна —
-- у неё этой строки либо нет (создаст), либо есть (сольёт). Две операции
-- вместо трёх убирают целый класс вопросов «а что если insert приехал после
-- update».
CREATE TRIGGER patients_journal_ins AFTER INSERT ON patients
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'patients', uid, 'put' FROM patients
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER patients_journal_upd AFTER UPDATE ON patients
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'patients', uid, 'put' FROM patients
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER patients_journal_del AFTER DELETE ON patients
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('patients', OLD.uid, 'del'); END;

CREATE TRIGGER visits_journal_ins AFTER INSERT ON visits
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visits', uid, 'put' FROM visits
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visits_journal_upd AFTER UPDATE ON visits
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visits', uid, 'put' FROM visits
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visits_journal_del AFTER DELETE ON visits
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('visits', OLD.uid, 'del'); END;

CREATE TRIGGER visit_services_journal_ins AFTER INSERT ON visit_services
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visit_services', uid, 'put' FROM visit_services
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visit_services_journal_upd AFTER UPDATE ON visit_services
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'visit_services', uid, 'put' FROM visit_services
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER visit_services_journal_del AFTER DELETE ON visit_services
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('visit_services', OLD.uid, 'del'); END;

CREATE TRIGGER lab_results_journal_ins AFTER INSERT ON lab_results
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'lab_results', uid, 'put' FROM lab_results
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER lab_results_journal_upd AFTER UPDATE ON lab_results
  BEGIN INSERT INTO sync_journal (tbl, uid, op)
        SELECT 'lab_results', uid, 'put' FROM lab_results
         WHERE id = NEW.id AND uid IS NOT NULL; END;
CREATE TRIGGER lab_results_journal_del AFTER DELETE ON lab_results
  WHEN OLD.uid IS NOT NULL
  BEGIN INSERT INTO sync_journal (tbl, uid, op) VALUES ('lab_results', OLD.uid, 'del'); END;

-- Записи, у которых ещё нет родителя. Хранятся целиком (JSON) и применяются,
-- когда родитель приезжает. Ключ — (tbl, uid): у одной строки одно последнее
-- состояние; более поздняя запись про ту же строку замещает более раннюю.
CREATE TABLE sync_pending (
  tbl        TEXT NOT NULL,
  uid        TEXT NOT NULL,
  stamp      TEXT NOT NULL,
  record     TEXT NOT NULL,          -- JSON всей записи, как приехала
  waits_tbl  TEXT NOT NULL,          -- какого родителя ждёт
  waits_uid  TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (tbl, uid)
);
CREATE INDEX idx_sync_pending_parent ON sync_pending(waits_tbl, waits_uid);

-- Метка последнего ПРИНЯТОГО изменения КАЖДОЙ колонки строки: слияние
-- поколоночное. col = '*' — надгробие: строка удалена с этой меткой, и put
-- старше него не воскрешает строку. Здесь, а не CREATE IF NOT EXISTS в коде:
-- таблица, о которой не знает schema_migrations, не попадает в решение о
-- резервной копии перед миграцией и не поддаётся следующей миграции.
CREATE TABLE sync_seen (
  tbl   TEXT NOT NULL,
  uid   TEXT NOT NULL,
  col   TEXT NOT NULL,
  stamp TEXT NOT NULL,
  PRIMARY KEY (tbl, uid, col)
);

-- Докуда каждому соседу уже отдано и что от него принято. Ключ — буква узла.
CREATE TABLE sync_peers (
  node       TEXT PRIMARY KEY,
  sent_seq   INTEGER NOT NULL DEFAULT 0,   -- наш журнал: докуда отдали
  last_ok    TEXT                          -- когда последний раз отдали успешно
);
```

- [ ] **Шаг 2: тест**

```js
// 084.test.js — BRANCH_RECORDS_V1: журнал пишется САМ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();   // засев миграции 083 не мешает
  return db;
}

test('084: создание пациента попадает в журнал без участия кода', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const rows = db.prepare("SELECT tbl, op FROM sync_journal WHERE tbl = 'patients'").all();
  assert.equal(rows.length >= 1, true);
  assert.equal(rows[0].op, 'put');
  db.close();
});

test('084: правка пишется отдельной записью', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const before = db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
  db.prepare("UPDATE patients SET phone = '+998900000000' WHERE id = ?").run(id);
  const after = db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n;
  assert.equal(after > before, true, 'правку обязаны увидеть соседи');
  db.close();
});

test('084: удаление записывается по uid УДАЛЁННОЙ строки', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  const del = db.prepare("SELECT uid FROM sync_journal WHERE op = 'del'").get();
  assert.equal(del.uid, uid, 'без uid соседи не поймут, что удалять');
  db.close();
});

test('084: журнал ведётся для всех четырёх таблиц', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)')
    .run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Анализ','S-9',1000,'lab',1)").run().lastInsertRowid;
  const vsid = db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity) VALUES (?, ?, 1)')
    .run(vid, sid).lastInsertRowid;
  db.prepare("INSERT INTO lab_results (visit_service_id, value) VALUES (?, '5.2')").run(vsid);

  const tables = db.prepare('SELECT DISTINCT tbl FROM sync_journal ORDER BY tbl').all().map(r => r.tbl);
  assert.deepEqual(tables, ['lab_results', 'patients', 'visit_services', 'visits']);
  db.close();
});
```

- [ ] **Шаг 3: прогнать — должно упасть**

Запустить: `node --test server/db/migrations/084.test.js`
Ожидается: FAIL — «no such table: sync_journal».

- [ ] **Шаг 4: прогнать после миграции — должно пройти**

Запустить: `node --test server/db/migrations/084.test.js`
Ожидается: 4 из 4 PASS.

- [ ] **Шаг 5: коммит**

```bash
git add server/db/migrations/084_sync_journal.sql server/db/migrations/084.test.js
git commit -m "feat(sync): журнал изменений, который пишут триггеры"
```

---

## Задача 4: сборка порции для соседа

> **Правки по ревью (2026-09-02), обязательные для реализации:**
>
> 1. **Холодный засев — страницами, с курсором и замороженным полом.** Наивный
>    засев отдавал первую страницу (`limit`) и делал соседа тёплым: остальное
>    не уезжало НИКОГДА (измерено: 5 000 из 18 000). В `sync_peers` —
>    `seed_floor` (MAX(seq) в момент старта), `seed_at`/`seed_tbl`/`seed_id`
>    (курсор). Пока `seed_floor IS NOT NULL`, `sent_seq = seed_floor`, и чистка
>    не трогает журнал под идущим засевом. Порядок — глобально по
>    `(created_at, ранг таблицы, id)`: дети создаются после родителей, поэтому
>    страницы сохраняют «родитель раньше ребёнка», а метки остаются близки к
>    времени правки (без раздувания счётчика от порядка TABLES).
> 2. **Надгробия переживают чистку.** Забытый сосед получал засев из живых
>    таблиц — присутствия без удалений — и ВОСКРЕШАЛ удалённого пациента у
>    отправителя. `sync_tombstones(tbl, uid, at)` пишут `*_journal_del`;
>    засев начинается с `del` по всем надгробиям; хранятся 60 дней (2×STALE_DAYS;
>    сосед, молчавший дольше, может воскресить строку — риск ограничен и записан).
> 3. **`SHIPPED.lab_results` += `parameter`, `ref_low`, `ref_high`** — без имени
>    аналита панель из 20 показателей схлопывалась у соседа в одно безымянное
>    число (`rpc/documents.js` группирует по `parameter`).
> 4. `Date.parse(at)` не число → `clockFn`, а не метка 1970 года. `markSent` —
>    в транзакции. Пустой `sync_peers` после чистки → журнал режется до MAX(seq).
>    Подготовленные запросы — один раз на порцию, не на строку.
> 5. Открытые вопросы для Этапа 1 (справочник): `services.code` без UNIQUE и без
>    индекса — разрешение по коду берёт `ORDER BY id LIMIT 1`; частичный
>    уникальный индекс потребует дедупликации живых данных.


**Файлы:**
- Создать: `server/services/branch-sync/journal.js`
- Создать: `server/services/branch-sync/journal.test.js`

- [ ] **Шаг 1: тест**

```js
// journal.test.js — BRANCH_RECORDS_V1: что уезжает соседу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent, pruneJournal } from './journal.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}

test('порция несёт ПОЛНУЮ строку, а не поля, которые менялись', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов', '+998901112233')").run();
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  const rec = batch.records.find(r => r.tbl === 'patients');
  assert.equal(rec.data.full_name, 'Иванов');
  assert.equal(rec.data.phone, '+998901112233');
  // Дельта по полям потребовала бы, чтобы у соседа СОВПАДАЛА история. У филиала,
  // включённого впервые, истории нет вовсе.
  db.close();
});

test('строка, изменённая много раз, уезжает ОДИН раз', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  for (let i = 0; i < 5; i++) db.prepare('UPDATE patients SET phone = ? WHERE id = ?').run('+9989' + i, id);
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  const forPatients = batch.records.filter(r => r.tbl === 'patients');
  assert.equal(forPatients.length, 1, 'уезжает состояние, а не история правок');
  db.close();
});

test('удалённая строка уезжает как удаление, без данных', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  const rec = batch.records.find(r => r.tbl === 'patients');
  assert.equal(rec.op, 'del');
  assert.equal(rec.data, undefined, 'данных удалённой строки у нас уже нет');
  db.close();
});

test('markSent сдвигает отметку, и следующая порция пуста', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  assert.equal(first.records.length > 0, true);
  markSent(db, 'C', first.upto, first.clock);
  const second = buildBatch(db, { self: 'B', peer: 'C' });
  assert.deepEqual(second.records, [], 'дважды одно и то же по узкому каналу не гоняем');
  db.close();
});

test('часы переживают перевод времени назад между двумя порциями', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const first = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', first.upto, first.clock);
  // Часы машины ушли назад (NTP). Новая правка обязана получить метку ВЫШЕ
  // отправленной, иначе приёмник её пропустит, а sent_seq уже ушёл вперёд.
  db.prepare("UPDATE patients SET phone = '+998900000000' WHERE full_name = 'Иванов'").run();
  const second = buildBatch(db, { self: 'B', peer: 'C', clock: () => 1 });
  const a = first.records[0].stamp, b = second.records[0].stamp;
  assert.equal(b > a, true, 'метка не откатилась вместе с часами: ' + a + ' -> ' + b);
  db.close();
});

test('холодному соседу уезжают строки, существовавшие ДО журнала', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Старожил')").run();
  db.prepare('DELETE FROM sync_journal').run();   // как на живой клинике после 083+084
  const batch = buildBatch(db, { self: 'B', peer: 'C' });
  assert.equal(batch.records.some((r) => r.tbl === 'patients' && r.data.full_name === 'Старожил'), true,
    'иначе «у соседа просто нет этого пациента» — неотличимо от поломки транспорта');
  markSent(db, 'C', batch.upto, batch.clock);
  assert.deepEqual(buildBatch(db, { self: 'B', peer: 'C' }).records, [], 'засев не повторяется');
  db.close();
});

test('отданный всем хвост журнала вычищается; заброшенный сосед чистку не держит', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', b.upto, b.clock);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0, 'единственный сосед всё получил');
  db.prepare("INSERT INTO patients (full_name) VALUES ('Петров')").run();
  // Второй сосед, не выходивший на связь 40 дней, не должен держать чистку.
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('D', 0, ?)")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());
  const b2 = buildBatch(db, { self: 'B', peer: 'C' });
  markSent(db, 'C', b2.upto, b2.clock);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n, 0);
  db.close();
});

test('заброшенный сосед по возвращении получает холодный засев, а не дыру', () => {
  const db = fresh(); warm(db);
  db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  const b1 = buildBatch(db, { self: 'B', peer: 'C' }); markSent(db, 'C', b1.upto, b1.clock);
  db.prepare("INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES ('D', 0, ?)")
    .run(new Date(Date.now() - 40 * 86400000).toISOString());
  db.prepare("INSERT INTO patients (full_name) VALUES ('Петров')").run();
  const b2 = buildBatch(db, { self: 'B', peer: 'C' }); markSent(db, 'C', b2.upto, b2.clock);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_peers WHERE node = 'D'").get().n, 0, 'молчун забыт');
  const names = buildBatch(db, { self: 'B', peer: 'D' }).records.filter(r => r.tbl === 'patients').map(r => r.data.full_name).sort();
  assert.deepEqual(names, ['Иванов', 'Петров'], 'вернувшийся получает ВСЁ, а не только то, что после его ухода');
  db.close();
});

test('деньги из visit_services не уезжают', () => {
  const db = fresh();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('И')").run().lastInsertRowid;
  const vid = db.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, '2026-09-02').lastInsertRowid;
  const sid = db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Анализ','S-9',1000,'lab',1)").run().lastInsertRowid;
  db.prepare('INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total) VALUES (?, ?, 1, 50000, 50000)').run(vid, sid);

  const rec = buildBatch(db, { self: 'B', peer: 'C' }).records.find(r => r.tbl === 'visit_services');
  assert.equal(rec.data.status !== undefined, true, 'статус нужен: на нём лабораторная очередь');
  assert.equal(rec.data.unit_price, undefined, 'цена — Фаза 3');
  assert.equal(rec.data.total, undefined, 'сумма — Фаза 3');
  db.close();
});
```

- [ ] **Шаг 2: прогнать — должно упасть**

Запустить: `node --test server/services/branch-sync/journal.test.js`
Ожидается: FAIL — «Cannot find module './journal.js'».

- [ ] **Шаг 3: реализация**

```js
// BRANCH_RECORDS_V1 — что именно уезжает соседу.
//
// ПЕРЕЧЕНЬ КОЛОНОК В КОДЕ, как у справочника (catalogue.js) и по той же
// причине: фильтр «уберём лишнее перед отправкой» забывают обновить, когда в
// таблицу добавляют колонку, а перечень — нет, потому что новая колонка просто
// не попадает в выгрузку, пока её сюда не впишут.
//
// Денежные поля visit_services (unit_price, total, invoice_item_id) НЕ
// перечислены намеренно: статус нужен лабораторной очереди, деньги — Фаза 3.
import { nextStamp } from './hlc.js';

export const SHIPPED = {
  patients: [
    'mrn', 'full_name', 'first_name', 'last_name', 'middle_name',
    'date_of_birth', 'gender', 'blood_type', 'phone', 'email', 'national_id',
    'address', 'nationality', 'occupation',
    'emergency_contact_name', 'emergency_contact_phone',
    'allergies', 'chronic_conditions', 'notes', 'active', 'registration_date',
  ],
  visits: [
    'visit_date', 'duration_minutes', 'visit_kind', 'visit_type', 'status', 'notes',
  ],
  visit_services: ['quantity', 'status'],
  lab_results: [
    'value', 'numeric_value', 'unit', 'reference_range', 'flag', 'notes',
    'entered_at', 'verified_at',
  ],
};

// Ссылки: колонка → таблица, на которую она смотрит. Уезжает uid родителя, а не
// его локальный id — id у соседа другой (см. миграцию 083).
export const REFS = {
  visits: { patient_id: 'patients' },
  visit_services: { visit_id: 'visits' },
  lab_results: { visit_service_id: 'visit_services' },
};

const TABLES = Object.keys(SHIPPED);

/**
 * Собрать порцию для узла: по одной записи на изменённую строку.
 *
 * @returns {{records: Array, upto: number}} upto — seq, до которого собрано
 */
/**
 * self — буква ЭТОЙ установки (идёт в метку и в origin); peer — буква узла,
 * КОМУ собираем (по нему читается sent_seq). Раньше оба смысла жили в одном
 * параметре `node`, и e2e-помощник помечал отправку под ключом, которого
 * buildBatch не читал (ревью Задачи 2). Два имени — две вещи.
 */
export function buildBatch(db, { self, peer, limit = 5000, clock: clockFn = Date.now } = {}) {
  const from = db.prepare('SELECT sent_seq FROM sync_peers WHERE node = ?').get(peer);
  const since = from ? from.sent_seq : 0;

  // Последняя запись про каждую строку: у пациента, правленного сто раз, есть
  // одно текущее состояние, а не сто.
  // ХОЛОДНЫЙ СОСЕД — строки в sync_peers ещё нет. «Холодный» значит «ни разу не
  // отдавали», а не sent_seq = 0: журнал мог быть пуст в момент засева, и по
  // нулю засев повторялся бы вечно. Журнал не засеян для строк, существовавших
  // до миграции 084 (ревью Задачи 3: на живой клинике после 083+084 журнал
  // ПУСТ), поэтому первую порцию собираем из самих таблиц — тот же приём, что
  // у справочника (catalogue.js). Дальше — только хвост журнала.
  const heads = from == null ? seedHeads(db, limit) : db.prepare(`
    SELECT tbl, uid, MAX(seq) AS seq, at
      FROM sync_journal
     WHERE seq > ?
     GROUP BY tbl, uid
     ORDER BY seq
     LIMIT ?
  `).all(since, limit);

  // ЧАСЫ ХРАНЯТСЯ, а не заводятся заново на каждую порцию. Иначе часы,
  // переведённые назад между двумя синхронизациями (обычная NTP-коррекция),
  // дали бы метку НИЖЕ уже отправленной — приёмник её пропустит, а sent_seq
  // уже ушёл вперёд: правка исчезает молча (ревью Задачи 2). Читаем один раз
  // на порцию, не на запись: 5000 записей — это не 5000 записей в WAL.
  let clock = readClock(db);
  const records = [];
  // Для холодного засева upto — текущий MAX(seq) журнала: всё, что накопилось
  // до засева, уже покрыто снимком таблиц и не должно уехать вторым разом.
  let upto = from == null
    ? (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_journal').get().m)
    : since;

  for (const h of heads) {
    upto = Math.max(upto, h.seq);
    if (!TABLES.includes(h.tbl)) continue;

    const row = db.prepare(`SELECT * FROM ${h.tbl} WHERE uid = ?`).get(h.uid);
    // Метка — от ВРЕМЕНИ ПРАВКИ (journal.at), не от времени отправки: иначе
    // правка в 10:00, отправленная в 10:15, побеждала бы настоящую правку соседа
    // в 10:05, и «последняя правка побеждает» значило бы «побеждает тот, кто
    // синхронизировался позже». Монотонный пол HLC при этом сохраняется: метка
    // никогда не упадёт ниже уже отправленной. `at` — секундной точности; внутри
    // секунды порядок отдачи, и это строго лучше, чем целый интервал синхронизации.
    clock = nextStamp(clock, self, h.at ? () => Date.parse(h.at) : clockFn);

    if (!row) {
      records.push({ tbl: h.tbl, uid: h.uid, op: 'del', stamp: clock.stamp });
      continue;
    }

    const data = {};
    for (const col of SHIPPED[h.tbl]) if (row[col] !== undefined) data[col] = row[col];

    // Родителей — по uid. Ссылка на строку, которой у соседа ещё нет, разрешится
    // при приёме (см. records.js): порядок прихода не гарантирован ничем.
    const refs = {};
    for (const [col, parent] of Object.entries(REFS[h.tbl] || {})) {
      const pid = row[col];
      if (pid == null) continue;
      const p = db.prepare(`SELECT uid FROM ${parent} WHERE id = ?`).get(pid);
      if (p) refs[col] = p.uid;
    }

    records.push({
      tbl: h.tbl, uid: h.uid, op: 'put', stamp: clock.stamp,
      data, refs, origin: self,
    });
  }
  return { records, upto, clock };
}

// Первая порция холодному соседу: все строки четырёх таблиц как «изменённые».
// seq = 0 у всех: настоящий журнал начнётся после этой порции. Порядок —
// родители раньше детей, чтобы приёмнику меньше держать в ожидании.
function seedHeads(db, limit) {
  const out = [];
  for (const tbl of TABLES) {
    for (const r of db.prepare(`SELECT uid, created_at AS at FROM ${tbl} WHERE uid IS NOT NULL ORDER BY id`).all()) {
      out.push({ tbl, uid: r.uid, seq: 0, at: r.at });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Хвост, отданный ВСЕМ соседям, больше не нужен: без чистки журнал растёт
// ~4.7 млн строк в год на клинике с 300 визитами в день, а сборка порции
// сканирует его целиком (ревью Задачи 3: 453 мс на «ничего нового»).
// Соседи без удачной отправки за STALE_DAYS не держат чистку: заброшенный или
// ещё не подключённый филиал иначе замораживал бы её навсегда — он всё равно
// получит холодный засев из таблиц. Защита местных правок (hasLocalUnshipped)
// от чистки не страдает: вычищенное отдано всем, и «false» — верный ответ.
// Сосед, молчавший дольше STALE_DAYS, ЗАБЫВАЕТСЯ: его строка удаляется, и по
// возвращении он получает холодный засев из таблиц. Просто исключить его из
// MIN было бы дырой навсегда: строка осталась бы, засев не сработал бы, а
// журнал ниже его sent_seq уже вычищен (повторное ревью Задачи 3).
const STALE_DAYS = 30;
export function pruneJournal(db, { now = () => new Date() } = {}) {
  const cutoff = new Date(now().getTime() - STALE_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM sync_peers WHERE last_ok IS NULL OR last_ok < ?').run(cutoff);
  const floor = db.prepare('SELECT MIN(sent_seq) AS m FROM sync_peers').get();
  if (!floor || floor.m == null || floor.m <= 0) return 0;
  return db.prepare('DELETE FROM sync_journal WHERE seq <= ?').run(floor.m).changes;
}

const CLOCK_KEY = 'sync_clock';

/** Последнее состояние часов из control_state. Строки → числа (TEXT-колонка). */
export function readClock(db) {
  const raw = db.prepare('SELECT value FROM control_state WHERE key = ?').get(CLOCK_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw.value);
    return { ms: Number(v.ms), cnt: Number(v.cnt) };
  } catch { return null; }
}

/** Записать часы — только если ушли вперёд. Вызывать после удачной отправки и
 *  после каждого приёма (приём двигает часы за чужую метку, см. Задачу 5). */
export function writeClock(db, clock) {
  if (!clock) return;
  const cur = readClock(db);
  if (cur && (cur.ms > clock.ms || (cur.ms === clock.ms && cur.cnt >= clock.cnt))) return;
  db.prepare(`INSERT INTO control_state (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(CLOCK_KEY, JSON.stringify({ ms: clock.ms, cnt: clock.cnt }));
}

/** Отметить, докуда соседу отдано, и сохранить часы. ТОЛЬКО после подтверждённой отправки. */
export function markSent(db, peer, upto, clock = null, { now = () => new Date() } = {}) {
  db.prepare(`
    INSERT INTO sync_peers (node, sent_seq, last_ok) VALUES (?, ?, ?)
    ON CONFLICT(node) DO UPDATE SET sent_seq = MAX(sent_seq, excluded.sent_seq), last_ok = excluded.last_ok
  `).run(peer, upto, now().toISOString());
  writeClock(db, clock);
  pruneJournal(db, { now });
}
```

- [ ] **Шаг 4: прогнать — должно пройти**

Запустить: `node --test server/services/branch-sync/journal.test.js`
Ожидается: 5 из 5 PASS.

- [ ] **Шаг 5: коммит**

```bash
git add server/services/branch-sync/journal.js server/services/branch-sync/journal.test.js
git commit -m "feat(sync): сборка порции изменений для соседнего филиала"
```

---

## Задача 5: приём порции

> **Правки по ревью (2026-09-02), обязательные для реализации:**
>
> 1. **Ссылки подчиняются поколоночному правилу.** `patient_id`, `visit_id`,
>    `visit_service_id`, `service_id` проверяются по `sync_seen` так же, как
>    данные; иначе воспроизведённая из ожидания СТАРАЯ запись перевешивала визит
>    на другого пациента (доказано пробой).
> 2. Прямое применение `(tbl, uid)` удаляет из `sync_pending` строку с меткой не
>    новее применённой: устаревший ожидающий не воспроизводится.
> 3. Предел `sync_pending` — в БАЙТАХ (`Buffer.byteLength`), не в code units.
> 4. Горизонт удержания `sync_seen` = `min(now, maxReceived) − 90 дн.`: буквальное
>    правило выселяло надгробия узла с часами 1970 года в той же транзакции, где
>    их писало. Чередующаяся порция от узла с нормальными часами всё же может
>    выселить такое надгробие — ограниченный, записанный остаток.
> 5. После того как чистка забыла соседа, `hasLocalUnshipped` для него = «защищено»
>    (нет строки — значит не отдавали). Консервативно и верно; после первого
>    `markSent` этому соседу защита снимается.
> 6. `visit_services.service_id` едет как `refs.service_code` (по коду услуги из
>    справочника); неизвестный код — ожидание с `waits_tbl = 'services'`,
>    освобождается, когда справочник привозит услугу.


**Файлы:**
- Создать: `server/services/branch-sync/records.js`
- Создать: `server/services/branch-sync/records.test.js`

**Схема, которую отвергает база (проверено ревью Задачи 1):** `visits.patient_id`,
`visit_services.visit_id`, `lab_results.visit_service_id` — `NOT NULL`, и
`foreign_keys = ON` (`server/db/connection.js:8`). Дочернюю строку, чей родитель
ещё не приехал, НЕЛЬЗЯ вставить с NULL-ссылкой. Поэтому:

**Правило приёма:** запись применяется только если ВСЕ её родители уже есть
локально. Иначе она целиком кладётся в таблицу ожидания `sync_pending` и
применяется, когда родитель приезжает — в этой же порции или в любой
следующей. Порядок прихода не гарантирован ничем, и сортировка порции
родителями вперёд его не спасает: родитель может приехать в следующей порции.

`visits.status` ограничен `CHECK (status IN ('scheduled','confirmed','arrived','cancelled','no_show'))`
(`003_visits.sql:11`) — в тестах использовать `'scheduled'`, не `'open'`.

Таблица ожидания `sync_pending` создаётся в `084_sync_journal.sql` (Задача 3) —
одна миграция пишется один раз.

**Поколоночно — значит поколоночно (ревью Задачи 2).** Первый набросок держал
ОДНУ метку на строку (`sync_seen(tbl, uid)`) и отбрасывал целиком запись со
старой меткой. Это не «последняя правка побеждает по колонкам», а «по строкам»:
телефон, исправленный в B, и адрес, исправленный в C, — и весь адрес пропадает,
если метка B старше. Спецификация обещает поколоночное слияние, и она права.
Поэтому:

- `sync_seen` — по КОЛОНКЕ: `(tbl, uid, col, stamp)`. Приехавшая запись
  применяет каждую свою колонку независимо: только если её метка новее метки,
  под которой эта колонка менялась в последний раз.
- **Местная неотправленная правка защищает свои колонки.** У местной правки
  метки нет — она появится при отправке. Пока она не отправлена, её колонки
  считаются НОВЕЕ любой приехавшей: `sync_journal` знает, что строка менялась
  (seq > sent_seq хотя бы для одного соседа). Без этого запись с меткой 10:00,
  приехавшая в 10:06, стёрла бы местную правку 10:05. Какие именно колонки
  менялись местно, журнал не знает — защищаются ВСЕ колонки строки до
  отправки; это грубее, но теряет ноль правок, а точность придёт с отправкой.
- **Приём двигает часы.** После применения порции `writeClock` с меткой
  `nextStamp(readClock(db), self, Date.now, maxReceivedStamp)`: узел с отставшими
  часами перестаёт проигрывать вечно (ревью Задачи 2).
- **Метка проверяется на входе.** `isStamp(rec.stamp)` из `hlc.js`; запись без
  метки — `skipped`, а не падение всей транзакции на NOT NULL в `sync_seen`.

- [ ] **Шаг 1: тест**

```js
// records.test.js — BRANCH_RECORDS_V1: приём чужих изменений.
//
// Здесь живут все решения, которые нельзя переиграть после того, как данные
// разъехались: что побеждает при конфликте, что делать со ссылкой на строку,
// которая ещё не приехала, и почему удаление проигрывает более поздней правке.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { applyBatch } from './records.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}

test('новый пациент приезжает и заводится под СВОИМ локальным id', () => {
  const db = fresh();
  db.prepare("INSERT INTO patients (full_name) VALUES ('Местный')").run();   // занимаем id=1

  applyBatch(db, [{
    tbl: 'patients', uid: 'aaaa', op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Приезжий', phone: '+998900000001' }, refs: {}, origin: 'C',
  }], { self: 'B' });

  const row = db.prepare("SELECT id, full_name FROM patients WHERE uid = 'aaaa'").get();
  assert.equal(row.full_name, 'Приезжий');
  assert.notEqual(row.id, 1, 'локальные id не переносятся: они уже заняты');
  db.close();
});

test('поколоночное слияние: телефон здесь, адрес там — выживают оба', () => {
  const db = fresh();
  applyBatch(db, [{
    tbl: 'patients', uid: 'bbbb', op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Иванов', phone: '+998900000001', address: '' }, refs: {}, origin: 'C',
  }], { self: 'B' });
  // Здесь правят адрес — позже.
  db.prepare("UPDATE patients SET address = 'Ташкент' WHERE uid = 'bbbb'").run();
  // Оттуда приезжает правка телефона с БОЛЕЕ ПОЗДНЕЙ меткой, но старым адресом.
  applyBatch(db, [{
    tbl: 'patients', uid: 'bbbb', op: 'put', stamp: '000000000009-0000-C',
    data: { phone: '+998900000002' }, refs: {}, origin: 'C',
  }], { self: 'B' });

  const row = db.prepare("SELECT phone, address FROM patients WHERE uid = 'bbbb'").get();
  assert.equal(row.phone, '+998900000002', 'приехавшая правка применилась');
  assert.equal(row.address, 'Ташкент', 'и не стёрла то, чего в ней не было');
  db.close();
});

test('приехавшая СТАРАЯ запись не стирает местную неотправленную правку', () => {
  const db = fresh();
  applyBatch(db, [{
    tbl: 'patients', uid: 'eeee', op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Иванов', phone: '+998900000001' }, refs: {}, origin: 'C',
  }], { self: 'B' });
  // Здесь поправили телефон и ещё никому не отправили.
  db.prepare("UPDATE patients SET phone = '+998900000009' WHERE uid = 'eeee'").run();
  // Оттуда приезжает полная строка с более НОВОЙ меткой, но старым телефоном
  // (её собрали до того, как узнали о нашей правке).
  applyBatch(db, [{
    tbl: 'patients', uid: 'eeee', op: 'put', stamp: '000000000005-0000-C',
    data: { full_name: 'Иванов', phone: '+998900000001' }, refs: {}, origin: 'C',
  }], { self: 'B' });
  assert.equal(db.prepare("SELECT phone FROM patients WHERE uid = 'eeee'").get().phone, '+998900000009',
    'неотправленная местная правка новее любой приехавшей');
  db.close();
});

test('ссылка на ещё не приехавшего родителя не теряется', () => {
  const db = fresh();
  // Визит приезжает ПЕРЕД пациентом: порядок прихода не гарантирован ничем.
  applyBatch(db, [{
    tbl: 'visits', uid: 'v1', op: 'put', stamp: '000000000001-0000-C',
    data: { visit_date: '2026-09-02', status: 'scheduled' },
    refs: { patient_id: 'p1' }, origin: 'C',
  }], { self: 'B' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM visits WHERE uid = 'v1'").get().n, 0,
    'visits.patient_id NOT NULL: ребёнка без родителя вставить нельзя — он ждёт');
  assert.equal(db.prepare("SELECT waits_uid FROM sync_pending WHERE uid = 'v1'").get().waits_uid, 'p1');

  applyBatch(db, [{
    tbl: 'patients', uid: 'p1', op: 'put', stamp: '000000000002-0000-C',
    data: { full_name: 'Опоздавший' }, refs: {}, origin: 'C',
  }], { self: 'B' });
  const v = db.prepare("SELECT patient_id FROM visits WHERE uid = 'v1'").get();
  const p = db.prepare("SELECT id FROM patients WHERE uid = 'p1'").get();
  assert.equal(v.patient_id, p.id, 'ребёнок применился, когда родитель приехал');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_pending").get().n, 0, 'и вышел из ожидания');
  db.close();
});

test('удаление проигрывает более поздней правке', () => {
  const db = fresh();
  applyBatch(db, [{
    tbl: 'patients', uid: 'cccc', op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Иванов' }, refs: {}, origin: 'C',
  }], { self: 'B' });
  db.prepare("UPDATE patients SET full_name = 'Иванов-Петров' WHERE uid = 'cccc'").run();

  // Удаление СТАРЕЕ нашей правки: кто-то удалил строку, не зная о ней.
  applyBatch(db, [{ tbl: 'patients', uid: 'cccc', op: 'del', stamp: '000000000000-0000-C', origin: 'C' }], { self: 'B' });

  const row = db.prepare("SELECT full_name FROM patients WHERE uid = 'cccc'").get();
  assert.ok(row, 'молча уничтожать запись, с которой кто-то работал, нельзя');
  assert.equal(row.full_name, 'Иванов-Петров');
  db.close();
});

test('запоздавший put не воскрешает удалённую строку', () => {
  const db = fresh();
  applyBatch(db, [{ tbl: 'patients', uid: 'tttt', op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Иванов' }, refs: {}, origin: 'C' }], { self: 'B' });
  applyBatch(db, [{ tbl: 'patients', uid: 'tttt', op: 'del', stamp: '000000000009-0000-C', origin: 'C' }], { self: 'B' });
  // Порция, собранная ДО удаления, приехала после него.
  applyBatch(db, [{ tbl: 'patients', uid: 'tttt', op: 'put', stamp: '000000000005-0000-C',
    data: { full_name: 'Иванов' }, refs: {}, origin: 'C' }], { self: 'B' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM patients WHERE uid = 'tttt'").get().n, 0,
    'отправитель удаление не повторит — воскрешение было бы навсегда');
  db.close();
});

test('своё же изменение, вернувшееся обратно, ничего не портит', () => {
  const db = fresh();
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const uid = db.prepare('SELECT uid FROM patients WHERE id = ?').get(id).uid;
  const before = db.prepare('SELECT COUNT(*) n FROM patients').get().n;

  applyBatch(db, [{
    tbl: 'patients', uid, op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Иванов' }, refs: {}, origin: 'C',
  }], { self: 'B' });

  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, before, 'дубля не появилось');
  db.close();
});

test('приём НЕ пишет в журнал: иначе изменения ходили бы по кругу вечно', () => {
  const db = fresh();
  applyBatch(db, [{
    tbl: 'patients', uid: 'dddd', op: 'put', stamp: '000000000001-0000-C',
    data: { full_name: 'Приезжий' }, refs: {}, origin: 'C',
  }], { self: 'B' });
  const n = db.prepare("SELECT COUNT(*) n FROM sync_journal WHERE uid = 'dddd'").get().n;
  assert.equal(n, 0, 'принятое не пересылаем обратно');
  db.close();
});
```

- [ ] **Шаг 2: прогнать — должно упасть**

Запустить: `node --test server/services/branch-sync/records.test.js`
Ожидается: FAIL — «Cannot find module './records.js'».

- [ ] **Шаг 3: реализация**

```js
// BRANCH_RECORDS_V1 — приём чужих изменений.
//
// ТРИ ПРАВИЛА, каждое из которых нельзя переиграть после того, как данные
// разъехались:
//
//   1. Строки приезжают по СВОИМ локальным id (uid → id через таблицу).
//      Перенести чужой id значило бы перевесить местные счета и смены кассы на
//      чужие строки — разбор этого есть в миграции 079.
//   2. Слияние ПОКОЛОНОЧНОЕ: приехавшая запись меняет только те колонки, что в
//      ней есть. Телефон, исправленный здесь, и адрес, исправленный там,
//      обязаны выжить оба.
//   3. Удаление проигрывает более поздней правке. Молча уничтожить запись, с
//      которой кто-то ещё работал, — единственная невосстановимая ошибка в
//      этом файле.
import { compareStamps, isStamp, nextStamp } from './hlc.js';
import { readClock, writeClock } from './journal.js';
import { SHIPPED, REFS } from './journal.js';

// sync_seen (миграция 084): метка последнего ПРИНЯТОГО изменения каждой
// колонки. Местная правка метки не имеет — до отправки её защищает журнал.
const SEEN = 'sync_seen';
// Приехавшая запись больше этого — не хранится в ожидании, а пропускается:
// предел релея (12 МБ сжатых) ничего не говорит о размере ОДНОЙ строки.
const MAX_PENDING_BYTES = 256 * 1024;
const PENDING_MAX_DAYS = 30;
// sync_seen растёт быстрее журнала: ~190 строк на принятый визит с панелью
// (повторное ревью Задачи 3: ~17 млн строк, 1.4 ГБ в год у принимающего
// филиала). Метка старше SEEN_DAYS не нужна: порции — минутной давности, а
// холодный засев несёт СВЕЖИЕ метки (пол HLC), не created_at. Надгробия '*'
// живут столько же: запоздавший put старше 90 дней — не сценарий.
const SEEN_DAYS = 90;


function localId(db, tbl, uid) {
  const r = db.prepare(`SELECT id FROM ${tbl} WHERE uid = ?`).get(uid);
  return r ? r.id : null;
}

/**
 * Применить порцию. Всё в ОДНОЙ транзакции: половина приехавшей истории хуже,
 * чем ничего — в ней визиты без пациентов.
 *
 * ЖУРНАЛ ПРИ ЭТОМ НЕ ПИШЕТСЯ (триггеры временно отключить нельзя, поэтому
 * записи, порождённые приёмом, удаляются в конце транзакции). Иначе принятое
 * изменение уехало бы обратно, вернулось снова и ходило бы по кругу вечно.
 *
 * @returns {{applied:number, skipped:number, deferred:number, deleted:number}}
 */
export function applyBatch(db, records, { self } = {}) {
  if (!self) throw new Error('applyBatch: self letter required');
  const stats = { applied: 0, skipped: 0, deferred: 0, deleted: 0 };

  let maxReceived = '';
  const run = db.transaction((batch) => {
    const mark = db.prepare('SELECT MAX(seq) AS s FROM sync_journal').get();
    const journalFrom = mark && mark.s ? mark.s : 0;

    for (const rec of batch) {
      if (!rec || !SHIPPED[rec.tbl] || typeof rec.uid !== 'string' || !isStamp(rec.stamp)) { stats.skipped++; continue; }
      // Часы двигаются за ЛЮБОЙ годной приехавшей меткой — и за удалением, и за
      // отложенной в ожидание, и за пропущенной: иначе узел с отставшими часами,
      // получивший детей раньше родителей, ничему не учится и продолжает проигрывать.
      if (rec.stamp > maxReceived) maxReceived = rec.stamp;

      const id = localId(db, rec.tbl, rec.uid);
      const protectedHere = id != null && hasLocalUnshipped(db, rec.tbl, rec.uid, rec.origin);

      if (rec.op === 'del') {
        // Правило 3. Удаление проигрывает любой более поздней правке — местной
        // неотправленной или приехавшей с более новой меткой по любой колонке.
        const newerCol = db.prepare(`SELECT 1 FROM ${SEEN} WHERE tbl = ? AND uid = ? AND stamp > ? LIMIT 1`)
          .get(rec.tbl, rec.uid, rec.stamp);
        if (protectedHere || newerCol) { stats.skipped++; continue; }
        if (id != null) { db.prepare(`DELETE FROM ${rec.tbl} WHERE id = ?`).run(id); stats.deleted++; }
        db.prepare(`DELETE FROM ${SEEN} WHERE tbl = ? AND uid = ?`).run(rec.tbl, rec.uid);
        db.prepare(`INSERT INTO ${SEEN} (tbl, uid, col, stamp) VALUES (?,?,'*',?)`).run(rec.tbl, rec.uid, rec.stamp);
        continue;
      }

      const cols = [];
      const vals = [];
      // Надгробие: строка удалена с меткой '*'. put, который старше надгробия,
      // не воскрешает её — иначе запоздавший put после удаления оживлял бы
      // строку у приёмника навсегда (отправитель удаление не повторяет).
      const tomb = db.prepare(`SELECT stamp FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = '*'`).get(rec.tbl, rec.uid);
      if (tomb && compareStamps(rec.stamp, tomb.stamp) <= 0) { stats.skipped++; continue; }
      if (tomb) db.prepare(`DELETE FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = '*'`).run(rec.tbl, rec.uid);
      const seenCol = db.prepare(`SELECT stamp FROM ${SEEN} WHERE tbl = ? AND uid = ? AND col = ?`);
      for (const col of SHIPPED[rec.tbl]) {
        if (!rec.data || !Object.prototype.hasOwnProperty.call(rec.data, col)) continue;
        if (protectedHere) continue;                       // местная правка ещё не уехала — не трогаем
        const prev = seenCol.get(rec.tbl, rec.uid, col);
        if (prev && compareStamps(rec.stamp, prev.stamp) <= 0) continue;   // эта колонка новее у нас
        cols.push(col); vals.push(rec.data[col]);
      }
      // Новая строка: у неё ничего не защищено и ничего не видено — все колонки едут.
      // Ссылки: uid родителя → его местный id. Родителя ещё нет — запись
      // ЦЕЛИКОМ уходит в ожидание: NOT NULL и внешние ключи не дадут вставить
      // ребёнка с пустой ссылкой, и это правильно.
      // sync_pending хранит ОДНОГО ожидаемого родителя, и break ниже — на
      // первом отсутствующем. Сегодня у каждой таблицы в REFS ровно одна
      // ссылка, поэтому этого достаточно; вторая ссылка потребует ждать обоих.
      let waiting = null;
      for (const [col, parent] of Object.entries(REFS[rec.tbl] || {})) {
        const parentUid = rec.refs ? rec.refs[col] : null;
        if (!parentUid) continue;
        const pid = localId(db, parent, parentUid);
        if (pid == null) { waiting = { tbl: parent, uid: parentUid }; break; }
        cols.push(col); vals.push(pid);
      }
      if (waiting) {
        const json = JSON.stringify(rec);
        if (json.length > MAX_PENDING_BYTES) { stats.skipped++; continue; }
        db.prepare(`INSERT INTO sync_pending (tbl, uid, stamp, record, waits_tbl, waits_uid)
                    VALUES (?,?,?,?,?,?)
                    ON CONFLICT(tbl, uid) DO UPDATE SET stamp = excluded.stamp, record = excluded.record,
                      waits_tbl = excluded.waits_tbl, waits_uid = excluded.waits_uid`)
          .run(rec.tbl, rec.uid, rec.stamp, json, waiting.tbl, waiting.uid);
        stats.deferred++;   // не «пропущено» — ждёт родителя; читающему лог это две разные новости
        continue;
      }

      if (id == null) {
        db.prepare(
          `INSERT INTO ${rec.tbl} (uid${cols.length ? ', ' + cols.join(', ') : ''})
           VALUES (?${cols.map(() => ', ?').join('')})`
        ).run(rec.uid, ...vals);
      } else if (cols.length) {
        db.prepare(`UPDATE ${rec.tbl} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`)
          .run(...vals, id);
      }
      const remember = db.prepare(`INSERT INTO ${SEEN} (tbl, uid, col, stamp) VALUES (?,?,?,?)
                  ON CONFLICT(tbl, uid, col) DO UPDATE SET stamp = excluded.stamp`);
      for (const col of cols) remember.run(rec.tbl, rec.uid, col, rec.stamp);
      if (cols.length || id == null) stats.applied++; else stats.skipped++;
    }

    releasePending(db, batch, stats);
    // Ребёнок, чей родитель удалён у источника, ждал бы вечно.
    db.prepare(`DELETE FROM sync_pending WHERE received_at < ?`)
      .run(new Date(Date.now() - PENDING_MAX_DAYS * 86400000).toISOString());
    // Метки, старше которых ничего не приедет. Сравнение строковое: метка —
    // hex миллисекунд фиксированной ширины (hlc.js), и «старше даты» — это
    // «меньше метки этой даты».
    const seenCutoff = (Date.now() - SEEN_DAYS * 86400000).toString(16).padStart(12, '0');
    db.prepare(`DELETE FROM ${SEEN} WHERE stamp < ?`).run(seenCutoff);

    // Приём не порождает исходящих изменений — см. заголовок.
    db.prepare('DELETE FROM sync_journal WHERE seq > ?').run(journalFrom);

    // Часы этой машины двигаются за самую новую чужую метку: узел с отставшими
    // часами иначе проигрывал бы каждое слияние вечно.
    if (maxReceived) writeClock(db, nextStamp(readClock(db), self, Date.now, maxReceived));
  });

  run(records);
  return stats;
}

// Строка менялась здесь и ещё не уехала ни одному соседу? Тогда её колонки
// новее любой приехавшей записи. Какие именно колонки — журнал не знает,
// поэтому защищаются все: грубее, но теряет ноль правок.
// ПО СОСЕДУ, от которого пришла порция (origin записи), а не MIN по всем:
// с тремя филиалами заброшенный D держал бы MIN(sent_seq) внизу вечно, и
// каждая строка, которую здесь хоть раз правили, отвергала бы ВСЕ слияния,
// пока D не выйдет на связь (ревью Задачи 2).
function hasLocalUnshipped(db, tbl, uid, peer) {
  const last = db.prepare('SELECT MAX(seq) AS s FROM sync_journal WHERE tbl = ? AND uid = ?').get(tbl, uid);
  if (!last || !last.s) return false;
  const sent = db.prepare('SELECT sent_seq FROM sync_peers WHERE node = ?').get(peer);
  return !sent || last.s > sent.sent_seq;
}

// Применить тех, кто ждал ИМЕННО этих родителей. Точечно, по (waits_tbl,
// waits_uid): связать всех висящих детей с первым попавшимся родителем было бы
// не «не связать», а перепутать — хуже. Освобождённый ребёнок сам может быть
// родителем (визит → услуга → результат), поэтому цикл до неподвижной точки.
function releasePending(db, batch, stats) {
  // Стартуем со ВСЕХ put порции, включая те, что сами ушли в ожидание: такой
  // ребёнок просто переждёт ещё раз, а next растёт только на настоящем
  // применении, поэтому цикл конечен. Чуть расточительно, зато без второго
  // списка «кто применился».
  let arrived = batch.filter((r) => r && r.op === 'put').map((r) => ({ tbl: r.tbl, uid: r.uid }));
  while (arrived.length) {
    const next = [];
    for (const parent of arrived) {
      const rows = db.prepare('SELECT record FROM sync_pending WHERE waits_tbl = ? AND waits_uid = ?')
        .all(parent.tbl, parent.uid);
      for (const row of rows) {
        const rec = JSON.parse(row.record);
        db.prepare('DELETE FROM sync_pending WHERE tbl = ? AND uid = ?').run(rec.tbl, rec.uid);
        const before = stats.applied;
        applyOne(db, rec, stats);            // та же логика, что в основном цикле
        if (stats.applied > before) next.push({ tbl: rec.tbl, uid: rec.uid });
      }
    }
    arrived = next;
  }
}
```

> **Для исполнителя:** тело основного цикла вынести в `applyOne(db, rec, stats)`,
> чтобы `releasePending` применяло ожидавшие записи тем же кодом. В `applyOne`
> запись, чей родитель по-прежнему отсутствует, снова уходит в `sync_pending`.

- [ ] **Шаг 4: тест на двух детей — обязателен**

```js
test('двое детей ждут разных родителей и получают именно своих', () => {
  const db = fresh();
  applyBatch(db, [
    { tbl: 'visits', uid: 'vA', op: 'put', stamp: '000000000001-0000-C',
      data: { visit_date: '2026-09-01' }, refs: { patient_id: 'pA' }, origin: 'C' },
    { tbl: 'visits', uid: 'vB', op: 'put', stamp: '000000000002-0000-C',
      data: { visit_date: '2026-09-02' }, refs: { patient_id: 'pB' }, origin: 'C' },
  ]);
  applyBatch(db, [
    { tbl: 'patients', uid: 'pA', op: 'put', stamp: '000000000003-0000-C',
      data: { full_name: 'А' }, refs: {}, origin: 'C' },
    { tbl: 'patients', uid: 'pB', op: 'put', stamp: '000000000004-0000-C',
      data: { full_name: 'Б' }, refs: {}, origin: 'C' },
  ]);
  const pa = db.prepare("SELECT id FROM patients WHERE uid = 'pA'").get().id;
  const pb = db.prepare("SELECT id FROM patients WHERE uid = 'pB'").get().id;
  assert.equal(db.prepare("SELECT patient_id FROM visits WHERE uid = 'vA'").get().patient_id, pa);
  assert.equal(db.prepare("SELECT patient_id FROM visits WHERE uid = 'vB'").get().patient_id, pb,
    'перепутать родителей хуже, чем не связать вовсе');
  db.close();
});
```

- [ ] **Шаг 5: прогнать — должно пройти**

Запустить: `node --test server/services/branch-sync/records.test.js`
Ожидается: 7 из 7 PASS.

- [ ] **Шаг 6: коммит**

```bash
git add server/services/branch-sync/records.js server/services/branch-sync/records.test.js
git commit -m "feat(sync): приём чужих записей — слияние поколоночное, удаление проигрывает правке"
```

---

## Задача 5b: журнал знает, какие колонки менялись

**Почему это отдельная задача и почему она обязательна.** Ревью качества Задачи 5
воспроизвело двумя базами и помощником `exchange` из Задачи 7: B правит телефон,
C — адрес, оба не отправлены. B→C: C защищает СВОЮ неотправленную строку и
ОТБРАСЫВАЕТ запись B целиком; `markSent` у B уходит вперёд — правка телефона
больше не поедет никогда. C→B: снимок C несёт устаревший телефон под более новой
меткой — телефон у B затёрт. Обе стороны «сошлись» на значении, которого никто не
вводил. Утверждение Задачи 7 `inB.phone === '+998901112233'` падает.

Корень: `buildBatch` отправляет ПОЛНЫЙ снимок строки под ОДНОЙ меткой, а
`applyOne` записывает эту метку в `sync_seen` для КАЖДОЙ колонки — отправитель
присваивает себе авторство колонок, которых не трогал. «Поколоночное» слияние
поверх построчных снимков — построчное слияние в костюме.

**Решение — три согласованные правки:**

1. **Журнал (084):** `cols TEXT NOT NULL DEFAULT '*'`. `*_journal_ins` пишет `'*'`;
   `*_journal_upd` — список ТЕХ колонок, что изменились (CASE WHEN NEW.x IS NOT
   OLD.x THEN 'x,' … по SHIPPED-колонкам и ссылкам таблицы); UPDATE, не тронувший
   ни одной отправляемой колонки (например, только `updated_at`), журнал НЕ пишет.
2. **Отправитель (`journal.js`):** запись несёт `changed: string[]` — объединение
   `cols` по журналу строки с прошлой отправки (`'*'` для вставок и засева). `data`
   по-прежнему полная строка (новой строке у соседа нужны все значения). Метка —
   одна на запись; все колонки, изменённые в одной порции, получают метку последней
   правки строки — приближение, записанное в коде.
3. **Приёмник (`records.js`):** для существующей строки применяются ТОЛЬКО колонки из
   `changed`, каждая по своему `sync_seen`; остальные — снимок, а не авторство.
   `hasLocalUnshipped` возвращает МНОЖЕСТВО местных неотправленных колонок (по
   соседу-источнику) — приёмник пропускает именно их и применяет остальные;
   запись целиком больше не отбрасывается. Сходимость: B→C применяет телефон,
   защищает адрес; C→B — наоборот; обе стороны: телефон B, адрес C.

**Также в этой задаче (Important из того же ревью):**
- **Изоляция записи** — `SAVEPOINT` на каждую: одна негодная строка (CHECK на
  `visits.status` с новой версии, UNIQUE по `mrn` при двух импортах одного
  легаси-списка, boolean в JSON) роняла ВСЮ порцию, а порция повторно не
  отправляется — молчаливая потеря всего в ней. Проверка типов значений на входе.
- `origin` приходит от соседа и управляет защитой: `applyBatch(db, records, {self,
  peer})` — при заданном `peer` запись с чужим `origin` пропускается.
- `self` проверяется по форме буквы ДО транзакции (сейчас — в конце, откатывая
  применённую порцию из-за ошибки конфигурации).
- Возврат: `{applied, released, skipped, protected, deferred, deleted}`; `deferred` —
  сколько ЖДЁТ в конце транзакции, а не сколько раз откладывали.
- Чистка `sync_seen` — только когда горизонт сдвинулся (сейчас — полный скан
  неиндексированной колонки на каждой порции).

**Тест, без которого задача не закрыта:** два узла, правки разных колонок одной
строки в разрыве связи, обмен в обе стороны, обе базы = {телефон B, адрес C}.

---

## Задача 6: адрес блоба для УЗЛА

**Файлы:**
- Изменить: `server/services/branch-sync/relay-crypto.js`
- Изменить: `server/services/branch-sync/relay-crypto.test.js`

- [ ] **Шаг 1: тест**

```js
test('у каждого узла свой адрес блоба, и он выводится из ключа группы', () => {
  const key = 'k'.repeat(43);
  const b = relayIdFor(key, 'B');
  const c = relayIdFor(key, 'C');
  assert.match(b, /^[0-9a-f]{32}$/);
  assert.notEqual(b, c, 'иначе филиалы затирали бы журналы друг друга');
  assert.equal(relayIdFor(key, 'B'), b, 'адрес постоянен: его не с кем согласовывать');
});

test('без узла адрес прежний — справочник лежит там же, где лежал', () => {
  const key = 'k'.repeat(43);
  assert.equal(relayIdFor(key).length, 32);
  assert.notEqual(relayIdFor(key), relayIdFor(key, 'B'));
});
```

- [ ] **Шаг 2: прогнать — должно упасть**

Запустить: `node --test server/services/branch-sync/relay-crypto.test.js`
Ожидается: FAIL — адреса совпадают (второй аргумент игнорируется).

- [ ] **Шаг 3: реализация**

```js
// BRANCH_RECORDS_V1 — адрес блоба ДЛЯ УЗЛА.
//
// У справочника адрес один на группу: пишет его только главная клиника.
// Журналы пишут все, и общий адрес означал бы, что филиалы затирают выгрузки
// друг друга. Адрес по-прежнему выводится из ключа группы, поэтому его не надо
// нигде согласовывать: каждый узел вычисляет и свой, и чужие.
export function relayIdFor(key, node) {
  const k = decodeGroupKey(key);
  if (!k) return null;
  const info = node ? RELAY_ID_INFO + ':' + String(node).toUpperCase() : RELAY_ID_INFO;
  return createHmac('sha256', k).update(info).digest('hex').slice(0, RELAY_ID_CHARS);
}
```

- [ ] **Шаг 4: прогнать — должно пройти**

Запустить: `node --test server/services/branch-sync/relay-crypto.test.js`
Ожидается: все PASS, включая прежние (адрес без узла не изменился).

- [ ] **Шаг 5: коммит**

```bash
git add server/services/branch-sync/relay-crypto.js server/services/branch-sync/relay-crypto.test.js
git commit -m "feat(sync): у каждого филиала свой адрес блоба для журнала"
```

---

## Задача 7a: релей-токен на несколько адресов (control plane)

**Блокирует Задачу 7.** Ревью Задачи 6 прочитало сервер: токен релея привязан к
ОДНОМУ `relay_id` — `control-plane/server/routes/relay-token.js` (`WHERE t.token = ?
AND t.relay_id = ?`), схема `006_relay_tokens.sql` (одна строка — один адрес). Клиент
минтит токен только для адреса справочника (`relay.js`, `relayIdFor(group_key)`), и
ключ подключения несёт один токен. Главная клиника ходит по `install_token` (не
привязан к адресу) — её выгрузка журнала пройдёт, а КАЖДЫЙ вторичный филиал получит
401 → `relay_branch_revoked` → «возьмите новый ключ у главной» — неверный совет на
ошибку кода. Тест на одной машине этого не покажет.

Плюс предел `MAX_LIVE_TOKENS_PER_CLINIC = 64` считается на клинику по всем адресам:
токен на адрес даёт ≈ N² токенов на сеть (63 при 8 узлах, 409 при 9).

**Решение:** расширить область токена на сервере. Токен принадлежит ФИЛИАЛУ, а
не адресу: таблица `relay_token_scopes(token, relay_id)` (или колонка-список), и
проверка `WHERE t.token = ? AND EXISTS (scope for relay_id)`. При выдаче главная
клиника перечисляет адреса, которые филиал будет трогать: справочник, свой узел,
узлы всех соседей — все выводятся из ключа группы. Отзыв — по-прежнему на филиал.

**Файлы:** `control-plane/server/db/migrations/008_relay_token_scopes.sql`,
`control-plane/server/routes/relay-token.js`, `control-plane/server/routes/relay.js`,
`server/services/branch-sync/relay.js` (mint с перечнем адресов), тесты обеих сторон.
**Проверка:** e2e с ДВУМЯ вторичными филиалами, где выгружает вторичный, не главный.

**Область — весь алфавит сразу (ревью 7a):** токен филиала выдаётся на
`справочник + A..Z` (27 из 64): филиал, заведённый позже, иначе оставался бы
невидимым для выданных раньше токенов, а «новый ключ» этого не чинил —
`branchKeyFor` собирает ключ из СОХРАНЁННОГО токена. `MAX_SCOPE` на обеих
сторонах — под тестом дрейфа.

**Порядок выката:** сначала control plane, потом клиники. Новый клиент против
старого сервера получает токен только на справочник (старый маршрут читает
`relay_id` и не знает `relay_ids`), и ничто это не заметит. Резервная копия
реестра — через `db.backup()` (WAL), не `cp`.

**Развёртывание:** control plane обновляется по SSH (см. `docs/HANDOVER.md`,
`/opt/easymed-cp`, `systemctl restart easymed-cp`), резервная копия реестра перед
миграцией — как 2026-09-02.

**Также на сервере:** удержание блобов (`relay.js:141-157`) сметает непрочитанные
>30 дней; при N блобах на группу и выгрузке раз в час нужен keep-alive и индекс
по выражению (или колонка `touched_at`); абзац о том, что видит вендор
(`control-plane/server/routes/relay.js:28-30`), устарел — теперь видно число
филиалов и ритм их журналов. Фильтровать соседей `letter IS NOT NULL AND letter <> ''`
перед `relayIdFor`; проверять форму приехавшего журнала, как `fetchCatalogue`.

---

## Задача 7: обмен по релею

**Файлы:**
- Изменить: `server/services/branch-sync/relay.js`
- Изменить: `server/services/rpc/branch-sync.js`
- Создать: `server/services/branch-sync/records-e2e.test.js`

- [ ] **Шаг 1: сквозной тест на двух базах**

```js
// records-e2e.test.js — BRANCH_RECORDS_V1: две базы сходятся.
//
// Главный инвариант всей фазы, и проверять его надо именно так: две базы,
// правки в обеих «в разрыве связи», обмен, обе обязаны прийти к одному
// состоянию. Всё остальное — детали реализации.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildBatch, markSent } from './journal.js';
import { applyBatch } from './records.js';

function node() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('DELETE FROM sync_journal').run();
  return db;
}
// self = буква отправителя, peer = буква получателя. Обе стороны реальные:
// первый набросок помечал отправку под литералом 'peer', которого buildBatch
// не читал (ревью Задачи 2).
const exchange = (from, to, self, peer) => {
  const b = buildBatch(from, { self, peer });
  applyBatch(to, b.records, { self: peer });
  markSent(from, peer, b.upto, b.clock);
};

test('пациент, заведённый в B, виден в C', () => {
  const B = node(); const C = node();
  B.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов', '+998901112233')").run();
  exchange(B, C, 'B', 'C');
  const p = C.prepare("SELECT full_name, phone FROM patients WHERE full_name = 'Иванов'").get();
  assert.equal(p.phone, '+998901112233');
  B.close(); C.close();
});

test('лабораторная очередь: услуга и результат доезжают вместе с визитом', () => {
  const B = node(); const C = node();
  const pid = B.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  const vid = B.prepare('INSERT INTO visits (patient_id, visit_date) VALUES (?, ?)').run(pid, '2026-09-02').lastInsertRowid;
  const sid = B.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('ОАК','S-1',1000,'lab',1)").run().lastInsertRowid;
  const vsid = B.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, status) VALUES (?,?,1,'ordered')").run(vid, sid).lastInsertRowid;
  B.prepare("INSERT INTO lab_results (visit_service_id, value) VALUES (?, '5.2')").run(vsid);

  exchange(B, C, 'B', 'C');

  const q = C.prepare(`
    SELECT vs.status, lr.value FROM visit_services vs
      JOIN lab_results lr ON lr.visit_service_id = vs.id
  `).get();
  assert.equal(q.status, 'ordered', 'очередь строится на статусе');
  assert.equal(q.value, '5.2');
  B.close(); C.close();
});

test('обе базы сходятся после правок в разрыве связи', () => {
  const B = node(); const C = node();
  B.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  exchange(B, C, 'B', 'C');

  // Связи нет. Каждый правит своё поле.
  B.prepare("UPDATE patients SET phone = '+998901112233' WHERE full_name = 'Иванов'").run();
  C.prepare("UPDATE patients SET address = 'Ташкент' WHERE full_name = 'Иванов'").run();

  exchange(B, C, 'B', 'C');
  exchange(C, B, 'C', 'B');

  const inB = B.prepare("SELECT phone, address FROM patients WHERE full_name = 'Иванов'").get();
  const inC = C.prepare("SELECT phone, address FROM patients WHERE full_name = 'Иванов'").get();
  assert.deepEqual(inB, inC, 'две базы обязаны сойтись к одному состоянию');
  assert.equal(inB.phone, '+998901112233');
  assert.equal(inB.address, 'Ташкент');
  B.close(); C.close();
});

test('повторный обмен ничего не меняет и ничего не дублирует', () => {
  const B = node(); const C = node();
  B.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run();
  exchange(B, C, 'B', 'C');
  const n1 = C.prepare('SELECT COUNT(*) n FROM patients').get().n;
  exchange(B, C, 'B', 'C');
  assert.equal(C.prepare('SELECT COUNT(*) n FROM patients').get().n, n1);
  B.close(); C.close();
});

test('деньги не уезжают: счетов в приёмнике не появляется', () => {
  const B = node(); const C = node();
  const pid = B.prepare("INSERT INTO patients (full_name) VALUES ('Иванов')").run().lastInsertRowid;
  B.prepare('INSERT INTO invoices (patient_id, total_amount, status) VALUES (?, 100000, ?)').run(pid, 'open');
  exchange(B, C, 'B', 'C');
  assert.equal(C.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'счета — Фаза 3');
  B.close(); C.close();
});
```

- [ ] **Шаг 2: прогнать — должно упасть**

Запустить: `node --test server/services/branch-sync/records-e2e.test.js`
Ожидается: FAIL на первом же тесте.

- [ ] **Шаг 3: довести до зелёного**

Реализация уже написана в Задачах 4–5; здесь чинятся расхождения, которые
покажет сквозной тест. НЕ ослаблять утверждения: тест «обе базы сходятся» —
главный инвариант фазы.

- [ ] **Шаг 4: выгрузка журнала на релей**

В `relay.js` добавить `publishJournal(db, dataDir, node)` и
`fetchJournals(db, dataDir, peers)` по образцу `publishCatalogue`/
`fetchCatalogue`: то же уплотнение gzip, то же шифрование `sealPayload`, тот же
предел `MAX_BLOB_BYTES`, адрес — `relayIdFor(groupKey, node)`.

> **Проводка (по ревью 5/5b/7a):** `applyBatch(db, records, { self, peer })` —
> передавать букву соседа, чей блоб забрали (проверка `origin`). `markSent(db, peer,
> upto, clock, seed)` — пятый аргумент ОБЯЗАТЕЛЕН для холодного/засеваемого соседа,
> иначе бросает (защита от усечения засева); помощник `exchange` в тесте — тоже.
> Путь записей получает то же, что справочник: резервная копия перед применением,
> `try/catch` вокруг транзакции, `reason` в ответ. Соседей фильтровать `letter IS NOT
> NULL AND letter <> ''` перед `relayIdFor`; форму приехавшего журнала проверять,
> как `fetchCatalogue`. Keep-alive выгрузки журнала (как REFRESH_MS у справочника).

- [ ] **Шаг 5: вызвать из синхронизации**

В `server/services/rpc/branch-sync.js`, в `runBranchSync`, ПОСЛЕ применения
справочника: собрать порцию, выложить, забрать чужие, применить. Порядок важен:
справочник несёт услуги, на которые ссылаются `visit_services`.

- [ ] **Шаг 5а: чистка и холодный засев вживую** — в `runBranchSync` после
`markSent` журнал уже вычищен (Задача 4). Проверить на двух базах: сосед,
подключённый через месяц после включения журнала, получает ВСЕ строки
(холодный засев), а не только правки последнего месяца.

- [ ] **Шаг 6: прогнать всё**

Запустить: `npm test > /tmp/s.log 2>&1; echo "EXIT=$?"; grep -E "^ℹ (tests|pass|fail)" /tmp/s.log | tail -3`
Ожидается: `EXIT=0`, `fail 0`. **Не пропускать вывод через `tail` без
`echo $?`:** код выхода тогда принадлежит `tail`, а не тестам — на этом уже
обжигались 2026-09-02.

> **ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ после реализации (2026-09-02) — пропущенная выгрузка теряется.**
>
> Блоб узла ОДИН и ЗАМЕЩАЕТСЯ следующей выгрузкой, а `markSent` ставится по
> ответу сервера (так и написано в Шаге 4). Значит, узел, не забравший блоб до
> следующей выгрузки соседа (компьютер выключен на ночь, канал лёг на час),
> её содержимое не получит НИКОГДА — отправитель второй раз его не пошлёт.
> Закреплено тестом «ОГРАНИЧЕНИЕ: узел, пропустивший выгрузку соседа…»
> (`records-e2e.test.js`). Обмен работает верно ровно пока каждый узел забирает чужие
> блобы не реже, чем соседи их выкладывают (общий часовой ритм).
>
> **Лечение — отдельная задача (Задача 7b), и её нельзя свести к одним квитанциям.**
> Пробная сборка с квитанциями (срез несёт отпечаток содержимого, сосед кладёт
> применённый отпечаток в СВОЙ блоб, `markSent` по нему) была написана и
> откачена: защита местной неотправленной правки (`records.js localUnshippedCols`)
> читает ТОТ ЖЕ `sent_seq`, и на задержке подтверждения вставка ('*') держит ВСЮ
> строку: B не принимает адрес от C, C не принимает телефон от B, оба не подтверждают
> и не сходятся вовсе (воспроизведено сквозным тестом). Правильное решение разводит
> ДВА горизонта: «выложено» (снимает защиту местной правки) и «подтверждено»
> (двигает `sent_seq` и чистку журнала), то есть новая колонка `pub_seq` в `sync_peers`
> (миграция 084 ещё не выпущена), её чтение в `localUnshippedCols` и создание строки
> `sync_peers` при ВЫГРУЗКЕ, а не при подтверждении. До выката в живую сеть
> это надо закрыть: терять вечерние анализы филиала молча нельзя.

- [ ] **Шаг 7: коммит**

```bash
git add server/services/branch-sync/relay.js server/services/rpc/branch-sync.js \
        server/services/branch-sync/records-e2e.test.js
git commit -m "feat(sync): журналы ездят по релею — пациенты и лабораторная очередь видны во всех филиалах"
```

---

## Задача 8: на экране видно, откуда запись

> **Правка по ревью (2026-09-02).** Буква в MRN говорит, ГДЕ ПАЦИЕНТ ЗАВЕДЁН, а не
> где произошёл визит: пациент из C приходит в B, и его визит — работа B. Значит
> рабочие списки нельзя фильтровать по букве MRN. А `visits.branch_id` до Фазы 1
> ненадёжен (мастер ставит первый активный филиал; на вторичном это строка
> главной). Поэтому:
>
> - **Метка происхождения хранится на строке.** В 083 (не выпущена) добавить
>   `sync_origin TEXT` (NULL = создано здесь) к четырём таблицам; `applyBatch`
>   пишет `rec.origin` при INSERT новой строки и не трогает при UPDATE.
>   `SHIPPED` её не несёт — у соседа своя.
> - **«Своё здание» = `sync_origin IS NULL`.** Лабораторная очередь, очередь врача
>   и «Мои услуги» показывают только такие строки. Поиск пациентов — все.
> - **Подпись «из филиала X»** на строке пациента/визита/результата — по
>   `sync_origin` (буква), а не по MRN; MRN остаётся как есть.
> - Маршрутизация лаборатории «чья лаборатория выполняет мои анализы» (решение
>   владельца, спецификация «Слой 7») — отдельная задача после Фазы 2: она меняет
>   «своё здание» на «направлено в мою лабораторию».


**Файлы:**
- Изменить: `public/js/admin/views/patients.js`
- Изменить: `public/js/admin/views/laboratory.js`
- Создать: `public/js/admin/__tests__/record-origin.test.mjs`

- [ ] **Шаг 1: тест**

```js
test('в списке пациентов запись из другого филиала подписана его буквой', () => {
  // MRN уже несёт букву филиала (B-26-00042), поэтому источник не надо
  // передавать отдельно — он в номере.
  const row = patientRow({ mrn: 'C-26-00042', full_name: 'Иванов' }, { selfLetter: 'B' });
  assert.equal(row.branchTag, 'C', 'видно, что пациент заведён в другом здании');
});

test('своя запись не подписывается — метка на всём подряд перестаёт значить что-либо', () => {
  const row = patientRow({ mrn: 'B-26-00042', full_name: 'Иванов' }, { selfLetter: 'B' });
  assert.equal(row.branchTag, null);
});
```

- [ ] **Шаг 2: прогнать — должно упасть**

Запустить: `node --experimental-vm-modules --test public/js/admin/__tests__/record-origin.test.mjs`
Ожидается: FAIL.

- [ ] **Шаг 3: реализация**

Извлечь букву из MRN (`/^([A-Z]+)-/`) и, если она не равна букве этой
установки, показать её меткой в строке списка и в лабораторной очереди.

- [ ] **Шаг 4: рабочие списки остаются пофилиальными**

Решение владельца 2026-09-02: очередь и кабинет врача — своего здания.
Убедиться, что списки НЕ начали показывать чужую работу: лабораторная очередь
фильтруется по `visit_services`, чьи визиты принадлежат этому филиалу; чужие
видны только при открытии карты пациента.

Добавить тест, закрепляющий это:

```js
test('лабораторная очередь показывает работу СВОЕГО здания', () => {
  const rows = labQueueRows([
    { uid: 'a', mrn: 'B-26-1', status: 'ordered' },
    { uid: 'b', mrn: 'C-26-1', status: 'ordered' },
  ], { selfLetter: 'B' });
  assert.deepEqual(rows.map(r => r.mrn), ['B-26-1'],
    'иначе очередь Юнусабада наполнится работой Чиланзара');
});
```

- [ ] **Шаг 5: прогнать и закоммитить**

```bash
npm test > /tmp/s.log 2>&1; echo "EXIT=$?"
git add public/js/admin/views/patients.js public/js/admin/views/laboratory.js \
        public/js/admin/__tests__/record-origin.test.mjs
git commit -m "feat(sync): в списках видно, из какого филиала запись"
```

---

## Проверка перед выпуском

- [ ] **База, на которой уже применяли 083 в течение дня, не получит новых колонок**
      (`sync_origin`, `cols`, надгробия и курсор засева добавлены в 083/084 ПОСЛЕ
      первого применения; `schema_migrations` ключуется именем файла). Dev-машина
      и тестовая клиника, гонявшие ветку до финального 083/084, начинают с
      чистой базы — иначе `select('*')` по пациентам упадёт с 400 на
      несуществующей колонке, и это будет выглядеть как поломка кода.
- [ ] **Списки, которые НЕ фильтруются по своему зданию — намеренно:** карта
      пациента (визиты, документы, услуги, лаборатория), выбор услуг, счета,
      мастер визита, архив, аптека, отчёты; `consultation.js:870` читает все услуги
      визита, чтобы решить, закрыт ли визит. Доска очереди и заработок врача
      защищены схемой: `queue_no`/`doctor_id` не едут и приходят NULL.
- [ ] **Control plane с областью токена (008) развёрнут 2026-09-02** — резервная
      копия `/root/cp-backup-20260902-174329`, 2 токена → 2 области, все точки
      отвечают. Клиники можно обновлять после.
- [ ] **Заработок врача** (`consultation.js` ~1193) не фильтруется — сегодня
      безопасно (doctor_id не едет), после Фазы 3 — вопрос владельцу.


- [ ] `npm test` — `EXIT=0`, `fail 0` (код выхода читать напрямую, не через `tail`)
- [ ] Сквозной тест «обе базы сходятся» проходит
- [ ] Счетов и платежей в приёмнике не появляется
- [ ] На тестовой клинике: завести пациента в филиале, нажать «Синхронизация» в
      главной, убедиться, что пациент виден, а его номер начинается с буквы
      филиала
- [ ] Владелец подтверждает на тестовой клинике ДО выката в живой филиал —
      требование из спецификации
