// PATIENT_FILE_ATTACH_V1 (2026-09-05) — вкладка «Документы» карты пациента:
// сторона ЭКРАНА.
//
// Жалоба владельца: «WE CANNOT UPLOAD THE PATIENT CARD. ITS SAYS ITS NOT
// IMPLEMENTED». Серверную сторону проверяет
// server/services/rpc/patient-card-docs.test.js; здесь — то, что человек
// видит и чем щёлкает:
//
//   * СЛИШКОМ БОЛЬШОЙ И НЕ ТОТ ФАЙЛ ОТБИВАЮТСЯ ДО ЗАГРУЗКИ. Сорокамегабайтную
//     фотографию с телефона незачем сначала лить по клинической сети, чтобы
//     потом узнать об отказе.
//   * У ЗАГРУЖЕННОГО ФАЙЛА ЕСТЬ АВТОР И ВРЕМЯ. Раньше в этой колонке стоял
//     «—», и спросить «кто это принёс» было не у кого.
//   * ФАЙЛ, КОТОРОГО НА ЭТОМ КОМПЬЮТЕРЕ НЕТ, НЕ ПРИТВОРЯЕТСЯ ССЫЛКОЙ. Файлы
//     не ездят между зданиями; молча открывшаяся пустая вкладка читается как
//     «документ потерян».
//   * КНОПКА ОТЗЫВАЕТ, А НЕ УДАЛЯЕТ: зовёт patient_card_doc_void и НЕ трогает
//     файл на диске; отозванный документ остаётся в списке помеченным.

// --- харнесс (копия из __tests__/patient-card-tabs.test.mjs) --------------
import { test } from 'node:test';
import assert from 'node:assert';

// --- Fake DOM (копия харнесса из __tests__/patients-hub.test.mjs) -----------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
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
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0, confirm: () => true,
  easymed: { state: { user: { id: 7, full_name: 'Регистратор', role: 'registrar' } } },
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history={state:null,replaceState(){},pushState(){}};
globalThis.confirm = () => true;

const PATIENT = { id: 1, mrn: 'MRN-1', full_name: 'Эргашев Жахонгир', gender: 'male',
  date_of_birth: '1990-04-01', phone: '+998901112233', active: 1 };

const UPLOADED = {
  id: 61, title: 'napravlenie.pdf', file_name: 'napravlenie.pdf',
  file_path: 'patients/1/docs/1757000000000-abc123-napravlenie.pdf',
  file_size: 12345, content_type: 'application/pdf', doc_type: 'upload',
  created_at: '2026-09-04T10:20:00Z', created_by: 7, created_by_name: 'Регистратор Ли',
  voided_at: null, voided_by_name: null, file_available: true, body: null,
};

function payloadWith(docs) {
  return {
    tabs: { services: 'none', labs: 'none', docs: 'delete', billing: 'none', visits: 'none', details: 'edit' },
    caps: { services: { edit: true, del: true }, labs: { edit: false, del: false }, docs: { edit: true, del: true },
            billing: { edit: false, del: false }, visits: { edit: true, del: false }, details: { edit: true, del: false } },
    patient: { ...PATIENT }, patient_limited: false, payer_name: null,
    visits: null, visit_count: 0, last_visit_date: null,
    services: null, lab_orders: null, lab_results: null,
    invoices: null, invoice_items: null, payments: null,
    docs, doc_notes: [],
  };
}

let calls = [];
let payload = payloadWith([UPLOADED]);
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  // тело бывает ФАЙЛОМ (загрузка в хранилище) — тогда оно не JSON
  let body = null;
  try { body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null; } catch { body = null; }
  calls.push({ url: u, method: (opts && opts.method) || 'GET', body });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    if (name === 'patient_card') return { ok: true, status: 200, json: async () => ({ data: JSON.parse(JSON.stringify(payload)) }) };
    return { ok: true, status: 200, json: async () => ({ data: { id: 61 } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: { path: 'x' } }) };
};

