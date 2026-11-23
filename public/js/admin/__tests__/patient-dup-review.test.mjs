// PATIENT_DUP_RULE_V3 (3.25.0, решение владельца 2026-11-18) — «Дубликаты» в
// списке пациентов: уверенные и «Возможные дубликаты — проверьте».
//
// Что проверяется здесь (экран; правило — patient-duplicates.test.js, сервер —
// rpc/patient-duplicates.test.js):
//   * КНОПКА «Дубликаты» одна: число — уверенные, как прежде, а рядом — второе число «возможные»;
//     без возможных второго нет. DUP_TO_RAIL_V1 (ветка партнёра, слияние 2026-11-23) — кнопка
//     переехала из шапки списка в левую колонку раздела; тест берёт её у модуля списка
//     (duplicatesRailButton — её же ставит patients-hub.js);
//   * РЕЖИМ «Дубликаты» показывает ГРУППЫ: сначала уверенные, потом возможные,
//     каждая группа — шапка с причиной («тот же телефон и дата рождения» / «то же
//     ФИО и дата рождения») и её карты подряд, строками списка;
//   * «НЕ ДУБЛИКАТ» — только у возможных групп и только у того, кому сервер
//     разрешил (как объединение — администратор); нажатие спрашивает
//     подтверждение, шлёт пары группы на сервер, и группа уходит из списка;
//   * «ОБЪЕДИНИТЬ» у группы открывает знакомое окно объединения ровно с её картами;
//   * узбекский экран — без кириллицы в шапках групп и в чипе;
//   * поиск в режиме «Дубликаты» возвращает к обычному списку.

import { test } from 'node:test';
import assert from 'node:assert';

// ---------------------------------------------------------------------------
// Fake-DOM harness — тот же, что в __tests__/patient-row.test.mjs.
// ---------------------------------------------------------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 append(...cs){for(const c of cs)this.children.push(typeof c==='string'?new TX(c):c);}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){ const p = document.body; const i = p.children.indexOf(this); if (i > -1) p.children.splice(i, 1); } select(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
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
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];}};

const store = new Map();
const fakeLocalStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear() };
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта экранов

let confirms = [];
globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 1, full_name: 'Админ', company_id: 'c-1', role: 'admin' } } },
  CLINIC: { id: 'c-1' },
  confirm: (text) => { confirms.push(String(text)); return true; },
  easymedSetTabSub: () => {},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };

// ---------------------------------------------------------------------------
// DATA — случай владельца + уверенная пара + «то же ФИО и дата».
// ---------------------------------------------------------------------------
const P = (id, last, first, phone, dob) => ({ id, company_id: 'c-1', mrn: 'A-26-' + String(id).padStart(5, '0'),
  full_name: (last + ' ' + first).trim(), last_name: last, first_name: first, phone, date_of_birth: dob,
  gender: 'male', registration_date: '2026-11-01', created_by: null });
const PATIENTS = [
  P(101, '', 'TEST', '+998977654321', '1990-05-05'),
  P(102, 'Sardor', 'Alimov', '998977654321', '1991-04-23'),
  P(103, 'ТЕст 2', 'Тест 2', '+998977654321', '1991-04-23'),
  P(201, 'Каримов', 'Азиз', '+998901234567', '1980-03-04'),
  P(202, 'Karimov', 'Азиз', '901234567', ''),
  P(301, 'Эргашев', 'Жахонгир', '+998977001122', '1990-04-01'),
  P(302, 'Эргашев', 'Жахонгир', '+998977003344', '1990-04-01'),
];
const FULL_SCAN = () => ({
  sure: [[201, 202]],
  possible: [{ ids: [102, 103], reasons: ['phone_dob'] }, { ids: [301, 302], reasons: ['name_dob'] }],
  scanned: PATIENTS.length,
});

