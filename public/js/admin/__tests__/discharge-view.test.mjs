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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
globalThis.window={location:{hostname:'localhost'},localStorage:globalThis.localStorage,addEventListener(){},dispatchEvent(){return true;},open:()=>null};
globalThis.CustomEvent=class{constructor(t,o){this.type=t;Object.assign(this,o||{});}};
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join(' ');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const classesIn = (root) => {
  const out = new Set();
  for (const n of walk(root)) for (const c of String(n.className || '').split(/\s+/)) if (c) out.add(c);
  return out;
};

// ─── Настоящий CSS ──────────────────────────────────────────────────────────
//
// «Схлопнутые поля и рамки» родились из ОТСУТСТВИЯ правила: экран вешал классы
// .table, .card-title, .field-label, .input — и ни одного из них в таблицах
// стилей не было. Поэтому тесты ниже читают НАСТОЯЩИЙ CSS и проверяют, что у
// каждого класса есть правило, а у коробки — размер. Разбор тот же, что в
// lab-card.test.mjs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSSDIR = path.resolve(HERE, '..', '..', '..', 'css');
const CSS = ['admin.css', 'admin-views.css']
  .map((f) => fs.readFileSync(path.join(CSSDIR, f), 'utf8'))
  .join('\n').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const BLOCKS = (() => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
    const sels = m[1].split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const decls = {};
    for (const part of m[2].split(';')) {
      const j = part.indexOf(':');
      if (j === -1) continue;
      decls[part.slice(0, j).trim()] = part.slice(j + 1).trim();
    }
    out.push({ sels, decls });
  }
  return out;
})();
/** Объявления правила по точному селектору (все блоки слиты). */
function rule(sel) {
  const norm = sel.trim().replace(/\s+/g, ' ');
  const hits = BLOCKS.filter((b) => b.sels.includes(norm));
  assert.ok(hits.length, 'правило «' + sel + '» пропало из таблиц стилей');
  return Object.assign({}, ...hits.map((b) => b.decls));
}
/** Есть ли ХОТЬ ОДНО правило, которое красит этот класс. */
function classIsStyled(cls) {
  const re = new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])');
  return BLOCKS.some((b) => b.sels.some((x) => re.test(x)));
}

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

// ACCOMMODATION_GAP_V1 — что отвечает `accommodation_state`. У «чистого»
// пациента ТРОЕ СУТОК в койке и НИ ОДНОЙ строки проживания: долг под подписью
// показывает ноль, пока 450 000 койко-дней нигде не числятся. У должника
// проживание внесено полностью — называть нечего.
let ACCOMMODATION = {
  1: { stay_units: 3, invoiced: { units: 0, total: 0 },
       current: { units: 3, rate: 150000, gross: 450000, net: 450000, mode: 'daily', discount_pct: 0 },
       billed: null, stale: false },
  2: { stay_units: 2, invoiced: { units: 1, total: 200000 },
       current: { units: 1, rate: 200000, gross: 200000, net: 200000, mode: 'daily', discount_pct: 0 },
       billed: { id: 9, units: 1, rate: 200000, total: 200000, invoiced: false }, stale: false },
};
let CAN = { discharge: true };
let QUEUE_FAILS = false;   // сервер молчит — экран обязан сказать это словами
const rpcCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/rpc/')) {
    const name = u.slice('/api/rpc/'.length);
    rpcCalls.push({ name, args: JSON.parse((opts && opts.body) || '{}') });
    if (name === 'inpatient_capabilities') return { ok: true, json: async () => ({ data: { roles: [], can: CAN } }) };
    if (name === 'admission_discharge_queue') {
      if (QUEUE_FAILS) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, json: async () => ({ data: QUEUE }) };
    }
    // ACCOMMODATION_GAP_V1 — расчёт проживания по каждому, кого оформляют.
    if (name === 'accommodation_state') {
      const a = JSON.parse((opts && opts.body) || '{}').admission_id;
      return { ok: true, json: async () => ({ data: ACCOMMODATION[a] || null }) };
    }
    return { ok: true, json: async () => ({ data: { admission: { status: 'discharged' } } }) };
  }
  return { ok: true, json: async () => ({ data: [{ id: 1, name: 'Терапия' }, { id: 2, name: 'Хирургия' }] }) };
};

