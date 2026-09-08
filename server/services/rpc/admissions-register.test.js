// ADMISSIONS_REGISTER_V1 — журнал госпитализаций: агрегаты денег, порядок, роли.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionsRegister } from './admissions-register.js';
import { RpcError } from './inpatient-flow.js';

const registrar = { id: 2, role: 'registrar' };
const nurse     = { id: 3, role: 'nurse' };
const cashier   = { id: 7, role: 'cashier' };
const marketing = { id: 8, role: 'marketing' };

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    for (const [id, u, role] of [[2, 'reg1', 'registrar'], [3, 'nurse1', 'nurse'], [5, 'doc1', 'doctor'], [7, 'cash1', 'cashier']]) {
        db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, role === 'doctor' ? 1 : 0);
    }
    const payerId = db.prepare("INSERT INTO payers (name, kind) VALUES ('Страховая А', 'insurance')").run().lastInsertRowid;
    const p1 = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, payer_id) VALUES ('Каримов Темур','31002','1971-07-03', ?)").run(payerId).lastInsertRowid;
    const p2 = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth) VALUES ('Юлдашев Сардор','27431','1985-03-30')").run().lastInsertRowid;
    const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Реанимация')").run().lastInsertRowid;
    const bed1 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('01-01/1', ?, 'free')").run(wardId).lastInsertRowid;
    const bed2 = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('01-01/2', ?, 'free')").run(wardId).lastInsertRowid;
    db.prepare("INSERT INTO services (id, name, price, type) VALUES (900, 'Аппендэктомия', 900000, 'other')").run();
    return { db, p1, p2, bed1, bed2 };
}
function inBed(ctx, patientId, bedId, at) {
    const { admission } = admissionOrderCreate(ctx.db, { patient_id: patientId, department: 'Реанимация' }, registrar);
    const adm = admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: bedId, at }, nurse).admission;
    ctx.db.prepare('UPDATE admissions SET attending_doctor_id = 5 WHERE id = ?').run(adm.id);
    return adm;
}

test('строка журнала: пациент, возраст, врач, покрытие; акт, выставлено и баланс считаются по услугам и счетам', () => {
    const ctx = seed();
    const a = inBed(ctx, ctx.p1, ctx.bed1, '2026-06-06T22:10:00Z');
    ctx.db.prepare('INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable) VALUES (?, 900, 1, 900000, 900000, 1)').run(a.id);
    ctx.db.prepare('INSERT INTO admission_services (admission_id, service_id, quantity, unit_price, total, billable) VALUES (?, 900, 1, 250000, 250000, 1)').run(a.id);
    ctx.db.prepare("INSERT INTO invoices (invoice_number, admission_id, patient_id, subtotal, total_amount, paid_amount, status) VALUES ('INV-1', ?, ?, 900000, 900000, 400000, 'partial')").run(a.id, ctx.p1);

    const { rows } = admissionsRegister(ctx.db, {}, nurse);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.full_name, 'Каримов Темур');
    assert.equal(r.mrn, '31002');
    assert.equal(r.date_of_birth, '1971-07-03');
    assert.equal(r.attending_name, 'Сотрудник doc1');
    assert.equal(r.payer_name, 'Страховая А');
    assert.equal(r.ward_name, 'Реанимация');
    assert.equal(r.bed_code, '01-01/1');
    assert.equal(r.act_total, 1150000, 'сумма акта — все оказанные строки');
    assert.equal(r.invoiced_total, 900000, 'выставлено — сумма счетов');
    assert.equal(r.paid_total, 400000);
    assert.equal(r.balance, -500000, 'баланс = оплачено − выставлено: минус — долг');
});

test('порядок — новые сверху; без счетов и услуг — нули, без страховой — покрытие пустое (экран покажет «Пациент»)', () => {
    const ctx = seed();
    const old = inBed(ctx, ctx.p2, ctx.bed2, '2026-06-01T06:50:00Z');
    const fresh = inBed(ctx, ctx.p1, ctx.bed1, '2026-06-06T22:10:00Z');
    const { rows, total } = admissionsRegister(ctx.db, { limit: 10 }, cashier);
    assert.equal(total, 2);
    assert.deepEqual(rows.map((r) => r.id), [fresh.id, old.id]);
    const r = rows.find((x) => x.id === old.id);
    assert.deepEqual([r.act_total, r.invoiced_total, r.balance], [0, 0, 0]);
    assert.equal(r.payer_name, null);
});

test('limit ограничен, роли: стационар, регистратура и касса — да; маркетинг — нет', () => {
    const ctx = seed();
    inBed(ctx, ctx.p2, ctx.bed2, '2026-06-01T06:50:00Z');
    inBed(ctx, ctx.p1, ctx.bed1, '2026-06-06T22:10:00Z');
    assert.equal(admissionsRegister(ctx.db, { limit: 1 }, registrar).rows.length, 1);
    assert.equal(admissionsRegister(ctx.db, { limit: 'x' }, registrar).rows.length, 2, 'мусор в limit — значение по умолчанию');
    assert.throws(() => admissionsRegister(ctx.db, {}, marketing), (e) => e instanceof RpcError && e.status === 403);
});
