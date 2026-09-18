// ROLES_EDITOR_V2 — Настройки → «Роли» (docs/plans/2026-08-24-lab-panels-and-roles.md,
// задача 2). Матрица доступа по ролям: для каждой штатной роли отмечаем, какие
// разделы она видит и что в них может делать. Одна строка на роль в
// `role_permissions` (permissions = JSON { sections:[navId],
// levels:{navId:'viewer'|'editor'|'admin'} }), которую при входе читают
// admin.js applyActorPermissions() и admin/permissions.js. Администратор всегда
// с полным доступом и здесь не редактируется — запереть себя нельзя.
//
// Экран управляет КЛИЕНТСКИМ интерфейсом (боковое меню и кнопки
// изменить/удалить); доступ к самим данным сервер проверяет отдельно по базовой
// роли (server/db/schema-registry.js). Об этом сказано прямо на экране: замок
// здесь не единственный.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ. Экран жил внутри settings-hub.js — файла, где уже
// лежат и сетка «Настроек», и универсальный редактор справочников. Правка
// прав задевала бы файл, который параллельно правят другие задачи, а в проекте
// конвенция — один файл на экран (88 файлов в views/). settings-hub.js теперь
// только монтирует этот экран и передаёт возврат назад.
//
// ЧТО БЫЛО СЛОМАНО В V1 (всё перечислено в плане, каждое проверено по коду):
//   1. Экран был на АНГЛИЙСКОМ внутри русского приложения. Теперь каждая
//      строка идёт через tr() и имеет запись ru/uz/en в i18n-strings.js.
//   2. У выпадающего списка уровня не было подписи. Теперь есть заголовок
//      колонки «Что можно делать» и aria-label на каждом списке.
//   3. Заблокированный список молчал о причине. Теперь рядом стоит строка
//      «Сначала отметьте раздел», и список ссылается на неё aria-describedby.
//   4. При ошибке загрузки экран показывал ПУСТУЮ матрицу — на экране прав это
//      читается как «у роли нет доступа», то есть опасная ложь. Теперь у
//      загрузки три честных состояния: загрузка, ошибка с кнопкой повтора,
//      данные. Пустая матрица рисуется только когда сервер действительно
//      ответил, и отдельная строка отличает «роль ещё не настроена» от «не
//      загрузилось».
//   5. Одна и та же кнопка «Сохранить» переносилась в карточку каждой роли.
//      Теперь кнопка создаётся вместе с карточкой, а на время запроса
//      блокируется вся форма (переключение ролей в том числе).
//   6. Переключение роли молча теряло отмеченные галочки. Теперь спрашиваем.
//   7. Инлайновые стили переехали в блок .roles-ed в public/css/admin-views.css
//      (тот же приём, что .tel-set у телефонии).

import { supabase } from '../../supabase.js';
import { h, Icon, PageHead, clear, toast } from '../ui.js';
// h() прогоняет текстовые дети и placeholder/aria-label через tr() сам; всё,
// что собирается конкатенацией или ставится после отрисовки, зовёт tr() явно
// (тот же приём, что в telephony-settings.js и locked-module.js).
import { tr, trf, t } from '../i18n.js';
import { NAV_MODULES, PATIENT_TABS } from '../permissions.js';   // ROLE_KEYS_V2 — единый список выдаваемых модулей;
                                                                  // PATIENT_TAB_ACCESS_V1 — вкладки карты пациента
// ROLE_REACH_V1 — «что роль видит, словами». Ответы спрашиваются у настоящих
// ворот доступа, а не выводятся здесь заново (см. шапку role-reach.js).
import { roleReach, reachSentences } from '../role-reach.js?v=reach1';
// ROLE_ACTIONS_V1 — права названы ДЕЙСТВИЯМИ, и предлагаются только те, что
// программа действительно проверяет (см. шапку role-actions.js).
import { levelsFor, openAction, actionFor, levelFromActions, actionsFromLevel }
    from '../role-actions.js?v=acts1';
// ROLES_MATRIX_V1 — матрица «раздел → окно → действие» по общему справочнику
// прав (shared/permission-catalog.js). Старые поля sections/levels выводятся
// из неё при сохранении, чтобы прежние ворота продолжали работать.
import { paintCatalog, collectGrants, grantsFromLegacy, legacyFromGrants } from '../roles-matrix.js?v=rm2';

// ROLE_KEYS_V2 — матрица строится из permissions.js NAV_MODULES, того же
// списка, который читают сами ворота бокового меню. Когда-то это была вторая
// копия списка, и она разошлась: экран предлагал «Doctor's room» и писал ключ
// `doctor-room`, который никто не проверяет (кабинет закрыт ключом
// `consultation»), — отмеченная галочка не давала ничего.
const ROLE_MODULES = NAV_MODULES;

