// QUICK_PATIENT_V1 (2026-09-21) — ОДНО ОКНО «НОВЫЙ ПАЦИЕНТ» НА ВСЕ ПОТОКИ.
// docs/plans/2026-09-21-quick-patient-everywhere.md, задача Q1.
//
// Владелец: «the linking patient, and the creating patient in the linking, in
// the calendar and in the calculator should add a new patient by flow of fast
// registration». До этого каждый поток заводил пациента СВОЕЙ мини-формой из
// пяти полей: калькулятор — своей, календарь — своей, карточка CRM — своей.
// Пол и дата рождения там не спрашивались вовсе, а от них зависят нормы
// анализов и печатные бланки: карта, заведённая «по дороге», выходила хуже
// карты, заведённой на своей странице.
//
// Что проверяется здесь — по предложению на решение:
//
//   * ОКНО — ЭТО БЛОК РЕКВИЗИТОВ БЫСТРОЙ РЕГИСТРАЦИИ. Те же поля, того же
//     сборщика (buildPatientFields, layout: 'compact'), в том же порядке.
//     Второй набор полей разошёлся бы с первым МОЛЧА — ровно это и случилось
//     с мини-формами.
//   * СОЗДАНИЕ — ОДНА ВСТАВКА, И КАРТА УХОДИТ ПОЗВАВШЕМУ. onCreated получает
//     ту самую строку, которой окно и закрывается: поток (привязка в
//     калькуляторе, запись в календаре, карточка CRM) продолжает с ней.
//   * ДУБЛИКАТ НЕ ЗАВОДИТ ВТОРУЮ КАРТУ. «Открыть существующего» здесь значит
//     «привязать найденного», а не уйти в его карту: уход потерял бы всё, что
//     набрано в окне, из которого пациента заводили.
//   * ПРАВО. Роль без ключа «Регистрация пациента» видит отказ, а не окно.
//   * ЭТАЖ. Окно открывается ПОВЕРХ окна привязки каталога (150) и ПОД
//     стражем дубликатов (160). Ошибка здесь читается как «кнопка не
//     работает»: окно открыто, но за тем, кто его позвал.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const srcOf = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

// ---------------------------------------------------------------------------
// Фальшивый DOM — тот же, что в fast-registration.test.mjs.
// ---------------------------------------------------------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);c.parentNode=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.appendChild(c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 fireInput(){this.dispatchEvent({type:'input',currentTarget:this,target:this});}
 fireChange(){this.dispatchEvent({type:'change',currentTarget:this,target:this});}
 focus(){ focused = this; } blur(){} scrollTo(){} scrollIntoView(){} remove(){ if(this.parentNode) this.parentNode.removeChild(this); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 closest(sel){const c=String(sel).replace(/^\./,'');let n=this;
   while(n){if(String(n.className||'').split(/\s+/).includes(c))return n;n=n.parentNode;}return null;}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className||'').split(/\s+/).includes(c),add(c){s.className=(s.className?s.className+' ':'')+c;},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
