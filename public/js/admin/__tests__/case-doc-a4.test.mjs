// CASE_DOC_A4_V1 — документ истории болезни листом A4 и правая панель вставки.
//
// Владелец (2026-09-08): «documents of the history left panel right panel and
// documents are a4 format not with the fields, but use something like document
// of the doctors workplace in the documents».
//
// Что проверяется — по одному предложению на решение:
//   • у каждого рода документа СВОИ разделы: протокол операции — один сплошной
//     текст, дневник — жалобы, объективно, план; общий набор из пяти полей
//     заставлял бы врача пролистывать разделы, которых у бумаги не бывает;
//   • раздел — редактируемая область ЛИСТА (contenteditable), а не поле формы,
//     и его разметка чистится перед отправкой;
//   • пустой раздел остаётся пустым: <br> из редактора — не текст документа;
//   • правая панель показывает четыре источника, вставляет анализ таблицей с
//     отмеченным отклонением, а исследование без заключения вставлять не даёт.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this._html = '';
    }
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c._parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    // Настоящий узел знает своего родителя, и код на это опирается (печать
    // поднимается от разделов до листа). Без этого подделка тише настоящего
    // DOM и пропускает ошибку.
    get parentNode() { return this._parent || null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(Object.assign({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    remove() { if (this._parent) this._parent.removeChild(this); }
    focus() {} blur() {}
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); }
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
    execCommand() { return false; },
};
globalThis.window = { location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {}, CLINIC: {} };
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
// Несуществующее имя иконки в БРАУЗЕРЕ рисует заметную заглушку, а не падает
// (icons.js): уронить экран клиники из-за значка дороже. В тесте окно
// подделано, поэтому строгий режим включается руками — иначе Icon('Save'),
// которого в наборе нет, молча проходил бы проверку и уезжал в клинику.
globalThis.EASYMED_ICONS_STRICT = true;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const settle = () => new Promise((r) => setTimeout(r, 30));

const SOURCES = {
    diagnosis: { referral: 'K35.8 (направление)', clinical: 'Острый аппендицит K35.8' },
    lab: [{ id: 61, name: 'Общий анализ крови', at: '2026-09-07T09:00:00Z', results: [
        { parameter: 'HGB', value: '101', unit: 'г/л', reference_range: '120–160', flag: 'low' },
        { parameter: 'WBC', value: '14.2', unit: '10⁹/л', reference_range: '4–9', flag: 'high' },
    ] }],
    imaging: [{ id: 62, name: 'Рентген грудной клетки', at: '2026-09-07T09:00:00Z', conclusion: 'Без очаговых теней' }],
    functional: [{ id: 63, name: 'ЭКГ', at: '2026-09-07T09:00:00Z', conclusion: '' }],
};
let rpcCalls = [];
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not ours */ }
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) {
        const name = u.slice('/api/rpc/'.length);
        rpcCalls.push({ name, args: body });
        if (name === 'admission_doc_sources') return ok(SOURCES);
        return ok(null);
    }
    // ICD_PICKER_PAGES_V1 — справочник МКБ-10 приезжает через /api/db: окно
    // выбора листает его страницами, и тест обязан видеть ТЕ ЖЕ запросы.
    if (u === '/api/db') {
        dbCalls.push(body);
        if (body && body.table === 'icd10') {
            const offset = Number(body.offset) || 0;
            const limit = Number(body.limit) || 9;
            const rows = [];
            for (let i = offset; i < offset + limit && i < ICD_TOTAL; i += 1) {
                rows.push({ code: 'A' + String(i).padStart(2, '0'), name: 'Болезнь номер ' + i });
            }
            return ok(rows);
        }
        return ok([]);
    }
    return ok(null);
};
const ICD_TOTAL = 20;
let dbCalls = [];

const a4 = await import('../views/case-doc-a4.js');
const { caseInsertPanel } = await import('../views/case-doc-insert.js');

