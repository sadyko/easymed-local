// ONLINEPBX_KEY_SHARE_V1 (2026-10-02) — ОДИН КЛЮЧ onlinePBX НА ВСЕ УСТАНОВКИ.
//
// Найдено проверкой: ключ (key_id/key) подключения onlinePBX на этом компьютере
// менялся 15 раз за 150 секунд — каждые ~11 секунд, на каждом шаге опроса, при
// одном работающем Easy-Med. Значит, тем же auth_key пользуются несколько
// установок (эта и серверы клиники), и каждая авторизация с new=true выдаёт
// НОВЫЙ ключ, гася ключ всех остальных: установки по очереди выбивали друг
// друга. «Прослушать» сразу после чужой авторизации получал isNotAuth — и
// оператор читал «записи нет».
//
// Документация onlinePBX (auth.json): «Запрашивайте ключ, только если в ответ
// получили { isNotAuth: true } или это первый запрос»; «каждая новая
// авторизация даёт новый ключ»; параметр new ("true"/"false") — «необходимость
// обновления ключа». Поэтому:
//   • авторизация по умолчанию — new=false: станция отдаёт ДЕЙСТВУЮЩИЙ ключ, и
//     все установки работают с одним;
//   • новый ключ (new=true) — только если и с только что полученным общим
//     ключом станция ответила isNotAuth; не больше ДВУХ авторизаций на вызов,
//     дальше — bad_credentials, без циклов;
//   • опрос берёт последний сохранённый ключ на каждом шаге.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { pbxAuth, pbxCall, pbxRecordingUrl, MAX_PBX_AUTHS_PER_CALL } from './onlinepbx.js';
import { pollOnce } from './poller.js';
import { telephonyCallRecording } from '../rpc/telephony.js';

const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, body: null,
  text: async () => JSON.stringify(body),
});
const form = (body) => Object.fromEntries(new URLSearchParams(String(body || '')));

// Поддельная станция: держит ДЕЙСТВУЮЩИЙ ключ. auth с new=false отдаёт его,
// с new=true — выдаёт новый (и старый перестаёт работать). Запрос с
// недействующим ключом — isNotAuth. `stubborn` — сколько первых запросов
// ответить isNotAuth даже с верным ключом (гонка с чужой установкой).
function station({ current = { key_id: 'ID9', key: 'K9' }, stubborn = 0, data = [] } = {}) {
  const s = { current: { ...current }, auths: [], requests: [], issued: 0 };
  s.fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/auth.json')) {
      const f = form(init.body);
      s.auths.push(f.new);
      if (f.new === 'true' || !s.current.key) { s.issued += 1; s.current = { key_id: 'NEW' + s.issued, key: 'NK' + s.issued }; }
      return answer({ status: '1', data: { ...s.current, new: f.new === 'true' ? 1 : 0 } });
    }
    const auth = init.headers['x-pbx-authentication'] || '';
    s.requests.push(auth);
    if (stubborn > 0) { stubborn -= 1; return answer({ status: '0', isNotAuth: true }); }
    if (auth !== s.current.key_id + ':' + s.current.key) return answer({ status: '0', isNotAuth: true });
    return answer({ status: '1', data: typeof data === 'function' ? data(u, init) : data });
  };
  return s;
}

test('авторизация по умолчанию просит ДЕЙСТВУЮЩИЙ ключ (new=false), а не новый', async () => {
  const s = station();
  const r = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl: s.fetchImpl });
  assert.deepEqual(r, { ok: true, key_id: 'ID9', key: 'K9' });
  assert.deepEqual(s.auths, ['false'], 'авторизация гасит ключи остальных установок');
  const fresh = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl: s.fetchImpl, newKey: true });
  assert.equal(fresh.ok, true);
  assert.deepEqual(s.auths, ['false', 'true']);
});

test('протухший ключ: общий ключ (new=false) — и запрос проходит, новый ключ не выпускается', async () => {
  const s = station();
  let renewed = null;
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
    creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', onRenew: (c) => { renewed = c; }, fetchImpl: s.fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(s.auths, ['false']);
  assert.deepEqual(s.requests, ['ID1:OLD', 'ID9:K9']);
  assert.deepEqual(renewed, { key_id: 'ID9', key: 'K9' });
  assert.equal(s.issued, 0, 'выпущен новый ключ — остальные установки его потеряли');
});

test('и с общим ключом isNotAuth — тогда, и только тогда, новый ключ (new=true), один раз', async () => {
  const s = station({ stubborn: 2 });   // первый запрос и запрос с общим ключом — isNotAuth
  const renewed = [];
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
    creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', onRenew: (c) => { renewed.push(c); }, fetchImpl: s.fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(s.auths, ['false', 'true']);
  assert.deepEqual(s.requests, ['ID1:OLD', 'ID9:K9', 'NEW1:NK1']);
  assert.deepEqual(renewed, [{ key_id: 'ID9', key: 'K9' }, { key_id: 'NEW1', key: 'NK1' }]);
});

test('станция упорно отвечает isNotAuth — не больше двух авторизаций на вызов, потом bad_credentials', async () => {
  const s = station({ stubborn: 99 });
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
    creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', fetchImpl: s.fetchImpl,
  });
  assert.deepEqual(r, { ok: false, reason: 'bad_credentials' });
  assert.equal(MAX_PBX_AUTHS_PER_CALL, 2);
  assert.deepEqual(s.auths, ['false', 'true']);
  assert.equal(s.requests.length, 3);
});

