// LIVE_AUDIT_FIX_V1 — remove_own_visit_line и discard_empty_visit через
// настоящий реестр RPC и SQLite после миграций.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { compile } from '../../db/query-compiler.js';

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
  const r = { doctor_id: 2, created_by: 2, status: 'added', sync_origin: null, ...extra };
  db.prepare('INSERT INTO visit_services (id, visit_id, service_id, quantity, unit_price, total, status, doctor_id, created_by, sync_origin) VALUES (?,40,21,1,100000,100000,?,?,?,?)')
    .run(id, r.status, r.doctor_id, r.created_by, r.sync_origin);
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

test('LIVE_AUDIT_FIX_V1: ensure_visit медсестре закрыт — пустого визита она не заведёт', async () => {
  const db = freshDb();
  const before = db.prepare('SELECT COUNT(*) c FROM visits').get().c;
  await assert.rejects(() => call('ensure_visit', db, { patient_id: 1, date: '2026-10-01' }, NURSE), (e) => e.status === 403);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM visits').get().c, before);
  const ok = await call('ensure_visit', db, { patient_id: 1, date: '2026-10-01' }, DOC);
  assert.equal(ok.created, true, 'врачу ensure_visit по-прежнему открыт');
});

test('LIVE_AUDIT_FIX_V1 (A6): calendar_book ставит источник направления новой записи; несуществующий — отказ', async () => {
  const db = freshDb();
  db.prepare("INSERT INTO referral_sources (id, name) VALUES (5, 'Каримов')").run();
  const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(6, 0, 0, 0);
  const out = await call('calendar_book', db, { patient_id: 1, start: start.toISOString(), referral_source_id: 5 }, REG);
  assert.equal(db.prepare('SELECT referral_source_id r FROM visits WHERE id = ?').get(out.visit.id).r, 5);
  await assert.rejects(() => call('calendar_book', db, { patient_id: 1, start: new Date(start.getTime() + 3600000).toISOString(), referral_source_id: 99 }, REG), /Источник направления не найден/);
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL_ROLES_SYNC_FIX_V1 (M3) — «своя» строка — заведённая этим врачом, и
// только в этом здании.
// ═══════════════════════════════════════════════════════════════════════════
test('M3: врач не снимает строку, которую завёл не он, даже назначив себя исполнителем', () => {
  const db = freshDb();
  // Регистратура завела строку ЕМУ; врач поставил себя исполнителем (doctor_id он правит сам).
  line(db, 201, { doctor_id: 2, created_by: 1 });
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 201 }, DOC),
    (e) => e.status === 403 && /которую вы добавили/.test(e.message));
  assert.equal(exists(db, 201), true);
  // Своя — снимается; старая строка без created_by — по исполнителю, как раньше.
  line(db, 202, { doctor_id: 3, created_by: 2 });
  assert.equal(call('remove_own_visit_line', db, { visit_service_id: 202 }, DOC).removed, true);
  line(db, 203, { doctor_id: 2, created_by: null });
  assert.equal(call('remove_own_visit_line', db, { visit_service_id: 203 }, DOC).removed, true);
});

test('M3: created_by строки ставит сервер из сессии — присланное браузером не принимается', () => {
  const db = freshDb();
  const q = compile({ op: 'insert', table: 'visit_services', values: { visit_id: 40, service_id: 21, quantity: 1, unit_price: 1, total: 1, doctor_id: 2, created_by: 3 } }, DOC, { db });
  db.prepare(q.sql).run(...q.params);
  const row = db.prepare('SELECT created_by FROM visit_services ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.created_by, 2, 'строка записана на того, кто её завёл, а не на присланного');
});

test('M3: строку другого здания не снимает никто — ни врач, ни регистратура', () => {
  const db = freshDb();
  line(db, 204, { sync_origin: 'B' });
  for (const u of [DOC, REG]) {
    assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 204 }, u), /другом здании/);
  }
  assert.equal(exists(db, 204), true);
});

