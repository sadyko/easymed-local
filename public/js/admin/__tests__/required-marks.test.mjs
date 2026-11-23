// INPATIENT_REQUIRED_V1 — отметки обязательных полей, окно «Заполнено не всё»,
// правила стационара для экранов, подписи полей титульного листа.
//
// Владелец: «in the required fields of the title and other user cannot understand
// which fields he is not filled, cn we add visual cues for that?»
import test from 'node:test';
import assert from 'node:assert/strict';

// ─── минимальный DOM (тот же, что в title-sheet.test.mjs, плюс фокус, родитель,
//     removeAttribute, scrollIntoView и слушатели документа) ──────────────────
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {}; this.children = []; this.attrs = {};
        this.className = ''; this._text = ''; this._l = {}; this.dataset = {};
        this.value = ''; this.parentNode = null;
    }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentNode = null; return c; }
    insertAdjacentElement(where, n) {
        const p = this.parentNode;
        if (where !== 'afterend' || !p) return null;
        p.children.splice(p.children.indexOf(this) + 1, 0, n); n.parentNode = p; return n;
    }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    replaceChildren() { this.children.length = 0; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener(t, fn) { const a = this._l[t] || []; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); }
    dispatchEvent(e) { for (const fn of (this._l[e.type] || []).slice()) fn(Object.assign({ currentTarget: this, preventDefault() {}, stopPropagation() {} }, e)); return true; }
    click() { this.dispatchEvent({ type: 'click' }); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    focus(opts) { this._focused = true; this._focusOpts = opts; globalThis.document.activeElement = this; }
    blur() {}
    scrollIntoView(opts) { this._scrolled = true; this._scrollOpts = opts; }
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
// Слушатели документа — по-настоящему: окно ловит Escape и Tab на документе.
const DOC_L = [];
globalThis.document = {
    createElement: mkEl, createElementNS: (_n, t) => mkEl(t), createTextNode: (t) => new FakeText(t),
    head: mkEl('head'), body: BODY, documentElement: mkEl('html'), activeElement: null,
    addEventListener(type, fn, capture) { DOC_L.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn) { const i = DOC_L.findIndex((x) => x.type === type && x.fn === fn); if (i > -1) DOC_L.splice(i, 1); },
    getElementById(id) { return BODY.children.find((c) => c.attrs && c.attrs.id === id) || null; },
};
globalThis.window = {
    location: { hostname: 'localhost' }, localStorage: { getItem: () => null, setItem() {} }, addEventListener() {},
    open: () => null,
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, out = []) => { if (!e || typeof e !== 'object') return out; out.push(e); for (const c of e.children || []) walk(c, out); return out; };
const textOf = (e) => walk(e).map((x) => x._text || '').join(' ');
const findBtn = (root, label) => walk(root).find((e) => e.tagName === 'BUTTON' && textOf(e).includes(label));
const byId = (root, id) => walk(root).find((e) => e.attrs && e.attrs.id === id);
/** Нажатие клавиши на документе: сначала слушатели «захвата», как в браузере. */
function keydown(key, extra = {}) {
    const ev = Object.assign({ type: 'keydown', key, stopped: false, prevented: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; } }, extra);
    const list = DOC_L.filter((x) => x.type === 'keydown');
    for (const x of [...list.filter((l) => l.capture), ...list.filter((l) => !l.capture)]) {
        if (ev.stopped) break;
        x.fn(ev);
    }
    return ev;
}

const fs = await import('node:fs');
const { requiredMarks, askSaveAnyway, loadInpatientRules, titleFieldLabel, TITLE_FIELD_LABEL, TITLE_GROUP_LABEL } = await import('../views/required-marks.js');
const { TITLE_FIELD_KEYS, TITLE_GROUPS, DEFAULT_RULES } = await import('../../shared/inpatient-required.js');
const { STRINGS } = await import('../i18n-strings.js');

function field(key, label, value = '') {
    const lbl = mkEl('label'); lbl._text = label;
    const el = mkEl('input'); el.value = value;
    const box = mkEl('span'); box.appendChild(el);
    return { key, label, el, box, labelEl: lbl, isEmpty: () => !String(el.value || '').trim() };
}
const cls = (el) => String(el.className || '').split(' ');
const lastDialog = () => BODY.children[BODY.children.length - 1];

