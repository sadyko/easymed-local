// LAB_DOC_SPLIT_V1 (решение владельца 2026-11-07, п. 8) — в карточке лаборатории
// анализы отмечаются галочкой: «Подтвердить» подтверждает, «Бланк» печатает только
// отмеченные; подтверждённые вместе уходят отдельным документом. Раздел «Документы»
// печатает через окно выбора (LAB_PRINT_PICK_V1). Поддельный DOM и /api/db — из
// lab-tube-label.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';

// Время на этикетке — местное. На Windows Node понимает только имя IANA
// («UZT-5» молча читается как UTC) — пояс задаётся до первого Date.
process.env.TZ = 'Asia/Tashkent';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
const fakeBody = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:fakeBody,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида

// Окно печати этикеток: сколько открыто и что в него написано.
let printed = [];
let opened = 0;
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
  open: () => { opened++; return { document: { open() {}, write(s) { printed.push(String(s)); }, close() {} } }; },
};
globalThis.confirm = () => true;   // LAB_DOC_SPLIT_V1 — «Подтвердить» спрашивает
globalThis.alert = (m) => { throw new Error('alert: ' + m); };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async () => {} } },
});

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clean = (b) => textOf(b).replace(/<[^>]*>/g, '').trim();

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- поддельный /api/db ------------------------------------------------------
const PATIENT = { id: 'p-20', full_name: 'Тестов Пациент Тестович', mrn: 'P-26-00020', gender: 'female', date_of_birth: '1990-02-03' };
// Ревью U11, L6 — визит и строки заведены СЕГОДНЯ (местный полдень): пробирку старше
// 7 дней карточка не печатает, и тест с днём, вписанным в код, через неделю
// перестал бы печатать вовсе. Время забора (19:06) — по-прежнему своё, 2 ноября.
const TODAY_NOON = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.toISOString(); })();
const daysAgoNoon = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.toISOString(); };
const VISITS = [{ id: 20, visit_date: TODAY_NOON, patients: PATIENT }];
let VISIT_SERVICES = [];
let LAB_PANELS = [];
let LAB_RESULTS = [];   // К4 — результат у возвращённой строки
let REFUNDED = [];
const writes = [];      // К4 — номера строк «услуга возвращена» (rpc refunded_lines)
function statusFilter(body) {
  for (const f of (body && body.filters) || []) if (f && f.col === 'status') return f;
  return null;
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op === 'update') writes.push(body);   // LAB_DOC_SPLIT_V1
    const table = body && body.table;
    let rows = {
      visit_services: VISIT_SERVICES, visits: VISITS, lab_results: LAB_RESULTS, admissions: [],
      lab_panels: LAB_PANELS, lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [], doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/refunded_lines')) return { ok: true, json: async () => ({ data: { line_ids: REFUNDED } }) };
  return { ok: true, json: async () => ({ data: null }) };
};


const { renderLaboratory } = await import('../views/laboratory.js');
const { setFullAccess } = await import('../permissions.js');
const { labPrintDocs } = await import('../views/patient-documents.js');
const { openLabPrintPick } = await import('../views/lab-print-pick.js');
setFullAccess(true);

