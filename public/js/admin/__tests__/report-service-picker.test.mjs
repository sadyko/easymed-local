// JOURNALS_V1_SERVICE — окно выбора услуг журнала: поиск, «Выбрать все
// найденные», запомненный выбор, пустой выбор, предел. Настоящего браузера
// нет — тот же крошечный DOM-стенд, что у порционника (kitchen-sheet.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._x='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._x;} set textContent(v){this._x=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._x=String(t);}}
const mk=t=>{const e=new F(t); if(String(t).toLowerCase()==='template') e.content=new F('#fragment'); return e;};
// Слушатели клавиатуры документа — чтобы проверить Esc окна выбора.
const keyListeners = [];
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),
  addEventListener(t,fn,cap){ if (t === 'keydown') keyListeners.push({ fn, cap: !!cap }); },
  removeEventListener(t,fn){ const i = keyListeners.findIndex((l) => l.fn === fn); if (i > -1) keyListeners.splice(i, 1); },
  getElementById(){return null;}};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},dispatchEvent(){return true;},open:()=>null};
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const P = await import('../views/report-service-picker.js');
const { JOURNAL_SERVICE_MAX: SERVER_MAX } = await import('../../../../server/services/domain/journal-rules.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
// Текст узла — в _x: у ui.js toast() поле _t занято таймером скрытия.
const textOf = (el) => walk(el).map((n) => n._x || '').join(' ');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const button = (root, text) => walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n).includes(text));
const boxes = (root) => walk(root).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox');
const searchBox = (root) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'text');
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const CATALOG = [
  { id: 1, name: 'УЗИ брюшной полости', active: 1 },
  { id: 2, name: 'УЗИ почек', active: 1 },
  { id: 3, name: 'ЭКГ', active: 1 },
  { id: 4, name: 'УЗИ щитовидной железы', active: 0 },
];

test('чистые правила: выбор без мусора и повторов, поиск как у колл-центра, подпись кнопки, предел как у сервера', () => {
  assert.equal(P.JOURNAL_SERVICE_MAX, SERVER_MAX, 'предел окна разошёлся с сервером');
  assert.deepEqual(P.cleanServiceIds([3, '3', 7, 'x', -1, 0, 2.5, null]), [3, 7]);
  assert.deepEqual(P.findServices(CATALOG, 'узи').map((s) => s.id), [1, 2, 4]);
  assert.deepEqual(P.findServices(CATALOG, '').map((s) => s.id), [1, 2, 3, 4]);
  assert.deepEqual(P.selectAllFound([3], P.findServices(CATALOG, 'узи')), [3, 1, 2, 4]);
  assert.equal(P.servicesButtonText(3), 'Выбрать услуги (3)');
  assert.equal(P.servicesButtonText(0), 'Выбрать услуги (0)');
});

test('запомненный выбор: свой на каждый вид и каждого сотрудника; битое, чужое и недоступное хранилище — пусто, без ошибки', () => {
  const s = memoryStorage();
  P.rememberServices(s, 'service_journal', [5, '6', 5, 'мусор'], 7);
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', 7), [5, 6]);
  assert.deepEqual(P.loadRememberedServices(s, 'other_kind', 7), []);
  s.setItem(P.rememberKey('service_journal', 7), '{битое');
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', 7), []);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(P.loadRememberedServices(broken, 'service_journal', 7), []);
  assert.doesNotThrow(() => P.rememberServices(broken, 'service_journal', [1], 7));
  assert.deepEqual(P.loadRememberedServices(null, 'service_journal', 7), []);
});

// JOURNALS_V1_RJ2C (ревью F7) — общий компьютер регистратуры: выбор одного
// сотрудника не должен открываться следующему. Ключ — вид отчёта + id сотрудника;
// прежний общий ключ (без сотрудника) не читается — неизвестно, чей он, — и
// убирается при первом обращении.
test('запомненный выбор — у каждого сотрудника свой; прежний общий ключ не читается и убирается; без сотрудника — не помнится', () => {
  const s = memoryStorage();
  assert.notEqual(P.rememberKey('service_journal', 7), P.rememberKey('service_journal', 8));
  assert.notEqual(P.rememberKey('service_journal', 7), P.rememberKey('inpatient_register', 7));
  P.rememberServices(s, 'service_journal', [1, 2], 7);
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', 8), [], 'выбор сотрудника 7 открылся сотруднику 8');
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', 7), [1, 2]);
  s.setItem('easymed_report_services_service_journal', '[3,4]');   // ключ до RJ2C — чей, неизвестно
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', 9), []);
  assert.equal(s.getItem('easymed_report_services_service_journal'), null, 'прежний общий ключ остался');
  // Сотрудник неизвестен — ни чтения, ни записи.
  assert.equal(P.rememberServices(s, 'service_journal', [5], null), false);
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', null), []);
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', undefined), []);
  // id сотрудника — из сессии оболочки (window.easymed.state.user).
  const saved = globalThis.window.easymed;
  try {
    globalThis.window.easymed = { state: { user: { id: 42 } } };
    assert.equal(P.currentUserId(), 42);
    globalThis.window.easymed = undefined;
    assert.equal(P.currentUserId(), null);
  } finally { globalThis.window.easymed = saved; }
});

