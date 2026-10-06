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
    if (body && body.op && body.op !== 'select') {
      writes.push(body);
      // Новая строка прибора — номер 77 (вставка с returning, как у сервера).
      const data = body.table === 'lab_devices' && body.op === 'insert' && body.returning ? [{ id: 77 }] : [];
      return { ok: true, json: async () => ({ data }) };
    }
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

// ── D2: «Добавить» прибор — только с моделью или «Другой анализатор (общий HL7)» ──
// BS-240, CL-900i и A1000 оставляют MSH-3/4 пустыми, и находка приходит без
// модели. Без модели Easy-Med читает общим правилом (номер пробы — OBR-3), а у
// BS-240 и CL-900i там номер прогона прибора: результат лёг бы не тому пациенту.
const MODEL_REQUIRED = 'Выберите модель анализатора: без неё Easy-Med прочитает не те поля. Нет в списке — выберите «Другой анализатор (общий HL7)».';
const GENERIC_LABEL = 'Другой анализатор (общий HL7)';
const FOUND_BLANK = { id: 9, name: 'Анализатор 192.168.1.60', profile: '', transport: 'mllp', host: '192.168.1.60', port: 2575, enabled: 1,
  added: 0, discovered: 1, model_confirmed: 0, dial: 0, sending_app: '', last_seen_at: iso(Date.now() - 60000) };
const rowNamed = (root, name) => walk(root).find((n) => n.tagName === 'TR' && n.children[0] && textOf(n.children[0]) === name);
const optionsOf = (sel) => walk(sel).filter((n) => n.tagName === 'OPTION');
const selectedValues = (sel) => optionsOf(sel).filter((o) => 'selected' in o.attrs).map((o) => o.value);
const modelSelectIn = (root) => walk(root).find((n) => n.tagName === 'SELECT' && optionsOf(n).some((o) => o.value === 'mindray-bs-240' || o.value === ''));
const adoptCalls = () => rpcCalls.filter((c) => c.name === 'lis_device_add').map((c) => c.args);

async function openAdoptOf(device) {
  reset();
  DEVICES = [BS, device];
  const root = await mount();
  await openAddWindow(root);
  findButtonByText(rowNamed(root, device.sending_app || device.name), /Добавить/).click();
  await tick();
  return root;
}
async function pressAdd(root) {
  formButton(root, /^Добавить$/).click();
  await tick(60);
}

test('D2: находка без модели — в списке есть «Другой анализатор (общий HL7)»; «Добавить» без выбора не уходит на сервер', async () => {
  const root = await openAdoptOf(FOUND_BLANK);
  const sel = modelSelectIn(root);
  assert.ok(sel, 'список моделей в форме');
  const opts = optionsOf(sel);
  assert.strictEqual(opts[0].value, '', 'первый пункт — «выберите модель»');
  assert.deepStrictEqual(selectedValues(sel), [''], 'модель не подставлена сама');
  const generic = opts[opts.length - 1];
  assert.strictEqual(textOf(generic), GENERIC_LABEL, 'явный выбор для прибора не из списка — последним');
  assert.ok(textOf(root).includes('Модель по имени прибора не определилась — выберите её сами.'), textOf(root));
  sel.value = '';
  await pressAdd(root);
  assert.strictEqual(toastMsg, MODEL_REQUIRED);
  assert.strictEqual(toastEl.dataset.kind, 'warn');
  assert.deepStrictEqual(adoptCalls(), [], 'на сервер ничего не ушло');
  assert.ok(!writes.some((w) => w.table === 'lab_devices'), '/api/db не пишется: ' + JSON.stringify(writes));
  assert.ok(formButton(root, /^Добавить$/), 'форма осталась на экране');
});

test('D2: выбрана модель — lis_device_add с моделью; «Другой анализатор (общий HL7)» — generic: true; /api/db не пишется', async () => {
  let root = await openAdoptOf(FOUND_BLANK);
  modelSelectIn(root).value = 'mindray-bs-240';
  await pressAdd(root);
  assert.deepStrictEqual(adoptCalls(), [{ id: 9, name: 'Анализатор 192.168.1.60', profile: 'mindray-bs-240' }]);
  assert.strictEqual(toastMsg, 'Прибор «Анализатор 192.168.1.60» добавлен');
  assert.ok(!writes.some((w) => w.table === 'lab_devices'), JSON.stringify(writes));

  root = await openAdoptOf(FOUND_BLANK);
  const sel = modelSelectIn(root);
  sel.value = optionsOf(sel).find((o) => textOf(o) === GENERIC_LABEL).value;
  await pressAdd(root);
  assert.deepStrictEqual(adoptCalls(), [{ id: 9, name: 'Анализатор 192.168.1.60', generic: true }]);
});