test('ключа ещё нет: первая авторизация — общий ключ; isNotAuth — один новый; дальше — bad_credentials', async () => {
  const ok = station({ stubborn: 1 });
  const r = await pbxCall('clinic.onpbx.ru', 'call/now.json', { from: '101', to: '998' }, { authKey: 'AUTH', fetchImpl: ok.fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(ok.auths, ['false', 'true']);

  const never = station({ stubborn: 99 });
  const r2 = await pbxCall('clinic.onpbx.ru', 'call/now.json', {}, { authKey: 'AUTH', fetchImpl: never.fetchImpl });
  assert.deepEqual(r2, { ok: false, reason: 'bad_credentials' });
  assert.deepEqual(never.auths, ['false', 'true'], 'третья авторизация за вызов');
});

// --- опрос и «Прослушать» на базе ------------------------------------------

function db1(secret) {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'adm', 'x', 'admin')").run();
  const id = Number(db.prepare(`INSERT INTO telephony_providers (kind, vendor, name, enabled, config, secret, poll_interval_sec)
      VALUES ('onlinepbx', 'onlinepbx', 'onlinePBX', 1, ?, ?, 10)`)
    .run(JSON.stringify({ domain: 'clinic.onpbx.ru' }), JSON.stringify(secret)).lastInsertRowid);
  return { db, id };
}
const storedKey = (db, id) => {
  const s = JSON.parse(db.prepare('SELECT secret FROM telephony_providers WHERE id = ?').get(id).secret);
  return s.key_id + ':' + s.key;
};
const setKey = (db, id, key_id, key) => {
  const s = JSON.parse(db.prepare('SELECT secret FROM telephony_providers WHERE id = ?').get(id).secret);
  db.prepare('UPDATE telephony_providers SET secret = ? WHERE id = ?').run(JSON.stringify({ ...s, key_id, key }), id);
};

test('опрос берёт последний сохранённый ключ на каждом шаге и не авторизуется, пока он действует', async () => {
  const { db, id } = db1({ auth_key: 'AUTH', key_id: 'ID1', key: 'K1' });
  const s = station({ current: { key_id: 'ID1', key: 'K1' } });
  await pollOnce(db, { fetchImpl: s.fetchImpl, hasModule: () => true });
  assert.deepEqual(s.requests, ['ID1:K1']);

  // Ключ обновил другой путь (например, «Прослушать» через onRenew) — опрос берёт его.
  s.current = { key_id: 'ID2', key: 'K2' };
  setKey(db, id, 'ID2', 'K2');
  await pollOnce(db, { fetchImpl: s.fetchImpl, hasModule: () => true });
  assert.deepEqual(s.requests, ['ID1:K1', 'ID2:K2']);
  assert.deepEqual(s.auths, [], 'опрос авторизуется при действующем ключе');
});

test('опрос с протухшим ключом: общий ключ один раз, сохранён, следующий шаг — без авторизации', async () => {
  const { db, id } = db1({ auth_key: 'AUTH', key_id: 'ID1', key: 'STALE' });
  const s = station({ current: { key_id: 'ID9', key: 'K9' } });
  await pollOnce(db, { fetchImpl: s.fetchImpl, hasModule: () => true });
  assert.deepEqual(s.auths, ['false']);
  assert.equal(storedKey(db, id), 'ID9:K9', 'полученный ключ не сохранён — опрос будет авторизоваться каждый шаг');
  await pollOnce(db, { fetchImpl: s.fetchImpl, hasModule: () => true });
  assert.deepEqual(s.auths, ['false'], 'второй шаг снова авторизовался');
  assert.equal(s.issued, 0, 'опрос выпустил новый ключ и погасил ключ остальных установок');
  assert.equal(db.prepare('SELECT last_error FROM telephony_providers WHERE id = ?').get(id).last_error, '');
});

test('«Прослушать» с протухшим ключом: общий ключ (new=false) — и ссылка на запись', async () => {
  const LINK = 'https://records.onpbx.ru/get/x.mp3?sign=1';
  const { db, id } = db1({ auth_key: 'AUTH', key_id: 'ID1', key: 'STALE' });
  const started = new Date(Date.now() - 3 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const callId = Number(db.prepare(`INSERT INTO calls (general_call_id, started_at, call_type, external_number, internal_number,
      waitsec, billsec, disposition, provider, provider_id) VALUES ('onlinepbx:u1', ?, 0, '998901112233', '101', 8, 97, 'ANSWER', 'onlinepbx', ?)`)
    .run(started, id).lastInsertRowid);
  const s = station({ data: () => LINK });
  const r = await telephonyCallRecording(db, { call_id: callId }, { id: 1, role: 'admin' }, {
    pbxRecordingUrlImpl: (domain, uuid, o) => pbxRecordingUrl(domain, uuid, { ...o, fetchImpl: s.fetchImpl }),
    sleep: async () => {},
  });
  assert.deepEqual(r, { url: LINK });
  assert.deepEqual(s.auths, ['false']);
  assert.deepEqual(s.requests, ['ID1:STALE', 'ID9:K9']);
  assert.equal(storedKey(db, id), 'ID9:K9');
});
