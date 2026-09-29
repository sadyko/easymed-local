// ROLES_EDITOR_V2 (docs/plans/2026-08-24-lab-panels-and-roles.md, задача 2) —
// экран Настройки → «Роли» после переписывания.
//
// Проверяется ровно то, что в плане названо сломанным:
//   * экран говорит по-русски (был целиком на английском внутри русского
//     приложения) — включая группу «Overview», чей исходник английский;
//   * у выпадающего списка уровня есть подпись, а у заблокированного —
//     видимая причина, на которую он ссылается aria-describedby;
//   * ошибка загрузки показывает СЕБЯ и кнопку повтора, а не пустую матрицу:
//     на экране прав пустая матрица читается как «доступа нет»;
//   * кнопка «Сохранить роль» блокируется на время запроса, и двойной клик
//     пишет один раз (в V1 узел кнопки был один на все роли);
//   * переключение роли и уход назад с неотмеченными изменениями спрашивают,
//     а не выбрасывают их молча;
//   * контракт записи не изменился: то же {sections, levels} в
//     role_permissions.

import { test } from 'node:test';
import assert from 'node:assert';

// Фейковая DOM — копия из __tests__/telephony-settings.test.mjs (тот, в свою
// очередь, из system-view.test.mjs): вид рисует Icon(), а это разбор <template>.
// Отличия ровно три, и все нужны именно этому экрану:
//   1. `checked` у <input> отражает атрибут, который ставит h() — экран читает
//      chk.checked, чтобы понять, отмечен ли раздел;
//   2. `value` у <select> берётся из <option selected> — иначе уровень доступа
//      читался бы пустой строкой и проверять было бы нечего;
//   3. classList.toggle реально меняет className — по нему видно активную роль.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this._v=null;this._chk=null;this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if(k==='value')this._v=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 // h() ставит checked/selected АТРИБУТОМ; браузер отражает его в свойство,
 // эта DOM — нет, поэтому отражаем сами.
 get checked(){return this._chk===null?('checked' in this.attrs):this._chk;} set checked(v){this._chk=!!v;}
 get value(){
   if(this.tagName!=='SELECT')return this._v===null?'':this._v;
   if(this._v!==null)return this._v;
   const on=this.children.find(c=>c.tagName==='OPTION'&&'selected' in c.attrs);
   return on?String(on.attrs.value??''):(this.children[0]?String(this.children[0].attrs.value??''):'');
 }
 set value(v){this._v=String(v);}
 get classList(){const s=this;return{
   contains:c=>String(s.className).split(/\s+/).includes(c),
   add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},
   remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x&&x!==c).join(' ');},
   toggle(c,on){if(on)this.add(c);else this.remove(c);},
 };}
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
// I18N_LOCALE_PIN_V1 — i18n.js выбирает язык ОДИН раз, при загрузке модуля, из
// этого же хранилища ('admin.lang'), и только потом смотрит navigator.language.
// Закрепление 'ru' ЗДЕСЬ, до импорта вида ниже, — то, из-за чего проверки
// русских строк держатся на англоязычном раннере CI так же, как на русской
// машине разработчика.
fakeLocalStorage.setItem('admin.lang', 'ru');

// Ответ на «уйти и потерять изменения?». null = диалога нет вовсе (так и было
// в V1 — предупреждения не существовало).
let confirmAnswer = true;
let confirmCalls = 0;
let lastConfirmText = null;
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, easymed: { state: { user: null } },
  confirm: (text) => { confirmCalls++; lastConfirmText = String(text); return confirmAnswer; },
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const tagsOf = (root, tag) => walk(root).filter((n) => n.tagName === tag);
const findButtonByText = (root, re) => tagsOf(root, 'BUTTON').find((b) => re.test(textOf(b)));
const roleButton = (root, key) => tagsOf(root, 'BUTTON').find((b) => b.dataset.role === key);
const checkboxes = (root) => tagsOf(root, 'INPUT').filter((n) => n.attrs.type === 'checkbox');
// ROLES_MATRIX_V1 — уровни в матрице это radio-группы: name = 'grant:<ключ>'.
const radios = (root) => tagsOf(root, 'INPUT').filter((n) => n.attrs.type === 'radio' && String(n.attrs.name || '').startsWith('grant:'));
const radiosFor = (root, key) => radios(root).filter((n) => n.attrs.name === 'grant:' + key);
const pick = (root, key, lvl) => {
  const r = radiosFor(root, key).find((n) => n.attrs.value === lvl);
  for (const x of radiosFor(root, key)) x.checked = x === r;
  r.dispatchEvent({ type: 'change' });
  return r;
};
// PATIENT_TAB_ACCESS_V1 — на экране теперь ДВА рода галочек: разделы меню
// (у каждой свой список уровня) и вкладки карты пациента (у них три галочки
// вместо списка). Считать их одним числом больше нельзя.
const moduleBoxes = (root) => checkboxes(root).filter((n) => n.dataset.permKey);
const tabBoxes = (root) => checkboxes(root).filter((n) => n.dataset.ptabKey);
const tabBoxesFor = (root, tab) => tabBoxes(root).filter((n) => n.dataset.ptabKey === tab);
const selects = (root) => tagsOf(root, 'SELECT');
const byClass = (root, cls) => walk(root).filter((n) => n.classList.contains(cls));

// Тост — тот же приём, что в telephony-settings.test.mjs: ui.js toast() держит
// свой таймер в el._t, ровно в том поле, где эта DOM хранит текст, поэтому
// текст тоста живёт отдельно.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// --- фейковый сервер -------------------------------------------------------
// Говорит на языке /api/db дескрипторов (public/js/db-client.js), а не на
// выдуманном: экран ходит через тот же supabase-шим, что и настоящий.
const SAVED = {
  registrar: { sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } },
  doctor:    { sections: ['patients', 'labs'],      levels: { patients: 'editor', labs: 'admin' } },
};
let selectCalls, updateCalls, lastUpdate, selectRespond, updateRespond;
// ROLES_SAVE_TRUTH_V1 — «что у роли есть сейчас» (role_effective_grants). По
// умолчанию сервер не называет ни одного ключа: экран рисует прежний вывод из
// старых полей, и прежние проверки экрана остаются о своём. Своя правда — в
// EFFECTIVE, сбой — в effectiveRespond.
const EFFECTIVE = {};
let effectiveRespond = null;
// ROLES_SAVE_TRUTH_V1 — строки проверки миграции 230 («Проверьте права этой роли»).
let GRANT_REVIEWS = [];
function resetServer() {
  selectCalls = 0; updateCalls = 0; lastUpdate = null; toastMsg = null;
  confirmAnswer = true; confirmCalls = 0; lastConfirmText = null;
  selectRespond = null; updateRespond = null; effectiveRespond = null; GRANT_REVIEWS = [];
}
const roleOf = (desc) => (desc.filters.find((f) => f.col === 'role') || {}).val;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const desc = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/role_effective_grants')) {
    if (effectiveRespond) return effectiveRespond(desc);
    return jsonOk({ levels: EFFECTIVE[desc && desc.role] || {} });
  }
  if (u.startsWith('/api/db') && desc && desc.table === 'role_grant_reviews' && desc.op === 'select') {
    return jsonOk(GRANT_REVIEWS.filter((r) => r.role === roleOf(desc) && r.resolution == null));
  }
  if (u.startsWith('/api/db') && desc && desc.table === 'role_permissions') {
    if (desc.op === 'select') {
      selectCalls++;
      if (selectRespond) return selectRespond(desc);
      const row = SAVED[roleOf(desc)];
      return jsonOk(row ? { permissions: JSON.stringify(row) } : null);
    }
    if (desc.op === 'update') {
      updateCalls++; lastUpdate = { role: roleOf(desc), values: desc.values };
      if (updateRespond) return updateRespond(desc);
      return jsonOk({ id: 1 });
    }
  }
  return jsonOk({});
};

