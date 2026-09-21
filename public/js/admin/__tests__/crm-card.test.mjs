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
 // QUICK_PATIENT_V1 — у узла НАСТОЯЩИЙ родитель, и remove() действительно
 // снимает окно с экрана: регистрация пациента переехала в окно, которое
 // закрывает само себя (fadeOutAndRemove), и «окно ушло» — это утверждение,
 // а не надежда.
 appendChild(c){this.children.push(c); if (c && typeof c === 'object') c.parentNode = this; return c;}
 append(...cs){for(const c of cs) if(c) this.appendChild(c);}
 removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1); if(c&&c.parentNode===this)c.parentNode=null; return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} select(){} closest(){return null;}
 remove(){ if (this.parentNode) this.parentNode.removeChild(this); }
 getBoundingClientRect(){return {top:0,left:0,width:0,height:0,bottom:0,right:0};}
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
globalThis.document={createElement:mk,createElementNS:(_n,t)=>mk(t),createTextNode:t=>new TX(t),head:mk('head'),body:mk('body'),documentElement:mk('html'),addEventListener(){},removeEventListener(){},getElementById(){return null;},
  // QUICK_PATIENT_V1 — окно заведения спрашивает документ, не открыт ли поверх
  // него список или календарь (тогда Enter значит «выбрать», а не «сохранить»).
  querySelector(){return null;},querySelectorAll(){return [];}};

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
// CRM_REASSIGN_V1 — персонал, который может вести доску, и ЖУРНАЛ ЗАПРОСОВ.
// Журнал нужен потому, что проверяется не вид поля, а то, что уходит на
// сервер: «передал заявку другому» — это строка в базе, а не выбранный пункт
// в списке.
let STAFF = [];
// CRM_LINKS_V1 — каталог услуг и СТРОКИ заявки (crm_request_services): окно
// заявки собирает из них свой список услуг, а «Записать на дату» назначает
// каждой дату. Без каталога окно не знает ни одной услуги, и записывать нечего.
let SERVICES = [];
let REQ_LINES = [];
const CALLS = [];
// CRM_REASSIGN_V1 — один отказ выборки персонала «по требованию»: список
// операторов не грузится ровно один раз, дальше — как обычно.
let failStaffOnce = false;
// CRM_LINKS_V1 — НАСТРОЕННАЯ воронка. null = пустой ответ crm_config_get, то
// есть запасные восемь колонок миграции 046 (как во всех тестах выше).
let BOARD_CFG = null;
// CRM_LINKS_V1 — отказ справочника воронки «по требованию» (см. раздел 11) и
// СТРОКИ ЗАЯВКИ, которые ещё едут или не доехали вовсе (раздел 10): и то и
// другое проверяется тем, что уходит на сервер СРАЗУ ПОСЛЕ, пока ответа нет.
let CFG_FAIL = false;
let LINES_HOLD = null;
let LINES_ERROR = false;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('/api/rpc/crm_config_get')) {
    if (CFG_FAIL) return { ok: false, json: async () => ({ error: { message: 'настройки недоступны' } }) };
    return jsonOk(BOARD_CFG);
  }
  if (u.startsWith('/api/rpc/')) return jsonOk({});
  if (u.startsWith('/api/db')) {
    if (body) CALLS.push(body);
    if (body && body.table === 'crm_requests' && body.op === 'select') return jsonOk(LEADS);
    // Список операторов отдаётся только на запрос с отбором ПО РОЛЯМ — тот
    // самый, которым карточка спрашивает «кому можно передать». Выборка врачей
    // (.eq('role','doctor')) сюда не попадает.
    if (body && body.table === 'users' && body.op === 'select'
        && (body.filters || []).some((f) => f.col === 'role' && f.op === 'in')) {
      if (failStaffOnce) { failStaffOnce = false; return { ok: false, json: async () => ({ error: { message: 'boom' } }) }; }
      return jsonOk(STAFF);
    }
    if (body && body.table === 'services' && body.op === 'select') return jsonOk(SERVICES);
    if (body && body.table === 'crm_request_services' && body.op === 'select') {
      if (LINES_HOLD) await LINES_HOLD;
      if (LINES_ERROR) return { ok: false, json: async () => ({ error: { message: 'строки не отданы' } }) };
      return jsonOk(REQ_LINES);
    }
    // CRM_LINKS_V1 — регистрация пациента с карточки. Поиск дубля читает
    // patients, вставка возвращает заведённую карту.
    // QUICK_PATIENT_V1 — выбор существующего пациента в диалоге дубликата
    // дочитывает его карту ОДНОЙ строкой (loadPatientById): без учёта `single`
    // окно получило бы массив вместо карты и привязало заявку к пустоте.
    if (body && body.table === 'patients' && body.op === 'select') {
      return jsonOk(body.single ? (PATIENT_DUPES[0] || null) : PATIENT_DUPES);
    }
    if (body && body.table === 'patients' && body.op === 'insert') return jsonOk(NEW_PATIENT);
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

// ═══ 6. КТО ВЕДЁТ ЗАЯВКУ ════════════════════════════════════════════════════
//
// CRM_REASSIGN_V1 (2026-09-19). Владелец: «in the crm we as an administrator
// change the operator of the card. please fix that too.»
//
// Взять заявку СЕБЕ умели все («Взять в работу», CRM_OWNERSHIP_V1), а передать
// её ДРУГОМУ — никто: единственная запись `assigned_to` во всём экране ставила
// туда номер нажавшего, и появлялась она только у ничьей заявки. Оператор
// заболел, ушёл со смены, уволился — его заявки оставались его: заведующая
// видела их (доска администратора не сужена), но сделать с ними ничего не
// могла, потому что чужие заявки не показываются их новому хозяину.
//
// Сервер это умел всегда: schema-registry отдаёт `assigned_to` в write.update
// и открывает администратору всю доску (scope.allRoles). Не хватало ровно
// одного поля в карточке — и тестам ниже важно не оно, а строка, которая после
// него уходит в базу.

/** Персонал, который может вести доску: ровно роли crm_requests.write. */
const OPERATORS = [
  { id: 7,  full_name: 'Админ',           role: 'admin' },
  { id: 12, full_name: 'Оператор Ольга',  role: 'callcenter' },
];

/** Открыть карточку заявки ТЕМ ЖЕ способом, что и человек, — щелчком по ней. */
async function openRequest(lead, user) {
  window.easymed.state.user = user;
  STAFF = OPERATORS;
  CALLS.length = 0;
  document.body.children.length = 0;
  const card = await oneCard(lead);
  card.dispatchEvent({ type: 'click', target: card, currentTarget: card, preventDefault() {}, stopPropagation() {} });
  await tick(60);
  const overlay = document.body.children.find((n) => hasClass(n, 'modal'));
  assert.ok(overlay, 'щелчок по карточке не открыл окно заявки');
  return overlay;
}

/** Выпадающий список операторов в окне заявки (или null, если его нет). */
const operatorSelect = (modal) =>
  walk(modal).find((n) => n.tagName === 'SELECT' && /Оператор/.test(String(n.getAttribute('aria-label') || ''))) || null;

/** Сохранение заявки — та же кнопка, что нажимает человек. */
async function saveRequest(modal) {
  const btn = walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить'));
  assert.ok(btn, 'кнопка «Сохранить» пропала из окна заявки');
  btn.click();
  await tick(60);
}

/** Запись ЭТОЙ заявки в базу (автоматика «Не пришёл» правит пачку по .in — не она). */
const savedRow = () => CALLS.filter((c) => c.table === 'crm_requests' && c.op === 'update'
  && (c.filters || []).some((f) => f.col === 'id' && f.op === 'eq')).pop();

const LEAD = { id: 1, full_name: 'Каримова Азиза', phone: UZ_RAW, assigned_to: 7, users: { full_name: 'Админ' } };

test('администратор видит «Оператор» в карточке заявки и может передать её другому', async () => {
  const modal = await openRequest(LEAD, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });
  const sel = operatorSelect(modal);
  assert.ok(sel, 'в карточке заявки нет поля «Оператор» — передать её некому и нечем');

  const opts = sel.children.filter((n) => n.tagName === 'OPTION').map((o) => ({ v: o.value, t: textOf(o) }));
  assert.ok(opts.some((o) => o.v === '' && o.t.includes('не назначен')),
    'нет пункта «снять оператора» — заявку можно было бы только передать, но не вернуть в общую стопку');
  assert.ok(opts.some((o) => o.v === '7' && o.t.includes('Админ')), 'в списке нет самого администратора');
  assert.ok(opts.some((o) => o.v === '12' && o.t.includes('Оператор Ольга')), 'в списке нет оператора колл-центра');
  assert.strictEqual(sel.value, '7', 'поле не показывает НЫНЕШНЕГО хозяина заявки');

  sel.value = '12';
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await saveRequest(modal);

  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.strictEqual(row.values.assigned_to, 12,
    'заявка сохранилась, но хозяин у неё прежний — именно это владелец и просил починить');
  window.easymed.state.user = null;
});

