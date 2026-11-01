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
//   * ВСЁ, ЧТО УМЕЛ ЭКРАН, цело: поиск, три сортировки, дубликаты с полосой
//     объединения, листание, кнопка синхронизации филиала, калькулятор и
//     создание пациента.
//
// FAST_REGISTRATION_V1 (2026-09-19) — владелец: «in the registrators window
// there is search by date of birth. we dont need that. actually create a
// pulsating button "fast registration"». Поле даты рождения ушло из шапки
// НАСОВСЕМ, а на его месте стоит одна пульсирующая кнопка, открывающая то же
// окно заведения пациента в быстром режиме: пациент → услуги и врач → счёт →
// печать. Проверяется здесь же — это та же шапка того же экрана.

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
let botConnected = true;   // PATIENT_BOT_INVITE_V1

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
    // PATIENT_BOT_INVITE_V1 — кто подключён к боту: id первой карты (Каримова,
    // её номер в TG_CHATS). botConnected = false — у клиники бота нет.
    if (name === 'patient_bot_status') return ok({ data: { bot: botConnected, sms_ready: false, linked: botConnected ? [1] : [] } });
    if (name === 'patient_bot_invite') return ok({ data: { ok: false, sms: false, link: 'https://t.me/clinic_bot' } });
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

async function paint({ lang = 'ru', allowTelegram = true, bot = true } = {}) {
  dbCalls = []; rpcCalls = [];
  tgAllowed = allowTelegram;
  botConnected = bot;
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

// PATIENT_BOT_INVITE_V1 (2026-11-01) — значок Telegram у имени (PATIENT_ROW_V2)
// переехал в ПОСЛЕДНЮЮ колонку: подключён к боту — логотип, нет — «Ссылка на бот».
// Источник — patient_bot_status (а не telegram_chats_list, закрытый правом чата).
const lastCell = (row) => row.children[row.children.length - 1];

test('конец строки: у подключённого к боту — логотип Telegram, у остальных — «Ссылка на бот»', async () => {
  const { box } = await paint();
  await tick();
  const rows = rowsOf(box);
  assert.equal(byClass(lastCell(rows[0]), 'pt-tg').length, 1, 'у подключённого пациента нет логотипа Telegram');
  assert.equal(byClass(lastCell(rows[0]), 'pt-bot-invite').length, 0, 'подключённому предлагают ссылку');
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(byClass(rows[i], 'pt-tg').length, 0, 'логотип у пациента без бота (строка ' + (i + 1) + ')');
    assert.equal(byClass(lastCell(rows[i]), 'pt-bot-invite').length, 1, 'нет «Ссылки на бот» в конце строки ' + (i + 1));
  }
  assert.ok(rpcCalls.includes('patient_bot_status'), 'статус бота не спрошен');
  assert.ok(!rpcCalls.includes('telegram_chats_list'), 'список чатов больше не нужен строке');
  // Значка у имени больше нет — он один, в конце строки.
  assert.equal(byClass(rows[0], 'pt-tg').length, 1, 'значок Telegram задвоился (у имени и в конце)');

  const btn = byClass(lastCell(rows[1]), 'pt-bot-invite')[0];
  btn.click();
  await tick();
  assert.ok(rpcCalls.includes('patient_bot_invite'), '«Ссылка на бот» не зовёт отправку');
});

