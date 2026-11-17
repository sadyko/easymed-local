// IMPORT_CATEGORY_LINK_V1 (3.25.0) — импорт услуг создаёт новые категории И
// ПРИВЯЗЫВАЕТ к ним услуги. НАСТОЯЩЕЕ окно импорта на НАСТОЯЩЕМ сервере.
//
// Владелец: файл услуг на 2 824 строки со 185 новыми «Категориями» — после
// импорта все 185 категорий есть, а у каждой услуги category_id пуст. Повторный
// импорт того же файла привязывает (категории тогда уже существуют).
//
// Причина: autoCreatePendingFks создаёт недостающие записи справочника одной
// пакетной вставкой и берёт их id из ответа. А /api/db этой сборки на пакетную
// (массивом) вставку строк не возвращает (server/routes/db.js: meta.multi →
// { data: null }), — и каждая заготовка разрешалась в null. Поддельный сервер
// import-dialog.test.mjs отвечал на такую вставку строками с id, поэтому
// ошибка жила только на настоящем сервере; здесь — он.
//
// Что проверяется:
//   • новые категории и отделения созданы по одному разу и услуги к ним привязаны;
//   • тип из колонки «type», которого у клиники нет, НЕ создаётся
//     (SERVICE_IMPORT_TYPE_NO_AUTOCREATE_V1) — тип берётся по «Разделу»;
//   • справочник не дал id (запись отказана) — строка ввезена без ссылки, и
//     итог импорта это называет, а не молчит.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Окно грузит SheetJS по адресу сайта '/js/vendor/xlsx-0.20.3.js'; здесь — тот
// же файл с диска (приём import-dialog.test.mjs).
const VENDOR = new URL('../../vendor/xlsx-0.20.3.js', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(
    `export async function resolve(s, c, next) { if (s === '/js/vendor/xlsx-0.20.3.js') return { url: ${JSON.stringify(VENDOR)}, shortCircuit: true }; return next(s, c); }`));

// ---- поддельный DOM (копия import-dialog.test.mjs) ---------------------------
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

// ---- настоящий сервер (приём roles-save-truth.test.mjs) ----------------------
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { createApp } = await import('../../../../server/app.js');
const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');

// Окно ходит относительными адресами (/api/db, /api/v1/…) — их везём на сервер
// стенда с сессией администратора. `refuse` — отказ сервера на запись в таблицу
// (для проверки итога, когда справочник не дал id).
const realFetch = globalThis.fetch;
let BASE = '';
let COOKIE = '';
const refuse = new Set();
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('/')) return realFetch(url, opts);
    if (u.startsWith('/api/db') && opts.body) {
        const d = JSON.parse(opts.body);
        sent.push(d);
        if (d.op === 'insert' && refuse.has(d.table)) {
            const msg = 'Сервер недоступен';
            return { ok: false, status: 500, json: async () => ({ error: { message: msg } }), text: async () => JSON.stringify({ error: { message: msg } }) };
        }
    }
    return realFetch(BASE + u, { ...opts, headers: { ...(opts.headers || {}), Cookie: COOKIE } });
};

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
async function world(t) {
    const db = openDb(':memory:');
    migrate(db);
    const scols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(1, 'adm', 'x', 'adm', 'admin');
    const cols = ['id', 'user_id', 'expires_at'];
    const vals = ['sid-adm', 1, iso(Date.now() + 8 * 3600e3)];
    if (scols.includes('last_seen_at')) { cols.push('last_seen_at'); vals.push(iso(Date.now())); }
    db.prepare(`INSERT INTO sessions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
    BASE = `http://127.0.0.1:${server.address().port}`;
    COOKIE = 'emsid=sid-adm';
    t.after(() => new Promise((r) => server.close(() => { db.close(); r(); })));
    return db;
}

const XLSX = await import(VENDOR);
const { openSectionImporter } = await import('../views/section-import-export.js');

async function until(cond, what, ms = 8000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('не дождались: ' + what);
        await new Promise((r) => setTimeout(r, 15));
    }
}
function sheetFile(rows) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Services');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return { name: 'services.xlsx', arrayBuffer: async () => buf };
}
const toastText = () => { const el = document.getElementById('toast'); return el ? el.textContent : ''; };
const resultText = (overlay) => { const el = all(overlay).find((n) => String(n.className).includes('imx-result')); return el ? el.textContent : ''; };

// Окно импорта услуг: файл выбран, «Импортировать» нажата, итог пришёл.
async function importFile(file) {
    BODY.children.length = 0;
    await openSectionImporter({ sectionKey: 'services', onImported() {} });
    const overlay = BODY.children.find((n) => String(n.className).includes('modal'));
    const fileInput = all(overlay).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'file');
    const confirm = all(overlay).find((n) => n.tagName === 'BUTTON' && /Импортировать/.test(n.textContent));
    const statusText = () => (all(overlay).find((n) => String(n.className).includes('imx-status')) || {}).textContent || '';
    fileInput.dispatchEvent({ type: 'change', target: { files: [file] } });
    await until(() => /Строк в файле/.test(statusText()) && !confirm.hasAttribute('disabled'), 'файл разобран');
    confirm.click();
    try {
        await until(() => /Импортировано строк|Импорт не удался/.test(toastText()), 'итог импорта');
    } catch (e) {
        throw new Error(e.message + ' — сообщение: «' + toastText() + '», строка статуса: «'
            + ((all(overlay).find((n) => String(n.className).includes('imx-status')) || {}).textContent || '') + '», запросы: '
            + JSON.stringify(sent.slice(-6).map((d) => d.table + ':' + (d.op || 'select'))));
    }
    return overlay;
}

