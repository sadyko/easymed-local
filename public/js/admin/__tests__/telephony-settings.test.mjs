// TELEPHONY_V1 (docs/plans/2026-08-23-binotel-telephony.md, Task 2) — the
// Settings → «Телефония» screen against the EXACT RPC contract the parallel
// server task is building to.
//
// TELEPHONY_ROUTING_V1 (docs/plans/2026-08-24-telephony-owns-its-routing.md)
// added the fifth section, «Звонки → заявки», and with it the assertions that
// moved here from __tests__/crm-settings.test.mjs when the card did.
//
// Covers: all five sections render and telephony_settings_get is called with
// {}; a 501 from a not-yet-merged server shows the calm «недоступно» line
// (full-screen for settings, per-card for the call log) and never crashes;
// saving the connection sends api_key always and api_secret ONLY when a new
// non-empty one was typed (empty means "keep the saved one"); an empty key
// refuses to save at all; the poll-interval save refuses anything below 10
// without calling the server and sends exactly {poll_interval_sec: N} when
// valid; the polling toggle saves {enabled} immediately and rolls the
// checkbox back when the server refuses; «Проверить подключение» sends the
// just-typed creds and prints the server's own reason on failure; the
// webhook URL is built from public_base_url (hint instead when absent); the
// call table renders shaped rows with em-dashes for absent fields, and the
// patient link resolves the patient over /api/db and navigates with the
// same ('patient-card', {id, full_name, mrn, phone}) payload CRM uses.

import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/system-view.test.mjs (itself from
// activation.test.mjs) because this view also renders Icon() calls, which go
// through ui.js's html() -> a <template> parse.
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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));
const findInputs = (root) => walk(root).filter((n) => n.tagName === 'INPUT');
const findInputByType = (root, type) => findInputs(root).find((n) => n.attrs.type === type);
const findInputByPlaceholder = (root, re) => findInputs(root).find((n) => re.test(String(n.attrs.placeholder || '')));
const findByRole = (root, role) => walk(root).find((n) => n.attrs.role === role);
// Company ID — единственный text-инпут секции без плейсхолдера (ключ и адрес свои несут).
const findCompanyInput = (root) => findInputs(root).find((n) => n.attrs.type === 'text' && !n.attrs.placeholder);

// The last toast the screen raised. A dedicated #toast node is handed to
// ui.js's toast() so it reuses it instead of appending a new one, and its text
// is kept OUTSIDE `_t`: toast() stores its dismiss timer in `el._t`, which is
// exactly the field this fake DOM keeps text in — reading `_t` back would
// return a Timeout object. (Verbatim from crm-settings.test.mjs, which needed
// it for the same refuse-before-the-server assertions.)
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);
const lastToast = () => toastMsg;

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// --- fake server ----------------------------------------------------------
// Answers exactly the plan's RPC contract, so every call site is asserted
// against the same shape the parallel server task is building to.
let getCalls, saveCalls, testCalls, callsCalls, dbCalls;
let lastGetBody, lastSaveBody, lastTestBody, lastCallsBody, lastDbBody;
let settingsRespond, saveRespond, testRespond, callsRespond, dbRespond;
// TELEPHONY_ROUTING_V1 — «Звонки → заявки» reads two more RPCs and writes the
// CRM's existing one. crm_config_save is deliberately NOT a telephony RPC:
// the card moved screens, the storage model did not.
let dispCalls, cfgGetCalls, cfgSaveCalls;
let lastDispBody, lastCfgGetBody, lastCfgSaveBody;
let dispRespond, cfgGetRespond, cfgSaveRespond;

const FULL_SETTINGS = {
  enabled: true, provider: 'binotel', api_key: 'key-live', api_secret_set: true, company_id: '12345',
  poll_interval_sec: 30, webhooks_enabled: false, public_base_url: 'https://clinic.example.uz',
  last_poll_at: '2026-08-23T09:00:00', last_call_at: null, last_error: null,
};

