// CASE_DOCS_V1 — чек-лист документов истории болезни и сборка истории в один
// файл (ответ на мокап владельца 040926/doc-checklist-mockup.html).
//
// Мокап — статичная картинка, и главное, чего в нём нет, — ЧАСОВ: все
// одиннадцать сроков там написаны буквами («до 09.06», «было ≤ 72 ч»), а
// состояния расставлены рукой. Поэтому здесь проверяется ровно то, что
// картинкой быть не может:
//
//   1. СРОК — ВЫЧИСЛЕНИЕ ОТ ДАТЫ ГОСПИТАЛИЗАЦИИ, а не строка. Сдвинулась дата
//      размещения — сдвинулись все одиннадцать сроков.
//   2. «ПРОСРОЧЕН» ДЕЛАЮТ ЧАСЫ, А НЕ ФЛАГ. Один и тот же документ на одних и
//      тех же данных «ждёт» в 10:00 и «просрочен» в 12:00 — разница только во
//      времени вопроса.
//   3. ЗАМЕТНОЕ ДЕЙСТВИЕ РОВНО ОДНО. Две кнопки «Продолжить» — это уже не
//      указание, что делать дальше.
//   4. ИСПРАВЛЕНИЕ СОЗДАЁТ РЕДАКЦИЮ И ХРАНИТ ОРИГИНАЛ, а счётчик редакций —
//      настоящий (в мокапе он захардкожен парой строк).
//   5. СБОРКА берёт опубликованные документы в РЕГЛАМЕНТНОМ порядке, черновики
//      не берёт, а неполный набор называет пробелами и всё равно собирается.
//   6. ГЕЙТ ВЫПИСКИ ОБЪЯСНЁН ТЕМ ЖЕ ДОКУМЕНТОМ, которым сервер и отказывает:
//      отказ admission_discharge_request и `discharge_gate` чек-листа обязаны
//      говорить об одной бумаге, иначе экран учит врача не тому.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionOrderCreate, admissionAdmit, admissionDischargeRequest } from './inpatient.js';
import {
  admissionReviewSave, admissionSetAttending, admissionCaseDocs, admissionCaseFile,
  CASE_DOC_SET, SURGICAL_KINDS, OTHER_KIND,
} from './inpatient-reviews.js';
import { RpcError } from './inpatient-flow.js';

const admin      = { id: 1, role: 'admin' };
const registrar  = { id: 2, role: 'registrar' };
const nurse      = { id: 3, role: 'nurse' };
const headDoctor = { id: 4, role: 'doctor', extra_roles: ['head_doctor'] };
const doctor     = { id: 5, role: 'doctor' };
const anesth     = { id: 6, role: 'doctor' };
const cashier    = { id: 7, role: 'cashier' };

const H = 3600 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** «столько-то часов назад / вперёд от момента запуска теста». */
const at = (hours) => iso(NOW + hours * H);

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const users = [
    [1, 'admin1', 'admin', 0, ''],
    [2, 'reg1', 'registrar', 0, ''],
    [3, 'nurse1', 'nurse', 0, ''],
    [4, 'hdoc1', 'doctor', 1, 'Хирургия'],
    [5, 'doc1', 'doctor', 1, 'Хирургия'],
    [6, 'anesth1', 'doctor', 1, 'Анестезиология'],
    [7, 'cash1', 'cashier', 0, ''],
  ];
  for (const [id, username, role, isDoctor, specialty] of users) {
    db.prepare('INSERT INTO users (id, username, password_hash, full_name, role, is_doctor, specialty) VALUES (?,?,?,?,?,?,?)')
      .run(id, username, 'x', 'Сотрудник ' + username, role, isDoctor, specialty);
  }
  const patientId = db.prepare("INSERT INTO patients (full_name, mrn) VALUES ('Салимбоев Шухрат','ID-23825')").run().lastInsertRowid;
  const wardId = db.prepare("INSERT INTO wards (name) VALUES ('Хирургия')").run().lastInsertRowid;
  const bedId = db.prepare("INSERT INTO beds (code, ward_id, status) VALUES ('X-1', ?, 'free')").run(wardId).lastInsertRowid;
  return { db, patientId, wardId, bedId };
}

/**
 * Пациент на койке, размещённый `hoursAgo` часов назад.
 *
 * Время размещения ставится SQL'ем сразу после настоящего admission_admit:
 * маршрут проходится по-настоящему (иначе проверялась бы не та строка), а
 * ЧАСЫ должны быть заданными — на «сейчас» никакой срок не проверить.
 */
