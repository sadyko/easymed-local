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
import fs from 'node:fs';

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
const W = { writes: [], storedReads: 0, failExisting: false, failStored: false, gatewayOk: false };
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const bad = (msg) => ({ ok: false, status: 500, json: async () => ({ error: { message: msg } }), text: async () => msg });
    if (u.startsWith('/api/auth/me')) return ok({ user: { id: 1, role: 'admin' } });
    if (u.startsWith('/api/v1')) {   // ревью 3 — gatewayOk: запись товаров «прошла» (проверка итога «Товаров»)
        if (W.gatewayOk) { W.writes.push('gw:' + (opts.method || 'GET')); return ok({}); }
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    }
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

async function openWith(file, sectionKey = 'services') {
    BODY.children.length = 0;
    await openSectionImporter({ sectionKey, onImported() {} });
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

// ---------------------------------------------------------------------------
// CLINIC_API_FIX_V1 (ревью итога) — ЗАМЕЧАНИЕ НЕ ТЕРЯЕТСЯ. Правило числа
// (900496a) держится на том, что человек ВИДИТ предупреждение. А предпросмотр
// показывал только первые 50 строк, строка статуса считала строку с
// замечанием «готовой», и итоговое сообщение о замечаниях молчало: «150 000
// сум» в 62-й строке не видел никто. Теперь строка статуса считает строки с
// замечаниями, предпросмотр показывает КАЖДУЮ строку с замечанием или
// ошибкой, где бы она ни стояла (и первые 50 чистых), а итог называет число
// строк с замечаниями.
// ---------------------------------------------------------------------------
const BIG = () => {
    const rows = [['name', 'group', 'price']];
    for (let i = 1; i <= 60; i++) rows.push(['Услуга ' + i, 'Консультация', 1000 + i]);
    rows.push(['Приём кардиолога', 'Консультация', '150 000 сум']);   // строка 62: обновление, замечание
    rows.push(['Приём невролога', 'Консультация', 'abc']);            // строка 63: новая, ошибка
    return sheetFile(rows);
};
const previewRows = (overlay) => {
    const tbody = all(overlay).find((n) => n.tagName === 'TBODY');
    return tbody ? tbody.children.filter((n) => n.tagName === 'TR') : [];
};
const rowNumOf = (tr) => tr.children[0].textContent.trim();

test('замечания видны: строка статуса считает их, предпросмотр показывает строку 62 и 63, итог называет число', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const { overlay, confirm } = await openWith(BIG());
    const statusText = all(overlay).find((n) => String(n.className).includes('imx-status')).textContent;
    assert.match(statusText, /Строк в файле: 62/, statusText);
    assert.match(statusText, /61\s*готовы/, statusText);
    assert.match(statusText, /из них с замечаниями:\s*1\b/, 'строка статуса молчит о замечании: ' + statusText);
    assert.match(statusText, /1\s*с ошибками/, statusText);

    const rows = previewRows(overlay);
    const nums = rows.map(rowNumOf);
    assert.ok(nums.includes('62'), 'строки с замечанием (62) нет в предпросмотре: ' + nums.slice(-5).join(','));
    assert.ok(nums.includes('63'), 'строки с ошибкой (63) нет в предпросмотре');
    assert.equal(rows.length, 52, 'предпросмотр: 50 чистых + 2 с замечаниями — ' + rows.length);
    const r62 = rows.find((tr) => rowNumOf(tr) === '62');
    assert.match(r62.textContent, /150 000 сум/);
    const caption = all(overlay).find((n) => /Предпросмотр/.test(n._text || '')).textContent;
    assert.match(caption, /с замечаниями и ошибками \(2\)/, caption);

    confirm.click();
    await settle(200);
    assert.match(toastText(), /с замечаниями: 1\b/, 'итог импорта молчит о замечаниях: ' + toastText());
});

