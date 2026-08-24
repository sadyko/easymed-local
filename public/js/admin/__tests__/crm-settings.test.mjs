// CRM_CONFIG_V1 (docs/plans/2026-08-24-crm-kanban-settings.md, part B) — the
// Настройки → «CRM-канбан» screen against the RPC contract in
// server/services/rpc/crm-config.js and services/crm/config.js.
//
// Covers: both cards render and crm_config_get is called with {}; a 501
// from a clinic still on an older build shows the calm «недоступно» line and
// never crashes; each card saves ONLY its own section, with positions
// renumbered from the on-screen order and labels trimmed; ↑/↓ reorder what
// gets sent; the kind==='won' column is badged «конверсия», cannot be removed
// and cannot be hidden; the rows the server refuses to delete
// (UNDELETABLE_*_KEYS) are not offered a delete button at all; a new column
// derives its key from the Russian label; a refused save never reaches the
// server.
//
// TELEPHONY_ROUTING_V1 (docs/plans/2026-08-24-telephony-owns-its-routing.md)
// — the «Звонки → карточки» assertions that used to live here MOVED into
// __tests__/telephony-settings.test.mjs along with the card itself. What
// stays behind is one test that the move actually happened: crm_config_get
// still answers with `routing`, and this screen must now render none of it.
// Deleting the old tests without that guard would have let the card quietly
// come back.

import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/telephony-settings.test.mjs
// (itself from system-view.test.mjs) because this view also renders Icon()
// calls, which go through ui.js's html() -> a <template> parse.
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
// this same store's 'admin.lang' before ever consulting navigator.language.
// Pinning 'ru' here, BEFORE the view import below, is what makes this file's
// Russian-string assertions hold on GitHub's English-locale runner exactly
// as they do on a Russian-locale dev machine.
fakeLocalStorage.setItem('admin.lang', 'ru');
// confirm() is answered YES by default: removing a row only edits the list in
// memory, and the dialog is a guard against a mis-click, not part of the
// contract. The one test about a refused removal overrides it.
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, easymed: { state: { user: null } }, confirm: () => true };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));
const findButtonByAria = (root, label) => findAllButtons(root).filter((b) => b.attrs['aria-label'] === label);
const findInputs = (root) => walk(root).filter((n) => n.tagName === 'INPUT');
const findTextInputs = (root) => findInputs(root).filter((n) => n.attrs.type === 'text');
const findCheckboxes = (root) => findInputs(root).filter((n) => n.attrs.type === 'checkbox');
const findSelects = (root) => walk(root).filter((n) => n.tagName === 'SELECT');
const findInputByPlaceholder = (root, re) => findInputs(root).find((n) => re.test(String(n.attrs.placeholder || '')));
// The last toast the screen raised. A dedicated #toast node is handed to
// ui.js's toast() so it reuses it instead of appending a new one, and its text
// is kept OUTSIDE `_t`: toast() stores its dismiss timer in `el._t`, which is
// exactly the field this fake DOM keeps text in — reading `_t` back would
// return a Timeout object.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);
const lastToast = () => toastMsg;
const clearToasts = () => { toastMsg = null; };

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// --- fake server ----------------------------------------------------------
// Answers exactly the plan's RPC contract, so every call site is asserted
// against the same shape the parallel server task is building to.
let getCalls, saveCalls;
let lastGetBody, lastSaveBody;
let getRespond, saveRespond;

