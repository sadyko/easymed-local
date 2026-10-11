// PUBLIC_API_V1 — приём заявок и онлайн-записи из очереди публичного сервера:
// карточка CRM с источником подключения и без карты пациента; удержание времени;
// повтор номера — без второй карточки; занятое, закрытое для партнёров и
// опоздавшее — отказ с причиной партнёру; два партнёра на одно время — второй
// получает «время занято»; «Не пришёл» удержанные не трогает. Срок держания —
// 30 рабочих минут клиники от приёма заявки КЛИНИКОЙ (решения владельца 18–19).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSeed, localAt, apptItem } from '../../test-helpers/api-booking-seed.js';
import { ingestItem, expireDue } from './bookings.js';
import { slotIsFree, calendarBook } from '../rpc/calendar.js';
import { crmNoShowSweep } from '../crm/no-show.js';
import { isoOf } from '../../../public/js/shared/api-booking.js';

const NOW = localAt('2030-03-11', '09:00');
const START = localAt('2030-03-12', '10:00');
const item = (s, over = {}) => apptItem({ connId: s.connId, startMs: START, receivedMs: NOW - 60000, ...over });
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

test('онлайн-запись: ждёт подтверждения, время держится 30 минут от приёма клиникой; карточка без карты — источник подключения, первая колонка, строка консультации на день', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, item(s), { now: NOW, kekPath: s.kekPath });
  assert.deepEqual({ applied: r.applied, status: r.status }, { applied: true, status: 'pending' });
  const req = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', r.id);
  assert.deepEqual([req.kind, req.doctor_id, req.consultation_type_id, req.duration_minutes, req.hold_until, req.patient_phone, req.external_id],
    ['appointment', 7, 1, 30, new Date(NOW + 30 * 60000).toISOString().replace('.000', ''), '+998901234567', 'med-1']);
  const card = one(s.db, 'SELECT * FROM crm_requests WHERE id = ?', req.crm_request_id);
  assert.deepEqual([card.full_name, card.phone, card.source, card.sources, card.status, card.patient_id, card.note, card.scheduled_date],
    ['Абдурахмонов Фаррух', '+998901234567', 'api_med24_uz', '["api_med24_uz"]', 'in_process', null, 'Ребёнок 5 лет', '2030-03-12']);
  assert.deepEqual({ ...one(s.db, 'SELECT service_id, consultation_type_id, doctor_id, scheduled_date, status, visit_id FROM crm_request_services WHERE request_id = ?', card.id) },
    { service_id: null, consultation_type_id: 1, doctor_id: 7, scheduled_date: '2030-03-12', status: 'pending', visit_id: null });
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: NOW }), false, 'время держится');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM visits').n, 0, 'визита нет — нет и карты');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM patients').n, 0, 'карту пациента заявка не заводит');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM api_outbox').n, 0, 'ждущей записи партнёр уже знает «pending» от публичного сервера');
});

test('повтор: тот же номер заявки и тот же номер партнёра — без второй карточки и второго удержания', async () => {
  const s = bookingSeed();
  await ingestItem(s.db, item(s), { now: NOW, kekPath: s.kekPath });
  assert.deepEqual(await ingestItem(s.db, item(s), { now: NOW, kekPath: s.kekPath }), { applied: false, duplicate: true });
  assert.deepEqual(await ingestItem(s.db, item(s, { publicId: 'rq_test0002' }), { now: NOW, kekPath: s.kekPath }), { applied: false, duplicate: true });
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM crm_requests').n, 1);
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM slot_holds').n, 1);
});

test('два партнёра на одно время: второй получает отказ «время занято»; карточка всё равно появляется — без даты', async () => {
  const s = bookingSeed();
  await ingestItem(s.db, item(s), { now: NOW, kekPath: s.kekPath });
  const r2 = await ingestItem(s.db, item(s, { publicId: 'rq_test0002', externalId: 'med-2', name: 'Каримов Олим', phone: '+998935550011' }), { now: NOW, kekPath: s.kekPath });
  assert.equal(r2.status, 'declined');
  const req = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', r2.id);
  assert.deepEqual([req.decline_reason, req.hold_until], ['slot_taken', null]);
  const ev = one(s.db, 'SELECT * FROM api_outbox WHERE api_request_id = ?', r2.id);
  assert.equal(ev.event, 'booking.declined');
  const body = JSON.parse(ev.body);
  assert.deepEqual([body.status, body.reason, body.request_id], ['declined', 'slot_taken', 'rq_test0002']);
  assert.ok(!ev.body.includes('Каримов') && !ev.body.includes('935550011'));
  const card = one(s.db, 'SELECT * FROM crm_requests WHERE id = ?', req.crm_request_id);
  assert.equal(card.scheduled_date, null);
  assert.equal(one(s.db, 'SELECT scheduled_date FROM crm_request_services WHERE request_id = ?', card.id).scheduled_date, null);
});

