// LAB_PANELS_BY_SECTION_V1 (2026-08-31, owner: «remove the laboratory and the
// panels settings from the settings, leave only in the lab section with switch.
// and make switch a little bit prominent. user in the system with the role of
// laborant will get exactly this window without giving him a separate
// permission in the settings. who ever will have permission of the lab section
// will be able to edit the panels») — supersedes LAB_PANELS_MODE_V1's gating.
//
// What is actually guarded here:
//   * the gate IS lab-section access: ANY role that can open Лаборатория —
//     viewer included — gets the Очередь | Панели switch and the editor.
//     canEditLabPanels() delegates to the same isModuleAllowed('labs') that
//     decides the sidebar, so the two can never disagree;
//   * the owner's acceptance case, literally: a bare laborant (the seeded
//     'lab' role row, ZERO settings-side configuration) opens '#labs/panels',
//     presses «Сохранить панель», and the write goes to lab_panels /
//     lab_panel_analytes;
//   * a role WITHOUT the labs section gets nothing — no switch, no editor,
//     whatever the address bar says;
//   * the Settings entry is GONE: views/lab-settings.js no longer exists,
//     admin.js neither imports nor routes it, and the old '#lab-settings'
//     address redirects to '#labs/panels' at route resolution;
//   * the switch is the prominent variant (.seg-lg) — the queue's own status
//     filter stays the small one;
//   * LAB_HEAD_ONE_V1 (owner: «make similar across the switching please»):
//     ONE page head for BOTH modes — same title, the switch right of the title
//     in both, built by a single function. The LAB_BUILD marker is NOT screen
//     text any more: it rides as data-lab-build on the head (both modes);
//   * the queue filter chips translate the label as a WHOLE word and compose
//     the count AFTER (I18N_COVERAGE_V1) — the owner photographed «Открытые ·
//     41» on an Uzbek screen because the label was glued to the count first.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const modeSwitch = (root) => walk(root).find((n) => hasClass(n, 'segmented') && n.attrs['aria-label'] === 'Режим раздела');
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

// --- fake /api/db ----------------------------------------------------------
// db-client.js POSTs one descriptor per call; answer by table so both the
// queue and the panel editor get shaped rows out of the same server, and
// RECORD every descriptor's {table, op} — the acceptance test asserts that
// «Сохранить панель» actually writes.
const PANELS = [
  { id: 'p-1', company_id: 'c-1', name: 'Общий анализ крови', modality: 'lab', has_narrative: false, service_id: 's-1', active: true },
];
const ANALYTES = [
  { id: 'a-1', panel_id: 'p-1', name: 'Гемоглобин', unit: 'г/л', value_type: 'numeric', decimals: 1,
    ref_low: 120, ref_high: 160, ref_low_m: 130, ref_high_m: 170, ref_low_f: 120, ref_high_f: 150,
    group_label: '', sort_order: 0, ref_ranges: null },
];
const SERVICES = [{ id: 's-1', name: 'ОАК', type: 'lab', is_lab: true, department_id: 'd-1', type_id: null }];

// Queue rows, EMPTY by default (the older tests were written against an empty
// queue). A test that needs the filter chips to carry counts pushes rows here
// and reset() clears them. The filters are ignored by this fake, so the same
// rows answer both the open-statuses query and the completed-window query —
// each order therefore shows up twice; the chip-count assertions expect that.
const VISIT_SERVICES = [];
const VISITS = [];

let dbCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    dbCalls.push({ table, op: (body && body.op) || 'select' });
    const rows = {
      lab_panels: PANELS,
      lab_panel_analytes: ANALYTES,
      services: SERVICES,
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [],
      visit_services: VISIT_SERVICES,
      visits: VISITS,
      lab_results: [],
    }[table] || [];
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { LAB_BUILD } = await import('../views/lab-panels.js');
const { setLang } = await import('../i18n.js');
const perms = await import('../permissions.js');
const { setFullAccess, setEffectiveFromRole, canEditLabPanels } = perms;