const BLOOD = { name: 'Анализ крови', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const URINE = { name: 'Анализ мочи', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const line = (id, svc, status = 'resulted') => ({ id, visit_id: 20, service_id: svc === BLOOD ? 40 : 41, status, sync_origin: null,
  created_at: TODAY_NOON, scheduled_at: null, sample_collected_at: null, services: svc });
const res = (id, vs, parameter, value) => ({ id, visit_service_id: vs, parameter, value, unit: '', flag: 'normal', notes: null, entered_at: TODAY_NOON });

async function card() {
  VISIT_SERVICES = [line(29, URINE), line(28, BLOOD)];
  LAB_PANELS = [];
  LAB_RESULTS = [res(1, 28, 'Лейкоциты', '6.1'), res(2, 29, 'Белок', '0.1')];
  printed = []; opened = 0; writes.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  return root;
}
const pickOf = (root, id) => walk(root).find((n) => n.tagName === 'INPUT' && n.getAttribute('data-pick') === String(id));
const actBtn = (root, label) => buttons(byClass(byClass(root, 'lq-card')[0], 'lq-do')[0]).find((b) => clean(b) === label);

test('галочки есть у анализов с результатом и «Отметить все» у карточки', async () => {
  const root = await card();
  assert.ok(pickOf(root, 28) && pickOf(root, 29));
  assert.ok(byClass(root, 'lq-pick-all').length === 1);
});

test('отметили один анализ — «Подтвердить» подтверждает только его (одна отметка — отдельный документ)', async () => {
  const root = await card();
  const box = pickOf(root, 28);
  box.checked = true;
  box.dispatchEvent({ type: 'change' });
  await tick();
  actBtn(root, 'Подтвердить').click();
  await tick(120);
  const vs = writes.filter((w) => w.table === 'visit_services');
  assert.equal(vs.length, 1, JSON.stringify(writes));
  assert.equal(vs[0].values.status, 'completed');
  assert.deepEqual(vs[0].filters.filter((f) => f.col === 'id').map((f) => f.val), [28], JSON.stringify(vs[0]));
});

test('ничего не отмечено — «Подтвердить» подтверждает все, как прежде', async () => {
  const root = await card();
  actBtn(root, 'Подтвердить').click();
  await tick(120);
  assert.equal(writes.filter((w) => w.table === 'visit_services').length, 2);
});

test('отметили один анализ — «Бланк» печатает только его', async () => {
  const root = await card();
  const box = pickOf(root, 29);
  box.checked = true;
  box.dispatchEvent({ type: 'change' });
  await tick();
  actBtn(root, 'Бланк').click();
  await tick(120);
  const html = printed.join('');
  assert.ok(html.includes('Белок'), 'отмеченный анализ не напечатан');
  assert.ok(!html.includes('Лейкоциты'), 'неотмеченный анализ напечатан');
});

test('«Документы»: визит, подтверждённый в два приёма, — два документа в окне печати; внесённые не полностью — не предлагаются', () => {
  const r = (vsId, name, orderStatus, orderVerifiedAt) => ({ vsId, panelName: name, orderStatus, orderVerifiedAt, testName: name });
  const docs = labPrintDocs({ id: 20 }, [
    r(101, 'ОАК', 'completed', '2026-11-07T05:00:00.000Z'), r(102, 'Биохимия', 'completed', '2026-11-07T09:00:00.000Z'),
    r(103, 'Гормоны', 'resulted', null),
  ]);
  assert.deepEqual(docs.map((d) => d.orders.map((o) => o.name)), [['ОАК'], ['Биохимия'], ['Гормоны']]);
  assert.match(docs[0].title, /выдан/);
  assert.match(docs[2].title, /не подтверждены/);
});

test('окно выбора: снятая галочка документа снимает его анализы; «Печать» отдаёт отмеченные', async () => {
  fakeBody.children.length = 0;
  let got = null;
  const dlg = openLabPrintPick({ docs: [
    { key: 'a', title: 'Документ 1', orders: [{ id: 1, name: 'ОАК' }, { id: 2, name: 'СОЭ' }] },
    { key: 'b', title: 'Документ 2', orders: [{ id: 3, name: 'ТТГ' }] },
  ], onPrint: (ids) => { got = ids; } });
  assert.ok(dlg);
  const docBox = walk(dlg).find((n) => n.getAttribute && n.getAttribute('data-pick-doc') === 'a');
  docBox.checked = false;
  docBox.dispatchEvent({ type: 'change' });
  walk(dlg).filter((n) => n.tagName === 'BUTTON').find((b) => textOf(b).includes('Печать')).click();
  assert.deepEqual(got, [3]);
  assert.equal(openLabPrintPick({ docs: [] }), null, 'печатать нечего — окна нет');
});