test('занятое визитом, врач скрыт, живая очередь, за горизонтом записи, опоздание клиники — отказ с причиной', async () => {
  const s = bookingSeed();
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Иванов', '+998901112233')").run();
  await calendarBook(s.db, { patient_id: 1, doctor_id: 7, start: new Date(localAt('2030-03-12', '11:00')).toISOString(), duration_minutes: 30 }, s.reg);
  const reasonOf = async (over) => {
    const r = await ingestItem(s.db, item(s, over), { now: NOW, kekPath: s.kekPath });
    return one(s.db, 'SELECT status, decline_reason FROM api_requests WHERE id = ?', r.id);
  };
  assert.deepEqual({ ...(await reasonOf({ publicId: 'rq_busy0001', externalId: 'b1', startMs: localAt('2030-03-12', '11:15') })) }, { status: 'declined', decline_reason: 'slot_taken' });
  assert.deepEqual({ ...(await reasonOf({ publicId: 'rq_live0001', externalId: 'b2', doctorId: 8 })) }, { status: 'declined', decline_reason: 'not_bookable' });
  assert.deepEqual({ ...(await reasonOf({ publicId: 'rq_far00001', externalId: 'b3', startMs: localAt('2030-03-30', '10:00') })) }, { status: 'declined', decline_reason: 'not_bookable' });
  assert.deepEqual({ ...(await reasonOf({ publicId: 'rq_grid0001', externalId: 'b4', startMs: localAt('2030-03-12', '10:07') })) }, { status: 'declined', decline_reason: 'slot_taken' });
  // Решение 19: клиника была без связи, а приём, на который записывались, уже прошёл — «не подтверждено вовремя».
  assert.deepEqual({ ...(await reasonOf({ publicId: 'rq_late0001', externalId: 'b5', receivedMs: localAt('2030-03-10', '20:00'), startMs: localAt('2030-03-11', '08:45') })) }, { status: 'expired', decline_reason: 'expired' });
  s.db.prepare('UPDATE users SET is_public = 0 WHERE id = 7').run();
  assert.deepEqual({ ...(await reasonOf({ publicId: 'rq_hide0001', externalId: 'b6', startMs: localAt('2030-03-12', '15:00') })) }, { status: 'declined', decline_reason: 'not_bookable' });
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM api_outbox WHERE event = ?', 'booking.declined').n, 6);
});

test('заявка «перезвоните»: карточка с услугой без даты; врач — только показанный партнёрам', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, { ...item(s, { publicId: 'rq_call0001' }), type: 'request.new',
    data: { external_id: 'cb-1', service_id: 301, doctor_id: 8, lang: 'uz' } }, { now: NOW });
  const req = one(s.db, 'SELECT * FROM api_requests WHERE id = ?', r.id);
  assert.deepEqual([req.kind, req.status, req.service_id, req.doctor_id, req.lang, req.start_at], ['request', 'new', 301, 8, 'uz', null]);
  assert.deepEqual({ ...one(s.db, 'SELECT service_id, doctor_id, scheduled_date FROM crm_request_services WHERE request_id = ?', req.crm_request_id) },
    { service_id: 301, doctor_id: 8, scheduled_date: null });
  const hidden = await ingestItem(s.db, { ...item(s, { publicId: 'rq_call0002', externalId: 'cb-2' }), type: 'request.new',
    data: { external_id: 'cb-2', service_id: 303 } }, { now: NOW });
  assert.equal(one(s.db, 'SELECT service_id FROM api_requests WHERE id = ?', hidden.id).service_id, null, 'скрытая услуга не ставится');
});

test('разбор: мусор и неизвестное подключение — не применяются и не бросают', async () => {
  const s = bookingSeed();
  assert.deepEqual(await ingestItem(s.db, { type: 'appointment.new', public_id: 'rq_x' }, { now: NOW }), { applied: false, problem: 'public_id' });
  assert.deepEqual(await ingestItem(s.db, item(s, { connId: 99 }), { now: NOW }), { applied: false, problem: 'connection' });
  assert.deepEqual(await ingestItem(s.db, { type: 'appointment.cancel', public_id: 'rq_nothere1', connection_id: s.connId }, { now: NOW }),
    { applied: false, problem: 'unknown_request' });
});

