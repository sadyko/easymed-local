// SERVICES_ONE_EDITOR_V1 — страница «Услуги» (каталог, views/services.js)
// открывает ЕДИНЫЙ редактор услуги (views/service-editor.js), а не собственную
// модалку. Своя модалка пережила SERVICE_EDITOR_V1, потому что services.js
// никогда не ссылался на section-crud и его никто не тронул: старые поля,
// голая галочка «Is lab test» и английские подписи на узбекском экране.
// Этот файл — регрессионный гвоздь: «Добавить услугу» и клик по строке обязаны
// открывать НОВЫЙ редактор, а единственный в клиенте путь ЖЁСТКОГО удаления
// (rpc service_delete_check → delete_service, SERVICE_DELETE_V1) обязан
// остаться достижимым с этой страницы — у нового редактора удаления нет,
// а generic-список секций умеет только деактивировать (DELETE на services
// закрыт для всех, см. server/db/schema-registry.js).
//
// Fake-DOM harness — тот же, что в __tests__/branch-sync-view.test.mjs
// (оттуда же и пин localStorage 'admin.lang'='ru' ДО импорта экрана: i18n.js
// выбирает язык один раз, при загрузке модуля).

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 // Выключенной кнопке настоящий браузер пользовательский клик НЕ доставляет —
 // на этом и держится защита от двойного сохранения (SAVE_BTN_TARGET_V1).
 dispatchEvent(e){if(e.type==='click'&&this.disabled)return false;for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',target:this,currentTarget:this,preventDefault(){},stopPropagation(){}});}   // target — как у настоящего события: обработчик «Сохранить» гасит им кнопку
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
// Тосты. toast() (ui.js) ищет #toast, пишет в него текст — и сразу кладёт в
// el._t таймер, затирая то же поле, в котором фейковый DOM держит текст.
// Поэтому ловим текст в момент записи: один общий элемент с пишущим сеттером.
const toasts = [];
const toastEl = {
  dataset: {}, _t: null, setAttribute() {},
  classList: { add() {}, remove() {}, contains() { return false; } },
  set textContent(v) { toasts.push(String(v)); },
  get textContent() { return toasts[toasts.length - 1] || ''; },
};
globalThis.document.getElementById = (id) => (id === 'toast' ? toastEl : null);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
// SERVICES_SCROLL_KEEP_V1 — прокрутку страницы держит ОКНО (у оболочки нет
// своего скроллера), поэтому окно умеет и scrollY, и scrollTo: так же, как в
// __tests__/app-shell.test.mjs, каждый вызов записывается — утверждения ниже
// читают именно их.
const scrollCalls = [];
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {},
  easymed: { state: { user: null } },
  CLINIC: { id: 1 },
  scrollY: 0,
  scrollTo(...args) { scrollCalls.push(args); },
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

// ---------------------------------------------------------------------------
// Сервер: /api/db отвечает по имени таблицы, /api/rpc — по имени процедуры.
// Каждый дескриптор записывается — утверждения ниже читают именно их.
// ---------------------------------------------------------------------------
const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const SVC = { id: 7, name: 'УЗИ печени', code: 'US-01', price: 50000, tax_rate: 12,
  duration_minutes: 20, requires_doctor: 1, active: 1, is_lab: 0, type: 'imaging' };
let services = [SVC];
let categories = [{ id: 3, name: 'УЗИ' }];   // SVC_LIST_V2 — the «Категория» column reads names by id
let serviceTypes = [{ id: 5, name: 'Абдоминальное' }];   // SVC_VOCAB_V1 — «Тип» is the clinic's own word, by id
let deleteCheck = { deletable: true, name: SVC.name, blocking: [] };
const dbCalls = [];
const rpcCalls = [];
// SERVICES_SCROLL_KEEP_V1 — задержка каталога по требованию: пока сюда положен
// промис, выборка services висит, и видно, ЧТО показывает таблица во время
// перезагрузки (в жизни это секунда сети — на ней и происходил прыжок наверх).
let holdServices = null;
// SERVICES_SCROLL_KEEP_V1 — один отказ выборки services «по требованию»:
// имитирует транзиентный сбой ровно на тихой перезагрузке (после сохранения).
let failServicesOnce = false;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    dbCalls.push(desc);
    if (desc.op === 'select') {
      if (desc.table === 'services' && holdServices) await holdServices;
      if (desc.table === 'services' && failServicesOnce) {
        failServicesOnce = false;
        return { ok: false, json: async () => ({ error: { message: 'boom' } }) };
      }
      return jsonOk(desc.table === 'services' ? services : desc.table === 'service_categories' ? categories : desc.table === 'service_types' ? serviceTypes : []);
    }
    return jsonOk({});
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: opts && opts.body ? JSON.parse(opts.body) : {} });
    if (name === 'service_delete_check') return jsonOk(deleteCheck);
    if (name === 'delete_service') return jsonOk({ ok: true });
    return jsonOk({});
  }
  return jsonOk({});
};
let confirms = [];
let confirmAnswer = true;
globalThis.window.confirm = (text) => { confirms.push(String(text)); return confirmAnswer; };

