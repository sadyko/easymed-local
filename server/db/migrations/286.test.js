// DAILY_REPORT_BOT_V1 — миграция 286: настройки бота ежедневного отчёта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('daily_report_settings: одна строка, выключена, 21:00, за сегодня, все блоки', () => {
  const db = openDb(':memory:');
  migrate(db);
  const r = db.prepare('SELECT * FROM daily_report_settings').all();
  assert.equal(r.length, 1);
  assert.equal(r[0].enabled, 0);
  assert.equal(r[0].send_time, '21:00');
  assert.equal(r[0].period, 'today');
  assert.equal(r[0].sections, '[]');
  assert.throws(() => db.prepare("UPDATE daily_report_settings SET send_time = '9:5' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE daily_report_settings SET period = 'week' WHERE id = 1").run(), /CHECK/);
  assert.throws(() => db.prepare('INSERT INTO daily_report_settings (id) VALUES (2)').run(), /CHECK/);
});
