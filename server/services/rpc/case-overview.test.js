// CASE_OVERVIEW_V1 — обзор госпитализации для врача и выписка со счётом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit, admissionDischargeRequest } from './inpatient.js';
import { admissionReviewSave, admissionSetAttending } from './inpatient-reviews.js';
import { treatmentOrderCreate } from './treatment-orders.js';
import { admissionOverview } from './case-overview.js';
import { RpcError } from './inpatient-flow.js';

const admin      = { id: 1, role: 'admin' };
const registrar  = { id: 2, role: 'registrar' };
const nurse      = { id: 3, role: 'nurse' };
const headDoctor = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doctor     = { id: 5, role: 'doctor' };
const doctor2    = { id: 6, role: 'doctor' };
const cashier    = { id: 7, role: 'cashier' };

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    const users = [
        [1, 'admin1', 'admin', 0, ''], [2, 'reg1', 'registrar', 0, ''], [3, 'nurse1', 'nurse', 0, ''],
        [4, 'hdoc1', 'doctor', 1, 'Хирургия'], [5, 'doc1', 'doctor', 1, 'Хирургия'], [6, 'doc2', 'doctor', 1, 'Терапия'], [7, 'cash1', 'cashier', 0, ''],
    ];
    for (const [id, username, role, isDoctor, specialty] of users) {
        db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,?,?,?,?,?,?)')
            .run(id, username, 'x', 'Сотрудник ' + username, role, isDoctor, specialty);
    }
    const p1 = db.prepare("INSERT INTO patients (full_name, mrn, allergies) VALUES ('Иванов Иван','ID-1','пенициллин')").run().lastInsertRowid;
    const p2 = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Петров Пётр','ID-2')").run().lastInsertRowid;
    const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Хирургия')").run().lastInsertRowid;
    const bed1 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('X-1', ?, 'free')").run(wardId).lastInsertRowid;
    const bed2 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('X-2', ?, 'free')").run(wardId).lastInsertRowid;
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (900, 'Аппендэктомия', 900000, 'other')").run();
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (901, 'Перевязка', 50000, 'procedure')").run();
    db.prepare("INSERT OR IGNORE INTO diet_tables (code, name) VALUES ('99', 'Стол №99 (тест)')").run();
    return { db, p1, p2, wardId, bed1, bed2 };
}
function inBed(ctx, patientId, bedId) {
    const { admission } = admissionOrderCreate(ctx.db, { patient_id: patientId, department: 'Хирургия' }, registrar);
    // Диагноз при направлении пишет регистратура/врач в заявке; здесь — прямо в строку.
    ctx.db.prepare("UPDATE admissions SET admission_diagnosis = 'K35.8' WHERE id = ?").run(admission.id);
    return admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: bedId }, nurse).admission;
}
function inTreatment(ctx, adm, attending = doctor) {
    admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', diagnosis: 'Острый аппендицит K35.8', complaints: 'Боли', objective: 'Живот напряжён', plan: 'Операция', publish: true }, headDoctor);
    admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: attending.id }, headDoctor);
    return ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id);
}
const addService = (ctx, admId, serviceId, price) => ctx.db.prepare(
    'INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable) VALUES (?,?,1,?,?,1)').run(admId, serviceId, price, price);

