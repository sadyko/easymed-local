// Employees (Сотрудники) — EMPLOYEE_EDITOR_V3. Staff roster + a multi-section
// editor modelled on easymed's «Новый сотрудник». «Категория сотрудника»
// (staff_type) drives is_doctor + the doctor-only sections. «Вход и доступ» has
// a primary role + «Дополнительные роли» (multi-role, unioned at login). The
// doctor sections «Услуги и ставки» and «Вознаграждение за направления» use the
// per-service rate table (mirrors easymed: tick a service, set its % — with
// search, type filter, «Выбрать все» and «% для всех»). Talks to the admin-only
// REST routes at /api/users (password hashing + is_doctor + validation server-side).

import { supabase } from '../../supabase.js';
import { h, Icon, clear, toast, field, checkField, Ring, initials } from '../ui.js';
import { tr, trf } from '../i18n.js';   // I18N_COVERAGE_V1 — перевод СНАЧАЛА, подстановка ПОТОМ
import { openEmployeePasswordModal, openChangeOwnPasswordModal } from '../password-change.js';   // PASSWORD_CHANGE_V2
import { selfUserId, settingsTileLevel, settingsMoneyAllowed, actorIsAdmin, hasRestriction, actorRoleCodes } from '../permissions.js';   // PASSWORD_CHANGE_V2 — своя карточка меняет пароль через текущий · ADMIN_ROWS_GRANTABLE_V1
import { phoneInput } from '../phone-input.js?v=ph1';
import { importExportButtons } from './section-import-export.js?v=aug17e';   // DATA_TRANSFER_V1
import { soleBranchId } from '../branch-context.js?v=bc3';                  // SOLE_BRANCH_V1
import { specialtyOptions, canonicalSpecialty, SPECIALTY_ROWS } from '../specialties.js?v=spec2';   // SPECIALTY_LIST_V1 + SPECIALTIES_CLONED_V1 + MULTI_SPECIALTY_V1
import { referralRewardEditor, saveReferralReward } from './referral-reward-editor.js';   // REPORTS_V2 — рабочая ставка за направления (источник врача)
import { employeeNameParts, employeeSaveGaps, NAME_KEYS } from '../../shared/employee-name.js?v=ecs2';   // EMPLOYEE_CARD_SAVE_V1 — имя из full_name и что держит сохранение; ecs2 — ревью: нетронутое ФИО побайтно, стёртый телефон
import { weekHoursGrid } from './week-hours.js';   // BRANCH_PROFILE_V1 — сетка дней одна на программу
import { doctorPublicPane, publicPaneProblems } from './doctor-public-pane.js';   // DOCTOR_PROFILE_V1 — «Публичный профиль» по макету
import { doctorPublicState, shownPracticeSince } from '../../shared/doctor-public.js';   // DOCTOR_PROFILE_V1
import { isRouteAllowed } from '../permissions.js';   // DOCTOR_PROFILE_V1 — «Изменить в «Консультации врачей»» только тому, кому она открыта

const SPEC_TAKEN = 'Эта специальность уже выбрана.';   // DOCTOR_PROFILE_V1 — макет «Публичный профиль»

const ROLES = [
    ['registrar', 'Регистратор'], ['doctor', 'Врач'], ['nurse', 'Медсестра'],
    ['cashier', 'Кассир'], ['lab', 'Лаборант'], ['inventory', 'Склад'],
    ['callcenter', 'Оператор колл-центра'],   // CALLCENTER_ROLE_V1 + CALLCENTER_OPERATOR_V1
    ['admin', 'Администратор'],
];
// INPATIENT_FLOW_V1 — НАДСТРОЕЧНЫЕ роли: только «Дополнительные роли», в
// «Основной роли» их нет намеренно (зеркало EXTRA_ONLY_ROLES в
// server/services/roles.js — сервер отвечает «Unknown role.» на попытку
// поставить их основной). Главный врач остаётся врачом, старшая медсестра —
// медсестрой; надстройка добавляет полномочия в стационаре, а не заменяет
// профессию.
const EXTRA_ONLY_ROLES = [
    ['head_doctor', 'Главный врач'],
    ['senior_nurse', 'Старшая медсестра'],
    // CASHIER_HEAD_V1 — старший кассир остаётся кассиром: основная роль
    // «Кассир», надстройка даёт экран всех смен и «Исправляет услуги в счёте».
    ['head_cashier', 'Старший кассир'],
];
const ALL_ASSIGNABLE_ROLES = [...ROLES, ...EXTRA_ONLY_ROLES];
// CUSTOM_ROLES_V1 (2026-09-16) — роли, заведённые самой клиникой («Настройки →
// Роли»). У каждой есть ОСНОВА из списка выше: её и получает users.role, а код
// своей роли едет рядом и решает, какие разделы человек увидит. Список
// подгружается вместе с сотрудниками; пусто — значит клиника своих ролей не
// заводила, и экран выглядит как раньше.
let CUSTOM_ROLES = [];
const customRoleOf = (code) => CUSTOM_ROLES.find((c) => c.code === code) || null;
const roleTitle = (u) => {
    const c = u && u.custom_role_code ? customRoleOf(u.custom_role_code) : null;
    if (c) return c.name;
    const r = ALL_ASSIGNABLE_ROLES.find((x) => x[0] === (u && u.role));
    return r ? r[1] : ((u && u.role) || '—');
};
const STAFF_TYPES = [['doctor', 'Врачи'], ['admin_staff', 'Административный персонал'], ['mid_low', 'Средний и младший персонал']];
const DOCTOR_CATEGORIES = [['', '—'], ['highest', 'Высшая'], ['first', 'Первая'], ['second', 'Вторая'], ['none', 'Без категории']];
const EMPLOYMENT_TYPES = [['', '—'], ['official', 'Официально'], ['civil_law', 'ГПХ (договор)'], ['unofficial', 'Неофициально']];
const SALARY_TYPES = [['', '—'], ['fixed', 'Оклад'], ['percentage', 'Процент от выручки'], ['fix_plus_kpi', 'Оклад + KPI']];
const roleLabel = (r) => (ALL_ASSIGNABLE_ROLES.find(x => x[0] === r) || [r, r])[1];
// STAFF_SYNC_V1 (миграция 086) — сотрудника завела главная клиника, и этот
// экран его только показывает. Сравнение именно с false: установка старой
// версии ключа не присылает вовсе, и «неизвестно» обязано значить «свой», иначе
// клиника из одного здания после обновления нашла бы весь свой ростер
// нередактируемым.
const fromMain = (u) => !!u && u.is_local === false;
const staffLabel = (s) => (STAFF_TYPES.find(x => x[0] === s) || ['', 'Не выбрана'])[1];
// DOCTOR_PROFILE_V1 — колонки макета в списке: специальности строки (из списка, у
// записанного до него — одна колонка) и показ на сайте и у партнёров — теми же
// словами, что список «Филиалов» (шаг 4).
const specNamesOf = (u) => (Array.isArray(u.specialties) && u.specialties.length
    ? u.specialties.map((s) => (s && typeof s === 'object' ? s.name : s)) : (u.specialty ? [u.specialty] : [])).filter(Boolean);
function publicTag(u, branchesById) {
    const state = doctorPublicState(u, branchesById);
    if (state === 'shown') return h('span', { class: 'emp-pub on' }, Icon('Globe', { size: 12 }), ' ', 'На сайте');
    return h('span', { class: 'emp-pub' }, 'Скрыт с сайта', state === 'branch_hidden' ? h('span', { class: 'dpp-sub' }, 'филиал скрыт') : null);
}
// Routing type (раздел) — the fixed easymed set (mirrors services.js).
const SERVICE_TYPES = [['imaging', 'Диагностика'], ['consultation', 'Консультации'], ['lab', 'Лаборатория'], ['procedure', 'Процедуры'], ['other', 'Хирургия']];   // SERVICE_TYPES_FIVE_V1 — the five the editor offers; a legacy 'radiology' row reads as «Диагностика»
const svcTypeVal = (s) => s.type || (s.is_lab ? 'lab' : 'consultation');
const svcTypeLabel = (v) => (SERVICE_TYPES.find(t => t[0] === (v === 'radiology' ? 'imaging' : v)) || [v, v])[1];
function fmtPrice(n) { const v = Math.round(Number(n) || 0); return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

// ADMIN_ROWS_GRANTABLE_V1 (2026-09-26) — «СОТРУДНИКИ» ИЗ «РОЛЕЙ».
//
// Экран открывается не только администратору: «Просмотр» — список и карточки
// без правки, «Изменение» — завести и править, «Удаление» — кнопка «Удалить».
// Деньги карточки (зарплата, ставки, вознаграждение за направления) — только с
// «Цены и проценты»: без них вкладок нет, и в сохранение они не уходят (сервер
// отказал бы всей записи, routes/users.js). Роль администратора
// не-администратору не предлагается вовсе. Сервер проверяет всё это второй раз.
const MONEY_KEYS = ['salary_type', 'salary_fixed', 'salary_percent', 'service_rates', 'referral_rates',
    'inpatient_rates', 'inpatient_referral_pct', 'inpatient_referral_fixed'];   // INPATIENT_BONUS_V1
const MONEY_SECTIONS = ['salary', 'services', 'inpatient', 'referral'];
function empAccess() {
    const admin = !hasRestriction() || actorIsAdmin();
    const lvl = settingsTileLevel('settings.employees');
    return {
        admin,
        canEdit: lvl === 'edit' || lvl === 'delete',
        canDelete: lvl === 'delete',
        money: admin || settingsMoneyAllowed('settings.employees'),
    };
}

async function api(path, opts = {}) {
    const res = await fetch('/api/users' + path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.error && json.error.message) || ('Request failed (' + res.status + ')'));
    return json;
}

// EMP_ARCHIVE_V1 — режим списка живёт на уровне модуля, а не внутри paint():
// «Вернуть» перерисовывает страницу, и локальный флаг выбрасывал бы из архива
// после каждого возвращённого сотрудника.
let showArchive = false;
let departments = [];
let branches = [];
let services = [];
let serviceTypes = [];       // RATES_FILTERS_V2 — the clinic's own types (service_types)
let serviceCategories = [];  // and categories (service_categories)

export async function renderEmployees(container) {
    clear(container);
    showArchive = false;   // вход в раздел — всегда со списка работающих
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root);
}

