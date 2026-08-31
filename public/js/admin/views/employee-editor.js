// Edit Employee — a polished, section-railed modal for the Employees (users)
// record. Ported from the "Edit Employee" design sample: a gradient header with
// avatar + status + chips + completion ring, a grouped left rail (Profile /
// Work / Access), one focused panel per section, and a save footer.
//
// Unlike the design mock this is fully wired to Supabase: FK lookups
// (positions / departments / rooms / roles / branches), the user_branches
// junction, service_rates + working_hours JSONB, kpi_links text[], and a
// hashed password. Opened from the Employees list (see section-crud.js).

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast } from '../ui.js';
import { hashPassword } from '../auth.js?v=admdoc3';
import { gw } from '../gateway.js';
import { isBranchRestricted, getAvailableBranchIds, soleBranchId } from '../branch-context.js?v=bc3';   // EMP_BRANCH_SCOPE_V1; soleBranchId: SOLE_BRANCH_V1
import { canEdit } from '../permissions.js';   // ROLE_DELEGATION_V1
import { getLang, tr, trf } from '../i18n.js';   // EMP_STAFF_TYPE_V1 + I18N_COVERAGE_V1
import { phoneInput } from '../phone-input.js?v=ph1';

// ROLE_ADMIN_ONLY_V1 — assigning a user's role is the clinic owner's job alone
// (the DB also enforces it: users.role_id writes require current_user_is_admin()).
function _isClinicOwner() {
    try {
        const u = (window.easymed && window.easymed.state && window.easymed.state.user) || {};
        return u.is_super_admin === true || (u.is_admin === true && !!u.company_id);
    } catch (e) { return false; }
}

// ROLE_DELEGATION_V1 — a non-owner who manages staff (settings:users) may assign a
// NON-admin role to an employee; the DB still blocks the admin role / super-admin.
function _canAssignRole() { try { return _isClinicOwner() || canEdit('settings:users'); } catch (e) { return _isClinicOwner(); } }

// EMP_BRANCH_SCOPE_V1 — a "branch admin" is a NON-owner staffer granted the Employees
// section by their role; they manage staff ONLY inside their own branch scope. The
// actor's scope is whatever branch-context resolved at boot (same module instance).
function _actorBranchIds() {
    try { return (getAvailableBranchIds() || []).filter(Boolean); } catch (e) { return []; }
}
function _isBranchScopedActor() {
    if (_isClinicOwner()) return false;
    try { return isBranchRestricted() === true; } catch (e) { return false; }
}
function _clampToActorBranches(ids) {
    const want = [...(ids || [])];
    if (_isClinicOwner()) return want;
    const allowed = new Set(_actorBranchIds());
    return want.filter((id) => allowed.has(id));
}
// EMP_BRANCH_VALIDATION_V1 — typed error so the save button shows a friendly RU message.
class EmpValidationError extends Error {
    constructor(msg) { super(msg); this.name = 'EmpValidationError'; }
}