test('«Не пришёл» удержанные не трогает: карточка ждущей записи остаётся в своей колонке и после дня записи', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, item(s), { now: NOW, kekPath: s.kekPath });
  const cardId = one(s.db, 'SELECT crm_request_id AS c FROM api_requests WHERE id = ?', r.id).c;
  assert.deepEqual(crmNoShowSweep(s.db, { day: '2030-03-20' }), []);
  assert.equal(one(s.db, 'SELECT status FROM crm_requests WHERE id = ?', cardId).status, 'in_process');
});

// ─── РЕШЕНИЯ ВЛАДЕЛЬЦА 18–19 (2026-10-11) ───────────────────────────────────

test('решение 19: запись, пролежавшая в очереди 2 часа (клиника была без связи), держится 30 минут от приёма клиникой, а не истекает в миг приёма', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, item(s, { receivedMs: NOW - 2 * 3600000 }), { now: NOW, kekPath: s.kekPath });
  assert.deepEqual([r.status, r.hold_until], ['pending', isoOf(NOW + 30 * 60000)]);
  const req = one(s.db, 'SELECT received_at, picked_at, hold_until FROM api_requests WHERE id = ?', r.id);
  assert.deepEqual({ ...req }, { received_at: isoOf(NOW - 2 * 3600000), picked_at: isoOf(NOW), hold_until: isoOf(NOW + 30 * 60000) },
    'отправлена партнёром два часа назад, принята клиникой сейчас');
  assert.equal(expireDue(s.db, { now: NOW + 29 * 60000, kekPath: s.kekPath }), 0);
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: NOW + 29 * 60000 }), false, 'время держится');
  assert.equal(one(s.db, 'SELECT COUNT(*) AS n FROM api_outbox').n, 0, 'отказа партнёру нет');
});

test('решение 18: ночная запись держится до 08:30 по часам главного здания; суббота вечером — до понедельника; часы не заданы — 30 минут подряд', async () => {
  const s = bookingSeed();
  const HOURS = JSON.stringify(Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { on: true, from: '08:00', to: '18:00' }])));
  s.db.prepare('UPDATE branches SET working_hours = ?, is_24_7 = 0 WHERE id = (SELECT branch_id FROM branch_identity WHERE id = 1)').run(HOURS);
  const night = localAt('2030-03-11', '22:00');   // понедельник
  const r = await ingestItem(s.db, item(s, { receivedMs: night - 60000 }), { now: night, kekPath: s.kekPath });
  assert.deepEqual([r.status, r.hold_until], ['pending', isoOf(localAt('2030-03-12', '08:30'))]);
  assert.equal(expireDue(s.db, { now: night + 31 * 60000, kekPath: s.kekPath }), 0, 'к 22:31 не истекает — регистратура разберёт утром');
  assert.equal(slotIsFree(s.db, { doctorId: 7, startMs: START, durationMin: 30, now: localAt('2030-03-12', '08:20') }), false);
  assert.equal(expireDue(s.db, { now: localAt('2030-03-12', '08:30'), kekPath: s.kekPath }), 1, 'в 08:30 без ответа — истекло');
  const sat = await ingestItem(s.db, item(s, { publicId: 'rq_sat00001', externalId: 'med-sat', startMs: localAt('2030-03-18', '10:00'),
    receivedMs: localAt('2030-03-16', '17:44') }), { now: localAt('2030-03-16', '17:45'), kekPath: s.kekPath });
  assert.deepEqual([sat.status, sat.hold_until], ['pending', isoOf(localAt('2030-03-18', '08:15'))], 'суббота 17:45 → понедельник 08:15: воскресенье закрыто');
  s.db.prepare("UPDATE branches SET working_hours = '{}'").run();
  const plain = await ingestItem(s.db, item(s, { publicId: 'rq_plain0001', externalId: 'med-plain', startMs: localAt('2030-03-19', '10:00'),
    receivedMs: night }), { now: night, kekPath: s.kekPath });
  assert.equal(plain.hold_until, isoOf(night + 30 * 60000), 'часы здания не заданы — 30 минут круглые сутки');
});

// ─── РЕВЬЮ 8a, C1: ЭЛЕМЕНТ, КОТОРЫЙ НЕЛЬЗЯ СОХРАНИТЬ КАК ЕСТЬ ───────────────
// Пока заявка ждала в очереди (клиника без связи — решение 19), врача, пакет
// или здание могли удалить, а услугу — сделать длиной 3 или 600 минут. Приём не
// бросает: такой элемент принимается — отказом партнёру или без лишнего поля.

