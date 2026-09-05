// UPDATE_CONFIRM_V1 (2026-09-05) — «Обновить сейчас» спрашивает, прежде чем
// погасить сервер.
//
// Что здесь стережётся и почему. Эта кнопка — единственная на экране, у
// которой нет ни отсрочки, ни отмены: update_approve({now:true}) ставит
// scheduled_at на текущую секунду (server/services/rpc/updates.js), минутный
// тик подхватывает её, и updater.js выходит через несколько секунд. Ни один
// файл под public/ не вешает beforeunload и нигде нет проверки «форма
// заполнена наполовину», поэтому наполовину заведённая карта пациента,
// незакрытый приём и несохранённый счёт в ДРУГИХ открытых окнах исчезали
// молча — по одному нажатию, которое до сих пор срабатывало сразу.
//
// Три вещи, каждая из которых по отдельности делает кнопку опасной снова:
//   1) вопрос задаётся ДО первого RPC, а не после;
//   2) «Отмена» не устанавливает ничего и оставляет экран рабочим;
//   3) в самом вопросе НАЗВАНО последствие — перезапуск и потеря
//      незаписанного, а в рабочие часы ещё и отключение сотрудников.
//      Диалог «Вы уверены?» без этого — не предупреждение.
//
// Стенд (фейковая DOM + фейковый сервер) — копия того, что уже стоит в
// __tests__/updates-view.test.mjs, урезанная до нужного этому файлу.

import { test } from 'node:test';
import assert from 'node:assert';

import { isWorkingHour } from '../updates-logic.js';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
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
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — прибиваем язык к ru до импорта вида: i18n.js выбирает
// его один раз, при загрузке модуля, иначе на английской локали CI этот файл
// сверял бы русские строки с английскими.
fakeLocalStorage.setItem('admin.lang', 'ru');

// Вопрос задаётся через window.confirm. Записываем КАЖДЫЙ показанный текст и
// отвечаем тем, что положено в confirmAnswer — так проверяется и «Отмена».
let confirmTexts = [];
let confirmAnswer = true;
globalThis.window = {
  location: { hostname: 'localhost' },
  localStorage: fakeLocalStorage,
  addEventListener(){},
  easymed: { state: { user: null } },
  confirm: (text) => { confirmTexts.push(String(text)); return confirmAnswer; },
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.location = { reload: () => {}, hostname: 'localhost' };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findButtonByText = (root, re) => walk(root).filter((n) => n.tagName === 'BUTTON').find((b) => re.test(textOf(b)));

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });

let currentStatus, approveCalls, lastApproveBody;
function resetServer(initial) {
  currentStatus = JSON.parse(JSON.stringify(initial));
  approveCalls = 0; lastApproveBody = null;
  confirmTexts = []; confirmAnswer = true;
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/update_status')) return jsonOk(currentStatus);
  if (u.startsWith('/api/rpc/update_approve')) {
    approveCalls++;
    lastApproveBody = opts && opts.body ? JSON.parse(opts.body) : null;
    currentStatus = { ...currentStatus, approved: true, hour: null, immediate: true, scheduled_at: new Date().toISOString() };
    return jsonOk({ ok: true, version: currentStatus.offer && currentStatus.offer.version, hour: null, immediate: true });
  }
  if (u.startsWith('/api/rpc/licence_status')) return jsonOk({ state: 'ok', locked: false, reason: null, modules: [] });
  return jsonOk({});
};

const { renderUpdates } = await import('../views/updates.js');

const OFFER = { version: '2.4.0', notes_ru: 'Ускорен список чатов.' };
const ADMIN = { id: 1, role: 'admin', is_admin: true, is_super_admin: false };
const FRESH = () => ({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });

test.beforeEach(() => {
  store.clear();
  fakeLocalStorage.setItem('admin.lang', 'ru');
  globalThis.window.easymed.state.user = ADMIN;
});

async function openScreen() {
  const root = mk('div');
  await renderUpdates(root);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  const btn = findButtonByText(root, /Обновить сейчас/);
  assert.ok(btn, 'кнопки «Обновить сейчас» нет на экране: ' + textOf(root));
  return { root, btn };
}

test('«Обновить сейчас» сначала спрашивает — до единственного RPC, а не после', async () => {
  resetServer(FRESH());
  const { btn } = await openScreen();
  btn.click();
  // Синхронно, тем же тиком: если бы вопрос стоял после await, здесь уже
  // висел бы запрос на установку.
  assert.strictEqual(confirmTexts.length, 1, 'вопрос не задан');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(approveCalls, 1, 'после согласия обновление должно быть назначено');
  assert.deepStrictEqual(lastApproveBody, { now: true });
});

test('«Отмена» в вопросе не устанавливает ничего и оставляет экран рабочим', async () => {
  resetServer(FRESH());
  confirmAnswer = false;
  const { btn } = await openScreen();
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(confirmTexts.length, 1);
  assert.strictEqual(approveCalls, 0, 'отказались — а сервер всё равно перезапустили');
  assert.notStrictEqual(btn.disabled, true, 'кнопка осталась заблокированной после отказа');

  // И передумать можно тут же, вторым нажатием, без перезагрузки экрана.
  confirmAnswer = true;
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(approveCalls, 1);
});

test('в вопросе НАЗВАНО последствие: перезапуск и потеря незаписанного', async () => {
  resetServer(FRESH());
  const { btn } = await openScreen();
  btn.click();
  await new Promise((r) => setTimeout(r, 20));

  const text = confirmTexts[0];
  assert.match(text, /Установить обновление сейчас\?/, 'вопрос не назван вопросом: ' + text);
  assert.match(text, /перезапустится/, 'не сказано, что программа перезапустится: ' + text);
  assert.match(text, /пропадёт/, 'не сказано, что незаписанное пропадёт: ' + text);
  // Не «данные могут быть потеряны», а какие именно окна — иначе фразу
  // невозможно соотнести с тем, что у сотрудника сейчас открыто.
  assert.match(text, /карта пациента/, text);
  assert.match(text, /счёт/, text);
});

test('в рабочие часы к вопросу добавляется та же фраза, что предупреждает у выбора часа', async () => {
  resetServer(FRESH());
  const { btn } = await openScreen();
  btn.click();
  await new Promise((r) => setTimeout(r, 20));

  const text = confirmTexts[0];
  const working = isWorkingHour(new Date().getHours());
  const WARN = /клиника обычно работает — сотрудники будут отключены на 1–2 минуты/;
  if (working) {
    assert.match(text, WARN, 'нажали в рабочий час, а про отключение сотрудников не сказано: ' + text);
  } else {
    // Ночью фраза неуместна: предупреждение, которое звучит всегда, перестают
    // читать, и в 11:40 оно уже ничего не значит.
    assert.doesNotMatch(text, WARN, 'нерабочий час, а экран пугает рабочим временем: ' + text);
  }
});

test('запланированные на ночь кнопки вопросов не задают — они ничего не гасят сейчас', async () => {
  resetServer(FRESH());
  const { root } = await openScreen();
  const tonight = findButtonByText(root, /Обновить сегодня ночью/);
  assert.ok(tonight);
  tonight.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(confirmTexts, [], 'лишний вопрос там, где ничего не происходит сейчас');
  assert.strictEqual(approveCalls, 1);
});
