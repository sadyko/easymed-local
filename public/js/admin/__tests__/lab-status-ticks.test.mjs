// LAB_STATUS_TICKS_V1 (2026-11-21) — ВКЛАДКИ ЛАБОРАТОРИИ = СТАТУСЫ, СТАТУС — ОДНОЙ КНОПКОЙ.
//
// Владелец, 2026-11-21 (снимки «РЕЗУЛЬТАТЫ НЕ ВНЕСЕНЫ · 0 / 3 готово · 3 к забору» и
// «Открытые · 39 · Забор · 21 · В работе · 6 · Результаты · 12 · Все · 324»):
//   «the status of the lab we need to make tick or just click so it changes the status
//    of the analysis. probe is taken, in progress etc. and also the statuses tabs are not
//    transcribing the actual statuses, there is no separate ready section».
// Решения владельца (вопросы 2026-11-21):
//   1. вкладка на КАЖДЫЙ статус: Открытые · Забор · Проба взята · В работе · Внесены ·
//      Готово · Все («Готово» — проверено и выдано, раньше было только во «Все»);
//   2. число на вкладке — ПАЦИЕНТЫ (карточки списка), а не анализы;
//   3. статус — КНОПКАМИ. Сначала владелец выбрал галочки и панель «Отмечено N: …»,
//      посмотрел на :8000 и сказал «its bit hard for user … add buttons?» — второе
//      решение: у пациента одна кнопка следующего шага для всех его анализов
//      («Проба взята · 3», без раскрытия строки), у каждого анализа — своя кнопка
//      следующего шага и стрелка «Вернуть на шаг назад»; панели галочек нет, галочки —
//      только у анализов с результатом (для «Подтвердить» и «Бланк»), как прежде.
// Слово статуса одно на вкладке, на карточке пациента и на строке анализа.
import { test } from 'node:test';
import assert from 'node:assert';

