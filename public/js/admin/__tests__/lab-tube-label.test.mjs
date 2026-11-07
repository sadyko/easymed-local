// LAB_TUBE_LABEL_V1 (решение владельца 2026-11-02) — «Штрих-код» карточки очереди
// печатает этикетку на КАЖДУЮ пробирку визита, номер этикетки — самая старая
// строка пробирки, время — местное.
//
// Снимок владельца: тестовая клиника, визит 20, два счёта, в каждом «Анализ
// крови» + «Анализ мочи» (№ 28, 29 и № 31, 32). Кнопка печатала одну этикетку
// № 00000032 (моча второго счёта — самая новая строка) со временем 14:06 (UTC)
// вместо 19:06.
//
// Поддельный DOM и /api/db — те же, что в lab-card.test.mjs; плюс панели
// (lab_panels.device_id — какой прибор кормит услугу) и окно печати, которое
// запоминает написанный в него HTML.
//
// LAB_ONE_BARCODE_V1 (решение владельца 2026-11-07, п. 10) — «Штрих-код» печатает
// ОДИН номер на день визита (одну и ту же этикетку на каждую пробирку); этикетка
// строки («Печать этикетки», «Забор пробы») — номер строки, как прежде.
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
let REFUNDED = [];      // К4 — номера строк «услуга возвращена» (rpc refunded_lines)
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
setFullAccess(true);

