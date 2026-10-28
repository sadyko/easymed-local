// ADMIN_ACT_AS_V1 (2026-10-28) — ЭКРАН ВХОДА ОТ ИМЕНИ СОТРУДНИКА (задача 2).
//
// Спецификация — docs/specs/2026-10-28-admin-act-as-design.md, «Интерфейс».
// Здесь — общая часть экрана (admin/act-as-client.js) на поддельном DOM:
//   • кто видит «Войти как сотрудник» и от чьего имени можно войти (R1, R2);
//   • подтверждение словами спецификации; вход и «Вернуться» — с перезагрузкой;
//   • полоса вверху экрана и блок в окне аватара;
//   • 409 act_as_ended от ЛЮБОГО запроса (db, rpc, прямой fetch, фоновый) —
//     причина показывается ОДИН раз, «Вернуться» уходит один раз, перезагрузка
//     одна; /me с act_as_ended — тот же путь;
//   • кнопки подписи R3 — неактивны с подсказкой;
//   • имя «… (от имени: адм. …)» в журналах пациента и счёта, номер — сотрудника;
//   • каждая новая строка — в ru/uz/en, без кириллицы в uz/en.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── поддельный DOM: родители, поиск по id и классу ─────────────────────────
class F {
    constructor(t) {
        this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; this.parentNode = null;
    }
    appendChild(c) { if (c && typeof c === 'object') { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; } this.children.push(c); return c; }
    insertBefore(c, ref) {
        if (c && typeof c === 'object') { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; }
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
        return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    append(...cs) { for (const c of cs) this.appendChild(c); }
    get firstChild() { return this.children[0] || null; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() {} blur() {}
    get textContent() { return this._t + this.children.map((c) => (c && c.textContent) || '').join(''); }
    set textContent(v) { this._t = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        const list = () => String(s.className || '').split(/\s+/).filter(Boolean);
        return { contains: (c) => list().includes(c), add: (c) => { if (!list().includes(c)) s.className = list().concat(c).join(' '); }, remove: (c) => { s.className = list().filter((x) => x !== c).join(' '); }, toggle() {} };
    }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = ''; s.attrs.html = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const body = mk('body');
const appEl = mk('div'); appEl.className = 'app';
body.appendChild(appEl);
const toastMsgs = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return ''; }, set(v) { toastMsgs.push(String(v)); } });
globalThis.Node = F;
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body, documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => (id === 'toast' ? toastEl : walk(body).find((n) => n.id === id) || null),
    querySelector: (sel) => (sel === '.app' ? walk(body).find((n) => n.classList && n.classList.contains('app')) || null : null),
};
const store = new Map([['admin.lang', 'ru']]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let RELOADS = 0;
const ALERTS = [];
let CONFIRM_ANSWER = true;
const CONFIRMS = [];
globalThis.window = {
    location: { hostname: 'localhost', reload: () => { RELOADS += 1; } },
    localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; },
    confirm: (m) => { CONFIRMS.push(String(m)); return CONFIRM_ANSWER; },
    alert: (m) => { ALERTS.push(String(m)); },
    easymed: { state: { user: null } },
};
globalThis.CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };

// ─── поддельный сервер ──────────────────────────────────────────────────────
const CALLS = [];
let SERVER = async () => ({ status: 200, body: { data: null } });
const reply = (status, payload) => {
    const make = () => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(payload)), clone: () => make() });
    return make();
};
// Ревью безопасности (вкладки) — заголовки запроса любой формы (объект, Headers, пары).
const headersOf = (hs) => {
    const out = {};
    if (!hs) return out;
    if (typeof hs.forEach === 'function' && !Array.isArray(hs)) hs.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    else for (const [k, v] of (Array.isArray(hs) ? hs : Object.entries(hs))) out[String(k).toLowerCase()] = String(v);
    return out;
};
globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: headersOf(opts.headers) };
    CALLS.push(call);
    const r = await SERVER(call);
    return reply(r.status, r.body);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const AA = await import('../act-as-client.js');
const { setLang } = await import('../i18n.js');
const { STRINGS } = await import('../i18n-strings.js');
const { ACT_AS_SIGN_REFUSAL, ACT_AS_MESSAGES, ACT_AS_END } = await import('../../shared/act-as.js');

