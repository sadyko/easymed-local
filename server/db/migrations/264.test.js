// META_INBOX_STATS_V1 — миграция 264: когда, кем и как переписка стала лидом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('мигр. 264: у переписки и комментария — момент, сотрудник и исход связи с CRM', () => {
  const db = openDb(':memory:');
  migrate(db);
  for (const t of ['meta_conversations', 'meta_comments']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['crm_linked_at', 'crm_linked_by', 'crm_link_kind']) assert.ok(cols.includes(c), `${t}.${c}`);
  }
  const conv = db.prepare("INSERT INTO meta_conversations (platform, conv_id) VALUES ('messenger', 't_1') RETURNING id").get();
  assert.throws(() => db.prepare("UPDATE meta_conversations SET crm_link_kind = 'other' WHERE id = ?").run(conv.id), /CHECK/);
  db.prepare("UPDATE meta_conversations SET crm_link_kind = 'merged' WHERE id = ?").run(conv.id);
});
