// TITLE_SHEET_V1 — титульный лист: правила, роли, дописывание, карточка.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionTitleSheetGet, admissionTitleSheetSave, titleSheetCaseItem, SHEET_DUE_HOURS } from './title-sheet.js';
import { RpcError } from './inpatient-flow.js';

const admin     = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse     = { id: 3, role: 'nurse' };
const doctor    = { id: 5, role: 'doctor' };
const cashier   = { id: 7, role: 'cashier' };
const senior    = { id: 9, role: 'nurse', extra_roles: ['senior_nurse'] };

function seed() {
    const db = openDb(':memory:');
    migrate(db);
    const users = [[1, 'admin1', 'admin'], [2, 'reg1', 'registrar'], [3, 'nurse1', 'nurse'], [5, 'doc1', 'doctor'], [7, 'cash1', 'cashier'], [9, 'senior1', 'nurse']];
    for (const [id, username, role] of users) {
        db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)').run(id, username, 'x', 'Сотрудник ' + username, role);
    }
    const patientId = db.prepare("INSERT INTO patients (full_name, mrn, date_of_birth, gender, phone) VALUES ('Иванов Иван Иванович','ID-1','1994-11-15','male','+998901112233')").run().lastInsertRowid;
    const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
    const bedId = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(wardId).lastInsertRowid;
    return { db, patientId, wardId, bedId };
}
function ordered(ctx) {
    return admissionOrderCreate(ctx.db, { patient_id: ctx.patientId, department: 'Терапия', admission_diagnosis: 'J18.9' }, registrar).admission;
}
function inBed(ctx) {
    const adm = ordered(ctx);
    return admissionAdmit(ctx.db, { admission_id: adm.id, bed_id: ctx.bedId }, nurse).admission;
}
const FULL = { height_cm: 172, weight_kg: '72,5', temp_c: 36.6, bp_sys: 120, bp_dia: 80, pulse_bpm: 72, pediculosis: 'none', sanitation: 'full' };

test('get: личные данные из карточки, лист пуст, срок — 2 часа от размещения', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetGet(ctx.db, { admission_id: adm.id }, doctor);
    assert.equal(v.patient.full_name, 'Иванов Иван Иванович');
    assert.equal(v.patient.phone, '+998901112233');
    assert.equal(v.admission.bed_code, 'T-1');
    assert.equal(v.admission.ward_name, 'Терапия');
    assert.equal(v.sheet, null);
    assert.equal(v.complete, false);
    assert.equal(v.missing.length, 8);
    assert.equal(Date.parse(v.due_at) - Date.parse(adm.admitted_at), SHEET_DUE_HOURS * 3600 * 1000);
});

test('save: запятая принимается, ИМТ считается, лист полон, подпись ставится один раз', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: FULL }, nurse);
    assert.equal(v.sheet.weight_kg, 72.5);
    assert.equal(v.bmi, 24.5);
    assert.equal(v.complete, true);
    assert.deepEqual(v.missing, []);
    assert.equal(v.sheet.filled_by, nurse.id);
    assert.ok(v.sheet.filled_at);
    const again = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'спит' } }, senior);
    assert.equal(again.sheet.filled_by, nurse.id, 'подпись первого заполнения не переписывается');
    assert.equal(again.sheet.note, 'спит');
    assert.equal(again.sheet.height_cm, 172, 'незатронутые поля остались');
});

test('save: неполный лист сохраняется и называет, чего не хватает', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { height_cm: 172, pediculosis: 'none' } }, nurse);
    assert.equal(v.complete, false);
    assert.deepEqual(v.missing, ['weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'sanitation']);
    assert.equal(v.sheet.filled_at, null);
});

test('save: невозможное значение отвергается словами, называющими поле', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const bad = [
        [{ height_cm: 2 }, /Рост: укажите от 30 до 250 см/],
        [{ weight_kg: 'много' }, /Вес: нужно число/],
        [{ pulse_bpm: 72.5 }, /Пульс: нужно целое число/],
        [{ bp_sys: 80, bp_dia: 120 }, /нижнее давление должно быть меньше верхнего/],
        [{ pediculosis: 'maybe' }, /Осмотр на педикулёз/],
        [{ sanitation: 'yes' }, /Санитарная обработка/],
    ];
    for (const [sheet, re] of bad) {
        assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet }, nurse),
            (e) => e instanceof RpcError && e.status === 400 && re.test(e.message), 'не отвергнуто: ' + JSON.stringify(sheet));
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM admission_title_sheets').get().n, 0, 'отвергнутый лист не должен сохраняться');
});

test('save: исправления личных данных уходят в карточку, ФИО и дата рождения — нет', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, {
        admission_id: adm.id, sheet: {},
        patient: { phone: '+998900000000', address: 'Ташкент, Чиланзар 5', occupation: 'учитель', blood_type: 'O(I) Rh+', full_name: 'Другой', date_of_birth: '2000-01-01' },
    }, nurse);
    assert.equal(v.patient.phone, '+998900000000');
    assert.equal(v.patient.address, 'Ташкент, Чиланзар 5');
    assert.equal(v.patient.blood_type, 'O(I) Rh+');
    assert.equal(v.patient.full_name, 'Иванов Иван Иванович');
    assert.equal(v.patient.date_of_birth, '1994-11-15');
    const row = ctx.db.prepare('SELECT phone, address FROM patients WHERE id = ?').get(ctx.patientId);
    assert.equal(row.phone, '+998900000000');
    assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, patient: { gender: 'x' } }, nurse), /Пол/);
});

