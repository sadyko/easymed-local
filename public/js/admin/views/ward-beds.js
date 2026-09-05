// Ward & beds — INPATIENT_LOCAL_V1. Fresh local bed board + admit/discharge,
// built on the local /api (the legacy cloud beds.js was Supabase/RLS-coupled).
// Occupancy is DERIVED from active admissions (not trusted from beds.status),
// mirroring easymed's currentByBed map. Money is server-side:
//   set_bed_status / transfer_admission / create_invoice_for_admission
//   (server/services/rpc/inpatient.js).
// INPATIENT_ROUTE — ПОСТУПЛЕНИЕ И ВЫПИСКА ЗДЕСЬ БОЛЬШЕ НЕ ЖИВУТ. Обе кнопки
// звали RPC версии v0.8.0 (admit_patient / discharge_patient), каждый из
// которых проходил весь маршрут госпитализации одним движением: поступление —
// без осмотра и без лечащего врача, выписка — без исхода, без эпикриза и без
// врачебной подписи. Поступление теперь в разделе «Стационар», выписка — в
// карте госпитализации и на экране «Выписки к оформлению». Подробности у
// каждого из двух мест ниже.
// Deferred vs easymed (flagged): transfers/home-bed, per-stay service/product
// line-items, prescriptions, monthly continuable accrual, full-screen console.
//
// ─── BED_BOARD_SHARED_V1 (2026-09-05) — ДОСКА КОЕК СТАЛА ОБЩИМ ЯЗЫКОМ ────────
// Владелец: «admission request are filled with dialogue window of the
// stationary. selecting beds or rooms like in the ui of the beds».
//
// До этой правки выбор койки существовал ДВАЖДЫ и выглядел по-разному: здесь —
// палатами и плитками с занятостью, а в окне «Положить на койку»
// (admission-modal.js) — плоским списком строк. Один и тот же коечный фонд в
// двух видах: медсестра, которая весь день читает доску, в момент размещения
// получала незнакомый экран и шла сверяться обратно на доску.
//
// Поэтому доска отдаётся наружу ТРЕМЯ частями — loadBedFund (коечный фонд и
// занятость), wardPillsEl (выбор палаты) и bedBoardEl (сама доска), — и окно
// выбора зовёт ИХ ЖЕ, а не копию. Копия разошлась бы в первый же день, когда на
// доску добавят состояние койки: список в окне о нём бы не узнал. Наружу отдана
// ровно эта тройка: палата-карточка и койка-плитка остаются внутренними —
// рисовать их поштучно снаружи некому.
//
// Что осталось ЗДЕСЬ и никуда не переехало: деньги (счёт, проживание, услуги и
// товары госпитализации), переводы между койками и журнал движений. Это не
// «как показать койку», а «что с ней делать», и второго места у этой работы
// быть не должно.
//
// ─── INPATIENT_ONE_SECTION_V1 — ЭКРАН УМЕЕТ БЫТЬ ВКЛАДКОЙ ───────────────────
// `ctx.embedded` снимает у экрана его СЕГМЕНТНЫЙ ПЕРЕКЛЮЧАТЕЛЬ «Койки /
// Госпитализации» и кнопку «Ждут размещения»: внутри раздела «Стационар»
// (views/admissions.js) эту работу делает полоса вкладок этажом выше, а полоса
// вкладок над сегментным переключателем — два переключателя на одном экране,
// ровно тот же дубль, который владелец просил убрать из меню.
//
// Шапка при этом ОСТАЁТСЯ: заголовок из неё снимает оболочка
// (dedupeSectionHeading в admin.js) — механизм против дубля имён в приложении
// один, и второй, свой, здесь заводить незачем.

import { supabase } from '../../supabase.js';
import { isAccommodationLine, isServiceLine, isGoodsLine, ACCOMMODATION_LABEL } from '../../shared/accommodation-line.js';
// INPATIENT_FLOW_V1 — «в койке» это ЧЕТЫРЕ состояния, а не 'active' (миграция 091).
import { IN_BED_STATUSES, admissionStatusLabel } from '../../shared/admission-status.js';
import { CAT_ORDER, categoryOf, filterCatalog, categoryCounts } from '../../shared/service-categories.js';   // SERVICE_CATALOG_FILTER_V1   // ACCOMMODATION_AS_SERVICE_V1
import { h, Icon, clear, toast, Tag, field, fmtDateTime, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — tr() matches WHOLE strings, so assembled sentences go through trf(): translate first, substitute second
import { searchableSelect } from './searchable-select.js?v=ss2';   // SEARCHABLE_SELECT_V1

const STATUS = {
    free:        { label: 'Свободна',  bg: 'var(--ok-50, #e9f7ef)',      fg: 'var(--ok-700, #1a7a44)',      bd: 'var(--ok-200, #bde5cd)',      dot: 'var(--ok-500, #2e8b52)' },
    occupied:    { label: 'Занята',    bg: 'var(--primary-50, #e8f3f2)', fg: 'var(--primary-700, #1f7a72)', bd: 'var(--primary-200, #bcdedb)', dot: 'var(--primary-600, #1f7a72)' },
    cleaning:    { label: 'Уборка',    bg: 'var(--warn-50, #fdf5e6)',    fg: 'var(--warn-700, #9a6b00)',    bd: 'var(--warn-200, #f0dca8)',    dot: 'var(--warn-500, #d9a441)' },
    maintenance: { label: 'Ремонт',    bg: 'var(--ink-50, #f1f2f4)',     fg: 'var(--ink-600, #545b66)',     bd: 'var(--ink-200, #d5d8dd)',     dot: 'var(--ink-300, #b9c0cc)' },
};

// WARD_BOARD_V2 — enum-значения больше не показываются как есть: в шапке палаты
// стояло "general · daily", то есть код таблицы вместо слов.
const WARD_TYPE_LABEL = {
    general: 'Общая', icu: 'ПИТ / реанимация', maternity: 'Родильная',
    pediatrics: 'Детская', surgery: 'Хирургическая', oncology: 'Онкологическая',
    isolation: 'Изолятор', other: 'Прочее',
};
const BED_TYPE_LABEL = {
    standard: 'Обычная', icu: 'ПИТ', isolation: 'Изолятор',
    vip: 'VIP', recovery: 'Послеоперационная', observation: 'Наблюдение',
};
// STATIONARY_ROOMS_V1 — какие КАБИНЕТЫ относятся к стационарному блоку. Список
// намеренно узкий: приём, процедурная, диагностика и лаборатория к койкам
// отношения не имеют и на этой доске были бы шумом.
const STATIONARY_ROOM_TYPES = ['surgery'];


function fmtPrice(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v < 0 ? '-' : '';
    return sign + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function lengthOfStay(fromIso) {
    const ms = Date.now() - Date.parse(fromIso);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const h = Math.floor(ms / 3600000);
    if (h < 48) return h + ' h';
    return Math.floor(h / 24) + ' d';
}
// Client-side ESTIMATE only (server is authoritative on discharge).
function estimateCharge(ward, bed, admittedAt, discountPct = 0) {
    const mode = ward && ward.billing_mode === 'hourly' ? 'hourly' : 'daily';
    const rate = mode === 'daily'
        ? ((bed && bed.price_per_day > 0) ? bed.price_per_day : (ward ? ward.price_per_day : 0))
        : ((bed && bed.price_per_hour > 0) ? bed.price_per_hour : (ward ? ward.price_per_hour : 0));
    const ms = Math.max(0, Date.now() - Date.parse(admittedAt));
    let units;
    if (mode === 'daily') { let d = Math.floor(ms / 86400000) + 1; if (d > 1) d -= 1; units = Math.max(1, d); }
    else units = Math.max(1, Math.ceil(ms / 3600000));
    const gross = Math.round(units * (rate || 0));
    const net = Math.round(gross * (1 - Math.min(100, Math.max(0, discountPct)) / 100));
    return { mode, rate: rate || 0, units, gross, net, unitLabel: mode === 'daily' ? 'day' : 'hour' };
}

let state = { tab: 'board', wardFilter: 'all', statusFilter: 'all', embedded: false };
// ADMISSION_ORDER_V1 — переход в окно медсестры. Доска коек показывает ФОНД
// (кто где лежит), очередь размещения живёт в «Стационаре»; без ссылки между
// ними администратор, увидевший свободную койку, не знает, кого на неё ждут.
// INPATIENT_ONE_SECTION_V1 — внутри раздела ссылка не нужна и потому убрана:
// очередь размещения теперь СОСЕДНЯЯ ВКЛАДКА, до неё один щелчок по полосе.
// Кнопка остаётся у отдельного маршрута #beds, где соседней вкладки нет.
let navigateTo = null;

/**
 * @param {HTMLElement} container
 * @param {{onNavigate?:Function, embedded?:boolean}} ctx
 *   `embedded` — экран рисуется вкладкой «Койки» раздела «Стационар»: журнал
 *   госпитализаций там СВОЯ вкладка (admissionsHistoryCard), поэтому
 *   собственный сегментный переключатель не показывается.
 */
export async function renderWardBeds(container, ctx = {}) {
    clear(container);
    navigateTo = ctx.onNavigate || null;
    state = { tab: 'board', wardFilter: 'all', statusFilter: 'all', embedded: !!ctx.embedded };
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root);
}

async function loadData() {
    const [wardsR, bedsR, admR, roomsR] = await Promise.all([
        supabase.from('wards').select('*').eq('active', 1).order('name'),
        supabase.from('beds').select('*, wards(name)').eq('active', 1).order('code'),
        // INPATIENT_FLOW_V1 — доска коек СЧИТАЕТ ЗАНЯТОСТЬ ПО ЭТОМУ ЗАПРОСУ, и
        // до 091 он спрашивал ровно status='active'. Пациент, которого медсестра
        // положила, но главный врач ещё не осмотрел, лежит в 'admitted': оставь
        // здесь 'active', и его койка показалась бы свободной, проживание за неё
        // никто бы не внёс, а сверху положили бы второго пациента.
        supabase.from('admissions').select('*, patients(mrn, full_name), users(full_name)').in('status', IN_BED_STATUSES),
        // STATIONARY_ROOMS_V1 — операционная заводится в «Помещениях» как КАБИНЕТ
        // (коек и платы за проживание у неё нет), но по смыслу она стационарная и
        // владелец ищет её здесь. Доска грузит такие кабинеты отдельно и показывает
        // их своей карточкой — без коек и без госпитализации.
        supabase.from('rooms').select('id, name, code, room_type, floor_id, active')
            .eq('active', 1).in('room_type', STATIONARY_ROOM_TYPES),
    ]);
    if (wardsR.error) throw wardsR.error;
    if (bedsR.error) throw bedsR.error;
    if (admR.error) throw admR.error;
    const currentByBed = new Map();
    for (const a of (admR.data || [])) if (a.bed_id != null) currentByBed.set(a.bed_id, a);
    return { wards: wardsR.data || [], beds: bedsR.data || [], admissions: admR.data || [], currentByBed,
             opRooms: (roomsR && roomsR.data) || [] };
}

// Effective status of a bed = occupied if an active admission points at it,
// else the housekeeping status stored on the bed.
function bedStatus(bed, currentByBed) {
    return currentByBed.has(bed.id) ? 'occupied' : (bed.status === 'occupied' ? 'occupied' : bed.status);
}

// BED_BOARD_SHARED_V1 — ОДИН коечный фонд и ОДНО правило «занята ли койка» на
// оба места. Окно выбора койки (admission-modal.js) считало занятость своим
// запросом; расхождение здесь стоило бы двух пациентов на одной койке.
export async function loadBedFund() { return loadData(); }

async function paint(root) {
    clear(root);
    // INPATIENT_ONE_SECTION_V1 — шапка ОСТАЁТСЯ и во вкладке: заголовок из неё
    // снимает оболочка (dedupeSectionHeading в admin.js), а подзаголовок —
    // подсказка «нажмите на койку, чтобы действовать» — нужен именно тут.
    //
    // А вот два ОРГАНА УПРАВЛЕНИЯ во вкладке лишние, и оба по одной причине:
    // их работу делает полоса вкладок этажом выше. Сегментный переключатель
    // «Койки / Госпитализации» стал двумя из трёх вкладок, а кнопка «Ждут
    // размещения» вела бы на соседнюю вкладку — то есть на расстояние одного
    // щелчка по полосе, которая и так на глазах. У отдельного маршрута #beds
    // соседней вкладки нет, и там оба остаются.
    root.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, tr('Стационар')),
            h('p', { class: 'page-subtitle' }, tr('Койки, госпитализации и выписки. Нажмите на койку, чтобы действовать.')),
        ),
        state.embedded ? null : h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            navigateTo ? h('button', {
                class: 'btn btn-sm', type: 'button', onclick: () => navigateTo('admissions'),
            }, Icon('Clock', { size: 13 }), ' ', tr('Ждут размещения')) : null,
            h('div', { class: 'segmented' },
                tabBtn(tr('Койки'), 'board', root),
                tabBtn(tr('Госпитализации'), 'admissions', root),
            ),
        ),
    ));

    let data;
    try { data = await loadData(); }
    catch (e) {
        root.appendChild(h('div', { class: 'card', style: { padding: '18px' } }, h('div', { class: 'empty' }, trf('Не удалось загрузить: {msg}', { msg: (e && e.message) || e }))));
        return;
    }

    if (state.tab === 'admissions') { root.appendChild(await admissionsTable()); return; }

    // KPI strip (also status filters)
    const counts = { all: data.beds.length, free: 0, occupied: 0, cleaning: 0, maintenance: 0 };
    for (const b of data.beds) counts[bedStatus(b, data.currentByBed)]++;
    root.appendChild(kpiStrip(counts, root));

    // Ward filter pills
    root.appendChild(wardPills(data, root));

    // Ward cards — та же функция, которой рисует себя окно выбора койки.
    root.appendChild(bedBoardEl(data, {
        mode: 'board',
        wardFilter: state.wardFilter,
        statusFilter: state.statusFilter,
        showOpRooms: true,
        onBed: (bed, ward, adm) => onBedClick(bed, ward, adm, root),
    }));
}