let focused = null;
function mk(t){
  const el = new F(t);
  if (el.tagName === 'TEMPLATE') {
    el.content = { firstChild: null };
    Object.defineProperty(el, 'innerHTML', { set(v) { const s = new F('svg'); s._t = String(v); el.content.firstChild = s; }, get() { return ''; } });
  }
  if (el.tagName === 'SELECT') {
    Object.defineProperty(el, 'options', { get() { return el.children.filter((c) => c.tagName === 'OPTION'); } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const toastEl = mk('div');
// Слушатели документа НАСТОЯЩИЕ: Escape должен доходить и до окна, и до
// дочернего диалога — как в браузере, где оба висят на одном document.
const docListeners = {};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),
  head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(type, fn){ (docListeners[type] || (docListeners[type] = [])).push(fn); },
  removeEventListener(type, fn){ const a = docListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  dispatchEvent(e){ for (const fn of (docListeners[e.type] || []).slice()) fn(e); return true; },
  getElementById:(id)=> (id === 'toast' ? toastEl : null),
  querySelector(){return null;},querySelectorAll(){return [];}};
const toasts = [];
Object.defineProperty(toastEl, 'textContent', { get(){ return toastEl._t; }, set(v){ toastEl._t = String(v); toasts.push(String(v)); } });

function makeLocalStorage() {
  const store = new Map();
  return { getItem:(k)=>(store.has(k)?store.get(k):null), setItem:(k,v)=>{store.set(k,String(v));},
           removeItem:(k)=>{store.delete(k);}, clear:()=>store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js выбирает язык ОДИН раз при загрузке модуля.
fakeLocalStorage.setItem('admin.lang', 'ru');

globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 3, full_name: 'Регистратор', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true, prompt: () => null,
  open: () => null,
  easymedSetTabSub(){}, easymedSetTabLabel(){},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };
try { Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: null }, configurable: true }); } catch (e) { /* node уже дал свой navigator */ }

// ---------------------------------------------------------------------------
// Фальшивый транспорт. Записываем ВСЁ: каждую выборку и каждую вставку —
// «сколько раз завели карту» и есть предмет двух проверок ниже.
// ---------------------------------------------------------------------------
const calls = [];            // { kind: 'rpc'|'insert'|'select', name/table, body }
let patientRows = [];        // чем отвечает выборка по patients (страж дублей)
// Задержка ВСТАВКИ: { table, promise } — окно встаёт на записи, и в этот миг
// проверяется, что Escape его не закрывает.
let holdInsert = null;
// ОТКАЗ ВСТАВКИ: имя таблицы — сервер отвечает ошибкой. Нужен, чтобы проверить
// «не вышло» там, где окно и диалог обязаны остаться на экране.
let failInsert = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });

  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    calls.push({ kind: 'rpc', name, body });
    return ok({ data: null });
  }

  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      calls.push({ kind: 'insert', table, body: body.values });
      if (holdInsert && holdInsert.table === table) await holdInsert.promise;
      if (failInsert === table) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'запись отклонена' } }) };
      }
      const row = table === 'patients'
        ? { id: 501, mrn: 'P-501', ...body.values }
        : { id: 1, ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    calls.push({ kind: 'select', table, body });
    const rows = table === 'patients' ? patientRows
      : table === 'branches' ? [{ id: 1 }]
      : [];
    return ok({ data: body && body.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const { openQuickPatientModal, QUICK_PATIENT_Z } = await import('../views/quick-patient-modal.js');
const { setFullAccess, setEffectiveFromRole, canCreatePatient, isRouteAllowed } = await import('../permissions.js');

// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const dialogs = (name) => walk(document.body).filter((n) => n.attrs['data-dialog'] === name);
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const btnByText = (root, text) => buttons(root).find((b) => textOf(b).replace(/\s+/g, ' ').trim().includes(text));
// Подписи компактной формы по порядку, без звёздочки обязательности.
const frLabels = (form) => (form.children || []).filter((n) => hasClass(n, 'fr-label'))
  .map((n) => textOf(n).replace(/\*/g, '').replace(/\s+/g, ' ').trim());

function reset() {
  calls.length = 0; toasts.length = 0; focused = null;
  patientRows = []; holdInsert = null; failInsert = null;
  document.body.children.length = 0;
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  setFullAccess('Admin');
}

const escapeKeydown = () => document.dispatchEvent({ type: 'keydown', key: 'Escape' });

// Enter приходит НА КАРТОЧКУ окна (обработчик висит там), а `target` — поле, в
// котором стоял курсор: фальшивый DOM события не всплывает, поэтому цель
// задаём явно, как её увидел бы браузер.
// Возвращает, ЧТО окно сделало с событием: Enter внутри окна обязан остановить
// всплытие — иначе тот же Enter доберётся до формы или каталога, из которых
// окно позвали, и сработает дважды.
function pressEnter(dlg, target) {
  const seen = { prevented: 0, stopped: 0 };
  dlg.card.dispatchEvent({
    type: 'keydown', key: 'Enter', target,
    preventDefault() { seen.prevented++; }, stopPropagation() { seen.stopped++; },
  });
  return seen;
}

/**
 * Чужая подложка .modal в документе — сосед этого окна.
 *
 * Ровно так выглядят и те, кто окно ПОЗВАЛ (каталог услуг 130, привязка
 * пациента 150), и те, кого оно открывает ПОВЕРХ себя (страж дубликатов 160).
 * Разница между ними — только этаж.
 */
function foreignModal(z) {
  const ov = document.createElement('div');
  ov.className = 'modal';
  ov.style.zIndex = String(z);
  document.body.appendChild(ov);
  return ov;
}

function fillMinimum(dlg) {
  const f = dlg.state.api.fields;
  f.last_name.value = 'Каримова';
  f.first_name.value = 'Азиза';
  f.date_of_birth.value = '1990-04-01';
  // Пол выбирают ПЛИТКОЙ — так же, как рукой: наружу окно подстановку пола не
  // отдаёт (подставлять его некому, см. проверку про state.api ниже).
  const chip = walk(dlg.card).find((e) => e.dataset && e.dataset.name === 'gender' && e.dataset.value === 'F');
  assert.ok(chip, 'в окне нет выбора пола — а он обязателен');
  chip.click();
}

const insertsInto = (table) => calls.filter((c) => c.kind === 'insert' && c.table === table).length;

// ===========================================================================
// 1. Окно — это блок реквизитов быстрой регистрации, и ничего сверх него.
// ===========================================================================
test('окно — реквизиты пациента как в быстрой регистрации', async () => {
  reset();
  const dlg = openQuickPatientModal({});
  assert.ok(dlg, 'окно не открылось');
  await tick(40);

  assert.strictEqual(dialogs('quick-patient').length, 1, 'окна «Новый пациент» нет в документе');
  assert.strictEqual(dlg.overlay.style.zIndex, '155', 'подложка окна не на своём этаже');
  assert.strictEqual(QUICK_PATIENT_Z, 155, 'этаж окна не вынесен наружу — привязать его будет нечем');
  assert.ok(hasClass(dlg.card, 'fr-card'), 'карточка не просит раскладку быстрой регистрации: ' + dlg.card.className);
  // Ширина — КЛАССОМ, а не встроенным стилем с пометкой !important. Встроенный
  // !important не перебить ничем, кроме такого же: узкий экран (медиазапрос
  // .fr-card) остался бы с окном в 1100 px, вылезающим за край.
  assert.ok(hasClass(dlg.card, 'fr-card-narrow'),
    'окно не просит свою ширину классом (у него нет таблицы услуг, значит оно уже): ' + dlg.card.className);
  assert.ok(!dlg.card.style.width,
    'ширину всё ещё просят встроенным стилем — медиазапросу её будет не перебить: ' + dlg.card.style.width);
  const css = fs.readFileSync(path.join(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
  const narrow = css.match(/\.fr-card-narrow\s*\{[^}]*\}/);
  assert.ok(narrow, 'правила .fr-card-narrow нет в admin-views.css — класс ничего не значит');
  assert.ok(/min\(1100px/.test(narrow[0]), 'у .fr-card-narrow не та ширина: ' + narrow[0]);
  assert.ok(css.indexOf('.fr-card-narrow') > css.indexOf('.fr-card {'),
    '.fr-card-narrow стоит ВЫШЕ .fr-card — при равном весе победит .fr-card, и окно станет широким');

  const txt = textOf(dlg.card).replace(/\s+/g, ' ');
  assert.ok(txt.includes('Новый пациент'), 'нет заголовка окна');
  assert.ok(txt.includes('Полная анкета — в карте пациента.'), 'не сказано, где заполняют остальное');

  // Поля — РОВНО те же и в том же порядке, что у быстрой регистрации, минус
  // её собственный ряд «Код отправителя» (это поле визита, а не карты).
  assert.ok(dlg.formEl && hasClass(dlg.formEl, 'fr-form'), 'окно не получило форму реквизитов');
  const labels = frLabels(dlg.formEl);
  assert.deepStrictEqual(labels, [
    'Клиент', 'Дата рождения', 'Пол', 'Телефон', 'Паспортные данные',
    'Резидентство', 'Область', 'Адрес', 'Тип скидки',
  ], 'поля окна: ' + labels.join(' | '));
  for (const gone of ['Email', 'Махалля', 'ПИНФЛ (ЖШШИР)', 'Район', 'Страна', 'Предпочитаемый язык']) {
    assert.ok(!labels.includes(gone), 'в быстром окне появилось поле «' + gone + '»');
  }
  // Строки поиска существующего здесь нет: искать — работа того окна, из
  // которого это позвали (привязка в калькуляторе ищет сама).
  assert.ok(!walk(dlg.card).some((n) => hasClass(n, 'mg-search')),
    'в окне заведения появился свой поиск — искать должен тот, кто позвал');

  const foot = walk(dlg.card).find((n) => hasClass(n, 'modal-foot'));
  assert.ok(foot, 'у окна нет подвала');
  assert.ok(buttons(foot).some((b) => textOf(b).includes('Создать пациента')), 'в подвале нет «Создать пациента»');
  assert.ok(buttons(foot).some((b) => textOf(b).includes('Отмена')), 'в подвале нет «Отмена»');
  dlg.close();
  await tick(20);
  assert.strictEqual(dialogs('quick-patient').length, 0, '«Отмена» не сняла окно с экрана');
});

// ===========================================================================
// 2. Создание: одна вставка, и карта уходит позвавшему.
// ===========================================================================
test('создание: collect → savePatient → onCreated → окно закрыто', async () => {
  reset();
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => created.push(p) });
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(80);

  assert.strictEqual(insertsInto('patients'), 1, 'карта заведена не одной вставкой: ' + insertsInto('patients'));
  const ins = calls.find((c) => c.kind === 'insert' && c.table === 'patients');
  assert.strictEqual(ins.body.last_name, 'Каримова', 'в базу уехала не набранная фамилия');
  assert.strictEqual(ins.body.gender, 'female', 'пол не доехал до базы — от него зависят нормы анализов');
  assert.strictEqual(ins.body.date_of_birth, '1990-04-01', 'дата рождения не доехала до базы');

  assert.strictEqual(created.length, 1, 'позвавший не получил карту: вызовов onCreated ' + created.length);
  assert.strictEqual(created[0].id, 501, 'onCreated получил не ту карту: ' + JSON.stringify(created[0]));
  assert.strictEqual(created[0].mrn, 'P-501', 'у карты нет номера — привязывать нечем');
  assert.strictEqual(dialogs('quick-patient').length, 0, 'окно осталось на экране после создания');
});

// ===========================================================================
// 3. Дубликат: «Открыть существующего» ПРИВЯЗЫВАЕТ найденного, а не уводит.
//
// У формы заведения то же нажатие уходит в карту пациента — там форма на этом
// и заканчивается. Здесь уход потерял бы всё, что набрано в окне, из которого
// пациента заводили (список услуг калькулятора, слот календаря, заявку CRM).
// ===========================================================================
test('дубль: «Открыть существующего» отдаёт найденную карту без второй вставки', async () => {
  reset();
  // PATIENT_DUP_RULE_V2 — телефон И имя это тот же человек.
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
                   middle_name: '', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' }];
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => created.push(p) });
  await tick(40);

  fillMinimum(dlg);
  dlg.state.api.fields.phone.value = '+998909610004';
  calls.length = 0;
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(60);

  const dup = dialogs('patient-duplicate');
  assert.strictEqual(dup.length, 1, 'страж дубликатов промолчал');
  assert.strictEqual(insertsInto('patients'), 0, 'карту завели, не спросив');

  const openExisting = walk(dup[0]).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'dup-row'));
  assert.ok(openExisting, 'в диалоге нет строки найденного пациента');
  openExisting.click();
  await tick(80);

  assert.strictEqual(insertsInto('patients'), 0, 'завели вторую карту на того же человека');
  assert.strictEqual(created.length, 1, 'позвавший не получил найденную карту');
  assert.strictEqual(created[0].id, 42, 'привязали не найденного: ' + JSON.stringify(created[0]));
  assert.strictEqual(dialogs('quick-patient').length, 0, 'окно осталось на экране после привязки');
});