// telephony_dispositions' contract: observed ∪ documented, each row already
// carrying its own rule. ANSWER/NOANSWER are documented AND seen, WHATSAPP-IN
// is one Binotel invented after this install (seen, no rule), SMS-SENDING is
// documented only.
const DISPOSITIONS = [
  { disposition: 'ANSWER',      seen_count: 15, last_seen_at: '2026-08-24T11:30:00Z', documented: true,  action: 'create', stage_key: 'in_process' },
  { disposition: 'NOANSWER',    seen_count: 3,  last_seen_at: '2026-08-23T09:00:00Z', documented: true,  action: 'create', stage_key: 'recall' },
  { disposition: 'WHATSAPP-IN', seen_count: 2,  last_seen_at: '2026-08-24T10:05:00Z', documented: false, action: 'ignore', stage_key: null },
  { disposition: 'SMS-SENDING', seen_count: 0,  last_seen_at: null,                   documented: true,  action: 'ignore', stage_key: null },
];
// crm_config_get's reply, unchanged by this move — «Нецелевой» is hidden on
// purpose, so the column picker can be asserted to leave it out.
const CRM_CONFIG = {
  stages: [
    { key: 'in_process',    label: 'В обработке', color: 'info', position: 1, is_active: 1, kind: 'open' },
    { key: 'recall',        label: 'Перезвонить', color: 'warn', position: 2, is_active: 1, kind: 'open' },
    { key: 'came',          label: 'Пришёл',      color: 'ok',   position: 3, is_active: 1, kind: 'won' },
    { key: 'not_qualified', label: 'Нецелевой',   color: '',     position: 4, is_active: 0, kind: 'lost' },
  ],
  sources: [{ key: 'call', label: 'Звонок', position: 1, is_active: 1 }],
  routing: DISPOSITIONS.map((d) => ({ provider: 'binotel', disposition: d.disposition, action: d.action, stage_key: d.stage_key })),
};

function resetServer() {
  getCalls = 0; saveCalls = 0; testCalls = 0; callsCalls = 0; dbCalls = 0;
  lastGetBody = null; lastSaveBody = null; lastTestBody = null; lastCallsBody = null; lastDbBody = null;
  dispCalls = 0; cfgGetCalls = 0; cfgSaveCalls = 0;
  lastDispBody = null; lastCfgGetBody = null; lastCfgSaveBody = null;
  dispRespond = () => jsonOk(JSON.parse(JSON.stringify(DISPOSITIONS)));
  cfgGetRespond = () => jsonOk(JSON.parse(JSON.stringify(CRM_CONFIG)));
  // The real crm_config_save answers with the WHOLE config (services/crm/config.js).
  cfgSaveRespond = () => jsonOk(JSON.parse(JSON.stringify(CRM_CONFIG)));
  toastMsg = null;
  settingsRespond = () => jsonOk({ ...FULL_SETTINGS });
  saveRespond = () => jsonOk({ ok: true });
  testRespond = () => jsonOk({ ok: true });
  callsRespond = () => jsonOk({ calls: [] });
  dbRespond = () => jsonOk({ id: 'p-1', full_name: 'Иванов Иван', mrn: 'EM-1', phone: '+998901234567' });
}

const err501 = () => jsonErr({ code: 'rpc_not_implemented', message: 'RPC not implemented: x' }, 501);

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/telephony_settings_get'))  { getCalls++;  lastGetBody = body;  return settingsRespond(); }
  if (u.startsWith('/api/rpc/telephony_settings_save')) { saveCalls++; lastSaveBody = body; return saveRespond(); }
  if (u.startsWith('/api/rpc/telephony_test'))          { testCalls++; lastTestBody = body; return testRespond(); }
  if (u.startsWith('/api/rpc/telephony_recent_calls'))  { callsCalls++; lastCallsBody = body; return callsRespond(); }
  if (u.startsWith('/api/rpc/telephony_dispositions'))  { dispCalls++; lastDispBody = body; return dispRespond(); }
  if (u.startsWith('/api/rpc/crm_config_get'))          { cfgGetCalls++; lastCfgGetBody = body; return cfgGetRespond(); }
  if (u.startsWith('/api/rpc/crm_config_save'))         { cfgSaveCalls++; lastCfgSaveBody = body; return cfgSaveRespond(); }
  if (u.startsWith('/api/db')) { dbCalls++; lastDbBody = body; return dbRespond(); }
  return jsonOk({});
};

