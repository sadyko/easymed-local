// ADMIN_ACT_AS_V1 (2026-10-28) — АДМИНИСТРАТОР РАБОТАЕТ ОТ ИМЕНИ СОТРУДНИКА:
// ЭКРАН (задача 2).
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md, раздел
// «Интерфейс». Сервер (задача 1) держит всё сам: проверяет, кто и от чьего
// имени входит (R1, R2), пишет журнал действий, отказывает в подписи
// документов врача (R3), заканчивает вход от имени сам (R4). Экран здесь
// только говорит человеку правду о том, что происходит:
//
//   • «Войти как сотрудник» — администратору из своей учётной записи и только
//     для сотрудников, разрешённых R2 (кнопка, которая всегда ругается, хуже
//     отсутствующей); подтверждение словами спецификации; потом перезагрузка
//     — программа собирается заново уже под сотрудником;
//   • полоса вверху экрана «Вы работаете от имени …» и «Вернуться к своей
//     учётной записи» (тот же приём, что у полосы лицензии, свой цвет);
//   • вход от имени кончился сам (2 часа, сотрудник отключён …): ЛЮБОЙ
//     запрос API получает 409 act_as_ended — экран ОДИН раз называет
//     причину, говорит серверу «Вернуться» и перезагружается;
//   • кнопки подписи документа врача неактивны, подсказка — текст отказа R3.
//
// Пользователь оболочки — window.easymed.state.user (admin/auth.js
// actorFromUser несёт acting_admin), до оболочки — window.CURRENT_USER.
import { h, Icon, toast } from './ui.js';
import { tr, trf } from './i18n.js';
import { currentRoleLabel, settingsTileLevel } from './permissions.js';
import { ACT_AS_MESSAGES, ACT_AS_SIGN_REFUSAL, ACT_AS_TAB_HEADER } from '../shared/act-as.js';

const API = '/api/auth/act-as';

function shellUser() {
    if (typeof window === 'undefined' || !window) return null;
    return (window.easymed && window.easymed.state && window.easymed.state.user) || window.CURRENT_USER || null;
}

/** Администратор, работающий сейчас от имени сотрудника ({id, full_name}), или null. */
export function actingAdmin(user = shellUser()) {
    const a = user && user.acting_admin;
    return a && a.id != null ? a : null;
}

/** Работает ли экран сейчас от имени сотрудника. */
export function isActingNow(user = shellUser()) {
    return !!actingAdmin(user);
}

function roleList(v) {
    let list = v;
    if (typeof v === 'string') {
        try { list = v.trim() ? JSON.parse(v) : []; } catch (_) { list = []; }
    }
    return Array.isArray(list) ? list : [];
}

/** Администратор по ролям — основная или дополнительная `admin` (isAdminUser сервера). */
export function hasAdminRole(u) {
    if (!u) return false;
    return u.role === 'admin' || roleList(u.extra_roles).includes('admin');
}

/**
 * R1 на экране — видит ли человек «Войти как сотрудник» (и «Входы от имени» в
 * карточке): администратор из СВОЕЙ учётной записи (не уже от имени другого),
 * не с временным паролем и с «Сотрудники: Изменение» — своя роль клиники на
 * основе администратора, закрывшая этот раздел, чужими правами его не вернёт
 * (ревью безопасности, MEDIUM 4). Сервер проверяет то же самое ещё раз.
 */
export function canStartActAs(user = shellUser()) {
    if (!user || !hasAdminRole(user) || isActingNow(user) || user.must_change_password) return false;
    const level = settingsTileLevel('settings.employees');
    return level === 'edit' || level === 'delete';
}

/**
 * R2 на экране — можно ли войти от имени этого сотрудника: активный, уже
 * входивший (не временный пароль), не сам вошедший и не администратор —
 * основной, дополнительной ролью или своей ролью клиники на её основе.
 * customRoles — [{ code, base_role }] клиники (экран «Сотрудники» их уже грузит).
 */
