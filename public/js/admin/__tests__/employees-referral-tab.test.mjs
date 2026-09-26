// REPORTS_V2 — вкладка «Вознаграждение за направления» в карточке сотрудника.
//
// Вкладка была МЁРТВОЙ: таблица писала users.referral_rates, которую не
// читает никто, — вознаграждение (отчёт «Рефералы», кабинет врача) считается
// по ставке ИСТОЧНИКА врача (referral_sources.doctor_id, мигр. 122). Теперь во
// вкладке рабочая правка из общего модуля referral-reward-editor.js, и её
// сохранение пишет строку источника этого врача.
//
// Fake-DOM харнесс — тот же, что в employees-inpatient-rates.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)if(c)this.children.push(c);}
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
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; },
};
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
localStorage.setItem('admin.lang', 'ru');
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage, addEventListener() {},
  easymed: { state: { user: { id: 1, role: 'admin', is_admin: true } } },
  CLINIC: { id: 1 },
  confirm: () => true,
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();

const DOC = {
  id: 7, username: 'surgeon', full_name: 'Хирургов Хасан', last_name: 'Хирургов', first_name: 'Хасан',
  role: 'doctor', is_active: true, is_local: true, extra_roles: [], phone: '+998901112255',
  staff_type: 'doctor', is_doctor: true, specialty: 'Хирург',
  service_rates: [], referral_rates: [{ service_id: 1, pct: 99, branches: [] }],
};

const patches = [];
const dbCalls = [];
// Ревью M6 — ставка группы, которой нет среди показанных (выключенная группа).
let SOURCE_RATES = '';
let SERVICE_TYPES = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === '/api/users') return { ok: true, json: async () => ({ users: [DOC] }) };
  if (u.startsWith('/api/users/')) { patches.push({ u, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ user: {} }) }; }
  if (u === '/api/db') {
    const desc = opts && opts.body ? JSON.parse(opts.body) : {};
    dbCalls.push(desc);
    let rows = [];
    if (desc.table === 'referral_sources' && desc.op === 'select') {
      rows = [{ id: 55, reward_mode: 'category', own_percent: 0, own_rates: SOURCE_RATES, category_id: 3 }];
    } else if (desc.table === 'referral_source_categories') {
      rows = [{ id: 3, name: 'Внутренние врачи', standard_percent: 0 }];
    } else if (desc.table === 'branches') rows = [{ id: 1, name: 'Чиланзар' }];
    else if (desc.table === 'service_types') rows = SERVICE_TYPES;
    return { ok: true, json: async () => ({ data: rows }) };
  }
  return { ok: true, json: async () => ({ data: [] }) };
};

const { renderEmployees } = await import('../views/employees.js');

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const tags = (root, tag) => walk(root).filter((n) => n.tagName === String(tag).toUpperCase());
const byClass = (root, c) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(c));
const buttonWith = (root, text) => tags(root, 'button').find((b) => textOf(b).includes(text));
async function flush() { for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0)); }

async function openCard() {
  document.body.children.length = 0;
  patches.length = 0;
  dbCalls.length = 0;
  const container = mk('div');
  await renderEmployees(container);
  await flush();
  const row = tags(container, 'tr').find((r) => textOf(r).includes('@surgeon'));
  row.dispatchEvent({ type: 'click', currentTarget: null, preventDefault() {}, stopPropagation() {} });
  await flush();
  return document.body.children[document.body.children.length - 1];
}
async function openReferralTab() {
  const card = await openCard();
  const item = walk(card).filter((n) => n._l && n._l.click && textOf(n).includes('Вознаграждение за направления')).pop();
  assert.ok(item, 'нет вкладки «Вознаграждение за направления» — подпись вкладки обязана остаться');
  item.click();
  await flush();
  return card;
}

test('вкладка читает источник ЭТОГО врача, а не users.referral_rates', async () => {
  const card = await openReferralTab();
  const q = dbCalls.find((d) => d.table === 'referral_sources' && d.op === 'select');
  assert.ok(q, 'источник врача не запрошен');
  assert.ok((q.filters || []).some((f) => f.col === 'doctor_id' && String(f.val) === '7'), JSON.stringify(q.filters));
  const t = textOf(card);
  assert.ok(t.includes('Вознаграждение по категории (общая ставка)'), 'нет рабочей правки');
  assert.ok(!t.includes('% направления'), 'мёртвая таблица по услугам осталась');
  assert.strictEqual(byClass(card, 'rt-item').length, 0, 'строки мёртвой таблицы ставок на месте');
});