const { renderServices } = await import('../views/services.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
const deleteButtons = (root) => tags(root, 'button').filter((b) => b.attrs.title === 'Удалить');

/** Редактор открывается без await из onclick — даём микрозадачам дойти. */
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

const ADMIN = { id: 1, full_name: 'Администратор', role: 'admin', is_admin: true };
const NURSE = { id: 2, full_name: 'Медсестра', role: 'nurse' };

async function paint(user = ADMIN) {
  window.easymed.state.user = user;
  document.body.children.length = 0;
  dbCalls.length = 0; rpcCalls.length = 0; confirms = []; confirmAnswer = true;
  scrollCalls.length = 0; window.scrollY = 0;   // SERVICES_SCROLL_KEEP_V1
  services = [SVC];
  deleteCheck = { deletable: true, name: SVC.name, blocking: [] };
  const container = mk('div');
  await renderServices(container, {});
  await flush();
  return container;
}

// Справочники, которые грузит ТОЛЬКО единый редактор (views/service-editor.js):
// их появление в dbCalls — доказательство, что открылся именно он.
const EDITOR_LOOKUPS = ['service_types', 'service_categories', 'departments', 'rooms', 'users'];

test('«Создать» открывает ЕДИНЫЙ редактор, а не свою модалку', async () => {
  const c = await paint(ADMIN);
  const add = buttonWith(c, 'Создать');
  assert.ok(add, 'кнопка «Создать» есть и переведена');

  dbCalls.length = 0;
  add.click();
  await flush();

  const body = textOf(document.body);
  assert.ok(body.includes('Новая услуга'), 'заголовок единого редактора (создание)');
  const asked = new Set(dbCalls.filter((d) => d.op === 'select').map((d) => d.table));
  for (const t of EDITOR_LOOKUPS) assert.ok(asked.has(t), 'редактор грузит справочник ' + t);
  // Старой модалки больше нет — вместе с её английскими подписями.
  for (const dead of ['Is lab test', 'Duration (minutes)', 'Requires doctor']) {
    assert.ok(!body.includes(dead), 'подпись старой модалки исчезла: ' + dead);
  }
});

test('клик по строке открывает тот же редактор на редактирование', async () => {
  const c = await paint(ADMIN);
  const row = tags(c, 'tr').find((r) => r.className.includes('row-click'));
  assert.ok(row, 'строка услуги кликабельна');

  dbCalls.length = 0;
  row.click();
  await flush();

  assert.ok(textOf(document.body).includes('Изменить услугу'), 'заголовок единого редактора (правка)');
  assert.ok(tags(document.body, 'input').some((i) => i.value === SVC.name),
    'редактор открыт именно на этой услуге (имя в поле)');
  const asked = new Set(dbCalls.filter((d) => d.op === 'select').map((d) => d.table));
  for (const t of EDITOR_LOOKUPS) assert.ok(asked.has(t), 'редактор грузит справочник ' + t);
});

test('не-админу — редактор на просмотр и никакого удаления', async () => {
  const c = await paint(NURSE);
  assert.equal(deleteButtons(c).length, 0, 'кнопка удаления — только админу (правило SERVICE_DELETE_V1)');
  const row = tags(c, 'tr').find((r) => r.className.includes('row-click'));
  row.click();
  await flush();
  assert.ok(textOf(document.body).includes('Просмотр услуги'), 'не-админ смотрит, но не редактирует');
});

test('удаление: неиспользуемая услуга — подтверждение и rpc delete_service', async () => {
  const c = await paint(ADMIN);
  const btn = deleteButtons(c)[0];
  assert.ok(btn, 'у админа в строке есть кнопка удаления');

  btn.click();
  await flush();

  assert.ok(rpcCalls.some((r) => r.name === 'service_delete_check' && r.args.p_service_id === SVC.id),
    'сначала спрашиваем сервер, что возможно');
  assert.equal(confirms.length, 1, 'одно подтверждение');
  assert.ok(confirms[0].includes('навсегда'), 'подтверждение говорит о безвозвратном удалении');
  assert.ok(rpcCalls.some((r) => r.name === 'delete_service' && r.args.p_service_id === SVC.id),
    'жёсткое удаление идёт через rpc delete_service — генерик-DELETE закрыт');
});

test('удаление: используемая услуга — предлагает отключить и пишет active=0', async () => {
  const c = await paint(ADMIN);
  deleteCheck = { deletable: false, name: SVC.name, blocking: [{ label: 'визиты', count: 3 }] };
  const btn = deleteButtons(c)[0];

  btn.click();
  await flush();

  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].includes('уже используется'), 'диалог объясняет, почему удалить нельзя');
  assert.ok(!rpcCalls.some((r) => r.name === 'delete_service'), 'delete_service НЕ зовётся');
  const upd = dbCalls.find((d) => d.op === 'update' && d.table === 'services');
  assert.ok(upd, 'вместо удаления — деактивация');
  assert.equal(upd.values.active, 0);
  assert.ok(upd.filters.some((f) => f.col === 'id' && f.val === SVC.id), 'деактивируется именно эта услуга');
});