// STATIONARY_ROOMS_V1 — карточка операционных. Плитки НЕ кликабельны: положить
// пациента в операционную нельзя (коек нет), а делать вид, что можно, хуже, чем
// не делать ничего. Правятся они там же, где заводятся — в «Помещениях».
function opRoomsCard(data) {
    const tiles = h('div', { class: 'wb-tiles' });
    for (const r of data.opRooms) {
        tiles.appendChild(h('div', { class: 'wb-op' },
            h('div', { class: 'wb-op__top' },
                h('span', { class: 'wb-op__ic' }, Icon('Pulse', { size: 14 })),
                h('strong', { style: { fontSize: '13.5px' } }, r.name || '—'),
                r.code ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, r.code) : null),
            h('div', { class: 'muted', style: { fontSize: '12.5px' } }, tr('Операционная'))));
    }
    return h('div', { class: 'card wb-ward' },
        h('div', { class: 'wb-ward__head' },
            h('div', { class: 'wb-ward__id' },
                h('h3', { class: 'wb-ward__name' }, tr('Операционные')),
                h('span', { class: 'muted wb-ward__meta' }, tr('без коек · правятся в «Помещениях»'))),
            h('span', { class: 'muted wb-ward__occlb' }, trf('помещений: {n}', { n: data.opRooms.length }))),
        tiles);
}

function tabBtn(label, tab, root) {
    const b = h('button', { class: 'segmented-btn' + (state.tab === tab ? ' on' : ''), type: 'button', onclick: () => { state.tab = tab; paint(root); } }, label);
    return b;
}

function kpiStrip(counts, root) {
    const occPct = counts.all ? Math.round(counts.occupied / counts.all * 100) : 0;
    // WARD_BOARD_V2 — плитки одновременно ФИЛЬТР, а выбранная была отмечена
    // голым outline: это читается как фокус с клавиатуры, а не как выбор.
    // Теперь у выбранной свой класс с заливкой и точкой статуса.
    const tile = (key, label, sub) => h('button', {
        class: 'card wb-kpi' + (state.statusFilter === key ? ' is-on' : ''),
        type: 'button',
        'aria-pressed': state.statusFilter === key ? 'true' : 'false',
        onclick: () => { state.statusFilter = state.statusFilter === key ? 'all' : key; paint(root); },
    },
        h('span', { class: 'wb-kpi__lb' },
            key !== 'all' ? h('span', { class: 'wb-kpi__dot', style: { background: (STATUS[key] || {}).dot || 'var(--ink-300)' } }) : null,
            label),
        h('span', { class: 'wb-kpi__n' }, String(counts[key])),
        sub ? h('span', { class: 'wb-kpi__sub muted' }, sub) : null,
    );
    return h('div', { class: 'wb-kpis' },
        tile('all', tr('Все койки'), trf('занято {n}%', { n: occPct })),
        tile('free', tr('Свободно'), tr('можно класть')),
        tile('occupied', tr('Занято'), tr('пациенты в палате')),
        tile('cleaning', tr('Уборка'), tr('готовится')),
        tile('maintenance', tr('Ремонт'), tr('не используется')),
    );
}

// BED_BOARD_SHARED_V1 — ПАЛАТЫ ПОЛОСОЙ. Это и есть «выбор палаты» в языке
// доски: владелец назвал койки И палаты («selecting beds or rooms»), и палата
// выбирается здесь, а койка — плиткой внутри неё.
export function wardPillsEl(data, { value = 'all', onPick = null } = {}) {
    const pill = (id, label) => h('button', {
        class: 'segmented-btn' + (String(value) === String(id) ? ' on' : ''),
        type: 'button', onclick: () => { if (onPick) onPick(id); },
    }, label);
    const wrap = h('div', { class: 'segmented', style: { flexWrap: 'wrap', marginBottom: '14px' } }, pill('all', trf('Все палаты · {n}', { n: data.beds.length })));
    for (const w of data.wards) {
        const n = data.beds.filter(b => b.ward_id === w.id).length;
        wrap.appendChild(pill(w.id, w.name + ' · ' + n));
    }
    return wrap;
}

function wardPills(data, root) {
    return wardPillsEl(data, { value: state.wardFilter, onPick: (id) => { state.wardFilter = id; paint(root); } });
}

/**
 * Доска коек целиком: палаты карточками, койки плитками.
 *
 * `mode: 'pick'` — тот же вид, но плитка становится ВЫБОРОМ: свободная койка
 * нажимается и отмечается, занятая / на уборке / в ремонте видна, названа
 * причиной и не нажимается. Прятать такую койку нельзя: медсестра ищет глазами
 * конкретное место, и не найдя его вовсе, решает, что экран сломан.
 *
 * @param {{wards:Array, beds:Array, currentByBed:Map, opRooms:Array}} data
 * @param {{mode?:'board'|'pick', wardFilter?:any, statusFilter?:string,
 *          selectedBedId?:any, onBed?:Function, showOpRooms?:boolean,
 *          emptyText?:string}} opts
 */
export function bedBoardEl(data, {
    mode = 'board', wardFilter = 'all', statusFilter = 'all',
    selectedBedId = null, onBed = null, showOpRooms = false, emptyText = null,
} = {}) {
    const grid = h('div', { style: { display: 'grid', gap: '16px' } });
    const wards = String(wardFilter) === 'all' ? data.wards : data.wards.filter(w => String(w.id) === String(wardFilter));
    let shownBeds = 0;
    for (const w of wards) {
        const wardBeds = data.beds.filter(b => b.ward_id === w.id
            && (statusFilter === 'all' || bedStatus(b, data.currentByBed) === statusFilter));
        if (!wardBeds.length) continue;
        shownBeds += wardBeds.length;
        grid.appendChild(wardCardEl(w, wardBeds, data, { mode, selectedBedId, onBed }));
    }
    // STATIONARY_ROOMS_V1 — операционные идут ПОСЛЕ палат: это не койки, и
    // подниматься выше коечного фонда им незачем. Фильтр по статусу к ним не
    // применяется — у кабинета нет статуса койки, и прятать его за «Свободно»
    // значило бы терять его без объяснения. В окне выбора койки их нет вовсе:
    // положить пациента в операционную нельзя.
    if (showOpRooms && data.opRooms.length && statusFilter === 'all') grid.appendChild(opRoomsCard(data));

    if (!shownBeds) grid.appendChild(h('div', { class: 'card', style: { padding: '20px' } },
        h('div', { class: 'empty' }, emptyText || tr('Койки не найдены. Заведите палаты и койки в «Настройки → Помещения».'))));
    return grid;
}

