// PUBLIC_API_V1 — УДЕРЖАНИЕ ОНЛАЙН-ЗАПИСИ ЗАНИМАЕТ ВРАЧА, КАК ВИЗИТ: свободные
// начала, запись календаря, ensure_visit и окна для партнёров видят его одинаково;
// истёкшее и снятое — не занимают; подтверждение этой же записи своим
// удержанием не останавливается; чужого врача удержание не трогает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { calendarSlots, calendarBook, doctorDayWindows, slotIsFree } from './calendar.js';
import { ensureVisit } from './visits.js';
import { insertConnectionRow } from '../../test-helpers/api-connection-row.js';

const DAY = '2030-03-12';
const at = (hhmm, day = DAY) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };
const REG = { id: 1, role: 'registrar' };

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (1, 'reg', 'x', 'Регистратор', 'registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7, 'doc', 'x', 'Петров П.П.', 'doctor', 1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (8, 'doc2', 'x', 'Каримов Р.', 'doctor', 1)").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name, phone) VALUES (1, 'P-1', 'Иванов', '+998901112233')").run();
  const conn = insertConnectionRow(db, { name: 'med24.uz' });
  const reqId = Number(db.prepare(`INSERT INTO api_requests (public_id, connection_id, kind, status, doctor_id, start_at, duration_minutes, received_at, hold_until)
    VALUES ('rq_hold0001', ?, 'appointment', 'pending', 7, ?, 30, '2030-03-01T00:00:00Z', '2030-03-12T00:00:00Z')`)
    .run(conn, new Date(at('10:00')).toISOString()).lastInsertRowid);
  const holdId = Number(db.prepare(`INSERT INTO slot_holds (doctor_id, start_at, duration_minutes, until_at, api_request_id, kind)
    VALUES (7, ?, 30, '2030-03-12T00:00:00Z', ?, 'booking')`).run(new Date(at('10:00')).toISOString(), reqId).lastInsertRowid);
  return { db, reqId, holdId };
}
const refusal = async (p) => { try { await p; } catch (e) { return e; } return assert.fail('ожидался отказ'); };

test('свободные начала: удержанное 10:00–10:30 занято; занятость называет подключение и срок, без имени', () => {
  const { db, holdId } = setup();
  const r = calendarSlots(db, { doctor_id: 7, date: DAY, duration_minutes: 15, step_minutes: 15 }, REG);
  const starts = r.slots.map((s) => s.start);
  assert.ok(!starts.includes('10:00') && !starts.includes('10:15'));
  assert.ok(starts.includes('09:45') && starts.includes('10:30'));
  const held = r.busy.find((b) => b.hold_id === holdId);
  assert.deepEqual({ ...held }, { visit_id: null, from: '10:00', to: '10:30', duration_minutes: 30, status: 'held',
    patient_id: null, patient_name: '', hold_id: holdId, held_for: 'med24.uz', held_until: '2030-03-12T00:00:00Z' });
  const other = calendarSlots(db, { doctor_id: 8, date: DAY, duration_minutes: 15, step_minutes: 15 }, REG);
  assert.ok(other.slots.some((s) => s.start === '10:00'), 'у другого врача время свободно');
});

test('запись календаря и ensure_visit на удержанное время — отказ «время занято»; визит не заводится', async () => {
  const { db } = setup();
  const e1 = await refusal(calendarBook(db, { patient_id: 1, doctor_id: 7, start: new Date(at('10:15')).toISOString(), duration_minutes: 15 }, REG));
  assert.equal(e1.status, 409);
  assert.equal(e1.code, 'slot_taken');
  assert.deepEqual(e1.params, { doctor: 'Петров П.П.', from: '10:00', to: '10:30' });
  const e2 = await refusal(ensureVisit(db, { patient_id: 1, date: DAY, book: { doctor_id: 7, start: new Date(at('10:00')).toISOString(), duration_minutes: 15 } }, REG));
  assert.equal(e2.code, 'slot_taken');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visits').get().n, 0);
});

test('подтверждение этой же записи: своё удержание не мешает; изнутри сервера, а не из аргументов RPC', async () => {
  const { db, holdId } = setup();
  const viaArgs = await refusal(ensureVisit(db, { patient_id: 1, date: DAY, exclude_hold_id: holdId,
    book: { doctor_id: 7, start: new Date(at('10:00')).toISOString(), duration_minutes: 30, exclude_hold_id: holdId } }, REG));
  assert.equal(viaArgs.code, 'slot_taken', 'присланное в аргументах — не действует');
  const ok = await ensureVisit(db, { patient_id: 1, date: DAY, book: { doctor_id: 7, start: new Date(at('10:00')).toISOString(), duration_minutes: 30 } },
    REG, { excludeHoldId: holdId });
  assert.equal(ok.booked, true);
  assert.equal(Date.parse(ok.visit.visit_date), at('10:00'));
});

test('истёкшее и снятое удержание время не держат', async () => {
  const { db, holdId } = setup();
  db.prepare("UPDATE slot_holds SET until_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(holdId);
  assert.ok(calendarSlots(db, { doctor_id: 7, date: DAY, duration_minutes: 30, step_minutes: 15 }, REG).slots.some((s) => s.start === '10:00'));
  db.prepare("UPDATE slot_holds SET until_at = '2030-03-12T00:00:00Z', released_at = '2030-03-01T00:10:00Z', release_reason = 'declined' WHERE id = ?").run(holdId);
  const bk = await calendarBook(db, { patient_id: 1, doctor_id: 7, start: new Date(at('10:00')).toISOString(), duration_minutes: 30 }, REG);
  assert.equal(bk.created, true);
});

test('окна для партнёров и проверка начала: удержанное не свободно; своё — свободно; вне сетки и прошедшее — нет', () => {
  const { db, holdId } = setup();
  const day = doctorDayWindows(db, { doctorId: 7, dayIso: DAY, durationMin: 15, now: at('08:00') });
  assert.equal(day.windows.find((w) => w.start === '10:00').free, false);
  assert.equal(day.windows.find((w) => w.start === '10:30').free, true);
  const now = at('08:00');
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('10:00'), durationMin: 30, now }), false);
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('10:00'), durationMin: 30, excludeHoldId: holdId, now }), true);
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('09:45'), durationMin: 30, now }), false, '09:45–10:15 задевает удержание');
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('10:30'), durationMin: 30, now }), true);
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('10:37'), durationMin: 15, now }), false, 'вне сетки');
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('17:45'), durationMin: 30, now }), false, 'за концом дня');
  assert.equal(slotIsFree(db, { doctorId: 7, startMs: at('10:30'), durationMin: 30, now: at('11:00') }), false, 'прошло');
});
