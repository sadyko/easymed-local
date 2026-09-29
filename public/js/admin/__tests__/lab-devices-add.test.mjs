// LIS_ANALYZER_LIST_V1 (2026-09-29) — Лаборатория → «Анализаторы»: таблица и
// окно «Добавить прибор».
//
// Владелец: «list of the analyzers when adding a dynamic list, which will be
// empty if analyzer not plugged or connected … (which shouldn't be there if
// its not connected)». Таблица — только выходившие на связь; находка ждёт
// одного нажатия «Добавить»; пусто — окно объясняет, как подключить.
import { test, mock } from 'node:test';
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
// Ревью I1: чтение lab_devices отказывает с этим текстом (null — читается).
let DEV_ERROR = null;
// Ревью I2: lis_profiles отказывает.
let PROFILES_FAIL = false;
const PROFILES = [{ key: 'mindray-bc-5300', vendor: 'Mindray', model: 'BC-5300', channelsSource: 'screenshot', defaultPort: 2575, channels: [] }];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') { writes.push(body); return { ok: true, json: async () => ({ data: [] }) }; }
    if (body && body.table === 'lab_devices') {
      if (DEV_ERROR) return { ok: false, status: 500, json: async () => ({ error: { message: DEV_ERROR } }) };
      return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(DEVICES)) }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') {
      if (PROFILES_FAIL) return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } }) };
      return { ok: true, json: async () => ({ data: PROFILES }) };
    }
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
const { STRINGS } = await import('../i18n-strings.js');   // ревью M2 — названия экранов на en/uz
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
  // Ревью M10: тестовый DOM не выводит value списка из selected-пункта, как
  // браузер, — ставим его сами, иначе модель в записи не увидеть.
  const sel = walk(root).find((n) => n.tagName === 'SELECT');
  sel.value = 'mindray-bc-5300';
  const save = findButtons(root).filter((b) => /Добавить/.test(textOf(b))).pop();
  save.click();
  await tick(60);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, 'записано: ' + JSON.stringify(writes));
  assert.strictEqual(upd.values.added, 1);
  assert.strictEqual(upd.values.profile, 'mindray-bc-5300', 'выбранная модель записана');
  assert.strictEqual(upd.values.model_confirmed, 1, 'человек выбрал модель — пометка «проверьте модель» снимается');
  // Ревью C1: discovered = 0 для discover.js — «заведён человеком на этот
  // адрес», и после одного «Добавить» всё с того же адреса ложилось бы сюда.
  assert.ok(!('discovered' in upd.values), 'discovered пишет только сервер: ' + JSON.stringify(upd.values));
  assert.strictEqual(upd.values.name, 'BC-5300');
  assert.ok(JSON.stringify(upd.filters || []).includes('5'), 'обновлена именно находка: ' + JSON.stringify(upd.filters));
});

// Ревью I1: «Ни один анализатор пока не выходил на связь.» стояло всякий раз,
// когда не было НАХОДОК, — и при kjkj в таблице, и когда список приборов вовсе
// не прочитался. Теперь — только когда пусто всё: таблица, находки и ждущие.
async function openAddWindowWith(devices) {
  DEVICES = devices;
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  return textOf(root);
}

test('ничего не подключено — окно пусто и объясняет, как подключить', async () => {
  const text = await openAddWindowWith([]);
  assert.ok(text.includes('Ни один анализатор пока не выходил на связь.'));
  assert.ok(text.includes('порт 2575, протокол HL7'), 'сказано, что настроить на приборе');
});

test('ревью I1: в таблице есть выходивший на связь — «Новых анализаторов пока нет.», а не «ни один не выходил»', async () => {
  const text = await openAddWindowWith([HEARD]);
  assert.ok(text.includes('Новых анализаторов пока нет.'), text);
  assert.ok(!text.includes('Ни один анализатор пока не выходил на связь.'), 'kjkj в таблице — значит, выходил');
  assert.ok(text.includes('порт 2575, протокол HL7'), 'как подключить следующий — та же строка');
});

test('ревью I1: есть только ждущий первого сообщения — тоже «Новых анализаторов пока нет.»', async () => {
  const text = await openAddWindowWith([WAITING]);
  assert.ok(text.includes('Новых анализаторов пока нет.'), text);
  assert.ok(!text.includes('Ни один анализатор пока не выходил на связь.'));
});

// Карточка окна «Добавить прибор» — по её заголовку.
const addWindow = (root) => walk(root).find((n) => String(n.className).split(/\s+/).includes('card')
  && walk(n).some((c) => c.tagName === 'H3' && textOf(c) === 'Добавить анализатор'));

