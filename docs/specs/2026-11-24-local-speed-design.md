# LOCAL_SPEED_V1 — Easy-Med Local opens fast: the browser keeps the code, the server stops re-doing work, and the slow log names the culprit

Date: 2026-11-24. Branch: `perf/local-speed` (from main 0d140df8). No migration.

## Owner request

> there is computer with 8 gb of operation memory and 512 ssd … its opens slow in the users computers like 2000ms or 812 ms and 200ms
> can we make tier caching or optimizing the request times for better speed in the local version?

Photos of the clinic's Easy-Med console (v3.27.0, the day after the update) show `[slow]` lines: JS files answered **304 in 267 ms … 3 221 ms** and **200 in 2 – 5 s**; data requests `POST /` 1 – 5.4 s; many lines finish within 1 – 5 ms of each other (1308/1309 ms, 267–271 ms, 3218–3223 ms) — the single Node thread is stalled and everyone waits in line.

## Facts measured on :8000 (dev box, fast CPU, NVMe)

- `admin.html` pulls **381 ES modules + 3 css (385 requests), 14.8 MB JS raw / 4.2 MB gzip**; longest import chain 12; only 6 modules lazy.
- NO_STALE_CODE_V1: html/js/css are `Cache-Control: no-cache` → **every open re-asks all 385** (304s).
- Every request — also a 304 or a 404 for a static file — runs the global `attachUser` and `attachControl`. `controlState()` = readFileSync control.json + licence.dat + Ed25519 verify + clock write = **1.15 ms per call** (0.68 ms is the two file reads). Static 304 costs **1.46 ms** vs `/api/health` **0.21 ms**. One open ≈ **0.55 s of serial main-thread work** with zero network. A slow CPU + antivirus (scans each file open) + 15 staff multiply it; after an update every PC downloads everything at once.
- `compress()` gzips every response again (async zlib, thread pool): the same 15 MB is recompressed for every PC after every update.
- `slowLog` label bug: at `finish` Express has stripped the mount path, so `/api/db` logs as `POST /` and `/api/rpc/x` as `POST /x` — the photos cannot tell which table/RPC is heavy. It also cannot tell the request that **caused** a stall from the ones that **waited** behind it.

## Design — three tiers, like a CDN's tiered cache, but inside the clinic

### Tier 1 — every staff browser keeps the code until the next update (versioned addresses)

- At startup the server computes `BUILD_ID` = short content hash (sha1, 10 hex) of every file under `public/` it serves as code or style (`js/`, `css/`, `fonts/`, plus top-level `*.js|*.css|*.svg`). Content, not mtime: an update that keeps sizes/mtimes must still change the id.
- New route **`GET /v/:build/*`** serves the same file as `/*` from `public/`:
  - `:build === BUILD_ID` → `Cache-Control: public, max-age=31536000, immutable` (+ ETag).
  - any other build (a tab opened before an update) → serve the CURRENT file with `no-cache` (never 404: an open tab doing a lazy `import()` must keep working, exactly as today; never immutable under a stale id).
  - Only for files that exist; path traversal impossible (reuse `express.static` / `send` with `root`).
- `admin.html`, `index.html`, `users.html` are served by a handler (still `no-cache`) that rewrites their own references `src="js/…"` / `href="css/…"` / `favicon.svg` to `/v/<BUILD_ID>/…` and drops the old `?v=…` suffix. Everything inside the modules is relative, so it inherits the `/v/<BUILD_ID>/` prefix by itself (`import.meta.url`-based font URLs too).
- The one absolute import (`import('/js/vendor/fflate.js')` in `views/section-import-export.js`) becomes relative. Guard test: no JS under `public/js` imports/fetches an absolute `/js/` or `/css/` path.
- Old addresses `/js/...` keep working exactly as today (`no-cache`) — print windows, bookmarks, the login page of an un-updated tab.
- Dev: `EASYMED_STATIC_IMMUTABLE=0` turns the immutable header off (still `/v/` addresses). Default on.
- Result: a normal open = `admin.html` (304) + data requests. **Zero** code requests until the next update; after an update each PC downloads the new 4.4 MB once.

### Tier 2 — the server keeps what it already computed

- **Static files skip the per-request licence + session work.** `attachUser` / `actAsEndedGuard` / `attachControl` run only for `/api/*` (test `req.path` at the global level — do NOT mount on `/api`, mount-stripping would break `LIVE_PATH` and other `req.path` checks). Static files never read `req.user`/`req.control`. `slowLog` may then print no `user=` for static lines — fine.
- **`controlState` cache**: the file part (read control.json + licence.dat, parse, verify) is cached keyed by both files' `(mtimeMs, size)` from `fs.statSync`; the db part (`effectiveNow`, `clockAnomaly`, `extensionUntil`) still runs every call (≈0.03 ms). Writers (`enroll.js`, `checkin.js`) call an exported `invalidateControlCache()` after writing, belt and braces. Behaviour must be byte-identical to today for every existing control/licence test.
- **Compressed static cache**: gzip of a static js/css/svg/html body is kept in memory keyed by `(absolute path, mtimeMs, size)` (LRU or plain Map; whole app ≈ 4.5 MB). A hit sends the cached gzip with the same headers `compress()` would set. API responses are not cached.

### Tier 3 — the database answers only real data; the log names what is slow

- `slowLog` labels from `req.originalUrl` (path only, never the query string): `rpc <name>` / `db <table>` (table from the body as today).
- New `[busy]` line: the `/api/db` route and the RPC dispatcher time the **synchronous** part of the handler (hrtime around the call) and log `[busy] 4800ms rpc <name>` / `db <table> <op>` when it exceeds `EASYMED_BUSY_MS` (default 150). This is the request that froze the server; the `[slow]` lines around it are the ones that waited.
- New `[stall]` line: a 200 ms `setInterval` drift check (unref'd) logs `[stall] 4700ms` when the event loop was blocked > 1 000 ms, plus the label of the last `[busy]` candidate that started before it. Off with `EASYMED_SLOW_MS=0`.
- No patient data, no query strings, no bodies in any line (same rule as today: RPC name / table name / op only).

## Out of scope (next step, after the new log names them)

Fixing specific heavy data requests (indexes, limits, caching `clinic_news_list`/`telegram_chats_list`/`meta_inbox_*` polling), lazy-loading views, bundling.

## Tests

- `/v/:build/*`: current build → immutable + same bytes as `/*`; other build → no-cache + current bytes; traversal → 404; missing file → 404; HTML rewrite of the three pages (references point to `/v/<id>/`, no `?v=` left, CSP unchanged); `BUILD_ID` changes when a file's content changes (same size, same mtime).
- Guard: no absolute `/js/`|`/css/` import/fetch/Worker in `public/js`.
- Static request runs no `controlState` / `sessionUser` (spy/counter); `/api` still does; `LIVE_PATH` background detection unchanged.
- `controlState` cache: second call reads no file; changing either file (mtime/size) or `invalidateControlCache()` re-reads; every existing control/licence/gate test unchanged.
- Gzip cache: second request of the same file does not call zlib; file change → recompressed; headers identical to the uncached path (Content-Encoding, Vary, ETag, Content-Length).
- slowLog label: `/api/db` → `db <table>`, `/api/rpc/x` → `rpc x`; `[busy]` fires for a slow sync handler and not for a fast one; nothing from the body except the table name.
- Before/after measurement with `scratchpad/perf/load.mjs` (385-request open) reported in the commit.