let opened = [];
globalThis.window.open = (u) => { opened.push(u); return null; };

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const { renderPatientCard } = await import('../views/patient-card.js');
const { setFullAccess } = await import('../permissions.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');

const TAB_LABELS = ['Услуги', 'Лаборатория', 'Документы', 'Счёт', 'Визиты', 'Деталь'];
const labelOfTab = (b) => walk(b).map((n) => (n._t || '').trim()).find((t) => TAB_LABELS.includes(t)) || null;
const DOCS_TAB = TAB_LABELS[2];
const openDocsTab = (root) => {
  const b = buttons(root).find((x) => labelOfTab(x) === DOCS_TAB);
  assert.ok(b, 'нет вкладки «Документы»');
  b.click();
};

async function renderDocs(docs) {
  calls = []; opened = [];
  payload = payloadWith(docs);
  setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  openDocsTab(box);
  await tick();
  return box;
}

const fileInput = (root) => walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'file');

async function pickFile(root, { name, size, type = 'application/pdf' }) {
  const inp = fileInput(root);
  assert.ok(inp, 'на вкладке нет поля выбора файла');
  inp.files = [{ name, size, type }];
  inp.dispatchEvent({ type: 'change', target: inp, currentTarget: inp });
  await tick();
}

const VOIDED_TAG = 'Отозван';
const NO_FILE_TAG = 'Файла нет на этом компьютере';
const VOID_BTN_TITLE = 'Отозвать документ';

// ===========================================================================

test('загруженный файл показан с тем, кто его приложил, и когда', async () => {
  const box = await renderDocs([UPLOADED]);
  const t = textOf(box);
  assert.ok(t.includes('napravlenie.pdf'), 'файла не видно в списке');
  assert.ok(t.includes('Регистратор Ли'), 'не видно, КТО приложил файл');
  assert.ok(/2026/.test(t), 'не видно, КОГДА приложили: ' + t.slice(0, 400));
});

test('сорокамегабайтная фотография отбивается ДО загрузки — сеть не трогается', async () => {
  const box = await renderDocs([]);
  calls = [];
  await pickFile(box, { name: 'foto.jpg', size: 42 * 1024 * 1024, type: 'image/jpeg' });
  assert.deepEqual(calls, [], 'файл поехал на сервер, хотя предел известен заранее');
});

test('запрещённый тип отбивается ДО загрузки', async () => {
  const box = await renderDocs([]);
  calls = [];
  await pickFile(box, { name: 'setup.exe', size: 1024, type: 'application/octet-stream' });
  assert.deepEqual(calls, [], '.exe поехал на сервер');
});

test('обычный файл всё-таки загружается: сначала байты, потом строка через RPC', async () => {
  const box = await renderDocs([]);
  calls = [];
  await pickFile(box, { name: 'analiz.pdf', size: 20000 });
  const storage = calls.filter((c) => c.url.includes('/api/storage/'));
  const add = calls.filter((c) => c.url.includes('/api/rpc/patient_card_doc_add'));
  assert.equal(storage.length, 1, 'байты не ушли в хранилище');
  assert.equal(add.length, 1, 'строка не ушла через RPC');
  assert.ok(String(storage[0].url).includes('patients/1/docs'), 'файл лёг не в папку этого пациента: ' + storage[0].url);
  assert.equal(add[0].body.row.created_by, undefined, 'автора ставит сервер — из браузера он приходить не должен');
});

test('файла нет на этом компьютере — карта говорит об этом, а не даёт битую ссылку', async () => {
  const box = await renderDocs([{ ...UPLOADED, file_available: false }]);
  assert.ok(textOf(box).includes(NO_FILE_TAG), 'экран молчит о том, что файла здесь нет');
  const link = walk(box).find((n) => n.tagName === 'A' && textOf(n).includes('napravlenie.pdf'));
  assert.ok(link, 'нет ссылки на документ');
  link.dispatchEvent({ type: 'click', target: link, currentTarget: link, preventDefault() {} });
  await tick();
  assert.deepEqual(opened, [], 'открылась вкладка с несуществующим файлом');
});

