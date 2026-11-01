// META_INBOX_V1 — миграция 263: переписка и комментарии Facebook / Instagram.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('мигр. 263: одна строка состояния, выключена; id Meta уникальны; каналы — закрытый список', () => {
  const db = openDb(':memory:');
  migrate(db);
  const st = db.prepare('SELECT * FROM meta_inbox_state').all();
  assert.equal(st.length, 1);
  assert.equal(st[0].enabled, 0);
  assert.throws(() => db.prepare('INSERT INTO meta_inbox_state (id) VALUES (2)').run(), /CHECK/);

  const conv = db.prepare("INSERT INTO meta_conversations (platform, conv_id) VALUES ('messenger', 't_1') RETURNING id").get();
  assert.throws(() => db.prepare("INSERT INTO meta_conversations (platform, conv_id) VALUES ('instagram', 't_1')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO meta_conversations (platform, conv_id) VALUES ('whatsapp', 't_2')").run(), /CHECK/);

  const msg = db.prepare("INSERT INTO meta_messages (conversation_id, msg_id, direction, created_at) VALUES (?, ?, 'in', '2026-10-31T10:00:00Z')");
  msg.run(conv.id, 'm_1');
  assert.throws(() => msg.run(conv.id, 'm_1'), /UNIQUE/);
  // неотправленные ответы — без id Meta, и их может быть несколько
  const failed = db.prepare("INSERT INTO meta_messages (conversation_id, direction, status, created_at) VALUES (?, 'out', 'failed', '2026-10-31T10:01:00Z')");
  failed.run(conv.id); failed.run(conv.id);

  db.prepare("INSERT INTO meta_comments (platform, comment_id, created_at) VALUES ('facebook', 'c_1', '2026-10-31T10:00:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO meta_comments (platform, comment_id, created_at) VALUES ('facebook', 'c_1', '2026-10-31T10:00:00Z')").run(), /UNIQUE/);

  db.prepare('DELETE FROM meta_conversations WHERE id = ?').run(conv.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_messages').get().n, 0, 'переписка уходит с сообщениями');
});
