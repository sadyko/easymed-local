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
    assert.deepEqual(a4.sectionsFor('operation'), ['body'], 'протокол операции — один сплошной текст');
    assert.deepEqual(a4.sectionsFor('round'), ['complaints', 'objective', 'plan'], 'в дневнике диагноза не пишут');
    assert.deepEqual(a4.sectionsFor('intake'), ['complaints', 'objective', 'diagnosis', 'plan']);
    assert.deepEqual(a4.sectionsFor('неизвестный род'), ['complaints', 'objective', 'diagnosis', 'plan', 'body'],
        'незнакомый род получает полный набор, а не пустой лист');
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