export function actAsTargetOk(target, { selfId = null, customRoles = [] } = {}) {
    if (!target || target.id == null) return false;
    if (!target.is_active) return false;
    if (target.must_change_password) return false;
    if (selfId != null && String(target.id) === String(selfId)) return false;
    if (hasAdminRole(target)) return false;
    const code = typeof target.custom_role_code === 'string' ? target.custom_role_code.trim() : '';
    if (code) {
        if (code === 'admin') return false;
        const own = (customRoles || []).find((c) => c && c.code === code);
        if (own && own.base_role === 'admin') return false;
    }
    return true;
}

/** Текст подтверждения входа — слова спецификации («Интерфейс»). */
export function actAsConfirmText(name, admin) {
    const n = String(name || '');
    const text = trf('Вы будете работать от имени {name}. Каждое действие запишется как «Администратор {admin} от имени {name}». Подписывать документы врача от его имени нельзя. Вернуться — кнопкой вверху экрана.',
        { name: n, admin: String(admin || '') });
    // Ревью — имя с точкой на конце («Иванова А.»): своя точка шаблона после
    // имени не ставится второй («Иванова А.. Каждое…»), на любом языке.
    return /\.$/.test(n) ? text.split(n + '.').join(n) : text;
}

function reloadPage() {
    try { window.location.reload(); } catch (_) { /* страницы нет — нечего перезагружать */ }
}

async function readJson(res) {
    try { return await res.json(); } catch (_) { return {}; }
}

/**
 * «Войти как сотрудник»: подтверждение → POST /api/auth/act-as → перезагрузка
 * (программа собирается заново уже под сотрудником). Отказ сервера — его же
 * словами (тексты R1/R2 есть в словаре). → true, если вход начался.
 */
export async function startActAs(target, { adminName } = {}) {
    if (!target || target.id == null) return false;
    const name = target.full_name || target.username || '';
    const me = shellUser();
    const admin = adminName || (me && (me.full_name || me.username)) || '';
    if (!window.confirm(actAsConfirmText(name, admin))) return false;
    let res;
    try {
        res = await fetch(API, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: target.id }),
        });
    } catch (_) {
        toast('Нет связи с сервером — попробуйте ещё раз.', 'fail');
        return false;
    }
    const json = await readJson(res);
    if (!res.ok) {
        toast((json && json.error && json.error.message) || 'Не удалось войти от имени сотрудника.', 'fail');
        return false;
    }
    reloadPage();
    return true;
}

/**
 * «Вернуться к своей учётной записи»: DELETE /api/auth/act-as → перезагрузка
 * под администратором. Сервер принимает повтор (вторая вкладка, двойной
 * щелчок); 401 — сессии уже нет, перезагрузка приведёт ко входу.
 */
export async function stopActAs() {
    let res;
    try {
        res = await fetch(API, { method: 'DELETE', credentials: 'same-origin' });
    } catch (_) {
        toast('Нет связи с сервером — попробуйте ещё раз.', 'fail');
        return false;
    }
    if (!res.ok && res.status !== 401) {
        const json = await readJson(res);
        toast((json && json.error && json.error.message) || 'Не удалось вернуться к своей учётной записи — попробуйте ещё раз.', 'fail');
        return false;
    }
    reloadPage();
    return true;
}

// ---------------------------------------------------------------------------
// ПОЛОСА ВВЕРХУ ЭКРАНА — тем же приёмом, что полоса лицензии (admin.js
// renderLicenceBanner): прежняя снимается по id, новая встаёт над `.app`.
// ---------------------------------------------------------------------------
const ROLE_RU = {
    admin: 'Администратор', registrar: 'Регистратор', doctor: 'Врач', nurse: 'Медсестра',
    cashier: 'Кассир', lab: 'Лаборант', inventory: 'Склад', callcenter: 'Оператор колл-центра',
};

/** Роль сотрудника словами экрана: своя роль клиники — её названием (как в карточке вверху). */
export function actAsRoleText(user) {
    if (!user) return '';
    const own = typeof user.custom_role_code === 'string' && user.custom_role_code.trim();
    const label = own ? currentRoleLabel() : null;
    if (label) return tr(label);
    return tr(ROLE_RU[user.role] || user.role || '');
}

function backButton(cls) {
    return h('button', {
        class: cls, type: 'button', 'data-act-as-back': '',
        onclick: (ev) => {
            const btn = ev && ev.currentTarget;
            if (btn) btn.disabled = true;
            stopActAs().then((ok) => { if (!ok && btn) btn.disabled = false; });
        },
    }, Icon('ChevronLeft', { size: 14 }), ' ', 'Вернуться к своей учётной записи');
}

