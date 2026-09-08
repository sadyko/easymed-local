// ADMISSION_NUMBER_V2 — «2026/00051»: год, дробь, пятизначный счётчик с начала года.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { nextAdmissionNo } from './admission-number.js';
import { admissionOrderCreate } from '../rpc/inpatient.js';

const registrar = { id: 2, role: 'registrar' };

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'reg1','x','Регистратор','registrar')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (1,'П')").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (2,'Р')").run();
    return db;
}

test('первый номер года — 00001, дальше по порядку; другой год начинает заново; старые ADM-… не мешают', () => {
    const db = seed();
    assert.equal(nextAdmissionNo(db, '2026-09-08T10:00:00Z'), '2026/00001');
    db.prepare("INSERT INTO admissions (patient_id, status, admission_no) VALUES (1, 'ordered', '2026/00001')").run();
    db.prepare("INSERT INTO admissions (patient_id, status, admission_no) VALUES (1, 'ordered', 'ADM-00007')").run();
    assert.equal(nextAdmissionNo(db, '2026-12-31T23:59:59Z'), '2026/00002');
    db.prepare("INSERT INTO admissions (patient_id, status, admission_no) VALUES (1, 'ordered', '2026/00051')").run();
    assert.equal(nextAdmissionNo(db, '2026-09-08T10:00:00Z'), '2026/00052', 'счётчик идёт от НАИБОЛЬШЕГО выданного, а не от количества');
    assert.equal(nextAdmissionNo(db, '2027-01-01T00:00:00Z'), '2027/00001', 'новый год — заново');
});

test('заявка на госпитализацию получает номер вида ГГГГ/NNNNN', () => {
    const db = seed();
    const { admission } = admissionOrderCreate(db, { patient_id: 1, department: 'Терапия' }, registrar);
    assert.match(admission.admission_no, /^\d{4}\/\d{5}$/);
    assert.equal(admission.admission_no.slice(5), '00001');
    const second = admissionOrderCreate(db, { patient_id: 2, department: 'Терапия' }, registrar).admission;   // у первого пациента заявка уже открыта
    assert.equal(second.admission_no.slice(5), '00002');
});
