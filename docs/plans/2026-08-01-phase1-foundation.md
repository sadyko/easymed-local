# Easy-Med Local — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running local server (Node.js + SQLite) that serves the app at `http://<ip>:8000` with working login/logout, session auth, and a user-management screen — plus removal of all landing/SaaS pages.

**Architecture:** One Express process serves static files from `public/` and a JSON API under `/api`. Data lives in `data/easymed.db` (SQLite, WAL). Sessions are rows in SQLite referenced by an HttpOnly cookie. Roles are enforced server-side by route guards. All client URLs are relative — the app never knows or cares about hostnames.

**Tech Stack:** Node.js 24 (ESM, `node:test`, global `fetch`), Express 5, better-sqlite3, bcryptjs. No other dependencies.

**Environment facts:** Windows 10, Node v24.16.0, npm 11.13.0. Dev machine has internet (for `npm install`); the final system must run with none. Project root: `easymed.uz/` (already a git repo, `main` branch).

---

## Target file structure

```
easymed.uz/
  package.json               (new)
  server/
    index.js                 (new — entry point)
    app.js                   (new — Express app factory, testable)
    app.test.js              (new)
    db/
      connection.js          (new)
      migrate.js             (new)
      migrate.test.js        (new)
      migrations/001_init.sql (new)
    middleware/auth.js       (new — cookies, attachUser, guards)
    routes/auth.js           (new)
    routes/users.js          (new)
    services/auth.js         (new — hashing, login, sessions, bootstrap)
    services/auth.test.js    (new)
  public/                    (new — everything the browser loads)
    index.html               (new — LOGIN page, replaces deleted landing)
    users.html               (new — user management screen)
    js/api.js                (new)  js/login.js (new)  js/users.js (new)
    css/local.css            (new)
    admin.html, css/, js/, favicon.svg, icon-*.png, manifest.json, sw.js
                             (moved from root — parked until Phase 2 conversion)
  data/easymed.db            (created at runtime; gitignored)
```

Deleted in this phase: `index.html` (landing), `js/landing.js`, `oferta.html`, `setting.html`, `js/setting/`, `js/clinic-signup.js`, `scripts/devserver.py`.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json` (via npm)
- Modify: `.gitignore`

- [ ] **Step 1: Create package.json and install dependencies**

Run in `easymed.uz/`:
```bash
npm init -y
npm install express better-sqlite3 bcryptjs
```
Expected: `node_modules/` appears, `package-lock.json` created, no build errors (better-sqlite3 downloads a prebuilt binary for Node 24 / win-x64).

- [ ] **Step 2: Edit package.json** — replace its contents with:

```json
{
  "name": "easymed-local",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "bcryptjs": "^3.0.2",
    "better-sqlite3": "^12.2.0",
    "express": "^5.1.0"
  }
}
```
(Keep the actual installed versions npm wrote; only ensure `type`, `scripts`, `private` are as above.)

- [ ] **Step 3: Append to `.gitignore`:**

```
# --- Local runtime state ---
node_modules/
data/
backups/
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold Node project (express, better-sqlite3, bcryptjs)"
```

---

### Task 2: Database connection + migration runner

**Files:**
- Create: `server/db/connection.js`, `server/db/migrate.js`, `server/db/migrations/001_init.sql`
- Test: `server/db/migrate.test.js`

- [ ] **Step 1: Write the failing test** — `server/db/migrate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './connection.js';
import { migrate } from './migrate.js';

