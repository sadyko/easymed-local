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
import { h, Icon, PageHead, toast, clear, avColor, initials, fmtDateTime } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { scopedDoctorId, selfDoctorId, scopedProviderId } from '../permissions.js';   // ADMIN_DOCTOR_V2 / SERVICE_SCOPE_V1
import { renderDoctorProfile } from './doctor-profile.js?v=btnright1';
import { openAdmissionRegistrarModal } from './admission-modal.js?v=aug17e';   // INPATIENT_TAB_V1
import { currentUser, loadPatientById } from '../data.js';

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
    // Page-level tabs: My appointments (the work queue) | My dashboard
    tab:          'appointments',
    // INPATIENT_TAB_V1 — «Стационар»: this doctor's active admissions (admins see
    // all). Lazy-loaded on first open. Inpatients live in admissions/admission_*
    // tables, so they never appear in «Мои приёмы» (visit_services-based).
    inpt: { loaded: false, loading: false, rows: [] },
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

export async function renderConsultation(container, { onNavigate } = {}) {
    containerRef = container;
    onNavigateRef = onNavigate || null;
    clear(container);
    container.appendChild(h('div', { class: 'empty', style: { padding: '40px' } }, 'Загрузка очереди…'));
    await loadServices();
    // Pre-load the doctor picker (cheap) so the Dashboard tab can render
    // immediately when clicked.
    if (state.dash.doctors.length === 0) await loadDoctorsForDash();
    paint();
    // Today's referrals feed the KPI cards (3) and (4). Loaded after the first
    // paint so the queue never waits on it; repaint once it lands.
    loadTodayReferrals().then(() => { if (state.tab === 'appointments') paint(); });
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
        .in('status', ['added', 'queued', 'in_progress', 'completed']);
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
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } },
            topTab('appointments', 'Мои приёмы',  'Activity'),
            topTab('inpatients',   'Стационар',    'Bed'),   // INPATIENT_TAB_V1
            topTab('dashboard',    'Дашборд',      'Dashboard'),
            topTab('profile',      'Мой профиль',  'User'),
        ),
        state.tab === 'profile' ? profileView() : state.tab === 'dashboard' ? dashboardView() : state.tab === 'inpatients' ? inpatientsView() : appointmentsView(),
    ));
    // The appointments table body is painted into a slot by id — only meaningful
    // when the appointments tab is the one being shown.
    if (state.tab === 'appointments') paintBody();
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
async function loadInpatients() {
    const cid = (window.CLINIC && window.CLINIC.id) || null;
    let q = supabase.from('admissions')
        .select(`
            id, admission_no, status, admission_diagnosis, admitted_at,
            patient_id, attending_doctor_id, ward_id, bed_id,
            patients(full_name, last_name, first_name, mrn, phone),
            wards(name),
            beds!admissions_bed_id_fkey(code)
        `)
        .eq('status', 'active')
        .order('admitted_at', { ascending: false })
        .limit(200);
    if (cid) q = q.eq('company_id', cid);
    const docId = scopedDoctorId();
    if (docId) q = q.eq('attending_doctor_id', docId);
    const { data, error } = await q;
    if (error) { console.warn('[inpatients]', error.message); state.inpt.rows = []; }
    else state.inpt.rows = data || [];
    state.inpt.loaded = true;
}

