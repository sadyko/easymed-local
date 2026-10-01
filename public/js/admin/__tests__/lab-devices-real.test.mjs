// LIS_REAL_ANALYZERS_V1 (экран, 2026-10-01) — Лаборатория → «Анализаторы» для
// настоящих приборов клиники: Mindray BS-200, Mindray BC-780(R), Autobio
// AutoLumo A1000 (docs/specs/2026-10-01-lis-real-analyzers-design.md, E9).
//
//   — «Easy-Med подключается к прибору сам» (lab_devices.dial): флажок в форме,
//     адрес — только IP локальной сети, порт обязателен; колонка «Подключение»
//     и строка состояния соединения (lis_listeners.dialing);
//   — служебные сообщения за сегодня у прибора (lis_service_counts);
//   — серия BS-200: «Идёт приём результатов» в лотке и одна строка серии в живой ленте;
//   — подпись модели по тому, откуда известен формат (channelsSource, wireSource);
//   — инструкция «Как подключить анализатор» для трёх новых моделей.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/lab-devices-add.test.mjs (itself
// from lab-panels-mode / telephony-settings tests) because these views also
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
// I18N_LOCALE_PIN_V1 — язык выбирается ОДИН раз, при загрузке i18n.js.
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
const rowNamed = (root, name) => walk(root).find((n) => n.tagName === 'TR' && n.children[0] && textOf(n.children[0]) === name);
const trWith = (root, text) => walk(root).find((n) => n.tagName === 'TR' && textOf(n).includes(text));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- fake сервер -----------------------------------------------------------
const PROFILES = [
  { key: 'mindray-bc-5300', vendor: 'Mindray', model: 'BC-5300', channelsSource: 'screenshot', defaultPort: 2575, channels: [], connect: 'listen', wireSource: null },
  { key: 'mindray-bs-200', vendor: 'Mindray', model: 'BS-200', channelsSource: 'device', wireSource: 'documented', defaultPort: 2575, channels: [], connect: 'listen', oneTestPerMessage: true },
  { key: 'mindray-bc-780', vendor: 'Mindray', model: 'BC-780', channelsSource: 'siblings', wireSource: 'siblings', defaultPort: 2575, channels: [{ code: 'WBC', name: 'Лейкоциты' }], connect: 'unknown' },
  { key: 'autobio-autolumo-a1000', vendor: 'Autobio', model: 'AutoLumo A1000', channelsSource: 'device', wireSource: 'driver', defaultPort: 2575, channels: [], connect: 'listen', oneTestPerMessage: true },
];
const now0 = Date.now();
const BS = { id: 1, name: 'Биохимия', profile: 'mindray-bs-200', transport: 'mllp', host: '10.0.0.40', port: 2575, enabled: 1, added: 1, discovered: 1, model_confirmed: 1, dial: 0, last_seen_at: '2026-09-20T08:00:00Z' };
const HEMA = { id: 2, name: 'Гематология', profile: 'mindray-bc-780', transport: 'mllp', host: '10.0.0.30', port: 5600, enabled: 1, added: 1, discovered: 0, model_confirmed: 0, dial: 1, last_seen_at: '2026-09-20T08:00:00Z' };
const WAIT_DIAL = { id: 3, name: 'Второй BC-780', profile: 'mindray-bc-780', transport: 'mllp', host: '10.0.0.31', port: 5601, enabled: 1, added: 1, discovered: 0, dial: 1, last_seen_at: null };
const IMMUNO = { id: 4, name: 'Иммунология', profile: 'autobio-autolumo-a1000', transport: 'mllp', host: '10.0.0.50', port: 2575, enabled: 1, added: 1, discovered: 1, model_confirmed: 1, dial: 0, last_seen_at: '2026-09-20T08:00:00Z' };

const connected = (over = {}) => ({ device_id: 2, host: '10.0.0.30', port: 5600, state: 'connected', since: iso(Date.now() - 60000), last_rx_at: iso(Date.now() - 2000), code: null, retry_at: null, ...over });
const waitingRefused = (over = {}) => ({ device_id: 3, host: '10.0.0.31', port: 5601, state: 'waiting', since: iso(Date.now() - 1000), last_rx_at: null, code: 'refused', retry_at: iso(Date.now() + 30000), ...over });
const baseListeners = () => ({ listening: [2575], failed: [], dialing: [connected(), waitingRefused()] });

