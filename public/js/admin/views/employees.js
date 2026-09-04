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
import { phoneInput } from '../phone-input.js?v=ph1';
import { importExportButtons } from './section-import-export.js?v=aug17e';   // DATA_TRANSFER_V1
import { soleBranchId } from '../branch-context.js?v=bc3';                  // SOLE_BRANCH_V1
import { specialtyOptions } from '../specialties.js?v=spec1';               // SPECIALTY_LIST_V1

const ROLES = [
    ['registrar', 'Регистратор'], ['doctor', 'Врач'], ['nurse', 'Медсестра'],
    ['cashier', 'Кассир'], ['lab', 'Лаборант'], ['inventory', 'Склад'],
    ['callcenter', 'Колл-центр'],   // CALLCENTER_ROLE_V1
    ['admin', 'Администратор'],
];
const STAFF_TYPES = [['doctor', 'Врачи'], ['admin_staff', 'Административный персонал'], ['mid_low', 'Средний и младший персонал']];
const DOCTOR_CATEGORIES = [['', '—'], ['highest', 'Высшая'], ['first', 'Первая'], ['second', 'Вторая'], ['none', 'Без категории']];
const EMPLOYMENT_TYPES = [['', '—'], ['official', 'Официально'], ['civil_law', 'ГПХ (договор)'], ['unofficial', 'Неофициально']];
const SALARY_TYPES = [['', '—'], ['fixed', 'Оклад'], ['percentage', 'Процент от выручки'], ['fix_plus_kpi', 'Оклад + KPI']];
const DAYS = [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']];
const roleLabel = (r) => (ROLES.find(x => x[0] === r) || [r, r])[1];
// STAFF_SYNC_V1 (миграция 086) — сотрудника завела главная клиника, и этот
// экран его только показывает. Сравнение именно с false: установка старой
// версии ключа не присылает вовсе, и «неизвестно» обязано значить «свой», иначе
// клиника из одного здания после обновления нашла бы весь свой ростер
// нередактируемым.
const fromMain = (u) => !!u && u.is_local === false;
const staffLabel = (s) => (STAFF_TYPES.find(x => x[0] === s) || ['', 'Не выбрана'])[1];
// Routing type (раздел) — the fixed easymed set (mirrors services.js).
const SERVICE_TYPES = [['imaging', 'Диагностика'], ['radiology', 'Лучевая диагностика'], ['consultation', 'Консультации'], ['lab', 'Лаборатория'], ['procedure', 'Процедуры'], ['other', 'Хирургия']];
const svcTypeVal = (s) => s.type || (s.is_lab ? 'lab' : 'consultation');
const svcTypeLabel = (v) => (SERVICE_TYPES.find(t => t[0] === v) || [v, v])[1];
function fmtPrice(n) { const v = Math.round(Number(n) || 0); return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

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

export async function renderEmployees(container) {
    clear(container);
    showArchive = false;   // вход в раздел — всегда со списка работающих
    const root = h('div', { class: 'fade-in' });
    container.appendChild(root);
    await paint(root);
}

async function paint(root) {
    clear(root);
    // EMP_ARCHIVE_V1 — переключатель «Архив». Живёт в шапке рядом с «Новый
    // сотрудник»: это не фильтр таблицы, а другой список.
    const archiveBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Архив');
    root.appendChild(h('div', { class: 'page-head' },
        h('div', null,
            h('h1', { class: 'page-title' }, 'Сотрудники'),
            h('p', { class: 'page-subtitle' }, 'Staff roster — employees, doctors, nurses, reception, admin.'),
        ),
        // DATA_TRANSFER_V1 — Шаблон / Импорт / Экспорт for the staff roster.
        // Export omits passwords (the API never returns them), so re-importing
        // an exported file updates people without resetting their logins.
        h('div', { class: 'page-head-actions' },
            ...importExportButtons({
                sectionKey:   'users',
                filenameStem: 'employees',
                fetchRows:    async () => (await api('')).users || [],
                onImported:   () => paint(root),
            }),
            archiveBtn,
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openEditor(null, root) }, Icon('Plus', { size: 14 }), ' Новый сотрудник')),
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
        h('table', { class: 'tbl' },
            h('thead', null,
                h('tr', null, h('th', null, 'Имя'), h('th', null, 'Категория'), h('th', null, 'Роль'), h('th', null, 'Телефон'), h('th', null, 'Статус'), h('th', null, '')),
                h('tr', { class: 'filter-row', style: { background: 'var(--ink-25, #f6f8f9)' } },
                    h('th', null, nameFlt), h('th', null, staffFlt), h('th', null, roleFlt),
                    h('th', null, phoneFlt), h('th', null),
                    h('th', { style: { textAlign: 'right' } }, resetBtn)),
            ),
            tbody),
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
            tbody.appendChild(h('tr', null, h('td', { colspan: '6', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, why)));
            return;
        }
        for (const u of rows) {
            const openBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, 'Открыть');
            // Кнопки «Вернуть» у сотрудника главной клиники нет: сервер ответил
            // бы отказом (routes/users.js), а кнопка, которая всегда ругается, —
            // хуже отсутствующей. Вернуть его на работу можно там же, где его
            // отключили.
            const backBtn = (!showArchive || fromMain(u)) ? null : h('button', {
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
                h('td', null, roleLabel(u.role)),
                h('td', null, u.phone || '—'),
                h('td', null, u.is_active ? h('span', { style: { color: 'var(--ok-700, #1a7a44)', fontWeight: 600, fontSize: '12.5px' } }, '● Активен') : h('span', { class: 'muted', style: { fontSize: '12.5px' } }, '○ Неактивен')),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } }, backBtn, openBtn),
            ));
        }
    }

    archiveBtn.addEventListener('click', () => { showArchive = !showArchive; renderRows(); });

    tbody.appendChild(h('tr', null, h('td', { colspan: '6', style: { textAlign: 'center', padding: '20px', color: 'var(--ink-500)' } }, 'Загрузка…')));
    try {
        if (!departments.length || !branches.length || !services.length) {
            const [dep, br, sv] = await Promise.all([
                supabase.from('departments').select('id, name').eq('active', 1).order('name'),
                supabase.from('branches').select('id, name').eq('active', 1).order('name'),
                supabase.from('services').select('id, name, price, is_lab, type').eq('active', 1).order('name').limit(1000),
            ]);
            departments = dep.data || []; branches = br.data || []; services = sv.data || [];
        }
        const { users } = await api('');
        allUsers = users || [];
        renderRows();
    } catch (e) {
        clear(tbody);
        tbody.appendChild(h('tr', null, h('td', { colspan: '6', style: { textAlign: 'center', padding: '18px', color: 'var(--crit-600)' } }, trf('Ошибка: {msg}', { msg: e.message || e }))));
    }
}

