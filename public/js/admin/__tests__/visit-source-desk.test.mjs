// DIAG_ROUTE_V1 (D8; ревью полировки L-1, M-1) — «КТО НАПРАВИЛ» ВИЗИТА СПРАШИВАЕТ
// ТОЛЬКО ТА РОЛЬ, ЧЬЁ ЗНАЧЕНИЕ СЕРВЕР СОХРАНИТ.
//
// С 61679d07 сервер не читает направившего визита (ensure_visit / calendar_book
// referral_source_id) от врача и медсестры — его называют стойка и колл-центр
// (server/services/domain/line-referral.js VISIT_SOURCE_ROLES). А мастер записи в
// режиме стойки («Добавить услуги» карты пациента — врачу он открыт) по-прежнему
// показывал галочку «Пациент по направлению» и шаг «Направление», подтверждение
// называло партнёра, а визит молча сохранялся без него: партнёр терял процент со
// всего визита. Теперь экран спрашивает только тех, кому сервер поверит
// (permissions.js canNameVisitSource — зеркало сервера).
//
// Стенд — как у wizard-booking.test.mjs: настоящие миграции, реестр RPC и
// компилятор /api/db за фальшивым fetch. Синтетические данные.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM (тот же стенд, что у room-calendar.test.mjs) ─────────────
class F {
  constructor(t) {
    this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {};
    this.className = ''; this._t = ''; this._l = {}; this.dataset = {};
    this.value = ''; this.checked = false; this.disabled = false;
  }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  get firstChild() { return this.children[0] || null; }
  replaceChildren() { this.children.length = 0; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); }
  removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} select() {} scrollTo() {}
  contains() { return false; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 200, bottom: 60, width: 200, height: 60 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() {
    const s = this;
    return {
      contains: (c) => String(s.className).split(/\s+/).includes(c),
      add(c) { if (!String(s.className).split(/\s+/).includes(c)) s.className = (s.className + ' ' + c).trim(); },
      remove(c) { s.className = String(s.className).split(/\s+/).filter((x) => x && x !== c).join(' '); },
      toggle() {},
    };
  }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.Event = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };
// CRM_REAL_BOOKING_V1 — ТОСТЫ СЛЫШНЫ. toast() (ui.js) пишет текст в
// el.textContent и следующей строкой кладёт в el._t идентификатор таймера —
// затирая текст. Свой #toast записывает всё сказанное в журнал (тот же обход,
// что в services-catalog.test.mjs и crm-card.test.mjs).
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
// QUICK_PATIENT_V1 — каталог спрашивает перед уходом (confirmLeaveCatalog) ГОЛЫМ
// confirm(), как это делает браузер. В node его нет вовсе, и любая проверка,
// дошедшая до Escape с набранной сметой, падала бы на «confirm is not defined»
// — то есть по причине, к предмету проверки отношения не имеющей. Умолчание
// «да, закрывай»; проверке, которой важен сам вопрос, эту заглушку подменяют и
// возвращают обратно.
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

// ─── настоящая база + настоящий реестр RPC за фальшивым fetch ───────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');   // SERVICES_PACKAGES_V1
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { calendarSlots, calendarWindows } = await import('../../../../server/services/rpc/calendar.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
// CRM_REAL_BOOKING_V1 — подменить ОДИН ответ ensure_visit (перенос / занятый
// день) при настоящей базе за всем остальным; RPC — журнал вызовов.
let ENSURE_OVERRIDE = null;
const RPC = [];
const DB_INSERTS = [];   // REFERRAL_LINE_V1 (ревью полировки L-1) — что экран прислал во вставку /api/db (до штампов сервера)

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    if (name === 'ensure_visit' && ENSURE_OVERRIDE) return ok(ENSURE_OVERRIDE);
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    if (body && body.op === 'insert') DB_INSERTS.push(JSON.parse(JSON.stringify(body)));
    stampWriteBody(DB, body);   // SERVICES_PACKAGES_V1 — как настоящая дверь (routes/db.js): цена пакета на строке
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    // CRM_REAL_BOOKING_V1 — мастер визита, открытый как экран, ПИШЕТ: строки
    // услуг и правки. Вставка отдаётся так же, как настоящим маршрутом
    // (routes/db.js): строка перечитывается по rowid колонками реестра.
    try {
      if (meta.op === 'select') {
        const rows = DB.prepare(sql).all(...params);
        if (meta.single === 'single') return ok(rows[0]);
        if (meta.single === 'maybe') return ok(rows[0] ?? null);
        return ok(rows);
      }
      if (meta.op === 'insert') {
        const info = DB.prepare(sql).run(...params);
        if (!meta.returning) return ok(null);
        const row = DB.prepare(
          `SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`
        ).get(info.lastInsertRowid);
        if (meta.single === 'single') return ok(row);
        if (meta.single === 'maybe') return ok(row ?? null);
        return ok([row]);
      }
      DB.prepare(sql).run(...params);
      return ok(null);
    } catch (e) {
      return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: e.message } }) };
    }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

