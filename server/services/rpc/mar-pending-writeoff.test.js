// OWN_SHELF_ONLY_V1 — ревью F6: отметка «введено» НИКОГДА не отказывается из-за
// склада; препарата нет на полках медсестры — «не списано со склада».
//
// Владелец: «The dose is recorded, so the patient's chart is never blocked.
// The drug is marked «не списано со склада», and the warehouse sees it in a
// list to settle.»
//
// ДЕНЬГИ — при отметке, один раз. Строка admission_services — та же, что у
// обычной выдачи (тот же код dispenseAdmissionItemCore: цена, единица, ставка
// НДС, метка отметки), склад не тронут, а остаток ложится в
// stock_pending_writeoffs. «Списать» (склад/администратор) — ровно один раз,
// обычным движением журнала на ту же строку. Снятие отметки до списания снимает
// и деньги, и запись; после списания — возвращает товар обычным путём.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { getRpc } from './index.js';
import { treatmentOrderCreate, treatmentAdminMark, treatmentAdminUnmark, treatmentOrdersList } from './treatment-orders.js';
import { createInvoiceForAdmission, removeAdmissionLineFromInvoice } from './billing.js';
import { OWN_SHELF_SHORT } from './inventory.js';
import { isReadOnlyRpc } from '../control/gate.js';

const U = {
  admin:  { id: 1, role: 'admin' },
  inv:    { id: 2, role: 'inventory' },
  doctor: { id: 10, role: 'doctor' },
  nurse:  { id: 11, role: 'nurse' },
  senior: { id: 12, role: 'nurse', extra_roles: ['senior_nurse'] },
  reg:    { id: 13, role: 'registrar' },
};
const K = 1;   // Кеторол: коробка по 10 ампул, доза — ампула
const S = 2;   // Шприц, штука

function seed({ on = true } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare('UPDATE stock_settings SET own_shelf_only = ? WHERE id = 1').run(on ? 1 : 0);
  db.prepare("INSERT INTO departments (id, name) VALUES (30, 'Терапия')").run();
  db.prepare("INSERT INTO rooms (id, name, department_id) VALUES (21, 'Процедурный', 30)").run();
  const u = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name, room_id, department_id, extra_roles) VALUES (?,?,?,?,?,?,?,?)');
  u.run(1, 'admin', 'x', 'admin', 'Админ', null, null, '[]');
  u.run(2, 'inv', 'x', 'inventory', 'Кладовщик', null, null, '[]');
  u.run(10, 'doc', 'x', 'doctor', 'Врач Азиз', null, 30, '[]');
  u.run(11, 'nurse', 'x', 'nurse', 'Медсестра Ирина', 21, 30, '[]');
  u.run(12, 'senior', 'x', 'nurse', 'Старшая Ольга', null, 30, '["senior_nurse"]');
  u.run(13, 'reg', 'x', 'registrar', 'Регистратура', null, null, '[]');
  db.prepare(`INSERT INTO products (id, name, unit, base_unit, consumption_unit, consumption_factor, sale_price, on_hand, avg_cost, is_drug, vat_rate)
              VALUES (1, 'Кеторол', 'уп', 'уп', 'амп', 10, 50000, 10, 20000, 1, 12)`).run();
  db.prepare("INSERT INTO products (id, name, unit, base_unit, sale_price, on_hand, avg_cost) VALUES (2, 'Шприц 5 мл', 'шт', 'шт', 1500, 100, 500)").run();
  db.prepare("INSERT INTO patients (id, full_name, mrn) VALUES (1, 'Иванов Иван', 'EM-1')").run();
  db.prepare("INSERT INTO wards (id, name, department_id) VALUES (1, 'Палата 3', 30)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id) VALUES (1, '3-1', 1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1, 'Инъекция', 20000)").run();
  return db;
}
const rpc = (db, name, args, user) => getRpc(name)(db, args, user);
const admission = (db) => Number(db.prepare("INSERT INTO admissions (patient_id, status, ward_id, bed_id, doctor_id, attending_doctor_id) VALUES (1, 'active', 1, 1, 10, 10)").run().lastInsertRowid);
const medOrder = (db, adm, over = {}) => treatmentOrderCreate(db, {
  admission_id: adm, kind: 'med', name: 'Кеторол', dose: '2 амп', route: 'в/м', freq_code: '1x',
  starts_on: '2026-09-04', days: 3, service_id: 1, stock_item_id: K, ...over,
}, U.doctor).order;
const mark = (db, order, user = U.nurse, extra = null, date = '2026-09-04') => treatmentAdminMark(db, {
  order_id: order.id, date, slot: 10, status: 'given', ...(extra ? { extra } : {}),
}, user);
const onHand = (db, pid = K) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(pid).on_hand;
const held = (db, type, id, pid = K) => (db.prepare('SELECT qty FROM stock_holdings WHERE holder_type = ? AND holder_id = ? AND product_id = ?').get(type, id, pid) || { qty: 0 }).qty;
const put = (db, type, id, qty, pid = K) => db.prepare('INSERT INTO stock_holdings (holder_type, holder_id, product_id, qty) VALUES (?, ?, ?, ?)').run(type, id, pid, qty);
const lines = (db, adm) => db.prepare('SELECT * FROM admission_services WHERE admission_id = ? ORDER BY id').all(adm);
const pendings = (db) => db.prepare('SELECT * FROM stock_pending_writeoffs ORDER BY id').all();
const moves = (db, lineId) => db.prepare("SELECT kind, qty, holder_type, holder_id, created_by FROM stock_movements WHERE reference_type = 'admission' AND reference_id = ? ORDER BY id").all(lineId);