// Редактируемые штатные роли (админ всегда с полным доступом — отдельно).
const ROLE_LIST = [
    { key: 'registrar',  label: 'Регистратор' },
    { key: 'doctor',     label: 'Врач' },
    { key: 'cashier',    label: 'Кассир' },
    { key: 'lab',        label: 'Лаборант' },
    { key: 'nurse',      label: 'Медсестра' },
    { key: 'inventory',  label: 'Склад' },
    { key: 'callcenter', label: 'Колл-центр' },   // CALLCENTER_ROLE_V1
    // INPATIENT_FLOW_V1 — надстроечные роли стационара. Права на РАЗДЕЛЫ у них
    // такие же настраиваемые, как у остальных; полномочия в маршруте
    // госпитализации проверяет сервер (rpc/inpatient-flow.js) и здесь не
    // настраиваются — иначе «первичный осмотр проводит главный врач» стало бы
    // галочкой, которую можно снять.
    { key: 'head_doctor',  label: 'Главный врач' },
    { key: 'senior_nurse', label: 'Старшая медсестра' },
];

// Уровни названы тем, что человек МОЖЕТ ДЕЛАТЬ, а не системной ролью:
// «Viewer/Editor/Admin» ничего не говорит заведующей, которая заводит
// лаборанта. Ключи в базе не менялись — поменялись только слова на экране.
const ROLE_LEVELS = [
    ['viewer', 'Только просмотр'],
    ['editor', 'Просмотр и изменение'],
    ['admin',  'Изменение и удаление'],
];
const DEFAULT_LEVEL = 'editor';

// CUSTOM_ROLES_V1 (2026-09-16) — СВОИ РОЛИ КЛИНИКИ.
//
// Владелец: «and also aviable option to create a new role with editing
// permissions?». Штатных ролей восемь, и они не переименовываются: сервер
// раздаёт данные по их именам. Своя роль клиники — это НАЗВАНИЕ и свой набор
// разделов поверх ОСНОВЫ, одной из штатных: «Старший регистратор» на базе
// регистратуры видит то, что ему отметили, а данные сервер отдаёт как
// регистратуре. Ниже основы — сколько угодно; выше — нельзя, и это главное,
// что нужно понимать про эту кнопку.
const BASE_ROLES = [
    ['registrar', 'Регистратор'], ['doctor', 'Врач'], ['cashier', 'Кассир'], ['lab', 'Лаборант'],
    ['nurse', 'Медсестра'], ['inventory', 'Склад'], ['callcenter', 'Колл-центр'], ['admin', 'Администратор'],
];
// Код роли — латиница: он ложится в role_permissions.role рядом со штатными
// именами. Русское название транслитерируется, а если от него ничего не
// осталось (название на другом алфавите) — берём «role» и номер.
const TRANSLIT = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
export function roleCodeFrom(name, taken = []) {
    const base = String(name || '').toLowerCase().split('').map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
        .join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
    const busy = new Set(taken);
    if (!busy.has(base)) return base;
    for (let i = 2; i < 999; i += 1) { const c = base + '-' + i; if (!busy.has(c)) return c; }
    return base + '-' + Date.now();
}

const roleLabel = (key) => (ROLE_LIST.find(r => r.key === key) || { label: key }).label;