test('D2: отказ сервера — «нужна модель» своими словами, «уже добавлен» — его словами, список перечитан', async () => {
  let root = await openAdoptOf(FOUND_BLANK);
  ADD_REPLY = { code: 'model_required', message: MODEL_REQUIRED };
  modelSelectIn(root).value = 'mindray-bs-240';
  await pressAdd(root);
  assert.strictEqual(toastMsg, MODEL_REQUIRED);
  assert.strictEqual(toastEl.dataset.kind, 'warn');

  root = await openAdoptOf(FOUND_BLANK);
  ADD_REPLY = { code: 'already_added', message: 'Прибор уже добавлен — меняйте его через «Изменить».' };
  modelSelectIn(root).value = 'mindray-bs-240';
  const reads = () => rpcCalls.filter((c) => c.name === 'lis_profiles').length;
  const before = reads();
  await pressAdd(root);
  assert.strictEqual(toastMsg, 'Прибор уже добавлен — меняйте его через «Изменить».');
  assert.ok(reads() > before, 'список перечитан');
});

test('D2: таблица — у добавленного с явным выбором «Другой анализатор (общий HL7)», без пометки «проверьте модель»', async () => {
  reset();
  DEVICES = [{ ...FOUND_BLANK, added: 1, model_confirmed: 1 }];
  const root = await mount();
  const card = textOf(devicesCard(root));
  assert.ok(card.includes(GENERIC_LABEL), card);
  assert.ok(!card.includes('найден сам — проверьте модель'));
  assert.ok(!card.includes('модель не выбрана'));
});

// «Добавить по адресу»: раньше новый прибор начинал с первой модели списка
// (Mindray BC-20) — BS-240, добавленный по адресу без правки модели, читался бы
// как гематология. Теперь модель выбирают явно.
async function newDeviceForm() {
  reset();
  const root = await mount();
  await openAddWindow(root);
  findButtonByText(root, /Добавить по адресу/).click();
  await tick();
  return root;
}
const inputByPlaceholder = (root, ph) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === ph);

test('D2: «Добавить по адресу» — модель не подставлена; без выбора — предупреждение, в базу ничего', async () => {
  const root = await newDeviceForm();
  const sel = modelSelectIn(root);
  assert.deepStrictEqual(selectedValues(sel), [''], 'первая модель списка больше не подставляется сама');
  assert.strictEqual(textOf(optionsOf(sel)[0]), '— выберите модель —');
  assert.ok(optionsOf(sel).some((o) => textOf(o) === GENERIC_LABEL));
  inputByPlaceholder(root, 'Например: Гематология').value = 'Биохимия';
  inputByPlaceholder(root, 'адрес анализатора в сети, например 10.0.0.20').value = '192.168.1.60';
  sel.value = '';
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  assert.strictEqual(toastMsg, MODEL_REQUIRED);
  assert.ok(!writes.some((w) => w.table === 'lab_devices'), JSON.stringify(writes));
});

test('D2: «Добавить по адресу» с «Другой анализатор (общий HL7)» — запись без модели, выбор запомнен', async () => {
  const root = await newDeviceForm();
  const sel = modelSelectIn(root);
  inputByPlaceholder(root, 'Например: Гематология').value = 'Иммунология';
  inputByPlaceholder(root, 'адрес анализатора в сети, например 10.0.0.20').value = '192.168.1.61';
  sel.value = optionsOf(sel).find((o) => textOf(o) === GENERIC_LABEL).value;
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  const ins = writes.find((w) => w.table === 'lab_devices' && w.op === 'insert');
  assert.ok(ins, JSON.stringify(writes) + ' ' + toastMsg);
  assert.strictEqual([].concat(ins.values)[0].profile, '', 'модель пустая — общий HL7');
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd && upd.values.model_confirmed === 1 && JSON.stringify(upd.filters).includes('77'), 'выбор «общего HL7» запомнен у новой строки: ' + JSON.stringify(writes));
});

