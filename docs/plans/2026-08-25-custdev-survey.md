# Cust Dev — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Work them in
> order; each task ends green and committed.

**Goal:** A Cust Dev workplace opened from a button next to «Канбан» in CRM, where the call
centre rates each arrived-and-paid visit on three criteria (регистратура / касса / врач) and the
card's kanban column follows from those ratings automatically.

**Architecture:** One table `custdev_cards`, one row per visit, materialised lazily by an
idempotent sync when the board opens. The table is **deliberately absent** from
`schema-registry.js`, so `/api/db` cannot reach it at all; every read and write goes through five
RPCs guarded by `canViewSection`/`canEditSection('custdev')`, which read the grant from
`role_permissions` — the same place the Roles editor writes it. Status derivation is a pure
function on the server.

**Tech Stack:** Node + better-sqlite3, `node:test`. Vanilla ES modules in the browser, no build
step. SheetJS is vendored at `public/js/vendor/xlsx-0.20.3.mjs`.

**Spec:** `docs/specs/2026-08-25-custdev-survey-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `server/db/migrations/078_custdev.sql` | Table + grant the `custdev` key to admin and callcenter |
| `server/db/migrations/078.test.js` | Schema shape, CHECKs, UNIQUE, idempotent grants |
| `server/services/custdev/score.js` | Pure: validate three ratings, derive the status |
| `server/services/custdev/score.test.js` | The whole derivation table, no database |
| `server/services/custdev/sync.js` | Create missing cards for a window |
| `server/services/custdev/sync.test.js` | Qualifying rules, staff snapshot, idempotency |
| `server/services/custdev/board.js` | `listCards` + `reportFor` — the two read queries |
| `server/services/custdev/board.test.js` | Joins, period filter, aggregation, empty period |
| `server/services/rpc/custdev.js` | Thin RPC entries + role-level guards |
| `server/services/rpc/custdev.test.js` | Guard behaviour at each access level |
| `server/services/rpc/index.js` | Register the five RPCs |
| `server/services/control/gate.js` | `custdev_list` / `custdev_report` are read-only |
| `public/js/admin/permissions.js` | The grantable `custdev` key |
| `server/db/migrations/055.test.js` | Teach the dead-key guard about `custdev` |
| `public/js/admin/views/custdev.js` | The workplace: board, rating popup, report, Excel |
| `public/js/admin/views/crm.js` | One import + one button |

Every server file stays small and single-purpose. `score.js` has no database access on purpose:
the derivation table is the heart of the feature and must be testable without a fixture.

---

## Task 1: Migration — table and role grants

**Files:**
- Create: `server/db/migrations/078_custdev.sql`
- Create: `server/db/migrations/078.test.js`

- [ ] **Step 1: Confirm 078 is free**

Run: `ls server/db/migrations/*.sql | tail -3`
Expected: highest is `077_crm_config.sql`. If `078_*.sql` already exists, STOP — pick the next
free number and rename consistently through this plan. CLAUDE.md records three files once
colliding on `071_`, which silently made their order alphabetical.

- [ ] **Step 2: Write the migration**

Create `server/db/migrations/078_custdev.sql`:

```sql
-- 078_custdev.sql
-- CUSTDEV_V1 — обзвон пациентов после визита
-- (docs/specs/2026-08-25-custdev-survey-design.md).
--
-- Колл-центр звонит тем, кто ПРИШЁЛ и ОПЛАТИЛ, и оценивает три точки
-- внутреннего CJM: регистратуру, кассу и врача. Из трёх оценок статус
-- карточки складывается сам — правило живёт в services/custdev/score.js,
-- не здесь: SQL умеет хранить результат, но не объяснять его.
--
-- Таблица СОЗНАТЕЛЬНО не регистрируется в server/db/schema-registry.js.
-- Реестр раздаёт права по жёстко зашитому списку ролей, а доступ сюда
-- выдаётся галочкой в «Настройки → Роли», то есть набор ролей заранее
-- неизвестен. Открыть таблицу ALL_STAFF значило бы дать врачу читать
-- оценки о себе обычным /api/db-запросом мимо галочки. Реестр — allow-list,
-- поэтому ОТСУТСТВИЕ в нём и есть защита: тот же приём, что у
-- telephony_settings в миграции 076.

CREATE TABLE custdev_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Одна карточка на ВИЗИТ. UNIQUE — это и есть идемпотентность синхронизации:
  -- повторный прогон не создаёт дубль, а не «обычно не создаёт».
  visit_id    INTEGER NOT NULL UNIQUE REFERENCES visits(id),
  patient_id  INTEGER NOT NULL REFERENCES patients(id),
  -- Снимок: доска фильтрует и сортирует по нему. Хранится в том же виде, что
  -- visits.visit_date, — полный UTC-момент, а не голая дата.
  visit_date  TEXT NOT NULL,
  -- Снимок суммы оплат по визиту. Возврат, сделанный позже, его не меняет:
  -- для опроса это неважно, а источником истины по деньгам карточка не является.
  paid_amount REAL NOT NULL DEFAULT 0,

  -- Кто обслуживал — ПОИМЁННО, снимком. Отчёт «доволен врачом» по конкретному
  -- врачу — единственная причина, по которой опрос вообще собирают.
  --
  -- ON DELETE SET NULL, а не голая ссылка: routes/users.js решает
  -- «удаляем сотрудника или нет» по жёстко зашитому списку таблиц, которого эта
  -- таблица не знает. Голый FK позволил бы объявить удаление разрешённым и
  -- умереть на нём непрозрачной пятисоткой — ловушка, описанная в 073 и 076.
  registrar_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cashier_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  doctor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- 'na' = «не применимо», и это не украшение. Лабораторный визит идёт без
  -- врача, бесплатная услуга — без кассира. Без 'na' такая карточка не собрала
  -- бы три «доволен» НИКОГДА и навсегда осела бы в «Частично доволен», а отчёт
  -- считал бы несуществующего врача недоработавшим.
  score_registrar TEXT NOT NULL DEFAULT 'unrated'
                    CHECK (score_registrar IN ('unrated','good','bad','na')),
  score_cashier   TEXT NOT NULL DEFAULT 'unrated'
                    CHECK (score_cashier   IN ('unrated','good','bad','na')),
  score_doctor    TEXT NOT NULL DEFAULT 'unrated'
                    CHECK (score_doctor    IN ('unrated','good','bad','na')),

  -- new/unreachable ставит человек; остальные три ВЫЧИСЛЯЮТСЯ из оценок.
  status  TEXT NOT NULL DEFAULT 'new'
            CHECK (status IN ('new','unreachable','satisfied','partial','unsatisfied')),
  comment TEXT NOT NULL DEFAULT '',

  called_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  called_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_custdev_status_date ON custdev_cards(status, visit_date);
CREATE INDEX idx_custdev_patient     ON custdev_cards(patient_id);

-- --------------------------------------------------------------------------
-- Право «Cust Dev» в «Настройки → Роли»
-- --------------------------------------------------------------------------
-- Тот же приём, что в 062 для «Чата с пациентами».
--
-- Выдать надо ОБЕИМ ролям явно. У callcenter есть настроенная строка прав
-- (миграция 059), а настроенная роль ограничена ровно своим списком — без
-- этих строк колл-центр не увидел бы функцию, ради которой всё написано.
--
-- Владельцу — 'admin', колл-центру — 'editor': читать отчёт и звонить это
-- разные работы. NOT LIKE защищает от задвоения при повторном накате.
UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'custdev'),
         '$.levels.custdev', 'admin')
 WHERE role = 'admin'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"custdev"%';

UPDATE role_permissions
   SET permissions = json_set(
         json_insert(permissions, '$.sections[#]', 'custdev'),
         '$.levels.custdev', 'editor')
 WHERE role = 'callcenter'
   AND json_valid(permissions)
   AND permissions NOT LIKE '%"custdev"%';
```

- [ ] **Step 3: Write the migration test**

Create `server/db/migrations/078.test.js`:

```js
// CUSTDEV_V1 — форма таблицы и выдача права.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

// Минимальный визит с пациентом — нужен, чтобы FK не мешал вставке карточки.
function seedVisit(db) {
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Тест')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-08-01T10:00:00Z', 'arrived')").run();
}

test('078 — карточка заводится со здоровыми значениями по умолчанию', () => {
  const db = fresh();
  seedVisit(db);
  db.prepare('INSERT INTO custdev_cards (visit_id, patient_id, visit_date) VALUES (1, 1, ?)')
    .run('2026-08-01T10:00:00Z');
  const row = db.prepare('SELECT * FROM custdev_cards WHERE visit_id = 1').get();
  assert.equal(row.status, 'new');
  assert.equal(row.score_registrar, 'unrated');
  assert.equal(row.score_cashier, 'unrated');
  assert.equal(row.score_doctor, 'unrated');
  assert.equal(row.comment, '');
  assert.equal(row.paid_amount, 0);
  assert.equal(row.called_at, null);
});

test('078 — одна карточка на визит, вторая невозможна по схеме', () => {
  const db = fresh();
  seedVisit(db);
  const ins = db.prepare('INSERT INTO custdev_cards (visit_id, patient_id, visit_date) VALUES (1, 1, ?)');
  ins.run('2026-08-01T10:00:00Z');
  // Именно на этом держится идемпотентность custdev_sync.
  assert.throws(() => ins.run('2026-08-01T10:00:00Z'));
});

test('078 — CHECK-и не пускают выдуманный статус и выдуманную оценку', () => {
  const db = fresh();
  seedVisit(db);
  assert.throws(() => db.prepare(
    "INSERT INTO custdev_cards (visit_id, patient_id, visit_date, status) VALUES (1, 1, 'x', 'happy')").run());
  assert.throws(() => db.prepare(
    "INSERT INTO custdev_cards (visit_id, patient_id, visit_date, score_doctor) VALUES (1, 1, 'x', 'maybe')").run());
});

test('078 — право custdev выдано владельцу и колл-центру, с разными уровнями', () => {
  const db = fresh();
  const perms = (role) => JSON.parse(
    db.prepare('SELECT permissions FROM role_permissions WHERE role = ?').get(role).permissions);

  const admin = perms('admin');
  assert.ok(admin.sections.includes('custdev'));
  assert.equal(admin.levels.custdev, 'admin');

  const cc = perms('callcenter');
  assert.ok(cc.sections.includes('custdev'), 'без этой строки колл-центр не увидел бы Cust Dev');
  assert.equal(cc.levels.custdev, 'editor');

  // Остальным — не выдано: оценивают их, а не они.
  const reg = perms('registrar');
  assert.ok(!reg.sections.includes('custdev'));
});

test('078 — повторный накат права не задваивает', () => {
  const db = fresh();
  // migrate() отслеживает файлы по имени, поэтому прогоняем сам UPDATE ещё раз:
  // именно он должен быть защищён NOT LIKE, а не механика migrate().
  db.prepare(`UPDATE role_permissions
                 SET permissions = json_set(
                       json_insert(permissions, '$.sections[#]', 'custdev'),
                       '$.levels.custdev', 'editor')
               WHERE role = 'callcenter'
                 AND json_valid(permissions)
                 AND permissions NOT LIKE '%"custdev"%'`).run();
  const cc = JSON.parse(db.prepare("SELECT permissions FROM role_permissions WHERE role = 'callcenter'").get().permissions);
  assert.equal(cc.sections.filter((s) => s === 'custdev').length, 1);
});
```

- [ ] **Step 4: Run the test**

Run: `node --test server/db/migrations/078.test.js`
Expected: 5 tests pass. A failure on `role_permissions` missing means migration 059/013 changed —
read the actual seeded rows before adjusting.

- [ ] **Step 5: Commit**

```bash
git add server/db/migrations/078_custdev.sql server/db/migrations/078.test.js
git commit -m "feat(custdev): the card table, and «Cust Dev» as a grantable right"
```

---

## Task 2: The derivation rule (pure, no database)

**Files:**
- Create: `server/services/custdev/score.js`
- Create: `server/services/custdev/score.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/custdev/score.test.js`:

```js
// CUSTDEV_V1 — правило, ради которого всё написано: три оценки -> одна колонка.
// Без базы: таблица комбинаций должна проверяться напрямую, а не через фикстуру.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateOutcome, ScoreError } from './score.js';

const ok = (o) => rateOutcome({ comment: '', ...o });

test('ноль жалоб — «Доволен»', () => {
  assert.equal(ok({ registrar: 'good', cashier: 'good', doctor: 'good' }).status, 'satisfied');
});

test('одна жалоба — «Частично доволен», как и просил владелец про «двое из трёх»', () => {
  assert.equal(rateOutcome({ registrar: 'good', cashier: 'good', doctor: 'bad', comment: 'долго ждал' }).status, 'partial');
  assert.equal(rateOutcome({ registrar: 'bad', cashier: 'good', doctor: 'good', comment: 'нагрубили' }).status, 'partial');
});

test('две и больше — «Недоволен»', () => {
  assert.equal(rateOutcome({ registrar: 'bad', cashier: 'bad', doctor: 'good', comment: 'очередь' }).status, 'unsatisfied');
  assert.equal(rateOutcome({ registrar: 'bad', cashier: 'bad', doctor: 'bad', comment: 'всё плохо' }).status, 'unsatisfied');
});

test('«Не применимо» не считается ни довольным, ни недовольным', () => {
  // Лабораторный визит: врача не было. Две «доволен» дают «Доволен», а не «Частично».
  assert.equal(ok({ registrar: 'good', cashier: 'good', doctor: 'na' }).status, 'satisfied');
  // И одна жалоба из двух применимых — это по-прежнему ровно одна жалоба.
  assert.equal(rateOutcome({ registrar: 'good', cashier: 'bad', doctor: 'na', comment: 'сдача' }).status, 'partial');
});

test('невыставленная оценка сохраниться не может', () => {
  assert.throws(() => ok({ registrar: 'good', cashier: 'good', doctor: 'unrated' }), ScoreError);
  assert.throws(() => ok({ registrar: 'good', cashier: 'good' }), ScoreError);
  assert.throws(() => ok({ registrar: 'good', cashier: 'good', doctor: 'отлично' }), ScoreError);
});

test('три «Не применимо» — отказ, а не «Доволен»', () => {
  // Оценивать нечего, и «Доволен» тут был бы враньём в отчёте.
  assert.throws(() => ok({ registrar: 'na', cashier: 'na', doctor: 'na' }), ScoreError);
});

test('жалоба без причины не сохраняется', () => {
  assert.throws(() => ok({ registrar: 'good', cashier: 'good', doctor: 'bad' }), ScoreError);
  assert.throws(() => rateOutcome({ registrar: 'good', cashier: 'good', doctor: 'bad', comment: '   ' }), ScoreError);
});

test('комментарий возвращается обрезанным, и не требуется когда жалоб нет', () => {
  const out = rateOutcome({ registrar: 'good', cashier: 'good', doctor: 'good', comment: '  спасибо  ' });
  assert.equal(out.comment, 'спасибо');
  assert.equal(ok({ registrar: 'good', cashier: 'good', doctor: 'good' }).comment, '');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test server/services/custdev/score.test.js`
Expected: FAIL — `Cannot find module './score.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/services/custdev/score.js`:

```js
// CUSTDEV_V1 — три оценки -> одна колонка канбана.
//
// Живёт ОТДЕЛЬНО от RPC и без обращений к базе, потому что это единственное
// место, где записано само правило, а правило должно проверяться таблицей
// комбинаций, а не фикстурой с визитами и счетами.
//
// Считается на СЕРВЕРЕ: браузер может прислать что угодно, а колонка карточки
// обязана следовать из оценок при любом клиенте.

export class ScoreError extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

// 'unrated' сюда не входит намеренно: сохранить можно только решённое.
// «Не знаю» у оператора уже есть — это 'na'.
const DECIDED = ['good', 'bad', 'na'];

const LABEL = { registrar: 'Регистратура', cashier: 'Касса', doctor: 'Врач' };

/**
 * Проверяет три оценки и выводит статус карточки.
 *
 * @param {{registrar:string, cashier:string, doctor:string, comment?:string}} args
 * @returns {{status:string, comment:string}}
 * @throws {ScoreError} с текстом, который можно показать оператору как есть
 */