const { renderTelephonySettings } = await import('../views/telephony-settings.js');

async function render(onNavigate) {
  const root = mk('div');
  await renderTelephonySettings(root, { onNavigate });
  await tick();   // журнал и маршрут грузятся после отрисовки настроек
  return root;
}

test('все пять секций рисуются; get вызван ровно с {}; secret говорит «сохранён» плейсхолдером', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  for (const section of ['Подключение', 'Опрос звонков', 'WebHook-и', 'Звонки → заявки', 'Последние звонки']) {
    assert.ok(text.includes(section), 'секция на экране: ' + section);
  }
  assert.strictEqual(getCalls, 1);
  assert.deepStrictEqual(lastGetBody, {}, 'контракт: telephony_settings_get {}');
  assert.strictEqual(callsCalls, 1);
  assert.deepStrictEqual(lastCallsBody, {}, 'контракт: telephony_recent_calls {}');
  const sec = findInputByType(root, 'password');
  assert.ok(sec, 'поле secret — type=password, значение никогда не приезжает');
  assert.strictEqual(sec.attrs.placeholder, 'сохранён — введите новый, чтобы заменить');
  assert.strictEqual(sec.value, '', 'secret не подставляется в поле');
  assert.strictEqual(findCompanyInput(root).value, '12345', 'company_id из telephony_settings_get предзаполняет поле');
});

test('501 на настройках — спокойная строка «недоступна», не падение и не пустой экран', async () => {
  resetServer();
  settingsRespond = err501;
  const root = await render();
  assert.ok(textOf(root).includes('Телефония недоступна: сервер ещё не обновлён'), textOf(root));
});

test('501 только на журнале — настройки живут, журнал говорит «недоступен»', async () => {
  resetServer();
  callsRespond = err501;
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Подключение'), 'настройки отрисованы');
  assert.ok(text.includes('Список звонков недоступен: сервер ещё не обновлён.'), text);
});

test('сохранение подключения: api_key всегда, api_secret только когда введён новый', async () => {
  resetServer();
  const root = await render();
  const key = findInputByPlaceholder(root, /ключ из письма/);
  key.value = ' key-new ';
  findButtonByText(root, /Сохранить подключение/).click();
  await tick();
  assert.strictEqual(saveCalls, 1);
  assert.deepStrictEqual(lastSaveBody, { api_key: 'key-new', company_id: '12345' },
    'пустое поле secret значит «оставить сохранённый»; company_id уходит с формой всегда');
  assert.strictEqual(getCalls, 2, 'после save состояние перечитывается, а не додумывается');

  // после сохранения экран перерисован — поля ищем заново
  const key2 = findInputByPlaceholder(root, /ключ из письма/);
  const sec2 = findInputByType(root, 'password');
  key2.value = 'key-new';
  sec2.value = 's3cret';
  findButtonByText(root, /Сохранить подключение/).click();
  await tick();
  assert.strictEqual(saveCalls, 2);
  assert.deepStrictEqual(lastSaveBody, { api_key: 'key-new', api_secret: 's3cret', company_id: '12345' });
});

test('пустой ключ не сохраняется вовсе', async () => {
  resetServer();
  const root = await render();
  findInputByPlaceholder(root, /ключ из письма/).value = '   ';
  findButtonByText(root, /Сохранить подключение/).click();
  await tick();
  assert.strictEqual(saveCalls, 0, 'save не вызван: сохранять нечего');
});