async function paint(root) {
    clear(root);
    const acc = empAccess();   // ADMIN_ROWS_GRANTABLE_V1
    // EMP_ARCHIVE_V1 — переключатель «Архив». Живёт в шапке рядом с «Новый
    // сотрудник»: это не фильтр таблицы, а другой список.
    const archiveBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Архив');
    root.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, 'Сотрудники'),
            h('p', { class: 'page-subtitle' }, 'Штат клиники — сотрудники, врачи, медсёстры, регистратура, администрация.'),
        ),
        // DATA_TRANSFER_V1 — Шаблон / Импорт / Экспорт for the staff roster.
        // Export omits passwords (the API never returns them), so re-importing
        // an exported file updates people without resetting their logins.
        // ADMIN_ROWS_GRANTABLE_V1 — импорт и «Новый сотрудник» пишут: без
        // «Изменения» их нет.
        h('div', { class: 'page-head-actions' },
            ...(acc.canEdit ? importExportButtons({
                sectionKey:   'users',
                filenameStem: 'employees',
                fetchRows:    async () => (await api('')).users || [],
                onImported:   () => paint(root),
            }) : []),
            archiveBtn,
            acc.canEdit ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openEditor(null, root) }, Icon('Plus', { size: 14 }), ' Новый сотрудник') : null),
    ));

    const tbody = h('tbody');
    // EMP_COL_FILTERS_V1 — фильтр под каждой колонкой. Ростер небольшой и уже
    // загружен целиком, поэтому отбор идёт в памяти: без запросов и задержек.
    // Строка фильтров строится ОДИН раз и при отборе не перерисовывается —
    // иначе поле, в котором печатают, пересоздавалось бы и теряло фокус.
    // EMP_ARCHIVE_V1 — уволенные не мешаются в основном списке.
    //
    // Отключённая учётная запись не удаляется (за ней тянутся визиты, счета и
    // подписанные документы), поэтому со временем ростер обрастает людьми,
    // которые в клинике больше не работают. Искать среди них действующего врача
    // — лишняя работа каждый день. Теперь список показывает только работающих,
    // а отключённые лежат в архиве за кнопкой, откуда их можно вернуть.
    const flt = { name: '', staff: '', role: '', phone: '' };
    let allUsers = [];

    const countEl = h('span', { class: 'muted', style: { fontSize: '12.5px', fontWeight: 500, marginLeft: '8px' } });
    const inpStyle = {
        width: '100%', height: '28px', padding: '0 8px', borderRadius: '6px',
        border: '1px solid var(--ink-200)', background: 'var(--white, #fff)',
        fontSize: '12.5px', fontFamily: 'inherit', boxSizing: 'border-box',
    };
    const textFilter = (key, ph) => h('input', {
        type: 'text', placeholder: ph, value: flt[key], style: inpStyle,
        oninput: (e) => { flt[key] = e.target.value; renderRows(); },
    });
    const selectFilter = (key, options) => h('select', {
        style: inpStyle,
        onchange: (e) => { flt[key] = e.target.value; renderRows(); },
    }, ...options.map(([v, l]) => h('option', { value: v, selected: flt[key] === v }, l)));

    const nameFlt   = textFilter('name', 'Имя или @логин');
    const staffFlt  = selectFilter('staff', [['', 'Все']].concat(STAFF_TYPES));
    const roleFlt   = selectFilter('role', [['', 'Все']].concat(ROLES));
    const phoneFlt  = textFilter('phone', 'Телефон');
    // Отдельного фильтра по статусу нет: им управляет переключатель «Архив»
    // наверху. Два органа управления одним и тем же — это способ получить
    // пустой список и не понять почему.

    const resetBtn = h('button', {
        class: 'btn btn-outline btn-sm', type: 'button', title: 'Сбросить фильтры',
        style: { display: 'none', padding: '2px 10px', fontSize: '12.5px' },
        onclick: () => {
            Object.keys(flt).forEach(k => { flt[k] = ''; });
            nameFlt.value = ''; phoneFlt.value = '';
            staffFlt.value = ''; roleFlt.value = '';
            renderRows();
        },
    }, 'Сброс');

    root.appendChild(h('div', { class: 'card' },
        h('div', { class: 'card-header' }, h('h3', null, Icon('ID', { size: 16 }), ' Список сотрудников', countEl)),
        h('div', { class: 'emp-table-wrap' }, h('table', { class: 'tbl' },   // DOCTOR_PROFILE_V1 — колонок больше: на узком экране прокрутка внутри карточки
            h('thead', null,
                h('tr', null, h('th', null, 'Имя'), h('th', null, 'Категория'),
                    h('th', null, 'Специальность'), h('th', null, 'Приём'), h('th', null, 'Сайт и партнёры'),   // DOCTOR_PROFILE_V1 — колонки макета
                    h('th', null, 'Роль'), h('th', null, 'Телефон'), h('th', null, 'Статус'), h('th', null, '')),
                h('tr', { class: 'filter-row', style: { background: 'var(--ink-25, #f6f8f9)' } },
                    h('th', null, nameFlt), h('th', null, staffFlt), h('th', null), h('th', null), h('th', null),   // DOCTOR_PROFILE_V1
                    h('th', null, roleFlt), h('th', null, phoneFlt), h('th', null),
                    h('th', { style: { textAlign: 'right' } }, resetBtn)),
            ),
            tbody)),
    ));

    // Категория в таблице показывается с подстановкой: без staff_type врач всё
    // равно числится «Врачи». Фильтр обязан следовать той же логике.
    const catKey = (u) => u.staff_type || (u.is_doctor ? 'doctor' : '');
    // Телефон набирают как угодно («+998 90…», «90…»): сравниваем по цифрам,
    // если в запросе есть хоть одна, иначе — как обычную подстроку.
    const digits = (s) => String(s || '').replace(/\D/g, '');

    function matches(u) {
        const name = flt.name.trim().toLowerCase();
        if (name && !`${u.full_name || ''} ${u.username || ''}`.toLowerCase().includes(name)) return false;
        if (flt.staff && catKey(u) !== flt.staff) return false;
        if (flt.role && u.role !== flt.role) return false;
        const ph = flt.phone.trim();
        if (ph) {
            const d = digits(ph);
            const ok = d ? digits(u.phone).includes(d) : String(u.phone || '').toLowerCase().includes(ph.toLowerCase());
            if (!ok) return false;
        }
        // Режим решает статус: основной список — только работающие, архив —
        // только отключённые.
        if (showArchive ? u.is_active : !u.is_active) return false;
        return true;
    }

    // EMP_ARCHIVE_V1 — вернуть человека на работу можно прямо из архива:
    // ради одной галочки открывать карточку и искать вкладку «Вход и доступ» —
    // лишние три клика на действии, которое делают одним решением.
    async function reactivate(u, btn) {
        btn.disabled = true;
        try {
            await api('/' + u.id, { method: 'PATCH', body: JSON.stringify({ is_active: true }) });
            toast(trf('{name} — снова активен', { name: u.full_name || u.username }), 'ok');
            await paint(root);
        } catch (e) {
            toast(e.message || 'Не удалось активировать.', 'fail');
            if (btn.isConnected) btn.disabled = false;
        }
    }

    function renderRows() {
        const active = Object.values(flt).some(v => String(v || '').trim());
        resetBtn.style.display = active ? '' : 'none';

        const inArchive = allUsers.filter(u => !u.is_active).length;
        archiveBtn.textContent = showArchive ? tr('← К работающим') : (tr('Архив') + (inArchive ? ' · ' + inArchive : ''));
        archiveBtn.className = 'btn btn-sm ' + (showArchive ? 'btn-primary' : 'btn-outline');

        const rows = allUsers.filter(matches);
        const pool = allUsers.filter(u => (showArchive ? !u.is_active : u.is_active)).length;
        countEl.textContent = active ? trf('{n} из {max}', { n: rows.length, max: pool }) : (pool ? String(pool) : '');
        clear(tbody);
        if (!rows.length) {
            const why = showArchive
                ? (active ? 'Ни один отключённый сотрудник не подходит под фильтры.' : 'В архиве пусто — все сотрудники работают.')
                : (active ? 'Ни один сотрудник не подходит под фильтры.' : 'Нет сотрудников.');
            tbody.appendChild(h('tr', null, h('td', { colspan: '9', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, why)));   // DOCTOR_PROFILE_V1 — девять колонок
            return;
        }
        const branchesById = new Map(branches.map((b) => [Number(b.id), b]));   // DOCTOR_PROFILE_V1
        for (const u of rows) {
            const openBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Открыть');
            // Кнопки «Вернуть» у сотрудника главной клиники нет: сервер ответил
            // бы отказом (routes/users.js), а кнопка, которая всегда ругается, —
            // хуже отсутствующей. Вернуть его на работу можно там же, где его
            // отключили.
            const backBtn = (!showArchive || fromMain(u) || !acc.canEdit) ? null : h('button', {
                class: 'btn btn-primary btn-sm', type: 'button', style: { marginRight: '6px' },
                // stopPropagation: строка целиком открывает карточку, а тут
                // нажали именно «Вернуть».
                onclick: (e) => { e.stopPropagation(); reactivate(u, e.currentTarget); },
            }, 'Вернуть');

            tbody.appendChild(h('tr', { class: 'row-click', style: { cursor: 'pointer' }, onclick: () => openEditor(u, root) },
                h('td', null, h('span', { style: { fontWeight: 600 } }, u.full_name || u.username), h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '6px' } }, '@' + u.username),
                    // Метка сразу в списке, а не только внутри карточки: иначе
                    // администратор филиала открывал бы карточку за карточкой,
                    // чтобы понять, кого из них он вообще вправе править.
                    fromMain(u) ? h('span', { class: 'muted', style: { fontSize: '12.5px', marginLeft: '8px', padding: '1px 7px', border: '1px solid var(--ink-100)', borderRadius: '20px', whiteSpace: 'nowrap' } }, 'Главная клиника') : null),
                h('td', null, u.staff_type ? staffLabel(u.staff_type) : (u.is_doctor ? 'Врачи' : '—')),
                // DOCTOR_PROFILE_V1 — специальность, приём, показ на сайте и у партнёров (у не-врача — «—»).
                h('td', null, document.createTextNode(specNamesOf(u).map((n) => tr(n)).join(', ') || '—')),
                h('td', null, u.is_doctor ? (u.scheduling_mode === 'live_queue' ? 'Живая очередь' : 'По записи') : '—'),
                h('td', null, u.is_doctor ? publicTag(u, branchesById) : '—'),
                h('td', null, roleTitle(u)),   // CUSTOM_ROLES_V1 — своя роль зовётся своим именем
                h('td', null, u.phone || '—'),
                h('td', null, u.is_active ? h('span', { style: { color: 'var(--ok-700, #1a7a44)', fontWeight: 600, fontSize: '12.5px' } }, '● Активен') : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '○ Неактивен')),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, backBtn, openBtn),
            ));
        }
    }

    archiveBtn.addEventListener('click', () => { showArchive = !showArchive; renderRows(); });

    tbody.appendChild(h('tr', null, h('td', { colspan: '9', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, 'Загрузка…')));   // DOCTOR_PROFILE_V1 — девять колонок
    try {
        if (!departments.length || !branches.length || !services.length) {
            const [dep, br, sv, st, sc] = await Promise.all([
                supabase.from('departments').select('id, name').eq('active', 1).order('name'),
                supabase.from('branches').select('id, name, show_public').eq('active', 1).order('name'),   // DOCTOR_PROFILE_V1 — скрытое здание прячет врача (карточка и список)
                supabase.from('services').select('id, name, price, is_lab, type, type_id, category_id').eq('active', 1).order('name').limit(1000),
                // RATES_FILTERS_V2 — type and category, the clinic's own words,
                // as filters next to the group (owner: «add not only groups,
                // but category and type filters too for editing»).
                supabase.from('service_types').select('id, name').order('name').limit(2000),
                supabase.from('service_categories').select('id, name').order('name').limit(2000),
            ]);
            departments = dep.data || []; branches = br.data || []; services = sv.data || [];
            serviceTypes = st.data || []; serviceCategories = sc.data || [];
        }
        // CUSTOM_ROLES_V1 — свои роли клиники: их предлагают в «Основной роли» и
        // ими подписывают строку сотрудника. Отказ (старая база без таблицы) —
        // не беда: останутся штатные роли.
        try {
            const { data: cr } = await supabase.from('custom_roles').select('code, name, base_role, active').order('name');
            CUSTOM_ROLES = (cr || []).filter((c) => c && c.code);
        } catch (e) { CUSTOM_ROLES = []; }
        const { users } = await api('');
        allUsers = users || [];
        renderRows();
    } catch (e) {
        clear(tbody);
        tbody.appendChild(h('tr', null, h('td', { colspan: '9', style: { textAlign: 'center', padding: '18px', color: 'var(--crit-600)' } }, trf('Ошибка: {msg}', { msg: e.message || e }))));   // DOCTOR_PROFILE_V1 — девять колонок
    }
}

// Sections marked doctorOnly appear in the rail ONLY when category = «Врачи».
const SECTIONS = [
    { group: 'ПРОФИЛЬ', items: [
        { key: 'personal', label: 'Личные данные', icon: 'ID',          required: ['last_name', 'first_name', 'phone'] },
        { key: 'job',      label: 'Должность',      icon: 'Stethoscope', required: ['staff_type'] },
        { key: 'license',  label: 'Лицензия',       icon: 'Doc',         required: [], doctorOnly: true },
        // DOCTOR_PUBLIC_PROFILE_V1 — публичный профиль врача (миграция 159).
        { key: 'profile',  label: 'Публичный профиль', icon: 'User',     required: [], doctorOnly: true },
    ] },
    { group: 'РАБОТА', items: [
        { key: 'branches', label: 'Филиалы',              icon: 'Building', required: [] },
        { key: 'salary',   label: 'Занятость и зарплата', icon: 'Coins',    required: [] },
        { key: 'schedule', label: 'Рабочее время',        icon: 'Clock',    required: [] },
        { key: 'services', label: 'Услуги и ставки',      icon: 'Layers',   required: [], doctorOnly: true },
        // INPATIENT_BONUS_V1 — ставки стационара отдельно от амбулаторных и
        // вознаграждение за направление пациента в стационар.
        { key: 'inpatient', label: 'Стационар',            icon: 'Bed',      required: [], doctorOnly: true },
        { key: 'referral', label: 'Вознаграждение за направления', icon: 'Coins', required: [], doctorOnly: true },
    ] },
    { group: 'ДОСТУП', items: [ { key: 'access', label: 'Вход и доступ', icon: 'Settings', required: ['username', 'role'] } ] },
];
const ALL_SECTIONS = SECTIONS.flatMap(g => g.items);

