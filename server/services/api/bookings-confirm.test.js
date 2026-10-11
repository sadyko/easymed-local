// PUBLIC_API_V1 — ПОДТВЕРЖДЕНИЕ ОНЛАЙН-ЗАПИСИ: регистратор выбрал карту — визит
// заводит ensure_visit (та же дверь, что у регистратуры): ровно один визит на
// выбранное время, строка консультации по цене кассы, карточка привязана,
// удержание снято, партнёр получает «booking.confirmed». Истёкшее не
// подтверждается; визит дня с работой — отказ до первой записи; гонка двух
// подтверждающих — один визит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, confirmBooking, expireDue } from './bookings.js';
import { slotIsFree, calendarBook } from '../rpc/calendar.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const one = (db, sql, ...a) => db.prepare(sql).get(...a);
const refusal = async (p) => { try { await p; } catch (e) { return e; } return assert.fail('ожидался отказ'); };

async function pending(s, over = {}) {
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000, ...over }), { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  return r.id;
}
const patient = (s, id = 1, name = 'Абдурахмонов Фаррух') =>
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (?, ?, ?, '+998901234567')").run(id, 'P-' + id, name);

test('подтверждение: один визит на выбранное время у выбранного врача; строка консультации по общей цене вида; карточка привязана; удержание снято; партнёру — booking.confirmed', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const out = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const visits = s.db.prepare('SELECT * FROM visits').all();
  assert.equal(visits.length, 1);
  const v = visits[0];
  assert.deepEqual([v.patient_id, v.doctor_id, Date.parse(v.visit_date), v.duration_minutes, v.status], [1, 7, START, 30, 'scheduled']);
  assert.equal(out.visit.id, v.id);
  const req = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', id);
  assert.deepEqual([req.status, req.visit_id, req.patient_id, req.handled_by], ['confirmed', v.id, 1, 2]);
  const line = one(s.db, 'SELECT consultation_type_id, doctor_id, unit_price, status FROM visit_services WHERE visit_id = ?', v.id);
  assert.deepEqual({ ...line }, { consultation_type_id: 1, doctor_id: 7, unit_price: 150000, status: 'added' }, 'цена — как у кассы (решение 8)');
  const card = one(s.db, 'SELECT * FROM crm_requests WHERE id = ?', req.crm_request_id);
  assert.equal(card.patient_id, 1);
  assert.equal(card.status, 'scheduled', 'карточка — в «Колонке записи», как у записи колл-центра');
  assert.equal(one(s.db, 'SELECT visit_id FROM crm_request_services WHERE request_id = ?', card.id).visit_id, v.id);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM slot_holds WHERE api_request_id = ? AND released_at IS NULL', id).n, 0);
  assert.equal(one(s.db, 'SELECT release_reason FROM slot_holds WHERE api_request_id = ?', id).release_reason, 'confirmed');
  const ev = one(s.db, "SELECT * FROM api_outbox WHERE event = 'booking.confirmed'");
  const body = JSON.parse(ev.body);
  assert.deepEqual([body.status, body.request_id, body.doctor_id], ['booked', 'rq_test0001', 7]);
  assert.match(body.start, /^2030-03-12T10:00:00\+\d\d:\d\d$/);
  assert.ok(ev.signature.startsWith('sha256='));
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: NOW }), false, 'теперь время держит визит');
});

test('повторное подтверждение — тот же визит; два подтверждающих одновременно — один визит', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const [a, b] = await Promise.allSettled([
    confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }),
    confirmBooking(s.db, { id, patientId: 1 }, s.cc, { now: NOW, kekPath: s.kekPath }),
  ]);
  const ok = [a, b].filter((x) => x.status === 'fulfilled');
  assert.ok(ok.length >= 1);
  for (const x of [a, b]) if (x.status === 'rejected') assert.equal(x.reason.code, 'busy');
  const again = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  assert.equal(again.already, true);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits').n, 1);
  assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM api_outbox WHERE event = 'booking.confirmed'").n, 1);
});

test('время истекло: подтверждения нет, итог «expired», партнёру — отказ; время свободно', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 31 * 60000, kekPath: s.kekPath }));
  assert.equal(e.code, 'hold_expired');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'expired');
  const body = JSON.parse(one(s.db, "SELECT body FROM api_outbox WHERE event = 'booking.declined'").body);
  assert.deepEqual([body.status, body.reason], ['expired', 'expired']);
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: NOW }), true);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits').n, 0);
  assert.equal(expireDue(s.db, { now: NOW + 40 * 60000, kekPath: s.kekPath }), 0, 'второй проход ничего не находит');
});

