// CABINET_REDESIGN_V1 (2026-09-11) — вкладка «Зарплата» кабинета врача.
//
// Владелец: «#consultation/pay please redesign this … for the doctor».
// Что здесь закреплено:
//   1. ЧИСЛА — ТЕ ЖЕ. Плитка «Зарплата» показывает долю врача по формуле
//      отчёта (serviceShare), и график по дням складывается в то же число:
//      график — это разложенная по дням плитка, а не вторая арифметика;
//   2. ГРАФИК ЕСТЬ и он из двух рядов (услуги + направления), с быстрыми
//      действиями «Разбор зарплаты» / «Разбор направлений» в своей шапке;
//   3. ВРАЧ ПОД СВОИМ ВХОДОМ НЕ ВЫБИРАЕТ ВРАЧА: списка из одного имени нет;
//   4. КАРТОЧКИ С ШАПКАМИ — «Как считается зарплата» и «по категориям» стоят
//      в системной карточке, а не в самодельной рамке;
//   5. НИ ОДНОГО АНГЛИЙСКОГО СЛОВА на русской вкладке.
import { test } from 'node:test';
import assert from 'node:assert';

// --- fake DOM (тот же харнесс, что у head-doctor-cabinet.test.mjs) ----------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;}
 appendChild(c){this.children.push(c);return c;} append(...c){for(const x of c)this.appendChild(x);} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;} removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){}
 _desc(o=[]){for(const c of this.children||[]){o.push(c);if(c._desc)c._desc(o);}return o;}
 _sel(n,s){ if(s[0]==='#')return (n.attrs&&n.attrs.id)===s.slice(1);
            if(s[0]==='.')return String(n.className||'').split(/\s+/).includes(s.slice(1));
            return String(n.tagName||'').toLowerCase()===s.toLowerCase(); }
 querySelector(s){return this._desc().find((n)=>this._sel(n,s))||null;}
 querySelectorAll(s){return this._desc().filter((n)=>this._sel(n,s));}
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
const styleEls = new Map();
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return styleEls.get(id) || null; },
};
function makeLocalStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null),
           setItem: (k, v) => { store.set(k, String(v)); },
           removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: null } },
  confirm: () => true,
  easymedSetTabSub: () => {},
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
// toLocaleString('ru-RU') разделяет тысячи узким неразрывным пробелом — в
// проверках он приводится к обычному, чтобы «80 000» читалось как написано.
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ').replace(/[  ]/g, ' ');
const byClass = (root, c) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(c));
const buttonByText = (root, re) => walk(root).filter((n) => n.tagName === 'BUTTON').find((b) => re.test(textOf(b)));
const chartSvgs = (root) => walk(root).filter((n) => n.tagName === 'SVG' && /<svg class="dc"/.test(n._t || ''));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// ПОСЕВ. Один врач на проценте: 40 % от услуги s-1 (налог 0). Две завершённые
// услуги по 100 000 — сегодня и вчера — и одно дошедшее направление за 50 000.
// ---------------------------------------------------------------------------
const DOC = { id: 'u-doc', full_name: 'Каримова Азиза', specialty: 'Терапевт', is_doctor: true, active: true, role: 'doctor',
              salary_type: 'percentage', salary_fixed: 0, service_rates: [{ service_id: 's-1', percentage: 40 }], kpi_links: [], rooms: null };
const P1 = { id: 'p-1', mrn: 'MRN-001', full_name: 'Иванов Пётр', last_name: 'Иванов', first_name: 'Пётр' };
const now = new Date();
const yesterday = new Date(now.getTime() - 86400000);
const SVC = { name: 'Приём', tax_rate: 0, type_id: null, category_id: null, service_categories: null, service_types: null };
const VISIT_SERVICES = [
  { id: 'sv-1', visit_id: 'v-1', doctor_id: 'u-doc', service_id: 's-1', status: 'completed', quantity: 1,
    unit_price: 100000, total: 100000, invoice_item_id: null, created_at: now.toISOString(),
    services: SVC, visits: { visit_date: now.toISOString(), patient_id: 'p-1', patients: P1 } },
  { id: 'sv-2', visit_id: 'v-2', doctor_id: 'u-doc', service_id: 's-1', status: 'completed', quantity: 1,
    unit_price: 100000, total: 100000, invoice_item_id: null, created_at: yesterday.toISOString(),
    services: SVC, visits: { visit_date: yesterday.toISOString(), patient_id: 'p-1', patients: P1 } },
];
const REFERRALS = [
  { id: 'r-1', status: 'done', notes: '', created_at: now.toISOString(), closed_at: now.toISOString(), recommended_by: 'u-doc',
    service_id: 's-2', service_name: 'УЗИ', patient_id: 'p-1',
    services: { name: 'УЗИ', price: 50000, tax_rate: 0, type_id: null, category_id: null, service_categories: null, service_types: null },
    patients: P1 },
];