test('запомненный выбор: больше 2000 не записывается и не обрезается молча при чтении; хранилище, которое бросает, — без ошибки', () => {
  const s = memoryStorage();
  const over = Array.from({ length: 2001 }, (_, i) => i + 1);
  assert.equal(P.rememberServices(s, 'service_journal', over, 7), false);
  assert.equal(s.getItem(P.rememberKey('service_journal', 7)), null, 'выбор больше предела записан');
  assert.equal(P.rememberServices(s, 'service_journal', over.slice(0, 2000), 7), true);
  assert.equal(P.loadRememberedServices(s, 'service_journal', 7).length, 2000);
  s.setItem(P.rememberKey('service_journal', 7), JSON.stringify(over));   // записано старой версией
  assert.deepEqual(P.loadRememberedServices(s, 'service_journal', 7), [], 'выбор больше предела молча обрезан до 2000');
  const throwing = { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('quota'); } };
  assert.doesNotThrow(() => P.loadRememberedServices(throwing, 'service_journal', 7));
  assert.equal(P.rememberServices(throwing, 'service_journal', [1], 7), false);
  // Доступ к самому localStorage бросает (запрет в настройках браузера).
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    assert.equal(P.browserStorage(), null);
  } finally { Object.defineProperty(globalThis, 'localStorage', desc); }
});

test('окно: набрал «узи», «Выбрать все найденные», «Готово» — найденные плюс прежний выбор; отключённая услуга подписана', async () => {
  let applied = null;
  const { overlay } = P.openReportServicePicker({ selected: [3], onApply: (ids) => { applied = ids; }, loadCatalog: async () => CATALOG });
  await tick();
  assert.equal(boxes(overlay).length, 4);
  assert.ok(textOf(overlay).includes('Выбрано: 1'));
  const input = searchBox(overlay);
  input.value = 'узи';
  input.dispatchEvent({ type: 'input', target: input, currentTarget: input });
  assert.equal(boxes(overlay).length, 3);
  assert.ok(textOf(overlay).includes('не активна'));
  button(overlay, 'Выбрать все найденные').click();
  assert.equal(boxes(overlay).filter((b) => 'checked' in b.attrs).length, 3);
  assert.ok(textOf(overlay).includes('Выбрано: 4'));
  button(overlay, 'Готово').click();
  assert.deepEqual([...applied].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('окно: снятая галочка уходит; «Снять все» — пустой выбор уходит как есть', async () => {
  let applied = null;
  const { overlay } = P.openReportServicePicker({ selected: [1, 3], onApply: (ids) => { applied = ids; }, loadCatalog: async () => CATALOG });
  await tick();
  const first = boxes(overlay)[0];
  first.checked = false;
  first.dispatchEvent({ type: 'change', target: first, currentTarget: first });
  button(overlay, 'Готово').click();
  assert.deepEqual(applied, [3]);
  const second = P.openReportServicePicker({ selected: [1, 3], onApply: (ids) => { applied = ids; }, loadCatalog: async () => CATALOG });
  await tick();
  button(second.overlay, 'Снять все').click();
  button(second.overlay, 'Готово').click();
  assert.deepEqual(applied, []);
});

test('окно: больше 2000 найденных — отказ словами, выбор не меняется', async () => {
  const big = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, name: 'Услуга ' + (i + 1), active: 1 }));
  let applied = null;
  const { overlay } = P.openReportServicePicker({ selected: [7], onApply: (ids) => { applied = ids; }, loadCatalog: async () => big });
  await tick();
  assert.equal(boxes(overlay).length, 500, 'список рисует не больше 500 строк');
  assert.ok(textOf(overlay).includes('Показаны первые 500 из 2001'));
  button(overlay, 'Выбрать все найденные').click();
  assert.ok(textOf(document.body).includes('Не больше 2000 услуг в одном журнале'));
  button(overlay, 'Готово').click();
  assert.deepEqual(applied, [7]);
});