// ===========================================================================
// 4. Право. Ключ «Регистрация пациента» открывает это окно так же, как окно
// заведения: молчащая кнопка читалась бы как поломка.
// ===========================================================================
test('медсестра без права «Регистрация пациента» — окно доступа, а не заведение', async () => {
  reset();
  setEffectiveFromRole({ name: 'nurse', permissions: {
    sections: ['patients', 'procedures', 'beds'],
    levels: { patients: 'editor', procedures: 'editor', beds: 'editor' },
  } });
  assert.strictEqual(isRouteAllowed('patients'), true, 'медсестре закрыли картотеку — проверяем не то');
  assert.strictEqual(canCreatePatient(), false);

  const dlg = openQuickPatientModal({});
  assert.strictEqual(dlg, null, 'окно открылось в обход права');
  assert.strictEqual(dialogs('quick-patient').length, 0, 'окно всё-таки нарисовалось');
  assert.strictEqual(dialogs('access-denied').length, 1, 'отказ промолчал — это читается как поломка');
  setFullAccess('Admin');
});

// ===========================================================================
// 5. Enter сохраняет; Escape ВО ВРЕМЯ записи не закрывает.
//
// Между нажатием и ответом сервера окно — единственное место, где известно,
// что именно записывается. Закрытие вставку не остановит, и карта появилась бы
// молча: позвавший её не получил бы и завёл бы вторую.
// ===========================================================================
test('Enter сохраняет, Esc во время сохранения не закрывает', async () => {
  reset();
  let release;
  holdInsert = { table: 'patients', promise: new Promise((r) => { release = r; }) };
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => created.push(p) });
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  const seen = pressEnter(dlg, dlg.state.api.fields.last_name);
  await tick(60);

  assert.strictEqual(insertsInto('patients'), 1, 'Enter не сохранил пациента');
  assert.strictEqual(seen.prevented, 1, 'Enter не отменил своё обычное действие — форма отправится сама');
  // Окно открывают ИЗ окон: из привязки каталога, из карточки CRM. У них свой
  // Enter, и всплывший туда — это второе действие на одно нажатие.
  assert.strictEqual(seen.stopped, 1, 'Enter ушёл наверх — тот же Enter сработает и у позвавшего');
  assert.strictEqual(dlg.state.saving, true, 'окно не считает себя записывающим — проверяется не то');

  escapeKeydown();
  await tick(20);
  assert.strictEqual(dialogs('quick-patient').length, 1, 'Esc закрыл окно посреди записи');
  assert.strictEqual(created.length, 0, 'карта отдана позвавшему до ответа сервера');

  release();
  holdInsert = null;
  await tick(80);
  assert.strictEqual(created.length, 1, 'после ответа сервера карту не отдали');
  assert.strictEqual(created[0].id, 501, 'отдали не ту карту');
  assert.strictEqual(dialogs('quick-patient').length, 0, 'окно не закрылось после записи');

  // А когда записи нет, Esc по-прежнему закрывает — проверка не должна была
  // превратиться в «Esc не работает вовсе».
  reset();
  const dlg2 = openQuickPatientModal({});
  await tick(40);
  escapeKeydown();
  await tick(20);
  assert.strictEqual(dialogs('quick-patient').length, 0, 'Esc перестал закрывать окно');
});

