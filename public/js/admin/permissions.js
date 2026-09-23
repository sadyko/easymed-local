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
        // CUSTDEV_V1 — не пункт меню, а кнопка внутри CRM. Ключ отдельный от
        // `crm` намеренно: заявки ведёт регистратура, а оценки о врачах и
        // кассирах читать ей незачем. Уровень «Просмотр» = доска и отчёт без
        // права оценивать — это уровень владельца.
        { key: 'custdev',           label: 'Cust Dev · Обзвон', desc: 'Опрос пришедших и оплативших: регистратура, касса, врач' },
        { key: 'consultation',      label: 'Мои услуги (кабинет врача)', desc: 'Очередь врача, заключения, назначения' },
        // QUEUE_BOARD_V1 — раздел только читает: кнопок, меняющих данные, в нём
        // нет, поэтому ролям хватает уровня «Просмотр».
        { key: 'queue',             label: 'Очередь',       desc: 'Доска номеров: кто у какого врача, в лаборатории и на процедурах' },
        { key: 'labs',              label: 'Лаборатория',   desc: 'Рабочий список и результаты' },
        { key: 'procedures',        label: 'Процедуры',     desc: 'Очередь процедур (медсестра)' },
        { key: 'beds',              label: 'Стационар и палаты', desc: 'Окно медсестры (заявки и размещение) и коечный фонд' },   // ADMISSION_ORDER_V1 — ключ открывает ОБА экрана: #admissions и #beds
        { key: 'patient-documents', label: 'Документы пациентов', desc: 'Печатные документы по пациентам' },
        // MY_STOCK_V1 — ОДИН КЛЮЧ НА ОБА ЛИЧНЫХ ЭКРАНА: «Мои запасы» (#my-stock)
        // и «Мой отдел» (#my-department). Тот же приём, что у `beds` строкой
        // выше, и по той же причине: это две стороны одной работы — что у меня
        // на руках и что у моего отдела, — и второй ключ был бы ловушкой в обе
        // стороны (клиника, выдавшая подотчёт, молча не увидела бы карточку
        // отдела, а роль могла бы получить право тратить, не получив права
        // видеть, чем она тратит).
        { key: 'my-stock',          label: 'Мои запасы и мой отдел', desc: 'Свой подотчёт (что выдали, кто выдал, что списано) и карточка своего отдела' },
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
const ALWAYS_ALLOWED = new Set(['specialties', 'updates', 'subscription', 'clinic-data']);
// specialties: global read-only reference; viewable by any role, add is super-admin-gated (SPECIALTIES_VIEW_V1)
// updates: UPDATE_DELIVERY_V1 — the approval screen is readable by any role;
// the RPCs behind it (update_status/update_approve/update_cancel) gate the
// admin-only ACTIONS themselves via hasAnyRole server-side, and the view
// itself only renders the approve/change/cancel buttons for an admin actor
// (admin-actor.js's isAdminActor()) — this only controls whether the route can
// be OPENED at all by a role-restricted account.
// subscription / clinic-data: SETTINGS_SPLIT_V1 — the other two thirds of what
// 'updates' used to be (views/subscription.js, views/clinic-data.js). They
// INHERIT that entry rather than being granted a new one: as cards on the
// updates page every role could already open them, and each card still decides
// for itself what a non-admin sees (the module list goes read-only, the backups
// card explains itself and never calls the admin-gated backup_list, the danger
// zone does not render at all). Leaving them out would have silently narrowed
// access as a side effect of moving a card between screens.

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
let _grants       = {};     // GRANTS_V1 — { 'inpatient.vitals': 'edit', … } по справочнику прав
let _roleLabel    = null;   // human label of the role currently in force
let _actorRoles   = [];     // INPATIENT_ROLE_GATE_V1 — role CODES currently in force

export const ACCESS_LEVELS = ['viewer', 'editor', 'admin'];

// ---------------------------------------------------------------------------
// INPATIENT_ROLE_GATE_V1 — WHICH ROLE the actor holds, not just which keys.
//
// The four inpatient screens (#mar-sheet, #mar-nurse, #kitchen-sheet,
// #discharge) all hang off ONE grant key, `beds`, and migration 092 handed
// `beds` to the registrar so she could see and cancel admission orders. The
// side effect: the registrar got four more menu items whose every RPC refuses
// her — the treatment sheet (READ_ROLES), the dose marks (MARK_ROLES), the
// kitchen sheet and the discharge queue all check ROLES server-side, not
// section keys. A menu item that always ends in «not allowed» is worse than no
// menu item: it reads as a broken program.
//
// The correct role lists already existed and were unit-tested — and were wired
// to nothing (views/discharge.js DISCHARGE_ROLES, views/kitchen-sheet.js
// KITCHEN_SHEET_ROLES). They live HERE now, next to the gate that reads them,
// and those two screens import them back, so there is still exactly one copy.
//
// The key gate stays: role AND grant. A clinic that took `beds` away from a
// role still hides all four.
export const ROLE_CODES = [
    'admin', 'registrar', 'doctor', 'nurse', 'cashier', 'lab', 'inventory',
    'callcenter', 'head_doctor', 'senior_nurse',
];
const _ROLE_CODE_SET = new Set(ROLE_CODES);

// Server mirrors, one per screen:
//   mar-sheet     — READ_ROLES (server/services/rpc/treatment-orders.js)
//   mar-nurse     — MARK_ROLES: this screen exists to MARK doses; the doctor
//                   and the head doctor read the sheet instead
//   kitchen-sheet — KITCHEN_SHEET_ROLES (views/kitchen-sheet.js)
//   discharge     — DISCHARGE_ROLES ('discharging→discharged' in TRANSITION_ROLES)
export const INPATIENT_SCREEN_ROLES = Object.freeze({
    'mar-sheet':     Object.freeze(['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']),
    'mar-nurse':     Object.freeze(['admin', 'nurse', 'senior_nurse']),
    'kitchen-sheet': Object.freeze(['nurse', 'senior_nurse', 'head_doctor', 'admin']),
    'discharge':     Object.freeze(['senior_nurse', 'head_doctor', 'admin']),
});

