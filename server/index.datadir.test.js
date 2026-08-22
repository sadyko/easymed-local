import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir } from './index.js';

test('with no environment variable, the data directory is <root>/data', () => {
  const root = '/srv/easymed';
  assert.equal(resolveDataDir({}, root), path.join(root, 'data'));
});

// resolveDataDir uses Node's platform-native `path`, deliberately: this app
// is installed only on clinic Windows machines (see the SUPERVISED_INSTALL_V1
// comments below), so on the one platform it actually ships to, `path` IS
// win32 semantics. A drive-letter value like 'C:\EasyMed\data' is only
// "absolute" under win32 rules — under posix rules (what `path` resolves to
// when this file itself runs on the ubuntu-latest CI runner) it is just a
// relative-looking string that gets joined under root instead, so the literal
// expectation below can never hold there. Skipped rather than rewritten for
// posix, because posix is not a real target for this code — this asserts a
// guarantee about the platform clinics actually run, and a passing-for-the-
// wrong-reason posix version would prove nothing.
test('EASYMED_DATA_DIR wins when set', { skip: process.platform !== 'win32' && 'drive-letter absolute-path detection is win32-only; this only ever runs on clinic Windows installs' }, () => {
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: 'C:\\EasyMed\\data' }, '/srv/easymed'), 'C:\\EasyMed\\data');
});

test('an empty or whitespace value is ignored, not obeyed', () => {
  // A service registered with a blank environment entry must not put the clinic
  // database in the filesystem root.
  const root = '/srv/easymed';
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: '' }, root), path.join(root, 'data'));
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: '   ' }, root), path.join(root, 'data'));
});

test('a relative value resolves against the application root, not the cwd', () => {
  // A Windows service starts with cwd = C:\Windows\system32. A relative path
  // resolved against that would silently create a second, empty database there,
  // and the clinic would open the app to an empty patient list while their real
  // records sat on disk, unreferenced.
  const root = path.join(os.tmpdir(), 'em-root');
  assert.equal(resolveDataDir({ EASYMED_DATA_DIR: 'mydata' }, root), path.join(root, 'mydata'));
});

test('the directory is created when asked', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-dd-'));
  const target = path.join(root, 'nested', 'data');
  resolveDataDir({ EASYMED_DATA_DIR: target }, root, { mkdir: true });
  assert.ok(fs.existsSync(target));
});

// SUPERVISED_INSTALL_V1 attack pass — found while reviewing this task, not asked
// for in the original ticket:
//
// A raw ENOTDIR/EEXIST from mkdirSync names the path but nothing else. A clinic
// manager who mistyped EASYMED_DATA_DIR into the service's environment config
// sees this on a headless Windows service with no console attached — the error
// only reaches a log file. The message must say which setting is at fault, not
// just repeat the path back.
test('a path that collides with an existing file fails with a message naming the setting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-dd-collide-'));
  const filePath = path.join(root, 'not-a-directory');
  fs.writeFileSync(filePath, 'x');
  assert.throws(
    () => resolveDataDir({ EASYMED_DATA_DIR: filePath }, root, { mkdir: true }),
    /EASYMED_DATA_DIR/,
  );
});

// path.resolve's absolute-path handling differs by platform in ways that are
// easy to get backwards without checking. Windows treats a fully-qualified
// drive-letter path (D:\...) as absolute even when `root` is a *different*
// drive (C:\...): the override must win outright, not get silently joined
// under root.
// Same win32-only reasoning as the skip above — path.isAbsolute('D:\\...')
// is only true under win32 rules, which is what `path` resolves to on the
// clinic Windows machines this ships to, but not on the ubuntu-latest runner
// this file is also exercised on.
test('an absolute override on a different drive than root is honoured, not joined under root', { skip: process.platform !== 'win32' && 'drive-letter absolute-path detection is win32-only; this only ever runs on clinic Windows installs' }, () => {
  assert.equal(
    resolveDataDir({ EASYMED_DATA_DIR: 'D:\\EasyMed\\data' }, 'C:\\some\\root'),
    'D:\\EasyMed\\data',
  );
});
