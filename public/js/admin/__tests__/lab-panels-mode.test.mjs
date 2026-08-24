// LAB_PANELS_MODE_V1 (docs/plans/2026-08-24-lab-panels-and-roles.md, Task 1) —
// panel editing reachable from Лаборатория, so a lab technician never has to be
// handed the whole Settings hub to fill in a reference range.
//
// What is actually guarded here:
//   * the Очередь | Панели switch does not exist for a lab user who may not
//     manage lab settings — the read-only technician sees the queue and nothing
//     that hints at a door they cannot open;
//   * it does exist for a labs-EDIT role (the owner's actual case) and for an
//     admin, and clicking «Панели» renders the panel editor in place;
//   * Настройки → «Лаборатория и диагностика» still renders that SAME editor —
//     the assertion that keeps «one implementation, two entry points» honest,
//     because a copy-paste fork would drift the moment either side is fixed;
//   * '#labs/panels' works in both directions: the mode writes it into the
//     address bar, and a boot that hands it back (ctx.payload.sub) opens the
//     editor — but never for a role without the right, whatever the URL says.

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
const findAllButtons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const findButtonByText = (root, re) => findAllButtons(root).find((b) => re.test(textOf(b)));
const findByAriaLabel = (root, label) => walk(root).find((n) => n.attrs['aria-label'] === label);
// The switch is identified by its accessible name, not by '.segmented': the
// queue's own status filter is a .segmented too, and asserting on the class
// would pass for the wrong control.
const modeSwitch = (root) => walk(root).find((n) => n.className === 'segmented' && n.attrs['aria-label'] === 'Режим раздела');
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
// db-client.js POSTs one descriptor per read; answer by table so both the queue
// and the panel editor get shaped rows out of the same server.
const PANELS = [
  { id: 'p-1', company_id: 'c-1', name: 'Общий анализ крови', modality: 'lab', has_narrative: false, service_id: 's-1', active: true },
];
const ANALYTES = [
  { id: 'a-1', panel_id: 'p-1', name: 'Гемоглобин', unit: 'г/л', value_type: 'numeric', decimals: 1,
    ref_low: 120, ref_high: 160, ref_low_m: 130, ref_high_m: 170, ref_low_f: 120, ref_high_f: 150,
    group_label: '', sort_order: 0, ref_ranges: null },
];
const SERVICES = [{ id: 's-1', name: 'ОАК', type: 'lab', is_lab: true, department_id: 'd-1', type_id: null }];

let dbTables = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    dbTables.push(table);
    const rows = {
      lab_panels: PANELS,
      lab_panel_analytes: ANALYTES,
      services: SERVICES,
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [],
      visit_services: [],
      visits: [],
      lab_results: [],
    }[table] || [];
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { renderLabSettings } = await import('../views/lab-settings.js');
const { setFullAccess, setEffectiveFromRole, canManageLabSettings } = await import('../permissions.js');

// Two roles that matter. «Лаборант (чтение)» holds Лаборатория at viewer level
// and nothing else — the person the switch must stay away from. «Лаборант»
// holds it at editor level, which is what canManageLabSettings() already
// accepts, so the plan needed no new permission key.
const LAB_VIEWER = { name: 'Лаборант (чтение)', permissions: { sections: ['labs'], levels: { labs: 'viewer' } } };
const LAB_EDITOR = { name: 'Лаборант',          permissions: { sections: ['labs'], levels: { labs: 'editor' } } };

function reset() { toastMsg = null; dbTables = []; lastHistoryUrl = null; historyWrites = 0; tabSubCalls = []; }

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

test('роль без права на настройки лаборатории: переключателя нет вовсе, только очередь', async () => {
  reset();
  setEffectiveFromRole(LAB_VIEWER);
  assert.strictEqual(canManageLabSettings(), false, 'предпосылка теста: право не дано');

  const root = mk('div');
  await renderLaboratory(root, {});
  await tick();

  assert.strictEqual(modeSwitch(root), undefined, 'переключатель режима не отрисован');
  assert.ok(!findButtonByText(root, /^Панели$/), 'кнопки «Панели» нет ни в каком виде — не отключённой, никакой');
  const text = textOf(root);
  assert.ok(text.includes('Лаборатория'), 'очередь на месте');
  assert.ok(text.includes('Очередь проб'), 'подзаголовок очереди');
  assert.ok(!text.includes('Из каталога'), 'редактор панелей не смонтирован');
});

test('роль с правом на редактирование лаборатории: переключатель есть, «Панели» открывают редактор', async () => {
  reset();
  setEffectiveFromRole(LAB_EDITOR);
  assert.strictEqual(canManageLabSettings(), true, 'labs=editor уже даёт это право');

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

test('#labs/panels открывает редактор сразу (ctx.payload.sub), но только тому, кому можно', async () => {
  reset();
  setFullAccess('Администратор');
  const root = mk('div');
  await renderLaboratory(root, { payload: { sub: 'panels' } });
  await tick();
  assertPanelEditor(root, 'по прямой ссылке');

  // Тот же адрес у роли без права — молча очередь. Ссылка не может выдать доступ.
  reset();
  setEffectiveFromRole(LAB_VIEWER);
  const root2 = mk('div');
  await renderLaboratory(root2, { payload: { sub: 'panels' } });
  await tick();
  assert.strictEqual(modeSwitch(root2), undefined, 'переключателя по-прежнему нет');
  assert.ok(!textOf(root2).includes('Из каталога'), 'редактор не открылся по ссылке');
  assert.ok(textOf(root2).includes('Очередь проб'), 'показана очередь');
});

test('Настройки → «Лаборатория и диагностика» рисуют ТОТ ЖЕ редактор', async () => {
  reset();
  setFullAccess('Администратор');
  const nav = [];
  const root = mk('div');
  await renderLabSettings(root, { onNavigate: (v) => nav.push(v) });
  await tick();

  const text = textOf(root);
  assert.ok(text.includes('Лаборатория и диагностика'), 'заголовок раздела настроек');
  assert.ok(text.includes('lab-v6'), 'маркер сборки на месте — по нему диагностируют «я не вижу изменений»');
  assertPanelEditor(root, 'из настроек');

  const back = findButtonByText(root, /Настройки/);
  assert.ok(back, 'кнопка возврата');
  back.click();
  assert.deepStrictEqual(nav, ['settings'], 'возврат ведёт в Настройки');
});

test('оба входа дают один и тот же экран — не две копии редактора', async () => {
  reset();
  setFullAccess('Администратор');

  const fromLabs = mk('div');
  await renderLaboratory(fromLabs, { payload: { sub: 'panels' } });
  await tick();

  const fromSettings = mk('div');
  await renderLabSettings(fromSettings, {});
  await tick();

  // Сравниваем сам редактор: набор кнопок под шапкой должен совпадать
  // дословно. Разойдётся — значит появилась вторая реализация.
  const editorButtons = (root) => findAllButtons(root)
    .map(textOf).map((s) => s.trim())
    .filter((s) => s && s !== 'Очередь' && s !== 'Панели' && s !== '← Настройки');
  assert.deepStrictEqual(editorButtons(fromLabs), editorButtons(fromSettings),
    'редактор в Лаборатории и в Настройках — один и тот же модуль');
});
