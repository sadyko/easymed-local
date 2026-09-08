// PATIENT_HISTORY_TAB_V1 — «История» в карте пациента: госпитализации и подшитые истории болезни.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { patientCard } from './patient-card.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionReviewSave, admissionCaseFileSave } from './inpatient-reviews.js';
import { PATIENT_CARD_TABS, PATIENT_TAB_CAPS } from '../roles.js';

const admin      = { id: 1, role: 'admin' };
const registrar  = { id: 2, role: 'registrar' };
const nurse      = { id: 3, role: 'nurse' };
const headDoctor = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    for (const [id, u, role, isDoc] of [[1, 'admin1', 'admin', 0], [2, 'reg1', 'registrar', 0], [3, 'nurse1', 'nurse', 0], [4, 'hdoc1', 'doctor', 1]]) {
        db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoc);
    }
    const pid = db.prepare("INSERT INTO patients (full_name, mrn, branch_id) VALUES ('Иванов Иван','ID-1',1)").run().lastInsertRowid;
    const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
    const bedId = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(wardId).lastInsertRowid;
    return { db, pid, bedId };
}

test('вкладка «История» — в реестре сервера, без прав на изменение и удаление', () => {
    assert.ok(PATIENT_CARD_TABS.includes('history'));
    assert.deepEqual(PATIENT_TAB_CAPS.history, { edit: false, del: false });
});

test('карта отдаёт госпитализации пациента и подшитые истории, привязанные к госпитализации', () => {
    const ctx = seed();
    const before = patientCard(ctx.db, { patient_id: ctx.pid }, admin);
    assert.deepEqual(before.history, { admissions: [], case_files: [] }, 'без госпитализаций — пустая история, не null');

    const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.pid, department: 'Терапия' }, registrar);
    const adm = admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: ctx.bedId }, nurse).admission;
    admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'primary', diagnosis: 'J18.9', complaints: 'Кашель', objective: 'Хрипы', plan: 'АБ', publish: true }, headDoctor);
    const saved = admissionCaseFileSave(ctx.db, { admission_id: adm.id }, headDoctor);

    const card = patientCard(ctx.db, { patient_id: ctx.pid }, admin);
    assert.equal(card.history.admissions.length, 1);
    const a = card.history.admissions[0];
    assert.equal(a.id, adm.id);
    assert.equal(a.department, 'Терапия');
    assert.equal(a.bed_code, 'T-1');
    assert.equal(card.history.case_files.length, 1);
    const f = card.history.case_files[0];
    assert.equal(f.id, saved.document_id);
    assert.equal(f.admission_id, adm.id, 'подшитая история знает свою госпитализацию');
    assert.equal(f.admission_no, adm.admission_no);
    assert.equal(f.created_by_name, 'Сотрудник hdoc1');
    assert.equal(f.complete, false, 'комплект неполный — только первичный осмотр');
    assert.ok(f.gaps > 0);
    assert.ok(f.body && Array.isArray(f.body.documents) && f.body.documents.length === 1, 'снимок истории — целиком, для печати');
});
