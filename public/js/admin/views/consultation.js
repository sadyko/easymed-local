// My services — work queue for service providers (doctors, lab techs, etc).
//
// What lands here: any visit_services row whose status is past the cashier
// step (queued / in_progress / completed). The cashier flips
// visit_services.status to 'queued' when they accept payment OR mark the
// invoice as debt (see cashier.js + visit-modal.js). Plain unpaid invoices
// that the cashier hasn't acted on yet stay invisible here.
//
// Two layouts (List / Grid, mirroring the toggle on the Scheduling page).
// Actions on each row:
//     queued       → "Start service"     → status = in_progress
//     in_progress  → "Complete service"  → status = completed
//     completed    → static "Done" tag

import { supabase } from '../../supabase.js';
import { h, Icon, Tag, PageHead, toast, clear, avColor, initials, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { scopedDoctorId, selfDoctorId, scopedProviderId } from '../permissions.js';   // ADMIN_DOCTOR_V2 / SERVICE_SCOPE_V1
import { renderDoctorProfile } from './doctor-profile.js?v=btnright1';
// DOCTOR_DASHBOARD_V1 — кабинет открывается дашбордом, и ДЕНЬГИ ЖИВУТ ТАМ.
// serviceRateMap/serviceShare переехали в doctor-dashboard.js целиком: две
// копии одной формулы доли врача — это две формулы, которые однажды разойдутся,
// и разойдутся молча, потому что обе «работают». Импорт без ?v=: версия в
// специфике делает ОТДЕЛЬНЫЙ экземпляр модуля, а у дашборда есть состояние.
import {
    renderDoctorDashboard, resetDoctorDashboard,
    serviceRateMap, serviceShare, perServicePayApplies,
} from './doctor-dashboard.js';
// HEAD_DOCTOR_WARD_VIEW_V1 — главный врач делает свою работу ПРЯМО ИЗ КАБИНЕТА:
// оба окна те же самые, что в разделе «Стационар», а не их копии.
import { openAdmissionCard, openAdmissionReviewModal, openAdmissionAttendingModal } from './admission-modal.js?v=inp2';   // INPATIENT_TAB_V1 / ADMISSION_ORDER_V1
import { loadPatientById } from '../data.js';   // NO_GREETING_V1 — currentUser() went with the greeting band
import { IN_BED_STATUSES, admissionStatusLabel } from '../../shared/admission-status.js';   // INPATIENT_FLOW_V1

// ---------------------------------------------------------------------------
// Aurora queue (AURORA_QUEUE_V1) — local RU helpers. These are intentionally
// LOCAL to this module; do NOT edit the shared STATUS_MAP in ui.js.
// ---------------------------------------------------------------------------
const STATUS_RU = {
    added:       'Запланирован',
    queued:      'В очереди',
    in_progress: 'Идёт приём',
    completed:   'Осмотрен',
};
const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                   'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const state = {
    rows:         [],
    statusFilter: 'all',     // 'all' | 'queued' | 'in_progress' | 'completed'
    view:         'list',    // 'list' | 'calendar'
    dateRange:    'all',     // CABINET_DEFAULT_ALL_V1 — was 'today', which hid future-dated bookings; show all, doctor can filter
    search:       '',
    // Today's referrals THIS doctor made (for the KPI cards / RecsModal). Lazy
    // and tolerant — see loadTodayReferrals(). { loaded, rows: [...] }
    todayReferrals: { loaded: false, rows: [] },
    // Page-level tabs. DOCTOR_DASHBOARD_V1 — кабинет ОТКРЫВАЕТСЯ дашбордом
    // (владелец: «in the doctors cabinet make dashboard first»); рабочий список
    // — соседняя вкладка в один щелчок и по своему адресу '#consultation/work'.
    tab:          'dashboard',
    // INPATIENT_TAB_V1 — «Стационар»: this doctor's active admissions (admins see
    // all). Lazy-loaded on first open. Inpatients live in admissions/admission_*
    // tables, so they never appear in «Мои приёмы» (visit_services-based).
    // HEAD_DOCTOR_WARD_VIEW_V1 — `scope` и `can` приходят С СЕРВЕРА
    // (inpatient_capabilities): 'own' — свои пациенты, 'all' — весь стационар
    // (главный врач, администратор). Значение по умолчанию — САМОЕ УЗКОЕ: не
    // ответил сервер — показываем только своих, а не всех.
    inpt: { loaded: false, loading: false, rows: [], scope: 'own', can: {}, capsAsked: false },
    // Dashboard tab state — lazy-loaded on first open of the dashboard tab.
    dash: {
        doctors:   [],        // [{ id, full_name, … }]
        doctorId:  null,      // currently-viewed doctor (defaults to first)
        period:    'month',   // 'week' | 'month' | 'year' | 'all'
        loaded:    false,
        loading:   false,
        doctor:    null,      // full users row for the picked doctor
        services:  [],        // visit_services this doctor performed in the period
        referrals: [],        // recommended_services where recommended_by = doctor
        bonusRules:[],        // doctor_referral_bonuses rules for this doctor
    },
};

let containerRef = null;
let onNavigateRef = null;
let tabIdRef = null;          // HASH_SUBROUTE_V1 — чем отчитываться оболочке
let queueLoaded = false;      // рабочий список грузится, когда его открыли

// HASH_SUBROUTE_V1 — адрес ↔ вкладка. Пустой sub — дашборд: кабинет ОТКРЫВАЕТСЯ
// им, поэтому у него бесхвостый '#consultation', а не '#consultation/dashboard'.
const SUB_TO_TAB = { work: 'appointments', inpatients: 'inpatients', pay: 'pay', profile: 'profile' };
const TAB_TO_SUB = { appointments: 'work', inpatients: 'inpatients', pay: 'pay', profile: 'profile' };

export async function renderConsultation(container, { onNavigate, payload, tabId } = {}) {
    containerRef = container;
    onNavigateRef = onNavigate || null;
    tabIdRef = tabId || null;
    // Адрес решает, что открыто: '#consultation/work' переживает F5 и
    // пересылку ссылки, а голый '#consultation' открывает дашборд.
    const sub = payload && typeof payload.sub === 'string' ? payload.sub : null;
    state.tab = SUB_TO_TAB[sub] || 'dashboard';
    clear(container);
    container.appendChild(h('div', { class: 'empty', style: { padding: '40px' } }, 'Загружаем кабинет…'));
    // DOCTOR_DASHBOARD_V1 — дашборд перечитывается при каждом входе в раздел:
    // «мой день» протухает быстрее всего на экране.
    resetDoctorDashboard();
    queueLoaded = false;
    // HEAD_DOCTOR_WARD_VIEW_V1 — стационар перечитывается при каждом входе в
    // кабинет, и вместе со списком заново спрашивается ОБЛАСТЬ ВИДИМОСТИ.
    // Оставленное состояние жило дольше сессии: список пациентов в койках
    // протухает быстрее «моего дня», а надстройку «главный врач» администратор
    // может снять — и кабинет продолжал бы показывать весь стационар.
    state.inpt = { loaded: false, loading: false, rows: [], scope: 'own', can: {}, capsAsked: false };
    if (state.tab === 'appointments') { await loadQueueOnce(); }
    paint();
    // Адрес открывает ЛЮБУЮ вкладку, а не только ту, на которую нажали, —
    // значит и подгружать её данные обязан тот же код, что и щелчок. Без этой
    // строки '#consultation/pay' из закладки открывался бы пустой зарплатой:
    // ленивая загрузка висела бы только на кнопке.
    ensureTabData(state.tab).then(() => paint());
    // Today's referrals feed the KPI cards (3) and (4). Loaded after the first
    // paint so the queue never waits on it; repaint once it lands.
    loadTodayReferrals().then(() => { if (state.tab === 'appointments') paint(); });
}