export function rateOutcome({ registrar, cashier, doctor, comment } = {}) {
  const scores = { registrar, cashier, doctor };

  for (const key of ['registrar', 'cashier', 'doctor']) {
    if (!DECIDED.includes(scores[key])) {
      throw new ScoreError(`Оцените пункт «${LABEL[key]}» или отметьте его как «Не применимо».`);
    }
  }

  const applicable = Object.values(scores).filter((v) => v !== 'na');
  if (applicable.length === 0) {
    // Иначе «ноль жалоб» дало бы «Доволен» по карточке, где никого не спросили.
    throw new ScoreError('Хотя бы один пункт должен быть оценён — три «Не применимо» оценкой не являются.');
  }

  const bad = applicable.filter((v) => v === 'bad').length;
  const text = String(comment || '').trim();

  // Жалоба без причины клинике бесполезна, а оператор держит человека на линии
  // именно сейчас — второй раз спросить будет уже не у кого.
  if (bad > 0 && !text) {
    throw new ScoreError('Отметьте в комментарии, что именно не устроило пациента.');
  }

  const status = bad === 0 ? 'satisfied' : bad === 1 ? 'partial' : 'unsatisfied';
  return { status, comment: text };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/services/custdev/score.test.js`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/custdev/score.js server/services/custdev/score.test.js
git commit -m "feat(custdev): the derivation rule — three ratings become one column"
```

---

## Task 3: Sync — materialising the cards

**Files:**
- Create: `server/services/custdev/sync.js`
- Create: `server/services/custdev/sync.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/custdev/sync.test.js`:

```js
// CUSTDEV_V1 — кто попадает на доску, с чьими именами, и что будет при повторе.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { syncCards } from './sync.js';

// Локальная дата со сдвигом в днях — теми же местными сутками, что и код.
const dayOffset = (db, n) => db.prepare("SELECT date('now','localtime',? || ' days') d").get(String(n)).d;

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(10, 'reg', 'x', 'Регистратор Р.', 'registrar');
  u.run(11, 'cash', 'x', 'Кассир К.', 'cashier');
  u.run(12, 'doc', 'x', 'Врач В.', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (1, 'Иванов И.', '+998900000000')").run();
  return db;
}

// Пришёл, счёт оплачен, деньги приняты — полный «хороший» визит.
function paidVisit(db, { id, day, doctorId = 12, paid = 50000, status = 'paid' }) {
  db.prepare('INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (?,1,?,?,?)')
    .run(id, doctorId, day + 'T09:00:00Z', 'arrived');
  db.prepare('INSERT INTO invoices (id, visit_id, patient_id, total_amount, paid_amount, status, created_by) VALUES (?,?,1,?,?,?,10)')
    .run(id, id, paid, paid, status);
  db.prepare('INSERT INTO payments (invoice_id, amount, cashier_id) VALUES (?,?,11)').run(id, paid);
}

const wide = (db) => ({ from: dayOffset(db, -30), to: dayOffset(db, 0) });

test('вчерашний оплаченный визит попадает на доску со снимком сотрудников', () => {
  const db = fresh();
  paidVisit(db, { id: 1, day: dayOffset(db, -1) });

  const created = syncCards(db, wide(db));
  assert.equal(created, 1);

  const c = db.prepare('SELECT * FROM custdev_cards WHERE visit_id = 1').get();
  assert.equal(c.patient_id, 1);
  assert.equal(c.registrar_id, 10, 'регистратор — тот, кто составил счёт');
  assert.equal(c.cashier_id, 11, 'кассир — тот, кто принял платёж');
  assert.equal(c.doctor_id, 12);
  assert.equal(c.paid_amount, 50000);
  assert.equal(c.status, 'new');
});

test('сегодняшний визит карточку НЕ создаёт — звоним на следующий день', () => {
  const db = fresh();
  paidVisit(db, { id: 1, day: dayOffset(db, 0) });
  assert.equal(syncCards(db, wide(db)), 0);
});

test('не пришёл или не оплатил — карточки нет', () => {
  const db = fresh();
  const yesterday = dayOffset(db, -1);

  // Записан, но не пришёл.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (2,1,?,'no_show')").run(yesterday + 'T09:00:00Z');
  db.prepare("INSERT INTO invoices (id, visit_id, patient_id, paid_amount, status, created_by) VALUES (2,2,1,50000,'paid',10)").run();

  // Пришёл, но счёт не оплачен.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (3,1,?,'arrived')").run(yesterday + 'T09:00:00Z');
  db.prepare("INSERT INTO invoices (id, visit_id, patient_id, paid_amount, status, created_by) VALUES (3,3,1,0,'unpaid',10)").run();

  assert.equal(syncCards(db, wide(db)), 0);
});

test('частичная оплата считается оплатой — деньги клиника получила', () => {
  const db = fresh();
  paidVisit(db, { id: 4, day: dayOffset(db, -1), paid: 20000, status: 'partial' });
  assert.equal(syncCards(db, wide(db)), 1);
});

test('визит без своего врача берёт врача из услуг', () => {
  const db = fresh();
  const day = dayOffset(db, -2);
  paidVisit(db, { id: 5, day, doctorId: null });
  db.prepare('INSERT INTO visit_services (visit_id, service_id, doctor_id) VALUES (5, NULL, 12)').run();

  syncCards(db, wide(db));
  assert.equal(db.prepare('SELECT doctor_id FROM custdev_cards WHERE visit_id = 5').get().doctor_id, 12);
});

test('лабораторный визит вообще без врача — карточка есть, врач пуст', () => {
  const db = fresh();
  paidVisit(db, { id: 6, day: dayOffset(db, -1), doctorId: null });
  syncCards(db, wide(db));
  const c = db.prepare('SELECT * FROM custdev_cards WHERE visit_id = 6').get();
  assert.equal(c.doctor_id, null, 'именно для этого случая существует оценка «Не применимо»');
});

test('повторный прогон не создаёт дублей', () => {
  const db = fresh();
  paidVisit(db, { id: 7, day: dayOffset(db, -1) });
  assert.equal(syncCards(db, wide(db)), 1);
  assert.equal(syncCards(db, wide(db)), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custdev_cards').get().n, 1);
});

test('глубже 90 дней не подметаем — иначе доска открылась бы тысячами карточек', () => {
  const db = fresh();
  paidVisit(db, { id: 8, day: dayOffset(db, -200) });
  assert.equal(syncCards(db, { from: dayOffset(db, -365), to: dayOffset(db, 0) }), 0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test server/services/custdev/sync.test.js`
Expected: FAIL — `Cannot find module './sync.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/services/custdev/sync.js`:

```js
// CUSTDEV_V1 — материализация карточек.
//
// Никакой фоновой работы и НИ ОДНОЙ правки в денежном коде: доска при открытии
// один раз досоздаёт то, чего не хватает. Прецедент такого «подмета при
// загрузке» в проекте уже есть — авто-no_show в views/crm.js.
//
// Идемпотентность держится не на аккуратности этого запроса, а на
// UNIQUE(visit_id) в миграции 078 плюс NOT EXISTS здесь.

import { localDate, today } from '../domain/day.js';

// Глубина первичного подмёта. В клинике с двухлетней историей без ограничения
// первое открытие доски создало бы десятки тысяч карточек «Не обзвонён» —
// очередь, которую никто никогда не разберёт.
export const BACKFILL_DAYS = 90;

/**
 * Создаёт недостающие карточки за пересечение периода с последними 90 днями.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{from?: string, to?: string}} window — местные 'YYYY-MM-DD'
 * @returns {number} сколько карточек создано
 */
export function syncCards(db, { from, to } = {}) {
  const t = today(db);
  const floor = db.prepare("SELECT date(?, '-' || ? || ' days') d").get(t, String(BACKFILL_DAYS)).d;

  const start = from && from > floor ? from : floor;
  const end = to && to < t ? to : t;
  if (start > end) return 0;

  // visits.visit_date хранит ПОЛНЫЙ UTC-момент (new Date().toISOString() в
  // doctor-room.js и room-calendar.js), а не голую дату. Поэтому сравниваем
  // через localDate(): на UTC+5 вечерний визит по UTC-срезу оказался бы
  // завтрашним и карточка появилась бы на день позже. Правило day.js: никто не
  // пишет date('now') или date(col) своими руками.
  const info = db.prepare(`
    INSERT INTO custdev_cards
           (visit_id, patient_id, visit_date, paid_amount, registrar_id, cashier_id, doctor_id)
    SELECT v.id,
           v.patient_id,
           v.visit_date,
           (SELECT COALESCE(SUM(i.paid_amount), 0) FROM invoices i WHERE i.visit_id = v.id),
           -- Смету составляет регистратура: автор ПЕРВОГО счёта визита.
           (SELECT i.created_by FROM invoices i WHERE i.visit_id = v.id ORDER BY i.id LIMIT 1),
           -- Кассир — тот, кто принял ПОСЛЕДНИЙ платёж: при доплате пациент
           -- разговаривал именно с ним.
           (SELECT p.cashier_id FROM payments p
              JOIN invoices i ON i.id = p.invoice_id
             WHERE i.visit_id = v.id ORDER BY p.id DESC LIMIT 1),
           -- У лабораторного визита своего врача нет — берём из услуг.
           COALESCE(v.doctor_id,
                    (SELECT vs.doctor_id FROM visit_services vs
                      WHERE vs.visit_id = v.id AND vs.doctor_id IS NOT NULL
                      ORDER BY vs.id LIMIT 1))
      FROM visits v
     WHERE v.status = 'arrived'
       AND ${localDate('v.visit_date')} BETWEEN date(?) AND date(?)
       AND ${localDate('v.visit_date')} < date(?)
       AND EXISTS (SELECT 1 FROM invoices i
                    WHERE i.visit_id = v.id
                      AND i.paid_amount > 0
                      AND i.status IN ('paid','partial'))
       AND NOT EXISTS (SELECT 1 FROM custdev_cards c WHERE c.visit_id = v.id)
  `).run(start, end, t);

  return info.changes;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test server/services/custdev/sync.test.js`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/custdev/sync.js server/services/custdev/sync.test.js
git commit -m "feat(custdev): materialise cards for arrived, paid visits — next day only"
```

---

## Task 4: The two read queries

**Files:**
- Create: `server/services/custdev/board.js`
- Create: `server/services/custdev/board.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/custdev/board.test.js`:

```js
// CUSTDEV_V1 — что видит доска и что считает отчёт.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { listCards, reportFor } from './board.js';

const dayOffset = (db, n) => db.prepare("SELECT date('now','localtime',? || ' days') d").get(String(n)).d;

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(10, 'reg', 'x', 'Регистратор Р.', 'registrar');
  u.run(11, 'cash', 'x', 'Кассир К.', 'cashier');
  u.run(12, 'doc', 'x', 'Врач В.', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name, mrn, phone) VALUES (1, 'Иванов И.', 'MRN-1', '+998900000000')").run();
  return db;
}