// --- фикстуры ---------------------------------------------------------------
const BLOOD = { name: 'Анализ крови', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const URINE = { name: 'Анализ мочи', is_lab: 1, type: 'lab', specimen: null, tube_color: null, department_id: 'd-1' };
const line = (id, svc, status, extra = {}) => ({
  id, visit_id: 20, service_id: svc === BLOOD ? 40 : 41, status, sync_origin: null,
  created_at: TODAY_NOON, scheduled_at: null, sample_collected_at: null,
  services: svc, ...extra,
});
// Снимок владельца до забора: все четыре строки ждут забора.
const PHOTO_QUEUED = () => [
  line(32, URINE, 'queued'), line(31, BLOOD, 'queued'), line(29, URINE, 'queued'), line(28, BLOOD, 'queued'),
];
// В порядке очереди (новые первыми). № 28 уже взят в 14:06 UTC — 19:06 по Ташкенту.
const PHOTO = () => [
  line(32, URINE, 'queued'), line(31, BLOOD, 'queued'), line(29, URINE, 'queued'),
  line(28, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:06:00Z' }),
];
// Панель «Анализа крови» кормит BC-780 (lab_devices.id = 3); у мочи панели нет.
const PANELS = [{ id: 7, name: 'ОАК', code: '', service_id: 40, has_narrative: 0, device_id: 3 }];

async function mount(rows, { filter = null, panels = PANELS } = {}) {
  VISIT_SERVICES = rows;
  LAB_PANELS = panels;
  printed = []; opened = 0; toastMsg = null;
  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  if (filter) {
    const chip = buttons(root).find((b) => textOf(b).startsWith(filter));
    assert.ok(chip, 'фильтр «' + filter + '» пропал из шапки очереди');
    chip.click();
    await tick();
  }
  const cards = byClass(root, 'lq-card');
  assert.strictEqual(cards.length, 1, 'ожидалась одна карточка, получено ' + cards.length);
  return cards[0];
}
const barcodeBtn = (c) => buttons(byClass(c, 'lq-do')[0]).find((b) => clean(b) === 'Штрих-код');
const labelsOf = (html) => html.split('<div class="lbl">').slice(1).map((part) => ({
  code: (/class="acc">№ (\d+)</.exec(part) || [])[1],
  date: (/class="date">([^<]*)</.exec(part) || [])[1],
  tests: (/class="tests">([^<]*)</.exec(part) || [])[1] || '',
}));

// ═══ Карточка: один номер на день визита, этикетка на каждую пробирку ═════════
// LAB_ONE_BARCODE_V1 (решение владельца 2026-11-07, п. 10) — «Штрих-код» печатает
// ОДИН номер (90000000 + самая старая открытая оплаченная строка дня) — одну и ту же
// этикетку столько раз, сколько у дня пробирок (lab-tube.js tubeGroups). Приём по
// этому номеру заполняет каждую строку дня, которую кормит прибор.

test('снимок владельца (до забора): «Штрих-код» — один номер дня (90000028) на каждую пробирку, одним окном', async () => {
  const c = await mount(PHOTO_QUEUED());
  const btn = barcodeBtn(c);
  assert.ok(btn, 'кнопка «Штрих-код» пропала');
  assert.strictEqual(btn.getAttribute('title'), 'Один номер на все пробирки дня визита — этикетка на каждую пробирку');
  btn.click();
  await tick();
  assert.strictEqual(opened, 1, 'этикетки визита — одним окном печати');
  const labels = labelsOf(printed[0]);
  assert.deepStrictEqual(labels.map((l) => l.code), ['90000028', '90000028', '90000028'], 'три пробирки (кровь двух счетов — одна) — три копии одного номера');
  for (const l of labels) {
    assert.strictEqual(l.tests, 'Анализ крови, Анализ мочи');
    assert.match(l.date, /^\d\d\.\d\d\.\d{4}, \d\d:\d\d$/, 'проба не взята — время печати, числом');
  }
  assert.ok(printed[0].includes(PATIENT.full_name), 'на этикетке нет пациента');
});

// Ревью S3, M-2 — № 28 взята, а «Анализ крови» второго счёта (№ 31) ждёт: это
// второй забор того же анализа — его пробирке своя этикетка строки (00000031).
test('проба № 28 уже взята — номер дня прежний, копий по числу пробирок; время — забора, местное (19:06)', async () => {
  const c = await mount(PHOTO());
  barcodeBtn(c).click();
  await tick();
  const labels = labelsOf(printed[0]);
  assert.deepStrictEqual(labels.map((l) => l.code), ['90000028', '90000028', '90000028', '00000031']);
  assert.strictEqual(labels[0].date, '02.11.2026, 19:06', 'забор в 14:06 UTC — на этикетке 19:06 по Ташкенту');
});

test('номер пробы на карточке — номер дня визита (как на этикетке), а не строки', async () => {
  const c = await mount(PHOTO());
  const acc = textOf(byClass(c, 'lq-acc')[0]);
  assert.ok(acc.includes('90000028'), acc);
  assert.ok(!acc.includes('LAB-0000'), acc);
});

test('добавили анализ до или после забора — номер дня тот же (90000028)', async () => {
  const c = await mount([line(35, BLOOD, 'queued'), ...PHOTO_QUEUED()]);
  barcodeBtn(c).click();
  await tick();
  assert.deepStrictEqual([...new Set(labelsOf(printed[0]).map((l) => l.code))], ['90000028']);
  const after = await mount([line(35, BLOOD, 'queued'), ...PHOTO()]);
  barcodeBtn(after).click();
  await tick();
  // Ревью S3, M-2 — после забора № 28 ждущая кровь (№ 31, 35) — второй забор: своя этикетка строки.
  assert.deepStrictEqual([...new Set(labelsOf(printed[0]).map((l) => l.code))], ['90000028', '00000031']);
});

test('номер не зависит от вкладки: под «В работе» видна одна строка, номер и копии — те же', async () => {
  const c = await mount(PHOTO(), { filter: 'В работе' });
  assert.strictEqual(byClass(c, 'lq-item').length, 1, 'под «В работе» — только взятая проба № 28');
  barcodeBtn(c).click();
  await tick();
  assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['90000028', '90000028', '90000028', '00000031']);   // ревью S3, M-2
});

test('панель без прибора — номер дня тот же, копий по числу пробирок; выданный визит — этикеток нет', async () => {
  const c = await mount(PHOTO(), { panels: [] });
  barcodeBtn(c).click();
  await tick();
  assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['90000028', '90000028', '90000028', '90000028']);

  const done = await mount([line(28, BLOOD, 'completed', { sample_collected_at: '2026-11-02T14:06:00Z' })], { filter: 'Все' });
  assert.ok(!barcodeBtn(done), 'открытых пробирок нет — клеить нечего');
});