test('отметки: звезда и скрытое «обязательно», красная рамка, aria-invalid, строка сверху — и живое обновление', () => {
    const a = field('a', 'Рост', '172'); const b = field('b', 'Пульс');
    const m = requiredMarks({ fields: [a, b] });
    assert.deepEqual(m.refresh(), ['b']);
    assert.ok(cls(a.labelEl).includes('rq-req') && cls(b.labelEl).includes('rq-req'));
    assert.ok(textOf(b.labelEl).includes('обязательно'));
    assert.equal(b.el.getAttribute('aria-required'), 'true');
    assert.ok(cls(b.box).includes('rq-empty'));
    assert.equal(b.el.getAttribute('aria-invalid'), 'true');
    assert.ok(!cls(a.box).includes('rq-empty'));
    assert.notEqual(a.el.getAttribute('aria-invalid'), 'true');
    assert.ok(textOf(b.box).includes('Не заполнено'));
    assert.equal(m.summary.hidden, false);
    assert.ok(textOf(m.summary).includes('Пульс') && !textOf(m.summary).includes('Рост'));
    b.el.value = '72'; b.el.dispatchEvent({ type: 'input' });
    assert.ok(!cls(b.box).includes('rq-empty'), 'рамка снимается по мере ввода');
    assert.notEqual(b.el.getAttribute('aria-invalid'), 'true');
    assert.equal(m.summary.hidden, true);
});

test('читалка: пустое поле описано подсказкой «Не заполнено» (aria-describedby), чужое описание не теряется', () => {
    const b = field('b', 'Пульс');
    b.el.setAttribute('aria-describedby', 'hint-1');
    requiredMarks({ fields: [b] });
    const ids = String(b.el.getAttribute('aria-describedby')).split(' ');
    assert.ok(ids.includes('hint-1'), 'прежнее описание поля осталось');
    const msgId = ids.find((x) => x !== 'hint-1');
    const msg = byId(b.box, msgId);
    assert.ok(msg && textOf(msg).includes('Не заполнено'), 'описание ведёт на «Не заполнено» в рамке поля');
    assert.equal(msg.hidden, false);
    b.el.value = '72'; b.el.dispatchEvent({ type: 'change' });
    assert.equal(b.el.getAttribute('aria-describedby'), 'hint-1', 'заполнили — подсказка ушла из описания');
    assert.equal(msg.hidden, true);
});

test('поле без рамки: красная рамка на самом поле, «Не заполнено» — сразу после него', () => {
    const wrap = mkEl('div');
    const dx = mkEl('input'); wrap.appendChild(dx);
    const m = requiredMarks({ fields: [{ key: 'diagnosis', label: 'Диагноз', el: dx, isEmpty: () => !String(dx.value || '').trim() }] });
    assert.ok(cls(dx).includes('rq-empty'));
    assert.equal(dx.getAttribute('aria-invalid'), 'true');
    assert.equal(wrap.children.length, 2);
    assert.ok(textOf(wrap.children[1]).includes('Не заполнено'));
    assert.ok(String(dx.getAttribute('aria-describedby')).includes(wrap.children[1].attrs.id));
    dx.value = 'J18.9'; dx.dispatchEvent({ type: 'input' });
    assert.ok(!cls(dx).includes('rq-empty'));
    assert.equal(m.missing().length, 0);
});

test('радиокнопки группы (watch) тоже пересчитывают отметки', () => {
    const r1 = mkEl('input'); const r2 = mkEl('input'); const grp = mkEl('div'); grp.appendChild(r1); grp.appendChild(r2);
    let picked = '';
    const m = requiredMarks({ fields: [{ key: 'sanitation', label: 'Санитарная обработка', el: r1, box: grp, watch: [r1, r2], isEmpty: () => !picked }] });
    assert.ok(cls(grp).includes('rq-empty'));
    picked = 'done'; r2.dispatchEvent({ type: 'change' });
    assert.ok(!cls(grp).includes('rq-empty'));
    assert.equal(m.summary.hidden, true);
});

test('имя в строке сверху — кнопка: прокручивает к полю и ставит в него курсор', () => {
    const b = field('b', 'Пульс');
    const m = requiredMarks({ fields: [b] });
    const btn = walk(m.summary).find((e) => e.tagName === 'BUTTON' && textOf(e).includes('Пульс'));
    assert.equal(btn.getAttribute('type'), 'button', 'кнопка не отправляет форму');
    btn.click();
    assert.equal(b.box._scrolled, true);
    assert.equal(b.el._focused, true);
    assert.ok(textOf(m.summary).includes('Не заполнено:'));
});

test('focusFirst — к первому пустому полю', () => {
    const a = field('a', 'Рост', '172'); const b = field('b', 'Пульс'); const c = field('c', 'Вес');
    const m = requiredMarks({ fields: [a, b, c] });
    m.focusFirst();
    assert.equal(b.el._focused, true);
    assert.notEqual(c.el._focused, true);
    assert.deepEqual(m.missing(), [{ key: 'b', label: 'Пульс' }, { key: 'c', label: 'Вес' }]);
});

