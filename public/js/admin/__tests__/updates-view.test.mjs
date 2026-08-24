// UPDATE_DELIVERY_V1 (docs/plans/2026-08-20-update-delivery.md, Task 6) — the
// approval screen (views/updates.js).
//
// Covers: an offer's notes_ru renders as literal TEXT, never as markup
// (`<b>evil</b>` must never become a real <b> element — see sanitize note in
// updates.js); the one-action consent+time rule (a single click on «Обновить
// сегодня ночью» calls update_approve with the resolved hour and the SAME
// screen repaints straight into the scheduled state, never a second
// screen); a double-click cannot fire the RPC twice; an RPC failure
// mid-approve re-enables the controls and leaves nothing half-approved; a
// non-admin actor sees the offer/status but no action buttons at all; a
// working-hour custom pick warns without disabling anything; «Изменить
// время»/«Отменить» both go through update_cancel and land back on the
// picker; a failed-and-rolled-back last_result is said plainly; a 10,000-
// character notes_ru still renders in full (no truncation — CSS clamps,
// this test proves the STRING itself survives intact); and the calm
// no-offer state.

import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/activation.test.mjs (itself
// borrowed from accommodation-live.test.mjs) because this view also renders
// Icon() calls, which go through ui.js's html() -> a <template> parse.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 // UPDATE_DELIVERY_V1 — the one addition over the borrowed harness: a real
 // browser reflects the `value` CONTENT ATTRIBUTE onto the live `.value`
 // PROPERTY until the user types (this is how h('input', {value: '3'}) ends
 // up readable as `el.value === '3'` in production). Neither locked-module's
 // nor activation's fixtures ever needed this (their inputs are never given
 // an initial `value` prop), but views/updates.js's hour picker is.
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

// A real, Map-backed localStorage (not the inert stub other fixtures use) —
// this view actually persists last-seen-version/notes-cache, and several
// tests below assert on that persistence.
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
// views/updates.js calls the bare global `localStorage`, same convention as
// i18n.js — both must point at the SAME store as window.localStorage.
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js's detect() also reads this same store, via
// this same bare global, for its OWN key ('admin.lang') — before ever
// falling back to navigator.language/languages. Pre-seeding it here pins the
// UI language to 'ru' regardless of the host OS locale, so this file's many
// assertions on rendered Russian strings hold on GitHub's English-locale
// ubuntu-latest runner the same way they already do on a Russian-locale dev
// machine. Must happen before the view import below: i18n.js picks the
// language once, at its own module-load time.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));
const findInput  = (root) => walk(root).find((n) => n.tagName === 'INPUT');
const findByClass = (root, cls) => walk(root).find((n) => String(n.className).split(/\s+/).includes(cls));
const findAllByClass = (root, cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

// --- fake server ----------------------------------------------------------
// currentStatus is mutated by the approve/cancel mocks exactly the way the
// real RPCs mutate control_state, so a full round trip (approve -> re-fetch
// -> repaint) behaves like the real thing instead of needing every test to
// hand-author two disagreeing canned responses.
let currentStatus, approveCalls, cancelCalls, statusCalls, approveShouldFail, statusShouldFail, lastApproveBody;
// «Проверить обновления» — checkNowMutate stands in for what a real check-in
// does server-side (a new offer lands, the licence moves) so the round trip
// click -> check-in -> fresh status behaves like the real thing, same idea as
// the approve/cancel mocks above.
let checkNowCalls, checkNowShouldFail, checkNowMutate, licenceStatusData;

function resetServer(initial) {
  currentStatus = JSON.parse(JSON.stringify(initial));
  approveCalls = 0; cancelCalls = 0; statusCalls = 0; approveShouldFail = false; statusShouldFail = false; lastApproveBody = null;
  checkNowCalls = 0; checkNowShouldFail = false; checkNowMutate = null;
  licenceStatusData = { state: 'ok', locked: false, reason: null, modules: [] };
}

// UPDATE_PAGE_RELOAD_V1 — the view reloads the tab once the server comes back
// on a new version. Counted so the tests can prove it happens exactly once,
// and does NOT happen when nothing is installing.
let reloads = 0;
globalThis.location = { reload: () => { reloads++; }, hostname: 'localhost' };

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/update_status')) {
    statusCalls++;
    if (statusShouldFail) throw new Error('network down');
    return jsonOk(currentStatus);
  }
  if (u.startsWith('/api/rpc/update_approve')) {
    approveCalls++;
    lastApproveBody = opts && opts.body ? JSON.parse(opts.body) : null;
    if (approveShouldFail) return jsonErr({ message: 'boom' });
    const hour = lastApproveBody && lastApproveBody.hour;
    currentStatus = { ...currentStatus, approved: true, hour, scheduled_at: new Date(2026, 7, 22, hour, 0, 0).toISOString() };
    return jsonOk({ ok: true, version: currentStatus.offer && currentStatus.offer.version, hour, scheduled_at: currentStatus.scheduled_at });
  }
  if (u.startsWith('/api/rpc/update_cancel')) {
    cancelCalls++;
    currentStatus = { ...currentStatus, approved: false, hour: null, scheduled_at: null };
    return jsonOk({ ok: true });
  }
  if (u.startsWith('/api/rpc/update_check_now')) {
    checkNowCalls++;
    if (checkNowShouldFail) return jsonErr({ message: 'boom' });
    if (checkNowMutate) checkNowMutate();
    return jsonOk({ ok: true, ...currentStatus });
  }
  if (u.startsWith('/api/rpc/licence_status')) {
    return jsonOk(licenceStatusData);
  }
  return jsonOk({});
};

