// REFERRALS_CRM_V1 (2026-10-26) — экран «Реферирование» под CRM на fake-DOM:
// полоса вкладок с подмаршрутом, вкладка представителей (плитки, пустое
// состояние, группа «Без представителя», закрепление), активность (окно и
// статусы), внутренние врачи (плитки). Fake-DOM harness — как в
// telephony-settings.test.mjs, включая pin 'admin.lang'='ru' ДО импортов.
import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;} remove(){}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(c){if(!this.contains(c))s.className=(s.className+' '+c).trim();},remove(c){s.className=String(s.className).split(/\s+/).filter(x=>x!==c).join(' ');},toggle(c,on){ if(on===undefined) on=!this.contains(c); if(on) this.add(c); else this.remove(c);}};}
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
const bodyEl = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:bodyEl,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

function makeLocalStorage() {
  const store = new Map();
  return { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');
const replaced = [];
globalThis.history = { replaceState: (st, _t, url) => { replaced.push(url); } };
const tabSubs = [];
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: { id: 1, role: 'admin' } } },
  easymedSetTabSub: (tab, sub) => { tabSubs.push([tab, sub]); }, open: () => null, confirm: () => true };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const findAll = (root, pred) => walk(root).filter(pred);
const byAttr = (root, name) => findAll(root, (n) => name in n.attrs);
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); } });
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const calls = [];
let reps = [{ id: 4, full_name: 'Представитель Один' }];
const SOURCES = [
  { id: 1, code: '0003', name: 'Абдурахманова Дилара', phone: '998912098887', workplace: 'Джизак', specialty: 'Терапевт', representative_id: null, visits: 23, patients: 22, received: 3780000, reward: 0 },
  { id: 2, code: '0086', name: 'Набиев Ойбек', phone: '+998 90 310 65 70', workplace: 'Джизак', specialty: 'ЛОР', representative_id: 4, visits: 12, patients: 12, received: 1730000, reward: 0 },
];
function repsReply() {
  return { from: '2026-10-01', to: '2026-10-26', money: true, representatives: reps, sources: SOURCES.map((s) => ({ ...s })),
    totals: { representatives: reps.length, assigned: 1, unassigned: 1, patients: 34, received: 5510000 } };
}
const ACTIVITY = (days) => ({ days, today: '2026-10-26', representatives: reps, sources: [
  { id: 1, code: '0003', name: 'Абдурахманова Дилара', specialty: 'Терапевт', workplace: 'Джизак', representative_id: null, last_visit: '2026-10-25', current: 5, previous: 2, total: 40, status: 'active', telegram: false },
  { id: 2, code: '0086', name: 'Набиев Ойбек', specialty: 'ЛОР', workplace: '', representative_id: 4, last_visit: '2026-08-30', current: 0, previous: 1, total: 3, status: 'fading', telegram: true },
  { id: 3, code: '0243', name: 'Абдувалиев Исмоил', specialty: 'ЛОР', workplace: '', representative_id: null, last_visit: null, current: 0, previous: 0, total: 0, status: 'never', telegram: false },
], totals: { active: 1, fading: 1, passive: 0, never: 1 } });
const INTERNAL = { from: '2026-10-01', to: '2026-10-26', money: true, doctors: [
  { id: 3, full_name: 'Абдуллаев Ахмаджон', specialty: 'Травматолог-ортопед', referrals: 4, done: 2, waiting: 1, cancelled: 1, patients: 3, amount: 900000, reward: 90000 },
], totals: { doctors_referring: 1, referrals: 4, done: 2, waiting: 1, cancelled: 1, amount: 900000, reward: 90000 } };

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    calls.push({ name, body });
    if (name === 'referrals_representatives') return jsonOk(repsReply());
    if (name === 'referrals_activity') return jsonOk(ACTIVITY(body && body.days));
    if (name === 'referrals_internal') return jsonOk(INTERNAL);
    if (name === 'referrals_assign_representative') return jsonOk({ source_id: body.source_id, representative_id: body.user_id });
    if (name === 'referrals_source_detail') return jsonOk({ source: SOURCES[0], from: '2026-10-01', to: '2026-10-26', money: true, visits: [], patients: 0, received: 0, reward: 0 });
    return jsonOk({});
  }
  if (u.startsWith('/api/db')) { calls.push({ name: 'db', body }); return jsonOk([]); }
  return jsonOk({});
};