function matches(row, f) {
  if (f.or) return true;
  const v = row[f.col];
  switch (f.op) {
    case 'eq':  return String(v) === String(f.val);
    case 'neq': return String(v) !== String(f.val);
    case 'is':  return f.val === null ? (v === null || v === undefined) : v === f.val;
    case 'in':  return (f.val || []).map(String).includes(String(v));
    case 'gte': return String(v) >= String(f.val);
    case 'gt':  return String(v) >  String(f.val);
    case 'lte': return String(v) <= String(f.val);
    case 'lt':  return String(v) <  String(f.val);
    default:    return true;
  }
}
const TABLES = () => ({
  users: [DOC], visits: [], visit_services: VISIT_SERVICES,
  invoice_items: [], invoices: [], recommended_services: REFERRALS,
  referral_sources: [], referral_source_categories: [], admissions: [],
});
let dbCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) return { ok: true, json: async () => ({ data: null }) };
  if (u.startsWith('/api/db')) {
    dbCalls.push(body);
    let rows = TABLES()[body.table] || [];
    for (const f of (body.filters || [])) rows = rows.filter((r) => matches(r, f));
    if (body.limit) rows = rows.slice(0, body.limit);
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderConsultation } = await import('../views/consultation.js');
const dash = await import('../views/doctor-dashboard.js');
const perms = await import('../permissions.js');
perms.setFullAccess('test');

async function openPay() {
  dbCalls = [];
  dash.resetDoctorDashboard();
  window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: { sub: 'pay' } });
  await tick(80);
  return host;
}

test('плитка «Зарплата» показывает долю врача по формуле отчёта, и график по дням складывается в то же число', async () => {
  const host = await openPay();
  const tiles = byClass(host, 'dash-kpi');
  assert.strictEqual(tiles.length, 4, 'плиток: ' + tiles.length);
  const salary = tiles.find((t) => textOf(t).includes('Зарплата'));
  assert.ok(salary, 'нет плитки «Зарплата»');
  // 40 % от 200 000 при нулевом налоге — 80 000.
  assert.ok(textOf(salary).includes('80 000'), 'доля врача не сошлась: ' + textOf(salary));
  const rewards = tiles.find((t) => textOf(t).includes('Вознаграждения за направления'));
  assert.ok(rewards, 'нет плитки вознаграждений');
  assert.ok(textOf(rewards).includes('отправлено направлений: 1'), 'направление не посчитано: ' + textOf(rewards));

  const card = byClass(host, 'card').find((c) => textOf(c).includes('Начисления по дням'));
  assert.ok(card, 'нет карточки «Начисления по дням»');
  const svg = chartSvgs(card)[0];
  assert.ok(svg, 'в карточке нет графика');
  assert.strictEqual((svg._t.match(/<linearGradient/g) || []).length, 2, 'ряда должно быть два: услуги и направления');
  // Подсказка последнего дня называет сегодняшнюю долю: одна услуга — 40 000.
  const chart = byClass(card, 'dash-chart')[0];
  chart.getBoundingClientRect = () => ({ left: 0, width: 640, height: 240 });
  chart.dispatchEvent({ type: 'mousemove', clientX: 700 });
  const tip = byClass(chart, 'dash-chart-tip')[0];
  assert.ok(tip && !tip.hidden, 'подсказка не показалась');
  assert.ok(textOf(tip).includes('40 000'), 'подсказка дня не сходится с долей: ' + textOf(tip));
});