test('роли: пишут медсестра, старшая, администратор; врач и кассир — нет; читают все, кто ведёт историю', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    for (const who of [nurse, senior, admin]) admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'ok' } }, who);
    for (const who of [doctor, cashier, registrar]) {
        assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'x' } }, who),
            (e) => e instanceof RpcError && e.status === 403 && /медсестра, старшая медсестра, администратор/.test(e.message));
    }
    for (const who of [nurse, senior, admin, doctor]) admissionTitleSheetGet(ctx.db, { admission_id: adm.id }, who);
    assert.throws(() => admissionTitleSheetGet(ctx.db, { admission_id: adm.id }, cashier), (e) => e.status === 403);
});

test('до койки листа нет: у заявки его не сохранить', () => {
    const ctx = seed();
    const adm = ordered(ctx);
    assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: FULL }, nurse), /ещё не размещён/);
});

test('admission_admit с листом — одна операция: плохой лист не кладёт пациента, хороший кладёт и сохраняет', () => {
    const ctx = seed();
    const adm = ordered(ctx);
    assert.throws(() => admissionAdmit(ctx.db, { admission_id: adm.id, bed_id: ctx.bedId, title_sheet: { sheet: { height_cm: 2 } } }, nurse), /Рост/);
    assert.equal(ctx.db.prepare('SELECT status FROM admissions WHERE id = ?').get(adm.id).status, 'ordered', 'пациент не должен быть размещён');
    assert.equal(ctx.db.prepare('SELECT status FROM beds WHERE id = ?').get(ctx.bedId).status, 'free', 'койка не должна быть занята');

    const res = admissionAdmit(ctx.db, { admission_id: adm.id, bed_id: ctx.bedId, title_sheet: { sheet: FULL, patient: { phone: '+998911111111' } } }, nurse);
    assert.equal(res.admission.status, 'admitted');
    assert.equal(res.title_sheet.height_cm, 172);
    assert.equal(res.title_sheet.filled_by, nurse.id);
    assert.equal(ctx.db.prepare('SELECT phone FROM patients WHERE id = ?').get(ctx.patientId).phone, '+998911111111');
});

test('строка чек-листа: pending → overdue по часам, draft при неполном, published при полном', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const base = Date.parse(adm.admitted_at);
    const H = 3600 * 1000;
    const item = (now) => titleSheetCaseItem(ctx.db, ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id), base, now);
    assert.equal(item(base + 1 * H).state, 'pending');
    assert.equal(item(base + 3 * H).state, 'overdue');
    assert.equal(item(base + 1 * H).kind, 'title');
    assert.equal(item(base + 1 * H).order, -1);
    admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { height_cm: 172 } }, nurse);
    assert.equal(item(base + 1 * H).state, 'draft');
    assert.equal(item(base + 3 * H).state, 'overdue', 'неполный и просроченный — просрочен');
    admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: FULL }, nurse);
    const done = item(base + 3 * H);
    assert.equal(done.state, 'published');
    assert.ok(done.published_at);
    assert.equal(done.author_name, 'Сотрудник nurse1');
});

// ─── INPATIENT_DOCS_V1 — бумаги при поступлении ─────────────────────────────
test('галочки о бумагах: время ставится один раз, снятие стирает, «true»/«1» — отметка, полнота не меняется', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v1 = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { contract_signed: true, consent_signed: '1', memo_given: 'true' } }, nurse);
    assert.ok(v1.sheet.contract_signed_at && v1.sheet.consent_signed_at && v1.sheet.memo_given_at, 'отметки не легли');
    const t = v1.sheet.contract_signed_at;
    const v2 = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { note: 'x' } }, nurse);
    assert.equal(v2.sheet.contract_signed_at, t, 'сохранение без галочки не должно её трогать');
    const v3 = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { contract_signed: true, memo_given: false } }, nurse);
    assert.equal(v3.sheet.contract_signed_at, t, 'повторная отметка не переписывает время');
    assert.equal(v3.sheet.memo_given_at, null, 'снятая галочка должна стереть время');
    assert.equal(v3.complete, false, 'бумаги не делают лист полным — полнота про измерения');
    const item = titleSheetCaseItem(ctx.db, ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id), Date.parse(adm.admitted_at), Date.now());
    assert.equal(item.papers.contract_signed_at, t);
    assert.equal(item.papers.memo_given_at, null);
    const empty = titleSheetCaseItem(ctx.db, ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id + 999) || { id: -1 }, null, Date.now());
    assert.deepEqual(empty.papers, { contract_signed_at: null, consent_signed_at: null, memo_given_at: null });
});

// ─── FORM_003_V1 — строки 6 и 8 бланка и данные для строк 1–10 ─────────────
test('бланк 003: как доставляют, транспорт, время от начала болезни — сохраняются; чужое значение отвергается; дни и диагноз приёмного покоя приезжают', () => {
    const ctx = seed();
    const adm = inBed(ctx);
    const v = admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { mobility: 'stretcher', delivered_by: 'скорая', since_onset: '2 суток' } }, nurse);
    assert.equal(v.sheet.mobility, 'stretcher');
    assert.equal(v.sheet.delivered_by, 'скорая');
    assert.equal(v.sheet.since_onset, '2 суток');
    assert.throws(() => admissionTitleSheetSave(ctx.db, { admission_id: adm.id, sheet: { mobility: 'car' } }, nurse), /Как доставляют/);
    assert.equal(v.admission.days, 1, 'первые сутки на койке — день 1');
    assert.equal(v.admission.clinical_diagnosis, '', 'осмотра ещё нет');
    assert.match(v.admission.admission_no, /^\d{4}\/\d{5}$/, 'номер истории — ГГГГ/NNNNN');
});