const ADMIN = { id: 1, full_name: 'Петров П.', role: 'admin', extra_roles: [] };
const ACTING = { id: 3, full_name: 'Иванова А.', username: 'doc', role: 'doctor', extra_roles: [], acting_admin: { id: 1, full_name: 'Петров П.' } };
const setUser = (u) => { window.easymed.state.user = u; };
const reset = () => { CALLS.length = 0; toastMsgs.length = 0; ALERTS.length = 0; CONFIRMS.length = 0; RELOADS = 0; CONFIRM_ANSWER = true; setLang('ru'); };

// ─── R1 / R2 на экране ──────────────────────────────────────────────────────

test('R1: «Войти как сотрудник» — администратору (основной или дополнительной ролью) из своей учётной записи', () => {
    assert.equal(AA.canStartActAs(ADMIN), true);
    assert.equal(AA.canStartActAs({ id: 2, role: 'doctor', extra_roles: ['admin'] }), true, 'администратор дополнительной ролью');
    assert.equal(AA.canStartActAs({ id: 2, role: 'doctor', extra_roles: '["admin"]' }), true, 'дополнительные роли строкой из базы');
    assert.equal(AA.canStartActAs(ACTING), false, 'уже работает от имени — сначала вернуться');
    assert.equal(AA.canStartActAs({ ...ADMIN, acting_admin: { id: 9, full_name: 'X' } }), false);
    assert.equal(AA.canStartActAs({ id: 4, role: 'nurse', extra_roles: [] }), false, 'не администратор');
    assert.equal(AA.canStartActAs({ ...ADMIN, must_change_password: true }), false, 'временный пароль');
    assert.equal(AA.canStartActAs(null), false);
});

test('ревью MEDIUM 4: своя роль администратора без «Сотрудники: Изменение» — ни кнопки, ни журнала входов', async () => {
    const P = await import('../permissions.js');
    try {
        for (const level of ['none', 'view']) {
            P.setOwnCustomGrants({ 'settings.employees': level });
            assert.equal(AA.canStartActAs(ADMIN), false, '«Сотрудники»: ' + level);
        }
        P.setOwnCustomGrants({ settings: 'none' });
        assert.equal(AA.canStartActAs(ADMIN), false, 'закрыт весь раздел «Настройки»');
        P.setOwnCustomGrants({ 'settings.employees': 'edit' });
        assert.equal(AA.canStartActAs(ADMIN), true, '«Сотрудники: Изменение»');
    } finally { P.setOwnCustomGrants(null); }
    assert.equal(AA.canStartActAs(ADMIN), true, 'штатный администратор — как прежде');
});

test('R2: войти можно только как активного, уже входившего сотрудника — не себя и не администратора', () => {
    const custom = [{ code: 'reg_to_admin', base_role: 'admin' }, { code: 'senior_reg', base_role: 'registrar' }];
    const ok = (t) => AA.actAsTargetOk(t, { selfId: 1, customRoles: custom });
    const base = { id: 5, role: 'nurse', extra_roles: [], is_active: true, must_change_password: false };
    assert.equal(ok(base), true);
    assert.equal(ok({ ...base, custom_role_code: 'senior_reg' }), true, 'своя роль не на основе администратора');
    assert.equal(ok({ ...base, is_active: false }), false, 'отключённый');
    assert.equal(ok({ ...base, must_change_password: true }), false, 'временный пароль — ещё не входил');
    assert.equal(ok({ ...base, id: 1 }), false, 'себя');
    assert.equal(ok({ ...base, role: 'admin' }), false, 'администратор основной ролью');
    assert.equal(ok({ ...base, extra_roles: ['admin'] }), false, 'администратор дополнительной ролью');
    assert.equal(ok({ ...base, extra_roles: '["admin"]' }), false, 'дополнительные роли строкой');
    assert.equal(ok({ ...base, custom_role_code: 'reg_to_admin' }), false, 'своя роль на основе администратора');
    assert.equal(ok(null), false);
});