function inBed(ctx, hoursAgo = 30) {
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.patientId, department: 'Хирургия' }, registrar);
  const res = admissionAdmit(ctx.db, { admission_id: admission.id, bed_id: ctx.bedId }, nurse);
  ctx.db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(at(-hoursAgo), res.admission.id);
  return ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(res.admission.id);
}

/** Довести до лечения: первичный осмотр + лечащий врач. */
function inTreatment(ctx, adm) {
  admissionReviewSave(ctx.db, {
    admission_id: adm.id, kind: 'primary', diagnosis: 'K35.8',
    complaints: 'Боли в правой подвздошной области', objective: 'Живот напряжён',
    plan: 'Стол №0, инфузия', publish: true,
  }, headDoctor);
  admissionSetAttending(ctx.db, { admission_id: adm.id, doctor_id: doctor.id }, headDoctor);
  return ctx.db.prepare('SELECT * FROM admissions WHERE id = ?').get(adm.id);
}

const itemOf = (state, kind) => state.items.find((i) => i.kind === kind);
const docs = (ctx, adm, hours = 0, user = headDoctor) =>
  admissionCaseDocs(ctx.db, { admission_id: adm.id, now: at(hours) }, user);

// ─── 1. Сроки — арифметика от даты госпитализации ───────────────────────────

test('срок каждого документа ВЫЧИСЛЕН от размещения на койке, а не написан буквами', () => {
  const ctx = seed();
  const adm = inBed(ctx, 30);
  const st = docs(ctx, adm);

  assert.equal(st.base_at, at(-30), 'точка отсчёта — время размещения на койке');
  assert.equal(st.base_source, 'admitted');

  const base = NOW - 30 * H;
  const expect = { consent: 2, intake: 2, head_review: 72, primary: 24, rationale: 72 };
  for (const [kind, hours] of Object.entries(expect)) {
    assert.equal(itemOf(st, kind).due_at, iso(base + hours * H), `срок «${kind}»`);
  }
  // «При выписке» — событие, а не час: срока нет и просроченным он не бывает.
  const epi = itemOf(st, 'discharge');
  assert.equal(epi.due_at, null);
  assert.equal(epi.due_rule, 'at_discharge');
  assert.notEqual(epi.state, 'overdue');
  ctx.db.close();
});

test('сдвинули дату госпитализации — сдвинулись ВСЕ сроки', () => {
  const ctx = seed();
  const adm = inBed(ctx, 30);
  const before = itemOf(docs(ctx, adm), 'primary').due_at;
  ctx.db.prepare('UPDATE admissions SET admitted_at = ? WHERE id = ?').run(at(-6), adm.id);
  const after = itemOf(docs(ctx, adm), 'primary').due_at;
  assert.notEqual(after, before);
  assert.equal(after, iso(NOW - 6 * H + 24 * H), 'срок пересчитан, а не взят из хранимой копии');
  ctx.db.close();
});

test('пока пациент не на койке, часы не идут и чек-лист об этом говорит', () => {
  const ctx = seed();
  const { admission } = admissionOrderCreate(ctx.db, { patient_id: ctx.patientId, department: 'Хирургия' }, registrar);
  const st = admissionCaseDocs(ctx.db, { admission_id: admission.id }, headDoctor);
  assert.equal(st.base_at, null);
  assert.equal(st.base_source, null);
  assert.ok(st.items.every((i) => i.due_at === null), 'ни у одного пункта срока нет');
  assert.equal(st.progress.done, 0);
  assert.equal(st.progress.overdue, 0, 'у пациента без койки нет просроченных: часы не запускались');
  ctx.db.close();
});

// ─── 2. Состояния делают данные и часы ──────────────────────────────────────

test('ОДИН И ТОТ ЖЕ документ «ждёт» до срока и «просрочен» после — разница только в часах', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);   // размещён час назад: срок согласия — 2 ч

  const early = itemOf(docs(ctx, adm, 0), 'consent');
  assert.ok(['pending', 'next'].includes(early.state), `до срока: ${early.state}`);

  const late = itemOf(docs(ctx, adm, 2), 'consent');
  assert.equal(late.state, 'overdue', 'через два часа тот же пункт просрочен');
  // Данные не менялись — менялся только вопрос «который час».
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM admission_reviews WHERE kind='consent'").get().n, 0);
  ctx.db.close();
});

