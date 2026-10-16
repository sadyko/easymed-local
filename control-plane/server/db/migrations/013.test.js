import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { createEnrollmentCode } from '../../services/enrollment.js';

// PUBLIC_LICENCE_V1 (step 8c re-check, round 2) — 013_sync_keys_history.sql:
// every sync key a clinic EVER had accepted, never deleted. Re-enrolment clears
// sync_keys_seen of the old install (F3); without this table the "same code as
// a key the clinic used" refusal (F1), blocking a former key by value and its
// code label forgot every key replaced before the re-enrolment.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const X = 'aa'.repeat(16);
const Y = 'bb'.repeat(16);
const Z = 'cc'.repeat(16);

test('013: sync_keys_history — one row per (clinic, key), 32 hex only', () => {
  const db = openDb(':memory:');
  migrate(db);
  const add = (clinic, fp) => db.prepare("INSERT INTO sync_keys_history (clinic_id, fp, first_accepted_at) VALUES (?, ?, '2026-10-16T10:00:00Z')").run(clinic, fp);
  add('c-1', X);
  add('c-2', X);
  assert.throws(() => add('c-1', X), /UNIQUE|PRIMARY/);
  for (const bad of ['AA'.repeat(16), 'aa'.repeat(15), 'zz'.repeat(16)]) assert.throws(() => add('c-1', bad), /CHECK/, bad);
});

test('013: a registry already at 012 keeps what it knew — accepted and replaced keys and the current accepted key go into the history, candidates do not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-mig-013-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of fs.readdirSync(HERE).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f < '013')) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
  const db = openDb(':memory:');
  migrate(db, dir);
  createEnrollmentCode(db, { clinicId: 'c-1', name: 'Клиника' });
  db.prepare("UPDATE clinics SET api_sync_key = ? WHERE clinic_id = 'c-1'").run(X);
  const seen = db.prepare("INSERT INTO sync_keys_seen (clinic_id, fp, first_seen, last_seen, state, state_at) VALUES ('c-1', ?, 't1', 't1', ?, ?)");
  seen.run(Y, 'replaced', '2026-10-01T00:00:00Z');
  seen.run(Z, 'candidate', 't1');
  migrate(db);
  const rows = db.prepare('SELECT clinic_id, fp FROM sync_keys_history ORDER BY fp').all();
  assert.deepEqual(rows, [{ clinic_id: 'c-1', fp: X }, { clinic_id: 'c-1', fp: Y }]);
});