// Клиент слотов и записи — ТОТ ЖЕ модуль, который зовут оба мастера.
const SPM = await import('../views/service-picker-modal.js?v=ownrep4');   // тот же адрес, что у мастера (один экземпляр)
const { loadSlotDay, freeStartMinutes, calendarBookOrAsk, askEmergencyReason, forgetSlots, hhmmToMin } = SPM;

// ─── посев ──────────────────────────────────────────────────────────────────
// День берётся будущий рабочий: «сегодня» отсекает прошедшие слоты, и тест
// зависел бы от часа запуска.
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function nextWeekday(offset = 2) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * shape:'card'    — карточка сотрудника: {enabled, from, to, lunch…} (форма,
 *                   которой мастер визита НЕ ВИДЕЛ вовсе);
 * shape:'list'    — экран «Сотрудники»: {on, from, to};
 * lunch:true      — обеденный перерыв из карточки.
 */
function seed({ shape = 'card', from = '10:00', to = '16:00', lunch = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const day = nextWeekday();
  const wh = {};
  for (const k of WD) {
    wh[k] = shape === 'card'
      ? { enabled: true, from, to, lunchEnabled: lunch, lunchFrom: '12:00', lunchTo: '13:00' }
      : { on: true, from, to };
  }
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт',?)").run(JSON.stringify(wh));
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (4,'Сидорова Мария')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes) VALUES (21,'Консультация терапевта',100000,30)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
  return { db, day, dayIso: isoOf(day) };
}

const at = (day, hh, mm = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0).toISOString();
const countVisits = () => DB.prepare('SELECT COUNT(*) c FROM visits').get().c;



const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Мастер визита на пациента 3 с врачебной услугой 21, врач выбран, слот подобран. */
async function openWizardReady(opts = {}) {
  return openWizardReadyWith(null, opts);
}
async function openWizardReadyWith(prep, opts = {}) {
  const s = seed({ shape: 'card', from: '10:00', to: '16:00' });
  if (prep) prep(DB);
  DB.prepare('UPDATE services SET requires_doctor = 1 WHERE id = 21').run();
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  let saved = 0;
  await openVisitWizard(() => { saved++; }, { id: 3, full_name: 'Иванов Иван' }, { presetServiceIds: [21], ...opts });
  await flush(20);
  const overlay = document.body.children.find(isWizard);
  assert.ok(overlay, 'мастер визита не открылся');

  // Врач — тем же полем, что и человек: фокус → список → выбор.
  const docInp = walk(overlay).find((n) => n.tagName === 'INPUT' && n.getAttribute('placeholder') === 'Врач — поиск…');
  assert.ok(docInp, 'в строке сметы нет поля выбора врача');
  docInp.dispatchEvent({ type: 'focus' });
  const docList = docInp.parentElement.children.find((n) => n !== docInp);
  const item = docList && docList.children.find((n) => textOf(n).includes('Петров'));
  assert.ok(item, 'врач не предложен строке: ' + (docList ? textOf(docList) : '—'));
  item.dispatchEvent({ type: 'mousedown', preventDefault() {}, currentTarget: item });
  await wait(60); await flush(20);   // autoPickSlot → calendar_slots (настоящий) → время строки
  // PICK_DAY_V1 — время ставится само только СЕГОДНЯ. Врач посева работает
  // 10:00–16:00: вечером сегодня окон нет, и строка ждёт выбора дня — стенд
  // жмёт «Ближайшее», как регистратор (иначе тест зависел бы от часа запуска).
  const near = walk(document.body.children.find(isWizard)).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-pick-nearest'] !== undefined);
  if (near) { near.click(); await flush(20); }
  return { overlay: () => document.body.children.find(isWizard), day: s.day, dayIso: s.dayIso, saved: () => saved };
}