test('опубликованный документ — зелёный, черновик — жёлтый, и это разные состояния', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);

  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'consent', body: 'Согласие подписано', publish: true }, doctor);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'intake', body: 'Осмотр приёмного врача', publish: false }, doctor);

  const st = docs(ctx, adm, 0);
  assert.equal(itemOf(st, 'consent').state, 'published');
  assert.ok(itemOf(st, 'consent').published_at, 'у опубликованного есть время публикации');
  assert.equal(itemOf(st, 'consent').author_name, 'Сотрудник doc1');
  const intake = itemOf(st, 'intake');
  assert.ok(['draft', 'next'].includes(intake.state), `черновик: ${intake.state}`);
  assert.equal(intake.has_draft, true);
  assert.equal(intake.published_at, null);
  ctx.db.close();
});

test('ДНЕВНИК НАБЛЮДЕНИЯ просрочен потому, что закрылись сутки без записи', () => {
  const ctx = seed();
  const adm = inBed(ctx, 30);   // вторые сутки, за первые записи нет
  const st = docs(ctx, adm, 0);
  const diary = itemOf(st, 'round');
  assert.equal(diary.state, 'overdue');
  assert.equal(diary.periods_missing, 1, 'ровно одни пропущенные сутки');
  assert.equal(diary.due_at, iso(NOW - 30 * H + 48 * H), 'следующая запись — до конца текущих суток');

  // Запись за пропущенные сутки закрывает просрочку — и это тоже данные.
  ctx.db.prepare(`INSERT INTO admission_reviews (admission_id, kind, body, author_id, author_role, published_at)
                  VALUES (?, 'round', 'Обход', 5, 'doctor', ?)`).run(adm.id, at(-20));
  assert.equal(itemOf(docs(ctx, adm, 0), 'round').state, 'pending', 'первые сутки закрыты, текущие ещё идут');
  ctx.db.close();
});

test('ЭТАПНЫЙ ЭПИКРИЗ не требуется на второй день и требуется на одиннадцатый', () => {
  const ctx = seed();
  const adm = inBed(ctx, 30);
  const early = itemOf(docs(ctx, adm, 0), 'interim');
  assert.equal(early.required, false, 'через сутки этапного эпикриза с врача не спрашивают');
  assert.equal(early.due_at, iso(NOW - 30 * H + 240 * H), 'но срок уже назван: через 10 суток');

  const late = itemOf(docs(ctx, adm, 240), 'interim');
  assert.equal(late.required, true);
  assert.equal(late.state, 'overdue', 'десять суток прошли, эпикриза нет');
  ctx.db.close();
});

test('ХИРУРГИЧЕСКИЙ БЛОК включается ДАННЫМИ, а не профилем отделения', () => {
  const ctx = seed();
  const adm = inBed(ctx, 30);

  const st0 = docs(ctx, adm, 0);
  assert.equal(st0.surgical, false);
  for (const kind of SURGICAL_KINDS) {
    assert.equal(itemOf(st0, kind).applies, false, `${kind} у терапевтического пациента не спрашивают`);
    assert.equal(itemOf(st0, kind).required, false);
  }
  assert.equal(st0.progress.total, 7, 'обязательных без хирургии и без этапного эпикриза — семь');

  // Анестезиолог написал свой осмотр — значит оперируют.
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'anesthesia', body: 'Осмотр анестезиолога', publish: true }, anesth);
  const st1 = docs(ctx, adm, 0);
  assert.equal(st1.surgical, true);
  assert.equal(itemOf(st1, 'operation').applies, true, 'протокол операции стал обязательным');
  assert.equal(itemOf(st1, 'preop').required, true);
  assert.equal(st1.progress.total, 10, 'три хирургические бумаги добавились к семи');
  assert.ok(st1.surgical_from, 'у блока есть своя точка отсчёта');
  assert.equal(itemOf(st1, 'operation').due_at, iso(Date.parse(st1.surgical_from) + 24 * H));
  ctx.db.close();
});

// ─── 3. Ровно одно заметное действие ────────────────────────────────────────

