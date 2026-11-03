// DIAG_ROUTE_V1 (D1, решение владельца 2026-11-03) — МАСТЕР ЗАПИСИ ВЫБИРАЕТ
// ИСПОЛНИТЕЛЯ У КАЖДОЙ УСЛУГИ КАБИНЕТА ВРАЧА.
//
// Расследование «диагностика не видна у врача» (#1): УЗИ «без врача»
// (requires_doctor = 0 — умолчание новой услуги) мастер записывал БЕЗ
// исполнителя, когда исполнителей было два и больше, ноль, или единственный был
// не role = 'doctor' (главный врач, администратор-врач, медсестра) — и строку не
// видел ни один кабинет (SERVICE_SCOPE_V3). Теперь: исполнитель нужен всем
// услугам, кроме групп «Лаборатория» и «Процедуры»; список — отмеченные услуге
// в «Услугах и ставках» (любой роли), иначе все врачи по is_doctor; один кандидат
// выбирается сам; без исполнителя «Далее» не пускает.
//
// Стенд — как у pick-day-wizard.test.mjs: настоящие миграции, реестр RPC и
// компилятор /api/db за фальшивым fetch; мастер открывает регистратура.
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
const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WH = JSON.stringify(Object.fromEntries(WD.map((k) => [k, { enabled: true, from: '00:00', to: '23:59' }])));

/**
 * Услуга 31 «Svc-УЗИ» группы `type` (по умолчанию «Диагностика»), «нужен врач» = req.
 * performers — [{id, role, is_doctor}]: им отмечена услуга 31. В клинике ещё врачи 7 и 8
 * (терапевты, им услуга не отмечена).
 */
function seed({ req = 0, type = 'imaging', performers = [] } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
  const U = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty, working_hours, service_rates) VALUES (?,?,?,?,?,?,?,?,?)');
  U.run(7, 'ter', 'x', 'Терапевт А', 'doctor', 1, 'терапевт', WH, '[]');
  U.run(8, 'ter2', 'x', 'Терапевт Б', 'doctor', 1, 'терапевт', WH, '[]');
  const rates = JSON.stringify([{ service_id: 31, percentage: 0 }]);
  for (const p of performers) U.run(p.id, 'u' + p.id, 'x', 'Исполнитель-' + p.id, p.role, p.is_doctor, 'УЗИ', WH, rates);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Тест-Пациент')").run();
  db.prepare('INSERT INTO services (id, name, price, duration_minutes, type, requires_doctor) VALUES (31,?,100000,20,?,?)').run('Svc-УЗИ', type, req);
  if (DB) DB.close();
  DB = db;
  SPM.forgetSlots();
}
const D = (id, role = 'doctor', is_doctor = 1) => ({ id, role, is_doctor });

async function open(cfg) {
  seed(cfg);
  document.body.children.length = 0; TOASTS.length = 0; RPC.length = 0;
  await openVisitWizard(() => {}, { id: 3, full_name: 'Тест-Пациент' }, { presetServiceIds: [31] });
  await flush(20); await wait(120); await flush(20);
  const ov = () => document.body.children.find(isWizard);
  assert.ok(ov(), 'мастер не открылся');
  return ov;
}
const perfSelect = (ov) => walk(ov()).find((n) => n.tagName === 'SELECT' && n.attrs['data-performer-for'] === '31') || null;
const optionIds = (sel) => sel.children.filter((o) => o.tagName === 'OPTION').map((o) => o.attrs.value).filter(Boolean).map(Number);
const nextButton = (ov) => walk(ov()).filter((n) => n.tagName === 'BUTTON')
  .find((n) => /^\s*(Далее|Сформировать счёт|Записать услуги)/.test(textOf(n).replace(/\s+/g, ' ').trim())) || null;