test('оператор колл-центра поля «Оператор» не видит и не шлёт assigned_to', async () => {
  // Раздать заявки может только тот, кто видит доску целиком. Оператор видит
  // свои и ничьи (scope в schema-registry), и «передать» для него — это отнять
  // у себя карточку, которую он больше не найдёт.
  const modal = await openRequest(LEAD, { id: 12, full_name: 'Оператор Ольга', role: 'callcenter' });
  assert.strictEqual(operatorSelect(modal), null, 'оператору показали чужой рычаг — раздачу заявок');
  // Окно и так спрашивает users — список ВРАЧЕЙ для строки услуги (.eq('role',
  // 'doctor'), CRM_LINE_DOCTOR_V1), это законно для любой роли. Здесь важно
  // именно отсутствие СПИСКА ОПЕРАТОРОВ — тот же самый запрос (.in('role', …)),
  // которым карточка ниже спрашивает «кому можно передать».
  assert.ok(!CALLS.some((c) => c.table === 'users' && (c.filters || []).some((f) => f.col === 'role' && f.op === 'in')),
    'список операторов запрошен для роли, которой раздавать заявки нельзя — лишний запрос на сервер');

  await saveRequest(modal);
  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.ok(!('assigned_to' in row.values),
    'ключ assigned_to ушёл на сервер от роли, которая его не правит: сохранение комментария молча меняло бы хозяина');
  window.easymed.state.user = null;
});