test('быстрые действия стоят в шапке графика и открывают разборы', async () => {
  const host = await openPay();
  const card = byClass(host, 'card').find((c) => textOf(c).includes('Начисления по дням'));
  const acts = byClass(card, 'dash-act');
  assert.strictEqual(acts.length, 2, 'быстрых действий: ' + acts.length);
  assert.ok(buttonByText(card, /Разбор зарплаты/) && buttonByText(card, /Разбор направлений/));
  // Разбор открывается окном: после нажатия в документе появляется диалог.
  const before = document.body.children.length;
  buttonByText(card, /Разбор зарплаты/).click();
  await tick(20);
  assert.ok(document.body.children.length > before, 'разбор зарплаты не открылся');
});

test('врач под своим входом не выбирает врача — списка из одного имени нет', async () => {
  const host = await openPay();
  const head = byClass(host, 'page-head')[0];
  assert.ok(head, 'нет шапки вкладки');
  assert.ok(!walk(head).some((n) => n.tagName === 'SELECT'), 'в шапке список врачей из одного имени');
  assert.ok(textOf(head).includes('Каримова Азиза'), 'шапка не называет врача');
});

test('«Как считается зарплата», «Разбор направлений» и «Последние» — системные карточки с шапками', async () => {
  const host = await openPay();
  for (const title of ['Как считается зарплата', 'Разбор направлений', 'Последние']) {
    const card = byClass(host, 'card').find((c) => textOf(c).includes(title));
    assert.ok(card, 'нет карточки «' + title + '»');
    assert.ok(byClass(card, 'card-header').length >= 1, 'у карточки «' + title + '» нет системной шапки');
  }
});

// PAY_ONE_SCREEN_V1 — владелец: «make everything fit into a one page».
test('три списка живут в одной карточке «Последние» и переключаются, экран — один', async () => {
  const host = await openPay();
  const recent = () => byClass(host, 'card').find((c) => textOf(c).includes('Последние'));
  // По умолчанию — последние услуги: видна услуга «Приём».
  assert.ok(textOf(recent()).includes('Приём'), 'последние услуги не показаны: ' + textOf(recent()));
  buttonByText(recent(), /Последние направления/).click();
  await tick(20);
  assert.ok(textOf(recent()).includes('УЗИ'), 'последние направления не показаны');
  buttonByText(recent(), /По категориям/).click();
  await tick(20);
  assert.ok(textOf(recent()).includes('направлений: 1'), 'вознаграждения по категориям не показаны: ' + textOf(recent()));
  // Списки прокручиваются внутри карточек, а корень вкладки берёт высоту окна.
  assert.ok(byClass(host, 'pay-page')[0] && String(byClass(host, 'pay-page')[0].className).includes('dash-fit'),
    'корень вкладки не помечен под один экран');
  assert.ok(byClass(host, 'pay-scroll').length >= 3, 'списки не получили свою прокрутку');
  const chart = byClass(host, 'dash-chart')[0];
  assert.ok(chart && String(chart.className).includes('dash-chart-fill') && !chart.style.height,
    'график с прибитой высотой не займёт карточку');
});

test('на русской вкладке нет английских слов', async () => {
  const host = await openPay();
  const t = textOf(host);
  assert.ok(!/Salary|Referral|Details|Completed|Patients seen/.test(t), 'английское слово на вкладке: ' + t.match(/Salary|Referral|Details|Completed|Patients seen/));
});

// WORK_ONE_SCREEN_V1 — владелец: «#consultation/work … fit this too in to a
// one viewport and scroll only a list of the patients».
test('«Мои приёмы» помещается в экран: прокручивается только список очереди', async () => {
  dbCalls = [];
  dash.resetDoctorDashboard();
  window.easymed.state.user = { ...DOC, is_admin: false, is_super_admin: false };
  const host = mk('div');
  await renderConsultation(host, { onNavigate: () => {}, payload: { sub: 'work' } });
  await tick(80);
  const root = byClass(host, 'work-page')[0];
  assert.ok(root && String(root.className).includes('dash-fit'), 'корень вкладки не помечен под один экран');
  const card = byClass(host, 'work-card')[0];
  assert.ok(card, 'карточка очереди не помечена как колонка');
  const body = walk(card).find((n) => n.attrs && n.attrs.id === 'svc-body');
  assert.ok(body && String(body.className).includes('work-scroll'), 'список очереди не получил свою прокрутку');
  // Шапка с поиском и фильтрами — вне прокрутки.
  const header = byClass(card, 'card-header')[0];
  assert.ok(header && walk(header).some((n) => n.tagName === 'INPUT'), 'поиск не в шапке карточки');
});
