import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// PUBLIC_LICENCE_V1 (step 8c review) — 012_sync_keys_seen.sql: every online-
// booking key a clinic's install has presented, one row per key. Its own
// migration, not an edit to 011: migrate() records migrations by FILE NAME, so
// a registry that already ran 011_public_api.sql would never have seen a table
// appended to that file (re-check F6: check-ins with a key, enrolment and the
// clinic page then failed with "no such table").

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FP = 'ab'.repeat(16);
const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('012: sync_keys_seen — an opaque id per row, one row per (clinic, key), 32 hex only, three states', () => {
  const db = freshDb();
  const add = (clinic, fp, state = 'candidate') => db.prepare(
    "INSERT INTO sync_keys_seen (clinic_id, fp, first_seen, last_seen, state, state_at) VALUES (?, ?, '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z', ?, '2026-10-12T10:00:00Z')",
  ).run(clinic, fp, state);
  const first = add('c-1', FP);
  add('c-2', FP, 'accepted');
  add('c-1', 'cd'.repeat(16), 'replaced');
  assert.equal(typeof first.lastInsertRowid, 'number');
  assert.throws(() => add('c-1', FP), /UNIQUE/);
  for (const [fp, state] of [['AB'.repeat(16), 'candidate'], ['ab'.repeat(15), 'candidate'], ['zz'.repeat(16), 'candidate'], ['ef'.repeat(16), 'new']]) {
    assert.throws(() => add('c-1', fp, state), /CHECK/, fp + ' ' + state);
  }
  assert.deepEqual(db.prepare('SELECT id FROM sync_keys_seen ORDER BY id').all().map((r) => r.id), [1, 2, 3]);
});

test('012: a registry that already ran 011_public_api.sql (before this table existed) gets it on the next migrate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mig-012-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(HERE).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < '012')) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
  const db = openDb(':memory:');
  migrate(db, dir);
  assert.equal(hasTable(db, 'revocations'), true, '011 applied');
  assert.equal(hasTable(db, 'sync_keys_seen'), false);
  migrate(db);
  assert.equal(hasTable(db, 'sync_keys_seen'), true);
});

test('011 is back to what registries already ran — sync_keys_seen is not in it', () => {
  assert.doesNotMatch(fs.readFileSync(path.join(HERE, '011_public_api.sql'), 'utf8'), /sync_keys_seen/);
});
