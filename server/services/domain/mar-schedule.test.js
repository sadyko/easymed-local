// MAR_SCHEDULE_V1 — расписание листа назначений.
//
// Проверяется то, на чём стоит весь лист: курс разворачивается по ДНЯМ (включая
// последний), отменённое назначение перестаёт рождать точки с момента отмены и
// НЕ теряет те, что уже прошли, а опоздание отличается от пропуска.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FREQUENCIES, FREQ_CODES, ROUTES, freqSlots, isPrnFreq,
  expandCourse, courseEnd, dueState, addDays, daysBetween, dueAtMs, isDate,
} from './mar-schedule.js';

// Плановая точка как местное абсолютное время — тем же способом, каким её
// считает сам модуль, чтобы тест не зависел от пояса машины.
const at = (date, hour, min = 0) => dueAtMs(date, hour) + min * 60000;

// ─── Таблица частот ─────────────────────────────────────────────────────────

test('таблица частот — ровно те часы, что назначены планом', () => {
  assert.deepEqual(freqSlots('1x'), [10]);
  assert.deepEqual(freqSlots('2x'), [10, 22]);
  assert.deepEqual(freqSlots('3x'), [6, 14, 22]);
  assert.deepEqual(freqSlots('4x'), [6, 10, 14, 18]);
  // «каждые 6 ч»: полночь — это 0, а не 24. Слот 24 в ключе (дата, слот)
  // означал бы дозу, поставленную на вчерашний день.
  assert.deepEqual(freqSlots('q6h'), [0, 6, 12, 18]);
  assert.deepEqual(freqSlots('once'), [10]);
  assert.deepEqual(freqSlots('prn'), []);
  assert.equal(freqSlots('каждые полчаса'), null, 'неизвестная частота не выдумывает часы');
});

test('часы частоты отдаются копией — снимок в назначении нельзя испортить извне', () => {
  const a = freqSlots('3x');
  a.push(2);
  assert.deepEqual(freqSlots('3x'), [6, 14, 22]);
  assert.deepEqual([...FREQUENCIES['3x'].slots], [6, 14, 22]);
});

test('«по требованию» — единственная частота без плановых точек', () => {
  for (const code of FREQ_CODES) {
    assert.equal(isPrnFreq(code), code === 'prn', code);
  }
});

test('десять путей введения — тот же список, что в CHECK миграции 093', () => {
  assert.deepEqual(ROUTES, ['в/в', 'в/в кап.', 'в/в (инфузомат)', 'в/м', 'п/к',
    'внутрь', 'сублингв.', 'ингаляция', 'местно', 'ректально']);
});

// ─── Календарь курса ────────────────────────────────────────────────────────

test('пятидневный курс кончается на четвёртые сутки после начала, а не на пятые', () => {
  assert.equal(courseEnd('2026-09-04', 5, '3x'), '2026-09-08');
  assert.equal(courseEnd('2026-09-04', 1, '3x'), '2026-09-04', 'один день — это сам день начала');
  assert.equal(courseEnd('2026-09-04', null, '3x'), null, '«до отмены» конца не имеет');
  assert.equal(courseEnd('2026-09-04', 30, 'once'), '2026-09-04', '«однократно» — только первый день');
});

test('арифметика дней переживает конец месяца и високосный год', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(daysBetween('2026-09-04', '2026-09-08'), 4);
  assert.equal(isDate('2026-9-4'), false, 'ГГГГ-ММ-ДД и никак иначе');
});

// ─── Разворот курса ─────────────────────────────────────────────────────────

const course = (over = {}) => ({
  freq_code: '3x', slots: '[6,14,22]', starts_on: '2026-09-04', days: 5,
  ends_on: '2026-09-08', status: 'active', prn: 0, cancel_at: null, ...over,
});