test('К4: строка «услуга возвращена» номер дня не даёт — номер даёт следующая открытая строка (90000029)', async () => {
  // № 28: результат внесён, потом касса вернула деньги — строка видна с пометкой, но номера дня она не даёт.
  REFUNDED = [28];
  LAB_RESULTS = [{ id: 1, visit_service_id: 28, parameter: 'Лейкоциты', value: '6.2', unit: '', flag: 'normal', notes: null, entered_at: '2026-11-02T14:30:00Z' }];
  try {
    const c = await mount([line(32, URINE, 'queued'), line(31, BLOOD, 'queued'), line(29, URINE, 'queued'),
      line(28, BLOOD, 'resulted', { sample_collected_at: '2026-11-02T14:06:00Z' })]);
    assert.strictEqual(byClass(c, 'lq-refunded').length, 1, 'возвращённая строка с результатом видна с пометкой');
    barcodeBtn(c).click();
    await tick();
    assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['90000029', '90000029', '90000029']);
  } finally {
    REFUNDED = [];
    LAB_RESULTS = [];
  }
});

test('скан этикетки дня в поиске очереди находит визит', async () => {
  VISIT_SERVICES = PHOTO();
  LAB_PANELS = PANELS;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  const search = walk(root).find((n) => n.tagName === 'INPUT' && (n.attrs.type === 'search' || /Поиск|поиск/.test(n.attrs.placeholder || '')));
  assert.ok(search, 'нет поля поиска');
  search.value = '90000028';
  search.dispatchEvent({ type: 'input', target: search, currentTarget: search });
  await tick();
  assert.strictEqual(byClass(root, 'lq-card').length, 1, 'карточка визита по номеру дня');
});

// ═══ Строка: «Печать этикетки» и «Забор пробы» ═════════════════════════════

test('«Печать этикетки» строки — её номер, местное время и название анализа', async () => {
  const c = await mount(PHOTO());
  const item = byClass(c, 'lq-item').find((n) => buttons(n).some((b) => b.getAttribute('title') === 'Печать этикетки'));
  assert.ok(item, 'у взятой пробы нет «Печать этикетки»');
  buttons(item).find((b) => b.getAttribute('title') === 'Печать этикетки').click();
  await tick();
  assert.strictEqual(opened, 1);
  assert.deepStrictEqual(labelsOf(printed[0]), [{ code: '00000028', date: '02.11.2026, 19:06', tests: 'Анализ крови' }]);
});

test('«Забор пробы» с галочкой печатает этикетку строки: её номер, название, время — местное, числом', async () => {
  const c = await mount(PHOTO());
  const item = byClass(c, 'lq-item').find((n) => buttons(n).some((b) => clean(b) === 'Забор пробы') && textOf(n).includes('Анализ крови'));
  assert.ok(item, 'нет строки крови с «Забор пробы»');
  buttons(item).find((b) => clean(b) === 'Забор пробы').click();
  await tick();
  const ok = buttons(fakeBody).find((b) => clean(b) === 'Проба взята');
  assert.ok(ok, 'окно «Забор пробы» не открылось');
  // В браузере setAttribute('checked') включает галочку; у поддельного DOM свойства нет — ставим, как браузер.
  for (const n of walk(fakeBody)) if (n.tagName === 'INPUT' && n.attrs.type === 'checkbox') n.checked = n.hasAttribute('checked');
  ok.click();
  await tick(80);
  assert.strictEqual(opened, 1, 'этикетка не напечатана');
  const [l] = labelsOf(printed[0]);
  assert.strictEqual(l.code, '00000031');
  assert.strictEqual(l.tests, 'Анализ крови');
  assert.match(l.date, /^\d\d\.\d\d\.\d{4}, \d\d:\d\d$/, 'время — местное, числом, а не ISO в UTC: ' + l.date);
});

// ═══ Ревью U11 ══════════════════════════════════════════════════════════════

const wsBtn = (c) => buttons(byClass(c, 'lq-do')[0]).find((b) => clean(b) === 'Внести результаты');
const headAcc = (c) => byClass(byClass(c, 'lq-head')[0], 'lq-acc');
/** Кнопки «Проба» по пробиркам: [номер, что в пробирке]. */
const chips = (root) => byClass(root, 'lq-tube').map((b) => [textOf(byClass(b, 'v')[0]), textOf(byClass(b, 'lq-tube-tests')[0] || mk('span'))]);
async function worksheetHead(c) {
  const b = wsBtn(c);
  assert.ok(b, 'нет «Внести результаты»');
  b.click();
  await tick(120);
  const wrap = walk(fakeBody).find((n) => hasClass(n, 'lw-accwrap'));
  assert.ok(wrap, 'в окне «Внести результаты» нет номера пробы');
  return wrap;
}