const {
  renderDischarge, canSeeDischarge, DISCHARGE_ROLES, outcomeTitle, money,
  hasDebt, balanceLines, excludeNotes, placeTitle, canSubmit,
  nowLocalInput, localToUtcIso, accommodationGap, accommodationWarning,
} = await import('../views/discharge.js');
const { setLang } = await import('../i18n.js');

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

// ─── 1б. Койко-дни без строки (ACCOMMODATION_GAP_V1) ────────────────────────

test('сутки в койке, за которые нет строки проживания, считаются и называются', () => {
  const gap = accommodationGap(ACCOMMODATION[1]);
  assert.ok(gap, 'три несчитанных койко-дня прошли молча — а это и есть недосчитанные деньги');
  assert.equal(gap.units, 3);
  assert.equal(gap.amount, 450000);
  // Выставленное и открытая строка вычитаются: считать заново уже внесённое
  // значило бы пугать кассу вторым счётом за те же сутки.
  assert.equal(accommodationGap(ACCOMMODATION[2]), null, 'проживание внесено — называть нечего');
  assert.equal(accommodationGap(null), null);
  // Бесплатная койка — решение клиники, а не пропажа.
  assert.equal(accommodationGap({ stay_units: 3, invoiced: { units: 0 }, current: { rate: 0 } }), null);

  const text = accommodationWarning(gap);
  assert.ok(text.includes('3') && text.includes(money(450000)), text);
  assert.ok(/сут/.test(text), 'единица срока не названа: ' + text);
  assert.equal(accommodationWarning(null), '');
});

test('экран называет невыставленное проживание рядом с остатком и в окне оформления', async () => {
  const root = mk('div');
  const view = await renderDischarge(root, {});
  const text = textOf(root);
  // Самый опасный случай — «Долга нет» при трёх невыставленных сутках.
  assert.ok(text.includes('Долга нет'), 'у первого пациента долга и правда нет');
  assert.ok(text.includes(money(450000)),
    'экран молчит о 450 000 непосчитанных койко-дней: ' + text.slice(0, 400));

  view.openFinalize(CLEAN);
  const modal = document.body.children[document.body.children.length - 1];
  const mtext = textOf(modal);
  assert.ok(mtext.includes('Проживание не внесено в счёт'),
    'окно оформления не называет пропажу: ' + mtext.slice(0, 400));
  assert.ok(mtext.includes(money(450000)), 'сумма пропажи не названа');
  assert.ok(mtext.includes('карте госпитализации'), 'не сказано, где это чинят');
  // Пропажа ПРЕДУПРЕЖДАЕТ, а не запрещает: подписи под ней не просят.
  const submit = walk(modal).find((n) => n.tagName === 'BUTTON' && /Оформить выписку/.test(textOf(n)));
  assert.equal(submit.disabled, false, 'невнесённое проживание выписку не держит');
});

