// CLINIC_API_FIX_V1 — импорт Excel соблюдает правило онлайн-записи.
//
// Окно услуги не сохраняет онлайн-запись без узбекского названия
// (server/services/rpc/service-save.js, SERVICE_NAMES_ONLINE_V1: русское
// название обязательно всегда, узбекское — для онлайн-записи). Импорт писал
// флаг прямо в колонку, и строка «online_booking = 1» без name_uz включала
// онлайн-запись услуге, у которой нет узбекского названия.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM so the view module (and i18n it pulls) can load; nothing renders here.
class F { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.dataset = {}; this.value = ''; }
    appendChild(c) { this.children.push(c); return c; } removeChild() {} setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener() {} removeEventListener() {} querySelector() { return null; } querySelectorAll() { return []; } remove() {}
    get textContent() { return this._t; } set textContent(v) { this._t = String(v); }
    get classList() { return { contains: () => false, add() {}, remove() {}, toggle() {} }; } }
const mk = (t) => new F(t);
globalThis.Node = F;
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => { const e = mk('#text'); e._t = String(t); return e; }, head: mk('head'), body: mk('body'), documentElement: mk('html'), addEventListener() {}, removeEventListener() {}, getElementById() { return null; } };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, removeEventListener() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
const { buildImportRow } = await import('../views/section-import-export.js');

const BASE = { name: 'Приём кардиолога', group: 'Консультация', price: 250000 };
const WARN = 'онлайн-запись не включена: нет названия на узбекском';

test('online_booking = 1 без узбекского названия — услуга без онлайн-записи, строка предупреждает с номером', () => {
    for (const nameUz of ['', '   ']) {
        const row = buildImportRow('services', { ...BASE, name_uz: nameUz, online_booking: 1 }, { rowNum: 7 });
        assert.strictEqual(row.payload.online_booking, false, 'онлайн-запись включена без узбекского названия');
        assert.strictEqual(row.status, 'warn', 'строка уехала без предупреждения');
        const note = row.notes.find((n) => String(n).includes(WARN));
        assert.ok(note, 'нет предупреждения: ' + JSON.stringify(row.notes));
        assert.match(String(note), /Строка 7\b/, 'предупреждение не называет строку файла: ' + note);
        assert.ok(String(note).includes('Приём кардиолога'), 'предупреждение не называет услугу: ' + note);
    }
    // Колонки name_uz в листе нет вовсе — то же самое.
    const noCol = buildImportRow('services', { ...BASE, online_booking: 'true' }, { rowNum: 3 });
    assert.strictEqual(noCol.payload.online_booking, false);
    assert.ok(noCol.notes.some((n) => String(n).includes(WARN) && /Строка 3\b/.test(String(n))), JSON.stringify(noCol.notes));
});

