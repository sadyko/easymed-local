// LAB_ROUND_V1 (решение владельца 2026-11-07, п. 6) — экраны лаборатории
// показывают значение прибора по настройке клиники «Округлять результаты
// анализаторов до 2 знаков»: включена — до 2 знаков, выключена — полное
// (lab_results.raw_value); ручной ввод — как набран. Карточка настройки — во
// вкладке «Анализаторы». Поддельный DOM и /api/db — из lab-tube-label.test.mjs.
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
  open: () => { opened++; return { document: { write(s) { printed.push(String(s)); }, close() {} } }; },
};
globalThis.confirm = () => false;
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
let DOC_SETTINGS = [{ id: 1, lab_scope: 'clinic', lab_round_analyzer: 1 }];   // LAB_ROUND_V1      // К4 — номера строк «услуга возвращена» (rpc refunded_lines)
function statusFilter(body) {
  for (const f of (body && body.filters) || []) if (f && f.col === 'status') return f;
  return null;
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    let rows = {
      visit_services: VISIT_SERVICES, visits: VISITS, lab_results: LAB_RESULTS, admissions: [],
      lab_panels: LAB_PANELS, lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [], doc_settings: DOC_SETTINGS,
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    const out = body && body.single ? (rows[0] || null) : rows;   // LAB_ROUND_V1 — .single() отдаёт строку, как сервер
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(out)) }) };
  }
  if (u.startsWith('/api/rpc/refunded_lines')) return { ok: true, json: async () => ({ data: { line_ids: REFUNDED } }) };
  return { ok: true, json: async () => ({ data: null }) };
};


const { renderLaboratory } = await import('../views/laboratory.js');
const { mountRoundCard } = await import('../views/lab-round-card.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

const BLOOD = { name: 'Анализ крови', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const line = (id, status) => ({ id, visit_id: 20, service_id: 40, status, sync_origin: null, created_at: TODAY_NOON, scheduled_at: null, sample_collected_at: null, services: BLOOD });
const RESULTS = () => [
  { id: 1, visit_service_id: 28, parameter: 'Лейкоциты', value: '4.15', raw_value: '4.152122', source: 'analyzer', unit: '', flag: 'normal', notes: null, entered_at: TODAY_NOON },
];

async function queueText(roundSetting, results = RESULTS()) {
  DOC_SETTINGS = [{ id: 1, lab_scope: 'clinic', lab_round_analyzer: roundSetting }];
  VISIT_SERVICES = [line(28, 'resulted')];
  LAB_PANELS = [];
  LAB_RESULTS = results;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  return textOf(root);
}

test('настройка включена (по умолчанию): карточка очереди — 4.15', async () => {
  const t = await queueText(1);
  assert.ok(t.includes('4.15'), t.slice(0, 400));
  assert.ok(!t.includes('4.152122'));
});

test('настройка выключена: карточка очереди — полное значение прибора 4.152122', async () => {
  const t = await queueText(0);
  assert.ok(t.includes('4.152122'), t.slice(0, 400));
});

test('записано полным (до обновления), настройка включена — показ 4.15; ручной ввод — как набран при любой настройке', async () => {
  const old = [{ id: 1, visit_service_id: 28, parameter: 'Лейкоциты', value: '4.152122', raw_value: null, source: 'analyzer', unit: '', flag: 'normal', notes: null, entered_at: TODAY_NOON }];
  assert.ok((await queueText(1, old)).includes('4.15'));
  assert.ok(!(await queueText(1, old)).includes('4.152122'));
  const manual = [{ ...old[0], source: 'manual' }];
  assert.ok((await queueText(1, manual)).includes('4.152122'), 'набранное руками не округляется');
});

test('карточка «Результаты анализаторов»: галочка по настройке; администратор меняет — пишется в doc_settings', async () => {
  const writes = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (String(url).startsWith('/api/db') && body && body.table === 'doc_settings' && body.op === 'update') writes.push(body);
    return saved(url, opts);
  };
  const user = window.easymed.state.user;
  window.easymed.state.user = { id: 'u-1', role: 'admin' };
  try {
    DOC_SETTINGS = [{ id: 1, lab_round_analyzer: 1 }];
    const card = mk('div');
    assert.equal(await mountRoundCard(card), true);
    const box = walk(card).find((n) => n.tagName === 'INPUT');
    assert.ok(box.checked, 'по умолчанию галочка стоит');
    assert.ok(!box.disabled);
    assert.ok(textOf(card).includes('Округлять результаты анализаторов до 2 знаков'));
    box.checked = false;
    box.dispatchEvent({ type: 'change' });
    await tick();
    assert.equal(writes.length, 1, 'настройка не записана');
    assert.deepEqual(writes[0].values || writes[0].patch || writes[0].data || writes[0].body, { lab_round_analyzer: 0 });
    // Не администратор — видит, как настроено, но не меняет.
    window.easymed.state.user = { id: 'u-2', role: 'lab' };
    DOC_SETTINGS = [{ id: 1, lab_round_analyzer: 0 }];
    const card2 = mk('div');
    assert.equal(await mountRoundCard(card2), false);
    const box2 = walk(card2).find((n) => n.tagName === 'INPUT');
    assert.ok(!box2.checked);
    assert.ok(box2.disabled);
    assert.ok(textOf(card2).includes('Изменить может администратор.'));
  } finally {
    globalThis.fetch = saved;
    window.easymed.state.user = user;
  }
});