// JOURNALS_V1_RJ2C (ревью F7) — предел проверяла только «Выбрать все найденные»:
// отдельные галочки и «Готово» пропускали 2001-ю услугу, сервер отвечал 400, а
// выбор запоминался. Теперь 2001-я галочка не ставится, «Готово» с выбором больше
// предела не закрывает окно — тем же сообщением.
// Стенд не находит #toast (getElementById → null), и каждое сообщение — новый
// узел в body: перед действием прежние убираем, читаем последний.
const isToast = (n) => n.attrs && n.attrs.id === 'toast';
const clearToasts = () => { document.body.children = document.body.children.filter((n) => !isToast(n)); };
const toastText = () => { const t = document.body.children.filter(isToast).pop(); return t ? t._x : ''; };
const BIG = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, name: 'Услуга ' + (i + 1), active: 1 }));

test('окно: 2001-я галочка не ставится — сообщение, выбор остаётся 2000', async () => {
  let applied = null;
  const two = Array.from({ length: 2000 }, (_, i) => i + 2);   // 2..2001 — галочка у первой строки свободна
  const { overlay } = P.openReportServicePicker({ selected: two, onApply: (ids) => { applied = ids; }, loadCatalog: async () => BIG });
  await tick();
  assert.ok(textOf(overlay).includes('Выбрано: 2000'));
  const first = boxes(overlay)[0];
  assert.ok(!('checked' in first.attrs), 'стенд не тот: первая строка уже отмечена');
  clearToasts();
  first.checked = true;
  first.dispatchEvent({ type: 'change', target: first, currentTarget: first });
  assert.equal(first.checked, false, 'галочка сверх предела осталась стоять');
  assert.ok(toastText().includes('Не больше 2000 услуг в одном журнале'), 'нет сообщения о пределе');
  assert.ok(textOf(overlay).includes('Выбрано: 2000'));
  // Снять одну и поставить эту — можно: предел — число, а не запрет.
  const second = boxes(overlay)[1];
  second.checked = false;
  second.dispatchEvent({ type: 'change', target: second, currentTarget: second });
  first.checked = true;
  first.dispatchEvent({ type: 'change', target: first, currentTarget: first });
  assert.equal(first.checked, true);
  button(overlay, 'Готово').click();
  assert.equal(applied.length, 2000);
  assert.ok(applied.includes(1) && !applied.includes(2));
});

test('окно: «Готово» с выбором больше 2000 не применяет и не закрывает — сообщение; «Снять все» — применяется', async () => {
  keyListeners.length = 0;
  let applied = null;
  const over = BIG.map((s) => s.id);   // 2001 — пришло снаружи (старый запомненный выбор)
  const { overlay } = P.openReportServicePicker({ selected: over, onApply: (ids) => { applied = ids; }, loadCatalog: async () => BIG });
  await tick();
  clearToasts();
  button(overlay, 'Готово').click();
  assert.equal(applied, null, '«Готово» отправило 2001 услугу');
  assert.equal(keyListeners.length, 1, 'окно закрылось, выбор потерян без объяснения');
  assert.ok(toastText().includes('Не больше 2000 услуг в одном журнале'));
  button(overlay, 'Снять все').click();
  button(overlay, 'Готово').click();
  assert.deepEqual(applied, []);
  assert.equal(keyListeners.length, 0);
});

// Окно лежит над конструктором отчёта, а тот закрывается по Esc своим
// слушателем документа. Esc в окне выбора закрывает ТОЛЬКО окно выбора:
// слушатель окна — в фазе перехвата и останавливает событие.
test('окно: Esc закрывает только окно выбора, конструктор под ним не закрывается; «Отмена» выбор не применяет', async () => {
  keyListeners.length = 0;
  let applied = null;
  const { overlay } = P.openReportServicePicker({ selected: [3], onApply: (ids) => { applied = ids; }, loadCatalog: async () => CATALOG });
  await tick();
  const mine = keyListeners.find((l) => l.cap);
  assert.ok(mine, 'у окна нет своего слушателя Esc в фазе перехвата');
  let stopped = false;
  mine.fn({ key: 'Escape', stopPropagation() { stopped = true; }, preventDefault() {} });
  assert.equal(stopped, true, 'Esc ушёл дальше — закрыл бы и конструктор');
  assert.equal(keyListeners.length, 0, 'окно закрылось, а слушатель остался');
  assert.equal(applied, null);
  const again = P.openReportServicePicker({ selected: [3], onApply: (ids) => { applied = ids; }, loadCatalog: async () => CATALOG });
  await tick();
  button(again.overlay, 'Снять все').click();
  button(again.overlay, 'Отмена').click();
  assert.equal(applied, null, '«Отмена» применила выбор');
  assert.equal(keyListeners.length, 0);
  void overlay;
});

test('окно: поле поиска — на всю ширину окна', async () => {
  const { overlay } = P.openReportServicePicker({ selected: [], onApply: () => {}, loadCatalog: async () => CATALOG });
  await tick();
  assert.equal(searchBox(overlay).style.width, '100%');
});
