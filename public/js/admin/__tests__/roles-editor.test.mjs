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
function resetServer() {
  selectCalls = 0; updateCalls = 0; lastUpdate = null; toastMsg = null;
  confirmAnswer = true; confirmCalls = 0; lastConfirmText = null;
  selectRespond = null; updateRespond = null;
}
const roleOf = (desc) => (desc.filters.find((f) => f.col === 'role') || {}).val;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const desc = opts && opts.body ? JSON.parse(opts.body) : null;
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
    'Что можно делать',
    'Регистратор',
  ]) assert.ok(text.includes(s), 'нет русской строки: ' + s);

  // «Overview» — единственная группа с английским ИСХОДНИКОМ (permissions.js);
  // без словарной записи она осталась бы английской посреди русского экрана.
  assert.ok(text.includes('Обзор'), 'группа Overview переведена');
  assert.ok(!text.includes('Overview'), 'английская группа не осталась: ' + text.slice(0, 200));

  // Уровни названы действием, а не системной ролью View/Edit/Full.
  // Текст у h() лежит в дочернем текстовом узле, а не в самом элементе.
  const opts = tagsOf(selects(root)[0], 'OPTION').map((o) => textOf(o));
  assert.deepStrictEqual(opts, ['Только просмотр', 'Просмотр и изменение', 'Изменение и удаление']);

  // Английские строки V1 не должны выжить нигде на экране.
  for (const gone of ['Roles & permissions', 'Save role', 'Back to settings', 'module access',
                      'Choose what each staff role sees', 'Loading…']) {
    assert.ok(!text.includes(gone), 'английский остаток V1: ' + gone);
  }
});

test('уровень доступа подписан, а заблокированный говорит причину', async () => {
  resetServer();
  const root = await render();

  const all = selects(root);
  assert.strictEqual(all.length, moduleBoxes(root).length, 'по списку уровня на каждый раздел');
  for (const s of all) {
    const label = s.getAttribute('aria-label') || '';
    assert.ok(label.startsWith('Уровень доступа: '), 'у списка нет подписи: ' + label);
    assert.ok(label.length > 'Уровень доступа: '.length, 'подпись называет раздел: ' + label);
    assert.ok(s.getAttribute('aria-describedby'), 'список ссылается на строку-причину');
  }

  // Отмеченный раздел — список доступен и причина скрыта; неотмеченный —
  // наоборот, и причина названа словами, а не молчанием.
  const rows = byClass(root, 'roles-row');
  const rowOf = (key) => rows.find((r) => walk(r).some((n) => n.attrs.id === 'roles-why-' + key));
  const pick = (key) => ({
    chk: checkboxes(rowOf(key))[0], sel: selects(rowOf(key))[0],
    why: walk(rowOf(key)).find((n) => n.attrs.id === 'roles-why-' + key),
  });

  const patients = pick('patients');           // выдан регистратору
  assert.strictEqual(patients.chk.checked, true);
  assert.strictEqual(patients.sel.disabled, false);
  assert.ok(patients.why.classList.contains('is-hidden'), 'причина спрятана, пока раздел отмечен');

  const labs = pick('labs');                   // не выдан
  assert.strictEqual(labs.chk.checked, false);
  assert.strictEqual(labs.sel.disabled, true);
  assert.strictEqual(textOf(labs.why), 'Сначала отметьте раздел');
  assert.ok(!labs.why.classList.contains('is-hidden'), 'причина видна рядом с заблокированным списком');

  // И причина исчезает ровно тогда, когда раздел отмечают.
  labs.chk.checked = true;
  labs.chk.dispatchEvent({ type: 'change' });
  assert.strictEqual(labs.sel.disabled, false);
  assert.ok(labs.why.classList.contains('is-hidden'));
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
  // Контракт хранения не менялся: те же sections + levels в role_permissions.
  const written = JSON.parse(lastUpdate.values.permissions);
  assert.deepStrictEqual(written.sections.sort(), ['dashboard', 'patients']);
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

  // Отмечаем раздел и пробуем уйти, ответив «нет».
  const box = checkboxes(root).find((c) => !c.checked);
  box.checked = true;
  box.dispatchEvent({ type: 'change' });
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
  const chk = checkboxes(root).find((c) => !c.checked);
  chk.checked = true; chk.dispatchEvent({ type: 'change' });
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
    services: 'delete', labs: 'view', docs: 'delete', billing: 'view',
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