// ===========================================================================
test('CASE_DOC_A4_V1: у каждого рода документа свой набор разделов, а не одна форма на всех', () => {
    // CASE_DX_EVERYWHERE_V1 — диагноз есть у КАЖДОГО документа (владелец: «make
    // diagnosis active in every document so it wont confuse user»), остальные
    // разделы остались своими у каждого рода.
    assert.deepEqual(a4.sectionsFor('operation'), ['diagnosis', 'body'], 'протокол операции — диагноз и сплошной текст');
    assert.deepEqual(a4.sectionsFor('round'), ['complaints', 'objective', 'diagnosis', 'plan']);
    assert.deepEqual(a4.sectionsFor('intake'), ['complaints', 'objective', 'diagnosis', 'plan']);
    assert.deepEqual(a4.sectionsFor('неизвестный род'), ['complaints', 'objective', 'diagnosis', 'plan', 'body'],
        'незнакомый род получает полный набор, а не пустой лист');
    for (const kind of Object.keys(a4.KIND_SECTIONS)) {
        assert.ok(a4.sectionsFor(kind).includes('diagnosis'), 'у «' + kind + '» пропал диагноз');
        assert.ok(a4.hasDiagnosis(kind), 'карточка диагноза не появится у «' + kind + '»');
    }
    // Подпись раздела зависит от документа: у протокола «body» — это протокол.
    assert.equal(a4.sectionLabel('operation', 'body'), 'Протокол операции');
    assert.equal(a4.sectionLabel('round', 'body'), 'Дополнительно');
    assert.ok(!a4.RICH_KEYS.includes('diagnosis'), 'диагноз — простой текст, а не размеченный');
});

test('CASE_DOC_A4_V1: раздел — редактируемая область листа; разметка чистится, пустое остаётся пустым', () => {
    const made = a4.richSection('primary', 'objective');
    assert.equal(made.input.tagName, 'DIV');
    assert.equal(made.input.attrs.contentEditable, 'true', 'раздел пишется прямо на листе');
    assert.equal(made.input.attrs['data-field'], 'objective');
    assert.ok(String(made.sec.className).includes('a4-sec'), 'те же классы листа, что в кабинете врача');

    a4.applyRich(made.input, '<p>Живот <b>мягкий</b></p><script>alert(1)</script>');
    assert.equal(made.input.innerHTML, '<p>Живот <b>мягкий</b></p>', 'скрипт не доезжает до листа');
    assert.equal(a4.readRich(made.input), '<p>Живот <b>мягкий</b></p>');

    made.input.innerHTML = '<p><br></p>';
    assert.equal(a4.readRich(made.input), '', 'пустой раздел не притворяется заполненным');
    made.input.innerHTML = '<div onclick="x()">текст</div>';
    assert.equal(a4.readRich(made.input), '<div>текст</div>', 'обработчик вырезан перед отправкой');
});

// CASE_DOC_FREE_SEC_V1 — владелец: «only rename and add option to create
// "free field without/with name" editable».
test('CASE_DOC_FREE_SEC_V1: подпись раздела переименовывается на месте, Esc отменяет', () => {
    const renamed = [];
    const made = a4.richSection('primary', 'objective', { onRename: (k, title) => renamed.push([k, title]) });
    const tag = made.sec.children[0];
    assert.equal(tag.tagName, 'BUTTON', 'подпись должна нажиматься, иначе переименовать её нечем');
    assert.match(textOf(tag), /Объективно/);

    tag.click();
    const field = made.sec.children.find((c) => c.tagName === 'INPUT');
    assert.ok(field, 'поле правки подписи не появилось');
    assert.equal(field.value, 'Объективно', 'поле не подставило нынешнюю подпись');
    field.value = 'Состояние по системам';
    field.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.deepEqual(renamed, [['objective', 'Состояние по системам']]);
    assert.match(textOf(made.sec.children[0]), /Состояние по системам/, 'подпись на листе не сменилась');

    // Esc возвращает подпись как была и НИЧЕГО не сохраняет.
    made.sec.children[0].click();
    const field2 = made.sec.children.find((c) => c.tagName === 'INPUT');
    field2.value = 'Передумал';
    field2.dispatchEvent({ type: 'keydown', key: 'Escape' });
    field2.dispatchEvent({ type: 'blur' });
    assert.equal(renamed.length, 1, 'отменённая правка всё равно сохранилась');

    // Без обработчика подпись — обычный текст листа: бланк и чтение не правят.
    assert.equal(a4.richSection('primary', 'objective').sec.children[0].tagName, 'SPAN');
});

