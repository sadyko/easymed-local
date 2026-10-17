// CRM_ONE_WAY_V1 — правила «услуги записи живут только в визите» (crm/one-way.js) на базе
// в памяти: желание садится в визит (O1), строка CRM уступает строке человека, желание
// сбывается (усыновление), отмена отпускает строки в карточку без дня (O4), ошибочная
// отмена возвращает их (O5), карточка убирает услугу из записи (O3), строку сняли в
// другом окне (O3), строку записи из карточки не переносят (O6).
// Каждый тест сверяет строки визита (деньги): меняется только задуманная строка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  attachWish, releaseCancelled, restoreReleased, releaseOrphans, removeFromBooking, wishYields,
  adoptWishes, bookedLineEditRefusal, clearReleaseOnEdit, BOOKED_LINE_LOCKED,
} from './one-way.js';
import { visitRow } from './booking-mirror.js';

const DAY = '2030-03-12';
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?, ?, ?, ?, ?, ?)');
  u.run(2, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(3, 'cc', 'x', 'Оператор', 'callcenter', 0);
  u.run(7, 'doc', 'x', 'Петров П.П.', 'doctor', 1);
  u.run(8, 'doc2', 'x', 'Иванов И.И.', 'doctor', 1);
  db.prepare("INSERT INTO consultation_types (id, name, price, active, duration_minutes) VALUES (1, 'Первичный приём', 150000, 1, 30)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40, 'Глюкоза крови', 40000, 'lab', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (41, 'Укол внутримышечный', 20000, 'procedure')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (42, 'Аппендэктомия', 3000000, 'other')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Каримов Азиз', '+998901234567')").run();
  return db;
}
const visit = (db, { status = 'scheduled', day = DAY } = {}) => Number(db.prepare(`INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by)
  VALUES (1, 7, ?, ?, 3)`).run(new Date(`${day}T10:00:00`).toISOString(), status).lastInsertRowid);
const card = (db) => Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id) VALUES ('Каримов Азиз', '+998901234567', 'call', 'in_process', 1)").run().lastInsertRowid);
const wish = (db, rid, { svc = null, ct = null, doctor = null, day = DAY } = {}) => Number(db.prepare(`INSERT INTO crm_request_services
  (request_id, service_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, ?, ?, ?, ?, 'pending')`).run(rid, svc, ct, doctor, day).lastInsertRowid);
