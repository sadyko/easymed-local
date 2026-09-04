import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { billAccommodation } from './accommodation.js';
import { admitPatient, dischargePatient, setBedStatus, requestAdmission, cancelAdmissionRequest } from './inpatient.js';

function seed() {
  const db = openDb(':memory:'); migrate(db);
  // users referenced by created_by/doctor_id FKs.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'admin1','x','admin')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7,'registrar1','x','registrar')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (6,'nurse1','x','nurse')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (9,'cashier1','x','cashier')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5,'lab1','x','lab')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3,'doctor1','x','doctor')").run();

  const patientId = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Patient One',1)").run().lastInsertRowid;
  const patientId2 = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Patient Two',1)").run().lastInsertRowid;
  const patientId3 = db.prepare("INSERT INTO patients (full_name, branch_id) VALUES ('Patient Three',1)").run().lastInsertRowid;

  const wardId = db.prepare("INSERT INTO wards (name) VALUES ('General Ward')").run().lastInsertRowid;

  const bed1 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('B-101', ?, 'free')").run(wardId).lastInsertRowid;
  const bed2 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('B-102', ?, 'free')").run(wardId).lastInsertRowid;
  const bed3 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('B-103', ?, 'occupied')").run(wardId).lastInsertRowid;
  const bed4 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('B-104', ?, 'free')").run(wardId).lastInsertRowid;

  return { db, patientId, patientId2, patientId3, wardId, bed1, bed2, bed3, bed4 };
}

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 7, role: 'registrar' };
const nurse     = { id: 6, role: 'nurse' };
const cashier   = { id: 9, role: 'cashier' };
const lab       = { id: 5, role: 'lab' };

// Deterministic stay duration: write admitted_at explicitly rather than
// relying on wall-clock timing during the test.
function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 19) + 'Z';
}


// ─── СТАРЫЙ ПУТЬ ЖИВ ТОЛЬКО ДЛЯ ТЕХ, КОГО ЗАВЕЛИ ДО ОБНОВЛЕНИЯ ───
//
// `admit_patient` и `discharge_patient` — RPC версии v0.8.0, и каждый проходит
// весь маршрут госпитализации ОДНИМ движением: поступление без первичного
// осмотра и без лечащего врача, выписка без исхода, без эпикриза и без
// врачебной подписи. Убрать их было нельзя (в койках лежат люди, которых клали
// ДО обновления, и выписного эпикриза у них не будет), поэтому граница
// проведена по дате: isLegacyAdmission (rpc/inpatient.js) сравнивает
// `created_at` строки с `schema_migrations.applied_at` миграции 091 — моментом,
// когда ЭТА клиника обновилась.
//
// Тестам ниже, которым нужен просто лежащий пациент, наследство подделывается
// честно: заявка с датой ДО обновления — ровно то, что видит клиника в день
// установки. Тесты САМОЙ границы (кому отказано и кому нет) стоят отдельно, в
// конце файла.
const LEGACY_AT = '2000-01-01T00:00:00Z';
const DOCTOR_ID = 3;   // seed(): users(3) — role 'doctor'

/** Заявка, оформленная ДО обновления, — единственный вход старого admit_patient. */
function legacyOrder(db, patientId, doctorId = DOCTOR_ID) {
  return db.prepare('INSERT INTO admissions (patient_id, doctor_id, status, created_at)'
                  + " VALUES (?,?,'ordered',?)").run(patientId, doctorId, LEGACY_AT).lastInsertRowid;
}

/** Пациент в койке старым путём: заявка ДО обновления + admit_patient. */
function legacyAdmit(db, args, user) {
  legacyOrder(db, args.patient_id, args.doctor_id ?? DOCTOR_ID);
  return admitPatient(db, { doctor_id: DOCTOR_ID, ...args }, user);
}

/** Сделать существующую госпитализацию дообновленческой. */
function legacy(db, admissionId) {
  db.prepare('UPDATE admissions SET created_at = ? WHERE id = ?').run(LEGACY_AT, admissionId);
  return admissionId;
}

// 1. admit occupies the bed, creates an active admission with admission_no, copies ward_id.
test('admit_patient occupies the bed, creates an active admission with admission_no, copies ward_id', () => {
  const { db, patientId, wardId, bed1 } = seed();
  const res = legacyAdmit(db, { patient_id: patientId, bed_id: bed1, pathway: 'therapy' }, nurse);

  assert.equal(res.admission.status, 'active');
  assert.equal(res.admission.patient_id, patientId);
  assert.equal(res.admission.bed_id, bed1);
  assert.equal(res.admission.ward_id, wardId);
  assert.ok(res.admission.admission_no);
  assert.match(res.admission.admission_no, /^ADM-\d{5}$/);

  const bed = db.prepare('SELECT status FROM beds WHERE id=?').get(bed1);
  assert.equal(bed.status, 'occupied');
});