const FULL_CONFIG = {
  stages: [
    { key: 'in_process',    label: 'В обработке',           color: 'info',   position: 1, is_active: 1, kind: 'open' },
    { key: 'recall',        label: 'Перезвонить',           color: 'warn',   position: 2, is_active: 1, kind: 'open' },
    { key: 'came',          label: 'Пришёл',                color: 'ok',     position: 3, is_active: 1, kind: 'won' },
    { key: 'not_qualified', label: 'Нецелевой',             color: '',       position: 4, is_active: 0, kind: 'lost' },
  ],
  sources: [
    { key: 'call',      label: 'Звонок',    position: 1, is_active: 1 },
    { key: 'telephony', label: 'Телефония', position: 2, is_active: 1 },
  ],
  routing: [
    { provider: 'binotel', disposition: 'ANSWER',   action: 'create', stage_key: 'in_process' },
    { provider: 'binotel', disposition: 'NOANSWER', action: 'create', stage_key: 'recall' },
    { provider: 'binotel', disposition: 'SMS-SENDING', action: 'ignore', stage_key: null },
  ],
};

function resetServer() {
  getCalls = 0; saveCalls = 0;
  lastGetBody = null; lastSaveBody = null;
  getRespond = () => jsonOk(JSON.parse(JSON.stringify(FULL_CONFIG)));
  // The real crm_config_save answers with the WHOLE config, not {ok:true}
  // (server/services/crm/config.js saveConfig) — the screen redraws from it.
  saveRespond = () => jsonOk(JSON.parse(JSON.stringify(FULL_CONFIG)));
  clearToasts();
}

const err501 = () => jsonErr({ code: 'rpc_not_implemented', message: 'RPC not implemented: x' }, 501);

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/crm_config_get'))  { getCalls++;  lastGetBody = body;  return getRespond(); }
  if (u.startsWith('/api/rpc/crm_config_save')) { saveCalls++; lastSaveBody = body; return saveRespond(); }
  return jsonOk({});
};

const { renderCrmSettings } = await import('../views/crm-settings.js');

async function render(onNavigate) {
  const root = mk('div');
  await renderCrmSettings(root, { onNavigate });
  await tick();
  return root;
}

// Save buttons are found by their aria-free label text ONCE: run() overwrites
// btn.textContent, and this fake element reports only its own _t, so after the
// first click a text search would no longer find the button (the lesson
// telephony-settings.test.mjs wrote down).
const saveStagesBtn = (root) => findButtonByText(root, /Сохранить колонки/);
const saveSourcesBtn = (root) => findButtonByText(root, /Сохранить источники/);

test('две карточки рисуются; crm_config_get вызван ровно с {}', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  for (const card of ['Колонки канбана', 'Источники']) {
    assert.ok(text.includes(card), 'карточка на экране: ' + card);
  }
  assert.strictEqual(getCalls, 1);
  assert.deepStrictEqual(lastGetBody, {}, 'контракт: crm_config_get {}');
  // Колонки и источники — из конфигурации, а не из зашитого списка.
  for (const label of ['В обработке', 'Перезвонить', 'Пришёл', 'Нецелевой', 'Звонок', 'Телефония']) {
    assert.ok(findTextInputs(root).some((i) => i.value === label), 'строка редактируется: ' + label);
  }
});

test('501 — спокойная строка «недоступны», не падение и не пустой экран', async () => {
  resetServer();
  getRespond = err501;
  const root = await render();
  assert.ok(textOf(root).includes('Настройки CRM недоступны: сервер ещё не обновлён'), textOf(root));
});

test('колонка конверсии: значок «конверсия», её нельзя ни скрыть, ни удалить', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('конверсия'), 'значок на колонке');
  assert.ok(text.includes('Через эту колонку регистрируется пациент'), 'объяснение прямо в строке, а не в документации');

  // Четыре колонки и два источника, но кнопка «Удалить» есть только у
  // «Перезвонить» и «Нецелевой»: «Пришёл» — конверсия, «В обработке» и оба
  // источника (call, telephony) сервер удалять не даёт (UNDELETABLE_*_KEYS),
  // и предлагать кнопку, которая всегда вернёт 409, нечестно.
  const removes = findButtonByAria(root, 'Удалить');
  assert.strictEqual(removes.length, 2, 'только «Перезвонить» и «Нецелевой»');
  assert.ok(text.includes('Подставляется новым заявкам по умолчанию'), 'причина у «В обработке» — прямо в строке');
  assert.ok(text.includes('На него ссылается сама система'), 'причина у системных источников — там же');

  // Галочка «Видна» у конверсии отключена, у остальных — нет.
  const boxes = findCheckboxes(root);
  const locked = boxes.filter((b) => 'disabled' in b.attrs);
  assert.strictEqual(locked.length, 1, 'заблокирована ровно одна галочка — колонки конверсии');
  assert.strictEqual(locked[0].attrs.title, 'Колонку конверсии нельзя скрыть');
});