const { renderRolesEditor } = await import('../views/roles-editor.js');

async function render(onBack) {
  const container = mk('div');
  await renderRolesEditor(container, { onBack });
  await tick();
  return container;
}

// Матрица опознаётся по галочкам разделов: их 19 (permissions.js NAV_MODULES).
const hasMatrix = (root) => checkboxes(root).length > 0;

// ---------------------------------------------------------------------------

test('экран говорит по-русски: заголовок, пояснение, кнопки, уровни и группы', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);

  for (const s of [
    'Роли и права',
    'Кто что видит и может менять. У администратора всегда полный доступ.',
    'Здесь вы выбираете, какие разделы видит сотрудник. Доступ к данным дополнительно проверяет сервер — это не единственный замок.',
    'Назад в настройки',
    'Разделы и уровень доступа',
    'Сохранить роль',
    // ROLES_MATRIX_V1 — шапка матрицы и подсказка про вложенные уровни.
    'Разделы, окна и действия',
    'Нет · Просмотр · Изменение · Удаление',
    'Уровни вложены',
    'Регистратор',
    // Строки справочника — словами клиники, с описанием.
    'Стационар', 'Назначения', 'Измерения', 'Кабинет врача', 'Мои визиты',
  ]) assert.ok(text.includes(s), 'нет русской строки: ' + s);
  assert.ok(!/Overview|Clinical|Operational/.test(text), 'английских групп на экране нет');

  // ROLE_ACTIONS_V1 — уровни больше не выпадающий список «просмотр /
  // изменение / удаление» у каждого раздела: он был у всех семнадцати, а
  // значил что-то у пяти. Теперь на экране названы ДЕЙСТВИЯ, и только те,
  // которые программа проверяет.
  // CUSTOM_ROLES_V1 — единственный список на экране это ОСНОВА новой роли
  // (в строке «Новая роль»), и он живёт вне карточки прав.
  const matrixCard = byClass(root, 'roles-card')[0];
  assert.ok(matrixCard, 'карточка прав на месте');
  assert.strictEqual(selects(matrixCard).length, 0,
    'выпадающий список уровня вернулся — он снова обещает право у разделов, где его нет');
  assert.strictEqual(selects(byClass(root, 'roles-new')[0] || root).length, 1,
    'у новой роли должен быть выбор основы — без него роль нечем ограничить');
  // ROLES_MATRIX_LEAN_V1 — под строкой одна подпись: что даёт ВЫБРАННЫЙ
  // уровень; остальные уровни объясняет подсказка на таблетке. Значит, фраза
  // про удаление должна быть на таблетке всегда, а в тексте — после выбора.
  const delPill = tagsOf(root, 'LABEL').find((l) => l.attrs.for === 'rm-patients-delete');
  assert.ok(delPill && /Удаляет визит, неоплаченную услугу/.test(delPill.attrs.title || ''),
    'у таблетки «Удаление» раздела Пациенты нет подсказки, что она даёт');
  assert.ok(!textOf(matrixCard).includes('Удаляет визит, неоплаченную услугу'),
    'подписи всех уровней снова на экране — владелец просил меньше текста');
  pick(root, 'patients', 'delete');
  assert.ok(textOf(matrixCard).includes('Удаляет визит, неоплаченную услугу из сметы и рекомендацию'),
    'выбранный уровень «удаление» у Пациентов не назван словами');
  pick(root, 'patients', 'view');
  assert.ok(textOf(matrixCard).includes('Видит картотеку и карты пациентов'),
    'не сказано, что даёт сам доступ к разделу');

  // Английские строки V1 не должны выжить нигде на экране.
  for (const gone of ['Roles & permissions', 'Save role', 'Back to settings', 'module access',
                      'Choose what each staff role sees', 'Loading…']) {
    assert.ok(!text.includes(gone), 'английский остаток V1: ' + gone);
  }
});

test('матрица рисует ровно справочник: у строки только те уровни, которые в ней что-то значат', async () => {
  resetServer();
  const root = await render();
  const { CATALOG, catalogRows } = await import('../../shared/permission-catalog.js');

  // ROLES_MATRIX_V1. Каждая строка справочника — на экране, и у неё ровно тот
  // набор уровней, что объявлен: «Удаление» у окна, где нечего удалять, было бы
  // галочкой-обманкой.
  for (const row of catalogRows()) {
    const offered = radiosFor(root, row.key).map((n) => n.attrs.value);
    // ROLE_REPORTS_SETTINGS_V1 — закрытая строка (только администратор)
    // переключателя не получает вовсе: выдать её нельзя.
    if (row.locked) { assert.deepStrictEqual(offered, [], 'закрытая строка получила переключатель: ' + row.key); continue; }
    assert.deepStrictEqual(offered, row.levels || ['none', 'view'], 'уровни у ' + row.key);
  }
  // И ничего сверх справочника: лишняя строка — это право, которого код не проверяет.
  const onScreen = new Set(radios(root).map((n) => n.attrs.name.slice('grant:'.length)));
  assert.deepStrictEqual([...onScreen].sort(), catalogRows().filter((r) => !r.locked).map((r) => r.key).sort());
  // ADMIN_ROWS_GRANTABLE_V1 — закрытых строк больше нет: «Сотрудники», «Роли»,
  // Telegram, телефония, CRM, API и плитки-деньги выдаются своими уровнями, а
  // «Цены и проценты» стоят прямо под своей плиткой.
  assert.deepStrictEqual(catalogRows().filter((r) => r.locked).map((r) => r.key), []);
  for (const k of ['settings.employees', 'settings.roles', 'settings.telegram', 'settings.telephony', 'settings.crm', 'settings.api', 'reports.telegram', 'settings.doctor_rates']) {
    assert.ok(radiosFor(root, k).length > 1, k + ' не выдаётся с экрана');
  }
  assert.deepStrictEqual(radiosFor(root, 'settings.employees').map((n) => n.attrs.value), ['none', 'view', 'edit', 'delete']);
  assert.deepStrictEqual(radiosFor(root, 'settings.rooms.money').map((n) => n.attrs.value), ['none', 'edit']);

  // Закрытый раздел гасит свои окна и действия и говорит почему.
  const inpatient = CATALOG.find((x) => x.key === 'inpatient');
  pick(root, 'inpatient', 'none');
  for (const r of [...inpatient.windows, ...inpatient.actions]) {
    assert.ok(radiosFor(root, r.key).every((n) => n.disabled), r.key + ' остался доступен при закрытом разделе');
  }
  assert.ok(textOf(root).includes('Сначала откройте раздел'), 'закрытый раздел не объяснил, почему строки погасли');
  pick(root, 'inpatient', 'view');
  assert.ok(radiosFor(root, 'inpatient.vitals').every((n) => !n.disabled), 'открытый раздел не вернул строки');

  // Под строкой — последствие выбранного уровня, словами.
  pick(root, 'inpatient.vitals', 'delete');
  assert.ok(textOf(root).includes('Удаляет ошибочное измерение'), 'выбор уровня не объяснён');
});

