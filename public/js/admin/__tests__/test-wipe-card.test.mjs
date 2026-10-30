// TEST_DATA_WIPE_V1 — карточка «Удалить тестовые данные» на «Данных клиники»
// (views/system-test-wipe.js): только администратору; окно перечисляет, что
// удалится и что останется (и что удаляются ВСЕ записи в календаре); кнопка
// мертва до «УДАЛИТЬ» + пароля; уходит ровно {password, confirm}; на
// restarting — оверлей перезапуска; связанной клинике — объяснение и мёртвая
// кнопка; отказ сервера — его словами на языке экрана; итог прошлого
// удаления — числами, с карточками CRM без учебной записи, оставленными
// файлами и тем, кто и когда попросил.

import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — копия из __tests__/system-view.test.mjs: карточки рисуют
// Icon(), а он идёт через html() ui.js -> разбор <template>.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){ const p = globalThis.document.body; const i = p.children.indexOf(this); if (i > -1) p.children.splice(i, 1); }
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
// I18N_LOCALE_PIN_V1 — язык закрепляется до импорта экрана: русские проверки
// держатся и на англоязычной машине CI.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, dispatchEvent(){ return true; }, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
// Значки (svg) — разметкой, а не текстом: в проверки текста они не идут.
const textOf = (el) => walk(el).filter((n) => n.tagName !== 'SVG').map((n) => n._t || '').join('');
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));
const findByClass = (root, cls) => walk(root).find((n) => String(n.className).split(/\s+/).includes(cls));
const findInputByType = (root, type) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === type);
const tick = () => new Promise((r) => setTimeout(r, 20));

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const jsonErr = (error, status = 400) => ({ ok: false, status, json: async () => ({ error }) });

let statusData, statusCalls, wipeCalls, lastWipeBody, wipeRespond, usersRow, usersCalls;
function resetServer() {
  statusData = { paired: false, pending: false, last: null };
  statusCalls = 0; wipeCalls = 0; lastWipeBody = null; usersCalls = 0;
  usersRow = null;
  wipeRespond = () => jsonOk({ ok: true, restarting: true, backup: 'wipe-20261030-100000.db' });
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/test_data_wipe_status')) { statusCalls++; return jsonOk(statusData); }
  if (u.startsWith('/api/rpc/test_data_wipe')) { wipeCalls++; lastWipeBody = body; return wipeRespond(); }
  if (u.startsWith('/api/rpc/backup_list')) return jsonOk({ backups: [] });
  if (u.startsWith('/api/rpc/disk_usage')) return jsonOk({});
  if (u.startsWith('/api/db') && body && body.table === 'users') { usersCalls++; return jsonOk(usersRow); }
  if (u.startsWith('/api/health')) return jsonOk({ ok: true });
  return jsonOk({});
};

const { renderClinicData } = await import('../views/clinic-data.js');
const { renderTestWipeCard } = await import('../views/system-test-wipe.js');
const { setLang } = await import('../i18n.js');
const { rememberServerMessage } = await import('../../shared/server-messages.js');

const ADMIN = { id: 1, role: 'admin', is_admin: true, is_super_admin: false };
const REGISTRAR = { id: 2, role: 'registrar', is_admin: false, is_super_admin: false };
const setUser = (u) => { globalThis.window.easymed.state.user = u; };

test.beforeEach(() => {
  resetServer();
  setUser(ADMIN);
  document.body.children.length = 0;
});

async function openModal() {
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  findButtonByText(root, /Удалить тестовые данные…/).click();
  const modal = findByClass(document.body, 'modal');
  assert.ok(modal, 'окно удаления открылось');
  return { root, modal };
}

function fillAndGetConfirm(modal) {
  findInputByType(modal, 'text').value = 'УДАЛИТЬ'; findInputByType(modal, 'text').dispatchEvent({ type: 'input' });
  findInputByType(modal, 'password').value = 'pw'; findInputByType(modal, 'password').dispatchEvent({ type: 'input' });
  return findButtonByText(modal, /Удалить тестовые данные$/);
}