test('кнопка ОТЗЫВАЕТ документ: patient_card_doc_void и ни одного DELETE файла', async () => {
  const box = await renderDocs([UPLOADED]);
  const btn = buttons(box).find((b) => (b.attrs.title || '') === VOID_BTN_TITLE);
  assert.ok(btn, 'нет кнопки отзыва при уровне «Удаление»');
  calls = [];
  btn.click();
  await tick();
  assert.ok(calls.some((c) => c.url.includes('/api/rpc/patient_card_doc_void')), 'отзыв не позвал свой RPC');
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'файл всё ещё удаляется с диска');
});

test('отозванный документ остаётся в списке, помечен, и отозвать его второй раз нельзя', async () => {
  const box = await renderDocs([{ ...UPLOADED, voided_at: '2026-09-05T08:00:00Z', voided_by_name: 'Главврач Каримов' }]);
  const t = textOf(box);
  assert.ok(t.includes('napravlenie.pdf'), 'отозванный документ исчез из карты');
  assert.ok(t.includes(VOIDED_TAG), 'не видно, что документ отозван');
  assert.ok(!buttons(box).some((b) => (b.attrs.title || '') === VOID_BTN_TITLE), 'кнопка отзыва осталась');

  opened = [];
  const link = walk(box).find((n) => n.tagName === 'A' && textOf(n).includes('napravlenie.pdf'));
  assert.ok(link, 'нет ссылки на отозванный документ');
  link.dispatchEvent({ type: 'click', target: link, currentTarget: link, preventDefault() {} });
  await tick();
  assert.deepEqual(opened, [], 'отозванный документ всё ещё открывается');
});

// DOC_RICH_FORMAT_V1 (ревью T1) — «Заключение приёма», которого нет в архиве
// (подписано до архива или архив не записался — WS_DERIVED_DOCS_V1), печаталось
// ОБРАЗЦОМ: в бланк шёл bodyHtml без данных, и на бумаге был чужой пациент
// «Алиев Бобур». Теперь — лист приёма с данными этого пациента и записи.
test('«Заключение приёма» из записи кабинета печатается этим пациентом и его записью, не образцом', async () => {
  const notes = JSON.stringify({
    __service_workspace_v1: 1, current: null,
    diagnoses: [{ code: 'J20.9', name: 'Острый бронхит', type: 'main' }],
    prescriptions: [{ name: 'Амброксол', dose: '30 мг', freq: '3 раза в день', dur: '5 дней' }],
    history: [{ kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', byName: 'Каримов Алишер', fields: {
      chief_complaint: '<b>Кашель</b> три дня', physical_exam: '<ul><li>Хрипов нет</li><li>ЧДД 18</li></ul>',
      primary_diagnosis: 'Средней тяжести', icd10: 'J20.9', recommendations_text: 'Питьё<img src=x onerror=alert(1)>',
    } }],
  });
  calls = []; opened = [];
  payload = { ...payloadWith([]), doc_notes: [{ id: 501, notes, services: { name: 'Приём терапевта' }, users: { full_name: 'Каримов Алишер' } }] };
  setFullAccess('Администратор');
  const printed = [];
  const prevOpen = globalThis.window.open;
  globalThis.window.open = () => ({ document: { open() {}, write(s) { printed.push(String(s)); }, close() {} } });
  try {
    const box = mk('div');
    renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
    await tick();
    openDocsTab(box);
    await tick();
    const link = walk(box).find((n) => n.tagName === 'A' && textOf(n).includes('Заключение приёма'));
    assert.ok(link, 'нет строки «Заключение приёма» из записи кабинета: ' + textOf(box).slice(0, 300));
    link.click();
    await tick();
  } finally {
    globalThis.window.open = prevOpen;
  }
  assert.equal(printed.length, 1, 'лист не открылся');
  const html = printed[0].replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(html.includes('Эргашев'), 'на листе не этот пациент');
  assert.ok(!/Алиев Бобур|О\. Юсупов|Периодические головные боли|Рахимов/.test(html), 'на листе образец');
  assert.ok(html.includes('<ul><li>Хрипов нет</li><li>ЧДД 18</li></ul>') && html.includes('<b>Кашель</b>'), 'разделы записи без оформления');
  assert.ok(html.includes('J20.9 — Острый бронхит') && html.includes('Амброксол') && html.includes('Каримов'), 'диагноз, рецепт, врач записи');
  assert.ok(!/<img|onerror/.test(html), 'поле записи вставлено без очистки');
});

