// CRM_MULTI_SOURCE_V1 (2026-09-29) — ИСТОЧНИКИ ЗАЯВКИ ЧЕРЕЗ ЕДИНСТВЕННУЮ ДВЕРЬ /api/db.
//
// У заявки несколько источников (crm_requests.sources, миграция 231), главный
// source — всегда первый. Держит это СЕРВЕР, а не экран:
//   • пишут sources — он проверяет его и сам ставит source = sources[0];
//   • пишут один source (старый экран, соседи) — sources становится [source],
//     чтобы два поля не разошлись;
//   • кривой sources — 400 словами, база не тронута;
//   • скрытый в настройках источник новой заявке не ставится, но у заявки,
//     где он уже стоит, остаётся;
//   • права — те же, что у source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';
import { leadSources } from '../../public/js/admin/crm-sources.js';

async function startServer() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)');
  u.run('operator', hashPassword('password1'), 'Оператор', 'callcenter');
  u.run('reg', hashPassword('password1'), 'Регистратура', 'registrar');
  u.run('doc', hashPassword('password1'), 'Врач', 'doctor');
  // «Telegram» клиника скрыла в настройках: новым заявкам его не предлагают.
  db.prepare("UPDATE crm_sources SET is_active = 0 WHERE key = 'telegram'").run();
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, who) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200, `login as ${who} failed`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function dbCall(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const insert = (values) => ({ table: 'crm_requests', op: 'insert', returning: true, single: 'single',
  values: { full_name: 'Каримова Азиза', phone: '+998901112233', status: 'in_process', ...values } });
const update = (id, values) => ({ table: 'crm_requests', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: id }] });
const row = (db, id) => db.prepare('SELECT source, sources FROM crm_requests WHERE id = ?').get(id);

