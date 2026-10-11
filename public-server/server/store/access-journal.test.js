// PUBLIC_SERVER_V1 — что попадает в журнал запросов партнёров (проверка 8b,
// C6): 429 и отказы без ключа, кроме 401, — только счётчики; строк одного ключа
// и строк без ключа в сутки — не больше потолка; всего строк — не больше потолка;
// после перезапуска счёт суток берётся из базы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessJournal } from './access-journal.js';
import { recordAccess } from './logs.js';
import { testDb, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';

const C = 'c-000777';
const DAY = 86400000;
function write(db, j, connectionId, status, now) {
  const ok = j.admit(db, { clinicId: C, connectionId, status, now });
  if (ok) recordAccess(db, { clinicId: C, connectionId, at: isoOf(now), method: 'GET', path: '/shifo/v1/clinic', status });
  return ok;
}
const rows = (db) => db.prepare('SELECT COUNT(*) AS n FROM access_log').get().n;

test('429 — никогда строкой; без ключа — только 401; с ключом — любой ответ', () => {
  const { db } = testDb();
  const j = createAccessJournal();
  assert.equal(write(db, j, 3, 429, NOW), false);
  assert.equal(write(db, j, null, 429, NOW), false);
  assert.equal(write(db, j, null, 503, NOW), false, 'без ключа и не 401 — счётчик');
  assert.equal(write(db, j, null, 400, NOW), false);
  assert.equal(write(db, j, null, 401, NOW), true);
  for (const s of [200, 401, 403, 404, 409, 503]) assert.equal(write(db, j, 3, s, NOW), true, String(s));
  assert.equal(rows(db), 7);
  assert.deepEqual(j.stats(), { rate_limited: 2, keyless: 2, over_key_day: 0, over_total: 0 });
});

test('потолок в сутки: на ключ и отдельно на запросы без ключа; новые сутки — снова пишется', () => {
  const { db } = testDb();
  const j = createAccessJournal({ perKeyPerDay: 5, keylessPerDay: 3, totalMax: 1000 });
  let wrote = 0;
  for (let i = 0; i < 10; i += 1) wrote += write(db, j, 3, 200, NOW + i) ? 1 : 0;
  assert.equal(wrote, 5);
  assert.equal(write(db, j, 4, 200, NOW), true, 'другой ключ — свой счёт');
  wrote = 0;
  for (let i = 0; i < 10; i += 1) wrote += write(db, j, null, 401, NOW + i) ? 1 : 0;
  assert.equal(wrote, 3);
  assert.equal(write(db, j, 3, 200, NOW + DAY), true, 'следующие сутки (UTC)');
  assert.equal(j.stats().over_key_day, 12);
});

test('после перезапуска счёт суток — из базы, а не с нуля', () => {
  const { db } = testDb();
  const first = createAccessJournal({ perKeyPerDay: 5, keylessPerDay: 2, totalMax: 1000 });
  for (let i = 0; i < 5; i += 1) write(db, first, 3, 200, NOW + i);
  for (let i = 0; i < 2; i += 1) write(db, first, null, 401, NOW + i);
  const again = createAccessJournal({ perKeyPerDay: 5, keylessPerDay: 2, totalMax: 1000 });
  assert.equal(write(db, again, 3, 200, NOW + 100), false);
  assert.equal(write(db, again, null, 401, NOW + 100), false);
  assert.equal(write(db, again, 3, 200, NOW + DAY), true);
});

test('всего строк — не больше потолка; уборка освобождает место', () => {
  const { db } = testDb();
  const j = createAccessJournal({ perKeyPerDay: 1000, keylessPerDay: 1000, totalMax: 4 });
  let wrote = 0;
  for (let i = 0; i < 10; i += 1) wrote += write(db, j, 1 + (i % 3), 200, NOW + i) ? 1 : 0;
  assert.equal(wrote, 4);
  assert.equal(j.stats().over_total, 6);
  db.prepare('DELETE FROM access_log WHERE id <= 2').run();
  assert.equal(write(db, j, 1, 200, NOW + 20), true);
});