test('M5: отказы по-русски', () => {
  const db = freshDb();
  assert.throws(() => call('remove_own_visit_line', db, { visit_service_id: 'x' }, DOC), (e) => e.status === 400 && /[А-Яа-я]/.test(e.message) && !/must be/.test(e.message));
  assert.throws(() => call('visit_set_referral_source', db, { visit_id: 0 }, REG), (e) => /[А-Яа-я]/.test(e.message) && !/must be/.test(e.message));
  assert.throws(() => call('visit_set_referral_source', db, { visit_id: 40 }, REG), (e) => /Не указан источник/.test(e.message) && !/required/.test(e.message));
  assert.throws(() => call('visit_set_referral_source', db, { visit_id: 40, referral_source_id: -1 }, REG), (e) => /[А-Яа-я]/.test(e.message) && !/must be/.test(e.message));
});

// ═══════════════════════════════════════════════════════════════════════════
// FINAL_ROLES_SYNC_FIX_V1 (M4) — discard_empty_visit: визит, который держат
// другие строки, — отказ по-русски, а не сырая ошибка внешнего ключа; заявка
// колл-центра, которую запись передвинула, возвращается как была.
// ═══════════════════════════════════════════════════════════════════════════
test('M4: давление, документ, талон очереди держат визит — отказ по-русски, визит на месте', () => {
  const holders = [
    ['patient_vitals', (db) => db.prepare('INSERT INTO patient_vitals (patient_id, visit_id, pulse_bpm) VALUES (1, 40, 72)').run(), /показатели/],
    ['visit_documents', (db) => db.prepare("INSERT INTO visit_documents (patient_id, visit_id, title) VALUES (1, 40, 'Справка')").run(), /документ/],
    ['recommended_services', (db) => db.prepare('INSERT INTO recommended_services (patient_id, service_id, source_visit_id) VALUES (1, 21, 40)').run(), /рекомендации/],
  ];
  for (const [name, add, why] of holders) {
    const db = freshDb();
    add(db);
    assert.throws(() => call('discard_empty_visit', db, { visit_id: 40 }, REG),
      (e) => e.status === 400 && /Визит не пустой/.test(e.message) && why.test(e.message) && !/FOREIGN KEY/.test(e.message), name);
    assert.ok(db.prepare('SELECT 1 FROM visits WHERE id = 40').get(), name + ': визит удалён');
  }
});

test('M4: убранный пустой визит возвращает заявку колл-центра туда, где она была', async () => {
  const db = freshDb();
  db.prepare('DELETE FROM visits').run();
  const rid = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES ('Лид','998900000000','in_process',1,NULL)").run().lastInsertRowid;
  const lid = db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, NULL, NULL, 'pending')").run(rid).lastInsertRowid;
  const out = await call('ensure_visit', db, { patient_id: 1, date: new Date().toISOString().slice(0, 10) }, REG);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'scheduled', 'запись не передвинула заявку — проверять нечего');
  assert.deepEqual(call('discard_empty_visit', db, { visit_id: out.visit.id }, REG), { discarded: true });
  const r = db.prepare('SELECT status, scheduled_date FROM crm_requests WHERE id = ?').get(rid);
  assert.equal(r.status, 'in_process', 'заявка осталась «Записан» на визит, которого нет');
  assert.equal(r.scheduled_date, null);
  assert.equal(db.prepare('SELECT visit_id FROM crm_request_services WHERE id = ?').get(lid).visit_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_booking_undo').get().n, 0, 'след записи убран');
});

test('M4: заявку, которую после записи тронул оператор, убранный визит не откатывает', async () => {
  const db = freshDb();
  db.prepare('DELETE FROM visits').run();
  const rid = db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id) VALUES ('Лид','998900000000','in_process',1)").run().lastInsertRowid;
  db.prepare("INSERT INTO crm_request_services (request_id, service_id, status) VALUES (?, NULL, 'pending')").run(rid);
  const out = await call('ensure_visit', db, { patient_id: 1, date: new Date().toISOString().slice(0, 10) }, REG);
  db.prepare("UPDATE crm_requests SET status = 'recall' WHERE id = ?").run(rid);   // оператор передвинул сам
  call('discard_empty_visit', db, { visit_id: out.visit.id }, REG);
  assert.equal(db.prepare('SELECT status FROM crm_requests WHERE id = ?').get(rid).status, 'recall');
});
