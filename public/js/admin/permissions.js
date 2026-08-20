// Role-based access control (RBAC).
//
// A role's `permissions` JSONB stores { sections: ['patients','cashier',
// 'settings:services', …] } — a flat list of permission keys. A key is
// either a top-level sidebar module id (matching the NAV ids in admin.js)
// or a Settings sub-section keyed as 'settings:<sectionKey>'.
//
// The "effective set" is the access currently in force:
//   * null  → full access (super admin, no role, or a role with no
//             permissions configured yet — we never lock someone out of a
//             freshly-created, unconfigured role).
//   * Set   → the role is restricted to exactly these keys. Every module,
//             including Dashboard, is gated by the role. admin.js lands a
//             restricted user on their first allowed module.
//
// admin.js reads isModuleAllowed()/isRouteAllowed() synchronously when it
// paints the sidebar and routes; the Documents/Roles editor reads
// permissionGroups() to render the tickable matrix.

import { SECTIONS } from './sections.js?v=noikpu1';

// ROLE_KEYS_V2 — THE canonical list of grantable modules for this build.
//
// Every key here MUST be a live module gate: either an `id` in admin.js NAV, or
// a key isModuleAllowed()/isRouteAllowed() checks by name (`registration`, and
// `cashier`, which the NAV item `cashier-shifts` accepts as an alias).
//
// This list exists because it had drifted into THREE different vocabularies —
// this file, the Roles editor in settings-hub.js, and the seeded rows in
// migration 013 — and a key granted in one was not read by the others. The
// visible damage: the Roles editor offered «Doctor's room» and wrote
// `doctor-room`, which nothing checks (the sidebar gates the doctor's cabinet on
// `consultation`). Every doctor in the clinic was therefore denied their own
// cabinet no matter what an admin ticked. `crm`, `procedures` and `registration`
// were the opposite failure: real gates that no editor could grant, so the
// registrar's «+ New patient» button was unreachable for the registrar role.
//
// Both editors and the guard test (server/db/migrations/055.test.js) read this
// one list, so the three cannot drift apart again.
export const NAV_MODULES = [
    { group: 'Overview', items: [
        { key: 'dashboard',   label: 'Дашборд', desc: 'Сводка по клинике за день' },
        { key: 'reports-hub', label: 'Отчёты',  desc: 'Отчёты за период и выгрузка в Excel' },
    ] },
    { group: 'Клинические', items: [
        { key: 'patients',          label: 'Пациенты',      desc: 'Картотека, карты, визиты, счета' },
        { key: 'registration',      label: 'Регистрация пациента', desc: 'Кнопка «+ Новый пациент» — заведение карты' },
        { key: 'crm',               label: 'CRM · Заявки',  desc: 'Обращения и лиды, конверсия в пациента' },
        { key: 'consultation',      label: 'Мои услуги (кабинет врача)', desc: 'Очередь врача, заключения, назначения' },
        // QUEUE_BOARD_V1 — раздел только читает: кнопок, меняющих данные, в нём
        // нет, поэтому ролям хватает уровня «Просмотр».
        { key: 'queue',             label: 'Очередь',       desc: 'Доска номеров: кто у какого врача, в лаборатории и на процедурах' },
        { key: 'labs',              label: 'Лаборатория',   desc: 'Рабочий список и результаты' },
        { key: 'procedures',        label: 'Процедуры',     desc: 'Очередь процедур (медсестра)' },
        { key: 'beds',              label: 'Стационар и палаты', desc: 'Койки, госпитализация и выписка' },
        { key: 'patient-documents', label: 'Документы пациентов', desc: 'Печатные документы по пациентам' },
    ] },
    { group: 'Операционные', items: [
        { key: 'cashier',      label: 'Касса',          desc: 'Смена кассира и приём оплат' },
        { key: 'cashier-head', label: 'Старший кассир', desc: 'Все смены и сверка' },
        { key: 'inventory',    label: 'Закупки и склад', desc: 'Товары, остатки, поступления' },
        // TELEGRAM_CHAT_V1 — стоит рядом с кассой и складом, потому что это
        // работа стойки, а не приёма. Уровень здесь не формальность: «Просмотр»
        // открывает чтение переписки, «Редактирование» — ответ пациенту от
        // имени клиники.
        { key: 'telegram-chat', label: 'Чат с пациентами', desc: 'Переписка в Telegram-боте: читать (Просмотр) и отвечать (Редактирование)' },
    ] },
    { group: 'Администрирование', items: [
        { key: 'settings', label: 'Настройки', desc: 'Вся конфигурация клиники' },
    ] },
];