// Рабочий список — по требованию. До DOCTOR_DASHBOARD_V1 он грузился всегда,
// потому что всегда и открывался; теперь кабинет открывается дашбордом, и
// тянуть 300 строк очереди ради вкладки, на которую ещё не нажали, незачем.
async function loadQueueOnce() {
    if (queueLoaded) return;
    await loadServices();
    queueLoaded = true;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadServices() {
    let query = supabase
        .from('visit_services')
        .select(`
            id, status, quantity, unit_price, total, created_at, invoice_item_id,
            visit_id, service_id, doctor_id, consultation_type_id,
            services(name, type, duration_minutes, service_types(name), departments(kind)),
            consultation_types(name_ru, name_uz),
            users:doctor_id(full_name, specialty, rooms(name, floors(name))),
            visits(visit_date, patient_id,
                   patients(full_name, last_name, first_name, mrn, phone))
        `)
        .in('status', ['added', 'queued', 'in_progress', 'completed'])
        // BRANCH_ORIGIN_V1 — решение владельца 2026-09-02: «очередь и кабинет врача —
        // своего здания». sync_origin IS NULL = строка заведена здесь; работа, приехавшая
        // от соседнего филиала, остаётся в его кабинете и видна тут только через карту
        // пациента. Фильтр серверный: .limit(300) ниже иначе тратился бы на чужие строки.
        .is('sync_origin', null);
    // M1 — scope to this clinic; super-admin/platform-staff JWT bypasses company RLS, so the
    // client filter is the only tenant boundary here (mirrors procedures.js loadServices).
    const cid = (window.CLINIC && window.CLINIC.id) || null;
    if (cid) query = query.eq('company_id', cid);
    // SERVICE_SCOPE_V1 — provider login (doctor OR nurse) → only their own services; admins see all.
    const docId = (typeof scopedProviderId === 'function') ? scopedProviderId() : null;
    // SERVICE_SCOPE_V3 — the cabinet shows ONLY services assigned to a specific performer;
    // unassigned services (doctor_id null) don't belong to any doctor's cabinet.
    query = query.not('doctor_id', 'is', null);
    if (docId) query = query.eq('doctor_id', docId);
    const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(300);
    if (error) {
        console.error('[my-services] load failed:', error);
        toast('Could not load services: ' + error.message, 'fail');
        state.rows = [];
        return;
    }
    // SERVICE_ROUTING: lab services go to the Laboratory module, not the doctor queue.
    const LAB_RE = /^lab|laborator|лаборатор/i;
    // SERVICE_ROUTING_V2 — lab → #labs, procedure → #procedures; the cabinet keeps the rest (consultation/diagnostics/surgery)
    // SERVICE_ROUTING_V3 — ALSO honor the built-in services.type enum: the
    // service_types(name) join can come back null (RLS on a cross-clinic
    // type row, PostgREST schema-cache lag), which silently re-routed lab
    // orders into the doctor queue. services.type is a plain column on the
    // row we already read, so it survives all join failures.
    const _goesElsewhere = (r) => ['laboratory', 'procedure'].includes(r.services?.departments?.kind)
        || r.services?.type === 'lab'
        || r.services?.type === 'procedure'   // SERVICE_GROUP_ROUTING_V1
        || LAB_RE.test(r.services?.service_types?.name || '');
    // RT2_FIX_V1 — a paid/partial invoice releases the order even when visit_services.status is
    // still 'added' (a partial payment doesn't flip the status). Cross-check invoice status by item.
    const _rtItemIds = [...new Set((data || []).map(r => r.invoice_item_id).filter(Boolean))];
    const _rtInvByItem = new Map();
    if (_rtItemIds.length) {
        try {
            const { data: _its } = await supabase.from('invoice_items').select('id, invoices(status)').in('id', _rtItemIds);
            for (const it of (_its || [])) _rtInvByItem.set(it.id, it.invoices?.status || null);
        } catch (e) { console.warn('[my-services] invoice status:', e && e.message); }
    }
    state.rows = (data || []).filter(r => !_goesElsewhere(r)).map(r => {
        const p = r.visits?.patients || {};
        const patientName = [p.last_name, p.first_name].filter(Boolean).join(' ').trim()
            || p.full_name || '(unknown)';
        return {
            id:              r.id,
            status:          r.status,
            invoiceStatus:   r.invoice_item_id ? (_rtInvByItem.get(r.invoice_item_id) || null) : null,   // RT2_FIX_V1
            visitId:         r.visit_id,
            // QUEUE_CONSULT_NAME_V1 — workspace consultations carry consultation_type_id
            // (service_id NULL); without this they rendered as '—' and looked missing.
            serviceName:     r.services?.name || (r.consultation_types ? (r.consultation_types.name_ru || r.consultation_types.name_uz || 'Консультация') : '—'),
            serviceType:     r.services?.service_types?.name || (r.consultation_type_id ? 'Консультация' : ''),
            duration:        r.services?.duration_minutes || null,
            doctorId:        r.doctor_id || null,
            doctorName:      r.users?.full_name || '—',
            doctorSpecialty: r.users?.specialty || '',
            // DOCTOR_ROOM_V1
            doctorRoom:      r.users?.rooms?.name || '',
            doctorFloor:     r.users?.rooms?.floors?.name || '',
            patientId:       r.visits?.patient_id,
            patientName,
            patientMrn:      p.mrn || '',
            patientPhone:    p.phone || '',
            price:           Number(r.unit_price || 0) * Number(r.quantity || 1),
            createdAt:       r.created_at,
            visitDate:       r.visits?.visit_date,
        };
    });
}

// Today's referrals THIS doctor recommended — powers KPI cards (3) & (4) and
// the RecsModal. Deliberately light + defensive: the recommended_services
// table / columns may differ between deployments, so any error falls back to
// an empty list rather than breaking the queue. (AURORA_QUEUE_V1)
async function loadTodayReferrals() {
    state.todayReferrals = { loaded: true, rows: [] };
    try {
        const docId = scopedDoctorId();
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end   = new Date(); end.setHours(23, 59, 59, 999);
        let query = supabase
            .from('recommended_services')
            .select('id, status, created_at, recommended_by, service_name, patient_id, services(name), patients(full_name, last_name, first_name)')
            .gte('created_at', start.toISOString())
            .lte('created_at', end.toISOString());
        const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1 — clinic scope (RLS-bypass roles see every clinic otherwise)
        if (cid) query = query.eq('company_id', cid);
        if (docId) query = query.eq('recommended_by', docId);
        const { data, error } = await query.order('created_at', { ascending: false }).limit(300);
        if (error) { console.warn('[my-services] referrals load (tolerated):', error.message); return; }
        state.todayReferrals.rows = (data || []).map(r => {
            const p = r.patients || {};
            const patientName = [p.last_name, p.first_name].filter(Boolean).join(' ').trim()
                || p.full_name || '—';
            return {
                id:          r.id,
                status:      r.status || '',
                createdAt:   r.created_at,
                serviceName: r.services?.name || r.service_name || '—',
                patientName,
            };
        });
    } catch (e) {
        console.warn('[my-services] referrals load failed (tolerated):', e);
        state.todayReferrals = { loaded: true, rows: [] };
    }
}

// A referral status that means "done / completed". The recommended_services
// status vocabulary varies; accept the common done-ish values.
function referralIsDone(status) {
    const s = String(status || '').toLowerCase();
    return s === 'done' || s === 'completed' || s === 'выполнено' || s === 'fulfilled' || s === 'closed';
}

// ---------------------------------------------------------------------------
// Top-level render — page tabs + chosen view
// ---------------------------------------------------------------------------
function paint() {
    clear(containerRef);
    containerRef.appendChild(h('div', { class: 'fade-in' },
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' } },
            // DOCTOR_DASHBOARD_V1 — дашборд ПЕРВЫМ и открыт ПО УМОЛЧАНИЮ.
            topTab('dashboard',    'Дашборд',      'Dashboard'),
            topTab('appointments', 'Мои приёмы',  'Activity'),
            topTab('inpatients',   'Стационар',    'Bed'),   // INPATIENT_TAB_V1
            // Старый «Дашборд» никуда не делся — он переехал сюда и назван тем,
            // чем всегда был: глубокие периоды, ставки, вознаграждения за
            // направления и разбор начислений.
            topTab('pay',          'Зарплата',     'Wallet'),
            topTab('profile',      'Мой профиль',  'User'),
        ),
        state.tab === 'profile' ? profileView()
            : state.tab === 'pay' ? dashboardView()
            : state.tab === 'inpatients' ? inpatientsView()
            : state.tab === 'appointments' ? appointmentsView()
            : doctorDashboardView(),
    ));
    // The appointments table body is painted into a slot by id — only meaningful
    // when the appointments tab is the one being shown.
    if (state.tab === 'appointments') paintBody();
}

// DOCTOR_DASHBOARD_V1 — дашборд рисует себя сам в своё гнездо: у него своё
// состояние и своя загрузка, и paint() здесь его не ждёт — вкладки
// переключаются мгновенно, а числа приезжают, когда приедут.
function doctorDashboardView() {
    const host = h('div');
    renderDoctorDashboard(host, {
        // Карточка приёма ведёт туда, где с ним работают, — в рабочий список.
        // Своего второго окна приёма дашборд не заводит.
        onOpenWork: () => setTab('appointments'),
        // HEAD_DOCTOR_WARD_VIEW_V1 — полоса главного врача ведёт на СВОЮ вкладку
        // кабинета, а не в раздел «Стационар»: работа делается там же, где он
        // уже стоит.
        onOpenInpatients: () => setTab('inpatients'),
    });
    return host;
}

function profileView() {
    const box = h('div');
    renderDoctorProfile(box, selfDoctorId());   // ADMIN_DOCTOR_V2 — your own profile even as admin
    return box;
}

// ---------------------------------------------------------------------------
// INPATIENT_TAB_V1 — «Стационар»: this doctor's ACTIVE admissions. Click a
// patient → the admission window (services + назначения). Inpatients never
// appear in «Мои приёмы» (that queue is visit_services-based; inpatient care
// lives in admissions/admission_services/admission_prescriptions).
// ---------------------------------------------------------------------------
// HEAD_DOCTOR_WARD_VIEW_V1 — КОГО ЭТОТ ЧЕЛОВЕК ВИДИТ, РЕШАЕТ СЕРВЕР.
//
// Владелец: «главный врач cannot see the admission of the patients of the
// departments. in their cabinet». Вкладка сужала список на `attending_doctor_id
// = я`, и для главного врача это ровно противоположность его работе: он
// осматривает поступивших ДО того, как лечащий врач появится ('admitted'), и
// назначает лечащего следом ('examined') — у обеих строк attending пуст, и
// фильтр вычёркивал их все. Вкладка была пуста ВСЕГДА.
//
// Спрашиваем ОДИН раз на открытие кабинета и не считаем по роли сами: правило
// живёт в rpc/inpatient-flow.js (inpatientScope), и вторая его копия здесь
// разошлась бы с первой молча — экран показывал бы пациента, на котором сервер
// откажет, или прятал бы того, за кого человек отвечает.
async function loadInpatientCaps() {
    if (state.inpt.capsAsked) return;
    state.inpt.capsAsked = true;
    try {
        const { data } = await supabase.rpc('inpatient_capabilities', {});
        state.inpt.scope = (data && data.scope) === 'all' ? 'all' : 'own';
        state.inpt.can = (data && data.can) || {};
    } catch (e) {
        // Не ответил сервер — остаёмся на самом узком: свои пациенты.
        state.inpt.scope = 'own';
        state.inpt.can = {};
    }
}

async function loadInpatients() {
    await loadInpatientCaps();
    let q = supabase.from('admissions')
        .select(`
            id, admission_no, status, admission_diagnosis, admitted_at, department,
            patient_id, attending_doctor_id, ward_id, bed_id,
            patients(full_name, last_name, first_name, mrn, phone),
            wards(name),
            beds(code),
            attending:attending_doctor_id(full_name)
        `)
        // INPATIENT_FLOW_V1 — вкладка «Стационар» показывает пациентов В КОЙКЕ,
        // а не только тех, кто дошёл до 'active': врач обязан видеть своего
        // пациента с первой минуты, а не после первичного осмотра.
        .in('status', IN_BED_STATUSES)
        .order('admitted_at', { ascending: false })
        .limit(200);
    // ADMISSION_ORDER_V1 — фильтра по company_id здесь БЫТЬ НЕ МОЖЕТ: в
    // schema-registry.js у admissions такой колонки нет ни в чтении, ни в
    // фильтрах, и /api/db отвечал на этот запрос отказом. Вместе с embed'ом
    // `beds!admissions_bed_id_fkey(…)` строкой выше (его не принимает
    // query-compiler) это делало вкладку «Стационар» пустой ВСЕГДА. База
    // локальная и однопользовательская по клинике — область и так одна.
    //
    // HEAD_DOCTOR_WARD_VIEW_V1 — сужение на «своих» ставится ТОЛЬКО при scope
    // 'own'. Здание сужать нечем и не нужно: `admissions` не ездит между
    // филиалами (её нет в SHIPPED, branch-sync/journal.js), у неё нет ни
    // sync_origin, ни uid — каждая база видит только свои госпитализации.
    const docId = scopedDoctorId();
    if (state.inpt.scope !== 'all' && docId) q = q.eq('attending_doctor_id', docId);
    const { data, error } = await q;
    if (error) { console.warn('[inpatients]', error.message); state.inpt.rows = []; }
    else state.inpt.rows = sortInpatients(data || []);
    state.inpt.loaded = true;
}

// ПОРЯДОК СПИСКА — ЭТО РАБОТА, А НЕ ДАТА. У главного врача сверху те, кого
// ждут именно от него: непроведённый первичный осмотр, затем осмотренные без
// лечащего врача. Остальные — как раньше, свежие первыми. У палатного врача
// список однородный, и порядок для него не меняется.
const INPT_URGENCY = { admitted: 0, examined: 1 };
export function sortInpatients(rows) {
    const rank = (r) => (INPT_URGENCY[r && r.status] !== undefined ? INPT_URGENCY[r.status] : 2);
    return rows.slice().sort((a, b) => {
        const d = rank(a) - rank(b);
        if (d) return d;
        return String(b.admitted_at || '').localeCompare(String(a.admitted_at || ''));
    });
}

// Одна строка списка. Кнопка «открыть карточку» ВНУТРИ строки, а не сама
// строка: рядом с ней живут действия главного врача, а кнопка внутри кнопки —
// это неработающая клавиатура и неверно озвученная строка у скринридера.
function inpatientRow(r, onChange) {
    const p = r.patients || {};
    const nm = (p.full_name || [p.last_name, p.first_name].filter(Boolean).join(' ') || '—').trim();
    const place = [r.wards && r.wards.name, r.beds && r.beds.code ? trf('койка {code}', { code: r.beds.code }) : null]
        .filter(Boolean).join(' · ');
    const attending = r.attending && r.attending.full_name;
    const meta = [
        p.mrn || null,
        place || tr('без койки'),
        trf('поступил {date}', { date: String(r.admitted_at || '').slice(0, 10) }),
        // Чей это пациент — вопрос главного врача, и без ответа список его
        // работы не описывает: «осмотрен» и «лечится» выглядели бы одинаково.
        state.inpt.scope === 'all'
            ? (attending ? trf('лечащий: {name}', { name: attending }) : tr('без лечащего врача'))
            : null,
        r.admission_diagnosis || null,
    ].filter(Boolean).join(' · ');

    // ДЕЙСТВИЯ РИСУЮТСЯ ПО ОТВЕТУ СЕРВЕРА (can), а не по роли: спрятанная
    // кнопка — украшение, и появиться она обязана ровно там, где сервер
    // пропустит. Дальше первичного осмотра и назначения лечащего кабинет не
    // идёт — остальное живёт в карточке госпитализации и в разделе «Стационар».
    const right = [];
    if (r.status === 'admitted') {
        right.push(state.inpt.can.examine
            ? h('button', { class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => openAdmissionReviewModal({ admission: r, onDone: onChange }) },
                Icon('Stethoscope', { size: 13 }), ' ', 'Провести первичный осмотр')
            : Tag('Ждёт главного врача', { kind: 'warn', dot: true }));
    } else if (r.status === 'examined') {
        right.push(state.inpt.can.set_attending
            ? h('button', { class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => openAdmissionAttendingModal({ admission: r, onDone: onChange }) },
                Icon('User', { size: 13 }), ' ', 'Назначить лечащего врача')
            : Tag('Ждёт лечащего врача', { kind: 'warn', dot: true }));
    } else {
        right.push(Tag(admissionStatusLabel(r.status), { kind: 'ok' }));
    }

    return h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', width: '100%',
                               padding: '14px 16px', background: 'var(--white)', border: '1px solid var(--ink-100)',
                               borderRadius: '12px', flexWrap: 'wrap' } },
        h('span', { class: 'av ' + avColor(r.patient_id || nm), style: { width: '38px', height: '38px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '13.5px', flex: 'none', background: 'var(--primary-50)', color: 'var(--primary-700)' } }, initials(nm)),
        h('button', {
            type: 'button',
            title: tr('Открыть карточку госпитализации'),
            style: { flex: 1, minWidth: '0', textAlign: 'left', background: 'transparent',
                     border: '0', padding: '0', cursor: 'pointer', font: 'inherit' },
            onclick: () => openAdmissionCard({ admissionId: r.id, onChange }),
        },
            h('div', { style: { fontWeight: 700, fontSize: '13.5px', color: 'var(--ink-900)' } }, nm),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } }, meta)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none', flexWrap: 'wrap' } },
            ...right.filter(Boolean)),
    );
}

