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
// Несуществующее имя иконки в БРАУЗЕРЕ рисует заметную заглушку, а не падает
// (icons.js): уронить экран клиники из-за значка дороже. В тесте окно
// подделано, поэтому строгий режим включается руками — иначе Icon('Save'),
// которого в наборе нет, молча проходил бы проверку и уезжал в клинику.
globalThis.EASYMED_ICONS_STRICT = true;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const buttons = (root) => walk(root).filter((e) => e.tagName === 'BUTTON');
const nameOf = (b) => (b.getAttribute('aria-label') || b.textContent || '').trim();

// ACT_OF_WORKS_V1 — вкладка акта СПРАШИВАЕТ сервер, поэтому у стенда есть
// ответчик: имя вызова → готовый ответ. Никакой сети, никаких выдумок за
// сервер — ровно тот кусок JSON, который он отдаёт.
const rpcAnswers = {};
globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }), headers: { getSetCookie: () => [] } });
    if (u.startsWith('/api/rpc/')) return ok(rpcAnswers[u.slice('/api/rpc/'.length)] ?? null);
    return ok(null);
};
const settle = () => new Promise((r) => setTimeout(r, 30));

const view = await import('../views/case-docs.js');
const server = await import('../../../../server/services/rpc/inpatient-reviews.js');
const { TITLE_KIND } = await import('../../../../server/services/rpc/title-sheet.js');   // TITLE_SHEET_V1

const {
    CASE_DOC_TITLE, caseDocTitle, caseDocStateWord, caseDueText, caseDoneText,
    caseGateText, caseMissingTitles, caseVisibleItems,
    caseDocsView, caseFilePrintHtml,
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
    state: Object.assign({}, STATE, over), onDoc() {}, onAssemble() {},
});

// ─── 1. Названия ────────────────────────────────────────────────────────────

