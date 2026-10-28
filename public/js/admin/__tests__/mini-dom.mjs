// DOC_RICH_FORMAT_V1 (T2) — МАЛЕНЬКИЙ DOM С РАЗБОРОМ РАЗМЕТКИ.
//
// Стенд кабинета (cabinet-harness.mjs) держит innerHTML строкой: детей у поля
// там нет, и перенести узлы списка или строки таблицы на другую страницу нечем.
// Разбивке по страницам (views/blank-split.js) нужны настоящие узлы: дети,
// соседи, текстовые узлы, cloneNode, splitText. Здесь — ровно это и не больше:
// разбор разметки бланка (теги, атрибуты в кавычках, <br>, сущности), сборка
// обратно (innerHTML/outerHTML, как у браузера), простые селекторы
// (tag, .class, [attr], [attr="v"], их сочетания и списки через запятую).
// Вёрстки нет — высоту меряет проверка сама (fits), как и в a4-sheets.test.mjs.

const VOID = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK', 'COL', 'WBR']);
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const decode = (s) => String(s).replace(/&(lt|gt|amp|quot|#39|apos|nbsp);/g, (_, k) => ENT[k]);
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

class MNode {
    constructor(doc) { this.ownerDocument = doc; this.parentNode = null; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p._kids[p._kids.indexOf(this) + 1] || null; }
    get previousSibling() { const p = this.parentNode; if (!p) return null; return p._kids[p._kids.indexOf(this) - 1] || null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

export class MText extends MNode {
    constructor(doc, data) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.data = String(data); }
    get nodeValue() { return this.data; }
    set nodeValue(v) { this.data = String(v); }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    get length() { return this.data.length; }
    splitText(off) {
        const rest = new MText(this.ownerDocument, this.data.slice(off));
        this.data = this.data.slice(0, off);
        if (this.parentNode) this.parentNode.insertBefore(rest, this.nextSibling);
        return rest;
    }
    appendData(s) { this.data += String(s); }
    cloneNode() { return new MText(this.ownerDocument, this.data); }
}

class MComment extends MNode {
    constructor(doc, data) { super(doc); this.nodeType = 8; this.nodeName = '#comment'; this.data = String(data); }
    get textContent() { return ''; }
    cloneNode() { return new MComment(this.ownerDocument, this.data); }
}

export class MElement extends MNode {
    constructor(doc, tag) {
        super(doc);
        this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName;
        this._kids = []; this._attrs = new Map(); this._l = {};
        this.style = {};
    }
    get childNodes() { return this._kids.slice(); }
    get children() { return this._kids.filter((k) => k.nodeType === 1); }
    get firstChild() { return this._kids[0] || null; }
    get lastChild() { return this._kids[this._kids.length - 1] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
    getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
    setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); }
    hasAttribute(k) { return this._attrs.has(k); }
    removeAttribute(k) { this._attrs.delete(k); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get classList() {
        const self = this;
        const list = () => self.className.split(/\s+/).filter(Boolean);
        return {
            contains: (c) => list().includes(c),
            add: (...cs) => { self.className = [...new Set([...list(), ...cs])].join(' '); },
            remove: (...cs) => { self.className = list().filter((x) => !cs.includes(x)).join(' '); },
        };
    }
    appendChild(n) { return this.insertBefore(n, null); }
    insertBefore(n, ref) {
        if (n === ref) return n;
        if (n.parentNode) n.parentNode.removeChild(n);
        const i = ref ? this._kids.indexOf(ref) : -1;
        if (ref && i < 0) throw new Error('insertBefore: ref is not a child');
        if (i < 0) this._kids.push(n); else this._kids.splice(i, 0, n);
        n.parentNode = this;
        return n;
    }
    removeChild(n) {
        const i = this._kids.indexOf(n);
        if (i < 0) throw new Error('removeChild: not a child');
        this._kids.splice(i, 1); n.parentNode = null;
        return n;
    }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    cloneNode(deep) {
        const c = new MElement(this.ownerDocument, this.tagName);
        for (const [k, v] of this._attrs) c._attrs.set(k, v);
        if (deep) for (const k of this._kids) c.appendChild(k.cloneNode(true));
        return c;
    }
    get textContent() { return this._kids.map((k) => k.textContent).join(''); }
    set textContent(v) { this._clear(); if (v) this.appendChild(new MText(this.ownerDocument, v)); }
    // Без вёрстки: <br> — перевод строки, как у innerText браузера.
    get innerText() { return this._kids.map((k) => (k.nodeType === 1 ? (k.tagName === 'BR' ? '\n' : k.innerText) : k.textContent)).join(''); }
    set innerText(v) {
        this._clear();
        String(v).split('\n').forEach((line, i) => {
            if (i) this.appendChild(new MElement(this.ownerDocument, 'br'));
            if (line) this.appendChild(new MText(this.ownerDocument, line));
        });
    }
    get innerHTML() { return this._kids.map(serialize).join(''); }
    set innerHTML(html) { this._clear(); parseInto(this, String(html)); }
    get outerHTML() { return serialize(this); }
    _clear() { for (const k of this._kids) k.parentNode = null; this._kids = []; }
    matches(sel) { return String(sel).split(',').some((s) => matchOne(this, s.trim())); }
    querySelectorAll(sel) { const out = []; const walk = (e) => { for (const c of e._kids) { if (c.nodeType !== 1) continue; if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { for (let e = this; e && e.nodeType === 1; e = e.parentNode) if (e.matches(sel)) return e; return null; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    dispatch(t) { for (const fn of this._l[t] || []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
    getBoundingClientRect() {
        const h = this.ownerDocument && this.ownerDocument.heightOf ? this.ownerDocument.heightOf(this) : 0;
        return { top: 0, left: 0, right: 0, width: 0, height: h, bottom: h };
    }
}

function matchOne(el, sel) {
    const m = /^([a-z][a-z0-9]*|\*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel);
    if (!m) throw new Error('mini-dom: selector not supported: ' + sel);
    if (m[1] && m[1] !== '*' && el.tagName !== m[1].toUpperCase()) return false;
    for (const c of m[2].match(/\.[\w-]+/g) || []) if (!el.classList.contains(c.slice(1))) return false;
    for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
        const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
        if (!am || !el.hasAttribute(am[1])) return false;
        if (am[2] !== undefined && el.getAttribute(am[1]) !== am[2]) return false;
    }
    return true;
}

/**
 * Атрибуты, которых проверка «не видит» в innerHTML/outerHTML: служебные метки,
 * живущие только между раскладками (метка пары data-split-id — ревью T3).
 * getAttribute их по-прежнему читает; что в хранение они не идут, проверяется
 * отдельно (очистка, mergedFieldClone).
 */
export const HIDE_ATTRS = new Set();

function serialize(n) {
    if (n.nodeType === 3) return escText(n.data);
    if (n.nodeType === 8) return '<!--' + n.data + '-->';
    const tag = n.tagName.toLowerCase();
    let attrs = '';
    for (const [k, v] of n._attrs) if (!HIDE_ATTRS.has(k)) attrs += ' ' + k + '="' + escAttr(v) + '"';
    if (VOID.has(n.tagName)) return '<' + tag + attrs + '>';
    return '<' + tag + attrs + '>' + n._kids.map(serialize).join('') + '</' + tag + '>';
}

function parseInto(root, html) {
    const doc = root.ownerDocument;
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const re = /<!--([\s\S]*?)-->|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
    let i = 0;
    let m;
    while ((m = re.exec(html))) {
        if (m.index > i) top().appendChild(new MText(doc, decode(html.slice(i, m.index))));
        i = re.lastIndex;
        if (m[1] !== undefined) { top().appendChild(new MComment(doc, m[1])); continue; }
        if (m[2]) {
            const t = m[2].toUpperCase();
            for (let k = stack.length - 1; k > 0; k -= 1) if (stack[k].tagName === t) { stack.length = k; break; }
            continue;
        }
        const el = new MElement(doc, m[3]);
        const ar = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let a;
        while ((a = ar.exec(m[4] || ''))) el.setAttribute(a[1], decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : (a[4] || '')));
        top().appendChild(el);
        if (!VOID.has(el.tagName)) stack.push(el);
    }
    if (i < html.length) top().appendChild(new MText(doc, decode(html.slice(i))));
}

/**
 * Документ стенда. heightOf(el) — «вёрстка» проверки: по умолчанию высоты нет.
 * Выделение — одно, как у браузера: getSelection().addRange кладёт курсор.
 */
export function miniDocument() {
    const doc = {
        heightOf: null,
        createElement: (t) => new MElement(doc, t),
        createTextNode: (t) => new MText(doc, t),
        createRange() {
            const r = { startContainer: null, startOffset: 0, collapsed: true };
            r.setStart = (n, o) => { r.startContainer = n; r.startOffset = o; };
            r.collapse = () => {};
            r.selectNodeContents = (n) => { r.startContainer = n; r.startOffset = 0; };
            return r;
        },
        _range: null,
        getSelection() {
            return {
                get rangeCount() { return doc._range ? 1 : 0; },
                get anchorNode() { return doc._range ? doc._range.startContainer : null; },
                get anchorOffset() { return doc._range ? doc._range.startOffset : 0; },
                removeAllRanges() { doc._range = null; },
                addRange(r) { doc._range = r; },
            };
        },
    };
    doc.documentElement = new MElement(doc, 'html');
    doc.body = new MElement(doc, 'body');
    doc.documentElement.appendChild(doc.body);
    doc.querySelector = (s) => doc.documentElement.querySelector(s);
    doc.querySelectorAll = (s) => doc.documentElement.querySelectorAll(s);
    return doc;
}

/** Элемент из разметки: el(doc, '<div data-field="x">…</div>'). */
export function el(doc, html) {
    const box = new MElement(doc, 'div');
    box.innerHTML = html;
    const e = box.firstChild;
    box.removeChild(e);
    return e;
}