function inpatientsView() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
    if (state.inpt.loading) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '40px' } }, 'Загрузка…'));
        return wrap;
    }
    const rows = state.inpt.rows || [];
    const wide = state.inpt.scope === 'all';
    const reload = () => { loadInpatients().then(paint); };
    wrap.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '10px' } },
        h('div', { style: { fontWeight: 700, fontSize: '13.5px' } },
            wide ? 'Стационар: все пациенты' : 'Пациенты в стационаре'),
        h('span', { class: 'muted', style: { fontSize: '12.5px' } }, trf('активные госпитализации: {n}', { n: rows.length })),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => {
            state.inpt.loading = true; paint();
            loadInpatients().then(() => { state.inpt.loading = false; paint(); });
        } }, Icon('Refresh', { size: 13 }), ' Обновить'),
    ));
    // Почему главный врач видит чужих пациентов — сказано на экране словами, а
    // не подразумевается: иначе широкий список выглядит ошибкой прав.
    if (wide) {
        wrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
            'Первичный осмотр и назначение лечащего врача — по всему стационару.'));
    }
    if (!rows.length) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '40px' } },
            wide ? 'В стационаре сейчас никого нет.' : 'Нет активных стационарных пациентов.'));
        return wrap;
    }
    for (const r of rows) wrap.appendChild(inpatientRow(r, reload));
    return wrap;
}

// ОДИН вход во все вкладки: и кнопка шапки, и карточка дашборда зовут его,
// поэтому ленивая загрузка и адрес обновляются в одном месте.
function setTab(id) {
    if (state.tab === id) return;
    state.tab = id;
    syncSubUrl();
    paint();
    ensureTabData(id).then(() => paint());
}

// Что вкладка обязана дочитать, прежде чем показать себя честно. ОДНА функция
// на два входа — щелчок и адрес: разъехавшись, они дали бы вкладку, которая
// работает по кнопке и пуста по ссылке.
function ensureTabData(id) {
    if (id === 'appointments') return loadQueueOnce();
    if (id === 'pay' && !state.dash.loaded) {
        state.dash.loading = true;
        return (state.dash.doctors.length ? Promise.resolve() : loadDoctorsForDash())
            .then(() => loadDashboardData())
            .then(() => { state.dash.loading = false; });
    }
    if (id === 'inpatients' && !state.inpt.loaded) {   // INPATIENT_TAB_V1
        state.inpt.loading = true;
        return loadInpatients().then(() => { state.inpt.loading = false; });
    }
    return Promise.resolve();
}

// HASH_SUBROUTE_V1 — адрес отражает состояние: вкладка живёт в строке адреса,
// поэтому F5 её сохраняет, а ссылку можно отправить коллеге. replaceState, а не
// pushState: переключение вкладки внутри одного экрана — не новое место, куда
// должна возвращать кнопка «Назад».
function syncSubUrl() {
    try {
        if (typeof history === 'undefined' || !history.replaceState) return;
        const sub = TAB_TO_SUB[state.tab] || null;
        history.replaceState({ view: 'consultation', payload: sub ? { sub } : null },
            '', '#consultation' + (sub ? '/' + sub : ''));
        // Адресной строки мало: navigate() перепишет хеш из payload ВКЛАДКИ
        // оболочки при следующем заходе в кабинет — и ссылка протухнет.
        if (typeof window !== 'undefined' && typeof window.easymedSetTabSub === 'function') {
            window.easymedSetTabSub(tabIdRef, sub);
        }
    } catch (e) {
        // Закрученный браузер может запретить запись в историю: вкладка
        // продолжает работать, просто перестаёт быть ссылкой.
    }
}

function topTab(id, label, icon) {
    const on = state.tab === id;
    return h('button', {
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        onclick: () => setTab(id),
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '10px 18px', borderRadius: '999px',
            border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-200)'),
            background: on ? 'var(--primary-50)' : 'white',
            color: on ? 'var(--primary-700)' : 'var(--ink-700)',
            fontWeight: on ? 600 : 500, fontSize: '13.5px',
            cursor: 'pointer', fontFamily: 'inherit',
        },
    }, Icon(icon, { size: 15 }), label);
}

// ---------------------------------------------------------------------------
// APPOINTMENTS VIEW — doctor "Очередь приёма" (KPIs · queue)
// (AURORA_QUEUE_V1)
//
// NO_GREETING_V1 (2026-09-05) — the greeting band that opened this screen is
// gone (owner: убрать приветственные баннеры). It carried a time-of-day
// greeting, a warm paragraph and a live 1-second clock — none of which is a
// control — plus ONE thing that is: the Сегодня/Неделя/Месяц/Период range
// filter. That filter moved down into the queue card's header, beside the
// search box and the status filter it has always worked with.
// ---------------------------------------------------------------------------
function appointmentsView() {
    return h('div', null,
        kpiSummary(),
        h('div', { class: 'card', id: 'svc-card' },
            h('div', { class: 'card-header' },
                h('div', { class: 'row', style: { gap: '10px', flex: '1', flexWrap: 'wrap' } },
                    h('input', {
                        placeholder: 'Поиск по ФИО, MRN, телефону, услуге…',
                        value: state.search,
                        oninput: (e) => { state.search = e.target.value; paintBody(); },
                        style: { height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px', width: '360px', maxWidth: '100%' },
                    }),
                    statusFilterSelect(),
                    rangeFilter(),   // NO_GREETING_V1 — relocated out of the band
                ),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    'Показано ', h('b', { id: 'svc-count', style: { color: 'var(--ink-800)' } }, '0'),
                    ' из ', String(state.rows.length)),
            ),
            h('div', { id: 'svc-body' }),
        ),
    );
}

// ---- Date-range filter: Сегодня / Неделя / Месяц / Период ----
// The values are read by inDateRange() (see the date-range helpers below);
// changing one repaints the whole view, which is what re-applies the filter.
const RANGES = [
    { id: 'today', label: 'Сегодня' },
    { id: 'week',  label: 'Неделя' },
    { id: 'month', label: 'Месяц' },
    { id: 'all',   label: 'Период' },
];

function rangeFilter() {
    return h('div', { class: 'segmented', id: 'svc-range' },
        ...RANGES.map(r => h('button', {
            class: state.dateRange === r.id ? 'on' : '',
            type: 'button',
            'data-range': r.id,
            onclick: () => { if (state.dateRange === r.id) return; state.dateRange = r.id; paint(); },
        }, r.label)));
}

// ---- KPI summary cards (4) — real counts from loaded rows + referrals ----
function kpiSummary() {
    const counts = countByStatus(state.rows);
    const toReview = (counts.added || 0) + counts.queued + counts.in_progress;
    const seenToday = state.rows.filter(r => r.status === 'completed' && isTodayDate(r.visitDate)).length;
    const refs = state.todayReferrals.rows;
    const recsToday = refs.length;
    const recsDone  = refs.filter(r => referralIsDone(r.status)).length;
    return h('div', { class: 'ws-kpi' },
        kpiCard({   // WS_KPI_ALL_V1 — «Все» resets the status filter
            active: state.statusFilter === 'all',
            icon: 'Layers', accent: 'var(--ink-700)', accentBg: 'var(--ink-50)',
            value: String(state.rows.length), label: 'Все',
            onClick: () => setStatusFilter('all'),
        }),
        kpiCard({
            active: state.statusFilter === 'queued' || state.statusFilter === 'in_progress',
            icon: 'Patients', accent: 'var(--info-700)', accentBg: 'var(--info-50)',
            value: String(toReview), label: 'В очереди / готовы к осмотру',
            onClick: () => setStatusFilter('queued'),
        }),
        kpiCard({
            active: false,
            icon: 'Check', accent: 'var(--ok-700)', accentBg: 'var(--ok-50)',
            value: String(seenToday), label: 'Осмотрено сегодня',
            onClick: () => setStatusFilter('completed'),
        }),
        kpiCard({
            active: false,
            icon: 'ArrowRight', accent: 'var(--purple-700)', accentBg: 'var(--purple-50)',
            value: String(recsToday), label: 'Рекомендаций сегодня',
            onClick: () => openRecsModal('all'),
        }),
        kpiCard({
            active: false,
            icon: 'Check', accent: 'var(--primary-700)', accentBg: 'var(--primary-50)',
            value: String(recsDone), sub: trf('из {n}', { n: recsToday }), label: 'Выполнено рекомендаций',
            onClick: () => openRecsModal('done'),
        }),
    );
}

function kpiCard({ active, icon, accent, accentBg, value, label, sub, onClick }) {
    return h('button', {
        type: 'button',
        class: 'ws-kpi-card' + (active ? ' on' : ''),
        // Set the per-card accent custom properties via setProperty so they
        // land reliably across browsers (Object.assign on style is unreliable
        // for CSS custom properties).
        ref: (el) => { el.style.setProperty('--ws-accent', accent); el.style.setProperty('--ws-accent-bg', accentBg); },
        onclick: onClick,
    },
        sub && h('div', { class: 'ws-kpi-trend' }, sub),
        h('div', { class: 'ws-kpi-ic' }, Icon(icon, { size: 18 })),
        h('div', { class: 'ws-kpi-body' },
            h('div', { class: 'ws-kpi-val num' }, value),
            h('div', { class: 'ws-kpi-label' }, label),
        ),
    );
}

// ---- Status filter dropdown (RU) ----
function statusFilterSelect() {
    return h('select', {
        value: state.statusFilter,
        onchange: (e) => setStatusFilter(e.target.value),
        style: { height: '34px', borderRadius: '8px', border: '1px solid var(--ink-200)', padding: '0 10px', fontSize: '13.5px' },
    },
        h('option', { value: 'all',         selected: state.statusFilter === 'all' },         'Все статусы'),
        h('option', { value: 'queued',      selected: state.statusFilter === 'queued' },      STATUS_RU.queued),
        h('option', { value: 'in_progress', selected: state.statusFilter === 'in_progress' }, STATUS_RU.in_progress),
        h('option', { value: 'completed',   selected: state.statusFilter === 'completed' },   STATUS_RU.completed),
    );
}

function setView(v) {
    if (state.view === v) return;
    state.view = v;
    paint();
}
function setStatusFilter(s) {
    if (state.statusFilter === s) return;
    state.statusFilter = s;
    paint();
}