let DEVICES = [];
let LISTENERS = baseListeners();
let COUNTS = [];
let MESSAGES = [];
let RECENT = [];
let writes = [];
let rpcCalls = [];
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
    if (name === 'lis_profiles') return ok(PROFILES);
    if (name === 'lis_listeners') return ok(LISTENERS);
    if (name === 'lis_service_counts') return ok(COUNTS);
    if (name === 'lis_recent') return ok(RECENT);
    if (name === 'lis_restart') return ok({ ok: true, listeners: 1 });
    return ok([]);
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');
const { STRINGS } = await import('../i18n-strings.js');

function reset() {
  DEVICES = [BS, HEMA, WAIT_DIAL];
  LISTENERS = baseListeners();
  COUNTS = [{ device_id: 1, qc: 3, calibration: 1, query: 12 }];
  MESSAGES = [];
  RECENT = [];
}
async function mount() {
  writes = []; rpcCalls = []; toastMsg = null;
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();   // живой опрос тесту не нужен
  return root;
}
const deviceTable = (root) => walk(root).find((n) => n.tagName === 'TABLE');
const addWindow = (root) => walk(root).find((n) => String(n.className).split(/\s+/).includes('card')
  && walk(n).some((c) => c.tagName === 'H3' && textOf(c) === 'Добавить анализатор'));
const clock = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

// Подписи формы и подсказок — до тестов: их читают и окно, и форма.
const ADDR_PH = 'адрес анализатора в сети, например 10.0.0.20';
const DIAL_LABEL = 'Easy-Med подключается к прибору сам';
const DIAL_ADD_HINT = 'Анализатор сам не звонит, а ждёт программу LIS? «Добавить по адресу» — и отметьте «Easy-Med подключается к прибору сам».';
const CONNECT_UNKNOWN_HINT = 'Если в настройках LIS прибора нет адреса сервера, а есть только «порт прибора», — отметьте «Easy-Med подключается к прибору сам».';

// ── таблица ──────────────────────────────────────────────────────────────────

test('таблица: «Подключение» — кто кому звонит; у прибора со звонком — строка состояния соединения', async () => {
  reset();
  const root = await mount();
  const table = deviceTable(root);
  assert.ok(walk(table).some((n) => n.tagName === 'TH' && textOf(n) === 'Подключение'));
  const bs = textOf(rowNamed(root, 'Биохимия'));
  assert.ok(bs.includes('сеть · прибор звонит на 2575'), bs);
  assert.ok(bs.includes('10.0.0.40'), 'адрес прибора виден: ' + bs);
  const hema = textOf(rowNamed(root, 'Гематология'));
  assert.ok(hema.includes('сеть · Easy-Med звонит 10.0.0.30:5600'), hema);
  assert.match(hema, /подключено с \S+ · сигнал \d+ с назад/);
  const since = Date.parse(LISTENERS.dialing[0].since);
  if (new Date(since).toDateString() === new Date().toDateString()) assert.ok(hema.includes('подключено с ' + clock(since)), 'время — часами: ' + hema);
});

test('таблица: подпись модели — по тому, откуда известен формат; не «набор типовой» для BS-200, BC-780 и A1000', async () => {
  reset();
  DEVICES = [BS, HEMA, IMMUNO];
  const root = await mount();
  const bs = textOf(rowNamed(root, 'Биохимия'));
  assert.ok(bs.includes('формат документирован; показатели — из проб прибора'), bs);
  assert.ok(textOf(rowNamed(root, 'Гематология')).includes('по документам соседних моделей: сверьте первую пробу'));
  assert.ok(textOf(rowNamed(root, 'Иммунология')).includes('формат — по программам других LIS: сверьте первую пробу'));
  assert.ok(!textOf(deviceTable(root)).includes('типовой'), 'ни одна из трёх моделей не «типовая»');
});

test('таблица: служебные сообщения за сегодня у прибора и подсказка, когда запросов много', async () => {
  reset();
  const root = await mount();
  const bs = textOf(rowNamed(root, 'Биохимия'));
  assert.ok(bs.includes('сегодня: контроль 3, калибровка 1, запросы 12'), bs);
  assert.ok(bs.includes('прибор спрашивает рабочий список — Easy-Med заказов не отдаёт, выключите запрос в настройках LIS прибора'), bs);
  assert.ok(!textOf(rowNamed(root, 'Гематология')).includes('сегодня:'), 'у прибора без служебных — ничего');
  assert.ok(rpcCalls.some((c) => c.name === 'lis_service_counts'), 'счётчик спрошен');

  COUNTS = [{ device_id: 1, qc: 2, calibration: 0, query: 0 }];
  const r2 = await mount();
  const t2 = textOf(rowNamed(r2, 'Биохимия'));
  assert.ok(t2.includes('сегодня: контроль 2'), t2);
  assert.ok(!t2.includes('рабочий список'), 'запросов нет — подсказки нет');
});