const FILE = () => sheetFile([
    ['name', 'group', 'type', 'price', 'category', 'department'],
    ['Приём невролога', 'Консультация', '', 240000, 'Неврология', 'Новое отделение'],
    ['Повторный приём невролога', 'Консультация', '', 180000, 'неврология ', 'Новое отделение'],
    ['МРТ головы', 'Диагностика', 'Несуществующий тип', 400000, 'МРТ головного мозга', ''],
]);

test('IMPORT_CATEGORY_LINK_V1: новые категории и отделения созданы по разу, и услуги к ним привязаны — с первого импорта', async (t) => {
    const db = await world(t);
    const typesBefore = db.prepare('SELECT COUNT(*) AS n FROM service_types').get().n;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM service_categories WHERE name IN ('Неврология','неврология','МРТ головного мозга')").get().n, 0, 'стенд неверен: категории уже есть');

    await importFile(FILE());

    // Снимок владельца: категории созданы (по одной на название)…
    // (lower() SQLite кириллицу не понижает — сравнение в JS, как normKey окна.)
    const cats = db.prepare('SELECT name FROM service_categories').all().map((r) => String(r.name).trim().toLowerCase());
    assert.equal(cats.filter((n) => n === 'неврология').length, 1, '«Неврология» не создана или создана дважды: ' + JSON.stringify(cats));
    assert.equal(cats.filter((n) => n === 'мрт головного мозга').length, 1);
    // …и услуги к ним привязаны.
    const svc = (name) => db.prepare('SELECT s.category_id, c.name AS category, s.department_id, d.name AS department, s.type_id, st.name AS type_name FROM services s LEFT JOIN service_categories c ON c.id = s.category_id LEFT JOIN departments d ON d.id = s.department_id LEFT JOIN service_types st ON st.id = s.type_id WHERE s.name = ?').get(name);
    for (const [name, category] of [['Приём невролога', 'Неврология'], ['Повторный приём невролога', 'Неврология'], ['МРТ головы', 'МРТ головного мозга']]) {
        const row = svc(name);
        assert.ok(row, 'услуга не ввезена: ' + name);
        assert.ok(row.category_id != null, name + ': категория создана, а услуга к ней не привязана (category_id пуст)');
        assert.equal(row.category, category, name + ': привязана не к той категории');
    }
    assert.equal(svc('Приём невролога').department, 'Новое отделение', 'отделение не привязано');
    assert.equal(svc('Приём невролога').category_id, svc('Повторный приём невролога').category_id, 'одна категория — две записи');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM departments WHERE name = 'Новое отделение'").get().n, 1);

    // SERVICE_IMPORT_TYPE_NO_AUTOCREATE_V1 — тип из колонки не создаётся: тип — по «Разделу».
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM service_types WHERE name = 'Несуществующий тип'").get().n, 0, 'импорт услуг создал тип из колонки «type»');
    assert.ok(svc('МРТ головы').type_id != null, 'тип по «Разделу» не подставлен');
    assert.equal(svc('МРТ головы').type_name, 'Диагностика');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM service_types').get().n <= typesBefore + 2, 'импорт наплодил типов');
    assert.match(toastText(), /Импортировано строк: 3/, toastText());
});

test('IMPORT_CATEGORY_LINK_V1: справочник не дал id — строка ввезена без ссылки, и итог это называет', async (t) => {
    const db = await world(t);
    refuse.add('service_categories');
    try {
        const overlay = await importFile(sheetFile([
            ['name', 'group', 'price', 'category'],
            ['Приём невролога', 'Консультация', 240000, 'Неврология'],
            ['Приём кардиолога', 'Консультация', 260000, ''],
        ]));
        assert.equal(db.prepare("SELECT category_id FROM services WHERE name = 'Приём невролога'").get().category_id, null, 'стенд неверен: категория привязалась, хотя запись отказана');
        const text = resultText(overlay);
        assert.ok(all(BODY).includes(overlay), 'окно закрылось, как после чистого импорта');
        assert.match(text, /Без ссылки на справочник: 1/, 'итог молчит, что строка ввезена без категории: ' + text);
        assert.match(text, /«Неврология»/, 'итог не называет, какая категория не создана: ' + text);
        assert.match(toastText(), /без ссылки на справочник: 1/, toastText());
    } finally { refuse.clear(); }
});

test('IMPORT_CATEGORY_LINK_V1: подписи итога — на трёх языках, без кириллицы в узбекском и английском', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const k of ['Без ссылки на справочник: {n} — не удалось создать или найти: {list}', 'без ссылки на справочник: {n}']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
        assert.ok(!/[Ѐ-ӿ]/.test(e.uz), 'кириллица в узбекском: ' + e.uz);
        assert.ok(!/[Ѐ-ӿ]/.test(e.en), 'кириллица в английском: ' + e.en);
    }
});
