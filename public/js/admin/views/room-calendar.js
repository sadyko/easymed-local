// Resource calendar — «Календарь записи» (registrar panel).
// Aurora «Экран C» structure + functions in EasyMed skin/data: left rail picks
// doctors OR rooms (Врачи | Кабинеты, направление + search), main grid = selected
// resources × days with per-slot booking, off-hours shading, status-colored blocks,
// hover tooltip, drag-to-move/resize (snap to step, commits to visits), and an
// appointment modal with live status pills (Подтверждён / Пришёл / Не пришёл / Отменён).
// Booking reuses the 3-step wizard (calculator → BOOK_WIZARD_V1). RESCAL_V2 / RESCAL_V3.
import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, initials, avColor, Avatar } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { loadPatientById } from '../data.js';
import { loadClinicHours, clampToClinic } from '../clinic-hours.js?v=ch1';   // WORKING_HOURS_CLINIC_BOUND_V1
import { openServicePickerModal } from './service-picker-modal.js?v=aug17e';   // RESCAL_WIRE_V1 — same URL as other importers (one instance)
import { registrarHeader } from './registrar-header.js?v=aurora5';               // RESCAL_V3 — same URL as patients.js (one instance)

const DAY_START = 8 * 60;     // 08:00
const DAY_END   = 20 * 60;    // 20:00
const WD_KEY    = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RU_MO = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const RU_WD_L = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const RU_WD_S = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const STATUS_META = {
    requested: { label: 'Заявка',       color: 'var(--purple-700)' },   // SYMPTEX_REQUESTED — Symptex booking awaiting confirm
    planned:   { label: 'Запланирован', color: 'var(--primary-600)' },
    confirmed: { label: 'Подтверждён',  color: 'var(--info-700)' },
    arrived:   { label: 'Пришёл',       color: 'var(--ok-700)' },
    done:      { label: 'Завершён',     color: 'var(--ink-400)' },
    noshow:    { label: 'Не пришёл',    color: 'var(--warn-700)' },
    cancelled: { label: 'Отменён',      color: 'var(--ink-300)' },
};
// Display buckets the registrar may SET from the calendar, and the raw
// visits.status each writes. Clinical statuses (done) are set by doctor flows.
const SETTABLE = ['planned', 'confirmed', 'arrived', 'noshow', 'cancelled'];
const BUCKET_RAW = { planned: 'scheduled', confirmed: 'confirmed', arrived: 'arrived', noshow: 'no_show', cancelled: 'cancelled' };

function mapStatus(s) {
    s = (s || '').toLowerCase();
    if (s === 'requested') return 'requested';   // SYMPTEX_REQUESTED
    if (['scheduled', 'registered', 'draft'].includes(s)) return 'planned';
    // RESCAL_V3 — raw 'confirmed' was missing here, so confirmed visits painted as planned.
    if (['confirmed', 'awaiting_payment', 'paid', 'in_queue'].includes(s)) return 'confirmed';
    if (['arrived', 'in_progress', 'in_consultation'].includes(s)) return 'arrived';
    if (['completed', 'concluded', 'closed', 'done'].includes(s)) return 'done';
    if (s === 'no_show') return 'noshow';
    if (s === 'cancelled') return 'cancelled';
    return 'planned';
}