test('migrate creates tables and is idempotent', () => {
  const db = openDb(':memory:');
  migrate(db);
  migrate(db); // second run must be a no-op, not an error
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('sessions'));
  assert.ok(tables.includes('schema_migrations'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./connection.js`.

- [ ] **Step 3: Implement** — `server/db/connection.js`:

```js
import Database from 'better-sqlite3';

// One shared connection per process. WAL = many readers + one writer,
// which matches a clinic LAN. foreign_keys is off by default in SQLite.
export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
```

`server/db/migrate.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// Applies every .sql file in migrations/ (sorted by name) that is not yet
// recorded in schema_migrations. Each file runs inside a transaction, so a
// failed migration leaves the database untouched.
export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`);
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
  }
}
```

`server/db/migrations/001_init.sql`:

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'registrar',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add server/db
git commit -m "feat: sqlite connection and auto-migration runner with initial schema"
```

---

### Task 3: Auth service (hashing, login, sessions, first-run admin)

**Files:**
- Create: `server/services/auth.js`
- Test: `server/services/auth.test.js`

- [ ] **Step 1: Write the failing test** — `server/services/auth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin, login, logout, sessionUser, hashPassword } from './auth.js';

function freshDb() { const db = openDb(':memory:'); migrate(db); return db; }

test('bootstrapAdmin creates admin only when there are no users', () => {
  const db = freshDb();
  const pw = bootstrapAdmin(db);
  assert.ok(pw && pw.length >= 10);
  assert.equal(db.prepare('SELECT role FROM users WHERE username = ?').get('admin').role, 'admin');
  assert.equal(bootstrapAdmin(db), null); // second call: users exist, no-op
});

test('login validates password and manages sessions', () => {
  const db = freshDb();
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)')
    .run('anna', hashPassword('secret123'), 'admin');

  assert.equal(login(db, 'anna', 'wrong').error, 'invalid');
  const ok = login(db, 'anna', 'secret123');
  assert.ok(ok.session);
  assert.equal(ok.user.username, 'anna');

  assert.equal(sessionUser(db, ok.session).username, 'anna');
  logout(db, ok.session);
  assert.equal(sessionUser(db, ok.session), null);
  assert.equal(sessionUser(db, null), null);
});

test('inactive users cannot log in', () => {
  const db = freshDb();
  db.prepare('INSERT INTO users (username, password_hash, role, is_active) VALUES (?,?,?,0)')
    .run('gone', hashPassword('secret123'), 'doctor');
  assert.equal(login(db, 'gone', 'secret123').error, 'invalid');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./auth.js`.

- [ ] **Step 3: Implement** — `server/services/auth.js`:

```js
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const SESSION_TTL_HOURS = 12;

// Anti-brute-force: after 5 wrong passwords for a username, refuse logins
// for that username for 5 minutes. In-memory on purpose (resets on restart).
const FAILED_LIMIT = 5;
const LOCK_MS = 5 * 60 * 1000;
const failedAttempts = new Map(); // username -> { count, lockedUntil }

export function hashPassword(pw) {
  return bcrypt.hashSync(String(pw), 10);
}

export function login(db, username, password) {
  const name = String(username || '').trim().toLowerCase();
  const fail = failedAttempts.get(name);
  if (fail && fail.lockedUntil > Date.now()) return { error: 'locked' };

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  const valid = user && user.is_active && bcrypt.compareSync(String(password || ''), user.password_hash);
  if (!valid) {
    const f = failedAttempts.get(name) || { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= FAILED_LIMIT) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
    failedAttempts.set(name, f);
    return { error: 'invalid' };
  }
  failedAttempts.delete(name);

  const sid = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)').run(sid, user.id, expiresAt);
  return { session: sid, user: publicUser(user) };
}

export function logout(db, sid) {
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
}

export function sessionUser(db, sid) {
  if (!sid) return null;
  const row = db.prepare(
    'SELECT u.*, s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
  ).get(sid);
  if (!row) return null;
  if (row.session_expires_at <= new Date().toISOString() || !row.is_active) {
    logout(db, sid);
    return null;
  }
  return publicUser(row);
}

export function publicUser(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, is_active: !!u.is_active };
}

// First run only: create the admin account with a random password and return
// it so index.js can print it to the console. Never a fixed default password.
export function bootstrapAdmin(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return null;
  const password = crypto.randomBytes(9).toString('base64url'); // 12 chars
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('admin', hashPassword(password), 'Administrator', 'admin');
  return password;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/services
git commit -m "feat: auth service - bcrypt login, sqlite sessions, first-run admin bootstrap"
```

---

### Task 4: Middleware (cookies, attachUser, role guards)

**Files:**
- Create: `server/middleware/auth.js`

(No standalone test — `attachUser` is exercised by Task 5's app-level tests;
`requireRole` gets its 401/403 coverage from Task 6's users-API tests.)

- [ ] **Step 1: Implement** — `server/middleware/auth.js`:

```js
import { sessionUser } from '../services/auth.js';

export const SESSION_COOKIE = 'emsid';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Runs on every request: resolves the session cookie to req.user (or null).
export function attachUser(db) {
  return (req, res, next) => {
    req.sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
    req.user = sessionUser(db, req.sessionId);
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Not allowed for your role.' } });
    }
    next();
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add server/middleware
git commit -m "feat: session cookie middleware and role guards"
```

---

### Task 5: Express app factory + auth routes

**Files:**
- Create: `server/app.js`, `server/routes/auth.js`
- Test: `server/app.test.js`

- [ ] **Step 1: Write the failing test** — `server/app.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { hashPassword } from './services/auth.js';
import { createApp } from './app.js';

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = createApp(db).listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base };
}

async function post(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test('health, login flow, session cookie, unknown api route', async () => {
  const { server, base } = startServer();
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);

    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'nope' });
    assert.equal(res.status, 401);

    res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^emsid=/);

    res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.username, 'boss');

    res = await post(base, '/api/auth/logout', {}, cookie);
    assert.equal(res.status, 200);
    res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 401);

    res = await fetch(`${base}/api/no-such-thing`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'not_found');
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `./app.js`.