// Sections marked doctorOnly appear in the rail ONLY when category = «Врачи».
const SECTIONS = [
    { group: 'ПРОФИЛЬ', items: [
        { key: 'personal', label: 'Личные данные', icon: 'ID',          required: ['last_name', 'first_name', 'phone'] },
        { key: 'job',      label: 'Должность',      icon: 'Stethoscope', required: ['staff_type'] },
        { key: 'license',  label: 'Лицензия',       icon: 'Doc',         required: [], doctorOnly: true },
    ] },
    { group: 'РАБОТА', items: [
        { key: 'branches', label: 'Филиалы',              icon: 'Building', required: [] },
        { key: 'salary',   label: 'Занятость и зарплата', icon: 'Coins',    required: [] },
        { key: 'schedule', label: 'Рабочее время',        icon: 'Clock',    required: [] },
        { key: 'services', label: 'Услуги и ставки',      icon: 'Layers',   required: [], doctorOnly: true },
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
const OPTIONAL_RATE_KEYS = ['price', 'fix', 'fixed'];
const loadRates = (list) => asArr(list).map((r) => {
    const out = { service_id: r.service_id, pct: Number(r.pct) || 0, branches: asArr(r.branches) };
    for (const k of OPTIONAL_RATE_KEYS) if (r[k] != null) out[k] = Number(r[k]);
    return out;
});

function openEditor(user, root) {
    const isEdit = !!user;
    const emp = {
        last_name: '', first_name: '', middle_name: '', phone: '', email: '',
        staff_type: '', scheduling_mode: 'schedulable', department_id: '', is_doctor: false,
        specialty: '', doctor_category: '', hire_date: '', license_number: '', license_expiry_date: '',
        branch_id: '', employment_type: '', salary_type: '', salary_fixed: '', salary_percent: '',
        working_hours: {}, service_rates: [], referral_rates: [],
        username: '', password: '', role: 'registrar', extra_roles: [], is_active: true,
        // SOLE_BRANCH_V1 — филиал в клинике один: подставляем его сразу, чтобы
        // раздел «Филиалы» не требовал выбора там, где выбирать не из чего.
        // У существующего сотрудника ниже победит его собственное значение.
        ...(soleBranchId() != null ? { branch_id: String(soleBranchId()) } : {}),
        ...(user ? {
            last_name: user.last_name || '', first_name: user.first_name || '', middle_name: user.middle_name || '',
            phone: user.phone || '', email: user.email || '',
            staff_type: user.staff_type || (user.is_doctor ? 'doctor' : ''), scheduling_mode: user.scheduling_mode || 'schedulable',
            department_id: user.department_id != null ? String(user.department_id) : '',
            is_doctor: !!user.is_doctor, specialty: user.specialty || '', doctor_category: user.doctor_category || '', hire_date: user.hire_date || '',
            license_number: user.license_number || '', license_expiry_date: user.license_expiry_date || '',
            // SOLE_BRANCH_V1 — у давнего сотрудника филиал мог не проставиться:
            // при единственном филиале подставляем его, а не пустое «—».
            branch_id: user.branch_id != null ? String(user.branch_id)
                : (soleBranchId() != null ? String(soleBranchId()) : ''),
            employment_type: user.employment_type || '', salary_type: user.salary_type || '',
            salary_fixed: user.salary_fixed ? String(user.salary_fixed) : '', salary_percent: user.salary_percent ? String(user.salary_percent) : '',
            working_hours: parseHours(user.working_hours),
            service_rates: loadRates(user.service_rates),
            referral_rates: loadRates(user.referral_rates),
            username: user.username || '', role: user.role || 'registrar',
            extra_roles: asArr(user.extra_roles).slice(), is_active: !!user.is_active,
        } : {}),
    };
    let active = 'personal';
    let dirty = false;
    // STAFF_SYNC_V1 — карточка сотрудника, приехавшего из главной клиники,
    // ОТКРЫВАЕТСЯ, но не правится. Открывается — потому что филиалу нужно
    // видеть телефон врача и его специальность; не правится — потому что
    // правка дожила бы до ближайшей синхронизации и молча откатилась (сервер
    // отвечает на неё 409, см. routes/users.js). Свой сотрудник филиала —
    // is_local = 1 — правится как раньше, и на главной клинике таких строк нет
    // вовсе, поэтому там этот экран не меняется ничем.
    const readOnly = fromMain(user);

    const overlay = h('div', { class: 'modal' });
    const close = () => overlay.remove();
    overlay.appendChild(h('div', { class: 'modal-backdrop', onclick: close }));

    const rail = h('div', { style: { width: '230px', flex: '0 0 230px', borderRight: '1px solid var(--ink-100)', padding: '10px 8px', overflowY: 'auto' } });
    const body = h('div', { style: { flex: 1, minWidth: 0, padding: '18px 22px', overflowY: 'auto' } });
    const ringWrap = h('div', { style: { textAlign: 'center' } });
    const headWrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 } });
    const dirtyEl = h('span', { class: 'muted', style: { fontSize: '12.5px' } });

    const railSections = () => ALL_SECTIONS.filter(s => !s.doctorOnly || emp.is_doctor);
    function reqFilled(f) { if (f === 'password') return isEdit || !!String(emp.password).trim(); return String(emp[f] != null ? emp[f] : '').trim() !== ''; }
    function sectionComplete(sec) { const req = sec.key === 'access' ? (isEdit ? sec.required : sec.required.concat('password')) : sec.required; return req.every(reqFilled); }
    function completionPct() { const all = railSections().flatMap(s => (s.key === 'access' && !isEdit) ? s.required.concat('password') : s.required); if (!all.length) return 100; return Math.round(all.filter(reqFilled).length / all.length * 100); }
    function touch() { dirty = true; dirtyEl.textContent = tr('● Есть несохранённые изменения'); }
    function markDirty(patch) { if (readOnly) return; Object.assign(emp, patch); touch(); renderRail(); renderHead(); }

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
                [emp.specialty, staffLabel(emp.staff_type)].filter(Boolean).join(' · ')),
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

    const txt = (key, ph) => { const i = h('input', { type: 'text', value: emp[key] || '', placeholder: ph || '' }); i.addEventListener('input', () => markDirty({ [key]: i.value })); return i; };
    // PHONE_INPUT_V1 — same country-code control as patient registration; the
    // wrapper's 'input' bubbles from the real field, and .value reads '' while
    // only the «+998» default is showing.
    const phonef = (key, ph) => { const w = phoneInput(key, ph, { value: emp[key] }); w.addEventListener('input', () => markDirty({ [key]: w.value })); return w; };
    const numf = (key, ph) => { const i = h('input', { type: 'number', min: '0', step: '1', value: emp[key] || '', placeholder: ph || '' }); i.addEventListener('input', () => markDirty({ [key]: i.value })); return i; };
    const datef = (key) => { const i = h('input', { type: 'date', value: (emp[key] || '').slice(0, 10) }); i.addEventListener('input', () => markDirty({ [key]: i.value })); return i; };
    const sel = (key, opts, onset) => { const s = h('select', null, ...opts.map(([v, l]) => h('option', { value: v, selected: String(emp[key]) === String(v) }, l))); s.addEventListener('change', () => onset ? onset(s.value) : markDirty({ [key]: s.value })); return s; };

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

    function renderBody() {
        clear(body);
        if (readOnly) body.appendChild(managedNote());
        const sec = ALL_SECTIONS.find(s => s.key === active) || ALL_SECTIONS[0];
        const head = (title, sub, right) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' } },
            h('span', { style: { width: '40px', height: '40px', borderRadius: '11px', background: 'var(--primary-50, #e8f3f2)', color: 'var(--primary-700, #1f7a72)', display: 'grid', placeItems: 'center', flex: '0 0 40px' } }, Icon(sec.icon, { size: 19 })),
            h('div', { style: { flex: 1 } }, h('h2', { style: { margin: 0, fontSize: '17px' } }, title), h('div', { class: 'muted', style: { fontSize: '12.5px' } }, sub)),
            right || null);
        const grid = (...els) => h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px' } }, ...els.filter(Boolean));
        const hint = (t) => h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '6px', lineHeight: 1.5 } }, t);

        if (active === 'personal') {
            body.append(head('Личные данные', 'Личные и контактные данные сотрудника.'),
                grid(field('Фамилия', txt('last_name', 'Каюмов'), { required: true }), field('Имя', txt('first_name', 'Араббек'), { required: true }),
                    field('Отчество', txt('middle_name', 'Акмалович')), field('Телефон', phonef('phone', '+998 90 961 00 04'), { required: true }), field('Email', txt('email', 'name@example.uz'))));
        } else if (active === 'job') {
            body.append(head('Должность', 'Роль, отдел и должность в клинике.'),
                field('Категория сотрудника', sel('staff_type', [['', 'Выберите категорию…']].concat(STAFF_TYPES), pickCategory), { required: true }),
                hint('Врачи получают роль доступа «Врач», попадают в список врачей клиники, и для них открываются разделы Лицензия / Услуги и ставки / Вознаграждение за направления.'),
                emp.is_doctor ? h('div', { style: { marginTop: '14px' } }, field('Приём услуг', sel('scheduling_mode', [['schedulable', 'По записи (расписание)'], ['live_queue', 'Живая очередь']])),
                    hint('«По записи» — регистратор выбирает дату и время. «Живая очередь» — визит создаётся без времени.')) : null,
                // SPECIALTY_LIST_V1 — «Должность» (свободный текст) убрана: она
                // дублировала категорию сотрудника и специальность, но ничем не
                // управляла и нигде, кроме шапки карточки, не показывалась.
                // «Специальность» — теперь список, чтобы одна и та же
                // специальность не приезжала в трёх написаниях.
                h('div', { style: { marginTop: '14px' } }, grid(
                    field('Отдел', sel('department_id', [['', '—']].concat(departments.map(d => [String(d.id), d.name])))),
                    field('Специальность', sel('specialty', specialtyOptions(emp.specialty))), field('Дата приёма', datef('hire_date')),
                    emp.is_doctor ? field('Категория врача', sel('doctor_category', DOCTOR_CATEGORIES)) : null)));
        } else if (active === 'license') {
            body.append(head('Лицензия', 'Медицинская лицензия сотрудника.'), grid(field('Номер лицензии', txt('license_number', 'AA-000000')), field('Действует до', datef('license_expiry_date'))));
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
            body.append(ratesSection(emp, 'service_rates', { icon: sec.icon, title: 'Услуги и ставки', sub: 'Сколько врач получает за оказанную услугу: процент от суммы после скидки либо фиксированная сумма за единицу. Своя цена — если этот врач берёт за услугу не как в каталоге; пусто = цена каталога.', rateLabel: 'Ставка врача', allowFix: true, ownPrice: true }, touch));
        } else if (active === 'referral') {
            // No fixed-sum mode here: referral payouts are computed from the
            // «Реферальное вознаграждение» table by source name (see
            // referralsReport in server/services/rpc/reports.js) and never read
            // users.referral_rates, so a fixed field would pay nobody.
            body.append(ratesSection(emp, 'referral_rates', { icon: sec.icon, title: 'Вознаграждение за направления', sub: '% от стоимости услуг, на которые врач направил пациента.', pctLabel: '% направления' }, touch));
        } else if (active === 'access') {
            const roleSel = sel('role', ROLES.map(r => [r[0], r[1]]), (v) => { markDirty({ role: v, extra_roles: (emp.extra_roles || []).filter(r => r !== v) }); renderBody(); });
            const extraRoles = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
            for (const [rk, rl] of ROLES) {
                if (rk === emp.role) continue;
                const on = (emp.extra_roles || []).includes(rk);
                const c = h('input', { type: 'checkbox', checked: on });
                c.addEventListener('change', () => { const set = new Set(emp.extra_roles || []); c.checked ? set.add(rk) : set.delete(rk); markDirty({ extra_roles: [...set].filter(r => r !== emp.role) }); });
                extraRoles.appendChild(h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', padding: '5px 10px', border: '1px solid ' + (on ? 'var(--primary-300, #9fd0cb)' : 'var(--ink-100)'), borderRadius: '20px', cursor: 'pointer', background: on ? 'var(--primary-50, #e8f3f2)' : 'transparent' } }, c, rl));
            }
            body.append(head('Вход и доступ', 'Логин, пароль и роли доступа. Каждый сотрудник входит в систему.'),
                grid(field('Логин', (() => { const i = h('input', { type: 'text', value: emp.username, placeholder: 'login', disabled: isEdit }); i.addEventListener('input', () => markDirty({ username: i.value })); return i; })(), { required: true }),
                    field('Основная роль', roleSel, { required: true }),
                    field(isEdit ? 'Новый пароль (пусто — не менять)' : 'Пароль', (() => { const i = h('input', { type: 'password', value: '', placeholder: '••••••••' }); i.addEventListener('input', () => markDirty({ password: i.value })); return i; })(), { required: !isEdit })),
                h('div', { style: { marginTop: '14px' } }, h('div', { style: { fontSize: '13.5px', fontWeight: 600, marginBottom: '7px' } }, 'Дополнительные роли'), extraRoles,
                    hint('Сотруднику открывается объединение разделов всех его ролей. Права на данные определяются основной ролью.')),
                h('div', { style: { marginTop: '12px' } }, checkField('Активен', (() => { const c = h('input', { type: 'checkbox', checked: emp.is_active }); c.addEventListener('change', () => markDirty({ is_active: c.checked })); return c; })())),
                isEdit ? null : hint('Логин 3–30 символов (латиница, цифры, . _ -). Пароль от 8 символов.'));
        }
        if (readOnly) disableAll(body);
    }

    const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, Icon('Check', { size: 14 }), ' Сохранить сотрудника');
    saveBtn.addEventListener('click', save);

    // STAFF_DELETE_V1 — removal, but only for an account with no history behind
    // it. Anyone who has seen a patient, taken money or signed a document stays
    // on the roster (deactivated), because their name is what those records
    // point at. The server decides; this asks first so the dialog can say which
    // of the two is actually on offer.
    const deleteBtn = isEdit
        ? h('button', { class: 'btn btn-danger', type: 'button', onclick: confirmDelete },
            Icon('Trash', { size: 14 }), ' Удалить')
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
        for (const f of ['last_name', 'first_name', 'phone']) if (!String(emp[f]).trim()) { active = 'personal'; renderRail(); renderBody(); toast('Заполните личные данные.', 'fail'); return; }
        if (!emp.staff_type) { active = 'job'; renderRail(); renderBody(); toast('Выберите категорию сотрудника.', 'fail'); return; }
        if (!String(emp.username).trim() || (!isEdit && !String(emp.password).trim())) { active = 'access'; renderRail(); renderBody(); toast('Заполните логин и пароль.', 'fail'); return; }

        const payload = {
            last_name: emp.last_name.trim(), first_name: emp.first_name.trim(), middle_name: emp.middle_name.trim(),
            phone: emp.phone.trim(), email: emp.email.trim(), staff_type: emp.staff_type, scheduling_mode: emp.scheduling_mode || 'schedulable',
            // `position` is deliberately NOT sent: the field is gone from the UI,
            // and PATCH only writes keys it receives, so any value an existing
            // record already carries is left untouched rather than blanked.
            department_id: emp.department_id ? Number(emp.department_id) : null,
            specialty: emp.specialty.trim(), doctor_category: emp.doctor_category || '', hire_date: emp.hire_date || '',
            license_number: emp.license_number.trim(), license_expiry_date: emp.license_expiry_date || '',
            branch_id: emp.branch_id ? Number(emp.branch_id) : null, employment_type: emp.employment_type || '', salary_type: emp.salary_type || '',
            salary_fixed: Number(emp.salary_fixed) || 0, salary_percent: Number(emp.salary_percent) || 0, working_hours: JSON.stringify(emp.working_hours || {}),
            service_rates: asArr(emp.service_rates), referral_rates: asArr(emp.referral_rates),
            role: emp.role, extra_roles: (emp.extra_roles || []).filter(r => r !== emp.role), is_active: !!emp.is_active,
        };
        if (String(emp.password).trim()) payload.password = emp.password;

        saveBtn.disabled = true; const prev = saveBtn.textContent; saveBtn.textContent = tr('Сохранение…');
        try {
            if (isEdit) await api('/' + user.id, { method: 'PATCH', body: JSON.stringify(payload) });
            else await api('', { method: 'POST', body: JSON.stringify({ ...payload, username: emp.username.trim() }) });
            toast('Сотрудник сохранён', 'ok'); close(); await paint(root);
        } catch (e) { toast(e.message || 'Не удалось сохранить.', 'fail'); saveBtn.disabled = false; saveBtn.textContent = prev; }
    }

    overlay.appendChild(h('div', { class: 'modal-card', style: { width: '960px', maxWidth: 'calc(100vw - 32px)', height: 'min(90vh, 780px)', display: 'flex', flexDirection: 'column' } },
        h('header', { class: 'modal-head', style: { alignItems: 'center' } }, headWrap, ringWrap, h('button', { class: 'modal-close', onclick: close }, '×')),
        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } }, rail, body),
        // Кнопок «Сохранить» и «Удалить» у карточки главной клиники нет вовсе —
        // не отключённых, а отсутствующих: отключённая кнопка предлагает
        // действие и молчит о том, почему оно недоступно, а причина уже сказана
        // строкой над полями.
        h('footer', { class: 'modal-foot' }, readOnly ? null : deleteBtn, dirtyEl, h('span', { class: 'grow' }), h('button', { class: 'btn', type: 'button', onclick: close }, readOnly ? 'Закрыть' : 'Отмена'), readOnly ? null : saveBtn),
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
        mk('%',   false, 'Процент от суммы строки после скидки'),
        mk('сум', true,  'Фиксированная сумма за единицу услуги'));
}

