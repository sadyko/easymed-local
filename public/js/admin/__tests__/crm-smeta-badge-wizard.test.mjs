// CRM_SMETA_BADGE_V1 (3.23.0) — «СМЕТА» МАСТЕРА ВИЗИТА: СТРОКА ИЗ ЗАЯВКИ И ПАЦИЕНТ, ЗАПИСАННЫЙ ИЗ
// ЗАЯВКИ, ВИДНЫ СРАЗУ. Владелец (2026-11-10, снимки 66–67): в каталоге мастера у «АЧТВ» чип «ИЗ
// ЗАЯВКИ», а в правой «Смете» — та же строка без всякой пометки, и у имени пациента ничего: «its
// there in the smeta but its not prominent». Теперь в смете у строки — «из заявки · 10.11», у
// пациента — «Записан из заявки на 10.11» (views/crm-smeta-badge.js).
//
// Стенд — как у diag-route-wizard.test.mjs: настоящие миграции, реестр RPC (crm_day_lines — та же
// дверь, что у регистратуры) и компилятор /api/db за фальшивым fetch; мастер открывает регистратура.
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

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;
const RPC = [];
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
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
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
const SPM = await import('../views/service-picker-modal.js?v=ownrep4');
const { openVisitWizard } = await import('../views/visit-wizard.js');
const isWizard = (n) => !!(n && n.style && n.style.position === 'fixed');
const flush = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
// День мастера — местный день JS (defaultWhen); строка заявки — на него же.
const jsToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Пациент 3; анализ 41 «Svc-АЧТВ» (лаборатория, врач не нужен); заявка CRM пациента с его строкой на день `day`. */
function seed({ day = jsToday(), crm = true } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
  db.prepare("INSERT INTO patients (id, full_name, phone) VALUES (3,'Тест-Пациент','+998901112233')").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, type, requires_doctor, is_lab) VALUES (41,'Svc-АЧТВ',35000,30,'lab',0,1)").run();
  db.prepare("INSERT INTO services (id, name, price, duration_minutes, type, requires_doctor, is_lab) VALUES (42,'Svc-ОАК',30000,30,'lab',0,1)").run();
  if (crm) {
    const rid = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, status, patient_id, scheduled_date) VALUES ('Тест-Пациент','+998901112233','scheduled',3,?)").run(day).lastInsertRowid);
    db.prepare("INSERT INTO crm_request_services (request_id, service_id, scheduled_date, status) VALUES (?, 41, ?, 'pending')").run(rid, day);
  }
  if (DB) DB.close();
  DB = db;
  SPM.forgetSlots();
}
async function open(cfg) {
  seed(cfg);
  document.body.children.length = 0; TOASTS.length = 0; RPC.length = 0;
  await openVisitWizard(() => {}, { id: 3, full_name: 'Тест-Пациент', phone: '+998901112233' }, {});
  await flush(20); await wait(120); await flush(20);
  const ov = () => document.body.children.find(isWizard);
  assert.ok(ov(), 'мастер не открылся');
  return ov;
}
const attrNodes = (root, attr) => [root, ...walk(root)].filter((n) => n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, attr));
const flat = (n) => textOf(n).replace(/\s+/g, ' ').trim();
/** Строки сметы: строка с названием услуги и кнопкой «Убрать». */
const railRow = (ov, name) => walk(ov()).find((n) => n.children && n.children.some((c) => c.tagName === 'SPAN' && flat(c) === name)
  && n.children.some((c) => c.tagName === 'BUTTON' && c.attrs.title === 'Убрать'));
/** «Добавить» у услуги каталога — как регистратор набирает услугу руками. */
async function addByHand(ov, name) {
  const row = walk(ov()).find((n) => n.children && flat(n).includes(name)
    && n.children.some((c) => c.tagName === 'BUTTON' && flat(c) === 'Добавить'));
  assert.ok(row, 'в каталоге нет «Добавить» у ' + name);
  row.children.find((c) => c.tagName === 'BUTTON' && flat(c) === 'Добавить').click();
  await flush(20); await wait(40); await flush(20);
}
const ddmm = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7);

test('CRM_SMETA_BADGE_V1: мастер визита — у строки из заявки «из заявки · дд.мм», у пациента «Записан из заявки на дд.мм»; набранная руками — без значка', async () => {
  const ov = await open();
  const day = ddmm(jsToday());
  assert.ok(RPC.some((c) => c.name === 'crm_day_lines'), 'мастер не спросил строки заявки дня');
  const row = railRow(ov, 'Svc-АЧТВ');
  assert.ok(row, 'строка из заявки не встала в смету: ' + flat(ov()).slice(0, 400));
  const badge = attrNodes(row, 'data-crm-line')[0];
  assert.ok(badge, 'у строки из заявки в смете нет значка');
  assert.equal(flat(badge), 'из заявки · ' + day);
  await addByHand(ov, 'Svc-ОАК');
  const own = railRow(ov, 'Svc-ОАК');
  assert.ok(own, 'набранная руками строка не встала в смету');
  assert.equal(attrNodes(own, 'data-crm-line').length, 0, 'значок «из заявки» у строки, набранной руками');
  const heads = attrNodes(ov(), 'data-crm-booked');
  assert.equal(heads.length, 1, 'у пациента в смете нет значка «Записан из заявки»');
  assert.equal(flat(heads[0]), 'Записан из заявки на ' + day);
  // Значок — сразу под строкой пациента (имя — в соседнем узле).
  const rail = heads[0].parentElement;
  const at = rail.children.indexOf(heads[0]);
  assert.ok(at > 0 && flat(rail.children[at - 1]).includes('Тест-Пациент'), 'значок не под именем пациента');
});

test('CRM_SMETA_BADGE_V1: без заявки — значков нет', async () => {
  const ov = await open({ crm: false });
  assert.equal(attrNodes(ov(), 'data-crm-booked').length, 0);
  assert.equal(attrNodes(ov(), 'data-crm-line').length, 0);
});

test('CRM_SMETA_BADGE_V1: мастер визита по-английски — «from request · дд.мм», «Booked from request for дд.мм», без кириллицы в значках', async () => {
  const { setLang } = await import('../i18n.js');
  window.dispatchEvent = () => true;
  globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
  try {
    setLang('en');
    const ov = await open();
    const day = ddmm(jsToday());
    const badge = attrNodes(ov(), 'data-crm-line')[0];
    assert.ok(badge, 'en: нет значка у строки');
    assert.equal(flat(badge), 'from request · ' + day);
    const head = attrNodes(ov(), 'data-crm-booked')[0];
    assert.ok(head, 'en: нет значка у пациента');
    assert.equal(flat(head), 'Booked from request for ' + day);
    for (const n of [badge, head]) assert.doesNotMatch(flat(n), /[Ѐ-ӿ]/);
  } finally { setLang('ru'); }
});
