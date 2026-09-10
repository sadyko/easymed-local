// ACT_OF_WORKS_V1 — акт выполненных работ: что начислено, что в счёте, что нет.
//
// Владелец: «we need to build … act of done things». Проверяется то, ради чего
// экран и делается:
//
//   1. в акт попадает ВСЁ начисленное — услуга, расходник со склада, койко-день;
//   2. итоги считает СЕРВЕР: две суммы, посчитанные в разных местах, разойдутся,
//      и спорить с пациентом придётся о той, которую он увидел;
//   3. выставленная строка знает свой счёт и БОЛЬШЕ НЕ ПРАВИТСЯ: за ней деньги;
//   4. «не в счёт» — настоящий переключатель: расходник за счёт клиники не
//      обязан навсегда оставаться в счёте пациента.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admitPatient } from './inpatient.js';
import { billAccommodation } from './accommodation.js';
import { dispenseAdmissionItem } from './inventory.js';
import { createInvoiceForAdmission } from './billing.js';
import { admissionCharges, admissionChargeSetBillable, admissionServiceAdd, admissionServiceDone } from './admission-charges.js';

const NURSE = { id: 2, role: 'nurse', full_name: 'Медсестра' };
const CASH  = { id: 9, role: 'cashier', full_name: 'Касса' };
const LAB   = { id: 5, role: 'lab', full_name: 'Лаборант' };
const DOC_ID = 3;

function seed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (2,'n','x','nurse','Медсестра')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (9,'c','x','cashier','Касса')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (5,'l','x','lab','Лаборант')").run();
  db.prepare("INSERT INTO users (id,username,password_hash,role,full_name) VALUES (3,'d','x','doctor','Др. Азиза')").run();
  const pid = db.prepare("INSERT INTO patients (full_name) VALUES ('Пациент')").run().lastInsertRowid;
  const wid = db.prepare("INSERT INTO wards (name, billing_mode, price_per_day) VALUES ('Палата 1','daily',200000)").run().lastInsertRowid;
  const bid = db.prepare("INSERT INTO beds (ward_id, code, status, price_per_day) VALUES (?,'B-1','free',0)").run(wid).lastInsertRowid;
  // Размещение делается тем же обходным путём, что и в accommodation.test.js:
  // прямое admitPatient сегодня отказывает (пациент должен пройти заявку и
  // осмотр), а этому тесту нужна лежащая госпитализация, а не проверка маршрута.
  db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, created_at) VALUES (?,?,'ordered','2000-01-01T00:00:00Z')").run(pid, DOC_ID);
  const adm = admitPatient(db, { patient_id: pid, bed_id: bid, doctor_id: DOC_ID }, NURSE).admission;
  db.prepare("UPDATE admissions SET admitted_at = datetime('now','-2 days') WHERE id = ?").run(adm.id);
  // Товар со склада с остатком: расходник списывают со склада, а не из воздуха.
  const prod = db.prepare(`INSERT INTO products (name, sale_price, consumption_unit, base_unit)
                           VALUES ('Система для инфузий', 7000, 'шт.', 'pcs')`).run().lastInsertRowid;
  db.prepare('UPDATE products SET on_hand = 100 WHERE id = ?').run(prod);   // списывают со СКЛАДА, а не из воздуха
  const svc = db.prepare("INSERT INTO services (name, price) VALUES ('Перевязка', 50000)").run().lastInsertRowid;
  return { db, adm, pid, prod, svc };
}

/** Услуга начисляется строкой того же вида, что и всё остальное. */
function addService(db, admId, svcId, price) {
  db.prepare(`INSERT INTO admission_services (admission_id, service_id, doctor_id, quantity, unit_price, total, billable)
              VALUES (?,?,?,1,?,?,1)`).run(admId, svcId, DOC_ID, price, price);
}

