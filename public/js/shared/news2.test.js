// VITALS_NEWS_V1 — NEWS2: границы каждого параметра, уровни, неполное измерение.
import test from 'node:test';
import assert from 'node:assert/strict';
import { news2Score, vitalError, NEWS_BANDS, CONSCIOUSNESS } from './news2.js';

const pts = (v) => news2Score(v).parts;

test('очки по каждому параметру — по таблице NEWS2, включая границы', () => {
  assert.deepEqual([8, 9, 11, 12, 20, 21, 24, 25].map((resp_rate) => pts({ resp_rate }).resp_rate), [3, 1, 1, 0, 0, 2, 2, 3]);
  assert.deepEqual([91, 92, 93, 94, 95, 96].map((spo2) => pts({ spo2 }).spo2), [3, 2, 2, 1, 1, 0]);
  assert.deepEqual([90, 91, 100, 101, 110, 111, 219, 220].map((bp_sys) => pts({ bp_sys }).bp_sys), [3, 2, 2, 1, 1, 0, 0, 3]);
  assert.deepEqual([40, 41, 50, 51, 90, 91, 110, 111, 130, 131].map((pulse_bpm) => pts({ pulse_bpm }).pulse_bpm), [3, 1, 1, 0, 0, 1, 1, 2, 2, 3]);
  assert.deepEqual([35.0, 35.1, 36.0, 36.1, 38.0, 38.1, 39.0, 39.1].map((temp_c) => pts({ temp_c }).temp_c), [3, 1, 1, 0, 0, 1, 1, 2]);
  assert.equal(pts({ on_oxygen: 1 }).on_oxygen, 2);
  assert.equal(pts({ on_oxygen: 0 }).on_oxygen, 0);
  assert.equal(pts({ consciousness: 'alert' }).consciousness, 0);
  for (const c of CONSCIOUSNESS.filter((x) => x !== 'alert')) assert.equal(pts({ consciousness: c }).consciousness, 3, c);
});

test('сумма и уровень: пример владельца — 5 баллов = средний риск; 7 — высокий; одна тройка — низко-средний', () => {
  // Скриншот: ЧДД 21 (+2), SpO₂ 94 (+1), 38,1 (+1), АД 138 (0), пульс 104 (+1), ясное, без O₂ → 5.
  const s = news2Score({ resp_rate: 21, spo2: 94, temp_c: 38.1, bp_sys: 138, bp_dia: 88, pulse_bpm: 104, consciousness: 'alert', on_oxygen: 0 });
  assert.equal(s.total, 5);
  assert.equal(s.band, 'medium');
  assert.equal(s.complete, true);
  assert.equal(s.red, false);

  assert.equal(news2Score({ resp_rate: 26, spo2: 90, temp_c: 36.6, bp_sys: 120, pulse_bpm: 80, consciousness: 'alert' }).band, 'medium', '3 + 3 = 6 — ещё средний');
  assert.equal(news2Score({ resp_rate: 26, spo2: 90, temp_c: 36.6, bp_sys: 120, pulse_bpm: 135, consciousness: 'alert' }).band, 'high', '9 — высокий');
  const one3 = news2Score({ resp_rate: 8, spo2: 97, temp_c: 36.6, bp_sys: 120, pulse_bpm: 80, consciousness: 'alert' });
  assert.equal(one3.total, 3);
  assert.equal(one3.red, true);
  assert.equal(one3.band, 'low_medium');
  assert.equal(news2Score({ resp_rate: 16, spo2: 98, temp_c: 36.6, bp_sys: 120, pulse_bpm: 70, consciousness: 'alert' }).band, 'none');
  assert.equal(news2Score({ resp_rate: 16, spo2: 95, temp_c: 36.6, bp_sys: 120, pulse_bpm: 70, consciousness: 'alert' }).band, 'low');
  for (const b of Object.keys(NEWS_BANDS)) assert.ok(NEWS_BANDS[b].label && NEWS_BANDS[b].advice, b);
});

test('неполное измерение считается по тому, что есть, и помечено неполным; пустое — без уровня', () => {
  const s = news2Score({ temp_c: 39.5, pulse_bpm: 115 });
  assert.equal(s.total, 4);
  assert.equal(s.measured, 2);
  assert.equal(s.complete, false);
  assert.equal(s.parts.spo2, null);
  const empty = news2Score({});
  assert.equal(empty.total, 0);
  assert.equal(empty.band, 'none');
  assert.equal(empty.measured, 0);
});

test('проверка ввода: диапазоны физически возможного, целые там, где нужно, запятая как точка', () => {
  assert.equal(vitalError('temp_c', '38,4'), null);
  assert.equal(vitalError('temp_c', '48'), 'от 30 до 45');
  assert.equal(vitalError('spo2', '101'), 'от 50 до 100');
  assert.equal(vitalError('pulse_bpm', '72.5'), 'целое число');
  assert.equal(vitalError('resp_rate', 'abc'), 'не число');
  assert.equal(vitalError('resp_rate', ''), null, 'пустое поле — не ошибка: измерили не всё');
  assert.equal(vitalError('unknown', '1'), null);
});

test('запятая как десятичный знак считается так же, как точка — экран отдаёт сырой ввод', () => {
  assert.equal(news2Score({ temp_c: '39,2', pulse_bpm: '118', resp_rate: '26' }).total, 7);
  assert.equal(news2Score({ temp_c: '39,2' }).parts.temp_c, 2);
});
