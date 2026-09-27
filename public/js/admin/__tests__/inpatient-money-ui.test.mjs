// INPATIENT_MONEY_FIX_V1 — консоль койки (ward-beds.js) после исправления денег
// стационара:
//   D6 — дата поступления уходит полным временем с зоной, а не «местным без
//        зоны», которое сервер читал как UTC и сдвигал срок на пояс;
//   D7 — услугу заводит RPC admission_service_add (цену ставит сервер), а не
//        прямая вставка в admission_services с ценой каталога из браузера;
//   D-minor — «Товары для пациента» по умолчанию идут в счёт, как и расход
//        из истории болезни.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    click() { for (const fn of this._l.click || []) fn({ currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    remove() {}
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: mkEl('body'), documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} } };
// I18N_LOCALE_PIN_V1 — pins the admin UI language to 'ru' regardless of the
// host OS locale. i18n.js's detect() checks localStorage.getItem('admin.lang')
// (the bare global, NOT window.localStorage above) before ever falling back
// to navigator.language/languages — so without this, the view below renders
// in whatever language the machine running the test defaults to: Russian on
// this dev box, English on GitHub's ubuntu-latest runner, breaking every
// assertion on a Russian string below there, identically, every run. Must be
// set before the view import: i18n.js picks the language once, at its own
// module-load time.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: null }), headers: { getSetCookie: () => [] } });

const wb = await import('../views/ward-beds.js');
const SRC = readFileSync(new URL('../views/ward-beds.js', import.meta.url), 'utf8');

test('D6: местное время формы уходит на сервер тем же мгновением в UTC', () => {
    const local = '2026-09-20T10:00';
    assert.equal(wb.localInputToIso(local), new Date(2026, 8, 20, 10, 0).toISOString());
    assert.equal(wb.localInputToIso(''), '', 'пустое — как есть, отказ скажет сервер');
    assert.match(SRC, /set_admission_date', \{ admission_id: adm\.id, admitted_at: localInputToIso\(inp\.value\) \}/);
});

test('D7: услуги у койки заводит сервер, прямой вставки в admission_services нет', () => {
    assert.ok(!/from\('admission_services'\)\.insert\(/.test(SRC), 'прямая вставка строки стационара вернулась');
    assert.match(SRC, /supabase\.rpc\('admission_service_add', \{/);
});

test('D-minor: «Товары для пациента» по умолчанию — в счёт пациенту', () => {
    assert.match(SRC, /const billChk = h\('input', \{ type: 'checkbox', checked: true,/);
});

// FINAL_ROLES_SYNC_FIX_V1 (I2) — кнопку «Добавить услугу» у койки видит тот, кому
// сервер строку заведёт (admission_service_add): медсестра, регистратура, касса,
// врачи и администратор; лаборатория, склад и колл-центр — нет. Настроенный в
// «Ролях» уровень «Услуги в стационаре» решает сам, как на сервере.
test('I2: кнопка «Добавить услугу» у койки — по кругу ролей сервера', async () => {
    const P = await import('../permissions.js');
    const { SERVICE_ADD_ROLES } = await import('../../../../server/services/rpc/admission-charges.js');
    assert.deepStrictEqual([...P.ADMISSION_SERVICE_ADD_ROLES].sort(), [...SERVICE_ADD_ROLES].sort());
    const as = (role, extra = []) => { window.easymed = { state: { user: { id: 1, role, extra_roles: extra } } }; P.setActorRoles([]); };
    try {
        for (const role of ['admin', 'doctor', 'nurse', 'registrar', 'cashier']) {
            as(role);
            assert.strictEqual(P.canAddAdmissionService(), true, role + ': кнопки нет, а сервер строку заведёт');
        }
        for (const role of ['lab', 'inventory', 'callcenter']) {
            as(role);
            assert.strictEqual(P.canAddAdmissionService(), false, role + ': кнопка обещает, сервер откажет');
        }
        // Настроенный уровень: медсестре выдан только «Просмотр» — кнопки нет;
        // лаборатории выдано «Изменение» — кнопка есть (сервер пускает по праву).
        as('nurse');
        P.setEffectiveFromRole({ name: 'nurse', permissions: { sections: ['beds'], grants: { 'inpatient.services': 'view' } } });
        assert.strictEqual(P.canAddAdmissionService(), false);
        as('lab');
        P.setEffectiveFromRole({ name: 'lab', permissions: { sections: ['beds'], grants: { 'inpatient.services': 'edit' } } });
        assert.strictEqual(P.canAddAdmissionService(), true);
    } finally {
        delete window.easymed;
        P.setEffectiveFromRole({ name: 'x', permissions: { sections: ['beds'] } });
    }
    // Консоль койки спрашивает именно это правило и без действия кнопку не рисует.
    assert.match(SRC, /sectionCard\('Услуги \(services performed\)', 'Добавить услугу', canAddAdmissionService\(\) \? \(\) => addServiceDialog\(\) : null/);
    assert.match(SRC, /onAdd \? h\('button'/);
});
