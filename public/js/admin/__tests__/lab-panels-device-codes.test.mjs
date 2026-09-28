// LIS_MINDRAY_CODES_V1 (2026-09-28) — «Поле анализатора» в Лаборатория → «Панели».
//
// Владелец: лаборатория обязана выбрать код, который прибор ДЕЙСТВИТЕЛЬНО
// присылает («6690-2 · WBC»), а не только догадку из типового списка, и
// вписать свой, если его нет нигде. Раньше ввод руками появлялся, только когда
// у профиля нет каналов, — у каждого Mindray список есть, и настоящий код
// ввести было нельзя.
import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/telephony-settings.test.mjs (itself
// from system-view.test.mjs / activation.test.mjs) because these views also
// render Icon() calls, which go through ui.js's html() -> a <template> parse.
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
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
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js picks its language ONCE, at module load, from
// this same store's 'admin.lang' before ever consulting navigator.language.
// Pinning 'ru' here, BEFORE the view imports below, is what makes this file's
// Russian-string assertions hold on GitHub's English-locale runner exactly as
// they do on a Russian-locale dev machine.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){},
  // setLang() (i18n.js) announces the switch on window — the chips test flips
  // the language to uz and back, so the fake must accept the event.
  dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  // currentClinicId() reads this; without it the editor takes its "no clinic"
  // branch and toasts, which is a different screen from the one under test.
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  // HASH_SUBROUTE_V1 — the shell hook the view reports its mode to. Recorded,
  // not stubbed away: without it navigate() would rewrite the hash from a tab
  // payload that still said «queue» and the deep link would rot on the next
  // sidebar click.
  easymedSetTabSub: (tabId, sub) => { tabSubCalls.push([tabId, sub]); },
};
let tabSubCalls = [];
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

// history is absent in Node. The mode writes the URL through it, so record the
// writes instead of stubbing them away — the deep link IS the feature.
let lastHistoryUrl = null;
let historyWrites = 0;
globalThis.history = {
  state: null,
  replaceState(st, _title, url) { this.state = st; lastHistoryUrl = url; historyWrites++; },
  pushState(st, _title, url) { this.state = st; lastHistoryUrl = url; historyWrites++; },
};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const parentOf = (root, node) => walk(root).find((n) => (n.children || []).includes(node));
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));
const findByAriaLabel = (root, label) => walk(root).find((n) => n.attrs['aria-label'] === label);
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
// The switch is identified by its accessible name, not by '.segmented': the
// queue's own status filter is a .segmented too, and asserting on the class
// would pass for the wrong control.
// LAB_TABS_SYSTEM_V1 — переключатель режима это системные вкладки (.tabs), а
// не пилюля; узнаётся по имени, как и раньше.
const modeSwitch = (root) => walk(root).find((n) => hasClass(n, 'tabs') && n.attrs['aria-label'] === 'Режим раздела');
const labelOf = (b) => textOf(b).replace(/<svg[\s\S]*?<\/svg>/g, '').trim();
const modeButtons = (root) => { const sw = modeSwitch(root); return sw ? findAllButtons(sw) : []; };

// A toast node, so ui.js reuses it instead of appending to the fake body. Its
// text is kept OUTSIDE `_t`: toast() stores its dismiss timer in `el._t`, which
// is exactly the field this fake DOM keeps text in.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- fake сервер: одна панель, привязанная к прибору 1 ---------------------
const PANELS = [{ id: 'p-1', company_id: 'c-1', name: 'Общий анализ крови', modality: 'lab', has_narrative: false, service_id: 's-1', active: true, device_id: 1 }];
const analyte = (over = {}) => ({ id: 'a-1', panel_id: 'p-1', code: 'WBC', name: 'Лейкоциты', unit: '10^9/л', value_type: 'numeric', decimals: 1,
  ref_low: null, ref_high: null, group_label: '', sort_order: 0, ref_ranges: null, device_code: '', device_code_confirmed: 0, ...over });
