// SERVICE_EDITOR_V1 — service_save: one dialog, ONE transaction.
//
// The published system's editor saved the service first and asked the admin to
// re-open it to tick performers — a workaround for its backend that this local
// editor exists to kill (docs/plans/2026-08-31-service-editor-design.md). The
// price of "one save" is that a partial save must be IMPOSSIBLE: a service row
// without its performer entries after a crash is the published bug reborn, so
// the atomicity test below is not decoration — it is the feature.
//
// The second danger is users.service_rates: a shared JSON store edited by the
// employee card AND this RPC, read by reports.js doctor-pay ($.pct,
// DOC_RATE_JSON_V1). Every merge test pins "touch only this service's entry".
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { serviceSave } from './service-save.js';
import { runReport } from './reports.js';

const admin = { id: 1, role: 'admin' };
// ADMIN_DOCTOR_V1 — a clinic admin whose PRIMARY role is doctor. hasAnyRole
// must accept them; user.role === 'admin' (the check this repo shipped wrong
// twice) would not.
const adminDoctor = { id: 2, role: 'doctor', extra_roles: ['admin'] };
const registrar = { id: 3, role: 'registrar' };

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function addUser(db, { name, isDoctor = 1, rates = '' } = {}) {
  return Number(db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, is_doctor, service_rates) VALUES (?, 'x', ?, 'doctor', ?, ?)",
  ).run(name.toLowerCase().replace(/\s+/g, '_'), name, isDoctor ? 1 : 0, rates).lastInsertRowid);
}

const baseArgs = (over = {}) => ({
  name: 'Приём терапевта',
  type: 'consultation',
  price: 150000,
  tax_rate: 12,
  duration_minutes: 30,
  requires_doctor: false,
  default_doctor_percent: 30,
  performers: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Access + validation
// ---------------------------------------------------------------------------

test('only an admin saves services — and admin-by-extra_roles counts', () => {
  const db = freshDb();
  assert.throws(() => serviceSave(db, baseArgs(), registrar), (e) => e.status === 403);
  assert.ok(serviceSave(db, baseArgs(), admin).id > 0);
  assert.ok(serviceSave(db, baseArgs({ name: 'Приём кардиолога' }), adminDoctor).id > 0);
});

test('name, price and a known раздел are required', () => {
  const db = freshDb();
  assert.throws(() => serviceSave(db, baseArgs({ name: '   ' }), admin), (e) => e.status === 400);
  assert.throws(() => serviceSave(db, baseArgs({ price: undefined }), admin), (e) => e.status === 400);
  assert.throws(() => serviceSave(db, baseArgs({ price: -1 }), admin), (e) => e.status === 400);
  assert.throws(() => serviceSave(db, baseArgs({ type: 'surgery' }), admin), (e) => e.status === 400);
});

test('performer gating: «оказывает специалист» with zero performers is refused', () => {
  const db = freshDb();
  assert.throws(
    () => serviceSave(db, baseArgs({ requires_doctor: true, performers: [] }), admin),
    (e) => e.status === 400 && /исполнителя/.test(e.message),
  );
  // …and the refusal left nothing behind.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE name = 'Приём терапевта'").get().n, 0);
});

// ---------------------------------------------------------------------------
// Create: combobox values resolve/create inside the SAME transaction
// ---------------------------------------------------------------------------

test('create with three typed-in combobox values: all created AND linked in one save', () => {
  const db = freshDb();
  const doc = addUser(db, { name: 'Врач Первый' });
  const res = serviceSave(db, baseArgs({
    requires_doctor: true,
    performers: [doc],
    type_ref: { name: 'Первичный приём' },
    category_ref: { name: 'Терапия' },
    department_ref: { name: 'Терапевтическое отделение' },
  }), admin);

  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(res.id);
  const type = db.prepare('SELECT * FROM service_types WHERE id = ?').get(svc.type_id);
  const cat = db.prepare('SELECT * FROM service_categories WHERE id = ?').get(svc.category_id);
  const dep = db.prepare('SELECT * FROM departments WHERE id = ?').get(svc.department_id);
  assert.equal(type.name, 'Первичный приём');
  assert.equal(cat.name, 'Терапия');
  assert.equal(dep.name, 'Терапевтическое отделение');
  assert.equal(svc.default_doctor_percent, 30);
  assert.equal(svc.requires_doctor, 1);

  // …and the performer entry landed in the same save, reports-ready.
  const rates = JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates);
  assert.deepEqual(rates, [{ service_id: res.id, pct: 30, branches: [1] }]);
});

test('an existing name typed again does NOT create a twin — case and spaces included', () => {
  const db = freshDb();
  const catId = Number(db.prepare("INSERT INTO service_categories (name) VALUES ('Терапия')").run().lastInsertRowid);

  const res = serviceSave(db, baseArgs({ category_ref: { name: '  терапия ' } }), admin);
  assert.equal(db.prepare('SELECT category_id FROM services WHERE id = ?').get(res.id).category_id, catId);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM service_categories WHERE name LIKE '%ерапия%'").get().n, 1,
    'no second Терапия row');
});

