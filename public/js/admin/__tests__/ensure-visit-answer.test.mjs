// ENSURE_VISIT_ANSWER_V1 (CRM_REAL_BOOKING_V1, 2026-09-21) — ОТВЕТ ensure_visit
// ЧИТАЕТСЯ ЦЕЛИКОМ, И ЧИТАЕТСЯ ОДНИМ КОДОМ НА ВСЕ ДВЕРИ.
//
// Разбор ревью нашёл в карточке заявки «есть id визита — значит записано», а
// у ensure_visit с book: три исхода, и визит есть во всех трёх. Мастер визита
// и быстрая регистрация читали ответ так же. Чтение вынуто в один модуль, и
// здесь прибиты его слова: отказ обязан назвать, во сколько и у кого человека
// уже ждут, а перенос — откуда и куда.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Язык пришпилен к ru ДО импорта: слова проверяются русские.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() {} };
// i18n.js ставит lang на корневой элемент при загрузке — ему нужен документ.
globalThis.document = { documentElement: { lang: '' }, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { readEnsureVisit } = await import('../ensure-visit-answer.js');

test('завели и заняли время — записано, сказать нечего', () => {
  const a = readEnsureVisit({ visit: { id: 1 }, created: true, booked: true });
  assert.equal(a.kind, 'booked');
  assert.equal(a.ok, true);
  assert.equal(a.text, '');
});

test('без book визит дня переиспользован — не отказ и не перенос', () => {
  const a = readEnsureVisit({ visit: { id: 1 }, created: false, booked: false });
  assert.equal(a.kind, 'reused');
  assert.equal(a.ok, true, 'переиспользованный визит дня прочитан как отказ');
  assert.equal(a.busy, false);
});

test('визит дня с работой: НЕ записано, и отказ называет час и врача', () => {
  const a = readEnsureVisit({
    visit: { id: 55 }, created: false, booked: false, reason: 'day_visit_busy',
    day_visit: { id: 55, start: '11:20', duration_minutes: 30, doctor_id: 7, doctor_name: 'Петров Пётр' },
  });
  assert.equal(a.kind, 'busy');
  assert.equal(a.ok, false, 'занятый день прочитан как успех — пациенту назовут незанятый час');
  assert.match(a.text, /11:20/, 'в отказе нет времени, во сколько человека уже ждут: ' + a.text);
  assert.match(a.text, /у Петров Пётр/, 'в отказе нет врача: ' + a.text);
  assert.match(a.text, /время не занято/, 'из отказа не следует главное — выбранный час свободен: ' + a.text);
});

test('визит дня с работой БЕЗ врача — врач не выдумывается', () => {
  const a = readEnsureVisit({
    visit: { id: 55 }, created: false, booked: false, reason: 'day_visit_busy',
    day_visit: { id: 55, start: '11:20', doctor_id: null, doctor_name: '' },
  });
  assert.ok(!/11:20 у /.test(a.text), 'к отказу приписан несуществующий врач: ' + a.text);
  assert.match(a.text, /11:20 — время не занято/, a.text);
});

test('перенос: откуда и куда, прежний врач — в скобках', () => {
  const a = readEnsureVisit({
    visit: { id: 55 }, created: false, booked: true, moved: true,
    from: { start: '16:00', doctor_id: 9, doctor_name: 'Иванов Иван' },
  }, { time: '09:15' });
  assert.equal(a.kind, 'moved');
  assert.equal(a.ok, true);
  assert.equal(a.text, 'Приём перенесён с 16:00 (Иванов Иван) на 09:15');
});

test('перенос без прежнего врача — скобок нет; новое время берётся из визита, если его не назвали', () => {
  const at = new Date(); at.setHours(9, 15, 0, 0);
  const a = readEnsureVisit({
    visit: { id: 55, visit_date: at.toISOString() }, created: false, booked: true, moved: true,
    from: { start: '16:00', doctor_id: null, doctor_name: '' },
  });
  assert.equal(a.text, 'Приём перенесён с 16:00 на 09:15');
});

test('ответ без from (старый сервер) переносом всё равно считается', () => {
  const a = readEnsureVisit({ visit: { id: 55 }, created: false, booked: true, moved: true }, { time: '09:15' });
  assert.equal(a.moved, true);
  assert.match(a.text, /на 09:15$/);
});

test('пустой или странный ответ — не бросает и не записан', () => {
  assert.equal(readEnsureVisit(null).kind, 'reused');
  assert.equal(readEnsureVisit(undefined).ok, true);
  assert.equal(readEnsureVisit({ booked: false, reason: 'day_visit_busy' }).busy, true);
});
