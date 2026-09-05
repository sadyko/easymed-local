// RCAL_REFERENCE_LAYOUT_V1 — счётная часть новой раскладки «Календаря записи».
//
// Экран целиком проверяется стендом __tests__/room-calendar.test.mjs (настоящая
// SQLite + настоящий компилятор запросов за поддельным fetch). Здесь — то, что
// в стенде проверялось бы через шесть слоёв разметки и потому проверялось бы
// плохо: СКОЛЬКО дней помещается в сетку, ЧТО показывает счётчик загрузки,
// КОГО оставляет «Работают сегодня», и что переживает перезагрузку страницы.
//
// Каждый тест здесь — про решение, которое можно принять иначе, а не про то,
// что «функция возвращает число».

import test from 'node:test';
import assert from 'node:assert/strict';

import { STRINGS } from '../i18n-strings.js';
import {
    ROW_PX, STEP_CHOICES, rowPx, pxPerMin, showsSlotLabel, SLOT_LABEL_MIN_PX,
    MAX_DAYS, MAX_COLUMNS, maxDaysFor, dayStepBlock,
    monthKey, monthGrid, monthRange, countByDay,
    groupByBranch, worksOn, keepsWorkingFilter, workingSlots, columnLoad, buildColumns,
    slotMode, MODE_LIVE_QUEUE, MODE_BY_APPOINTMENT,
    normalizeWorkingSet, readWorkingSet, writeWorkingSet, restoreSelection, WORKING_SET_KEY,
    dateToIso, isoToLocalDay,
} from './rcal-layout.js';

const CANVAS = { from: 8 * 60, to: 20 * 60 };
const WIN_9_18 = { from: 9 * 60, to: 18 * 60, breaks: [{ from: 13 * 60, to: 14 * 60 }] };

// ---------------------------------------------------------------------------
// Высота строки и подпись слота
// ---------------------------------------------------------------------------

test('шаг сетки меняет только КАРТИНКУ: высота строки и точность клика', () => {
    for (const s of STEP_CHOICES) {
        assert.ok(rowPx(s) >= 12, 'строка шага ' + s + ' ниже читаемой');
        assert.ok(pxPerMin(s) > 0);
    }
    // Мелкий шаг НЕ означает пропорционально длинного полотна: иначе
    // пятиминутная сетка стала бы втрое выше пятнадцатиминутной.
    assert.ok(rowPx(5) * (60 / 5) < rowPx(15) * (60 / 15) * 2,
        'час на пятиминутном шаге не должен быть вдвое выше часа на пятнадцатиминутном');
    assert.equal(rowPx(15), ROW_PX[15]);
    assert.equal(rowPx(999), Math.max(12, Math.min(80, Math.round(999 * 1.6))), 'неизвестный шаг не роняет сетку');
});

test('подпись «филиал · режим» появляется, только когда она физически влезает', () => {
    assert.equal(showsSlotLabel(5), false, 'в 12-пиксельную строку строка текста не помещается');
    assert.equal(showsSlotLabel(10), false);
    assert.equal(showsSlotLabel(15), true);
    assert.equal(showsSlotLabel(30), true);
    // Порог — про высоту, а не про шаг: он останется верным, если ROW_PX
    // когда-нибудь перерисуют.
    for (const s of STEP_CHOICES) assert.equal(showsSlotLabel(s), rowPx(s) >= SLOT_LABEL_MIN_PX);
});

// ---------------------------------------------------------------------------
// Сколько дней показывать
// ---------------------------------------------------------------------------

test('дни упираются в НЕДЕЛЮ — дальше вопрос «когда свободно» решает мини-месяц', () => {
    assert.equal(maxDaysFor(1), MAX_DAYS);
    assert.equal(maxDaysFor(2), MAX_DAYS);
    assert.equal(maxDaysFor(0), MAX_DAYS, 'без выбранных ресурсов предел — прежний');
    assert.equal(dayStepBlock(MAX_DAYS, 1), 'week');
    assert.equal(dayStepBlock(1, 1), null);
});