test('подтверждение — слова спецификации; на uz/en — без кириллицы, кроме имён', () => {
    reset();
    // Ревью — имя с точкой на конце не получает вторую («Иванова А.. Каждое…»).
    assert.equal(AA.actAsConfirmText('Иванова А.', 'Петров П.'),
        'Вы будете работать от имени Иванова А. Каждое действие запишется как «Администратор Петров П. от имени Иванова А.». Подписывать документы врача от его имени нельзя. Вернуться — кнопкой вверху экрана.');
    assert.equal(AA.actAsConfirmText('Иванова Анна', 'Петров П.'),
        'Вы будете работать от имени Иванова Анна. Каждое действие запишется как «Администратор Петров П. от имени Иванова Анна». Подписывать документы врача от его имени нельзя. Вернуться — кнопкой вверху экрана.');
    setLang('en');
    assert.doesNotMatch(AA.actAsConfirmText('Ivanova A.', 'Petrov P.'), /\.\./, 'en: без двух точек');
    setLang('ru');
    for (const lang of ['uz', 'en']) {
        setLang(lang);
        const text = AA.actAsConfirmText('NAME', 'ADMIN');
        assert.ok(text.includes('NAME') && text.includes('ADMIN'), lang + ': ' + text);
        assert.doesNotMatch(text, /[Ѐ-ӿ]/, lang + ': ' + text);
    }
    setLang('ru');
});

test('вход: подтверждение → POST {user_id} → перезагрузка; «Отмена» — ничего; отказ сервера — его словами, без перезагрузки', async () => {
    reset();
    setUser(ADMIN);
    const target = { id: 3, full_name: 'Иванова А.' };

    CONFIRM_ANSWER = false;
    assert.equal(await AA.startActAs(target), false);
    assert.equal(CALLS.length, 0, '«Отмена» — запроса нет');
    assert.match(CONFIRMS[0], /Вы будете работать от имени Иванова А\..*Администратор Петров П\. от имени Иванова А\./);

    CONFIRM_ANSWER = true;
    SERVER = async () => ({ status: 200, body: { ok: true, user: ACTING, acting_admin: ACTING.acting_admin } });
    assert.equal(await AA.startActAs(target), true);
    assert.deepEqual(CALLS.map((c) => [c.method, c.url, c.body]), [['POST', '/api/auth/act-as', { user_id: 3 }]]);
    assert.equal(RELOADS, 1, 'после входа программа собирается заново под сотрудником');

    reset();
    SERVER = async () => ({ status: 400, body: { error: { code: 'bad_request', message: ACT_AS_MESSAGES.targetNew } } });
    assert.equal(await AA.startActAs(target), false);
    assert.equal(RELOADS, 0);
    assert.deepEqual(toastMsgs, [ACT_AS_MESSAGES.targetNew]);
    setLang('en');
    toastMsgs.length = 0;
    await AA.startActAs(target);
    assert.doesNotMatch(toastMsgs[0], /[Ѐ-ӿ]/, 'отказ сервера — на языке экрана: ' + toastMsgs[0]);
    setLang('ru');
});

test('«Вернуться»: DELETE → перезагрузка; 401 (сессии уже нет) — тоже перезагрузка; сбой — тост, без перезагрузки', async () => {
    reset();
    SERVER = async () => ({ status: 200, body: { ok: true, user: ADMIN, acting_admin: null } });
    assert.equal(await AA.stopActAs(), true);
    assert.deepEqual(CALLS.map((c) => [c.method, c.url]), [['DELETE', '/api/auth/act-as']]);
    assert.equal(RELOADS, 1);
    reset();
    SERVER = async () => ({ status: 401, body: { error: { code: 'unauthorized' } } });
    assert.equal(await AA.stopActAs(), true);
    assert.equal(RELOADS, 1);
    reset();
    SERVER = async () => ({ status: 500, body: { error: { message: 'x' } } });
    assert.equal(await AA.stopActAs(), false);
    assert.equal(RELOADS, 0);
    assert.equal(toastMsgs.length, 1);
});

// ─── полоса и окно аватара ──────────────────────────────────────────────────

