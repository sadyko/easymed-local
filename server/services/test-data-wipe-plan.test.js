// TEST_DATA_WIPE_V1 — защита от будущих таблиц: каждая таблица базы, собранной
// миграциями, отнесена к «удалять», «оставить», «очистить связь» (или к
// служебным следам связи зданий), и решения не противоречат схеме.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { TABLE_PLAN, WIPE_ORDER, GUARD_TRIGGERS, tablesBy } from './test-data-wipe-plan.js';

function schema() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map((r) => r.name);
const fksOf = (db, t) => db.prepare('SELECT "from" AS col, "table" AS parent, on_delete FROM pragma_foreign_key_list(?)').all(t);
const HOWS = new Set(['delete', 'partial', 'clear', 'sync', 'keep']);
const removing = () => new Set([...tablesBy('delete'), ...tablesBy('partial')]);

test('охват: каждая таблица схемы — ровно одно решение; новая таблица без решения роняет сборку', () => {
  const db = schema();
  try {
    assert.deepEqual(Object.keys(TABLE_PLAN).sort(), tablesOf(db),
      'новая таблица? Решите в server/services/test-data-wipe-plan.js: delete, partial, clear, sync или keep');
  } finally { db.close(); }
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
  const db = schema();
  try {
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
  } finally { db.close(); }
});

test('оставшиеся строки никогда не указывают на удалённые', () => {
  const db = schema();
  try {
    const gone = removing();
    const bad = [];
    for (const t of tablesOf(db)) {
      const p = TABLE_PLAN[t];
      if (p.how === 'delete') continue;
      for (const fk of fksOf(db, t)) {
        if (!gone.has(fk.parent)) continue;
        if (fk.on_delete === 'SET NULL' || fk.on_delete === 'CASCADE') continue;
        if (p.how === 'clear' && new RegExp(`\\b${fk.col} = NULL\\b`).test(p.set)) continue;
        if (p.how === 'partial' && new RegExp(`\\b${fk.col} (IS NOT NULL|IN \\()`).test(p.where)) continue;
        bad.push(`${t}.${fk.col} -> ${fk.parent} (${fk.on_delete})`);
      }
    }
    assert.deepEqual(bad, [], 'строка остаётся, а её родителя удаление уносит: решите в плане');
  } finally { db.close(); }
});

test('триггеры-запреты удаления на удаляемых таблицах перечислены в GUARD_TRIGGERS и существуют', () => {
  const db = schema();
  try {
    const gone = removing();
    const found = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
      .filter((r) => gone.has(r.tbl_name) && /BEFORE\s+DELETE/i.test(r.sql) && /RAISE\s*\(/i.test(r.sql))
      .map((r) => `${r.tbl_name}.${r.name}`).sort();
    const listed = Object.entries(GUARD_TRIGGERS).flatMap(([t, names]) => names.map((n) => `${t}.${n}`)).sort();
    assert.deepEqual(listed, found);
  } finally { db.close(); }
});