// PRINT_VISIT_DATE_V1 (ревью m6) — перепечатка подписанной записи без архивной копии
// датировалась ПОСЛЕДНЕЙ подписью: переподписал через неделю — и протокол «уехал» на
// неделю. Теперь — то же правило, что у кабинета и архива (shared/cabinet-doc.js
// docDayText): день визита, но не позже ПЕРВОЙ подписи; дня визита нет — день первой подписи.
async function printDerivedConclusion(extra = {}) {
  const notes = JSON.stringify({
    __service_workspace_v1: 1, current: null,
    history: [
      { kind: 'draft',  savedAt: '2026-09-29T08:00:00.000Z', fields: { chief_complaint: 'Кашель' } },
      { kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', byName: 'Каримов Алишер', fields: { chief_complaint: 'Кашель' } },
      { kind: 'signed', savedAt: '2026-10-05T08:00:00.000Z', byName: 'Каримов Алишер', fields: { chief_complaint: 'Кашель, уточнено' } },
    ],
  });
  calls = []; opened = [];
  payload = { ...payloadWith([]), doc_notes: [{ id: 502, notes, services: { name: 'Приём терапевта' }, users: { full_name: 'Каримов Алишер' } }], ...extra };
  setFullAccess('Администратор');
  const printed = [];
  const prevOpen = globalThis.window.open;
  globalThis.window.open = () => ({ document: { open() {}, write(s) { printed.push(String(s)); }, close() {} } });
  try {
    const box = mk('div');
    renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
    await tick();
    openDocsTab(box);
    await tick();
    const link = walk(box).find((n) => n.tagName === 'A' && textOf(n).includes('Заключение приёма'));
    assert.ok(link, 'нет строки «Заключение приёма» из записи кабинета');
    link.click();
    await tick();
  } finally {
    globalThis.window.open = prevOpen;
  }
  assert.equal(printed.length, 1, 'лист не открылся');
  return printed[0].replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
}

test('перепечатка записи без архива: день — ПЕРВАЯ подпись, а не последняя переподпись', async () => {
  const html = await printDerivedConclusion();
  assert.ok(html.includes('01.10.2026'), 'на листе нет дня первой подписи');
  assert.ok(!html.includes('05.10.2026'), 'лист датирован последней переподписью');
  assert.ok(html.includes('Кашель, уточнено'), 'на лист пошла не последняя подписанная запись');
});

test('перепечатка записи без архива: известен день визита — он, но не позже первой подписи', async () => {
  const svcRow = (visit_date) => ({ id: 502, visit_id: 9, service_id: 3, status: 'completed', quantity: 1, total: 100000,
    visit_date, services: { name: 'Приём терапевта' }, users: { full_name: 'Каримов Алишер' }, products: null });
  const tabs = { ...payloadWith([]).tabs, services: 'view' };
  const past = await printDerivedConclusion({ tabs, services: [svcRow('2026-09-30T09:00:00.000Z')] });
  assert.ok(past.includes('30.09.2026') && !past.includes('01.10.2026') && !past.includes('05.10.2026'), 'не день визита');
  const ahead = await printDerivedConclusion({ tabs, services: [svcRow('2026-10-03T09:00:00.000Z')] });
  assert.ok(ahead.includes('01.10.2026') && !ahead.includes('03.10.2026'), 'визит позже подписи — лист датирован будущим днём визита');
});

// PRINT_VISIT_DATE_V1 (ревью-2) — роль с «Документами», но без «Услуг»: день визита брался
// только из строк вкладки «Услуги», и запись, подписанная на следующий день после визита,
// перепечатывалась днём подписи. Теперь день визита едет на строке заключения (doc_notes).
test('перепечатка записи без архива у роли без «Услуг»: день визита со строки заключения', async () => {
  const late = JSON.stringify({
    __service_workspace_v1: 1, current: null,
    history: [{ kind: 'signed', savedAt: '2026-10-01T08:00:00.000Z', byName: 'Каримов Алишер', fields: { chief_complaint: 'Кашель' } }],
  });
  const html = await printDerivedConclusion({
    doc_notes: [{ id: 503, notes: late, visit_date: '2026-09-30T09:00:00.000Z',
      services: { name: 'Приём терапевта' }, users: { full_name: 'Каримов Алишер' } }],
  });
  assert.equal(payload.tabs.services, 'none', 'у роли открыты «Услуги»');
  assert.equal(payload.services, null);
  assert.ok(html.includes('30.09.2026'), 'на листе нет дня визита');
  assert.ok(!html.includes('01.10.2026'), 'лист датирован днём подписи, а не днём визита');
});

// ═══ LAB_DOC_SPLIT_V1 + LAB_PRINT_PICK_V1 (решение владельца 2026-11-07, п. 8) ═══
// Подтверждённые вместе анализы — отдельный документ; ещё не подтверждённые —
// свой. «Печать…» вкладки — окно с галочками (все готовые отмечены), печатаются
// отмеченные одним бланком.
const T1 = '2026-11-07T05:00:00.000Z';
const T2 = '2026-11-07T09:30:00.000Z';
const labLine = (id, name, status, verified_at) => ({ id, visit_id: 20, service_id: id, status, verified_at, visit_date: '2026-11-07',
  quantity: 1, total: 0, services: { name, is_lab: 1, type: 'lab' } });
const labRes = (id, vs, parameter, value) => ({ id, visit_service_id: vs, parameter, value, unit: '', flag: 'normal',
  entered_at: '2026-11-07T04:00:00Z', verified_at: null, verified_by: null });
function labPayload() {
  const lines = [labLine(101, 'ОАК', 'completed', T1), labLine(102, 'Биохимия', 'completed', T2), labLine(103, 'Гормоны', 'resulted', null)];
  return { ...payloadWith([]), services: lines, lab_orders: lines,
    lab_results: [labRes(1, 101, 'Лейкоциты', '6.1'), labRes(2, 102, 'Глюкоза', '5.2'), labRes(3, 103, 'ТТГ', '2.1')] };
}

test('LAB_DOC_SPLIT_V1: визит, подтверждённый в два приёма, и неподтверждённый анализ — три документа анализов', async () => {
  calls = []; opened = [];
  payload = labPayload();
  setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  openDocsTab(box);
  await tick();
  const rows = walk(box).filter((n) => n.tagName === 'TR' && textOf(n).includes('Результаты анализов'));
  assert.equal(rows.length, 3, textOf(box).slice(0, 600));
  const t = rows.map(textOf).join(' | ');
  assert.equal((t.match(/Выдан/g) || []).length, 2, t);
  assert.match(t, /Готов/);
});

test('LAB_PRINT_PICK_V1: «Печать…» — окно с готовыми документами, всё отмечено; сняли «Гормоны» — бланк без них', async () => {
  calls = []; opened = [];
  payload = labPayload();
  setFullAccess('Администратор');
  const printed = [];
  const prevOpen = globalThis.window.open;
  globalThis.window.open = () => ({ document: { open() {}, write(s) { printed.push(String(s)); }, close() {} } });
  document.body.children.length = 0;
  const prevFetch = globalThis.fetch;
  // справочник показателей бланка (/api/db) — пустой список
  globalThis.fetch = async (url, opts) => (String(url).startsWith('/api/db') ? { ok: true, status: 200, json: async () => ({ data: [] }) } : prevFetch(url, opts));
  try {
    const box = mk('div');
    renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
    await tick();
    openDocsTab(box);
    await tick();
    const btn = walk(box).find((n) => n.tagName === 'BUTTON' && n.hasAttribute('data-docs-print'));
    assert.ok(btn, 'нет кнопки «Печать…»');
    btn.click();
    await tick();
    const dlg = walk(document.body).find((n) => n.hasAttribute && n.hasAttribute('data-lab-print-pick'));
    assert.ok(dlg, 'окно выбора не открылось');
    const orderBoxes = walk(dlg).filter((n) => n.tagName === 'INPUT' && n.hasAttribute('data-pick-order'));
    assert.deepEqual(orderBoxes.map((b) => [b.getAttribute('data-pick-order'), b.checked]), [['103', true], ['102', true], ['101', true]]);
    const hormones = orderBoxes.find((b) => b.getAttribute('data-pick-order') === '103');
    hormones.checked = false;
    hormones.dispatchEvent({ type: 'change' });
    const print = walk(dlg).filter((n) => n.tagName === 'BUTTON').find((b) => textOf(b).includes('Печать'));
    print.click();
    await tick(80);
  } finally {
    globalThis.window.open = prevOpen;
    globalThis.fetch = prevFetch;
  }
  assert.equal(printed.length, 1, 'бланк не открылся одним окном');
  const html = printed[0].replace(/<style[\s\S]*?<\/style>/g, '');
  assert.ok(html.includes('Лейкоциты') && html.includes('Глюкоза'), 'отмеченные анализы — на бланке');
  assert.ok(!html.includes('ТТГ'), 'снятый анализ напечатан');
});

// Ревью S3, M-1 — услугу в очередь лаборатории ставит и отдел, и привязанная панель
// (isLabService), а флага is_lab / типа 'lab' у неё может не быть («Мазок на флору»).
// 3.21.1 печатал её результаты в документе визита; разбивка 3.22 строила документы
// только из заказов с флагом, и результаты «Мазка» не попадали ни в один документ —
// ни в строку списка, ни в окно «Печать…». Теперь они — отдельным документом визита.
test('ревью M-1: результаты анализа без флага «лабораторная» (отдел/панель) — в документе и в «Печать…», как в 3.21.1', async () => {
  const lineX = (id, name, status, verified_at, svc) => ({ id, visit_id: 20, service_id: id, status, verified_at, visit_date: '2026-11-07',
    quantity: 1, total: 0, services: { name, ...svc } });
  const lines = [lineX(101, 'ОАК', 'completed', T1, { is_lab: 1, type: 'lab' }), lineX(104, 'Мазок на флору', 'resulted', null, { is_lab: 0, type: 'other' })];
  calls = []; opened = [];
  payload = { ...payloadWith([]), services: lines, lab_orders: lines,
    lab_results: [labRes(1, 101, 'Лейкоциты', '6.1'), labRes(4, 104, 'Флора', 'кокковая')] };
  setFullAccess('Администратор');
  const printed = [];
  const prevOpen = globalThis.window.open;
  globalThis.window.open = () => ({ document: { open() {}, write(s) { printed.push(String(s)); }, close() {} }, focus() {}, print() {} });
  document.body.children.length = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('/api/db') ? { ok: true, status: 200, json: async () => ({ data: [] }) } : prevFetch(url, opts));
  try {
    const box = mk('div');
    renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
    await tick();
    openDocsTab(box);
    await tick();
    const rows = walk(box).filter((n) => n.tagName === 'TR' && textOf(n).includes('Результаты анализов'));
    assert.equal(rows.length, 2, 'ОАК (выдан) и «Мазок» — по документу: ' + rows.map(textOf).join(' | '));
    // «Печать…» — оба документа готовы и отмечены; бланк несёт и «Флору».
    walk(box).find((n) => n.tagName === 'BUTTON' && n.hasAttribute('data-docs-print')).click();
    await tick();
    const dlg = walk(document.body).find((n) => n.hasAttribute && n.hasAttribute('data-lab-print-pick'));
    assert.ok(dlg, 'окно выбора не открылось');
    const ids = walk(dlg).filter((n) => n.tagName === 'INPUT' && n.hasAttribute('data-pick-order')).map((b) => b.getAttribute('data-pick-order')).sort();
    assert.deepEqual(ids, ['101', '104']);
    walk(dlg).filter((n) => n.tagName === 'BUTTON').find((b) => textOf(b).includes('Печать')).click();
    await tick(80);
  } finally {
    globalThis.window.open = prevOpen;
    globalThis.fetch = prevFetch;
  }
  assert.equal(printed.length, 1);
  const html = printed[0].replace(/<style[\s\S]*?<\/style>/g, '');
  assert.ok(html.includes('Лейкоциты'), 'ОАК на бланке');
  assert.ok(html.includes('Флора'), 'результат «Мазка» пропал с бланка');
});

