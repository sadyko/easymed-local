// DISK_GUARD_V1 (docs/specs/2026-10-29-3181-cabinet-print-disk-design.md, раздел 3,
// п. 10) — журнал базы (-wal) не держит пиковый размер.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, checkpointWal, scheduleWalCheckpoint, JOURNAL_SIZE_LIMIT } from './connection.js';
import { tmpDir, closeOnExit, closeRegistered } from '../test-helpers/tmpdir.js';

test.after(closeRegistered);

// Журнал, который растёт и сам не сжимается: автоматическая контрольная точка
// выключена — как во время длинного отчёта, когда сжать его нельзя.
function grownWal() {
  const dir = tmpDir('em-wal-');
  const file = path.join(dir, 'easymed.db');
  const db = closeOnExit(openDb(file));
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t (x BLOB)');
  const ins = db.prepare('INSERT INTO t (x) VALUES (?)');
  db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(Buffer.alloc(4096, i % 256)); })();
  return { db, file };
}

test('DISK_GUARD_V1: каждое соединение — с пределом журнала 64 МБ', () => {
  const db = closeOnExit(openDb(path.join(tmpDir('em-wal-'), 'easymed.db')));
  assert.equal(JOURNAL_SIZE_LIMIT, 64 * 1024 * 1024);
  assert.equal(db.pragma('journal_size_limit', { simple: true }), JOURNAL_SIZE_LIMIT);
});

test('DISK_GUARD_V1: checkpointWal сжимает журнал до нуля, данные на месте, ожидание прежнее', () => {
  const { db, file } = grownWal();
  assert.ok(fs.statSync(file + '-wal').size > 1024 * 1024, 'журнал вырос');
  const r = checkpointWal(db);
  assert.equal(r.busy, 0);
  assert.equal(fs.statSync(file + '-wal').size, 0, 'TRUNCATE оставляет журнал пустым');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM t').get().n, 500);
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000, 'busy_timeout вернулся к прежнему');
});

test('DISK_GUARD_V1: закрытая база — null и строка в журнал, не исключение', () => {
  const db = openDb(path.join(tmpDir('em-wal-'), 'easymed.db'));
  db.close();
  assert.equal(checkpointWal(db), null);
});

test('DISK_GUARD_V1: scheduleWalCheckpoint — таймер unref, и он действительно сжимает', async () => {
  const { db, file } = grownWal();
  const t = scheduleWalCheckpoint(db, { intervalMs: 10 });
  try {
    assert.equal(t.hasRef(), false, 'остановку программы таймер не держит');
    const until = Date.now() + 3000;
    while (Date.now() < until && fs.statSync(file + '-wal').size > 0) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.statSync(file + '-wal').size, 0);
  } finally {
    clearInterval(t);
  }
});
