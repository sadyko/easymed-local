// MRN_BEYOND_99999_V1 (ревью 1) — сортировка «MRN» в реестре пациентов идёт по
// номеру, а не по тексту.
//
// Реестр (public/js/admin/data.js, loadPatientsPaged, sort 'mrn') просит
// .order('mrn'). Текстом после 99 999 порядок ломается: A-26-09999, A-26-10000,
// A-26-100000, A-26-100001, A-26-10001… Теперь для patients.mrn реестр схемы
// (schema-registry.js, patients.order) даёт три ключа того же правила, что у
// триггера номера (миграция 232): окно года после первого дефиса, номер целиком
// после второго, потом сам mrn. Первые два — выражения индекса
// idx_patients_mrn_seq, поэтому страница из 30 строк берётся по индексу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { compile } from './query-compiler.js';
import { readOrder } from './schema-registry.js';

const REGISTRAR = { role: 'registrar', id: 1 };
const MRNS = ['A-26-10001', 'A-26-100001', 'A-26-09999', 'P-25-120000', 'A-26-100000', 'A-26-10000', 'P-26-10000', 'без-формата'];

function seeded(extra = 0) {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO patients (full_name, mrn) VALUES (?, ?)');
  db.transaction(() => {
    for (const m of MRNS) ins.run('Пациент ' + m, m);
    for (let n = 1; n <= extra; n++) ins.run('Легаси', 'P-26-' + String(n).padStart(5, '0'));
  })();
  return db;
}
const listSql = (db, asc, limit = 100) =>
  compile({ table: 'patients', op: 'select', columns: 'id,mrn', order: [{ col: 'mrn', asc }], limit }, REGISTRAR, { db });
const listed = (db, asc) => { const { sql, params } = listSql(db, asc); return db.prepare(sql).all(...params).map((r) => r.mrn); };

test('реестр: «MRN» по возрастанию — год, номер целиком, потом сам номер карты', () => {
  const db = seeded();
  assert.deepEqual(listed(db, true), [
    'P-25-120000',                               // год раньше — раньше, хоть номер и больше
    'A-26-09999', 'A-26-10000', 'P-26-10000',    // равный номер — по самому mrn
    'A-26-10001', 'A-26-100000', 'A-26-100001',  // 100000 — ПОСЛЕ 10001, а не между 10000 и 10001
    'без-формата',                               // не по форме — после
  ]);
  db.close();
});

test('реестр: «MRN» по убыванию — тот же порядок наоборот, все три ключа', () => {
  const db = seeded();
  assert.deepEqual(listed(db, false), [...listed(db, true)].reverse());
  db.close();
});

test('реестр: ключи «MRN» — только для patients.mrn; прочие колонки сортируются как были', () => {
  assert.equal(readOrder('patients', 'created_at'), null);
  assert.equal(readOrder('visits', 'mrn'), null);
  const keys = readOrder('patients', 'mrn');
  assert.equal(keys.length, 3);
  const { sql } = compile({ table: 'patients', op: 'select', columns: 'id', order: [{ col: 'created_at', asc: false }] }, REGISTRAR);
  assert.match(sql, /ORDER BY "patients"\."created_at" DESC$/);
  const byMrn = listSql(null, false).sql;
  assert.match(byMrn, /ORDER BY substr\("patients"\."mrn", instr\("patients"\."mrn", '-'\), 4\) DESC, CAST\(substr\("patients"\."mrn", instr\("patients"\."mrn", '-'\) \+ 4\) AS INTEGER\) DESC, "patients"\."mrn" DESC/);
});

test('реестр: страница по «MRN» идёт по индексу номера карты, а не сортировкой всей базы', () => {
  const db = seeded(5000);
  db.exec('ANALYZE');
  const { sql, params } = listSql(db, true, 30);
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_patients_mrn_seq/, plan);
  assert.doesNotMatch(plan, /USE TEMP B-TREE FOR ORDER BY/, 'сортировка всей базы: ' + plan);
  db.close();
});
