// LAB_CARD_V3 (2026-09-05) — карточка лабораторной пробы.
//
// Владелец: «make a little redesign of the cards of the laboratory». На его
// снимке экрана лежали пять вещей, и ни одна не чинится оформлением:
//
//   1. САМЫМ ГРОМКИМ НА КАРТОЧКЕ БЫЛ НОМЕР ОБРАЗЦА — чёрная плашка в правом
//      верхнем углу, крупнее фамилии пациента. Номер нужен ровно в один
//      момент — когда сверяешь пробирку; это ключ сверки, а не заголовок.
//      И скопировать его было нечем.
//   2. ДВЕ ЗАЛИТЫЕ БИРЮЗОЙ КНОПКИ В ОДНОМ РЯДУ («Внести результаты» и
//      «Подтвердить») плюс третья, тёмная, на строке анализа. Три равных
//      призыва — это ноль призывов.
//   3. ДАТА РОЖДЕНИЯ ПЕЧАТАЛАСЬ МАШИННО: «1994 M11 15».
//   4. ЧЕТЫРЕ ФАКТА О ЧЕЛОВЕКЕ СТОЯЛИ ОДНИМ ВЕСОМ — четыре одинаковые
//      таблетки, в которых номер карты весит столько же, сколько возраст.
//   5. «Норма» и «Результаты внесены» — два одинаковых чипа бок о бок. Это
//      факты РАЗНОГО РОДА: измерение и ступень работы.
//
// Тесты ниже проверяют результат этих решений, а не «класс проставлен»:
// сколько главных кнопок отрисовалось в каждом состоянии, что именно написано
// на экране в трёх языках, и те правила CSS, от которых зависит, отличит ли
// человек флаг от состояния, не видя цвета.
//
// Поддельный DOM — тот же, что в __tests__/lab-panels-mode.test.mjs (он же из
// telephony-settings.test.mjs): очередь монтируется целиком, вместе с
// выборками visit_services / visits / lab_results.

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
// I18N_LOCALE_PIN_V1 — язык выбирается ОДИН раз при загрузке i18n.js, поэтому
// пин стоит ДО импорта вида: иначе английская локаль сборочной машины сломала
// бы русские утверждения ниже.
fakeLocalStorage.setItem('admin.lang', 'ru');

let confirmPrompts = [];
globalThis.window = {
  location: { hostname: 'localhost' }, localStorage: fakeLocalStorage,
  addEventListener(){}, dispatchEvent(){ return true; },
  easymed: { state: { user: { id: 'u-1', full_name: 'Лаборант' } } },
  CLINIC: { id: 'c-1' },
  confirm: (msg) => { confirmPrompts.push(String(msg)); return false; },
};
globalThis.confirm = (msg) => { confirmPrompts.push(String(msg)); return false; };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.history = { state: null, replaceState(){}, pushState(){} };

// navigator существует в Node 24 и НЕ имеет clipboard — а именно его карточка
// теперь и просит. Подменяем целиком (свойство globalThis только для чтения).
let copied = [];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { clipboard: { writeText: async (v) => { copied.push(String(v)); } } },
});

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Тост: ui.js ищет узел #toast; текст держим ВНЕ `_t` — toast() кладёт туда
// свой таймер, и это ровно то поле, в котором поддельный DOM хранит текст.
let toastMsg = null;
const toastEl = mk('div');
Object.defineProperty(toastEl, 'textContent', {
  configurable: true, get() { return toastMsg; }, set(v) { toastMsg = String(v); },
});
document.getElementById = (id) => (id === 'toast' ? toastEl : null);

// --- поддельный /api/db ------------------------------------------------------
// Очередь читает visit_services ДВАЖДЫ (открытые одним запросом, закрытые —
// вторым, окном). Поэтому фальшивка обязана уважать фильтр по статусу: иначе
// каждая карточка приехала бы дважды и «ровно одна главная кнопка» стало бы
// бессмысленным утверждением.
let VISIT_SERVICES = [];
let VISITS = [];
let LAB_RESULTS = [];
function statusFilter(body) {
  for (const f of (body && body.filters) || []) {
    if (f && f.col === 'status') return f;
  }
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
      lab_panels: [],
      lab_panel_analytes: [],
      services: [],
      departments: [{ id: 'd-1', name: 'Лаборатория', kind: 'laboratory' }],
      service_types: [],
      doc_settings: [],
    }[table] || [];
    if (table === 'visit_services') {
      const f = statusFilter(body);
      if (f && f.op === 'in') rows = rows.filter((r) => f.val.includes(r.status));
      else if (f && f.op === 'eq') rows = rows.filter((r) => r.status === f.val);
    }
    return { ok: true, json: async () => ({ data: JSON.parse(JSON.stringify(rows)) }) };
  }
  if (u.startsWith('/api/rpc/')) return { ok: true, json: async () => ({ data: null }) };
  return { ok: true, json: async () => ({ data: null }) };
};

