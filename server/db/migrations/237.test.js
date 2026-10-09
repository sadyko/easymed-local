// CRM_UNIFY_V1 (мигр. 237) — crm_settings: одна строка, выбор колонки пуст, окно 72 часа.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('237: одна строка настроек; окно 1..720 часов; вторая строка невозможна', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.deepEqual(db.prepare('SELECT id, booked_stage, window_hours, changed_by, changed_at FROM crm_settings').all(),
    [{ id: 1, booked_stage: null, window_hours: 72, changed_by: null, changed_at: null }]);
  assert.throws(() => db.prepare('UPDATE crm_settings SET window_hours = 0 WHERE id = 1').run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE crm_settings SET window_hours = 721 WHERE id = 1').run(), /CHECK/);
  assert.throws(() => db.prepare('INSERT INTO crm_settings (id) VALUES (2)').run(), /CHECK/);
  // Внешнего ключа на колонку нет намеренно (Р10): правка колонок не падает на настройке.
  db.prepare("UPDATE crm_settings SET booked_stage = 'no_such_column' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT booked_stage FROM crm_settings').get().booked_stage, 'no_such_column');
  // Кто менял — не запрет на удаление сотрудника: ключ обнуляется.
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5, 'adm', 'x', 'admin')").run();
  db.prepare('UPDATE crm_settings SET changed_by = 5 WHERE id = 1').run();
  db.prepare('DELETE FROM users WHERE id = 5').run();
  assert.equal(db.prepare('SELECT changed_by FROM crm_settings').get().changed_by, null);
  db.close();
});