// Weekday keys must match what the scheduling calendar reads from
// users.working_hours (mon..sun).
const DAY_KEYS = [
    ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
    ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

const DOCTOR_CATEGORIES = [
    ['', 'No category'], ['highest', 'Highest category'],
    ['first', 'First category'], ['second', 'Second category'],
];
export const EMPLOYMENT_TYPES = [
    ['', '—'], ['official', 'Official (labour contract)'],
    ['civil_law', 'Civil-law contract (ГПХ / contractor)'], ['unofficial', 'Unofficial (no formal contract)'],
];
const SALARY_TYPES = [
    ['', '—'], ['fixed', 'Fixed (monthly)'],
    ['percentage', 'Variable (% of revenue)'], ['fix_plus_kpi', 'Fix + KPI bonus'],
];
const KPI_OPTS = [
    ['consultations', 'Consultations done'], ['services', 'Services delivered'],
    ['revenue', 'Revenue generated'], ['referrals', 'Patient referrals brought in'],
    ['lab_tests', 'Lab tests processed'], ['surgeries', 'Surgeries performed'],
];

// EMP_STAFF_TYPE_V1 — staff category dropdown (replaces the is-doctor checkbox).
// Stored in users.staff_type (migration 066); is_doctor stays derived so all
// existing doctor logic (rail sections, doctor list, specialties) keeps working.
const STAFF_TYPES = [
    { key: 'admin_staff', en: 'Administrative staff',        ru: 'Административный персонал',      uz: 'Maʼmuriy xodimlar' },
    { key: 'mid_low',     en: 'Middle & junior personnel',   ru: 'Средний и младший персонал',     uz: 'Oʻrta va kichik tibbiyot xodimlari' },
    { key: 'doctor',      en: 'Doctors',                     ru: 'Врачи',                          uz: 'Shifokorlar' },
];
const STAFF_TYPE_L = {
    en: { label: 'Staff category', choose: 'Select category…', help: 'Doctors get the «Doctor» access role, the clinic doctor list, and the License / Services & rates / Referral rewards sections.' },
    ru: { label: 'Категория сотрудника', choose: 'Выберите категорию…', help: 'Врачи получают роль доступа «Врач», попадают в список врачей клиники, и для них открываются разделы Лицензия / Услуги и ставки / Реферальные вознаграждения.' },
    uz: { label: 'Xodim toifasi', choose: 'Toifani tanlang…', uzhelp: '', help: 'Shifokorlarga «Shifokor» kirish roli beriladi, ular klinika shifokorlari roʻyxatiga qoʻshiladi va ular uchun Litsenziya / Xizmatlar va stavkalar / Referal mukofotlari boʻlimlari ochiladi.' },
};
function stL(key) {
    const lang = (typeof getLang === 'function' && getLang()) || 'en';
    return (STAFF_TYPE_L[lang] || STAFF_TYPE_L.en)[key] ?? STAFF_TYPE_L.en[key];
}

const EDIT_SECTIONS = [
    { id: 'identity', label: 'Identity',            icon: 'User' },
    { id: 'job',      label: 'Job',                 icon: 'Stethoscope' },
    { id: 'license',  label: 'License',             icon: 'Doc' },
    { id: 'branches', label: 'Branches',            icon: 'Building' },
    { id: 'salary',   label: 'Employment & salary', icon: 'Wallet' },
    { id: 'schedule', label: 'Working hours',       icon: 'Clock' },
    { id: 'services', label: 'Services & rates',    icon: 'Layers' },
    // CONSULT_SECTION_REMOVED_V1 — { id: 'consultations' } rail entry removed
    { id: 'referral', label: 'Referral rewards',    icon: 'Coins', optional: true },
    { id: 'login',    label: 'Login & access',      icon: 'Settings' },
];
const EDIT_GROUPS = [
    { label: 'Profile', ids: ['identity', 'job', 'license'] },
    { label: 'Work',    ids: ['branches', 'salary', 'schedule', 'services', 'referral'] },   // CONSULT_SECTION_REMOVED_V1 — «Консультации» dropped from the rail (owner request); per-doctor consultation prices live in Настройки → Консультации врачей
    { label: 'Access',  ids: ['login'] },
];

const fkLabel = (r) => r.name || r.full_name || r.code || r.number || r.label || ('#' + String(r.id).slice(0, 6));

// Compose the single display name from the three parts (Surname Name Patronymic).
const composeName = (emp) => [emp.last_name, emp.first_name, emp.middle_name]
    .map(s => (s || '').trim()).filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Public entry — open the editor. `row` is an existing users row (null = add).
// `onSaved` is called after a successful save so the list can reload.
// ---------------------------------------------------------------------------
export async function openEmployeeEditor({ row = null, onSaved = null, readOnly = false } = {}) {
    injectCss();
    const lookups = await loadLookups();
    // MULTI_ROLE_V1 — detect the extra_role_ids column (absent before migration 128)
    // and, for an existing employee, load their current extra roles. Fully tolerant:
    // if the column isn't there the feature just hides and never breaks the editor.
    let extraRolesOk = true;
    try {
        if (row && row.id) {
            const { data: _u, error: _e } = await supabase.from('users').select('extra_role_ids').eq('id', row.id).maybeSingle();
            if (_e) extraRolesOk = false;
            else if (_u) row = { ...row, extra_role_ids: Array.isArray(_u.extra_role_ids) ? _u.extra_role_ids : [] };
        } else {
            const { error: _pe } = await supabase.from('users').select('extra_role_ids', { head: true }).limit(1);
            if (_pe) extraRolesOk = false;
        }
    } catch (_) { extraRolesOk = false; }
    const emp = buildEmp(row, lookups);
    emp.__extraRolesOk = extraRolesOk;
    paintModal({ row, emp, lookups, onSaved, readOnly });
}

export async function loadLookups() {
    // EMP_CLINIC_FIRST_V1 — the SUBDOMAIN CLINIC wins over the logged-in user's own
    // company (a super admin's home clinic differs from the panel he's working on).
    const cid = (window.CLINIC && window.CLINIC.id) || (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.company_id) || null;
    const safe = async (table, sel = '*', order = null, scope = false) => {
        try {
            let q = supabase.from(table).select(sel);
            if (scope && cid) q = q.eq('company_id', cid);   // CLINIC_SCOPE_LOOKUP_V1: only this clinic's reference data
            if (order) q = q.order(order);
            const { data, error } = await q;
            if (error) { console.warn(`[emp-editor] ${table}:`, error.message); return []; }
            return data || [];
        } catch (e) { console.warn(`[emp-editor] ${table} threw:`, e.message); return []; }
    };
    const [positions, departments, rooms, roles, branches, services, serviceTypes, consultationTypes] = await Promise.all([
        safe('positions', 'id, name, is_doctor', 'name', true),
        safe('departments', 'id, name', 'name', true),
        safe('rooms', '*', null, true),
        safe('roles', 'id, name', 'name'),
        safe('branches', 'id, name, working_hours, is_24_7', 'name', true),
        safe('services', 'id, name, price, type_id, active', null, true),
        safe('service_types', 'id, name', null, true),
        safe('consultation_types', '*', 'sort_order', true),
    ]);
    const typeName = new Map(serviceTypes.map(t => [t.id, t.name]));
    const svc = services
        .filter(s => s.active !== false)
        .map(s => ({ id: s.id, name: s.name, price: Number(s.price || 0), typeName: typeName.get(s.type_id) || 'Other' }))
        .sort((a, b) => a.name.localeCompare(b.name));
    // Specialties come from medcore via the gateway (non-fatal). Also expose a
    // slug→row lookup for the save path (name_ru/name_uz mirror). SPECIALTIES_SYNC_V1
    let specialties = [];
    try { specialties = (await gw('/catalog/specialties')).data || []; }
    catch (e) { console.warn('[emp-editor] specialties:', e.message); }
    try { window.__specLookup = Object.fromEntries((specialties || []).map(s => [s.slug, s])); } catch (e) {}
    return { positions, departments, rooms, roles, branches, services: svc, specialties, consultationTypes };
}

export async function loadUserBranchIds(userId) {
    if (!userId) return [];
    try {
        const { data, error } = await supabase.from('user_branches').select('branch_id').eq('user_id', userId);
        if (error) { console.warn('[emp-editor] user_branches:', error.message); return []; }
        return (data || []).map(r => r.branch_id);
    } catch { return []; }
}

async function loadUserSpecialtySlugs(userId) {
    if (!userId) return [];
    try {
        const { data, error } = await supabase.from('user_specialties')
            .select('specialty_slug, is_primary').eq('user_id', userId).order('is_primary', { ascending: false });
        if (error) { console.warn('[emp-editor] user_specialties:', error.message); return []; }
        return (data || []).map(r => r.specialty_slug);
    } catch { return []; }
}

// This doctor's own per-consultation-type settings →
// { [consultation_type_id]: { price, available, is_free } }.
// Blank/absent = the clinic default applies. CONSULTATION_PRICE_V1
export async function loadDoctorConsultationPrices(userId) {
    if (!userId) return {};
    try {
        const { data, error } = await supabase.from('doctor_consultation_prices')
            .select('consultation_type_id, price, available, is_free').eq('doctor_id', userId);
        if (error) { console.warn('[emp-editor] doctor_consultation_prices:', error.message); return {}; }
        const out = {};
        for (const r of (data || [])) out[r.consultation_type_id] = { price: r.price, available: r.available, is_free: r.is_free };
        return out;
    } catch { return {}; }
}

// Find-or-create the clinic's single "Doctor" position (is_doctor=true). DOCTOR_POSITION_V1
async function ensureDoctorPosition(companyId) {
    if (!companyId) return null;
    try {
        const { data } = await supabase.from('positions').select('id')
            .eq('company_id', companyId).eq('is_doctor', true).limit(1);
        if (data && data.length) return data[0].id;
        const { data: ins, error } = await supabase.from('positions')
            .insert({ name: 'Doctor', is_doctor: true, active: true, company_id: companyId })
            .select('id').single();
        if (error) { console.warn('[emp-editor] create doctor position:', error.message); return null; }
        return ins.id;
    } catch (e) { console.warn('[emp-editor] ensureDoctorPosition:', e.message); return null; }
}

// Shape a users row (+ lookups) into the editable model.
export function buildEmp(row, lookups) {
    const r = row || {};
    const wh = (r.working_hours && typeof r.working_hours === 'object') ? r.working_hours : null;
    const days = DAY_KEYS.map(([key], i) => {
        const slot = wh ? wh[key] : null;
        const defaultOn = i < 5;
        return {
            key,
            name: DAY_KEYS[i][1],
            on:        slot ? (slot.enabled !== false) : (wh ? false : defaultOn),
            start:     (slot && slot.from) || '09:00',
            end:       (slot && slot.to)   || '18:00',
            lunch:     slot ? !!slot.lunchEnabled : false,
            lunchStart:(slot && slot.lunchFrom) || '13:00',
            lunchEnd:  (slot && slot.lunchTo)   || '14:00',
        };
    });

    // Build an editable per-service rate list from a stored rate array. `priceKey`
    // is the column the row's "price" field maps to (service_rates uses `price`,
    // referral_rates uses `fixed`). `priceDefault` seeds new rows.
    const buildRates = (stored, priceKey, priceDefaultFromSvc) => {
        const by = new Map();
        if (Array.isArray(stored)) for (const it of stored) if (it && it.service_id) by.set(it.service_id, it);
        return lookups.services.map(s => {
            const rate = by.get(s.id);
            return {
                id: s.id, name: s.name, typeName: s.typeName,
                on: !!rate,
                price: rate && rate[priceKey] != null ? rate[priceKey] : (priceDefaultFromSvc ? s.price : 0),
                pct: rate && rate.percentage != null ? rate.percentage : 0,
                branches: rate && Array.isArray(rate.branches) ? [...rate.branches] : lookups.branches.map(b => b.id),
            };
        });
    };
    const services         = buildRates(r.service_rates,  'price', true);   // performed
    const referralServices = buildRates(r.referral_rates, 'fixed', false);  // referral reward

    // Name parts. Prefer the dedicated columns (migration 026); fall back to
    // splitting full_name (1st token = surname, 2nd = name, rest = patronymic).
    let last_name = r.last_name || '', first_name = r.first_name || '', middle_name = r.middle_name || '';
    if (!last_name && !first_name && r.full_name) {
        const parts = r.full_name.trim().split(/\s+/);
        last_name = parts[0] || '';
        first_name = parts[1] || '';
        middle_name = parts.slice(2).join(' ');
    }

    return {
        __id:        r.id || null,
        last_name, first_name, middle_name,
        phone:       r.phone || '',
        email:       r.email || '',
        position_id: r.position_id || '',
        department_id: r.department_id || '',
        room_id:     r.room_id || '',
        doctor_category: r.doctor_category || '',
        staff_type:  r.staff_type || (r.is_doctor === true ? 'doctor' : ''),   // EMP_STAFF_TYPE_V1
        scheduling_mode: r.scheduling_mode || 'schedulable',   // EMP_SCHED_MODE_V1
        is_doctor:   r.is_doctor === true,
        specialties: [],                       // slugs, filled async by loadUserSpecialtySlugs
        consultationPrices: {},                // {consultation_type_id: {price, available, is_free}}, filled async by loadDoctorConsultationPrices
        hire_date:   (r.hire_date || '').slice(0, 10),
        license_number: r.license_number || '',
        license_expiry_date: (r.license_expiry_date || '').slice(0, 10),
        branches:    new Set(),                // filled async by loadUserBranchIds
        employment_type: r.employment_type || '',
        salary_type: r.salary_type || '',
        salary_fixed: r.salary_fixed != null ? String(r.salary_fixed) : '',
        salary_percent: r.salary_percent != null ? String(r.salary_percent) : '',
        kpis:        new Set(Array.isArray(r.kpi_links) ? r.kpi_links : []),
        days,
        services,
        referralServices,
        username:    r.username || '',
        password:    '',
        role_id:     r.role_id || '',
        extra_role_ids: Array.isArray(r.extra_role_ids) ? r.extra_role_ids.map(String) : [],   // MULTI_ROLE_V1
        role:        (r.role || ''),   // CLINIC_ADMIN_FULL_ACCESS_V1 — guard the Role picker for admins
        __roleLookup: (lookups && lookups.roles) || [],   // EMP_ROLE_OWNER_EQUIV_V1 — for the save-side owner-equiv role guard
        active:      r.active !== false,
    };
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------
function paintModal({ row, emp, lookups, onSaved, readOnly }) {
    let section = 'identity';

    const overlay = h('div', { class: 'emp-overlay' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.appendChild(h('div', { class: 'emp-scrim', onclick: close }));

    const panel = h('div', { class: 'emp-panel' });
    const rail  = h('nav', { class: 'emp-rail' });
    const headChrome = h('div', { class: 'emp-head-main' });
    const ringWrap   = h('div', { class: 'emp-progress' });
    const footDirty  = h('span', { class: 'muted', style: { fontSize: '12.5px', display: 'inline-flex', alignItems: 'center', gap: '7px' } });

    let dirty = false;
    // markDirty: update model + refresh header/rail/footer only (safe to call
    // from text inputs without stealing focus). set: same, but also re-renders
    // the active panel (use for toggles whose visual state lives in the panel).
    const markDirty = (patch) => { Object.assign(emp, patch); dirty = true; refreshChrome(); };
    // set() re-renders the rail too so doctor-only sections (e.g. consultations)
    // appear/disappear the moment the "is a doctor" box is toggled. CONSULTATION_PRICE_V1
    const set       = (patch) => { markDirty(patch); renderRail(); renderPanel(); };

    const ctx = { emp, lookups, set, markDirty, readOnly, get section() { return section; } };

    function renderPanel() {
        clear(panel);
        const fn = SECTION_RENDERERS[section];
        panel.appendChild(fn ? fn(ctx) : h('div'));
    }
    function renderRail() {
        clear(rail);
        // DOCTOR_ONLY_SECTIONS_V1 — License, Services & rates, Referral rewards
        // and Consultations only make sense for doctors; hide them for other
        // staff (nurses, cashiers, registrars…). Toggling «is a doctor» in Job
        // shows/hides them live (set() re-renders the rail).
        const DOCTOR_ONLY = new Set(['license', 'services', 'referral']);   // CONSULT_SECTION_REMOVED_V1
        if (!emp.is_doctor && DOCTOR_ONLY.has(section)) {
            section = 'identity';   // active section just got hidden — bounce home
        }
        for (const g of EDIT_GROUPS) {
            const ids = g.ids.filter(id => !DOCTOR_ONLY.has(id) || emp.is_doctor);
            if (!ids.length) continue;
            const grp = h('div', null, h('div', { class: 'emp-rail-group' }, g.label));
            for (const id of ids) {
                const s = EDIT_SECTIONS.find(x => x.id === id);
                const done = sectionComplete(emp, id);
                const indicator = done
                    ? Icon('Check', { size: 13 })
                    : h('span', {
                        class: s.optional ? 'emp-dot-opt' : 'emp-dot-todo',
                        title: s.optional ? 'Optional — not set' : 'Required fields still empty',
                    });
                grp.appendChild(h('button', {
                    class: 'emp-rail-item' + (section === id ? ' on' : ''),
                    onclick: () => { section = id; renderRail(); renderPanel(); },
                },
                    Icon(s.icon, { size: 15 }),
                    h('span', { style: { flex: 1, textAlign: 'left' } }, s.label),
                    indicator,
                ));
            }
            rail.appendChild(grp);
        }
    }
    function refreshChrome() {
        // Header identity + chips
        clear(headChrome);
        const statusBadge = emp.active
            ? h('span', { class: 'emp-badge ok' }, h('span', { class: 'd' }), ' Active')
            : h('span', { class: 'emp-badge off' }, h('span', { class: 'd' }), ' Inactive');
        const posName  = optLabel(lookups.positions, emp.position_id) || emp.doctor_category && labelOf(DOCTOR_CATEGORIES, emp.doctor_category) || 'No position';
        const deptName = optLabel(lookups.departments, emp.department_id) || 'No department';
        const roleName = optLabel(lookups.roles, emp.role_id) || 'No role';
        headChrome.appendChild(h('div', { class: 'row', style: { gap: '10px' } },
            h('span', { class: 'emp-title' }, composeName(emp) || (row ? 'Edit employee' : 'New employee')),
            statusBadge,
        ));
        headChrome.appendChild(h('div', { class: 'emp-sub' }, `${posName} · ${deptName}`));
        const chips = h('div', { class: 'emp-chips' },
            h('span', { class: 'emp-chip' }, Icon('Building', { size: 12 }), ` ${emp.branches.size} branches`),
            h('span', { class: 'emp-chip' }, Icon('Doc', { size: 12 }), ` Lic. ${emp.license_number || '—'}`),
            emp.license_expiry_date && h('span', { class: 'emp-chip warn' }, Icon('Clock', { size: 12 }), ` Exp ${emp.license_expiry_date}`),
            h('span', { class: 'emp-chip' }, Icon('Settings', { size: 12 }), ` ${roleName}`),
        );
        headChrome.appendChild(chips);
        // Avatar initials
        const av = overlay.querySelector('[data-emp-avatar]');
        if (av) av.firstChild && (av.childNodes[0].nodeValue = initialsOf(composeName(emp)));
        // Ring
        clear(ringWrap);
        const pct = completionPct(emp);
        ringWrap.appendChild(ring(pct));
        ringWrap.appendChild(h('span', { class: 'lbl' }, 'Complete'));
        // Footer dirty indicator
        clear(footDirty);
        if (dirty) {
            footDirty.appendChild(h('span', { style: { width: '7px', height: '7px', borderRadius: '999px', background: 'var(--warn-500)' } }));
            footDirty.appendChild(document.createTextNode(' Unsaved changes'));
        } else {
            footDirty.appendChild(Icon('Check', { size: 13 }));
            footDirty.appendChild(document.createTextNode(' All changes saved'));
        }
        // Rail checkmarks
        renderRail();
    }

    const saveBtn = h('button', { class: 'btn btn-primary', onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        try {
            const { dropped = [], authError, syncWarnings = [] } = (await saveEmployee(emp, row)) || {};
            dirty = false;
            // Surface columns the DB couldn't store (missing migration) rather
            // than silently claiming success — this is why referral rewards /
            // services would appear "not kept".
            const MIGRATION_FOR = { referral_rates: '027', service_rates: '023', room_id: '021', working_hours: '002' };
            const blocking = dropped.filter(c => c in MIGRATION_FOR);
            if (blocking.length) {
                toast('Saved, but ' + blocking.join(', ') + ' could NOT be stored (missing column). Apply migration ' +
                    [...new Set(blocking.map(c => MIGRATION_FOR[c]))].join(' & ') + ' in Supabase (and reload its schema cache), then save again.', 'fail');
            } else if (authError) {
                // The users row saved but Supabase Auth provisioning failed —
                // they cannot log in until this is resolved. Surface clearly.
                toast('Employee saved, but login could NOT be enabled: ' + authError + '. They will not be able to sign in until this is fixed.', 'fail');
            } else if (syncWarnings.length) {
                // H1 — branches / specialties / consultation prices failed to persist; don't claim success.
                toast(trf('Сохранено, но не удалось записать: {what}. Откройте сотрудника и сохраните ещё раз.', { what: syncWarnings.join(', ') }), 'fail');
            } else if (!row?.id && !(emp.username || '').trim()) {
                // NEW_EMP_PASSWORD_V1 — saved without a login at all: legal
                // (e.g. staff who never use the system), but say it loudly.
                toast('Сотрудник сохранён БЕЗ логина — войти в систему он не сможет. Чтобы дать доступ, откройте сотрудника и заполните «Login & access».', 'fail');
            } else {
                toast(emp.password ? 'Employee saved. They can sign in with this password.' : 'Employee saved.');
            }
            close();
            onSaved && onSaved();
        } catch (e) {
            toast('Save failed: ' + (e.message || e), 'fail');
        } finally {
            if (ev.currentTarget?.isConnected) ev.currentTarget.disabled = false;
        }
    } }, Icon('Check', { size: 14 }), ' Save employee');

    const modal = h('div', { class: 'emp-modal' },
        // Header
        h('div', { class: 'emp-head' },
            h('div', { class: 'emp-avatar ' + (row?.av_color || 'av-2'), 'data-emp-avatar': '' },
                initialsOf(composeName(emp)),
                h('span', { class: 'emp-cam', title: 'Change photo' }, Icon('Camera', { size: 12 })),
            ),
            headChrome,
            ringWrap,
            h('button', { class: 'icon-btn', style: { width: '32px', height: '32px' }, onclick: close }, '×'),
        ),
        // Body
        h('div', { class: 'emp-body' }, rail, panel),
        // Footer
        h('div', { class: 'emp-foot' },
            footDirty,
            h('span', { class: 'grow' }),
            h('button', { class: 'btn btn-outline', onclick: close }, readOnly ? 'Close' : 'Cancel'),
            !readOnly && saveBtn,
        ),
    );

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);

    renderRail();
    renderPanel();
    refreshChrome();

    // Branches load async (junction table), then refresh chips + panel.
    loadUserBranchIds(emp.__id).then(ids => {
        // SOLE_BRANCH_V1 — филиал в клинике один: отмечаем его сам. Иначе
        // сотрудника нельзя было сохранить, не поставив вручную единственную
        // возможную галочку (EMP_BRANCH_VALIDATION_V1 требует хотя бы один филиал).
        const only = soleBranchId();
        emp.branches = new Set(ids.length === 0 && only != null ? [only] : ids);
        refreshChrome();
        if (section === 'branches') renderPanel();
    });

    // Specialty picks load async (user_specialties), then refresh the job panel.
    loadUserSpecialtySlugs(emp.__id).then(slugs => {
        emp.specialties = slugs;
        if (section === 'job') renderPanel();
    });

    // Per-doctor consultation prices load async, then refresh the consultations panel. CONSULTATION_PRICE_V1
    loadDoctorConsultationPrices(emp.__id).then(m => {
        emp.consultationPrices = m;
        if (section === 'consultations') renderPanel();
    });
}

// ---------------------------------------------------------------------------
// Small shared building blocks
// ---------------------------------------------------------------------------
const optLabel = (list, id) => { const r = (list || []).find(x => String(x.id) === String(id)); return r ? fkLabel(r) : ''; };
const labelOf  = (pairs, val) => { const p = pairs.find(([v]) => v === val); return p ? p[1] : ''; };
function initialsOf(name) {
    return (name || 'NE').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'NE';
}
// A section counts as COMPLETE only when its must-fill fields are all present.
// The rail shows a green tick when complete and a red dot until then; the
// header ring is the share of complete sections.
const hasVal = (v) => v != null && String(v).trim() !== '';
function sectionComplete(emp, id) {
    const isNew = !emp.__id;
    switch (id) {
        case 'identity': return hasVal(emp.last_name) && hasVal(emp.first_name) && hasVal(emp.phone);
        case 'job':      return true;   // DEPT_MEMBERS_V1 — department is assigned from the Departments section; Job has only optional fields.
        case 'license':  return hasVal(emp.license_number) && hasVal(emp.license_expiry_date);
        case 'branches': return emp.branches.size > 0;
        case 'salary': {
            if (!hasVal(emp.employment_type) || !hasVal(emp.salary_type)) return false;
            const needFix = emp.salary_type === 'fixed' || emp.salary_type === 'fix_plus_kpi';
            const needVar = emp.salary_type === 'percentage' || emp.salary_type === 'fix_plus_kpi';
            if (needFix && !hasVal(emp.salary_fixed)) return false;
            if (needVar && !hasVal(emp.salary_percent)) return false;
            if (emp.salary_type === 'fix_plus_kpi' && emp.kpis.size === 0) return false;   // DOCTOR_PAY_KPI_WIRE_V1
            return true;
        }
        case 'schedule': return emp.days.some(d => d.on);
        case 'services': return emp.services.some(s => s.on);
        case 'referral': return emp.referralServices.some(s => s.on);
        case 'login':    return true;   // EMP_ROLE_IN_JOB_V1 — Role moved to Job; Login has only optional username/password.
        default: return false;
    }
}
function completionPct(emp) {
    // Optional sections (e.g. referral rewards) don't count toward the ring.
    const ids = EDIT_SECTIONS.filter(s => !s.optional).map(s => s.id);
    const done = ids.filter(id => sectionComplete(emp, id)).length;
    return Math.round(done / ids.length * 100);
}
function ring(pct) {
    const size = 52, stroke = 5, r = (size - stroke) / 2, c = 2 * Math.PI * r;
    const off = c * (1 - pct / 100);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', size / 2); bg.setAttribute('cy', size / 2); bg.setAttribute('r', r);
    bg.setAttribute('fill', 'none'); bg.setAttribute('stroke', 'var(--ink-100)'); bg.setAttribute('stroke-width', stroke);
    const fg = document.createElementNS(svgNS, 'circle');
    fg.setAttribute('cx', size / 2); fg.setAttribute('cy', size / 2); fg.setAttribute('r', r);
    fg.setAttribute('fill', 'none'); fg.setAttribute('stroke', 'var(--primary-600)'); fg.setAttribute('stroke-width', stroke);
    fg.setAttribute('stroke-linecap', 'round'); fg.setAttribute('stroke-dasharray', c.toFixed(2));
    fg.setAttribute('stroke-dashoffset', off.toFixed(2));
    fg.setAttribute('transform', `rotate(-90 ${size / 2} ${size / 2})`);
    const txt = document.createElementNS(svgNS, 'text');
    txt.setAttribute('x', '50%'); txt.setAttribute('y', '52%'); txt.setAttribute('dominant-baseline', 'middle');
    txt.setAttribute('text-anchor', 'middle'); txt.setAttribute('font-size', '13'); txt.setAttribute('font-weight', '700');
    txt.setAttribute('fill', 'var(--ink-800)'); txt.textContent = pct + '%';
    svg.append(bg, fg, txt);
    return svg;
}

const secHead = (icon, title, sub, right) => h('div', { class: 'row', style: { marginBottom: '20px', alignItems: 'flex-start' } },
    h('div', { class: 'sec-badge' }, Icon(icon, { size: 18 })),
    h('div', null,
        h('h2', { class: 'sec-title' }, title),
        sub && h('p', { class: 'sec-sub' }, sub),
    ),
    right && h('span', { class: 'grow' }),
    right || null,
);
const fld = (label, input, { hint, span, required } = {}) => {
    // REQUIRED_STARS_V1 — required fields carry a red asterisk, matching the
    // red "incomplete" dots in the section rail.
    const w = h('div', { class: 'field' },
        h('label', null, label, required ? h('span', { style: { color: 'var(--crit-600, #dc2626)', fontWeight: 700 } }, ' *') : null),
        input, hint && h('span', { class: 'hint' }, hint));
    if (span) w.style.gridColumn = '1 / -1';
    return w;
};
const grid2 = (...kids) => h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr' } }, ...kids);
const textInput = (val, on, ph, opts = {}) => { const el = h('input', { value: val ?? '', placeholder: ph || '', ...opts }); el.oninput = () => on(el.value); return el; };
// PHONE_INPUT_V1 — country-code control, same one patient registration uses.
const phoneField = (val, on, ph) => { const el = phoneInput('phone', ph, { value: val }); el.addEventListener('input', () => on(el.value)); return el; };
const dateInput = (val, on, opts = {}) => { const el = h('input', { type: 'date', value: val || '', ...opts }); el.onchange = () => on(el.value); return el; };
const selectInput = (val, pairs, on, opts = {}) => {
    const el = h('select', opts, ...pairs.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val ?? '') }, l)));
    el.onchange = () => on(el.value);
    return el;
};
const fkSelect = (val, list, on, { placeholder = '— none —', ...opts } = {}) =>
    selectInput(val, [['', placeholder], ...list.map(r => [r.id, fkLabel(r)])], on, opts);
