// V3120_FIX — a new migration must never land BELOW what clinics already ran.
//
// migrate() applies every file not yet in schema_migrations, sorted by name.
// A file numbered 150 that appears after a release that already shipped 189
// still runs at the clinic — but AFTER 151..189, against a schema it was not
// written for. Two machines claiming the same number and one being renumbered
// "down into a gap" is exactly how that happens (docs: migration number
// collisions). This gate compares the working tree against the previous
// release tag: every file the tag did not have must be numbered above the
// tag's highest.
//
// Skipped (not failed) when git or the tag is unavailable — the shallow CI
// checkout has no tags; the release workflow checks out full history, so the
// gate does run where it matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lateMigrations } from './migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIR = path.join(HERE, 'migrations');
const num = (f) => Number(f.slice(0, f.indexOf('_')));

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function previousReleaseMigrations() {
  let tag;
  try { tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD']); } catch { return null; }
  if (!tag) return null;
  let listing;
  try { listing = git(['ls-tree', '--name-only', tag, 'server/db/migrations/']); } catch { return null; }
  const files = listing.split(/\r?\n/).map((p) => path.posix.basename(p)).filter((f) => /^\d{3,}_.*\.sql$/.test(f));
  return { tag, files };
}

test('no new migration is numbered at or below the previous release\'s highest', (t) => {
  const prev = previousReleaseMigrations();
  if (!prev || !prev.files.length) { t.skip('no release tag reachable (shallow checkout?)'); return; }
  const shipped = new Set(prev.files);
  const maxShipped = Math.max(...prev.files.map(num));
  const current = fs.readdirSync(DIR).filter((f) => /^\d{3,}_.*\.sql$/.test(f));
  const offenders = current.filter((f) => !shipped.has(f) && num(f) <= maxShipped);
  assert.deepEqual(offenders, [],
    `these migrations are new since ${prev.tag} but numbered <= ${maxShipped}, so clinics would run them out of order — renumber them above ${maxShipped}: ${offenders.join(', ')}`);
});

test('lateMigrations: flags only pending files below the highest applied number', () => {
  const files = ['001_a.sql', '058_x.sql', '058_y.sql', '150_late.sql', '189_top.sql', '190_new.sql'];
  const applied = new Set(['001_a.sql', '058_x.sql', '058_y.sql', '189_top.sql']);
  assert.deepEqual(lateMigrations(files, applied), [{ file: '150_late.sql', maxApplied: 189 }]);
});

test('lateMigrations: a fresh database has nothing late', () => {
  assert.deepEqual(lateMigrations(['001_a.sql', '002_b.sql'], new Set()), []);
});