test('своя ставка сохраняется в строку источника врача (referral_sources), карточка — отдельно', async () => {
  const card = await openReferralTab();
  const chkBox = byClass(card, 'checkbox').find((n) => textOf(n).includes('Вознаграждение по категории'));
  const modeChk = chkBox && tags(chkBox, 'input')[0];
  const pctInp = tags(card, 'input').find((n) => n.attrs.type === 'number' && n.attrs.placeholder === '0');
  assert.ok(modeChk && pctInp, 'нет полей режима и процента');
  modeChk.checked = false; modeChk.dispatchEvent({ type: 'change' });
  pctInp.value = '12'; pctInp.dispatchEvent({ type: 'input' });
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
  assert.equal(patches.length, 1, 'карточка сотрудника ушла своим PATCH');
  // Мёртвая колонка не затирается и не правится: что было, то и уходит.
  assert.deepStrictEqual(patches[0].body.referral_rates.map((r) => r.pct), [99]);
  const upd = dbCalls.find((d) => d.table === 'referral_sources' && d.op === 'update');
  assert.ok(upd, 'ставка не записана в источник врача');
  assert.equal(upd.values.reward_mode, 'own');
  assert.equal(upd.values.own_percent, 12);
  assert.ok((upd.filters || []).some((f) => f.col === 'doctor_id' && String(f.val) === '7'), JSON.stringify(upd.filters));
});

test('вкладку не открывали — строка источника не переписывается', async () => {
  const card = await openCard();
  buttonWith(card, 'Сохранить сотрудника').click();
  await flush();
  assert.equal(patches.length, 1);
  assert.ok(!dbCalls.some((d) => d.table === 'referral_sources' && d.op === 'update'), 'ставка переписана без правки');
});

test('обе карточки сотрудника правят ставку ОДНИМ модулем — второй копии записи нет', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  for (const f of ['employees.js', 'employee-editor.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', f), 'utf8');
    assert.match(src, /from '\.\/referral-reward-editor\.js'/, f + ' не берёт общий редактор');
    assert.doesNotMatch(src, /from\('referral_sources'\)\.update/, f + ' пишет источник сам, мимо общего модуля');
  }
});

test('M6: ставки групп, которых нет в таблице, сохраняются как были', async () => {
  SOURCE_RATES = JSON.stringify([{ type_id: 99, unit: 'fix', value: 15000 }]);
  SERVICE_TYPES = [];   // группа 99 выключена — в таблице её нет
  try {
    const card = await openReferralTab();
    const chkBox = byClass(card, 'checkbox').find((n) => textOf(n).includes('Вознаграждение по категории'));
    const modeChk = tags(chkBox, 'input')[0];
    modeChk.checked = false; modeChk.dispatchEvent({ type: 'change' });
    buttonWith(card, 'Сохранить сотрудника').click();
    await flush();
    const upd = dbCalls.find((d) => d.table === 'referral_sources' && d.op === 'update');
    assert.ok(upd, 'ставка не записана');
    const rates = typeof upd.values.own_rates === 'string' ? JSON.parse(upd.values.own_rates) : upd.values.own_rates;
    assert.deepStrictEqual(rates, [{ type_id: 99, unit: 'fix', value: 15000 }], 'ставка выключенной группы стёрта');
  } finally { SOURCE_RATES = ''; SERVICE_TYPES = []; }
});

// GROUPS_FIVE_REFERRAL_V1 (мигр. 153) — в таблице ставок ровно ПЯТЬ групп
// (services.type), а не строки справочника «Типы услуг»: там их шесть, и
// шестая («Лучевая диагностика») стояла здесь под заголовком «Группа услуг».
test('таблица ставок — пять групп услуг, тип из справочника группой не показан', async () => {
  SERVICE_TYPES = [{ id: 6, name: 'Лучевая диагностика' }];
  SOURCE_RATES = JSON.stringify([{ group: 'lab', unit: 'fix', value: 7000 }]);
  try {
    const card = await openReferralTab();
    const t = textOf(card);
    for (const g of ['Консультации', 'Лаборатория', 'Диагностика', 'Процедуры', 'Хирургия']) {
      assert.ok(t.includes(g), 'нет группы «' + g + '»');
    }
    assert.ok(!t.includes('Лучевая диагностика'), 'тип из справочника показан группой');
    const labInp = tags(card, 'input').find((n) => n.attrs['data-rate-group'] === 'lab');
    assert.ok(labInp, 'нет строки группы «Лаборатория»');
    assert.equal(labInp.attrs.value, '7000', 'ставка группы не подставилась');
  } finally { SOURCE_RATES = ''; SERVICE_TYPES = []; }
});
