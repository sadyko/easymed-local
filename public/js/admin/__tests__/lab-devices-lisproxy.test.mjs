// LIS_PROXY_V1 (2026-10-09) — Лаборатория → «Анализаторы» и LIS Proxy:
// карточка (включить, адрес с ключом, сменить ключ; роли), строки приборов
// за прокси, «Добавить» и «Изменить» такого прибора, «один анализатор — один
// приёмник», группы строк лотка (docs/specs/2026-10-09-lis-proxy-endpoint-design.md, раздел 7).
import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — копия из __tests__/lab-devices-add.test.mjs.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
const store = new Map();
const fakeLocalStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта экрана
let CONFIRM = true;
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } }, CLINIC: { id: 'c-1' },
  confirm: () => CONFIRM, prompt: () => null,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);
const findButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findButtons(root).find((b) => re.test(textOf(b)));

// --- fake сервер -----------------------------------------------------------
const NOW = new Date().toISOString();
const PROFILES = [
  { key: 'mindray-bs-200', vendor: 'Mindray', model: 'BS-200', channels: [] },
  { key: 'mindray-bc-780', vendor: 'Mindray', model: 'BC-780', channels: [] },
  { key: 'autobio-autolumo-a1000', vendor: 'Autobio', model: 'AutoLumo A1000', channels: [] },
  { key: 'mindray-cl-900i', vendor: 'Mindray', model: 'CL-900i', channels: [] },
];
const PROXY_BS = { id: 1, name: 'bs200', profile: 'mindray-bs-200', transport: 'mllp', host: '', port: null, enabled: 1, added: 1, discovered: 1, model_confirmed: 1,
  last_seen_at: NOW, via: 'lisproxy', proxy_name: 'bs200', proxy_label: 'LAB-PC-1', proxy_ip: '192.168.1.21' };
const PROXY_FOUND = { id: 2, name: 'lumo', profile: '', transport: 'mllp', host: '', port: null, enabled: 1, added: 0, discovered: 1, model_confirmed: 0,
  last_seen_at: NOW, via: 'lisproxy', proxy_name: 'lumo', proxy_label: 'LAB-PC-2', proxy_ip: '192.168.1.22' };