test('заметное действие ровно одно — и это ПЕРВЫЙ по порядку выполнимый пункт', () => {
  const ctx = seed();
  const adm = inBed(ctx, 30);
  const st = docs(ctx, adm, 0);

  const next = st.items.filter((i) => i.state === 'next');
  assert.equal(next.length, 1, 'две заметные кнопки — это уже не указание, что делать дальше');
  assert.equal(st.next_kind, next[0].kind);
  // Просроченные пункты «следующим» не бывают: «что делать» и «что провалено» —
  // разные вопросы.
  assert.notEqual(next[0].state, 'overdue');
  assert.ok(st.items.some((i) => i.state === 'overdue'), 'просроченные при этом есть');
  // Порядок: следующий стоит раньше любого другого невыполненного непросроченного.
  const candidates = st.items.filter((i) => i.required && ['pending', 'next'].includes(i.state) && i.due_rule !== 'at_discharge');
  assert.equal(candidates[0].kind, st.next_kind);
  ctx.db.close();
});

test('выписной эпикриз не предлагается «следующим» лежащему пациенту', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  const st = docs(ctx, adm, 0);
  assert.notEqual(st.next_kind, 'discharge', 'на первом часу госпитализации это указание не туда');
  ctx.db.close();
});

test('когда остался только эпикриз — он и становится следующим', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  const treated = inTreatment(ctx, adm);
  for (const kind of ['consent', 'intake', 'head_review', 'rationale']) {
    admissionReviewSave(ctx.db, { admission_id: treated.id, kind, body: 'Документ', diagnosis: 'K35.8', publish: true }, headDoctor);
  }
  ctx.db.prepare(`INSERT INTO admission_reviews (admission_id, kind, body, author_id, author_role, published_at)
                  VALUES (?, 'round', 'Обход', 5, 'doctor', ?)`).run(treated.id, at(0));
  const st = docs(ctx, treated, 0);
  assert.deepEqual(st.discharge_gate.incomplete, ['discharge'], 'кроме эпикриза не осталось ничего');
  assert.equal(st.next_kind, 'discharge');
  ctx.db.close();
});

// ─── 4. Редакции — настоящие ────────────────────────────────────────────────

test('ИСПРАВЛЕНИЕ создаёт редакцию, хранит оригинал, и счётчик редакций настоящий', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);

  const first = admissionReviewSave(ctx.db, {
    admission_id: adm.id, kind: 'intake', diagnosis: 'K35.2', body: 'Осмотр приёмного врача', publish: true,
  }, doctor).review;
  const one = itemOf(docs(ctx, adm, 0), 'intake');
  assert.equal(one.revision_count, 1);
  assert.equal(one.revisions.length, 1);
  assert.equal(one.revisions[0].no, 1);
  assert.equal(one.revisions[0].current, true);

  const second = admissionReviewSave(ctx.db, {
    admission_id: adm.id, kind: 'intake', diagnosis: 'K35.8', body: 'Осмотр приёмного врача (испр.)', publish: true,
  }, headDoctor).review;

  const two = itemOf(docs(ctx, adm, 0), 'intake');
  assert.equal(two.revision_count, 2, 'две редакции, а не две записи в списке');
  assert.equal(two.review_id, second.id, 'действующая — вторая');
  assert.deepEqual(two.revisions.map((r) => r.no), [1, 2]);
  assert.equal(two.revisions[0].id, first.id);
  assert.equal(two.revisions[0].current, false);
  assert.equal(two.revisions[1].current, true);
  // Автор и время у каждой редакции — свои, настоящие (в мокапе тут хардкод).
  assert.equal(two.revisions[0].author_name, 'Сотрудник doc1');
  assert.equal(two.revisions[1].author_name, 'Сотрудник hdoc1');
  assert.ok(two.revisions[0].at && two.revisions[1].at);

  // ОРИГИНАЛ ЦЕЛ: текст, автор и время публикации не тронуты.
  const original = ctx.db.prepare('SELECT * FROM admission_reviews WHERE id = ?').get(first.id);
  assert.equal(original.diagnosis, 'K35.2');
  assert.equal(original.superseded_by, second.id);
  assert.equal(original.published_at, first.published_at);
  ctx.db.close();
});

test('дневник наблюдения НЕ закрывает вчерашнюю запись сегодняшней', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  const treated = inTreatment(ctx, adm);
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'round', body: 'Обход 1', publish: true }, doctor);
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'round', body: 'Обход 2', publish: true }, doctor);
  const rows = ctx.db.prepare("SELECT * FROM admission_reviews WHERE kind='round' ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].superseded_by, null, 'вторая запись обхода — не исправление первой');
  assert.equal(itemOf(docs(ctx, treated, 0), 'round').entries, 2);
  ctx.db.close();
});