const { renderUpdates } = await import('../views/updates.js');

const OFFER = { version: '2.4.0', notes_ru: 'Ускорен список чатов.' };

function setUser(u) { globalThis.window.easymed.state.user = u; }
const ADMIN = { id: 1, role: 'admin', is_admin: true, is_super_admin: false };
const REGISTRAR = { id: 2, role: 'registrar', is_admin: false, is_super_admin: false };

test.beforeEach(() => {
  fakeLocalStorage.clear();
  setUser(ADMIN);
});

// --- XSS: notes_ru renders as text, never markup -----------------------------

test('notes_ru c "<b>evil</b>" рендерится как ТЕКСТ, а не как реальный <b>-элемент', async () => {
  resetServer({ current_version: '2.3.0', offer: { version: '2.4.0', notes_ru: '<b>evil</b>' }, approved: false, hour: null, scheduled_at: null, last_result: null });
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');   // не мешаем "что нового" в этом тесте

  const root = mk('div');
  await renderUpdates(root);

  assert.match(textOf(root), /<b>evil<\/b>/, 'буквальный текст должен присутствовать: ' + textOf(root));
  const bTag = walk(root).find((n) => n.tagName === 'B');
  assert.strictEqual(bTag, undefined, 'ни в коем случае не должен появиться настоящий <b>-элемент');
});

// --- one action = consent + time -------------------------------------------

test('«Обновить сегодня ночью» вызывает update_approve с часом 3 и экран сразу переходит в «подтверждено» (без второго экрана)', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');

  const root = mk('div');
  await renderUpdates(root);
  const tonightBtn = findButtonByText(root, /Обновить сегодня ночью/);
  assert.ok(tonightBtn, 'должна быть основная кнопка');
  tonightBtn.click();
  assert.strictEqual(tonightBtn.disabled, true, 'блокируется сразу, синхронно, до ответа RPC');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(approveCalls, 1);
  assert.strictEqual(lastApproveBody.hour, 3, 'резервный ночной час — 3, отправлен без второго экрана');
  assert.match(textOf(root), /Компьютер должен быть включён/, 'та самая нагрузочная последняя фраза должна появиться: ' + textOf(root));
});

test('«Обновить завтра ночью» тоже отправляет час 3 (следующая ночь, тот же час)', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  const root = mk('div');
  await renderUpdates(root);
  findButtonByText(root, /Обновить завтра ночью/).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(approveCalls, 1);
  assert.strictEqual(lastApproveBody.hour, 3);
});

test('«Другое время» — свой час, включая рабочее время: предупреждение показывается, но кнопка НЕ блокируется', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  const root = mk('div');
  await renderUpdates(root);
  const hourInput = findInput(root);
  assert.ok(hourInput, 'должно быть поле для своего часа');

  hourInput.value = '10';
  hourInput.dispatchEvent({ type: 'input' });
  const warn = findByClass(root, 'upd-hour-warn');
  assert.notEqual(warn.style.display, 'none', 'в рабочее время (10:00) должно появиться предупреждение');

  const customBtn = findButtonByText(root, /Запланировать/);
  assert.ok(!customBtn.disabled, 'кнопка не должна быть заблокирована предупреждением');
  customBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(approveCalls, 1, 'предупреждение не должно было блокировать отправку');
  assert.strictEqual(lastApproveBody.hour, 10, 'это их клиника — они могли выбрать рабочее время осознанно');
});

