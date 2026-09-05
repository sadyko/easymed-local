// LAB_QUEUE_SPLIT_V1 (2026-09-05) — граница между пациентами в очереди.
//
// Владелец: «the breakdowns in the lab we need to add between the patients or
// orders», со снимком, на котором одна карточка кончается и тут же начинается
// следующая. Ошибка, которую этим предотвращают, на лабораторном экране ровно
// одна и она же самая дорогая: СДЕЛАТЬ ПРАВИЛЬНОЕ ДЕЙСТВИЕ НЕ ТОМУ ПАЦИЕНТУ.
// Поэтому граница обязана читаться с метра, на клиническом мониторе, без
// вглядывания.
//
// ДИАГНОЗ, из которого следует решение. Зазор между карточками был не
// маленький — он был НЕВИДИМЫЙ: очередь лежала внутри белой панели (.card),
// карточки тоже белые, и 12 px между ними были белым по белому. Рамка карточки
// рисовалась --ink-100 (#e7ebee) — 1.14:1 к белому. Увеличивать такой зазор
// бессмысленно: белого стало бы больше, границы — нет. Значит, лечится не
// расстояние, а ЗАЛИВКА: очередь снимается с белой панели и кладётся на грунт,
// и зазор становится полосой другого цвета во всю ширину.
//
// Тесты ниже поэтому меряют не «отступ проставлен», а то, ВИДНА ли граница:
// контраст полосы к карточке и края карточки к полосе считается из тех же
// токенов, что уходят в браузер (admin.css → admin-views.css), и проверяется
// на шести подряд идущих карточках всех состояний — включая приглушённую
// неоплаченную, чей собственный пунктирный край и есть главный кандидат в
// «ложные разделители».
//
// Отдельно зафиксирована ЦЕНА: сколько карточек помещается в экран 1366×768.
// Это факт, а не пожелание: разделитель, съевший половину видимой очереди,
// решал бы одну проблему лаборанта, создавая другую.
//
// Поддельный DOM — тот же, что в __tests__/lab-card.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} remove(){} select(){} closest(){return null;}
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
const fakeBody = mk('body');
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:fakeBody,documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;}};

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
fakeLocalStorage.setItem('admin.lang', 'ru');   // I18N_LOCALE_PIN_V1 — до импорта вида

globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => false,
};
globalThis.confirm = () => false;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async () => {} } },
});

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const toastEl = mk('div');
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- поддельный /api/db ------------------------------------------------------
let VISIT_SERVICES = [];
let VISITS = [];
let LAB_RESULTS = [];
function statusFilter(body) {
  for (const f of (body && body.filters) || []) if (f && f.col === 'status') return f;
  return null;
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/db')) {
    const table = body && body.table;
    let rows = {
      visit_services: VISIT_SERVICES,
      visits: VISITS,
      lab_results: LAB_RESULTS,
      lab_panels: [], lab_panel_analytes: [], services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [], doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

// --- очередь из шести подряд идущих пациентов --------------------------------
// Ровно тот набор, на котором разделитель обязан выжить: одна анализа и пять,
// неоплаченная (приглушённая, с пунктиром), пациент соседнего здания с меткой
// «Филиал Б», и все пять рабочих состояний карточки.
const SVC = (name) => ({ name, is_lab: true, type: 'lab', specimen: 'Кровь', tube_color: 'lavender', department_id: 'd-1' });
let uid = 800;
function vs(visitId, status, extra = {}) {
  const id = ++uid;
  return {
    id, visit_id: visitId, service_id: 's-' + id, status,
    sample_collected_at: (status === 'added' || status === 'queued') ? null : '2026-09-05T08:20:00Z',
    sync_origin: null, services: SVC('Общий анализ крови'),
    ...extra,
  };
}
function res(vsId, flag, value) {
  return { id: 'r-' + vsId, visit_service_id: vsId, parameter: 'Гемоглобин', value, unit: 'г/л', flag, notes: null, entered_at: '2026-09-05T09:00:00Z' };
}
const P = (n, name, mrn) => ({ id: 'p-' + n, full_name: name, mrn, gender: n % 2 ? 'female' : 'male', date_of_birth: '199' + n + '-11-15' });

/** Шесть карточек подряд, в порядке очереди. Возвращает массив .lq-card. */
async function queue() {
  uid = 800;
  VISIT_SERVICES = []; LAB_RESULTS = []; VISITS = [];
  const rows = [];
  const add = (...r) => { rows.push(...r); return r; };

  // 1. НЕ ОПЛАЧЕНО — приглушённая карточка с пунктирным краем, один анализ.
  add(vs('v-1', 'added'));
  // 2. ОПЛАЧЕНО, РЕЗУЛЬТАТОВ НЕТ — пять анализов, самая высокая карточка.
  add(vs('v-2', 'queued'), vs('v-2', 'queued'), vs('v-2', 'collected'), vs('v-2', 'collected'), vs('v-2', 'in_progress'));
  // 3. ЧАСТИЧНО — сосед по очереди у неоплаченной сверху и у «филиала» снизу.
  const partial = add(vs('v-3', 'resulted'), vs('v-3', 'collected'));
  LAB_RESULTS.push(res(partial[0].id, 'high', '171'));
  // 4. ВНЕСЕНЫ ВСЕ — и это пациент СОСЕДНЕГО ЗДАНИЯ («Филиал Б»).
  const entered = add(vs('v-4', 'resulted', { sync_origin: 'Б' }), vs('v-4', 'resulted', { sync_origin: 'Б' }));
  LAB_RESULTS.push(res(entered[0].id, 'normal', '138'), res(entered[1].id, 'critical', '31'));
  // 5. ВЫДАНО — закрытая проба.
  const done = add(vs('v-5', 'completed'), vs('v-5', 'completed'));
  LAB_RESULTS.push(res(done[0].id, 'normal', '4.2'), res(done[1].id, 'low', '3.1'));
  // 6. ЕЩЁ ОДНА НЕ ОПЛАЧЕНА — две приглушённые карточки подряд: случай, в
  //    котором пунктир соседа проще всего принять за разделитель.
  add(vs('v-6', 'added'), vs('v-6', 'added'));

  VISIT_SERVICES = rows;
  VISITS = [
    { id: 'v-1', visit_date: '2026-09-05', patients: P(1, 'Каримова Азиза Рустамовна', 'P-26-70126') },
    { id: 'v-2', visit_date: '2026-09-05', patients: P(2, 'Юсупов Бахтиёр Анварович', 'P-26-70127') },
    { id: 'v-3', visit_date: '2026-09-05', patients: P(3, 'Исмоилова Нилуфар', 'P-26-70128') },
    { id: 'v-4', visit_date: '2026-09-05', patients: P(4, 'Раҳимов Жасур Улуғбекович', 'P-26-70129') },
    { id: 'v-5', visit_date: '2026-09-05', patients: P(5, 'Тошматова Дилноза', 'P-26-70130') },
    { id: 'v-6', visit_date: '2026-09-05', patients: P(6, 'Абдуллаев Санжар', 'P-26-70131') },
  ];

  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  // «Все» — иначе выданная проба (completed) в очередь не попадёт и шести
  // карточек подряд не будет.
  const chip = buttons(root).find((b) => textOf(b).startsWith('Все'));
  assert.ok(chip, 'фильтр «Все» пропал из шапки очереди');
  chip.click();
  await tick();
  return { root, cards: byClass(root, 'lq-card') };
}

// --- CSS: токены и правила, как их видит браузер -----------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const readCss = (name) => fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'css', name), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const VIEWS_CSS = readCss('admin-views.css');
const APP_CSS = readCss('admin.css');

function blocksOf(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const decls = {};
    for (const part of m[2].split(';')) {
      const j = part.indexOf(':');
      if (j === -1) continue;
      decls[part.slice(0, j).trim()] = part.slice(j + 1).trim();
    }
    out.push({ sels, decls });
  }
  return out;
}
/** Убирает @media-блоки: правила внутри них — это ДРУГОЙ экран, и сливать их
 *  с настольными значило бы мерить границу шириной телефона. */
function desktopOnly(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let j = css.indexOf('{', at), depth = 0;
    if (j === -1) break;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { j++; break; }
    }
    i = j;
  }
  return out;
}
const BLOCKS = blocksOf(desktopOnly(VIEWS_CSS));
function rule(sel) {
  const norm = sel.trim().replace(/\s+/g, ' ');
  const hits = BLOCKS.filter((b) => b.sels.includes(norm));
  assert.ok(hits.length, 'правило «' + sel + '» пропало из admin-views.css');
  return Object.assign({}, ...hits.map((b) => b.decls));
}