// Ревью S3, L-3 — бланк анализов из карты пациента печатал lab_results.value как
// записано: строки до 3.22 — полными (7.2549), хотя лаборатория и раздел
// «Документы» показывают 7.25; при выключенной настройке строки, записанные при
// включённой, — округлёнными. Теперь — то же правило (shared/lab-round.js labShownValue).
async function printCardLab(lab_results, round) {
  const lines = [labLine(101, 'ОАК', 'completed', T1)];
  calls = []; opened = [];
  payload = { ...payloadWith([]), services: lines, lab_orders: lines, lab_results };
  setFullAccess('Администратор');
  const printed = [];
  const prevOpen = globalThis.window.open;
  globalThis.window.open = () => ({ document: { open() {}, write(s) { printed.push(String(s)); }, close() {} }, focus() {}, print() {} });
  document.body.children.length = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith('/api/db')) return prevFetch(url, opts);
    const b = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ data: b.table === 'doc_settings' ? { lab_round_analyzer: round } : [] }) };
  };
  try {
    const box = mk('div');
    renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
    await tick();
    openDocsTab(box);
    await tick();
    walk(box).find((n) => n.tagName === 'BUTTON' && n.hasAttribute('data-docs-print')).click();
    await tick();
    const dlg = walk(document.body).find((n) => n.hasAttribute && n.hasAttribute('data-lab-print-pick'));
    walk(dlg).filter((n) => n.tagName === 'BUTTON').find((b) => textOf(b).includes('Печать')).click();
    await tick(80);
  } finally {
    globalThis.window.open = prevOpen;
    globalThis.fetch = prevFetch;
  }
  assert.equal(printed.length, 1);
  return printed[0].replace(/<style[\s\S]*?<\/style>/g, '');
}
const anRes = (id, parameter, value, raw_value, source = 'analyzer') => ({ ...labRes(id, 101, parameter, value), raw_value, source });

test('ревью L-3: бланк из карты — значение прибора по настройке округления, ручной ввод — как набран', async () => {
  const on = await printCardLab([anRes(1, 'Лейкоциты', '7.2549', null), anRes(2, 'Гемоглобин', '4.1567', '7.2549'), anRes(3, 'СОЭ', '12.345', null, 'manual')], 1);
  assert.ok(on.includes('7.25') && !on.includes('7.2549'), 'строка до 3.22 при включённой — 7.25');
  assert.ok(on.includes('4.1567'), 'набранное поверх значения прибора — как набрано (L-1)');
  assert.ok(on.includes('12.345'), 'ручной ввод — как набран');
  const off = await printCardLab([anRes(1, 'Лейкоциты', '7.25', '7.2549')], 0);
  assert.ok(off.includes('7.2549'), 'выключено — полное значение прибора');
});
