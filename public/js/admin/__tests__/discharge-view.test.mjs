// TWO_STEP_DISCHARGE_V1 — «Выписки к оформлению»: экран второго шага.
//
// Проверяется то, из-за чего экран вообще может навредить, а не «отрисовалось
// без исключения»:
//   • ДОЛГ НЕ ЗАПРЕЩАЕТ ВЫПИСКУ — кнопка гаснет ровно до галочки «Долг
//     согласован» и не гаснет ни от чего другого (перепутать это местами —
//     классическая ошибка, названная в плане дважды);
//   • число долга и границы этого числа приходят С СЕРВЕРА и показываются
//     полностью: «чего сумма не покрывает» — часть суммы;
//   • фактическое время выписки уезжает на сервер в UTC, а набирается местным;
//   • кнопки «Оформить» нет у того, кому сервер откажет (inpatient_capabilities);
//   • роли: старшая медсестра, главный врач, админ — да; медсестра, врач,
//     касса — нет.
//
// Стенд тот же крошечный DOM, что у kitchen-sheet.test.mjs: настоящего браузера
// здесь нет, а связку «что ответил сервер → что оказалось на экране и что ушло
// обратно» проверять надо.

import { test } from 'node:test';
import assert from 'node:assert';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';this.checked=false;this.disabled=false;}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){}
 querySelector(){return null;} querySelectorAll(){return [];}
 get textContent(){return this._t;} set textContent(v){this._t=String(v);this.children.length=0;}
 get classList(){const s=this;return{contains:c=>String(s.className).split(/\s+/).includes(c),add(){},remove(){},toggle(){}};}
 get isConnected(){return true;}}
class TX extends F{constructor(t){super('#text');this.nodeType=3;this._t=String(t);}}
const mk=t=>{const e=new F(t); if(String(t).toLowerCase()==='template') e.content=new F('#fragment'); return e;};
globalThis.Node=F; globalThis.Event=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};
// I18N_LOCALE_PIN_V1 — язык пришпилен к ru ДО импорта экрана.
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},open:()=>null};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');

// ─── Что отвечает сервер ────────────────────────────────────────────────────

const CLEAN = {
  admission_id: 1, admission_no: 'ADM-00001', patient_name: 'Иванов Иван',
  ward_name: 'Терапия', bed_code: 'K-1', attending_name: 'Петров П.П.',
  requested_by_name: 'Петров П.П.', discharge_outcome: 'home', discharge_destination: '',
  discharge_recommendations: 'Наблюдение у терапевта',
  discharge_requested_at: '2026-09-04T09:00:00Z', active_orders: 0,
  balance: { balance: 0, unbilled: 0, unbilled_lines: 0, invoiced: 0, paid: 0, invoice_count: 0,
    excludes: { internal_lines: 0, internal_amount: 0, void_invoices: 0 } },
};

const OWING = {
  admission_id: 2, admission_no: 'ADM-00002', patient_name: 'Сидорова Мария',
  ward_name: 'Хирургия', bed_code: 'X-2', attending_name: 'Каримов Р.',
  requested_by_name: 'Каримов Р.', discharge_outcome: 'transfer',
  discharge_destination: 'Городская больница №2', discharge_recommendations: '',
  discharge_requested_at: '2026-09-04T11:30:00Z', active_orders: 2,
  balance: { balance: 450000, unbilled: 150000, unbilled_lines: 2, invoiced: 400000, paid: 100000,
    invoice_count: 1, excludes: { internal_lines: 1, internal_amount: 90000, void_invoices: 1 } },
};

let QUEUE = { ward_id: null, outcomes: ['home', 'transfer', 'refuse', 'death'], rows: [CLEAN, OWING] };
let CAN = { discharge: true };
const rpcCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length);
    rpcCalls.push({ name, args: JSON.parse((opts && opts.body) || '{}') });
    if (name === 'inpatient_capabilities') return { ok: true, json: async () => ({ data: { roles: [], can: CAN } }) };
    if (name === 'admission_discharge_queue') return { ok: true, json: async () => ({ data: QUEUE }) };
    return { ok: true, json: async () => ({ data: { admission: { status: 'discharged' } } }) };
  }
  return { ok: true, json: async () => ({ data: [{ id: 1, name: 'Терапия' }, { id: 2, name: 'Хирургия' }] }) };
};

const {
  renderDischarge, canSeeDischarge, DISCHARGE_ROLES, outcomeTitle, money,
  hasDebt, balanceLines, excludeNotes, placeTitle, canSubmit,
  nowLocalInput, localToUtcIso,
} = await import('../views/discharge.js');

// ─── 1. Подписи и чистые функции ────────────────────────────────────────────

