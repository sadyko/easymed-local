// LIS_MINDRAY_CODES_V1 (ревью 2026-09-28) — Лаборатория → «Анализаторы»,
// карточка «Необработанные».
//
// R1. Лоток читал последние 100 неразобранных строк (resolved_at IS NULL) и
// только потом отбрасывал applied на клиенте. Принятые пробы никто не
// разбирает, а с правилом «тихого лотка» их большинство: сотня заполнялась
// ими, настоящая беда (смазанный штрихкод — unmatched) выпадала из окна, и
// экран говорил «Все результаты разложены по бланкам.» Фильтр по статусу
// теперь в самом запросе — до limit.
import { test } from 'node:test';
import assert from 'node:assert';

// Fake-DOM harness — copied from __tests__/lab-panels-mode.test.mjs (itself
// from telephony-settings / system-view / activation tests) because these
// views also render Icon() calls, which go through ui.js's html() -> a
// <template> parse.
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
// this same store's 'admin.lang'. Pinning 'ru' BEFORE the view import is what
// makes the Russian-string assertions hold on an English-locale runner.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){},
  dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  prompt: () => null,
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');

// A toast node, so ui.js reuses it instead of appending to the fake body. Its
// text is kept OUTSIDE `_t`: toast() stores its dismiss timer in `el._t`, which
// is exactly the field this fake DOM keeps text in.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- fake сервер --------------------------------------------------------------
// lab_device_messages отвечает КАК СЕРВЕР: фильтры, порядок и limit из
// дескриптора применяются к набору строк. Иначе тест не отличил бы фильтр в
// запросе от фильтра на клиенте — а ошибка была ровно в этом.
let MESSAGES = [];
let messageReads = [];
let serverIgnoresStatus = false;   // «старый сервер»: фильтр по статусу не применён

