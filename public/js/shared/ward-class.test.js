// JOURNALS_V1_WARD_CLASS — класс палаты одним словарём на сервер (реестр) и экран (окно палаты).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WARD_CLASSES, WARD_CLASS_RU, wardClassLabel, normalizeWardClass } from './ward-class.js';

test('класс палаты: три значения, подписи владельца; пусто и мусор — «не задан»', () => {
  assert.deepEqual([...WARD_CLASSES], ['lux', 'semi_lux', 'standard']);
  assert.deepEqual({ ...WARD_CLASS_RU }, { lux: 'Люкс', semi_lux: 'Полулюкс', standard: 'Обычная' });
  assert.equal(wardClassLabel('semi_lux'), 'Полулюкс');
  assert.equal(wardClassLabel(null), '');
  assert.equal(wardClassLabel('vip'), '');
  assert.equal(normalizeWardClass(' lux '), 'lux');
  assert.equal(normalizeWardClass(''), null);
  assert.equal(normalizeWardClass(null), null);
  assert.equal(normalizeWardClass('vip'), null);
});

test('значения словаря — ровно те, что пускает CHECK миграции 234', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(dir, '..', '..', '..', 'server', 'db', 'migrations', '234_ward_class.sql'), 'utf8');
  const m = /CHECK \(ward_class IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(m, 'нет CHECK в миграции 234');
  assert.deepEqual(m[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...WARD_CLASSES]);
});