const cbx = (on, onClick, { sm, disabled } = {}) => h('button', {
    type: 'button', class: 'cbx' + (sm ? ' sm' : '') + (on ? ' on' : ''),
    disabled: disabled ? '' : null,
    onclick: (e) => { e.preventDefault(); if (!disabled) onClick(); },
}, on && Icon('Check', { size: sm ? 10 : 12 }));

// MULTI_ROLE_V1 — pick ADDITIONAL access roles (their permissions union with the
// primary role). Backed by emp.extra_role_ids; the primary role_id is excluded.
function extraRolesControl(emp, lookups, markDirty) {
    // MULTI_ROLE_V2 — picked roles show as removable chips; a small dropdown adds
    // more. The dropdown lists only roles not yet picked (and never the primary).
    const wrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', maxWidth: '560px' } });
    const render = () => {
        clear(wrap);
        const current = (emp.extra_role_ids || []).map(String);
        const byId = new Map((lookups.roles || []).map(r => [String(r.id), r]));
        for (const id of current) {
            const r = byId.get(id);
            if (!r) continue;
            wrap.appendChild(h('span', { class: 'row', style: {
                gap: '6px', alignItems: 'center', fontSize: '13.5px', fontWeight: 600,
                padding: '4px 6px 4px 12px', border: '1px solid #dbeafe', background: '#eff6ff',
                color: '#1d4ed8', borderRadius: '999px' } },
                fkLabel(r),
                h('button', { type: 'button', title: 'Убрать', style: {
                    border: 'none', background: 'transparent', cursor: 'pointer', color: '#1d4ed8',
                    fontSize: '17px', lineHeight: '1', padding: '0 2px' },
                    onclick: () => { markDirty({ extra_role_ids: current.filter(x => x !== id) }); render(); } }, '×')));
        }
        const rest = (lookups.roles || []).filter(r =>
            String(r.id) !== String(emp.role_id) && !current.includes(String(r.id)));
        if (rest.length) {
            const sel = h('select', { style: {
                height: '34px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px',
                fontSize: '13.5px', background: 'white', fontFamily: 'inherit', maxWidth: '220px' } },
                h('option', { value: '' }, '+ Добавить роль…'),
                ...rest.map(r => h('option', { value: String(r.id) }, fkLabel(r))));
            sel.addEventListener('change', () => {
                if (!sel.value) return;
                markDirty({ extra_role_ids: [...current, String(sel.value)] });
                render();
            });
            wrap.appendChild(sel);
        } else if (!current.length) {
            wrap.appendChild(h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Нет других ролей.'));
        }
    };
    render();
    return wrap;
}

// Specialty multiselect (max 4): chips for picks + an "add" select of the rest.
// Backed by emp.specialties (an array of slugs); writes via set() so the panel
// re-renders. SPECIALTIES_SYNC_V1
function specialtyPicker(emp, lookups, set) {
    const nameOf = (s) => (s && (s.name_ru || s.slug)) || '';
    const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const chips = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
    for (const slug of emp.specialties) {
        const s = (lookups.specialties || []).find(x => x.slug === slug) || { slug, name_ru: slug };
        chips.appendChild(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', background: '#eef2ff', borderRadius: '999px', fontSize: '12.5px' } },
            nameOf(s),
            h('button', { type: 'button', style: { border: 'none', background: 'none', cursor: 'pointer', fontSize: '13.5px', lineHeight: '1', padding: '0' },
                onclick: () => set({ specialties: emp.specialties.filter(x => x !== slug) }) }, '×')));
    }
    wrap.appendChild(chips);
    if (emp.specialties.length < 4) {
        const avail = (lookups.specialties || []).filter(s => !emp.specialties.includes(s.slug));
        wrap.appendChild(selectInput('', [['', '+ Add specialty'], ...avail.map(s => [s.slug, nameOf(s)])],
            v => { if (v) set({ specialties: [...emp.specialties, v] }); }));
    } else {
        wrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Maximum 4 specialties.'));
    }
    return wrap;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------
const SECTION_RENDERERS = {
    identity: ({ emp, markDirty }) => h('div', { class: 'fade-in' },
        secHead('User', 'Identity', 'Personal and contact details for this employee.'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '620px' } },
            h('div', { class: 'field-row', style: { gridTemplateColumns: '1fr 1fr 1fr' } },
                fld('Surname', textInput(emp.last_name, v => markDirty({ last_name: v }), 'Kayumov'), { required: true }),
                fld('Name', textInput(emp.first_name, v => markDirty({ first_name: v }), 'Arabbek'), { required: true }),
                fld('Middle name', textInput(emp.middle_name, v => markDirty({ middle_name: v }), 'Akmalovich')),
            ),
            grid2(
                fld('Phone', phoneField(emp.phone, v => markDirty({ phone: v }), '+998 90 961 00 04'), { required: true }),
                fld('Email', textInput(emp.email, v => markDirty({ email: v }), 'name@example.uz')),
            ),
        ),
    ),

    job: ({ emp, markDirty, set, lookups }) => {
        return h('div', { class: 'fade-in' },
            secHead('Stethoscope', 'Job', 'Role, department, and posting within the clinic group.'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '620px' } },
                // EMP_STAFF_TYPE_V1 — trilingual category dropdown replaces the
                // old is-doctor checkbox; «Doctors» keeps all the old side-effects.
                (() => {
                    const lang = (typeof getLang === 'function' && getLang()) || 'en';
                    const sel = h('select', {
                        style: { width: '100%', maxWidth: '320px', height: '38px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit' },
                    },
                        h('option', { value: '', selected: !emp.staff_type }, stL('choose')),
                        ...STAFF_TYPES.map(t => h('option', { value: t.key, selected: emp.staff_type === t.key }, t[lang] || t.en)),
                    );
                    sel.addEventListener('change', () => {
                        const v = sel.value;
                        const becomingDoctor = v === 'doctor';
                        const patch = { staff_type: v, is_doctor: becomingDoctor, position_id: '', specialties: becomingDoctor ? emp.specialties : [] };
                        // DOCTOR_ROLE_DEFAULT_V1 / ADMIN_DOCTOR_V1 — pre-fill the Doctor
                        // access role only for non-admins with no role picked yet.
                        if (becomingDoctor && !emp.role_id && (emp.role || '').toLowerCase() !== 'admin') {
                            const docRole = (lookups.roles || []).find(r => /doctor|врач|shifokor/i.test(r.name || ''));
                            if (docRole) patch.role_id = docRole.id;
                        }
                        set(patch);
                    });
                    return h('div', { style: { padding: '12px 14px', border: '1px solid #e5e7eb', borderRadius: '10px' } },
                        fld(stL('label'), sel),
                        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } }, stL('help')),
                    );
                })(),
                // EMP_SCHED_MODE_V1 — per-doctor scheduling mode (schedulable vs live queue)
                emp.is_doctor ? (() => {
                    const modeSel = h('select', {
                        style: { width: '100%', maxWidth: '320px', height: '38px', padding: '0 10px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '13.5px', background: 'white', fontFamily: 'inherit' },
                    },
                        h('option', { value: 'schedulable', selected: (emp.scheduling_mode || 'schedulable') === 'schedulable' }, 'По записи (расписание)'),
                        h('option', { value: 'live_queue', selected: emp.scheduling_mode === 'live_queue' }, 'Живая очередь'),
                    );
                    modeSel.addEventListener('change', () => markDirty({ scheduling_mode: modeSel.value }));
                    return h('div', { style: { padding: '12px 14px', border: '1px solid #e5e7eb', borderRadius: '10px' } },
                        fld('Приём услуг', modeSel),
                        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
                            '«По записи» — регистратор выбирает дату и время. «Живая очередь» — визит создаётся без времени.'),
                    );
                })() : null,
                emp.is_doctor ? fld('Specialties (up to 4)', specialtyPicker(emp, lookups, set)) : null,
                // EMP_ROLE_IN_JOB_V1 — the access Role is assigned in the Job tab (owner-only; the DB also enforces it).
                (emp.role || '').toLowerCase() === 'admin'
                    ? fld('Role', h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 0' } }, 'Администратор клиники — полный доступ (роль не назначается).'))
                    : !_canAssignRole()
                        ? fld('Role', h('div', { class: 'muted', style: { fontSize: '12.5px', padding: '8px 0' } }, trf('{role} · нет прав назначать роль', { role: optLabel(lookups.roles, emp.role_id) || 'No role' })))
                        : fld('Role', fkSelect(emp.role_id, lookups.roles, v => markDirty({ role_id: v }), { style: { maxWidth: '320px' } })),
                // MULTI_ROLE_V1 — additional access roles stack their permissions on top
                // of the main Role (union). Owner/admin only; not for the clinic-admin
                // (already full access); shown only when migration 128 is applied.
                (emp.__extraRolesOk && (emp.role || '').toLowerCase() !== 'admin' && _canAssignRole())
                    ? fld('Additional roles', h('div', null,
                        extraRolesControl(emp, lookups, markDirty),
                        h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px' } },
                            'Доступ = основная роль + отмеченные роли (объединение прав).')))
                    : null,
                fld('Hire date', dateInput(emp.hire_date, v => markDirty({ hire_date: v }), { style: { maxWidth: '280px' } })),
            ),
        );
    },

    license: ({ emp, markDirty }) => {
        // LICENSE_DATE_YEAR_FIX_V1 — use markDirty (not set) so the date input is NOT
        // re-rendered mid-typing. A native <input type=date> fires 'change' as soon as
        // the date is complete, so set()'s renderPanel() recreated the input and reset
        // the year to 0002 — making the year uneditable. The warning strip updates in place.
        const warn = h('div', { class: 'info-strip', style: { marginTop: '16px', display: emp.license_expiry_date ? '' : 'none' } },
            Icon('Bell', { size: 15 }),
            h('span', null, 'This license expires ', h('b', { class: 'lic-exp-v' }, emp.license_expiry_date || ''), ' — a renewal reminder will be raised for HR.'));
        const onExp = (v) => {
            markDirty({ license_expiry_date: v });
            warn.style.display = v ? '' : 'none';
            const b = warn.querySelector('.lic-exp-v'); if (b) b.textContent = v || '';
        };
        return h('div', { class: 'fade-in' },
            secHead('Doc', 'License', 'Medical license on file. We warn before expiry.'),
            h('div', { style: { maxWidth: '560px' } },
                grid2(
                    fld('License number', textInput(emp.license_number, v => markDirty({ license_number: v })), { required: true }),
                    fld('License expires on', dateInput(emp.license_expiry_date, onExp), { required: true }),
                ),
                h('div', { style: { marginTop: '16px', maxWidth: '300px' } },
                    fld('Doctor category', selectInput(emp.doctor_category, DOCTOR_CATEGORIES, v => markDirty({ doctor_category: v })))),
                warn,
            ),
        );
    },

    branches: ({ emp, markDirty, lookups }) => {
        // Toggle the clicked card in place (CSS transitions handle the visual
        // change) and refresh chrome via markDirty — a full set()/renderPanel()
        // would re-fade the whole panel and read as a blink on every click.
        const makeCard = (b) => {
            const on0  = emp.branches.has(b.id);
            const cbx  = h('span', { class: 'cbx' + (on0 ? ' on' : '') }, on0 && Icon('Check', { size: 12 }));
            const meta = h('span', { class: 'branch-meta' }, on0 ? 'Assigned' : 'Not assigned');
            const card = h('button', {
                type: 'button',
                class: 'branch-card' + (on0 ? ' on' : ''),
                onclick: () => {
                    const n = new Set(emp.branches);
                    const nowOn = !n.has(b.id);
                    nowOn ? n.add(b.id) : n.delete(b.id);
                    markDirty({ branches: n });
                    card.classList.toggle('on', nowOn);
                    cbx.classList.toggle('on', nowOn);
                    clear(cbx);
                    if (nowOn) cbx.appendChild(Icon('Check', { size: 12 }));
                    meta.textContent = nowOn ? 'Assigned' : 'Not assigned';
                },
            },
                cbx,
                h('span', { style: { flex: 1, textAlign: 'left' } },
                    h('span', { class: 'branch-name' }, b.name),
                    meta,
                ),
                Icon('Building', { size: 16 }),
            );
            return card;
        };
        return h('div', { class: 'fade-in' },
            secHead('Building', 'Branches', 'A doctor can work at several branches at once. Tick every branch this person works at.'),
            (() => {
                const allowed = _isBranchScopedActor() ? new Set(_actorBranchIds()) : null;   // EMP_BRANCH_SCOPE_V1
                const visible = allowed ? lookups.branches.filter((b) => allowed.has(b.id)) : lookups.branches;
                if (lookups.branches.length === 0)
                    return h('div', { class: 'muted', style: { fontSize: '13.5px' } }, 'No branches configured yet.');
                if (visible.length === 0)
                    return h('div', { class: 'muted', style: { fontSize: '13.5px' } },
                        'У вас нет филиалов в управлении — обратитесь к администратору клиники.');
                return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px', maxWidth: '760px' } },
                    ...visible.map(makeCard),
                );
            })(),
        );
    },

    salary: ({ emp, set, markDirty }) => {
        const isFix = emp.salary_type === 'fixed' || emp.salary_type === 'fix_plus_kpi';
        const isVar = emp.salary_type === 'percentage' || emp.salary_type === 'fix_plus_kpi';
        const toggleKpi = (k) => { const n = new Set(emp.kpis); n.has(k) ? n.delete(k) : n.add(k); set({ kpis: n }); };
        return h('div', { class: 'fade-in' },
            secHead('Wallet', 'Employment & salary', 'Contract type and how this employee is paid.'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '680px' } },
                grid2(
                    fld('Employment contract', selectInput(emp.employment_type, EMPLOYMENT_TYPES, v => markDirty({ employment_type: v })), { required: true }),
                    fld('Salary type', selectInput(emp.salary_type, SALARY_TYPES, v => set({ salary_type: v })), { required: true }),
                ),
                // SALARY_FIELDS_CONDITIONAL_V1 — only the fields the chosen
                // salary type actually uses are rendered: Fixed → amount only;
                // Percentage → % + KPIs; Fix+KPI → all. Nothing selected → none.
                (isFix || isVar) ? grid2(
                    isFix ? fld('Fixed amount (UZS)', textInput(emp.salary_fixed, v => markDirty({ salary_fixed: v }), '0', { type: 'number', step: '0.01' }), { required: true }) : h('div'),
                    isVar ? fld('Percentage (%)', textInput(emp.salary_percent, v => markDirty({ salary_percent: v }), '0', { type: 'number', step: '0.01' }), { required: true }) : h('div'),
                ) : null,
                isVar ? h('div', null,
                    h('label', { class: 'field-label' }, 'KPIs tied to bonus ', h('span', { class: 'muted', style: { fontWeight: 400 } }, '· tick all that apply')),
                    h('div', { class: 'check-list', style: { marginTop: '8px' } },
                        ...KPI_OPTS.map(([val, lbl]) => {
                            const on = emp.kpis.has(val);
                            return h('button', { type: 'button', class: 'check-row' + (on ? ' on' : ''), onclick: () => toggleKpi(val) },
                                h('span', { class: 'cbx' + (on ? ' on' : '') }, on && Icon('Check', { size: 12 })),
                                lbl,
                            );
                        }),
                    ),
                ) : null,
            ),
        );
    },

    schedule: ({ emp, set, lookups }) => {
        // WORKING_HOURS_CLINIC_BOUND_V1 — clinic (primary branch) hours, to flag a doctor day outside them.
        const _hm = (x) => { const [hh, mm] = String(x || '').split(':').map(Number); return (hh || 0) * 60 + (mm || 0); };
        const _pb = ((lookups && lookups.branches) || []).find(b => emp.branches.has(b.id));
        const _clinicWh = (_pb && _pb.working_hours && typeof _pb.working_hours === 'object' && !_pb.is_24_7) ? _pb.working_hours : null;
        const upd = (i, patch) => set({ days: emp.days.map((d, idx) => idx === i ? { ...d, ...patch } : d) });
        const copyAll = () => {
            const tpl = emp.days.find(d => d.on) || emp.days[0];
            set({ days: emp.days.map(d => ({ ...d, start: tpl.start, end: tpl.end, lunch: tpl.lunch, lunchStart: tpl.lunchStart, lunchEnd: tpl.lunchEnd })) });
        };
        const timeEl = (val, disabled, on) => { const el = h('input', { type: 'time', value: val, disabled: disabled ? '' : null }); el.onchange = () => on(el.value); return el; };
        return h('div', { class: 'fade-in' },
            secHead('Clock', 'Working days & hours', 'Set the days this employee works and their hours, including optional lunch breaks.',
                h('button', { class: 'btn btn-outline btn-sm', onclick: copyAll }, Icon('Repeat', { size: 13 }), ' Copy first row to all')),
            h('div', { class: 'day-list' },
                ...emp.days.map((d, i) => {
                    const _cw = _clinicWh ? _clinicWh[d.key] : null;
                    const _cClosed = d.on && !!_cw && _cw.enabled === false;
                    const _exceeds = d.on && _cw && _cw.enabled !== false && (_hm(d.start) < _hm(_cw.from) || _hm(d.end) > _hm(_cw.to));
                    const _warn = (_cClosed || _exceeds)
                        ? h('span', { style: { fontSize: '12.5px', color: 'var(--crit-700)', whiteSpace: 'nowrap', fontWeight: '500' } },
                            _cClosed ? '⚠ Клиника закрыта в этот день' : trf('⚠ Часы клиники: {from}–{to}', { from: _cw.from, to: _cw.to }))
                        : null;
                    return h('div', { class: 'day-row' + (d.on ? ' on' : '') },
                    cbx(d.on, () => upd(i, { on: !d.on }), {}),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                        h('div', { class: 'row', style: { gap: '12px' } },
                            h('span', { class: 'day-name' }, d.name),
                            _warn,
                            h('span', { class: 'grow' }),
                            h('div', { class: 'time-pair' },
                                timeEl(d.start, !d.on, v => upd(i, { start: v })),
                                h('span', { class: 'dash' }, '–'),
                                timeEl(d.end, !d.on, v => upd(i, { end: v })),
                            ),
                        ),
                        h('div', { class: 'row', style: { gap: '12px', marginTop: '10px' } },
                            cbx(d.lunch, () => d.on && upd(i, { lunch: !d.lunch }), { sm: true, disabled: !d.on }),
                            h('span', { class: 'lunch-label', style: { opacity: d.on ? 1 : 0.5 } }, 'Lunch break'),
                            h('span', { class: 'grow' }),
                            h('div', { class: 'time-pair', style: { opacity: d.on && d.lunch ? 1 : 0.45 } },
                                timeEl(d.lunchStart, !d.on || !d.lunch, v => upd(i, { lunchStart: v })),
                                h('span', { class: 'dash' }, '–'),
                                timeEl(d.lunchEnd, !d.on || !d.lunch, v => upd(i, { lunchEnd: v })),
                            ),
                        ),
                    ),
                ); }),
            ),
        );
    },

    services: (ctx) => ratesSection(ctx, {
        arrayKey: 'services', icon: 'Layers', title: 'Services & rates',
        sub: '% of price or fixed amount the doctor earns when they perform a service.',
        priceLabel: 'Price', pctLabel: '% of doctor',
    }),

    referral: (ctx) => ratesSection(ctx, {
        arrayKey: 'referralServices', icon: 'Coins', title: 'Referral rewards',
        sub: 'What this doctor earns when they refer a patient to another service (via “Refer to”). Applied when this doctor is the referral source on the patient’s visit — set per service, fixed amount and/or % of price.',
        priceLabel: 'Reward (UZS)', pctLabel: '% of price',
    }),

    login: ({ emp, set, markDirty, lookups }) => h('div', { class: 'fade-in' },
        secHead('Settings', 'Login & access', 'Credentials used at sign-in and the access role.'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '680px' } },
            grid2(
                fld('Login (username \u2014 unique within this clinic)', textInput(emp.username, v => markDirty({ username: v }), 'username', { autocomplete: 'off' })),
                fld('Password', textInput(emp.password, v => markDirty({ password: v }), 'Leave blank to keep current', { type: 'password', autocomplete: 'new-password' }), { hint: 'Leave blank to keep existing. Minimum 6 characters.' }),
            ),
            h('div', { style: { height: '1px', background: 'var(--ink-100)', margin: '4px 0' } }),
            h('label', { class: 'row', style: { gap: '12px', cursor: 'pointer' } },
                cbx(emp.active, () => set({ active: !emp.active })),
                h('div', null,
                    h('div', { style: { fontSize: '13.5px', fontWeight: 600, color: 'var(--ink-900)' } }, 'Account active'),
                    h('div', { class: 'muted', style: { fontSize: '12.5px' } }, "Inactive employees can't sign in and are hidden from scheduling."),
                ),
            ),
        ),
    ),

    // Per-doctor consultation prices. Each row overrides the clinic default for
    // one consultation type; blank input = use the clinic default. CONSULTATION_PRICE_V1
    consultations: ({ emp, markDirty, lookups }) => {
        const wrap = h('div', { class: 'fade-in' });
        wrap.appendChild(secHead('Stethoscope', 'Consultations', "This doctor's price per consultation type (blank = clinic default)."));
        const types = lookups.consultationTypes || [];
        if (!types.length) {
            wrap.appendChild(h('div', { class: 'muted', style: { padding: '24px 16px', textAlign: 'center', fontSize: '13.5px' } },
                'No consultation types yet. Add them under Settings → Doctor salary → Consultation types.'));
            return wrap;
        }
        const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '620px' } });
        for (const t of types) {
            const def = Number(t.default_price || 0);
            // State is now an object per type: { price, available, is_free }.
            // Anything missing falls back to the clinic default (available, not free).
            const cur = emp.consultationPrices[t.id] || {};
            const curPrice = (cur.price === '' || cur.price == null) ? '' : cur.price;
            const curAvail = cur.available !== false;   // default available
            const curFree  = cur.is_free === true;

            // Helper: rewrite this type's setting into the consultationPrices map.
            const patch = (over) => {
                const cell = { price: curPrice, available: curAvail, is_free: curFree, ...emp.consultationPrices[t.id], ...over };
                const next = { ...emp.consultationPrices, [t.id]: cell };
                markDirty({ consultationPrices: next });
            };

            const availI = h('input', { type: 'checkbox' });
            availI.checked = curAvail;
            availI.onchange = () => patch({ available: availI.checked });

            const priceI = h('input', {
                type: 'number', step: '0.01',
                value: curPrice,
                placeholder: String(def),
            });
            priceI.disabled = curFree;
            if (curFree) priceI.style.opacity = '0.5';
            priceI.oninput = () => patch({ price: priceI.value === '' ? null : priceI.value });

            const freeI = h('input', { type: 'checkbox' });
            freeI.checked = curFree;
            freeI.onchange = () => { patch({ is_free: freeI.checked }); priceI.disabled = freeI.checked; priceI.style.opacity = freeI.checked ? '0.5' : ''; };

            const nameRow = h('div', { style: { minWidth: 0 } },
                h('div', { class: 'svc-name', title: t.name_ru || t.name_uz || '' }, t.name_ru || t.name_uz || t.name_en || '—'),
                t.name_uz ? h('span', { class: 'muted', style: { fontSize: '12.5px' } }, t.name_uz) : null,
            );
            const controls = h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' } },
                h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' } }, availI, 'Available'),
                h('div', { class: 'in-box', style: { width: '130px' } }, priceI),
                h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' } }, freeI, 'Free'),
            );
            list.appendChild(fld(
                nameRow,
                controls,
                { hint: `Clinic default: ${def} · blank price = default · free overrides price` },
            ));
        }
        wrap.appendChild(list);
        return wrap;
    },
};

