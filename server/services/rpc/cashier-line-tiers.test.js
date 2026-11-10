// VISIT_TIER_SHOWN_CASHIER_V1 (2026-11-10) — ЯРУС ЦЕНЫ У СТРОК КАССЫ (cashier_line_tiers).
//
// Владелец: убедиться, что изменение цены по счёту визита (второй / повторный
// визит, VISIT_TIER_PRICING_V1) видят касса и регистратура. Касса видела только
// сумму строки; теперь окно оплаты, «Исправить услуги», «Выставить счёт» и
// «Платежи» спрашивают у сервера, у каких строк ярус и какая у них цена первого
// визита.
//
// Здесь — сервер: какие строки попадают в ответ, цена первого визита (каталог или
// своя цена врача — OWN_PRICE_TIER_RATIO_V1), дни от прошлого визита, и когда
// цену первого визита сервер НЕ называет (её нельзя восстановить честно).
// Пример владельца: приём 200 000, второй визит за 1–6 дней — 60 000, повторный —
// бесплатно; врач со своей ценой 300 000 → 90 000 на втором.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { RPC } from './index.js';
import { createInvoiceForVisit } from './billing.js';
import { cashierLineTiers } from './cashier.js';
import { isReadOnlyRpc } from '../control/gate.js';

const registrar = { id: 7, role: 'registrar', full_name: 'Регистратура' };
const cashier = { id: 9, role: 'cashier', full_name: 'Кассир' };
const pharmacist = { id: 12, role: 'pharmacist', full_name: 'Аптека' };
const OWN = 20;      // своя цена 300 000 на приём
const PLAIN = 21;    // своей цены нет

function seed() {
  const db = openDb(':memory:'); migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, is_doctor, extra_roles, is_active) VALUES (?,?,?,?,?,?,?,1)');
  u.run(7, 'reg', 'x', 'registrar', 'Регистратура', 0, '[]');
  u.run(9, 'cash', 'x', 'cashier', 'Кассир', 0, '[]');
  u.run(OWN, 'own', 'x', 'doctor', 'Врач Свой', 1, '[]');
  u.run(PLAIN, 'plain', 'x', 'doctor', 'Врач Каталог', 1, '[]');
  const CONS = Number(db.prepare(`INSERT INTO services (name, price, tax_rate, type, price_secondary, secondary_days_from, secondary_days_to, price_repeat)
                                  VALUES ('Приём терапевта', 200000, 0, 'consultation', 60000, 1, 6, 0)`).run().lastInsertRowid);
  const USG = Number(db.prepare("INSERT INTO services (name, price, tax_rate, type) VALUES ('УЗИ', 80000, 0, 'imaging')").run().lastInsertRowid);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: CONS, pct: 10, price: 300000, branches: [] }, { service_id: USG, pct: 10, branches: [] }]), OWN);
  db.prepare('UPDATE users SET service_rates = ? WHERE id = ?').run(JSON.stringify([
    { service_id: CONS, pct: 10, branches: [] }, { service_id: USG, pct: 10, branches: [] }]), PLAIN);
  const pid = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Тестов Повторный')").run().lastInsertRowid);
  return { db, CONS, USG, pid };
}

// Местный полдень дня «сегодня + offset» — день визита сервер считает тем же 'localtime'.
const dayAt = (db, offset) => db.prepare(
  "SELECT strftime('%Y-%m-%dT%H:%M:%SZ', date('now', 'localtime', ?) || ' 12:00:00', 'utc') AS t",
).get(`${offset >= 0 ? '+' : ''}${offset} days`).t;