test('строка состояния звонка обновляется на месте: секунды — без перестройки таблицы; новое состояние — словами', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    reset();
    writes = []; rpcCalls = []; toastMsg = null;
    const root = mk('div');
    await mountLabDevices(root);   // опрос включён
    const edit = findButtonByText(rowNamed(root, 'Гематология'), /Изменить/);
    assert.ok(edit);
    LISTENERS = { ...baseListeners(), dialing: [connected({ since: LISTENERS.dialing[0].since, last_rx_at: iso(Date.now() - 1000) }), waitingRefused()] };
    mock.timers.tick(5000);
    await tick(60);
    assert.ok(walk(root).includes(edit), 'сигнал сменился — таблица не перестроена, кнопка под курсором та же');
    assert.match(textOf(rowNamed(root, 'Гематология')), /сигнал \d+ с назад/);

    LISTENERS = { ...baseListeners(), dialing: [{ device_id: 2, host: '10.0.0.30', port: 5600, state: 'waiting', since: iso(Date.now()), last_rx_at: null, code: 'closed', retry_at: iso(Date.now() + 4000) }, waitingRefused()] };
    mock.timers.tick(5000);
    await tick(60);
    assert.match(textOf(rowNamed(root, 'Гематология')), /прибор закрыл соединение · повтор через \d+ с/);
  } finally {
    stopLabDevicesLive();
    mock.timers.reset();
  }
});

test('звонок прибору не поднят: внешний адрес, петля на себя, дубль — словами, без кода', async () => {
  reset();
  LISTENERS = { listening: [2575], failed: [], dialing: [{ device_id: 2, host: '8.8.8.8', port: 5600, state: 'off', since: iso(Date.now()), last_rx_at: null, code: 'bad_address', retry_at: null }] };
  let root = await mount();
  let hema = textOf(rowNamed(root, 'Гематология'));
  assert.ok(hema.includes('адрес не из локальной сети — не подключаемся'), hema);
  assert.ok(!hema.includes('bad_address'));
  LISTENERS.dialing[0].code = 'self';
  root = await mount();
  assert.ok(textOf(rowNamed(root, 'Гематология')).includes('это порт самого Easy-Med — не подключаемся'));
  LISTENERS.dialing[0].code = 'duplicate';
  root = await mount();
  assert.ok(textOf(rowNamed(root, 'Гематология')).includes('этот адрес и порт уже у другого прибора — не подключаемся'));
});

// ── окно «Добавить прибор» ───────────────────────────────────────────────────

test('«Ждут первого сообщения»: у прибора со звонком — состояние соединения, а не строка о порте; внизу — как добавить такой прибор', async () => {
  reset();
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const row = textOf(rowNamed(root, 'Второй BC-780'));
  assert.match(row, /отказано в соединении — порт прибора закрыт · повтор через \d+ с/);
  assert.ok(!row.includes('слушается'), 'порт прибора Easy-Med не слушает: ' + row);
  assert.ok(textOf(addWindow(root)).includes(DIAL_ADD_HINT), 'подсказка про прибор, который ждёт звонка');
});

test('окно «Добавить прибор»: опрос с новыми секундами повтора окно не перестраивает', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    reset();
    writes = []; rpcCalls = []; toastMsg = null;
    const root = mk('div');
    await mountLabDevices(root);
    findButtonByText(root, /Добавить прибор/).click();
    await tick();
    const btn = findButtonByText(rowNamed(root, 'Второй BC-780'), /Изменить/);
    assert.ok(btn);
    LISTENERS = { ...baseListeners(), dialing: [connected(), waitingRefused({ retry_at: iso(Date.now() + 12000) })] };
    mock.timers.tick(5000);
    await tick(60);
    assert.ok(walk(root).includes(btn), 'окно не перестроено: кнопка под курсором та же');
    assert.match(textOf(rowNamed(root, 'Второй BC-780')), /повтор через \d+ с/);
  } finally {
    stopLabDevicesLive();
    mock.timers.reset();
  }
});