test('setFields меняет список: прежние отметки снимаются', () => {
    const a = field('a', 'Рост'); const b = field('b', 'Пульс');
    const m = requiredMarks({ fields: [a] });
    m.setFields([b]);
    assert.ok(!cls(a.labelEl).includes('rq-req'));
    assert.ok(!cls(a.box).includes('rq-empty'));
    assert.ok(!textOf(a.labelEl).includes('обязательно'), 'скрытое «обязательно» снято с прежней подписи');
    assert.equal(a.el.getAttribute('aria-invalid'), null);
    assert.equal(a.el.getAttribute('aria-required'), null);
    assert.equal(a.el.getAttribute('aria-describedby'), null);
    assert.deepEqual(m.missing().map((x) => x.key), ['b']);
    // Прежнее поле больше не отмечается, даже если по нему печатают.
    a.el.dispatchEvent({ type: 'input' });
    assert.ok(!cls(a.box).includes('rq-empty'));
    // Пустой список — отметок нет совсем.
    m.setFields([]);
    assert.ok(!cls(b.box).includes('rq-empty'));
    assert.equal(m.summary.hidden, true);
});

test('подпись переименовали (textContent) — refresh возвращает скрытое «обязательно»', () => {
    const b = field('b', 'Пульс');
    const m = requiredMarks({ fields: [b] });
    b.labelEl.textContent = 'Пульс на приёме';
    assert.ok(!textOf(b.labelEl).includes('обязательно'));
    m.refresh();
    assert.ok(textOf(b.labelEl).includes('обязательно'));
});

test('«Заполнено не всё»: «Дописать» и «Сохранить как есть»; жёсткий запрет — только «Дописать»', async () => {
    let p = askSaveAnyway({ missing: ['Рост', 'Пульс'] });
    let dlg = lastDialog();
    assert.ok(textOf(dlg).includes('Заполнено не всё') && textOf(dlg).includes('Рост, Пульс'));
    findBtn(dlg, 'Сохранить как есть').click();
    assert.equal(await p, 'save');
    assert.ok(!BODY.children.includes(dlg), 'окно закрылось');
    p = askSaveAnyway({ missing: ['Рост'] });
    findBtn(lastDialog(), 'Дописать').click();
    assert.equal(await p, 'fix');
    p = askSaveAnyway({ missing: ['Приёмный врач'], hard: true });
    dlg = lastDialog();
    assert.equal(findBtn(dlg, 'Сохранить как есть'), undefined, 'жёсткий запрет не предлагает сохранить');
    assert.ok(textOf(dlg).includes('Без этого сохранить нельзя'));
    findBtn(dlg, 'Дописать').click();
    assert.equal(await p, 'fix');
    assert.equal(DOC_L.length, 0, 'слушатели клавиш сняты');
});

test('окно доступно: alertdialog, подписано заголовком, список пустых — в описании; фокус на «Дописать»', async () => {
    const before = mkEl('button'); BODY.appendChild(before); before.focus();
    const p = askSaveAnyway({ missing: ['Рост', 'Пульс'] });
    const dlg = lastDialog();
    const card = walk(dlg).find((e) => e.attrs && e.attrs.role === 'alertdialog');
    assert.ok(card, 'role=alertdialog');
    assert.equal(card.getAttribute('aria-modal'), 'true');
    const title = byId(dlg, card.getAttribute('aria-labelledby'));
    assert.ok(title && textOf(title).includes('Заполнено не всё'), 'подписано заголовком');
    const desc = String(card.getAttribute('aria-describedby')).split(' ').map((id) => byId(dlg, id));
    assert.ok(desc.every(Boolean) && desc.some((d) => textOf(d).includes('Рост, Пульс')), 'список пустых — в описании');
    assert.equal(document.activeElement, findBtn(dlg, 'Дописать'), 'первый фокус — «Дописать»');
    assert.equal(walk(dlg).some((e) => /[\u{1F300}-\u{1FAFF}☀-➿]/u.test(e._text || '')), false, 'без эмодзи');
    findBtn(dlg, 'Сохранить как есть').click();
    await p;
    assert.equal(document.activeElement, before, 'фокус вернулся туда, где был');
    BODY.removeChild(before);
});

