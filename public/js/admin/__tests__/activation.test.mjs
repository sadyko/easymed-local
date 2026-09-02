// LICENCE_CORE_V1 — the activation screen a lapsed clinic sees before ANY
// module, including the free clinical core (see locked-module.test.mjs for
// the per-module sales screen this one takes precedence over).
//
// Covers: the 'unpaid' heading is money-flavoured, the 'offline' heading is
// not; the telephone challenge renders when the RPC returns one; a successful
// unlock shows the success line; a failed unlock (including the exact 403 a
// non-admin gets back — "Только администратор может активировать.") re-enables
// the button and shows the SERVER's message, not a generic wrapper; and a
// licence_status fetch that fails outright (a locked clinic is often offline)
// still leaves a fully usable screen instead of throwing.

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
// The activation screen renders an Icon() (see ui.js's Icon -> html(), which
// parses via a <template> and reads tpl.content.firstChild) — locked-module.js
// has no icon so its own test fixture never needed this; borrowed from
// accommodation-live.test.mjs, the other fixture in this suite that does.
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
const findInput  = (root) => walk(root).find((n) => n.tagName === 'INPUT');
const findByClass = (root, cls) => walk(root).find((n) => String(n.className).split(/\s+/).includes(cls));

// Fetch-response shaped helpers, so each test's mock reads as data, not paren soup.
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