test('a combobox {id} that does not exist is a clean 400, not an FK explosion', () => {
  const db = freshDb();
  assert.throws(() => serviceSave(db, baseArgs({ category_ref: { id: 9999 } }), admin), (e) => e.status === 400);
  assert.throws(() => serviceSave(db, baseArgs({ room_id: 9999 }), admin), (e) => e.status === 400);
});

// ---------------------------------------------------------------------------
// Lab block: persisted ONLY when раздел = лаборатория
// ---------------------------------------------------------------------------

test('lab fields persist for a lab service, and is_lab follows the раздел', () => {
  const db = freshDb();
  const res = serviceSave(db, baseArgs({
    name: 'Глюкоза крови', type: 'lab',
    lab: { specimen: 'кровь', result_unit: 'ммоль/л', ref_low: 3.3, ref_high: 5.5, ref_text: null, tube_color: 'grey' },
  }), admin);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(res.id);
  assert.equal(svc.is_lab, 1);
  assert.equal(svc.specimen, 'кровь');
  assert.equal(svc.result_unit, 'ммоль/л');
  assert.equal(svc.ref_low, 3.3);
  assert.equal(svc.tube_color, 'grey');
});

test('lab fields sent with a non-lab раздел are dropped, not stored', () => {
  const db = freshDb();
  const res = serviceSave(db, baseArgs({
    name: 'Массаж', type: 'procedure',
    lab: { specimen: 'кровь', result_unit: 'x', ref_low: 1, ref_high: 2, ref_text: 't', tube_color: 'red' },
  }), admin);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(res.id);
  assert.equal(svc.is_lab, 0);
  assert.equal(svc.specimen, null);
  assert.equal(svc.result_unit, null);
  assert.equal(svc.tube_color, null);
});

test('switching a lab service to another раздел keeps its lab columns (hidden ≠ wiped)', () => {
  const db = freshDb();
  const created = serviceSave(db, baseArgs({
    name: 'ОАК', type: 'lab',
    lab: { specimen: 'кровь', result_unit: 'г/л', ref_low: 120, ref_high: 160, ref_text: null, tube_color: 'lavender' },
  }), admin);

  // The same precedent as the generic form's visibleWhen note (sections.js):
  // hidden fields are left untouched, so switching back restores everything.
  serviceSave(db, baseArgs({ id: created.id, name: 'ОАК', type: 'consultation' }), admin);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(created.id);
  assert.equal(svc.is_lab, 0, 'routing follows the раздел');
  assert.equal(svc.specimen, 'кровь', 'the lab data survives for the day it switches back');
  assert.equal(svc.tube_color, 'lavender');
});

// ---------------------------------------------------------------------------
// The service_rates merge, RPC-level
// ---------------------------------------------------------------------------

