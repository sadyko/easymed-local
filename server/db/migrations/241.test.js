// BRANCH_PROFILE_V1 (мигр. 241) — ПРОФИЛЬ ЗДАНИЯ: только ADD COLUMN.
//
// Новые колонки пусты, «показывать на сайте» — 1; прежние поля, буквы зданий
// и часы не тронуты; строк столько же. CHECK — запасной замок для /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore241() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig241-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 241)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const TEXT = ['name_uz', 'name_en', 'country_code', 'region_code', 'district_code',
  'street_ru', 'street_uz', 'street_en', 'landmark_ru', 'landmark_uz', 'landmark_en', 'maps_url'];
const WH = JSON.stringify({ mon: { enabled: true, from: '08:00', to: '17:00' } });

test('241: колонки профиля здания добавлены пустыми, «на сайте» — 1; прежнее и буквы не тронуты', () => {
  const db = dbBefore241();
  db.prepare("UPDATE branches SET name = 'Главный корпус', phone = '+998712000000', address = 'ул. Мира, 1', working_hours = ?, is_24_7 = 0 WHERE letter = 'A'").run(WH);
  db.prepare("INSERT INTO branches (name, letter, active, is_24_7) VALUES ('Стационар', 'C', 0, 1)").run();
  const before = db.prepare('SELECT * FROM branches ORDER BY id').all();
  migrate(db);
  const after = db.prepare('SELECT * FROM branches ORDER BY id').all();
  assert.equal(after.length, before.length);
  after.forEach((row, i) => {
    for (const c of TEXT) assert.equal(row[c], '', c + ' пуста');
    assert.equal(row.show_public, 1, 'прежние здания видны на сайте, как в макете');
    for (const [k, v] of Object.entries(before[i])) assert.equal(row[k], v, 'прежнее ' + k);
  });
});

test('241: CHECK — карта только Яндекса, «на сайте» — 0 или 1', () => {
  const db = openDb(':memory:'); migrate(db);
  const set = (col, v) => db.prepare(`UPDATE branches SET ${col} = ? WHERE letter = 'A'`).run(v);
  for (const [col, bad, good, back] of [
    ['maps_url', 'https://maps.google.com/x', 'https://yandex.uz/maps/-/CDabc', ''],
    ['show_public', 2, 0, 1],
  ]) {
    assert.throws(() => set(col, bad), /CHECK/, col + ' = ' + bad);
    set(col, good);
    set(col, back);
  }
});
