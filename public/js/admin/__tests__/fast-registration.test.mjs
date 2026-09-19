// FAST_REG_ONE_SCREEN_V1 (2026-09-19) — «Быстрая регистрация» ОДНИМ окном.
// docs/plans/2026-09-19-fast-registration-one-screen.md, задача T4.
//
// Что здесь действительно проверяется — по предложению на решение:
//
//   * ОКНО — ЭТО ДВА БЛОКА. Реквизиты пациента (те же три раздела сборщика
//     PATIENT_FIELDS_V1) и таблица услуг с кнопками «+Услуги», «+Пакеты» и
//     «Печать». Второго окна нет ни на одном шаге: именно ради этого задача
//     и затевалась.
//   * ЦЕНА ПОКАЗАНА ДВАЖДЫ И ЧЕСТНО. «С НДС» — цена каталога (в продукте цены
//     включают НДС), «Сумма» — она же без него. Ошибка здесь читалась бы как
//     «клиника обсчитывает».
//   * ПОРЯДОК СОХРАНЕНИЯ. Пациент → визит → строки услуг с врачом → счёт →
//     номера очереди, и ровно в этом порядке: счёт, выставленный раньше
//     строк, был бы счётом ни на что.
//   * ВРАЧ ОБЯЗАТЕЛЕН ТАМ, ГДЕ ОН ОБЯЗАТЕЛЕН. Услуга с requires_doctor без
//     врача не уходит в базу ВООБЩЕ — ни визита, ни карты.
//   * ДУБЛИКАТ НЕ ТЕРЯЕТ РАБОТУ. «Открыть существующего» в этом окне значит
//     «записать услуги на него»: визит уезжает на найденного пациента, а
//     вторая карта не заводится. У формы заведения то же нажатие уводит в
//     карту — здесь это было бы потерей уже набранной таблицы.
//   * ПРАВО. Роль без ключа «Регистрация пациента» видит отказ, а не окно.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const srcOf = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

// ---------------------------------------------------------------------------
// Фальшивый DOM — тот же, что в patient-create-modal.test.mjs / patients-hub.
// Отличие одно: <select> отдаёт .options, потому что searchableSelect
// (обёртка поля «Кто направил») читает их при сборке.
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
  // SEARCHABLE_SELECT_V1 читает sel.options при сборке обёртки.
  if (el.tagName === 'SELECT') {
    Object.defineProperty(el, 'options', { get() { return el.children.filter((c) => c.tagName === 'OPTION'); } });
  }
  return el;
}
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const toastEl = mk('div');
// Слушатели документа — НАСТОЯЩИЕ (записывающие), а не заглушки: Escape должен
// дойти и до окна, и до дочернего диалога — ровно как в браузере, где оба
// висят на одном document. Заглушённый addEventListener сделал бы проверку
// «Esc под дочерним диалогом» невозможной (та же техника, что в
// __tests__/template-picker-modal.test.mjs).
const docListeners = {};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),
  head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(type, fn){ (docListeners[type] || (docListeners[type] = [])).push(fn); },
  removeEventListener(type, fn){ const a = docListeners[type]; if (!a) return; const i = a.indexOf(fn); if (i > -1) a.splice(i, 1); },
  dispatchEvent(e){ for (const fn of (docListeners[e.type] || []).slice()) fn(e); return true; },
  getElementById:(id)=> (id === 'toast' ? toastEl : null),
  querySelector(){return null;},querySelectorAll(){return [];}};
const toasts = [];
// ВАЖНОСТЬ тоста записывается рядом с текстом и по тому же номеру: «тариф не
// спрошен» обязано быть предупреждением, а не рядовым сообщением, которое
// прочитают краем глаза (ui.js: textContent, затем dataset.kind).
const toastKinds = [];
Object.defineProperty(toastEl, 'textContent', { get(){ return toastEl._t; }, set(v){ toastEl._t = String(v); toasts.push(String(v)); toastKinds.push('info'); } });
toastEl.dataset = {
  get kind(){ return toastKinds[toastKinds.length - 1]; },
  set kind(v){ if (toastKinds.length) toastKinds[toastKinds.length - 1] = String(v); },
};
const kindOf = (needle) => toastKinds[toasts.findIndex((t) => t.includes(needle))];

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
// Фальшивый транспорт. Записываем ВСЁ: имя и тело каждого rpc и каждую вставку
// в /api/db — порядок вызовов и есть предмет проверки.
// ---------------------------------------------------------------------------
const calls = [];            // { kind: 'rpc'|'insert'|'select', name/table, body }
let patientRows = [];        // чем отвечает выборка по patients (страж дублей)
// { table, message, nth? } — отказ вставки. nth — номер вставки В ЭТУ таблицу
// (1 — первая): цепочка вставляет строки услуг по одной, и «упала ВТОРАЯ» —
// это отдельный случай, где часть строк уже лежит в базе.
let insertFail = null;
// Отказы двух НЕобязательных шагов цепочки: тариф визита и номера очереди.
// Регистрацию они не срывают, и именно поэтому о них надо сказать вслух.
let quoteFail = null;        // текст отказа service_price_quote
let queueFail = null;        // текст отказа issue_queue_numbers
// Деньги: чем отвечают тариф и счёт. По умолчанию — цена каталога и сумма,
// которую видит окно; проверки «цена после сохранения» ставят сюда своё,
// потому что расхождение каталога и счёта и есть их предмет.
let quotes = null;           // { [serviceId]: { price, tier } } | null — цена каталога
let invoiceTotal = 152000;   // total_amount ответа create_invoice_for_visit
let queueTickets = null;     // (ids) => [ticket] | null — талоны по умолчанию
// Задержка одного rpc: { name, promise } — цепочка встаёт на нём, и в этот миг
// проверяется поведение окна «пока идёт запись».
let holdRpc = null;
// Печать открывает окно и пишет в него документ: ловим написанное (та же
// техника, что в case-file-tabs.test.mjs).
let printed = [];
globalThis.window.open = () => ({
  document: { open() {}, write(html) { printed.push(String(html)); }, close() {} },
  focus() {}, print() {},
});

