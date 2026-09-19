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
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),
  head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(){},removeEventListener(){},
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
// Фальшивый транспорт. Записываем ВСЁ: имя и тело каждого rpc и каждую вставку
// в /api/db — порядок вызовов и есть предмет проверки.
// ---------------------------------------------------------------------------
const calls = [];            // { kind: 'rpc'|'insert'|'select', name/table, body }
let patientRows = [];        // чем отвечает выборка по patients (страж дублей)
let insertFail = null;       // { table, message } — отказ вставки

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
    if (name === 'ensure_visit') return ok({ data: { visit: { id: 77 }, created: true } });
    if (name === 'service_price_quote') {
      return ok({ data: { quotes: { 1: { price: 112000, tier: 'primary' }, 2: { price: 40000, tier: 'primary' } } } });
    }
    if (name === 'create_invoice_for_visit') {
      return ok({ data: { invoice: { id: 9, invoice_number: 'INV-9', total_amount: 152000 }, items: [] } });
    }
    if (name === 'issue_queue_numbers') {
      const ids = (body && body.p_ids) || [];
      return ok({ data: ids.map((id, i) => ({ visit_service_id: id, label: 'A-' + (i + 1), number: i + 1, queue_key: 'k' })) });
    }
    return ok({ data: null });
  }

  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    const op = (body && body.op) || 'select';
    if (op === 'insert') {
      calls.push({ kind: 'insert', table, body: body.values });
      if (insertFail && insertFail.table === table) {
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
  calls.length = 0; toasts.length = 0; patientRows = []; insertFail = null; focused = null;
  document.body.children.length = 0;
  setFullAccess('Admin');
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
test('окно рисует реквизиты пациента (три секции) и пустую таблицу услуг с кнопками', async () => {
  reset();
  const dlg = openFastRegistrationDialog({});
  assert.ok(dlg, 'окно не открылось');
  await tick(40);

  assert.strictEqual(dialogs('fast-registration').length, 1, 'окна быстрой регистрации нет в документе');
  const txt = textOf(dlg.card).replace(/\s+/g, ' ');
  assert.ok(txt.includes('Быстрая регистрация'), 'нет заголовка окна');
  assert.ok(txt.includes('Пациент → услуги и врач → счёт → печать'), 'нет строки пути');

  // Реквизиты пациента — ТРИ раздела сборщика (четвёртый, «Здоровье», остаётся
  // карте пациента), плюс свой «Направление и скидка».
  const titles = walk(dlg.body).filter((n) => n.tagName === 'H3')
    .map((n) => textOf(n).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/\s+/g, ' ').trim())
    .map((t) => t.replace(/^[1234]\s*/, ''));
  for (const want of ['Личные данные', 'Документы и резидентство', 'Контакты и адрес', 'Направление и скидка', 'Услуги']) {
    assert.ok(titles.some((t) => t.includes(want)), 'нет блока «' + want + '»: ' + titles.join(' | '));
  }
  assert.ok(!titles.some((t) => t.includes('Здоровье')), 'раздел «Здоровье» попал в окно регистрации');
  const sections = walk(dlg.body).filter((n) => hasClass(n, 'mg-section') && !hasClass(n, 'mg-search'));
  assert.ok(sections.length >= 4, 'разделов меньше четырёх: ' + sections.length);

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
  // Номер очереди виден в таблице.
  assert.ok(textOf(dlg.table).includes('A-1'), 'номер очереди не показан');
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
  // Страж дублей ищет по patients: совпадение по ПИНФЛ — сильный признак.
  patientRows = [{ id: 42, mrn: 'P-42', full_name: 'Каримова Азиза', last_name: 'Каримова', first_name: 'Азиза',
                   middle_name: '', phone: '', date_of_birth: '1990-04-01', national_id: '12345678901234' }];
  const dlg = openFastRegistrationDialog({});
  await tick(40);

  fillMinimum(dlg);
  dlg.fields.national_id.value = '12345678901234';
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