// The three roles that matter now. «lab» is the SEEDED 'lab' row from
// migration 013 verbatim — the owner's acceptance case is that this exact user
// edits panels with zero settings-side configuration. «Медсестра» holds labs at
// viewer level only: under the owner's rule («who ever will have permission of
// the lab section will be able to edit the panels») that is enough.
// «Регистратура» has no labs section at all and must stay outside.
const LAB_SEEDED = { name: 'lab', permissions: { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'editor', patients: 'viewer', dashboard: 'viewer' } } };
const LAB_VIEWER = { name: 'Медсестра', permissions: { sections: ['labs', 'patients', 'dashboard'], levels: { labs: 'viewer', patients: 'editor', dashboard: 'viewer' } } };
const NO_LABS    = { name: 'Регистратура', permissions: { sections: ['patients', 'dashboard'], levels: { patients: 'editor', dashboard: 'viewer' } } };

function reset() { toastMsg = null; dbCalls = []; lastHistoryUrl = null; historyWrites = 0; tabSubCalls = []; VISIT_SERVICES.length = 0; VISITS.length = 0; }

// Markers the panel editor — and only the panel editor — puts on screen.
function assertPanelEditor(root, where) {
  const text = textOf(root);
  assert.ok(text.includes('Из каталога'), where + ': кнопка «Из каталога» — ' + text.slice(0, 200));
  assert.ok(text.includes('Пустая'), where + ': кнопка «Пустая»');
  assert.ok(findByAriaLabel(root, 'Поиск панели'), where + ': поиск панели с доступным именем');
  assert.ok(text.includes('Общий анализ крови'), where + ': панель клиники из lab_panels');
  assert.ok(text.includes('Показатели'), where + ': таблица показателей');
  assert.ok(text.includes('Сохранить панель'), where + ': кнопка сохранения');
}

test('любой доступ к Лаборатории — включая чтение — даёт переключатель, и «Панели» открывают редактор', async () => {
  reset();
  setEffectiveFromRole(LAB_VIEWER);
  assert.strictEqual(canEditLabPanels(), true,
    'правило владельца: раздел виден — панели редактируемы; labs=viewer этого достаточно');

  const root = mk('div');
  await renderLaboratory(root, {});
  await tick();

  const btns = modeButtons(root);
  assert.deepStrictEqual(btns.map(textOf), ['Очередь', 'Панели'], 'двусторонний переключатель в шапке');
  assert.ok(btns[0].className.includes('on'), 'по умолчанию — Очередь');
  assert.strictEqual(btns[0].attrs['aria-pressed'], 'true');
  assert.strictEqual(btns[1].attrs['aria-pressed'], 'false');
  assert.ok(textOf(root).includes('Открытые'), 'фильтры очереди видны в режиме очереди');

  btns[1].click();
  await tick();

  assertPanelEditor(root, 'после переключения');
  assert.ok(!textOf(root).includes('Открытые'), 'фильтры очереди убраны, а не оставлены бесполезными');
  const after = modeButtons(root);
  assert.ok(after[1].className.includes('on'), '«Панели» подсвечены');
  assert.strictEqual(after[1].attrs['aria-pressed'], 'true');

  // и обратно — очередь возвращается целиком
  after[0].click();
  await tick();
  assert.ok(textOf(root).includes('Открытые'), 'возврат в очередь восстанавливает фильтры');
  assert.ok(!textOf(root).includes('Из каталога'), 'редактор убран');
});

test('приёмочный случай владельца: голый лаборант открывает #labs/panels и сохраняет панель — ноль настроек', async () => {
  reset();
  setEffectiveFromRole(LAB_SEEDED);
  assert.strictEqual(canEditLabPanels(), true, 'штатная роль lab проходит без единого settings-ключа');

  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick();
  assertPanelEditor(root, 'по прямой ссылке');

  const save = findButtonByText(root, /Сохранить панель/);
  assert.ok(save, 'кнопка сохранения на месте');
  save.click();
  await tick();

  assert.strictEqual(toastMsg, 'Панель сохранена', 'сохранение дошло до конца');
  const writes = dbCalls.filter((c) => c.op !== 'select');
  assert.ok(writes.some((c) => c.table === 'lab_panels' && c.op === 'update'),
    'панель записана в lab_panels: ' + JSON.stringify(writes));
  assert.ok(writes.some((c) => c.table === 'lab_panel_analytes' && c.op === 'insert'),
    'показатели перезаписаны (insert новых): ' + JSON.stringify(writes));
  assert.ok(writes.some((c) => c.table === 'lab_panel_analytes' && c.op === 'delete'),
    'reconcile добрал удаление старых строк: ' + JSON.stringify(writes));
});

