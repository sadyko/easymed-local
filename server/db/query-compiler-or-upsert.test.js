import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, CompileError } from './query-compiler.js';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

const REG = { role: 'registrar', id: 1 };

function seedRel() {
  const db = openDb(':memory:'); migrate(db);
  const a = db.prepare("INSERT INTO patients (full_name) VALUES ('A')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO patients (full_name) VALUES ('B')").run().lastInsertRowid;
  const c = db.prepare("INSERT INTO patients (full_name) VALUES ('C')").run().lastInsertRowid;
  db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?,?,'spouse')").run(a, b);
  return { db, a, b, c };
}

// ---- .or() ------------------------------------------------------------------
test('.or() compiles to a parenthesised OR group and matches either side', () => {
  const { db, a, c } = seedRel();
  const q = compile({ table: 'patient_relationships', op: 'select', columns: '*',
    filters: [{ or: [{ col: 'patient_id_a', op: 'eq', val: a }, { col: 'patient_id_b', op: 'eq', val: a }] }] }, REG);
  assert.match(q.sql, /\("patient_relationships"\."patient_id_a" = \? OR "patient_relationships"\."patient_id_b" = \?\)/);
  assert.equal(db.prepare(q.sql).all(...q.params).length, 1);

  const q2 = compile({ table: 'patient_relationships', op: 'select', columns: '*',
    filters: [{ or: [{ col: 'patient_id_a', op: 'eq', val: c }, { col: 'patient_id_b', op: 'eq', val: c }] }] }, REG);
  assert.equal(db.prepare(q2.sql).all(...q2.params).length, 0);   // c is on neither side
});

