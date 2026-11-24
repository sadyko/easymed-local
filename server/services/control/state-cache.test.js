// LOCAL_SPEED_V1 (2026-11-24) — файловая часть controlState живёт в памяти.
//
// controlState спрашивают на каждом запросе API: control.json + licence.dat с
// диска + проверка подписи Ed25519 — ≈1,15 мс, из них 0,68 мс — два чтения
// файлов (на клинике с антивирусом — больше). Файлы меняются раз в час (check-in)
// или при активации, поэтому их разбор хранится в памяти по (mtimeMs, size)
// обоих файлов. Часть с базой (effectiveNow, clockAnomaly, extensionUntil) —
// на каждом вызове, как прежде.
//
// Здесь — что кэш не меняет ни одного ответа: только убирает чтения. Файлы
// создаются фикстурой с выдуманной клиникой; их содержимое тесты не печатают.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { canonical } from './canonical.js';
import { controlState, invalidateControlCache, __setPublicKeyForTests } from './state.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
__setPublicKeyForTests(publicKey);

const NOW = new Date('2026-08-25T00:00:00Z');
const HOUR_AGO = () => new Date(Date.now() - 3600 * 1000);

const issue = (over = {}) => {
  const payload = {
    clinic_id: 'c-000047', clinic_name: 'Тестовая клиника',
    modules: ['crm'], valid_until: '2026-09-03T00:00:00Z',
    issued_at: '2026-08-20T00:00:00Z', nonce: 'n1', ...over,
  };
  return JSON.stringify({ payload, sig: sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64') });
};
const IDENTITY = JSON.stringify({ clinic_id: 'c-000047', unlock_secret: 's3cret', subscription: 'active' });

/** Записать файл и состарить его: свежий файл кэш намеренно не хранит (см. state.js). */
function put(dir, name, content, when = HOUR_AGO()) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  fs.utimesSync(file, when, when);
}

function workspace({ identity = IDENTITY, licence = issue(), age = true } = {}) {
  const dir = tmpDir('em-ctlc-');
  if (identity !== null) age ? put(dir, 'control.json', identity) : fs.writeFileSync(path.join(dir, 'control.json'), identity);
  if (licence !== null) age ? put(dir, 'licence.dat', licence) : fs.writeFileSync(path.join(dir, 'licence.dat'), licence);
  const db = openDb(':memory:'); migrate(db);
  return { dir, db };
}

/** Сколько раз за fn прочитаны control.json / licence.dat (шпион на fs.readFileSync). */
function countReads(fn) {
  const real = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function (p, ...rest) {
    const name = path.basename(String(p));
    if (name === 'control.json' || name === 'licence.dat') reads.push(name);
    return real.call(this, p, ...rest);
  };
  try { return { value: fn(), reads }; } finally { fs.readFileSync = real; }
}

/** Ответ без функции has — для сравнения; has сверяется отдельно. */
const plain = (s) => ({ ...s, has: undefined });

test('второй вызов не читает ни одного файла — и отвечает то же самое', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  const first = countReads(() => controlState(db, dir, NOW));
  assert.deepEqual(first.reads.sort(), ['control.json', 'licence.dat'], 'первый вызов читает оба файла');
  const second = countReads(() => controlState(db, dir, NOW));
  assert.deepEqual(second.reads, [], 'второй вызов — из памяти');
  assert.deepEqual(plain(second.value), plain(first.value));
  assert.equal(second.value.has('crm'), true);
  assert.equal(second.value.locked, false);
});

test('часть с базой работает на каждом вызове: время и продление по телефону — свежие', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  assert.equal(controlState(db, dir, NOW).locked, false);
  const later = countReads(() => controlState(db, dir, new Date('2026-09-10T00:00:00Z')));
  assert.deepEqual(later.reads, [], 'файлы — из памяти');
  assert.equal(later.value.locked, true, 'а срок считается от нового времени');
  db.prepare("INSERT INTO control_state (key, value) VALUES ('offline_extension_until', '2026-09-20T00:00:00Z')").run();
  const rescued = countReads(() => controlState(db, dir, new Date('2026-09-10T00:00:00Z')));
  assert.deepEqual(rescued.reads, []);
  assert.equal(rescued.value.locked, false, 'продление из базы видно сразу');
  assert.equal(rescued.value.validUntil, '2026-09-20T00:00:00.000Z');
});

test('другой размер licence.dat — перечитывается', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  assert.deepEqual(controlState(db, dir, NOW).modules, ['crm']);
  put(dir, 'licence.dat', issue({ modules: ['crm', 'telegram'] }));
  const after = countReads(() => controlState(db, dir, NOW));
  assert.ok(after.reads.includes('licence.dat'), 'новый файл прочитан');
  assert.deepEqual(after.value.modules, ['crm', 'telegram']);
});

test('тот же размер, другое время изменения — перечитывается', () => {
  const { dir, db } = workspace({ licence: issue({ modules: ['crm'] }) });
  invalidateControlCache();
  assert.deepEqual(controlState(db, dir, NOW).modules, ['crm']);
  const other = issue({ modules: ['abc'] });
  assert.equal(Buffer.byteLength(other), fs.statSync(path.join(dir, 'licence.dat')).size, 'размер тот же');
  put(dir, 'licence.dat', other, new Date(Date.now() - 2 * 3600 * 1000));
  const after = countReads(() => controlState(db, dir, NOW));
  assert.ok(after.reads.includes('licence.dat'));
  assert.deepEqual(after.value.modules, ['abc']);
});

