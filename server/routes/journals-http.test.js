// JOURNALS_V1 — оба журнала сквозь HTTP на настоящем сервере (createApp):
// массив service_ids в JSON-теле, отказы по-русски, права группы «Журналы»
// после миграции 235 (кассир и оператор — нет, врач без «Отчётов» — нет,
// врач с надстройкой «Главный врач» — да).
//
// «Главный врач» бывает только ДОПОЛНИТЕЛЬНОЙ ролью (EXTRA_ONLY_ROLES,
// services/roles.js): основная — doctor, в extra_roles — head_doctor. Сервер
// авторизует по объединению ролей (effectiveRoles).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

// [логин, основная роль, дополнительные роли, врач]
const USERS = [
  ['admin', 'admin', [], 0],
  ['cashier', 'cashier', [], 0],
  ['operator', 'callcenter', [], 0],
  ['doctor', 'doctor', [], 1],
  ['head', 'doctor', ['head_doctor'], 1],
];
const MARCH = { from: '2026-03-01', to: '2026-03-31' };

function seed(db, ids) {
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'УЗИ брюшной полости', 150000), (2, 'ЭКГ', 60000)").run();
  db.prepare(`INSERT INTO patients (id, mrn, full_name, gender, date_of_birth, phone, passport_number) VALUES
    (1, 'P-1', 'Азизов Бахтиёр', 'male', '1980-05-01', '+998901112233', 'AA1234567'),
    (2, 'P-2', 'Каримова Нилуфар', 'female', '1992-03-15', '+998907776655', 'AB7654321')`).run();
  db.prepare("INSERT INTO wards (id, name, ward_class) VALUES (1, 'Палата 1', 'semi_lux')").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '1-1', 1)").run();
  db.prepare(`INSERT INTO admissions (id, admission_no, patient_id, bed_id, ward_id, attending_doctor_id, status, admitted_at, admission_diagnosis)
              VALUES (1, 'ИБ-1', 1, 1, 1, ?, 'active', '2026-03-10T07:00:00Z', 'K35.8 — Острый аппендицит')`).run(ids.doctor);
  // Стационарная строка (пациент лежит), и амбулаторная — другой пациент без госпитализации.
  db.prepare("INSERT INTO visits (id, patient_id, visit_date, status) VALUES (1, 1, '2026-03-11T07:00:00Z', 'arrived'), (2, 2, '2026-03-15T07:00:00Z', 'arrived')").run();
  db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status) VALUES
    (1, 1, ?, 1, 150000, 150000, 'completed'),
    (2, 2, ?, 1, 60000, 60000, 'queued')`).run(ids.doctor, ids.doctor);
  db.prepare("INSERT INTO invoices (id, invoice_number, admission_id, patient_id, total_amount, paid_amount, status) VALUES (5, 'INV-5', 1, 1, 500000, 500000, 'paid')").run();
  db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (5, 500000, 'cash', '2026-03-12T07:00:00Z')").run();
}

async function start(t) {
  const db = openDb(':memory:');
  migrate(db);
  const pw = hashPassword('password1');
  const ids = {};
  for (const [login, role, extra, isDoctor] of USERS) {
    ids[login] = Number(db.prepare('INSERT INTO users (username, password_hash, full_name, role, extra_roles, is_doctor) VALUES (?,?,?,?,?,?)')
      .run(login, pw, 'Сотрудник ' + login, role, JSON.stringify(extra), isDoctor).lastInsertRowid);
  }
  seed(db, ids);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => new Promise((r) => server.close(() => { db.close(); r(); })));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = {};
  for (const [login] of USERS) {
    const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: login, password: 'password1' }) });
    assert.equal(res.status, 200, 'login ' + login);
    cookie[login] = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  return { base, cookie };
}

async function rpc(ctx, who, args, name = 'run_report') {
  const res = await fetch(ctx.base + '/api/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie[who] }, body: JSON.stringify(args) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const objectsOf = (d) => d.rows.map((row) => Object.fromEntries(d.columns.map((c, i) => [c, row[i]])));

test('HTTP: журнал услуг — массив service_ids в теле доезжает; стационарная строка с лечащим и диагнозом; амбулаторная — «сам»', async (t) => {
  const ctx = await start(t);
  const r = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, service_ids: [1, 2], kind_of_care: 'all' });
  assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
  const d = r.json.data;
  assert.equal(d.columns.length, 13);
  assert.equal(d.notes.length, 5);   // JOURNALS_V1_ALL — пятое: по каким услугам построен
  assert.equal(d.notes[0], 'Журнал построен по выбранным услугам — выбрано услуг: 2.');
  assert.deepEqual(d.notes_t[0], { template: 'Журнал построен по выбранным услугам — выбрано услуг: {n}.', params: { n: '2' } });
  assert.deepEqual(d.summable_columns, []);
  const rows = objectsOf(d);
  assert.equal(rows.length, 2);
  const [inp, out] = rows;
  assert.equal(inp['ИБ №'], 'ИБ-1');
  assert.equal(inp['Кто направил'], 'Сотрудник doctor');
  assert.equal(inp['Лечащий врач'], 'Сотрудник doctor');
  assert.equal(inp['Диагноз при направлении'], 'K35.8 — Острый аппендицит');
  assert.equal(inp['Заключение'], 'Выполнено', 'без документа — статус строки (JOURNALS_V1_CONCLUSION)');
  assert.equal(out['Кто направил'], 'сам');
  assert.equal(out['ИБ №'], '');
  // Числа строкой из <select> и мусор в массиве — принимаются и отбрасываются.
  const mixed = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, service_ids: ['1', 'x', 1, -3], kind_of_care: 'all' });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.json.data.rows.length, 1);
  // «Амбулатория» — без «ИБ №» и «Лечащий врач».
  const amb = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, service_ids: [1, 2], kind_of_care: 'outpatient' });
  assert.equal(amb.status, 200);
  assert.equal(amb.json.data.columns.length, 11);
  assert.ok(!amb.json.data.columns.includes('ИБ №') && !amb.json.data.columns.includes('Лечащий врач'));
  assert.equal(amb.json.data.rows.length, 1);
});

// JOURNALS_V1_ALL (владелец, 02.10) — ничего не выбрано — журнал по всем услугам, не отказ.
test('HTTP: без выбора услуг (пусто, нет аргумента, не массив) — журнал по всем услугам', async (t) => {
  const ctx = await start(t);
  const both = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, service_ids: [1, 2] });
  assert.equal(both.status, 200);
  for (const none of [{ service_ids: [] }, {}, { service_ids: '1' }, { service_ids: ['x', -1] }]) {
    const r = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, ...none });
    assert.equal(r.status, 200, JSON.stringify(none) + ' ' + JSON.stringify(r.json).slice(0, 200));
    assert.deepEqual(r.json.data.rows, both.json.data.rows, JSON.stringify(none));
    assert.equal(r.json.data.notes[0], 'Журнал построен по всем услугам: ни одна не выбрана.');
  }
});

test('HTTP: отказы журнала услуг — по-русски, 400', async (t) => {
  const ctx = await start(t);
  const many = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, service_ids: Array.from({ length: 2001 }, (_, i) => i + 1) });
  assert.equal(many.status, 400);
  assert.match(many.json.error.message, /не больше 2000/);
  const care = await rpc(ctx, 'admin', { kind: 'service_journal', ...MARCH, service_ids: [1], kind_of_care: 'day' });
  assert.equal(care.status, 400);
  assert.match(care.json.error.message, /«Все», «Стационар» или «Амбулатория»/);
});

test('HTTP: реестр — оплата, тип палаты, итог только по «Сумме оплаты»', async (t) => {
  const ctx = await start(t);
  const r = await rpc(ctx, 'admin', { kind: 'inpatient_register', ...MARCH });
  assert.equal(r.status, 200);
  const [row] = objectsOf(r.json.data);
  assert.equal(row['ИБ №'], 'ИБ-1');
  assert.equal(row['Сумма оплаты'], 500000);
  assert.equal(row['Тип палаты'], 'Полулюкс');
  assert.equal(row['Дата оплаты'], '2026-03-12');
  assert.equal(row['Паспорт'], 'AA1234567');
  assert.deepEqual(r.json.data.summable_columns, ['Сумма оплаты']);
  assert.equal(r.json.data.total_label, 'Сумма оплаты');
});

test('HTTP: права «Журналов» — кассир, оператор и врач 403, врач с «Главным врачом» 200; списков-фильтров журналы не отдают', async (t) => {
  const ctx = await start(t);
  for (const kind of ['service_journal', 'inpatient_register']) {
    const args = { kind, ...MARCH, service_ids: [1] };
    assert.equal((await rpc(ctx, 'cashier', args)).status, 403, kind + ': кассир');
    assert.equal((await rpc(ctx, 'operator', args)).status, 403, kind + ': оператор колл-центра');
    assert.equal((await rpc(ctx, 'doctor', args)).status, 403, kind + ': врач');
    const head = await rpc(ctx, 'head', args);
    assert.equal(head.status, 200, kind + ': врач с «Главным врачом» — ' + JSON.stringify(head.json).slice(0, 200));
    assert.equal(head.json.data.rows.length, 1);
    const ch = await rpc(ctx, 'head', { kind, arg: 'doctor_id' }, 'report_choices');
    assert.equal(ch.status, 200);
    assert.deepEqual(ch.json.data, { choices: [] });
  }
  // Главному врачу открыты только журналы — не деньги; кассиру его касса — как была.
  assert.equal((await rpc(ctx, 'head', { kind: 'total_revenue', ...MARCH })).status, 403);
  assert.equal((await rpc(ctx, 'cashier', { from: MARCH.from, to: MARCH.to }, 'cashier_report')).status, 200);
});