// ===========================================================================
// 6. ЭТАЖИ ОКОН. Окно привязки каталога (150) зовёт это окно, а оно зовёт
// стража дубликатов (160). Все трое — подложки .modal в document.body, соседи;
// кто выше, решает ТОЛЬКО z-index. Ошибка не видна ничем, кроме «кнопка не
// работает»: окно открыто, но за тем, кто его позвал.
//
// Числа не выдуманы проверкой — они вычитаны из тех самых файлов сегодня.
// ===========================================================================
test('этаж 155: выше окна привязки каталога и ниже стража дубликатов', async () => {
  reset();
  const dlg = openQuickPatientModal({});
  await tick(40);
  const mine = Number(dlg.overlay.style.zIndex);
  assert.strictEqual(mine, QUICK_PATIENT_Z, 'подложка и объявленный этаж разошлись');

  // Окно привязки пациента ВНУТРИ каталога услуг (сам каталог — 130).
  const picker = srcOf('views/service-picker-modal.js');
  const attachSrc = picker.slice(picker.indexOf('function openAttachPatientModal'));
  assert.ok(attachSrc, 'в каталоге больше нет openAttachPatientModal — проверку надо пересобрать');
  const attach = attachSrc.match(/class: 'modal', style: \{ zIndex: '(\d+)' \}/);
  assert.ok(attach, 'у окна привязки больше нет подложки с z-index — проверку надо пересобрать');
  assert.ok(mine > Number(attach[1]),
    'окно заведения (' + mine + ') не выше окна привязки (' + attach[1] + ') — оно откроется ЗА ним');

  // Страж дубликатов открывается поверх ЭТОГО окна.
  const pcm = srcOf('views/patient-create-modal.js');
  const dupSrc = pcm.slice(pcm.indexOf('export function openDuplicatePatientDialog'));
  const dup = dupSrc.match(/class: 'modal', style: \{ zIndex: '(\d+)' \}/);
  assert.ok(dup, 'у стража дубликатов больше нет подложки с z-index — проверку надо пересобрать');
  assert.ok(mine < Number(dup[1]),
    'окно заведения (' + mine + ') не ниже стража дубликатов (' + dup[1] + ') — вопрос о дубле откроется ЗА ним');

  dlg.close();
});