// --- поддельный DOM (тот же, что у lab-card.test.mjs) -------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
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
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
};
globalThis.confirm = () => false;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async () => {} } } });

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const clean = (b) => textOf(b).replace(/<[^>]*>/g, '').trim();
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- поддельный /api/db: читает по статусу, ЗАПИСИ запоминает и применяет ------
let VISIT_SERVICES = [];
let VISITS = [];
let LAB_RESULTS = [];
let UPDATES = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    if (table === 'visit_services' && body.op === 'update') {
      UPDATES.push(body);
      const f = (body.filters || []).find((x) => x && x.col === 'id');
      const ids = f ? (f.op === 'in' ? f.val : [f.val]).map(Number) : [];
      for (const r of VISIT_SERVICES) if (ids.includes(Number(r.id))) Object.assign(r, body.values);
      return { ok: true, json: async () => ({ data: [] }) };
    }
    let rows = {
      visit_services: VISIT_SERVICES, visits: VISITS, lab_results: LAB_RESULTS, admissions: [],
      lab_panels: [], lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }], service_types: [], doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = (body.filters || []).find((x) => x && x.col === 'status');
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const G = await import('../views/lab-grouping.js');
const { STRINGS } = await import('../i18n-strings.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

const P1 = { id: 'p-1', full_name: 'Тестова Пациентка', mrn: 'P-1', gender: 'female', date_of_birth: '1990-01-01' };
const P2 = { id: 'p-2', full_name: 'Тестов Пациент', mrn: 'P-2', gender: 'male', date_of_birth: '1985-05-05' };
const SVC = (name) => ({ name, is_lab: true, type: 'lab', specimen: 'Кровь', tube_color: 'lavender', department_id: 'd-1' });
function vs(id, status, visit = 'v-1', extra = {}) {
  return {
    id, visit_id: visit, service_id: 's-' + id, status,
    sample_collected_at: status === 'queued' ? null : '2026-11-21T08:00:00Z',
    sync_origin: null, services: SVC('Анализ ' + id), ...extra,
  };
}
const res = (id, vsId) => ({ id, visit_service_id: vsId, parameter: 'Гемоглобин', value: '130', unit: 'г/л', flag: 'normal', notes: null, entered_at: '2026-11-21T09:00:00Z' });

async function mount(rows, results = []) {
  VISIT_SERVICES = rows; LAB_RESULTS = results; UPDATES = []; toastMsg = null;
  VISITS = [{ id: 'v-1', visit_date: '2026-11-21', patients: P1 }, { id: 'v-2', visit_date: '2026-11-21', patients: P2 }];
  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  return root;
}
// Вкладки — только в ряду фильтров очереди (.segmented): «Проба взята · 3» есть и у пациента.
const filterRow = (root) => walk(root).find((n) => hasClass(n, 'segmented') && !hasClass(n, 'seg-lg'));
function tabChip(root, label) {
  const row = filterRow(root);
  assert.ok(row, 'ряд вкладок очереди пропал');
  const c = buttons(row).find((b) => clean(b) === label || clean(b).startsWith(label + ' · '));
  assert.ok(c, 'нет вкладки «' + label + '»: ' + buttons(row).map(clean).join(' | '));
  return c;
}
async function openTab(root, label) { tabChip(root, label).click(); await tick(); }
const ticks = (root) => walk(root).filter((n) => n.tagName === 'INPUT' && n.getAttribute('data-pick'));
const cardBtns = (root) => buttons(byClass(byClass(root, 'lq-card')[0], 'lq-do')[0] || mk('div'));
const itemOf = (root, status) => byClass(root, 'lq-item').find((n) => n.getAttribute('data-status') === status);
const rowBtns = (item) => buttons(byClass(item, 'lq-item-do')[0] || mk('div'));
const UNDO = 'Вернуть на шаг назад';
const isUndo = (b) => b.getAttribute('title') === UNDO;

// ═══ 1. ПРАВИЛА — чистые функции (lab-grouping.js) ════════════════════════════

test('вкладки — по одной на статус, в порядке работы, и «Готово» отдельно', () => {
  assert.deepStrictEqual(G.LAB_TABS.map((t) => t.label),
    ['Открытые', 'Забор', 'Проба взята', 'В работе', 'Внесены', 'Готово', 'Все']);
  for (const s of ['queued', 'collected', 'in_progress', 'resulted', 'completed']) {
    const own = G.LAB_TABS.filter((t) => t.key !== 'open' && t.key !== 'all' && t.match(s));
    assert.strictEqual(own.length, 1, s + ': статус попал не в одну вкладку');
    assert.strictEqual(own[0].label, G.LAB_STATUS_WORD[s], s + ': слово вкладки и слово статуса разные');
  }
  const open = G.LAB_TABS.find((t) => t.key === 'open');
  assert.ok(!open.match('completed'), '«Открытые» показывают уже выданное');
  assert.ok(['queued', 'collected', 'in_progress', 'resulted'].every((s) => open.match(s)));
});

test('число на вкладке — пациенты (карточки), а не анализы', () => {
  const rows = [vs(1, 'queued'), vs(2, 'queued'), vs(3, 'queued'),           // пациент 1: три анализа к забору
    vs(4, 'queued', 'v-2'), vs(5, 'resulted', 'v-2'),                         // пациент 2
    vs(6, 'completed', null)];                                                // заказ без визита — своя карточка
  const n = G.labTabCounts(rows);
  assert.strictEqual(n.collect, 2, '«Забор»: три анализа одного пациента — это один пациент');
  assert.strictEqual(n.resulted, 1);
  assert.strictEqual(n.done, 1);
  assert.strictEqual(n.open, 2);
  assert.strictEqual(n.all, 3);
  assert.strictEqual(n.taken, 0);
});

test('«Проба взята»: из забора — со временем взятия; шаг назад из «В работе» время не трогает', () => {
  const NOW = '2026-11-21T10:00:00Z';
  const rows = [vs(1, 'queued'), vs(2, 'in_progress'), vs(3, 'collected'), vs(4, 'resulted'), vs(5, 'in_progress')];
  const hasRes = (r) => r.id === 5;   // результат уже есть — статус ведёт ввод результатов
  const plan = G.labMovePlan(rows, 'collected', hasRes, NOW);
  assert.deepStrictEqual(plan, [
    { ids: [1], values: { status: 'collected', sample_collected_at: NOW } },
    { ids: [2], values: { status: 'collected' } },
  ]);
});

test('«В работу»: из забора и из «Проба взята»; «Вернуть в забор» снимает время взятия', () => {
  const NOW = '2026-11-21T10:00:00Z';
  const rows = [vs(1, 'queued'), vs(2, 'collected'), vs(3, 'in_progress'), vs(4, 'completed')];
  assert.deepStrictEqual(G.labMovePlan(rows, 'in_progress', () => false, NOW), [
    { ids: [1], values: { status: 'in_progress', sample_collected_at: NOW } },
    { ids: [2], values: { status: 'in_progress' } },
  ]);
  assert.deepStrictEqual(G.labMovePlan(rows, 'queued', () => false, NOW), [
    { ids: [2, 3], values: { status: 'queued', sample_collected_at: null } },
  ]);
  assert.deepStrictEqual(G.labMovePlan([vs(9, 'resulted')], 'queued', () => true, NOW), [], 'анализ с результатом кнопками не двигается');
  assert.deepStrictEqual(G.labMovePlan([vs(9, 'queued')], 'queued', () => false, NOW), [], 'в тот же статус — нечего писать');
});

// ═══ 2. ЭКРАН ═════════════════════════════════════════════════════════════════

test('вкладки на экране: все семь, с числом пациентов', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'queued'), vs(3, 'queued'), vs(4, 'queued', 'v-2'), vs(5, 'collected', 'v-2')]);
  for (const [label, n] of [['Открытые', 2], ['Забор', 2], ['Проба взята', 1], ['В работе', 0], ['Внесены', 0], ['Готово', 0], ['Все', 2]]) {
    assert.strictEqual(clean(tabChip(root, label)), label + ' · ' + n, '«' + label + '»: ' + clean(tabChip(root, label)));
  }
  assert.ok(!buttons(root).some((b) => clean(b).startsWith('Результаты ·')), 'старая вкладка «Результаты» осталась');
});

