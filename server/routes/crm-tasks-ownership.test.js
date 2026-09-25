// CRM_DEDUP_SEARCH_TASKS_V1 — задачи CRM подчиняются CRM_OWNERSHIP_V1.
//
// Ревью (I1): у crm_tasks не было ограничения по владельцу — оператор Б через
// /api/db читал текст задач по заявке оператора А, отмечал их, переназначал,
// вставлял задачи на чужую заявку и подписывал их чужим именем (done_by /
// created_by приходили с экрана).
//
// Правило (решение): задача видна и правится ТОЛЬКО если видна её заявка —
// то же правило, что у crm_requests (своя или ничья; администратор — всё).
// Задача, назначенная Б на заявке А, Б НЕ видна: владелец сказал про чужие
// заявки «do not show», и задача — часть заявки. Счётчик в меню Б её тоже не
// считает — Б не смог бы её ни открыть, ни закрыть.
// created_by и done_by ставит СЕРВЕР по сессии; присланное экраном отбрасывается.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../services/auth.js';
import { createApp } from '../app.js';
import { licensedDataDir } from '../services/control/licensed-fixture.js';
import { listen } from '../../control-plane/server/test-helpers/listen.js';

async function start() {
  const db = openDb(':memory:');
  migrate(db);
  const u = db.prepare('INSERT INTO users (id, username, password_hash, full_name, role) VALUES (?,?,?,?,?)');
  u.run(21, 'opa', hashPassword('password1'), 'Оператор А', 'callcenter');
  u.run(22, 'opb', hashPassword('password1'), 'Оператор Б', 'callcenter');
  u.run(23, 'boss', hashPassword('password1'), 'Админ', 'admin');
  const lead = db.prepare('INSERT INTO crm_requests (id, full_name, phone, status, assigned_to) VALUES (?,?,?,?,?)');
  lead.run(1, 'Заявка А', '901111111', 'in_process', 21);
  lead.run(2, 'Ничья', '902222222', 'in_process', null);
  lead.run(3, 'Заявка Б', '903333333', 'in_process', 22);
  const t = db.prepare('INSERT INTO crm_tasks (id, request_id, text, due_at, assignee_id) VALUES (?,?,?,?,?)');
  t.run(10, 1, 'Секрет А', '2026-01-01T09:00:00Z', 21);
  t.run(11, 1, 'Задача Б на заявке А', '2026-01-01T09:00:00Z', 22);
  t.run(12, 2, 'На ничьей', '2026-01-01T09:00:00Z', 22);
  t.run(13, 3, 'На своей Б', '2026-01-01T09:00:00Z', 22);
  const server = await listen(createApp(db, { dataDir: licensedDataDir() }));
  return { db, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function login(base, who) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who, password: 'password1' }),
  });
  assert.equal(res.status, 200, 'login ' + who);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
async function dbCall(base, cookie, desc) {
  const res = await fetch(base + '/api/db', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(desc),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const ids = (r) => (r.json.data || []).map((x) => x.id).sort((a, b) => a - b);

// CRM_HEAD_MERGE_TAGS_V1 (ревью M1, 2026-09-25) — ПРАВИЛО УТОЧНЕНО: задача,
// ПОРУЧЕННАЯ Б, видна Б и на заявке А (orOwn: assignee_id). После слияния
// дублей задачи переезжают на карточку, которую может вести другой оператор,
// и поручение не должно пропадать у исполнителя. Чужие задачи на чужой заявке
// (№10) Б по-прежнему не видны, а вставка — только на видимую заявку.
test('чтение: Б видит задачи своих и ничьих заявок и порученные ему; администратор — все', async (t) => {
  const { db, server, base } = await start();
  t.after(() => { server.close(); db.close(); });
  const b = await login(base, 'opb');
  const all = { table: 'crm_tasks', op: 'select', columns: 'id, text', filters: [] };
  assert.deepEqual(ids(await dbCall(base, b, all)), [11, 12, 13], 'Б прочитал чужую задачу заявки А или потерял свою');
  // и по номеру задачи тоже не достать
  const byId = await dbCall(base, b, { ...all, filters: [{ col: 'id', op: 'eq', val: 10 }] });
  assert.deepEqual(byId.json.data, []);
  // счётчик (count) идёт тем же путём
  const cnt = await dbCall(base, b, { ...all, count: 'exact', filters: [{ col: 'assignee_id', op: 'eq', val: 22 }] });
  assert.equal(cnt.json.count, 3, 'в счётчике Б нет задачи, порученной ему на заявке А');
  const boss = await login(base, 'boss');
  assert.deepEqual(ids(await dbCall(base, boss, all)), [10, 11, 12, 13]);
});

test('правка и удаление: чужие задачи Б не отметить, не переназначить; порученную ему — отметить', async (t) => {
  const { db, server, base } = await start();
  t.after(() => { server.close(); db.close(); });
  const b = await login(base, 'opb');
  await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { done_at: '2026-09-23T10:00:00Z', assignee_id: 22 },
    filters: [{ col: 'id', op: 'eq', val: 10 }] });
  assert.equal(db.prepare('SELECT done_at FROM crm_tasks WHERE id = 10').get().done_at, null, 'Б отметил чужую задачу заявки А');
  await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { done_at: '2026-09-23T10:00:00Z' },
    filters: [{ col: 'id', op: 'eq', val: 11 }] });
  assert.ok(db.prepare('SELECT done_at FROM crm_tasks WHERE id = 11').get().done_at, 'Б не смог закрыть порученную ему задачу');
  assert.equal(db.prepare('SELECT assignee_id FROM crm_tasks WHERE id = 10').get().assignee_id, 21, 'Б переназначил задачу А');
  const own = await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { done_at: '2026-09-23T10:00:00Z' },
    filters: [{ col: 'id', op: 'eq', val: 13 }] });
  assert.equal(own.status, 200);
  assert.ok(db.prepare('SELECT done_at FROM crm_tasks WHERE id = 13').get().done_at, 'свою задачу Б отметить не смог');
});