// Карточка прямо в таблицу: board.js читает, а не создаёт.
function card(db, { id, day, status = 'new', reg = 'unrated', cash = 'unrated', doc = 'unrated' }) {
  db.prepare('INSERT INTO visits (id, patient_id, visit_date, status) VALUES (?,1,?,?)')
    .run(id, day + 'T09:00:00Z', 'arrived');
  db.prepare(`INSERT INTO custdev_cards
                (visit_id, patient_id, visit_date, paid_amount, registrar_id, cashier_id, doctor_id,
                 score_registrar, score_cashier, score_doctor, status)
              VALUES (?,1,?,50000,10,11,12,?,?,?,?)`)
    .run(id, day + 'T09:00:00Z', reg, cash, doc, status);
}

test('доска отдаёт карточку вместе с ЖИВЫМИ данными пациента и именами сотрудников', () => {
  const db = fresh();
  card(db, { id: 1, day: dayOffset(db, -1) });

  const rows = listCards(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].patient_name, 'Иванов И.');
  assert.equal(rows[0].mrn, 'MRN-1');
  assert.equal(rows[0].phone, '+998900000000');
  assert.equal(rows[0].registrar_name, 'Регистратор Р.');
  assert.equal(rows[0].cashier_name, 'Кассир К.');
  assert.equal(rows[0].doctor_name, 'Врач В.');
});

test('исправленный телефон подхватывается — он не снимок', () => {
  const db = fresh();
  card(db, { id: 1, day: dayOffset(db, -1) });
  db.prepare("UPDATE patients SET phone = '+998911111111' WHERE id = 1").run();
  const rows = listCards(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rows[0].phone, '+998911111111', 'звонить надо по новому номеру');
});

test('период режет по дате визита', () => {
  const db = fresh();
  card(db, { id: 1, day: dayOffset(db, -1) });
  card(db, { id: 2, day: dayOffset(db, -40) });
  const rows = listCards(db, { from: dayOffset(db, -7), to: dayOffset(db, 0) });
  assert.deepEqual(rows.map((r) => r.visit_id), [1]);
});

test('отчёт считает воронку и долю обзвона', () => {
  const db = fresh();
  const d = dayOffset(db, -1);
  card(db, { id: 1, day: d, status: 'satisfied',   reg: 'good', cash: 'good', doc: 'good' });
  card(db, { id: 2, day: d, status: 'partial',     reg: 'good', cash: 'good', doc: 'bad'  });
  card(db, { id: 3, day: d, status: 'unsatisfied', reg: 'bad',  cash: 'bad',  doc: 'good' });
  card(db, { id: 4, day: d, status: 'unreachable' });
  card(db, { id: 5, day: d });   // не обзвонён

  const rep = reportFor(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rep.total, 5);
  assert.equal(rep.satisfied, 1);
  assert.equal(rep.partial, 1);
  assert.equal(rep.unsatisfied, 1);
  assert.equal(rep.unreachable, 1);
  // Обзвонено = всё, кроме «Не обзвонён»; недозвон — тоже попытка.
  assert.equal(rep.called, 4);
});