test('«Другое время» ночью — предупреждения нет', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  const root = mk('div');
  await renderUpdates(root);
  const hourInput = findInput(root);
  hourInput.value = '4';
  hourInput.dispatchEvent({ type: 'input' });
  const warn = findByClass(root, 'upd-hour-warn');
  assert.equal(warn.style.display, 'none');
});

// --- ATTACK: double-click ------------------------------------------------------

test('двойной клик по «сегодня ночью» — RPC вызывается РОВНО один раз', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  const root = mk('div');
  await renderUpdates(root);
  const btn = findButtonByText(root, /Обновить сегодня ночью/);
  btn.click();
  btn.click();
  btn.click();
  assert.strictEqual(approveCalls, 1, 'ровно один вызов, несмотря на три клика: ' + approveCalls);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(approveCalls, 1, 'и после ответа лишних вызовов не появилось');
});

// --- ATTACK: RPC failure mid-approve --------------------------------------------

test('ошибка RPC при approve — кнопки разблокируются, ничего не утверждено наполовину', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  approveShouldFail = true;
  const root = mk('div');
  await renderUpdates(root);
  const btn = findButtonByText(root, /Обновить сегодня ночью/);
  btn.click();
  assert.strictEqual(btn.disabled, true, 'блокируется сразу при клике');
  await new Promise((r) => setTimeout(r, 20));

  assert.strictEqual(btn.disabled, false, 'ошибка сети/клиники офлайн — должна снова разрешить нажать');
  const status = findByClass(root, 'upd-action-status');
  assert.match(textOf(status), /Попробуйте ещё раз/, 'должно быть видно сообщение о повторе');
  assert.strictEqual(currentStatus.approved, false, 'ничего не должно было утвердиться на "сервере"');
  assert.doesNotMatch(textOf(root), /Обновление подтверждено/, 'экран не должен молча перейти в подтверждённое состояние');
});

// --- non-admin: read-only ----------------------------------------------------

test('неадмин видит статус предложения, но не видит НИ ОДНОЙ кнопки действия', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: false, hour: null, scheduled_at: null, last_result: null });
  setUser(REGISTRAR);
  const root = mk('div');
  await renderUpdates(root);
  assert.match(textOf(root), /2\.4\.0/, 'версия предложения должна быть видна: ' + textOf(root));
  assert.deepEqual(findAllButtons(root), [], 'у не-администратора не должно быть ни одной кнопки на этом экране');
  assert.match(textOf(root), /Только администратор/, 'должно быть объяснение, почему кнопок нет');
});

test('неадмин на УЖЕ подтверждённом обновлении видит время, но не «Изменить»/«Отменить», и не видит устаревшую фразу про администратора', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: true, hour: 3, scheduled_at: new Date(2026, 7, 22, 3, 0, 0).toISOString(), last_result: null });
  setUser(REGISTRAR);
  const root = mk('div');
  await renderUpdates(root);
  assert.match(textOf(root), /Компьютер должен быть включён/);
  assert.deepEqual(findAllButtons(root), []);
  assert.doesNotMatch(textOf(root), /Только администратор может подтвердить/, 'уже подтверждено — эта фраза больше не имеет смысла');
});

// --- change / cancel ------------------------------------------------------------

test('«Отменить» вызывает update_cancel и возвращает к выбору времени (пере-одобрение без отдельного экрана)', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: true, hour: 3, scheduled_at: new Date(2026, 7, 22, 3, 0, 0).toISOString(), last_result: null });
  const root = mk('div');
  await renderUpdates(root);
  const cancelBtn = findButtonByText(root, /Отменить/);
  assert.ok(cancelBtn);
  cancelBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(cancelCalls, 1);
  assert.ok(findButtonByText(root, /Обновить сегодня ночью/), 'после отмены снова доступен выбор времени');
});

test('«Изменить время» тоже идёт через cancel, затем показывает пикер снова', async () => {
  resetServer({ current_version: '2.3.0', offer: OFFER, approved: true, hour: 3, scheduled_at: new Date(2026, 7, 22, 3, 0, 0).toISOString(), last_result: null });
  const root = mk('div');
  await renderUpdates(root);
  findButtonByText(root, /Изменить время/).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(cancelCalls, 1);
  assert.ok(findButtonByText(root, /Обновить завтра ночью/));
});

