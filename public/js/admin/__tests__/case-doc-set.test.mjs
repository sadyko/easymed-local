// CASE_DOC_SET_V2 — экран «Состав истории болезни».
//
// Владелец (2026-09-08): «this list is hardcoded and the system asks for
// filling them, we need to make not hardcoded, and able to add a title
// document ... but we shoud give basic templates list + option».
//
// Проверяется то, ради чего экран и сделан: базовый список виден, «+» заводит
// свой документ, порядок меняется, документ убирается из набора и возвращается,
// а убирается любой документ, включая выписной эпикриз.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this._html = ''; this.disabled = false; this.checked = false;
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', {
            set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; },
            get() { return ''; },
        });
    }
    return el;
}
globalThis.Node = FakeNode;
const BODY = mkEl('body');
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
    execCommand() { return false; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {} };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер» ───────────────────────────────────────────────────────────────
let TYPES = [];
const RESET = () => {
    TYPES = [
        { kind: 'intake', title: '', due_rule: 'clock', due_hours: 2, block: '', sort_order: 10, builtin: true, active: true, locked: false, used: 0 },
        { kind: 'primary', title: '', due_rule: 'clock', due_hours: 24, block: '', sort_order: 20, builtin: true, active: true, locked: false, used: 3 },
        { kind: 'discharge', title: '', due_rule: 'at_discharge', due_hours: null, block: '', sort_order: 30, builtin: true, active: true, locked: false, used: 0 },
    ];
};
let calls = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        calls.push({ name, args: body });
        if (name === 'case_doc_types_list') return ok({ types: TYPES, due_rules: ['clock', 'period', 'surgical', 'at_discharge', 'none'] });
        if (name === 'case_doc_type_save') {
            if (!body.kind) {
                TYPES = TYPES.concat([{ kind: 'own_9', title: body.title, due_rule: body.due_rule, due_hours: body.due_hours,
                    block: body.block || '', sort_order: 40, builtin: false, active: true, locked: false, used: 0 }]);
            }
            return ok({ type: TYPES[TYPES.length - 1] });
        }
        if (name === 'case_doc_type_set_active') {
            TYPES = TYPES.map((t) => (t.kind === body.kind ? Object.assign({}, t, { active: !!body.active }) : t));
            return ok({ type: TYPES.find((t) => t.kind === body.kind) });
        }
        if (name === 'case_doc_types_reorder') {
            const order = body.kinds;
            TYPES = order.map((k) => TYPES.find((t) => t.kind === k)).filter(Boolean);
            return ok({ types: TYPES });
        }
        return ok(null);
    }
    return ok(null);
};

const mod = await import('../views/case-doc-set.js');
const btns = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const named = (root, label) => btns(root).filter((b) => (b.getAttribute('aria-label') || textOf(b) || '').includes(label));

// CASE_DOC_SET_OPEN_V1 — панель свёрнута, пока её не открыли: развёрнутая, она
// делила высоту колонки с чек-листом и тот сжимался в ноль. Тесты открывают её
// тем же щелчком по шапке, каким её открывает человек.
const openPanel = async (panel) => {
    const head = walk(panel).find((e) => e.tagName === 'BUTTON' && String(e.className).split(/\s+/).includes('cds-h'));
    assert.ok(head, 'шапка панели не кнопка — открыть её нечем');
    head.click();
    await settle();
    return panel;
};

// ===========================================================================
// ===========================================================================
// CASE_DOC_SET_SIMPLE_V1 — владелец: «i cannot add, because its asking
// something with dialogue window … make just name of the document + button and
// remove buttons and at the bottom a create document field».
//
// Окно спрашивало имя, правило срока, часы и «только у оперируемых» — четыре
// решения там, где у врача одно: такого документа нет, заведите. Проверяется
// то, что осталось: имя и одна кнопка в строке, строка создания внизу, и
// заведение БЕЗ единого окна.
test('CASE_DOC_SET_SIMPLE_V1: строка — это имя и одна кнопка, без срока, счётчиков и стрелок', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    await openPanel(panel);
    const t = textOf(panel);
    assert.ok(t.includes('Осмотр приёмного врача'), 'встроенный документ не назван словарём');
    // Ничего, кроме имени: ни срока, ни «встроенный», ни числа записей.
    for (const noise of ['2 ч от поступления', 'При выписке', 'встроенный', 'записей: 3']) {
        assert.ok(!t.includes(noise), 'в строке осталось лишнее: ' + noise);
    }
    // По одной кнопке на строку — «убрать». Стрелок и карандаша нет.
    assert.equal(named(panel, 'Выше:').length, 0, 'стрелки порядка вернулись');
    assert.equal(named(panel, 'Изменить:').length, 0, 'правка строки вернулась');
    assert.equal(named(panel, 'Убрать из набора:').length, 3,
        'кнопка «убрать» должна быть у КАЖДОЙ строки: запертых родов больше нет');
});

