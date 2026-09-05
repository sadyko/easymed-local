// CASE_DOCS_V1 — чек-лист документов истории болезни: экранная половина.
//
// Серверная половина (сроки, состояния, редакции, сборка) проверена в
// server/services/rpc/case-docs.test.js. Здесь — ровно то, что решает БРАУЗЕР,
// и три из четырёх вопросов взяты из мокапа как ОТКАЗЫ от него:
//
//   1. ДО КАЖДОГО ДЕЙСТВИЯ МОЖНО ДОЙТИ БЕЗ МЫШИ. В мокапе кнопки «открыть /
//      исправить / создать» появляются на :hover — на тачскрине сестринского
//      поста их нет вовсе, а с клавиатуры до них не добраться. Здесь каждое
//      действие — <button> с именем, видимый всегда.
//   2. ЗАМЕТНАЯ КНОПКА РОВНО ОДНА, и стоит она у пункта, который СЕРВЕР назвал
//      следующим. Экран не выбирает его сам.
//   3. НАЗВАНИЕ ЕСТЬ У КАЖДОГО РОДА ДОКУМЕНТА. Род, приехавший с сервера без
//      имени, нарисовался бы пустой строкой — и список молча потерял бы пункт.
//   4. ПЕЧАТНЫЙ ФАЙЛ — это регламентный порядок, действующие редакции и
//      названные пробелы; черновиков в нём нет.

import { test } from 'node:test';
import assert from 'node:assert';

