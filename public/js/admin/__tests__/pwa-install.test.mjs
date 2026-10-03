// PWA_ADDRESS_BAR_ONLY_V1 (2026-10-03) — страж «установка только значком Chrome».
//
// Владелец хочет ставить EasyMed как приложение тем же значком «Установить»
// справа в адресной строке, что у YouTube, и НЕ хочет кнопки на странице.
// Раньше была своя мигающая кнопка (PWA_INSTALL_FAB_V1): она перехватывала
// событие beforeinstallprompt и звала preventDefault(), то есть глушила
// собственное предложение Chrome. Кнопку убрали; этот файл не даёт ей тихо
// вернуться и следит, что всё, без чего Chrome значок НЕ покажет, на месте:
//
//   * НИКТО НЕ ПЕРЕХВАТЫВАЕТ beforeinstallprompt — ни в одном файле public/js,
//     и от кнопки не осталось ни разметки, ни стилей (em-install-*);
//   * СЕРВИС-ВОРКЕР РЕГИСТРИРУЕТСЯ (PWA_V1) — без него нет установки;
//   * МАНИФЕСТ ГОДЕН ДЛЯ УСТАНОВКИ: имя, start_url, display: standalone и
//     значки 192 и 512, файлы которых реально лежат в public/;
//   * admin.html ССЫЛАЕТСЯ НА МАНИФЕСТ, а у sw.js есть обработчик fetch;
//   * СЕРВЕР ОТДАЁТ /admin, /manifest.json, /sw.js и значки без входа —
//     настоящий createApp: Chrome проверяет установку до любого логина.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', '..', '..');       // …/public
const read = (rel) => fs.readFileSync(path.join(PUB, rel), 'utf8');

// Все файлы под dir с нужными расширениями. Папки __tests__ пропускаются:
// в них (в этом самом файле) искомые слова стоят как образцы.
function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, exts, out); continue; }
    if (exts.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(PUB, p).replace(/\\/g, '/');

test('никто не перехватывает предложение установки Chrome и кнопки em-install нет', () => {
  const js = walk(path.join(PUB, 'js'), /\.m?js$/);
  assert.ok(js.length > 50, 'обход public/js нашёл подозрительно мало файлов: ' + js.length);
  const hijack = js.filter((f) => fs.readFileSync(f, 'utf8').includes('beforeinstallprompt'));
  assert.deepEqual(hijack.map(rel), [], 'beforeinstallprompt снова перехватывается — значок Chrome заглушён');
  const jsBtn = js.filter((f) => fs.readFileSync(f, 'utf8').includes('em-install'));
  assert.deepEqual(jsBtn.map(rel), [], 'в public/js вернулась кнопка установки на странице');

  const css = walk(path.join(PUB, 'css'), /\.css$/);
  assert.ok(css.length > 0, 'обход public/css не нашёл ни одного файла');
  const cssBtn = css.filter((f) => fs.readFileSync(f, 'utf8').includes('em-install'));
  assert.deepEqual(cssBtn.map(rel), [], 'в public/css вернулись стили кнопки установки');

  const html = fs.readdirSync(PUB).filter((n) => n.endsWith('.html'));
  for (const n of html) assert.ok(!read(n).includes('em-install'), n + ': кнопка установки в разметке');
});

test('сервис-воркер по-прежнему регистрируется (PWA_V1)', () => {
  const src = read('js/admin.js');
  assert.match(src, /navigator\.serviceWorker\.register\(\s*['"]\/sw\.js['"]/, 'admin.js больше не регистрирует /sw.js — Chrome не предложит установку');
});

test('manifest.json годен для установки: имя, start_url, standalone, значки 192 и 512 на месте', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.ok(typeof m.name === 'string' && m.name.trim(), 'нет name');
  assert.ok(typeof m.short_name === 'string' && m.short_name.trim(), 'нет short_name');
  assert.ok(typeof m.start_url === 'string' && m.start_url.startsWith('/'), 'нет start_url (или он не на своём сервере)');
  assert.equal(m.display, 'standalone');
  const icons = Array.isArray(m.icons) ? m.icons : [];
  for (const size of ['192x192', '512x512']) {
    const icon = icons.find((i) => String(i.sizes).split(/\s+/).includes(size) && /png/.test(String(i.type || 'png')));
    assert.ok(icon, 'нет значка ' + size);
    const file = path.join(PUB, String(icon.src).replace(/^\//, ''));
    assert.ok(fs.existsSync(file), 'значок ' + size + ' указан, но файла нет: ' + icon.src);
    // PNG по подписи, а не по имени: битый файл Chrome молча не примет.
    const sig = fs.readFileSync(file).subarray(0, 8).toString('hex');
    assert.equal(sig, '89504e470d0a1a0a', icon.src + ' — не PNG');
  }
});

test('admin.html ссылается на манифест, у sw.js есть обработчик fetch', () => {
  assert.match(read('admin.html'), /<link\s+rel=["']manifest["']\s+href=["']\/manifest\.json["']/);
  assert.match(read('sw.js'), /addEventListener\(\s*['"]fetch['"]/);
});

test('сервер отдаёт /admin, манифест, sw.js и значки без входа', async (t) => {
  const { openDb } = await import('../../../../server/db/connection.js');
  const { migrate } = await import('../../../../server/db/migrate.js');
  const { createApp } = await import('../../../../server/app.js');
  const { licensedDataDir } = await import('../../../../server/services/control/licensed-fixture.js');
  const { listen } = await import('../../../../control-plane/server/test-helpers/listen.js');
  const db = openDb(':memory:');
  migrate(db);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const m = JSON.parse(read('manifest.json'));
  const admin = await fetch(base + m.start_url);   // /admin — чистый адрес (extensions: ['html'])
  assert.equal(admin.status, 200, m.start_url + ' → ' + admin.status);
  assert.match(admin.headers.get('content-type') || '', /text\/html/);
  assert.match(await admin.text(), /rel=["']manifest["']/, 'по start_url пришла не страница программы');

  for (const [p, type] of [['/manifest.json', /json/], ['/sw.js', /javascript/], ['/icon-192.png', /image\/png/], ['/icon-512.png', /image\/png/]]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p + ' → ' + r.status);
    assert.match(r.headers.get('content-type') || '', type, p + ': ' + r.headers.get('content-type'));
    await r.arrayBuffer();
  }
});