test('в акт попадает ВСЁ начисленное: услуга, расходник и койко-день', () => {
  const { db, adm, prod, svc } = seed();
  try {
    billAccommodation(db, { admission_id: adm.id }, NURSE);
    addService(db, adm.id, svc, 50000);
    dispenseAdmissionItem(db, { admission_id: adm.id, product_id: prod, quantity: 3, billable: true }, NURSE);

    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    const kinds = act.lines.map((l) => l.kind).sort();
    assert.deepEqual(kinds, ['item', 'service', 'stay'], 'в акте не все роды строк: ' + kinds.join(', '));

    const stay = act.lines.find((l) => l.kind === 'stay');
    assert.equal(stay.quantity, 2, 'двое суток проживания');
    assert.equal(stay.total, 400000);
    assert.ok(stay.name, 'у койко-дня должно быть человеческое имя: его читает касса');

    const item = act.lines.find((l) => l.kind === 'item');
    assert.match(item.name, /Система/);
    assert.equal(item.unit, 'шт.', 'единица расходника берётся у товара');
    assert.equal(item.quantity, 3);

    const service = act.lines.find((l) => l.kind === 'service');
    assert.match(service.name, /Перевязка/);
    assert.equal(service.doctor_name, 'Др. Азиза', 'у услуги видно, кто её сделал');
  } finally { db.close(); }
});

test('итоги считает СЕРВЕР: начислено, к выставлению, в счетах, не в счёт', () => {
  const { db, adm, prod, svc } = seed();
  try {
    addService(db, adm.id, svc, 50000);
    dispenseAdmissionItem(db, { admission_id: adm.id, product_id: prod, quantity: 1, billable: false }, NURSE);

    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    assert.equal(act.totals.accrued, 57000, 'начислено — всё, включая то, что не в счёт');
    assert.equal(act.totals.billable, 50000);
    assert.equal(act.totals.not_billable, 7000, 'расходник за счёт клиники виден отдельной суммой');
    assert.equal(act.totals.pending, 50000, 'к выставлению — то, что в счёт, но ещё без счёта');
    assert.equal(act.totals.invoiced, 0);
    assert.equal(act.totals.lines, 2);
  } finally { db.close(); }
});

test('выставленная строка знает свой счёт и больше не правится', () => {
  const { db, adm, svc } = seed();
  try {
    addService(db, adm.id, svc, 50000);
    const before = admissionCharges(db, { admission_id: adm.id }, CASH);
    const lineId = before.lines[0].id;

    createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [lineId] }, CASH);

    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    const line = act.lines[0];
    assert.ok(line.invoice_id, 'строка не знает своего счёта');
    assert.ok(line.invoice_number, 'номер счёта — то, что называют пациенту');
    assert.equal(line.locked, true);
    assert.equal(act.totals.invoiced, 50000);
    assert.equal(act.totals.pending, 0, 'выставленное больше не ждёт выставления');

    // За строкой деньги: пока она в счёте, «не в счёт» ей не поставить.
    assert.throws(() => admissionChargeSetBillable(db, { line_id: lineId, billable: false }, CASH),
      /в счёте/i);
  } finally { db.close(); }
});

test('«не в счёт» — настоящий переключатель, и роль его спрашивают', () => {
  const { db, adm, prod } = seed();
  try {
    dispenseAdmissionItem(db, { admission_id: adm.id, product_id: prod, quantity: 2, billable: true }, NURSE);
    const line = admissionCharges(db, { admission_id: adm.id }, CASH).lines[0];
    assert.equal(line.billable, true);

    admissionChargeSetBillable(db, { line_id: line.id, billable: false }, CASH);
    const off = admissionCharges(db, { admission_id: adm.id }, CASH).lines[0];
    assert.equal(off.billable, false, 'расходник за счёт клиники так и не исключился');
    assert.equal(admissionCharges(db, { admission_id: adm.id }, CASH).totals.pending, 0);

    // Вернуть в счёт можно тем же переключателем.
    admissionChargeSetBillable(db, { line_id: line.id, billable: true }, CASH);
    assert.equal(admissionCharges(db, { admission_id: adm.id }, CASH).lines[0].billable, true);

    // Лаборанту акт не показывают вовсе: это счёт пациента, а не палата.
    // Проживание он видеть может (accommodation.js) — там речь о койке; здесь
    // речь о деньгах, и круг у них разный намеренно.
    assert.throws(() => admissionCharges(db, { admission_id: adm.id }, LAB), /роли/i);
    assert.throws(() => admissionChargeSetBillable(db, { line_id: line.id, billable: false }, LAB), /роли/i);
  } finally { db.close(); }
});