// ---------------------------------------------------------------------------
// Per-service rate table (Услуги и ставки / Вознаграждение) — mirrors easymed.
// emp[arrayKey] = [{ service_id, pct, branches:[ids] }] for the SELECTED services.
// ---------------------------------------------------------------------------
function ratesSection(emp, arrayKey, opts, touch) {
    if (!Array.isArray(emp[arrayKey])) emp[arrayKey] = [];
    let q = '', typeFilter = 'all';
    const arr = () => emp[arrayKey];
    const idxOf = (sid) => arr().findIndex(r => Number(r.service_id) === Number(sid));
    const visible = () => services.filter(s => (typeFilter === 'all' || svcTypeVal(s) === typeFilter) && s.name.toLowerCase().includes(q.toLowerCase()));

    const selBadge = h('span', { class: 'rt-sel' });
    const refreshCount = () => { clear(selBadge); selBadge.append(h('i'), trf('Выбрано: {n}', { n: arr().length })); };

    const scroll = h('div', { class: 'rt-scroll' });
    // RATES_UI_V2 — header and rows share one .rt-row grid (defined once in CSS,
    // so the two cannot drift apart) and the header lives INSIDE the scroller,
    // sticky, so column labels stay visible down a long catalogue.
    const rowCls = 'rt-row' + (opts.ownPrice ? '' : ' rt-row--noprice');
    const headRow = () => h('div', { class: rowCls + ' rt-head' },
        h('span'), h('span', null, 'Услуга'), h('span', null, 'Филиалы'),
        h('span', { class: 'r' }, opts.ownPrice ? 'Своя цена' : 'Цена'),
        h('span', { class: 'r' }, opts.rateLabel || opts.pctLabel));

    // SOLE_BRANCH_V1 — филиал в клинике один: «Все филиалы» и он же — одно и то
    // же, поэтому новая строка ставки сразу привязана к нему, а не к пустому
    // списку. При нескольких филиалах поведение прежнее: пусто = все.
    const soleBranch = () => (branches.length === 1 ? branches[0] : null);
    const newRate = (sid) => ({
        service_id: Number(sid), pct: 0,
        branches: soleBranch() ? [Number(soleBranch().id)] : [],
    });

    const toggle = (sid) => { const i = idxOf(sid); if (i >= 0) arr().splice(i, 1); else arr().push(newRate(sid)); touch(); refreshCount(); renderRows(); };
    const setPct = (sid, v) => { const i = idxOf(sid); if (i >= 0) { arr()[i].pct = v; touch(); } };
    // DOCTOR_FIX_RATE_V1 — a doctor is paid EITHER a share of the price or a
    // fixed sum per unit. Presence of `fix` is the mode (matching how the server
    // stores it), so the two can never disagree; `pct` is left in place while
    // fixed is active so switching back restores the rate that was there.
    const isFix = (r) => !!opts.allowFix && !!r && r.fix != null;
    const setFix = (sid, v) => { const i = idxOf(sid); if (i >= 0) { arr()[i].fix = v; touch(); } };
    const setMode = (sid, mode) => {
        const i = idxOf(sid); if (i < 0) return;
        if (mode === 'fix') arr()[i].fix = Number(arr()[i].fix) || 0;
        else delete arr()[i].fix;
        touch(); renderRows();
    };
    const setBranches = (sid, v) => { const i = idxOf(sid); if (i >= 0) { arr()[i].branches = v; touch(); } };
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
    const typeSel = h('select', { class: 'rt-select', style: { width: 'auto', minWidth: '150px' } }, ...[['all', 'Все типы'], ...SERVICE_TYPES].map(([v, l]) => h('option', { value: v }, l)));
    typeSel.addEventListener('change', () => { typeFilter = typeSel.value; renderRows(); });
    const selAllChk = h('input', { type: 'checkbox' });
    const allOn = () => { const v = visible(); return v.length > 0 && v.every(s => idxOf(s.id) >= 0); };
    selAllChk.addEventListener('change', () => { const want = selAllChk.checked; for (const s of visible()) { const i = idxOf(s.id); if (want && i < 0) arr().push(newRate(s.id)); if (!want && i >= 0) arr().splice(i, 1); } touch(); refreshCount(); renderRows(); });
    // DOCTOR_FIX_RATE_V1 — the bulk setter follows the same two modes, so a
    // whole list can be put on a fixed rate in one go rather than row by row.
    // RATES_UI_V2 — a two-button segment beats a dropdown here: the active mode
    // is legible without opening anything, and switching is one click.
    let bulkFix = false;
    const bulkUnit = h('span', { class: 'rt-unit' }, '%');
    const bulkInp = h('input', { type: 'number', min: '0', max: '100', placeholder: '0', class: 'rt-num',
        style: { width: '104px' }, title: 'Введите ставку и нажмите Enter — применится ко всем отмеченным услугам из списка' });
    const bulkSeg = segmented(opts.allowFix, () => bulkFix, (fix) => {
        bulkFix = fix;
        bulkInp.max = fix ? '' : '100';
        bulkUnit.textContent = fix ? tr('сум') : tr('%');
    });
    const applyBulk = () => {
        const raw = String(bulkInp.value).trim();
        if (raw === '') return;
        const fix = opts.allowFix && bulkFix;
        const n = fix ? Math.max(0, Number(raw) || 0) : Math.min(100, Math.max(0, Number(raw) || 0));
        const vis = new Set(visible().map(s => Number(s.id)));
        for (const r of arr()) {
            if (!vis.has(Number(r.service_id))) continue;
            if (fix) r.fix = n;
            else { delete r.fix; r.pct = n; }
        }
        bulkInp.value = ''; touch(); renderRows();
    };
    bulkInp.addEventListener('blur', applyBulk);
    bulkInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBulk(); } });

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
            // SOLE_BRANCH_V1 — при единственном филиале «Все филиалы» — это он же:
            // второй пункт только путал бы. Показываем сам филиал и считаем его
            // выбранным, в том числе у давних строк, где сохранён пустой список.
            const only = soleBranch();
            const brSel = only
                ? h('select', { class: 'rt-select', disabled: !on },
                    h('option', { value: String(only.id), selected: true }, only.name))
                : h('select', { class: 'rt-select', disabled: !on },
                    h('option', { value: '' }, 'Все филиалы'),
                    ...branches.map(b => h('option', { value: String(b.id), selected: on && (r.branches || []).map(Number).includes(Number(b.id)) }, b.name)));
            brSel.addEventListener('change', () => setBranches(s.id, brSel.value ? [Number(brSel.value)] : []));

            // DOCTOR_FIX_RATE_V1 — mode picker + the value it applies to.
            const fixed = isFix(r);
            const modeSeg = segmented(opts.allowFix, () => fixed, (wantFix) => setMode(s.id, wantFix ? 'fix' : 'pct'), !on);
            const rateInp = h('input', {
                type: 'number', min: '0', class: 'rt-num', disabled: !on,
                max: fixed ? null : '100',
                step: fixed ? '1000' : '1',
                value: on ? String(fixed ? r.fix : r.pct) : '0',
                title: fixed ? 'Врач получает эту сумму за каждую единицу услуги' : 'Процент от суммы строки после скидки',
            });
            rateInp.addEventListener('input', () => {
                const n = Number(rateInp.value) || 0;
                if (fixed) setFix(s.id, Math.max(0, n));
                else setPct(s.id, Math.min(100, Math.max(0, n)));
            });

            scroll.appendChild(h('div', { class: rowCls + ' rt-item' + (on ? ' on' : '') },
                chk,
                h('div', { style: { minWidth: 0 } },
                    h('div', { class: 'rt-name', title: s.name }, s.name),
                    h('div', { class: 'rt-type' }, svcTypeLabel(svcTypeVal(s)))),
                brSel,
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
            searchBox, typeSel, h('span', { class: 'grow' }),
            h('label', { class: 'rt-selall' }, selAllChk, 'Выбрать все'),
            h('div', { class: 'rt-bulk' },
                h('span', { class: 'muted' }, 'Ставка для всех'),
                bulkSeg,
                h('div', { class: 'rt-field', style: { flex: '0 0 auto' } }, bulkInp, bulkUnit))),
        h('div', { class: 'rt-box' }, scroll),
    );
    renderRows();
    return wrap;
}