test('Escape = «Дописать» и не закрывает окно под ним; Tab не уходит из окна', async () => {
    let underClosed = false;
    // Окно под нашим (inpatientModal) слушает Escape на документе без «захвата».
    const under = (ev) => { if (ev.key === 'Escape') underClosed = true; };
    document.addEventListener('keydown', under);
    const p = askSaveAnyway({ missing: ['Рост'] });
    const dlg = lastDialog();
    const ring = walk(dlg).filter((e) => e.tagName === 'BUTTON');
    const fix = findBtn(dlg, 'Дописать');
    assert.equal(document.activeElement, fix);
    // Tab с последней кнопки — на первую, Shift+Tab с первой — на последнюю.
    const last = ring[ring.length - 1]; const first = ring[0];
    last.focus();
    let ev = keydown('Tab');
    assert.equal(ev.prevented, true);
    assert.equal(document.activeElement, first);
    ev = keydown('Tab', { shiftKey: true });
    assert.equal(document.activeElement, last);
    ev = keydown('Escape');
    assert.equal(await p, 'fix');
    assert.equal(underClosed, false, 'Escape закрыл только наше окно');
    document.removeEventListener('keydown', under);
});

test('окно стоит над окном стационара; одно нажатие — один ответ', async () => {
    const p = askSaveAnyway({ missing: ['Рост'] });
    const dlg = lastDialog();
    assert.ok(Number(dlg.style.zIndex) >= 200);
    const fix = findBtn(dlg, 'Дописать');
    fix.click(); findBtn(dlg, 'Сохранить как есть').click();
    assert.equal(await p, 'fix');
});

test('правила: сбой сервера — сегодняшние; ответ — как прислан', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 501, json: async () => ({ error: { message: 'нет' } }), headers: { getSetCookie: () => [] } });
    assert.deepEqual(await loadInpatientRules(), DEFAULT_RULES);
    globalThis.fetch = async () => { throw new Error('сеть'); };
    assert.deepEqual(await loadInpatientRules(), DEFAULT_RULES);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ data: null }) });
    assert.deepEqual(await loadInpatientRules(), DEFAULT_RULES);
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => [] },
        json: async () => ({ data: { settings: { intake_before_attending: 0, title_required_fields: ['phone'] }, docs: [] } }) });
    const r = await loadInpatientRules();
    assert.equal(r.intakeBeforeAttending, false);
    assert.deepEqual(r.titleFields, ['phone']);
    let asked = null;
    globalThis.fetch = async (url) => { asked = url; return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({ data: { settings: {}, docs: [] } }) }; };
    await loadInpatientRules();
    assert.ok(String(asked).endsWith('/inpatient_settings_get'));
});

test('подписи: у каждого поля листа и каждой группы есть подпись — и перевод на три языка', () => {
    for (const k of TITLE_FIELD_KEYS) assert.ok(TITLE_FIELD_LABEL[k], k);
    for (const g of TITLE_GROUPS) assert.ok(TITLE_GROUP_LABEL[g], g);
    assert.deepEqual(Object.keys(TITLE_FIELD_LABEL).sort(), [...TITLE_FIELD_KEYS].sort(), 'лишних подписей нет');
    for (const ru of [...Object.values(TITLE_FIELD_LABEL), ...Object.values(TITLE_GROUP_LABEL)]) {
        const e = STRINGS[ru];
        assert.ok(e && e.ru && e.uz && e.en, 'нет в словаре: ' + ru);
    }
    assert.equal(titleFieldLabel('height_cm'), 'Рост');
    assert.equal(titleFieldLabel('нет-такого'), 'нет-такого');
});

test('печать отметок не видит', () => {
    const css = fs.readFileSync(new URL('../../../css/admin-views.css', import.meta.url), 'utf8');
    const print = css.slice(css.indexOf('INPATIENT_REQUIRED_V1'));
    assert.match(print, /@media print\s*\{[^}]*\.rq-summary[^}]*display:\s*none/);
    assert.match(print, /@media print[\s\S]*\.rq-req::after[\s\S]*content:\s*none/);
    assert.match(print, /@media print[\s\S]*\.rq-empty[\s\S]*box-shadow:\s*none/);
    // «Не заполнено» — блок, а у блока скрытый атрибут проигрывает: нужно своё правило.
    assert.match(print, /\.rq-msg\[hidden\]\s*\{\s*display:\s*none/);
    // Цвета — только переменные палитры, без своих.
    const block = print.slice(0, print.indexOf('/* end INPATIENT_REQUIRED_V1'));
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'свои цвета в блоке');
});

test('модуль не тянет экранов (без колец) и общих модулей со штампом ?v=', () => {
    const src = fs.readFileSync(new URL('../views/required-marks.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+'\.\/[^']+'/, 'импорт соседнего экрана');
    assert.doesNotMatch(src, /from\s+'[^']*\?v=/, 'штамп ?v=');
    assert.doesNotMatch(src, /\bconfirm\s*\(/, 'никаких window.confirm');
});