test('ROLES_ACCORDION_V1: разделы свёрнуты, раскрываются по шеврону, смена уровня раскрывает, «все» — обе кнопки', async () => {
  resetServer();
  const root = await render();
  const byClass = (cls) => walk(root).filter((n) => String(n.className).split(/\s+/).includes(cls));
  const section = (key) => byClass('rm-section').find((n) => n.dataset.section === key);
  const bodyOf = (key) => walk(section(key)).find((n) => String(n.className).split(/\s+/).includes('rm-body'));
  const toggleOf = (key) => walk(section(key)).find((n) => String(n.className).split(/\s+/).includes('rm-toggle'));

  // Сколько разделов в справочнике — столько панелей, и все свёрнуты: экран
  // открывается списком, а не простынёй. (CALLCENTER_OPERATOR_V1 добавил Cust Dev.)
  assert.equal(byClass('rm-section').length, 18);
  assert.ok(byClass('rm-body').every((b) => b.hidden === true), 'раздел раскрыт при открытии экрана');
  assert.equal(toggleOf('inpatient').attrs['aria-expanded'], 'false');

  // Свёрнутый раздел всё же говорит, что внутри: счёт открытых окон и действий.
  assert.ok(textOf(section('inpatient')).includes('из 4'), 'нет счёта окон у свёрнутого стационара');

  // Шеврон раскрывает и сворачивает; aria-expanded честно следует.
  toggleOf('inpatient').click();
  assert.equal(bodyOf('inpatient').hidden, false);
  assert.equal(toggleOf('inpatient').attrs['aria-expanded'], 'true');
  toggleOf('inpatient').click();
  assert.equal(bodyOf('inpatient').hidden, true);

  // Смена уровня самого раздела раскрывает его: последствие выбора — перед глазами.
  pick(root, 'mar', 'view');
  assert.equal(bodyOf('mar').hidden, false, 'раздел не раскрылся после смены уровня');

  // «Развернуть все» / «Свернуть все».
  findButtonByText(root, /^Развернуть все$/).click();
  assert.ok(byClass('rm-body').every((b) => b.hidden === false), 'не все раскрылись');
  findButtonByText(root, /^Свернуть все$/).click();
  assert.ok(byClass('rm-body').every((b) => b.hidden === true), 'не все свернулись');

  // Радио внутри свёрнутого тела никуда не делись — сохранение читает их как прежде.
  assert.ok(radiosFor(root, 'inpatient.vitals').length > 0);

  // Раздел без окон и действий не раскрывается: ни кнопки, ни тела — владелец
  // раскрыл «Настройки», увидел пустоту и написал «nothing is found».
  // («Настройки» с DEPARTMENTS_V1 обзавелись окном «Отделы»; касса с
  // CASHIER_HEAD_V1 — действием «Исправляет услуги в счёте»; пустым примером
  // служит дашборд.)
  assert.ok(!toggleOf('dashboard') || toggleOf('dashboard').tagName !== 'BUTTON', 'у пустого раздела шеврон-кнопка');
  assert.equal(bodyOf('dashboard'), undefined, 'у пустого раздела есть тело, в котором ничего нет');
  assert.ok(radiosFor(root, 'dashboard').length > 0, 'уровень пустого раздела остался в форме');
  // CASHIER_HEAD_V1 — у кассы теперь есть что раскрыть: право мелких исправлений.
  assert.equal(toggleOf('cashier').tagName, 'BUTTON', 'у кассы нет шеврона — право исправлений не видно');
  assert.ok(radiosFor(root, 'cashier.lines').length > 0, 'строки «Исправляет услуги в счёте» нет в матрице');
});

test('ошибка загрузки: видимая ошибка с повтором, а НЕ пустая матрица', async () => {
  resetServer();
  selectRespond = () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'database is locked' } }) });
  const root = await render();
  const text = textOf(root);

  assert.ok(text.includes('Не удалось загрузить права роли.'), text);
  assert.ok(text.includes('database is locked'), 'причина сервера показана целиком');
  assert.ok(text.includes('Права не показаны — это не значит, что их нет.'),
    'экран прямо говорит, что пустота — не отсутствие прав');
  assert.strictEqual(hasMatrix(root), false, 'ПУСТАЯ МАТРИЦА ВМЕСТО ОШИБКИ — это дефект V1');

  const retry = findButtonByText(root, /Повторить загрузку/);
  assert.ok(retry, 'есть кнопка повтора');

  // Повтор действительно перечитывает и рисует матрицу.
  selectRespond = null;
  const before = selectCalls;
  retry.click();
  await tick();
  assert.strictEqual(selectCalls, before + 1, 'повтор идёт на сервер');
  assert.ok(hasMatrix(root), 'после успешного повтора матрица на месте');
  assert.ok(!textOf(root).includes('Не удалось загрузить права роли.'));
});

test('сохранение: кнопка заперта на время запроса, двойной клик пишет один раз', async () => {
  resetServer();
  let release;
  updateRespond = () => new Promise((r) => { release = () => r(jsonOk({ id: 1 })); });
  const root = await render();

  const btn = findButtonByText(root, /Сохранить роль/);
  assert.strictEqual(btn.disabled, false, 'до запроса кнопка активна');

  btn.click();
  await tick(5);
  assert.strictEqual(btn.disabled, true, 'на время запроса кнопка заперта');
  assert.strictEqual(btn.textContent, 'Сохранение…');
  assert.strictEqual(roleButton(root, 'doctor').disabled, true, 'смена роли посреди записи тоже заперта');
  assert.strictEqual(checkboxes(root)[0].disabled, true,
    'галочки тоже заперты: отмеченное во время запроса не попало бы в него, но село бы в снимок «сохранено»');

  btn.click();   // второй клик по «заблокированной» кнопке
  await tick(5);
  assert.strictEqual(updateCalls, 1, 'двойной клик не пишет права дважды');

  release();
  await tick();
  assert.strictEqual(btn.disabled, false, 'после ответа кнопка снова активна');
  assert.strictEqual(btn.textContent, 'Сохранить роль');
  assert.strictEqual(roleButton(root, 'doctor').disabled, false);
  assert.strictEqual(checkboxes(root)[0].disabled, false);
  assert.strictEqual(lastUpdate.role, 'registrar');
  // ROLES_SAVE_TRUTH_V1 — ПУСТОЕ СОХРАНЕНИЕ НИЧЕГО НЕ МЕНЯЕТ. Прежде сюда
  // уезжала матрица целиком, и старые поля выводились из неё заново: «Пациенты:
  // изменение» дописывали registration, окно «Очередь» — queue. Роль, у
  // которой их не было, получала их просто оттого, что её открыли и сохранили
  // (а заодно — и всё, что экран вывел для неё из старых галочек). Теперь в
  // grants — только записанное у роли (у этой — ничего), старые поля — те же.
  // Как «Пациенты: Изменение» дописывает registration, когда раздел ТРОНУЛИ, —
  // в тесте ROLES_SAVE_TRUTH_V1 ниже.
  const written = JSON.parse(lastUpdate.values.permissions);
  assert.deepStrictEqual(written.grants, {}, 'пустое сохранение записало ключи, которых не трогали');
  assert.deepStrictEqual(written.sections, ['patients', 'dashboard']);
  assert.deepStrictEqual(written.levels, { patients: 'editor', dashboard: 'viewer' });
  assert.ok(String(toastMsg).includes('Права сохранены'), toastMsg);
});

