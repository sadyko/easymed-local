// QUICK_PATIENT_V1 (2026-09-21) — «НОВЫЙ ПАЦИЕНТ» В ПРИВЯЗКЕ КАТАЛОГА.
// docs/plans/2026-09-21-quick-patient-everywhere.md, задача Q2.
//
// ЧТО БЫЛО. Калькулятор услуг набирает смету без пациента, а привязать её к
// человеку предлагает окном поиска. Человека в базе может и не быть — и тогда
// это же окно заводило карту СВОЕЙ мини-формой из пяти полей: фамилия, имя,
// телефон, дата рождения, пол. Пол и дата там были необязательны, паспорта,
// области и типа скидки не было вовсе. Карта, заведённая «по дороге к смете»,
// выходила хуже карты, заведённой в регистратуре, и разницу никто не видел:
// обе выглядели как заведённая карта.
//
// ЧТО СТАЛО. «Новый пациент» открывает ОБЩЕЕ окно быстрой регистрации
// (views/quick-patient-modal.js) — тот же блок реквизитов, что у регистратуры,
// — а созданная карта возвращается в смету привязанной.
//
// Что проверяется здесь — по предложению на решение:
//
//   * КНОПКА ОТКРЫВАЕТ ОБЩЕЕ ОКНО, А НЕ МИНИ-ФОРМУ. Признак общего окна —
//     data-dialog="quick-patient" и поля, которых в мини-форме не было
//     («Тип скидки», «Паспортные данные»).
//   * ЭТАЖ. Окно заведения (155) стоит ПОВЕРХ окна привязки (150). Ошибка
//     здесь читается как «кнопка не работает»: окно открыто, но за тем, кто
//     его позвал.
//   * ЗАВЕДЁННЫЙ ПАЦИЕНТ ПРИВЯЗЫВАЕТСЯ К СМЕТЕ, а окно поиска уходит: ради
//     этого его и заводили. Набранная смета при этом остаётся на месте.
//   * ДВЕРЬ В ПОЛНУЮ АНКЕТУ ОСТАЁТСЯ. «Создать пациента» по-прежнему зовёт
//     onCreatePatient — того, кто умеет показать всю карту.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const srcOf = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

// ---------------------------------------------------------------------------
// Фальшивый DOM — тот же, что в quick-patient-modal.test.mjs: окно заведения
// живёт слушателями document (Escape) и своими подложками в document.body,
// поэтому поддельный документ обязан уметь и то и другое.
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
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){ if(this.parentNode) this.parentNode.removeChild(this); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 closest(sel){const c=String(sel).replace(/^\./,'');let n=this;
   while(n){if(String(n.className||'').split(/\s+/).includes(c))return n;n=n.parentNode;}return null;}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className||'').split(/\s+/).includes(c),add(c){s.className=(s.className?s.className+' ':'')+c;},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
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
  confirm: () => true, prompt: () => null, open: () => null,
  easymedSetTabSub(){}, easymedSetTabLabel(){},
};
globalThis.confirm = () => true;
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };
try { Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: null }, configurable: true }); } catch (e) { /* node уже дал свой navigator */ }

