import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { recordEvent, pruneOpsEvents } from './ops-log.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('recordEvent inserts a row of the given kind', () => {
  const db = freshDb();
  recordEvent(db, 'boot');
  const row = db.prepare('SELECT * FROM ops_events').get();
  assert.equal(row.kind, 'boot');
  assert.equal(row.route, null);
});

test('recordEvent keeps a route that looks like a path template', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', '/api/patients/:id');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, '/api/patients/:id');
});

test('recordEvent keeps an rpc-style route (letters, digits, underscore, colon)', () => {
  const db = freshDb();
  recordEvent(db, 'slow_request', '/api/rpc/run_report_v2');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, '/api/rpc/run_report_v2');
});

// --- sanitisation: the defence-in-depth regex, both directions ------------

test('recordEvent nulls out a route carrying a query string — a caller mistake passing req.url instead of req.route.path', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', '/api/patients/42?name=Ivanov+Petrov');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

test('recordEvent nulls out a route containing free text (spaces, a name)', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', '/api/patients/Ivanov Petrov');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

test('recordEvent nulls out a route with a non-ASCII (e.g. Cyrillic) patient name in it', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', '/api/patients/Иванов');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

test('recordEvent nulls out a full URL (scheme/host), not just a path', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', 'http://example.com/api/x');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

test('recordEvent nulls out a route over 120 characters', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', '/' + 'a'.repeat(120));
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

test('recordEvent nulls out a non-string route (e.g. undefined slipping through as a literal)', () => {
  const db = freshDb();
  recordEvent(db, 'server_error', undefined);
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

test('recordEvent treats "no route" as null with no route argument at all', () => {
  const db = freshDb();
  recordEvent(db, 'boot');
  assert.equal(db.prepare('SELECT route FROM ops_events').get().route, null);
});

// --- recordEvent can NEVER throw -------------------------------------------

test('recordEvent does not throw on a closed database handle', () => {
  const db = freshDb();
  db.close();
  assert.doesNotThrow(() => recordEvent(db, 'boot'));
});

test('recordEvent does not throw against a database that has no ops_events table yet (pre-migration)', () => {
  const db = openDb(':memory:'); // migrate() deliberately not called
  assert.doesNotThrow(() => recordEvent(db, 'boot'));
});

test('recordEvent does not throw when handed a garbage db argument', () => {
  assert.doesNotThrow(() => recordEvent(null, 'boot'));
  assert.doesNotThrow(() => recordEvent(undefined, 'boot'));
  assert.doesNotThrow(() => recordEvent({}, 'boot'));
});

test('recordEvent does not throw on an unknown kind (lets the CHECK constraint fail silently)', () => {
  // Defence in depth: even if a future caller passes a typo'd kind, the write
  // side must not be the thing that crashes the request.
  const db = freshDb();
  assert.doesNotThrow(() => recordEvent(db, 'not_a_real_kind'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 0, 'the bad row must not have landed either');
});

// --- pruneOpsEvents ----------------------------------------------------------

test('pruneOpsEvents deletes rows older than the window and keeps recent ones', () => {
  const db = freshDb();
  db.prepare("INSERT INTO ops_events (kind, at) VALUES ('boot', strftime('%Y-%m-%dT%H:%M:%SZ','now','-20 days'))").run();
  db.prepare("INSERT INTO ops_events (kind, at) VALUES ('boot', strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 days'))").run();
  pruneOpsEvents(db, 14);
  const rows = db.prepare('SELECT * FROM ops_events').all();
  assert.equal(rows.length, 1, 'only the 1-day-old row should survive a 14-day prune');
});

test('pruneOpsEvents defaults to a 14 day window', () => {
  const db = freshDb();
  db.prepare("INSERT INTO ops_events (kind, at) VALUES ('boot', strftime('%Y-%m-%dT%H:%M:%SZ','now','-15 days'))").run();
  pruneOpsEvents(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops_events').get().n, 0);
});

test('pruneOpsEvents does not throw on a closed database handle', () => {
  const db = freshDb();
  db.close();
  assert.doesNotThrow(() => pruneOpsEvents(db));
});

test('pruneOpsEvents does not throw against a database with no ops_events table', () => {
  const db = openDb(':memory:');
  assert.doesNotThrow(() => pruneOpsEvents(db));
});