test('снять оператора: «— не назначен —» возвращает заявку в общую стопку', async () => {
  const modal = await openRequest(LEAD, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });
  const sel = operatorSelect(modal);
  sel.value = '';
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await saveRequest(modal);

  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.strictEqual(row.values.assigned_to, null,
    'пустой выбор обязан записать NULL: только так заявка снова попадает в стопку «ничьих»');
  window.easymed.state.user = null;
});

// Список персонала иногда транзиентно не грузится (сеть, перегруженный
// сервер). Тишина здесь опаснее пустоты: молчаливо очищенное поле при
// ближайшем сохранении сняло бы оператора с заявки, ничего не спросив.
// Тост здесь НЕ проверяется: toast() (ui.js) переиспользует el._t сначала для
// текста, а следующей же строкой — под возврат setTimeout (id таймера,
// который прячет заглушку), затирая его; в services-catalog.test.mjs это
// обойдено отдельным #toast с пишущим сеттером textContent, а этот харнесс
// (document.getElementById всегда null) такого перехватчика не заводит —
// значит, тексту неоткуда быть виден УЖЕ ПОСЛЕ возврата toast(). Проверяемо
// здесь только состояние поля.
test('сбой загрузки персонала — текущий оператор остаётся в поле', async () => {
  failStaffOnce = true;
  const modal = await openRequest(LEAD, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });
  const sel = operatorSelect(modal);
  assert.ok(sel, 'в карточке заявки нет поля «Оператор»');
  assert.strictEqual(sel.value, '7', 'сбой загрузки списка снял текущего оператора с поля');
  window.easymed.state.user = null;
});

// ═══ 7. «ЗАПИСАТЬ НА ДАТУ» СТАВИТ ДАТУ И СТУПЕНЬ ════════════════════════════
//
// CRM_LINKS_V1 (2026-09-20). Колл-центр назначает дату каждой услуге в окне
// «Даты приёма» — и карточка на доске оставалась в «В обработке» без метки
// даты: crm_requests.scheduled_date / status считались по ОТДЕЛЬНОМУ,
// оторванному от документа полю-зеркалу, которое окно дат не трогало.
//
// Цена — не косметика. По этим двум колонкам живут: метка «записан на …» на
// карточке, отчёт колл-центра (KPI «Записан» и «запись вперёд») и ночная
// автоматика «день прошёл без визита → Не пришёл». Записанный пациент был
// невидим всем троим.
//
// Проверяется то, что уходит на сервер, а не вид окна: дата ставится ТЕМ ЖЕ
// полем, что и человеком, и после «Сохранить и записать» строка заявки обязана
// нести и дату, и ступень «Записан».

const SVC = { id: 10, name: 'УЗИ почек', price: 120000, requires_doctor: 0, active: 1, type: 'imaging' };
const BOOK_DAY = '2026-10-05';

/** Заявка привязанного пациента с одной услугой — и открытое окно этой заявки. */
async function openBookable() {
  SERVICES = [SVC];
  REQ_LINES = [{ service_id: SVC.id, scheduled_date: '', status: 'pending', doctor_id: null }];
  const modal = await openRequest({
    id: 1, status: 'in_process', service_id: SVC.id, scheduled_date: null,
    full_name: 'Каримова Азиза', phone: UZ_RAW,
    patient_id: 7, patients: { id: 7, full_name: 'Каримова Азиза', mrn: 'A-000123' },
  }, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });
  return modal;
}

/** Окно «Даты приёма» — открывается той же кнопкой, что нажимает оператор. */
async function openScheduleSheet(modal) {
  const btn = walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Записать на дату'));
  assert.ok(btn, 'кнопка «Записать на дату» пропала из окна заявки');
  btn.click();
  await tick(60);
  const sheet = document.body.children.filter((n) => hasClass(n, 'modal')).pop();
  assert.ok(sheet && sheet !== modal, 'окно «Даты приёма» не открылось');
  return sheet;
}

const dateInputs = (root) => walk(root).filter((n) => n.tagName === 'INPUT' && n.getAttribute('type') === 'date');

test('«Записать на дату»: дата из окна дат доезжает до заявки, а заявка — в «Записан»', async () => {
  const modal = await openBookable();
  const sheet = await openScheduleSheet(modal);

  // В окне два поля даты: «одна дата для всех» и строка услуги. Ставим дату
  // строке — тем же действием, что человек.
  const inputs = dateInputs(sheet);
  assert.ok(inputs.length >= 2, 'в окне «Даты приёма» нет поля даты у строки услуги');
  const rowDate = inputs[inputs.length - 1];
  rowDate.value = BOOK_DAY;
  rowDate.dispatchEvent({ type: 'change', target: rowDate, currentTarget: rowDate });

  const save = walk(sheet).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить и записать'));
  assert.ok(save, 'кнопка «Сохранить и записать» пропала из окна дат');
  save.click();
  await tick(80);

  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.strictEqual(row.values.scheduled_date, BOOK_DAY,
    'заявка сохранилась без даты записи: карточка останется без метки, а ночная автоматика «Не пришёл» никогда не сработает');
  assert.strictEqual(row.values.status, 'scheduled',
    'записанная заявка осталась в «В обработке» — в воронке нет ни одного «записан»');
  window.easymed.state.user = null;
});

