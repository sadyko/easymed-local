// SYSTEM_SETTINGS_V1 (docs/plans/2026-08-23-system-settings.md, Task 3) — the
// three cards that grew Settings → «Система» out of the updates screen:
// activation & subscription (views/system-subscription.js), backups
// (views/system-backups.js) and the danger zone (views/system-danger.js),
// rendered through the page owner views/updates.js.
//
// Covers: all four cards render for an admin; a non-admin sees ZERO buttons
// page-wide (the updates screen's own rule, extended) and never even calls
// the admin-gated backup_list; the extended licence fields render and their
// ABSENCE renders an em-dash (the server side is built in parallel and may
// deliver less); «Запросить» goes through module_request exactly once per
// click storm; the EM- entry appears ONLY when not enrolled and sends the
// code as typed; «Создать копию сейчас» calls backup_create then re-lists;
// the restore modal refuses to fire without a password, sends the exact
// {name, password} contract, surfaces the server's own wrong-password
// sentence, and mounts the restart overlay on {restarting:true}; the danger
// modal's confirm stays dead until «УДАЛИТЬ» + password, sends the exact
// {password, confirm, wipe_backups} contract with wipe_backups OFF by
// default and ON only when the checkbox is ticked.
//
// The updates card's own behavior is updates-view.test.mjs's job — not
// repeated here.

import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/updates-view.test.mjs (itself from
// activation.test.mjs) because these views also render Icon() calls, which go
// through ui.js's html() -> a <template> parse.
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
const findByClass = (root, cls) => walk(root).find((n) => String(n.className).split(/\s+/).includes(cls));
const findInputByType = (root, type) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === type);

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

// --- fake server ----------------------------------------------------------
// The updates RPCs answer a calm no-offer status (that card's behavior is
// updates-view.test.mjs's business); the four SYSTEM_SETTINGS_V1 RPCs answer
// exactly the plan's contract so every call site here is asserted against
// the same shape the parallel server task is building to.
let backupListCalls, backupCreateCalls, restoreCalls, resetCalls, requestCalls, enrollCalls;
let lastRestoreBody, lastResetBody, lastRequestBody, lastEnrollBody;
let backupRows, restoreRespond, resetRespond;

function resetServer() {
  backupListCalls = 0; backupCreateCalls = 0; restoreCalls = 0; resetCalls = 0; requestCalls = 0; enrollCalls = 0;
  lastRestoreBody = null; lastResetBody = null; lastRequestBody = null; lastEnrollBody = null;
  backupRows = [
    { name: 'daily-20260822-030000.db', kind: 'daily', size: 15 * 1024 * 1024, mtimeMs: new Date(2026, 7, 22, 3, 0).getTime() },
    { name: 'manual-20260823-100000.db', kind: 'manual', size: 1229, mtimeMs: new Date(2026, 7, 23, 10, 0).getTime() },
  ];
  restoreRespond = () => jsonOk({ ok: true, restarting: true });
  resetRespond = () => jsonOk({ ok: true, restarting: true });
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/update_status')) return jsonOk({ current_version: '2.3.0', offer: null, approved: false, hour: null, scheduled_at: null, last_result: null });
  if (u.startsWith('/api/rpc/backup_list')) { backupListCalls++; return jsonOk({ backups: backupRows }); }
  if (u.startsWith('/api/rpc/backup_create')) {
    backupCreateCalls++;
    backupRows = [{ name: 'manual-20260823-110000.db', kind: 'manual', size: 2048, mtimeMs: new Date(2026, 7, 23, 11, 0).getTime() }, ...backupRows];
    return jsonOk(backupRows[0]);
  }
  if (u.startsWith('/api/rpc/backup_restore')) { restoreCalls++; lastRestoreBody = body; return restoreRespond(); }
  if (u.startsWith('/api/rpc/factory_reset')) { resetCalls++; lastResetBody = body; return resetRespond(); }
  if (u.startsWith('/api/rpc/module_request')) { requestCalls++; lastRequestBody = body; return jsonOk({ ok: true, requested_at: '2026-08-23T09:00:00.000Z' }); }
  if (u.startsWith('/api/rpc/licence_enroll')) { enrollCalls++; lastEnrollBody = body; return jsonOk({ ok: true }); }
  if (u.startsWith('/api/health')) return jsonOk({ ok: true });
  return jsonOk({});
};

const { renderUpdates } = await import('../views/updates.js');
const { setLicence } = await import('../licence.js');

function setUser(u) { globalThis.window.easymed.state.user = u; }
const ADMIN = { id: 1, role: 'admin', is_admin: true, is_super_admin: false };
const REGISTRAR = { id: 2, role: 'registrar', is_admin: false, is_super_admin: false };

const ENROLLED_LIC = {
  state: 'ok', locked: false, reason: null, days_left: 22, modules: ['crm'],
  clinic_name: 'Нурафшон Мед', clinic_id: 'c-000051',
  valid_until: new Date(2026, 8, 12).toISOString(), last_checkin: new Date(2026, 7, 23, 9, 0).toISOString(),
};