// 2. admit rejects a non-free bed, a patient who already has an active admission, and a disallowed role.
test('admit_patient rejects a non-free bed (400), a patient already admitted (400), and a disallowed role (403)', () => {
  const { db, patientId, patientId3, bed1, bed2, bed3 } = seed();

  // bed3 seeded as 'occupied' -> not free.
  legacyOrder(db, patientId);
  assert.throws(() => admitPatient(db, { patient_id: patientId, bed_id: bed3, doctor_id: DOCTOR_ID }, nurse), /400|free|occupied/i);

  // Admit patient to bed1; patient now has an active admission.
  admitPatient(db, { patient_id: patientId, bed_id: bed1, doctor_id: DOCTOR_ID }, nurse);
  assert.throws(() => legacyAdmit(db, { patient_id: patientId, bed_id: bed2 }, nurse), /400|already|active/i);

  // Disallowed role (lab) rejected regardless of otherwise-valid args.
  assert.throws(() => legacyAdmit(db, { patient_id: patientId3, bed_id: bed2 }, lab), /403|allow|forbid|role/i);
});

// 3. discharge (daily): units/charge computed from elapsed time, invoice + item created, bed -> cleaning.
test('discharge_patient computes a daily accommodation charge, creates an unpaid invoice, and frees the bed to cleaning', () => {
  const { db, patientId, wardId, bed1 } = seed();
  db.prepare("UPDATE wards SET billing_mode='daily', price_per_day=100000 WHERE id=?").run(wardId);

  const { admission } = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
  db.prepare('UPDATE admissions SET admitted_at=? WHERE id=?').run(isoHoursAgo(50), admission.id);

  // ACCOMMODATION_AS_SERVICE_V1 — арифметика та же, но живёт она теперь во
  // внесении проживания, а не в выписке: считаем строку, потом выписываем.
  const { line } = billAccommodation(db, { admission_id: admission.id }, cashier);
  assert.equal(line.quantity, 2);        // ~50h -> 2 daily units per the spec formula
  assert.equal(line.unit_price, 100000);
  assert.equal(line.total, 200000);
  assert.match(line.notes, /General Ward/);
  assert.match(line.notes, /B-101/);

  const res = dischargePatient(db, { admission_id: admission.id }, admin);

  assert.equal(res.mode, 'daily');
  assert.equal(res.units, 2);
  assert.equal(res.rate, 100000);
  assert.equal(res.gross, 200000);

  // Счёт за койку выписка больше НЕ создаёт — его соберёт касса вместе с
  // остальной госпитализацией. charge_amount отражает внесённое.
  assert.equal(res.admission.invoice_id, null);
  assert.equal(res.admission.charge_amount, 200000);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, 0);

  assert.equal(res.admission.status, 'discharged');
  assert.ok(res.admission.discharged_at);
  const bed = db.prepare('SELECT status FROM beds WHERE id=?').get(bed1);
  assert.equal(bed.status, 'cleaning');
});

// 4. discharge (hourly): ~90 min -> 2 hourly units.
test('discharge_patient computes an hourly accommodation charge', () => {
  const { db, patientId, wardId, bed1 } = seed();
  db.prepare("UPDATE wards SET billing_mode='hourly', price_per_hour=5000 WHERE id=?").run(wardId);

  const { admission } = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
  db.prepare('UPDATE admissions SET admitted_at=? WHERE id=?').run(isoHoursAgo(1.5), admission.id);

  const res = dischargePatient(db, { admission_id: admission.id }, admin);
  assert.equal(res.mode, 'hourly');
  assert.equal(res.units, 2);
  assert.equal(res.rate, 5000);
  assert.equal(res.gross, 10000);
  assert.equal(res.charge, 10000);
  // ACCOMMODATION_AS_SERVICE_V1 — счёта выписка не создаёт; сумма к оплате
  // появляется только после внесения проживания.
  assert.equal(res.invoice_id, null);
});

// 5. bed rate overrides ward rate; discount_percent reduces net.
test('discharge_patient: a per-bed rate override beats the ward rate, and discount_percent reduces net', () => {
  const { db, patientId, wardId, bed1 } = seed();
  db.prepare("UPDATE wards SET billing_mode='daily', price_per_day=100000 WHERE id=?").run(wardId);
  db.prepare('UPDATE beds SET price_per_day=150000 WHERE id=?').run(bed1);

  const { admission } = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
  db.prepare('UPDATE admissions SET admitted_at=? WHERE id=?').run(isoHoursAgo(50), admission.id);

  // Скидка живёт на госпитализации; внесение проживания её применяет.
  setAdmissionDiscount(db, { admission_id: admission.id, percent: 10 }, admin);
  const { line } = billAccommodation(db, { admission_id: admission.id }, cashier);
  assert.equal(line.unit_price, 150000);   // bed override wins over ward's 100000
  assert.equal(line.quantity, 2);
  assert.equal(line.total, 270000);        // 300 000 * 0.9

  const res = dischargePatient(db, { admission_id: admission.id, discount_percent: 10 }, admin);
  assert.equal(res.rate, 150000);
  assert.equal(res.gross, 300000);
  assert.equal(res.admission.accommodation_discount_percent, 10);
  assert.equal(res.admission.charge_amount, 270000, 'в карточке — то, что реально внесено');
  assert.equal(res.admission.invoice_id, null);
});