// ─── 1. Отметка не отказывается; деньги — при отметке, один раз ──────────────

test('включено, медсестра, дозы нет на полках: «введено» записано, начислено как при обычной выдаче, склад не тронут, «не списано со склада»', () => {
  const db = seed();
  const a = admission(db);
  const m = mark(db, medOrder(db, a));
  assert.equal(m.administration.status, 'given');
  assert.equal(m.stock.status, 'pending');
  assert.match(m.stock.note, /не списано со склада: Кеторол — 2 амп/);
  assert.ok(m.warnings.some((w) => w.code === 'stock_pending' && /не списано со склада/.test(w.message)), JSON.stringify(m.warnings));
  assert.equal(onHand(db), 10, 'склад не тронут');
  const [line] = lines(db, a);
  assert.equal(moves(db, line.id).length, 0, 'движений нет — ничего не взято');
  // Деньги — ровно как у обычной выдачи той же дозы (тот же код, та же строка).
  const ref = seed({ on: false });
  const ra = admission(ref);
  mark(ref, medOrder(ref, ra));
  const [refLine] = lines(ref, ra);
  for (const col of ['quantity', 'unit_price', 'total', 'billable', 'clinic_item_id', 'doctor_id', 'ward_id', 'bed_id', 'goods_vat_rate', 'status']) {
    assert.equal(line[col], refLine[col], col);
  }
  assert.equal(line.notes, refLine.notes, 'метка отметки та же — снятие найдёт строку');
  assert.equal(lines(db, a).length, 1, 'одна строка');
  const [p] = pendings(db);
  assert.deepEqual(
    { status: p.status, kind: p.kind, line: p.admission_service_id, adm: p.admission_id, admin: p.administration_id, product: p.product_id, base: p.base_qty, qty: p.qty, unit: p.unit, by: p.given_by },
    { status: 'pending', kind: 'dose', line: line.id, adm: a, admin: m.administration.id, product: K, base: 0.2, qty: 2, unit: 'амп', by: 11 });
  ref.close(); db.close();
});

test('включено: полки покрывают часть — своё списано с полки, остаток «не списано со склада»; деньги — за всю дозу', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 0.1);   // одна ампула на руках
  mark(db, medOrder(db, a));
  const [line] = lines(db, a);
  assert.equal(line.quantity, 2);
  assert.equal(line.total, 10000);
  assert.equal(held(db, 'staff', 11), 0, 'своя ампула списана');
  assert.deepEqual(moves(db, line.id), [{ kind: 'dispense', qty: -0.1, holder_type: 'staff', holder_id: 11, created_by: 11 }]);
  const [p] = pendings(db);
  assert.deepEqual([p.base_qty, p.qty, p.unit], [0.1, 1, 'амп'], 'ждёт склада одна ампула');
  assert.equal(onHand(db), 10);
  db.close();
});

test('включено: расход сверх дозы не на полках — своя строка и своя запись «не списано», доза с полки — как обычно', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 0.2);
  const m = mark(db, medOrder(db, a), U.nurse, [{ product_id: S, qty: 2, name: 'Шприц (брак)' }]);
  assert.equal(m.stock.status, 'pending');
  const ls = lines(db, a);
  assert.equal(ls.length, 2);
  const p = pendings(db);
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].kind, p[0].product_id, p[0].qty, p[0].unit], ['extra', S, 2, 'шт']);
  assert.equal(held(db, 'staff', 11), 0, 'доза — с полки');
  assert.equal(onHand(db, S), 100);
  db.close();
});