// ===========================================================================
// 7. ДОЧЕРНИМ СЧИТАЕТСЯ ТОЛЬКО ОКНО ВЫШЕ ЭТАЖОМ.
//
// Окно глушит Esc и Enter, пока поверх него стоит чужой диалог: страж
// дубликатов слушает тот же document, и Esc, закрывающий вопрос о дубле, снёс
// бы заодно и само окно с набранными полями.
//
// Но «чужой диалог в документе» — это ещё и ТЕ, КТО ОКНО ПОЗВАЛ: каталог услуг
// (130) и привязка пациента в нём (150). Они стоят ПОД окном и заслонить его
// не могут. Считая их дочерними, окно глохло ровно в самом частом случае —
// когда его открыли из каталога: Esc не закрывал, Enter не сохранял, и это
// читалось как «окно зависло».
// ===========================================================================
test('окно ПОД нами не глушит окно: Esc закрывает, Enter сохраняет', async () => {
  reset();
  foreignModal(150);   // привязка пациента в каталоге — она нас и позвала
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => created.push(p) });
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  pressEnter(dlg, dlg.state.api.fields.last_name);
  await tick(80);
  assert.strictEqual(insertsInto('patients'), 1,
    'Enter не сохранил: окно приняло позвавшего (150) за диалог поверх себя');
  assert.strictEqual(created.length, 1, 'позвавший не получил карту');

  // И то же самое для Esc — на чистом окне, без записи.
  reset();
  foreignModal(150);
  openQuickPatientModal({});
  await tick(40);
  escapeKeydown();
  await tick(20);
  assert.strictEqual(dialogs('quick-patient').length, 0,
    'Esc не закрыл окно: позвавшего (150) снова приняли за диалог поверх');
});