/** Кнопка сметы «Далее / Сформировать счёт» — нажимать, пока не дошли до записи. */
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = document.body.children.find(isWizard);
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON')
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit')) break;
  }
  await wait(80); await flush(30);
}

const { reshape } = await import('../../../../server/routes/db.js');
async function asRole(role, id, fn) {
  const perms = await import('../permissions.js');
  const was = { id: USER.id, role: USER.role };
  const openWas = window.open;
  const fetchWas = globalThis.fetch;
  const opened = { n: 0 };
  window.open = () => { opened.n++; return { document: { open() {}, write() {}, close() {} }, focus() {}, print() {}, close() {} }; };
  globalThis.fetch = async (url, opts) => {
    const res = await fetchWas(url, opts);
    if (String(url) !== '/api/db' || !res.ok) return res;
    let meta;
    try { meta = compile(JSON.parse((opts && opts.body) || '{}'), USER).meta; } catch { return res; }
    if (meta.op !== 'select' || !meta.embeds || !meta.embeds.length) return res;
    const json = await res.json();
    const rows = Array.isArray(json.data) ? json.data : (json.data ? [json.data] : []);
    reshape(rows, meta);
    return { ok: true, status: res.status, json: async () => json };
  };
  window.easymed = { state: { user: { id, role, extra_roles: [] } } };
  perms.setActorRoles([role]);
  Object.assign(USER, { id, role });
  try { await fn(opened); }
  finally {
    Object.assign(USER, was);
    window.open = openWas;
    globalThis.fetch = fetchWas;
    delete window.easymed;
    perms.setActorRoles([]);
  }
}

// Врач открывает мастер в режиме стойки из карты пациента: «Добавить услуги» —
// tabEdit('services') && canAddVisitLines() (VISIT_LINE_ROLES включает врача).
// У стенда DOM нет select.options — searchableSelect читает его.
if (!Object.getOwnPropertyDescriptor(F.prototype, 'options')) Object.defineProperty(F.prototype, 'options', { get() { return this.children.filter((c) => c.tagName === 'OPTION'); } });
const partner = (db) => {
  const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 5)").run().lastInsertRowid;
  db.prepare("INSERT INTO referral_sources (id, name, category_id) VALUES (900, 'Клиника Б', ?)").run(cat);
  return cat;
};
let PCAT = null;
const selByFirst = (ov, first) => walk(ov).find((n) => n.tagName === 'SELECT' && n.children[0] && textOf(n.children[0]).trim().startsWith(first));

async function tickAndPickPartner() {
  let ov = document.body.children.find(isWizard);
  const label = walk(ov).find((n) => n.tagName === 'LABEL' && textOf(n).includes('Пациент по направлению'));
  assert.ok(label, '«Пациент по направлению» not shown');
  const chk = walk(label).find((n) => n.tagName === 'INPUT');
  chk.checked = true; chk.dispatchEvent({ type: 'change', target: chk, currentTarget: chk });
  await flush(20);
  // go to step 2
  for (let i = 0; i < 4; i++) {
    ov = document.body.children.find(isWizard);
    if (selByFirst(ov, '— Без направления —')) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON').find((n) => /^\s*Далее/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click(); await wait(40); await flush(20);
  }
  ov = document.body.children.find(isWizard);
  const cat = selByFirst(ov, '— Без направления —');
  assert.ok(cat, 'step «Направление» not reached: ' + textOf(ov).slice(0, 300));
  cat.value = String(PCAT); cat.dispatchEvent({ type: 'change', target: cat, currentTarget: cat });
  await flush(20);
  ov = document.body.children.find(isWizard);
  const src = selByFirst(ov, '— Выберите, кто направил —');
  assert.ok(src, '«Кто направил» select not shown');
  src.value = '900'; src.dispatchEvent({ type: 'change', target: src, currentTarget: src });
  await flush(20);
  // walk to the confirmation and read it
  let confirmText = '';
  for (let i = 0; i < 5; i++) {
    ov = document.body.children.find(isWizard);
    const t = textOf(ov);
    if (/Источник направления/.test(t) && /Подтверждение/.test(t) && !selByFirst(ov, '— Без направления —')) { confirmText = t; break; }
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON').find((n) => /^\s*Далее/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) { confirmText = t; break; }
    btn.click(); await wait(40); await flush(20);
  }
  return confirmText;
}

