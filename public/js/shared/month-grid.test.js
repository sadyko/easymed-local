// MONTH_GRID_V1 (2026-09-05) — арифметика календаря проверяется числами.
//
// Свой календарь ломается всегда одинаково: неделя начинается не с того дня,
// февраль високосного года теряет день, «31 января минус месяц» уезжает на
// 3 марта, а полночь в летнее время сдвигает дату на предыдущую. Всё это
// невидимо на экране — выглядит как обычный календарь, просто не тот.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isoOf, parseIso, daysInMonth, monthGrid, shiftMonth, todayIso, withinRange,
} from './month-grid.js';

test('сетка месяца — всегда шесть недель по семь дней', () => {
    for (const [y, m] of [[2026, 0], [2026, 1], [2026, 7], [2024, 1], [2027, 4]]) {
        const weeks = monthGrid(y, m);
        assert.equal(weeks.length, 6, `${y}-${m + 1}: недель ${weeks.length}`);
        for (const w of weeks) assert.equal(w.length, 7);
    }
});

test('неделя начинается с понедельника', () => {
    // 1 февраля 2026 — воскресенье: значит первая строка это 26 января … 1 февраля.
    const weeks = monthGrid(2026, 1);
    const first = weeks[0];
    assert.equal(first[0].iso, '2026-01-26', 'первая клетка сетки не понедельник: ' + first[0].iso);
    assert.equal(first[6].iso, '2026-02-01');
    assert.equal(first[6].inMonth, true);
    assert.equal(first[0].inMonth, false, 'дни соседнего месяца обязаны быть помечены');
});

test('февраль високосного года — 29 дней, и все они в сетке', () => {
    assert.equal(daysInMonth(2024, 1), 29);
    assert.equal(daysInMonth(2026, 1), 28);
    assert.equal(daysInMonth(2100, 1), 28, '2100 не високосный — правило деления на 400');

    const days = monthGrid(2024, 1).flat().filter((c) => c.inMonth).map((c) => c.day);
    assert.equal(days.length, 29);
    assert.equal(days[28], 29);
});

test('сдвиг месяца не переносит лишние дни вперёд', () => {
    assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, 1), { year: 2026, month: 1 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
    assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -13), { year: 2024, month: 11 });
    // Именно ради этого сдвиг считается по месяцам, а не Date.setMonth: у
    // Date «31 января минус месяц» даёт 3 марта — месяц перелистнулся дважды.
    assert.deepEqual(shiftMonth({ year: 2026, month: 2 }, -1), { year: 2026, month: 1 });
});

test('значение строится и разбирается только как ГГГГ-ММ-ДД', () => {
    assert.equal(isoOf(2019, 4, 2), '2019-05-02');
    assert.deepEqual(parseIso('2019-05-02'), { year: 2019, month: 4, day: 2 });
    assert.equal(parseIso(''), null);
    assert.equal(parseIso('02.05.2019'), null, 'человеческий формат в поле не хранится');
    // Строгость нарочно: new Date('2026-02-31') молча даёт 3 марта, и
    // календарь открылся бы не на том месяце, ничего не сказав.
    assert.equal(parseIso('2026-02-31'), null, 'несуществующий день обязан отвергаться');
    assert.deepEqual(parseIso('2024-02-29'), { year: 2024, month: 1, day: 29 });
    assert.equal(parseIso('2026-13-01'), null);
});

test('сегодня берётся по местному календарю, а не по UTC', () => {
    // 1 января 2026, 00:30 местного времени. По UTC в минусовых поясах это ещё
    // 31 декабря — и «Сегодня» поставило бы прошлый год.
    assert.equal(todayIso(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
    assert.equal(todayIso(new Date(2026, 11, 31, 23, 45)), '2026-12-31');
});

test('ограничения поля сравниваются как даты', () => {
    assert.equal(withinRange('2026-02-10', { min: '2026-02-05', max: '2026-02-20' }), true);
    assert.equal(withinRange('2026-02-04', { min: '2026-02-05' }), false);
    assert.equal(withinRange('2026-02-21', { max: '2026-02-20' }), false);
    assert.equal(withinRange('2026-02-10', {}), true);
    assert.equal(withinRange('', { min: '2026-01-01' }), false);
    // Строковое сравнение работает только потому, что формат с ведущими
    // нулями: '2026-09-05' < '2026-10-01' верно, а '2026-9-5' сломало бы всё.
    assert.equal(withinRange('2026-09-05', { max: '2026-10-01' }), true);
});