const perms = await import('../permissions.js');
perms.setFullAccess('Администратор');
const { renderReferrals, TABS } = await import('../views/referrals.js');

async function mount(sub = null) {
  calls.length = 0; replaced.length = 0; tabSubs.length = 0; toastMsg = null;
  const root = mk('div');
  const api = await renderReferrals(root, { tabId: 'pane-1', payload: sub ? { sub } : null, onNavigate: () => {} });
  await tick();
  return { root, api };
}
const tabButtons = (root) => findAll(root, (n) => n.tagName === 'BUTTON' && n.attrs.role === 'tab');
const panel = (root, id) => findAll(root, (n) => n.attrs['data-tab-panel'] === id)[0];

test('полоса вкладок: пять вкладок в порядке снимка, «Представители» раскрыта по умолчанию и смонтирована одна', async () => {
  const { root } = await mount();
  assert.ok(textOf(root).includes('Реферирование'), 'имя экрана');
  // Кнопка несёт и разметку значка (fake-DOM кладёт svg текстом), поэтому — includes, не равенство.
  const buttons = tabButtons(root);
  assert.strictEqual(buttons.length, TABS.length);
  TABS.forEach((t, i) => assert.ok(textOf(buttons[i]).includes(t.label), 'вкладка ' + t.label));
  assert.deepStrictEqual(TABS.map((t) => t.label), ['Представители', 'Врачи-источники', 'Внутренние врачи', 'Категории источников', 'Активность врачей', 'Telegram-бот']);
  assert.strictEqual(TABS.find((t) => t.id === 'bot').adminOnly, true, 'токен бота — только администратору');
  assert.strictEqual(tabButtons(root)[0].attrs['aria-selected'], 'true');
  assert.strictEqual(panel(root, 'reps').style.display, '');
  assert.strictEqual(panel(root, 'activity').style.display, 'none');
  assert.ok(calls.some((c) => c.name === 'referrals_representatives'), 'вкладка представителей загрузилась');
  assert.ok(!calls.some((c) => c.name === 'referrals_activity'), 'активность не грузится, пока вкладка не открыта');
});

test('подмаршрут: #referrals/activity открывает вкладку активности; переключение пишет hash и сообщает оболочке', async () => {
  const { root } = await mount('activity');
  assert.strictEqual(panel(root, 'activity').style.display, '');
  assert.ok(calls.some((c) => c.name === 'referrals_activity'));
  tabButtons(root)[2].click();
  await tick();
  assert.strictEqual(replaced[replaced.length - 1], '#referrals/internal');
  assert.deepStrictEqual(tabSubs[tabSubs.length - 1], ['pane-1', 'internal']);
  assert.ok(calls.some((c) => c.name === 'referrals_internal'));
  tabButtons(root)[0].click();
  await tick();
  assert.strictEqual(replaced[replaced.length - 1], '#referrals', 'вкладка по умолчанию — без подмаршрута');
});

test('представители: плитки, группы «представитель» и «Без представителя», подписи строки «№ код · телефон», деньги с суммой', async () => {
  const { root } = await mount();
  const t = textOf(root);
  for (const label of ['Представителей', 'Врачей закреплено', 'Без представителя', 'Пациентов за период', 'Получено за период']) assert.ok(t.includes(label), 'плитка ' + label);
  assert.ok(t.includes('5 510 000'), 'получено за период с разрядами');
  assert.ok(!t.includes('Медпредставителей пока нет'), 'при наличии представителя пустого состояния нет');
  const groups = byAttr(root, 'data-ref-group').map((g) => g.attrs['data-ref-group']);
  assert.deepStrictEqual(groups, ['rep:4', 'none']);
  assert.ok(t.includes('№ 0003 · 998912098887 · Терапевт'));
  assert.ok(t.includes('Абдурахманова Дилара') && t.includes('Набиев Ойбек'));
  const selects = byAttr(root, 'data-ref-assign');
  assert.strictEqual(selects.length, 2);
  assert.ok(selects.every((s) => !s.attrs.disabled), 'полный доступ закрепляет');
});