// ─── минимальный DOM (тот же стенд, что у mar-sheet.test.mjs) ───────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = '';
    }
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() {}
    focus() {} blur() {}
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
    getElementById() { return null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const nameOf = (b) => (b.getAttribute('aria-label') || b.textContent || '').trim();

const view = await import('../views/case-docs.js');
const server = await import('../../../../server/services/rpc/inpatient-reviews.js');

const {
    CASE_DOC_TITLE, caseDocTitle, caseDocStateWord, caseDueText, caseDoneText,
    caseGateText, caseMissingTitles, caseFilterMatch, caseVisibleItems,
    caseDocsView, caseFilePrintHtml, CASE_FILTERS,
} = view;

// ─── ответ сервера, снятый с настоящего admission_case_docs ─────────────────
const D = (kind, over) => Object.assign({
    kind, group: 'required', applies: true, required: true, state: 'pending',
    due_rule: 'clock', due_at: '2026-06-09T08:00:00Z', period_hours: null, periods_missing: 0,
    entries: 0, block: null, review_id: null, published_at: null, author_name: '',
    revisions: [], revision_count: 0, draft_id: null, has_draft: false,
}, over);

const STATE = {
    admission_id: 13, status: 'active', now: '2026-06-09T09:00:00Z',
    base_at: '2026-06-08T08:00:00Z', base_source: 'admitted',
    surgical: true, surgical_from: '2026-06-08T10:00:00Z',
    items: [
        D('consent', { state: 'published', published_at: '2026-06-08T11:57:00Z', author_name: 'Мудунов А.М.', review_id: 1, revision_count: 1, revisions: [{ id: 1, no: 1, at: '2026-06-08T11:57:00Z', author_name: 'Мудунов А.М.', current: true }] }),
        D('intake', {
            state: 'published', published_at: '2026-06-08T12:15:00Z', author_name: 'Мудунов А.М.', review_id: 3, revision_count: 2,
            revisions: [
                { id: 2, no: 1, at: '2026-06-08T10:40:00Z', author_name: 'Мудунов А.М.', current: false },
                { id: 3, no: 2, at: '2026-06-08T12:15:00Z', author_name: 'Мудунов А.М.', current: true },
            ],
        }),
        D('anesthesia', { state: 'published', published_at: '2026-06-08T13:00:00Z', author_name: 'Каримов Р.', review_id: 4, revision_count: 1, due_rule: 'surgical' }),
        D('preop', { state: 'published', published_at: '2026-06-08T14:00:00Z', author_name: 'Каримов Р.', review_id: 5, revision_count: 1, due_rule: 'surgical' }),
        D('head_review', { state: 'published', published_at: '2026-06-09T08:20:00Z', author_name: 'Юсупов А.', review_id: 6, revision_count: 1 }),
        D('primary', { state: 'next' }),
        D('rationale', { state: 'overdue', due_at: '2026-06-08T10:00:00Z' }),
        D('operation', { state: 'draft', has_draft: true, draft_id: 9, due_rule: 'surgical' }),
        D('round', { state: 'pending', due_rule: 'period', period_hours: 24, due_at: '2026-06-09T08:00:00Z' }),
        D('interim', { state: 'pending', required: false, due_rule: 'period', period_hours: 240, due_at: '2026-06-18T08:00:00Z' }),
        D('discharge', { state: 'pending', due_rule: 'at_discharge', due_at: null }),
    ],
    other: [Object.assign(D('other', { state: 'published', published_at: '2026-06-08T15:00:00Z', author_name: 'Мудунов А.М.', review_id: 20, revision_count: 1 }), { group: 'other', required: false })],
    progress: { done: 5, total: 10, overdue: 1, draft: 2 },
    next_kind: 'primary',
    discharge_gate: { blocked: true, blocking: [{ kind: 'discharge', reason: 'absent' }], incomplete: ['primary', 'rationale', 'operation', 'round', 'discharge'] },
};

const render = (over = {}) => caseDocsView({
    state: Object.assign({}, STATE, over), filter: over.filter || 'all',
    onFilter() {}, onDoc() {}, onAssemble() {},
});

// ─── 1. Названия ────────────────────────────────────────────────────────────

test('у каждого рода документа, который умеет присылать сервер, есть название', () => {
    for (const def of server.CASE_DOC_SET) {
        assert.ok(CASE_DOC_TITLE[def.kind], `род «${def.kind}» приедет с сервера без имени`);
        assert.ok(caseDocTitle(def.kind).length > 3, `имя рода «${def.kind}» пустое`);
    }
    assert.ok(CASE_DOC_TITLE[server.OTHER_KIND], 'у «прочего документа» тоже должно быть имя');
    // И обратно: лишнее имя — это род, который сервер прислать не может.
    const known = new Set([...server.CASE_DOC_SET.map((d) => d.kind), server.OTHER_KIND]);
    for (const kind of Object.keys(CASE_DOC_TITLE)) {
        assert.ok(known.has(kind), `имя «${kind}» не соответствует ни одному роду сервера`);
    }
});

test('слово состояния есть у всех пяти состояний мокапа', () => {
    for (const s of ['published', 'draft', 'overdue', 'next', 'pending']) {
        assert.ok(caseDocStateWord(s).length > 3, `состояние ${s} без слова`);
    }
    // Слово — третий способ назвать состояние: цвет и иконку читают не все.
    assert.notEqual(caseDocStateWord('published'), caseDocStateWord('overdue'));
});

// ─── 2. Срок словами ────────────────────────────────────────────────────────

test('форма фразы про срок зависит от рода срока, а не одна на всех', () => {
    const item = (k) => STATE.items.find((i) => i.kind === k);
    assert.match(caseDueText(item('discharge'), STATE), /выписк/i, '«при выписке» — событие, а не дата');
    assert.match(caseDueText(item('round'), STATE), /ежедневно/i, 'дневник — повторяющийся документ');
    assert.match(caseDueText(item('interim'), STATE), /10/, 'этапный эпикриз — период в 10 суток');
    assert.match(caseDueText(item('rationale'), STATE), /был/i, 'просроченный говорит о сроке в прошедшем времени');

    // Пропущенные сутки называются числом, а не «просрочено».
    const missed = Object.assign({}, item('round'), { state: 'overdue', periods_missing: 3 });
    assert.match(caseDueText(missed, STATE), /3/);

    // Пока пациент не на койке, срока нет ни у чего — и это сказано словами.
    const noBase = Object.assign({}, STATE, { base_at: null });
    assert.match(caseDueText(item('primary'), noBase), /койк/i);
});

test('оформленный документ подписан временем и автором', () => {
    const consent = STATE.items[0];
    const line = caseDoneText(consent);
    assert.match(line, /Мудунов/, 'кто подписал');
    assert.ok(line.length > 'Мудунов А.М.'.length, 'и когда');
});

// ─── 3. Фильтры ─────────────────────────────────────────────────────────────

test('фильтры отбирают то, что обещают', () => {
    assert.deepEqual(CASE_FILTERS.map(([k]) => k), ['all', 'todo', 'overdue']);
    const overdue = caseVisibleItems(STATE, 'overdue');
    assert.deepEqual(overdue.map((i) => i.kind), ['rationale']);
    const todo = caseVisibleItems(STATE, 'todo');
    assert.ok(!todo.some((i) => i.state === 'published'), '«к заполнению» не показывает оформленное');
    assert.equal(caseVisibleItems(STATE, 'all').length, STATE.items.length);
    assert.equal(caseFilterMatch('overdue', { state: 'draft' }), false);
});

test('неприменимый хирургический блок не занимает места', () => {
    const therapeutic = Object.assign({}, STATE, {
        surgical: false,
        items: STATE.items.map((i) => (i.due_rule === 'surgical' ? Object.assign({}, i, { applies: false, required: false }) : i)),
    });
    const kinds = caseVisibleItems(therapeutic, 'all').map((i) => i.kind);
    assert.ok(!kinds.includes('operation'), 'протокол операции у терапевтического пациента не показывают');
    assert.ok(kinds.includes('primary'));
});

// ─── 4. Действия достижимы без мыши ─────────────────────────────────────────

test('КАЖДОЕ действие — кнопка с именем, и ни одно не спрятано за наведение', () => {
    const el = render();
    const btns = buttons(el);
    assert.ok(btns.length >= 10, `кнопок должно быть много, а их ${btns.length}`);
    for (const b of btns) {
        assert.equal(b.getAttribute('type'), 'button', 'кнопка без type=button отправляет форму');
        assert.ok(nameOf(b).length > 0, 'кнопка без имени не читается ни голосом, ни глазом');
        // Мокап прячет действия за :hover (opacity:0). Здесь такого нет.
        assert.notEqual(String(b.style.opacity || ''), '0', 'действие спрятано до наведения');
        assert.notEqual(String(b.style.display || ''), 'none', 'действие скрыто');
    }
    // Ни один интерактивный элемент не сделан из <div onclick>.
    const clickable = walk(el).filter((e) => (e._l.click || []).length);
    for (const c of clickable) {
        assert.ok(['BUTTON', 'A', 'INPUT', 'SELECT'].includes(c.tagName),
            `по <${c.tagName.toLowerCase()}> кликают мышью, но не табом`);
    }
});

test('заметная кнопка ровно одна — у пункта, который следующим назвал СЕРВЕР', () => {
    const el = render();
    const primary = buttons(el).filter((b) => String(b.className).includes('btn-primary')
        && !b.hasAttribute('aria-pressed'));   // сегменты фильтра — не действие над документом
    assert.equal(primary.length, 1, 'две заметные кнопки перестают быть указанием, что делать дальше');
    assert.match(nameOf(primary[0]), /Продолжить/);

    // Сервер назвал другой пункт — заметная кнопка переехала, экран ничего не решал.
    const moved = render({
        next_kind: 'round',
        items: STATE.items.map((i) => (i.kind === 'primary' ? Object.assign({}, i, { state: 'pending' })
            : i.kind === 'round' ? Object.assign({}, i, { state: 'next' }) : i)),
    });
    const movedPrimary = buttons(moved).filter((b) => String(b.className).includes('btn-primary') && !b.hasAttribute('aria-pressed'));
    assert.equal(movedPrimary.length, 1);
});

test('фильтры — переключатели с aria-pressed, а не картинки', () => {
    const el = caseDocsView({ state: STATE, filter: 'overdue', onFilter() {}, onDoc() {}, onAssemble() {} });
    const segs = buttons(el).filter((b) => b.hasAttribute('aria-pressed'));
    assert.equal(segs.length, CASE_FILTERS.length);
    assert.equal(segs.filter((b) => b.getAttribute('aria-pressed') === 'true').length, 1);
});

test('список редакций раскрывается кнопкой с aria-expanded и показывает НАСТОЯЩИЕ редакции', () => {
    const el = render();
    const toggle = buttons(el).find((b) => /ред\./.test(nameOf(b)));
    assert.ok(toggle, 'у исправленного документа должен быть переключатель редакций');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'состояние переключателя объявлено');

    const text = el.textContent;
    assert.match(text, /Оригинал/, 'оригинал не исчез');
    assert.match(text, /Исправление 1/, 'и его исправление названо номером');
    // Открыть можно любую редакцию, включая закрытую, — ради этого список и есть.
    assert.ok(buttons(el).filter((b) => /Открыть/.test(nameOf(b))).length >= 2);
});