test('в разрезе по сотруднику «Не применимо» и «Не оценено» не считаются', () => {
  const db = fresh();
  const d = dayOffset(db, -1);
  card(db, { id: 1, day: d, status: 'satisfied', reg: 'good', cash: 'good', doc: 'good' });
  card(db, { id: 2, day: d, status: 'partial',   reg: 'good', cash: 'good', doc: 'bad'  });
  card(db, { id: 3, day: d, status: 'satisfied', reg: 'good', cash: 'good', doc: 'na'   });
  card(db, { id: 4, day: d });   // ничего не оценено

  const rep = reportFor(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  const doc = rep.byDoctor.find((r) => r.id === 12);
  assert.equal(doc.good, 1);
  assert.equal(doc.bad, 1);
  assert.equal(doc.pct, 50, 'na и unrated не входят ни в числитель, ни в знаменатель');

  const reg = rep.byRegistrar.find((r) => r.id === 10);
  assert.equal(reg.good, 3);
  assert.equal(reg.bad, 0);
  assert.equal(reg.pct, 100);
});

test('пустой период не делит на ноль', () => {
  const db = fresh();
  const rep = reportFor(db, { from: dayOffset(db, -30), to: dayOffset(db, 0) });
  assert.equal(rep.total, 0);
  assert.equal(rep.calledPct, 0);
  assert.deepEqual(rep.byDoctor, []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test server/services/custdev/board.test.js`
Expected: FAIL — `Cannot find module './board.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/services/custdev/board.js`:

```js
// CUSTDEV_V1 — два запроса на чтение: доска и отчёт.
//
// JOIN здесь, а не embed в /api/db, потому что custdev_cards намеренно нет в
// schema-registry.js: реестр раздаёт права по жёстко зашитому списку ролей, а
// доступ к Cust Dev выдаётся галочкой в «Настройки → Роли».

import { localDate } from '../domain/day.js';

// Столько карточек доска читает за раз — как 800 заявок в CRM. Доска это
// рабочая очередь, а не архив.
const MAX_ROWS = 1000;

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/**
 * Карточки периода с ЖИВЫМИ данными пациента и именами сотрудников.
 * Телефон и ФИО не снимок: если пациент исправил номер, звонить надо по новому.
 */
export function listCards(db, { from, to } = {}) {
  return db.prepare(`
    SELECT c.*,
           p.full_name AS patient_name, p.mrn AS mrn, p.phone AS phone,
           r.full_name AS registrar_name,
           k.full_name AS cashier_name,
           d.full_name AS doctor_name,
           cb.full_name AS called_by_name
      FROM custdev_cards c
      JOIN patients p ON p.id = c.patient_id
      LEFT JOIN users r  ON r.id  = c.registrar_id
      LEFT JOIN users k  ON k.id  = c.cashier_id
      LEFT JOIN users d  ON d.id  = c.doctor_id
      LEFT JOIN users cb ON cb.id = c.called_by
     WHERE ${localDate('c.visit_date')} BETWEEN date(?) AND date(?)
     ORDER BY c.visit_date DESC, c.id DESC
     LIMIT ${MAX_ROWS}
  `).all(from, to);
}

// Разрез по одному сотруднику. 'na' и 'unrated' не попадают ни в числитель, ни
// в знаменатель: иначе лабораторный визит без врача портил бы статистику врача,
// которого там не было.
function byStaff(db, idColumn, scoreColumn, from, to) {
  const rows = db.prepare(`
    SELECT c.${idColumn} AS id,
           u.full_name   AS name,
           SUM(c.${scoreColumn} = 'good') AS good,
           SUM(c.${scoreColumn} = 'bad')  AS bad
      FROM custdev_cards c
      JOIN users u ON u.id = c.${idColumn}
     WHERE ${localDate('c.visit_date')} BETWEEN date(?) AND date(?)
       AND c.${scoreColumn} IN ('good','bad')
     GROUP BY c.${idColumn}, u.full_name
     ORDER BY u.full_name
  `).all(from, to);

  return rows.map((r) => ({ ...r, pct: pct(r.good, r.good + r.bad) }));
}

/** Всё, что показывает экран «Отчёт». */
export function reportFor(db, { from, to } = {}) {
  const k = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(status <> 'new')       AS called,
           SUM(status = 'satisfied')  AS satisfied,
           SUM(status = 'partial')    AS partial,
           SUM(status = 'unsatisfied') AS unsatisfied,
           SUM(status = 'unreachable') AS unreachable
      FROM custdev_cards
     WHERE ${localDate('visit_date')} BETWEEN date(?) AND date(?)
  `).get(from, to);

  const total = k.total || 0;
  const called = k.called || 0;

  return {
    total,
    called,
    calledPct: pct(called, total),
    satisfied: k.satisfied || 0,
    partial: k.partial || 0,
    unsatisfied: k.unsatisfied || 0,
    unreachable: k.unreachable || 0,
    byRegistrar: byStaff(db, 'registrar_id', 'score_registrar', from, to),
    byCashier:   byStaff(db, 'cashier_id',   'score_cashier',   from, to),
    byDoctor:    byStaff(db, 'doctor_id',    'score_doctor',    from, to),
  };
}
```

Note on `byStaff`: `idColumn` and `scoreColumn` are interpolated into SQL, which normally would be
the injection this codebase forbids. They are safe here and only here because both arguments are
**compile-time literals from this file** — never a request value. Do not widen this function to
take a caller-supplied column.

- [ ] **Step 4: Run the tests**

Run: `node --test server/services/custdev/board.test.js`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/services/custdev/board.js server/services/custdev/board.test.js
git commit -m "feat(custdev): board listing and the satisfaction report"
```

---

## Task 5: The RPC surface and its guards

**Files:**
- Create: `server/services/rpc/custdev.js`
- Create: `server/services/rpc/custdev.test.js`
- Modify: `server/services/rpc/index.js`
- Modify: `server/services/control/gate.js`

- [ ] **Step 1: Write the failing test**

Create `server/services/rpc/custdev.test.js`:

```js
// CUSTDEV_V1 — граница: кто может смотреть, кто может оценивать, и как отказ
// доходит до экрана.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { custdevList, custdevSync, custdevRate, custdevMark, custdevReport } from './custdev.js';
import { RpcError } from './crm-config.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { tableEntry, canRead, canWrite } from '../../db/schema-registry.js';

const dayOffset = (db, n) => db.prepare("SELECT date('now','localtime',? || ' days') d").get(String(n)).d;

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'adm', 'x', 'Владелец', 'admin');
  u.run(2, 'cc', 'x', 'Оператор', 'callcenter');
  u.run(3, 'doc', 'x', 'Врач В.', 'doctor');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1, 'Иванов И.')").run();
  return db;
}

const admin = { id: 1, role: 'admin' };
const operator = { id: 2, role: 'callcenter' };
const doctor = { id: 3, role: 'doctor' };

function paidVisit(db, id, day) {
  db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (?,1,3,?,'arrived')")
    .run(id, day + 'T09:00:00Z');
  db.prepare("INSERT INTO invoices (id, visit_id, patient_id, paid_amount, status, created_by) VALUES (?,?,1,1000,'paid',1)")
    .run(id, id);
  db.prepare('INSERT INTO payments (invoice_id, amount, cashier_id) VALUES (?,1000,1)').run(id);
}

const period = (db) => ({ from: dayOffset(db, -30), to: dayOffset(db, 0) });

test('custdev_cards НЕДОСТУПНА через /api/db — на этом держится вся защита', () => {
  // Реестр — allow-list, поэтому отсутствие в нём и есть защита: тот же приём,
  // что у telephony_settings (076). Если таблицу однажды зарегистрируют «чтобы
  // было удобнее», врач сможет прочитать оценки о себе обычным запросом мимо
  // галочки в «Настройки → Роли». Этот тест — единственное, что стоит на пути.
  assert.equal(tableEntry('custdev_cards'), null);
  for (const role of ['admin', 'callcenter', 'doctor', 'registrar', 'cashier', 'nurse', 'lab', 'inventory']) {
    assert.equal(canRead('custdev_cards', role), false, role + ' не должен читать таблицу напрямую');
    for (const op of ['insert', 'update', 'delete']) {
      assert.equal(canWrite('custdev_cards', op, role), false);
    }
  }
});

test('пять RPC зарегистрированы под ожидаемыми именами', () => {
  for (const name of ['custdev_list', 'custdev_sync', 'custdev_rate', 'custdev_mark', 'custdev_report']) {
    assert.equal(typeof getRpc(name), 'function', name + ' не зарегистрирован');
  }
});

test('чтение доски и отчёт работают при просроченной лицензии, запись — нет', () => {
  // Клиника с лапнувшей лицензией читает, но не пишет. Доска без чтения была бы
  // пустым экраном, а не «режимом только для чтения».
  assert.equal(isReadOnlyRpc('custdev_list'), true);
  assert.equal(isReadOnlyRpc('custdev_report'), true);
  assert.equal(isReadOnlyRpc('custdev_rate'), false);
  assert.equal(isReadOnlyRpc('custdev_sync'), false);
});

test('роль без выданного ключа не проходит никуда', () => {
  const db = fresh();
  for (const call of [custdevList, custdevSync, custdevReport]) {
    assert.throws(() => call(db, period(db), doctor),
      (e) => e instanceof RpcError && e.status === 403,
      'врач не должен читать оценки о себе');
  }
});

test('колл-центр видит доску и может оценивать', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  assert.equal(custdevSync(db, period(db), operator).created, 1);

  const rows = custdevList(db, period(db), operator);
  assert.equal(rows.length, 1);

  const card = rows[0];
  const out = custdevRate(db, {
    card_id: card.id, registrar: 'good', cashier: 'good', doctor: 'good', comment: '',
  }, operator);
  assert.equal(out.status, 'satisfied');

  const saved = db.prepare('SELECT * FROM custdev_cards WHERE id = ?').get(card.id);
  assert.equal(saved.status, 'satisfied');
  assert.equal(saved.called_by, 2, 'штамп «кто звонил» ставит сервер');
  assert.ok(saved.called_at);
});

test('уровень «Только просмотр» читает, но оценивать не может', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  // Понижаем колл-центр до просмотра — ровно то, что владелец делает галочкой.
  db.prepare(`UPDATE role_permissions SET permissions = json_set(permissions, '$.levels.custdev', 'viewer')
               WHERE role = 'callcenter'`).run();

  assert.equal(custdevList(db, period(db), operator).length, 1);
  assert.throws(() => custdevRate(db, {
    card_id: cardId, registrar: 'good', cashier: 'good', doctor: 'good',
  }, operator), (e) => e instanceof RpcError && e.status === 403);
});

test('жалоба без комментария отклоняется с текстом для оператора', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  assert.throws(() => custdevRate(db, {
    card_id: cardId, registrar: 'good', cashier: 'good', doctor: 'bad', comment: '',
  }, operator), (e) => e.status === 400 && /не устроило/.test(e.message));
});

test('custdev_mark ставит «Не дозвонились» и не трогает оценки', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), operator);
  const cardId = custdevList(db, period(db), operator)[0].id;

  custdevMark(db, { card_id: cardId, status: 'unreachable' }, operator);
  const row = db.prepare('SELECT * FROM custdev_cards WHERE id = ?').get(cardId);
  assert.equal(row.status, 'unreachable');
  assert.equal(row.score_doctor, 'unrated');

  // Вычисляемый статус руками не ставится — иначе колонка разошлась бы с оценками.
  assert.throws(() => custdevMark(db, { card_id: cardId, status: 'satisfied' }, operator),
    (e) => e instanceof RpcError && e.status === 400);
});

test('оценка несуществующей карточки — 404, а не молчание', () => {
  const db = fresh();
  assert.throws(() => custdevRate(db, {
    card_id: 999, registrar: 'good', cashier: 'good', doctor: 'good',
  }, operator), (e) => e instanceof RpcError && e.status === 404);
});

test('владелец видит доску и отчёт', () => {
  const db = fresh();
  paidVisit(db, 1, dayOffset(db, -1));
  custdevSync(db, period(db), admin);
  assert.equal(custdevList(db, period(db), admin).length, 1);
  assert.equal(custdevReport(db, period(db), admin).total, 1);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test server/services/rpc/custdev.test.js`
Expected: FAIL — `Cannot find module './custdev.js'`.

- [ ] **Step 3: Write the RPC module**

Create `server/services/rpc/custdev.js`:

```js
// CUSTDEV_V1 — граница Cust Dev: разбор аргументов и права. Вся логика живёт в
// services/custdev/.
//
// Права проверяются через canViewSection/canEditSection, а НЕ hasAnyRole со
// списком ролей в коде: доступ выдаётся галочкой в «Настройки → Роли», то есть
// набор ролей заранее неизвестен и проверять его надо ТАМ ЖЕ, где он хранится.
// Тот же выбор и по той же причине сделан для «Чата с пациентами».

import { canViewSection, canEditSection } from '../roles.js';
import { RpcError } from './crm-config.js';
import { syncCards } from '../custdev/sync.js';
import { listCards, reportFor } from '../custdev/board.js';
import { rateOutcome, ScoreError } from '../custdev/score.js';

const KEY = 'custdev';

function requireView(db, user) {
  if (!canViewSection(db, user, KEY)) {
    throw new RpcError('Раздел «Cust Dev» вам не выдан.', 403);
  }
}

function requireEdit(db, user) {
  requireView(db, user);
  if (!canEditSection(db, user, KEY)) {
    throw new RpcError('У вас доступ «Только просмотр»: оценивать карточки нельзя.', 403);
  }
}

// Границы периода приходят как местные 'YYYY-MM-DD'. Пустые не подставляем
// молча: доска всегда шлёт обе, а запрос без периода читал бы всю базу.
function period(args) {
  const from = String((args && args.from) || '').slice(0, 10);
  const to = String((args && args.to) || '').slice(0, 10);
  if (!from || !to) throw new RpcError('Не указан период.', 400);
  return { from, to };
}

function loadCard(db, args) {
  const id = Number(args && args.card_id);
  if (!Number.isInteger(id) || id <= 0) throw new RpcError('Не указана карточка.', 400);
  const row = db.prepare('SELECT * FROM custdev_cards WHERE id = ?').get(id);
  if (!row) throw new RpcError('Карточка не найдена.', 404);
  return row;
}

export function custdevList(db, args, user) {
  requireView(db, user);
  return listCards(db, period(args));
}

export function custdevReport(db, args, user) {
  requireView(db, user);
  return reportFor(db, period(args));
}

/**
 * Досоздаёт карточки за период. Просмотра достаточно: это не изменение данных
 * клиники, а материализация того, что уже произошло у кассы.
 */
export function custdevSync(db, args, user) {
  requireView(db, user);
  return { created: syncCards(db, period(args)) };
}

export function custdevRate(db, args, user) {
  requireEdit(db, user);
  const card = loadCard(db, args);

  let outcome;
  try {
    outcome = rateOutcome(args);
  } catch (e) {
    // ScoreError несёт текст, который можно показать оператору как есть.
    if (e instanceof ScoreError) throw new RpcError(e.message, 400);
    throw e;
  }

  db.prepare(`UPDATE custdev_cards
                 SET score_registrar = ?, score_cashier = ?, score_doctor = ?,
                     status = ?, comment = ?,
                     called_by = ?, called_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE id = ?`)
    .run(args.registrar, args.cashier, args.doctor,
         outcome.status, outcome.comment, (user && user.id) || null, card.id);

  return { id: card.id, status: outcome.status };
}

// Только ручные статусы. Вычисляемые три сюда не пускаем: они следуют из
// оценок, и поставленный руками «Доволен» разошёлся бы с ними навсегда.
const MANUAL = ['new', 'unreachable'];

export function custdevMark(db, args, user) {
  requireEdit(db, user);
  const card = loadCard(db, args);
  const status = String((args && args.status) || '');
  if (!MANUAL.includes(status)) {
    throw new RpcError('Этот статус выставляется оценками, а не вручную.', 400);
  }

  db.prepare(`UPDATE custdev_cards
                 SET status = ?, called_by = ?,
                     called_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
               WHERE id = ?`)
    .run(status, (user && user.id) || null, card.id);

  return { id: card.id, status };
}
```

- [ ] **Step 4: Register the five RPCs**

In `server/services/rpc/index.js`, add the import beside the other CRM ones:

```js
import { custdevList, custdevSync, custdevRate, custdevMark, custdevReport } from './custdev.js';   // CUSTDEV_V1
```

And inside the `RPC` object:

```js
  // CUSTDEV_V1 — обзвон пациентов после визита
  custdev_list:   (db, args, user) => custdevList(db, args, user),
  custdev_sync:   (db, args, user) => custdevSync(db, args, user),
  custdev_rate:   (db, args, user) => custdevRate(db, args, user),
  custdev_mark:   (db, args, user) => custdevMark(db, args, user),
  custdev_report: (db, args, user) => custdevReport(db, args, user),
```

- [ ] **Step 5: Let a lapsed clinic still read the board**

In `server/services/control/gate.js`, add to `READ_ONLY_RPCS` (after the `crm_config_get` entry):

```js
  // CUSTDEV_V1 — доска и отчёт по обзвону. Чистое чтение. Клиника с
  // просроченной лицензией читает, но не пишет, и «читает» не должно
  // означать «пустой экран вместо доски». Оценка (custdev_rate/mark) и
  // досоздание карточек (custdev_sync) сюда НЕ входят — это записи.
  'custdev_list', 'custdev_report',
```

- [ ] **Step 6: Run the tests**

Run: `node --test server/services/rpc/custdev.test.js`
Expected: 10 tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/services/rpc/custdev.js server/services/rpc/custdev.test.js \
        server/services/rpc/index.js server/services/control/gate.js
git commit -m "feat(custdev): RPC surface guarded by the granted section level"
```

---

## Task 6: The tickable right in Settings → Роли

**Files:**
- Modify: `public/js/admin/permissions.js:40-73` (the `NAV_MODULES` list)
- Modify: `server/db/migrations/055.test.js`

- [ ] **Step 1: Add the grantable key**

In `public/js/admin/permissions.js`, inside the `'Клинические'` group, immediately after the
`crm` entry:

```js
        // CUSTDEV_V1 — не пункт меню, а кнопка внутри CRM. Ключ отдельный от
        // `crm` намеренно: заявки ведёт регистратура, а оценки о врачах и
        // кассирах читать ей незачем. Уровень «Просмотр» = доска и отчёт без
        // права оценивать — это уровень владельца.
        { key: 'custdev',           label: 'Cust Dev · Обзвон', desc: 'Опрос пришедших и оплативших: регистратура, касса, врач' },
```

- [ ] **Step 2: Teach the dead-key guard about it**

`055.test.js` fails any grantable key that nothing checks. `custdev` is a real gate but lives in
`views/crm.js`, which the test does not currently read. In `server/db/migrations/055.test.js`,
extend `NON_NAV_GATES` and the source list it searches.

Replace the `NON_NAV_GATES` block with:

```js
// Keys that are real gates without being NAV ids, each with the line that reads
// it. Anything NOT here and not a NAV id is a dead key.
const NON_NAV_GATES = {
  // renderSidebar(): the «+ Новый пациент» CTA.
  registration: /isModuleAllowed\('registration'\)/,
  // isModuleAllowed('cashier-shifts') accepts `cashier` as an alias of the NAV id.
  cashier: /navId === 'cashier-shifts'\) return _effective\.has\('cashier-shifts'\) \|\| _effective\.has\('cashier'\)/,
  // CUSTDEV_V1 — the «Cust Dev» button inside the CRM screen. Its gate cannot
  // live in admin.js: the workplace is not a sidebar section, it is a button
  // next to «Канбан».
  custdev: /canView\('custdev'\)/,
};

// Files a non-NAV gate may live in. crm.js joined the list with CUSTDEV_V1 —
// a gate belongs where the thing it guards is drawn, and forcing it into
// admin.js just to satisfy this test would put the check in the wrong file.
const GATE_SOURCES = ['public/js/admin.js', 'public/js/admin/permissions.js', 'public/js/admin/views/crm.js'];
```

Then in the first test, replace the two `read(...)` lines and the membership check:

```js
test('every grantable key is a real gate — no key the UI offers is dead', () => {
  const nav = new Set(navIds());
  const sources = GATE_SOURCES.map(read);
  const dead = [];
  for (const key of grantableKeys()) {
    if (nav.has(key)) continue;
    const re = NON_NAV_GATES[key];
    if (re && sources.some((src) => re.test(src))) continue;
    dead.push(key);
  }
  assert.deepEqual(dead, [], 'grantable keys that nothing checks (ticking them does nothing):\n' + dead.join('\n'));
});
```

- [ ] **Step 3: Run the guard and watch it FAIL**

Run: `node --test server/db/migrations/055.test.js`
Expected: FAIL — `custdev` is reported as a dead key, because `canView('custdev')` does not exist
in `crm.js` yet. **This failure is the point:** it proves the guard actually catches a dead
tickbox. Task 9 adds the gate and turns it green.

- [ ] **Step 4: Commit the red state deliberately**

```bash
git add public/js/admin/permissions.js server/db/migrations/055.test.js
git commit -m "feat(custdev): offer «Cust Dev» in the Roles editor

055.test.js is RED after this commit, on purpose: the key is offered but
nothing reads it yet. Task 9 adds canView('custdev') to crm.js and the
guard goes green. A tickbox nothing checks is exactly the failure this
test exists to catch — see doctor-room."
```

---

## Task 7: The workplace — board and cards

**Files:**
- Create: `public/js/admin/views/custdev.js`

- [ ] **Step 1: Write the view**

Create `public/js/admin/views/custdev.js`:

```js
// CUSTDEV_V1 — рабочее место обзвона (docs/specs/2026-08-25-custdev-survey-design.md).
//
// Открывается кнопкой «Cust Dev» рядом с «Канбан» в CRM. Оператор звонит тем,
// кто пришёл и оплатил, и оценивает три точки: регистратуру, кассу и врача.
//
// ТРИ ИЗ ПЯТИ КОЛОНОК ВЫЧИСЛЯЕМЫЕ. Перетаскивать карточку в «Доволен» нельзя:
// перетаскивание противоречило бы оценкам, из которых эта колонка получилась.
// Руками двигаются только «Не обзвонён» и «Не дозвонились».

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, Tag, field } from '../ui.js';
import { canEdit } from '../permissions.js';

