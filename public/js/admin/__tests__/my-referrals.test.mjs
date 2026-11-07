// MY_REFERRALS_V1 (3.22.0, решение владельца 2026-11-07, п. 11) — вкладка «Мои направления»
// кабинета врача: период уходит на сервер (my_referrals { from, to }, по умолчанию последние 30
// дней по местному календарю), группа и поиск — по ответу; «Результат» только у строки, где
// сервер его разрешил; документ — окном patient_doc_sources (правило карты пациента), у анализа —
// только показатели этой строки. Вкладка — только врачу.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.id='';this._html='';this.parent=null;}
 appendChild(c){this.children.push(c);if(c&&typeof c==='object')c.parent=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){ if(this.parent) this.parent.removeChild(this); } select(){} closest(){return null;}
 querySelector(){return null;} querySelectorAll(){return [];}
 get innerHTML(){return this._html;} set innerHTML(v){this._html=String(v);}
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
const toastEl = mk('div');
const TOASTS = [];
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
const body = mk('body');
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body, documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 1, role: 'doctor', is_doctor: true, full_name: 'Алиев Анвар', extra_roles: [] } } },
  confirm: () => false, open: () => null,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const byAttr = (root, a) => walk(root).filter((n) => n.attrs && a in n.attrs);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const ROWS = [
  { kind: 'line', id: 11, visit_service_id: 11, patient_id: 1, patient_name: 'Пациентов Пётр', patient_mrn: 'P-1', service: 'УЗИ почек', group: 'diag', status: 'done', sent_at: '2026-11-06T09:00:00Z', visit_date: '2026-11-06T09:00:00Z', performer: 'Расулов Рустам', result: 'doc' },
  { kind: 'line', id: 12, visit_service_id: 12, patient_id: 2, patient_name: 'Иванова Ирина', patient_mrn: 'P-2', service: 'ОАК', group: 'lab', status: 'done', sent_at: '2026-11-05T09:00:00Z', visit_date: null, performer: '', result: 'labs' },
  { kind: 'line', id: 13, visit_service_id: 13, patient_id: 2, patient_name: 'Иванова Ирина', patient_mrn: 'P-2', service: 'Приём кардиолога', group: 'consult', status: 'awaiting_payment', sent_at: '2026-11-04T09:00:00Z', visit_date: null, performer: 'Боброва Белла', result: null },
  { kind: 'rec', id: 5, visit_service_id: null, patient_id: 1, patient_name: 'Пациентов Пётр', patient_mrn: 'P-1', service: 'Аппендэктомия', group: 'other', status: 'not_billed', sent_at: '2026-11-03T09:00:00Z', visit_date: null, performer: '', result: null },
];
const DOCS = { groups: {
  consult: [],
  diag: [{ id: 'doc:1', kind: 'diag', visit_service_id: 11, title: 'УЗИ почек', doctor: 'Расулов Рустам', at: '2026-11-06T10:00:00Z',
           sections: [{ key: 'description', label: 'Описание', html: 'Почки в норме' }, { key: 'conclusion', label: 'Заключение', html: 'Патологии нет' }] }],
  labs: [{ id: 'labs:7', kind: 'labs', visit_id: 7, visit_service_id: null, title: 'Анализы', at: '2026-11-05T10:00:00Z', panels: [
    { visit_service_id: 99, title: 'Чужой анализ', rows: [{ parameter: 'GLU', value: '5.1', unit: 'ммоль/л', reference_range: '3.9-6.1' }] },
    { visit_service_id: 12, title: 'ОАК', rows: [{ parameter: 'HGB', value: '140', unit: 'г/л', reference_range: '120-160' }] },
  ] }],
}, closed: [] };
const ASKED = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const b = opts && opts.body ? JSON.parse(opts.body) : null;
  ASKED.push([u, b]);
  if (u === '/api/rpc/my_referrals') return { ok: true, json: async () => ({ data: { from: b.from, to: b.to, rows: JSON.parse(JSON.stringify(ROWS)), truncated: false } }) };
  if (u === '/api/rpc/patient_doc_sources') return { ok: true, json: async () => ({ data: DOCS }) };
  return { ok: true, json: async () => ({ data: null }) };
};

const M = await import('../views/my-referrals.js');
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

async function open() {
  M.resetMyReferrals();
  ASKED.length = 0;
  await M.loadMyReferrals();
  const root = mk('div');
  const paint = () => { root.children.length = 0; root.appendChild(M.myReferralsView(paint)); };
  paint();
  return root;
}
const rowsShown = (root) => byAttr(root, 'data-ref-row').map((n) => n.attrs['data-ref-row']);

test('MY_REFERRALS_V1: период по умолчанию — последние 30 дней местного календаря, уходит на сервер', async () => {
  await open();
  const [u, b] = ASKED[0];
  assert.strictEqual(u, '/api/rpc/my_referrals');
  const today = new Date();
  const from = new Date(); from.setDate(from.getDate() - 29);
  assert.deepStrictEqual(b, { from: ymd(from), to: ymd(today) });
});

