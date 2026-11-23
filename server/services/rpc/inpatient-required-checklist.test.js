// INPATIENT_REQUIRED_V1 — чек-лист: документы «по желанию», полнота листа по списку клиники, пустые разделы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionReviewSave, admissionCaseDocs } from './inpatient-reviews.js';
import { admissionTitleSheetGet, admissionTitleSheetSave } from './title-sheet.js';
import { inpatientSettingsSave } from './inpatient-settings.js';
import { admissionOverview } from './case-overview.js';

const admin = { id: 1, role: 'admin' };
const registrar = { id: 2, role: 'registrar' };
const nurse = { id: 3, role: 'nurse' };
const head = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const H = 3600 * 1000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  for (const [id, u, role, isDoc] of [[1, 'adm', 'admin', 0], [2, 'reg', 'registrar', 0], [3, 'nur', 'nurse', 0], [4, 'head', 'doctor', 1]]) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (?,?,?,?,?,?)').run(id, u, 'x', 'Сотрудник ' + u, role, isDoc);
  }
  const pid = db.prepare("INSERT INTO patients (full_name, mrn, phone) VALUES ('Тестов Пациент','T-0002','+998900000000')").run().lastInsertRowid;
  const ward = db.prepare("INSERT INTO wards (name) VALUES ('Терапия')").run().lastInsertRowid;
  const bed = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('T-1', ?, 'free')").run(ward).lastInsertRowid;
  return { db, pid, bed };
}
function inBed(ctx, hoursAgo) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.pid, department: 'Терапия' }, registrar);
  const a = admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: ctx.bed }, nurse).admission;
  ctx.db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(iso(NOW - hoursAgo * H), a.id);
  return a;
}
const docs = (ctx, a) => admissionCaseDocs(ctx.db, { admission_id: a.id, now: iso(NOW) }, head);
const item = (st, kind) => st.items.find((i) => i.kind === kind);
// База клиники, которая не дошла до 298: ни строки настроек, ни журнала, ни колонок набора.
function dropTo297(db) {
  db.exec('DROP TABLE inpatient_settings_log; DROP TABLE inpatient_settings;');
  db.exec('ALTER TABLE case_doc_types DROP COLUMN required_sections; ALTER TABLE case_doc_types DROP COLUMN required;');
}

test('умолчания: всё обязательно, как раньше; поля несут optional и missing_sections', () => {
  const ctx = seed();
  const st = docs(ctx, inBed(ctx, 100));
  for (const it of st.items) {
    assert.equal(it.optional, false, it.kind);
    assert.deepEqual(it.missing_sections, [], it.kind);
  }
  assert.equal(item(st, 'title').required, true);
  assert.deepEqual(item(st, 'title').missing, ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
  assert.equal(item(st, 'head_review').state, 'overdue');
  assert.equal(st.discharge_gate.epicrisis_required, true);
  ctx.db.close();
});

test('документ «по желанию»: не просрочен, не следующий шаг, не в прогрессе и не в «не оформлено»', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'head_review', required: false }, { kind: 'intake', required: false }] }, admin);
  const st = docs(ctx, inBed(ctx, 100));
  for (const kind of ['head_review', 'intake']) {
    const it = item(st, kind);
    assert.equal(it.optional, true, kind);
    assert.equal(it.required, false, kind);
    assert.equal(it.state, 'pending', kind);
    assert.ok(!st.discharge_gate.incomplete.includes(kind), kind);
  }
  assert.notEqual(st.next_kind, 'intake');
  assert.notEqual(st.next_kind, 'head_review');
  const required = st.items.filter((i) => i.required).length;
  assert.equal(st.progress.total, required);
  ctx.db.close();
});

test('титульный лист не обязателен: строка «по желанию», не просрочена, не держит набор', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { title_required: 0 }, admin);
  const st = docs(ctx, inBed(ctx, 30));
  const t = item(st, 'title');
  assert.equal(t.required, false);
  assert.equal(t.optional, true);
  assert.equal(t.state, 'pending');
  assert.deepEqual(t.missing, []);
  assert.ok(!st.discharge_gate.incomplete.includes('title'));
  ctx.db.close();
});

test('свой список полей листа: поле карточки и отметка бумаги; filled_at — по списку клиники', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { title_required_fields: ['height_cm', 'phone', 'consent_signed'] }, admin);
  const a = inBed(ctx, 1);
  let v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { height_cm: '172' } }, nurse);
  assert.deepEqual(v.required_fields, ['phone', 'height_cm', 'consent_signed']);
  assert.deepEqual(v.missing, ['consent_signed']);
  assert.equal(v.complete, false);
  assert.equal(v.sheet.filled_at, null);
  v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { consent_signed: true } }, nurse);
  assert.equal(v.complete, true);
  assert.ok(v.sheet.filled_at, 'лист заполнен по списку клиники — подпись ставится');
  assert.equal(item(docs(ctx, a), 'title').state, 'published');
  // Без телефона в карточке лист снова неполон (карточку правят из листа же).
  v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, patient: { phone: '' } }, nurse);
  assert.deepEqual(v.missing, ['phone']);
  assert.deepEqual(admissionTitleSheetGet(ctx.db, { admission_id: a.id }, head).missing, ['phone']);
  ctx.db.close();
});

