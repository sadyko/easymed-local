import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile, CompileError } from '../query-compiler.js';

function reshape(rows, meta) {
  if (!meta.embeds || !meta.embeds.length) return rows;
  return rows.map((row) => {
    for (const { name, columns } of meta.embeds) {
      const nested = {}; let allNull = true;
      for (const c of columns) { const v = row[`${name}.${c}`]; nested[c] = v; if (v != null) allNull = false; delete row[`${name}.${c}`]; }
      row[name] = allNull ? null : nested;
    }
    return row;
  });
}

function seed(db) {
  const u = db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES ('reg','x','Rita Reg','registrar')").run().lastInsertRowid;
  const a = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Ann A','A1')").run().lastInsertRowid;
  const b = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Bob B','B1')").run().lastInsertRowid;
  return { u, a, b };
}

test('029 creates patient history tables', () => {
  const db = openDb(':memory:'); migrate(db);
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  assert.ok(have.has('patient_relationships'));
  assert.ok(have.has('patient_activity_log'));
});

test('029 patient_relationships: FK, UNIQUE pair, CHECK, cascade', () => {
  const db = openDb(':memory:'); migrate(db);
  const { a, b } = seed(db);

  db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?,?,'spouse')").run(a, b);
  assert.throws(() => db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?,?,'child')").run(a, b));   // UNIQUE pair
  assert.throws(() => db.prepare("INSERT INTO patient_relationships (patient_id_a, patient_id_b, relation_type) VALUES (?,?,'bogus')").run(b, a));    // CHECK

  db.prepare('DELETE FROM patients WHERE id=?').run(a);   // ON DELETE CASCADE
  assert.equal(db.prepare('SELECT count(*) c FROM patient_relationships').get().c, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('029 patient_activity_log: insert + colon-aliased users embed resolves to nested actor', () => {
  const db = openDb(':memory:'); migrate(db);
  const { u, a } = seed(db);
  db.prepare(`INSERT INTO patient_activity_log (patient_id, action, summary, actor_user_id, actor_name, actor_role)
              VALUES (?, 'invoice.cancel', 'Cancelled invoice #5', ?, 'Rita Reg', 'registrar')`).run(a, u);

  const c = compile({ table: 'patient_activity_log', op: 'select', columns: '*, users:actor_user_id(full_name, role)',
                      filters: [{ col: 'patient_id', op: 'eq', val: a }], order: [{ col: 'created_at', asc: false }], limit: 100 },
                    { id: u, role: 'registrar' });
  assert.match(c.sql, /join/i);
  const rows = reshape(db.prepare(c.sql).all(...c.params), c.meta);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'invoice.cancel');
  assert.equal(rows[0].users.full_name, 'Rita Reg');   // nested under the `users` alias
  assert.equal(rows[0].users.role, 'registrar');
});

test('029 registry: activity log is append-only; relationships writable by registrar', () => {
  const REG = { id: 1, role: 'registrar' };
  // registrar records an event and links patients…
  assert.ok(compile({ table: 'patient_activity_log', op: 'insert', values: { patient_id: 1, action: 'x' } }, REG).sql);
  assert.ok(compile({ table: 'patient_relationships', op: 'insert', values: { patient_id_a: 1, patient_id_b: 2, relation_type: 'sibling' } }, REG).sql);
  // …but nobody may edit or delete the audit trail.
  assert.throws(() => compile({ table: 'patient_activity_log', op: 'update', values: { action: 'y' }, filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG),
    (e) => e instanceof CompileError && e.status === 403);
  assert.throws(() => compile({ table: 'patient_activity_log', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG),
    (e) => e instanceof CompileError && e.status === 403);
});
