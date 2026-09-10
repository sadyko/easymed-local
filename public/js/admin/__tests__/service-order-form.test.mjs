// SERVICE_ORDER_FORM_V1 — окно «назначить услугу»: как у назначений, со
// временем.
//
// Владелец: «we need to make dialogue window in the services like in the
// prescriptions, select time and date etc» — и до этого: «i cannot add a
// service in the adding service».
//
// Тест проходит ВЕСЬ путь врача: открыть окно, выбрать услугу из справочника,
// поставить дату и время, нажать «Назначить» — и смотрит, что ушло на сервер.
import test from 'node:test';
import assert from 'node:assert/strict';


// ─── минимальный DOM (тот же, что в title-sheet.test.mjs) ───────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    removeAttribute(k) { delete this.attrs[k]; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
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
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {}, open: () => null };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const allBtns = (root, label) => walk(root).filter((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const topOverlay = () => BODY.children.filter((c) => c.className === 'modal').pop() || null;
const lastToast = () => { const t = BODY.children.filter((c) => c.attrs && c.attrs.id === 'toast').pop(); return t ? t.textContent : ''; };
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер»: справочник разделов и услуг местной клиники ─────────────────
let SERVICES = [];
const TYPES = [
    { id: 1, name: 'Консультации', active: 1 },
    { id: 2, name: 'Диагностика', active: 1 },
    { id: 3, name: 'Лаборатория', active: 1 },
    { id: 5, name: 'Хирургия', active: 1 },
];
const FULL = [
    { id: 10, name: 'Аппендэктомия', price: 3000000, type_id: 5, type: 'procedure', active: 1 },
    { id: 11, name: 'Общий анализ крови', price: 40000, type_id: 3, type: 'lab', active: 1 },
    { id: 12, name: 'Приём терапевта', price: 90000, type_id: 1, type: 'consultation', active: 1 },
    { id: 13, name: 'УЗИ брюшной полости', price: 160000, type_id: 2, type: 'imaging', active: 1 },
];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш запрос */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const gone = () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'нет такого' } }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/db')) {
        if (body.table === 'service_types') return ok(TYPES);
        if (body.table === 'services') return ok(SERVICES);
        return ok([]);
    }
    if (u.startsWith('/api/rpc/')) {
        rpc.push({ name: u.slice('/api/rpc/'.length), args: body });
        return ok({ line: { id: 1 } });
    }
    return gone();   // шлюз медкора: локальной клинике его нет, и окно живёт без него
};


let rpc = [];
const { openServiceOrderForm } = await import('../views/service-order-form.js');

const openForm = async (opts) => {
    rpc = [];
    SERVICES = FULL;
    openServiceOrderForm(Object.assign({ admissionId: 11, title: 'Операция', typeNames: ['хирург'] }, opts));
    await settle();
    const modals = BODY.children.filter((c) => String(c.className || '').includes('modal'));
    assert.ok(modals.length, 'окно назначения не открылось');
    return modals[modals.length - 1];
};

test('услуга выбирается из справочника и уходит на сервер С ВРЕМЕНЕМ', async () => {
    const form = await openForm({});
    assert.ok(textOf(form).includes('Услуга не выбрана'), 'окно не говорит, что услуга ещё не выбрана');

    // 1. Справочник — В САМОМ ОКНЕ: второго, полноэкранного, больше нет.
    assert.equal(BODY.children.filter((c) => String(c.className || '').includes('modal')).length, 1,
        'поверх формы открылось второе окно — на его величину и жаловались');
    const row = walk(form).find((e) => e.tagName === 'BUTTON'
        && String(e.className).includes('sof-row') && textOf(e).includes('Аппендэктомия'));
    assert.ok(row, 'услуги в списке нет: ' + textOf(form).slice(0, 200));
    row.click();
    await settle();

    // 2. Выбранная услуга видна в окне вместе с ценой.
    assert.ok(textOf(form).includes('Аппендэктомия'), 'выбранная услуга не показана: ' + textOf(form).slice(0, 200));
    assert.ok(textOf(form).includes('3 000 000'), 'цена услуги не показана');

    // 3. Дата и время — как в назначениях.
    const inputs = walk(form).filter((e) => e.tagName === 'INPUT');
    const dateInp = inputs.find((e) => e.attrs.type === 'date');
    const timeInp = inputs.find((e) => e.attrs.type === 'time');
    assert.ok(dateInp && timeInp, 'в окне нет даты и времени');
    dateInp.value = '2026-09-11';
    timeInp.value = '10:30';

    findBtn(form, 'Назначить').click();
    await settle();
    const call = rpc.find((c) => c.name === 'admission_service_add');
    assert.ok(call, 'назначение не ушло на сервер');
    assert.equal(call.args.service_id, 10, 'ушла не та услуга');
    assert.equal(call.args.quantity, 1);
    assert.ok(call.args.planned_at, 'время назначения не ушло — ради него окно и делалось');
    // Местное время переводится в общее: сравниваем момент, а не строку.
    assert.equal(new Date(call.args.planned_at).getTime(), new Date('2026-09-11T10:30:00').getTime());
});

