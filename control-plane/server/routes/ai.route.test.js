import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { openDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { aiRoutes, AI_MOUNT } from './ai.js';
import { createApp } from '../app.js';
import { listen } from '../test-helpers/listen.js';

// AI_CHAT_V1 — POST /cp/v1/ai/chat-reply. Клиника предъявляет install_token в
// заголовке X-Install-Token; Claude здесь всегда подменён (callClaude из deps).

const MARKER = 'MARKER-AI-TEXT-1';

function seed({ module = true, limit = 20, spent = 0, subscription = 'active', until = null, active = 1 } = {}) {
  const db = openDb(':memory:'); migrate(db);
  db.prepare(`INSERT INTO clinics (clinic_id, name, unlock_secret, install_token, ai_monthly_limit_usd, subscription, subscription_until, active)
              VALUES ('c1','A','s','tok',?,?,?,?)`).run(limit, subscription, until, active);
  if (module) db.prepare("INSERT INTO clinic_modules (clinic_id, module_key) VALUES ('c1','ai')").run();
  const month = new Date().toISOString().slice(0, 7);
  if (spent) db.prepare('INSERT INTO ai_usage (clinic_id, month, cost_micro_usd) VALUES (?,?,?)').run('c1', month, spent);
  const calls = [];
  const callClaude = async (p) => { calls.push(p); return { result: { outcome: 'reply', text: 'ok' }, usage: { input_tokens: 100, output_tokens: 10 } }; };
  return { db, calls, callClaude, month };
}

// Отдельное приложение БЕЗ общего разборщика JSON — как в app.js, где ручка
// стоит выше app.use('/cp', express.json(...)).
async function world(opts) {
  const w = seed(opts);
  const app = express();
  app.use(AI_MOUNT, aiRoutes(w.db, { callClaude: w.callClaude }));
  w.server = await listen(app);
  return w;
}

async function post(server, body, token = 'tok') {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-Install-Token'] = token;
  const r = await fetch(`http://127.0.0.1:${server.address().port}${AI_MOUNT}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}
const P = { channel: 'telegram', transcript: [{ from: 'patient', text: MARKER }], facts: {} };

test('AI_MOUNT — тот же путь, что у клиники (cp-client.js AI_PATH)', async () => {
  const { AI_PATH } = await import('../../../server/services/ai/cp-client.js');
  assert.equal(AI_MOUNT, AI_PATH);
});

test('ответ и учёт расхода; текст переписки не сохраняется', async (t) => {
  const w = await world(); t.after(() => w.server.close());
  const r = await post(w.server, P);
  assert.deepEqual(r, { status: 200, body: { outcome: 'reply', text: 'ok' } });
  const u = w.db.prepare('SELECT requests, input_tokens, output_tokens, cost_micro_usd FROM ai_usage WHERE clinic_id = ?').get('c1');
  assert.deepEqual(u, { requests: 1, input_tokens: 100, output_tokens: 10, cost_micro_usd: 100 * 4 + 10 * 20 });
  await post(w.server, P);
  assert.equal(w.db.prepare('SELECT requests FROM ai_usage WHERE clinic_id = ?').get('c1').requests, 2, 'второй запрос того же месяца — в ту же строку');
  const dump = JSON.stringify(w.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((tb) => w.db.prepare(`SELECT * FROM "${tb.name}"`).all()));
  assert.ok(!dump.includes(MARKER), 'текст переписки не лёг в базу');
});

test('Claude получает очищенную переписку: не больше 20 реплик, from только patient/clinic', async (t) => {
  const w = await world(); t.after(() => w.server.close());
  const transcript = Array.from({ length: 25 }, (_, i) => ({ from: i % 2 ? 'operator' : 'patient', text: `m${i}`, extra: 'x' }));
  transcript[24].text = 'я'.repeat(5000);
  await post(w.server, { channel: 'meta_comment', transcript, patient_name: 'Ali', post_text: 'Пост', facts: { services: [] } });
  const p = w.calls[0];
  assert.equal(p.channel, 'meta_comment');
  assert.equal(p.transcript.length, 20);
  assert.ok(p.transcript.every((m) => Object.keys(m).sort().join() === 'from,text' && (m.from === 'patient' || m.from === 'clinic')));
  assert.equal(p.transcript[19].text.length, 2000);
  assert.deepEqual(p.facts, { services: [] });
  assert.equal(p.patient_name, 'Ali');
});

test('чужой токен — 401; токен в теле, а не в заголовке — 401; выведенная клиника — 401', async (t) => {
  const a = await world(); t.after(() => a.server.close());
  assert.equal((await post(a.server, P, 'nope')).status, 401);
  assert.equal((await post(a.server, { install_token: 'tok', ...P }, null)).status, 401);
  const b = await world({ active: 0 }); t.after(() => b.server.close());
  assert.equal((await post(b.server, P)).status, 401);
  assert.equal(a.calls.length + b.calls.length, 0, 'Claude не вызывался');
});

test('нет модуля — 402 no_module; лимит — 402 limit', async (t) => {
  const b = await world({ module: false }); t.after(() => b.server.close());
  assert.deepEqual(await post(b.server, P), { status: 402, body: { error: { code: 'no_module' } } });
  const c = await world({ limit: 1, spent: 1_000_000 }); t.after(() => c.server.close());
  assert.deepEqual(await post(c.server, P), { status: 402, body: { error: { code: 'limit' } } });
  assert.equal(b.calls.length + c.calls.length, 0, 'Claude не вызывался');
});

test('A9: подписка не оплачена или истекла — 402 no_module, даже с модулем ai', async (t) => {
  const u = await world({ subscription: 'unpaid' }); t.after(() => u.server.close());
  assert.deepEqual(await post(u.server, P), { status: 402, body: { error: { code: 'no_module' } } });
  const e = await world({ until: '2020-01-01' }); t.after(() => e.server.close());
  assert.deepEqual(await post(e.server, P), { status: 402, body: { error: { code: 'no_module' } } });
  const ok = await world({ until: '2999-12-31' }); t.after(() => ok.server.close());
  assert.equal((await post(ok.server, P)).status, 200);
  assert.equal(u.calls.length + e.calls.length, 0);
});

test('филиал пользуется модулем ai своей главной клиники', async (t) => {
  const w = seed({ module: false });
  w.db.prepare("INSERT INTO clinics (clinic_id, name, unlock_secret) VALUES ('main','M','s')").run();
  w.db.prepare("INSERT INTO clinic_modules (clinic_id, module_key) VALUES ('main','ai')").run();
  w.db.prepare("UPDATE clinics SET parent_clinic_id = 'main' WHERE clinic_id = 'c1'").run();
  const app = express();
  app.use(AI_MOUNT, aiRoutes(w.db, { callClaude: w.callClaude }));
  const server = await listen(app); t.after(() => server.close());
  assert.equal((await post(server, P)).status, 200);
  assert.ok(w.db.prepare("SELECT 1 FROM ai_usage WHERE clinic_id = 'c1'").get(), 'расход — на филиал');
});

test('через createApp: токен проверяется ДО разбора тела; тело больше 100 КБ проходит, больше 1 МБ — 413', async (t) => {
  const w = seed();
  const server = await listen(createApp(w.db, { ai: { callClaude: w.callClaude } })); t.after(() => server.close());
  const big = (n) => ({ ...P, facts: { pad: 'x'.repeat(Math.min(n, 200_000)) }, post_text: 'y'.repeat(Math.max(0, n - 200_000)) });
  // Чужой токен с телом в 2 МБ — 401, а не 413: тело даже не читалось.
  assert.equal((await post(server, big(2_000_000), 'nope')).status, 401);
  // 300 КБ больше общего лимита /cp (100 КБ), но в пределах своего 1 МБ.
  assert.deepEqual(await post(server, big(300_000)), { status: 200, body: { outcome: 'reply', text: 'ok' } });
  assert.equal((await post(server, big(2_000_000))).status, 413);
  // Битый JSON — 400 от общего обработчика ошибок, Claude не вызывается.
  assert.equal((await post(server, '{not json')).status, 400);
  assert.equal(w.calls.length, 1);
});

test('сбой Claude (например, 401 у Anthropic) — клинике 503 upstream, расход не пишется, текст не в логе', async (t) => {
  const w = seed();
  const app = express();
  const boom = async () => { const e = new Error(`401 ${MARKER}`); e.status = 401; e.error = { type: 'error', error: { type: 'authentication_error' } }; throw e; };
  app.use(AI_MOUNT, aiRoutes(w.db, { callClaude: boom }));
  const server = await listen(app); t.after(() => server.close());
  const logged = [];
  const orig = { warn: console.warn, error: console.error };
  console.warn = (...a) => logged.push(a); console.error = (...a) => logged.push(a);
  let r;
  try { r = await post(server, P); } finally { Object.assign(console, orig); }
  assert.deepEqual(r, { status: 503, body: { error: { code: 'upstream' } } });
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n, 0);
  assert.ok(logged.length > 0, 'сбой виден в логе');
  assert.ok(!JSON.stringify(logged).includes(MARKER), 'ни сообщение ошибки, ни переписка не попали в лог');
});

test('сведения о клинике больше 250 000 знаков — 413 too_large; нет ни одной реплики пациента — 400; Claude не вызывался', async (t) => {
  const w = await world(); t.after(() => w.server.close());
  assert.deepEqual(await post(w.server, { ...P, facts: { pad: 'x'.repeat(250_001) } }), { status: 413, body: { error: { code: 'too_large' } } });
  assert.equal((await post(w.server, { ...P, transcript: [{ from: 'clinic', text: 'hi' }] })).status, 400);
  assert.equal((await post(w.server, { ...P, transcript: [] })).status, 400);
  assert.equal((await post(w.server, { ...P, transcript: 'nope' })).status, 400);
  assert.equal(w.calls.length, 0);
  assert.equal((await post(w.server, { ...P, facts: { pad: 'x'.repeat(200_000) } })).status, 200);
});
