// LIS_ANALYZER_LIST_V1 (2026-09-29) — Лаборатория → «Анализаторы»: таблица и
// окно «Добавить прибор».
//
// Владелец: «list of the analyzers when adding a dynamic list, which will be
// empty if analyzer not plugged or connected … (which shouldn't be there if
// its not connected)». Таблица — только выходившие на связь; находка ждёт
// одного нажатия «Добавить»; пусто — окно объясняет, как подключить.
import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/lab-panels-mode.test.mjs (itself
// from telephony-settings / system-view / activation tests) because these
// views also render Icon() calls, which go through ui.js's html() -> a
// <template> parse.
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
// I18N_LOCALE_PIN_V1 — i18n.js picks its language ONCE, at module load, from
// this same store's 'admin.lang'. Pinning 'ru' BEFORE the view import is what
// makes the Russian-string assertions hold on an English-locale runner.
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

// A toast node, so ui.js reuses it instead of appending to the fake body. Its
// text is kept OUTSIDE `_t`: toast() stores its dismiss timer in `el._t`, which
// is exactly the field this fake DOM keeps text in.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const findButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findButtons(root).find((b) => re.test(textOf(b)));

// --- fake сервер -----------------------------------------------------------
let DEVICES = [];
let writes = [];
let rpcCalls = [];
// Ревью C2: ответ lis_device_delete. null — удалено; объект — ошибка сервера.
let DELETE_REPLY = null;
// Ревью M6: ответ lis_listeners.
const LISTENING_2575 = { listening: [2575], failed: [] };
let LISTENERS = LISTENING_2575;
const PROFILES = [{ key: 'mindray-bc-5300', vendor: 'Mindray', model: 'BC-5300', channelsSource: 'screenshot', defaultPort: 2575, channels: [] }];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') { writes.push(body); return { ok: true, json: async () => ({ data: [] }) }; }
    if (body && body.table === 'lab_devices') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(DEVICES)) }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') return { ok: true, json: async () => ({ data: PROFILES }) };
    if (name === 'lis_listeners') return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(LISTENERS)) }) };
    if (name === 'lis_restart') return { ok: true, json: async () => ({ data: { ok: true, listeners: 1 } }) };
    if (name === 'lis_device_delete') {
      return DELETE_REPLY
        ? { ok: false, status: 409, json: async () => ({ error: DELETE_REPLY }) }
        : { ok: true, json: async () => ({ data: { ok: true, detached: 3 } }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const HEARD = { id: 1, name: 'kjkj', profile: 'mindray-bc-5300', transport: 'mllp', host: '', port: 2575, enabled: 1, added: 1, discovered: 0, last_seen_at: '2026-09-14T08:02:50Z' };
const FOUND = { id: 5, name: 'BC-5300', profile: 'mindray-bc-5300', transport: 'mllp', host: '127.0.0.1', port: 2575, enabled: 1, added: 0, discovered: 1, last_seen_at: '2026-09-29T08:00:00Z' };
const WAITING = { id: 4, name: 'jjjj', profile: 'mindray-bc-5300', transport: 'mllp', host: '', port: 2575, enabled: 1, added: 1, discovered: 0, last_seen_at: null };

async function mount() {
  writes = []; rpcCalls = []; toastMsg = null;
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();   // живой опрос тесту не нужен
  return root;
}

test('таблица — только добавленные и выходившие на связь; кнопка называет число найденных', async () => {
  DEVICES = [HEARD, FOUND, WAITING];
  const root = await mount();
  const table = walk(root).find((n) => n.tagName === 'TABLE');
  const text = textOf(table);
  // Локатор сужен до ячеек «Название» (первая ячейка строки): колонка «Модель»
  // у kjkj — «Mindray BC-5300», и поиск по всей таблице принимал её за находку «BC-5300».
  const names = walk(table).filter((n) => n.tagName === 'TR').map((r) => r.children[0])
    .filter((c) => c && c.tagName === 'TD').map(textOf).join(' | ');
  assert.ok(text.includes('kjkj'), 'выходивший на связь — в таблице');
  assert.ok(!text.includes('jjjj'), 'ни разу не выходивший — не в таблице');
  assert.ok(!names.includes('BC-5300'), 'находка — не в таблице, пока не нажали «Добавить»');
  assert.ok(findButtonByText(root, /Добавить прибор · найдено 1/), 'кнопка говорит, что есть находка');
});

test('окно «Добавить прибор»: находка с «Добавить», ждущий со строкой о порте, ручной путь', async () => {
  DEVICES = [HEARD, FOUND, WAITING];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const text = textOf(root);
  assert.ok(text.includes('Найдены в сети'));
  assert.ok(text.includes('127.0.0.1'), 'адрес находки виден');
  assert.ok(text.includes('Ждут первого сообщения'));
  assert.ok(text.includes('порт 2575 слушается — ждём первое сообщение'), 'проверка связи с нашей стороны');
  assert.ok(findButtonByText(root, /Анализатор не появился\? Добавить по адресу/), 'ручной путь остаётся');
});

test('«Добавить» у находки переводит её в таблицу: added = 1, признак «найден сам» не трогается', async () => {
  DEVICES = [HEARD, FOUND];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const addRow = findButtons(root).find((b) => /^\s*(<svg[\s\S]*?<\/svg>)?\s*Добавить\s*$/.test(textOf(b)));
  assert.ok(addRow, 'у находки есть кнопка «Добавить»');
  addRow.click();
  await tick();
  const save = findButtons(root).filter((b) => /Добавить/.test(textOf(b))).pop();
  save.click();
  await tick(60);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, 'записано: ' + JSON.stringify(writes));
  assert.strictEqual(upd.values.added, 1);
  // Ревью C1: discovered = 0 для discover.js — «заведён человеком на этот
  // адрес», и после одного «Добавить» всё с того же адреса ложилось бы сюда.
  assert.ok(!('discovered' in upd.values), 'discovered пишет только сервер: ' + JSON.stringify(upd.values));
  assert.strictEqual(upd.values.name, 'BC-5300');
  assert.ok(JSON.stringify(upd.filters || []).includes('5'), 'обновлена именно находка: ' + JSON.stringify(upd.filters));
});

test('ничего не подключено — окно пусто и объясняет, как подключить', async () => {
  DEVICES = [HEARD];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const text = textOf(root);
  assert.ok(text.includes('Ни один анализатор пока не выходил на связь.'));
  assert.ok(text.includes('порт 2575, протокол HL7'), 'сказано, что настроить на приборе');
});

// ── Ревью C2 — «Удалить» идёт через RPC lis_device_delete ───────────────────
// Голый DELETE в /api/db упирался во внешние ключи (мигр. 123): у найденного
// анализатора всегда есть сообщения, и «Удалить» у него не срабатывало ни разу.
const deleteButton = (root) => findButtons(root).find((b) => /^\s*Удалить\s*$/.test(textOf(b)));

test('ревью C2: «Удалить» у находки — через lis_device_delete, а не голым DELETE в /api/db', async () => {
  DEVICES = [HEARD, FOUND];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const del = deleteButton(root);
  assert.ok(del, 'у находки есть «Удалить»');
  del.click();
  await tick(60);
  assert.deepStrictEqual(rpcCalls.filter((c) => c.name === 'lis_device_delete').map((c) => c.args), [{ id: 5 }]);
  assert.ok(!writes.some((w) => w.table === 'lab_devices' && w.op === 'delete'), 'голого DELETE нет: ' + JSON.stringify(writes));
  assert.ok(!rpcCalls.some((c) => c.name === 'lis_restart'), 'слушатели перезапускает сам сервер после удаления');
  assert.strictEqual(toastMsg, 'Прибор удалён');
});

test('ревью C2: прибор привязан к панели — на экране отказ сервера с названиями панелей', async () => {
  DEVICES = [HEARD, FOUND];
  DELETE_REPLY = {
    code: 'device_in_use',
    message: 'Прибор привязан к панелям: «ОАК» — сначала выберите у них другой анализатор.',
    template: 'Прибор привязан к панелям: {panels} — сначала выберите у них другой анализатор.',
    params: { panels: '«ОАК»' },
  };
  try {
    const root = await mount();
    findButtonByText(root, /Добавить прибор/).click();
    await tick();
    deleteButton(root).click();
    await tick(60);
    assert.strictEqual(toastMsg, 'Прибор привязан к панелям: «ОАК» — сначала выберите у них другой анализатор.',
      'отказ — словами сервера, без «Не удалось удалить прибор:» перед ними');
    assert.strictEqual(toastEl.dataset.kind, 'warn');
  } finally { DELETE_REPLY = null; }
});

// ── Ревью M6 — строка о порте своими словами, без сырого текста сервера ─────
test('ревью M6: порт не поднялся — «занят другой программой» или «не слушается», без текста сервера', async () => {
  DEVICES = [HEARD, { ...WAITING, id: 6, name: 'Порт занят', port: 5100 }, { ...WAITING, id: 7, name: 'Порт не поднялся', port: 5200 }];
  LISTENERS = { listening: [2575], failed: [
    { port: 5100, code: 'busy', error: 'LIS: порт 5100 уже занят — вероятно, Easy-Med уже запущен' },
    { port: 5200, code: 'error', error: 'listen EACCES: permission denied 0.0.0.0:5200' },
  ] };
  try {
    const root = await mount();
    findButtonByText(root, /Добавить прибор/).click();
    await tick();
    const text = textOf(root);
    assert.ok(text.includes('порт 5100 занят другой программой'), text);
    assert.ok(text.includes('порт 5200 не слушается'));
    assert.ok(!text.includes('вероятно, Easy-Med уже запущен') && !text.includes('EACCES'), 'сырого текста сервера на экране нет');
  } finally { LISTENERS = LISTENING_2575; }
});

// ── Ревью M5 — строка о порте только у сетевого прибора; выключенный — «выключен»
const rowNamed = (root, name) => walk(root).find((n) => n.tagName === 'TR' && n.children[0] && textOf(n.children[0]) === name);

test('ревью M5: у ждущего кабельного прибора нет строки о порте; выключенный — «выключен», а не «порт слушается»', async () => {
  DEVICES = [HEARD,
    { ...WAITING, id: 8, name: 'Кабельный', transport: 'serial', port: null },
    { ...WAITING, id: 9, name: 'Выключенный', enabled: 0 },
    WAITING];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  const serial = textOf(rowNamed(root, 'Кабельный'));
  assert.ok(!/порт/.test(serial), 'у кабеля COM нет сетевого порта: ' + serial);
  const off = textOf(rowNamed(root, 'Выключенный'));
  assert.ok(off.includes('выключен'), off);
  assert.ok(!off.includes('слушается'), 'порт по умолчанию слушается всегда — выключенному прибору это ничего не обещает: ' + off);
  assert.ok(textOf(rowNamed(root, 'jjjj')).includes('порт 2575 слушается — ждём первое сообщение'), 'сетевой включённый — как прежде');
});
