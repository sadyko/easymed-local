// JOURNALS_V1_REGISTER — «сумма оплаты» и диагноз госпитализации: одно правило
// на вкладку «Госпитализации» (admissions_register) и отчёт «Реестр
// стационарных пациентов» (run_report inpatient_register).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionsRegister } from '../rpc/admissions-register.js';
import {
  ADMISSION_PAID_TOTAL_SQL, ADMISSION_LAST_PAID_AT_SQL, ADMISSION_REVIEW_DIAGNOSIS_SQL, admissionDiagnosisText,
} from './admission-facts.js';

const admin = { id: 9, role: 'admin' };

function clinic() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (1, 'P-1', 'Каримов Темур')").run();
  db.prepare("INSERT INTO admissions (id, admission_no, patient_id, status, admitted_at, admission_diagnosis) VALUES (1, 'ИБ-1', 1, 'active', '2026-03-10T07:00:00Z', '')").run();
  const inv = db.prepare('INSERT INTO invoices (id, invoice_number, admission_id, patient_id, total_amount, paid_amount, status) VALUES (?,?,1,1,?,?,?)');
  inv.run(10, 'INV-10', 900000, 390000, 'partial');
  inv.run(11, 'INV-11', 777000, 777000, 'void');
  inv.run(12, 'INV-12', 300000, 300000, 'refunded');
  const pay = db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?,?,?,?)');
  pay.run(10, 150000, 'cash', '2026-03-12T07:00:00Z');
  pay.run(10, 250000, 'card', '2026-03-15T07:00:00Z');
  pay.run(10, -10000, 'cash', '2026-03-16T07:00:00Z');   // возврат — не «оплата»
  pay.run(11, 777000, 'cash', '2026-03-18T07:00:00Z');   // отменённый счёт — не в счёт
  const rv = db.prepare('INSERT INTO admission_reviews (admission_id, kind, diagnosis, published_at) VALUES (1, ?, ?, ?)');
  rv.run('primary', 'J18 — Пневмония', '2026-03-11T07:00:00Z');
  rv.run('round', 'I10 — Гипертензия', '2026-03-12T07:00:00Z');
  rv.run('round', '   ', '2026-03-13T07:00:00Z');                 // пустой — пропускается
  rv.run('round', 'Черновик', null);                              // не опубликован
  return db;
}
const fact = (db, sql) => db.prepare(`SELECT ${sql} AS v FROM admissions a WHERE a.id = 1`).get().v;

test('оплачено — без отменённых и возвращённых счетов; последняя оплата — по положительным платежам живых счетов', () => {
  const db = clinic();
  try {
    assert.equal(fact(db, ADMISSION_PAID_TOTAL_SQL('a')), 390000);
    assert.equal(fact(db, ADMISSION_LAST_PAID_AT_SQL('a')), '2026-03-15T07:00:00Z');
    db.prepare("INSERT INTO admissions (id, patient_id, status) VALUES (2, 1, 'active')").run();
    assert.equal(db.prepare(`SELECT ${ADMISSION_PAID_TOTAL_SQL('a')} AS v FROM admissions a WHERE a.id = 2`).get().v, 0);
    assert.equal(db.prepare(`SELECT ${ADMISSION_LAST_PAID_AT_SQL('a')} AS v FROM admissions a WHERE a.id = 2`).get().v, null);
  } finally { db.close(); }
});

test('диагноз: при поступлении, иначе последний опубликованный непустой осмотр', () => {
  const db = clinic();
  try {
    assert.equal(fact(db, ADMISSION_REVIEW_DIAGNOSIS_SQL('a')), 'I10 — Гипертензия');
    assert.equal(admissionDiagnosisText('', 'I10 — Гипертензия'), 'I10 — Гипертензия');
    assert.equal(admissionDiagnosisText('  K35.8 — Острый аппендицит ', 'I10'), 'K35.8 — Острый аппендицит');
    assert.equal(admissionDiagnosisText(null, null), '');
  } finally { db.close(); }
});

test('вкладка «Госпитализации» считает тем же правилом и не держит своей копии', () => {
  const db = clinic();
  try {
    const r = admissionsRegister(db, {}, admin).rows.find((x) => x.id === 1);
    assert.equal(r.paid_total, 390000);
    assert.equal(r.diagnosis, 'I10 — Гипертензия');
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rpc', 'admissions-register.js'), 'utf8');
    assert.doesNotMatch(src, /SUM\(i\.paid_amount\)/, 'своя копия правила «оплачено»');
    assert.doesNotMatch(src, /FROM admission_reviews/, 'своя копия правила «диагноз осмотра»');
    assert.match(src, /\$\{ADMISSION_PAID_TOTAL_SQL\('a'\)\} AS paid_total/);
    assert.match(src, /\$\{ADMISSION_REVIEW_DIAGNOSIS_SQL\('a'\)\} AS review_diagnosis/);
  } finally { db.close(); }
});
