// RCAL_REFERENCE_LAYOUT_V1 — раскладка «Календаря записи» по референсу владельца.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. views/room-calendar.js импортирует supabase.js и ui.js,
// то есть в node не загружается вовсе («document is not defined»), и всё, что
// в нём написано, проверяется только через тяжёлый стенд с поддельным DOM. Тут
// живёт СЧЁТНАЯ часть новой раскладки — сколько дней помещается в сетку, какие
// клетки мини-месяца рисовать, что показывает счётчик загрузки колонки, кто
// работает в этот день и что запоминается между открытиями экрана. Ни одной
// строки для человека здесь нет намеренно: интерфейсный текст живёт рядом с
// tr() в самом экране, а этот файл считает числа (тот же приём, что у
// views/doctor-pool.js и views/lab-grouping.js).
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: правил записи. Занятость, рабочие окна, обеды,
// запрет двойной записи и межфилиальные вердикты считает сервер
// (rpc/slot-engine.js, rpc/calendar.js) — вторая их реализация в браузере уже
// была и уже разошлась с первой. Здесь только раскладка.

// ---------------------------------------------------------------------------
// Сетка: высота строки и сколько дней помещается
// ---------------------------------------------------------------------------

/**
 * Высота одной клетки по шагу сетки. Не линейная: у пятиминутного шага строк
 * втрое больше, и линейная высота увела бы полотно за три экрана, а у
 * получасового строка обязана вместить время, фамилию и услугу.
 */
export const ROW_PX = Object.freeze({ 5: 12, 10: 18, 15: 28, 20: 34, 30: 44, 60: 64 });

/** Шаги сетки, которые предлагает селектор (как в референсе). */
export const STEP_CHOICES = Object.freeze([5, 10, 15, 20, 30, 60]);

export function rowPx(step) {
    const s = Number(step) || 15;
    return ROW_PX[s] || Math.max(12, Math.min(80, Math.round(s * 1.6)));
}
export function pxPerMin(step) {
    const s = Number(step) || 15;
    return rowPx(s) / s;
}

/**
 * Подпись «филиал · режим приёма» помещается в клетку не всегда: на пяти- и
 * десятиминутном шаге строка ниже строки текста, и подпись превратилась бы в
 * обрезанную кашу. Порог — высота строки, а не шаг: он остаётся верным, если
 * когда-нибудь поменяется ROW_PX.
 */
export const SLOT_LABEL_MIN_PX = 22;
export const showsSlotLabel = (step) => rowPx(step) >= SLOT_LABEL_MIN_PX;

/**
 * СКОЛЬКО ДНЕЙ ПОКАЗЫВАТЬ — РЕШЕНИЕ, А НЕ ПРЕДЕЛ ТИПА ДАННЫХ.
 *
 * Референс даёт шаг «— N дней +» и упирается в 7. Но дни в этой сетке
 * умножаются на врачей: четыре врача на неделю — это 28 колонок, то есть
 * четыре экрана горизонтальной прокрутки, где не видно ни одного дня целиком.
 * Читать такую сетку нельзя, а нарисовать — можно, и именно это делает её
 * опасной: она выглядит как расписание.
 *
 * Поэтому пределов два: НЕДЕЛЯ (дальше вопрос «когда свободно» решает
 * мини-месяц, а не сетка) и ДВАДЦАТЬ ЧЕТЫРЕ КОЛОНКИ — примерно полтора экрана
 * при минимальной ширине колонки 150 px. Что именно упёрлось, экран говорит
 * словами у самой кнопки «+», а не молча её гасит.
 */
export const MAX_DAYS = 7;
export const MAX_COLUMNS = 24;

export function maxDaysFor(resourceCount) {
    const n = Math.max(0, Number(resourceCount) || 0);
    if (!n) return MAX_DAYS;
    return Math.max(1, Math.min(MAX_DAYS, Math.floor(MAX_COLUMNS / n)));
}
/** Почему «+» неактивна: 'week' — упёрлись в неделю, 'columns' — в ширину. */
export function dayStepBlock(period, resourceCount) {
    const p = Math.max(1, Number(period) || 1);
    const max = maxDaysFor(resourceCount);
    if (p < max) return null;
    return max >= MAX_DAYS ? 'week' : 'columns';
}

