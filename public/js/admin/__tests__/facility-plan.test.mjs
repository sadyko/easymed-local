// FACILITY_PLAN_V1 (2026-09-11) — план клиники в «Помещениях».
//
// Владелец: «the user should be able to visually build a hospital … not
// entering data into a spreadsheet». Что здесь закреплено:
//   1. ДЕРЕВО И ПЛАН ИЗ ДАННЫХ: этажи, отделения и помещения на плане — те же
//      строки floors/rooms/wards, ничего не прибито в разметке;
//   2. НЕРАЗМЕЩЁННОЕ РАСКЛАДЫВАЕТСЯ САМО и рисуется пунктиром; настоящие
//      координаты пишутся в базу, когда плитку сдвинули (pointer-события);
//   3. КАРТОЧКА ПОМЕЩЕНИЯ называет отделение, тип, врачей и оборудование;
//      «Добавить оборудование» пишет справочник и размещение;
//   4. ПОИСК ведёт на этаж совпадения; фильтр отделения гасит чужие плитки;
//   5. ПУСТАЯ КЛИНИКА говорит «Постройте клинику» с одной кнопкой.
import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM ────────────────────────────────────────────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.hidden = false; this.disabled = false; this.checked = false;
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatch(t, e) { for (const fn of this._l[t] || []) fn(Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, e || {})); }
    click() { this.dispatch('click', { currentTarget: this }); }
    setPointerCapture() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
    focus() {} blur() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        return { contains: (c) => String(s.className).split(/\s+/).includes(c),
            add(c) { if (!this.contains(c)) s.className = (s.className + ' ' + c).trim(); },
            remove(c) { s.className = String(s.className).split(/\s+/).filter((x) => x !== c).join(' '); },
            toggle() {} };
    }
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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, easymed: { state: { user: { id: 1, role: 'admin' } } } };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.setTimeout = globalThis.setTimeout;

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
// Значки — SVG-разметка в тексте поддельного узла; из текста экрана их убираем.
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ').replace(/<svg[\s\S]*?<\/svg>/g, '');
const byClass = (root, c) => walk(root).filter((e) => String(e.className || '').split(/\s+/).includes(c));
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const settle = () => new Promise((r) => setTimeout(r, 30));

// ─── данные «сервера»: настоящий макет /api/db со select/insert/update/delete ─
let T;
function seed() {
    T = {
        floors: [{ id: 1, name: '1 этаж', level: 1, active: 1 }, { id: 2, name: '2 этаж', level: 2, active: 1 }],
        departments: [{ id: 10, name: 'Кардиология', kind: 'clinical', active: 1 }, { id: 11, name: 'Лаборатория', kind: 'laboratory', active: 1 }],
        rooms: [
            { id: 101, name: 'Кабинет 101', code: '101', room_type: 'consultation', capacity: 2, queue_mode: 'none', floor_id: 1, department_id: 10, active: 1, plan_x: 32, plan_y: 32, plan_w: 176, plan_h: 96 },
            { id: 102, name: 'Кабинет 102', code: '102', room_type: 'consultation', capacity: 0, queue_mode: 'none', floor_id: 1, department_id: 10, active: 1, plan_x: 0, plan_y: 0, plan_w: 0, plan_h: 0 },
            { id: 201, name: 'Кабинет 201', code: '201', room_type: 'consultation', capacity: 0, queue_mode: 'none', floor_id: 2, department_id: null, active: 1, plan_x: 0, plan_y: 0, plan_w: 0, plan_h: 0 },
        ],
        wards: [{ id: 50, name: 'Палата 1', code: 'П1', type: 'general', floor_id: 1, department_id: 10, billing_mode: 'daily', price_per_day: 100000, price_per_hour: 0, active: 1, plan_x: 0, plan_y: 0, plan_w: 0, plan_h: 0 }],
        beds: [{ id: 501, ward_id: 50, code: '1', type: 'standard', status: 'free', active: 1 }, { id: 502, ward_id: 50, code: '2', type: 'standard', status: 'occupied', active: 1 }],
        users: [
            { id: 7, full_name: 'Каримов Азиз', is_doctor: true, specialty: 'Кардиолог', room_id: 101, is_active: true },
            { id: 8, full_name: 'Алиева Мадина', is_doctor: true, specialty: 'Кардиолог', room_id: null, is_active: true },
        ],
        equipment: [{ id: 900, name: 'ЭКГ', kind: '', active: 1 }],
        room_equipment: [{ id: 1, room_id: 101, ward_id: null, equipment_id: 900, quantity: 1 }],
    };
}
function matches(row, f) {
    const v = row[f.col];
    switch (f.op) {
        case 'eq': return String(v) === String(f.val);
        case 'in': return (f.val || []).map(String).includes(String(v));
        default: return true;
    }
}
let dbCalls = [];
let nextId = 5000;
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (u.startsWith('/api/rpc/')) {
        const name = decodeURIComponent(u.slice('/api/rpc/'.length));
        dbCalls.push({ rpc: name, args: body });
        if (name === 'room_assign_doctors') {
            for (const id of body.add || []) { const d = T.users.find((x) => x.id === id); if (d) d.room_id = body.room_id; }
            for (const id of body.remove || []) { const d = T.users.find((x) => x.id === id); if (d) d.room_id = null; }
        }
        return { ok: true, json: async () => ({ data: { ok: true } }) };
    }
    if (u.startsWith('/api/db')) {
        dbCalls.push(body);
        const rows = T[body.table] || (T[body.table] = []);
        const hit = rows.filter((r) => (body.filters || []).every((f) => matches(r, f)));
        if (body.op === 'insert') {
            const list = Array.isArray(body.values) ? body.values : [body.values];
            const made = list.map((v) => { const r = { id: nextId++, ...v }; rows.push(r); return r; });
            return { ok: true, json: async () => ({ data: body.single ? made[0] : made }) };
        }
        if (body.op === 'update') { for (const r of hit) Object.assign(r, body.values); return { ok: true, json: async () => ({ data: hit }) }; }
        if (body.op === 'delete') { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { ok: true, json: async () => ({ data: [] }) }; }
        return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(hit)) }) };
    }
    return { ok: true, json: async () => ({ data: null }) };
};