// MY_STOCK_V1 — КТО ДЕРЖИТ ТОВАР НА РУКАХ, ТОТ И ВИДИТ «МОИ ЗАПАСЫ».
//
// Ключ `my-stock` у экрана ЕСТЬ (NAV_MODULES выше, роздан миграцией 144), но
// одного ключа мало: экран показывает ТОЛЬКО собственные строки вошедшего
// (отбор считает сервер — rpc/holdings.js `mine`, rpc/stock-log.js `only`), и
// роли, которой товар на руки не выдают, он был бы всегда пуст. Поэтому список
// ниже спрашивается ВМЕСТЕ с ключом — тот же приём «право И роль», что у
// четырёх экранов стационара выше.
//
// Список — те, кому склад вообще выдаёт под отчёт (rpc/procurement.js
// issue_stock_lines): врач, медсестра, старшая, главный врач; администратор
// тоже, чтобы увидеть СВОЁ. Кассиру и регистратуре товар на руки не выдают —
// у них экран был бы всегда пустым. Заведующая отделом сюда попадает и по
// роли (руководителем отдела бывает только врач или медсестра — eligibleHead
// в rpc/departments.js), и по собственному отделу (ownDepartmentId ниже).
export const MY_STOCK_ROLES = Object.freeze(['admin', 'doctor', 'head_doctor', 'nurse', 'senior_nurse']);

// MY_STOCK_V1 — ЛИЧНЫЕ ЭКРАНЫ НИКОГДА НЕ БЫВАЮТ ДОМАШНИМИ.
//
// «Домашний экран» роли считают ДВА места, и оба перебирают меню сверху вниз:
// оболочка (admin.js firstAllowedView) — и как место, куда человек попадает,
// войдя, и как место, куда его возвращают с ЛЮБОГО закрытого маршрута; сводка
// прав (role-reach.js landingScreen) — чтобы сказать это владельцу словами.
//
// «Мои запасы» стоят в клиническом блоке, то есть раньше кассы, закупок и
// дашборда, и открыты всякому, у кого есть отдел. Без этого списка кассир с
// отделом входил бы в свой подотчёт вместо кассы, главный врач — вместо
// дашборда, кладовщик — вместо «Закупок», а экран «Роли» уверенно сообщал бы
// владельцу, что дом кассира — «Мои запасы».
//
// Порядком пунктов это не лечится: любой порядок оставляет роль, у которой
// первым доступным окажется личный экран. Личный экран — то, куда заходят
// посмотреть на себя, а не работа смены; домашним он не бывает ни у кого.
export const PERSONAL_VIEWS = Object.freeze(new Set(['my-stock', 'my-department']));

// Экраны, которые ключ роли открывает, а видит их только человек нужной роли.
// Сводка прав (role-reach.js) обязана называть такие экраны отдельно, иначе она
// обещает роли то, чего роль не получит.
export const ROLE_GATED_SCREENS = Object.freeze({ ...INPATIENT_SCREEN_ROLES, 'my-stock': MY_STOCK_ROLES });

/**
 * MY_STOCK_V1 — отдел вошедшего (users.department_id, приезжает с сессией —
 * server/services/auth.js sessionUser). null — отдела нет.
 *
 * Принадлежность к отделу — ФАКТ о человеке, а не право: по нему решается,
 * есть ли смысл показывать пункт «Мой отдел» (карточка ЧУЖОГО отдела ему всё
 * равно не откроется — rpc/departments.js isOwn) и ссылку на отдел с «Моих
 * запасов». Руководитель отдела всегда состоит и в его команде
 * (department_form добавляет его сам), поэтому одного этого поля хватает и для
 * заведующей.
 *
 * ПРЕДПРОСМОТР РОЛИ НЕ НАСЛЕДУЕТ О ЧИТАТЕЛЕ НИЧЕГО. previewRole() подменял
 * права и роль, а отдел молча оставался ОТ ТОГО, КТО СМОТРИТ: администратор,
 * состоящий в отделе, открывал «Настройки → Роли», выбирал «Кассир» — и сводка
 * сообщала, что кассирам открыты «Мои запасы» и «Мой отдел». Это неправда о
 * роли и правда о самом читателе — худший вид ошибки именно на экране прав.
 * Поэтому предпросмотр объявляет отдел САМ (_preview ниже), а по умолчанию —
 * «отдела нет». Тем же одним флагом закрыта вторая половина той же течи: пока
 * предпросмотр в силе, actorRoleCodes() не подмешивает роль вошедшего.
 */
let _preview = null;   // null — не предпросмотр; { departmentId: number|null } — предпросмотр

export function ownDepartmentId() {
    if (_preview) return _preview.departmentId;
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    const id = u ? Number(u.department_id) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * MY_STOCK_V1 — ЗАБЫТЬ СВОЙ ОТДЕЛ, КОГДА СЕРВЕР СКАЗАЛ, ЧТО ОН НЕ СВОЙ.
 *
 * users.department_id приезжает с сессией ОДИН раз, при входе (auth.js
 * actorFromUser), и пункт «Мой отдел» рисуется по нему. Медсестру перевели в
 * другое отделение — до перезагрузки страницы пункт остаётся на месте и ведёт
 * в отказ; орган управления, который ведёт в отказ, читается как поломка
 * программы.
 *
 * Чинится НЕ перечитыванием отдела на каждом переходе: better-sqlite3
 * синхронна, и лишний запрос на КАЖДУЮ навигацию стоит дороже самой беды.
 * Протухшее поле вредит ровно в ту минуту, когда им воспользовались, — а в эту
 * минуту программа и так спрашивает сервер (department_card) и получает отказ.
 * Отказ по СВОЕМУ отделу и означает «он больше не свой»: поле забывается, и
 * пункт исчезает с ближайшей отрисовки меню.
 *
 * Возвращает true, если поле действительно забыли, — ради вызывающего и теста.
 */
export function forgetOwnDepartment(departmentId) {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u || !Number.isInteger(Number(departmentId))) return false;
    if (Number(u.department_id) !== Number(departmentId)) return false;   // отказ по ЧУЖОМУ отделу ничего о своём не говорит
    u.department_id = null;
    return true;
}

function rememberRoles(names) {
    const out = [];
    for (const n of (names || [])) {
        const code = String(n == null ? '' : n).trim().toLowerCase();
        if (_ROLE_CODE_SET.has(code) && !out.includes(code)) out.push(code);
    }
    _actorRoles = out;
}