// SERVICES_BULK_V1 — owner: «cannot select several … services at the same
// time». Every row carries a checkbox; ticking shows a bar with the count and
// the group actions; «Отключить» writes active=0 to each picked row.
const rowBoxes = (root) => tags(root, 'input').filter((i) => i.attrs.type === 'checkbox' && i.attrs.title !== 'Отметить все');
const tick = (box, on) => { box.checked = on; box.dispatchEvent({ type: 'change', target: box }); };

test('выделение: галочки в строках, счётчик «Выбрано», «Отключить» пишет active=0 каждой', async () => {
  services = [SVC, { ...SVC, id: 8, name: 'УЗИ почек', code: 'US-02' }, { ...SVC, id: 9, name: 'ЭКГ', code: 'ECG' }];
  window.easymed.state.user = ADMIN;
  document.body.children.length = 0;
  dbCalls.length = 0; rpcCalls.length = 0; confirms = [];
  const c = mk('div');
  await renderServices(c, {});
  await flush();

  const boxes = rowBoxes(c);
  assert.equal(boxes.length, 3, 'по галочке на строку');
  assert.ok(!buttonWith(c, 'Снять выделение'), 'без выделения панели нет');

  tick(boxes[0], true);
  tick(boxes[2], true);
  assert.ok(textOf(c).includes('Выбрано: 2'), 'панель показывает число выбранных');
  assert.ok(buttonWith(c, 'Экспорт выбранных в Excel'), 'экспорт выбранных доступен');

  buttonWith(c, 'Отключить').click();
  await flush();
  const upds = dbCalls.filter((d) => d.op === 'update' && d.table === 'services');
  assert.deepEqual(upds.map((u) => u.filters.find((f) => f.col === 'id').val).sort(), [7, 9], 'отключены ровно выбранные');
  assert.ok(upds.every((u) => u.values.active === 0));
  services = [SVC];
});