test('свежеразмещённый пациент: статус, первый день, диагноз при направлении, пусто по назначениям и услугам, один в отделении', () => {
    const ctx = seed();
    const adm = inBed(ctx, ctx.p1, ctx.bed1);
    const ov = admissionOverview(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(ov.admission.status, 'admitted');
    assert.equal(ov.admission.days, 1);
    assert.equal(ov.admission.bed_code, 'X-1');
    assert.equal(ov.patient.full_name, 'Иванов Иван');
    assert.equal(ov.patient.allergies, 'пенициллин');
    assert.equal(ov.diagnosis.referral, 'K35.8');
    assert.equal(ov.diagnosis.clinical, '');
    assert.equal(ov.diet.current, null);
    assert.equal(ov.orders.active, 0);
    assert.equal(ov.orders.today.due, 0);
    assert.equal(ov.services.count, 0);
    assert.equal(ov.operation.state, 'none');
    assert.equal(ov.bill.total, 0);
    assert.equal(ov.docs.next_kind, 'consent', 'первый документ по регламенту — согласие');
    assert.deepEqual([ov.neighbours.index, ov.neighbours.total, ov.neighbours.prev, ov.neighbours.next], [0, 1, null, null]);
    assert.equal(ov.title_sheet.complete, false);
});

test('в лечении: клинический диагноз из осмотра, назначение с дозами на сегодня, стол, услуги, операция запланирована → проведена', () => {
    const ctx = seed();
    const adm = inTreatment(ctx, inBed(ctx, ctx.p1, ctx.bed1));
    treatmentOrderCreate(ctx.db, { admission_id: adm.id, kind: 'med', name: 'Цефтриаксон', dose: '1 г', route: 'в/м', freq_code: '2x' }, doctor);
    ctx.db.prepare("INSERT INTO admission_diets (admission_id, diet_code) VALUES (?, '99')").run(adm.id);
    addService(ctx, adm.id, 900, 900000);
    addService(ctx, adm.id, 901, 50000);

    const ov = admissionOverview(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(ov.admission.status, 'active');
    assert.equal(ov.diagnosis.clinical, 'Острый аппендицит K35.8');
    assert.equal(ov.orders.active, 1);
    assert.equal(ov.orders.today.due, 2, 'два раза в день — две дозы на сегодня');
    assert.equal(ov.orders.list[0].name, 'Цефтриаксон');
    assert.equal(ov.diet.current.name, 'Стол №99 (тест)');
    assert.equal(ov.services.count, 2);
    assert.equal(ov.services.unbilled, 2);
    assert.equal(ov.services.sum_unbilled, 950000);
    assert.equal(ov.operation.state, 'planned', 'операция в услугах — значит запланирована');
    assert.equal(ov.operation.has_surgery_service, true);

    admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'operation', body: 'Протокол операции', publish: true }, doctor);
    const done = admissionOverview(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(done.operation.state, 'done');
    assert.ok(done.operation.at);
});

test('соседи: рядовой врач ходит по своим, главный врач — по всем, в порядке палата → койка', () => {
    const ctx = seed();
    const a1 = inTreatment(ctx, inBed(ctx, ctx.p1, ctx.bed1), doctor2);   // X-1, лечит doc2
    const a2 = inTreatment(ctx, inBed(ctx, ctx.p2, ctx.bed2), doctor);    // X-2, лечит doc1

    const mine = admissionOverview(ctx.db, { admission_id: a2.id }, doctor);
    assert.equal(mine.neighbours.mine, true);
    assert.deepEqual([mine.neighbours.index, mine.neighbours.total], [0, 1]);

    const all = admissionOverview(ctx.db, { admission_id: a2.id }, headDoctor);
    assert.equal(all.neighbours.mine, false);
    assert.deepEqual([all.neighbours.index, all.neighbours.total], [1, 2]);
    assert.equal(all.neighbours.prev.id, a1.id);
    assert.equal(all.neighbours.prev.full_name, 'Иванов Иван');
    assert.equal(all.neighbours.next, null);

    // Врач без своих пациентов видит всех — иначе стрелки пустые.
    const other = admissionOverview(ctx.db, { admission_id: a1.id }, { id: 99, role: 'doctor' });
    assert.equal(other.neighbours.total, 2);
});

test('роли: кассе обзор недоступен', () => {
    const ctx = seed();
    const adm = inBed(ctx, ctx.p1, ctx.bed1);
    assert.throws(() => admissionOverview(ctx.db, { admission_id: adm.id }, cashier), (e) => e instanceof RpcError && e.status === 403);
    for (const who of [admin, headDoctor, doctor, nurse]) admissionOverview(ctx.db, { admission_id: adm.id }, who);
});

test('выписка со счётом: заявка принята и все невыставленные услуги ушли в один счёт; без generate_bill счёта нет', () => {
    const ctx = seed();
    const adm = inTreatment(ctx, inBed(ctx, ctx.p1, ctx.bed1));
    addService(ctx, adm.id, 900, 900000);
    addService(ctx, adm.id, 901, 50000);
    admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'discharge', body: 'Выписной эпикриз', diagnosis: 'K35.8', publish: true }, doctor);

    const res = admissionDischargeRequest(ctx.db, { admission_id: adm.id, outcome: 'home', generate_bill: true }, doctor);
    assert.equal(res.admission.status, 'discharging');
    assert.ok(res.bill && res.bill.invoice_number, 'счёт не сформирован');
    assert.ok(res.bill.items >= 2, 'в счёте должны быть обе услуги');
    assert.ok(res.bill.total_amount >= 950000);
    const left = ctx.db.prepare('SELECT COUNT(*) n FROM admission_services WHERE admission_id = ? AND invoice_item_id IS NULL AND billable = 1').get(adm.id).n;
    assert.equal(left, 0, 'невыставленных строк не должно остаться');
    const ov = admissionOverview(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(ov.bill.invoices.length, 1);
    assert.equal(ov.bill.debt, ov.bill.total, 'ничего ещё не оплачено');
    assert.equal(ov.bill.debt_marked, 0, 'DEBT_FLOW_V1 — неоплаченный ещё не оформленный долг');
    // DEBT_FLOW_V1 — отменённый счёт кассиром в сумму не входит: «Долг» на обзоре
    // после отмены был бы долгом, которого нет; оформленный долг — считается.
    ctx.db.prepare("INSERT INTO invoices (invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-V', ?, ?, 999000, 999000, 0, 'void')").run(adm.id, ctx.p1);
    ctx.db.prepare("INSERT INTO invoices (invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-D', ?, ?, 200000, 200000, 50000, 'debt')").run(adm.id, ctx.p1);
    const ov2 = admissionOverview(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(ov2.bill.total, res.bill.total_amount + 200000, 'void не в сумме');
    assert.equal(ov2.bill.debt_marked, 150000);
    assert.equal(ov2.bill.invoices.length, 3, 'список счетов полный — отменённый виден строкой');
    assert.equal(ov.discharge.status, 'discharging');
    assert.ok(ov.discharge.requested_at);

    // Второй пациент — без generate_bill: как раньше, счёт собирает касса.
    const b = inTreatment(ctx, inBed(ctx, ctx.p2, ctx.bed2));
    addService(ctx, b.id, 901, 50000);
    admissionReviewSave(ctx.db, { admission_id: b.id, kind: 'discharge', body: 'Эпикриз', publish: true }, doctor);
    const plain = admissionDischargeRequest(ctx.db, { admission_id: b.id, outcome: 'home' }, doctor);
    assert.equal(plain.bill, null);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM invoices WHERE admission_id = ?').get(b.id).n, 0);
});

test('выписка со счётом: нечего выставлять — счёта нет, заявка всё равно принята; без эпикриза — отказ до всякого счёта', () => {
    const ctx = seed();
    const adm = inTreatment(ctx, inBed(ctx, ctx.p1, ctx.bed1));
    assert.throws(() => admissionDischargeRequest(ctx.db, { admission_id: adm.id, outcome: 'home', generate_bill: true }, doctor), /эпикриз/i);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM invoices WHERE admission_id = ?').get(adm.id).n, 0, 'отказ не должен оставить счёт');

    admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'discharge', body: 'Эпикриз', publish: true }, doctor);
    const res = admissionDischargeRequest(ctx.db, { admission_id: adm.id, outcome: 'home', generate_bill: true }, doctor);
    assert.equal(res.admission.status, 'discharging');
    // Проживание по тарифу 0 даёт строку с нулём — счёт на 0 тоже счёт; без
    // тарифа и услуг счёта нет. Утверждаем ровно инвариант: услуги выставлены все.
    const left = ctx.db.prepare('SELECT COUNT(*) n FROM admission_services WHERE admission_id = ? AND invoice_item_id IS NULL AND billable = 1').get(adm.id).n;
    assert.equal(left, 0);
});
