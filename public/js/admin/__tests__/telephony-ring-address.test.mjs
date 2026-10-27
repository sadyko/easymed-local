// CALL_RING_V1 (2026-10-17) — экран «Телефония», плитка onlinePBX: карточка «События
// звонков — блок «Звонит»» с адресом для кабинета станции. Через публичный сервер
// — адрес и подсказка; без него — причина и, если есть публичный адрес клиники,
// прямой адрес; «Сгенерировать заново» спрашивает и меняет адрес; сервер без
// этого RPC — честная строка, а не пустая карточка.
//
// Свой маленький стенд (как у telephony-settings.test.mjs, но без его тысячи
// строк): поддельный DOM, поддельный сервер по именам RPC.
import { test } from 'node:test';
import assert from 'node:assert';

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} scrollTo() {} remove() {} select() {}
  querySelector() { return null; } querySelectorAll() { return []; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add() {}, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
function mk(t) {
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const toastEl = mk('div');
let toastMsg = null;
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
globalThis.document = { createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t), head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById: (id) => (id === 'toast' ? toastEl : null), querySelector() { return null; }, querySelectorAll() { return []; } };
const store = new Map();
const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
ls.setItem('admin.lang', 'ru');
globalThis.localStorage = ls;
let confirmAnswer = true;
globalThis.window = { location: { hostname: 'localhost' }, localStorage: ls, addEventListener() {}, easymed: { state: { user: { id: 1, role: 'admin' } } }, confirm: () => confirmAnswer };
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });   // в Node navigator — только getter
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byAttr = (root, a) => walk(root).filter((n) => n.attrs && a in n.attrs);
const findTileByText = (root, re) => walk(root).filter((n) => n.tagName === 'BUTTON' && /(^|\s)tel-prov(\s|$)/.test(String(n.className))).find((b) => re.test(textOf(b)));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

const SETTINGS = { enabled: false, provider: 'binotel', api_key: '', api_secret_set: false, company_id: '', poll_interval_sec: 30, webhooks_enabled: false, public_base_url: '', last_poll_at: null, last_call_at: null, last_error: null };
const PBX = { id: 7, kind: 'onlinepbx', kind_label: 'onlinePBX', name: 'Регистратура', enabled: true, poll_interval_sec: 30, config: { domain: 'clinic.onpbx.ru' }, authorized: true, configured: true, last_poll_at: null, last_call_at: null, last_error: '' };
const CFG = { stages: [{ key: 'in_process', label: 'В обработке', color: 'info', position: 1, is_active: 1, kind: 'open' }], sources: [], routing: [] };
const TOKEN = 'ab'.repeat(16);
let ringInfo, rotateCalls, ringCalls, RPC;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const name = u.startsWith('/api/rpc/') ? u.slice('/api/rpc/'.length) : '';
  if (name) RPC.push(name);
  if (name === 'telephony_settings_get') return jsonOk({ ...SETTINGS });
  if (name === 'telephony_providers_list') return jsonOk({ kinds: [{ kind: 'onlinepbx', label: 'onlinePBX' }], providers: [{ ...PBX }] });
  if (name === 'telephony_recent_calls') return jsonOk([]);
  if (name === 'telephony_dispositions') return jsonOk([]);
  if (name === 'crm_config_get') return jsonOk(CFG);
  if (name === 'telephony_ring_info') { ringCalls++; return typeof ringInfo === 'function' ? ringInfo() : jsonOk(ringInfo); }
  if (name === 'telephony_ring_token_rotate') { rotateCalls++; return jsonOk({ ...ringInfo, ring_token: 'cd'.repeat(16), relay_url: ringInfo.relay_url ? ringInfo.relay_url.replace(TOKEN, 'cd'.repeat(16)) : '', direct_url: ringInfo.direct_url ? ringInfo.direct_url.replace(TOKEN, 'cd'.repeat(16)) : '' }); }
  if (u.startsWith('/api/db')) return jsonOk([]);
  return jsonOk({});
};

const { renderTelephonySettings } = await import('../views/telephony-settings.js');