test('визит дня с работой: отказ до первой записи — строки заявки не уходят в чужую смету, карточку отказ не трогает', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const dv = await calendarBook(s.db, { patient_id: 1, doctor_id: 8, start: new Date(localAt('2030-03-12', '08:00')).toISOString(), duration_minutes: 15 }, s.reg);
  s.db.prepare("INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, total_amount) VALUES (1, 'INV-1', ?, 1, 1000, 1000)").run(dv.visit.id);
  const req = one(s.db, 'SELECT crm_request_id FROM api_requests WHERE id = ?', id);
  // Запись к Каримовой уже связала карточку по номеру (crm/visit-link.js, шаг D) — это правило CRM, не подтверждения.
  const cardBefore = { ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', req.crm_request_id) };
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }));
  assert.equal(e.code, 'day_visit_busy');
  assert.equal(e.status, 409);
  assert.equal(e.params.doctor, 'Каримова Нигора');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'pending');
  assert.deepEqual({ ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', req.crm_request_id) }, cardBefore, 'карточку отказ не тронул');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visit_services WHERE visit_id = ? AND consultation_type_id = 1', dv.visit.id).n, 0, 'консультация заявки не ушла в смету визита Каримовой');
});

test('отказ двери записи (экстренная запись поверх удержания): заявка снова ждёт, карточка без карты, визита нет', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  patient(s, 2, 'Другой Пациент');
  await calendarBook(s.db, { patient_id: 2, doctor_id: 7, start: new Date(START).toISOString(), duration_minutes: 30, emergency: true, emergency_reason: 'боль' }, s.reg);
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', id).c;
  const cardBefore = { ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', cardId) };
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }));
  assert.equal(e.code, 'slot_taken');
  assert.deepEqual({ ...one(s.db, 'SELECT status, patient_id, visit_id FROM api_requests WHERE id = ?', id) }, { status: 'pending', patient_id: null, visit_id: null });
  // PUBLIC_API_V1 — неудача возвращает и карточку: выбранная карта (1) не остаётся на ней.
  assert.deepEqual({ ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', cardId) }, cardBefore, 'карточка — как до подтверждения');
  assert.notEqual(cardBefore.patient_id, 1);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits WHERE patient_id = 1').n, 0);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM slot_holds WHERE api_request_id = ? AND released_at IS NULL', id).n, 1, 'удержание заявки на месте');
});

test('семья на одном номере: карточку по номеру связали с мамой — регистратор выбирает ребёнка, визит и консультация — у ребёнка', async () => {
  const s = bookingSeed();
  const id = await pending(s, { name: 'Абдурахмонова Мадина', comment: 'Записываю дочь' });
  patient(s, 1, 'Абдурахмонова Мадина');
  patient(s, 2, 'Абдурахмонова Лола');
  const req = one(s.db, 'SELECT crm_request_id FROM api_requests WHERE id = ?', id);
  s.db.prepare('UPDATE crm_requests SET patient_id = 1 WHERE id = ?').run(req.crm_request_id);
  const out = await confirmBooking(s.db, { id, patientId: 2 }, s.reg, { now: NOW, kekPath: s.kekPath });
  assert.equal(out.visit.patient_id, 2);
  assert.equal(one(s.db, 'SELECT patient_id FROM crm_requests WHERE id = ?', req.crm_request_id).patient_id, 2);
  assert.deepEqual({ ...one(s.db, 'SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ?', out.visit.id) },
    { consultation_type_id: 1, unit_price: 150000 });
});

test('отказы: не та заявка, без карты, чужая карта, не ждёт', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: null }, s.reg, { now: NOW }))).status, 400);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: 99 }, s.reg, { now: NOW }))).status, 400);
  assert.equal((await refusal(confirmBooking(s.db, { id: 999, patientId: 1 }, s.reg, { now: NOW }))).status, 404);
  s.db.prepare("UPDATE api_requests SET status = 'declined', decline_reason = 'other' WHERE id = ?").run(id);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW }))).status, 409);
});

// ─── РЕВЬЮ 8a, I7: ПОДТВЕРЖДЕНИЕ НЕ ПЕРЕНОСИТ ЧУЖУЮ ЗАПИСЬ ПАЦИЕНТА ─────────