const SERVICES = [
  { id: 1, name: 'Приём терапевта', price: 112000, tax_rate: 12, requires_doctor: 1, type: 'consultation', active: 1 },
  { id: 2, name: 'Общий анализ крови', price: 40000, tax_rate: 0, requires_doctor: 0, type: 'lab', active: 1 },
];
const DOCTORS = [
  { id: 7, full_name: 'Петров Пётр', service_rates: JSON.stringify([{ service_id: 1, pct: 40 }]) },
  { id: 8, full_name: 'Сидорова Анна', service_rates: null },
];
const SOURCES = [{ id: 5, name: 'Сайт клиники', code: '0007', category_id: null, doctor_id: null, active: 1 }];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });

  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    calls.push({ kind: 'rpc', name, body });
    if (holdRpc && holdRpc.name === name) await holdRpc.promise;
    if (name === 'ensure_visit') return ok({ data: { visit: { id: 77 }, created: true } });
    if (name === 'service_price_quote') {
      if (quoteFail) return { ok: false, status: 400, json: async () => ({ error: { message: quoteFail } }) };
      return ok({ data: { quotes: quotes || { 1: { price: 112000, tier: 'primary' }, 2: { price: 40000, tier: 'primary' } } } });
    }
    if (name === 'create_invoice_for_visit') {
      return ok({ data: { invoice: { id: 9, invoice_number: 'INV-9', total_amount: invoiceTotal }, items: [] } });
    }
    if (name === 'issue_queue_numbers') {
      if (queueFail) return { ok: false, status: 400, json: async () => ({ error: { message: queueFail } }) };
      const ids = (body && body.p_ids) || [];
      if (queueTickets) return ok({ data: queueTickets(ids) });
      return ok({ data: ids.map((id, i) => ({ visit_service_id: id, label: 'A-' + (i + 1), number: i + 1, queue_key: 'k' })) });
    }
    return ok({ data: null });
  }

  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      calls.push({ kind: 'insert', table, body: body.values });
      const nth = calls.filter((c) => c.kind === 'insert' && c.table === table).length;
      if (insertFail && insertFail.table === table && (!insertFail.nth || insertFail.nth === nth)) {
        return { ok: false, status: 409, json: async () => ({ error: { message: insertFail.message } }) };
      }
      let row;
      if (table === 'patients') row = { id: 501, mrn: 'P-501', ...body.values };
      else if (table === 'visit_services') row = { id: 900 + calls.filter((c) => c.table === 'visit_services').length, ...body.values };
      else row = { id: 1, ...body.values };
      return ok({ data: body.single ? row : [row] });
    }
    calls.push({ kind: 'select', table, body });
    const rows = table === 'patients' ? patientRows
      : table === 'services' ? SERVICES
      : table === 'users' ? DOCTORS
      : table === 'referral_sources' ? SOURCES
      : table === 'branches' ? [{ id: 1 }]
      : table === 'service_templates' ? [{ id: 3, name: 'Первичный приём', service_ids: [1, 2] }]
      : [];
    return ok({ data: body && body.single ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const { openFastRegistrationDialog } = await import('../views/fast-registration.js');
const { setFullAccess, setEffectiveFromRole, canCreatePatient, isRouteAllowed } = await import('../permissions.js');

// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const dialogs = (name) => walk(document.body).filter((n) => n.attrs['data-dialog'] === name);
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const btnByText = (root, text) => buttons(root).find((b) => textOf(b).replace(/\s+/g, ' ').trim().includes(text));

function reset() {
  calls.length = 0; toasts.length = 0; toastKinds.length = 0; printed.length = 0;
  patientRows = []; insertFail = null; quoteFail = null; queueFail = null; focused = null;
  quotes = null; invoiceTotal = 152000; queueTickets = null; holdRpc = null;
  document.body.children.length = 0;
  // Окна прошлой проверки с экрана сняты — их слушатели Escape тоже.
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  setFullAccess('Admin');
}

const escapeKeydown = () => document.dispatchEvent({ type: 'keydown', key: 'Escape' });

// Нажатие Enter приходит НА КАРТОЧКУ окна (обработчик висит там), а `target` —
// поле, в котором стоял курсор: фальшивый DOM события не всплывает, поэтому
// цель задаём явно, как её увидел бы браузер (та же техника, что в
// __tests__/patient-create-modal.test.mjs).
function pressEnter(dlg, target) {
  dlg.card.dispatchEvent({
    type: 'keydown', key: 'Enter', target,
    preventDefault() {}, stopPropagation() {},
  });
}

function fillMinimum(dlg) {
  dlg.fields.last_name.value = 'Каримова';
  dlg.fields.first_name.value = 'Азиза';
  dlg.fields.date_of_birth.value = '1990-04-01';
  dlg.setGender('F');
}

const rowsOf = (dlg) => walk(dlg.table).filter((n) => n.tagName === 'TR' && walk(n).some((c) => c.tagName === 'TD'));
const cellsOf = (tr) => (tr.children || []).filter((c) => c.tagName === 'TD');

// ===========================================================================
test('окно рисует ОДИН раздел реквизитов по образцу и пустую таблицу услуг с кнопками', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  assert.ok(dlg, 'окно не открылось');
  await tick(40);

  assert.strictEqual(dialogs('fast-registration').length, 1, 'окна быстрой регистрации нет в документе');
  const txt = textOf(dlg.card).replace(/\s+/g, ' ');
  assert.ok(txt.includes('Быстрая регистрация'), 'нет заголовка окна');
  assert.ok(txt.includes('Пациент → услуги и врач → счёт → печать'), 'нет строки пути');

  // FAST_REG_COMPACT_V1 — владелец: в быстром окне только необходимое, как на
  // образце. Реквизиты пациента — ОДИН раздел компактной раскладки сборщика,
  // и «Код отправителя» стоит В НЁМ: отдельный блок «Направление и скидка»
  // был четвёртым разделом там, где разделов теперь один.
  const titles = walk(dlg.body).filter((n) => n.tagName === 'H3')
    .map((n) => textOf(n).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').trim())
    .map((t) => t.replace(/^[1234]\s*/, ''));
  for (const want of ['Реквизиты пациента', 'Услуги']) {
    assert.ok(titles.some((t) => t.includes(want)), 'нет блока «' + want + '»: ' + titles.join(' | '));
  }
  for (const gone of ['Личные данные', 'Документы и резидентство', 'Контакты и адрес', 'Направление и скидка', 'Здоровье']) {
    assert.ok(!titles.some((t) => t.includes(gone)), 'в быстром окне остался раздел «' + gone + '»: ' + titles.join(' | '));
  }
  const sections = walk(dlg.body).filter((n) => hasClass(n, 'mg-section') && !hasClass(n, 'mg-search'));
  const reqs = sections.filter((n) => walk(n).some((c) => c.tagName === 'H3'
    && textOf(c).replace(/<svg[\s\S]*?<\/svg>/g, '').includes('Реквизиты пациента')));
  assert.strictEqual(reqs.length, 1, 'разделов реквизитов не один: ' + reqs.length);

  // Поля раздела — ровно образец владельца, и «Код отправителя» с «Типом
  // скидки» среди них.
  const labels = walk(reqs[0]).filter((n) => n.tagName === 'LABEL')
    .map((n) => textOf(n).replace(/\s+/g, ' ').trim());
  assert.deepStrictEqual(labels, [
    'Фамилия *', 'Имя *', 'Отчество',
    'Дата рождения *', 'Пол *', 'Телефон',
    'Паспортные данные', 'Резидентство', 'Область',
    'Адрес', 'Тип скидки',
    'Код отправителя (лечащий врач)',
  ], 'поля быстрой регистрации: ' + labels.join(' | '));
  for (const gone of ['Email', 'Махалля', 'ПИНФЛ (ЖШШИР)', 'Район', 'Страна', 'Предпочитаемый язык']) {
    assert.ok(!labels.includes(gone), 'в быстром окне осталось поле «' + gone + '»');
  }

  // Кнопки таблицы услуг.
  assert.ok(btnByText(dlg.card, '+Услуги'), 'нет кнопки «+Услуги»');
  assert.ok(btnByText(dlg.card, '+Пакеты'), 'нет кнопки «+Пакеты»');
  const print = btnByText(dlg.card, 'Печать');
  assert.ok(print, 'нет кнопки «Печать»');
  assert.ok(print.hasAttribute('disabled') || print.disabled, 'до сохранения «Печать» должна быть выключена');
  assert.ok(btnByText(dlg.card, 'Сохранить'), 'нет кнопки «Сохранить»');

  // Пустое состояние подсказывает, чем наполнять таблицу.
  assert.ok(textOf(dlg.table).includes('Добавьте услуги'), 'нет подсказки пустой таблицы');

  // Поле направления заполнено из справочника, подпись — «код · имя».
  assert.ok(textOf(dlg.referralSel).includes('0007 · Сайт клиники'), 'источник направления не подписан кодом');
  dlg.close();
});

test('+Услуги добавляет строку с ценой без НДС и с НДС, +Пакеты — все услуги пакета', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  // Каталог открывается отдельным окном; здесь проверяется то, что оно зовёт.
  dlg.state.addLine(SERVICES[0], null);
  let rows = rowsOf(dlg).filter((r) => cellsOf(r).length === 6 && textOf(r).includes('Приём терапевта'));
  assert.strictEqual(rows.length, 1, 'строка услуги не добавилась');
  const cells = cellsOf(rows[0]).map((c) => textOf(c).replace(/\s+/g, ' ').trim());
  assert.strictEqual(cells[1], 'Приём терапевта');
  assert.ok(cells[2].includes('100 000'), 'столбец «Сумма» не равен цене без НДС: ' + cells[2]);
  assert.ok(cells[3].includes('112 000'), 'столбец «С НДС» не равен цене каталога: ' + cells[3]);

  // Врач — выбор из пула услуги (у врача 7 есть ставка по этой услуге).
  const sel = walk(rows[0]).find((n) => n.tagName === 'SELECT');
  assert.ok(sel, 'в строке нет выбора врача');
  const opts = sel.children.filter((o) => o.tagName === 'OPTION').map((o) => textOf(o));
  assert.ok(opts.some((o) => o.includes('Петров')), 'врача услуги нет в списке: ' + opts.join(' | '));

  // Пакет разворачивается в услуги каталога.
  dlg.state.applyTemplate({ id: 3, name: 'Первичный приём', service_ids: [1, 2] });
  rows = rowsOf(dlg).filter((r) => cellsOf(r).length === 6 && !textOf(r).includes('Итого'));
  assert.strictEqual(rows.length, 3, 'после пакета строк не три: ' + rows.length);

  // «Итого» — сумма цен С НДС.
  assert.ok(textOf(dlg.table).includes('264 000'), 'итог не равен сумме цен с НДС');
  dlg.close();
});

test('сохранение: пациент → визит → строки с врачом → счёт → очередь, окно переходит в сохранённое состояние', async () => {
  reset();
  let savedWith = 0;
  const dlg = openFastRegistrationDialog({ onSaved: () => { savedWith++; } });
  await tick(40);

  fillMinimum(dlg);
  dlg.referralSel.value = '5';
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  calls.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);

  const chain = calls.filter((c) => c.kind !== 'select')
    .map((c) => (c.kind === 'rpc' ? 'rpc:' + c.name : 'insert:' + c.table));
  assert.deepStrictEqual(chain, [
    'insert:patients',
    'rpc:ensure_visit',
    'rpc:service_price_quote',
    'insert:visit_services',
    'rpc:create_invoice_for_visit',
    'rpc:issue_queue_numbers',
  ], 'порядок цепочки сохранения: ' + chain.join(' → '));

  const visit = calls.find((c) => c.kind === 'rpc' && c.name === 'ensure_visit');
  assert.strictEqual(visit.body.patient_id, 501, 'визит заведён не на созданного пациента');
  assert.strictEqual(Number(visit.body.referral_source_id), 5, 'направление не доехало до визита');
  const line = calls.find((c) => c.kind === 'insert' && c.table === 'visit_services');
  assert.strictEqual(line.body.doctor_id, 7, 'врач не записан в строку услуги');
  assert.strictEqual(line.body.visit_id, 77);

  // Сохранённое состояние: номер карты и номер счёта в шапке, печать доступна.
  const head = textOf(dlg.card).replace(/\s+/g, ' ');
  assert.ok(head.includes('P-501'), 'в шапке нет номера карты: ' + head.slice(0, 200));
  assert.ok(head.includes('INV-9'), 'в шапке нет номера счёта');
  const print = btnByText(dlg.card, 'Печать');
  assert.ok(!print.disabled && !print.hasAttribute('disabled'), 'после сохранения «Печать» осталась выключенной');
  assert.strictEqual(savedWith, 1, 'onSaved вызван не один раз: ' + savedWith);

  // «Сохранить» больше нажать НЕЛЬЗЯ — ни мышью, ни Enter'ом. registerWalkIn не
  // идемпотентна: второе нажатие дописало бы те же услуги в тот же визит дня и
  // выставило бы ВТОРОЙ счёт на них, а разбирались бы с этим уже в кассе.
  // Поэтому кнопка и спрятана, и выключена: спрятанная, но живая кнопка всё
  // ещё срабатывает по Enter.
  assert.strictEqual(dlg.saveBtn.style.display, 'none', 'после сохранения «Сохранить» осталась на виду');
  assert.ok(dlg.saveBtn.disabled, 'после сохранения «Сохранить» можно нажать ещё раз');
  // Номер очереди виден в таблице.
  assert.ok(textOf(dlg.table).includes('A-1'), 'номер очереди не показан');

  // SEARCHABLE_SELECT_V1 — у поля направления ДВА лица: скрытый <select>
  // (источник правды) и видимая строка поиска поверх него. Выключенный
  // select при живой строке — это поле, которое по-прежнему открывается,
  // ищет и выбирает, ничего уже не меняя: выбор уехал бы в никуда.
  const refInput = (dlg.referralSel.parentNode.children || []).find((c) => c.tagName === 'INPUT');
  assert.ok(refInput, 'у поля направления нет строки поиска');
  assert.ok(refInput.disabled, 'после сохранения строка поиска направления осталась живой');
  dlg.close();
});