// 6. no rate configured (ward + bed both 0) -> charge 0, no invoice, still discharges cleanly.
test('discharge_patient with no rate configured: charge is 0 and no invoice is created', () => {
  const { db, patientId, bed1 } = seed(); // ward defaults: price_per_day=0, price_per_hour=0

  const { admission } = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
  const res = dischargePatient(db, { admission_id: admission.id }, admin);

  assert.equal(res.charge, 0);
  assert.equal(res.gross, 0);
  assert.equal(res.invoice_id, null);
  assert.equal(res.admission.status, 'discharged');
  assert.equal(res.admission.invoice_id, null);
  assert.equal(res.admission.charge_amount, 0);

  const bed = db.prepare('SELECT status FROM beds WHERE id=?').get(bed1);
  assert.equal(bed.status, 'cleaning');
});

// 6b. only admin/cashier may apply a discount; a nurse/registrar cannot (review #1).
//     A negative ward rate is clamped to 0 (no negative charge); a bad doctor_id is a clean 400.
test('discharge_patient: discount is admin/cashier-only; negative rate clamps to 0; admit validates doctor', () => {
  const { db, patientId, patientId2, patientId3, wardId, bed1, bed2, bed4 } = seed();
  db.prepare("UPDATE wards SET billing_mode='daily', price_per_day=100000 WHERE id=?").run(wardId);

  // nurse discharging WITH a discount -> 403; WITHOUT one -> allowed.
  const a1 = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;
  assert.throws(() => dischargePatient(db, { admission_id: a1.id, discount_percent: 25 }, nurse), /403|admin|cashier|discount/i);
  const ok = dischargePatient(db, { admission_id: a1.id }, nurse);
  assert.equal(ok.admission.status, 'discharged');

  // negative ward rate -> clamped to 0 -> no charge, no invoice, still discharged.
  db.prepare("UPDATE wards SET price_per_day=-500 WHERE id=?").run(wardId);
  const a2 = legacyAdmit(db, { patient_id: patientId2, bed_id: bed2 }, nurse).admission;
  const neg = dischargePatient(db, { admission_id: a2.id }, admin);
  assert.equal(neg.gross, 0);
  assert.equal(neg.charge, 0);
  assert.equal(neg.invoice_id, null);

  // admit with a non-existent doctor_id -> clean 400 (not an FK 500).
  legacyOrder(db, patientId3);
  assert.throws(() => admitPatient(db, { patient_id: patientId3, bed_id: bed4, doctor_id: 999999 }, nurse), /400|doctor/i);
});

// 7. discharge rejects a non-active (already-discharged) admission, and an out-of-range discount_percent.
test('discharge_patient rejects an already-discharged admission (400) and discount_percent outside [0,100] (400)', () => {
  const { db, patientId, patientId2, bed1, bed2 } = seed();

  const { admission } = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
  dischargePatient(db, { admission_id: admission.id }, admin);
  // INPATIENT_REVIEW_V1 (Задача 3) — отказ теперь называет ПРИЧИНУ по-русски
  // («Пациент уже выписан…») вместо «not found or not active»: выписка ходит
  // из любого состояния «в койке», и «не активна» перестало быть правдой.
  assert.throws(() => dischargePatient(db, { admission_id: admission.id }, admin), /400|active|not found|discharged|выписан/i);

  const { admission: admission2 } = legacyAdmit(db, { patient_id: patientId2, bed_id: bed2 }, nurse);
  assert.throws(() => dischargePatient(db, { admission_id: admission2.id, discount_percent: 150 }, admin), /400|discount/i);
  assert.throws(() => dischargePatient(db, { admission_id: admission2.id, discount_percent: -5 }, admin), /400|discount/i);

  // admission2 is still active after the rejected discharge attempts
  const stillActive = db.prepare('SELECT status FROM admissions WHERE id=?').get(admission2.id);
  assert.equal(stillActive.status, 'active');
});

// 8. set_bed_status: free->cleaning ok; 'occupied' rejected; bed with active admission rejected; role-gated.
test('set_bed_status: free->cleaning ok; rejects occupied, a bed with an active admission, and a disallowed role', () => {
  const { db, patientId, bed1, bed2 } = seed();

  const res = setBedStatus(db, { bed_id: bed2, status: 'cleaning' }, nurse);
  assert.equal(res.bed.status, 'cleaning');

  assert.throws(() => setBedStatus(db, { bed_id: bed2, status: 'occupied' }, nurse), /400|occupied|one of/i);

  legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
  assert.throws(() => setBedStatus(db, { bed_id: bed1, status: 'free' }, nurse), /400|active|admission/i);

  assert.throws(() => setBedStatus(db, { bed_id: bed2, status: 'free' }, lab), /403|allow|forbid|role/i);
});

// ---- BED_CONSOLE_V1 ---------------------------------------------------------
import { transferAdmission, setAdmissionDiscount } from './inpatient.js';
import { dispenseAdmissionItem, voidDispensedAdmissionItem } from './inventory.js';
import { createInvoiceForAdmission } from './billing.js';

