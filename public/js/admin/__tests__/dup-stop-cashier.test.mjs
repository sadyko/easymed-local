// DUP_STOP_V1 (2026-11-02, раздел К1 спецификации) — касса: окно выбора услуги в «Заменить
// услугу», «Вернуть эту услугу и выставить новую», «Исправить услуги» и «Ждут счёта»
// (cashier-line-fix.js pickService) гасит услуги, уже назначенные в этом визите («уже
// назначено»): замена или добавление на них — повтор, сервер откажет. Строка, которую
// меняют, не мешает. Настоящий RPC visit_dup_check и настоящий compile() за фальшивым fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this._l = {}; this.dataset = {}; this.value = ''; }
  appendChild(c) { this.children.push(c); c.parentElement = this; return c; }
  append(...cs) { for (const c of cs) if (c) this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); return c; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._l[t] || (this._l[t] = [])).push(fn); } removeEventListener() {}
  dispatchEvent(e) { for (const fn of this._l[e.type] || []) fn(e); return true; }
  click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} }); }
  focus() {} blur() {} querySelector() { return null; } querySelectorAll() { return []; }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._t; } set textContent(v) { this._t = String(v); this.children.length = 0; }
  get classList() { const s = this; return { contains: (c) => String(s.className).split(/\s+/).includes(c), add(c) { s.className = (s.className + ' ' + c).trim(); }, remove() {}, toggle() {} }; }
  get isConnected() { return true; }
}
class TX extends F { constructor(t) { super('#text'); this.nodeType = 3; this._t = String(t); } }
const mk = (t) => { const e = new F(t); if (String(t).toLowerCase() === 'template') e.content = new F('#fragment'); return e; };
globalThis.Node = F;
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, easymed: { state: { user: { id: 9, role: 'cashier' } } } };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };
const textOf = (el) => [el, ...walk(el)].map((n) => n._t || '').join('');

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const USER = { id: 9, role: 'cashier', extra_roles: [] };
let DB = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  try {
    if (u.startsWith('/api/rpc/')) return ok(await getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)))(DB, body, USER));
    if (u === '/api/db') { const { sql, params } = compile(body, USER); return ok(DB.prepare(sql).all(...params)); }
  } catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message } }) }; }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
};

const { pickService } = await import('../views/cashier-line-fix.js');

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (9, 'cash', 'x', 'Кассир', 'cashier', 0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (10, 'doc', 'x', 'Иванов', 'doctor', 1)").run();
  const s = db.prepare('INSERT INTO services (id, name, price, type, active) VALUES (?,?,?,?,1)');
  s.run(40, 'Анализ крови', 40000, 'lab');
  s.run(50, 'УЗИ', 80000, 'imaging');
  s.run(60, 'Капельница', 30000, 'procedure');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  const vid = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, '2026-11-02T05:00:00Z', 'arrived')").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO visit_services (visit_id, service_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, 1, 0, 0, 'added', 10)");
  const lab = Number(ins.run(vid, 40).lastInsertRowid);
  const usg = Number(ins.run(vid, 50).lastInsertRowid);
  ins.run(vid, 60);
  DB = db;
  return { vid, lab, usg };
}
async function openPicker(args) {
  document.body.children.length = 0;
  const pending = pickService('Заменить услугу', args);
  for (let i = 0; i < 50 && !walk(document.body).some((n) => n.attrs && n.attrs['data-service-id']); i++) await new Promise((r) => setTimeout(r, 10));
  const btn = (id) => walk(document.body).find((n) => n.attrs && n.attrs['data-service-id'] === String(id));
  return { pending, btn };
}

test('DUP_STOP_V1 (К1): окно выбора услуги кассы гасит назначенное в визите; заменяемая строка и процедура — не мешают', async () => {
  const { vid, usg } = seed();
  const { pending, btn } = await openPicker({ visitId: vid, exceptLineId: usg });
  assert.ok('disabled' in btn(40).attrs, 'анализ уже в визите — его можно выбрать');
  assert.match(textOf(btn(40)), /уже назначено/);
  assert.ok(!('disabled' in btn(50).attrs), 'заменяемую строку (УЗИ) нельзя заменить на ту же услугу у другого врача');
  assert.ok(!('disabled' in btn(60).attrs), 'процедура погашена');
  btn(40).click();
  btn(60).click();
  assert.equal((await pending).id, 60, 'погашенная услуга выбрана');
});

test('DUP_STOP_V1 (К1): без визита окно выбора ничего не гасит (как прежде)', async () => {
  seed();
  const { pending, btn } = await openPicker({});
  assert.ok(!('disabled' in btn(40).attrs));
  btn(40).click();
  assert.equal((await pending).id, 40);
});

test('DUP_STOP_V1 (К1): все окна кассы передают визит в окно выбора услуги', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(HERE, '..', 'views', 'cashier-line-fix.js'), 'utf8').replace(/\/\/[^\n]*/g, '');
  const callsOf = [...src.matchAll(/pickService\(tr\('[^']+'\)([^)]*\))/g)].map((m) => m[1]);
  assert.equal(callsOf.length, 5, 'окон выбора услуги в кассе не пять: ' + callsOf.length);
  for (const c of callsOf) assert.match(c, /visitId:/, 'окно выбора без визита: ' + c);
});