// Independent, reassignable responders — one per RPC name — so a test can
// point any of them at whatever answer it wants without re-mocking all of fetch.
let statusCalls = 0, unlockCalls = 0, enrollCalls = 0, enrollBody = null;
let statusRespond = () => jsonOk({ state: 'locked', locked: true, reason: 'offline', days_left: 0, modules: [], challenge: null });
let unlockRespond = () => jsonOk({ ok: true, until: '2026-09-03T00:00:00Z' });
let enrollRespond = () => jsonOk({ ok: true, clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед' });
let pairCalls = 0, pairBody = null;
let pairRespond = () => jsonOk({ ok: true, role: 'secondary', group_id: 'g-1', letter: 'Б' });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/licence_status')) { statusCalls++; return statusRespond(); }
  if (u.startsWith('/api/rpc/licence_unlock')) { unlockCalls++; return unlockRespond(); }
  if (u.startsWith('/api/rpc/licence_enroll')) { enrollCalls++; try { enrollBody = JSON.parse(init?.body ?? 'null'); } catch { enrollBody = null; } return enrollRespond(); }
  if (u.startsWith('/api/rpc/branch_sync_pair')) { pairCalls++; try { pairBody = JSON.parse(init?.body ?? 'null'); } catch { pairBody = null; } return pairRespond(); }
  return jsonOk({});
};

const { renderActivation } = await import('../views/activation.js');

test('неоплаченная подписка — заголовок про деньги, а не про связь', async () => {
  statusRespond = () => jsonOk({ challenge: null });
  const root = mk('div');
  await renderActivation(root, { reason: 'unpaid', days_left: 0, locked: true, state: 'locked' });
  assert.match(textOf(root), /Подписка не активна/);
});

test('офлайн — заголовок про связь, а НЕ денежный заголовок «Подписка не активна»', async () => {
  // The reassurance line ("...Пока подписка не активна...") is shown in BOTH
  // states — the spec itself mandates that exact wording unconditionally — so
  // this test does not assert the word "подписка" is absent everywhere on the
  // screen (that copy is neutral/factual, not an accusation of non-payment).
  // What must never appear for an offline clinic is the MONEY-FLAVOURED
  // HEADING itself: that is the one line this task's whole rule is about.
  statusRespond = () => jsonOk({ challenge: null });
  const root = mk('div');
  await renderActivation(root, { reason: 'offline', days_left: 0, locked: true, state: 'locked' });
  const text = textOf(root);
  assert.match(text, /Нет связи с Easy-Med/, 'должен быть заголовок про связь: ' + text);
  assert.doesNotMatch(text, /Подписка не активна/, 'платящая клиника не должна видеть денежный заголовок: ' + text);
});

test('код авторизации отображается крупно и моноширинно, когда RPC его вернул', async () => {
  statusRespond = () => jsonOk({ challenge: 'AB3CD9' });
  const root = mk('div');
  await renderActivation(root, { reason: 'offline', days_left: 0, locked: true, state: 'locked' });
  const call = findByClass(root, 'act-call');
  const code = findByClass(root, 'act-code');
  assert.ok(call, 'должна быть строка "позвоните менеджеру"');
  assert.match(textOf(call), /Позвоните менеджеру Easy-Med/);
  assert.ok(code, 'код должен отображаться');
  assert.strictEqual(textOf(code), 'AB3CD9');
});

test('без кода в ответе (клиника офлайн) — экран всё равно рабочий, кода просто нет', async () => {
  statusRespond = () => jsonOk({ challenge: null });
  const root = mk('div');
  await renderActivation(root, { reason: 'offline', days_left: 0, locked: true, state: 'locked' });
  assert.strictEqual(findByClass(root, 'act-code'), undefined, 'без challenge код не рисуется');
  assert.ok(findButton(root), 'кнопка активации должна остаться доступной');
});

test('успешная активация показывает «Система разблокирована.»', async () => {
  statusRespond = () => jsonOk({ challenge: 'ZZ9988' });
  unlockRespond = () => jsonOk({ ok: true, until: '2026-09-03T00:00:00Z' });
  unlockCalls = 0;

  const root = mk('div');
  await renderActivation(root, { reason: 'unpaid', days_left: 0, locked: true, state: 'locked' });
  const input = findInput(root);
  input.value = 'AAAAA-BBBBB';
  const btn = findButton(root);
  btn.click();
  assert.strictEqual(btn.disabled, true, 'кнопка блокируется сразу, синхронно, до ответа RPC');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(unlockCalls, 1);
  const status = findByClass(root, 'act-status');
  assert.match(textOf(status), /Система разблокирована/);
});

test('неверный код (в т.ч. отказ non-admin 403) снова разрешает нажать и показывает ИМЕННО ответ сервера', async () => {
  statusRespond = () => jsonOk({ challenge: 'ZZ9988' });
  // The exact message server/services/rpc/licence.js sends a non-admin — the
  // concrete case the spec calls out: a non-admin must see WHY they can't
  // activate, not a raw error object.
  unlockRespond = () => jsonErr({ message: 'Только администратор может активировать.' }, 403);
  unlockCalls = 0;

  const root = mk('div');
  await renderActivation(root, { reason: 'unpaid', days_left: 0, locked: true, state: 'locked' });
  const input = findInput(root);
  input.value = 'WRONG-CODE1';
  const btn = findButton(root);
  btn.click();
  assert.strictEqual(btn.disabled, true, 'блокируется сразу при клике');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(btn.disabled, false, 'ошибка должна снова разрешить нажать');
  const status = findByClass(root, 'act-status');
  assert.match(textOf(status), /Только администратор может активировать/, 'должен быть виден ИМЕННО ответ сервера: ' + textOf(status));
  assert.doesNotMatch(textOf(status), /Система разблокирована/);
});

test('падение licence_status (клиника офлайн) не ломает экран — заголовок, форма и кнопка всё равно есть', async () => {
  statusRespond = () => { throw new Error('network down'); };
  const root = mk('div');
  await assert.doesNotReject(() => renderActivation(root, { reason: 'offline', days_left: 0, locked: true, state: 'locked' }));
  assert.match(textOf(root), /Нет связи с Easy-Med/);
  assert.ok(findInput(root), 'поле ввода кода должно остаться доступным');
  assert.ok(findButton(root), 'кнопка «Активировать» должна остаться доступной');
  assert.strictEqual(findByClass(root, 'act-code'), undefined, 'без ответа RPC кода нет — это нормальное состояние, не ошибка');
});

// --- ENROLLMENT_SCREEN_V1 — the not_enrolled (first-run) branch --------------
//
// A brand-new install is NOT offline and does NOT owe money; before this
// branch existed it fell into the offline heading — told its internet was
// broken and offered a telephone-unlock field that cannot work (unlock needs
// an unlock_secret, which only enrollment creates).

test('не привязана — заголовок про активацию, а не про связь и не про деньги', async () => {
  statusRespond = () => jsonOk({ challenge: 'AB3CD9' });
  const root = mk('div');
  await renderActivation(root, { reason: 'not_enrolled', days_left: 0, locked: true, state: 'locked' });
  const text = textOf(root);
  assert.match(text, /Активация Easy-Med/, 'заголовок первой установки: ' + text);
  assert.doesNotMatch(text, /Нет связи с Easy-Med/, 'новой установке нельзя говорить, что её интернет сломан');
  assert.doesNotMatch(text, /Подписка не активна/, 'и нельзя обвинять её в неоплате');
  assert.match(text, /Введите код активации, полученный от менеджера Easy-Med\./);
});

test('не привязана — поле под EM-код, без телефонного кода разблокировки', async () => {
  statusRespond = () => jsonOk({ challenge: 'AB3CD9' });
  const root = mk('div');
  await renderActivation(root, { reason: 'not_enrolled', days_left: 0, locked: true, state: 'locked' });
  const input = findInput(root);
  assert.ok(input, 'поле ввода кода активации должно быть');
  assert.strictEqual(input.attrs.placeholder, 'EM-XXXX-XXXX', 'формат кода активации, не формат кода разблокировки');
  // Даже когда licence_status вернул challenge — на этом экране он бесполезен:
  // разблокировка по телефону требует unlock_secret, которого ещё нет.
  assert.strictEqual(findByClass(root, 'act-call'), undefined, 'строки «позвоните менеджеру» быть не должно');
  assert.strictEqual(findByClass(root, 'act-code'), undefined, 'телефонный код показывать не нужно');
  // Строка про «данные на месте» — про ЛАПС, у первой установки данных ещё нет.
  assert.doesNotMatch(textOf(root), /Данные клиники на месте/);
});

test('успешная активация кодом вызывает licence_enroll и показывает «Система активирована.»', async () => {
  statusRespond = () => jsonOk({ challenge: null });
  enrollRespond = () => jsonOk({ ok: true, clinic_id: 'c-000051', clinic_name: 'Нурафшон Мед' });
  enrollCalls = 0; enrollBody = null;
  const before = unlockCalls;

  const root = mk('div');
  await renderActivation(root, { reason: 'not_enrolled', days_left: 0, locked: true, state: 'locked' });
  const input = findInput(root);
  input.value = ' em-7k4q-9xzp ';
  const btn = findButton(root);
  btn.click();
  assert.strictEqual(btn.disabled, true, 'кнопка блокируется сразу, синхронно, до ответа RPC');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(enrollCalls, 1);
  assert.strictEqual(unlockCalls, before, 'licence_unlock здесь ни при чём');
  assert.strictEqual(enrollBody.code, ' em-7k4q-9xzp ', 'нормализация — дело сервера; экран шлёт как есть');
  assert.match(textOf(findByClass(root, 'act-status')), /Система активирована/);
});

test('неверный EM-код снова разрешает нажать и показывает ИМЕННО ответ сервера', async () => {
  statusRespond = () => jsonOk({ challenge: null });
  enrollRespond = () => jsonErr({ message: 'Код неверный. Проверьте и введите ещё раз.' }, 400);
  enrollCalls = 0;

  const root = mk('div');
  await renderActivation(root, { reason: 'not_enrolled', days_left: 0, locked: true, state: 'locked' });
  findInput(root).value = 'EM-WRONG-CODE';
  const btn = findButton(root);
  btn.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(btn.disabled, false, 'ошибка должна снова разрешить нажать');
  const status = findByClass(root, 'act-status');
  assert.match(textOf(status), /Код неверный\. Проверьте и введите ещё раз\./, 'должен быть виден ИМЕННО ответ сервера: ' + textOf(status));
  assert.doesNotMatch(textOf(status), /Система активирована/);
});

// BRANCH_FIRST_RUN_V1 — второй шаг первого запуска. У филиала СВОЯ подписка и
// свой код активации (на control plane это отдельная клиника), поэтому шаг 1
// обязателен и для него; ключ филиала не активирует, а присоединяет уже
// активированную установку к главной клинике.
test('после активации предлагается подключить филиал, и ключ уходит в branch_sync_pair', async () => {
  statusRespond = () => jsonOk({ challenge: null });
  enrollRespond = () => jsonOk({ ok: true, clinic_id: 'c-000052', clinic_name: 'Филиал Б' });
  pairCalls = 0; pairBody = null;

  const root = mk('div');
  await renderActivation(root, { reason: 'not_enrolled', days_left: 0, locked: true, state: 'locked' });
  findInput(root).value = 'EM-1111-2222';
  findButton(root).click();
  await new Promise((r) => setTimeout(r, 20));

  // Экран сначала ПОКАЗЫВАЕТ «Система активирована», и только потом уходит на
  // шаг 2 — иначе подтверждение мелькнуло бы и человек не понял, что сработало.
  assert.match(textOf(findByClass(root, 'act-status')), /Система активирована/);
  await new Promise((r) => setTimeout(r, 1300));

  const keyInput = findInput(root);
  assert.ok(keyInput, 'на шаге 2 есть поле для ключа филиала');
  keyInput.value = 'BR-TEST-KEY';
  const buttons = walk(root).filter((n) => n.tagName === 'BUTTON');
  buttons[0].click();
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(pairCalls, 1, 'ключ филиала уходит в branch_sync_pair');
  assert.strictEqual(pairBody.key, 'BR-TEST-KEY');
});

test('главная клиника пропускает шаг филиала, не вызывая branch_sync_pair', async () => {
  statusRespond = () => jsonOk({ challenge: null });
  enrollRespond = () => jsonOk({ ok: true, clinic_id: 'c-000053', clinic_name: 'Главная' });
  pairCalls = 0;

  const root = mk('div');
  await renderActivation(root, { reason: 'not_enrolled', days_left: 0, locked: true, state: 'locked' });
  findInput(root).value = 'EM-3333-4444';
  findButton(root).click();
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 1300));

  const buttons = walk(root).filter((n) => n.tagName === 'BUTTON');
  assert.ok(buttons.length >= 2, 'есть кнопка «пропустить»');
  buttons[1].click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(pairCalls, 0, 'пропуск ничего не связывает');
});