test('исход назван словами, а неизвестный не превращается в пустоту', () => {
  assert.equal(outcomeTitle('home'), 'Выписан домой');
  assert.equal(outcomeTitle('transfer'), 'Переведён в другое учреждение');
  assert.equal(outcomeTitle('refuse'), 'Отказ от лечения');
  assert.equal(outcomeTitle('death'), 'Летальный исход');
  assert.equal(outcomeTitle(null), 'Исход не указан');
});

test('пациент без палаты и без койки из списка не исчезает', () => {
  assert.equal(placeTitle({ ward_name: 'Терапия', bed_code: 'K-1' }), 'Терапия · K-1');
  assert.equal(placeTitle({ ward_name: 'Терапия' }), 'Терапия');
  assert.equal(placeTitle({}), 'Без палаты');
});

test('долг — это долг, а копейка округления — нет', () => {
  assert.equal(hasDebt({ balance: 450000 }), true);
  assert.equal(hasDebt({ balance: 0 }), false);
  assert.equal(hasDebt({ balance: 0.004 }), false, 'остаток после round2 — не долг');
  assert.equal(hasDebt(null), false);
});

test('остаток разложен на слагаемые: «не выставлено» и «выставлено, но не оплачено»', () => {
  const lines = balanceLines(OWING.balance);
  assert.deepEqual(lines.map((l) => l.label),
    ['Начислено, не выставлено', 'Выставлено счетами', 'Оплачено']);
  assert.equal(lines[0].value, money(150000));
  assert.equal(lines[2].value, money(100000));
  // Без счетов — одна строка: «выставлено 0 / оплачено 0» это шум, а не ответ.
  assert.equal(balanceLines(CLEAN.balance).length, 1);
});

test('границы суммы названы вслух — иначе человек поверит числу целиком', () => {
  const notes = excludeNotes(OWING.balance);
  // Сумма собирается той же money(), что и на экране: она ставит НЕРАЗРЫВНЫЙ
  // пробел в разрядах, и сравнение с обычным пробелом здесь молча не совпало бы.
  assert.ok(notes.some((n) => /учёте расходов/.test(n) && n.includes(money(90000))), notes.join(' | '));
  assert.ok(notes.some((n) => /аннулированные счета: 1/.test(n)));
  // Последнее исключение — БЕЗУСЛОВНОЕ: приёмы вне стационара и невнесённое не
  // попадают в долг никогда, и сказать об этом надо даже при нулевом долге.
  assert.ok(excludeNotes(CLEAN.balance).some((n) => /вне стационара/.test(n)));
});

test('фактическое время набирается местным, а уезжает в UTC', () => {
  assert.match(nowLocalInput(new Date(2026, 8, 5, 15, 40)), /^2026-09-05T15:40$/);
  const iso = localToUtcIso('2026-09-05T15:40');
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'формат базы, а не строка из поля');
  assert.equal(iso, new Date('2026-09-05T15:40').toISOString().slice(0, 19) + 'Z');
  assert.equal(localToUtcIso(''), null, 'не указали — пусть сервер поставит своё');
  assert.equal(localToUtcIso('не дата'), null);
});

// ─── 2. Долг предупреждает, а не запрещает ──────────────────────────────────

test('кнопка гаснет ТОЛЬКО из-за неподтверждённого долга — и ни от чего больше', () => {
  // Без долга — можно сразу, даже с открытым листом назначений и без документов.
  assert.equal(canSubmit(OWING, { debt_ack: false, close_orders: false, docs_given: false, bill_settled: false }), false);
  assert.equal(canSubmit(OWING, { debt_ack: true }), true, 'подпись — и выписка проходит С ДОЛГОМ');
  assert.equal(canSubmit(CLEAN, {}), true);
  assert.equal(canSubmit(CLEAN, { close_orders: false, docs_given: false, bill_settled: false }), true,
    'ни лист назначений, ни документы выписку не держат');
  assert.equal(canSubmit(null, {}), false);
});

// ─── 3. Экран ───────────────────────────────────────────────────────────────

test('очередь спрашивается у сервера и показывает, кого отпускают и с каким долгом', async () => {
  rpcCalls.length = 0;
  const root = mk('div');
  await renderDischarge(root, {});

  assert.equal(rpcCalls.filter((c) => c.name === 'admission_discharge_queue').length, 1);
  assert.equal(rpcCalls.filter((c) => c.name === 'inpatient_capabilities').length, 1,
    'право нажать спрашивается ОДИН раз на экран, а не по строке');

  const text = textOf(root);
  assert.ok(text.includes('Выписки к оформлению'));
  assert.ok(text.includes('Иванов Иван') && text.includes('Сидорова Мария'));
  assert.ok(text.includes('Терапия · K-1'), 'палата и койка');
  assert.ok(text.includes('Переведён в другое учреждение') && text.includes('Городская больница №2'));
  assert.ok(text.includes(money(450000)), 'долг посчитан сервером и показан');
  assert.ok(text.includes('Долга нет'), 'и у кого его нет — тоже сказано');
});