test('окно НАД нами глушит окно: Esc не закрывает, Enter не сохраняет', async () => {
  reset();
  foreignModal(160);   // страж дубликатов / отказ доступа — он поверх нас
  const dlg = openQuickPatientModal({});
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  pressEnter(dlg, dlg.state.api.fields.last_name);
  await tick(60);
  assert.strictEqual(insertsInto('patients'), 0,
    'Enter прошёл мимо диалога поверх окна и запустил сохранение заново');

  escapeKeydown();
  await tick(20);
  assert.strictEqual(dialogs('quick-patient').length, 1,
    'Esc закрыл окно вместе с диалогом, стоящим поверх него');
  dlg.close();
});

// ===========================================================================
// 8. ПОЗВАВШИЙ УПАЛ — ОКНО ВСЁ РАВНО УХОДИТ.
//
// onCreated — чужой код: привязка к смете, мастер визита, хвост регистрации
// заявки. Карта на этот момент УЖЕ в базе, и окно своё дело сделало. Если его
// оставить на экране, регистратор видит форму с теми же полями и нажимает
// «Создать пациента» ещё раз — вторая карта на того же человека.
// ===========================================================================
test('сбой позвавшего не оставляет окно открытым', async () => {
  reset();
  const dlg = openQuickPatientModal({ onCreated: () => { throw new Error('позвавший упал'); } });
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(90);

  assert.strictEqual(insertsInto('patients'), 1, 'карта не заведена — проверяется не то');
  assert.strictEqual(dialogs('quick-patient').length, 0,
    'окно осталось на экране: следующее нажатие заведёт вторую карту на того же человека');
  // Молча проглоченный сбой — это «всё хорошо» на экране и потерянный поток на
  // самом деле: пациент заведён, но смета/заявка его не получили.
  assert.ok(toasts.some((t) => /продолжить/i.test(t)),
    'о сбое позвавшего никто не сказал: ' + JSON.stringify(toasts));
});

// ===========================================================================
// 8б. ПОЗВАВШИЙ ПОЧТИ ВСЕГДА АСИНХРОННЫЙ — И ОКНО ЖДЁТ ЕГО ДО КОНЦА.
//
// onCreated карточки CRM возвращает обещание: привязка открытых заявок, правка
// карточки, лист дат. Брошенное обещание не ловится НИКАКИМ try/catch вокруг
// вызова — окно к тому мигу уже снято, отказ уходит в «unhandled rejection», и
// на экране это читается как «нажал „Записать на дату“ — и ничего». Ровно так
// молчала кнопка «Записать на дату»: пациент заведён, лист дат не открылся.
//
// И обратная сторона того же решения: пока позвавший работает, окно стоит на
// экране. Иначе между исчезнувшим окном и открывшимся листом дат — кадр
// пустого экрана, который читается как «всё закрылось, работа потеряна».
// ===========================================================================
test('обещание позвавшего сорвалось — окно уходит и говорит об этом', async () => {
  reset();
  const dlg = openQuickPatientModal({ onCreated: () => Promise.reject(new Error('хвост регистрации упал')) });
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(120);

  assert.strictEqual(insertsInto('patients'), 1, 'карта не заведена — проверяется не то');
  assert.strictEqual(dialogs('quick-patient').length, 0, 'окно осталось на экране после сорванного продолжения');
  assert.ok(toasts.some((t) => /продолжить/i.test(t)),
    'сорванное обещание позвавшего прошло молча: ' + JSON.stringify(toasts));
});

test('позвавший ещё работает — окно стоит на экране и говорит «Сохраняем…»', async () => {
  reset();
  let release;
  const pending = new Promise((r) => { release = r; });
  const dlg = openQuickPatientModal({ onCreated: () => pending });
  await tick(40);

  fillMinimum(dlg);
  calls.length = 0;
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(90);

  assert.strictEqual(insertsInto('patients'), 1, 'карта не заведена — проверяется не то');
  assert.strictEqual(dialogs('quick-patient').length, 1,
    'окно ушло, не дождавшись позвавшего: между ним и следующим окном — кадр пустого экрана');
  assert.strictEqual(dlg.saveBtn.disabled, true, 'кнопка снова доступна — можно завести вторую карту');
  assert.ok(textOf(dlg.saveBtn).includes('Сохраняем'),
    'кнопка молчит о том, что окно занято, и читается как зависшая: ' + textOf(dlg.saveBtn));

  release();
  await tick(90);
  assert.strictEqual(dialogs('quick-patient').length, 0, 'позвавший закончил, а окно осталось');
});

