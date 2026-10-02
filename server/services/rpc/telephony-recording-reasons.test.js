// CALL_RECORDING_REASONS_V1 (2026-10-02) — «Прослушать» говорит ПРАВДУ о том,
// почему записи нет.
//
// Владелец (2 октября): оператор нажал «Прослушать» на входящем звонке 09:33
// (1 мин 37 сек разговора) и получил «Записи этого разговора у станции нет.».
// Запись при этом была: через полчаса onlinePBX отдал по тому же звонку ссылку
// на mp3. Прежде ЛЮБОЙ отказ станции — нет связи, «не чаще», ошибка, ключ, и
// запись, которую станция ещё не склеила, — превращался в одно «нет записи».
//
// Здесь — каждая причина своим словом:
//   • нет связи / ошибка станции / неразборчивый ответ — один повтор через
//     полторы секунды, потом честная причина;
//   • «не чаще» и «ключ не подходит» — без повтора (повтор тут вредит);
//   • станция ответила без ссылки: разговор кончился меньше десяти минут
//     назад — «запись ещё готовится» (not_ready), раньше — «записи нет»;
//   • линия звонка удалена из настроек — своя причина (no_line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyCallRecording } from './telephony.js';
import { RECORDING_NOT_READY_WINDOW_MS, RECORDING_SERVER_RETRY_MS } from '../../../public/js/shared/call-recording.js';

const NOW = Date.parse('2026-10-02T04:40:00Z');
const admin = { id: 1, role: 'admin' };
const LINK = 'https://records.onlinepbx.ru/get/abc.mp3?sign=xyz';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'adm', 'x', 'admin')").run();
  const p = db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
      VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1, ?, ?, 30)`)
    .run(JSON.stringify({ domain: 'clinic.onpbx.ru' }), JSON.stringify({ auth_key: 'a', key_id: 'k', key: 'v' }));
  return { db, providerId: Number(p.lastInsertRowid) };
}

let seq = 0;
// Звонок, разговор которого КОНЧИЛСЯ endedAgoMs назад: начало = конец − (ожидание + разговор).
function addCall(db, providerId, { endedAgoMs, billsec = 97, waitsec = 8, startedAt } = {}) {
  const end = NOW - endedAgoMs;
  const start = startedAt || new Date(end - (billsec + waitsec) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  seq += 1;
  return Number(db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number,
        waitsec, billsec, disposition, provider, provider_id)
      VALUES (?, ?, 0, '998901112233', '101', ?, ?, 'ANSWER', 'onlinepbx', ?)`)
    .run('onlinepbx:uuid-' + seq, start, waitsec, billsec, providerId).lastInsertRowid);
}

// Поддельная станция: отвечает по списку, последний ответ повторяется.
function station(...answers) {
  const asked = [];
  const sleeps = [];
  const impl = async (domain, uuid) => {
    asked.push({ domain, uuid });
    return answers[Math.min(asked.length - 1, answers.length - 1)];
  };
  const deps = { pbxRecordingUrlImpl: impl, sleep: async (ms) => { sleeps.push(ms); }, now: () => NOW };
  return { asked, sleeps, deps };
}

test('нет связи — один повтор через паузу, и ссылка, если со второго раза станция ответила', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: 60_000 });
  const s = station({ ok: false, reason: 'offline' }, { ok: true, data: LINK });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: LINK });
  assert.equal(s.asked.length, 2, 'станцию спросили не дважды');
  assert.deepEqual(s.sleeps, [RECORDING_SERVER_RETRY_MS], 'повтор без паузы');
  assert.equal(RECORDING_SERVER_RETRY_MS, 1500);
  assert.equal(s.asked[0].domain, 'clinic.onpbx.ru');
  assert.match(s.asked[0].uuid, /^uuid-\d+$/, 'станцию спросили с «onlinepbx:» в номере звонка');
});

