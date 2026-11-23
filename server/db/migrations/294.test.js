// AI_CHAT_V1 — миграция 294 (на ветке local/ai-on-main была 287: номер занят в main миграцией 287_wait_reg_line_journal).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('294 AI_CHAT_V1 (была 287): таблицы ИИ-помощника и отметки «ИИ»', () => {
  const db = openDb(':memory:');
  migrate(db);
  const s = db.prepare('SELECT enabled, enabled_at, blocked FROM ai_settings WHERE id = 1').get();
  assert.deepEqual(s, { enabled: 0, enabled_at: null, blocked: '' }, 'одна строка настроек, ИИ выключен');
  db.prepare("INSERT INTO ai_chat_jobs (channel, chat_key, source_id, next_at) VALUES ('telegram','1','10','2026-01-01T00:00:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO ai_chat_jobs (channel, chat_key, source_id, next_at) VALUES ('telegram','1','10','2026-01-01T00:00:00Z')").run(),
    /UNIQUE/, 'одно входящее сообщение — одна задача');
  db.prepare("INSERT INTO ai_chat_flags (channel, chat_key, reason, flagged_at) VALUES ('telegram','1','medical','2026-01-01T00:00:00Z')").run();
  assert.throws(() => db.prepare("INSERT INTO ai_chat_flags (channel, chat_key, reason, flagged_at) VALUES ('telegram','1','x','2026-01-01T00:00:00Z')").run(),
    /UNIQUE|PRIMARY/, 'один чат — один флаг');
  assert.throws(() => db.prepare('INSERT INTO ai_settings (id) VALUES (2)').run(),
    /CHECK/, 'строка настроек только одна');
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('telegram_messages').includes('by_ai'));
  assert.ok(cols('meta_messages').includes('by_ai'));
  assert.ok(cols('meta_comments').includes('by_ai'));
  db.close();
});
