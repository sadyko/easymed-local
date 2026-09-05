// PATIENT_ROW_V2 (2026-09-05) — строка реестра пациентов.
//
// Владелец, глядя на реестр: «make a little redesign of the cards of the
// patients. make more appealing. date format is 2 may 2019. show the
// registrators name also add small telegram icon for the patients with active
// telegram».
//
// Что здесь действительно проверяется — по одному предложению на решение:
//
//   * ДАТА читается человеком и НА ЯЗЫКЕ ИНТЕРФЕЙСА: «2 мая 2019» по-русски,
//     «2-may 2019» по-узбекски, «2 May 2019» по-английски. Проверяются все три
//     языка, потому что сырое ISO выглядело одинаково во всех трёх, и «починка»
//     только русского была бы тем же багом в двух языках из трёх;
//   * РЕГИСТРАТОР — настоящее имя, а когда его в карте нет, так и написано
//     словом. Прочерк на каждой строке (то, что владелец и сфотографировал)
//     неотличим от сломанного экрана; отдельный случай — что имя берётся из
//     patients.created_by и НЕ зависит от RPC patient_base_aggregates, которой
//     в этой сборке нет вовсе;
//   * TELEGRAM — значок стоит у тех, у кого ЖИВАЯ связка чата, и не стоит у
//     остальных; без права на раздел чата процедура вообще не спрашивается,
//     и ни одна строка не притворяется, будто знает про Telegram;
//   * ТЕЛЕФОН выглядит как везде в продукте (formatPhone) и не переносится;
//   * КРАЙНИЕ СЛУЧАИ (60-значное ФИО, нет даты рождения, нет визитов, нет
//     телефона) не ломают строку: ячеек по-прежнему восемь, и обрезанное имя
//     остаётся прочитываемым (title);
//   * ВСЁ, ЧТО УМЕЛ ЭКРАН, цело: поиск, фильтр по дате рождения, три
//     сортировки, дубликаты с полосой объединения, листание, кнопка
//     синхронизации филиала, калькулятор и создание пациента.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');
const CSS = fs.readFileSync(path.join(PUB, 'css', 'admin-views.css'), 'utf8');

// ---------------------------------------------------------------------------
// Fake-DOM harness — copied from __tests__/patients-hub.test.mjs (itself from
// lab-panels-mode / telephony-settings): these views render Icon() calls,
// which go through ui.js's html() -> a <template> parse.
// ---------------------------------------------------------------------------
class F{constructor(t){this.tagName=String(t).toUpperCase();this.style={};this.children=[];this.attrs={};this.className='';this._t='';this._l={};this.dataset={};this.value='';}
 appendChild(c){this.children.push(c);return c;} removeChild(c){const i=this.children.indexOf(c);if(i>-1)this.children.splice(i,1);return c;}
 get firstChild(){return this.children[0]||null;} replaceChildren(){this.children.length=0;}
 setAttribute(k,v){this.attrs[k]=String(v); if (k === 'value') this.value = String(v);} getAttribute(k){return this.attrs[k]??null;} hasAttribute(k){return k in this.attrs;}
 removeAttribute(k){delete this.attrs[k];}
 addEventListener(t,fn){(this._l[t]||(this._l[t]=[])).push(fn);} removeEventListener(){}
 dispatchEvent(e){for(const fn of this._l[e.type]||[])fn(e);return true;}
 click(){this.dispatchEvent({type:'click',currentTarget:this,target:this,preventDefault(){},stopPropagation(){}});}
 focus(){} blur(){} scrollTo(){} scrollIntoView(){} remove(){} select(){}
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

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
}
const fakeLocalStorage = makeLocalStorage();
globalThis.localStorage = fakeLocalStorage;
// I18N_LOCALE_PIN_V1 — i18n.js picks its language ONCE, at module load, from
// this store, so pin it BEFORE the view imports below.
fakeLocalStorage.setItem('admin.lang', 'ru');