test('нет связи, ошибка станции, неразборчивый ответ — повтор ОДИН, потом честная причина', async () => {
  for (const reason of ['offline', 'server_error', 'bad_response']) {
    const { db, providerId } = fresh();
    const id = addCall(db, providerId, { endedAgoMs: 60_000 });
    const s = station({ ok: false, reason });
    assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason }, reason);
    assert.equal(s.asked.length, 2, reason + ': повторов не один');
    assert.deepEqual(s.sleeps, [RECORDING_SERVER_RETRY_MS], reason);
  }
});

test('«не чаще» и «ключ не подходит» — без повтора, своей причиной, а не «записи нет»', async () => {
  for (const reason of ['rate_limited', 'bad_credentials']) {
    const { db, providerId } = fresh();
    const id = addCall(db, providerId, { endedAgoMs: 60_000 });
    const s = station({ ok: false, reason });
    assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason }, reason);
    assert.equal(s.asked.length, 1, reason + ': повтор там, где он вредит');
    assert.deepEqual(s.sleeps, [], reason);
  }
});

test('незнакомый отказ станции — «ответила ошибкой», а не «записи нет»', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: 60_000 });
  const s = station({ ok: false, reason: 'something_new' });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'server_error' });
  assert.equal(s.asked.length, 1);
});

test('станция ответила без ссылки: разговор кончился недавно — «готовится», давно — «записи нет»', async () => {
  for (const data of ['', [], {}, null, 'not a link']) {
    const { db, providerId } = fresh();
    const freshCall = addCall(db, providerId, { endedAgoMs: 2 * 60_000 });               // как у владельца: нажали через две минуты
    const edge = addCall(db, providerId, { endedAgoMs: RECORDING_NOT_READY_WINDOW_MS - 1000 });
    const old = addCall(db, providerId, { endedAgoMs: RECORDING_NOT_READY_WINDOW_MS + 1000 });
    const s = station({ ok: true, data });
    const tag = JSON.stringify(data);
    assert.deepEqual(await telephonyCallRecording(db, { call_id: freshCall }, admin, s.deps), { url: '', reason: 'not_ready' }, tag);
    assert.deepEqual(await telephonyCallRecording(db, { call_id: edge }, admin, s.deps), { url: '', reason: 'not_ready' }, tag);
    assert.deepEqual(await telephonyCallRecording(db, { call_id: old }, admin, s.deps), { url: '', reason: 'not_found' }, tag);
    assert.deepEqual(s.sleeps, [], 'ответ без ссылки — не сбой связи, повторять на сервере нечего');
  }
  assert.equal(RECORDING_NOT_READY_WINDOW_MS, 10 * 60_000);
});

test('«кончился» считается от конца разговора: начало + ожидание + разговор', async () => {
  const { db, providerId } = fresh();
  // Начался 14 минут назад, но 5 минут ждал и 6 минут говорил — кончился 3 минуты назад.
  const startedAt = new Date(NOW - 14 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const id = addCall(db, providerId, { startedAt, waitsec: 5 * 60, billsec: 6 * 60, endedAgoMs: 0 });
  const s = station({ ok: true, data: '' });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'not_ready' });
});

test('время звонка не читается — «записи нет», без бесконечного «готовится»', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { startedAt: 'вчера', endedAgoMs: 0 });
  const s = station({ ok: true, data: '' });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'not_found' });
});

test('линия звонка удалена из настроек — своя причина, станцию не спрашиваем', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: 60_000 });
  db.prepare('DELETE FROM telephony_providers WHERE id = ?').run(providerId);   // calls.provider_id → NULL (миграция 126)
  const s = station({ ok: true, data: LINK });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'no_line' });
  assert.equal(s.asked.length, 0);
});

test('ссылка — прежний ответ {url} без лишних полей', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: 30_000 });
  const s = station({ ok: true, data: LINK });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: LINK });
  assert.equal(s.asked.length, 1);
});