test('услуга требует врача, врач не выбран — сохранение не идёт', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);   // requires_doctor, врача нет

  calls.length = 0; toasts.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(60);

  assert.strictEqual(calls.filter((c) => c.kind === 'rpc').length, 0, 'ушли вызовы RPC при пустом враче');
  assert.strictEqual(calls.filter((c) => c.kind === 'insert').length, 0, 'завели карту при пустом враче');
  assert.ok(toasts.some((t) => t.includes('врача')), 'регистратору не сказали, чего не хватает: ' + toasts.join(' | '));
  assert.strictEqual(focused, row.sel, 'курсор не встал в тот самый выбор врача');
  dlg.close();
});

test('дубликат: «использовать существующего» регистрирует визит на найденного пациента', async () => {
  reset();
  // Страж дублей ищет по patients: телефон И имя — тот же человек
  // (PATIENT_DUP_RULE_V2). ПИНФЛ здесь больше не спрашивают: быстрое окно
  // показывает только реквизиты образца (FAST_REG_COMPACT_V1), и признаком
  // дубля работает то, что в нём есть.
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
                   middle_name: '', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  fillMinimum(dlg);
  dlg.fields.phone.value = '+998909610004';
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  calls.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(60);

  const dup = dialogs('patient-duplicate');
  assert.strictEqual(dup.length, 1, 'диалог дубликата не открылся');
  assert.strictEqual(calls.filter((c) => c.kind === 'insert').length, 0, 'карту завели, не спросив');

  // «Открыть существующего» — это строка найденного пациента.
  const openExisting = walk(dup[0]).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'dup-row'));
  assert.ok(openExisting, 'в диалоге нет строки найденного пациента');
  openExisting.click();
  await tick(80);

  const visit = calls.find((c) => c.kind === 'rpc' && c.name === 'ensure_visit');
  assert.ok(visit, 'визит не заведён после выбора существующего');
  assert.strictEqual(visit.body.patient_id, 42, 'визит уехал не на найденного пациента');
  assert.strictEqual(calls.filter((c) => c.kind === 'insert' && c.table === 'patients').length, 0,
    'завели вторую карту на того же человека');
  dlg.close();
});

