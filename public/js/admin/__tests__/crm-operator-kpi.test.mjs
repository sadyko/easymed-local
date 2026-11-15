// OPERATOR_KPI_V1 — окно «Мой KPI» оператора (views/crm-operator-kpi.js).
//
// Что закреплено:
//   * оплата из карточки: оклад, процент, база, бонус и «к начислению за месяц»;
//   * не задано в карточке — объяснение вместо оплаты, показатели остаются;
//   * период перечитывает показатели; руководителю — выбор оператора;
//   * без внутреннего номера — объяснение вместо звонков.
//
// Fake-DOM harness — copied from __tests__/meta-chat.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.hidden=false;}
 appendChild(c){this.children.push(c);c.parentNode=this;return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} select(){}
 remove(){ if (this.parentNode) this.parentNode.removeChild(this); this.parentNode = null; }
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){ let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document.body; }}
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
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener(){}, removeEventListener(){},
  easymed: { state: { user: { id: 'u-2', full_name: 'Оператор Анна', role: 'callcenter' } } },
  CLINIC: { id: 1 },
};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.ResizeObserver=class{observe(){}disconnect(){}unobserve(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const byAttr = (root, a, v) => walk(root).filter((n) => n.attrs && a in n.attrs && (v === undefined || n.attrs[a] === v));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let resp = null;
const calls = [];
function data(over = {}) {
  return {
    operator: { id: 2, name: 'Оператор Анна', extension: '101' },
    period: { key: 'month', from: '2026-11-01', to: '2026-11-14' },
    leads: { total: 30, came: 9, scheduled: 4, no_show: 1, lost: 6, open: 10, became_patient: 9, with_date: 5, conversion: 30 },
    open_now: 12,
    series: [{ date: '2026-11-13', leads: 3, came: 1 }, { date: '2026-11-14', leads: 2, came: 1 }],
    calls: { extension: '101', incoming: 80, answered: 70, missed: 10, outgoing: 120, outgoing_answered: 60, talk_min: 300, avg_wait_sec: 9, answer_rate: 87.5 },
    tasks: { done: 5, overdue: 2, open: 3 },
    pay: { type: 'fix_plus_kpi', fixed: 3000000, percent: 5, revenue_base: 4000000, revenue_patients: 9, bonus: 200000, total: 3200000, kpi_links: ['revenue'], configured: true },
    rank: { place: 2, of: 5 },
    can_pick: false, operators: [],
    ...over,
  };
}
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length).split('?')[0];
    let args = {};
    try { args = init.body ? JSON.parse(init.body) : {}; } catch { args = {}; }
    calls.push({ name, args });
    return { ok: true, json: async () => ({ data: name === 'crm_operator_kpi' ? resp(args) : {} }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { openOperatorKpi } = await import('../views/crm-operator-kpi.js');

async function open() {
  calls.length = 0;
  const w = await openOperatorKpi();
  await tick();
  return { w, root: byAttr(document.body, 'data-operator-kpi')[0] };
}

test('оплата из карточки: оклад, процент, база, бонус, к начислению за месяц; заявки, звонки, задачи', async () => {
  resp = () => data();
  const { w, root } = await open();
  const t = textOf(root);
  for (const s of ['Мой KPI', 'Оператор Анна', 'Оклад в месяц', '3 000 000', '5%', 'Оплаты ваших пациентов', '4 000 000',
    'Бонус за период', '200 000', 'К начислению за месяц', '3 200 000', 'Заявок в работе', 'Пришли', 'конверсия 30%',
    'место среди операторов: 2 из 5', 'Входящих', 'отвечено 87,5%', 'По внутреннему номеру 101.', 'Просрочено']) {
    assert.ok(t.includes(s), 'нет «' + s + '»');
  }
  assert.strictEqual(calls[0].args.period, 'month', 'по умолчанию — этот месяц');
  w.close();
  assert.strictEqual(byAttr(document.body, 'data-operator-kpi').length, 0, 'окно закрылось');
});

test('не задано в карточке и нет внутреннего номера — объяснения вместо оплаты и звонков', async () => {
  resp = () => data({ pay: { type: '', fixed: null, percent: null, revenue_base: 0, revenue_patients: 0, bonus: null, total: null, kpi_links: [], configured: false }, calls: null, rank: null });
  const { w, root } = await open();
  const t = textOf(root);
  assert.ok(t.includes('Оклад и процент в карточке сотрудника не заданы'));
  assert.ok(t.includes('Внутренний номер телефонии не задан'));
  assert.ok(!t.includes('К начислению'));
  w.close();
});

test('период перечитывает показатели; руководителю — выбор оператора', async () => {
  resp = (args) => data({ can_pick: true, operators: [{ id: 2, name: 'Оператор Анна' }, { id: 3, name: 'Оператор Бек' }],
    operator: args.user_id === 3 ? { id: 3, name: 'Оператор Бек', extension: null } : { id: 2, name: 'Оператор Анна', extension: '101' } });
  const { w, root } = await open();
  byAttr(root, 'data-okpi-period', 'week')[0].click();
  await tick();
  assert.strictEqual(calls.at(-1).args.period, 'week');
  const sel = byAttr(root, 'data-okpi-operator')[0];
  assert.ok(sel, 'руководитель выбирает оператора');
  sel.dispatchEvent({ type: 'change', target: { value: '3' } });
  await tick();
  assert.strictEqual(calls.at(-1).args.user_id, 3);
  assert.ok(textOf(root).includes('Оператор Бек'));
  w.close();
});
