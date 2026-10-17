// CRM_UNIFY_V1 — СТРОКИ-ДВОЙНИКИ ЗАПИСИ. CRM_ONE_WAY_V1 (2026-10-17) — РЕШЕНО КОРНЕМ.
//
// Две карточки одного пациента держат одну и ту же услугу на один день, а запись по
// одной из них отменяют или переносят: двусторонняя копия (зеркало записи, mirrorVisit)
// ввозила в визит нового дня вторую строку той же услуги (двойной счёт) или оставляла
// строку ×1 вместо строки регистратуры (×N, пакет, своя цена). Четыре круга правок зеркала
// (CRM_TWIN_LINE: a657cc23, e0e6f44e, 9140fbe6, d6630801) каждый ломал другой случай.
//
// CRM_ONE_WAY_V1 (docs/specs/2026-10-17-crm-one-way-booking-design.md) убрал копию: услуга
// записи живёт только в визите, карточка держит желания и строки записи — указатели на
// строку визита. Отсюда ожидания ниже:
//   • O2 — строки регистратуры не копируются в карточку: отменили запись — в карточке их нет,
//     и новая запись их не получает (они остаются в отменённом визите как история, O4);
//   • O4 — отмена отпускает строки записи в карточку без дня: ни одна запись того же дня их
//     сама не берёт; новая запись получает только датированные желания (O1, одна строка);
//   • O6 / O3 — строку записи из карточки не переносят (отказ двери /api/db): перенос — в
//     календаре (строки едут с визитом, количество и пакет при строке), убрать услугу из
//     записи — крестиком (O3), добавить в другую запись — желание садится в неё (O1) и на
//     строку той же услуги указывает, а не заводит вторую.
// Деньги: в каждом тесте сверяются строки визитов (количество, цена, пакет).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { ensureVisit } from '../rpc/visits.js';
import { calendarBook } from '../rpc/calendar.js';
import { crmMergeLeads } from '../rpc/crm-merge.js';
import { onVisitLinesAdded, bookedLineEditRefusal, BOOKED_LINE_LOCKED, removeFromBooking, attachCardLines } from './one-way.js';

const at = (day, hhmm) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const iso = (day, hhmm) => new Date(at(day, hhmm)).toISOString();
const DAY = '2030-03-12';
const D1 = '2030-03-11';
const D2 = '2030-03-14';
const CC = { id: 3, role: 'callcenter' };
const REG = { id: 2, role: 'registrar' };
const BOSS = { id: 1, role: 'admin' };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?, ?, ?, ?, ?, ?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin', 0);
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
const consults = (db, vid) => db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(vid).map((x) => ({ ...x }));
const card = (db, source, phone, patientId, day = DAY) => Number(db.prepare(`INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date)
  VALUES ('Каримов Азиз', ?, ?, 'in_process', ?, ?)`).run(phone, source, patientId, day).lastInsertRowid);
