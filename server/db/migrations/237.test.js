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

// CRM_UNIFY_V1 (ревью задачи 4) — журнал переноса «Колонки конверсии»: сколько
// карточек, откуда, куда, кто и когда. Кто — не запрет на удаление сотрудника.
test('237: журнал переноса конверсии — пустой; число карточек не отрицательное; автор обнуляется', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_conversion_log').get().n, 0);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (5, 'adm', 'x', 'admin')").run();
  db.prepare("INSERT INTO crm_conversion_log (moved_by, from_stage, to_stage, cards_moved) VALUES (5, 'came', 'approved', 3)").run();
  const r = db.prepare('SELECT moved_by, from_stage, to_stage, cards_moved, moved_at FROM crm_conversion_log').get();
  assert.deepEqual({ ...r, moved_at: undefined }, { moved_by: 5, from_stage: 'came', to_stage: 'approved', cards_moved: 3, moved_at: undefined });
  assert.match(r.moved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.throws(() => db.prepare("INSERT INTO crm_conversion_log (from_stage, to_stage, cards_moved) VALUES ('a','b',-1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO crm_conversion_log (from_stage, cards_moved) VALUES ('a', 0)").run(), /NOT NULL/);
  db.prepare('DELETE FROM users WHERE id = 5').run();
  assert.equal(db.prepare('SELECT moved_by FROM crm_conversion_log').get().moved_by, null);
  db.close();
});