// ---------------------------------------------------------------------------
// Даты
// ---------------------------------------------------------------------------

export function dateToIso(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
export function isoToLocalDay(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}
export const monthKey = (year, month) => `${year}-${String(month + 1).padStart(2, '0')}`;

/**
 * Клетки мини-месяца, понедельник первым. Недель ровно столько, сколько
 * занимает месяц (5 или 6) — лишняя строка следующего месяца рисовала бы дни,
 * которых в этом месяце нет, и путала бы точки занятости.
 */
export function monthGrid(year, month) {
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7;
    const dim = new Date(year, month + 1, 0).getDate();
    const weeks = Math.ceil((lead + dim) / 7);
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
        const d = new Date(year, month, i - lead + 1);
        cells.push({ iso: dateToIso(d), day: d.getDate(), weekday: d.getDay(), inMonth: d.getMonth() === month });
    }
    return { weeks, cells };
}

/**
 * Границы ОДНОГО запроса за точками мини-месяца: с местной полуночи первого дня
 * СЕТКИ месяца по полночь дня после последней. Спрашивать по дню — это 42
 * запроса на каждое перелистывание месяца, и ровно этого требование владельца
 * («точки на днях с записями») не стоит.
 */
export function monthRange(year, month) {
    const { cells } = monthGrid(year, month);
    const from = isoToLocalDay(cells[0].iso);
    const lastDay = isoToLocalDay(cells[cells.length - 1].iso);
    const to = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
    return { fromIso: cells[0].iso, toIso: cells[cells.length - 1].iso, from, to };
}

/**
 * Точки мини-месяца: сколько записей в каждый день у ВЫБРАННЫХ ресурсов.
 *
 * items — уже приведённые строки {day, resId, status}; месяц приезжает одним
 * ответом, а пересчёт под новый набор врачей идёт здесь, без похода на сервер:
 * иначе каждая галочка в рейке стоила бы запроса.
 */
