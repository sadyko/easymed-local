// PATIENT_MERGE_MONEY_V1 — «Объединить» в разделе «Пациенты» переносит баланс.
//
// mergePatients (data.js) — настоящий код экрана; fetch пропускает его вызовы
// через НАСТОЯЩИЙ реестр RPC и компилятор /api/db на SQLite после миграций
// (стенд как у picker-invoice.test.mjs). Баланс дубля (patient_deposits) клиент
// писать не может — переносит его сервер (patient_merge_money), и после
// объединения на оставленной карте — сумма обоих балансов.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class F {
  constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; this.children = []; this.attrs = {}; this.dataset = {}; this._l = {}; }
  appendChild(c) { this.children.push(c); return c; } append() {} setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {} removeEventListener() {} get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
}
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
globalThis.document = { addEventListener() {}, getElementById: () => null, createElement: (t) => new F(t), createTextNode: (t) => new F('#text'), body: new F('body'), head: new F('head'), documentElement: new F('html') };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');
const { createDeposit, acceptDeposit, depositBalance } = await import('../../../../server/services/rpc/deposits.js');

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
let USER = ADMIN;
let DB = null;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  const fail = (status, e) => ({ ok: false, status, json: async () => ({ error: { code: e.code || (status === 403 ? 'forbidden' : 'bad_request'), message: e.message } }) });
  if (u.startsWith('/api/rpc/')) {
    const handler = getRpc(decodeURIComponent(u.slice('/api/rpc/'.length)));
    if (!handler) return fail(501, { message: 'RPC not implemented' });
    try { return ok(await handler(DB, body, USER)); } catch (e) { return fail(e.status || 500, e); }
  }
  if (u === '/api/db') {
    let c;
    try { c = compile(body, USER, { db: DB }); } catch (e) { return fail(403, e); }
    try {
      const rows = c.meta.op === 'select' ? DB.prepare(c.sql).all(...c.params) : (DB.prepare(c.sql).run(...c.params), []);
      return ok(c.meta.single ? (rows[0] ?? null) : rows);
    } catch (e) { return fail(409, e); }
  }
  return fail(404, { message: 'no route ' + u });
};

const { mergePatients } = await import('../data.js');

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (1,'a','x','Админ','admin')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,full_name,role) VALUES (9,'c','x','Касса','cashier')").run();
  const keep = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run().lastInsertRowid;
  const drop = db.prepare("INSERT INTO patients (full_name) VALUES ('Иванов Иван')").run().lastInsertRowid;
  const CASH = { id: 9, role: 'cashier', full_name: 'Касса' };
  for (const [pid, amount] of [[keep, 100000], [drop, 250000]]) {
    const { deposit } = createDeposit(db, { patient_id: pid, amount }, { id: 1, role: 'admin', full_name: 'Админ' });
    acceptDeposit(db, { deposit_id: deposit.id, method: 'cash' }, CASH);
  }
  if (DB) DB.close();
  DB = db;
  return { keep, drop, CASH };
}

test('объединение переносит баланс дубля: на оставленной карте — сумма обоих, дубль удалён', async () => {
  const { keep, drop, CASH } = seed();
  const out = await mergePatients({ primaryId: keep, duplicateIds: [drop] });
  assert.equal(out.duplicatesDeleted, 1);
  assert.equal(depositBalance(DB, { patient_id: keep }, CASH).balance, 350000);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM patients WHERE id = ?').get(drop).n, 0);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM patient_deposits WHERE patient_id = ?').get(drop).n, 0);
});

test('кому объединять нельзя (не админ) — сервер отказывает первым шагом, карты не тронуты', async () => {
  const { keep, drop, CASH } = seed();
  USER = { id: 9, role: 'cashier', extra_roles: [] };
  try {
    await assert.rejects(() => mergePatients({ primaryId: keep, duplicateIds: [drop] }));
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM patients').get().n, 2);
    assert.equal(depositBalance(DB, { patient_id: drop }, CASH).balance, 250000);
  } finally { USER = ADMIN; }
});
