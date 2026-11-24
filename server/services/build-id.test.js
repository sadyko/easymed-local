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

// LOCAL_SPEED_V1 (ревью) — файл, который при старте не прочитать (антивирус
// держит: EBUSY/EPERM), не должен выпасть из сборки: иначе страница оставит его
// ссылку без /v/<номер>/, и общие модули загрузятся по двум адресам — дважды.

/** Читатель, отказывающий на одном файле: первые `times` раз (Infinity — всегда). */
function busyReader(rel, times, code = 'EBUSY') {
  const calls = { n: 0 };
  const readFile = (abs, ...rest) => {
    if (abs.split(path.sep).join('/').endsWith('/' + rel)) {
      calls.n += 1;
      if (calls.n <= times) throw Object.assign(new Error(code + ': resource busy or locked, open \'' + abs + '\''), { code });
    }
    return fs.readFileSync(abs, ...rest);
  };
  return { readFile, calls };
}

test('LOCAL_SPEED_V1 (ревью): нечитаемый файл остаётся в сборке с меткой — три попытки, одна строка в журнале', (t) => {
  const root = tree(t, BASE);
  const healthy = computeBuild(root);
  const warned = [];
  const pauses = [];
  const { readFile, calls } = busyReader('js/app.js', Infinity);
  const b = computeBuild(root, { readFile, warn: (l) => warned.push(String(l)), pause: (ms) => pauses.push(ms) });
  assert.equal(calls.n, 3, 'три попытки чтения');
  assert.equal(pauses.length, 2, 'между попытками — пауза');
  assert.deepEqual([...b.files.keys()], buildFiles(root), 'состав сборки — полный');
  assert.deepEqual(b.files.get('js/app.js'), { mtimeMs: -1, size: -1 });
  assert.deepEqual(b.files.get('css/app.css'), healthy.files.get('css/app.css'), 'остальные — как обычно');
  assert.match(b.id, /^[0-9a-f]{10}$/);
  assert.notEqual(b.id, healthy.id, 'номер — не тот, что у целой сборки');
  assert.equal(isBuildFile(b, 'js/app.js', fs.statSync(path.join(root, 'js', 'app.js'))), false, '«навсегда» такой файл не получит');
  assert.equal(warned.length, 1, warned.join(' | '));
  assert.ok(warned[0].includes('js/app.js'), warned[0]);
  assert.ok(!warned[0].includes(root) && !warned[0].includes(path.basename(root)), 'только относительный путь: ' + warned[0]);
  assert.doesNotMatch(warned[0], /resource busy|open '/, 'текст ошибки системы (с полным путём) не печатается');
});

test('LOCAL_SPEED_V1 (ревью): файл прочитался со второй-третьей попытки — сборка та же, что без сбоя, и тишина', (t) => {
  const root = tree(t, BASE);
  const healthy = computeBuild(root);
  const warned = [];
  const { readFile, calls } = busyReader('js/app.js', 2, 'EPERM');
  const b = computeBuild(root, { readFile, warn: (l) => warned.push(l), pause: () => {} });
  assert.equal(calls.n, 3);
  assert.equal(b.id, healthy.id);
  assert.deepEqual(b.files.get('js/app.js'), healthy.files.get('js/app.js'));
  assert.deepEqual(warned, []);
});

test('LOCAL_SPEED_V1 (ревью): два разных нечитаемых файла — два разных номера; исчезнувший файл — мимо, без повторов', (t) => {
  const root = tree(t, BASE);
  const quiet = { warn: () => {}, pause: () => {} };
  const a = computeBuild(root, { readFile: busyReader('js/app.js', Infinity).readFile, ...quiet });
  const b = computeBuild(root, { readFile: busyReader('js/admin/view.js', Infinity).readFile, ...quiet });
  assert.notEqual(a.id, b.id);
  const gone = busyReader('js/app.js', Infinity, 'ENOENT');
  const warned = [];
  const c = computeBuild(root, { readFile: gone.readFile, warn: (l) => warned.push(l), pause: () => {} });
  assert.equal(gone.calls.n, 1, 'файла нет — ждать нечего');
  assert.equal(c.files.has('js/app.js'), false, 'удалённого между обходом и чтением файла в сборке нет');
  assert.deepEqual(warned, []);
});
