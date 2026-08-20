// DB_CONSTRAINT_ERRORS_V1 — a constraint violation is the CALLER's problem and
// must say what it was.
//
// The bug this pins: /api/db flattened every SQLite throw into
//   500 { code: 'internal', message: 'Query failed.' }
// so a laborant linking a service already claimed by another panel (migration
// 048 puts a UNIQUE index on lab_panels.service_id) saw «Не удалось сохранить:
// Query failed.» The real reason — «UNIQUE constraint failed:
// lab_panels.service_id» — went only to the server console, where no one on the
// ward is looking. There is no way to act on that, so the linking simply looked
// broken.
//
// A violated constraint is a 409, not a server fault; a genuine internal error
// must still be a 500 with nothing leaked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';

function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('lab1', hashPassword('password1'), 'Сулаймонов Акмал', 'lab');
  db.prepare('INSERT INTO services (name, price, type, is_lab) VALUES (?,?,?,1)').run('Гомоцистеин', 90000, 'lab');
  db.prepare("INSERT INTO lab_panels (name, modality, service_id, active) VALUES ('ГОМОЦИСТЕИН','lab',1,1)").run();
  db.prepare("INSERT INTO lab_panels (name, modality, active) VALUES ('Новая панель','lab',1)").run();
  return new Promise((resolve) => {
    const server = createApp(db).listen(0, '127.0.0.1', () => {
      resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function login(base, who) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function dbCall(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('linking a service another panel already owns answers 409, naming the constraint', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'lab1'), {
    table: 'lab_panels', op: 'update', values: { service_id: 1 },
    filters: [{ col: 'id', op: 'eq', val: 2 }],
  });

  assert.equal(res.status, 409, 'a violated constraint is the caller\'s problem, not a 500: ' + JSON.stringify(res.json));
  assert.equal(res.json.error.code, 'conflict');
  assert.match(res.json.error.message, /lab_panels\.service_id/,
    'the message must name what conflicted so the UI can explain it: ' + res.json.error.message);
  assert.doesNotMatch(res.json.error.message, /Query failed/);
});

// The panel that legitimately owns the service must still be saveable — the new
// branch must not turn an ordinary re-save into an error.
test('re-saving the panel that already owns the service still succeeds', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'lab1'), {
    table: 'lab_panels', op: 'update', values: { service_id: 1, name: 'ГОМОЦИСТЕИН' },
    filters: [{ col: 'id', op: 'eq', val: 1 }],
  });

  assert.equal(res.status, 200, JSON.stringify(res.json));
});

// A NOT NULL violation is a malformed request, not a conflict.
test('a NOT NULL violation answers 400, not 500', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });

  const res = await dbCall(base, await login(base, 'lab1'), {
    table: 'lab_panels', op: 'insert', values: { name: null, modality: 'lab' },
  });

  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal(res.json.error.code, 'bad_request');
});
