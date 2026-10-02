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
//
// CALL_RECORDING_NOT_READY_ERR_V1 — как станция отвечает, пока запись ещё
// готовится, вживую не пойман (два часа наблюдения — ни одного звонка). Если
// это status "0" с комментарием (у нас — server_error), то в первые десять
// минут после разговора ошибка станции и неразборчивый ответ читаются как
// «готовится» (экран спросит снова); позже — своей причиной. Нет связи,
// «не чаще» и ключ — всегда своей: это настоящие поломки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { telephonyCallRecording } from './telephony.js';
import { pbxRecordingUrl } from '../telephony/onlinepbx.js';
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

const OLD = RECORDING_NOT_READY_WINDOW_MS + 60_000;   // CALL_RECORDING_NOT_READY_ERR_V1 — давний звонок: ошибка станции — своей причиной

test('нет связи, ошибка станции, неразборчивый ответ — повтор ОДИН, потом честная причина (давний звонок)', async () => {
  for (const reason of ['offline', 'server_error', 'bad_response']) {
    const { db, providerId } = fresh();
    const id = addCall(db, providerId, { endedAgoMs: OLD });
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

test('незнакомый отказ станции — «ответила ошибкой», а не «записи нет» (давний звонок)', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: OLD });
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

// ---------------------------------------------------------------------------
// CALL_RECORDING_NOT_READY_ERR_V1 — «готовится» и тогда, когда станция в первые
// минуты отвечает ОШИБКОЙ, а не пустым ответом.

// Настоящий разбор ответа onlinePBX (onlinepbx.js post) на поддельной сети:
// status "0" + комментарий → server_error, как и было бы вживую.
function stationSaying(body, { status = 200 } = {}) {
  const asked = [];
  const sleeps = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const deps = {
    pbxRecordingUrlImpl: (domain, uuid, o) => pbxRecordingUrl(domain, uuid, { ...o, fetchImpl }),
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => NOW,
  };
  return { asked, sleeps, deps };
}

test('свежий звонок, станция отвечает status "0" — «готовится», повтор сервера был', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: 2 * 60_000 });
  const s = stationSaying({ status: '0', comment: 'record is not ready' });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'not_ready' });
  assert.equal(s.asked.length, 2, 'серверный повтор пропал');
  assert.deepEqual(s.sleeps, [RECORDING_SERVER_RETRY_MS]);
});

test('давний звонок, станция отвечает status "0" — «ответил ошибкой» (server_error), а не вечное «готовится»', async () => {
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: OLD });
  const s = stationSaying({ status: '0', comment: 'record is not ready' });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'server_error' });
});

test('свежий звонок: ошибка станции, неразборчивый и незнакомый ответ — «готовится»; давний — своей причиной', async () => {
  for (const [answer, oldReason] of [
    [{ ok: false, reason: 'server_error', comment: 'x' }, 'server_error'],
    [{ ok: false, reason: 'bad_response' }, 'bad_response'],
    [{ ok: false, reason: 'something_new' }, 'server_error'],
  ]) {
    const tag = JSON.stringify(answer);
    const a = fresh();
    const freshCall = addCall(a.db, a.providerId, { endedAgoMs: RECORDING_NOT_READY_WINDOW_MS - 1000 });
    assert.deepEqual(await telephonyCallRecording(a.db, { call_id: freshCall }, admin, station(answer).deps), { url: '', reason: 'not_ready' }, tag);
    const b = fresh();
    const old = addCall(b.db, b.providerId, { endedAgoMs: RECORDING_NOT_READY_WINDOW_MS + 1000 });
    assert.deepEqual(await telephonyCallRecording(b.db, { call_id: old }, admin, station(answer).deps), { url: '', reason: oldReason }, tag);
  }
});

test('свежий звонок: нет связи, «не чаще», ключ — своей причиной, не «готовится»: это настоящие поломки', async () => {
  for (const reason of ['offline', 'rate_limited', 'bad_credentials']) {
    const { db, providerId } = fresh();
    const id = addCall(db, providerId, { endedAgoMs: 60_000 });
    assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, station({ ok: false, reason }).deps), { url: '', reason }, reason);
  }
  // И через настоящий разбор: 429 — rate_limited.
  const { db, providerId } = fresh();
  const id = addCall(db, providerId, { endedAgoMs: 60_000 });
  const s = stationSaying({}, { status: 429 });
  assert.deepEqual(await telephonyCallRecording(db, { call_id: id }, admin, s.deps), { url: '', reason: 'rate_limited' });
  assert.equal(s.asked.length, 1, '«не чаще» переспросили');
});