test('SERVICE_FORM_GROUPS_V1: разделы видны строкой и сужают список', async () => {
    // Окно анализов: лаборатория и диагностика — два раздела, между ними и
    // выбирают. Услуга-операция в это окно не попадает вовсе.
    const form = await openForm({ title: 'Анализы и диагностика', typeNames: ['лаборатор', 'диагностик'] });
    const chips = walk(form).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('cf-fchip'));
    const names = chips.map((c) => textOf(c));
    assert.ok(names.some((n) => n.includes('Все')), 'нет строки «Все»: ' + names.join(' | '));
    assert.ok(names.some((n) => n.includes('Лаборатория')), 'раздела «Лаборатория» нет: ' + names.join(' | '));
    assert.ok(names.some((n) => n.includes('Диагностика')), 'раздела «Диагностика» нет: ' + names.join(' | '));

    // Пока раздел не выбран — видно всё разрешённое.
    const rowsNow = () => walk(form).filter((e) => String(e.className).includes('sof-row')).map(textOf);
    assert.ok(rowsNow().some((n) => n.includes('Общий анализ крови')), 'анализа нет в общем списке');

    // Выбрали «Диагностика» — анализ ушёл, потому что он из другого раздела.
    chips.find((c) => textOf(c).includes('Диагностика')).click();
    await settle();
    assert.ok(!rowsNow().some((n) => n.includes('Общий анализ крови')),
        'раздел выбран, а список не сузился: ' + rowsNow().join(' | '));
    // И выбранный раздел ПОМЕЧЕН: иначе непонятно, почему список короткий.
    const on = walk(form).filter((e) => String(e.className).includes('cf-fchip') && String(e.className).includes('on'));
    assert.equal(on.length, 1, 'помечен не один раздел: ' + on.map(textOf).join(' | '));
    assert.ok(textOf(on[0]).includes('Диагностика'));
});

test('в списке — только услуги нужного раздела', async () => {
    const form = await openForm({});
    const names = walk(form).filter((e) => String(e.className).includes('sof-row')).map((e) => textOf(e));
    assert.ok(names.some((n) => n.includes('Аппендэктомия')), 'хирургии нет в списке хирургии');
    assert.ok(!names.some((n) => n.includes('Общий анализ крови')), 'анализ попал в список операций');
    assert.ok(!names.some((n) => n.includes('Приём терапевта')), 'консультация попала в список операций');
});

test('без выбранной услуги окно не отпускает и на сервер ничего не шлёт', async () => {
    const form = await openForm({});
    findBtn(form, 'Назначить').click();
    await settle();
    assert.equal(rpc.filter((c) => c.name === 'admission_service_add').length, 0,
        'пустое назначение ушло на сервер');
    assert.ok(BODY.children.includes(form), 'окно закрылось, потеряв введённое');
});

test('«уже выполнено» гасит дату и время и шлёт назначение без плана', async () => {
    const form = await openForm({});
    walk(form).find((e) => e.tagName === 'BUTTON' && String(e.className).includes('sof-row')
        && textOf(e).includes('Аппендэктомия')).click();
    await settle();

    const chk = walk(form).filter((e) => e.tagName === 'INPUT' && e.attrs.type === 'checkbox')[0];
    chk.checked = true;
    chk.dispatchEvent({ type: 'change', target: chk });
    await settle();
    const dateInp = walk(form).find((e) => e.tagName === 'INPUT' && e.attrs.type === 'date');
    assert.equal(dateInp.disabled, true, 'дата осталась живой у уже выполненной услуги');

    findBtn(form, 'Назначить').click();
    await settle();
    const call = rpc.find((c) => c.name === 'admission_service_add');
    assert.ok(call, 'назначение не ушло');
    assert.equal(call.args.planned_at, undefined, 'у выполненного не должно быть плана — его начисляют сейчас');
});