test('online_booking = 1 с узбекским названием — онлайн-запись включена, без предупреждения', () => {
    const row = buildImportRow('services', { ...BASE, name_uz: 'Kardiolog qabuli', online_booking: 1 }, { rowNum: 4 });
    assert.strictEqual(row.payload.online_booking, true);
    assert.strictEqual(row.payload.name_uz, 'Kardiolog qabuli');
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('online_booking = 0 без узбекского названия — предупреждать не о чем', () => {
    const row = buildImportRow('services', { ...BASE, name_uz: '', online_booking: 0 });
    assert.strictEqual(row.payload.online_booking, false);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('колонки online_booking в листе нет — отметка услуги не трогается (старый файл не выключает онлайн-запись)', () => {
    const row = buildImportRow('services', { ...BASE, name_uz: 'Kardiolog qabuli' });
    assert.ok(!('online_booking' in row.payload), 'обновление старым файлом выключило бы онлайн-запись: ' + JSON.stringify(row.payload));
    assert.strictEqual(row.status, 'ok');
});

// CLINIC_API_FIX_V1 (ревью) — ОБНОВЛЕНИЕ существующей услуги. Пустая текстовая
// ячейка в запись не идёт, и сохранённое узбекское название остаётся у услуги;
// колонки name_uz может не быть вовсе. Тогда узбекское название у услуги ЕСТЬ —
// сохранённое, — и онлайн-запись выключать нельзя. Сохранённое считается только
// когда строка действительно обновляет услугу: стоит «Обновлять существующие»
// и услуга с таким названием есть. Иначе строка ложится новой услугой — без
// узбекского названия.
const STORED = ({ wantUpdate = true, nameUz = 'Kardiolog qabuli' } = {}) => ({
    __wantUpdate: wantUpdate,
    __stored: new Map([['приём кардиолога', { name: 'Приём кардиолога', name_uz: nameUz }]]),
});

test('обновление: пустая ячейка name_uz — узбекское название сохранённое, онлайн-запись остаётся включённой', () => {
    const row = buildImportRow('services', { ...BASE, name_uz: '', online_booking: 1 }, { rowNum: 5, lookups: STORED() });
    assert.strictEqual(row.payload.online_booking, true, 'обновление выключило онлайн-запись услуге с узбекским названием');
    assert.ok(!('name_uz' in row.payload), 'пустая ячейка не стирает сохранённое название');
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('обновление: колонки name_uz в листе нет — тоже сохранённое название, без ложного предупреждения', () => {
    const row = buildImportRow('services', { ...BASE, online_booking: 'true' }, { rowNum: 5, lookups: STORED() });
    assert.strictEqual(row.payload.online_booking, true);
    assert.strictEqual(row.status, 'ok', JSON.stringify(row.notes));
});

test('обновление услуги, у которой узбекского названия нет и в базе, — выключено с предупреждением', () => {
    const row = buildImportRow('services', { ...BASE, name_uz: '', online_booking: 1 }, { rowNum: 5, lookups: STORED({ nameUz: null }) });
    assert.strictEqual(row.payload.online_booking, false);
    assert.ok(row.notes.some((n) => String(n).includes(WARN) && /Строка 5\b/.test(String(n))), JSON.stringify(row.notes));
});

test('новая услуга: сохранённое название чужой строки не считается — без «Обновлять существующие» и без совпадения по названию', () => {
    // Галочка «Обновлять существующие» снята: строка ляжет НОВОЙ услугой.
    const fresh = buildImportRow('services', { ...BASE, name_uz: '', online_booking: 1 }, { rowNum: 6, lookups: STORED({ wantUpdate: false }) });
    assert.strictEqual(fresh.payload.online_booking, false, 'новая услуга получила онлайн-запись по названию другой');
    assert.ok(fresh.notes.some((n) => String(n).includes(WARN)), JSON.stringify(fresh.notes));
    // Галочка стоит, но услуги с таким названием нет — тоже вставка.
    const other = buildImportRow('services', { ...BASE, name: 'Приём невролога', name_uz: '', online_booking: 1 }, { rowNum: 7, lookups: STORED() });
    assert.strictEqual(other.payload.online_booking, false);
    assert.ok(other.notes.some((n) => String(n).includes(WARN) && /Строка 7\b/.test(String(n))), JSON.stringify(other.notes));
});

// Окно импорта собирается только в браузере (SheetJS, файл); здесь — что оно
// кладёт галочку «Обновлять существующие» в сборку строк и пересобирает их,
// когда галочку меняют после выбора файла, и перед самим импортом.
test('окно импорта собирает строки с галочкой «Обновлять существующие» и пересобирает при её смене', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../views/section-import-export.js', import.meta.url), 'utf8');
    const dlg = src.slice(src.indexOf('export async function openSectionImporter('), src.indexOf('async function autoCreatePendingFks('));
    assert.match(dlg, /lookups\.__wantUpdate = wantUpdateNow\(\)/, 'галочка не доходит до сборки строк');
    assert.match(dlg, /updateExistingInp\.addEventListener\('change',[\s\S]{0,120}buildParsed\(\)/, 'смена галочки не пересобирает строки');
    const run = dlg.slice(dlg.indexOf('async function runImport('));
    assert.match(run.slice(0, 400), /__wantUpdate !== wantUpdateNow\(\)[\s\S]{0,60}buildParsed\(\)/, 'импорт идёт строками, собранными с другой галочкой');
});
