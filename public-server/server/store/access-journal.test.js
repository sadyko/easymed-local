// PUBLIC_SERVER_V1 — что попадает в журнал запросов партнёров (проверка 8b,
// C6, и проверка исправлений 8b, F): 429 и отказы без ключа, кроме 401, — только
// счётчики; строк одного ключа и строк без ключа в сутки — не больше потолка;
// у каждой клиники — свой бюджет строк за 30 дней хранения (одни клиники не
// вытесняют другие), общий потолок — только защита диска; где журнал неполон —
// одна строка-отметка «SKIP» для 8d; после перезапуска счёт берётся из базы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessJournal, ACCESS_CLINIC_MAX, ACCESS_TOTAL_MAX, ACCESS_PER_KEY_PER_DAY, KEYLESS_SHARE } from './access-journal.js';
import { recordAccess, accessSince } from './logs.js';
import { testDb, NOW } from '../test-helpers/fixture.js';
import { isoOf } from '../lib/time.js';

const C = 'c-000777';
const DAY = 86400000;
function clinics(db, ...ids) {
  for (const id of ids) db.prepare("INSERT INTO clinics (clinic_id, key_fp, first_seen_at, last_seen_at) VALUES (?, 'f', ?, ?)").run(id, isoOf(NOW), isoOf(NOW));
}
function write(db, j, connectionId, status, now, clinicId = C) {
  const ok = j.admit(db, { clinicId, connectionId, status, now });
  if (ok) recordAccess(db, { clinicId, connectionId, at: isoOf(now), method: 'GET', path: '/shifo/v1/clinic', status });
  return ok;
}
const rows = (db) => db.prepare('SELECT COUNT(*) AS n FROM access_log WHERE status > 0').get().n;
const real = (db, clinicId) => db.prepare('SELECT COUNT(*) AS n FROM access_log WHERE clinic_id = ? AND status > 0').get(clinicId).n;
const marks = (db) => db.prepare('SELECT clinic_id AS c, connection_id AS k, path FROM access_log WHERE status = 0 ORDER BY id').all()
  .map((m) => [m.c, m.k, m.path]);

test('429 — никогда строкой; без ключа — только 401; с ключом — любой ответ', () => {
  const { db } = testDb();
  clinics(db, C);
  const j = createAccessJournal();
  assert.equal(write(db, j, 3, 429, NOW), false);
  assert.equal(write(db, j, null, 429, NOW), false);
  assert.equal(write(db, j, null, 503, NOW), false, 'без ключа и не 401 — счётчик');
  assert.equal(write(db, j, null, 400, NOW), false);
  assert.equal(write(db, j, null, 401, NOW), true);
  for (const s of [200, 401, 403, 404, 409, 503]) assert.equal(write(db, j, 3, s, NOW), true, String(s));
  assert.equal(rows(db), 7);
  assert.deepEqual(marks(db), [], 'отказы по виду запроса — не неполнота журнала');
  assert.deepEqual(j.stats(), { rate_limited: 2, keyless: 2, over_key_day: 0, over_clinic: 0, over_total: 0 });
});

test('потолок в сутки на ключ и на запросы без ключа; где журнал неполон — одна отметка SKIP за сутки, её видит клиника', () => {
  const { db } = testDb();
  clinics(db, C);
  const j = createAccessJournal({ perKeyPerDay: 5, keylessPerDay: 3 });
  let wrote = 0;
  for (let i = 0; i < 10; i += 1) wrote += write(db, j, 3, 200, NOW + i) ? 1 : 0;
  assert.equal(wrote, 5);
  assert.equal(write(db, j, 4, 200, NOW), true, 'другой ключ — свой счёт');
  wrote = 0;
  for (let i = 0; i < 10; i += 1) wrote += write(db, j, null, 401, NOW + i) ? 1 : 0;
  assert.equal(wrote, 3);
  assert.deepEqual(marks(db), [[C, 3, 'key_day'], [C, null, 'keyless_day']], 'одна отметка на ключ и причину за сутки');
  const exported = accessSince(db, C, 0).filter((r) => r.status === 0);
  assert.deepEqual(exported.map((r) => [r.method, r.path, r.connection_id, r.at]), [['SKIP', 'key_day', 3, isoOf(NOW + 5)], ['SKIP', 'keyless_day', null, isoOf(NOW + 3)]],
    'клиника получает отметку «журнал неполон с …» тем же каналом, что журнал (8d)');
  assert.equal(write(db, j, 3, 200, NOW + DAY), true, 'следующие сутки (UTC)');
  assert.equal(j.stats().over_key_day, 12);
});