// ===========================================================================
// Escape под дочерним диалогом.
//
// Окно открывает поверх себя ещё три: выбор пакета, каталог услуг и стража
// дубликатов. Escape слушают все на одном document, поэтому нажатие достаётся
// обоим — и без проверки «стоит ли кто-то поверх» Esc, закрывающий выбор
// пакета, сносил бы вместе с ним и окно регистрации: заполненные поля, набранную
// таблицу услуг и выбранных врачей. Набирать всё это заново — как раз то, ради
// чего окно и сделали одним.
// ===========================================================================
test('Esc под дочерним диалогом закрывает ЕГО, а окно регистрации остаётся', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  dlg.state.addLine(SERVICES[1], null);   // услуга в таблице — её терять нельзя

  btnByText(dlg.card, '+Пакеты').click();
  await tick(40);
  assert.strictEqual(dialogs('template-picker').length, 1, 'выбор пакета не открылся');

  escapeKeydown();
  assert.strictEqual(dialogs('template-picker').length, 0, 'Esc не закрыл выбор пакета');
  assert.strictEqual(dialogs('fast-registration').length, 1,
    'Esc закрыл окно регистрации заодно с дочерним диалогом');
  assert.strictEqual(dlg.state.rows.length, 1, 'набранные услуги потерялись');
  assert.strictEqual(dlg.fields.last_name.value, 'Каримова', 'заполненные поля потерялись');

  // А когда поверх никого нет, Esc по-прежнему закрывает само окно — проверка
  // не должна была превратиться в «Esc не работает вовсе».
  escapeKeydown();
  await tick(20);
  assert.strictEqual(dialogs('fast-registration').length, 0, 'Esc перестал закрывать окно');
});

