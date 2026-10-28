// CALL_RING_V1 (2026-10-17) — живые звонки: событие станции → состояние в памяти с
// именем пациента и заявкой; спрос панели; длинный опрос публичного сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { noteEvent, liveCalls, demandLive, liveDemanded, resetLive, pullOnce, liveCursor, liveSource, scheduleLivePull,
         ENDED_KEEP_MS, RINGING_MAX_MS, DEMAND_TTL_MS } from './live.js';

const T0 = Date.parse('2026-10-17T07:00:00Z');
const at = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO patients (full_name, phone, mrn) VALUES ('Каримова Азиза', '+998 90 111 22 33', 'A-12')").run();
  db.prepare("INSERT INTO crm_requests (full_name, phone, status, source) VALUES ('Заявка Тестовая', '+998 93 555 01 12', 'in_process', 'call')").run();
  return db;
}
const ring = (uuid, caller, callee = '101', t = T0) => ({ uuid, event: 'ring', direction: 'in', caller, callee, at: at(t) });

test('начало входящего → ringing с именем пациента по номеру; заявка с доски — тоже по номеру', () => {
  resetLive();
  const db = fresh();
  noteEvent(db, ring('u1', '998901112233'), T0);
  noteEvent(db, ring('u2', '998935550112'), T0 + 1000);
  const [b, a] = liveCalls(T0 + 1000);
  assert.equal(a.uuid, 'u1');
  assert.equal(a.state, 'ringing');
  assert.equal(a.number, '998901112233');
  assert.deepEqual(a.patient, { id: 1, full_name: 'Каримова Азиза', mrn: 'A-12' });
  assert.equal(a.lead, null);
  assert.equal(b.uuid, 'u2', 'свежие первыми');
  assert.equal(b.patient, null);
  assert.deepEqual(b.lead, { id: 1, full_name: 'Заявка Тестовая', status: 'in_process' });
});

test('ответили → answered; кончился → ended и через 15 секунд исчезает; повтор начала — одна запись', () => {
  resetLive();
  const db = fresh();
  noteEvent(db, ring('u1', '998901112233'), T0);
  noteEvent(db, ring('u1', '998901112233'), T0 + 500);
  assert.equal(liveCalls(T0 + 500).length, 1, 'повтор события «начало» удвоил звонок');
  noteEvent(db, { uuid: 'u1', event: 'answer', direction: 'in', caller: '998901112233', callee: '101', at: at(T0 + 8000) }, T0 + 8000);
  assert.equal(liveCalls(T0 + 8000)[0].state, 'answered');
  noteEvent(db, { uuid: 'u1', event: 'end', direction: 'in', caller: '998901112233', callee: '101', at: at(T0 + 90000) }, T0 + 90000);
  const c = liveCalls(T0 + 90000)[0];
  assert.equal(c.state, 'ended');
  assert.equal(c.was_answered, true);
  assert.equal(liveCalls(T0 + 90000 + ENDED_KEEP_MS + 1).length, 0, 'законченный звонок висит дольше 15 секунд');
});

test('пропущенный: конец без ответа — was_answered false; конец без начала — ничего; звонок без конца — уходит через три минуты', () => {
  resetLive();
  const db = fresh();
  assert.equal(noteEvent(db, { uuid: 'ghost', event: 'end', direction: 'in', caller: '998901112233', callee: '101', at: at(T0) }, T0), null);
  assert.equal(liveCalls(T0).length, 0);
  noteEvent(db, ring('u1', '998901112233'), T0);
  noteEvent(db, { uuid: 'u1', event: 'end', direction: 'in', caller: '998901112233', callee: '101', at: at(T0 + 20000) }, T0 + 20000);
  assert.equal(liveCalls(T0 + 20000)[0].was_answered, false);
  noteEvent(db, ring('u2', '998935550112'), T0 + 30000);
  assert.equal(liveCalls(T0 + 30000 + RINGING_MAX_MS + 1).length, 0);
});

test('исходящий: номер пациента — callee; непонятное событие — null и ничего в состоянии', () => {
  resetLive();
  const db = fresh();
  const c = noteEvent(db, { uuid: 'o1', event: 'ring', direction: 'out', caller: '101', callee: '998901112233', at: at(T0) }, T0);
  assert.equal(c.number, '998901112233');
  assert.equal(c.patient.full_name, 'Каримова Азиза');
  assert.equal(noteEvent(db, { unknown: true, keys: ['foo'] }, T0), null);
  assert.equal(liveCalls(T0).length, 1);
});

// FIX_318_V1 (C6) — непонятное событие пропускается, а его имя пишется в журнал
// ОДИН раз (по имени): по нему схема станции сверяется на настоящих событиях.
test('FIX_318_V1: непонятное событие — в журнал один раз на имя (имя и поля, без значений); состояние не меняется', () => {
  resetLive();
  const db = fresh();
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    for (let i = 0; i < 3; i++) assert.equal(noteEvent(db, { unknown: true, keys: ['event', 'uuid', 'caller'], name: 'call_missed' }, T0), null);
    noteEvent(db, { unknown: true, keys: ['event'], name: 'pending' }, T0);
    noteEvent(db, { unknown: true, keys: ['event'], name: 'call_missed' }, T0);
  } finally { console.warn = orig; }
  assert.equal(warns.length, 2, warns.join('\n'));
  assert.match(warns[0], /call_missed/);
  assert.match(warns[0], /event, uuid, caller/);
  assert.match(warns[1], /pending/);
  assert.equal(liveCalls(T0).length, 0);
  resetLive();
});