test('MY_REFERRALS_V1: строки, статусы и «Результат» только там, где его дал сервер', async () => {
  const root = await open();
  assert.deepStrictEqual(rowsShown(root), ['line:11', 'line:12', 'line:13', 'rec:5']);
  const st = byAttr(root, 'data-ref-status').map((n) => [n.attrs['data-ref-status'], textOf(n).trim()]);
  assert.deepStrictEqual(st, [['done', 'Готово'], ['done', 'Готово'], ['awaiting_payment', 'Ждёт оплаты'], ['not_billed', 'Не выставлено']]);
  assert.deepStrictEqual(byAttr(root, 'data-ref-result-btn').map((n) => n.attrs['data-ref-result-btn']), ['11', '12']);
  assert.match(textOf(root), /рекомендация/);
});

test('MY_REFERRALS_V1: группа и поиск фильтруют на экране, без нового чтения', async () => {
  const root = await open();
  const n = ASKED.length;
  const sel = byAttr(root, 'data-ref-group')[0];
  sel.dispatchEvent({ type: 'change', target: { value: 'lab' } });
  assert.deepStrictEqual(rowsShown(root), ['line:12']);
  sel.dispatchEvent({ type: 'change', target: { value: '' } });
  const s = byAttr(root, 'data-ref-search')[0];
  s.dispatchEvent({ type: 'input', target: { value: 'иванова' } });
  await tick(650);   // поле поиска — с задержкой ввода (SEARCH_DEBOUNCE_V1, 500 мс)
  assert.deepStrictEqual(rowsShown(root), ['line:12', 'line:13']);
  assert.strictEqual(ASKED.length, n, 'фильтр на экране не спрашивает сервер');
  assert.deepStrictEqual(M.shownRows(ROWS, { group: 'other', search: '' }).map((r) => r.id), [5]);
});

test('MY_REFERRALS_V1: смена периода — новое чтение с сервера', async () => {
  const root = await open();
  const from = byAttr(root, 'data-ref-period').find((n) => n.attrs['data-ref-period'] === 'from');
  from.dispatchEvent({ type: 'change', target: { value: '2026-01-01' } });
  await tick();
  assert.deepStrictEqual(ASKED.at(-1)[1].from, '2026-01-01');
});

test('MY_REFERRALS_V1: «Результат» диагностики — документ строки из patient_doc_sources', async () => {
  body.children.length = 0;
  const ov = await M.openReferralResult(ROWS[0]);
  assert.ok(ov, 'окно не открылось');
  assert.deepStrictEqual(ASKED.at(-1), ['/api/rpc/patient_doc_sources', { patient_id: 1, limit: 100 }]);
  const html = byAttr(ov, 'data-ref-result-body')[0].innerHTML;
  assert.match(html, /Почки в норме/);
  assert.match(html, /Патологии нет/);
  ov.remove();
});

test('MY_REFERRALS_V1: «Результат» анализа — только показатели этой строки', async () => {
  const ov = await M.openReferralResult(ROWS[1]);
  const html = byAttr(ov, 'data-ref-result-body')[0].innerHTML;
  assert.match(html, /HGB/);
  assert.doesNotMatch(html, /GLU|Чужой анализ/);
  ov.remove();
});

test('MY_REFERRALS_V1: документа нет в окне — честное «не найден», окна нет', async () => {
  TOASTS.length = 0;
  const ov = await M.openReferralResult({ ...ROWS[0], visit_service_id: 404 });
  assert.strictEqual(ov, null);
  assert.ok(TOASTS.some((t) => /Документ не найден/.test(t)), TOASTS.join(' | '));
});

test('MY_REFERRALS_V1: вкладка — только врачу (флаг или роль); кабинет её подключает', () => {
  assert.strictEqual(M.canSeeMyReferrals({ role: 'doctor' }), true);
  assert.strictEqual(M.canSeeMyReferrals({ role: 'admin', is_doctor: 1 }), true);
  assert.strictEqual(M.canSeeMyReferrals({ role: 'nurse', extra_roles: ['head_doctor'] }), true);
  assert.strictEqual(M.canSeeMyReferrals({ role: 'admin' }), false);
  assert.strictEqual(M.canSeeMyReferrals({ role: 'nurse' }), false);
  assert.strictEqual(M.canSeeMyReferrals(null), false);
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'consultation.js'), 'utf8');
  assert.match(src, /canSeeMyReferrals\(\) \? topTab\('referrals', 'Мои направления', 'Send'\) : null/);
  assert.match(src, /state\.tab === 'referrals' \? myReferralsView\(/);
  assert.match(src, /if \(state\.tab === 'referrals' && !canSeeMyReferrals\(\)\) state\.tab = 'dashboard';/);
});