function serveMessages(desc) {
  let rows = MESSAGES.map((r) => ({ ...r }));
  for (const f of desc.filters || []) {
    if (f.op === 'is') rows = rows.filter((r) => (r[f.col] ?? null) === f.val);
    else if (f.op === 'eq') rows = rows.filter((r) => r[f.col] === f.val);
    else if (f.op === 'neq') { if (!(serverIgnoresStatus && f.col === 'status')) rows = rows.filter((r) => r[f.col] !== f.val); }
    else throw new Error('фильтр не эмулирован: ' + JSON.stringify(f));
  }
  for (const o of [...(desc.order || [])].reverse()) {
    const dir = o.asc ? 1 : -1;
    rows.sort((a, b) => (a[o.col] > b[o.col] ? 1 : a[o.col] < b[o.col] ? -1 : 0) * dir);
  }
  return desc.limit != null ? rows.slice(0, desc.limit) : rows;
}

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    if (body && body.table === 'lab_device_messages') {
      messageReads.push(body);
      return { ok: true, json: async () => ({ data: serveMessages(body) }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, args: body });
    if (name === 'lis_message_attach') return { ok: true, json: async () => ({ data: attachAnswer }) };
    return { ok: true, json: async () => ({ data: [] }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};
let rpcCalls = [];
let attachAnswer = null;

const { mountLabDevices, stopLabDevicesLive } = await import('../views/lab-devices.js');

const at = (min) => new Date(Date.parse('2026-09-28T09:00:00Z') + min * 60000).toISOString();
const row = (id, status, min, extra = {}) => ({
  id, device_id: 1, peer: '10.0.0.5', raw: 'MSH|^~\\&|BC-5380', sample_id: 'LAB-' + String(id).padStart(6, '0'),
  visit_service_id: null, status, detail: '', received_at: at(min), resolved_at: null, ...extra,
});

async function mount() {
  const root = mk('div');
  await mountLabDevices(root);
  stopLabDevicesLive();   // живой опрос тесту не нужен
  return root;
}

test('R1: смазанный штрихкод виден в лотке, даже когда за ним полторы сотни принятых проб', async () => {
  // Самая старая строка — настоящая беда; над ней 150 принятых проб, которые
  // никто не разбирает (applied и не надо разбирать).
  MESSAGES = [row(777, 'unmatched', 0, { detail: 'заказ по номеру пробы не найден' })];
  for (let i = 1; i <= 150; i++) MESSAGES.push(row(1000 + i, 'applied', i));
  messageReads = [];

  const root = await mount();

  const d = messageReads[0];
  assert.ok(d, 'лоток прочитан');
  assert.deepStrictEqual(d.filters.find((f) => f.col === 'resolved_at'), { col: 'resolved_at', op: 'is', val: null });
  assert.deepStrictEqual(d.filters.find((f) => f.col === 'status'), { col: 'status', op: 'neq', val: 'applied' },
    'принятые отсеиваются в ЗАПРОСЕ, до limit: ' + JSON.stringify(d.filters));
  assert.strictEqual(d.limit, 100);

  const text = textOf(root);
  assert.ok(text.includes('LAB-000777'), 'проба со смазанным штрихкодом в лотке');
  assert.ok(!text.includes('Все результаты разложены по бланкам.'), 'ложное «всё разложено» не показано');
});

// R9. Ручная привязка говорила «Сообщение применено» по одному ACK — даже
// когда бланк заполнился не весь. Сервер теперь отдаёт статус новой строки
// лотка, и экран говорит, что именно вышло.
test('R9: привязка — «применено» только при applied; принято, но бланк не весь — предупреждение с причиной', async () => {
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const cases = [
    { answer: { ok: true, code: 'AA', status: 'applied', detail: '' }, text: 'Сообщение применено', kind: 'info' },
    { answer: { ok: true, code: 'AA', status: 'unmapped', detail: 'не пришли: Гемоглобин (HGB)' },
      text: 'Сообщение принято, но бланк заполнен не полностью: не пришли: Гемоглобин (HGB)', kind: 'warn' },
    { answer: { ok: true, code: 'AA', status: 'unmatched', detail: 'услуга «ОАК» не помечена как лабораторная' },
      text: 'Приём не применил сообщение — смотрите лоток', kind: 'fail' },
    { answer: { ok: false, code: 'AE', status: 'rejected', detail: 'ошибка записи' },
      text: 'Приём не применил сообщение — смотрите лоток', kind: 'fail' },
  ];
  const prevPrompt = window.prompt;
  window.prompt = () => '123';
  try {
    for (const c of cases) {
      MESSAGES = [row(42, 'unmatched', 1, { sample_id: 'LAB-000124', detail: 'заказ по номеру пробы не найден' })];
      attachAnswer = c.answer;
      rpcCalls = [];
      toastMsg = null;
      const root = await mount();
      const btn = walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n) === 'Привязать');
      assert.ok(btn, 'у строки лотка есть «Привязать»');
      btn.click();
      await tick();
      const call = rpcCalls.find((x) => x.name === 'lis_message_attach');
      assert.deepStrictEqual(call && call.args, { id: 42, visit_service_id: 123 });
      assert.strictEqual(toastMsg, c.text, 'status ' + c.answer.status);
      assert.strictEqual(toastEl.dataset.kind, c.kind, 'status ' + c.answer.status);
      stopLabDevicesLive();
    }
  } finally { window.prompt = prevPrompt; }
});

test('R1: фильтр на клиенте остаётся — принятая проба не показана, даже если сервер её прислал', async () => {
  MESSAGES = [row(5, 'applied', 5), row(6, 'unmapped', 6, { detail: 'не пришли: Гемоглобин (HGB)' })];
  serverIgnoresStatus = true;
  try {
    const text = textOf(await mount());
    assert.ok(text.includes('LAB-000006'));
    assert.ok(!text.includes('LAB-000005'), 'applied в лоток не попадает');
  } finally { serverIgnoresStatus = false; }
});
