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
//
// Ревью: в описании параметра new сказано «обязательное значение "true"» —
// станция может однажды начать отвергать new=false. Если отказ — ошибка
// станции или неразборчивый ответ, авторизация один раз повторяется с
// new=true (в пределах тех же двух авторизаций на вызов); нет связи, «не
// чаще» и неверный ключ — нет: new=true там не поможет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { pbxAuth, pbxCall, pbxRecordingUrl, MAX_PBX_AUTHS_PER_CALL } from './onlinepbx.js';
import { pollOnce } from './poller.js';
import { telephonyCallRecording, telephonyProviderSave, telephonyProviderTest } from '../rpc/telephony.js';

const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, body: null,
  text: async () => JSON.stringify(body),
});
const form = (body) => Object.fromEntries(new URLSearchParams(String(body || '')));

// Поддельная станция: держит ДЕЙСТВУЮЩИЙ ключ. auth с new=false отдаёт его,
// с new=true — выдаёт новый (и старый перестаёт работать). Запрос с
// недействующим ключом — isNotAuth. `stubborn` — сколько первых запросов
// ответить isNotAuth даже с верным ключом (гонка с чужой установкой).
const REJECT = {
  server_error:    () => answer({ status: '0', comment: 'parameter new must be "true"' }),
  bad_response:    () => ({ ok: true, status: 200, body: null, text: async () => '<html>maintenance</html>' }),
  bad_credentials: () => answer({ status: '0', comment: 'wrong auth key' }),
  rate_limited:    () => answer({}, 429),
  offline:         () => { throw new Error('ECONNRESET'); },
};
function station({ current = { key_id: 'ID9', key: 'K9' }, stubborn = 0, data = [], rejectShared = null } = {}) {
  const s = { current: { ...current }, auths: [], requests: [], issued: 0 };
  s.fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/auth.json')) {
      const f = form(init.body);
      s.auths.push(f.new);
      if (rejectShared && f.new !== 'true') return REJECT[rejectShared]();
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

// ---------------------------------------------------------------------------
// Ревью ONLINEPBX_KEY_SHARE_V1 — станция отвергает new=false.

test('станция отвергает new=false ошибкой или неразборчивым ответом — один new=true, и запрос проходит', async () => {
  for (const rejectShared of ['server_error', 'bad_response']) {
    const s = station({ rejectShared });
    const renewed = [];
    const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
      creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', onRenew: (c) => { renewed.push(c); }, fetchImpl: s.fetchImpl,
    });
    assert.equal(r.ok, true, rejectShared);
    assert.deepEqual(s.auths, ['false', 'true'], rejectShared);
    assert.deepEqual(s.requests, ['ID1:OLD', 'NEW1:NK1'], rejectShared);
    assert.deepEqual(renewed, [{ key_id: 'NEW1', key: 'NK1' }], rejectShared);
  }
});

test('ключа ещё нет, станция отвергает new=false — new=true, запрос проходит (первый опрос, «Позвонить»)', async () => {
  const s = station({ rejectShared: 'server_error' });
  const r = await pbxCall('clinic.onpbx.ru', 'call/now.json', { from: '101', to: '998' }, { authKey: 'AUTH', fetchImpl: s.fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(s.auths, ['false', 'true']);
  assert.deepEqual(s.requests, ['NEW1:NK1']);
});

test('нет связи, «не чаще», неверный ключ на new=false — без new=true: там он не поможет', async () => {
  for (const [rejectShared, reason] of [['offline', 'offline'], ['rate_limited', 'rate_limited'], ['bad_credentials', 'bad_credentials']]) {
    const s = station({ rejectShared });
    const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
      creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', fetchImpl: s.fetchImpl,
    });
    assert.equal(r.ok, false, rejectShared);
    assert.equal(r.reason, reason, rejectShared);
    assert.deepEqual(s.auths, ['false'], rejectShared + ': выпущен новый ключ там, где он не поможет');
  }
});

test('станция отвергла new=false, а с новым ключом — isNotAuth: всё равно не больше двух авторизаций', async () => {
  const s = station({ rejectShared: 'server_error', stubborn: 99 });
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
    creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', fetchImpl: s.fetchImpl,
  });
  assert.deepEqual(r, { ok: false, reason: 'bad_credentials' });
  assert.deepEqual(s.auths, ['false', 'true'], 'третья авторизация за вызов');
  assert.equal(s.requests.length, 2);
});

test('опрос: станция отвергает new=false — new=true один раз, ключ сохранён, следующий шаг без авторизации', async () => {
  const { db, id } = db1({ auth_key: 'AUTH', key_id: 'ID1', key: 'STALE' });
  const s = station({ rejectShared: 'server_error' });
  await pollOnce(db, { fetchImpl: s.fetchImpl, hasModule: () => true });
  assert.deepEqual(s.auths, ['false', 'true']);
  assert.equal(storedKey(db, id), 'NEW1:NK1');
  await pollOnce(db, { fetchImpl: s.fetchImpl, hasModule: () => true });
  assert.deepEqual(s.auths, ['false', 'true'], 'опрос авторизуется при действующем ключе');
  assert.equal(db.prepare('SELECT last_error FROM telephony_providers WHERE id = ?').get(id).last_error, '');
});

// new=false по умолчанию — и у тех, кто зовёт авторизацию напрямую: проверка
// ключа при сохранении подключения и «Проверить подключение». Их сеть —
// глобальный fetch, поэтому он подменяется на время проверки.
async function withGlobalFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => fetchImpl(url, init);
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const ADMIN = { id: 1, role: 'admin' };

test('сохранение подключения с новым ключом проверяет его авторизацией new=false', async () => {
  const { db } = db1({ auth_key: 'AUTH', key_id: 'ID1', key: 'K1' });
  const s = station();
  await withGlobalFetch(s.fetchImpl, () => telephonyProviderSave(db, {
    kind: 'onlinepbx', name: 'Вторая линия', enabled: false, config: { domain: 'clinic.onpbx.ru' }, secret: { auth_key: 'AUTH2' },
  }, ADMIN));
  assert.deepEqual(s.auths, ['false'], 'проверка ключа при сохранении погасила ключи остальных установок');
  assert.equal(s.issued, 0);

  const strict = station({ rejectShared: 'server_error' });
  const out = await withGlobalFetch(strict.fetchImpl, () => telephonyProviderSave(db, {
    kind: 'onlinepbx', name: 'Третья линия', enabled: false, config: { domain: 'clinic.onpbx.ru' }, secret: { auth_key: 'AUTH3' },
  }, ADMIN));
  assert.ok(out && out.id, 'станция отвергла new=false — и ключ не сохранить');
  assert.deepEqual(strict.auths, ['false', 'true']);
});

test('«Проверить подключение» с новым ключом — авторизация new=false, история проходит', async () => {
  const { db } = db1({ auth_key: 'AUTH', key_id: 'ID1', key: 'K1' });
  const s = station();
  const r = await withGlobalFetch(s.fetchImpl, () => telephonyProviderTest(db, {
    kind: 'onlinepbx', config: { domain: 'clinic.onpbx.ru' }, secret: { auth_key: 'AUTH2' },
  }, ADMIN));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(s.auths, ['false']);
  assert.deepEqual(s.requests, ['ID9:K9']);

  const strict = station({ rejectShared: 'bad_response' });
  const r2 = await withGlobalFetch(strict.fetchImpl, () => telephonyProviderTest(db, {
    kind: 'onlinepbx', config: { domain: 'clinic.onpbx.ru' }, secret: { auth_key: 'AUTH2' },
  }, ADMIN));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(strict.auths, ['false', 'true']);
});
