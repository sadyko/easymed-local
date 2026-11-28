// HR_STAFF_V1 — миграция 302: документы сотрудника и выданная техника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (500, 'hr.t', 'x', 'Тест', 'nurse')").run();
  return db;
}

test('hr_staff_documents: вид из списка, пустые заголовок и путь запрещены', () => {
  const db = fresh();
  db.prepare("INSERT INTO hr_staff_documents (user_id, title, file_path) VALUES (500, 'Паспорт', 'staff/500/a.pdf')").run();
  const r = db.prepare('SELECT * FROM hr_staff_documents').get();
  assert.equal(r.kind, 'other');
  assert.equal(r.removed_at, null);
  assert.throws(() => db.prepare("INSERT INTO hr_staff_documents (user_id, title, file_path, kind) VALUES (500, 'x', 'p', 'selfie')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_staff_documents (user_id, title, file_path) VALUES (500, '  ', 'p')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_staff_documents (user_id, title, file_path) VALUES (500, 'x', '')").run(), /CHECK/);
});

test('hr_assets: вид из списка, дата выдачи обязательна, по умолчанию не возвращено', () => {
  const db = fresh();
  db.prepare("INSERT INTO hr_assets (user_id, kind, name, issued_on) VALUES (500, 'laptop', 'Lenovo T14', '2026-11-26')").run();
  const r = db.prepare('SELECT * FROM hr_assets').get();
  assert.equal(r.returned_on, null);
  assert.equal(r.serial_no, '');
  assert.throws(() => db.prepare("INSERT INTO hr_assets (user_id, kind, name, issued_on) VALUES (500, 'car', 'x', '2026-11-26')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO hr_assets (user_id, name) VALUES (500, 'x')").run(), /NOT NULL/);
});