test('D2: «Изменить» прибора с «общим HL7» — выбран «Другой анализатор»; сохранение выбор оставляет', async () => {
  reset();
  DEVICES = [{ ...FOUND_BLANK, name: 'Иммунология', added: 1, model_confirmed: 1 }];
  const root = await mount();
  findButtonByText(rowNamed(root, 'Иммунология'), /Изменить/).click();
  await tick();
  const sel = modelSelectIn(root);
  const generic = optionsOf(sel).find((o) => textOf(o) === GENERIC_LABEL);
  assert.deepStrictEqual(selectedValues(sel), [generic.value]);
  sel.value = generic.value;   // тестовый DOM не выводит value списка из selected-пункта (ревью M10)
  walk(root).find((n) => n.tagName === 'SELECT' && optionsOf(n).some((o) => o.value === 'mllp')).value = 'mllp';
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, JSON.stringify(writes) + ' ' + toastMsg);
  assert.strictEqual(upd.values.profile, '');
  assert.strictEqual(upd.values.model_confirmed, 1);
});

test('D2: строки экрана — в словаре на uz и en', () => {
  for (const k of [GENERIC_LABEL, MODEL_REQUIRED, '— выберите модель —']) {
    assert.ok(STRINGS[k], 'в словаре: ' + k);
    for (const lang of ['en', 'uz']) assert.ok(STRINGS[k][lang] && STRINGS[k][lang] !== k, lang + ': ' + k);
  }
  // Подпись выбора цитируется в отказе её же переводом.
  for (const lang of ['en', 'uz']) assert.ok(STRINGS[MODEL_REQUIRED][lang].includes('«' + STRINGS[GENERIC_LABEL][lang] + '»'), lang);
});

// ── D10: непрочитанные буквы (U+FFFD) — в лотке сказано, что коды должны быть латиницей ──
// BS-200 отдаёт «Код на ЛИС» в кодировке своего компьютера; кириллица, прочитанная
// не той кодировкой, — знаки U+FFFD. Такой код «Поле анализатора» больше не
// предлагает (rpc/lis.js), и лоток объясняет, что поправить на приборе.
const UNREADABLE_NOTE = 'Часть букв в сообщении не прочиталась — задайте на анализаторе коды тестов латиницей (например, GLU, ALT).';
const BAD = String.fromCharCode(0xFFFD);
const trayMsg = (id, raw) => ({ id, device_id: 1, peer: '10.0.0.40', raw, sample_id: 'LAB-000123', visit_service_id: 123,
  status: 'unmapped', detail: 'не сопоставлено: ' + BAD + BAD + BAD, received_at: iso(Date.now() - 2 * 3600000), resolved_at: null, kind: 'result' });
const BS200_RAW = (code) => ['MSH|^~\\&|Mindray|BS-200|||20261005101500||ORU^R01|17|P|2.3.1||||0||ASCII|||',
  'OBR|1|LAB-000123|12|Mindray^BS-200|N||20261005101200',
  'OBX|1|NM|' + code + '|Glucose|5.230000|mmol/L|3.900000-6.100000|N|||F|||20261005101200'].join('\r');
const trayRow = (root, id) => walk(cardWithTitle(root, 'Необработанные')).filter((n) => n.tagName === 'TR')
  .find((r) => walk(r).some((b) => b.tagName === 'BUTTON' && label(b) === 'Сырое') && textOf(r).includes('#' + id + '#'));

test('D10: в лотке — сообщение с непрочитанными буквами: коды тестов на анализаторе — латиницей; обычное — без строки', async () => {
  reset();
  MESSAGES = [
    { ...trayMsg(1, BS200_RAW(BAD + BAD + BAD)), sample_id: '#1#' },
    { ...trayMsg(2, BS200_RAW('GLU')), sample_id: '#2#', detail: 'не сопоставлено: GLU' },
  ];
  const root = await mount();
  const tray = cardWithTitle(root, 'Необработанные');
  assert.ok(tray, 'лоток на экране');
  assert.ok(textOf(trayRow(root, 1)).includes(UNREADABLE_NOTE), textOf(tray));
  assert.ok(!textOf(trayRow(root, 2)).includes(UNREADABLE_NOTE), 'у сообщения без U+FFFD строки нет');
  assert.ok(STRINGS[UNREADABLE_NOTE] && STRINGS[UNREADABLE_NOTE].en && STRINGS[UNREADABLE_NOTE].uz, 'в словаре на uz и en');
});