const MLLP_BS = { id: 3, name: 'BS-200 напрямую', profile: 'mindray-bs-200', transport: 'mllp', host: '10.0.0.40', port: 2575, enabled: 1, added: 1, discovered: 0, model_confirmed: 1, last_seen_at: NOW };
let DEVICES = [];
let MESSAGES = [];
let COUNTS = [];
let PROXY = null;
let writes = [];
let rpcCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') { writes.push(body); return { ok: true, json: async () => ({ data: [] }) }; }
    if (body && body.table === 'lab_devices') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(DEVICES)) }) };
    if (body && body.table === 'lab_device_messages') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(MESSAGES)) }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') return { ok: true, json: async () => ({ data: PROFILES }) };
    if (name === 'lis_listeners') return { ok: true, json: async () => ({ data: { listening: [2575], failed: [], now: NOW } }) };
    if (name === 'lis_service_counts') return { ok: true, json: async () => ({ data: COUNTS }) };
    if (name === 'lis_proxy_get') return { ok: true, json: async () => ({ data: PROXY }) };
    if (name === 'lis_proxy_set') {
      PROXY = { ...PROXY, enabled: body.enabled === undefined ? PROXY.enabled : body.enabled, key: body.rotate ? 'NEWKEY' : PROXY.key };
      PROXY.urls = PROXY.enabled ? ['http://192.168.1.10:8000/api/lisproxy?key=' + PROXY.key] : [];
      return { ok: true, json: async () => ({ data: PROXY }) };
    }
    if (name === 'lis_message_dismiss') return { ok: true, json: async () => ({ data: { ok: true } }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');
const { proxyUrls } = await import('../views/lab-proxy-card.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function reset({ devices = [PROXY_BS], proxy = { enabled: true, key: 'K1', port: 8000, addresses: ['192.168.1.10'], urls: ['http://192.168.1.10:8000/api/lisproxy?key=K1'], can_manage: true } } = {}) {
  DEVICES = devices; MESSAGES = []; COUNTS = []; PROXY = proxy; writes = []; rpcCalls = []; toastMsg = null; CONFIRM = true;
}
async function mount() {
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();
  await tick();
  return root;
}

test('карточка: включён — адрес с ключом и «Копировать»; «Сменить ключ» спрашивает и меняет', async () => {
  reset();
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('LIS Proxy'));
  assert.ok(text.includes('http://192.168.1.10:8000/api/lisproxy?key=K1'), 'адрес с ключом виден');
  assert.ok(findButtonByText(root, /Копировать/), 'есть «Копировать»');
  findButtonByText(root, /Сменить ключ/).click();
  await tick();
  const set = rpcCalls.find((c) => c.name === 'lis_proxy_set');
  assert.deepStrictEqual(set && set.args, { rotate: true });
  assert.ok(textOf(root).includes('key=NEWKEY'), 'новый адрес на экране');
});

test('карточка: выключен — «Включить» включает; «Сменить ключ» без согласия ничего не делает', async () => {
  reset({ proxy: { enabled: false, key: null, port: 8000, addresses: [], urls: [], can_manage: true } });
  const root = await mount();
  assert.ok(textOf(root).includes('Выключен — LIS Proxy получает ответ «адрес не найден», и его результаты теряются.'));
  findButtonByText(root, /^\s*Включить\s*$/).click();
  await tick();
  assert.deepStrictEqual(rpcCalls.find((c) => c.name === 'lis_proxy_set').args, { enabled: true });
  CONFIRM = false;
  rpcCalls = [];
  findButtonByText(root, /Сменить ключ/).click();
  await tick();
  assert.equal(rpcCalls.filter((c) => c.name === 'lis_proxy_set').length, 0);
});

test('карточка: врач — без адреса и без кнопок', async () => {
  reset({ proxy: { enabled: true, key: null, port: 8000, addresses: [], urls: [], can_manage: false } });
  const root = await mount();
  const text = textOf(root);
  assert.ok(text.includes('Адрес для LIS Proxy видят и меняют администратор и лаборант.'));
  assert.ok(!text.includes('/api/lisproxy?key='));
  assert.ok(!findButtonByText(root, /Сменить ключ/));
});

test('адрес: от сервера; адресов нет — по адресу страницы, но не localhost', () => {
  const st = { enabled: true, key: 'K', port: 8000, urls: [] };
  assert.deepStrictEqual(proxyUrls({ ...st, urls: ['http://a/x'] }, { hostname: '10.0.0.5' }), ['http://a/x']);
  assert.deepStrictEqual(proxyUrls(st, { hostname: '10.0.0.5' }), ['http://10.0.0.5:8000/api/lisproxy?key=K']);
  assert.deepStrictEqual(proxyUrls(st, { hostname: 'localhost' }), []);
  assert.deepStrictEqual(proxyUrls(st, { hostname: '127.0.0.1' }), []);
  assert.deepStrictEqual(proxyUrls({ ...st, enabled: false }, { hostname: '10.0.0.5' }), []);
});

test('«Копировать адрес»: буфер обмена есть — адрес в буфере; нет (Easy-Med открыт по http-адресу в сети) — адрес выделен для Ctrl+C', async () => {
  reset();
  const root = await mount();
  const btn = findButtonByText(root, /Копировать адрес/);
  const code = walk(root).find((n) => n.tagName === 'CODE' && textOf(n) === 'http://192.168.1.10:8000/api/lisproxy?key=K1');
  assert.ok(btn && code, 'кнопка и адрес на экране');
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied = null;
  let selected = null;
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t) => { copied = t; } } } });
    btn.click();
    await tick();
    assert.equal(copied, 'http://192.168.1.10:8000/api/lisproxy?key=K1');
    assert.equal(toastMsg, 'Скопировано');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    window.getSelection = () => ({ removeAllRanges() {}, addRange(r) { selected = r.node; } });
    document.createRange = () => ({ node: null, selectNodeContents(n) { this.node = n; } });
    btn.click();
    await tick();
    assert.equal(toastMsg, 'Скопируйте вручную');
    assert.equal(selected, code, 'адрес выделен — Ctrl+C копирует его');
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc); else delete globalThis.navigator;
    delete window.getSelection;
    delete document.createRange;
  }
});
