// PATIENT_MERGE_BRANCHES_V1 (мигр. 168) — событие «карта слита» едет журналом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';
import { SHIPPED } from '../../services/branch-sync/journal.js';

test('168: событие объединения получает uid, попадает в журнал и едет соседям', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO patient_merges (keep_uid, drop_uid) VALUES ('k1', 'd1')").run();
    const row = db.prepare('SELECT * FROM patient_merges').get();
    assert.match(row.uid, /^[0-9a-f]{32}$/);
    assert.ok(row.merged_at);
    assert.ok(db.prepare("SELECT 1 FROM sync_journal WHERE tbl = 'patient_merges' AND uid = ?").get(row.uid), 'событие в журнале');
    assert.deepEqual(SHIPPED.patient_merges, ['keep_uid', 'drop_uid', 'merged_at']);
    assert.throws(() => db.prepare("INSERT INTO patient_merges (keep_uid, drop_uid) VALUES ('x', 'x')").run(), /CHECK/);
  } finally { db.close(); }
});