test('ревью I1: список приборов не прочитался — окно говорит об этом, а не «ни один не выходил»', async () => {
  DEV_ERROR = 'нет связи с сервером';
  try {
    DEVICES = [HEARD, FOUND];
    const root = await mount();
    findButtonByText(root, /Добавить прибор/).click();
    await tick();
    const win = addWindow(root);
    assert.ok(win, 'окно открыто');
    const text = textOf(win);
    assert.ok(text.includes('Не удалось прочитать список приборов: нет связи с сервером'), text);
    assert.ok(!text.includes('Ни один анализатор пока не выходил на связь.'));
    assert.ok(!text.includes('Новых анализаторов пока нет.'));
  } finally { DEV_ERROR = null; }
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

// ── Ревью I2 — пустая модель не стирает догадку и не подменяется первой ─────
async function openAdoptFor(device) {
  DEVICES = [HEARD, device];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  findButtons(root).find((b) => /^\s*(<svg[\s\S]*?<\/svg>)?\s*Добавить\s*$/.test(textOf(b))).click();
  await tick();
  return root;
}
async function saveAdopt(root) {
  findButtons(root).filter((b) => /Добавить/.test(textOf(b))).pop().click();
  await tick(60);
  const upd = writes.find((w) => w.table === 'lab_devices' && w.op === 'update');
  assert.ok(upd, 'записано: ' + JSON.stringify(writes));
  return upd;
}
const optionsOf = (sel) => walk(sel).filter((n) => n.tagName === 'OPTION');
const selectedValues = (sel) => optionsOf(sel).filter((o) => 'selected' in o.attrs).map((o) => o.value);
const modelSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT' && optionsOf(n).some((o) => textOf(o) === 'модель не выбрана'));

test('ревью I2: «Добавить» с «модель не определена» — модель не пишется вовсе, догадка сервера остаётся', async () => {
  const root = await openAdoptFor(FOUND);
  walk(root).find((n) => n.tagName === 'SELECT').value = '';
  const upd = await saveAdopt(root);
  assert.deepStrictEqual(upd.values, { name: 'BC-5300', added: 1 });
});

// Пометка «найден сам — проверьте модель» в таблице — пока модель находки не
// подтвердил человек. Раньше она оставалась навсегда: discovered — правило
// приёма, трогать его нельзя (ревью C1), а отдельного признака не было.
test('таблица: «найден сам — проверьте модель» — только пока модель не подтверждена', async () => {
  DEVICES = [{ ...FOUND, added: 1, model_confirmed: 0 }];
  let root = await mount();
  assert.ok(textOf(walk(root).find((n) => n.tagName === 'TABLE')).includes('найден сам — проверьте модель'));
  DEVICES = [{ ...FOUND, added: 1, model_confirmed: 1 }];
  root = await mount();
  assert.ok(!textOf(walk(root).find((n) => n.tagName === 'TABLE')).includes('найден сам'), 'модель проверил человек — пометки нет');
});

test('ревью I2: lis_profiles не ответил — в списке один пустой пункт, и модель находки не стирается', async () => {
  PROFILES_FAIL = true;
  try {
    const root = await openAdoptFor(FOUND);
    assert.deepStrictEqual(optionsOf(walk(root).find((n) => n.tagName === 'SELECT')).map((o) => o.value), ['']);
    const upd = await saveAdopt(root);
    assert.ok(!('profile' in upd.values), JSON.stringify(upd.values));
  } finally { PROFILES_FAIL = false; }
});

test('ревью I2: «Изменить» у прибора без модели — выбран «модель не выбрана», а не первый профиль', async () => {
  // Без пустого пункта у такого прибора не было выбранного пункта, браузер
  // показывал первый (Mindray BC-20), и «Изменить → Сохранить» молча ставил его.
  DEVICES = [HEARD, { ...WAITING, profile: '' }];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  findButtonByText(rowNamed(root, 'jjjj'), /Изменить/).click();
  await tick();
  const sel = modelSelect(root);
  assert.ok(sel, 'у модели есть пункт «модель не выбрана»');
  assert.strictEqual(optionsOf(sel)[0].value, '', 'он первый');
  assert.deepStrictEqual(selectedValues(sel), [''], 'и выбран');
});

test('ревью I2: модели прибора нет среди профилей — она своим пунктом и выбрана, «Сохранить» её не стирает', async () => {
  DEVICES = [HEARD, { ...WAITING, profile: 'mindray-bc-9999' }];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  findButtonByText(rowNamed(root, 'jjjj'), /Изменить/).click();
  await tick();
  const sel = modelSelect(root);
  assert.deepStrictEqual(selectedValues(sel), ['mindray-bc-9999']);
  assert.ok(optionsOf(sel).some((o) => o.value === 'mindray-bc-9999' && textOf(o) === 'mindray-bc-9999 — профиль не найден'));
});

// ── Ревью M3 — форма, открытая из окна «Добавить прибор», возвращает туда ────
// «Удалить» у строки окна, и «Изменить → Сохранить / Удалить» у ждущего
// закрывали всё окно: человек разбирал список и терял его после каждого шага.
async function openAddWindowRoot(devices) {
  DEVICES = devices;
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  return root;
}
const formButton = (root, re) => findButtons(root).find((b) => re.test(textOf(b).replace(/<svg[\s\S]*?<\/svg>/g, '').trim()));

test('ревью M3: «Удалить» у находки — окно «Добавить прибор» остаётся открытым', async () => {
  const root = await openAddWindowRoot([HEARD, FOUND, WAITING]);
  findButtonByText(rowNamed(root, 'BC-5300'), /Удалить/).click();
  await tick(60);
  assert.strictEqual(toastMsg, 'Прибор удалён');
  assert.ok(addWindow(root), 'окно на месте');
});

test('ревью M3: «Изменить → Сохранить» у ждущего — снова окно «Добавить прибор», а не пустое место', async () => {
  const root = await openAddWindowRoot([HEARD, FOUND, WAITING]);
  findButtonByText(rowNamed(root, 'jjjj'), /Изменить/).click();
  await tick();
  assert.ok(!addWindow(root), 'открыта форма прибора');
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  assert.ok(writes.some((w) => w.table === 'lab_devices' && w.op === 'update'), 'сохранено: ' + JSON.stringify(writes));
  assert.ok(addWindow(root), 'вернулись в окно');
});

test('ревью M3: «Изменить → Удалить» и «Изменить → Отмена» у ждущего — тоже обратно в окно', async () => {
  let root = await openAddWindowRoot([HEARD, WAITING]);
  findButtonByText(rowNamed(root, 'jjjj'), /Изменить/).click();
  await tick();
  formButton(root, /^Удалить$/).click();
  await tick(60);
  assert.deepStrictEqual(rpcCalls.filter((c) => c.name === 'lis_device_delete').map((c) => c.args), [{ id: 4 }]);
  assert.ok(addWindow(root), 'после удаления — окно');

  root = await openAddWindowRoot([HEARD, WAITING]);
  findButtonByText(rowNamed(root, 'jjjj'), /Изменить/).click();
  await tick();
  formButton(root, /^Отмена$/).click();
  await tick();
  assert.ok(addWindow(root), 'после отмены — окно');
});

// ── Ревью M9 — живой опрос не перестраивает окно «Добавить прибор» без нужды ─
// Каждые 5 с окно строилось заново: кнопка, на которую как раз нажимали,
// исчезала из-под курсора, и нажатие терялось. Метки времени здесь старые и
// неподвижные («не отвечает с …»), чтобы текст связи не менялся сам по часам.
test('ревью M9: опрос перерисовывает окно, только когда изменилось то, что в нём видно', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const found = { ...FOUND, last_seen_at: '2026-09-20T08:00:00Z' };
    DEVICES = [HEARD, found, WAITING];
    writes = []; rpcCalls = []; toastMsg = null;
    const root = mk('div');
    await mountLabDevices(root);   // опрос включён: mount() теста его гасит
    findButtonByText(root, /Добавить прибор/).click();
    await tick();
    const btn = findButtonByText(rowNamed(root, 'BC-5300'), /Добавить/);
    assert.ok(btn, 'кнопка «Добавить» у находки');

    const polls = () => rpcCalls.filter((c) => c.name === 'lis_listeners').length;
    const before = polls();
    mock.timers.tick(5000);   // опрос, данные те же
    await tick(60);
    assert.ok(polls() > before, 'опрос действительно прошёл');
    assert.ok(walk(root).includes(btn), 'окно не перестроено: кнопка под курсором та же');

    DEVICES = [HEARD, { ...found, last_seen_at: '2026-09-21T08:00:00Z' }, WAITING];   // находка прислала ещё пробу
    mock.timers.tick(5000);
    await tick(60);
    assert.ok(!walk(root).includes(btn), 'видимое изменилось — окно перерисовано');
    assert.ok(addWindow(root), 'и это всё то же окно');

    const btn2 = findButtonByText(rowNamed(root, 'BC-5300'), /Добавить/);
    LISTENERS = { listening: [], failed: [{ port: 2575, code: 'busy', error: 'x' }] };   // порт упал
    mock.timers.tick(5000);
    await tick(60);
    assert.ok(!walk(root).includes(btn2), 'строка о порте ждущего изменилась — окно перерисовано');
    assert.ok(textOf(addWindow(root)).includes('порт 2575 занят другой программой'));
  } finally {
    stopLabDevicesLive();
    mock.timers.reset();
    LISTENERS = LISTENING_2575;
  }
});