test('полоса вверху: «Вы работаете от имени: имя (роль) · все действия записываются · Вернуться» — над .app, одна; без входа от имени — нет', async () => {
    reset();
    assert.equal(AA.renderActAsBanner(ADMIN), null);
    assert.equal(document.getElementById('act-as-banner'), null);

    AA.renderActAsBanner(ACTING);
    AA.renderActAsBanner(ACTING);   // повтор (смена языка) — не две полосы
    const banners = walk(body).filter((n) => n.id === 'act-as-banner');
    assert.equal(banners.length, 1);
    const banner = banners[0];
    assert.equal(body.children.indexOf(banner) + 1, body.children.indexOf(appEl), 'полоса стоит прямо над .app');
    assert.match(banner.textContent, /Вы работаете от имени: Иванова А\. \(Врач\)/);
    assert.match(banner.textContent, /все действия записываются/);
    const back = walk(banner).find((n) => n.tagName === 'BUTTON');
    assert.match(back.textContent, /Вернуться к своей учётной записи/);
    assert.ok(walk(banner).some((n) => n.tagName === 'SVG'), 'значок — через Icon()');

    SERVER = async () => ({ status: 200, body: { ok: true, user: ADMIN, acting_admin: null } });
    back.click();
    await tick(5);
    assert.deepEqual(CALLS.map((c) => [c.method, c.url]), [['DELETE', '/api/auth/act-as']]);
    assert.equal(RELOADS, 1, '«Вернуться» — перезагрузка под администратором');

    setLang('en');
    AA.renderActAsBanner(ACTING);
    const en = document.getElementById('act-as-banner').textContent;
    assert.match(en, /You are acting as: Иванова А\. \(Doctor\)/);
    assert.doesNotMatch(en.replace('Иванова А.', ''), /[Ѐ-ӿ]/, en);
    setLang('uz');
    AA.renderActAsBanner(ACTING);
    assert.doesNotMatch(document.getElementById('act-as-banner').textContent.replace('Иванова А.', ''), /[Ѐ-ӿ]/);
    setLang('ru');
    AA.renderActAsBanner(ADMIN);   // вернулись — полосы нет
    assert.equal(document.getElementById('act-as-banner'), null);
});

test('окно аватара: кто работает на самом деле и «Вернуться»; без входа от имени — ничего', () => {
    reset();
    assert.equal(AA.actAsAccountBlock(ADMIN), null);
    const block = AA.actAsAccountBlock(ACTING);
    assert.match(block.textContent, /Работа от имени сотрудника/);
    assert.match(block.textContent, /Администратор: Петров П\./);
    assert.ok(walk(block).some((n) => n.tagName === 'BUTTON' && /Вернуться к своей учётной записи/.test(n.textContent)));
});

// ─── 409 act_as_ended ───────────────────────────────────────────────────────

test('409 act_as_ended от любого запроса — причина один раз, «Вернуться» один раз, перезагрузка одна; ответ — вызывающему как есть', async () => {
    reset();
    AA.__resetActAsForTests();
    const before = globalThis.fetch;
    assert.equal(AA.installActAsEndedGuard(globalThis), true);
    assert.equal(AA.installActAsEndedGuard(globalThis), false, 'вторая установка — ничего');
    assert.notEqual(globalThis.fetch, before);
    SERVER = async (c) => (c.url.startsWith('/api/auth/')
        ? { status: 200, body: { ok: true } }
        : { status: 409, body: { error: { code: 'act_as_ended', message: ACT_AS_MESSAGES.ended, reason: ACT_AS_END.expired } } });

    // Три запроса разом (экран, меню, фоновый опрос) — через настоящие двери.
    const { supabase } = await import('../../supabase.js');
    const [db, rpc, direct] = await Promise.all([
        supabase.from('visits').update({ status: 'x' }).eq('id', 1),
        supabase.rpc('procedures_list', {}),
        fetch('/api/users', { headers: { 'x-em-background': '1' } }),
    ]);
    await tick(10);
    assert.equal(db.error.status, 409, 'запрос /api/db получил свой ответ');
    assert.equal(rpc.error.code, 'act_as_ended', 'RPC получил свой ответ');
    assert.equal(direct.status, 409, 'прямой fetch получил свой ответ');
    assert.equal(ALERTS.length, 1, 'причина показана один раз: ' + JSON.stringify(ALERTS));
    assert.match(ALERTS[0], /Работа от имени сотрудника закончилась/);
    assert.match(ALERTS[0], /Причина: Истекло/);
    assert.deepEqual(CALLS.filter((c) => c.url === '/api/auth/act-as').map((c) => c.method), ['DELETE'], '«Вернуться» — один раз');
    assert.equal(RELOADS, 1, 'перезагрузка — одна');

    // Ещё запросы, пока страница перезагружается, — ничего нового.
    await supabase.rpc('procedures_list', {});
    await tick(10);
    assert.equal(ALERTS.length, 1);
    assert.equal(RELOADS, 1);
    assert.equal(AA.actAsEnding(), true);
});

