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

// ─── INPATIENT_REQUIRED_V1 (ревью) ───────────────────────────────────────────
/** Подмена, как её делает ui-select.js кадром позже: обёртка .uisel встаёт на место
 *  <select>, в ней видимая кнопка .uisel-field, а родной список уезжает внутрь,
 *  спрятанный (.uisel-native, tabIndex -1, data-ui-select="on"). */
function swapSelect(sel) {
    const wrap = mkEl('div'); wrap.className = 'uisel';
    const btn = mkEl('button'); btn.className = 'uisel-field';
    btn.setAttribute('type', 'button'); btn.setAttribute('aria-haspopup', 'listbox');
    wrap.appendChild(btn);
    const p = sel.parentNode;
    if (p) { p.children.splice(p.children.indexOf(sel), 0, wrap); wrap.parentNode = p; p.removeChild(sel); }
    wrap.appendChild(sel);
    sel.dataset.uiSelect = 'on'; sel.setAttribute('data-ui-select', 'on');
    sel.className = (sel.className + ' uisel-native').trim(); sel.tabIndex = -1;
    return btn;
}
const msgsIn = (n) => walk(n).filter((e) => cls(e).includes('rq-msg'));
const srsIn = (n) => walk(n).filter((e) => cls(e).includes('rq-sr'));
const viewsCss = () => fs.readFileSync(new URL('../../../css/admin-views.css', import.meta.url), 'utf8');

// INPATIENT_REQUIRED_V1 (ревью) — aria-required у кнопки (role=button) ARIA не разрешает: обязательность
// остаётся на родном <select>, а aria-invalid и aria-describedby — и на видимой кнопке.
test('ревью: список программы вместо <select> — фокус, aria-invalid и aria-describedby на видимой кнопке, aria-required — только у родного списка', () => {
    const lbl = mkEl('label'); lbl._text = 'Приёмный врач';
    const box = mkEl('div'); const sel = mkEl('select'); box.appendChild(sel);
    const btn = swapSelect(sel);
    btn.setAttribute('aria-describedby', 'own-hint');
    const m = requiredMarks({ fields: [{ key: 'doc', label: 'Приёмный врач', el: sel, box, labelEl: lbl, isEmpty: () => !sel.value }] });
    assert.equal(btn.getAttribute('aria-required'), null, 'aria-required на кнопке ARIA не разрешает');
    assert.equal(sel.getAttribute('aria-required'), 'true', 'обязательность — у родного списка');
    assert.equal(btn.getAttribute('aria-invalid'), 'true');
    const ids = String(btn.getAttribute('aria-describedby')).split(' ');
    assert.ok(ids.includes('own-hint'), 'чужое описание кнопки осталось');
    const msg = byId(box, ids.find((x) => x !== 'own-hint'));
    assert.ok(msg && textOf(msg).includes('Не заполнено'));
    // Переход из строки сверху и focusFirst — на видимую кнопку, не на спрятанный список.
    walk(m.summary).find((e) => e.tagName === 'BUTTON' && textOf(e).includes('Приёмный врач')).click();
    assert.equal(document.activeElement, btn);
    assert.notEqual(sel._focused, true);
    document.activeElement = null;
    assert.equal(m.focusFirst(), true);
    assert.equal(document.activeElement, btn);
    // Выбор в списке программы — change на родном поле.
    sel.value = '7'; sel.dispatchEvent({ type: 'change' });
    assert.equal(btn.getAttribute('aria-invalid'), null);
    assert.equal(btn.getAttribute('aria-describedby'), 'own-hint');
    m.setFields([]);
    assert.equal(sel.getAttribute('aria-required'), null, 'своё aria-required снято');
    assert.equal(btn.getAttribute('aria-required'), null);
    assert.equal(btn.getAttribute('aria-describedby'), 'own-hint');
});