const wants = (db, requestId, serviceId, day = DAY) => Number(db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, ?, ?, 'pending')").run(requestId, serviceId, day).lastInsertRowid);
const wantsConsult = (db, requestId, day = DAY) => Number(db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, ?, 'pending')").run(requestId, day).lastInsertRowid);
const book = (db, day, hhmm, user) => ensureVisit(db, { patient_id: 1, date: iso(day, hhmm), doctor_id: 7, book: { doctor_id: 7, start: iso(day, hhmm), duration_minutes: 30 } }, user);
const lineRow = (db, id) => db.prepare('SELECT * FROM crm_request_services WHERE id = ?').get(id);
// Регистратура добавляет строку в окне визита — как /api/db: запись, затем правило CRM_ONE_WAY_V1
// (строка CRM той же услуги уступает строке человека, сбывшееся желание указывает на неё).
function regAdd(db, visitId, serviceId, { quantity = 1, unit = null, packageId = null } = {}) {
  const price = unit ?? db.prepare('SELECT price FROM services WHERE id = ?').get(serviceId).price;
  const id = Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by, package_id)
                                VALUES (?, ?, ?, ?, ?, 'added', 2, ?)`).run(visitId, serviceId, quantity, price, price * quantity, packageId).lastInsertRowid);
  onVisitLinesAdded(db, visitId, [id]);
  return id;
}
const cancel = (db, vid, day, hhmm) => calendarBook(db, { visit_id: vid, start: iso(day, hhmm), status: 'cancelled' }, REG);
// Окно карточки: убрать услугу из записи (×) — строка 'cancelled' дверью /api/db, затем O3.
function cardRemoves(db, lineId) {
  const l = lineRow(db, lineId);
  db.prepare("UPDATE crm_request_services SET status = 'cancelled' WHERE id = ?").run(lineId);
  removeFromBooking(db, [{ lineId, vsId: l.visit_service_id }]);
}
// Окно карточки: новая услуга на день записи — вставка с visit_id этой записи, затем O1.
function cardAddsToBooking(db, requestId, visitId, { serviceId = null, consult = false, day }) {
  const id = Number(db.prepare(`INSERT INTO crm_request_services (request_id, service_id, consultation_type_id, doctor_id, scheduled_date, status, visit_id)
                                VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(requestId, serviceId, consult ? 1 : null, consult ? 7 : null, day, visitId).lastInsertRowid);
  attachCardLines(db, [id], { actorId: 3 });
  return id;
}

// ── Отмена и повторная запись ───────────────────────────────────────────────

test('CRM_ONE_WAY_V1 (O2, O4): два анализа глюкозы регистратуры в записи звонка; запись отменили и записали снова — новая запись их не получает, отменённая держит обе строки', async () => {
  const db = clinic();
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  regAdd(db, w.visit.id, 40);
  regAdd(db, w.visit.id, 40);
  const before = live(db, w.visit.id, 40);
  assert.equal(before.length, 2);
  await cancel(db, w.visit.id, DAY, '15:00');
  const v = await book(db, DAY, '10:00', REG);
  assert.notEqual(v.visit.id, w.visit.id);
  assert.deepEqual(live(db, v.visit.id, 40), [], 'строки регистратуры не карточки — в новую запись не едут (O2)');
  assert.deepEqual(live(db, w.visit.id, 40), before, 'отменённая запись — история (O4)');
});

test('CRM_ONE_WAY_V1 (O4, O1): укол ×2 регистратуры по записи звонка, карточка сайта (заведена позже) ждёт укол; запись отменили и записали снова — в новой записи один укол сайта, ×2 остался в отменённой', async () => {
  const db = clinic();
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  regAdd(db, w.visit.id, 41, { quantity: 2 });
  const site = card(db, 'website', '+998935550000', null);
  wants(db, site, 41);
  await cancel(db, w.visit.id, DAY, '15:00');
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
  const v = await book(db, DAY, '10:00', REG);
  assert.deepEqual(live(db, v.visit.id, 41).map((r) => [r.quantity, r.unit_price]), [[1, 20000]]);
  assert.equal(units(live(db, w.visit.id, 41)), 2);
});

test('CRM_ONE_WAY_V1 (O4, O1): пакетная строка регистратуры, карточка сайта (заведена позже) ждёт тот же анализ; запись отменили и записали снова — одна строка желания по цене каталога, пакетная осталась в отменённой', async () => {
  const db = clinic();
  db.prepare("INSERT INTO service_templates (id, name, discount_percent, is_package, discount_mode, discount_value) VALUES (9, 'Check-up', 50, 1, 'percent', 50)").run();
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  const pk = regAdd(db, w.visit.id, 40, { unit: 20000, packageId: 9 });
  db.prepare('UPDATE visit_services SET package_full = 40000, package_price = 20000 WHERE id = ?').run(pk);
  const site = card(db, 'website', '+998935550000', null);
  wants(db, site, 40);
  await cancel(db, w.visit.id, DAY, '15:00');
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
  const v = await book(db, DAY, '10:00', REG);
  assert.deepEqual(live(db, v.visit.id, 40).map((r) => [r.package_id, r.unit_price]), [[null, 40000]], 'один анализ, а не два');
  assert.deepEqual(live(db, w.visit.id, 40).map((r) => [r.id, r.package_id]), [[pk, 9]]);
});