// Токены :root из admin.css — те самые значения, что попадают в браузер.
const TOKENS = (() => {
  const t = {};
  for (const b of blocksOf(APP_CSS)) {
    if (!b.sels.some((s) => s === ':root' || s.startsWith(':root'))) continue;
    for (const [k, v] of Object.entries(b.decls)) if (k.startsWith('--')) t[k] = v;
  }
  return t;
})();

/** var(--x) → конкретный цвет; цепочки токенов разворачиваются. */
function color(value, depth = 0) {
  let v = String(value == null ? '' : value).trim();
  const m = /^var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)$/.exec(v);
  if (m) {
    assert.ok(depth < 6, 'цикл в токенах цвета: ' + value);
    const next = TOKENS[m[1]] != null ? TOKENS[m[1]] : m[2];
    assert.ok(next != null, 'токен ' + m[1] + ' не объявлен в :root (admin.css)');
    return color(next, depth + 1);
  }
  return v.toLowerCase();
}
function rgb(hex) {
  let h = String(hex).trim().replace('#', '');
  if (h === 'white') h = 'ffffff';
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  assert.ok(/^[0-9a-f]{6}$/.test(h), 'не цвет: ' + hex);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Контраст по WCAG: 1.00 — цвета совпали, 21 — чёрное на белом. */
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const px = (v) => parseFloat(String(v));
const round2 = (n) => Math.round(n * 100) / 100;

// Цвета очереди — один раз, из CSS.
const CARD_BG   = color(rule('.lq-card').background.split(' ')[0]);
const GAP_BG    = color(rule('.lq-queue').background);
const CARD_EDGE = color(rule('.lq-card').border.split(/\s+/).pop());
const UNPAID    = rule('.lq-card[data-state="unpaid"]');
const UNPAID_BG = color(UNPAID.background);
const UNPAID_EDGE = color(UNPAID['border-color']);
const GAP_PX    = px(rule('.lq-card')['margin-bottom']);

// ═══ 1. ГРАНИЦА ЕСТЬ И ОНА ИЗМЕРИМА ═════════════════════════════════════════

test('между двумя соседними карточками лежит полоса — другого цвета и измеримой высоты', async () => {
  const { cards } = await queue();
  assert.ok(cards.length >= 6, 'ожидалось не меньше шести карточек подряд, пришло ' + cards.length);

  // Высота полосы. 12 px было и раньше — и не помогало; дело не только в ней,
  // но меньше 12 полоса перестаёт быть полосой.
  assert.ok(GAP_PX >= 14, 'зазор между карточками ' + GAP_PX + 'px — граница снова тоньше, чем была признана недостаточной');

  // ГЛАВНОЕ: полоса ЗАЛИТА, и залита не тем же, чем карточка. Пока очередь
  // лежала на белой панели, здесь было ровно 1.00 — белое по белому, и
  // никакая высота зазора этого не чинила.
  const c = contrast(GAP_BG, CARD_BG);
  assert.ok(c >= 1.15,
    'полоса между карточками (' + GAP_BG + ') почти не отличается от карточки (' + CARD_BG + '): контраст ' + round2(c) + ':1');
});

test('у карточки есть край — иначе белый лист на сером расплывается', () => {
  const toPaper = contrast(CARD_EDGE, CARD_BG);
  const toGap   = contrast(CARD_EDGE, GAP_BG);
  assert.ok(toPaper >= 1.35, 'край карточки (' + CARD_EDGE + ') к белому: ' + round2(toPaper) + ':1 — это волосок, а не край');
  assert.ok(toGap >= 1.2, 'край карточки к полосе: ' + round2(toGap) + ':1 — край сливается с разделителем');
});

// ═══ 2. ГРАНИЦА ДЕРЖИТСЯ ВО ВСЕХ СОСТОЯНИЯХ ═════════════════════════════════

test('в очереди стоят все пять состояний подряд — и разделитель между ними один и тот же', async () => {
  const { cards } = await queue();
  const states = cards.map((c) => c.attrs['data-state']);
  for (const s of ['unpaid', 'fresh', 'partial', 'entered', 'released']) {
    assert.ok(states.includes(s), 'состояние «' + s + '» не встало в очередь: ' + states.join(', '));
  }
  // Соседей одного состояния тоже проверяем: две неоплаченные подряд — тот
  // случай, где пунктир соседа проще всего принять за разделитель.
  assert.ok(states.filter((s) => s === 'unpaid').length >= 2, 'в фикстуре не осталось двух неоплаченных подряд');

  // Ни одно состояние не имеет права переопределить зазор: разная граница
  // между разными парами карточек — это уже не граница, а шум.
  const perState = BLOCKS.filter((b) => b.sels.some((s) => s.includes('lq-card') && s.includes('data-state')))
    .filter((b) => 'margin-bottom' in b.decls || 'margin' in b.decls);
  assert.strictEqual(perState.length, 0,
    'состояние карточки меняет её отступ — расстояние между пациентами перестало быть постоянным');
});

test('приглушённая неоплаченная карточка — всё ещё карточка, а её пунктир не спутать с разделителем', async () => {
  const { cards } = await queue();
  const unpaid = cards.filter((c) => c.attrs['data-state'] === 'unpaid');
  assert.ok(unpaid.length >= 2, 'неоплаченных карточек в очереди меньше двух');

  // 1. Заливка неоплаченной ОТЛИЧАЕТСЯ от полосы: карточка цвета зазора
  //    перестала бы быть карточкой и слилась бы с соседом через разделитель.
  const toGap = contrast(UNPAID_BG, GAP_BG);
  assert.ok(toGap >= 1.12,
    'неоплаченная карточка (' + UNPAID_BG + ') почти цвета полосы (' + GAP_BG + '): ' + round2(toGap) + ':1 — она растворилась в разделителе');

  // 2. Её пунктирный край ВИДЕН на полосе. Прежний --ink-100 (#e7ebee) на
  //    грунте #eaedf1 давал 1.02:1 — край карточки исчезал, и глаз принимал
  //    за границу что попало.
  assert.strictEqual(UNPAID['border-style'], 'dashed', 'неоплаченная потеряла пунктир — знак «работы здесь нет»');
  const edgeOnGap = contrast(UNPAID_EDGE, GAP_BG);
  assert.ok(edgeOnGap >= 1.5,
    'пунктир неоплаченной (' + UNPAID_EDGE + ') на полосе даёт ' + round2(edgeOnGap) + ':1 — край карточки не читается');

  // 3. И он НЕ выдаёт себя за разделитель: разделитель — заливка во всю
  //    ширину, а не линия. Правила вида «.lq-card + .lq-card { border-top }»
  //    здесь быть не должно: тогда у неоплаченной было бы две границы подряд.
  const lines = BLOCKS.filter((b) => b.sels.some((s) => /lq-card\s*\+\s*\.lq-card/.test(s)))
    .filter((b) => Object.keys(b.decls).some((k) => k.startsWith('border')));
  assert.strictEqual(lines.length, 0,
    'между карточками появилась ЛИНИЯ — рядом с пунктирной неоплаченной их станет две, и обе будут значить разное');
});

test('карточка соседнего здания несёт метку «Филиал Б» и отделена так же, как своя', async () => {
  const { cards } = await queue();
  const tagged = cards.filter((c) => byClass(c, 'lq-branch').length);
  assert.strictEqual(tagged.length, 1, 'меток филиала на очереди: ' + tagged.length + ' — ожидалась ровно одна');
  assert.ok(textOf(byClass(tagged[0], 'lq-branch')[0]).includes('Филиал Б'), 'метка филиала потеряла букву здания');
  // Метка ничего не меняет в отделении карточки: отступ у неё общий.
  assert.strictEqual(tagged[0].attrs['data-state'], 'entered', 'фикстура «филиала» сменила состояние — тест перестал проверять соседство');
});

test('очередь лежит НА грунте, а не внутри белой панели — иначе зазор снова станет белым по белому', async () => {
  const { root } = await queue();
  const queues = byClass(root, 'lq-queue');
  assert.strictEqual(queues.length, 1, 'контейнер очереди .lq-queue не найден (или их несколько)');
  const cardsInside = byClass(queues[0], 'lq-card');
  assert.ok(cardsInside.length >= 6, 'карточки лежат не в .lq-queue — полоса между ними ничем не залита');
  // Белой панели вокруг очереди больше нет: именно она делала зазор невидимым.
  const white = walk(root).filter((n) => hasClass(n, 'card') && byClass(n, 'lq-card').length);
  assert.strictEqual(white.length, 0, 'очередь снова обёрнута в белую панель .card — зазор между карточками опять белый по белому');
});

// ═══ 3. ЦЕНА: СКОЛЬКО ПАЦИЕНТОВ ВИДНО НА ЭКРАНЕ 1366×768 ════════════════════
//
// Разделитель, съевший видимую очередь, меняет одну ошибку на другую: лаборант
// начинает листать и терять место. Поэтому цена — тоже утверждение.
//
// Модель высоты. Всё, что можно прочитать из CSS, читается из CSS (падинги,
// отступы, высота плашки состояния и кнопки): тогда правка стилей ломает тест,
// а не тихо крадёт строки. Высота текста считается по правилам той же таблицы:
// line-height 1.5 у корпуса (admin.css), 1.2 у .lq-title.

const VIEWPORT = { w: 1366, h: 768 };
const BTN_H = px(rule2(APP_CSS, '.btn-sm')['height']);         // 30 — кнопки карточки .btn.btn-sm
const TAG_H = 22;                                              // .lq-state / .tag — одна строка 22px
function rule2(css, sel) {
  const hits = blocksOf(css).filter((b) => b.sels.includes(sel));
  assert.ok(hits.length, 'правило «' + sel + '» пропало из admin.css');
  return Object.assign({}, ...hits.map((b) => b.decls));
}

/** Высота шага очереди для карточки с n анализами, в px. */
function cardPitch(n, gap = GAP_PX) {
  const card = rule('.lq-card');
  const pad = card.padding.split(/\s+/).map(px);               // 14 16 10
  const box = pad[0] + pad[2] + 2;                             // + рамка 1px сверху и снизу
  // Шапка: аватар 34 против колонки «кто это».
  const head = Math.max(34,
      17 * 1.2                                                  // .lq-title
    + px(rule('.lq-facts')['margin-top']) + 13.5 * 1.5          // .lq-facts
    + px(rule('.lq-marks')['margin-top']) + TAG_H);             // .lq-marks
  const status = px(rule('.lq-status')['margin-top'])
    + px(rule('.lq-status')['padding-top']) + 1                 // border-top
    + Math.max(TAG_H, BTN_H);
  const itemPad = rule('.lq-item').padding.split(/\s+/).map(px); // 8 6
  const item = itemPad[0] * 2 + 13.5 * 1.5 + 12.5 * 1.5 + 1;   // падинг сверху/снизу + название + подпись + линия
  const list = px(rule('.lq-list')['margin-top']) + n * item;
  return box + head + status + list + gap;
}
/** Сколько пикселей очереди видно на экране 768 — без прокрутки. */
function queueViewport() {
  const shellGap = px(TOKENS['--shell-gap']);
  const topbar = px(TOKENS['--topbar-h']);
  const viewPad = px(rule2(APP_CSS, '.view-root')['padding'].split(/\s+/)[0]);
  const head = 24 * 1.5 + 2 + 13.5 * 1.5 + px(rule2(APP_CSS, '.page-head')['margin-bottom']);
  return VIEWPORT.h - shellGap - topbar - viewPad - head;
}

test('цена разделителя: сколько пациентов видно на экране 1366×768', () => {
  const visible = queueViewport();
  const pitchNow = cardPitch(1);
  const pitchBefore = cardPitch(1, 12);                        // зазор до правки
  const fitNow = visible / pitchNow;
  const fitBefore = visible / pitchBefore;

  // ФАКТ, зафиксированный намеренно: на 1366×768 в очереди видно ~2.5 карточки
  // с одним анализом. Если правка стилей уронит это число — тест упадёт, и
  // «мы просто чуть увеличили отступы» перестанет проходить молча.
  assert.ok(fitNow >= 2.4,
    'на экране 1366×768 помещается ' + round2(fitNow) + ' карточки (' + Math.round(visible) + 'px видимой очереди / '
    + Math.round(pitchNow) + 'px шаг) — очередь стала листаться вдвое чаще');

  // И цена самой полосы: не больше десятой доли карточки.
  assert.ok(fitBefore - fitNow <= 0.1,
    'разделитель стоит ' + round2(fitBefore - fitNow) + ' карточки экрана — это уже не граница, а расход высоты');
  // Доля полосы в шаге карточки — та же мысль, но не зависящая от экрана.
  assert.ok(GAP_PX / pitchNow <= 0.08,
    'полоса занимает ' + Math.round(GAP_PX / pitchNow * 100) + '% высоты карточки');
});

test('карточка на пять анализов помещается в экран целиком — иначе длинную пробу не увидеть за раз', () => {
  assert.ok(cardPitch(5) <= queueViewport(),
    'карточка с пятью анализами (' + Math.round(cardPitch(5)) + 'px) выше видимой очереди ('
    + Math.round(queueViewport()) + 'px) — лаборант не увидит её границ одновременно');
});

test('на узком экране полоса остаётся, только уже', () => {
  const media = /@media \(max-width: 720px\)\{([\s\S]*?)\n\}/.exec(VIEWS_CSS.replace(/\r\n/g, '\n'));
  assert.ok(media, 'мобильный блок LAB_CARD_V3 пропал');
  const m = /\.lq-card\{[^}]*margin-bottom:\s*(\d+)px/.exec(media[1]);
  assert.ok(m, 'на узком экране зазор между карточками не задан — он унаследует десктопный');
  assert.ok(Number(m[1]) >= 12, 'на узком экране полоса ужалась до ' + m[1] + 'px — это уже не граница');
});

// ═══ 4. РАЗДЕЛИТЕЛЬ НИЧЕГО НЕ ДОБАВИЛ НА ЭКРАН ══════════════════════════════

test('граница не принесла ни одного нового кегля и ни одной новой краски', () => {
  const STEPS = new Set([12.5, 13.5, 15, 17, 20, 24, 30, 40]);
  for (const sel of ['.lq-queue', '.lq-card', '.lq-card[data-state="unpaid"]']) {
    const r = rule(sel);
    if (r['font-size'] != null) {
      assert.ok(STEPS.has(px(r['font-size'])), sel + ': ' + r['font-size'] + ' — не ступень шкалы');
    }
  }
  // Разделитель монохромен: на этом экране бирюза значит «нажми сюда»,
  // семантические пары — флаг результата, и граница не имеет права занять ни то,
  // ни другое.
  for (const c of [GAP_BG, CARD_EDGE, UNPAID_EDGE]) {
    const [r, g, b] = rgb(c);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    // Серая шкала приложения (--ink-*) чуть холодная: разброс каналов у неё
    // не больше 24 (#aab4bc — 18). У бирюзы действия и у семантических пар он
    // на порядок больше, поэтому порог и различает «нейтраль» и «сигнал».
    assert.ok(spread <= 24, 'цвет границы ' + c + ' окрашен (разброс каналов ' + spread + ') — он заговорил на языке действия или флага');
  }
});