const { renderLaboratory } = await import('../views/laboratory.js');
const { setLang, monthName, MONTH_KEYS_FORMAT } = await import('../i18n.js');
const { STRINGS } = await import('../i18n-strings.js');
const { labCardState, labPrimaryAction } = await import('../views/lab-grouping.js');
const { setFullAccess } = await import('../permissions.js');
setFullAccess(true);

// --- фикстуры ---------------------------------------------------------------
// Пациентка со снимка владельца: тот же номер карты, тот же год рождения.
const PATIENT = { id: 'p-1', full_name: 'Каримова Азиза Рустамовна', mrn: 'P-26-70126', gender: 'female', date_of_birth: '1994-11-15' };
const SVC = (name, specimen) => ({ name, is_lab: true, type: 'lab', specimen, tube_color: 'lavender', department_id: 'd-1' });

/** Одна строка заказа. id 805 -> номер образца LAB-000805, как на снимке. */
function vs(id, status, extra = {}) {
  return {
    id, visit_id: 'v-1', service_id: 's-' + id, status,
    sample_collected_at: status === 'added' || status === 'queued' ? null : '2026-09-05T08:20:00Z',
    sync_origin: null, services: SVC('Общий анализ крови', 'Кровь'),
    ...extra,
  };
}
function res(id, vsId, flag, value) {
  return { id, visit_service_id: vsId, parameter: 'Гемоглобин', value, unit: 'г/л', flag, notes: null, entered_at: '2026-09-05T09:00:00Z' };
}

/** Монтирует очередь на заданных строках и отдаёт единственную карточку. */
async function card(rows, results = [], { filter = null } = {}) {
  VISIT_SERVICES = rows;
  LAB_RESULTS = results;
  VISITS = [{ id: 'v-1', visit_date: '2026-09-05', patients: PATIENT }];
  confirmPrompts = []; copied = []; toastMsg = null;
  fakeBody.children.length = 0;
  const root = mk('div');
  await renderLaboratory(root, { tabId: 't-1' });
  await tick();
  if (filter) {
    const chip = buttons(root).find((b) => textOf(b).startsWith(filter));
    assert.ok(chip, 'фильтр «' + filter + '» пропал из шапки очереди');
    chip.click();
    await tick();
  }
  const cards = byClass(root, 'lq-card');
  assert.strictEqual(cards.length, 1, 'ожидалась ровно одна карточка в очереди, получено ' + cards.length);
  return cards[0];
}

// ПЯТЬ СОСТОЯНИЙ, в которых лаборант реально застаёт пробу.
const STATE_FIXTURES = {
  // счёт не оплачен — лаборатории делать нечего
  unpaid:   () => card([vs(805, 'added')]),
  // оплачено, ни одного результата
  fresh:    () => card([vs(805, 'queued'), vs(806, 'collected')]),
  // часть внесена
  partial:  () => card([vs(805, 'resulted'), vs(806, 'in_progress')], [res(1, 805, 'normal', '138')]),
  // внесены все, ждут подтверждения
  entered:  () => card([vs(805, 'resulted'), vs(806, 'resulted')], [res(1, 805, 'normal', '138'), res(2, 806, 'high', '9.4')]),
  // проверено и выдано (закрытые видны только под фильтром «Все»)
  released: () => card([vs(805, 'completed'), vs(806, 'completed')],
                       [res(1, 805, 'normal', '138'), res(2, 806, 'normal', '4.2')], { filter: 'Все' }),
};

// --- CSS --------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const BLOCKS = (() => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS))) {
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
})();
/** Объявления правила по селектору (все блоки с этим селектором, слитые). */
function rule(sel) {
  const norm = sel.trim().replace(/\s+/g, ' ');
  const hits = BLOCKS.filter((b) => b.sels.includes(norm));
  assert.ok(hits.length, 'правило «' + sel + '» пропало из admin-views.css');
  return Object.assign({}, ...hits.map((b) => b.decls));
}