test('missing_sections: опубликованный с пустым обязательным разделом — оформлен, но пробел назван; черновик — тоже', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'primary', required_sections: ['diagnosis', 'plan'] }, { kind: 'intake', required_sections: ['complaints'] }] }, admin);
  const a = inBed(ctx, 1);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', plan: '<p><br></p>', publish: true }, head);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'intake', objective: '<p>ясно</p>' }, head);   // черновик
  const st = docs(ctx, a);
  assert.equal(item(st, 'primary').state, 'published');
  assert.deepEqual(item(st, 'primary').missing_sections, ['plan']);
  assert.deepEqual(item(st, 'intake').missing_sections, ['complaints']);
  assert.deepEqual(item(st, 'round').missing_sections, [], 'документа нет — пробелов не называем');
  ctx.db.close();
});

test('гейт выписки: эпикриз не обязателен — не держит и чек-лист говорит то же', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { discharge_needs_epicrisis: 0 }, admin);
  const st = docs(ctx, inBed(ctx, 1));
  assert.equal(st.discharge_gate.blocked, false);
  assert.equal(st.discharge_gate.epicrisis_required, false);
  ctx.db.close();
});

// ─── Добавлено при исполнении: края, которых план не назвал ──────────────────

test('умолчания: гейт эпикриза держит, как раньше; лист отвечает прежними восемью полями', () => {
  const ctx = seed();
  const a = inBed(ctx, 1);
  const st = docs(ctx, a);
  assert.equal(st.discharge_gate.blocked, true);
  assert.deepEqual(st.discharge_gate.blocking, [{ kind: 'discharge', reason: 'absent' }]);
  const v = admissionTitleSheetGet(ctx.db, { admission_id: a.id }, head);
  assert.deepEqual(v.required_fields, ['height_cm', 'weight_kg', 'temp_c', 'bp_sys', 'bp_dia', 'pulse_bpm', 'pediculosis', 'sanitation']);
  assert.equal(v.title_required, true);
  assert.equal(v.missing.length, 8);
  ctx.db.close();
});

test('повторяющийся документ «по желанию»: пропущенных периодов не считает и не краснеет', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'round', required: false }] }, admin);
  const it = item(docs(ctx, inBed(ctx, 100)), 'round');
  assert.equal(it.optional, true);
  assert.equal(it.required, false);
  assert.equal(it.periods_missing, 0);
  assert.equal(it.state, 'pending');
  ctx.db.close();
});

test('лист стал полным, потому что список сократили: оформлен, время — последней правки, без подписи «заполнил»', () => {
  const ctx = seed();
  const a = inBed(ctx, 1);
  admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { height_cm: '172' } }, nurse);
  assert.equal(item(docs(ctx, a), 'title').state, 'draft');
  inpatientSettingsSave(ctx.db, { title_required_fields: ['height_cm'] }, admin);
  const t = item(docs(ctx, a), 'title');
  assert.equal(t.state, 'published');
  assert.ok(t.published_at, 'оформленный лист показывает время');
  assert.deepEqual(t.required_fields, ['height_cm']);
  assert.deepEqual(t.missing, []);
  ctx.db.close();
});

test('снятая галочка бумаги в обязательном списке — лист снова неполон', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { title_required_fields: ['memo_given'] }, admin);
  const a = inBed(ctx, 1);
  let v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { memo_given: true } }, nurse);
  assert.equal(v.complete, true);
  v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { memo_given: false } }, nurse);
  assert.equal(v.complete, false);
  assert.deepEqual(v.missing, ['memo_given']);
  ctx.db.close();
});

test('обзор госпитализации: титульный лист несёт недостающие поля и обязательность', () => {
  const ctx = seed();
  const a = inBed(ctx, 1);
  let ov = admissionOverview(ctx.db, { admission_id: a.id }, head);
  assert.equal(ov.title_sheet.complete, false);
  assert.equal(ov.title_sheet.required, true);
  assert.equal(ov.title_sheet.missing.length, 8);
  inpatientSettingsSave(ctx.db, { title_required: 0 }, admin);
  ov = admissionOverview(ctx.db, { admission_id: a.id }, head);
  assert.equal(ov.title_sheet.required, false);
  assert.deepEqual(ov.title_sheet.missing, []);
  ctx.db.close();
});

test('база старше 298 — чек-лист и лист как сегодня', () => {
  const ctx = seed();
  const a = inBed(ctx, 100);
  dropTo297(ctx.db);
  const st = docs(ctx, a);
  for (const it of st.items) {
    assert.equal(it.optional, false, it.kind);
    assert.deepEqual(it.missing_sections, [], it.kind);
  }
  assert.equal(item(st, 'title').required, true);
  assert.equal(item(st, 'title').state, 'overdue');
  assert.equal(item(st, 'title').missing.length, 8);
  assert.equal(item(st, 'intake').state, 'overdue');
  assert.equal(st.discharge_gate.blocked, true);
  assert.equal(st.discharge_gate.epicrisis_required, true);
  const v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { height_cm: '172' } }, nurse);
  assert.equal(v.missing.length, 7);
  assert.equal(v.complete, false);
  ctx.db.close();
});