test('409 другого рода (конфликт записи) и ответы не API — возврата не запускают', async () => {
    reset();
    AA.__resetActAsForTests();
    AA.installActAsEndedGuard(globalThis);   // уже стоит — ничего
    SERVER = async () => ({ status: 409, body: { error: { code: 'notes_conflict', message: 'x' } } });
    await fetch('/api/db', { method: 'POST', body: '{}' });
    SERVER = async () => ({ status: 409, body: { error: { code: 'act_as_ended', reason: 'Истекло' } } });
    await fetch('/assets/x.json');
    await tick(10);
    assert.equal(ALERTS.length, 0);
    assert.equal(RELOADS, 0);
});

test('причина авто-конца — на языке экрана (uz/en без кириллицы)', async () => {
    for (const lang of ['en', 'uz']) {
        reset();
        AA.__resetActAsForTests();
        setLang(lang);
        SERVER = async () => ({ status: 200, body: { ok: true } });
        await AA.endActAs(ACT_AS_END.unavailable);
        assert.equal(ALERTS.length, 1);
        assert.doesNotMatch(ALERTS[0], /[Ѐ-ӿ]/, lang + ': ' + ALERTS[0]);
    }
    setLang('ru');
    AA.__resetActAsForTests();
});

test('/me после авто-конца: db-auth отдаёт act_as_ended, rehydrateUserFromSession несёт его рядом с пользователем', async () => {
    reset();
    const { makeAuthBridge } = await import('../../db-auth.js');
    const me = async () => reply(200, { user: ADMIN, act_as_ended: { reason: ACT_AS_END.expired } });
    const bridge = makeAuthBridge({ fetch: me, base: '/api/auth' });
    const got = await bridge.getUser();
    assert.equal(got.data.user.id, 1);
    assert.deepEqual(got.data.act_as_ended, { reason: ACT_AS_END.expired });
    const plain = makeAuthBridge({ fetch: async () => reply(200, { user: ADMIN }), base: '/api/auth' });
    assert.equal((await plain.getUser()).data.act_as_ended, null);

    SERVER = async (c) => (c.url === '/api/auth/me' ? { status: 200, body: { user: ADMIN, act_as_ended: { reason: ACT_AS_END.expired } } } : { status: 200, body: {} });
    const { rehydrateUserFromSession, actorFromUser } = await import('../auth.js');
    const row = await rehydrateUserFromSession();
    assert.equal(row.id, 1);
    assert.deepEqual(row.act_as_ended, { reason: ACT_AS_END.expired });
    SERVER = async () => ({ status: 200, body: { user: ACTING } });
    const acting = await rehydrateUserFromSession();
    assert.equal(acting.act_as_ended, undefined);

    // Оболочка знает, кто работает на самом деле: actorFromUser несёт acting_admin.
    assert.deepEqual(actorFromUser(ACTING).acting_admin, { id: 1, full_name: 'Петров П.' });
    assert.equal(actorFromUser(ADMIN).acting_admin, null);
});

// ─── R3: кнопки подписи ─────────────────────────────────────────────────────

test('R3: кнопка подписи — неактивна с подсказкой отказа, пока работают от имени; без входа от имени — как была', () => {
    reset();
    const b1 = mk('button');
    AA.lockSignButton(b1, ADMIN);
    assert.notEqual(b1.disabled, true);
    assert.equal(b1.getAttribute('title'), null);
    const b2 = mk('button');
    AA.lockSignButton(b2, ACTING);
    assert.equal(b2.disabled, true);
    assert.equal(b2.getAttribute('title'), ACT_AS_SIGN_REFUSAL);
    assert.equal(AA.signLockHint(ACTING), ACT_AS_SIGN_REFUSAL);
    assert.equal(AA.signLockHint(ADMIN), null);
    assert.equal(AA.refuseSignWhileActing(ADMIN), false);
    assert.equal(AA.refuseSignWhileActing(ACTING), true);
    assert.deepEqual(toastMsgs, [ACT_AS_SIGN_REFUSAL]);
    setLang('en');
    const b3 = mk('button');
    AA.lockSignButton(b3, ACTING);
    assert.doesNotMatch(b3.getAttribute('title'), /[Ѐ-ӿ]/);
    setLang('ru');
});

