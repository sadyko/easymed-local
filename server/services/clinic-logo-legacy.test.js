// CLINIC_PROFILE_V1 — прежний логотип «Компании» (data URL) не теряется:
// при запуске он ложится файлом в хранилище, строка базы не меняется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { fakePng, pngDataUrl } from '../test-helpers/fake-png.js';
import { becomeSecondary } from './branch-sync/identity.js';
import { preserveLegacyLogo } from './clinic-logo-legacy.js';

function seed(values = {}) {
  const db = openDb(':memory:'); migrate(db);
  const sets = Object.keys(values).map((k) => `${k} = @${k}`).join(', ');
  if (sets) db.prepare(`UPDATE doc_settings SET ${sets} WHERE id = 1`).run(values);
  return db;
}
const legacyDir = (storage) => path.join(storage, 'clinic-logos', 'legacy');

test('data URL без квадратного — файл с теми же байтами; строка как была; повтор ничего не пишет', () => {
  const png = fakePng(220, 90);
  const db = seed({ logo_data_url: pngDataUrl(png) });
  const storage = tmpDir('em-legacy-logo-');
  const first = preserveLegacyLogo(db, storage);
  assert.match(first.kept, /^legacy\/logo-[0-9a-f]{16}\.png$/);
  assert.equal(first.already, false);
  assert.deepEqual(fs.readFileSync(path.join(storage, 'clinic-logos', first.kept)), png);
  assert.equal(db.prepare('SELECT logo_data_url FROM doc_settings').get().logo_data_url, pngDataUrl(png));
  const second = preserveLegacyLogo(db, storage);
  assert.equal(second.already, true);
  assert.equal(second.kept, first.kept);
  assert.equal(fs.readdirSync(legacyDir(storage)).length, 1);
});

test('другой прежний логотип (восстановили копию) получает свой файл; JPEG — с расширением .jpg', () => {
  const storage = tmpDir('em-legacy-logo-');
  const a = preserveLegacyLogo(seed({ logo_data_url: pngDataUrl(fakePng(220, 90)) }), storage);
  const b = preserveLegacyLogo(seed({ logo_data_url: 'data:image/jpeg;base64,' + Buffer.from('JPEG-LOGO').toString('base64') }), storage);
  assert.notEqual(a.kept, b.kept);
  assert.match(b.kept, /^legacy\/logo-[0-9a-f]{16}\.jpg$/);
  assert.equal(fs.readFileSync(path.join(storage, 'clinic-logos', b.kept), 'utf8'), 'JPEG-LOGO');
  assert.equal(fs.readdirSync(legacyDir(storage)).length, 2);
});

test('квадратный уже загружен, логотипа нет, филиал, не data URL — ничего не пишется и не падает', () => {
  for (const db of [
    seed({ logo_data_url: pngDataUrl(fakePng(220, 220)), logo_square_path: 'square/1-a.png' }),
    seed({}),
    (() => { const d = seed({ logo_data_url: pngDataUrl(fakePng(220, 90)) }); becomeSecondary(d, { letter: 'C', name: 'Чиланзар' }); return d; })(),
    seed({ logo_data_url: 'не картинка' }),
  ]) {
    const storage = tmpDir('em-legacy-logo-');
    assert.doesNotThrow(() => preserveLegacyLogo(db, storage));
    assert.equal(fs.existsSync(legacyDir(storage)), false);
  }
});

test('index.js вызывает сохранение после миграций', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = src.indexOf('preserveLegacyLogo(db');
  assert.ok(at > 0, 'вызова нет');
  assert.ok(at > src.indexOf('migrate(db);'), 'вызов должен стоять после migrate(db)');
  assert.match(src, /import \{ preserveLegacyLogo \} from '\.\/services\/clinic-logo-legacy\.js';/);
});
