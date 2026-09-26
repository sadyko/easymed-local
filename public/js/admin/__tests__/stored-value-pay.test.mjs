// DEPOSIT_WALLET_V1 — «Баланс: использовать» в мастере записи и калькуляторе.
//
// stored-value-pay.js раскладывает баланс пациента по только что выставленным
// счетам и проводит его через сервер. Стенд — как у picker-invoice.test.mjs:
// фальшивый fetch пропускает вызовы через НАСТОЯЩИЙ реестр RPC и SQLite после
// миграций, поэтому проверяется то же, что увидит касса: платежи 'wallet',
// строки журнала баланса и остаток.

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
globalThis.window = { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {} };
globalThis.document = { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }) };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { compile } = await import('../../../../server/db/query-compiler.js');
const { getRpc } = await import('../../../../server/services/rpc/index.js');

let USER = { id: 9, role: 'cashier', extra_roles: [] };
let DB = null;
const RPC = [];
const DBWRITES = [];

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });
  if (u.startsWith('/api/rpc/')) {
    const name = decodeURIComponent(u.slice('/api/rpc/'.length));
    RPC.push({ name, body });
    const handler = getRpc(name);
    if (!handler) return { ok: false, status: 501, json: async () => ({ error: { message: 'RPC not implemented: ' + name } }) };
    try { return ok(await handler(DB, body, USER)); }
    catch (e) { return { ok: false, status: e.status || 500, json: async () => ({ error: { code: e.code || (e.status === 403 ? 'forbidden' : 'bad_request'), message: e.message } }) }; }
  }
  if (u === '/api/db') {
    const { sql, params, meta } = compile(body, USER);
    if (meta.op !== 'select') DBWRITES.push(meta.table);
    const rows = meta.op === 'select' ? DB.prepare(sql).all(...params) : (DB.prepare(sql).run(...params), []);
    return ok(meta.single ? (rows[0] ?? null) : rows);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'no route ' + u } }) };
};

const { planStoredValue, payFromStoredValue, loadPatientBalance, canSpendStoredValue } = await import('../stored-value-pay.js');

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (9,'c','x','Касса','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (7,'r','x','Регистратор','registrar')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (3,'Пациент')").run();
  // Баланс 150 000 — зачисленный возврат (как после «не мой пациент»).
  // Строки с деньгами пишет только сервер (мигр. 160): посев — под его разрешением.
  const tok = db.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run().lastInsertRowid;
  db.prepare("INSERT INTO patient_deposits (patient_id, amount, status, kind) VALUES (3, 150000, 'received', 'credit')").run();
  db.prepare('DELETE FROM ledger_write_token WHERE id = ?').run(tok);
  for (const id of [1, 2]) {
    db.prepare("INSERT INTO invoices (id, invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status) VALUES (?, ?, 3, 100000, 0, 100000, 0, 'unpaid')")
      .run(id, 'INV-A-26-0000' + id);
  }
  if (DB) DB.close();
  DB = db;
  RPC.length = 0; DBWRITES.length = 0;
}
const INVOICES = () => DB.prepare('SELECT * FROM invoices ORDER BY id').all();

test('раскладка: счета по порядку, каждому не больше его остатка и остатка баланса', () => {
  const plan = planStoredValue([
    { id: 1, total_amount: 100000, paid_amount: 0 },
    { id: 2, total_amount: 100000, paid_amount: 30000 },
    { id: 3, total_amount: 100000, paid_amount: 0 },
  ], { wallet: 150000 });
  assert.deepEqual(plan, [
    { invoice_id: 1, tenders: [{ method: 'wallet', amount: 100000 }] },
    { invoice_id: 2, tenders: [{ method: 'wallet', amount: 50000 }] },
  ]);
  assert.deepEqual(planStoredValue([{ id: 1, total_amount: 0 }], { wallet: 10 }), [], 'нулевой счёт не трогаем');
});

test('касса списывает баланс на два счёта: платежи wallet, журнал баланса, остаток 0 — всё сервером', async () => {
  seed();
  USER = { id: 9, role: 'cashier', extra_roles: [] };
  assert.equal(await loadPatientBalance(3), 150000);
  const res = await payFromStoredValue(INVOICES(), { wallet: 150000 });
  assert.deepEqual(res.errors, []);
  assert.equal(res.wallet, 150000);
  const [a, b] = INVOICES();
  assert.equal(a.status, 'paid');
  assert.equal(b.paid_amount, 50000);
  assert.equal(b.status, 'partial');
  assert.equal(await loadPatientBalance(3), 0);
  assert.deepEqual(DB.prepare("SELECT method, amount FROM payments ORDER BY id").all().map((r) => [r.method, r.amount]),
    [['wallet', 100000], ['wallet', 50000]]);
  assert.equal(DB.prepare("SELECT COUNT(*) n FROM patient_deposits WHERE kind = 'spend'").get().n, 2);
  assert.deepEqual(RPC.filter((r) => r.name !== 'deposit_balance').map((r) => r.name), ['record_payment', 'record_payment']);
  assert.ok(!DBWRITES.some((t) => ['invoices', 'payments', 'patient_deposits'].includes(t)), 'деньги пишет только сервер');
});