test('«Применить ко всем» — тот же результат: дата уходит в заявку', async () => {
  const modal = await openBookable();
  const sheet = await openScheduleSheet(modal);

  const all = dateInputs(sheet)[0];
  all.value = BOOK_DAY;
  const applyAll = walk(sheet).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Применить ко всем'));
  assert.ok(applyAll, 'кнопка «Применить ко всем» пропала из окна дат');
  applyAll.click();
  await tick();

  walk(sheet).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить и записать')).click();
  await tick(80);

  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.strictEqual(row.values.scheduled_date, BOOK_DAY,
    '«Применить ко всем» проставило даты в окне, но заявка ушла на сервер без даты');
  window.easymed.state.user = null;
});

test('самая РАННЯЯ дата становится датой заявки: карточка показывает ближайший приём', async () => {
  SERVICES = [SVC, { id: 11, name: 'Анализ крови', price: 40000, requires_doctor: 0, active: 1, type: 'lab' }];
  REQ_LINES = [
    { service_id: 11, scheduled_date: '', status: 'pending', doctor_id: null },
    { service_id: 10, scheduled_date: '', status: 'pending', doctor_id: null },
  ];
  const modal = await openRequest({
    id: 1, status: 'in_process', service_id: 11, scheduled_date: null,
    full_name: 'Каримова Азиза', phone: UZ_RAW,
    patient_id: 7, patients: { id: 7, full_name: 'Каримова Азиза', mrn: 'A-000123' },
  }, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });
  const sheet = await openScheduleSheet(modal);

  // Первой строкой идёт «Анализ крови» (порядок строк заявки), но назначена она
  // на ПОЗДНИЙ день. Ближайший приём — второй строкой.
  const rows = dateInputs(sheet).slice(1);
  assert.strictEqual(rows.length, 2, 'ожидались две строки услуг');
  rows[0].value = '2026-10-09';
  rows[0].dispatchEvent({ type: 'change', target: rows[0], currentTarget: rows[0] });
  rows[1].value = BOOK_DAY;
  rows[1].dispatchEvent({ type: 'change', target: rows[1], currentTarget: rows[1] });

  walk(sheet).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Сохранить и записать')).click();
  await tick(80);

  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.strictEqual(row.values.scheduled_date, BOOK_DAY,
    'датой заявки стала не ближайшая: карточка обещает приём позже, чем пациента ждут');
  SERVICES = []; REQ_LINES = [];
  window.easymed.state.user = null;
});

// ═══ 8. РЕГИСТРАЦИЯ ПАЦИЕНТА С КАРТОЧКИ ═════════════════════════════════════
//
// CRM_LINKS_V1 (2026-09-20). Окно регистрации внутри CRM писало в `patients`
// НАПРЯМУЮ, минуя savePatient() — единственный путь, на котором висят три
// вещи, без которых карта заводится «почти правильно»:
//
//   • проверка дубля (findDuplicateCandidates): тот же человек звонил на
//     прошлой неделе — и получает вторую карту, а с ней вторую историю;
//   • штампы клиники и филиала (company_id / branch_id): карта без филиала
//     выпадает из отчётов по филиалу;
//   • привязка ВСЕХ открытых заявок с этим номером (linkCrmRequestsToPatient):
//     пациент звонил трижды — закрывается одна заявка, две остаются висеть.
//
// Проверяется не «функция вызвана», а следы этого пути в запросах к серверу:
// сначала поиск дубля, потом вставка, потом привязка заявок по номеру.
//
// QUICK_PATIENT_V1 (2026-09-21). Своей формы у этого окна больше нет: карточка
// зовёт ОБЩЕЕ окно быстрой регистрации (views/quick-patient-modal.js) — то же,
// что и регистратура, и привязка пациента в каталоге услуг. Смысл проверок
// ниже не изменился ни на слово; изменилось то, В ЧЁМ их проверяют: подписи и
// кнопка стали общими, а пол и дата рождения — обязательными, потому что от
// них зависят нормы анализов и печатные бланки. Своя форма их не спрашивала.

let PATIENT_DUPES = [];
const NEW_PATIENT = { id: 77, full_name: 'Каримова Азиза', mrn: 'A-000777', phone: '+' + UZ_RAW };

/** Окно регистрации, открытое кнопкой «Записать на дату» у лида без карты. */
async function openRegistration() {
  SERVICES = [SVC];
  REQ_LINES = [{ service_id: SVC.id, scheduled_date: '', status: 'pending', doctor_id: null }];
  const modal = await openRequest({
    id: 1, status: 'in_process', service_id: SVC.id, full_name: 'Каримова Азиза', phone: UZ_RAW,
  }, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });
  const btn = walk(modal).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Записать на дату'));
  assert.ok(btn, 'кнопка «Записать на дату» пропала из окна заявки');
  btn.click();
  await tick(60);
  const reg = document.body.children.filter((n) => hasClass(n, 'modal')).pop();
  assert.ok(reg && reg !== modal, 'лид без карты не открыл окно регистрации пациента');
  assert.ok(walk(reg).some((n) => n.attrs && n.attrs['data-dialog'] === 'quick-patient'),
    'карточка рисует СВОЮ форму заведения пациента вместо общего окна быстрой регистрации');
  return reg;
}

/** Поле общего окна по имени колонки (реестр полей = имена в разметке). */
const fieldByName = (root, name) => walk(root).find((e) => e.attrs && e.attrs.name === name) || null;

