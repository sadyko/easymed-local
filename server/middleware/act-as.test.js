// ADMIN_ACT_AS_V1 (2026-10-28) — ЖУРНАЛ ДЕЙСТВИЙ ОТ ИМЕНИ: И ФАЙЛЫ ТОЖЕ.
//
// Задача 1 писала в журнал записи /api/db, все RPC и записи /api/users. Но у
// программы есть второй путь записи — /api/storage: фото пациента, сканы
// документов, вложения Telegram, логотип. Загрузка и удаление файла от имени
// сотрудника — такое же действие, как строка в таблице, и в журнал оно обязано
// попасть (вид storage, «МЕТОД /storage/корзина»). Путь объекта в журнал НЕ
// идёт: в имени файла пациента бывает его номер, а журнал хранит только имена
// таблиц, RPC и корзин. Чтение файла — не действие, как и чтение строки.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actAsEntry } from './act-as.js';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

const req = (method, url, body) => ({ method, originalUrl: url, url, body });

test('actAsEntry: загрузка и удаление файла — вид storage, «МЕТОД /storage/корзина», без пути объекта', () => {
  assert.deepEqual(actAsEntry(req('POST', '/api/storage/clinic-docs/patients/17/scan.pdf')),
    { kind: 'storage', name: 'POST /storage/clinic-docs' });
  assert.deepEqual(actAsEntry(req('DELETE', '/api/storage/telegram-media/2026/10/a.jpg?x=1')),
    { kind: 'storage', name: 'DELETE /storage/telegram-media' });
  assert.deepEqual(actAsEntry(req('PUT', '/api/storage/patient-photos/p1.jpg')),
    { kind: 'storage', name: 'PUT /storage/patient-photos' });
  // Чтение файла — не действие.
  assert.equal(actAsEntry(req('GET', '/api/storage/clinic-docs/misc/a.pdf')), null);
  assert.equal(actAsEntry(req('HEAD', '/api/storage/clinic-docs/misc/a.pdf')), null);
  // Странное имя корзины чистится тем же правилом, что имя таблицы.
  assert.deepEqual(actAsEntry(req('POST', '/api/storage/clinic<docs>/x')), { kind: 'storage', name: 'POST /storage/clinicdocs' });
  // Прежние виды не изменились.
  assert.deepEqual(actAsEntry(req('POST', '/api/db', { table: 'visits', op: 'update' })), { kind: 'db', name: 'visits.update' });
  assert.equal(actAsEntry(req('POST', '/api/db', { table: 'visits', op: 'select' })), null);
  assert.deepEqual(actAsEntry(req('POST', '/api/rpc/procedures_list')), { kind: 'rpc', name: 'procedures_list' });
  assert.deepEqual(actAsEntry(req('PATCH', '/api/users/4')), { kind: 'users', name: 'PATCH /users/4' });
  assert.equal(actAsEntry(req('GET', '/api/users')), null);
});

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare(`INSERT INTO users (id, username, password_hash, full_name, role, extra_roles, is_active, must_change_password)
                        VALUES (?,?,?,?,?,?,?,?)`);
  const pw = hashPassword('password1');
  u.run(1, 'boss', pw, 'Петров П.', 'admin', '[]', 1, 0);
  u.run(4, 'nurse', pw, 'Медсестра Н.', 'nurse', '[]', 1, 0);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  server.unref();   // упавшая проверка не вешает прогон (см. slow-log.test.js)
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход ' + username);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

test('журнал: загрузка и удаление файла от имени — строки storage с кодом ответа; чтение — нет; после возврата — ничего', async () => {
  const { db, server, base } = await startServer();
  try {
    const boss = await login(base, 'boss');
    const start = await fetch(base + '/api/auth/act-as', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: boss }, body: JSON.stringify({ user_id: 4 }),
    });
    assert.equal(start.status, 200);
    const actAsId = db.prepare('SELECT act_as_id FROM sessions WHERE user_id = 1 AND act_as_id IS NOT NULL').get().act_as_id;

    const up = await fetch(base + '/api/storage/clinic-docs/misc/act-as-probe.pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Cookie: boss }, body: Buffer.from('%PDF-1.4 probe'),
    });
    await up.arrayBuffer();
    const read = await fetch(base + '/api/storage/clinic-docs/misc/act-as-probe.pdf', { headers: { Cookie: boss } });
    await read.arrayBuffer();
    const del = await fetch(base + '/api/storage/clinic-docs/misc/act-as-probe.pdf', { method: 'DELETE', headers: { Cookie: boss } });
    await del.arrayBuffer();

    const rows = db.prepare('SELECT kind, name, status FROM act_as_actions WHERE act_as_id = ? ORDER BY id').all(actAsId);
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { kind: 'storage', name: 'POST /storage/clinic-docs', status: up.status },
      { kind: 'storage', name: 'DELETE /storage/clinic-docs', status: del.status },
    ]);
    assert.doesNotMatch(JSON.stringify(rows), /act-as-probe|misc/, 'путь объекта в журнал не попадает');

    // Возврат — дальше файлы от своего имени, журнал не пишется.
    await fetch(base + '/api/auth/act-as', { method: 'DELETE', headers: { Cookie: boss } });
    const after = await fetch(base + '/api/storage/clinic-docs/misc/act-as-probe-2.pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', Cookie: boss }, body: Buffer.from('%PDF-1.4 probe'),
    });
    await after.arrayBuffer();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM act_as_actions').get().n, 2);
  } finally { server.close(); }
});