const STATUSES = [
    ['new',         'Не обзвонён',      'info'],
    ['unreachable', 'Не дозвонились',   'warn'],
    ['satisfied',   'Доволен',          'ok'],
    ['partial',     'Частично доволен', 'purple'],
    ['unsatisfied', 'Недоволен',        'crit'],
];
// Куда можно бросить карточку мышью. Остальные три следуют из оценок.
const MANUAL = ['new', 'unreachable'];

const SCORES = [
    ['good', 'Доволен'],
    ['bad',  'Не доволен'],
    ['na',   'Не применимо'],
];
const SCORE_TAG = { good: 'ok', bad: 'crit', na: '', unrated: '' };
const SCORE_RU = { good: 'Доволен', bad: 'Не доволен', na: 'Не применимо', unrated: 'Не оценено' };

const CRITERIA = [
    ['registrar', 'Регистратура', 'registrar_name', 'score_registrar'],
    ['cashier',   'Касса',        'cashier_name',   'score_cashier'],
    ['doctor',    'Врач',         'doctor_name',    'score_doctor'],
];

const PERIODS = [['today', 'Сегодня'], ['week', 'Эта неделя'], ['30', '30 дней'], ['custom', 'Свой период']];

// Период по умолчанию — 30 дней. «Сегодня» на этой доске ВСЕГДА пусто: карточка
// появляется на следующий день после визита. Открывать рабочее место на заведомо
// пустом экране значит показать поломку там, где её нет.
const state = { period: '30', from: '', to: '', search: '', rows: [], editable: false };

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtD = (iso) => (iso || '').slice(0, 10).split('-').reverse().join('.');
const money = (n) => (Number(n) || 0).toLocaleString('ru-RU');