function wardCardEl(ward, beds, data, opts = {}) {
    const tiles = h('div', { class: 'wb-tiles' });
    for (const bed of beds) tiles.appendChild(bedTileEl(bed, ward, data, opts));

    // WARD_BOARD_V2 — «6 beds» не отвечало на вопрос, ради которого на эту
    // доску и смотрят: сколько мест ещё есть. Считаем по ВСЕМ койкам палаты, а
    // не по отфильтрованным, иначе полоса врала бы при включённом фильтре.
    const all = data.beds.filter(b => b.ward_id === ward.id);
    const busy = all.filter(b => bedStatus(b, data.currentByBed) === 'occupied').length;
    const pct = all.length ? Math.round(busy / all.length * 100) : 0;
    const rate = ward.billing_mode === 'hourly'
        ? trf('{price} / час', { price: fmtPrice(ward.price_per_hour) })
        : trf('{price} / сут', { price: fmtPrice(ward.price_per_day) });

    return h('div', { class: 'card wb-ward' },
        h('div', { class: 'wb-ward__head' },
            h('div', { class: 'wb-ward__id' },
                ward.color ? h('span', { class: 'wb-ward__dot', style: { background: ward.color } }) : null,
                h('h3', { class: 'wb-ward__name' }, ward.name),
                h('span', { class: 'muted wb-ward__meta' },
                    tr(WARD_TYPE_LABEL[ward.type] || ward.type || 'Общая') + ' · ' + rate)),
            h('div', { class: 'wb-ward__occ' },
                h('span', { class: 'muted wb-ward__occlb' }, trf('занято {busy} из {all}', { busy, all: all.length })),
                h('span', { class: 'wb-bar' }, h('span', { class: 'wb-bar__fill', style: { width: pct + '%' } })))),
        tiles,
    );
}

function bedTileEl(bed, ward, data, { mode = 'board', selectedBedId = null, onBed = null } = {}) {
    const st = bedStatus(bed, data.currentByBed);
    const style = STATUS[st] || STATUS.free;
    const adm = data.currentByBed.get(bed.id);
    // В режиме выбора нажимается ТОЛЬКО свободная койка. Остальные видны,
    // подписаны причиной (Занята / Уборка / Ремонт) и отключены — те же три
    // отказа, которыми ответит сервер (rpc/inpatient.js, admissionAdmit).
    const pickable = mode !== 'pick' || st === 'free';
    const chosen = mode === 'pick' && selectedBedId != null && String(selectedBedId) === String(bed.id);
    // Плитка — КНОПКА, а не div с обработчиком: по ней щёлкают, значит до неё
    // надо доходить с клавиатуры и объявлять её нажимаемой.
    const tile = h('button', {
        type: 'button',
        disabled: !pickable,
        'aria-pressed': mode === 'pick' ? (chosen ? 'true' : 'false') : null,
        title: pickable ? null : tr(style.label),
        style: {
            border: chosen ? '2px solid var(--primary-600, #1f7a72)' : '1px solid ' + style.bd,
            background: style.bg, borderRadius: '10px', padding: chosen ? '9px' : '10px',
            cursor: pickable ? 'pointer' : 'not-allowed', opacity: pickable ? '1' : '0.62',
            minHeight: '84px', display: 'flex', flexDirection: 'column', gap: '4px',
            font: 'inherit', textAlign: 'left', width: '100%',
        },
        onclick: () => { if (pickable && onBed) onBed(bed, ward, adm, st); },
    },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
            h('strong', { style: { fontSize: '13.5px' } }, bed.code),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12.5px', fontWeight: '700', color: style.fg } },
                h('span', { class: 'wb-dot', style: { background: style.dot } }),
                tr(style.label)),
        ),
    );
    if (adm) {
        const p = adm.patients || {};
        tile.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', marginTop: '2px' } },
            h('span', { style: { width: '22px', height: '22px', borderRadius: '50%', background: 'var(--primary-600, #1f7a72)', color: '#fff', fontSize: '12.5px', fontWeight: 700, display: 'grid', placeItems: 'center', flex: '0 0 22px' } }, initials(p.full_name || '?')),
            h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, p.full_name || '—'),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, (p.mrn ? p.mrn + ' · ' : '') + lengthOfStay(adm.admitted_at)),
            ),
        ));
        if (adm.users && adm.users.full_name) tile.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '4px' } }, Icon('Stethoscope', { size: 11 }), adm.users.full_name));
    } else {
        // Здесь стояло «Госпитализация — в разделе "Стационар"» — указатель на
        // другой пункт меню. Пункта больше нет: заявки стали соседней вкладкой
        // этого же раздела, и указывать некуда. Осталось то, что о койке
        // действительно надо знать перед выбором, — её тип.
        tile.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: 'auto' } },
            bed.type && bed.type !== 'standard' ? tr(BED_TYPE_LABEL[bed.type] || bed.type) : '—'));
    }
    return tile;
}

function onBedClick(bed, ward, adm, root) {
    const st = adm ? 'occupied' : bed.status;
    if (adm) return bedDetailModal(bed, ward, adm, root);
    // Свободная койка ведёт в то же окно состояния койки, что уборка и ремонт:
    // госпитализация оформляется в разделе «Стационар» (см. блок ниже).
    return housekeepingModal(bed, ward, root);   // free / cleaning / maintenance
}

// ---------------------------------------------------------------------------
// ЗДЕСЬ БЫЛА КНОПКА «ГОСПИТАЛИЗИРОВАТЬ» — И ЕЁ УБРАЛИ НАМЕРЕННО
// ---------------------------------------------------------------------------
//
// Свободная койка открывала окно `admitModal`, а оно звало `admit_patient`:
// один запрос писал status='active' с пустым первичным осмотром и пустым
// лечащим врачом. Весь маршрут владельца — заявка → медсестра кладёт →
// первичный осмотр главного врача → назначение лечащего — обходился одним
// нажатием, а миграция 092 выдала эту доску медсестре, старшей медсестре,
// главному врачу и РЕГИСТРАТУРЕ. Хуже того, получившаяся госпитализация не
// лечилась: без attending_doctor_id назначения отвечали 403 «Назначения ведёт
// лечащий врач этого пациента» — в том числе тому самому врачу, который
// пациента и ведёт.
//
// Поступление живёт теперь в разделе «Стационар»: регистратура оформляет
// заявку, медсестра размещает на койке, главный врач осматривает и назначает
// лечащего врача. Каждый шаг подписан и проверен сервером
// (rpc/inpatient-flow.js), и ни один не пропускается.
//
// ДОСКА КОЕК ОСТАЁТСЯ ПРИ СВОЁМ ДЕЛЕ, а не превращается в витрину: занятость,
// статус койки (уборка / ремонт / свободна), услуги и товары пациента, счёт,
// проживание, перевод, журнал движений. По свободной койке щёлкают, чтобы
// поменять её СОСТОЯНИЕ, — это то, ради чего доска и нужна.
//
// Сервер закрыт отдельно: /api/rpc открыт curl'ом с любого компьютера клиники,
// поэтому `admit_patient` отказывает сам (rpc/inpatient.js — он выполняет
// только заявку, оформленную ДО этого обновления, и новых госпитализаций не
// заводит). Спрятанная кнопка — не защита.