function visit(db, pid, offset, status = 'arrived') {
  return Number(db.prepare('INSERT INTO visits (patient_id, visit_date, status, created_by) VALUES (?, ?, ?, 7)')
    .run(pid, dayAt(db, offset), status).lastInsertRowid);
}
function line(db, vid, { service_id, doctor_id, tier = null, status = 'added', unit_price = 0, qty = 1 }) {
  return Number(db.prepare(`INSERT INTO visit_services (visit_id, service_id, doctor_id, quantity, unit_price, total, status, created_by, price_tier)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 7, ?)`).run(vid, service_id, doctor_id, qty, unit_price, unit_price * qty, status, tier).lastInsertRowid);
}
// Прошлый приём этой услуги: первичный, выполнен, `offset` дней назад.
function history(db, pid, serviceId, offset) {
  const v = visit(db, pid, offset);
  line(db, v, { service_id: serviceId, doctor_id: PLAIN, tier: 'primary', status: 'completed' });
  return v;
}
const itemOf = (db, vsId) => db.prepare('SELECT invoice_item_id FROM visit_services WHERE id = ?').get(vsId).invoice_item_id;

test('счёт: строка второго визита — ярус, цена счёта, цена первого визита по каталогу и дни; первичная строка в ответ не попадает', () => {
  const { db, CONS, USG, pid } = seed();
  history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const second = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const usg = line(db, v, { service_id: USG, doctor_id: PLAIN, tier: 'primary' });
  const inv = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [second, usg] }, registrar).invoice;

  const out = cashierLineTiers(db, { invoice_id: inv.id }, cashier);
  assert.equal(out.lines.length, 1, 'в ответе должна быть только строка с ярусом: ' + JSON.stringify(out.lines));
  assert.deepEqual(out.lines[0], {
    visit_service_id: second, invoice_item_id: itemOf(db, second), tier: 'secondary',
    quantity: 1, price: 60000, first_price: 200000, days_since: 3,
  });
  assert.equal(typeof RPC.cashier_line_tiers, 'function', 'RPC не зарегистрирован');
  assert.equal(isReadOnlyRpc('cashier_line_tiers'), true, 'RPC только читает — его место в READ_ONLY_RPCS');
});

test('своя цена врача: второй визит 90 000 (30 % своей), цена первого визита — его своя 300 000', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -2);
  const v = visit(db, pid, 0);
  const second = line(db, v, { service_id: CONS, doctor_id: OWN, tier: 'secondary' });
  const inv = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [second] }, registrar).invoice;
  const [l] = cashierLineTiers(db, { invoice_id: inv.id }, cashier).lines;
  assert.equal(l.price, 90000);
  assert.equal(l.first_price, 300000);
  assert.equal(l.days_since, 2);
});

test('визит без счёта («Выставить счёт»): строки визита по visit_id — цена строки и цена первого визита', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -1);
  const v = visit(db, pid, 0);
  const second = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary', unit_price: 60000, qty: 2 });
  const out = cashierLineTiers(db, { visit_id: v }, cashier);
  assert.deepEqual(out.lines, [{ visit_service_id: second, invoice_item_id: null, tier: 'secondary', quantity: 2, price: 60000, first_price: 200000, days_since: 1 }]);
});