let scan = FULL_SCAN();
let canDismiss = true;
let rpcCalls = [];
let dbCalls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push({ name, body });
    if (name === 'patient_duplicates_scan') return ok({ data: { ...JSON.parse(JSON.stringify(scan)), can_dismiss: canDismiss } });
    if (name === 'patient_dup_dismiss') {
      const ids = (body && body.ids) || [];
      scan = { ...scan, possible: scan.possible.filter((g) => g.ids.join() !== [...ids].sort((a, b) => a - b).join()) };
      return ok({ data: { dismissed: 1, pairs: 1 } });
    }
    if (name === 'patient_list_page') return ok({ data: { rows: JSON.parse(JSON.stringify(PATIENTS)), total: PATIENTS.length } });
    if (name === 'patient_bot_status') return ok({ data: { bot: true, sms_ready: false, linked: [] } });
    if (name === 'patient_base_aggregates') return { ok: false, status: 404, json: async () => ({ error: { message: 'Unknown RPC' } }) };
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    dbCalls.push(body);
    if (body && body.table === 'patients') {
      const f = (body.filters || []).find((x) => x.op === 'in' && x.col === 'id');
      const want = f ? new Set(f.val.map(String)) : null;
      const rows = want ? PATIENTS.filter((p) => want.has(String(p.id))) : PATIENTS;
      return ok({ data: JSON.parse(JSON.stringify(rows)), count: rows.length });
    }
    return ok({ data: [], count: 0 });
  }
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const { setFullAccess, setEffectiveFromRole } = await import('../permissions.js');
const { setLang } = await import('../i18n.js');
let coldN = 0;
const coldView = () => import('../views/patients.js?dupcold=' + (++coldN));

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const rowsOf = (root) => walk(root).filter((n) => n.tagName === 'TR' && hasClass(n, 'row-click'));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const labelOf = (n) => textOf(n).trim();
const byAct = (root, act) => walk(root).filter((n) => n.attrs && n.attrs['data-act'] === act);
const CYR = /[Ѐ-ӿ]/;

async function paint({ lang = 'ru', role = 'admin', dismiss = true, data = FULL_SCAN() } = {}) {
  rpcCalls = []; dbCalls = []; confirms = [];
  scan = data; canDismiss = dismiss;
  document.body.children.length = 0;
  globalThis.window.easymed.state.user = { id: role === 'admin' ? 1 : 2, full_name: 'Сотрудник', company_id: 'c-1', role };
  if (role === 'admin') setFullAccess('Admin');
  else setEffectiveFromRole({ name: role, permissions: { sections: ['patients', 'registration'], levels: { patients: 'editor', registration: 'editor' } } });
  setLang(lang);
  const box = mk('div');
  const mod = await coldView();
  await mod.renderPatients(box, { onNavigate: () => {}, embedded: true });
  box.__dupBtn = mod.duplicatesRailButton();   // DUP_TO_RAIL_V1 — кнопка колонки
  await tick();
  return box;
}
const chipOf = (box) => box.__dupBtn;
// Числа кнопки колонки: уверенные — первый .nav-badge, возможные — .dup-chip-possible.
const sureOf = (chip) => labelOf(byClass(chip, 'nav-badge').find((n) => !hasClass(n, 'dup-chip-possible')));
const possibleOf = (chip) => byClass(chip, 'dup-chip-possible')[0];
async function openDupMode(box) {
  chipOf(box).click();
  await tick();
}

// ===========================================================================
test('чип: «Дубликаты · 2» считает уверенные, «возможные · 4» — карты возможных групп; без возможных хвоста нет', async () => {
  const box = await paint();
  const chip = chipOf(box);
  assert.ok(chip, 'кнопки «Дубликаты» нет в колонке');
  assert.ok(rpcCalls.some((c) => c.name === 'patient_duplicates_scan'), 'скан дубликатов не спрошен у сервера');
  assert.ok(!dbCalls.some((b) => b && b.table === 'patients' && b.limit === 1000), 'остался прежний скан первой тысячи карт в браузере');
  assert.match(labelOf(chip), /Дубликаты/);
  assert.equal(sureOf(chip), '2', 'уверенные посчитаны не так');
  assert.equal(labelOf(possibleOf(chip)), '4', 'возможные не видны на кнопке');
  assert.notEqual(possibleOf(chip).style.display, 'none', 'число возможных спрятано при четырёх');
  assert.match(String(possibleOf(chip).attrs.title || ''), /возможные/, 'второе число не подписано');
  assert.match(String(chip.attrs.title || ''), /Возможные/, 'подсказка чипа не объясняет второй список');

  const none = await paint({ data: { sure: [[201, 202]], possible: [] } });
  const wrap = possibleOf(chipOf(none));
  assert.ok(wrap, 'у чипа нет места для «возможных»');
  assert.equal(wrap.style.display, 'none', 'при нуле возможных число «0» видно');
  assert.equal(sureOf(chipOf(none)), '2');
});