test('несохранённые изменения: смена роли и уход назад спрашивают', async () => {
  resetServer();
  let backCalls = 0;
  const root = await render(() => { backCalls++; });

  // Пока ничего не трогали — вопросов нет.
  roleButton(root, 'doctor').click();
  await tick();
  assert.strictEqual(confirmCalls, 0, 'без изменений не спрашиваем');
  assert.ok(textOf(root).includes('Врач'));

  // Меняем уровень в матрице и пробуем уйти, ответив «нет».
  const box = pick(root, 'labs', 'view');
  confirmAnswer = false;
  roleButton(root, 'cashier').click();
  await tick();
  assert.strictEqual(confirmCalls, 1, 'спросили перед потерей изменений');
  assert.ok(lastConfirmText.includes('Изменения пропадут.'), lastConfirmText);
  assert.ok(textOf(root).includes('Врач'), 'отказ оставляет на той же роли');
  assert.strictEqual(box.checked, true, 'галочка на месте — ничего не выброшено');

  // «Назад в настройки» закрыт тем же вопросом.
  findButtonByText(root, /Назад в настройки/).click();
  assert.strictEqual(confirmCalls, 2);
  assert.strictEqual(backCalls, 0, 'отказ никуда не уводит');

  // Согласие — уходим.
  confirmAnswer = true;
  roleButton(root, 'cashier').click();
  await tick();
  assert.strictEqual(confirmCalls, 3);
  assert.ok(textOf(root).includes('Кассир'));

  // После сохранения экран снова «чистый»: повторный уход не спрашивает.
  pick(root, 'reports', 'view');
  findButtonByText(root, /Сохранить роль/).click();
  await tick();
  const after = confirmCalls;
  roleButton(root, 'nurse').click();
  await tick();
  assert.strictEqual(confirmCalls, after, 'сохранённое не считается потерянным');
});

test('роль без сохранённой строки: честная подсказка, а не молчаливая пустота', async () => {
  resetServer();
  const root = await render();
  roleButton(root, 'nurse').click();   // в SAVED её нет — сервер отвечает null
  await tick();
  const text = textOf(root);
  assert.ok(text.includes('У этой роли ещё нет сохранённых настроек. Отметьте разделы и сохраните.'), text);
  assert.ok(hasMatrix(root), 'матрица показана — отмечать есть что');
  assert.ok(!text.includes('Не удалось загрузить'), '«не настроено» — не ошибка');
});

test('сбой сохранения: сообщение называет следующий шаг', async () => {
  resetServer();
  updateRespond = () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'disk I/O error' } }) });
  const root = await render();
  findButtonByText(root, /Сохранить роль/).click();
  await tick();
  assert.ok(String(toastMsg).includes('Проверьте связь с сервером и повторите.'), toastMsg);
  assert.ok(String(toastMsg).includes('disk I/O error'), 'причина сервера не проглочена');
  assert.strictEqual(findButtonByText(root, /Сохранить роль/).disabled, false, 'кнопка разблокирована');
});

// ---------------------------------------------------------------------------
// PATIENT_TAB_ACCESS_V1 — вкладки карты пациента в том же экране.
//
// Владелец: «we need to add a patients card tabs to the view/edit/delete
// option. the informations about the patients are available for anyone who has
// access to the patients section». Проверяется ровно то, чем это могло бы
// навредить: что права появились там, где их настраивают; что первое же
// сохранение НИЧЕГО не отнимает; что галочка не обещает права, которого нет; и
// что сохранение роли не стирает настройку, сделанную не здесь.
// ---------------------------------------------------------------------------

test('вкладки карты пациента настраиваются здесь же — по одной строке на вкладку', async () => {
  resetServer();
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Карта пациента — вкладки'), 'группы вкладок на экране нет');
  for (const tab of ['Услуги', 'Лаборатория', 'Документы', 'Счёт', 'Визиты', 'Деталь']) {
    assert.ok(text.includes(tab), 'вкладку «' + tab + '» нельзя выдать роли');
  }
  assert.ok(tabBoxes(root).length > 0, 'у вкладок нет галочек');
  for (const cb of tabBoxes(root)) {
    const label = cb.getAttribute('aria-label') || '';
    assert.ok(/^(Вкладка видна|Изменение на вкладке|Удаление на вкладке): /.test(label), 'у галочки нет подписи: ' + label);
  }
});

test('удаление предлагается ТОЛЬКО там, где оно есть: «Счёт» и «Лаборатория» — просмотр', async () => {
  resetServer();
  const root = await render();
  const kinds = (tab) => tabBoxesFor(root, tab).map((n) => (n.getAttribute('aria-label') || '').split(':')[0]);
  assert.deepEqual(kinds('services'), ['Вкладка видна', 'Изменение на вкладке', 'Удаление на вкладке']);
  assert.deepEqual(kinds('docs'),     ['Вкладка видна', 'Изменение на вкладке', 'Удаление на вкладке']);
  assert.deepEqual(kinds('billing'),  ['Вкладка видна'], '«Счёт» не должен обещать правку и удаление');
  assert.deepEqual(kinds('labs'),     ['Вкладка видна'], 'результаты вносит раздел «Лаборатория»');
  assert.deepEqual(kinds('visits'),   ['Вкладка видна', 'Изменение на вкладке'], 'удаления визита в карте нет');
  assert.deepEqual(kinds('details'),  ['Вкладка видна', 'Изменение на вкладке'], 'удаление пациента — в «Настройки → Пациенты»');
});

test('роль без настроенных вкладок: всё отмечено, и сохранение НИЧЕГО не отнимает', async () => {
  resetServer();
  const root = await render();
  // registrar в SAVED не имеет patient_tabs вовсе — это «как в клинике сегодня»
  for (const cb of tabBoxes(root)) {
    assert.equal(cb.checked, true, 'ненастроенная вкладка нарисована ограниченной: ' + cb.getAttribute('aria-label'));
  }
  findButtonByText(root, /Сохранить роль/).click();
  await tick();
  const saved = JSON.parse(lastUpdate.values.permissions);
  assert.deepEqual(saved.patient_tabs, {
    services: 'delete', labs: 'view', docs: 'delete', history: 'view', billing: 'view',   // PATIENT_HISTORY_TAB_V1 — «История» только смотреть
    visits: 'edit', details: 'edit', recommended: 'edit',
  }, 'первое сохранение роли отняло право, которым клиника пользуется сегодня');
});

test('снятая галочка «Видна» закрывает вкладку и гасит остальные', async () => {
  resetServer();
  const root = await render();
  const [view, edit, del] = tabBoxesFor(root, 'services');
  view.checked = false;
  view.dispatchEvent({ type: 'change', currentTarget: view, target: view });
  assert.equal(edit.checked, false, 'закрытая вкладка не может остаться «редактируемой»');
  assert.equal(del.checked, false);

  findButtonByText(root, /Сохранить роль/).click();
  await tick();
  assert.equal(JSON.parse(lastUpdate.values.permissions).patient_tabs.services, 'none');
});