// ---------------------------------------------------------------------------
// Bed detail + discharge
// ---------------------------------------------------------------------------
function bedDetailModal(bed, ward, adm, root) {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const st = { lines: [], transfers: [], selected: new Set(), catalog: [], products: [] };
    const p = adm.patients || {};
    const me = () => (window.easymed && window.easymed.state && window.easymed.state.user) || {};

    const rightEl = h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '14px' } });
    const leftEl = h('div', { style: { flex: '0 0 340px', display: 'flex', flexDirection: 'column', gap: '14px' } });

    async function reloadAll() {
        const [ls, ts] = await Promise.all([
            supabase.from('admission_services')
                // ACCOMMODATION_AS_SERVICE_V1 — notes несёт метку строки проживания;
                // без неё строку не отличить от услуги, удалённой из каталога.
                .select('id, service_id, clinic_item_id, quantity, unit_price, total, status, invoice_item_id, billable, notes, performed_at, created_at, services(name), products(name, unit)')
                .eq('admission_id', adm.id).order('id', { ascending: false }),
            supabase.from('admission_transfers')
                .select('*').eq('admission_id', adm.id).order('id', { ascending: true }),
        ]);
        st.lines = ls.data || [];
        st.transfers = ts.data || [];
        for (const id of [...st.selected]) if (!st.lines.some(l => l.id === id && !l.invoice_item_id)) st.selected.delete(id);
        paintLeft(); paintRight();
    }

    // ---------------- LEFT: пациент + госпитализация + ACCOMMODATION ----------------
    function paintLeft() {
        clear(leftEl);
        leftEl.appendChild(h('div', { class: 'card', style: { padding: '16px' } },
            h('div', { class: 'row', style: { gap: '10px' } },
                h('span', { style: { width: '40px', height: '40px', borderRadius: '999px', background: 'var(--primary-600)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700 } }, initials(p.full_name || '?')),
                h('div', { style: { minWidth: 0 } },
                    h('div', { style: { fontWeight: 700, fontSize: '15px' } }, p.full_name || '—'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, [p.mrn, adm.chief_complaint].filter(Boolean).join(' · ')))),
            h('div', { style: { borderTop: '1px solid var(--ink-100)', margin: '12px 0' } }),
            kvRow('Admission #', adm.admission_no || ('#' + adm.id)),
            kvRow('Pathway', adm.pathway === 'surgical' ? 'Surgical' : 'Therapy'),
            kvRow('Attending', (adm.users && adm.users.full_name) || '—'),
            // ADMISSION_DATE_EDIT_V1 — дату поступления правят прямо здесь: из неё
            // считаются койко-дни, а значит и счёт за проживание, и опечатка во
            // времени поступления стоит клинике суток.
            admittedRow(adm, reloadAll),
            kvRow('Койка', (ward ? ward.name + ' · ' : '') + (bed.code || bed.id)),
        ));

        const est = estimateCharge(ward, bed, adm.admitted_at, Number(discInp.value) || 0);
        leftEl.appendChild(h('div', { class: 'card', style: { padding: '16px', background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)' } },
            h('div', { style: { fontSize: '12.5px', fontWeight: 800, letterSpacing: '.06em', color: 'var(--primary-700)', marginBottom: '8px' } }, 'ACCOMMODATION'),
            kvRow('Дата поступления', fmtDateTime(adm.admitted_at)),
            kvRow('Длительность', lengthOfStay(adm.admitted_at)),
            kvRow('Ставка', fmtPrice(est.rate) + ' / ' + (est.unitLabel === 'day' ? tr('день') : tr('час'))),
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', margin: '8px 0' } },
                h('span', { class: 'muted', style: { flex: 1, fontSize: '12.5px' } }, 'Discount %'), discInp, saveDiscBtn),
            h('div', { style: { borderTop: '1px dashed var(--primary-100, #d7efe9)', margin: '8px 0' } }),
            // ACCOMMODATION_DAILY_V1 — «к оплате» это ОСТАТОК: сутки, за которые
            // ещё не выставляли счёт. Числа берём у сервера (accommodation_state),
            // а не из локального estimateCharge: тот считает весь срок и про уже
            // оплаченные дни не знает — экран обещал бы одно, а счёт нёс другое.
            // Пока состояние не пришло, показываем локальный расчёт: до первого
            // счёта он совпадает с остатком.
            accommodationDueRows(adm, est),
            // ACCOMMODATION_AS_SERVICE_V1 — проживание попадает в счёт ТОЛЬКО по
            // этой кнопке. Клиника, которая за койку не берёт, просто её не
            // нажимает; выписка сама ничего больше не выставляет.
            accommodationBox(adm, est, reloadAll),
        ));
    }
    function kvRow(k, v) {
        return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '3px 0', fontSize: '12.5px' } },
            h('span', { class: 'muted' }, k), h('span', { style: { fontWeight: 600, textAlign: 'right' } }, v || '—'));
    }
    const discInp = h('input', { type: 'number', min: '0', max: '100', step: '1',
        value: String(adm.accommodation_discount_percent || 0), style: { width: '76px', height: '34px', padding: '0 10px', textAlign: 'right', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '13.5px', outline: 'none' } });
    discInp.addEventListener('input', () => paintLeft());
    const saveDiscBtn = h('button', {
        class: 'btn btn-sm', type: 'button',
        onclick: async () => {
            const { error } = await supabase.rpc('set_admission_discount', { admission_id: adm.id, percent: Number(discInp.value) || 0 });
            if (error) { toast(error.message, 'fail'); return; }
            adm.accommodation_discount_percent = Number(discInp.value) || 0;
            toast('Скидка сохранена.', 'ok');
        },
    }, 'Сохранить');

    // ---------------- RIGHT ----------------
    function unbilledSelectedTotal() {
        return st.lines.filter(l => st.selected.has(l.id) && !l.invoice_item_id)
            .reduce((s, l) => s + Number(l.total || 0), 0);
    }
    function paintRight() {
        clear(rightEl);
        const selCount = [...st.selected].length;
        // -- панель действий --
        rightEl.appendChild(h('div', { class: 'card', style: { padding: '12px 16px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { class: 'btn', style: { background: 'var(--warn-500, #e8a23d)', borderColor: 'var(--warn-500, #e8a23d)', color: '#fff', fontWeight: 700 },
                onclick: () => transferDialog() }, '→ Перевести'),
            h('button', { class: 'btn btn-primary', disabled: !selCount,
                onclick: () => generateInvoice() }, Icon('Plus', { size: 14 }), ' Сформировать счёт', selCount ? ' (' + selCount + ')' : ''),
            // ЗДЕСЬ БЫЛА КНОПКА «ВЫПИСАТЬ» — см. блок «Выписка ушла отсюда» ниже.
            h('span', { class: 'muted', style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' } },
                Icon('Help', { size: 13 }), tr('Выписку оформляют в карте госпитализации')),
            h('span', { class: 'grow' }),
            h('span', { style: { fontSize: '13.5px', fontWeight: 700 } }, 'К ОПЛАТЕ ', h('span', { class: 'num', style: { fontSize: '15px' } }, fmtPrice(unbilledSelectedTotal()) + ' UZS')),
        ));
        // -- назначения врача --
        rightEl.appendChild(h('div', { class: 'card', style: { padding: '14px 16px' } },
            secTitle('Назначения врача'),
            h('div', { class: 'muted', style: { border: '1px dashed var(--ink-200)', borderRadius: '10px', padding: '14px', textAlign: 'center', fontSize: '12.5px' } },
                'Назначений нет — врач добавляет их в своём кабинете (вкладка «Стационар»).')));
        // -- услуги --
        // ACCOMMODATION_AS_SERVICE_V1 — у проживания нет ни service_id, ни
        // clinic_item_id, поэтому оно проваливалось между двумя списками и не
        // показывалось НИГДЕ — при этом продолжало попадать в счёт. Строка,
        // которую нельзя увидеть, но можно выставить, — худший вариант.
        const svcLines = st.lines.filter(isServiceLine);
        rightEl.appendChild(sectionCard('Услуги (services performed)', 'Добавить услугу', () => addServiceDialog(), svcLines, false));
        // -- товары --
        const itemLines = st.lines.filter(isGoodsLine);
        rightEl.appendChild(sectionCard('Товары (расходные материалы)', 'Добавить товары', () => addItemsDialog(), itemLines, true));
        // -- журнал --
        const j = h('div', null);
        for (const t of st.transfers) {
            const to = bedNameById(t.to_bed_id);
            j.appendChild(h('div', { class: 'row', style: { gap: '8px', padding: '7px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '12.5px' } },
                // ADMISSION_DATE_EDIT_V1 — правка даты это НЕ перевод: койка не
                // менялась, и строка «Перевод 201·1 → 201·1» только сбивала бы.
                h('span', { style: { color: t.kind === 'admitted_at' ? 'var(--warn-600, #d97706)' : 'var(--ok-600)', fontWeight: 800 } },
                    t.kind === 'admit' ? '+' : t.kind === 'admitted_at' ? '✎' : '→'),
                h('span', { style: { flex: 1 } },
                    t.kind === 'admit' ? h('span', null, h('b', null, 'Поступил'), ' (new) → ' + to)
                        : t.kind === 'admitted_at' ? h('span', null, h('b', null, 'Изменена дата поступления'), t.reason ? ' · ' + t.reason : '')
                        : h('span', null, h('b', null, 'Перевод'), ' ' + bedNameById(t.from_bed_id) + ' → ' + to + (t.reason ? ' · ' + t.reason : ''))),
                h('span', { class: 'muted num' }, fmtDateTime(t.transferred_at || t.created_at))));
        }
        rightEl.appendChild(h('div', { class: 'card', style: { padding: '14px 16px' } },
            secTitle('Журнал движения пациента'),
            st.transfers.length ? j : h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Записей нет.')));
    }
    const secTitle = (t) => h('div', { style: { fontSize: '12.5px', fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--ink-700)', marginBottom: '10px' } }, t);
    function bedNameById(id) {
        if (id == null) return '—';
        const b = (bedsCache || []).find(x => x.id === id);
        return b ? ((b.wards && b.wards.name ? b.wards.name + ' · ' : '') + b.code) : trf('Койка #{id}', { id });
    }
    let bedsCache = null;
    supabase.from('beds').select('id, code, ward_id, status, active, wards(name)').then(({ data }) => { bedsCache = data || []; paintRight(); });

    function sectionCard(title, addLabel, onAdd, lines, withChecks) {
        const card = h('div', { class: 'card', style: { padding: '14px 16px' } });
        card.appendChild(h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } },
            secTitle(title), h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: onAdd }, Icon('Plus', { size: 13 }), ' ' + addLabel)));
        if (!lines.length) {
            card.appendChild(h('div', { class: 'muted', style: { border: '1px dashed var(--ink-200)', borderRadius: '10px', padding: '14px', textAlign: 'center', fontSize: '12.5px' } },
                withChecks ? 'Товаров пока нет — выдайте препараты кнопкой «Добавить товары».' : 'Услуг пока нет — добавьте выполненную услугу.'));
            return card;
        }
        const tbody = h('tbody');
        for (const l of lines) {
            const billed = !!l.invoice_item_id;
            const expenseOnly = !billed && !l.billable;   // «в учёте расходов» — не биллуется, пока не переключат
            const chk = (!billed && !expenseOnly) ? h('input', { type: 'checkbox', checked: st.selected.has(l.id) }) : null;
            if (chk) chk.addEventListener('change', () => { chk.checked ? st.selected.add(l.id) : st.selected.delete(l.id); paintRight(); });
            const name = isAccommodationLine(l)
                ? ACCOMMODATION_LABEL   // переводится через tr() в h(), как и всё остальное
                : ((l.services && l.services.name) || (l.products && l.products.name) || '—');
            const unit = l.products && l.products.unit ? l.products.unit : '';
            tbody.appendChild(h('tr', null,
                h('td', { style: { width: '30px' } }, billed ? null : chk),
                h('td', null, h('span', { style: { fontWeight: 600 } }, name), unit ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' ' + unit) : null),
                h('td', { class: 'num' }, String(l.quantity)),
                h('td', { class: 'num' }, fmtPrice(l.unit_price)),
                h('td', { class: 'num', style: { fontWeight: 700 } }, fmtPrice(l.total)),
                h('td', { class: 'num', style: { fontSize: '12.5px' } }, fmtDateTime(l.performed_at || l.created_at)),
                h('td', null, billed ? h('span', { class: 'row', style: { gap: '6px' } }, Tag('Invoiced', { kind: 'ok', dot: true }),
                        h('button', { class: 'btn btn-sm', type: 'button', title: 'Убрать строку из неоплаченного счёта',
                            onclick: async () => {
                                if (!confirm(trf('Убрать «{name}» из счёта? Счёт будет пересчитан (пустой — удалён).', { name }))) return;
                                const { data: rr, error } = await supabase.rpc('remove_admission_line_from_invoice', { line_id: l.id });
                                if (error) { toast(error.message, 'fail'); return; }
                                toast(rr && rr.invoice_deleted ? 'Строка убрана, пустой счёт удалён.' : 'Строка убрана из счёта.');
                                await reloadAll();
                            } }, 'Из счёта'))
                    : expenseOnly ? h('span', { class: 'row', style: { gap: '6px' } }, Tag('В учёте', { kind: '', dot: true }),
                        h('button', { class: 'btn btn-sm', type: 'button', title: 'Выставить в счёт пациенту',
                            onclick: async () => { const { error } = await supabase.from('admission_services').update({ billable: 1 }).eq('id', l.id); if (error) { toast(error.message, 'fail'); return; } toast('Строка пойдёт в счёт.'); await reloadAll(); } }, 'В счёт'))
                    : h('span', { class: 'row', style: { gap: '6px' } }, Tag('Unbilled', { kind: 'warn', dot: true }),
                        h('button', { class: 'btn btn-sm', type: 'button', title: 'Перевести в учёт расходов (не биллуется)',
                            onclick: async () => { const { error } = await supabase.from('admission_services').update({ billable: 0 }).eq('id', l.id); if (error) { toast(error.message, 'fail'); return; } st.selected.delete(l.id); toast('Строка переведена в учёт.'); await reloadAll(); } }, 'В учёт'))),
                h('td', { style: { textAlign: 'right' } }, billed ? null : h('button', {
                    class: 'btn btn-ghost btn-sm', type: 'button', title: 'Убрать', style: { color: 'var(--crit-600, #dc2626)' },
                    onclick: async () => {
                        if (!confirm(trf('Убрать строку «{name}»?', { name }))) return;
                        const { error } = l.clinic_item_id != null
                            ? await supabase.rpc('void_dispensed_admission_item', { p_line: l.id })
                            : await supabase.from('admission_services').delete().eq('id', l.id);
                        if (error) { toast(error.message, 'fail'); return; }
                        toast('Строка убрана.'); await reloadAll();
                    },
                }, Icon('Trash', { size: 13 }))),
            ));
        }
        const total = lines.reduce((s, l) => s + Number(l.total || 0), 0);
        card.appendChild(h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'tbl' },
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, withChecks ? 'Товар' : 'Услуга'),
                h('th', { style: { textAlign: 'right' } }, 'Кол-во'), h('th', { style: { textAlign: 'right' } }, 'Цена'),
                h('th', { style: { textAlign: 'right' } }, 'Сумма'), h('th', null, 'Когда'), h('th', null, 'Статус'), h('th', null, ''))),
            tbody)));
        card.appendChild(h('div', { style: { textAlign: 'right', fontSize: '12.5px', fontWeight: 800, marginTop: '8px' } },
            (withChecks ? 'ТОВАРЫ ИТОГО ' : 'УСЛУГИ ИТОГО ') + fmtPrice(total) + ' UZS'));
        return card;
    }

    // -- добавить услугу --
    // SVC_DIALOG_EASYMED_V1 — поиск + несколько строк + Итого (как «Товары для пациента»).
    function addServiceDialog() {
        const picked = [];   // [{ s, qty }]
        let servicesAll = [];
        const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
        const totalEl = h('span', { style: { fontWeight: 800 } }, '0');
        const refreshTotal = () => {
            totalEl.textContent = fmtPrice(picked.reduce((s2, x) => s2 + (Number(x.qty) || 0) * Number(x.s.price || 0), 0));
        };
        function paintPicked() {
            clear(listEl);
            if (!picked.length) {
                listEl.appendChild(h('div', { class: 'muted', style: { textAlign: 'center', fontSize: '12.5px', padding: '6px' } },
                    'Найдите услугу в поиске выше — можно добавить несколько.'));
                refreshTotal(); return;
            }
            for (const x of picked) {
                const qtyInp = h('input', { type: 'number', min: '1', step: '1', value: String(x.qty),
                    style: { width: '76px', height: '34px', padding: '0 10px', textAlign: 'right', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '13.5px', outline: 'none' } });
                qtyInp.addEventListener('input', () => { x.qty = qtyInp.value === '' ? 0 : Number(qtyInp.value); refreshTotal(); });
                listEl.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', padding: '9px 12px', border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'var(--ink-25, #f8fafa)' } },
                    h('span', { style: { flex: 1, minWidth: 0, fontWeight: 600, fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        x.s.name, h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '12.5px' } }, ' · ' + fmtPrice(x.s.price), ' сум')),
                    qtyInp,
                    h('button', { type: 'button', title: 'Убрать', style: { width: '28px', height: '28px', borderRadius: '999px', border: '1px solid var(--ink-150, var(--ink-200))', background: 'var(--white, #fff)', cursor: 'pointer', color: 'var(--ink-500)', fontWeight: 700, lineHeight: 1, flex: '0 0 auto' }, onmouseenter: (e) => { e.currentTarget.style.background = 'var(--crit-50, #fdecec)'; e.currentTarget.style.color = 'var(--crit-600, #dc2626)'; e.currentTarget.style.borderColor = 'var(--crit-200, #f5c2c2)'; }, onmouseleave: (e) => { e.currentTarget.style.background = 'var(--white, #fff)'; e.currentTarget.style.color = 'var(--ink-500)'; e.currentTarget.style.borderColor = 'var(--ink-150, var(--ink-200))'; },
                        onclick: () => { picked.splice(picked.indexOf(x), 1); paintPicked(); paintCatalog(); } }, '×')));
            }
            refreshTotal();
        }
        const svcSearch = h('input', {
            type: 'text', placeholder: 'Поиск услуги…',
            style: { width: '100%', height: '40px', boxSizing: 'border-box', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13.5px', outline: 'none' },
        });
        svcSearch.addEventListener('input', () => { filt.q = svcSearch.value; paintChips(); paintCatalog(); });

        // SERVICE_CATALOG_FILTER_V1 — каталог с разделами и отбором по врачу.
        //
        // Было: одна строка поиска и выпадающий список на 10 позиций. По каталогу
        // в 542 услуги так можно только искать точное название — просмотреть
        // «что вообще есть в процедурах» было нельзя. Теперь список постоянный,
        // сверху чипы разделов со счётчиками (те же, что в мастере записи —
        // правила общие, см. shared/service-categories.js), и отдельный выбор
        // врача: он сужает каталог до услуг из его ставок, чтобы услугу не
        // записали на врача, который её не делает.
        const filt = { q: '', cat: '', doctorId: '' };
        let doctorsAll = [];

        const chipsEl = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' } });
        const docSel = h('select', { title: 'Показать только услуги выбранного врача' },
            h('option', { value: '' }, 'Все врачи'));
        docSel.addEventListener('change', () => { filt.doctorId = docSel.value; paintChips(); paintCatalog(); });
        // SEARCHABLE_SELECT_V1 — врачей под два десятка, и обычный <select>
        // раскрывался стеной имён поверх окна. Тот же компонент, что и в форме
        // поступления: настоящий docSel остаётся источником правды, его change
        // по-прежнему слушается выше, а варианты читаются лениво — врачи
        // догружаются асинхронно и на момент создания списка ещё пусты.
        // Жёлтый фон — признак СУЖАЮЩЕГО фильтра: пока он выбран, каталог
        // показывает не все услуги, и это должно бросаться в глаза, иначе
        // «услуга пропала» читается как поломка каталога.
        const docPick = searchableSelect(docSel, { placeholder: 'Все врачи — введите фамилию…', background: '#fffbe6' });

        const catalogEl = h('div', { style: { border: '1px solid var(--ink-100)', borderRadius: '12px', maxHeight: '300px', overflow: 'auto' } });

        const currentDoctor = () => (filt.doctorId ? doctorsAll.find(d => String(d.id) === String(filt.doctorId)) : null) || null;

        function paintChips() {
            clear(chipsEl);
            const counts = categoryCounts(servicesAll, { query: filt.q, doctor: currentDoctor() });
            const chip = (label, value, n) => {
                const on = filt.cat === value;
                const b = h('button', {
                    type: 'button',
                    style: {
                        padding: '5px 12px', borderRadius: '999px', cursor: 'pointer', fontFamily: 'inherit',
                        fontSize: '12.5px', fontWeight: on ? 700 : 500,
                        border: '1px solid ' + (on ? 'var(--primary-400, #4fb3a0)' : 'var(--ink-200)'),
                        background: on ? 'var(--primary-50, #f2faf8)' : 'var(--white, #fff)',
                        color: on ? 'var(--primary-700)' : 'var(--ink-700)',
                    },
                    onclick: () => { filt.cat = on ? '' : value; paintChips(); paintCatalog(); },
                }, label + ' · ' + n);
                return b;
            };
            chipsEl.appendChild(chip('Все', '', counts['']));
            for (const c of CAT_ORDER) if (counts[c]) chipsEl.appendChild(chip(c, c, counts[c]));
        }

        function paintCatalog() {
            clear(catalogEl);
            const pool = filterCatalog(servicesAll, { query: filt.q, category: filt.cat, doctor: currentDoctor() });
            if (!pool.length) {
                // Три разных причины пустоты — три разных подсказки: каталог не
                // загрузился, врач ничего такого не делает, или поиск ничего не нашёл.
                const why = !servicesAll.length ? 'Каталог услуг не загрузился.'
                    : currentDoctor() ? 'У этого врача нет услуг в «Услуги и ставки».'
                    : 'Ничего не найдено — измените поиск или раздел.';
                catalogEl.appendChild(h('div', { class: 'muted', style: { padding: '18px', textAlign: 'center', fontSize: '12.5px' } }, why));
                return;
            }
            for (const s2 of pool.slice(0, 200)) {
                const already = picked.some(x => x.s.id === s2.id);
                catalogEl.appendChild(h('div', {
                    style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '9px 12px', borderBottom: '1px solid var(--ink-50)', cursor: already ? 'default' : 'pointer', opacity: already ? '.55' : '1' },
                    onmouseenter: (e) => { if (!already) e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                    onclick: () => { if (already) return; picked.push({ s: s2, qty: 1 }); paintPicked(); paintCatalog(); },
                },
                    h('span', { style: { flex: 1, minWidth: 0, fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        s2.name,
                        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, ' · ' + categoryOf(s2))),
                    h('span', { class: 'num', style: { fontSize: '12.5px', fontWeight: 700, whiteSpace: 'nowrap' } }, fmtPrice(s2.price), ' сум'),
                    h('span', { style: { fontSize: '15px', fontWeight: 800, color: already ? 'var(--ink-300)' : 'var(--primary-600)', width: '16px', textAlign: 'center' } }, already ? '✓' : '+')));
            }
            if (pool.length > 200) {
                catalogEl.appendChild(h('div', { class: 'muted', style: { padding: '10px', textAlign: 'center', fontSize: '12.5px' } },
                    trf('Показаны первые 200 из {n} — уточните поиск.', { n: pool.length })));
            }
        }

        // Каталог и врачи грузятся параллельно; список услуг рисуем сразу, как
        // он пришёл, — ждать врачей незачем, фильтр по врачу просто появится.
        supabase.from('services').select('id, name, price, is_lab, type').eq('active', 1).order('name').limit(2000)
            .then(({ data }) => { servicesAll = data || []; paintChips(); paintCatalog(); });
        supabase.from('users').select('id, full_name, service_rates').eq('role', 'doctor').eq('is_active', 1).order('full_name')
            .then(({ data }) => {
                doctorsAll = data || [];
                for (const d of doctorsAll) docSel.appendChild(h('option', { value: String(d.id) }, d.full_name));
            });

        modalWide('Услуги для пациента', 'Plus',
            [
                // SERVICE_CATALOG_FILTER_V1 — строка отбора: поиск и врач рядом,
                // одинаковой высоты и с подписями. Раньше это были голые поля
                // разной высоты, и что делает выпадающий список, было неясно.
                h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 280px)', gap: '10px', alignItems: 'end' } },
                    h('div', { style: { minWidth: 0 } },
                        h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '4px' } }, 'Поиск услуги'),
                        svcSearch),
                    h('div', { style: { minWidth: 0 } },
                        h('div', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '4px' } }, 'Врач'),
                        docPick)),
                chipsEl,
                catalogEl,
                listEl,
                h('div', { class: 'row', style: { justifyContent: 'flex-end', alignItems: 'baseline', gap: '7px', padding: '10px 14px', background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)', borderRadius: '10px' } }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Итого:'), h('span', { style: { fontSize: '17px', fontWeight: 800, color: 'var(--primary-700)' } }, totalEl), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'UZS')),
            ],
            '+ Добавить',
            async () => {
                const lines = picked.filter(x => Number(x.qty) > 0);
                if (!lines.length) { toast('Добавьте хотя бы одну услугу.', 'fail'); return false; }
                let ok = 0; const fails = [];
                for (const x of lines) {
                    const qty = Math.max(1, Math.round(Number(x.qty)));
                    const price = Number(x.s.price) || 0;
                    const { error } = await supabase.from('admission_services').insert({
                        // ЛЕЧАЩИЙ, А НЕ НАПРАВИВШИЙ. `adm.doctor_id` — врач, который
                        // ПРИСЛАЛ пациента в стационар; работу в отделении ведёт
                        // лечащий (attending_doctor_id, миграция 091), и выработка
                        // за услугу должна доставаться ему. Пока здесь стоял
                        // doctor_id, каждая услуга и каждая выдача записывались на
                        // направившего — вместе с деньгами за чужую работу.
                        admission_id: adm.id, service_id: x.s.id,
                        doctor_id: adm.attending_doctor_id || adm.doctor_id || null,
                        bed_id: adm.bed_id, ward_id: adm.ward_id,
                        quantity: qty, unit_price: price, total: price * qty, status: 'added', billable: 1,
                    });
                    if (error) fails.push(x.s.name + ': ' + error.message); else ok++;
                }
                if (fails.length) toast(trf('Добавлено: {n}. Ошибки — {fails}', { n: ok, fails: fails.join('; ') }), 'fail');
                else toast(trf('Добавлено услуг: {n}.', { n: ok }), 'ok');
                await reloadAll();
                return fails.length === 0;
            });
    }

    // -- добавить товары (выдача) --
    // ITEMS_EASYMED_V1 — «Товары для пациента» как в easymed: поиск сверху,
    // несколько строк, Итого, Примечание и чекбокс «Выставить в счёт пациенту»
    // (по умолчанию — только в учёт расходов, billable=0).
    function addItemsDialog() {
        const picked = [];   // [{ p, qty }]
        let productsAll = [];
        const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
        const totalEl = h('span', { style: { fontWeight: 800 } }, '0');
        const refreshTotal = () => {
            totalEl.textContent = fmtPrice(picked.reduce((s2, x) => s2 + (Number(x.qty) || 0) * Number(x.p.sale_price || 0), 0));
        };
        function paintPicked() {
            clear(listEl);
            if (!picked.length) {
                listEl.appendChild(h('div', { class: 'muted', style: { textAlign: 'center', fontSize: '12.5px', padding: '6px' } },
                    'Найдите товар в поиске выше — можно добавить несколько.'));
                refreshTotal(); return;
            }
            for (const x of picked) {
                const qtyInp = h('input', { type: 'number', min: '0', step: 'any', value: String(x.qty),
                    style: { width: '76px', height: '34px', padding: '0 10px', textAlign: 'right', border: '1px solid var(--ink-200)', borderRadius: '9px', fontFamily: 'inherit', fontSize: '13.5px', outline: 'none' } });
                qtyInp.addEventListener('input', () => { x.qty = qtyInp.value === '' ? 0 : Number(qtyInp.value); refreshTotal(); });
                listEl.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', padding: '9px 12px', border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'var(--ink-25, #f8fafa)' } },
                    h('span', { style: { flex: 1, minWidth: 0, fontWeight: 600, fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        x.p.name, h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '12.5px' } }, ' ' + (x.p.base_unit || '') + ' · ' + fmtPrice(x.p.sale_price), ' сум')),
                    qtyInp,
                    h('button', { type: 'button', title: 'Убрать', style: { width: '28px', height: '28px', borderRadius: '999px', border: '1px solid var(--ink-150, var(--ink-200))', background: 'var(--white, #fff)', cursor: 'pointer', color: 'var(--ink-500)', fontWeight: 700, lineHeight: 1, flex: '0 0 auto' }, onmouseenter: (e) => { e.currentTarget.style.background = 'var(--crit-50, #fdecec)'; e.currentTarget.style.color = 'var(--crit-600, #dc2626)'; e.currentTarget.style.borderColor = 'var(--crit-200, #f5c2c2)'; }, onmouseleave: (e) => { e.currentTarget.style.background = 'var(--white, #fff)'; e.currentTarget.style.color = 'var(--ink-500)'; e.currentTarget.style.borderColor = 'var(--ink-150, var(--ink-200))'; },
                        onclick: () => { picked.splice(picked.indexOf(x), 1); paintPicked(); paintCatalog(); } }, '×')));
            }
            refreshTotal();
        }
        const prodSearch = h('input', {
            type: 'text', placeholder: 'Поиск товара — выберите, чтобы добавить в список…',
            style: { width: '100%', boxSizing: 'border-box', padding: '11px 12px', border: '1px solid var(--ink-200)', borderRadius: '10px', fontFamily: 'inherit', fontSize: '13.5px', outline: 'none' },
        });
        const prodResults = h('div', { style: { display: 'none', position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 40, maxHeight: '220px', overflow: 'auto', background: 'var(--white, #fff)', border: '1px solid var(--ink-200)', borderRadius: '10px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' } });
        function paintProdResults() {
            clear(prodResults);
            const q = prodSearch.value.trim().toLowerCase();
            const pool = productsAll.filter(p2 => !q || (p2.name || '').toLowerCase().includes(q)).slice(0, 10);
            if (!pool.length) { prodResults.style.display = q ? '' : 'none'; if (q) prodResults.appendChild(h('div', { class: 'muted', style: { padding: '9px 12px', fontSize: '12.5px' } }, 'Не найдено')); return; }
            prodResults.style.display = '';
            for (const p2 of pool) {
                // PRICE_AT_LINE_END_V1 — остаток на складе так же уходит вправо:
                // это тот же список, и две разные раскладки рядом читались бы хуже,
                // чем одна.
                prodResults.appendChild(h('div', {
                    style: { padding: '9px 12px', cursor: 'pointer', fontSize: '13.5px',
                             display: 'flex', alignItems: 'baseline', gap: '12px' },
                    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--ink-25, #f6f8f9)'; },
                    onmouseleave: (e) => { e.currentTarget.style.background = ''; },
                    onmousedown: (e) => { e.preventDefault(); picked.push({ p: p2, qty: 1 }); prodSearch.value = ''; prodResults.style.display = 'none'; paintPicked(); },
                },
                    h('span', { style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' } }, p2.name),
                    h('span', { class: 'muted', style: { flex: '0 0 auto', fontSize: '12.5px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } },
                        trf('остаток {n} {unit}', { n: p2.on_hand || 0, unit: p2.base_unit || '' }))));
            }
        }
        prodSearch.addEventListener('input', paintProdResults);
        prodSearch.addEventListener('focus', paintProdResults);
        prodSearch.addEventListener('blur', () => setTimeout(() => { prodResults.style.display = 'none'; }, 150));
        supabase.from('products').select('id, name, base_unit, on_hand, sale_price').eq('active', 1).order('name').limit(1000)
            .then(({ data }) => { productsAll = data || []; });

        const noteInp = h('input', { type: 'text', placeholder: 'Необязательно' });
        const billChk = h('input', { type: 'checkbox', style: { width: '17px', height: '17px', accentColor: 'var(--primary-600)' } });

        modalWide('Товары для пациента', 'Pill',
            [
                h('div', { style: { position: 'relative' } }, prodSearch, prodResults),
                listEl,
                h('div', { class: 'row', style: { justifyContent: 'flex-end', alignItems: 'baseline', gap: '7px', padding: '10px 14px', background: 'var(--primary-25, #f2faf8)', border: '1px solid var(--primary-100, #d7efe9)', borderRadius: '10px' } }, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Итого:'), h('span', { style: { fontSize: '17px', fontWeight: 800, color: 'var(--primary-700)' } }, totalEl), h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'UZS')),
                field('Примечание', noteInp),
                h('label', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px', background: 'var(--ink-25, #f8fafa)', border: '1px solid var(--ink-100)', borderRadius: '10px', cursor: 'pointer' } },
                    billChk,
                    h('span', { style: { minWidth: 0 } },
                        h('span', { style: { display: 'block', fontSize: '13.5px', fontWeight: 700 } }, 'Выставить в счёт пациенту'),
                        h('span', { class: 'muted', style: { display: 'block', fontSize: '12.5px', marginTop: '1px' } },
                            'По умолчанию товары идут только в учёт расходов. Отметьте, чтобы выставить их в счёт пациенту.'))),
            ],
            '+ Добавить',
            async () => {
                const lines = picked.filter(x => Number(x.qty) > 0);
                if (!lines.length) { toast('Добавьте хотя бы один товар.', 'fail'); return false; }
                let ok = 0; const fails = [];
                for (const x of lines) {
                    const { error } = await supabase.rpc('dispense_admission_item', {
                        p_admission_id: adm.id, p_item_id: x.p.id, p_qty: Number(x.qty),
                        p_doctor_id: adm.attending_doctor_id || adm.doctor_id || null,   // лечащий, а не направивший — см. «Услуги» выше
                        p_billable: billChk.checked, p_note: noteInp.value.trim() || null,
                    });
                    if (error) fails.push(x.p.name + ': ' + error.message); else ok++;
                }
                if (fails.length) toast(trf('Выдано: {n}. Ошибки — {fails}', { n: ok, fails: fails.join('; ') }), 'fail');
                else toast(billChk.checked ? trf('Выдано позиций: {n} — в счёт пациента.', { n: ok }) : trf('Выдано позиций: {n} — в учёт расходов.', { n: ok }), 'ok');
                await reloadAll();
                return fails.length === 0;
            });
    }

    // -- счёт по выбранным строкам --
    async function generateInvoice() {
        const ids = st.lines.filter(l => st.selected.has(l.id) && !l.invoice_item_id).map(l => l.id);
        if (!ids.length) { toast('Отметьте небиллованные строки.', 'fail'); return; }
        const { data, error } = await supabase.rpc('create_invoice_for_admission', { admission_id: adm.id, admission_service_ids: ids });
        if (error) { toast(error.message, 'fail'); return; }
        toast(trf('Счёт {num} выставлен — виден в кассе.', { num: (data.invoice && data.invoice.invoice_number) || '' }), 'ok');
        st.selected = new Set();
        await reloadAll();
    }

    // -- перевод --
    function transferDialog() {
        const bedSel = h('select', null, h('option', { value: '' }, 'Выберите свободную койку…'));
        for (const b of (bedsCache || []).filter(b => b.active && b.status === 'free' && b.id !== adm.bed_id)) {
            bedSel.appendChild(h('option', { value: String(b.id) }, (b.wards && b.wards.name ? b.wards.name + ' · ' : '') + b.code));
        }
        const reasonInp = h('input', { type: 'text', placeholder: 'Причина (необязательно)' });
        modal('Перевести пациента', 'ArrowRight',
            [field('Куда', bedSel, { required: true }), field('Причина', reasonInp)],
            'Перевести',
            async () => {
                if (!bedSel.value) { toast('Выберите койку.', 'fail'); return false; }
                const { error } = await supabase.rpc('transfer_admission', { admission_id: adm.id, to_bed_id: Number(bedSel.value), reason: reasonInp.value.trim() });
                if (error) { toast(error.message, 'fail'); return false; }
                toast('Пациент переведён.', 'ok');
                close(); await paint(root); return true;
            });
    }

    // ─── ВЫПИСКА УШЛА ОТСЮДА, И ЭТО ГЛАВНОЕ ИСПРАВЛЕНИЕ ЭТОГО ЭКРАНА ────────
    //
    // Здесь стояла кнопка «Выписать», и она звала `discharge_patient` — RPC
    // версии v0.8.0, который закрывает госпитализацию ОДНИМ движением: без
    // исхода («выписан домой» / «переведён» / «летальный исход»), без выписного
    // эпикриза, без рекомендаций и без подписи врача — из любого состояния «в
    // койке», включая пациента, которого главный врач ещё даже не осматривал.
    // Список ролей у этого RPC был шире некуда (кассир, регистратура), а
    // миграция 092 выдала саму доску коек ещё четырём ролям.
    //
    // В новом порядке выписка — ДВА ШАГА РАЗНЫХ ЛЮДЕЙ (TWO_STEP_DISCHARGE_V1):
    // лечащий врач подаёт заявку в карте госпитализации (исход, опубликованный
    // эпикриз, рекомендации), старшая медсестра оформляет её на экране «Выписки
    // к оформлению» (фактическое время, чек-лист, долг, койка в «уборку»).
    // Оставить рядом кнопку, которая делает то же самое, но без всего этого,
    // значило бы оставить открытой дверь, ради закрытия которой два шага и
    // придумали: отделение всегда выберет одно нажатие вместо двух.
    //
    // Сервер закрыт независимо от экрана: `discharge_patient` теперь отвечает
    // отказом всем госпитализациям, заведённым ПОСЛЕ обновления, и остаётся
    // только для тех, кто лежал в койке в день обновления (у них нет и не будет
    // эпикриза). См. isLegacyAdmission в rpc/inpatient.js.

    // ---------------- shell ----------------
    overlay.appendChild(h('div', { class: 'modal-card', style: { width: 'calc(100vw - 48px)', height: 'calc(100vh - 48px)', maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('div', null,
                h('h2', { style: { margin: 0 } }, 'Bed ' + (bed.code || bed.id)),
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, (ward ? ward.name : '') + (bed.type ? ' · ' + bed.type : ''))),
            h('div', { class: 'row', style: { gap: '10px' } },
                Tag('ЗАНЯТО', { kind: 'ok', dot: true }),
                h('button', { class: 'modal-close', onclick: close }, '×'))),
        h('div', { class: 'modal-body', style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', gap: '16px', alignItems: 'flex-start' } },
            leftEl, rightEl),
    ));
    document.body.appendChild(overlay);
    paintLeft(); paintRight();
    reloadAll();
}

// ---------------------------------------------------------------------------
// Housekeeping (cleaning / maintenance beds)
// ---------------------------------------------------------------------------
function housekeepingModal(bed, ward, root) {
    const setStatus = async (status) => {
        const { error } = await supabase.rpc('set_bed_status', { bed_id: bed.id, status });
        if (error) { toast((error.message) || 'Failed.', 'fail'); return; }
        toast('Bed updated', 'ok');
        await paint(root);
    };
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const actionBtn = (label, status, primary) => h('button', { class: 'btn ' + (primary ? 'btn-primary' : 'btn-outline'), type: 'button', style: { width: '100%', marginBottom: '8px' }, onclick: async () => { await setStatus(status); close(); } }, label);
    const body = [];
    if (bed.status === 'cleaning') { body.push(actionBtn('Cleaning done · free the bed', 'free', true)); body.push(actionBtn('Mark out of service', 'maintenance')); }
    else if (bed.status === 'maintenance') { body.push(actionBtn('Back in service · free', 'free', true)); }
    else { body.push(actionBtn('Mark cleaning', 'cleaning')); body.push(actionBtn('Mark out of service', 'maintenance')); }
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: '380px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon('Bed', { size: 16 }), ' Bed ' + bed.code + ' · ' + (STATUS[bed.status] ? STATUS[bed.status].label : bed.status)), h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { class: 'modal-body' }, ...body),
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')),
    ));
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Admissions history tab
// ---------------------------------------------------------------------------
// INPATIENT_ONE_SECTION_V1 — журнал госпитализаций стал ТРЕТЬЕЙ ВКЛАДКОЙ
// раздела «Стационар», поэтому таблица экспортируется. Это не подвопрос доски
// коек («где кто лежит»), а свой вопрос — «что было»: там закрытые, отменённые
// и выписанные, которых на доске нет по определению.
export async function admissionsHistoryCard() { return admissionsTable(); }

async function admissionsTable() {
    const tbody = h('tbody');
    const card = h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('Doc', { size: 16 }), ' Admissions')),
        h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Adm #'), h('th', null, 'Patient'), h('th', null, 'Ward / Bed'), h('th', null, 'Attending'),
                h('th', null, 'Admitted'), h('th', null, 'Discharged'),
                h('th', { style: { textAlign: 'right' } }, 'Charge'), h('th', null, 'Status'),
            )),
            tbody,
        ),
    );
    tbody.appendChild(h('tr', null, h('td', { colspan: '8', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, 'Loading…')));
    let rows = [];
    try {
        const { data, error } = await supabase.from('admissions')
            .select('*, patients(mrn, full_name), beds(code), wards(name), users(full_name)')
            .order('id', { ascending: false }).limit(200);
        if (error) throw error;
        rows = data || [];
    } catch (e) {
        clear(tbody); tbody.appendChild(h('tr', null, h('td', { colspan: '8', style: { textAlign: 'center', padding: '18px', color: 'var(--crit-600)' } }, 'Failed: ' + ((e && e.message) || e)))); return card;
    }
    clear(tbody);
    if (!rows.length) { tbody.appendChild(h('tr', null, h('td', { colspan: '8', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, 'No admissions yet.'))); return card; }
    for (const a of rows) {
        // Строка «Госпитализации» показывает ВСЕ, включая закрытые: зелёной
        // отметкой выделяем тех, кто лежит сейчас.
        const active = IN_BED_STATUSES.includes(a.status);
        tbody.appendChild(h('tr', null,
            h('td', null, a.admission_no || ('#' + a.id)),
            h('td', null, (a.patients && a.patients.full_name) || '—'),
            h('td', null, ((a.wards && a.wards.name) || '—') + ' / ' + ((a.beds && a.beds.code) || '—')),
            h('td', null, (a.users && a.users.full_name) || '—'),
            h('td', null, fmtDateTime(a.admitted_at)),
            h('td', null, a.discharged_at ? fmtDateTime(a.discharged_at) : '—'),
            h('td', { style: { textAlign: 'right' } }, a.charge_amount != null ? fmtPrice(a.charge_amount) : '—'),
            // ADMISSION_ORDER_V1 — ПОДПИСЬ БЕРЁТСЯ ИЗ ОБЩЕЙ КАРТЫ и ниоткуда
            // больше. Раньше она собиралась здесь на месте и знала не все
            // состояния: заявка ('ordered') подписывалась «Отменено» — то есть
            // экран сообщал, что госпитализации не будет, ровно про того
            // пациента, которого ждут в отделении. Оттенок тоже разведён на
            // три: ждёт размещения (жёлтый), лежит (зелёный), закрыта (серый).
            h('td', null, Tag(admissionStatusLabel(a.status), {
                kind: active ? 'ok' : (a.status === 'ordered' ? 'warn' : ''), dot: true,
            })),
        ));
    }
    return card;
}

// Shared minimal modal (mirrors cashier-desk.js / settings-hub.js chrome).
function modalWide(title, icon, bodyEls, submitLabel, onSubmit) {
    // SERVICE_CATALOG_FILTER_V1 — окно шире и выше: в нём теперь чипы разделов,
    // выбор врача, постоянный список каталога и корзина. На 680px они лепились
    // друг на друга, и каталог был виден на три строки.
    return modal(title, icon, bodyEls, submitLabel, onSubmit, { width: 900, bodyMinHeight: 560 });
}

function modal(title, icon, bodyEls, submitLabel, onSubmit, opts = {}) {
    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
    const submitBtn = h('button', { class: 'btn btn-primary', type: 'button' }, submitLabel);
    submitBtn.addEventListener('click', async () => {
        submitBtn.disabled = true; const prev = submitBtn.textContent; submitBtn.textContent = tr('Выполняем…');
        let ok = false;
        try { ok = await onSubmit(); } catch (e) { toast((e && e.message) || 'Failed.', 'fail'); }
        if (ok) { close(); return; }
        submitBtn.disabled = false; submitBtn.textContent = prev;
    });
    overlay.appendChild(h('div', { class: 'modal-card modal-compact', style: { width: (opts.width || 520) + 'px', maxWidth: 'calc(100vw - 32px)' } },
        h('header', { class: 'modal-head' }, h('h2', null, Icon(icon, { size: 16 }), ' ', title), h('button', { class: 'modal-close', onclick: close }, '×')),
        // MODAL_BODY_ALIGN_V1 — .modal-body это grid (admin.css), а grid по
        // умолчанию РАСТЯГИВАЕТ строки, когда контейнер выше содержимого. С
        // bodyMinHeight свободная высота делилась между строками, и обёртка
        // поля поиска становилась на ~75px выше самого поля. Выпадающий список
        // позиционируется от неё (top: calc(100% + 4px)) — отсюда и провал
        // между строкой поиска и результатами. Строкам нужна своя высота, а
        // остаток пусть копится внизу: min-height задаёт РАЗМЕР ОКНА, а не
        // высоту его строк.
        h('div', { class: 'modal-body', style: { alignContent: 'start', ...(opts.bodyMinHeight ? { minHeight: opts.bodyMinHeight + 'px' } : {}) } }, ...bodyEls.filter(Boolean)),
        h('footer', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), h('span', { class: 'grow' }), submitBtn),
    ));
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// ACCOMMODATION_AS_SERVICE_V1 — «внести проживание в счёт».
// ---------------------------------------------------------------------------
// Раньше выписка молча выставляла отдельный счёт за койку, и не брать за неё
// денег было нельзя. Теперь проживание — обычная строка стационара: внесли —
// попадёт в общий счёт госпитализации вместе с процедурами; не внесли — нет.
//
// Сумма в строке — СНИМОК на момент внесения: проживание дорожает каждый день.
// Когда снимок отстал от текущего расчёта, карточка говорит об этом и предлагает
// обновить — молча недосчитаться денег хуже, чем лишний раз спросить.
const _accState = {};   // admission_id -> ответ accommodation_state

// onChanged — перезагрузка всей консоли (reloadAll). Проживание становится
// СТРОКОЙ в «Услугах», то есть меняет соседний список и итог по счёту, а не
// только эту карточку. Без этого вызова строка появлялась лишь после F5:
// карточка говорила «в счёте», а список услуг был пуст — и это выглядело как
// потерянные деньги.
// ACCOMMODATION_DAILY_V1 — три строки вместо одной: сколько пациент лежит,
// сколько за это уже выставлено и сколько предстоит внести. Без средней строки
// «к оплате 250 000» на третьи сутки читается как потеря двух дней.
const _accDueRepaint = {};   // admission_id -> перерисовать строки «к оплате»

function accommodationDueRows(adm, est) {
    // Своя строка «ключ — значение»: kvRow живёт ВНУТРИ рендера консоли и сюда,
    // в модульную область, не виден. Стиль тот же, чтобы блок читался одним
    // колонкой — расхождение в пару пикселей заметнее, чем кажется.
    const kvRow = (k, v) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '3px 0', fontSize: '12.5px' } },
        h('span', { class: 'muted' }, k), h('span', { style: { fontWeight: 600, textAlign: 'right' } }, v || '—'));
    const box = h('div');
    const paint = () => {
        clear(box);
        const st = _accState[adm.id];
        const units = st ? st.current.units : est.units;
        const net = st ? st.current.net : est.net;
        const rate = st ? st.current.rate : est.rate;
        const unitRu = est.unitLabel === 'day' ? tr('сут.') : tr('ч.');   // перевод по словам — сборка вокруг числа (см. changesLabel в branch-sync-logic.js)

        if (st && st.stay_units != null) {
            box.appendChild(kvRow('Всего в стационаре', st.stay_units + ' ' + unitRu));
        }
        if (st && st.invoiced && st.invoiced.units > 0) {
            box.appendChild(kvRow('Уже выставлено',
                st.invoiced.units + ' ' + unitRu + ' · ' + fmtPrice(st.invoiced.total) + ' ' + tr('сум')));
        }
        box.appendChild(kvRow(est.unitLabel === 'day' ? 'К оплате, дней' : 'К оплате, часов', String(units)));
        box.appendChild(h('div', { style: { fontSize: '17px', fontWeight: 800, color: 'var(--primary-700)' } },
            fmtPrice(net), ' сум'));
        box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
            units + ' × ' + fmtPrice(rate)));
    };
    _accDueRepaint[adm.id] = paint;
    paint();
    return box;
}


