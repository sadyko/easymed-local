import test from 'node:test';
import assert from 'node:assert/strict';
import { listen, isBadPort, FETCH_BAD_PORTS } from './listen.js';

test('isBadPort: matches the WHATWG bad-port list fetch() enforces', () => {
  assert.equal(isBadPort(6000), true);   // X11 — on the list, and inside this machine's dynamic range
  assert.equal(isBadPort(59999), false); // ordinary ephemeral port — not on the list
});

// Regression guard: 4190 and 6679 are real entries in undici's own blocklist
// (confirmed by probing live fetch() against every port 1-15000) but were
// missing from FETCH_BAD_PORTS here — isBadPort() said they were fine, so
// listen() never redrew one, and whichever test's fetch() next happened to
// hit that port died with "bad port", often nowhere near the test whose
// listen() actually drew it. Both are inside this machine's dynamic range.
test('isBadPort: 4190 and 6679 are on the real blocklist too — a past gap in this hand-kept copy', () => {
  assert.equal(isBadPort(4190), true);
  assert.equal(isBadPort(6679), true);
});

test('FETCH_BAD_PORTS: exported set backs isBadPort, not a separate copy', () => {
  assert.equal(FETCH_BAD_PORTS.has(6000), true);
  assert.equal(FETCH_BAD_PORTS.has(59999), false);
});

// A minimal stand-in for the real app/http.Server pair: each call to
// listen(port, host, cb) hands back the next server in `ports` and records
// close() calls so the test can assert the blocked server was actually torn
// down. cb fires on a later microtask, same as a real listener's
// 'listening' event — never synchronously within the listen() call itself,
// which is what lets callers assign `const server = app.listen(..., cb)`
// and have `server` already bound by the time cb runs.
function fakeApp(ports) {
  const closed = [];
  let draws = 0;
  const servers = ports.map((port, i) => ({
    address: () => ({ port }),
    close: (cb) => { closed.push(i); if (cb) cb(); },
  }));
  return {
    servers,
    closed,
    listen(_port, _host, cb) {
      const server = servers[draws];
      draws += 1;
      queueMicrotask(cb);
      return server;
    },
  };
}

test('listen(): redraws once when the first port is blocked, closing the bad server', async () => {
  const app = fakeApp([6000, 59999]);
  const server = await listen(app);
  assert.equal(server, app.servers[1]);
  assert.equal(server.address().port, 59999);
  assert.deepEqual(app.closed, [0]);
});

test('listen(): attempts: 0 resolves the first draw even if it is blocked', async () => {
  const app = fakeApp([6000, 59999]);
  const server = await listen(app, { attempts: 0 });
  assert.equal(server, app.servers[0]);
  assert.equal(server.address().port, 6000);
  assert.deepEqual(app.closed, []);
});
