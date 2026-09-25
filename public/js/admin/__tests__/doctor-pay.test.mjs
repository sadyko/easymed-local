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

// DOCTOR_TIER_V1 — ответ doctor_tier_positions: нумерацию строк по ступеням
// считает СЕРВЕР, кабинет её только применяет. Ответ — за ДИАПАЗОН месяцев
// ({ from, to, rows }), и у каждой строки есть свой ym: кабинет спрашивает
// один раз и раскладывает строки по месяцам сам. По умолчанию ступеней нет.
const monthKeyOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
let TIER_RESPONSE = { from: '', to: '', rows: [] };
let TIER_FORBID = false;   // ROLE_REPORTS_SETTINGS_V1 (ревью M2) — сервер отказал в ступенях
// INPATIENT_SHARE_V1 — ответ doctor_inpatient_share; по умолчанию стационара нет.
let INPATIENT_RESPONSE = { rows: [], count: 0, fee: 0 };
let inpatientCalls = [];
// REPORTS_V2 — ответ doctor_referral_reward; по умолчанию вознаграждения нет.
let REFERRAL_RESPONSE = { rows: [], count: 0, reward: 0, paid_amount: 0 };
let referralCalls = [];

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
let tierCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/doctor_tier_positions')) {
    tierCalls.push(body);
    if (TIER_FORBID) return { ok: false, status: 403, json: async () => ({ error: { code: 'forbidden', message: 'Можно смотреть только свои начисления.' } }) };
    return { ok: true, json: async () => ({ data: TIER_RESPONSE }) };
  }
  // INPATIENT_SHARE_V1 — стационарная доля приходит готовой с сервера.
  if (u.startsWith('/api/rpc/doctor_inpatient_share')) {
    inpatientCalls.push(body);
    return { ok: true, json: async () => ({ data: INPATIENT_RESPONSE }) };
  }
  // REPORTS_V2 — вознаграждение за направления приходит готовым с сервера.
  if (u.startsWith('/api/rpc/doctor_referral_reward')) {
    referralCalls.push(body);
    return { ok: true, json: async () => ({ data: REFERRAL_RESPONSE }) };
  }
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

test('DOCTOR_TIER_V1: позиции сервера меняют сумму и рисуют прогресс ступени', async () => {
  // sv-1 — 26-я строка месяца: 1 единица по ступени 50 % вместо личных 40 %.
  // ym у каждой строки свой, как отдаёт сервер: прогресс месяца собирается
  // только по строкам ТЕКУЩЕГО месяца.
  TIER_RESPONSE = { from: monthKeyOf(yesterday), to: monthKeyOf(now), rows: [
    { visit_service_id: 'sv-1', service_id: 's-1', service_name: 'Приём', ym: monthKeyOf(now), units: 1, units_above: 1, tier_from: 25, tier_percent: 50, count_so_far: 26 },
    { visit_service_id: 'sv-2', service_id: 's-1', service_name: 'Приём', ym: monthKeyOf(yesterday), units: 1, units_above: 0, tier_from: 25, tier_percent: 50, count_so_far: 25 },
  ] };
  let root = null;
  try {
    root = await openPay();
    // Вкладка грузит деньги ОДИН раз на процесс, и первый тест файла уже успел
    // их прочитать без ступеней. Переключение периода — тот же путь, которым
    // это делает врач: оно перечитывает всё заново, теперь уже с позициями.
    tierCalls = [];
    buttonByText(root, /7 дней/).click();
    await tick(80);
    // ПРАВИЛО: позиции спрашиваются ОДНИМ запросом за диапазон месяцев, а не по
    // одному запросу на месяц — цикл по месяцам на «12 месяцев» это двенадцать
    // запросов подряд.
    assert.strictEqual(tierCalls.length, 1, 'запросов позиций: ' + tierCalls.length);
    assert.ok(tierCalls[0].from && tierCalls[0].to, 'позиции запрошены не диапазоном: ' + JSON.stringify(tierCalls[0]));
    assert.ok(!('month' in tierCalls[0]), 'в запросе остался месяц: ' + JSON.stringify(tierCalls[0]));
    const txt = textOf(root);
    // 100 000 × 50 % + 100 000 × 40 % = 90 000 (без ступени было бы 80 000).
    // Число проверяется НА ПЛИТКЕ, а не где-нибудь на вкладке: «90 000» в общем
    // тексте мог бы нарисовать и соседний список.
    const salary = byClass(root, 'dash-kpi').find((t) => textOf(t).includes('Зарплата'));
    assert.ok(salary, 'нет плитки «Зарплата»');
    assert.ok(textOf(salary).includes('90 000'), 'плитка не учла ступень: ' + textOf(salary));
    assert.ok(/Ступень: Приём/.test(txt), 'нет строки прогресса ступени');
    assert.ok(/26 из 25/.test(txt), 'прогресс не показывает счёт месяца');
    // И график — та же арифметика, что плитка: сегодняшняя услуга по ступени
    // 50 % даёт 50 000. Без этого график и плитка могли бы разойтись под
    // ступенью и никто бы не заметил.
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Начисления по дням'));
    const chart = byClass(card, 'dash-chart')[0];
    chart.getBoundingClientRect = () => ({ left: 0, width: 640, height: 240 });
    chart.dispatchEvent({ type: 'mousemove', clientX: 700 });
    const tip = byClass(chart, 'dash-chart-tip')[0];
    assert.ok(tip && !tip.hidden, 'подсказка не показалась');
    assert.ok(textOf(tip).includes('50 000'), 'подсказка дня не учла ступень: ' + textOf(tip));
  } finally {
    TIER_RESPONSE = { from: '', to: '', rows: [] };
    // Вернуть вкладку в исходный период — состояние живёт дольше теста.
    if (root) { const b = buttonByText(root, /30 дней/); if (b) b.click(); await tick(80); }
  }
});