// CASE_DOC_SEC_MANAGER_V2 — владелец показал лист кабинета: «here is how the
// sections look like in the doctors workspace. apply same thing». Выключенный
// раздел — это ТА ЖЕ коробка, свёрнутая в строку «+ Добавить: имя».
test('CASE_DOC_SEC_MANAGER_V2: раздел сворачивается в строку «+ Добавить», как на листе приёма', () => {
    const acts = [];
    const made = a4.richSection('round', 'body', {
        onAdd: () => acts.push('add'), onRemove: () => acts.push('remove'),
    });

    // Порядок детей коробки — тот же, что у a4Section в кабинете: на нём
    // держится вся раскладка, потому что прячет их CSS по позиции.
    const kinds = made.sec.children.map((c) => String(c.className || c.tagName));
    const at = (cls) => kinds.findIndex((c) => c.split(/\s+/).includes(cls));
    assert.equal(at('a4-sec-add'), 0, 'свёрнутая строка должна быть первой: ' + kinds.join(', '));
    assert.ok(at('a4-sec-tag') > at('a4-sec-add'), 'подпись должна идти за свёрнутой строкой');
    assert.ok(at('a4-sec-x') > at('a4-sec-tag'), 'крестик должен идти за подписью');
    assert.equal(at('a4-input'), kinds.length - 1, 'текст должен идти последним: ' + kinds.join(', '));

    const addRow = made.sec.children[at('a4-sec-add')];
    assert.match(textOf(addRow), /Добавить/, 'свёрнутая строка не называет, что она добавит');
    assert.match(textOf(addRow), /Дополнительно/, 'свёрнутая строка не называет РАЗДЕЛ');
    addRow.click();
    made.sec.children[at('a4-sec-x')].click();
    assert.deepEqual(acts, ['add', 'remove'], 'строка и крестик должны звать включение и выключение');

    // Без обработчиков — ни строки, ни крестика: бланк и чтение их не рисуют.
    const plain = a4.richSection('round', 'body');
    assert.equal(plain.sec.children.length, 2,
        'у нередактируемого раздела остаются только подпись и текст: ' + plain.sec.children.map((c) => c.className).join(', '));
});

// CASE_DOC_ACTIONS_V1 — владелец: «remove this [панель форматирования], and
// please add template, print, draft, save button instead».
test('CASE_DOC_ACTIONS_V1: над листом четыре действия документа, а не форматирование', () => {
    const calls = [];
    const bar = a4.docActionsBar({
        applyTemplate: () => calls.push('template'),
        print: () => calls.push('print'),
        secondaryLabel: 'Сохранить черновик', secondary: () => calls.push('draft'),
        submitLabel: 'Опубликовать документ', submit: () => calls.push('publish'),
    });
    assert.ok(bar, 'полосы действий нет');
    const names = walk(bar).filter((e) => e.tagName === 'BUTTON').map((b) => textOf(b).trim());
    assert.equal(names.length, 4, 'действий должно быть четыре: ' + names.join(' | '));
    assert.match(names[0], /Заготовка/);
    assert.match(names[1], /Печать/);
    assert.match(names[2], /черновик/i);
    assert.match(names[3], /Опубликовать/);

    // Ни одной кнопки форматирования: ни Ж/К/П, ни списков, ни размера.
    for (const n of names) assert.ok(!/^(B|I|U|Aa|1.)$/.test(n), 'вернулось форматирование: ' + n);

    walk(bar).filter((e) => e.tagName === 'BUTTON').forEach((b) => b.click());
    assert.deepEqual(calls, ['template', 'print', 'draft', 'publish']);
});

// CASE_DOC_FORMAT_V1 — владелец: «add a rich text toolbar, into a fields on
// top, when pressed edit button … but do not do sloppy font written text panel».
test('CASE_DOC_FORMAT_V1: у раздела своя панель оформления — скрытая, иконками, над полем', () => {
    const made = a4.richSection('primary', 'objective', { onRename: () => {}, onRemove: () => {} });
    const kids = made.sec.children.map((c) => String(c.className || ''));
    const iBar = kids.findIndex((c) => c.includes('a4-fmt') && !c.includes('a4-fmt-t'));
    const iInput = kids.findIndex((c) => c.includes('a4-input'));
    assert.ok(iBar > -1, 'панели оформления у раздела нет');
    assert.ok(iBar < iInput, 'панель обязана стоять НАД полем: ' + kids.join(', '));

    const bar = made.sec.children[iBar];
    assert.equal(bar.hidden, true, 'панель должна быть скрыта, пока её не позвали');
    const toggle = made.sec.children.find((c) => String(c.className || '').includes('a4-fmt-t'));
    assert.ok(toggle, 'кнопки вызова панели нет');
    toggle.click();
    assert.equal(bar.hidden, false, 'кнопка не открыла панель');
    assert.equal(toggle.attrs['aria-expanded'], 'true');
    toggle.click();
    assert.equal(bar.hidden, true, 'второе нажатие не убрало панель');

    // ИКОНКИ, а не буквы: у кнопки нет собственного текста, но есть имя.
    const tools = walk(bar).filter((e) => e.tagName === 'BUTTON');
    assert.equal(tools.length, 6, 'инструментов должно быть шесть: ' + tools.length);
    for (const b of tools) {
        // Прежняя панель была набрана БУКВАМИ: «B», «I», «U», «• •», «1.», «Aa».
        // Буква вместо значка читается как отладочная надпись — владелец: «do
        // not do sloppy font written text panel».
        const own = textOf(b).trim();
        assert.ok(!/^(B|I|U|Aa|1\.|• •)$/.test(own), 'кнопка набрана буквами вместо значка: ' + own);
        assert.ok(own.startsWith('<svg'), 'в кнопке оформления нет значка набора');
        assert.ok((b.getAttribute('aria-label') || '').length > 2, 'у кнопки оформления нет имени');
    }
    assert.ok(String(bar.className).includes('no-print'), 'панель оформления пойдёт на бумагу');
});

