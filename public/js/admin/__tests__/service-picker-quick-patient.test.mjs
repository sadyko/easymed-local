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
// 3. Дверь в полную анкету на месте.
// ===========================================================================
test('«Создать пациента» по-прежнему зовёт полную анкету вызывающего', async () => {
  reset();
  let asked = 0;
  const { attach } = await openAttach({ onCreatePatient: () => { asked++; } });

  const btn = btnByText(attach, 'Создать пациента');
  assert.ok(btn, 'в окне привязки пропала дверь в полную анкету');
  btn.click();
  await tick(40);
  assert.strictEqual(asked, 1, 'полную анкету никто не позвал: вызовов onCreatePatient ' + asked);
});

// ===========================================================================
// 4. Мини-формы в каталоге больше нет. Проверяется исходником: живого пути к
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
});
