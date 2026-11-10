// CALENDAR_BOOKING_V1 — движок «что свободно».
//
// Проверяются РАСХОЖДЕНИЯ, ради устранения которых он и написан. До него один
// и тот же вопрос считался в трёх местах браузера, и три ответа отличались:
//
//   • форма графика: карточка сотрудника пишет {enabled,…}, экран
//     «Сотрудники» — {on,…}; мастер визита понимал только второе, календарь —
//     только первое. Обе формы лежат в одной колонке живых клиник;
//   • обед: его вводят в карточке и не вычитал никто;
//   • окно по умолчанию: 09:00–18:00 у мастера, 08:00–20:00 у календаря.
//
// Плюс арифметика, на которой такие движки обычно и ломаются: стык интервалов
// (14:00–14:30 и 14:30–15:00 — НЕ конфликт), шаг от начала приёма, а не от
// полуночи, и «услуга без длительности» ≠ «ноль минут».
//
// Ни одного часового пояса здесь нет намеренно: движок считает минуты дня и
// номер дня недели, поэтому тест одинаков на любой машине.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DURATION_MIN, DEFAULT_FROM_MIN, DEFAULT_TO_MIN,
  clampWindow, clinicWindow, dayWindow, formatHhmm, overlaps, overlapsMs,
  parseHhmm, parseWorkingHours, serviceDurationMinutes, slotStarts, windowSegments,
  packedStarts, startFits, packMinStart,   // SLOT_PACK_V1
} from './slot-engine.js';

const MON = 1, TUE = 2, SUN = 0;
const hm = (s) => parseHhmm(s);

test('обе формы графика читаются: {enabled} карточки и {on} экрана «Сотрудники»', () => {
  // Карточка сотрудника (employee-editor.js).
  const card = { mon: { enabled: true, from: '10:00', to: '14:00' }, tue: { enabled: false, from: '09:00', to: '18:00' } };
  assert.deepEqual(dayWindow(card, MON), { from: hm('10:00'), to: hm('14:00'), breaks: [] });
  assert.equal(dayWindow(card, TUE), null, 'выключенный день карточки обязан быть выходным');

  // Экран «Сотрудники» (employees.js) — та же колонка, другая форма.
  const list = { mon: { on: true, from: '10:00', to: '14:00' }, tue: { on: false, from: '09:00', to: '18:00' } };
  assert.deepEqual(dayWindow(list, MON), { from: hm('10:00'), to: hm('14:00'), breaks: [] });
  assert.equal(dayWindow(list, TUE), null,
    'день, выключенный на экране «Сотрудники», календарь рисовал рабочим — это и чинится');
});

test('график приезжает строкой JSON и объектом — обе формы понимаются', () => {
  const asObject = { mon: { enabled: true, from: '08:30', to: '12:00' } };
  const asString = JSON.stringify(asObject);
  assert.deepEqual(dayWindow(asString, MON), dayWindow(asObject, MON));
  assert.equal(parseWorkingHours(''), null, 'пустая колонка = графика нет');
  assert.equal(parseWorkingHours('не json'), null);
  assert.equal(parseWorkingHours('[1,2]'), null, 'массив — не график');
});

test('графика нет вовсе — окно по умолчанию 09:00–18:00, то же, по которому клиника записывает сегодня', () => {
  for (const empty of [null, '', undefined, 'мусор']) {
    assert.deepEqual(dayWindow(empty, MON), { from: DEFAULT_FROM_MIN, to: DEFAULT_TO_MIN, breaks: [] });
  }
  // А вот график, В КОТОРОМ ЭТОГО ДНЯ НЕТ, — это выходной, а не «по умолчанию»:
  // расписание заполнено, и воскресенья в нём нет намеренно.
  assert.equal(dayWindow({ mon: { enabled: true, from: '09:00', to: '18:00' } }, SUN), null);
});

test('ПУСТОЙ объект графика врача или кабинета — «не задано», окно по умолчанию, а не выходной каждый день', () => {
  // Экран «Сотрудники» сохраняет нового врача с '{}' (ни одного дня не
  // отмечено). До EMPTY_HOURS_DEFAULT_V1 это читалось как «не принимает
  // никогда»: серая колонка в календаре и отказ в записи у каждого такого
  // врача — владелец увидел это в клинике после заведения новых кабинетов.
  for (const raw of ['{}', {}, '{"lunch":1}']) {
    assert.deepEqual(dayWindow(raw, MON), { from: hm('09:00'), to: hm('18:00'), breaks: [] }, JSON.stringify(raw));
  }
  // А заполненный график, где понедельника нет, — закрыт: это решение человека.
  assert.equal(dayWindow({ tue: { on: true, from: '09:00', to: '18:00' } }, MON), null);
});

