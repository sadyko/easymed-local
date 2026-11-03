// LAB_PANEL_DEDUP_V1 — стенд «настоящий экран лаборатории на настоящем сервере».
//
// Экраны (lab-panels.js, laboratory.js) работают без изменений на поддельной
// DOM, а всё, что они спрашивают и пишут, уходит HTTP-запросом в настоящий
// сервер (createApp) на базе в памяти после всех миграций. Заглушка сервера
// дала бы зелёный тест и на старом коде: копии показателей рождались на
// границе «экран — сервер» (три запроса сохранения вперемешку).
//
// Две вещи поддельной DOM — как у браузера, потому что от них зависит ответ:
//   • клик по неактивной кнопке до обработчика не доходит (как в браузере);
//     raw = true — доходит (проверка, что и сам обработчик не пишет дважды);
//   • слушатели документа живые (Escape закрывает окно).
// slow(ms) — каждый запрос к /api ждёт столько перед отправкой: «медленный
// сервер», на котором человек успевает нажать второй раз.
// Данные — синтетические; на диск пишется только временная папка лицензии
// (убирается сама).
import { openDb } from '../../../../server/db/connection.js';
import { migrate } from '../../../../server/db/migrate.js';
import { hashPassword } from '../../../../server/services/auth.js';
import { createApp } from '../../../../server/app.js';
import { licensedDataDir } from '../../../../server/services/control/licensed-fixture.js';
import { listen } from '../../../../control-plane/server/test-helpers/listen.js';

export const ui = { raw: false };

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; this.parentNode = null; this.disabled = false; }
  appendChild(c) { if (c && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c); this.children.push(c); if (c) c.parentNode = this; return c; }
  prepend(c) { this.children.unshift(c); if (c) c.parentNode = this; return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new TX(c) : c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); if (c) c.parentNode = null; return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) return this.appendChild(c); this.children.splice(i, 0, c); c.parentNode = this; return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren(...cs) { for (const c of this.children) if (c) c.parentNode = null; this.children.length = 0; for (const c of cs) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true; if (k === 'disabled') this.disabled = true; if (k === 'selected') this.selected = true; }
  getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); } removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() {
    if (this.disabled && !ui.raw) return;   // как браузер: неактивная кнопка клик не получает
    this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} });
  }
  focus() {} blur() {} scrollTo() {} scrollIntoView() {} select() {}
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  closest() { return null; }
  querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); for (const c of this.children) if (c) c.parentNode = null; this.children.length = 0; }
  get innerText() { return this._t; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  // Подключён ли к документу: кнопка перерисованного редактора — нет.
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document.body; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  } else {
    let ih = '';
    Object.defineProperty(el, 'innerHTML', { configurable: true, set(v) { ih = String(v); }, get() { return ih; } });
  }
  return el;
}
export const body = mk('body');
export const toasts = [];
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toasts[toasts.length - 1] || ''; }, set(v) { toasts.push(String(v)); } });

const docListeners = {};
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body, documentElement: mk('html'),
  addEventListener(t, fn) { (docListeners[t] || (docListeners[t] = [])).push(fn); },
  removeEventListener(t, fn) { const a = docListeners[t] || []; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  getElementById: (id) => (id === 'toast' ? toastEl : null),
  querySelector() { return null; }, querySelectorAll() { return []; },
};
/** Нажать клавишу «в документе» (Escape окна вешается на document). */
export function pressKey(key) { for (const fn of [...(docListeners.keydown || [])]) fn({ key, target: body, preventDefault() {}, stopPropagation() {} }); }

const store = new Map([['admin.lang', 'ru']]);   // язык — до импорта видов
const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.localStorage = ls; globalThis.sessionStorage = ls;
export const printed = [];
export const confirms = [];   // тексты вопросов; ответ — confirmAnswer
export let confirmAnswer = true;
export function answerConfirm(v) { confirmAnswer = v; }
const confirmFn = (q) => { confirms.push(String(q)); return confirmAnswer; };
globalThis.window = {
  location: { hostname: 'localhost', hash: '', search: '', pathname: '/' }, localStorage: ls, sessionStorage: ls,
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 2, full_name: 'Лаборант', role: 'lab' } } },
  CLINIC: { id: 'c-1' },
  confirm: confirmFn,
  open: () => ({ document: { open() {}, write(h) { printed.push(String(h)); }, close() {} }, focus() {}, print() {} }),
  easymedSetTabSub: () => {},
};
globalThis.confirm = confirmFn;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { language: 'ru-RU', languages: ['ru-RU'], clipboard: { writeText: async () => {} } } });

export const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
export const textOf = (el) => walk(el).map((n) => n._t || '').join('');
export const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
export const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
export const byTag = (root, t) => walk(root).filter((n) => n.tagName === t.toUpperCase());
export const buttonByText = (root, s) => byTag(root, 'button').find((b) => textOf(b).includes(s));
export const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
/** Дождаться, пока экран дорисует ответы сервера (n коротких пауз). */
export async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(25); }

const realFetch = globalThis.fetch;
let delayMs = 0;
/** Медленный сервер: каждый запрос к /api ждёт ms перед отправкой. */
export function slow(ms) { delayMs = ms; }
// Придержать запрос RPC name, пока тест не отпустит: «сервер ещё отвечает».
const holds = new Map();
export function holdRpc(name) {
  let release;
  const gate = new Promise((r) => { release = r; });
  holds.set('/api/rpc/' + name, gate);
  return () => { holds.delete('/api/rpc/' + name); release(); };
}

/** Настоящий сервер на базе в памяти; seed(db) — синтетические строки. */
export async function startApp(seed = () => {}) {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'boss', hashPassword('password1'), 'Админ', 'admin');
  u.run(2, 'lab', hashPassword('password1'), 'Лаборант', 'lab');
  seed(db);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await realFetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lab', password: 'password1' }) });
  if (res.status !== 200) throw new Error('login ' + res.status);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const s = String(url);
    if (!s.startsWith('/api/')) return realFetch(url, init);
    let b = null; try { b = init.body ? JSON.parse(init.body) : null; } catch { b = null; }
    calls.push({ url: s, table: b && b.table, op: b && b.op });
    if (delayMs) await tick(delayMs);
    if (holds.has(s)) await holds.get(s);
    return realFetch(base + s, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } });
  };
  return { db, calls, close: () => { globalThis.fetch = realFetch; server.close(); db.close(); } };
}