async function pressRegister(reg) {
  // Дата рождения и пол в общем окне ОБЯЗАТЕЛЬНЫ — своя форма CRM их не
  // спрашивала вовсе, и карта уходила в базу без возраста и пола.
  const dob = fieldByName(reg, 'date_of_birth');
  assert.ok(dob, 'в окне регистрации нет даты рождения');
  dob.value = '1990-01-01';
  const sex = walk(reg).find((e) => e.dataset && e.dataset.name === 'gender' && e.dataset.value === 'F');
  assert.ok(sex, 'в окне регистрации нечем указать пол');
  sex.click();

  const btn = walk(reg).find((n) => n.tagName === 'BUTTON' && textOf(n).includes('Создать пациента'));
  assert.ok(btn, 'кнопка «Создать пациента» пропала из окна регистрации');
  btn.click();
  await tick(90);
}

/** Правка ИМЕННО этой заявки (привязка карточки к карте), а не пачки по номеру. */
const cardPatch = (from) => CALLS.slice(from).find((c) => c.table === 'crm_requests' && c.op === 'update'
  && (c.filters || []).some((f) => f.col === 'id' && f.op === 'eq'));

const patientInserts = () => CALLS.filter((c) => c.table === 'patients' && c.op === 'insert');
const patientSelects = () => CALLS.filter((c) => c.table === 'patients' && c.op === 'select');

test('карта с карточки заводится общим путём: сначала проверка дубля, потом вставка', async () => {
  PATIENT_DUPES = [];
  const reg = await openRegistration();
  const before = CALLS.length;
  await pressRegister(reg);

  const after = CALLS.slice(before);
  const ins = after.findIndex((c) => c.table === 'patients' && c.op === 'insert');
  const dup = after.findIndex((c) => c.table === 'patients' && c.op === 'select');
  assert.ok(ins > -1, 'пациент не создан вовсе');
  assert.ok(dup > -1 && dup < ins,
    'перед вставкой карты не было ни одного поиска по базе — окно CRM снова пишет в patients мимо проверки дубля');
  // Заведённая карта достаётся ЗАЯВКЕ: ради этого регистрацию и открывали.
  const patch = cardPatch(before);
  assert.ok(patch, 'карточка не получила пациента: заявка останется без карты');
  assert.strictEqual(patch.values.patient_id, NEW_PATIENT.id, 'к заявке привязали не созданную карту');
  assert.strictEqual(walk(document.body).some((n) => n.attrs && n.attrs['data-dialog'] === 'quick-patient'), false,
    'окно регистрации осталось на экране после заведения карты');
  window.easymed.state.user = null;
});

// QUICK_PATIENT_V1 — ЧТО УЖЕ ЗНАЕТ ЗАЯВКА, ПОВТОРНО НЕ НАБИРАЮТ.
//
// Имя в заявке лежит ОДНОЙ строкой, а карта хранит его тремя полями; телефон
// — единственное, что в лиде есть всегда. Регистратор, перенабирающий их
// руками, ошибается ровно в номере — и заявка расходится с картой.
test('окно регистрации открывается заполненным: имя и телефон приходят из заявки', async () => {
  PATIENT_DUPES = [];
  const reg = await openRegistration();

  assert.strictEqual(fieldByName(reg, 'last_name').value, 'Каримова',
    'фамилия из заявки не подставлена — её придётся набирать заново');
  assert.strictEqual(fieldByName(reg, 'first_name').value, 'Азиза', 'имя из заявки не подставлено');
  const phone = fieldByName(reg, 'phone');
  assert.ok(phone, 'в окне регистрации нет телефона');
  assert.strictEqual(String(phone.value).replace(/\D/g, ''), UZ_RAW,
    'телефон заявки не подставлен или искажён: ' + phone.value);
  window.easymed.state.user = null;
});

test('все открытые заявки с этим номером привязываются к новой карте, а не одна', async () => {
  PATIENT_DUPES = [];
  const reg = await openRegistration();
  const before = CALLS.length;
  await pressRegister(reg);

  const link = CALLS.slice(before).find((c) => c.table === 'crm_requests' && c.op === 'update'
    && (c.filters || []).some((f) => f.col === 'id' && f.op === 'in'));
  assert.ok(link, 'привязки открытых заявок по телефону не было: пациент звонил трижды — две заявки останутся висеть');
  assert.strictEqual(link.values.patient_id, NEW_PATIENT.id, 'заявки привязаны не к созданной карте');
  window.easymed.state.user = null;
});

test('похожий пациент уже есть — окно спрашивает, а не заводит вторую карту', async () => {
  PATIENT_DUPES = [{ id: 55, mrn: 'A-000055', full_name: 'Каримова Азиза', last_name: 'Каримова',
                     first_name: 'Азиза', middle_name: '', phone: '+' + UZ_RAW, date_of_birth: '1990-01-01', national_id: '' }];
  const reg = await openRegistration();
  const before = CALLS.length;
  await pressRegister(reg);
  await tick(60);

  assert.strictEqual(CALLS.slice(before).filter((c) => c.table === 'patients' && c.op === 'insert').length, 0,
    'вторая карта заведена молча — именно это и есть дубль пациента');
  const dlg = walk(document.body).find((n) => n.getAttribute && n.getAttribute('data-dialog') === 'patient-duplicate');
  assert.ok(dlg, 'о найденном дубле никто не спросил: окно возможного дубликата не открылось');
  PATIENT_DUPES = [];
  window.easymed.state.user = null;
});