// ═══ 1. ИЕРАРХИЯ: ЧЬЯ ПРОБА → ЧТО В НЕЙ → В КАКОМ СОСТОЯНИИ → ЧТО ДЕЛАТЬ ════

test('порядок блоков карточки и есть ответ на «что читать первым»', async () => {
  const c = await STATE_FIXTURES.entered();
  const order = c.children.map((n) => String(n.className).split(/\s+/)[0]);
  assert.deepStrictEqual(order, ['lq-head', 'lq-status', 'lq-list'],
    'порядок блоков карточки изменился — а он и есть порядок вопросов лаборанта');
});

test('громче всего — имя пациента; номер образца тише его и больше не чёрная плашка', async () => {
  const c = await STATE_FIXTURES.entered();
  const size = (sel) => parseFloat(rule(sel)['font-size']);
  assert.ok(size('.lq-title') > size('.lq-acc .v'),
    'номер образца снова не тише имени — а он ключ сверки, не заголовок');
  assert.ok(size('.lq-title') > size('.lq-fact'), 'имя сравнялось по весу с фактами о человеке');
  // Именно заливка и делала прежнюю плашку самым громким на карточке.
  const acc = rule('.lq-acc');
  assert.ok(!/ink-900|#000|black/.test(String(acc.background || '')),
    'номер образца снова залит чёрным: ' + acc.background);
  assert.ok(/ink-/.test(String(rule('.lq-acc .v').color || '')),
    'номер образца снова печатается небуквенным цветом');
  // Имя на карточке ровно одно и это имя, а не номер.
  const title = byClass(c, 'lq-title');
  assert.strictEqual(title.length, 1);
  assert.strictEqual(textOf(title[0]), PATIENT.full_name);
});

test('факты о человеке больше не равновелики: пол и возраст весомее даты и счётчика', async () => {
  const c = await STATE_FIXTURES.entered();
  const facts = byClass(c, 'lq-fact');
  assert.ok(facts.length >= 3, 'строка фактов о пациенте пропала');
  const t = textOf(byClass(c, 'lq-facts')[0]);
  assert.ok(t.includes('Ж'), 'пол пропал со строки фактов');
  assert.ok(/\d+\s+(год|года|лет)/.test(t), 'возраст пропал или снова склеен одним куском: ' + t);
  const strong = parseFloat(rule('.lq-fact')['font-weight']);
  const soft = parseFloat(rule('.lq-fact-soft')['font-weight']);
  assert.ok(strong > soft, 'у второстепенных фактов вернулся тот же вес, что у главных');
  // Номер карты — ключ поиска, а не факт о человеке: он ушёл в отдельный ряд.
  const mrn = byClass(c, 'lq-mrn');
  assert.strictEqual(mrn.length, 1);
  assert.ok(textOf(mrn[0]).includes(PATIENT.mrn));
  assert.strictEqual(rule('.lq-mrn')['user-select'], 'text', 'номер карты перестал выделяться мышью');
});

// ═══ 2. НОМЕР ПРОБЫ — ТИХИЙ, НО КОПИРУЕМЫЙ ══════════════════════════════════

test('номер пробы на месте, и он копируется одним нажатием', async () => {
  const c = await STATE_FIXTURES.entered();
  const accs = byClass(c, 'lq-acc');
  assert.strictEqual(accs.length, 1, 'номер пробы с карточки пропал');
  const acc = accs[0];
  assert.strictEqual(acc.tagName, 'BUTTON', 'номер пробы снова просто текст — его нечем скопировать');
  assert.strictEqual(acc.getAttribute('aria-label'), 'Скопировать номер пробы',
    'у кнопки номера нет имени: экранный диктор прочитает набор цифр и ничего больше');
  assert.ok(textOf(acc).includes('LAB-000805'), 'номер образца не отрисован: ' + textOf(acc));
  copied = [];
  acc.click();
  await tick();
  assert.deepStrictEqual(copied, ['LAB-000805'], 'нажатие на номер ничего не скопировало');
  assert.strictEqual(toastMsg, 'Номер пробы скопирован', 'копирование прошло молча — непонятно, сработало ли');
});