test('зеркало: VISIT_SOURCE_ROLES экрана — те же, что у сервера (line-referral.js)', async () => {
  const perms = await import('../permissions.js');
  const server = await import('../../../../server/services/domain/line-referral.js');
  assert.deepEqual([...perms.VISIT_SOURCE_ROLES].sort(), [...server.VISIT_SOURCE_ROLES].sort());
  const roleSets = [['doctor'], ['nurse'], ['head_doctor'], ['admin'], ['registrar'], ['callcenter'], ['doctor', 'registrar']];
  for (const roles of roleSets) {
    perms.setActorRoles(roles);
    assert.equal(perms.canNameVisitSource(), server.canNameVisitSource({ role: roles[0], extra_roles: roles.slice(1) }), roles.join('+'));
  }
  perms.setActorRoles([]);
});

test('врач, мастер записи в режиме стойки: нет «Пациент по направлению», шага «Направление» и источника в подтверждении; ensure_visit — без источника', async () => {
  await asRole('doctor', 7, async () => {
    const w = await openWizardReadyWith((db) => { PCAT = partner(db); });
    const t = textOf(w.overlay());
    assert.ok(!t.includes('Пациент по направлению'), 'врачу показана галочка «Пациент по направлению»');
    assert.ok(!selByFirst(w.overlay(), '— Без направления —'), 'врачу показан шаг «Направление»');
    await pressUntilCreate();
    const ev = RPC.find((c) => c.name === 'ensure_visit');
    assert.ok(ev, 'мастер не дошёл до ensure_visit');
    assert.equal(ev.body.referral_source_id, null, 'врач прислал направившего визита');
    assert.ok(!TOASTS.some((x) => /Источник направления/.test(x)));
  });
});

test('регистратура — те же щелчки: галочка, шаг, партнёр в подтверждении, визит сохранён С ним (стойка не тронута)', async () => {
  await asRole('registrar', 1, async () => {
    await openWizardReadyWith((db) => { PCAT = partner(db); });
    const confirmText = await tickAndPickPartner();
    assert.match(confirmText.replace(/\s+/g, ' '), /Источник направления\s+Клиника Б/);
    await pressUntilCreate();
    const ev = RPC.find((c) => c.name === 'ensure_visit');
    assert.ok(ev, 'мастер не дошёл до ensure_visit');
    assert.equal(ev.body.referral_source_id, 900);
    const v = DB.prepare('SELECT referral_source_id FROM visits WHERE patient_id = 3 ORDER BY id DESC LIMIT 1').get();
    assert.equal(v.referral_source_id, 900);
  });
});

test('врач с дополнительной ролью регистратуры — стойка: галочка есть', async () => {
  const perms = await import('../permissions.js');
  await asRole('doctor', 7, async () => {
    perms.setActorRoles(['doctor', 'registrar']);
    const w = await openWizardReadyWith((db) => { PCAT = partner(db); });
    assert.ok(textOf(w.overlay()).includes('Пациент по направлению'));
  });
});

test('врач, мастер направления («Направить на услуги»): галочки нет, ensure_visit без источника — как было', async () => {
  await asRole('doctor', 7, async () => {
    const w = await openWizardReadyWith((db) => { PCAT = partner(db); }, { referrerDoctorId: 7 });
    assert.ok(!textOf(w.overlay()).includes('Пациент по направлению'));
    await pressUntilCreate();
    const ev = RPC.find((c) => c.name === 'ensure_visit');
    assert.ok(ev);
    assert.equal(ev.body.referral_source_id, null);
  });
});