test('«Удаление» без «Редакт.» невозможно, «Редакт.» без «Видна» — тоже', async () => {
  resetServer();
  const root = await render();
  const [view, edit, del] = tabBoxesFor(root, 'docs');
  del.checked = false; edit.checked = false; view.checked = false;
  del.checked = true;
  del.dispatchEvent({ type: 'change', currentTarget: del, target: del });
  assert.equal(edit.checked, true, '«Удаление» обязано включать «Редакт.»');
  assert.equal(view.checked, true, 'и «Видна»');

  edit.checked = false;
  edit.dispatchEvent({ type: 'change', currentTarget: edit, target: edit });
  assert.equal(del.checked, false, 'снятое «Редакт.» снимает «Удаление»');
});

test('сохранение роли НЕ стирает настройку вкладки, которой этот экран не рисует', async () => {
  resetServer();
  SAVED.registrar.patient_tabs = { billing: 'none', loyalty: 'none' };   // loyalty экран не рисует
  try {
    const root = await render();
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions).patient_tabs;
    assert.equal(saved.billing, 'none', 'закрытая вкладка осталась закрытой');
    assert.equal(saved.loyalty, 'none', 'чужая настройка стёрта сохранением');
  } finally {
    delete SAVED.registrar.patient_tabs;
  }
});

// ---------------------------------------------------------------------------
// CALLCENTER_OPERATOR_V1 — роль `callcenter` называется ЧЕЛОВЕКОМ.
// ---------------------------------------------------------------------------
// Список ролей — это список ПРОФЕССИЙ: «Регистратор», «Кассир», «Лаборант».
// «Колл-центр» стоял среди них отделом, и заведующая, раздавая права, читала
// строку как участок работы, а не как того, КОМУ их выдают.
//
// Проверяется ЭКРАН, а не константа: подпись обязана доехать до кнопки роли.
// Код роли при этом не тронут — он остаётся ключом кнопки (dataset.role),
// потому что по нему живут role_permissions и реестр таблиц.
test('роль callcenter подписана «Оператор колл-центра», а её код прежний', async () => {
  resetServer();
  const root = await render();
  const btn = roleButton(root, 'callcenter');
  assert.ok(btn, 'кнопки роли callcenter нет на экране');
  assert.match(textOf(btn), /Оператор колл-центра/, 'роль подписана отделом, а не человеком');
});

// ---------------------------------------------------------------------------
// CALLCENTER_OPERATOR_V1 — ТОЧЕЧНО ВЫДАННЫЙ КЛЮЧ НЕ ОБНУЛЯЕТ ВСЮ МАТРИЦУ.
// ---------------------------------------------------------------------------
// Экран читал `perms.grants || grantsFromLegacy(perms)`: ОДНОГО ключа в grants
// хватало, чтобы весь остальной справочник нарисовался «Нет», и первое же
// «Сохранить роль» отняло бы у роли всё, что она имела по старым полям.
// Миграция 141 выдаёт ключи именно так — точечно; и так же выглядит любая
// роль, настроенная ДО появления новой строки справочника.
test('роль с частично выданными grants рисуется по старым полям, а сохранение ничего не отнимает', async () => {
  resetServer();
  SAVED.registrar.grants = { 'crm.dial': 'edit' };   // ровно то, что пишет миграция 141
  try {
    const root = await render();
    const chosen = (key) => (radiosFor(root, key).find((n) => n.checked) || {}).attrs.value;

    assert.equal(chosen('crm.dial'), 'edit', 'выданный ключ не доехал до экрана');
    assert.equal(chosen('patients'), 'edit', 'раздел из старых полей нарисовался «Нет»');
    assert.equal(chosen('patients.list'), 'view', 'окно раздела нарисовалось «Нет»');
    assert.equal(chosen('dashboard'), 'view');

    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.ok(saved.sections.includes('patients'), 'сохранение отняло раздел «Пациенты»');
    assert.equal(saved.grants['crm.dial'], 'edit', 'сохранение потеряло выданный ключ');
  } finally {
    delete SAVED.registrar.grants;
  }
});

// ---------------------------------------------------------------------------
// CALLCENTER_OPERATOR_V1 — ЯВНЫЙ ЗАПРЕТ ГЛАВНЕЕ ВЫВЕДЕННОГО ИЗ СТАРЫХ ПОЛЕЙ.
// ---------------------------------------------------------------------------
// Слияние `{...grantsFromLegacy(perms), ...perms.grants}` имеет порядок, и он
// не украшение: старые поля — ОСНОВА, настроенные ключи ложатся ПОВЕРХ.
// Перепутай стороны — и «Нет», поставленное заведующей руками (или выданное
// миграцией 141, чтобы первое сохранение никому не расширило телефонию),
// молча заменится выводом из галочки раздела: роль с открытым разделом CRM
// получила бы обратно и звонок, и запись разговора.
test('явное «Нет» в grants не перебивается старыми полями — ни на экране, ни при сохранении', async () => {
  resetServer();
  SAVED.registrar.sections = [...SAVED.registrar.sections, 'crm'];
  SAVED.registrar.levels = { ...SAVED.registrar.levels, crm: 'admin' };
  SAVED.registrar.grants = { 'crm.dial': 'none', 'crm.recording': 'none' };
  try {
    const root = await render();
    const chosen = (key) => (radiosFor(root, key).find((n) => n.checked) || {}).attrs.value;

    // Раздел CRM открыт — из него вывелись бы все его строки…
    assert.equal(chosen('crm'), 'edit', 'раздел из старых полей не доехал');
    assert.equal(chosen('crm.calls'), 'view', 'ненастроенная строка обязана читаться по старым полям');
    // …но у этих двух есть решение администратора, и оно главнее.
    assert.equal(chosen('crm.dial'), 'none', 'явный запрет перебит выводом из старых полей');
    assert.equal(chosen('crm.recording'), 'none', 'явный запрет перебит выводом из старых полей');

    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.equal(saved.grants['crm.dial'], 'none', 'сохранение вернуло роли отнятое право');
    assert.equal(saved.grants['crm.recording'], 'none', 'сохранение вернуло роли отнятое право');
    // ROLES_SAVE_TRUTH_V1 — нетронутый незаписанный ключ не пишется: журнал
    // регистратуре по-прежнему даёт сервер по списку ролей, а не запись.
    assert.ok(!('crm.calls' in saved.grants), 'нетронутый ключ записан');
  } finally {
    SAVED.registrar.sections = ['patients', 'dashboard'];
    SAVED.registrar.levels = { patients: 'editor', dashboard: 'viewer' };
    delete SAVED.registrar.grants;
  }
});