test.beforeEach(() => {
  resetServer();
  setUser(ADMIN);
  setLicence(ENROLLED_LIC);
  fakeLocalStorage.setItem('em.updates.lastSeenVersion', '2.3.0');   // «что нового» — не предмет этого файла
  document.body.children.length = 0;   // модалки и оверлеи прошлых тестов не должны утекать в следующий
});

// --- страница из четырёх карточек ---------------------------------------------

test('админ видит все четыре карточки: обновления, активация и подписка, резервные копии, опасная зона', async () => {
  const root = mk('div');
  await renderUpdates(root);
  const text = textOf(root);
  assert.match(text, /Система/, 'заголовок страницы — «Система»');
  assert.match(text, /У вас последняя версия/, 'карточка обновлений живёт как раньше');
  assert.match(text, /Активация и подписка/);
  assert.match(text, /Резервные копии/);
  assert.match(text, /Опасная зона/);
});

test('неадмин: НИ ОДНОЙ кнопки на всей странице, опасной зоны нет вовсе, backup_list даже не вызывается', async () => {
  setUser(REGISTRAR);
  const root = mk('div');
  await renderUpdates(root);
  assert.deepEqual(findAllButtons(root), [], 'у не-администратора не должно быть ни одной кнопки');
  assert.doesNotMatch(textOf(root), /Опасная зона/, 'красная карточка — чистая угроза для того, кто не может её нажать');
  assert.equal(backupListCalls, 0, 'backup_list закрыт на сервере для не-админа — гарантированный 403 незачем провоцировать');
  assert.match(textOf(root), /Управление копиями доступно администратору/, 'вместо кнопок — честное объяснение');
});

// --- активация и подписка --------------------------------------------------------

test('карточка подписки показывает клинику, ID, срок и последнюю связь из licence_status', async () => {
  const root = mk('div');
  await renderUpdates(root);
  const text = textOf(root);
  assert.match(text, /Нурафшон Мед/);
  assert.match(text, /c-000051/);
  assert.match(text, /12\.09\.2026 — осталось 22 дн\./);
  assert.match(text, /23\.08\.2026 09:00/);
  assert.match(text, /Подписка активна/);
});

test('расширенные поля ещё не приехали (сервер строится параллельно) — тире, а не undefined', async () => {
  setLicence({ state: 'ok', locked: false, reason: null, days_left: 0, modules: [] });
  const root = mk('div');
  await renderUpdates(root);
  const text = textOf(root);
  assert.match(text, /—/, 'em-dash должен присутствовать');
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(text, /null/);
});

test('«Запросить» отправляет module_request с ключом модуля; двойной клик — один вызов', async () => {
  setLicence({ ...ENROLLED_LIC, modules: [] });
  const root = mk('div');
  await renderUpdates(root);
  const btn = findButtonByText(root, /Запросить/);
  assert.ok(btn, 'невключённый модуль должен предлагать «Запросить»');
  btn.click();
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requestCalls, 1, 'ровно один вызов на клик-шторм');
  assert.equal(lastRequestBody.module_key, 'crm');
  assert.match(textOf(btn), /Заявка отправлена/);
});

test('включённый модуль показывает «Подключён», а не кнопку запроса', async () => {
  const root = mk('div');   // ENROLLED_LIC: crm включён, telegram нет
  await renderUpdates(root);
  assert.match(textOf(root), /Подключён/);
  assert.match(textOf(root), /CRM и call-центр/);
  assert.match(textOf(root), /Telegram-бот для пациентов/);
});

test('ввод EM-кода появляется ТОЛЬКО когда licence_status говорит not_enrolled, и шлёт код как набран', async () => {
  setLicence({ state: 'locked', locked: true, reason: 'not_enrolled', days_left: 0, modules: [] });
  const root = mk('div');
  await renderUpdates(root);
  const input = walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === 'EM-XXXX-XXXX');
  assert.ok(input, 'поле EM-кода должно быть');
  input.value = ' em-7k4q-9xzp ';
  const btn = findButtonByText(root, /Активировать/);
  btn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(enrollCalls, 1);
  assert.equal(lastEnrollBody.code, ' em-7k4q-9xzp ', 'нормализация — дело сервера; экран шлёт как есть (правило activation.js)');
});

test('зарегистрированная клиника поля EM-кода не видит', async () => {
  const root = mk('div');
  await renderUpdates(root);
  const emInput = walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === 'EM-XXXX-XXXX');
  assert.equal(emInput, undefined, 'уже привязана — повторный ввод заработал бы только already_enrolled');
});

// --- резервные копии ---------------------------------------------------------------

test('таблица копий: дата, человеческий тип, размер — новые сверху', async () => {
  const root = mk('div');
  await renderUpdates(root);
  const text = textOf(root);
  assert.match(text, /ручная/);
  assert.match(text, /ежедневная/);
  assert.match(text, /15 МБ/);
  assert.match(text, /1,2 КБ/);
  assert.match(text, /Копия содержит базу данных клиники/, 'честная строка про storage/ обязана присутствовать');
  const rows = walk(root).filter((n) => n.tagName === 'TR');
  assert.match(textOf(rows[1]), /23\.08\.2026/, 'первая строка данных — самая свежая копия');
});