// let, а не const: тесты ревью ставят свои строки бланка (fetch читает имя при вызове).
let ANALYTES = [analyte()];
const SERVICES = [{ id: 's-1', name: 'ОАК', type: 'lab', is_lab: true, department_id: 'd-1', type_id: null }];
const DEVICES = [
  { id: 1, name: 'Гематология', profile: 'mindray-bc-5300', enabled: 1, added: 1 },
  // LIS_ANALYZER_LIST_V1 — находка, которую ещё не добавили (ждёт «Добавить» на экране «Анализаторы»)
  { id: 2, name: 'Найденный BC-5300', profile: 'mindray-bc-5300', enabled: 1, added: 0 },
];
const PROFILES = [{ key: 'mindray-bc-5300', vendor: 'Mindray', model: 'BC-5300', channelsSource: 'screenshot',
  channels: [{ code: 'WBC', name: 'Лейкоциты' }, { code: 'PLT', name: 'Тромбоциты' }] }];
const SENT_CODES = [
  { code: '08001', name: 'Take Mode', system: '99MRC', value_type: 'IS', unit: '' },
  { code: '6690-2', name: 'WBC', system: 'LN', value_type: 'NM', unit: '10*9/L' },
];

let rpcCalls = [];
let writes = [];
// Ревью R3: ответ lis_device_codes можно задержать — редактор перерисуется,
// когда он придёт, и набранное в шапке обязано это пережить.
let codesGate = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.op && body.op !== 'select') writes.push(body);
    const rows = {
      lab_panels: PANELS, lab_panel_analytes: ANALYTES, services: SERVICES, lab_devices: DEVICES,
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }], service_types: [],
      visit_services: [], visits: [], lab_results: [],
    }[body && body.table] || [];
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_profiles') return { ok: true, json: async () => ({ data: PROFILES }) };
    if (name === 'lis_device_codes') {
      if (codesGate) await codesGate;
      return { ok: true, json: async () => ({ data: SENT_CODES }) };
    }
    return { ok: true, json: async () => ({ data: null }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { setEffectiveFromRole } = await import('../permissions.js');
const LAB_SEEDED = { name: 'lab', permissions: { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } } };

test('«Поле анализатора»: присланные коды первыми, свой код вписывается и сохраняется подтверждённым', async () => {
  setEffectiveFromRole(LAB_SEEDED);
  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick(80);

  assert.ok(rpcCalls.some((c) => c.name === 'lis_device_codes' && c.args && c.args.device_id === 1),
    'редактор спросил коды прибора панели: ' + JSON.stringify(rpcCalls));

  // Ищем в таблице показателей: выбор «Привязанная услуга» над ней тоже с
  // группами («Лабораторные услуги»), и поиск по всему экрану находил его.
  const tbody = walk(root).find((n) => n.tagName === 'TBODY');
  const sel = tbody && walk(tbody).find((n) => n.tagName === 'SELECT' && walk(n).some((o) => o.tagName === 'OPTGROUP'));
  assert.ok(sel, 'у строки показателя — список с группами');
  assert.deepStrictEqual(walk(sel).filter((n) => n.tagName === 'OPTGROUP').map((g) => g.attrs.label),
    ['Присылал этот анализатор', 'Типовые для модели']);
  const labels = walk(sel).filter((n) => n.tagName === 'OPTION').map((o) => textOf(o));
  assert.ok(labels.includes('6690-2 · WBC'), 'присланный код с обеими частями: ' + labels.join(' | '));
  assert.ok(labels.indexOf('6690-2 · WBC') < labels.indexOf('PLT · Тромбоциты'), 'присланное — раньше типового');
  assert.ok(!labels.includes('WBC · Лейкоциты'), 'WBC уже есть среди присланных — второй раз не показан');
  assert.strictEqual(labels[labels.length - 1], 'Вписать код…', 'свой код — последним пунктом');

  // «Вписать код…» → поле ввода → вписанный код сохраняется подтверждённым.
  sel.value = '__lis_type_own__';
  sel.dispatchEvent({ type: 'change', target: sel });
  await tick();
  const inp = walk(root).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === 'код канала');
  assert.ok(inp, 'появилось поле для своего кода');
  inp.value = 'NRBC#';
  inp.dispatchEvent({ type: 'input', target: inp });

  findButtonByText(root, /Сохранить панель/).click();
  await tick(80);
  const ins = writes.find((w) => w.table === 'lab_panel_analytes' && w.op === 'insert');
  assert.ok(ins, 'показатели записаны: ' + JSON.stringify(writes.map((w) => w.table + ':' + w.op)));
  const row = [].concat(ins.values).find((r) => r.name === 'Лейкоциты');
  assert.strictEqual(row.device_code, 'NRBC#');
  assert.strictEqual(row.device_code_confirmed, 1, 'вписал сам — это и есть подтверждение');
});