// CRM_LINKS_V1 — «ОТКРЫТЬ СУЩЕСТВУЮЩЕГО» — ЭТО ТОЖЕ РЕГИСТРАЦИЯ.
//
// Три вещи savePatient() делает ПОСЛЕ вставки карты, и привязка открытых заявок
// по номеру — одна из них. На пути «карта уже есть, беру её» вставки нет, а
// значит не было и привязки: у человека, звонившего трижды, к найденной карте
// цеплялась ровно та заявка, из которой открыли окно, а две другие оставались
// висеть ничьими — их не подхватит ни смета, ни визит.
test('«Открыть существующего» привязывает к карте ВСЕ открытые заявки с этим номером', async () => {
  PATIENT_DUPES = [{ id: 55, mrn: 'A-000055', full_name: 'Каримова Азиза', last_name: 'Каримова',
                     first_name: 'Азиза', middle_name: '', phone: '+' + UZ_RAW, date_of_birth: '1990-01-01', national_id: '' }];
  const reg = await openRegistration();
  await pressRegister(reg);
  await tick(60);

  const dlg = walk(document.body).find((n) => n.getAttribute && n.getAttribute('data-dialog') === 'patient-duplicate');
  assert.ok(dlg, 'окно возможного дубликата не открылось — выбирать нечего');
  const pick = walk(dlg).find((n) => n.tagName === 'BUTTON' && hasClass(n, 'dup-row'));
  assert.ok(pick, 'в окне дубликата нет строки найденного пациента');

  const before = CALLS.length;
  pick.click();
  await tick(90);

  const link = CALLS.slice(before).find((c) => c.table === 'crm_requests' && c.op === 'update'
    && (c.filters || []).some((f) => f.col === 'id' && f.op === 'in'));
  assert.ok(link, 'заявки по номеру к выбранной карте не привязаны: звонивший трижды оставит две ничьи заявки');
  assert.strictEqual(link.values.patient_id, 55, 'заявки привязаны не к выбранной карте');
  // И та заявка, ИЗ КОТОРОЙ открыли окно, — тоже: она могла быть без телефона
  // или с другим его написанием, и привязка по номеру её бы не подхватила.
  const patch = cardPatch(before);
  assert.ok(patch, 'сама карточка осталась без пациента');
  assert.strictEqual(patch.values.patient_id, 55, 'карточку привязали не к выбранной карте');

  PATIENT_DUPES = [];
  window.easymed.state.user = null;
});

// ═══ 9. НОЧНАЯ АВТОМАТИКА ЧИТАЕТ НАСТРОЕННУЮ ВОРОНКУ ════════════════════════
//
// CRM_LINKS_V1 (2026-09-20). Доска умеет любую воронку (миграция 077: «добавить
// колонку "Ждёт оплаты" больше не значит выпустить релиз»), а автоматика
// «день записи прошёл, визита не было → Не пришёл» сверялась с зашитой парой
// ['scheduled','approved']. Клиника, переименовавшая или добавившая колонку,
// получала заявки, которые не подхватывались НИЧЕМ: они оставались в своей
// колонке навсегда, и отчёт считал их всё ещё ожидающими приёма.

const SEEDED_STAGES = [
  { key: 'in_process',    label: 'В обработке',           color: 'info',   position: 1, is_active: 1, kind: 'open' },
  { key: 'recall',        label: 'Перезвонить',           color: 'warn',   position: 2, is_active: 1, kind: 'open' },
  { key: 'scheduled',     label: 'Записан',               color: 'purple', position: 3, is_active: 1, kind: 'open' },
  { key: 'approved',      label: 'Подтверждён',           color: 'teal',   position: 4, is_active: 1, kind: 'open' },
  { key: 'came',          label: 'Пришёл',                color: 'ok',     position: 5, is_active: 1, kind: 'won' },
  { key: 'no_show',       label: 'Не пришёл',             color: 'crit',   position: 6, is_active: 1, kind: 'lost' },
  { key: 'stopped',       label: 'Обработка остановлена', color: '',       position: 7, is_active: 1, kind: 'lost' },
  { key: 'not_qualified', label: 'Нецелевой',             color: '',       position: 8, is_active: 1, kind: 'lost' },
];

/** Отбор по статусу у автоматики «Не пришёл» (правка ПАЧКИ, без фильтра по id). */
const sweepCall = () => CALLS.find((c) => c.table === 'crm_requests' && c.op === 'update'
  && (c.filters || []).some((f) => f.col === 'scheduled_date' && f.op === 'lt'));

test('автоматика «Не пришёл» берёт живые колонки из настроек, а не из зашитой пары', async () => {
  BOARD_CFG = { stages: [...SEEDED_STAGES, { key: 'waiting_pay', label: 'Ждёт оплаты', color: 'info', position: 9, is_active: 1, kind: 'open' }], sources: [], routing: [] };
  CALLS.length = 0;
  await board([]);

  const sweep = sweepCall();
  assert.ok(sweep, 'ночная автоматика не сработала вовсе');
  const mine = (sweep.filters || []).find((f) => f.col === 'status' && f.op === 'in');
  assert.ok(mine, 'автоматика не отбирает по ступени');
  assert.ok(mine.val.includes('waiting_pay'),
    'заведённая клиникой живая колонка не попала в автоматику: заявки в ней зависнут навсегда — ' + JSON.stringify(mine.val));
  assert.ok(!mine.val.includes('came'), 'автоматика метит «не пришёл» тем, кто уже дошёл');
  assert.ok(!mine.val.includes('no_show'), 'автоматика перекладывает заявку саму в себя');
  assert.strictEqual(sweep.values.status, 'no_show', 'заявка уходит не в проигрышную колонку');
  BOARD_CFG = null;
});

