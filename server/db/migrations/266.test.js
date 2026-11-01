// CLINIC_NEWS_V1 — миграция 266: таблица доски объявлений.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

test('clinic_news: вид из списка, пустой заголовок запрещён, по умолчанию — новость без срока', () => {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO clinic_news (title) VALUES ('Новость')").run();
  const r = db.prepare('SELECT * FROM clinic_news').get();
  assert.equal(r.kind, 'news');
  assert.equal(r.pinned, 0);
  assert.equal(r.show_until, null);
  assert.equal(r.archived_at, null);
  assert.throws(() => db.prepare("INSERT INTO clinic_news (title, kind) VALUES ('x', 'party')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO clinic_news (title) VALUES ('   ')").run(), /CHECK/);
});