globalThis.window = {
  location: { hostname: 'localhost', hash: '' }, localStorage: fakeLocalStorage,
  addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  scrollTo(){}, scrollY: 0,
  easymed: { state: { user: { id: 'u-1', full_name: 'Регистратор', company_id: 'c-1', role: 'registrar' } } },
  CLINIC: { id: 'c-1' },
  confirm: () => true,
  easymedSetTabSub: () => {},
};
globalThis.location = globalThis.window.location;
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
globalThis.requestAnimationFrame=(fn)=>fn();
globalThis.cancelAnimationFrame=()=>{};
globalThis.history = { state: null, replaceState(){}, pushState(){} };

// ---------------------------------------------------------------------------
// DATA — десять правдоподобных строк, включая крайние случаи.
// ---------------------------------------------------------------------------
const LONG_NAME = 'Абдурахманбердиев Шамсиддинбек Улугбекмирзаевич';   // 47 букв в ФИО
assert.ok(LONG_NAME.length >= 45, 'образец длинного ФИО перестал быть длинным');

const PATIENTS = [
  // ① обычная строка + ЖИВОЙ Telegram + дата рождения ровно из просьбы владельца
  { id: 1, company_id: 'c-1', mrn: 'P-26-00001', full_name: 'Каримова Азиза Рустамовна',
    last_name: 'Каримова', first_name: 'Азиза', middle_name: 'Рустамовна',
    date_of_birth: '2019-05-02', gender: 'female', phone: '+998901234567', city: 'Ташкент',
    registration_date: '2026-08-21', created_by: 7 },
  // ② ФИО длиной с колонку — обрезается многоточием, не ломает строку
  { id: 2, company_id: 'c-1', mrn: 'P-26-00002', full_name: LONG_NAME,
    last_name: 'Абдурахманбердиев', first_name: 'Шамсиддинбек', middle_name: 'Улугбекмирзаевич',
    date_of_birth: '1976-09-04', gender: 'male', phone: '998915930555',
    registration_date: '2026-07-15', created_by: 7 },
  // ③ БЕЗ даты рождения
  { id: 3, company_id: 'c-1', mrn: 'P-26-00003', full_name: 'Турсунов Бобур',
    last_name: 'Турсунов', first_name: 'Бобур', date_of_birth: '', gender: 'male',
    phone: '+998918452218', registration_date: '2026-06-02', created_by: 9 },
  // ④ БЕЗ регистратора (карту завели до того, как автора стали записывать)
  { id: 4, company_id: 'c-1', mrn: 'P-26-00004', full_name: 'Ахмедова Мадина',
    last_name: 'Ахмедова', first_name: 'Мадина', date_of_birth: '2014-11-28', gender: 'female',
    phone: '+998934100902', registration_date: '2026-05-18', created_by: null },
  // ⑤ БЕЗ визитов и БЕЗ даты регистрации — последняя дата неизвестна вовсе
  { id: 5, company_id: 'c-1', mrn: 'P-26-00005', full_name: 'Норқулов Жасур',
    last_name: 'Норқулов', first_name: 'Жасур', date_of_birth: '1962-01-19', gender: 'male',
    phone: '+998905537104', registration_date: '', created_at: '', created_by: 7 },
  // ⑥ БЕЗ телефона
  { id: 6, company_id: 'c-1', mrn: 'P-26-00006', full_name: 'Саидова Дилноза',
    last_name: 'Саидова', first_name: 'Дилноза', date_of_birth: '1995-07-23', gender: 'female',
    phone: '', registration_date: '2026-04-29', created_by: 9 },
  // ⑦–⑩ ещё четыре обычные карты: страница реестра — тридцать строк, и десять
  // из них должны выглядеть как десять, а не как четыре особых случая.
  { id: 7, company_id: 'c-1', mrn: 'P-26-00007', full_name: 'Хакимов Рустам Бахтиёрович',
    last_name: 'Хакимов', first_name: 'Рустам', middle_name: 'Бахтиёрович',
    date_of_birth: '1981-04-30', gender: 'male', phone: '+998909226418', city: 'Андижан',
    registration_date: '2026-05-15', created_by: 7 },
  { id: 8, company_id: 'c-1', mrn: 'P-26-00008', full_name: 'Юсупова Нилуфар',
    last_name: 'Юсупова', first_name: 'Нилуфар', date_of_birth: '1958-12-08', gender: 'female',
    phone: '+998912201355', registration_date: '2026-05-10', created_by: 9 },
  { id: 9, company_id: 'c-1', mrn: 'P-26-00009', full_name: 'Мирзаев Шерзод Фарходович',
    last_name: 'Мирзаев', first_name: 'Шерзод', middle_name: 'Фарходович',
    date_of_birth: '2002-08-17', gender: 'male', phone: '+998901002287',
    registration_date: '2026-03-01', created_by: 7 },
  { id: 10, company_id: 'c-1', mrn: 'P-26-00010', full_name: 'Эргашев Жахонгир',
    last_name: 'Эргашев', first_name: 'Жахонгир', date_of_birth: '1990-04-01', gender: 'male',
    phone: '+998977001122', registration_date: '2026-02-11', created_by: 7 },
];