test('CRM_ONE_WAY_V1 (O4): две карточки ждут одну консультацию (сайт раньше звонка), запись по звонку на 15:00 отменили, пациента записали на 10:00 — одна консультация, строка звонка ждёт без дня', async () => {
  const db = clinic();
  const first = card(db, 'website', '+998935550000', null);
  wantsConsult(db, first);
  const second = card(db, 'call', '+998901234567', 1);
  const callLine = wantsConsult(db, second);
  const ph = await book(db, DAY, '15:00', CC);
  assert.equal(consults(db, ph.visit.id).length, 1);
  await cancel(db, ph.visit.id, DAY, '15:00');
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(first);
  const v = await book(db, DAY, '10:00', REG);
  assert.deepEqual(consults(db, v.visit.id), [{ consultation_type_id: 1, unit_price: 150000 }], 'одна консультация, а не две');
  const r = lineRow(db, callLine);
  assert.deepEqual([r.status, r.scheduled_date, r.visit_id, r.released_from_visit_id], ['pending', null, null, ph.visit.id]);
});

// ── Прежние todo CRM_TWIN_LINE — теперь настоящие тесты ─────────────────────

test('CRM_ONE_WAY_V1 (бывший todo 1): карточка сайта (заведена раньше) ждёт укол, по записи звонка регистратура поставила укол ×2; запись отменили и записали снова — один укол, а не три', async () => {
  const db = clinic();
  const site = card(db, 'website', '+998935550000', null);
  wants(db, site, 41);
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  regAdd(db, w.visit.id, 41, { quantity: 2 });
  await cancel(db, w.visit.id, DAY, '15:00');
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
  const v = await book(db, DAY, '10:00', REG);
  assert.equal(units(live(db, v.visit.id, 41)), 1, 'было 3: желание сайта ×1 + привезённый ×2');
  assert.equal(units(live(db, w.visit.id, 41)), 2, '×2 при своей (отменённой) записи');
});

test('CRM_ONE_WAY_V1 (бывший todo 2): карточка сайта (заведена раньше) ждёт анализ, по записи звонка — пакетная строка; запись отменили и записали снова — в новой записи одна строка', async () => {
  const db = clinic();
  db.prepare("INSERT INTO service_templates (id, name, discount_percent, is_package, discount_mode, discount_value) VALUES (9, 'Check-up', 50, 1, 'percent', 50)").run();
  const site = card(db, 'website', '+998935550000', null);
  wants(db, site, 40);
  card(db, 'call', '+998901234567', 1);
  const w = await book(db, DAY, '15:00', CC);
  const pk = regAdd(db, w.visit.id, 40, { unit: 20000, packageId: 9 });
  await cancel(db, w.visit.id, DAY, '15:00');
  db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(site);
  const v = await book(db, DAY, '10:00', REG);
  assert.equal(live(db, v.visit.id, 40).length, 1, 'было две: желание сайта и привезённая пакетная');
  assert.deepEqual(live(db, w.visit.id, 40).map((r) => r.id), [pk]);
});