- [ ] **Step 3: Implement** — `server/routes/auth.js`:

```js
import { Router } from 'express';
import { login, logout, SESSION_TTL_HOURS } from '../services/auth.js';
import { SESSION_COOKIE } from '../middleware/auth.js';

export function authRoutes(db) {
  const r = Router();

  r.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    const result = login(db, username, password);
    if (result.error === 'locked') {
      return res.status(429).json({ error: { code: 'locked', message: 'Too many attempts. Try again in a few minutes.' } });
    }
    if (result.error) {
      return res.status(401).json({ error: { code: 'invalid_credentials', message: 'Wrong username or password.' } });
    }
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${result.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`);
    res.json({ user: result.user });
  });

  r.post('/logout', (req, res) => {
    logout(db, req.sessionId);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: { code: 'unauthorized', message: 'Login required.' } });
    res.json({ user: req.user });
  });

  return r;
}
```

`server/app.js`:

```js
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUser } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser(db));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes(db));

  // Unknown /api paths answer JSON, not an HTML 404 page.
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown API endpoint.' } }));

  // extensions:['html'] gives clean URLs: /users serves public/users.html.
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  // Last resort: never leak stack traces to the browser.
  app.use((err, req, res, next) => {
    console.error('[server error]', err);
    res.status(500).json({ error: { code: 'internal', message: 'Server error.' } });
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add server/app.js server/routes/auth.js server/app.test.js
git commit -m "feat: express app factory with auth routes and json error shape"
```

---

### Task 6: Users API (admin-only management)

**Files:**
- Create: `server/routes/users.js`
- Modify: `server/app.js` (mount route)
- Test: extend `server/app.test.js`

- [ ] **Step 1: Write the failing test** — append to `server/app.test.js`:

```js
test('users API: admin CRUD, role guard, self-protection', async () => {
  const { server, base } = startServer();
  try {
    let res = await post(base, '/api/auth/login', { username: 'boss', password: 'password1' });
    const admin = res.headers.get('set-cookie').split(';')[0];

    // unauthenticated and non-admin are rejected
    assert.equal((await fetch(`${base}/api/users`)).status, 401);

    // create a registrar
    res = await post(base, '/api/users', { username: 'reg1', password: 'password2', full_name: 'Reception One', role: 'registrar' }, admin);
    assert.equal(res.status, 201);
    const reg1 = (await res.json()).user;
    assert.equal(reg1.role, 'registrar');

    // duplicate username rejected
    res = await post(base, '/api/users', { username: 'reg1', password: 'password2', role: 'registrar' }, admin);
    assert.equal(res.status, 400);

    // registrar cannot use the users API
    res = await post(base, '/api/auth/login', { username: 'reg1', password: 'password2' });
    const regCookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: regCookie } })).status, 403);

    // admin can list, edit role, deactivate (which kills sessions)
    res = await fetch(`${base}/api/users`, { headers: { Cookie: admin } });
    assert.equal((await res.json()).users.length, 2);
    res = await fetch(`${base}/api/users/${reg1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(res.status, 200);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: regCookie } })).status, 401);

    // admin cannot deactivate own account
    const meId = (await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: admin } })).json()).user.id;
    res = await fetch(`${base}/api/users/${meId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: admin },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `/api/users` returns 404 (route not mounted yet), asserted 401.

- [ ] **Step 3: Implement** — `server/routes/users.js`:

```js
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { hashPassword, publicUser } from '../services/auth.js';

export const VALID_ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory'];

export function userRoutes(db) {
  const r = Router();
  r.use(requireRole('admin'));

  r.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY username').all();
    res.json({ users: rows.map(publicUser) });
  });

  r.post('/', (req, res) => {
    const { username, password, full_name = '', role } = req.body || {};
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(name)) return bad(res, 'Username must be 3-30 characters: letters, digits, . _ -');
    if (String(password || '').length < 8) return bad(res, 'Password must be at least 8 characters.');
    if (!VALID_ROLES.includes(role)) return bad(res, 'Unknown role.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return bad(res, 'Username already exists.');
    const info = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
      .run(name, hashPassword(password), String(full_name).trim(), role);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)) });
  });

  r.patch('/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: { code: 'not_found', message: 'User not found.' } });
    const { full_name, role, is_active, password } = req.body || {};
    if (role !== undefined && !VALID_ROLES.includes(role)) return bad(res, 'Unknown role.');
    if (password !== undefined && String(password).length < 8) return bad(res, 'Password must be at least 8 characters.');
    if (user.id === req.user.id && (is_active === false || (role !== undefined && role !== 'admin'))) {
      return bad(res, 'You cannot deactivate or demote your own account.');
    }
    db.prepare(`UPDATE users SET
        full_name     = COALESCE(?, full_name),
        role          = COALESCE(?, role),
        is_active     = COALESCE(?, is_active),
        password_hash = COALESCE(?, password_hash),
        updated_at    = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`).run(
      full_name !== undefined ? String(full_name).trim() : null,
      role ?? null,
      is_active === undefined ? null : (is_active ? 1 : 0),
      password !== undefined ? hashPassword(password) : null,
      user.id,
    );
    if (is_active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
  });

  return r;
}

function bad(res, message) {
  return res.status(400).json({ error: { code: 'bad_request', message } });
}
```

- [ ] **Step 4: Mount in `server/app.js`** — add import and route:

```js
import { userRoutes } from './routes/users.js';
```
and after the `authRoutes` line:
```js
  app.use('/api/users', userRoutes(db));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (6 tests total).

- [ ] **Step 6: Commit**

```bash
git add server/routes/users.js server/app.js server/app.test.js
git commit -m "feat: admin-only users API (list, create, update, deactivate)"
```

---

### Task 7: Server entry point

**Files:**
- Create: `server/index.js`

- [ ] **Step 1: Implement** — `server/index.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { bootstrapAdmin } from './services/auth.js';
import { createApp } from './app.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = openDb(path.join(DATA_DIR, 'easymed.db'));
migrate(db);
const firstRunPassword = bootstrapAdmin(db);

// Hourly cleanup of expired sessions; unref so it never blocks shutdown.
setInterval(
  () => db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')").run(),
  3600 * 1000,
).unref();

const PORT = Number(process.env.PORT || 8000);
createApp(db).listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('Easy-Med Local is running.');
  console.log(`  On this PC:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  On the network:  http://${ip}:${PORT}`);
  if (firstRunPassword) {
    console.log('');
    console.log('FIRST RUN - admin account created:');
    console.log('  username: admin');
    console.log(`  password: ${firstRunPassword}`);
    console.log('  Log in and change this password.');
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}
```

- [ ] **Step 2: Verify manually**

Run: `npm start` (leave running), then in another shell: `curl http://localhost:8000/api/health`
Expected: console shows the URLs and the FIRST RUN admin password; curl returns `{"ok":true}`. Stop the server (Ctrl+C). Confirm `data/easymed.db` exists.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: server entry point - migrations, admin bootstrap, LAN listener"
```

---

### Task 8: Delete SaaS pages, move frontend into public/

**Files:**
- Delete: `index.html`, `js/landing.js`, `oferta.html`, `setting.html`, `js/setting/` (whole folder), `js/clinic-signup.js`, `scripts/devserver.py`
- Move: `admin.html`, `css/`, `js/`, `favicon.svg`, `icon-192.png`, `icon-512.png`, `manifest.json`, `sw.js` → `public/`

- [ ] **Step 1: Delete and move (git keeps history)**

```bash
git rm -q index.html oferta.html setting.html js/landing.js js/clinic-signup.js scripts/devserver.py
git rm -rq js/setting
mkdir public
git mv admin.html css js favicon.svg icon-192.png icon-512.png manifest.json sw.js public/
```
Note: `scripts/` may now be empty — that's fine, it will hold start/backup helpers later. If git complains it's empty, remove the folder.

- [ ] **Step 2: Verify nothing else referenced the deleted files**

Run: `grep -rn "landing.js\|clinic-signup\|setting.html\|oferta" public/ server/ --include="*.html" --include="*.js" | grep -v ".git"`
Expected: no hits that would break pages (references inside parked `public/admin.html`-era code are acceptable only if they are to files that still exist; if a `<script>` tag in a *kept* page points to a deleted file, remove that tag).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: remove landing/SaaS pages, move frontend into public/"
```

---

### Task 9: API client + login page

**Files:**
- Create: `public/js/api.js`, `public/js/login.js`, `public/index.html`, `public/css/local.css`

- [ ] **Step 1: Implement** — `public/js/api.js`:

```js
// Easy-Med Local — API client. All URLs are RELATIVE: the app works from any
// IP or hostname it happens to be served on. Never hardcode a host here.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.status === 401 && location.pathname !== '/') {
    // Session gone — return to the login page.
    location.href = '/';
    throw new Error('Login required.');
  }
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
  return data;
}
```

- [ ] **Step 2: Implement** — `public/css/local.css`:

```css
/* Easy-Med Local — shell styles for login + management pages. */
:root {
  --bg: #f1f5f9; --card: #ffffff; --text: #0f172a; --muted: #64748b;
  --primary: #2563eb; --primary-dark: #1d4ed8; --danger: #dc2626;
  --border: #e2e8f0; --radius: 10px;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, "Segoe UI", Roboto, sans-serif;
}
.center-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.card {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 10px 30px rgba(2, 6, 23, .08);
}
.brand { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
.brand span { color: var(--primary); }
.sub { color: var(--muted); margin: 0 0 24px; }
label { display: block; font-weight: 600; font-size: 13px; margin: 14px 0 4px; }
input, select {
  width: 100%; padding: 9px 11px; border: 1px solid var(--border);
  border-radius: 8px; font: inherit; background: #fff;
}
input:focus, select:focus { outline: 2px solid var(--primary); outline-offset: -1px; }
button {
  font: inherit; font-weight: 600; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--primary); color: #fff; padding: 10px 16px;
}
button:hover { background: var(--primary-dark); }
button:disabled { opacity: .6; cursor: default; }
button.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
.error { color: var(--danger); min-height: 20px; margin: 10px 0 0; font-size: 14px; }
.full { width: 100%; margin-top: 20px; }

/* management pages */
.page { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
.topbar { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.topbar .brand { font-size: 18px; margin: 0; flex: 1; }
.topbar .who { color: var(--muted); font-size: 14px; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
th { background: #f8fafc; font-size: 13px; color: var(--muted); }
tr.inactive td { opacity: .5; }
.panel { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-top: 24px; }
.panel h2 { margin: 0 0 12px; font-size: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0 16px; }
```

- [ ] **Step 3: Implement** — `public/index.html` (the login page):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Easy-Med — Login</title>
  <link rel="icon" href="favicon.svg">
  <link rel="stylesheet" href="css/local.css">
</head>
<body>
  <div class="center-screen">
    <form class="card" id="login-form">
      <h1 class="brand">Easy-<span>Med</span></h1>
      <p class="sub">Clinic management system</p>
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <p class="error" id="login-error"></p>
      <button class="full" type="submit">Sign in</button>
    </form>
  </div>
  <script type="module" src="js/login.js"></script>
</body>
</html>
```

`public/js/login.js`:

```js
import { api } from './api.js';

const form = document.getElementById('login-form');
const err = document.getElementById('login-error');

// Already signed in? Go straight to the app.
api('/auth/me').then(() => { location.href = '/users'; }).catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    await api('/auth/login', {
      method: 'POST',
      body: { username: form.username.value, password: form.password.value },
    });
    location.href = '/users';
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});
```

(The post-login destination is `/users` for now — it becomes the dashboard when Phase 2 converts the main app.)

- [ ] **Step 4: Verify manually**

Run: `npm start`, open `http://localhost:8000/` in a browser.
Expected: login card renders; wrong password shows "Wrong username or password."; correct first-run admin password redirects to `/users` (404/blank page for now — built in Task 10).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/js/api.js public/js/login.js public/css/local.css
git commit -m "feat: login page and relative-URL api client"
```

---

### Task 10: User management screen

**Files:**
- Create: `public/users.html`, `public/js/users.js`

- [ ] **Step 1: Implement** — `public/users.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Easy-Med — Users</title>
  <link rel="icon" href="favicon.svg">
  <link rel="stylesheet" href="css/local.css">