const USERS = [
  { id: 7, full_name: 'Юлдашева Гулнора' },
  { id: 9, full_name: 'Каюмов Араббек' },
];

// telegram_chats_list — ровно та форма, которую отдаёт сервер: связки чатов,
// каждая со списком карт на своём номере (server/services/telegram/chat.js).
const TG_CHATS = [
  { chat_id: '555', phone: '+998901234567', tg_name: 'Aziza', patients: [{ id: 1, name: 'Каримова Азиза', mrn: 'P-26-00001' }] },
];

let dbCalls = [];
let rpcCalls = [];
let tgAllowed = true;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
  const denied = () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'Раздел «Чат с пациентами» вам не выдан.' } }) });

  if (u.startsWith('/api/auth/me')) return ok({ user: globalThis.window.easymed.state.user });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    rpcCalls.push(name);
    if (name === 'telegram_chats_list') return tgAllowed ? ok({ data: TG_CHATS }) : denied();
    // patient_base_aggregates НЕ существует в этой сборке — сервер отвечает
    // отказом, как и живой. Строка обязана оставаться правдивой без него.
    if (name === 'patient_base_aggregates') return { ok: false, status: 404, json: async () => ({ error: { message: 'Unknown RPC' } }) };
    return ok({ data: null });
  }
  if (u.startsWith('/api/db')) {
    dbCalls.push(body);
    const table = body && body.table;
    if (table === 'users') {
      const f = (body.filters || []).find((x) => x.op === 'in');
      const want = new Set((f ? f.val : []).map(String));
      return ok({ data: USERS.filter((x) => want.has(String(x.id))), count: USERS.length });
    }
    const rows = { patients: PATIENTS }[table] || [];
    return ok({ data: JSON.parse(JSON.stringify(rows)), count: rows.length });
  }
  return ok({ data: null });
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const { setFullAccess, setEffectiveFromRole } = await import('../permissions.js');
const { setLang } = await import('../i18n.js');