// ─── имя в журналах клиники ─────────────────────────────────────────────────

test('журналы пациента и счёта: имя «сотрудник (от имени: адм. …)», номер — сотрудника; без входа от имени — просто имя', async () => {
    reset();
    const writes = [];
    SERVER = async (c) => { if (c.url === '/api/db' && c.body.op === 'insert') writes.push(c.body); return { status: 200, body: { data: null } }; };
    const { logInvoiceAction, currentActor } = await import('../views/invoice-actions.js');
    const { logPatientActivity } = await import('../views/activity-log.js');

    setUser(ACTING);
    assert.deepEqual(currentActor(), { id: 3, name: 'Иванова А. (от имени: адм. Петров П.)', role: 'doctor' });
    await logInvoiceAction({ id: 7, invoice_number: 'INV-7', visit_id: 1 }, { action: 'refund', fromStatus: 'paid', toStatus: 'refunded' });
    await logPatientActivity({ patientId: 9, entityType: 'invoice', action: 'refund' });
    const inv = writes.find((w) => w.table === 'invoice_audit_log').values;
    const act = writes.find((w) => w.table === 'patient_activity_log').values;
    for (const row of [inv, act]) {
        assert.equal(row.actor_name, 'Иванова А. (от имени: адм. Петров П.)');
        assert.equal(row.actor_user_id, 3, 'номер — сотрудника: права и принадлежность записей — его');
    }

    writes.length = 0;
    setUser({ id: 3, full_name: 'Иванова А.', role: 'doctor', acting_admin: null });
    await logInvoiceAction({ id: 7 }, { action: 'refund' });
    assert.equal(writes[0].values.actor_name, 'Иванова А.');
    setUser(null);
});

test('экран журнала: снимок имени с отметкой «от имени» показывается как есть, без неё — текущее имя сотрудника', async () => {
    // Снимок — ровно тот, что пишут сервер и экран (shared/act-as.js): разойтись форматам нельзя.
    const { actingActorName } = await import('../../shared/act-as.js');
    const snap = actingActorName(ACTING, 'Иванова А.');
    assert.equal(AA.actorShownName({ actor_name: snap, users: { full_name: 'Иванова Анна' } }), snap);
    assert.equal(AA.actorShownName({ actor_name: 'Иванова А. (от имени: адм. Петров П.)', users: { full_name: 'Иванова Анна' } }), 'Иванова А. (от имени: адм. Петров П.)');
    assert.equal(AA.actorShownName({ actor_name: 'Иванова А.', users: { full_name: 'Иванова Анна' } }), 'Иванова Анна');
    assert.equal(AA.actorShownName({ actor_name: 'Иванова А.' }), 'Иванова А.');
    assert.equal(AA.actorShownName({}), 'Unknown');
});

// ─── словарь ────────────────────────────────────────────────────────────────

const ACT_AS_UI_STRINGS = [
    'Войти как сотрудник',
    'Вы будете работать от имени {name}. Каждое действие запишется как «Администратор {admin} от имени {name}». Подписывать документы врача от его имени нельзя. Вернуться — кнопкой вверху экрана.',
    'Не удалось войти от имени сотрудника.',
    'Нет связи с сервером — попробуйте ещё раз.',
    'Не удалось вернуться к своей учётной записи — попробуйте ещё раз.',
    'Вы работаете от имени: {name} ({role})',
    'Вы работаете от имени: {name}',
    'все действия записываются',
    'Вернуться к своей учётной записи',
    'Работа от имени сотрудника',
    'Администратор: {name}',
    'Причина: {reason}',
];