function inpatientsView() {
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
    if (state.inpt.loading) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '40px' } }, 'Загрузка…'));
        return wrap;
    }
    const rows = state.inpt.rows || [];
    wrap.appendChild(h('div', { class: 'row', style: { alignItems: 'center', gap: '10px' } },
        h('div', { style: { fontWeight: 700, fontSize: '14px' } }, 'Пациенты в стационаре'),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, trf('активные госпитализации: {n}', { n: rows.length })),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn btn-outline btn-sm', type: 'button', onclick: () => {
            state.inpt.loading = true; paint();
            loadInpatients().then(() => { state.inpt.loading = false; paint(); });
        } }, Icon('Refresh', { size: 13 }), ' Обновить'),
    ));
    if (!rows.length) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '40px' } },
            'Нет активных стационарных пациентов.'));
        return wrap;
    }
    for (const r of rows) {
        const p = r.patients || {};
        const nm = (p.full_name || [p.last_name, p.first_name].filter(Boolean).join(' ') || '—').trim();
        const place = [r.wards && r.wards.name, r.beds && r.beds.code ? trf('койка {code}', { code: r.beds.code }) : null].filter(Boolean).join(' · ');
        wrap.appendChild(h('button', {
            type: 'button',
            style: { display: 'flex', gap: '14px', alignItems: 'center', textAlign: 'left', width: '100%',
                     padding: '14px 16px', background: 'var(--white)', border: '1px solid var(--ink-100)',
                     borderRadius: '12px', cursor: 'pointer', fontFamily: 'inherit' },
            onclick: () => openAdmissionRegistrarModal({
                admissionId: r.id,
                onChange: () => { loadInpatients().then(paint); },
            }),
        },
            h('span', { class: 'av ' + avColor(r.patient_id || nm), style: { width: '38px', height: '38px', borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '13px', flex: 'none', background: 'var(--primary-50)', color: 'var(--primary-700)' } }, initials(nm)),
            h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontWeight: 700, fontSize: '13.5px' } }, nm,
                    h('span', { class: 'muted', style: { fontWeight: 400, fontSize: '11.5px', marginLeft: '8px' } }, p.mrn || '')),
                h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '2px' } },
                    (place || 'без койки'),
                    ' · ' + trf('поступил {date}', { date: String(r.admitted_at || '').slice(0, 10) }),
                    r.admission_diagnosis ? ' · ' + r.admission_diagnosis : ''),
            ),
            h('span', { class: 'muted', style: { fontSize: '12px', flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                'Назначения ', Icon('ArrowRight', { size: 13 })),
        ));
    }
    return wrap;
}

function topTab(id, label, icon) {
    const on = state.tab === id;
    return h('button', {
        type: 'button',
        onclick: () => {
            if (state.tab === id) return;
            state.tab = id;
            if (id === 'dashboard' && !state.dash.loaded) {
                state.dash.loading = true;
                paint();
                loadDashboardData().then(() => { state.dash.loading = false; paint(); });
            } else if (id === 'inpatients' && !state.inpt.loaded) {   // INPATIENT_TAB_V1
                state.inpt.loading = true;
                paint();
                loadInpatients().then(() => { state.inpt.loading = false; paint(); });
            } else {
                paint();
            }
        },
        style: {
            display: 'inline-flex', alignItems: 'center', gap: '8px',
            padding: '10px 18px', borderRadius: '999px',
            border: '1px solid ' + (on ? 'var(--primary-500)' : 'var(--ink-200)'),
            background: on ? 'var(--primary-50)' : 'white',
            color: on ? 'var(--primary-700)' : 'var(--ink-700)',
            fontWeight: on ? 600 : 500, fontSize: '14px',
            cursor: 'pointer', fontFamily: 'inherit',
        },
    }, Icon(icon, { size: 15 }), label);
}

