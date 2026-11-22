// AI_CALLS_V1 — миграция 292: разбор записей звонков ИИ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('292 AI_CALLS_V1: одна строка на звонок, статусы ограничены, звонок удалён — разбор тоже', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(db.prepare('SELECT calls_since FROM ai_settings WHERE id = 1').get().calls_since, null);
  const callId = Number(db.prepare("INSERT INTO calls (general_call_id, started_at, billsec, disposition) VALUES ('x:1', '2026-11-18T10:00:00Z', 60, 'ANSWER')").run().lastInsertRowid);
  db.prepare("INSERT INTO ai_call_analysis (call_id, next_at, created_at) VALUES (?, '2026-11-18T10:03:00Z', '2026-11-18T10:01:00Z')").run(callId);
  const r = db.prepare('SELECT status, attempts, score, scores_json FROM ai_call_analysis WHERE call_id = ?').get(callId);
  assert.deepEqual(r, { status: 'queued', attempts: 0, score: null, scores_json: '{}' });
  assert.throws(() => db.prepare("INSERT INTO ai_call_analysis (call_id, next_at, created_at) VALUES (?, 'a', 'b')").run(callId), /UNIQUE|PRIMARY/);
  assert.throws(() => db.prepare("UPDATE ai_call_analysis SET status = 'weird' WHERE call_id = ?").run(callId), /CHECK/);
  db.prepare('DELETE FROM calls WHERE id = ?').run(callId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_call_analysis').get().n, 0);
  db.close();
});
