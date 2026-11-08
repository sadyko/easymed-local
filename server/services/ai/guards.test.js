import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { operatorRecent, flagChat, isFlagged, flaggedChats, OPERATOR_QUIET_MS } from './guards.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function fresh() {
  const db = openDb(':memory:'); migrate(db);
  // sent_by — внешний ключ на users: операторы 5 и 9 должны существовать.
  for (const id of [5, 9]) db.prepare("INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?, ?, 'x', 'Op', 'admin')").run(id, 'op' + id);
  return db;
}

test('Telegram: сообщение оператора за 12 часов — ИИ молчит; бот и ИИ не в счёт', () => {
  const db = fresh();
  const put = (dir, sentBy, kind, at, byAi = 0) => db.prepare(
    'INSERT INTO telegram_messages (chat_id, direction, text, kind, sent_by, created_at, by_ai) VALUES (?,?,?,?,?,?,?)').run('100', dir, 'x', kind, sentBy, iso(at), byAi);
  put('out', null, 'system', NOW - 1000);
  put('out', null, 'text', NOW - 1000, 1);   // ответ ИИ
  assert.equal(operatorRecent(db, 'telegram', '100', NOW), false);
  put('out', 5, 'text', NOW - OPERATOR_QUIET_MS + 60_000);
  assert.equal(operatorRecent(db, 'telegram', '100', NOW), true);
  assert.equal(operatorRecent(db, 'telegram', '100', NOW + 2 * 60_000), false, 'через 12 часов — снова ИИ');
});

test('Meta: переписка и нитка комментария', () => {
  const db = fresh();
  const conv = db.prepare(`INSERT INTO meta_conversations (platform, conv_id, peer_id, peer_name, updated_time) VALUES ('messenger','c1','p1','Ann','2026-11-08T11:00:00Z')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO meta_messages (conversation_id, msg_id, direction, text, created_at, sent_by) VALUES (?, 'm1', 'out', 'hi', ?, 9)`).run(conv, iso(NOW - 1000));
  assert.equal(operatorRecent(db, 'meta_dm', String(conv), NOW), true);
  const root = db.prepare(`INSERT INTO meta_comments (platform, comment_id, parent_id, root_id, post_id, author_id, author_name, text, created_at, is_page)
                           VALUES ('facebook','k1','','','p','a','Bob','цена?',?,0)`).run(iso(NOW - 5000)).lastInsertRowid;
  assert.equal(operatorRecent(db, 'meta_comment', String(root), NOW), false);
  db.prepare(`INSERT INTO meta_comments (platform, comment_id, parent_id, root_id, post_id, author_id, author_name, text, created_at, is_page, sent_by)
              VALUES ('facebook','k2','k1','k1','p','page','Clinic','ответ',?,1,9)`).run(iso(NOW - 1000));
  assert.equal(operatorRecent(db, 'meta_comment', String(root), NOW), true);
});

test('отметка «Нужен оператор» держится до ответа оператора', () => {
  const db = fresh();
  flagChat(db, 'telegram', '100', 'medical', NOW - 10_000);
  assert.equal(isFlagged(db, 'telegram', '100'), true);
  assert.deepEqual(flaggedChats(db).map((f) => [f.channel, f.chat_key, f.reason]), [['telegram', '100', 'medical']]);
  db.prepare('INSERT INTO telegram_messages (chat_id, direction, text, kind, sent_by, created_at) VALUES (?,?,?,?,?,?)')
    .run('100', 'out', 'ответ', 'text', 5, iso(NOW - 5000));
  assert.equal(isFlagged(db, 'telegram', '100'), false, 'оператор ответил — отметка снята');
  assert.deepEqual(flaggedChats(db), []);
});
