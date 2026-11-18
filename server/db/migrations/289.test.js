// DOC_HISTORY_V1 — миграция 289: история изменений документа приёма
// (visit_document_revisions). Только добавление: новая таблица, её индекс и два
// триггера-запрета. Существующие строки клиники не меняются, журнал связи зданий
// (084) не пишется; версию нельзя ни изменить, ни удалить — никому.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const MIGRATIONS = path.dirname(fileURLToPath(import.meta.url));

/** База версии до 289: все миграции ниже 289. */
function before289() {
  const db = openDb(':memory:');
  const stage = tmpDir('em-mig289-');
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (parseInt(f, 10) >= 289 || !f.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(MIGRATIONS, f), path.join(stage, f));
  }
  migrate(db, stage);
  return db;
}

const DOC = JSON.stringify({ __service_workspace_v1: 1, current: { chief_complaint: 'Кашель' },
  history: [{ kind: 'signed', savedAt: '2026-11-01T08:00:00.000Z', by: 7, byName: 'Врач', fields: { chief_complaint: 'Кашель' } }] });

test('289: таблица версий документа — колонки, вид из шести, индекс по строке; существующие данные и журнал связи зданий не тронуты', () => {
  const db = before289();
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, full_name, role, is_doctor) VALUES (7, 'doc', 'x', 'Врач', 'doctor', 1)").run();
    db.prepare("INSERT INTO patients (id, full_name) VALUES (3, 'Пациент')").run();
    db.prepare("INSERT INTO visits (id, patient_id, doctor_id, visit_date, status) VALUES (1, 3, 7, '2026-11-01T04:00:00.000Z', 'arrived')").run();
    db.prepare("INSERT INTO visit_services (id, visit_id, doctor_id, status, notes) VALUES (5, 1, 7, 'completed', ?), (6, 1, 7, 'added', NULL)").run(DOC);
    db.prepare("INSERT INTO visit_documents (visit_service_id, visit_id, patient_id, doc_type, title, body, created_by) VALUES (5, 1, 3, 'protocol', 'Протокол', '{}', 7)").run();
    const snap = () => ({
      vs: db.prepare('SELECT * FROM visit_services ORDER BY id').all(),
      docs: db.prepare('SELECT * FROM visit_documents ORDER BY id').all(),
      journal: db.prepare('SELECT COUNT(*) n FROM sync_journal').get().n,
    });
    const before = snap();
    migrate(db);
    assert.deepEqual(snap(), before, 'существующие строки или журнал связи зданий изменились');

    const cols = db.prepare('PRAGMA table_info(visit_document_revisions)').all().map((c) => c.name);
    for (const c of ['id', 'visit_service_id', 'rev_no', 'kind', 'via', 'doc_type', 'sections', 'images_added', 'images_removed',
      'snapshot', 'content_hash', 'signed_n', 'user_id', 'user_name', 'user_role', 'acting_admin_id', 'acting_admin_name', 'created_at']) {
      assert.ok(cols.includes(c), 'нет колонки ' + c);
    }
    assert.equal(db.prepare("SELECT COUNT(*) n FROM visit_document_revisions").get().n, 0, 'миграция сама версий не заводит');
    // ссылки на строку визита нет нарочно: строку снимают, а история остаётся
    const fks = db.prepare('SELECT "table" t, "from" f FROM pragma_foreign_key_list(?)').all('visit_document_revisions');
    assert.ok(!fks.some((f) => f.t === 'visit_services'), 'история не должна уходить вместе со строкой визита');
    assert.ok(fks.some((f) => f.t === 'users' && f.f === 'user_id'), 'кто изменил — сотрудник');

    const ins = db.prepare(`INSERT INTO visit_document_revisions (visit_service_id, rev_no, kind, via, doc_type, snapshot, content_hash, user_id)
                            VALUES (5, ?, ?, 'cabinet', 'conclusion', '{}', 'h1.1', 7)`);
    ins.run(1, 'draft');
    assert.throws(() => ins.run(2, 'whatever'), /CHECK/, 'неизвестный вид версии');
    assert.throws(() => ins.run(1, 'signed'), /UNIQUE/, 'номер версии строки — один раз');
    const row = db.prepare('SELECT * FROM visit_document_revisions WHERE rev_no = 1').get();
    assert.match(row.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'время ставит база, с миллисекундами');
    assert.equal(row.sections, '[]');

    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM visit_document_revisions WHERE visit_service_id = 5 ORDER BY rev_no").all().map((r) => r.detail).join(' | ');
    assert.match(plan, /USING (COVERING )?INDEX/, plan);
    migrate(db);   // повторный запуск ничего не меняет
  } finally { db.close(); }
});

test('289: версию нельзя изменить или удалить — триггеры отказывают всем (запрет снимает только удаление тестовых данных)', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare(`INSERT INTO visit_document_revisions (visit_service_id, rev_no, kind, via, doc_type, snapshot, content_hash)
                VALUES (5, 1, 'draft', 'cabinet', 'conclusion', '{}', 'h1.1')`).run();
    assert.throws(() => db.prepare("UPDATE visit_document_revisions SET kind = 'signed'").run(), /не меняется/);
    assert.throws(() => db.prepare("UPDATE visit_document_revisions SET snapshot = '{\"x\":1}' WHERE id = 1").run(), /не меняется/);
    assert.throws(() => db.prepare('DELETE FROM visit_document_revisions').run(), /не удаляется/);
    assert.equal(db.prepare('SELECT kind FROM visit_document_revisions').get().kind, 'draft');
    const trg = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'visit_document_revisions' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(trg, ['visit_document_revisions_no_delete', 'visit_document_revisions_no_update']);
  } finally { db.close(); }
});