test('Company ID: отсутствует в ответе — поле пустое; сохраняется обрезанным; очистка уходит пустой строкой', async () => {
  resetServer();
  // Старый сервер поля ещё не знает: инпут просто пуст (правило тире — для
  // текста на экране, не для полей ввода).
  settingsRespond = () => jsonOk({ ...FULL_SETTINGS, company_id: undefined });
  let root = await render();
  const cid = findCompanyInput(root);
  assert.ok(cid, 'поле Company ID на месте');
  assert.strictEqual(cid.value, '', 'нет значения — пустое поле, не «—»');

  cid.value = ' 54321 ';
  findButtonByText(root, /Сохранить подключение/).click();
  await tick();
  assert.deepStrictEqual(lastSaveBody, { api_key: 'key-live', company_id: '54321' }, 'уходит обрезанным');

  // Очистка поля должна очистить и хранилище — пустая строка отправляется,
  // а не выбрасывается из payload.
  const cid2 = findCompanyInput(root);
  cid2.value = '';
  findButtonByText(root, /Сохранить подключение/).click();
  await tick();
  assert.deepStrictEqual(lastSaveBody, { api_key: 'key-live', company_id: '' });
});

test('интервал: меньше 10 не уходит на сервер; валидный уходит ровно {poll_interval_sec: N}', async () => {
  resetServer();
  const root = await render();
  const interval = findInputByType(root, 'number');
  const btn = findButtonByText(root, /Сохранить интервал/);
  interval.value = '5';
  btn.click();
  await tick();
  assert.strictEqual(saveCalls, 0, 'ниже пола — отказ БЕЗ похода на сервер (и без подмены на 10)');
  interval.value = '15';
  btn.click();
  await tick();
  assert.strictEqual(saveCalls, 1);
  assert.deepStrictEqual(lastSaveBody, { poll_interval_sec: 15 });
});

test('переключатель опроса сохраняет {enabled} сразу; отказ сервера откатывает галочку', async () => {
  resetServer();
  settingsRespond = () => jsonOk({ ...FULL_SETTINGS, enabled: false });
  const root = await render();
  const [pollCb, whCb] = findInputs(root).filter((n) => n.attrs.type === 'checkbox');
  assert.ok(pollCb && whCb, 'две галочки: опрос и webhooks');

  pollCb.checked = true;
  pollCb.dispatchEvent({ type: 'change' });
  await tick();
  assert.strictEqual(saveCalls, 1);
  assert.deepStrictEqual(lastSaveBody, { enabled: true });

  saveRespond = () => jsonErr({ message: 'нет доступа' }, 403);
  pollCb.checked = false;
  pollCb.dispatchEvent({ type: 'change' });
  await tick();
  assert.strictEqual(pollCb.checked, true, 'не сохранилось — галочка не врёт');
});

test('переключатель WebHook-ов шлёт {webhooks_enabled}', async () => {
  resetServer();
  const root = await render();
  const whCb = findInputs(root).filter((n) => n.attrs.type === 'checkbox')[1];
  whCb.checked = true;
  whCb.dispatchEvent({ type: 'change' });
  await tick();
  assert.deepStrictEqual(lastSaveBody, { webhooks_enabled: true });
});

test('проверка подключения шлёт введённые ключи и честно показывает reason сервера', async () => {
  resetServer();
  const root = await render();
  findInputByPlaceholder(root, /ключ из письма/).value = 'k-typed';
  findInputByType(root, 'password').value = 's-typed';
  const status = findByRole(root, 'status');
  assert.ok(status, 'строка результата — живая область role=status');

  // Ссылку на кнопку держим ОДНУ: в настоящем DOM textContent собирается по
  // потомкам и run() восстанавливает подпись, а этот фейковый читает только
  // собственный _t — после первого клика поиск по тексту кнопку не найдёт.
  const testBtn = findButtonByText(root, /Проверить подключение/);
  testRespond = () => jsonOk({ ok: false, reason: 'Binotel отклонил ключ' });
  testBtn.click();
  await tick();
  assert.strictEqual(testCalls, 1);
  assert.deepStrictEqual(lastTestBody, { api_key: 'k-typed', api_secret: 's-typed' },
    'контракт: telephony_test {api_key?, api_secret?} — проверяются именно введённые');
  assert.strictEqual(status.textContent, 'Binotel отклонил ключ');

  testRespond = () => jsonOk({ ok: true });
  testBtn.click();
  await tick();
  assert.strictEqual(status.textContent, 'Подключение работает.');
});

