// «Календарь записи» — CALENDAR_BOOKING_V1.
//
// ─── ЧТО С ЭТИМ ЭКРАНОМ БЫЛО ────────────────────────────────────────────────
//
// Он существовал с RESCAL_V2 — рейка ресурсов, сетка «день × ресурс»,
// затенение нерабочих часов, перетаскивание, цветные статусы, подсказка — и
// НИ РАЗУ, НИ В ОДНОЙ КЛИНИКЕ не показал ни одного приёма. Причина не в
// разметке: каждый его запрос просил колонки, которых нет
// (branches.name_ru, floors.branch_id, rooms.working_hours, rooms.department_id,
// users.branch_id, visits.service_id, visits.room_id), сервер отвечал
// «unknown column» (400), ответ гасился в catch — и сетка была пустой ВСЕГДА.
// Пустая сетка выглядит как «на сегодня никого не записали», поэтому ошибку
// два года никто не видел.
//
// Отсюда два правила этого файла:
//   1. НИ ОДНОГО «catch → console.warn». Не загрузилось — экран говорит, ЧТО
//      именно не загрузилось, и не притворяется пустым расписанием.
//   2. Ни одной колонки, которой нет в реестре (server/db/schema-registry.js).
//
// ─── ГДЕ ЖИВЁТ ПРАВИЛО, А ГДЕ ЭКРАН ─────────────────────────────────────────
//
// Экран НЕ ЗНАЕТ, что такое рабочий день, обед, часы клиники и занятость. Всё
// это считает один общий движок на сервере (server/services/rpc/slot-engine.js):
//
//   calendar_windows — рабочие окна пачкой на «ресурс × день» (затенение);
//   calendar_book    — записать / перенести / растянуть, с проверкой
//                      «ОДИН ПАЦИЕНТ НА ВРАЧА НА СЛОТ» (решение владельца
//                      2026-09-05) и отказом, который НАЗЫВАЕТ занятое время.
//
// Раньше то же правило считалось в браузере в трёх местах сразу, и три ответа
// расходились (разбор — в шапке slot-engine.js). Проверка, которую можно
// обойти, выключив JavaScript, запретом не является: перетаскивание карточки
// уходит в тот же calendar_book, что и сохранение в диалоге.
//
// ─── ВСЕ ЗДАНИЯ (CROSS_BRANCH_CALENDAR_V1) ──────────────────────────────────
//
// Раньше здесь стояло `.is('sync_origin', null)` — «показываем только своё
// здание», и шов был назван вслух: чужая запись приехала бы БЕЗ ВРАЧА, потому
// что SHIPPED.visits не вёз doctor_id. Теперь везёт (ссылкой по логину,
// branch-sync/journal.js), владелец выбрал «видеть и записывать в любой», и
// фильтр снят.
//
// ЧТО ЭКРАН ОБЯЗАН ГОВОРИТЬ ВСЛУХ, И ПОЧЕМУ ИМЕННО ОН. Здания обмениваются раз
// в час. Значит картинка чужого филиала — не живая, и человек, который об этом
// не знает, продаст занятое время. Поэтому:
//
//   • у чужой карточки БУКВА ЗДАНИЯ и «данные на HH:MM» — возраст той копии,
//     а не время последней синхронизации вообще;
//   • наша запись в чужое здание помечена «подтверждается», пока оттуда не
//     придёт квитанция, и слот всё это время занят у обеих сторон;
//   • не уехало — оператор читает «не подтверждено», а не «записано»;
//   • настоящее столкновение внутри часа НЕ ПРЯЧЕТСЯ: обе записи видны, поздняя
//     помечена, и рядом написано, кто считается первым.
//
// НИ ОДНО ИЗ ЭТИХ ЧЕТЫРЁХ ЗНАНИЙ ЭКРАН НЕ СЧИТАЕТ САМ. «Подтверждено» живёт в
// горизонте квитанций, «данные на» — в возрасте последнего блоба, «кто первый» —
// это правило. Всё считает сервер и отдаёт одним ответом calendar_windows.cross
// (services/rpc/calendar.js) — по той же причине, по которой окна рабочего дня
// считает slot-engine.js: вторая реализация правила в браузере разошлась бы с
// первой, и разошлась бы молча.
//
// ─── ЧЕГО ЗДЕСЬ ПОКА НЕТ ────────────────────────────────────────────────────
//
// ОСИ КАБИНЕТОВ ПО ЧУЖОМУ ЗДАНИЮ. Правило владельца: кабинеты — принадлежность
// здания, и room_id между зданиями не ездит намеренно (миграция 100). «Кабинет
// 5» соседа в нашей базе означал бы случайную местную комнату, поэтому при
// выбранном чужом филиале ось кабинетов честно говорит, что её нет.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, initials, avColor, Avatar } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { loadPatientById } from '../data.js';
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';   // RESCAL_WIRE_V1 — same URL as other importers (one instance)
import { registrarHeader } from './registrar-header.js?v=aurora5';   // NO_GREETING_V1 — same URL as patients.js (one instance)

const WD_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RU_MO = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const RU_WD_L = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const RU_WD_S = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// Полотно сетки по умолчанию. Не «рабочий день» — рабочий день считает сервер,
// — а холст, на котором он рисуется. Раздвигается под настоящие окна и под
// записи, вылезающие за него (приём в 21:00 раньше был просто не виден).
const CANVAS_FROM = 8 * 60;
const CANVAS_TO = 20 * 60;

// СТАТУСЫ — ПЯТЬ, И ЭТО ВСЕ, ЧТО МОЖЕТ БЫТЬ В БАЗЕ. visits.status несёт
// CHECK (status IN ('scheduled','confirmed','arrived','cancelled','no_show'))
// с миграции 003, и владелец назвал ровно эти пять: записан / подтверждён /
// пришёл / отменён / не пришёл. Прежняя версия экрана рисовала ещё «Заявка»,
// «Завершён» и «Запланирован» — состояния из старшей системы, которых локальная
// база принять не может физически; кнопка «Заявка» не могла сработать никогда.
const STATUS_META = {
    scheduled: { label: 'Записан',     color: 'var(--primary-600)' },
    confirmed: { label: 'Подтверждён', color: 'var(--info-700)' },
    arrived:   { label: 'Пришёл',      color: 'var(--ok-700)' },
    cancelled: { label: 'Отменён',     color: 'var(--ink-300)' },
    no_show:   { label: 'Не пришёл',   color: 'var(--warn-700)' },
};
const STATUS_ORDER = ['scheduled', 'confirmed', 'arrived', 'no_show', 'cancelled'];
// Время занимают только эти три — как и на сервере (BUSY_STATUSES).
const BUSY = ['scheduled', 'confirmed', 'arrived'];

function normStatus(s) {
    const k = String(s || '').toLowerCase();
    return STATUS_META[k] ? k : 'scheduled';
}

// Отказы calendar_book с динамикой. Склеенная фраза непереводима в принципе
// (tr() ищет строку целиком), поэтому сервер шлёт {code, params}, а экран
// переводит ШАБЛОН и подставляет значения ПОСЛЕ перевода — тот же приём, что у
// service-editor-logic.js.
const RPC_ERROR_TEMPLATES = {
    slot_taken: 'Это время занято: у врача {doctor} уже есть приём {from}–{to}. Выберите другое время.',
    emergency_reason_required: 'Экстренная запись поверх занятого времени требует причины — укажите её.',
};
function rpcErrorText(error) {
    const tpl = error && error.code ? RPC_ERROR_TEMPLATES[error.code] : null;
    if (tpl) return trf(tpl, (error && error.params) || {});
    return (error && error.message) ? tr(error.message) : tr('Не удалось сохранить запись.');
}