function consoleSeed() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1,'r','x','registrar'),(2,'n','x','nurse'),(3,'a','x','admin')").run();
  db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
  db.prepare("INSERT INTO wards (id, name, active) VALUES (1,'201',1),(2,'202',1)").run();
  db.prepare("INSERT INTO beds (id, ward_id, code, status, active) VALUES (1,1,'K1','free',1),(2,2,'K2','free',1)").run();
  db.prepare("INSERT INTO services (id, name, price) VALUES (1,'Перевязка',30000)").run();
  db.prepare("INSERT INTO products (id, name, unit, sale_price, on_hand, active) VALUES (1,'Trimol','мл',5000,50,1)").run();
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (4,'d','x','doctor')").run();
  // Старый путь принимает только дообновленческую заявку и требует лечащего
  // врача — см. блок про границу выпуска в начале файла.
  db.prepare("INSERT INTO admissions (patient_id, doctor_id, status, created_at) VALUES (1,4,'ordered','2000-01-01T00:00:00Z')").run();
  const { admission } = admitPatient(db, { patient_id: 1, bed_id: 1, doctor_id: 4 }, { id: 1, role: 'registrar' });
  return { db, adm: admission };
}

test('bed console: dispense/void admission item moves stock + admission_services', () => {
  const { db, adm } = consoleSeed();
  const nurse = { id: 2, role: 'nurse' };
  const r = dispenseAdmissionItem(db, { admission_id: adm.id, product_id: 1, quantity: 2 }, nurse);
  assert.equal(r.item_name, 'Trimol');
  assert.equal(r.on_hand, 48);
  const line = db.prepare('SELECT * FROM admission_services WHERE id = ?').get(r.line_id);
  assert.equal(line.total, 10000);
  assert.equal(line.clinic_item_id, 1);
  // void restores stock and deletes the line (admin)
  const v = voidDispensedAdmissionItem(db, { line_id: r.line_id }, { id: 3, role: 'admin' });
  assert.equal(v.on_hand, 50);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admission_services').get().n, 0);
});

test('bed console: invoice for admission links lines, catalog prices win', () => {
  const { db, adm } = consoleSeed();
  const reg = { id: 1, role: 'registrar' };
  const svcLine = db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, status) VALUES (?,1,1,999,999,'added')").run(adm.id).lastInsertRowid;
  const itemLine = dispenseAdmissionItem(db, { admission_id: adm.id, product_id: 1, quantity: 2 }, { id: 2, role: 'nurse' }).line_id;
  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [svcLine, itemLine] }, reg);
  assert.equal(invoice.subtotal, 40000);                 // 30000 (каталог, не 999) + 2×5000
  assert.equal(invoice.admission_id, adm.id);
  assert.equal(invoice.status, 'unpaid');
  const l1 = db.prepare('SELECT invoice_item_id, status FROM admission_services WHERE id = ?').get(svcLine);
  assert.ok(l1.invoice_item_id); assert.equal(l1.status, 'completed');
  // повторная попытка на те же строки — отказ
  assert.throws(() => createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [svcLine] }, reg), /already invoiced/);
});

test('bed console: transfer moves the patient, beds flip, журнал written', () => {
  const { db, adm } = consoleSeed();
  const r = transferAdmission(db, { admission_id: adm.id, to_bed_id: 2, reason: 'ближе к посту' }, { id: 2, role: 'nurse' });
  assert.equal(r.admission.bed_id, 2);
  assert.equal(r.admission.ward_id, 2);
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=1').get().status, 'cleaning');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=2').get().status, 'occupied');
  const j = db.prepare("SELECT kind FROM admission_transfers WHERE admission_id=? ORDER BY id").all(adm.id).map(x => x.kind);
  assert.deepEqual(j, ['admit', 'transfer']);
  // занятая койка — отказ
  assert.throws(() => transferAdmission(db, { admission_id: adm.id, to_bed_id: 2 }, { id: 2, role: 'nurse' }), /уже на этой койке/);
});

test('bed console: discount is admin/cashier-only and clamped', () => {
  const { db, adm } = consoleSeed();
  setAdmissionDiscount(db, { admission_id: adm.id, percent: 15 }, { id: 3, role: 'admin' });
  assert.equal(db.prepare('SELECT accommodation_discount_percent p FROM admissions WHERE id=?').get(adm.id).p, 15);
  assert.throws(() => setAdmissionDiscount(db, { admission_id: adm.id, percent: 15 }, { id: 2, role: 'nurse' }), /not allowed/);
  assert.throws(() => setAdmissionDiscount(db, { admission_id: adm.id, percent: 150 }, { id: 3, role: 'admin' }), /0\.\.100/);
});