// ===========================================================================
// Enter под дочерним диалогом — ТА ЖЕ ПРИЧИНА, ЧТО У Escape.
//
// Enter в этом окне нажимает главное действие подвала, то есть «Сохранить». Но
// пока поверх стоит страж дубликатов, вопрос ещё не решён: это тот самый миг,
// когда регистратор смотрит, не заводит ли он второго такого же человека.
// Нажатие в этот момент запускает сохранение ЗАНОВО — второй проход по той же
// цепочке и второй диалог дубликата поверх первого. Поля окна при этом живые:
// щелчок мимо диалога возвращает курсор в форму, и Enter из неё доходит до
// обработчика карточки ровно так же, как при закрытом диалоге.
// ===========================================================================
test('Enter под дочерним диалогом не запускает сохранение заново', async () => {
  reset();
  // Страж дублей найдёт совпадение по телефону и имени и откроет свой диалог —
  // настоящий, а не подставленный: проверяется поведение под ним.
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
                   middle_name: '', phone: '+998 90 961 00 04', date_of_birth: '1990-04-01' }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  fillMinimum(dlg);
  dlg.fields.phone.value = '+998909610004';
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  btnByText(dlg.card, 'Сохранить').click();
  await tick(60);
  assert.strictEqual(dialogs('patient-duplicate').length, 1, 'диалог дубликата не открылся — проверяется не то');

  calls.length = 0;
  pressEnter(dlg, dlg.fields.last_name);
  await tick(60);

  assert.strictEqual(dialogs('patient-duplicate').length, 1, 'Enter открыл второй диалог дубликата поверх первого');
  assert.strictEqual(calls.filter((c) => c.kind === 'rpc').length, 0, 'Enter под диалогом отправил RPC');
  assert.strictEqual(calls.filter((c) => c.kind === 'insert').length, 0, 'Enter под диалогом завёл карту, не спросив');

  // А когда поверх никого нет, Enter по-прежнему сохраняет — проверка не должна
  // была превратиться в «Enter не работает вовсе».
  const dup = dialogs('patient-duplicate')[0];
  const openExisting = walk(dup).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'dup-row'));
  openExisting.click();
  await tick(80);
  assert.ok(calls.some((c) => c.kind === 'rpc' && c.name === 'ensure_visit'), 'выбор существующего не довёл до визита');
  dlg.close();
});

test('Enter в обычном поле, когда поверх никого нет, сохраняет', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  calls.length = 0;
  pressEnter(dlg, dlg.fields.last_name);
  await tick(80);

  assert.strictEqual(calls.filter((c) => c.kind === 'insert' && c.table === 'patients').length, 1,
    'Enter не сохранил пациента');
  assert.ok(dlg.state.result, 'Enter не довёл цепочку до счёта');
  dlg.close();
});

// ===========================================================================
// WALK_IN_ROLE_GATE_V1 — РОЛЬ БЕЗ ПРАВА УЗНАЁТ ОБ ЭТОМ ДО ЗАВЕДЕНИЯ КАРТЫ.
//
// Право «Регистрация пациента» и РОЛЬ — разные вещи: право открывает окно,
// роль решает, дойдёт ли цепочка до счёта (create_invoice_for_visit пускает
// admin/registrar/cashier, вставка в patients — admin/registrar/callcenter).
// Кассир или оператор колл-центра с этим правом завёл бы карту и визит и
// получил отказ на счёте — то самое «визит без счёта», ради ухода от которого
// окно и делали одним. Поэтому отказ стоит ПЕРЕД первой записью.
// ===========================================================================
test('роль без права на визит и счёт: отказ ДО заведения карты, ни одной записи', async () => {
  reset();
  const was = globalThis.window.easymed.state.user;
  globalThis.window.easymed.state.user = { id: 4, full_name: 'Медсестра', role: 'nurse' };
  try {
    const dlg = openFastRegistrationDialog({});
    await tick(40);
    fillMinimum(dlg);
    const row = dlg.state.addLine(SERVICES[0], null);
    row.sel.value = '7';
    row.sel.fireChange();

    calls.length = 0; toasts.length = 0;
    btnByText(dlg.card, 'Сохранить').click();
    await tick(80);

    assert.strictEqual(calls.filter((c) => c.kind === 'insert').length, 0, 'карту завели роли без права');
    assert.strictEqual(calls.filter((c) => c.kind === 'rpc').length, 0, 'визит завели роли без права');
    assert.ok(toasts.some((t) => t.includes('регистратор или администратор')),
      'отказ промолчал — это читается как поломка кнопки: ' + toasts.join(' | '));
    assert.ok(!dlg.state.result, 'окно считает регистрацию состоявшейся');
    dlg.close();
  } finally {
    globalThis.window.easymed.state.user = was;
  }
});

// ===========================================================================
// Тариф не спрошен / очередь не выдана — ГРОМКО.
//
// Оба шага необязательные: регистрацию они не срывают (walk-in-booking.js
// возвращает quoteError/queueError и идёт дальше). Но счёт при провале тарифа
// выставлен по цене каталога и слову «первичный приём» — то есть возможной
// переплатой пациента, а без номера очереди его никто никуда не позовёт.
// Молчаливый ответ здесь читается как «всё прошло», и разбираются с этим уже
// в кассе.
// ===========================================================================
test('тариф не спрошен и очередь не выдана — регистратор видит предупреждения, а не тишину', async () => {
  reset();
  quoteFail = 'нет доступа к ценам';
  queueFail = 'очередь недоступна';
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  toasts.length = 0; toastKinds.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);

  assert.ok(toasts.some((t) => t.includes('Тариф визита не спрошен') && t.includes('нет доступа к ценам')),
    'о неспрошенном тарифе не сказали: ' + toasts.join(' | '));
  assert.strictEqual(kindOf('Тариф визита не спрошен'), 'warn',
    'о неспрошенном тарифе сказали рядовым сообщением');
  assert.ok(toasts.some((t) => t.includes('Номера очереди не выданы') && t.includes('очередь недоступна')),
    'о невыданной очереди не сказали: ' + toasts.join(' | '));
  assert.strictEqual(kindOf('Номера очереди не выданы'), 'warn',
    'о невыданной очереди сказали рядовым сообщением');

  // И при этом регистрация ДОВЕДЕНА: счёт есть, окно в сохранённом состоянии.
  assert.ok(dlg.state.result && dlg.state.result.invoice, 'предупреждение сорвало саму регистрацию');
  dlg.close();
});

