import fs from 'node:fs';
import path from 'node:path';

// SUPERVISED_INSTALL_V1 — the rollback for an update.
//
// Reverting code is trivial; reverting a migration is not. So the design never
// tries: it restores the database from a copy taken immediately before the
// migrations ran. That copy IS the rollback story, and every part of remote
// updating depends on it existing and being correct.
//
// better-sqlite3's own db.backup() is used rather than fs.copyFileSync. The
// database runs in WAL mode, so the .db file on disk is NOT the whole database —
// recent writes live in the -wal sidecar. A plain file copy silently loses them,
// and the loss only shows up when the backup is restored, which is the worst
// possible moment to find out.

/**
 * @param {Database} db      the open connection
 * @param {string} dbPath    where that database lives on disk
 * @param {string} version   the version about to be installed, for the filename
 * @returns {Promise<string>} the path written
 */
export async function backupBeforeMigrate(db, dbPath, version) {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });

  // A retried update must not destroy the state the first attempt captured, so
  // the name carries a counter rather than being overwritten.
  //
  // The filename is CLAIMED with an exclusive create ('wx'), not decided by
  // existsSync-then-write. A Windows service restart racing a manual
  // double-click starts two instances within milliseconds of each other; with
  // a plain existsSync check both could see "pre-2.4.0.db free" and both call
  // db.backup() onto the same path at once. 'wx' fails with EEXIST if the file
  // is already there, atomically, so the OS — not a timing accident — decides
  // which process gets which name. (Verified db.backup() writes fine onto a
  // file pre-created this way: SQLite treats a fresh empty file as a blank
  // database to initialize.)
  const base = `pre-${version}`;
  let n = 0;
  let out = path.join(dir, `${base}.db`);
  for (;;) {
    try {
      fs.closeSync(fs.openSync(out, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      out = path.join(dir, `${base}.${++n}.db`);
    }
  }

  // ASYNC — db.backup() returns a Promise. Not awaiting it would start migrations
  // while the copy was still being written, producing a backup of a half-migrated
  // database: the one thing this function exists to prevent.
  await db.backup(out);
  return out;
}

/**
 * Keep the newest `keep` backups. A clinic PC does not have infinite disk.
 * Synchronous on purpose: it runs at boot and deleting a few files is instant.
 */
export function pruneBackups(dir, keep = 3) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')); } catch { return; }
  const byAge = files
    // statSync is guarded per-file, not just the readdirSync above: this runs
    // right after backupBeforeMigrate() logged a successful backup, and the
    // caller's try/catch can't tell "the backup failed" apart from "cleaning
    // up OLD backups failed" — a file vanishing between readdir and stat (a
    // second clinic process pruning at the same moment, or a user manually
    // deleting an old backup) must never be mistaken for the former.
    .map((f) => {
      try { return { f, t: fs.statSync(path.join(dir, f)).mtimeMs }; }
      catch { return null; }
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.t - a.t);
  for (const { f } of byAge.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* a locked file is not worth failing a boot over */ }
  }
}