test('CASE_DOC_ACTIONS_V1: печать берёт ТОТ ЖЕ лист и прячет служебное', () => {
    const html = a4.docPrintHtml('<div class="a4-paper"><b>Осмотр</b></div>',
        { title: 'Первичный осмотр', base: 'http://localhost:8000/' });
    assert.match(html, /Первичный осмотр/, 'у печатной страницы нет заголовка');
    assert.match(html, /a4-paper/, 'на бумагу не попал сам лист');
    // Окно печати пустое (about:blank): без <base> относительные ссылки в нём
    // разрешать не от чего, и лист приезжает голым текстом и без логотипа.
    assert.ok(html.includes('<base href="http://localhost:8000/">'), 'у печатной страницы нет корня для ссылок');
    // Без вшитых стилей остаются ссылки — пол, а не основной путь.
    assert.ok(html.includes('css/admin.css'), 'печать без таблицы стилей — голый текст');
    assert.ok(html.includes('css/admin-views.css'), 'печать без таблицы стилей документа');

    // А ВШИТЫЕ стили вытесняют ссылки: лист перестаёт зависеть от сети и
    // таймингов — именно так он и печатался голым текстом.
    const inlined = a4.docPrintHtml('<div class="a4-paper">лист</div>',
        { title: 'Осмотр', base: 'http://localhost:8000/', css: '.a4-paper{width:210mm}' });
    assert.ok(inlined.includes('.a4-paper{width:210mm}'), 'стили не вшиты в печатную страницу');
    assert.ok(!inlined.includes('css/admin.css'), 'при вшитых стилях ссылка на файл лишняя');
    // Служебное скрыто: кнопки, крестики, свёрнутые строки, полоса действий.
    for (const cls of ['no-print', 'a4-sec-add', 'a4-sec-x', 'cd-acts', 'a4-sec-off']) {
        assert.ok(html.includes('.' + cls), 'на бумаге осталось служебное: ' + cls);
    }
    assert.ok(html.includes('@page { size: A4'), 'печать не задаёт лист A4');
    // Шрифт объявляется заново: экранные правила приезжают, а файлы шрифта в
    // новом окне надо назвать — иначе браузер печатает системным Times.
    assert.match(html, /@font-face/, 'печатная страница без объявления шрифта');
    assert.match(html, /font-family:[^;]*Onest/, 'лист печатается не шрифтом клиники');
    // Пустой документ — одна страница: экранная высота листа гнала вторую.
    assert.match(html, /min-height: 0 !important/, 'пустой лист снова займёт две страницы');
});

// CASE_DOC_ACTIONS_V1 — владелец: «pressing print dont cloning the current
// document fully». Печать получала только разделы: звавший её код смотрел на
// ОДНОГО родителя, а между разделами и бумагой лежит ещё обёртка тела.
test('CASE_DOC_ACTIONS_V1: печать поднимается до самого листа, а не печатает одни разделы', () => {
    const paper = mkEl('div'); paper.className = 'a4-paper';
    const body = mkEl('div'); body.className = 'cw-doc-body';
    const sheet = mkEl('div'); sheet.className = 'cd-sheet';
    paper.appendChild(body); body.appendChild(sheet);
    sheet._parent = body; body._parent = paper;
    // Разметку берут через outerHTML — подставляем её обоим узлам, чтобы было
    // видно, КАКОЙ из них ушёл в печать.
    Object.defineProperty(paper, 'outerHTML', { get: () => '<div class=a4-paper>Heal point clinic · Этапный эпикриз</div>' });
    Object.defineProperty(sheet, 'outerHTML', { get: () => '<div class=cd-sheet>только разделы</div>' });

    let printed = null;
    const w = { document: { open() {}, write(html) { printed = html; }, close() {} }, focus() {}, print() {} };
    const openWas = globalThis.window.open;
    globalThis.window.open = () => w;
    try { a4.printDocSheet(sheet, { title: 'Этапный эпикриз' }); } finally { globalThis.window.open = openWas; }

    assert.ok(printed, 'окно печати не получило разметки');
    assert.ok(printed.includes('Heal point clinic'), 'на бумагу ушли одни разделы, без шапки листа');
    assert.ok(!printed.includes('только разделы'), 'печать взяла .cd-sheet вместо листа');});