// ADM_REQUEST_LIFECYCLE_V1 — REGRESSION: an 'ordered' admission (called
// 'requested' before migration 091 renamed it) could never be
// left. admit_patient opened a SECOND row and nothing could ever move the first
// one, so — because request_admission refuses a second open request — the very
// first referral blocked that patient from inpatient care permanently.
test('admit fulfils an open request in place instead of orphaning it', () => {
  const { db, patientId, wardId, bed1 } = seed();
  const req = requestAdmission(db, { patient_id: patientId, doctor_id: 3, pathway: 'surgical', chief_complaint: 'боль в животе' }, { id: 3, role: 'doctor' }).admission;
  assert.equal(req.status, 'ordered');   // INPATIENT_FLOW_V1 — прежнее 'requested'
  assert.equal(req.bed_id, null);
  legacy(db, req.id);   // заявка оформлена ДО обновления — иначе старый путь ей откажет

  const adm = admitPatient(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;

  // Same row, now active on a bed — not a second admission.
  assert.equal(adm.id, req.id, 'the request must BECOME the stay');
  assert.equal(adm.status, 'active');
  assert.equal(adm.bed_id, bed1);
  assert.equal(adm.ward_id, wardId);
  assert.ok(adm.admitted_at);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admissions WHERE patient_id=?').get(patientId).n, 1);

  // What the referring doctor filed survives when the desk doesn't override it.
  assert.equal(adm.chief_complaint, 'боль в животе');
  assert.equal(adm.doctor_id, 3);

  // And the patient can be referred again after the stay ends.
  dischargePatient(db, { admission_id: adm.id }, admin);
  const again = requestAdmission(db, { patient_id: patientId, pathway: 'therapy' }, { id: 3, role: 'doctor' }).admission;
  assert.equal(again.status, 'ordered');
});

test('a hospitalisation request can be declined, freeing the patient to be referred again', () => {
  const { db, patientId } = seed();
  const req = requestAdmission(db, { patient_id: patientId, pathway: 'therapy' }, { id: 3, role: 'doctor' }).admission;

  // Before: nothing could move it. A second request was refused outright.
  assert.throws(() => requestAdmission(db, { patient_id: patientId, pathway: 'therapy' }, { id: 3, role: 'doctor' }), /pending|already/i);

  const res = cancelAdmissionRequest(db, { admission_id: req.id, reason: 'состояние улучшилось' }, nurse);
  assert.equal(res.admission.status, 'cancelled');
  assert.ok(res.admission.discharged_at);
  const log = db.prepare("SELECT kind, reason FROM admission_transfers WHERE admission_id=?").get(req.id);
  assert.equal(log.kind, 'cancel');
  assert.equal(log.reason, 'состояние улучшилось');

  // The patient is free again.
  assert.equal(requestAdmission(db, { patient_id: patientId, pathway: 'therapy' }, { id: 3, role: 'doctor' }).admission.status, 'ordered');
});

test('cancel refuses an ACTIVE stay (that is what discharge is for) and a bad role', () => {
  const { db, patientId, bed1 } = seed();
  const adm = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;
  assert.throws(() => cancelAdmissionRequest(db, { admission_id: adm.id }, nurse), /cannot go from 'active'/);
  assert.throws(() => cancelAdmissionRequest(db, { admission_id: adm.id }, lab), /not allowed/);
  // the stay is untouched
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(adm.id).status, 'active');
});

// ADM_DISCOUNT_HONOURED_V1 — REGRESSION: discharge read only args.discount_percent
// (default 0) and then wrote that 0 back over the stored percent, so a discount
// agreed during the stay was both ignored on the bill and erased from the record.
test('discharge honours a discount stored during the stay, and an explicit argument overrides it', () => {
  const { db, patientId, patientId2, wardId, bed1, bed2 } = seed();
  db.prepare('UPDATE wards SET price_per_day = 100000, billing_mode = ?  WHERE id = ?').run('daily', wardId);

  // Stay A: 20% agreed mid-stay by an admin, discharged by a NURSE with no argument.
  const a = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;
  db.prepare("UPDATE admissions SET admitted_at=? WHERE id=?").run(isoHoursAgo(2), a.id);
  setAdmissionDiscount(db, { admission_id: a.id, percent: 20 }, admin);

  const rA = dischargePatient(db, { admission_id: a.id }, nurse);
  assert.equal(rA.gross, 100000);
  assert.equal(rA.charge, 80000, 'the stored 20% must be applied to the bill');
  assert.equal(rA.discount_amount, 20000);
  assert.equal(rA.admission.accommodation_discount_percent, 20, 'the stored percent must survive discharge');
  // Счёт больше не рождается на выписке — проверяем ту же сумму на внесённой
  // строке проживания.
  assert.equal(rA.admission.invoice_id, null);

  // Stay B: 50% stored, but the desk overrides with an explicit 0 at discharge.
  const b = legacyAdmit(db, { patient_id: patientId2, bed_id: bed2 }, nurse).admission;
  db.prepare("UPDATE admissions SET admitted_at=? WHERE id=?").run(isoHoursAgo(2), b.id);
  setAdmissionDiscount(db, { admission_id: b.id, percent: 50 }, admin);

  const rB = dischargePatient(db, { admission_id: b.id, discount_percent: 0 }, admin);
  assert.equal(rB.charge, 100000, 'an explicit argument wins over the stored percent');
  assert.equal(rB.admission.accommodation_discount_percent, 0);
});