test('обед вычитается из приёма — до этого движка его не вычитал никто', () => {
  const wh = { mon: { enabled: true, from: '09:00', to: '18:00', lunchEnabled: true, lunchFrom: '13:00', lunchTo: '14:00' } };
  const win = dayWindow(wh, MON);
  assert.deepEqual(win.breaks, [{ from: hm('13:00'), to: hm('14:00') }]);
  assert.deepEqual(windowSegments(win), [
    { from: hm('09:00'), to: hm('13:00') },
    { from: hm('14:00'), to: hm('18:00') },
  ]);
  // Выключенный обед не режет день.
  const off = dayWindow({ mon: { enabled: true, from: '09:00', to: '18:00', lunchEnabled: false, lunchFrom: '13:00', lunchTo: '14:00' } }, MON);
  assert.deepEqual(off.breaks, []);
});

test('перевёрнутое окно — не окно, а опечатка', () => {
  assert.equal(dayWindow({ mon: { enabled: true, from: '18:00', to: '09:00' } }, MON), null);
  assert.equal(dayWindow({ mon: { enabled: true, from: '12:00', to: '12:00' } }, MON), null);
});

test('часы клиники бьют по графику ресурса', () => {
  const doctor = { from: hm('08:00'), to: hm('20:00'), breaks: [] };
  const branch = { is_24_7: 0, working_hours: { mon: { enabled: true, from: '09:00', to: '18:00' } } };
  assert.deepEqual(clampWindow(doctor, clinicWindow(branch, MON)),
    { from: hm('09:00'), to: hm('18:00'), breaks: [] });

  // Клиника закрыта — ресурс не работает, чей бы график ни говорил обратное.
  const closed = { is_24_7: 0, working_hours: { mon: { enabled: false } } };
  assert.equal(clampWindow(doctor, clinicWindow(closed, MON)), null);

  // 24/7 и «часов не задано» — границы нет, а не «закрыто».
  assert.equal(clinicWindow({ is_24_7: 1, working_hours: null }, MON), undefined);
  assert.equal(clinicWindow(null, MON), undefined);
  assert.deepEqual(clampWindow(doctor, undefined), doctor);
});

test('ПУСТОЙ объект часов здания — «не задано», а не «закрыто семь дней в неделю»', () => {
  // `branches.working_hours TEXT NOT NULL DEFAULT '{}'` (миграция 002), в
  // отличие от users и rooms, где умолчание — пустая строка. Значит '{}' стоит
  // у КАЖДОГО здания, которому распорядок ни разу не открывали, и прочитать
  // его как «закрыто» значило бы погасить расписание целого корпуса за то, что
  // его никто не настраивал.
  //
  // Ловушка срабатывает только у ресурса с ЗАПОЛНЕННЫМ филиалом. Пока приписка
  // врача не ездила между зданиями, у приехавших она была пуста, сужать было
  // нечем — и межфилиальный календарь наткнулся на неё первым же настоящим
  // прогоном (CROSS_BRANCH_CALENDAR_V1).
  const doctor = { from: hm('09:00'), to: hm('18:00'), breaks: [] };
  assert.equal(clinicWindow({ is_24_7: 0, working_hours: '{}' }, MON), undefined);
  assert.deepEqual(clampWindow(doctor, clinicWindow({ is_24_7: 0, working_hours: '{}' }, MON)), doctor);

  // А заполненный распорядок, в котором этого дня нет, ЗАКРЫТ — это решение
  // человека, а не пустая колонка.
  assert.equal(clinicWindow({ is_24_7: 0, working_hours: { tue: { enabled: true, from: '09:00', to: '18:00' } } }, MON), null);
});

test('слоты: шаг считается ОТ НАЧАЛА ПРИЁМА, а не от полуночи', () => {
  const win = { from: hm('08:40'), to: hm('09:40'), breaks: [] };
  const starts = slotStarts({ segments: windowSegments(win), busy: [], durationMin: 15, stepMin: 15 });
  assert.deepEqual(starts.map(formatHhmm), ['08:40', '08:55', '09:10', '09:25']);
});

test('слоты обходят занятое, но СТЫК занятым не считается', () => {
  const win = { from: hm('09:00'), to: hm('10:00'), breaks: [] };
  const busy = [{ from: hm('09:15'), to: hm('09:30') }];
  const starts = slotStarts({ segments: windowSegments(win), busy, durationMin: 15, stepMin: 15 });
  // 09:00 (кончается ровно в 09:15 — стык), 09:30 (начинается ровно на стыке), 09:45.
  assert.deepEqual(starts.map(formatHhmm), ['09:00', '09:30', '09:45']);
});

