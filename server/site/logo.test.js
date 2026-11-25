// SITE_CLINIC_LOGO_V1 — на сайте логотип этой клиники, а не файл из Chilla.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { createSiteApp } from './app.js';
import { clinicLogo } from './logo.js';

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const DATA = 'data:image/png;base64,iVBORw0KGgo=';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT OR IGNORE INTO doc_settings (id) VALUES (1)').run();
  return { db, dir: tmpDir('em-site-logo-') };
}
const set = (db, square, data) => db.prepare('UPDATE doc_settings SET logo_square_path = ?, logo_data_url = ? WHERE id = 1').run(square, data);

async function site(db, dir, fn) {
  const server = createSiteApp(db, { storageDir: dir }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); server.closeAllConnections(); }
}

test('логотипа нет — на странице нет картинки, /media/logo отвечает 404', async () => {
  const { db, dir } = fresh(); set(db, '', '');
  await site(db, dir, async (u) => {
    const html = await (await fetch(u + '/ru/')).text();
    assert.ok(!html.includes('brand__mark') && !html.includes('logo.webp'));
    assert.equal((await fetch(u + '/media/logo')).status, 404);
  });
});

test('печатная копия из «Компании» — в шапке, и картинка отдаётся', async () => {
  const { db, dir } = fresh(); set(db, '', DATA);
  await site(db, dir, async (u) => {
    const src = /class="brand__mark" src="([^"]+)"/.exec(await (await fetch(u + '/ru/')).text())[1];
    assert.match(src, /^\/media\/logo\?v=[0-9a-f]{10}$/);
    const r = await fetch(u + src);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  });
});

test('квадратный файл главнее копии; нет файла — копия; чужой путь и SVG не читаются', () => {
  const { db, dir } = fresh();
  fs.mkdirSync(path.join(dir, 'clinic-logos', 'square'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'clinic-logos', 'square', 'a.png'), 'FILE');
  fs.writeFileSync(path.join(dir, 'secret.png'), 'SECRET');
  set(db, 'square/a.png', DATA);
  assert.equal(String(clinicLogo(db, dir).bytes), 'FILE');
  set(db, 'square/gone.png', DATA);
  assert.deepEqual(clinicLogo(db, dir).bytes, PNG);
  let got = null;
  try { set(db, 'square/../../secret.png', ''); got = clinicLogo(db, dir); } catch { /* база сама отвергла путь */ }
  assert.equal(got, null);
  set(db, '', 'data:image/svg+xml;base64,PHN2Zz4=');
  assert.equal(clinicLogo(db, dir), null);
});
