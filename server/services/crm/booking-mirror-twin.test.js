// CRM_UNIFY_V1 — СТРОКИ-ДВОЙНИКИ В ЗЕРКАЛЕ ЗАПИСИ (crm/booking-mirror.js).
//
// Две карточки одного пациента держат одну и ту же услугу на один день, а
// запись по одной из них отменяют или переносят: в визите нового дня может
// оказаться вторая строка той же услуги (двойной счёт) или, наоборот, остаться
// строка зеркала ×1 вместо строки регистратуры (×N, пакет, своя цена).
//
// CRM_TWIN_LINE — ОТДЕЛЬНАЯ ЗАДАЧА. Три попытки исправить это в ходе шага 8a
// (a657cc23, e0e6f44e) каждая ломала другой случай общего кода CRM: строку,
// которую делят две карточки, гоняло между визитами; после слияния карточек
// консультация попадала в счёт дважды. Зеркало возвращено к виду до них
// (9140fbe6); поведение двойников — прежнее, ещё не выпущенное поведение
// CRM_UNIFY_V1, и проектируется отдельно. Ниже: случаи, которые прежний код
// решает верно, — тесты; случаи, которые он решает неверно, — todo (ни «да»,
// ни «нет»; код сценариев — в истории, e0e6f44e и a657cc23).
// Онлайн-запись (PUBLIC_API_V1) в этот путь сотрудников больше не ведёт: отказ
// «day_visit_exists» советует другое время или перенос той записи на другой
// день, а не отмену и повторное подтверждение.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureVisit } from '../rpc/visits.js';
import { calendarBook } from '../rpc/calendar.js';
import { mirrorVisit } from './booking-mirror.js';

const TWIN = 'CRM_TWIN_LINE — отдельная задача, см. todo: ';
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

// ── Прежний код решает верно ────────────────────────────────────────────────

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

test('регистратура поставила укол ×2 по записи звонка, карточка сайта (заведена позже) ждёт тот же укол; запись отменили и записали снова — в визите 2 укола', async () => {
  const db = clinic();
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  regAdd(db, w.visit.id, 41, { quantity: 2 });
  const site = card(db, 'website', '+998935550000', null);
  wants(db, site, 41);
  assert.equal(units(live(db, w.visit.id, 41)), 2);
  await calendarBook(db, { visit_id: w.visit.id, start: iso(DAY, '15:00'), status: 'cancelled' }, REG);
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
  const v = await book(db, DAY, '10:00', REG);
  assert.equal(units(live(db, v.visit.id, 41)), 2);
});

test('строка регистратуры по цене пакета, карточка сайта (заведена позже) ждёт ту же услугу; запись отменили и записали снова — остаётся пакетная', async () => {
  const db = clinic();
  db.prepare("INSERT INTO service_templates (id, name, discount_percent, is_package, discount_mode, discount_value) VALUES (9, 'Check-up', 50, 1, 'percent', 50)").run();
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  const pk = regAdd(db, w.visit.id, 40, { unit: 20000, packageId: 9 });
  db.prepare('UPDATE visit_services SET package_full = 40000, package_price = 20000 WHERE id = ?').run(pk);
  const site = card(db, 'website', '+998935550000', null);
  wants(db, site, 40);
  await calendarBook(db, { visit_id: w.visit.id, start: iso(DAY, '15:00'), status: 'cancelled' }, REG);
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
  const v = await book(db, DAY, '10:00', REG);
  const rows = live(db, v.visit.id, 40);
  assert.equal(rows.length, 1, 'один анализ, а не два');
  assert.deepEqual([rows[0].package_id, rows[0].unit_price], [9, 20000], 'строка регистратуры с пакетной скидкой');
});

// ── CRM_LINK_ALL_V1 (CRM_TWIN_LINE) — решено правилом отмены (crm/visit-status.js
// releaseCancelledLines): строка зеркала отменённой записи не едет в новую ─────

test('две карточки ждут одну консультацию на день (сайт раньше звонка), запись по звонку на 15:00 отменили, пациента записали на 10:00 — в визите одна консультация (было две, 2 × 150 000)', async () => {
  const db = clinic();
  // Первая карточка (раньше): сайт, другой номер — номер её с картой не свяжет.
  const first = card(db, 'website', '+998935550000', null);
  db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, ?, 'pending')").run(first, DAY);
  // Вторая (позже): звонок, карта пациента выбрана; запись на 15:00.
  const second = card(db, 'call', '+998901234567', 1);
  db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, ?, 'pending')").run(second, DAY);
  const ph = await book(db, DAY, '15:00', CC);
  const consults = (vid) => db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(vid).map((x) => ({ ...x }));
  assert.equal(consults(ph.visit.id).length, 1);
  await calendarBook(db, { visit_id: ph.visit.id, start: iso(DAY, '15:00'), status: 'cancelled' }, REG);
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(first);
  const v = await book(db, DAY, '10:00', REG);
  assert.deepEqual(consults(v.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }], 'одна консультация, а не две');
});

// ── Ещё не решено — CRM_TWIN_LINE, правило шага 2 зеркала (booking-mirror.js) ──
// Общая причина оставшихся: в шаге 2 сверки строка карточки без строки визита заводит
// свою (или делит чужую) РАНЬШЕ, чем строка другой карточки привезёт свою (перенос) —
// исход зависит от порядка строк (ORDER BY id). Без правки правил зеркала не решается.

test.todo(TWIN + 'карточка сайта (заведена раньше) ждёт укол, по записи звонка регистратура поставила укол ×2; запись отменили и записали снова — должно быть 2 укола (сейчас 3): желание сайта заводит ×1 раньше, чем строка звонка привозит ×2 (шаг 2, порядок строк)');
test.todo(TWIN + 'карточка сайта (заведена раньше) ждёт анализ, по записи звонка — пакетная строка (20 000); запись отменили и записали снова — должна остаться одна пакетная строка (сейчас обе): та же причина, шаг 2');
test.todo(TWIN + 'карточка переносит курс уколов ×10 на день, где другая карточка уже держит укол ×1 в записи, — должно быть 10 уколов (сейчас 11): перенос окном карточки, не отмена — шаг 2 везёт ×10, не сверяясь со строкой зеркала ×1');
test.todo(TWIN + 'консультацию карточки Б перенесли на день, где та же консультация карточки А уже в записи (и так же после слияния А и Б в одну карточку), — в визите должна быть одна консультация (сейчас две): перенос, не отмена — шаг 2 везёт строку, не глядя на homeFor');
test.todo(TWIN + 'строку, которую делят две карточки-дубля, одна из них переносит на день, где та же услуга уже в записи, — визит нового дня должен нести одну строку (сейчас две), а прежний день — свою: перенос общей строки — шаг 2');
