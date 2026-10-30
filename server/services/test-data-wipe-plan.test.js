// TEST_DATA_WIPE_V1 — защита от будущих таблиц: каждая таблица базы, собранной
// миграциями, отнесена к «удалять», «оставить», «очистить связь» (или к
// служебным следам связи зданий), и решения не противоречат схеме.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { TABLE_PLAN, WIPE_ORDER, GUARD_TRIGGERS, DELETE_TRIGGERS, tablesBy } from './test-data-wipe-plan.js';

// Одна база на весь файл: схема только читается (временная таблица одной
// проверки живёт внутри SAVEPOINT и откатывается).
let db;
before(() => { db = openDb(':memory:'); migrate(db); });
after(() => { db.close(); });

const tablesOf = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map((r) => r.name);
const fksOf = (d, t) => d.prepare('SELECT "from" AS col, "table" AS parent, on_delete FROM pragma_foreign_key_list(?)').all(t);
const HOWS = new Set(['delete', 'partial', 'clear', 'sync', 'keep']);
const removingIn = (plan) => new Set(Object.keys(plan).filter((t) => plan[t].how === 'delete' || plan[t].how === 'partial'));
const removing = () => removingIn(TABLE_PLAN);

// Ссылки оставшихся строк на удаляемые таблицы, которые план не снимает.
// Внешний ключ сам снимает ссылку только при ON DELETE SET NULL. CASCADE —
// не выход: удаление родителя молча унесло бы и строки таблицы, которую план
// оставляет (дети с решением delete пропущены выше — им и так уходить).
function danglingRefs(d, plan) {
  const gone = removingIn(plan);
  const bad = [];
  for (const t of tablesOf(d)) {
    const p = plan[t];
    if (p.how === 'delete') continue;
    for (const fk of fksOf(d, t)) {
      if (!gone.has(fk.parent)) continue;
      if (fk.on_delete === 'SET NULL') continue;
      if (p.how === 'clear' && new RegExp(`\\b${fk.col} = NULL\\b`).test(p.set)) continue;
      if (p.how === 'partial' && new RegExp(`\\b${fk.col} (IS NOT NULL|IN \\()`).test(p.where)) continue;
      bad.push(`${t}.${fk.col} -> ${fk.parent} (${fk.on_delete})`);
    }
  }
  return bad;
}

test('охват: каждая таблица схемы — ровно одно решение; новая таблица без решения роняет сборку', () => {
  assert.deepEqual(Object.keys(TABLE_PLAN).sort(), tablesOf(db),
    'новая таблица? Решите в server/services/test-data-wipe-plan.js: delete, partial, clear, sync или keep');
});

