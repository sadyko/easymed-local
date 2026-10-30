// REFUND_ANY_V1 (ревью B4, п. 9a) — ПРОЦЕДУРНАЯ: ВОЗВРАЩЁННАЯ ПРОЦЕДУРА — НЕ РАБОТА.
//
// Касса вернула деньги за кабинетную процедуру (refunded_lines), а строка
// осталась в визите со своим статусом. Очередь процедур по статусу ставила её
// «В работе» и предлагала «Выполнить». Теперь:
//   • очередь спрашивает refunded_lines ОДИН раз на загрузку — номерами только
//     кабинетных строк (у палатной номер — из другой таблицы, admission_services);
//   • возвращённой нет «В работе» и в его счётчике; во «Все» и «Выполнено» она
//     видна с меткой «Услуга возвращена»; ни «Выполнить», ни «Взять», ни
//     «Ожидает кассу» у неё нет (сервер откажет отметке и сам).

import { test } from 'node:test';
import assert from 'node:assert';
import { REFUNDED_LINE_MARK } from '../../shared/refunded-line.js';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={setProperty(k,v){this[k]=v;},getPropertyValue(k){return this[k];}};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.id='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
 _desc(o=[]){for(const c of this.children||[]){o.push(c);if(c._desc)c._desc(o);}return o;}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', { get() { return ''; }, set() {}, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {},
  getElementById(id) { return id === 'toast' ? toastEl : null; },
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage,
  addEventListener() {}, dispatchEvent() { return true; },
  easymed: { state: { user: { id: 2, role: 'nurse', full_name: 'Сестра', extra_roles: [] } } },
  confirm: () => false,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.history = { state: null, replaceState() {}, pushState() {} };

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const row = (kind, id, status, service, patient, extra = {}) => ({ kind, id, status, service, patient, phone: '', mrn: '', dob: null, sex: null,
  performer_id: null, performer: '', performer_role: '', performer_is_doctor: false, unassigned: true, done: status === 'completed',
  done_at: null, done_by: '', notes: '', when: '2026-10-30T09:00:00Z', visit_id: kind === 'outpatient' ? 500 + id : null,
  patient_id: 900 + id, admission_id: kind === 'inpatient' ? 1 : null, ward: kind === 'inpatient' ? 'Терапия' : '', bed: '', ...extra });
const ROWS = [
  row('outpatient', 41, 'queued', 'Перевязка', 'Аминов Олим'),
  row('outpatient', 42, 'queued', 'Инъекция', 'Зокиров Бобур'),          // возвращена, со следом работы
  row('outpatient', 43, 'added', 'Капельница', 'Валиева Дилноза'),        // возвращена, оставлена в визите
  row('outpatient', 44, 'completed', 'Массаж', 'Бакиев Санжар'),          // возвращена после выполнения
  row('inpatient', 42, 'in_progress', 'Укол в палате', 'Гаипов Тимур'),   // палатная: тот же номер — другая таблица
];
const REFUNDED = new Set([42, 43, 44]);
const ASKED = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u === '/api/rpc/procedures_list') return { ok: true, json: async () => ({ data: { scope: 'own', me: 2, rows: JSON.parse(JSON.stringify(ROWS)) } }) };
  if (u === '/api/rpc/refunded_lines') {
    ASKED.push(body);
    return { ok: true, json: async () => ({ data: { line_ids: (body.line_ids || []).filter((id) => REFUNDED.has(Number(id))) } }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderProcedures } = await import('../views/procedures.js');

const SERVICES = ROWS.map((r) => r.service);
const rowEls = (root) => walk(root).filter((n) => hasClass(n, 'proc-row'));
const serviceOf = (el) => SERVICES.find((s) => textOf(el).includes(s)) || null;
const shown = (root) => rowEls(root).map(serviceOf);
const rowBy = (root, svc) => rowEls(root).find((el) => serviceOf(el) === svc);
const marked = (el) => walk(el).some((n) => n.attrs && 'data-refunded-mark' in n.attrs && textOf(n).includes(REFUNDED_LINE_MARK));
const tab = (root, label) => walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n).trim().startsWith(label));

async function open() {
  ASKED.length = 0;
  const root = mk('div');
  await renderProcedures(root);
  await tick();
  return root;
}

test('один вопрос refunded_lines на загрузку — номерами только кабинетных строк', async () => {
  await open();
  assert.strictEqual(ASKED.length, 1, 'вопросов: ' + ASKED.length);
  assert.deepStrictEqual([...ASKED[0].line_ids].sort((a, b) => a - b), [41, 42, 43, 44]);
});

test('«В работе» и его счётчик — без возвращённых; палатная строка с тем же номером — не возвращена', async () => {
  const root = await open();
  assert.deepStrictEqual(shown(root).sort(), ['Перевязка', 'Укол в палате'].sort(), 'возвращённая процедура «В работе»');
  assert.ok(textOf(tab(root, 'В работе')).includes('2'), 'счётчик «В работе»: ' + textOf(tab(root, 'В работе')));
  assert.ok(!marked(rowBy(root, 'Укол в палате')), 'палатная строка помечена чужой отметкой');
  assert.ok(textOf(rowBy(root, 'Перевязка')).includes('Выполнить'));
});

test('«Все» и «Выполнено»: возвращённые видны с меткой; у неначатых — ни «Выполнить», ни «Взять», ни «Ожидает кассу»', async () => {
  const root = await open();
  tab(root, 'Все').click();
  assert.strictEqual(shown(root).length, 5);
  for (const el of rowEls(root)) {
    const svc = serviceOf(el);
    const want = ['Инъекция', 'Капельница', 'Массаж'].includes(svc);
    assert.strictEqual(marked(el), want, svc + ': метка не там');
  }
  for (const svc of ['Инъекция', 'Капельница']) {
    const t = textOf(rowBy(root, svc));
    assert.ok(!t.includes('Выполнить') && !t.includes('Взять') && !t.includes('Ожидает кассу'), svc + ': у возвращённой есть действие: ' + t);
  }
  tab(root, 'Выполнено').click();
  assert.deepStrictEqual(shown(root), ['Массаж']);
  assert.ok(marked(rowBy(root, 'Массаж')));
});