</head>
<body>
  <div class="page">
    <div class="topbar">
      <h1 class="brand">Easy-<span>Med</span> · Users</h1>
      <span class="who" id="whoami"></span>
      <button class="ghost" id="logout" type="button">Sign out</button>
    </div>

    <table>
      <thead>
        <tr><th>Username</th><th>Full name</th><th>Role</th><th>Active</th><th></th></tr>
      </thead>
      <tbody id="user-rows"></tbody>
    </table>

    <form class="panel" id="add-form">
      <h2>Add user</h2>
      <div class="grid">
        <div><label for="a-username">Username</label><input id="a-username" name="username" required></div>
        <div><label for="a-fullname">Full name</label><input id="a-fullname" name="full_name"></div>
        <div><label for="a-password">Password (min 8)</label><input id="a-password" name="password" type="password" required minlength="8"></div>
        <div><label for="a-role">Role</label><select id="a-role" name="role"></select></div>
      </div>
      <p class="error" id="add-error"></p>
      <button type="submit">Create user</button>
    </form>
  </div>
  <script type="module" src="js/users.js"></script>
</body>
</html>
```

- [ ] **Step 2: Implement** — `public/js/users.js`:

```js
import { api } from './api.js';

const ROLES = ['admin', 'registrar', 'doctor', 'cashier', 'lab', 'nurse', 'inventory'];
let me = null;