const { renderRoomsSetup } = await import('../views/rooms-setup.js');
const { autoLayout, floorItems, GRID } = await import('../views/facility-plan.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');

async function screen() {
    dbCalls = [];
    BODY.children.length = 0;
    const root = mkEl('div');
    await renderRoomsSetup(root);
    await settle();
    return root;
}
const tiles = (root) => byClass(root, 'fp-room');
const tileOf = (root, key) => tiles(root).find((t) => t.attrs['data-key'] === key);

test('дерево и план — из данных: два этажа, отделение, помещения на своём этаже', async () => {
    seed();
    const root = await screen();
    assert.ok(byClass(root, 'fp')[0], 'план не смонтирован');
    const floors = byClass(root, 'fp-node--floor');
    assert.deepStrictEqual(floors.map((f) => textOf(f).trim().replace(/\s+\d+$/, '')), ['1 этаж', '2 этаж']);
    // Первый этаж открыт: на плане его три помещения, кабинет 201 — на втором.
    assert.deepStrictEqual(tiles(root).map((t) => t.attrs['data-key']).sort(), ['room:101', 'room:102', 'ward:50']);
    assert.ok(textOf(byClass(root, 'fp-node--dept')[0]).includes('Кардиология'), 'отделение в дереве');
    // Обзор клиники — числами.
    assert.ok(textOf(byClass(root, 'fp-figs')[0]).includes('2'), 'обзор без чисел');
});

test('размещённая плитка стоит по координатам, неразмещённые раскладываются сами и рисуются пунктиром', async () => {
    seed();
    const root = await screen();
    const placed = tileOf(root, 'room:101');
    assert.strictEqual(placed.style.left, '32px');
    assert.strictEqual(placed.style.top, '32px');
    assert.ok(!String(placed.className).includes('is-auto'));
    const auto = tileOf(root, 'room:102');
    assert.ok(String(auto.className).includes('is-auto'), 'неразмещённое не помечено пунктиром');
    assert.ok(parseInt(auto.style.top, 10) >= 32 + 96 + GRID, 'авторазметка легла поверх размещённого');
    // Чистая функция раскладки — ничего не пишет в базу.
    const laid = autoLayout(floorItems({ rooms: T.rooms, wards: T.wards, bedsByWard: {} }, 1));
    assert.ok(laid.every((i) => i.w > 0 && i.h > 0));
    assert.ok(!dbCalls.some((c) => c.op === 'update'), 'раскладка сама что-то записала');
});

test('сдвинутая мышью плитка пишет координаты в базу по сетке', async () => {
    seed();
    const root = await screen();
    const t = tileOf(root, 'room:101');
    t.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    t.dispatch('pointermove', { clientX: 170, clientY: 145 });
    t.dispatch('pointerup', { clientX: 170, clientY: 145 });
    await settle();
    const upd = dbCalls.find((c) => c.op === 'update' && c.table === 'rooms');
    assert.ok(upd, 'координаты не записаны');
    assert.deepStrictEqual(upd.values, { plan_x: 96, plan_y: 80, plan_w: 176, plan_h: 96 }, 'координаты не по сетке 16: ' + JSON.stringify(upd.values));
    assert.ok(upd.filters.some((f) => f.col === 'id' && String(f.val) === '101'));
});