test('дни упираются и в ШИРИНУ: колонок больше двадцати четырёх сетка не держит', () => {
    // Четыре врача — шесть дней (24 колонки), седьмой день уже не помещается.
    assert.equal(maxDaysFor(4), 6);
    assert.equal(dayStepBlock(6, 4), 'columns', 'кнопка «+» обязана назвать причину: ширина, а не неделя');
    assert.equal(dayStepBlock(5, 4), null);
    // Двенадцать врачей на день — уже предел: второй день дал бы 24 колонки
    // одних только повторов, и ни один день не читался бы целиком.
    assert.equal(maxDaysFor(12), 2);
    assert.equal(maxDaysFor(25), 1, 'больше предела колонок — остаётся один день, а не ноль');
    for (const n of [1, 2, 3, 4, 6, 8, 12, 24]) {
        assert.ok(maxDaysFor(n) * n <= MAX_COLUMNS || maxDaysFor(n) === 1,
            'при ' + n + ' ресурсах предел дней даёт больше ' + MAX_COLUMNS + ' колонок');
    }
});

// ---------------------------------------------------------------------------
// Мини-месяц
// ---------------------------------------------------------------------------

test('мини-месяц — понедельник первым, и лишней недели соседнего месяца нет', () => {
    // Сентябрь 2026: 1-е — вторник, 30 дней → 5 недель.
    const g = monthGrid(2026, 8);
    assert.equal(g.cells.length, g.weeks * 7);
    assert.equal(g.weeks, 5);
    assert.equal(g.cells[0].weekday, 1, 'первая клетка сетки обязана быть понедельником');
    assert.equal(g.cells[1].iso, '2026-09-01');
    assert.equal(g.cells[1].inMonth, true);
    assert.equal(g.cells[0].inMonth, false, 'хвост августа помечен как чужой месяц');
    assert.equal(g.cells.filter(c => c.inMonth).length, 30);

    // Февраль 2027 начинается в понедельник и длится 28 дней — ровно 4 недели.
    const feb = monthGrid(2027, 1);
    assert.equal(feb.weeks, 4);
    assert.equal(feb.cells.every(c => c.inMonth), true, 'ровный месяц не тащит соседей');
});

test('точки мини-месяца берутся ОДНИМ диапазоном на месяц, а не запросом на день', () => {
    const r = monthRange(2026, 8);
    assert.equal(r.fromIso, '2026-08-31');
    assert.equal(dateToIso(r.from), '2026-08-31');
    // Верхняя граница — полночь ДНЯ ПОСЛЕ последней клетки: иначе записи
    // последнего дня месяца не попадают в ответ.
    assert.equal(dateToIso(r.to), dateToIso(new Date(isoToLocalDay(r.toIso).getTime() + 86400000)));
    assert.ok(r.to > r.from);
    assert.equal(monthKey(2026, 8), '2026-09');
});

test('точка на дне — записи ВЫБРАННЫХ ресурсов, отменённые не в счёт', () => {
    const items = [
        { day: '2026-09-07', resId: 7, status: 'scheduled' },
        { day: '2026-09-07', resId: 7, status: 'cancelled' },
        { day: '2026-09-07', resId: 9, status: 'confirmed' },
        { day: '2026-09-08', resId: 9, status: 'arrived' },
    ];
    assert.deepEqual(countByDay(items, { ids: [7] }), { '2026-09-07': 1 },
        'отменённая запись не делает день занятым');
    assert.deepEqual(countByDay(items, { ids: [7], showCancelled: true }), { '2026-09-07': 2 });
    assert.deepEqual(countByDay(items, { ids: [7, 9] }), { '2026-09-07': 2, '2026-09-08': 1 });
    assert.deepEqual(countByDay(items, { ids: [] }), {}, 'никого не выбрали — точек нет');
    // Строковый id из хранилища не должен ронять счёт.
    assert.deepEqual(countByDay(items, { ids: ['7'] }), { '2026-09-07': 1 });
});

// ---------------------------------------------------------------------------
// Рейка по зданиям
// ---------------------------------------------------------------------------

const DOCS = [
    { id: 1, name: 'Азизов', letter: 'A' },
    { id: 2, name: 'Бакиева', letter: 'B' },
    { id: 3, name: 'Валиев', letter: 'A' },
    { id: 4, name: 'Гулямов', letter: '' },
];