// ---------------------------------------------------------------------------
// APPOINTMENTS VIEW — doctor "Очередь приёма" (greeting · KPIs · queue)
// (AURORA_QUEUE_V1)
// ---------------------------------------------------------------------------
function appointmentsView() {
    return h('div', null,
        greetBanner(),
        kpiSummary(),
        h('div', { class: 'card', id: 'svc-card' },
            h('div', { class: 'card-header' },
                h('div', { class: 'row', style: { gap: '10px', flex: '1', flexWrap: 'wrap' } },
                    h('input', {
                        placeholder: 'Поиск по ФИО, MRN, телефону, услуге…',
                        value: state.search,
                        oninput: (e) => { state.search = e.target.value; paintBody(); },
                        style: { height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px', width: '360px', maxWidth: '100%' },
                    }),
                    statusFilterSelect(),
                ),
                h('div', { class: 'muted', style: { fontSize: '12px' } },
                    'Показано ', h('b', { id: 'svc-count', style: { color: 'var(--ink-800)' } }, '0'),
                    ' из ', String(state.rows.length)),
            ),
            h('div', { id: 'svc-body' }),
        ),
    );
}

// ---- Greeting banner: time-of-day greeting + today's date + range filter ----
function greetBanner() {
    // Kill any previous interval so navigating between My services and
    // other tabs (or rerendering this view) never stacks ticks.
    if (_docClockTimer) { clearInterval(_docClockTimer); _docClockTimer = null; }

    const u = currentUser();
    const firstName = ((u && (u.full_name || u.username)) || '').trim().split(/\s+/)[0] || 'доктор';
    const now = new Date();
    const hh = now.getHours();
    const greetPart = hh < 12 ? 'Доброе утро' : hh < 18 ? 'Добрый день' : 'Добрый вечер';
    const greetLine = `${greetPart}, ${firstName}!`;

    // Live clock element — same pattern as registrarHeader: a <b> we
    // mutate textContent on every tick, self-destructing if it leaves the
    // DOM (so view changes auto-clean it).
    const timeB = h('b', { class: 'num' }, ruTimeLabel(now));
    _docClockTimer = setInterval(() => {
        if (!timeB.isConnected) { clearInterval(_docClockTimer); _docClockTimer = null; return; }
        timeB.textContent = ruTimeLabel(new Date());
    }, 1000);

    const RANGES = [
        { id: 'today', label: 'Сегодня' },
        { id: 'week',  label: 'Неделя' },
        { id: 'month', label: 'Месяц' },
        { id: 'all',   label: 'Период' },
    ];
    const tabBtn = (r) => h('button', {
        class: 'segmented-btn' + (state.dateRange === r.id ? ' on' : ''),
        type: 'button',
        onclick: () => { if (state.dateRange === r.id) return; state.dateRange = r.id; paint(); },
    }, h('span', null, r.label));

    return h('div', { class: 'reg-greet' },
        // LEFT — role id + greeting + warm message (doctor-flavoured).
        h('div', { class: 'reg-greet-main' },
            h('div', { class: 'reg-greet-id' },
                h('div', { class: 'reg-greet-title' }, 'Кабинет врача'),
                h('div', { class: 'reg-greet-sub' }, 'Очередь приёма · приёмная'),
            ),
            h('div', { class: 'reg-greet-msg' },
                h('div', { class: 'reg-greet-hello' }, greetLine),
                h('div', { class: 'reg-greet-warm' },
                    'Каждый пациент — это история, которую вы слушаете. Ваша внимательность, точный диагноз и спокойная манера лечат не меньше препаратов. Спасибо за то, что вы делаете каждый день.',
                ),
            ),
        ),
        // RIGHT — live clock + RU date, then the 4 range tabs.
        h('div', { class: 'reg-greet-ctrl' },
            h('div', { class: 'reg-now' },
                h('span', { class: 'reg-now-date' }, Icon('Calendar', { size: 14 }), h('span', null, ruDateLabel(now))),
                h('span', { class: 'reg-now-time' }, Icon('Clock', { size: 14 }), timeB),
            ),
            h('div', { class: 'segmented reg-viewtabs' }, ...RANGES.map(tabBtn)),
        ),
    );
}

// ---- Local RU date / time formatters (mirror registrar-header.js so the
// greeting banner here renders identically to the registrar's). Kept inline
// to avoid an import cycle between consultation.js and registrar-header.js.
const _RU_WD = ['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
const _RU_MO = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const _zz = (n) => String(n).padStart(2, '0');
function ruDateLabel(d) { return `${_RU_WD[d.getDay()]}, ${d.getDate()} ${_RU_MO[d.getMonth()]} ${d.getFullYear()}`; }
function ruTimeLabel(d) { return `${_zz(d.getHours())}:${_zz(d.getMinutes())}:${_zz(d.getSeconds())}`; }
let _docClockTimer = null;

function rangeBtn(id, label) {
    return h('button', {
        class: state.dateRange === id ? 'on' : '',
        onclick: () => { if (state.dateRange === id) return; state.dateRange = id; paint(); },
    }, label);
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
        style: { height: '34px', borderRadius: '8px', border: '1px solid var(--ink-200)', padding: '0 10px', fontSize: '13px' },
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
                    r.patientMrn && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.patientMrn),
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
                nameLink(r, { fontSize: '14px' }),
                h('div', { class: 'muted', style: { fontSize: '11.5px' } },
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
            h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '2px' } },
                // DOCTOR_ROOM_V1
                r.doctorName + (r.doctorSpecialty ? ' · ' + r.doctorSpecialty : '')
                + (r.doctorRoom ? ' · ' + trf('Кабинет {room}', { room: r.doctorRoom }) + (r.doctorFloor ? ' · ' + trf('Этаж {n}', { n: r.doctorFloor }) : '') : '')),
            h('div', { class: 'row', style: { marginTop: '8px', gap: '10px' } },
                h('span', { class: 'num cell-strong', style: { fontSize: '13px' } },
                    Number(r.price || 0).toLocaleString('ru-RU') + ' UZS'),
                h('span', { class: 'grow' }),
                h('span', { class: 'muted', style: { fontSize: '11.5px' } }, formatDateTime(r.createdAt)),
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
                    h('td', { class: 'num muted', style: { fontSize: '11.5px' } }, formatDateTime(r.createdAt)),
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

// Map of service_id → the doctor's pay rule for it (from users.service_rates,
// set in the "Services performed" list): { price, percentage }. Tolerates the
// older {percentage} and {mode,value} shapes.
function serviceRateMap() {
    const m = new Map();
    const rates = Array.isArray(state.dash.doctor?.service_rates) ? state.dash.doctor.service_rates : [];
    for (const r of rates) if (r && r.service_id != null) {
        let price      = Number(r.price) || 0;
        // RATES_PCT_ALIAS_V1 — принимаем и `percentage` (employee-editor), и
        // `pct` (быстрое назначение услуг в «Сотрудниках»): из-за расхождения
        // ключей дашборд считал ставку 0% и зарплата с услуг не показывалась.
        let percentage = Number(r.percentage != null ? r.percentage : r.pct) || 0;
        if (!price && r.mode === 'fixed' && r.value != null)      price = Number(r.value) || 0;
        if (!percentage && r.mode !== 'fixed' && r.value != null) percentage = Number(r.value) || 0;
        m.set(String(r.service_id), { price, percentage });
    }
    return m;
}

// One service's contribution to the doctor's pay. DOCTOR_SHARE_AFTER_TAX_V1 —
// тот же порядок, что в отчётах (reports.js ITEM_FEE_SQL):
//   база = сумма строки − скидка;  налог = база × ставка;  доля = (база − налог) × %
// Фиксированная ставка добавляется как есть — она за единицу и налогом не режется.
//
// Ставка налога — своя у услуги. Прежний фолбэк 12% брался с потолка: у клиники
// налог 6%, и услуга без проставленной ставки занижала долю врача вдвое против
// отчёта. Нет ставки — считаем 0 и не выдумываем налог, которого нет в данных.
function serviceShare(s, rateMap) {
    const rate = rateMap.get(String(s.serviceId));
    if (!rate) return 0;
    const base = Math.max(0, Number(s.total || 0) - Number(s.discount || 0));
    const taxRate = s.taxRate != null ? Number(s.taxRate) : 0;
    const net = base * (1 - taxRate / 100);
    return (rate.price || 0) + net * (rate.percentage || 0) / 100;
}

// Salary breakdown for the period. The variable component is the sum of each
// completed/in-progress service's after-tax revenue times its per-service %.
function computeSalary() {
    const doc = state.dash.doctor;
    if (!doc) return { fixed: 0, variable: 0, total: 0, kind: 'none', revenue: 0 };
    const rateMap = serviceRateMap();
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
    const _kpis = new Set(Array.isArray(doc.kpi_links) ? doc.kpi_links : []);
    const _svcKpi = ['consultations', 'services', 'revenue', 'lab_tests', 'surgeries'].some(k => _kpis.has(k));
    const _varOut = (doc.salary_type === 'fix_plus_kpi' && !_svcKpi) ? 0 : variableComponent;
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
        return h('div', { class: 'empty', style: { padding: '60px' } }, 'Loading dashboard…');
    }
    const doc = state.dash.doctor;
    const docSelect = h('select', {
        onchange: (ev) => {
            state.dash.doctorId = ev.target.value;
            state.dash.loaded = false; state.dash.loading = true; paint();
            loadDashboardData().then(() => { state.dash.loading = false; paint(); });
        },
        style: { height: '34px', borderRadius: '8px', border: '1px solid var(--ink-200)', padding: '0 10px', fontSize: '13px', minWidth: '220px' },
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
            title: 'My dashboard',
            subtitle: doc
                ? `Salary, referral rewards and activity for ${doc.full_name}.`
                : 'No doctor selected.',
            right: [docSelect, periodSeg],
        }),
        // KPI tiles
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px', marginBottom: '16px' } },
            kpiTile({
                label: 'Salary · ' + periodLabel(),
                value: salary.total.toLocaleString('ru-RU') + ' UZS',
                sub:   salaryKindLabel(salary.kind) + (salary.kind === 'fix_plus_kpi'
                    ? `  ·  fix ${Math.round(salary.fixed).toLocaleString('ru-RU')} + var ${Math.round(salary.variable).toLocaleString('ru-RU')}`
                    : ''),
                icon:  'Wallet', color: 'var(--ok-700)',
                detailsLabel: 'Salary details',
                onDetails: () => openSalaryDetails(),
            }),
            kpiTile({
                label: 'Referral rewards · ' + periodLabel(),
                value: rewards.total.toLocaleString('ru-RU') + ' UZS',
                sub:   `${rewards.count} referral${rewards.count === 1 ? '' : 's'} sent`,
                icon:  'ArrowRight', color: 'var(--info-700)',
                detailsLabel: 'Referral details',
                onDetails: () => openReferralDetails(),
            }),
            kpiTile({
                label: 'Services completed',
                value: String(completedCount),
                sub:   inProgressCount + ' currently in progress',
                icon:  'Check', color: 'var(--primary-700)',
            }),
            kpiTile({
                label: 'Patients seen',
                value: String(uniquePatients),
                sub:   'unique patients in period',
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
    return { week: 'last 7 days', month: 'last 30 days', year: 'last 12 months', all: 'all time' }[state.dash.period];
}
function salaryKindLabel(kind) {
    return { fixed: 'Fixed monthly', percentage: 'Variable (%)', fix_plus_kpi: 'Fix + KPI', none: 'Not configured' }[kind] || kind;
}

function kpiTile({ label, value, sub, icon, color, detailsLabel, onDetails }) {
    return h('div', { style: { padding: '14px 16px', border: '1px solid var(--ink-100)', borderRadius: '12px', background: 'white', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { class: 'row', style: { gap: '8px', color } },
            Icon(icon, { size: 16 }),
            h('span', { style: { fontSize: '11.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
        ),
        h('div', { class: 'num', style: { fontSize: '24px', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em' } }, value),
        sub && h('div', { class: 'muted', style: { fontSize: '11.5px' } }, sub),
        onDetails && h('button', {
            class: 'btn btn-outline btn-sm', onclick: onDetails,
            style: { marginTop: 'auto', alignSelf: 'flex-start' },
        }, Icon('ArrowRight', { size: 12 }), ' ', detailsLabel || 'Details'),
    );
}

function salaryConfigCard(salary) {
    const doc = state.dash.doctor;
    if (!doc) return h('div');
    return h('div', { class: 'card', style: { padding: '16px 18px' } },
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px' } },
            Icon('Wallet', { size: 16 }),
            h('span', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Salary setup'),
        ),
        kvRow('Plan',          salaryKindLabel(salary.kind)),
        kvRow('Fixed amount',  Number(doc.salary_fixed || 0).toLocaleString('ru-RU') + ' UZS / month'),
        kvRow('Per-service rates', (Array.isArray(doc.service_rates) ? doc.service_rates.filter(r => Number(r.value != null ? r.value : r.percentage) > 0).length : 0) + ' service(s) set'),
        kvRow('Revenue (period)', Math.round(salary.revenue).toLocaleString('ru-RU') + ' UZS'),
        kvRow('Earned (after tax)', Math.round(salary.variable).toLocaleString('ru-RU') + ' UZS'),
        kvRow('KPI links',     (doc.kpi_links || []).length
            ? (doc.kpi_links || []).join(', ')
            : '—'),
        h('div', { class: 'row', style: { gap: '8px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--ink-100)' } },
            h('span', { style: { fontSize: '12.5px', color: 'var(--ink-600)' } }, 'Total this period:'),
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
function referralAnalyticsCard() {
    const rules = state.dash.bonusRules;
    // Group referrals by their service TYPE (falls back to category, then to
    // a single bucket).
    const buckets = {};
    for (const r of state.dash.referrals) {
        const key = r.serviceType || r.serviceCat || '(uncategorised)';
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
            h('h3', null, Icon('ArrowRight', { size: 16 }), ' Referral analytics'),
            h('div', { class: 'row', style: { gap: '10px' } },
                h('span', { class: 'muted', style: { fontSize: '12px' } }, periodLabel()),
                h('button', {
                    class: 'btn btn-outline btn-sm',
                    onclick: () => openReferralDetails(),
                }, 'Open full list ', Icon('ArrowRight', { size: 12 })),
            ),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '40px 20px', fontSize: '12.5px' } },
                'No referrals in this period.')
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Service type'),
                    h('th', { style: { textAlign: 'right' } }, '# Referred'),
                    h('th', { style: { textAlign: 'right' } }, '# Arrived'),
                    h('th', { style: { textAlign: 'right' } }, 'Revenue (after tax)'),
                    h('th', { style: { textAlign: 'right' } }, 'Doctor reward'),
                )),
                h('tbody', null,
                    ...rows.map(r => h('tr', null,
                        h('td', { class: 'cell-strong' }, r.label),
                        h('td', { class: 'num', style: { textAlign: 'right' } }, String(r.referred)),
                        h('td', { class: 'num', style: { textAlign: 'right' } },
                            String(r.arrived),
                            h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '4px' } },
                                r.referred ? `(${Math.round(r.arrived / r.referred * 100)}%)` : ''),
                        ),
                        h('td', { class: 'num', style: { textAlign: 'right' } },
                            Math.round(r.revenueAfter).toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '4px' } }, 'UZS')),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: 'var(--ok-700)' } },
                            r.reward.toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '4px' } }, 'UZS')),
                    )),
                    // Totals
                    h('tr', { style: { background: 'var(--ink-25)', borderTop: '2px solid var(--ink-200)' } },
                        h('td', { class: 'cell-strong' }, 'Total'),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right' } }, String(total.referred)),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right' } }, String(total.arrived)),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right' } },
                            Math.round(total.revenueAfter).toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '4px' } }, 'UZS')),
                        h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: 'var(--ok-700)' } },
                            total.reward.toLocaleString('ru-RU'),
                            h('span', { class: 'muted', style: { fontSize: '11px', marginLeft: '4px' } }, 'UZS')),
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
            h('span', { style: { fontSize: '13px', fontWeight: 700, color: 'var(--ink-900)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Rewards by sector'),
        ),
        sectors.length === 0
            ? h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 0' } }, 'No referrals in this period.')
            : h('div', null, ...sectors.map(([name, s]) =>
                h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--ink-100)', gap: '10px' } },
                    h('span', { style: { fontSize: '13px', color: 'var(--ink-900)' } }, name),
                    h('span', { class: 'grow' }),
                    h('span', { class: 'muted num', style: { fontSize: '11.5px' } }, s.count + ' ref'),
                    h('span', { class: 'num cell-strong', style: { fontSize: '13px', color: 'var(--ok-700)', minWidth: '90px', textAlign: 'right' } },
                        s.commission.toLocaleString('ru-RU') + ' UZS'),
                ),
            )),
    );
}