// ── Ревью M2 — инструкция ведёт туда, где прибор теперь появляется ──────────
// «Прибор появится в списке выше сам» — больше неправда: находка ждёт в окне
// «Добавить прибор», а в таблицу попадает после нажатия «Добавить».
const GUIDE_STEP = 'Прогоните одну пробу. Прибор появится в «Добавить прибор» → «Найдены в сети»: нажмите «Добавить», затем в «Панелях» выберите его у панели и подтвердите поля.';
const GUIDE_NOTE = 'Если прибор уже присылал пробы, но значения не ложатся — смотрите «Необработанные»: там написано, чего именно не хватает.';

test('ревью M2: инструкция — «Добавить прибор» → «Найдены в сети» → «Добавить», а не «в списке выше»', async () => {
  DEVICES = [HEARD];
  const text = textOf(await mount());
  assert.ok(text.includes(GUIDE_STEP), 'шаг инструкции');
  assert.ok(text.includes(GUIDE_NOTE), 'строка «Важно»');
  assert.ok(!text.includes('в списке выше') && !text.includes('появился в списке'), 'про «список» больше ни слова');
});

test('ревью M2: английская и узбекская инструкция называют экраны так, как они подписаны на этом языке', () => {
  for (const lang of ['en', 'uz']) {
    for (const label of ['Добавить прибор', 'Найдены в сети', 'Добавить', 'Панели']) {
      assert.ok(STRINGS[GUIDE_STEP][lang].includes('«' + STRINGS[label][lang] + '»'), `${lang}: «${STRINGS[label][lang]}» — ${STRINGS[GUIDE_STEP][lang]}`);
    }
    assert.ok(STRINGS[GUIDE_NOTE][lang].includes('«' + STRINGS['Необработанные'][lang] + '»'), lang);
  }
});