test('сохранение колонок шлёт ТОЛЬКО {stages}, с позициями 1..n по экранному порядку и обрезанными названиями', async () => {
  resetServer();
  const root = await render();
  const labels = findTextInputs(root);
  // Переименование пишется прямо в модель, без перерисовки (каретка на месте).
  const recall = labels.find((i) => i.value === 'Перезвонить');
  recall.value = '  Перезвонить позже  ';
  recall.dispatchEvent({ type: 'input' });

  saveStagesBtn(root).click();
  await tick();
  assert.strictEqual(saveCalls, 1);
  assert.deepStrictEqual(Object.keys(lastSaveBody), ['stages'], 'секция сохраняется одна — источники и маршрут не трогаются');
  assert.deepStrictEqual(lastSaveBody.stages.map((s) => [s.key, s.label, s.position, s.is_active, s.kind, s.color]), [
    ['in_process', 'В обработке', 1, 1, 'open', 'info'],
    ['recall', 'Перезвонить позже', 2, 1, 'open', 'warn'],
    ['came', 'Пришёл', 3, 1, 'won', 'ok'],
    ['not_qualified', 'Нецелевой', 4, 0, 'lost', ''],
  ]);
  assert.strictEqual(getCalls, 1, 'экран перерисовывается ОТВЕТОМ сохранения, а не догадкой и не лишним запросом');
});

test('↑/↓ меняют порядок, который уходит на сервер; «↑» на первой строке — ничего', async () => {
  resetServer();
  const root = await render();
  // Первая пара стрелок принадлежит первой колонке, вторая — второй.
  const ups = findButtonByAria(root, 'Выше');
  const downs = findButtonByAria(root, 'Ниже');
  assert.ok('disabled' in ups[0].attrs, 'на первой строке «↑» отключена — обёртки к концу списка не будет');
  assert.ok('disabled' in downs[3].attrs, 'на последней строке колонок «↓» отключена');

  ups[1].click();   // «Перезвонить» вверх
  await tick();
  saveStagesBtn(root).click();
  await tick();
  assert.deepStrictEqual(lastSaveBody.stages.map((s) => [s.key, s.position]),
    [['recall', 1], ['in_process', 2], ['came', 3], ['not_qualified', 4]]);
});

test('«Добавить колонку»: ключ выводится из русского названия и уходит с формой', async () => {
  resetServer();
  const root = await render();
  const input = findInputByPlaceholder(root, /Название новой колонки/);
  input.value = 'Ждём оплату';
  findButtonByText(root, /Добавить колонку/).click();
  await tick();

  saveStagesBtn(root).click();
  await tick();
  const added = lastSaveBody.stages[lastSaveBody.stages.length - 1];
  assert.deepStrictEqual(added, {
    key: 'zhdem_oplatu', label: 'Ждём оплату', color: '', position: 5, is_active: 1, kind: 'open',
  }, 'новая колонка серая, видимая, обычная — и никогда не вторая конверсия');
});

test('пустое название не добавляет колонку и не идёт на сервер', async () => {
  resetServer();
  const root = await render();
  findInputByPlaceholder(root, /Название новой колонки/).value = '   ';
  findButtonByText(root, /Добавить колонку/).click();
  await tick();
  assert.strictEqual(lastToast(), 'Введите название.');
  saveStagesBtn(root).click();
  await tick();
  assert.strictEqual(lastSaveBody.stages.length, 4, 'ничего не добавилось');
});