// Flat set of the canonical keys — used by the guard test and by both editors.
export const NAV_MODULE_KEYS = NAV_MODULES.flatMap(g => g.items.map(i => i.key));

const MODULE_GROUPS = NAV_MODULES;

// Modules that bypass role gating entirely. Empty: every module (Dashboard
// included) is controlled by the role's permission list. A restricted user
// lands on their first allowed module (see admin.js firstAllowedView()).
const ALWAYS_ALLOWED = new Set(['specialties']);  // specialties: global read-only reference; viewable by any role, add is super-admin-gated (SPECIALTIES_VIEW_V1)

// ---------------------------------------------------------------------------
// Effective access state
// ---------------------------------------------------------------------------
// Each allowed key also carries an access LEVEL — 'viewer' | 'editor' |
// 'admin'. Stored in roles.permissions as { sections:[...], levels:{key:lvl} }.
//   * viewer → read-only
//   * editor → can create / edit
//   * admin  → can create / edit / DELETE
// A key that is allowed (in `sections`) but has no explicit level falls back to
// 'admin' so older roles configured before levels existed keep full control.
let _effective    = null;   // Set<string> | null (null = full access)
let _levels       = {};     // { key: 'viewer'|'editor'|'admin' }
let _patientTabs  = {};     // { tabId: 'none'|'view'|'edit' } — absent key = visible (default)
let _roleLabel    = null;   // human label of the role currently in force

export const ACCESS_LEVELS = ['viewer', 'editor', 'admin'];

export function currentRoleLabel() { return _roleLabel; }
export function hasRestriction()   { return _effective instanceof Set; }

// Grant full access (super admin / no role / "view as Super Admin").
export function setFullAccess(label = null) {
    _effective = null;
    _levels    = {};
    _patientTabs = {};
    _roleLabel = label;
}

// Apply a role row's permissions. An empty/missing sections list means the
// role is unconfigured → full access (don't lock the user out).
export function setEffectiveFromRole(roleRow) {
    const perms    = (roleRow && roleRow.permissions) || null;
    const sections = perms && Array.isArray(perms.sections) ? perms.sections : null;
    _levels = (perms && perms.levels && typeof perms.levels === 'object') ? { ...perms.levels } : {};
    _patientTabs = (perms && perms.patient_tabs && typeof perms.patient_tabs === 'object') ? { ...perms.patient_tabs } : {};
    // SERVICES_TAB_V1 shim — the Услуги tab split out of Визиты; role configs saved
    // before the split have no 'services' key, so inherit the visits restriction.
    if (_patientTabs.visits === 'none' && _patientTabs.services == null) _patientTabs.services = 'none';
    // ROLE_AUDIT_V1 (fix #3) — an empty/unconfigured role is FAIL-CLOSED (was:
    // null = full access, reachable via the role-preview and any future caller).
    // Full access is granted only through explicit setFullAccess().
    if (!sections || sections.length === 0) {
        _effective = new Set(['__no_access__']);
    } else {
        _effective = new Set(sections);
    }
    _roleLabel = roleRow ? (roleRow.name || 'Role') : null;
}

// MULTI_ROLE_V1 — a user can hold a PRIMARY role plus extra roles. Effective access
// is the UNION: any section any role grants, the HIGHEST level per area, and the
// MOST-permissive patient-tab setting. roleRows[0] is the primary (its name is the
// label). Empty / all-no-access → fail closed, same as setEffectiveFromRole.
const _LEVEL_RANK = { viewer: 1, editor: 2, admin: 3 };
const _TAB_RANK   = { none: 0, view: 1, edit: 2, delete: 3 };
const _RANK_TAB   = { 0: 'none', 1: 'view', 2: 'edit', 3: 'delete' };

