// DUP_STOP_V1 (2026-11-02) — экранный помощник «уже назначено в этом визите»
// (views/dup-order-check.js) на настоящем RPC visit_dup_check: фальшивый fetch
// пропускает вызовы через реестр RPC и SQLite в памяти, прошедшую миграции.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── крошечный DOM ──────────────────────────────────────────────────────────
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
const TOASTS = [];
const TOAST_EL = mk('div');
Object.defineProperty(TOAST_EL, 'textContent', { get() { return ''; }, set(v) { TOASTS.push(String(v)); }, configurable: true });
globalThis.document = {
  createElement: mk, createElementNS: (_n, t) => mk(t), createTextNode: (t) => new TX(t),
  head: mk('head'), body: mk('body'), documentElement: mk('html'),
  addEventListener() {}, removeEventListener() {}, getElementById(id) { return id === 'toast' ? TOAST_EL : null; },
};
globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
const walk = (e, o = []) => { for (const c of e.children || []) { o.push(c); walk(c, o); } return o; };

// ─── настоящая база и реестр RPC за фальшивым fetch ─────────────────────────
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
let DB = null;
let USER = { id: 2, role: 'registrar', extra_roles: [] };
let FAIL = false;
const CALLS = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  if (!u.startsWith('/api/rpc/')) return { ok: false, status: 404, json: async () => ({ error: { message: 'no route' } }) };
  const name = decodeURIComponent(u.slice('/api/rpc/'.length));
  CALLS.push({ name, body });
  if (FAIL) return { ok: false, status: 500, json: async () => ({ error: { code: 'internal', message: 'Ошибка сервера. Повторите позже.' } }) };
  try { return { ok: true, status: 200, json: async () => ({ data: await getRpc(name)(DB, body, USER) }) }; }
  catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message } }) }; }
};