test('решения заполнены: вид из пяти; у удаляемых — группа; у partial — where; у clear — set и where', () => {
  for (const [t, p] of Object.entries(TABLE_PLAN)) {
    assert.ok(HOWS.has(p.how), `${t}: неизвестное решение ${p.how}`);
    if (p.how === 'delete' || p.how === 'partial' || p.how === 'clear') assert.ok(p.group, `${t}: нет группы для итога`);
    if (p.how === 'partial') assert.ok(p.where, `${t}: partial без where`);
    if (p.how === 'clear') assert.ok(p.set && p.where, `${t}: clear без set/where`);
    if (p.reset) assert.ok(p.reset.set && p.reset.where, `${t}: reset без set/where`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(TABLE_PLAN, 'sqlite_sequence'), false,
    'sqlite_sequence не трогается никогда: от номеров строк зависят штрихкоды проб');
  assert.deepEqual(tablesBy('sync').sort(), ['sync_journal', 'sync_pending', 'sync_refused', 'sync_seen', 'sync_tombstones']);
});

test('порядок шагов — ровно удаляемые, частичные и очищаемые таблицы, каждая один раз', () => {
  const steps = [...tablesBy('delete'), ...tablesBy('partial'), ...tablesBy('clear')].sort();
  assert.deepEqual([...WIPE_ORDER].sort(), steps);
  assert.equal(new Set(WIPE_ORDER).size, WIPE_ORDER.length);
});

test('порядок: ребёнок раньше родителя (единственный цикл — admissions ↔ invoices — под отложенной проверкой)', () => {
  const idx = new Map(WIPE_ORDER.map((t, i) => [t, i]));
  const CYCLE = new Set(['invoices->admissions']);
  const bad = [];
  for (const child of WIPE_ORDER) {
    for (const fk of fksOf(db, child)) {
      if (fk.parent === child || !idx.has(fk.parent) || CYCLE.has(`${child}->${fk.parent}`)) continue;
      if (TABLE_PLAN[fk.parent].how === 'clear') continue;   // очищаемые строки остаются — ссылаться на них можно
      if (idx.get(child) > idx.get(fk.parent)) bad.push(`${child}.${fk.col} -> ${fk.parent}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('оставшиеся строки никогда не указывают на удалённые', () => {
  assert.deepEqual(danglingRefs(db, TABLE_PLAN), [], 'строка остаётся, а её родителя удаление уносит: решите в плане');
});

test('страж ловит каскад: будущая таблица «оставить» с visit_id … ON DELETE CASCADE молча опустела бы', () => {
  db.exec('SAVEPOINT future_table');
  try {
    db.exec(`CREATE TABLE future_notes (
      id INTEGER PRIMARY KEY,
      visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL)`);
    const plan = { ...TABLE_PLAN, future_notes: { how: 'keep', why: 'test' } };
    assert.deepEqual(danglingRefs(db, plan), ['future_notes.visit_id -> visits (CASCADE)']);
  } finally {
    db.exec('ROLLBACK TO future_table; RELEASE future_table');
  }
  assert.deepEqual(Object.keys(TABLE_PLAN).sort(), tablesOf(db), 'временная таблица не откатилась');
});

test('триггеры-запреты удаления на удаляемых таблицах перечислены в GUARD_TRIGGERS и существуют', () => {
  const gone = removing();
  const found = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
    .filter((r) => gone.has(r.tbl_name) && /BEFORE\s+DELETE/i.test(r.sql) && /RAISE\s*\(/i.test(r.sql))
    .map((r) => `${r.tbl_name}.${r.name}`).sort();
  const listed = Object.entries(GUARD_TRIGGERS).flatMap(([t, names]) => names.map((n) => `${t}.${n}`)).sort();
  assert.deepEqual(listed, found);
});

// Событие в заголовке триггера (до, после или вместо) — не в его теле.
const HEAD = String.raw`^\s*CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+(?:BEFORE\s+|AFTER\s+|INSTEAD\s+OF\s+)?`;
const ON_DELETE_EVENT = new RegExp(HEAD + String.raw`DELETE\s+ON\s`, 'i');
const ON_UPDATE_EVENT = new RegExp(HEAD + String.raw`UPDATE\s+(?:OF\s+([\s\S]+?)\s+)?ON\s`, 'i');
const triggersOf = (d) => d.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name").all();
const unquote = (c) => c.trim().replace(/^["`[]|["`\]]$/g, '');

// Триггеры, которые сработают от самих удалений (DELETE на удаляемых таблицах).
const deleteTriggersOf = (d) => {
  const gone = removing();
  return triggersOf(d).filter((r) => gone.has(r.tbl_name) && ON_DELETE_EVENT.test(r.sql))
    .map((r) => `${r.tbl_name}.${r.name}`).sort();
};

// Колонки, которые удаление меняет у оставшихся строк (clear.set, reset.set),
// и UPDATE-триггеры, которые на них сработают: без OF — на любую колонку,
// с OF — если в списке есть сбрасываемая колонка.
const resetColumns = () => {
  const cols = new Map();
  for (const [t, p] of Object.entries(TABLE_PLAN)) {
    const sets = [p.how === 'clear' ? p.set : null, p.reset ? p.reset.set : null].filter(Boolean);
    if (sets.length) cols.set(t, new Set(sets.flatMap((s) => [...s.matchAll(/(?:^|,)\s*([^\s,=]+)\s*=/g)].map((m) => unquote(m[1])))));
  }
  return cols;
};
const resetUpdateTriggersOf = (d) => {
  const cols = resetColumns();
  const fired = [];
  for (const r of triggersOf(d)) {
    const m = cols.has(r.tbl_name) && r.sql.match(ON_UPDATE_EVENT);
    if (!m) continue;
    const of = m[1] ? m[1].split(',').map(unquote) : null;
    if (!of || of.some((c) => cols.get(r.tbl_name).has(c))) {
      fired.push(`${r.tbl_name}.${r.name}${/RAISE\s*\(/i.test(r.sql) ? ' (RAISE)' : ''}`);
    }
  }
  return fired;
};

test('все триггеры, которые срабатывают от удаления, перечислены в DELETE_TRIGGERS (запреты — среди них)', () => {
  const listed = Object.entries(DELETE_TRIGGERS).flatMap(([t, names]) => names.map((n) => `${t}.${n}`)).sort();
  assert.deepEqual(listed, deleteTriggersOf(db),
    'новый триггер на удаляемой таблице: проверьте, куда он пишет во время удаления, и впишите его в DELETE_TRIGGERS');
  for (const [t, names] of Object.entries(GUARD_TRIGGERS)) {
    for (const n of names) assert.ok((DELETE_TRIGGERS[t] || []).includes(n), `${t}.${n}: запрет не в DELETE_TRIGGERS`);
  }
});

test('сброс у оставшихся строк (clear, reset) не будит UPDATE-триггеров: ни запрета, ни записи в другие таблицы', () => {
  assert.deepEqual([...resetColumns().keys()].sort(), ['beds', 'crm_request_services', 'patient_discounts', 'products']);
  assert.deepEqual(resetUpdateTriggersOf(db), [],
    'UPDATE-триггер на сбрасываемой колонке: запрет (RAISE) остановит удаление, запись уйдёт мимо плана — решите в плане');
});

test('страж ловит новые триггеры: AFTER DELETE на visits и запрет на сбрасываемой колонке products', () => {
  db.exec('SAVEPOINT future_triggers');
  try {
    db.exec(`CREATE TRIGGER visits_future_touch AFTER DELETE ON visits BEGIN DELETE FROM crm_tags WHERE 0; END;
             CREATE TRIGGER products_future_lock BEFORE UPDATE OF on_hand ON products
               BEGIN SELECT RAISE(ABORT, 'нельзя'); END;
             CREATE TRIGGER products_future_other BEFORE UPDATE OF name ON products
               BEGIN SELECT RAISE(ABORT, 'нельзя'); END;`);
    assert.ok(deleteTriggersOf(db).includes('visits.visits_future_touch'));
    assert.deepEqual(resetUpdateTriggersOf(db), ['products.products_future_lock (RAISE)']);
  } finally {
    db.exec('ROLLBACK TO future_triggers; RELEASE future_triggers');
  }
  assert.deepEqual(resetUpdateTriggersOf(db), [], 'временные триггеры не откатились');
});

test('порядок: частичные удаления смотрят на ещё живые строки — patient_activity_log раньше visits, api_outbox раньше api_requests', () => {
  const at = (t) => WIPE_ORDER.indexOf(t);
  // visit_id IS NOT NULL: визит, удалённый раньше, обнулил бы ссылку
  // (ON DELETE SET NULL), и запись о нём осталась бы.
  assert.ok(at('patient_activity_log') < at('visits'), 'patient_activity_log идёт после visits');
  // Подзапрос к api_requests: после удаления броней он пуст — их исходящие остались бы.
  assert.ok(at('api_outbox') < at('api_requests'), 'api_outbox идёт после api_requests');
  // И в общем виде: таблица из подзапроса условия уходит позже того, кто в неё смотрит.
  const gone = removing();
  for (const [t, p] of Object.entries(TABLE_PLAN)) {
    for (const w of [p.where, p.reset && p.reset.where]) {
      for (const [, from] of String(w || '').matchAll(/\bFROM\s+(\w+)/gi)) {
        if (gone.has(from) && from !== t) assert.ok(at(t) < at(from), `${t}: условие смотрит в ${from}, а ${from} уходит раньше`);
      }
    }
  }
});
