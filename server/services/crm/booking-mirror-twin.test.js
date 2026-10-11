// CRM_UNIFY_V1 / PUBLIC_API_V1 — повторная проверка 8a, п. 4: ЗЕРКАЛО ЗАПИСИ НЕ
// ВВОЗИТ В ВИЗИТ ВТОРУЮ СТРОКУ ТОЙ ЖЕ УСЛУГИ.
//
// Две карточки одного пациента ждут одну и ту же консультацию в один день.
// Запись по второй (15:00) отменили, пациента записали на 10:00: связь визита с
// CRM берёт обе ждущие строки. Первая заводит в визит строку консультации, а
// вторая прежде ПЕРЕНОСИЛА из отменённого визита свою — две консультации в
// одном визите, двойной счёт. Теперь та же услуга в визите уже есть — строка
// второй карточки берёт её, а не ввозит вторую.
//
// Финальная проверка 8a, п. 1: «берёт её» — только когда это честно. Строку,
// которую поставил ЧЕЛОВЕК (регистратура: количество, пакет, своя цена),
// строка зеркала (×1 по прайсу) не вытесняет — уступает сама, как в шаге 3
// сверки (yieldAutoLine). И две строки ОДНОЙ карточки (анализ натощак и через
// два часа) — две настоящие строки, а не двойники: их не сливают.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureVisit } from '../rpc/visits.js';
import { calendarBook } from '../rpc/calendar.js';
import { mirrorVisit } from './booking-mirror.js';

const at = (day, hhmm) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const iso = (day, hhmm) => new Date(at(day, hhmm)).toISOString();
const DAY = '2030-03-12';
const CC = { id: 3, role: 'callcenter' };
const REG = { id: 2, role: 'registrar' };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?, ?, ?, ?, ?, ?)');
  u.run(2, 'reg', 'x', 'Регистратор', 'registrar', 0);
  u.run(3, 'cc', 'x', 'Оператор', 'callcenter', 0);
  u.run(7, 'doc', 'x', 'Петров П.П.', 'doctor', 1);
  db.prepare("INSERT INTO consultation_types (id, name, price, active, duration_minutes) VALUES (1, 'Первичный приём', 150000, 1, 30)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab) VALUES (40, 'Глюкоза крови', 40000, 'lab', 1)").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (41, 'Укол внутримышечный', 20000, 'procedure')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Каримов Азиз', '+998901234567')").run();
  return db;
}
const lines = (db, visitId) => db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'")
  .all(visitId).map((x) => ({ ...x }));

test('две карточки ждут ту же консультацию в один день; запись по второй отменили, пациента записали снова — в визите одна консультация', async () => {
  const db = clinic();
  // Первая карточка (раньше): сайт, другой номер — номер её с картой не свяжет.
  const first = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, scheduled_date) VALUES ('Каримов Азиз', '+998935550000', 'website', 'in_process', '2030-03-12')").run().lastInsertRowid);
  db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(first);
  // Вторая (позже): звонок, карта пациента выбрана; запись на 15:00.
  const second = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date) VALUES ('Каримов Азиз', '+998901234567', 'call', 'in_process', 1, '2030-03-12')").run().lastInsertRowid);
  db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(second);
  const ph = await ensureVisit(db, { patient_id: 1, date: new Date(at('2030-03-12', '15:00')).toISOString(), doctor_id: 7,
    book: { doctor_id: 7, start: new Date(at('2030-03-12', '15:00')).toISOString(), duration_minutes: 30 } }, CC);
  assert.equal(lines(db, ph.visit.id).length, 1);
  // Запись на 15:00 отменили; первая карточка получила карту пациента.
  await calendarBook(db, { visit_id: ph.visit.id, start: new Date(at('2030-03-12', '15:00')).toISOString(), status: 'cancelled' }, REG);
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(first);
  const v = await ensureVisit(db, { patient_id: 1, date: new Date(at('2030-03-12', '10:00')).toISOString(), doctor_id: 7,
    book: { doctor_id: 7, start: new Date(at('2030-03-12', '10:00')).toISOString(), duration_minutes: 30 } }, REG);
  assert.deepEqual(lines(db, v.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }], 'одна консультация, а не две');
});

// ── Финальная проверка 8a, п. 1 ─────────────────────────────────────────────
const live = (db, visitId, sid) => db.prepare("SELECT id, quantity, unit_price, package_id FROM visit_services WHERE visit_id = ? AND service_id = ? AND status <> 'cancelled' ORDER BY id")
  .all(visitId, sid).map((x) => ({ ...x }));
const units = (rows) => rows.reduce((n, r) => n + Number(r.quantity), 0);
const card = (db, source, phone, patientId, day = DAY) => Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date)
  VALUES ('Каримов Азиз', ?, ?, 'in_process', ?, ?)`).run(phone, source, patientId, day).lastInsertRowid);
const wants = (db, requestId, serviceId, day = DAY) => db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, ?, ?, 'pending')").run(requestId, serviceId, day);
const book = (db, day, hhmm, user) => ensureVisit(db, { patient_id: 1, date: iso(day, hhmm), doctor_id: 7, book: { doctor_id: 7, start: iso(day, hhmm), duration_minutes: 30 } }, user);
// Регистратура добавляет строку в окне визита — как /api/db: запись, затем сверка зеркала.
function regAdd(db, visitId, serviceId, { quantity = 1, unit = null, packageId = null } = {}) {
  const price = unit ?? db.prepare('SELECT price FROM services WHERE id = ?').get(serviceId).price;
  const id = Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by, package_id)
                                VALUES (?, ?, ?, ?, ?, 'added', 2, ?)`).run(visitId, serviceId, quantity, price, price * quantity, packageId).lastInsertRowid);
  mirrorVisit(db, visitId, { actorId: 2 });
  return id;
}