// ═══ 3. ОДНО ГЛАВНОЕ ДЕЙСТВИЕ НА СОСТОЯНИЕ ══════════════════════════════════

// Ровно этот счётчик и запрещает будущей правке вернуть вторую залитую кнопку.
const PRIMARY_PER_STATE = { unpaid: 0, fresh: 1, partial: 1, entered: 1, released: 1 };

for (const [name, expected] of Object.entries(PRIMARY_PER_STATE)) {
  test(`состояние «${name}»: главных кнопок на карточке ровно ${expected}`, async () => {
    const c = await STATE_FIXTURES[name]();
    assert.strictEqual(c.getAttribute('data-state'), name,
      'карточка считает себя в другом состоянии');
    const primaries = byClass(c, 'btn-primary');
    assert.strictEqual(primaries.length, expected,
      `главных кнопок ${primaries.length}, а должно быть ${expected}: ` +
      primaries.map((b) => textOf(b).replace(/<[^>]*>/g, '').trim()).join(' | '));
  });
}

test('главная кнопка каждого состояния — та, что и есть следующий шаг, и стоит первой', async () => {
  const want = { fresh: 'Внести результаты', partial: 'Внести результаты', entered: 'Подтвердить', released: 'Бланк' };
  for (const [name, label] of Object.entries(want)) {
    const c = await STATE_FIXTURES[name]();
    const row = byClass(c, 'lq-do')[0];
    assert.ok(row, name + ': ряд действий пропал');
    const btns = buttons(row);
    const clean = (b) => textOf(b).replace(/<[^>]*>/g, '').trim();
    assert.strictEqual(clean(btns[0]), label,
      name + ': первой в ряду стоит «' + clean(btns[0]) + '», а следующий шаг — «' + label + '»');
    assert.ok(hasClass(btns[0], 'btn-primary'), name + ': первая кнопка ряда не главная');
    for (const b of btns.slice(1)) {
      assert.ok(!hasClass(b, 'btn-primary'), name + ': вторая залитая кнопка — «' + clean(b) + '»');
    }
  }
});

test('на строке анализа главных кнопок нет вовсе — иначе их было бы по одной на каждый анализ', async () => {
  const c = await card(
    [vs(805, 'queued'), vs(806, 'collected'), vs(807, 'in_progress'), vs(808, 'resulted'), vs(809, 'resulted')],
    [res(1, 808, 'high', '9.4'), res(2, 809, 'normal', '4.2')]);
  const items = byClass(c, 'lq-item');
  assert.strictEqual(items.length, 5, 'пять анализов — пять строк');
  for (const it of items) {
    assert.strictEqual(byClass(it, 'btn-primary').length, 0,
      'на строке анализа снова залитая кнопка — пять анализов дадут пять равных призывов');
  }
  // И на всей карточке при пяти анализах главная по-прежнему одна.
  assert.strictEqual(byClass(c, 'btn-primary').length, 1);
});

test('решение о главном действии — чистая функция, а не разметка', () => {
  const R = (status, hasRes) => ({ status, _r: hasRes });
  const has = (r) => !!r._r;
  assert.strictEqual(labCardState([R('added', false)], has), 'unpaid');
  assert.strictEqual(labCardState([R('queued', false), R('collected', false)], has), 'fresh');
  assert.strictEqual(labCardState([R('resulted', true), R('in_progress', false)], has), 'partial');
  assert.strictEqual(labCardState([R('resulted', true), R('resulted', true)], has), 'entered');
  assert.strictEqual(labCardState([R('completed', true), R('completed', true)], has), 'released');
  assert.strictEqual(labCardState([], has), 'unpaid', 'пустая группа не имеет права предлагать работу');

  assert.strictEqual(labPrimaryAction('unpaid', {}), null, 'до кассы у лаборатории главного действия нет');
  assert.strictEqual(labPrimaryAction('fresh', {}), 'worksheet');
  assert.strictEqual(labPrimaryAction('partial', {}), 'worksheet');
  assert.strictEqual(labPrimaryAction('entered', { anyToVerify: true }), 'verify');
  assert.strictEqual(labPrimaryAction('entered', { anyToVerify: false }), 'report',
    'кнопка «Подтвердить», которой нечего подтверждать, — худший ответ на «что делать дальше»');
  assert.strictEqual(labPrimaryAction('released', {}), 'report');
});