test('повторное нажатие: ни второй строки, ни второй записи «не списано»', () => {
  const db = seed();
  const a = admission(db);
  const o = medOrder(db, a);
  const first = mark(db, o);
  const again = mark(db, o);
  assert.equal(again.already, true);
  assert.equal(again.administration.id, first.administration.id);
  assert.equal(lines(db, a).length, 1);
  assert.equal(pendings(db).length, 1);
  db.close();
});

test('лист врача: «не списано со склада» — отдельной строкой (ждёт склада), а не «провести вручную» для старшей; после «Списать» — снова «списано»', () => {
  const db = seed();
  const a = admission(db);
  mark(db, medOrder(db, a));
  const sheet = treatmentOrdersList(db, { admission_id: a, from: '2026-09-04', to: '2026-09-04' }, U.nurse);
  assert.equal(sheet.stock_issues.count, 0, 'ручной выдачей консоли здесь начислили бы второй раз');
  // А отдельной строкой — видна: «не списано со склада», спишет склад.
  assert.equal(sheet.stock_pending.count, 1);
  assert.match(sheet.stock_pending.items[0].stock_note, /не списано со склада: Кеторол — 2 амп/);
  rpc(db, 'stock_pending_settle', { id: pendings(db)[0].id, source: { type: 'warehouse' } }, U.inv);
  const after = treatmentOrdersList(db, { admission_id: a, from: '2026-09-04', to: '2026-09-04' }, U.nurse);
  assert.equal(after.stock_pending.count, 0, 'склад списал — отметка снова «списано»');
  assert.match(after.orders[0].marks[0].stock_note, /списано складом$/);
  db.close();
});

// ─── 2. Склад: список, счёт, «Списать» ровно один раз ─────────────────────────

