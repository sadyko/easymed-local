// BOOKING_DAY_V1 (2026-11-13) — вкладка «Бронирование» раздела «Пациенты»:
// день ОДНОГО врача.
//
// Владелец (снимок полосы «Список · Очередь · Записи»): «add Бронирование
// section also, it should have filters and random date should be today, and
// search place for doctor, and if doctor chosen, down place it should show
// consultation times and list of patient».
//
// Что на экране:
//   • строка фильтров — дата (по умолчанию СЕГОДНЯ, стрелки ‹ › и «Сегодня»),
//     специальность (сужает поиск врача), поиск врача и вид консультации
//     (задаёт длительность — как в окне записи);
//   • выбран врач — ниже его день: окно приёма и перерывы и «Расписание»
//     (BOOKING_DAY_V2): строка на каждое время — слева время, справа пациент
//     (имя открывает карту, статус) или «Свободно» с «Записать» — поиск
//     пациента прямо в строке или «Новый пациент», запись — calendar_book.
//
// ВСЁ ВРЕМЯ СЧИТАЕТ СЕРВЕР: calendar_slots через ОБЩИЙ клиент слотов (loadSlotDay), как у окна записи и
// календаря «Записи» (SLOT_PACK_V1: начала вплотную, сегодня — не раньше
// «сейчас»). Своей сетки здесь нет, поэтому «свободно» на этом экране и
// «свободно» в окне записи — одно и то же. calendar_slots закрыт ролями записи
// (BOOK_ROLES), поэтому вкладку видят те же, кому открыты «Записи»
// (patients-hub.js TAB_ROUTE).
import { h, Icon, clear, toast } from '../ui.js';
import { tr, trf } from '../i18n.js';
import { supabase } from '../../supabase.js';
import { loadPatientById } from '../data.js';
// BOOKING_DAY_V2 — запись идёт той же дверью, что у окна записи и календаря
// (visit-booking.js → calendar_book), поиск пациента — тот же, что у окна
// заведения карты (patient-create-modal.js).
import { bookVisit, setVisitStatus } from './visit-booking.js';   // BOOKING_DAY_CANCEL_V1 — отмена той же дверью
import { loadSlotDay, forgetSlots } from './service-picker-modal.js?v=ownrep4';   // один клиент слотов на продукт
import { consultMinutes } from '../../shared/consultation-price.js';   // длительность вида консультации — то же правило, что у сервера
import { runPatientSearch, openPatientCreateModal } from './patient-create-modal.js?v=onewin1';
import { grantAllows, canAddVisitLines } from '../permissions.js';

// Пять статусов визита — как в календаре «Записи» (room-calendar.js STATUS_META);
// время занимают только первые три (BUSY_STATUSES на сервере), они и приходят.
export const STATUS_META = {
    scheduled: { label: 'Записан', kind: 'scheduled' },
    confirmed: { label: 'Подтверждён', kind: 'confirmed' },
    arrived: { label: 'Пришёл', kind: 'arrived' },
};
const STATUS_ORDER = ['scheduled', 'confirmed', 'arrived'];

const pad2 = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' по местному времени. */
export function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function shiftDay(dayIso, delta) {
    const [y, m, d] = String(dayIso).split('-').map(Number);
    return ymd(new Date(y, m - 1, d + delta));
}
const toMin = (hhmm) => { const [a, b] = String(hhmm || '').split(':').map(Number); return (a || 0) * 60 + (b || 0); };

/** Врач ли это — то же правило, что у календаря «Записи» (room-calendar.js). */
export function isDoctorLike(u) {
    return u.is_doctor === true || u.is_doctor === 1 || String(u.role || '').toLowerCase() === 'doctor' || !!String(u.specialty || '').trim();
}

/**
 * Лента дня: свободные начала и занятые приёмы одним списком по времени.
 * Чистая функция — ради теста.
 */
export function dayTimeline(day) {
    if (!day) return [];
    const free = (day.slots || []).map((s) => ({ kind: 'free', from: s.start, to: s.end, at: toMin(s.start), start_iso: s.start_iso }));
    const busy = (day.busy || []).map((b) => ({
        kind: 'busy', from: b.from, to: b.to, at: b.from_min != null ? b.from_min : toMin(b.from),
        patient_id: b.patient_id, patient_name: b.patient_name || '', status: b.status, visit_id: b.visit_id,
    }));
    return free.concat(busy).sort((x, y) => x.at - y.at || (x.kind === 'busy' ? -1 : 1));
}