test('режим «Дубликаты»: сначала уверенные, потом возможные; у группы — причина и её карты подряд', async () => {
  const box = await paint();
  await openDupMode(box);
  const secs = byClass(box, 'dup-sec-row').map(labelOf);
  assert.equal(secs.length, 2, 'разделов не два: ' + secs.join(' | '));
  assert.match(secs[0], /^Дубликаты/, 'первым должен идти раздел уверенных: ' + secs[0]);
  assert.match(secs[1], /Возможные дубликаты — проверьте/, 'нет раздела возможных: ' + secs[1]);

  const heads = byClass(box, 'dup-group-head');
  assert.equal(heads.length, 3, 'групп не три');
  assert.equal(heads[0].attrs['data-dup-kind'], 'sure');
  assert.equal(heads[1].attrs['data-dup-kind'], 'possible');
  assert.match(labelOf(heads[1]), /тот же телефон и дата рождения/, 'нет причины у группы: ' + labelOf(heads[1]));
  assert.match(labelOf(heads[2]), /то же ФИО и дата рождения/, 'нет причины у группы: ' + labelOf(heads[2]));

  // Карты групп подряд, в порядке групп — и только они (TEST 101 — не дубликат).
  const names = rowsOf(box).map((r) => byClass(r, 'pt-nm')[0]).map(labelOf);
  assert.deepEqual(names, ['Каримов Азиз', 'Karimov Азиз', 'Sardor Alimov', 'ТЕст 2 Тест 2', 'Эргашев Жахонгир', 'Эргашев Жахонгир']);
  // Строки грузятся по id групп одной выборкой — без отбора по зданиям.
  const q = dbCalls.filter((b) => b && b.table === 'patients' && (b.filters || []).some((f) => f.op === 'in' && f.col === 'id'));
  assert.equal(q.length, 1, 'карты групп не одной выборкой');
  assert.deepEqual([...q[0].filters.find((f) => f.op === 'in').val].sort(), [102, 103, 201, 202, 301, 302]);

  // Строки метятся: уверенные — «Дубликат», возможные — «Возможный дубликат».
  const rows = rowsOf(box);
  assert.match(textOf(rows[0]), /Дубликат/);
  assert.match(textOf(rows[2]), /Возможный дубликат/);
  assert.ok(textOf(box).includes('Страница 1 из 1 · групп: 3'), 'подпись страницы режима не о группах: ' + textOf(box).slice(-200));
});

test('«Не дубликат» — только у возможных групп; спрашивает подтверждение, шлёт карты группы, группа уходит', async () => {
  const box = await paint();
  await openDupMode(box);
  const heads = byClass(box, 'dup-group-head');
  assert.equal(byAct(heads[0], 'dup-dismiss').length, 0, '«Не дубликат» у уверенной группы');
  const dismissBtns = byAct(box, 'dup-dismiss');
  assert.equal(dismissBtns.length, 2, 'у каждой возможной группы — своя кнопка «Не дубликат»');
  assert.match(labelOf(dismissBtns[0]), /Не дубликат/);

  dismissBtns[0].click();
  await tick(80);
  assert.equal(confirms.length, 1, 'нажатие не спросило подтверждения');
  assert.match(confirms[0], /не изменятся/, 'подтверждение не говорит, что карты не меняются: ' + confirms[0]);
  const sent = rpcCalls.find((c) => c.name === 'patient_dup_dismiss');
  assert.ok(sent, '«Не дубликат» не дошёл до сервера');
  assert.deepEqual(sent.body, { ids: [102, 103], reasons: ['phone_dob'] });
  assert.ok(rpcCalls.filter((c) => c.name === 'patient_duplicates_scan').length >= 2, 'после отметки дубликаты не пересчитаны');

  const after = byClass(box, 'dup-group-head');
  assert.equal(after.length, 2, 'отмеченная группа осталась в списке');
  assert.ok(!rowsOf(box).some((r) => textOf(r).includes('Sardor Alimov')), 'карта отмеченной группы осталась на экране');
  assert.equal(labelOf(possibleOf(chipOf(box))), '2', 'кнопка не пересчитала возможные');
});