function parseHours(str) { try { const o = JSON.parse(str || '{}'); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
const asArr = (v) => (Array.isArray(v) ? v : []);

// RATE_LOAD_V2 — every OPTIONAL key that parseRates() (server/routes/users.js)
// persists on a rate entry. Absence is meaningful for all of them — no `fix`
// means "paid a percentage", no `price` means "bill the catalog" — so they can
// only be carried through when present, never defaulted.
//
// This list used to be written out inline, separately for each of the two rate
// tables, and `fix` was missing from both. The effect was nasty precisely
// because the save worked: the server stored the fixed rate correctly, the
// editor dropped it on the next OPEN, and the following save then wrote the
// loss back — so a rate could be entered, confirmed saved, and be gone an hour
// later with nothing to show what happened. One shared mapping means the two
// tables cannot disagree; users.test.js pins the key set against the server so
// a new key added there cannot go unnoticed here.
// INPATIENT_BONUS_V1 (мигр. 155) — inpatient_pct здесь больше нет: ставки
// стационара живут в своём списке (inpatient_rates, вкладка «Стационар»).
const OPTIONAL_RATE_KEYS = ['price', 'fix', 'fixed'];
// Ревью I5 (мигр. 155) — запись БЕЗ pct значит «оказывает, ставка по
// умолчанию» (так её пишут окно услуги и перенос 155; отчёт берёт
// service_rate_default). Читать её как 0 нельзя: 0 ушёл бы на сервер при
// сохранении и перекрыл ставку по умолчанию. Поэтому pct копируется, только
// если он есть.
const loadRates = (list) => asArr(list).map((r) => {
    const out = { service_id: r.service_id, branches: asArr(r.branches) };
    if (r.pct != null && r.pct !== '') out.pct = Number(r.pct) || 0;
    for (const k of OPTIONAL_RATE_KEYS) if (r[k] != null) out[k] = Number(r[k]);
    return out;
});
// INPATIENT_BONUS_V1 — запись стационарной ставки: процент ЛИБО фикс за
// единицу (сервер примет ровно одно из двух, routes/users.js).
const loadInpatientRates = (list) => asArr(list).map((r) => (r && r.fix != null
    ? { service_id: Number(r.service_id), fix: Number(r.fix) || 0 }
    : { service_id: Number(r && r.service_id), pct: Number(r && r.pct) || 0 }));
const moneyText = (v) => (Number(v) > 0 ? String(Number(v)) : '');
// RATES_MODE_TYPED_V1 (2026-09-29) — процент ставки годен, только если он в
// 0..100. Больше 100 карточка теперь хранит КАК НАБРАН (прежде молча
// прижимала к 100 — и сумма, набранная в режиме «%», становилась долей 100 %):
// такое значение останавливает сохранение (overPct), а переключатель
// «% / сум» не возвращает его строке процентом (pctOk).
const pctOk = (v) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100;
// Первая запись в режиме «%» (без fix) с процентом больше 100 — или null.
const overPct = (list) => asArr(list).find((r) => r && r.fix == null && r.pct != null && r.pct !== '' && Number(r.pct) > 100) || null;
const serviceName = (sid) => (services.find((s) => Number(s.id) === Number(sid)) || {}).name || String(sid);

function openEditor(user, root) {
    const isEdit = !!user;
    const emp = {
        last_name: '', first_name: '', middle_name: '', phone: '', email: '',
        staff_type: '', scheduling_mode: 'schedulable', department_id: '', is_doctor: false,
        pbx_extension: '',   // CALL_FROM_CRM_V1
        is_public: false, booking_days: 14, show_queue_count: false,   // DOCTOR_PROFILE_V1
        specialty: '', specialties: [], doctor_category: '', hire_date: '', license_number: '', license_expiry_date: '',
        branch_id: '', employment_type: '', salary_type: '', salary_fixed: '', salary_percent: '',
        working_hours: {}, service_rates: [], referral_rates: [],
        inpatient_rates: [], inpatient_referral_pct: '', inpatient_referral_fixed: '',   // INPATIENT_BONUS_V1
        username: '', password: '', role: 'registrar', custom_role_code: '', extra_roles: [], is_active: true,
        // SOLE_BRANCH_V1 — филиал в клинике один: подставляем его сразу, чтобы
        // раздел «Филиалы» не требовал выбора там, где выбирать не из чего.
        // У существующего сотрудника ниже победит его собственное значение.
        ...(soleBranchId() != null ? { branch_id: String(soleBranchId()) } : {}),
        ...(user ? {
            // EMPLOYEE_CARD_SAVE_V1 — у сотрудника, заведённого одной строкой
            // full_name (демо-врачи, `admin` первого запуска), частей имени нет:
            // поля были пустыми, а шапка показывала логин. Теперь full_name
            // разбирается так же, как в старой карточке (shared/employee-name.js).
            ...employeeNameParts(user),
            phone: user.phone || '', email: user.email || '',
            staff_type: user.staff_type || (user.is_doctor ? 'doctor' : ''), scheduling_mode: user.scheduling_mode || 'schedulable',
            pbx_extension: user.pbx_extension || '',   // CALL_FROM_CRM_V1
            department_id: user.department_id != null ? String(user.department_id) : '',
            is_doctor: !!user.is_doctor, specialty: user.specialty || '', doctor_category: user.doctor_category || '', hire_date: user.hire_date || '',
            // MULTI_SPECIALTY_V1 — the list from the server (primary first); an old record has only the column
            specialties: (Array.isArray(user.specialties) && user.specialties.length ? user.specialties.map((x) => (typeof x === 'string' ? x : x.name)) : (user.specialty ? [user.specialty] : [])).map(canonicalSpecialty),
            license_number: user.license_number || '', license_expiry_date: user.license_expiry_date || '',
            // SOLE_BRANCH_V1 — у давнего сотрудника филиал мог не проставиться:
            // при единственном филиале подставляем его, а не пустое «—».
            branch_id: user.branch_id != null ? String(user.branch_id)
                : (soleBranchId() != null ? String(soleBranchId()) : ''),
            employment_type: user.employment_type || '', salary_type: user.salary_type || '',
            salary_fixed: user.salary_fixed ? String(user.salary_fixed) : '', salary_percent: user.salary_percent ? String(user.salary_percent) : '',
            working_hours: parseHours(user.working_hours),
            service_rates: loadRates(user.service_rates),
            // RATES_HONEST_V1 (ревью 1) — только для подсказки пустого процента:
            // запись без pct платит его (reports.js COALESCE). Не сохраняется —
            // payload собирается по списку полей.
            service_rate_default: Number(user.service_rate_default) || 0,
            referral_rates: loadRates(user.referral_rates),
            // INPATIENT_BONUS_V1 — вкладка «Стационар».
            inpatient_rates: loadInpatientRates(user.inpatient_rates),
            inpatient_referral_pct: moneyText(user.inpatient_referral_pct),
            inpatient_referral_fixed: moneyText(user.inpatient_referral_fixed),
            username: user.username || '', role: user.role || 'registrar', custom_role_code: user.custom_role_code || '',
            extra_roles: asArr(user.extra_roles).slice(), is_active: !!user.is_active,
            // DOCTOR_PUBLIC_PROFILE_V1 — что хранится; правка копится в profilePatch.
            public_profile: { ...(user.public_profile || {}) },
            is_public: !!user.is_public, booking_days: Number(user.booking_days) || 14, show_queue_count: !!user.show_queue_count,   // DOCTOR_PROFILE_V1
        } : {}),
    };
    if (!emp.public_profile) emp.public_profile = {};
    const profilePatch = {};
    let paneRepaint = null;   // DOCTOR_PROFILE_V1 — перерисовка заполненности «Публичного профиля» (задача 14)
    // CLINIC_API_FIX_V1 — профиль, с которым карточка открылась. В PATCH уходят
    // только поля, ставшие не такими (тексты — без пробелов по краям, как их
    // хранит сервер): тронутое и возвращённое не откатывает правку, которую
    // врач тем временем сделал в «Моём профиле». Не пришёл профиль — точка
    // отсчёта пустая, и пустой раздел ничего не стирает.
    const profileAtOpen = { ...emp.public_profile };
    // DOCTOR_PROFILE_V1 — точка отсчёта года «работает с» — то, что раздел покажет
    // (год из прежнего стажа у строки главной старой версии): показанное и
    // не тронутое не уходит.
    profileAtOpen.practice_since = shownPracticeSince(emp.public_profile);
    // DOCTOR_PROFILE_V1 — показ, срок записи и счётчик очереди, с которыми карточка открылась.
    const opened = { is_public: !!emp.is_public, booking_days: Number(emp.booking_days) || 14, show_queue_count: !!emp.show_queue_count };
    const paneErrors = {};   // DOCTOR_PROFILE_V1 — отказы сохранения по полям «Публичного профиля»
    let previewPromise = null;
    // DOCTOR_PROFILE_V1 — «Что увидят партнёры» и цены: один запрос на открытие карточки.
    const loadPreview = () => {
        if (!isEdit) return Promise.resolve(null);
        if (!previewPromise) {
            previewPromise = supabase.rpc('doctor_public_preview', { doctor_id: user.id })
                .then(({ data, error }) => (error || !data || typeof data !== 'object' || Array.isArray(data) ? false : data), () => false);
        }
        return previewPromise;
    };
    const profileSame = (k, a, b) => {
        if (k === 'experience_years' || k === 'practice_since') { const n = (v) => (v == null || v === '' ? null : Number(v)); return n(a) === n(b); }   // DOCTOR_PROFILE_V1 — год тоже числом
        if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
        return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
    };
    let active = 'personal';
    let dirty = false;
    // EMPLOYEE_CARD_SAVE_V1 — с чем карточка открылась: сохранение существующего
    // сотрудника держат только поля, которые ПРАВИЛИ и оставили пустыми
    // (shared/employee-name.js employeeSaveGaps). `refusal` — последний отказ
    // сохранения: он стоит в своём разделе, пока поля не заполнят, а не гаснет
    // тостом через 2,4 с. `ctrls` — поля раздела на экране, чтобы отметить пустое
    // и поставить в него курсор.
    // Ревью: телефон тоже — стёртый сейчас держит сохранение, как категория.
    // `user` (строка с сервера) решает, вернутся ли нетронутые части имени тем же
    // full_name (namesRoundTrip): иначе они не уходят.
    const was = { last_name: emp.last_name, first_name: emp.first_name, middle_name: emp.middle_name, staff_type: emp.staff_type, phone: emp.phone };
    // CLINIC_API_FIX_V1 — список специальностей, с которым карточка открылась
    // (уже приведённый canonicalSpecialty, порядок важен: первая — основная).
    // save() шлёт specialties / specialty, только когда список стал другим:
    // сервер переписывает user_specialties целиком, и правка одного оклада не
    // должна трогать специальности.
    const specKey = (list) => JSON.stringify((list || []).map((v) => String(v || '').trim()).filter(Boolean));
    const specsAtOpen = specKey(emp.specialties);
    let refusal = null;
    let statusBox = null;
    const ctrls = {};
    const FIELD_LABEL = { last_name: 'Фамилия', first_name: 'Имя', phone: 'Телефон', staff_type: 'Категория сотрудника', username: 'Логин', password: 'Пароль' };
    const saveGaps = () => employeeSaveGaps({ isEdit, now: emp, was, stored: user || {} });
    const namesTouched = () => NAME_KEYS.some((k) => String(emp[k] || '').trim() !== String(was[k] || '').trim());
    const emptyNow = (k) => !String(emp[k] || '').trim();
    const emptyAtOpen = (k) => !String(was[k] || '').trim();
    // STAFF_SYNC_V1 — карточка сотрудника, приехавшего из главной клиники,
    // ОТКРЫВАЕТСЯ, но не правится. Открывается — потому что филиалу нужно
    // видеть телефон врача и его специальность; не правится — потому что
    // правка дожила бы до ближайшей синхронизации и молча откатилась (сервер
    // отвечает на неё 409, см. routes/users.js). Свой сотрудник филиала —
    // is_local = 1 — правится как раньше, и на главной клинике таких строк нет
    // вовсе, поэтому там этот экран не меняется ничем.
    const managed = fromMain(user);
    // ADMIN_ROWS_GRANTABLE_V1 — «Сотрудники: Просмотр» открывает карточку, но не правит её.
    const acc = empAccess();
    const readOnly = managed || !acc.canEdit;

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const rail = h('div', { style: { width: '230px', flex: '0 0 230px', borderRight: '1px solid var(--ink-100)', padding: '10px 8px', overflowY: 'auto' } });
    const body = h('div', { style: { flex: 1, minWidth: 0, padding: '18px 22px', overflowY: 'auto' } });
    const ringWrap = h('div', { style: { textAlign: 'center' } });
    const headWrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 } });
    const dirtyEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } });

    const railSections = () => ALL_SECTIONS.filter(s => (!s.doctorOnly || emp.is_doctor) && (acc.money || !MONEY_SECTIONS.includes(s.key)));
    function reqFilled(f) { if (f === 'password') return isEdit || !!String(emp.password).trim(); return String(emp[f] != null ? emp[f] : '').trim() !== ''; }
    function sectionComplete(sec) { const req = sec.key === 'access' ? (isEdit ? sec.required : sec.required.concat('password')) : sec.required; return req.every(reqFilled); }
    function completionPct() { const all = railSections().flatMap(s => (s.key === 'access' && !isEdit) ? s.required.concat('password') : s.required); if (!all.length) return 100; return Math.round(all.filter(reqFilled).length / all.length * 100); }
    function touch() { dirty = true; dirtyEl.textContent = tr('● Есть несохранённые изменения'); }
    function markDirty(patch) { if (readOnly) return; Object.assign(emp, patch); touch(); renderRail(); renderHead(); paintStatus(); }   // EMPLOYEE_CARD_SAVE_V1 — отказ и пометки следят за вводом

    // EMPLOYEE_CARD_SAVE_V1 — строка раздела над полями. Отказ сохранения
    // называет пустые поля («Не заполнено: Фамилия, Имя»), отмечает их и стоит,
    // пока их не заполнят; пометки ниже сохранение не держат — они говорят, чего
    // в карточке нет. Перерисовывается на каждый ввод (markDirty), без
    // перестройки раздела — фокус остаётся в поле.
    const ALERT_STYLE = {
        display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
        padding: '9px 12px', borderRadius: '9px', fontSize: '13.5px', lineHeight: 1.5,
        background: 'var(--crit-50, #fef2f2)', border: '1px solid var(--crit-200, #fecaca)', color: 'var(--crit-700, #b91c1c)',
    };
    const NOTE_STYLE = {
        display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px',
        padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
        background: 'var(--ink-25, #f6f8f9)', border: '1px solid var(--ink-100)', color: 'var(--ink-600)',
    };
    function sectionNotes() {
        if (!isEdit) return [];
        const notes = [];
        if (active === 'personal') {
            // Одно слово в full_name (или имени нет вовсе), ФИО не правили: части
            // имени не уходят, и сервер оставит full_name прежним.
            if ((emptyNow('last_name') || emptyNow('first_name')) && !namesTouched()) notes.push('Фамилия или имя не заполнены. Остальные разделы карточки сохраняются, а ФИО останется прежним, пока не заполните оба поля.');
            // Пометка — только о том, чего не было с самого начала; стёртое сейчас
            // называет отказ сохранения.
            if (emptyNow('phone') && emptyAtOpen('phone')) notes.push('Телефон не заполнен');
        }
        if (active === 'job' && emptyNow('staff_type') && emptyAtOpen('staff_type')) notes.push('Категория сотрудника не выбрана');
        return notes;
    }
    function paintStatus() {
        if (refusal) {
            const r = saveGaps().refuse;
            refusal = r && r.section === refusal.section ? r : null;
        }
        const missing = refusal && refusal.section === active ? refusal.keys : [];
        for (const k of Object.keys(FIELD_LABEL)) {
            if (!ctrls[k]) continue;
            const el = ctrls[k].input || ctrls[k];   // у телефона рамку несёт само поле, а не обёртка
            el.setAttribute('aria-invalid', missing.includes(k) ? 'true' : 'false');
            el.style.borderColor = missing.includes(k) ? 'var(--crit-500, #d64545)' : '';
        }
        if (!statusBox) return;
        clear(statusBox);
        if (missing.length) {
            statusBox.appendChild(h('div', { role: 'alert', style: ALERT_STYLE }, Icon('Warning', { size: 15 }),
                h('span', null, trf('Не заполнено: {list}', { list: missing.map((k) => tr(FIELD_LABEL[k])).join(', ') }))));
        }
        for (const n of sectionNotes()) statusBox.appendChild(h('div', { style: NOTE_STYLE }, Icon('Info', { size: 15 }), h('span', null, n)));
    }
    // Отказ: раздел с пустым полем, строка в нём, курсор в первое пустое поле.
    function refuse(r) {
        refusal = r;
        active = r.section; renderRail(); renderBody();
        toast(trf('Не заполнено: {list}', { list: r.keys.map((k) => tr(FIELD_LABEL[k])).join(', ') }), 'fail');
        const first = ctrls[r.keys[0]];
        if (!first) return;
        if (typeof first.focus === 'function') first.focus();
        const el = first.input || first;
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    }

    function renderHead() {
        clear(ringWrap);
        ringWrap.appendChild(Ring({ value: completionPct(), max: 100, size: 54, stroke: 5, label: completionPct() + '%' }));
        ringWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', letterSpacing: '.06em', marginTop: '2px' } }, 'ЗАПОЛНЕНО'));
        clear(headWrap);
        const nm = [emp.last_name, emp.first_name].filter(Boolean).join(' ') || (isEdit ? emp.username : 'Новый сотрудник');
        headWrap.appendChild(h('span', { style: { width: '46px', height: '46px', borderRadius: '12px', background: 'var(--primary-600, #1f7a72)', color: '#fff', fontSize: '15px', fontWeight: 700, display: 'grid', placeItems: 'center', flex: '0 0 46px' } }, initials(nm)));
        headWrap.appendChild(h('div', { style: { minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('strong', { style: { fontSize: '17px' } }, nm),
                emp.is_active ? h('span', { style: { color: 'var(--ok-700, #1a7a44)', fontSize: '12.5px', fontWeight: 600 } }, '● Активен') : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '○ Неактивен')),
            // SPECIALTY_LIST_V1 — было «должность · категория». Должности больше
            // нет, и специальность описывает сотрудника точнее; без неё
            // остаётся одна категория, а не «Без должности».
            h('div', { class: 'muted', style: { fontSize: '12.5px' } },
                [(emp.specialties || []).filter(Boolean).join(', ') || emp.specialty, staffLabel(emp.staff_type)].filter(Boolean).join(' · ')),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '5px', flexWrap: 'wrap' } }, chip(depName(emp.department_id) || 'Без отдела'), chip('Lic. ' + (emp.license_number || '—')), chip(roleLabel(emp.role)))));
    }

    function renderRail() {
        clear(rail);
        for (const g of SECTIONS) {
            const items = g.items.filter(s => !s.doctorOnly || emp.is_doctor);
            if (!items.length) continue;
            rail.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px', letterSpacing: '.06em', padding: '10px 10px 4px' } }, g.group));
            for (const sec of items) {
                const on = active === sec.key;
                const done = sectionComplete(sec);
                rail.appendChild(h('div', {
                    style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', background: on ? 'var(--ink-25)' : 'transparent', fontWeight: on ? 600 : 400, fontSize: '13.5px' },
                    onclick: () => { active = sec.key; renderRail(); renderBody(); },
                },
                    h('span', { style: { color: on ? 'var(--primary-700)' : 'var(--ink-500)', display: 'flex' } }, Icon(sec.icon, { size: 15 })),
                    h('span', { style: { flex: 1 } }, sec.label),
                    done ? h('span', { style: { color: 'var(--ok-600, #2b8a4e)' } }, Icon('Check', { size: 14 })) : (sec.required.length ? h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--crit-500, #d64545)' } }) : null),
                ));
            }
        }
    }

    // EMPLOYEE_CARD_SAVE_V1 — txt / phonef / sel записывают поле в ctrls.
    const txt = (key, ph) => { const i = h('input', { type: 'text', value: emp[key] || '', placeholder: ph || '' }); i.addEventListener('input', () => markDirty({ [key]: i.value })); ctrls[key] = i; return i; };
    // PHONE_INPUT_V1 — same country-code control as patient registration; the
    // wrapper's 'input' bubbles from the real field, and .value reads '' while
    // only the «+998» default is showing.
    const phonef = (key, ph) => { const w = phoneInput(key, ph, { value: emp[key] }); w.addEventListener('input', () => markDirty({ [key]: w.value })); ctrls[key] = w; return w; };
    const numf = (key, ph) => { const i = h('input', { type: 'number', min: '0', step: '1', value: emp[key] || '', placeholder: ph || '' }); i.addEventListener('input', () => markDirty({ [key]: i.value })); return i; };
    const datef = (key) => { const i = h('input', { type: 'date', value: (emp[key] || '').slice(0, 10) }); i.addEventListener('input', () => markDirty({ [key]: i.value })); return i; };
    // CUSTOM_ROLES_V1 — четвёртым аргументом можно назвать ТЕКУЩЕЕ значение: у
    // списка ролей оно собирается из двух полей (role + код своей роли) и в
    // emp[key] не лежит.
    const sel = (key, opts, onset, curValue) => { const cur = curValue !== undefined ? curValue : emp[key]; const s = h('select', null, ...opts.map(([v, l]) => h('option', { value: v, selected: String(cur) === String(v) }, l))); s.addEventListener('change', () => onset ? onset(s.value) : markDirty({ [key]: s.value })); ctrls[key] = s; return s; };

    function pickCategory(v) {
        const becomingDoctor = v === 'doctor';
        const patch = { staff_type: v, is_doctor: becomingDoctor };
        if (becomingDoctor && emp.role !== 'doctor') patch.role = 'doctor';
        if (!becomingDoctor && emp.role === 'doctor') patch.role = 'registrar';
        markDirty(patch);
        if (!railSections().some(s => s.key === active)) active = 'job';
        renderRail(); renderBody();
    }

    // STAFF_SYNC_V1 — одна сеть на всю карточку, а не `disabled` по каждому полю.
    // Поля строят и вложенные секции («Рабочее время», «Услуги и ставки») —
    // своим кодом, мимо любого перечня; и новое поле, добавленное сюда завтра,
    // родилось бы редактируемым, а узнали бы об этом по правке, уехавшей в
    // никуда. Обход уже построенного поддерева не может пропустить ни то, ни
    // другое.
    function disableAll(node) {
        for (const child of node.children || []) {
            const tag = String(child.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') child.disabled = true;
            disableAll(child);
        }
    }

    // Строка стоит ПЕРВОЙ и на каждом разделе карточки: администратор филиала
    // должен узнать, почему поля серые, раньше, чем начнёт в них тыкать. Что
    // делать — тоже сказано: карточка правится в главной клинике и приедет
    // оттуда сама.
    const managedNote = () => h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px',
            padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
            background: 'var(--ink-25, #f6f8f9)', border: '1px solid var(--ink-100)', color: 'var(--ink-600)',
        },
    }, Icon('Building', { size: 15 }), h('span', null, 'Этого сотрудника ведёт главная клиника — изменить его данные можно только там.'));
    // ADMIN_ROWS_GRANTABLE_V1 — та же строка для роли с «Сотрудники: Просмотр».
    const viewOnlyNote = () => h('div', {
        style: {
            display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px',
            padding: '9px 12px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5,
            background: 'var(--ink-25, #f6f8f9)', border: '1px solid var(--ink-100)', color: 'var(--ink-600)',
        },
    }, Icon('Lock', { size: 15 }), h('span', null, 'Только просмотр: менять сотрудников может роль с «Сотрудники: Изменение».'));

    function renderBody() {
        clear(body);
        // EMPLOYEE_CARD_SAVE_V1 — поля и строка состояния — этого раздела.
        for (const k of Object.keys(ctrls)) delete ctrls[k];
        statusBox = ['personal', 'job', 'access'].includes(active) ? h('div') : null;
        if (managed) body.appendChild(managedNote());
        else if (readOnly) body.appendChild(viewOnlyNote());
        const sec = ALL_SECTIONS.find(s => s.key === active) || ALL_SECTIONS[0];
        const head = (title, sub, right) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' } },
            h('span', { style: { width: '40px', height: '40px', borderRadius: '11px', background: 'var(--primary-50, #e8f3f2)', color: 'var(--primary-700, #1f7a72)', display: 'grid', placeItems: 'center', flex: '0 0 40px' } }, Icon(sec.icon, { size: 19 })),
            h('div', { style: { flex: 1 } }, h('h2', { style: { margin: 0, fontSize: '17px' } }, title), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub)),
            right || null);
        const grid = (...els) => h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' } }, ...els.filter(Boolean));
        // MULTI_SPECIALTY_V1 — up to four specialties (owner). The first is the
        // primary: it is what users.specialty carries and what every other
        // screen shows. «+ Добавить специальность» adds a row; «×» removes one.
        const MAX_SPEC = 4;
        function specialtiesField() {
            const list = () => { if (!Array.isArray(emp.specialties)) emp.specialties = []; if (!emp.specialties.length) emp.specialties.push(emp.specialty || ''); return emp.specialties; };
            // CLINIC_API_FIX_V1 — правка НА МЕСТЕ: строки на экране держат этот же
            // массив (`rows` в paint), и новый массив терял вторую правку того же
            // списка и «Добавить специальность» после правки.
            // DOCTOR_PROFILE_V1 — заполненность «Публичного профиля» следит за списком.
            const commit = () => { const rows = list(); rows.forEach((v, i) => { rows[i] = String(v || '').trim(); }); emp.specialty = rows[0] || ''; markDirty({ specialty: emp.specialty, specialties: rows }); if (paneRepaint) paneRepaint(); };
            const box = h('div', { class: 'spec-list' });
            // DOCTOR_PROFILE_V1 — повтор отклоняется у поля (макет «Эта специальность уже выбрана.»).
            const err = h('div', { class: 'cpf-err spec-err', role: 'alert' });
            err.hidden = true;
            const say = (msg) => { err.textContent = msg ? tr(msg) : ''; err.hidden = !msg; };
            // DOCTOR_PROFILE_V1 — рядом с выбранной — её узбекское и английское названия и
            // код справочника: по коду партнёры ищут врача (макет specialtyRows).
            const namesOf = (val) => {
                const canon = SPECIALTY_ROWS.find((r) => r.ru === canonicalSpecialty(val));
                if (!canon) {
                    return h('span', { class: 'spec-names muted' }, String(val || '').trim()
                        ? 'Нет в справочнике — партнёры не найдут врача по ней'
                        : 'Названия на узбекском и английском подставятся из справочника');
                }
                return h('span', { class: 'spec-names' },
                    h('span', null, h('span', { class: 'cpf-lang' }, 'UZ'), ' ', document.createTextNode(canon.uz)),
                    h('span', null, h('span', { class: 'cpf-lang' }, 'EN'), ' ', document.createTextNode(canon.en)),
                    h('code', null, document.createTextNode(canon.slug)));
            };
            const paint = () => {
                clear(box);
                const rows = list();
                rows.forEach((val, i) => {
                    const s2 = h('select', { 'aria-label': i === 0 ? 'Основная специальность' : 'Дополнительная' },
                        ...specialtyOptions(val).map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l)));
                    const names = h('div', { class: 'spec-names-slot' }, namesOf(val));
                    s2.addEventListener('change', () => {
                        const v = String(s2.value || '').trim();
                        if (v && rows.some((x, j) => j !== i && String(x || '').trim() === v)) { s2.value = rows[i] || ''; say(SPEC_TAKEN); return; }
                        say('');
                        rows[i] = s2.value; commit();
                        clear(names); names.appendChild(namesOf(rows[i]));
                    });
                    const rm = i > 0 ? h('button', { type: 'button', class: 'icon-btn sm', title: tr('Убрать'), 'aria-label': tr('Убрать'),
                        onclick: () => { rows.splice(i, 1); commit(); paint(); } }, Icon('X', { size: 14 })) : null;
                    box.appendChild(h('div', { class: 'spec-row' },
                        h('span', { class: 'spec-cap' }, i === 0 ? 'Основная' : 'Дополнительная'), s2, rm, names));
                });
                if (rows.length < MAX_SPEC) box.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm spec-add',
                    onclick: () => { rows.push(''); paint(); } }, Icon('Plus', { size: 14 }), ' ', tr('Добавить специальность')));
                box.appendChild(err);
            };
            paint();
            return field(trf('Специальность (основная — первая, до {n})', { n: MAX_SPEC }), box);
        }
        const hint = (t) => h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px', lineHeight: 1.5 } }, t);

        if (active === 'personal') {
            body.append(head('Личные данные', 'Личные и контактные данные сотрудника.'), statusBox,   // EMPLOYEE_CARD_SAVE_V1
                grid(field('Фамилия', txt('last_name', 'Каюмов'), { required: true }), field('Имя', txt('first_name', 'Араббек'), { required: true }),
                    field('Отчество', txt('middle_name', 'Акмалович')), field('Телефон', phonef('phone', '+998 90 961 00 04'), { required: true }), field('Email', txt('email', 'name@example.uz')),
                    // CALL_FROM_CRM_V1 — внутренний номер на АТС. Среди контактов,
                    // а не в «Должности»: это способ дозвониться до человека, как
                    // телефон и почта. Пустое поле — обычное дело: не все сидят на
                    // телефоне, и кнопка «Позвонить» тогда честно скажет, чего нет.
                    field('Внутренний номер (АТС), если он есть', txt('pbx_extension', '101'))),
                // CALL_FROM_CRM_V1 — владелец: «why we need to setup a telephony
                // if we are making call from same number from pbx?». Поле
                // НЕОБЯЗАТЕЛЬНОЕ, и подсказка обязана это говорить первой
                // строкой: клиника с одной линией не должна ничего сюда вписывать.
                hint('Заполняйте, только если у сотрудника своя трубка в АТС. Тогда по кнопке «Позвонить» зазвонит именно она, и в журнале будет видно, кто звонил. Если номер у клиники один — оставьте пусто, звонок пойдёт с номера линии из настроек телефонии.'),
                hint('Пациент в любом случае видит номер клиники: что он увидит, решает сама АТС, а не это поле.'));
        } else if (active === 'job') {
            body.append(head('Должность', 'Роль, отдел и должность в клинике.'), statusBox,   // EMPLOYEE_CARD_SAVE_V1
                field('Категория сотрудника', sel('staff_type', [['', 'Выберите категорию…']].concat(STAFF_TYPES), pickCategory), { required: true }),
                hint('Врачи получают роль доступа «Врач», попадают в список врачей клиники, и для них открываются разделы Лицензия / Услуги и ставки / Вознаграждение за направления.'),
                // NULL_IN_APPEND_V1 — пустая ветка тут превратилась бы в слово «null»
                // на экране: это родной Element.append, а не h(). У не-врача блок
                // просто не строится.
                ...(emp.is_doctor ? [h('div', { style: { marginTop: '14px' } }, field('Приём услуг', sel('scheduling_mode', [['schedulable', 'По записи (расписание)'], ['live_queue', 'Живая очередь']])),
                    hint('«По записи» — регистратор выбирает дату и время. «Живая очередь» — визит создаётся без времени.'))] : []),
                // SPECIALTY_LIST_V1 — «Должность» (свободный текст) убрана: она
                // дублировала категорию сотрудника и специальность, но ничем не
                // управляла и нигде, кроме шапки карточки, не показывалась.
                // «Специальность» — теперь список, чтобы одна и та же
                // специальность не приезжала в трёх написаниях.
                h('div', { style: { marginTop: '14px' } }, grid(
                    field('Отдел', sel('department_id', [['', '—']].concat(departments.map(d => [String(d.id), d.name])))),
                    specialtiesField(), field('Дата приёма', datef('hire_date')),
                    emp.is_doctor ? field('Категория врача', sel('doctor_category', DOCTOR_CATEGORIES)) : null)));
        } else if (active === 'license') {
            body.append(head('Лицензия', 'Медицинская лицензия сотрудника.'), grid(field('Номер лицензии', txt('license_number', 'AA-000000')), field('Действует до', datef('license_expiry_date'))));
        } else if (active === 'profile') {
            // DOCTOR_PROFILE_V1 — раздел макета «Публичный профиль» (views/doctor-public-pane.js).
            body.append(head('Публичный профиль', 'Как врача видят пациенты на сайте клиники, в Symptex и у партнёров. Врач правит это же в «Моём профиле».'),
                doctorPublicPane({
                    emp, profile: emp.public_profile, isEdit, readOnly, isAdmin: acc.admin,
                    doctorId: isEdit ? user.id : null, errors: paneErrors,
                    initials: initials([emp.last_name, emp.first_name].filter(Boolean).join(' ') || emp.username || ''),
                    setProfile: (k, v) => { emp.public_profile[k] = v; profilePatch[k] = v; markDirty({}); },
                    setField: (patch) => markDirty(patch),
                    specialtiesNode: () => specialtiesField(),
                    specialtiesCount: () => (emp.specialties || []).filter((v) => String(v || '').trim()).length,
                    branchesById: new Map(branches.map((b) => [Number(b.id), b])),
                    loadPreview,
                    onRepaint: (fn) => { paneRepaint = fn; },
                    openConsultations: isRouteAllowed('consultation-types') ? () => {
                        close();
                        const nav = typeof window !== 'undefined' && window.easymed && window.easymed.navigate;
                        if (typeof nav === 'function') nav('consultation-types');
                    } : null,
                }));
        } else if (active === 'branches') {
            body.append(head('Филиалы', 'Филиал, в котором работает сотрудник.'), field('Основной филиал', sel('branch_id', [['', '—']].concat(branches.map(b => [String(b.id), b.name])))),
                hint(branches.length ? '' : 'Филиалы настраиваются в Настройки → Управление филиалами.'));
        } else if (active === 'salary') {
            body.append(head('Занятость и зарплата', 'Тип занятости и модель оплаты.'),
                grid(field('Тип занятости', sel('employment_type', EMPLOYMENT_TYPES)), field('Тип зарплаты', sel('salary_type', SALARY_TYPES)), field('Оклад (сум)', numf('salary_fixed', '0')), field('Процент (%)', numf('salary_percent', '0'))),
                hint('Оклад — для «Оклад» / «Оклад + KPI». Процент — для «Процент» / «Оклад + KPI».'));
        } else if (active === 'schedule') {
            body.append(head('Рабочее время', 'Дни и часы работы сотрудника.'), buildHours(emp, markDirty));
        } else if (active === 'services') {
            // RATES_MODE_TYPED_V1 (m12) — доля берётся после скидки И налога.
            body.append(ratesSection(emp, 'service_rates', { icon: sec.icon, title: 'Услуги и ставки', sub: 'Сколько врач получает за оказанную услугу: процент от суммы после скидки и налога либо фиксированная сумма за единицу. Своя цена — если этот врач берёт за услугу не как в каталоге; пусто = цена каталога.', rateLabel: 'Ставка врача', allowFix: true, ownPrice: true }, touch));
        } else if (active === 'inpatient') {
            // INPATIENT_BONUS_V1 — стационар отдельно от «Услуг и ставок»:
            // ставка здесь не заводит амбулаторной записи и не обнуляет
            // ставку по умолчанию.
            body.append(inpatientSection(emp, touch));
        } else if (active === 'referral') {
            // REPORTS_V2 — вкладка была МЁРТВОЙ: таблица писала users.referral_rates,
            // а вознаграждение за направления (отчёт «Рефералы», кабинет врача)
            // читает ставку источника этого врача (referral_sources, мигр. 122).
            // Процент вводился, сохранялся и не платился. Теперь здесь та же
            // рабочая правка, что в старой карточке, — общим модулем.
            body.append(head('Вознаграждение за направления', 'Что врач получает, когда пациент пришёл по его направлению.'),
                referralRewardEditor({ doctorId: isEdit ? user.id : null, holder: emp, onChange: () => markDirty({}), readOnly }));
        } else if (active === 'access') {
            // CUSTOM_ROLES_V1 — в одном списке штатные роли и роли клиники. У своей
            // роли значение 'custom:<код>': выбрали её — в role ложится ОСНОВА
            // (её и проверяет сервер), а код едет отдельным полем.
            // ADMIN_ROWS_GRANTABLE_V1 — роль администратора (и своя роль на её
            // основе) не-администратору не предлагается: сервер её не назначит.
            // Ревью безопасности C1 — и основа только та, что носит сам назначающий:
            // данные сервер отдаёт по основе (routes/users.js откажет второй раз).
            const own = new Set(actorRoleCodes());
            const baseOk = (b) => acc.admin || (b !== 'admin' && own.has(b));
            const activeCustom = CUSTOM_ROLES.filter((c) => (c.active || c.code === emp.custom_role_code) && (baseOk(c.base_role) || c.code === emp.custom_role_code));
            const roleOptions = [
                ...ROLES.filter((r) => baseOk(r[0]) || emp.role === r[0]).map((r) => [r[0], r[1]]),
                ...activeCustom.map((c) => ['custom:' + c.code, c.name + ' · ' + tr(roleLabel(c.base_role))]),
            ];
            const roleValue = emp.custom_role_code ? 'custom:' + emp.custom_role_code : emp.role;
            const roleSel = sel('roleChoice', roleOptions, (v) => {
                if (String(v).startsWith('custom:')) {
                    const code = String(v).slice(7);
                    const c = customRoleOf(code);
                    markDirty({ custom_role_code: code, role: (c && c.base_role) || emp.role, extra_roles: (emp.extra_roles || []).filter(r => r !== ((c && c.base_role) || emp.role)) });
                } else {
                    markDirty({ custom_role_code: '', role: v, extra_roles: (emp.extra_roles || []).filter(r => r !== v) });
                }
                renderBody();
            }, roleValue);
            const extraRoles = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
            for (const [rk, rl] of ALL_ASSIGNABLE_ROLES) {
                if (rk === emp.role) continue;
                if (!acc.admin && !own.has(rk) && !(emp.extra_roles || []).includes(rk)) continue;   // ADMIN_ROWS_GRANTABLE_V1 — ревью C1: только свои основы
                const on = (emp.extra_roles || []).includes(rk);
                const c = h('input', { type: 'checkbox', checked: on });
                c.addEventListener('change', () => { const set = new Set(emp.extra_roles || []); c.checked ? set.add(rk) : set.delete(rk); markDirty({ extra_roles: [...set].filter(r => r !== emp.role) }); });
                extraRoles.appendChild(h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', padding: '5px 10px', border: '1px solid ' + (on ? 'var(--primary-300, #9fd0cb)' : 'var(--ink-100)'), borderRadius: '20px', cursor: 'pointer', background: on ? 'var(--primary-50, #e8f3f2)' : 'transparent' } }, c, rl));
            }
            body.append(head('Вход и доступ', 'Логин, пароль и роли доступа. Каждый сотрудник входит в систему.'), statusBox,   // EMPLOYEE_CARD_SAVE_V1
                grid(field('Логин', (() => { const i = h('input', { type: 'text', value: emp.username, placeholder: 'login', disabled: isEdit }); i.addEventListener('input', () => markDirty({ username: i.value })); ctrls.username = i; return i; })(), { required: true }),
                    field('Основная роль', roleSel, { required: true }),
                    field(isEdit ? 'Новый пароль (пусто — не менять)' : 'Пароль', (() => { const i = h('input', { type: 'password', value: '', placeholder: '••••••••' }); i.addEventListener('input', () => markDirty({ password: i.value })); ctrls.password = i; return i; })(), { required: !isEdit })),
                h('div', { style: { marginTop: '14px' } }, h('div', { style: { fontSize: '13.5px', fontWeight: 600, marginBottom: '7px' } }, 'Дополнительные роли'), extraRoles,
                    hint('Сотруднику открывается объединение разделов всех его ролей. Права на данные определяются основной ролью.')),
                h('div', { style: { marginTop: '12px' } }, checkField('Активен', (() => { const c = h('input', { type: 'checkbox', checked: emp.is_active }); c.addEventListener('change', () => markDirty({ is_active: c.checked })); return c; })())),
                // NULL_IN_APPEND_V1 — здесь НЕЛЬЗЯ писать `isEdit ? null : hint(…)`.
                // Это не h(), который пустые ветки пропускает (ui.js: `if (c == null
                // || c === false) continue`), а РОДНОЙ Element.append: он превращает
                // всё, что не узел, в текст, и null становится строкой «null».
                // Владелец её и увидел — под галочкой «Активен» при правке
                // сотрудника. Поэтому подсказку добавляем отдельной строкой, а не
                // веткой внутри append.
                );
            if (!isEdit) {
                body.append(hint('Логин 3–30 символов (латиница, цифры, . _ -). Пароль — любой, длину выбирает клиника.'));
            }
        }
        if (!readOnly) paintStatus();   // EMPLOYEE_CARD_SAVE_V1 — у карточки «только просмотр» нечего сохранять
        if (readOnly) disableAll(body);
    }

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Сохранить сотрудника');
    saveBtn.addEventListener('click', save);

    // STAFF_DELETE_V1 — removal, but only for an account with no history behind
    // it. Anyone who has seen a patient, taken money or signed a document stays
    // on the roster (deactivated), because their name is what those records
    // point at. The server decides; this asks first so the dialog can say which
    // of the two is actually on offer.
    const deleteBtn = isEdit && acc.canDelete   // ADMIN_ROWS_GRANTABLE_V1 — «Удаление» у роли
        ? h('button', { class: 'btn btn-danger', type: 'button', onclick: confirmDelete },
            Icon('Trash', { size: 14 }), ' Удалить')
        : null;

    // PASSWORD_CHANGE_V2 — пароль существующего сотрудника меняется ОТДЕЛЬНО от
    // карточки: окно шлёт PATCH только с { password }, и потому не упирается в
    // проверку ФИО, телефона и категории в save() ниже. Без этого учётная
    // запись первого запуска `admin` (в ней не заполнено ничего) и сотрудники
    // без телефона не могли получить новый пароль вовсе.
    //
    // Ревью W1-M1: СВОЯ карточка — то же окно, что в меню аватара, с текущим
    // паролем (/api/auth/change-password). PATCH без текущего — право
    // администратора на чужую учётную запись; на своей он обходил бы проверку
    // «докажи, что это ты».
    const isSelf = isEdit && selfUserId() != null && String(selfUserId()) === String(user.id);
    const passwordBtn = isEdit
        ? h('button', { class: 'btn btn-outline', type: 'button',
            onclick: () => (isSelf ? openChangeOwnPasswordModal() : openEmployeePasswordModal(user)) },
            Icon('Lock', { size: 14 }), ' Сменить пароль')
        : null;

    async function confirmDelete() {
        deleteBtn.disabled = true;
        try {
            const chk = await api('/' + user.id + '/delete-check');
            const who = chk.name || user.full_name || user.username;

            if (!chk.deletable) {
                // A guard reason (own account, last admin) has no alternative to
                // offer; a history reason does — deactivation.
                if (!chk.blocking || !chk.blocking.length) { toast(chk.reason || 'Удаление невозможно.', 'fail'); return; }
                const where = chk.blocking.map(b => `${b.label}: ${b.count}`).join(', ');
                const ok = window.confirm(
                    trf('За сотрудником «{who}» закреплены записи ({where}).\n\nУдалить его нельзя — визиты, счета и журналы ссылаются на него как на автора.\n\nОтключить учётную запись вместо удаления? Он исчезнет из выбора и не сможет войти, а записи останутся целыми.', { who, where }));
                if (ok) await deactivate();
                return;
            }

            if (!window.confirm(trf('Удалить сотрудника «{who}» навсегда?\n\nЗа ним нет ни одной записи, поэтому он удаляется без следа.', { who }))) return;
            await api('/' + user.id, { method: 'DELETE' });
            toast(trf('Сотрудник «{who}» удалён', { who }), 'ok');
            close();
            await paint(root);
        } catch (e) {
            toast(e.message || 'Не удалось удалить сотрудника.', 'fail');
        } finally {
            if (deleteBtn.isConnected) deleteBtn.disabled = false;
        }
    }

    async function deactivate() {
        await api('/' + user.id, { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
        toast('Учётная запись отключена — записи сохранены', 'ok');
        close();
        await paint(root);
    }

    async function save() {
        // EMPLOYEE_CARD_SAVE_V1 — прежде здесь стояла одна проверка на всю
        // карточку: без Фамилии, Имени И Телефона не уходило ничего, даже ставки
        // (21 карточка из 45 на базе разработки). Теперь у существующего
        // сотрудника её держит только то, что правили и оставили пустым;
        // новому по-прежнему нужны Фамилия, Имя и Телефон (employeeSaveGaps).
        const gaps = saveGaps();
        if (gaps.refuse) { refuse(gaps.refuse); return; }
        // RATES_MODE_TYPED_V1 — процент больше 100 не прижимается молча, а
        // останавливает сохранение: чаще всего это сумма, набранная в режиме
        // «%» (аудит: 25 000 становились 100 %, а врач получал не то, что
        // договорено). Открываем вкладку, где он набран, и говорим, как быть.
        // Без «Цены и проценты» ставки не уходят вовсе — и не проверяются.
        if (acc.money) {
            const over = overPct(emp.service_rates) ? ['services', overPct(emp.service_rates)]
                : overPct(emp.inpatient_rates) ? ['inpatient', overPct(emp.inpatient_rates)] : null;
            if (over) {
                active = over[0]; renderRail(); renderBody();
                toast(trf('Ставка «{name}» — {n}%: процент не больше 100. Если это сумма, переключите на «сум».',
                    { name: serviceName(over[1].service_id), n: over[1].pct }), 'fail');
                return;
            }
        }
        // DOCTOR_PROFILE_V1 — публичный профиль врача: ФИО на русском и
        // специальность у показываемого, год «работает с» — у поля, до отправки
        // (сервер проверит то же: routes/users.js).
        if (emp.is_doctor) {
            for (const k of Object.keys(paneErrors)) delete paneErrors[k];
            Object.assign(paneErrors, publicPaneProblems({
                isPublic: !!emp.is_public, profile: emp.public_profile, profileAtOpen, touched: Object.keys(profilePatch),
                specialtiesCount: (emp.specialties || []).filter((v) => String(v || '').trim()).length,
            }));
            const firstKey = Object.keys(paneErrors)[0];
            if (firstKey) { active = 'profile'; renderRail(); renderBody(); toast(paneErrors[firstKey], 'fail'); return; }
        }

        const payload = {
            last_name: emp.last_name.trim(), first_name: emp.first_name.trim(), middle_name: emp.middle_name.trim(),
            phone: emp.phone.trim(), email: emp.email.trim(), staff_type: emp.staff_type, scheduling_mode: emp.scheduling_mode || 'schedulable',
            // CALL_FROM_CRM_V1 — внутренний номер. Пустая строка здесь ОСМЫСЛЕННА:
            // сервер понимает её как «стереть номер» (routes/users.js), поэтому
            // сотрудника можно снять с телефона, не заводя для этого отдельного
            // действия.
            pbx_extension: String(emp.pbx_extension || '').trim(),
            // `position` is deliberately NOT sent: the field is gone from the UI,
            // and PATCH only writes keys it receives, so any value an existing
            // record already carries is left untouched rather than blanked.
            department_id: emp.department_id ? Number(emp.department_id) : null,
            specialty: String(emp.specialty || '').trim(), doctor_category: emp.doctor_category || '', hire_date: emp.hire_date || '',
            // MULTI_SPECIALTY_V1 — the whole list; the server takes the first as users.specialty
            specialties: (emp.specialties || []).map((v) => String(v || '').trim()).filter(Boolean)
                .map((name) => ({ name, slug: (SPECIALTY_ROWS.find((r) => r.ru === name) || {}).slug || null })),
            license_number: emp.license_number.trim(), license_expiry_date: emp.license_expiry_date || '',
            branch_id: emp.branch_id ? Number(emp.branch_id) : null, employment_type: emp.employment_type || '', salary_type: emp.salary_type || '',
            salary_fixed: Number(emp.salary_fixed) || 0, salary_percent: Number(emp.salary_percent) || 0, working_hours: JSON.stringify(emp.working_hours || {}),
            service_rates: asArr(emp.service_rates), referral_rates: asArr(emp.referral_rates),
            // INPATIENT_BONUS_V1 — вкладка «Стационар»; пустое поле бонуса — 0.
            inpatient_rates: asArr(emp.inpatient_rates),
            inpatient_referral_pct: Number(emp.inpatient_referral_pct) || 0,
            inpatient_referral_fixed: Number(emp.inpatient_referral_fixed) || 0,
            role: emp.role, custom_role_code: emp.custom_role_code || '', extra_roles: (emp.extra_roles || []).filter(r => r !== emp.role), is_active: !!emp.is_active,
        };
        if (String(emp.password).trim()) payload.password = emp.password;
        // EMPLOYEE_CARD_SAVE_V1 — Фамилии или Имени нет, а ФИО не правили (одно
        // слово в full_name): части не уходят вовсе. Сервер пересобирает
        // full_name, только когда части присланы (routes/users.js), — без них
        // имя остаётся ровно таким, каким было, а неполные части не ложатся в
        // колонки.
        if (isEdit && !gaps.sendNames) for (const k of NAME_KEYS) delete payload[k];
        // CLINIC_API_FIX_V1 — специальности не правили: не уходят ни список, ни
        // users.specialty. Сервер пишет только присланные ключи (routes/users.js),
        // так что строки user_specialties с узбекскими названиями и кодами,
        // которых карточка не знает, остаются как были.
        if (isEdit && specKey(emp.specialties) === specsAtOpen) { delete payload.specialties; delete payload.specialty; }
        // DOCTOR_PUBLIC_PROFILE_V1 — только изменённые поля профиля.
        // CLINIC_API_FIX_V1 — «изменённые» — отличные от открытых, а не тронутые.
        const profileChanged = {};
        for (const [k, v] of Object.entries(profilePatch)) if (!profileSame(k, v, profileAtOpen[k])) profileChanged[k] = v;
        if (Object.keys(profileChanged).length) payload.public_profile = profileChanged;
        // DOCTOR_PROFILE_V1 — показ, срок записи и счётчик очереди — только
        // изменённое (показ меняет только администратор: у остальных
        // переключатель выключен, сервер ответил бы 403).
        if (!!emp.is_public !== opened.is_public) payload.is_public = !!emp.is_public;
        if (!!emp.show_queue_count !== opened.show_queue_count) payload.show_queue_count = !!emp.show_queue_count;
        if (Number(emp.booking_days) !== opened.booking_days) payload.booking_days = Number(emp.booking_days);
        // ADMIN_ROWS_GRANTABLE_V1 — без «Цены и проценты» деньги не уходят вовсе:
        // экран их не показывал, и сервер отказал бы всей записи.
        if (!acc.money) for (const k of MONEY_KEYS) delete payload[k];

        saveBtn.disabled = true; const prev = saveBtn.textContent; saveBtn.textContent = tr('Сохранение…');
        try {
            if (isEdit) await api('/' + user.id, { method: 'PATCH', body: JSON.stringify(payload) });
            else await api('', { method: 'POST', body: JSON.stringify({ ...payload, username: emp.username.trim() }) });
            // REPORTS_V2 — ставка за направления лежит на источнике врача, а не в
            // карточке: пишется своей попыткой, и её отказ не выдаётся за неудачу
            // сохранения самого сотрудника. Вкладку не открывали — не пишется вовсе.
            if (isEdit && emp.referralReward && acc.money) {
                const err = await saveReferralReward(user.id, emp.referralReward);
                if (err) toast(trf('Сотрудник сохранён, но ставка за направления — нет: {msg}', { msg: err }), 'fail');
            }
            toast('Сотрудник сохранён', 'ok'); close(); await paint(root);
        } catch (e) { toast(e.message || 'Не удалось сохранить.', 'fail'); saveBtn.disabled = false; saveBtn.textContent = prev; }
    }

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '1080px', maxWidth: 'calc(100vw - 32px)', height: 'min(90vh, 780px)', display: 'flex', flexDirection: 'column' } },   // RATES_FILTERS_V2 — room for the service name
        h('header', { class: 'modal-head', style: { alignItems: 'center' } }, headWrap, ringWrap, h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } }, rail, body),
        // Кнопок «Сохранить» и «Удалить» у карточки главной клиники нет вовсе —
        // не отключённых, а отсутствующих: отключённая кнопка предлагает
        // действие и молчит о том, почему оно недоступно, а причина уже сказана
        // строкой над полями.
        h('footer', { class: 'modal-foot' }, readOnly ? null : deleteBtn, readOnly ? null : passwordBtn, dirtyEl, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: close }, readOnly ? 'Закрыть' : 'Отмена'), readOnly ? null : saveBtn),
    ));
    document.body.appendChild(overlay);
    renderHead(); renderRail(); renderBody();
}