function recentServicesCard() {
    const rows = state.dash.services.slice(0, 8);
    return h('div', { class: 'card' },
        h('div', { class: 'card-header' },
            h('h3', null, Icon('Activity', { size: 16 }), ' Recent services'),
            h('span', { class: 'muted', style: { fontSize: '12px' } }, periodLabel()),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '30px 20px', fontSize: '12.5px' } }, 'No services in this period.')
            : h('table', { class: 'tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'When'), h('th', null, 'Service'),
                    h('th', null, 'Patient'), h('th', null, 'Status'),
                    h('th', { style: { textAlign: 'right' } }, 'Amount'),
                )),
                h('tbody', null, ...rows.map(s => h('tr', null,
                    h('td', { class: 'num muted', style: { fontSize: '11.5px' } }, formatDateTime(s.createdAt)),
                    h('td', { class: 'cell-strong' }, s.serviceName),
                    h('td', null, s.patientName,
                        s.patientMrn && h('div', { class: 'muted', style: { fontSize: '11px' } }, s.patientMrn)),
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
            h('h3', null, Icon('ArrowRight', { size: 16 }), ' Recent referrals'),
            h('span', { class: 'muted', style: { fontSize: '12px' } }, periodLabel()),
        ),
        rows.length === 0
            ? h('div', { class: 'empty', style: { padding: '30px 20px', fontSize: '12.5px' } }, 'No referrals in this period.')
            : h('div', null, ...rows.map(r => h('div', { class: 'row', style: { padding: '10px 16px', borderTop: '1px solid var(--ink-100)', gap: '10px' } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { class: 'cell-strong', style: { fontSize: '12.5px' } }, r.serviceName),
                    h('div', { class: 'muted', style: { fontSize: '11.5px' } }, r.patientName + (r.serviceCat ? ' · ' + r.serviceCat : '')),
                ),
                tagEl(r.status === 'done' ? 'Done' : r.status === 'cancelled' ? 'Cancelled' : 'Pending',
                      r.status === 'done' ? 'ok' : r.status === 'cancelled' ? 'crit' : 'warn', null),
                h('span', { class: 'num cell-strong', style: { fontSize: '13px', minWidth: '80px', textAlign: 'right', color: 'var(--ok-700)' } },
                    commissionFor(r, state.dash.bonusRules).toLocaleString('ru-RU')),
            ))),
    );
}

