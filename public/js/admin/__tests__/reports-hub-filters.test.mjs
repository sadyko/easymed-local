// REPORTS_TAX_PAY_V1 (владелец, 2026-11-07) — фильтры в окне отчёта ДО выгрузки
// в Excel: способ оплаты, кассир, врач, группа услуг, группа пациентов.
//
// Договор трёх сторон: карточка отчёта (REPORT_DEFS) называет фильтры,
// конструктор отправляет их аргументами run_report / cashier_report, сервер
// отбирает строки — и в Excel уходят ровно отобранные строки (reportSheets
// строит лист из того же ответа). Пример владельца: «только пациенты,
// оплатившие картой → Excel».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = globalThis.document || { documentElement: {}, addEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null };
globalThis.window = globalThis.window || { location: { hostname: 'localhost' }, localStorage: globalThis.localStorage, addEventListener() {}, dispatchEvent() { return true; } };

const { REPORT_DEFS, optionsFor, reportArgs, defaultReportOptions, reportKinds } = await import('../views/reports-hub.js');
const { reportSheets } = await import('../views/report-totals.js');
const { activeFilters, filterFileSuffix } = await import('../views/report-filters.js');
const { openDb } = await import('../../../../server/db/connection.js');
const { migrate } = await import('../../../../server/db/migrate.js');
const { runReport } = await import('../../../../server/services/rpc/reports.js');
const { cashierReport } = await import('../../../../server/services/rpc/cashier-report.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const hub = fs.readFileSync(path.join(ROOT, 'public', 'js', 'admin', 'views', 'reports-hub.js'), 'utf8');
const def = (kind) => REPORT_DEFS.find((d) => d.kind === kind);
const args = (kind) => (view) => optionsFor(def(kind), view || kind).map((o) => o.arg);
const tx = { tr: (s) => s, trf: (t, p) => Object.entries(p || {}).reduce((s, [k, v]) => s.split('{' + k + '}').join(String(v)), t), lang: 'ru', monthName: () => '' };

test('у каждого денежного окна — свои фильтры (где у отчёта есть это измерение)', () => {
  const ALL = ['pay_method', 'cashier_id', 'doctor_id', 'group', 'patient_group'];
  assert.deepEqual(args('total_revenue')(), ALL);
  assert.deepEqual(args('invoices_full')(), ALL);
  assert.deepEqual(args('cashier')(), ALL);
  assert.deepEqual(args('surgery_profit')(), ['pay_method', 'cashier_id', 'doctor_id', 'patient_group']);
  assert.deepEqual(args('by_services')(), ['paid', 'group', 'pay_method', 'cashier_id', 'doctor_id', 'patient_group']);
  assert.deepEqual(args('doctor_salaries')(), ['doctor_id']);
  assert.deepEqual(args('inpatient_share')(), ['doctor_id', 'group', 'patient_group']);
  assert.deepEqual(args('by_specialty')(), ['doctor_id', 'group', 'patient_group']);
  assert.deepEqual(args('referrals')(), ['referrer', 'group', 'patient_group']);
  assert.deepEqual(args('by_doctors')('by_doctors'), ['doctor_id']);
  assert.deepEqual(args('by_doctors')('doctor_lines'), ['doctor_id', 'group', 'patient_group']);
  // Журналы, склад, колл-центр и Telegram — без денежных фильтров.
  assert.deepEqual(args('service_journal')(), ['service_ids', 'kind_of_care']);
  assert.deepEqual(args('inpatient_register')(), []);
  assert.ok(!args('procurement')().includes('pay_method'));
});

test('«все» не уезжает на сервер; выбранное — уезжает', () => {
  const d = def('total_revenue');
  assert.deepEqual(reportArgs(d, 'total_revenue', defaultReportOptions(d)), {});
  assert.deepEqual(reportArgs(d, 'total_revenue', { ...defaultReportOptions(d), pay_method: 'card', patient_group: '3' }),
    { pay_method: 'card', patient_group: '3' });
});

test('конструктор: статический список не спрашивает сервер, фильтры уезжают и у кассы, имя файла — с фильтрами', () => {
  assert.match(hub, /if \(!isStaticOption\(o\) && !st\.loaded\[o\.arg\] && !st\.loading\.has\(o\.arg\)\)/);
  assert.match(hub, /supabase\.rpc\(rep\.rpc \|\| 'owner_report', \{ \.\.\.args, \.\.\.reqArgs \}\)/);
  assert.match(hub, /XLSX\.writeFile\(wb, `\$\{st\.kind\}_\$\{st\.from\}_\$\{st\.to\}\$\{filterFileSuffix\(st\.resultFilters \|\| \[\], reportTx\(\)\)\}\.xlsx`\)/);
  // Фильтры берутся ДО ожидания ответа и запоминаются вместе с ответом;
  // сброс результата их забывает — старая таблица не уедет под новыми фильтрами.
  const gen = hub.slice(hub.indexOf('async function generate()'), hub.indexOf('overlay.appendChild', hub.indexOf('async function generate()')));
  assert.ok(gen.indexOf('const reqFilters = activeFilters(rep, reqKind, st.opts, st.loaded);') < gen.indexOf('await supabase.rpc'));
  assert.match(gen, /st\.resultFilters = reqFilters;/);
  assert.match(hub, /st\.resultFilters = null;/);
  // Таблицы кассы — тоже с фильтрами в имени файла.
  assert.match(hub, /renderCashierReport\(el, data, st \? st\.from \+ '_' \+ st\.to \+ filterFileSuffix\(st\.resultFilters \|\| \[\], reportTx\(\)\) : ''\)/);
});

// Клиника: счёт 100 000 — 60 000 наличными + 40 000 картой; счёт 30 000 — наличными.
function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name) VALUES (1, 'adm', 'x', 'admin', 'Админ'), (5, 'ca', 'x', 'cashier', 'Кассир А')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'A-1', 'Азизов А.'), (2, 'B-2', 'Бобров Б.')").run();
  db.prepare("INSERT INTO services (id, name, price, type) VALUES (1, 'Приём', 100000, 'consultation')").run();
  const at = '2026-11-05T06:00:00Z';
  const inv = (no, pid, total) => db.prepare(`INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, paid_amount, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'paid', ?)`).run(no, pid, total, total, total, at).lastInsertRowid;
  const item = (id, total) => db.prepare("INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price, total) VALUES (?, 1, 'Приём', 1, ?, ?)").run(id, total, total);
  const pay = (id, amount, method) => db.prepare('INSERT INTO payments (invoice_id, amount, method, cashier_id, paid_at) VALUES (?, ?, ?, 5, ?)').run(id, amount, method, at);
  const a = inv('INV-1', 1, 100000); item(a, 100000); pay(a, 60000, 'cash'); pay(a, 40000, 'card');
  const b = inv('INV-2', 2, 30000); item(b, 30000); pay(b, 30000, 'cash');
  return db;
}
const RANGE = { from: '2026-11-01', to: '2026-11-30' };
const ADMIN = { id: 1, role: 'admin' };

