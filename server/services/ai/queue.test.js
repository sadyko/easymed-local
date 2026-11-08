import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { setAiEnabled, setAiBlocked } from './settings.js';
import { enqueueChatJob, claimNextJob, markSending, finishJob, retryJob, dropQueuedJobs, recoverJobsAtBoot } from './queue.js';

const T0 = Date.parse('2026-11-08T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
function fresh() { const db = openDb(':memory:'); migrate(db); setAiEnabled(db, true, 1, iso(T0)); return db; }
const job = (o = {}) => ({ channel: 'telegram', chatKey: '100', sourceId: 's1', createdAt: iso(T0 + 1000), now: T0 + 2000, ...o });

test('ставится только при включённом ИИ, только новое и только один раз', () => {
  const db = fresh();
  assert.equal(enqueueChatJob(db, job()), 'queued');
  assert.equal(enqueueChatJob(db, job()), 'dup');
  assert.equal(enqueueChatJob(db, job({ sourceId: 's0', createdAt: iso(T0 - 1000) })), 'old', 'до включения — не наше');
  assert.equal(enqueueChatJob(db, job({ sourceId: 's2', createdAt: iso(T0 + 1000), now: T0 + 31 * 60_000 })), 'old', 'старше 30 минут');
  setAiBlocked(db, 'limit');
  assert.equal(enqueueChatJob(db, job({ sourceId: 's3' })), 'off');
  setAiBlocked(db, '');
  setAiEnabled(db, false, 1, iso(T0 + 5000));
  assert.equal(enqueueChatJob(db, job({ sourceId: 's4' })), 'off');
});

test('забрать: одна задача на чат, остальные того же чата — merged', () => {
  const db = fresh();
  enqueueChatJob(db, job({ sourceId: 'a' }));
  enqueueChatJob(db, job({ sourceId: 'b' }));
  enqueueChatJob(db, job({ chatKey: '200', sourceId: 'c' }));
  const j = claimNextJob(db, T0 + 3000);
  assert.equal(j.source_id, 'a');
  assert.equal(j.status, 'working');
  const rows = db.prepare('SELECT source_id, status FROM ai_chat_jobs ORDER BY id').all();
  assert.deepEqual(rows, [{ source_id: 'a', status: 'working' }, { source_id: 'b', status: 'merged' }, { source_id: 'c', status: 'queued' }]);
});

test('повтор с паузой; через 10 минут — сдаёмся', () => {
  const db = fresh();
  enqueueChatJob(db, job());
  const j = claimNextJob(db, T0 + 3000);
  assert.equal(retryJob(db, j.id, T0 + 4000), 'retry');
  assert.equal(claimNextJob(db, T0 + 5000), null, 'пауза ещё не прошла');
  const again = claimNextJob(db, T0 + 4000 + 15_000);
  assert.equal(again.attempts, 2);
  assert.equal(retryJob(db, again.id, T0 + 11 * 60_000), 'gave_up');
  assert.equal(db.prepare('SELECT status FROM ai_chat_jobs').get().status, 'failed');
});

test('выключение роняет ждущие; перезапуск: working → queued, sending → failed', () => {
  const db = fresh();
  enqueueChatJob(db, job({ sourceId: 'a' }));
  enqueueChatJob(db, job({ chatKey: '2', sourceId: 'b' }));
  enqueueChatJob(db, job({ chatKey: '3', sourceId: 'c' }));
  const a = claimNextJob(db, T0 + 3000);
  const b = claimNextJob(db, T0 + 3000);
  markSending(db, b.id);
  const recovered = recoverJobsAtBoot(db);
  assert.deepEqual(recovered, { requeued: 1, failed: [{ channel: 'telegram', chat_key: '2' }] });
  assert.equal(db.prepare('SELECT status FROM ai_chat_jobs WHERE id = ?').get(a.id).status, 'queued');
  assert.equal(dropQueuedJobs(db), 2);
  finishJob(db, a.id, 'done', 'reply');
  assert.equal(db.prepare('SELECT status, outcome FROM ai_chat_jobs WHERE id = ?').get(a.id).outcome, 'reply');
});