test('discharge: a nurse may discharge at a pre-approved discount but still cannot introduce one', () => {
  const { db, patientId, patientId2, wardId, bed1, bed2 } = seed();
  db.prepare('UPDATE wards SET price_per_day = 100000 WHERE id = ?').run(wardId);

  // Pre-approved by an admin -> the nurse's discharge is allowed and discounted.
  const a = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;
  setAdmissionDiscount(db, { admission_id: a.id, percent: 30 }, admin);
  assert.equal(dischargePatient(db, { admission_id: a.id }, nurse).charge, 70000);

  // Introducing one at the door is still 403 for a nurse.
  const b = legacyAdmit(db, { patient_id: patientId2, bed_id: bed2 }, nurse).admission;
  assert.throws(() => dischargePatient(db, { admission_id: b.id, discount_percent: 30 }, nurse),
    /403|admin|cashier|discount/i);
});

import { removeAdmissionLineFromInvoice } from './billing.js';

test('bed console: line can be pulled back out of an UNPAID invoice', () => {
  const { db, adm } = consoleSeed();
  const reg = { id: 1, role: 'registrar' };
  const l1 = db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, status) VALUES (?,1,1,30000,30000,'added')").run(adm.id).lastInsertRowid;
  const l2 = dispenseAdmissionItem(db, { admission_id: adm.id, product_id: 1, quantity: 1 }, { id: 2, role: 'nurse' }).line_id;
  const { invoice } = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [l1, l2] }, reg);

  // одну строку вынули — счёт пересчитан, строка снова Unbilled
  const r1 = removeAdmissionLineFromInvoice(db, { line_id: l1 }, reg);
  assert.equal(r1.invoice_deleted, false);
  assert.equal(db.prepare('SELECT total_amount FROM invoices WHERE id=?').get(invoice.id).total_amount, 5000);
  const back = db.prepare('SELECT invoice_item_id, status FROM admission_services WHERE id=?').get(l1);
  assert.equal(back.invoice_item_id, null); assert.equal(back.status, 'added');

  // последнюю строку вынули — пустой счёт удалён
  const r2 = removeAdmissionLineFromInvoice(db, { line_id: l2 }, reg);
  assert.equal(r2.invoice_deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices WHERE id=?').get(invoice.id).n, 0);

  // по оплаченному счёту — отказ
  const l3 = db.prepare("INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, status) VALUES (?,1,1,30000,30000,'added')").run(adm.id).lastInsertRowid;
  const inv2 = createInvoiceForAdmission(db, { admission_id: adm.id, admission_service_ids: [l3] }, reg).invoice;
  db.prepare("UPDATE invoices SET paid_amount=30000, status='paid' WHERE id=?").run(inv2.id);
  assert.throws(() => removeAdmissionLineFromInvoice(db, { line_id: l3 }, reg), /оплачен/);
});

// ─── INPATIENT_REVIEW_V1 (Задача 3): никто не остаётся запертым в койке ──────
//
// Это РЕГРЕССИЯ на дыру, открытую Задачей 2 и видимую только со стороны
// пациента. Окно медсестры кладёт человека в 'admitted'; выписка требовала
// 'active'; между ними — первичный осмотр главного врача и назначение лечащего.
// Пока их не было, пациент, положенный медсестрой, не мог быть выписан вообще.
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { assertCanPrescribe } from './inpatient-flow.js';

test('пациент, положенный через окно медсестры, ВЫПИСЫВАЕТСЯ (до всякого осмотра)', () => {
  const { db, patientId, bed1 } = seed();
  const { admission: ordered } = admissionOrderCreate(db, { patient_id: patientId, department: 'Терапия' }, registrar);
  const { admission: inBed } = admissionAdmit(db, { admission_id: ordered.id, bed_id: bed1 }, nurse);
  assert.equal(inBed.status, 'admitted', 'Задача 2 доводит ровно до койки');
  legacy(db, inBed.id);   // клали ДО обновления — иначе прямая выписка откажет

  const res = dischargePatient(db, { admission_id: inBed.id }, admin);
  assert.equal(res.admission.status, 'discharged');
  assert.ok(res.admission.discharged_at);
  // Койка освобождается так же, как при любой другой выписке: в уборку.
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bed1).status, 'cleaning');
});

test('выписать можно из ЛЮБОГО состояния «в койке», и только из него', () => {
  for (const status of ['admitted', 'examined', 'active', 'discharging']) {
    const { db, patientId, bed1 } = seed();
    const { admission } = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse);
    db.prepare('UPDATE admissions SET status=? WHERE id=?').run(status, admission.id);
    const res = dischargePatient(db, { admission_id: admission.id }, admin);
    assert.equal(res.admission.status, 'discharged', `выписка из '${status}'`);
    db.close();
  }

  // Заявку не выписывают — её отменяют; закрытую не открывают заново.
  const { db, patientId, patientId2 } = seed();
  const { admission: ordered } = admissionOrderCreate(db, { patient_id: patientId }, registrar);
  assert.throws(() => dischargePatient(db, { admission_id: ordered.id }, admin), /не размещён на койке/);
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(ordered.id).status, 'ordered');

  const { admission: cancelled } = admissionOrderCreate(db, { patient_id: patientId2 }, registrar);
  db.prepare("UPDATE admissions SET status='cancelled' WHERE id=?").run(cancelled.id);
  assert.throws(() => dischargePatient(db, { admission_id: cancelled.id }, admin), /отменена/);
  db.close();
});