test('длительность услуги решает, сколько слотов помещается', () => {
  const win = { from: hm('09:00'), to: hm('10:00'), breaks: [] };
  const seg = windowSegments(win);
  assert.equal(slotStarts({ segments: seg, durationMin: 15, stepMin: 15 }).length, 4);
  assert.equal(slotStarts({ segments: seg, durationMin: 30, stepMin: 30 }).length, 2);
  // Шаг и длительность — РАЗНЫЕ вещи: сорокаминутная услуга при шаге 15
  // предлагается с 09:00 и с 09:15 (кончается в 09:55), но не с 09:30 —
  // такая запись вылезла бы за конец приёма.
  assert.deepEqual(slotStarts({ segments: seg, durationMin: 40, stepMin: 15 }).map(formatHhmm), ['09:00', '09:15']);
});

test('слоты не залезают в обед', () => {
  const win = dayWindow({ mon: { enabled: true, from: '12:30', to: '14:30', lunchEnabled: true, lunchFrom: '13:00', lunchTo: '14:00' } }, MON);
  const starts = slotStarts({ segments: windowSegments(win), durationMin: 30, stepMin: 30 });
  assert.deepEqual(starts.map(formatHhmm), ['12:30', '14:00']);
});

test('minStartMin отсекает прошедшее — «сегодня» не предлагает записать во вчера', () => {
  const win = { from: hm('09:00'), to: hm('11:00'), breaks: [] };
  const starts = slotStarts({ segments: windowSegments(win), durationMin: 30, stepMin: 30, minStartMin: hm('10:00') });
  assert.deepEqual(starts.map(formatHhmm), ['10:00', '10:30']);
});

test('пересечение интервалов: полуоткрытые, стык свободен', () => {
  assert.equal(overlaps(0, 30, 30, 60), false, 'соседние приёмы не конфликтуют');
  assert.equal(overlaps(0, 30, 29, 60), true);
  assert.equal(overlaps(10, 20, 0, 60), true, 'вложенный интервал — конфликт');
  const base = Date.parse('2026-09-07T09:00:00Z');
  assert.equal(overlapsMs(base, 30, base + 30 * 60000, 30), false);
  assert.equal(overlapsMs(base, 31, base + 30 * 60000, 30), true);
});

test('услуга без длительности — это «не заполнено», а не «ноль минут»', () => {
  assert.equal(serviceDurationMinutes({ duration_minutes: 40 }), 40);
  assert.equal(serviceDurationMinutes({ duration_minutes: 0 }), DEFAULT_DURATION_MIN);
  assert.equal(serviceDurationMinutes({ duration_minutes: null }), DEFAULT_DURATION_MIN);
  assert.equal(serviceDurationMinutes(null), DEFAULT_DURATION_MIN);
  assert.equal(DEFAULT_DURATION_MIN, 15, 'решение владельца 2026-09-05: по умолчанию 15 минут');
});

test('разбор и печать часов', () => {
  assert.equal(parseHhmm('09:30'), 570);
  assert.equal(parseHhmm('9:05'), 545);
  assert.equal(parseHhmm('00:00'), 0, 'полночь — настоящее значение, а не «мусор»');
  assert.equal(parseHhmm('24:00'), null);
  assert.equal(parseHhmm('09:60'), null);
  assert.equal(parseHhmm(''), null);
  assert.equal(formatHhmm(570), '09:30');
  assert.equal(formatHhmm(0), '00:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// SLOT_PACK_V1 (3.23.0) — ЗАПИСИ ВСТАЮТ ВПЛОТНУЮ: следующее свободное начало —
// конец предыдущей записи, дальше шагом ДЛИТЕЛЬНОСТИ услуги. Снимок владельца:
// врач 09:00–18:00, записи 09:00–09:30 и 10:10–10:40 — сетка в 30 минут
// предлагала 09:30, 11:00, 11:30…, и 10:40 не предлагалось никогда.
// ═══════════════════════════════════════════════════════════════════════════
const DAY_9_18 = windowSegments({ from: hm('09:00'), to: hm('18:00'), breaks: [] });
const OWNER_BUSY = [{ from: hm('09:00'), to: hm('09:30') }, { from: hm('10:10'), to: hm('10:40') }];

test('SLOT_PACK_V1: после записи — её конец, дальше шагом длительности (снимок владельца)', () => {
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30 }).slice(0, 4).map(formatHhmm),
    ['09:30', '10:40', '11:10', '11:40'], '10:40 — конец записи 10:10–10:40 — обязано предлагаться');
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 15 }).slice(0, 4).map(formatHhmm),
    ['09:30', '09:45', '10:40', '10:55']);
  // Конец дня: последняя тридцатиминутка начинается не позже 17:30 (от 10:40 шагом 30 — 17:10).
  const all = packedStarts({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30 });
  assert.equal(formatHhmm(all[all.length - 1]), '17:10');
  assert.ok(all.every((t) => t + 30 <= hm('18:00')));
});