function isoToLocalDay(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1); }
function dateToIso(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
function todayIso() { return dateToIso(new Date()); }
function minutesOfLocal(dt) { return dt.getHours() * 60 + dt.getMinutes(); }
function fmtHM(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function ruDay(iso) { const d = isoToLocalDay(iso); return `${RU_WD_L[d.getDay()]}, ${d.getDate()} ${RU_MO[d.getMonth()]} ${d.getFullYear()}`; }
function shortBranch(name) {
    const n = String(name || '').trim(); if (!n) return '';
    const words = n.split(/\s+/);
    return (words.length > 1 ? words.map(w => w[0]).join('') : n.slice(0, 3)).toUpperCase().slice(0, 4);
}
// Working window for a resource on a weekday (minutes). null => off all day.
function workRange(hours, dayIso, branchId) {
    let base;
    if (!hours || typeof hours !== 'object') base = { from: DAY_START, to: DAY_END };
    else {
        const slot = hours[WD_KEY[isoToLocalDay(dayIso).getDay()]];
        if (!slot || slot.enabled === false) return null;
        const p = (s) => { const [hh, mm] = String(s || '').split(':').map(Number); return (hh || 0) * 60 + (mm || 0); };
        const from = slot.from ? p(slot.from) : DAY_START, to = slot.to ? p(slot.to) : DAY_END;
        base = to > from ? { from, to } : null;
    }
    return clampToClinic(base, branchId, dayIso);   // WORKING_HOURS_CLINIC_BOUND_V1 — bound by clinic hours
}
const pxPerMin = (step) => (step <= 10 ? 16 : step <= 15 ? 22 : 34) / step;

export async function renderRoomCalendar(container, { onNavigate, embedded = false } = {}) {
    const state = {
        resType: 'doctor', napr: '', q: '', step: 15, period: 1,
        dayIso: todayIso(), showCancelled: false,
        doctors: [], rooms: [], servicesList: [], appts: [], selected: new Set(), loaded: false,
    };

    clear(container);
    const wrap = h('div', { class: 'fade-in' });
    container.appendChild(wrap);
    // RESCAL_V3 — the Aurora greeting band + view tabs sit above the calendar
    // (mirrors patients.js; skipped when embedded in a parent that draws its own).
    if (!embedded) wrap.appendChild(registrarHeader({ active: 'appointments', onNavigate }));
    const root = h('div', { class: 'rcal' });
    wrap.appendChild(root);

    // ---- data ----
    async function loadResources() {
        let doctors = [], rooms = [], servicesList = [], floorBranch = {}, branchLabel = {};
        await loadClinicHours();   // WORKING_HOURS_CLINIC_BOUND_V1
        const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1 — scope to this clinic (super-admin JWT passes RLS everywhere)
        try {
            const [brs, floors, rms, docs, svcs] = await Promise.all([
                supabase.from('branches').select('id, name_ru, name').eq('company_id', cid),
                supabase.from('floors').select('id, branch_id').eq('company_id', cid).eq('active', true),
                supabase.from('rooms').select('id, name, code, floor_id, room_type, working_hours, department_id').eq('company_id', cid).eq('active', true).order('code', { ascending: true }),
                supabase.from('users').select('id, full_name, specialty, role, branch_id, working_hours, is_doctor').eq('company_id', cid).eq('active', true).order('full_name', { ascending: true }),
                supabase.from('services').select('id, name, duration_minutes, department_id').eq('company_id', cid).eq('active', true).order('name', { ascending: true }),
            ]);
            for (const b of ((brs && brs.data) || [])) branchLabel[b.id] = shortBranch(b.name_ru || b.name || '');
            for (const f of ((floors && floors.data) || [])) floorBranch[f.id] = f.branch_id;
            rooms = ((rms && rms.data) || []).map(r => ({ id: r.id, name: r.name || trf('Каб. {code}', { code: r.code || '' }), spec: r.room_type || 'кабинет', napr: r.room_type || '—', branch: branchLabel[floorBranch[r.floor_id]] || '', branchId: floorBranch[r.floor_id], deptId: r.department_id, hours: r.working_hours }));
            doctors = ((docs && docs.data) || []).filter(u => u.is_doctor === true || (u.role || '').toLowerCase() === 'doctor' || (u.specialty || '').trim())   // ADMIN_DOCTOR_LIST_V1
                .map(u => ({ id: u.id, name: u.full_name || '—', spec: u.specialty || 'врач', napr: u.specialty || '—', branch: branchLabel[u.branch_id] || '', branchId: u.branch_id, hours: u.working_hours }));
            servicesList = ((svcs && svcs.data) || []).map(s => ({ id: s.id, name: s.name || '—', dur: s.duration_minutes, deptId: s.department_id }));
        } catch (e) { console.warn('[rcal] resources', e.message); }
        state.doctors = doctors; state.rooms = rooms; state.servicesList = servicesList;
    }
    async function loadAppts() {
        const start = isoToLocalDay(state.dayIso);
        const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + state.period);
        let visits = [];
        try {
            const cid = (window.CLINIC && window.CLINIC.id) || null;   // M1
            const { data, error } = await supabase.from('visits')
                .select('id, patient_id, doctor_id, service_id, room_id, visit_date, duration_minutes, status')
                .eq('company_id', cid)
                .gte('visit_date', start.toISOString()).lt('visit_date', end.toISOString())
                .order('visit_date', { ascending: true });
            if (!error) visits = data || [];
        } catch (e) { console.warn('[rcal] visits', e.message); }
        const pids = [...new Set(visits.map(v => v.patient_id).filter(Boolean))];
        const sids = [...new Set(visits.map(v => v.service_id).filter(Boolean))];
        const [pn, sn] = await Promise.all([
            pids.length ? supabase.from('patients').select('id, full_name, first_name, last_name, phone').in('id', pids) : Promise.resolve({ data: [] }),
            sids.length ? supabase.from('services').select('id, name').in('id', sids) : Promise.resolve({ data: [] }),
        ]);
        const pm = {}, ph = {}, sm = {};
        for (const r of ((pn && pn.data) || [])) { pm[r.id] = r.full_name || [r.last_name, r.first_name].filter(Boolean).join(' ') || '—'; ph[r.id] = r.phone || ''; }
        for (const r of ((sn && sn.data) || [])) sm[r.id] = r.name || '';
        state.appts = visits.map(v => {
            const dt = new Date(v.visit_date);
            return { id: v.id, patientId: v.patient_id, doctorId: v.doctor_id, roomId: v.room_id,
                date: dateToIso(dt), start: minutesOfLocal(dt), dur: Number(v.duration_minutes) || 30,
                patient: pm[v.patient_id] || '—', phone: ph[v.patient_id] || '', serviceId: v.service_id, service: sm[v.service_id] || '', status: mapStatus(v.status) };
        });
    }

    // RCAL_UNASSIGNED_V1 — confirmed Symptex requests carry no room (and no-doctor
    // accepts carry no doctor), so a strictly doctor/room-laned grid would hide them.
    // A synthetic «Не назначено» lane catches visits with no matching resource so the
    // registrator always sees them and can drag one onto a doctor/room to assign it.
    const UNASSIGNED_ID = '__unassigned__';
    const UNASSIGNED = { id: UNASSIGNED_ID, name: 'Не назначено', spec: 'ждут назначения', napr: '', branch: '', hours: null };
    const resources = () => [UNASSIGNED, ...(state.resType === 'doctor' ? state.doctors : state.rooms)];
    const filteredRail = () => {
        const ql = state.q.trim().toLowerCase();
        return resources().filter(r => (!state.napr || r.napr === state.napr) && (!ql || (r.name + ' ' + r.spec).toLowerCase().includes(ql)));
    };
    function defaultSelect() {
        state.selected = new Set(filteredRail().slice(0, 6).map(r => r.id));
    }
    const doctorName = (id) => (state.doctors.find(d => d.id === id) || {}).name || '';
    const roomName   = (id) => (state.rooms.find(r => r.id === id) || {}).name || '';

    // ---- booking + open ----
    function bookAt(res, dayIso, min) {
        if (res.id === UNASSIGNED_ID) { toast('Перетащите запись на врача или кабинет, чтобы её назначить.', 'info'); return; }   // RCAL_UNASSIGNED_V1
        const d = isoToLocalDay(dayIso); d.setHours(Math.floor(min / 60), min % 60, 0, 0);
        openServicePickerModal({
            calculator: true,
            roomId: state.resType === 'room' ? res.id : null,
            lockedDoctor: state.resType === 'doctor' ? { id: res.id, name: res.name, spec: res.spec } : null,   // CATALOG_WIZARD_V1
            scheduledISO: d.toISOString(),
            onCreatePatient: () => { if (onNavigate) onNavigate('registration'); },
            onBooked: () => { reloadAndRepaint(); },   // BOOK_WIZARD_V1 — show the new booking immediately
        });
    }
    async function openCard(a) {
        if (!a.patientId) { toast('У записи нет пациента.', 'info'); return; }
        try { const p = await loadPatientById(a.patientId); if (p && onNavigate) onNavigate('patient-card', p); else toast('Не удалось открыть карту.', 'fail'); }
        catch (e) { toast('Не удалось открыть карту.', 'fail'); }
    }

    // ---- appointment modal: details + live status pills (Aurora ApptModal) ----
    async function setApptStatus(a, bucket) {
        const raw = BUCKET_RAW[bucket];
        if (!raw) return false;
        const { error } = await supabase.from('visits').update({ status: raw }).eq('id', a.id);
        if (error) {
            if (/check|constraint/i.test(error.message || '')) {
                toast(trf('Статус «{status}» не разрешён БД — примените миграцию 008_visit_statuses.sql.', { status: STATUS_META[bucket].label }), 'fail');
            } else toast(trf('Не удалось изменить статус: {msg}', { msg: error.message }), 'fail');
            return false;
        }
        a.status = bucket;
        return true;
    }
    function openApptModal(a) {
        const overlay = h('div', { class: 'modal', style: { zIndex: '140' } });
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onEsc); reloadAndRepaint(); };
        const onEsc = (e) => { if (e.key === 'Escape') close(); };
        overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

        const pillsBox = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } });
        function paintPills() {
            clear(pillsBox);
            for (const k of SETTABLE) {
                const m = STATUS_META[k];
                pillsBox.appendChild(h('button', { class: 'rcal-stbtn' + (a.status === k ? ' on' : ''), type: 'button',
                    onclick: async (ev) => { ev.currentTarget.disabled = true; const ok = await setApptStatus(a, k); if (ok) { toast(trf('Статус: {status}', { status: m.label })); paintPills(); } else ev.currentTarget.disabled = false; } },
                    h('span', { class: 'rcal-dot', style: { background: m.color } }), m.label));
            }
        }
        paintPills();

        // SYMPTEX_REQUESTED — a Symptex booking lands as «Заявка»; the registrar confirms
        // (requested->scheduled) or rejects (->cancelled) it here. Reuses setApptStatus.
        const requestedBanner = (a.status === 'requested') ? h('div', { style: { background: 'var(--purple-50, #f5f3ff)', border: '1px solid var(--purple-200, #ddd6fe)', borderRadius: '10px', padding: '11px 12px', margin: '0 0 14px' } },
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '8px' } },
                h('span', { class: 'rcal-dot', style: { background: 'var(--purple-700)' } }),
                h('div', { style: { fontWeight: 700, fontSize: '13px', color: 'var(--purple-700)' } }, 'Заявка из Symptex')),
            h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '10px' } }, 'Пациент записался через Symptex. Подтвердите запись, чтобы зафиксировать слот, или отклоните её.'),
            h('div', { class: 'row', style: { gap: '8px' } },
                h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try {
                        // #14 — confirm must ASSIGN, not just flip status (mirror requests-inbox REQ_CONFIRM_ASSIGN_V1).
                        // A doctor-less, room-less 'scheduled' visit is unroutable in the cabinet / nurse queue.
                        const docId = docSel.value || null, roomId = a.roomId || null;
                        if (!docId && !roomId) { toast('Назначьте врача (или кабинет), чтобы подтвердить запись.', 'fail'); ev.currentTarget.disabled = false; return; }
                        const dv = dateInp.value || a.date, tv = timeInp.value || fmtHM(a.start);
                        if (!dv || !tv) { toast('Укажите дату и время приёма.', 'fail'); ev.currentTarget.disabled = false; return; }
                        const [yy, mo, dd] = dv.split('-').map(Number), [hh, mi] = tv.split(':').map(Number);
                        const day = new Date(yy, (mo || 1) - 1, dd || 1, hh || 0, mi || 0, 0, 0);
                        const dur = Math.max(5, parseInt(durInp.value, 10) || a.dur);
                        const upd = { status: 'scheduled', doctor_id: docId, service_id: svcSel.value || null, visit_date: day.toISOString(), duration_minutes: dur };
                        const { error } = await supabase.from('visits').update(upd).eq('id', a.id);
                        if (error) {
                            if (error.code === '23P01' || /overlap|exclu|conflict/i.test(error.message || '')) toast('Это время уже занято у выбранного врача.', 'fail');
                            else toast(trf('Не удалось подтвердить: {msg}', { msg: error.message || error }), 'fail');
                            ev.currentTarget.disabled = false; return;
                        }
                        toast('Запись подтверждена'); close();
                    } catch (e) { toast(trf('Не удалось подтвердить: {msg}', { msg: e.message || e }), 'fail'); ev.currentTarget.disabled = false; }
                } }, 'Подтвердить'),
                h('button', { class: 'btn', style: { color: 'var(--crit-700)' }, onclick: async (ev) => { ev.currentTarget.disabled = true; const ok = await setApptStatus(a, 'cancelled'); if (ok) { toast('Заявка отклонена'); close(); } else ev.currentTarget.disabled = false; } }, 'Отклонить'))) : null;

        const row = (label, value) => h('div', { class: 'row', style: { gap: '10px', padding: '7px 0', borderBottom: '1px solid var(--ink-50)', fontSize: '13px', alignItems: 'baseline' } },
            h('span', { class: 'muted', style: { flex: '0 0 110px', fontSize: '12px' } }, label),
            h('span', { style: { fontWeight: 500 } }, value || '—'));
        // RCAL_EDIT_V1 — editable service / doctor / date / time (status stays the pills below).
        const _ecss = { fontSize: '13px', padding: '7px 9px', border: '1px solid var(--ink-200, #e2e8f0)', borderRadius: '8px', background: '#fff', color: 'var(--ink-800, #1e293b)', width: '100%', boxSizing: 'border-box' };
        const svcSel = h('select', { class: 'rcal-edit', style: _ecss },
            h('option', { value: '' }, '— без услуги —'),
            ...(state.servicesList || []).map(s => h('option', Object.assign({ value: s.id }, String(s.id) === String(a.serviceId) ? { selected: true } : {}), s.name || '—')));
        const docSel = h('select', { class: 'rcal-edit', style: _ecss },
            h('option', { value: '' }, '— без врача —'),
            ...(state.doctors || []).map(d => h('option', Object.assign({ value: d.id }, String(d.id) === String(a.doctorId) ? { selected: true } : {}), (d.name || '—') + (d.spec ? ' · ' + d.spec : ''))));
        const dateInp = h('input', { type: 'date', class: 'rcal-edit', style: _ecss, value: a.date });
        const timeInp = h('input', { type: 'time', class: 'rcal-edit', style: Object.assign({}, _ecss, { width: '120px' }), value: fmtHM(a.start) });
        const durInp = h('input', { type: 'number', min: '5', step: '5', class: 'rcal-edit', style: Object.assign({}, _ecss, { width: '90px' }), value: String(a.dur) });
        const editRow = (label, control) => h('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--ink-50)' } },
            h('div', { class: 'muted', style: { fontSize: '11px', marginBottom: '4px' } }, label), control);

        overlay.appendChild(h('div', { class: 'modal-card', style: { width: '480px', maxWidth: 'calc(100vw - 32px)' } },
            h('header', { class: 'modal-head' },
                h('h2', null, Icon('Calendar', { size: 16 }), ' Запись'),
                h('button', { class: 'modal-close', onclick: close }, '×')),
            h('div', { class: 'modal-body' },
                requestedBanner,
                h('div', { class: 'row', style: { gap: '11px', alignItems: 'center', marginBottom: '12px' } },
                    Avatar({ initials: initials(a.patient), color: avColor(a.patientId || a.patient) }),
                    h('div', { style: { minWidth: 0 } },
                        h('div', { style: { fontWeight: 700, fontSize: '14px' } }, a.patient),
                        a.phone ? h('div', { class: 'muted', style: { fontSize: '12px' } }, a.phone) : null)),
                editRow('Услуга', svcSel),
                editRow('Врач', docSel),
                a.roomId ? row('Кабинет', roomName(a.roomId)) : null,
                editRow('Дата', dateInp),
                editRow('Время и длительность', h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, timeInp, durInp, h('span', { class: 'muted', style: { fontSize: '12px' } }, 'мин'))),
                h('div', { style: { fontWeight: 700, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-500)', margin: '14px 0 8px' } }, 'Статус приёма'),
                pillsBox,
                h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '12px' } },
                    'Перетащите запись в сетке, чтобы перенести время, день или ресурс.')),
            h('footer', { class: 'modal-foot' },
                h('button', { class: 'btn', style: { color: 'var(--crit-700)' }, onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    const ok = await setApptStatus(a, 'cancelled');
                    if (ok) { toast('Запись отменена'); close(); } else ev.currentTarget.disabled = false;
                } }, 'Отменить запись'),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn btn-outline', onclick: () => { overlay.remove(); document.removeEventListener('keydown', onEsc); openCard(a); } },
                    Icon('ID', { size: 13 }), ' Карта пациента'),
                h('button', { class: 'btn btn-primary', onclick: async (ev) => {
                    ev.currentTarget.disabled = true;
                    try {
                        const dv = dateInp.value || a.date, tv = timeInp.value || fmtHM(a.start);
                        const [yy, mo, dd] = dv.split('-').map(Number), [hh, mi] = tv.split(':').map(Number);
                        const day = new Date(yy, (mo || 1) - 1, dd || 1, hh || 0, mi || 0, 0, 0);
                        const dur = Math.max(5, parseInt(durInp.value, 10) || a.dur);
                        const upd = { doctor_id: docSel.value || null, service_id: svcSel.value || null, visit_date: day.toISOString(), duration_minutes: dur };
                        const { error } = await supabase.from('visits').update(upd).eq('id', a.id);
                        if (error) {
                            if (error.code === '23P01' || /overlap|exclu|conflict/i.test(error.message || '')) toast('Это время уже занято у выбранного врача.', 'fail');
                            else toast(trf('Не удалось сохранить: {msg}', { msg: error.message || error }), 'fail');
                            ev.currentTarget.disabled = false; return;
                        }
                        toast('Запись сохранена'); close();
                    } catch (e2) { toast(trf('Не удалось сохранить: {msg}', { msg: e2.message || e2 }), 'fail'); ev.currentTarget.disabled = false; }
                } }, 'Готово'))));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onEsc);
    }

    // ---- hover tooltip (Aurora .cal-tip) ----
    let _tipEl = null;
    function hideTip() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } }
    function showTip(a, rect) {
        hideTip();
        if (_drag) return;
        const m = STATUS_META[a.status] || STATUS_META.planned;
        const line = (icon, text) => h('div', { class: 'row', style: { gap: '7px', fontSize: '12px', alignItems: 'baseline' } },
            h('span', { style: { color: 'var(--ink-400)', flex: '0 0 14px' } }, Icon(icon, { size: 12 })), h('span', null, text));
        _tipEl = h('div', { class: 'rcal-tip' },
            h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', marginBottom: '6px' } },
                h('span', { style: { fontWeight: 700, fontSize: '12.5px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.patient),
                h('span', { class: 'rcal-tip-st' }, h('span', { class: 'rcal-dot', style: { background: m.color } }), m.label)),
            line('Clock', fmtHM(a.start) + '–' + fmtHM(a.start + a.dur) + ' · ' + trf('{n} мин', { n: a.dur })),
            a.service ? line('Doc', a.service) : null,
            a.phone ? line('Phone', a.phone) : null,
            a.doctorId ? line('Stethoscope', doctorName(a.doctorId)) : null,
            state.period > 1 ? line('Calendar', ruDay(a.date)) : null,
            h('div', { class: 'muted', style: { fontSize: '10.5px', marginTop: '6px' } }, 'Клик — детали · тяни — перенести'));
        document.body.appendChild(_tipEl);
        const tw = 270;
        let left = rect.right + 8;
        if (left + tw > window.innerWidth - 8) left = rect.left - tw - 8;
        _tipEl.style.left = Math.max(8, left) + 'px';
        _tipEl.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - 220)) + 'px';
    }

    // ---- drag to move / resize (Aurora; snaps to step, commits to visits) ----
    let _drag = null;
    function startDrag(e, a, el, mode) {
        e.preventDefault(); e.stopPropagation();
        hideTip();
        const ppm = pxPerMin(state.step);
        const lanes = [...gridWrapEl.querySelectorAll('.rcal-lane')].map(L => ({ el: L, rect: L.getBoundingClientRect(), res: L.dataset.res, day: L.dataset.day }));
        _drag = { a, el, mode, ppm, lanes, startY: e.clientY, startX: e.clientX,
            origStart: a.start, origDur: a.dur, curStart: a.start, curDur: a.dur,
            curRes: (state.resType === 'doctor' ? a.doctorId : a.roomId), curDay: a.date, moved: false };
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
            d.curDur = Math.max(state.step, Math.min(d.origDur + dMin, DAY_END - d.curStart));
            d.el.style.height = (d.curDur * d.ppm - 2) + 'px';
            return;
        }
        d.curStart = Math.max(DAY_START, Math.min(d.origStart + dMin, DAY_END - d.origDur));
        d.el.style.top = ((d.curStart - DAY_START) * d.ppm) + 'px';
        const lane = d.lanes.find(L => e.clientX >= L.rect.left && e.clientX < L.rect.right);
        if (lane && (lane.res !== d.curRes || lane.day !== d.curDay)) {
            d.curRes = lane.res; d.curDay = lane.day;
            lane.el.appendChild(d.el);   // carry the block into the target lane
        }
    }
    async function onDragUp() {
        const d = _drag; _drag = null;
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragUp);
        if (!d) return;
        d.el.classList.remove('dragging');
        if (!d.moved) { openApptModal(d.a); return; }
        try {
            if (d.mode === 'resize') {
                const { error } = await supabase.from('visits').update({ duration_minutes: d.curDur }).eq('id', d.a.id);
                if (error) throw error;
                toast(trf('Длительность: {n} мин', { n: d.curDur }));
            } else {
                const day = isoToLocalDay(d.curDay); day.setHours(Math.floor(d.curStart / 60), d.curStart % 60, 0, 0);
                const upd = { visit_date: day.toISOString() };
                const origRes = state.resType === 'doctor' ? d.a.doctorId : d.a.roomId;
                if (d.curRes && d.curRes !== origRes) {
                    const _val = d.curRes === UNASSIGNED_ID ? null : d.curRes;   // RCAL_UNASSIGNED_V1 — drop on «Не назначено» clears it
                    // DEPT_ROUTING_V1 — hard-restrict: a service may only sit in a room of its own department
                    if (state.resType === 'room' && _val) {
                        const _svc = state.servicesList.find(s => s.id === d.a.serviceId);
                        const _room = state.rooms.find(r => r.id === _val);
                        if (_svc && _svc.deptId && _room && _room.deptId && String(_svc.deptId) !== String(_room.deptId)) {
                            toast('Услуга относится к другому отделу — выберите кабинет нужного отдела', 'fail');
                            reloadAndRepaint();   // snap the block back to its lane
                            return;
                        }
                    }
                    if (state.resType === 'doctor') upd.doctor_id = _val; else upd.room_id = _val;
                }
                const { error } = await supabase.from('visits').update(upd).eq('id', d.a.id);
                if (error) throw error;
                toast(trf('Перенесено: {day}, {time}', { day: ruDay(d.curDay), time: fmtHM(d.curStart) }));
            }
        } catch (e2) {
            toast(trf('Не удалось перенести: {msg}', { msg: e2.message || e2 }), 'fail');
        }
        reloadAndRepaint();
    }

    // ---- render: stable shell + repaint of rail-list and grid ----
    let railListEl, gridWrapEl, countEl, naprSelEl, dayLabelEl, dateInputEl, statsEl;

    function repaintRailList() {
        clear(railListEl);
        const list = filteredRail();
        if (countEl) countEl.textContent = String(state.selected.size);
        if (!list.length) { railListEl.appendChild(h('div', { class: 'muted', style: { padding: '16px', fontSize: '12.5px' } }, 'Ничего не найдено')); return; }
        for (const r of list) {
            const on = state.selected.has(r.id);
            railListEl.appendChild(h('label', { class: 'rcal-pick' + (on ? ' on' : '') },
                h('input', { type: 'checkbox', checked: on ? true : null, onchange: () => { if (state.selected.has(r.id)) state.selected.delete(r.id); else state.selected.add(r.id); repaintRailList(); repaintGrid(); } }),
                h('span', { class: 'rcal-av', style: { background: avColor(r.id || r.name) } }, initials(r.name)),
                h('span', { class: 'rcal-pick-tx' },
                    h('span', { class: 'rcal-pick-nm' }, r.name),
                    h('span', { class: 'rcal-pick-sp' }, [r.spec, r.branch].filter(Boolean).join(' · '))),
            ));
        }
    }

    function refreshNaprOptions() {
        if (!naprSelEl) return;
        const naprs = [...new Set(resources().map(r => r.napr).filter(Boolean))];
        clear(naprSelEl);
        naprSelEl.appendChild(h('option', { value: '' }, 'Все направления'));
        for (const n of naprs) naprSelEl.appendChild(h('option', { value: n, selected: n === state.napr ? true : null }, n));
    }

    function mainLabel() {
        const s = isoToLocalDay(state.dayIso);
        if (state.period === 1) return `${RU_WD_L[s.getDay()]}, ${s.getDate()} ${RU_MO[s.getMonth()]} ${s.getFullYear()}`;
        const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + state.period - 1);
        return `${s.getDate()} ${RU_MO[s.getMonth()]} – ${e.getDate()} ${RU_MO[e.getMonth()]} ${e.getFullYear()}`;
    }
    function shiftDay(n) {
        const d = isoToLocalDay(state.dayIso); d.setDate(d.getDate() + n); state.dayIso = dateToIso(d);
        if (dateInputEl) dateInputEl.value = state.dayIso; if (dayLabelEl) dayLabelEl.textContent = mainLabel();
        reloadAndRepaint();
    }

    function colDays() {
        const s = isoToLocalDay(state.dayIso);
        return Array.from({ length: state.period }, (_, i) => dateToIso(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i)));
    }

    function laneBody(res, dayIso, firstOfDay) {
        const ppm = pxPerMin(state.step);
        const laneH = (DAY_END - DAY_START) * ppm;
        const body = h('div', { class: 'rcal-lane' + (firstOfDay ? ' rcal-dayfirst' : ''), style: { height: laneH + 'px' } });
        body.dataset.res = res.id;
        body.dataset.day = dayIso;
        // RESCAL_V3 — per-slot rows (Aurora): hover affordance + precise click booking.
        const wr = workRange(res.hours, dayIso, res.branchId);
        for (let m = DAY_START; m < DAY_END; m += state.step) {
            const off = !wr || m < wr.from || m >= wr.to;
            body.appendChild(h('div', {
                class: 'rcal-slot' + (off ? ' off' : '') + (m % 60 === 0 ? ' hr' : ''),
                style: { height: (state.step * ppm) + 'px' },
                onclick: () => { if (off) { toast('Вне рабочих часов.', 'info'); return; } bookAt(res, dayIso, m); },
            }));
        }
        // now-line
        if (dayIso === todayIso()) { const nm = minutesOfLocal(new Date()); if (nm >= DAY_START && nm <= DAY_END) body.appendChild(h('div', { class: 'rcal-now', style: { top: ((nm - DAY_START) * ppm) + 'px' } })); }
        // appts
        const resKey = state.resType === 'doctor' ? 'doctorId' : 'roomId';
        const _matchRes = (a) => res.id === UNASSIGNED_ID ? !a[resKey] : a[resKey] === res.id;   // RCAL_UNASSIGNED_V1
        const items = state.appts.filter(a => _matchRes(a) && a.date === dayIso && (state.showCancelled || a.status !== 'cancelled'));
        for (const a of items) {
            const vs = Math.max(a.start, DAY_START), ve = Math.min(a.start + a.dur, DAY_END); if (ve <= vs) continue;
            const meta = STATUS_META[a.status] || STATUS_META.planned;
            const block = h('div', { class: 'rcal-appt' + (a.status === 'cancelled' ? ' rcal-appt-x' : ''),
                style: { top: ((vs - DAY_START) * ppm) + 'px', height: (Math.max((ve - vs) * ppm, 22) - 2) + 'px', borderLeft: `3px solid ${meta.color}` } },
                h('div', { class: 'rcal-appt-t' }, `${fmtHM(a.start)}–${fmtHM(a.start + a.dur)}`),
                h('div', { class: 'rcal-appt-p' }, a.patient),
                a.service ? h('div', { class: 'rcal-appt-s' }, a.service) : null,
                h('div', { class: 'rcal-appt-rs', onmousedown: (e) => startDrag(e, a, block, 'resize') }),
            );
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
            ['Заявки', by('requested'), STATUS_META.requested.color],
            ['Запланировано', by('planned') + by('confirmed'), STATUS_META.confirmed.color],
            ['Пришли', by('arrived'), STATUS_META.arrived.color],
            ['Завершено', by('done'), STATUS_META.done.color],
            ['Не пришли', by('noshow'), STATUS_META.noshow.color],
            ['Отменено', by('cancelled'), STATUS_META.cancelled.color],
        ];
        clear(statsEl);
        for (const [label, n, color] of cards) {
            statsEl.appendChild(h('div', { style: { padding: '9px 14px', border: '1px solid var(--ink-100, #e2e8f0)', borderRadius: '12px', background: 'var(--surface, #fff)', minWidth: '76px', textAlign: 'center' } },
                h('div', { style: { fontSize: '20px', fontWeight: 700, color: color } }, String(n)),
                h('div', { style: { fontSize: '11px', color: 'var(--ink-400, #64748b)', marginTop: '1px' } }, label)));
        }
    }

    function repaintGrid() {
        if (statsEl) repaintStats();
        hideTip();
        clear(gridWrapEl);
        const sel = resources().filter(r => state.selected.has(r.id));
        if (!sel.length) { gridWrapEl.appendChild(h('div', { class: 'empty', style: { padding: '60px 20px' } }, state.resType === 'doctor' ? tr('Выберите врачей слева, чтобы увидеть расписание.') : tr('Выберите кабинеты слева, чтобы увидеть расписание.'))); return; }
        const days = colDays();
        const ppm = pxPerMin(state.step), laneH = (DAY_END - DAY_START) * ppm;
        const cols = [];
        for (const dayIso of days) sel.forEach((res, ri) => cols.push({ res, dayIso, firstOfDay: ri === 0 && state.period > 1 }));
        const grid = h('div', { class: 'rcal-grid', style: { gridTemplateColumns: `52px repeat(${cols.length}, minmax(150px, 1fr))` } });
        // header row
        const head = h('div', { class: 'rcal-headrow', style: { gridTemplateColumns: `52px repeat(${cols.length}, minmax(150px, 1fr))` } });
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
                        h('div', { class: 'rcal-colsp' }, [c.res.spec, c.res.branch].filter(Boolean).join(' · '))),
                    h('span', { class: 'rcal-colcnt', title: 'Записей' }, String(n))),
            ));
        }
        // body row: time + lanes
        const bodyRow = h('div', { class: 'rcal-bodyrow', style: { gridTemplateColumns: `52px repeat(${cols.length}, minmax(150px, 1fr))` } });
        const timeCol = h('div', { class: 'rcal-timecol', style: { height: laneH + 'px' } });
        for (let m = DAY_START; m <= DAY_END; m += 60) timeCol.appendChild(h('div', { class: 'rcal-tlabel', style: { top: ((m - DAY_START) * ppm) + 'px' } }, fmtHM(m)));
        bodyRow.appendChild(timeCol);
        for (const c of cols) bodyRow.appendChild(laneBody(c.res, c.dayIso, c.firstOfDay));
        grid.appendChild(head); grid.appendChild(bodyRow);
        gridWrapEl.appendChild(grid);
    }

    async function reloadAndRepaint() { await loadAppts(); repaintGrid(); }

    function buildShell() {
        clear(root);
        // ---- left rail ----
        const setResType = (tp) => {
            if (state.resType === tp) return;
            state.resType = tp; state.napr = ''; state.q = '';
            segDocBtn.className = (tp === 'doctor' ? 'on' : '');
            segRoomBtn.className = (tp === 'room' ? 'on' : '');
            if (searchEl) { searchEl.value = ''; searchEl.placeholder = tp === 'doctor' ? 'Поиск врача…' : 'Поиск кабинета…'; }
            defaultSelect(); refreshNaprOptions(); repaintRailList(); repaintGrid();
        };
        const segDocBtn = h('button', { class: state.resType === 'doctor' ? 'on' : '', onclick: () => setResType('doctor') }, Icon('Stethoscope', { size: 14 }), ' Врачи');
        const segRoomBtn = h('button', { class: state.resType === 'room' ? 'on' : '', onclick: () => setResType('room') }, Icon('Grid', { size: 14 }), ' Кабинеты');
        const seg = h('div', { class: 'segmented rcal-railseg' }, segDocBtn, segRoomBtn);
        naprSelEl = h('select', { class: 'rcal-sel', onchange: (e) => { state.napr = e.target.value; repaintRailList(); } });
        const searchEl = h('input', { class: 'rcal-search', type: 'search', placeholder: state.resType === 'doctor' ? 'Поиск врача…' : 'Поиск кабинета…', oninput: (e) => { state.q = e.target.value; repaintRailList(); } });
        countEl = h('span', { class: 'rcal-cnt' }, '0');
        const acts = h('div', { class: 'rcal-acts' },
            h('button', { class: 'rcal-link', type: 'button', onclick: () => { for (const r of filteredRail()) state.selected.add(r.id); repaintRailList(); repaintGrid(); } }, 'Выбрать все'),
            h('button', { class: 'rcal-link', type: 'button', onclick: () => { state.selected.clear(); repaintRailList(); repaintGrid(); } }, 'Очистить'),
            countEl);
        railListEl = h('div', { class: 'rcal-list' });
        const rail = h('div', { class: 'rcal-rail' }, seg, naprSelEl, h('div', { class: 'rcal-search-w' }, Icon('Search', { size: 14 }), searchEl), acts, railListEl);

        // ---- main ----
        dateInputEl = h('input', { type: 'date', class: 'rcal-date', value: state.dayIso, onchange: (e) => { if (e.target.value) { state.dayIso = e.target.value; dayLabelEl.textContent = mainLabel(); reloadAndRepaint(); } } });
        dayLabelEl = h('span', { class: 'rcal-daylabel' }, mainLabel());
        const periodSeg = h('div', { class: 'segmented rcal-period' }, ...[[1, 'День'], [2, '2 дня'], [3, '3 дня'], [7, 'Неделя']].map(([n, l]) =>
            h('button', { class: state.period === n ? 'on' : '', onclick: (e) => { state.period = n; dayLabelEl.textContent = mainLabel(); for (const b of e.currentTarget.parentElement.children) b.classList.remove('on'); e.currentTarget.classList.add('on'); reloadAndRepaint(); } }, l)));
        const stepSel = h('select', { class: 'rcal-sel', onchange: (e) => { state.step = Number(e.target.value); repaintGrid(); } },
            ...[[10, 'Шаг 10 мин'], [15, 'Шаг 15 мин'], [30, 'Шаг 30 мин']].map(([v, l]) => h('option', { value: v, selected: v === state.step ? true : null }, l)));
        const cancelChk = h('label', { class: 'rcal-chk' }, h('input', { type: 'checkbox', onchange: (e) => { state.showCancelled = e.target.checked; repaintGrid(); } }), ' Отменённые');
        const toolbar = h('div', { class: 'rcal-toolbar' },
            h('div', { class: 'rcal-nav' },
                h('button', { class: 'btn btn-outline btn-sm', title: 'Назад', onclick: () => shiftDay(-state.period) }, Icon('ChevronLeft', { size: 15 })),
                h('button', { class: 'btn btn-outline btn-sm', onclick: () => { state.dayIso = todayIso(); dateInputEl.value = state.dayIso; dayLabelEl.textContent = mainLabel(); reloadAndRepaint(); } }, 'Сегодня'),
                h('button', { class: 'btn btn-outline btn-sm', title: 'Вперёд', onclick: () => shiftDay(state.period) }, Icon('ChevronRight', { size: 15 })),
                dateInputEl, dayLabelEl),
            h('div', { class: 'rcal-tools' }, periodSeg, stepSel, cancelChk));
        const legend = h('div', { class: 'rcal-legend' },
            ...Object.keys(STATUS_META).map(k => h('span', { class: 'rcal-leg' }, h('span', { class: 'rcal-dot', style: { background: STATUS_META[k].color } }), STATUS_META[k].label)),
            h('span', { class: 'rcal-leg' }, h('span', { class: 'rcal-leg-off' }), 'вне приёма'));
        gridWrapEl = h('div', { class: 'rcal-gridwrap' });
        statsEl = h('div', { class: 'rcal-stats', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '0 0 12px' } });
        const main = h('div', { class: 'rcal-main' }, toolbar, statsEl, legend, gridWrapEl);

        root.appendChild(h('div', { class: 'rcal-page' }, rail, main));
        refreshNaprOptions();
        repaintRailList();
        repaintGrid();
    }

    // initial
    root.appendChild(h('div', { class: 'empty', style: { padding: '50px' } }, 'Загрузка…'));
    await loadResources();
    defaultSelect();
    await loadAppts();
    state.loaded = true;
    buildShell();
}
