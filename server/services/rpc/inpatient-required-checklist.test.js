// INPATIENT_REQUIRED_V1 — чек-лист: документы «по желанию», полнота листа по списку клиники, пустые разделы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit } from './inpatient.js';
import { admissionReviewSave, admissionCaseDocs, admissionSetAttending } from './inpatient-reviews.js';
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

// ─── INPATIENT_REQUIRED_V1 (ревью) ───────────────────────────────────────────

test('(ревью) листа нет — он не полон; строка чек-листа несёт started, чтобы экран сказал «не начат»', () => {
  const ctx = seed();
  // В списке клиники только телефон карточки, и он заполнен; самого листа нет.
  inpatientSettingsSave(ctx.db, { title_required_fields: ['phone'] }, admin);
  const a = inBed(ctx, 30);
  const v = admissionTitleSheetGet(ctx.db, { admission_id: a.id }, head);
  assert.equal(v.sheet, null);
  assert.equal(v.complete, false, 'листа нет — лист не полон');
  let t = item(docs(ctx, a), 'title');
  assert.equal(t.started, false);
  assert.equal(t.state, 'overdue');
  assert.deepEqual(t.missing, []);
  // Лист начали — пустот нет: полон, оформлен.
  const s = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { note: 'заметка' } }, nurse);
  assert.equal(s.complete, true);
  t = item(docs(ctx, a), 'title');
  assert.equal(t.started, true);
  assert.equal(t.state, 'published');
  ctx.db.close();
});

test('(ревью) лист «по желанию» и листа нет — не полон и «не начат», но не просрочен', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { title_required: 0 }, admin);
  const a = inBed(ctx, 30);
  assert.equal(admissionTitleSheetGet(ctx.db, { admission_id: a.id }, head).complete, false);
  assert.equal(admissionOverview(ctx.db, { admission_id: a.id }, head).title_sheet.complete, false);
  const t = item(docs(ctx, a), 'title');
  assert.equal(t.started, false);
  assert.equal(t.state, 'pending');
  ctx.db.close();
});

test('(ревью) умолчания: строка листа как сегодня, только с полем started', () => {
  const ctx = seed();
  const a = inBed(ctx, 30);
  let t = item(docs(ctx, a), 'title');
  assert.equal(t.started, false);
  assert.equal(t.state, 'overdue');
  assert.equal(t.required, true);
  assert.equal(t.missing.length, 8);
  assert.equal(admissionTitleSheetGet(ctx.db, { admission_id: a.id }, head).complete, false);
  admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: { height_cm: '172' } }, nurse);
  t = item(docs(ctx, a), 'title');
  assert.equal(t.started, true);
  assert.equal(t.state, 'overdue', 'неполный лист после срока — просрочен, как раньше');
  assert.equal(t.has_draft, true);
  assert.equal(t.missing.length, 7);
  ctx.db.close();
});

test('(ревью) пустой список полей: первое сохранение подписи «заполнил» не ставит', () => {
  for (const setting of [{ title_required: 0 }, { title_required_fields: [] }]) {
    const label = JSON.stringify(setting);
    const ctx = seed();
    inpatientSettingsSave(ctx.db, setting, admin);
    const a = inBed(ctx, 1);
    const v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: {} }, nurse);
    assert.ok(v.sheet, label);
    assert.equal(v.sheet.filled_at, null, label);
    assert.equal(v.sheet.filled_by, null, label);
    // Строка чек-листа: оформлен (пустот нет), время — последней правки, автора нет.
    const t = item(docs(ctx, a), 'title');
    assert.equal(t.state, 'published', label);
    assert.ok(t.published_at, label);
    assert.equal(t.author_name, '', label);
    ctx.db.close();
  }
});

test('(ревью) умолчания: полный лист подписывается при первом полном сохранении, как раньше', () => {
  const ctx = seed();
  const a = inBed(ctx, 1);
  const full = { height_cm: '172', weight_kg: '70', temp_c: '36.6', bp_sys: '120', bp_dia: '80', pulse_bpm: '70', pediculosis: 'none', sanitation: 'full' };
  const v = admissionTitleSheetSave(ctx.db, { admission_id: a.id, sheet: full }, nurse);
  assert.equal(v.complete, true);
  assert.ok(v.sheet.filled_at);
  assert.equal(v.sheet.filled_by, 3);
  ctx.db.close();
});

test('(ревью) документ «по желанию» с черновиком после срока — «черновик», а не «ожидается»', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'head_review', required: false }] }, admin);
  const a = inBed(ctx, 100);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'head_review', objective: '<p>черновик</p>' }, head);
  const it = item(docs(ctx, a), 'head_review');
  assert.equal(it.optional, true);
  assert.equal(it.state, 'draft');
  ctx.db.close();
});