test('SLOT_PACK_V1: после обеда — с конца обеда; до обеда — пока помещается', () => {
  const win = { from: hm('09:00'), to: hm('15:00'), breaks: [{ from: hm('12:20'), to: hm('13:00') }] };
  const starts = packedStarts({ segments: windowSegments(win), durationMin: 30 }).map(formatHhmm);
  assert.ok(starts.includes('11:30') && !starts.includes('12:00'), '12:00–12:30 залезает в обед');
  assert.deepEqual(starts.filter((s) => s >= '12:00'), ['13:00', '13:30', '14:00', '14:30']);
});

test('SLOT_PACK_V1: сегодня — «сейчас», округлённое ВВЕРХ до 5 минут (не «10:07»)', () => {
  const d = (h, m, s = 0) => new Date(2030, 0, 7, h, m, s, 0);
  assert.equal(packMinStart(d(10, 7)), hm('10:10'));
  assert.equal(packMinStart(d(10, 5)), hm('10:05'), 'ровно 10:05 — уже кратно пяти');
  assert.equal(packMinStart(d(10, 5, 30)), hm('10:10'), 'начатая минута — прошла');
  assert.equal(packMinStart(d(23, 58, 10)), 24 * 60, 'поздно вечером — ни одного начала сегодня');
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30, minStartMin: packMinStart(d(10, 7)) })
    .slice(0, 3).map(formatHhmm), ['10:40', '11:10', '11:40'], '10:10 занято записью — первое начало — её конец');
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy: [], durationMin: 30, minStartMin: packMinStart(d(10, 7)) })
    .slice(0, 3).map(formatHhmm), ['10:10', '10:40', '11:10']);
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy: [], durationMin: 30, minStartMin: packMinStart(d(23, 35)) }), []);
});

test('SLOT_PACK_V1: промежуток короче услуги не предлагается; внахлёст занятое — один блок', () => {
  const busy = [{ from: hm('09:00'), to: hm('09:30') }, { from: hm('09:50'), to: hm('18:00') }];
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy, durationMin: 30 }), [], '20 минут для получасовой услуги — не окно');
  assert.deepEqual(packedStarts({ segments: DAY_9_18, busy, durationMin: 15 }).map(formatHhmm), ['09:30']);
  const lap = [{ from: hm('10:15'), to: hm('11:00') }, { from: hm('10:00'), to: hm('10:30') }];
  const win = windowSegments({ from: hm('10:00'), to: hm('12:00'), breaks: [] });
  assert.deepEqual(packedStarts({ segments: win, busy: lap, durationMin: 20 }).map(formatHhmm), ['11:00', '11:20', '11:40']);
});

test('SLOT_PACK_V1: разные длительности — у каждой услуги свой шаг от того же конца записи', () => {
  const busy = [{ from: hm('09:00'), to: hm('09:45') }];
  const win = windowSegments({ from: hm('09:00'), to: hm('11:00'), breaks: [] });
  assert.deepEqual(packedStarts({ segments: win, busy, durationMin: 45 }).map(formatHhmm), ['09:45'], '10:30–11:15 не помещается до 11:00');
  assert.deepEqual(packedStarts({ segments: win, busy, durationMin: 20 }).map(formatHhmm), ['09:45', '10:05', '10:25']);
  // Две несохранённые строки одной сметы: вторая встаёт сразу за первой.
  const withFirst = busy.concat([{ from: hm('09:45'), to: hm('10:05') }]);
  assert.equal(formatHhmm(packedStarts({ segments: win, busy: withFirst, durationMin: 20 })[0]), '10:05');
});

test('SLOT_PACK_V1: startFits — выбранное время помещается, даже если его нет в упакованном списке', () => {
  assert.equal(startFits({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30, startMin: hm('10:40') }), true);
  assert.equal(startFits({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30, startMin: hm('12:05') }), true,
    'не на упакованном шаге, но свободно — помещается');
  assert.equal(startFits({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30, startMin: hm('09:45') }), false, 'задевает 10:10');
  assert.equal(startFits({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30, startMin: hm('17:45') }), false, 'вылезает за 18:00');
  assert.equal(startFits({ segments: DAY_9_18, busy: OWNER_BUSY, durationMin: 30, startMin: hm('08:30') }), false, 'до начала приёма');
  assert.equal(startFits({ segments: DAY_9_18, busy: [], durationMin: 30, startMin: hm('10:00'), minStartMin: hm('10:10') }), false);
});