// ── D12: инструкция «Как подключить анализатор» — по каждой модели ──────────
// Слова экранов самих приборов — из русских руководств (analyzer-research,
// notes/ui-labels-ru.md, REPORT.md часть B); A1000 — английские экраны его
// программы 1.0.7 (autobio-autolumo-a1000.settle.md).
const NEW_GUIDE = {
  intro: 'Почти все анализаторы сами отправляют результаты на компьютер с Easy-Med: после первой пробы прибор появится в «Добавить прибор» → «Найдены в сети». Mindray BC-20 — наоборот: к нему подключается Easy-Med (см. ниже).',
  head: 'Прибор, который сам отправляет результаты (BC-5300, BS-200, BS-240, CL-900i, AutoLumo A1000)',
  cable: 'Подключите прибор — или компьютер, на котором работает его программа, — сетевым кабелем к той же сети, где стоит компьютер с Easy-Med.',
  where: 'В настройках связи с LIS на приборе (у каждой модели путь свой — ниже) укажите: адрес компьютера с Easy-Med — адрес этого компьютера в сети, порт — 2575, протокол — HL7.',
  firstSample: 'Прогоните одну пробу. Прибор появится в «Добавить прибор» → «Найдены в сети»: нажмите «Добавить» и выберите модель, затем в «Панелях» выберите его у панели и подтвердите поля.',
  models: 'Настройка на приборе — по моделям',
  bc20: 'Mindray BC-20 — к нему подключается Easy-Med: поля для адреса Easy-Med у BC-20 нет. На приборе: «Меню» → «Установка» → «Устан.системы» → «Обмен данными»: «Связь:сетевой порт», его собственный «IP-адрес», «Протокол связи» — HL7, отметьте «Автосвязь». В Easy-Med: «Добавить прибор» → «Добавить по адресу», модель Mindray BC-20, отметьте «Easy-Med подключается к прибору сам», адрес — IP-адрес самого BC-20, порт — 5100.',
  bc5300: 'Mindray BC-5300 — «Меню» → «Установка» → «Общая настройка» → «Связь»: «IP-адрес» — адрес компьютера с Easy-Med, «Порт» — 2575, «Авт.дан» — «Вкл», затем «Применить». Компьютеру BC-5300 нужна вторая сетевая карта в сети клиники: первая соединяет его с анализатором — её не трогайте.',
  bs200: 'Mindray BS-200 — в программе прибора на его компьютере: «Настройка» → «Система» → «ЛИС»: отметьте «Разрешение ЛИС», «IP хоста ЛИС» — адрес компьютера с Easy-Med, «Порт» — 2575, отметьте «Отпр.рез.после обр.каждой пробы». В «Согласование тестов» → «Код на ЛИС» дайте каждому тесту свой код латиницей (GLU, UREA, ALT…): тест без кода прибор не отправляет. Нажмите «OK», затем «Подключение». Номер пробирки — в поле «Штрих-код» на экране «Запрос пробы». Тесты приходят по одному: пока проба не пришла целиком, она видна в «Необработанные» → «Идёт приём результатов».',
  bs240cl: 'Mindray BS-240 и CL-900i — «Утилита» → «Устан.системы» → «Хост F5» → «Параметры связи с хостом»: «Перенести» — TCP/IP, «IP-адрес» — адрес компьютера с Easy-Med, «Порт» — 2575, «Протокол» — HL7, «Режим» — «Однонаправленный»; отметьте «Автосоединение с ЛИС» и «Отправить завершенные пробы». В таблице каналов («№ канала», у CL-900i — «№ стандарт. канала») дайте каждому тесту свой код латиницей. Нажмите «Сохр.», затем «Подключено» — это кнопка подключения. Номер пробирки — сканером или в поле «Штрихкод», а не в «ИД»: «ИД» — номер прогона прибора.',
  a1000: 'Autobio AutoLumo A1000 (программа 1.0.7, экраны на английском) — System configure → LIS settings: LIS interface — Off, Result type — «Send all test results», Sending mode — «By test», Communication type — LAN, Protocol type — HL7, Socket Type — «As client», Address — адрес компьютера с Easy-Med, Port — 2575, Encoding type — UTF-8. Нажмите Save F2, откройте LIS settings снова и проверьте, что Result type не сбросился в Off. Компьютеру A1000 нужна вторая сетевая карта в сети клиники: первая (192.168.253.x) соединяет его с анализатором.',
  every: 'Для всех анализаторов',
  label: 'Сканируйте этикетку Easy-Med LAB-… в поле номера пробирки на приборе и не давайте прибору нумеровать пробы самому.',
  qc: 'Пробам контроля качества давайте номера с буквами (QC1, QC-AFP-1): такой номер не совпадёт с заказом пациента.',
  keyboard: 'Пока сканируете, раскладка клавиатуры — английская: на русской сканер напечатает «ДФИ-000123» вместо LAB-000123.',
  model: 'Добавляя прибор, всегда выбирайте модель — без неё Easy-Med прочитает не те поля. Нет в списке — «Другой анализатор (общий HL7)».',
  com: 'Такой прибор не умеет отправлять по сети — за него это делает переадресатор на том же компьютере. Папку «analyzers» выдаёт разработчик: скопируйте её целиком на лабораторный компьютер и запустите файл своей модели — например, FORWARD-BC-2800.bat. При первом запуске он спросит COM-порт, скорость и адрес этого компьютера с Easy-Med. Дальше результаты приходят сюда так же, как с сетевого прибора.',
  noForwarder: 'BS-200 и AutoLumo A1000 переадресатор не нужен: их кабель COM соединяет анализатор с его собственной программой, а результаты программа отправляет по сети. На их компьютерах переадресатор только отнимет порт у программы прибора — уберите его.',
};
const GONE = {
  qcFalse: 'Контроль качества, калибровка и запросы заказов в бланки и «Необработанные» не идут — их число за сегодня видно у прибора в таблице.',
  oldA1000: 'приоритет LIS «только локальный» (2)',
  a1000Forwarder: 'FORWARD-AutoLumo-A1000.bat',
  oldHematologyPath: 'Настройка → Системные настройки → Связь (Setup → System Setup → Communication)',
  bc20InPort2575List: 'Прибор с сетевым разъёмом (BC-20,',
  oldBs200SampleId: 'это место в штативе',
};
const guideCard = (root) => cardWithTitle(root, 'Как подключить анализатор');

