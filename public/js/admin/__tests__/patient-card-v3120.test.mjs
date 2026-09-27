// V3120_FIX (2026-09-27) — карта пациента после инспекции v3.12.0.
//
//   * «Баланс счёта»: отказ сервера в deposit_balance НЕ рисуется как
//     «Депозит 0 сум». Ноль — это ответ «денег нет», а отказ — «вам не видно»;
//     регистратура повторит пациенту то, что увидит.
//   * «Госпитализация» в шапке карты — только тем, кому сервер оформит заявку
//     (inpatient.requests / ORDER_CREATE_ROLES). Кнопка, ведущая в отказ, хуже
//     отсутствующей: её нажимают снова, потом звонят.

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

// --- транспорт: считаем ВСЕ обращения, чтобы поймать вторую дверь ----------
const PATIENT = {
  id: 1, mrn: 'MRN-1', full_name: 'Эргашев Жахонгир', gender: 'male',
  date_of_birth: '1990-04-01', phone: '+998901112233', address: 'ул. Тестовая 1',
  allergies: '', chronic_conditions: '', notes: 'аккуратен', active: 1,
};
const VISIT = { id: 11, patient_id: 1, visit_date: '2026-08-12T09:00:00Z', status: 'completed', visit_type: 'приём',
  doctor: { id: 3, full_name: 'Пулатов А.' }, patients: { id: 1, full_name: PATIENT.full_name, mrn: 'MRN-1' } };
const SERVICE_ROW = { id: 21, visit_id: 11, service_id: 5, doctor_id: 3, quantity: 1, unit_price: 50000, total: 50000,
  status: 'added', invoice_item_id: 31, scheduled_at: null, visit_date: '2026-08-12T09:00:00Z',
  services: { name: 'ОАК', is_lab: 1, type: 'lab' }, users: { full_name: 'Пулатов А.' } };
// HOLDINGS_FIRST_V1 — ТОВАРНАЯ СТРОКА. Списанный на пациента бинт — такая же
// строка визита, только с clinic_item_id вместо услуги, и вкладка «Услуги»
// показывает её наравне с услугами. До этой правки она была безымянной («—»),
// предлагала «Заменить услугу» и молчала о том, куда вернулся товар.
const PRODUCT_ROW = { id: 22, visit_id: 11, service_id: null, clinic_item_id: 3, doctor_id: null,
  quantity: 3, unit_price: 2000, total: 6000, status: 'added', invoice_item_id: null,
  scheduled_at: null, visit_date: '2026-08-12T09:10:00Z',
  services: { name: null }, products: { name: 'Бинт', unit: 'шт' }, users: null };
const INVOICE = { id: 41, patient_id: 1, invoice_number: 'INV-A-26-00001', total_amount: 50000, paid_amount: 20000,
  status: 'partial', created_at: '2026-08-12T09:30:00Z' };

// Полный ответ сервера: все вкладки открыты.
function fullPayload() {
  return {
    tabs: { services: 'delete', labs: 'view', docs: 'delete', history: 'view', billing: 'view', visits: 'edit', details: 'edit' },
    caps: { services: { edit: true, del: true }, labs: { edit: false, del: false }, docs: { edit: true, del: true }, history: { edit: false, del: false },
            billing: { edit: false, del: false }, visits: { edit: true, del: false }, details: { edit: true, del: false } },
    patient: { ...PATIENT }, patient_limited: false, payer_name: 'Наличные',
    visits: [VISIT], visit_count: 1, last_visit_date: VISIT.visit_date,
    services: [SERVICE_ROW], lab_orders: [SERVICE_ROW],
    lab_results: [{ id: 51, visit_service_id: 21, parameter: 'HGB', value: '140', entered_at: '2026-08-12T11:00:00Z' }],
    invoices: [INVOICE], invoice_items: [{ id: 31, invoice_id: 41, description: 'ОАК', quantity: 1, total: 50000, services: { name: 'ОАК' }, doctor_name: 'Пулатов А.' }],
    payments: [{ invoice_id: 41, amount: 20000, method: 'cash', paid_at: '2026-08-12T10:00:00Z' }],
    docs: [{ id: 61, title: 'Заключение', doc_type: 'protocol', created_at: '2026-08-12T12:00:00Z', body: {} }],
    doc_notes: [],
  };
}

// Роль, которой оставили только «Визиты» и «Услуги» — та самая настройка из
// проверки владельца: регистратура ведёт запись и услуги и не видит ни денег,
// ни анализов, ни документов, ни анкеты.
function visitsAndServicesOnly() {
  const p = fullPayload();
  p.tabs = { services: 'edit', labs: 'none', docs: 'none', history: 'none', billing: 'none', visits: 'edit', details: 'none' };
  p.patient = { id: 1, mrn: 'MRN-1', full_name: PATIENT.full_name, gender: 'male', date_of_birth: '1990-04-01', active: 1 };
  p.patient_limited = true;
  p.payer_name = null;
  p.labs = null; p.lab_orders = null; p.lab_results = null;
  p.docs = null; p.doc_notes = null;
  p.invoices = null; p.invoice_items = null; p.payments = null;
  return p;
}