test('I7: у пациента на этот день уже есть запись (без работы) — подтверждение отказывает «day_visit_exists», та запись не сдвинута; заявка ждёт, карточка как была', async () => {
  const s = bookingSeed();
  const { ensureVisit } = await import('../rpc/visits.js');
  const id = await pending(s);
  patient(s);
  const PHONE_AT = localAt('2030-03-12', '15:00');
  const ph = await ensureVisit(s.db, { patient_id: 1, date: new Date(PHONE_AT).toISOString(), doctor_id: 7,
    book: { doctor_id: 7, start: new Date(PHONE_AT).toISOString(), duration_minutes: 30 } }, s.cc);
  assert.equal(ph.booked, true);
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', id).c;
  const cardBefore = { ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', cardId) };
  const e = await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }));
  assert.deepEqual([e.status, e.code], [409, 'day_visit_exists']);
  assert.deepEqual(e.params, { start: '15:00', doctor: 'Петров Пётр Петрович' });
  assert.equal(Date.parse(one(s.db, 'SELECT visit_date FROM visits WHERE id = ?', ph.visit.id).visit_date), PHONE_AT, 'запись 15:00 на месте');
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'pending');
  assert.deepEqual({ ...one(s.db, 'SELECT patient_id, status FROM crm_requests WHERE id = ?', cardId) }, cardBefore);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits').n, 1);
});

// ─── РЕВЬЮ 8a, I8: ЗДАНИЕ ЗАПИСИ — ЗДАНИЕ ВРАЧА, А НЕ ТО, ЧТО НАЗВАЛ ПАРТНЁР ─

test('I8: врач филиала Б, партнёр назвал главное здание — заявка и визит в здании врача (запись в чужое здание, cross_branch Б)', async () => {
  const s = bookingSeed();
  const main = one(s.db, 'SELECT branch_id FROM branch_identity WHERE id = 1').branch_id;
  s.db.prepare("INSERT INTO branches (id, name, letter, active, show_public) VALUES (2, 'Филиал Чиланзар', 'B', 1, 1)").run();
  s.db.prepare('UPDATE users SET branch_id = 2 WHERE id = 7').run();
  const it = apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 });
  it.data.branch_id = main;
  const r = await ingestItem(s.db, it, { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  assert.equal(one(s.db, 'SELECT branch_id FROM api_requests WHERE id = ?', r.id).branch_id, 2, 'здание врача');
  patient(s);
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT cross_branch FROM visits WHERE id = ?', c.visit.id).cross_branch, 'B');
});

test('I8: врач главного здания без приписки, партнёр назвал филиал — заявка без здания, визит не уходит в филиал', async () => {
  const s = bookingSeed();
  s.db.prepare("INSERT INTO branches (id, name, letter, active, show_public) VALUES (2, 'Филиал Чиланзар', 'B', 1, 1)").run();
  const it = apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 });
  it.data.branch_id = 2;
  const r = await ingestItem(s.db, it, { now: NOW, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT branch_id FROM api_requests WHERE id = ?', r.id).branch_id, null);
  patient(s);
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const v = one(s.db, 'SELECT branch_id, cross_branch FROM visits WHERE id = ?', c.visit.id);
  assert.equal(v.cross_branch, '');
  assert.notEqual(v.branch_id, 2);
});

// ─── РЕВЬЮ 8a, M1: ПОДТВЕРЖДЕНИЕ, ПРЕРВАННОЕ ПОСЛЕ ЗАПИСИ ВИЗИТА ────────────

test('M1: процесс оборвался после записи визита — фон через 5 минут доводит заявку до «записан» (визит, событие партнёру ровно одно); раньше — не трогает', async () => {
  const s = bookingSeed();
  const { ensureVisit } = await import('../rpc/visits.js');
  const id = await pending(s);
  patient(s);
  let resume;
  const parked = new Promise((res) => { resume = res; });
  const p = confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath,
    ensureVisitImpl: async (...a) => { const out = await ensureVisit(...a); await parked; return out; } });
  for (let i = 0; i < 10; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'confirming');
  expireDue(s.db, { now: NOW + 4 * 60000, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'confirming', 'подтверждение ещё может идти');
  expireDue(s.db, { now: NOW + 6 * 60000, kekPath: s.kekPath });
  const v = one(s.db, 'SELECT id FROM visits');
  assert.deepEqual({ ...one(s.db, 'SELECT status, visit_id, patient_id FROM api_requests WHERE id = ?', id) }, { status: 'confirmed', visit_id: v.id, patient_id: 1 });
  assert.equal(one(s.db, 'SELECT release_reason FROM slot_holds WHERE api_request_id = ?', id).release_reason, 'confirmed');
  // Прерванное «проснулось» (замок обмена освободился) — второго события нет.
  resume();
  const out = await p;
  assert.equal(out.request.status, 'confirmed');
  assert.equal(one(s.db, "SELECT COUNT(*) AS n FROM api_outbox WHERE event = 'booking.confirmed'").n, 1);
});

