// HR_CANDIDATE_DOCS_V1 — документы кандидата в «Подборе»: приложить, убрать,
// права рекрутера и перенос в карточку сотрудника при «Создать сотрудника».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import {
  hrCandidateSave, hrCandidateMove, hrCandidateGet, hrCandidateLinkEmployee,
  hrCandidateDocumentAdd, hrCandidateDocumentRemove,
} from './hr-recruiting.js';
import { hrStaffCard } from './hr.js';
import { getRpc } from './index.js';
import { isReadOnlyRpc } from '../control/gate.js';

const ADMIN = { id: 1, role: 'admin', extra_roles: [] };
const RECRUITER = { id: 2, role: 'registrar', extra_roles: [] };

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO users (id, username, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)');
  ins.run(1, 'adm', 'x', 'admin', 'Админ');
  ins.run(2, 'rec', 'x', 'registrar', 'Рекрутер');
  ins.run(10, 'new.emp', 'x', 'nurse', 'Новая Сотрудница');
  return db;
}
function grant(db, role, lvl) {
  db.prepare('INSERT OR REPLACE INTO role_permissions (role, permissions) VALUES (?, ?)')
    .run(role, JSON.stringify({ grants: { hr_recruiting: lvl } }));
}
const addCandidate = (db) => hrCandidateSave(db, { full_name: 'Каримова Дилноза' }, ADMIN).id;
const doc = (id, extra = {}) => ({ candidate_id: id, kind: 'passport', title: 'Паспорт', file_path: `candidate/${id}/p.pdf`, file_name: 'p.pdf', file_size: 1200, ...extra });

test('приложить и убрать документ: виден в карточке, убранный — нет', () => {
  const db = fresh();
  const id = addCandidate(db);
  const { id: docId } = hrCandidateDocumentAdd(db, doc(id), ADMIN);
  hrCandidateDocumentAdd(db, doc(id, { kind: 'resume', title: 'Резюме', file_path: `candidate/${id}/cv.docx` }), ADMIN);
  assert.equal(hrCandidateGet(db, { id }, ADMIN).documents.length, 2);
  assert.equal(hrCandidateDocumentRemove(db, { id: docId }, ADMIN).removed, true);
  assert.equal(hrCandidateDocumentRemove(db, { id: docId }, ADMIN).removed, false);
  const left = hrCandidateGet(db, { id }, ADMIN).documents;
  assert.deepEqual(left.map((d) => d.kind), ['resume']);
});

test('путь файла — только своя папка кандидата; вид — из списка', () => {
  const db = fresh();
  const id = addCandidate(db);
  for (const p of [`candidate/${id + 1}/a.pdf`, `staff/${id}/a.pdf`, `candidate/${id}/`, `candidate/${id}/x/a.pdf`, `candidate/${id}/../a.pdf`]) {
    assert.throws(() => hrCandidateDocumentAdd(db, doc(id, { file_path: p }), ADMIN), (e) => e.status === 400, p);
  }
  assert.throws(() => hrCandidateDocumentAdd(db, doc(id, { kind: 'selfie' }), ADMIN), (e) => e.status === 400);
  assert.throws(() => hrCandidateDocumentAdd(db, doc(id, { title: ' ' }), ADMIN), (e) => e.status === 400);
  assert.throws(() => hrCandidateDocumentAdd(db, doc(999), ADMIN), (e) => e.status === 404);
});

test('права: «Просмотр» — нельзя прикладывать, «Изменение» — можно', () => {
  const db = fresh();
  const id = addCandidate(db);
  assert.throws(() => hrCandidateDocumentAdd(db, doc(id), RECRUITER), (e) => e.status === 403);
  grant(db, 'registrar', 'view');
  assert.throws(() => hrCandidateDocumentAdd(db, doc(id), RECRUITER), (e) => e.status === 403);
  grant(db, 'registrar', 'edit');
  assert.ok(hrCandidateDocumentAdd(db, doc(id), RECRUITER).id > 0);
});

test('«Создать сотрудника» переносит документы кандидата в карточку сотрудника', () => {
  const db = fresh();
  const id = addCandidate(db);
  hrCandidateDocumentAdd(db, doc(id), ADMIN);
  hrCandidateDocumentAdd(db, doc(id, { kind: 'resume', title: 'Резюме', file_path: `candidate/${id}/cv.pdf` }), ADMIN);
  const gone = hrCandidateDocumentAdd(db, doc(id, { title: 'Старый скан', file_path: `candidate/${id}/old.pdf` }), ADMIN).id;
  hrCandidateDocumentRemove(db, { id: gone }, ADMIN);
  hrCandidateMove(db, { id, stage: 'hired' }, ADMIN);
  hrCandidateLinkEmployee(db, { id, user_id: 10 }, ADMIN);
  const staffDocs = hrStaffCard(db, { user_id: 10 }, ADMIN).documents;
  assert.deepEqual(staffDocs.map((d) => [d.kind, d.title]).sort(), [['other', 'Резюме'], ['passport', 'Паспорт']]);
  assert.ok(staffDocs.every((d) => d.file_path.startsWith(`candidate/${id}/`)));
});

test('операции зарегистрированы и пишущие — закрыты для клиники без лицензии', () => {
  assert.equal(typeof getRpc('hr_candidate_document_add'), 'function');
  assert.equal(typeof getRpc('hr_candidate_document_remove'), 'function');
  assert.equal(isReadOnlyRpc('hr_candidate_document_add'), false);
  assert.equal(isReadOnlyRpc('hr_candidate_document_remove'), false);
});
