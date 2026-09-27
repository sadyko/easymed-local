// V3120_FINAL (S1) — снятая отметка о введении не оставляет денег за дозу.
//
// Строка дозы, уже попавшая в счёт, при снятии отметки остаётся (за ней счёт),
// и медсестре говорят «уберите через кассу». Касса убирает — отменяет счёт или
// снимает строку со счёта, — но строка лишь теряла ссылку на счёт и снова
// оказывалась «к оплате», а препарат — списанным: при выписке пациент платил
// за неведённую дозу. Теперь отпущенная со счёта строка СНЯТОЙ отметки
// сторнируется: препарат возвращается, строки нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { dueAtMs } from '../domain/mar-schedule.js';
import { treatmentOrderCreate, treatmentAdminMark, treatmentAdminUnmark } from './treatment-orders.js';
import { createInvoiceForAdmission, removeAdmissionLineFromInvoice } from './billing.js';
import { voidInvoice } from './cashier.js';
import { admissionBalance } from './inpatient.js';

const ACTOR = {
  admin:        { id: 9, role: 'admin' },
  doctor:       { id: 1, role: 'doctor' },
  nurse:        { id: 2, role: 'nurse' },
  senior_nurse: { id: 5, role: 'nurse', extra_roles: ['senior_nurse'] },
  registrar:    { id: 6, role: 'registrar' },
};

const START = '2026-09-04';
const localTs = (date, hour, min = 0) => new Date(dueAtMs(date, hour) + min * 60000).toISOString();

// Склад клиники. Единицы разные НАМЕРЕННО: на них и держится половина этих
// тестов — «1 г» при складе в штуках количества не даёт.
function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(1, 'doc', 'x', 'Лечащий', 'doctor');
  u.run(2, 'nur', 'x', 'Медсестра', 'nurse');
  u.run(5, 'snur', 'x', 'Старшая', 'nurse');
  u.run(6, 'reg', 'x', 'Регистратура', 'registrar');
  u.run(9, 'boss', 'x', 'Админ', 'admin');
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'Иванов Иван'),(2,'Петров Пётр')").run();
  db.prepare("INSERT INTO wards (id, name, billing_mode, price_per_day) VALUES (1,'Терапия','daily',150000),(2,'Хирургия','daily',250000)").run();
  db.prepare("INSERT INTO beds (id, code, ward_id, status) VALUES (1,'K-1',1,'occupied'),(2,'K-2',2,'occupied')").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Инъекция в/м',20000)").run();
  const p = db.prepare('INSERT INTO products (id, name, unit, category, sale_price, on_hand, active) VALUES (?,?,?,?,?,?,1)');
  p.run(1, 'Цефтриаксон 1 г', 'шт', 'drug', 12000, 20);       // штучный флакон
  p.run(2, 'Натрия хлорид 0,9%', 'мл', 'drug', 200, 500);     // объёмный
  p.run(3, 'Шприц 5 мл', 'шт', 'consumable', 1500, 100);      // расход сверх дозы
  p.run(4, 'Кеторол', 'шт', 'drug', 8000, 0);                 // пустой остаток
  return db;
}

function admission(db, over = {}) {
  const cols = { patient_id: 1, ward_id: 1, bed_id: 1, doctor_id: 1, attending_doctor_id: 1, status: 'active', ...over };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO admissions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid;
}

function order(db, admissionId, over = {}) {
  return treatmentOrderCreate(db, {
    admission_id: admissionId, kind: 'med', name: 'Цефтриаксон', dose: '1 шт', route: 'в/м',
    freq_code: '3x', starts_on: START, days: 5, service_id: 1, stock_item_id: 1, ...over,
  }, ACTOR.doctor).order;
}

const mark = (db, o, over = {}, who = ACTOR.nurse) =>
  treatmentAdminMark(db, { order_id: o.id, date: START, slot: 6, status: 'given', ...over }, who);

// UNMARK_WINDOW_V1 — состарить отметку, не поспав пятнадцати минут: given_at
// переписывается ТЕМИ ЖЕ часами, по которым правило её и читает.
const ageMark = (db, id, minutes) => db.prepare(
  "UPDATE treatment_administrations SET given_at = strftime('%Y-%m-%dT%H:%M:%SZ','now',?) WHERE id = ?")
  .run(`-${minutes} minutes`, id);

const onHand = (db, id) => db.prepare('SELECT on_hand FROM products WHERE id = ?').get(id).on_hand;
const movements = (db, productId) => db.prepare(
  'SELECT * FROM stock_movements WHERE product_id = ? ORDER BY id').all(productId);
const lines = (db, admissionId) => db.prepare(
  'SELECT * FROM admission_services WHERE admission_id = ? ORDER BY id').all(admissionId);

const CASH = { id: 9, role: 'admin' };

function givenAndInvoiced() {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  const m = mark(db, o);
  const lineId = lines(db, adm)[0].id;
  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [lineId] }, ACTOR.registrar);
  const back = treatmentAdminUnmark(db, { administration_id: m.administration.id, reason: 'не вводили' }, ACTOR.senior_nurse);
  assert.equal(back.reversal.kept, 1, 'строка в счёте осталась — касса');
  assert.equal(onHand(db, 1), 19);
  return { db, adm, lineId, invoice };
}

test('S1: касса отменила счёт — строка снятой дозы сторнируется, препарат вернулся', () => {
  const { db, adm, invoice } = givenAndInvoiced();
  voidInvoice(db, { invoice_id: invoice.id, in_bed_ack: true, reason: 'доза снята' }, CASH);
  assert.equal(lines(db, adm).length, 0, 'строка за неведённую дозу снова «к оплате»');
  assert.equal(onHand(db, 1), 20, 'препарат не вернулся на склад');
  assert.equal(admissionBalance(db, adm).balance, 0);
  db.close();
});

test('S1: строку сняли со счёта — то же самое', () => {
  const { db, adm, lineId } = givenAndInvoiced();
  removeAdmissionLineFromInvoice(db, { line_id: lineId }, CASH);
  assert.equal(lines(db, adm).length, 0);
  assert.equal(onHand(db, 1), 20);
  db.close();
});

test('S1: у ДЕЙСТВУЮЩЕЙ отметки строка при отмене счёта остаётся к выставлению', () => {
  const db = seed();
  const adm = admission(db);
  const o = order(db, adm);
  mark(db, o);
  const lineId = lines(db, adm)[0].id;
  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm, admission_service_ids: [lineId] }, ACTOR.registrar);
  voidInvoice(db, { invoice_id: invoice.id, in_bed_ack: true }, CASH);
  const [l] = lines(db, adm);
  assert.ok(l, 'введённая доза пропала');
  assert.equal(l.invoice_item_id, null);
  assert.equal(onHand(db, 1), 19);
  db.close();
});
