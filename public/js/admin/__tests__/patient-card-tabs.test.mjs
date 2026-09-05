// PATIENT_TAB_ACCESS_V1 (2026-09-05) — карта пациента по вкладкам: просмотр /
// изменение / удаление по отдельности.
//
// Жалоба владельца: «the informations about the patients are available for
// anyone who has access to the patients section». Здесь проверяется сторона
// ЭКРАНА — то, что человек увидит, когда вкладку закроют:
//
//   * КАРТА ХОДИТ В ОДНУ ДВЕРЬ. Ни визитов, ни счетов, ни анализов, ни
//     документов через /api/db она больше не тянет: единственный источник —
//     rpc patient_card, тот самый, который проверяет права. Дверь, мимо которой
//     можно пройти, — не дверь.
//   * ЗАКРЫТАЯ ВКЛАДКА ОБЪЯСНЯЕТСЯ, А НЕ ИСЧЕЗАЕТ. Пропавшая вкладка читается
//     как поломка, и человек ищет её или зовёт мастера; замок + фраза «кто
//     открывает доступ» отвечает на вопрос сразу.
//   * ПУСТО ≠ ЗАКРЫТО. На закрытом «Счёте» нельзя написать «счетов нет»:
//     регистратура повторит это пациенту.
//   * ШАПКА ПОДЧИНЯЕТСЯ ТЕМ ЖЕ ПРАВАМ. Право, которое обходится взглядом на
//     сводку сверху, — не право.
//   * КНОПКИ ПО УРОВНЮ: «Только просмотр» не показывает правок, «Изменение» —
//     не показывает удаления.
//   * ПО УМОЛЧАНИЮ ВИДНО ВСЁ — обновление никого не отключает.

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
const INVOICE = { id: 41, patient_id: 1, invoice_number: 'INV-A-26-00001', total_amount: 50000, paid_amount: 20000,
  status: 'partial', created_at: '2026-08-12T09:30:00Z' };