// M2 (проба P5a): шапка окна «Внести результаты» показывала g.accession — самую
// новую видимую строку, а карточка — другое. LAB_ONE_BARCODE_V1 — теперь оба экрана
// показывают номер дня визита — тот, что на этикетке «Штрих-код».
test('ревью U11, M2 + LAB_ONE_BARCODE_V1: карточка и «Внести результаты» — один и тот же номер дня', async () => {
  for (const rows of [PHOTO_QUEUED(), PHOTO()]) {
    const c = await mount(rows);
    assert.deepStrictEqual(chips(c), [], 'день один — ряда номеров нет, номер один');
    assert.ok(textOf(headAcc(c)[0]).includes('90000028'), 'строка очереди: ' + textOf(headAcc(c)[0]));
    const ws = await worksheetHead(c);
    assert.strictEqual(byClass(ws, 'lq-acc').length, 1);
    assert.ok(textOf(ws).includes('90000028'), 'окно «Внести результаты» — тот же номер: ' + textOf(ws));
  }
});

test('номер дня — самая старая открытая строка дня, какой бы прибор её ни кормил; кнопка копирует номер дня', async () => {
  // № 27 — моча без прибора — самая старая строка; номер дня — 90000027.
  const c = await mount([line(28, BLOOD, 'queued'), line(27, URINE, 'queued')]);
  assert.strictEqual(headAcc(c).length, 1);
  assert.ok(textOf(headAcc(c)[0]).includes('90000027'), textOf(headAcc(c)[0]));
  const copied = [];
  const saved = navigator.clipboard.writeText;
  navigator.clipboard.writeText = async (v) => { copied.push(v); };
  try {
    headAcc(c)[0].click();
    await tick();
    assert.deepStrictEqual(copied, ['90000027']);
    assert.strictEqual(toastMsg, 'Номер пробы скопирован');
  } finally { navigator.clipboard.writeText = saved; }
});

test('стационар: два дня визита — по номеру на день (кнопкой на карточке), в строке очереди — сегодняшний', async () => {
  const visit = VISITS[0].visit_date;
  VISITS[0].visit_date = daysAgoNoon(1);
  try {
    const c = await mount([line(31, BLOOD, 'queued'), line(28, BLOOD, 'queued', { created_at: daysAgoNoon(1) })]);
    assert.deepStrictEqual(chips(c).map(([n]) => n), ['90000028', '90000031']);
    assert.ok(textOf(headAcc(c)[0]).includes('90000031'), textOf(headAcc(c)[0]));
    barcodeBtn(c).click();
    await tick();
    assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['90000028', '90000031']);
  } finally {
    VISITS[0].visit_date = visit;
  }
});


// L4 (проба P5b): rpc refunded_lines не ответил — список «услуга возвращена»
// пуст, и возвращённая строка № 28 становилась номером пробирки. Теперь, пока
// возвраты не известны, карточка этикеток пробирок не печатает и говорит почему;
// этикетка строки («Печать этикетки», «Забор пробы») — как прежде.
test('ревью U11, L4: возвраты кассы не прочитались — «Штрих-код» этикетки пробирок не печатает и говорит почему; этикетка строки печатается', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('/api/rpc/refunded_lines')
    ? { ok: false, status: 500, json: async () => ({ error: { message: 'нет связи' } }) }
    : saved(url, opts));
  REFUNDED = [28];
  try {
    const c = await mount(PHOTO());
    const btn = barcodeBtn(c);
    assert.ok(btn, '«Штрих-код» остаётся: нажатие говорит, почему этикеток нет');
    btn.click();
    await tick();
    assert.strictEqual(opened, 0, 'возвраты не известны — этикетки пробирок не печатаются');
    assert.match(String(toastMsg), /^Не удалось проверить возвраты кассы/);
    const item = byClass(c, 'lq-item').find((n) => buttons(n).some((b) => b.getAttribute('title') === 'Печать этикетки'));
    assert.ok(item, 'у взятой пробы нет «Печать этикетки»');
    buttons(item).find((b) => b.getAttribute('title') === 'Печать этикетки').click();
    await tick();
    assert.strictEqual(opened, 1, 'этикетка строки печатается, как прежде');
    assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['00000028']);
  } finally {
    globalThis.fetch = saved;
    REFUNDED = [];
  }
});