test('C1: врача удалили, пока заявка ждала, — отказ «запись не открыта», заявка сохранена без врача; ничего не бросает', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, item(s, { doctorId: 999 }), { now: NOW, kekPath: s.kekPath });
  assert.deepEqual([r.applied, r.status], [true, 'declined']);
  const req = one(s.db, 'SELECT doctor_id, decline_reason, start_at, duration_minutes, crm_request_id FROM api_requests WHERE id = ?', r.id);
  assert.deepEqual([req.doctor_id, req.decline_reason], [null, 'not_bookable']);
  assert.ok(req.start_at && req.duration_minutes >= 5 && req.crm_request_id, 'время, длительность и карточка — для звонка');
  const body = JSON.parse(one(s.db, 'SELECT body FROM api_outbox WHERE api_request_id = ?', r.id).body);
  assert.deepEqual([body.status, body.reason, body.doctor_id], ['declined', 'not_bookable', 999], 'партнёру — его же номер врача');
  assert.equal(one(s.db, 'SELECT doctor_id FROM crm_request_services WHERE request_id = ?', req.crm_request_id), undefined, 'без врача и вида — строки нет');
});

test('C1: незнакомые здание и пакет не сохраняются — запись принимается без них; заявка «перезвоните» — тоже', async () => {
  const s = bookingSeed();
  const a = item(s);
  a.data.branch_id = 999;
  a.data.package_id = 4242;
  const r = await ingestItem(s.db, a, { now: NOW, kekPath: s.kekPath });
  assert.equal(r.status, 'pending');
  assert.deepEqual({ ...one(s.db, 'SELECT branch_id, package_id FROM api_requests WHERE id = ?', r.id) }, { branch_id: null, package_id: null });
  const cb = await ingestItem(s.db, { ...item(s, { publicId: 'rq_call0001', externalId: 'cb-1' }), type: 'request.new',
    data: { external_id: 'cb-1', package_id: 4242 } }, { now: NOW });
  assert.deepEqual([cb.applied, cb.status, one(s.db, 'SELECT package_id FROM api_requests WHERE id = ?', cb.id).package_id], [true, 'new', null]);
});

test('C1: услуга короче 5 минут — держится 5 (меньше календарь не записывает); длиннее 480 — отказ «запись не открыта»', async () => {
  const s = bookingSeed();
  s.db.prepare('UPDATE services SET duration_minutes = 3 WHERE id = 301').run();
  const short = await ingestItem(s.db, item(s, { publicId: 'rq_dur00003', externalId: 'd3', consultation: '', serviceId: 301 }), { now: NOW, kekPath: s.kekPath });
  assert.equal(short.status, 'pending');
  assert.equal(one(s.db, 'SELECT duration_minutes FROM api_requests WHERE id = ?', short.id).duration_minutes, 5);
  assert.equal(one(s.db, 'SELECT duration_minutes FROM slot_holds WHERE api_request_id = ?', short.id).duration_minutes, 5);
  s.db.prepare('UPDATE services SET duration_minutes = 600 WHERE id = 301').run();
  const long = await ingestItem(s.db, item(s, { publicId: 'rq_dur00600', externalId: 'd600', consultation: '', serviceId: 301,
    startMs: localAt('2030-03-12', '12:00') }), { now: NOW, kekPath: s.kekPath });
  assert.equal(long.status, 'declined');
  assert.deepEqual({ ...one(s.db, 'SELECT decline_reason, duration_minutes FROM api_requests WHERE id = ?', long.id) },
    { decline_reason: 'not_bookable', duration_minutes: 480 });
});

test('C1: отмена записанной, когда календарь отказывает в отмене, — не бросает: пометка «решите вручную»', async () => {
  const s = bookingSeed();
  const r = await ingestItem(s.db, item(s), { now: NOW, kekPath: s.kekPath });
  s.db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Абдурахмонов Фаррух', '+998901234567')").run();
  const { confirmBooking } = await import('./bookings.js');
  const c = await confirmBooking(s.db, { id: r.id, patientId: 1 }, s.reg, { now: NOW, kekPath: s.kekPath });
  // Календарь отказывает в отмене (здесь — запретом в самой базе): отмена не должна
  // ронять очередь — элемент принимается пометкой для регистратуры.
  s.db.exec("CREATE TRIGGER zz_no_cancel BEFORE UPDATE OF status ON visits WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'отмена запрещена'); END");
  const out = await ingestItem(s.db, { type: 'appointment.cancel', cursor: '5', public_id: 'rq_test0001', connection_id: s.connId }, { now: NOW + 60000, kekPath: s.kekPath });
  assert.deepEqual([out.applied, out.needs_staff], [true, true]);
  assert.ok(one(s.db, 'SELECT partner_cancel_at FROM api_requests WHERE id = ?', r.id).partner_cancel_at);
});