// ---------------------------------------------------------------------------
// CALLCENTER_OPERATOR_V1 — «НЕТ» У РАЗДЕЛА ЗАКРЫВАЕТ ВСЁ, ЧТО В НЁМ.
// ---------------------------------------------------------------------------
// Экран гасит окна и действия закрытого раздела, но гасит ТОЛЬКО на экране:
// input.disabled не меняет значения, а сбор читает и погашенные переключатели.
// В базу уезжало «custdev: Нет, custdev.list: Просмотр, custdev.rate:
// Изменение» — и сервер, спрошенный про окно, пускал на доску закрытого
// раздела. Погасить — это про экран; ОТНЯТЬ — это про то, что уезжает в базу.
test('раздел, поставленный в «Нет», сохраняется закрытым вместе со всеми своими строками', async () => {
  resetServer();
  // Колл-центр ровно таким, каким его оставляют миграции 059 (доска CRM), 078
  // (Cust Dev) и 141 (ключи телефонии), — то есть без единой настройки руками.
  SAVED.callcenter = {
    sections: ['crm', 'custdev', 'patients'],
    levels: { crm: 'admin', custdev: 'admin', patients: 'editor' },
    grants: { 'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit', 'crm.convert': 'edit' },
  };
  try {
    const root = await render();
    roleButton(root, 'callcenter').click();
    await tick();

    pick(root, 'custdev', 'none');
    pick(root, 'crm', 'none');

    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    assert.equal(lastUpdate.role, 'callcenter');
    const saved = JSON.parse(lastUpdate.values.permissions);
    for (const key of ['custdev.list', 'custdev.rate', 'crm.calls', 'crm.dial', 'crm.recording', 'crm.convert']) {
      assert.equal(saved.grants[key], 'none', 'строка закрытого раздела уехала в базу открытой: ' + key);
    }
    assert.equal(saved.grants.custdev, 'none');
    assert.equal(saved.grants.crm, 'none');
    assert.ok(!saved.sections.includes('custdev'), 'старая галочка закрытого раздела осталась выданной');
    assert.ok(!saved.sections.includes('crm'));
    // ROLES_SAVE_TRUTH_V1 — соседний раздел не тронут и не записан.
    assert.ok(!('patients' in saved.grants), 'закрытие одного раздела задело соседний');
    assert.ok(saved.sections.includes('patients') && saved.levels.patients === 'editor', 'старые поля соседнего раздела тронуты');
  } finally {
    delete SAVED.callcenter;
  }
});

// Та же беда, доставшаяся по наследству: запись «раздел Нет, окно Просмотр»
// уже лежит в базе (её и писал экран до этой правки). Сохранение роли обязано
// её ПОЧИНИТЬ, даже если администратор к этому разделу не прикасался, — иначе
// сломанная строка живёт вечно и ждёт ворот, которые спросят только про окно.
//
// И ровно этого НЕЛЬЗЯ делать по «Нет», ВЫВЕДЕННОМУ из старой галочки: у
// колл-центра ключи телефонии выданы точечно (миграция 141), а раздел CRM
// здесь закрыт — обнуление по нему отняло бы у оператора телефон, которого
// никто не закрывал.
test('унаследованное «раздел Нет, окно Просмотр» чинится при сохранении, а выведенное «Нет» ничего не отнимает', async () => {
  resetServer();
  SAVED.callcenter = {
    sections: ['patients'],
    levels: { patients: 'editor' },
    grants: {
      custdev: 'none', 'custdev.list': 'view', 'custdev.rate': 'edit',
      'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit', 'crm.convert': 'edit',
    },
  };
  try {
    const root = await render();
    roleButton(root, 'callcenter').click();
    await tick();

    // Ничего не трогаем — просто сохраняем роль.
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.equal(saved.grants['custdev.list'], 'none', 'сломанная строка закрытого раздела пережила сохранение');
    assert.equal(saved.grants['custdev.rate'], 'none');
    // Раздел CRM закрыт лишь ВЫВОДОМ из старых полей — ни ключи не тронуты, ни
    // сам раздел не записан решением.
    assert.ok(!('crm' in saved.grants), 'выведенное «Нет» уехало в базу решением');
    assert.equal(saved.grants['crm.dial'], 'edit', 'сохранение отняло телефон, которого администратор не закрывал');
    assert.equal(saved.grants['crm.calls'], 'view');
  } finally {
    delete SAVED.callcenter;
  }
});

// ---------------------------------------------------------------------------
// CALLCENTER_OPERATOR_V1 — ВЫВЕДЕННОЕ «НЕТ» НЕ СТАНОВИТСЯ РЕШЕНИЕМ ПРИ
// СОХРАНЕНИИ ЧУЖОЙ СТРОКИ.
// ---------------------------------------------------------------------------
// Сохранение пишет матрицу ЦЕЛИКОМ, и пока раздел, закрытый лишь выводом из
// старой галочки, уезжал в неё как `crm: none`, беда приходила через шаг:
// сервер такое «Нет» от решения не отличает и закрывает по нему ВСЁ, что
// внутри, — включая `crm.dial`, выданный колл-центру миграцией 141. Оператор
// терял телефон после того, как администратор открыл его роль, поправил
// что-то постороннее и нажал «Сохранить», а экран всё это время показывал
// «Позвонить пациенту: Изменение».
test('раздел, закрытый лишь выводом из старых полей, не уезжает в базу решением', async () => {
  resetServer();
  // Колл-центр с неотмеченной доской CRM и ключами телефонии от миграции 141.
  SAVED.callcenter = {
    sections: ['dashboard', 'telegram-chat', 'custdev'],
    levels: { dashboard: 'viewer', 'telegram-chat': 'editor', custdev: 'admin' },
    grants: { 'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit', 'crm.convert': 'edit' },
  };
  try {
    const root = await render();
    roleButton(root, 'callcenter').click();
    await tick();
    const chosen = (key) => (radiosFor(root, key).find((n) => n.checked) || {}).attrs.value;
    assert.equal(chosen('crm'), 'none', 'раздел CRM обязан читаться закрытым — его нет в старых полях');
    assert.equal(chosen('crm.dial'), 'edit', 'выданный миграцией ключ не доехал до экрана');

    // Администратор правит ПОСТОРОННЕЕ и сохраняет.
    pick(root, 'documents', 'view');
    findButtonByText(root, /Сохранить роль/).click();
    await tick();

    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.equal(lastUpdate.role, 'callcenter');
    assert.equal(saved.grants['crm.dial'], 'edit', 'сохранение отняло телефон, выданный миграцией');
    assert.equal(saved.grants['crm.calls'], 'view');
    assert.equal(saved.grants['crm.recording'], 'edit');
    assert.ok(!('crm' in saved.grants),
      'выведенное «Нет» записано решением — сервер закроет по нему все ключи телефонии');
    assert.ok(!saved.sections.includes('crm'), 'старые поля не должны были измениться');
    assert.equal(saved.grants.documents, 'view', 'посторонняя правка не сохранилась');
  } finally {
    delete SAVED.callcenter;
  }
});

// Закрыть раздел и тут же передумать — обычное движение руки. Обнуление строк
// при закрытии не должно стоить администратору всей настройки раздела: пока
// экран открыт, прежние уровни помнятся и возвращаются.
test('раздел, закрытый и снова открытый, возвращает свои строки', async () => {
  resetServer();
  SAVED.callcenter = {
    sections: ['crm', 'custdev', 'patients'],
    levels: { crm: 'admin', custdev: 'admin', patients: 'editor' },
    grants: { 'crm.calls': 'view', 'crm.dial': 'edit', 'crm.recording': 'edit', 'crm.convert': 'edit' },
  };
  try {
    const root = await render();
    roleButton(root, 'callcenter').click();
    await tick();
    const chosen = (key) => (radiosFor(root, key).find((n) => n.checked) || {}).attrs.value;

    pick(root, 'crm', 'none');
    assert.equal(chosen('crm.dial'), 'none', 'закрытие раздела не обнулило его строку');
    assert.equal(chosen('crm.calls'), 'none');

    pick(root, 'crm', 'edit');
    assert.equal(chosen('crm.dial'), 'edit', 'открытый обратно раздел не вернул свои строки');
    assert.equal(chosen('crm.calls'), 'view');
    assert.equal(chosen('crm.recording'), 'edit');

    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    // ROLES_SAVE_TRUTH_V1 — открыли обратно: раздел вернулся к показанному и не
    // пишется; его старый уровень остаётся тем, что записан.
    assert.ok(!('crm' in saved.grants), 'раздел, вернувшийся к показанному, записан');
    assert.equal(saved.levels.crm, 'admin', 'старый уровень раздела переписан выводом');
    assert.equal(saved.grants['crm.dial'], 'edit', 'сохранение записало обнулённую строку');
  } finally {
    delete SAVED.callcenter;
  }
});

