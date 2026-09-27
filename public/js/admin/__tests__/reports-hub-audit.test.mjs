// REPORTS_AUDIT_FIX_V1 (2026-09-27) — хаб отчётов:
//   9  прежняя страница #reports удалена, адрес ведёт в хаб;
//   10 «Итого» складывает колонки, которые назвал сервер, и пропускает строки
//      вне итога — на настоящем ответе run_report;
//   11 выбор филиалов скрыт у видов склада, которые филиал не читают;
//   12 «7 дней» — ровно семь дней, включая сегодня.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = globalThis.document || { documentElement: {}, addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null };
globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };

const { REPORT_DEFS, branchPickerShown, presetRange } = await import('../views/reports-hub.js');
const { reportTotals } = await import('../views/report-totals.js');
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { runReport } = await import('../../../../server/services/rpc/reports.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const admin = { id: 1, role: 'admin' };

test('9: #reports ведёт в хаб; прежней страницы и её выгрузок больше нет', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/admin.js'), 'utf8');
  const legacy = src.slice(src.indexOf('const LEGACY_ROUTES'), src.indexOf('function navigate('));
  assert.match(legacy, /\breports:\s*\{\s*view:\s*'reports-hub'\s*\}/);
  assert.ok(!/views\/reports\.js/.test(src), 'admin.js всё ещё грузит прежнюю страницу');
  assert.ok(!/case 'reports':/.test(src), 'маршрут #reports всё ещё рисует прежнюю страницу');
  for (const f of ['public/js/admin/views/reports.js', 'public/js/admin/views/reports-export.js']) {
    assert.ok(!fs.existsSync(path.join(ROOT, f)), f + ' не удалён');
  }
});

test('10: «Итого» «Счетов» — без отменённых и DEP-, «Цена» «Общей выручки» не складывается', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Приём',50000)").run();
  const inv = db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, discount_amount, total_amount, paid_amount, status, created_at)
                          VALUES (?,1,?,0,?,?,?,'2026-09-10T09:00:00Z')`);
  const a = inv.run('INV-1', 100000, 100000, 100000, 'paid').lastInsertRowid;
  inv.run('INV-2', 70000, 70000, 0, 'void');
  inv.run('DEP-1', 200000, 200000, 200000, 'paid');
  db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?,1,'Приём',2,50000,100000)").run(a);
  const R = { from: '2026-09-01', to: '2026-09-30' };
  const footer = (res) => {
    const numeric = res.columns.map((_, ci) => res.rows.some((r) => typeof r[ci] === 'number'));
    const t = reportTotals(res.columns.map((c) => ({ label: c })), res.rows, (r, _c, ci) => r[ci], (_c, ci) => numeric[ci],
      { summable: res.summable_columns, skipRows: res.total_skip_rows });
    return Object.fromEntries(res.columns.map((c, i) => [c, t[i]]));
  };
  const inv1 = footer(runReport(db, { kind: 'invoices_full', ...R }, admin));
  assert.equal(inv1['Итого'], 100000, 'футер «Счетов» сложил отменённый счёт или депозит');
  const tr = footer(runReport(db, { kind: 'total_revenue', ...R }, admin));
  assert.equal(tr['Цена'], null, 'футер сложил цену за единицу');
  assert.equal(tr['Сумма'], 100000);
});

test('11: выбор филиалов скрыт у расхода, остатков и сроков; у прихода и у выбора зданий — есть', () => {
  const stock = REPORT_DEFS.find((r) => r.kind === 'procurement');
  assert.equal(branchPickerShown(stock, 'procurement', false), true);
  for (const k of ['stock_consumption', 'stock_statement', 'stock_expiry']) {
    assert.equal(branchPickerShown(stock, k, false), false, k + ': филиалы не читаются, а выбор виден');
    assert.equal(branchPickerShown(stock, k, true), true, k + ': здания читаются — выбор зданий нужен');
  }
  const cc = REPORT_DEFS.find((r) => r.kind === 'callcenter');
  assert.equal(branchPickerShown(cc, 'callcenter', true), false);
  assert.equal(branchPickerShown(REPORT_DEFS.find((r) => r.kind === 'total_revenue'), 'total_revenue', false), true);
});

test('12: «7 дней» — семь дней, включая сегодня', () => {
  const [from, to] = presetRange('week', new Date(2026, 8, 27, 15, 0));
  assert.equal(to, '2026-09-27');
  assert.equal(from, '2026-09-21');
  const [f2, t2] = presetRange('week', new Date(2026, 2, 3, 9, 0));   // через границу месяца
  assert.equal(f2, '2026-02-25');
  assert.equal(t2, '2026-03-03');
});