test('CASE_DOC_SET_SIMPLE_V1: документ заводится строкой снизу, без окна и без срока', async () => {
    RESET(); calls = [];
    const before = BODY.children.length;
    const panel = mod.caseDocSetPanel();
    await settle();
    await openPanel(panel);

    const input = walk(panel).find((e) => e.tagName === 'INPUT' && String(e.className).includes('cds-new-in'));
    assert.ok(input, 'поля создания внизу нет');
    // Поле стоит ПОД списком: список кончился — и вот строка «а такого нет».
    const order = panel.children.map((c) => String(c.className || ''));
    assert.ok(order.findIndex((c) => c.includes('cds-list')) < order.findIndex((c) => c.includes('cds-new')),
        'строка создания оказалась выше списка: ' + order.join(', '));

    input.value = 'Лист анестезиолога';
    const add = walk(panel).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('btn-primary'));
    assert.equal(add.length, 1, 'кнопка создания должна быть одна');
    add[0].click();
    await settle();

    // Ни одного окна не открылось.
    assert.equal(BODY.children.filter((c) => String(c.className || '').includes('modal')).length, 0,
        'заведение документа снова спрашивает окном');
    const sent = calls.filter((c) => c.name === 'case_doc_type_save').pop();
    assert.ok(sent, 'документ не ушёл на сервер');
    assert.equal(sent.args.title, 'Лист анестезиолога');
    // Свой документ заводится БЕЗ СРОКА: он в наборе, но просроченным не висит.
    assert.equal(sent.args.due_rule, 'none');
    assert.equal(sent.args.due_hours, null);
    assert.ok(!sent.args.kind, 'род выдаёт сервер, а не экран');
    assert.equal(input.value, '', 'поле не очистилось под следующий документ');
    assert.ok(textOf(panel).includes('Лист анестезиолога'), 'новый документ не появился в списке');
});

test('CASE_DOC_SET_SIMPLE_V1: пустое имя ничего не заводит', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    await openPanel(panel);
    const input = walk(panel).find((e) => e.tagName === 'INPUT' && String(e.className).includes('cds-new-in'));
    input.value = '   ';
    walk(panel).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('btn-primary'))[0].click();
    await settle();
    assert.equal(calls.filter((c) => c.name === 'case_doc_type_save').length, 0,
        'пустое имя ушло на сервер');
});
test('CASE_DOC_SET_V2: документ убирается из набора и возвращается', async () => {
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    await openPanel(panel);

    named(panel, 'Убрать из набора: Первичный осмотр и план лечения')[0].click();
    await settle();
    const off = calls.filter((c) => c.name === 'case_doc_type_set_active').pop();
    assert.equal(off.args.active, false);
    assert.ok(textOf(panel).includes('Убрано из набора: 1'), 'не сказано, что документ убран, и что записи остались');

    named(panel, 'Вернуть в набор: Первичный осмотр и план лечения')[0].click();
    await settle();
    assert.equal(calls.filter((c) => c.name === 'case_doc_type_set_active').pop().args.active, true);

    // CASE_DOC_SET_OPEN_V1 — замка больше нет: эпикриз убирается, как любой
    // другой документ, а гейт выписки сам смотрит, есть ли он в наборе.
    assert.equal(named(panel, 'Убрать из набора: Выписной эпикриз').length, 1,
        'выписной эпикриз снова нельзя убрать');
    assert.ok(!walk(panel).some((e) => String(e.className || '').includes('cds-lock')), 'замок вернулся');
});

// CASE_DOC_SET_SIMPLE_V1 — стрелок порядка в панели больше нет; серверный
// case_doc_types_reorder жив и проверен в server/services/rpc/case-doc-types.test.js.

test('CASE_DOC_SET_IN_RAIL_V1: панель стоит в левой колонке истории болезни, а создание — одно и под списком', async () => {
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = pathx.dirname(fileURLToPath(import.meta.url));
    const ws = fsx.readFileSync(pathx.join(dir, '..', 'views', 'case-workspace.js'), 'utf8');
    const docs = fsx.readFileSync(pathx.join(dir, '..', 'views', 'documents.js'), 'utf8');
    assert.ok(ws.includes('caseDocSetPanel('), 'состав не появился в истории болезни');
    assert.ok(!docs.includes('caseDocSetPanel'), 'состав остался и в «Документах» — два места на один список');

    // Создание одно и стоит ПОД списком.
    RESET(); calls = [];
    const panel = mod.caseDocSetPanel();
    await settle();
    await openPanel(panel);
    const add = walk(panel).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('btn-primary'));
    assert.equal(add.length, 1, 'кнопок создания должно быть ровно одна: ' + add.length);
    const list = walk(panel).find((e) => String(e.className || '').includes('cds-list'));
    assert.ok(list, 'списка нет');
    const order = panel.children.map((c) => String(c.className || ''));
    assert.ok(order.findIndex((c) => c.includes('cds-list')) < order.findIndex((c) => c.includes('cds-new')),
        'строка создания оказалась выше списка: ' + order.join(', '));
});
