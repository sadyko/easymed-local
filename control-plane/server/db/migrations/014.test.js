import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

// PUBLIC_LICENCE_V1 (step 8c re-check, round 3) — 014_sync_keys_history_ids.sql:
// the history of accepted keys gets an opaque id (the panel blocks a former key
// by it, never by fingerprint — like candidates, F4) and when each key was last
// accepted and replaced (the card lists former keys with those dates). A
// forward rebuild, not an edit to 013: registries that ran 013 keep their rows.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const X = 'aa'.repeat(16);
const Y = 'bb'.repeat(16);

test('014: sync_keys_history — opaque id, one row per (clinic, key), last_accepted_at and replaced_at', () => {
  const db = openDb(':memory:');
  migrate(db);
  const add = (clinic, fp) => db.prepare(
    "INSERT INTO sync_keys_history (clinic_id, fp, first_accepted_at, last_accepted_at) VALUES (?, ?, '2026-10-16T10:00:00Z', '2026-10-16T10:00:00Z')",
  ).run(clinic, fp);
  assert.equal(add('c-1', X).lastInsertRowid, 1);
  assert.equal(add('c-2', X).lastInsertRowid, 2);
  assert.throws(() => add('c-1', X), /UNIQUE/);
  for (const bad of ['AA'.repeat(16), 'aa'.repeat(15)]) assert.throws(() => add('c-1', bad), /CHECK/, bad);
  const cols = db.prepare('PRAGMA table_info(sync_keys_history)').all().map((c) => c.name);
  assert.deepEqual(cols, ['id', 'clinic_id', 'fp', 'first_accepted_at', 'last_accepted_at', 'replaced_at']);
});

test('014: a registry already at 013 keeps every key; ids follow the old order; last accepted = first accepted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mig-014-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(HERE).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < '014')) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
  const db = openDb(':memory:');
  migrate(db, dir);
  const old = db.prepare('INSERT INTO sync_keys_history (clinic_id, fp, first_accepted_at) VALUES (?, ?, ?)');
  old.run('c-1', Y, '2026-10-01T00:00:00Z');
  old.run('c-1', X, '2026-10-02T00:00:00Z');
  migrate(db);
  assert.deepEqual(db.prepare('SELECT id, clinic_id, fp, first_accepted_at, last_accepted_at, replaced_at FROM sync_keys_history ORDER BY id').all(), [
    { id: 1, clinic_id: 'c-1', fp: Y, first_accepted_at: '2026-10-01T00:00:00Z', last_accepted_at: '2026-10-01T00:00:00Z', replaced_at: null },
    { id: 2, clinic_id: 'c-1', fp: X, first_accepted_at: '2026-10-02T00:00:00Z', last_accepted_at: '2026-10-02T00:00:00Z', replaced_at: null },
  ]);
});
