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

// CLINIC_PROFILE_V1 (ревью M3) — прежний логотип бывает не только
// «data:image/png;base64,…»: SVG текстом (utf8 или %-кодированный), base64 в
// URL-безопасном алфавите, data URL с параметрами (;charset=, ;name=). Такие
// раньше молча пропускались, и первая загрузка квадратного затирала
// единственную копию. Теперь каждый ложится файлом с теми же байтами.
test('варианты data URL: SVG текстом и %-кодом, URL-безопасный base64, параметры — файл с теми же байтами', () => {
  const storage = tmpDir('em-legacy-logo-');
  const bin = Buffer.from([0xfb, 0xff, 0xfe, 1, 2, 0x3e, 0x3f]);
  for (const [value, ext, bytes] of [
    ['data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>', '.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['data:image/svg+xml,%3Csvg%2F%3E', '.svg', Buffer.from('<svg/>')],
    ['data:image/svg+xml;charset=utf-8,%3Csvg%3E%D0%96%3C%2Fsvg%3E', '.svg', Buffer.from('<svg>Ж</svg>')],
    ['data:image/png;base64,' + bin.toString('base64url'), '.png', bin],
    ['data:image/png;name=logo.png;base64,' + bin.toString('base64'), '.png', bin],
    ['data:image/PNG;BASE64,' + bin.toString('base64').replace(/(.{4})/g, '$1\n'), '.png', bin],
    ['data:image/png;base64,' + bin.toString('base64').replace(/=/g, '%3D'), '.png', bin],
  ]) {
    const r = preserveLegacyLogo(seed({ logo_data_url: value }), storage);
    assert.ok(r.kept, 'не сохранён: ' + value.slice(0, 50));
    assert.ok(r.kept.endsWith(ext), r.kept + ' — ожидалось ' + ext);
    assert.deepEqual(fs.readFileSync(path.join(storage, 'clinic-logos', r.kept)), bytes, value.slice(0, 50));
  }
});

test('битый base64 не теряется: тело сохраняется как есть (.txt)', () => {
  const storage = tmpDir('em-legacy-logo-');
  const r = preserveLegacyLogo(seed({ logo_data_url: 'data:image/png;base64,@@not*base64@@' }), storage);
  assert.match(r.kept, /\.txt$/);
  assert.equal(fs.readFileSync(path.join(storage, 'clinic-logos', r.kept), 'utf8'), '@@not*base64@@');
});

test('хранилище не пишется — исключение наружу (запуск его ловит; /api/db отказывает затирать)', () => {
  const storage = tmpDir('em-legacy-logo-');
  fs.writeFileSync(path.join(storage, 'clinic-logos'), 'x');   // на месте папки — файл
  assert.throws(() => preserveLegacyLogo(seed({ logo_data_url: pngDataUrl(fakePng(220, 90)) }), storage));
});
