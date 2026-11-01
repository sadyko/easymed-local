// SMS_PUSH_V1 — миграция 262: SMS-рассылки и их получатели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('мигр. 262: рассылка начинается «running»; один номер — одна строка получателя на рассылку', () => {
  const db = openDb(':memory:');
  migrate(db);
  const bc = db.prepare("INSERT INTO sms_broadcasts (text) VALUES ('t') RETURNING id, status, audience_count").get();
  assert.equal(bc.status, 'running');
  assert.equal(bc.audience_count, 0);
  const add = db.prepare('INSERT INTO sms_broadcast_targets (broadcast_id, phone, message_id) VALUES (?, ?, ?)');
  add.run(bc.id, '998901112233', 'a');
  assert.throws(() => add.run(bc.id, '998901112233', 'b'), /UNIQUE/, 'тот же номер второй раз');
  assert.throws(() => add.run(bc.id, '998914445566', 'a'), /UNIQUE/, 'тот же message-id');
  assert.throws(() => db.prepare("UPDATE sms_broadcast_targets SET status = 'queued'").run(), /CHECK/);
});