test('фильтр по отделению уходит В RPC, а не режет строки в браузере', async () => {
  rpcCalls.length = 0;
  const root = mk('div');
  await renderDischarge(root, {});
  const sel = walk(root).find((n) => n.tagName === 'SELECT');
  assert.ok(sel, 'выбор отделения есть');
  assert.deepEqual(sel.children.map((o) => textOf(o).trim()), ['Все отделения', 'Терапия', 'Хирургия']);

  sel.value = '2';
  sel.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rpcCalls.filter((c) => c.name === 'admission_discharge_queue').pop().args.ward_id, 2);
});

test('кнопки «Оформить выписку» нет у того, кому сервер откажет', async () => {
  CAN = { discharge: false };
  const root = mk('div');
  await renderDischarge(root, {});
  const text = textOf(root);
  assert.ok(!text.includes('Оформить выписку'), 'кнопки нет');
  assert.ok(text.includes('Оформляет старшая медсестра'), 'и сказано, кто это делает');
  CAN = { discharge: true };
});

test('окно оформления просит подпись под долгом и не даёт нажать без неё', async () => {
  const root = mk('div');
  const view = await renderDischarge(root, {});
  view.openFinalize(OWING);

  const modal = document.body.children[document.body.children.length - 1];
  const text = textOf(modal);
  assert.ok(text.includes('Оформление выписки'));
  assert.ok(text.includes('Фактическое время выписки'));
  assert.ok(text.includes('Долг согласован (гарантия / рассрочка)'));
  assert.ok(text.includes('Долг выписке не мешает'), 'сказано, что это предупреждение, а не запрет');
  assert.ok(text.includes('В сумму не входит:'), 'границы числа показаны');
  assert.ok(/Закрыть оставшиеся назначения \(2\)/.test(text), 'предложено закрыть лист назначений');

  const submit = walk(modal).find((n) => n.tagName === 'BUTTON' && /Оформить выписку/.test(textOf(n)));
  assert.ok(submit, 'кнопка есть');
  assert.equal(submit.disabled, true, 'но без подписи под долгом нажать нельзя');

  const ack = walk(modal).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox').pop();
  ack.checked = true;
  ack.dispatchEvent({ type: 'change' });
  assert.equal(submit.disabled, false, 'подпись — и кнопка ожила');
});

test('оформление уезжает на сервер целиком: время, чек-лист и подпись под долгом', async () => {
  rpcCalls.length = 0;
  const root = mk('div');
  const view = await renderDischarge(root, {});
  view.openFinalize(OWING);

  const modal = document.body.children[document.body.children.length - 1];
  const boxes = walk(modal).filter((n) => n.tagName === 'INPUT' && n.attrs.type === 'checkbox');
  for (const b of boxes) { b.checked = true; b.dispatchEvent({ type: 'change' }); }
  const at = walk(modal).find((n) => n.tagName === 'INPUT' && n.attrs.type === 'datetime-local');
  at.value = '2026-09-05T15:40';
  at.dispatchEvent({ type: 'change' });

  const submit = walk(modal).find((n) => n.tagName === 'BUTTON' && /Оформить выписку/.test(textOf(n)));
  submit.click();
  await new Promise((r) => setTimeout(r, 0));

  const call = rpcCalls.filter((c) => c.name === 'admission_discharge_finalize').pop();
  assert.ok(call, 'выписка отправлена');
  assert.equal(call.args.admission_id, 2);
  assert.equal(call.args.at, localToUtcIso('2026-09-05T15:40'), 'время в UTC');
  assert.equal(call.args.close_orders, true);
  assert.equal(call.args.bill_settled, true);
  assert.equal(call.args.docs_given, true);
  assert.equal(call.args.debt_ack, true, 'подпись под долгом уехала явно');
  // И очередь перечитана: оформленный из неё уходит.
  assert.ok(rpcCalls.filter((c) => c.name === 'admission_discharge_queue').length >= 2);
});

// ─── 4. Роли ────────────────────────────────────────────────────────────────

test('экран держат те, кто вправе оформить: надстройка считается наравне с основной ролью', () => {
  assert.deepEqual(DISCHARGE_ROLES, ['senior_nurse', 'head_doctor', 'admin']);
  assert.equal(canSeeDischarge({ role: 'nurse', extra_roles: ['senior_nurse'] }), true);
  assert.equal(canSeeDischarge({ role: 'doctor', extra_roles: ['head_doctor'] }), true);
  assert.equal(canSeeDischarge({ role: 'admin' }), true);
  // Обычная медсестра кладёт и лечит, но не оформляет; врач подал заявку и
  // видит её судьбу в карте пациента; касса в стационар не ходит.
  assert.equal(canSeeDischarge({ role: 'nurse' }), false);
  assert.equal(canSeeDischarge({ role: 'doctor' }), false);
  assert.equal(canSeeDischarge({ role: 'cashier' }), false);
  assert.equal(canSeeDischarge(null), false);
});