test('без замечаний — строка статуса и итог как раньше, предпросмотр — первые 50', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const rowsIn = [['name', 'group', 'price']];
    for (let i = 1; i <= 55; i++) rowsIn.push(['Услуга ' + i, 'Консультация', 1000 + i]);
    const { overlay, confirm } = await openWith(sheetFile(rowsIn));
    const statusText = all(overlay).find((n) => String(n.className).includes('imx-status')).textContent;
    assert.ok(!/замечани/.test(statusText), statusText);
    assert.equal(previewRows(overlay).length, 50);
    confirm.click();
    await settle(200);
    assert.ok(!/замечани/.test(toastText()), toastText());
});

test('новые подписи окна импорта — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const k of ['из них с замечаниями:', 'Предпросмотр: все строки с замечаниями и ошибками ({flagged}) и первые {n} без замечаний — всего строк {total}', 'с замечаниями: {n}']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
        assert.ok(!/[Ѐ-ӿ]/.test(e.uz), 'кириллица в узбекском: ' + e.uz);
    }
});

// CLINIC_API_FIX_V1 (ревью итога) — окно передаёт имя файла: CSV из русского
// Excel (cp1251) читается кириллицей, а не кашей.
test('CSV в cp1251: окно показывает русские названия, а не кашу', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const text = 'name;group;price\nПриём невролога;Консультация;240 000\n';
    const bytes = new Uint8Array([...text].map((ch) => { const c = ch.codePointAt(0); return c < 0x80 ? c : c === 0x451 ? 0xB8 : c - 0x410 + 0xC0; }));
    const { overlay } = await openWith({ name: 'uslugi.csv', arrayBuffer: async () => bytes.buffer });
    const tbody = all(overlay).find((n) => n.tagName === 'TBODY');
    assert.ok(tbody && /Приём невролога/.test(tbody.textContent), 'в предпросмотре нет «Приём невролога»: ' + (tbody ? tbody.textContent.slice(0, 200) : '—'));
});

// CLINIC_API_FIX_V1 (ревью 3) — ПРЕДПРОСМОТР С ПОТОЛКОМ. Строки с замечаниями
// рисовались все: 5 000 таких строк — около 90 тысяч узлов, и всё заново на
// каждое переключение галочки. Теперь — не больше 200 строк с замечаниями и
// ошибками, под таблицей — «ещё N строк с замечаниями».
test('предпросмотр: не больше 200 строк с замечаниями, остальные названы числом', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const rows = [['name', 'group', 'price']];
    for (let i = 1; i <= 300; i++) rows.push(['Новая ' + i, 'Консультация', 'abc']);   // ошибка: не число в цене новой услуги
    for (let i = 1; i <= 60; i++) rows.push(['Чистая ' + i, 'Консультация', 1000 + i]);
    const { overlay } = await openWith(sheetFile(rows));
    const trs = previewRows(overlay);
    const flaggedShown = trs.filter((tr) => /ошибка|внимание/.test(tr.children[1].textContent)).length;
    assert.equal(flaggedShown, 200, 'строк с замечаниями в предпросмотре: ' + flaggedShown);
    assert.equal(trs.length, 250, 'всего строк в предпросмотре: ' + trs.length);
    assert.match(overlay.textContent, /ещё 100 строк с замечаниями/);
});

test('подписи потолка предпросмотра — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const k of ['ещё {n} строк с замечаниями', 'Предпросмотр: первые {shown} из {flagged} строк с замечаниями и ошибками и первые {n} без замечаний — всего строк {total}']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
    }
});