test('пустое название существующей колонки — отказ ДО обращения к серверу', async () => {
  resetServer();
  const root = await render();
  const first = findTextInputs(root)[0];
  first.value = '   ';
  first.dispatchEvent({ type: 'input' });
  saveStagesBtn(root).click();
  await tick();
  assert.strictEqual(saveCalls, 0, 'на сервер такое не уходит вовсе');
  assert.strictEqual(lastToast(), 'У каждой колонки должно быть название.');
});

test('удаление строки спрашивает подтверждение; отказ оставляет колонку на месте', async () => {
  resetServer();
  const root = await render();
  window.confirm = () => false;
  try {
    findButtonByAria(root, 'Удалить')[0].click();   // «Перезвонить»
    await tick();
    saveStagesBtn(root).click();
    await tick();
    assert.strictEqual(lastSaveBody.stages.length, 4, 'отказ в диалоге — список не тронут');
  } finally { window.confirm = () => true; }
});

test('источники сохраняются своей кнопкой и своей секцией', async () => {
  resetServer();
  const root = await render();
  const tel = findTextInputs(root).find((i) => i.value === 'Телефония');
  tel.value = 'Звонок с АТС';
  tel.dispatchEvent({ type: 'input' });
  saveSourcesBtn(root).click();
  await tick();
  assert.deepStrictEqual(Object.keys(lastSaveBody), ['sources']);
  assert.strictEqual(getCalls, 1, 'ответ save уже содержит конфигурацию — второго crm_config_get не нужно');
  assert.deepStrictEqual(lastSaveBody.sources, [
    { key: 'call', label: 'Звонок', position: 1, is_active: 1 },
    { key: 'telephony', label: 'Звонок с АТС', position: 2, is_active: 1 },
  ]);
});

test('маршрут звонков уехал в «Телефонию» — на этом экране от него не осталось ничего', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  // Сервер по-прежнему отдаёт routing в том же ответе (crm_config_get не
  // менялся) — и экран обязан его игнорировать. Правило источника
  // настраивается там, где настраивается сам источник.
  assert.ok(FULL_CONFIG.routing.length, 'тест бессмыслен, если сервер перестал присылать правила');
  for (const gone of ['Звонки → карточки', 'Исход звонка', 'Что делать', 'В какую колонку',
                      'Сохранить маршрут', 'Ответили', 'ANSWER', 'SMS-SENDING',
                      'Правила работают, только пока подключён модуль']) {
    assert.ok(!text.includes(gone), 'осталось от карточки маршрута: ' + gone);
  }
  assert.strictEqual(findSelects(root).length, 0, 'выпадающих списков на этом экране больше нет вовсе');
  assert.strictEqual(findAllButtons(root).filter((b) => /маршрут|телефон/i.test(textOf(b))).length, 0,
    'и ни одной кнопки, которая писала бы routing');
});

test('501 на сохранении — честная строка «недоступно», не «сервер сломан»', async () => {
  resetServer();
  const root = await render();
  saveRespond = err501;
  saveStagesBtn(root).click();
  await tick();
  assert.strictEqual(lastToast(), 'Сохранение недоступно: сервер ещё не обновлён.');
});

test('тонкий ответ сервера — экран показывает сегодняшнюю воронку, а не пустую форму', async () => {
  resetServer();
  getRespond = () => jsonOk({});
  const root = await render();
  const values = findTextInputs(root).map((i) => i.value);
  for (const label of ['В обработке', 'Перезвонить', 'Записан', 'Подтверждён', 'Пришёл', 'Не пришёл', 'Обработка остановлена', 'Нецелевой']) {
    assert.ok(values.includes(label), 'запасная колонка: ' + label);
  }
  for (const label of ['Звонок', 'Instagram', 'Telegram', 'Сайт', 'Пришёл сам', 'Рекомендация', 'Другое']) {
    assert.ok(values.includes(label), 'запасной источник: ' + label);
  }
});