// ── форма прибора: «Easy-Med подключается к прибору сам» ─────────────────────
const inputByPlaceholder = (root, ph) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === ph);
const dialBox = (root) => walk(root).find((n) => n.tagName === 'LABEL' && textOf(n).includes(DIAL_LABEL));
const dialInput = (root) => { const l = dialBox(root); return l && walk(l).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox'); };
const portInput = (root) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'number');
const hostInput = (root) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder && /10\.0\.0\./.test(n.attrs.placeholder));
const nameInput = (root) => inputByPlaceholder(root, 'Например: Гематология');
const transportSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT' && walk(n).some((o) => o.tagName === 'OPTION' && o.value === 'mllp'));

async function newDeviceForm() {
  reset();
  DEVICES = [BS];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  findButtonByText(root, /Добавить по адресу/).click();
  await tick();
  return root;
}
function tickDial(root, on) {
  const box = dialInput(root);
  box.checked = on;
  box.dispatchEvent({ type: 'change', target: box });
}
async function save(root) {
  formButton(root, /^Сохранить$/).click();
  await tick(60);
}

test('«Добавить по адресу»: флажок «Easy-Med подключается к прибору сам»; строки «пока не поддерживаются» больше нет', async () => {
  const root = await newDeviceForm();
  assert.ok(dialBox(root), 'флажок есть');
  assert.ok(textOf(dialBox(root)).includes('(прибор ждёт звонка, как Mindray BC-3600)'));
  assert.ok(!textOf(root).includes('пока не поддерживаются'), 'прибор-сервер теперь поддержан');
  assert.ok(!('checked' in dialInput(root).attrs), 'новый прибор — по умолчанию звонит сам');
  assert.strictEqual(portInput(root).value, '2575');

  tickDial(root, true);
  assert.strictEqual(portInput(root).value, '', 'у прибора свой порт — 2575 тут ни при чём');
  assert.strictEqual(hostInput(root).attrs.placeholder, 'IP-адрес прибора, например 10.0.0.30');
  const note = walk(root).find((n) => n.tagName === 'P' && textOf(n).startsWith('Easy-Med сам подключится'));
  assert.ok(note && note.style.display !== 'none', 'пояснение про звонок видно');
  tickDial(root, false);
  assert.strictEqual(portInput(root).value, '2575', 'флажок сняли — порт по умолчанию вернулся');
  assert.strictEqual(note.style.display, 'none');
  assert.ok(inputByPlaceholder(root, ADDR_PH), 'подсказка адреса — прежняя');
});

async function dialSave(host, port) {
  const root = await newDeviceForm();
  nameInput(root).value = 'Гематология';
  tickDial(root, true);
  hostInput(root).value = host;
  portInput(root).value = port;
  await save(root);
  return root;
}

test('звонок: адрес не из локальной сети, имя вместо IP, без порта — предупреждение, в базу ничего', async () => {
  const cases = [
    ['8.8.8.8', '5600', 'Адрес не из локальной сети — анализатор в интернете означает ошибку в адресе'],
    ['bc780.local', '5600', 'Нужен IP-адрес анализатора, например 10.0.0.30, — имя не подходит'],
    ['10.0.0.30', '', 'Укажите порт анализатора — он в настройках LIS прибора'],
    ['10.0.0.30', '70000', 'Укажите порт анализатора — он в настройках LIS прибора'],
    ['10.0.0.30', '0', 'Укажите порт анализатора — он в настройках LIS прибора'],
  ];
  for (const [host, port, msg] of cases) {
    const root = await dialSave(host, port);
    assert.strictEqual(toastMsg, msg, host + ':' + port);
    assert.strictEqual(toastEl.dataset.kind, 'warn');
    assert.ok(!writes.some((w) => w.table === 'lab_devices'), 'ничего не записано: ' + JSON.stringify(writes));
    assert.ok(!rpcCalls.some((c) => c.name === 'lis_restart'));
    assert.ok(formButton(root, /^Сохранить$/), 'форма осталась на экране');
  }
});

