// CRM_DEDUP_SEARCH_TASKS_V1 — поддельный DOM и поддельный сервер для тестов
// доски заявок (дубли, поиск, задачи). Тот же приём, что в crm-card.test.mjs:
// доска монтируется целиком, а проверяется то, что отрисовалось и что ушло на
// сервер. Это НЕ тестовый файл (нет «.test.» в имени) — его импортируют.

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c.parentNode = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); if (c && typeof c === 'object') c.parentNode = this; return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c && c.parentNode === this) c.parentNode = null; return c; }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); p.children.splice(i, 1, n); n.parentNode = p; this.parentNode = null; }
  get firstChild() { return this.children[0] || null; } replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'type') this.type = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); } removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} scrollTo() {} scrollIntoView() {} select() {} closest() { return null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
  querySelector(sel) {
    const m = /^\[([^\]=]+)\]$/.exec(String(sel));
    if (!m) return null;
    const stack = [...this.children];
    while (stack.length) { const n = stack.shift(); if (n && n.attrs && m[1] in n.attrs) return n; if (n && n.children) stack.push(...n.children); }
    return null;
  }
  querySelectorAll() { return []; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
export function mk(t) {
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
export const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
};
const store = new Map();
const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage = ls;
ls.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида
globalThis.window = { location: { hostname: 'localhost' }, localStorage: ls, addEventListener() {}, confirm: () => false, easymed: { state: { user: null } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

export const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
export const textOf = (el) => walk(el).map((n) => n._t || '').join('');
export const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
export const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
export const byAttr = (root, a) => walk(root).filter((n) => n.attrs && a in n.attrs);
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
export const button = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n)));

// --- поддельный сервер -----------------------------------------------------
// S — изменяемое состояние стенда; CALLS — журнал /api/db, RPC — журнал RPC.
export const S = { leads: [], dups: [], search: [], tasks: [], staff: [], nextTaskId: 100, inserted: null, failInsertOnce: false };
export const CALLS = [];
export const RPC = [];
const jsonOk = (data, count) => ({ ok: true, json: async () => ({ data, count }) });

function applyFilters(rows, filters) {
  return rows.filter((r) => (filters || []).every((f) => {
    if (!f.col) return true;
    const v = r[f.col];
    switch (f.op) {
      case 'eq': return String(v) === String(f.val);
      case 'is': return f.val === null ? v == null : v === f.val;
      case 'lte': return v != null && String(v) <= String(f.val);
      case 'in': return (f.val || []).map(String).includes(String(v));
      default: return true;
    }
  }));
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    if (name === 'crm_config_get') return jsonOk(null);
    if (name === 'crm_leads_by_phone') return jsonOk(S.dups);
    if (name === 'crm_search') return jsonOk(typeof S.search === 'function' ? S.search(body) : S.search);
    if (name === 'crm_lead_calls') return jsonOk([]);
    return jsonOk({});
  }
  if (u.startsWith('/api/db')) {
    CALLS.push(body);
    if (body.table === 'crm_requests' && body.op === 'select') {
      if (body.single) return jsonOk(applyFilters(S.leads, body.filters)[0] || null);
      return jsonOk(S.leads);
    }
    if (body.table === 'crm_requests' && body.op === 'insert') {
      if (S.failInsertOnce) { S.failInsertOnce = false; return { ok: false, json: async () => ({ error: { message: 'сбой вставки' } }) }; }
      S.inserted = { id: 900, ...body.values };
      return jsonOk(S.inserted);
    }
    if (body.table === 'crm_tasks') {
      if (body.op === 'select') {
        const rows = applyFilters(S.tasks, body.filters);
        if (body.count) return jsonOk(null, rows.length);
        return jsonOk(rows);
      }
      if (body.op === 'insert') {
        const row = { id: S.nextTaskId++, done_at: null, done_by: null, created_at: '2026-09-23T08:00:00Z', ...body.values };
        S.tasks.push(row);
        return jsonOk(body.single ? row : [row]);
      }
      if (body.op === 'update') {
        for (const t of applyFilters(S.tasks, body.filters)) Object.assign(t, body.values);
        return jsonOk([]);
      }
      if (body.op === 'delete') {
        const kill = new Set(applyFilters(S.tasks, body.filters));
        S.tasks = S.tasks.filter((t) => !kill.has(t));
        return jsonOk([]);
      }
    }
    if (body.table === 'users' && body.op === 'select') return jsonOk(S.staff);
    return jsonOk([]);
  }
  return jsonOk([]);
};