// Shared per-service rate grid — searchable, with select-all, bulk %, per-row
// branch picker. Used for both "Services & rates" (performed) and "Referral
// rewards", parameterised by `cfg` (which emp array, labels, icon). Uses
// markDirty (not set) so its own row re-render isn't clobbered by a full panel
// rebuild, which would also reset the local search/filter.
function ratesSection({ emp, markDirty, lookups }, cfg) {
    const { arrayKey, icon, title, sub, priceLabel, pctLabel } = cfg;
    const rows = () => emp[arrayKey];
    const types = ['All types', ...Array.from(new Set(rows().map(s => s.typeName)))];
    let q = '', typeFilter = 'All types', bulkPct = '';

    const wrap = h('div', { class: 'fade-in' });
    const scroll = h('div', { class: 'svc-scroll' });
    const selCountBadge = h('span', { class: 'emp-badge ok', style: { background: 'var(--primary-50)', color: 'var(--primary-700)' } });
    const commit = () => markDirty({ [arrayKey]: emp[arrayKey] });

    // Quiet patch — update state without rebuilding rows (so price/% inputs and
    // the branch picker keep focus while editing).
    const patchS = (id, patch) => {
        const arr = emp[arrayKey];
        const idx = arr.findIndex(s => s.id === id);
        if (idx < 0) return;
        arr[idx] = { ...arr[idx], ...patch };
        commit();
    };
    // Toggle on/off — needs a row re-render (row styling) + count refresh.
    const toggleS = (id) => {
        const arr = emp[arrayKey];
        const idx = arr.findIndex(s => s.id === id);
        if (idx < 0) return;
        arr[idx] = { ...arr[idx], on: !arr[idx].on };
        commit();
        refreshCount();
        renderRows();
    };
    const refreshCount = () => { clear(selCountBadge); selCountBadge.append(h('span', { class: 'd', style: { background: 'var(--primary-500)' } }), ` ${rows().filter(s => s.on).length} selected`); };

    function visible() {
        return rows().filter(s =>
            (typeFilter === 'All types' || s.typeName === typeFilter) &&
            s.name.toLowerCase().includes(q.toLowerCase()));
    }
    function renderRows() {
        // RATES_SCROLL_KEEP_V1 — ticking a row rebuilds the list; keep the scroll
        // position so the user continues ticking right where they were.
        const _keepScroll = scroll.scrollTop;
        clear(scroll);
        const list = visible();
        syncSelectAll();
        if (list.length === 0) {
            scroll.appendChild(h('div', { class: 'muted', style: { padding: '24px 16px', textAlign: 'center', fontSize: '13.5px' } }, 'No services match your search.'));
            return;
        }
        for (const s of list) {
            scroll.appendChild(h('div', { class: 'svc-grid svc-row' + (s.on ? ' on' : '') },
                cbx(s.on, () => toggleS(s.id), {}),
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'svc-name', title: s.name }, s.name),
                    h('span', { class: 'svc-type-tag' }, s.typeName),
                ),
                branchPicker(s.branches, lookups.branches, (v) => patchS(s.id, { branches: v })),
                priceBox(s.price, (v) => patchS(s.id, { price: v })),
                pctBox(s.pct, (v) => patchS(s.id, { pct: v })),
            ));
        }
        scroll.scrollTop = _keepScroll;   // RATES_SCROLL_KEEP_V1
    }

    const allOn = () => { const v = visible(); return v.length > 0 && v.every(s => s.on); };
    // The "Select all" checkbox reflects whether every *visible* row is on, and
    // re-syncs on every selection / search / filter change (called in renderRows).
    const selAllCbx = h('span', { class: 'cbx sm' }, Icon('Check', { size: 10 }));
    const syncSelectAll = () => { selAllCbx.classList.toggle('on', allOn()); };
    const selectAll = () => {
        const want = !allOn();
        const vis = new Set(visible().map(s => s.id));
        emp[arrayKey] = emp[arrayKey].map(s => vis.has(s.id) ? { ...s, on: want } : s);
        commit();
        refreshCount(); renderRows();
    };
    // Bulk "Set % for all" — a one-shot action: apply the typed % to every
    // visible row, then clear the field. Guarded against an empty value so
    // blurring an empty field never wipes everyone's percentage to 0, and the
    // clear-after means it won't re-clobber later per-row edits.
    const applyPctAll = () => {
        const raw = (bulkEl.value ?? '').trim();
        if (raw === '') return;
        const n = Number(raw) || 0;
        const vis = new Set(visible().map(s => s.id));
        emp[arrayKey] = emp[arrayKey].map(s => vis.has(s.id) ? { ...s, pct: n } : s);
        commit();
        bulkEl.value = ''; bulkPct = '';
        renderRows();
    };

    const searchEl = h('input', { placeholder: 'Search services…' });
    searchEl.oninput = () => { q = searchEl.value; renderRows(); };
    const typeEl = selectInput(typeFilter, types.map(t => [t, t]), v => { typeFilter = v; renderRows(); }, { class: 'svc-type' });
    const bulkEl = h('input', { type: 'number', value: '', title: 'Type a %, then press Enter or Tab to apply it to all listed services' });
    bulkEl.oninput = () => { bulkPct = bulkEl.value; };
    bulkEl.onblur = applyPctAll;
    bulkEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPctAll(); } };

    wrap.append(
        secHead(icon, title, sub, selCountBadge),
        h('div', { class: 'svc-toolbar' },
            h('div', { class: 'svc-search' }, Icon('Search', { size: 15 }), searchEl),
            typeEl,
            h('span', { class: 'grow' }),
            h('button', { class: 'link-btn', type: 'button', onclick: selectAll },
                selAllCbx, 'Select all'),
            h('div', { class: 'bulk-pct' }, h('span', null, 'Set % for all'), bulkEl, h('span', null, '%')),
        ),
        h('div', { class: 'svc-grid svc-grid-head' },
            h('span'), h('span', null, 'Service'), h('span', null, 'Branches'),
            h('span', { style: { textAlign: 'right' } }, priceLabel),
            h('span', { style: { textAlign: 'right' } }, pctLabel),
        ),
        scroll,
    );
    refreshCount();
    renderRows();
    return wrap;
}