// ===========================================================================
// ЭТАЖИ ОКОН. Окно регистрации открывает поверх себя каталог услуг, и оба —
// подложки .modal на всё окно браузера, соседи в document.body. Кто выше,
// решает только z-index: окно с бо́льшим числом накрывает каталог, и нажатие
// «+Услуги» выглядит как «кнопка не работает» — каталог открыт, но за окном.
//
// Числа продукта: страницы-модалки 100, каталог услуг 130, дубликат и
// предпросмотр печати 160, выбор пакета 180. Окно регистрации обязано быть
// выше страницы и НИЖЕ всех своих детей — то есть 120.
// ===========================================================================
test('окно стоит ниже каталога услуг: подложка 120 против 130 у каталога (иначе «+Услуги» открывается ЗА окном)', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  assert.strictEqual(dlg.overlay.style.zIndex, '120', 'подложка окна не на своём этаже');
  // Второе число — не выдумка проверки, а то, что стоит в каталоге сегодня.
  const picker = srcOf('views/service-picker-modal.js');
  const m = picker.match(/const overlay = h\('div', \{ class: 'modal', style: \{ zIndex: '(\d+)' \} \}\)/);
  assert.ok(m, 'в каталоге услуг больше нет подложки с z-index — проверку надо пересобрать');
  assert.ok(Number(m[1]) > Number(dlg.overlay.style.zIndex),
    'каталог услуг (' + m[1] + ') не выше окна регистрации (' + dlg.overlay.style.zIndex + ')');
  dlg.close();
});

// MODULE_INSTANCE_V1 — каталог грузится ТЕМ ЖЕ адресом, что и у всех.
// Строка запроса — часть адреса модуля: './x.js?v=a' и './x.js?v=b' это для
// браузера ДВА разных модуля с двумя копиями состояния. У каталога состояние
// есть (забронированные слоты, forgetSlots), и вторая копия теряет его молча.
test('каталог услуг импортируется той же строкой запроса, что и у остальных экранов (один модуль, одно состояние)', () => {
  const mine = srcOf('views/fast-registration.js').match(/service-picker-modal\.js\?v=([a-z0-9]+)/i);
  const theirs = srcOf('views/patients.js').match(/service-picker-modal\.js\?v=([a-z0-9]+)/i);
  assert.ok(mine && theirs, 'импорт каталога не найден');
  assert.strictEqual(mine[1], theirs[1],
    'быстрая регистрация грузит вторую копию каталога: ?v=' + mine[1] + ' против ?v=' + theirs[1]);
});

// И по той же причине — сборщик полей пациента. У него состояние есть тоже
// (PATIENT_PHOTO_V1: снимок с веб-камеры ждёт сохранения в модуле, а не в
// окне), и вторая копия модуля означала бы второй такой набор. Ровно этим
// адресом его грузят картотека и регистрация — значит и это окно.
test('сборщик полей пациента импортируется той же строкой запроса, что и остальные экраны (один модуль)', () => {
  const mine = srcOf('views/fast-registration.js').match(/patient-create-modal\.js\?v=([a-z0-9]+)/i);
  const theirs = srcOf('views/patients.js').match(/patient-create-modal\.js\?v=([a-z0-9]+)/i);
  assert.ok(mine && theirs, 'импорт сборщика полей пациента не найден');
  assert.strictEqual(mine[1], theirs[1],
    'быстрая регистрация грузит вторую копию сборщика: ?v=' + mine[1] + ' против ?v=' + theirs[1]);
});

// ===========================================================================
// ДЕНЬГИ ПОСЛЕ СОХРАНЕНИЯ — ТЕ, ЧТО В СЧЁТЕ.
//
// До нажатия таблица показывает каталог: другой цены ещё нет. После нажатия
// цена известна точно — тариф визита вернул её построчно, а сервер применил
// процент категории пациента и вернул итог счёта. Если таблица продолжает
// показывать каталог, регистратор называет пациенту одну сумму, а касса берёт
// другую — и разбираются они между собой, без экрана.
// ===========================================================================
test('после сохранения таблица и печать показывают цену СЧЁТА, а не каталога, и называют скидку', async () => {
  reset();
  quotes = { 1: { price: 60000, tier: 'secondary' }, 2: { price: 40000, tier: 'primary' } };
  invoiceTotal = 90000;   // 60 000 + 40 000 − 10 000 скидки категории
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();
  dlg.state.addLine(SERVICES[1], null);

  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);
  assert.ok(dlg.state.result, 'регистрация не прошла — проверяется не то');

  const rows = rowsOf(dlg).filter((r) => textOf(r).includes('Приём терапевта'));
  const cells = cellsOf(rows[0]).map((c) => textOf(c).replace(/\s+/g, ' ').trim());
  assert.ok(cells[3].includes('60 000'), 'в строке не цена счёта: ' + cells[3]);
  assert.ok(!cells[3].includes('112 000'), 'в строке осталась цена каталога: ' + cells[3]);

  const tbl = textOf(dlg.table).replace(/\s+/g, ' ');
  assert.ok(tbl.includes('90 000'), '«Итого» не равно сумме счёта: ' + tbl.slice(-160));
  assert.ok(!tbl.includes('152 000'), 'в итоге осталась сумма каталога');

  // Скидка названа прямо под таблицей: разницу «сложил сам» пациент не обязан.
  const card = textOf(dlg.table.parentNode).replace(/\s+/g, ' ');
  assert.ok(/Скидка/.test(card) && card.includes('10 000'), 'скидка не названа под таблицей: ' + card.slice(-200));

  // И на бумаге — то же самое.
  btnByText(dlg.card, 'Печать').click();
  await tick(20);
  assert.strictEqual(printed.length, 1, 'счёт не напечатался');
  assert.ok(printed[0].includes('60 000'), 'на печати нет цены счёта');
  assert.ok(!printed[0].includes('112 000'), 'на печати осталась цена каталога');
  assert.ok(printed[0].includes('<div class="fl">Скидка</div>'), 'на печати нет строки скидки');
  assert.ok(/Скидка<\/div><div class="fv">[^<]*10 000/.test(printed[0]), 'сумма скидки на печати другая');
  // INVOICE_DOCTOR_V1 — кто выполняет, написано и на бумаге: пациент с этим
  // счётом идёт к конкретному человеку, а не «в клинику».
  assert.ok(printed[0].includes('Петров Пётр'), 'на печати нет исполнителя услуги');
  dlg.close();
});