let dbCalls = [];
let rpcCalls = [];
let payload = fullPayload();
// Ответы прочих RPC — по имени: «Убрать» обязан РАССКАЗАТЬ, куда вернулся
// товар, а рассказывает он это из ответа сервера (sources).
let rpcAnswers = {};
// V3120_FIX — отказ сервера по имени RPC: { status, error: { code, message } }.
let rpcErrors = {};
const rpcBodies = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (p) => ({ ok: true, status: 200, json: async () => p });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    rpcBodies.push([name, body]);   // V3120_FIX — аргументы вызова
    if (name === 'patient_card') return ok({ data: JSON.parse(JSON.stringify(payload)) });
    if (Object.prototype.hasOwnProperty.call(rpcErrors, name)) { const e = rpcErrors[name]; return { ok: false, status: e.status, json: async () => ({ error: e.error }) }; }
    if (Object.prototype.hasOwnProperty.call(rpcAnswers, name)) return ok({ data: rpcAnswers[name] });
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    dbCalls.push((body && body.table) || '?');
    return ok({ data: [], count: 0 });
  }
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const { renderPatientCard } = await import('../views/patient-card.js');
const { setFullAccess, setEffectiveFromRole } = await import('../permissions.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const titles = (root) => buttons(root).map((b) => b.attrs.title || '').filter(Boolean);

// Полоса вкладок — первая карточка с шестью подписями вкладок.
const TAB_LABELS = ['Услуги', 'Лаборатория', 'Документы', 'История', 'Счёт', 'Визиты', 'Деталь'];   // PATIENT_HISTORY_TAB_V1
const labelOfTab = (b) => walk(b).map((n) => (n._t || '').trim()).find((t) => TAB_LABELS.includes(t)) || null;
function tabBar(root) {
  return buttons(root).filter((b) => labelOfTab(b) !== null);
}
const openTab = (root, label) => { const b = tabBar(root).find((x) => labelOfTab(x) === label); assert.ok(b, 'нет вкладки ' + label); b.click(); };

// Подтверждение — ЧАСТЬ ПОВЕДЕНИЯ, а не украшение: в нём человек читает, что
// именно он убирает. Поэтому стенд его запоминает, а не проглатывает.
const confirms = [];
globalThis.confirm = (msg) => { confirms.push(String(msg)); return true; };
globalThis.window.confirm = globalThis.confirm;
// Сообщение toast снимается В МОМЕНТ ЗАПИСИ: ui.js toast() кладёт текст в
// textContent, а следующей строкой пишет в el._t дескриптор таймера — то же
// поле, в котором стенд держит текст. Со страницы его потом уже не прочитать.
const toasts = [];
{
  const d = Object.getOwnPropertyDescriptor(F.prototype, 'textContent');
  Object.defineProperty(F.prototype, 'textContent', {
    configurable: true, get: d.get,
    set(v) { if (this.attrs && this.attrs.id === 'toast') toasts.push(String(v)); d.set.call(this, v); },
  });
}
const lastToast = () => (toasts.length ? toasts[toasts.length - 1] : '');

async function render(p, roleRow) {
  dbCalls = []; rpcCalls = [];
  payload = p;
  if (roleRow) setEffectiveFromRole(roleRow); else setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  return box;
}


const modalText = () => textOf(document.body);
const findBtnByText = (root, s) => buttons(root).find((b) => textOf(b).includes(s));

test('V3120_FIX: отказ в депозите не рисуется нулём — «нет доступа», а не «0 сум»', async () => {
  document.body.children.length = 0;
  rpcErrors = { deposit_balance: { status: 403, error: { code: 'forbidden', message: 'Your role is not allowed to perform this action.' } } };
  const box = await render(fullPayload());
  const cell = findBtnByText(box, 'Баланс счёта');
  assert.ok(cell, 'нет ячейки «Баланс счёта»');
  cell.click();
  await tick();
  const t = modalText();
  assert.ok(t.includes('Депозит'), 'окно баланса не открылось или строки депозита нет');
  assert.ok(t.includes('нет доступа'), 'отказ сервера не назван: ' + t.slice(0, 300));
  assert.ok(!/Депозит \(предоплата\):\s*0/.test(t), 'отказ нарисован как «Депозит 0 сум»');
  assert.ok(!findBtnByText(document.body, 'Внести депозит'), 'кнопка взноса предлагается тому, кому депозиты закрыты');
  rpcErrors = {};
});

test('V3120_FIX: читаемый депозит показывается как прежде — с суммой и кнопкой взноса', async () => {
  document.body.children.length = 0;
  rpcErrors = {};
  rpcAnswers = { deposit_balance: { balance: 150000, rows: [] } };
  const box = await render(fullPayload());
  findBtnByText(box, 'Баланс счёта').click();
  await tick();
  const t = modalText();
  assert.ok(t.includes('150 000') || t.includes('150 000') || t.includes('150,000'), 'сумма депозита не видна: ' + t.slice(0, 300));
  assert.ok(findBtnByText(document.body, 'Внести депозит'), 'кнопка взноса пропала у того, кому депозит открыт');
  rpcAnswers = {};
});

test('V3120_FIX: «Госпитализация» в шапке карты — только тем, кому сервер оформит заявку', async () => {
  const perms = await import('../permissions.js');
  const roleCases = [
    ['nurse', false], ['lab', false], ['cashier', false],
    ['registrar', true], ['doctor', true],
  ];
  for (const [role, want] of roleCases) {
    globalThis.window.easymed.state.user = { id: 7, full_name: 'Сотрудник', role };
    const box = await render(fullPayload(), { name: role, permissions: { sections: ['patients'], levels: { patients: 'editor' } } });
    const has = !!findBtnByText(box, 'Госпитализация');
    assert.equal(has, want, role + ': кнопка «Госпитализация» ' + (want ? 'пропала' : 'показана, а сервер откажет'));
  }
  // Настроенный в «Ролях» ключ решает сам, как у сервера (requireGrant).
  globalThis.window.easymed.state.user = { id: 7, full_name: 'Сотрудник', role: 'nurse' };
  const granted = await render(fullPayload(), { name: 'nurse', permissions: { sections: ['patients'], levels: { patients: 'editor' }, grants: { 'inpatient.requests': 'edit' } } });
  assert.ok(findBtnByText(granted, 'Госпитализация'), 'выданное в «Ролях» право на заявку не открыло кнопку');
  globalThis.window.easymed.state.user = { id: 7, full_name: 'Регистратор', role: 'registrar' };
  perms.setFullAccess('Администратор');
});

test('V3120_FIX: история болезни (обзор и документы) закрыта роли, которой сервер её не отдаёт', async () => {
  const perms = await import('../permissions.js');
  const beds = { sections: ['patients', 'beds'], levels: { patients: 'editor', beds: 'editor' } };
  try {
    globalThis.window.easymed.state.user = { id: 7, full_name: 'Регистратор', role: 'registrar' };
    perms.setEffectiveFromRole({ name: 'registrar', permissions: beds });
    assert.equal(perms.isRouteAllowed('admissions'), true, 'тест подобран неверно: раздел «Стационар» регистратуре закрыт');
    assert.equal(perms.isRouteAllowed('case-overview'), false, 'регистратуру пускают в обзор, а сервер откажет (admission_overview)');
    assert.equal(perms.isRouteAllowed('case-file'), false, 'регистратуру пускают в документы истории, а сервер откажет (admission_case_docs)');
    globalThis.window.easymed.state.user = { id: 7, full_name: 'Медсестра', role: 'nurse' };
    perms.setEffectiveFromRole({ name: 'nurse', permissions: beds });
    assert.equal(perms.isRouteAllowed('case-overview'), true, 'медсестре закрыли историю болезни');
    // Настроенный уровень решает сам.
    globalThis.window.easymed.state.user = { id: 7, full_name: 'Регистратор', role: 'registrar' };
    perms.setEffectiveFromRole({ name: 'registrar', permissions: { ...beds, grants: { 'inpatient.patients': 'view' } } });
    assert.equal(perms.isRouteAllowed('case-overview'), true, 'выданное в «Ролях» право не открыло обзор');
  } finally {
    globalThis.window.easymed.state.user = { id: 7, full_name: 'Регистратор', role: 'registrar' };
    perms.setFullAccess('Администратор');
  }
});

test('V3120_FIX: окно депозита шлёт idempotency_key — один на окно, тот же при повторе', async () => {
  document.body.children.length = 0;
  rpcErrors = {};
  rpcAnswers = { deposit_balance: { balance: 0, rows: [] } };
  const box = await render(fullPayload());
  findBtnByText(box, 'Баланс счёта').click();
  await tick();
  findBtnByText(document.body, 'Внести депозит').click();
  await tick();
  const amount = walk(document.body).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'number');
  assert.ok(amount, 'в окне депозита нет поля суммы');
  amount.value = '50000';
  // первый раз сервер отказывает (обрыв), второй — принимает: ключ обязан совпасть
  rpcErrors = { create_deposit: { status: 500, error: { code: 'internal', message: 'обрыв' } } };
  const send = findBtnByText(document.body, 'Отправить в кассу');
  send.click(); await tick();
  rpcErrors = {};
  rpcAnswers = { ...rpcAnswers, create_deposit: { deposit: { deposit_number: 'DEP-1', amount: 50000, status: 'pending' } } };
  send.click(); await tick();
  const calls = rpcBodies.filter(([n]) => n === 'create_deposit').map(([, b]) => b);
  assert.equal(calls.length, 2, 'create_deposit вызван не дважды');
  const k = calls[0].idempotency_key;
  assert.match(String(k), /^[A-Za-z0-9_-]{8,80}$/, 'ключ не по формату сервера: ' + k);
  assert.equal(calls[1].idempotency_key, k, 'повтор из того же окна пришёл с другим ключом — сервер заведёт второй депозит');
  rpcAnswers = {};
});
