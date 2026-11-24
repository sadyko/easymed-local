// LOCAL_SPEED_V1 (2026-11-24) — номер сборки клиента: отпечаток содержимого public/.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFiles, computeBuild, buildOf, isBuildFile, staticImmutable } from './build-id.js';

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const BASE = {
  'index.html': '<html></html>',
  'favicon.svg': '<svg/>',
  'sw.js': '// sw',
  'manifest.json': '{}',
  'icon-192.png': 'png',
  'js/app.js': 'export const a = 1;',
  'js/admin/view.js': 'export const b = 2;',
  'js/admin/view.test.js': 'test',
  'js/admin/__tests__/view.test.mjs': 'test',
  'js/admin/__tests__/harness.mjs': 'helper',
  'css/app.css': 'body{}',
  'fonts/f.woff2': 'font',
  'assets/icons/x.svg': '<svg/>',
};

test('в отпечаток входят js/, css/, fonts/ и *.js|*.css|*.svg из корня — без тестов, в постоянном порядке', (t) => {
  const root = tree(t, BASE);
  assert.deepEqual(buildFiles(root), [
    'css/app.css', 'favicon.svg', 'fonts/f.woff2', 'js/admin/view.js', 'js/app.js', 'sw.js',
  ]);
  const b = computeBuild(root);
  assert.match(b.id, /^[0-9a-f]{10}$/);
  assert.equal(computeBuild(root).id, b.id, 'тот же каталог — тот же номер');
  assert.deepEqual([...b.files.keys()], buildFiles(root));
});

test('номер меняется, когда содержимое файла изменилось при тех же размере и времени', (t) => {
  const root = tree(t, BASE);
  const file = path.join(root, 'js', 'app.js');
  const when = new Date('2026-11-01T10:00:00Z');   // целые миллисекунды: utimes не хранит доли
  fs.utimesSync(file, when, when);
  const before = fs.statSync(file);
  const first = computeBuild(root).id;
  fs.writeFileSync(file, 'export const a = 2;');   // та же длина
  fs.utimesSync(file, before.atime, before.mtime);
  const after = fs.statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(computeBuild(root).id, first);
});

test('номер меняется от нового, переименованного и удалённого файла кода', (t) => {
  const root = tree(t, BASE);
  const ids = new Set([computeBuild(root).id]);
  fs.writeFileSync(path.join(root, 'js', 'new.js'), '');
  ids.add(computeBuild(root).id);
  fs.renameSync(path.join(root, 'js', 'new.js'), path.join(root, 'js', 'new2.js'));
  ids.add(computeBuild(root).id);
  fs.rmSync(path.join(root, 'css', 'app.css'));
  ids.add(computeBuild(root).id);
  assert.equal(ids.size, 4);
});

test('тесты, страницы, картинки и манифест на номер не влияют (у клиники тестов нет)', (t) => {
  const root = tree(t, BASE);
  const first = computeBuild(root).id;
  fs.rmSync(path.join(root, 'js', 'admin', '__tests__'), { recursive: true });
  fs.rmSync(path.join(root, 'js', 'admin', 'view.test.js'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>другое</html>');
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'icon-192.png'), 'png2');
  assert.equal(computeBuild(root).id, first);
});

test('граница между файлами входит в отпечаток: байты не «переезжают» из файла в файл незаметно', (t) => {
  const a = tree(t, { 'js/a.js': 'xy', 'js/b.js': 'z' });
  const b = tree(t, { 'js/a.js': 'x', 'js/b.js': 'yz' });
  assert.notEqual(computeBuild(a).id, computeBuild(b).id);
});

test('buildOf считает папку один раз на процесс; пустая и отсутствующая папка — не ошибка', (t) => {
  const root = tree(t, BASE);
  const first = buildOf(root);
  fs.writeFileSync(path.join(root, 'js', 'app.js'), 'export const a = 3;');
  assert.equal(buildOf(root), first, 'посчитано при старте');
  assert.match(computeBuild(path.join(root, 'no-such-dir')).id, /^[0-9a-f]{10}$/);
});

test('isBuildFile: файл тот самый, пока время и размер те, что были при подсчёте', (t) => {
  const root = tree(t, BASE);
  const b = computeBuild(root);
  const file = path.join(root, 'js', 'app.js');
  assert.equal(isBuildFile(b, 'js/app.js', fs.statSync(file)), true);
  fs.writeFileSync(file, 'export const a = 1; // правка');
  assert.equal(isBuildFile(b, 'js/app.js', fs.statSync(file)), false);
  assert.equal(isBuildFile(b, 'manifest.json', fs.statSync(path.join(root, 'manifest.json'))), false, 'в отпечатке его нет');
});

test('EASYMED_STATIC_IMMUTABLE: выключает только «0»', () => {
  assert.equal(staticImmutable({}), true);
  assert.equal(staticImmutable({ EASYMED_STATIC_IMMUTABLE: '1' }), true);
  assert.equal(staticImmutable({ EASYMED_STATIC_IMMUTABLE: '' }), true);
  assert.equal(staticImmutable({ EASYMED_STATIC_IMMUTABLE: '0' }), false);
  assert.equal(staticImmutable({ EASYMED_STATIC_IMMUTABLE: ' 0 ' }), false);
});