test('«Готово» показывает проверенные и выданные анализы', async () => {
  const root = await mount([vs(1, 'completed'), vs(2, 'queued', 'v-2')], [res(1, 1)]);
  await openTab(root, 'Готово');
  const cards = byClass(root, 'lq-card');
  assert.strictEqual(cards.length, 1);
  assert.ok(textOf(cards[0]).includes(P1.full_name), '«Готово» показывает не того пациента');
  assert.ok(textOf(byClass(cards[0], 'lq-state-card')[0]).includes('Готово'), 'карточка во «Готово» говорит другое слово');
});

test('карточка и строка говорят словом вкладки; «0 / 3 внесено» вместо «готово»', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'queued'), vs(3, 'queued')]);
  const card = byClass(root, 'lq-card')[0];
  const cardWord = textOf(byClass(card, 'lq-state-card')[0]);
  assert.ok(cardWord.includes('Забор'), 'карточка к забору подписана «' + cardWord + '»');
  assert.ok(!textOf(card).includes('Результаты не внесены'), 'осталось «Результаты не внесены»');
  assert.ok(textOf(card).includes('0 / 3 внесено'), 'нет «0 / 3 внесено»: ' + textOf(card));
  assert.ok(!textOf(card).includes('готово'), 'слово «готово» на карточке к забору путает с вкладкой «Готово»');
  for (const it of byClass(card, 'lq-item')) assert.ok(textOf(byClass(it, 'lq-state')[0]).includes('Забор'));
  // Смешанная карточка — по самому отстающему анализу.
  const mixed = await mount([vs(1, 'resulted'), vs(2, 'collected')], [res(1, 1)]);
  assert.ok(textOf(byClass(byClass(mixed, 'lq-card')[0], 'lq-state-card')[0]).includes('Проба взята'));
});

test('кнопка пациента: «Проба взята · 3» — главная и первая; одно нажатие — все три одной записью', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'queued'), vs(3, 'queued')]);
  const first = cardBtns(root)[0];
  assert.strictEqual(clean(first), 'Проба взята · 3', 'первой у пациента стоит «' + clean(first) + '»');
  assert.ok(hasClass(first, 'btn-primary'), '«Проба взята · 3» — не главная кнопка');
  assert.strictEqual(byClass(byClass(root, 'lq-card')[0], 'btn-primary').length, 1, 'главных кнопок у пациента больше одной');
  first.click();
  await tick(60);
  assert.strictEqual(UPDATES.length, 1, 'три анализа — не одна запись: ' + UPDATES.length);
  const f = UPDATES[0].filters.find((x) => x.col === 'id');
  assert.deepStrictEqual({ op: f.op, ids: f.val.map(Number).sort() }, { op: 'in', ids: [1, 2, 3] });
  assert.strictEqual(UPDATES[0].values.status, 'collected');
  assert.ok(UPDATES[0].values.sample_collected_at, 'время взятия не записано');
  const next = cardBtns(root).map(clean);
  assert.ok(next.includes('В работу · 3'), 'после забора у пациента нет «В работу · 3»: ' + next.join(' | '));
  assert.ok(!next.some((t) => t.startsWith('Проба взята')), '«Проба взята» осталась, хотя забирать нечего');
});