// INPATIENT_SHARE_V1 — стационарная доля в «Зарплате» кабинета. Сумму считает
// СЕРВЕР (тот же запрос, что отчёт «Стационар: доля врачей»); кабинет её
// прибавляет к плитке, раскладывает по дням на графике и называет отдельной
// строкой в «Как считается зарплата».
test('INPATIENT_SHARE_V1: стационарная доля с сервера входит в плитку, график и карточку', async () => {
  const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  INPATIENT_RESPONSE = { rows: [{ date: dayKey(now), service: 'Перевязка', fee: 30000, net: 300000, pct: 10, doctor_role: 'performer' }], count: 1, fee: 30000 };
  let root = null;
  try {
    root = await openPay();
    inpatientCalls = [];
    buttonByText(root, /7 дней/).click();
    await tick(80);
    assert.strictEqual(inpatientCalls.length, 1, 'стационар спрошен одним запросом');
    assert.match(String(inpatientCalls[0].from), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(inpatientCalls[0].to), /^\d{4}-\d{2}-\d{2}$/);
    const salary = byClass(root, 'dash-kpi').find((t) => textOf(t).includes('Зарплата'));
    // 80 000 за услуги + 30 000 стационар.
    assert.ok(textOf(salary).includes('110 000'), 'плитка не учла стационар: ' + textOf(salary));
    const cfg = byClass(root, 'card').find((c) => textOf(c).includes('Как считается зарплата'));
    assert.ok(/Стационар \(оплаченные счета\)/.test(textOf(cfg)), 'нет строки стационара');
    assert.ok(textOf(cfg).includes('30 000 UZS · услуг: 1'), textOf(cfg));
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Начисления по дням'));
    const svg = chartSvgs(card)[0];
    assert.strictEqual((svg._t.match(/<linearGradient/g) || []).length, 3, 'третий ряд — стационар');
    const chart = byClass(card, 'dash-chart')[0];
    chart.getBoundingClientRect = () => ({ left: 0, width: 640, height: 240 });
    chart.dispatchEvent({ type: 'mousemove', clientX: 700 });
    const tip = byClass(chart, 'dash-chart-tip')[0];
    // Сегодня: услуга 40 000 + стационар 30 000 — график сходится с плиткой.
    assert.ok(textOf(tip).includes('30 000') && textOf(tip).includes('40 000'), 'подсказка дня: ' + textOf(tip));
  } finally {
    INPATIENT_RESPONSE = { rows: [], count: 0, fee: 0 };
    if (root) { const b = buttonByText(root, /30 дней/); if (b) b.click(); await tick(80); }
  }
});