test('вставка: на чужую заявку — 403 и ничего не записано; на свою и ничью — можно', async (t) => {
  const { db, server, base } = await start();
  t.after(() => { server.close(); db.close(); });
  const b = await login(base, 'opb');
  const ins = (rid) => dbCall(base, b, { table: 'crm_tasks', op: 'insert', returning: true, single: 'single',
    values: { request_id: rid, text: 'Новая', due_at: '2026-10-01T09:00:00Z', assignee_id: 22 } });
  const before = db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n;
  const foreign = await ins(1);
  assert.equal(foreign.status, 403, 'вставка на заявку А прошла: ' + JSON.stringify(foreign.json));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, before);
  // пакетом тоже нельзя
  const batch = await dbCall(base, b, { table: 'crm_tasks', op: 'insert',
    values: [{ request_id: 3, text: 'x' }, { request_id: 1, text: 'y' }] });
  assert.equal(batch.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM crm_tasks').get().n, before, 'пакет записался наполовину');
  assert.equal((await ins(2)).status, 200);
  assert.equal((await ins(3)).status, 200);
  // upsert обходил бы ограничение — закрыт
  const up = await dbCall(base, b, { table: 'crm_tasks', op: 'upsert', onConflict: 'id',
    values: { id: 10, request_id: 1, text: 'захват' } });
  assert.equal(up.status, 403);
  assert.equal(db.prepare('SELECT text FROM crm_tasks WHERE id = 10').get().text, 'Секрет А');
});

test('created_by и done_by ставит сервер — подделать нельзя', async (t) => {
  const { db, server, base } = await start();
  t.after(() => { server.close(); db.close(); });
  const b = await login(base, 'opb');
  const r = await dbCall(base, b, { table: 'crm_tasks', op: 'insert', returning: true, single: 'single',
    values: { request_id: 3, text: 'Подпись', created_by: 21, done_by: 21 } });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT created_by, done_by, done_at FROM crm_tasks WHERE id = ?').get(r.json.data.id);
  assert.deepEqual({ ...row }, { created_by: 22, done_by: null, done_at: null });

  await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { done_at: '2026-09-23T10:00:00Z', done_by: 21 },
    filters: [{ col: 'id', op: 'eq', val: 13 }] });
  assert.equal(db.prepare('SELECT done_by FROM crm_tasks WHERE id = 13').get().done_by, 22, 'done_by подделан');
  await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { done_at: null },
    filters: [{ col: 'id', op: 'eq', val: 13 }] });
  assert.deepEqual({ ...db.prepare('SELECT done_at, done_by FROM crm_tasks WHERE id = 13').get() }, { done_at: null, done_by: null });
  // правка текста не трогает done_by
  await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { done_at: '2026-09-23T11:00:00Z' },
    filters: [{ col: 'id', op: 'eq', val: 13 }] });
  await dbCall(base, b, { table: 'crm_tasks', op: 'update', values: { text: 'Поправил' },
    filters: [{ col: 'id', op: 'eq', val: 13 }] });
  assert.equal(db.prepare('SELECT done_by FROM crm_tasks WHERE id = 13').get().done_by, 22);
});