test('M1: оборвалось до записи визита — заявка снова ждёт, пока время держится; срок вышел — истекла с отказом партнёру', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath, ensureVisitImpl: () => new Promise(() => {}) }).catch(() => {});
  for (let i = 0; i < 5; i += 1) await new Promise((res) => setImmediate(res));
  expireDue(s.db, { now: NOW + 6 * 60000, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'pending');
  s.db.prepare("UPDATE api_requests SET status = 'confirming', updated_at = ? WHERE id = ?").run(new Date(NOW).toISOString(), id);
  expireDue(s.db, { now: NOW + 40 * 60000, kekPath: s.kekPath });
  assert.equal(one(s.db, 'SELECT status FROM api_requests WHERE id = ?', id).status, 'expired');
  assert.equal(JSON.parse(one(s.db, "SELECT body FROM api_outbox WHERE event = 'booking.declined'").body).reason, 'expired');
});

// ─── РЕВЬЮ 8a, M3: ОКНО ПОКАЗЫВАЕТ ЦЕНУ И ИМЯ, КОТОРЫЕ ВОЗЬМЁТ КАССА ─────────

test('M3: своя цена врача, пустая (0), «Бесплатно» и без строки — окно показывает ту же цену, что получит строка визита; своё имя приёма — тоже', async () => {
  const { requestsOfCard } = await import('./bookings.js');
  for (const [label, row] of [['своя 200 000', { price: 200000, is_free: 0, name_ru: 'Приём педиатра' }], ['пустая', { price: null, is_free: 0 }],
    ['бесплатно', { price: 50000, is_free: 1 }], ['без строки', null]]) {
    const s = bookingSeed();
    if (row) s.db.prepare('INSERT INTO doctor_consultation_prices (doctor_id, consultation_type_id, price, available, is_free, name_ru) VALUES (7, 1, ?, 1, ?, ?)').run(row.price, row.is_free, row.name_ru || null);
    const id = await pending(s);
    const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', id).c;
    const shown = requestsOfCard(s.db, cardId, NOW)[0].what;
    patient(s);
    const c = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
    const line = one(s.db, 'SELECT unit_price FROM visit_services WHERE visit_id = ?', c.visit.id);
    assert.equal(shown.price, line.unit_price, label + ': цена окна = цена строки');
    if (row && row.name_ru) assert.equal(shown.name, 'Приём педиатра', label + ': имя приёма врача');
  }
});

test('I8: врач главного здания с припиской, партнёр назвал филиал — визит в здании врача (branch_id главного), не в филиале', async () => {
  const s = bookingSeed();
  const main = one(s.db, 'SELECT branch_id FROM branch_identity WHERE id = 1').branch_id;
  s.db.prepare('UPDATE users SET branch_id = ? WHERE id = 7').run(main);
  s.db.prepare("INSERT INTO branches (id, name, letter, active, show_public) VALUES (2, 'Филиал Чиланзар', 'B', 1, 1)").run();
  const it = apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000 });
  it.data.branch_id = 2;
  const r = await ingestItem(s.db, it, { now: NOW, kekPath: s.kekPath });
  patient(s);
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  assert.deepEqual({ ...one(s.db, 'SELECT branch_id, cross_branch FROM visits WHERE id = ?', c.visit.id) }, { branch_id: main, cross_branch: '' });
});

// ─── ПОВТОРНАЯ ПРОВЕРКА 8a, п. 1: ДЕНЬ МЕНЯЕТ ТОЛЬКО СВОЯ СТРОКА ЗАЯВКИ ─────

test('рр-1: строка анализа на другой день на той же карточке — подтверждение её не трогает и не берёт в визит', async () => {
  const s = bookingSeed();
  const id = await pending(s);
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', id).c;
  s.db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, 301, '2030-03-15', 'pending')").run(cardId);
  patient(s);
  const c = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  assert.deepEqual({ ...one(s.db, 'SELECT scheduled_date, visit_id FROM crm_request_services WHERE request_id = ? AND service_id = 301', cardId) },
    { scheduled_date: '2030-03-15', visit_id: null });
  assert.deepEqual(s.db.prepare('SELECT service_id, consultation_type_id FROM visit_services WHERE visit_id = ?').all(c.visit.id).map((x) => [x.service_id, x.consultation_type_id]), [[null, 1]]);
});