function isoToLocalDay(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function dateToIso(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
function todayIso() { return dateToIso(new Date()); }
function minutesOfLocal(dt) { return dt.getHours() * 60 + dt.getMinutes(); }
function fmtHM(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function hhmmToMin(s) { const [hh, mm] = String(s || '').split(':').map(Number); return (hh || 0) * 60 + (mm || 0); }
function ruDay(iso) { const d = isoToLocalDay(iso); return `${RU_WD_L[d.getDay()]}, ${d.getDate()} ${RU_MO[d.getMonth()]} ${d.getFullYear()}`; }
/** Местное настенное время дня → ISO. Единственный перевод в сторону сервера. */
function localIso(dayIso, min) {
    const d = isoToLocalDay(dayIso);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d.toISOString();
}
const pxPerMin = (step) => (step <= 10 ? 16 : step <= 15 ? 22 : 34) / step;

/**
 * Минуты ожидания → «25 мин» / «3 ч 10 мин». СКОЛЬКО, а не «давно»: оператор
 * решает по числу, звонить ли, и «давно» этого решения не поддерживает.
 *
 * Само число считает сервер (rpc/calendar.js confirming_minutes) — здесь только
 * его написание словами, потому что склейка «3» + «ч» непереводима целиком.
 */
function ageText(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return trf('{n} мин', { n: m });
    const h = Math.floor(m / 60), rest = m % 60;
    return rest ? trf('{h} ч {n} мин', { h, n: rest }) : trf('{h} ч', { h });
}

// CROSS_BRANCH_CALENDAR_V1 — вид межфилиальных подписей. Живёт здесь, а не в
// admin.css: это свойства ОДНОГО экрана, а таблица стилей общая на все сто с
// лишним. Размеры — нижняя ступень шкалы (12.5 px), ниже неё не опускаемся.
const AGE_CSS = { fontSize: '12.5px', color: 'var(--ink-400, #94a3b8)', lineHeight: '1.25' };
const FAR_NOTE_CSS = {
    padding: '9px 12px', margin: '0 0 10px', borderRadius: '8px', fontSize: '13.5px',
    background: 'var(--warn-50, #fff7ed)', border: '1px solid var(--warn-200, #fed7aa)',
    color: 'var(--ink-700, #334155)',
};

export async function renderRoomCalendar(container, { onNavigate, embedded = false } = {}) {
    const state = {
        resType: 'doctor', napr: '', q: '', step: 15, period: 1,
        dayIso: todayIso(), showCancelled: false,
        doctors: [], rooms: [], servicesList: [], appts: [], windows: {},
        selected: new Set(), failed: [], loaded: false,
        // CROSS_BRANCH_CALENDAR_V1. branch — БУКВА выбранного здания ('' = все).
        // cross — то, что про эти записи знает только сервер (см. шапку).
        branch: '', cross: { self: '', buildings: [], visits: {} },
    };

    clear(container);
    const wrap = h('div', { class: 'fade-in' });
    container.appendChild(wrap);
    // Своя шапка — только когда экран открыт сам по себе. Внутри вкладок
    // «Пациенты» её рисует хост (та же договорённость, что у patients.js с его
    // `embedded`): заголовок и полоса вкладок там принадлежат хосту, иначе на
    // экране окажется две шапки.
    if (!embedded) {
        wrap.appendChild(h('div', { class: 'page-head' },
            h('div', null,
                h('h1', { class: 'page-title' }, 'Записи'),
                h('p', { class: 'page-subtitle' }, 'Кто к кому и когда записан. Колонки — врачи или кабинеты, длительность — из услуги, перенос — перетаскиванием.'))));
        wrap.appendChild(registrarHeader({ active: 'appointments', onNavigate }));
    }
    const root = h('div', { class: 'rcal' });
    wrap.appendChild(root);

    // ---- data ----------------------------------------------------------
    // Каждый запрос ПРОВЕРЯЕТСЯ. Молчаливый catch — ровно то, из-за чего этот
    // экран два года показывал пустую сетку вместо ошибки.
    function take(res, tableLabel) {
        if (res && res.error) { state.failed.push(tableLabel); return []; }
        return (res && res.data) || [];
    }

    async function loadResources() {
        state.failed = [];
        const [brs, floors, rms, docs, svcs] = await Promise.all([
            supabase.from('branches').select('id, name').eq('active', true),
            supabase.from('floors').select('id, name, level').eq('active', true),
            supabase.from('rooms').select('id, name, code, room_type, floor_id').eq('active', true).order('code', { ascending: true }),
            supabase.from('users').select('id, full_name, specialty, role, branch_id, is_doctor, scheduling_mode').eq('active', true).order('full_name', { ascending: true }),
            supabase.from('services').select('id, name, duration_minutes').eq('active', true).order('name', { ascending: true }),
        ]);
        const branchName = {}, floorName = {};
        for (const b of take(brs, tr('филиалы'))) branchName[b.id] = b.name || '';
        for (const f of take(floors, tr('этажи'))) floorName[f.id] = f.name || '';

        // У кабинета подписывается ЭТАЖ, а не здание: календарь показывает
        // работу своего здания, поэтому буква здания была бы одинаковой на всех
        // карточках, а этаж — то, чем регистратура отличает кабинет от кабинета.
        // Подробный разбор — в шапке миграции 099.
        state.rooms = take(rms, tr('кабинеты')).map(r => ({
            id: r.id,
            name: r.name || trf('Каб. {code}', { code: r.code || '' }),
            spec: r.room_type || '',
            napr: r.room_type || '',
            place: floorName[r.floor_id] || '',
        }));
        // ADMIN_DOCTOR_LIST_V1 — администратор клиники может быть и врачом; у
        // такой учётки role='admin', поэтому проверять надо is_doctor.
        state.doctors = take(docs, tr('сотрудники'))
            .filter(u => u.is_doctor === true || u.is_doctor === 1 || (u.role || '').toLowerCase() === 'doctor' || (u.specialty || '').trim())
            .map(u => ({
                id: u.id, name: u.full_name || '—',
                spec: u.specialty || '',
                napr: u.specialty || '',
                place: branchName[u.branch_id] || '',
                // CROSS_BRANCH_CALENDAR_V1 — id здания сотрудника. Буква из него
                // берётся ПРИ ОТРИСОВКЕ, а не здесь: справочник зданий приезжает
                // тем же ответом, что и записи, и порядок загрузок не должен
                // решать, окажется ли врач приписан к филиалу.
                branchId: u.branch_id || null,
                liveQueue: (u.scheduling_mode || '') === 'live_queue',
            }));
        state.servicesList = take(svcs, tr('услуги')).map(s => ({ id: s.id, name: s.name || '—', dur: s.duration_minutes }));
    }

    async function loadAppts() {
        const start = isoToLocalDay(state.dayIso);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + state.period);
        // ВСЕ ЗДАНИЯ. Фильтра «только своё» здесь больше нет: врач едет вместе с
        // записью, поэтому чужая запись попадает в колонку своего врача, а не в
        // «Не назначено». sync_origin читается, чтобы отличить приехавшую строку
        // от своей — на приехавшую нельзя ссылаться как на «нашу работу».
        const { data, error } = await supabase.from('visits')
            .select('id, patient_id, doctor_id, service_id, room_id, branch_id, sync_origin, visit_date, duration_minutes, status')
            .gte('visit_date', start.toISOString()).lt('visit_date', end.toISOString())
            .order('visit_date', { ascending: true });
        if (error) { state.appts = []; state.failed = [tr('записи')]; return; }
        const visits = data || [];

        const pids = [...new Set(visits.map(v => v.patient_id).filter(Boolean))];
        const pn = pids.length
            ? await supabase.from('patients').select('id, full_name, first_name, last_name, phone').in('id', pids)
            : { data: [] };
        const pm = {}, ph = {};
        for (const r of take(pn, tr('пациенты'))) {
            pm[r.id] = r.full_name || [r.last_name, r.first_name].filter(Boolean).join(' ') || '—';
            ph[r.id] = r.phone || '';
        }
        const sm = {};
        for (const s of state.servicesList) sm[s.id] = s.name;

        state.appts = visits.map(v => {
            const dt = new Date(v.visit_date);
            return {
                id: v.id, patientId: v.patient_id, doctorId: v.doctor_id, roomId: v.room_id,
                branchId: v.branch_id || null, origin: v.sync_origin || null,
                date: dateToIso(dt), start: minutesOfLocal(dt), dur: Number(v.duration_minutes) || 15,
                patient: pm[v.patient_id] || '—', phone: ph[v.patient_id] || '',
                serviceId: v.service_id, service: sm[v.service_id] || '',
                status: normStatus(v.status),
            };
        });
    }

    // Рабочие окна и МЕЖФИЛИАЛЬНЫЙ КОНТЕКСТ — ОДНИМ запросом на всю видимую
    // сетку. Экран не считает ни графики, обеды и часы клиники, ни «кто первый»,
    // ни «подтверждено ли»: всё это считает сервер (slot-engine.js и
    // rpc/calendar.js), потому что вторая реализация правила в браузере
    // разошлась бы с первой молча.
    //
    // ЗАПРОС УХОДИТ ДАЖЕ БЕЗ ВЫБРАННЫХ РЕСУРСОВ, и это не расточительство:
    // список зданий нужен переключателю филиалов ДО того, как в сетке
    // что-нибудь выбрано.
    async function loadWindows() {
        const sel = resources().filter(r => state.selected.has(r.id) && r.id !== UNASSIGNED_ID);
        const args = { date: state.dayIso, days: state.period };
        if (state.resType === 'doctor') args.doctor_ids = sel.map(r => r.id);
        else args.room_ids = sel.map(r => r.id);
        const { data, error } = await supabase.rpc('calendar_windows', args);
        state.windows = (!error && data && data.windows) ? data.windows : {};
        // Контекст НЕ обнуляется молча при отказе: пустой контекст означал бы
        // «чужих записей нет и всё подтверждено» — самая опасная из возможных
        // неправд на этом экране. Отказ виден в полосе «Не загрузилось».
        if (!error && data && data.cross) state.cross = data.cross;
        else if (error) state.failed = [...new Set([...state.failed, tr('филиалы')])];
    }

    function windowFor(res, dayIso) {
        if (res.id === UNASSIGNED_ID) return null;
        const byDay = state.windows[state.resType + ':' + res.id];
        const w = byDay && byDay[dayIso];
        if (!w) return null;
        return { from: hhmmToMin(w.from), to: hhmmToMin(w.to), breaks: (w.breaks || []).map(b => ({ from: hhmmToMin(b.from), to: hhmmToMin(b.to) })) };
    }
    function isOffHour(win, min) {
        if (!win) return true;
        if (min < win.from || min >= win.to) return true;
        return (win.breaks || []).some(b => min >= b.from && min < b.to);
    }

    // RCAL_UNASSIGNED_V1 — запись без врача (и без кабинета) должна быть видна:
    // иначе строго разложенная по дорожкам сетка её ПРЯЧЕТ, и человек не
    // приходит потому, что о нём забыли. Синтетическая дорожка ловит такие
    // записи, и регистратура перетаскивает их на врача, чтобы назначить.
    const UNASSIGNED_ID = '__unassigned__';
    const UNASSIGNED = { id: UNASSIGNED_ID, name: 'Не назначено', spec: 'ждут назначения', napr: '', place: '' };
    const resources = () => [UNASSIGNED, ...(state.resType === 'doctor' ? state.doctors : state.rooms)];
    const filteredRail = () => {
        const ql = state.q.trim().toLowerCase();
        return resources().filter(r => (!state.napr || r.napr === state.napr)
            && railBranchOk(r)
            && (!ql || (r.name + ' ' + r.spec).toLowerCase().includes(ql)));
    };
    function defaultSelect() { state.selected = new Set(filteredRail().slice(0, 6).map(r => r.id)); }
    const doctorName = (id) => (state.doctors.find(d => d.id === id) || {}).name || '';
    const roomName = (id) => (state.rooms.find(r => r.id === id) || {}).name || '';

    // ---- здания (CROSS_BRANCH_CALENDAR_V1) ------------------------------
    // Всё, что экран знает о зданиях, приезжает в calendar_windows.cross. Своих
    // домыслов здесь нет ни одного: буква здания, возраст его картинки, «ждём
    // подтверждения» и «кто первый в споре» — ответы сервера, а не вычисления.
    const myLetter = () => state.cross.self || '';
    const buildings = () => state.cross.buildings || [];
    const letterOfBranchId = (id) => (buildings().find(b => b.id === id) || {}).letter || '';
    const buildingByLetter = (l) => buildings().find(b => b.letter === l) || null;
    const buildingName = (l) => { const b = buildingByLetter(l); return (b && b.name) || l || ''; };
    const apptCross = (a) => (state.cross.visits || {})[a.id] || null;
    /** Здание ПРИЁМА (не автора записи): ответ сервера, иначе приписка, иначе своё. */
    const apptLetter = (a) => {
        const i = apptCross(a);
        return (i && i.building) || letterOfBranchId(a.branchId) || myLetter();
    };
    const inBranch = (a) => !state.branch || apptLetter(a) === state.branch;
    /**
     * Куда запишет клик по этой дорожке. Приписка врача сильнее выбранного
     * фильтра: врач здания B остаётся врачом здания B, даже когда в сетке
     * смотрят «все здания».
     *
     * ЭТА ФУНКЦИЯ ДОЛГО ОТВЕЧАЛА ВСЕГДА ОДНО И ТО ЖЕ — «своё здание», — и весь
     * межфилиальный путь ниже (far, commitToBuilding) из-за этого не исполнялся
     * ни разу на настоящих данных: приписка приезжающих врачей была пуста,
     * потому что справочник её не вёз. Теперь везёт буквой здания
     * (branch-sync/catalogue.js), и ответ здесь наконец зависит от врача.
     */
    const targetLetter = (r) => {
        if (state.resType !== 'doctor') return myLetter();
        return letterOfBranchId(r.branchId) || state.branch || myLetter();
    };
    const hhmmOf = (iso) => {
        const d = new Date(iso || '');
        return Number.isNaN(d.getTime()) ? '' : fmtHM(minutesOfLocal(d));
    };
    /**
     * Пускать ли ресурс в рейку при выбранном здании.
     *
     * Сотрудник БЕЗ приписки показывается в ЛЮБОМ филиале, и это честнее, чем
     * спрятать его: пустая приписка означает «здание неизвестно», а не «здание
     * чужое». Раньше пустой она была У ВСЕХ приехавших врачей (справочник не
     * вёз колонку), то есть это правило было единственным, что вообще держало
     * рейку непустой; теперь приписка едет буквой (catalogue.js), пустой она
     * остаётся у редких строк — и правило из подпорки стало тем, чем должно
     * быть: обращением с неизвестным как с неизвестным.
     */
    const railBranchOk = (r) => {
        if (!state.branch || r.id === UNASSIGNED_ID) return true;
        if (state.resType === 'room') return state.branch === myLetter();
        const l = letterOfBranchId(r.branchId);
        return !l || l === state.branch;
    };

    // ---- сервер решает, можно ли ---------------------------------------
    /** Единственный путь записи/переноса/растягивания. Возвращает true при успехе. */
    async function commit(args, { onSlotTaken = null } = {}) {
        const { data, error } = await supabase.rpc('calendar_book', args);
        if (!error) return data || true;
        if (error.code === 'slot_taken' && onSlotTaken) { onSlotTaken(error); return false; }
        toast(rpcErrorText(error), 'fail');
        return false;
    }

    // ЭКСТРЕННАЯ ЗАПИСЬ — ОТДЕЛЬНОЕ ДЕЙСТВИЕ С ПРИЧИНОЙ, а не галочка, снимающая
    // проверку. Причина уходит в саму запись (visits.notes) и уезжает вместе с
    // ней филиалам, то есть остаётся у пациента, а не в логе на этом компьютере.
    function openEmergencyDialog(conflictText, onConfirm) {
        const overlay = h('div', { class: 'modal', style: { zIndex: '150' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        const reason = h('textarea', { class: 'rcal-reason', rows: '3', placeholder: tr('Например: острая боль, направлен из приёмного отделения') });
        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Warning', { size: 16 }), ' ', tr('Экстренная запись')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { class: 'rcal-conflict' }, conflictText),
                h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '12px 0 6px' } },
                    'Запись поверх занятого времени сохраняется вместе с причиной — она останется в карточке приёма.'),
                reason),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-outline', onclick: close }, 'Отмена'),
                h('button', {
                    class: 'btn btn-primary', onclick: async (ev) => {
                        const text = (reason.value || '').trim();
                        if (text.length < 3) { toast('Укажите причину экстренной записи.', 'fail'); return; }
                        ev.currentTarget.disabled = true;
                        const ok = await onConfirm(text);
                        if (ok) close(); else ev.currentTarget.disabled = false;
                    },
                }, 'Записать экстренно'))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
        reason.focus();
    }

    /** Отказ «занято» → предложить экстренную запись тем же вызовом с причиной. */
    function offerEmergency(args, error, after) {
        openEmergencyDialog(rpcErrorText(error), async (reasonText) => {
            const ok = await commit({ ...args, emergency: true, emergency_reason: reasonText });
            if (ok) { toast('Запись сохранена как экстренная'); if (after) after(); }
            return !!ok;
        });
    }

    // ---- booking + open -------------------------------------------------
    function bookAt(res, dayIso, min) {
        if (res.id === UNASSIGNED_ID) { toast('Перетащите запись на врача или кабинет, чтобы её назначить.', 'info'); return; }
        // Мгновенная подсказка по уже загруженным записям дня. НЕ ЗАМЕНА
        // серверной проверки: мастер визита пишет визит сам, и последнее слово
        // о занятости всё равно за сервером.
        const key = state.resType === 'doctor' ? 'doctorId' : 'roomId';
        const clash = state.appts.find(a => a[key] === res.id && a.date === dayIso
            && BUSY.includes(a.status) && min < a.start + a.dur && a.start < min + state.step);
        if (clash && state.resType === 'doctor') {
            toast(trf('Это время занято: у врача {doctor} уже есть приём {from}–{to}. Выберите другое время.',
                { doctor: res.name, from: fmtHM(clash.start), to: fmtHM(clash.start + clash.dur) }), 'fail');
            return;
        }
        const letter = targetLetter(res);
        const far = !!(letter && myLetter() && letter !== myLetter());
        const open = () => openServicePickerModal({
            calculator: true,
            roomId: state.resType === 'room' ? res.id : null,
            lockedDoctor: state.resType === 'doctor' ? { id: res.id, name: res.name, spec: res.spec } : null,   // CATALOG_WIZARD_V1
            scheduledISO: localIso(dayIso, min),
            onCreatePatient: () => { if (onNavigate) onNavigate('registration'); },
            // BOOK_WIZARD_V1 — новая запись видна сразу. CROSS_BRANCH_CALENDAR_V1
            // — а если она в чужое здание, то ещё и привязывается к нему и
            // немедленно уезжает (commitToBuilding).
            onBooked: () => { if (far) commitToBuilding(res, dayIso, min, letter); else reloadAndRepaint(); },
        });
        // ПРЕДУПРЕЖДЕНИЕ ДОСТАЁТСЯ ТОМУ, КТО ЕЩЁ НЕ ЗАПИСАЛ. Остаточный риск
        // решения владельца — слот, занятый в том здании внутри последнего часа,
        // — устранить нельзя: забирает сосед своим тактом. Значит единственное
        // честное действие — назвать возраст картинки и приехавшую запись без
        // врача ЗДЕСЬ, до открытия мастера, а не в ответе после сохранения.
        // Полоса над сеткой говорила это тому, кто уже записал.
        if (!far) { open(); return; }
        farBookingWarning(letter, dayIso, min, open);
    }

    /**
     * Что оператор слышит ПЕРЕД записью в чужое здание.
     *
     * Три случая, и порог между ними — не вкус:
     *   • приехавшая запись без врача на это же время — спрашиваем подтверждение
     *     кнопкой: там кого-то ждут, и кто именно врач, не знает никто;
     *   • картинки того здания у нас нет вовсе или она старше порога — тоже
     *     кнопкой: сетка, которую сейчас видит оператор, ничего не обещает;
     *   • картинка свежая — обычное уведомление с её возрастом, без остановки:
     *     останавливать на каждой записи в соседний корпус значило бы приучить
     *     нажимать «продолжить» не читая.
     */
    function farBookingWarning(letter, dayIso, min, proceed) {
        const b = buildingByLetter(letter);
        const name = buildingName(letter);
        // ПОРОГ — ОТВЕТ СЕРВЕРА, И ВТОРОЙ ЕГО КОПИИ ЗДЕСЬ НЕТ. Сервер старой
        // сборки его не пришлёт; тогда экран НЕ ОБЪЯВЛЯЕТ картинку устаревшей
        // сам (0 — «правила не знаю»), но отсутствие картинки вовсе остаётся
        // поводом спросить: для этого правило не нужно.
        const stale = Number(state.cross.stale_after_minutes) || 0;
        const ageMin = b && b.as_of ? Math.floor((Date.now() - Date.parse(b.as_of)) / 60000) : null;
        const blind = !(b && b.as_of) || !Number.isFinite(ageMin) || (stale > 0 && ageMin >= stale);
        // Приехавшие записи без врача этого здания, попадающие на это время.
        const nodoc = (state.appts || []).filter(a => !a.doctorId && a.date === dayIso
            && BUSY.includes(a.status) && (apptCross(a) || {}).unassigned
            && apptLetter(a) === letter
            && min < a.start + a.dur && a.start < min + state.step);

        if (!blind && !nodoc.length) {
            toast(trf('Здание {b}: данные на {t}. Внутри этого часа слот могли занять и там.',
                { b: name, t: hhmmOf(b.as_of) }), 'info');
            proceed();
            return;
        }
        const lines = [];
        if (nodoc.length) {
            lines.push(trf('В здании {b} на {from}–{to} уже ждут пациента, а врач у этой записи не определён: её время у нас не занято ни у кого.',
                { b: name, from: fmtHM(nodoc[0].start), to: fmtHM(nodoc[0].start + nodoc[0].dur) }));
        }
        if (blind) {
            lines.push(b && b.as_of
                ? trf('Данные здания {b} — на {t}, это дольше обычного обмена. Что там сейчас занято, мы не знаем.', { b: name, t: hhmmOf(b.as_of) })
                : trf('Данных из здания {b} ещё не было ни разу. Что там занято, мы не знаем.', { b: name }));
        }
        openConfirmDialog({
            title: trf('Запись в здание {b}', { b: name }),
            lines,
            note: tr('Записать можно — время там, скорее всего, свободно. Но обещать его пациенту как подтверждённое нельзя: подтверждение придёт из того здания.'),
            okLabel: tr('Всё равно записать'),
            onConfirm: proceed,
        });
    }

    /**
     * Спросить и продолжить. Тот же костяк, что у диалога экстренной записи, но
     * БЕЗ поля причины: там причина уходит в запись и остаётся с пациентом, а
     * здесь спрашивают не «зачем», а «вы это прочитали». Поле, которое никуда
     * не пишется, было бы бутафорией.
     */
    function openConfirmDialog({ title, lines, note, okLabel, onConfirm }) {
        const overlay = h('div', { class: 'modal', style: { zIndex: '150' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));
        // Фокус — на «Отмене», а не на «Всё равно записать»: диалог открылся
        // потому, что что-то не в порядке, и Enter по привычке не должен
        // означать «продолжить».
        const cancel = h('button', { class: 'btn btn-outline', onclick: close }, tr('Отмена'));
        overlay.appendChild(h('div', { class: 'modal-card rcal-confirm', style: { width: '460px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Warning', { size: 16 }), ' ', title),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                ...lines.map(t => h('div', { class: 'rcal-conflict', style: { marginBottom: '8px' } }, t)),
                note ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, note) : null),
            h('footer', { class: 'modal-foot' },
                h('span', { class: 'grow' }),
                cancel,
                h('button', {
                    class: 'btn btn-primary',
                    onclick: () => { close(); onConfirm(); },
                }, okLabel))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
        cancel.focus();
    }

    /**
     * ЗАПИСЬ В ЧУЖОЕ ЗДАНИЕ — вторым шагом и ТЕМ ЖЕ calendar_book.
     *
     * Мастер визита пишет визит сам (он же собирает услуги и деньги), и он общий
     * для полудюжины экранов — трогать его ради филиалов нельзя. Поэтому
     * календарь делает свою половину после него: привязывает только что
     * созданную запись к зданию тем же вызовом, что и любой перенос. Проверка
     * занятости, срочная выгрузка и пометка «подтверждается» приходят оттуда же,
     * а не отсюда.
     *
     * Запись ищется по врачу, дню и минуте — ровно по тем трём, которые мастеру
     * и назвали (lockedDoctor + scheduledISO). Не нашли (оператор поменял время
     * внутри мастера) — говорим вслух: запись есть, к зданию не привязана.
     * Промолчать здесь значило бы оставить в чужом здании невидимый приём.
     */
    async function commitToBuilding(res, dayIso, min, letter) {
        await loadAppts();
        const b = buildingByLetter(letter);
        const fresh = state.appts
            .filter(a => !a.origin && a.doctorId === res.id && a.date === dayIso && a.start === min)
            .sort((x, y) => y.id - x.id)[0];
        if (!fresh || !b || !b.id) {
            toast(trf('Запись создана, но привязать её к зданию {b} не удалось — откройте карточку и повторите.',
                { b: buildingName(letter) }), 'fail');
            await reloadAndRepaint();
            return;
        }
        const out = await commit({ visit_id: fresh.id, branch_id: b.id, start: localIso(dayIso, min) });
        const cx = out && out.cross_branch;
        // СЛОВА «ЗАПИСАНО» ЗДЕСЬ НЕТ НИ В ОДНОЙ ВЕТКЕ. Уехало — «отправлено,
        // ждём подтверждения»; не уехало — «не подтверждено». Оператор стоит
        // перед человеком, и обещать за соседнее здание он не должен.
        if (cx && cx.published === false) {
            toast(trf('Не подтверждено: связи со зданием {b} нет. Слот держим здесь, но там о записи ещё не знают — не обещайте пациенту это время.',
                { b: buildingName(letter) }), 'fail');
        } else if (cx) {
            toast(trf('Запись отправлена в здание {b}. Пока оно не подтвердит, карточка помечена «подтверждается».',
                { b: buildingName(letter) }), 'info');
        }
        await reloadAndRepaint();
    }

    async function openCard(a) {
        if (!a.patientId) { toast('У записи нет пациента.', 'info'); return; }
        try {
            const p = await loadPatientById(a.patientId);
            if (p && onNavigate) onNavigate('patient-card', p); else toast('Не удалось открыть карту.', 'fail');
        } catch (e) { toast('Не удалось открыть карту.', 'fail'); }
    }

    // ---- диалог записи: правки + статусы --------------------------------
    function openApptModal(a) {
        const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); reloadAndRepaint(); };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const _ecss = { fontSize: '13.5px', padding: '7px 9px', border: '1px solid var(--ink-200, #e2e8f0)', borderRadius: '8px', background: '#fff', color: 'var(--ink-800, #1e293b)', width: '100%', boxSizing: 'border-box' };
        const svcSel = h('select', { class: 'rcal-edit', style: _ecss },
            h('option', { value: '' }, tr('— без услуги —')),
            ...(state.servicesList || []).map(s => h('option', Object.assign({ value: s.id }, String(s.id) === String(a.serviceId) ? { selected: true } : {}), s.name || '—')));
        const docSel = h('select', { class: 'rcal-edit', style: _ecss },
            h('option', { value: '' }, tr('— без врача —')),
            ...(state.doctors || []).map(d => h('option', Object.assign({ value: d.id }, String(d.id) === String(a.doctorId) ? { selected: true } : {}), (d.name || '—') + (d.spec ? ' · ' + d.spec : ''))));
        const dateInp = h('input', { type: 'date', class: 'rcal-edit', style: _ecss, value: a.date });
        const timeInp = h('input', { type: 'time', class: 'rcal-edit', style: Object.assign({}, _ecss, { width: '120px' }), value: fmtHM(a.start) });
        const durInp = h('input', { type: 'number', min: '5', step: '5', class: 'rcal-edit', style: Object.assign({}, _ecss, { width: '90px' }), value: String(a.dur) });

        // Длительность подтягивается за услугой: владелец назвал её источником
        // длительности («по умолчанию 15, лабораторные — свои»).
        svcSel.addEventListener('change', () => {
            const s = state.servicesList.find(x => String(x.id) === String(svcSel.value));
            if (s && Number(s.dur) > 0) durInp.value = String(Number(s.dur));
        });

        function editArgs() {
            const dv = dateInp.value || a.date;
            const tv = timeInp.value || fmtHM(a.start);
            return {
                visit_id: a.id,
                start: localIso(dv, hhmmToMin(tv)),
                duration_minutes: Math.max(5, parseInt(durInp.value, 10) || a.dur),
                doctor_id: docSel.value ? Number(docSel.value) : null,
                service_id: svcSel.value ? Number(svcSel.value) : null,
            };
        }

        const pillsBox = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } });
        function paintPills() {
            clear(pillsBox);
            for (const k of STATUS_ORDER) {
                const m = STATUS_META[k];
                pillsBox.appendChild(h('button', {
                    class: 'rcal-stbtn' + (a.status === k ? ' on' : ''), type: 'button',
                    onclick: async (ev) => {
                        ev.currentTarget.disabled = true;
                        // Смена статуса идёт ТЕМ ЖЕ обработчиком: возврат
                        // отменённой записи в «Записан» обязан спросить, свободен
                        // ли ещё её слот.
                        const args = { visit_id: a.id, start: localIso(a.date, a.start), status: k };
                        const ok = await commit(args, { onSlotTaken: (err) => offerEmergency(args, err, () => { a.status = k; paintPills(); }) });
                        if (ok) { a.status = k; toast(trf('Статус: {status}', { status: tr(m.label) })); paintPills(); }
                        else ev.currentTarget.disabled = false;
                    },
                }, h('span', { class: 'rcal-dot', style: { background: m.color } }), tr(m.label)));
            }
        }
        paintPills();

        const row = (label, value) => h('div', { class: 'row', style: { gap: '10px', padding: '7px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '13.5px', alignItems: 'baseline' } },
            h('span', { class: 'muted', style: { flex: '0 0 110px', fontSize: '12.5px' } }, label),
            h('span', { style: { fontWeight: 500 } }, value || '—'));
        const editRow = (label, control) => h('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--ink-50)' } },
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginBottom: '4px' } }, label), control);

        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Calendar', { size: 16 }), ' ', tr('Запись')),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                h('div', { class: 'row', style: { gap: '11px', alignItems: 'center', marginBottom: '12px' } },
                    Avatar({ initials: initials(a.patient), color: avColor(a.patientId || a.patient) }),
                    h('div', { style: { minWidth: 0 } },
                        h('div', { style: { fontWeight: 700, fontSize: '13.5px' } }, a.patient),
                        a.phone ? h('div', { class: 'muted', style: { fontSize: '12.5px' } }, a.phone) : null)),
                editRow(tr('Услуга'), svcSel),
                editRow(tr('Врач'), docSel),
                a.roomId ? row(tr('Кабинет'), roomName(a.roomId)) : null,
                editRow(tr('Дата'), dateInp),
                editRow(tr('Время и длительность'), h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
                    timeInp, durInp, h('span', { class: 'muted', style: { fontSize: '12.5px' } }, tr('мин')))),
                h('div', { class: 'rcal-sechead' }, 'Статус приёма'),
                pillsBox,
                h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '12px' } },
                    'Перетащите запись в сетке, чтобы перенести время, день или ресурс.')),
            h('footer', { class: 'modal-foot' },
                h('button', {
                    class: 'btn', style: { color: 'var(--crit-700)' }, onclick: async (ev) => {
                        ev.currentTarget.disabled = true;
                        const ok = await commit({ visit_id: a.id, start: localIso(a.date, a.start), status: 'cancelled' });
                        if (ok) { toast('Запись отменена'); close(); } else ev.currentTarget.disabled = false;
                    },
                }, 'Отменить запись'),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-outline', onclick: () => { overlay.remove(); document.removeEventListener('keydown', onEsc); openCard(a); } },
                    Icon('ID', { size: 13 }), ' ', tr('Карта пациента')),
                h('button', {
                    class: 'btn btn-primary', onclick: async (ev) => {
                        ev.currentTarget.disabled = true;
                        const args = editArgs();
                        const ok = await commit(args, { onSlotTaken: (err) => { ev.currentTarget.disabled = false; offerEmergency(args, err, close); } });
                        if (ok) { toast('Запись сохранена'); close(); } else ev.currentTarget.disabled = false;
                    },
                }, 'Готово'))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
    }

    // ---- подсказка со статусом ------------------------------------------
    let _tipEl = null;
    function hideTip() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } }
    function showTip(a, rect) {
        hideTip();
        if (_drag) return;
        const m = STATUS_META[a.status];
        const cx = apptCross(a);
        const line = (icon, text) => h('div', { class: 'row', style: { gap: '7px', fontSize: '12.5px', alignItems: 'baseline' } },
            h('span', { style: { color: 'var(--ink-400)', flex: '0 0 14px' } }, Icon(icon, { size: 12 })), h('span', null, text));
        _tipEl = h('div', { class: 'rcal-tip' },
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '6px' } },
                h('span', { style: { fontWeight: 700, fontSize: '12.5px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.patient),
                h('span', { class: 'rcal-tip-st', 'data-status': a.status },
                    h('span', { class: 'rcal-dot', style: { background: m.color } }), tr(m.label))),
            line('Clock', fmtHM(a.start) + '–' + fmtHM(a.start + a.dur) + ' · ' + trf('{n} мин', { n: a.dur })),
            a.service ? line('Doc', a.service) : null,
            a.doctorId ? line('Stethoscope', doctorName(a.doctorId)) : null,
            a.roomId ? line('Grid', roomName(a.roomId)) : null,
            a.phone ? line('Phone', a.phone) : null,
            state.period > 1 ? line('Calendar', ruDay(a.date)) : null,
            // Межфилиальное — в подсказке целиком и словами: на карточке для
            // этого места нет, а решение «звонить или не звонить» принимают
            // именно здесь.
            cx && cx.building && cx.building !== myLetter()
                ? line('Building', trf('Здание {b}', { b: buildingName(cx.building) })) : null,
            cx && cx.foreign && cx.as_of
                ? line('Clock', trf('данные на {t}', { t: hhmmOf(cx.as_of) })) : null,
            cx && cx.confirming
                ? line('Warning', trf('Ждём подтверждения здания {b}', { b: buildingName(cx.cross || cx.building) })) : null,
            cx && cx.collision && cx.collision.loses
                ? line('Warning', trf('Эта запись позже — время занято записью здания {b}. Позвоните пациенту.', { b: buildingName(cx.collision.building) })) : null,
            cx && cx.collision && !cx.collision.loses
                ? line('Warning', trf('Это же время заняли в здании {b}, но позже — приём остаётся за этим пациентом.', { b: buildingName(cx.collision.building) })) : null,
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } }, 'Клик — детали · тяни — перенести'));
        document.body.appendChild(_tipEl);
        const tw = 270;
        let left = rect.right + 8;
        if (left + tw > window.innerWidth - 8) left = rect.left - tw - 8;
        _tipEl.style.left = Math.max(8, left) + 'px';
        _tipEl.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - 220)) + 'px';
    }

    // ---- перетаскивание: перенос и растягивание -------------------------
    // Оба заканчиваются ОДНИМ вызовом calendar_book — тем же, что и «Готово» в
    // диалоге. Экран не решает, свободно ли: он показывает, куда тянут, и
    // спрашивает сервер, когда отпустили.
    let _drag = null;
    function startDrag(e, a, el, mode) {
        e.preventDefault(); e.stopPropagation();
        hideTip();
        const ppm = pxPerMin(state.step);
        const lanes = [...gridWrapEl.querySelectorAll('.rcal-lane')].map(L => ({ el: L, rect: L.getBoundingClientRect(), res: L.dataset.res, day: L.dataset.day }));
        _drag = {
            a, el, mode, ppm, lanes, startY: e.clientY, startX: e.clientX,
            origStart: a.start, origDur: a.dur, curStart: a.start, curDur: a.dur,
            curRes: (state.resType === 'doctor' ? a.doctorId : a.roomId), curDay: a.date, moved: false,
        };
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragUp);
    }
    function onDragMove(e) {
        const d = _drag; if (!d) return;
        if (!d.moved && Math.abs(e.clientY - d.startY) + Math.abs(e.clientX - d.startX) < 4) return;
        d.moved = true;
        d.el.classList.add('dragging');
        const dMin = Math.round((e.clientY - d.startY) / d.ppm / state.step) * state.step;
        if (d.mode === 'resize') {
            d.curDur = Math.max(state.step, Math.min(d.origDur + dMin, canvas.to - d.curStart));
            d.el.style.height = (d.curDur * d.ppm - 2) + 'px';
            return;
        }
        d.curStart = Math.max(canvas.from, Math.min(d.origStart + dMin, canvas.to - d.origDur));
        d.el.style.top = ((d.curStart - canvas.from) * d.ppm) + 'px';
        const lane = d.lanes.find(L => e.clientX >= L.rect.left && e.clientX < L.rect.right);
        if (lane && (lane.res !== String(d.curRes) || lane.day !== d.curDay)) {
            d.curRes = lane.res; d.curDay = lane.day;
            lane.el.appendChild(d.el);
        }
    }
    async function onDragUp() {
        const d = _drag; _drag = null;
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragUp);
        if (!d) return;
        d.el.classList.remove('dragging');
        if (!d.moved) { openApptModal(d.a); return; }

        const args = { visit_id: d.a.id };
        let done;
        if (d.mode === 'resize') {
            args.start = localIso(d.a.date, d.a.start);
            args.duration_minutes = d.curDur;
            done = () => toast(trf('Длительность: {n} мин', { n: d.curDur }));
        } else {
            args.start = localIso(d.curDay, d.curStart);
            const origRes = state.resType === 'doctor' ? d.a.doctorId : d.a.roomId;
            if (d.curRes != null && String(d.curRes) !== String(origRes)) {
                const val = d.curRes === UNASSIGNED_ID ? null : Number(d.curRes);
                if (state.resType === 'doctor') args.doctor_id = val; else args.room_id = val;
            }
            done = () => toast(trf('Перенесено: {day}, {time}', { day: ruDay(d.curDay), time: fmtHM(d.curStart) }));
        }
        const ok = await commit(args, { onSlotTaken: (err) => offerEmergency(args, err, () => reloadAndRepaint()) });
        if (ok) done();
        reloadAndRepaint();   // отказ — карточка возвращается на своё место
    }

    // ---- render ---------------------------------------------------------
    let railListEl, gridWrapEl, countEl, naprSelEl, dayLabelEl, dateInputEl, statsEl, branchSelEl;
    // Полотно, посчитанное под то, что реально надо показать.
    let canvas = { from: CANVAS_FROM, to: CANVAS_TO };

    function recomputeCanvas() {
        let from = CANVAS_FROM, to = CANVAS_TO;
        for (const byDay of Object.values(state.windows || {})) {
            for (const w of Object.values(byDay || {})) {
                if (!w) continue;
                from = Math.min(from, hhmmToMin(w.from));
                to = Math.max(to, hhmmToMin(w.to));
            }
        }
        // Запись за пределами холста раньше была просто не видна.
        for (const a of state.appts) {
            if (!state.showCancelled && a.status === 'cancelled') continue;
            from = Math.min(from, a.start);
            to = Math.max(to, a.start + a.dur);
        }
        canvas = { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(24 * 60, Math.ceil(to / 60) * 60) };
        if (canvas.to <= canvas.from) canvas = { from: CANVAS_FROM, to: CANVAS_TO };
    }

    function repaintRailList() {
        clear(railListEl);
        const list = filteredRail();
        if (countEl) countEl.textContent = String(state.selected.size);
        if (!list.length) { railListEl.appendChild(h('div', { class: 'muted', style: { padding: '16px', fontSize: '12.5px' } }, 'Ничего не найдено')); return; }
        for (const r of list) {
            const on = state.selected.has(r.id);
            railListEl.appendChild(h('label', { class: 'rcal-pick' + (on ? ' on' : '') },
                h('input', {
                    type: 'checkbox', checked: on ? true : null,
                    onchange: () => { if (state.selected.has(r.id)) state.selected.delete(r.id); else state.selected.add(r.id); repaintRailList(); reloadWindowsAndRepaint(); },
                }),
                h('span', { class: 'rcal-av', style: { background: avColor(r.id || r.name) } }, initials(r.name)),
                h('span', { class: 'rcal-pick-tx' },
                    h('span', { class: 'rcal-pick-nm' }, r.name),
                    h('span', { class: 'rcal-pick-sp' }, [r.spec, r.place].filter(Boolean).join(' · ')))));
        }
    }

    /**
     * ПЕРЕКЛЮЧАТЕЛЬ ЗДАНИЙ. Прячется, когда зданий одно: выпадающий список с
     * единственным пунктом — это не выбор, а лишний вопрос к оператору.
     */
    function refreshBranchOptions() {
        if (!branchSelEl) return;
        const list = buildings();
        clear(branchSelEl);
        branchSelEl.appendChild(h('option', { value: '' }, tr('Все здания')));
        for (const b of list) {
            branchSelEl.appendChild(h('option', {
                value: b.letter, selected: b.letter === state.branch ? true : null,
            }, b.name || b.letter));
        }
        branchSelEl.style.display = list.length > 1 ? '' : 'none';
    }

    function refreshNaprOptions() {
        if (!naprSelEl) return;
        const naprs = [...new Set(resources().map(r => r.napr).filter(Boolean))];
        clear(naprSelEl);
        naprSelEl.appendChild(h('option', { value: '' }, tr('Все направления')));
        for (const n of naprs) naprSelEl.appendChild(h('option', { value: n, selected: n === state.napr ? true : null }, n));
    }

    function mainLabel() {
        const s = isoToLocalDay(state.dayIso);
        if (state.period === 1) return ruDay(state.dayIso);
        const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + state.period - 1);
        return `${s.getDate()} ${RU_MO[s.getMonth()]} – ${e.getDate()} ${RU_MO[e.getMonth()]} ${e.getFullYear()}`;
    }
    function shiftDay(n) {
        const d = isoToLocalDay(state.dayIso); d.setDate(d.getDate() + n); state.dayIso = dateToIso(d);
        if (dateInputEl) dateInputEl.value = state.dayIso;
        if (dayLabelEl) dayLabelEl.textContent = mainLabel();
        reloadAndRepaint();
    }
    function colDays() {
        const s = isoToLocalDay(state.dayIso);
        return Array.from({ length: state.period }, (_, i) => dateToIso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i)));
    }

    function laneBody(res, dayIso, firstOfDay) {
        const ppm = pxPerMin(state.step);
        const laneH = (canvas.to - canvas.from) * ppm;
        const body = h('div', { class: 'rcal-lane' + (firstOfDay ? ' rcal-dayfirst' : ''), style: { height: laneH + 'px' } });
        body.dataset.res = res.id;
        body.dataset.day = dayIso;

        const win = windowFor(res, dayIso);
        for (let m = canvas.from; m < canvas.to; m += state.step) {
            const off = isOffHour(win, m);
            body.appendChild(h('div', {
                class: 'rcal-slot' + (off ? ' off' : '') + (m % 60 === 0 ? ' hr' : ''),
                // Минута клетки — на самой клетке. Дорожка уже подписана
                // ресурсом и днём (dataset выше); без минуты «куда именно
                // нажали» приходилось выводить из порядка клеток, а полотно
                // сетки раздвигается под окна и записи.
                'data-min': String(m),
                style: { height: (state.step * ppm) + 'px' },
                onclick: () => { if (off) { toast('Вне рабочих часов.', 'info'); return; } bookAt(res, dayIso, m); },
            }));
        }
        if (dayIso === todayIso()) {
            const nm = minutesOfLocal(new Date());
            if (nm >= canvas.from && nm <= canvas.to) body.appendChild(h('div', { class: 'rcal-now', style: { top: ((nm - canvas.from) * ppm) + 'px' } }));
        }

        const resKey = state.resType === 'doctor' ? 'doctorId' : 'roomId';
        const matchRes = (a) => res.id === UNASSIGNED_ID ? !a[resKey] : a[resKey] === res.id;
        const items = state.appts.filter(a => matchRes(a) && a.date === dayIso && inBranch(a)
            && (state.showCancelled || a.status !== 'cancelled'));
        for (const a of items) {
            const vs = Math.max(a.start, canvas.from), ve = Math.min(a.start + a.dur, canvas.to);
            if (ve <= vs) continue;
            const meta = STATUS_META[a.status];
            const cx = apptCross(a);
            const clash = cx && cx.collision && cx.collision.loses;
            const block = h('div', {
                class: 'rcal-appt' + (a.status === 'cancelled' ? ' rcal-appt-x' : '')
                    + (cx && cx.foreign ? ' rcal-appt-far' : '')
                    + (cx && cx.confirming ? ' rcal-appt-wait' : '')
                    + (clash ? ' rcal-appt-clash' : ''),
                'data-status': a.status,
                // Стили межфилиальных состояний ЗДЕСЬ, а не в admin.css: пунктир
                // «ждём подтверждения» и рамка «двойная запись» — свойства
                // ЭТОГО экрана и больше ничьи, а таблица стилей общая.
                style: Object.assign(
                    { top: ((vs - canvas.from) * ppm) + 'px', height: (Math.max((ve - vs) * ppm, 22) - 2) + 'px', borderLeft: `3px solid ${meta.color}` },
                    cx && cx.confirming ? { outline: '1px dashed var(--warn-500, #f59e0b)', outlineOffset: '-1px' } : {},
                    clash ? { outline: '2px solid var(--crit-500, #ef4444)', outlineOffset: '-2px' } : {},
                ),
            },
                h('div', { class: 'rcal-appt-t' },
                    `${fmtHM(a.start)}–${fmtHM(a.start + a.dur)}`,
                    // БУКВА ЗДАНИЯ — только у чужого. На своём она была бы
                    // одинаковой на всех карточках, то есть не информацией.
                    cx && cx.building && cx.building !== myLetter()
                        ? h('span', {
                            class: 'rcal-appt-bld', title: buildingName(cx.building),
                            style: { marginLeft: '5px', padding: '0 4px', borderRadius: '4px', fontWeight: 700, fontSize: '12.5px', background: 'var(--ink-100, #eef2f7)', color: 'var(--ink-600, #475569)' },
                        }, cx.building)
                        : null),
                h('div', { class: 'rcal-appt-p' }, a.patient),
                // Карточка — «пациент + врач», как просил владелец. Врач подписан
                // и на оси врачей: сетку читают наискось, и подпись под фамилией
                // пациента дешевле, чем возврат глазами к шапке колонки.
                a.doctorId ? h('div', { class: 'rcal-appt-d' }, doctorName(a.doctorId)) : null,
                a.service ? h('div', { class: 'rcal-appt-s' }, a.service) : null,
                // ВОЗРАСТ КАРТИНКИ — на самой карточке, а не в углу экрана: её
                // читают по одной, и «час назад так было» должно стоять рядом с
                // тем, о чём это сказано.
                cx && cx.foreign && cx.as_of
                    ? h('div', { class: 'rcal-appt-age', style: AGE_CSS }, trf('данные на {t}', { t: hhmmOf(cx.as_of) }))
                    : null,
                // «ПОДТВЕРЖДАЕТСЯ» С ВОЗРАСТОМ. Без возраста запись пятиминутной
                // давности и запись, висящая вторые сутки, выглядели одинаково —
                // а это разные новости: первая нормальна, вторая означает, что
                // там о пациенте не знают. Перешедшая порог читается ИНАЧЕ и
                // красным: это уже не «идёт обмен», а повод звонить.
                cx && cx.confirming
                    ? h('div', {
                        class: 'rcal-appt-age' + (cx.confirming_stale ? ' rcal-appt-late' : ''),
                        style: Object.assign({}, AGE_CSS, cx.confirming_stale
                            ? { color: 'var(--crit-700, #b91c1c)', fontWeight: 700 }
                            : { color: 'var(--warn-700, #b45309)' }),
                    }, cx.confirming_stale
                        ? trf('не подтверждено {age}', { age: ageText(cx.confirming_minutes) })
                        : (cx.confirming_minutes == null
                            ? tr('подтверждается')
                            : trf('подтверждается · {age}', { age: ageText(cx.confirming_minutes) })))
                    : null,
                // ЧУЖАЯ ЗАПИСЬ БЕЗ ВРАЧА. Её время НЕ ЗАНЯТО ни у кого — сказать
                // это на самой карточке дешевле, чем объяснять потом, почему
                // сетка показывала свободное время, куда уже едет пациент.
                cx && cx.unassigned
                    ? h('div', { class: 'rcal-appt-age rcal-appt-nodoc', style: Object.assign({}, AGE_CSS, { color: 'var(--crit-700, #b91c1c)', fontWeight: 700 }) },
                        tr('врач не определён — время не занято'))
                    : null,
                clash
                    ? h('div', { class: 'rcal-appt-age', style: Object.assign({}, AGE_CSS, { color: 'var(--crit-700, #b91c1c)', fontWeight: 700 }) }, tr('двойная запись'))
                    : null,
                h('div', { class: 'rcal-appt-rs', onmousedown: (e) => startDrag(e, a, block, 'resize') }));
            block.addEventListener('mousedown', (e) => { if (e.target.classList.contains('rcal-appt-rs')) return; startDrag(e, a, block, 'move'); });
            block.addEventListener('mouseenter', () => showTip(a, block.getBoundingClientRect()));
            block.addEventListener('mouseleave', hideTip);
            body.appendChild(block);
        }
        return body;
    }

    function repaintStats() {
        if (!statsEl) return;
        const a = state.appts || [];
        const by = (st) => a.filter(x => x.status === st).length;
        const cards = [
            ['Всего', a.filter(x => x.status !== 'cancelled').length, 'var(--ink-700, #334155)'],
            ...STATUS_ORDER.map(k => [STATUS_META[k].label, by(k), STATUS_META[k].color]),
        ];
        clear(statsEl);
        for (const [label, n, color] of cards) {
            statsEl.appendChild(h('div', { class: 'rcal-stat' },
                h('div', { class: 'rcal-stat-n', style: { color } }, String(n)),
                h('div', { class: 'rcal-stat-l' }, tr(label))));
        }
    }

    /**
     * ПОЛОСА ЧЕСТНОСТИ. Показывается ровно тогда, когда в сетке есть чужое
     * здание — своё её не заслуживает и не получает.
     *
     * Говорит две вещи, и обе обязаны быть сказаны здесь, а не в справке:
     * НАСКОЛЬКО СТАРА картинка каждого здания и ЧТО БУДЕТ, если внутри этого
     * часа слот займут и там. Второе — остаточный риск решения владельца
     * «видеть и записывать в любой»: он не устраняется, поэтому называется.
     */
    function farNote() {
        const mine = myLetter();
        const shown = (state.appts || []).filter(a => inBranch(a) && (state.showCancelled || a.status !== 'cancelled'));
        // Здание попадает в полосу не только когда его записи ВИДНЫ, но и когда
        // мы чего-то от него ЖДЁМ: неподтверждённая запись в чужой корпус —
        // наша карточка, чужих среди них может не быть ни одной, а сказать про
        // неё надо ровно то же самое.
        const seen = shown.filter(a => { const i = apptCross(a) || {}; return i.foreign || i.confirming; })
            .map(a => apptLetter(a));
        const picked = state.branch && mine && state.branch !== mine ? [state.branch] : [];
        const letters = [...new Set([...seen, ...picked])].filter(Boolean).filter(l => l !== mine);
        if (!letters.length) return null;
        const stamps = letters.map((l) => {
            const b = buildingByLetter(l);
            return b && b.as_of
                ? trf('{b} — данные на {t}', { b: buildingName(l), t: hhmmOf(b.as_of) })
                : trf('{b} — данных оттуда ещё не было', { b: buildingName(l) });
        }).join(' · ');
        // ДВЕ ТРЕВОГИ, КОТОРЫЕ ПОЛОСА ОБЯЗАНА ПОДНЯТЬ ОТДЕЛЬНО от возраста
        // картинки: они требуют не осторожности, а ДЕЙСТВИЯ — позвонить.
        const waiting = shown.filter(a => (apptCross(a) || {}).confirming_stale);
        const nodoc = shown.filter(a => (apptCross(a) || {}).unassigned);
        const alarms = [];
        if (waiting.length) {
            const oldest = waiting.reduce((m, a) => Math.max(m, apptCross(a).confirming_minutes || 0), 0);
            alarms.push(trf('{n} записей в чужие здания не подтверждены дольше {age} — там о них, возможно, не знают. Проверьте связь в «Синхронизации» или позвоните туда.',
                { n: waiting.length, age: ageText(oldest) }));
        }
        if (nodoc.length) {
            alarms.push(trf('{n} приехавших записей без врача: пациента ждут, но время у нас не занято ни у кого. Уточните врача в том здании, прежде чем записывать туда.',
                { n: nodoc.length }));
        }
        return h('div', { class: 'rcal-far-note', style: FAR_NOTE_CSS },
            h('div', { class: 'row', style: { gap: '7px', alignItems: 'center', fontWeight: 600 } },
                Icon('Building', { size: 14 }), h('span', null, stamps)),
            ...alarms.map(t => h('div', {
                class: 'rcal-far-alarm',
                style: { fontSize: '12.5px', marginTop: '5px', fontWeight: 600, color: 'var(--crit-700, #b91c1c)' },
            }, t)),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '4px' } },
                tr('Здания обмениваются раз в час: внутри этого часа тот же слот могут занять и там. Тогда первой считается более ранняя запись — видны обе, поздняя помечена «двойная запись», и звонить нужно её пациенту.')));
    }

    function repaintGrid() {
        recomputeCanvas();
        if (statsEl) repaintStats();
        hideTip();
        clear(gridWrapEl);
        if (state.failed.length) {
            gridWrapEl.appendChild(h('div', { class: 'rcal-fail' },
                Icon('Warning', { size: 15 }), ' ',
                trf('Не загрузилось: {what}. Обновите страницу — если не поможет, сообщите администратору.', { what: state.failed.join(', ') })));
            return;
        }
        // ЧУЖОЕ ЗДАНИЕ — СНАЧАЛА СЛОВАМИ. Полоса стоит НАД сеткой, потому что
        // читать сетку, не зная возраста её данных, опаснее, чем не читать вовсе.
        const note = farNote();
        if (note) gridWrapEl.appendChild(note);
        if (state.resType === 'room' && state.branch && myLetter() && state.branch !== myLetter()) {
            gridWrapEl.appendChild(h('div', { class: 'empty', style: { padding: '60px 20px' } },
                tr('Кабинеты — только своего здания: кабинет соседнего филиала в этой базе ничего не значит. Переключитесь на врачей.')));
            return;
        }
        const sel = resources().filter(r => state.selected.has(r.id));
        if (!sel.length) {
            gridWrapEl.appendChild(h('div', { class: 'empty', style: { padding: '60px 20px' } },
                state.resType === 'doctor' ? tr('Выберите врачей слева, чтобы увидеть расписание.') : tr('Выберите кабинеты слева, чтобы увидеть расписание.')));
            return;
        }
        const days = colDays();
        const ppm = pxPerMin(state.step), laneH = (canvas.to - canvas.from) * ppm;
        const cols = [];
        for (const dayIso of days) sel.forEach((res, ri) => cols.push({ res, dayIso, firstOfDay: ri === 0 && state.period > 1 }));
        const tmpl = `52px repeat(${cols.length}, minmax(150px, 1fr))`;
        const grid = h('div', { class: 'rcal-grid', style: { gridTemplateColumns: tmpl } });
        const head = h('div', { class: 'rcal-headrow', style: { gridTemplateColumns: tmpl } });
        head.appendChild(h('div', { class: 'rcal-corner' }));
        for (const c of cols) {
            const resKey = state.resType === 'doctor' ? 'doctorId' : 'roomId';
            const n = state.appts.filter(a => (c.res.id === UNASSIGNED_ID ? !a[resKey] : a[resKey] === c.res.id) && a.date === c.dayIso && (state.showCancelled || a.status !== 'cancelled')).length;
            head.appendChild(h('div', { class: 'rcal-colhead' + (c.firstOfDay ? ' rcal-dayfirst' : '') },
                state.period > 1 ? h('div', { class: 'rcal-colday' }, `${RU_WD_S[isoToLocalDay(c.dayIso).getDay()]} ${c.dayIso.slice(8)}.${c.dayIso.slice(5, 7)}`) : null,
                h('div', { class: 'rcal-colhead-in' },
                    h('span', { class: 'rcal-av', style: { background: avColor(c.res.id || c.res.name) } }, initials(c.res.name)),
                    h('div', { class: 'rcal-colhead-tx' },
                        h('div', { class: 'rcal-colnm' }, c.res.name),
                        h('div', { class: 'rcal-colsp' }, [c.res.spec, c.res.place].filter(Boolean).join(' · '))),
                    h('span', { class: 'rcal-colcnt', title: tr('Записей') }, String(n)))));
        }
        const bodyRow = h('div', { class: 'rcal-bodyrow', style: { gridTemplateColumns: tmpl } });
        const timeCol = h('div', { class: 'rcal-timecol', style: { height: laneH + 'px' } });
        for (let m = canvas.from; m <= canvas.to; m += 60) timeCol.appendChild(h('div', { class: 'rcal-tlabel', style: { top: ((m - canvas.from) * ppm) + 'px' } }, fmtHM(m)));
        bodyRow.appendChild(timeCol);
        for (const c of cols) bodyRow.appendChild(laneBody(c.res, c.dayIso, c.firstOfDay));
        grid.appendChild(head); grid.appendChild(bodyRow);
        gridWrapEl.appendChild(grid);
    }

    async function reloadAndRepaint() { await loadAppts(); await loadWindows(); refreshBranchOptions(); repaintGrid(); }
    async function reloadWindowsAndRepaint() { await loadWindows(); refreshBranchOptions(); repaintGrid(); }

    function buildShell() {
        clear(root);
        const setResType = (tp) => {
            if (state.resType === tp) return;
            state.resType = tp; state.napr = ''; state.q = '';
            segDocBtn.className = (tp === 'doctor' ? 'on' : '');
            segRoomBtn.className = (tp === 'room' ? 'on' : '');
            if (searchEl) { searchEl.value = ''; searchEl.placeholder = tp === 'doctor' ? tr('Поиск врача…') : tr('Поиск кабинета…'); }
            defaultSelect(); refreshNaprOptions(); repaintRailList(); reloadWindowsAndRepaint();
        };
        const segDocBtn = h('button', { class: state.resType === 'doctor' ? 'on' : '', onclick: () => setResType('doctor') }, Icon('Stethoscope', { size: 14 }), ' ', tr('Врачи'));
        const segRoomBtn = h('button', { class: state.resType === 'room' ? 'on' : '', onclick: () => setResType('room') }, Icon('Grid', { size: 14 }), ' ', tr('Кабинеты'));
        const seg = h('div', { class: 'segmented rcal-railseg' }, segDocBtn, segRoomBtn);
        naprSelEl = h('select', { class: 'rcal-sel', onchange: (e) => { state.napr = e.target.value; repaintRailList(); } });
        const searchEl = h('input', { class: 'rcal-search', type: 'search', placeholder: state.resType === 'doctor' ? tr('Поиск врача…') : tr('Поиск кабинета…'), oninput: (e) => { state.q = e.target.value; repaintRailList(); } });
        countEl = h('span', { class: 'rcal-cnt' }, '0');
        const acts = h('div', { class: 'rcal-acts' },
            h('button', { class: 'rcal-link', type: 'button', onclick: () => { for (const r of filteredRail()) state.selected.add(r.id); repaintRailList(); reloadWindowsAndRepaint(); } }, 'Выбрать все'),
            h('button', { class: 'rcal-link', type: 'button', onclick: () => { state.selected.clear(); repaintRailList(); repaintGrid(); } }, 'Очистить'),
            countEl);
        railListEl = h('div', { class: 'rcal-list' });
        const rail = h('div', { class: 'rcal-rail' }, seg, naprSelEl, h('div', { class: 'rcal-search-w' }, Icon('Search', { size: 14 }), searchEl), acts, railListEl);

        dateInputEl = h('input', { type: 'date', class: 'rcal-date', value: state.dayIso, onchange: (e) => { if (e.target.value) { state.dayIso = e.target.value; dayLabelEl.textContent = mainLabel(); reloadAndRepaint(); } } });
        dayLabelEl = h('span', { class: 'rcal-daylabel' }, mainLabel());
        const periodSeg = h('div', { class: 'segmented rcal-period' }, ...[[1, 'День'], [2, '2 дня'], [3, '3 дня'], [7, 'Неделя']].map(([n, l]) =>
            h('button', {
                class: state.period === n ? 'on' : '',
                onclick: (e) => { state.period = n; dayLabelEl.textContent = mainLabel(); for (const b of e.currentTarget.parentElement.children) b.classList.remove('on'); e.currentTarget.classList.add('on'); reloadAndRepaint(); },
            }, tr(l))));
        branchSelEl = h('select', {
            class: 'rcal-sel', title: tr('Здание'),
            onchange: (e) => {
                state.branch = e.target.value;
                // Выбор здания меняет и рейку (врачи того здания), поэтому
                // отметки набираются заново — держать выбранными врачей,
                // которых больше не видно, значит рисовать пустые дорожки.
                defaultSelect(); repaintRailList(); reloadWindowsAndRepaint();
            },
        });
        const stepSel = h('select', { class: 'rcal-sel', onchange: (e) => { state.step = Number(e.target.value); repaintGrid(); } },
            ...[[10, 'Шаг 10 мин'], [15, 'Шаг 15 мин'], [30, 'Шаг 30 мин']].map(([v, l]) => h('option', { value: v, selected: v === state.step ? true : null }, tr(l))));
        const cancelChk = h('label', { class: 'rcal-chk' }, h('input', { type: 'checkbox', onchange: (e) => { state.showCancelled = e.target.checked; repaintGrid(); } }), ' ', tr('Отменённые'));
        const toolbar = h('div', { class: 'rcal-toolbar' },
            h('div', { class: 'rcal-nav' },
                h('button', { class: 'btn btn-outline btn-sm', title: tr('Назад'), onclick: () => shiftDay(-state.period) }, Icon('ChevronLeft', { size: 15 })),
                h('button', { class: 'btn btn-outline btn-sm', onclick: () => { state.dayIso = todayIso(); dateInputEl.value = state.dayIso; dayLabelEl.textContent = mainLabel(); reloadAndRepaint(); } }, 'Сегодня'),
                h('button', { class: 'btn btn-outline btn-sm', title: tr('Вперёд'), onclick: () => shiftDay(state.period) }, Icon('ChevronRight', { size: 15 })),
                dateInputEl, dayLabelEl),
            h('div', { class: 'rcal-tools' }, branchSelEl, periodSeg, stepSel, cancelChk));
        const legend = h('div', { class: 'rcal-legend' },
            ...STATUS_ORDER.map(k => h('span', { class: 'rcal-leg' }, h('span', { class: 'rcal-dot', style: { background: STATUS_META[k].color } }), tr(STATUS_META[k].label))),
            h('span', { class: 'rcal-leg' }, h('span', { class: 'rcal-leg-off' }), tr('вне приёма')));
        gridWrapEl = h('div', { class: 'rcal-gridwrap' });
        statsEl = h('div', { class: 'rcal-stats' });
        const main = h('div', { class: 'rcal-main' }, toolbar, statsEl, legend, gridWrapEl);

        root.appendChild(h('div', { class: 'rcal-page' }, rail, main));
        refreshBranchOptions();
        refreshNaprOptions();
        repaintRailList();
        repaintGrid();
    }

    root.appendChild(h('div', { class: 'empty', style: { padding: '50px' } }, 'Загрузка…'));
    await loadResources();
    defaultSelect();
    await loadAppts();
    await loadWindows();
    state.loaded = true;
    buildShell();
}