test('курс 3 р/д × 5 дней — пятнадцать точек, и последний день не потерян', () => {
  const due = expandCourse(course(), '2026-09-01', '2026-09-30');
  assert.equal(due.length, 15);
  assert.deepEqual(due[0], { date: '2026-09-04', slot: 6, due_at: '2026-09-04 06:00', due_ms: at('2026-09-04', 6) });
  assert.equal(due.at(-1).date, '2026-09-08', 'последний день курса обязан развернуться');
  assert.equal(due.at(-1).slot, 22);
  // Ровно пять разных дат, по три точки в каждой.
  const dates = [...new Set(due.map((d) => d.date))];
  assert.deepEqual(dates, ['2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
  for (const d of dates) assert.equal(due.filter((x) => x.date === d).length, 3, d);
});

test('окно запроса режет курс с обеих сторон, но не меняет его', () => {
  const due = expandCourse(course(), '2026-09-06', '2026-09-06');
  assert.deepEqual(due.map((d) => d.slot), [6, 14, 22]);
  assert.equal(expandCourse(course(), '2026-09-01', '2026-09-03').length, 0, 'до начала курса точек нет');
  assert.equal(expandCourse(course(), '2026-09-09', '2026-09-20').length, 0, 'после конца — тоже');
});

test('«до отмены» (days = null) идёт столько, сколько спросили', () => {
  const due = expandCourse(course({ freq_code: '1x', slots: '[10]', days: null, ends_on: null }),
    '2026-09-04', '2026-09-13');
  assert.equal(due.length, 10);
});

test('«однократно» — одна точка, сколько бы дней ни спросили', () => {
  const due = expandCourse(course({ freq_code: 'once', slots: '[10]', days: null, ends_on: '2026-09-04' }),
    '2026-09-01', '2026-09-30');
  assert.deepEqual(due, [{ date: '2026-09-04', slot: 10, due_at: '2026-09-04 10:00', due_ms: at('2026-09-04', 10) }]);
});

test('«по требованию» не рождает плановых точек ни при каком окне', () => {
  assert.deepEqual(expandCourse(course({ freq_code: 'prn', slots: '[]', prn: 1, ends_on: null }),
    '2026-09-01', '2026-09-30'), []);
});

test('курс живёт по СОХРАНЁННЫМ часам, а не по сегодняшней таблице частот', () => {
  // Назначено по старой таблице (8/20). Таблица с тех пор изменилась — история
  // не должна переписаться задним числом.
  const due = expandCourse(course({ freq_code: '2x', slots: '[8,20]', days: 2, ends_on: '2026-09-05' }),
    '2026-09-01', '2026-09-30');
  assert.deepEqual([...new Set(due.map((d) => d.slot))], [8, 20]);
  assert.equal(due.length, 4);
});

test('часы разворачиваются по возрастанию, дубли и мусор в снимке отброшены', () => {
  const due = expandCourse(course({ slots: '[22,6,6,14,99,-1,"x"]', days: 1, ends_on: '2026-09-04' }),
    '2026-09-04', '2026-09-04');
  assert.deepEqual(due.map((d) => d.slot), [6, 14, 22]);
});

// ─── Отмена ─────────────────────────────────────────────────────────────────

test('отменённый курс не рождает точек ПОСЛЕ отмены и не теряет те, что до неё', () => {
  // Врач отменил назначение 5 сентября в 09:00 по местным часам. Доза 06:00
  // того же дня уже была плановой (и, возможно, уже дана) — она остаётся.
  const cancelAt = new Date(at('2026-09-05', 9)).toISOString();
  const due = expandCourse(course({ status: 'cancelled', cancel_at: cancelAt }), '2026-09-01', '2026-09-30');

  assert.deepEqual(due.map((d) => `${d.date} ${d.slot}`), [
    '2026-09-04 6', '2026-09-04 14', '2026-09-04 22', '2026-09-05 6',
  ], 'после 09:00 пятого числа плановых точек больше нет');
});

test('отмена ровно в час дозы: эта доза уже не планируется', () => {
  const cancelAt = new Date(at('2026-09-04', 14)).toISOString();
  const due = expandCourse(course({ status: 'cancelled', cancel_at: cancelAt }), '2026-09-04', '2026-09-04');
  assert.deepEqual(due.map((d) => d.slot), [6]);
});

test('статус «отменено» без времени отмены курс не режет — резать нечем', () => {
  const due = expandCourse(course({ status: 'cancelled', cancel_at: null }), '2026-09-01', '2026-09-30');
  assert.equal(due.length, 15);
});

// ─── Три степени опоздания ──────────────────────────────────────────────────

test('ожидает / задержано / просрочено — с допуском в 15 минут', () => {
  const due = { date: '2026-09-04', slot: 14 };
  assert.equal(dueState(due, at('2026-09-04', 13)), 'pending', 'до срока');
  assert.equal(dueState(due, at('2026-09-04', 14)), 'pending', 'ровно в срок');
  assert.equal(dueState(due, at('2026-09-04', 14, 14)), 'pending', 'внутри допуска');
  assert.equal(dueState(due, at('2026-09-04', 14, 15)), 'delayed', 'допуск кончился — задержано');
  assert.equal(dueState(due, at('2026-09-04', 14, 59)), 'delayed');
  assert.equal(dueState(due, at('2026-09-04', 15)), 'missed', 'час спустя — просрочено');
  assert.equal(dueState(due, at('2026-09-05', 14)), 'missed');
});

test('допуск — настройка, а не закон природы', () => {
  const due = { date: '2026-09-04', slot: 14 };
  assert.equal(dueState(due, at('2026-09-04', 14, 20), { graceMin: 30 }), 'pending');
  assert.equal(dueState(due, at('2026-09-04', 14, 40), { graceMin: 30, missedMin: 35 }), 'missed');
});

test('точка из expandCourse годится в dueState как есть', () => {
  const [first] = expandCourse(course(), '2026-09-04', '2026-09-04');
  assert.equal(dueState(first, at('2026-09-04', 8)), 'missed');
  assert.equal(dueState(first, at('2026-09-04', 5)), 'pending');
});