test('представители: без medrep — карточка-подсказка, группа «Без представителя» всё равно есть', async () => {
  const saved = reps; reps = [];
  try {
    const { root } = await mount();
    const t = textOf(root);
    assert.ok(t.includes('Медпредставителей пока нет'));
    assert.ok(t.includes('Заведите сотрудника с ролью «Медпредставитель»'));
    assert.deepStrictEqual(byAttr(root, 'data-ref-group').map((g) => g.attrs['data-ref-group']), ['none']);
  } finally { reps = saved; }
});

test('закрепление: выбор представителя шлёт {source_id, user_id}, снятие — user_id null; строка переезжает в группу', async () => {
  const { root } = await mount();
  const sel = byAttr(root, 'data-ref-assign').find((s) => s.attrs['data-ref-assign'] === '1');
  sel.value = '4';
  sel.dispatchEvent({ type: 'change' });
  await tick();
  const c = calls.find((x) => x.name === 'referrals_assign_representative');
  assert.deepStrictEqual(c.body, { source_id: 1, user_id: 4 });
  assert.strictEqual(toastMsg, 'Врач закреплён за представителем.');
  const groups = byAttr(root, 'data-ref-group').map((g) => g.attrs['data-ref-group']);
  assert.deepStrictEqual(groups, ['rep:4'], 'оба врача у представителя — группы «Без представителя» больше нет');
  const sel2 = byAttr(root, 'data-ref-assign').find((s) => s.attrs['data-ref-assign'] === '1');
  sel2.value = '';
  sel2.dispatchEvent({ type: 'change' });
  await tick();
  const c2 = calls.filter((x) => x.name === 'referrals_assign_representative').pop();
  assert.deepStrictEqual(c2.body, { source_id: 1, user_id: null });
});

test('активность: плитки по статусам, окно по умолчанию 30 дней, смена окна перечитывает с days=7, статусы и Telegram в строках', async () => {
  const { root } = await mount('activity');
  const first = calls.find((c) => c.name === 'referrals_activity');
  assert.deepStrictEqual(first.body, { days: 30, representative_id: 'all' });
  const t = textOf(root);
  for (const label of ['Активные', 'Затихают', 'Пассивные', 'Ни разу не направляли']) assert.ok(t.includes(label), 'плитка ' + label);
  assert.ok(t.includes('За 30 дн.'), 'заголовок колонки называет окно');
  const rows = byAttr(root, 'data-ref-status');
  assert.deepStrictEqual(rows.map((r) => r.attrs['data-ref-status']), ['active', 'fading', 'never']);
  assert.ok(t.includes('Активный') && t.includes('Затихает') && t.includes('Ни разу не направлял'));
  assert.ok(t.includes('никогда'), 'без визитов — «никогда»');
  assert.ok(t.includes('подключён'), 'подключённый к боту врач отмечен');
  assert.ok(t.includes('+3'), 'динамика 5 против 2');
  const win = byAttr(root, 'data-ref-window')[0];
  win.value = '7';
  win.dispatchEvent({ type: 'change' });
  await tick();
  const last = calls.filter((c) => c.name === 'referrals_activity').pop();
  assert.deepStrictEqual(last.body, { days: 7, representative_id: 'all' });
  assert.ok(textOf(root).includes('За 7 дн.'));
});

test('внутренние врачи: шесть плиток и строка врача с числами', async () => {
  const { root } = await mount('internal');
  const t = textOf(root);
  for (const label of ['Врачей направляли', 'Направлений', 'Выполнено', 'Ожидают', 'Сумма выполненных', 'Вознаграждение']) assert.ok(t.includes(label), 'плитка ' + label);
  assert.ok(t.includes('Абдуллаев Ахмаджон') && t.includes('Травматолог-ортопед'));
  assert.ok(t.includes('90 000'), 'вознаграждение с разрядами');
  const row = byAttr(root, 'data-ref-doctor')[0];
  assert.ok(row, 'строка врача');
});
