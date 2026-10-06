// CLINIC_API_FIX_V1 (ревью) — окно импорта, ВЖИВУЮ: настоящий
// openSectionImporter, настоящий SheetJS из public/js/vendor, поддельные DOM и
// сервер.
//
// Что проверяется:
//   • список уже сохранённых услуг при импорте не прочитался — импорт НЕ идёт
//     (раньше ошибка только писалась в консоль, и каждая строка вставлялась
//     новой услугой: дубли, а строки, собранные как обновление, получали
//     значения базы — НДС 0, «нужен врач» снят); ничего не записано, даже
//     справочники; человек видит переведённую причину;
//   • то же, если при чтении файла не прочитался сохранённый список услуг;
//   • второй файл в том же окне перечитывает сохранённый список, а не берёт
//     прошлый.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Окно грузит SheetJS по адресу сайта '/js/vendor/xlsx-0.20.3.js'; здесь — тот
// же файл с диска.
const VENDOR = new URL('../../vendor/xlsx-0.20.3.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
    `export async function resolve(s, c, next) { if (s === '/js/vendor/xlsx-0.20.3.js') return { url: ${JSON.stringify(VENDOR)}, shortCircuit: true }; return next(s, c); }`));

// ---- поддельный DOM (как в app-shell.test.mjs) -----------------------------
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {};
        this.dataset = {}; this.value = ''; this.hidden = false; this._parent = null;
    }
    appendChild(c) { if (c && typeof c === 'object') c._parent = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c); }
    insertBefore(c, ref) { const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); if (c) c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) { this.children.splice(i, 1); c._parent = null; } return c; }
    get firstChild() { return this.children[0] || null; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; } querySelectorAll() { return []; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children.length = 0; }
    get classList() {
        const s = this;
        const list = () => String(s.className || '').split(/\s+/).filter(Boolean);
        return { contains: (c) => list().includes(c), add: (c) => { if (!list().includes(c)) s.className = list().concat(c).join(' '); },
            remove: (c) => { s.className = list().filter((x) => x !== c).join(' '); }, toggle() {} };
    }
    get isConnected() { return true; }
}
class FakeText extends FakeNode { constructor(t) { super('#text'); this._text = String(t); } }
function mkEl(tag) {
    const el = new FakeNode(tag);
    if (el.tagName === 'TEMPLATE') {
        el.content = { firstChild: null };
        Object.defineProperty(el, 'innerHTML', { set(v) { const s = new FakeNode('svg'); s._text = String(v); el.content.firstChild = s; }, get() { return ''; } });
    }
    return el;
}
const all = (root, out = []) => { for (const c of root.children || []) { out.push(c); all(c, out); } return out; };
const BODY = mkEl('body');
globalThis.Node = FakeNode;
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'),
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => all(BODY).find((n) => n.attrs.id === id) || null,
    querySelector: () => null, querySelectorAll: () => [],
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, CLINIC: { id: 1 } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

// ---- поддельный сервер ------------------------------------------------------
const W = { writes: [], storedReads: 0, failExisting: false, failStored: false };
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const bad = (msg) => ({ ok: false, status: 500, json: async () => ({ error: { message: msg } }), text: async () => msg });
    if (u.startsWith('/api/auth/me')) return ok({ user: { id: 1, role: 'admin' } });
    if (u.startsWith('/api/v1')) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    if (u.startsWith('/api/db')) {
        const d = JSON.parse(opts.body || '{}');
        if (d.op !== 'select') { W.writes.push(d.table + ':' + d.op); return ok({ data: [] }); }
        if (d.table === 'services') {
            if (/doctor_tier_from/.test(String(d.columns))) {   // сохранённый список (loadLookups)
                W.storedReads++;
                if (W.failStored) return bad('Сервер недоступен');
                return ok({ data: [{ name: 'Приём кардиолога', type: 'consultation', type_id: 77, tax_rate: 0 }] });
            }
            if (W.failExisting) return bad('Сервер недоступен');   // id по названию (runImport)
            return ok({ data: [{ id: 5, name: 'Приём кардиолога' }] });
        }
        return ok({ data: [] });
    }
    return ok({});
};

const XLSX = await import(VENDOR);
const { openSectionImporter } = await import('../views/section-import-export.js');
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function sheetFile(rows) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Services');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return { name: 'services.xlsx', arrayBuffer: async () => buf };
}
// Файл «название · раздел · цена»: одна услуга есть, одна новая (с новой категорией).
const FILE = () => sheetFile([['name', 'group', 'price', 'category'],
    ['Приём кардиолога', 'Консультация', 260000, ''], ['Приём невролога', 'Консультация', 240000, 'Неврология']]);

async function openWith(file) {
    BODY.children.length = 0;
    await openSectionImporter({ sectionKey: 'services', onImported() {} });
    const overlay = BODY.children.find((n) => String(n.className).includes('modal'));
    const fileInput = all(overlay).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'file');
    const confirm = all(overlay).find((n) => n.tagName === 'BUTTON' && /Импортировать/.test(n.textContent));
    const pick = async (f) => { fileInput.dispatchEvent({ type: 'change', target: { files: [f] } }); await settle(150); };
    await pick(file);
    return { overlay, confirm, pick };
}
const toastText = () => { const t = document.getElementById('toast'); return t ? t.textContent : ''; };

test('стенд: обычный импорт обновляет существующую услугу и вставляет новую', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const { confirm } = await openWith(FILE());
    assert.ok(!confirm.hasAttribute('disabled'), 'файл не разобран: ' + toastText());
    confirm.click();
    await settle(200);
    assert.ok(W.writes.includes('services:update'), JSON.stringify(W.writes));
    assert.ok(W.writes.includes('services:insert'), JSON.stringify(W.writes));
});

test('список сохранённых услуг при импорте не прочитался — ничего не записано, причина на экране', async () => {
    Object.assign(W, { writes: [], failExisting: true, failStored: false });
    const { confirm } = await openWith(FILE());
    confirm.click();
    await settle(200);
    assert.deepEqual(W.writes, [], 'импорт пошёл без списка сохранённых: ' + JSON.stringify(W.writes));
    assert.match(toastText(), /Не удалось прочитать уже сохранённые записи/);
    assert.match(toastText(), /Импорт не выполнен/);
});

test('сохранённый список не прочитался при чтении файла — импорт тоже не идёт', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: true });
    const { confirm } = await openWith(FILE());
    confirm.click();
    await settle(200);
    assert.deepEqual(W.writes, [], 'строки собраны без сохранённого списка и записаны: ' + JSON.stringify(W.writes));
    assert.match(toastText(), /Не удалось прочитать уже сохранённые записи/);
});

test('второй файл в том же окне перечитывает сохранённый список', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false, storedReads: 0 });
    const { pick } = await openWith(FILE());
    assert.equal(W.storedReads, 1);
    await pick(FILE());
    assert.equal(W.storedReads, 2, 'второй файл собран по списку, прочитанному для первого');
});
