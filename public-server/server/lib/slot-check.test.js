// PUBLIC_SERVER_V1 — свободное время по присланному: N окон подряд без разрыва,
// прошедшее сегодня — занято, за пределами присланного — решит клиника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayWindows, slotState, windowsNeeded } from './slot-check.js';
import { localMsOf } from './time.js';

const OFF = 300;
const NOW = localMsOf('2030-03-11', '09:00', OFF);
const day = { date: '2030-03-12', from: '09:00', to: '12:00', starts: ['09:00', '09:15', '09:30', '09:45', '11:00', '11:15'], free: '110111' };
const slots = { generated_at: '2030-03-11T03:59:00Z', slot_minutes: 15, doctors: { 7: { reception: 'booking', days: [day] } } };
const doctor = { id: 7, booking_days: 14 };
const at = (d, hhmm) => localMsOf(d, hhmm, OFF);

test('окна подряд: 30 минут — два свободных окна без разрыва', () => {
  assert.equal(windowsNeeded(30), 2);
  assert.equal(windowsNeeded(null), 1);
  assert.equal(windowsNeeded(20), 2);
  assert.deepEqual(dayWindows(day, null, { now: NOW, offsetMin: OFF }).map((w) => w.free), [true, true, false, true, true, true]);
  assert.deepEqual(dayWindows(day, 2, { now: NOW, offsetMin: OFF }).map((w) => w.start), ['09:00', '11:00'], '09:45 + 11:00 — разрыв, не подряд');
});

test('сегодня прошедшее — занято', () => {
  const today = { ...day, date: '2030-03-11' };
  assert.deepEqual(dayWindows(today, null, { now: at('2030-03-11', '09:20'), offsetMin: OFF }).map((w) => w.free), [false, false, false, true, true, true]);
});

test('начало записи: свободно / занято / вне присланного — решит клиника', () => {
  const o = { now: NOW, offsetMin: OFF };
  assert.equal(slotState(slots, doctor, at('2030-03-12', '09:00'), 2, o), 'free');
  assert.equal(slotState(slots, doctor, at('2030-03-12', '09:15'), 2, o), 'taken', '09:30 занято');
  assert.equal(slotState(slots, doctor, at('2030-03-12', '10:00'), 1, o), 'taken', 'не начало сетки — не рабочее');
  assert.equal(slotState(slots, doctor, at('2030-03-13', '10:00'), 1, o), 'taken', 'в пределах присланного дня нет — врач не работает');
  assert.equal(slotState(slots, doctor, at('2030-03-26', '10:00'), 1, o), 'unknown', 'за пределами присланных 14 дней');
  assert.equal(slotState(slots, { id: 8, booking_days: 14 }, at('2030-03-12', '09:00'), 1, o), 'unknown', 'нет времени врача');
});