test('ревью M3: форма из таблицы по-прежнему просто закрывается', async () => {
  DEVICES = [HEARD];
  const root = await mount();
  findButtonByText(rowNamed(root, 'kjkj'), /Изменить/).click();
  await tick();
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  assert.ok(writes.some((w) => w.table === 'lab_devices' && w.op === 'update'));
  assert.ok(!addWindow(root), 'окно «Добавить прибор» само не открывается');
  assert.ok(!findButtons(root).some((b) => /^\s*Сохранить\s*$/.test(textOf(b))), 'форма закрыта');
});

test('ревью I2: новый прибор по адресу — по-прежнему выбрана первая модель', async () => {
  DEVICES = [HEARD];
  const root = await mount();
  findButtonByText(root, /Добавить прибор/).click();
  await tick();
  findButtonByText(root, /Добавить по адресу/).click();
  await tick();
  assert.deepStrictEqual(selectedValues(modelSelect(root)), ['mindray-bc-5300']);
});

// ── LIS_DISCOVERY_FIX_V1 (экран), C1 — ручная форма: только сеть, адрес обязателен ──
// Решение владельца 2026-09-29: новый прибор руками — только сетевой и только с
// адресом. Анализатор на кабеле COM приходит через переадресатор на
// лабораторном ПК и появляется в «Найдены в сети» сам; «Кабель COM» и «Папка»
// в новой форме больше не предлагаются. Уже заведённые строки своё значение
// сохраняют и видят его в правке.
const ADDR_PH = 'адрес анализатора в сети, например 10.0.0.20';
const COM_NOTE = 'Анализатор на кабеле COM подключается через переадресатор на лабораторном компьютере и появится в «Найдены в сети» сам — добавлять его здесь не нужно.';
const NO_HOST_HINT = 'Без адреса прибор примет пробы только от сетевого анализатора на своём порту и запомнит первого — лучше укажите адрес.';
const inputByPlaceholder = (root, ph) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === ph);
const transportSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT' && optionsOf(n).some((o) => o.value === 'mllp'));

async function openNewDeviceForm() {
  const root = await openAddWindowRoot([HEARD]);
  findButtonByText(root, /Добавить по адресу/).click();
  await tick();
  return root;
}