test('цену первого визита сервер НЕ называет, если её нельзя восстановить: цена строки уже не та, каталог правили после счёта, своя цена при бесплатном ярусе', () => {
  const { db, CONS, pid } = seed();
  history(db, pid, CONS, -3);
  // (а) цена второго визита в каталоге изменилась после счёта — сегодняшнее правило дало бы 70 000, в счёте 60 000.
  {
    const v = visit(db, pid, 0);
    const vs = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
    const inv = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [vs] }, registrar).invoice;
    db.prepare("UPDATE services SET price_secondary = 70000 WHERE id = ?").run(CONS);
    const [l] = cashierLineTiers(db, { invoice_id: inv.id }, cashier).lines;
    assert.equal(l.tier, 'secondary', 'чип остаётся: ярус записан в строке');
    assert.equal(l.price, 60000, 'цена — та, что в счёте');
    assert.equal(l.first_price, null, 'цена первого визита — догадка, её нет');
    db.prepare("UPDATE services SET price_secondary = 60000 WHERE id = ?").run(CONS);
  }
  // (б) каталог правили ПОСЛЕ счёта (цена второго визита та же, а первичная — другая): та цена первого визита
  //     могла быть другой, сегодняшняя — догадка.
  {
    const { db: db2, CONS: C2, pid: p2 } = seed();
    history(db2, p2, C2, -3);
    const v = visit(db2, p2, 0);
    const vs = line(db2, v, { service_id: C2, doctor_id: PLAIN, tier: 'secondary' });
    const inv = createInvoiceForVisit(db2, { visit_id: v, visit_service_ids: [vs] }, registrar).invoice;
    db2.prepare("UPDATE services SET price = 250000, updated_at = '2099-01-01T00:00:00Z' WHERE id = ?").run(C2);
    const [l] = cashierLineTiers(db2, { invoice_id: inv.id }, cashier).lines;
    assert.equal(l.price, 60000);
    assert.equal(l.first_price, null, 'каталог изменён после счёта — цены первого визита на тот день нет');
  }
  // (в) повторный визит бесплатно у врача со своей ценой: 0 не зависит от своей цены — проверить её нечем.
  {
    const { db: db3, CONS: C3, pid: p3 } = seed();
    const h1 = visit(db3, p3, -4); line(db3, h1, { service_id: C3, doctor_id: PLAIN, tier: 'primary', status: 'completed' });
    const h2 = visit(db3, p3, -2); line(db3, h2, { service_id: C3, doctor_id: PLAIN, tier: 'secondary', status: 'completed' });
    const v = visit(db3, p3, 0);
    const vs = line(db3, v, { service_id: C3, doctor_id: OWN, tier: 'repeat' });
    const inv = createInvoiceForVisit(db3, { visit_id: v, visit_service_ids: [vs] }, registrar).invoice;
    assert.equal(inv.total_amount, 0);
    const [l] = cashierLineTiers(db3, { invoice_id: inv.id }, cashier).lines;
    assert.equal(l.tier, 'repeat');
    assert.equal(l.price, 0);
    assert.equal(l.first_price, null, 'своя цена при бесплатном ярусе не проверяется');
  }
});

test('повторный бесплатно по каталогу: цена 0, цена первого визита 200 000', () => {
  const { db, CONS, pid } = seed();
  const h1 = visit(db, pid, -4); line(db, h1, { service_id: CONS, doctor_id: PLAIN, tier: 'primary', status: 'completed' });
  const h2 = visit(db, pid, -2); line(db, h2, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary', status: 'completed' });
  const v = visit(db, pid, 0);
  const vs = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'repeat', unit_price: 0 });
  const [l] = cashierLineTiers(db, { visit_id: v }, cashier).lines;
  assert.equal(l.tier, 'repeat');
  assert.equal(l.price, 0);
  assert.equal(l.first_price, 200000);
  assert.equal(l.days_since, 2);
});

test('прошлый визит с тех пор отменили: ярус в строке остаётся, дни не называются', () => {
  const { db, CONS, pid } = seed();
  const h = history(db, pid, CONS, -3);
  const v = visit(db, pid, 0);
  const vs = line(db, v, { service_id: CONS, doctor_id: PLAIN, tier: 'secondary' });
  const inv = createInvoiceForVisit(db, { visit_id: v, visit_service_ids: [vs] }, registrar).invoice;
  db.prepare("UPDATE visits SET status = 'cancelled' WHERE id = ?").run(h);
  const [l] = cashierLineTiers(db, { invoice_id: inv.id }, cashier).lines;
  assert.equal(l.tier, 'secondary');
  assert.equal(l.days_since, null);
  assert.equal(l.first_price, 200000, 'цена первого визита от отмены прошлого визита не зависит');
});

test('отказы: без счёта и визита — 400; неизвестный счёт — 400; роль без доступа к ценам — 403', () => {
  const { db } = seed();
  assert.throws(() => cashierLineTiers(db, {}, cashier), (e) => e.status === 400);
  assert.throws(() => cashierLineTiers(db, { invoice_id: 'x' }, cashier), (e) => e.status === 400);
  assert.throws(() => cashierLineTiers(db, { invoice_id: 999 }, cashier), (e) => e.status === 400);
  assert.throws(() => cashierLineTiers(db, { visit_id: 999 }, cashier), (e) => e.status === 400);
  assert.throws(() => cashierLineTiers(db, { invoice_id: 1 }, pharmacist), (e) => e.status === 403);
});