test('пустые поля ключей не передаются в telephony_test — сервер проверит сохранённые', async () => {
  resetServer();
  // Клиника без сохранённого ключа: поле пустое, и в telephony_test не должно
  // уйти ничего — иначе сервер решит, что ему прислали пустой ключ на проверку.
  // (С сохранённым ключом поле предзаполнено, и отправка его значения — норма.)
  settingsRespond = () => jsonOk({ ...FULL_SETTINGS, api_key: '', api_secret_set: false });
  const root = await render();
  findButtonByText(root, /Проверить подключение/).click();
  await tick();
  assert.deepStrictEqual(lastTestBody, {});
});

test('501 на проверке — честная строка «недоступна», не «Binotel сломан»', async () => {
  resetServer();
  const root = await render();
  testRespond = err501;
  findButtonByText(root, /Проверить подключение/).click();
  await tick();
  assert.strictEqual(findByRole(root, 'status').textContent, 'Проверка недоступна: сервер ещё не обновлён.');
});

test('адрес для Binotel собирается из public_base_url; без адреса — подсказка вместо URL', async () => {
  resetServer();
  let root = await render();
  const urlBox = findInputs(root).find((n) => 'readonly' in n.attrs);
  assert.ok(urlBox, 'URL показан копируемым readonly-полем');
  assert.strictEqual(urlBox.value, 'https://clinic.example.uz/api/telephony/binotel');

  resetServer();
  settingsRespond = () => jsonOk({ ...FULL_SETTINGS, public_base_url: '' });
  root = await render();
  assert.strictEqual(findInputs(root).find((n) => 'readonly' in n.attrs), undefined);
  assert.ok(textOf(root).includes('Укажите публичный адрес клиники'), 'подсказка вместо мёртвого URL');
});

test('журнал: строки в человеческом виде, пропуски — тире; пациент открывается как из CRM', async () => {
  resetServer();
  const at = new Date(2026, 7, 23, 14, 30, 0);
  callsRespond = () => jsonOk({ calls: [
    { started_at: Math.floor(at.getTime() / 1000), call_type: 0, external_number: '+998901234567',
      internal_number: '101', billsec: 134, waitsec: 6, disposition: 'ANSWER',
      patient_id: 'p-1', patient_name: 'Иванов Иван' },
    { started_at: null, call_type: 1, external_number: null, billsec: null, disposition: 'NOANSWER', patient_id: null },
  ] });
  const navCalls = [];
  const root = await render((view, payload) => navCalls.push([view, payload]));
  const text = textOf(root);
  assert.ok(text.includes('23.08.2026 14:30'), 'время звонка');
  assert.ok(text.includes('2:14'), 'длительность м:сс');
  assert.ok(text.includes('Отвечен'), 'итог человеческим словом');
  assert.ok(text.includes('Без ответа'));
  assert.ok(text.includes('—'), 'пропуски отданы тире');
  assert.ok(text.includes('Входящий') && text.includes('Исходящий'), 'направление словом рядом со стрелкой-иконкой');

  const link = findButtonByText(root, /Иванов Иван/);
  assert.ok(link, 'пациент со связкой — кнопка-ссылка');
  assert.strictEqual(findAllButtons(root).filter((b) => /Карта пациента|Иванов/.test(textOf(b))).length, 1,
    'строка без patient_id ссылки не получает');
  link.click();
  await tick();
  assert.strictEqual(dbCalls, 1, 'пациент добирается из базы по id');
  assert.strictEqual(lastDbBody.table, 'patients');
  assert.deepStrictEqual(navCalls, [['patient-card', { id: 'p-1', full_name: 'Иванов Иван', mrn: 'EM-1', phone: '+998901234567' }]],
    'навигация тем же payload, что crm.js');
});

test('пустой журнал — спокойное «Звонков пока нет.», не пустая таблица', async () => {
  resetServer();
  const root = await render();
  assert.ok(textOf(root).includes('Звонков пока нет.'));
});

