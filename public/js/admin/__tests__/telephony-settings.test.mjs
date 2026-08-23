// TELEPHONY_V1 (docs/plans/2026-08-23-binotel-telephony.md, Task 2) — the
// Settings → «Телефония» screen against the EXACT RPC contract the parallel
// server task is building to.
//
// Covers: all four sections render and telephony_settings_get is called with
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

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// --- fake server ----------------------------------------------------------
// Answers exactly the plan's RPC contract, so every call site is asserted
// against the same shape the parallel server task is building to.
let getCalls, saveCalls, testCalls, callsCalls, dbCalls;
let lastGetBody, lastSaveBody, lastTestBody, lastCallsBody, lastDbBody;
let settingsRespond, saveRespond, testRespond, callsRespond, dbRespond;

const FULL_SETTINGS = {
  enabled: true, provider: 'binotel', api_key: 'key-live', api_secret_set: true, company_id: '12345',
  poll_interval_sec: 30, webhooks_enabled: false, public_base_url: 'https://clinic.example.uz',
  last_poll_at: '2026-08-23T09:00:00', last_call_at: null, last_error: null,
};

function resetServer() {
  getCalls = 0; saveCalls = 0; testCalls = 0; callsCalls = 0; dbCalls = 0;
  lastGetBody = null; lastSaveBody = null; lastTestBody = null; lastCallsBody = null; lastDbBody = null;
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
  if (u.startsWith('/api/db')) { dbCalls++; lastDbBody = body; return dbRespond(); }
  return jsonOk({});
};

const { renderTelephonySettings } = await import('../views/telephony-settings.js');

async function render(onNavigate) {
  const root = mk('div');
  await renderTelephonySettings(root, { onNavigate });
  await tick();   // журнал звонков грузится после отрисовки настроек
  return root;
}

test('все четыре секции рисуются; get вызван ровно с {}; secret говорит «сохранён» плейсхолдером', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  for (const section of ['Подключение', 'Опрос звонков', 'WebHook-и', 'Последние звонки']) {
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
