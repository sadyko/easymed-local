// TELEGRAM_BROADCAST_IMG_V1 (mig 064) — картинка к рассылке.
//
// Проверяем ровно две вещи: колонка появилась, и она НЕОБЯЗАТЕЛЬНАЯ. Второе
// важнее первого: рассылка без картинки — это всё поведение, которое было до
// миграции, и оно обязано продолжать работать без единой правки вызывающего
// кода.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('064 adds a nullable image_path to telegram_broadcasts', () => {
  const db = freshDb();
  const col = db.prepare('PRAGMA table_info(telegram_broadcasts)').all()
    .find((c) => c.name === 'image_path');
  assert.ok(col, 'image_path must exist');
  assert.equal(col.notnull, 0, 'a broadcast without a picture must stay legal');
  db.close();
});

test('064 leaves a picture-less broadcast working exactly as before', () => {
  const db = freshDb();
  const id = db.prepare(
    "INSERT INTO telegram_broadcasts (text_ru, audience_count) VALUES ('Тест', 3) RETURNING id").get().id;
  const row = db.prepare('SELECT * FROM telegram_broadcasts WHERE id = ?').get(id);
  assert.equal(row.image_path, null, 'no picture means NULL, not an empty string');
  assert.equal(row.text_ru, 'Тест');
  db.close();
});

test('064 stores a picture path when one is given', () => {
  const db = freshDb();
  const id = db.prepare(
    `INSERT INTO telegram_broadcasts (text_ru, audience_count, image_path)
     VALUES ('С картинкой', 1, 'broadcast/2026-08-17-abc.jpg') RETURNING id`).get().id;
  assert.equal(
    db.prepare('SELECT image_path FROM telegram_broadcasts WHERE id = ?').get(id).image_path,
    'broadcast/2026-08-17-abc.jpg');
  db.close();
});