/** Explicit setter for callers that know the actor's roles (tests, future shell). */
export function setActorRoles(roles) { rememberRoles(roles); }

/**
 * The role codes in force: what the permission loader was given, PLUS whatever
 * the signed-in actor carries on the app shell. Both, because neither is
 * complete on its own — `role_permissions` rows are named by role code but a
 * role with no row is dropped, and window.easymed.state.user carries the
 * primary role but (today) no extra_roles.
 *
 * An EMPTY result means «unknown», and unknown never hides a menu item: this
 * gate narrows what a known-wrong role sees, it is not a second access system.
 * The server refuses on its own regardless.
 */
export function actorRoleCodes() {
    const out = [..._actorRoles];
    // MY_STOCK_V1 — в предпросмотре роли вошедшего нет: иначе сводка отвечала
    // бы про кассира ролью АДМИНИСТРАТОРА, который её читает (см. _preview).
    if (_preview) return out;
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (u) {
        const extra = Array.isArray(u.extra_roles) ? u.extra_roles : [];
        for (const r of [u.role, ...extra]) {
            const code = String(r == null ? '' : r).trim().toLowerCase();
            if (_ROLE_CODE_SET.has(code) && !out.includes(code)) out.push(code);
        }
    }
    return out;
}

/** Does the actor hold any of these roles? Unknown roles answer «yes». */
export function hasActorRole(allowed) {
    const need = allowed || [];
    if (!need.length) return true;
    const have = actorRoleCodes();
    if (!have.length) return true;
    return have.some((r) => need.includes(r));
}

export function currentRoleLabel() { return _roleLabel; }
export function hasRestriction()   { return _effective instanceof Set; }

// Grant full access (super admin / no role / "view as Super Admin").
export function setFullAccess(label = null) {
    _grants = {};   // GRANTS_V1 — полному доступу окна не закрывают
    _effective = null;
    _levels    = {};
    _patientTabs = {};
    _roleLabel = label;
    // Full access is granted to the super admin and to the clinic admin only
    // (admin.js applyActorPermissions); the role gate must agree.
    rememberRoles(['admin']);
}

// Apply a role row's permissions. An empty/missing sections list means the
// role is unconfigured → full access (don't lock the user out).
// GRANTS_V1 — права по справочнику (shared/permission-catalog.js): ключ → уровень.
// Читаются экранами с ВКЛАДКАМИ (пациенты, кабинет врача, лист медсестры),
// чтобы не показывать окно, которое роли закрыли. Действия проверяет сервер —
// это его ворота (server/services/grants.js), а здесь только «что видно».
const _GRANT_RANK = { none: 0, view: 1, edit: 2, delete: 3 };

function grantsOf(perms) {
    return (perms && perms.grants && typeof perms.grants === 'object') ? perms.grants : null;
}

/**
 * Уровень по ключу справочника — или null, если роль этот ключ не настраивала.
 * null значит «как раньше»: экраны обязаны тогда решать по старым ключам
 * (isRouteAllowed / canView), а не считать окно закрытым.
 */
export function grantLevel(key) {
    return Object.prototype.hasOwnProperty.call(_grants, key) ? _grants[key] : null;
}

/** Видно ли окно/действие: настроенный уровень выше «Нет», либо не настроено вовсе. */
export function grantAllows(key, need = 'view') {
    const lvl = grantLevel(key);
    if (lvl === null) return true;
    return (_GRANT_RANK[lvl] || 0) >= (_GRANT_RANK[need] || 0);
}

export function setEffectiveFromRole(roleRow) {
    const perms    = (roleRow && roleRow.permissions) || null;
    const sections = perms && Array.isArray(perms.sections) ? perms.sections : null;
    _grants = { ...(grantsOf(perms) || {}) };
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
    rememberRoles([roleRow && roleRow.name]);
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

    // GRANTS_V1 — по каждому ключу самая щедрая из ролей; ключ, который ни
    // одна роль не настраивала, остаётся ненастроенным («как раньше»).
    const grants = {};
    for (const r of rows) {
        const g = grantsOf(r && r.permissions) || {};
        for (const [k, v] of Object.entries(g)) {
            if (!(k in grants) || (_GRANT_RANK[v] || 0) > (_GRANT_RANK[grants[k]] || 0)) grants[k] = v;
        }
    }

    _effective   = sections.size ? sections : new Set(['__no_access__']);
    _levels      = levels;
    _patientTabs = tabs;
    _grants      = grants;
    _roleLabel   = (rows[0] && rows[0].name) || 'Roles';
    rememberRoles(rows.map((r) => r && r.name));
}

export function getEffectiveSet() { return _effective; }

/**
 * ROLE_REACH_V1 (2026-09-06) — ПОСМОТРЕТЬ НА ПРОГРАММУ ГЛАЗАМИ РОЛИ.
 *
 * Роли настраивают галочками, но галочка — это ключ, а вопрос у человека
 * другой: «что сотрудник в итоге увидит и куда попадёт, когда войдёт?».
 * Ответить можно двумя способами, и один из них неверный: описать права
 * СЛОВАМИ ОТДЕЛЬНО от того, как их проверяет сам интерфейс. Такое описание
 * разойдётся с действительностью в первой же правке ворот — и это худший вид
 * ошибки на экране прав, потому что читается он как обещание.
 *
 * Поэтому описание не пишется, а СПРАШИВАЕТСЯ у настоящих ворот: состояние
 * подменяется правами роли, вопросы задаются теми же isModuleAllowed() и
 * patientTabLevel(), которыми пользуется всё приложение, и состояние
 * возвращается на место. try/finally обязателен: исключение внутри fn иначе
 * оставило бы вошедшего сотрудника с правами ЧУЖОЙ роли до перезагрузки.
 *
 * Только СИНХРОННО: подмена глобальна, и await внутри fn означал бы, что чужие
 * права действуют, пока мы ждём.
 *
 * MY_STOCK_V1 — ОТДЕЛ ПОДМЕНЯЕТСЯ ВМЕСТЕ С ПРАВАМИ. `opts.departmentId`:
 * число — «сотрудник этой роли состоит в отделе», null (и по умолчанию) — «не
 * состоит». Наследовать отдел ЧИТАТЕЛЯ нельзя: см. ownDepartmentId() выше.
 *
 * @param opts.departmentId  номер отдела предпросматриваемого сотрудника (null — отдела нет)
 */