test('CASE_DOC_ACTIONS_V1: чтение опубликованного не показывает ни черновика, ни сохранения', () => {
    const bar = a4.docActionsBar({ print: () => {} });
    const names = walk(bar).filter((e) => e.tagName === 'BUTTON').map((b) => textOf(b).trim());
    assert.deepEqual(names.length, 1, 'у чтения остаётся только печать: ' + names.join(' | '));
    assert.match(names[0], /Печать/);
});

test('CASE_DOC_FREE_SEC_V1: свой раздел бывает и без имени, и убирается крестиком', () => {
    const removed = [];
    const made = a4.freeSection({ title: 'Осмотр стопы', html: '<p>Пульсация</p>', onRemove: (box) => removed.push(box) });
    assert.equal(made.name.tagName, 'INPUT', 'имя раздела правится полем, как в кабинете врача');
    assert.equal(made.name.value, 'Осмотр стопы');
    assert.equal(made.input.attrs.contentEditable, 'true');
    assert.equal(a4.readRich(made.input), '<p>Пульсация</p>', 'текст своего раздела не восстановился');

    // Имя НЕОБЯЗАТЕЛЬНО: раздел без имени — законный случай.
    const bare = a4.freeSection({});
    assert.equal(bare.name.value, '');
    assert.ok(String(bare.name.attrs.placeholder || '').length > 0, 'у поля имени нет подсказки');

    const x = made.sec.children.find((c) => String(c.className || '').split(/\s+/).includes('a4-sec-x'));
    assert.ok(x, 'убрать свой раздел нечем');
    x.click();
    assert.deepEqual(removed, [made.sec]);
});

test('CASE_DOC_A4_V1: правая панель показывает четыре источника и вставляет анализ таблицей с отклонением', async () => {
    rpcCalls = [];
    const inserted = [];
    const panel = caseInsertPanel({ admissionId: 11, onInsert: (html) => { inserted.push(html); return true; } });
    BODY.appendChild(panel);
    await settle();

    assert.ok(rpcCalls.some((c) => c.name === 'admission_doc_sources' && c.args.admission_id === 11), 'источники спрошены у сервера');
    const t = textOf(panel);
    for (const block of ['Диагноз', 'Функциональные исследования', 'Лучевая диагностика', 'Лабораторные исследования']) {
        assert.ok(t.includes(block), 'нет блока: ' + block);
    }
    const items = walk(panel).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('ci-item'));
    const byText = (s) => items.find((x) => textOf(x).includes(s));

    // Анализ вставляется таблицей: показатель, значение с единицей, норма; отклонение — цветом.
    byText('Общий анализ крови').click();
    assert.equal(inserted.length, 1);
    const html = inserted[0];
    assert.ok(html.includes('<table class="a4-restbl">'), 'анализ вставляется таблицей: ' + html.slice(0, 120));
    assert.ok(html.includes('HGB') && html.includes('101') && html.includes('120–160'));
    assert.ok(/<span style="color: #b91c1c[^"]*">101<\/span>/.test(html), 'отклонение отмечено цветом: ' + html);
    assert.ok(html.includes('Общий анализ крови'), 'у блока есть заголовок с названием анализа');

    // Диагноз — одной строкой.
    byText('Острый аппендицит').click();
    assert.ok(inserted[1].includes('Острый аппендицит K35.8') && inserted[1].includes('<b>'), inserted[1]);

    // Исследование с заключением вставляется, без заключения — кнопка выключена.
    byText('Рентген').click();
    assert.ok(inserted[2].includes('Без очаговых теней'));
    const ecg = byText('ЭКГ');
    assert.ok(ecg.hasAttribute('disabled'), 'вставлять нечего — кнопка выключена, а не вставляет пустоту');
    ecg.click();
    assert.equal(inserted.length, 3, 'выключенная кнопка ничего не вставила');
});

// ─── CASE_DX_LIST_V1 — диагнозы списком, с ролями ───────────────────────────
const dx = await import('../views/case-dx.js');

