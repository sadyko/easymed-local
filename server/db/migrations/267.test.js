// CLINIC_NEWS_IMPORTANT_V1 — миграция 267: отметка «Важно» у объявления доски.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('clinic_news.important: по умолчанию 0, ставится 1', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO clinic_news (title) VALUES ('Обычная')").run();
  db.prepare("INSERT INTO clinic_news (title, important) VALUES ('Важная', 1)").run();
  const rows = db.prepare('SELECT title, important FROM clinic_news ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.important), [0, 1]);
});