// Память о закрытых строках живёт до ПЕРВОГО возврата, и не дольше. Иначе
// выходит вот что: закрыли раздел и открыли обратно, потом сняли право руками,
// потом снова закрыли и открыли — и снятое право возвращается само, из записи,
// сделанной до того, как администратор передумал. Экран молча отменяет решение
// человека, и заметить это можно только по спискам в базе.
test('закрыть → открыть → снять право → закрыть → открыть: снятое право не возвращается', async () => {
  resetServer();
  SAVED.callcenter = { sections: ['custdev', 'patients'], levels: { custdev: 'admin', patients: 'editor' } };
  try {
    const root = await render();
    roleButton(root, 'callcenter').click();
    await tick();
    const chosen = (key) => (radiosFor(root, key).find((n) => n.checked) || {}).attrs.value;
    assert.equal(chosen('custdev.rate'), 'edit', 'строка раздела не доехала до экрана');

    // Закрыли и передумали — строки вернулись, как и задумано.
    pick(root, 'custdev', 'none');
    assert.equal(chosen('custdev.rate'), 'none');
    pick(root, 'custdev', 'edit');
    assert.equal(chosen('custdev.rate'), 'edit', 'открытый обратно раздел не вернул свою строку');

    // А теперь администратор снимает право САМ — и снова закрывает-открывает.
    pick(root, 'custdev.rate', 'none');
    pick(root, 'custdev', 'none');
    pick(root, 'custdev', 'edit');
    assert.equal(chosen('custdev.rate'), 'none', 'снятое администратором право вернулось само');
    assert.equal(chosen('custdev.list'), 'view', 'заодно потерялась соседняя строка');

    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.equal(saved.grants['custdev.rate'], 'none', 'в базу уехало право, которое администратор снял');
    // ROLES_SAVE_TRUTH_V1 — нетронутые строки не пишутся: «Доска обзвона» и сам
    // раздел вернулись к показанному.
    assert.ok(!('custdev.list' in saved.grants), 'нетронутое окно записано');
    assert.ok(!('custdev' in saved.grants), 'вернувшийся раздел записан');
  } finally {
    delete SAVED.callcenter;
  }
});

test('изменение галочки вкладки считается несохранённым — уход спрашивает', async () => {
  resetServer();
  const root = await render();
  const [view] = tabBoxesFor(root, 'billing');
  view.checked = false;
  view.dispatchEvent({ type: 'change', currentTarget: view, target: view });
  confirmAnswer = false;
  roleButton(root, 'doctor').click();
  await tick();
  assert.equal(confirmCalls, 1, 'экран не заметил снятую галочку вкладки');
});

// ADMIN_ROWS_GRANTABLE_V1 — «Роли» у не-администратора. «Просмотр» — экран
// без записи; «Изменение» — без роли администратора в основах и без правки
// своей собственной роли (сервер отказывает второй раз, services/role-guard.js).
test('«Роли: Просмотр» — только чтение: нет «Сохранить», нет новой роли, переключатели погашены', async () => {
  resetServer();
  const container = mk('div');
  await renderRolesEditor(container, { readOnly: true });
  await tick();
  assert.ok(!findButtonByText(container, /Сохранить роль/), 'кнопка сохранения на «Просмотре»');
  assert.ok(!findButtonByText(container, /Новая роль/), 'новую роль заводят на «Просмотре»');
  assert.ok(textOf(container).includes('Только просмотр'), 'не сказано, почему нельзя');
  assert.ok(radios(container).length && radios(container).every((n) => n.disabled), 'переключатели матрицы живые');
  assert.ok(tabBoxes(container).every((n) => n.disabled), 'галочки вкладок живые');
});

test('«Роли: Изменение» у медсестры: основы — только свои, роль администратора не предлагается, своя роль заперта', async () => {
  resetServer();
  const perms = await import('../permissions.js');
  SAVED.nurse = { sections: ['patients'], levels: { patients: 'editor' }, grants: { settings: 'view', 'settings.roles': 'edit' } };
  window.easymed.state.user = { id: 60, role: 'nurse', extra_roles: [] };
  perms.setEffectiveFromRole({ name: 'nurse', permissions: SAVED.nurse });
  try {
    const root = await render();
    const baseSel = selects(root).find((s) => s.attrs['aria-label'] === 'Основа новой роли');
    assert.ok(baseSel, 'нет выбора основы');
    const bases = baseSel.children.map((o) => o.attrs.value);
    assert.deepStrictEqual(bases, ['nurse'], 'основы не сужены до своих ролей');
    assert.ok(findButtonByText(root, /Сохранить роль/), 'чужую роль (регистратор) сохранить нельзя');
    roleButton(root, 'nurse').click();
    await tick();
    assert.ok(!findButtonByText(root, /Сохранить роль/), 'своя роль сохраняется');
    assert.ok(textOf(root).includes('Это ваша собственная роль'), 'не сказано, почему своя роль заперта');
  } finally {
    delete SAVED.nurse;
    window.easymed.state.user = null;
    perms.setFullAccess('Admin');
  }
});

// ADMIN_ROWS_GRANTABLE_V1 (ревью безопасности) — новая своя роль заводится ОДНИМ
// вызовом сервера (custom_role_create), а не двумя записями через /api/db.
test('«Новая роль» — один вызов custom_role_create, без прямых записей custom_roles / role_permissions', async () => {
  resetServer();
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).startsWith('/api/rpc/custom_role_create')) return jsonOk({ code: body.code, name: body.name, base_role: body.base_role, active: 1 });
    return prev(url, opts);
  };
  try {
    const root = await render();
    const nameInp = tagsOf(root, 'INPUT').find((n) => n.attrs['aria-label'] === 'Название новой роли');
    nameInp.value = 'Старший регистратор';
    findButtonByText(root, /Новая роль/).click();
    await tick(40);
    const rpc = calls.filter((c) => c.url.startsWith('/api/rpc/custom_role_create'));
    assert.equal(rpc.length, 1, 'сервер не позван');
    assert.equal(rpc[0].body.base_role, 'registrar');
    assert.ok(/^[a-z0-9-]+$/.test(rpc[0].body.code), 'код не строчный: ' + rpc[0].body.code);
    const writes = calls.filter((c) => c.url.startsWith('/api/db') && c.body && c.body.op === 'insert' && ['custom_roles', 'role_permissions'].includes(c.body.table));
    assert.deepEqual(writes, [], 'полроли можно оставить прямыми записями');
  } finally { globalThis.fetch = prev; }
});