test('ревью: aria-required, поставленное экраном на кнопку, отметки не снимают', () => {
    const box = mkEl('div'); const sel = mkEl('select'); box.appendChild(sel);
    const btn = swapSelect(sel);
    btn.setAttribute('aria-required', 'true');
    const m = requiredMarks({ fields: [{ key: 'doc', label: 'Врач', el: sel, box, isEmpty: () => !sel.value }] });
    m.setFields([]);
    assert.equal(btn.getAttribute('aria-required'), 'true');
});

test('ревью: подмена списка кадром позже — кнопку находят в момент действия, пересчёт через два кадра переносит aria-*', () => {
    const rafWas = globalThis.requestAnimationFrame;
    const q = [];
    globalThis.requestAnimationFrame = (fn) => { q.push(fn); return q.length; };
    try {
        const form = mkEl('div'); const sel = mkEl('select'); form.appendChild(sel);
        const m = requiredMarks({ fields: [{ key: 'doc', label: 'Врач', el: sel, isEmpty: () => !sel.value }] });
        assert.ok(textOf(form.children[1]).includes('Не заполнено'), '«Не заполнено» — сразу за списком');
        const btn = swapSelect(sel);
        assert.equal(form.children[0], btn.parentNode);
        assert.ok(textOf(form.children[1]).includes('Не заполнено'), 'после подмены — за обёрткой');
        assert.equal(btn.parentNode.children.length, 2, 'внутри обёртки только кнопка и родной список');
        m.focusFirst();
        assert.equal(document.activeElement, btn, 'фокус — на кнопку, найденную в момент действия');
        while (q.length) q.shift()();
        assert.equal(btn.getAttribute('aria-required'), null, 'aria-required на кнопке ARIA не разрешает');
        assert.equal(sel.getAttribute('aria-required'), 'true');
        assert.equal(btn.getAttribute('aria-invalid'), 'true');
        assert.ok(String(btn.getAttribute('aria-describedby')).includes(form.children[1].attrs.id));
        m.setFields([]);
    } finally { globalThis.requestAnimationFrame = rafWas; }
});

test('ревью: список программы без рамки опустел после подмены — «Не заполнено» за обёрткой, красную рамку несёт кнопка (CSS)', () => {
    const form = mkEl('div'); const sel = mkEl('select'); form.appendChild(sel); sel.value = '3';
    const btn = swapSelect(sel);
    const m = requiredMarks({ fields: [{ key: 'doc', label: 'Врач', el: sel, isEmpty: () => !sel.value }] });
    assert.equal(msgsIn(form).length, 0);
    sel.value = ''; sel.dispatchEvent({ type: 'change' });
    assert.equal(btn.parentNode.children.length, 2, 'внутрь обёртки ничего не легло');
    assert.equal(form.children.length, 2);
    assert.ok(textOf(form.children[1]).includes('Не заполнено'));
    assert.ok(cls(sel).includes('rq-empty'));
    const css = viewsCss();
    const block = css.slice(css.indexOf('INPATIENT_REQUIRED_V1'), css.indexOf('/* end INPATIENT_REQUIRED_V1'));
    assert.match(block, /\.uisel:has\(>\s*select\.rq-empty\)\s*>\s*\.uisel-field\s*\{[^}]*box-shadow/);
    assert.match(block, /@media print[\s\S]*\.uisel:has\(>\s*select\.rq-empty\)\s*>\s*\.uisel-field[\s\S]*box-shadow:\s*none/);
    m.setFields([]);
});