test('администратор видит карточку между копиями и «Опасной зоной»; не-администратор — нет, и состояние не спрашивается', async () => {
  const root = mk('div');
  await renderClinicData(root);
  const text = textOf(root);
  assert.match(text, /Удалить тестовые данные/);
  assert.match(text, /а пациенты \(ФИО, телефоны, номера карт\), CRM и все настройки остаются\./, 'не «карты пациентов остаются» без оговорки: сканы и показатели удаляются');
  assert.equal(statusCalls, 1);
  assert.ok(text.indexOf('Создать копию сейчас') < text.indexOf('Удалить тестовые данные'), 'после копий — путь назад виден первым');
  assert.ok(text.indexOf('Удалить тестовые данные') < text.indexOf('Опасная зона'), 'до полного удаления');

  setUser(REGISTRAR);
  statusCalls = 0;
  const other = mk('div');
  await renderClinicData(other);
  assert.doesNotMatch(textOf(other), /Удалить тестовые данные/);
  assert.equal(statusCalls, 0);
  assert.deepEqual(findAllButtons(other), []);
});

test('окно перечисляет, что удалится и что останется, и предупреждает о календаре, копии, номерах, перезапуске и связанной клинике', async () => {
  const { modal } = await openModal();
  const text = textOf(modal);
  for (const re of [/Будут удалены:/, /визиты и их услуги/, /рекомендованные услуги/, /карточки обзвона после визита/,
    /сканы в карте пациента/, /отправки документов в Telegram/, /стационар: госпитализации/,
    /деньги: счета, платежи/, /движения по балансу пациентов/, /остатки товаров начнутся с нуля/,
    /Удаляются ВСЕ записи в календаре — и прошедшие, и будущие, в том числе записи настоящих пациентов/,
    /Останутся:/, /карты пациентов: ФИО, телефоны, номера карт/, /CRM: карточки, задачи/, /стадии карточек не меняются/,
    /роли, права, сотрудники, услуги, цены/,
    /подарочные карты, заведённые в настройках, — снова с полным номиналом; занятые койки освобождаются/,
    /снова начнутся с 1/, /Перед удалением тестовых данных/,
    /Клинике, связанной с другими зданиями/, /на большой базе дольше\. Не перезапускайте её вручную: удаление пройдёт при запуске/]) {
    assert.match(text, re);
  }
  assert.ok(text.indexOf('Будут удалены:') < text.indexOf('Удаляются ВСЕ записи в календаре'), 'календарь — сразу под списком удаляемого');
});

test('кнопка мертва до «УДАЛИТЬ» + пароля; уходит ровно {password, confirm}; на restarting — оверлей', async () => {
  const { modal } = await openModal();
  const confirm = findButtonByText(modal, /Удалить тестовые данные$/);
  const word = findInputByType(modal, 'text');
  const pass = findInputByType(modal, 'password');
  assert.equal(confirm.disabled, true);
  word.value = 'удалить'; word.dispatchEvent({ type: 'input' });
  pass.value = 'admin-pw'; pass.dispatchEvent({ type: 'input' });
  assert.equal(confirm.disabled, true, 'не тот регистр — кнопка мертва');
  word.value = ' УДАЛИТЬ '; word.dispatchEvent({ type: 'input' });
  assert.equal(confirm.disabled, false);
  confirm.click();
  await tick();
  assert.equal(wipeCalls, 1);
  assert.deepEqual(lastWipeBody, { password: 'admin-pw', confirm: 'УДАЛИТЬ' });
  assert.ok(findByClass(document.body, 'sys-restart-overlay'));
});

test('клиника связана с другими зданиями — объяснение с выходом («Отвязать») и мёртвая кнопка, окно не открывается', async () => {
  statusData = { paired: true, pending: false, last: null };
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  assert.match(textOf(root), /Удаление ушло бы в другое здание/);
  assert.match(textOf(root), /нажмите «Отвязать» на экране «Филиалы»/);
  const btn = findButtonByText(root, /Удалить тестовые данные…/);
  assert.equal(btn.disabled, true);
  btn.click();
  assert.equal(findByClass(document.body, 'modal'), undefined);
});