const line = (db, id) => db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id);
const regLine = (db, vid, svc, { quantity = 1, doctor = null, unit = null } = {}) => {
  const p = unit ?? db.prepare('SELECT price FROM services WHERE id = ?').get(svc).price;
  return Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'added', 2)`).run(vid, svc, doctor, quantity, p, p * quantity).lastInsertRowid);
};
const money = (db, vid) => db.prepare(`SELECT id, service_id, consultation_type_id, quantity, unit_price, status FROM visit_services
                                         WHERE visit_id = ? ORDER BY id`).all(vid).map((x) => ({ ...x }));
const attach = (db, vid, lid) => db.transaction(() => attachWish(db, visitRow(db, vid), line(db, lid), { actorId: 3 }))();

test('CRM_ONE_WAY_V1 O1: желание садится в визит одной строкой по цене каталога; строка карточки — строка записи (auto 1, день визита)', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const l = wish(db, rid, { svc: 40, day: null });
  const vsId = attach(db, v, l);
  assert.deepEqual(money(db, v), [{ id: vsId, service_id: 40, consultation_type_id: null, quantity: 1, unit_price: 40000, status: 'added' }]);
  const r = line(db, l);
  assert.deepEqual([r.visit_id, r.visit_service_id, r.visit_service_auto, r.scheduled_date], [v, vsId, 1, DAY]);
});

test('CRM_ONE_WAY_V1 O1: строка той же услуги уже в визите (регистратура) — желание указывает на неё, второй строки нет', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const x = regLine(db, v, 41, { quantity: 2 });
  const before = money(db, v);
  const l = wish(db, rid, { svc: 41 });
  assert.equal(attach(db, v, l), x);
  assert.deepEqual(money(db, v), before, 'деньги не двинулись');
  assert.deepEqual([line(db, l).visit_service_id, line(db, l).visit_service_auto], [x, 0]);
});

test('CRM_ONE_WAY_V1 O1: два желания ОДНОЙ карточки на одну услугу (натощак и через два часа) — две строки', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  attach(db, v, wish(db, rid, { svc: 40 }));
  attach(db, v, wish(db, rid, { svc: 40 }));
  assert.equal(money(db, v).length, 2);
});

test('CRM_ONE_WAY_V1 O1: две карточки на одну консультацию у одного врача — одна строка, обе указывают на неё', () => {
  const db = clinic(); const a = card(db); const b = card(db); const v = visit(db);
  const la = wish(db, a, { ct: 1, doctor: 7 }); const lb = wish(db, b, { ct: 1, doctor: 7 });
  const x = attach(db, v, la);
  assert.equal(attach(db, v, lb), x);
  assert.equal(money(db, v).length, 1);
});

test('CRM_ONE_WAY_V1 O1: консультация у другого врача — другая запись (своя строка); хирургия в запись не садится', () => {
  const db = clinic(); const a = card(db); const v = visit(db);
  attach(db, v, wish(db, a, { ct: 1, doctor: 7 }));
  attach(db, v, wish(db, a, { ct: 1, doctor: 8 }));
  assert.equal(money(db, v).length, 2);
  const s = wish(db, a, { svc: 42 });
  assert.equal(attach(db, v, s), null);
  assert.equal(money(db, v).length, 2);
  assert.deepEqual([line(db, s).visit_id, line(db, s).visit_service_id], [null, null]);
});

test('CRM_ONE_WAY_V1 O4: отмена — строки записи в карточку без дня (отпущенные), строки визита остаются как были', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const l = wish(db, rid, { svc: 40 });
  const x = attach(db, v, l);
  const before = money(db, v);
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v);
  assert.equal(releaseCancelled(db, v), 1);
  const r = line(db, l);
  assert.deepEqual([r.status, r.scheduled_date, r.visit_id, r.visit_service_id, r.released_from_visit_id, r.released_vs_id], ['pending', null, null, null, v, x]);
  assert.deepEqual(money(db, v), before);
});

test('CRM_ONE_WAY_V1 O5: ошибочную отмену отменили — нетронутые отпущенные строки снова указывают на свои строки визита; датированную оператором — нет', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const l1 = wish(db, rid, { svc: 40 }); const l2 = wish(db, rid, { svc: 41 });
  const x1 = attach(db, v, l1); attach(db, v, l2);
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v);
  releaseCancelled(db, v);
  db.prepare("UPDATE crm_request_services SET scheduled_date = '2030-03-20', released_from_visit_id = NULL, released_vs_id = NULL WHERE id = ?").run(l2);
  db.prepare("UPDATE visits SET status = 'scheduled' WHERE id = ?").run(v);
  assert.equal(restoreReleased(db, v), 1);
  assert.deepEqual([line(db, l1).visit_id, line(db, l1).visit_service_id, line(db, l1).scheduled_date, line(db, l1).released_from_visit_id], [v, x1, DAY, null]);
  assert.deepEqual([line(db, l2).visit_id, line(db, l2).scheduled_date], [null, '2030-03-20']);
  assert.equal(money(db, v).length, 2, 'строки визита не менялись');
});

test('CRM_ONE_WAY_V1 O3: строку визита сняли в другом окне — строка записи отпущена (без дня, отметка визита), чужие строки не тронуты', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const l1 = wish(db, rid, { svc: 40 }); const l2 = wish(db, rid, { svc: 41 });
  const x1 = attach(db, v, l1); attach(db, v, l2);
  db.prepare('DELETE FROM visit_services WHERE id = ?').run(x1);
  assert.equal(releaseOrphans(db, v), 1);
  const r = line(db, l1);
  assert.deepEqual([r.status, r.visit_id, r.scheduled_date, r.released_from_visit_id, r.released_vs_id], ['pending', null, null, v, null]);
  assert.equal(line(db, l2).visit_id, v);
});

test('CRM_ONE_WAY_V1 O3: карточка убрала услугу из записи — свободная строка уходит; общую со второй карточкой и выставленную — нет', () => {
  const db = clinic(); const a = card(db); const b = card(db); const v = visit(db);
  const la = wish(db, a, { svc: 40 }); const x = attach(db, v, la);
  const lb = wish(db, b, { svc: 40 }); attach(db, v, lb);
  const lc = wish(db, a, { svc: 41 }); const y = attach(db, v, lc);
  db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE id IN (?, ?)").run(la, lc);
  assert.deepEqual(removeFromBooking(db, [{ lineId: la, vsId: x }, { lineId: lc, vsId: y }]), [v]);
  assert.deepEqual(money(db, v).map((r) => r.id), [x], 'общая строка осталась (её ждёт карточка Б), строка укола ушла');
  const w = visit(db, { day: '2030-03-13' });
  const ld = wish(db, a, { svc: 41, day: '2030-03-13' }); const z = attach(db, w, ld);
  db.prepare("INSERT INTO invoices (visit_id, patient_id, total_amount, status) VALUES (?, 1, 20000, 'unpaid')").run(w);
  db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE id = ?").run(ld);
  assert.deepEqual(removeFromBooking(db, [{ lineId: ld, vsId: z }]), []);
  assert.equal(money(db, w).length, 1, 'визит при счёте — строку правит касса');
});

test('CRM_ONE_WAY_V1 O1: строка CRM ×1 уступает строке регистратуры ×2 той же услуги — 2 укола, а не 3', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const l = wish(db, rid, { svc: 41 }); attach(db, v, l);
  const y = regLine(db, v, 41, { quantity: 2 });
  assert.equal(wishYields(db, v), 1);
  assert.deepEqual(money(db, v).map((r) => [r.id, r.quantity]), [[y, 2]]);
  assert.deepEqual([line(db, l).visit_service_id, line(db, l).visit_service_auto], [y, 0]);
});

test('CRM_ONE_WAY_V1: желание без дня сбывается строкой регистратуры (усыновление); отпущенное — никогда', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  attach(db, v, wish(db, rid, { svc: 40 }));   // карточка держит визит строкой
  const undated = wish(db, rid, { ct: 1, doctor: null, day: null });
  const released = wish(db, rid, { svc: 41, day: null });
  db.prepare('UPDATE crm_request_services SET released_from_visit_id = 999 WHERE id = ?').run(released);
  const c = Number(db.prepare(`INSERT INTO visit_services (visit_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, created_by)
                               VALUES (?, 1, 7, 1, 150000, 150000, 'added', 2)`).run(v).lastInsertRowid);
  const inj = regLine(db, v, 41);
  const before = money(db, v);
  assert.equal(adoptWishes(db, v, [c, inj]), 1);
  assert.deepEqual([line(db, undated).visit_service_id, line(db, undated).scheduled_date], [c, DAY]);
  assert.equal(line(db, released).visit_service_id, null);
  assert.deepEqual(money(db, v), before);
});

test('CRM_ONE_WAY_V1 O6: день, врач, услуга и визит строки записи из карточки не меняются; те же значения и желание — можно', () => {
  const db = clinic(); const rid = card(db); const v = visit(db);
  const l = wish(db, rid, { svc: 41 }); attach(db, v, l);
  const w = wish(db, rid, { svc: 40, day: null });
  assert.equal(bookedLineEditRefusal(db, [l], { scheduled_date: '2030-03-20' }), BOOKED_LINE_LOCKED);
  assert.equal(bookedLineEditRefusal(db, [l], { doctor_id: 8 }), BOOKED_LINE_LOCKED);
  assert.equal(bookedLineEditRefusal(db, [l], { visit_id: null }), BOOKED_LINE_LOCKED);
  assert.equal(bookedLineEditRefusal(db, [l], { scheduled_date: DAY, doctor_id: null, note: 'перезвонить' }), null);
  assert.equal(bookedLineEditRefusal(db, [w], { scheduled_date: '2030-03-20' }), null);
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(v);
  assert.equal(bookedLineEditRefusal(db, [l], { scheduled_date: '2030-03-20' }), null, 'отменённая запись — уже не запись');
});

test('CRM_ONE_WAY_V1 O4: правка дня отпущенного желания снимает отметку; правка комментария — нет', () => {
  const db = clinic(); const rid = card(db);
  const l = wish(db, rid, { svc: 40, day: null });
  db.prepare('UPDATE crm_request_services SET released_from_visit_id = 5, released_vs_id = 9 WHERE id = ?').run(l);
  const before = new Map([[l, line(db, l)]]);
  assert.equal(clearReleaseOnEdit(db, before, { note: 'x' }), 0);
  assert.equal(clearReleaseOnEdit(db, before, { scheduled_date: null }), 0, 'тот же пустой день — не правка');
  assert.equal(clearReleaseOnEdit(db, before, { scheduled_date: '2030-03-20' }), 1);
  assert.deepEqual([line(db, l).released_from_visit_id, line(db, l).released_vs_id], [null, null]);
});
