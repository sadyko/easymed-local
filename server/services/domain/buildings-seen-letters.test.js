// V3120_PERF — seenLetters() перешёл с `SELECT DISTINCT sync_origin` на прыжки
// по частичному индексу (миграция 210). Набор зданий в отчётах обязан остаться
// тем же: сравнивается с DISTINCT на тех же данных, и план — поиск по индексу,
// а не чтение таблицы.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { buildingContext, normalizeLetter } from './buildings.js';

const TABLES = ['invoices', 'payments', 'visit_services', 'visits', 'patients', 'lab_results'];

test('здания из данных: тот же набор, что DISTINCT, при любом числе приехавших строк', () => {
  const db = openDb(':memory:'); migrate(db);
  const ins = db.prepare('INSERT INTO patients (full_name, sync_origin) VALUES (?, ?)');
  // Буквы вразнобой, повторы, строчная, пустая, мусор, NULL.
  for (const o of ['B', null, 'C', 'B', 'b', null, 'Z', '', 'zz', 'C', 'B']) ins.run('П ' + o, o);
  // Вторая таблица с частично пересекающимся набором.
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO visits (patient_id, visit_date, sync_origin) VALUES (1, '2026-09-27T05:00:00Z', 'D')").run();
  db.prepare("INSERT INTO visits (patient_id, visit_date, sync_origin) VALUES (1, '2026-09-27T05:00:00Z', 'B')").run();

  const want = new Set();
  for (const t of TABLES) {
    for (const r of db.prepare(`SELECT DISTINCT sync_origin AS s FROM ${t} WHERE sync_origin IS NOT NULL`).all()) {
      const l = normalizeLetter(r.s); if (l) want.add(l);
    }
  }
  const ctx = buildingContext(db);
  const got = new Set(ctx.options.map((o) => o.key).filter((k) => k !== ctx.ownKey));
  assert.deepEqual([...got].sort(), [...want].sort());
  assert.ok(want.has('B') && want.has('C') && want.has('D') && want.has('Z'));
});

test('буквы берутся поиском по частичному индексу, а не чтением таблицы', () => {
  const db = openDb(':memory:'); migrate(db);
  for (const t of TABLES) {
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql LIKE '%(sync_origin)%WHERE sync_origin IS NOT NULL%'").get(t);
    assert.ok(idx, `частичный индекс по sync_origin у ${t}`);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT MIN(sync_origin) FROM ${t} WHERE sync_origin IS NOT NULL AND sync_origin > 'A'`).all()
      .map((r) => r.detail).join(' | ');
    assert.match(plan, /SEARCH .*USING (COVERING )?INDEX idx_\w+_sync_origin/, `${t}: ${plan}`);
  }
});