test('CRM_ONE_WAY_V1 (бывший todo 3): курс ×10 карточки нельзя перенести из карточки на день, где другая карточка держит укол ×1 — отказ, 10 и 1 при своих записях; перенос записи в календаре везёт ×10 с визитом', async () => {
  const db = clinic();
  const site = card(db, 'website', '+998935550000', 1, DAY);
  wants(db, site, 41, DAY);
  const v = await book(db, DAY, '10:00', CC);
  assert.equal(units(live(db, v.visit.id, 41)), 1);
  const call = card(db, 'call', '+998901234567', 1, D1);
  const callLine = wants(db, call, 41, D1);
  const w = await book(db, D1, '15:00', CC);
  regAdd(db, w.visit.id, 41, { quantity: 10 });   // курс: строка CRM ×1 уступает строке регистратуры ×10
  assert.deepEqual(live(db, w.visit.id, 41).map((r) => r.quantity), [10]);
  assert.equal(lineRow(db, callLine).visit_service_id, live(db, w.visit.id, 41)[0].id);
  assert.equal(bookedLineEditRefusal(db, [callLine], { scheduled_date: DAY, visit_id: null }), BOOKED_LINE_LOCKED);
  assert.equal(units(live(db, v.visit.id, 41)), 1);
  assert.equal(units(live(db, w.visit.id, 41)), 10);
  // перенос записи — в календаре: визит уезжает на D2 вместе со строкой ×10, строка карточки следует (O6)
  await calendarBook(db, { visit_id: w.visit.id, start: iso(D2, '15:00') }, REG);
  assert.deepEqual(live(db, w.visit.id, 41).map((r) => r.quantity), [10]);
  assert.deepEqual([lineRow(db, callLine).visit_id, lineRow(db, callLine).scheduled_date], [w.visit.id, D2]);
});

test('CRM_ONE_WAY_V1 (бывший todo 4): консультацию карточки Б «перенести» на день записи карточки А — отказ; убрать (×) и добавить в запись А — одна консультация; после слияния А и Б — тоже одна', async () => {
  const db = clinic();
  const a = card(db, 'call', '+998901234567', 1, DAY);
  wantsConsult(db, a, DAY);
  const v = await book(db, DAY, '10:00', CC);
  const b = card(db, 'website', '+998901234567', 1, D1);   // тот же номер — дубль, который можно слить
  const bLine = wantsConsult(db, b, D1);
  const w = await book(db, D1, '15:00', CC);
  assert.equal(consults(db, w.visit.id).length, 1);
  assert.equal(bookedLineEditRefusal(db, [bLine], { scheduled_date: DAY, visit_id: null }), BOOKED_LINE_LOCKED);
  cardRemoves(db, bLine);
  assert.deepEqual(consults(db, w.visit.id), [], 'свободная строка ушла из записи Б (O3)');
  cardAddsToBooking(db, b, v.visit.id, { consult: true, day: DAY });
  assert.equal(consults(db, v.visit.id).length, 1, 'желание Б указывает на консультацию А, второй нет (O1)');
  await crmMergeLeads(db, { keep_id: a, merge_ids: [b] }, BOSS);
  assert.equal(consults(db, v.visit.id).length, 1, 'после слияния — одна консультация');
});

test('CRM_ONE_WAY_V1 (бывший todo 5): строку, которую делят две карточки-дубля, одна из них «переносит» на день, где та же услуга уже в записи, — отказ; убрать и добавить — в каждом дне одна строка', async () => {
  const db = clinic();
  const a = card(db, 'call', '+998901234567', 1, DAY);
  const b = card(db, 'website', '+998935550000', 1, DAY);
  wants(db, a, 41, DAY);
  const bLine = wants(db, b, 41, DAY);
  const v = await book(db, DAY, '10:00', CC);
  assert.equal(live(db, v.visit.id, 41).length, 1, 'одна строка на две карточки');
  const c = card(db, 'call', '+998901234567', 1, D1);
  wants(db, c, 41, D1);
  const w = await book(db, D1, '15:00', CC);
  assert.equal(live(db, w.visit.id, 41).length, 1);
  assert.equal(bookedLineEditRefusal(db, [bLine], { scheduled_date: D1, visit_id: null }), BOOKED_LINE_LOCKED);
  cardRemoves(db, bLine);
  assert.equal(live(db, v.visit.id, 41).length, 1, 'общая строка осталась: её ждёт карточка А');
  cardAddsToBooking(db, b, w.visit.id, { serviceId: 41, day: D1 });
  assert.equal(live(db, w.visit.id, 41).length, 1, 'желание Б указывает на строку того дня');
  assert.equal(live(db, v.visit.id, 41).length, 1);
});
