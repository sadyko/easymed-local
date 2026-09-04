// ACCOMMODATION_DAILY_V1 — счёт за койку выставляют КАЖДЫЙ ДЕНЬ, а не один раз.
//
// Клиника берёт за сутки вперёд: пациент оплатил первый день, назавтра ему
// выставляют второй. Прежняя модель считала проживание одной строкой на всю
// госпитализацию, и как только строка попадала в счёт, дорога закрывалась:
// accommodationLine() находил её же (LIMIT 1, без учёта invoice_item_id), а
// billAccommodation отвечал «Проживание уже в счёте». Второй день выставить
// было нечем — и на экране кнопка даже не появлялась (stale считался только
// для невыставленной строки).
//
// Правило теперь: вносим ОСТАТОК — сутки, за которые ещё не выставляли.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admitPatient } from './inpatient.js';
import { billAccommodation, accommodationState, unbillAccommodation } from './accommodation.js';

const NURSE = { id: 2, role: 'nurse', full_name: 'Медсестра' };
const DOC_ID = 3;

// СТАРЫЙ ПУТЬ ПОСТУПЛЕНИЯ ТЕПЕРЬ ТОЛЬКО ДЛЯ ДООБНОВЛЕНЧЕСКИХ ЗАЯВОК.
// `admit_patient` больше не заводит новую госпитализацию и требует лечащего
// врача (isLegacyAdmission, rpc/inpatient.js): одно нажатие открывало лечение
// без осмотра и без врача. Этой фикстуре нужен просто пациент в койке, поэтому
// она заводит заявку с датой ДО обновления — ровно то, что видит клиника в день
// установки.
function legacyAdmit(db, args, user) {
    db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, created_at)"
             + " VALUES (?,?,'ordered','2000-01-01T00:00:00Z')").run(args.patient_id, args.doctor_id ?? null);
    return admitPatient(db, args, user);
}

function seed({ daysAgo = 1, rate = 250000 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (2,'n','x','nurse','Медсестра')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (3,'d','x','doctor','Др. Азиза')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wid = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Палата 1','daily',?)").run(rate).lastInsertRowid;
  const bid = db.prepare("INSERT INTO beds (ward_id, code, status, price_per_day) VALUES (?,'B-1','free',0)").run(wid).lastInsertRowid;
  const adm = legacyAdmit(db, { patient_id: pid, bed_id: bid, doctor_id: DOC_ID }, NURSE).admission;
  db.prepare("UPDATE admissions SET admitted_at = datetime('now', ?) WHERE id = ?").run('-' + daysAgo + ' days', adm.id);
  return { db, adm };
}
const accLines = (db, id) => db.prepare('SELECT * FROM admission_services WHERE admission_id = ? ORDER BY id').all(id);
const stay = (db, id, days) => db.prepare("UPDATE admissions SET admitted_at = datetime('now', ?) WHERE id = ?").run('-' + days + ' days', id);

// Выставляет открытую строку в настоящий счёт — как это делает касса.
function issueInvoice(db, admId) {
  const line = db.prepare('SELECT * FROM admission_services WHERE admission_id = ? AND invoice_item_id IS NULL ORDER BY id DESC LIMIT 1').get(admId);
  const invId = db.prepare("INSERT INTO invoices (invoice_number, patient_id, subtotal, total_amount, status) VALUES (?,1,?,?,'paid')")
    .run('INV-' + line.id, line.total, line.total).lastInsertRowid;
  const itemId = db.prepare("INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?)")
    .run(invId, 'Проживание', line.quantity, line.unit_price, line.total).lastInsertRowid;
  db.prepare('UPDATE admission_services SET invoice_item_id = ? WHERE id = ?').run(itemId, line.id);
  return line;
}

test('второй день выставляется отдельной строкой после оплаты первого', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  const first = issueInvoice(db, adm.id);
  assert.equal(first.quantity, 1);
  assert.equal(first.total, 250000);

  stay(db, adm.id, 2);                       // наступили вторые сутки
  const out = billAccommodation(db, { admission_id: adm.id }, NURSE);
  assert.equal(out.line.quantity, 1, 'вносим ОДНИ сутки, а не весь срок заново');
  assert.equal(out.line.total, 250000);

  const all = accLines(db, adm.id);
  assert.equal(all.length, 2, 'две строки: оплаченная и новая');
  assert.ok(all[0].invoice_item_id, 'первая осталась выставленной');
  assert.equal(all[1].invoice_item_id, null, 'вторая ждёт счёта');
});

test('оплаченный день не переписывается и не дублируется', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  const first = issueInvoice(db, adm.id);
  stay(db, adm.id, 3);
  billAccommodation(db, { admission_id: adm.id }, NURSE);

  const paid = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(first.id);
  assert.equal(paid.quantity, 1, 'оплаченная строка нетронута');
  assert.equal(paid.total, 250000);
  const open = accLines(db, adm.id).filter((l) => !l.invoice_item_id);
  assert.equal(open.length, 1, 'открытая строка одна');
  assert.equal(open[0].quantity, 2, 'за 2 неоплаченных дня из трёх');
  assert.equal(open[0].total, 500000);
});

test('повторное нажатие до выставления обновляет открытую строку, а не плодит', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  stay(db, adm.id, 2);
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  const all = accLines(db, adm.id);
  assert.equal(all.length, 1, 'ничего не выставляли — строка та же');
  assert.equal(all[0].quantity, 2);
});

test('когда всё выставлено — вносить нечего', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  issueInvoice(db, adm.id);
  assert.throws(() => billAccommodation(db, { admission_id: adm.id }, NURSE), /уже выставлен/i);
});

test('состояние показывает и оплаченное, и остаток', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  issueInvoice(db, adm.id);
  stay(db, adm.id, 3);

  const st = accommodationState(db, { admission_id: adm.id }, NURSE);
  assert.equal(st.invoiced.units, 1, 'сутки, за которые уже выставили');
  assert.equal(st.invoiced.total, 250000);
  assert.equal(st.current.units, 2, 'осталось выставить двое суток');
  assert.equal(st.current.net, 500000);
  assert.equal(st.stay_units, 3, 'а всего пациент лежит трое суток');
  assert.equal(st.billed, null, 'открытой строки ещё нет');
});

test('убрать можно открытую строку, оплаченная остаётся', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  issueInvoice(db, adm.id);
  stay(db, adm.id, 2);
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  unbillAccommodation(db, { admission_id: adm.id }, NURSE);

  const all = accLines(db, adm.id);
  assert.equal(all.length, 1, 'оплаченная строка на месте');
  assert.ok(all[0].invoice_item_id);
});

test('скидка считается от остатка, а не от всего срока', () => {
  const { db, adm } = seed({ daysAgo: 1 });
  billAccommodation(db, { admission_id: adm.id }, NURSE);
  issueInvoice(db, adm.id);
  stay(db, adm.id, 2);
  db.prepare('UPDATE admissions SET accommodation_discount_percent = 50 WHERE id = ?').run(adm.id);
  const out = billAccommodation(db, { admission_id: adm.id }, NURSE);
  assert.equal(out.line.quantity, 1);
  assert.equal(out.line.total, 125000, '50% от одних суток остатка');
});