// ACT_ADD_SERVICE_V1 — владелец: «add analyses and diagnostics, add surgery».
test('услуга начисляется госпитализации по цене СПРАВОЧНИКА и попадает в акт', () => {
  const { db, adm, svc } = seed();
  const DOC = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };
  try {
    // Цена приходит из справочника, а не из аргументов: присланную ценой
    // можно подделать запросом, а здесь деньги.
    admissionServiceAdd(db, { admission_id: adm.id, service_id: svc, quantity: 2, unit_price: 1 }, DOC);

    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    assert.equal(act.lines.length, 1);
    const line = act.lines[0];
    assert.equal(line.kind, 'service');
    assert.match(line.name, /Перевязка/);
    assert.equal(line.quantity, 2);
    assert.equal(line.unit_price, 50000, 'цена взята не из справочника');
    assert.equal(line.total, 100000);
    assert.equal(line.billable, true);
    assert.equal(act.totals.pending, 100000);
  } finally { db.close(); }
});

test('услугу назначает врач, а не касса, и не в закрытую госпитализацию', () => {
  const { db, adm, svc } = seed();
  const DOC = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };
  try {
    // Назначение услуги — решение клиническое: касса его не принимает.
    assert.throws(() => admissionServiceAdd(db, { admission_id: adm.id, service_id: svc }, CASH), /роли/i);
    assert.throws(() => admissionServiceAdd(db, { admission_id: adm.id, service_id: 9999 }, DOC), /справочник/i);
    assert.throws(() => admissionServiceAdd(db, { admission_id: adm.id }, DOC), /Услуга не выбрана/i);

    // Выписанному пациенту услуги не дописывают задним числом.
    db.prepare("UPDATE admissions SET status='discharged' WHERE id=?").run(adm.id);
    assert.throws(() => admissionServiceAdd(db, { admission_id: adm.id, service_id: svc }, DOC), /закрыт/i);
  } finally { db.close(); }
});

test('акт несуществующей госпитализации — отказ, а не пустой список', () => {
  const { db } = seed();
  try {
    // Пустой акт и «нет такой госпитализации» — разные вещи: пустой список на
    // чужом номере выглядел бы как «пациенту ничего не начисляли».
    assert.throws(() => admissionCharges(db, { admission_id: 9999 }, CASH), /не найдена/i);
    assert.throws(() => admissionCharges(db, {}, CASH), /не выбрана/i);
  } finally { db.close(); }
});

test('строка акта называет свой РАЗДЕЛ: по нему вкладки отличают анализ от операции', () => {
  const { db, adm } = seed();
  const DOC = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };
  try {
    // Раздел у услуги берётся из справочника разделов, а когда он не заполнен —
    // из служебного слова маршрутизации: пустой раздел означал бы, что
    // назначенная операция не покажется ни на одной вкладке.
    const typeId = db.prepare("INSERT INTO service_types (name) VALUES ('Хирургия')").run().lastInsertRowid;
    const opSvc = db.prepare("INSERT INTO services (name, price, type_id) VALUES ('Аппендэктомия', 3000000, ?)")
      .run(typeId).lastInsertRowid;
    const labSvc = db.prepare("INSERT INTO services (name, price, type) VALUES ('Общий анализ крови', 40000, 'lab')")
      .run().lastInsertRowid;

    admissionServiceAdd(db, { admission_id: adm.id, service_id: opSvc }, DOC);
    admissionServiceAdd(db, { admission_id: adm.id, service_id: labSvc }, DOC);

    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    const op = act.lines.find((l) => l.name === 'Аппендэктомия');
    const lab = act.lines.find((l) => l.name === 'Общий анализ крови');
    assert.equal(op.service_type, 'Хирургия', 'раздел берётся из справочника разделов');
    assert.equal(lab.service_type, 'lab', 'без раздела остаётся служебное слово услуги');
    assert.equal(op.service_id, opSvc, 'строка помнит, какая это услуга');
  } finally { db.close(); }
});