// --- last_result: failed & rolled back ------------------------------------------

test('провалившееся обновление показывается прямо, с версией и датой', async () => {
  resetServer({
    current_version: '2.3.0', offer: null, approved: false, hour: null, scheduled_at: null,
    last_result: { version: '2.4.0', ok: false, at: '2026-08-21T02:00:00.000Z', db: 'untouched' },
  });
  const root = mk('div');
  await renderUpdates(root);
  const text = textOf(root);
  assert.match(text, /2\.4\.0/);
  assert.match(text, /21\.08\.2026/);
  assert.match(text, /не удалось/);
  assert.match(text, /2\.3\.0/, 'версия, к которой откатились, тоже должна быть видна');
});

// --- calm no-offer state --------------------------------------------------------

test('нет предложения — спокойный экран «У вас последняя версия — 2.3.0»', async () => {
  resetServer({ current_version: '2.3.0', offer: null, approved: false, hour: null, scheduled_at: null, last_result: null });
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  const root = mk('div');
  await renderUpdates(root);
  assert.match(textOf(root), /У вас последняя версия/);
  assert.match(textOf(root), /2\.3\.0/);
  assert.strictEqual(findByClass(root, 'upd-offer'), undefined, 'без предложения не должно быть карточки предложения');
});

// --- notes_ru of 10,000 characters — no truncation ------------------------------

test('notes_ru длиной 10 000 символов рендерится ПОЛНОСТЬЮ (обрезка — дело CSS, не строки)', async () => {
  const longNotes = 'A'.repeat(10000);
  resetServer({ current_version: '2.3.0', offer: { version: '2.4.0', notes_ru: longNotes }, approved: false, hour: null, scheduled_at: null, last_result: null });
  const root = mk('div');
  await assert.doesNotReject(() => renderUpdates(root));
  const notesEl = findByClass(root, 'upd-notes');
  assert.ok(notesEl);
  assert.strictEqual(textOf(notesEl).length, 10000, 'строка не должна обрезаться на уровне рендера');
});

// --- what's new, one-time --------------------------------------------------------

test('«Что нового» показывается один раз при смене текущей версии, с закэшированными заметками', async () => {
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  fakeLocalStorage.setItem('em.updates.notesCache', JSON.stringify({ '2.4.0': 'Ускорен список чатов.' }));
  resetServer({ current_version: '2.4.0', offer: null, approved: false, hour: null, scheduled_at: null, last_result: null });

  const root1 = mk('div');
  await renderUpdates(root1);
  assert.match(textOf(root1), /Что нового в версии 2\.4\.0/);
  assert.match(textOf(root1), /Ускорен список чатов/);

  // Second render (e.g. navigating back to this screen again) must not
  // repeat the note — it already updated lastSeenVersion to 2.4.0.
  const root2 = mk('div');
  await renderUpdates(root2);
  assert.doesNotMatch(textOf(root2), /Что нового/, 'заметка одноразовая — второй показ не нужен');
});

// --- initial load failure --------------------------------------------------------

test('первичная загрузка update_status падает (клиника офлайн) — экран остаётся рабочим, с понятным сообщением, а не падает сам', async () => {
  resetServer({ current_version: '2.3.0', offer: null, approved: false, hour: null, scheduled_at: null, last_result: null });
  statusShouldFail = true;
  const root = mk('div');
  await assert.doesNotReject(() => renderUpdates(root));
  assert.match(textOf(root), /Не удалось загрузить статус обновления/, textOf(root));
});

// --- «Проверить обновления» -----------------------------------------------------

const CALM = { current_version: '2.3.0', offer: null, approved: false, hour: null, scheduled_at: null, last_result: null };

test('«Проверить обновления»: клик делает один check-in и сразу перерисовывает свежий статус', async () => {
  resetServer(CALM);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  const root = mk('div');
  await renderUpdates(root);
  assert.match(textOf(root), /У вас последняя версия/);

  const btn = findButtonByText(root, /Проверить обновления/);
  assert.ok(btn, 'админ должен видеть кнопку проверки');
  // The "check-in" delivers a fresh offer — the SAME click must repaint it,
  // never require a page reload or a second navigation to this screen.
  checkNowMutate = () => { currentStatus = { ...currentStatus, offer: OFFER }; };
  btn.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(checkNowCalls, 1);
  assert.match(textOf(root), /Доступно обновление/);
  assert.match(textOf(root), /2\.4\.0/);
  assert.equal(btn.disabled, false, 'кнопка снова доступна для следующей проверки');
});