test('CASE_DX_LIST_V1: строка диагнозов разбирается и собирается обратно, старая запись читается как основной', () => {
    assert.deepEqual(dx.parseDx('K35.8 — Острый аппендицит (осн.); I10 — Гипертензия (соп.)'), [
        { text: 'K35.8 — Острый аппендицит', type: 'main' },
        { text: 'I10 — Гипертензия', type: 'concomitant' },
    ]);
    // Документ, написанный до этого правила, обязан открываться.
    assert.deepEqual(dx.parseDx('Пневмония'), [{ text: 'Пневмония', type: 'main' }]);
    assert.deepEqual(dx.parseDx(''), []);
    assert.deepEqual(dx.parseDx('   '), []);
    // Скобка, которая не роль, остаётся частью названия.
    assert.deepEqual(dx.parseDx('Пневмония (нижнедолевая)'), [{ text: 'Пневмония (нижнедолевая)', type: 'main' }]);
    assert.equal(dx.formatDx([{ text: 'K35.8', type: 'main' }, { text: 'E11', type: 'background' }]), 'K35.8 (осн.); E11 (фон.)');
    assert.equal(dx.formatDx([]), '');
    // Круг замкнут: разобрали — собрали — то же самое.
    const s = 'K35.8 — Аппендицит (осн.); I10 — Гипертензия (соп.); E11 — Диабет (фон.)';
    assert.equal(dx.formatDx(dx.parseDx(s)), s);
});

test('CASE_DX_LIST_V1: две кнопки — справочник и свой текст; список хранится в поле документа', () => {
    const carrier = document.createElement('input');
    const box = dx.dxEditor({ carrier, required: true });
    assert.ok(textOf(box).includes('Для первичного осмотра диагноз обязателен.'), 'пусто — и об этом сказано');
    const btns = walk(box).filter((e) => e.tagName === 'BUTTON');
    const icdBtn = btns.find((b) => textOf(b).includes('Из МКБ-10'));
    const ownBtn = btns.find((b) => textOf(b).includes('Добавить свой'));
    assert.ok(icdBtn && icdBtn.className.includes('btn-primary'), 'справочник — главное действие');
    assert.ok(ownBtn && ownBtn.className.includes('btn-ghost'), 'свой диагноз — призрачная кнопка');

    const field = walk(box).find((e) => e.tagName === 'INPUT');
    field.value = 'Пневмония нижней доли';
    ownBtn.click();
    assert.equal(carrier.value, 'Пневмония нижней доли (осн.)', 'первый диагноз — основной');
    assert.equal(field.value, '', 'поле очищено под следующий');
    assert.ok(textOf(box).includes('Пневмония нижней доли'), 'диагноз виден строкой');

    field.value = 'Гипертензия';
    ownBtn.click();
    assert.equal(carrier.value, 'Пневмония нижней доли (осн.); Гипертензия (соп.)', 'второй — сопутствующий');

    // Повтор не добавляется дважды.
    field.value = 'гипертензия';
    ownBtn.click();
    assert.equal(carrier.value, 'Пневмония нижней доли (осн.); Гипертензия (соп.)');

    // Написанное, но не добавленное, забирается при сохранении.
    field.value = 'Анемия';
    carrier.dxCommit();
    assert.ok(carrier.value.includes('Анемия (соп.)'), 'текст из поля не теряется: ' + carrier.value);

    // Убрать диагноз можно крестиком.
    const x = walk(box).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('dx-chip-x'));
    assert.equal(x.length, 3);
    x[0].click();
    assert.ok(!carrier.value.includes('Пневмония'), 'убранный диагноз ушёл: ' + carrier.value);
});

// ===========================================================================
// CASE_DOC_BLANK_V1 — бланк документа: заготовка клиники, а не пустой лист.
//
// Владелец (2026-09-08): «we should be able to edit document in the #documents
// section». Проверяется то, что легко сломать молча: бланк хранится разметкой
// и чистится на обоих концах; согласия среди видов нет (его убрали из набора);
// и — главное — бланк НЕ затирает написанное: он подставляется только в новый
// документ и только в пустой раздел.
test('CASE_DOC_BLANK_V1: бланк хранится разметкой, чистится и не заводит пустых записей', () => {
    assert.ok(a4.CASE_BLANK_KINDS.includes('intake'), 'осмотра приёмного врача нет среди бланков');
    assert.ok(!a4.CASE_BLANK_KINDS.includes('consent'), 'согласие убрано из набора — бланка у него быть не должно');

    let all = a4.withCaseDocBlank({}, 'primary', 'objective', '<p>Состояние <b>удовлетворительное</b></p><script>x()</script>');
    assert.deepEqual(Object.keys(all), ['primary']);
    assert.equal(all.primary.objective, '<p>Состояние <b>удовлетворительное</b></p>', 'скрипт не доезжает до бланка');

    const settings = { caseDocBlanks: all };
    assert.deepEqual(a4.caseDocBlank(settings, 'primary'), { objective: '<p>Состояние <b>удовлетворительное</b></p>' });
    assert.deepEqual(a4.caseDocBlank(settings, 'round'), {}, 'чужой вид документа не получает чужой бланк');
    assert.deepEqual(a4.caseDocBlank(null, 'primary'), {}, 'без настроек бланка нет, а не падение');

    // Пустой раздел УБИРАЕТ запись, а не сохраняет пустоту: иначе «Заполнено
    // разделов» считало бы пустые строки, и бланк нельзя было бы очистить.
    all = a4.withCaseDocBlank(settings, 'primary', 'objective', '<p><br></p>');
    assert.deepEqual(all, {}, 'опустевший бланк исчезает целиком');

    // Настройки не правятся на месте: их сравнивают по ссылке, чтобы понять,
    // есть ли несохранённые изменения.
    assert.equal(settings.caseDocBlanks.primary.objective, '<p>Состояние <b>удовлетворительное</b></p>');
});