// RATES_UI_V2 — the % / сум switch. A two-button segment rather than a <select>:
// the active mode is readable without opening anything and switching is one
// click, which matters on a list where every row carries one. When the section
// has no fixed mode it degrades to a plain «%» label, not a dead control.
function segmented(enabled, isFix, onPick, disabled = false) {
    if (!enabled) return h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '%');
    const mk = (label, fix, title) => {
        const b = h('button', { type: 'button', class: isFix() === fix ? 'on' : '', title, disabled });
        b.textContent = label;
        b.addEventListener('click', () => { if (isFix() !== fix) onPick(fix); });
        return b;
    };
    return h('div', { class: 'rt-seg' },
        mk('%',   false, 'Процент от суммы строки после скидки и налога'),   // RATES_MODE_TYPED_V1 (m12)
        mk('сум', true,  'Фиксированная сумма за единицу услуги'));
}

// ---------------------------------------------------------------------------
// Per-service rate table (Услуги и ставки / Вознаграждение) — mirrors easymed.
// emp[arrayKey] = [{ service_id, pct, branches:[ids] }] for the SELECTED services.
// ---------------------------------------------------------------------------
function ratesSection(emp, arrayKey, opts, touch) {
    if (!Array.isArray(emp[arrayKey])) emp[arrayKey] = [];
    let q = '', typeFilter = 'all', kindFilter = '', catFilter = '';   // group · type (clinic's) · category (clinic's)
    const arr = () => emp[arrayKey];
    const idxOf = (sid) => arr().findIndex(r => Number(r.service_id) === Number(sid));
    const nameIn = (rows, id) => (id == null ? '' : ((rows.find(r => String(r.id) === String(id)) || {}).name || ''));
    const visible = () => services.filter(s => (typeFilter === 'all' || svcTypeVal(s) === typeFilter)
        && (!kindFilter || String(s.type_id) === kindFilter)
        && (!catFilter || String(s.category_id) === catFilter)
        && [s.name, nameIn(serviceTypes, s.type_id), nameIn(serviceCategories, s.category_id)].join(' ').toLowerCase().includes(q.toLowerCase()));

    const selBadge = h('span', { class: 'rt-sel' });
    const refreshCount = () => { clear(selBadge); selBadge.append(h('i'), trf('Выбрано: {n}', { n: arr().length })); };

    const scroll = h('div', { class: 'rt-scroll' });
    // RATES_UI_V2 — header and rows share one .rt-row grid (defined once in CSS,
    // so the two cannot drift apart) and the header lives INSIDE the scroller,
    // sticky, so column labels stay visible down a long catalogue.
    // INPATIENT_BONUS_V1 — колонки «Стационар, %» здесь больше нет: ставки
    // стационара — во вкладке «Стационар» (inpatientSection ниже).
    // RATES_HONEST_V1 — колонки «Филиалы» тоже нет (владелец, 30.09: «Remove the
    // column»): расчёт доли и своей цены филиал не читает, а две записи «по
    // филиалам» на одну услугу молча сливались в последнюю (routes/users.js
    // parseRates). Над таблицей — одна строка: ставки действуют во всех филиалах.
    const rowCls = 'rt-row' + (opts.ownPrice ? '' : ' rt-row--noprice');
    const headRow = () => h('div', { class: rowCls + ' rt-head' },
        h('span'), h('span', null, 'Услуга'),
        h('span', { class: 'r' }, opts.ownPrice ? 'Своя цена' : 'Цена'),
        h('span', { class: 'r' }, opts.rateLabel || opts.pctLabel));

    // RATES_HONEST_V1 (ревью 1) — пустой процент платит то, что стоит за ним в
    // расчёте: COALESCE(dr.percent, doc.service_rate_default, 0) (reports.js).
    // Ставку по умолчанию экраны не пишут, но PATCH /api/users её принимает:
    // если она есть — подсказка называет её, нет — «0 % — не задано».
    const dfltPct = Number(emp.service_rate_default) > 0 ? Number(emp.service_rate_default) : 0;
    const emptyHint = () => (dfltPct > 0 ? trf('{n} % — по умолчанию', { n: dfltPct }) : tr('0 % — не задано'));
    const emptyTip = () => (dfltPct > 0
        ? trf('Ставка не задана — врач получает ставку по умолчанию {n} %. Введите процент или сумму.', { n: dfltPct })
        : tr('Ставка не задана — врач за эту услугу получает 0 %. Введите процент или сумму.'));

    // RATES_HONEST_V1 — новая запись несёт ПУСТОЙ список филиалов (прежде при
    // единственном филиале — его, SOLE_BRANCH_V1). У прежних записей branches
    // не трогается: карточка его не показывает, не правит и отдаёт как было.
    const newRate = (sid) => ({ service_id: Number(sid), pct: 0, branches: [] });

    const toggle = (sid) => { const i = idxOf(sid); if (i >= 0) arr().splice(i, 1); else arr().push(newRate(sid)); touch(); refreshCount(); renderRows(); };
    const setPct = (sid, v) => { const i = idxOf(sid); if (i >= 0) { arr()[i].pct = v; touch(); } };
    // DOCTOR_FIX_RATE_V1 — a doctor is paid EITHER a share of the price or a
    // fixed sum per unit. Presence of `fix` is the mode (matching how the server
    // stores it), so the two can never disagree; `pct` is left in place while
    // fixed is active so switching back restores the rate that was there.
    const isFix = (r) => !!opts.allowFix && !!r && r.fix != null;
    const setFix = (sid, v) => { const i = idxOf(sid); if (i >= 0) { arr()[i].fix = v; touch(); } };
    // RATES_MODE_TYPED_V1 — переключатель переносит НАБРАННОЕ число. Аудит:
    // 25 000 в «%», затем «сум» — процент прижимался к 100, а сумма
    // становилась 0 (Number(undefined) || 0): врачу платилось 0, обратный
    // щелчок давал 100 %.
    //   %→сум: сумма = число в поле; процент строки — каким он был при
    //          отрисовке строки (не было — ключа нет, «по умолчанию»).
    //   сум→%: число становится процентом, только если оно не больше 100;
    //          иначе процент — каким он был при отрисовке (или «по умолчанию»).
    // Сумма никогда не превращается в долю 100 %.
    const restorePct = (r, pctAtRender) => { if (pctOk(pctAtRender)) r.pct = Number(pctAtRender); else delete r.pct; };
    const setMode = (sid, mode, boxRaw, pctAtRender) => {
        const i = idxOf(sid); if (i < 0) return;
        const r = arr()[i];
        const raw = String(boxRaw == null ? '' : boxRaw).trim();
        const typed = raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : null;
        if (mode === 'fix') {
            r.fix = typed == null ? 0 : typed;
            restorePct(r, pctAtRender);
        } else {
            delete r.fix;
            if (typed != null && typed <= 100) r.pct = typed;
            else restorePct(r, pctAtRender);
        }
        touch(); renderRows();
    };
    // DOCTOR_OWN_PRICE_V1 — an EMPTY field means "no own price": the key is
    // removed so the invoice falls back to the catalog. A typed 0 is kept as a
    // real price of zero. Never write the catalog price in here as a default —
    // that would silently freeze today's price onto the doctor forever.
    const setOwnPrice = (sid, raw) => {
        const i = idxOf(sid); if (i < 0) return;
        const s = String(raw).trim();
        const n = Number(s);
        if (s === '' || !Number.isFinite(n) || n < 0) delete arr()[i].price;
        else arr()[i].price = n;
        touch();
    };
    const searchInp = h('input', { type: 'text', placeholder: 'Поиск услуг…' });
    searchInp.addEventListener('input', () => { q = searchInp.value; renderRows(); });
    const searchBox = h('div', { class: 'rt-search' },
        h('span', { class: 'rt-search-ic' }, Icon('Search', { size: 14 })), searchInp);
    const typeSel = h('select', { class: 'rt-select', style: { width: 'auto', minWidth: '130px' } }, ...[['all', 'Все группы'], ...SERVICE_TYPES].map(([v, l]) => h('option', { value: v }, l)));   // SVC_VOCAB_V1 — the five are groups
    typeSel.addEventListener('change', () => { typeFilter = typeSel.value; renderRows(); });
    // RATES_FILTERS_V2 — only the types / categories some service actually has,
    // so the lists stay short; empty when the clinic has not written any.
    const usedIds = (key) => new Set(services.map(s => (s[key] == null ? '' : String(s[key]))).filter(Boolean));
    const lookupSel = (rows, key, allLabel, onPick) => {
        const used = usedIds(key);
        const opts = rows.filter(r => used.has(String(r.id)));
        const sel = h('select', { class: 'rt-select', style: { width: 'auto', minWidth: '130px' }, disabled: !opts.length, title: opts.length ? null : tr('У услуг пока не заполнено') },
            h('option', { value: '' }, allLabel),
            ...opts.map(r => h('option', { value: String(r.id) }, r.name)));
        sel.addEventListener('change', () => { onPick(sel.value); renderRows(); });
        return sel;
    };
    const kindSel = lookupSel(serviceTypes, 'type_id', 'Все типы', (v) => { kindFilter = v; });
    const catSel = lookupSel(serviceCategories, 'category_id', 'Все категории', (v) => { catFilter = v; });
    const selAllChk = h('input', { type: 'checkbox' });
    const allOn = () => { const v = visible(); return v.length > 0 && v.every(s => idxOf(s.id) >= 0); };
    selAllChk.addEventListener('change', () => { const want = selAllChk.checked; for (const s of visible()) { const i = idxOf(s.id); if (want && i < 0) arr().push(newRate(s.id)); if (!want && i >= 0) arr().splice(i, 1); } touch(); refreshCount(); renderRows(); });
    // DOCTOR_FIX_RATE_V1 — the bulk setter follows the same two modes, so a
    // whole list can be put on a fixed rate in one go rather than row by row.
    // RATES_UI_V2 — a two-button segment beats a dropdown here: the active mode
    // is legible without opening anything, and switching is one click.
    // RATES_MODE_TYPED_V1 (C1) — поле применяется ТОЛЬКО по Enter или кнопке
    // «Применить», а не на blur. Аудит: 50 000, затем щелчок «сум» — щелчок
    // снимал фокус, поле применялось ещё в режиме «%», прижималось к 100, и
    // каждая отмеченная услуга сохранялась как 100 % под тостом «Сотрудник
    // сохранён». Смена режима ничего не применяет; «%» больше 100 не
    // применяется вовсе — это почти наверняка сумма.
    let bulkFix = false;
    const bulkUnit = h('span', { class: 'rt-unit' }, '%');
    const bulkInp = h('input', { type: 'number', min: '0', max: '100', placeholder: '0', class: 'rt-num',
        style: { width: '104px' }, title: 'Введите ставку и нажмите Enter или «Применить» — применится ко всем отмеченным услугам из списка' });
    const bulkSeg = segmented(opts.allowFix, () => bulkFix, (fix) => {
        bulkFix = fix;
        bulkInp.max = fix ? '' : '100';
        bulkUnit.textContent = fix ? tr('сум') : tr('%');
    });
    const applyBulk = () => {
        const raw = String(bulkInp.value).trim();
        if (raw === '') return;
        const fix = opts.allowFix && bulkFix;
        const n = Math.max(0, Number(raw) || 0);
        if (!fix && n > 100) { toast('Процент не больше 100 — для суммы выберите «сум».', 'fail'); return; }
        const vis = new Set(visible().map(s => Number(s.id)));
        for (const r of arr()) {
            if (!vis.has(Number(r.service_id))) continue;
            // Процент, набранный больше 100, рядом с суммой не остаётся: сервер
            // прижал бы его к 100, и обратный переход дал бы 100 %.
            if (fix) { r.fix = n; if (r.pct != null && !pctOk(r.pct)) delete r.pct; }
            else { delete r.fix; r.pct = n; }
        }
        bulkInp.value = ''; touch(); renderRows();
    };
    bulkInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBulk(); } });
    const bulkApply = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: applyBulk }, 'Применить');

    // DOCTOR_OWN_PRICE_V1 — the price cell. Empty shows the catalog price as a
    // placeholder (that is what will be billed); a typed value is the doctor's
    // OWN price, highlighted and clearable back to the catalog with «×».
    function ownPriceCell(s, r, on) {
        const hasOwn = () => on && r && r.price != null;
        const inp = h('input', {
            type: 'number', min: '0', step: '1000', disabled: !on, class: 'rt-num rt-num--price',
            value: hasOwn() ? String(r.price) : '',
            // The placeholder IS the catalog price — an empty field is not blank,
            // it means "bill what the catalog says", and shows what that is.
            placeholder: fmtPrice(s.price),
        });
        const reset = h('button', { type: 'button', class: 'rt-clear', title: 'Вернуть цену из каталога' }, '×');
        const paintOwn = () => {
            const own = hasOwn();
            inp.classList.toggle('is-own', own);
            inp.title = !on ? tr('Отметьте услугу, чтобы задать свою цену')
                : own ? tr('Своя цена врача — по ней выставляется счёт')
                      : trf('Цена из каталога: {price}. Введите свою, чтобы переопределить.', { price: fmtPrice(s.price) });
            reset.style.visibility = own ? 'visible' : 'hidden';
        };
        // Style updates happen in place (no re-render) so the field keeps focus
        // while the number is being typed.
        inp.addEventListener('input', () => { setOwnPrice(s.id, inp.value); paintOwn(); });
        reset.addEventListener('click', () => { inp.value = ''; setOwnPrice(s.id, ''); paintOwn(); });
        paintOwn();
        return h('div', { class: 'rt-field' }, inp, reset);
    }

    function renderRows() {
        const keep = scroll.scrollTop;
        clear(scroll);
        scroll.appendChild(headRow());
        selAllChk.checked = allOn();
        const list = visible();
        if (!list.length) { scroll.appendChild(h('div', { class: 'rt-empty' }, services.length ? 'Услуги не найдены.' : 'Нет услуг — добавьте их в Настройки → Список услуг.')); return; }
        for (const s of list) {
            const r = arr()[idxOf(s.id)];
            const on = !!r;
            const chk = h('input', { type: 'checkbox', checked: on });
            chk.addEventListener('change', () => toggle(s.id));

            // DOCTOR_FIX_RATE_V1 — mode picker + the value it applies to.
            const fixed = isFix(r);
            // RATES_HONEST_V1 — процента нет: платится users.service_rate_default,
            // а его не пишет ни один экран, то есть обычно 0 % (владелец: «Keep 0,
            // label it honestly»). Подсказка называет то, что заплатит расчёт.
            const noPct = on && !fixed && r.pct == null;
            const rateInp = h('input', {
                type: 'number', min: '0', class: 'rt-num', disabled: !on,
                max: fixed ? null : '100',
                step: fixed ? '1000' : '1',
                // Ревью I5 — процента нет: пустое поле с подсказкой, а не «0».
                value: on ? String(fixed ? r.fix : (r.pct == null ? '' : r.pct)) : '0',
                placeholder: on && !fixed ? emptyHint() : null,   // RATES_HONEST_V1
                title: fixed ? 'Врач получает эту сумму за каждую единицу услуги'
                    : noPct ? emptyTip()   // RATES_HONEST_V1
                        : 'Процент от суммы строки после скидки и налога',   // RATES_MODE_TYPED_V1 (m12)
            });
            // RATES_MODE_TYPED_V1 — процент строки на момент отрисовки: к нему
            // переключатель возвращает строку, если набранное процентом быть не может.
            const pctAtRender = on && r.pct != null ? r.pct : null;
            const modeSeg = segmented(opts.allowFix, () => fixed,
                (wantFix) => setMode(s.id, wantFix ? 'fix' : 'pct', rateInp.value, pctAtRender), !on);
            rateInp.addEventListener('input', () => {
                const n = Number(rateInp.value) || 0;
                if (fixed) setFix(s.id, Math.max(0, n));
                // Стёртый процент — снова «не задано» (ключа pct нет, 0 %).
                else if (String(rateInp.value).trim() === '') { const i = idxOf(s.id); if (i >= 0) { delete arr()[i].pct; touch(); } }
                // RATES_MODE_TYPED_V1 — без тихого зажима в 100: больше 100
                // хранится как набрано, и сохранение откажет (save → overPct).
                else setPct(s.id, Math.max(0, n));
                // RATES_HONEST_V1 — подсказка под мышью следует за полем (без перерисовки: фокус остаётся).
                if (!fixed) rateInp.title = String(rateInp.value).trim() === ''
                    ? emptyTip() : tr('Процент от суммы строки после скидки и налога');
            });

            scroll.appendChild(h('div', { class: rowCls + ' rt-item' + (on ? ' on' : '') },
                chk,
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'rt-name', title: s.name }, s.name),
                    // group · type · category — whichever the service has
                    h('div', { class: 'rt-type' }, [tr(svcTypeLabel(svcTypeVal(s))), nameIn(serviceTypes, s.type_id), nameIn(serviceCategories, s.category_id)].filter(Boolean).join(' · '))),
                opts.ownPrice ? ownPriceCell(s, r, on) : h('div', { class: 'rt-catalog' }, fmtPrice(s.price)),
                h('div', { class: 'rt-rate' },
                    modeSeg,
                    h('div', { class: 'rt-field' }, rateInp, h('span', { class: 'rt-unit' }, fixed ? 'сум' : '%'))),
            ));
        }
        scroll.scrollTop = keep;
    }

    refreshCount();
    const wrap = h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' } },
            h('span', { style: { width: '40px', height: '40px', borderRadius: '11px', background: 'var(--primary-50, #e8f3f2)', color: 'var(--primary-700, #1f7a72)', display: 'grid', placeItems: 'center', flex: '0 0 40px' } }, Icon(opts.icon || 'Layers', { size: 19 })),
            h('div', { style: { flex: 1 } }, h('h2', { style: { margin: 0, fontSize: '17px' } }, opts.title), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, opts.sub)),
            selBadge),
        h('div', { class: 'rt-toolbar' },
            searchBox, typeSel, kindSel, catSel, h('span', { class: 'grow' }),
            h('label', { class: 'rt-selall' }, selAllChk, 'Выбрать все'),
            h('div', { class: 'rt-bulk' },
                h('span', { class: 'muted' }, 'Ставка для всех'),
                bulkSeg,
                h('div', { class: 'rt-field', style: { flex: '0 0 auto' } }, bulkInp, bulkUnit),
                bulkApply)),
        // RATES_HONEST_V1 — вместо колонки «Филиалы».
        h('div', { class: 'muted', style: { fontSize: '12.5px', margin: '0 0 8px' } }, 'Ставки и своя цена действуют во всех филиалах.'),
        h('div', { class: 'rt-box' }, scroll),
    );
    renderRows();
    return wrap;
}