test('.or() supports in terms alongside a plain filter (AND of the group)', () => {
  const { db, a } = seedRel();
  const q = compile({ table: 'patient_relationships', op: 'select', columns: '*',
    filters: [{ col: 'patient_id_a', op: 'eq', val: a },
              { or: [{ col: 'patient_id_a', op: 'in', val: [a, 999] }, { col: 'patient_id_b', op: 'eq', val: 999 }] }] }, REG);
  assert.match(q.sql, /"patient_relationships"\."patient_id_a" = \? AND \("patient_relationships"\."patient_id_a" IN \(\?, \?\) OR/);
  assert.equal(db.prepare(q.sql).all(...q.params).length, 1);
});

test('.or() drops tenancy-only groups (collapses to no WHERE) but still validates real unknowns', () => {
  const q = compile({ table: 'products', op: 'select', columns: 'id',
    filters: [{ or: [{ col: 'company_id', op: 'is', val: null }, { col: 'company_id', op: 'eq', val: 1 }] }] }, REG);
  assert.doesNotMatch(q.sql, /WHERE/);
  assert.throws(() => compile({ table: 'patient_relationships', op: 'select', columns: '*',
    filters: [{ or: [{ col: 'ssn', op: 'eq', val: 1 }] }] }, REG), /filter/);
});

// ---- upsert -----------------------------------------------------------------
test('upsert inserts then updates on the tenancy-stripped conflict target', () => {
  const { db, a, b } = seedRel();
  const base = { table: 'patient_relationships', op: 'upsert', onConflict: 'company_id,patient_id_a,patient_id_b' };
  const c1 = compile({ ...base, values: { patient_id_a: a, patient_id_b: b, relation_type: 'sibling' } }, REG);
  assert.match(c1.sql, /ON CONFLICT \("patient_id_a", "patient_id_b"\) DO UPDATE SET "relation_type" = excluded\."relation_type"/);
  db.prepare(c1.sql).run(...c1.params);   // updates the existing (a,b) row
  const c2 = compile({ ...base, values: { patient_id_a: a, patient_id_b: b, relation_type: 'parent' } }, REG);
  db.prepare(c2.sql).run(...c2.params);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_relationships').get().n, 1);   // no duplicate
  assert.equal(db.prepare('SELECT relation_type FROM patient_relationships').get().relation_type, 'parent');
});

test('upsert needs both insert+update perms, and a non-empty conflict target', () => {
  // patient_activity_log: insert allowed for all staff, update denied -> 403
  assert.throws(() => compile({ table: 'patient_activity_log', op: 'upsert', values: { patient_id: 1, action: 'x' }, onConflict: 'id' }, REG),
    (e) => e instanceof CompileError && e.status === 403);
  // a target of only tenancy columns leaves nothing to conflict on -> 400
  assert.throws(() => compile({ table: 'patient_relationships', op: 'upsert', values: { patient_id_a: 1, patient_id_b: 2, relation_type: 'other' }, onConflict: 'company_id' }, REG),
    /onConflict/);
});

test('upsert accepts an array of rows with ignoreDuplicates -> multi-row INSERT ... DO NOTHING', () => {
  const { db, a, b, c } = seedRel();   // (a,b) spouse already exists
  const rows = [
    { patient_id_a: a, patient_id_b: b, relation_type: 'sibling' },   // conflicts with existing (a,b)
    { patient_id_a: a, patient_id_b: c, relation_type: 'parent' },    // new pair
  ];
  const cc = compile({ table: 'patient_relationships', op: 'upsert', values: rows, onConflict: 'company_id,patient_id_a,patient_id_b', ignoreDuplicates: true }, REG);
  assert.match(cc.sql, /VALUES \(\?, \?, \?\), \(\?, \?, \?\) ON CONFLICT \("patient_id_a", "patient_id_b"\) DO NOTHING/);
  assert.equal(cc.meta.multi, true);
  db.prepare(cc.sql).run(...cc.params);
  // the existing pair kept its original type (DO NOTHING), the new pair was added
  assert.equal(db.prepare('SELECT relation_type FROM patient_relationships WHERE patient_id_a=? AND patient_id_b=?').get(a, b).relation_type, 'spouse');
  assert.ok(db.prepare('SELECT 1 FROM patient_relationships WHERE patient_id_a=? AND patient_id_b=?').get(a, c));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patient_relationships').get().n, 2);
});

// ---- .not() -----------------------------------------------------------------
// Supabase negation, encoded by the client as op 'not.<op>'. The queue's
// `.not('doctor_id','is',null)` (IS NOT NULL) and the cashier's
// `.not('status','in','("void","refunded")')` (string-form NOT IN) both land here.
test('.not() negates is-null and string-form in lists, and executes', () => {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, specialty) VALUES (2,'d','x','Doc','doctor',1,'')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1,1,'2026-08-07','confirmed')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'S',100)").run();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (1,1,2,1,100,100,'queued')").run();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (1,1,NULL,1,100,100,'queued')").run();
  db.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES (1,1,2,1,100,100,'cancelled')").run();

  // IS NOT NULL — only assigned rows
  const q1 = compile({ table: 'visit_services', op: 'select', columns: 'id, doctor_id',
    filters: [{ col: 'doctor_id', op: 'not.is', val: null }] }, REG);
  assert.match(q1.sql, /NOT \("visit_services"\."doctor_id" IS \?\)/);
  assert.equal(db.prepare(q1.sql).all(...q1.params).length, 2);

  // string-form NOT IN — drops the cancelled row
  const q2 = compile({ table: 'visit_services', op: 'select', columns: 'id, status',
    filters: [{ col: 'status', op: 'not.in', val: '("cancelled","void")' }] }, REG);
  assert.equal(db.prepare(q2.sql).all(...q2.params).length, 2);

  // array-form .in() still works alongside
  const q3 = compile({ table: 'visit_services', op: 'select', columns: 'id',
    filters: [{ col: 'status', op: 'in', val: ['queued'] }] }, REG);
  assert.equal(db.prepare(q3.sql).all(...q3.params).length, 2);

  // unknown inner op is still rejected
  assert.throws(() => compile({ table: 'visit_services', op: 'select', columns: 'id',
    filters: [{ col: 'status', op: 'not.bogus', val: 1 }] }, REG), /unsupported operator/);
});