// ── Ревью 2026-09-28 ────────────────────────────────────────────────────────

const fieldControl = (root, label, tag) => {
  const f = walk(root).find((n) => hasClass(n, 'field') && (n.children || []).some((c) => c.tagName === 'LABEL' && textOf(c) === label));
  return f && walk(f).find((n) => n.tagName === tag);
};

async function mountPanels() {
  setEffectiveFromRole(LAB_SEEDED);
  rpcCalls = []; writes = []; toastMsg = null;
  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick(80);
  return root;
}

test('R3: набранное в шапке переживает перерисовку, когда приходят коды прибора, и уходит в сохранение', async () => {
  ANALYTES = [analyte()];
  let release;
  codesGate = new Promise((r) => { release = r; });
  try {
    const root = await mountPanels();
    assert.ok(rpcCalls.some((c) => c.name === 'lis_device_codes'), 'коды прибора ещё в пути');
    assert.ok(!walk(root).some((n) => n.tagName === 'OPTGROUP' && n.attrs.label === 'Присылал этот анализатор'), 'ответа ещё нет');

    const nameInp = fieldControl(root, 'Название панели', 'INPUT');
    assert.strictEqual(nameInp.value, 'Общий анализ крови');
    nameInp.value = 'ОАК — развёрнутый';
    nameInp.dispatchEvent({ type: 'input', target: nameInp });
    const modSel = fieldControl(root, 'Группа', 'SELECT');
    modSel.value = 'diagnostic';
    modSel.dispatchEvent({ type: 'change', target: modSel });

    release();          // коды пришли — редактор перерисовывается целиком
    await tick(80);
    assert.ok(walk(root).some((n) => n.tagName === 'OPTGROUP' && n.attrs.label === 'Присылал этот анализатор'), 'перерисовка случилась');

    const again = fieldControl(root, 'Название панели', 'INPUT');
    assert.notStrictEqual(again, nameInp, 'это новое поле, построенное перерисовкой');
    assert.strictEqual(again.value, 'ОАК — развёрнутый', 'набранное имя не пропало');
    const picked = walk(fieldControl(root, 'Группа', 'SELECT')).find((o) => o.tagName === 'OPTION' && 'selected' in o.attrs);
    assert.strictEqual(picked && picked.attrs.value, 'diagnostic', 'выбранная группа не пропала');
    const listed = walk(root).filter((n) => hasClass(n, 'nav-item')).map((n) => textOf(n));
    assert.ok(listed.some((t) => t.includes('Общий анализ крови')), 'до сохранения список слева — с прежним именем: ' + listed.join(' | '));

    findButtonByText(root, /Сохранить панель/).click();
    await tick(80);
    const upd = writes.find((w) => w.table === 'lab_panels' && w.op === 'update');
    assert.ok(upd, 'панель записана: ' + JSON.stringify(writes.map((w) => w.table + ':' + w.op)));
    assert.strictEqual(upd.values.name, 'ОАК — развёрнутый');
  } finally { codesGate = null; }
});