// REPORTS_V2 — вознаграждение за направления в «Зарплате» кабинета. Сумму
// считает СЕРВЕР (doctor_referral_reward — те же строки, что отчёт
// «Рефералы»: строка счёта после скидки, только оплаченные счета); кабинет
// больше не считает её от цены каталога рекомендаций.
test('REPORTS_V2: вознаграждение за направления с сервера — в плитке, графике и разборе', async () => {
  const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  REFERRAL_RESPONSE = { rows: [
    { date: dayKey(now), invoice: 'INV-9', status: 'paid', paid: true, patient: 'Иванов Пётр', service: 'УЗИ',
      service_type: 'Диагностика', service_category: '', qty: 1, amount: 45000, rate: '10 %', reward: 4500 },
  ], count: 1, reward: 4500, paid_amount: 45000 };
  let root = null;
  try {
    root = await openPay();
    referralCalls = [];
    buttonByText(root, /7 дней/).click();
    await tick(80);
    assert.strictEqual(referralCalls.length, 1, 'вознаграждение спрошено одним запросом');
    assert.strictEqual(String(referralCalls[0].doctor_id), 'u-doc');
    assert.match(String(referralCalls[0].from), /^\d{4}-\d{2}-\d{2}$/);
    const tile = byClass(root, 'dash-kpi').find((t) => textOf(t).includes('Вознаграждения за направления'));
    // 4 500 с сервера, а не 50 000 × ставка от цены каталога рекомендации.
    assert.ok(textOf(tile).includes('4 500'), 'плитка не взяла сумму сервера: ' + textOf(tile));
    // Карточка «Разбор направлений» — та, где таблица по видам услуг (кнопка
    // с тем же названием есть и в шапке графика).
    const card = byClass(root, 'card').find((c) => textOf(c).includes('Вид услуги'));
    assert.ok(textOf(card).includes('4 500') && textOf(card).includes('45 000'), 'разбор: ' + textOf(card));
  } finally {
    REFERRAL_RESPONSE = { rows: [], count: 0, reward: 0, paid_amount: 0 };
    if (root) { const b = buttonByText(root, /30 дней/); if (b) b.click(); await tick(80); }
  }
});

// ROLE_REPORTS_SETTINGS_V1 (ревью M2) — сервер отказал в ступенях (смотрит не
// сам врач и без «Оплаты врачей»): кабинет не имеет права показать сумму БЕЗ
// ступеней как настоящую — он говорит, почему её нет, и прячет её.
test('ступени не пришли (403): видно объяснение, а доля без ступеней не выдаётся за зарплату', async () => {
  let root = null;
  TIER_FORBID = true;
  try {
    root = await openPay();
    buttonByText(root, /7 дней/).click();
    await tick(80);
    const txt = textOf(root);
    assert.ok(txt.includes('Ступени доли не загружены — нет права на отчёт «Оплата врачей»'), 'отказ сервера промолчал');
    const salary = byClass(root, 'dash-kpi').find((t) => textOf(t).includes('Зарплата'));
    assert.ok(salary, 'нет плитки «Зарплата»');
    assert.ok(!/\d0 000/.test(textOf(salary)), 'плитка показала сумму без ступеней: ' + textOf(salary));
    assert.ok(!byClass(root, 'card').some((c) => textOf(c).includes('Начисления по дням') && byClass(c, 'dash-chart').length),
      'график начислений нарисован без ступеней');
  } finally {
    TIER_FORBID = false;
    if (root) { const b = buttonByText(root, /30 дней/); if (b) b.click(); await tick(80); }
  }
});