// window.confirm обёрнут: в тестовой фейковой DOM диалогов нет, и отсутствие
// диалога не должно молча означать «нет» (тот же приём, что в crm-settings.js).
// Вопрос — цельная строка из словаря: tr() ищет по исходной строке целиком,
// поэтому собранный конкатенацией вопрос перевода бы не нашёл.
function askDiscard() {
    const text = tr('Права этой роли изменены, но не сохранены. Перейти дальше? Изменения пропадут.');
    return (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm(text) : true;
}

// Снимок состояния галочек — по нему и только по нему решается «есть
// несохранённое». Сравниваем не с сырым ответом сервера, а с НОРМАЛИЗОВАННЫМ
// снимком того же вида: у роли, сохранённой до появления уровней, уровня в
// JSON нет, и наивное сравнение объявляло бы такую роль изменённой сразу
// после загрузки — предупреждение, которое всегда врёт, перестают читать.
function snapshot(sections, levels, tabs, grants) {
    const keys = [...sections].sort();
    const tkeys = Object.keys(tabs || {}).sort();
    const gkeys = Object.keys(grants || {}).sort();
    return JSON.stringify({
        s: keys, l: keys.map(k => levels[k] || DEFAULT_LEVEL),
        t: tkeys.map(k => k + '=' + tabs[k]),
        g: gkeys.map(k => k + '=' + grants[k]),
    });
}

// PATIENT_TAB_ACCESS_V1 — уровень вкладки из трёх галочек. Порядок важен:
// «Удаление» подразумевает «Редакт.», «Редакт.» подразумевает «Видна».
function tabLevelOf(st) {
    if (!st.view) return 'none';
    if (st.del) return 'delete';
    if (st.edit) return 'edit';
    return 'view';
}

export async function renderRolesEditor(container, { onBack } = {}) {
    // roles-ed — область действия стилей экрана (см. блок в admin-views.css).
    const root = h('div', { class: 'fade-in roles-ed' });
    const state = {
        custom: [],       // CUSTOM_ROLES_V1 — роли клиники (и включённые, и отключённые)
        selected: ROLE_LIST[0].key,
        controls: {},     // moduleKey -> { chk, level }
        tabControls: {},  // PATIENT_TAB_ACCESS_V1: tabId -> { view, edit, del }
        otherTabs: {},    // настройки вкладок, которых этот экран НЕ рисует — переносим как есть
        baseline: null,   // снимок на момент загрузки; null = данных нет
        busy: false,      // идёт сохранение — форма и переключатель заперты
        openSections: new Set(),   // ROLES_ACCORDION_V1 — раскрытые разделы матрицы, живут пока открыт экран
    };

    const roleBtns   = h('div', { class: 'segmented roles-tabs', role: 'group', 'aria-label': 'Выберите роль' });
    const matrixWrap = h('div');

    const backBtn = h('button', {
        class: 'btn btn-outline btn-sm roles-back', type: 'button',
        onclick: () => { if (guard()) onBack && onBack(); },
    }, Icon('ChevronLeft', { size: 14 }), ' ', 'Назад в настройки');
    root.appendChild(backBtn);

    root.appendChild(PageHead({
        title: 'Роли и права',
        subtitle: 'Кто что видит и может менять. У администратора всегда полный доступ.',
    }));

    root.appendChild(h('div', { class: 'card roles-note' },
        h('span', { class: 'roles-note-ico' }, Icon('Help', { size: 15 })),
        h('div', { class: 'muted roles-note-txt' },
            'Здесь вы выбираете, какие разделы видит сотрудник. Доступ к данным дополнительно проверяет сервер — это не единственный замок.'),
    ));

    root.appendChild(roleBtns);
    // CUSTOM_ROLES_V1 — форма «новой роли» живёт прямо под полосой ролей:
    // заводят её редко, и отдельное окно ради двух полей было бы лишним шагом.
    const newRoleBox = h('div', { class: 'roles-new' });
    root.appendChild(newRoleBox);
    root.appendChild(matrixWrap);
    container.appendChild(root);

    await loadCustomRoles();
    paintRoleTabs();
    paintNewRole();

    await selectRole(state.selected);
    return root;

    // -------------------------------------------------------------------------

    // Единственная точка, где решается «можно ли уйти». Ею закрыты и
    // переключение роли, и «Назад в настройки»: правило рекомендаций —
    // предупреждать перед УХОДОМ с несохранёнными изменениями, а не только
    // перед сменой вкладки.
    function guard() {
        if (state.busy) return false;
        if (!isDirty()) return true;
        return askDiscard();
    }

    function isDirty() {
        if (state.baseline == null) return false;   // ошибка/загрузка — терять нечего
        return current() !== state.baseline;
    }

    function current() {
        const { sections, levels, patient_tabs, grants } = collect();
        return snapshot(sections, levels, patient_tabs, grants);
    }

    // Одно место, где состояние экрана превращается в то, что уходит в базу —
    // и «изменено ли», и «что сохранить» считаются по нему, иначе они разойдутся.
    function collect() {
        // ROLES_MATRIX_V1 — источник правды теперь grants; старые sections/levels
        // выводятся из них, а неизвестные справочнику ключи переносятся как есть.
        const grants = collectGrants(state.grantControls || {});
        const { sections, levels } = legacyFromGrants(grants, state.prevLegacy || {});
        // ROLE_SAVE_PRESERVE_V1 — вкладки, которых этот экран не рисует,
        // переносим как есть: иначе сохранение роли молча стирало бы настройку,
        // сделанную где-то ещё.
        const patient_tabs = { ...state.otherTabs };
        for (const [tab, ctl] of Object.entries(state.tabControls)) {
            patient_tabs[tab] = tabLevelOf({ view: ctl.view.checked, edit: !!(ctl.edit && ctl.edit.checked), del: !!(ctl.del && ctl.del.checked) });
        }
        return { sections, levels, patient_tabs, grants };
    }

    // CUSTOM_ROLES_V1 ---------------------------------------------------------
    // Объявлены ФУНКЦИЯМИ, а не стрелками в const: полоса ролей рисуется выше по
    // файлу, до этой строки, и const там ещё не существует (TDZ).
    function allRoles() {
        return [...ROLE_LIST, ...state.custom.map((c) => ({ key: c.code, label: c.name, custom: c }))];
    }
    function customOf(key) { return state.custom.find((c) => c.code === key) || null; }
    function labelOf(key) { const c = customOf(key); return c ? c.name : roleLabel(key); }

    async function loadCustomRoles() {
        try {
            const { data, error } = await supabase.from('custom_roles').select('*').order('name');
            if (!error && Array.isArray(data)) state.custom = data;
        } catch (e) { /* таблицы ещё нет (база до миграции 133) — только штатные роли */ }
    }

    function paintRoleTabs() {
        clear(roleBtns);
        for (const r of allRoles()) {
            const off = r.custom && !r.custom.active;
            const b = h('button', { class: 'segmented-btn' + (off ? ' is-off' : ''), type: 'button',
                title: r.custom ? trf('Своя роль клиники · основа: {base}', { base: tr(roleLabel(r.custom.base_role)) }) : '',
                onclick: () => selectRole(r.key) }, r.label + (off ? ' · ' + tr('отключена') : ''));
            b.dataset.role = r.key;
            roleBtns.appendChild(b);
        }
        paintActive();
    }

    function paintNewRole() {
        clear(newRoleBox);
        const nameInp = h('input', { class: 'roles-new-inp', type: 'text', placeholder: 'Название роли', 'aria-label': 'Название новой роли' });
        const baseSel = h('select', { class: 'roles-new-sel', 'aria-label': 'Основа новой роли' },
            ...BASE_ROLES.map(([k, l]) => h('option', { value: k }, l)));
        const addBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' }, Icon('Plus', { size: 13 }), ' ', 'Новая роль');
        addBtn.addEventListener('click', () => createRole(nameInp, baseSel, addBtn));
        newRoleBox.appendChild(h('div', { class: 'roles-new-row' }, nameInp, baseSel, addBtn));
        newRoleBox.appendChild(h('div', { class: 'muted roles-new-hint' },
            'Своя роль клиники: название ваше, разделы вы отмечаете сами. Основа решает, какие данные отдаёт сервер, — больше основы роль не получит.'));
    }

    async function createRole(nameInp, baseSel, addBtn) {
        const name = String(nameInp.value || '').trim();
        if (!name) { toast(tr('Введите название роли.'), 'fail'); return; }
        const base = baseSel.value;
        const taken = [...ROLE_LIST.map((r) => r.key), ...state.custom.map((c) => c.code)];
        const code = roleCodeFrom(name, taken);
        addBtn.disabled = true;
        try {
            const ins = await supabase.from('custom_roles').insert({ code, name, base_role: base, active: 1 }).select().single();
            if (ins.error) throw new Error(ins.error.message || String(ins.error));
            // Новая роль начинает с прав СВОЕЙ ОСНОВЫ: пустая роль, выданная
            // человеку, заперла бы его в пустом приложении, а сузить готовый
            // набор — работа на минуту.
            let permissions = JSON.stringify({ sections: [], levels: {}, patient_tabs: {} });
            try {
                const { data: baseRow } = await supabase.from('role_permissions').select('permissions').eq('role', base).maybeSingle();
                if (baseRow && baseRow.permissions) permissions = typeof baseRow.permissions === 'string' ? baseRow.permissions : JSON.stringify(baseRow.permissions);
            } catch (e) { /* нет строки основы — начнём с пустой */ }
            const perm = await supabase.from('role_permissions').insert({ role: code, permissions }).select().single();
            if (perm.error) throw new Error(perm.error.message || String(perm.error));
            state.custom.push(ins.data || { code, name, base_role: base, active: 1 });
            nameInp.value = '';
            paintRoleTabs();
            toast(trf('Роль «{name}» создана — отметьте её разделы и сохраните.', { name }), 'ok');
            await selectRole(code);
        } catch (e) {
            toast(tr('Не удалось создать роль.') + ' ' + ((e && e.message) || ''), 'fail');
        } finally {
            addBtn.disabled = false;
        }
    }

    async function toggleRoleActive(role, btn) {
        btn.disabled = true;
        const next = role.active ? 0 : 1;
        try {
            const { error } = await supabase.from('custom_roles').update({ active: next }).eq('code', role.code).select().single();
            if (error) throw new Error(error.message || String(error));
            role.active = next;
            paintRoleTabs();
            toast(next ? tr('Роль включена.') : tr('Роль отключена — новым сотрудникам её не предложат.'), 'ok');
        } catch (e) {
            toast(tr('Не удалось изменить роль.') + ' ' + ((e && e.message) || ''), 'fail');
        } finally { btn.disabled = false; }
    }

    function paintActive() {
        for (const b of roleBtns.children) {
            const on = b.dataset.role === state.selected;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    async function selectRole(key) {
        if (key !== state.selected && !guard()) return;
        state.selected = key;
        state.baseline = null;
        state.controls = {};
        state.grantControls = {};
        state.prevLegacy = {};
        state.tabControls = {};
        state.otherTabs = {};
        paintActive();

        clear(matrixWrap);
        // Строка загрузки заканчивается многоточием — правило рекомендаций и
        // единственный способ отличить «ещё грузится» от «пусто».
        matrixWrap.appendChild(h('div', { class: 'roles-state', role: 'status' }, 'Загрузка…'));

        let perms = null;   // null = не загрузилось; {} = сервер ответил
        let failure = null;
        try {
            const { data, error } = await supabase.from('role_permissions')
                .select('permissions').eq('role', key).maybeSingle();
            if (error) throw new Error(error.message || String(error));
            let p = data && data.permissions;
            if (typeof p === 'string') p = JSON.parse(p);
            const tabs = (p && p.patient_tabs && typeof p.patient_tabs === 'object') ? p.patient_tabs : {};
            const grants = (p && p.grants && typeof p.grants === 'object') ? p.grants : null;
            perms = (p && Array.isArray(p.sections))
                ? { sections: p.sections, levels: p.levels || {}, patient_tabs: tabs, grants, configured: true }
                : { sections: [], levels: {}, patient_tabs: tabs, grants, configured: false };
        } catch (e) {
            failure = (e && e.message) || String(e);
        }
        if (key !== state.selected) return;   // пока грузили, переключились — ответ устарел
        if (failure) paintError(failure); else paintMatrix(perms);
    }

    // Экран прав НИКОГДА не показывает пустую матрицу вместо ошибки: пустая
    // матрица здесь читается как «у роли нет доступа» и толкает администратора
    // сохранить эту ложь поверх настоящих прав.
    function paintError(message) {
        clear(matrixWrap);
        matrixWrap.appendChild(h('div', { class: 'card roles-error', role: 'alert' },
            h('div', { class: 'roles-error-head' },
                h('span', { class: 'roles-error-ico' }, Icon('Warning', { size: 16 })),
                h('strong', null, 'Не удалось загрузить права роли.'),
            ),
            h('p', { class: 'roles-error-why' }, String(message || '')),
            h('p', { class: 'roles-error-next' },
                'Права не показаны — это не значит, что их нет. Повторите загрузку, прежде чем что-то сохранять.'),
            h('button', {
                class: 'btn btn-primary btn-sm', type: 'button',
                onclick: () => selectRole(state.selected),
            }, Icon('Refresh', { size: 14 }), ' ', 'Повторить загрузку'),
        ));
    }

    function paintMatrix(perms) {
        clear(matrixWrap);
        state.controls = {};
        const granted = new Set(perms.sections || []);
        const levels  = perms.levels || {};

        // Кнопка создаётся ВМЕСТЕ с карточкой. В V1 существовал один узел
        // saveBtn, который переносился в карточку каждой роли: он оставался
        // жив после clear() и уносил с собой состояние прошлого рендера.
        const saveBtn = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Сохранить роль');
        saveBtn.addEventListener('click', () => save(saveBtn));

        const card = h('div', { class: 'card roles-card' },
            h('div', { class: 'card-header' },
                h('h3', null, Icon('Shield', { size: 16 }), ' ', 'Разделы и уровень доступа', ' · ', labelOf(state.selected)),
                saveBtn,
            ),
        );

        // CUSTOM_ROLES_V1 — у своей роли видно, на чём она стоит, и её можно
        // отключить: удаления нет намеренно (людей с этой ролью нельзя оставить
        // с кодом, которого нет).
        const cur = customOf(state.selected);
        if (cur) {
            const offBtn = h('button', { class: 'btn btn-outline btn-sm', type: 'button' },
                cur.active ? 'Отключить роль' : 'Включить роль');
            offBtn.addEventListener('click', () => toggleRoleActive(cur, offBtn));
            card.appendChild(h('div', { class: 'roles-base' },
                h('span', { class: 'muted' }, trf('Своя роль клиники · основа: {base}', { base: tr(roleLabel(cur.base_role)) })),
                h('span', { class: 'grow' }),
                offBtn));
        }

        if (!perms.configured) {
            card.appendChild(h('p', { class: 'roles-unset' },
                'У этой роли ещё нет сохранённых настроек. Отметьте разделы и сохраните.'));
        }

        // ROLE_REACH_V1 — ИТОГ ГАЛОЧЕК, СЛОВАМИ, И ПРЯМО ЗДЕСЬ.
        //
        // Тридцать галочек не отвечают на вопрос, ради которого их и ставят:
        // куда сотрудник попадёт, войдя, и чего не увидит. Сводка отвечает — и
        // пересчитывается на КАЖДОЕ изменение, ещё до сохранения: увидеть
        // последствие галочки нужно тогда, когда её ставят, а не после того,
        // как роль уже выдана живому человеку.
        const reachBox = h('div', { class: 'roles-reach' });
        card.appendChild(reachBox);
        function paintReach() {
            clear(reachBox);
            // NAV лежит в оболочке (admin.js открывает его наружу). Нет
            // оболочки — сводки нет: соврать про доступ хуже, чем промолчать.
            const nav = (typeof window !== 'undefined' && window.easymed && window.easymed.NAV) || null;
            if (!nav) return;
            const ids = nav.filter((it) => !it.section).map((it) => it.id);
            const reach = roleReach(
                { name: labelOf(state.selected), permissions: collect() },
                ids,
                (id) => t('sidebar.nav.' + id, id),
                tr,   // перевод СНАЧАЛА: слова уровня и ролей едут в {дырках}
            );
            reachBox.appendChild(h('div', { class: 'roles-reach-h' },
                Icon('Doc', { size: 13 }), ' ', tr('Что увидит сотрудник с этой ролью')));
            for (const line of reachSentences(reach, tr)) {
                reachBox.appendChild(h('div', { class: 'roles-reach-line is-' + line.tone },
                    line.params ? trf(line.template, line.params) : tr(line.template)));
            }
        }
        // Одно делегированное событие на карточку вместо обработчика на каждую
        // из трёх десятков галочек и списков.
        card.addEventListener('change', paintReach);

        // ROLES_MATRIX_V1 — раздел → окно → действие. Роль без grants получает
        // их из старых полей: экран показывает то, что действует сейчас, а не
        // пустую матрицу, которая читалась бы как «у роли нет ничего».
        state.prevLegacy = { sections: perms.sections || [], levels: perms.levels || {} };
        const grants = perms.grants || grantsFromLegacy(perms);
        card.appendChild(h('div', { class: 'roles-group' },
            h('span', { class: 'roles-group-name' }, 'Разделы, окна и действия'),
            h('span', { class: 'roles-group-lvl' }, 'Нет · Просмотр · Изменение · Удаление'),
        ));
        card.appendChild(h('p', { class: 'roles-unset' },
            'Уровни вложены: «Изменение» включает «Просмотр», «Удаление» — всё вместе. Под каждой строкой написано, что даёт выбранный уровень.'));
        const matrixHost = h('div', { class: 'rm' });
        card.appendChild(matrixHost);
        state.grantControls = paintCatalog(matrixHost, grants, { onAnyChange: paintReach, openSections: state.openSections });

        // PATIENT_TAB_ACCESS_V1 — вкладки карты пациента. Владелец: «we need to
        // add a patients card tabs to the view/edit/delete option». Отдельная
        // группа В ТОМ ЖЕ экране и по тем же правилам, что разделы: ключ
        // раздела `patients` открывает карту, а эти галочки решают, ЧТО в ней
        // видно. Выключенная галочка — единственный способ что-то закрыть: по
        // умолчанию открыто всё, поэтому обновление никого не отключает.
        const tabs = perms.patient_tabs || {};
        const rendered = new Set(PATIENT_TABS.map(t => t.id));
        state.otherTabs = {};
        for (const [k, v] of Object.entries(tabs)) if (!rendered.has(k)) state.otherTabs[k] = v;

        card.appendChild(h('div', { class: 'roles-group' },
            h('span', { class: 'roles-group-name' }, 'Карта пациента — вкладки'),
            h('span', { class: 'roles-group-lvl' }, 'Что открыто'),
        ));
        card.appendChild(h('p', { class: 'roles-unset' },
            'По умолчанию открыты все вкладки. Снимите галочку, чтобы закрыть вкладку этой роли.'));
        for (const t of PATIENT_TABS) card.appendChild(tabRow(t, tabs));

        matrixWrap.appendChild(card);
        paintReach();   // ROLE_REACH_V1 — сводка есть сразу, а не после первой галочки
        state.baseline = current();
    }

    // Строка вкладки: «Видна» · «Редакт.» · «Удаление». Галочка рисуется
    // ТОЛЬКО там, где право существует (permissions.js PATIENT_TABS caps):
    // «Удаление» у «Счёта» обещало бы то, чего нет ни в карте, ни в реестре
    // таблиц, и админ считал бы, что выдал доступ, который на деле не работает.
    function tabRow(t, tabs) {
        const caps = t.caps || { edit: true, del: true };
        const lvl = tabs[t.id];
        const box = (labelText, on, aria) => {
            const cb = h('input', { type: 'checkbox', checked: on });
            cb.dataset.ptabKey = t.id;
            cb.setAttribute('aria-label', tr(aria) + ': ' + tr(t.label));
            return { cb, el: h('label', { class: 'roles-tab-opt' }, cb, h('span', null, labelText)) };
        };
        // ОТСУТСТВИЕ НАСТРОЙКИ = ПОЛНЫЙ ДОСТУП, и галочки обязаны показывать
        // именно это. Если бы «Удаление» у ненастроенной роли рисовалось
        // снятым, ПЕРВОЕ же сохранение любой роли молча отняло бы право,
        // которым клиника пользуется сегодня, — и никто бы не понял, почему
        // после «просто сохранил» перестала убираться неоплаченная услуга.
        const view = box('Видна',    lvl == null ? true : lvl !== 'none', 'Вкладка видна');
        const edit = caps.edit ? box('Редакт.',  lvl == null ? true : (lvl === 'edit' || lvl === 'delete'), 'Изменение на вкладке') : null;
        const del  = caps.del  ? box('Удаление', lvl == null ? true : lvl === 'delete', 'Удаление на вкладке') : null;

        const sync = (src) => {
            if (src === 'view' && !view.cb.checked) { if (edit) edit.cb.checked = false; if (del) del.cb.checked = false; }
            if (src === 'edit') { if (edit.cb.checked) view.cb.checked = true; else if (del) del.cb.checked = false; }
            if (src === 'del' && del.cb.checked) { if (edit) edit.cb.checked = true; view.cb.checked = true; }
        };
        view.cb.addEventListener('change', () => sync('view'));
        if (edit) edit.cb.addEventListener('change', () => sync('edit'));
        if (del)  del.cb.addEventListener('change', () => sync('del'));
        state.tabControls[t.id] = { view: view.cb, edit: edit && edit.cb, del: del && del.cb };

        const dash = (why) => h('span', { class: 'roles-why', title: why }, '—');
        return h('div', { class: 'roles-row', dataset: { patientTab: t.id } },
            h('span', { class: 'roles-pick-txt' },
                h('span', { class: 'roles-mod' }, t.label),
                t.note ? h('span', { class: 'roles-desc' }, t.note) : null,
            ),
            h('div', { class: 'roles-tab-opts' },
                view.el,
                edit ? edit.el : dash('Изменять на этой вкладке нечего'),
                del  ? del.el  : dash('Удаления на этой вкладке не существует'),
            ),
        );
    }

    // ROLE_ACTIONS_V1 — СТРОКА РАЗДЕЛА ГОВОРИТ ДЕЙСТВИЯМИ.
    //
    // Здесь у каждого раздела стоял выпадающий список из трёх уровней. Уровень
    // при этом читают ПЯТЬ ключей во всей программе: у остальных четырнадцати
    // разделов он не значил ничего, и «Только просмотр» у кассы оставляло кассу
    // ровно такой же — с теми же кнопками приёма денег. Право, которого нет,
    // показанное галочкой, опаснее отсутствия галочки: первое даёт ложную
    // уверенность, второе заставляет спросить.
    //
    // Теперь раздел — это выключатель («открыт»), а под ним отмечаются
    // ДОБАВОЧНЫЕ действия, и только те, которые программа проверяет на самом
    // деле. Список действий и его согласие с кодом держит role-actions.js и
    // тест __tests__/role-actions.test.mjs — сверять такое глазами по 105
    // файлам видов невозможно.
    function moduleRow(it, granted, levels) {
        const chk = h('input', { type: 'checkbox', checked: granted.has(it.key) });
        chk.dataset.permKey = it.key;   // ROLE_KEYS_V2 — по нему тесты отличают раздел от вкладки карты

        const wantLevels = levelsFor(it.key);
        const saved = actionsFromLevel(levels[it.key] || DEFAULT_LEVEL);
        const acts = {};
        const actEls = [];
        for (const lvl of wantLevels) {
            const box = h('input', { type: 'checkbox', checked: !!saved[lvl] });
            box.dataset.permAction = it.key + ':' + lvl;
            acts[lvl] = box;
            actEls.push(h('label', { class: 'roles-act' }, box,
                h('span', null, tr(actionFor(it.key, lvl)))));
        }

        // «Удаление» без «изменения» бессмысленно — accessLevelFor() всё равно
        // прочтёт его как более старшее право. Отмечаем зависимость сразу, а не
        // молча исправляем при сохранении.
        if (acts.admin && acts.editor) {
            acts.admin.addEventListener('change', () => { if (acts.admin.checked) acts.editor.checked = true; });
            acts.editor.addEventListener('change', () => { if (!acts.editor.checked) acts.admin.checked = false; });
        }

        // Список действий существует только у отмеченного раздела: у закрытого
        // он не «серый», а отсутствует — обсуждать нечего.
        const actBox = h('div', { class: 'roles-acts' }, ...actEls);
        const sync = () => { actBox.className = chk.checked ? 'roles-acts' : 'roles-acts is-hidden'; };
        sync();
        chk.addEventListener('change', sync);

        // level — не орган управления, а вычисляемое значение: collect() читает
        // .value, как читал у списка, поэтому сохранение не менялось вовсе.
        state.controls[it.key] = {
            chk,
            level: { get value() { return levelFromActions({ editor: !!(acts.editor && acts.editor.checked), admin: !!(acts.admin && acts.admin.checked) }); } },
        };

        const open = openAction(it.key);
        return h('div', { class: 'roles-row' },
            h('label', { class: 'roles-pick' },
                chk,
                h('span', { class: 'roles-pick-txt' },
                    h('span', { class: 'roles-mod' }, it.label),
                    open ? h('span', { class: 'roles-desc' }, tr(open)) : null,
                ),
            ),
            actEls.length ? actBox : null,
        );
    }

    async function save(saveBtn) {
        if (state.busy) return;
        const { sections, levels, patient_tabs, grants } = collect();
        const permissions = JSON.stringify({ sections, levels, patient_tabs, grants });
        const role = state.selected;

        // Кнопка остаётся активной ДО начала запроса и запирается на время
        // него: без этого двойной клик записывал права дважды.
        setBusy(true, saveBtn);
        try {
            const { error } = await supabase.from('role_permissions')
                .update({ permissions }).eq('role', role).select().single();
            if (error) throw new Error(error.message || String(error));
            state.baseline = snapshot(sections, levels, patient_tabs, grants);
            toast(tr('Права сохранены — сотрудники увидят их при следующем входе.') + ' · ' + (customOf(role) ? customOf(role).name : tr(roleLabel(role))), 'ok');
        } catch (e) {
            // В сообщении есть следующий шаг, а не только беда.
            toast(tr('Не удалось сохранить права. Проверьте связь с сервером и повторите.') + ' ' + ((e && e.message) || ''), 'fail');
        } finally {
            setBusy(false, saveBtn);
        }
    }

    function setBusy(on, saveBtn) {
        state.busy = on;
        saveBtn.disabled = on;
        saveBtn.textContent = on ? tr('Сохранение…') : tr('Сохранить роль');
        // Переключатель ролей и выход тоже заперты: уйти в середине записи
        // значит не узнать, чем она кончилась. Кнопки именно ГАСНУТ, а не
        // молча перестают работать — иначе экран выглядит зависшим.
        for (const b of roleBtns.children) b.disabled = on;
        backBtn.disabled = on;
        // И сами галочки: отмеченное во время запроса не попало бы в него, но
        // попало бы в новый снимок «сохранено» — экран считал бы себя чистым,
        // а на сервере этой галочки не было бы.
        // ROLES_MATRIX_V1 — переключатели матрицы гаснут на время записи по той
        // же причине, что и галочки вкладок ниже.
        for (const ctl of Object.values(state.grantControls || {})) ctl.disable(on);
        // PATIENT_TAB_ACCESS_V1 — галочки вкладок по той же причине.
        for (const ctl of Object.values(state.tabControls)) {
            ctl.view.disabled = on;
            if (ctl.edit) ctl.edit.disabled = on;
            if (ctl.del)  ctl.del.disabled = on;
        }
        matrixWrap.setAttribute('aria-busy', on ? 'true' : 'false');
    }
}