test('(ревью) повторяющийся «по желанию»: сегодняшняя запись есть, прошлых дней нет — «оформлен»; без неё, с черновиком — «черновик»', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'round', required: false }] }, admin);
  const a = inBed(ctx, 100);
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 4 }, head);
  // Черновик дневника — прошлые сутки пропущены, сегодняшних нет.
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'round', objective: '<p>черновик</p>' }, head);
  let it = item(docs(ctx, a), 'round');
  assert.equal(it.state, 'draft');
  assert.equal(it.periods_missing, 0);
  // Запись за сегодня опубликована — прошлые сутки по-прежнему пропущены.
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'round', objective: '<p>сегодня</p>', entry_date: '2026-11-23', publish: true }, head);
  it = item(docs(ctx, a), 'round');
  assert.equal(it.state, 'published');
  assert.equal(it.periods_missing, 0);
  assert.equal(it.required, false);
  ctx.db.close();
});

test('(ревью) «по желанию» без документа — «ожидается», не «просрочен»; обязательный рядом — просрочен, как раньше', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'head_review', required: false }] }, admin);
  const st = docs(ctx, inBed(ctx, 100));
  assert.equal(item(st, 'head_review').state, 'pending');
  assert.equal(item(st, 'rationale').state, 'overdue');
  ctx.db.close();
});

test('(ревью) эпикриз: переключатель включён — строка обязательна, даже если документ «по желанию»; выключен — решает документ', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'discharge', required: false }] }, admin);
  const a = inBed(ctx, 1);
  let st = docs(ctx, a);
  let ep = item(st, 'discharge');
  assert.equal(ep.optional, false);
  assert.equal(ep.required, true);
  assert.ok(st.discharge_gate.incomplete.includes('discharge'));
  assert.equal(st.discharge_gate.blocked, true);
  assert.equal(st.progress.total, st.items.filter((i) => i.required).length);

  // Переключатель выключен: документ «по желанию» — строка по желанию.
  inpatientSettingsSave(ctx.db, { discharge_needs_epicrisis: 0 }, admin);
  st = docs(ctx, a);
  ep = item(st, 'discharge');
  assert.equal(ep.optional, true);
  assert.equal(ep.required, false);
  assert.ok(!st.discharge_gate.incomplete.includes('discharge'));
  assert.equal(st.discharge_gate.blocked, false);

  // Переключатель выключен, документ обязательный — строка обязательна (флаг документа).
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'discharge', required: true }] }, admin);
  st = docs(ctx, a);
  ep = item(st, 'discharge');
  assert.equal(ep.optional, false);
  assert.equal(ep.required, true);
  assert.ok(st.discharge_gate.incomplete.includes('discharge'));
  assert.equal(st.discharge_gate.blocked, false, 'гейт держит только переключатель');
  ctx.db.close();
});

// INPATIENT_REQUIRED_V1 (ревью) — спека §3: документ «по желанию» не входит в прогресс —
// и его черновик тоже (progress.draft считал его, а done/total — нет).
test('(ревью) progress.draft: черновик документа «по желанию» не считается; обязательного — считается, как раньше', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { docs: [{ kind: 'head_review', required: false }] }, admin);
  const a = inBed(ctx, 1);
  const before = docs(ctx, a).progress.draft;
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'head_review', objective: '<p>черновик</p>' }, head);
  let st = docs(ctx, a);
  assert.equal(item(st, 'head_review').state, 'draft');
  assert.equal(st.progress.draft, before, 'черновик «по желанию» в прогресс не входит');
  // Обязательный документ с черновиком — в прогрессе, как раньше.
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'rationale', objective: '<p>черновик</p>' }, head);
  st = docs(ctx, a);
  assert.equal(item(st, 'rationale').state, 'draft');
  assert.equal(st.progress.draft, before + 1);
  assert.equal(st.progress.draft, st.items.filter((i) => !i.optional && (i.state === 'draft' || i.state === 'next')).length);
  ctx.db.close();
});

// INPATIENT_REQUIRED_V1 (ревью) — выключили «лечащий врач только после осмотра», назначили
// лечащего с койки, включили обратно: первичный осмотр публикуется (документом), и строка
// чек-листа перестаёт быть просроченной — раньше отказ держал её красной навсегда.
test('(ревью) выключили → назначили с койки → включили: первичный осмотр опубликован — строка больше не просрочена', () => {
  const ctx = seed();
  inpatientSettingsSave(ctx.db, { intake_before_attending: 0 }, admin);
  const a = inBed(ctx, 100);
  admissionSetAttending(ctx.db, { admission_id: a.id, doctor_id: 4 }, head);
  inpatientSettingsSave(ctx.db, { intake_before_attending: 1 }, admin);
  let st = docs(ctx, a);
  assert.equal(item(st, 'primary').state, 'overdue');
  const overdueBefore = st.progress.overdue;
  admissionReviewSave(ctx.db, { admission_id: a.id, kind: 'primary', diagnosis: 'J18.9', publish: true }, head);
  st = docs(ctx, a);
  assert.equal(item(st, 'primary').state, 'published');
  assert.equal(st.progress.overdue, overdueBefore - 1);
  assert.equal(st.status, 'active');
  ctx.db.close();
});
