// DOCTOR_PROFILE_V1 — «Виды консультаций» через /api/db: длительность 5..480
// минут, «для партнёров» — initial / repeat / пусто, и одно значение — у одного
// вида. Отказ называет поле.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { CONSULT_MESSAGES } from '../../public/js/shared/consultation-price.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)').run('boss', hashPassword('password1'), 'Boss', 'admin');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, stop() { server.close(); db.close(); } };
}
async function loginAs(base) {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'boss', password: 'password1' }) });
  return res.headers.get('set-cookie').split(';')[0];
}
const post = (base, cookie, body) => fetch(base + '/api/db', { method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });

test('длительность и вид для партнёров проверяются; одно значение — у одного вида; свой — не занят', async () => {
  const t = await startServer();
  try {
    const cookie = await loginAs(t.base);
    const a = t.db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Первичный приём', 100000)").run().lastInsertRowid;
    const b = t.db.prepare("INSERT INTO consultation_types (name, price) VALUES ('Повторный приём', 60000)").run().lastInsertRowid;
    const upd = (id, values) => post(t.base, cookie, { table: 'consultation_types', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
    let res = await upd(a, { duration_minutes: 4 });
    assert.equal(res.status, 400);
    let j = await res.json();
    assert.deepEqual([j.error.field, j.error.message], ['duration_minutes', CONSULT_MESSAGES.minutes]);
    res = await upd(a, { api_kind: 'first' });
    assert.equal(res.status, 400);
    res = await upd(a, { duration_minutes: 45, api_kind: 'initial' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    res = await upd(b, { api_kind: 'initial' });
    assert.equal(res.status, 409);
    j = await res.json();
    assert.deepEqual([j.error.field, j.error.message], ['api_kind', CONSULT_MESSAGES.kindTaken]);
    res = await upd(a, { api_kind: 'initial', name_en: 'Initial visit' });
    assert.equal(res.status, 200, 'свой же вид — не занят');
    res = await post(t.base, cookie, { table: 'consultation_types', op: 'insert', values: { name: 'Ещё первичный', api_kind: 'initial' } });
    assert.equal(res.status, 409, 'вставка проверяется так же');
    res = await upd(b, { api_kind: 'repeat' });
    assert.equal(res.status, 200);
    assert.deepEqual(t.db.prepare('SELECT api_kind FROM consultation_types WHERE id IN (?, ?) ORDER BY id').all(a, b).map((r) => r.api_kind), ['initial', 'repeat']);
  } finally { t.stop(); }
});