// ---------------------------------------------------------------------------
// Body — switches between list table and calendar
// ---------------------------------------------------------------------------
function paintBody() {
    const body = containerRef.querySelector('#svc-body');
    if (!body) return;
    const filtered = filterRows();
    const countEl = containerRef.querySelector('#svc-count');
    if (countEl) countEl.textContent = String(filtered.length);

    clear(body);

    // List/Calendar toggle lives in the card body so it can sit above either view.
    body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '12px 14px 0' } },
        h('div', { class: 'segmented' },
            h('button', { class: state.view === 'list' ? 'on' : '', onclick: () => setView('list') },
                Icon('Doc', { size: 13 }), ' Список'),
            h('button', { class: state.view === 'calendar' ? 'on' : '', onclick: () => setView('calendar') },
                Icon('Calendar', { size: 13 }), ' Календарь'),
        ),
    ));

    if (state.view === 'calendar') { body.appendChild(calendarView(filtered)); return; }

    if (filtered.length === 0) {
        body.appendChild(h('div', { class: 'empty', style: { padding: '40px 20px' } },
            'Нет записей на приём за выбранный период.'));
        return;
    }
    body.appendChild(listView(filtered));
}

function filterRows() {
    const t = (state.search || '').trim().toLowerCase();
    return state.rows.filter(r => {
        if (state.statusFilter !== 'all') {
            const want = state.statusFilter === 'queued' ? ['added', 'queued'] : [state.statusFilter];
            if (!want.includes(r.status)) return false;
        }
        if (!inDateRange(r.visitDate)) return false;
        if (t) {
            const hay = [r.patientName, r.patientMrn, r.patientPhone, r.serviceName, r.doctorName]
                .filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(t)) return false;
        }
        return true;
    });
}

// ---- Date-range helpers (AURORA_QUEUE_V1) ----
// Parse a visit_date ("YYYY-MM-DD" or ISO) to a local Date at midnight; null if
// unparseable.
function visitDay(visitDate) {
    if (!visitDate) return null;
    const d = new Date(visitDate);
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
}
function isTodayDate(visitDate) {
    const d = visitDay(visitDate);
    if (!d) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return d.getTime() === today.getTime();
}
// Monday-anchored ISO week containing `ref`.
function isoWeekBounds(ref = new Date()) {
    const start = new Date(ref); start.setHours(0, 0, 0, 0);
    const dow = (start.getDay() + 6) % 7;   // 0 = Monday
    start.setDate(start.getDate() - dow);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    return { start, end };
}
// Does a row's visitDate fall inside the active dateRange filter? Rows with no
// usable date are kept only on the 'all' range (so nothing silently vanishes
// from the unfiltered view).
function inDateRange(visitDate) {
    if (state.dateRange === 'all') return true;
    const d = visitDay(visitDate);
    if (!d) return false;
    if (state.dateRange === 'today') return isTodayDate(visitDate);
    if (state.dateRange === 'week') {
        const { start, end } = isoWeekBounds();
        return d >= start && d < end;
    }
    if (state.dateRange === 'month') {
        const now = new Date();
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
    return true;
}

// ---------------------------------------------------------------------------
// List view — RU columns, only columns backed by real data. (AURORA_QUEUE_V1)
// № · Пациент · Тип услуги · Услуга · Статус услуги · Запись · Принято · Действие
// ---------------------------------------------------------------------------
function listView(rows) {
    return h('table', { class: 'tbl' },
        h('thead', null, h('tr', null,
            h('th', { style: { width: '40px' } }, '№'),
            h('th', null, 'Пациент'),
            h('th', null, 'Тип услуги'),
            h('th', null, 'Услуга'),
            h('th', null, 'Статус услуги'),
            h('th', null, 'Запись'),
            h('th', null, 'Принято'),
            h('th', { style: { width: '170px', textAlign: 'right' } }, 'Действие'),
        )),
        h('tbody', null, ...rows.map((r, i) => listRow(r, i))),
    );
}

function listRow(r, i) {
    return h('tr', null,
        h('td', { class: 'num muted' }, String(i + 1)),
        h('td', null,
            h('div', { class: 'row', style: { gap: '10px' } },
                h('div', { class: 'avatar sm ' + avColor(r.patientId || r.patientName) }, initials(r.patientName)),
                h('div', null,
                    nameLink(r),
                    r.patientMrn && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, r.patientMrn),
                ),
            ),
        ),
        h('td', null, r.serviceType
            ? h('span', { class: 'tag tag-teal' }, r.serviceType)
            : h('span', { class: 'muted' }, '—')),
        // DOCTOR_ROOM_V1 — no doctor column in the list; surface the room under the service.
        h('td', { class: 'cell-strong' },
            r.serviceName,
            r.doctorRoom && h('div', { class: 'docroom-line' },
                trf('Кабинет {room}', { room: r.doctorRoom }) + (r.doctorFloor ? ' · ' + trf('Этаж {n}', { n: r.doctorFloor }) : '')),
        ),
        h('td', null, statusBadge(r.status)),
        h('td', { class: 'num muted' }, formatVisitDate(r.visitDate)),
        h('td', { class: 'num muted' }, formatDateTime(r.createdAt)),
        h('td', { style: { textAlign: 'right' } }, actionButton(r)),
    );
}

// ---------------------------------------------------------------------------
// Grid card (kept for potential reuse — not reachable from the List/Calendar
// toggle). (AURORA_QUEUE_V1: List/Calendar replaced the old List/Grid toggle.)
// ---------------------------------------------------------------------------
function gridCard(r) {
    return h('div', {
        style: {
            padding: '14px',
            border: '1px solid var(--ink-100)',
            borderRadius: '12px',
            background: 'white',
            display: 'flex', flexDirection: 'column', gap: '10px',
        },
    },
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } },
            h('div', { class: 'avatar ' + avColor(r.patientId || r.patientName) }, initials(r.patientName)),
            h('div', { style: { flex: 1, minWidth: 0 } },
                nameLink(r, { fontSize: '13.5px' }),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                    [r.patientMrn, r.patientPhone].filter(Boolean).join(' · ')),
            ),
            statusBadge(r.status),
        ),
        h('div', {
            style: {
                padding: '10px 12px',
                background: 'var(--ink-25)',
                border: '1px solid var(--ink-100)',
                borderRadius: '8px',
            },
        },
            h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, r.serviceName),
            h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '2px' } },
                // DOCTOR_ROOM_V1
                r.doctorName + (r.doctorSpecialty ? ' · ' + r.doctorSpecialty : '')
                + (r.doctorRoom ? ' · ' + trf('Кабинет {room}', { room: r.doctorRoom }) + (r.doctorFloor ? ' · ' + trf('Этаж {n}', { n: r.doctorFloor }) : '') : '')),
            h('div', { class: 'row', style: { marginTop: '8px', gap: '10px' } },
                h('span', { class: 'num cell-strong', style: { fontSize: '13.5px' } },
                    Number(r.price || 0).toLocaleString('ru-RU') + ' UZS'),
                h('span', { class: 'grow' }),
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, formatDateTime(r.createdAt)),
            ),
        ),
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, actionButton(r)),
    );
}

// ---------------------------------------------------------------------------
// Clickable patient name → opens the per-patient service workspace
// (the old consultation page: SOAP note, diagnosis, prescription, labs,
// follow-up, AI assistant). Falls back to plain text when there is no
// onNavigate (defensive — admin.js always passes one).
// ---------------------------------------------------------------------------
function nameLink(r, extraStyle = {}) {
    if (!onNavigateRef) {
        return h('div', { class: 'cell-strong', style: extraStyle }, r.patientName);
    }
    return h('button', {
        type: 'button',
        title: 'Open service workspace',
        onclick: (ev) => { ev.stopPropagation(); openWorkspace(r); },
        style: {
            background: 'none', border: 'none', padding: 0, margin: 0,
            font: 'inherit', color: 'var(--primary-700)', fontWeight: 600,
            cursor: 'pointer', textAlign: 'left', textDecoration: 'underline',
            textDecorationColor: 'transparent', textUnderlineOffset: '3px',
            ...extraStyle,
        },
        onmouseenter: (ev) => { ev.currentTarget.style.textDecorationColor = 'var(--primary-400)'; },
        onmouseleave: (ev) => { ev.currentTarget.style.textDecorationColor = 'transparent'; },
    }, r.patientName);
}

async function openWorkspace(r) {
    // #15 — pay-first gate (single chokepoint: row click, calendar, and the action button all land here).
    // An 'added' service is un-released; the cashier must confirm payment OR debt first
    // (releaseServicesForInvoice then promotes added→queued). Refuse to open it until then.
    if (r.status === 'added' && !['paid', 'partial'].includes(r.invoiceStatus)) { toast('Услуга ещё не проведена кассой — проведите оплату или долг, затем начните приём.', 'fail'); return; }   // RT2_FIX_V1
    // WS_FULL_PATIENT_V1 — load the COMPLETE patient record (dob, gender, blood,
    // allergies, address…) so the workspace panels and the document blank show
    // real data; the minimal queue-row payload remains the fail-soft fallback.
    let full = null;
    try { full = await loadPatientById(r.patientId); } catch (e) { /* fail-soft */ }
    const parts = (r.patientName || '').trim().split(/\s+/);
    const payload = {
        ...(full || {}),
        // WS_TAB_KEY_V1 — admin.js keys workspace tabs by top-level serviceId/visitId
        // (tabIdFor). Without them every workspace shared ONE generic tab id, so a
        // cached empty «Пациент не выбран» tab swallowed the navigation.
        serviceId:  r.id,
        visitId:    r.visitId,
        label:      r.patientName || 'Приём',
        id:         r.patientId,
        mrn:        (full && full.mrn) || r.patientMrn || '',
        lastName:   (full && full.lastName) || parts[0] || '',
        firstName:  (full && full.firstName) || parts.slice(1).join(' ') || '',
        middle:     (full && full.middle) || '',
        fullName:   (full && full.fullName) || r.patientName,
        phone:      (full && full.phone) || r.patientPhone || '',
        initials:   (full && full.initials) || initials(r.patientName),
        avColor:    (full && full.avColor) || avColor(r.patientId || r.patientName),
        // Pass the service context so the workspace header can show what
        // service is being delivered (and by whom).
        __service: {
            id:         r.id,
            name:       r.serviceName,
            doctorId:   r.doctorId || null,
            doctorName: r.doctorName,
            doctorSpec: r.doctorSpecialty,
            price:      r.price,
            visitId:    r.visitId,
            status:     r.status,
        },
    };
    onNavigateRef('service-workspace', payload);
}

// ---------------------------------------------------------------------------
// Status badge + action button
// ---------------------------------------------------------------------------
function statusBadge(status) {
    if (status === 'added')       return tagEl(STATUS_RU.added,       'info', 'Calendar');
    if (status === 'queued')      return tagEl(STATUS_RU.queued,      'info', 'Clock');
    if (status === 'in_progress') return tagEl(STATUS_RU.in_progress, 'warn', 'Stethoscope');
    if (status === 'completed')   return tagEl(STATUS_RU.completed,   'ok',   'Check');
    return tagEl(status || '—', '', null);
}

function tagEl(label, kind, iconName) {
    return h('span', {
        class: 'tag' + (kind ? ' tag-' + kind : ''),
        style: { gap: '4px', display: 'inline-flex', alignItems: 'center' },
    },
        iconName && Icon(iconName, { size: 11 }),
        h('span', null, label),
    );
}

// Exactly one action button per row (AURORA_QUEUE_V1):
//   queued       → «Начать»     → transition(in_progress) THEN openWorkspace
//   in_progress  → «Продолжить» → openWorkspace
//   completed    → «Открыть»    → openWorkspace
function actionButton(r) {
    const _rtReleased = r.status !== 'added' || ['paid', 'partial'].includes(r.invoiceStatus);   // RT2_FIX_V1
    if (r.status === 'added' && !_rtReleased) {
        // #15 — un-released (pay-first): visible but not actionable until the cashier confirms (payment/debt).
        return h('span', { class: 'tag', style: { gap: '4px', display: 'inline-flex', alignItems: 'center', opacity: '.75' } },
            Icon('Wallet', { size: 11 }), h('span', null, 'Ожидает кассу'));
    }
    if (r.status === 'queued' || (r.status === 'added' && _rtReleased)) {
        return h('button', {
            class: 'btn btn-primary btn-sm',
            onclick: async (ev) => {
                const ok = await transition(r, 'in_progress', ev.currentTarget);
                if (ok) openWorkspace(r);
            },
        }, Icon('Stethoscope', { size: 13 }), ' Начать');
    }
    if (r.status === 'in_progress') {
        return h('button', {
            class: 'btn btn-success btn-sm',
            onclick: (ev) => { ev.stopPropagation(); openWorkspace(r); },
        }, Icon('ArrowRight', { size: 13 }), ' Продолжить');
    }
    return h('button', {
        class: 'btn btn-outline btn-sm',
        onclick: (ev) => { ev.stopPropagation(); openWorkspace(r); },
    }, Icon('Doc', { size: 13 }), ' Открыть');
}

