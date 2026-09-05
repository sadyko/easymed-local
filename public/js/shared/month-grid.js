// MONTH_GRID_V1 (2026-09-05) — сетка месяца для календарного поля.
//
// Владелец: «please fix the dialogue windows and dropdowns and calendar
// pickers design. its the default dropdowns. not a system design dropdowns».
//
// Родной календарь браузера нарисовать по-своему нельзя: он рисуется
// операционной системой, и ни одно правило CSS до него не достаёт. Поэтому
// поле даты получает СВОЙ календарь, а вся его арифметика живёт здесь —
// в чистом модуле без DOM, чтобы её можно было проверить числами, а не
// разглядыванием экрана. Ошибки в календарях всегда одни и те же:
// перевод часов, високосный год, неделя, начинающаяся не с того дня, и
// «31 число» при переходе на месяц, где его нет.
//
// ВРЕМЕНИ ЗДЕСЬ НЕТ. Дата приёма — это календарный день, а не момент: все
// значения строятся и сравниваются как «ГГГГ-ММ-ДД», ровно в том виде, в
// каком их хранит <input type="date"> и база. Стоило бы завести Date со
// временем — и полночь в летнее время сдвинула бы день на предыдущий.

/** Понедельник — 0, воскресенье — 6. Неделя в Узбекистане начинается с понедельника. */
function mondayIndex(jsDay) {
    return (jsDay + 6) % 7;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** 'ГГГГ-ММ-ДД' из года, месяца (0–11) и числа. Единственный способ собрать значение. */
export function isoOf(year, month, day) {
    return year + '-' + pad2(month + 1) + '-' + pad2(day);
}

/**
 * Разбирает 'ГГГГ-ММ-ДД' в {year, month, day} или null.
 * Строгий разбор нарочно: `new Date('2026-02-31')` молча даёт 3 марта, и
 * календарь открылся бы не на том месяце, ничего не сказав.
 */
export function parseIso(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const year = Number(m[1]), month = Number(m[2]) - 1, day = Number(m[3]);
    if (month < 0 || month > 11 || day < 1) return null;
    if (day > daysInMonth(year, month)) return null;
    return { year, month, day };
}

/** Сколько дней в месяце. Февраль високосного года считается, а не угадывается. */
export function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

/**
 * Сетка месяца: шесть недель по семь дней, всегда одного размера.
 *
 * Ровно шесть строк — не прихоть: у месяца их выходит от четырёх до шести, и
 * сетка переменной высоты дёргала бы всё окно при перелистывании, а кнопка
 * «Сегодня» уезжала бы из-под курсора.
 *
 * Каждая клетка: { iso, day, month, year, inMonth }.
 */
export function monthGrid(year, month) {
    const first = new Date(year, month, 1);
    const lead = mondayIndex(first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
        const d = new Date(year, month, 1 - lead + i);
        const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
        cells.push({ iso: isoOf(y, m, day), day, month: m, year: y, inMonth: m === month && y === year });
    }
    const weeks = [];
    for (let i = 0; i < 42; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
}

/**
 * Сдвиг на месяцы с сохранением числа ТАМ, ГДЕ ОНО ЕСТЬ.
 * 31 января минус месяц — это 28 (или 29) февраля, а не 3 марта: перенос
 * «лишних» дней вперёд — самая частая ошибка самодельных календарей.
 */
export function shiftMonth({ year, month }, delta) {
    const total = year * 12 + month + delta;
    return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

/** Сегодняшний день как 'ГГГГ-ММ-ДД' по местному календарю (не по UTC). */
export function todayIso(now = new Date()) {
    return isoOf(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Разрешена ли дата ограничениями поля (атрибуты min/max у <input type="date">).
 * Сравнение строковое: 'ГГГГ-ММ-ДД' сортируется как дата, и это единственный
 * способ сравнить дни, не заводя момент времени.
 */
export function withinRange(iso, { min, max } = {}) {
    if (!iso) return false;
    if (min && iso < min) return false;
    if (max && iso > max) return false;
    return true;
}