async function boot() {
  try { me = (await api('/auth/me')).user; } catch { return; } // api() redirects to login
  document.getElementById('whoami').textContent = `${me.full_name || me.username} (${me.role})`;
  document.getElementById('logout').addEventListener('click', async () => {
    // Best-effort server-side kill; the navigation must happen even if the
    // server is unreachable (shared clinic PC must never look signed-in).
    try { await api('/auth/logout', { method: 'POST' }); } finally { location.href = '/'; }
  });
  if (me.role !== 'admin') {
    document.querySelector('table').remove();
    document.getElementById('add-form').remove();
    const p = document.createElement('p');
    p.textContent = 'Only administrators can manage users.';
    document.querySelector('.page').append(p);
    return;
  }
  const roleSelect = document.getElementById('a-role');
  for (const r of ROLES) roleSelect.append(new Option(r, r));
  roleSelect.value = 'registrar'; // least-privilege default, not 'admin'
  document.getElementById('add-form').addEventListener('submit', onAdd);
  render();
}

async function render() {
  const { users } = await api('/users');
  const tbody = document.getElementById('user-rows');
  tbody.replaceChildren();
  for (const u of users) {
    const tr = document.createElement('tr');
    if (!u.is_active) tr.classList.add('inactive');
    tr.append(cell(u.username), cell(u.full_name), roleCell(u), activeCell(u), actionsCell(u));
    tbody.append(tr);
  }
}