function priceBox(val, on) {
    const inp = h('input', { type: 'number', value: val ?? 0, placeholder: '0' });
    inp.oninput = () => on(inp.value === '' ? 0 : Number(inp.value));
    return h('div', { class: 'in-box' }, inp);
}
function pctBox(val, on) {
    const inp = h('input', { type: 'number', value: val ?? 0, placeholder: '0' });
    inp.oninput = () => on(inp.value === '' ? 0 : Number(inp.value));
    return h('div', { class: 'in-box' }, inp, h('span', { class: 'suf' }, '%'));
}

// Per-service tickable branch dropdown (fixed-positioned popup).
function branchPicker(value, branches, onChange) {
    const sel = new Set(value || []);
    // SOLE_BRANCH_V1 — филиал один: «All branches» скрывает от глаз тот
    // единственный филиал, к которому и относится ставка. Показываем его имя.
    const label = () => sel.size === 0 ? 'No branches'
        : (sel.size === branches.length && branches.length > 1) ? 'All branches'
        : branches.filter(b => sel.has(b.id)).map(b => b.name).join(', ');
    const btn = h('button', { type: 'button', class: 'bsel-btn' },
        h('span', { class: 'bsel-label' }, label()),
        h('span', null, Icon('ChevronDown', { size: 12 })),
    );
    let pop = null, scrim = null;
    const close = () => { pop?.remove(); scrim?.remove(); pop = scrim = null; btn.classList.remove('open'); };
    const refreshLabel = () => { btn.firstChild.textContent = label(); };
    const toggle = (id) => { sel.has(id) ? sel.delete(id) : sel.add(id); onChange([...sel]); refreshLabel(); paintPop(); };
    function paintPop() {
        if (!pop) return;
        clear(pop);
        for (const b of branches) {
            const on = sel.has(b.id);
            pop.appendChild(h('button', { type: 'button', class: 'bsel-opt' + (on ? ' on' : ''), onclick: () => toggle(b.id) },
                h('span', { class: 'cbx sm' + (on ? ' on' : '') }, on && Icon('Check', { size: 10 })),
                b.name,
            ));
        }
    }
    btn.onclick = () => {
        if (pop) { close(); return; }
        const r = btn.getBoundingClientRect();
        scrim = h('div', { class: 'bsel-scrim', onclick: close });
        pop = h('div', { class: 'bsel-pop', style: { top: (r.bottom + 5) + 'px', left: r.left + 'px', width: Math.max(r.width, 200) + 'px' } });
        document.body.append(scrim, pop);
        btn.classList.add('open');
        paintPop();
    };
    return h('div', { class: 'bsel' }, btn);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
export async function saveEmployee(emp, row) {
    const fullName = composeName(emp);
    if (!fullName) throw new Error('Surname or name is required.');
    // EMP_ROLE_IN_JOB_V1 — the consulting-room requirement was dropped (a room is assigned later under Rooms & floors).

    const working_hours = {};
    emp.days.forEach((d) => {
        working_hours[d.key] = {
            enabled: d.on, from: d.start, to: d.end,
            lunchEnabled: d.lunch, lunchFrom: d.lunchStart, lunchTo: d.lunchEnd,
        };
    });
    const service_rates = emp.services.filter(s => s.on).map(s => ({
        service_id: s.id,
        price: Number(s.price) || 0,
        percentage: Number(s.pct) || 0,
        branches: Array.isArray(s.branches) ? s.branches : [],
    }));
    // Referral reward rules — `fixed` is the per-referral amount, `percentage`
    // the % of price. Earned when this doctor is the referral source.
    const referral_rates = emp.referralServices.filter(s => s.on).map(s => ({
        service_id: s.id,
        fixed: Number(s.price) || 0,
        percentage: Number(s.pct) || 0,
        branches: Array.isArray(s.branches) ? s.branches : [],
    }));

    // EMP_BRANCH_SCOPE_V1 / EMP_BRANCH_VALIDATION_V1 — clamp ticked branches to the
    // actor's own scope (no-op for owners); for a branch-scoped actor creating NEW
    // staff with nothing ticked, default the hire onto the actor's own branches.
    let branchIds = _clampToActorBranches([...emp.branches]);
    if (_isBranchScopedActor() && branchIds.length === 0 && !emp.__id) {
        branchIds = _actorBranchIds();
    }
    // SOLE_BRANCH_V1 — подстраховка: единственный филиал проставляется и здесь,
    // если галочка не успела встать (список филиалов грузится асинхронно).
    if (branchIds.length === 0 && soleBranchId() != null) branchIds = [soleBranchId()];
    const num = (v) => (v === '' || v == null) ? null : Number(v);

    // EMP_BRANCH_VALIDATION_V1 — every NON-owner employee must belong to >=1 branch
    // (the branch is the operational + isolation boundary). Clinic admins/owners are
    // exempt (cross-branch by design, may be intentionally unassigned).
    const _isAdminEmp = (emp.role || '').toLowerCase() === 'admin';
    if (!_isAdminEmp && branchIds.length === 0) {
        throw new EmpValidationError('Назначьте хотя бы один филиал для сотрудника (вкладка «Branches»).');
    }
    if (emp.salary_type === 'fix_plus_kpi' && emp.kpis.size === 0) {   // DOCTOR_PAY_KPI_WIRE_V1
        throw new EmpValidationError('Для «Fix + KPI» отметьте хотя бы один KPI (вкладка «Employment & salary»).');
    }
    if (emp.password && emp.password.length < 6) {   // EMP_PW_MIN_V1 — auth RPC requires >=6; catch it before saving
        throw new EmpValidationError('Пароль должен содержать минимум 6 символов (вкладка «Login & access»).');
    }
    // NEW_EMP_PASSWORD_V1 — a login (auth account) is minted ONLY when a
    // password is set. A new employee saved with a username but no password
    // looked "created" yet could never sign in ("access is not provided").
    if (!row?.id && (emp.username || '').trim() && !(emp.password || '').trim()) {
        throw new EmpValidationError('Задайте пароль для нового сотрудника — без пароля вход в систему не создаётся (вкладка «Login & access»).');
    }

    // EMP_CLINIC_FIRST_V1 — staff created on a clinic panel belongs to THAT clinic,
    // not to the creator's own company (super admin home = SMA broke VITA adds).
    const companyId = (window.CLINIC && window.CLINIC.id)
                      || (window.easymed && window.easymed.state && window.easymed.state.user && window.easymed.state.user.company_id) || null;
    // Doctors get the auto-managed "Doctor" position; non-doctors keep their picked one.
    const positionId = emp.position_id || null;   // POSITIONS_DROP_V1 — positions consolidated into roles; no auto Doctor position.

    const payload = {
        full_name:   fullName,
        company_id:  companyId,   // CLINIC_SCOPE_FIX: rls_users_clinic_scope (RESTRICTIVE) requires company_id = the admin's clinic on insert/update
        last_name:   emp.last_name?.trim() || null,
        first_name:  emp.first_name?.trim() || null,
        middle_name: emp.middle_name?.trim() || null,
        phone:       emp.phone || null,
        email:       emp.email || null,
        position_id: positionId,
        room_id:     emp.room_id || null,
        doctor_category: emp.doctor_category || null,
        staff_type:  emp.staff_type || null,   // EMP_STAFF_TYPE_V1
        scheduling_mode: emp.scheduling_mode || 'schedulable',   // EMP_SCHED_MODE_V1 (drop-and-retry safe pre-migration 092)
        is_doctor:   emp.is_doctor === true,
        hire_date:   emp.hire_date || null,
        license_number: emp.license_number || null,
        license_expiry_date: emp.license_expiry_date || null,
        employment_type: emp.employment_type || null,
        salary_type: emp.salary_type || null,
        salary_fixed: num(emp.salary_fixed),
        salary_percent: num(emp.salary_percent),
        kpi_links:   [...emp.kpis],
        working_hours,
        service_rates,
        referral_rates,
        active:      emp.active,
        username:    emp.username || null,
        role_id:     emp.role_id || null,
        branch_id:   branchIds[0] || null,     // mirror primary branch
    };
    // ROLE_ADMIN_ONLY_V1 — never write role_id from a non-owner session (the picker
    // is read-only for them; this stops an unchanged/tampered value tripping the DB guard).
    if (!_canAssignRole()) delete payload.role_id;

    // MULTI_ROLE_V1 — additional roles: owner/admin only, and only when the column
    // exists (migration 128). Dedupe and never include the primary role_id. Omitted
    // otherwise so it can't trip the DB guard or error on a missing column.
    if (_canAssignRole() && emp.__extraRolesOk) {
        const _ex = Array.isArray(emp.extra_role_ids) ? emp.extra_role_ids.filter(Boolean).map(String) : [];
        payload.extra_role_ids = [...new Set(_ex.filter(id => id && id !== String(payload.role_id || '')))];
    }

    // EMP_ROLE_OWNER_EQUIV_V1 — assigning an OWNER-EQUIVALENT role (name resolves to
    // 'admin' -> the role-text sync trigger flips users.role to 'admin') is the owner's
    // exclusive act. A non-owner may never assign it.
    if (payload.role_id) {
        let _roleName = '';
        try {
            const _r = (emp.__roleLookup || []).find((x) => String(x.id) === String(payload.role_id));
            _roleName = (_r && _r.name ? String(_r.name) : '').toLowerCase();
        } catch (e) { _roleName = ''; }
        if (_roleName === 'admin' && !_isClinicOwner()) {
            throw new EmpValidationError('Только администратор клиники может назначить административную роль.');
        }
    }
    if (emp.password) payload.password_hash = await hashPassword(emp.password);

    // Some columns may be absent on older DBs — drop-and-retry like data.js.
    // Columns we had to drop are reported back so the caller can warn the user
    // instead of falsely claiming everything saved (e.g. referral_rates needs
    // migration 027; service_rates needs 023).
    let userId = row?.id || null;
    const dropped = [];
    const writeRow = async (op) => {
        let body = { ...payload };
        for (let i = 0; i < 8; i++) {
            const res = await op(body);
            if (!res.error) return res;
            const m = /column "?([a-z_]+)"? .* does not exist/i.exec(res.error.message || '')
                   || /could not find the '?([a-z_]+)'? column/i.exec(res.error.message || '');
            if (m && m[1] && m[1] in body) { dropped.push(m[1]); delete body[m[1]]; continue; }
            // TENANT_USERNAME_V1 — friendly message for the per-clinic username uniqueness index.
            if (/duplicate key|unique constraint/i.test(res.error.message || '') && /username/i.test(res.error.message || '')) {
                throw new Error('Этот логин уже занят в этой клинике — выберите другой.');
            }
            // STAFF_PERM_MSG_V1 — friendly message when RLS blocks the write (the role lacks
            // the «Сотрудники» (settings:users) permission) or .single() returns no row (PGRST116).
            if (res.error.code === '42501' || res.error.code === 'PGRST116'
                || /row-level security|JSON object requested|multiple \(or no\) rows/i.test(res.error.message || '')) {
                console.error('[emp-editor] users write rejected:', res.error);   // STAFF_PERM_DETAIL_V1
                throw new Error(trf('Недостаточно прав для управления сотрудниками. В редакторе ролей включите для этой роли доступ «Сотрудники» (редактирование), либо войдите как администратор клиники. [{code}: {msg}]', { code: res.error.code || '?', msg: res.error.message || '' }));
            }
            throw res.error;
        }
        throw new Error('Could not save employee (schema mismatch).');
    };

    if (userId) {
        // STAFF_UPDATE_NO_RETURNING_V1 — don't read the row back: RETURNING runs
        // the SELECT policies, and a session that may UPDATE but cannot re-SELECT
        // the row (JWT company-claim quirks) got PGRST116 here even though the
        // write landed. Verify by affected-row count instead.
        const _upRes = await writeRow((body) => supabase.from('users').update(body, { count: 'exact' }).eq('id', userId));
        if (!_upRes || _upRes.count === 0) {
            // STAFF_SAVE_DIAG_V1 — ask the DB who this session actually is, so the
            // error states facts instead of guesses.
            let _diag = '';
            try {
                const [_adm, _mgr, _au, _see] = await Promise.all([
                    supabase.rpc('current_user_is_admin'),
                    supabase.rpc('current_user_can_manage_staff'),
                    supabase.auth.getUser(),
                    supabase.from('users').select('id', { count: 'exact', head: true }).eq('id', userId),
                ]);
                _diag = ' [diag admin=' + (_adm && _adm.data) + ' staffmgr=' + (_mgr && _mgr.data)
                      + ' auth=' + ((_au && _au.data && _au.data.user && _au.data.user.id) ? _au.data.user.id.slice(0, 8) : 'NONE')
                      + ' see=' + ((_see && _see.count != null) ? _see.count : '?') + ']';
            } catch (e) { _diag = ' [diag failed: ' + (e && e.message || e) + ']'; }
            throw new Error(tr('Изменения не записаны (0 строк) — у вашей сессии нет прав на этого сотрудника.') + _diag);
        }
    } else {
        const res = await writeRow((body) => supabase.from('users').insert(body).select('id').single());
        userId = res.data.id;
    }

    // Sync the user_branches junction: clear then re-insert ticked branches.
    const syncWarnings = [];   // H1 — collect silent sync failures so the toast doesn't falsely claim "saved"
    try {
        await supabase.from('user_branches').delete().eq('user_id', userId);
        if (branchIds.length) {
            const rows = branchIds.map(bid => ({ company_id: companyId, user_id: userId, branch_id: bid }));
            const { error } = await supabase.from('user_branches').insert(rows);
            if (error) { console.warn('[emp-editor] user_branches insert:', error.message); syncWarnings.push('филиалы'); }
        }
    } catch (e) { console.warn('[emp-editor] branch sync:', e.message); syncWarnings.push('филиалы'); }

    // Specialties mirror (local) + medcore sync. SPECIALTIES_SYNC_V1
    try {
        await supabase.from('user_specialties').delete().eq('user_id', userId);
        if (emp.is_doctor && emp.specialties.length && companyId) {
            const rows = emp.specialties.slice(0, 4).map((slug, i) => {
                const s = (window.__specLookup && window.__specLookup[slug]) || {};
                return { company_id: companyId, user_id: userId, specialty_slug: slug,
                         name_ru: s.name_ru || null, name_uz: s.name_uz || null, is_primary: i === 0 };
            });
            const { error } = await supabase.from('user_specialties').insert(rows);
            if (error) { console.warn('[emp-editor] user_specialties insert:', error.message); syncWarnings.push('специальности'); }
        }
    } catch (e) { console.warn('[emp-editor] specialty sync:', e.message); syncWarnings.push('специальности'); }

    // Per-doctor consultation settings (availability / price / free).
    // Each cell is { price, available, is_free }; we persist any cell that
    // differs from the pure default (available, not free, no explicit price).
    // Free rows store price = null. CONSULTATION_PRICE_V1
    try {
        await supabase.from('doctor_consultation_prices').delete().eq('doctor_id', userId);
        if (emp.is_doctor && companyId) {
            const rows = [];
            for (const [consultation_type_id, raw] of Object.entries(emp.consultationPrices || {})) {
                const cell = (raw && typeof raw === 'object') ? raw : { price: raw };   // back-compat with the old {id: price} shape
                const available = cell.available !== false;
                const is_free = cell.is_free === true;
                const hasPrice = cell.price !== '' && cell.price != null && !Number.isNaN(Number(cell.price));
                // Skip pure-default cells (no row needed → defaults apply).
                if (available && !is_free && !hasPrice) continue;
                rows.push({
                    company_id: companyId,
                    doctor_id: userId,
                    consultation_type_id,
                    price: is_free ? null : (hasPrice ? Number(cell.price) : null),
                    available,
                    is_free,
                });
            }
            if (rows.length) { const { error } = await supabase.from('doctor_consultation_prices').insert(rows); if (error) { console.warn('[emp-editor] consultation prices:', error.message); syncWarnings.push('цены консультаций'); } }
        }
    } catch (e) { console.warn('[emp-editor] consultation price sync:', e.message); syncWarnings.push('цены консультаций'); }

    // Push to medcore via the gateway.
    // #26 — sync on DEMOTION too: if the person already has a medcore link (core_doctor_id), call the
    // gateway even when is_doctor is now false, so un-checking it sets is_active=false and takes them OFF
    // the Symptex marketplace. (Previously the whole block was gated on emp.is_doctor → demotion left them live.)
    let _coreDoctorId = null;
    try { const { data: _u } = await supabase.from('users').select('core_doctor_id').eq('id', userId).maybeSingle(); _coreDoctorId = (_u && _u.core_doctor_id) || null; } catch (e) { /* fail-soft */ }
    if (emp.is_doctor || _coreDoctorId) {
        let clinicCoreId = (window.CLINIC && window.CLINIC.core_id) || null;
        if (!clinicCoreId && companyId) {
            try { const p = await gw('/clinics/profile?company_id=' + companyId); clinicCoreId = (p && (p.id || p.core_clinic_id)) || null; }
            catch (e) { console.warn('[emp-editor] clinic core id:', e.message); }
        }
        try {
            const res = await gw('/identity/doctor', { method: 'POST', body: {
                user_id: userId,
                clinic_core_id: clinicCoreId,
                // #24 — set ALL three name columns (the editor has one name field), else a prior self-edit's
                //       uz/en strand at the old name when an admin renames (gateway only overrode full_name_ru).
                // #26 — is_active follows is_doctor so a demotion deactivates the marketplace listing.
                fields: { full_name_ru: fullName, full_name_uz: fullName, full_name_en: fullName, is_active: !!emp.is_doctor },
                specialty_slugs: emp.specialties.slice(0, 4),
            } });
            if (res && res.core_doctor_id) {
                await supabase.from('users').update({ core_doctor_id: res.core_doctor_id }).eq('id', userId);
            }
        } catch (e) {
            console.warn('[emp-editor] doctor sync:', e.message);
            toast('Saved locally, but doctor sync to the marketplace failed: ' + (e.message || e), 'fail');
        }
    }

    // Wire the Supabase Auth side. Without this, login by username/password
    // fails because Supabase Auth has no idea who this user is — only the
    // legacy users.password_hash got set above.
    //
    // admin_reset_user_password handles both cases atomically:
    //   - user has no auth_user_id   → mint auth.users + auth.identities + link.
    //   - user has auth_user_id      → bcrypt-rotate auth.users.encrypted_password.
    // Reported back to the caller as authError so the toast can mention it.
    let authError = null;
    if (emp.password) {
        try {
            const { error } = await supabase.rpc('admin_reset_user_password', {
                target_user_id: userId,
                new_password:   emp.password,
            });
            if (error) authError = error.message || String(error);
        } catch (e) {
            authError = e.message || String(e);
        }
    }

    return { dropped, authError, userId, syncWarnings };
}

// ---------------------------------------------------------------------------
// Scoped CSS — injected once.
// ---------------------------------------------------------------------------
function injectCss() {
    if (document.getElementById('emp-editor-css')) return;
    const style = document.createElement('style');
    style.id = 'emp-editor-css';
    style.textContent = EDITOR_CSS;
    document.head.appendChild(style);
}

const EDITOR_CSS = `
.emp-overlay { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 28px; }
.emp-scrim { position: absolute; inset: 0; background: rgba(11,20,24,0.45); backdrop-filter: blur(3px); }
.emp-modal { position: relative; z-index: 1; width: min(1080px, 100%); height: min(760px, calc(100vh - 56px));
  background: white; border-radius: 16px; box-shadow: 0 30px 80px rgba(11,20,24,0.30);
  display: flex; flex-direction: column; overflow: hidden; animation: empPop 160ms ease; }
@keyframes empPop { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: none; } }

.emp-head { position: relative; display: flex; align-items: center; gap: 16px; padding: 18px 20px;
  border-bottom: 1px solid var(--ink-100); background: linear-gradient(115deg, var(--primary-50), white 58%); }
.emp-avatar { position: relative; flex: 0 0 56px; width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center;
  color: white; font-weight: 700; font-size: 20px; letter-spacing: 0.02em; box-shadow: 0 6px 16px rgba(11,20,24,0.16), 0 0 0 3px white; }
.emp-cam { position: absolute; right: -5px; bottom: -5px; width: 22px; height: 22px; border-radius: 999px; background: white;
  color: var(--primary-700); display: grid; place-items: center; box-shadow: 0 1px 4px rgba(0,0,0,0.20); border: 1px solid var(--ink-100); cursor: pointer; }
.emp-cam:hover { color: var(--primary-800); background: var(--primary-50); }
.emp-head-main { flex: 1; min-width: 0; }
.emp-title { font-size: 17px; font-weight: 700; color: var(--ink-900); letter-spacing: -0.01em; }
.emp-sub { font-size: 12.5px; color: var(--ink-500); margin-top: 2px; }
.emp-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 700; }
.emp-badge .d { width: 6px; height: 6px; border-radius: 999px; }
.emp-badge.ok { background: var(--ok-50); color: var(--ok-700); } .emp-badge.ok .d { background: var(--ok-500); }
.emp-badge.off { background: var(--ink-100); color: var(--ink-600); } .emp-badge.off .d { background: var(--ink-400); }
.emp-chips { display: flex; gap: 7px; margin-top: 9px; flex-wrap: wrap; }
.emp-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: white;
  border: 1px solid var(--ink-200); font-size: 12.5px; font-weight: 600; color: var(--ink-700); }
.emp-chip svg { color: var(--ink-400); }
.emp-chip.warn { background: var(--warn-50); border-color: color-mix(in oklab, var(--warn-500) 28%, white); color: var(--warn-700); }
.emp-chip.warn svg { color: var(--warn-700); }
.emp-progress { display: flex; flex-direction: column; align-items: center; gap: 3px; margin-right: 2px; }
.emp-progress .lbl { font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-500); }

.emp-body { flex: 1; display: grid; grid-template-columns: 220px 1fr; min-height: 0; }
.emp-rail { border-right: 1px solid var(--ink-100); padding: 12px; display: flex; flex-direction: column; gap: 2px; background: var(--ink-25); overflow-y: auto; }
.emp-rail-group { font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-400); padding: 12px 12px 5px; }
.emp-rail > div:first-child .emp-rail-group { padding-top: 4px; }
.emp-rail-item { position: relative; display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 12px; border-radius: 9px;
  background: transparent; border: none; color: var(--ink-600); font-size: 13.5px; font-weight: 500; font-family: inherit; cursor: pointer; }
.emp-rail-item:hover { background: var(--ink-50); color: var(--ink-900); }
.emp-rail-item.on { background: white; color: var(--primary-700); font-weight: 600; box-shadow: 0 1px 2px rgba(11,20,24,0.06); }
.emp-rail-item.on svg { color: var(--primary-600); }
.emp-rail-item.on::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 999px; background: var(--primary-600); }
.emp-rail-item > svg:last-child { color: var(--ok-700); margin-left: auto; }
.emp-dot-todo { flex: 0 0 auto; margin-left: auto; width: 8px; height: 8px; border-radius: 999px; background: var(--crit-500); box-shadow: 0 0 0 3px color-mix(in oklab, var(--crit-500) 14%, transparent); }
.emp-dot-opt { flex: 0 0 auto; margin-left: auto; width: 8px; height: 8px; border-radius: 999px; background: var(--ink-300); }

.emp-panel { padding: 26px 30px; overflow-y: auto; min-height: 0; }
/* Section switches re-render the panel root. Override the global .fade-in
   (opacity + upward translate, 200ms) with a quick opacity-only fade so each
   rail press feels smooth instead of blinking/jumping into place. */
.emp-panel > .fade-in { animation: empPanelFade 130ms ease-out both; }
@keyframes empPanelFade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .emp-panel > .fade-in { animation: none; } }
.emp-foot { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--ink-100); background: var(--ink-25); }

.emp-panel .sec-title { font-size: 17px; font-weight: 700; color: var(--ink-900); letter-spacing: -0.015em; margin: 0; }
.emp-panel .sec-sub { font-size: 13.5px; color: var(--ink-500); margin: 4px 0 0; max-width: 560px; line-height: 1.5; }
.emp-panel .field-label { font-size: 12.5px; font-weight: 600; color: var(--ink-700); }
.emp-panel .field label { font-size: 12.5px; font-weight: 600; color: var(--ink-700); }
.emp-panel .field input:not([type=checkbox]), .emp-panel .field select { width: 100%; box-sizing: border-box; }
.emp-panel .hint { font-size: 12.5px; color: var(--ink-500); margin-top: 4px; display: block; }
.sec-badge { flex: 0 0 38px; width: 38px; height: 38px; border-radius: 11px; background: var(--primary-50); color: var(--primary-700); display: grid; place-items: center; margin-right: 14px; }

.cbx { flex: 0 0 20px; width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--ink-300); background: white;
  display: grid; place-items: center; color: white; cursor: pointer; transition: all 100ms ease; padding: 0; }
.cbx.sm { width: 16px; height: 16px; border-radius: 5px; flex-basis: 16px; }
.cbx.on { background: var(--primary-600); border-color: var(--primary-600); }
.cbx:disabled { opacity: 0.45; cursor: default; }

.info-strip { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: 10px; background: var(--warn-50);
  color: var(--warn-700); font-size: 12.5px; border: 1px solid color-mix(in oklab, var(--warn-500) 25%, white); }
.info-strip b { color: var(--warn-700); }

.branch-card { display: flex; align-items: center; gap: 11px; padding: 14px; border-radius: 12px; border: 1.5px solid var(--ink-200);
  background: white; cursor: pointer; font-family: inherit; transition: all 110ms ease; }
.branch-card:hover { border-color: var(--ink-300); }
.branch-card.on { border-color: var(--primary-500); background: var(--primary-50); }
/* Only tint the card's own (right-side) icon — NOT the white check inside the
   green .cbx box, which lives in a nested span. Without the child combinator
   the check became green-on-green and disappeared. */
.branch-card.on > svg { color: var(--primary-600); } .branch-card > svg { color: var(--ink-300); }
.branch-name { display: block; font-size: 13.5px; font-weight: 600; color: var(--ink-900); }
.branch-meta { display: block; font-size: 12.5px; color: var(--ink-500); margin-top: 2px; }

.check-list { display: flex; flex-direction: column; gap: 8px; }
.check-row { display: flex; align-items: center; gap: 11px; padding: 11px 14px; border-radius: 10px; border: 1px solid var(--ink-200);
  background: white; cursor: pointer; font-family: inherit; font-size: 13.5px; color: var(--ink-800); font-weight: 500; text-align: left; }
.check-row:hover { border-color: var(--ink-300); background: var(--ink-25); }
.check-row.on { border-color: var(--primary-400); background: var(--primary-50); color: var(--primary-800); }

.day-list { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--ink-200); border-radius: 12px; overflow: hidden; max-width: 720px; }
.day-row { display: flex; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--ink-100); background: var(--ink-25); transition: background 100ms ease; }
.day-row:last-child { border-bottom: none; } .day-row.on { background: white; }
.day-name { font-size: 13.5px; font-weight: 600; color: var(--ink-900); }
.lunch-label { font-size: 12.5px; color: var(--ink-600); }
.time-pair { display: inline-flex; align-items: center; gap: 8px; }
.time-pair input { height: 34px; width: 104px; padding: 0 10px; border: 1px solid var(--ink-200); border-radius: 8px; font-size: 13.5px; color: var(--ink-900); background: white; font-family: inherit; }
.time-pair input:focus { outline: none; border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-50); }
.time-pair input:disabled { background: var(--ink-50); color: var(--ink-400); }
.time-pair .dash { color: var(--ink-400); }

.svc-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.svc-search { position: relative; flex: 1; min-width: 220px; display: flex; align-items: center; }
.svc-search svg { position: absolute; left: 12px; color: var(--ink-400); }
.svc-search input { width: 100%; height: 38px; padding: 0 12px 0 36px; border: 1px solid var(--ink-200); border-radius: 9px; font-family: inherit; font-size: 13.5px; color: var(--ink-900); }
.svc-search input:focus { outline: none; border-color: var(--primary-500); box-shadow: 0 0 0 4px var(--primary-50); }
.svc-type { height: 38px; padding: 0 30px 0 12px; border: 1px solid var(--ink-200); border-radius: 9px; font-family: inherit; font-size: 13.5px; color: var(--ink-800); background: white; }
.link-btn { display: inline-flex; align-items: center; gap: 7px; background: none; border: none; color: var(--primary-700); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; }
.bulk-pct { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--ink-600); }
.bulk-pct input { width: 56px; height: 32px; text-align: right; padding: 0 8px; border: 1px solid var(--ink-200); border-radius: 8px; font-family: var(--font-mono); font-size: 12.5px; }
.bulk-pct input:focus, .svc-type:focus { outline: none; border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-50); }

.svc-grid { display: grid; grid-template-columns: 28px 1fr 190px 96px 88px; gap: 12px; align-items: center; }
.svc-grid-head { padding: 0 14px 8px; font-size: 12.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-500); }
.svc-scroll { border: 1px solid var(--ink-200); border-radius: 12px; overflow: hidden; max-height: 380px; overflow-y: auto; }
.svc-row { padding: 12px 14px; border-bottom: 1px solid var(--ink-100); } .svc-row:last-child { border-bottom: none; } .svc-row.on { background: var(--primary-50); }
.svc-name { font-size: 12.5px; color: var(--ink-900); font-weight: 500; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc-type-tag { display: inline-block; margin-top: 4px; font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-500); background: var(--ink-100); padding: 1px 7px; border-radius: 999px; }

.bsel { position: relative; }
.bsel-btn { display: flex; align-items: center; gap: 6px; width: 100%; height: 32px; padding: 0 9px; border: 1px solid var(--ink-200); border-radius: 8px; background: white; font-family: inherit; font-size: 12.5px; color: var(--ink-800); cursor: pointer; }
.bsel-btn:hover { border-color: var(--ink-300); } .bsel-btn.open { border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-50); }
.bsel-label { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bsel-btn svg { color: var(--ink-400); flex: 0 0 12px; }
.bsel-scrim { position: fixed; inset: 0; z-index: 300; }
.bsel-pop { position: fixed; z-index: 301; background: white; border: 1px solid var(--ink-200); border-radius: 10px; box-shadow: 0 12px 30px rgba(11,20,24,0.16); padding: 5px; display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; }
.bsel-opt { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 7px; background: transparent; border: none; font-family: inherit; font-size: 12.5px; color: var(--ink-800); cursor: pointer; text-align: left; }
.bsel-opt:hover { background: var(--ink-50); } .bsel-opt.on { color: var(--primary-800); font-weight: 600; }
.in-box { display: inline-flex; align-items: center; justify-content: flex-end; border: 1px solid var(--ink-200); border-radius: 8px; background: white; height: 32px; padding: 0 9px; gap: 3px; }
.in-box:focus-within { border-color: var(--primary-500); box-shadow: 0 0 0 3px var(--primary-50); }
.in-box input { border: none; outline: none; width: 100%; min-width: 0; text-align: right; font-family: var(--font-mono); font-size: 12.5px; color: var(--ink-900); background: transparent; padding: 0; }
.in-box .suf { font-size: 12.5px; color: var(--ink-500); flex: 0 0 auto; }

@media (max-width: 720px) {
  .emp-body { grid-template-columns: 1fr; }
  .emp-rail { flex-direction: row; flex-wrap: wrap; border-right: none; border-bottom: 1px solid var(--ink-100); }
}
`;