test('выделение: «Отметить все» в шапке берёт все строки и «Удалить» проверяет каждую', async () => {
  services = [SVC, { ...SVC, id: 8, name: 'УЗИ почек', code: 'US-02' }];
  window.easymed.state.user = ADMIN;
  document.body.children.length = 0;
  dbCalls.length = 0; rpcCalls.length = 0; confirms = []; confirmAnswer = true;
  deleteCheck = { deletable: true, name: SVC.name, blocking: [] };
  const c = mk('div');
  await renderServices(c, {});
  await flush();

  const head = tags(c, 'input').find((i) => i.attrs.title === 'Отметить все');
  assert.ok(head, 'в шапке таблицы есть «Отметить все»');
  tick(head, true);
  assert.ok(textOf(c).includes('Выбрано: 2'));

  buttonWith(c, 'Удалить').click();
  await flush();
  assert.equal(confirms.length, 1, 'одно подтверждение на всю группу');
  assert.equal(rpcCalls.filter((r) => r.name === 'service_delete_check').length, 2, 'каждая проверяется перед удалением');
  assert.equal(rpcCalls.filter((r) => r.name === 'delete_service').length, 2);
  services = [SVC];
});

// SVC_LIST_V2 — the list the owner chose from the four previews: five columns
// by default (Наименование, Категория, Тип, Цена, Статус), a filter box under
// every label, a toolbar with search · Активные/Отключённые/Все · type ·
// Сбросить · Шаблон/Импорт/Экспорт · Таблица · Создать. No price range, no
// «По счёту визита».
const headLabels = (c) => walk(c).filter((n) => /svc-th-label/.test(n.className || '')).map((n) => textOf(n).trim());
const dataRows = (c) => tags(c, 'tr').filter((r) => /row-click/.test(r.className || ''));
const cellsOf = (r) => tags(r, 'td').map((t) => textOf(t).replace(/\s+/g, ' ').trim());
const filterBox = (c, key) => tags(c, 'input').find((i) => i.attrs.id === 'svc-f-' + key);
const type = (inp, v) => { inp.value = v; inp.dispatchEvent({ type: 'input', target: inp }); };
// paint() resets the catalogue to one row; these tests bring their own.
async function paintRows(rows, user = ADMIN) {
  window.easymed.state.user = user;
  document.body.children.length = 0;
  dbCalls.length = 0; rpcCalls.length = 0; confirms = []; confirmAnswer = true;
  services = rows;
  const c = mk('div');
  await renderServices(c, {});
  await flush();
  return c;
}

test('пять колонок по умолчанию, под каждой — поле «фильтр»; категория — по названию', async () => {
  const c = await paintRows([{ ...SVC, category_id: 3, type_id: 5 }]);
  assert.deepEqual(headLabels(c), ['Наименование', 'Категория', 'Тип', 'Цена', 'Статус']);
  for (const k of ['name', 'category', 'type', 'price', 'status']) assert.ok(filterBox(c, k), 'поле фильтра под колонкой ' + k);
  assert.ok(!headLabels(c).includes('По счёту визита') && !headLabels(c).includes('Код'), 'без кода и без цен по счёту визита');
  const cells = cellsOf(dataRows(c)[0]);
  assert.ok(cells.includes('УЗИ'), 'категория подписана названием: ' + cells.join(' | '));
  // SVC_VOCAB_V1 — «Тип» is what the clinic wrote (service_types), NOT the group of five
  assert.ok(cells.includes('Абдоминальное'), 'тип — слово клиники: ' + cells.join(' | '));
  assert.ok(!cells.includes('Диагностика'), 'группа не подменяет тип');
  assert.ok(cells.includes('50 000') && cells.includes('Активна'));
  const sel = tags(c, 'select').find((el) => el.attrs.id === 'svc-group');
  assert.deepEqual(sel.children.map((o) => textOf(o).trim()), ['Все группы', 'Диагностика', 'Консультации', 'Лаборатория', 'Процедуры', 'Хирургия'], 'группа — пять, в выпадающем списке');
  services = [SVC];
});