// ─── 5. Сборка истории болезни ──────────────────────────────────────────────

test('СБОРКА берёт опубликованное в регламентном порядке и не берёт черновики', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  const treated = inTreatment(ctx, adm);   // primary опубликован

  // Пишем НЕ в регламентном порядке — сборка обязана его восстановить.
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'round', body: 'Обход первого дня', publish: true }, doctor);
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'consent', body: 'Согласие', publish: true }, doctor);
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'intake', body: 'Приёмный врач', publish: true }, doctor);
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: OTHER_KIND, body: 'Согласие на препарат пациента', publish: true }, doctor);
  // …и один черновик, который в файл попасть не должен.
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'head_review', body: 'Черновик заведующего', publish: false }, headDoctor);

  const file = admissionCaseFile(ctx.db, { admission_id: treated.id, now: at(0) }, headDoctor);

  assert.deepEqual(file.documents.map((d) => d.kind), ['consent', 'intake', 'primary', 'round', OTHER_KIND],
    'порядок — регламентный, а не порядок написания');
  assert.ok(!file.documents.some((d) => d.kind === 'head_review'), 'черновик в сборку не вошёл');
  assert.equal(file.drafts_excluded, 1, 'и сборка говорит, сколько черновиков осталось за бортом');
  assert.equal(file.documents.find((d) => d.kind === 'primary').diagnosis, 'K35.8', 'текст документа в файле есть');

  // Обложка называет пациента, номер госпитализации, палату, даты и врача.
  assert.equal(file.cover.patient_name, 'Салимбоев Шухрат');
  assert.equal(file.cover.patient_mrn, 'ID-23825');
  assert.ok(file.cover.admission_no, 'номер госпитализации');
  assert.equal(file.cover.ward_name, 'Хирургия');
  assert.equal(file.cover.bed_code, 'X-1');
  assert.equal(file.cover.admitted_at, at(-1));
  assert.equal(file.cover.attending_name, 'Сотрудник doc1');
  assert.equal(file.cover.assembled_by, 'Сотрудник hdoc1');
  ctx.db.close();
});

test('в сборку идёт ДЕЙСТВУЮЩАЯ редакция, и она названа редакцией', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'intake', diagnosis: 'K35.2', body: 'Первая', publish: true }, doctor);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'intake', diagnosis: 'K35.8', body: 'Вторая', publish: true }, doctor);

  const file = admissionCaseFile(ctx.db, { admission_id: adm.id, now: at(0) }, headDoctor);
  const intake = file.documents.filter((d) => d.kind === 'intake');
  assert.equal(intake.length, 1, 'исправленный документ входит ОДИН раз');
  assert.equal(intake[0].body, 'Вторая', 'и это действующая редакция');
  assert.equal(intake[0].revision_count, 2, 'но читатель знает, что документ правили');
  ctx.db.close();
});

test('дневник наблюдения входит в сборку ВЕСЬ, по датам', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  const treated = inTreatment(ctx, adm);
  for (const n of [1, 2, 3]) {
    admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'round', body: 'Обход ' + n, publish: true }, doctor);
  }
  const file = admissionCaseFile(ctx.db, { admission_id: treated.id, now: at(0) }, headDoctor);
  const rounds = file.documents.filter((d) => d.kind === 'round');
  assert.equal(rounds.length, 3, 'течение болезни — это все записи, а не последняя');
  assert.deepEqual(rounds.map((r) => r.body), ['Обход 1', 'Обход 2', 'Обход 3']);
  ctx.db.close();
});

test('неполный набор СОБИРАЕТСЯ, но называет пробелы', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'consent', body: 'Согласие', publish: true }, doctor);

  const file = admissionCaseFile(ctx.db, { admission_id: adm.id, now: at(0) }, headDoctor);
  assert.equal(file.complete, false);
  assert.equal(file.documents.length, 1, 'отказа нет — что есть, то и собрано');
  assert.ok(file.gaps.includes('discharge') && file.gaps.includes('primary'), 'пробелы названы поимённо');
  assert.ok(!file.gaps.includes('consent'), 'оформленное пробелом не считается');
  // И это ровно тот же список, что показывает чек-лист.
  const st = docs(ctx, adm, 0);
  assert.deepEqual(file.gaps, st.discharge_gate.incomplete);
  ctx.db.close();
});

// ─── 6. Гейт выписки объяснён тем же документом ─────────────────────────────

