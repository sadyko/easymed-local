// SMS_INFORM_V1 — миграция 261: настройки SMS (Play Mobile) и журнал отправленного.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('мигр. 261: одна строка настроек, выключено; журнал с уникальным message_id', () => {
  const db = openDb(':memory:');
  migrate(db);
  const row = db.prepare('SELECT * FROM sms_settings').all();
  assert.equal(row.length, 1);
  assert.equal(row[0].enabled, 0);
  assert.equal(row[0].password_sealed, '');
  assert.throws(() => db.prepare('INSERT INTO sms_settings (id) VALUES (2)').run(), /CHECK/);
  const ins = db.prepare("INSERT INTO sms_messages (message_id, phone, text, status) VALUES (?, '998901234567', 't', 'sent')");
  ins.run('m1');
  assert.throws(() => ins.run('m1'), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO sms_messages (message_id, phone, text, status) VALUES ('m2', '1', 't', 'queued')").run(), /CHECK/);
});
