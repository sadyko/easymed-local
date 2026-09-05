// CRM_CARD_V2 (2026-09-05) — карточка заявки на канбане.
//
// Владелец попросил «сделать карточку CRM приятнее», и на его снимке экрана
// лежали четыре вещи, которые чинятся не оформлением:
//
//   1. НОМЕР ПЕРЕНОСИЛСЯ ПОСРЕДИ ЦИФР: «998945669» на одной строке, «203» на
//      следующей. Номер — единственное на этой карточке, что диктуют вслух и
//      набирают; разорванный, он не читается и легко путается. Значит: не
//      переносится никогда и печатается ГРУППАМИ, как его произносят
//      (+998 94 566 92 03).
//   2. НОМЕР ПЕЧАТАЛСЯ ДВАЖДЫ — заголовком и строкой под ним. Это не опечатка
//      разметки: лид, заведённый АТС от неизвестного звонящего, кладёт номер в
//      full_name (server/services/crm/lead-from-call.js), потому что имени
//      взять неоткуда. Значит: одно значение — одно место.
//   3. ВНУТРИ КАРТОЧКИ СТОЯЛ ГОЛЫЙ <select> со ступенями воронки, и выбранной в
//      нём была та ступень, в колонке которой карточка и лежит. Самый тяжёлый
//      элемент карточки повторял то, что уже сказано её положением.
//   4. ДАТА ВИСЕЛА рядом с (перенесённым) номером без всякой связи с ним.
//
// Тесты ниже проверяют именно это, а не «класс проставлен»: текст, который
// действительно отрисовался, и правила CSS, от которых зависит, разорвётся
// строка или нет.
//
// Поддельный DOM — тот же, что в crm-board-config.test.mjs (он же из
// telephony-settings.test.mjs): доска монтируется целиком, вместе с
// crm_config_get и выборкой заявок.

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
 querySelector(sel){
   const m = /^\[([^\]=]+)\]$/.exec(String(sel));
   if (!m) return null;
   const want = m[1];
   const stack = [...this.children];
   while (stack.length) {
     const n = stack.shift();
     if (n && n.attrs && want in n.attrs) return n;
     if (n && n.children) stack.push(...n.children);
   }
   return null;
 }
 querySelectorAll(){return [];}
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

const store = new Map();
const fakeLocalStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — язык выбирается ОДИН раз при загрузке i18n.js, поэтому
// пин стоит ДО импорта вида: иначе английская локаль сборочной машины ломала бы
// русские утверждения ниже.
fakeLocalStorage.setItem('admin.lang', 'ru');
globalThis.window = { location: { hostname: 'localhost' }, localStorage: fakeLocalStorage, addEventListener(){}, easymed: { state: { user: null } } };
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=(fn)=>fn();

const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const cardsOf = (root) => byClass(root, 'crm-card');

const jsonOk = (data) => ({ ok: true, json: async () => ({ data }) });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- поддельный сервер -----------------------------------------------------
// Воронка — ЗАПАСНАЯ (та, что в crm-settings-logic.js): пустой ответ
// crm_config_get оставляет доску с восемью колонками миграции 046.
let LEADS = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/')) return jsonOk({});
  if (u.startsWith('/api/db')) {
    if (body && body.table === 'crm_requests' && body.op === 'select') return jsonOk(LEADS);
    return jsonOk([]);
  }
  return jsonOk([]);
};

const { renderCrm } = await import('../views/crm.js');

async function board(leads) {
  LEADS = leads;
  const root = mk('div');
  await renderCrm(root, { onNavigate() {} });
  await tick();
  return root;
}
/** Доска с ОДНОЙ заявкой — и сама эта карточка. */
async function oneCard(lead) {
  const root = await board([{ id: 1, status: 'in_process', source: 'call', created_at: '2026-09-03T10:12:00Z', ...lead }]);
  const cards = cardsOf(root);
  assert.strictEqual(cards.length, 1, 'ожидалась ровно одна карточка на доске');
  return cards[0];
}

// Настоящий узбекский номер — тот самый вид, что на снимке владельца.
const UZ_RAW = '998945669203';
const UZ_READ = '+998 94 566 92 03';

