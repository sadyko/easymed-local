// BUTTON_REENABLE_V1 (2026-10-02) — «Save employee» (employee-editor.js) оставалась
// неактивной после неудачного сохранения. onclick ловил событие в `ev`, выставлял
// `ev.currentTarget.disabled = true`, ждал `await saveEmployee(...)`, и в finally
// читал `ev.currentTarget` СНОВА — но браузер обнуляет currentTarget сразу после
// синхронной фазы диспетчеризации события, то есть ДО того, как async-обработчик
// возобновится после своего первого await. `finally` поэтому молча не делал ничего
// (с `?.`), и кнопка оставалась мёртвой до закрытия и повторного открытия окна —
// теряя правки владельца.
//
// Харнесс ниже — тот же фальшивый DOM, что в employees-card-save.test.mjs
// (employees.js, рядом), с ОДНИМ отличием: dispatchEvent обнуляет currentTarget
// после синхронного цикла по слушателям, как это делают настоящие браузеры;
// без этого харнесс не увидел бы баг вовсе (currentTarget оставался бы валиден
// вечно, и тест был бы зелёным и до, и после правки).
//
// employee-editor.js отдельна от employees.js (своя «Save employee» — без
// переноса на русский, своя модалка): section-crud.js импортирует её
// openEmployeeEditor, но живой путь приложения уходит через employees.js
// (см. picker-invoice.test.mjs's DEAD-set comment). Тест вызывает
// openEmployeeEditor() напрямую — это не требует живого маршрута, только модуль.
//
// Сценарий — новый сотрудник (row = null) без имени: saveEmployee() бросает
// первой же проверкой («Surname or name is required.») без единого сетевого
// похода, так что ни один RPC/таблица не нуждается в особом моке.

import test from 'node:test';
import assert from 'node:assert/strict';

class F {
    constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    append(...cs) { for (const c of cs) if (c) this.children.push(c); }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) {
        this.attrs[k] = String(v); if (k === 'value') this.value = String(v);
        if (k === 'checked') this.checked = true;
        if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
    }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    // BUTTON_REENABLE_V1 — real browsers reset event.currentTarget to null the
    // moment the synchronous dispatch loop finishes, well before an async
    // listener resumes past its first `await`. Reproduce that here, or the bug
    // this test exists for stays invisible (employees-card-save.test.mjs's own
    // copy of this fake DOM never does this, which is fine there — it never
    // exercises this exact after-await read).
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); e.currentTarget = null; return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    focus() { globalThis.__focused = this; } blur() {} scrollTo() {} remove() {} select() {}
    querySelectorAll(sel) {
        const m = String(sel).match(/^(\w+)\[([\w-]+)(?:="([^"]*)")?\]$/); if (!m) return [];
        const out = [];
        const go = (e) => { for (const c of e.children || []) { if (c.tagName === m[1].toUpperCase() && (m[3] === undefined ? (m[2] in (c.attrs || {})) : (c.attrs || {})[m[2]] === m[3])) out.push(c); go(c); } };
        go(this); return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage, addEventListener() {},
    easymed: { state: { user: { id: 2, role: 'admin', is_admin: true } } },
    CLINIC: { id: 1 },
    confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

// Любой /api/db — пустой список без ошибки (хватает для отрисовки формы: нет
// ни филиалов, ни услуг, ни ролей — они не нужны для этого сценария); любой
// другой запрос (specialties через gw, user_branches, extra_role_ids) — тоже
// безопасная пустота. На самом деле ничего из этого даже не понадобится:
// saveEmployee() бросает на первой же проверке (пустое имя), до единого
// сетевого похода — но loadLookups() и extra_role_ids проверяются раньше, при
// самом открытии редактора, так что им нужен хоть какой-то ответ.
globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/db') return { ok: true, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{"data":[]}' };
};

const { openEmployeeEditor } = await import('../views/employee-editor.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

test('неудачное сохранение нового сотрудника: «Save employee» снова активна, не мёртвая кнопка', async () => {
    document.body.children.length = 0;
    await openEmployeeEditor({});   // row = null -> новый сотрудник, пустое имя
    await flush();

    const overlay = document.body.children.find((c) => c.className === 'emp-overlay');
    assert.ok(overlay, 'не нашли открытую модалку редактора сотрудника (emp-overlay)');
    // h() translates text children through tr() centrally (admin.lang = 'ru' above),
    // so the button's English literal ('Save employee') renders as the Russian string.
    const saveBtn = buttonWith(overlay, 'Сохранить сотрудника');
    assert.ok(saveBtn, 'не нашли кнопку «Save employee» / «Сохранить сотрудника»');
    assert.ok(!saveBtn.disabled, 'кнопка изначально должна быть активна');

    saveBtn.click();   // синхронная диспетчеризация: currentTarget валиден в ней; СРАЗУ после — null (как в браузере)
    assert.ok(saveBtn.disabled, 'кнопка не заблокировалась на время сохранения');

    await flush();   // даём async-обработчику дойти до catch/finally после своего await

    assert.ok(!saveBtn.disabled,
        'BUTTON_REENABLE_V1: сохранение не удалось (пустое имя -> «Surname or name is required.»), ' +
        'но кнопка осталась неактивной — окно придётся закрыть и открыть снова, теряя правки.');
});