// ---------------------------------------------------------------------------
// TELEPHONY_ROUTING_V1 — «Звонки → заявки»
// (docs/plans/2026-08-24-telephony-owns-its-routing.md, tasks 2 and 4)
// ---------------------------------------------------------------------------
// Эти проверки ПЕРЕЕХАЛИ сюда из __tests__/crm-settings.test.mjs вместе с
// самой карточкой: исходы по-русски рядом с сырым кодом, «не создавать» не
// хранит колонку, переключение на «создать» подставляет первую видимую,
// пустой список объясняется словами, и честная строка про модуль — на экране,
// а не в документации. К ним добавилось то, чего на прошлом экране быть не
// могло: счётчик реальных звонков, значок «новое» у исхода без правила и
// пометка «ещё не встречалось» у чисто вендорской строки.

const findSelects = (root) => walk(root).filter((n) => n.tagName === 'SELECT');
// В строке маршрута два списка, и порядок в DOM — [что делать, в какую
// колонку]: ячейки идут именно так, как их читает человек.
const routeSelects = (root) => findSelects(root);

test('карточка «Звонки → заявки»: контракт обоих запросов, исходы по-русски, сырой код рядом', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Звонки → заявки'), 'карточка на экране');
  assert.strictEqual(dispCalls, 1);
  assert.deepStrictEqual(lastDispBody, {}, 'контракт: telephony_dispositions {}');
  // Колонки берутся у CRM её же RPC — второй список колонок здесь разошёлся
  // бы с доской при первом же переименовании.
  assert.strictEqual(cfgGetCalls, 1);
  assert.deepStrictEqual(lastCfgGetBody, {}, 'контракт: crm_config_get {}');

  for (const ru of ['Ответили', 'Не ответили', 'SMS']) assert.ok(text.includes(ru), 'исход по-русски: ' + ru);
  for (const raw of ['ANSWER', 'NOANSWER', 'SMS-SENDING']) assert.ok(text.includes(raw), 'сырой код рядом: ' + raw);
  // Исход, которого экран не знает, показывает себя сырым кодом — иначе
  // правило нельзя было бы даже назвать.
  assert.ok(text.includes('WHATSAPP-IN'), 'незнакомый исход всё равно называет себя');
  // …но ровно один раз: dispositionRu отдаёт неизвестный код как есть, и
  // вторая строка тогда его не повторяет — а у трёх правил SMS-*, которые все
  // называются «SMS», код остаётся единственным различием.
  assert.strictEqual((text.match(/WHATSAPP-IN/g) || []).length, 1, 'код не задваивается');
  assert.ok(text.includes('SMS-SENDING'), 'у исхода с русским именем сырой код на месте');
  assert.ok(text.includes('Правила работают, только пока подключён модуль «Колл-центр»'),
    'честное ограничение на экране, а не в документации');
});

test('наблюдённые исходы носят счётчик, вендорские — «ещё не встречалось», без правила — «новое»', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  // «15 звонков» — число и слово собраны РАЗНЫМИ текстовыми детьми, чтобы
  // «звонков» нашлось в словаре; на экране это по-прежнему одна фраза.
  assert.ok(text.includes('15 звонков'), text.slice(0, 400));
  assert.ok(text.includes('3 звонка'), 'форма множественного числа согласована с числом');
  assert.ok(text.includes('2 звонка'));
  // Строка только из документации: правило задать можно, но такого звонка
  // ещё не было — и это видно.
  assert.ok(text.includes('ещё не встречалось'));
  // Исход без правила сейчас не создаёт НИЧЕГО, и владелец узнаёт об этом
  // здесь, а не через три недели по отсутствию карточек.
  assert.ok(text.includes('новое'), 'значок у исхода, которому правило ещё не задано');
});

test('в списке колонок только ВИДИМЫЕ колонки канбана', async () => {
  resetServer();
  const root = await render();
  const [, firstStage] = routeSelects(root);
  const options = firstStage.children.map((o) => o.attrs.value);
  assert.deepStrictEqual(options, ['in_process', 'recall', 'came'],
    'скрытая колонка не предлагается: сервер такое правило и не сохранит, а заявка в невидимой колонке неотличима от потерянной');
});