test('колонку «Не пришёл» переименовали — автоматика уходит в неё, а не в исчезнувший ключ', async () => {
  BOARD_CFG = { stages: SEEDED_STAGES.filter((s) => s.key !== 'no_show')
    .concat([{ key: 'missed', label: 'Пропустил', color: 'crit', position: 6, is_active: 1, kind: 'lost' }]), sources: [], routing: [] };
  CALLS.length = 0;
  await board([]);

  const sweep = sweepCall();
  assert.ok(sweep, 'без сидовой колонки автоматика молчит — заявки зависают');
  assert.strictEqual(sweep.values.status, 'missed',
    'автоматика пишет несуществующий ключ: вставка упадёт по внешнему ключу, и заявка останется висеть');
  BOARD_CFG = null;
});

// CRM_LINKS_V1 — «НЕ ПРИШЁЛ» БЫВАЕТ ТОЛЬКО У ТОГО, КОГО ЖДАЛИ.
//
// Автоматика брала ВСЕ живые колонки. Но «В обработке» и «Перезвонить» — это
// колонки, в которых пациента ещё НЕ ЖДУТ: дата в такой карточке значит «когда
// перезвонить», а не «когда придёт». Оператор, отложивший вчерашний лид на
// «Перезвонить», наутро находил его в «Не пришёл» — заявка, с которой он ещё
// работает, объявлена потерянной, и вернуть её можно только руками.
//
// Метится всё, что стоит в воронке С «Записан» И ДАЛЬШЕ: дальше по порядку
// колонок — это дальше по пути пациента, и там дата уже значит приём.
test('сметание «Не пришёл» начинается с «Записан» — отложенный на «Перезвонить» лид не трогают', async () => {
  BOARD_CFG = { stages: [...SEEDED_STAGES, { key: 'waiting_pay', label: 'Ждёт оплаты', color: 'info', position: 9, is_active: 1, kind: 'open' }], sources: [], routing: [] };
  CALLS.length = 0;
  await board([]);

  const sweep = sweepCall();
  assert.ok(sweep, 'ночная автоматика не сработала вовсе');
  const mine = (sweep.filters || []).find((f) => f.col === 'status' && f.op === 'in');
  assert.ok(mine, 'автоматика не отбирает по ступени');
  assert.ok(!mine.val.includes('in_process'),
    'заявка «В обработке» с прошедшей датой уезжает в «Не пришёл»: её ещё никто не ждал — ' + JSON.stringify(mine.val));
  assert.ok(!mine.val.includes('recall'),
    'лид, отложенный оператором на «Перезвонить», объявлен не пришедшим: дата в нём значит «когда звонить»');
  assert.ok(mine.val.includes('scheduled'), 'записанного пациента автоматика перестала проверять вовсе');
  assert.ok(mine.val.includes('approved'), 'подтверждённая запись выпала из автоматики');
  assert.ok(mine.val.includes('waiting_pay'),
    'колонка клиники ПОСЛЕ «Записан» выпала из автоматики: заявки в ней зависнут навсегда');
  BOARD_CFG = null;
});

// ═══ 10. ОКНО ЗАЯВКИ НЕ СТИРАЕТ ТО, ЧЕГО НЕ ВИДЕЛО ══════════════════════════
//
// CRM_LINKS_V1 (2026-09-20). saveLines() — «полная замена набора»: pending-строки
// отменяются, выбранные пишутся заново. Набор этот собирается из ОТВЕТА сервера,
// который едет отдельным запросом. Пока он не доехал, picked пуст — и сохранение,
// сделанное в эту секунду (человек открыл карточку и сразу дописал комментарий),
// отменяло ВСЕ строки заявки и не писало ни одной. Услуги и даты, набранные
// колл-центром, исчезали молча.
//
// То же самое, когда запрос ОТКАЗАЛ: пустой список неотличим от «услуг нет».

/** Правки/вставки строк заявки — то, чем saveLines() переписывает набор. */
const lineWrites = () => CALLS.filter((c) => c.table === 'crm_request_services' && c.op !== 'select');

test('сохранение до того, как строки доехали, не стирает их', async () => {
  SERVICES = [SVC];
  REQ_LINES = [{ service_id: SVC.id, scheduled_date: BOOK_DAY, status: 'pending', doctor_id: null }];
  let release = null;
  LINES_HOLD = new Promise((r) => { release = r; });
  try {
    const modal = await openRequest({
      id: 1, status: 'scheduled', service_id: SVC.id, scheduled_date: BOOK_DAY,
      full_name: 'Каримова Азиза', phone: UZ_RAW,
    }, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });

    CALLS.length = 0;
    await saveRequest(modal);

    assert.deepStrictEqual(lineWrites(), [],
      'строки заявки переписаны до того, как их прочитали: услуги и даты колл-центра стёрты — ' + JSON.stringify(lineWrites()));
    const row = savedRow();
    assert.ok(row, 'сохранение не дошло до базы');
    assert.strictEqual(row.values.scheduled_date, BOOK_DAY, 'дата заявки затёрта пустым набором строк');
  } finally {
    LINES_HOLD = null;
    if (release) release();
    await tick(40);
    SERVICES = []; REQ_LINES = [];
    window.easymed.state.user = null;
  }
});

