// INVOICE_APPEND_V1 (решение владельца 2026-11-02) — БЫСТРАЯ РЕГИСТРАЦИЯ
// ВТОРОЙ РАЗ ЗА ДЕНЬ, ПОКА ПЕРВЫЙ СЧЁТ НЕ ОПЛАЧЕН: строки ложатся в ТОТ ЖЕ счёт.
//
// registerWalkIn (walk-in-booking.js) переиспользует визит дня (ensure_visit) и
// раньше выставлял на новые строки ВТОРОЙ счёт. Теперь create_invoice_for_visit
// дописывает их в неоплаченный счёт визита и отвечает appended: true; модуль
// отдаёт это экрану вместе со скидкой своей части (appendedDiscount), а items —
// только позиции этой регистрации (по ним экран сверяет цены своих строк).
//
// Стенд — как у walk-in-booking.test.mjs: настоящий реестр RPC, настоящий
// компилятор /api/db и настоящая SQLite в памяти за фальшивым fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: (k) => (k === 'admin.lang' ? 'ru' : null), setItem() {}, removeItem() {}, clear() {} };
globalThis.document = { documentElement: {}, body: null, createElement: () => ({ style: {}, appendChild() {} }) };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o || {}); } };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { readableColumns } = await import('../../../../server/db/schema-registry.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

const USER = { id: 1, role: 'registrar', extra_roles: [] };
let DB = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'no rpc' } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code, message: e.message, params: e.params } }) }; }
  }
  if (u === '/api/db') {
    let compiled;
    try { compiled = compile(body, USER); }
    catch (e) { return { ok: false, status: e.status || 400, json: async () => ({ error: { code: 'bad_request', message: e.message } }) }; }
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

const { registerWalkIn } = await import('../views/walk-in-booking.js');

const CONSULT = 21;
const LAB = 22;
const DOCTOR = 7;
const PATIENT = 3;

function seed({ vip = false } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (1,'reg','x','Регистратор','registrar',0)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,'doc','x','Петров Пётр','doctor',1,'терапевт')").run(DOCTOR);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (?, 'Иванов Иван')").run(PATIENT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type) VALUES (?,'Консультация терапевта',100000,0,30,1,'consultation')").run(CONSULT);
  db.prepare("INSERT INTO services (id, name, price, tax_rate, duration_minutes, requires_doctor, type, is_lab) VALUES (?,'Общий анализ крови',40000,0,15,0,'lab',1)").run(LAB);
  if (vip) {
    const cat = db.prepare("INSERT INTO patient_categories (name, discount_percent, active) VALUES ('VIP', 10, 1)").run().lastInsertRowid;
    db.prepare('UPDATE patients SET category_id = ? WHERE id = ?').run(cat, PATIENT);
  }
  if (DB) DB.close();
  DB = db;
}
const svc = (id) => DB.prepare('SELECT id, name, price, requires_doctor FROM services WHERE id = ?').get(id);

test('вторая регистрация за день, первый счёт не оплачен — тот же счёт: appended, items — только новые позиции', async () => {
  seed();
  const first = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(CONSULT), doctorId: DOCTOR }], createdBy: 1 });
  assert.equal(first.appended, undefined, 'первый счёт — новый');
  const second = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(LAB), doctorId: null }], createdBy: 1 });
  assert.equal(second.visit.id, first.visit.id, 'визит дня не переиспользован — проверяется не то');
  assert.equal(second.appended, true);
  assert.equal(second.invoice.id, first.invoice.id, 'второй счёт за один приход');
  assert.equal(second.invoice.invoice_number, first.invoice.invoice_number);
  assert.equal(second.invoice.total_amount, 140000);
  assert.equal(second.items.length, 1, 'items — позиции ЭТОЙ регистрации');
  assert.deepEqual(second.lines.map((l) => l.unitPrice), [40000]);
  assert.equal(second.appendedDiscount, 0);
  assert.equal(DB.prepare('SELECT COUNT(*) c FROM invoices').get().c, 1);
});

test('скидка своей части — пол группы пациента новой части, а не скидка всего счёта', async () => {
  seed({ vip: true });
  await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(CONSULT), doctorId: DOCTOR }], createdBy: 1 });
  const second = await registerWalkIn({ patientId: PATIENT, lines: [{ service: svc(LAB), doctorId: null }], createdBy: 1 });
  assert.equal(second.appended, true);
  assert.equal(second.appendedDiscount, 4000, '10 % от 40 000');
  assert.equal(second.invoice.discount_amount, 14000, 'скидка счёта — 10 000 прежней части + 4 000 новой');
  assert.equal(second.invoice.total_amount, 126000);
});

test.after(() => { if (DB) DB.close(); DB = null; });
