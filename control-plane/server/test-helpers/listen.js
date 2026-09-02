// FETCH_BAD_PORT_V1 — every route/e2e test does `app.listen(0, host, cb)` to
// get an ephemeral port, then talks to it with `fetch()`. Node's fetch
// (undici) refuses to open a connection to a port on the WHATWG "bad ports"
// blocklist (https://fetch.spec.whatwg.org/#port-blocking), throwing
// `TypeError: fetch failed` / `cause: Error: bad port` before a socket is
// even attempted. This machine's TCP dynamic port range (1024-14999)
// contains 14 of those blocked ports, so roughly 1 in 800 ephemeral-port
// draws is unusable — an intermittent flake, not a real bug in the route
// under test. `listen()` below is the one place that knows about the list:
// it redraws a fresh ephemeral port whenever the OS hands back a blocked
// one, so callers never see the failure.
//
// Not Node-version- or platform-specific: this is the same fixed list on
// every OS and every fetch()-capable runtime (undici ships it verbatim), so
// there is nothing to detect at runtime — it's just data.
export const FETCH_BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
]);

export function isBadPort(port) {
  return FETCH_BAD_PORTS.has(port);
}

// listen(app, { host, attempts }) -> Promise<server>
//
// Calls app.listen(0, host, cb) and resolves with the resulting server once
// its ephemeral port is one fetch() will actually connect to. If the OS
// hands back a blocked port, the (unused, never-connected) server is closed
// and a new ephemeral port is drawn, up to `attempts` times; after that it
// resolves with whatever was last drawn rather than hang forever — a test
// suite should fail loudly on a real bug, not stall in CI.
export function listen(app, { host = '127.0.0.1', attempts = 5 } = {}) {
  return new Promise((resolve) => {
    let left = attempts;

    function draw() {
      const server = app.listen(0, host, () => {
        const port = server.address().port;
        if (isBadPort(port) && left > 0) {
          left -= 1;
          server.close(() => draw());
          return;
        }
        resolve(server);
      });
    }

    draw();
  });
}