export function setEffectiveFromRoles(roleRows) {
    const rows = (roleRows || []).filter(Boolean);
    if (rows.length <= 1) { setEffectiveFromRole(rows[0] || null); return; }

    const sections = new Set();
    const levels = {};
    for (const r of rows) {
        const p = (r && r.permissions) || {};
        for (const s of (Array.isArray(p.sections) ? p.sections : [])) {
            if (s && s !== '__no_access__') sections.add(s);
        }
        const lv = (p.levels && typeof p.levels === 'object') ? p.levels : {};
        for (const [k, v] of Object.entries(lv)) {
            if ((_LEVEL_RANK[v] || 0) > (_LEVEL_RANK[levels[k]] || 0)) levels[k] = v;
        }
    }
    // patient_tabs: a tab is restricted only if EVERY role restricts it — absence in
    // ANY role means that role grants it fully (absent = visible+editable), so the
    // union is fully permissive. Otherwise keep the MOST-permissive explicit value.
    const allTabs = new Set();
    for (const r of rows) for (const k of Object.keys((r.permissions && r.permissions.patient_tabs) || {})) allTabs.add(k);
    const tabs = {};
    for (const tab of allTabs) {
        let maxRank = 0;
        for (const r of rows) {
            const pt = (r.permissions && r.permissions.patient_tabs) || {};
            const rank = (tab in pt) ? (_TAB_RANK[pt[tab]] ?? 3) : 3;   // absent = fully permissive
            if (rank > maxRank) maxRank = rank;
        }
        if (maxRank < 3) tabs[tab] = _RANK_TAB[maxRank];   // store only real restrictions
    }
    if (tabs.visits === 'none' && tabs.services == null) tabs.services = 'none';   // SERVICES_TAB_V1 shim

    _effective   = sections.size ? sections : new Set(['__no_access__']);
    _levels      = levels;
    _patientTabs = tabs;
    _roleLabel   = (rows[0] && rows[0].name) || 'Roles';
}

export function getEffectiveSet() { return _effective; }

// ---------------------------------------------------------------------------
// Access level for a permission key — drives who can edit vs. delete.
// 'none' = no access; otherwise 'viewer' | 'editor' | 'admin'. Full-access
// actors (super admin / unconfigured role) are 'admin' everywhere.
//
// IMPORTANT: when a key is GRANTED to a role but no explicit level is set, we
// default to 'editor' — *not* 'admin'. Admin (which gates delete) must be
// granted explicitly. This keeps a misconfigured / legacy role from silently
// having delete rights everywhere (the bug that left "Delete visit" visible
// for registrars).
// ---------------------------------------------------------------------------
export function accessLevelFor(key) {
    if (_effective == null) return 'admin';   // super admin / no-role: full access
    if (!key) return 'admin';
    if (_effective.has(key)) return _levels[key] || 'editor';
    // A Settings sub-section inherits the Settings-home level if that's all the
    // role was granted.
    if (key.startsWith('settings:') && _effective.has('settings')) {
        return _levels['settings'] || 'viewer';   // LEAST_PRIV_INHERIT_V1 — bare Settings grants READ-ONLY on sub-sections; edit must be granted explicitly
    }
    return 'none';
}
export function canView(key)   { return accessLevelFor(key) !== 'none'; }
export function canEdit(key)   { const l = accessLevelFor(key); return l === 'editor' || l === 'admin'; }
export function canDelete(key) { return accessLevelFor(key) === 'admin'; }

// LAB_ROLE_SETTINGS_V1 — the Lab role can reach + edit lab service settings
// (Лаборатория и диагностика) either through the explicit «settings:lab_settings»
// grant OR by holding the Laboratory module at edit/delete level. Used by
// isModuleAllowed('settings') and isRouteAllowed('lab-settings').
export function canManageLabSettings() {
    if (_effective == null) return true;   // full access
    return _effective.has('settings:lab_settings')
        || _effective.has('lab-settings')
        || canEdit('labs');
}

