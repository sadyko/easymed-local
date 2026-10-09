// LIS_PROXY_V1 — настройка LIS Proxy (файл data/lisproxy.json): чтение не
// бросает, включён — только с ключом, ключ — 43 знака base64url, сравнение —
// по SHA-256 за постоянное время.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../test-helpers/tmpdir.js';
import { readProxySettings, writeProxySettings, newProxyKey, keyMatches, settingsPath } from './lisproxy-settings.js';

test('нет файла, мусор, массив, включён без ключа — выключено', () => {
  const dir = tmpDir('em-lpx-set-');
  assert.deepEqual(readProxySettings(dir), { enabled: false, key: null, changed_at: null, changed_by: null });
  for (const text of ['{не json', '[]', 'null', '{"enabled":true}', '{"enabled":true,"key":"   "}']) {
    fs.writeFileSync(settingsPath(dir), text);
    assert.equal(readProxySettings(dir).enabled, false, text);
  }
});

test('запись и чтение: включён с ключом; кто и когда; BOM не мешает', () => {
  const dir = tmpDir('em-lpx-set-');
  const s = writeProxySettings(dir, { enabled: true, key: 'k-1', changed_by: 7 });
  assert.equal(s.enabled, true);
  assert.equal(s.key, 'k-1');
  assert.equal(s.changed_by, 7);
  assert.match(s.changed_at, /^\d{4}-\d{2}-\d{2}T/);
  fs.writeFileSync(settingsPath(dir), '﻿' + JSON.stringify({ enabled: true, key: 'k-2' }));
  assert.deepEqual([readProxySettings(dir).enabled, readProxySettings(dir).key], [true, 'k-2']);
  assert.equal(writeProxySettings(dir, { enabled: false, key: 'k-2' }).enabled, false, 'выключенный ключ хранит');
  assert.equal(readProxySettings(dir).key, 'k-2');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'временных файлов не осталось');
});

test('ключ: 43 знака base64url, каждый раз новый', () => {
  const a = newProxyKey();
  const b = newProxyKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('keyMatches: только точное совпадение; не строка, пусто, массив — нет', () => {
  assert.equal(keyMatches('abc', 'abc'), true);
  assert.equal(keyMatches('abd', 'abc'), false);
  assert.equal(keyMatches('abc ', 'abc'), false);
  assert.equal(keyMatches('', 'abc'), false);
  assert.equal(keyMatches('abc', null), false);
  assert.equal(keyMatches(['abc'], 'abc'), false);
  assert.equal(keyMatches(undefined, 'abc'), false);
  assert.equal(keyMatches('a'.repeat(5000), 'abc'), false, 'длинная строка не бросает');
});

test('settingsPath — файл в папке данных здания', () => {
  assert.equal(path.basename(settingsPath('X')), 'lisproxy.json');
});