// --- CSS -------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'css', 'admin-views.css'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
/** Объявления правила по селектору (все блоки с этим селектором, слитые). */
function rule(selector) {
  const out = {};
  let at = 0, found = 0;
  for (;;) {
    const i = CSS.indexOf(selector + ' {', at);
    if (i === -1) break;
    at = i + selector.length;
    const before = CSS[i - 1];
    if (before && !'\n};'.includes(before)) continue;
    found++;
    for (const part of CSS.slice(i + selector.length + 2, CSS.indexOf('}', i)).split(';')) {
      const j = part.indexOf(':');
      if (j === -1) continue;
      out[part.slice(0, j).trim()] = part.slice(j + 1).trim();
    }
  }
  assert.ok(found > 0, `правило «${selector}» пропало из admin-views.css`);
  return out;
}

// ═══ 1. НОМЕР ═══════════════════════════════════════════════════════════════

test('номер печатается группами, как его произносят, — и это то, что видно на карточке', async () => {
  const card = await oneCard({ full_name: 'Каримова Азиза', phone: UZ_RAW });
  const tel = byClass(card, 'crm-card-tel-n');
  assert.strictEqual(tel.length, 1, 'строка телефона на карточке ровно одна');
  assert.strictEqual(textOf(tel[0]), UZ_READ,
    `номер отрисован как «${textOf(tel[0])}», а произносится «${UZ_READ}»`);
  // И сырой слитной строки цифр на карточке не осталось — иначе где-то остался
  // второй способ печатать номер.
  assert.ok(!textOf(card).includes(UZ_RAW), 'на карточке всё ещё есть неформатированный номер');
});

test('номер не переносится ни при какой ширине колонки — это правило CSS, а не удача вёрстки', () => {
  const tel = rule('.crm-card-tel-n');
  assert.strictEqual(tel['white-space'], 'nowrap',
    'у номера пропал white-space: nowrap — именно так «…9669» и «203» и разъехались на две строки');
  assert.notStrictEqual(tel['overflow-wrap'], 'anywhere', 'номеру разрешили рваться в любом месте');
  // Не влезло — многоточие, а не перенос: обрезанный номер ВИДНО, что он
  // обрезан, а перенесённый читается как целый и неверный.
  assert.strictEqual(tel.overflow, 'hidden');
  assert.strictEqual(tel['text-overflow'], 'ellipsis');
  // Тот же договор для номера, ставшего заголовком.
  const asTitle = rule('.crm-card-name-tel');
  assert.strictEqual(asTitle['white-space'], 'nowrap', 'номер-заголовок снова умеет переноситься');
  assert.strictEqual(asTitle['overflow-wrap'], 'normal',
    'номер-заголовок унаследовал overflow-wrap: anywhere от .crm-card-name');
  // Номер копируют мышью, а у карточки user-select: none ради перетаскивания.
  for (const r of [tel, asTitle]) {
    assert.strictEqual(r['user-select'], 'text', 'номер перестал выделяться мышью — его не скопировать');
  }
});

test('в списке номер записан так же, как на карточке: одно поле — одна запись', async () => {
  const root = await board([{ id: 1, status: 'in_process', source: 'call', full_name: 'Каримова Азиза', phone: UZ_RAW, created_at: '2026-09-03T10:12:00Z' }]);
  // Переключаемся на «Список» той же кнопкой, что и владелец.
  const btn = walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Список'));
  assert.ok(btn, 'кнопка «Список» пропала с экрана');
  btn.click();
  await tick();
  assert.ok(textOf(root).includes(UZ_READ), 'в списке номер снова печатается слитно');
  // и возвращаемся на канбан — state.view живёт в модуле между тестами
  const back = walk(root).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Канбан'));
  back.click();
  await tick();
});

// ═══ 2. ОДНО ЗНАЧЕНИЕ — ОДНО МЕСТО ══════════════════════════════════════════