test('рейка группируется ЗДАНИЕМ, со счётом «отмечено из показанных»', () => {
    const g = groupByBranch(DOCS, { letterOf: (r) => r.letter, selected: new Set([1, 2]) });
    assert.deepEqual(g.map(x => x.letter), ['A', 'B', ''], 'порядок групп — порядок справочника');
    assert.deepEqual(g[0].items.map(x => x.id), [1, 3]);
    assert.equal(g[0].selectedCount, 1);
    assert.equal(g[1].selectedCount, 1);
    assert.equal(g[2].letter, '', 'сотрудник без здания не приписывается к чужому');
    assert.equal(g[2].items.length, 1, 'и не выбрасывается из рейки');
});

// ---------------------------------------------------------------------------
// «Работают сегодня»
// ---------------------------------------------------------------------------

const WINDOWS = {
    'doctor:7': { '2026-09-07': { from: '09:00', to: '18:00' }, '2026-09-08': null },
    'doctor:9': { '2026-09-07': null, '2026-09-08': { from: '10:00', to: '15:00' } },
};

test('«Работают сегодня» слушает СЕРВЕР: пустое окно — выходной', () => {
    assert.equal(worksOn(WINDOWS, 'doctor', 7, '2026-09-07'), true);
    assert.equal(worksOn(WINDOWS, 'doctor', 7, '2026-09-08'), false);
    assert.equal(keepsWorkingFilter(WINDOWS, 'doctor', 7, '2026-09-08', true), false);
    assert.equal(keepsWorkingFilter(WINDOWS, 'doctor', 9, '2026-09-08', true), true);
    assert.equal(keepsWorkingFilter(WINDOWS, 'doctor', 7, '2026-09-08', false), true,
        'выключенный фильтр никого не прячет');
});

test('ПРО КОГО НЕ СПРАШИВАЛИ — ТОГО НЕ ПРЯЧЕМ: неизвестное окно не выходной', () => {
    assert.equal(worksOn(WINDOWS, 'doctor', 999, '2026-09-07'), null);
    assert.equal(keepsWorkingFilter(WINDOWS, 'doctor', 999, '2026-09-07', true), true,
        'спрятать врача, окно которого не запрашивали, значит тихо соврать про его выходной');
    assert.equal(worksOn({}, 'doctor', 7, '2026-09-07'), null, 'окна не приехали вовсе — тоже «неизвестно»');
    assert.equal(worksOn(WINDOWS, 'room', 7, '2026-09-07'), null, 'ось не путается: кабинет 7 — не врач 7');
});

// ---------------------------------------------------------------------------
// Загрузка колонки «6/32»
// ---------------------------------------------------------------------------

const APPTS = [
    { doctorId: 7, roomId: 11, date: '2026-09-07', start: 10 * 60, dur: 30, status: 'confirmed' },
    { doctorId: 7, roomId: 11, date: '2026-09-07', start: 15 * 60, dur: 15, status: 'scheduled' },
    { doctorId: 7, roomId: 11, date: '2026-09-07', start: 16 * 60, dur: 30, status: 'cancelled' },
    { doctorId: 7, roomId: 11, date: '2026-09-07', start: 17 * 60, dur: 30, status: 'no_show' },
    { doctorId: 9, roomId: null, date: '2026-09-07', start: 11 * 60, dur: 30, status: 'confirmed' },
    { doctorId: null, roomId: null, date: '2026-09-07', start: 12 * 60, dur: 15, status: 'scheduled' },
];
const loadOf = (resId, step, extra = {}) => columnLoad({
    appts: APPTS, resKey: 'doctorId', resId, dayIso: '2026-09-07',
    step, win: WIN_9_18, canvas: CANVAS, unassignedId: '__unassigned__', ...extra,
});

test('рабочих клеток столько, сколько РЕАЛЬНО влезает в окно с обедом', () => {
    // 09:00–18:00 минус час обеда = 8 часов = 32 клетки по 15 минут.
    assert.equal(workingSlots(WIN_9_18, 15, CANVAS), 32);
    assert.equal(workingSlots(WIN_9_18, 30, CANVAS), 16);
    assert.equal(workingSlots(null, 15, CANVAS), 0, 'выходной — рабочих клеток нет');
});