function kvRow(k, v) {
    return h('div', { class: 'row', style: { padding: '4px 0', gap: '10px' } },
        h('span', { style: { fontSize: '11.5px', color: 'var(--ink-500)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 } }, k),
        h('span', { class: 'grow' }),
        h('span', { style: { fontSize: '13px', color: 'var(--ink-900)', fontWeight: 500 } }, v),
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
                    kvBlock('Plan',     salaryKindLabel(salary.kind)),
                    kvBlock('Fixed',    Math.round(salary.fixed).toLocaleString('ru-RU') + ' UZS'),
                    kvBlock('Variable (after-tax × per-service %)',
                            Math.round(salary.variable).toLocaleString('ru-RU') + ' UZS'),
                    kvBlock('Total',    Math.round(salary.total).toLocaleString('ru-RU') + ' UZS', 'var(--ok-700)'),
                ),
            ),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('input', {
                    placeholder: 'Filter by service / patient name…',
                    value: filterText,
                    oninput: (e) => { filterText = e.target.value; repaintList(); },
                    style: { flex: 1, height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px' },
                }),
                h('div', { class: 'segmented' },
                    h('button', { class: statusFilter === 'all' ? 'on' : '',
                        onclick: () => { statusFilter = 'all'; repaintList(); } }, 'All'),
                    h('button', { class: statusFilter === 'completed' ? 'on' : '',
                        onclick: () => { statusFilter = 'completed'; repaintList(); } }, 'Completed'),
                    h('button', { class: statusFilter === 'in_progress' ? 'on' : '',
                        onclick: () => { statusFilter = 'in_progress'; repaintList(); } }, 'In progress'),
                ),
            ),
            h('div', { id: 'salary-list', style: { maxHeight: '50vh', overflow: 'auto' } }),
        );
        repaintList();
    }
    function repaintList() {
        const list = body.querySelector('#salary-list');
        if (!list) return;
        const rateMap = serviceRateMap();
        const t = filterText.trim().toLowerCase();
        const rows = state.dash.services.filter(s => {
            if (statusFilter !== 'all' && s.status !== statusFilter) return false;
            if (t && !(s.serviceName.toLowerCase().includes(t) || s.patientName.toLowerCase().includes(t))) return false;
            return true;
        });
        clear(list);
        if (rows.length === 0) {
            list.appendChild(h('div', { class: 'empty', style: { padding: '30px', fontSize: '12.5px' } }, 'No matching services.'));
            return;
        }
        list.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'When'), h('th', null, 'Service'),
                h('th', null, 'Patient'),
                h('th', { style: { textAlign: 'right' } }, 'Revenue'),
                h('th', { style: { textAlign: 'right' } }, 'After tax'),
                h('th', { style: { textAlign: 'right' } }, 'Rule'),
                h('th', { style: { textAlign: 'right' } }, 'My share'),
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
                    h('td', { class: 'num muted', style: { fontSize: '11.5px' } }, formatDateTime(s.createdAt)),
                    h('td', { class: 'cell-strong' }, s.serviceName),
                    h('td', null, s.patientName),
                    h('td', { class: 'num', style: { textAlign: 'right' } }, s.total.toLocaleString('ru-RU')),
                    h('td', { class: 'num', style: { textAlign: 'right' } }, Math.round(net).toLocaleString('ru-RU')),
                    h('td', { class: 'num muted', style: { textAlign: 'right', fontSize: '11.5px' } }, ruleLabel),
                    h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: share ? 'var(--ok-700)' : 'var(--ink-400)' } }, share.toLocaleString('ru-RU')),
                );
            })),
        ));
    }

    const card = h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('Wallet', { size: 16 }), ' Salary details · ', periodLabel()),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: close }, 'Close'),
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
        for (const r of state.dash.referrals) set.add(r.serviceCat || r.serviceType || '(uncategorised)');
        return [...set];
    }

    function repaint() {
        clear(body);
        const rewards = computeReferralRewards();
        body.append(
            h('div', { style: { padding: '12px 14px', background: 'var(--ink-25)', borderRadius: '10px', border: '1px solid var(--ink-100)' } },
                h('div', { class: 'row', style: { gap: '12px' } },
                    kvBlock('Referrals sent', String(rewards.count)),
                    kvBlock('Sectors',        String(Object.keys(rewards.bySector).length)),
                    kvBlock('Total rewards',  rewards.total.toLocaleString('ru-RU') + ' UZS', 'var(--ok-700)'),
                ),
            ),
            // Filters
            h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
                h('input', {
                    placeholder: 'Filter by service / patient name…',
                    value: serviceFilter,
                    oninput: (e) => { serviceFilter = e.target.value; repaintList(); },
                    style: { flex: 1, minWidth: '200px', height: '34px', padding: '0 12px', border: '1px solid var(--ink-200)', borderRadius: '8px', fontSize: '13px' },
                }),
                (() => {
                    const sel = h('select', {
                        style: { height: '34px', borderRadius: '8px', border: '1px solid var(--ink-200)', padding: '0 10px', fontSize: '13px' },
                        onchange: (e) => { sectorFilter = e.target.value; repaintList(); },
                    },
                        ...sectors().map(s => h('option', { value: s, selected: sectorFilter === s }, s === 'all' ? 'All sectors' : s)),
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
            const sec = r.serviceCat || r.serviceType || '(uncategorised)';
            if (sectorFilter !== 'all' && sec !== sectorFilter) return false;
            if (t && !(r.serviceName.toLowerCase().includes(t) || r.patientName.toLowerCase().includes(t))) return false;
            return true;
        });
        clear(list);
        if (rows.length === 0) {
            list.appendChild(h('div', { class: 'empty', style: { padding: '30px', fontSize: '12.5px' } }, 'No matching referrals.'));
            return;
        }
        list.appendChild(h('table', { class: 'tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'When'),
                h('th', null, 'Service'),
                h('th', null, 'Sector'),
                h('th', null, 'Patient'),
                h('th', null, 'Status'),
                h('th', { style: { textAlign: 'right' } }, 'Commission'),
            )),
            h('tbody', null, ...rows.map(r => {
                const c = commissionFor(r, state.dash.bonusRules);
                const sec = r.serviceCat || r.serviceType || '(uncategorised)';
                return h('tr', null,
                    h('td', { class: 'num muted', style: { fontSize: '11.5px' } }, formatDateTime(r.createdAt)),
                    h('td', { class: 'cell-strong' }, r.serviceName),
                    h('td', { class: 'muted' }, sec),
                    h('td', null, r.patientName),
                    h('td', null, tagEl(r.status === 'done' ? 'Done' : r.status === 'cancelled' ? 'Cancelled' : 'Pending',
                                        r.status === 'done' ? 'ok' : r.status === 'cancelled' ? 'crit' : 'warn', null)),
                    h('td', { class: 'num cell-strong', style: { textAlign: 'right', color: 'var(--ok-700)' } }, c.toLocaleString('ru-RU')),
                );
            })),
        ));
    }

    const card = h('div', { class: 'modal-card', style: { width: '900px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 60px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head' },
            h('h2', null, Icon('ArrowRight', { size: 16 }), ' Referral rewards · ', periodLabel()),
            h('button', { class: 'modal-close', onclick: close }, '×'),
        ),
        body,
        h('footer', { class: 'modal-foot' },
            h('span', { class: 'grow' }),
            h('button', { class: 'btn', onclick: close }, 'Close'),
        ),
    );
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    repaint();
}

function kvBlock(label, value, color) {
    return h('div', { style: { minWidth: '140px' } },
        h('div', { class: 'muted', style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 } }, label),
        h('div', { class: 'num', style: { fontSize: '16px', fontWeight: 700, color: color || 'var(--ink-900)', marginTop: '2px' } }, value),
    );
}