// Ревью C5 (M1): удаление уже ждёт перезапуска — второй раз просить нельзя:
// кнопка мертва и говорит почему, окно не открывается.
test('удаление уже ждёт перезапуска — кнопка мертва с объяснением, окно не открывается', async () => {
  statusData = { paired: false, pending: true, last: null };
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  assert.match(textOf(root), /Удаление уже ждёт перезапуска программы\./);
  const btn = findButtonByText(root, /Удалить тестовые данные…/);
  assert.equal(btn.disabled, true);
  assert.equal(btn.getAttribute('title'), 'Удаление уже ждёт перезапуска программы.');
  btn.click();
  assert.equal(findByClass(document.body, 'modal'), undefined);
});

// Ревью C5 (M3): неверный пароль — поле пароля очищается, кнопка снова мертва
// до нового пароля; другой отказ пароль не трогает.
test('неверный пароль — поле пароля очищено, кнопка мертва; отказ «связана» пароль не стирает', async () => {
  wipeRespond = () => jsonErr({ code: 'forbidden', message: 'Неверный пароль.' }, 403);
  const { modal } = await openModal();
  const confirm = fillAndGetConfirm(modal);
  confirm.click();
  await tick();
  assert.match(textOf(modal), /Неверный пароль\./);
  assert.equal(findInputByType(modal, 'password').value, '');
  assert.equal(confirm.disabled, true, 'без пароля кнопка мертва');

  document.body.children.length = 0;
  wipeRespond = PAIRED_ERR;
  const second = await openModal();
  const confirm2 = fillAndGetConfirm(second.modal);
  confirm2.click();
  await tick();
  assert.equal(findInputByType(second.modal, 'password').value, 'pw');
});

// Ревью C5 (M1): сервер отказывает, пока pending-action.json держит любое
// отложенное действие, — его словами на языке экрана.
test('отказ сервера «уже ждёт перезапуска» — его словами на языке экрана (en)', async () => {
  wipeRespond = () => jsonErr({ code: 'pending', message: 'Удаление тестовых данных уже запрошено и ждёт перезапуска программы. Просить второй раз не нужно.' }, 409);
  const { modal } = await openModal();
  const confirm = fillAndGetConfirm(modal);
  setLang('en');
  try {
    confirm.click();
    await tick();
    assert.match(textOf(modal), /Test data deletion has already been requested and is waiting for the program to restart\./);
  } finally { setLang('ru'); }
});

// Фраза сервера — rpc/backup.js PAIRED_REFUSAL (test-wipe-logic.test.js
// сверяет её с PAIRED_TEXT экрана).
const PAIRED_ERR = () => jsonErr({
  code: 'paired',
  message: 'Клиника связана с другими зданиями. Удаление ушло бы в другое здание и стёрло бы там настоящие данные, поэтому удалить тестовые данные здесь нельзя. Если связь не нужна, нажмите «Отвязать» на экране «Филиалы» и удалите тестовые данные до того, как связывать клинику снова.',
}, 409);
const PAIRED_TEXT = {
  ru: /Удаление ушло бы в другое здание.*«Отвязать»/,
  en: /The deletion would travel to another building.*“Unlink”/,
  uz: /boshqa binoga ham yetib borib.*«Uzish»/,
};
// Отказ при просьбе — фраза удаления (test-data-wipe.js wipeNoSpaceError).
const NO_SPACE_ERR = () => jsonErr({
  code: 'no_space',
  message: 'Недостаточно места на диске: нужно 2,1 ГБ, свободно 0,4 ГБ. Тестовые данные не удалены.',
  template: 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Тестовые данные не удалены.',
  params: { need: 2.1, free: 0.4 },
}, 409);

for (const lang of ['ru', 'en', 'uz']) {
  test(`отказ сервера «связана со зданиями» (${lang}) — его словами на языке экрана, без оверлея`, async () => {
    wipeRespond = PAIRED_ERR;
    const { modal } = await openModal();
    const confirm = fillAndGetConfirm(modal);
    setLang(lang);
    try {
      confirm.click();
      await tick();
      assert.match(textOf(modal), PAIRED_TEXT[lang]);
      assert.equal(findByClass(document.body, 'sys-restart-overlay'), undefined);
      assert.equal(confirm.disabled, false, 'кнопка снова живая');
      assert.ok(findByClass(modal, 'sys-modal-status'), 'отказ — красной строкой');
    } finally { setLang('ru'); }
  });
}

