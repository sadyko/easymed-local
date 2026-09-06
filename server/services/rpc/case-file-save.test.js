// CASE_FILE_SAVE_V1 (2026-09-06) — СОБРАННАЯ ИСТОРИЯ БОЛЕЗНИ ЛОЖИТСЯ В КАРТУ.
//
// Владелец: «when the pressed the collect history, its will be saved in the
// documents section of the patient».
//
// До сих пор «Собрать историю» открывала окно печати и на этом заканчивалась:
// закрыл вкладку — и собранного документа нет нигде. А это та самая бумага,
// которую спрашивают через год.
//
// Проверяется не «RPC ответил», а ТО, ЧТО ЛЕГЛО В КАРТУ: строка документа у
// нужного пациента, со снимком, в котором лежат опубликованные записи и нет
// черновиков. Ответ без записи в базе выглядел бы на экране точно так же —
// тост «сохранено» и пустая карта.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { admissionCaseFileSave } from './inpatient-reviews.js';

const DOCTOR = { id: 2, role: 'doctor', is_doctor: 1 };
const HEAD = { id: 3, role: 'head_doctor' };

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (2,'doc','x','Каримова Азиза','doctor')").run();
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (3,'head','x','Юсупов Бахтиёр','doctor')").run();
  db.prepare("INSERT INTO patients (id, mrn, full_name) VALUES (7, 'P-7', 'Иванов Пётр')").run();
  db.prepare(`INSERT INTO admissions (id, patient_id, status, admission_no, attending_doctor_id, admitted_at)
              VALUES (5, 7, 'active', 'A-26-0005', 2, '2026-09-01T09:00:00Z')`).run();
  return db;
}

/** Опубликованная запись нужного рода — так их пишет rpc admission_review_publish. */
function publish(db, kind, text, at = '2026-09-02T10:00:00Z') {
  db.prepare(`INSERT INTO admission_reviews (admission_id, kind, complaints, objective, diagnosis, plan, body,
                author_id, author_role, published_at, created_at)
              VALUES (5, ?, ?, '', '', '', '', 2, 'doctor', ?, ?)`)
    .run(kind, text, at, at);
}

function draft(db, kind, text) {
  db.prepare(`INSERT INTO admission_reviews (admission_id, kind, complaints, author_id, author_role, created_at)
              VALUES (5, ?, ?, 2, 'doctor', '2026-09-03T10:00:00Z')`).run(kind, text);
}

const docsOf = (db) => db.prepare("SELECT * FROM visit_documents WHERE doc_type = 'case_file'").all();

test('собранная история появляется в документах ПАЦИЕНТА, а не только в печати', (t) => {
  const db = seed();
  t.after(() => db.close());
  publish(db, 'primary', 'Боль в груди');

  const res = admissionCaseFileSave(db, { admission_id: 5 }, DOCTOR);

  const docs = docsOf(db);
  assert.equal(docs.length, 1, 'документ не подшит в карту — «сохранено» было бы обманом');
  assert.equal(docs[0].patient_id, 7, 'история легла не тому пациенту');
  assert.equal(res.document_id, docs[0].id);
  // Печать берёт снимок ИЗ ОТВЕТА, а не собирает второй раз: две сборки
  // однажды разойдутся, и бумага перестанет соответствовать подшитому.
  assert.ok(res.file && res.file.cover, 'в ответе нет снимка — печатать будет нечего');
  assert.deepEqual(res.file, JSON.parse(docs[0].body), 'напечатано будет не то, что подшито');
  assert.match(docs[0].title, /История болезни/);
  assert.match(docs[0].title, /A-26-0005/, 'в названии нет номера госпитализации — их у пациента бывает несколько');
  assert.equal(docs[0].created_by, 2, 'не записано, кто собрал');
});

test('в снимке лежат опубликованные записи — тот же состав, что уходит в печать', (t) => {
  const db = seed();
  t.after(() => db.close());
  publish(db, 'primary', 'Боль в груди');
  publish(db, 'rationale', 'Обоснование диагноза', '2026-09-03T09:00:00Z');

  admissionCaseFileSave(db, { admission_id: 5 }, DOCTOR);
  const body = JSON.parse(docsOf(db)[0].body);

  assert.equal(body.admission_id, 5);
  assert.ok(body.cover && body.cover.patient_name === 'Иванов Пётр', 'в снимке нет обложки с пациентом');
  const kinds = (body.documents || []).map((d) => d.kind);
  assert.ok(kinds.includes('primary') && kinds.includes('rationale'),
    'опубликованные записи не попали в снимок: ' + kinds.join(', '));
  assert.ok((body.documents || []).some((d) => d.complaints === 'Боль в груди'),
    'текст записи в снимок не попал — подшили пустую обложку');
});

test('черновик в подшитую историю не попадает, но о нём сказано', (t) => {
  const db = seed();
  t.after(() => db.close());
  publish(db, 'primary', 'Опубликованная запись');
  draft(db, 'round', 'Недописанный дневник');

  const res = admissionCaseFileSave(db, { admission_id: 5 }, DOCTOR);
  const body = JSON.parse(docsOf(db)[0].body);

  assert.ok(!JSON.stringify(body.documents).includes('Недописанный дневник'),
    'незаконченная запись врача оказалась в подшитой истории болезни');
  assert.equal(res.drafts_excluded, 1,
    'о пропущенном черновике не сказано — собравший не узнает, что осталось за бортом');
});

test('неполную историю собрать МОЖНО, и недостающее названо', (t) => {
  const db = seed();
  t.after(() => db.close());
  publish(db, 'primary', 'Только один документ');

  const res = admissionCaseFileSave(db, { admission_id: 5 }, DOCTOR);
  assert.equal(docsOf(db).length, 1, 'сборку запретили из-за недостающих бумаг — тогда история недоступна никому');
  assert.equal(res.complete, false);
  assert.ok(Array.isArray(res.gaps) && res.gaps.length > 0, 'не сказано, чего не хватает');
});

test('каждая сборка — отдельный документ: прежняя остаётся историей', (t) => {
  const db = seed();
  t.after(() => db.close());
  publish(db, 'primary', 'Первая редакция');
  admissionCaseFileSave(db, { admission_id: 5 }, DOCTOR);
  publish(db, 'round', 'Дневник наблюдения', '2026-09-04T10:00:00Z');
  admissionCaseFileSave(db, { admission_id: 5 }, HEAD);

  const docs = docsOf(db);
  assert.equal(docs.length, 2, 'вторая сборка затёрла первую — а собранное однажды не должно исчезать');
  assert.equal(docs[1].created_by, 3, 'вторую сборку записали не на того, кто её сделал');
});

test('роль без права читать историю болезни её и не соберёт', (t) => {
  const db = seed();
  t.after(() => db.close());
  publish(db, 'primary', 'Запись');

  assert.throws(() => admissionCaseFileSave(db, { admission_id: 5 }, { id: 9, role: 'registrar' }),
    /История болезни|доступ|прав/i,
    'регистратура собрала историю болезни — читать её она не вправе');
  assert.equal(docsOf(db).length, 0, 'отказ оставил документ в карте');
});