test('«Создать копию сейчас» вызывает backup_create и перечитывает список', async () => {
  const root = mk('div');
  await renderUpdates(root);
  const listCallsBefore = backupListCalls;
  findButtonByText(root, /Создать копию сейчас/).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backupCreateCalls, 1);
  assert.equal(backupListCalls, listCallsBefore + 1, 'после создания список перечитывается — сервер мог и подрезать старые');
  assert.match(textOf(root), /11:00/, 'новая копия должна появиться в таблице');
});

test('модалка восстановления: без пароля RPC не уходит; с паролем уходит ровно {name, password}; на restarting поднимается оверлей', async () => {
  const root = mk('div');
  await renderUpdates(root);
  findButtonByText(root, /Восстановить/).click();
  const modal = findByClass(document.body, 'modal');
  assert.ok(modal, 'модалка должна смонтироваться на body');
  assert.match(textOf(modal), /исчезнут/, 'предупреждение о том, что пропадёт');
  assert.match(textOf(modal), /страховочная копия/, 'успокоение про safety-копию');
  assert.match(textOf(modal), /перезапустится/, 'предупреждение о перезапуске');

  const confirm = findButtonByText(modal, /Восстановить/);
  confirm.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(restoreCalls, 0, 'без пароля RPC уходить не должен');
  assert.match(textOf(modal), /Введите пароль администратора/);

  findInputByType(modal, 'password').value = 'admin-pw';
  confirm.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(restoreCalls, 1);
  assert.deepEqual(lastRestoreBody, { name: 'manual-20260823-100000.db', password: 'admin-pw' },
    'ровно контракт плана — имя строки, по которой кликнули (самая свежая), и пароль');
  assert.ok(findByClass(document.body, 'sys-restart-overlay'), 'оверлей «перезапускается» должен подняться');
});

test('неверный пароль при восстановлении: показан ИМЕННО ответ сервера, кнопка снова активна', async () => {
  restoreRespond = () => jsonErr({ message: 'Пароль неверный.' }, 403);
  const root = mk('div');
  await renderUpdates(root);
  findButtonByText(root, /Восстановить/).click();
  const modal = findByClass(document.body, 'modal');
  findInputByType(modal, 'password').value = 'wrong';
  const confirm = findButtonByText(modal, /Восстановить/);
  confirm.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(restoreCalls, 1);
  assert.match(textOf(modal), /Пароль неверный\./);
  assert.equal(confirm.disabled, false, 'ошибка должна снова разрешить нажать');
  assert.equal(findByClass(document.body, 'sys-restart-overlay'), undefined, 'без restarting никакого оверлея');
});

// --- опасная зона -------------------------------------------------------------------

test('сброс: кнопка мертва до «УДАЛИТЬ»+пароля, уходит точный контракт с wipe_backups=false по умолчанию', async () => {
  const root = mk('div');
  await renderUpdates(root);
  findButtonByText(root, /Удалить все данные клиники/).click();
  const modal = findByClass(document.body, 'modal');
  assert.ok(modal);
  assert.match(textOf(modal), /НОВЫЙ код активации/, 'потеря активации — та, которой админ не ждёт; она обязана быть в списке');

  const confirm = findButtonByText(modal, /Удалить всё/);
  const word = findInputByType(modal, 'text');
  const pass = findInputByType(modal, 'password');

  word.value = 'удалить';   // не тот регистр — сервер примет только точное слово
  word.dispatchEvent({ type: 'input' });
  pass.value = 'admin-pw';
  pass.dispatchEvent({ type: 'input' });
  assert.equal(confirm.disabled, true, 'неточное слово держит кнопку мёртвой');

  word.value = ' УДАЛИТЬ ';
  word.dispatchEvent({ type: 'input' });
  assert.equal(confirm.disabled, false, 'точное слово (пробелы прощены) + пароль оживляют кнопку');

  confirm.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resetCalls, 1);
  assert.deepEqual(lastResetBody, { password: 'admin-pw', confirm: 'УДАЛИТЬ', wipe_backups: false },
    'ровно контракт плана; галочка про копии по умолчанию ВЫКЛ');
  assert.ok(findByClass(document.body, 'sys-restart-overlay'), 'после restarting — тот же оверлей, что и у восстановления');
});

test('галочка «также удалить все резервные копии» отправляет wipe_backups=true', async () => {
  const root = mk('div');
  await renderUpdates(root);
  findButtonByText(root, /Удалить все данные клиники/).click();
  const modal = findByClass(document.body, 'modal');
  const chk = findInputByType(modal, 'checkbox');
  assert.ok(chk, 'галочка должна существовать');
  chk.checked = true;
  const word = findInputByType(modal, 'text');
  const pass = findInputByType(modal, 'password');
  word.value = 'УДАЛИТЬ'; word.dispatchEvent({ type: 'input' });
  pass.value = 'admin-pw'; pass.dispatchEvent({ type: 'input' });
  findButtonByText(modal, /Удалить всё/).click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lastResetBody.wipe_backups, true);
});