async function transition(r, newStatus, btn) {
    btn.disabled = true;
    try {
        const { error } = await supabase.from('visit_services')
            .update({ status: newStatus }).eq('id', r.id);
        if (error) { toast(error.message, 'fail'); return false; }
        r.status = newStatus;
        // Mirror onto the parent visit so the scheduling calendar block
        // recolors immediately. Starting a service puts the visit in_progress;
        // completing one only completes the visit once every (non-cancelled)
        // service on it is done. Best-effort — failures are logged, not toasted.
        if (r.visitId) {
            let visitStatus = 'in_progress';
            if (newStatus === 'completed') {
                const { data: sib } = await supabase.from('visit_services')
                    .select('status').eq('visit_id', r.visitId);
                const active = (sib || []).filter(s => s.status !== 'cancelled');
                if (active.length > 0 && active.every(s => s.status === 'completed')) visitStatus = 'completed';
            }
            const { error: vErr } = await supabase.from('visits')
                .update({ status: visitStatus }).eq('id', r.visitId);
            if (vErr) console.warn('[my-services] visit status mirror failed:', vErr);
        }
        toast(newStatus === 'in_progress' ? 'Приём начат.' : 'Услуга завершена.');
        paintBody();
        return true;
    } finally {
        if (btn.isConnected) btn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
function countByStatus(rows) {
    const c = { queued: 0, in_progress: 0, completed: 0, total: rows.length };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
}

function formatDateTime(d) { return fmtDateTime(d); }   // DATE_FMT_V1

// "Запись" column: date (+ time when the visit_date carries one).
function formatVisitDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '—';
    const date = dt.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hasTime = dt.getHours() !== 0 || dt.getMinutes() !== 0;
    return hasTime
        ? date + ' ' + dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : date;
}

// ===========================================================================
// CALENDAR VIEW — vertical timeline 08:00–19:00, status-coloured events,
// period selector (1/3/7 days), hover tooltip, "unscheduled" strip.
// (AURORA_QUEUE_V1)
// ===========================================================================
const CAL_START = 8, CAL_END = 19;          // hours
const CAL_PX_PER_MIN = 1.1;                  // grid scale
let calSpan = 1;                             // 1 | 3 | 7 days (module-local, persists across repaints)
let calTipEl = null;

function statusTone(status) {
    if (status === 'completed')   return 'is-done';
    if (status === 'in_progress') return 'is-now';
    return 'is-queue';                        // queued / anything else
}

// Minutes-from-CAL_START for a row's visitDate time, or null if it has no
// usable time (midnight = "no time").
function rowMinutes(visitDate) {
    if (!visitDate) return null;
    const dt = new Date(visitDate);
    if (isNaN(dt.getTime())) return null;
    const mins = dt.getHours() * 60 + dt.getMinutes();
    if (dt.getHours() === 0 && dt.getMinutes() === 0) return null;
    return mins - CAL_START * 60;
}

function calendarView(rows) {
    const totalMin = (CAL_END - CAL_START) * 60;
    const gridH = totalMin * CAL_PX_PER_MIN;
    const labelStep = 60;   // hourly labels

    // Build the day columns relative to today.
    const base = new Date(); base.setHours(0, 0, 0, 0);
    const days = Array.from({ length: calSpan }, (_, i) => {
        const d = new Date(base); d.setDate(base.getDate() + i);
        return {
            off:  i,
            date: d,
            wd:   d.toLocaleDateString('ru-RU', { weekday: 'short' }),
            dm:   `${d.getDate()} ${RU_MONTHS[d.getMonth()].slice(0, 3)}`,
            today: i === 0,
        };
    });

    // Assign each row to a day column by its visitDate day-offset; rows with no
    // usable time go to the unscheduled strip.
    const dayKey = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const unscheduled = [];
    const byDay = days.map(() => []);
    for (const r of rows) {
        const mins = rowMinutes(r.visitDate);
        const vd = visitDay(r.visitDate);
        let placed = false;
        if (mins != null && vd) {
            const idx = days.findIndex(d => dayKey(d.date) === vd.getTime());
            if (idx >= 0) { byDay[idx].push({ r, mins }); placed = true; }
        }
        if (!placed) unscheduled.push(r);
    }

    const gridCols = `56px repeat(${calSpan}, 1fr)`;
    const rangeLabel = calSpan === 1
        ? base.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
        : `${days[0].dm} – ${days[days.length - 1].dm}`;

    // hour-tick marks
    const ticks = [];
    for (let m = 0; m <= totalMin; m += labelStep) ticks.push(m);

    const card = h('div', { class: 'card ws-cal-card', style: { marginTop: '12px' } },
        // toolbar
        h('div', { class: 'ws-cal-toolbar' },
            h('span', { class: 'ws-cal-title' }, rangeLabel),
            h('span', { class: 'grow', style: { flex: '1' } }),
            h('div', { class: 'ws-cal-ctl' },
                h('span', { class: 'ws-cal-ctl-l' }, 'Период:'),
                h('div', { class: 'segmented' },
                    calSpanBtn(1, '1 день'),
                    calSpanBtn(3, '3 дня'),
                    calSpanBtn(7, '7 дней'),
                ),
            ),
        ),
        // legend
        h('div', { class: 'ws-cal-legend' },
            h('span', { class: 'row' }, h('span', { class: 'ws-cal-dot is-queue' }), 'В очереди'),
            h('span', { class: 'row' }, h('span', { class: 'ws-cal-dot is-now' }), 'Идёт приём'),
            h('span', { class: 'row' }, h('span', { class: 'ws-cal-dot is-done' }), 'Осмотрен'),
        ),
        // unscheduled strip
        unscheduled.length ? h('div', { class: 'ws-cal-unsched' },
            h('span', { class: 'ws-cal-unsched-l' }, 'Без времени:'),
            ...unscheduled.map(r => h('button', {
                class: 'ws-cal-pill', type: 'button',
                onclick: () => openWorkspace(r),
            },
                h('span', { class: 'ws-cal-dot ' + statusTone(r.status) }),
                r.patientName,
            )),
        ) : null,
        // multi-day column headers
        calSpan > 1 ? h('div', { class: 'ws-cal-dayhead', style: { gridTemplateColumns: gridCols, margin: '0 16px' } },
            h('div'),
            ...days.map(d => h('div', { class: 'ws-cal-dh' + (d.today ? ' today' : '') },
                h('b', null, d.wd), h('span', null, d.dm))),
        ) : null,
        // scroll body
        h('div', { class: 'ws-cal-scroll' },
            h('div', { class: 'ws-cal-grid', style: { gridTemplateColumns: gridCols, height: gridH + 'px' } },
                // time gutter
                h('div', { class: 'ws-cal-gutter', style: { height: gridH + 'px' } },
                    ...ticks.map(m => h('div', { class: 'ws-cal-tick', style: { top: (m * CAL_PX_PER_MIN) + 'px' } },
                        `${String(CAL_START + m / 60).padStart(2, '0')}:00`)),
                ),
                // day columns
                ...days.map((d, di) => h('div', { class: 'ws-cal-col', style: { height: gridH + 'px' } },
                    ...ticks.map(m => h('div', { class: 'ws-cal-line', style: { top: (m * CAL_PX_PER_MIN) + 'px' } })),
                    ...byDay[di].map(({ r, mins }) => calEvent(r, mins)),
                )),
            ),
        ),
    );
    return card;
}

function calSpanBtn(n, label) {
    return h('button', {
        class: calSpan === n ? 'on' : '',
        onclick: () => { if (calSpan === n) return; calSpan = n; paintBody(); },
    }, label);
}

function calEvent(r, mins) {
    const top = Math.max(0, mins * CAL_PX_PER_MIN);
    const dur = Number(r.duration) > 0 ? Number(r.duration) : 20;
    const height = Math.max(dur * CAL_PX_PER_MIN - 3, 18);
    const compact = height < 32;
    const timeStr = (() => {
        const dt = new Date(r.visitDate);
        return isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    })();
    return h('div', {
        class: 'ws-cal-event ' + statusTone(r.status) + (compact ? ' compact' : ''),
        style: { top: top + 'px', height: height + 'px' },
        onclick: () => { hideCalTip(); openWorkspace(r); },
        onmouseenter: (ev) => showCalTip(r, ev),
        onmousemove:  (ev) => showCalTip(r, ev),
        onmouseleave: hideCalTip,
    },
        h('div', { class: 'ce-name' }, r.patientName),
        !compact && h('div', { class: 'ce-sub' }, [timeStr, r.serviceName].filter(Boolean).join(' · ')),
    );
}

function showCalTip(r, ev) {
    hideCalTip();
    const timeStr = (() => {
        const dt = new Date(r.visitDate);
        return isNaN(dt.getTime()) ? '—' : dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    })();
    const tip = h('div', { class: 'ws-cal-tip', style: { width: '264px' } },
        h('div', { class: 'ct-name', style: { marginBottom: '8px' } }, r.patientName),
        h('div', { class: 'ct-row' }, h('span', null, 'Услуга'), h('b', null, r.serviceName)),
        h('div', { class: 'ct-row' }, h('span', null, 'Время'),  h('b', { class: 'num' }, timeStr)),
        h('div', { class: 'ct-row' }, h('span', null, 'Статус'), h('b', null, STATUS_RU[r.status] || r.status || '—')),
    );
    const vw = window.innerWidth, vh = window.innerHeight;
    const W = 264, H = 130;
    tip.style.left = Math.min(ev.clientX + 16, vw - W - 12) + 'px';
    tip.style.top  = Math.min(ev.clientY + 14, vh - H - 12) + 'px';
    document.body.appendChild(tip);
    calTipEl = tip;
}
function hideCalTip() {
    if (calTipEl) { calTipEl.remove(); calTipEl = null; }
}

// ===========================================================================
// RECS MODAL — today's recommended / completed referrals (KPI cards 3 & 4).
// (AURORA_QUEUE_V1)
// ===========================================================================
function openRecsModal(mode) {
    const all  = state.todayReferrals.rows;
    const list = mode === 'done' ? all.filter(r => referralIsDone(r.status)) : all;
    const title = mode === 'done' ? 'Выполненные рекомендации' : 'Рекомендованные услуги';
    const sub   = mode === 'done'
        ? trf('Выполнено {n} из {total} за сегодня', { n: list.length, total: all.length })
        : trf('Всего {n} рекомендованных услуг за сегодня', { n: list.length });

    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const body = h('div', { class: 'modal-body' },
        h('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub),
        list.length === 0
            ? h('div', { class: 'empty', style: { padding: '30px 20px', fontSize: '12.5px' } }, 'Нет рекомендаций за сегодня.')
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Дата'),
                    h('th', null, 'Пациент'),
                    h('th', null, 'Услуга'),
                    h('th', null, 'Статус'),
                )),
                h('tbody', null, ...list.map(r => h('tr', null,
                    h('td', { class: 'num muted', style: { fontSize: '12.5px' } }, formatDateTime(r.createdAt)),
                    h('td', null, r.patientName),
                    h('td', { class: 'cell-strong' }, r.serviceName),
                    h('td', null, referralIsDone(r.status)
                        ? tagEl('Выполнено', 'ok', 'Check')
                        : tagEl(r.status || 'Назначено', 'info', null)),
                ))),
            ),
    );

    const card = h('div', { class: 'modal-card', style: { width: '760px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('ArrowRight', { size: 16 }), ' ', title),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-primary', onclick: close }, 'Готово'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
}

// ===========================================================================
// MY DASHBOARD — salary, referral rewards, activity for one doctor.
// ===========================================================================

// Helper: convert state.dash.period into start/end ISO timestamps.
function periodRange(period) {
    const now = new Date();
    const start = new Date(now);
    if (period === 'week')       start.setDate(now.getDate() - 7);
    else if (period === 'month') start.setMonth(now.getMonth() - 1);
    else if (period === 'year')  start.setFullYear(now.getFullYear() - 1);
    else                          start.setFullYear(2000);   // 'all' — pull everything reasonable
    return { startIso: start.toISOString(), endIso: now.toISOString() };
}

async function loadDoctorsForDash() {
    const { data, error } = await supabase.from('users')
        .select('id, full_name, is_doctor, specialty, role, salary_type, salary_fixed, salary_percent, doctor_category, kpi_links, service_rates, referral_rates, license_expiry_date')
        .eq('active', true)
        .order('full_name');
    if (error) { console.warn('[dash] doctors load:', error.message); return; }
    const all = data || [];
    // Prefer rows that look like doctors (role/specialty/license), fall back
    // to everyone so demo data still shows up.
    const doctors = all.filter(u =>
        u.is_doctor === true || (u.role || '').toLowerCase() === 'doctor' || (u.specialty || '').length > 0   // ADMIN_DOCTOR_LIST_V1
    );
    let list = doctors.length ? doctors : all;
    // Doctor login → the dashboard is locked to that doctor only; other
    // doctors must not be selectable.
    const docId = scopedDoctorId();
    if (docId) {
        list = list.filter(u => u.id === docId);
        state.dash.doctorId = docId;
    }
    state.dash.doctors = list;
    if (!state.dash.doctorId && state.dash.doctors[0]) {
        state.dash.doctorId = state.dash.doctors[0].id;
    }
}

async function loadDashboardData() {
    if (!state.dash.doctorId && state.dash.doctors[0]) state.dash.doctorId = state.dash.doctors[0].id;
    const docId = state.dash.doctorId;
    if (!docId) { state.dash.loaded = true; return; }
    const { startIso, endIso } = periodRange(state.dash.period);

    // 1. Full doctor record (salary settings live here).
    const docRow = state.dash.doctors.find(d => d.id === docId) || null;
    state.dash.doctor = docRow;

    // 2. Services this doctor has worked on in the period (visit_services).
    const { data: svcs, error: svcErr } = await supabase
        .from('visit_services')
        .select(`
            id, status, quantity, unit_price, total, created_at, invoice_item_id,
            visit_id, service_id,
            services(name, tax_rate, type_id, category_id, service_categories(name), service_types(name)),
            visits(visit_date, patient_id,
                   patients(full_name, last_name, first_name, mrn))
        `)
        .eq('doctor_id', docId)
        .gte('created_at', startIso)
        .lte('created_at', endIso)
        .order('created_at', { ascending: false })
        .limit(500);
    if (svcErr) console.warn('[dash] services:', svcErr.message);
    state.dash.services = (svcs || []).map(r => ({
        id:           r.id,
        status:       r.status,
        total:        Number(r.total || (r.unit_price || 0) * (r.quantity || 1)),
        serviceId:    r.service_id,
        // DOCTOR_SHARE_AFTER_TAX_V1 — фолбэк 0, а не 12: ставка налога есть в
        // карточке услуги, и придумывать её за данные нельзя — у клиники 6%.
        taxRate:      r.services?.tax_rate != null ? Number(r.services.tax_rate) : 0,
        createdAt:    r.created_at,
        serviceName:  r.services?.name || '(removed)',
        serviceCat:   r.services?.service_categories?.name || '',
        serviceType:  r.services?.service_types?.name || '',
        patientName:  (() => {
            const p = r.visits?.patients || {};
            return [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '(unknown)';
        })(),
        patientMrn:   r.visits?.patients?.mrn || '',
        invoiceItemId: r.invoice_item_id || null,
    }));

    // DOCTOR_SHARE_AFTER_TAX_V1 — доля счётной строки в скидке счёта. Скидка
    // живёт на СЧЁТЕ, а не на услуге, поэтому её долю разносим так же, как
    // reports.js (ITEM_DISCOUNT_SQL): пропорционально сумме строки. Без этого
    // кабинет считал долю врача от суммы БЕЗ учёта скидки и показывал больше,
    // чем начислит отчёт по зарплате.
    try {
        const itemIds = [...new Set(state.dash.services.map(s => s.invoiceItemId).filter(Boolean))];
        if (itemIds.length) {
            const { data: items } = await supabase.from('invoice_items')
                .select('id, total, invoice_id').in('id', itemIds).limit(1000);
            const invIds = [...new Set((items || []).map(i => i.invoice_id).filter(Boolean))];
            const { data: invs } = invIds.length
                ? await supabase.from('invoices').select('id, subtotal, discount_amount').in('id', invIds).limit(1000)
                : { data: [] };
            const invById = new Map((invs || []).map(i => [i.id, i]));
            const discByItem = new Map();
            for (const it of (items || [])) {
                const inv = invById.get(it.invoice_id);
                const sub = Number(inv && inv.subtotal) || 0;
                const disc = Number(inv && inv.discount_amount) || 0;
                discByItem.set(it.id, sub > 0 ? disc * (Number(it.total) || 0) / sub : 0);
            }
            for (const s of state.dash.services) {
                s.discount = s.invoiceItemId ? (discByItem.get(s.invoiceItemId) || 0) : 0;
            }
        }
    } catch (e) { console.warn('[dash] discounts:', e && e.message); }

    // 3. Referrals THIS doctor made (recommended_services where recommended_by = me).
    const { data: refs, error: refErr } = await supabase
        .from('recommended_services')
        .select(`
            id, status, notes, created_at, closed_at,
            service_id, service_name, patient_id,
            services(name, price, tax_rate, type_id, category_id,
                     service_categories(name), service_types(name)),
            patients(full_name, last_name, first_name, mrn)
        `)
        .eq('recommended_by', docId)
        .gte('created_at', startIso)
        .lte('created_at', endIso)
        .order('created_at', { ascending: false })
        .limit(500);
    if (refErr) console.warn('[dash] referrals:', refErr.message);
    state.dash.referrals = (refs || []).map(r => ({
        id:           r.id,
        status:       r.status,
        createdAt:    r.created_at,
        closedAt:     r.closed_at,
        serviceId:    r.service_id,
        serviceName:  r.services?.name || r.service_name || '(removed)',
        servicePrice: Number(r.services?.price || 0),
        taxRate:      r.services?.tax_rate != null ? Number(r.services.tax_rate) : 0,   // DOCTOR_SHARE_AFTER_TAX_V1
        serviceCat:   r.services?.service_categories?.name || '',
        serviceType:  r.services?.service_types?.name || '',
        patientName:  (() => {
            const p = r.patients || {};
            return [p.last_name, p.first_name].filter(Boolean).join(' ').trim() || p.full_name || '(unknown)';
        })(),
        patientMrn:   r.patients?.mrn || '',
    }));

    // 4. Referral reward rules — DOCTOR_PAY_REFERRAL_WIRE_V1: read from users.referral_rates
    // (the consolidated source the employee editor writes), NOT the empty
    // doctor_referral_bonuses table the old code queried (always returned 0).
    const _refDoc = state.dash.doctors.find(d => String(d.id) === String(docId));
    state.dash.bonusRules = (_refDoc && Array.isArray(_refDoc.referral_rates)) ? _refDoc.referral_rates : [];

    state.dash.loaded = true;
}

// Compute one referral's commission using doctor_referral_bonuses rules.
function commissionFor(referral, rules) {
    if (!referral || !referral.serviceId) return 0;
    // DOCTOR_PAY_REFERRAL_WIRE_V1 — referral_rates shape: { service_id, fixed (per-referral UZS), percentage (% of price) }.
    const rule = (rules || []).find(r => String(r.service_id) === String(referral.serviceId));
    if (!rule) return 0;
    const fixed = Number(rule.fixed || 0);
    const pct   = Number(rule.percentage || 0);
    return fixed + Math.round(Number(referral.servicePrice || 0) * pct / 100);
}

// DOCTOR_DASHBOARD_V1 — serviceRateMap()/serviceShare() ЖИВУТ В
// doctor-dashboard.js и импортируются сверху. Здесь были их копии: две
// реализации доли врача на одном экране разошлись бы молча — дашборд
// показывал бы одну сумму за день, вкладка «Зарплата» — другую за тот же
// день, и обе выглядели бы рабочими.

// Salary breakdown for the period. The variable component is the sum of each
// completed/in-progress service's after-tax revenue times its per-service %.
function computeSalary() {
    const doc = state.dash.doctor;
    if (!doc) return { fixed: 0, variable: 0, total: 0, kind: 'none', revenue: 0 };
    const rateMap = serviceRateMap(doc);
    const earning = state.dash.services.filter(s => s.status === 'completed' || s.status === 'in_progress');
    const revenue = earning.reduce((sum, s) => sum + Number(s.total || 0), 0);
    const variableComponent = earning.reduce((sum, s) => sum + serviceShare(s, rateMap), 0);
    const fixedMonth = Number(doc.salary_fixed || 0);

    // Pro-rate the fixed portion for non-month periods (rough estimate).
    const periodMonths = state.dash.period === 'week' ? 0.25
                       : state.dash.period === 'year' ? 12
                       : state.dash.period === 'all'  ? 12
                       : 1;
    const fixedComponent = fixedMonth * periodMonths;

    // DOCTOR_PAY_KPI_WIRE_V1 — for Fix+KPI the per-service variable only counts when a
    // service-revenue KPI is ticked (Consultations/Services/Revenue/Lab/Surgeries);
    // ticking only 'Patient referrals' → no service variable (referral reward is its own line).
    // Правило одно на кабинет (perServicePayApplies, doctor-dashboard.js):
    // дашборд по нему решает, рисовать ли дневной заработок вообще.
    const _varOut = perServicePayApplies(doc) || doc.salary_type !== 'fix_plus_kpi'
        ? variableComponent : 0;
    let total = 0;
    if (doc.salary_type === 'fixed')                 total = fixedComponent;
    else if (doc.salary_type === 'fix_plus_kpi')     total = fixedComponent + _varOut;
    else                                              total = variableComponent;   // 'percentage' or unset → per-service shares
    return { fixed: fixedComponent, variable: _varOut, total, kind: doc.salary_type || 'none', revenue };
}

function computeReferralRewards() {
    const rules = state.dash.bonusRules;
    let total = 0;
    const bySector = {};      // sector → { count, commission }
    for (const ref of state.dash.referrals) {
        const c = commissionFor(ref, rules);
        const sector = ref.serviceCat || ref.serviceType || '(uncategorised)';
        const slot = bySector[sector] || (bySector[sector] = { count: 0, commission: 0 });
        slot.count++;
        slot.commission += c;
        total += c;
    }
    return { total, bySector, count: state.dash.referrals.length };
}

// ---------------------------------------------------------------------------
// DASHBOARD VIEW
// ---------------------------------------------------------------------------
function dashboardView() {
    if (state.dash.loading) {
        return h('div', { class: 'empty', style: { padding: '60px' } }, tr('Загружаем начисления…'));
    }
    const doc = state.dash.doctor;
    const docSelect = h('select', {
        onchange: (ev) => {
            state.dash.doctorId = ev.target.value;
            state.dash.loaded = false; state.dash.loading = true; paint();
            loadDashboardData().then(() => { state.dash.loading = false; paint(); });
        },
        style: { height: '34px', borderRadius: '8px', border: '1px solid var(--ink-200)', padding: '0 10px', fontSize: '13.5px', minWidth: '220px' },
    },
        ...state.dash.doctors.map(d => h('option', { value: d.id, selected: state.dash.doctorId === d.id },
            d.full_name + (d.specialty ? ' · ' + d.specialty : ''))),
    );
    const periodSeg = h('div', { class: 'segmented' },
        periodBtn('week',  '7 дней'),
        periodBtn('month', '30 дней'),
        periodBtn('year',  '12 мес'),
        periodBtn('all',   'Всё'),
    );

    const salary  = computeSalary();
    const rewards = computeReferralRewards();
    const completedCount = state.dash.services.filter(s => s.status === 'completed').length;
    const inProgressCount = state.dash.services.filter(s => s.status === 'in_progress').length;
    const uniquePatients = new Set(state.dash.services.map(s => s.patientName + '|' + s.patientMrn)).size;

    return h('div', null,
        PageHead({
            // DOCTOR_DASHBOARD_V1 — вкладка называется «Зарплата», и шапка обязана
            // говорить то же самое: два разных имени у одного экрана — это два
            // экрана в голове у врача.
            // DOCTOR_PAY_I18N_V1 — вся вкладка была написана английскими
            // литералами мимо tr(), поэтому на русском и узбекском интерфейсе
            // разбор начислений оставался английским. Исходная строка теперь
            // русская: так экран попадает под общий страж i18n-coverage, который
            // ищет ИМЕННО кириллицу и английского литерала не замечает.
            title: tr('Зарплата'),
            subtitle: doc
                ? trf('Зарплата, вознаграждения за направления и работа врача: {name}.', { name: doc.full_name })
                : tr('Врач не выбран.'),
            right: [docSelect, periodSeg],
        }),
        // KPI tiles
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '16px' } },
            kpiTile({
                label: trf('Зарплата · {period}', { period: periodLabel() }),
                value: salary.total.toLocaleString('ru-RU') + ' UZS',
                sub:   salaryKindLabel(salary.kind) + (salary.kind === 'fix_plus_kpi'
                    ? '  ·  ' + trf('оклад {fix} + переменная {variable}', {
                        fix:      Math.round(salary.fixed).toLocaleString('ru-RU'),
                        variable: Math.round(salary.variable).toLocaleString('ru-RU'),
                    })
                    : ''),
                icon:  'Wallet', color: 'var(--ok-700)',
                detailsLabel: tr('Разбор зарплаты'),
                onDetails: () => openSalaryDetails(),
            }),
            kpiTile({
                label: trf('Вознаграждения за направления · {period}', { period: periodLabel() }),
                value: rewards.total.toLocaleString('ru-RU') + ' UZS',
                sub:   trf('отправлено направлений: {n}', { n: rewards.count }),
                icon:  'ArrowRight', color: 'var(--info-700)',
                detailsLabel: tr('Разбор направлений'),
                onDetails: () => openReferralDetails(),
            }),
            kpiTile({
                label: tr('Услуг завершено'),
                value: String(completedCount),
                sub:   trf('сейчас в работе: {n}', { n: inProgressCount }),
                icon:  'Check', color: 'var(--primary-700)',
            }),
            kpiTile({
                label: tr('Пациентов принято'),
                value: String(uniquePatients),
                sub:   tr('разных пациентов за период'),
                icon:  'Patients', color: 'var(--purple-700, var(--purple-500))',
            }),
        ),
        // Salary setup on the left, full referral analytics table on the right.
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: '16px' } },
            salaryConfigCard(salary),
            referralAnalyticsCard(),
        ),
        // Recent services + recent referrals.
        h('div', { style: { display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '16px', marginTop: '16px' } },
            recentServicesCard(),
            recentReferralsCard(),
        ),
        // "Rewards by sector" mini summary — moved down per request.
        h('div', { style: { marginTop: '16px' } },
            referralBySectorCard(rewards),
        ),
    );
}