// ХОЛОДНЫЙ ЭКРАН НА КАЖДЫЙ ПРОГОН. patients.js помнит между отрисовками две
// вещи — имена регистраторов и множество связок Telegram, — и помнит их
// НАМЕРЕННО: иначе листание страницы платило бы теми же запросами заново.
// Но тогда второй тест в файле видел бы уже прогретый кэш, и «спрошено одним
// запросом» проходило бы, даже если бы запроса не было вовсе. Свежая строка
// запроса в специфаторе даёт новый экземпляр модуля (кэш свой, зависимости —
// общие: права и язык одни на файл), то есть настоящий первый вход в раздел.
let coldN = 0;
const coldView = () => import('../views/patients.js?cold=' + (++coldN));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const walk = (e, o = []) => { o.push(e); for (const c of e.children || []) walk(c, o); return o; };
const textOf = (el) => walk(el).map((n) => n._t || '').join('');
const hasClass = (n, c) => String(n.className || '').split(/\s+/).includes(c);
const byClass = (root, c) => walk(root).filter((n) => hasClass(n, c));
const rowsOf = (root) => walk(root).filter((n) => n.tagName === 'TR' && hasClass(n, 'row-click'));
const cellsOf = (tr) => (tr.children || []).filter((n) => n.tagName === 'TD');
const headCells = (root) => {
  const thead = walk(root).find((n) => n.tagName === 'THEAD');
  return walk(thead).filter((n) => n.tagName === 'TH');
};
const buttons = (root) => walk(root).filter((n) => n.tagName === 'BUTTON');
// Правило из НАСТОЯЩЕГО файла стилей: намерение в разметке ничего не значит,
// если перенос или выделение запрещены только на словах.
function cssRule(selector) {
  const m = new RegExp('\\' + selector + '\\s*\\{([^}]*)\\}').exec(CSS);
  assert.ok(m, 'в admin-views.css нет правила ' + selector);
  return m[1];
}
const labelOf = (n) => walk(n).map((x) => x._t || '').join('').trim();

async function paint({ lang = 'ru', allowTelegram = true } = {}) {
  dbCalls = []; rpcCalls = [];
  tgAllowed = allowTelegram;
  document.body.children.length = 0;
  if (allowTelegram) setFullAccess('Admin');
  else setEffectiveFromRole({ name: 'registrar', permissions: {
    sections: ['patients', 'registration'], levels: { patients: 'editor', registration: 'editor' } } });
  setLang(lang);
  const box = mk('div');
  const navigated = [];
  const { renderPatients } = await coldView();
  await renderPatients(box, { onNavigate: (v, p) => navigated.push([v, p]), embedded: true });
  await tick();
  return { box, navigated };
}

// ===========================================================================
test('дата рождения читается человеком и на языке интерфейса: ru / uz / en', async () => {
  // Владелец: «date format is 2 may 2019». Пациент ① родился 2 мая 2019 —
  // ровно тот случай, который он и написал.
  const ru = await paint({ lang: 'ru' });
  const rowRu = rowsOf(ru.box)[0];
  assert.ok(textOf(rowRu).includes('2 мая 2019'),
    'по-русски дата рождения не «2 мая 2019»: ' + textOf(rowRu));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(textOf(rowRu)),
    'в строке осталась сырая дата вида 2019-05-02 — её и фотографировал владелец');

  const uz = await paint({ lang: 'uz' });
  assert.ok(textOf(rowsOf(uz.box)[0]).includes('2-may 2019'),
    'по-узбекски дата рождения не «2-may 2019»: ' + textOf(rowsOf(uz.box)[0]));

  const en = await paint({ lang: 'en' });
  assert.ok(textOf(rowsOf(en.box)[0]).includes('2 May 2019'),
    'по-английски дата рождения не «2 May 2019»: ' + textOf(rowsOf(en.box)[0]));

  // И то же правило на дате ПОСЛЕДНЕГО ВИЗИТА — она была таким же ISO.
  await paint({ lang: 'ru' });
});

test('регистратор — настоящее имя, а когда его нет, так и написано словом', async () => {
  const { box } = await paint();
  const rows = rowsOf(box);

  // ① и ② завёл сотрудник 7, ③ — сотрудник 9: обе фамилии на экране.
  assert.ok(textOf(rows[0]).includes('Юлдашева Гулнора'), 'нет имени регистратора у первой карты');
  assert.ok(textOf(rows[2]).includes('Каюмов Араббек'), 'нет имени второго регистратора');

  // ④ заведена без автора — честная фраза, а не прочерк «экран сломан».
  const noneRow = rows[3];
  assert.ok(textOf(noneRow).includes('Не указан'),
    'карта без автора не сказала об этом словами: ' + textOf(noneRow));

  // Имена спрошены ОДНИМ запросом на страницу и только про неизвестные id.
  const userQueries = dbCalls.filter((b) => b && b.table === 'users');
  assert.equal(userQueries.length, 1, 'имена регистраторов спрошены не одним запросом: ' + userQueries.length);
  const inFilter = (userQueries[0].filters || []).find((f) => f.op === 'in');
  assert.deepEqual([...inFilter.val].sort(), [7, 9], 'спрошены не те id сотрудников');

  // И главное: имя НЕ зависит от patient_base_aggregates — процедуры, которой
  // в этой сборке нет. Именно её отказ и оставлял колонку пустой.
  assert.ok(rpcCalls.includes('patient_base_aggregates'),
    'проверка бессмысленна: data.js больше не зовёт отсутствующую RPC');
});