/** Полоса «Вы работаете от имени …». Без входа от имени — снимается и не ставится. */
export function renderActAsBanner(user = shellUser()) {
    if (typeof document === 'undefined') return null;
    const old = document.getElementById('act-as-banner');
    if (old) old.remove();
    if (!isActingNow(user)) return null;
    const name = user.full_name || user.username || '';
    const role = actAsRoleText(user);
    const who = role
        ? trf('Вы работаете от имени: {name} ({role})', { name, role })
        : trf('Вы работаете от имени: {name}', { name });
    const banner = h('div', { id: 'act-as-banner', role: 'status' },
        h('span', { class: 'aab-msg' }, Icon('User', { size: 15 }),
            h('span', { class: 'aab-who' }, who),
            h('span', { class: 'aab-sep', 'aria-hidden': 'true' }, '·'),
            h('span', { class: 'aab-rec' }, 'все действия записываются')),
        backButton('aab-back'));
    document.body.insertBefore(banner, document.querySelector('.app') || document.body.firstChild);
    return banner;
}

/** Окно аватара вверху: кто на самом деле работает и «Вернуться». Без входа от имени — null. */
export function actAsAccountBlock(user = shellUser()) {
    const a = actingAdmin(user);
    if (!a) return null;
    return h('div', { id: 'act-as-account', class: 'aab-pop' },
        h('div', { class: 'aab-pop-t' }, Icon('User', { size: 13 }), ' ', 'Работа от имени сотрудника'),
        h('div', { class: 'aab-pop-who' }, trf('Администратор: {name}', { name: a.full_name || '' })),
        backButton('btn btn-outline aab-pop-back'));
}

// ---------------------------------------------------------------------------
// ВХОД ОТ ИМЕНИ КОНЧИЛСЯ САМ (R4) — 409 act_as_ended на любом запросе.
//
// Один раз на страницу, а не на каждый запрос: экран шлёт сразу несколько
// запросов (меню, счётчики, опросы), и каждый из них получит 409. Флаг
// `ending` пропускает только первый: причина показывается одна, «Вернуться»
// уходит один раз, перезагрузка — одна.
// ---------------------------------------------------------------------------
let ending = false;
let rawFetch = null;
let changing = false;   // ревью (вкладки) — перезагрузка после act_as_changed уже начата

/** Начат ли уже возврат после авто-конца или перезагрузка вкладки (для проверок и для boot). */
export function actAsEnding() { return ending || changing; }

/**
 * Вход от имени кончился сам: назвать причину (на языке экрана), сказать
 * серверу «Вернуться» и перезагрузиться под администратором. Повторный вызов —
 * ничего. → true, если этот вызов и начал возврат.
 */
export async function endActAs(reason) {
    if (ending || changing) return false;
    ending = true;
    let text = tr(ACT_AS_MESSAGES.ended);
    if (reason) text += '\n\n' + trf('Причина: {reason}', { reason: tr(String(reason)) });
    try { window.alert(text); } catch (_) { toast(text, 'warn'); }
    const send = rawFetch || ((...a) => fetch(...a));
    try { await send(API, { method: 'DELETE', credentials: 'same-origin' }); } catch (_) { /* перезагрузка спросит сервер заново */ }
    reloadPage();
    return true;
}

function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
}

// ---------------------------------------------------------------------------
// ВКЛАДКИ (ревью безопасности, MEDIUM 3). Сессия (cookie) одна на весь
// браузер, а экран собран в каждой вкладке под своего человека: вкладка A
// вернулась к администратору — вкладка B ещё показывает кабинет врача; вкладка A
// вошла от имени — админская вкладка B пишет уже от имени сотрудника. Поэтому
// каждый запрос API этой страницы несёт номер входа от имени, под который она
// собрана (X-Em-Act-As; 0 — без входа от имени). Номер — из ПЕРВОГО
// /api/auth/me страницы (его и так спрашивает загрузка; запрос, ушедший раньше,
// ждёт его) или из своего входа и возврата; позднейшие /me его не меняют —
// меняет перезагрузка. Сервер, у которого номер другой, записи не выполняет:
// 409 act_as_changed — вкладка один раз говорит об этом и перезагружается
// (вход от имени другой вкладки не заканчивается: «Вернуться» не уходит).
// ---------------------------------------------------------------------------
let tabActAs = null;       // номер вкладки; null — ещё не знаем
let tabActAsWait = null;   // первый /me в пути

