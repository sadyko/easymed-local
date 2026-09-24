// REPORTS_V2, ревью M2 — выгрузка «Рефералы» на старой странице «#reports»
// считала ТРЕТЬЕ число вознаграждения (visit_services, без скидки, по дате
// визита, неоплаченные тоже). Теперь она — тот же серверный отчёт 'referrals',
// что карточка в «Отчётах»: проверяется, что ответ совпадает до ячейки.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = globalThis.document || { documentElement: {}, addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null };
globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };

const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { runReport } = await import('../../../../server/services/rpc/reports.js');

const db = openDb(':memory:');
migrate(db);
const cat = db.prepare("INSERT INTO referral_source_categories (name, standard_percent) VALUES ('Партнёры', 10)").run().lastInsertRowid;
const src = db.prepare("INSERT INTO referral_sources (name, category_id) VALUES ('Клиника Х', ?)").run(cat).lastInsertRowid;
db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1,'P-1','Азизов А.')").run();
db.prepare("INSERT INTO services (id, name, price, tax_rate) VALUES (1,'УЗИ',200000,0)").run();
const today = new Date();
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
db.prepare("INSERT INTO visits (id, patient_id, visit_date, referral_source_id) VALUES (1,1,?,?)").run(today.toISOString(), src);
// Оплаченный счёт со скидкой и неоплаченный — прежняя выгрузка платила с обоих и без скидки.
db.prepare(`INSERT INTO invoices (id, invoice_number, visit_id, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
            VALUES (1,'INV-1',1,1,200000,20000,180000,180000,'paid',?), (2,'INV-2',1,1,200000,0,200000,0,'unpaid',?)`).run(today.toISOString(), today.toISOString());
db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (1,1,'УЗИ',1,200000,200000), (2,1,'УЗИ',1,200000,200000)").run();

const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const body = JSON.parse((opts && opts.body) || '{}');
  if (u === '/api/rpc/run_report') {
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ data: runReport(db, body, { id: 1, role: 'admin' }) }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: [] }) };
};

const { buildReferralReport, REFERRAL_COLUMNS } = await import('../views/reports-export.js');

test('выгрузка «Рефералы» — серверный отчёт referrals, числа те же, что в «Отчётах»', async () => {
  const rows = await buildReferralReport({ period: 'month' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'referrals');
  assert.match(calls[0].from, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[0].to, ymd(today));
  const hub = runReport(db, { kind: 'referrals', from: calls[0].from, to: calls[0].to }, { id: 1, role: 'admin' });
  assert.equal(rows.length, hub.rows.length);
  assert.deepEqual(REFERRAL_COLUMNS.map((c) => c.label), hub.columns);
  assert.deepEqual(REFERRAL_COLUMNS.map((c) => rows[0][c.key]), hub.rows[0]);
  // 10 % от 180 000 оплаченного — не 40 000 (с обоих счетов без скидки).
  assert.equal(rows[0]['Вознаграждение'], 18000);
});
