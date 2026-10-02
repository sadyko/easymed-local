// CABINET_FIX_V1_R1 — маленький DOM для поведенческих проверок кабинета врача.
//
// Кабинет целиком (iframe бланка, печать) без браузера не поднимается, но
// НАСТОЯЩАЯ форма под бланком (soapForm) — это h()-элементы, и её достаточно
// для сбора и раскладки полей: collectFields / applyFields / разделы. Стенд
// понимает простые селекторы: tag, .class, [attr], [attr="v"] и их сочетания.
export class El {
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
        if (this.tagName === 'IFRAME') this.contentDocument = fakeDocument();   // бланк кабинета пишет в iframe
        // CABINET_FIX_V1_R2 — как в браузере: у списка без выбора значение — первый пункт.
        if (this.tagName === 'SELECT') {
            let v = '';
            Object.defineProperty(this, 'value', { configurable: true, get() { const o = this.children.find((c) => c.tagName === 'OPTION'); return v !== '' || !o ? v : String(o.value || o.getAttribute('value') || ''); }, set(x) { v = String(x == null ? '' : x); } });
        }
    }
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); this.attrs.class = String(v); }
    get className() { return this.attrs.class || ''; }
    setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
    removeEventListener() {}
    // CABINET_FIX_V1_R4 — как в браузере: после того как обработчик вернул
    // управление (на первом await), event.currentTarget — null.
    dispatch(type, ev = {}) {
        for (const fn of this._l[type] || []) {
            const e = { currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
            const r = fn(e);
            e.currentTarget = null;
            if (r && typeof r.then === 'function') this._pending = r;
        }
    }
    appendChild(c) { if (c && typeof c === 'object') { if (c.parentElement) c.parentElement.removeChild(c); this.children.push(c); c.parentElement = this; } return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) return this.appendChild(c); this.children.splice(i, 0, c); c.parentElement = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); c.parentElement = null; return c; }
    remove() { if (this.parentElement) this.parentElement.removeChild(this); }
    get firstChild() { return this.children[0] || null; }
    get isConnected() { return true; }
    get textContent() { return this._html != null ? this._html.replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '') : this._text + this.children.map((c) => c.textContent || '').join(''); }
    set textContent(v) { this._text = String(v); this._html = null; this.children = []; }
    get innerHTML() { return this._html != null ? this._html : this._text; }
    set innerHTML(v) { this._html = String(v); this.children = []; }
    get innerText() { return this.textContent; }
    focus() {} blur() {} scrollIntoView() {}
    matches(sel) {
        const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(String(sel).trim());
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
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}
class Txt extends El { constructor(t) { super('#text'); this._text = String(t); } }

// Документ iframe бланка: разметку бланка стенд не разбирает (её проверяют
// тесты doc-variants), но всё, что кабинет делает с документом, должно не падать.
// CABINET_FIX_V1_R4 — поля бланка ([data-field]) стенд всё же достаёт из
// записанной разметки: так проверяется, редактируются ли они (запор на время
// загрузки строки). Остальная разметка не разбирается.
function fakeDocument() {
    const root = new El('html');
    const head = new El('head');
    const body = new El('body');
    root.appendChild(head); root.appendChild(body);
    return {
        documentElement: root, head, body, html: '',
        open() { this.html = ''; head.children = []; body.children = []; }, write(s) { this.html += String(s); },
        close() {
            const re = /<([a-z][a-z0-9]*)\b([^<>]*?)\sdata-field="([^"]+)"([^<>]*)>/gi;
            let m;
            while ((m = re.exec(this.html))) { const el = new El(m[1]); el.setAttribute('data-field', m[3]); body.appendChild(el); }
        },
        createElement: (t) => new El(t), createTextNode: (t) => new Txt(t),
        querySelector: (sel) => root.querySelector(sel), querySelectorAll: (sel) => root.querySelectorAll(sel),
        addEventListener() {}, removeEventListener() {}, getSelection: () => null, createRange: () => ({ selectNodeContents() {}, collapse() {} }),
        execCommand() { return false; },
    };
}

export const TOASTS = [];
export const CONFIRMS = [];
export let confirmAnswer = true;
export function answerConfirm(v) { confirmAnswer = v; }

export function installFakeDom() {
    globalThis.Node = El;
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
    const toastEl = new El('div');
    Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
    globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
    globalThis.document = {
        createElement: (t) => new El(t), createTextNode: (t) => new Txt(t), createElementNS: (_n, t) => new El(t),
        head: new El('head'), body: new El('body'), documentElement: new El('html'),
        addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? toastEl : null), querySelector: () => null,
    };
    globalThis.confirm = (msg) => { CONFIRMS.push(String(msg)); return confirmAnswer; };
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };   // CABINET_FIX_V1_R2 — лист приёма
    globalThis.requestAnimationFrame = (fn) => fn();
}