function cell(text) { const td = document.createElement('td'); td.textContent = text ?? ''; return td; }

function roleCell(u) {
  const td = document.createElement('td');
  const sel = document.createElement('select');
  for (const r of ROLES) sel.append(new Option(r, r, false, r === u.role));
  sel.disabled = u.id === me.id;
  sel.addEventListener('change', () => update(u.id, { role: sel.value }));
  td.append(sel);
  return td;
}

function activeCell(u) {
  const td = document.createElement('td');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!u.is_active;
  box.disabled = u.id === me.id;
  box.addEventListener('change', () => update(u.id, { is_active: box.checked }));
  td.append(box);
  return td;
}

function actionsCell(u) {
  const td = document.createElement('td');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = 'Reset password';
  btn.addEventListener('click', async () => {
    const pw = prompt(`New password for ${u.username} (min 8 characters):`);
    if (pw === null) return;
    await update(u.id, { password: pw });
  });
  td.append(btn);
  return td;
}

async function update(id, patch) {
  try { await api(`/users/${id}`, { method: 'PATCH', body: patch }); }
  catch (e) { alert(e.message); }
  render();
}

async function onAdd(e) {
  e.preventDefault();
  const f = e.target;
  document.getElementById('add-error').textContent = '';
  try {
    await api('/users', {
      method: 'POST',
      body: { username: f.username.value, password: f.password.value, full_name: f.full_name.value, role: f.role.value },
    });
    f.reset();
    render();
  } catch (ex) {
    document.getElementById('add-error').textContent = ex.message;
  }
}