test('фильтр под колонкой ищет по тому, что видно; «Активные» прячет отключённые, «Все» показывает', async () => {
  const c = await paintRows([SVC, { ...SVC, id: 8, name: 'ЭКГ', type: 'procedure', active: 0 }, { ...SVC, id: 9, name: 'Массаж', type: 'procedure' }]);
  assert.equal(dataRows(c).length, 2, 'по умолчанию — только активные');
  const groupSel = tags(c, 'select').find((el) => el.attrs.id === 'svc-group');
  groupSel.value = 'procedure'; groupSel.dispatchEvent({ type: 'change', target: groupSel });
  assert.deepEqual(dataRows(c).map((r) => cellsOf(r)[1]), ['Массаж'], 'группа в списке отбирает по пяти (отключённая ЭКГ скрыта)');
  buttonWith(c, 'Все').click();
  assert.deepEqual(dataRows(c).map((r) => cellsOf(r)[1]).sort(), ['Массаж', 'ЭКГ'], '«Все» возвращает отключённые');
  type(filterBox(c, 'name'), 'масс');
  assert.deepEqual(dataRows(c).map((r) => cellsOf(r)[1]), ['Массаж'], 'фильтр под колонкой по слову из ячейки');
  const reset = buttonWith(c, 'Сбросить');
  assert.ok(reset && !reset.attrs.disabled, '«Сбросить» активна, пока есть фильтр');
  reset.click();
  assert.equal(dataRows(c).length, 3, 'сброс снимает группу и фильтры колонок');
  assert.equal(filterBox(c, 'name').value, '', 'поле фильтра очищено');
  assert.equal(groupSel.value, '', 'группа сброшена');
  const search = tags(c, 'input').find((i) => i.attrs.id === 'svc-search');
  type(search, 'экг');
  await new Promise((r) => setTimeout(r, 650));   // SEARCH_DEBOUNCE_V1 (500 мс) — поле поиска отвечает с задержкой
  assert.equal(dataRows(c).length, 1, 'поиск по названию');
  services = [SVC];
});

test('«Таблица»: добавить «Код», убрать «Категорию», «Применить» — шапка меняется и выбор запоминается; «По умолчанию» возвращает пять', async () => {
  localStorage.removeItem('svc.tbl.cols.v1');
  const c = await paint(ADMIN);
  buttonWith(c, 'Таблица').click();
  const body = document.body;
  assert.ok(textOf(body).includes('Настройка таблицы'), 'диалог открылся');
  const rowOf = (label) => walk(body).filter((n) => /tset-row/.test(n.className || '')).find((r) => textOf(r).includes(label));
  assert.ok(rowOf('Код') && rowOf('Категория'), 'слева — текущие колонки, справа — доступные');
  const tick = (label) => { const cb = tags(rowOf(label), 'input')[0]; cb.checked = !cb.checked; cb.dispatchEvent({ type: 'change', target: cb }); };
  tick('Код');          // add
  tick('Категория');    // remove
  buttonWith(body, 'Применить').click();
  assert.deepEqual(headLabels(c), ['Наименование', 'Тип', 'Цена', 'Статус', 'Код']);
  assert.deepEqual(JSON.parse(localStorage.getItem('svc.tbl.cols.v1')), ['name', 'type', 'price', 'status', 'code'], 'выбор колонок сохранён в браузере');
  assert.ok(cellsOf(dataRows(c)[0]).includes('US-01'), 'колонка «Код» показывает код');

  buttonWith(c, 'Таблица').click();
  buttonWith(document.body, 'По умолчанию').click();
  buttonWith(document.body, 'Применить').click();
  assert.deepEqual(headLabels(c), ['Наименование', 'Категория', 'Тип', 'Цена', 'Статус']);
  assert.equal(localStorage.getItem('svc.tbl.cols.v1'), null, 'умолчание — без записи');
});