test('sources пишется, а главный source ставит сервер — первым ключом (вставка и правка)', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const op = await login(base, 'operator');

  const ins = await dbCall(base, op, insert({ sources: ['instagram', 'referral'] }));
  assert.equal(ins.status, 200, JSON.stringify(ins.json));
  const id = ins.json.data.id;
  assert.deepEqual(row(db, id), { source: 'instagram', sources: '["instagram","referral"]' });
  assert.equal(ins.json.data.source, 'instagram');
  assert.deepEqual(leadSources(ins.json.data), ['instagram', 'referral'], 'ответ вставки читается правилом чтения');

  // Присланный source, не совпадающий с первым ключом, сервер поправляет сам.
  const upd = await dbCall(base, op, update(id, { source: 'call', sources: ['referral', 'call'] }));
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.deepEqual(row(db, id), { source: 'referral', sources: '["referral","call"]' });

  // Чтение через /api/db — массив, а не строка (колонка JSON в реестре).
  const sel = await dbCall(base, op, { table: 'crm_requests', op: 'select', columns: '*', filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.deepEqual(sel.json.data[0].sources, ['referral', 'call']);
});

test('запись одного source (старый экран, соседи) сбрасывает sources в [source]', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const reg = await login(base, 'reg');
  const id = (await dbCall(base, reg, insert({ sources: ['instagram', 'referral'] }))).json.data.id;
  const r = await dbCall(base, reg, update(id, { source: 'website' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(row(db, id), { source: 'website', sources: '["website"]' });
  // Вставка только с source — тоже с массивом (два поля не расходятся с рождения).
  const id2 = (await dbCall(base, reg, insert({ source: 'call' }))).json.data.id;
  assert.deepEqual(row(db, id2), { source: 'call', sources: '["call"]' });
  // Правка, где источника нет вовсе, sources не трогает.
  await dbCall(base, reg, update(id, { note: 'перезвонить' }));
  assert.deepEqual(row(db, id), { source: 'website', sources: '["website"]' });
});

test('кривой sources — 400 словами, база не тронута', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const op = await login(base, 'operator');
  const id = (await dbCall(base, op, insert({ sources: ['call'] }))).json.data.id;
  const eleven = ['call', 'instagram', 'website', 'walk_in', 'referral', 'other', 'telephony', 'a1', 'a2', 'a3', 'a4'];
  const cases = [
    [[], /хотя бы один источник/],
    [['nope'], /Источника «nope» нет в справочнике/],
    [['call', 'instagram', 'call'], /«call» указан дважды/],
    [eleven, /не больше 10 источников/],
    ['call', /список ключей/],
    [[5], /список ключей/],
    [null, /список ключей/],
    [['call', ''], /список ключей/],
  ];
  const before = db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n;
  for (const [sources, re] of cases) {
    const u = await dbCall(base, op, update(id, { sources }));
    assert.equal(u.status, 400, 'правка ' + JSON.stringify(sources) + ' прошла: ' + JSON.stringify(u.json));
    assert.match(u.json.error.message, re);
    const i = await dbCall(base, op, insert({ sources }));
    assert.equal(i.status, 400, 'вставка ' + JSON.stringify(sources) + ' прошла');
  }
  assert.deepEqual(row(db, id), { source: 'call', sources: '["call"]' }, 'отказ всё-таки записал');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_requests').get().n, before, 'отказанная вставка завела заявку');
  // Шаблон для перевода едет рядом с фразой (экран переводит собранные фразы по нему).
  const d = await dbCall(base, op, update(id, { sources: ['call', 'call'] }));
  assert.equal(d.json.error.template, 'Источник «{key}» указан дважды.');
  assert.deepEqual(d.json.error.params, { key: 'call' });
});

test('скрытый источник: новой заявке — нет; заявке, где он уже стоит, — остаётся', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const op = await login(base, 'operator');
  const hidden = await dbCall(base, op, insert({ sources: ['call', 'telegram'] }));
  assert.equal(hidden.status, 400);
  assert.match(hidden.json.error.message, /«Telegram» скрыт в настройках/);

  const id = (await dbCall(base, op, insert({ sources: ['call'] }))).json.data.id;
  const add = await dbCall(base, op, update(id, { sources: ['call', 'telegram'] }));
  assert.equal(add.status, 400, 'скрытый источник поставлен заявке, где его не было');

  // Заявка, у которой Telegram стоял до того, как его скрыли.
  db.prepare("UPDATE crm_requests SET sources = '[\"telegram\",\"call\"]', source = 'telegram' WHERE id = ?").run(id);
  const keep = await dbCall(base, op, update(id, { sources: ['call', 'telegram', 'instagram'] }));
  assert.equal(keep.status, 200, JSON.stringify(keep.json));
  assert.deepEqual(row(db, id), { source: 'call', sources: '["call","telegram","instagram"]' });
  // Старая заявка, где Telegram был только главным source (sources пуст), — тоже «уже стоит».
  const old = Number(db.prepare("INSERT INTO crm_requests (full_name, phone, source) VALUES ('Старая', '+998907778899', 'telegram')").run().lastInsertRowid);
  const oldUpd = await dbCall(base, op, update(old, { sources: ['telegram', 'referral'] }));
  assert.equal(oldUpd.status, 200, JSON.stringify(oldUpd.json));
});

test('пакетная вставка: каждая строка проверена и получила главный source', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const reg = await login(base, 'reg');
  const ok = await dbCall(base, reg, { table: 'crm_requests', op: 'insert', values: [
    { full_name: 'А', phone: '+998901000001', sources: ['website', 'call'] },
    { full_name: 'Б', phone: '+998901000002', source: 'instagram' },
  ] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(db.prepare("SELECT full_name, source, sources FROM crm_requests WHERE full_name IN ('А','Б') ORDER BY full_name").all(), [
    { full_name: 'А', source: 'website', sources: '["website","call"]' },
    { full_name: 'Б', source: 'instagram', sources: '["instagram"]' },
  ]);
  const bad = await dbCall(base, reg, { table: 'crm_requests', op: 'insert', values: [
    { full_name: 'В', phone: '+998901000003', sources: ['call'] },
    { full_name: 'Г', phone: '+998901000004', sources: [] },
  ] });
  assert.equal(bad.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM crm_requests WHERE full_name IN ('В','Г')").get().n, 0, 'пакет записан наполовину');
});

test('права — как у source: колл-центр и регистратура пишут, врач только читает', async (t) => {
  const { db, server, base } = await startServer();
  t.after(() => { server.close(); db.close(); });
  const reg = await login(base, 'reg');
  const doc = await login(base, 'doc');
  const id = (await dbCall(base, reg, insert({ sources: ['instagram', 'referral'] }))).json.data.id;
  const ins = await dbCall(base, doc, insert({ sources: ['call'] }));
  assert.equal(ins.status, 403, 'врач завёл заявку');
  const upd = await dbCall(base, doc, update(id, { sources: ['call'] }));
  assert.equal(upd.status, 403, 'врач поменял источники');
  assert.deepEqual(row(db, id), { source: 'instagram', sources: '["instagram","referral"]' });
  const sel = await dbCall(base, doc, { table: 'crm_requests', op: 'select', columns: 'id,source,sources', filters: [{ col: 'id', op: 'eq', val: id }] });
  assert.equal(sel.status, 200);
  assert.deepEqual(sel.json.data[0].sources, ['instagram', 'referral']);
});