// ---------------------------------------------------------------------------
// INPATIENT_BONUS_V1 — вкладка «Стационар».
//
// Две вещи, и обе — деньги (видны и уходят на сервер только с «Цены и
// проценты», MONEY_SECTIONS / MONEY_KEYS):
//   1. «За направление в стационар» — что врач получает, когда САМ направил
//      пациента на госпитализацию (он «Направивший врач» заявки): % от
//      оплаченного счёта госпитализации (услуги и койко-дни, без медикаментов)
//      и/или фиксированная сумма за госпитализацию. Так же, как у партнёров.
//   2. «Ставки за услуги в стационаре» — доля врача за услугу, оказанную в
//      стационаре: процент либо фиксированная сумма за единицу. Хранится
//      ОТДЕЛЬНО от «Услуг и ставок» (users.inpatient_rates): прежде отметка
//      услуги ради стационарного процента заводила амбулаторную запись 0 %, и
//      та перекрывала ставку по умолчанию.
// emp.inpatient_rates = [{ service_id, pct } | { service_id, fix }].
// ---------------------------------------------------------------------------
function inpatientSection(emp, touch) {
    if (!Array.isArray(emp.inpatient_rates)) emp.inpatient_rates = [];
    const arr = () => emp.inpatient_rates;
    const idxOf = (sid) => arr().findIndex((r) => Number(r.service_id) === Number(sid));
    let q = '', typeFilter = 'all';
    const visible = () => services.filter((s) => (typeFilter === 'all' || svcTypeVal(s) === typeFilter)
        && String(s.name || '').toLowerCase().includes(q.toLowerCase()));
    const hintEl = (t) => h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px', lineHeight: 1.5 } }, t);

    // 1. За направление в стационар.
    const bonusField = (key, unit, max, title) => {
        const inp = h('input', { type: 'number', min: '0', max: max || null, step: max ? '1' : '1000',
            class: 'rt-num rt-num--bonus', value: emp[key] || '', placeholder: '0', title });
        inp.addEventListener('input', () => { emp[key] = inp.value; touch(); });
        return h('div', { class: 'rt-field' }, inp, h('span', { class: 'rt-unit' }, unit));
    };
    const referralBox = h('div', { class: 'card card-pad-sm', style: { marginBottom: '16px' } },
        h('h3', { style: { margin: '0 0 10px', fontSize: '15px' } }, 'За направление в стационар'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px 16px' } },
            field('% от оплаченного счёта госпитализации', bonusField('inpatient_referral_pct', '%', '100',
                tr('Процент от оплаченного счёта госпитализации: услуги и койко-дни, без медикаментов и расходников'))),
            field('Фиксированная сумма за госпитализацию', bonusField('inpatient_referral_fixed', tr('сум'), null,
                tr('Один раз за госпитализацию, когда оплачен её счёт')))),
        hintEl('Платится врачу, указанному в заявке на госпитализацию как направивший, — только с оплаченных счетов госпитализации. Процент — от услуг и койко-дней, без медикаментов и расходников; фиксированная сумма — один раз за госпитализацию. Пусто или 0 — не платится.'));

    // 2. Ставки за услуги в стационаре.
    const selBadge = h('span', { class: 'rt-sel' });
    const refreshCount = () => { clear(selBadge); selBadge.append(h('i'), trf('Выбрано: {n}', { n: arr().length })); };
    const scroll = h('div', { class: 'rt-scroll' });
    const rowCls = 'rt-row rt-row--inpatient';
    const headRow = () => h('div', { class: rowCls + ' rt-head' },
        h('span'), h('span', null, 'Услуга'), h('span', { class: 'r' }, 'Цена'), h('span', { class: 'r' }, 'Ставка в стационаре'));
    const isFix = (r) => !!r && r.fix != null;
    const toggle = (sid) => {
        const i = idxOf(sid);
        if (i >= 0) arr().splice(i, 1); else arr().push({ service_id: Number(sid), pct: 0 });
        touch(); refreshCount(); renderRows();
    };
    // RATES_MODE_TYPED_V1 — то же правило переноса, что в «Услугах и ставках»
    // (там прежний процент лежит в записи рядом с суммой; здесь у записи ровно
    // одна ставка — сервер примет только одну, — поэтому процент строки на
    // время «сум» помнит pctMemo). Прежде переключение обнуляло строку:
    // набранные 25 000 пропадали, обратный щелчок давал 0 %.
    //   %→сум: сумма = число в поле.
    //   сум→%: число — процентом, только если оно не больше 100; иначе прежний
    //          процент строки (до «сум»), а его нет — 0, как у новой отметки.
    const pctMemo = new Map();
    const setMode = (sid, fix, boxRaw, pctAtRender) => {
        const i = idxOf(sid); if (i < 0) return;
        const raw = String(boxRaw == null ? '' : boxRaw).trim();
        const typed = raw !== '' && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : null;
        if (fix) {
            if (pctOk(pctAtRender)) pctMemo.set(Number(sid), Number(pctAtRender));
            arr()[i] = { service_id: Number(sid), fix: typed == null ? 0 : typed };
        } else {
            const back = pctMemo.has(Number(sid)) ? pctMemo.get(Number(sid)) : 0;
            arr()[i] = { service_id: Number(sid), pct: typed != null && typed <= 100 ? typed : back };
        }
        touch(); renderRows();
    };
    const setValue = (sid, raw) => {
        const i = idxOf(sid); if (i < 0) return;
        const n = Number(raw) || 0;
        if (isFix(arr()[i])) arr()[i].fix = Math.max(0, n);
        // RATES_MODE_TYPED_V1 — без тихого зажима: больше 100 хранится как
        // набрано, и сохранение откажет (save → overPct).
        else arr()[i].pct = Math.max(0, n);
        touch();
    };

    const searchInp = h('input', { type: 'text', placeholder: 'Поиск услуг…' });
    searchInp.addEventListener('input', () => { q = searchInp.value; renderRows(); });
    const typeSel = h('select', { class: 'rt-select', style: { width: 'auto', minWidth: '130px' } },
        ...[['all', 'Все группы'], ...SERVICE_TYPES].map(([v, l]) => h('option', { value: v }, l)));
    typeSel.addEventListener('change', () => { typeFilter = typeSel.value; renderRows(); });
    const selAllChk = h('input', { type: 'checkbox' });
    const allOn = () => { const v = visible(); return v.length > 0 && v.every((s) => idxOf(s.id) >= 0); };
    selAllChk.addEventListener('change', () => {
        const want = selAllChk.checked;
        for (const s of visible()) {
            const i = idxOf(s.id);
            if (want && i < 0) arr().push({ service_id: Number(s.id), pct: 0 });
            if (!want && i >= 0) arr().splice(i, 1);
        }
        touch(); refreshCount(); renderRows();
    });
    // Своя «Ставка для всех»: пишет только стационарные ставки отмеченных услуг
    // из списка; амбулаторных не касается.
    // RATES_MODE_TYPED_V1 (C1) — как в «Услугах и ставках»: только Enter или
    // «Применить», не blur; смена режима ничего не применяет; «%» больше 100 —
    // не применяется, а говорит тостом.
    let bulkFix = false;
    const bulkUnit = h('span', { class: 'rt-unit' }, '%');
    const bulkInp = h('input', { type: 'number', min: '0', max: '100', placeholder: '0', class: 'rt-num rt-num--inp-bulk',
        style: { width: '104px' }, title: 'Введите ставку и нажмите Enter или «Применить» — применится ко всем отмеченным услугам из списка' });
    const bulkSeg = segmented(true, () => bulkFix, (fix) => {
        bulkFix = fix;
        bulkInp.max = fix ? '' : '100';
        bulkUnit.textContent = fix ? tr('сум') : tr('%');
    });
    const applyBulk = () => {
        const raw = String(bulkInp.value).trim();
        if (raw === '') return;
        const n = Math.max(0, Number(raw) || 0);
        if (!bulkFix && n > 100) { toast('Процент не больше 100 — для суммы выберите «сум».', 'fail'); return; }
        const vis = new Set(visible().map((s) => Number(s.id)));
        for (let i = 0; i < arr().length; i += 1) {
            const sid = Number(arr()[i].service_id);
            if (!vis.has(sid)) continue;
            arr()[i] = bulkFix ? { service_id: sid, fix: n } : { service_id: sid, pct: n };
        }
        bulkInp.value = ''; touch(); renderRows();
    };
    bulkInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBulk(); } });
    const bulkApply = h('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: applyBulk }, 'Применить');

    function renderRows() {
        const keep = scroll.scrollTop;
        clear(scroll);
        scroll.appendChild(headRow());
        selAllChk.checked = allOn();
        const list = visible();
        if (!list.length) { scroll.appendChild(h('div', { class: 'rt-empty' }, services.length ? 'Услуги не найдены.' : 'Нет услуг — добавьте их в Настройки → Список услуг.')); return; }
        for (const s of list) {
            const r = arr()[idxOf(s.id)];
            const on = !!r;
            const chk = h('input', { type: 'checkbox', checked: on });
            chk.addEventListener('change', () => toggle(s.id));
            const fixed = isFix(r);
            const rateInp = h('input', {
                type: 'number', min: '0', class: 'rt-num rt-num--inp', disabled: !on,
                max: fixed ? null : '100', step: fixed ? '1000' : '1',
                value: on ? String(fixed ? r.fix : r.pct) : '',
                placeholder: on ? '0' : '—',
                title: !on ? tr('Отметьте услугу, чтобы задать ставку')
                    : tr('Доля врача за услугу в стационаре: исполнителю, иначе назначившему. Процент — от суммы после скидки и налога, сумма — за единицу.'),
            });
            // RATES_MODE_TYPED_V1 — набранное число и процент строки на момент отрисовки.
            const pctAtRender = on && !fixed ? r.pct : null;
            const modeSeg = segmented(true, () => fixed, (wantFix) => setMode(s.id, wantFix, rateInp.value, pctAtRender), !on);
            rateInp.addEventListener('input', () => setValue(s.id, rateInp.value));
            scroll.appendChild(h('div', { class: rowCls + ' rt-item' + (on ? ' on' : '') },
                chk,
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'rt-name', title: s.name }, s.name),
                    h('div', { class: 'rt-type' }, tr(svcTypeLabel(svcTypeVal(s))))),
                h('div', { class: 'rt-catalog' }, fmtPrice(s.price)),
                h('div', { class: 'rt-rate' }, modeSeg,
                    h('div', { class: 'rt-field' }, rateInp, h('span', { class: 'rt-unit' }, fixed ? 'сум' : '%'))),
            ));
        }
        scroll.scrollTop = keep;
    }

    refreshCount();
    const wrap = h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' } },
            h('span', { style: { width: '40px', height: '40px', borderRadius: '11px', background: 'var(--primary-50, #e8f3f2)', color: 'var(--primary-700, #1f7a72)', display: 'grid', placeItems: 'center', flex: '0 0 40px' } }, Icon('Bed', { size: 19 })),
            h('div', { style: { flex: 1 } }, h('h2', { style: { margin: 0, fontSize: '17px' } }, 'Стационар'),
                h('div', { class: 'muted', style: { fontSize: '12.5px' } }, 'Ставки за услуги в стационаре и вознаграждение за направление пациента в стационар. Хранятся отдельно от «Услуг и ставок».'))),
        referralBox,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', margin: '4px 0 10px' } },
            h('h3', { style: { margin: 0, fontSize: '15px', flex: 1 } }, 'Ставки за услуги в стационаре'), selBadge),
        h('div', { class: 'rt-toolbar' },
            h('div', { class: 'rt-search' }, h('span', { class: 'rt-search-ic' }, Icon('Search', { size: 14 })), searchInp),
            typeSel, h('span', { class: 'grow' }),
            h('label', { class: 'rt-selall' }, selAllChk, 'Выбрать все'),
            h('div', { class: 'rt-bulk' },
                h('span', { class: 'muted' }, 'Ставка для всех'),
                bulkSeg,
                h('div', { class: 'rt-field', style: { flex: '0 0 auto' } }, bulkInp, bulkUnit),
                bulkApply)),
        h('div', { class: 'rt-box' }, scroll),
        hintEl('Отмеченная услуга без введённой ставки — 0: это решение, а не «не задано». Неотмеченная — стационарной доли нет. Ставка в стационаре не меняет амбулаторную ставку и ставку по умолчанию.'),
    );
    renderRows();
    return wrap;
}

function buildHours(emp, markDirty) {
    // BRANCH_PROFILE_V1 — сетка вынесена в week-hours.js (её же берут «Филиалы»).
    // Пишется, как и прежде, тронутый день поверх прежнего графика.
    return weekHoursGrid(emp.working_hours, {
        onChange: (key, entry) => markDirty({ working_hours: { ...emp.working_hours, [key]: entry } }),
    }).node;
}

function depName(id) { const d = departments.find(x => String(x.id) === String(id)); return d ? d.name : ''; }
function chip(text) { return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12.5px', padding: '2px 8px', borderRadius: '20px', background: 'var(--ink-50, #f1f2f4)', color: 'var(--ink-600)' } }, text); }