/** BOOKING_DAY_SERVICE_V1 — длительность услуги: своя, иначе 30 (как serviceDurationMinutes на сервере). */
export function serviceMinutes(sv) { const n = Math.round(Number(sv && sv.duration_minutes)); return Number.isFinite(n) && n > 0 ? n : 30; }
/** users.service_rates — массив или его JSON-строка. */
export function parseRates(v) {
    if (Array.isArray(v)) return v;
    try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch (_) { return []; }
}

/** «13.11.2026» из 'YYYY-MM-DD'. */
export function dmy(dayIso) { const [y, m, d] = String(dayIso || '').split('-'); return d && m && y ? d + '.' + m + '.' + y : String(dayIso || ''); }

// BOOKING_DAY_V2 — «Записать» видит тот, кому «Записи» открыты на изменение
// (patients.calendar: edit — «Записывает, переносит и отменяет записи»).
// Сервер всё равно проверяет роль сам (calendar_book, BOOK_ROLES).
export function canBook() { return grantAllows('patients.calendar', 'edit'); }

/**
 * Вкладка «Бронирование». ctx — { onNavigate }.
 * deps.today — подмена «сегодня» тестами.
 */
export async function renderBookingDay(host, ctx = {}, deps = {}) {
    clear(host);
    const state = {
        date: deps.today || ymd(new Date()),
        specialty: '',
        doctorId: null,
        choice: '',          // BOOKING_DAY_SERVICE_V1 — 'svc:<id>' | 'ct:<id>' | '' (без услуги)
        services: [],
        statusFilter: 'all',
        doctors: [], types: [],
        day: null, loading: false, error: '',
        bookingAt: null, booking: false,   // BOOKING_DAY_V2 — открытая строка записи
        mrn: new Map(), svc: new Map(),    // BOOKING_DAY_DETAIL_V1 — номер карты по пациенту, услуги по визиту
    };
    let reqToken = 0;

    const root = h('div', { class: 'bkd', 'data-booking-day': '' });
    host.appendChild(root);

    // ── фильтры ──────────────────────────────────────────────────────────
    const dateInp = h('input', { type: 'date', class: 'bkd-date', value: state.date, 'aria-label': tr('Дата'),
        onchange: () => { if (dateInp.value) { state.date = dateInp.value; paintDateBtns(); loadDay(); } } });
    const todayBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-bkd-today': '',
        onclick: () => setDate(deps.today || ymd(new Date())) }, tr('Сегодня'));
    const prevBtn = h('button', { class: 'icon-btn btn-sm', type: 'button', title: tr('Предыдущий день'), 'aria-label': tr('Предыдущий день'),
        onclick: () => setDate(shiftDay(state.date, -1)) }, Icon('ChevronLeft', { size: 14 }));
    const nextBtn = h('button', { class: 'icon-btn btn-sm', type: 'button', title: tr('Следующий день'), 'aria-label': tr('Следующий день'),
        onclick: () => setDate(shiftDay(state.date, 1)) }, Icon('ChevronRight', { size: 14 }));
    function setDate(v) { state.bookingAt = null; state.date = v; dateInp.value = v; paintDateBtns(); loadDay(); }
    function paintDateBtns() { todayBtn.classList.toggle('is-today', state.date === (deps.today || ymd(new Date()))); }

    const specSel = h('select', { 'aria-label': tr('Специальность'), 'data-bkd-spec': '',
        onchange: () => { state.specialty = specSel.value; paintDoctorList(); } });
    // BOOKING_DAY_SERVICE_V1 (2026-11-13, владелец со снимком пустого «Вид
    // консультации»: «why services of doctor is not coming, if there is one it
    // should come randomly»). Видов консультаций у клиники может не быть вовсе
    // (так и есть на снимке), а услуги у врача есть — его users.service_rates.
    // Поэтому список — «Услуга»: сначала услуги ЭТОГО врача, затем виды
    // консультаций («Без услуги» снят — BOOKING_DAY_SERVICE_REQUIRED_V1); при выборе врача сразу стоит
    // первая его услуга. Длительность слота — длительность услуги (у сервера то
    // же правило: своя длительность, иначе 30), а запись уносит услугу строкой
    // визита (calendar_book line) — в окне услуг она встанет «из записи».
    const typeSel = h('select', { 'aria-label': tr('Услуга'), 'data-bkd-type': '',
        onchange: () => { state.choice = typeSel.value; state.bookingAt = null; loadDay(); } });

    // Поиск врача: поле и выпадающий список совпадений.
    const docInp = h('input', { type: 'search', class: 'bkd-doc-input', autocomplete: 'off', 'data-bkd-doctor': '',
        placeholder: tr('Поиск врача по ФИО или специальности…'),
        oninput: () => { paintDoctorList(); docList.hidden = false; },
        onfocus: () => { paintDoctorList(); docList.hidden = false; },
        onkeydown: (e) => {
            if (e.key === 'Escape') { docList.hidden = true; return; }
            if (e.key === 'Enter') { const first = matchingDoctors()[0]; if (first) { e.preventDefault(); pickDoctor(first); } }
        },
    });
    const docList = h('div', { class: 'bkd-doc-list', hidden: true, role: 'listbox' });
    const docWrap = h('div', { class: 'bkd-doc',
        onfocusout: (e) => { if (!e.relatedTarget || !docWrap.contains(e.relatedTarget)) docList.hidden = true; } },
    h('span', { class: 'bkd-doc-ic' }, Icon('Search', { size: 14 })), docInp, docList);

    const lbl = (text, el) => h('label', { class: 'bkd-f' }, h('span', { class: 'bkd-f-l' }, tr(text)), el);
    root.appendChild(h('div', { class: 'card bkd-filters' },
        lbl('Дата', h('div', { class: 'bkd-date-row' }, prevBtn, dateInp, nextBtn, todayBtn)),
        lbl('Специальность', specSel),
        h('div', { class: 'bkd-f bkd-f-doc' }, h('span', { class: 'bkd-f-l' }, tr('Врач')), docWrap),
        lbl('Услуга', typeSel)));

    const body = h('div', { class: 'bkd-body' });
    root.appendChild(body);

    // ── данные справочников ──────────────────────────────────────────────
    try {
        const [users, types, services] = await Promise.all([
            supabase.from('users').select('id, full_name, specialty, role, is_doctor, service_rates').eq('active', true).order('full_name', { ascending: true }),
            supabase.from('consultation_types').select('id, name, price, active, duration_minutes').eq('active', true).order('name', { ascending: true }),
            supabase.from('services').select('id, name, duration_minutes, price, active').eq('active', true).order('name', { ascending: true }),
        ]);
        state.doctors = ((users && users.data) || []).filter(isDoctorLike);
        state.types = (types && types.data) || [];
        state.services = (services && services.data) || [];
    } catch (e) { state.error = (e && e.message) || String(e); }

    const specs = [...new Set(state.doctors.map((d) => String(d.specialty || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    for (const o of [h('option', { value: '' }, tr('Все специальности')), ...specs.map((sp) => h('option', { value: sp }, sp))]) specSel.appendChild(o);
    paintServiceSelect();

    /** Услуги врача — id из его списка ставок (users.service_rates), только действующие услуги каталога. */
    function doctorServices(doc) {
        const ids = new Set(parseRates(doc && doc.service_rates).map((r) => String(r && r.service_id)));
        return state.services.filter((sv) => ids.has(String(sv.id)));
    }
    function paintServiceSelect() {
        clear(typeSel);
        const doc = state.doctors.find((d) => d.id === state.doctorId) || null;
        const mine = doc ? doctorServices(doc) : [];
        const opt = (value, label) => h('option', { value, selected: state.choice === value }, label);
        for (const sv of mine) typeSel.appendChild(opt('svc:' + sv.id, sv.name + ' · ' + trf('{n} мин', { n: serviceMinutes(sv) })));
        for (const t of state.types) typeSel.appendChild(opt('ct:' + t.id, t.name + ' · ' + trf('{n} мин', { n: consultMinutes(t) })));
        // BOOKING_DAY_SERVICE_REQUIRED_V1 (2026-11-13, владелец: «if there is no
        // service no booking should happen»). «Без услуги» больше нет: запись
        // всегда несёт услугу. Нет у врача ни услуг, ни видов консультаций —
        // список говорит это, а «Записать» не открывается (scheduleRow, book).
        if (!typeSel.children.length) {
            typeSel.appendChild(h('option', { value: '' }, doc ? tr('У врача нет услуг') : tr('Сначала выберите врача')));
            typeSel.disabled = true;
        } else typeSel.disabled = false;
        typeSel.value = state.choice;
    }

    function matchingDoctors() {
        const q = docInp.value.trim().toLowerCase();
        return state.doctors.filter((d) => (!state.specialty || String(d.specialty || '').trim() === state.specialty)
            && (!q || String(d.full_name || '').toLowerCase().includes(q) || String(d.specialty || '').toLowerCase().includes(q)));
    }
    function paintDoctorList() {
        clear(docList);
        const list = matchingDoctors().slice(0, 30);
        if (!list.length) { docList.appendChild(h('div', { class: 'bkd-doc-empty' }, tr('Врач не найден'))); return; }
        for (const d of list) {
            docList.appendChild(h('button', { type: 'button', class: 'bkd-doc-opt' + (d.id === state.doctorId ? ' on' : ''), role: 'option',
                'data-bkd-doctor-opt': String(d.id), onclick: () => pickDoctor(d) },
            h('span', { class: 'bkd-doc-nm' }, d.full_name || '—'),
            d.specialty ? h('span', { class: 'bkd-doc-sp' }, d.specialty) : null));
        }
    }
    function pickDoctor(d) {
        state.doctorId = d.id;
        // BOOKING_DAY_SERVICE_V1 — у врача есть услуги: первая выбрана сразу.
        const mine = doctorServices(d);
        state.choice = mine.length ? 'svc:' + mine[0].id : (state.types.length ? 'ct:' + state.types[0].id : '');
        paintServiceSelect();
        state.statusFilter = 'all';
        state.bookingAt = null;
        docInp.value = d.full_name || '';
        docList.hidden = true;
        loadDay();
    }

    // ── день врача ───────────────────────────────────────────────────────
    // Длительность приёма: вид консультации — его длительность (consultMinutes,
    // по умолчанию 30, как у сервера), без вида — 30.
    function durationMin() {
        const [kind, id] = String(state.choice || '').split(':');
        if (kind === 'svc') return serviceMinutes(state.services.find((x) => String(x.id) === id) || {});
        if (kind === 'ct') return consultMinutes(state.types.find((x) => String(x.id) === id) || {});
        return 30;
    }
    async function loadDay() {
        if (!state.doctorId) { paintBody(); return; }
        const my = ++reqToken;
        state.loading = true; state.error = ''; paintBody();
        // Свободное время спрашивает ОДИН клиент слотов на весь продукт
        // (service-picker-modal.js loadSlotDay — страж booking-doors.test.mjs).
        // Его кэш сбрасываем: экран открыт часами, а записи делают и другие.
        forgetSlots();
        let day = null;
        try { day = await loadSlotDay(state.doctorId, state.date, durationMin()); } catch (_) { day = null; }
        if (my !== reqToken) return;   // за время запроса сменили врача или дату
        state.loading = false;
        if (!day) { state.day = null; state.error = tr('Не удалось загрузить расписание.'); }
        else state.day = day;
        paintBody();
        if (day) loadDetails(day, my);
    }

    function paintBody() {
        clear(body);
        if (state.error && !state.day) {
            body.appendChild(h('div', { class: 'card empty bkd-empty' }, Icon('Warning', { size: 22 }), h('div', null, state.error)));
            return;
        }
        if (!state.doctorId) {
            body.appendChild(h('div', { class: 'card empty bkd-empty', 'data-bkd-hint': '' }, Icon('Stethoscope', { size: 26 }),
                h('div', null, tr('Выберите врача — ниже появятся время приёма и список пациентов на выбранный день.'))));
            return;
        }
        if (state.loading || !state.day) { body.appendChild(h('div', { class: 'card empty bkd-empty' }, tr('Загружаем расписание…'))); return; }
        const day = state.day;
        const doc = state.doctors.find((d) => d.id === state.doctorId) || {};
        const timeline = dayTimeline(day);
        const busy = timeline.filter((t) => t.kind === 'busy');
        const freeCount = timeline.length - busy.length;

        // Сводка дня врача.
        const win = day.window;
        const winText = win
            ? trf('Приём {from}–{to}', { from: win.from, to: win.to }) + ((win.breaks || []).length
                ? ' · ' + tr('перерыв') + ' ' + win.breaks.map((b) => `${b.from}–${b.to}`).join(', ') : '')
            : tr('В этот день врач не принимает');
        body.appendChild(h('div', { class: 'card bkd-head', 'data-bkd-head': '' },
            h('div', { class: 'bkd-head-who' },
                h('div', { class: 'bkd-head-nm' }, doc.full_name || (day.resource && day.resource.name) || '—'),
                h('div', { class: 'bkd-head-sub' }, [doc.specialty, winText].filter(Boolean).join(' · '))),
            h('div', { class: 'bkd-kpis' },
                h('div', { class: 'bkd-kpi is-free' }, h('b', null, String(freeCount)), h('span', null, tr('свободно'))),
                h('div', { class: 'bkd-kpi' }, h('b', null, String(busy.length)), h('span', null, tr('записано'))),
                h('div', { class: 'bkd-kpi' }, h('b', null, trf('{n} мин', { n: day.duration_minutes || 30 })), h('span', null, tr('приём'))))));

        // BOOKING_DAY_V2 (2026-11-13, владелец со снимком сетки времени: «no need
        // this one, just left side is time and right side is patients and make it
        // possibe to chose time and make booking too for registrars»). Одна
        // карточка «Расписание»: строка на каждое время дня — слева время,
        // справа пациент (имя — в карту, статус) или «Свободно» с кнопкой
        // «Записать». Записать — найти пациента в строке (или «Новый пациент») —
        // запись создаёт bookVisit (calendar_book: та же проверка занятости,
        // тот же вопрос про экстренную запись и визит дня, что у окна записи).
        const counts = Object.fromEntries(STATUS_ORDER.map((st) => [st, busy.filter((x) => x.status === st).length]));
        const chip = (id, label, n) => h('button', { type: 'button', class: 'bkd-chip' + (state.statusFilter === id ? ' on' : ''), 'data-bkd-status': id,
            onclick: () => { state.statusFilter = id; state.bookingAt = null; paintBody(); } }, tr(label), h('b', null, String(n)));
        const rows = timeline.filter((t) => state.statusFilter === 'all'
            || (state.statusFilter === 'free' ? t.kind === 'free' : t.kind === 'busy' && t.status === state.statusFilter));
        // BOOKING_DAY_SERVICE_REQUIRED_V1 — у врача нет услуг: записывать не на что.
        if (!state.choice && canBook()) {
            body.appendChild(h('div', { class: 'bkd-noservice', 'data-bkd-noservice': '' }, Icon('Warning', { size: 15 }),
                h('span', null, tr('У врача нет услуг — записать к нему нельзя. Добавьте услуги, которые он выполняет, в карточке сотрудника.'))));
        }
        const card = h('div', { class: 'card bkd-card', 'data-bkd-schedule': '' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Clock', { size: 16 }), ' ', tr('Расписание')),
                h('div', { class: 'bkd-chips' },
                    chip('all', 'Все', timeline.length),
                    chip('free', 'Свободно', freeCount),
                    ...STATUS_ORDER.map((st) => chip(st, STATUS_META[st].label, counts[st])))));
        if (!timeline.length) {
            card.appendChild(h('div', { class: 'empty bkd-card-empty' },
                win ? (day.min_start === '24:00' ? tr('Сегодня приём уже закончился.') : tr('Свободного времени нет.')) : tr('В этот день врач не принимает.')));
        } else if (!rows.length) {
            card.appendChild(h('div', { class: 'empty bkd-card-empty' }, tr('Нет строк с таким статусом.')));
        } else {
            card.appendChild(h('div', { class: 'bkd-sched' }, ...rows.map((t) => scheduleRow(t))));
        }
        body.appendChild(card);
    }

    function scheduleRow(t) {
        const time = h('div', { class: 'bkd-sched-time' }, h('b', null, t.from), h('span', null, t.to));
        if (t.kind === 'busy') {
            // BOOKING_DAY_DETAIL_V1 (2026-11-13, владелец: «make it more detailed, id
            // of patient and name of service too») — у записи видны номер карты
            // пациента и услуги визита (или вид консультации).
            const mrn = t.patient_id != null ? state.mrn.get(String(t.patient_id)) : '';
            const svcs = t.visit_id != null ? state.svc.get(String(t.visit_id)) : null;
            // BOOKING_DAY_TO_WIZARD_V1 — «when you press it, it should come to service
            // added place as service added and continue process». Строка СЕГОДНЯШНЕЙ
            // записи открывает окно услуг («Услуги и пациент → Подтверждение»): оно
            // само берёт запись дня пациента и ставит её услуги в смету «из записи»
            // (visit-wizard.js prefillFromBooking, CRM_LINK_ALL_V1), дальше — обычное
            // оформление. Только сегодня: окно оформляет визит дня, и запись на
            // другой день в сегодняшний счёт попасть не должна. Имя — по-прежнему карта.
            const today = state.date === (deps.today || ymd(new Date()));
            const can = today && !!t.patient_id && canAddVisitLines();
            const go = () => openWizard(t);
            return h('div', {
                class: 'bkd-sched-row is-busy' + (can ? ' is-actionable' : ''), 'data-bkd-row': String(t.visit_id || ''), 'data-bkd-busy': t.from,
                ...(can ? {
                    role: 'button', tabindex: '0', 'data-bkd-wizard': String(t.visit_id || ''), title: tr('Оформить: услуги, счёт, очередь'),
                    onclick: go,
                    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { if (e.preventDefault) e.preventDefault(); go(); } },
                } : { title: today ? '' : tr('Оформить запись можно в её день') }),
            }, time,
                h('div', { class: 'bkd-sched-who' },
                    h('div', { class: 'bkd-who-main' },
                        h('div', { class: 'bkd-who-line' },
                            t.patient_id
                                ? h('button', { type: 'button', class: 'link-btn bkd-pt', 'data-bkd-open': String(t.patient_id), title: tr('Открыть карту пациента'),
                                    onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); openCard(t.patient_id); } }, t.patient_name || '—')
                                : h('span', { class: 'bkd-pt' }, t.patient_name || '—'),
                            mrn ? h('span', { class: 'bkd-mrn', 'data-bkd-mrn': mrn }, mrn) : null),
                        svcs && svcs.length
                            ? h('div', { class: 'bkd-svc', 'data-bkd-svc': '' }, Icon('Stethoscope', { size: 12 }), ' ', svcs.join(', '))
                            : null),
                    h('span', { class: 'bkd-st is-' + (STATUS_META[t.status] ? t.status : 'scheduled') },
                        tr((STATUS_META[t.status] || { label: t.status || '—' }).label)),
                    // BOOKING_DAY_CANCEL_V1 (2026-11-13, владелец со снимком строк записей:
                    // «add at the end remove button too») — «Отменить запись» в конце
                    // строки: только у «Записан» и «Подтверждён» (пришедшего уже
                    // обслуживают) и только тому, кто вправе менять записи. Нажатие
                    // не открывает окно услуг — у кнопки своё действие.
                    canBook() && ['scheduled', 'confirmed'].includes(String(t.status || '')) && t.visit_id
                        ? h('button', { type: 'button', class: 'bkd-cancel', 'data-bkd-cancel': String(t.visit_id),
                            title: tr('Отменить запись'), 'aria-label': tr('Отменить запись'),
                            onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); cancelBooking(t); },
                            onkeydown: (e) => { if (e && e.stopPropagation) e.stopPropagation(); } },
                        Icon('Trash', { size: 14 }))
                        : null,
                    can ? h('span', { class: 'bkd-go', 'aria-hidden': 'true' }, Icon('ChevronRight', { size: 15 })) : null));
        }
        const open = state.bookingAt === t.from;
        // BOOKING_DAY_ROW_CLICK_V1 (2026-11-13, владелец со снимком строк
        // «Свободно … [+ Записать]»: «can you not to add book button at the end,
        // make just itself pressable»). Кнопки в конце нет: нажимается сама
        // свободная строка (мышью, Enter или пробелом) — открывает и закрывает
        // поиск пациента под ней. Роли без права записи строка не нажимается.
        const may = canBook() && !!state.choice;   // BOOKING_DAY_SERVICE_REQUIRED_V1 — без услуги не записываем
        const toggle = () => { state.bookingAt = open ? null : t.from; paintBody(); };
        const row = h('div', {
            class: 'bkd-sched-row is-free' + (open ? ' is-open' : '') + (may ? ' is-bookable' : ''), 'data-bkd-free': t.from,
            ...(may ? {
                role: 'button', tabindex: '0', 'data-bkd-book': t.from, 'aria-expanded': open ? 'true' : 'false',
                title: open ? tr('Закрыть') : tr('Записать на это время'),
                onclick: toggle,
                onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { if (e.preventDefault) e.preventDefault(); toggle(); } },
            } : {}),
        }, time,
            h('div', { class: 'bkd-sched-who' }, h('span', { class: 'bkd-free-l' }, tr('Свободно')),
                may ? h('span', { class: 'bkd-free-plus', 'aria-hidden': 'true' }, Icon(open ? 'X' : 'Plus', { size: 15 })) : null));
        if (!open) return row;
        return h('div', { class: 'bkd-sched-group' }, row, bookingPanel(t));
    }

    // Запись в свободное время: поиск пациента прямо в строке; «Новый пациент»
    // — обычное окно заведения карты, после сохранения карта записывается сюда же.
    function bookingPanel(t) {
        const results = h('div', { class: 'mg-search-results bkd-book-results', style: { display: 'none' } });
        let timer = 0;
        const input = h('input', { type: 'search', class: 'bkd-book-input', autocomplete: 'off', 'data-bkd-book-search': '',
            placeholder: tr('Пациент: ФИО, телефон или номер карты…'),
            oninput: () => { clearTimeout(timer); timer = setTimeout(() => runPatientSearch(input.value, results, (p) => book(t, p)), 250); } });
        setTimeout(() => { try { input.focus(); } catch (_) { /* не в документе */ } }, 0);
        return h('div', { class: 'bkd-book', 'data-bkd-book-panel': t.from },
            h('div', { class: 'bkd-book-row' },
                h('div', { class: 'bkd-book-search' }, h('span', { class: 'bkd-doc-ic' }, Icon('Search', { size: 14 })), input, results),
                h('button', { type: 'button', class: 'btn btn-sm btn-outline', 'data-bkd-new-patient': '',
                    onclick: () => openPatientCreateModal({ onNavigate: ctx.onNavigate, onSaved: (p) => { if (p && p.id) book(t, p); } }) },
                Icon('Plus', { size: 13 }), ' ', tr('Новый пациент'))),
            h('div', { class: 'bkd-book-hint' }, trf('Запись к врачу на {date} в {time}', { date: dmy(state.date), time: t.from + '–' + t.to })));
    }

    async function book(t, patient) {
        if (state.booking || !state.choice) return;   // BOOKING_DAY_SERVICE_REQUIRED_V1
        state.booking = true;
        try {
            const args = { patient_id: patient.id, doctor_id: state.doctorId, start: t.start_iso, status: 'scheduled' };
            if (state.day && state.day.duration_minutes) args.duration_minutes = state.day.duration_minutes;
            // BOOKING_DAY_SERVICE_V1 — услуга записи строкой визита (одной транзакцией с визитом).
            const [kind, id] = String(state.choice || '').split(':');
            if (kind === 'svc') { args.service_id = Number(id); args.line = { service_id: Number(id) }; }
            if (kind === 'ct') { args.consultation_type_id = Number(id); args.line = { consultation_type_id: Number(id) }; }
            const res = await (deps.bookVisit || bookVisit)(args);
            if (!res) { state.booking = false; return; }   // отказался от экстренной записи — ничего не создано
            const name = [patient.last_name, patient.first_name].filter(Boolean).join(' ') || patient.full_name || '';
            toast(trf('Записан: {name}, {time}', { name, time: t.from }), 'ok');
            state.bookingAt = null;
        } catch (e) {
            toast((e && e.message) || tr('Не удалось записать.'), 'fail');
        } finally {
            state.booking = false;
        }
        await loadDay();
    }

    // BOOKING_DAY_DETAIL_V1 — номера карт и услуги записей дня: две выборки на
    // день, не на строку. Нет права или сбой — строки остаются без подробностей.
    async function loadDetails(day, token) {
        const busy = (day && day.busy) || [];
        const pids = [...new Set(busy.map((b) => b.patient_id).filter((x) => x != null))];
        const vids = [...new Set(busy.map((b) => b.visit_id).filter((x) => x != null))];
        if (!pids.length && !vids.length) return;
        const [pts, lines] = await Promise.all([
            pids.length ? supabase.from('patients').select('id, mrn').in('id', pids).then((r) => r, () => ({ data: [] })) : { data: [] },
            vids.length ? supabase.from('visit_services')
                .select('visit_id, status, services(name), consultation_types(name)')
                .in('visit_id', vids).then((r) => r, () => ({ data: [] })) : { data: [] },
        ]);
        if (token !== reqToken) return;   // день уже сменили
        for (const p of (pts && pts.data) || []) if (p && p.mrn) state.mrn.set(String(p.id), p.mrn);
        const byVisit = new Map();
        for (const l of (lines && lines.data) || []) {
            if (!l || ['cancelled', 'removed', 'refunded'].includes(String(l.status || ''))) continue;
            const name = (l.services && l.services.name) || (l.consultation_types && l.consultation_types.name) || '';
            if (!name) continue;
            const k = String(l.visit_id);
            if (!byVisit.has(k)) byVisit.set(k, []);
            if (!byVisit.get(k).includes(name)) byVisit.get(k).push(name);
        }
        for (const [k, v] of byVisit) state.svc.set(k, v);
        paintBody();
    }

    // BOOKING_DAY_CANCEL_V1 — отмена записи: подтверждение с именем и временем,
    // затем setVisitStatus(…, 'cancelled') — calendar_book, та же дверь, что у
    // календаря «Записи» и CRM. Время визита берётся из самой записи (visit_date
    // до секунды): строка расписания знает его только до минуты, а дверь шлёт
    // время как есть — неточное перенесло бы визит, а не отменило.
    async function cancelBooking(t) {
        if (state.cancelling) return;
        const name = t.patient_name || tr('пациента');
        if (!window.confirm(trf('Отменить запись {name} на {time}? Время освободится.', { name, time: t.from }))) return;
        state.cancelling = true;
        try {
            const { data, error } = await supabase.from('visits').select('id, visit_date, status').eq('id', t.visit_id).maybeSingle();
            if (error) throw new Error(error.message);
            const visit = Array.isArray(data) ? data.find((v) => String(v.id) === String(t.visit_id)) : data;
            if (!visit) { toast(tr('Запись не найдена — возможно, её уже отменили.'), 'warn'); return; }
            await (deps.setVisitStatus || setVisitStatus)(visit, 'cancelled');
            toast(trf('Запись отменена: {name}, {time}', { name, time: t.from }), 'ok');
        } catch (e) {
            toast((e && e.message) || tr('Не удалось отменить запись.'), 'fail');
        } finally {
            state.cancelling = false;
        }
        await loadDay();
    }

    // BOOKING_DAY_TO_WIZARD_V1 — окно услуг для сегодняшней записи (см. scheduleRow).
    async function openWizard(t) {
        const full = await loadPatientById(t.patient_id).catch(() => null);
        // Окну услуг — ровно те поля, что даёт ему карта пациента (patientStub в
        // patient-card.js): { id, full_name, mrn, phone }. loadPatientById отдаёт
        // карту в виде экрана (fullName, а не full_name), и окно показывало «—»
        // вместо имени. Карта не дочиталась — хватит id и имени из строки записи:
        // остальное окно читает само (запись дня, тарифы, скидки).
        const patient = {
            id: (full && full.id != null) ? full.id : t.patient_id,
            full_name: (full && (full.fullName || full.full_name)) || t.patient_name || '',
            mrn: full && full.mrn && full.mrn !== '—' ? full.mrn : (state.mrn.get(String(t.patient_id)) || ''),
            phone: (full && full.phone) || '',
        };
        const open = deps.openVisitWizard || (await import('./visit-wizard.js?v=ownrep4')).openVisitWizard;
        await open(() => loadDay(), patient);
    }

    async function openCard(patientId) {
        if (typeof ctx.onNavigate !== 'function') return;
        const full = await loadPatientById(patientId).catch(() => null);
        if (!full) { toast(tr('Карта пациента не найдена.'), 'fail'); return; }
        ctx.onNavigate('patient-card', full);
    }

    paintDateBtns();
    paintDoctorList();
    paintBody();
    return { state, pickDoctor, setDate, reload: loadDay };
}