test('список склада: пациент, препарат, сколько, кто ввёл, когда, палата и койка; откуда списать и хватит ли', () => {
  const db = seed();
  const a = admission(db);
  // Хирургия — не в цепочке медсестры (её отдел и отдел палаты — Терапия):
  // отсюда склад может списать, а сама медсестра дозу не взяла бы.
  db.prepare("INSERT INTO departments (id, name) VALUES (31, 'Хирургия')").run();
  put(db, 'department', 31, 0.5);
  mark(db, medOrder(db, a));
  const list = rpc(db, 'stock_pending_list', {}, U.inv);
  assert.equal(list.count, 1);
  const [r] = list.rows;
  assert.deepEqual(
    { patient: r.patient_name, product: r.product_name, qty: r.qty, unit: r.unit, who: r.given_by_name, ward: r.ward_name, bed: r.bed_code, kind: r.kind },
    { patient: 'Иванов Иван', product: 'Кеторол', qty: 2, unit: 'амп', who: 'Медсестра Ирина', ward: 'Палата 3', bed: '3-1', kind: 'dose' });
  assert.match(r.given_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(r.sources.map((s) => [s.type, s.id, s.qty_shown, s.enough]), [['warehouse', null, 100, true], ['department', 31, 5, true]]);
  assert.equal(rpc(db, 'stock_pending_count', {}, U.admin).pending, 1);
  for (const who of [U.nurse, U.doctor, U.senior, U.reg]) {
    assert.throws(() => rpc(db, 'stock_pending_list', {}, who), (e) => e.status === 403, who.role);
    assert.throws(() => rpc(db, 'stock_pending_count', {}, who), (e) => e.status === 403, who.role);
    assert.throws(() => rpc(db, 'stock_pending_settle', { id: r.id, source: { type: 'warehouse' } }, who), (e) => e.status === 403, who.role);
  }
  db.close();
});

test('«Списать» со склада — ровно один раз, обычным движением на ту же строку; деньги не меняются', () => {
  const db = seed();
  const a = admission(db);
  const m = mark(db, medOrder(db, a));
  const [line] = lines(db, a);
  const [p] = pendings(db);
  const r = rpc(db, 'stock_pending_settle', { id: p.id, source: { type: 'warehouse' } }, U.inv);
  assert.equal(r.status, 'settled');
  assert.equal(onHand(db), 9.8, 'две ампулы со склада');
  assert.deepEqual(moves(db, line.id), [{ kind: 'dispense', qty: -0.2, holder_type: null, holder_id: null, created_by: 2 }]);
  const after = pendings(db)[0];
  assert.deepEqual([after.status, after.settled_by, after.settled_from_type, after.settled_from_id], ['settled', 2, 'warehouse', null]);
  assert.match(after.settled_at, /Z$/);
  assert.equal(db.prepare('SELECT stock_status FROM treatment_administrations WHERE id = ?').get(m.administration.id).stock_status, 'ok');
  // Второй раз — «уже списано», и склад не тронут второй раз.
  assert.throws(() => rpc(db, 'stock_pending_settle', { id: p.id, source: { type: 'warehouse' } }, U.admin), (e) => e.status === 409 && /Уже списано/.test(e.message));
  assert.equal(onHand(db), 9.8);
  // Деньги: та же одна строка, та же сумма.
  assert.deepEqual(lines(db, a).map((l) => [l.id, l.total]), [[line.id, line.total]]);
  assert.equal(rpc(db, 'stock_pending_count', {}, U.inv).pending, 0);
  db.close();
});

test('«Списать» с выбранной полки; где не хватает — отказ словами, ничего не списано', () => {
  const db = seed();
  const a = admission(db);
  mark(db, medOrder(db, a));
  const [p] = pendings(db);
  put(db, 'staff', 12, 0.1);   // у старшей одна ампула — не хватит
  assert.throws(() => rpc(db, 'stock_pending_settle', { id: p.id, source: { type: 'staff', id: 12 } }, U.inv),
    (e) => e.status === 400 && e.message === 'Не хватает, чтобы списать: Кеторол — нужно 2 амп, есть 1 амп.');
  assert.equal(held(db, 'staff', 12), 0.1);
  assert.equal(pendings(db)[0].status, 'pending');
  put(db, 'department', 30, 0.3);
  rpc(db, 'stock_pending_settle', { id: p.id, source: { type: 'department', id: 30 } }, U.admin);
  assert.equal(held(db, 'department', 30), 0.1);
  assert.equal(onHand(db), 10, 'склад не тронут');
  assert.deepEqual([pendings(db)[0].settled_from_type, pendings(db)[0].settled_from_id], ['department', 30]);
  assert.throws(() => rpc(db, 'stock_pending_settle', { id: p.id, source: { type: 'shelf' } }, U.admin), (e) => e.status === 400);
  db.close();
});

// ─── 3. Снятие отметки ───────────────────────────────────────────────────────

test('снятие ДО списания: деньги сняты, запись «не списано» отменена, на склад НИЧЕГО не вернулось (его и не брали)', () => {
  const db = seed();
  const a = admission(db);
  put(db, 'staff', 11, 0.1);   // одна ампула с полки, одна ждёт склада
  const m = mark(db, medOrder(db, a));
  const back = treatmentAdminUnmark(db, { administration_id: m.administration.id, reason: 'не вводили' }, U.senior);
  assert.equal(back.reversal.reversed, 1);
  assert.equal(lines(db, a).length, 0, 'начисление снято');
  assert.equal(pendings(db)[0].status, 'cancelled');
  assert.equal(held(db, 'staff', 11), 0.1, 'своя ампула вернулась на полку');
  assert.equal(onHand(db), 10, 'на склад не вернулось ничего — со склада не брали');
  assert.throws(() => rpc(db, 'stock_pending_settle', { id: pendings(db)[0].id, source: { type: 'warehouse' } }, U.inv), (e) => e.status === 409);
  assert.equal(onHand(db), 10);
  db.close();
});

test('снятие ПОСЛЕ списания: товар возвращается туда, откуда списан, деньги сняты', () => {
  const db = seed();
  const a = admission(db);
  const m = mark(db, medOrder(db, a));
  rpc(db, 'stock_pending_settle', { id: pendings(db)[0].id, source: { type: 'warehouse' } }, U.inv);
  assert.equal(onHand(db), 9.8);
  treatmentAdminUnmark(db, { administration_id: m.administration.id, reason: 'не вводили' }, U.senior);
  assert.equal(onHand(db), 10, 'вернулось на склад обычным путём');
  assert.equal(lines(db, a).length, 0);
  assert.equal(pendings(db)[0].status, 'settled', 'списание было — след остаётся');
  db.close();
});

test('строка уже в счёте: снятие отметки отменяет «не списано», касса снимает строку — склад не получает лишнего', () => {
  const db = seed();
  const a = admission(db);
  const m = mark(db, medOrder(db, a));
  const [line] = lines(db, a);
  createInvoiceForAdmission(db, { admission_id: a, admission_service_ids: [line.id] }, U.reg);
  const back = treatmentAdminUnmark(db, { administration_id: m.administration.id, reason: 'не вводили' }, U.senior);
  assert.equal(back.reversal.kept, 1, 'строка в счёте — через кассу');
  assert.equal(pendings(db)[0].status, 'cancelled', 'дозы не было — списывать нечего');
  removeAdmissionLineFromInvoice(db, { line_id: line.id }, U.admin);
  assert.equal(lines(db, a).length, 0, 'касса сняла — строка сторнирована (S1)');
  assert.equal(onHand(db), 10, 'на склад не вернулось то, чего не брали');
  db.close();
});

test('строку удалили любым путём (отмена госпитализации и т. п.) — «не списано» закрыто, склад без фантомов', () => {
  const db = seed();
  const a = admission(db);
  mark(db, medOrder(db, a));
  const [line] = lines(db, a);
  rpc(db, 'void_dispensed_admission_item', { p_line: line.id }, U.admin);
  assert.equal(pendings(db)[0].status, 'cancelled');
  assert.equal(onHand(db), 10);
  db.close();
});

// ─── 4. Выключено; отключённый товар; двери выдачи ────────────────────────────

test('выключено: этот случай не возникает — склад добирает, как в 3.12.1, записей «не списано» нет', () => {
  const db = seed({ on: false });
  const a = admission(db);
  const m = mark(db, medOrder(db, a));
  assert.equal(m.stock.status, 'ok');
  assert.equal(onHand(db), 9.8);
  assert.equal(pendings(db).length, 0);
  db.close();
});

test('переключатель выключили, пока записи ждут: список, «Списать» и снятие работают как прежде', () => {
  const db = seed();
  const a = admission(db);
  const o = medOrder(db, a);
  const m1 = mark(db, o);
  const m2 = mark(db, o, U.nurse, null, '2026-09-05');
  db.prepare('UPDATE stock_settings SET own_shelf_only = 0 WHERE id = 1').run();
  assert.equal(rpc(db, 'stock_pending_list', {}, U.inv).rows.length, 2);
  rpc(db, 'stock_pending_settle', { id: pendings(db)[0].id, source: { type: 'warehouse' } }, U.inv);
  assert.equal(onHand(db), 9.8);
  treatmentAdminUnmark(db, { administration_id: m2.administration.id, reason: 'не вводили' }, U.senior);
  assert.equal(pendings(db)[1].status, 'cancelled');
  assert.equal(onHand(db), 10 - 0.2, 'вторая доза склада не касалась');
  treatmentAdminUnmark(db, { administration_id: m1.administration.id, reason: 'не вводили' }, U.senior);
  assert.equal(onHand(db), 10);
  db.close();
});

for (const [mode, on] of [['выключен', false], ['включён', true]]) {
  test(`ревью M1 в силе (переключатель ${mode}): отключённый товар не на полках — предупреждение, без начисления и без «не списано»`, () => {
    const db = seed({ on });
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(K);
    const a = admission(db);
    const m = mark(db, medOrder(db, a));
    assert.equal(m.administration.status, 'given');
    assert.equal(m.stock.status, 'short');
    assert.ok(m.warnings.some((w) => w.code === 'stock'));
    assert.equal(lines(db, a).length, 0);
    assert.equal(pendings(db).length, 0);
    db.close();
  });
}

test('двери выдачи (консоль койки) — как в F4: при включённом отказ «нет на ваших полках», «не списано» только у листа назначений', () => {
  const db = seed();
  const a = admission(db);
  assert.throws(() => rpc(db, 'dispense_admission_item', { p_admission_id: a, p_item_id: K, p_qty: 1 }, U.nurse), (e) => e.code === OWN_SHELF_SHORT);
  assert.equal(pendings(db).length, 0);
  db.close();
});

test('шлюз лицензии: список и счёт — чтение, «Списать» — запись', () => {
  assert.equal(isReadOnlyRpc('stock_pending_list'), true);
  assert.equal(isReadOnlyRpc('stock_pending_count'), true);
  assert.equal(isReadOnlyRpc('stock_pending_settle'), false);
});