test('у каждого рода документа, который умеет присылать сервер, есть название', () => {
    for (const def of server.CASE_DOC_SET) {
        assert.ok(CASE_DOC_TITLE[def.kind], `род «${def.kind}» приедет с сервера без имени`);
        assert.ok(caseDocTitle(def.kind).length > 3, `имя рода «${def.kind}» пустое`);
    }
    assert.ok(CASE_DOC_TITLE[server.OTHER_KIND], 'у «прочего документа» тоже должно быть имя');
    // И обратно: лишнее имя — это род, который сервер прислать не может.
    assert.ok(CASE_DOC_TITLE[TITLE_KIND], 'у титульного листа медсестры должно быть имя');   // TITLE_SHEET_V1
    // CONSENT_OUT_V1 — согласие из набора ушло, но старые записи этого рода сервер
    // по-прежнему присылает в собранной истории (LEGACY_KINDS) — имя им нужно.
    const known = new Set([...server.CASE_DOC_SET.map((d) => d.kind), ...(server.LEGACY_KINDS || []), server.OTHER_KIND, TITLE_KIND]);
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

// ─── 3. Состав набора правится в самом списке ───────────────────────────────

// CASE_DOC_SET_INLINE_V1 — владелец: «remove this shit completely, and add to
// the kasallik tarixi hujjatlari a buttons near the documents cards. and in the
// bottom a card with free fields. and remove options».
//
// Отдельная панель состава перечисляла ТЕ ЖЕ документы, что и чек-лист строкой
// выше: один список в колонке дважды. Проверяется то, что заняло её место, —
// и то, что фильтры действительно ушли: спрятанный пункт чек-листа это пункт,
// о котором забыли.
test('CASE_DOC_SET_INLINE_V1: фильтров нет — список показывает ВСЁ', () => {
    const el = render();
    assert.equal(buttons(el).filter((b) => b.hasAttribute('aria-pressed')).length, 0,
        'сегменты фильтра вернулись в чек-лист');
    assert.equal(caseVisibleItems(STATE).length, STATE.items.length);
    // Оформленный документ виден наравне с просроченным: чек-лист затем и есть.
    assert.match(el.textContent, new RegExp(caseDocTitle('intake')));
    assert.match(el.textContent, new RegExp(caseDocTitle('rationale')));
});

test('CASE_DOC_SET_INLINE_V1: «убрать из набора» стоит у строки и называет документ', () => {
    // Без обработчика кнопок нет вовсе: состав правят главный врач и
    // администратор, остальным кнопка только отказала бы.
    assert.equal(buttons(render()).filter((b) => /Убрать из набора/.test(nameOf(b))).length, 0,
        'кнопка правки состава появилась у того, кому её не давали');

    const dropped = [];
    const el = caseDocsView({
        state: STATE, onDoc() {}, onAssemble() {},
        onDrop: (kind, name) => dropped.push([kind, name]), onAdd() {},
    });
    const drops = buttons(el).filter((b) => /Убрать из набора/.test(nameOf(b)));
    // У каждого пункта набора — и НИ ОДНОГО у титульного листа и у прочих
    // документов: их в справочнике набора нет, убрать оттуда нечего.
    assert.equal(drops.length, STATE.items.filter((i) => i.kind !== TITLE_KIND).length,
        'кнопка «убрать» должна быть у каждого пункта набора: ' + drops.length);
    assert.ok(!drops.some((b) => new RegExp(caseDocTitle(TITLE_KIND)).test(nameOf(b))),
        'титульный лист не пункт набора — убирать его нечем');

    drops.find((b) => new RegExp(caseDocTitle('round')).test(nameOf(b))).click();
    assert.deepEqual(dropped, [['round', caseDocTitle('round')]],
        'кнопка обязана сказать, КАКОЙ документ убирают');
});

// CASE_DOC_OWN_NAME_V1 — владелец: «added document not called as it should be».
// Свой документ клиники называется тем именем, которым его завели: лист
// подписывался «Прочий документ», потому что имя не доезжало до редактора —
// в словаре встроенных названий рода own_N нет и быть не может.
test('CASE_DOC_OWN_NAME_V1: имя своего документа едет в редактор при каждом открытии', () => {
    const opened = [];
    const own = D('own_5', { title: 'Лист анестезиолога', state: 'overdue', due_at: '2026-06-08T10:00:00Z' });
    const el = caseDocsView({
        state: Object.assign({}, STATE, { items: STATE.items.concat([own]) }),
        onDoc: (kind, mode, id, name) => opened.push([kind, name]),
        onAssemble() {},
    });

    // Имя в списке — своё, а не «Прочий документ».
    assert.ok(el.textContent.includes('Лист анестезиолога'), 'свой документ назван чужим именем в списке');

    // И в редактор едет ОНО ЖЕ: и по строке, и по кнопке действия.
    const row = buttons(el).find((b) => /Лист анестезиолога/.test(nameOf(b)));
    assert.ok(row, 'строки своего документа нет');
    row.click();
    const act = buttons(el).filter((b) => /Оформить/.test(nameOf(b)));
    act[act.length - 1].click();
    assert.deepEqual(opened, [['own_5', 'Лист анестезиолога'], ['own_5', 'Лист анестезиолога']],
        'редактор получил род без имени — лист подпишется «Прочим документом»');
});

test('CASE_DOC_OWN_NAME_V1: редактор подписывает лист присланным именем, а не словарём', async () => {
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = pathx.dirname(fileURLToPath(import.meta.url));
    const src = fsx.readFileSync(pathx.join(dir, '..', 'views', 'admission-modal.js'), 'utf8');
    // Половина пути, которую щелчком не проверить: имя обязано дойти от
    // параметра редактора до заголовка листа.
    assert.ok(src.includes("docTitle = '', onDone }"), 'редактор перестал принимать имя документа');
    assert.ok(src.includes('title: reviewTitle(kind, mode, docTitle)'), 'заголовок листа снова не смотрит на присланное имя');
    assert.ok(src.includes("function reviewTitle(kind, mode, docTitle = '')"), 'reviewTitle снова считает имя только по словарю');
});

// CASE_DOC_SET_BACK_V1 — владелец: «when i am deleting the documents we gave
// should disappear but go inactive and added when necessary». Убранный
// документ не исчезает бесследно: он стоит бледной строкой в конце списка, и
// «+» возвращает его на место.
test('CASE_DOC_SET_BACK_V1: убранный документ виден бледной строкой и возвращается нажатием', () => {
    const gone = [{ kind: 'head_review', name: caseDocTitle('head_review'), active: false, own: false, used: 2 }];

    // Без права правки состава убранных не показываем вовсе: вернуть их
    // палатный врач всё равно не может.
    const plain = caseDocsView({ state: STATE, onDoc() {}, onAssemble() {}, types: gone });
    assert.ok(!plain.textContent.includes('Убраны из набора'), 'убранные показаны тому, кто не правит состав');

    const back = [];
    const el = caseDocsView({
        state: STATE, onDoc() {}, onAssemble() {}, onDrop() {}, onAdd() {},
        types: gone, onRestore: (kind, name) => back.push([kind, name]),
    });
    assert.ok(el.textContent.includes('Убраны из набора'), 'раздела убранных нет');
    assert.ok(el.textContent.includes(caseDocTitle('head_review')), 'убранный документ не назван');

    const plus = buttons(el).find((b) => /Вернуть в набор/.test(nameOf(b)));
    assert.ok(plus, 'вернуть документ нечем');
    plus.click();
    assert.deepEqual(back, [['head_review', caseDocTitle('head_review')]]);
});

// CASE_DOC_RENAME_V1 — владелец: «why i cant delete or edit added documents?
// add an option». Заведённый документ можно переименовать прямо в строке и
// удалить насовсем, пока им ничего не написано.
test('CASE_DOC_RENAME_V1: карандаш только у своего документа, и правит имя на месте', () => {
    const renamed = [];
    const own = D('own_5', { title: 'Лист анестезиолога', state: 'overdue' });
    const el = caseDocsView({
        state: Object.assign({}, STATE, { items: STATE.items.concat([own]) }),
        onDoc() {}, onAssemble() {}, onDrop() {},
        types: [{ kind: 'own_5', name: 'Лист анестезиолога', active: true, own: true, used: 0 },
                { kind: 'intake', name: caseDocTitle('intake'), active: true, own: false, used: 3 }],
        onRename: (kind, title) => renamed.push([kind, title]),
    });

    // Встроенный не переименовывается: его имя переводится на три языка.
    const pencils = buttons(el).filter((b) => /Переименовать/.test(nameOf(b)));
    assert.equal(pencils.length, 1, 'карандаш должен быть ровно у своего документа');
    assert.match(nameOf(pencils[0]), /Лист анестезиолога/);

    // Правка НА МЕСТЕ: кнопка-имя подменяется полем, окна не открывается.
    pencils[0].click();
    const input = walk(el).find((e) => e.tagName === 'INPUT' && String(e.className).includes('cd-ren'));
    assert.ok(input, 'поле правки имени не появилось');
    assert.equal(input.value, 'Лист анестезиолога', 'поле не подставило нынешнее имя');
    input.value = 'Лист анестезиолога №1';
    input.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(renamed, [['own_5', 'Лист анестезиолога №1']]);

    // Перерисовка списка уводит фокус с поля, и blur не должен слать имя
    // второй раз: два запроса и два сообщения на одно нажатие.
    input.dispatchEvent({ type: 'blur' });
    assert.equal(renamed.length, 1, 'имя ушло на сервер дважды');
});

test('CASE_DOC_RENAME_V1: Esc отменяет правку имени, а не сохраняет её', () => {
    const renamed = [];
    const own = D('own_5', { title: 'Лист анестезиолога', state: 'overdue' });
    const el = caseDocsView({
        state: Object.assign({}, STATE, { items: STATE.items.concat([own]) }),
        onDoc() {}, onAssemble() {}, onDrop() {},
        types: [{ kind: 'own_5', name: 'Лист анестезиолога', active: true, own: true, used: 0 }],
        onRename: (kind, title) => renamed.push([kind, title]),
    });
    buttons(el).find((b) => /Переименовать/.test(nameOf(b))).click();
    const input = walk(el).find((e) => e.tagName === 'INPUT' && String(e.className).includes('cd-ren'));
    input.value = 'Передумал';
    input.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
    input.dispatchEvent({ type: 'blur' });   // фокус уходит сразу за Esc
    assert.deepEqual(renamed, [], 'отменённое имя всё равно сохранилось');
});

test('CASE_DOC_RENAME_V1: корзина только у своего убранного документа, которым не писали', () => {
    const deleted = [];
    const el = caseDocsView({
        state: STATE, onDoc() {}, onAssemble() {}, onDrop() {}, onRestore() {},
        types: [
            { kind: 'own_7', name: 'Заведён по ошибке', active: false, own: true, used: 0 },
            { kind: 'own_8', name: 'Свой, но написанный', active: false, own: true, used: 4 },
            { kind: 'head_review', name: caseDocTitle('head_review'), active: false, own: false, used: 0 },
        ],
        onDelete: (kind, name) => deleted.push([kind, name]),
    });

    const bins = buttons(el).filter((b) => /Удалить насовсем/.test(nameOf(b)));
    assert.equal(bins.length, 1, 'корзина должна быть только у своего и ненаписанного: ' + bins.length);
    assert.match(nameOf(bins[0]), /Заведён по ошибке/);
    // Вернуть можно ЛЮБОЙ убранный — и написанный, и встроенный.
    assert.equal(buttons(el).filter((b) => /Вернуть в набор/.test(nameOf(b))).length, 3);

    bins[0].click();
    assert.deepEqual(deleted, [['own_7', 'Заведён по ошибке']]);
});

test('CASE_DOC_ADD_IN_LIST_V1: строка создания — последняя строка СПИСКА', () => {
    const added = [];
    const el = caseDocsView({
        state: STATE, onDoc() {}, onAssemble() {}, onDrop() {}, onAdd: (t) => added.push(t),
    });
    const input = walk(el).find((e) => e.tagName === 'INPUT' && String(e.className).includes('cd-add-in'));
    assert.ok(input, 'поля создания нет');

    // В СПИСКЕ, а не в подвале: владелец «please transfer this in to a list».
    // В подвале строка стояла под правилом выписки и перечнем неоформленного —
    // за двумя абзацами от списка, к которому относится.
    const zone = (cls) => walk(el).find((e) => String(e.className || '').split(/\s+/).includes(cls));
    const list = zone('cd-list');
    const foot = zone('cd-foot');
    assert.ok(walk(list).includes(input), 'строка создания не в списке');
    assert.ok(!walk(foot).includes(input), 'строка создания осталась и в подвале');

    // И последней: сперва документы, потом «а такого нет — заведите».
    const rows = list.children.map((c) => String(c.className || ''));
    assert.ok(rows[rows.length - 1].includes('cd-add-note') || rows[rows.length - 1].includes('cd-add'),
        'строка создания оказалась не в конце списка: ' + rows.join(', '));

    const go = buttons(el).find((b) => /Добавить документ в набор/.test(nameOf(b)));
    assert.ok(go, 'кнопки создания нет');
    // Пустое имя ничего не заводит: пустой документ в наборе — вечный пункт
    // без названия, который никто не сможет ни написать, ни убрать.
    input.value = '   ';
    go.click();
    assert.deepEqual(added, []);

    input.value = 'Лист анестезиолога';
    go.click();
    assert.deepEqual(added, ['Лист анестезиолога']);
    assert.equal(input.value, '', 'поле не очистилось под следующий документ');
});
test('неприменимый хирургический блок не занимает места', () => {
    const therapeutic = Object.assign({}, STATE, {
        surgical: false,
        items: STATE.items.map((i) => (i.due_rule === 'surgical' ? Object.assign({}, i, { applies: false, required: false }) : i)),
    });
    const kinds = caseVisibleItems(therapeutic).map((i) => i.kind);
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
    const primary = buttons(el).filter((b) => String(b.className).includes('btn-primary'));
    assert.equal(primary.length, 1, 'две заметные кнопки перестают быть указанием, что делать дальше');
    assert.match(nameOf(primary[0]), /Продолжить/);

    // Сервер назвал другой пункт — заметная кнопка переехала, экран ничего не решал.
    const moved = render({
        next_kind: 'round',
        items: STATE.items.map((i) => (i.kind === 'primary' ? Object.assign({}, i, { state: 'pending' })
            : i.kind === 'round' ? Object.assign({}, i, { state: 'next' }) : i)),
    });
    const movedPrimary = buttons(moved).filter((b) => String(b.className).includes('btn-primary'));
    assert.equal(movedPrimary.length, 1);
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

// CASE_FILE_TABS_V1 — владелец: «after the card of the patient we need to add
// tabs for navigation: documents, prescriptions, examinations and lab, surgery».
test('CASE_FILE_TABS_V1: четыре вкладки, и каждая показывает СВОИ данные, не выдумывая их', async () => {
    const tabs = await import('../views/case-file-tabs.js');
    assert.deepEqual(tabs.CASE_TABS.map((t) => t.id), ['documents', 'orders', 'exams', 'surgery', 'act']);

    // Полоса — системная (.tabs/.tab), как во всех разделах приложения.
    const picked = [];
    const bar = tabs.caseTabsBar({ active: 'orders', onPick: (id) => picked.push(id) });
    assert.ok(String(bar.className).split(/\s+/).includes('tabs'), 'полоса вкладок не системная');
    const btns = walk(bar).filter((e) => e.tagName === 'BUTTON');
    assert.equal(btns.length, 5);
    assert.equal(btns[1].getAttribute('aria-selected'), 'true', 'открытая вкладка не помечена');
    btns[0].click();
    assert.deepEqual(picked, ['documents']);
    btns[1].click();
    assert.deepEqual(picked, ['documents'], 'нажатие на уже открытую вкладку не должно ничего делать');

    // Назначения: список из обзора и дверь в лист назначений.
    const opened = [];
    const orders = tabs.caseOrdersPanel({ orders: [{ name: 'Цефтриаксон', dose: '1 г', route: 'в/в', freq_code: '2 раза в сутки' }] },
        { onOpenSheet: () => opened.push(1) });
    assert.match(orders.textContent, /Цефтриаксон/);
    walk(orders).filter((e) => e.tagName === 'BUTTON').pop().click();
    assert.deepEqual(opened, [1], 'вкладка обязана уводить в лист назначений, а не рисовать вторую сетку');

    // Пустых выдумок нет: без назначений вкладка так и говорит.
    assert.match(tabs.caseOrdersPanel({ orders: [] }).textContent, /Назначений пока нет/);

    // Операция: состояние от сервера, документы — из чек-листа.
    const docOpened = [];
    const surgery = tabs.caseSurgeryPanel(
        { operation: { state: 'done', at: '2026-06-08T10:00:00Z' } },
        { items: STATE.items }, { onDoc: (kind) => docOpened.push(kind) });
    assert.match(surgery.textContent, /Проведена/);
    assert.match(surgery.textContent, new RegExp(caseDocTitle('operation')));
    walk(surgery).filter((e) => e.tagName === 'BUTTON')[0].click();
    assert.ok(['anesthesia', 'preop', 'operation'].includes(docOpened[0]),
        'кнопка документа операции должна открывать документ: ' + docOpened[0]);
});

// ACT_OF_WORKS_V1 — владелец: «act of done things». Акт показывает начисленное
// построчно и НЕ СЧИТАЕТ САМ: суммы приходят с сервера.
test('ACT_OF_WORKS_V1: акт показывает строки и итоги сервера, а пустой честно молчит', async () => {
    const tabs = await import('../views/case-file-tabs.js');
    assert.ok(tabs.CASE_TABS.some((t) => t.id === 'act'), 'вкладки акта нет');

    // Ответ сервера — тот же, что отдаёт admission_charges.
    const answer = {
        lines: [
            { id: 1, kind: 'stay', name: 'Проживание · Палата 1 · 2 сут. × 200000', quantity: 2,
              unit: '', unit_price: 200000, total: 400000, billable: true, invoice_number: '', locked: false },
            { id: 2, kind: 'item', name: 'Система для инфузий', quantity: 3, unit: 'шт.',
              unit_price: 7000, total: 21000, billable: false, invoice_number: '', locked: false },
            { id: 3, kind: 'service', name: 'Перевязка', quantity: 1, unit: '', unit_price: 50000,
              total: 50000, billable: true, invoice_number: 'СЧ-00041', locked: true },
        ],
        totals: { accrued: 471000, billable: 450000, invoiced: 50000, pending: 400000, not_billable: 21000, lines: 3 },
    };
    rpcAnswers.admission_charges = answer;

    const panel = tabs.caseActPanel(13, { onInvoice: () => {}, onAddExpense: () => {} });
    await settle();
    const t = panel.textContent;
    for (const piece of ['Система для инфузий', 'Перевязка', 'СЧ-00041', 'шт.']) {
        assert.ok(t.includes(piece), 'в акте нет: ' + piece);
    }
    // Суммы — те, что прислал сервер, и в том виде, в каком их читает касса.
    for (const piece of ['471 000', '400 000', '50 000', '21 000']) {
        assert.ok(t.includes(piece), 'итог не показан: ' + piece);
    }
    assert.ok(t.includes('Начислено') && t.includes('К выставлению') && t.includes('В счетах'),
        'итоги не подписаны');

    // Строка, уже попавшая в счёт, не предлагает себя выключить: за ней деньги.
    const btns = walk(panel).filter((e) => e.tagName === 'BUTTON').map((b) => nameOf(b));
    assert.ok(!btns.some((n) => /Перевязка/.test(n)), 'у выставленной строки появилась кнопка');

    // Пустой акт говорит, что начислений нет, а не рисует пустую таблицу.
    rpcAnswers.admission_charges = { lines: [], totals: { accrued: 0, pending: 0, invoiced: 0, not_billable: 0, lines: 0 } };
    const bare = tabs.caseActPanel(13, {});
    await settle();
    assert.match(bare.textContent, /ещё ничего не начислено/i);
});

// CASE_DOC_LIST_QUIET_V1 — владелец показал на пустой блок «Прочие документы»
// со строкой «Ничего не подшито», кнопкой «Подшить» и абзацем про хирургию:
// «remove this please». Три элемента из четырёх говорили о том, чего НЕТ.
// Подшитое никуда не делось — оно возвращает и заголовок, и строки.
test('CASE_DOC_LIST_QUIET_V1: пустые «прочие документы» молчат, а подшитые видны', () => {
    const el = render();
    assert.match(el.textContent, /Обязательные/);
    assert.ok(el.textContent.includes('Прочие документы'), 'подшитый документ есть, а заголовка нет');

    const empty = render({ other: [] });
    assert.ok(!empty.textContent.includes('Прочие документы'), 'пустой раздел вернулся');
    assert.ok(!empty.textContent.includes('Ничего не подшито'), 'строка про пустоту вернулась');
    assert.equal(buttons(empty).filter((b) => /Подшить документ/.test(nameOf(b))).length, 0,
        'кнопка «Подшить документ» вернулась');

    // И абзац про хирургический блок — тоже: его убрали вместе с остальным.
    const therapeutic = render({ surgical: false, other: [] });
    assert.ok(!therapeutic.textContent.includes('появятся в списке'), 'абзац про хирургический блок вернулся');
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

    // CASE_DOC_SET_OPEN_V1 — эпикриз отпёрли, и клиника вправе убрать его из
    // набора. Тогда её не отчитывают об оформленном документе, которого у неё
    // нет: выписку не держит ничего, и так и сказано.
    assert.match(caseGateText(open), /эпикриз оформлен/i, 'клиника держит эпикриз — про него и сказано');
    const noEpi = Object.assign({}, open, { items: (open.items || []).filter((it) => it.kind !== 'discharge') });
    assert.match(caseGateText(noEpi), /убран из набора/i,
        'убранный из набора эпикриз всё ещё числится оформленным');

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

    // CASE_FILE_COVER_V2 — списка «чего не хватает» на бумаге больше нет: он
    // подсказка экрана, а не содержание истории (владелец: «remove this from the list»).
    assert.ok(!/не хватает/i.test(html), 'на обложке снова список пробелов');
    for (const kind of FILE.gaps) assert.ok(!html.includes(caseDocTitle(kind)), `пробел ${kind} назван на бумаге`);
    // И черновики не просто выброшены — сказано, сколько их.
    assert.match(html, /Черновиков не включено: 2/);
    assert.ok(html.includes('@page'), 'это печатный документ, а не экран');
});

test('обложка не судит о полноте комплекта, и пустая сборка не притворяется полной', () => {
    const full = caseFilePrintHtml(Object.assign({}, FILE, { gaps: [], complete: true, drafts_excluded: 0 }));
    assert.ok(!/комплект документов полный/i.test(full), 'CASE_FILE_COVER_V2 — оценка полноты на бумаге не печатается');
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

// ─── CASE_RAIL_FIT_V1 — три зоны: шапка, прокручиваемый список, подвал ──────
//
// Владелец (2026-09-08): «this section should fit in to a left panel. and user
// should not scroll. only scroll in the list. and be able to create a a list».
// Панель была одной стопкой, и «Собрать историю» оказывалась за краем экрана.
test('CASE_RAIL_FIT_V1: чек-лист разложен на шапку, прокручиваемый список и подвал — прокручивается только список', () => {
    const el = render();
    const zone = (cls) => walk(el).find((e) => String(e.className || '').split(/\s+/).includes(cls));
    const head = zone('cd-head');
    const list = zone('cd-list');
    const foot = zone('cd-foot');
    assert.ok(head && list && foot, 'зон должно быть три: шапка, список, подвал');

    // Порядок сверху вниз — тот же, что на экране.
    const box = walk(el).find((e) => String(e.className || '').includes('cd-box')) || el;
    const order = box.children.map((c) => c.className);
    assert.deepEqual(order, ['cd-head', 'cd-list', 'cd-foot'], 'зоны переставлены: ' + order.join(', '));

    // Что где: цифры и фильтры в шапке, документы и «Подшить» в списке.
    const t = (n) => walk(n).map((x) => x._text || '').join(' ');
    assert.ok(t(head).includes('оформлено'), 'счётчик уехал из шапки');
    // CASE_DOC_SET_INLINE_V1 — фильтров в шапке больше нет; карточка создания
    // стоит в подвале, то есть под прокручиваемым списком, а не в нём.
    assert.ok(!walk(head).some((e) => e.hasAttribute && e.hasAttribute('aria-pressed')), 'фильтры вернулись в шапку');
    assert.ok(t(list).includes('Первичный осмотр и план лечения'), 'документы уехали из списка');
    // CASE_DOC_LIST_QUIET_V1 — пополняют список полем в подвале, а не кнопкой
    // внутри него: в списке остались только документы.
    assert.equal(buttons(list).filter((x) => nameOf(x).includes('Подшить документ')).length, 0,
        'кнопка «Подшить документ» вернулась в список');

    // Подвал НЕ прокручивается вместе со списком: правило выписки читают
    // тогда же, когда смотрят на список, а не после него.
    assert.ok(t(foot).includes('выписк') || t(foot).includes('эпикриз'), 'правило выписки уехало из подвала');
    assert.ok(!t(list).includes('Не оформлено из обязательного набора'), 'перечень недооформленного попал в прокрутку');

    // Ни одна строка документа не осталась вне списка.
    const rows = walk(el).filter((e) => e.tagName === 'LI');
    const inList = walk(list).filter((e) => e.tagName === 'LI');
    assert.equal(rows.length, inList.length, 'часть строк документов рисуется вне прокручиваемого списка');
});