test('CASE_DOC_BLANK_V1: бланк подставляется в НОВЫЙ документ и только в пустой раздел', async () => {
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = pathx.dirname(fileURLToPath(import.meta.url));
    const src = fsx.readFileSync(pathx.join(dir, '..', 'views', 'admission-modal.js'), 'utf8');

    const i = src.indexOf('if (src) fill(src);');
    assert.ok(i > 0, 'редактор больше не заполняет форму найденной записью');
    const tail = src.slice(i, i + 900);
    assert.ok(tail.includes('else if (!isView && !isCorrection)'),
        'бланк подставляется в просмотр или исправление — он затрёт опубликованный текст');
    assert.ok(tail.includes('!readRich(rich[k])'),
        'бланк подставляется поверх непустого раздела — так теряется написанное');
    assert.ok(tail.includes('caseDocBlank(loadDocSettings(), kind)'),
        'бланк берётся не из настроек документов клиники');

    // #documents правит бланк ТЕМ ЖЕ листом, а не второй формой.
    const docs = fsx.readFileSync(pathx.join(dir, '..', 'views', 'documents.js'), 'utf8');
    assert.ok(docs.includes("id: 'case_doc'"), 'в «Документах» нет вкладки документов истории болезни');
    assert.ok(docs.includes('a4Sheet({ title: caseDocTitle(kind)'), 'бланк правится не листом A4');
    assert.ok(docs.includes('richToolbar(sheet)'), 'у бланка нет той же панели форматирования');
    assert.ok(docs.includes('withCaseDocBlank(state.s, kind, key, readRich(made.input))'),
        'правка бланка не попадает в настройки клиники');
});

// ===========================================================================
// ICD_PICKER_PAGES_V1 — справочник открыт сразу и листается страницами.
//
// Владелец (2026-09-08): «in the list show actual list with paginations without
// scroll adapted to the tablet». Окно открывалось пустым и просило ввести две
// буквы — врач видел пустоту там, где лежит весь справочник.
test('ICD_PICKER_PAGES_V1: окно открывается со списком, листается страницами и не прокручивается', async () => {
    dbCalls = [];
    const picked = [];
    dx.openIcdPicker({ onPick: (d) => picked.push(d) });
    await settle();

    const modal = BODY.children.filter((c) => String(c.className || '').includes('modal')).pop();
    assert.ok(modal, 'окно выбора не открылось');
    const rowsOf = () => walk(modal).filter((e) => String(e.className || '').split(/\s+/).includes('dxp-row'));
    const real = () => rowsOf().filter((e) => !String(e.className).includes('dxp-row-empty'));

    // Список ЕСТЬ сразу, без единого нажатия и без ввода.
    assert.equal(real().length, 8, 'первая страница показывает не восемь строк: ' + real().length);
    assert.ok(textOf(modal).includes('A00'), 'первая строка справочника не показана');
    assert.ok(textOf(modal).includes('Страница 1'), 'номер страницы не показан');
    // Запрошено на строку больше, чем показано: так узнают, есть ли следующая.
    const first = dbCalls.filter((c) => c.table === 'icd10').pop();
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 9, 'страница читается без запроса «сколько всего»');

    // Листание вперёд и назад.
    const pageBtns = walk(modal).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('dxp-page-btn'));
    assert.equal(pageBtns.length, 2, 'кнопок листания должно быть две');
    assert.equal(pageBtns[0].disabled, true, 'на первой странице «назад» неактивна');
    pageBtns[1].click();
    await settle();
    assert.ok(textOf(modal).includes('Страница 2'), 'вперёд не листается');
    assert.ok(textOf(modal).includes('A08'), 'вторая страница показывает не те строки');
    assert.equal(dbCalls.filter((c) => c.table === 'icd10').pop().offset, 8, 'смещение второй страницы неверное');

    // Последняя страница: строк меньше восьми, «вперёд» гаснет, а высота окна
    // держится пустыми местами — на планшете прыгающее окно уводит палец.
    pageBtns[1].click();
    await settle();
    assert.ok(textOf(modal).includes('Страница 3'));
    assert.equal(real().length, 4, 'на последней странице должно остаться четыре строки');
    assert.equal(rowsOf().length, 8, 'высота списка не держится: ' + rowsOf().length);
    const nextNow = walk(modal).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('dxp-page-btn'))[1];
    assert.equal(nextNow.disabled, true, '«вперёд» не погасла на последней странице');

    // Выбор строки отдаёт код и название с выбранной ролью.
    real()[0].click();
    assert.equal(picked.length, 1);
    assert.ok(picked[0].text.startsWith('A16'), 'выбрана не та строка: ' + picked[0].text);
    assert.equal(picked[0].type, 'main', 'по умолчанию диагноз основной');
});