// ===========================================================================
// 8в. ВЫБОР ДУБЛИКАТА НЕ ЗАКРЫВАЕТСЯ, ЕСЛИ ВЫБРАТЬ НЕ ВЫШЛО.
//
// «Открыть существующего» здесь ДОЧИТЫВАЕТ карту (в диалоге она урезана до
// полей сравнения). Чтение может не удаться — и тогда диалог закрывался всё
// равно: человек видел отказ, а под ним пустой экран, ни выбора, ни набранной
// карты, и заводить всё заново.
// ===========================================================================
test('карту дубликата не дочитали — выбор остаётся открытым', async () => {
  reset();
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
                   middle_name: '', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' }];
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => created.push(p) });
  await tick(40);

  fillMinimum(dlg);
  dlg.state.api.fields.phone.value = '+998909610004';
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(60);

  const dup = dialogs('patient-duplicate');
  assert.strictEqual(dup.length, 1, 'страж дубликатов промолчал — проверять нечего');

  // Дочитать карту не удалось: выборка по id отвечает пустотой.
  patientRows = [];
  const openExisting = walk(dup[0]).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'dup-row'));
  assert.ok(openExisting, 'в диалоге нет строки найденного пациента');
  openExisting.click();
  await tick(90);

  assert.strictEqual(dialogs('patient-duplicate').length, 1,
    'выбор закрылся, хотя выбрать не вышло: под отказом остался пустой экран');
  assert.strictEqual(created.length, 0, 'позвавшему отдали карту, которой не смогли прочесть');
  assert.strictEqual(dialogs('quick-patient').length, 1, 'окно заведения снято вместе с несостоявшимся выбором');
  assert.ok(toasts.some((t) => /не удалось открыть карту/i.test(t)),
    'о несостоявшемся чтении никто не сказал: ' + JSON.stringify(toasts));
});

// ===========================================================================
// 8г. ДВА СОВПАДЕНИЯ — ОДИН ИСХОД.
//
// Страж дубликатов гасил ТОЛЬКО нажатую строку, а ответ на нажатие ждёт
// позвавшего до самого конца (хвост регистрации заявки, мастер визита,
// привязка к смете) — и всё это время на экране не меняется ничего.
// Совпадений бывает два: регистратор щёлкает первое, отклика не видит и
// щёлкает второе. Наружу уходили ДВА РАЗНЫХ пациента на одно заведение —
// заявка колл-центра привязывалась к чужой карте, — а окно снималось дважды.
//
// Заслонок здесь две, и обе нужны: окно знает, что исход у него один
// (state.finishing), а диалог гасит ВЕСЬ выбор, пока ответ в пути.
// ===========================================================================
test('два совпадения: второй щелчок не отдаёт позвавшему второго пациента', async () => {
  reset();
  // Оба — «тот же человек» по правилу PATIENT_DUP_RULE_V2 (телефон И имя).
  patientRows = [
    { id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
      middle_name: '', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' },
    { id: 43, mrn: 'P-43', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
      middle_name: 'Бахтиёровна', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' },
  ];
  // Позвавший ещё работает — ровно тот миг, когда на экране «ничего не
  // произошло» и руки тянутся щёлкнуть второе совпадение.
  let release;
  const pending = new Promise((r) => { release = r; });
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => { created.push(p); return pending; } });
  await tick(40);

  fillMinimum(dlg);
  dlg.state.api.fields.phone.value = '+998909610004';
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(60);

  const dup = dialogs('patient-duplicate');
  assert.strictEqual(dup.length, 1, 'страж дубликатов промолчал — проверять нечего');
  const rows = walk(dup[0]).filter((n) => n.tagName === 'BUTTON' && hasClass(n, 'dup-row'));
  assert.strictEqual(rows.length, 2, 'в диалоге не два совпадения, а ' + rows.length + ' — проверяется не то');
  const force = walk(dup[0]).find((n) => n.attrs && n.attrs['data-act'] === 'force-create');
  assert.ok(force, 'в диалоге нет «Создать принудительно»');

  rows[0].click();
  await tick(60);
  assert.strictEqual(created.length, 1, 'первый выбор не дошёл до позвавшего — проверяется не то');
  assert.strictEqual(rows[1].disabled, true,
    'второе совпадение осталось живым, пока ответ по первому в пути');
  assert.strictEqual(force.disabled, true,
    '«Создать принудительно» осталась живой, пока ответ по выбранной строке в пути');

  rows[1].click();
  await tick(80);
  assert.strictEqual(created.length, 1,
    'позвавший получил ДВУХ пациентов на одно заведение: заявка привяжется к чужой карте');

  release();
  await tick(90);
  assert.strictEqual(dialogs('quick-patient').length, 0, 'окно заведения осталось на экране');
  assert.strictEqual(dialogs('patient-duplicate').length, 0, 'выбор дубликата остался на экране');
});