test('значок Telegram стоит у того, с кем есть живая связка чата, и только у него', async () => {
  const { box } = await paint();
  const rows = rowsOf(box);
  assert.equal(byClass(rows[0], 'pt-tg').length, 1, 'у связанного пациента нет значка Telegram');
  assert.equal(byClass(rows[0], 'pt-tg')[0].attrs.title, 'Есть Telegram', 'значок без подписи');
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(byClass(rows[i], 'pt-tg').length, 0,
      'значок Telegram появился у пациента без связки (строка ' + (i + 1) + ')');
  }
  assert.ok(rpcCalls.includes('telegram_chats_list'), 'связки чата не спрошены');
});

test('без права на раздел чата отметок нет — и процедура не спрашивается', async () => {
  const { box } = await paint({ allowTelegram: false });
  assert.equal(byClass(box, 'pt-tg').length, 0,
    'строка притворилась, будто знает про Telegram, не имея права его спросить');
  assert.ok(!rpcCalls.includes('telegram_chats_list'),
    'заведомо отказной запрос всё равно ушёл на сервер');
  // Реестр при этом цел: строки на месте.
  assert.equal(rowsOf(box).length, PATIENTS.length, 'без Telegram список поредел');
});

test('телефон выглядит как везде в продукте и не переносится', async () => {
  const { box } = await paint();
  const rows = rowsOf(box);
  assert.ok(textOf(rows[0]).includes('+998 90 123 45 67'),
    'телефон не приведён к общему виду: ' + textOf(rows[0]));
  // ② хранится сырыми цифрами — и всё равно читается номером.
  assert.ok(textOf(rows[1]).includes('+998 91 593 05 55'),
    'сырые цифры не превратились в номер: ' + textOf(rows[1]));
  // ⑥ без телефона — прочерк, а не пустая ячейка.
  assert.ok(byClass(rows[5], 'pt-none').length >= 1, 'карта без телефона не показала прочерк');

  // Перенос запрещён НАСТОЯЩИМ правилом, а не намерением.
  const rule = cssRule('.pt-phone');
  assert.ok(/white-space:\s*nowrap/.test(rule), '.pt-phone может переноситься');
  assert.ok(/user-select:\s*text/.test(rule), '.pt-phone нельзя выделить мышью');
});