boot();
```

- [ ] **Step 3: Verify manually (full walkthrough)**

Run: `npm start`, open `http://localhost:8000/`:
1. Log in as admin → lands on Users page, sees own row.
2. Create user `reg1` / password / role registrar → appears in table.
3. Open a private/incognito window → log in as `reg1` → sees "Only administrators can manage users."
4. Back as admin: untick `reg1` Active → in the incognito window, any action returns to login.
5. Reset password on `reg1` → log in with the new password works.
6. Sign out → returns to login page.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add public/users.html public/js/users.js
git commit -m "feat: user management screen (list, add, role, active, password reset)"
```

---

### Task 11: Documentation + phase wrap-up

**Files:**
- Modify: `SETUP.md`, `CLAUDE.md`

- [ ] **Step 1: Replace `SETUP.md` contents:**

```markdown
# Easy-Med Local — Setup

Fully local clinic system. No internet is needed to run it.

## Requirements
- Windows PC (the "server PC")
- Node.js 24+ (one-time install)

## First start
Open a terminal in this folder:

    npm install        (first time only, needs internet once)
    npm start

The console prints the addresses and, on the very first run, the generated
admin password:

    Easy-Med Local is running.
      On this PC:      http://localhost:8000
      On the network:  http://192.168.x.x:8000

    FIRST RUN - admin account created:
      username: admin
      password: <generated>