test('control.json тоже: новая клиника в файле — новый ответ', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  assert.equal(controlState(db, dir, NOW).clinicId, 'c-000047');
  put(dir, 'control.json', JSON.stringify({ clinic_id: 'c-000048', subscription: 'active' }));
  const s = controlState(db, dir, NOW);
  assert.equal(s.clinicId, 'c-000048');
  assert.equal(s.locked, true, 'лицензия чужой клиники не подходит');
});

test('invalidateControlCache() — следующий вызов читает файлы заново', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  controlState(db, dir, NOW);
  assert.deepEqual(countReads(() => controlState(db, dir, NOW)).reads, []);
  invalidateControlCache();
  assert.deepEqual(countReads(() => controlState(db, dir, NOW)).reads.sort(), ['control.json', 'licence.dat']);
});

test('файл, изменённый только что, не хранится: читается на каждом вызове (как до кэша)', () => {
  const { dir, db } = workspace({ age: false });
  invalidateControlCache();
  controlState(db, dir, NOW);
  assert.deepEqual(countReads(() => controlState(db, dir, NOW)).reads.sort(), ['control.json', 'licence.dat']);
});

test('удалённый licence.dat после закэшированного — сразу «не активировано», без чтения из памяти', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  assert.equal(controlState(db, dir, NOW).locked, false);
  fs.unlinkSync(path.join(dir, 'licence.dat'));
  const s = controlState(db, dir, NOW);
  assert.equal(s.locked, true);
  assert.equal(s.reason, 'unlicensed');
  assert.deepEqual(s.modules, []);
});

test('испорченные и отсутствующие файлы: из памяти — ровно тот же ответ, что и с диска', () => {
  const cases = [
    { name: 'нет licence.dat', licence: null },
    { name: 'мусор в licence.dat', licence: 'garbage' },
    { name: 'нет control.json', identity: null },
    { name: 'control.json — массив', identity: '[]' },
    { name: 'clinic_id — число', identity: JSON.stringify({ clinic_id: 123 }) },
    { name: 'подпись не та', licence: JSON.stringify({ payload: JSON.parse(issue()).payload, sig: JSON.parse(issue({ nonce: 'n2' })).sig }) },
    { name: 'чужая клиника', licence: issue({ clinic_id: 'c-999999' }) },
    { name: 'нестроковые модули', licence: issue({ modules: ['crm', 1, {}] }) },
  ];
  for (const c of cases) {
    const { dir, db } = workspace({ identity: c.identity === undefined ? IDENTITY : c.identity, licence: c.licence === undefined ? issue() : c.licence });
    invalidateControlCache();
    const fromDisk = controlState(db, dir, NOW);
    const fromMemory = countReads(() => controlState(db, dir, NOW));
    assert.deepEqual(fromMemory.reads, [], c.name + ': второй раз — без чтения');
    assert.deepEqual(plain(fromMemory.value), plain(fromDisk), c.name);
    assert.equal(fromMemory.value.has('crm'), fromDisk.has('crm'), c.name + ': has()');
  }
});

test('две папки данных не смешиваются', () => {
  const a = workspace({ licence: issue({ modules: ['crm'] }) });
  const b = workspace({ licence: issue({ modules: ['telegram'] }) });
  invalidateControlCache();
  assert.deepEqual(controlState(a.db, a.dir, NOW).modules, ['crm']);
  assert.deepEqual(controlState(b.db, b.dir, NOW).modules, ['telegram']);
  assert.deepEqual(countReads(() => controlState(a.db, a.dir, NOW)).value.modules, ['crm']);
});

test('смена ключа проверки (тесты) сбрасывает память: старая подпись больше не верна', () => {
  const { dir, db } = workspace();
  invalidateControlCache();
  assert.equal(controlState(db, dir, NOW).locked, false);
  const other = generateKeyPairSync('ed25519');
  __setPublicKeyForTests(other.publicKey);
  try {
    assert.equal(controlState(db, dir, NOW).locked, true, 'подпись под другим ключом — не принята');
  } finally {
    __setPublicKeyForTests(publicKey);
  }
  assert.equal(controlState(db, dir, NOW).locked, false);
});

test('писатели файлов (активация и check-in) сбрасывают память сразу после записи', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const [file, writes] of [['enroll.js', ['control.json', 'licence.dat']], ['checkin.js', ['licence.dat']]]) {
    const src = fs.readFileSync(path.join(here, file), 'utf8');
    assert.match(src, /import \{ invalidateControlCache \} from '\.\/state\.js'/, file + ': импорт');
    for (const w of writes) {
      const at = src.indexOf("writeAtomic(path.join(dataDir, '" + w + "')");
      assert.ok(at > 0, file + ': запись ' + w + ' найдена');
      const after = src.slice(at, at + 900);
      assert.match(after, /finally \{[\s\S]*?invalidateControlCache\(\)/, file + ': после записи ' + w + ' — invalidateControlCache() в finally');
    }
  }
});
