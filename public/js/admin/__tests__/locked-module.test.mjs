// LICENCE_CORE_V1 — the locked-module sales screen.
//
// This view is the best sales surface in the product, so it must never look
// broken. Covers: a successful request disables the button and shows the
// (ru-RU formatted, not raw ISO) date; a second click cannot re-fire the RPC
// while the first is in flight; an already-open request shows ITS original
// date, not today's; an RPC error re-enables the button and shows the retry
// message via the role="status" region; an unknown navId renders the
// fallback instead of throwing.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
const mk=t=>new F(t);
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
globalThis.window={location:{hostname:'localhost'},localStorage:{getItem:()=>null,setItem(){}},addEventListener(){}};
// I18N_LOCALE_PIN_V1 — pins the admin UI language to 'ru' regardless of the
// host OS locale. i18n.js's detect() checks localStorage.getItem('admin.lang')
// (the bare global, NOT window.localStorage above) before ever falling back
// to navigator.language/languages — so without this, the view below renders
// in whatever language the machine running the test defaults to: Russian on
// this dev box, English on GitHub's ubuntu-latest runner, breaking every
// assertion on a Russian string below there, identically, every run. Must be
// set before the view import: i18n.js picks the language once, at its own
// module-load time.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findButton = (root) => walk(root).find((n) => n.tagName === 'BUTTON');
const findByClass = (root, cls) => walk(root).find((n) => String(n.className).split(/\s+/).includes(cls));

// Fetch-response shaped helpers, so each test's mock reads as data, not paren soup.
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 500) => ({ ok: false, status, json: async () => ({ error }) });

// One shared, reassignable RPC responder: each test points it at the answer
// it wants /api/rpc/module_request to give, without re-mocking all of fetch.
let rpcCalls = 0;
let respond = () => jsonOk({ ok: true, already: false, requested_at: '2026-08-20T10:15:00Z' });
// LICENCE_REFRESH_ON_LOCKED_V1 — the screen also asks the vendor again when it
// opens (admins only). Counted separately so the sales-flow tests above stay
// about module_request and nothing else.
let checkNowCalls = 0;
let licenceModules = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/module_request')) { rpcCalls++; return respond(); }
  if (u.startsWith('/api/rpc/update_check_now')) { checkNowCalls++; return jsonOk({ ok: true }); }
  if (u.startsWith('/api/rpc/licence_status')) return jsonOk({ modules: licenceModules });
  return jsonOk({});
};

let reloads = 0;
globalThis.location = { reload: () => { reloads++; }, hostname: 'localhost' };

const { renderLockedModule } = await import('../views/locked-module.js');

test('успешная заявка отключает кнопку и показывает дату (ru-RU, не сырой ISO)', async () => {
  rpcCalls = 0;
  respond = () => jsonOk({ ok: true, already: false, requested_at: '2026-08-20T10:15:00Z' });

  const root = mk('div');
  await renderLockedModule(root, 'crm');
  const cta = findButton(root);
  assert.ok(cta, 'должна быть кнопка «Подключить модуль»');
  assert.ok(textOf(cta).includes('Подключить модуль'), 'исходный текст кнопки: ' + textOf(cta));
  assert.ok(!cta.disabled, 'изначально кнопка активна');

  cta.click();
  assert.strictEqual(cta.disabled, true, 'кнопка блокируется СРАЗУ, синхронно, до ответа RPC');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(rpcCalls, 1);
  assert.match(textOf(cta), /20\.08\.2026/, 'дата показана в ru-RU формате: ' + textOf(cta));
  assert.ok(!textOf(cta).includes('2026-08-20T'), 'сырой ISO-таймстамп не должен просачиваться в текст кнопки: ' + textOf(cta));
  assert.strictEqual(cta.disabled, true, 'после успешной отправки кнопка остаётся заблокированной');

  const foot = findByClass(root, 'lm-foot');
  assert.strictEqual(foot.attrs.role, 'status', 'статус должен объявляться ассистивным технологиям через role="status"');
  assert.match(textOf(foot), /менеджер свяжется/i);
});