// CASHIER_HEAD_V1 (2026-09-28) — «касса только принимает оплату или принимает и
// исправляет»: переключатель в разделе «Касса». У кассира, которого не
// настраивали, он ВЫКЛЮЧЕН, и простое пересохранение роли его не включает;
// включённый уходит в базу явным «Изменением». «Старший кассир» — в списке ролей.
test('CASHIER_HEAD_V1: «Исправляет услуги в счёте» у кассира выключено, включается и сохраняется', async () => {
  resetServer();
  SAVED.cashier = { sections: ['cashier', 'patients', 'dashboard'], levels: { cashier: 'admin', patients: 'editor', dashboard: 'viewer' } };
  try {
    const root = await render();
    assert.ok(roleButton(root, 'head_cashier'), 'в списке ролей нет «Старшего кассира»');
    assert.ok(textOf(root).includes('Старший кассир'));
    roleButton(root, 'cashier').click();
    await tick();
    const on = () => radiosFor(root, 'cashier.lines').find((n) => n.checked);
    assert.equal(on() && on().attrs.value, 'none', 'у кассира по умолчанию право должно быть выключено');
    assert.ok(textOf(root).includes('Исправляет услуги в счёте'));

    // Пересохранили роль, ничего не трогая, — право так и не выдано.
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    let written = JSON.parse(lastUpdate.values.permissions);
    assert.equal(lastUpdate.role, 'cashier');
    assert.ok(!('cashier.lines' in written.grants), 'пересохранение раздало право: ' + written.grants['cashier.lines']);

    // Включили — уходит «Изменение».
    pick(root, 'cashier.lines', 'edit');
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    written = JSON.parse(lastUpdate.values.permissions);
    assert.equal(written.grants['cashier.lines'], 'edit');
    assert.ok(written.sections.includes('cashier'), 'касса осталась выдана');
  } finally { delete SAVED.cashier; }
});

// ---------------------------------------------------------------------------
// ROLES_SAVE_TRUTH_V1 — ЭКРАН ПОКАЗЫВАЕТ ПРАВДУ, «СОХРАНИТЬ РОЛЬ» ПИШЕТ ТРОНУТОЕ.
// ---------------------------------------------------------------------------
// Экран рисовал у незаписанного ключа догадку из старой галочки раздела и
// писал матрицу целиком: первое же «Сохранить роль» без правок выдавало
// регистратуре измерения стационара, а оператору — чужие заявки. Теперь
// незаписанный ключ с серверными воротами рисуется ответом сервера
// (role_effective_grants), записанный — как записан, а в базу уходит только
// записанное и тронутое. Сквозь настоящий сервер то же проверяет
// roles-save-truth.test.mjs.
test('ROLES_SAVE_TRUTH_V1: правда сервера перекрывает догадку экрана, записанное — всё; пустое сохранение пишет только записанное', async () => {
  resetServer();
  SAVED.registrar = { sections: ['patients', 'crm', 'beds'], levels: { patients: 'editor', crm: 'editor', beds: 'editor' }, grants: { 'inpatient.marks': 'view' } };
  EFFECTIVE.registrar = { 'crm.all': 'none', 'inpatient.vitals': 'none', 'inpatient.marks': 'none', 'crm.calls': 'view' };
  try {
    const root = await render();
    const chosen = (key) => ((radiosFor(root, key).find((n) => n.checked) || {}).attrs || {}).value;
    assert.equal(chosen('crm.all'), 'none', 'догадка «раздел выдан — внутри всё» перебила сервер');
    assert.equal(chosen('inpatient.vitals'), 'none');
    assert.equal(chosen('inpatient.marks'), 'view', 'записанное у роли перебито ответом сервера');
    assert.equal(chosen('crm'), 'edit', 'раздел выводится из старых полей, как и прежде');
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.deepStrictEqual(saved.grants, { 'inpatient.marks': 'view' }, 'пустое сохранение записало то, чего не трогали');
    assert.deepStrictEqual([...saved.sections].sort(), ['beds', 'crm', 'patients']);
    assert.deepStrictEqual(saved.levels, { patients: 'editor', crm: 'editor', beds: 'editor' });
  } finally {
    SAVED.registrar = { sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } };
    delete EFFECTIVE.registrar;
  }
});

// Вернуться к догадке экрана без ответа сервера значило бы вернуть ту самую
// ошибку: поэтому без правды сервера роль только смотрят.
test('ROLES_SAVE_TRUTH_V1: сервер не сказал, что у роли есть сейчас — только чтение, «Сохранить роль» заперта', async () => {
  resetServer();
  effectiveRespond = () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'database is locked' } }) });
  const root = await render();
  const text = textOf(root);
  assert.ok(text.includes('Не удалось узнать, какие права у роли сейчас, — сохранять нельзя. Обновите страницу.'), 'нет предупреждения');
  assert.ok(text.includes('database is locked'), 'причина не показана');
  const btn = findButtonByText(root, /Сохранить роль/);
  assert.ok(btn && btn.disabled === true, '«Сохранить роль» не заперта');
  btn.click();
  await tick();
  assert.strictEqual(updateCalls, 0, 'без правды сервера роль сохранилась — вернулась бы прежняя ошибка');
  assert.ok(radios(root).length && radios(root).every((n) => n.disabled), 'переключатели живые');
  assert.ok(tabBoxes(root).every((n) => n.disabled), 'галочки вкладок живые');
});

// Незаписанные окна раздела оболочка выводит из его старого ключа: сдвинь
// правка раздела старый ключ — и окна сдвинутся следом, хотя экран показывал
// их прежними. Поэтому тронутый раздел пишет свои окна такими, как их видно.
test('ROLES_SAVE_TRUTH_V1: тронутый раздел пишет свои окна такими, как их видно; старые поля следуют выводу только там, где он сдвинулся', async () => {
  resetServer();
  SAVED.lab = { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } };
  try {
    const root = await render();
    roleButton(root, 'lab').click();
    await tick();
    pick(root, 'patients', 'edit');
    findButtonByText(root, /Сохранить роль/).click();
    await tick();
    const saved = JSON.parse(lastUpdate.values.permissions);
    assert.equal(lastUpdate.role, 'lab');
    assert.deepStrictEqual(saved.grants, { patients: 'edit', 'patients.list': 'view', 'patients.queue': 'view', 'patients.calendar': 'view' },
      'окна раздела не записаны такими, какими их видно — «Записи» вывелись бы из нового «editor» в «Изменение»');
    assert.ok(saved.sections.includes('registration'), '«Пациенты: Изменение» не открыли регистрацию');
    assert.ok(!saved.sections.includes('queue'), 'очередь дописана, хотя её вывод не сдвинулся');
    assert.equal(saved.levels.patients, 'editor');
    assert.equal(saved.levels.labs, 'editor', 'чужой раздел тронут');
  } finally { delete SAVED.lab; }
});

// Плашка миграции 230 — у того, кто вправе менять роль; на «Просмотре» решать
// нечем, и кнопок, которые всё равно отклонят, там быть не должно.
test('ROLES_SAVE_TRUTH_V1: плашка «Проверьте права этой роли» — у того, кто вправе менять роль; на «Просмотре» её нет', async () => {
  resetServer();
  SAVED.registrar.grants = { 'crm.all': 'edit' };
  GRANT_REVIEWS = [{ id: 5, role: 'registrar', key: 'crm.all', level: 'edit', standard: 'none', resolution: null }];
  try {
    const root = await render();
    await tick();
    assert.ok(textOf(root).includes('Проверьте права этой роли'), 'плашки нет');
    assert.ok(textOf(root).includes('«CRM · Заявки → Видит все заявки и передаёт их»'), 'право не названо словами справочника');
    assert.ok(findButtonByText(root, /Убрать эти права/), 'нет кнопки «Убрать эти права»');
    const ro = mk('div');
    await renderRolesEditor(ro, { readOnly: true });
    await tick();
    assert.ok(!textOf(ro).includes('Проверьте права этой роли'), 'плашка с кнопками на «Просмотре»');
  } finally { delete SAVED.registrar.grants; GRANT_REVIEWS = []; }
});