test('услугу назначают НА ВРЕМЯ, и до выполнения акт не называет её сделанной', () => {
  const { db, adm, svc } = seed();
  const DOC = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };
  try {
    admissionServiceAdd(db, { admission_id: adm.id, service_id: svc, planned_at: '2026-09-11T10:30:00Z' }, DOC);
    const line = db.prepare('SELECT planned_at, performed_at FROM admission_services WHERE service_id = ?').get(svc);
    assert.equal(line.planned_at, '2026-09-11T10:30:00Z', 'время назначения не сохранено');
    assert.equal(line.performed_at, null, 'назначенное на завтра не может быть выполнено сегодня');

    const act = admissionCharges(db, { admission_id: adm.id }, CASH);
    const row = act.lines.find((l) => l.name === 'Перевязка');
    assert.equal(row.planned_at, '2026-09-11T10:30:00Z', 'акт не отдаёт «на когда назначено»');

    // Без времени — как и раньше: сделано сейчас.
    admissionServiceAdd(db, { admission_id: adm.id, service_id: svc }, DOC);
    const now = db.prepare('SELECT planned_at, performed_at FROM admission_services ORDER BY id DESC LIMIT 1').get();
    assert.equal(now.planned_at, null);
    assert.ok(now.performed_at, 'услуга без плана начисляется выполненной');

    // Нечитаемое время — отказ, а не тихая запись мимо расписания.
    assert.throws(() => admissionServiceAdd(db, { admission_id: adm.id, service_id: svc, planned_at: 'завтра утром' }, DOC),
      /не разобран/i);
  } finally { db.close(); }
});

test('SERVICE_TASKS_V1: отметка выполнения ставится, повтор ничего не портит, снять можно 15 минут', () => {
  const { db, adm, svc } = seed();
  const DOC = { id: 3, role: 'doctor', full_name: 'Др. Азиза' };
  const NURSE2 = { id: 2, role: 'nurse', full_name: 'Медсестра' };
  try {
    admissionServiceAdd(db, { admission_id: adm.id, service_id: svc, planned_at: '2026-09-11T10:30:00Z' }, DOC);
    const id = db.prepare('SELECT id FROM admission_services ORDER BY id DESC LIMIT 1').get().id;

    // Отмечает МЕДСЕСТРА: она это и делает.
    const first = admissionServiceDone(db, { line_id: id }, NURSE2);
    assert.ok(first.line.performed_at, 'выполнение не отмечено');
    assert.equal(first.already, false);

    // Повторное нажатие на планшете не переписывает время первой отметки.
    const again = admissionServiceDone(db, { line_id: id }, NURSE2);
    assert.equal(again.already, true, 'повтор затёр бы время');
    assert.equal(again.line.performed_at, first.line.performed_at);

    // Промах снимается тут же.
    const undone = admissionServiceDone(db, { line_id: id, undo: true }, NURSE2);
    assert.equal(undone.line.performed_at, null, 'отметка не снялась');

    // А через час — уже запись о работе.
    admissionServiceDone(db, { line_id: id }, NURSE2);
    db.prepare("UPDATE admission_services SET performed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 hours') WHERE id = ?").run(id);
    assert.throws(() => admissionServiceDone(db, { line_id: id, undo: true }, NURSE2), /15 минут/);

    // Касса отметок выполнения не ставит: это работа отделения.
    assert.throws(() => admissionServiceDone(db, { line_id: id }, CASH), /роли/i);
  } finally { db.close(); }
});