test('ширины колонок — доли карточки: любой набор колонок делит ширину без прокрутки', async () => {
  const c = await paint(ADMIN);
  const ths = tags(c, 'th').filter((t) => t.style && /calc\(\(100% - 78px\)/.test(t.style.width || ''));
  assert.equal(ths.length, 5, 'у каждой колонки — доля от (100% − фикс. колонки)');
  const shares = ths.map((t) => Number(t.style.width.match(/\* ([\d.]+)\)/)[1]));
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 0.01, 'доли в сумме дают 1: ' + shares.join(', '));
});

test('DOCTOR_TIER_V1: в редакторе услуги есть порог и доля выше порога, и они уходят в service_save', async () => {
  SVC.requires_doctor = 0;   // без исполнителей: страж «отметьте исполнителя» не должен мешать этому тесту
  try {
    const c = await paint();
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();
    const inputs = tags(document.body, 'input');
    const from = inputs.find((i) => i.attrs.placeholder === '0 — нет');
    const pct  = inputs.find((i) => i.attrs.placeholder === 'напр. 40');
    assert.ok(from && pct, 'поля ступени не нарисованы');
    from.value = '25'; pct.value = '40';
    buttonWith(document.body, 'Сохранить').click();
    await flush();
    const save = rpcCalls.find((r) => r.name === 'service_save');
    assert.ok(save, 'service_save не вызван: ' + rpcCalls.map((r) => r.name).join(','));
    assert.equal(save.args.doctor_tier_from, 25);
    assert.equal(save.args.doctor_tier_percent, 40);
  } finally { SVC.requires_doctor = 1; }
});

// Полупара — порог без доли (или наоборот) — это отказ 400 на сервере
// (rpc/service-save.js). Редактор не обязан его дожидаться: проверка здесь
// ставит курсор в незаполненное поле, а на сервер не уходит ничего.
test('DOCTOR_TIER_V1: половина ступени не уходит на сервер — редактор просит вторую половину', async () => {
  SVC.requires_doctor = 0;   // страж «отметьте исполнителя» не должен мешать этому тесту
  try {
    const c = await paint();
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();
    const from = tags(document.body, 'input').find((i) => i.attrs.placeholder === '0 — нет');
    assert.ok(from, 'поле порога не нарисовано');
    from.value = '25';   // доля выше порога осталась пустой
    rpcCalls.length = 0; toasts.length = 0;
    buttonWith(document.body, 'Сохранить').click();
    await flush();
    assert.ok(!rpcCalls.some((r) => r.name === 'service_save'),
      'полупара ушла на сервер: ' + rpcCalls.map((r) => r.name).join(','));
    assert.ok(toasts.some((t) => t.includes('Ступень задаётся парой')),
      'подсказки о второй половине нет: ' + toasts.join(' | '));
  } finally { SVC.requires_doctor = 1; }
});

// DOCTOR_TIER_V2 — владелец: «another 2 (overall 3) steps of the percentage».
// Три ряда той же пары полей с подписями «Ступень 1/2/3»; уходят шесть полей.
test('DOCTOR_TIER_V2: в редакторе три ряда ступеней, и все шесть полей уходят в service_save', async () => {
  SVC.requires_doctor = 0;
  try {
    const c = await paint();
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();
    const body = textOf(document.body);
    for (const lbl of ['Ступень 1', 'Ступень 2', 'Ступень 3']) assert.ok(body.includes(lbl), 'нет подписи «' + lbl + '»');
    const inputs = tags(document.body, 'input');
    const tier = (k) => inputs.find((i) => i.attrs['data-tier'] === k);
    for (const k of ['from-1', 'pct-1', 'from-2', 'pct-2', 'from-3', 'pct-3']) assert.ok(tier(k), 'нет поля ' + k);
    Object.entries({ 'from-1': '25', 'pct-1': '40', 'from-2': '50', 'pct-2': '45', 'from-3': '100', 'pct-3': '50' })
      .forEach(([k, v]) => { tier(k).value = v; });
    rpcCalls.length = 0;
    buttonWith(document.body, 'Сохранить').click();
    await flush();
    const save = rpcCalls.find((r) => r.name === 'service_save');
    assert.ok(save, 'service_save не вызван');
    assert.deepEqual(
      ['doctor_tier_from', 'doctor_tier_percent', 'doctor_tier_from_2', 'doctor_tier_percent_2', 'doctor_tier_from_3', 'doctor_tier_percent_3'].map((k) => save.args[k]),
      [25, 40, 50, 45, 100, 50]);
  } finally { SVC.requires_doctor = 1; }
});

