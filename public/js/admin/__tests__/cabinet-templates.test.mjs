// CABINET_FIX_V1_TPL (2026-10-02) — ШАБЛОНЫ ОКНА ВРАЧА.
//
// Владелец: «please check for the template saving», затем: «the template using,
// when changed the document type is still not working». Воспроизведено в
// браузере на чистой базе (шаблон каждого рода, тип документа переключали в обе
// стороны) — причин три, и ни одна не в самом переключении:
//   1. библиотека в кабинете показывала шаблоны ВСЕХ родов — приёма,
//      диагностики и истории болезни — независимо от типа документа.
//      «Использовать» на шаблоне другого рода клало текст в поля, которых на
//      видимом бланке нет (жалобы — под бланком диагностики, «Описание» — под
//      бланком приёма, разделы истории болезни — никуда): «ничего не вставилось»;
//   2. у шаблона диагностики «Описание» вставлять было некуда (поле появилось
//      в CABINET_FIX_V1_DIAG), а «Заключение» стиралось при следующем открытии;
//   3. applyFields на «Использовать» заново строил свои разделы врача из полей
//      шаблона — а их в шаблоне нет никогда, и свои разделы приёма пропадали.
// Плюс находки дизайна (A–F): doc_type числом ('1.0' в базе dev), тип не
// подсвечивался при правке, «Не удалось сохранить» без причины, окно из
// стационарного документа падало на «Из текущего документа», редактор в
// «Документах» без автора, с doc_type-подписью и вырезанным HTML.
//
// Проверяется поведением на маленьком DOM-стенде (кабинет целиком без браузера
// не поднимается) и по исходнику там, где поведение — это вызов окна.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── маленький DOM: простые селекторы ([attr], [attr="v"], .cls, tag) ─────────
class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase(); this.attrs = {}; this.children = []; this.parentElement = null;
        this.style = {}; this.dataset = {}; this._text = ''; this._html = null; this.value = ''; this._l = {};
        const self = this;
        this.classList = {
            _s: new Set(),
            contains(c) { return this._s.has(c); }, add(...c) { c.forEach((x) => this._s.add(x)); self.attrs.class = [...this._s].join(' '); },
            remove(...c) { c.forEach((x) => this._s.delete(x)); self.attrs.class = [...this._s].join(' '); },
            toggle(c, on) { const want = on === undefined ? !this._s.has(c) : !!on; if (want) this.add(c); else this.remove(c); return want; },
        };
        if (this.tagName === 'TEMPLATE') this.content = new El('#fragment');
    }
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); this.attrs.class = String(v); }
    get className() { return this.attrs.class || ''; }
    setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    appendChild(c) { if (c && typeof c === 'object') { this.children.push(c); c.parentElement = this; } return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    get firstChild() { return this.children[0] || null; }
    get textContent() { return this._html != null ? this._html.replace(/<[^>]+>/g, '') : this._text + this.children.map((c) => c.textContent || '').join(''); }
    set textContent(v) { this._text = String(v); this._html = null; this.children = []; }
    get innerHTML() { return this._html != null ? this._html : this._text; }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    get innerText() { return this.textContent; }
    focus() {}
    matches(sel) {
        const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel.trim());
        if (!m) return false;
        if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
        for (const c of (m[2].match(/\.[\w-]+/g) || [])) if (!this.classList.contains(c.slice(1))) return false;
        for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) {
            const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
            if (!am || !(am[1] in this.attrs)) return false;
            if (am[2] !== undefined && this.attrs[am[1]] !== am[2]) return false;
        }
        return true;
    }
    closest(sel) { for (let e = this; e; e = e.parentElement) if (e.matches && e.matches(sel)) return e; return null; }
    querySelectorAll(sel) {
        const out = [];
        const walk = (e) => { for (const c of e.children) { if (c.matches && c.matches(sel)) out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Txt extends El { constructor(t) { super('#text'); this._text = String(t); } }
globalThis.Node = El;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, addEventListener() {} };
globalThis.document = {
    createElement: (t) => new El(t), createTextNode: (t) => new Txt(t), createElementNS: (_n, t) => new El(t),
    head: new El('head'), body: new El('body'), documentElement: new El('html'),
    addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const WS_SRC = read('views/service-workspace.js');
const DOCS_SRC = read('views/documents.js');
const ADM_SRC = read('views/admission-modal.js');
const code = (s) => s.replace(/\/\/[^\n]*/g, '');
const WS = await import('../views/service-workspace.js');

// ─── стенд кабинета: те же поля и разделы, что рисует soapForm ───────────────
function el(tag, attrs = {}, ...kids) { const e = new El(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); kids.forEach((k) => e.appendChild(k)); return e; }
const input = (field) => el('div', { class: 'a4-input', 'data-field': field });
const section = (sec, field) => el('div', { class: 'a4-sec a4-sec-off', 'data-sec': sec }, input(field));
function cabinet() {
    const select = el('select', { 'data-doctype': '' });
    const root = el('div', {},
        select,
        section('complaints', 'chief_complaint'), section('anamnesis', 'hpi'), section('exam', 'physical_exam'),
        section('diagnosis', 'primary_diagnosis'), section('therapy', 'therapy_text'),
        section('recommendations', 'recommendations_text'), section('conclusion', 'conclusion_text'),
        el('div', { 'data-free-secs': '' }),
        el('div', { 'data-diag-fields': '' }, input('instrumental_text')),
        el('div', {}, el('select', { 'data-field': 'follow_up' }), el('input', { 'data-field': 'icd10' }), el('select', { 'data-field': 'referral' })),
    );
    return { container: root, select };
}
// «Сохранить черновик» → «открыть снова»: те же функции, что у кабинета (collectFields / applyFields).
function saveAndReopen(ctx) {
    const saved = JSON.parse(JSON.stringify(WS.collectFields(ctx)));
    const again = cabinet();
    WS.setDocType(again, ctx.select.value === 'diag' ? 'diag' : 'conclusion');
    WS.applyFields(again, saved);
    return { again, saved };
}
const T0 = { id: 1, name: 'ОРВИ', doc_type: '0', scope: 'shared', author_id: 2, body: { chief_complaint: 'Кашель три дня', therapy_text: 'Обильное питьё' } };
const T1 = { id: 2, name: 'УЗИ почек — норма', doc_type: '1', scope: 'shared', author_id: 2, body: { instrumental_text: 'Почки обычных размеров', primary_diagnosis: 'Патологии нет' } };
const T1_LEGACY = { ...T1, id: 3, doc_type: '1.0' };
const T2 = { id: 4, name: 'Дневник', doc_type: '2', scope: 'shared', author_id: 2, body: { complaints: 'Жалоб нет' } };
const RX = { id: 5, name: 'Ангина', doc_type: '3', scope: 'private', author_id: 2, body: { rx: [{ name: 'Амоксициллин' }] } };

test('tplDocType: код рода — строкой «0/1/2/3»; «1.0» из базы dev читается как «1»', () => {
    assert.equal(WS.tplDocType('1.0'), '1');
    assert.equal(WS.tplDocType(1), '1');
    assert.equal(WS.tplDocType('2'), '2');
    assert.equal(WS.tplDocType('3'), '3');
    assert.equal(WS.tplDocType(null), '0');
    assert.equal(WS.tplDocType('мусор'), '0');
    // правка подсвечивает тип: черновик несёт число того же рода
    const d = WS.tplDraftFrom(T1_LEGACY);
    assert.equal(d.doc_type, 1, '«1.0» не подсвечивается при правке');
    assert.deepEqual(Object.keys(d.body).sort(), ['instrumental_text', 'primary_diagnosis']);
});

test('список кабинета — шаблоны ТЕКУЩЕГО типа документа; истории болезни и рецепты — не здесь', () => {
    const rows = [T0, T1, T1_LEGACY, T2, RX];
    assert.deepEqual(WS.tplKindRows(rows, '0').map((t) => t.id), [1], 'приём');
    assert.deepEqual(WS.tplKindRows(rows, '1').map((t) => t.id), [2, 3], 'диагностика (и «1.0»)');
    assert.deepEqual(WS.tplKindRows(rows, '2').map((t) => t.id), [4], 'история болезни — окно стационара');
    assert.deepEqual(WS.tplKindRows(rows, 'docs').map((t) => t.id), [1, 2, 3, 4], '«Документы»: все шаблоны документов, без рецептов');
    assert.deepEqual(WS.tplKindRows(rows, '3').map((t) => t.id), [5], 'окно рецепта: только рецепты');
    // библиотека кабинета берёт род из ТЕКУЩЕГО типа документа в момент открытия
    assert.match(code(WS_SRC), /const kind = only !== null \? String\(only\) : manage \? 'docs' : cabinetKind\(\)/,
        'библиотека не перечитывает тип документа при открытии');
});

for (const [label, start, tpl, wantType, want] of [
    ['Приём → шаблон приёма', 'conclusion', T0, 'conclusion', { chief_complaint: 'Кашель три дня', therapy_text: 'Обильное питьё' }],
    ['Диагностика → шаблон диагностики', 'diag', T1, 'diag', { instrumental_text: 'Почки обычных размеров', primary_diagnosis: 'Патологии нет' }],
    ['Диагностика → шаблон диагностики «1.0»', 'diag', T1_LEGACY, 'diag', { instrumental_text: 'Почки обычных размеров', primary_diagnosis: 'Патологии нет' }],
    ['Диагностика → шаблон приёма: тип переключается на «Приём»', 'diag', T0, 'conclusion', { chief_complaint: 'Кашель три дня', therapy_text: 'Обильное питьё' }],
    ['Приём → шаблон диагностики: тип переключается на «Диагностику»', 'conclusion', T1, 'diag', { instrumental_text: 'Почки обычных размеров', primary_diagnosis: 'Патологии нет' }],
]) {
    test('«Использовать» после смены типа: ' + label + ' — вставлено, сохранено, после открытия на месте', () => {
        const ctx = cabinet();
        // врач открыл документ одним типом и переключил на другой
        WS.setDocType(ctx, start === 'diag' ? 'conclusion' : 'diag');
        WS.setDocType(ctx, start);
        WS.tplApply(ctx, tpl);
        assert.equal(ctx.select.value, wantType, 'тип документа не тот, в который ложится шаблон');
        const got = WS.collectFields(ctx);
        for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, k + ' не вставлен в видимый бланк');
        // каждый раздел шаблона открыт: свёрнутый раздел не печатается
        for (const k of Object.keys(want)) {
            const box = ctx.container.querySelector('[data-field="' + k + '"]').closest('.a4-sec');
            if (box) assert.ok(!box.classList.contains('a4-sec-off'), 'раздел ' + k + ' остался свёрнутым');
        }
        const { again } = saveAndReopen(ctx);
        const back = WS.collectFields(again);
        for (const [k, v] of Object.entries(want)) assert.equal(back[k], v, k + ' пропал после сохранения и открытия');
    });
}

test('история болезни: шаблон ложится через окно стационара (profile.apply), кабинет не трогается', () => {
    const ctx = cabinet();
    WS.setDocType(ctx, 'conclusion');
    let put = null;
    WS.tplApply(null, T2, { dt: 2, apply: (f) => { put = f; } });
    assert.deepEqual(put, { complaints: 'Жалоб нет' });
    assert.equal(ctx.select.value, 'conclusion');
});

test('«Использовать» не стирает свои разделы врача', () => {
    const ctx = cabinet();
    WS.setDocType(ctx, 'conclusion');
    WS.applyFields(ctx, { free_1__title: 'Глазное дно', free_1: 'Без особенностей' });   // открыт приём со своим разделом
    assert.equal(WS.collectFields(ctx).free_1, 'Без особенностей');
    WS.tplApply(ctx, T0);
    const got = WS.collectFields(ctx);
    assert.equal(got.free_1, 'Без особенностей', 'шаблон стёр свой раздел врача');
    assert.equal(got.free_1__title, 'Глазное дно');
    assert.equal(got.chief_complaint, 'Кашель три дня');
});

test('тип документа сохраняется с документом и открывается тем же — не выбранным по услуге', () => {
    const ws = code(WS_SRC);
    const saves = ws.match(/payload\.docType = wsState\.docType;/g) || [];
    assert.equal(saves.length, 2, 'тип документа сохраняют не и черновик, и подпись');
    assert.match(ws, /if \(payload\.docType === 'diag' \|\| payload\.docType === 'conclusion'\) \{ ctx\.docTypeSaved = true; if \(wsState\.docType !== payload\.docType\) setDocType\(ctx, payload\.docType\); \}/,
        'открытие не восстанавливает тип документа');
    assert.match(ws, /if \(!ctx\.docTypeSaved && opensAsDiagnostics\(/, 'выбор по услуге перебивает сохранённый тип');
});

test('B: «Документы» открывают ту же библиотеку кабинета (автор, род 0/1/2, те же разделы, HTML не вырезается)', () => {
    const c = code(DOCS_SRC);
    assert.match(c, /await import\('\.\/service-workspace\.js\?v=[\w-]+'\)/, '«Документы» не зовут библиотеку кабинета');
    assert.match(c, /openTemplateLibraryModal\(null, \{ manage: true \}\)/);
    assert.ok(!/TPL_SECTIONS/.test(c), 'второй редактор шаблонов в «Документах» остался');
    assert.ok(!/doc_type: 'Приём \(осмотр, консультация\)'/.test(c), 'doc_type — снова подпись, а не код');
    // правка разделов — редактируемая область с HTML, а не textarea с вырезанными тегами
    const ws = code(WS_SRC);
    assert.match(ws, /'data-tpl-sec': k, contentEditable: 'true'/, 'разделы шаблона снова textarea');
    assert.match(ws, /d\.body\[k\] = e\.currentTarget\.innerHTML/, 'правка раздела не хранит HTML');
    assert.ok(!/body\.innerHTML = esc\(v\)/.test(ws), 'просмотр шаблона показывает теги текстом');
});

test('C/E/F: правит автор или администратор; причина отказа сервера видна; окно стационара не падает', () => {
    const ws = code(WS_SRC);
    assert.match(ws, /const canManage = \(t\) => isMine\(t\) \|\| isAdminActor\(\)/, 'администратор не правит чужие шаблоны в окне');
    assert.match(ws, /trf\('Не удалось сохранить: \{msg\}', \{ msg: errText\(error\) \}\)/, 'отказ сохранения без причины');
    assert.match(ws, /trf\('Не удалось удалить: \{msg\}', \{ msg: errText\(error\) \}\)/, 'отказ удаления без причины');
    assert.ok(!/toast\('Не удалось сохранить', 'fail'\)/.test(ws));
    // «Из текущего документа»: окно стационара даёт read(), без него кнопки нет
    assert.match(ws, /profile && typeof profile\.read === 'function'/, '«Из текущего документа» снова зовёт collectFields(null)');
    assert.match(code(ADM_SRC), /read: \(\) => \{ const o = \{\}; for \(const k of RICH_KEYS\) if \(rich\[k\]\) o\[k\] = readRich\(rich\[k\]\)/, 'окно стационара не отдаёт текст своего документа');
    // doc_type уходит строкой
    assert.match(ws, /doc_type: tplDocType\(d\.doc_type\)/, 'doc_type снова уходит числом');
});

test('один экземпляр модуля кабинета: «Документы» и окно стационара зовут его с тем же штампом, что admin.js', () => {
    const admin = fs.readFileSync(path.join(HERE, '..', '..', 'admin.js'), 'utf8');
    const stamp = (admin.match(/views\/service-workspace\.js\?v=([\w-]+)'/) || [])[1];
    assert.ok(stamp, 'штамп кабинета в admin.js не найден');
    for (const [name, src] of [['documents.js', DOCS_SRC], ['admission-modal.js', ADM_SRC]]) {
        const m = src.match(/import\('\.\/service-workspace\.js(?:\?v=([\w-]+))?'\)/);
        assert.ok(m, name + ' не зовёт библиотеку кабинета');
        assert.equal(m[1], stamp, name + ': другой штамп — второй экземпляр модуля со своим состоянием окна');
    }
});

test('подписи окна шаблонов переведены на три языка', async () => {
    const { STRINGS } = await import('../i18n-strings.js');
    for (const key of ['Приём', 'Диагностика', 'Шаблоны документов', 'Тип документа переключён: {type}']) {
        const e = STRINGS[key];
        assert.ok(e, 'строки нет в словаре: ' + key);
        for (const lang of ['ru', 'uz', 'en']) assert.ok(e[lang], key + ': нет перевода ' + lang);
    }
});