// Границы периода — местные сутки, как в CRM: клиника считает календарными
// днями, а не окнами по 24 часа.
function bounds() {
    if (state.period === 'custom') return { from: state.from, to: state.to };
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const to = ymd(new Date());
    if (state.period === 'today') return { from: ymd(d), to };
    if (state.period === 'week') {
        // Неделя с ПОНЕДЕЛЬНИКА: getDay() считает воскресенье нулём, иначе в
        // воскресенье «эта неделя» показала бы один день.
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return { from: ymd(d), to };
    }
    d.setDate(d.getDate() - 29);
    return { from: ymd(d), to };
}

export async function openCustDev() {
    if (state.period === 'custom' && !state.from && !state.to) {
        const now = new Date();
        state.from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        state.to = ymd(now);
    }
    state.editable = canEdit('custdev');

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

    const body = h('div', { class: 'modal-body', style: { minHeight: '300px' } });
    const filters = h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' } });

    overlay.appendChild(h('div', {
        class: 'modal-card',
        style: { width: 'calc(100vw - 48px)', maxWidth: '1600px', height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' },
    },
        h('header', { class: 'modal-head' },
            h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
                h('span', { style: { width: '34px', height: '34px', borderRadius: '10px', background: 'var(--teal-50, #e0f2f1)', color: 'var(--teal-700, #00796b)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                    Icon('PhoneOut', { size: 17 })),
                h('div', null,
                    h('h2', { style: { margin: 0, fontSize: '15px' } }, 'Cust Dev · Обзвон пациентов'),
                    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '1px' } },
                        state.editable
                            ? 'Пришли и оплатили: спросите про регистратуру, кассу и врача'
                            : 'Доступ «Только просмотр»: оценивать карточки нельзя'))),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { style: { padding: '12px 20px 0' } }, filters),
        body));

    document.body.appendChild(overlay);
    paintFilters();
    await reload();

    function paintFilters() {
        clear(filters);
        const chip = (on, label, onclick) => h('button', { class: 'wzc-cat' + (on ? ' on' : ''), type: 'button', onclick }, label);

        const search = h('input', {
            class: 'crm-search', type: 'search', placeholder: 'Поиск по имени или телефону…', value: state.search,
            style: { width: '260px', height: '36px', padding: '0 12px', border: '1px solid var(--ink-200, #d1d5db)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13px' },
        });
        search.addEventListener('input', () => { state.search = search.value; paintBoard(); });
        filters.appendChild(search);

        const per = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
        for (const [key, label] of PERIODS) {
            per.appendChild(chip(state.period === key, label, () => {
                if (key === 'custom' && !state.from && !state.to) {
                    const now = new Date();
                    state.from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
                    state.to = ymd(now);
                }
                state.period = key;
                paintFilters();
                reload();
            }));
        }
        if (state.period === 'custom') {
            const box = h('div', { class: 'crm-range' });
            const inp = (value, onchange) => {
                const el = h('input', { type: 'date', value: value || '' });
                el.addEventListener('change', () => { onchange(el.value); reload(); });
                return el;
            };
            box.appendChild(h('span', { class: 'lbl' }, 'с'));
            box.appendChild(inp(state.from, (v) => { state.from = v; }));
            box.appendChild(h('span', { class: 'lbl' }, 'по'));
            box.appendChild(inp(state.to, (v) => { state.to = v; }));
            per.appendChild(box);
        }
        filters.appendChild(per);

        filters.appendChild(h('span', { class: 'grow', style: { flex: 1 } }));
        filters.appendChild(h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => reportModal() },
            Icon('Chart', { size: 13 }), ' Отчёт'));
        filters.appendChild(h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => exportExcel() },
            Icon('Download', { size: 13 }), ' Excel'));
    }

    async function reload() {
        const b = bounds();
        if (!b.from || !b.to) { state.rows = []; paintBoard(); return; }

        // Сначала досоздаём карточки, потом читаем. Ошибку синхронизации ГЛОТАЕМ:
        // у клиники с просроченной лицензией custdev_sync — запись и вернёт 402,
        // но уже созданные карточки читаться должны, иначе «только чтение»
        // превратилось бы в пустой экран.
        try { await supabase.rpc('custdev_sync', b); } catch (e) { /* фоновая автоматика — молча */ }

        try {
            state.rows = await supabase.rpc('custdev_list', b) || [];
        } catch (e) {
            toast('Не удалось загрузить карточки: ' + ((e && e.message) || e), 'fail');
            state.rows = [];
        }
        paintBoard();
    }

    function filtered() {
        const q = state.search.trim().toLowerCase();
        if (!q) return state.rows;
        return state.rows.filter(r => (r.patient_name || '').toLowerCase().includes(q) || (r.phone || '').includes(q));
    }

    function paintBoard() {
        clear(body);
        const rows = filtered();
        const board = h('div', { 'data-cd-board': '', style: { display: 'grid', gridTemplateColumns: `repeat(${STATUSES.length}, minmax(230px, 1fr))`, gap: '12px', overflowX: 'auto', paddingBottom: '6px' } });

        for (const [key, label, kind] of STATUSES) {
            const colRows = rows.filter(r => r.status === key);
            const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '60px', padding: '4px' } });
            for (const r of colRows) list.appendChild(cardEl(r));

            board.appendChild(h('div', {
                class: 'card', 'data-col': key,
                style: { padding: '10px 12px', background: 'var(--ink-25, #f8fafa)' },
            },
                h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
                    Tag(label, { kind, dot: true }),
                    h('span', { class: 'muted', style: { fontSize: '12px', fontWeight: 700 } }, String(colRows.length))),
                list));
        }

        if (!rows.length) {
            body.appendChild(h('p', { class: 'muted', style: { padding: '20px 0' } },
                'За выбранный период обзванивать некого. Карточка появляется на следующий день после оплаченного визита.'));
        }
        body.appendChild(board);
    }

    function cardEl(r) {
        const line = (...kids) => h('div', { style: { fontSize: '12.5px', marginTop: '4px', overflowWrap: 'anywhere' } }, ...kids);

        const scores = h('div', { class: 'row', style: { gap: '4px', marginTop: '8px', flexWrap: 'wrap' } });
        for (const [, label, , col] of CRITERIA) {
            scores.appendChild(Tag(label.slice(0, 4) + ': ' + SCORE_RU[r[col]], { kind: SCORE_TAG[r[col]] || '' }));
        }

        const card = h('div', {
            style: { background: 'var(--white, #fff)', border: '1px solid var(--ink-100)', borderRadius: '10px', padding: '10px 12px', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', touchAction: 'none', userSelect: 'none' },
            onclick: () => rateModal(r),
        },
            h('div', { class: 'row', style: { gap: '6px', alignItems: 'baseline' } },
                h('span', { style: { flex: 1, minWidth: 0, fontWeight: 700, fontSize: '13px', overflowWrap: 'anywhere' } }, r.patient_name || '—'),
                h('span', { class: 'muted', style: { fontSize: '11px', whiteSpace: 'nowrap' } }, fmtD(r.visit_date))),
            line(h('span', { class: 'num' }, r.phone || '—')),
            r.mrn ? line(Tag(r.mrn, { kind: 'ok' })) : null,
            line(h('span', { class: 'muted' }, 'Оплачено: '), money(r.paid_amount), ' сум'),
            line(h('span', { class: 'muted' }, 'Врач: '), r.doctor_name || '—'),
            line(h('span', { class: 'muted' }, 'Касса: '), r.cashier_name || '—'),
            line(h('span', { class: 'muted' }, 'Регистратура: '), r.registrar_name || '—'),
            scores,
            r.comment ? line(h('span', { class: 'muted' }, r.comment)) : null);

        if (state.editable && MANUAL.includes(r.status)) attachDrag(card, r);
        return card;
    }

    // Перетаскивание на pointer-событиях — как в CRM (HTML5 DnD там часто вовсе
    // не стартовал). Разрешено ТОЛЬКО между двумя ручными колонками.
    function attachDrag(card, r) {
        card.style.cursor = 'grab';
        card.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 && ev.pointerType === 'mouse') return;
            if (ev.target.closest('button, select, input, a')) return;
            try { card.setPointerCapture(ev.pointerId); } catch (e) { /* не критично */ }

            const startX = ev.clientX, startY = ev.clientY;
            let ghost = null, overCol = null, dx = 0, dy = 0;

            const mark = (col) => {
                if (overCol === col) return;
                if (overCol) overCol.style.outline = 'none';
                overCol = col;
                // Подсвечиваем только те колонки, куда бросить МОЖНО.
                if (overCol && MANUAL.includes(overCol.dataset.col)) {
                    overCol.style.outline = '2px dashed var(--primary-300, #7fcbb8)';
                } else {
                    overCol = null;
                }
            };
            const onMove = (mv) => {
                if (!ghost) {
                    if (Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 7) return;
                    const rect = card.getBoundingClientRect();
                    dx = startX - rect.left; dy = startY - rect.top;
                    ghost = card.cloneNode(true);
                    Object.assign(ghost.style, { position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', margin: '0', zIndex: '9999', pointerEvents: 'none', boxShadow: '0 12px 28px rgba(0,0,0,0.2)', transform: 'rotate(2deg)', opacity: '0.95' });
                    document.body.appendChild(ghost);
                    card.style.opacity = '0.35';
                }
                ghost.style.left = (mv.clientX - dx) + 'px';
                ghost.style.top = (mv.clientY - dy) + 'px';
                const under = document.elementFromPoint(mv.clientX, mv.clientY);
                mark(under ? under.closest('[data-col]') : null);
                mv.preventDefault();
            };
            const cleanup = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', cleanup);
                card.style.cursor = 'grab';
                if (overCol) overCol.style.outline = 'none';
                if (ghost) { ghost.remove(); card.style.opacity = '1'; }
            };
            const onUp = async () => {
                const target = overCol;
                cleanup();
                if (!target || target.dataset.col === r.status) return;
                await mark_(r, target.dataset.col);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', cleanup);
        });
    }

    async function mark_(r, status) {
        try {
            await supabase.rpc('custdev_mark', { card_id: r.id, status });
            await reload();
        } catch (e) {
            toast((e && e.message) || 'Не удалось изменить статус.', 'fail');
        }
    }

    // Попап оценки — Task 8.
    function rateModal(r) { openRate(r, reload, state.editable); }
    // Отчёт и Excel — Task 9.
    function reportModal() { openReport(bounds()); }
    function exportExcel() { toExcel(filtered()); }
}
```

- [ ] **Step 2: Check it parses**

Run: `node --check public/js/admin/views/custdev.js`
Expected: no output. `openRate`, `openReport` and `toExcel` are added in Tasks 8 and 9 — the file
will not RUN correctly until then, but it must parse.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin/views/custdev.js
git commit -m "feat(custdev): the workplace board — five columns, drag only between the manual two"
```