test('DOCTOR_TIER_V2: ступень 3 без ступени 2 и нерастущий порог не уходят на сервер', async () => {
  SVC.requires_doctor = 0;
  try {
    for (const [vals, msg] of [
      [{ 'from-1': '25', 'pct-1': '40', 'from-3': '100', 'pct-3': '50' }, 'ступень 3 без ступени 2'],
      [{ 'from-1': '25', 'pct-1': '40', 'from-2': '20', 'pct-2': '45' }, 'Порог ступени 2 должен быть больше'],
    ]) {
      const c = await paint();
      tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
      await flush();
      const inputs = tags(document.body, 'input');
      for (const [k, v] of Object.entries(vals)) inputs.find((i) => i.attrs['data-tier'] === k).value = v;
      rpcCalls.length = 0; toasts.length = 0;
      buttonWith(document.body, 'Сохранить').click();
      await flush();
      assert.ok(!rpcCalls.some((r) => r.name === 'service_save'), 'неверные ступени ушли на сервер: ' + JSON.stringify(vals));
      assert.ok(toasts.some((t) => t.includes(msg)), 'нет подсказки «' + msg + '»: ' + toasts.join(' | '));
    }
  } finally { SVC.requires_doctor = 1; }
});

// SAVE_BTN_TARGET_V1 — внутри «Сохранить» лежит значок, и палец попадает
// обычно в него: у такого события target — значок, а не кнопка. Гасить надо
// кнопку (currentTarget), иначе она остаётся живой и второй клик создаёт
// услугу второй раз.
test('SAVE_BTN_TARGET_V1: клик по значку внутри «Сохранить» гасит кнопку — двойной клик сохраняет один раз', async () => {
  SVC.requires_doctor = 0;   // страж «отметьте исполнителя» не должен мешать этому тесту
  try {
    const c = await paint();
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();
    const btn = buttonWith(document.body, 'Сохранить');
    const icon = btn.children[0];
    assert.ok(icon && icon !== btn, 'внутри кнопки нет значка — тогда тест ничего не проверяет');
    const fire = () => btn.dispatchEvent({ type: 'click', target: icon, currentTarget: btn,
      preventDefault() {}, stopPropagation() {} });
    rpcCalls.length = 0;
    fire(); fire();   // два клика подряд, без ожидания между ними
    await flush();
    assert.equal(rpcCalls.filter((r) => r.name === 'service_save').length, 1,
      'услуга сохранена дважды: ' + rpcCalls.map((r) => r.name).join(','));
    assert.ok(!btn.disabled, 'кнопка осталась выключенной после сохранения');
  } finally { SVC.requires_doctor = 1; }
});