test('editing performers never clobbers a person\'s OTHER services\' rates', () => {
  const db = freshDb();
  const otherEntry = { service_id: 777, pct: 55, fix: 20000, branches: [3] };
  const doc = addUser(db, { name: 'Врач Ставочный', rates: JSON.stringify([otherEntry]) });
  const bystander = addUser(db, { name: 'Врач Посторонний', rates: JSON.stringify([otherEntry]) });

  const res = serviceSave(db, baseArgs({ requires_doctor: true, performers: [doc] }), admin);
  let rates = JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates);
  assert.deepEqual(rates[0], otherEntry, 'the pre-existing entry is byte-identical');
  assert.deepEqual(rates[1], { service_id: res.id, pct: 30, branches: [1] });

  // Untick on edit: only this service's entry goes.
  serviceSave(db, baseArgs({ id: res.id, requires_doctor: false, performers: [] }), admin);
  rates = JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates);
  assert.deepEqual(rates, [otherEntry]);

  // A user never involved keeps the exact stored string — no rewrite happened.
  assert.equal(
    db.prepare('SELECT service_rates FROM users WHERE id = ?').get(bystander).service_rates,
    JSON.stringify([otherEntry]),
  );
});

test('an already-ticked performer keeps their personal pct — the dialog sets membership, not overrides', () => {
  const db = freshDb();
  const doc = addUser(db, { name: 'Врач Персональный' });
  const created = serviceSave(db, baseArgs({ requires_doctor: true, performers: [doc], default_doctor_percent: 30 }), admin);

  // The employee card personalises the share afterwards.
  const personal = [{ service_id: created.id, pct: 50, branches: [1] }];
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify(personal), doc);

  // Re-saving the service with a NEW default must not stamp it over the override.
  serviceSave(db, baseArgs({ id: created.id, requires_doctor: true, performers: [doc], default_doctor_percent: 25 }), admin);
  const rates = JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates);
  assert.deepEqual(rates, personal);
  assert.equal(db.prepare('SELECT default_doctor_percent FROM services WHERE id = ?').get(created.id).default_doctor_percent, 25,
    'the service default itself does move');
});

test('a performer id that is not a user is refused before anything is written', () => {
  const db = freshDb();
  assert.throws(
    () => serviceSave(db, baseArgs({ requires_doctor: true, performers: [12345] }), admin),
    (e) => e.status === 400,
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE name = 'Приём терапевта'").get().n, 0);
});

test('corrupt service_rates on a ticked performer refuses the save — never repaired by overwrite', () => {
  const db = freshDb();
  const doc = addUser(db, { name: 'Врач Битый', rates: '{broken' });
  assert.throws(
    () => serviceSave(db, baseArgs({ requires_doctor: true, performers: [doc] }), admin),
    (e) => e.status === 400 && /Врач Битый/.test(e.message),
  );
  assert.equal(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates, '{broken',
    'the stored value is untouched');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE name = 'Приём терапевта'").get().n, 0,
    'and the service did not half-save');
});

// ---------------------------------------------------------------------------
// Atomicity — the reason this RPC exists at all
// ---------------------------------------------------------------------------

test('a crash mid-save leaves NOTHING: no service, no created combobox rows, no rate entries', () => {
  const db = freshDb();
  const doc = addUser(db, { name: 'Врач Атомарный' });
  const typesBefore = db.prepare('SELECT COUNT(*) n FROM service_types').get().n;
  const catsBefore = db.prepare('SELECT COUNT(*) n FROM service_categories').get().n;

  // Force the LAST write of the save (the performer merge) to blow up, the way
  // a mid-transaction crash would. Everything before it must roll back.
  db.exec("CREATE TRIGGER boom BEFORE UPDATE OF service_rates ON users BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => serviceSave(db, baseArgs({
    requires_doctor: true,
    performers: [doc],
    type_ref: { name: 'Новый тип' },
    category_ref: { name: 'Новая категория' },
  }), admin));

  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE name = 'Приём терапевта'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM service_types').get().n, typesBefore, 'created type rolled back');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM service_categories').get().n, catsBefore, 'created category rolled back');
  assert.equal(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates, '');
});

// ---------------------------------------------------------------------------
// Edit basics
// ---------------------------------------------------------------------------

