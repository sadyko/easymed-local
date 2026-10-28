// ADMIN_ACT_AS_V1 (мигр. 249) — вход администратора от имени сотрудника:
// три колонки sessions (кто, какая запись журнала, с какого времени), журнал
// act_as_sessions/act_as_actions и триггер, закрывающий запись журнала при
// любом удалении сессии. Дверь /api/db этих таблиц не знает: журнал читает
// только GET /api/auth/act-as/log (администратор).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { REGISTRY } from '../schema-registry.js';

const cols = (db, t) => new Map(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c]));

test('мигр. 249: колонки sessions, таблицы журнала и их индексы', () => {
  const db = openDb(':memory:');
  migrate(db);
  const s = cols(db, 'sessions');
  for (const c of ['act_as_user_id', 'act_as_id', 'act_as_started_at']) {
    assert.ok(s.has(c), 'sessions.' + c);
    assert.equal(s.get(c).notnull, 0, 'пусто — не от имени');
  }
  assert.deepEqual([...cols(db, 'act_as_sessions').keys()],
    ['id', 'admin_id', 'admin_name', 'target_id', 'target_name', 'started_at', 'ended_at', 'end_reason']);
  assert.deepEqual([...cols(db, 'act_as_actions').keys()], ['id', 'act_as_id', 'at', 'kind', 'name', 'status']);
  const idx = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'act_as_%'").all().map((r) => r.name);
  for (const n of ['idx_act_as_sessions_target', 'idx_act_as_sessions_admin', 'idx_act_as_sessions_started', 'idx_act_as_actions_session']) {
    assert.ok(idx.includes(n), 'индекс ' + n);
  }
  // Ссылок на users нет намеренно: журнал не мешает удалить сотрудника (R4
  // «удалён») и переживает удаление — имена лежат копией.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_list(act_as_sessions)').all(), []);
  assert.ok(!('act_as_sessions' in REGISTRY) && !('act_as_actions' in REGISTRY), 'дверь /api/db журнала не знает');
});

test('мигр. 249: причины конца и виды действий — только из списка', () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare('INSERT INTO act_as_sessions (admin_id, target_id, ended_at, end_reason) VALUES (1, 2, ?, ?)');
  for (const r of ['Вернулся', 'Вышел', 'Истекло', 'Сессия завершена', 'Сотрудник недоступен']) ins.run('2026-10-28T10:00:00Z', r);
  ins.run(null, null);
  assert.throws(() => ins.run('2026-10-28T10:00:00Z', 'Просто так'), /CHECK/);
  assert.throws(() => ins.run(null, 'Вернулся'), /CHECK/, 'причина без конца');
  assert.throws(() => ins.run('2026-10-28T10:00:00Z', null), /CHECK/, 'конец без причины');
  const act = db.prepare('INSERT INTO act_as_actions (act_as_id, kind, name, status) VALUES (1, ?, ?, 200)');
  // ADMIN_ACT_AS_V1 (задача 2) — storage: загрузка и удаление файла (/api/storage).
  for (const k of ['db', 'rpc', 'users', 'storage']) act.run(k, 'x');
  assert.throws(() => act.run('files', 'x'), /CHECK/);
});

test('мигр. 249: удаление сессии закрывает открытую запись журнала — «Сессия завершена», после 2 часов — «Истекло» ровно в +2 ч', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'a', 'x', 'admin'), (2, 'b', 'x', 'nurse')").run();
  const open = (startedAt) => {
    const id = Number(db.prepare('INSERT INTO act_as_sessions (admin_id, target_id, started_at) VALUES (1, 2, ?)').run(startedAt).lastInsertRowid);
    db.prepare("INSERT INTO sessions (id, user_id, expires_at, act_as_user_id, act_as_id, act_as_started_at) VALUES (?, 1, '2999-01-01T00:00:00Z', 2, ?, ?)")
      .run('s' + id, id, startedAt);
    return id;
  };
  const row = (id) => db.prepare('SELECT ended_at, end_reason FROM act_as_sessions WHERE id = ?').get(id);
  const now = new Date(Date.now() - 60 * 1000).toISOString().slice(0, 19) + 'Z';
  const fresh = open(now);
  const old = open('2026-01-01T08:00:00Z');
  const closed = open(now);
  db.prepare("UPDATE act_as_sessions SET ended_at = '2026-10-28T11:00:00Z', end_reason = 'Вернулся' WHERE id = ?").run(closed);
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('plain', 1, '2999-01-01T00:00:00Z')").run();

  db.prepare('DELETE FROM sessions').run();
  assert.equal(row(fresh).end_reason, 'Сессия завершена');
  assert.ok(row(fresh).ended_at >= now);
  assert.deepEqual({ ...row(old) }, { ended_at: '2026-01-01T10:00:00Z', end_reason: 'Истекло' });
  assert.deepEqual({ ...row(closed) }, { ended_at: '2026-10-28T11:00:00Z', end_reason: 'Вернулся' }, 'закрытая запись не переписывается');
});