test('рр-1: две онлайн-записи одного номера слиты в одну карточку — каждая подтверждается со своей строкой в своём визите', async () => {
  const { crmMergeLeads } = await import('../rpc/crm-merge.js');
  const s = bookingSeed();
  const D2 = localAt('2030-03-14', '11:00');
  const id1 = await pending(s);
  const r2 = await ingestItem(s.db, apptItem({ connId: s.connId, publicId: 'rq_test0002', externalId: 'med-2', startMs: D2, receivedMs: NOW - 30000,
    consultation: '', serviceId: 302 }), { now: NOW, kekPath: s.kekPath });
  const c1 = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', id1).c;
  const c2 = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r2.id).c;
  crmMergeLeads(s.db, { keep_id: c2, merge_ids: [c1] }, s.admin);
  patient(s);
  const v1 = await confirmBooking(s.db, { id: id1, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const v2 = await confirmBooking(s.db, { id: r2.id, patientId: 1 }, s.reg, { now: NOW + 120000, kekPath: s.kekPath });
  const kinds = (vid) => s.db.prepare('SELECT service_id, consultation_type_id FROM visit_services WHERE visit_id = ?').all(vid).map((x) => [x.service_id, x.consultation_type_id]);
  assert.deepEqual(kinds(v1.visit.id), [[null, 1]]);
  assert.deepEqual(kinds(v2.visit.id), [[302, null]]);
});

// ─── ПОВТОРНАЯ ПРОВЕРКА 8a, п. 4: ОТКАЗ «day_visit_exists», ЗАПИСЬ ОТМЕНИЛИ — ОДНА КОНСУЛЬТАЦИЯ ─

test('рр-4: подтверждение отказало (запись колл-центра на 15:00), её отменили в календаре — подтверждённый визит несёт одну консультацию', async () => {
  const { ensureVisit } = await import('../rpc/visits.js');
  const s = bookingSeed();
  const id = await pending(s);
  patient(s);
  const cc = Number(s.db.prepare("INSERT INTO crm_requests (full_name, phone, source, status, patient_id, scheduled_date) VALUES ('Абдурахмонов Фаррух', '+998901234567', 'call', 'in_process', 1, '2030-03-12')").run().lastInsertRowid);
  s.db.prepare("INSERT INTO crm_request_services (request_id, consultation_type_id, doctor_id, scheduled_date, status) VALUES (?, 1, 7, '2030-03-12', 'pending')").run(cc);
  const PHONE_AT = localAt('2030-03-12', '15:00');
  const ph = await ensureVisit(s.db, { patient_id: 1, date: new Date(PHONE_AT).toISOString(), doctor_id: 7,
    book: { doctor_id: 7, start: new Date(PHONE_AT).toISOString(), duration_minutes: 30 } }, s.cc);
  assert.equal((await refusal(confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath }))).code, 'day_visit_exists');
  await calendarBook(s.db, { visit_id: ph.visit.id, start: new Date(PHONE_AT).toISOString(), status: 'cancelled' }, s.reg);
  const c = await confirmBooking(s.db, { id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  assert.deepEqual(s.db.prepare("SELECT consultation_type_id, unit_price FROM visit_services WHERE visit_id = ? AND status <> 'cancelled'").all(c.visit.id).map((x) => ({ ...x })),
    [{ consultation_type_id: 1, unit_price: 150000 }], 'одна консультация, а не две');
});

// ─── ПОВТОРНАЯ ПРОВЕРКА 8a, п. 5: УСЛУГА — ЦЕНА КАССЫ, А НЕ ПРАЙСА ─────────────

test('рр-5: онлайн-запись на услугу к врачу со своей ценой — окно показывает своё (200 000), как строка визита, а не прайс (180 000)', async () => {
  const { requestsOfCard } = await import('./bookings.js');
  const s = bookingSeed();
  s.db.prepare('UPDATE users SET service_rates = ? WHERE id = 7').run(JSON.stringify([{ service_id: 302, price: 200000 }]));
  const r = await ingestItem(s.db, apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000, consultation: '', serviceId: 302 }), { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  const shown = requestsOfCard(s.db, one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c, NOW)[0].what;
  patient(s);
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW + 60000, kekPath: s.kekPath });
  const billed = one(s.db, 'SELECT unit_price FROM visit_services WHERE visit_id = ? AND service_id = 302', c.visit.id).unit_price;
  assert.deepEqual([shown.price, billed], [200000, 200000]);
});
