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
const STAFF = [
    { id: 77, full_name: 'Мудунов А. М.', specialty: 'Хирург', role: 'doctor', is_doctor: 1 },
    { id: 78, full_name: 'Кассир К.', specialty: '', role: 'cashier', is_doctor: 0 },
];
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
        if (body.table === 'users') return ok(STAFF);
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

test('НЕСКОЛЬКО УСЛУГ ЗА РАЗ: у каждой своё время, исполнитель один', async () => {
    // Без набора вкладки окно открывается на всём справочнике — в наборе будут
    // услуги из разных разделов, как это и бывает перед операцией.
    const form = await openForm({ typeNames: null });
    const rows = () => walk(form).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('sof-row'));

    // Отмечаем две услуги подряд — окно не закрывается и список не сбрасывается.
    rows().find((e) => textOf(e).includes('Аппендэктомия')).click();
    await settle();
    const second = rows().find((e) => textOf(e).includes('Общий анализ крови'));
    assert.ok(second, 'после первой отметки список услуг пропал');
    second.click();
    await settle();

    // Справа видно, что назначаем, и на какую сумму.
    const t = textOf(form).replace(/ /g, ' ');
    assert.ok(t.includes('Услуг: 2'), 'набор не посчитан: ' + t.slice(0, 200));
    assert.ok(t.includes('3 040 000'), 'сумма набора не показана: ' + t.slice(0, 200));

    // Количество второй строки — своё.
    const qty = walk(form).filter((e) => e.tagName === 'INPUT' && String(e.className).includes('sof-qty'))[1];
    qty.value = '3';
    qty.dispatchEvent({ type: 'input', target: qty });
    await settle();

    // У КАЖДОЙ карточки своё время: кровь утром натощак, КТ днём.
    const dates = walk(form).filter((e) => e.tagName === 'INPUT' && e.attrs.type === 'date');
    const times = walk(form).filter((e) => e.tagName === 'INPUT' && e.attrs.type === 'time');
    assert.equal(dates.length, 2, 'дата не у каждой услуги: ' + dates.length);
    assert.equal(times.length, 2, 'время не у каждой услуги: ' + times.length);
    const setWhen = (i, d, t) => {
        dates[i].value = d; dates[i].dispatchEvent({ type: 'input', target: dates[i] });
        times[i].value = t; times[i].dispatchEvent({ type: 'input', target: times[i] });
    };
    setWhen(0, '2026-09-11', '10:30');
    setWhen(1, '2026-09-12', '07:00');

    // Исполнитель — общий: поручают набор целиком.
    const sel = walk(form).find((e) => e.tagName === 'SELECT');
    assert.ok(textOf(sel).includes('Мудунов'), 'исполнителей не подгрузили: ' + textOf(sel));
    sel.value = '77';

    findBtn(form, 'Назначить').click();
    await settle();
    const calls = rpc.filter((c) => c.name === 'admission_service_add');
    assert.equal(calls.length, 2, 'ушло записей: ' + calls.length);
    assert.deepEqual(calls.map((c) => c.args.service_id).sort((a, b) => a - b), [10, 11]);
    assert.equal(calls.find((c) => c.args.service_id === 11).args.quantity, 3, 'количество строки потерялось');
    for (const c of calls) assert.equal(c.args.doctor_id, 77, 'исполнитель не ушёл');
    const byId = (id) => calls.find((c) => c.args.service_id === id);
    assert.equal(new Date(byId(10).args.planned_at).getTime(), new Date('2026-09-11T10:30:00').getTime(),
        'у первой услуги ушло чужое время');
    assert.equal(new Date(byId(11).args.planned_at).getTime(), new Date('2026-09-12T07:00:00').getTime(),
        'вторая услуга уехала со временем первой — общее время вернулось');
});

test('повторное нажатие СНИМАЕТ услугу с набора', async () => {
    const form = await openForm({});
    const rows = () => walk(form).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('sof-row'));
    rows().find((e) => textOf(e).includes('Аппендэктомия')).click();
    await settle();
    assert.ok(textOf(form).includes('Услуг: 1'));
    rows().find((e) => textOf(e).includes('Аппендэктомия')).click();
    await settle();
    assert.ok(textOf(form).includes('Ничего не выбрано'), 'услуга не снялась: ' + textOf(form).slice(0, 200));
});

test('SERVICE_FORM_GROUPS_V2: набор вкладки — умолчание, а весь справочник в одной плашке', async () => {
    // Владелец, увидев в окне анализов только «Диагностику» и «Лабораторию»:
    // «where is consultations and the procedures?». Разделы вкладки — это
    // умолчание, а не стена: остальное открывается соседней плашкой.
    const form = await openForm({ title: 'Анализы и диагностика', typeNames: ['лаборатор', 'диагностик'] });
    const chips = () => walk(form).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('cf-fchip'));
    const names = chips().map((c) => textOf(c));
    assert.ok(names.some((n) => n.includes('Анализы и диагностика')), 'нет плашки своего набора: ' + names.join(' | '));
    assert.ok(names.some((n) => n.includes('Весь справочник')), 'весь справочник недоступен: ' + names.join(' | '));
    assert.ok(names.some((n) => n.includes('Консультации')), 'консультаций нет ни в одной плашке: ' + names.join(' | '));

    const rowsNow = () => walk(form).filter((e) => String(e.className).includes('sof-row')).map(textOf);
    // Открылось на своём наборе: анализ есть, консультации и операции нет.
    assert.ok(rowsNow().some((n) => n.includes('Общий анализ крови')), 'анализа нет в умолчании');
    assert.ok(!rowsNow().some((n) => n.includes('Приём терапевта')), 'консультация показана до того, как её попросили');
    assert.ok(!rowsNow().some((n) => n.includes('Аппендэктомия')), 'операция показана в умолчании анализов');

    // Одна плашка — и консультация на месте.
    chips().find((c) => textOf(c).includes('Консультации')).click();
    await settle();
    assert.ok(rowsNow().some((n) => n.includes('Приём терапевта')), 'консультацию так и не достать: ' + rowsNow().join(' | '));
    assert.ok(!rowsNow().some((n) => n.includes('Общий анализ крови')), 'выбран раздел, а список не сузился');

    // «Весь справочник» показывает всё, включая хирургию.
    chips().find((c) => textOf(c).includes('Весь справочник')).click();
    await settle();
    const all = rowsNow();
    assert.ok(all.some((n) => n.includes('Аппендэктомия')) && all.some((n) => n.includes('Общий анализ крови')),
        'весь справочник показывает не всё: ' + all.join(' | '));

    // Выбранная плашка ровно одна — иначе непонятно, почему список такой.
    const on = chips().filter((c) => String(c.className).includes('on'));
    assert.equal(on.length, 1, 'помечено плашек: ' + on.length);
});

test('пустой набор окно не отпускает и на сервер ничего не шлёт', async () => {
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