test('лид от АТС: номер вместо имени печатается ОДИН раз и выглядит решением, а не поломкой', async () => {
  // Ровно то, что кладёт в базу services/crm/lead-from-call.js для неизвестного
  // звонящего: full_name === phone.
  const card = await oneCard({ full_name: '+' + UZ_RAW, phone: '+' + UZ_RAW, source: 'telephony' });
  const t = textOf(card);
  const times = t.split(UZ_READ).length - 1;
  assert.strictEqual(times, 1, `номер напечатан ${times} раза(-а) на одной карточке`);
  // Строки телефона нет вовсе: телефон И ЕСТЬ заголовок.
  assert.strictEqual(byClass(card, 'crm-card-tel').length, 0,
    'под номером-заголовком снова стоит строка телефона — то самое удвоение');
  const title = byClass(card, 'crm-card-name');
  assert.strictEqual(textOf(title[0]), UZ_READ, 'заголовком стоит не читаемый номер');
  assert.ok(hasClass(title[0], 'crm-card-name-tel'), 'номер-заголовок не помечен как номер');
  // Подпись «Без имени» — то, что делает карточку намеренной, а не обрезанной.
  assert.strictEqual(byClass(card, 'crm-card-kicker').length, 1);
  assert.ok(t.includes('Без имени'), 'ничего не объясняет, почему вместо имени номер');
});