async function pressUntilCreate(ov) {
  for (let i = 0; i < 6; i++) {
    if (!ov()) break;
    const near = walk(ov()).find((n) => n.tagName === 'BUTTON' && n.attrs && n.attrs['data-pick-nearest'] !== undefined);
    if (near) { near.click(); await flush(20); }
    const btn = nextButton(ov);
    if (!btn) break;
    btn.click();
    await wait(80); await flush(30);
    if (RPC.some((c) => c.name === 'ensure_visit')) break;
  }
  await wait(120); await flush(30);
}
const lineDoctor = () => { const r = DB.prepare('SELECT doctor_id FROM visit_services WHERE service_id = 31').get(); return r ? r.doctor_id : undefined; };

test('W2 / W3: два исполнителя или ни одного — выбор исполнителя у строки «на дату», «Далее» не пускает, без выбора ничего не записано', async () => {
  for (const [label, cfg, want] of [
    ['W2 два отмеченных', { performers: [D(21), D(22)] }, [21, 22]],
    ['W3 никто не отмечен — все врачи', { performers: [] }, [7, 8]],
  ]) {
    const ov = await open(cfg);
    const sel = perfSelect(ov);
    assert.ok(sel, label + ': у строки нет выбора исполнителя');
    assert.deepEqual(optionIds(sel), want, label + ': кандидаты');
    assert.equal(sel.value, '', label + ': исполнитель выбран сам при двух кандидатах');
    const btn = nextButton(ov);
    assert.ok(btn && 'disabled' in btn.attrs, label + ': «Далее» не закрыт');
    assert.match(textOf(ov()), /выберите исполнителя услуги — без него пациента не увидит ни один врач/, label + ': нет объяснения');
    await pressUntilCreate(ov);
    assert.ok(!RPC.some((c) => c.name === 'ensure_visit'), label + ': визит заведён без исполнителя');
    assert.equal(lineDoctor(), undefined, label + ': строка записана');
    assert.ok(TOASTS.some((t) => /выберите исполнителя услуги/.test(t)), label + ': отказ не сказан: ' + JSON.stringify(TOASTS));
  }
});

test('W2: выбранный исполнитель ложится в строку', async () => {
  const ov = await open({ performers: [D(21), D(22)] });
  const sel = perfSelect(ov);
  sel.value = '22';
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await flush(20);
  assert.ok(!('disabled' in nextButton(ov).attrs), '«Далее» закрыт после выбора');
  await pressUntilCreate(ov);
  assert.equal(lineDoctor(), 22);
});

test('W4–W6: единственный отмеченный исполнитель любой роли — главный врач, администратор-врач, медсестра — ставится сам', async () => {
  for (const p of [D(23, 'head_doctor'), D(24, 'admin'), D(25, 'nurse', 0)]) {
    const ov = await open({ performers: [p] });
    const sel = perfSelect(ov);
    assert.ok(sel, p.role + ': нет выбора исполнителя');
    assert.equal(sel.value, String(p.id), p.role + ': не выбран сам');
    await pressUntilCreate(ov);
    assert.equal(lineDoctor(), p.id, p.role);
  }
});

test('W7: врач и главный врач отмечены — оба в списке, строка получает выбранного главного врача', async () => {
  const ov = await open({ performers: [D(21), D(23, 'head_doctor')] });
  const sel = perfSelect(ov);
  assert.deepEqual(optionIds(sel), [21, 23]);
  sel.value = '23';
  sel.dispatchEvent({ type: 'change', target: sel, currentTarget: sel });
  await flush(20);
  await pressUntilCreate(ov);
  assert.equal(lineDoctor(), 23);
});

test('W9: «нужен врач», единственный исполнитель — главный врач: строка его, а не терапевта', async () => {
  const ov = await open({ req: 1, performers: [D(23, 'head_doctor')] });
  await wait(80); await flush(30);
  await pressUntilCreate(ov);
  assert.equal(lineDoctor(), 23);
});

test('анализ и процедура — без выбора исполнителя и без исполнителя', async () => {
  for (const type of ['lab', 'procedure']) {
    const ov = await open({ type, performers: [] });
    assert.equal(perfSelect(ov), null, type + ': выбор исполнителя у анализа/процедуры');
    await pressUntilCreate(ov);
    assert.equal(lineDoctor(), null, type);
  }
});