test('баланса меньше, чем просит экран (устаревшая цифра) — сервер отказывает, счёт не тронут', async () => {
  seed();
  const tok = DB.prepare('INSERT INTO ledger_write_token DEFAULT VALUES').run().lastInsertRowid;
  DB.prepare("INSERT INTO patient_deposits (patient_id, amount, status, kind) VALUES (3, 120000, 'spent', 'spend')").run();
  DB.prepare('DELETE FROM ledger_write_token WHERE id = ?').run(tok);
  const res = await payFromStoredValue(INVOICES(), { wallet: 150000 });
  assert.equal(res.wallet, 0);
  assert.match(res.errors[0], /На балансе пациента только 30000/);
  assert.equal(INVOICES()[0].paid_amount, 0);
});

test('регистратура баланс не списывает: сервер отказывает по роли, экран спрятал галочку', async () => {
  seed();
  USER = { id: 7, role: 'registrar', extra_roles: [] };
  globalThis.window.easymed = { state: { user: { role: 'registrar', extra_roles: [] } } };
  try {
    assert.equal(canSpendStoredValue(), false);
    const res = await payFromStoredValue(INVOICES(), { wallet: 150000 });
    assert.equal(res.errors.length, 2);
    assert.equal(DB.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
    globalThis.window.easymed = { state: { user: { role: 'cashier', extra_roles: [] } } };
    assert.equal(canSpendStoredValue(), true);
  } finally {
    USER = { id: 9, role: 'cashier', extra_roles: [] };
    delete globalThis.window.easymed;
  }
});

// ─── CARD_BALANCE_V1 — карта платит своим остатком, первой ──────────────────
const { discountValue, discountBlockReason, discountOptionParts, cardRemaining } = await import('../discount-rules.js');

test('карта в раскладке идёт первой, баланс — следом; обе не больше остатка счёта', () => {
  const plan = planStoredValue([
    { id: 1, total_amount: 100000, paid_amount: 0 },
    { id: 2, total_amount: 100000, paid_amount: 0 },
  ], { wallet: 50000, card: { id: 5, remaining: 120000 } });
  assert.deepEqual(plan, [
    { invoice_id: 1, tenders: [{ method: 'gift_card', amount: 100000, card_id: 5 }] },
    { invoice_id: 2, tenders: [{ method: 'gift_card', amount: 20000, card_id: 5 }, { method: 'wallet', amount: 50000 }] },
  ]);
});

test('карта — не скидка: discountValue 0, в списке показан остаток, пустая карта не предлагается', () => {
  const card = { id: 5, name: 'Подарок', kind: 'gift_card', amount: 300000, remaining: 120000, active: 1, service_ids: [] };
  assert.equal(discountValue(card, [{ service_id: 1, total: 500000 }]), 0, 'раньше карта снимала полный номинал с каждого визита');
  assert.equal(cardRemaining(card), 120000);
  assert.equal(discountOptionParts(card, (n) => String(n)).value, '120000');
  assert.equal(discountBlockReason({ ...card, remaining: 0 }, { today: '2026-09-26' }), 'exhausted');
  assert.equal(discountBlockReason(card, { today: '2026-09-26' }), '');
});

test('касса: картой и балансом через сервер — остаток карты и баланс уменьшились, платежи gift_card + wallet', async () => {
  seed();
  USER = { id: 9, role: 'cashier', extra_roles: [] };
  const cardId = DB.prepare("INSERT INTO patient_discounts (name, kind, amount) VALUES ('Подарок', 'gift_card', 120000)").run().lastInsertRowid;
  const res = await payFromStoredValue(INVOICES(), { wallet: 150000, card: { id: cardId, remaining: 120000 } });
  assert.deepEqual(res.errors, []);
  assert.equal(res.card, 120000);
  assert.equal(res.wallet, 80000);
  assert.equal(DB.prepare('SELECT remaining FROM patient_discounts WHERE id = ?').get(cardId).remaining, 0);
  assert.equal(await loadPatientBalance(3), 70000);
  assert.deepEqual(INVOICES().map((i) => i.status), ['paid', 'paid']);
  assert.ok(!DBWRITES.some((t) => ['invoices', 'payments', 'patient_discounts', 'card_ledger'].includes(t)));
});