function periodBtn(id, label) {
    const on = state.dash.period === id;
    return h('button', {
        class: on ? 'on' : '',
        onclick: () => {
            if (state.dash.period === id) return;
            state.dash.period = id;
            state.dash.loaded = false; state.dash.loading = true; paint();
            loadDashboardData().then(() => { state.dash.loading = false; paint(); });
        },
    }, label);
}
function periodLabel() {
    return tr({ week: 'за 7 дней', month: 'за 30 дней', year: 'за 12 месяцев', all: 'за всё время' }[state.dash.period]);
}
function salaryKindLabel(kind) {
    return tr({ fixed: 'Оклад помесячно', percentage: 'Процент от услуг', fix_plus_kpi: 'Оклад + процент', none: 'Не настроено' }[kind]) || kind;
}

function kpiTile({ label, value, sub, icon, color, detailsLabel, onDetails }) {
    return h('div', { style: { padding: '14px 16px', border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'white', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'row', style: { gap: '8px', color } },
            Icon(icon, { size: 16 }),
            h('span', { style: { fontSize: '12.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
        ),
        h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em' } }, value),
        sub && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub),
        onDetails && h('button', {
            class: 'btn btn-outline btn-sm', onclick: onDetails,
            style: { marginTop: 'auto', alignSelf: 'flex-start' },
        }, Icon('ArrowRight', { size: 12 }), ' ', detailsLabel || tr('Подробнее')),
    );
}

function salaryConfigCard(salary) {
    const doc = state.dash.doctor;
    if (!doc) return h('div');
    return h('div', { class: 'card', style: { padding: '16px 18px' } },
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } },
            Icon('Wallet', { size: 16 }),
            h('span', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, tr('Как считается зарплата')),
        ),
        kvRow(tr('Схема'),         salaryKindLabel(salary.kind)),
        kvRow(tr('Оклад'),         trf('{sum} UZS в месяц', { sum: Number(doc.salary_fixed || 0).toLocaleString('ru-RU') })),
        kvRow(tr('Ставки по услугам'), trf('услуг задано: {n}', { n: (Array.isArray(doc.service_rates) ? doc.service_rates.filter(r => Number(r.value != null ? r.value : r.percentage) > 0).length : 0) })),
        kvRow(tr('Выручка за период'), Math.round(salary.revenue).toLocaleString('ru-RU') + ' UZS'),
        kvRow(tr('Начислено (после налога)'), Math.round(salary.variable).toLocaleString('ru-RU') + ' UZS'),
        kvRow(tr('Показатели KPI'), (doc.kpi_links || []).length
            ? (doc.kpi_links || []).join(', ')
            : '—'),
        h('div', { class: 'row', style: { gap: '8px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--ink-100)' } },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-600)' } }, tr('Итого за период:')),
            h('span', { class: 'grow' }),
            h('span', { class: 'num', style: { fontSize: '15px', fontWeight: 700, color: 'var(--ok-700)' } },
                Math.round(salary.total).toLocaleString('ru-RU') + ' UZS'),
        ),
    );
}