// ---------------------------------------------------------------------------
// «Сервер»: каталог услуг (как в service-picker-attach.test.mjs) плюс
// пациенты (как в quick-patient-modal.test.mjs) — окно заведения работает
// через тот же транспорт, что и всё остальное.
// ---------------------------------------------------------------------------
const TYPES = [{ id: 1, name: 'Консультации', active: 1 }];
const SERVICES = [
  { id: 10, name: 'Приём терапевта', price: 90000, type_id: 1, type: 'consultation', active: 1, duration_minutes: 30, requires_doctor: true, tax_rate: 12 },
];
const USERS = [
  { id: 7, full_name: 'Петров П.П.', specialty: 'Терапевт', is_doctor: true, active: 1, role: 'doctor' },
];
const calls = [];            // { kind: 'rpc'|'insert'|'select', name/table, body }
let patientRows = [];        // чем отвечает выборка по patients (страж дублей)

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body = null; try { body = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = null; }
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload, headers: { getSetCookie: () => [] } });

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
      const row = table === 'patients' ? { id: 501, mrn: 'P-501', ...body.values } : { id: 1, ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    calls.push({ kind: 'select', table, body });
    const rows = table === 'service_types' ? TYPES
      : table === 'services' ? SERVICES
      : table === 'users' ? USERS
      : table === 'patients' ? patientRows
      : table === 'branches' ? [{ id: 1 }]
      : [];
    return ok({ data: body && body.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  // Шлюз медкора: локальной клинике его нет, и каталог живёт без него.
  return { ok: false, status: 404, json: async () => ({ error: { message: 'нет такого' } }), headers: { getSetCookie: () => [] } };
};

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const { openServicePickerModal } = await import('../views/service-picker-modal.js');
const { setFullAccess } = await import('../permissions.js');

// ---------------------------------------------------------------------------
const walk = (e, o = []) => { if (!e || typeof e !== 'object') return o; o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const overlays = () => document.body.children.filter((n) => hasClass(n, 'modal'));
const dialog = (name) => walk(document.body).find((n) => n.attrs && n.attrs['data-dialog'] === name) || null;
const btnByText = (root, s) => walk(root).filter((n) => n.tagName === 'BUTTON')
  .find((b) => textOf(b).replace(/\s+/g, ' ').trim().includes(s));

function reset() {
  calls.length = 0; toasts.length = 0; patientRows = [];
  document.body.children.length = 0;
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  setFullAccess('Admin');
}

/** Калькулятор с одной услугой в смете и открытым окном привязки пациента. */
async function openAttach(opts = {}) {
  const box = (() => {
    openServicePickerModal(Object.assign({
      calculator: true, title: 'Калькулятор услуг', onPick: () => {},
    }, opts));
    return overlays()[overlays().length - 1];
  })();
  await tick(40);

  const add = byClass(box, 'wzc-svc').filter((r) => textOf(r).includes('Приём терапевта'))
    .map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
  assert.ok(add, 'услугу нечем добавить в смету — проверять привязку не с чем');
  add.click();
  await tick(30);

  const attachBtn = byClass(box, 'wzc-attach')[0];
  assert.ok(attachBtn, 'в смете нет «Привязать пациента»');
  attachBtn.click();
  await tick(30);

  const attach = overlays().find((o) => String(o.style.zIndex) === '150');
  assert.ok(attach, 'окно привязки пациента не открылось');
  return { box, attach };
}

/** Заполнить в окне заведения то, без чего карту не создать. */
function fillQuick(card) {
  const byName = (n) => walk(card).find((e) => e.attrs && e.attrs.name === n);
  byName('last_name').value = 'Каримова';
  byName('first_name').value = 'Азиза';
  const dob = byName('date_of_birth');
  dob.value = '1990-04-01';
  const chip = walk(card).find((e) => e.dataset && e.dataset.name === 'gender' && e.dataset.value === 'F');
  assert.ok(chip, 'в окне заведения нет выбора пола — а он обязателен');
  chip.click();
}

const insertsInto = (table) => calls.filter((c) => c.kind === 'insert' && c.table === table).length;

// ===========================================================================
// 1. «Новый пациент» открывает ОБЩЕЕ окно, и оно стоит ПОВЕРХ привязки.
// ===========================================================================
test('«Новый пациент» в привязке открывает окно быстрой регистрации поверх окна поиска', async () => {
  reset();
  const { attach } = await openAttach();

  const btn = btnByText(attach, 'Новый пациент');
  assert.ok(btn, 'в окне привязки нет кнопки «Новый пациент»');
  btn.click();
  await tick(60);

  const card = dialog('quick-patient');
  assert.ok(card, 'открылась не общее окно заведения: data-dialog="quick-patient" в документе нет');
  const qOverlay = overlays().find((o) => walk(o).includes(card));
  assert.ok(qOverlay, 'у окна заведения нет своей подложки');
  assert.ok(Number(qOverlay.style.zIndex) > Number(attach.style.zIndex),
    'окно заведения (' + qOverlay.style.zIndex + ') не выше окна привязки (' + attach.style.zIndex
    + ') — оно откроется ЗА ним, и кнопка прочтётся как неработающая');

  // Признак ОБЩЕГО окна, а не мини-формы: поля, которых в мини-форме не было.
  const txt = textOf(card).replace(/\s+/g, ' ');
  for (const label of ['Клиент', 'Дата рождения', 'Пол', 'Телефон', 'Паспортные данные', 'Тип скидки']) {
    assert.ok(txt.includes(label), 'в окне заведения нет поля «' + label + '»: ' + txt);
  }
});

// ===========================================================================
// 2. Заведённый пациент ПРИВЯЗЫВАЕТСЯ к смете, окно поиска уходит, смета цела.
// ===========================================================================
test('созданный пациент привязывается к смете, окно привязки закрывается, смета цела', async () => {
  reset();
  const { box, attach } = await openAttach();
  btnByText(attach, 'Новый пациент').click();
  await tick(60);

  const card = dialog('quick-patient');
  fillQuick(card);
  calls.length = 0;
  btnByText(card, 'Создать пациента').click();
  await tick(90);

  assert.strictEqual(insertsInto('patients'), 1, 'карта заведена не одной вставкой: ' + insertsInto('patients'));
  const ins = calls.find((c) => c.kind === 'insert' && c.table === 'patients');
  assert.strictEqual(ins.body.gender, 'female', 'пол не доехал до базы — мини-форма его и не спрашивала');
  assert.strictEqual(ins.body.date_of_birth, '1990-04-01', 'дата рождения не доехала до базы');

  assert.strictEqual(dialog('quick-patient'), null, 'окно заведения осталось на экране');
  assert.ok(!document.body.children.includes(attach), 'окно привязки осталось поверх каталога');
  assert.ok(!overlays().some((o) => String(o.style.zIndex) === '150'),
    'подложка окна привязки осталась в документе — она накрывает каталог невидимым стеклом');

  // Пациент виден в смете — именно этого ради его и заводили.
  const rail = byClass(box, 'wzc-pat')[0];
  assert.ok(rail, 'в смете нет привязанного пациента');
  const who = textOf(rail).replace(/\s+/g, ' ');
  assert.ok(who.includes('Каримова'), 'в смете не тот пациент: ' + who);
  assert.ok(who.includes('P-501'), 'у привязанной карты нет номера: ' + who);
  // Набранная смета пережила заведение карты: ради этого окно и открывается
  // поверх каталога, а не вместо него.
  assert.ok(byClass(box, 'wzc-ln').some((r) => textOf(r).includes('Приём терапевта')),
    'услуга из сметы потерялась, пока заводили пациента');
});

// ===========================================================================
// 2б. ДВА НАЖАТИЯ — ОДНО ОКНО.
//
// Окно тянется динамическим импортом, то есть с ожиданием, а кнопка всё это
// время нажимается. Два окна на 155-м этаже друг друга не видят (дочерним
// считается только этаж ВЫШЕ), поэтому второе, пустое, всплывало бы ровно
// после того, как первое сохранило карту, — и следующее нажатие «Создать
// пациента» завело бы вторую карту на того же человека.
// ===========================================================================
test('двойное нажатие «Новый пациент» открывает ОДНО окно, а не два', async () => {
  reset();
  const { attach } = await openAttach();
  const btn = btnByText(attach, 'Новый пациент');
  assert.ok(btn, 'в окне привязки нет кнопки «Новый пациент»');

  btn.click();
  btn.click();   // второе нажатие, пока модуль ещё в пути
  await tick(80);

  const quick = overlays().filter((o) => String(o.style.zIndex) === '155');
  assert.strictEqual(quick.length, 1,
    'окон заведения на экране ' + quick.length + ': второе, пустое, всплывёт после сохранения первого');

  // И пока окно открыто, кнопка под ним новых окон не плодит.
  btn.click();
  await tick(60);
  assert.strictEqual(overlays().filter((o) => String(o.style.zIndex) === '155').length, 1,
    'нажатие при уже открытом окне добавило второе');
});

// ===========================================================================
// 3. Дверь в полную анкету на месте — и она СПРАШИВАЕТ, прежде чем снести
//    каталог.
//
// Эта кнопка сносит каталог целиком и из календаря уводит в Регистратуру:
// набранная смета и выбранный слот уходят вместе с ним. Escape в том же
// каталоге об этом спрашивает («Закрыть мастер записи? Подбор услуг будет
// потерян.»), а кнопка — нет: в режиме калькулятора до этой ветки просто не
// доходили, её сторожил ранний возврат. Теперь путь один, и вопрос обязан
// быть один.
// ===========================================================================
test('«Полная анкета» спрашивает перед уходом: отказ не трогает ни каталог, ни смету', async () => {
  reset();
  let asked = 0, questions = 0;
  const saved = globalThis.confirm;
  globalThis.confirm = (q) => { questions++; return false; };
  try {
    const { box, attach } = await openAttach({ onCreatePatient: () => { asked++; } });
    const btn = btnByText(attach, 'Полная анкета');
    assert.ok(btn, 'в окне привязки пропала дверь в полную анкету');
    btn.click();
    await tick(40);

    assert.strictEqual(questions, 1, 'уход из каталога с набранной сметой не спросил ни о чём');
    assert.strictEqual(asked, 0, 'передумали, а полную анкету всё равно позвали');
    assert.ok(document.body.children.includes(box), 'передумали, а каталог со сметой уже снесён');
    assert.ok(document.body.children.includes(attach), 'передумали, а окно привязки уже закрыто');
  } finally { globalThis.confirm = saved; }
});

test('«Полная анкета» после согласия зовёт анкету вызывающего и снимает каталог', async () => {
  reset();
  let asked = 0;
  const saved = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    const { box, attach } = await openAttach({ onCreatePatient: () => { asked++; } });
    const btn = btnByText(attach, 'Полная анкета');
    assert.ok(btn, 'в окне привязки пропала дверь в полную анкету');
    btn.click();
    await tick(40);

    assert.strictEqual(asked, 1, 'полную анкету никто не позвал: вызовов onCreatePatient ' + asked);
    assert.ok(!document.body.children.includes(attach), 'окно привязки осталось поверх ушедшего каталога');
    assert.ok(!document.body.children.includes(box), 'каталог остался на экране под полной анкетой');
  } finally { globalThis.confirm = saved; }
});

// ===========================================================================
// 4. ESC ПРИНАДЛЕЖИТ ВЕРХНЕМУ ОКНУ.
//
// Каталог услуг слушает Escape на document — и слушает его ВСЕГДА, пока
// открыт. Окно заведения (155) и страж дубликатов (160) слушают тот же
// document и стоят ПОВЕРХ него. Один Escape доходил до обоих: верхнее окно
// закрывалось правильно, а каталог под ним — заодно, вместе с набранной сметой
// и привязанным пациентом. На экране это выглядело как «нажал Esc в окне
// заведения — пропал весь расчёт».
//
// Правило одно на все этажи: чужая подложка .modal выше моей — Escape не мой.
// ===========================================================================
test('Esc в окне заведения не закрывает каталог под ним', async () => {
  reset();
  const { box, attach } = await openAttach();
  btnByText(attach, 'Новый пациент').click();
  await tick(60);
  assert.ok(dialog('quick-patient'), 'окно заведения не открылось — проверять нечего');

  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  await tick(50);

  assert.ok(document.body.children.includes(box),
    'Esc снёс каталог из-под окна заведения — набранная смета пропала');
  assert.strictEqual(dialog('quick-patient'), null,
    'Esc не закрыл само окно заведения — а оно было верхним');
});

test('Esc в окне привязки закрывает окно привязки, а каталог оставляет', async () => {
  reset();
  const { box, attach } = await openAttach();

  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  await tick(50);

  assert.ok(!document.body.children.includes(attach),
    'Esc не закрыл окно привязки — верхним было оно');
  assert.ok(document.body.children.includes(box),
    'Esc снёс каталог вместе с набранной сметой');
});

test('над каталогом никого — Esc по-прежнему закрывает сам каталог', async () => {
  reset();
  openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {} });
  await tick(40);
  const box = overlays()[overlays().length - 1];
  assert.ok(box, 'каталог не открылся');

  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  await tick(50);
  assert.ok(!document.body.children.includes(box),
    'страж верхнего окна превратился в «Esc не закрывает вовсе»');
});