/** Путь адреса API этой страницы в нижнем регистре ('/api/…') или null — чужой адрес, не API. */
function apiPathOf(input) {
    const raw = urlOf(input);
    let p = null;
    if (raw.startsWith('/') && !raw.startsWith('//')) p = raw;
    else {
        const m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(raw);
        const host = typeof window !== 'undefined' && window && window.location ? window.location.host : null;
        if (m && host && m[1].toLowerCase() === String(host).toLowerCase()) p = m[2] || '/';
    }
    if (p == null) return null;
    p = p.split(/[?#]/)[0].toLowerCase();
    return p.startsWith('/api/') ? p : null;
}

const asTabNumber = (json) => {
    const n = Number(json && json.act_as_id);
    return Number.isInteger(n) && n > 0 ? n : 0;
};

/** Номер вкладки (ждёт первый /me, если его ещё нет); null — сервер недоступен, без номера. */
function waitTabActAs(orig, target) {
    if (tabActAs != null) return Promise.resolve(tabActAs);
    if (!tabActAsWait) {
        tabActAsWait = Promise.resolve()
            .then(() => orig.call(target, '/api/auth/me', { credentials: 'same-origin', headers: { 'x-em-background': '1' } }))
            .then((r) => (r && r.ok ? r.json().then((j) => { if (tabActAs == null) tabActAs = asTabNumber(j); })
                : (() => { if (tabActAs == null) tabActAs = 0; })()))   // 401: сессии нет — и входа от имени нет
            .catch(() => { /* нет связи — номер узнаем следующим запросом */ })
            .finally(() => { tabActAsWait = null; });
    }
    return tabActAsWait.then(() => tabActAs);
}

/** Тот же запрос с номером вкладки — в заголовках любой формы (объект, Headers, пары). */
function withTabHeader(input, init, value) {
    const v = String(value);
    const base = init && init.headers !== undefined ? init.headers
        : (input && typeof input === 'object' && input.headers) || undefined;
    const name = ACT_AS_TAB_HEADER.toLowerCase();
    let headers;
    if (typeof Headers !== 'undefined' && base instanceof Headers) { headers = new Headers(base); headers.set(ACT_AS_TAB_HEADER, v); }
    else if (Array.isArray(base)) headers = base.filter((p) => String(p && p[0]).toLowerCase() !== name).concat([[ACT_AS_TAB_HEADER, v]]);
    else {
        headers = {};
        for (const [k, val] of Object.entries(base || {})) if (String(k).toLowerCase() !== name) headers[k] = val;
        headers[ACT_AS_TAB_HEADER] = v;
    }
    return { ...(init || {}), headers };
}

/**
 * Вкладка собрана не под того, кто сейчас у сессии (другая вкладка вошла от
 * имени или вернулась): сказать один раз и перезагрузиться. → true, если этот
 * вызов и начал перезагрузку.
 */
export function tabChanged() {
    if (ending || changing) return false;
    changing = true;
    const text = tr(ACT_AS_MESSAGES.changed);
    try { window.alert(text); } catch (_) { toast(text, 'warn'); }
    reloadPage();
    return true;
}

/**
 * Обёртка над fetch всей страницы:
 *   • каждый запрос API этой страницы (кроме /api/auth) несёт номер вкладки
 *     (X-Em-Act-As, см. выше); /me и свой вход и возврат его называют;
 *   • ответ 409 act_as_ended (запросы /api/db, /api/rpc, /api/storage, прямые
 *     fetch экранов — фоновые тоже) запускает endActAs, 409 act_as_changed —
 *     tabChanged.
 * Ответ возвращается вызывающему нетронутым (тело читается из копии).
 * Ставится один раз; повторная установка — ничего.
 */
export function installActAsEndedGuard(target = globalThis) {
    const orig = target && target.fetch;
    if (typeof orig !== 'function' || orig.__actAsGuard) return false;
    rawFetch = (...a) => orig.apply(target, a);
    const guarded = async function guardedFetch(input, init) {
        const path = apiPathOf(input);
        const auth = path != null && path.startsWith('/api/auth/');
        if (path != null && !auth) {
            const n = await waitTabActAs(orig, target);
            if (n != null) init = withTabHeader(input, init, n);
        }
        const resP = orig.call(target, input, init);
        if (auth) {
            const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
            if (path === '/api/auth/me' && tabActAs == null && !tabActAsWait) {
                // Первый /me страницы (загрузка) — номер вкладки; копия тела — до того, как его прочтёт вызывающий.
                tabActAsWait = resP.then((r) => (r && r.ok && typeof r.clone === 'function'
                    ? r.clone().json().then((j) => { if (tabActAs == null) tabActAs = asTabNumber(j); })
                    : (() => { if (r && r.status === 401 && tabActAs == null) tabActAs = 0; })()))
                    .catch(() => {})
                    .finally(() => { tabActAsWait = null; });
            } else if (path === '/api/auth/act-as' && (method === 'POST' || method === 'DELETE')) {
                // Свой вход от имени или возврат — новый номер (следом — перезагрузка).
                resP.then((r) => (r && r.ok && typeof r.clone === 'function'
                    ? r.clone().json().then((j) => { tabActAs = asTabNumber(j); }) : null)).catch(() => {});
            }
        }
        const res = await resP;
        try {
            if (res && res.status === 409 && typeof res.clone === 'function' && path != null) {
                res.clone().json().then((j) => {
                    const e = j && j.error;
                    if (e && e.code === 'act_as_ended') endActAs(e.reason);
                    else if (e && e.code === 'act_as_changed') tabChanged();
                }, () => {});
            }
        } catch (_) { /* проверка ответа не важнее самого ответа */ }
        return res;
    };
    guarded.__actAsGuard = true;
    target.fetch = guarded;
    return true;
}

/** Только для проверок: забыть начатый возврат, перезагрузку и номер вкладки. */
export function __resetActAsForTests() {
    ending = false;
    changing = false;
    rawFetch = null;
    tabActAs = null;
    tabActAsWait = null;
}

// ---------------------------------------------------------------------------
// R3 — ПОДПИСЬ ДОКУМЕНТА ВРАЧА ОТ ЧУЖОГО ИМЕНИ. Сервер отказывает сам; экран
// не предлагает действия, которое заведомо получит отказ: кнопка неактивна,
// подсказка — тот же текст, что у отказа сервера.
// ---------------------------------------------------------------------------

/** Подсказка R3, пока экран работает от имени сотрудника, иначе null. */
export function signLockHint(user = shellUser()) {
    return isActingNow(user) ? ACT_AS_SIGN_REFUSAL : null;
}

/** Запереть кнопку подписи (неактивна + подсказка R3), если экран работает от имени. */
export function lockSignButton(btn, user = shellUser()) {
    if (!btn || !isActingNow(user)) return btn;
    btn.disabled = true;
    btn.setAttribute('title', tr(ACT_AS_SIGN_REFUSAL));
    btn.setAttribute('data-act-as-lock', '');
    return btn;
}

/** Отказ подписи до запроса (тост R3) — true, если подписывать нельзя. */
export function refuseSignWhileActing(user = shellUser()) {
    if (!isActingNow(user)) return false;
    toast(ACT_AS_SIGN_REFUSAL, 'fail');
    return true;
}

// Имя в журналах клиники пишет shared/act-as.js actingActorName: «Иванова А.
// (от имени: адм. Петров П.)». Экран журнала показывает ТЕКУЩЕЕ имя
// сотрудника по номеру — а отметка «от имени» есть только в снимке имени.
// Поэтому снимок с отметкой показывается как есть.
const ACTING_MARK = /\(от имени: адм\. /;

/** Имя действующего для журнала на экране: снимок с отметкой «от имени» — как есть. */
export function actorShownName(row) {
    const snap = row && row.actor_name ? String(row.actor_name) : '';
    if (snap && ACTING_MARK.test(snap)) return snap;
    return (row && row.users && row.users.full_name) || snap || 'Unknown';
}