// SERVICES_SCROLL_KEEP_V1 — владелец: «после сохранения услуги список
// перескакивает наверх, и приходится снова листать вниз». Причина не в самом
// сохранении: перезагрузка списка сначала СТИРАЛА строки и ставила одну
// «Loading…», страница на миг становилась короткой — и браузер сам обнулял
// прокрутку окна (другого скроллера у оболочки нет). Здесь выборка каталога
// держится на паузе: в этот момент строки обязаны остаться на экране, а после
// возврата данных прокрутка — вернуться туда, где человек стоял.
test('SERVICES_SCROLL_KEEP_V1: после сохранения услуги страница не прыгает вверх — строки не пропадают на время перезагрузки', async () => {
  SVC.requires_doctor = 0;   // страж «отметьте исполнителя» не должен мешать этому тесту
  let release = null;
  try {
    const c = await paint(ADMIN);
    window.scrollY = 900;   // человек листал список и открыл услугу далеко внизу
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();

    holdServices = new Promise((r) => { release = r; });
    scrollCalls.length = 0;
    buttonWith(document.body, 'Сохранить').click();
    await flush();

    const rowsNow = tags(c, 'tr').filter((r) => r.className.includes('row-click'));
    assert.ok(rowsNow.some((r) => textOf(r).includes(SVC.name)),
      'на время перезагрузки строки исчезли — страница становится короткой и браузер сбрасывает прокрутку');
    assert.ok(!tags(c, 'tr').some((r) => /Loading|Загруз/.test(textOf(r))),
      'вместо списка показана заглушка «Loading…» — именно она и обнуляет прокрутку');

    release(); release = null; holdServices = null;
    await flush();

    assert.ok(tags(c, 'tr').some((r) => r.className.includes('row-click') && textOf(r).includes(SVC.name)),
      'после ответа сервера список не перерисован');
    assert.ok(scrollCalls.some((a) => a[0] && a[0].top === 900 && a[0].behavior === 'instant'),
      'прокрутка не восстановлена мгновенно (behavior:instant из-за html{scroll-behavior:smooth}): ' + JSON.stringify(scrollCalls));
  } finally {
    if (release) release();
    holdServices = null; SVC.requires_doctor = 1;
  }
});

// SERVICES_SCROLL_KEEP_V1 — сбой самой перезагрузки (не только задержка):
// владелец видел тот же прыжок наверх, когда тихий рефреш после сохранения
// транзиентно отказывал — catch стирал allServices и рисовал пустой список,
// хотя данные в памяти были целы. Тихий путь обязан ИХ оставить на экране.
test('SERVICES_SCROLL_KEEP_V1: сбой тихой перезагрузки не стирает строки', async () => {
  SVC.requires_doctor = 0;   // страж «отметьте исполнителя» не должен мешать этому тесту
  try {
    const c = await paint(ADMIN);
    tags(c, 'tr').find((r) => r.className.includes('row-click')).click();
    await flush();

    failServicesOnce = true;
    buttonWith(document.body, 'Сохранить').click();
    await flush();

    assert.ok(tags(c, 'tr').some((r) => r.className.includes('row-click') && textOf(r).includes(SVC.name)),
      'сбой тихой перезагрузки стёр строки — список коллапсирует и страница прыгает вверх');
  } finally {
    failServicesOnce = false; SVC.requires_doctor = 1;
  }
});

// Первая загрузка — другое дело: показывать нечего, и «Loading…» честно
// говорит, что список едет. Тишина вместо него читалась бы как «услуг нет».
test('SERVICES_SCROLL_KEEP_V1: первая отрисовка по-прежнему показывает «Loading…»', async () => {
  let release = null;
  try {
    window.easymed.state.user = ADMIN;
    document.body.children.length = 0;
    services = [SVC];
    scrollCalls.length = 0; window.scrollY = 0;
    holdServices = new Promise((r) => { release = r; });

    const container = mk('div');
    const done = renderServices(container, {});   // без await: список ещё едет
    await flush();
    assert.ok(tags(container, 'tr').some((r) => /Loading|Загруз/.test(textOf(r))),
      'при первой загрузке нет ни строк, ни «Loading…» — экран выглядит пустым');

    release(); release = null; holdServices = null;
    await done; await flush();
    assert.ok(tags(container, 'tr').some((r) => r.className.includes('row-click') && textOf(r).includes(SVC.name)),
      'после загрузки заглушка не сменилась списком');
  } finally {
    if (release) release();
    holdServices = null;
  }
});