test('одна карточка держит два анализа глюкозы (натощак и через два часа): запись отменили и записали снова — в визите оба', async () => {
  const db = clinic();
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  regAdd(db, w.visit.id, 40);
  regAdd(db, w.visit.id, 40);
  assert.equal(live(db, w.visit.id, 40).length, 2);
  await calendarBook(db, { visit_id: w.visit.id, start: iso(DAY, '15:00'), status: 'cancelled' }, REG);
  const v = await book(db, DAY, '10:00', REG);
  assert.notEqual(v.visit.id, w.visit.id);
  assert.equal(live(db, v.visit.id, 40).length, 2, 'две строки одной карточки — два анализа, а не один');
});

for (const order of ['сначала сайт', 'сначала звонок']) {
  test(`регистратура поставила укол ×2 по записи звонка, сайт ждёт тот же укол; запись отменили и записали снова — в визите 2 укола, не 1 и не 3 (${order})`, async () => {
    const db = clinic();
    let site;
    if (order === 'сначала сайт') { site = card(db, 'website', '+998935550000', null); wants(db, site, 41); }
    card(db, 'call', '+998901234567', 1);
    const w = await book(db, DAY, '15:00', CC);
    regAdd(db, w.visit.id, 41, { quantity: 2 });
    if (order === 'сначала звонок') { site = card(db, 'website', '+998935550000', null); wants(db, site, 41); }
    assert.equal(units(live(db, w.visit.id, 41)), 2);
    await calendarBook(db, { visit_id: w.visit.id, start: iso(DAY, '15:00'), status: 'cancelled' }, REG);
    db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
    const v = await book(db, DAY, '10:00', REG);
    assert.equal(units(live(db, v.visit.id, 41)), 2, 'строка регистратуры ×2 не уступает строке зеркала ×1');
  });
}

for (const order of ['сначала сайт', 'сначала звонок']) {
  test(`строка регистратуры по цене пакета и строка зеркала по прайсу на ту же услугу — остаётся пакетная (${order})`, async () => {
    const db = clinic();
    db.prepare("INSERT INTO service_templates (id, name, discount_percent, is_package, discount_mode, discount_value) VALUES (9, 'Check-up', 50, 1, 'percent', 50)").run();
    let site;
    if (order === 'сначала сайт') { site = card(db, 'website', '+998935550000', null); wants(db, site, 40); }
    card(db, 'call', '+998901234567', 1);
    const w = await book(db, DAY, '15:00', CC);
    const pk = regAdd(db, w.visit.id, 40, { unit: 20000, packageId: 9 });
    db.prepare('UPDATE visit_services SET package_full = 40000, package_price = 20000 WHERE id = ?').run(pk);
    if (order === 'сначала звонок') { site = card(db, 'website', '+998935550000', null); wants(db, site, 40); }
    await calendarBook(db, { visit_id: w.visit.id, start: iso(DAY, '15:00'), status: 'cancelled' }, REG);
    db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
    const v = await book(db, DAY, '10:00', REG);
    const rows = live(db, v.visit.id, 40);
    assert.equal(rows.length, 1, 'один анализ, а не два');
    assert.equal(rows[0].package_id, 9, 'остаётся строка регистратуры с пакетной скидкой');
    assert.equal(rows[0].unit_price, 20000);
  });
}

test('карточка переносит курс уколов ×10 на день, где другая карточка уже держит укол ×1 в записи, — в визите 10 уколов, а не 1', async () => {
  const db = clinic();
  const D1 = '2030-03-11';
  const site = card(db, 'website', '+998935550000', 1, DAY);
  wants(db, site, 41, DAY);
  const v = await book(db, DAY, '10:00', CC);
  assert.equal(units(live(db, v.visit.id, 41)), 1);
  const call = card(db, 'call', '+998901234567', 1, D1);
  const w = await book(db, D1, '15:00', REG);
  db.prepare("INSERT OR REPLACE INTO crm_booking_links (visit_id, request_id, source, created_by, created_request) VALUES (?, ?, 'match', 2, 0)").run(w.visit.id, call);
  regAdd(db, w.visit.id, 41, { quantity: 10 });
  const line = db.prepare('SELECT id FROM crm_request_services WHERE request_id = ?').get(call);
  assert.equal(units(live(db, w.visit.id, 41)), 10);
  // Окно карточки переносит строку на DAY (crm.js saveLines: новый день, визит снят), затем сверка.
  db.prepare('UPDATE crm_request_services SET scheduled_date = ?, visit_id = NULL WHERE id = ?').run(DAY, line.id);
  mirrorVisit(db, w.visit.id, { actorId: 3 });
  const again = await ensureVisit(db, { patient_id: 1, date: DAY, doctor_id: 7 }, CC);
  assert.equal(again.visit.id, v.visit.id);
  assert.equal(units(live(db, v.visit.id, 41)), 10, 'курс ×10 не сжимается до ×1 (180 000 недосчёта)');
});
