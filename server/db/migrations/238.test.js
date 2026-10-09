// CRM_UNIFY_V1 (мигр. 238) — разовое исправление: отметка «не сделано» и журнал.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('238: одна строка отметки — не сделано, счётчики нули; вторая строка невозможна', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.deepEqual(db.prepare('SELECT id, done_at, cards, no_shows, tasks FROM crm_unify_repair').all(),
    [{ id: 1, done_at: null, cards: 0, no_shows: 0, tasks: 0 }]);
  assert.throws(() => db.prepare('INSERT INTO crm_unify_repair (id) VALUES (2)').run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE crm_unify_repair SET tasks = -1 WHERE id = 1').run(), /CHECK/);
  db.close();
});

test('238: журнал пуст; вид — только card / task; у задачи есть task_id, у карточки — нет', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_unify_repair_log').get().n, 0);
  const ins = db.prepare('INSERT INTO crm_unify_repair_log (kind, request_id, task_id, from_value, to_value) VALUES (?, ?, ?, ?, ?)');
  ins.run('card', 7, null, 'scheduled', 'came');
  ins.run('task', 7, 3, null, '21');
  assert.throws(() => ins.run('x', 7, null, 'a', 'b'), /CHECK/);
  assert.throws(() => ins.run('task', 7, null, null, '21'), /CHECK/);
  assert.throws(() => ins.run('card', 7, 3, 'scheduled', 'came'), /CHECK/);
  assert.throws(() => ins.run('card', 7, null, 'scheduled', null), /NOT NULL/);
  const r = db.prepare("SELECT created_at FROM crm_unify_repair_log WHERE kind = 'card'").get();
  assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  db.close();
});