// Detailed referral analytics — one row per service type (or category).
// Columns: Service type · # Referred · # Arrived · Revenue (after tax) ·
// Reward for doctor. "Arrived" = recommendations the registrar attached to
// a visit (status='done'). Revenue uses the service catalog price; tax_rate
// is read from `services` when available, defaulting to 12 %.
// UNCATEGORISED_BUCKET_V1 — '(uncategorised)' — это КЛЮЧ группировки, а не
// подпись: он собирается из данных и обязан остаться одинаковым во всех трёх
// языках, иначе одна и та же корзина распалась бы на три при смене языка.
// Переводится только то, что видит человек.
const NO_SECTOR = '(uncategorised)';
function sectorLabel(name) {
    return name === NO_SECTOR ? tr('Без категории') : name;
}

function referralAnalyticsCard() {
    const rules = state.dash.bonusRules;
    // Group referrals by their service TYPE (falls back to category, then to
    // a single bucket).
    const buckets = {};
    for (const r of state.dash.referrals) {
        const key = r.serviceType || r.serviceCat || NO_SECTOR;
        const slot = buckets[key] || (buckets[key] = {
            label:       key,
            referred:    0,
            arrived:     0,
            revenue:     0,
            revenueAfter:0,
            reward:      0,
        });
        slot.referred++;
        if (r.status === 'done') {
            slot.arrived++;
            const gross = Number(r.servicePrice || 0);
            // DOCTOR_SHARE_AFTER_TAX_V1 — ставка налога берётся у самой услуги.
            // Прежние «assume 12 % VAT default» брались с потолка: у клиники
            // налог 6%, и «выручка после налога» по направлениям занижалась вдвое
            // против отчётов. Нет ставки в данных — налог не выдумываем.
            const taxPct = Number(r.taxRate ?? 0);
            const net = gross * (1 - taxPct / 100);
            slot.revenue      += gross;
            slot.revenueAfter += net;
            slot.reward       += commissionFor(r, rules);
        }
    }
    const rows = Object.values(buckets).sort((a, b) => b.reward - a.reward);

    // Totals row.
    const total = rows.reduce((acc, r) => ({
        referred:     acc.referred + r.referred,
        arrived:      acc.arrived + r.arrived,
        revenueAfter: acc.revenueAfter + r.revenueAfter,
        reward:       acc.reward + r.reward,
    }), { referred: 0, arrived: 0, revenueAfter: 0, reward: 0 });

    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('ArrowRight', { size: 16 }), ' ', tr('Разбор направлений')),
            h('div', { class: 'row', style: { gap: '10px' } },
                h('span', { class: 'muted', style: { fontSize: '12.5px' } }, periodLabel()),
                h('button', {
                    class: 'btn btn-outline btn-sm',
                    onclick: () => openReferralDetails(),
                }, tr('Открыть весь список'), ' ', Icon('ArrowRight', { size: 12 })),
            ),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '40px 20px', fontSize: '12.5px' } },
                tr('За этот период направлений нет.'))
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, tr('Вид услуги')),
                    h('th', { style: { textAlign: 'right' } }, tr('Направлено')),
                    h('th', { style: { textAlign: 'right' } }, tr('Дошли')),
                    h('th', { style: { textAlign: 'right' } }, tr('Выручка (после налога)')),
                    h('th', { style: { textAlign: 'right' } }, tr('Вознаграждение врача')),
                )),
                h('tbody', null,
                    ...rows.map(r => h('tr', null,
                        h('td', { class: 'cell-strong' }, sectorLabel(r.label)),
                        h('td', { class: 'num', style: { textAlign: 'right' } }, String(r.referred)),
                        h('td', { class: 'num', style: { textAlign: 'right' } },
                            String(r.arrived),
                            h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '4px' } },
                                r.referred ? `(${Math.round(r.arrived / r.referred * 100)}%)` : ''),
                        ),
                        h('td', { class: 'num', style: { textAlign: 'right' } },
                            Math.round(r.revenueAfter).toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '4px' } }, 'UZS')),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: 'var(--ok-700)' } },
                            r.reward.toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '4px' } }, 'UZS')),
                    )),
                    // Totals
                    h('tr', { style: { background: 'var(--ink-25)', borderTop: '2px solid var(--ink-200)' } },
                        h('td', { class: 'cell-strong' }, tr('Итого')),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right' } }, String(total.referred)),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right' } }, String(total.arrived)),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right' } },
                            Math.round(total.revenueAfter).toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '4px' } }, 'UZS')),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: 'var(--ok-700)' } },
                            total.reward.toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '4px' } }, 'UZS')),
                    ),
                ),
            ),
    );
}

function referralBySectorCard(rewards) {
    const sectors = Object.entries(rewards.bySector).sort((a, b) => b[1].commission - a[1].commission);
    return h('div', { class: 'card', style: { padding: '16px 18px' } },
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } },
            Icon('ArrowRight', { size: 16 }),
            h('span', { style: { fontSize: '13.5px', fontWeight: 700, color: 'var(--ink-900)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, tr('Вознаграждения по категориям услуг')),
        ),
        sectors.length === 0
            ? h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 0' } }, tr('За этот период направлений нет.'))
            : h('div', null, ...sectors.map(([name, s]) =>
                h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--ink-100)', gap: '10px' } },
                    h('span', { style: { fontSize: '13.5px', color: 'var(--ink-900)' } }, sectorLabel(name)),
                    h('span', { class: 'grow' }),
                    h('span', { class: 'muted num', style: { fontSize: '12.5px' } }, trf('направлений: {n}', { n: s.count })),
                    h('span', { class: 'num cell-strong', style: { fontSize: '13.5px', color: 'var(--ok-700)', minWidth: '90px', textAlign: 'right' } },
                        s.commission.toLocaleString('ru-RU') + ' UZS'),
                ),
            )),
    );
}

