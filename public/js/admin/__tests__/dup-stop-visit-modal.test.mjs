// DUP_STOP_V1 (ревью M3) — окно визита «Добавить услуги к визиту» (visit-modal.js) и повтор
// услуги в визите. Окно гасило в каталоге ВСЕ строки визита и отказывало сравнением со
// своим списком: отменённая строка, строка, возвращённая «Вернуть услугу», и процедура
// мешали назначить ту же услугу снова (раздел К1 спецификации), а обхода с причиной у
// администратора не было. Теперь правило — сервера (visit_dup_check): каталог гасит
// назначенное (attachExcludeIds), строка проверяется до записи (precheckOrders), причина
// администратора уходит в строку (__repeat_reason).
// Стенд — как у dup-stop-wizard.test.mjs: фальшивый DOM, настоящая SQLite и реестр RPC за
// фальшивым fetch; дверь /api/db — compile() с тем же снятием причины и той же проверкой
// повтора (checkOrders), что у routes/db.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, innerWidth: 1440, innerHeight: 900, addEventListener() {}, open: () => null, CLINIC: {}, easymed: { state: { user: null } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.confirm = () => true;

const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { takeRepeatReason, checkOrders, logRepeatOrders, DUP_CODE } = await import('../../../../server/services/domain/dup-order.js');

let USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
const WRITES = [];   // тела вставок /api/db ДО снятия __repeat_reason

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented' } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params, template: e.template } }) }; }
  }
  if (u === '/api/db') {
    if (body.op === 'insert') WRITES.push(JSON.parse(JSON.stringify(body)));
    const reason = takeRepeatReason(body);   // как routes/db.js: причина повтора — не колонка
    let orders = {};
    if (body.table === 'visit_services' && body.op === 'insert') {   // как routes/db.js visitOrderCheck
      orders = checkOrders(DB, Array.isArray(body.values) ? body.values : [body.values], { user: USER, reason });
      if (orders.error) return { ok: false, status: 409, json: async () => ({ error: { code: DUP_CODE, message: orders.error.message, template: orders.error.template, params: orders.error.params } }) };
    }
    let compiled;
    try { compiled = compile(body, USER, { db: DB }); }
    catch (e) { return { ok: false, status: 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
    const { sql, params, meta } = compiled;
    if (meta.op === 'select') {
      const rows = DB.prepare(sql).all(...params);
      if (meta.single === 'single') return ok(rows[0]);
      if (meta.single === 'maybe') return ok(rows[0] ?? null);
      return ok(rows);
    }
    const info = DB.prepare(sql).run(...params);
    if (meta.op === 'insert') logRepeatOrders(DB, orders, USER);
    if (meta.op === 'insert' && meta.returning) {
      const row = DB.prepare(`SELECT ${readableColumns(meta.table).map((c) => `"${c}"`).join(', ')} FROM "${meta.table}" WHERE rowid = ?`).get(info.lastInsertRowid);
      return ok(meta.single ? row : [row]);
    }
    return ok(null);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const VM = await import('../views/visit-modal.js');

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (2,'boss','x','Админ','admin',0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7,'doc','x','Петров Пётр','doctor',1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Иванов Иван')").run();
  const s = db.prepare('INSERT INTO services (id, name, price, type, is_lab, requires_doctor) VALUES (?,?,?,?,?,0)');
  s.run(22, 'Анализ крови', 40000, 'lab', 1);
  s.run(23, 'УЗИ', 80000, 'imaging', 0);
  s.run(24, 'Капельница', 30000, 'procedure', 0);
  const now = new Date(); now.setHours(9, 0, 0, 0);
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, doctor_id, visit_date, status, created_by) VALUES (3, 7, ?, 'arrived', 7)").run(now.toISOString()).lastInsertRowid);
  if (DB) DB.close();
  DB = db;
  TOASTS.length = 0; WRITES.length = 0;
  return vid;
}
const line = (vid, svc, status = 'added') => Number(DB.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 1, 0, 0, ?, 7)").run(vid, svc, status).lastInsertRowid);
const live = (vid, svc) => DB.prepare("SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND service_id = ? AND status <> 'cancelled'").get(vid, svc).n;
/** Состояние окна визита: строки — как их загружает окно (все, с отменёнными). */
function stateOf(vid) {
  const visit = DB.prepare('SELECT * FROM visits WHERE id = ?').get(vid);
  const services = DB.prepare('SELECT * FROM visit_services WHERE visit_id = ?').all(vid);
  return { visit, patient: { id: 3 }, services };
}
const svc = (id) => DB.prepare('SELECT * FROM services WHERE id = ?').get(id);
const pick = (id) => ({ service: svc(id), doctor: null });

test('DUP_STOP_V1 (ревью M3, К1): окно визита — отменённая, возвращённая («Вернуть услугу») строка и процедура не мешают добавить ту же услугу снова', async () => {
  const vid = seed();
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  line(vid, 22, 'cancelled');
  const back = line(vid, 23);
  DB.prepare("INSERT INTO pay_refund_releases (kind, line_id, invoice_id) VALUES ('out', ?, 1)").run(back);   // отпущена со счёта с возвратом
  line(vid, 24);
  for (const id of [22, 23, 24]) {
    await VM.addServiceFromPicker(stateOf(vid), pick(id), () => {});
  }
  assert.equal(live(vid, 22), 1, 'анализ после отменённой строки');
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM visit_services WHERE visit_id = ? AND service_id = 23').get(vid).n, 2, 'УЗИ после возврата');
  assert.equal(live(vid, 24), 2, 'процедура второй раз');
  const ex = await VM.attachExcludeIds(vid);
  assert.ok(ex.includes(22) && ex.includes(23), 'новые строки — назначение: ' + JSON.stringify(ex));
  assert.ok(!ex.includes(24), 'процедура погашена');
});

test('DUP_STOP_V1 (ревью M3): окно визита — каталог гасит только назначенное по правилу сервера; повтор — отказ словами сервера до записи', async () => {
  const vid = seed();
  USER = { id: 1, role: 'registrar', extra_roles: [] };
  line(vid, 22);
  line(vid, 23, 'cancelled');
  line(vid, 24);
  assert.deepEqual(await VM.attachExcludeIds(vid), [22], 'каталог гасит отменённое или процедуру');
  await assert.rejects(() => VM.addServiceFromPicker(stateOf(vid), pick(22), () => {}),
    (e) => /^Эта услуга уже назначена в этом визите: «Анализ крови» — Петров Пётр, .+, счёта ещё нет\.$/.test(e.message));
  assert.equal(WRITES.length, 0, 'повтор дошёл до записи');
  assert.equal(live(vid, 22), 1);
});

test('DUP_STOP_V1 (ревью M3): окно визита — администратор назначает повтор с причиной; каталог ему ничего не гасит', async () => {
  const vid = seed();
  USER = { id: 2, role: 'admin', extra_roles: [] };
  try {
    line(vid, 22);
    assert.deepEqual(await VM.attachExcludeIds(vid), [], 'администратору повтор доступен — с причиной');
    document.body.children.length = 0;
    const run = VM.addServiceFromPicker(stateOf(vid), pick(22), () => {});
    let modal = null;
    for (let i = 0; i < 100 && !modal; i++) {
      await new Promise((r) => setTimeout(r, 10));
      modal = document.body.children.find((n) => walk(n).some((x) => x.dataset && 'repeatConfirm' in x.dataset));
    }
    assert.ok(modal, 'окно причины не открылось');
    walk(modal).find((n) => n.tagName === 'TEXTAREA').value = 'контрольный анализ';
    walk(modal).find((n) => n.dataset && 'repeatConfirm' in n.dataset).click();
    await run;
    const ins = WRITES.filter((w) => w.table === 'visit_services');
    assert.equal(ins.length, 1);
    assert.equal(ins[0].values.__repeat_reason, 'контрольный анализ');
    assert.equal(live(vid, 22), 2);
    assert.deepEqual(DB.prepare("SELECT reason FROM invoice_audit_log WHERE action = 'line_repeat_order'").all(), [{ reason: 'контрольный анализ' }]);
  } finally { USER = { id: 1, role: 'registrar', extra_roles: [] }; }
});

test('DUP_STOP_V1 (ревью M3): «Добавить услуги к визиту» гасит каталог по attachExcludeIds, а не по всем строкам окна', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'visit-modal.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const at = src.indexOf("title:          'Добавить услуги к визиту'");
  assert.ok(at > 0, 'окно «Добавить услуги к визиту» не найдено');
  const call = src.slice(src.lastIndexOf('openServicePickerModal({', at), src.indexOf('onPick:', at));
  assert.match(call, /excludeServiceIds:\s*excludeIds/, 'каталог гасит не по правилу сервера');
  assert.ok(!/state\.services \|\| \[\]\)\.map\(s => s\.service_id\)/.test(call), 'каталог по-прежнему гасит все строки окна');
  const before = src.slice(Math.max(0, src.lastIndexOf('onclick:', at)), at);
  assert.match(before, /const excludeIds = await attachExcludeIds\(state\.visit\.id\)/);
});