test('роль без раздела Лаборатория: ни переключателя, ни редактора — даже по прямой ссылке', async () => {
  reset();
  setEffectiveFromRole(NO_LABS);
  assert.strictEqual(canEditLabPanels(), false, 'нет labs — нет панелей');

  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick();

  assert.strictEqual(modeSwitch(root), undefined, 'переключатель режима не отрисован');
  assert.ok(!findButtonByText(root, /^Панели$/), 'кнопки «Панели» нет ни в каком виде — не отключённой, никакой');
  assert.ok(!textOf(root).includes('Из каталога'), 'редактор не открылся по ссылке');
  assert.ok(textOf(root).includes('Очередь проб'), 'показана очередь');
  // (в живой оболочке этот пользователь не дошёл бы и сюда: renderViewInto
  // отсекает '#labs' через isRouteAllowed — это защита в глубину.)
});

test('переключатель заметный: seg-lg на переключателе режима — и только на нём', async () => {
  reset();
  setFullAccess('Администратор');
  const root = mk('div');
  await renderLaboratory(root, {});
  await tick();

  const sw = modeSwitch(root);
  assert.ok(sw, 'переключатель на месте');
  assert.ok(hasClass(sw, 'seg-lg'), 'режимный переключатель — крупный вариант: ' + sw.className);
  const smallSegments = walk(root).filter((n) => hasClass(n, 'segmented') && n !== sw);
  assert.ok(smallSegments.length >= 1, 'фильтр очереди — тоже .segmented (иначе сравнивать не с чем)');
  for (const s of smallSegments) assert.ok(!hasClass(s, 'seg-lg'), 'фильтры очереди остаются мелкими');

  // Класс без правила — невидимая «заметность»: разметка получила seg-lg, а
  // браузер рисовал бы обычную мелкую пилюлю. admin-views.css обязан объявлять
  // вариант, и его активная сторона — заливка primary, не белая карточка.
  const css = fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8');
  assert.match(css, /\.segmented\.seg-lg\s*\{/, 'вариант .seg-lg объявлен в admin-views.css');
  assert.match(css, /\.segmented\.seg-lg button\.on\s*\{[^}]*var\(--primary-600\)/,
    'активная сторона крупного варианта залита primary — то самое «a little bit prominent»');
});

// LAB_HEAD_ONE_V1 — the owner's two screenshots showed two DIFFERENT heads:
// the queue drew the switch beside the title, the editor pushed it to the far
// right and grew a grey «lab-v7» after the title. One head, one builder, both
// modes — the queue layout is the base.
test('одна шапка на оба режима: заголовок, рядом с ним переключатель, подзаголовок — одинаково в очереди и в «Панелях»', async () => {
  setFullAccess('Администратор');
  for (const [name, ctx] of [['очередь', {}], ['панели', { payload: { sub: 'panels' } }]]) {
    reset();
    const root = mk('div');
    await renderLaboratory(root, ctx);
    await tick();

    const heads = walk(root).filter((n) => hasClass(n, 'page-head'));
    assert.strictEqual(heads.length, 1, name + ': ровно одна шапка');

    const title = walk(root).find((n) => n.tagName === 'H1');
    assert.ok(title && textOf(title).includes('Лаборатория'), name + ': тот же заголовок');

    const sw = modeSwitch(root);
    assert.ok(sw, name + ': переключатель на месте');
    assert.ok(hasClass(sw, 'seg-lg'), name + ': тот же крупный вариант');

    // The switch stands NEXT TO THE TITLE — same row, same parent — in BOTH
    // modes, never parked in the right-hand actions block (that is exactly
    // where the panels mode used to drift it to).
    const swParent = parentOf(root, sw);
    assert.ok(swParent && swParent.children.some((c) => c.tagName === 'H1'),
      name + ': переключатель в одном ряду с заголовком');
    const actions = walk(root).find((n) => hasClass(n, 'page-head-actions'));
    assert.ok(!actions || !walk(actions).includes(sw), name + ': и НЕ в блоке действий справа');

    assert.ok(walk(root).some((n) => hasClass(n, 'page-subtitle')), name + ': подзаголовок есть в обоих режимах');
  }

  // «Not two heads that agree by coincidence»: the head is built in ONE place
  // in the source — a second `class: 'page-head'` site is how the drift began.
  const labSrc = fs.readFileSync(path.resolve(HERE, '..', 'views', 'laboratory.js'), 'utf8');
  assert.strictEqual((labSrc.match(/['"]page-head['"]/g) || []).length, 1,
    'шапку собирает одно место в laboratory.js — не два, совпадающих по случайности');
});

test('маркер сборки не показывается пользователю: не текст на экране, а data-атрибут шапки — в обоих режимах', async () => {
  setFullAccess('Администратор');
  for (const [name, ctx] of [['панели', { payload: { sub: 'panels' } }], ['очередь', {}]]) {
    reset();
    const root = mk('div');
    await renderLaboratory(root, ctx);
    await tick();
    assert.ok(!textOf(root).includes(LAB_BUILD),
      name + ': пользователь маркер сборки не видит — он не для него');
    const head = walk(root).find((n) => hasClass(n, 'page-head'));
    assert.strictEqual(head && head.attrs['data-lab-build'], LAB_BUILD,
      name + ': след для диагностики «я не вижу изменений» остаётся — data-lab-build на шапке (видно в инспекторе)');
  }
});

// I18N_COVERAGE_V1, the owner's photo: «Открытые · 41» on an Uzbek screen.
// The label was glued to the count BEFORE translation, and tr() matches whole
// strings — no dictionary entry can rescue 'Открытые · 41'. The label must be
// translated as a whole word and the count composed AFTER.
test('чипы фильтра очереди переводятся: слово целиком, счётчик после — узбекский экран без русских слов', async () => {
  reset();
  setFullAccess('Администратор');
  VISIT_SERVICES.push({ id: 1, visit_id: 'v-1', service_id: 's-1', status: 'queued', sample_collected_at: null,
    services: { name: 'OAK', is_lab: true, type: 'lab', department_id: 'd-1', type_id: null, tube_color: null, specimen: null } });
  VISITS.push({ id: 'v-1', visit_date: '2026-08-30',
    patients: { id: 'pt-1', full_name: 'Test Bemor', mrn: 'M-1', gender: 'male', date_of_birth: '1990-01-01' } });

  const chipTexts = (root) => {
    const wrap = walk(root).find((n) => hasClass(n, 'segmented') && !hasClass(n, 'seg-lg'));
    assert.ok(wrap, 'фильтры очереди на месте');
    return findAllButtons(wrap).map(textOf);
  };

  try {
    setLang('uz');
    const root = mk('div');
    await renderLaboratory(root, {});
    await tick();
    const texts = chipTexts(root);
    // The fake db answers both the open and the completed query with the same
    // row, so every matching chip counts it twice.
    assert.deepStrictEqual(texts,
      ['Ochiq · 2', 'Namuna olish · 2', 'Jarayonda · 0', 'Natijalar · 0', 'Hammasi · 2'],
      'каждый чип — переведённое слово + счётчик');
    assert.ok(!/[Ѐ-ӿ]/.test(texts.join(' ')), 'на узбекском экране в чипах нет кириллицы');
  } finally {
    setLang('ru');   // остальные тесты этого файла закреплены на русских строках
  }

  // и на русском счётчик по-прежнему на месте
  const root2 = mk('div');
  await renderLaboratory(root2, {});
  await tick();
  assert.deepStrictEqual(chipTexts(root2),
    ['Открытые · 2', 'Забор · 2', 'В работе · 0', 'Результаты · 0', 'Все · 2']);
});

test('переключение режима пишет адрес: #labs/panels и обратно #labs (replaceState, без новой записи истории)', async () => {
  reset();
  setFullAccess('Администратор');
  const root = mk('div');
  await renderLaboratory(root, { tabId: 'labs' });
  await tick();

  modeButtons(root)[1].click();
  await tick();
  assert.strictEqual(lastHistoryUrl, '#labs/panels', 'режим оказался в адресной строке');
  assert.deepStrictEqual(history.state, { view: 'labs', payload: { sub: 'panels' } },
    'состояние истории несёт тот же sub, который admin.js вернёт обратно во view');

  modeButtons(root)[0].click();
  await tick();
  assert.strictEqual(lastHistoryUrl, '#labs', 'возврат в очередь убирает подмаршрут');
  assert.strictEqual(historyWrites, 2, 'ровно два replaceState — ни одного pushState');
  assert.deepStrictEqual(tabSubCalls, [['labs', 'panels'], ['labs', null]],
    'оболочка узнаёт о режиме — иначе следующий navigate() перепишет адрес из устаревшего payload вкладки');
});

// ---------------------------------------------------------------------------
// The Settings entry is GONE. admin.js cannot be imported without a real DOM
// (it grabs #view-root at module scope), so the routing half of the change is
// pinned the way clinic-after-login.test.mjs pins boot(): on the source text.
// What a source assertion cannot prove — that a browser actually lands on the
// panels editor from an old bookmark — stays a manual check.
// ---------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const adminSrc = fs.readFileSync(path.resolve(HERE, '..', '..', 'admin.js'), 'utf8');

test('настройки больше не входная точка: экран удалён, маршрут и карточка вычищены', () => {
  assert.ok(!fs.existsSync(path.resolve(HERE, '..', 'views', 'lab-settings.js')),
    'views/lab-settings.js удалён — редактор живёт только в Лаборатории');
  assert.ok(!/from\s+'\.\/admin\/views\/lab-settings\.js/.test(adminSrc), 'admin.js не импортирует lab-settings');
  assert.ok(!/case\s+'lab-settings'/.test(adminSrc), 'маршрута lab-settings больше нет');
  assert.ok(!/renderLabSettings/.test(adminSrc), 'и ссылок на renderLabSettings тоже');

  const hubSrc = fs.readFileSync(path.resolve(HERE, '..', 'views', 'settings-hub.js'), 'utf8');
  assert.ok(!/lab-settings/.test(hubSrc), 'в хабе настроек не осталось входа lab-settings');

  // Отдельное право на настройки лаборатории умерло вместе с экраном.
  assert.strictEqual(perms.canManageLabSettings, undefined,
    'canManageLabSettings удалён — единственный гейт теперь canEditLabPanels (= доступ к разделу labs)');
  const permsSrc = fs.readFileSync(path.resolve(HERE, '..', 'permissions.js'), 'utf8');
  assert.ok(!/settings:lab_settings/.test(permsSrc), 'ключ settings:lab_settings больше не раздаётся в редакторе ролей');
});

test('старый адрес #lab-settings ведёт в #labs/panels (перенаправление на разборе маршрута)', () => {
  // Одна таблица legacy-маршрутов, и оба места, где старый id может всплыть,
  // проходят через неё: navigate() (popstate со старой записью истории, любой
  // застрявший вызов) и parseHash() (вставленная в адресную строку старая
  // ссылка — именно так «старые ссылки не ломаются»).
  assert.match(adminSrc, /LEGACY_ROUTES\s*=\s*\{[^}]*'lab-settings':\s*\{\s*view:\s*'labs',\s*sub:\s*'panels'\s*\}/,
    'таблица legacy-маршрутов объявлена и знает lab-settings → labs/panels');
  const uses = (adminSrc.match(/LEGACY_ROUTES\[/g) || []).length;
  assert.ok(uses >= 2, 'таблица применяется и в navigate(), и в parseHash() — найдено применений: ' + uses);
});