export function countByDay(items, { ids = null, showCancelled = false } = {}) {
    const want = ids ? new Set(ids.map(String)) : null;
    const out = {};
    for (const it of items || []) {
        if (!it || !it.day) continue;
        if (!showCancelled && it.status === 'cancelled') continue;
        if (want && !want.has(String(it.resId))) continue;
        out[it.day] = (out[it.day] || 0) + 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Рейка: группировка по зданиям
// ---------------------------------------------------------------------------

/**
 * Врачи в рейке сгруппированы ЗДАНИЕМ, как в референсе: «MEDION LABZAK · ML
 * 3/6». Ресурс без здания не выбрасывается и не приписывается к первому
 * попавшемуся — у него своя группа с пустым ключом, и экран подписывает её
 * честно («здание не указано»). Порядок групп — порядок первого появления,
 * то есть порядок справочника, а не алфавит буквы.
 */
export function groupByBranch(items, { letterOf, selected } = {}) {
    const sel = selected instanceof Set ? selected : new Set(selected || []);
    const groups = [];
    const byKey = new Map();
    for (const r of items || []) {
        const letter = (letterOf ? letterOf(r) : r.letter) || '';
        if (!byKey.has(letter)) {
            const g = { letter, items: [], selectedCount: 0 };
            byKey.set(letter, g);
            groups.push(g);
        }
        const g = byKey.get(letter);
        g.items.push(r);
        if (sel.has(r.id)) g.selectedCount++;
    }
    return groups;
}

// ---------------------------------------------------------------------------
// «Работают сегодня» и загрузка колонки
// ---------------------------------------------------------------------------

/**
 * Работает ли ресурс в этот день — ПО ОТВЕТУ СЕРВЕРА (calendar_windows), а не
 * по местной догадке. Три значения, и третье важнее двух первых:
 *
 *   true  — окно приехало;
 *   false — окно приехало пустым: в этот день ресурс не принимает;
 *   null  — окна не спрашивали (ресурс не попал в запрос).
 *
 * НЕИЗВЕСТНОЕ НЕ ПРЯЧЕТСЯ. Фильтр «Работают сегодня» на null отвечает «пусть
 * остаётся»: спрятать врача, про которого мы просто не спросили, — это тихо
 * соврать, что он не принимает. Та же логика, что у railBranchOk в экране.
 */
export function worksOn(windows, resType, id, dayIso) {
    const byDay = (windows || {})[resType + ':' + id];
    if (!byDay || !(dayIso in byDay)) return null;
    return !!byDay[dayIso];
}
export function keepsWorkingFilter(windows, resType, id, dayIso, onlyWorking) {
    if (!onlyWorking) return true;
    return worksOn(windows, resType, id, dayIso) !== false;
}

/** Клетка нерабочая: вне окна или в перерыве. Копия правила экрана, в минутах. */
function offAt(win, min) {
    if (!win) return true;
    if (min < win.from || min >= win.to) return true;
    return (win.breaks || []).some((b) => min >= b.from && min < b.to);
}

/** Сколько рабочих клеток шага помещается в окно этого дня на полотне сетки. */
export function workingSlots(win, step, canvas) {
    if (!win) return 0;
    const s = Math.max(1, Number(step) || 15);
    let n = 0;
    for (let m = canvas.from; m < canvas.to; m += s) if (!offAt(win, m)) n++;
    return n;
}

/**
 * ЗАГРУЗКА КОЛОНКИ — «6/32» из референса.
 *
 * Числитель — КЛЕТКИ, занятые записями, а не число записей: приём на 30 минут
 * при шаге 15 съедает две клетки, и «1» на месте числителя означала бы, что
 * половина дня свободна, когда она занята. Знаменатель — рабочие клетки этого
 * дня, то есть та же мера. Число записей возвращается рядом (bookings): оно
 * нужно подписи, но не дроби.
 *
 * ВРЕМЯ ЗАНИМАЮТ РОВНО ТЕ ЖЕ ТРИ СТАТУСА, ЧТО НА СЕРВЕРЕ (BUSY_STATUSES в
 * slot-engine.js): записан, подтверждён, пришёл. Отменённый и не пришедший
 * приёмы времени не держат — сервер продаст этот слот следующему, — и
 * загрузка, считающая их занятыми, показывала бы день полнее, чем он есть, то
 * есть отговаривала бы записывать туда, куда записать можно.
 */
export const BUSY_STATUSES = Object.freeze(['scheduled', 'confirmed', 'arrived']);

export function columnLoad({ appts, resKey, resId, dayIso, step, win, canvas, unassignedId = null }) {
    const s = Math.max(1, Number(step) || 15);
    const mine = (appts || []).filter((a) => a.date === dayIso
        && BUSY_STATUSES.includes(a.status)
        && (resId === unassignedId ? !a[resKey] : a[resKey] === resId));
    const cells = new Set();
    for (const a of mine) {
        const from = Math.max(canvas.from, a.start);
        const to = Math.min(canvas.to, a.start + a.dur);
        for (let m = Math.floor((from - canvas.from) / s) * s + canvas.from; m < to; m += s) cells.add(m);
    }
    return { bookings: mine.length, busySlots: cells.size, workingSlots: workingSlots(win, s, canvas) };
}

// ---------------------------------------------------------------------------
// Колонки сетки
// ---------------------------------------------------------------------------

/**
 * Колонки «день × ресурс», ДЕНЬ СНАРУЖИ. Порядок не косметический: при
 * нескольких днях оператор читает день целиком («что у нас во вторник»), а
 * колонки одного врача через весь экран этому мешают.
 *
 * firstOfDay — ЭТО СТЫК, а не «первая колонка». У самого первого дня его нет:
 * слева от него не другой день, а край сетки, и лишняя жирная линия там
 * читалась бы как ещё одна граница между днями, которой не существует.
 */
export function buildColumns({ days, resources, resType, windows, onlyWorking }) {
    const cols = [];
    const list = days || [];
    for (let di = 0; di < list.length; di++) {
        const dayIso = list[di];
        let first = true;
        for (const res of resources || []) {
            if (!keepsWorkingFilter(windows, resType, res.id, dayIso, onlyWorking)) continue;
            cols.push({ res, dayIso, firstOfDay: first && di > 0 });
            first = false;
        }
    }
    return cols;
}

// ---------------------------------------------------------------------------
// Режим приёма — подпись слота
// ---------------------------------------------------------------------------

export const MODE_LIVE_QUEUE = 'live_queue';
export const MODE_BY_APPOINTMENT = 'by_appointment';
/** Врач с scheduling_mode='live_queue' ведёт живую очередь; всё прочее — по записи. */
export const slotMode = (res) => (res && res.liveQueue ? MODE_LIVE_QUEUE : MODE_BY_APPOINTMENT);

// ---------------------------------------------------------------------------
// Рабочий набор оператора между открытиями экрана
// ---------------------------------------------------------------------------
//
// ЧТО ПЕРЕЖИВАЕТ ПЕРЕЗАГРУЗКУ И ПОЧЕМУ. Отмеченные ресурсы, число дней и шаг
// сетки — это НАСТРОЙКА РАБОЧЕГО МЕСТА, а не вопрос, который человек задаёт
// один раз: регистратор ведёт своих четырёх врачей из сорока и переставляет их
// раз в месяц, а вкладку в клинике перезагружают по десять раз в день (и ещё
// раз — ночным перезапуском). Терять этот выбор значит заставлять его собирать
// рейку заново каждое утро.
//
// ЧТО НЕ ПЕРЕЖИВАЕТ, И ЭТО ТОЖЕ РЕШЕНИЕ:
//   • ДЕНЬ. Экран всегда открывается на сегодня. Вчерашнее расписание, молча
//     показанное утром как текущее, — это пропущенные приёмы;
//   • «Отменённые» и «Работают сегодня». Это вопросы к одной картинке
//     («а где отменённые?»), а не устройство рабочего места;
//   • поиск, направление и филиал — тем более: они сужают ответ на вопрос,
//     который уже закрыт.
//
// Хранилище передаётся аргументом, а не берётся из window: у localStorage в
// приватном режиме кидается сам доступ к свойству, и падать из-за настройки
// вида этот экран не должен ни при каких обстоятельствах.

export const WORKING_SET_KEY = 'rcal.workingset.v1';

const RES_TYPES = ['doctor', 'room'];

export function normalizeWorkingSet(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const selected = {};
    for (const t of RES_TYPES) {
        const list = Array.isArray(o.selected && o.selected[t]) ? o.selected[t] : [];
        selected[t] = [...new Set(list.filter((v) => v != null && v !== ''))];
    }
    const step = STEP_CHOICES.includes(Number(o.step)) ? Number(o.step) : 15;
    const period = Math.max(1, Math.min(MAX_DAYS, Math.round(Number(o.period) || 1)));
    const resType = RES_TYPES.includes(o.resType) ? o.resType : 'doctor';
    return { resType, selected, period, step };
}

export function readWorkingSet(storage) {
    try {
        const raw = storage && storage.getItem ? storage.getItem(WORKING_SET_KEY) : null;
        return normalizeWorkingSet(raw ? JSON.parse(raw) : null);
    } catch (e) {
        return normalizeWorkingSet(null);
    }
}

export function writeWorkingSet(storage, value) {
    const ws = normalizeWorkingSet(value);
    try {
        if (storage && storage.setItem) storage.setItem(WORKING_SET_KEY, JSON.stringify(ws));
    } catch (e) { /* приватный режим, переполненное хранилище — не повод ронять экран */ }
    return ws;
}

/**
 * Запомненный выбор — ПОДСКАЗКА, А НЕ ПРИКАЗ. Врача могли уволить, кабинет
 * закрыть, филиал переключить: id из хранилища сверяются с тем, что реально
 * есть в рейке, и если не осталось ничего — экран возвращается к своему
 * обычному «первые шесть», а не показывает пустую сетку с надписью «выберите».
 */
export function restoreSelection(storedIds, available, fallbackCount = 6) {
    const have = new Set((available || []).map((r) => String(r.id)));
    const keep = (storedIds || []).filter((id) => have.has(String(id)));
    if (keep.length) {
        // Возвращаются id ИЗ СПРАВОЧНИКА: в хранилище число могло стать строкой.
        return (available || []).filter((r) => keep.some((id) => String(id) === String(r.id))).map((r) => r.id);
    }
    return (available || []).slice(0, fallbackCount).map((r) => r.id);
}
