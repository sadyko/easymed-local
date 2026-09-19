// PICKER_CATALOG_EVERYWHERE_V1 — окно выбора услуги открывается КАТАЛОГОМ, а не
// тремя колонками, и умеет работать БЕЗ пациента и БЕЗ брони времени.
//
// Владелец, открыв новое окно «Быстрая регистрация» и нажав «+Услуги»: «i see an
// old version with 3 columns». Окна два в одном файле: старый каскад «Группы
// услуг → Услуги → Врачи» и каталог со сметой. Каталог включается attachMode, но
// до сих пор он был написан под ОДИН случай — «добавить услугу к уже открытому
// визиту», — и потому требовал двух вещей, которых у регистрации нет:
//
//   1. пациента: без него смета показывала кнопку «Привязать пациента», то есть
//      предлагала завести второго, пока первого вводят в окне позади;
//   2. врача и времени на каждой строке: иначе кнопка сметы оставалась серой.
//      Пришедшему без записи слот не нужен, а врача регистратор выбирает в
//      своей же строке.
//
// Здесь проверяется обе стороны: с requireSlot: false смета собирается и без
// врача, а по умолчанию — по-прежнему нет.
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в service-picker-groups.test.mjs) ─────────
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
const hasClass = (e, c) => String(e.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((e) => hasClass(e, c));
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── «сервер» ──────────────────────────────────────────────────────────────
// Приём терапевта — услуга С ИСПОЛНИТЕЛЯМИ: тип 'consultation' маршрутизируется
// в кабинет, значит в подборе врача участвуют оба врача клиники (DOCTOR_FALLBACK_V1),
// и каталог считает строку требующей врача (__needsDoc).
const TYPES = [{ id: 1, name: 'Консультации', active: 1 }];
const SERVICES = [
    { id: 10, name: 'Приём терапевта', price: 90000, type_id: 1, type: 'consultation', active: 1, duration_minutes: 30, requires_doctor: true, tax_rate: 12 },
];
const USERS = [
    { id: 7, full_name: 'Петров П.П.', specialty: 'Терапевт', is_doctor: true, active: 1, role: 'doctor' },
    { id: 8, full_name: 'Сидоров С.С.', specialty: 'Терапевт', is_doctor: true, active: 1, role: 'doctor' },
];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* не наш запрос */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    const gone = () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'нет такого' } }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/db')) {
        if (body.table === 'service_types') return ok(TYPES);
        if (body.table === 'services') return ok(SERVICES);
        if (body.table === 'users') return ok(USERS);
        if (body.table === 'service_templates') return ok([]);
        return ok([]);
    }
    if (u.startsWith('/api/rpc/')) return ok({});
    return gone();   // шлюз медкора: локальной клинике его нет, и окно живёт без него
};

const { openServicePickerModal } = await import('../views/service-picker-modal.js');

const overlays = () => BODY.children.filter((c) => String(c.className || '').includes('modal'));
const openPicker = async (opts) => {
    const before = overlays().length;
    openServicePickerModal(Object.assign({ onPick: () => {} }, opts));
    await settle();
    const o = overlays();
    assert.ok(o.length > before, 'окно выбора услуги не открылось');
    return o[o.length - 1];
};
const addBtnFor = (box, name) => byClass(box, 'wzc-svc')
    .filter((row) => textOf(row).includes(name))
    .map((row) => byClass(row, 'wzc-add')[0])
    .find(Boolean);

test('быстрая регистрация: каталог со сметой, без пациента и без обязательного слота', async () => {
    const picked = [];
    const box = await openPicker({
        attachMode: true, requireSlot: false,
        title: 'Добавить услуги', ctaLabel: 'Готово',
        onPick: (p) => { picked.push(p); },
    });

    // 1. Это КАТАЛОГ, а не три колонки — ровно то, на что смотрит владелец.
    assert.ok(byClass(box, 'wzc-grid').length === 1, 'каталога в окне нет');
    assert.equal(walk(box).filter((e) => String(e.className || '').includes('sched-col')).length, 0,
        'в окне остались старые колонки «Группы услуг → Услуги → Врачи»');

    // 2. Пациента здесь не привязывают: его вводят в окне регистрации позади.
    assert.ok(!textOf(box).includes('Привязать пациента'),
        'смета предлагает завести второго пациента, пока первого вводят в окне-хозяине');

    // 3. Кнопка сметы называется так, как просил вызывающий.
    const cta = () => byClass(overlays()[overlays().length - 1] || box, 'wzc-cta')[0];
    assert.ok(cta(), 'у сметы нет кнопки действия');
    assert.equal(textOf(cta()).trim(), 'Готово', 'кнопка сметы называется по-своему: ' + textOf(cta()));
    assert.equal(cta().disabled, true, 'пустая смета предлагает нажать «Готово»');

    // 4. Услуга с исполнителями добавляется БЕЗ выбора врача и времени.
    const add = addBtnFor(box, 'Приём терапевта');
    assert.ok(add, 'услуги нечем добавить: кнопки в карточке нет');
    add.click();
    await settle();
    assert.equal(cta().disabled, false,
        'смета требует врача и время там, где записи на время нет — «Готово» серое');

    // 5. Нажатие отдаёт услуги вызывающему по одной и закрывает окно.
    cta().click();
    await settle();
    assert.equal(picked.length, 1, 'выбор не дошёл до окна регистрации');
    assert.equal(picked[0].service.id, 10, 'дошла не та услуга');
    assert.equal(picked[0].doctor, null, 'врач выдуман там, где его не выбирали');
    assert.ok(!BODY.children.includes(box), 'окно каталога осталось открытым поверх регистрации');
});

test('по умолчанию слот по-прежнему обязателен: без врача и времени «Добавить к визиту» не нажать', async () => {
    const box = await openPicker({ attachMode: true, patient: { id: 1, fullName: 'Иванов И.И.' } });
    const cta = () => byClass(overlays()[overlays().length - 1] || box, 'wzc-cta')[0];
    assert.equal(textOf(cta()).trim(), 'Добавить к визиту', 'подпись по умолчанию сменилась');

    const add = addBtnFor(box, 'Приём терапевта');
    assert.ok(add, 'услуги нечем добавить: кнопки в карточке нет');
    add.click();
    await settle();
    assert.equal(cta().disabled, true,
        'услугу с исполнителями пустили в визит без врача и времени — привязка перестала спрашивать слот');
});
