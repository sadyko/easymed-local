// REFERENCE_LISTS_V1 — выбор специальности упорядочен по тому, что видно на
// экране. Список хранится в русском алфавитном порядке, а показывается
// переводом: в узбекском и английском интерфейсе 120 названий шли вразнобой
// («Akusher-ginekolog», «Allergolog-immunolog», …, «Bolalar …» посреди «D…»).
// Теперь пункты сортируются по показанной (переведённой) подписи на языке
// интерфейса; сохраняемое значение — по-прежнему русское название / slug.
//
// Язык интерфейса — узбекский: i18n.js выбирает язык один раз при загрузке,
// поэтому admin.lang ставится ДО импорта экранов.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
    constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._text = ''; this._l = {}; this.dataset = {}; this.value = ''; }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
    get firstChild() { return this.children[0] || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() {} focus() {} blur() {} remove() {} scrollIntoView() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
    get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._text = String(t); } }
function mk(t) {
    const el = new F(t);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set() { el.content.firstChild = new F('svg'); }, get() { return ''; } });
    }
    return el;
}
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
globalThis.Node = F;
globalThis.document = {
    createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
    head: mk('head'), body: mk('body'), documentElement: mk('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null,
};
const lsStore = new Map([['admin.lang', 'uz']]);
globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); }, removeItem: (k) => { lsStore.delete(k); }, clear: () => lsStore.clear(),
};
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() {},
    easymed: { state: { user: { id: 7, role: 'doctor', is_doctor: true, company_id: 1 } } }, CLINIC: { id: 1 },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === '/api/db') {
        const desc = JSON.parse(opts.body);
        if (desc.table === 'users') return reply(200, { data: { id: 7, full_name: 'Karimov Alisher', specialty: 'Кардиолог' } });
        if (desc.table === 'user_specialties') return reply(200, { data: [{ specialty_slug: 'kardiolog', name_ru: 'Кардиолог', is_primary: 1 }] });
        return reply(200, { data: [] });
    }
    return reply(200, { data: [] });
};

const { tr, getLang } = await import('../i18n.js');
const { specialtyOptions, SPECIALTIES } = await import('../specialties.js?v=spec2');
const { renderDoctorProfile } = await import('../views/doctor-profile.js');

const sortedIn = (labels, lang) => labels.every((l, i) => i === 0 || labels[i - 1].localeCompare(l, lang) <= 0);

test('язык интерфейса — узбекский', () => {
    assert.equal(getLang(), 'uz');
    assert.equal(tr('Кардиолог'), 'Kardiolog');
});

test('карточка сотрудника: специальности по узбекской подписи, значения — русские названия', () => {
    const opts = specialtyOptions('');
    assert.equal(opts[0][0], '', 'первым — «не указана»');
    const listed = opts.slice(1);
    assert.equal(listed.length, SPECIALTIES.length);
    const shown = listed.map(([, l]) => tr(l));
    assert.ok(sortedIn(shown, 'uz'), 'не по алфавиту показанных подписей: ' + shown.slice(0, 12).join(' · '));
    assert.deepEqual(new Set(listed.map(([v]) => v)), new Set(SPECIALTIES), 'сохраняемые значения — те же русские названия');
    // Значение «не из списка» остаётся сразу под «не указана».
    const kept = specialtyOptions('Гирудотерапевт');
    assert.equal(kept[1][0], 'Гирудотерапевт');
    assert.ok(sortedIn(kept.slice(2).map(([, l]) => tr(l)), 'uz'));
});

test('«Мой профиль»: «+ Добавить специальность» — по узбекской подписи, значения — slug', async () => {
    const container = mk('div');
    await renderDoctorProfile(container, 7);
    const sel = walk(container).find((n) => n.tagName === 'SELECT' && n.children[0] && n.children[0].attrs.value === ''
        && /Mutaxassislik|специальност/i.test(n.children[0].textContent));
    assert.ok(sel, 'нет списка «+ Добавить специальность»');
    const opts = sel.children.slice(1);
    assert.ok(opts.length > 100, 'в списке ' + opts.length + ' пунктов');
    const shown = opts.map((o) => o.textContent);
    assert.ok(sortedIn(shown, 'uz'), 'не по алфавиту показанных подписей: ' + shown.slice(0, 12).join(' · '));
    assert.ok(opts.every((o) => /^[a-z0-9-]+$/.test(o.attrs.value)), 'значение пункта — slug');
    assert.ok(!opts.some((o) => o.attrs.value === 'kardiolog'), 'уже выбранная специальность в списке не повторяется');
});