test('D12: инструкция — по каждой модели, словами экранов приборов; общие правила; ложного и устаревшего нет', async () => {
  reset();
  const root = await mount();
  const text = textOf(guideCard(root));
  for (const [k, s] of Object.entries(NEW_GUIDE)) assert.ok(text.includes(s), k + ': ' + s);
  for (const [k, s] of Object.entries(GONE)) assert.ok(!text.includes(s), 'убрано — ' + k + ': ' + s);
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), 'без эмодзи');
});

// LIS_VENDOR_EXACT_V1 (D12, ревью) — шаги REPORT.md, часть B, без которых
// результаты не доходят или ложатся не туда, и которых в инструкции не было:
// BC-20 — «Ввод вручную» номера пробы, «ID пробы», запасные порты (B1);
// BC-5300 — «Администратор», «Подтверждение связи», «Способ ввода» (B2);
// BS-200 — «Подключение к ЛИС при запуске», Easy-Med раньше программы (B4);
// BS-240 и CL-900i — «Повтор после отключения», «Отправить незавершенные пробы»
// (B5, B6.5); CL-900i — вторая сетевая карта (B6.1); диапазоны клиники (B6.8 —
// у A1000 диапазона нет тоже); единицы BS-240 — в панели (B5.5). Слова экранов —
// notes/ui-labels-ru.md, mindray-bs-200.addendum.md (Text120.dll).
const MORE_GUIDE = {
  bc20Next: 'Mindray BC-20 — «Установка» → «Вспомог.установка» → «Настройка следующей пробы»: «Ввод следующего ID пробы» — «Ввод вручную», а не «Автоприращение». Этикетку сканируйте в «ID пробы», а не в «ID пациента». Порт 5100 не отвечает — попробуйте 3600 и 5000.',
  bc5300Admin: 'Mindray BC-5300 — войдите как «Администратор». В «Связь» поставьте и «Подтверждение связи» — «Вкл» (если прибор сообщает о сбое связи, а проба в Easy-Med пришла, — «Выкл»). В «Общая настройка» → «Вспомогательный» → «Код пробы» → «Способ ввода» выберите «Ввод вручную»: при «Автоувеличение» прибор нумерует пробы сам, и номер может совпасть с заказом другого пациента.',
  bs200Start: 'Mindray BS-200 — отметьте и «Подключение к ЛИС при запуске», а Easy-Med запускайте раньше программы прибора. Появилось «Не удается подкл. главный компьютер LIS» — нажмите «Подключение».',
  bs240clRetry: 'Mindray BS-240 и CL-900i — в том же окне отметьте «Повтор после отключения» («Интервал» — 30, «Вр.ожид» — 30): без этого после перезапуска или обновления Easy-Med прибор сам не переподключится. «Отправить незавершенные пробы» у CL-900i отметьте, у BS-240 — нет.',
  clCard: 'Mindray CL-900i («ИХЛА 900i») — компьютеру прибора нужна вторая сетевая карта в сети клиники. Первая (192.168.23.3) соединяет его с анализатором — её не трогайте. Адрес второй: «Утилита» → «Устан.системы» → «Аппарат F1» → «3 Устан.связи» → «Связь системы» → «Следующий IP-адрес».',
  ranges: 'Введите диапазоны клиники в каждой строке панели: AutoLumo A1000 диапазона не присылает, а CL-900i у каждого результата пишет «N» — без диапазона любое число выйдет «Норма».',
  bs240Units: 'У BS-240 меняйте единицу в панели Easy-Med, а не на приборе: смена «Ед.изм.» на BS-240 требует повторной калибровки.',
  firstCheck: 'Первую пробу каждого нового прибора сверьте построчно с распечаткой прибора: BS-200 сделан по руководству производителя, AutoLumo A1000 — по программе самого прибора (1.0.7), BC-780 — по документам соседних моделей.',
};

