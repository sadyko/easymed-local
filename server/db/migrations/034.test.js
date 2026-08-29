import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { compile } from '../query-compiler.js';

const ADMIN = { id: 1, role: 'admin' };
const REG = { id: 1, role: 'registrar' };

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('034 patients has the Settings-section columns', () => {
  const db = freshDb();
  const cols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
  for (const c of ['marital_status', 'emergency_contact_relation', 'payer_policy_id', 'insurance_policy_number', 'insurance_expiry_date']) {
    assert.ok(cols.includes(c), 'patients.' + c);
  }
});

test('034 batch insert: importer array shape — ragged keys keep DB defaults', () => {
  const db = freshDb();
  // section-import-export.js inserts arrays (batches of 100) and deliberately
  // leaves empty cells OUT of the payload "so the DB default fires". The
  // compiler must therefore emit one statement per row, not a uniform
  // multi-row VALUES that would bind NULL over the defaults.
  const rows = [
    { full_name: 'Иванов Иван', phone: '+998901112233', mrn: 'P-26-00001', gender: 'male', active: true },
    { full_name: 'Петрова Анна', date_of_birth: '1990-02-03', marital_status: 'married' },   // no phone/gender
  ];
  const c = compile({ table: 'patients', op: 'insert', values: rows }, REG);
  assert.equal(c.meta.multi, true);
  assert.equal(c.statements.length, 2);
  db.transaction(() => { for (const st of c.statements) db.prepare(st.sql).run(...st.params); })();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, 2);
  assert.equal(db.prepare("SELECT mrn FROM patients WHERE full_name='Иванов Иван'").get().mrn, 'P-26-00001');
  const anna = db.prepare("SELECT phone, gender, marital_status, mrn FROM patients WHERE full_name='Петрова Анна'").get();
  assert.equal(anna.marital_status, 'married');
  assert.equal(anna.phone, '');          // DB default fired, not NULL
  assert.equal(anna.gender, 'other');    // NOT NULL DEFAULT survived the batch
  // MAX+1 autogen — no collision with the imported P-26-00001. The prefix is
  // 'A' and not 'P' since 080_branch_identity: the number now carries this
  // install's branch letter, and the legacy 'P-' row still counts towards MAX,
  // which is exactly what keeps 00002 from being handed out twice.
  assert.equal(anna.mrn, 'A-26-00002');

  // single-object insert unchanged (returning path intact)
  const c1 = compile({ table: 'patients', op: 'insert', values: { full_name: 'X' }, returning: true, single: 'single' }, REG);
  assert.equal(c1.meta.multi, false);
  assert.match(c1.sql, /VALUES \(\?\)$/);
});

test('034 patients section round-trip: new form fields write and read back', () => {
  const db = freshDb();
  db.prepare("INSERT INTO payers (id, name) VALUES (1,'UzMed Insurance')").run();
  db.prepare("INSERT INTO payer_policies (id, name, payer_id) VALUES (1,'Standard',1)").run();
  const ins = compile({ table: 'patients', op: 'insert', values: {
    full_name: 'Тестова Пациентка', mrn: 'P-26-99999', marital_status: 'single',
    emergency_contact_relation: 'сестра', payer_id: 1, payer_policy_id: 1,
    insurance_policy_number: 'POL-123', insurance_expiry_date: '2027-01-01',
    registration_date: '2026-08-07', active: true,
  } }, ADMIN);
  db.prepare(ins.sql).run(...ins.params);
  const sel = compile({ table: 'patients', op: 'select', columns: 'mrn, marital_status, emergency_contact_relation, payer_policy_id, insurance_policy_number, insurance_expiry_date, active',
    filters: [{ col: 'mrn', op: 'eq', val: 'P-26-99999' }] }, ADMIN);
  const r = db.prepare(sel.sql).get(...sel.params);
  assert.equal(r.marital_status, 'single');
  assert.equal(r.payer_policy_id, 1);
  assert.equal(r.insurance_policy_number, 'POL-123');
  assert.equal(r.active, 1);
});

test('034 patients delete: admin only', () => {
  const db = freshDb();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  const del = compile({ table: 'patients', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, ADMIN);
  db.prepare(del.sql).run(...del.params);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM patients').get().n, 0);
  assert.throws(() => compile({ table: 'patients', op: 'delete', filters: [{ col: 'id', op: 'eq', val: 1 }] }, REG));
});