test('словарь: каждая новая строка — ru/uz/en, uz/en без кириллицы, дыры {…} одни и те же', () => {
    const bad = [];
    for (const k of ACT_AS_UI_STRINGS) {
        const e = STRINGS[k];
        if (!e) { bad.push('нет в словаре: ' + k); continue; }
        if (e.ru !== k) bad.push('ru ≠ ключ: ' + k);
        for (const l of ['uz', 'en']) {
            if (!e[l] || !e[l].trim()) bad.push(l + ' пусто: ' + k);
            else if (/[Ѐ-ӿ]/.test(e[l])) bad.push(l + ' с кириллицей: ' + e[l]);
            const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
            if (holes(e[l]) !== holes(k)) bad.push(l + ' дыры: ' + e[l]);
        }
    }
    assert.deepEqual(bad, []);
});

// ─── Ревью безопасности (MEDIUM 3): вкладки одной сессии ────────────────────
// Сессия одна на браузер. Вкладка шлёт в каждом запросе API номер входа от
// имени, под который собрана (X-Em-Act-As; 0 — без него), — узнаёт его из
// ПЕРВОГО /api/auth/me страницы (или своего входа и возврата). Сервер, у
// которого номер другой (другая вкладка вошла или вернулась), отвечает 409
// act_as_changed: вкладка один раз говорит об этом и перезагружается.

test('ревью MEDIUM 3: каждый запрос API несёт номер вкладки из первого /me; /me — один на всех; /api/auth и чужие адреса — без номера', async () => {
    reset();
    AA.__resetActAsForTests();
    AA.installActAsEndedGuard(globalThis);   // уже стоит — ничего
    SERVER = async (c) => (c.url === '/api/auth/me' ? { status: 200, body: { user: ACTING, act_as_id: 7 } } : { status: 200, body: { data: null } });
    const { supabase } = await import('../../supabase.js');
    await Promise.all([
        supabase.from('visits').update({ status: 'x' }).eq('id', 1),
        supabase.rpc('procedures_list', {}),
        fetch('/api/storage/clinic-docs/x.pdf', { method: 'POST', headers: new Headers({ 'Content-Type': 'application/pdf' }), body: '{}' }),
        fetch('/api/users/3', { method: 'PATCH', headers: [['Content-Type', 'application/json']], body: '{}' }),
    ]);
    const me = CALLS.filter((c) => c.url === '/api/auth/me');
    assert.equal(me.length, 1, 'номер узнаётся один раз: ' + JSON.stringify(CALLS.map((c) => c.url)));
    assert.equal(me[0].headers['x-em-act-as'], undefined, '/api/auth — без номера');
    const api = CALLS.filter((c) => !c.url.startsWith('/api/auth/'));
    assert.equal(api.length, 4);
    for (const c of api) assert.equal(c.headers['x-em-act-as'], '7', c.url);
    assert.equal(api.find((c) => c.url.startsWith('/api/storage')).headers['content-type'], 'application/pdf', 'свои заголовки запроса целы (Headers)');
    assert.equal(api.find((c) => c.url.startsWith('/api/users')).headers['content-type'], 'application/json', 'свои заголовки запроса целы (пары)');

    await fetch('/api/db', { method: 'POST', body: '{}' });
    assert.equal(CALLS.filter((c) => c.url === '/api/auth/me').length, 1, 'дальше — без нового /me');
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '7');
    // Поздний /me (другая вкладка вернулась) номер вкладки не меняет — его меняет только перезагрузка.
    SERVER = async (c) => (c.url === '/api/auth/me' ? { status: 200, body: { user: ADMIN, act_as_id: 0 } } : { status: 200, body: { data: null } });
    await (await fetch('/api/auth/me')).json();
    await fetch('/api/db', { method: 'POST', body: '{}' });
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '7');
    await fetch('https://example.org/api/db', { method: 'POST', body: '{}' });
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], undefined, 'чужой адрес — без номера');
});