test('у каждого состояния своё слово — и оно переводится', async () => {
  const want = {
    unpaid: 'Ожидает оплату', fresh: 'Результаты не внесены', partial: 'Внесены частично',
    entered: 'Все результаты внесены', released: 'Проверено и выдано',
  };
  for (const [name, label] of Object.entries(want)) {
    const c = await STATE_FIXTURES[name]();
    const chip = byClass(c, 'lq-state-card')[0];
    assert.ok(chip, name + ': подпись состояния карточки пропала');
    assert.ok(textOf(chip).includes(label), name + ': написано «' + textOf(chip) + '», ожидалось «' + label + '»');
    const entry = STRINGS[label];
    assert.ok(entry && entry.uz && entry.en, name + ': «' + label + '» нет в словаре в трёх языках');
  }
});

// ═══ 4. ФЛАГ РЕЗУЛЬТАТА ≠ РАБОЧЕЕ СОСТОЯНИЕ ═════════════════════════════════

test('флаг и состояние — разной ФОРМЫ, а не разного цвета: они различимы в ч/б', async () => {
  const c = await STATE_FIXTURES.entered();
  const flags = byClass(c, 'lq-flag');
  const states = byClass(c, 'lq-state');
  assert.ok(flags.length >= 1, 'флаг результата пропал со строки анализа');
  assert.ok(states.length >= 2, 'рабочее состояние пропало (карточка + строки)');
  // Ни один узел не является одновременно и тем и другим — раньше это были
  // два одинаковых чипа, и разница между ними жила только в цвете.
  for (const n of flags) assert.ok(!hasClass(n, 'lq-state'), 'флаг и состояние снова один и тот же объект');

  const flagCss = rule('.lq-flag');
  const stateCss = rule('.lq-state');
  assert.strictEqual(flagCss['border-radius'], '999px', 'флаг перестал быть таблеткой');
  assert.notStrictEqual(stateCss['border-radius'], '999px',
    'состояние снова таблетка — той же формы, что флаг, и отличать их будет нечем, кроме цвета');
  assert.strictEqual(stateCss['text-transform'], 'uppercase', 'состояние потеряло свой регистр');
  assert.ok(!stateCss['text-transform'] || stateCss['text-transform'] !== flagCss['text-transform'],
    'флаг и состояние набраны одинаково');
  // Состояние не имеет права зависеть от оттенка вообще.
  for (const k of ['color', 'background', 'border']) {
    const v = String(stateCss[k] || '');
    assert.ok(!/(--ok-|--warn-|--crit-|--info-|--purple-|--primary-)/.test(v),
      'состояние снова красится семантическим цветом (' + k + ': ' + v + ') — а цвет здесь занят флагом');
  }
});

test('состояние читается по числу закрашенных делений — без единой буквы и без цвета', async () => {
  const c = await card([vs(805, 'queued'), vs(806, 'resulted')], [res(1, 806, 'normal', '138')]);
  const items = byClass(c, 'lq-item');
  const stageOf = (item) => {
    const st = byClass(item, 'lq-state')[0];
    const track = byClass(st, 'lq-steps')[0];
    assert.ok(track, 'дорожка ступеней пропала');
    assert.strictEqual(track.children.length, 5, 'ступеней конвейера должно быть пять');
    return track.children.filter((i) => hasClass(i, 'on')).length;
  };
  assert.strictEqual(stageOf(items[0]), 1, '«оплачен · к забору» — одно деление');
  assert.strictEqual(stageOf(items[1]), 4, '«результаты внесены» — четыре деления');
  // Карточка встаёт по САМОЙ отстающей пробирке.
  const cardTrack = byClass(byClass(c, 'lq-state-card')[0], 'lq-steps')[0];
  assert.strictEqual(cardTrack.children.filter((i) => hasClass(i, 'on')).length, 1,
    'карточка обогнала свою худшую строку — а она готова ровно настолько, насколько готова та');
});

test('флаг несёт значок направления: «выше» и «ниже» отличаются и на чёрно-белой печати', async () => {
  const high = await card([vs(805, 'resulted')], [res(1, 805, 'high', '9.4')]);
  const low = await card([vs(805, 'resulted')], [res(1, 805, 'low', '2.1')]);
  const glyph = (c) => {
    const f = byClass(c, 'lq-flag')[0];
    assert.ok(f, 'флаг результата пропал');
    const svg = walk(f).find((n) => n.tagName === 'SVG');
    assert.ok(svg && svg._t, 'у флага нет значка — без цвета его не прочитать');
    return svg._t;
  };
  assert.notStrictEqual(glyph(high), glyph(low),
    '«выше» и «ниже» рисуются одним значком — в ч/б они станут неотличимы');
  assert.ok(textOf(byClass(high, 'lq-flag')[0]).includes('Выше'));
  assert.ok(textOf(byClass(low, 'lq-flag')[0]).includes('Ниже'));
});