---

## Task 8: The rating popup

**Files:**
- Modify: `public/js/admin/views/custdev.js`

- [ ] **Step 1: Add the rating popup**

Append to `public/js/admin/views/custdev.js`:

```js
// Попап оценки. Открывается поверх рабочего места (z-index выше, как у
// вложенного попапа в CRM), потому что оператор возвращается на доску сразу
// после звонка и терять её позицию незачем.
function openRate(r, onSaved, editable) {
    const ov = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => ov.remove();
    ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });

    // Оценка, уже стоящая на карточке, — стартовое значение. 'unrated'
    // означает «ещё не спрашивали», выбранной кнопки нет.
    const picked = {
        registrar: r.score_registrar === 'unrated' ? '' : r.score_registrar,
        cashier:   r.score_cashier   === 'unrated' ? '' : r.score_cashier,
        doctor:    r.score_doctor    === 'unrated' ? '' : r.score_doctor,
    };

    const comment = h('textarea', {
        rows: 3, placeholder: 'Что сказал пациент',
        style: { width: '100%', fontFamily: 'inherit', fontSize: '13px', padding: '8px 10px', borderRadius: '10px', border: '1px solid var(--ink-200, #d1d5db)' },
    });
    comment.value = r.comment || '';
    comment.disabled = !editable;
    comment.addEventListener('input', syncSave);

    const hint = h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '6px' } });
    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Сохранить');

    const groups = {};
    function groupEl(key, label, who) {
        const row = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } });
        const buttons = {};
        for (const [val, text] of SCORES) {
            const b = h('button', {
                class: 'wzc-cat' + (picked[key] === val ? ' on' : ''), type: 'button',
                disabled: !editable,
                onclick: () => { picked[key] = val; repaint(); },
            }, text);
            buttons[val] = b;
            row.appendChild(b);
        }
        groups[key] = buttons;
        return field(label + (who ? ' · ' + who : ''), row);
    }

    function repaint() {
        for (const [key, buttons] of Object.entries(groups)) {
            for (const [val, b] of Object.entries(buttons)) {
                b.classList.toggle('on', picked[key] === val);
            }
        }
        syncSave();
    }

    // Кнопка «Сохранить» гаснет, пока сохранять нельзя, И говорит почему.
    // Заблокированная кнопка без объяснения читается как поломка.
    function syncSave() {
        if (!editable) { saveBtn.disabled = true; hint.textContent = 'Доступ «Только просмотр».'; return; }
        const vals = [picked.registrar, picked.cashier, picked.doctor];
        if (vals.some(v => !v)) { saveBtn.disabled = true; hint.textContent = 'Оцените все три пункта — или отметьте «Не применимо».'; return; }
        if (vals.every(v => v === 'na')) { saveBtn.disabled = true; hint.textContent = 'Три «Не применимо» оценкой не являются.'; return; }
        if (vals.includes('bad') && !comment.value.trim()) {
            saveBtn.disabled = true;
            hint.textContent = 'Есть «Не доволен» — напишите, что именно не устроило.';
            return;
        }
        saveBtn.disabled = false;
        hint.textContent = '';
    }

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
            await supabase.rpc('custdev_rate', {
                card_id: r.id, registrar: picked.registrar, cashier: picked.cashier,
                doctor: picked.doctor, comment: comment.value,
            });
            toast('Оценка сохранена.', 'ok');
            close();
            await onSaved();
        } catch (e) {
            // Сервер считает то же правило и его отказ — источник истины.
            toast((e && e.message) || 'Не удалось сохранить оценку.', 'fail');
            syncSave();
        }
    });

    const noAnswer = h('button', { class: 'btn btn-outline', type: 'button', disabled: !editable },
        Icon('PhoneMissed', { size: 14 }), ' Не дозвонились');
    noAnswer.addEventListener('click', async () => {
        noAnswer.disabled = true;
        try {
            await supabase.rpc('custdev_mark', { card_id: r.id, status: 'unreachable' });
            close();
            await onSaved();
        } catch (e) {
            toast((e && e.message) || 'Не удалось изменить статус.', 'fail');
            noAnswer.disabled = false;
        }
    });

    ov.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '560px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', { style: { margin: 0, fontSize: '15px' } }, r.patient_name || 'Карточка'),
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '1px' } },
                    'Визит ' + fmtD(r.visit_date) + ' · ' + (r.phone || 'телефон не указан'))),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' },
            groupEl('registrar', 'Регистратура', r.registrar_name),
            groupEl('cashier', 'Касса', r.cashier_name),
            groupEl('doctor', 'Врач', r.doctor_name),
            field('Комментарий', comment),
            hint),
        h('footer', { class: 'modal-foot' },
            noAnswer,
            h('span', { class: 'grow', style: { flex: 1 } }),
            h('button', { class: 'btn btn-ghost', type: 'button', onclick: close }, 'Отмена'),
            saveBtn)));

    document.body.appendChild(ov);
    syncSave();
}
```

