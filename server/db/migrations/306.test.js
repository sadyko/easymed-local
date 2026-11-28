// HR_CANDIDATE_DOCS_V1 — миграция 306: документы кандидата в «Подборе».
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('hr_candidate_documents: вид из списка, пустые заголовок и путь запрещены, удаление кандидата уносит строки', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO hr_candidates (id, full_name) VALUES (7, 'Кандидат')").run();
  db.prepare("INSERT INTO hr_candidate_documents (candidate_id, kind, title, file_path) VALUES (7, 'resume', 'Резюме', 'candidate/7/a.pdf')").run();
  const r = db.prepare('SELECT * FROM hr_candidate_documents').get();
  assert.equal(r.removed_at, null);
  assert.equal(r.file_size, 0);
  assert.throws(() => db.prepare("INSERT INTO hr_candidate_documents (candidate_id, kind, title, file_path) VALUES (7, 'selfie', 'x', 'p')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_candidate_documents (candidate_id, title, file_path) VALUES (7, '  ', 'p')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_candidate_documents (candidate_id, title, file_path) VALUES (7, 'x', '')").run(), /CHECK/);
  db.prepare('DELETE FROM hr_candidates WHERE id = 7').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hr_candidate_documents').get().n, 0);
});