test('ревью MEDIUM 3: номер — из /me самой страницы (boot), второго /me нет; без сессии (401) — 0; свой вход от имени меняет номер', async () => {
    reset();
    AA.__resetActAsForTests();
    AA.installActAsEndedGuard(globalThis);   // стоит с прошлых проверок — ничего; одна эта проверка — ставит
    SERVER = async (c) => (c.url === '/api/auth/me' ? { status: 200, body: { user: ADMIN, act_as_id: 0 } }
        : c.url === '/api/auth/act-as' ? { status: 200, body: { ok: true, act_as_id: 9 } } : { status: 200, body: {} });
    const r = await fetch('/api/auth/me');   // как db-auth.js getUser при загрузке
    assert.equal((await r.json()).act_as_id, 0, 'ответ /me — вызывающему как есть');
    await fetch('/api/rpc/x', { method: 'POST', body: '{}' });
    assert.equal(CALLS.filter((c) => c.url === '/api/auth/me').length, 1);
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '0');
    await fetch('/api/auth/act-as', { method: 'POST', body: '{"user_id":3}' });
    await fetch('/api/rpc/x', { method: 'POST', body: '{}' });
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '9', 'после своего входа от имени — его номер');

    reset();
    AA.__resetActAsForTests();
    SERVER = async (c) => (c.url === '/api/auth/me' ? { status: 401, body: {} } : { status: 200, body: {} });
    await fetch('/api/rpc/x', { method: 'POST', body: '{}' });
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '0', 'без сессии — без входа от имени');
});

test('ревью-2: номер вкладки ставит /me, по которому собран экран (rehydrate несёт act_as_id), — поверх раннего', async () => {
    reset();
    AA.__resetActAsForTests();
    AA.installActAsEndedGuard(globalThis);
    let n = 0;
    SERVER = async (c) => (c.url === '/api/auth/me' ? (n++ === 0 ? { status: 200, body: { user: ADMIN, act_as_id: 0 } } : { status: 200, body: { user: ACTING, act_as_id: 7 } })
        : { status: 200, body: { data: null } });
    await (await fetch('/api/auth/me')).json();   // проверка связи при загрузке — первый /me
    const { rehydrateUserFromSession } = await import('../auth.js');
    const row = await rehydrateUserFromSession();   // экран собирается по этому
    assert.equal(row.id, 3);
    assert.equal(row.act_as_id, 7, 'rehydrate несёт номер вкладки');
    AA.setTabActAs(row.act_as_id);   // так делает admin.js boot()
    await fetch('/api/db', { method: 'POST', body: '{}' });
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '7');
    AA.setTabActAs(null);
    await fetch('/api/db', { method: 'POST', body: '{}' });
    assert.equal(CALLS[CALLS.length - 1].headers['x-em-act-as'], '0', 'нет номера в ответе — без входа от имени');
    const { makeAuthBridge } = await import('../../db-auth.js');
    const bridge = makeAuthBridge({ fetch: async () => reply(200, { user: ACTING, act_as_id: 7 }), base: '/api/auth' });
    assert.equal((await bridge.getUser()).data.act_as_id, 7, 'db-auth getUser отдаёт act_as_id');
    AA.__resetActAsForTests();
});

test('ревью MEDIUM 3: 409 act_as_changed — одно предупреждение (на языке экрана), одна перезагрузка, без «Вернуться»', async () => {
    for (const lang of ['ru', 'en']) {
        reset();
        AA.__resetActAsForTests();
        AA.installActAsEndedGuard(globalThis);
        setLang(lang);
        SERVER = async (c) => (c.url === '/api/auth/me' ? { status: 200, body: { user: ACTING, act_as_id: 7 } }
            : { status: 409, body: { error: { code: 'act_as_changed', message: ACT_AS_MESSAGES.changed } } });
        const { supabase } = await import('../../supabase.js');
        const [a, b] = await Promise.all([supabase.rpc('procedures_list', {}), fetch('/api/db', { method: 'POST', body: '{}' })]);
        await tick(10);
        assert.equal(a.error.code, 'act_as_changed', 'RPC получил свой ответ');
        assert.equal(b.status, 409);
        assert.equal(ALERTS.length, 1, lang + ': ' + JSON.stringify(ALERTS));
        if (lang === 'ru') assert.match(ALERTS[0], /Учётная запись в этой вкладке сменилась/);
        else assert.doesNotMatch(ALERTS[0], /[Ѐ-ӿ]/, ALERTS[0]);
        assert.equal(RELOADS, 1);
        assert.equal(CALLS.filter((c) => c.url === '/api/auth/act-as').length, 0, 'вход от имени другой вкладки не заканчивается');
    }
    setLang('ru');
    AA.__resetActAsForTests();
});