function recentServicesCard() {
    const rows = state.dash.services.slice(0, 8);
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Activity', { size: 16 }), ' ', tr('Последние услуги')),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, periodLabel()),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '30px 20px', fontSize: '12.5px' } }, tr('За этот период услуг нет.'))
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, tr('Когда')), h('th', null, tr('Услуга')),
                    h('th', null, tr('Пациент')), h('th', null, tr('Статус')),
                    h('th', { style: { textAlign: 'right' } }, tr('Сумма')),
                )),
                h('tbody', null, ...rows.map(s => h('tr', null,
                    h('td', { class: 'num muted', style: { fontSize: '12.5px' } }, formatDateTime(s.createdAt)),
                    h('td', { class: 'cell-strong' }, s.serviceName),
                    h('td', null, s.patientName,
                        s.patientMrn && h('div', { class: 'muted', style: { fontSize: '12.5px' } }, s.patientMrn)),
                    h('td', null, statusBadge(s.status)),
                    h('td', { class: 'num cell-strong', style: { textAlign: 'right' } }, s.total.toLocaleString('ru-RU')),
                ))),
            ),
    );
}

function recentReferralsCard() {
    const rows = state.dash.referrals.slice(0, 8);
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('ArrowRight', { size: 16 }), ' ', tr('Последние направления')),
            h('span', { class: 'muted', style: { fontSize: '12.5px' } }, periodLabel()),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '30px 20px', fontSize: '12.5px' } }, tr('За этот период направлений нет.'))
            : h('div', null, ...rows.map(r => h('div', { class: 'row', style: { padding: '10px 16px', borderTop: '1px solid var(--ink-100)', gap: '10px' } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '12.5px' } }, r.serviceName),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, r.patientName + (r.serviceCat ? ' · ' + r.serviceCat : '')),
                ),
                tagEl(referralStatusLabel(r.status),
                      r.status === 'done' ? 'ok' : r.status === 'cancelled' ? 'crit' : 'warn', null),
                h('span', { class: 'num cell-strong', style: { fontSize: '13.5px', minWidth: '80px', textAlign: 'right', color: 'var(--ok-700)' } },
                    commissionFor(r, state.dash.bonusRules).toLocaleString('ru-RU')),
            ))),
    );
}

// Состояние направления словами. Три значения — закрытый набор, поэтому
// таблица, а не цепочка тернарных операторов, повторённая в двух местах.
function referralStatusLabel(status) {
    if (status === 'done')      return tr('Дошёл');
    if (status === 'cancelled') return tr('Отменено');
    return tr('Ожидает');
}

function kvRow(k, v) {
    return h('div', { class: 'row', style: { padding: '4px 0', gap: '10px' } },
        h('span', { style: { fontSize: '12.5px', color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 } }, k),
        h('span', { class: 'grow' }),
        h('span', { style: { fontSize: '13.5px', color: 'var(--ink-900)', fontWeight: 500 } }, v),
    );
}

// ---------------------------------------------------------------------------
// SALARY DETAILS modal — filterable list of services contributing to salary.
// ---------------------------------------------------------------------------
function openSalaryDetails() {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let filterText = '';
    let statusFilter = 'all';   // all | completed | in_progress

    const body = h('div', { class: 'modal-body', style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

    function repaint() {
        clear(body);
        const salary = computeSalary();
        const doc = state.dash.doctor;
        body.append(
            h('div', { style: { padding: '12px 14px', background: 'var(--ink-25)', borderRadius: '10px', border: '1px solid var(--ink-100)' } },
                h('div', { class: 'row', style: { gap: '12px' } },
                    kvBlock(tr('Схема'), salaryKindLabel(salary.kind)),
                    kvBlock(tr('Оклад'), Math.round(salary.fixed).toLocaleString('ru-RU') + ' UZS'),
                    kvBlock(tr('Переменная часть (после налога × процент по услуге)'),
                            Math.round(salary.variable).toLocaleString('ru-RU') + ' UZS'),
                    kvBlock(tr('Итого'), Math.round(salary.total).toLocaleString('ru-RU') + ' UZS', 'var(--ok-700)'),
                ),
            ),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('input', {
                    placeholder: tr('Фильтр по услуге или пациенту…'),
                    value: filterText,
                    oninput: (e) => { filterText = e.target.value; repaintList(); },
                    style: { flex: 1, height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px' },
                }),
                h('div', { class: 'segmented' },
                    h('button', { class: statusFilter === 'all' ? 'on' : '',
                        onclick: () => { statusFilter = 'all'; repaintList(); } }, tr('Все')),
                    h('button', { class: statusFilter === 'completed' ? 'on' : '',
                        onclick: () => { statusFilter = 'completed'; repaintList(); } }, tr('Завершённые')),
                    h('button', { class: statusFilter === 'in_progress' ? 'on' : '',
                        onclick: () => { statusFilter = 'in_progress'; repaintList(); } }, tr('В работе')),
                ),
            ),
            h('div', { id: 'salary-list', style: { maxHeight: '50vh', overflow: 'auto' } }),
        );
        repaintList();
    }
    function repaintList() {
        const list = body.querySelector('#salary-list');
        if (!list) return;
        const rateMap = serviceRateMap(state.dash.doctor);
        const t = filterText.trim().toLowerCase();
        const rows = state.dash.services.filter(s => {
            if (statusFilter !== 'all' && s.status !== statusFilter) return false;
            if (t && !(s.serviceName.toLowerCase().includes(t) || s.patientName.toLowerCase().includes(t))) return false;
            return true;
        });
        clear(list);
        if (rows.length === 0) {
            list.appendChild(h('div', { class: 'empty', style: { padding: '30px', fontSize: '12.5px' } }, tr('Подходящих услуг нет.')));
            return;
        }
        list.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Когда')), h('th', null, tr('Услуга')),
                h('th', null, tr('Пациент')),
                h('th', { style: { textAlign: 'right' } }, tr('Выручка')),
                h('th', { style: { textAlign: 'right' } }, tr('После налога')),
                h('th', { style: { textAlign: 'right' } }, tr('Правило')),
                h('th', { style: { textAlign: 'right' } }, tr('Моя доля')),
            )),
            h('tbody', null, ...rows.map(s => {
                const rate = rateMap.get(String(s.serviceId));
                const tax  = s.taxRate != null ? Number(s.taxRate) : 12;
                const net  = Number(s.total || 0) * (1 - tax / 100);
                const share = Math.round(serviceShare(s, rateMap));
                const ruleParts = [];
                if (rate && rate.price) ruleParts.push(rate.price.toLocaleString('ru-RU') + ' UZS');
                if (rate && rate.percentage) ruleParts.push(rate.percentage + '%');
                const ruleLabel = ruleParts.length ? ruleParts.join(' + ') : '—';
                return h('tr', null,
                    h('td', { class: 'num muted', style: { fontSize: '12.5px' } }, formatDateTime(s.createdAt)),
                    h('td', { class: 'cell-strong' }, s.serviceName),
                    h('td', null, s.patientName),
                    h('td', { class: 'num', style: { textAlign: 'right' } }, s.total.toLocaleString('ru-RU')),
                    h('td', { class: 'num', style: { textAlign: 'right' } }, Math.round(net).toLocaleString('ru-RU')),
                    h('td', { class: 'num muted', style: { textAlign: 'right', fontSize: '12.5px' } }, ruleLabel),
                    h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: share ? 'var(--ok-700)' : 'var(--ink-400)' } }, share.toLocaleString('ru-RU')),
                );
            })),
        ));
    }

    const card = h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Wallet', { size: 16 }), ' ',
                trf('Разбор зарплаты · {period}', { period: periodLabel() })),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: close }, tr('Закрыть')),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    repaint();
}

// ---------------------------------------------------------------------------
// REFERRAL REWARDS modal — filter by sector + service.
// ---------------------------------------------------------------------------
function openReferralDetails() {
    const overlay = h('div', { class: 'modal' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    let serviceFilter = '';
    let sectorFilter  = 'all';

    const body = h('div', { class: 'modal-body', style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

    function sectors() {
        const set = new Set(['all']);
        for (const r of state.dash.referrals) set.add(r.serviceCat || r.serviceType || NO_SECTOR);
        return [...set];
    }

    function repaint() {
        clear(body);
        const rewards = computeReferralRewards();
        body.append(
            h('div', { style: { padding: '12px 14px', background: 'var(--ink-25)', borderRadius: '10px', border: '1px solid var(--ink-100)' } },
                h('div', { class: 'row', style: { gap: '12px' } },
                    kvBlock(tr('Отправлено направлений'), String(rewards.count)),
                    kvBlock(tr('Категорий услуг'),        String(Object.keys(rewards.bySector).length)),
                    kvBlock(tr('Всего вознаграждений'),   rewards.total.toLocaleString('ru-RU') + ' UZS', 'var(--ok-700)'),
                ),
            ),
            // Filters
            h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
                h('input', {
                    placeholder: tr('Фильтр по услуге или пациенту…'),
                    value: serviceFilter,
                    oninput: (e) => { serviceFilter = e.target.value; repaintList(); },
                    style: { flex: 1, minWidth: '200px', height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13.5px' },
                }),
                (() => {
                    const sel = h('select', {
                        style: { height: '34px', borderRadius: '8px', border: '1px solid var(--ink-200)', padding: '0 10px', fontSize: '13.5px' },
                        onchange: (e) => { sectorFilter = e.target.value; repaintList(); },
                    },
                        ...sectors().map(s => h('option', { value: s, selected: sectorFilter === s },
                            s === 'all' ? tr('Все категории') : sectorLabel(s))),
                    );
                    return sel;
                })(),
            ),
            h('div', { id: 'ref-list', style: { maxHeight: '50vh', overflow: 'auto' } }),
        );
        repaintList();
    }
    function repaintList() {
        const list = body.querySelector('#ref-list');
        if (!list) return;
        const t = serviceFilter.trim().toLowerCase();
        const rows = state.dash.referrals.filter(r => {
            const sec = r.serviceCat || r.serviceType || NO_SECTOR;
            if (sectorFilter !== 'all' && sec !== sectorFilter) return false;
            if (t && !(r.serviceName.toLowerCase().includes(t) || r.patientName.toLowerCase().includes(t))) return false;
            return true;
        });
        clear(list);
        if (rows.length === 0) {
            list.appendChild(h('div', { class: 'empty', style: { padding: '30px', fontSize: '12.5px' } }, tr('Подходящих направлений нет.')));
            return;
        }
        list.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, tr('Когда')),
                h('th', null, tr('Услуга')),
                h('th', null, tr('Категория')),
                h('th', null, tr('Пациент')),
                h('th', null, tr('Статус')),
                h('th', { style: { textAlign: 'right' } }, tr('Вознаграждение')),
            )),
            h('tbody', null, ...rows.map(r => {
                const c = commissionFor(r, state.dash.bonusRules);
                const sec = r.serviceCat || r.serviceType || NO_SECTOR;
                return h('tr', null,
                    h('td', { class: 'num muted', style: { fontSize: '12.5px' } }, formatDateTime(r.createdAt)),
                    h('td', { class: 'cell-strong' }, r.serviceName),
                    h('td', { class: 'muted' }, sectorLabel(sec)),
                    h('td', null, r.patientName),
                    h('td', null, tagEl(referralStatusLabel(r.status),
                                        r.status === 'done' ? 'ok' : r.status === 'cancelled' ? 'crit' : 'warn', null)),
                    h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: 'var(--ok-700)' } }, c.toLocaleString('ru-RU')),
                );
            })),
        ));
    }

    const card = h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('ArrowRight', { size: 16 }), ' ',
                trf('Вознаграждения за направления · {period}', { period: periodLabel() })),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: close }, tr('Закрыть')),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    repaint();
}

function kvBlock(label, value, color) {
    return h('div', { style: { minWidth: '140px' } },
        h('div', { class: 'muted', style: { fontSize: '12.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { class: 'num', style: { fontSize: '17px', fontWeight: 700, color: color || 'var(--ink-900)', marginTop: '2px' } }, value),
    );
}
