// LIS_VENDOR_EXACT_V1 — D2 (обход через /api/db): «Добавить» прибор — только RPC
// lis_device_add, которая без модели не добавляет.
//
// Раунд 1 перевёл «Добавить» найденного прибора на RPC (5eeb196), но реестр
// схемы оставил 'added' среди колонок правки lab_devices: вкладка браузера,
// открытая до обновления (3.16.0 писал {name, added: 1}), или прямой вызов
// /api/db по-прежнему переводили находку без модели в таблицу. Без модели
// BS-240, CL-900i и A1000 читаются общим правилом: номер пробы — OBR-3, а у
// BS-240 и CL-900i там номер прогона прибора — результат ложился не тому
// пациенту (C1-RESULT, «Remaining risks»; ревью A, п. 6; ревью B, п. 6(4)).
//
// Здесь — по настоящему маршруту /api/db, ролью «Лаборатория», формами записи
// самого экрана (views/lab-devices.js): правка, «Добавить по адресу» (с моделью,
// «Другой анализатор (общий HL7)», звонок BC-20), флажки «Включён» и
// «Easy-Med подключается к прибору сам», «Добавить» через RPC — и обход,
// который больше не проходит.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { writableColumns } from '../db/schema-registry.js';

// Тот же текст — у отказа RPC lis_device_add и у экрана: один ключ словаря.
const MODEL_REQUIRED = 'Выберите модель анализатора: без неё Easy-Med прочитает не те поля. Нет в списке — выберите «Другой анализатор (общий HL7)».';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)')
    .run('laborant', hashPassword('password1'), 'Лаборант', 'lab');
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'laborant', password: 'password1' }),
  });
  assert.equal(res.status, 200, 'вход лаборанта');
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function post(base, cookie, path, body) {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const dbCall = (base, cookie, desc) => post(base, cookie, '/api/db', desc);
const update = (base, cookie, id, values) => dbCall(base, cookie, { table: 'lab_devices', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const insert = (base, cookie, values) => dbCall(base, cookie, { table: 'lab_devices', op: 'insert', values });

/** Находка, как её заводит discover.js: BS-240 не назвал модель (MSH-3/4 пустые). */
function foundDevice(db, { host = '192.168.1.61', profile = '' } = {}) {
  return Number(db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added)
                            VALUES (?, ?, 'mllp', ?, 2575, 1, 1, 0)`).run('Прибор ' + host, profile, host).lastInsertRowid);
}
const row = (db, id) => db.prepare('SELECT name, profile, transport, host, port, enabled, dial, added, model_confirmed, discovered FROM lab_devices WHERE id = ?').get(id);
const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM lab_devices').get().n;

test('D2: реестр — «Добавить» не пишется правкой (added нет в update); «общий HL7» — колонкой вставки', () => {
  assert.ok(!writableColumns('lab_devices', 'update').includes('added'), 'added ставит только RPC lis_device_add');
  assert.ok(writableColumns('lab_devices', 'insert').includes('model_confirmed'), '«Добавить по адресу» с «общим HL7» — одной записью');
  assert.ok(!writableColumns('lab_devices', 'insert').includes('added'), 'вставка человеком — всегда added = 1 (умолчание мигр. 228)');
  for (const op of ['insert', 'update']) assert.ok(!writableColumns('lab_devices', op).includes('discovered'), 'discovered — правило приёма: ' + op);
});

test('D2: {added: 1} через /api/db отклоняется — находка без модели остаётся находкой', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  const id = foundDevice(db);

  // Прямой вызов: только added.
  const bare = await update(base, cookie, id, { added: 1 });
  assert.equal(bare.status, 400, 'отказ: ' + JSON.stringify(bare.json));
  assert.equal(row(db, id).added, 0, 'находка не добавлена');

  // Старая вкладка (3.16.0 openAdopt): {name, added: 1} — имя правится, добавления нет.
  const old = await update(base, cookie, id, { name: 'Биохимия', added: 1 });
  assert.equal(old.status, 200, JSON.stringify(old.json));
  assert.deepEqual([row(db, id).name, row(db, id).added], ['Биохимия', 0], 'added из старой вкладки не записан');

  // И вместе с отметкой «модель проверена» — тоже нет.
  await update(base, cookie, id, { added: 1, model_confirmed: 1 });
  assert.equal(row(db, id).added, 0);
});

test('D2: «Добавить» — только RPC lis_device_add: без модели отказ, с моделью добавлен', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  const id = foundDevice(db);

  const refused = await post(base, cookie, '/api/rpc/lis_device_add', { id, name: 'Биохимия' });
  assert.equal(refused.status, 400, JSON.stringify(refused.json));
  assert.equal(refused.json.error.code, 'model_required');
  assert.equal(row(db, id).added, 0);

  const ok = await post(base, cookie, '/api/rpc/lis_device_add', { id, name: 'Биохимия', profile: 'mindray-bs-240' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(
    (({ name, profile, added, model_confirmed }) => ({ name, profile, added, model_confirmed }))(row(db, id)),
    { name: 'Биохимия', profile: 'mindray-bs-240', added: 1, model_confirmed: 1 });
});

test('D2: «Добавить по адресу» без модели через /api/db отклоняется — строка без модели не появляется', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  const before = count(db);

  // Форма 3.16.0 с пунктом «модель не выбрана» или прямой вызов: модель пустая, выбора нет.
  const bare = await insert(base, cookie, { name: 'Иммунология', profile: '', transport: 'mllp', host: '192.168.1.62', port: 2575, enabled: 1, dial: 0 });
  assert.equal(bare.status, 400, JSON.stringify(bare.json));
  assert.equal(bare.json.error.message, MODEL_REQUIRED, 'отказ словами экрана');
  // «Общий HL7» без самого выбора (model_confirmed = 0) — тоже не выбор.
  const zero = await insert(base, cookie, { name: 'Иммунология', profile: '', transport: 'mllp', host: '192.168.1.62', port: 2575, enabled: 1, dial: 0, model_confirmed: 0 });
  assert.equal(zero.status, 403, JSON.stringify(zero));
  assert.match(zero.json.error.message, /model_confirmed/);
  assert.equal(count(db), before, 'в базу ничего');
});

test('D2: экран пишет как прежде — «Добавить по адресу» с моделью, с «общим HL7» одной записью, BC-20 со звонком', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);

  // Модель выбрана (lab-devices.js openForm → save, новый прибор).
  const bs = await insert(base, cookie, { name: 'Биохимия', profile: 'mindray-bs-240', transport: 'mllp', host: '192.168.1.61', port: 2575, enabled: 1, dial: 0 });
  assert.equal(bs.status, 200, JSON.stringify(bs.json));
  const bsRow = db.prepare("SELECT * FROM lab_devices WHERE name = 'Биохимия'").get();
  assert.deepEqual([bsRow.profile, bsRow.added, bsRow.model_confirmed, bsRow.discovered], ['mindray-bs-240', 1, 0, 0]);

  // «Другой анализатор (общий HL7)» — модель пустая, выбор человека — в той же записи.
  const gen = await insert(base, cookie, { name: 'Иммунология', profile: '', transport: 'mllp', host: '192.168.1.62', port: 2575, enabled: 1, dial: 0, model_confirmed: 1 });
  assert.equal(gen.status, 200, JSON.stringify(gen.json));
  const genRow = db.prepare("SELECT * FROM lab_devices WHERE name = 'Иммунология'").get();
  assert.deepEqual([genRow.profile, genRow.added, genRow.model_confirmed], ['', 1, 1], 'выбор «общего HL7» запомнен одной записью');

  // BC-20: Easy-Med подключается к прибору сам (dial), порт прибора 5100.
  const bc = await insert(base, cookie, { name: 'BC-20', profile: 'mindray-bc-20', transport: 'mllp', host: '192.168.1.50', port: 5100, enabled: 1, dial: 1 });
  assert.equal(bc.status, 200, JSON.stringify(bc.json));
  const bcRow = db.prepare("SELECT * FROM lab_devices WHERE name = 'BC-20'").get();
  assert.deepEqual([bcRow.profile, bcRow.port, bcRow.dial, bcRow.added], ['mindray-bc-20', 5100, 1, 1]);
});

test('D2: «Изменить» и флажки «Включён», «Easy-Med подключается к прибору сам» пишутся как прежде', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const cookie = await login(base);
  const id = Number(db.prepare(`INSERT INTO lab_devices (name, profile, transport, host, port, enabled, discovered, added, model_confirmed, last_seen_at)
                                VALUES ('Гематология', 'mindray-bc-5300', 'mllp', '192.168.1.70', 2575, 1, 1, 1, 1, '2026-10-06T08:00:00Z')`).run().lastInsertRowid);

  // Полная форма «Изменить» (payload экрана): выключить прибор, сменить адрес.
  const off = await update(base, cookie, id, { name: 'Гематология 2', profile: 'mindray-bc-5300', transport: 'mllp', host: '192.168.1.71', port: 2575, enabled: 0, dial: 0, model_confirmed: 1 });
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.deepEqual((({ name, host, enabled, added, model_confirmed }) => ({ name, host, enabled, added, model_confirmed }))(row(db, id)),
    { name: 'Гематология 2', host: '192.168.1.71', enabled: 0, added: 1, model_confirmed: 1 });

  // Снова включить и отметить «Easy-Med подключается к прибору сам».
  const on = await update(base, cookie, id, { name: 'Гематология 2', profile: 'mindray-bc-5300', transport: 'mllp', host: '192.168.1.71', port: 5100, enabled: 1, dial: 1 });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.deepEqual([row(db, id).enabled, row(db, id).dial, row(db, id).port, row(db, id).added], [1, 1, 5100, 1]);

  // «Другой анализатор (общий HL7)» в «Изменить» и обратно «модель не выбрана» (решение C1 — законная правка).
  await update(base, cookie, id, { name: 'Гематология 2', profile: '', transport: 'mllp', host: '192.168.1.71', port: 5100, enabled: 1, dial: 1, model_confirmed: 1 });
  assert.deepEqual([row(db, id).profile, row(db, id).model_confirmed, row(db, id).added], ['', 1, 1]);
  await update(base, cookie, id, { name: 'Гематология 2', profile: '', transport: 'mllp', host: '192.168.1.71', port: 5100, enabled: 1, dial: 1, model_confirmed: 0 });
  assert.deepEqual([row(db, id).model_confirmed, row(db, id).added], [0, 1], 'правка не снимает «добавлен»');
});