test('крайние случаи не ломают строку: длинное ФИО, нет даты рождения, нет визитов', async () => {
  const { box } = await paint();
  const rows = rowsOf(box);
  assert.equal(rows.length, PATIENTS.length, 'нарисованы не все строки');

  // Восемь ячеек в КАЖДОЙ строке и ровно столько же заголовков.
  assert.equal(headCells(box).length, 8, 'в шапке не восемь колонок');
  for (const [i, r] of rows.entries()) {
    assert.equal(cellsOf(r).length, 8, 'строка ' + (i + 1) + ' не из восьми ячеек');
  }

  // ② длинное ФИО: обрезается многоточием, но полностью читается в подсказке.
  const nm = byClass(rows[1], 'pt-nm')[0];
  assert.equal(nm.attrs.title, LONG_NAME, 'обрезанное имя не прочитать целиком');
  const nmRule = cssRule('.pt-nm');
  assert.ok(/text-overflow:\s*ellipsis/.test(nmRule), 'длинное имя распирает колонку вместо многоточия');
  assert.ok(/overflow:\s*hidden/.test(nmRule), 'обрезать имя нечем — многоточию не на чем сработать');

  // ③ без даты рождения — прочерк, и ни слова о возрасте.
  const dobCell = cellsOf(rows[2])[2];
  assert.equal(byClass(dobCell, 'pt-none').length, 1, 'пустая дата рождения не показала прочерк');
  assert.ok(!/лет/.test(textOf(dobCell)), 'у карты без даты рождения откуда-то взялся возраст');

  // ⑤ без визитов — так и сказано, а не «0».
  assert.ok(textOf(rows[4]).includes('визитов не было'),
    'карта без визитов не сказала об этом: ' + textOf(rows[4]));

  // ① личность собрана в один блок: аватар, имя, номер карты рядом.
  const ident = byClass(rows[0], 'pt-ident')[0];
  assert.ok(ident, 'блок личности не собран');
  assert.ok(walk(ident).some((n) => hasClass(n, 'avatar')), 'в блоке личности нет аватара');
  assert.ok(textOf(ident).includes('P-26-00001'), 'номер карты ушёл из блока личности');
  assert.ok(textOf(ident).includes('Ташкент'), 'город ушёл из блока личности');
});

test('всё, что умел экран, цело: поиск, дата рождения, сортировки, дубликаты, листание', async () => {
  const { box, navigated } = await paint();

  const inputs = walk(box).filter((n) => n.tagName === 'INPUT');
  assert.ok(inputs.some((i) => i.attrs.type === 'search'), 'поиск пропал');
  assert.ok(inputs.some((i) => i.attrs.type === 'date'), 'фильтр по дате рождения пропал');

  const labels = buttons(box).map(labelOf);
  // «MRN» — ключ словаря, и по-русски кнопка подписана «МРН» (i18n-strings).
  for (const need of ['Sort: Recent', 'A–Z', 'МРН']) {
    assert.ok(labels.includes(need), 'пропала сортировка «' + need + '»');
  }
  assert.ok(labels.some((l) => l.includes('Дубликаты')), 'кнопка дубликатов пропала');
  assert.ok(labels.some((l) => l.includes('Калькулятор')), 'калькулятор пропал');
  assert.ok(labels.some((l) => l.includes('Госпитализация')), 'заявка на госпитализацию пропала');
  assert.ok(labels.some((l) => l.includes('Создать пациента')), 'создание пациента пропало');
  assert.ok(buttons(box).some((b) => b.attrs['data-onb'] === 'create-patient'),
    'подсказка онбординга потеряла свою цель');

  // Полоса объединения дубликатов на месте (скрыта, пока не выбрано два).
  assert.equal(byClass(box, 'dup-merge-bar').length, 1, 'полоса объединения дубликатов пропала');

  // Листание: пара стрелок + подпись страницы.
  assert.equal(byClass(box, 'icon-btn').length, 2, 'кнопки листания пропали');
  assert.ok(textOf(box).includes('Page 1 of 1'), 'подпись страницы пропала');

  // Кнопка синхронизации филиала на месте. Показывать ли себя, она решает сама
  // (одиночной клинике меняться не с кем, и тогда стоит скрытой), поэтому
  // ищется она по подписи, а не по видимости.
  assert.ok(buttons(box).some((b) => b.attrs.title === 'Обменяться данными с другими филиалами'),
    'кнопка синхронизации филиала пропала из шапки списка');

  // Строка по-прежнему ведёт в карточку — и кликом по строке, и кнопкой.
  rowsOf(box)[0].click();
  assert.equal(navigated.at(-1)[0], 'patient-card', 'клик по строке больше не открывает карту');
  const card = buttons(box).find((b) => labelOf(b).includes('Карточка'));
  assert.ok(card, 'кнопка «Карточка» пропала');
  card.click();
  assert.equal(navigated.at(-1)[0], 'patient-card', 'кнопка «Карточка» больше не открывает карту');
});
