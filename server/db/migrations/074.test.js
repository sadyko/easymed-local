import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../connection.js';
import { migrate } from '../migrate.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('074 ops_events inserts land with a default timestamp', () => {
  const db = fresh();
  db.prepare("INSERT INTO ops_events (kind) VALUES ('boot')").run();
  const row = db.prepare('SELECT * FROM ops_events').get();
  assert.equal(row.kind, 'boot');
  assert.ok(row.at, 'at defaults to now, without the caller supplying one');
  assert.equal(row.route, null);
});

test('074 accepts every kind the plan defines', () => {
  const db = fresh();
  for (const kind of ['server_error', 'slow_request', 'failed_login', 'boot']) {
    assert.doesNotThrow(
      () => db.prepare('INSERT INTO ops_events (kind) VALUES (?)').run(kind),
      `${kind} should be a valid kind`
    );
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 4);
});

test('074 the CHECK constraint refuses a kind outside that fixed vocabulary', () => {
  const db = fresh();
  assert.throws(
    () => db.prepare("INSERT INTO ops_events (kind) VALUES ('patient_deleted')").run(),
    /CHECK constraint failed/,
    'a made-up kind must be rejected at insert time, not merely by convention'
  );
});

test('074 route stores a path template when one is given', () => {
  const db = fresh();
  db.prepare("INSERT INTO ops_events (kind, route) VALUES ('server_error', '/api/patients/:id')").run();
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, '/api/patients/:id');
});

test('074 no other column exists — the no-free-text rule is load-bearing, pin it', () => {
  const db = fresh();
  const cols = db.prepare('PRAGMA table_info(ops_events)').all().map((c) => c.name).sort();
  // Exactly id/kind/route/at. In particular no message/details/payload/body
  // column — that is the entire point of this table: there must be nowhere
  // for a constraint-violation error message (which can echo a patient name)
  // to land.
  assert.deepEqual(cols, ['at', 'id', 'kind', 'route'].sort());
});

test('074 has an index on (kind, at) for the counters that will scan by kind and recency', () => {
  const db = fresh();
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ops_events'").all();
  assert.ok(idx.some((i) => i.name === 'ops_events_kind_at'), 'expected ops_events_kind_at to exist');
});