// ═══ 5. ДАТА РОЖДЕНИЯ ═══════════════════════════════════════════════════════

test('дата рождения — словом, а не «1994 M11 15», и так во всех трёх языках', async () => {
  const want = { ru: /ноября/, uz: /noyabr/, en: /November/ };
  try {
    for (const [lang, re] of Object.entries(want)) {
      setLang(lang);
      const c = await STATE_FIXTURES.entered();
      const t = textOf(byClass(c, 'lq-facts')[0]);
      assert.ok(re.test(t), lang + ': месяц не написан словом — ' + t);
      assert.ok(t.includes('1994'), lang + ': год рождения пропал — ' + t);
      assert.ok(!/\d{4}\s+M\d{1,2}\s+\d{1,2}/.test(t),
        lang + ': дата снова печатается машинной формой — ' + t);
    }
  } finally { setLang('ru'); }
});

// MONTH_WORDS_V1 — запасная сборка даты (isMachineDate / ymd / RU_MONTH_GEN)
// из lab-grouping.js убрана: месяцы берёт общий форматтер, и Intl он не
// спрашивает вовсе. Здесь остаётся то, на чём эта карточка держится, —
// узбекские месяцы в словаре; полный разбор формата в uzbek-dates.test.mjs.
test('узбекские месяцы лежат в словаре, а не в этом экране', () => {
  assert.strictEqual(MONTH_KEYS_FORMAT.length, 12);
  for (const m of MONTH_KEYS_FORMAT) {
    const e = STRINGS[m];
    assert.ok(e && e.uz && e.en, 'месяца «' + m + '» нет в словаре в трёх языках');
    assert.notStrictEqual(e.uz, e.ru, 'узбекский месяц «' + m + '» — побайтовая копия русского');
  }
  // «2 may 2019» — тот вид, о котором просил владелец.
  assert.strictEqual(monthName(4, { lang: 'uz' }), 'may');
  assert.strictEqual(monthName(10, { lang: 'uz' }), 'noyabr');
});

// ═══ 6. ЧУЖОЙ ФИЛИАЛ ════════════════════════════════════════════════════════

test('пациент соседнего здания подписан «Филиал X» — иначе лаборант ищет человека, которого у него не было', async () => {
  const c = await card([vs(805, 'resulted', { sync_origin: 'Б' })], [res(1, 805, 'normal', '138')]);
  const tags = byClass(c, 'lq-branch');
  assert.strictEqual(tags.length, 1, 'метка филиала пропала с карточки');
  assert.ok(textOf(tags[0]).includes('Филиал Б'), 'на метке написано «' + textOf(tags[0]) + '»');
  // Своя работа не подписывается — иначе метка перестаёт что-либо значить.
  const own = await card([vs(805, 'resulted')], [res(1, 805, 'normal', '138')]);
  assert.strictEqual(byClass(own, 'lq-branch').length, 0, 'своя работа снова подписана филиалом');
});

test('критические значения видны на карточке до раскрытия строк', async () => {
  const c = await card([vs(805, 'resulted')], [res(1, 805, 'critical', '31')]);
  const crit = byClass(c, 'lq-crit');
  assert.strictEqual(crit.length, 1, 'счётчик критических значений пропал из шапки');
  assert.ok(textOf(crit[0]).includes('1'), 'счётчик критических значений не назвал число');
  const e = STRINGS['{n} критич.'];
  assert.ok(e && e.uz && e.en && e.uz.includes('{n}') && e.en.includes('{n}'),
    'подпись критических значений без дырки {n} в одном из языков — счётчик молча пропадёт');
});

// ═══ 7. НИ ОДНО ДЕЙСТВИЕ НЕ ПОТЕРЯНО ════════════════════════════════════════

const clean = (b) => textOf(b).replace(/<[^>]*>/g, '').trim();