test('ни одно значение на карточке не встречается дважды', async () => {
  const card = await oneCard({
    full_name: 'Каримова Азиза Рустамовна', phone: UZ_RAW, source: 'call',
    note: 'Просила перезвонить после обеда',
    scheduled_date: '2026-09-10',
    services: { id: 4, name: 'УЗИ брюшной полости', price: 120000 },
    patients: { id: 7, full_name: 'Каримова Азиза Рустамовна', mrn: 'A-000123' },
    users: { full_name: 'Оператор Лола' },
  });
  const seen = new Map();
  for (const n of walk(card)) {
    const t = String(n._t || '').trim();
    if (t.length < 4 || t.includes('<')) continue;   // '<' — это контуры иконки, а не значение
    seen.set(t, (seen.get(t) || 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
  assert.deepStrictEqual(dupes, [], 'значение напечатано дважды: ' + dupes.join(' | '));
});

test('имя-номер, НЕ совпавший с телефоном заявки, печатается целиком: два номера — два факта', async () => {
  const card = await oneCard({ full_name: '998901112233', phone: UZ_RAW });
  const t = textOf(card);
  assert.ok(t.includes('+998 90 111 22 33'), 'первый номер потерян');
  assert.ok(t.includes(UZ_READ), 'второй номер потерян');
});

// ═══ 3. КРАЙНИЕ СЛУЧАИ ══════════════════════════════════════════════════════

test('без имени, без телефона, без имени И телефона — карточка каждый раз выглядит намеренной', async () => {
  const noName = await oneCard({ full_name: '', phone: UZ_RAW });
  assert.strictEqual(textOf(byClass(noName, 'crm-card-name')[0]), UZ_READ, 'без имени заголовком должен стать номер');
  assert.ok(textOf(noName).includes('Без имени'));

  const noPhone = await oneCard({ full_name: 'Каримова Азиза', phone: '' });
  const tel = byClass(noPhone, 'crm-card-tel');
  assert.strictEqual(tel.length, 1, 'отсутствие телефона обязано быть ВИДНО: это «дозвониться нельзя»');
  assert.ok(hasClass(tel[0], 'crm-card-tel-none'));
  assert.ok(textOf(noPhone).includes('Телефон не указан'));

  const neither = await oneCard({ full_name: '', phone: '' });
  const t = textOf(neither);
  assert.ok(t.includes('Без имени') && t.includes('Телефон не указан'),
    'пустая заявка обязана сказать, чего именно в ней нет');
  assert.strictEqual(byClass(neither, 'crm-card-name-none').length, 1);
});

test('шестидесятизначное имя печатается целиком и переносится, а не выносит колонку', async () => {
  const LONG = 'Абдурахмонов Шухратбек Улугбек угли Ташкентский-Юнусабадский';
  assert.strictEqual(LONG.length, 60, 'фикстура должна быть ровно из 60 знаков');
  const card = await oneCard({ full_name: LONG, phone: UZ_RAW });
  assert.ok(textOf(card).includes(LONG), 'длинное имя обрезали — на доске его уже не прочитать');
  assert.strictEqual(rule('.crm-card-name')['overflow-wrap'], 'anywhere',
    'длинному имени запретили переноситься — оно вылезет за колонку');
});

test('четыре метки на одной заявке: все на месте, все переносятся, ни одна не рвёт колонку', async () => {
  const card = await oneCard({
    full_name: 'Каримова Азиза', phone: UZ_RAW,
    source: 'referral', scheduled_date: '2026-09-10',
    patients: { id: 7, mrn: 'A-000123' },
    users: { full_name: 'Оператор Лола' },
  });
  const tags = byClass(card, 'crm-card-tags');
  assert.strictEqual(tags.length, 1);
  const chips = walk(tags[0]).filter((n) => hasClass(n, 'tag'));
  assert.strictEqual(chips.length, 4, 'ожидались четыре метки-факта: источник, карта, кто ведёт, запись');
  const t = chips.map(textOf);
  assert.ok(t.some((x) => x.includes('Рекомендация')), 'метка источника');
  assert.ok(t.some((x) => x.includes('A-000123')), 'метка «карта заведена» с номером карты');
  assert.ok(t.some((x) => x.includes('Оператор Лола')), 'метка «кто ведёт»');
  assert.ok(t.some((x) => x.includes('10.09.2026')), 'метка «на какой день записан»');

  const row = rule('.crm-card-tags');
  assert.strictEqual(row['flex-wrap'], 'wrap', 'ряд меток перестал переноситься — четвёртая уедет за край');
  // Длинная подпись источника: обычная .tag это nowrap + ровно 22px, и такая
  // метка вылезла бы за колонку. Обрезать факт нечем — он и есть сообщение.
  const chip = rule('.crm-card-tags .tag');
  assert.strictEqual(chip['white-space'], 'normal', 'длинная подпись источника снова не умеет переноситься');
  assert.strictEqual(chip['max-width'], '100%');
  assert.strictEqual(chip.height, 'auto', 'у метки снова фиксированная высота — перенесённый текст вылезет из таблетки');
});

test('очень длинная подпись источника доезжает до карточки целиком', async () => {
  const card = await oneCard({ full_name: 'Каримова Азиза', phone: UZ_RAW, source: 'partner_clinic_long' });
  // Ключа нет в справочнике источников — на карточку выходит сам ключ, и он
  // тоже не имеет права вынести колонку (правила проверены выше).
  assert.ok(textOf(card).includes('partner_clinic_long'));
});

// ═══ 4. ПЕРЕЕЗД МЕЖДУ СТУПЕНЯМИ ═════════════════════════════════════════════

test('ступень меняется с клавиатуры: это родной select с именем, а не кнопка-картинка', async () => {
  const card = await oneCard({ full_name: 'Каримова Азиза', phone: UZ_RAW, status: 'in_process' });
  const sels = walk(card).filter((n) => n.tagName === 'SELECT');
  assert.strictEqual(sels.length, 1, 'на карточке должен быть ровно один переключатель ступени');
  const sel = sels[0];
  // Родной select фокусируется и управляется стрелками сам; отнять это можно
  // ровно двумя способами — и оба здесь запрещены.
  assert.ok(!sel.hasAttribute('disabled'), 'переключатель выключен — с клавиатуры до него не добраться');
  assert.notStrictEqual(sel.getAttribute('tabindex'), '-1', 'переключатель вынут из порядка обхода');
  assert.strictEqual(sel.getAttribute('aria-label'), 'Переместить заявку в другую колонку',
    'у переключателя нет имени: экранный диктор прочитает «список» и ничего больше');
  // И его видно, когда он в фокусе.
  assert.match(String(rule('.crm-move-sel:focus-visible').outline || ''), /^2px solid/,
    'фокус на переключателе не виден — клавиатурой по доске не пройти');
});

test('переключатель — список НАПРАВЛЕНИЙ, а не повтор колонки, в которой карточка лежит', async () => {
  const card = await oneCard({ full_name: 'Каримова Азиза', phone: UZ_RAW, status: 'in_process' });
  const sel = walk(card).find((n) => n.tagName === 'SELECT');
  const opts = sel.children.filter((n) => n.tagName === 'OPTION');
  assert.strictEqual(textOf(opts[0]), 'Переместить…', 'видимая подпись должна называть ДЕЙСТВИЕ');
  assert.strictEqual(opts[0].value, '', 'подпись действия не имеет права быть ступенью');
  const values = opts.slice(1).map((o) => o.value);
  assert.ok(!values.includes('in_process'), 'своя ступень снова в списке — карточка повторяет свою колонку');
  assert.ok(!values.includes('came'),
    'конверсия открывает попап регистрации пациента — попасть туда молчаливой сменой значения нельзя');
  assert.ok(values.includes('recall') && values.includes('no_show'), 'остальные ступени пропали из списка');
  // Своей ступени нет и в тексте карточки — ни одной подписи «В обработке».
  assert.ok(!textOf(card).includes('В обработке'), 'название своей колонки снова напечатано внутри карточки');
});

test('в покое переключатель не выглядит формой, а под курсором и в фокусе — выглядит', () => {
  const rest = rule('.crm-move-sel');
  assert.strictEqual(rest.background, 'transparent', 'у переключателя вернулась своя заливка');
  assert.match(rest.border, /transparent/, 'у переключателя вернулась постоянная рамка');
  assert.match(rest.appearance, /none/, 'вернулась системная стрелка — деталь из другой системы');
  const live = rule('.crm-move-sel:hover, .crm-move-sel:focus');
  assert.match(live['border-color'], /var\(--ink-200/, 'под курсором рамка не появляется — непонятно, что это управление');
});

// ═══ 5. ИЕРАРХИЯ И ДАТА ═════════════════════════════════════════════════════

test('дата обращения стоит в подвале и подписана, а не висит рядом с именем', async () => {
  const card = await oneCard({ full_name: 'Каримова Азиза', phone: UZ_RAW, created_at: '2026-09-03T10:12:00Z' });
  const foot = byClass(card, 'crm-card-foot');
  assert.strictEqual(foot.length, 1);
  assert.ok(textOf(foot[0]).includes('Заявка от 03.09.2026'),
    'дата снова печатается голым числом — непонятно, чего это дата');
  // И её нет в строке имени: там теперь только человек.
  const who = byClass(card, 'crm-card-who')[0];
  assert.ok(!textOf(who).includes('03.09.2026'), 'дата вернулась в строку имени');
});

test('порядок разметки и есть иерархия: кто → как дозвониться → факты → детали → подвал', async () => {
  const card = await oneCard({
    full_name: 'Каримова Азиза', phone: UZ_RAW, source: 'call',
    services: { id: 4, name: 'УЗИ брюшной полости' }, note: 'Перезвонить после обеда',
  });
  const order = card.children.map((n) => String(n.className).split(/\s+/)[0]);
  assert.deepStrictEqual(order,
    ['crm-card-who', 'crm-card-tel', 'crm-card-tags', 'crm-card-line', 'crm-card-note', 'crm-card-foot'],
    'порядок блоков карточки изменился — а он и есть ответ на «что читать первым»');
  // Вес: имя крупнее номера, номер крупнее деталей. Пол — 12.5px.
  const size = (sel) => parseFloat(rule(sel)['font-size']);
  assert.ok(size('.crm-card-name') > size('.crm-card-tel-n'), 'имя перестало быть главным на карточке');
  assert.ok(size('.crm-card-tel-n') > size('.crm-card-note'), 'номер сравнялся с комментарием по весу');
  for (const s of ['.crm-card-name', '.crm-card-tel-n', '.crm-card-note', '.crm-card-when', '.crm-card-kicker', '.crm-move-sel']) {
    assert.ok(size(s) >= 12.5, `${s}: ${size(s)}px — ниже пола шкалы (12.5px)`);
  }
});