async function openPbx(info) {
  ringInfo = info; rotateCalls = 0; ringCalls = 0; RPC = []; toastMsg = null; confirmAnswer = true;
  const root = mk('div');
  await renderTelephonySettings(root, { onNavigate() {} });
  await tick(40);
  const tile = findTileByText(root, /Регистратура/);
  assert.ok(tile, 'плитки onlinePBX нет');
  tile.click();
  await tick(60);
  const card = byAttr(root, 'data-ring-card')[0];
  assert.ok(card, 'карточки адреса событий нет у плитки onlinePBX');
  return { root, card };
}

test('через публичный сервер: адрес с токеном, подсказка про кабинет, кнопка «Копировать»; RPC спрошен один раз', async () => {
  const { card } = await openPbx({ ring_token: TOKEN, relay_url: 'https://api.easymed.uz/_pbx/v1/c-000777/' + TOKEN, direct_url: '', relay_ready: true, relay_reason: '', clinic_id: 'c-000777' });
  assert.strictEqual(ringCalls, 1);
  const inp = byAttr(card, 'data-ring-relay-url')[0];
  assert.ok(inp, 'поля с адресом нет');
  assert.strictEqual(inp.value, 'https://api.easymed.uz/_pbx/v1/c-000777/' + TOKEN);
  assert.ok(/Сервисы → Интеграция → Webhooks/.test(textOf(card)));
  assert.ok(/Копировать/.test(textOf(card)));
  assert.strictEqual(byAttr(card, 'data-ring-direct-url').length, 0);
});

test('без публичного сервера: причина словами; с публичным адресом клиники — прямой адрес; без него — где его взять', async () => {
  const a = await openPbx({ ring_token: TOKEN, relay_url: '', direct_url: 'https://clinic.example.uz/api/telephony/pbx/' + TOKEN, relay_ready: false, relay_reason: 'not_enabled', clinic_id: 'c-000777' });
  assert.ok(/Easy-Med ещё не включил обмен/.test(textOf(a.card)));
  assert.strictEqual(byAttr(a.card, 'data-ring-direct-url')[0].value, 'https://clinic.example.uz/api/telephony/pbx/' + TOKEN);
  const b = await openPbx({ ring_token: TOKEN, relay_url: '', direct_url: '', relay_ready: false, relay_reason: 'not_enrolled', clinic_id: '' });
  assert.ok(/не зарегистрирована/.test(textOf(b.card)));
  assert.ok(/публичный адрес клиники/.test(textOf(b.card)), 'не сказано, откуда взять прямой адрес');
  assert.strictEqual(byAttr(b.card, 'data-ring-direct-url').length, 0);
});

test('«Сгенерировать заново»: спрашивает; отказ — ничего; согласие — RPC и новый адрес на экране', async () => {
  const { card } = await openPbx({ ring_token: TOKEN, relay_url: 'https://api.easymed.uz/_pbx/v1/c-000777/' + TOKEN, direct_url: '', relay_ready: true, relay_reason: '', clinic_id: 'c-000777' });
  confirmAnswer = false;
  byAttr(card, 'data-ring-rotate')[0].click();
  await tick(30);
  assert.strictEqual(rotateCalls, 0, 'адрес сменился без согласия');
  confirmAnswer = true;
  byAttr(card, 'data-ring-rotate')[0].click();
  await tick(60);
  assert.strictEqual(rotateCalls, 1);
  assert.strictEqual(byAttr(card, 'data-ring-relay-url')[0].value, 'https://api.easymed.uz/_pbx/v1/c-000777/' + 'cd'.repeat(16));
  assert.ok(/Адрес обновлён/.test(String(toastMsg)));
});

test('сервер старее экрана (RPC не знаком) — честная строка, карточка не пустая и экран не падает', async () => {
  const { card } = await openPbx(() => jsonErr({ code: 'rpc_not_implemented', message: 'RPC not implemented: telephony_ring_info' }, 501));
  assert.ok(/Сервер старее экрана/.test(textOf(card)), textOf(card));
  assert.strictEqual(byAttr(card, 'data-ring-rotate').length, 0);
});