// PROCUREMENT_REQ_GRANT_V1 — «Заявки на закупку» is a SEPARATE grant so a nurse
// can raise requisitions for their department without seeing the rest of
// Procurement (stock, purchase orders, suppliers, valuation, counts).
//   canProcurementFull()         → the whole module (has 'procurement')
//   canProcurementRequisitions() → at least the requisitions tab
export function canProcurementFull() {
    if (_effective == null) return true;
    return _effective.has('procurement');
}
export function canProcurementRequisitions() {
    if (_effective == null) return true;
    return _effective.has('procurement') || _effective.has('procurement:requisitions');
}

// PATIENT_TAB_PERMS_V1 — per-patient-card-tab gating. Default is VISIBLE: a role
// only restricts tabs it explicitly lists (so existing roles see everything).
export const PATIENT_TABS = [
    { id: 'overview',    label: 'Деталь' },
    { id: 'visits',      label: 'Визиты' },
    { id: 'services',    label: 'Услуги' },
    { id: 'recommended', label: 'Рекомендации' },
    { id: 'labs',        label: 'Лаборатория' },
    { id: 'rx',          label: 'Назначения' },
    { id: 'docs',        label: 'Документы' },
    { id: 'billing',     label: 'Счёт' },
    { id: 'loyalty',     label: 'Лояльность' },
    { id: 'chat',        label: 'Чат' },
];
export function canViewPatientTab(tab) {
    if (_effective == null) return true;          // super admin / clinic admin / no-role
    const l = _patientTabs[tab];
    return l == null || l !== 'none';             // absent = visible
}
export function patientTabCanEdit(tab, need) {
    if (_effective == null) return true;
    const l = _patientTabs[tab];
    if (need === 'delete') return l === 'delete';
    return l == null || l === 'edit' || l === 'delete';
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
// Is a top-level sidebar module visible? The Settings module is special: it
// shows when the role can reach the Settings home OR any single sub-section.
export function isModuleAllowed(navId) {
    if (_effective == null) return true;
    if (ALWAYS_ALLOWED.has(navId)) return true;
    if (navId === 'settings') {
        if (_effective.has('settings')) return true;
        for (const k of _effective) if (k.startsWith('settings:')) return true;
        // ROLE_AUDIT_V2 — Documents (print-forms) and the other special pages
        // live INSIDE the Settings home (there is no top-level nav item for
        // them since CLINICAL_DOCS_ARCHIVE_V1). A role granted one of these
        // keys must still see the Settings module or the grant is unreachable
        // (Lab/Nurse/Doctor roles carry 'documents' with no settings key).
        // The Settings home index itself filters rows by isRouteAllowed, so
        // they see ONLY the rows they were granted.
        for (const k of ['documents', 'discounts-settings', 'api-settings', 'referral-settings', 'doctor-pay', 'lab-settings', 'consultation-types', 'communications', 'cashier-settings'])
            if (_effective.has(k)) return true;
        // LOCAL_ROLES_V1 — the production LAB_ROLE_SETTINGS_V1 implication (any
        // Laboratory-edit role also opens Settings, to manage lab panels) is
        // dropped locally: this app's Settings is the FULL clinic-config hub with
        // no separate lab-settings screen, so opening it must be an explicit
        // grant. Otherwise a Lab/Doctor role would reach all config. Admin keeps
        // full access via setFullAccess().
        return false;
    }
    if (navId === 'docs-archive') return _effective.has('docs-archive');   // ROLE_AUDIT_V2 — explicit grant only (mig 106 backfilled roles that used the old labs/consultation implication)
    if (navId === 'cashier-shifts') return _effective.has('cashier-shifts') || _effective.has('cashier');   // CASHIER_SHIFTS_MAP_V1
    // CASHIER_HEAD_KEY_V1 — Старший кассир is its OWN explicit grant (was derived
    // from Cashier: Admin, which made every delete-level cashier a head cashier).
    if (navId === 'cashier-head') return _effective.has('cashier-head');
    // ROLE_AUDIT_V1 (fix #2) — registration is its OWN grant (roles already
    // store it: Registrator/Doctor have it, Nurse/Lab/Cashier don't). Gating on
    // patients-edit alone let nurses see the registrar area. Both the grant AND
    // patients-edit are required (registering creates a patient row).
    if (navId === 'registration') return _effective.has('registration') && canEdit('patients');
    // PROCUREMENT_REQ_GRANT_V1 — the «Заявки на закупку» sub-grant also opens the
    // Procurement module (the view itself shows only the requisitions tab).
    if (navId === 'procurement') return _effective.has('procurement') || _effective.has('procurement:requisitions');
    return _effective.has(navId);
}

// Is a concrete route allowed? Handles sub-routes that don't have their own
// nav item (patient-card → patients, service-workspace → consultation,
// settings:<key> → that exact key, report:<key> → reports).
export function isRouteAllowed(view) {
    if (_effective == null) return true;
    if (!view) return true;
    if (ALWAYS_ALLOWED.has(view)) return true;

    if (view === 'patient-card')      return isModuleAllowed('patients');
    if (view === 'visits')            return isModuleAllowed('patients');   // LANDING_VISITS_V1 — журнал визитов идёт в комплекте с модулем «Пациенты»
    if (view === 'service-workspace') return isModuleAllowed('consultation');
    if (view === 'settings')          return isModuleAllowed('settings');
    // ROLE_AUDIT_V1 (fix #4) — each Settings sub-section must be granted
    // explicitly; bare «Settings (home)» no longer unlocks every sub-table
    // (staff accounts, price lists — a disclosure). Bare settings still opens
    // the Settings home index itself.
    if (view.startsWith('settings:')) return _effective.has(view);
    if (view.startsWith('report:'))   return isModuleAllowed('reports');
    if (view === 'consultation-types') return _effective.has('consultation-types') || _effective.has('settings:consultation_types') || _effective.has('settings');
    if (view === 'communications')     return _effective.has('communications') || _effective.has('settings');
    if (view === 'lab-settings')       return _effective.has('lab-settings') || _effective.has('settings:lab_settings') || _effective.has('settings') || canManageLabSettings();   // LAB_ROLE_SETTINGS_V1
    if (view === 'discounts-settings') return _effective.has('discounts-settings') || _effective.has('settings');   // PATIENT_DISCOUNTS_V2
    if (view === 'api-settings') return _effective.has('api-settings') || _effective.has('settings');   // CLINIC_API_V1
    // TELEGRAM_BOT_V1 — раздел админский целиком, включая чтение: токен бота
    // это полный доступ к переписке с пациентами, и даже его хвост регистратору
    // видеть незачем. Полный доступ (_effective === null) отсекается выше, так
    // что здесь остаются только настроенные роли — им отказ. Сервер отказывает
    // второй раз, независимо от этой строки.
    if (view === 'telegram-settings') return false;
    if (view === 'doctor-pay') return _effective.has('doctor-pay') || _effective.has('settings:doctor_pay') || _effective.has('settings');   // DOCTOR_PAY_BULK_V1
    if (view === 'referral-settings') return _effective.has('referral-settings') || _effective.has('settings');   // REFERRAL_REWARDS_V1
    if (view === 'cashier-settings') return _effective.has('cashier-settings') || _effective.has('settings:cashiers') || _effective.has('settings');   // CASHIER_SHIFT_MODE_V1
    // COMPANY_ROUTE_GRANT_V1 — «Компания» (Настройки → Основное) is the clinic
    // letterhead editor for doc_settings. It was the ONE settings sub-page with
    // no implication line here, so it fell through to `_effective.has(view)` —
    // and 'documents-settings' is not a grantable key in any role, so the check
    // could never pass. Every role except full-access hit Access-denied on the
    // one screen that sets the clinic name, contacts and printed logo.
    if (view === 'documents-settings') return _effective.has('documents-settings') || _effective.has('documents') || _effective.has('settings');

    if (view === 'docs-archive') return _effective.has('docs-archive');   // ROLE_AUDIT_V2 — explicit grant only
    if (view === 'cashier-shifts') return _effective.has('cashier-shifts') || _effective.has('cashier');   // CASHIER_SHIFTS_MAP_V1
    if (view === 'cashier-head') return isModuleAllowed('cashier-head');   // CASHIER_HEAD_NAV_V1
    if (view === 'registration') return _effective.has('registration') && canEdit('patients');   // ROLE_AUDIT_V1 (fix #2)
    if (view === 'procurement') return _effective.has('procurement') || _effective.has('procurement:requisitions');   // PROCUREMENT_REQ_GRANT_V1
    return _effective.has(view);
}

// ---------------------------------------------------------------------------
// Permission matrix — the tickable groups shown in the Roles editor.
// Built fresh on each call so newly-added Settings sections appear.
// ---------------------------------------------------------------------------
export function permissionGroups() {
    const groups = MODULE_GROUPS.map(g => ({ group: g.group, items: g.items.slice() }));

    // Settings sub-sections, grouped by each section's `group` (falling back
    // to "General"). Keyed as 'settings:<sectionKey>' so they nest under the
    // Settings module.
    const buckets = new Map();
    for (const [key, def] of Object.entries(SECTIONS)) {
        if (def.hidden || !def.table) continue;          // skip workflow/report/placeholder sections
        if (def.platformOnly) continue;                  // ROLE_EDITOR_AVAIL_V1 — super-admin console sections aren't grantable to clinic roles
        const groupName = 'Settings · ' + (def.group || 'General');
        if (!buckets.has(groupName)) buckets.set(groupName, []);
        buckets.get(groupName).push({ key: 'settings:' + key, label: def.label || key, soon: !!def.comingSoon });   // ROLE_EDITOR_AVAIL_V1
    }
    // EXTRA_SETTINGS_PERMS_V1 — non-table settings pages (special routes) made grantable per-role.
    for (const e of [
        { key: 'settings:consultation_types', label: 'Консультации врачей',      group: 'Service settings' },
        { key: 'settings:lab_settings',       label: 'Лаборатория и диагностика', group: 'Service settings' },
        { key: 'settings:doctor_pay',         label: 'Зарплата врачей (массово)',  group: 'Doctor salary' },
    ]) {
        const gn = 'Settings · ' + e.group;
        if (!buckets.has(gn)) buckets.set(gn, []);
        buckets.get(gn).push({ key: e.key, label: e.label });
    }
    for (const [groupName, items] of buckets) {
        items.sort((a, b) => a.label.localeCompare(b.label));
        groups.push({ group: groupName, items });
    }
    return groups;
}

// Flat list of every permission key (used by "Select all").
export function allPermissionKeys() {
    const out = [];
    for (const g of permissionGroups()) for (const it of g.items) out.push(it.key);
    return out;
}

// ---------------------------------------------------------------------------
// Row-level doctor scoping
// ---------------------------------------------------------------------------
// When the signed-in actor is a doctor (not an admin), data views narrow to
// that doctor: only their own services and only patients they have a service
// for (or are the primary doctor of). Reads the live actor from
// window.easymed so any view can call it without prop-drilling.
export function scopedDoctorId() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    // ADMIN_DOCTOR_V1 — admins (super admin OR clinic admin) see everything,
    // even when they are also a doctor; only pure doctors are patient-scoped.
    if (!u || u.is_super_admin || u.is_admin) return null;
    if (u.is_doctor && u.id) return u.id;
    return null;
}
export function isDoctorScoped() { return scopedDoctorId() != null; }

// ADMIN_DOCTOR_V2 — the current user's OWN doctor id when they ARE a doctor,
// even if also an admin. Unlike scopedDoctorId (null for admins so they see
// all data), this answers "which doctor am I" for self profile / dashboard.
export function selfDoctorId() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    return (u && u.is_doctor && u.id) ? u.id : null;
}

// SERVICE_SCOPE_V1 — «My services» / «Procedures» scope to the current user AS PROVIDER:
// any non-admin (doctor OR nurse) sees only rows assigned to them; full admins see all.
export function scopedProviderId() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u || u.is_super_admin || u.is_admin) return null;
    return u.id || null;
}