export function previewRole(roleRow, fn, opts = {}) {
    const saved = { eff: _effective, levels: _levels, tabs: _patientTabs, label: _roleLabel, roles: _actorRoles, preview: _preview };
    try {
        setEffectiveFromRole(roleRow);
        const id = Number(opts && opts.departmentId);
        _preview = { departmentId: Number.isInteger(id) && id > 0 ? id : null };
        return fn();
    } finally {
        _effective = saved.eff; _levels = saved.levels; _patientTabs = saved.tabs;
        _roleLabel = saved.label; _actorRoles = saved.roles; _preview = saved.preview;
    }
}

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

// LAB_PANELS_BY_SECTION_V1 (2026-08-31, owner: «who ever will have permission
// of the lab section will be able to edit the panels») — panel editing follows
// LAB-SECTION access itself. The ONE predicate is the same isModuleAllowed('labs')
// that decides whether Лаборатория is in the sidebar, so the nav and the
// «Панели» mode can never disagree. No settings-side grant is involved any
// more: the lab-settings screen is gone (the editor's only home is
// Лаборатория → «Панели») and its settings key is no longer offered in the
// Roles editor. Replaces LAB_ROLE_SETTINGS_V1's canManageLabSettings, which
// wanted a settings key or labs-at-EDIT — now opening the section is enough,
// viewer level included: a role trusted to see the lab's queue is trusted with
// its reference ranges, per the owner. Server mirror: schema-registry.js
// LAB_SECTION_ROLES (admin/doctor/lab/nurse — the seeded labs-section roles).
export function canEditLabPanels() {
    return isModuleAllowed('labs');
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

// PATIENT_CREATE_GATE_V1 (2026-09-05) — ОДИН ключ на заведение пациента, где бы
// его ни начали.
//
// До перекроя оболочки все три «Создать пациента» звали onNavigate('registration'),
// и право спрашивала оболочка: admin.js отказывал маршруту через
// isRouteAllowed('registration') и показывал панель отказа. PATIENT_ONE_WINDOW_V1
// убрал страницу — окно стало открываться на месте, — и вместе со страницей
// пропала ЕДИНСТВЕННАЯ проверка: `registration` выдан только регистратуре
// (миграция 055), но медсестра, врач или своя роль с ключом `patients` заводили
// карту беспрепятственно. Сервер подстраховать не может: canWrite() не получает
// подключения к базе и в role_permissions не заглядывает.
//
// Поэтому предикат живёт ЗДЕСЬ, рядом с маршрутным гейтом, а спрашивают его в
// одной точке — openPatientCreateModal() (views/patient-create-modal.js), через
// которую проходят все входы: пустой список, калькулятор услуг, кнопка шапки и
// сам маршрут #registration. Ключ ТОТ ЖЕ, что проверял маршрут, поэтому путь
// «room-calendar.js → onNavigate('registration') → оболочка → окно» отвечает
// одинаково в обеих точках, а не отказывает дважды разными словами.
//
// CALLCENTER_OPERATOR_V1 — У ЭТОГО ПРАВА ПОЯВИЛАСЬ СТРОКА В МАТРИЦЕ.
// «Завести пациента из заявки» (crm.convert) — работа оператора колл-центра:
// он для того и звонит. Сервер ему это позволял всегда (реестр таблиц
// разрешает callcenter вставку в patients), а оболочка молча отказывала, потому
// что ключ `registration` выдан только регистратуре (миграция 055) и выдать его
// оператору, не открыв ему заодно весь раздел, было нечем.
//
// ПРАВИЛО ОДНОСТОРОННЕЕ: НОВЫЙ КЛЮЧ ДОБАВЛЯЕТ ПРАВО И НИКОГДА ЕГО НЕ ОТНИМАЕТ.
// Правила перехода (grants.js: «ключ не настроен — решает прежний список»)
// здесь МАЛО, и вот почему. Экран «Роли» сохраняет матрицу ЦЕЛИКОМ: после
// первого же «Сохранить роль» у роли появляется явная запись по КАЖДОЙ строке
// справочника — у врача, кассира и регистратуры без CRM это `crm.convert:
// none`. Спрашивай мы только новый ключ, такое сохранение молча отняло бы
// заведение карты у тех, кто годами заводил её по ключу `registration`, и
// связать поломку с «я просто сохранил роль» не смог бы никто.
//
// Поэтому «Изменение» по crm.convert ДАЁТ право тому, у кого ключа регистрации
// нет (ради этого строка и появилась — оператор колл-центра), а «Нет» по нему
// не значит ничего: отвечает прежний ключ.
export function canCreatePatient() {
    const lvl = grantLevel('crm.convert');
    if (lvl !== null && grantAllows('crm.convert', 'edit')) return true;
    return isModuleAllowed('registration');
}

// PATIENT_TAB_PERMS_V1 — per-patient-card-tab gating. Default is VISIBLE: a role
// only restricts tabs it explicitly lists (so existing roles see everything).
//
// PATIENT_TAB_ACCESS_V1 (2026-09-05, владелец: «we need to add a patients card
// tabs to the view/edit/delete option») — этот список стал СПИСКОМ ВКЛАДОК
// КАРТЫ, а не приблизительным его подобием, и у каждой вкладки записано, что на
// ней вообще МОЖНО сделать.
//
//   • id совпадают с views/patient-card.js TABS. «Деталь» звалась здесь
//     `overview`, а карта зовёт её `details` — то есть ограничение «Детали»
//     карта не спрашивала НИКОГДА. Ключ переименован (миграция 103), старое имя
//     читается псевдонимом ниже: кабинет врача (views/service-workspace.js)
//     спрашивает `overview`, и ломать его ради красоты ключа незачем.
//   • `rx`, `loyalty`, `chat` убраны: этих вкладок в местной карте нет
//     («Production-only tabs … are not ported»), и ни одна строка кода их не
//     спрашивала. Галочка, которая ничего не делает, — это та же болезнь, что
//     чинила 055. Уже сохранённые значения не теряются: редактор ролей
//     переносит нерисованные ключи как есть (ROLE_SAVE_PRESERVE_V1).
//   • `recommended` остаётся — это живой гейт кнопки «Рекомендовать услугу» в
//     кабинете врача.
//
// caps — ЧТО НА ВКЛАДКЕ СУЩЕСТВУЕТ. Право, которого нет, выдавать нельзя:
// «Удаление» у «Счёта» обещало бы то, чего нет ни в карте, ни в реестре таблиц
// (invoices/invoice_items/payments — delete roles: []), и читалось бы как
// разрешение, которое почему-то не работает. Серверное зеркало —
// server/services/roles.js PATIENT_TAB_CAPS.
export const PATIENT_TABS = [
    { id: 'services',    label: 'Услуги',        caps: { edit: true,  del: true  }, note: 'Смена врача в строке, замена и удаление НЕОПЛАЧЕННОЙ услуги' },
    { id: 'labs',        label: 'Лаборатория',   caps: { edit: false, del: false }, note: 'Результаты вносит раздел «Лаборатория» — карта их только показывает' },
    { id: 'docs',        label: 'Документы',     caps: { edit: true,  del: true  }, note: 'Загрузка файла и удаление документа' },
    { id: 'history',     label: 'История',       caps: { edit: false, del: false }, note: 'Госпитализации и подшитые истории болезни — карта их только показывает и печатает' },   // PATIENT_HISTORY_TAB_V1
    { id: 'billing',     label: 'Счёт',          caps: { edit: false, del: false }, note: 'Счета и оплаты пишет только касса; удаления счёта нет нигде' },
    { id: 'visits',      label: 'Визиты',        caps: { edit: true,  del: false }, note: 'Запись визита; удаления визита в карте нет' },
    { id: 'details',     label: 'Деталь',        caps: { edit: true,  del: false }, note: 'Правка анкеты и отметок; удаление пациента — «Настройки → Пациенты»' },
    { id: 'recommended', label: 'Рекомендации',  caps: { edit: true,  del: false }, note: 'Кнопка «Рекомендовать услугу» в кабинете врача' },
];

// Список вкладок САМОЙ карты (без ключей кабинета врача) — в порядке карты.
export const PATIENT_CARD_TAB_IDS = ['services', 'labs', 'docs', 'history', 'billing', 'visits', 'details'];   // PATIENT_HISTORY_TAB_V1

const PATIENT_TAB_ALIASES = { overview: 'details' };
export function normalizePatientTab(tab) {
    const t = String(tab == null ? '' : tab).trim();
    return PATIENT_TAB_ALIASES[t] || t;
}
export function patientTabCaps(tab) {
    const t = PATIENT_TABS.find((x) => x.id === normalizePatientTab(tab));
    return (t && t.caps) || { edit: true, del: true };
}

const _PTAB_RANK  = { none: 0, view: 1, edit: 2, delete: 3 };
const _PTAB_LEVEL = ['none', 'view', 'edit', 'delete'];

/** Уровень доступа к вкладке: 'none' | 'view' | 'edit' | 'delete'. */
export function patientTabLevel(tab) {
    const key = normalizePatientTab(tab);
    const caps = patientTabCaps(key);
    const ceiling = caps.del ? 3 : (caps.edit ? 2 : 1);
    if (_effective == null) return _PTAB_LEVEL[ceiling];   // super admin / clinic admin / no-role
    let raw = _patientTabs[key];
    if (raw == null) {
        for (const [legacy, canon] of Object.entries(PATIENT_TAB_ALIASES)) {
            if (canon === key && _patientTabs[legacy] != null) { raw = _patientTabs[legacy]; break; }
        }
    }
    const rank = raw == null ? 3 : (_PTAB_RANK[raw] ?? 3);   // absent = fully permissive
    return _PTAB_LEVEL[Math.min(rank, ceiling)];
}

export function canViewPatientTab(tab) {
    return patientTabLevel(tab) !== 'none';                 // absent = visible
}
export function patientTabCanEdit(tab, need) {
    const l = patientTabLevel(tab);
    if (need === 'delete') return l === 'delete';
    return l === 'edit' || l === 'delete';
}
export function patientTabCanDelete(tab) {
    return patientTabCaps(tab).del && patientTabLevel(tab) === 'delete';
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
// MY_STOCK_V1 — ДВА ЛИЧНЫХ ЭКРАНА: ПРАВО КЛИНИКИ, А ПОВЕРХ НЕГО — ФАКТ О
// ЧЕЛОВЕКЕ.
//
// ПРАВО. Ключ один на оба экрана (MY_STOCK_KEY, NAV_MODULES выше), роздан
// миграцией 144 тем, кому склад выдаёт под отчёт, и администратору. Клиника,
// снявшая галочку в «Настройки → Роли», прячет ОБА пункта — иначе ключ был бы
// бутафорией, а экран прав обещал бы то, чего не делает.
//
// ФАКТ. Принадлежность к отделу правом не является и галочкой не выдаётся:
// «Мой отдел» ведёт на карточку ТВОЕГО отдела, и человеку, который ни в одном
// отделе не состоит, вести туда некуда — полный доступ этого не меняет
// (администратор без отдела увидел бы пункт, открывающий чужой справочник;
// свои отделы он открывает из «Настройки → Отделы», как и открывал).
//
// «Мои запасы» спрашивают ещё и РОЛЬ (MY_STOCK_ROLES): кассиру и регистратуре
// товар на руки не выдают, и экран был бы у них всегда пустым. Заведующая
// отделом проходит и тогда, когда её роль в список не попала, — у неё есть
// отдел. Это ИЛИ, а не И: ключ · (роль или отдел).
function personalStockAllowed(navId) {
    if (navId === 'my-department' && (ownDepartmentId() == null || !isRouteAllowed('departments'))) return false;
    if (_effective == null) return true;
    if (!_effective.has('my-stock')) return false;
    if (navId === 'my-department') return true;
    return hasActorRole(MY_STOCK_ROLES) || ownDepartmentId() != null;
}

// Is a top-level sidebar module visible? The Settings module is special: it
// shows when the role can reach the Settings home OR any single sub-section.
export function isModuleAllowed(navId) {
    // MY_STOCK_V1 — оба личных экрана решаются одним местом, см. ниже.
    if (navId === 'my-stock' || navId === 'my-department') return personalStockAllowed(navId);
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
        for (const k of ['documents', 'discounts-settings', 'api-settings', 'doctor-pay', 'consultation-types', 'communications', 'cashier-settings'])
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
    // ADMISSION_ORDER_V1 — «Стационар» (окно медсестры) и «Койки и палаты»
    // (коечный фонд) — ДВА экрана ОДНОГО раздела, и ключ у них один: `beds`.
    // Отдельный грант здесь был бы ловушкой в обе стороны: у клиник, где
    // стационар уже выдан, новый экран молча не появился бы, а выдать право
    // класть на койку, не выдав права видеть, свободна ли она, — это как раз
    // тот класс ошибки, который чинила 055. Приём тот же, что у
    // 'cashier-shifts' → 'cashier' строкой выше.
    if (navId === 'admissions') return _effective.has('admissions') || _effective.has('beds');
    // CASE_WORKSPACE_V1 — история болезни это ЭКРАН раздела «Стационар», а не
    // отдельный раздел: ключ у них один, по тому же доводу, что у листа
    // назначений ниже. Лечащий врач ведёт её из кабинета, поэтому
    // `consultation` открывает её тоже — иначе единственный, кто вправе писать
    // документы, не дошёл бы до экрана, на котором их пишут.
    // CASE_OVERVIEW_ROUTE_V1 — обзор (#case-overview) и документы (#case-file)
    // это две вкладки ОДНОЙ истории болезни (общий caseHead), ключ у них один.
    if (navId === 'case-file' || navId === 'case-overview') return _effective.has('admissions') || _effective.has('beds') || _effective.has('consultation');
    // MAR_SHEET_V1 / MAR_NURSE_V1 / KITCHEN_SHEET_V1 — ещё три экрана ОДНОГО
    // раздела «Стационар и палаты», и ключ у них тот же `beds`, по тому же
    // доводу, что строкой выше: клиника, которой стационар уже выдан, обязана
    // увидеть новые экраны БЕЗ похода в настройки ролей, а завести новый
    // грантовый ключ здесь значило бы спрятать лист назначений и порционник от
    // всех, включая медсестру, ради которой они и написаны (миграция 092
    // раздала `beds` медсестре, старшей, главному врачу и регистратуре).
    //
    // ЛИСТ НАЗНАЧЕНИЙ — ИСКЛЮЧЕНИЕ В ОДНУ СТОРОНУ: его ведёт ЛЕЧАЩИЙ ВРАЧ, а
    // `beds` ему не выдают (у роли `doctor` его нет ни в 055, ни в 092).
    // Поэтому лист открывает и владелец кабинета врача (`consultation`) —
    // иначе единственный человек, который вправе назначать, не смог бы дойти
    // до экрана, на котором это делается.
    //
    // Меню — это МЕНЮ, а не доступ к данным (admin.js говорит это дословно):
    // сервер отвечает второй раз и строже — читает лист только тот, кто ведёт
    // пациента (READ_ROLES в rpc/treatment-orders.js), отмечает дозу только
    // медсестра, старшая или админ. Регистратура, которой `beds` выдан ради
    // заявок, увидит пункт меню и получит отказ сервера — это осознанный
    // размен в пользу того, чтобы функция вообще существовала для тех, кому
    // она нужна.
    //
    // TWO_STEP_DISCHARGE_V1 — «Выписки к оформлению» (#discharge) — четвёртый
    // экран того же раздела и тот же ключ `beds`, ровно по доводу выше:
    // клиника, у которой стационар уже есть, обязана увидеть второй шаг
    // выписки без похода в настройки ролей, а собственный грантовый ключ
    // спрятал бы очередь оформления от старшей медсестры, ради которой она и
    // написана. Сервер отвечает второй раз и строже: ОФОРМИТЬ выписку вправе
    // только старшая медсестра, главный врач и администратор
    // ('discharging→discharged' в TRANSITION_ROLES), и экран рисует кнопку по
    // ответу `inpatient_capabilities`, а не по этому ключу.
    //
    // INPATIENT_ROLE_GATE_V1 — И РОЛЬ ТОЖЕ. Довод выше («меню — это меню, а не
    // доступ к данным») оказался разменом не в ту сторону: регистратура,
    // которой `beds` выдан ради заявок, видела ЧЕТЫРЕ пункта, за каждым из
    // которых её ждёт отказ сервера — лист назначений (READ_ROLES), отметка
    // дозы (MARK_ROLES), порционник и очередь выписок. Пункт меню, который
    // всегда кончается словами «не разрешено», читается как сломанная
    // программа, а не как аккуратно суженное право. Роль теперь спрашивается
    // вместе с ключом (INPATIENT_SCREEN_ROLES выше — те же списки, которыми
    // отвечает сервер).
    if (navId === 'mar-nurse' || navId === 'kitchen-sheet' || navId === 'discharge') {
        return _effective.has('beds') && hasActorRole(INPATIENT_SCREEN_ROLES[navId]);
    }
    if (navId === 'mar-sheet') {
        return (_effective.has('beds') || _effective.has('consultation'))
            && hasActorRole(INPATIENT_SCREEN_ROLES['mar-sheet']);
    }
    // PATIENTS_HUB_V1 — «Календарь записи» это ЛИЦО раздела «Пациенты», а не
    // отдельный раздел: с 2026-09-05 он третья вкладка внутри «Пациентов»
    // (views/patients-hub.js), и попасть в него можно ещё и собственным
    // маршрутом #appointments.
    //
    // Ключа `appointments` нет ни в одной настроенной роли и никогда не было —
    // его нет в NAV_MODULES, значит редактор ролей его не предлагает, значит
    // проверка `_effective.has('appointments')` не могла пройти НИ У КОГО:
    // календарь был невидим для каждой роли, кроме полного доступа. Завести
    // ему собственный грант — значит оставить его невидимым и дальше, пока
    // администратор клиники не сходит в настройки ролей и не проставит галочку
    // каждой роли поимённо; а регистратура, ради которой календарь и написан,
    // должна видеть его сразу.
    //
    // Поэтому — не новый ключ, а следствие: у кого есть картотека, у того есть
    // и календарь записи. Тот же приём и тот же довод, что у 'admissions' →
    // 'beds' и 'cashier-shifts' → 'cashier' выше. Сервер отвечает второй раз и
    // строже: запись пишется в visits с обычной проверкой прав.
    if (navId === 'appointments') return _effective.has('appointments') || _effective.has('patients');
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
    if (view === 'service-workspace') return isModuleAllowed('consultation');
    // ROUTE_GATE_COVERS_PARENT_OF_V1 — прежний кабинет врача (#doctor-room,
    // DOCTOR_ROOM_V1): из меню недостижим, но адрес живёт в закладках. Ключ тот
    // же, что у кабинета (`consultation`), как у service-workspace строкой выше,
    // а не мёртвый `doctor-room`, который редактор ролей перестал предлагать
    // ещё в ROLE_KEYS_V2 — на него маршрут и падал.
    if (view === 'doctor-room')       return isModuleAllowed('consultation');
    if (view === 'settings')          return isModuleAllowed('settings');
    // ROLE_AUDIT_V1 (fix #4) — each Settings sub-section must be granted
    // explicitly; bare «Settings (home)» no longer unlocks every sub-table
    // (staff accounts, price lists — a disclosure). Bare settings still opens
    // the Settings home index itself.
    if (view.startsWith('settings:')) return _effective.has(view);
    // ROUTE_GATE_COVERS_PARENT_OF_V1 — пункт меню отчётов называется
    // `reports-hub` (REPORTS_HUB_V1), ключа `reports` нет ни в одной роли: и
    // прежний «Обзор владельца» (#reports), и отчёты-справочники (report:<key>)
    // спрашивали несуществующий ключ и отказывали каждой настроенной роли.
    if (view === 'reports' || view.startsWith('report:')) return isModuleAllowed('reports-hub');
    if (view === 'consultation-types') return _effective.has('consultation-types') || _effective.has('settings:consultation_types') || _effective.has('settings');
    if (view === 'communications')     return _effective.has('communications') || _effective.has('settings');
    if (view === 'discounts-settings') return _effective.has('discounts-settings') || _effective.has('settings');   // PATIENT_DISCOUNTS_V2
    if (view === 'api-settings') return _effective.has('api-settings') || _effective.has('settings');   // CLINIC_API_V1
    // TELEGRAM_BOT_V1 — раздел админский целиком, включая чтение: токен бота
    // это полный доступ к переписке с пациентами, и даже его хвост регистратору
    // видеть незачем. Полный доступ (_effective === null) отсекается выше, так
    // что здесь остаются только настроенные роли — им отказ. Сервер отказывает
    // второй раз, независимо от этой строки.
    if (view === 'telegram-settings') return false;
    // TELEPHONY_V1 — то же правило, что у Telegram-бота строкой выше: ключ и
    // secret Binotel открывают журнал звонков всей клиники, настроенным ролям
    // тут делать нечего. Полный доступ (_effective === null) уже пропущен выше;
    // сервер (admin-only RPC) отказывает второй раз, независимо от этой строки.
    if (view === 'telephony-settings') return false;
    // DEPARTMENTS_V1 — экран «Отделы». Настроенный уровень окна главнее; без
    // настройки маршрут открыт всем: сервер (department_list) отдаёт
    // сотруднику без прав только его собственный отдел, а администратору и
    // снабжению — все. Закрыть окно роли можно в «Настройки → Роли».
    if (view === 'departments') { const lvl = grantLevel('settings.departments'); return lvl === null ? true : lvl !== 'none'; }
    // CRM_CONFIG_V1 — то же правило, что у Телефонии строкой выше. Этот экран
    // задаёт САМУ воронку: колонки доски, колонку конверсии (единственный путь
    // регистрации пациента) и то, из каких звонков система делает заявки.
    // Ошибка здесь ломает CRM всей клиники, поэтому раздел админский целиком,
    // включая чтение. Полный доступ (_effective === null) уже пропущен выше;
    // сервер (admin-only crm_config_save) отказывает второй раз, независимо от
    // этой строки.
    if (view === 'crm-settings') return false;
    if (view === 'doctor-pay') return _effective.has('doctor-pay') || _effective.has('settings:doctor_pay') || _effective.has('settings');   // DOCTOR_PAY_BULK_V1
    if (view === 'cashier-settings') return _effective.has('cashier-settings') || _effective.has('settings:cashiers') || _effective.has('settings');   // CASHIER_SHIFT_MODE_V1
    // ROOMS_SETUP_V1 — «Помещения» пишет в те же таблицы, что разделы Rooms /
    // Wards / Beds, поэтому и права те же: у кого есть любой из них (или
    // Settings целиком), у того есть и объединённый экран. Отдельного нового
    // грантa не заводим — иначе у существующих ролей раздел просто исчез бы.
    if (view === 'rooms-setup') return _effective.has('rooms-setup')
        || _effective.has('settings:rooms') || _effective.has('settings:wards')
        || _effective.has('settings:beds_settings') || _effective.has('settings:floors')
        || _effective.has('settings');
    // COMPANY_ROUTE_GRANT_V1 — «Компания» (Настройки → Основное) is the clinic
    // letterhead editor for doc_settings. It was the ONE settings sub-page with
    // no implication line here, so it fell through to `_effective.has(view)` —
    // and 'documents-settings' is not a grantable key in any role, so the check
    // could never pass. Every role except full-access hit Access-denied on the
    // one screen that sets the clinic name, contacts and printed logo.
    if (view === 'documents-settings') return _effective.has('documents-settings') || _effective.has('documents') || _effective.has('settings');
    // ROUTE_GATE_COVERS_PARENT_OF_V1 — дизайнер печатных форм (#documents,
    // плитка «Документы» хаба) пишет ТУ ЖЕ запись doc_settings, что «Компания»
    // строкой выше, и ключ у него тот же: своего грантового ключа `documents`
    // в локальном редакторе ролей нет, и маршрут падал на него так же, как
    // documents-settings до COMPANY_ROUTE_GRANT_V1. Сервер отвечает второй раз:
    // update doc_settings — только admin (schema-registry.js).
    if (view === 'documents') return _effective.has('documents') || _effective.has('settings');
    // ROUTE_GATE_COVERS_PARENT_OF_V1 — «Список услуг» (#services, плитка хаба)
    // это лицо того же раздела, что 'settings:services' (та же таблица
    // services), и открывается тем же грантом; собственного ключа `services`
    // ни у одной роли нет. Голый `settings` его НЕ открывает нарочно: прайс —
    // тот самый «disclosure» из ROLE_AUDIT_V1 (fix #4) выше. Сервер отвечает
    // второй раз: чтение ALL_STAFF, запись — admin (schema-registry.js).
    if (view === 'services') return _effective.has('services') || _effective.has('settings:services');

    if (view === 'docs-archive') return _effective.has('docs-archive');   // ROLE_AUDIT_V2 — explicit grant only
    if (view === 'cashier-shifts') return _effective.has('cashier-shifts') || _effective.has('cashier');   // CASHIER_SHIFTS_MAP_V1
    if (view === 'admissions') return isModuleAllowed('admissions');   // ADMISSION_ORDER_V1 — один ключ на оба экрана стационара
    // MAR_SHEET_V1 — маршрут листа назначений открывается и с номером
    // госпитализации ('#mar-sheet/13', payload.sub), и без него: без номера
    // экран показывает лежащих и просит выбрать. Право одно на оба случая.
    if (view === 'mar-sheet' || view === 'mar-nurse' || view === 'kitchen-sheet' || view === 'discharge') return isModuleAllowed(view);   // TWO_STEP_DISCHARGE_V1 добавил #discharge
    if (view === 'case-file') return isModuleAllowed('case-file');   // CASE_WORKSPACE_V1
    // CASE_OVERVIEW_ROUTE_V1 — обзор и документы это две вкладки ОДНОЙ истории
    // болезни (общий caseHead), ключ у них один; без этой строки маршрут падал
    // на `_effective.has('case-overview')` — ключ, которого нет ни в одной роли,
    // — и «экран врача» отказывал врачу. Сервер отвечает второй раз через грант
    // inpatient.patients (rpc/case-overview.js, OVERVIEW_ROLES).
    if (view === 'case-overview') return isModuleAllowed('case-file');
    if (view === 'appointments') return isModuleAllowed('appointments');   // PATIENTS_HUB_V1 — «Календарь записи» едет с ключом `patients`
    // ROUTE_GATE_COVERS_PARENT_OF_V1 — «Заявки» (#requests, REQUESTS_INBOX) —
    // входящие регистратуры, подэкран CRM (PARENT_OF в admin.js); ключ тот же
    // `crm`, а не несуществующий `requests`.
    if (view === 'requests') return isModuleAllowed('crm');
    if (view === 'cashier-head') return isModuleAllowed('cashier-head');   // CASHIER_HEAD_NAV_V1
    if (view === 'registration') return _effective.has('registration') && canEdit('patients');   // ROLE_AUDIT_V1 (fix #2)
    // PROCUREMENT_REQ_GRANT_V1 — свои ключи закупок как были.
    // ROUTE_GATE_COVERS_PARENT_OF_V1 — маршрутизатор уводит #procurement в
    // #inventory (WAREHOUSE_NAMES_V1), но право спрашивается ДО switch, и
    // настроенная роль со складом упиралась в «Нет доступа» вместо
    // перенаправления. Ключ склада открывает и старый адрес.
    if (view === 'procurement') return _effective.has('procurement') || _effective.has('procurement:requisitions') || isModuleAllowed('inventory');
    // STOCK_LOG_V1 — ЖУРНАЛ ДВИЖЕНИЙ ОТКРЫТ ВСЕМ, КОГО ОН КАСАЕТСЯ, А ЧТО В НЁМ
    // ВИДНО — РЕШАЕТ СЕРВЕР. Решение владельца (23.09): «каждый видит своё,
    // заведующая — свой отдел, администратор и кладовщик — всю клинику». Ни
    // «своё», ни «свой отдел» не выражаются ключом права: заведующая узнаётся
    // по departments.head_user_id, а «своё» — по самим строкам движений. Отбор
    // считает rpc/stock-log.js (journalScope) и присылает только разрешённое;
    // медсестра со своим единственным движением увидит его, кассир — пустой
    // список. То же устройство, что у карточки отдела (`departments` выше):
    // маршрут открыт, доступ к данным закрыт сервером. Права склада этим НЕ
    // расширяются — ключ `inventory` по-прежнему открывает только #inventory.
    if (view === 'stock-log') return true;
    // MY_STOCK_V1 — «МОИ ЗАПАСЫ» ОТКРЫТ, ПОТОМУ ЧТО ПОКАЗЫВАЕТ ТОЛЬКО ТЕБЯ.
    // Тот же довод, что у журнала строкой выше, и на ступень сильнее: журналу
    // область видимости считают («своё / свой отдел / вся клиника»), а здесь
    // считать нечего — все три списка экрана по построению чужих строк не
    // содержат: holdings_list спрашивается с `mine`, движения — с `only`, и
    // имя человека оба раза берёт сервер из сессии, а не из аргумента. Роль
    // решает, показывать ли ПУНКТ МЕНЮ (isModuleAllowed выше); адрес,
    // набранный руками, откроет пустой экран, а не чужой.
    if (view === 'my-stock') return true;
    // MY_STOCK_V1 — «Мой отдел» это карточка отдела под своим адресом: право
    // то же, что у «Отделов» (сервер отдаёт сотруднику только его отдел —
    // rpc/departments.js isOwn), а меню сверх того требует, чтобы отдел был.
    if (view === 'my-department') return isRouteAllowed('departments');
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
        // LAB_PANELS_BY_SECTION_V1 — «Лаборатория и диагностика» is no longer a
        // grantable settings key: panel editing rides on the Laboratory module
        // itself (canEditLabPanels), so there is nothing here to tick.
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

// CRM_OWNERSHIP_V1 — «кто я» для заявок CRM: чья это карточка и могу ли я её
// взять. Свой ответ, а не scopedProviderId: тот отвечает null администратору
// (ему видно всё), а здесь номер нужен и администратору — чтобы «Взять в
// работу» записало заявку на него, а не обнулило владельца.
export function selfUserId() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    return (u && u.id) || null;
}

// SERVICE_SCOPE_V1 — «My services» / «Procedures» scope to the current user AS PROVIDER:
// any non-admin (doctor OR nurse) sees only rows assigned to them; full admins see all.
export function scopedProviderId() {
    const u = (typeof window !== 'undefined' && window.easymed && window.easymed.state && window.easymed.state.user) || null;
    if (!u || u.is_super_admin || u.is_admin) return null;
    return u.id || null;
}
