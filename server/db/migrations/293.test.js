// DOCTOR_BOT_TEMPLATE_V1 — миграция 293: свой текст уведомления врачу-источнику.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('293 DOCTOR_BOT_TEMPLATE_V1: у бота для врачей есть message_template, по умолчанию пустой (= стандартный)', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.equal(db.prepare('SELECT message_template FROM doctor_bot_settings WHERE id = 1').get().message_template, '');
  db.close();
});