test('звонок: локальный IP и порт — запись с dial = 1 и портом прибора; без флажка — dial = 0 и 2575', async () => {
  await dialSave(' 10.0.0.30 ', '5600');
  const ins = writes.find((w) => w.table === 'lab_devices' && w.op === 'insert');
  assert.ok(ins, 'записано: ' + JSON.stringify(writes) + ' ' + toastMsg);
  const v = [].concat(ins.values)[0];
  assert.deepStrictEqual([v.transport, v.host, v.port, v.dial], ['mllp', '10.0.0.30', 5600, 1]);
  assert.ok(rpcCalls.some((c) => c.name === 'lis_restart'), 'слушатели и клиенты перезапущены');

  const root = await newDeviceForm();
  nameInput(root).value = 'Химия';
  inputByPlaceholder(root, ADDR_PH).value = '10.0.0.40';
  await save(root);
  const v2 = [].concat(writes.find((w) => w.table === 'lab_devices' && w.op === 'insert').values)[0];
  assert.deepStrictEqual([v2.host, v2.port, v2.dial], ['10.0.0.40', 2575, 0]);
});

test('«Изменить» у прибора со звонком: флажок отмечен; сняли — dial = 0, порт прибора сохранён', async () => {
  reset();
  const root = await mount();
  findButtonByText(rowNamed(root, 'Гематология'), /Изменить/).click();
  await tick();
  const box = dialInput(root);
  assert.ok(box && 'checked' in box.attrs, 'флажок отмечен');
  assert.strictEqual(portInput(root).value, '5600');
  transportSelect(root).value = 'mllp';
  tickDial(root, false);
  await save(root);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, JSON.stringify(writes) + ' ' + toastMsg);
  assert.strictEqual(upd.values.dial, 0);
  assert.strictEqual(upd.values.port, 5600);
});

test('«Изменить» у прибора со звонком: сохранение без правки оставляет dial = 1', async () => {
  reset();
  const root = await mount();
  findButtonByText(rowNamed(root, 'Гематология'), /Изменить/).click();
  await tick();
  transportSelect(root).value = 'mllp';   // тестовый DOM не выводит value списка из selected-пункта (ревью M10)
  dialInput(root).checked = true;   // тестовый DOM не выводит свойство из атрибута — как в браузере
  await save(root);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, JSON.stringify(writes) + ' ' + toastMsg);
  assert.deepStrictEqual([upd.values.dial, upd.values.host, upd.values.port], [1, '10.0.0.30', 5600]);
});

test('модель «кто звонит — неизвестно» (BC-780): подсказка про флажок; у BS-200 её нет', async () => {
  const root = await newDeviceForm();
  const hint = walk(root).find((n) => n.tagName === 'P' && textOf(n) === CONNECT_UNKNOWN_HINT);
  assert.ok(hint, 'подсказка есть в форме');
  const sel = walk(root).find((n) => n.tagName === 'SELECT' && walk(n).some((o) => o.tagName === 'OPTION' && o.value === 'mindray-bc-780'));
  sel.value = 'mindray-bc-780';
  sel.dispatchEvent({ type: 'change', target: sel });
  assert.notStrictEqual(hint.style.display, 'none', 'BC-780 — подсказка видна');
  sel.value = 'mindray-bs-200';
  sel.dispatchEvent({ type: 'change', target: sel });
  assert.strictEqual(hint.style.display, 'none', 'BS-200 звонит сам — подсказки нет');
});

// ── лоток: «Идёт приём результатов» ──────────────────────────────────────────────────────
const PREFIX = 'серия: ждём остальные строки — ';
const msg = (id, status, minAgo, detail, extra = {}) => ({ id, device_id: 1, peer: '10.0.0.40', raw: 'MSH|^~\\&|Mindray|BS-200E', sample_id: 'LAB-' + String(id).padStart(6, '0'),
  visit_service_id: null, status, detail, received_at: iso(Date.now() - minAgo * 60000), resolved_at: null, kind: 'result', ...extra });
const trayCard = (root) => walk(root).find((n) => String(n.className).split(/\s+/).includes('card')
  && walk(n).some((c) => c.tagName === 'H3' && textOf(c) === 'Необработанные'));

test('лоток: серия, которая ещё идёт, — приглушённой группой «Идёт приём результатов» и не в счёт «Необработанных»; не дошла за час — «серия не дошла до конца»', async () => {
  reset();
  MESSAGES = [
    msg(50, 'unmapped', 5, PREFIX + 'не пришли: Креатинин (3)'),
    msg(51, 'unmapped', 90, PREFIX + 'не пришли: Мочевина (2)'),
    msg(52, 'unmatched', 2, 'заказ по номеру пробы не найден'),
  ];
  const root = await mount();
  const card = trayCard(root);
  const text = textOf(card);
  assert.ok(text.includes('ждут разбора: 2'), 'идущая серия не считается: ' + text.slice(0, 200));
  assert.ok(text.includes('Идёт приём результатов'));
  assert.ok(text.includes('Анализатор присылает тесты по одному: строка ждёт остальные результаты бланка до 60 минут.'));
  const going = trWith(card, 'LAB-000050');
  assert.ok(textOf(going).includes('не пришли: Креатинин (3)'));
  assert.ok(!findButtons(going).some((b) => label(b) === 'Привязать'), 'идущий приём — не беда: кнопок разбора нет');
  const stale = trWith(card, 'LAB-000051');
  assert.ok(textOf(stale).includes('серия не дошла до конца: не пришли: Мочевина (2)'), textOf(stale));
  assert.ok(findButtons(stale).some((b) => label(b) === 'Привязать'), 'не дошедшая серия — обычная строка лотка');
  assert.ok(!text.includes(PREFIX.trim()), 'слово «ждём» экран не показывает');
});