test('«не создавать» не хранит колонку; переключение на «создать» само выбирает первую видимую', async () => {
  resetServer();
  const root = await render();
  const [answerAction, answerStage, , , , , smsAction, smsStage] = routeSelects(root);
  assert.ok('disabled' in smsStage.attrs, 'у «не создавать» выбор колонки отключён, а не притворяется рабочим');
  assert.ok(!('disabled' in answerStage.attrs));
  assert.strictEqual(answerAction.children.length, 2, 'выбор ровно из двух действий');

  // ANSWER → «не создавать»: колонка при сохранении обнуляется.
  answerAction.value = 'ignore';
  answerAction.dispatchEvent({ type: 'change' });
  await tick();
  // SMS-SENDING → «создать заявку»: пустая колонка недопустима, подставляется первая видимая.
  const smsAction2 = routeSelects(root)[6];
  smsAction2.value = 'create';
  smsAction2.dispatchEvent({ type: 'change' });
  await tick();

  findButtonByText(root, /Сохранить маршрут/).click();
  await tick();
  assert.strictEqual(cfgSaveCalls, 1);
  assert.deepStrictEqual(Object.keys(lastCfgSaveBody), ['routing'],
    'сохраняется ТОЛЬКО маршрут — колонки и источники этот экран не трогает');
  assert.deepStrictEqual(lastCfgSaveBody.routing, [
    { provider: 'binotel', disposition: 'ANSWER',      action: 'ignore', stage_key: null },
    { provider: 'binotel', disposition: 'NOANSWER',    action: 'create', stage_key: 'recall' },
    { provider: 'binotel', disposition: 'WHATSAPP-IN', action: 'ignore', stage_key: null },
    { provider: 'binotel', disposition: 'SMS-SENDING', action: 'create', stage_key: 'in_process' },
  ]);
});

test('после сохранения карточка перечитывается — значок «новое» считает сервер, а не экран', async () => {
  resetServer();
  const root = await render();
  findButtonByText(root, /Сохранить маршрут/).click();
  await tick();
  assert.strictEqual(dispCalls, 2, 'исходы перечитаны: у того, кому правило только что задали, значка быть не должно');
  assert.strictEqual(cfgGetCalls, 2);
  assert.strictEqual(saveCalls, 0, 'настройки телефонии этой кнопкой не трогаются');
});

test('правило без видимой колонки — отказ ДО обращения к серверу', async () => {
  resetServer();
  // Доска, у которой не осталось ни одной видимой колонки: правило «создать
  // заявку» вести некуда, и это ловится на экране, а не 400-й от сервера.
  cfgGetRespond = () => jsonOk({ ...CRM_CONFIG, stages: CRM_CONFIG.stages.map((s) => ({ ...s, is_active: 0 })) });
  const root = await render();
  findButtonByText(root, /Сохранить маршрут/).click();
  await tick();
  assert.strictEqual(cfgSaveCalls, 0, 'на сервер такое не уходит вовсе');
  assert.ok(/не выбрана видимая колонка/.test(String(lastToast())), lastToast());
});

test('пустой список исходов — спокойное объяснение, а не пустая таблица', async () => {
  resetServer();
  dispRespond = () => jsonOk([]);
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Исходов звонков пока нет.'), text);
  assert.ok(text.includes('Они появятся сами, как только Binotel пришлёт первый звонок.'));
  assert.ok(text.includes('Правила работают, только пока подключён модуль «Колл-центр»'),
    'ограничение видно и в пустом состоянии');
});

test('501 только на маршруте — остальной экран живёт, карточка говорит «недоступен»', async () => {
  resetServer();
  dispRespond = err501;
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Подключение'), 'настройки отрисованы');
  assert.ok(text.includes('Последние звонки'), 'журнал отрисован');
  assert.ok(text.includes('Маршрут звонков недоступен: сервер ещё не обновлён.'), text);
  assert.strictEqual(findSelects(root).length, 0, 'ни одного списка, который нечем наполнить');
});