test('обязательные и прочие документы разделены, и «подшить документ» есть всегда', () => {
    const el = render();
    assert.match(el.textContent, /Обязательные/);
    assert.match(el.textContent, /Прочие документы/);
    assert.ok(buttons(el).some((b) => /Подшить документ/.test(nameOf(b))));
});

// ─── 5. Гейт выписки объяснён словами ───────────────────────────────────────

test('чек-лист объясняет отказ выписки тем же документом и с тем же различием', () => {
    assert.match(caseGateText(STATE), /не написан/i);
    const draft = Object.assign({}, STATE, {
        discharge_gate: { blocked: true, blocking: [{ kind: 'discharge', reason: 'draft' }], incomplete: ['discharge'] },
    });
    assert.match(caseGateText(draft), /черновик/i, 'черновик и пустое место — разные беды');
    const open = Object.assign({}, STATE, { discharge_gate: { blocked: false, blocking: [], incomplete: [] } });
    assert.match(caseGateText(open), /примут/i);

    // Недооформленное названо ПОИМЁННО, а не числом.
    const missing = caseMissingTitles(STATE);
    assert.equal(missing.length, STATE.discharge_gate.incomplete.length);
    assert.ok(missing.includes(caseDocTitle('rationale')));
    assert.match(render().textContent, new RegExp(caseDocTitle('rationale')));
});