function buildHours(emp, markDirty) {
    const wrap = h('div', { style: { display: 'grid', gap: '6px' } });
    for (const [key, label] of DAYS) {
        const d = emp.working_hours[key] || { on: false, from: '09:00', to: '18:00' };
        const chk = h('input', { type: 'checkbox', checked: !!d.on });
        const from = h('input', { type: 'time', value: d.from || '09:00', disabled: !d.on, style: { width: '110px' } });
        const to = h('input', { type: 'time', value: d.to || '18:00', disabled: !d.on, style: { width: '110px' } });
        const commit = () => { const wh = { ...emp.working_hours, [key]: { on: chk.checked, from: from.value, to: to.value } }; from.disabled = to.disabled = !chk.checked; markDirty({ working_hours: wh }); };
        chk.addEventListener('change', commit); from.addEventListener('change', commit); to.addEventListener('change', commit);
        wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 0' } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '7px', width: '80px', cursor: 'pointer' } }, chk, h('span', { style: { fontWeight: 600, fontSize: '13.5px' } }, label)), from, h('span', { class: 'muted' }, '—'), to));
    }
    return wrap;
}

function depName(id) { const d = departments.find(x => String(x.id) === String(id)); return d ? d.name : ''; }
function chip(text) { return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12.5px', padding: '2px 8px', borderRadius: '20px', background: 'var(--ink-50, #f1f2f4)', color: 'var(--ink-600)' } }, text); }