test('ревью: редактор contenteditable без рамки — «Не заполнено» после него, текст редактора цел', () => {
    const kinds = [(e) => { e.isContentEditable = true; }, (e) => { e.setAttribute('contenteditable', 'true'); }];
    for (const mark of kinds) {
        const wrap = mkEl('div'); const ed = mkEl('div'); mark(ed); wrap.appendChild(ed);
        const m = requiredMarks({ fields: [{ key: 'complaints', label: 'Жалобы', el: ed, isEmpty: () => !String(ed.textContent).trim() }] });
        assert.equal(ed.children.length, 0, 'внутри редактора нет «Не заполнено»');
        assert.equal(wrap.children.length, 2);
        assert.ok(textOf(wrap.children[1]).includes('Не заполнено'));
        assert.ok(cls(ed).includes('rq-empty'));
        assert.equal(m.missing().length, 1);
        ed._text = 'текст'; ed.dispatchEvent({ type: 'input' });
        assert.equal(ed.textContent, 'текст', 'текст редактора не испорчен');
        assert.equal(wrap.children[1].hidden, true);
        assert.equal(m.missing().length, 0);
        m.setFields([]);
    }
});

test('ревью: окно «Заполнено не всё» не печатается (no-print)', async () => {
    const p = askSaveAnyway({ missing: ['Рост'] });
    const dlg = lastDialog();
    assert.ok(cls(dlg).includes('modal') && cls(dlg).includes('no-print'));
    assert.match(viewsCss(), /@media print\s*\{\s*\.no-print\s*\{\s*display:\s*none\s*!important/);
    findBtn(dlg, 'Дописать').click();
    await p;
});

/** Окно формы под вопросом: крестик, поля (спрятанный родной список, неактивное поле,
 *  доступное поле) и кнопка отправки — как inpatientModal. */
function formModal() {
    const overlay = mkEl('div'); overlay.className = 'modal';
    const card = mkEl('div'); card.className = 'modal-card modal-compact';
    const head = mkEl('header'); const close = mkEl('button'); close.className = 'modal-close'; head.appendChild(close);
    const body = mkEl('div'); body.className = 'modal-body';
    const native = mkEl('select'); native.tabIndex = -1;
    const off = mkEl('input'); off.disabled = true;
    const first = mkEl('input');
    body.appendChild(native); body.appendChild(off); body.appendChild(first);
    const foot = mkEl('footer'); const submit = mkEl('button'); submit.className = 'btn btn-primary'; foot.appendChild(submit);
    card.appendChild(head); card.appendChild(body); card.appendChild(foot); overlay.appendChild(card);
    BODY.appendChild(overlay);
    return { overlay, card, close, first, submit };
}

test('ревью: фокус не возвращается на неактивную или убранную кнопку и не остаётся на body — первое доступное поле окна', async () => {
    const w = formModal();
    // inpatientModal гасит «Положить» на время сохранения.
    w.submit.focus(); w.submit.disabled = true;
    let p = askSaveAnyway({ missing: ['Рост'] });
    findBtn(lastDialog(), 'Сохранить как есть').click();
    assert.equal(await p, 'save');
    assert.equal(document.activeElement, w.first, 'неактивная кнопка — фокус на первое доступное поле окна');
    // Кнопку убрали из окна, пока висел вопрос.
    w.submit.disabled = false; w.submit.focus();
    p = askSaveAnyway({ missing: ['Рост'] });
    w.submit.parentNode.removeChild(w.submit);
    Object.defineProperty(w.submit, 'isConnected', { get: () => false, configurable: true });
    findBtn(lastDialog(), 'Дописать').click();
    assert.equal(await p, 'fix');
    assert.equal(document.activeElement, w.first, 'убранная кнопка — фокус на первое доступное поле окна');
    // Фокус был на body, а окно открыто — фокус уходит в окно, не на body.
    document.activeElement = BODY;
    p = askSaveAnyway({ missing: ['Рост'] });
    findBtn(lastDialog(), 'Дописать').click();
    await p;
    assert.equal(document.activeElement, w.first, 'окно открыто — фокус в окне');
    BODY.removeChild(w.overlay);
});

test('ревью: setFields с новыми записями тех же полей не множит «Не заполнено»; общая подпись — одно «обязательно»; снятие убирает подсказки из DOM', () => {
    const lbl = mkEl('label'); lbl._text = 'АД';
    const box = mkEl('span'); const sys = mkEl('input'); const dia = mkEl('input'); box.appendChild(sys); box.appendChild(dia);
    const entries = () => [
        { key: 'bp_sys', label: 'АД верхнее', el: sys, box, labelEl: lbl, isEmpty: () => !sys.value },
        { key: 'bp_dia', label: 'АД нижнее', el: dia, box, labelEl: lbl, isEmpty: () => !dia.value },
    ];
    const m = requiredMarks({ fields: entries() });
    m.setFields(entries());
    m.setFields(entries());
    assert.equal(msgsIn(box).length, 1, 'одна подсказка на рамку');
    assert.equal(srsIn(lbl).length, 1, 'одно скрытое «обязательно» на подпись');
    // Одно из двух заполнено — рамка всё ещё красная, подсказка видна, описание — только у пустого.
    sys.value = '120'; sys.dispatchEvent({ type: 'input' });
    assert.ok(cls(box).includes('rq-empty'));
    assert.equal(msgsIn(box)[0].hidden, false);
    assert.equal(sys.getAttribute('aria-describedby'), null);
    assert.equal(sys.getAttribute('aria-invalid'), null);
    assert.ok(String(dia.getAttribute('aria-describedby')).includes(msgsIn(box)[0].attrs.id));
    assert.deepEqual(m.missing().map((x) => x.key), ['bp_dia']);
    m.setFields([]);
    assert.equal(msgsIn(box).length, 0, '«Не заполнено» убрано из DOM');
    assert.equal(srsIn(lbl).length, 0);
    assert.equal(dia.getAttribute('aria-describedby'), null);
    assert.ok(!cls(lbl).includes('rq-req'));
});

// INPATIENT_REQUIRED_V1 (ревью) — жёсткий отказ называет СВОЮ причину: лечащий врач обязателен
// всегда (не «так настроено в клинике»), и действие окна — «Назначить», а не «сохранить».
test('ревью: «Заполнено не всё» с причиной — своя строка вместо «так настроено в клинике»; без причины — прежняя', async () => {
    let p = askSaveAnyway({ missing: ['Лечащий врач'], hard: true, reason: 'Без лечащего врача назначить нельзя — выберите врача.' });
    let dlg = lastDialog();
    assert.ok(textOf(dlg).includes('Без лечащего врача назначить нельзя — выберите врача.'));
    assert.ok(!textOf(dlg).includes('так настроено в клинике'), 'причина клиники вместо своей');
    const card = walk(dlg).find((e) => e.attrs && e.attrs.role === 'alertdialog');
    const desc = String(card.getAttribute('aria-describedby')).split(' ').map((id) => byId(dlg, id));
    assert.ok(desc.every(Boolean) && desc.some((d) => textOf(d).includes('Без лечащего врача')), 'причина — в описании окна');
    assert.equal(findBtn(dlg, 'Сохранить как есть'), undefined);
    findBtn(dlg, 'Дописать').click();
    assert.equal(await p, 'fix');
    p = askSaveAnyway({ missing: ['Приёмный врач'], hard: true });
    dlg = lastDialog();
    assert.ok(textOf(dlg).includes('Без этого сохранить нельзя — так настроено в клинике.'));
    findBtn(dlg, 'Дописать').click();
    await p;
    const e = STRINGS['Без лечащего врача назначить нельзя — выберите врача.'];
    assert.ok(e && e.ru && e.uz && e.en, 'причины нет в словаре');
    assert.doesNotMatch(e.uz + e.en, /[А-Яа-яЁё]/);
});

// INPATIENT_REQUIRED_V1 (ревью) — aria-required ARIA разрешает только ролям, у которых
// «обязательно» что-то значит (textbox, combobox, checkbox…) и родным полям ввода.
// Редактор с contenteditable без роли и радиокнопка его не получают — им остаются
// aria-invalid, aria-describedby, «Не заполнено», скрытое «обязательно» у подписи и строка сверху.
test('ревью: aria-required — только полю с разрешённой ролью; contenteditable без роли и радиокнопка — без него, остальные отметки на месте', () => {
    const kinds = [(e) => { e.isContentEditable = true; }, (e) => { e.setAttribute('contenteditable', 'true'); }, (e) => { e.setAttribute('contenteditable', ''); }];
    for (const mark of kinds) {
        const wrap = mkEl('div'); const ed = mkEl('div'); mark(ed); wrap.appendChild(ed);
        const lbl = mkEl('span'); lbl._text = 'Жалобы';
        const m = requiredMarks({ fields: [{ key: 'complaints', label: 'Жалобы', el: ed, labelEl: lbl, isEmpty: () => !String(ed.textContent).trim() }] });
        assert.equal(ed.getAttribute('aria-required'), null, 'aria-required на contenteditable без роли');
        assert.equal(ed.getAttribute('aria-invalid'), 'true');
        const msgId = wrap.children[1].getAttribute('id');
        assert.ok(msgId && String(ed.getAttribute('aria-describedby')).split(' ').includes(msgId), 'описание «Не заполнено» потерялось');
        assert.ok(textOf(lbl).includes('обязательно') && cls(lbl).includes('rq-req'), 'скрытое «обязательно» у подписи');
        assert.equal(m.summary.hidden, false);
        assert.ok(textOf(m.summary).includes('Жалобы'));
        ed._text = 'текст'; ed.dispatchEvent({ type: 'input' });
        assert.notEqual(ed.getAttribute('aria-invalid'), 'true');
        assert.equal(ed.getAttribute('aria-required'), null);
        m.setFields([]);
    }
    // Редактор с ролью textbox — aria-required разрешён и ставится; снятие — снимает своё.
    const tb = mkEl('div'); tb.setAttribute('contenteditable', 'true'); tb.setAttribute('role', 'textbox');
    const wrapTb = mkEl('div'); wrapTb.appendChild(tb);
    const m2 = requiredMarks({ fields: [{ key: 'plan', label: 'План', el: tb, isEmpty: () => true }] });
    assert.equal(tb.getAttribute('aria-required'), 'true');
    m2.setFields([]);
    assert.equal(tb.getAttribute('aria-required'), null);
    // Радиокнопка (role=radio) aria-required не берёт; aria-invalid — да. Родные поля — как раньше.
    const r1 = mkEl('input'); r1.setAttribute('type', 'radio'); const grp = mkEl('div'); grp.appendChild(r1);
    const txt = mkEl('input'); txt.setAttribute('type', 'number'); const boxN = mkEl('span'); boxN.appendChild(txt);
    const chk = mkEl('input'); chk.setAttribute('type', 'checkbox'); const boxC = mkEl('span'); boxC.appendChild(chk);
    const area = mkEl('textarea'); const boxA = mkEl('span'); boxA.appendChild(area);
    const m3 = requiredMarks({ fields: [
        { key: 'sanitation', label: 'Санитарная обработка', el: r1, box: grp, watch: [r1], isEmpty: () => true },
        { key: 'pulse_bpm', label: 'Пульс', el: txt, box: boxN, isEmpty: () => true },
        { key: 'consent_signed', label: 'Информированное согласие', el: chk, box: boxC, isEmpty: () => true },
        { key: 'note', label: 'Примечание', el: area, box: boxA, isEmpty: () => true },
    ] });
    assert.equal(r1.getAttribute('aria-required'), null, 'aria-required на радиокнопке');
    assert.equal(r1.getAttribute('aria-invalid'), 'true');
    for (const el of [txt, chk, area]) assert.equal(el.getAttribute('aria-required'), 'true', el.tagName);
    m3.setFields([]);
    for (const el of [txt, chk, area]) assert.equal(el.getAttribute('aria-required'), null, el.tagName);
});
