// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md, раздел 3,
// п. 11) — временные папки PDF для Telegram не копятся в %TEMP%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removePdfTempDir, sweepStalePdfDirs, PDF_TMP_PREFIX } from './render.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';

function renderDir(base, name) {
  const dir = path.join(base, PDF_TMP_PREFIX + name);
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doc.pdf'), 'pdf');
  return dir;
}

test('DISK_GUARD_V1: папка, занятая Chrome, удаляется повторной попыткой, а не остаётся в %TEMP%', () => {
  const dir = renderDir(tmpDir('em-pdftmp-'), 'busy');
  const calls = [];
  let busy = true;
  const rmImpl = (p, o) => {
    calls.push(o);
    if (busy) { busy = false; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); }
    fs.rmSync(p, o);
  };
  const later = [];
  const schedule = (fn, ms) => { later.push(ms); fn(); };
  assert.equal(removePdfTempDir(dir, { rmImpl, schedule }), false, 'сразу не вышло');
  assert.deepEqual(later, [30_000], 'вторая попытка — через полминуты, когда Chrome отпустит профиль');
  assert.equal(fs.existsSync(dir), false, 'и она убрала папку');
  assert.equal(calls[0].maxRetries, 5, 'и первая попытка — с повторами (rmSync maxRetries)');
  assert.equal(calls[0].recursive, true);
});

test('DISK_GUARD_V1: свободная папка удаляется сразу, без отложенной попытки', () => {
  const dir = renderDir(tmpDir('em-pdftmp-'), 'free');
  const later = [];
  assert.equal(removePdfTempDir(dir, { schedule: (fn, ms) => later.push(ms) }), true);
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(later, []);
});

test('DISK_GUARD_V1: при запуске убираются папки easymed-pdf-* старше суток — и только они', () => {
  const base = tmpDir('em-pdfsweep-');
  const old = renderDir(base, 'old');
  const fresh = renderDir(base, 'fresh');
  const foreign = path.join(base, 'other-old');
  fs.mkdirSync(foreign);
  const sameNameFile = path.join(base, PDF_TMP_PREFIX + 'file');
  fs.writeFileSync(sameNameFile, 'x');
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  for (const p of [old, foreign, sameNameFile]) fs.utimesSync(p, twoDaysAgo, twoDaysAgo);
  assert.equal(sweepStalePdfDirs({ base }), 1);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(fresh), 'папка идущего рендера не тронута');
  assert.ok(fs.existsSync(foreign), 'чужое не наше');
  assert.ok(fs.existsSync(sameNameFile), 'файл — не папка рендера');
});

test('DISK_GUARD_V1: уборка без папки — 0 и тишина, не исключение', () => {
  assert.equal(sweepStalePdfDirs({ base: path.join(tmpDir('em-pdfsweep-'), 'нет-такой') }), 0);
});

test('DISK_GUARD_V1: renderPdf убирает за собой через removePdfTempDir — в finally, на любом исходе', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'render.js'), 'utf8');
  assert.match(src, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), PDF_TMP_PREFIX\)\)/);
  assert.match(src, /\} finally \{\s*removePdfTempDir\(dir\);\s*\}/);
});
