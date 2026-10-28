// CALL_RING_V1 (2026-10-17) — прямой приём событий станции на клинике: секрет
// адреса, модуль колл-центра, JSON и form, предел тела.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';
import { ringWebhook } from './ring-webhook.js';
import { liveCalls, resetLive } from './live.js';

const TOKEN = 'f'.repeat(32);
async function stand({ token = TOKEN, control = { has: (k) => k === 'callcenter' } } = {}) {
  resetLive();
  const db = openDb(':memory:');
  migrate(db);
  db.prepare('UPDATE telephony_settings SET ring_token = ? WHERE id = 1').run(token);
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Каримова Азиза', '+998 90 111 22 33')").run();
  const app = express();
  app.use((req, res, next) => { req.control = control; next(); });
  app.use('/api/telephony/pbx', ringWebhook(db));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}/api/telephony/pbx/`;
  const post = (tok, body, type = 'application/json') => fetch(base + tok, { method: 'POST', headers: { 'Content-Type': type }, body });
  return { db, post, close: () => new Promise((r) => server.close(r)) };
}
const EV = { event: 'call_start', direction: 'inbound', uuid: 'u-1', caller: '998901112233', callee: '101', date: 1792220400 };

test('чужой или пустой секрет — неразличимый 404; верный — событие в живом состоянии с именем пациента', async () => {
  const s = await stand();
  try {
    assert.equal((await s.post('0'.repeat(32), JSON.stringify(EV))).status, 404);
    assert.equal((await s.post('', JSON.stringify(EV))).status, 404);
    assert.equal((await fetch(s.post.base || 'http://127.0.0.1:1/', { method: 'GET' }).catch(() => ({ status: 404 }))).status, 404);
    const ok = await s.post(TOKEN, JSON.stringify(EV));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    const [c] = liveCalls();
    assert.equal(c.caller, '998901112233');
    assert.equal(c.patient.full_name, 'Каримова Азиза');
  } finally { await s.close(); }
});

test('form-urlencoded тело читается так же; непонятное событие — 200 и ничего в состоянии', async () => {
  const s = await stand();
  try {
    const form = 'event=call_start&direction=inbound&uuid=u-2&caller=998935550112&callee=102&date=1792220400';
    assert.equal((await s.post(TOKEN, form, 'application/x-www-form-urlencoded')).status, 200);
    assert.equal(liveCalls()[0].uuid, 'u-2');
    assert.equal((await s.post(TOKEN, JSON.stringify({ event: 'weird', uuid: 'u-3' }))).status, 200);
    assert.equal(liveCalls().length, 1);
  } finally { await s.close(); }
});

test('модуль колл-центра не куплен — 404; пустой секрет в настройках — 404 на любой адрес', async () => {
  const s = await stand({ control: { has: () => false } });
  try { assert.equal((await s.post(TOKEN, JSON.stringify(EV))).status, 404); } finally { await s.close(); }
  const t = await stand({ token: '' });
  try { assert.equal((await t.post('', JSON.stringify(EV))).status, 404); assert.equal((await t.post('x', JSON.stringify(EV))).status, 404); } finally { await t.close(); }
});

// FIX_318_V1 (C6) — огромная дата роняла разбор (RangeError) мимо try — станция
// получала 404 на верный адрес; «call_missed» угадывался как «звонит».
test('FIX_318_V1: дата вне диапазона — 200 и звонок со временем приёма; call_missed — 200 и ничего в состоянии', async () => {
  const s = await stand();
  try {
    const big = await s.post(TOKEN, JSON.stringify({ ...EV, uuid: 'u-9', date: 1e20 }));
    assert.equal(big.status, 200);
    assert.equal(liveCalls()[0].uuid, 'u-9');
    assert.equal((await s.post(TOKEN, JSON.stringify({ ...EV, uuid: 'u-10', event: 'call_missed' }))).status, 200);
    assert.deepEqual(liveCalls().map((c) => c.uuid), ['u-9'], 'call_missed показан звонящим');
  } finally { await s.close(); }
});

test('тело больше 16 КБ — 413, не 500', async () => {
  const s = await stand();
  try {
    const big = JSON.stringify({ ...EV, pad: 'x'.repeat(20000) });
    assert.equal((await s.post(TOKEN, big)).status, 413);
  } finally { await s.close(); }
});
