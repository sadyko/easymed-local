// CLINIC_PROFILE_V1 (мигр. 240) — ПРОФИЛЬ КЛИНИКИ: только ADD COLUMN.
//
// Новые колонки пусты; адрес, который клиника вписала, и всё прежнее — на
// месте (бланки печатают прежний doc_settings.address — ответ владельца
// 2026-10-10, вариант B: колонки address_manual и сборки адреса для бланка нет);
// строка doc_settings не пересобрана (lab_scope и логотип на месте); CHECK —
// запасной замок форматов для /api/db.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
function dbBefore240() {
  const db = openDb(':memory:');
  const tmp = tmpDir('em-mig240-');
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql') && parseInt(x, 10) < 240)) {
    fs.copyFileSync(path.join(DIR, f), path.join(tmp, f));
  }
  migrate(db, tmp);
  return db;
}
const NEW = ['name_uz', 'name_en', 'about_ru', 'about_uz', 'about_en', 'country_code', 'region_code', 'district_code',
  'street_ru', 'street_uz', 'street_en', 'website', 'telegram_bot', 'telegram_channel', 'instagram',
  'maps_url', 'logo_square_path', 'logo_portrait_path'];

test('240: колонки профиля добавлены пустыми; вписанный адрес и прежнее не тронуты', () => {
  const db = dbBefore240();
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', address = 'Ташкент, ул. Мира 1',
              logo_data_url = 'data:image/png;base64,AAAA', lab_scope = 'building' WHERE id = 1`).run();
  migrate(db);
  const row = db.prepare('SELECT * FROM doc_settings WHERE id = 1').get();
  for (const c of NEW) assert.ok(c in row, 'нет колонки ' + c);
  for (const c of NEW) assert.equal(row[c], '', c + ' пуста');
  assert.deepEqual([row.clinic_name, row.address, row.logo_data_url, row.lab_scope],
    ['Шифо', 'Ташкент, ул. Мира 1', 'data:image/png;base64,AAAA', 'building']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_settings').get().n, 1);
});

test('240: колонки address_manual нет — бланк печатает вписанный руками address (ответ владельца, вариант B)', () => {
  const db = openDb(':memory:'); migrate(db);
  const cols = db.prepare('PRAGMA table_info(doc_settings)').all().map((c) => c.name);
  assert.ok(!cols.includes('address_manual'));
  for (const c of NEW) assert.ok(cols.includes(c), 'нет колонки ' + c);
});

test('240: CHECK — сайт https, бот на «bot», имена через @, карта Яндекса, логотипы в своих папках', () => {
  const db = openDb(':memory:'); migrate(db);
  const set = (col, v) => db.prepare(`UPDATE doc_settings SET ${col} = ? WHERE id = 1`).run(v);
  for (const [col, bad, good, empty] of [
    ['website', 'http://klinika.uz', 'https://klinika.uz', ''],
    ['telegram_bot', '@klinika', '@klinika_bot', ''],
    ['telegram_channel', 'klinika', '@klinika', ''],
    ['instagram', 'klinika', '@klinika.uz', ''],
    ['maps_url', 'https://google.com/maps/x', 'https://yandex.uz/maps/-/CDabc', ''],
    ['logo_square_path', 'portrait/1-a.png', 'square/1-a.png', ''],
    ['logo_portrait_path', 'square/1-a.png', 'portrait/1-a.png', ''],
  ]) {
    assert.throws(() => set(col, bad), /CHECK/, col + ' = ' + bad);
    set(col, good);
    set(col, empty);
  }
});