test('лоток: только идущий приём — «Все результаты разложены» не говорим, в шапке — «идёт приём»', async () => {
  reset();
  MESSAGES = [msg(50, 'unmapped', 5, PREFIX + 'не пришли: Креатинин (3)')];
  const text = textOf(trayCard(await mount()));
  assert.ok(!text.includes('Все результаты разложены по бланкам.'), text);
  assert.ok(text.includes('идёт приём: 1'), text);
});

// Ревью E9: метки лотка и звонков ставит СЕРВЕР, а часы лабораторного ПК могут
// отставать. По часам браузера серия, просроченная по серверу, выглядела бы
// «из будущего» — и пряталась бы в «Идёт приём результатов», пока длится
// разница. Экран меряет время часами сервера (lis_listeners.now).
test('часы компьютера отстают от сервера на 2 часа: серия судится по часам сервера, звонок — тоже', async () => {
  reset();
  const H2 = 2 * 3600e3;
  const server = (ms) => iso(Date.now() + H2 + ms);   // метка по часам сервера
  LISTENERS = { listening: [2575], failed: [], now: server(0), dialing: [
    connected({ since: server(-60000), last_rx_at: server(-2000) }),
    waitingRefused({ since: server(-1000), retry_at: server(30000) }),
  ] };
  MESSAGES = [
    msg(70, 'unmapped', 0, PREFIX + 'не пришли: Креатинин (102)', { received_at: server(-61 * 60000), sample_id: 'LAB-000070' }),
    msg(71, 'unmapped', 0, PREFIX + 'не пришли: Мочевина (3)', { received_at: server(-5 * 60000), sample_id: 'LAB-000071' }),
  ];
  RECENT = [{ id: 71, received_at: server(-5 * 60000), device_id: 1, device_name: 'BS-200', sample_id: 'LAB-000071', visit_service_id: 71,
    patient_name: 'Иванов Иван', service_name: 'Биохимия', status: 'unmapped', detail: PREFIX + 'не пришли: Мочевина (3)', resolved_at: null, values: [] }];
  const root = await mount();
  const card = trayCard(root);
  const expired = trWith(card, 'LAB-000070');
  assert.ok(textOf(expired).includes('серия не дошла до конца: не пришли: Креатинин (102)'), 'просрочена по серверу — в лотке: ' + textOf(expired));
  assert.ok(findButtons(expired).some((b) => label(b) === 'Привязать'));
  assert.ok(textOf(card).includes('ждут разбора: 1'), textOf(card).slice(0, 200));
  const going = trWith(card, 'LAB-000071');
  assert.ok(!findButtons(going).some((b) => label(b) === 'Привязать'), 'свежая по серверу — ещё идёт');
  assert.match(textOf(rowNamed(root, 'Гематология')), /сигнал [23] с назад/, 'сигнал — по часам сервера, а не «0 с»');
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  assert.match(textOf(rowNamed(root, 'Второй BC-780')), /повтор через (29|30) с/, 'повтор — по часам сервера, а не через 2 часа');
  const live = walk(root).find((n) => String(n.className).split(/\s+/).includes('card')
    && walk(n).some((c) => c.tagName === 'H3' && textOf(c) === 'Последние результаты'));
  assert.ok(textOf(trWith(live, 'LAB-000071')).includes('идёт приём'), 'лента — тоже по часам сервера');
});