test('строки не отдались из-за ошибки — сохранение тоже их не трогает', async () => {
  SERVICES = [SVC];
  REQ_LINES = [{ service_id: SVC.id, scheduled_date: BOOK_DAY, status: 'pending', doctor_id: null }];
  LINES_ERROR = true;
  try {
    const modal = await openRequest({
      id: 1, status: 'scheduled', service_id: SVC.id, scheduled_date: BOOK_DAY,
      full_name: 'Каримова Азиза', phone: UZ_RAW,
    }, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });

    CALLS.length = 0;
    await saveRequest(modal);

    assert.deepStrictEqual(lineWrites(), [],
      'отказ выборки принят за «услуг нет», и набор строк переписан пустым — ' + JSON.stringify(lineWrites()));
  } finally {
    LINES_ERROR = false;
    SERVICES = []; REQ_LINES = [];
    window.easymed.state.user = null;
  }
});

// CRM_LINKS_V1 — ВЫПОЛНЕННАЯ СТРОКА НЕ ПЕРЕПИСЫВАЕТСЯ.
//
// Строка со статусом 'done' — это уже оформленная и оплаченная услуга.
// saveLines() отменяла только pending (это верно), но потом вставляла ЗАНОВО
// ВЕСЬ picked, включая выполненные: у заявки появлялась вторая, «ждущая» копия
// уже оплаченной услуги, и регистратура подставляла её в смету второй раз.
// primaryDate() ту же строку считала датой заявки — карточка обещала приём,
// который состоялся неделю назад, и ночная автоматика уносила заявку в
// «Не пришёл», хотя ждали её совсем в другой день.
test('выполненная строка не переписывается и не считается датой заявки', async () => {
  const LAB = { id: 11, name: 'Анализ крови', price: 40000, requires_doctor: 0, active: 1, type: 'lab' };
  SERVICES = [SVC, LAB];
  REQ_LINES = [
    { service_id: SVC.id, scheduled_date: '2026-09-01', status: 'done', doctor_id: null },
    { service_id: LAB.id, scheduled_date: BOOK_DAY,     status: 'pending', doctor_id: null },
  ];
  const modal = await openRequest({
    id: 1, status: 'scheduled', service_id: SVC.id, scheduled_date: '2026-09-01',
    full_name: 'Каримова Азиза', phone: UZ_RAW,
  }, { id: 7, full_name: 'Админ', role: 'admin', is_admin: true });

  CALLS.length = 0;
  await saveRequest(modal);

  const row = savedRow();
  assert.ok(row, 'сохранение не дошло до базы');
  assert.strictEqual(row.values.scheduled_date, BOOK_DAY,
    'датой заявки стала уже выполненная строка: карточка обещает приём, который прошёл, и ночью заявка уедет в «Не пришёл»');

  const ins = CALLS.find((c) => c.table === 'crm_request_services' && c.op === 'insert');
  assert.ok(ins, 'строки заявки не сохранены вовсе');
  const written = (Array.isArray(ins.values) ? ins.values : [ins.values]).map((v) => v.service_id);
  assert.deepStrictEqual(written, [LAB.id],
    'выполненная строка вписана заново как ждущая: у оплаченной услуги появился второй, «ждущий» двойник — ' + JSON.stringify(written));

  SERVICES = []; REQ_LINES = [];
  window.easymed.state.user = null;
});

// ═══ 11. ЗАПАСНАЯ ВОРОНКА НЕ ЗАПОМИНАЕТСЯ ═══════════════════════════════════
//
// CRM_LINKS_V1 (2026-09-20). crmStageKeys() кеширует ответ справочника — это
// верно: воронку правят раз в месяц, а спрашивают её все фоновые действия.
// Но кешировался и ЗАПАСНОЙ вариант: одна неудачная попытка (сервер ещё
// поднимается, сеть моргнула) — и вся вкладка до перезагрузки работала с
// сидовыми восемью колонками. У клиники со своей воронкой это значит, что её
// колонки не существуют: заявки в них не привязываются к карте, не
// подставляются в смету и не закрываются визитом.
const { crmStageKeys, invalidateCrmStages } = await import('../crm-stages.js');

test('справочник не ответил — запасная воронка не запоминается, следующий спросит заново', async () => {
  invalidateCrmStages();
  CFG_FAIL = true;
  const first = await crmStageKeys();
  assert.ok(!first.open.includes('waiting_pay'), 'отказ отдал не запасную воронку');

  CFG_FAIL = false;
  BOARD_CFG = { stages: [...SEEDED_STAGES, { key: 'waiting_pay', label: 'Ждёт оплаты', color: 'info', position: 9, is_active: 1, kind: 'open' }], sources: [], routing: [] };
  const second = await crmStageKeys();
  assert.ok(second.open.includes('waiting_pay'),
    'запасная воронка осела в кеше: одна неудачная попытка — и вкладка до перезагрузки не знает колонок клиники — ' + JSON.stringify(second.open));

  BOARD_CFG = null;
  invalidateCrmStages();
});