test('проживание внесено — экран об этом молчит', async () => {
  const before = ACCOMMODATION;
  ACCOMMODATION = { 1: { ...before[1], stay_units: 0 }, 2: before[2] };
  try {
    const root = mk('div');
    const view = await renderDischarge(root, {});
    assert.ok(!textOf(root).includes('проживание не внесено'), 'лишнее предупреждение хуже молчания');
    view.openFinalize(CLEAN);
    const modal = document.body.children[document.body.children.length - 1];
    assert.ok(!textOf(modal).includes('Проживание не внесено в счёт'));
  } finally { ACCOMMODATION = before; }
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

// ═══ 5. ЯЗЫК ИНТЕРФЕЙСА: НИ ОДНОЙ СХЛОПНУТОЙ КОРОБКИ ════════════════════════
//
// Владелец: «fields and frames are collapsed». Причина была не в оформлении:
// экран ставил четыре класса, которых в таблицах стилей НЕТ — .table (очередь
// рисовалась голым <table>: ни отбивок, ни шапки, ни линеек), .card-title,
// .field-label и .input, — а `.card` брал без `.card-pad`, у которой и живут
// отступы. Тесты ниже стерегут следствие, а не «класс проставлен».

/** Монтирует экран в заданном состоянии сервера и отдаёт корень и окно. */
async function screen({ rows = [CLEAN, OWING], fails = false, can = { discharge: true } } = {}) {
  QUEUE = { ward_id: null, outcomes: ['home', 'transfer', 'refuse', 'death'], rows };
  QUEUE_FAILS = fails; CAN = can;
  document.body.children.length = 0;
  const root = mk('div');
  const view = await renderDischarge(root, {});
  await new Promise((r) => setTimeout(r, 0));
  const wins = byClass(root, 'card');
  assert.equal(wins.length, 1, 'рабочее окно должно быть ровно одно, а их ' + wins.length);
  return { root, win: wins[0], view };
}
function resetServer() {
  QUEUE = { ward_id: null, outcomes: ['home', 'transfer', 'refuse', 'death'], rows: [CLEAN, OWING] };
  QUEUE_FAILS = false; CAN = { discharge: true };
}
const STATES = {
  queue: () => screen({}),
  empty: () => screen({ rows: [] }),
  error: () => screen({ fails: true }),
};

// Классы без собственного правила — только МЕТКИ экрана (корень .dq), не
// оформление.
const UNSTYLED_OK = new Set(['dq']);

test('ни один класс экрана не остался без правила — именно этим и были «схлопнутые рамки»', async () => {
  try {
    for (const [name, mount] of Object.entries(STATES)) {
      const { root } = await mount();
      for (const cls of classesIn(root)) {
        if (UNSTYLED_OK.has(cls)) continue;
        assert.ok(classIsStyled(cls),
          name + ': класс «' + cls + '» экран вешает, а правила для него нет ни в одной таблице стилей');
      }
    }
    // Окно оформления — тоже экран: его панели проверяются отдельно.
    const { view } = await screen({});
    view.openFinalize(OWING);
    const modal = document.body.children[document.body.children.length - 1];
    for (const cls of classesIn(modal)) {
      if (UNSTYLED_OK.has(cls)) continue;
      assert.ok(classIsStyled(cls), 'окно оформления: класс «' + cls + '» без правила');
    }
  } finally { resetServer(); }
});

test('в каждом состоянии есть коробка настоящего размера, а не полоска у рамки', async () => {
  try {
    for (const name of ['empty', 'error']) {
      const { root } = await STATES[name]();
      const notes = byClass(root, 'dq-note');
      assert.equal(notes.length, 1, name + ': состояние нарисовано без блока-заглушки');
      assert.ok(textOf(notes[0]).trim().length > 10, name + ': заглушка молчит о том, что случилось');
    }
    const note = rule('.dq-note');
    assert.ok(parseFloat(note['min-height']) >= 120, 'заглушка снова схлопнулась по высоте: ' + note['min-height']);
    assert.ok(/\d/.test(String(note.padding || '')), 'у заглушки нет отступов');

    const f = rule('.dq-bar .field');
    assert.ok(/\d/.test(String(f.flex || '')), 'выбор отделения снова без ширины: flex=' + f.flex);
    assert.ok(parseFloat(f['min-width']) >= 120, 'выбор отделения может сжаться в ничто: ' + f['min-width']);
    assert.ok(/\d/.test(String(rule('.dq-bar').padding || '')), 'полоса фильтра прижата к рамке окна');

    // Строка очереди: сетка с именованными областями и собственными отступами.
    const row = rule('.dq-row');
    assert.equal(row.display, 'grid', 'строка очереди перестала быть сеткой');
    assert.ok(/\d/.test(String(row.padding || '')), 'строка очереди прижата к рамке');
    // Правило .dq-row объявлено дважды (обычная ширина и @media), поэтому
    // сетку читаем из текста таблицы стилей, а не из слитых объявлений.
    assert.ok(/"main money act"\s*"alert alert alert"/.test(CSS),
      'полоса предупреждения перестала занимать всю ширину строки');
    assert.ok(/grid-template-columns:\s*minmax/.test(CSS), 'колонки строки очереди пропали');
    // И то же на узком экране — иначе деньги и кнопка уезжают за край.
    assert.ok(/max-width:\s*900px/.test(CSS), 'узкий экран больше не обслуживается');
  } finally { resetServer(); }
});

test('очередь — строки со своей рамкой-линией, а не голая <table class="table">', async () => {
  try {
    const { root, win } = await STATES.queue();
    assert.equal(walk(root).filter((n) => n.tagName === 'TABLE').length, 0,
      'вернулась таблица — а вместе с ней восемь узких колонок и .table без правила');
    const rows = byClass(root, 'dq-row');
    assert.equal(rows.length, 2, 'в очереди должно быть две строки');
    assert.equal(win.getAttribute('data-state'), 'queue');
    // Строки разделены линией, а не собственными рамками с тенью.
    assert.ok(/ink-100/.test(String(rule('.dq-row')['border-top'] || '')), 'строки перестали разделяться линией');
    assert.equal(byClass(win, 'card').length, 1, 'внутри окна снова окно');
  } finally { resetServer(); }
});

// ═══ 6. ОДНО ГЛАВНОЕ ДЕЙСТВИЕ ══════════════════════════════════════════════

test('главная кнопка — одна на строку, и ни одной там, где оформлять нечего или некому', async () => {
  try {
    const { root } = await STATES.queue();
    for (const row of byClass(root, 'dq-row')) {
      const primaries = byClass(row, 'btn-primary');
      assert.equal(primaries.length, 1, 'на строке главных кнопок ' + primaries.length);
      assert.ok(textOf(primaries[0]).includes('Оформить выписку'), 'главная кнопка строки — не оформление');
    }
    // Вне строк главных кнопок нет: «Обновить» — второстепенное действие.
    assert.equal(byClass(root, 'btn-primary').length, 2, 'главная кнопка завелась вне строки очереди');

    for (const name of ['empty', 'error']) {
      const { root: r } = await STATES[name]();
      assert.equal(byClass(r, 'btn-primary').length, 0, name + ': главная кнопка там, где нечего оформлять');
    }
    // Сервер откажет — кнопки нет вовсе, и сказано, кто это делает.
    const { root: noRights } = await screen({ can: { discharge: false } });
    assert.equal(byClass(noRights, 'btn-primary').length, 0, 'кнопка есть у того, кому сервер откажет');
    assert.equal(byClass(noRights, 'dq-nope').length, 2, 'не сказано, кто оформляет');
  } finally { resetServer(); }
});

test('в окне оформления главная кнопка ровно одна — «Оформить выписку»', async () => {
  try {
    const { view } = await screen({});
    view.openFinalize(OWING);
    const modal = document.body.children[document.body.children.length - 1];
    const primaries = byClass(modal, 'btn-primary');
    assert.equal(primaries.length, 1, 'в окне главных кнопок ' + primaries.length);
    assert.ok(textOf(primaries[0]).includes('Оформить выписку'));
    const cancel = walk(modal).find((n) => n.tagName === 'BUTTON' && /Отмена/.test(textOf(n)));
    assert.ok(cancel && !hasClass(cancel, 'btn-primary'), '«Отмена» стала вторым равным призывом');
  } finally { resetServer(); }
});

// ═══ 7. ТЕКСТ БЕЗОПАСНОСТИ ОСТАЁТСЯ ГРОМКИМ ═════════════════════════════════

test('долг и невнесённое проживание видно в очереди — и оба взяты семантическим цветом', async () => {
  try {
    const { root } = await STATES.queue();
    // Долг — тег состояния (--warn), а не пастель: пастель здесь означала бы
    // «чей-то», а долг это не личность.
    const debts = byClass(root, 'dq-debt');
    assert.equal(debts.length, 2, 'остаток показан не у каждого');
    const text = textOf(root);
    assert.ok(text.includes(money(450000)), 'долг пропал из очереди');
    assert.ok(text.includes('Долга нет'), 'и у кого его нет — тоже сказано');
    assert.ok(byClass(root, 'tag-warn').length >= 1, 'долг перестал быть предупреждением');

    // ACCOMMODATION_GAP_V1 — полоса во всю ширину строки, а не третья строка
    // самой тесной ячейки. И она стоит у ЧИСТОГО пациента: «Долга нет» при
    // трёх невыставленных койко-днях — самый опасный случай.
    const alerts = byClass(root, 'dq-alert');
    assert.equal(alerts.length, 1, 'предупреждение о проживании пропало из очереди');
    const at = textOf(alerts[0]);
    assert.ok(at.includes(money(450000)) && /сут/.test(at), 'предупреждение молчит о сумме или сроке: ' + at);
    const clean = byClass(root, 'dq-row')[0];
    assert.equal(byClass(clean, 'dq-alert').length, 1, 'предупреждение стоит не у того пациента');
    // В РАЗМЕТКЕ полоса идёт ДО кнопки: диктор и клавиатура идут по порядку
    // узлов, и текст безопасности обязан быть прочитан раньше действия.
    const order = walk(clean).filter((n) => hasClass(n, 'dq-alert') || hasClass(n, 'btn-primary'));
    assert.ok(hasClass(order[0], 'dq-alert'),
      'кнопку оформления читают раньше предупреждения о непосчитанных койко-днях');

    const css = rule('.dq-alert');
    assert.ok(/crit-50/.test(String(css.background || '')), 'полоса перестала быть красной по смыслу');
    assert.ok(/crit-700/.test(String(css.color || '')), 'текст полосы больше не критический');
    assert.ok(!/--p-bg|pastel/.test(String(css.background || '')), 'состояние перекрасили в пастель');
  } finally { resetServer(); }
});

test('в окне оформления и предупреждение о проживании, и подпись под долгом — панели, а не карточки в карточке', async () => {
  try {
    const { view } = await screen({});
    // «Чистый» пациент: долга нет, а трёх койко-дней в счёте нет тоже.
    view.openFinalize(CLEAN);
    let modal = document.body.children[document.body.children.length - 1];
    let panels = byClass(modal, 'dq-panel');
    assert.equal(panels.length, 1, 'у пациента без долга пропала панель проживания');
    assert.ok(hasClass(panels[0], 'is-crit'), 'пропажа проживания перестала быть критической');
    assert.ok(textOf(panels[0]).includes('Проживание не внесено в счёт'));
    assert.ok(textOf(panels[0]).includes(money(450000)), 'сумма пропажи не названа');
    assert.ok(textOf(panels[0]).includes('карте госпитализации'), 'не сказано, где это чинят');
    assert.equal(byClass(modal, 'card').length, 0,
      'внутри модального окна снова .card — вторая рамка и вторая тень в окне');

    // Должник: панель долга с подписью, и она предупреждает, а не запрещает.
    view.openFinalize(OWING);
    modal = document.body.children[document.body.children.length - 1];
    panels = byClass(modal, 'dq-panel');
    assert.ok(panels.some((p) => hasClass(p, 'is-warn')), 'панель долга пропала');
    const debtPanel = panels.find((p) => hasClass(p, 'is-warn'));
    const dt = textOf(debtPanel);
    assert.ok(dt.includes('Долг выписке не мешает'), 'исчезло «предупреждает, а не запрещает»');
    assert.ok(dt.includes('Долг согласован (гарантия / рассрочка)'), 'подпись под долгом пропала');
    assert.ok(dt.includes('В сумму не входит:'), 'границы числа больше не показаны');
    for (const l of balanceLines(OWING.balance)) {
      assert.ok(dt.includes(l.label) && dt.includes(l.value), 'слагаемое «' + l.label + '» пропало');
    }
    // Цвета панелей — семантические токены, а не вписанная руками rgba.
    assert.ok(/warn-50/.test(String(rule('.dq-panel.is-warn').background || '')));
    assert.ok(/crit-50/.test(String(rule('.dq-panel.is-crit').background || '')));
    assert.ok(!/rgba\(179,\s*38,\s*30/.test(CSS), 'вернулся жёстко вписанный красный вместо токена');
  } finally { resetServer(); }
});

// ═══ 8. ДАТЫ — СЛОВОМ, НА ТРЁХ ЯЗЫКАХ ══════════════════════════════════════

test('дата подачи заявки написана словом во всех трёх языках', async () => {
  const want = { ru: /сентября/, uz: /sentabr/, en: /September/ };
  try {
    for (const [lang, re] of Object.entries(want)) {
      setLang(lang);
      const { root } = await STATES.queue();
      const t = textOf(root);
      assert.ok(re.test(t), lang + ': месяц не написан словом в очереди');
      assert.ok(!/2026-09-04T/.test(t), lang + ': в очередь вернулась машинная дата');
    }
  } finally { setLang('ru'); resetServer(); }
});

// ═══ 9. ШКАЛА ═══════════════════════════════════════════════════════════════

test('все размеры экрана — со шкалы восьми ступеней (пол 12.5px)', () => {
  const STEPS = new Set([12.5, 13.5, 15, 17, 20, 24, 30, 40]);
  for (const sel of ['.dq-name', '.dq-no', '.dq-fact', '.dq-dest', '.dq-debt', '.dq-debt.is-clear',
                     '.dq-nope', '.dq-alert', '.dq-panel-t', '.dq-panel-p', '.dq-sums',
                     '.dq-excl-list', '.dq-quiet', '.dq-lab', '.dq-note-t']) {
    const v = parseFloat(rule(sel)['font-size']);
    assert.ok(STEPS.has(v), sel + ': ' + v + 'px — не ступень шкалы');
  }
});