for (const [lang, re] of [
  ['en', /Not enough disk space: 2\.1 GB needed, 0\.4 GB free\. Test data was not deleted\./],
  ['ru', /Недостаточно места на диске: нужно 2,1 ГБ, свободно 0,4 ГБ\. Тестовые данные не удалены\./],
  ['uz', /Diskda joy yetarli emas: 2,1 GB kerak, 0,4 GB bo‘sh\. Test ma’lumotlari o‘chirilmadi\./],
]) {
  test(`нет места на копию и журнал удаления — фраза сервера с числами на языке экрана (${lang})`, async () => {
    wipeRespond = NO_SPACE_ERR;
    const { modal } = await openModal();
    const confirm = fillAndGetConfirm(modal);
    setLang(lang);
    try {
      confirm.click();
      await tick();
      assert.match(textOf(modal), re);
    } finally { setLang('ru'); }
  });
}

test('итог прошлого удаления — дата, кто попросил, числа без нулей, карточки CRM и оставленные файлы; ждущее — «ждёт перезапуска»', async () => {
  usersRow = { id: 7, full_name: 'Тестовый Администратор' };
  statusData = {
    paired: false, pending: true,
    last: {
      ok: true, at: '2026-10-30T05:00:00.000Z', requested_by: 7, requested_at: '2026-10-30T04:58:00.000Z',
      deleted: { visits: 12, invoices: 7, payments: 9, admissions: 0 }, cleared: { products: 3 },
      crm_cards_unbooked: 2, files: { removed: 4, failed: 3 }, vacuum: { done: true },
    },
  };
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  const text = textOf(root);
  assert.match(text, /Последнее удаление тестовых данных: 30\.10\.2026/);
  assert.match(text, /Кто и когда попросил: Тестовый Администратор, 30\.10\.2026/);
  assert.equal(usersCalls, 1);
  assert.match(text, /Визиты12/);
  assert.match(text, /Счета7/);
  assert.match(text, /Платежи9/);
  assert.match(text, /Файлы документов4/);
  assert.match(text, /Товары с обнулённым остатком3/);
  assert.doesNotMatch(text, /Госпитализации0/, 'нули не показываются');
  assert.match(text, /Карточек CRM без учебной записи: 2 — их стадии не менялись\./);
  assert.match(text, /Файлов документов оставлено на диске: 3 — их нет в копии «Перед удалением тестовых данных»/);
  assert.match(text, /Удаление уже ждёт перезапуска программы\./);
  assert.equal(findByClass(root, 'sys-modal-warn'), undefined, 'удачный итог — без красных плашек');
});

// Ревью C5: «удалять было нечего» решают ВСЕ числа итога (deleted, cleared),
// а не только строки таблицы: удалённый журнал действий или освобождённая
// койка — тоже удаление.
test('«Удалять было нечего» — только когда в итоге нет ни одного числа больше нуля', async () => {
  for (const last of [
    { ok: true, at: '2026-10-30T05:00:00.000Z', deleted: { patient_activity_log: 3, visits: 0 }, cleared: {} },
    { ok: true, at: '2026-10-30T05:00:00.000Z', deleted: { visits: 0 }, cleared: { beds: 1 } },
  ]) {
    statusData = { paired: false, pending: false, last };
    const root = mk('div');
    await renderTestWipeCard(root, { admin: true });
    assert.doesNotMatch(textOf(root), /Удалять было нечего/, JSON.stringify(last));
  }
  statusData = { paired: false, pending: false, last: { ok: true, at: '2026-10-30T05:00:00.000Z', deleted: { visits: 0 }, cleared: { beds: 0 } } };
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  assert.match(textOf(root), /Удалять было нечего: учебных данных не нашлось\./);
});

test('итог: копии «Перед удалением» не нашлось — своя причина словами, база не тронута', async () => {
  statusData = { paired: false, pending: false, last: { ok: false, reason: 'no_copy', at: '2026-10-30T05:00:00.000Z' } };
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  assert.match(textOf(root), /Тестовые данные не удалены: копия «Перед удалением тестовых данных» не найдена\. База не тронута\./);
  assert.doesNotMatch(textOf(root), /произошёл сбой/);
});