test('ЗАГРУЗКА КОЛОНКИ ЕСТЬ ЕЁ ЗАПИСИ: числитель — клетки, которые они заняли', () => {
    const l15 = loadOf(7, 15);
    assert.equal(l15.bookings, 2,
        'ни отменённый, ни не пришедший приём времени не держат — сервер продаст этот слот следующему');
    assert.equal(l15.busySlots, 3, 'приём на 30 минут при шаге 15 — это ДВЕ клетки, плюс одна на 15 минут');
    assert.equal(l15.workingSlots, 32);

    // Тот же день и те же записи на получасовом шаге: клеток меньше, а
    // записей столько же — числитель обязан следовать за шагом, а не за
    // числом карточек.
    const l30 = loadOf(7, 30);
    assert.equal(l30.bookings, 2);
    assert.equal(l30.busySlots, 2);
    assert.equal(l30.workingSlots, 16);

    // Колонка без записей — честный ноль, а не пустая строка.
    assert.deepEqual(loadOf(9, 15), { bookings: 1, busySlots: 2, workingSlots: 32 });
    assert.equal(loadOf(1234, 15).busySlots, 0);
});

test('дорожка «Не назначено» считает записи БЕЗ ресурса', () => {
    const l = loadOf('__unassigned__', 15);
    assert.equal(l.bookings, 1, 'приехавшая запись без врача обязана попасть именно сюда');
    assert.equal(l.busySlots, 1);
});

// ---------------------------------------------------------------------------
// Колонки
// ---------------------------------------------------------------------------

const RES = [{ id: 7, name: 'Петров' }, { id: 9, name: 'Каримов' }];

test('колонки идут ДЕНЬ СНАРУЖИ, и первая колонка дня помечена разделителем', () => {
    const cols = buildColumns({
        days: ['2026-09-07', '2026-09-08'], resources: RES, resType: 'doctor',
        windows: WINDOWS, onlyWorking: false,
    });
    assert.deepEqual(cols.map(c => c.dayIso + ':' + c.res.id),
        ['2026-09-07:7', '2026-09-07:9', '2026-09-08:7', '2026-09-08:9']);
    // Разделитель — на СТЫКЕ дней, а не у левого края сетки: слева от первого
    // дня другого дня нет.
    assert.deepEqual(cols.map(c => c.firstOfDay), [false, false, true, false]);
});

test('один день — разделителя нет; «Работают сегодня» убирает колонку только в НЕРАБОЧИЙ день', () => {
    const one = buildColumns({ days: ['2026-09-07'], resources: RES, resType: 'doctor', windows: WINDOWS, onlyWorking: false });
    assert.deepEqual(one.map(c => c.firstOfDay), [false, false], 'в однодневном виде разделять нечего');

    const filtered = buildColumns({
        days: ['2026-09-07', '2026-09-08'], resources: RES, resType: 'doctor',
        windows: WINDOWS, onlyWorking: true,
    });
    // 7-го принимает только Петров, 8-го — только Каримов: у каждого остаётся
    // ТОТ день, в который он работает, а не «врач исчез целиком».
    assert.deepEqual(filtered.map(c => c.dayIso + ':' + c.res.id), ['2026-09-07:7', '2026-09-08:9']);
    assert.deepEqual(filtered.map(c => c.firstOfDay), [false, true]);
});

// ---------------------------------------------------------------------------
// Режим приёма
// ---------------------------------------------------------------------------

test('режим слота — настоящий scheduling_mode сотрудника', () => {
    assert.equal(slotMode({ liveQueue: true }), MODE_LIVE_QUEUE);
    assert.equal(slotMode({ liveQueue: false }), MODE_BY_APPOINTMENT);
    assert.equal(slotMode({}), MODE_BY_APPOINTMENT, 'по умолчанию — по записи, как в карточке сотрудника');
    assert.equal(slotMode(null), MODE_BY_APPOINTMENT);
});

// ---------------------------------------------------------------------------
// Рабочий набор оператора
// ---------------------------------------------------------------------------

function fakeStorage(initial = null) {
    const box = { v: initial };
    return {
        getItem: (k) => (k === WORKING_SET_KEY ? box.v : null),
        setItem: (k, v) => { if (k === WORKING_SET_KEY) box.v = v; },
        peek: () => box.v,
    };
}