const { loadVisitOrders, orderedMatch, orderedLabel, blockedPickIds, precheckOrders, withRepeatReason } = await import('../views/dup-order-check.js');

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, extra_roles) VALUES (?,?,?,?,?,?,?)');
  u.run(1, 'boss', 'x', 'Админ', 'admin', 0, '[]');
  u.run(2, 'reg', 'x', 'Регистратура', 'registrar', 0, '[]');
  u.run(10, 'doc', 'x', 'Иванов', 'doctor', 1, '[]');
  u.run(11, 'doc2', 'x', 'Петров', 'doctor', 1, '[]');
  const s = db.prepare('INSERT INTO services (id, name, price, type, requires_doctor) VALUES (?,?,?,?,?)');
  s.run(30, 'Консультация терапевта', 100000, 'consultation', 1);
  s.run(40, 'Анализ крови', 40000, 'lab', 0);
  s.run(60, 'Капельница', 30000, 'procedure', 0);
  db.prepare("INSERT INTO services (id, name, price) VALUES (70, 'Без типа', 50000)").run();   // DUP_STOP_V1 (ревью m4) — тип по умолчанию, врач не нужен
  db.prepare("INSERT INTO consultation_types (id, name, name_ru, price, active) VALUES (5, 'Первичный', 'Первичный приём', 90000, 1)").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (77, 'Пациент Тест')").run();
  const now = new Date(); now.setHours(9, 0, 0, 0);
  const v = Number(db.prepare("INSERT INTO visits (patient_id, visit_date, status) VALUES (77, ?, 'arrived')").run(now.toISOString()).lastInsertRowid);
  const ln = db.prepare("INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, ?, 1, 0, 0, 'added', 10)");
  ln.run(v, 40, null, null);
  ln.run(v, 30, null, 10);
  ln.run(v, null, 5, 11);
  if (DB) DB.close();
  DB = db;
  const p = (n) => String(n).padStart(2, '0');
  return { v, day: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` };
}

test('DUP_STOP_V1: loadVisitOrders — назначенное визита дня; каталог гасит анализ, консультацию — только у того же врача', async () => {
  const { v, day } = seed();
  const got = await loadVisitOrders({ patientId: 77, day });
  assert.equal(got.visitId, v);
  assert.equal(got.canOverride, false);
  assert.deepEqual(got.ordered.map((o) => o.key).sort(), ['c:5|d:11', 's:30|d:10', 's:40']);
  assert.equal(orderedMatch({ id: 40, type: 'lab' }, got.ordered).blocked, true);
  assert.equal(orderedMatch({ id: 60, type: 'procedure' }, got.ordered), null, 'процедура — повтор можно');
  const cons = orderedMatch({ id: 30, type: 'consultation' }, got.ordered);
  assert.equal(cons.blocked, false, 'консультация без выбранного врача — подсказка, не запрет');
  assert.equal(orderedLabel(cons), 'уже назначено: Иванов');
  assert.equal(orderedMatch({ id: 30, type: 'consultation' }, got.ordered, 10).blocked, true);
  assert.equal(orderedMatch({ id: 'c|11|5', __consult: true, consultation_type_id: 5, __consultDoctorId: 11 }, got.ordered).blocked, true);
  assert.equal(orderedMatch({ id: 'c|10|5', __consult: true, consultation_type_id: 5, __consultDoctorId: 10 }, got.ordered), null);
  assert.deepEqual(blockedPickIds(got.ordered).sort(), [40, 'c|11|5'].sort());
  assert.deepEqual(await loadVisitOrders({ patientId: 77 }), { visitId: null, ordered: [], canOverride: false }, 'нет дня — не спрашиваем');
});

test('DUP_STOP_V1 (ревью m4): услуга без типа и без «нужен врач», назначенная у врача, погашена для любого врача и в каталоге', async () => {
  const { v, day } = seed();
  DB.prepare("INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, 70, 10, 1, 0, 0, 'added', 10)").run(v);
  const got = await loadVisitOrders({ patientId: 77, day });
  const o = got.ordered.find((r) => r.service_id === 70);
  assert.equal(o.key, 's:70', 'в ключе — врач строки');
  const svc = { id: 70, type: 'consultation', requires_doctor: 0 };
  for (const doc of [null, 10, 11]) assert.equal(orderedMatch(svc, got.ordered, doc).blocked, true, 'врач ' + doc);
  assert.ok(blockedPickIds(got.ordered).includes(70), 'каталог не гасит услугу без типа');
  assert.ok(!blockedPickIds(got.ordered).includes(30), 'консультация с врачом гасится только для своего врача');
});

test('DUP_STOP_V1 (ревью, остаток 4): консультация, назначенная БЕЗ врача (c:5|d: · s:30|d:), гасится для новой строки без врача — как отказывает сервер', async () => {
  const { v, day } = seed();
  const ln = DB.prepare("INSERT INTO visit_services (visit_id, service_id, consultation_type_id, doctor_id, quantity, unit_price, total, status, created_by) VALUES (?, ?, ?, NULL, 1, 0, 0, 'added', 10)");
  ln.run(v, 30, null);
  ln.run(v, null, 5);
  const got = await loadVisitOrders({ patientId: 77, day });
  assert.ok(got.ordered.some((o) => o.key === 's:30|d:') && got.ordered.some((o) => o.key === 'c:5|d:'), JSON.stringify(got.ordered.map((o) => o.key)));
  // сервер: новая строка без врача — повтор
  for (const line of [{ service_id: 30 }, { consultation_type_id: 5 }]) {
    const r = await precheckOrders({ patientId: 77, day, lines: [line] });
    assert.equal(r.ok, false, 'сервер отказывает: ' + JSON.stringify(line));
  }
  // экран — то же
  const svc = orderedMatch({ id: 30, type: 'consultation', requires_doctor: 1 }, got.ordered);
  assert.equal(svc.blocked, true, 'услуга-консультация без врача уже назначена без врача');
  assert.equal(svc.row.doctor_id, null);
  const cons = orderedMatch({ id: 'c||5', __consult: true, consultation_type_id: 5, __consultDoctorId: null }, got.ordered);
  assert.equal(cons && cons.blocked, true);
  assert.ok(blockedPickIds(got.ordered).includes('c||5'), 'вид приёма без врача — id строки быстрой регистрации');
  // у врача, которому её не назначали, — по-прежнему подсказка, не запрет (сервер пускает)
  assert.equal(orderedMatch({ id: 30, type: 'consultation', requires_doctor: 1 }, got.ordered, 11).blocked, false);
  assert.ok(!blockedPickIds(got.ordered).includes('c|10|5'));
});

test('DUP_STOP_V1: precheckOrders — повтор: отказ словами сервера, писать нельзя; новое — можно; сервер молчит — решит дверь', async () => {
  const { day } = seed();
  CALLS.length = 0;
  const bad = await precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /^Эта услуга уже назначена в этом визите: «Анализ крови» — Иванов, .+, счёта ещё нет\.$/);
  assert.equal(CALLS[0].name, 'visit_dup_check');
  assert.deepEqual(await precheckOrders({ patientId: 77, day, lines: [{ service_id: 60 }, { consultation_type_id: 5, doctor_id: 10 }] }), { ok: true, reason: null });
  assert.deepEqual(await precheckOrders({ patientId: 77, day, lines: [] }), { ok: true, reason: null });
  FAIL = true;
  try { assert.deepEqual(await precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] }), { ok: true, reason: null }); }
  finally { FAIL = false; }
});

test('DUP_STOP_V1: администратор — окно причины; причина уходит в строку, отказ от окна — ничего не пишем', async () => {
  const { day } = seed();
  USER = { id: 1, role: 'admin', extra_roles: [] };
  try {
    const pending = precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] });
    for (let i = 0; i < 20 && !document.body.children.length; i++) await new Promise((r) => setTimeout(r, 5));
    const modal = document.body.children[document.body.children.length - 1];
    const area = walk(modal).find((n) => n.tagName === 'TEXTAREA');
    const ok = walk(modal).find((n) => n.tagName === 'BUTTON' && n.dataset && 'repeatConfirm' in n.dataset);
    area.value = 'ок';
    ok.click();
    assert.ok(TOASTS.some((t) => t.includes('Укажите причину повторного назначения')), 'короткая причина не принята');
    area.value = '  контрольный анализ ';
    ok.click();
    const res = await pending;
    assert.deepEqual(res, { ok: true, reason: 'контрольный анализ' });
    assert.deepEqual(withRepeatReason({ visit_id: 1 }, res.reason), { visit_id: 1, __repeat_reason: 'контрольный анализ' });
    assert.deepEqual(withRepeatReason({ visit_id: 1 }, null), { visit_id: 1 });

    const second = precheckOrders({ patientId: 77, day, lines: [{ service_id: 40 }] });
    for (let i = 0; i < 20 && !document.body.children.length; i++) await new Promise((r) => setTimeout(r, 5));
    const m2 = document.body.children[document.body.children.length - 1];
    walk(m2).find((n) => n.tagName === 'BUTTON' && /Отмена/.test(walk(n).map((x) => x._t).join(''))).click();
    assert.deepEqual(await second, { ok: false, text: null });
  } finally { USER = { id: 2, role: 'registrar', extra_roles: [] }; }
});