test('кто попросил: сотрудника не нашлось — номер; номера нет — имя не спрашивается', async () => {
  statusData = { paired: false, pending: false, last: { ok: true, at: '2026-10-30T05:00:00.000Z', requested_by: 7, requested_at: '2026-10-30T04:58:00.000Z', deleted: { visits: 1 } } };
  const root = mk('div');
  await renderTestWipeCard(root, { admin: true });
  assert.match(textOf(root), /Кто и когда попросил: сотрудник № 7, 30\.10\.2026/);

  statusData = { paired: false, pending: false, last: { ok: true, at: '2026-10-30T05:00:00.000Z', deleted: {} } };
  usersCalls = 0;
  const root2 = mk('div');
  await renderTestWipeCard(root2, { admin: true });
  assert.equal(usersCalls, 0);
  assert.doesNotMatch(textOf(root2), /Кто и когда попросил/);
  assert.match(textOf(root2), /Удалять было нечего: учебных данных не нашлось\./);
});

for (const [lang, re] of [
  ['ru', /Последняя попытка удалить тестовые данные: 30\.10\.2026.*Недостаточно места на диске: нужно 2,1 ГБ, свободно 0,4 ГБ\. Тестовые данные не удалены\./],
  ['en', /Last attempt to delete test data: 30\.10\.2026.*Not enough disk space: 2\.1 GB needed, 0\.4 GB free\. Test data was not deleted\./],
]) {
  test(`итог: при запуске не хватило места — причина словами сервера с числами на языке экрана (${lang})`, async () => {
    // Ревью C5 (M5): та же фраза уже пришла отказом сервера в этой вкладке —
    // слой запросов запомнил её числа (shared/server-messages.js). Итог обязан
    // остаться с десятичным знаком экрана, а не сервера, — независимо от
    // порядка тестов.
    rememberServerMessage({
      code: 'no_space',
      message: 'Недостаточно места на диске: нужно 2,1 ГБ, свободно 0,4 ГБ. Тестовые данные не удалены.',
      template: 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Тестовые данные не удалены.',
      params: { need: 2.1, free: 0.4 },
    });
    statusData = {
      paired: false, pending: false,
      last: {
        ok: false, reason: 'no_space', at: '2026-10-30T05:00:00.000Z', requested_by: null, requested_at: null,
        template: 'Недостаточно места на диске: нужно {need} ГБ, свободно {free} ГБ. Тестовые данные не удалены.',
        params: { need: 2.1, free: 0.4 },
      },
    };
    setLang(lang);
    try {
      const root = mk('div');
      await renderTestWipeCard(root, { admin: true });
      assert.match(textOf(root), re);
      assert.ok(findByClass(root, 'sys-modal-warn'), 'неудача — красной плашкой');
    } finally { setLang('ru'); }
  });
}

test('английский экран: в карточке и окне нет кириллицы, кроме слова УДАЛИТЬ', async () => {
  statusData = {
    paired: true, pending: true,
    last: { ok: true, at: '2026-10-30T05:00:00.000Z', requested_by: 7, requested_at: '2026-10-30T04:58:00.000Z',
      deleted: { visits: 1, visit_services: 2, visit_documents: 1, patient_deposits: 1, stock_movements: 1, api_requests: 1 },
      cleared: { products: 1, crm_request_services: 1 }, crm_cards_unbooked: 1, files: { removed: 1, failed: 1 }, vacuum: { done: false, reason: 'no_space' } },
  };
  setLang('en');
  try {
    const root = mk('div');
    await renderTestWipeCard(root, { admin: true });
    assert.match(textOf(root), /Requested by: employee #7/);
    assert.equal(/[А-Яа-яЁё]/.test(textOf(root).replace(/УДАЛИТЬ/g, '')), false, textOf(root));
    statusData = { paired: false, pending: false, last: null };
    const root2 = mk('div');
    await renderTestWipeCard(root2, { admin: true });
    findButtonByText(root2, /Delete test data…/).click();
    const modal = findByClass(document.body, 'modal');
    assert.equal(/[А-Яа-яЁё]/.test(textOf(modal).replace(/УДАЛИТЬ/g, '')), false, textOf(modal));
  } finally { setLang('ru'); }
});