test('регистратор без права на чат тоже видит, кто в боте; без бота у клиники колонка пуста', async () => {
  const { box } = await paint({ allowTelegram: false });
  await tick();
  assert.equal(byClass(box, 'pt-tg').length, 1, 'регистратору не видно, кто подключён к боту');
  assert.ok(!rpcCalls.includes('telegram_chats_list'), 'заведомо отказной запрос чатов ушёл на сервер');
  assert.equal(rowsOf(box).length, PATIENTS.length, 'список поредел');

  const { box: box2 } = await paint({ bot: false });
  await tick();
  // Бот не подключён: логотипов нет, а кнопка видна, но неактивна и объясняет
  // почему (пустая колонка читалась как поломка — владелец её не нашёл).
  assert.equal(byClass(box2, 'pt-tg').length, 0, 'логотип Telegram без бота у клиники');
  const idle = byClass(box2, 'pt-bot-invite');
  assert.equal(idle.length, PATIENTS.length, 'без бота кнопки «Ссылка на бот» не видно');
  assert.ok(idle.every((b) => 'disabled' in b.attrs || b.disabled), 'без бота кнопка нажимается');
  assert.match(String(idle[0].attrs.title || ''), /не подключён/, 'кнопка не говорит, почему неактивна');
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

  // Десять ячеек в КАЖДОЙ строке и ровно столько же заголовков
  // (REG_LIST_AGE_COL_V1 — возраст; PATIENT_BOT_INVITE_V1 — бот пациента в конце).
  assert.equal(headCells(box).length, 10, 'в шапке не десять колонок');
  for (const [i, r] of rows.entries()) {
    assert.equal(cellsOf(r).length, 10, 'строка ' + (i + 1) + ' не из десяти ячеек');
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
  assert.ok(!/лет/.test(textOf(cellsOf(rows[2])[3])), 'в колонке «Возраст» возраст без даты рождения');
  // REG_LIST_AGE_COL_V1 — возраст стоит в своей колонке, а не под датой.
  assert.ok(/лет/.test(textOf(cellsOf(rows[0])[3])), 'колонка «Возраст» пуста у карты с датой рождения');
  assert.ok(!/лет/.test(textOf(cellsOf(rows[0])[2])), 'возраст остался под датой рождения');

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

test('всё, что умел экран, цело: поиск, сортировки, дубликаты, листание', async () => {
  const { box, navigated } = await paint();

  const inputs = walk(box).filter((n) => n.tagName === 'INPUT');
  assert.ok(inputs.some((i) => i.attrs.type === 'search'), 'поиск пропал');
  // FAST_REGISTRATION_V1 — поля даты рождения в шапке БОЛЬШЕ НЕТ: владелец
  // сказал «we dont need that», и место занято быстрой регистрацией. Тёзок
  // по-прежнему различают в самой строке реестра — дата рождения стоит в ней
  // отдельной колонкой.
  // PATIENT_SEARCH_DOB_V2 (2026-10-31) — владелец вернул поиск по дате
  // рождения: «search and search by date of birth».
  assert.ok(inputs.some((i) => i.attrs.type === 'date' && 'data-dob-search' in i.attrs),
    'поиска по дате рождения нет в шапке списка');

  const labels = buttons(box).map(labelOf);
  // «MRN» — ключ словаря, и по-русски кнопка подписана «МРН» (i18n-strings).
  for (const need of ['Сначала новые', 'A–Z', 'МРН']) {
    assert.ok(labels.includes(need), 'пропала сортировка «' + need + '»');
  }
  assert.ok(labels.some((l) => l.includes('Дубликаты')), 'кнопка дубликатов пропала');
  assert.ok(labels.some((l) => l.includes('Калькулятор')), 'калькулятор пропал');
  assert.ok(labels.some((l) => l.includes('Госпитализация')), 'заявка на госпитализацию пропала');
  assert.ok(labels.some((l) => l.includes('Создать пациента')), 'создание пациента пропало');
  assert.ok(labels.some((l) => l.includes('Быстрая регистрация')), 'быстрая регистрация пропала');
  assert.ok(buttons(box).some((b) => b.attrs['data-onb'] === 'create-patient'),
    'подсказка онбординга потеряла свою цель');

  // Полоса объединения дубликатов на месте (скрыта, пока не выбрано два).
  assert.equal(byClass(box, 'dup-merge-bar').length, 1, 'полоса объединения дубликатов пропала');

  // Листание: пара стрелок + подпись страницы.
  assert.equal(byClass(box, 'icon-btn').length, 2, 'кнопки листания пропали');
  assert.ok(textOf(box).includes('Страница 1 из 1'), 'подпись страницы пропала');

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

// ===========================================================================
// FAST_REGISTRATION_V1 — пульсирующая кнопка вместо поиска по дате рождения
// ===========================================================================
test('FAST_REGISTRATION_V1: на месте поиска по дате рождения — ОДНА пульсирующая кнопка, и она открывает быструю регистрацию', async () => {
  const { box } = await paint();

  const btn = buttons(box).find((b) => labelOf(b).includes('Быстрая регистрация'));
  assert.ok(btn, 'кнопки «Быстрая регистрация» нет в шапке списка');
  assert.ok(hasClass(btn, 'btn-primary'),
    'быстрая регистрация — главное действие регистратуры, а нарисована не первичной кнопкой: ' + btn.className);
  assert.ok(hasClass(btn, 'btn-pulse'), 'кнопка не пульсирует: ' + btn.className);
  assert.equal(btn.attrs['data-onb'], 'fast-registration', 'кнопка потеряла свою метку');

  // REG_LIST_HEAD_V3 (2026-10-31, владелец: «put the button on one line and
  // search place belove them separately») — кнопка в ряду кнопок, ПЕРЕД
  // сортировкой; поиск и поиск по дате рождения — ниже, отдельным рядом.
  const order = walk(box);
  const iSearch = order.findIndex((n) => n.tagName === 'INPUT' && n.attrs.type === 'search');
  const iSort   = order.findIndex((n) => hasClass(n, 'segmented'));
  const iBtn    = order.indexOf(btn);
  assert.ok(iSearch > -1 && iSort > -1, 'шапка списка потеряла поиск или сортировку — сравнивать не с чем');
  assert.ok(iBtn < iSort && iSort < iSearch,
    'ряды шапки не в том порядке (кнопка ' + iBtn + ', сортировка ' + iSort + ', поиск ' + iSearch + ')');

  // Пульс — НАСТОЯЩЕЕ правило файла стилей, а не класс без объявления.
  const rule = cssRule('.btn-pulse');
  assert.ok(/animation:\s*em-btn-pulse/.test(rule), '.btn-pulse ничем не пульсирует: ' + rule);

  // И пульсирует на экране ровно одна вещь: два пульсирующих пятна отменяют
  // друг друга (домашнее правило в admin-views.css).
  assert.equal(byClass(box, 'btn-pulse').length, 1,
    'на экране больше одного пульсирующего элемента: ' + byClass(box, 'btn-pulse').length);

  // FAST_REG_ONE_SCREEN_V1 — клик открывает ОДНО окно быстрой регистрации
  // (views/fast-registration.js): и реквизиты пациента, и таблица услуг в нём
  // же. Раньше открывалось окно заведения «в быстром режиме», а услуги ждали во
  // ВТОРОМ окне — и закрытое второе окно оставляло пациента без визита и счёта.
  // Окно грузится динамическим импортом, поэтому его ждут, а не читают сразу.
  document.body.children.length = 0;
  btn.click();
  await tick(80);
  const dlg = walk(document.body).find((n) => n.attrs['data-dialog'] === 'fast-registration');
  assert.ok(dlg, 'кнопка не открыла окно быстрой регистрации');
  const inside = textOf(dlg).replace(/\s+/g, ' ');
  assert.ok(inside.includes('Быстрая регистрация'), 'окно не назвалось быстрой регистрацией');
  // Реквизиты пациента — тот же сборщик полей, что и в окне заведения, только
  // компактной раскладкой (FAST_REG_COMPACT_V1): один раздел по образцу.
  assert.ok(inside.includes('Реквизиты пациента'), 'в окне нет реквизитов пациента: ' + inside.slice(0, 200));
  assert.ok(inside.includes('Услуги'), 'в окне нет таблицы услуг: ' + inside.slice(0, 200));
  // И второго окна не открылось: окно заведения пациента тут больше ни при чём.
  assert.ok(!walk(document.body).some((n) => n.attrs['data-dialog'] === 'patient-create'),
    'быстрая регистрация всё ещё открывает окно заведения пациента');
});

// ===========================================================================
// DEBT_FLOW_V1 — «yes mark as a debt»: долг стоит у имени в реестре.
// ===========================================================================
test('DEBT_FLOW_V1: у должника красная метка «Долг» с суммой, у остальных её нет; долг спрашивается одним запросом на страницу', async () => {
  const prevFetch = globalThis.fetch;
  let invoiceQueries = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (String(url).startsWith('/api/db') && body && body.table === 'invoices') {
      invoiceQueries++;
      const st = (body.filters || []).find((x) => x.col === 'status' || x.column === 'status' || x.field === 'status');
      assert.ok(!st || String(st.val ?? st.value) === 'debt', 'спрашивать надо только счета-долги: ' + JSON.stringify(body.filters));
      return { ok: true, status: 200, json: async () => ({ data: [
        { patient_id: 1, total_amount: 400000, paid_amount: 100000 },
        { patient_id: 1, total_amount: 50000,  paid_amount: 0 },
      ], count: 2 }) };
    }
    return prevFetch(url, opts);
  };
  try {
    const { box } = await paint({ lang: 'ru' });
    const rows = rowsOf(box);
    const debtor = rows.find((r) => textOf(r).includes('Каримова'));
    assert.ok(debtor, 'строка должницы не найдена');
    const tag = byClass(debtor, 'pt-debt')[0];
    assert.ok(tag, 'у должницы нет метки «Долг»');
    assert.ok(hasClass(tag, 'tag-crit'), 'метка долга обязана быть красной (tag-crit), а не жёлтой');
    assert.ok(textOf(tag).includes('Долг'), 'метка без слова «Долг»: ' + textOf(tag));
    assert.ok(textOf(tag).replace(/\s/g, '').includes('350000'), 'сумма долга = остаток по счетам (350 000): ' + textOf(tag));
    for (const r of rows) if (r !== debtor) assert.equal(byClass(r, 'pt-debt').length, 0, 'метка долга у того, кто не должен: ' + textOf(r).slice(0, 60));
    assert.equal(invoiceQueries, 1, 'долги спрашиваются одним запросом на страницу, а не по строке');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// PATIENT_SEARCH_DOB_V2 — поле даты рождения НАСТОЯЩЕЕ: выбранная дата уходит
// в запрос списка фильтром date_of_birth, очистка снимает фильтр.
test('поиск по дате рождения фильтрует список точной датой', async () => {
  const { box } = await paint();
  const dobInp = walk(box).find((n) => n.tagName === 'INPUT' && 'data-dob-search' in n.attrs);
  assert.ok(dobInp, 'поля даты рождения нет');
  const patientsCalls = () => dbCalls.filter((b) => b && b.table === 'patients' && JSON.stringify(b).includes('registration_date'));
  dobInp.value = '1990-04-11';
  dobInp.dispatchEvent({ type: 'change', currentTarget: dobInp, target: dobInp });
  await tick();
  const last = JSON.stringify(patientsCalls().at(-1) || {});
  assert.ok(last.includes('date_of_birth') && last.includes('1990-04-11'), 'дата рождения не ушла в запрос: ' + last);
  dobInp.value = '';
  dobInp.dispatchEvent({ type: 'change', currentTarget: dobInp, target: dobInp });
  await tick();
  assert.ok(!JSON.stringify(patientsCalls().at(-1) || {}).includes('1990-04-11'), 'очистка не сняла фильтр');
});