test('D12 (ревью): инструкция — шаги части B, без которых результаты не доходят; A1000 — по программе самого прибора; uz/en — без кириллицы', async () => {
  reset();
  const root = await mount();
  const text = textOf(guideCard(root));
  for (const [k, s] of Object.entries(MORE_GUIDE)) assert.ok(text.includes(s), k + ': ' + s);
  assert.ok(!text.includes('по рабочим программам других LIS'), 'A1000 сверен с программой самого прибора (settle), а не с чужими LIS');
  for (const s of Object.values(MORE_GUIDE)) {
    assert.ok(STRINGS[s], 'в словаре: ' + s);
    for (const lang of ['en', 'uz']) assert.ok(STRINGS[s][lang] && !/[Ѐ-ӿ]/.test(STRINGS[s][lang]), lang + ' без кириллицы: ' + (STRINGS[s][lang] || ''));
  }
  // «Норма» на экране Easy-Med — её подписью на этом языке.
  for (const lang of ['en', 'uz']) assert.ok(STRINGS[MORE_GUIDE.ranges][lang].includes('«' + STRINGS['Норма'][lang] + '»'), lang);
});

test('D12: инструкция на uz/en — без кириллицы, экраны Easy-Med — их подписями на этом языке', () => {
  const byAddress = (lang) => STRINGS['Анализатор не появился? Добавить по адресу'][lang].split('? ')[1];
  const quoted = {
    [NEW_GUIDE.intro]: (lang) => [STRINGS['Добавить прибор'][lang], STRINGS['Найдены в сети'][lang]],
    [NEW_GUIDE.firstSample]: (lang) => [STRINGS['Добавить прибор'][lang], STRINGS['Найдены в сети'][lang], STRINGS['Добавить'][lang], STRINGS['Панели'][lang]],
    [NEW_GUIDE.bc20]: (lang) => [STRINGS['Добавить прибор'][lang], byAddress(lang), STRINGS['Easy-Med подключается к прибору сам'][lang]],
    [NEW_GUIDE.bs200]: (lang) => [STRINGS['Необработанные'][lang], STRINGS['Идёт приём результатов'][lang]],
    [NEW_GUIDE.model]: (lang) => [STRINGS['Другой анализатор (общий HL7)'][lang]],
  };
  // Шаг с адресом — шаблон {ip}: в словаре он, а не собранная фраза.
  const keys = { ...NEW_GUIDE, where: 'В настройках связи с LIS на приборе (у каждой модели путь свой — ниже) укажите: адрес компьютера с Easy-Med — {ip}, порт — 2575, протокол — HL7.' };
  for (const lang of ['en', 'uz']) assert.ok(STRINGS[keys.where] && STRINGS[keys.where][lang].includes('{ip}'), lang + ': {ip}');
  for (const s of Object.values(keys)) {
    assert.ok(STRINGS[s], 'в словаре: ' + s);
    for (const lang of ['en', 'uz']) {
      assert.ok(STRINGS[s][lang] && !/[Ѐ-ӿ]/.test(STRINGS[s][lang]), lang + ' без кириллицы: ' + STRINGS[s][lang]);
      for (const l of (quoted[s] ? quoted[s](lang) : [])) assert.ok(STRINGS[s][lang].includes('«' + l + '»'), `${lang}: «${l}» — ${STRINGS[s][lang]}`);
    }
  }
});