test('спрос панели живёт 30 секунд', () => {
  resetLive();
  assert.equal(liveDemanded(T0), false, 'без единого вопроса спроса нет');
  demandLive(T0);
  assert.equal(liveDemanded(T0 + DEMAND_TTL_MS - 1), true);
  assert.equal(liveDemanded(T0 + DEMAND_TTL_MS + 1), false);
});

test('длинный опрос: первый — с пустым курсором и wait=20; события ложатся в состояние; второй — после последнего номера', async () => {
  resetLive();
  const db = fresh();
  const seen = [];
  const answers = [
    { items: [{ id: 41, ...ring('p1', '998901112233') }, { id: 42, uuid: 'p1', event: 'answer', direction: 'in', caller: '998901112233', callee: '101', at: at(T0 + 5000) }] },
    { items: [] },
  ];
  const callImpl = async (_ctx, method, p) => { seen.push(method + ' ' + p); return answers.shift(); };
  const ctx = { db };
  assert.deepEqual(await pullOnce(ctx, { callImpl, now: () => T0 + 6000 }), { ok: true, count: 2 });
  assert.equal(seen[0], 'GET /pbx-events?after=&wait=20');
  assert.equal(liveCalls(T0 + 6000)[0].state, 'answered');
  assert.equal(liveCursor(), '42');
  await pullOnce(ctx, { callImpl, now: () => T0 + 7000 });
  assert.equal(seen[1], 'GET /pbx-events?after=42&wait=20');
});

// FIX_318_V1 (C6) — базу публичного сервера восстановили из копии: номера событий
// пошли заново с меньших, а курсор клиники остался прежним, большим, — новые
// события «старше курсора» не приезжали никогда. Сервер видит курсор больше
// своего последнего номера и говорит cursor_reset (с свежими событиями или без).
test('FIX_318_V1: сервер говорит cursor_reset (его база восстановлена) — курсор сбрасывается или становится номером свежего события; без флага — как раньше', async () => {
  resetLive();
  const db = fresh();
  const seen = [];
  const answers = [
    { items: [{ id: 500, ...ring('p1', '998901112233') }] },
    { items: [], cursor_reset: true },
    { items: [{ id: 38, ...ring('p2', '998907778899') }] },
    { items: [{ id: 12, ...ring('p3', '998935550112') }], cursor_reset: true },
    { items: [] },
  ];
  const callImpl = async (_ctx, method, p) => { seen.push(p); return answers.shift(); };
  const ctx = { db };
  await pullOnce(ctx, { callImpl, now: () => T0 });
  assert.equal(liveCursor(), '500');
  await pullOnce(ctx, { callImpl, now: () => T0 + 1000 });
  assert.equal(liveCursor(), '', 'курсор больше последнего номера сервера остался — новые события не приедут');
  await pullOnce(ctx, { callImpl, now: () => T0 + 2000 });
  assert.equal(seen[2], '/pbx-events?after=&wait=20');
  assert.equal(liveCursor(), '38');
  await pullOnce(ctx, { callImpl, now: () => T0 + 3000 });
  assert.equal(liveCursor(), '12', 'со свежими событиями курсор — номер последнего из них');
  await pullOnce(ctx, { callImpl, now: () => T0 + 4000 });
  assert.equal(liveCursor(), '12', 'ответ без флага сбросил курсор');
  assert.ok(liveCalls(T0 + 4000).some((c) => c.uuid === 'p3'));
  resetLive();
});

test('источник: без ключа обмена — off; с публичным адресом и токеном — direct; причина — как у обмена', () => {
  resetLive();
  const db = fresh();
  const dir = tmpDir('em-live-');
  assert.deepEqual(liveSource(db, dir), { source: 'off', reason: 'not_enrolled' });
  db.prepare("UPDATE telephony_settings SET ring_token = ?, public_base_url = 'https://clinic.example.uz' WHERE id = 1").run('a'.repeat(32));
  assert.deepEqual(liveSource(db, dir), { source: 'direct', reason: 'not_enrolled' });
});

test('цикл: без спроса в сеть не ходит; при спросе — опрашивает подряд; заблокирован обмен — ждёт; сбой — пауза', async () => {
  resetLive();
  const db = fresh();
  const dir = tmpDir('em-live-loop-');
  let built = 0, pulled = 0, blocked = false, fail = false;
  const buildContext = () => { built++; return blocked ? { blocked: 'not_enabled' } : { db }; };
  const callImpl = async () => { pulled++; if (fail) { const e = new Error('offline'); e.reason = 'offline'; throw e; } return { items: [] }; };
  const warnings = [];
  const loop = scheduleLivePull(db, dir, { buildContext, callImpl, idleMs: 5, blockedMs: 5, backoffMs: 5, log: { warn: (m) => warnings.push(m) } });
  try {
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(pulled, 0, 'без спроса пошёл в сеть');
    demandLive(Date.now());
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(pulled >= 2, 'при спросе опрос не пошёл подряд: ' + pulled);
    blocked = true;
    const before = pulled;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(pulled, before, 'заблокированный обмен всё равно опрашивается');
    assert.ok(built > 0);
    blocked = false; fail = true;
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(warnings.length >= 1 && /offline/.test(warnings[0]), 'сбой сети не записан в журнал');
    assert.ok(warnings.length <= 1, 'сбой сети пишется чаще раза в минуту');
  } finally { loop.stop(); }
  fs.rmSync(dir, { recursive: true, force: true });
});