test('суточное начисление за пациента без осмотра считается от размещения', () => {
  const { db, patientId, wardId, bed1 } = seed();
  db.prepare('UPDATE wards SET billing_mode=?, price_per_day=? WHERE id=?').run('daily', 100000, wardId);
  const { admission: ordered } = admissionOrderCreate(db, { patient_id: patientId }, registrar);
  admissionAdmit(db, { admission_id: ordered.id, bed_id: bed1 }, nurse);
  db.prepare('UPDATE admissions SET admitted_at=? WHERE id=?').run(isoHoursAgo(30), ordered.id);
  legacy(db, ordered.id);   // прямая выписка осталась только для дообновленческих

  const res = dischargePatient(db, { admission_id: ordered.id }, admin);
  assert.equal(res.mode, 'daily');
  assert.equal(res.units, 1, 'вторые начатые сутки не считаются лишними — правило v0.8.0 не изменилось');
  assert.equal(res.rate, 100000);
  // Главный врач тут не участвовал вовсе: выписка не спрашивает осмотра.
  assert.equal(db.prepare('SELECT examined_at FROM admissions WHERE id=?').get(ordered.id).examined_at, null);
  db.close();
});


// ═══ ГРАНИЦА ВЫПУСКА: СТАРЫЕ КНОПКИ БОЛЬШЕ НЕ ОБХОДЯТ МАРШРУТ ═══════════════
//
// Разбор C1 назвал дыру целиком: доска коек (views/ward-beds.js) звала
// `admit_patient` и `discharge_patient`, а миграция 092 выдала эту доску
// медсестре, старшей медсестре, главному врачу и РЕГИСТРАТУРЕ. Одно нажатие
// писало status='active' с пустыми examined_* и attending_doctor_id — весь
// маршрут владельца пропускался, и получившаяся госпитализация НЕ ЛЕЧИЛАСЬ:
// назначения отвечали 403 «Назначения ведёт лечащий врач этого пациента».
// Второе нажатие закрывало чужую историю болезни без исхода, без эпикриза и
// без врачебной подписи.
//
// Кнопок на экране больше нет. Тесты ниже проверяют ВТОРУЮ половину — сервер:
// /api/rpc открыт curl'ом с любого компьютера клиники, и спрятанная кнопка
// защитой не является.

test('C1: admit_patient больше не заводит госпитализацию — и говорит, куда идти', () => {
  const { db, patientId, bed1 } = seed();

  // Ровно тот вызов, который делала кнопка «Госпитализировать» на доске коек.
  assert.throws(() => admitPatient(db, { patient_id: patientId, bed_id: bed1, doctor_id: DOCTOR_ID }, registrar),
    (e) => e.status === 400 && /Стационар/.test(e.message) && /лечащего врача/.test(e.message));

  // Ни строки, ни занятой койки после отказа.
  assert.equal(db.prepare('SELECT COUNT(*) n FROM admissions').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bed1).status, 'free');
  db.close();
});

test('C1: заявка, оформленная ПОСЛЕ обновления, старым путём не выполняется — а дообновленческая выполняется', () => {
  const { db, patientId, patientId2, bed1, bed2 } = seed();

  // Заявка нового маршрута (created_at = сейчас): её кладёт медсестра в окне
  // «Стационар», а не старый RPC.
  const fresh = admissionOrderCreate(db, { patient_id: patientId, department: 'Терапия' }, registrar).admission;
  assert.throws(() => admitPatient(db, { patient_id: patientId, bed_id: bed1, doctor_id: DOCTOR_ID }, nurse),
    (e) => e.status === 400 && /Стационар/.test(e.message));
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(fresh.id).status, 'ordered',
    'отказ не должен ничего сдвинуть');

  // Та же заявка, но оформленная ДО обновления, — выполняется как раньше.
  const old = admissionOrderCreate(db, { patient_id: patientId2, department: 'Терапия' }, registrar).admission;
  legacy(db, old.id);
  const res = admitPatient(db, { patient_id: patientId2, bed_id: bed2, doctor_id: DOCTOR_ID }, nurse);
  assert.equal(res.admission.id, old.id, 'заявка должна СТАТЬ госпитализацией, а не породить вторую');
  assert.equal(res.admission.status, 'active');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bed2).status, 'occupied');
  db.close();
});