// R4: строка с подсказкой (код есть, не подтверждён), переведённая в «Вписать
// код…», выглядела подтверждённой. Сохранение отказывало «Подтвердите поля
// анализатора…», а на экране не было ни следа, что и как подтверждать.
const deviceTbody = (root) => walk(root).find((n) => n.tagName === 'TBODY');
const codeInput = (root) => walk(deviceTbody(root)).find((n) => n.tagName === 'INPUT' && n.attrs.placeholder === 'код канала');
const confirmButton = (root) => walk(deviceTbody(root)).find((n) => n.tagName === 'BUTTON' && n.attrs['aria-label'] === 'Подтвердить сопоставление');
async function typeOwnCode(root) {
  const sel = walk(deviceTbody(root)).find((n) => n.tagName === 'SELECT' && walk(n).some((o) => o.tagName === 'OPTGROUP'));
  sel.value = '__lis_type_own__';
  sel.dispatchEvent({ type: 'change', target: sel });
  await tick();
}

test('R4: «Вписать код…» с неподтверждённым кодом — курсив и кнопка «Подтвердить», как у списка', async () => {
  ANALYTES = [analyte({ device_code: 'WBC', device_code_confirmed: 0 })];
  const root = await mountPanels();
  await typeOwnCode(root);
  const inp = codeInput(root);
  assert.ok(inp, 'поле своего кода');
  assert.strictEqual(inp.value, 'WBC');
  assert.strictEqual(inp.style.fontStyle, 'italic', 'неподтверждённое видно и в режиме ввода');
  const btn = confirmButton(root);
  assert.ok(btn && btn.style.display !== 'none', 'кнопка подтверждения рядом с полем');

  findButtonByText(root, /Сохранить панель/).click();
  await tick(80);
  assert.strictEqual(toastMsg, 'Подтвердите поля анализатора: Лейкоциты');
  assert.ok(!writes.length, 'неподтверждённое не сохраняется');

  btn.click();
  await tick();
  const after = codeInput(root);
  assert.ok(after, 'подтверждение не выбрасывает из режима ввода');
  assert.notStrictEqual(after.style.fontStyle, 'italic');
  const gone = confirmButton(root);
  assert.ok(!gone || gone.style.display === 'none', 'подтверждать больше нечего');

  findButtonByText(root, /Сохранить панель/).click();
  await tick(80);
  const ins = writes.find((w) => w.table === 'lab_panel_analytes' && w.op === 'insert');
  assert.ok(ins, 'сохранено: ' + JSON.stringify(writes.map((w) => w.table + ':' + w.op)));
  const row = [].concat(ins.values)[0];
  assert.deepStrictEqual({ code: row.device_code, confirmed: row.device_code_confirmed }, { code: 'WBC', confirmed: 1 });
});

test('R4: вписанный руками код подтверждает строку сразу — курсив и кнопка уходят без перерисовки', async () => {
  ANALYTES = [analyte({ device_code: 'WBC', device_code_confirmed: 0 })];
  const root = await mountPanels();
  await typeOwnCode(root);
  const inp = codeInput(root);
  const btn = confirmButton(root);
  inp.value = '6690-2';
  inp.dispatchEvent({ type: 'input', target: inp });
  assert.strictEqual(codeInput(root), inp, 'поле то же — курсор не сбит перерисовкой');
  assert.notStrictEqual(inp.style.fontStyle, 'italic');
  assert.strictEqual(btn.style.display, 'none');
});