test('щелчок без движения ничего не пишет; растягивание за угол меняет размер', async () => {
    seed();
    const root = await screen();
    const t = tileOf(root, 'room:101');
    t.dispatch('pointerdown', { clientX: 10, clientY: 10, button: 0, pointerId: 1 });
    t.dispatch('pointerup', { clientX: 11, clientY: 10 });
    await settle();
    assert.ok(!dbCalls.some((c) => c.op === 'update'), 'щелчок записал координаты');
    const handle = byClass(t, 'fp-resize')[0];
    t.dispatch('pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 1, target: handle });
    t.dispatch('pointermove', { clientX: 40, clientY: 30 });
    t.dispatch('pointerup', { clientX: 40, clientY: 30 });
    await settle();
    const upd = dbCalls.find((c) => c.op === 'update' && c.table === 'rooms');
    assert.ok(upd, 'размер не записан');
    assert.deepStrictEqual(upd.values, { plan_x: 32, plan_y: 32, plan_w: 224, plan_h: 128 });
});

test('карточка помещения: отделение, тип, врачи и оборудование; добавление оборудования пишет две строки', async () => {
    seed();
    const root = await screen();
    tileOf(root, 'room:101').click();
    await settle();
    const side = byClass(root, 'fp-side')[0];
    const t = textOf(side);
    assert.ok(t.includes('Кардиология'), 'нет отделения');
    assert.ok(t.includes('Каримов Азиз'), 'нет врача');
    assert.ok(t.includes('ЭКГ'), 'нет оборудования');
    assert.ok(findBtn(side, 'Назначить врача') && findBtn(side, 'Добавить оборудование') && findBtn(side, 'Перенести на этаж'));
    // Добавить новое оборудование по названию.
    findBtn(side, 'Добавить оборудование').click();
    const modal = BODY.children[BODY.children.length - 1];
    const inputs = walk(modal).filter((n) => n.tagName === 'INPUT');
    const nameInp = inputs.find((n) => n.attrs.placeholder && n.attrs.placeholder.includes('ЭКГ'));
    nameInp.value = 'Кушетка'; nameInp.dispatch('input', { target: nameInp });
    findBtn(modal, 'Добавить').click();
    await settle();
    assert.ok(dbCalls.some((c) => c.op === 'insert' && c.table === 'equipment' && c.values.name === 'Кушетка'), 'справочник не пополнен');
    assert.ok(dbCalls.some((c) => c.op === 'insert' && c.table === 'room_equipment' && c.values.room_id === 101), 'размещение не записано');
});

test('«Назначить врача» переносит врача через RPC, а не пишет в users', async () => {
    seed();
    const root = await screen();
    tileOf(root, 'room:102').click();
    await settle();
    findBtn(byClass(root, 'fp-side')[0], 'Назначить врача').click();
    const modal = BODY.children[BODY.children.length - 1];
    const boxes = walk(modal).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox');
    const madina = boxes[1];
    madina.checked = true; madina.dispatch('change', { target: madina });
    findBtn(modal, 'Назначить').click();
    await settle();
    const rpc = dbCalls.find((c) => c.rpc === 'room_assign_doctors');
    assert.ok(rpc, 'врач не назначен через RPC');
    assert.deepStrictEqual(rpc.args.add, [8]);
    assert.ok(!dbCalls.some((c) => c.table === 'users' && c.op === 'update'), 'план полез писать users напрямую');
});

test('поиск ведёт на этаж совпадения; фильтр отделения гасит чужие плитки', async () => {
    seed();
    const root = await screen();
    const search = byClass(root, 'fp-search')[0];
    // SEARCH_DEBOUNCE_V1 — поле type=search отвечает с задержкой; ждём её.
    search.value = '201'; search.dispatch('input', { target: search });
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(tileOf(root, 'room:201'), 'поиск не перевёл на второй этаж: плитки ' + tiles(root).map((t) => t.attrs['data-key']).join(',') + ' · ' + textOf(byClass(root, 'fp-crumbs')[0] || mkEl('i')));
    // Обратно на первый этаж — и фильтр по отделению.
    search.value = ''; search.dispatch('input', { target: search });
    await new Promise((r) => setTimeout(r, 1200));
    byClass(root, 'fp-node--floor')[0].click();
    await settle();
    const sel = walk(root).find((n) => n.tagName === 'SELECT' && textOf(n).includes('Все отделения'));
    sel.value = '11'; sel.dispatch('change', { target: sel });
    await settle();
    assert.ok(tiles(root).every((t) => String(t.className).includes('is-dim')), 'плитки чужого отделения не погасли');
});

test('пустая клиника говорит «Постройте клинику» и ведёт к первому этажу', async () => {
    seed();
    T.floors = []; T.rooms = []; T.wards = []; T.beds = [];
    const root = await screen();
    assert.ok(textOf(root).includes('Постройте клинику'));
    const btn = findBtn(root, 'Создать первый этаж');
    assert.ok(btn, 'нет кнопки первого этажа');
    btn.click();
    const modal = BODY.children[BODY.children.length - 1];
    assert.ok(modal && textOf(modal).includes('Новый этаж'), 'кнопка не открыла окно этажа');
});