// САМОЕ ВАЖНОЕ В C1: старый путь, пока он жив, НЕ ОСТАВЛЯЕТ ПАЦИЕНТА БЕЗ
// ЛЕЧАЩЕГО ВРАЧА. Именно это делало госпитализацию невосстановимой: назначения
// отказывали всем, а admission_set_attending отвечал «уже назначен», потому что
// смотрел на статус, а не на пустую колонку.
test('C1: старый путь проставляет лечащего врача и отметку осмотра — иначе отказывает', () => {
  const { db, patientId, patientId2, bed1, bed2 } = seed();

  // Заявка без врача + вызов без врача = госпитализация, которую нельзя лечить.
  // Такую сервер не создаёт вовсе.
  legacyOrder(db, patientId, null);
  assert.throws(() => admitPatient(db, { patient_id: patientId, bed_id: bed1 }, nurse),
    (e) => e.status === 400 && /лечащего врача/.test(e.message));
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bed1).status, 'free');

  // Медсестра лечащим врачом быть не может — признак врача спрашивается тем же
  // вопросом, что и в admission_set_attending.
  assert.throws(() => admitPatient(db, { patient_id: patientId, bed_id: bed1, doctor_id: 6 }, nurse),
    (e) => e.status === 400 && /только врача/.test(e.message));

  // С врачом — проходит, и все три пропущенные подписи стоят.
  const adm = legacyAdmit(db, { patient_id: patientId2, bed_id: bed2 }, nurse).admission;
  assert.equal(adm.attending_doctor_id, DOCTOR_ID, 'без лечащего врача назначения невозможны');
  assert.equal(adm.admitted_by, nurse.id);
  assert.equal(adm.examined_by, nurse.id, 'шаг пройден одним движением — подписан тем, кто его сделал');
  assert.ok(adm.examined_at, 'пустой осмотр сделал бы строку неотличимой от мигрировавшей');
  // И проверка «изнутри»: этому врачу лечение открыто.
  assert.equal(assertCanPrescribe(db, adm.id, { id: DOCTOR_ID, role: 'doctor' }).id, adm.id);
  db.close();
});

test('C1: discharge_patient отказывает госпитализации, заведённой после обновления, и работает для дообновленческой', () => {
  const { db, patientId, patientId2, bed1, bed2 } = seed();

  // Новая госпитализация, дошедшая до лечения нормальным маршрутом.
  const fresh = admissionOrderCreate(db, { patient_id: patientId }, registrar).admission;
  admissionAdmit(db, { admission_id: fresh.id, bed_id: bed1 }, nurse);
  db.prepare("UPDATE admissions SET status='active', attending_doctor_id=?, examined_at='2026-09-04T09:00:00Z' WHERE id=?")
    .run(DOCTOR_ID, fresh.id);

  assert.throws(() => dischargePatient(db, { admission_id: fresh.id }, nurse),
    (e) => e.status === 400 && /два шага/.test(e.message) && /Выписки к оформлению/.test(e.message));
  assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(fresh.id).status, 'active',
    'отказ обязан ничего не менять');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bed1).status, 'occupied');

  // Дообновленческая — выписывается по-прежнему: эпикриза у неё нет и не будет.
  const old = legacyAdmit(db, { patient_id: patientId2, bed_id: bed2 }, nurse).admission;
  const res = dischargePatient(db, { admission_id: old.id }, nurse);
  assert.equal(res.admission.status, 'discharged');
  assert.equal(db.prepare('SELECT status FROM beds WHERE id=?').get(bed2).status, 'cleaning');
  db.close();
});

// Отказ по СОСТОЯНИЮ звучит раньше отказа по границе выпуска: у заявки, у
// отменённой и у выписанной свой точный ответ, и подменять его рассказом про
// два шага значит отвечать не на тот вопрос.
test('C1: у заявки и у закрытой госпитализации ответ прежний, а не про два шага', () => {
  const { db, patientId, patientId2 } = seed();
  const ordered = admissionOrderCreate(db, { patient_id: patientId }, registrar).admission;
  assert.throws(() => dischargePatient(db, { admission_id: ordered.id }, admin), /не размещён на койке/);

  const cancelled = admissionOrderCreate(db, { patient_id: patientId2 }, registrar).admission;
  db.prepare("UPDATE admissions SET status='cancelled' WHERE id=?").run(cancelled.id);
  assert.throws(() => dischargePatient(db, { admission_id: cancelled.id }, admin), /отменена/);
  db.close();
});

// C1, третья половина: КАССИР И РЕГИСТРАТУРА БОЛЬШЕ НЕ ВЫПИСЫВАЮТ.
//
// Исход госпитализации — врачебное заключение, оформление выписки — работа
// старшей медсестры. Ни кассир, ни регистратор не подписывают ни того, ни
// другого нигде в новом маршруте (TRANSITION_ROLES), и держать им старую
// кнопку значило оставить открытым ровно тот вход, который маршрут закрыл.
test('C1: кассир и регистратура выписать не могут; те, кто стоит у койки, — могут', () => {
  for (const who of [cashier, registrar, lab]) {
    const { db, patientId, bed1 } = seed();
    const adm = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;
    assert.throws(() => dischargePatient(db, { admission_id: adm.id }, who),
      (e) => e.status === 403, 'роль ' + who.role + ' не должна выписывать');
    assert.equal(db.prepare('SELECT status FROM admissions WHERE id=?').get(adm.id).status, 'active');
    db.close();
  }

  const seniorNurse = { id: 6, role: 'nurse', extra_roles: ['senior_nurse'] };
  const headDoctor  = { id: 3, role: 'doctor', extra_roles: ['head_doctor'] };
  for (const who of [nurse, admin, seniorNurse, headDoctor]) {
    const { db, patientId, bed1 } = seed();
    const adm = legacyAdmit(db, { patient_id: patientId, bed_id: bed1 }, nurse).admission;
    assert.equal(dischargePatient(db, { admission_id: adm.id }, who).admission.status, 'discharged',
      'роль ' + (who.extra_roles || [who.role]).join(',') + ' обязана выписывать');
    db.close();
  }
});