function accommodationBox(adm, est, onChanged) {
    const box = h('div', { style: { marginTop: '10px', borderTop: '1px dashed var(--primary-100, #d7efe9)', paddingTop: '10px' } });
    const paint = () => {
        clear(box);
        const st = _accState[adm.id];
        const billed = st && st.billed;

        if (!billed) {
            // ACCOMMODATION_DAILY_V1 — новых суток пока нет: всё, что пациент
            // пролежал, уже в счетах. Кнопка, которая ответит отказом, хуже её
            // отсутствия — тот же принцип, что у поля ответа в чате.
            if (st && st.current && st.current.units <= 0) {
                box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', textAlign: 'center' } },
                    'Всё проживание выставлено — новые сутки появятся здесь'));
                return;
            }
            const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', style: { width: '100%' } },
                Icon('Plus', { size: 13 }), ' Внести в счёт');
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const { data, error } = await supabase.rpc('bill_accommodation', { admission_id: adm.id });
                if (error) { toast(error.message || 'Не удалось внести проживание.', 'fail'); btn.disabled = false; return; }
                toast(trf('Проживание внесено в счёт: {sum} сум', { sum: fmtPrice(data.line.total) }), 'ok');
                await refreshAccommodation(adm.id, paint);
                if (onChanged) await onChanged();   // строка появилась в «Услугах» — обновляем списки
            });
            box.appendChild(btn);
            box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px', textAlign: 'center' } },
                'Пока не внесено — за проживание не выставляется'));
            return;
        }

        box.appendChild(h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
            h('span', { style: { flex: 1, fontSize: '12.5px', fontWeight: 700, color: 'var(--ok-700, #047857)' } },
                Icon('Check', { size: 12 }), ' ', trf('В счёте: {sum} сум', { sum: fmtPrice(billed.total) })),
            billed.invoiced
                ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'выставлено')
                : h('button', { class: 'btn btn-ghost btn-sm', type: 'button', style: { color: 'var(--crit-600)' },
                    onclick: async () => {
                        if (!confirm(tr('Убрать проживание из счёта? За койку тогда денег не возьмут.'))) return;
                        const { error } = await supabase.rpc('unbill_accommodation', { admission_id: adm.id });
                        if (error) { toast(error.message || 'Не удалось убрать.', 'fail'); return; }
                        toast('Проживание убрано из счёта.', 'info');
                        await refreshAccommodation(adm.id, paint);
                        if (onChanged) await onChanged();
                    } }, 'Убрать')));

        // Снимок устарел: пациент лежит дольше, чем когда проживание вносили.
        if (st.stale) {
            const upd = h('button', { class: 'btn btn-sm', type: 'button', style: { width: '100%', marginTop: '6px' } }, trf('Обновить до {sum} сум', { sum: fmtPrice(st.current.net) }));
            upd.addEventListener('click', async () => {
                upd.disabled = true;
                const { error } = await supabase.rpc('bill_accommodation', { admission_id: adm.id });
                if (error) { toast(error.message || 'Не удалось обновить.', 'fail'); upd.disabled = false; return; }
                toast('Проживание обновлено.', 'ok');
                await refreshAccommodation(adm.id, paint);
                if (onChanged) await onChanged();
            });
            box.appendChild(h('div', { style: { fontSize: '12.5px', color: 'var(--warn-700, #92400e)', marginTop: '6px' } },
                trf('Срок вырос: в счёте {billed}, сейчас {current}', { billed: fmtPrice(billed.total), current: fmtPrice(st.current.net) })));
            box.appendChild(upd);
        }
    };
    paint();
    refreshAccommodation(adm.id, paint);
    return box;
}