test('C1: новый прибор руками — без выбора «Подключение», адрес с сетевой подсказкой, строка про COM', async () => {
  const root = await openNewDeviceForm();
  assert.ok(!transportSelect(root), 'списка «Подключение» в новой форме нет');
  assert.ok(!walk(root).some((n) => n.tagName === 'LABEL' && textOf(n).startsWith('Подключение')), 'и подписи его нет');
  assert.ok(inputByPlaceholder(root, ADDR_PH), 'у адреса подсказка — пример сетевого адреса');
  const text = textOf(root);
  assert.ok(text.includes(COM_NOTE), 'сказано, откуда берётся прибор на кабеле COM');
  assert.ok(!text.includes('Кабель COM (RS-232)') && !text.includes('Папка с файлами'), 'кабель и папка не предлагаются');
  assert.ok(!text.includes(NO_HOST_HINT), 'подсказка «без адреса» — только в правке: новому прибору адрес обязателен');
});

test('C1: новый прибор без адреса не сохраняется — предупреждение, в базу ничего', async () => {
  const root = await openNewDeviceForm();
  inputByPlaceholder(root, 'Например: Гематология').value = 'Гематология';
  inputByPlaceholder(root, ADDR_PH).value = '   ';
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  assert.strictEqual(toastMsg, 'Укажите адрес анализатора в сети — например, 10.0.0.20');
  assert.strictEqual(toastEl.dataset.kind, 'warn');
  assert.ok(!writes.some((w) => w.table === 'lab_devices'), 'ничего не записано: ' + JSON.stringify(writes));
  assert.ok(!rpcCalls.some((c) => c.name === 'lis_restart'), 'слушатели не перезапускаются');
  assert.ok(formButton(root, /^Сохранить$/), 'форма осталась на экране — адрес можно вписать');
});

test('C1: новый прибор с адресом записывается сетевым: transport = mllp', async () => {
  const root = await openNewDeviceForm();
  inputByPlaceholder(root, 'Например: Гематология').value = 'Гематология';
  inputByPlaceholder(root, ADDR_PH).value = ' 10.0.0.20 ';
  formButton(root, /^Сохранить$/).click();
  await tick(60);
  const ins = writes.find((w) => w.table === 'lab_devices' && w.op === 'insert');
  assert.ok(ins, 'записано: ' + JSON.stringify(writes));
  const v = [].concat(ins.values)[0];
  assert.strictEqual(v.transport, 'mllp');
  assert.strictEqual(v.host, '10.0.0.20');
  assert.strictEqual(v.name, 'Гематология');
});

test('C1: «Изменить» у старого прибора на кабеле COM — его подключение по-прежнему выбрано и видно', async () => {
  const root = await openAddWindowRoot([HEARD, { ...WAITING, id: 8, name: 'Кабельный', transport: 'serial', port: null }]);
  findButtonByText(rowNamed(root, 'Кабельный'), /Изменить/).click();
  await tick();
  const sel = transportSelect(root);
  assert.ok(sel, 'в правке список «Подключение» есть');
  assert.deepStrictEqual(optionsOf(sel).map((o) => o.value), ['mllp', 'serial'], 'сеть и прежнее значение строки; папки нет');
  assert.deepStrictEqual(selectedValues(sel), ['serial'], '«Изменить → Сохранить» не превращает кабель в сеть');
  assert.ok(optionsOf(sel).some((o) => o.value === 'serial' && textOf(o) === 'Кабель COM (RS-232)'));
});

test('C1: «Изменить» у сетевого прибора без адреса — в списке только сеть и подсказка «лучше укажите адрес»', async () => {
  const root = await openAddWindowRoot([HEARD, WAITING]);   // у jjjj адреса нет
  findButtonByText(rowNamed(root, 'jjjj'), /Изменить/).click();
  await tick();
  const sel = transportSelect(root);
  assert.deepStrictEqual(optionsOf(sel).map((o) => o.value), ['mllp']);
  const host = inputByPlaceholder(root, ADDR_PH);
  assert.ok(host, 'у адреса в правке та же подсказка');
  const hint = walk(root).find((n) => n.tagName === 'P' && textOf(n) === NO_HOST_HINT);
  assert.ok(hint, 'подсказка про прибор без адреса');
  // Ревью M10: тестовый DOM не выводит value списка из selected-пункта — ставим сами.
  sel.value = 'mllp';
  sel.dispatchEvent({ type: 'change', target: sel });
  assert.notStrictEqual(hint.style.display, 'none', 'адреса нет — подсказка видна');
  host.value = '10.0.0.7';
  host.dispatchEvent({ type: 'input', target: host });
  assert.strictEqual(hint.style.display, 'none', 'адрес вписан — подсказка ушла');
  host.value = '';
  host.dispatchEvent({ type: 'input', target: host });
  assert.notStrictEqual(hint.style.display, 'none', 'адрес стёрли — подсказка снова видна');
});
