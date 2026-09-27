// LIVE_AUDIT_FIX_V1 — remove_own_visit_line и discard_empty_visit через
// настоящий реестр RPC и SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';

const REG = { id: 1, role: 'registrar', extra_roles: [] };
const DOC = { id: 2, role: 'doctor', extra_roles: [] };
const DOC2 = { id: 3, role: 'doctor', extra_roles: [] };
const NURSE = { id: 4, role: 'nurse', extra_roles: [] };

function freshDb() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (1,'r','x','Reg','registrar',1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (2,'d','x','Doc','doctor',1,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active, is_doctor) VALUES (3,'d2','x','Doc2','doctor',1,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (4,'n','x','Nurse','nurse',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'P')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (21,'УЗИ',100000)").run();
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status, created_by) VALUES (40,1,?,'scheduled',1)").run(new Date().toISOString());
  return db;
}
const call = (name, db, args, user) => getRpc(name)(db, args, user);
const line = (db, id, extra = {}) => {
  const r = { doctor_id: 2, created_by: 2, status: 'added', ...extra };
  db.prepare('INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, doctor_id, created_by) VALUES (?,40,21,1,100000,100000,?,?,?)')
    .run(id, r.status, r.doctor_id, r.created_by);
};
const exists = (db, id) => !!db.prepare('SELECT 1 FROM visit_services WHERE id = ?').get(id);

test('remove_own_visit_line: врач снимает свою невыставленную услугу — строки нет ни в визите, ни в будущем счёте', () => {
  const db = freshDb();
  line(db, 101);
  const out = call('remove_own_visit_line', db, { visit_service_id: 101 }, DOC);
  assert.deepEqual(out, { removed: true, id: 101 });
  assert.equal(exists(db, 101), false);
});

test('remove_own_visit_line: чужая строка, выставленная, начатая, с результатом — отказ, строка на месте', () => {
  const db = freshDb();
  line(db, 101, { doctor_id: 3, created_by: 3 });
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 101 }, DOC), (e) => e.status === 403 && /свою/.test(e.message));
  assert.equal(exists(db, 101), true);

  line(db, 102, { status: 'in_progress' });
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 102 }, DOC), /начата/);
  assert.equal(exists(db, 102), true);

  line(db, 103);
  db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount, status) VALUES (9,'INV-9',40,1,100000,100000,'unpaid')").run();
  db.prepare("INSERT INTO invoice_items (id, invoice_id, service_id, description, quantity, unit_price, total) VALUES (90,9,21,'УЗИ',1,100000,100000)").run();
  db.prepare('UPDATE visit_services SET invoice_item_id = 90 WHERE id = 103').run();
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 103 }, DOC), /в счёте/);
  assert.equal(exists(db, 103), true);

  line(db, 104);
  db.prepare("INSERT INTO lab_results (visit_service_id, value) VALUES (104, '5.1')").run();
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 104 }, DOC), /результаты/);
  assert.equal(exists(db, 104), true);

  // медсестра строк визита не снимает вовсе
  line(db, 105, { doctor_id: 4, created_by: 4 });
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 105 }, NURSE), (e) => e.status === 403);
  // регистратура снимает любую невыставленную — то же, что ей даёт реестр
  assert.equal(call('remove_own_visit_line', db, { visit_service_id: 101 }, REG).removed, true);
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 101 }, DOC2), (e) => e.status === 404);
});

test('discard_empty_visit: свой пустой только что заведённый визит удаляется; с услугой или чужой — нет', () => {
  const db = freshDb();
  // чужой (завёл регистратор 1) — врач удалить не может
  assert.throws(() => call('discard_empty_visit', db, { visit_id: 40 }, DOC), (e) => e.status === 403);
  // с услугой — не пустой
  line(db, 101);
  assert.throws(() => call('discard_empty_visit', db, { visit_id: 40 }, REG), /не пустой/);
  assert.ok(db.prepare('SELECT 1 FROM visits WHERE id = 40').get());
  db.prepare('DELETE FROM visit_services WHERE id = 101').run();
  // давно заведённый — нет
  db.prepare("UPDATE visits SET created_at = '2020-01-01T00:00:00Z' WHERE id = 40").run();
  assert.throws(() => call('discard_empty_visit', db, { visit_id: 40 }, REG), /давно/);
  db.prepare("UPDATE visits SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 40").run();
  // свой, пустой, свежий — удалён
  assert.deepEqual(call('discard_empty_visit', db, { visit_id: 40 }, REG), { discarded: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits WHERE id = 40').get().c, 0);
});

test('visit_set_referral_source: стойка ставит и снимает источник; врач и медсестра — отказ; несуществующий — отказ', () => {
  const db = freshDb();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (5, 'Каримов')").run();
  assert.deepEqual(call('visit_set_referral_source', db, { visit_id: 40, referral_source_id: 5 }, REG), { visit_id: 40, referral_source_id: 5 });
  assert.equal(db.prepare('SELECT referral_source_id r FROM visits WHERE id = 40').get().r, 5);
  assert.throws(() => call('visit_set_referral_source', db, { visit_id: 40, referral_source_id: null }, DOC), (e) => e.status === 403);
  assert.throws(() => call('visit_set_referral_source', db, { visit_id: 40, referral_source_id: null }, NURSE), (e) => e.status === 403);
  assert.throws(() => call('visit_set_referral_source', db, { visit_id: 40, referral_source_id: 77 }, REG), /не найден/);
  assert.equal(db.prepare('SELECT referral_source_id r FROM visits WHERE id = 40').get().r, 5);
  call('visit_set_referral_source', db, { visit_id: 40, referral_source_id: null }, REG);
  assert.equal(db.prepare('SELECT referral_source_id r FROM visits WHERE id = 40').get().r, null);
});