test('второй и третий клик не запускают RPC повторно, пока кнопка заблокирована', async () => {
  rpcCalls = 0;
  let resolveFirst;
  respond = () => new Promise((resolve) => {
    resolveFirst = () => resolve(jsonOk({ ok: true, already: false, requested_at: '2026-08-20T10:15:00Z' }));
  });

  const root = mk('div');
  await renderLockedModule(root, 'crm');
  const cta = findButton(root);

  cta.click();   // 1st click: starts the RPC, disables synchronously
  cta.click();   // 2nd click while still pending: must be a no-op
  cta.click();   // 3rd click, same
  assert.strictEqual(rpcCalls, 1, 'ровно один вызов RPC, несмотря на три клика: ' + rpcCalls);

  resolveFirst();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(rpcCalls, 1, 'и после разрешения запроса лишних вызовов не появилось');
});

test('already:true показывает ИСХОДНУЮ дату заявки, а не сегодняшнюю', async () => {
  rpcCalls = 0;
  respond = () => jsonOk({ ok: true, already: true, requested_at: '2026-08-15T09:00:00Z' });

  const root = mk('div');
  await renderLockedModule(root, 'telegram-chat');
  const cta = findButton(root);
  cta.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.match(textOf(cta), /15\.08\.2026/, 'должна остаться дата первой заявки, не сегодняшняя: ' + textOf(cta));
});

test('ошибка RPC разблокирует кнопку и показывает текст «повторите»', async () => {
  rpcCalls = 0;
  respond = () => jsonErr({ message: 'boom' });

  const root = mk('div');
  await renderLockedModule(root, 'crm');
  const cta = findButton(root);

  cta.click();
  assert.strictEqual(cta.disabled, true, 'блокируется сразу при клике');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(cta.disabled, false, 'ошибка должна снова разрешить нажать — офлайн-клиника может повторить позже');
  const foot = findByClass(root, 'lm-foot');
  assert.match(textOf(foot), /Попробуйте ещё раз/, 'должно быть видно сообщение о повторе: ' + textOf(foot));

  // Кнопка не должна была молча "зависнуть" на заявленном тексте успеха.
  assert.doesNotMatch(textOf(cta), /Заявка отправлена/);
});

test('неизвестный navId рендерит заглушку и не бросает исключение', async () => {
  const root = mk('div');
  await assert.doesNotReject(() => renderLockedModule(root, 'no-such-module'));
  assert.match(textOf(root), /Модуль не подключён/);
  assert.strictEqual(findButton(root), undefined, 'без описанного модуля кнопки быть не должно');
});


// --- LICENCE_REFRESH_ON_LOCKED_V1 -------------------------------------------

test('админ: экран сам переспрашивает поставщика и перезагружается, если модуль уже выдан', async () => {
  checkNowCalls = 0; reloads = 0;
  // A granted module is exactly the owner's case: activated in the panel,
  // still locked in the clinic until somebody pressed «Проверить обновления».
  licenceModules = ['crm'];
  globalThis.window.easymed = { state: { user: { role: 'admin' } } };

  const root = mk('div');
  await renderLockedModule(root, 'crm');
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(checkNowCalls, 1, 'один звонок домой при открытии');
  assert.strictEqual(reloads, 1, 'модуль выдан — страница перезагружается в него');
});

test('не админ: экран молчит — update_check_now доступен только администратору', async () => {
  checkNowCalls = 0; reloads = 0;
  licenceModules = ['crm'];
  globalThis.window.easymed = { state: { user: { role: 'registrar' } } };

  const root = mk('div');
  await renderLockedModule(root, 'crm');
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(checkNowCalls, 0, 'регистратор не шлёт запрос, который вернётся 403');
  assert.strictEqual(reloads, 0);
});