test('«Идёт приём результатов»: сообщения одной пробы — одной строкой, с тем, чего ещё не хватает сейчас', async () => {
  reset();
  // Сервер отдаёт лоток от новых к старым; ранняя строка серии говорит про
  // то, чего не хватало ТОГДА, — показывать её рядом значило бы противоречить себе.
  MESSAGES = [
    msg(61, 'unmapped', 1, PREFIX + 'не пришли: Креатинин (102)', { sample_id: 'LAB-000123', visit_service_id: 123 }),
    msg(60, 'unmapped', 2, PREFIX + 'не пришли: Мочевина (3), Креатинин (102)', { sample_id: 'LAB-000123', visit_service_id: 123 }),
    msg(62, 'unmapped', 3, PREFIX + 'не пришли: Глюкоза (2)', { sample_id: 'LAB-000124', visit_service_id: 124 }),
  ];
  const card = trayCard(await mount());
  const rows = walk(card).filter((n) => n.tagName === 'TR' && textOf(n).includes('LAB-000123'));
  assert.strictEqual(rows.length, 1, 'одна проба — одна строка');
  assert.ok(textOf(rows[0]).includes('не пришли: Креатинин (102)'), textOf(rows[0]));
  assert.ok(!textOf(rows[0]).includes('Мочевина'), 'устаревшее «не пришли» не показано');
  assert.ok(textOf(rows[0]).includes('сообщений: 2'));
  assert.ok(!textOf(trWith(card, 'LAB-000124')).includes('сообщений:'), 'одно сообщение — без счёта');
  assert.ok(textOf(card).includes('идёт приём: 2'), 'в шапке — сколько проб ещё принимается');
});

// LIS_REAL_ANALYZERS_V1 (ревью R1, п. 10) — сервер принимает номер заказа и
// этикеткой целиком: «LAB-000123». Экран больше не отказывает «Нужен номер заказа».
test('«Привязать»: номер заказа можно вписать этикеткой целиком — LAB-000123', async () => {
  reset();
  MESSAGES = [msg(52, 'unmatched', 2, 'заказ по номеру пробы не найден')];
  const prev = window.prompt;
  try {
    for (const [typed, expected] of [['LAB-000123', 123], [' lab-000077 ', 77], ['124', 124]]) {
      window.prompt = () => typed;
      const root = await mount();
      findButtons(trWith(root, 'LAB-000052')).find((b) => label(b) === 'Привязать').click();
      await tick(60);
      const call = rpcCalls.find((c) => c.name === 'lis_message_attach');
      assert.deepStrictEqual(call && call.args, { id: 52, visit_service_id: expected }, typed);
    }
    window.prompt = () => 'LAB-12x';
    const root = await mount();
    findButtons(trWith(root, 'LAB-000052')).find((b) => label(b) === 'Привязать').click();
    await tick(60);
    assert.ok(!rpcCalls.some((c) => c.name === 'lis_message_attach'), 'не номер — серверу не шлём');
    assert.strictEqual(toastMsg, 'Нужен номер заказа');
  } finally { window.prompt = prev; }
});

// ── живая лента: серия одной строкой ─────────────────────────────────────────
test('живая лента: сообщения одной серии — одна строка «сообщений: N»; идёт — «идёт приём»', async () => {
  reset();
  const r = (id, minAgo, extra = {}) => ({ id, received_at: iso(Date.now() - minAgo * 60000), device_id: 1, device_name: 'BS-200', sample_id: 'LAB-000123',
    visit_service_id: 123, patient_name: 'Иванов Иван', service_name: 'Биохимия', status: 'applied', detail: '', resolved_at: null,
    values: [{ parameter: 'Глюкоза', value: '5', unit: 'ммоль/л' }], ...extra });
  RECENT = [r(3, 1, { status: 'unmapped', detail: PREFIX + 'не пришли: Креатинин (3)' }), r(2, 2), r(1, 3),
    { ...r(9, 4), visit_service_id: 124, sample_id: 'LAB-000124', patient_name: 'Каримова Азиза' }];
  const root = await mount();
  const live = walk(root).find((n) => String(n.className).split(/\s+/).includes('card')
    && walk(n).some((c) => c.tagName === 'H3' && textOf(c) === 'Последние результаты'));
  const rows = walk(live).filter((n) => n.tagName === 'TR' && textOf(n).includes('LAB-000123'));
  assert.strictEqual(rows.length, 1, 'серия — одной строкой');
  assert.ok(textOf(rows[0]).includes('сообщений: 3'), textOf(rows[0]));
  assert.ok(textOf(rows[0]).includes('идёт приём'));
  const single = trWith(live, 'LAB-000124');
  assert.ok(!textOf(single).includes('сообщений:'), 'одиночная проба — как прежде');
  assert.ok(textOf(single).includes('Применено'));
});