test('«Проверить обновления»: двойной клик не делает второй check-in', async () => {
  resetServer(CALM);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  const root = mk('div');
  await renderUpdates(root);
  const btn = findButtonByText(root, /Проверить обновления/);
  btn.click();
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(checkNowCalls, 1, 'повторный клик до ответа сервера — no-op');
});

test('«Проверить обновления»: не-админ кнопку не видит вовсе', async () => {
  resetServer(CALM);
  setUser(REGISTRAR);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  const root = mk('div');
  await renderUpdates(root);
  assert.equal(findButtonByText(root, /Проверить обновления/), undefined,
    'проверка — вендорское действие админа, как approve/cancel');
});

test('«Проверить обновления»: сбой проверки — кнопка снова активна и на экране объяснение', async () => {
  resetServer(CALM);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  const root = mk('div');
  await renderUpdates(root);
  const btn = findButtonByText(root, /Проверить обновления/);
  checkNowShouldFail = true;
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(checkNowCalls, 1);
  assert.match(textOf(root), /Не удалось проверить обновления/);
  assert.equal(btn.disabled, false, 'после сбоя можно пробовать снова');
});

test('«Проверить обновления»: check-in привёз изменение лицензии (выдан модуль) — экран готовит перезагрузку, а не тихую перерисовку', async () => {
  resetServer(CALM);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');
  // licence.js's module-level state is untouched in this harness (modules: []),
  // so a licence_status answer naming a module IS a change.
  licenceStatusData = { state: 'ok', locked: false, reason: null, modules: ['crm'] };
  checkNowMutate = () => { currentStatus = { ...currentStatus, offer: OFFER }; };
  const root = mk('div');
  await renderUpdates(root);
  const btn = findButtonByText(root, /Проверить обновления/);
  btn.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(checkNowCalls, 1);
  // The reload path must NOT paint the fetched offer — the whole app is about
  // to re-read its licence; painting half-fresh state first would flash and
  // then vanish. (location.reload itself is unreachable in this fake window —
  // the view wraps it in try/catch by design, same as activation.js.)
  assert.doesNotMatch(textOf(root), /Доступно обновление/,
    'при смене лицензии экран уходит в перезагрузку, не в перерисовку');
});


// --- UPDATE_PAGE_RELOAD_V1 ---------------------------------------------------

test('идёт установка: экран сам перезагружается, когда сервер вернулся на новой версии', async () => {
  resetServer({ current_version: '0.3.4', offer: { version: '0.4.0', notes_ru: 'x' },
    approved: true, immediate: true, hour: null, scheduled_at: new Date().toISOString(), last_result: null });
  reloads = 0;
  const root = mk('div');
  await renderUpdates(root);

  // Предыдущие тесты могли оставить отложенную перезагрузку (экран проверки
  // обновлений планирует её через setTimeout). Даём ей сработать и только
  // потом обнуляем счётчик — иначе чужой таймер попадёт в наше окно.
  await new Promise((r) => setTimeout(r, 1500));
  reloads = 0;

  // Сервер перезапустился на 0.4.0 — ровно то, что делает staleAfterSwitch.
  currentStatus = { ...currentStatus, current_version: '0.4.0', approved: false, offer: null };
  await new Promise((r) => setTimeout(r, 7000));
  assert.strictEqual(reloads, 1, 'страница перезагружается один раз');

  // И не повторяет это бесконечно после перезагрузки.
  await new Promise((r) => setTimeout(r, 5600));
  assert.strictEqual(reloads, 1, 'таймер остановлен после перезагрузки');
});

test('ничего не устанавливается: никакого фонового опроса и никаких перезагрузок', async () => {
  resetServer({ current_version: '0.3.4', offer: null, approved: false, hour: null,
    scheduled_at: null, last_result: null });
  reloads = 0;
  const root = mk('div');
  await renderUpdates(root);
  const after = statusCalls;
  await new Promise((r) => setTimeout(r, 5600));
  assert.strictEqual(reloads, 0, 'перезагружать нечего');
  assert.strictEqual(statusCalls, after, 'сервер не опрашивается впустую');
});