// ===========================================================================
// НОМЕР ОЧЕРЕДИ — ЭТО НОМЕР, А НЕ ДВЕРЬ.
//
// issue_queue_numbers возвращает и label (чья дверь: врач, кабинет,
// лаборатория), и number (какой по счёту). Пациенту нужен номер: с ним он
// садится ждать. Дверь — уточнение к номеру, а не замена ему.
//
// На печатном счёте блок очереди собирается только из строк с truthy number
// (doc-variants.js queueGroups): счёт, отданный пациенту без номера, отправляет
// его обратно к стойке спрашивать, какой он.
// ===========================================================================
test('номер очереди виден в таблице и ПЕЧАТАЕТСЯ на счёте, дверь — подписью к нему', async () => {
  reset();
  queueTickets = (ids) => ids.map((id) => ({
    visit_service_id: id, queue_key: 'doc:5', label: 'Петров Пётр', number: 3,
  }));
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);

  const rows = rowsOf(dlg).filter((r) => textOf(r).includes('Приём терапевта'));
  const queueCell = cellsOf(rows[0])[5];
  const cellText = textOf(queueCell).replace(/\s+/g, ' ').trim();
  assert.ok(/^3\b/.test(cellText), 'в столбце «№ очереди» не номер: ' + cellText);
  assert.ok(cellText.includes('Петров Пётр'), 'дверь не подписана рядом с номером: ' + cellText);

  btnByText(dlg.card, 'Печать').click();
  await tick(20);
  assert.strictEqual(printed.length, 1, 'счёт не напечатался');
  const i = printed[0].indexOf('Номер очереди');
  assert.ok(i > 0, 'на счёте нет блока номера очереди');
  const block = printed[0].slice(i, i + 700);
  assert.ok(block.includes('>3<'), 'номер не попал на счёт: ' + block.slice(0, 300));
  assert.ok(block.includes('Петров Пётр'), 'дверь не попала на счёт');
  dlg.close();
});

// ===========================================================================
// СБОЙ ПОСРЕДИ ЦЕПОЧКИ — ПОВТОР НЕВОЗМОЖЕН.
//
// Визит дня переиспользуется (ensure_visit). Значит второе нажатие «Сохранить»
// после сбоя на второй строке допишет в ТОТ ЖЕ визит обе строки заново и
// выставит счёт на четыре. Поэтому после такого сбоя кнопки «Сохранить» больше
// нет: визит создан, счёт выставляется из карты пациента.
// ===========================================================================
test('сбой на второй строке: окно говорит «визит создан, счёт не выставлен» и больше не даёт сохранить', async () => {
  reset();
  insertFail = { table: 'visit_services', message: 'услуга недоступна', nth: 2 };
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();
  dlg.state.addLine(SERVICES[1], null);

  toasts.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);

  assert.ok(toasts.some((t) => t.includes('Визит создан, счёт не выставлен') && t.includes('услуга недоступна')),
    'регистратору не сказали, что визит остался без счёта: ' + toasts.join(' | '));
  assert.ok(dlg.state.patient && dlg.state.patient.id, 'созданный пациент потерялся');
  assert.strictEqual(dlg.saveBtn.style.display, 'none', '«Сохранить» осталась на виду после сбоя');
  assert.ok(dlg.saveBtn.disabled, '«Сохранить» можно нажать ещё раз после сбоя');
  assert.ok(btnByText(dlg.card, 'Открыть карту'), 'нечем уйти в карту пациента');

  // Второе нажатие — ни второй карты, ни второго визита, ни новых строк.
  calls.length = 0;
  dlg.saveBtn.click();
  await tick(60);
  assert.strictEqual(calls.filter((c) => c.kind === 'insert' && c.table === 'patients').length, 0,
    'повтор завёл вторую карту');
  assert.strictEqual(calls.filter((c) => c.kind === 'rpc' && c.name === 'ensure_visit').length, 0,
    'повтор пошёл заводить визит заново');
  assert.strictEqual(calls.filter((c) => c.kind === 'insert' && c.table === 'visit_services').length, 0,
    'повтор задвоил строки услуг');
  dlg.close();
});

// ===========================================================================
// ВЫБРАННЫЙ ИСПОЛНИТЕЛЬ ВИДЕН ВСЕГДА.
//
// Каталог услуг отдаёт услугу вместе с выбранным исполнителем, и это может
// быть человек ВНЕ пула услуги (медсестра на заборе крови). Пул рисует
// <select>, в котором его нет, — и в строке показывается «не выбран», а
// записывается он. Что записано, то и должно быть видно.
// ===========================================================================
test('исполнитель из каталога вне пула услуги показан в строке, а не записан втихую', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  const row = dlg.state.addLine(SERVICES[1], { id: 99, full_name: 'Медсестра Нина' });
  assert.strictEqual(row.doctorId, 99, 'исполнитель не доехал до строки — проверяется не то');

  const rows = rowsOf(dlg).filter((r) => textOf(r).includes('Общий анализ крови'));
  const sel = walk(rows[0]).find((n) => n.tagName === 'SELECT');
  assert.ok(sel, 'в строке с выбранным исполнителем нет выбора');
  assert.strictEqual(sel.value, '99', 'выбранный исполнитель не выбран в списке');
  const opts = sel.children.filter((o) => o.tagName === 'OPTION').map((o) => textOf(o));
  assert.ok(opts.some((o) => o.includes('Медсестра Нина')), 'исполнителя нет среди вариантов: ' + opts.join(' | '));
  dlg.close();
});