// R2: два показателя с одним подтверждённым полем анализатора. Прибор шлёт код
// один раз — второй показатель остался бы пустым навсегда, а каждая проба
// панели лежала бы в лотке. Сохранение отказывает и называет строки.
test('R2: одно поле анализатора у двух показателей — сохранение отказывает и называет их', async () => {
  ANALYTES = [
    analyte({ id: 'a-1', name: 'Лейкоциты', device_code: 'WBC', device_code_confirmed: 1, sort_order: 0 }),
    analyte({ id: 'a-2', code: 'WBC#', name: 'Лейкоциты (абс.)', device_code: ' wbc ', device_code_confirmed: 1, sort_order: 1 }),
    analyte({ id: 'a-3', code: 'HGB', name: 'Гемоглобин', device_code: 'HGB', device_code_confirmed: 1, sort_order: 2 }),
  ];
  const root = await mountPanels();
  findButtonByText(root, /Сохранить панель/).click();
  await tick(80);
  assert.strictEqual(toastMsg,
    'Одно поле анализатора выбрано у нескольких показателей: Лейкоциты, Лейкоциты (абс.) (WBC). Прибор заполнит только первый — выберите каждому своё поле.');
  assert.strictEqual(toastEl.dataset.kind, 'fail');
  assert.deepStrictEqual(writes, [], 'ничего не записано');
});

test('R2: разные поля, пустые поля и строка без имени — не спор, панель сохраняется', async () => {
  ANALYTES = [
    analyte({ id: 'a-1', name: 'Лейкоциты', device_code: 'WBC', device_code_confirmed: 1, sort_order: 0 }),
    analyte({ id: 'a-2', code: 'RBC', name: 'Эритроциты', device_code: '', device_code_confirmed: 0, sort_order: 1 }),
    analyte({ id: 'a-3', code: 'PLT', name: 'Тромбоциты', device_code: '', device_code_confirmed: 0, sort_order: 2 }),
    analyte({ id: 'a-4', code: 'X', name: '', device_code: 'WBC', device_code_confirmed: 1, sort_order: 3 }),
  ];
  const root = await mountPanels();
  findButtonByText(root, /Сохранить панель/).click();
  await tick(80);
  const ins = writes.find((w) => w.table === 'lab_panel_analytes' && w.op === 'insert');
  assert.ok(ins, 'сохранено: ' + toastMsg);
  assert.deepStrictEqual([].concat(ins.values).map((r) => r.name), ['Лейкоциты', 'Эритроциты', 'Тромбоциты'],
    'строка без имени не сохраняется — и спором не считается');
});

// LIS_ANALYZER_LIST_V1 — у панели выбирают из ДОБАВЛЕННЫХ приборов: находка,
// которую ещё не добавили, не выглядит выбранным прибором. Уже привязанный
// показывается всегда — иначе привязка молча стала бы «— нет —».
const deviceSelect = (root) => walk(root).find((n) => n.tagName === 'SELECT'
  && walk(n).some((o) => o.tagName === 'OPTION' && textOf(o) === '— нет —'));

test('«Анализатор» у панели: находка, которую не добавили, не предлагается', async () => {
  setEffectiveFromRole(LAB_SEEDED);
  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick(80);
  const labels = walk(deviceSelect(root)).filter((n) => n.tagName === 'OPTION').map((o) => textOf(o));
  assert.ok(labels.includes('Гематология'), labels.join(' | '));
  assert.ok(!labels.includes('Найденный BC-5300'), 'ненажатая находка не в списке');
});

test('«Анализатор» у панели: уже привязанный прибор виден, даже если он не добавлен', async () => {
  const was = PANELS[0].device_id;
  PANELS[0].device_id = 2;
  try {
    setEffectiveFromRole(LAB_SEEDED);
    const root = mk('div');
    await renderLaboratory(root, { payload: { sub: 'panels' } });
    await tick(80);
    const labels = walk(deviceSelect(root)).filter((n) => n.tagName === 'OPTION').map((o) => textOf(o));
    assert.ok(labels.includes('Найденный BC-5300'), 'привязка не превращается молча в «— нет —»: ' + labels.join(' | '));
  } finally { PANELS[0].device_id = was; }
});
