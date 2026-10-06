// LIS_VENDOR_EXACT_V1 (2026-10-06) — Лаборатория → «Анализаторы» для шести
// настоящих приборов клиники (Mindray BC-20, BC-5300, BS-200, BS-240, CL-900i,
// Autobio AutoLumo A1000), по исследованию C:\Users\user\Desktop\analyzer-research
// (REPORT.md, части B и C):
//
//   — D14: кто подключён к порту приёма (lis_listeners.peers): «приходят
//     данные, которые Easy-Med не понимает (похоже на ASTM)» и «прибор
//     подключён и ждёт первую пробу» — раньше и то и другое выглядело как
//     «никто не подключался»;
//   — D2: «Добавить» найденный прибор, который не назвал свою модель, — только
//     с выбранной моделью или «Другой анализатор (общий HL7)»: без модели
//     Easy-Med читал бы не то поле (у BS-240 и CL-900i — номер прогона вместо
//     номера пробирки);
//   — D10: в лотке — сообщение с непрочитанными буквами (U+FFFD): коды тестов
//     на анализаторе должны быть латиницей;
//   — D12: инструкция «Как подключить анализатор» — по каждой модели, словами
//     экранов самих приборов.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/lab-devices-real.test.mjs (itself
// from lab-devices-add / lab-panels-mode tests) because these views also
// render Icon() calls, which go through ui.js's html() -> a <template> parse.
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

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — язык выбирается ОДИН раз, при загрузке i18n.js: русский,
// как у клиники (CI работает на английской машине).
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){},
  dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  prompt: () => null,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');

// Тост — свой узел (как в lab-devices-add.test.mjs): текст вне `_t`.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const findButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findButtons(root).find((b) => re.test(textOf(b)));
const label = (b) => textOf(b).replace(/<svg[\s\S]*?<\/svg>/g, '').trim();
const formButton = (root, re) => findButtons(root).find((b) => re.test(label(b)));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- fake сервер -----------------------------------------------------------
const PROFILES = [
  { key: 'mindray-bc-20', vendor: 'Mindray', model: 'BC-20', channelsSource: 'documented', defaultPort: 2575, channels: [], connect: 'listen', wireSource: null },
  { key: 'mindray-bs-200', vendor: 'Mindray', model: 'BS-200', channelsSource: 'device', wireSource: 'documented', defaultPort: 2575, channels: [], connect: 'listen', oneTestPerMessage: true },
  { key: 'mindray-bs-240', vendor: 'Mindray', model: 'BS-240', channelsSource: 'device', wireSource: 'documented', defaultPort: 2575, channels: [], connect: 'listen' },
  { key: 'autobio-autolumo-a1000', vendor: 'Autobio', model: 'AutoLumo A1000', channelsSource: 'device', wireSource: 'driver', defaultPort: 2575, channels: [], connect: 'listen', oneTestPerMessage: true },
];
const BS = { id: 1, name: 'Биохимия', profile: 'mindray-bs-200', transport: 'mllp', host: '10.0.0.40', port: 2575, enabled: 1, added: 1, discovered: 1, model_confirmed: 1, dial: 0, last_seen_at: '2026-10-05T08:00:00Z' };

let DEVICES = [];
let LISTENERS = { listening: [2575], failed: [], dialing: [], peers: [] };
let MESSAGES = [];
let writes = [];
let rpcCalls = [];
let PROFILES_FAIL = false;
// Ответ lis_device_add: null — принято; объект — отказ сервера.
let ADD_REPLY = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') { writes.push(body); return { ok: true, json: async () => ({ data: [] }) }; }
    if (body && body.table === 'lab_devices') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(DEVICES)) }) };
    if (body && body.table === 'lab_device_messages') {
      return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(MESSAGES.filter((m) => !m.resolved_at && m.status !== 'applied'))) }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    const ok = (data) => ({ ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(data)) }) });
    if (name === 'lis_profiles') {
      if (PROFILES_FAIL) return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } }) };
      return ok(PROFILES);
    }
    if (name === 'lis_listeners') return ok({ ...LISTENERS, now: new Date().toISOString() });
    if (name === 'lis_restart') return ok({ ok: true, listeners: 1 });
    if (name === 'lis_device_add') {
      return ADD_REPLY
        ? { ok: false, status: 400, json: async () => ({ error: ADD_REPLY }) }
        : ok({ ok: true, id: body && body.id });
    }
    return ok([]);
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');
const { STRINGS } = await import('../i18n-strings.js');

function reset() {
  DEVICES = [BS];
  LISTENERS = { listening: [2575], failed: [], dialing: [], peers: [] };
  MESSAGES = [];
  PROFILES_FAIL = false;
  ADD_REPLY = null;
}
async function mount() {
  writes = []; rpcCalls = []; toastMsg = null;
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();   // живой опрос тесту не нужен
  return root;
}
const cardWithTitle = (root, title) => walk(root).find((n) => String(n.className).split(/\s+/).includes('card')
  && walk(n).some((c) => c.tagName === 'H3' && textOf(c) === title));