// ===========================================================================
// 8д. «СОЗДАТЬ ПРИНУДИТЕЛЬНО» НЕ ВЫШЛО — ВЫБОР ОСТАЁТСЯ.
//
// То же правило, что и у «Открыть существующего»: runSave на отказе записи
// отдаёт null, и отданный наружу как есть он читался диалогом как «готово».
// Человек видел отказ, а под ним пустой экран — ни выбора, ни набранной карты.
// ===========================================================================
test('запись вопреки дубликату сорвалась — выбор остаётся открытым', async () => {
  reset();
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
                   middle_name: '', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' }];
  const created = [];
  const dlg = openQuickPatientModal({ onCreated: (p) => created.push(p) });
  await tick(40);

  fillMinimum(dlg);
  dlg.state.api.fields.phone.value = '+998909610004';
  btnByText(dlg.card, 'Создать пациента').click();
  await tick(60);

  const dup = dialogs('patient-duplicate');
  assert.strictEqual(dup.length, 1, 'страж дубликатов промолчал — проверять нечего');

  // Запись вопреки совпадению не удалась: сервер отвечает отказом.
  failInsert = 'patients';
  const force = walk(dup[0]).find((n) => n.attrs && n.attrs['data-act'] === 'force-create');
  assert.ok(force, 'в диалоге нет «Создать принудительно»');
  force.click();
  await tick(90);
  failInsert = null;

  assert.strictEqual(created.length, 0, 'позвавшему отдали карту, которую не завели');
  assert.strictEqual(dialogs('patient-duplicate').length, 1,
    'выбор закрылся, хотя записать не вышло: под отказом остался пустой экран');
  assert.strictEqual(dialogs('quick-patient').length, 1,
    'окно заведения снято вместе с несостоявшейся записью — набранное потеряно');
  assert.strictEqual(force.disabled, false,
    'кнопка осталась погашенной: повторить попытку нечем');
});

// ===========================================================================
// 9. ЧТО ОКНО ОТДАЁТ ПОЗВАВШЕМУ. Через state.api позвавший подставляет
// известное (карточка CRM — имя и телефон из заявки). Весь сборщик анкеты
// отдавать нельзя: у него есть save(), который на «Открыть существующего»
// УХОДИТ В КАРТУ пациента — и поток, из которого окно позвали, теряется. Этот
// путь здесь свой намеренно (см. шапку модуля), и вторая дверь к нему
// перечеркнула бы решение.
// ===========================================================================
test('state.api отдаёт только подстановку полей, а не весь сборщик анкеты', async () => {
  reset();
  const dlg = openQuickPatientModal({});
  await tick(40);
  const api = dlg.state.api;

  assert.ok(api.fields && api.fields.last_name, 'позвавшему нечем добраться до полей');
  assert.strictEqual(typeof api.setValue, 'function', 'нет setValue — подставлять значения нечем');

  // Пол сюда не выходит намеренно: подставлять его некому. Заявка колл-центра
  // знает имя, телефон и дату — пола в ней не спрашивают, и setGender стояла
  // без единого вызова, обещая возможность, которой никто не пользуется.
  for (const leaked of ['save', 'collect', 'photo', 'searchStrip', 'state', 'tg', 'setGender']) {
    assert.strictEqual(api[leaked], undefined,
      'через state.api наружу торчит ' + leaked + '() сборщика анкеты');
  }

  // setValue подставляет так же, как набрали бы руками: от даты рождения
  // зависят возраст и тип скидки, а их считает слушатель поля.
  let fired = 0;
  api.fields.date_of_birth.addEventListener('input', () => { fired++; });
  api.setValue('date_of_birth', '1990-04-01', { notify: true });
  assert.strictEqual(api.fields.date_of_birth.value, '1990-04-01', 'setValue не положил значение в поле');
  assert.strictEqual(fired, 1, 'setValue не разбудил слушателя поля — зависимое не пересчитается');
  dlg.close();
});