// ===========================================================================
// ПОИСК СУЩЕСТВУЮЩЕГО — ВТОРАЯ КАРТА НЕ ЗАВОДИТСЯ.
// ===========================================================================
test('пациент найден строкой поиска: форма заперта, «Сменить» отпирает, визит уезжает на его карту', async () => {
  reset();
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова',
                   first_name: 'Азиза', middle_name: '', phone: '+998901112233', date_of_birth: '1990-04-01' }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  dlg.searchInput.value = 'Кари';
  dlg.searchInput.fireInput();
  await tick(600);   // SEARCH_DEBOUNCE_V1 — поиск ждёт паузы в наборе

  const hit = walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt'));
  assert.ok(hit, 'найденный пациент не показан строкой выбора');
  hit.click();
  await tick(60);

  assert.ok(dlg.state.patient && dlg.state.patient.id === 42, 'выбор не взял карту найденного');
  assert.ok(dlg.fields.last_name.disabled, 'поля чужой карты остались редактируемыми');
  assert.ok(textOf(dlg.card).includes('P-42'), 'в окне не видно, на кого записываем');
  // FAST_REG_COMPACT_V1 — «Код отправителя» стоит в том же разделе, что и поля
  // карты, но он поле ВИЗИТА: у найденного пациента карту трогать нельзя, а
  // направление у сегодняшнего визита своё, и запирать его вместе с картой
  // значило бы терять его на каждом найденном пациенте.
  assert.ok(!dlg.referralSel.disabled, 'направление заперто вместе с чужой картой');

  // «Сменить» возвращает форму заведения новой карты.
  btnByText(dlg.card, 'Сменить').click();
  await tick(20);
  assert.ok(!dlg.fields.last_name.disabled, '«Сменить» не отперла форму');
  assert.strictEqual(dlg.state.patient, null, '«Сменить» не отпустила выбранного пациента');

  // Берём его снова и записываем услугу.
  dlg.searchInput.fireInput();
  await tick(600);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  await tick(60);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  calls.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(80);

  assert.strictEqual(calls.filter((c) => c.kind === 'insert' && c.table === 'patients').length, 0,
    'на найденного пациента завели вторую карту');
  const visit = calls.find((c) => c.kind === 'rpc' && c.name === 'ensure_visit');
  assert.ok(visit, 'визит не заведён');
  assert.strictEqual(visit.body.patient_id, 42, 'визит уехал не на найденную карту');

  // И после успеха повторное нажатие не уходит в базу ВООБЩЕ.
  calls.length = 0;
  dlg.saveBtn.click();
  await tick(60);
  assert.strictEqual(calls.length, 0, 'после сохранения повторное нажатие пошло в базу: ' + calls.length);
  dlg.close();
});

test('найденный пациент без услуг: окно говорит, что карта не изменена, и закрывается', async () => {
  reset();
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова',
                   first_name: 'Азиза', date_of_birth: '1990-04-01' }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  dlg.searchInput.value = 'Кари';
  dlg.searchInput.fireInput();
  await tick(600);
  walk(dlg.card).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'mg-search-opt')).click();
  await tick(60);

  calls.length = 0; toasts.length = 0;
  btnByText(dlg.card, 'Сохранить').click();
  await tick(60);

  assert.ok(toasts.some((t) => t.includes('Услуги не добавлены')),
    'сказали «Пациент сохранён», хотя ничего не сохраняли: ' + toasts.join(' | '));
  assert.strictEqual(calls.filter((c) => c.kind === 'rpc').length, 0, 'без услуг ушли вызовы RPC');
  assert.strictEqual(calls.filter((c) => c.kind === 'insert').length, 0, 'без услуг что-то записали');
  await tick(30);
  assert.strictEqual(dialogs('fast-registration').length, 0, 'окно не закрылось');
});

// ===========================================================================
// ПОКА ИДЁТ ЗАПИСЬ, ОКНО НЕ ЗАКРЫВАЕТСЯ.
//
// Между «Сохранить» и ответом сервера окно держит единственное знание о том,
// что именно записывается. Esc или щелчок мимо в этот миг снимают его с
// экрана, а цепочка идёт дальше: визит и счёт появятся, а регистратор об этом
// не узнает — ни номера счёта, ни номера очереди, ни печати.
// ===========================================================================
test('во время сохранения Esc и щелчок по подложке не закрывают окно', async () => {
  reset();
  let release;
  holdRpc = { name: 'ensure_visit', promise: new Promise((r) => { release = r; }) };
  const dlg = openFastRegistrationDialog({});
  await tick(40);
  fillMinimum(dlg);
  const row = dlg.state.addLine(SERVICES[0], null);
  row.sel.value = '7';
  row.sel.fireChange();

  btnByText(dlg.card, 'Сохранить').click();
  await tick(40);
  assert.strictEqual(dlg.state.saving, true, 'запись не идёт — проверяется не то');

  escapeKeydown();
  assert.strictEqual(dialogs('fast-registration').length, 1, 'Esc закрыл окно посреди записи');
  const backdrop = walk(dlg.overlay).find((n) => hasClass(n, 'modal-backdrop'));
  assert.ok(backdrop, 'у окна нет подложки');
  backdrop.click();
  assert.strictEqual(dialogs('fast-registration').length, 1, 'щелчок мимо закрыл окно посреди записи');

  release();
  holdRpc = null;
  await tick(80);
  assert.ok(dlg.state.result, 'запись не довелась до конца');
  dlg.close();
});

test('медсестра без права «Регистрация пациента» — окно доступа, а не регистрация', async () => {
  reset();
  setEffectiveFromRole({ name: 'nurse', permissions: {
    sections: ['patients', 'procedures', 'beds'],
    levels: { patients: 'editor', procedures: 'editor', beds: 'editor' },
  } });
  assert.strictEqual(isRouteAllowed('patients'), true, 'медсестре закрыли картотеку — проверяем не то');
  assert.strictEqual(canCreatePatient(), false);

  const dlg = openFastRegistrationDialog({});
  assert.strictEqual(dlg, null, 'окно открылось в обход права');
  assert.strictEqual(dialogs('fast-registration').length, 0, 'окно быстрой регистрации всё-таки нарисовалось');
  assert.strictEqual(dialogs('access-denied').length, 1, 'отказ промолчал — это читается как поломка');
  setFullAccess('Admin');
});