const devicesCard = (root) => cardWithTitle(root, 'Анализаторы');
const addWindow = (root) => cardWithTitle(root, 'Добавить анализатор');
async function openAddWindow(root) {
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
}

// ── D14: кто подключён к порту приёма ────────────────────────────────────────
const NOW = Date.now();
const peer = (over) => ({ ip: '192.168.1.33', port: 2575, connectedAt: iso(NOW - 120000), lastRxAt: iso(NOW - 5000),
  frames: 0, noiseBytes: 0, noiseHint: null, open: true, ...over });
const ASTM_LINE = 'С адреса 192.168.1.33 приходят данные, которые Easy-Med не понимает (похоже на ASTM). Проверьте на анализаторе протокол HL7.';
const WAIT_LINE = 'Прибор 192.168.1.40 подключён и ждёт первую пробу';

test('D14: прибор шлёт непонятное — строка с адресом и подсказкой в «Анализаторах» и в «Добавить прибор»; подключён и молчит — только в окне', async () => {
  reset();
  LISTENERS.peers = [
    peer({ noiseBytes: 412, noiseHint: 'astm' }),
    peer({ ip: '192.168.1.40', lastRxAt: null }),
    peer({ ip: '10.0.0.40', frames: 5 }),   // BS-200 из таблицы — работает, строки нет
  ];
  const root = await mount();
  const card = textOf(devicesCard(root));
  assert.ok(card.includes(ASTM_LINE), 'беда видна сразу, без окна: ' + card);
  assert.ok(!card.includes(WAIT_LINE), 'ожидание — не беда: в таблице его нет');
  await openAddWindow(root);
  const win = textOf(addWindow(root));
  assert.ok(win.includes(ASTM_LINE), win);
  assert.ok(win.includes(WAIT_LINE), win);
  assert.ok(!win.includes('10.0.0.40 подключён'), 'прибор, который присылает пробы, не «ждёт первую»');
});

test('D14: подсказка — по тому, на что похоже: Autobio, Unicode, HL7 без рамки, неизвестное', async () => {
  const cases = [
    ['autobio', 'похоже на собственный формат Autobio — выберите HL7'],
    ['utf16', 'кодировка Unicode — выберите UTF-8'],
    ['hl7-unframed', 'HL7 без рамки MLLP'],
    ['other', 'неизвестный формат'],
    [null, 'неизвестный формат'],
  ];
  for (const [hint, words] of cases) {
    reset();
    LISTENERS.peers = [peer({ noiseBytes: 40, noiseHint: hint })];
    const root = await mount();
    assert.ok(textOf(devicesCard(root)).includes('С адреса 192.168.1.33 приходят данные, которые Easy-Med не понимает (' + words + '). Проверьте на анализаторе протокол HL7.'),
      String(hint) + ': ' + textOf(devicesCard(root)));
  }
});

test('D14: опрос с новым временем приёма окно не перестраивает; новая беда — перерисовывает', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    reset();
    LISTENERS.peers = [peer({ ip: '192.168.1.40', lastRxAt: null })];
    writes = []; rpcCalls = []; toastMsg = null;
    const root = mk('div');
    await mountLabDevices(root);
    await openAddWindow(root);
    const btn = findButtonByText(root, /Добавить по адресу/);
    assert.ok(btn);
    LISTENERS = { ...LISTENERS, peers: [peer({ ip: '192.168.1.40', lastRxAt: null, connectedAt: iso(Date.now()) })] };
    mock.timers.tick(5000);
    await tick(60);
    assert.ok(walk(root).includes(btn), 'окно не перестроено: кнопка под курсором та же');
    LISTENERS = { ...LISTENERS, peers: [peer({ ip: '192.168.1.40', noiseBytes: 9, noiseHint: 'utf16' })] };
    mock.timers.tick(5000);
    await tick(60);
    const win = textOf(addWindow(root));
    assert.ok(win.includes('С адреса 192.168.1.40 приходят данные, которые Easy-Med не понимает (кодировка Unicode — выберите UTF-8).'), win);
    assert.ok(!win.includes('192.168.1.40 подключён и ждёт'), 'непонятное важнее ожидания');
  } finally {
    stopLabDevicesLive();
    mock.timers.reset();
  }
});

test('D14: строки соединений — в словаре на uz и en, адрес и подсказка подставляются', () => {
  const keys = [
    'С адреса {ip} приходят данные, которые Easy-Med не понимает ({hint}). Проверьте на анализаторе протокол HL7.',
    'Прибор {ip} подключён и ждёт первую пробу',
    'похоже на ASTM', 'похоже на собственный формат Autobio — выберите HL7', 'кодировка Unicode — выберите UTF-8',
    'HL7 без рамки MLLP', 'неизвестный формат',
  ];
  for (const k of keys) {
    assert.ok(STRINGS[k], 'в словаре: ' + k);
    for (const lang of ['en', 'uz']) {
      assert.ok(STRINGS[k][lang] && STRINGS[k][lang] !== k, lang + ': ' + k);
      for (const hole of k.match(/\{\w+\}/g) || []) assert.ok(STRINGS[k][lang].includes(hole), lang + ' ' + hole + ': ' + STRINGS[k][lang]);
    }
  }
});