- [ ] **Step 2: Check it parses**

Run: `node --check public/js/admin/views/custdev.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add public/js/admin/views/custdev.js
git commit -m "feat(custdev): the rating popup — three criteria, comment required on a complaint"
```

---

## Task 9: Report, Excel, and the CRM button

**Files:**
- Modify: `public/js/admin/views/custdev.js`
- Modify: `public/js/admin/views/crm.js:265-271`

- [ ] **Step 1: Add the report and the export**

Append to `public/js/admin/views/custdev.js`:

```js
// Отчёт за период. Считает сервер: доска читает максимум 1000 карточек, а
// отчёт должен отвечать за весь период, а не за то, что поместилось на экран.
async function openReport(b) {
    const ov = h('div', { class: 'modal', style: { zIndex: '160' } });
    const close = () => ov.remove();
    ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });

    const body = h('div', { class: 'modal-body' }, h('p', { class: 'muted' }, 'Считаем…'));
    ov.appendChild(h('div', { class: 'modal-card', style: { width: '860px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' },
            h('h2', { style: { margin: 0, fontSize: '15px' } }, Icon('Chart', { size: 16 }), ' Отчёт по обзвону'),
            h('button', { class: 'modal-close', onclick: close }, '×')),
        body));
    document.body.appendChild(ov);

    let rep;
    try {
        rep = await supabase.rpc('custdev_report', b);
    } catch (e) {
        clear(body);
        body.appendChild(h('p', { class: 'muted' }, 'Не удалось построить отчёт: ' + ((e && e.message) || e)));
        return;
    }

    const kpi = (label, value, sub) => h('div', { class: 'card', style: { padding: '12px 14px', flex: '1 1 150px' } },
        h('div', { class: 'muted', style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
        h('div', { style: { fontSize: '22px', fontWeight: 700, marginTop: '4px' } }, String(value)),
        sub ? h('div', { class: 'muted', style: { fontSize: '11.5px' } }, sub) : null);

    function staffTable(title, rows) {
        if (!rows.length) {
            return h('div', { style: { marginTop: '16px' } },
                h('h3', { style: { fontSize: '13px', margin: '0 0 6px' } }, title),
                h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'Нет оценённых карточек за период.'));
        }
        const tb = h('tbody');
        for (const r of rows) {
            tb.appendChild(h('tr', null,
                h('td', null, r.name || '—'),
                h('td', { style: { textAlign: 'right' } }, String(r.good)),
                h('td', { style: { textAlign: 'right' } }, String(r.bad)),
                h('td', { style: { textAlign: 'right', fontWeight: 700 } }, r.pct + ' %')));
        }
        return h('div', { style: { marginTop: '16px' } },
            h('h3', { style: { fontSize: '13px', margin: '0 0 6px' } }, title),
            h('table', { class: 'table' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Сотрудник'),
                    h('th', { style: { textAlign: 'right' } }, 'Доволен'),
                    h('th', { style: { textAlign: 'right' } }, 'Не доволен'),
                    h('th', { style: { textAlign: 'right' } }, '% довольных'))),
                tb));
    }

    clear(body);
    body.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } },
        'Период: ' + fmtD(b.from) + ' — ' + fmtD(b.to)));
    body.appendChild(h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } },
        kpi('Карточек', rep.total),
        kpi('Обзвонено', rep.called, rep.calledPct + ' %'),
        kpi('Доволен', rep.satisfied),
        kpi('Частично', rep.partial),
        kpi('Недоволен', rep.unsatisfied),
        kpi('Не дозвонились', rep.unreachable)));
    body.appendChild(staffTable('По врачам', rep.byDoctor));
    body.appendChild(staffTable('По кассирам', rep.byCashier));
    body.appendChild(staffTable('По регистраторам', rep.byRegistrar));
}

// Выгрузка тем же вендоренным SheetJS, что в CRM. Никаких CDN.
async function toExcel(rows) {
    if (!rows.length) { toast('Нет карточек для выгрузки.', 'fail'); return; }
    try {
        const XLSX = await import('../../vendor/xlsx-0.20.3.mjs');
        const statusRu = Object.fromEntries(STATUSES.map(([k, l]) => [k, l]));
        const aoa = [
            ['Пациент', 'MRN', 'Дата визита', 'Телефон', 'Оплачено', 'Регистратор', 'Кассир', 'Врач',
             'Регистратура', 'Касса', 'Врач (оценка)', 'Статус', 'Комментарий', 'Кто звонил', 'Когда'],
            ...rows.map(r => [
                r.patient_name || '', r.mrn || '', fmtD(r.visit_date), r.phone || '', Number(r.paid_amount) || 0,
                r.registrar_name || '', r.cashier_name || '', r.doctor_name || '',
                SCORE_RU[r.score_registrar], SCORE_RU[r.score_cashier], SCORE_RU[r.score_doctor],
                statusRu[r.status] || r.status, r.comment || '',
                r.called_by_name || '', (r.called_at || '').replace('T', ' ').slice(0, 16),
            ]),
        ];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 12 },
                       { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 14 },
                       { wch: 14 }, { wch: 18 }, { wch: 34 }, { wch: 18 }, { wch: 16 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Cust Dev');
        XLSX.writeFile(wb, 'custdev.xlsx');
    } catch (e) {
        toast('Не удалось сформировать Excel: ' + ((e && e.message) || e), 'fail');
    }
}
```

- [ ] **Step 2: Add the button to CRM**

In `public/js/admin/views/crm.js`, add near the other view imports at the top:

```js
import { openCustDev } from './custdev.js';           // CUSTDEV_V1 — обзвон после визита
import { canView } from '../permissions.js';          // CUSTDEV_V1 — право на кнопку «Cust Dev»
```

Then in the `page-head-actions` block, immediately after the `viewBtn('list', …)` line:

```js
            // CUSTDEV_V1 — рабочее место обзвона. Отдельное право: заявки ведёт
            // регистратура, а оценки о врачах и кассирах читать ей незачем.
            canView('custdev') ? h('button', { class: 'btn btn-sm btn-outline', type: 'button', onclick: () => openCustDev() },
                Icon('PhoneOut', { size: 13 }), ' Cust Dev') : null,
```

- [ ] **Step 3: Verify the dead-key guard goes green**

Run: `node --test server/db/migrations/055.test.js`
Expected: PASS. Task 6 left this test red on purpose; `canView('custdev')` in `crm.js` is what
turns it green. If it is still red, the gate is not in a file listed in `GATE_SOURCES`.

- [ ] **Step 4: Check both files parse**

Run: `node --check public/js/admin/views/custdev.js && node --check public/js/admin/views/crm.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add public/js/admin/views/custdev.js public/js/admin/views/crm.js
git commit -m "feat(custdev): report, Excel export, and the button next to «Канбан»"
```

---

## Task 10: Full suite and a real look at the screen

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all tests pass.

**Read failures carefully.** CLAUDE.md records a known environmental flake: roughly one run in
three reports 2–3 failures in files that bind a real port and use `fetch`, always
`fetch failed / cause: bad port`, never an assertion failure. That is the flake — re-run. Anything
that is an assertion failure is real. Do not report the suite green off a single run.

- [ ] **Step 2: Start the server and look at it**

Run: `npm start`, open `http://localhost:8000`, log in, open CRM.

Check by hand:
1. The «Cust Dev» button sits next to «Канбан».
2. It opens the workplace; the default period is «30 дней».
3. If the board is empty, that is likely correct — cards need an *arrived* visit with a paid
   invoice dated **before today**. Seed one through the app (register a patient, create a visit,
   invoice it, take payment at the till), then re-open: it will not appear until tomorrow. To see
   a card today, set that visit's date to yesterday in the database.
4. Rate a card 3×«Доволен» → it lands in «Доволен».
5. Rate one «Не доволен» with no comment → «Сохранить» stays disabled and says why.
6. Two «Не доволен» → «Недоволен».
7. Try dragging a card onto «Доволен» → it must NOT accept the drop; «Не дозвонились» must.
8. «Отчёт» shows the three staff tables. «Excel» downloads `custdev.xlsx`.

- [ ] **Step 3: Check the roles screen**

Open «Настройки → Роли», pick any role: «Cust Dev · Обзвон» appears with a level dropdown. Set the
call-centre role to «Только просмотр», reload as that user — the board opens, rating controls are
disabled, and the popup says «Доступ "Только просмотр"».

- [ ] **Step 4: Review the diff before pushing**

Run: `git status && git diff origin/main --stat`
Expected: only the files in the File Structure table. **No `data/`, no `*.db`, no keys.**

- [ ] **Step 5: Stop before anything release-shaped**

Per CLAUDE.md: pushing to GitHub is safe, but **do not tag, publish, or make this visible to
clinics** until the owner approves that specific version. Ask.

---

## Notes carried from the spec

- **90-day backfill.** The first sync in an established clinic creates cards for up to 90 days at
  once. Warn the owner: the board opens with a backlog.
- **Deliberately not built:** attempts counter and call history, a «жалоба разобрана» flag for the
  head of clinic, telephony auto-dial (Binotel, migration 076), and a configurable call delay —
  "next day" is a constant.
- **`paid_amount` is a snapshot.** A refund after the card exists does not change it. That is fine
  for a survey; the card is not a source of truth about money.