test('все действия карточки на месте в каждом состоянии — изменился только их вес', async () => {
  const want = {
    unpaid: [],
    fresh: ['Внести результаты', 'Штрих-код'],
    partial: ['Внести результаты', 'Подтвердить', 'Бланк', 'Штрих-код'],
    entered: ['Подтвердить', 'Внести результаты', 'Бланк', 'Штрих-код'],
    released: ['Бланк', 'Внести результаты', 'Штрих-код'],
  };
  for (const [name, labels] of Object.entries(want)) {
    const c = await STATE_FIXTURES[name]();
    const btns = buttons(byClass(c, 'lq-do')[0]);
    assert.deepStrictEqual(btns.map(clean).sort(), labels.slice().sort(),
      name + ': состав действий изменился — ' + btns.map(clean).join(' | '));
    for (const b of btns) {
      assert.ok((b._l.click || []).length === 1, name + ': кнопка «' + clean(b) + '» ни к чему не подключена');
      assert.ok(b.getAttribute('title'), name + ': у кнопки «' + clean(b) + '» пропала подсказка');
    }
  }
});

test('все действия строки анализа на месте — по одному на каждый статус', async () => {
  const want = {
    queued:      ['Забор пробы'],
    collected:   ['В работу'],
    in_progress: ['Результаты…'],
    resulted:    ['Проверить и выдать'],
    completed:   ['Отчёт'],
  };
  for (const [status, labels] of Object.entries(want)) {
    const results = status === 'resulted' || status === 'completed' ? [res(1, 805, 'normal', '138')] : [];
    const c = await card([vs(805, status)], results, { filter: status === 'completed' ? 'Все' : null });
    const row = byClass(c, 'lq-item-do')[0];
    assert.ok(row, status + ': ряд действий строки пропал');
    const btns = buttons(row);
    for (const label of labels) {
      assert.ok(btns.some((b) => clean(b) === label), status + ': кнопка «' + label + '» пропала со строки');
    }
    for (const b of btns) assert.ok((b._l.click || []).length === 1, status + ': кнопка ни к чему не подключена');
    // Перепечать этикетки живёт на строке с момента, когда проба существует.
    const label = btns.find((b) => b.getAttribute('title') === 'Печать этикетки');
    if (status === 'queued') assert.ok(!label, 'этикетка предлагается до того, как проба взята');
    else assert.ok(label, status + ': перепечать этикетки пропала');
    // Правка уже внесённых результатов — там же, где была.
    if (status === 'resulted') {
      assert.ok(btns.some((b) => b.getAttribute('title') === 'Изменить результаты'),
        'правка внесённых результатов пропала со строки');
    }
  }
});

test('главная кнопка действительно делает то, что обещает', async () => {
  // «Внести результаты» открывает общий бланк ввода (модальное окно в body).
  const fresh = await STATE_FIXTURES.fresh();
  fakeBody.children.length = 0;
  buttons(byClass(fresh, 'lq-do')[0])[0].click();
  await tick(60);
  assert.ok(byClass(fakeBody, 'lw-patient').length === 1,
    '«Внести результаты» не открыла бланк ввода — действие отвалилось от кнопки');

  // «Подтвердить» доходит до подтверждения выдачи (и спрашивает про пациента).
  const entered = await STATE_FIXTURES.entered();
  confirmPrompts = [];
  buttons(byClass(entered, 'lq-do')[0])[0].click();
  await tick(60);
  assert.strictEqual(confirmPrompts.length, 1, '«Подтвердить» не дошла до подтверждения выдачи');
  assert.ok(confirmPrompts[0].includes(PATIENT.full_name),
    'подтверждение не называет пациента: ' + confirmPrompts[0]);
});

// ═══ 8. ШКАЛА ═══════════════════════════════════════════════════════════════

test('все размеры карточки — со шкалы восьми ступеней (пол 12.5px)', () => {
  const STEPS = new Set([12.5, 13.5, 15, 17, 20, 24, 30, 40]);
  for (const sel of ['.lq-title', '.lq-fact', '.lq-mrn', '.lq-acc .k', '.lq-acc .v',
                     '.lq-state', '.lq-flag', '.lq-prog-txt', '.lq-name', '.lq-type', '.lq-val']) {
    const v = parseFloat(rule(sel)['font-size']);
    assert.ok(STEPS.has(v), sel + ': ' + v + 'px — не ступень шкалы');
  }
});