test('кнопка пациента двигает только ждущие забора — не взятые, не с результатом', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'resulted'), vs(3, 'collected')], [res(1, 2)]);
  const take = cardBtns(root).find((b) => clean(b).startsWith('Проба взята'));
  assert.strictEqual(clean(take), 'Проба взята · 1');
  assert.ok(!cardBtns(root).some((b) => clean(b).startsWith('В работу')), 'пока есть что забирать, у пациента одна кнопка шага');
  take.click();
  await tick(60);
  assert.deepStrictEqual(UPDATES[0].filters.find((x) => x.col === 'id').val.map(Number), [1]);
  assert.strictEqual(clean(cardBtns(root).find((b) => clean(b).startsWith('В работу'))), 'В работу · 2');
});

test('у каждого анализа — кнопка следующего шага и стрелка назад; у внесённого — нет', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'collected'), vs(3, 'in_progress'), vs(4, 'resulted')], [res(1, 4)]);
  const want = {
    queued: { step: 'Проба взята', undo: false },
    collected: { step: 'В работу', undo: true },
    in_progress: { step: 'Результаты…', undo: true },
    resulted: { step: 'Проверить и выдать', undo: false },
  };
  for (const [status, w] of Object.entries(want)) {
    const item = itemOf(root, status);
    assert.ok(item, status + ': строки нет');
    const btns = rowBtns(item);
    assert.ok(btns.some((b) => clean(b) === w.step), status + ': нет «' + w.step + '»: ' + btns.map(clean).join(' | '));
    assert.strictEqual(btns.some(isUndo), w.undo, status + ': стрелка назад ' + (w.undo ? 'пропала' : 'лишняя'));
    for (const b of btns) assert.ok(!hasClass(b, 'btn-primary'), status + ': на строке анализа залитая кнопка');
  }
});

test('кнопка анализа меняет только его', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'queued')]);
  const item = byClass(root, 'lq-item').find((n) => n.getAttribute('data-vs') === '2');
  assert.ok(item, 'строки «Анализ 2» нет');
  rowBtns(item).find((b) => clean(b) === 'Проба взята').click();
  await tick(60);
  assert.strictEqual(UPDATES.length, 1);
  assert.deepStrictEqual(UPDATES[0].filters.find((x) => x.col === 'id').val.map(Number), [2]);
  assert.strictEqual(UPDATES[0].values.status, 'collected');
  assert.strictEqual(VISIT_SERVICES.find((r) => r.id === 1).status, 'queued', 'сдвинулся соседний анализ');
});

test('стрелка назад: из «Проба взята» — в забор без времени; из «В работе» — в «Проба взята», время то же', async () => {
  const root = await mount([vs(1, 'collected'), vs(2, 'in_progress')]);
  rowBtns(itemOf(root, 'collected')).find(isUndo).click();
  await tick(60);
  assert.deepStrictEqual(UPDATES[0].values, { status: 'queued', sample_collected_at: null });
  UPDATES = [];
  rowBtns(itemOf(root, 'in_progress')).find(isUndo).click();
  await tick(60);
  assert.deepStrictEqual(UPDATES[0].values, { status: 'collected' }, 'шаг назад из «В работе» сбросил время взятия');
});

test('панели галочек нет; галочка — только у анализа с результатом (для «Подтвердить» и «Бланк»)', async () => {
  const root = await mount([vs(1, 'queued'), vs(2, 'resulted')], [res(1, 2)]);
  assert.deepStrictEqual(ticks(root).map((b) => b.getAttribute('data-pick')), ['2']);
  assert.strictEqual(byClass(root, 'lq-tickbar').length, 0);
});

test('новые слова есть в словаре на трёх языках', () => {
  for (const s of ['Внесены', '{done} / {total} внесено', 'Вернуть на шаг назад',
    'Проба взята: {n}', 'В работе: {n}', 'Возвращено в забор: {n}']) {
    const e = STRINGS[s];
    assert.ok(e && e.uz && e.en, '«' + s + '» нет в словаре');
    assert.ok(!/[А-Яа-яЁё]/.test(e.uz) && !/[А-Яа-яЁё]/.test(e.en), '«' + s + '»: кириллица в uz/en');
  }
});
