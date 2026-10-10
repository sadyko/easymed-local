// CLINIC_API_STEP7_V1 — стенд экрана «API и подключения»: поддельный DOM (как в
// crm-settings.test.mjs), RPC по имени, буфер обмена, русский язык ДО импорта видов.
export class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); else throw new Error('not a child'); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() { this.selected = true; } remove() {} scrollTo() {}
  querySelector() { return null; } querySelectorAll() { return []; }
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
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById: (id) => (id === 'toast' ? toastEl : null),
  querySelector: () => null, querySelectorAll: () => [],
};
const store = new Map([['admin.lang', 'ru']]);   // I18N_LOCALE_PIN_V1 — до импорта видов
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = { location: { hostname: 'localhost', hash: '' }, localStorage: globalThis.localStorage, addEventListener() {},
  easymed: { state: { user: null } }, confirm: () => true, CLINIC: { id: 1, slug: 'local', name: 'Клиника Демо' } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
export const clip = [];
let clipboardOk = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'ru-RU', languages: ['ru-RU'], userAgent: 'node',
  clipboard: { writeText: async (t) => { if (!clipboardOk) throw new Error('denied'); clip.push(t); } } } });
export function setClipboard(ok) { clipboardOk = ok; }

export const calls = [];
const handlers = new Map();
export function onRpc(name, fn) { handlers.set(name, fn); }
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const m = /^\/api\/rpc\/([a-z_]+)/.exec(u);
  if (!m) return { ok: true, status: 200, json: async () => ({ data: {} }) };
  calls.push([m[1], body]);
  const fn = handlers.get(m[1]);
  const r = fn ? await fn(body) : null;
  if (r && r.__error) return { ok: false, status: r.status || 400, json: async () => ({ error: r.__error }) };
  return { ok: true, status: 200, json: async () => ({ data: r }) };
};
export function reset() {
  calls.length = 0; handlers.clear(); clip.length = 0; clipboardOk = true; toastMsg = null;
  document.body.children.length = 0; store.clear(); store.set('admin.lang', 'ru');
}
export const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
export const textOf = (el) => walk(el).map((n) => n._t || '').join('');
export const byAttr = (root, k, v) => walk(root).filter((n) => n.attrs && (v === undefined ? k in n.attrs : n.attrs[k] === v));
export const buttonByText = (root, re) => walk(root).find((n) => n.tagName === 'BUTTON' && re.test(textOf(n))) || null;
export const lastToast = () => toastMsg;
export const storeValues = () => [...store.values()];
export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
export const modal = (name) => document.body.children.find((n) => n.attrs && n.attrs['data-apic-modal'] === name) || null;
export const rpcNames = () => calls.map((c) => c[0]);

// Образцы значений: 32 знака после префикса и TESTONLY (страж no-real-api-keys).
export const KEY_VALUE = 'em_live_TESTONLYtestonlyTESTONLYtesta91c';
export const SECRET_VALUE = 'em_whsec_TESTONLYtestonlyTESTONLYtest51d0';
const ALL = ['clinic', 'branches', 'doctors', 'services', 'packages', 'slots', 'requests', 'appointments', 'cancel'];
export function settingsFixture(over = {}) {
  return {
    slug: 'klinika-demo', base_url: 'https://api.easymed.uz/klinika-demo/v1/', slug_suggestion: '', public_server: false,
    building_role: 'main', clinic_name: 'Клиника Демо', company_website: 'https://klinika-demo.uz', partner_address_missing: [],
    can: { view: true, edit: true, admin: true },
    connections: [
      { id: 1, kind: 'site', name: 'Сайт клиники', site_url: '', contact: '', scopes: ALL, active: false,
        crm_source_key: 'website', crm_source_label: 'Сайт', owns_source: false, key_mask: 'em_live_••••s1te',
        key_issued_at: '2026-10-10T09:00:00Z', key_issued_by_name: 'Босс', key_ttl: 'never', key_expires_at: null, rate_limit: 120,
        ip_allow: '', webhook_url: '', webhook_events: [], secret_mask: 'em_whsec_••••s1te', last_used_at: null,
        created_at: '2026-10-10T09:00:00Z', created_by_name: 'Босс' },
      { id: 3, kind: 'partner', name: 'med24.uz', site_url: 'https://med24.uz', contact: 'Отдел партнёров',
        scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'], active: true,
        crm_source_key: 'api_med24_uz', crm_source_label: 'med24.uz', owns_source: true, key_mask: 'em_live_••••a91c',
        key_issued_at: '2026-10-10T09:00:00Z', key_issued_by_name: 'Босс', key_ttl: '1y', key_expires_at: '2027-10-10T09:00:00Z',
        rate_limit: 60, ip_allow: '', webhook_url: 'https://med24.uz/hooks/easymed',
        webhook_events: ['request.accepted', 'appointment.created', 'appointment.cancelled'], secret_mask: 'em_whsec_••••51d0',
        last_used_at: null, created_at: '2026-10-10T09:00:00Z', created_by_name: 'Босс' },
    ],
    ...over,
  };
}
export const JOURNAL = [
  { id: 3, at: '2026-10-10T10:00:00Z', connection_id: 3, connection_name: 'med24.uz', user_name: 'Босс', action: 'key_regenerated', detail: {} },
  { id: 2, at: '2026-10-10T09:30:00Z', connection_id: 3, connection_name: 'med24.uz', user_name: 'Босс', action: 'updated', detail: { fields: ['name', 'scopes'] } },
  { id: 1, at: '2026-10-10T09:00:00Z', connection_id: null, connection_name: '', user_name: 'Босс', action: 'slug_saved', detail: { from: '', to: 'klinika-demo' } },
];