// ===========================================================================
// 5. Мини-формы в каталоге больше нет. Проверяется исходником: живого пути к
// ней может и не остаться, а сам набор полей — остаться и разойтись с общим.
// ===========================================================================
test('своей мини-формы заведения пациента в каталоге не осталось', () => {
  const picker = srcOf('views/service-picker-modal.js');
  assert.ok(!/function openCreatePatientInline/.test(picker),
    'мини-форма заведения пациента осталась в каталоге — снова два набора полей');
  assert.ok(!/Создать и привязать/.test(picker), 'в каталоге осталась кнопка мини-формы');
  assert.ok(!/savePatient\(/.test(picker),
    'каталог всё ещё сохраняет пациента сам — путь заведения обязан быть один');
  assert.ok(/quick-patient-modal\.js\?v=/.test(picker), 'каталог не зовёт окно быстрой регистрации');

  // MODULE_INSTANCE_V1 — окно грузится ТЕМ ЖЕ адресом, что и из карточки CRM.
  // Строка запроса — часть адреса модуля: './x.js?v=a' и './x.js?v=b' это для
  // браузера ДВА разных модуля с двумя копиями состояния.
  const mine = picker.match(/quick-patient-modal\.js\?v=([a-z0-9]+)/i);
  const theirs = srcOf('views/crm.js').match(/quick-patient-modal\.js\?v=([a-z0-9]+)/i);
  assert.ok(theirs, 'карточка CRM не зовёт окно быстрой регистрации');
  assert.strictEqual(mine[1], theirs[1],
    'каталог и CRM грузят ДВЕ копии окна: ?v=' + mine[1] + ' против ?v=' + theirs[1]);
});

// ===========================================================================
// 6. ПРАВИЛО «КТО СТОИТ ПОВЕРХ МЕНЯ» — ОДНО НА ВСЕХ.
//
// Оно было написано дважды и по-разному: каталог услуг читал только встроенный
// style.zIndex, окно заведения — встроенный, а при его отсутствии вычисленный.
// Две копии одного правила расходятся молча: окно, чей этаж задан классом, для
// одного считается нулевым, а для другого — своим, и наружу это выходит как
// «Esc закрыл не то окно».
// ===========================================================================
const { coveredByHigherModal, modalZ, BASE_MODAL_Z } = await import('../views/modal-stack.js');

test('правило «кто поверх меня» живёт в одном месте, а не в двух копиях', () => {
  // Быстрая регистрация держала ТРЕТЬЮ копию — и самую грубую: любая чужая
  // подложка считалась дочерней, даже страничное окно ПОД ней (100), которое
  // заслонить её не может. Esc глох ровно там, где его ждут.
  for (const rel of ['views/service-picker-modal.js', 'views/quick-patient-modal.js', 'views/fast-registration.js']) {
    const src = srcOf(rel);
    assert.ok(/from '\.\/modal-stack\.js/.test(src), rel + ' не зовёт общее правило этажей');
    assert.ok(!/function coveredByHigherModal/.test(src), rel + ' держит свою копию coveredByHigherModal');
    assert.ok(!/function overlayZ/.test(src), rel + ' держит свою копию overlayZ');
    assert.ok(!src.includes(".includes('modal')"),
      rel + ' сам перебирает чужие подложки .modal — это ещё одна копия правила этажей');
  }

  // Окно без встроенного z-index стоит НА ОБЩЕМ ЭТАЖЕ ОКОН (правило .modal в
  // admin.css), а не на нулевом: считать его ниже всех значило бы пускать
  // Escape мимо него.
  assert.strictEqual(BASE_MODAL_Z, 100, 'общий этаж окон разошёлся с правилом .modal в admin.css');
  const bare = document.createElement('div');
  bare.className = 'modal';
  assert.strictEqual(modalZ(bare), BASE_MODAL_Z, 'окно без встроенного этажа посчитано нулевым');
});

test('окно выше — накрывает, окно ниже — нет', () => {
  reset();
  const mineOv = document.createElement('div');
  mineOv.className = 'modal'; mineOv.style.zIndex = '150';
  document.body.appendChild(mineOv);
  assert.strictEqual(coveredByHigherModal(mineOv), false, 'чужих окон нет, а окно считает себя накрытым');

  const below = document.createElement('div');
  below.className = 'modal'; below.style.zIndex = '130';
  document.body.appendChild(below);
  assert.strictEqual(coveredByHigherModal(mineOv), false,
    'позвавшего (130) приняли за окно поверх — Esc и Enter заглохнут ровно там, где их ждут');

  const above = document.createElement('div');
  above.className = 'modal'; above.style.zIndex = '160';
  document.body.appendChild(above);
  assert.strictEqual(coveredByHigherModal(mineOv), true, 'окно поверх (160) не замечено');
});

// ===========================================================================
// 7. У ВЕРХНЕГО ОКНА ДОЛЖЕН БЫТЬ СВОЙ ESCAPE.
//
// Каталог услуг под чужим окном Escape больше не берёт (правило выше). Значит
// диалог, у которого своего обработчика нет, стал окном, которое клавишей не
// закрыть ВОВСЕ — а два диалога шаблонов сметы (170) именно такими и были.
// ===========================================================================

/** Калькулятор с одной услугой в смете — без окна привязки пациента. */
async function openCalc() {
  openServicePickerModal({ calculator: true, title: 'Калькулятор услуг', onPick: () => {} });
  await tick(40);
  const box = overlays()[overlays().length - 1];
  assert.ok(box, 'каталог не открылся');
  const add = byClass(box, 'wzc-svc').filter((r) => textOf(r).includes('Приём терапевта'))
    .map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
  assert.ok(add, 'услугу нечем добавить в смету');
  add.click();
  await tick(30);
  return box;
}

for (const [label, what] of [['Сохранить как шаблон', 'сохранения шаблона'], ['Выбрать шаблон', 'выбора шаблона']]) {
  test('Esc в диалоге «' + label + '» закрывает его, а каталог оставляет', async () => {
    reset();
    const box = await openCalc();
    const btn = btnByText(box, label);
    assert.ok(btn, 'в каталоге нет кнопки «' + label + '»');
    btn.click();
    await tick(40);

    const dlg = overlays().find((o) => String(o.style.zIndex) === '170');
    assert.ok(dlg, 'диалог ' + what + ' не открылся');

    document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await tick(40);

    assert.ok(!document.body.children.includes(dlg),
      'Esc не закрыл диалог ' + what + ' — клавишей его теперь не закрыть вовсе');
    assert.ok(document.body.children.includes(box),
      'Esc снёс каталог из-под диалога ' + what + ' — набранная смета пропала');
  });
}

// ===========================================================================
// 8. КАТАЛОГ УХОДИТ ЦЕЛИКОМ — ВМЕСТЕ СО СВОИМ ESCAPE.
//
// Каталог живёт не только подложкой: он слушает Escape на document. Выходов из
// него восемь, и половина снимала подложку, забыв снять слушателя. Оставшийся
// обработчик держит замкнутое состояние ушедшего окна и отвечает на Escape где
// угодно потом: нажатие в совсем другом экране поднимало вопрос «Закрыть
// мастер записи?», а «Отмена» в нём ничего не чинила — вопрос возвращался на
// каждое следующее нажатие.
// ===========================================================================
test('× снимает мастер записи вместе с его Escape: клавиша потом ни о чём не спрашивает', async () => {
  reset();
  const asked = [];
  const savedConfirm = globalThis.confirm;
  // Здесь проверяется УБОРКА за ушедшим окном, а не вопрос перед уходом: на
  // вопрос крестика (проверка 11) отвечаем «да», чтобы окно действительно
  // ушло, а считаем то, что спросят ПОСЛЕ его ухода.
  globalThis.confirm = (q) => { asked.push(String(q)); return true; };
  try {
    // Мастер записи из пустой дорожки календаря: со слотом и набранной сметой.
    openServicePickerModal({
      calculator: true, title: 'Мастер записи', onPick: () => {},
      scheduledISO: '2026-10-08T10:00:00.000Z',
    });
    await tick(40);
    const box = overlays()[overlays().length - 1];
    assert.ok(box, 'мастер записи не открылся');
    const add = byClass(box, 'wzc-svc').filter((r) => textOf(r).includes('Приём терапевта'))
      .map((r) => byClass(r, 'wzc-add')[0]).find(Boolean);
    assert.ok(add, 'услугу нечем добавить в смету');
    add.click();
    await tick(30);

    const x = byClass(box, 'modal-close')[0];
    assert.ok(x, 'у мастера записи нет крестика');
    x.click();
    await tick(30);
    assert.ok(!document.body.children.includes(box), '× не снял мастер записи с экрана');

    asked.length = 0;   // вопрос крестика задан и отвечен — дальше считаем чужие
    document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await tick(30);

    assert.deepStrictEqual(asked, [],
      'Escape после закрытого мастера поднял вопрос ушедшего окна: ' + JSON.stringify(asked));
    assert.strictEqual((docListeners.keydown || []).length, 0,
      'обработчик Escape пережил своё окно — он отвечает на клавишу в любом другом экране');
  } finally { globalThis.confirm = savedConfirm; }
});

// ===========================================================================
// 9. ВОПРОС ЗАДАЮТ О ТОМ, ЧТО ТЕРЯЕТСЯ.
//
// Выбранный в календаре слот считался работой наравне со сметой, и на пустой
// смете вопрос выходил неправдой: «Подбор услуг будет потерян» — терять нечего,
// а слот выбирается тем же щелчком по той же пустой дорожке. Вопрос, на
// который правильный ответ всегда «да», перестают читать — и перестают читать
// его тогда, когда смета набрана.
// ===========================================================================
test('пустая смета: Esc в мастере записи со слотом закрывает молча', async () => {
  reset();
  const asked = [];
  const savedConfirm = globalThis.confirm;
  globalThis.confirm = (q) => { asked.push(String(q)); return true; };
  try {
    openServicePickerModal({
      calculator: true, title: 'Мастер записи', onPick: () => {},
      scheduledISO: '2026-10-08T10:00:00.000Z',
    });
    await tick(40);
    const box = overlays()[overlays().length - 1];
    assert.ok(box, 'мастер записи не открылся');

    document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    await tick(30);

    assert.deepStrictEqual(asked, [],
      'спросили о потере подбора услуг, которого нет: ' + JSON.stringify(asked));
    assert.ok(!document.body.children.includes(box), 'Esc не закрыл мастер записи');
  } finally { globalThis.confirm = savedConfirm; }
});

// ===========================================================================
// 10. ЩЕЛЧОК МИМО ОКНА СПРАШИВАЕТ ТО ЖЕ САМОЕ.
//
// У подложки стояла СВОЯ копия правила «что теряется при уходе». Две копии
// одного правила расходятся молча: Escape спрашивал бы об одном, щелчок мимо —
// о другом, и работа уходила бы через тот выход, который отстал.
// ===========================================================================
test('щелчок мимо окна спрашивает тем же вопросом, и «Отмена» оставляет смету', async () => {
  reset();
  const asked = [];
  const savedConfirm = globalThis.confirm;
  globalThis.confirm = (q) => { asked.push(String(q)); return false; };
  try {
    const box = await openCalc();
    const backdrop = byClass(box, 'modal-backdrop')[0];
    assert.ok(backdrop, 'у каталога нет подложки');
    backdrop.click();
    await tick(30);

    assert.strictEqual(asked.length, 1, 'щелчок мимо окна с набранной сметой не спросил ни о чём');
    assert.match(asked[0], /Подбор услуг будет потерян/,
      'щелчок мимо спрашивает не тем вопросом, что Escape: ' + asked[0]);
    assert.ok(document.body.children.includes(box), 'передумали, а каталог со сметой уже снесён');

    globalThis.confirm = () => true;
    backdrop.click();
    await tick(30);
    assert.ok(!document.body.children.includes(box), 'согласились, а каталог остался');
    assert.strictEqual((docListeners.keydown || []).length, 0,
      'щелчок мимо снял подложку, но оставил Escape ушедшего окна');
  } finally { globalThis.confirm = savedConfirm; }
});

// ===========================================================================
// 11. КРЕСТИК СПРАШИВАЕТ ТО ЖЕ САМОЕ.
//
// Выходов из каталога много, а правило «что теряется при уходе» одно
// (confirmLeaveCatalog). Escape и щелчок мимо окна спрашивали, а крестик —
// самый заметный и самый частый выход — уносил набранную смету молча. Для
// человека это один и тот же жест «закрыть окно», и разницу между ними он
// узнаёт ровно один раз: когда смета уже пропала.
// ===========================================================================
test('× спрашивает тем же вопросом, и «Отмена» оставляет смету', async () => {
  reset();
  const asked = [];
  const savedConfirm = globalThis.confirm;
  globalThis.confirm = (q) => { asked.push(String(q)); return false; };
  try {
    const box = await openCalc();
    const x = byClass(box, 'modal-close')[0];
    assert.ok(x, 'у каталога нет крестика');
    x.click();
    await tick(30);

    assert.strictEqual(asked.length, 1, '× с набранной сметой не спросил ни о чём');
    assert.match(asked[0], /Подбор услуг будет потерян/,
      '× спрашивает не тем вопросом, что Escape и щелчок мимо: ' + asked[0]);
    assert.ok(document.body.children.includes(box), 'передумали, а каталог со сметой уже снесён');
    assert.strictEqual((docListeners.keydown || []).length, 1,
      'каталог остался на экране, а его Escape уже снят — клавиша перестала его закрывать');

    globalThis.confirm = () => true;
    x.click();
    await tick(30);
    assert.ok(!document.body.children.includes(box), 'согласились, а каталог остался');
    assert.strictEqual((docListeners.keydown || []).length, 0,
      '× снял подложку, но оставил Escape ушедшего окна');
  } finally { globalThis.confirm = savedConfirm; }
});

// ===========================================================================
// 12. ОКНО ЗАВЕДЕНИЯ НЕ ОТКРЫЛОСЬ — КНОПКА ОСТАЁТСЯ РАБОЧЕЙ.
//
// Замок «модуль в пути» снимался ПОСЛЕ открытия окна. Открытие — чужой код, и
// упасть оно может: тогда замок оставался поднятым навсегда, а кнопка —
// погашенной. Наружу это выходит как «„Новый пациент“ перестал работать
// вовсе», и починить это можно было только закрыв весь каталог.
// ===========================================================================
test('сбой при открытии окна заведения не выводит кнопку «Новый пациент» из строя', async () => {
  reset();
  const { attach } = await openAttach();
  const btn = btnByText(attach, 'Новый пациент');
  assert.ok(btn, 'в окне привязки нет кнопки «Новый пациент»');

  // Ломаем окну постановку подложки в документ — ровно тот сбой, после
  // которого замок оставался поднятым.
  const realAppend = document.body.appendChild;
  document.body.appendChild = () => { throw new Error('окно не построилось'); };
  try {
    btn.click();
    await tick(80);
  } finally { document.body.appendChild = realAppend; }

  assert.strictEqual(overlays().filter((o) => String(o.style.zIndex) === '155').length, 0,
    'окно заведения всё-таки встало — проверяется не то');
  assert.notStrictEqual(btn.disabled, true,
    'кнопка осталась погашенной: «Новый пациент» больше не открыть ничем, кроме перезакрытия каталога');

  // И она действительно работает: следующее нажатие открывает окно.
  btn.click();
  await tick(80);
  assert.ok(dialog('quick-patient'),
    'замок «модуль в пути» остался поднятым — кнопка мертва до конца сеанса');
});
