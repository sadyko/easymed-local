// CLINIC_API_STEP7_V1 — ключи через настоящее приложение: значение уходит
// только в своих ответах администратору — ни в список, ни в журнал, ни в
// console, ни в ops_events, ни в саму базу; /api/db таблиц подключений не знает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const add = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  add.run('boss', hashPassword('password1'), 'Босс', 'admin');
  add.run('reg', hashPassword('password2'), 'Регистратор', 'registrar');
  db.prepare(`UPDATE doc_settings SET clinic_name = 'Шифо', region_code = 'tashkent-city', district_code = 'yunusobod',
    street_ru = 'ул. Мира, 1' WHERE id = 1`).run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, p, body, cookie) => fetch(base + p, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body || {}) });
async function login(base, username, password) {
  const res = await post(base, '/api/auth/login', { username, password });
  return res.headers.get('set-cookie').split(';')[0];
}

test('ключ и секрет — только в своих ответах администратору; нигде больше', async () => {
  const t = await startServer();
  const logs = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error']) {
    orig[m] = console[m];
    console[m] = (...a) => { logs.push(a.map(String).join(' ')); orig[m].apply(console, a); };
  }
  try {
    const boss = await login(t.base, 'boss', 'password1');
    const rpc = async (name, body) => { const r = await post(t.base, '/api/rpc/' + name, body, boss); return { status: r.status, json: await r.json() }; };
    assert.equal((await rpc('api_slug_save', { slug: 'shifo' })).status, 200);
    const draft = (await rpc('api_connection_draft', {})).json.data;
    const created = (await rpc('api_connection_create', { draft_id: draft.draft_id, kind: 'partner', name: 'med24.uz',
      scopes: ['clinic', 'doctors', 'services', 'slots', 'requests', 'appointments'],
      webhook_url: 'https://med24.uz/hooks', webhook_events: ['request.accepted'] })).json.data;
    const K = created.key;
    const S = created.secret;
    assert.match(K, /^em_live_/);
    const id = created.connection.id;
    const list = JSON.stringify((await rpc('api_settings_get', {})).json);
    assert.equal((await rpc('api_connection_reveal', { id, what: 'key' })).json.data.value, K);
    const K2 = (await rpc('api_connection_regenerate', { id, what: 'key', confirm: true })).json.data.value;
    assert.notEqual(K2, K);
    assert.equal((await rpc('api_connection_reveal', { id: 999, what: 'key' })).status, 404);
    const journal = JSON.stringify((await rpc('api_journal_list', {})).json);
    const places = {
      'список': list, 'журнал': journal, 'console': logs.join('\n'),
      'ops_events': JSON.stringify(t.db.prepare('SELECT * FROM ops_events').all()),
      'база': t.db.serialize().toString('latin1'),
    };
    for (const v of [K, K2, S]) for (const [where, hay] of Object.entries(places)) assert.ok(!hay.includes(v), 'значение просочилось: ' + where);
  } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
    t.server.close();
  }
});

test('/api/db не знает таблиц подключений — даже администратору; регистратор без права — 403 на чтение RPC', async () => {
  const t = await startServer();
  try {
    const boss = await login(t.base, 'boss', 'password1');
    for (const table of ['api_connections', 'api_settings', 'api_journal']) {
      const r = await post(t.base, '/api/db', { table, op: 'select', columns: '*' }, boss);
      assert.ok(r.status >= 400 && r.status < 500, table + ': ' + r.status);
    }
    const reg = await login(t.base, 'reg', 'password2');
    assert.equal((await post(t.base, '/api/rpc/api_settings_get', {}, reg)).status, 403);
  } finally { t.server.close(); }
});