test('отказ в подтверждении — ничего не уходит на сервер', async () => {
  const box = await paint();
  await openDupMode(box);
  const prev = globalThis.window.confirm;
  globalThis.window.confirm = (t) => { confirms.push(String(t)); return false; };
  try {
    byAct(box, 'dup-dismiss')[0].click();
    await tick(60);
  } finally { globalThis.window.confirm = prev; }
  assert.ok(!rpcCalls.some((c) => c.name === 'patient_dup_dismiss'), 'отменённое подтверждение всё равно отметило пару');
});

test('«Объединить» у группы открывает окно объединения ровно с её картами', async () => {
  const box = await paint();
  await openDupMode(box);
  const head = byClass(box, 'dup-group-head')[2];
  const merge = byAct(head, 'dup-merge')[0];
  assert.ok(merge, 'у группы нет «Объединить»');
  merge.click();
  await tick();
  const modal = document.body.children.find((n) => hasClass(n, 'modal'));
  assert.ok(modal, 'окно объединения не открылось');
  const radios = walk(modal).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'radio');
  assert.equal(radios.length, 2, 'в окне не две карты группы');
  assert.ok(textOf(modal).includes('Эргашев Жахонгир'));
  assert.ok(!textOf(modal).includes('Sardor'), 'в окно попала карта из другой группы');
});

test('регистратор видит обе группы и числа, но без «Не дубликат» и «Объединить»', async () => {
  const box = await paint({ role: 'registrar', dismiss: false });
  assert.equal(sureOf(chipOf(box)), '2');
  assert.equal(labelOf(possibleOf(chipOf(box))), '4');
  await openDupMode(box);
  assert.equal(byClass(box, 'dup-group-head').length, 3, 'регистратор не видит групп');
  assert.equal(byAct(box, 'dup-dismiss').length, 0, 'регистратору показана «Не дубликат», которую сервер отвергнет');
  assert.equal(byAct(box, 'dup-merge').length, 0, 'регистратору показано «Объединить», которое сервер отвергнет');
});

test('узбекский экран: чип и шапки групп без кириллицы', async () => {
  const box = await paint({ lang: 'uz' });
  const chipText = labelOf(chipOf(box));
  assert.ok(!CYR.test(chipText), 'кириллица в чипе: ' + chipText);
  assert.ok(!CYR.test(String(chipOf(box).attrs.title || '')), 'кириллица в подсказке чипа');
  await openDupMode(box);
  for (const n of [...byClass(box, 'dup-sec-row'), ...byClass(box, 'dup-group-head')]) {
    assert.ok(!CYR.test(textOf(n)), 'кириллица в шапке режима «Дубликаты»: ' + textOf(n));
  }
  setLang('ru');
});

test('поиск в режиме «Дубликаты» возвращает к обычному списку', async () => {
  const box = await paint();
  await openDupMode(box);
  assert.ok(byClass(box, 'dup-group-head').length > 0);
  const search = walk(box).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'search');
  search.value = 'Эргашев';
  search.dispatchEvent({ type: 'input', currentTarget: search, target: search });
  await tick(900);
  assert.equal(byClass(box, 'dup-group-head').length, 0, 'поиск остался внутри групп дубликатов');
  assert.equal(rowsOf(box).length, PATIENTS.length, 'обычный список не вернулся');
});

// Журнал «Входы от имени» подписывает оба новых RPC словами (скан спрашивается при
// каждом входе в список — именем RPC журнал читался бы как лог сервера).
test('журнал «Входы от имени»: скан и «Не дубликат» — подписью на трёх языках', async () => {
  const { actAsActionLabel } = await import('../views/act-as-history.js');
  for (const lang of ['ru', 'uz', 'en']) {
    setLang(lang);
    for (const name of ['patient_duplicates_scan', 'patient_dup_dismiss']) {
      const l = actAsActionLabel({ kind: 'rpc', name });
      assert.ok(l !== name && !/[a-z]+_[a-z]+/.test(l), lang + ': ' + name + ' без подписи: ' + l);
      if (lang !== 'ru') assert.ok(!CYR.test(l), lang + ': кириллица в подписи ' + l);
    }
  }
  setLang('ru');
  assert.equal(actAsActionLabel({ kind: 'rpc', name: 'patient_dup_dismiss' }), 'Отметка «Не дубликат»');
});
