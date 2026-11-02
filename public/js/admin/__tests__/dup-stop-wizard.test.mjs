// DUP_STOP_V1 (2026-11-02) — мастер визита и повтор услуги в визите дня.
//   • каталог гасит уже назначенное («уже назначено»), смета его не берёт;
//   • услуга, назначенная в визите, пока смета собиралась (второй регистратор, врач), —
//     отказ ДО ensure_visit: ни визита, ни строки, ни счёта;
//   • администратор называет причину — строка уходит с __repeat_reason, повтор записан.
// Стенд — тот же, что у server/routes/crm-one-way-r2-m2-wizard.test.js (фальшивый DOM,
// настоящая SQLite и реестр RPC за фальшивым fetch). Дверь /api/db здесь — compile() с тем
// же снятием __repeat_reason, что у routes/db.js; отказ сервера проверяют
// server/routes/dup-stop-db.test.js и server/services/rpc/dup-stop-rpc.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  focus() {} blur() {} select() {} scrollTo() {} scrollIntoView() {}
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
globalThis.confirm = () => true;

function walk(e, o = []) { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; }
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join(' ');

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { stampWriteBody } = await import('../../../../server/services/domain/package-lines.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { takeRepeatReason } = await import('../../../../server/services/domain/dup-order.js');
const { forgetSlots } = await import('../views/service-picker-modal.js');

let USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
const RPC = [];
const WRITES = [];   // тела вставок /api/db ДО снятия __repeat_reason

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params, template: e.template } }) }; }
  }
  if (u === '/api/db') {
    if (body.op === 'insert') WRITES.push(JSON.parse(JSON.stringify(body)));
    takeRepeatReason(body);   // как routes/db.js: причина повтора — не колонка
    stampWriteBody(DB, body);
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
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
        const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
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

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (1,'reg','x','Регистратор','registrar',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, working_hours) VALUES (2,'boss','x','Админ','admin',0,'')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (7,'doc','x','Петров Пётр','doctor',1,'терапевт')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (22,'Анализ крови',40000,'lab',1,0)").run();
  db.prepare("INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (23,'Анализ мочи',30000,'lab',1,0)").run();
  if (DB) DB.close();
  DB = db;
  forgetSlots();
}
/** Визит пациента сегодня («Пришёл») со строкой анализа крови, выставленной врачом. */
function orderedToday() {
  const now = new Date(); now.setHours(0, 30, 0, 0);
  const vid = Number(DB.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (3, 7, ?, 'arrived', 7)").run(now.toISOString()).lastInsertRowid);
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, 22, 1, 40000, 40000, 'queued', 7)").run(vid);
  return vid;
}

const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = (svc) => DB.prepare("SELECT COUNT(*) n FROM visit_services WHERE service_id = ? AND status <> 'cancelled'").get(svc).n;
const rowOf = (ov, id) => walk(ov).find((n) => n.dataset && n.dataset.svcRow === String(id));
const addBtn = (row) => walk(row).find((n) => n.tagName === 'BUTTON' && /Добавить/.test(textOf(n)));
async function open() {
  document.body.children.length = 0;
  TOASTS.length = 0; RPC.length = 0; WRITES.length = 0;
  const { openVisitWizard } = await import('../views/visit-wizard.js');
  await openVisitWizard(() => {}, { id: 3, full_name: 'Иванов Иван' }, {});
  await flush(30);
  return document.body.children.find(isWizard);
}
async function pressUntilCreate() {
  for (let i = 0; i < 6; i++) {
    const ov = document.body.children.find(isWizard);
    if (!ov) break;
    const btn = walk(ov).filter((n) => n.tagName === 'BUTTON')
      .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim()));
    if (!btn) break;
    btn.click();
    await wait(60); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit') || TOASTS.some((t) => /уже назначена в этом визите/.test(t))) break;
  }
  await wait(80); await flush(30);
}

test('DUP_STOP_V1: мастер — анализ, уже назначенный в визите дня, погашен «уже назначено», в смету не берётся', async () => {
  seed();
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  orderedToday();
  const ov = await open();
  assert.ok(ov, 'мастер не открылся');
  assert.ok(RPC.some((c) => c.name === 'visit_dup_check'), 'мастер не спросил, что уже назначено');
  const row = rowOf(ov, 22);
  assert.ok(row, 'строки каталога «Анализ крови» нет');
  assert.match(textOf(row), /уже назначено/);
  assert.ok('disabled' in addBtn(row).attrs, '«Добавить» у назначенной услуги нажимается');
  assert.ok(!/уже назначено/.test(textOf(rowOf(ov, 23))), 'новая услуга погашена');
});

test('DUP_STOP_V1: мастер — услугу назначили, пока смета собиралась: отказ до ensure_visit, ничего не записано', async () => {
  seed();
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  const ov = await open();
  addBtn(rowOf(ov, 22)).click();
  await flush(20);
  orderedToday();   // второй регистратор успел первым
  const visitsBefore = DB.prepare('SELECT COUNT(*) n FROM visits').get().n;
  await pressUntilCreate();
  assert.ok(TOASTS.some((t) => /^Эта услуга уже назначена в этом визите: «Анализ крови» — Петров Пётр/.test(t)), 'нет отказа словами сервера: ' + JSON.stringify(TOASTS));
  assert.equal(RPC.some((c) => c.name === 'ensure_visit'), false, 'визит дня заведён до отказа');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visits').get().n, visitsBefore, 'появился визит');
  assert.equal(lines(22), 1, 'вторая строка анализа');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0, 'счёт выставлен');
});

test('DUP_STOP_V1: мастер — администратор назначает повтор с причиной: строка уходит с __repeat_reason', async () => {
  seed();
  USER = { id: 2, role: 'admin', extra_roles: [] };
  try {
    orderedToday();
    const ov = await open();
    const row = rowOf(ov, 22);
    assert.match(textOf(row), /уже назначено/, 'администратору тоже видно, что услуга уже есть');
    assert.ok(!('disabled' in addBtn(row).attrs), 'администратору «Добавить» доступно');
    addBtn(row).click();
    await flush(20);
    const run = pressUntilCreate();
    let modal = null;
    for (let i = 0; i < 100 && !modal; i++) {
      await wait(20);
      modal = document.body.children.find((n) => walk(n).some((x) => x.dataset && 'repeatConfirm' in x.dataset));
    }
    assert.ok(modal, 'окно причины не открылось: ' + JSON.stringify(TOASTS));
    walk(modal).find((n) => n.tagName === 'TEXTAREA').value = 'контрольный анализ';
    walk(modal).find((n) => n.dataset && 'repeatConfirm' in n.dataset).click();
    await run;
    await wait(100); await flush(30);
    const ins = WRITES.filter((w) => w.table === 'visit_services');
    assert.equal(ins.length, 1, JSON.stringify(TOASTS));
    assert.equal(ins[0].values.__repeat_reason, 'контрольный анализ');
    assert.equal(lines(22), 2);
  } finally { USER = { id: 1, role: 'registrar', extra_roles: [] }; }
});