// L6 (проба P2e, 9 дней): номер старше 7 дней приём отказывает — карточка его не
// печатает и говорит почему; срок — та же константа, что у приёма. LAB_ONE_BARCODE_V1 —
// срок судится у дня визита (номер дня старой строки стационара — свой, старый).
test('ревью U11, L6: день старше 7 дней карточка не печатает — приём его номер не примет; сегодняшний печатается, сказано почему', async () => {
  const visit = VISITS[0].visit_date;
  VISITS[0].visit_date = daysAgoNoon(9);   // стационар: визит начался 9 дней назад
  try {
    const c = await mount([line(31, BLOOD, 'queued'), line(28, BLOOD, 'queued', { created_at: daysAgoNoon(9) })]);
    assert.ok(textOf(headAcc(c)[0]).includes('90000031'), 'в строке очереди — номер дня, который печатают: ' + textOf(headAcc(c)[0]));
    barcodeBtn(c).click();
    await tick();
    assert.strictEqual(opened, 1);
    assert.deepStrictEqual(labelsOf(printed[0]).map((l) => l.code), ['90000031']);
    assert.match(String(toastMsg), /старше 7 дней/);
    // Только старый день — окна нет, сказано почему.
    const old = await mount([line(28, BLOOD, 'queued', { created_at: daysAgoNoon(9) })]);
    barcodeBtn(old).click();
    await tick();
    assert.strictEqual(opened, 0);
    assert.match(String(toastMsg), /старше 7 дней/);
    // Ровно 7 дней — ещё печатается (приём примет).
    VISITS[0].visit_date = daysAgoNoon(7);
    const seven = await mount([line(28, BLOOD, 'queued', { created_at: daysAgoNoon(7) })]);
    barcodeBtn(seven).click();
    await tick();
    assert.strictEqual(opened, 1);
  } finally {
    VISITS[0].visit_date = visit;
  }
});

// Ревью S3, M-2 — повторный забор того же анализа в тот же день: утренняя кровь
// (№ 28) взята, вечерняя (№ 31) ждёт. Номер дня приём не разложил бы между двумя
// открытыми «Анализ крови» — у вечерней пробирки своя этикетка строки, и карточка
// говорит почему.
test('ревью M-2: повторный забор — номер дня утренней пробирке, вечерней — этикетка её строки; сказано почему', async () => {
  const c = await mount([line(31, BLOOD, 'queued'), line(29, URINE, 'queued'),
    line(28, BLOOD, 'collected', { sample_collected_at: '2026-11-02T14:06:00Z' })]);
  barcodeBtn(c).click();
  await tick();
  assert.strictEqual(opened, 1, 'одним окном');
  assert.deepStrictEqual(labelsOf(printed[0]).map((l) => [l.code, l.tests]),
    [['90000028', 'Анализ крови, Анализ мочи'], ['90000028', 'Анализ крови, Анализ мочи'], ['00000031', 'Анализ крови']]);
  assert.match(String(toastMsg), /Повторный забор/);
  assert.ok(String(toastMsg).includes('00000031'), String(toastMsg));
});

// Ревью S3, M-3 — один анализатор кормит и кровь, и мочу (панели обеих услуг — на
// приборе 3): через LIS Proxy материал пробы не приходит, и номер дня не разделил бы
// пробирки. У обеих — свои этикетки пробирок (номер — самая старая строка пробирки).
test('ревью M-3: моча и кровь на одном анализаторе — у его пробирок свои этикетки, номера дня нет; сказано почему', async () => {
  const URINE_M = { ...URINE, specimen: 'Моча' };
  const panels = [...PANELS, { id: 8, name: 'Моча', code: '', service_id: 41, has_narrative: 0, device_id: 3 }];
  const c = await mount([line(29, URINE_M, 'queued'), line(28, BLOOD, 'queued')], { panels });
  barcodeBtn(c).click();
  await tick();
  assert.deepStrictEqual(labelsOf(printed[0]).map((l) => [l.code, l.tests]), [['00000028', 'Анализ крови'], ['00000029', 'Анализ мочи']]);
  assert.match(String(toastMsg), /Моча и другой материал на одном анализаторе/);
});