test('пример владельца: «оплатили картой» → в Excel только карточная часть, итог 40 000, имя файла говорит о фильтре', () => {
  const db = clinic();
  try {
    for (const kind of ['total_revenue', 'invoices_full']) {
      const d = def(kind);
      const opts = { ...defaultReportOptions(d), pay_method: 'card' };
      const r = runReport(db, { kind, ...RANGE, ...reportArgs(d, kind, opts) }, ADMIN);
      const sheet = reportSheets(r, tx).report;
      const head = sheet[0];
      const body = sheet.slice(1, -1);
      const total = sheet[sheet.length - 1];
      assert.equal(body.length, 1, kind + ': в листе только строка, оплаченная картой');
      assert.equal(body[0][head.indexOf('Способ оплаты')], 'Карта');
      assert.equal(total[head.indexOf('Сумма с НДС')], 40000, kind + ': «Итого» листа — по отобранным строкам');
      const af = activeFilters(d, kind, opts, {});
      assert.equal(`${kind}_${RANGE.from}_${RANGE.to}${filterFileSuffix(af, tx)}.xlsx`, `${kind}_2026-11-01_2026-11-30_Способ оплаты Карта.xlsx`);
    }
    // Касса: плоская выгрузка «Скачать Excel» — те же строки, что на экране.
    const cd = def('cashier');
    const cr = cashierReport(db, { ...RANGE, ...reportArgs(cd, 'cashier', { ...defaultReportOptions(cd), pay_method: 'card' }) }, ADMIN);
    assert.equal(cr.rows.length, 1);
    assert.equal(cr.kpi.income, 40000);
  } finally { db.close(); }
});

test('без фильтров — всё, как прежде по сумме: способы — частями', () => {
  const db = clinic();
  try {
    const r = runReport(db, { kind: 'total_revenue', ...RANGE }, ADMIN);
    const sheet = reportSheets(r, tx).report;
    const head = sheet[0];
    assert.deepEqual(sheet.slice(1, -1).map((row) => row[head.indexOf('Способ оплаты')]), ['Наличные', 'Карта', 'Наличные']);
    assert.equal(sheet[sheet.length - 1][head.indexOf('Сумма с НДС')], 130000);
    assert.ok(reportKinds(def('total_revenue')).length === 1);
  } finally { db.close(); }
});