// Полный ответ сервера: все вкладки открыты.
function fullPayload() {
  return {
    tabs: { services: 'delete', labs: 'view', docs: 'delete', billing: 'view', visits: 'edit', details: 'edit' },
    caps: { services: { edit: true, del: true }, labs: { edit: false, del: false }, docs: { edit: true, del: true },
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
  p.tabs = { services: 'edit', labs: 'none', docs: 'none', billing: 'none', visits: 'edit', details: 'none' };
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
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (p) => ({ ok: true, status: 200, json: async () => p });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    if (name === 'patient_card') return ok({ data: JSON.parse(JSON.stringify(payload)) });
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
const TAB_LABELS = ['Услуги', 'Лаборатория', 'Документы', 'Счёт', 'Визиты', 'Деталь'];
const labelOfTab = (b) => walk(b).map((n) => (n._t || '').trim()).find((t) => TAB_LABELS.includes(t)) || null;
function tabBar(root) {
  return buttons(root).filter((b) => labelOfTab(b) !== null);
}
const openTab = (root, label) => { const b = tabBar(root).find((x) => labelOfTab(x) === label); assert.ok(b, 'нет вкладки ' + label); b.click(); };

async function render(p, roleRow) {
  dbCalls = []; rpcCalls = [];
  payload = p;
  if (roleRow) setEffectiveFromRole(roleRow); else setFullAccess('Администратор');
  const box = mk('div');
  renderPatientCard(box, { onNavigate() {}, payload: { id: 1 } });
  await tick();
  return box;
}

// ===========================================================================
test('карта ходит в ОДНУ дверь: всё содержимое приезжает rpc patient_card', async () => {
  const box = await render(fullPayload());
  assert.deepEqual(rpcCalls, ['patient_card'], 'карта спросила не только свою дверь');
  assert.deepEqual(dbCalls, [], 'карта всё ещё тянет данные пациента напрямую из /api/db — мимо проверки прав');
  const t = textOf(box);
  assert.ok(t.includes('Эргашев Жахонгир'), 'пациента не видно');
  assert.ok(t.includes('ОАК'), 'услуг не видно');
});

test('по умолчанию открыты все шесть вкладок и ни одна не под замком', async () => {
  const box = await render(fullPayload());
  assert.deepEqual(tabBar(box).map(labelOfTab), TAB_LABELS);
  assert.equal(titles(box).filter((x) => x.includes('закрыта')).length, 0, 'при полном доступе замков быть не должно');
});

test('закрытая вкладка ОСТАЁТСЯ на месте под замком, а не исчезает', async () => {
  const box = await render(visitsAndServicesOnly(), { name: 'Регистратура', permissions: {
    sections: ['patients'], levels: { patients: 'editor' },
    patient_tabs: { labs: 'none', docs: 'none', billing: 'none', details: 'none' },
  } });
  assert.deepEqual(tabBar(box).map(labelOfTab), TAB_LABELS,
    'вкладки пропали из полосы — исчезнувшая вкладка читается как поломка');
  const locked = tabBar(box).filter((b) => (b.attrs.title || '').includes('закрыта')).map(labelOfTab);
  assert.deepEqual(locked.sort(), ['Деталь', 'Документы', 'Лаборатория', 'Счёт'], 'под замком не те вкладки');
});

test('закрытая вкладка ОБЪЯСНЯЕТ отказ и называет, кто открывает доступ', async () => {
  const box = await render(visitsAndServicesOnly(), { name: 'Регистратура', permissions: {
    sections: ['patients'], levels: { patients: 'editor' }, patient_tabs: { billing: 'none' },
  } });
  openTab(box, 'Счёт');
  const t = textOf(box);
  assert.ok(t.includes('Вкладка «Счёт» закрыта'), 'отказ не называет вкладку');
  assert.ok(t.includes('Регистратура'), 'отказ не называет роль');
  assert.ok(t.includes('Настройки') && t.includes('Роли'), 'отказ не говорит, кто открывает доступ');
  // и главное — НЕ пустота: «счетов нет» регистратура повторит пациенту
  assert.ok(!t.includes('Счетов пока нет'), 'закрытая вкладка выдаёт себя за пустую');
});

test('шапка подчиняется тем же правам: ни долга, ни даты последнего визита', async () => {
  const p = visitsAndServicesOnly();
  p.tabs = { ...p.tabs, visits: 'none' };
  p.visits = null; p.visit_count = null; p.last_visit_date = null;
  const box = await render(p, { name: 'Лаборант', permissions: {
    sections: ['patients'], levels: { patients: 'viewer' },
    patient_tabs: { visits: 'none', billing: 'none', services: 'view' },
  } });
  const t = textOf(box);
  assert.ok(!t.includes('20 000') && !t.includes('30 000'), 'сумма долга видна при закрытом «Счёте»');
  assert.ok(!t.includes('2026-08-12'), 'дата последнего визита видна при закрытых «Визитах»');
  assert.ok(t.includes('вкладка закрыта'), 'шапка не объясняет прочерки');
});

test('уровень «Просмотр» не показывает кнопок правки, «Изменение» — кнопок удаления', async () => {
  // просмотр
  let p = fullPayload();
  p.tabs = { services: 'view', labs: 'view', docs: 'view', billing: 'view', visits: 'view', details: 'view' };
  let box = await render(p, { name: 'Наблюдатель', permissions: {
    sections: ['patients'], levels: { patients: 'viewer' },
    patient_tabs: { services: 'view', labs: 'view', docs: 'view', billing: 'view', visits: 'view', details: 'view' },
  } });
  openTab(box, 'Услуги');   // state.tab модульный — предыдущий тест мог оставить другую вкладку
  let ttl = titles(box);
  assert.ok(!ttl.includes('Сменить врача'), '«Просмотр» показывает смену врача');
  assert.ok(!textOf(box).includes('Добавить услуги'), '«Просмотр» показывает заведение услуг');
  assert.ok(!textOf(box).includes('Редактировать'), '«Просмотр» показывает правку анкеты');

  // изменение без удаления
  p = fullPayload();
  p.tabs = { ...p.tabs, services: 'edit', docs: 'edit' };
  box = await render(p, { name: 'Регистратура', permissions: {
    sections: ['patients'], levels: { patients: 'editor' },
    patient_tabs: { services: 'edit', docs: 'edit' },
  } });
  openTab(box, 'Услуги');
  ttl = titles(box);
  assert.ok(ttl.includes('Сменить врача'), '«Изменение» должно давать смену врача');
  assert.ok(!ttl.some((x) => x.startsWith('Убрать услугу')), '«Изменение» без «Удаления» показывает снятие услуги');
  openTab(box, 'Документы');
  // PATIENT_FILE_ATTACH_V1 — документ теперь ОТЗЫВАЕТСЯ, а не удаляется:
  // право то же (уровень «Удаление»), действие другое.
  assert.ok(!titles(box).includes('Отозвать документ'), '«Изменение» без «Удаления» показывает отзыв документа');

  // полное право
  p = fullPayload();
  box = await render(p, { name: 'Администратор', permissions: {
    sections: ['patients'], levels: { patients: 'admin' },
    patient_tabs: { services: 'delete', docs: 'delete' },
  } });
  openTab(box, 'Услуги');
  assert.ok(titles(box).some((x) => x.startsWith('Убрать услугу')), '«Удаление» не дало снять услугу');
  openTab(box, 'Документы');
  assert.ok(titles(box).includes('Отозвать документ'), '«Удаление» не дало отозвать документ');
});

test('строка визита не открывает счёт визита, когда «Счёт» закрыт', async () => {
  const p = visitsAndServicesOnly();
  const box = await render(p, { name: 'Регистратура', permissions: {
    sections: ['patients'], levels: { patients: 'editor' }, patient_tabs: { billing: 'none' },
  } });
  openTab(box, 'Визиты');
  const rows = walk(box).filter((n) => n.tagName === 'TR' && String(n.className).includes('row-click'));
  assert.equal(rows.length, 0, 'клик по визиту всё ещё открывает окно с деньгами');
});