async function refreshAccommodation(admissionId, paint) {
    const { data, error } = await supabase.rpc('accommodation_state', { admission_id: admissionId });
    if (!error) _accState[admissionId] = data;
    // Строки «всего / выставлено / к оплате» живут выше кнопки и читают тот же
    // ответ — иначе кнопка знала бы про новые сутки, а цифры над ней нет.
    const rows = _accDueRepaint[admissionId];
    if (rows) { try { rows(); } catch (e) {} }
    paint();
}

// Тестовая точка входа: консоль целиком без DOM не поднимается, а поведение
// кнопки проверить надо — от неё зависит, увидит ли медсестра строку сразу.
export const __test_accommodationBox = accommodationBox;

// ---------------------------------------------------------------------------
// ADMISSION_DATE_EDIT_V1 — строка «Поступил» с правкой.
// ---------------------------------------------------------------------------
// Обычная строка карточки, пока на неё не нажали: дату меняют редко, и поле
// ввода на видном месте только приглашает задеть его случайно. По щелчку
// появляется datetime-local и «ОК».
//
// Сервер принимает время БЕЗ зоны как местное (см. rpc/admission-date.js), а
// datetime-local именно такое и отдаёт — поэтому значение уходит как есть, без
// toISOString(), который сдвинул бы дату на часовой пояс.
function admittedRow(adm, onChanged) {
    const wrap = h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '3px 0', fontSize: '12.5px', alignItems: 'center' } });
    const paint = () => {
        clear(wrap);
        wrap.appendChild(h('span', { class: 'muted' }, 'Поступил'));
        wrap.appendChild(h('button', {
            type: 'button', title: 'Изменить дату поступления',
            style: { border: '0', background: 'none', padding: '0', cursor: 'pointer', font: 'inherit', fontWeight: 600, textAlign: 'right', color: 'var(--ink-900)', textDecoration: 'underline dotted' },
            onclick: () => edit(),
        }, fmtDateTime(adm.admitted_at) + ' · ' + lengthOfStay(adm.admitted_at)));
    };
    const edit = () => {
        clear(wrap);
        // datetime-local хочет 'YYYY-MM-DDTHH:MM' в МЕСТНОМ времени; в базе UTC.
        const d = new Date(adm.admitted_at);
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        const inp = h('input', { type: 'datetime-local', value: local,
            style: { flex: 1, minWidth: 0, height: '30px', padding: '0 8px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontFamily: 'inherit', fontSize: '12.5px' } });
        const ok = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'ОК');
        ok.addEventListener('click', async () => {
            ok.disabled = true;
            const { data, error } = await supabase.rpc('set_admission_date', { admission_id: adm.id, admitted_at: inp.value });
            if (error) { toast(error.message || 'Не удалось изменить дату.', 'fail'); ok.disabled = false; return; }
            adm.admitted_at = data.admission.admitted_at;
            toast('Дата поступления изменена.', 'ok');
            // Срок пребывания изменился — с ним койко-дни, расчёт проживания и
            // журнал движения. Перечитываем консоль целиком.
            if (onChanged) await onChanged(); else paint();
        });
        wrap.appendChild(h('span', { class: 'muted' }, 'Поступил'));
        wrap.appendChild(h('span', { class: 'row', style: { gap: '6px', flex: 1, justifyContent: 'flex-end' } }, inp, ok,
            h('button', { class: 'btn btn-sm', type: 'button', onclick: paint }, 'Отмена')));
    };
    paint();
    return wrap;
}