// ─── 6. Печатный файл ───────────────────────────────────────────────────────

const FILE = {
    admission_id: 13,
    cover: {
        patient_name: 'Салимбоев Шухрат', patient_mrn: 'ID 23825', patient_birth_date: '2005-01-10',
        admission_no: 'ADM-00042', department: 'Хирургия', ward_name: 'Хирургия', bed_code: 'X-1',
        admitted_at: '2026-06-08T08:00:00Z', discharged_at: null, planned_discharge_at: '2026-06-14T08:00:00Z',
        attending_name: 'Мудунов А.М.', attending_specialty: 'Хирург',
        assembled_by: 'Юсупов А.', assembled_at: '2026-06-09T09:00:00Z',
    },
    documents: [
        { kind: 'consent', order: 0, review_id: 1, published_at: '2026-06-08T11:57:00Z', author_name: 'Мудунов А.М.', complaints: '', objective: '', diagnosis: '', plan: '', body: 'Согласие получено', revision_no: 1, revision_count: 1 },
        { kind: 'intake', order: 1, review_id: 3, published_at: '2026-06-08T12:15:00Z', author_name: 'Мудунов А.М.', complaints: 'Боли', objective: 'Живот напряжён', diagnosis: 'K35.8', plan: 'Стол №0', body: '', revision_no: 2, revision_count: 2 },
        { kind: 'primary', order: 5, review_id: 7, published_at: '2026-06-09T08:20:00Z', author_name: 'Юсупов А.', complaints: 'Боли', objective: 'Средней тяжести', diagnosis: 'K35.8', plan: 'Аппендэктомия', body: '', revision_no: 1, revision_count: 1 },
    ],
    gaps: ['rationale', 'round', 'discharge'],
    complete: false,
    drafts_excluded: 2,
    progress: { done: 3, total: 6, overdue: 1, draft: 2 },
};

test('печатный файл — обложка, регламентный порядок и названные пробелы', () => {
    const html = caseFilePrintHtml(FILE);

    // Обложка называет пациента, номер, палату, даты и лечащего врача.
    for (const s of ['Салимбоев Шухрат', 'ID 23825', 'ADM-00042', 'Хирургия', 'X-1', 'Мудунов А.М.', 'Юсупов А.']) {
        assert.ok(html.includes(s), `на обложке нет: ${s}`);
    }

    // Документы идут в том порядке, в котором их прислал сервер.
    const pos = FILE.documents.map((d) => html.indexOf(caseDocTitle(d.kind)));
    assert.ok(pos.every((x) => x > 0), 'каждый документ назван');
    assert.deepEqual(pos.slice().sort((a, b) => a - b), pos, 'порядок в файле — регламентный');

    // Текст документов внутри есть, и исправленный помечен редакцией.
    assert.ok(html.includes('Живот напряжён'));
    assert.match(html, /редакция 2/);

    // Пробелы названы поимённо, а не числом.
    for (const kind of FILE.gaps) assert.ok(html.includes(caseDocTitle(kind)), `пробел ${kind} не назван`);
    // И черновики не просто выброшены — сказано, сколько их.
    assert.match(html, /Черновиков не включено: 2/);
    assert.ok(html.includes('@page'), 'это печатный документ, а не экран');
});

test('полный комплект говорит об этом, и пустая сборка не притворяется полной', () => {
    const full = caseFilePrintHtml(Object.assign({}, FILE, { gaps: [], complete: true, drafts_excluded: 0 }));
    assert.match(full, /комплект документов полный/i);
    assert.ok(!/не хватает/i.test(full));

    const empty = caseFilePrintHtml(Object.assign({}, FILE, { documents: [] }));
    assert.match(empty, /Опубликованных документов пока нет/);
});

test('в печатный файл не попадает ничего, кроме присланных документов', () => {
    // Сервер черновики не присылает (см. server/.../case-docs.test.js); экран
    // не имеет права дорисовать их сам — печатает ровно то, что дали.
    const html = caseFilePrintHtml(FILE);
    const sections = html.split('<section class="doc">').length - 1;
    assert.equal(sections, FILE.documents.length, 'разделов в файле ровно столько, сколько документов прислал сервер');
    for (const b of FILE.documents.map((d) => d.body).filter(Boolean)) assert.ok(html.includes(b));
    // Слово «черновик» встречается ровно один раз — в объяснении на обложке,
    // почему их в файле нет, а не в теле документа.
    assert.equal((html.match(/[Чч]ерновик/g) || []).length, 2, 'черновик упомянут только объяснением на обложке');
});