test('edit updates in place — no twin service, updated_at moves, room is settable and clearable', () => {
  const db = freshDb();
  const room = Number(db.prepare("INSERT INTO rooms (name) VALUES ('Кабинет 3')").run().lastInsertRowid);
  const created = serviceSave(db, baseArgs(), admin);
  db.prepare("UPDATE services SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(created.id);

  serviceSave(db, baseArgs({ id: created.id, name: 'Приём терапевта повторный', price: 90000, room_id: room }), admin);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(created.id);
  assert.equal(svc.name, 'Приём терапевта повторный');
  assert.equal(svc.price, 90000);
  assert.equal(svc.room_id, room);
  assert.notEqual(svc.updated_at, '2000-01-01T00:00:00Z');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM services WHERE name LIKE 'Приём терапевта%'").get().n, 1);

  serviceSave(db, baseArgs({ id: created.id, name: 'Приём терапевта повторный', room_id: null }), admin);
  assert.equal(db.prepare('SELECT room_id FROM services WHERE id = ?').get(created.id).room_id, null);
});

test('editing a service that is gone is 404, not a silent create', () => {
  const db = freshDb();
  assert.throws(() => serviceSave(db, baseArgs({ id: 424242 }), admin), (e) => e.status === 404);
});

test('default share 0: the membership entry carries NO pct, and the REAL pay report uses the card default', () => {
  // Measured before this behaviour existed: an entry with pct:0 OVERRODE the
  // doctor's card default with zero on the actual doctor_salaries report. An
  // entry without the pct key falls through reports.js's COALESCE to
  // users.service_rate_default — which is what "I did not set a share" means.
  const db = freshDb();
  const doc = addUser(db, { name: 'Врач Карточный' });
  db.prepare('UPDATE users SET service_rate_default = 40 WHERE id = ?').run(doc);

  const res = serviceSave(db, baseArgs({
    requires_doctor: true, performers: [doc], default_doctor_percent: 0, tax_rate: 6,
  }), admin);

  const rates = JSON.parse(db.prepare('SELECT service_rates FROM users WHERE id = ?').get(doc).service_rates);
  assert.deepEqual(rates, [{ service_id: res.id, branches: [1] }], 'no pct key — the card governs');

  // …and the actual salary report agrees: 100 000 − 6% налог = 94 000; 40% = 37 600.
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Пациент')").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date) VALUES (1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))").run();
  db.prepare(`INSERT INTO visit_services (id, visit_id, service_id, doctor_id, quantity, unit_price, total, status)
              VALUES (1,1,?,?,1,100000,100000,'added')`).run(res.id, doc);
  db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
              VALUES (1,'INV-1',1,1,100000,0,100000,100000,'paid',strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run();
  db.prepare(`INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total)
              VALUES (1,1,?, 'Приём',1,100000,100000)`).run(res.id);
  db.prepare('UPDATE visit_services SET invoice_item_id = 1 WHERE id = 1').run();

  const r = runReport(db, { kind: 'doctor_salaries', from: '2000-01-01', to: '2100-01-01' }, admin);
  assert.equal(r.rows[0][r.columns.indexOf('Доля врача (гонорар)')], 37600,
    'card default 40% governs when the service default was left at 0');
});

test('the three dynamic refusals carry machine codes + params — the dialog translates by code', () => {
  // The assembled Russian sentences stay for logs and old clients, but a
  // sentence built around a value can never match a dictionary key (tr()
  // matches whole strings) — so the translatable identity is {code, params},
  // the same architecture the branch screen already uses.
  const db = freshDb();

  try { serviceSave(db, baseArgs({ category_ref: { id: 9999 } }), admin); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'ref_row_missing');
    assert.deepEqual(e.params, { table: 'service_categories', id: 9999 });
    assert.match(e.message, /service_categories/, 'the human sentence survives for logs');
  }

  try { serviceSave(db, baseArgs({ requires_doctor: true, performers: [12345] }), admin); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'employee_missing');
    assert.deepEqual(e.params, { id: 12345 });
  }

  const doc = addUser(db, { name: 'Врач Битый Код', rates: '{broken' });
  try { serviceSave(db, baseArgs({ requires_doctor: true, performers: [doc] }), admin); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'rates_corrupt');
    assert.deepEqual(e.params, { name: 'Врач Битый Код' });
  }
});
