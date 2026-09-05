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
