// PICKER_TYPE_KEY_V1 / ACT_ADD_SERVICE_V1 — окно выбора услуги ОТКРЫВАЕТСЯ СО
// СПИСКОМ, а не пустым.
//
// Владелец: «can you fix the dialogue window of the adding service and adding
// surgery, i guess its not available».
//
// Окно открывалось, но услуг в нём не было. Причина не в стационаре: раздел
// услуги вычисляется строкой (resolveTypeId возвращает String(type_id)), а в
// колонку разделов кладётся id из таблицы — число. Строгое сравнение '5' !== 5
// отсеивало ВЕСЬ справочник, стоило выбрать раздел. Проверяется то, из-за чего
// окно было бесполезным:
//
//   1. выбранный раздел ПОКАЗЫВАЕТ свои услуги, а не «Услуги не найдены»;
//   2. ограничение разделами пускает свои услуги и не пускает чужие;
//   3. если в этих разделах у клиники пусто, ограничение СНИМАЕТСЯ: пустое
//      окно хуже лишней услуги в списке.
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
    { id: 3, name: 'Лаборатория', active: 1 },
    { id: 5, name: 'Хирургия', active: 1 },
];
const FULL = [
    { id: 10, name: 'Аппендэктомия', price: 3000000, type_id: 5, type: 'procedure', active: 1 },
    { id: 11, name: 'Общий анализ крови', price: 40000, type_id: 3, type: 'lab', active: 1 },
    { id: 12, name: 'Приём терапевта', price: 90000, type_id: 1, type: 'consultation', active: 1 },
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

test('выбранный раздел показывает СВОИ услуги, а не «Услуги не найдены»', async () => {
    SERVICES = FULL;
    const box = await openPicker({ lockedTypeNames: ['хирург'] });
    const t = textOf(box);
    assert.ok(t.includes('Аппендэктомия'), 'раздел выбран, а услуг в окне нет: ' + t.slice(0, 200));
    assert.ok(!t.includes('Услуги не найдены'), 'окно говорит «Услуги не найдены» при полном справочнике');
    assert.ok(!t.includes('Общий анализ крови'), 'в разделе «Хирургия» показан анализ');
});

test('ограничение разделами пускает свои услуги и не пускает чужие', async () => {
    SERVICES = FULL;
    const box = await openPicker({ allowedTypeNames: ['лаборатор', 'диагностик'] });
    const t = textOf(box);
    assert.ok(t.includes('Общий анализ крови'), 'анализа нет в окне анализов');
    assert.ok(!t.includes('Аппендэктомия'), 'операция попала в окно анализов');
    assert.ok(!t.includes('Приём терапевта'), 'консультация попала в окно анализов');
});

test('если в разделе у клиники пусто — ограничение снимается, а не пустеет окно', async () => {
    // Клиника завела операции «Процедурами»: раздела «Хирургия» у неё нет.
    SERVICES = [{ id: 20, name: 'Аппендэктомия', price: 3000000, type_id: null, type: 'procedure', active: 1 }];
    const box = await openPicker({ allowedTypeNames: ['хирург'] });
    const t = textOf(box);
    assert.ok(t.includes('Аппендэктомия'), 'окно осталось пустым: врачу нечем назначить операцию');
});

test('услугу МОЖНО ВЫБРАТЬ И ДОБАВИТЬ: щелчок по строке, затем «Назначить»', async () => {
    SERVICES = FULL;
    const picked = [];
    const box = await openPicker({
        allowedTypeNames: ['хирург'], confirmLabel: 'Назначить',
        onPick: (payload) => picked.push(payload),
    });
    // Строка услуги — кнопка в колонке услуг.
    const row = walk(box).find((e) => e.tagName === 'BUTTON'
        && String(e.className).includes('sched-col-row') && textOf(e).includes('Аппендэктомия'));
    assert.ok(row, 'услуги нечем выбрать: строки нет');
    row.click();
    await settle();

    const done = walk(box).find((e) => e.tagName === 'BUTTON' && textOf(e).includes('Назначить'));
    assert.ok(done, 'кнопки подтверждения нет');
    assert.ok(!done.hasAttribute('disabled'),
        'услуга выбрана, а подтвердить нельзя — ровно то, на что жалуется владелец');
    done.click();
    await settle();
    assert.equal(picked.length, 1, 'выбор не дошёл до экрана, который начисляет услугу');
    assert.equal(picked[0].service.id, 10, 'дошла не та услуга');
});