// ── инструкция «Как подключить анализатор» ───────────────────────────────────
const GUIDE = {
  head: 'Прибор с сетевым разъёмом (BC-20, BC-5300, BC-780, BS-200, BS-240, CL-900i, AutoLumo A1000)',
  oneWay: 'Передача — в одну сторону: прибор только отправляет результаты. Запрос заказов из LIS (рабочий список, «загрузка из LIS») выключите — Easy-Med заказов не отдаёт.',
  firewall: 'Прибор не появляется, хотя адрес и порт верны? На компьютере с Easy-Med разрешите входящий TCP-порт 2575 в брандмауэре Windows — это делается с правами администратора.',
  bs200: 'Mindray BS-200 — связь с LIS настраивается в программе прибора на его компьютере: адрес этого компьютера, порт 2575. Номер пробирки прибор передаёт из поля «Штрихкод» (Barcode): сканируйте этикетку LAB-… или впишите её номер в это поле, а не в «Номер пробы» (Sample ID) — это место в штативе, Easy-Med его не читает. Тесты приходят по одному: пока проба не пришла целиком, она видна в «Необработанные» → «Идёт приём результатов».',
  bc780: 'Mindray BC-780 — если в настройках LIS прибора есть адрес сервера, укажите адрес этого компьютера и порт 2575: прибор позвонит сам. Если есть только «порт прибора» — прибор ждёт звонка: «Добавить по адресу», впишите IP-адрес и порт прибора и отметьте «Easy-Med подключается к прибору сам».',
  a1000: 'Autobio AutoLumo A1000 — лучше по сети: связь с LIS по TCP/IP, протокол HL7, тип порта «As client», адрес этого компьютера и порт 2575, приоритет LIS «только локальный» (2), «Get from LIS…» выключите. Если сетевой разъём занят — кабелем COM через переадресатор (FORWARD-AutoLumo-A1000.bat), на приборе протокол ASTM.',
  com: 'Прибор, подключённый к компьютеру только кабелем COM (BC-2800, BC-3000 Plus и другие)',
  verify: 'Первую пробу каждого нового прибора сверьте построчно с распечаткой прибора: BS-200 сделан по руководству производителя, AutoLumo A1000 — по рабочим программам других LIS, BC-780 — по документам соседних моделей.',
  service: 'Контроль качества, калибровка и запросы заказов в бланки и «Необработанные» не идут — их число за сегодня видно у прибора в таблице.',
};

test('инструкция: три новые модели, передача в одну сторону, брандмауэр 2575, BS-200 — поле «Штрихкод»; устаревшего нет', async () => {
  reset();
  DEVICES = [BS];
  const text = textOf(await mount());
  for (const [k, s] of Object.entries(GUIDE)) assert.ok(text.includes(s), k + ': ' + s);
  assert.ok(!text.includes('Прибор с сетевым разъёмом (BC-20, BC-5300, BS-240, CL-900i)'), 'старый заголовок без новых моделей');
  assert.ok(!text.includes('(BC-2800, BC-3000 Plus, AutoLumo A1000 и другие)'), 'A1000 больше не «только кабелем COM»');
  assert.ok(!text.includes('пока не поддерживаются'));
});

test('инструкция и подсказки на uz/en называют экраны и флажок их подписями на этом языке', () => {
  const byAddress = (lang) => STRINGS['Анализатор не появился? Добавить по адресу'][lang].split('? ')[1];
  const flag = (lang) => STRINGS[DIAL_LABEL][lang];
  const quoted = {
    [GUIDE.bs200]: (lang) => [STRINGS['Необработанные'][lang], STRINGS['Идёт приём результатов'][lang]],
    [GUIDE.bc780]: (lang) => [byAddress(lang), flag(lang)],
    [GUIDE.service]: (lang) => [STRINGS['Необработанные'][lang]],
    [DIAL_ADD_HINT]: (lang) => [byAddress(lang), flag(lang)],
    [CONNECT_UNKNOWN_HINT]: (lang) => [flag(lang)],
  };
  for (const lang of ['en', 'uz']) {
    for (const [key, labels] of Object.entries(quoted)) {
      assert.ok(STRINGS[key], 'в словаре: ' + key);
      for (const l of labels(lang)) {
        assert.ok(l && STRINGS[key][lang].includes('«' + l + '»'), `${lang}: «${l}» — ${STRINGS[key][lang]}`);
      }
    }
  }
});