Log in and change the password (Users page → Reset password).
If Windows Firewall asks, click "Allow access" so other clinic PCs can connect.

## Daily use
- Server PC: keep `npm start` running (autostart comes in a later phase).
- Any other PC on the clinic network: open `http://<server-ip>:8000` in a browser.
- All data is in `data/easymed.db`. To back up, stop the server and copy that
  file (automatic backups come in a later phase).

## Tests
    npm test
```

- [ ] **Step 2: Update `CLAUDE.md`** — replace the `## Structure` and `## Current status` sections with:

```markdown
## Current status
- Phase 1 (foundation) DONE: Node/Express/SQLite server, session login,
  user management. Landing/SaaS pages deleted.
- Phase 2 NEXT: convert the parked admin app (public/admin.html + public/js/)
  module by module from Supabase calls to /api calls.

## Structure
- `server/` — Node.js backend: `index.js` (entry), `app.js` (Express factory),
  `db/` (SQLite + migrations), `routes/`, `services/`, `middleware/`
- `public/` — everything the browser loads; `/` = login, `/users` = user management
- `public/admin.html`, `public/js/admin/` — parked old app awaiting conversion
- `data/easymed.db` — the entire clinic dataset (gitignored)
- Design mock-up folders (`Call center/`, `Documents/`, etc.) — reference only
```

- [ ] **Step 3: Final check + commit**

Run: `npm test` (all pass), `npm start` + open `http://localhost:8000` once more.
```bash
git add SETUP.md CLAUDE.md
git commit -m "docs: setup and project notes for Phase 1 foundation"
```

---

## Self-review notes

- Spec coverage (Phase 1 items): server skeleton ✓ (T5, T7), static + health ✓ (T5), DB with migrations ✓ (T2), login/logout/session ✓ (T3, T5, T9), user management ✓ (T6, T10), SaaS/landing deletions ✓ (T8), IP-only relative URLs ✓ (T9 api.js), first-run generated admin password ✓ (T3, T7), sessions survive restart ✓ (SQLite sessions table), error JSON shape ✓ (T5), tests ✓ (T2, T3, T5, T6).
- Deferred by design (later phases): backups, autostart/firewall packaging, font vendoring, i18n on new pages, in-file SaaS excisions inside the parked admin app (gateway/clinic-context/upgrade-modal — Phase 2 conversion).
- Consistency: `SESSION_COOKIE`/`publicUser`/`hashPassword` imported from single sources; ROLES list lives in `server/services/roles.js` (authoritative) and is mirrored in `public/js/users.js`.

## Deferred security notes (from Task 3 quality review — address in later phases)

1. **Password spraying:** ADDRESSED in this phase — a per-IP throttle (10 attempts/min)
   was added in `server/routes/auth.js`, plus every attempt costs ~60ms bcrypt.
2. **Admin lockout recovery:** `bootstrapAdmin` guards on "zero users", not "no active
   admin" — if all admins get deactivated, nobody can log in and a restart won't fix
   it. Add a documented recovery path (e.g. a CLI command) in a later phase.
3. **Statement caching:** `sessionUser` re-prepares its SQL on every request (~44µs).
   Irrelevant at clinic scale; cache prepared statements only if profiling ever says so.
