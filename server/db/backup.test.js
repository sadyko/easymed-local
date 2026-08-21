import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';
import { backupBeforeMigrate, pruneBackups } from './backup.js';

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-bk-'));
  const dbPath = path.join(dir, 'easymed.db');
  const db = openDb(dbPath);
  migrate(db);
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('a','x','A','admin')").run();
  return { dir, dbPath, db };
}

test('a backup is taken and is a usable database', async () => {
  const { dbPath, db } = workspace();
  const out = await backupBeforeMigrate(db, dbPath, '2.4.0');
  assert.ok(fs.existsSync(out), 'the file exists');

  const restored = openDb(out);
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM users').get().n, 1,
    'the copy opens and holds the same rows — a raw file copy of a WAL database can lose the last writes');
});

test('the backup name records the version being installed', async () => {
  const { dbPath, db } = workspace();
  assert.match(path.basename(await backupBeforeMigrate(db, dbPath, '2.4.0')), /2\.4\.0/);
});

test('taking a backup twice does not overwrite the first', async () => {
  const { dbPath, db } = workspace();
  const a = await backupBeforeMigrate(db, dbPath, '2.4.0');
  const b = await backupBeforeMigrate(db, dbPath, '2.4.0');
  assert.notEqual(a, b, 'a retried update must not destroy the pre-update state');
});

test('two backups starting at the same instant do not collide', async () => {
  // A Windows service restart racing a manual double-click starts two
  // instances within milliseconds. An existsSync-then-write filename check
  // (the original implementation) lets both see the same name as free and
  // both write it at once. Promise.all forces the two calls to interleave
  // for real, rather than one completing before the other starts.
  const { dbPath, db } = workspace();
  const [a, b] = await Promise.all([
    backupBeforeMigrate(db, dbPath, '2.4.0'),
    backupBeforeMigrate(db, dbPath, '2.4.0'),
  ]);
  assert.notEqual(a, b, 'racing starts must not both claim the same backup filename');
  assert.equal(openDb(a).prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'first backup is intact');
  assert.equal(openDb(b).prepare('SELECT COUNT(*) n FROM users').get().n, 1, 'second backup is intact, not corrupted by the race');
});

test('old backups are pruned but the newest are kept', async () => {
  const { dir, dbPath, db } = workspace();
  const made = [];
  for (let i = 0; i < 7; i++) made.push(await backupBeforeMigrate(db, dbPath, '2.4.' + i));
  pruneBackups(path.join(dir, 'backups'), 3);
  const left = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(left.length, 3, 'a clinic disk is not infinite');
  assert.ok(left.includes(path.basename(made[6])), 'the newest survives');
  assert.ok(!left.includes(path.basename(made[0])), 'the oldest is gone');
});

test('the backup is a standalone checkpointed file, independent of the original WAL', async () => {
  // The whole reason this module exists instead of fs.copyFileSync: the .db
  // file on disk is not the whole database while WAL is active — recent writes
  // sit in the -wal sidecar. This proves db.backup() actually folds those
  // uncheckpointed writes into ONE standalone file, rather than the backup
  // being usable only for as long as the ORIGINAL's -wal happens to survive.
  const { dbPath, db } = workspace();
  // A second row, inserted right before backing up and never explicitly
  // checkpointed — if backup() missed WAL-resident data this is what it would lose.
  db.prepare("INSERT INTO users (username, password_hash, full_name, role) VALUES ('b','x','B','admin')").run();
  const out = await backupBeforeMigrate(db, dbPath, '2.4.0');

  // Windows holds an exclusive lock on an open -wal file, so it must be closed
  // before the sidecar can be removed at all — this is not true on POSIX, but
  // closing first is correct either way: what's being tested is the BACKUP's
  // independence from the original, not the original's own file locking.
  db.close();

  // Delete the ORIGINAL's WAL sidecars, not the backup's. If the backup were
  // somehow still tied to them, this is what would expose it.
  fs.rmSync(dbPath + '-wal', { force: true });
  fs.rmSync(dbPath + '-shm', { force: true });

  assert.ok(!fs.existsSync(out + '-wal'), 'the backup itself carries no WAL sidecar — it is one file');
  const restored = openDb(out);
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM users').get().n, 2,
    'both rows are in the backup even though the original WAL that held the second one is gone');
});

test('a failure to back up is reported, not swallowed', async () => {
  const { db } = workspace();
  // '/definitely/not/here/easymed.db' was the original probe for "unwritable
  // path", but on Windows a bare leading '/' resolves under the CURRENT DRIVE
  // ROOT (e.g. C:\definitely\not\here), and mkdirSync({recursive:true}) happily
  // created it there — the test passed on POSIX and silently created real
  // directories on C:\ here. Routing the path through an existing FILE forces
  // ENOTDIR on every platform without touching anything outside the temp dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-bk-blocker-'));
  const blocker = path.join(dir, 'not-a-directory.txt');
  fs.writeFileSync(blocker, 'x');
  await assert.rejects(() => backupBeforeMigrate(db, path.join(blocker, 'nested', 'easymed.db'), '2.4.0'));
});