test('чек-лист называет ТОТ ЖЕ документ, которым сервер отказывает в выписке', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  const treated = inTreatment(ctx, adm);

  // (а) эпикриза нет вовсе
  const gateAbsent = docs(ctx, treated, 0).discharge_gate;
  assert.equal(gateAbsent.blocked, true);
  assert.deepEqual(gateAbsent.blocking, [{ kind: 'discharge', reason: 'absent' }]);
  assert.throws(
    () => admissionDischargeRequest(ctx.db, { admission_id: treated.id, outcome: 'home' }, doctor),
    (e) => e.status === 400 && /Выписной эпикриз не написан/.test(e.message),
    'сервер отказывает тем же документом',
  );

  // (б) эпикриз есть, но черновиком — вторая, ДРУГАЯ беда
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'discharge', body: 'Эпикриз', publish: false }, doctor);
  const gateDraft = docs(ctx, treated, 0).discharge_gate;
  assert.deepEqual(gateDraft.blocking, [{ kind: 'discharge', reason: 'draft' }]);
  assert.throws(
    () => admissionDischargeRequest(ctx.db, { admission_id: treated.id, outcome: 'home' }, doctor),
    (e) => e.status === 400 && /черновиком/.test(e.message),
  );

  // (в) опубликовали — гейт открыт и заявка проходит
  admissionReviewSave(ctx.db, { admission_id: treated.id, kind: 'discharge', body: 'Эпикриз', publish: true }, doctor);
  const gateOpen = docs(ctx, treated, 0).discharge_gate;
  assert.equal(gateOpen.blocked, false);
  assert.deepEqual(gateOpen.blocking, []);
  const res = admissionDischargeRequest(ctx.db, { admission_id: treated.id, outcome: 'home' }, doctor);
  assert.equal(res.admission.status, 'discharging');
  ctx.db.close();
});

// ─── 7. Права и целостность ─────────────────────────────────────────────────

test('чек-лист и сборку читают те, кто ведёт пациента; кассе — отказ', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  for (const u of [admin, headDoctor, doctor, nurse]) {
    assert.ok(admissionCaseDocs(ctx.db, { admission_id: adm.id }, u).items.length === CASE_DOC_SET.length, `роль ${u.role}`);
  }
  assert.throws(() => admissionCaseDocs(ctx.db, { admission_id: adm.id }, cashier),
    (e) => e instanceof RpcError && e.status === 403);
  assert.throws(() => admissionCaseFile(ctx.db, { admission_id: adm.id }, cashier),
    (e) => e instanceof RpcError && e.status === 403);
  ctx.db.close();
});

test('анестезиолог пишет свой осмотр, не будучи лечащим врачом', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  // Лечащего врача ещё нет вовсе — и именно поэтому осмотр анестезиолога не
  // может спрашивать assertCanPrescribe: иначе его нельзя было бы написать
  // никогда до назначения лечащего.
  const r = admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'anesthesia', body: 'Риск ASA II', publish: true }, anesth);
  assert.ok(r.review.published_at);
  assert.equal(r.review.author_id, anesth.id);
  ctx.db.close();
});

test('в закрытую госпитализацию документы больше не подшивают', () => {
  const ctx = seed();
  const adm = inBed(ctx, 1);
  ctx.db.prepare("UPDATE admissions SET status='discharged', discharged_at=? WHERE id=?").run(at(0), adm.id);
  assert.throws(
    () => admissionReviewSave(ctx.db, { admission_id: adm.id, kind: 'consent', body: 'Задним числом', publish: true }, doctor),
    (e) => e instanceof RpcError && /закрыта/.test(e.message),
  );
  ctx.db.close();
});

test('набор — один на все госпитализации, и профиль отделения его не задаёт', () => {
  // Честная фиксация решения: профиля отделения в этом продукте сегодня нет
  // (department — свободный текст, миграция 092), и набор от него не зависит.
  // Тест упадёт в тот день, когда профиль появится, — и это ровно та точка,
  // где придётся сознательно решить, как набор от него зависит.
  const ctx = seed();
  const a1 = inBed(ctx, 1);
  ctx.db.prepare("UPDATE admissions SET department='Терапия' WHERE id=?").run(a1.id);
  const st = docs(ctx, a1, 0);
  assert.deepEqual(st.items.map((i) => i.kind), CASE_DOC_SET.map((d) => d.kind));
  assert.equal(st.progress.total, 7, 'общий набор без хирургического блока');
  ctx.db.close();
});