// CLINIC_API_FIX_V1 (ревью 3) — ИТОГ ИМПОРТА ЧЕСТНЫЙ И ОСТАЁТСЯ НА ЭКРАНЕ.
// Было: «Импортировано строк: 2 · новых: 2.», хотя ещё 3 строки файла не
// ввезены (ошибки), и окно закрывалось — вместе со списком причин. Теперь,
// если что-то не ввезено или с замечаниями, окно остаётся и показывает итог:
// ввезено N (новых M), не импортировано K, с замечаниями W; таблица с
// причинами — под ним. Чистый импорт закрывает окно, как раньше. Сообщение
// с оттенком предупреждения теперь окрашено (admin.css), а сообщение
// «Товаров» об остатках дописывается к итогу, а не заменяет его.
const resultText = (overlay) => {
    const el = all(overlay).find((n) => String(n.className).includes('imx-result'));
    return el ? el.textContent : '';
};
const inBody = (overlay) => all(BODY).includes(overlay);

test('итог: 2 ввезены, 3 не ввезены из-за ошибок в файле — окно остаётся, итог честный', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const { overlay, confirm } = await openWith(sheetFile([['name', 'group', 'price'],
        ['Приём A', 'Консультация', 1000], ['Приём B', 'Консультация', 2000],
        ['Приём X', 'Консультация', 'abc'], ['Приём Y', 'Консультация', ''], ['Приём Z', 'Консультация', '1,500']]));
    confirm.click();
    await settle(200);
    assert.ok(inBody(overlay), 'окно закрылось, а 3 строки не ввезены');
    const text = resultText(overlay);
    assert.match(text, /Импорт завершён/);
    assert.match(text, /Импортировано строк: 2/);
    assert.match(text, /новых: 2/);
    assert.match(text, /Не импортировано — ошибки в файле: 3/);
    assert.match(toastText(), /не импортировано \(ошибки в файле\): 3/, toastText());
    assert.ok(confirm.disabled === true || confirm.hasAttribute('disabled'), 'после импорта «Импортировать» снова доступна — повтор задвоит');
    assert.ok(previewRows(overlay).length >= 3, 'таблица с причинами пропала');
});

test('итог: только замечания — окно остаётся, «С замечаниями: 1»', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const { overlay, confirm } = await openWith(sheetFile([['name', 'group', 'price'],
        ['Приём кардиолога', 'Консультация', '150 000 сум'], ['Приём A', 'Консультация', 1000]]));
    confirm.click();
    await settle(200);
    assert.ok(inBody(overlay));
    assert.match(resultText(overlay), /С замечаниями: 1/);
});

test('итог: всё чисто — окно закрывается, как раньше', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false });
    const { overlay, confirm } = await openWith(FILE());
    confirm.click();
    await settle(200);
    assert.ok(!inBody(overlay), 'чистый импорт оставил окно открытым');
    assert.match(toastText(), /Импортировано строк: 2/);
});

test('«Товары»: сообщение об остатках дописано к итогу, а не заменяет его', async () => {
    Object.assign(W, { writes: [], failExisting: false, failStored: false, gatewayOk: true });
    try {
        const { confirm } = await openWith(sheetFile([['Товар', 'Цена', 'Остаток'], ['Шприц', 1200, 5]]), 'procurement_items');
        confirm.click();
        await settle(250);
        const t = toastText();
        assert.match(t, /Импортировано строк: 1/, t);
        assert.match(t, /Остатки пропущены/, t);
    } finally { W.gatewayOk = false; }
});

test('сообщение с оттенком предупреждения окрашено (admin.css), цветом из токенов', () => {
    const css = fs.readFileSync(new URL('../../../css/admin.css', import.meta.url), 'utf8');
    assert.match(css, /\.toast\[data-kind="warn"\]\s*\{[^}]*background:\s*var\(--warn-\d+\)/);
});

test('подписи итога — на трёх языках', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const k of ['Импорт завершён', 'Импортировано строк: {n}', 'Не импортировано — ошибки в файле: {n}', 'Не записано — ошибка при записи: {n}',
        'С замечаниями: {n}', 'Строки с ошибками и замечаниями — в таблице ниже.', 'не импортировано (ошибки в файле): {n}']) {
        const e = STRINGS[k];
        assert.ok(e && e.ru === k && e.uz && e.en, 'нет перевода: ' + k);
    }
});