test('врачи, число дней и шаг сетки ПЕРЕЖИВАЮТ перезагрузку', () => {
    const st = fakeStorage();
    writeWorkingSet(st, { resType: 'doctor', selected: { doctor: [7, 9], room: [11] }, period: 3, step: 30 });
    const back = readWorkingSet(st);
    assert.deepEqual(back.selected.doctor, [7, 9]);
    assert.deepEqual(back.selected.room, [11], 'набор соседней оси не теряется при переключении');
    assert.equal(back.period, 3);
    assert.equal(back.step, 30);
    assert.equal(back.resType, 'doctor');
});

test('ДЕНЬ НЕ ЗАПОМИНАЕТСЯ НАМЕРЕННО: экран всегда открывается на сегодня', () => {
    const st = fakeStorage();
    writeWorkingSet(st, { resType: 'doctor', selected: { doctor: [7] }, period: 1, step: 15, dayIso: '2020-01-01' });
    assert.equal('dayIso' in readWorkingSet(st), false,
        'вчерашнее расписание, молча показанное утром как сегодняшнее, — это пропущенные приёмы');
    assert.equal(JSON.parse(st.peek()).dayIso, undefined);
});

test('мусор в хранилище не роняет экран и не даёт невозможных значений', () => {
    assert.deepEqual(readWorkingSet({ getItem: () => 'не json' }), normalizeWorkingSet(null));
    assert.deepEqual(readWorkingSet(null), normalizeWorkingSet(null));
    assert.deepEqual(readWorkingSet({ getItem: () => { throw new Error('приватный режим'); } }), normalizeWorkingSet(null));
    const bad = normalizeWorkingSet({ resType: 'equip', period: 99, step: 7, selected: { doctor: 'нет' } });
    assert.equal(bad.resType, 'doctor', 'ось, которой нет, не становится третьим поведением');
    assert.equal(bad.period, MAX_DAYS, 'число дней зажимается пределом сетки');
    assert.equal(bad.step, 15, 'шаг вне списка — это 15, а не «сетка из семиминутных клеток»');
    assert.deepEqual(bad.selected.doctor, []);
    // Запись при недоступном хранилище — не исключение, а тихий отказ.
    assert.doesNotThrow(() => writeWorkingSet({ setItem: () => { throw new Error('quota'); } }, { period: 2 }));
});

test('ЗАПОМНЕННЫЙ ВЫБОР — ПОДСКАЗКА: уволенный врач не оставляет пустую сетку', () => {
    const pool = [{ id: 7 }, { id: 9 }, { id: 11 }, { id: 12 }];
    assert.deepEqual(restoreSelection([9, 7], pool), [7, 9], 'порядок берётся из справочника, а не из хранилища');
    assert.deepEqual(restoreSelection(['9'], pool), [9], 'число, ставшее строкой в JSON, всё ещё тот же врач');
    assert.deepEqual(restoreSelection([7, 999], pool), [7], 'исчезнувший id просто отпадает');
    assert.deepEqual(restoreSelection([999], pool, 2), [7, 9],
        'не осталось ничего — обычные «первые», а не пустая сетка с надписью «выберите»');
    assert.deepEqual(restoreSelection([], pool, 2), [7, 9]);
    assert.deepEqual(restoreSelection([7], []), [], 'пустой справочник — пустой выбор, без исключений');
});

// ---------------------------------------------------------------------------
// Словарь
// ---------------------------------------------------------------------------

test('в счётном модуле нет ни одной строки для человека — они живут рядом с tr()', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, 'rcal-layout.js'), 'utf8');
    // Кириллица в файле есть только в комментариях: их сборщик текста и не
    // трогает, а строковых литералов с кириллицей быть не должно вовсе.
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/['"`][^'"`]*[Ѐ-ӿ]/.test(noComments), false,
        'строка для человека попала в счётный модуль — её место в room-calendar.js под tr()');
});

test('слова счётчика дней переведены на все три языка', () => {
    for (const w of ['день', 'дня', 'дней', 'по записи', 'живая очередь', 'выбрано', 'Работают сегодня']) {
        const e = STRINGS[w];
        assert.ok(e, 'нет ключа словаря: ' + w);
        for (const lang of ['ru', 'uz', 'en']) {
            assert.equal(typeof e[lang], 'string', w + ': нет перевода ' + lang);
            assert.notEqual(e[lang].trim(), '', w + ': пустой перевод ' + lang);
        }
    }
});
