// V3120_PERF (мигр. 211) — номер карты выдаётся по индексу, а правило номера
// то же: сравнивается с тем, что выдаёт тот же триггер БЕЗ индекса, на картах
// своих, приехавших от соседа, введённых руками, прошлогодних и мусорных.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const MAX_SQL = `SELECT COALESCE(MAX(CAST(substr(mrn, -5) AS INTEGER)), 0) + 1
                   FROM patients
                  WHERE substr(mrn, -9, 4) = '-' || substr(strftime('%Y','now'), 3, 2) || '-'`;

function seeded() {
  const db = openDb(':memory:');
  migrate(db);
  const yy = db.prepare("SELECT substr(strftime('%Y','now'), 3, 2) y").get().y;
  const prev = String((Number(yy) + 99) % 100).padStart(2, '0');
  const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
  for (const m of [`A-${yy}-00007`, `B-${yy}-00041`, `C-${prev}-99999`, `РУЧН-${yy}-00012`, 'без-формата', `A-${yy}-0000x`]) ins.run('П', m);
  return { db, yy };
}
const register = (db) => {
  const id = db.prepare("INSERT INTO patients (full_name) VALUES ('Новый')").run().lastInsertRowid;
  return db.prepare('SELECT mrn FROM patients WHERE id = ?').get(id).mrn;
};

test('211: номер карты тот же, что без индекса, — и соседские/ручные номера учитываются', () => {
  const a = seeded(); const b = seeded();
  b.db.exec('DROP INDEX idx_patients_mrn_seq');
  const got = [], want = [];
  for (let i = 0; i < 5; i++) { got.push(register(a.db)); want.push(register(b.db)); }
  assert.deepEqual(got, want);
  assert.equal(got[0], `A-${a.yy}-00042`, 'после соседского B-ГГ-00041 — 42, формат прежний');
  // Удалили последнего — номер снова свободен, как и было.
  a.db.prepare('DELETE FROM patients WHERE mrn = ?').run(got[4]);
  b.db.prepare('DELETE FROM patients WHERE mrn = ?').run(want[4]);
  assert.equal(register(a.db), register(b.db));
  a.db.close(); b.db.close();
});

test('211: MAX триггера идёт спуском по индексу, а не перебором карт', () => {
  const { db } = seeded();
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + MAX_SQL).all().map((r) => r.detail).join(' | ');
  assert.match(plan, /SEARCH patients USING COVERING INDEX idx_patients_mrn_seq/, plan);
  const ops = db.prepare('EXPLAIN ' + MAX_SQL).all().map((o) => o.opcode);
  assert.ok(ops.includes('SeekLE') && ops.includes('Prev'), 'MAX берётся с конца диапазона: ' + ops.join(','));
  // Триггер не пересоздавался — его текст тот, что оставила 080.
  const trig = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'patients_mrn_autogen'").get().sql;
  assert.match(trig, /COALESCE\(MAX\(CAST\(substr\(mrn, -5\) AS INTEGER\)\), 0\) \+ 1/);
  db.close();
});