test('ICD_PICKER_PAGES_V1: поиск СУЖАЕТ список и возвращает его на первую страницу', async () => {
    dbCalls = [];
    dx.openIcdPicker({ onPick: () => {} });
    await settle();
    const modal = BODY.children.filter((c) => String(c.className || '').includes('modal')).pop();
    const pageBtns = walk(modal).filter((e) => e.tagName === 'BUTTON' && String(e.className).includes('dxp-page-btn'));
    pageBtns[1].click();
    await settle();
    assert.ok(textOf(modal).includes('Страница 2'));

    const search = walk(modal).find((e) => e.tagName === 'INPUT' && String(e.className).includes('dxp-search'));
    assert.ok(search, 'поля поиска нет');
    search.value = 'пневмония';
    search.dispatchEvent({ type: 'input' });
    await settle();
    assert.ok(textOf(modal).includes('Страница 1'), 'поиск не вернул список на первую страницу');
    const last = dbCalls.filter((c) => c.table === 'icd10').pop();
    assert.equal(last.offset, 0, 'поиск читается не с начала');
    const ors = JSON.stringify(last.filters || []);
    assert.ok(ors.includes('пневмония'), 'запрос ушёл без искомого слова: ' + ors);
});

// ─── A4_ONE_TEMPLATE_V1 — один бланк на три экрана ──────────────────────────
//
// Владелец (2026-09-09): «make them similar design repeating the a4 template of
// the documents settings, and make them similar like in the doctors cabinet
// workplace». Экранный лист брал реквизиты из window.CLINIC, а печатный — из
// настроек «Документов»: клиника настраивала логотип и название, а на экране
// видела другую шапку.
test('A4_ONE_TEMPLATE_V1: шапка листа берёт реквизиты и акцент из настроек «Документов», а явная клиника всё равно главнее', async () => {
    const { clinicLetterheadData } = await import('../views/a4-letterhead.js');
    const { saveDocSettings, loadDocSettings } = await import('../views/doc-settings.js?v=noqr1');

    const before = loadDocSettings();
    saveDocSettings(Object.assign({}, before, { clinicName: 'Клиника «Настройки»', address: 'ул. Настроек, 1', phone: '+998 71 111 11 11', accent: '#b45309' }));
    const fromSettings = clinicLetterheadData();
    assert.equal(fromSettings.name, 'Клиника «Настройки»', 'шапка не спросила настройки документов');
    assert.equal(fromSettings.addr, 'ул. Настроек, 1');
    assert.equal(fromSettings.accent, '#b45309', 'акцент бланка не доехал до экрана');

    // Явно переданная клиника главнее: печать снимка обязана показать те
    // реквизиты, что были на момент снимка, а не сегодняшние.
    const snap = clinicLetterheadData({ name_ru: 'Клиника «Снимок»', address: 'ул. Снимка, 2' });
    assert.equal(snap.name, 'Клиника «Снимок»', 'снимок перебит сегодняшними настройками');
    assert.equal(snap.addr, 'ул. Снимка, 2');

    // Панель форматирования стоит своей полосой над листом — на всех трёх экранах.
    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path2.dirname(fileURLToPath(import.meta.url));
    const ws = fs2.readFileSync(path2.join(dir, '..', 'views', 'case-workspace.js'), 'utf8');
    const docs = fs2.readFileSync(path2.join(dir, '..', 'views', 'documents.js'), 'utf8');
    const cab = fs2.readFileSync(path2.join(dir, '..', 'views', 'service-workspace.js'), 'utf8');
    for (const [name, src] of [['история болезни', ws], ['бланк «Документов»', docs], ['кабинет врача', cab]]) {
        assert.ok(src.includes("class: 'a4-toolbar-slot'"), 'панель инструментов не в общей полосе: ' + name);
    }
});