test('после перезапуска счёт суток — из базы, а не с нуля (отметки не считаются)', () => {
  const { db } = testDb();
  clinics(db, C);
  const first = createAccessJournal({ perKeyPerDay: 5, keylessPerDay: 2 });
  for (let i = 0; i < 6; i += 1) write(db, first, 3, 200, NOW + i);
  for (let i = 0; i < 2; i += 1) write(db, first, null, 401, NOW + i);
  const again = createAccessJournal({ perKeyPerDay: 5, keylessPerDay: 2 });
  assert.equal(write(db, again, 3, 200, NOW + 100), false);
  assert.equal(write(db, again, null, 401, NOW + 100), false);
  assert.equal(write(db, again, 3, 200, NOW + DAY), true);
  assert.equal(write(db, again, 4, 200, NOW + 100), true, 'отметка ключа 3 не съела счёт ключа 4');
});

test('у каждой клиники свой бюджет: два занятых ключа клиники А не вытесняют журнал клиники Б; 401 без ключа — в запасе', () => {
  const { db } = testDb();
  clinics(db, 'c-a', 'c-b');
  const j = createAccessJournal({ perKeyPerDay: 1000, keylessPerDay: 100, totalMax: 200 });   // 200 строк на 2 клиники — по 100, из них 10 — запас для 401
  for (let d = 0; d < 3; d += 1) for (let i = 0; i < 60; i += 1) for (const k of [1, 2]) write(db, j, k, 200, NOW + d * DAY + i, 'c-a');
  assert.equal(real(db, 'c-a'), 90, 'клиника А — в пределах своего бюджета без запаса');
  assert.equal(write(db, j, null, 401, NOW + 3 * DAY, 'c-a'), true, 'неверный ключ у клиники А всё ещё виден ей — запас');
  for (let i = 0; i < 5; i += 1) assert.equal(write(db, j, 1, 200, NOW + 3 * DAY + i, 'c-b'), true, 'клиника Б пишет своё');
  assert.equal(write(db, j, null, 401, NOW + 3 * DAY, 'c-b'), true);
  assert.equal(real(db, 'c-b'), 6);
  assert.ok(marks(db).some(([c, k, p]) => c === 'c-a' && k === 1 && p === 'clinic_budget'), 'клиника А видит, с какого мига её журнал неполон');
  assert.equal(j.stats().over_total, 0, 'общий потолок — только защита диска, до него не доходит');
  assert.ok(j.stats().over_clinic > 0);
});

test('бюджет клиники освобождается уборкой: пересчёт из базы — не чаще раза в минуту', () => {
  const { db } = testDb();
  clinics(db, C);
  const j = createAccessJournal({ perKeyPerDay: 1000, totalMax: 10 });   // одна клиника: 10, из них 9 — с ключом
  for (let i = 0; i < 9; i += 1) assert.equal(write(db, j, 3, 200, NOW + i), true);
  assert.equal(write(db, j, 3, 200, NOW + 10), false);
  db.prepare('DELETE FROM access_log WHERE id <= 5 AND status > 0').run();
  assert.equal(write(db, j, 3, 200, NOW + 30000), false, 'полминуты — ещё по памяти');
  assert.equal(write(db, j, 3, 200, NOW + 61000), true, 'через минуту — пересчёт, место есть');
});

test('общий потолок — защита диска: строки сверх него не пишутся, клиника получает отметку', () => {
  const { db } = testDb();
  clinics(db, C);
  for (let i = 0; i < 10; i += 1) recordAccess(db, { clinicId: 'c-x', connectionId: 1, at: isoOf(NOW), method: 'GET', path: '/x/v1/clinic', status: 200 });
  const j = createAccessJournal({ totalMax: 10 });
  assert.equal(write(db, j, 3, 200, NOW), false);
  assert.deepEqual(marks(db), [[C, 3, 'total']]);
  assert.equal(j.stats().over_total, 1);
});

test('потолки по умолчанию: общий потолок держит полный бюджет хотя бы десяти клиник; один ключ не выбирает бюджет клиники за неделю', () => {
  assert.ok(ACCESS_TOTAL_MAX >= 10 * ACCESS_CLINIC_MAX);
  assert.ok(ACCESS_PER_KEY_PER_DAY * 7 < ACCESS_CLINIC_MAX * (1 - KEYLESS_SHARE));
});
