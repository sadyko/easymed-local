// ONLINEPBX_V1 — клиент HTTP API onlinePBX: авторизация, повтор при протухшем
// ключе, история, приведение звонка к словарю журнала.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbxAuth, pbxCall, pbxHistory, pbxCallNow, normalizePbxCall, normalizeDomain, ONLINEPBX_API_BASE } from './onlinepbx.js';

// Ответ провайдера как его видит fetch: JSON-строка, status 200.
const answer = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, body: null,
  text: async () => JSON.stringify(body),
});

test('normalizeDomain: схема, путь, регистр и пробелы отбрасываются', () => {
  assert.equal(normalizeDomain(' HTTPS://Clinic.onpbx.ru/panel '), 'clinic.onpbx.ru');
  assert.equal(normalizeDomain(''), '');
  assert.equal(normalizeDomain(null), '');
});

test('pbxAuth: auth_key уходит формой в /{domain}/auth.json, назад — пара key_id/key', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, ct: init.headers['Content-Type'], body: init.body });
    return answer({ status: '1', data: { key_id: 'ID1', key: 'SECRET' } });
  };
  const r = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl });
  assert.deepEqual(r, { ok: true, key_id: 'ID1', key: 'SECRET' });
  assert.equal(seen[0].url, ONLINEPBX_API_BASE + '/clinic.onpbx.ru/auth.json');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].ct, 'application/x-www-form-urlencoded');
  assert.match(seen[0].body, /auth_key=AUTH/);
});

test('pbxAuth: провайдер сказал «нет» (status 0 / 401) — честный bad_credentials', async () => {
  let r = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl: async () => answer({ status: '0', comment: 'auth key is wrong' }) });
  assert.equal(r.ok, false); assert.equal(r.reason, 'bad_credentials');
  r = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl: async () => answer({}, 401) });
  assert.equal(r.reason, 'bad_credentials');
  r = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(r.reason, 'offline');
  r = await pbxAuth('clinic.onpbx.ru', 'AUTH', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) });
  assert.equal(r.reason, 'bad_response');
  r = await pbxAuth('', 'AUTH', { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(r.reason, 'bad_credentials');
});

test('pbxCall: с выданной парой — один запрос с заголовком x-pbx-authentication, без повторной авторизации', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers['x-pbx-authentication'], body: init.body }); return answer({ status: '1', data: [] }); };
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', { start_stamp_from: 100 }, { creds: { key_id: 'ID1', key: 'K' }, authKey: 'AUTH', fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1, 'ключ есть — авторизацию не дёргаем: провайдер предупреждает, что частая авторизация ломает сессии');
  assert.equal(seen[0].auth, 'ID1:K');
  assert.match(seen[0].body, /start_stamp_from=100/);
});

test('pbxCall: ключ протух (isNotAuth) — ровно одна повторная авторизация, повтор запроса, новая пара наверх через onRenew', async () => {
  const seen = [];
  let renewed = null;
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers['x-pbx-authentication'] || null });
    if (url.endsWith('/auth.json')) return answer({ status: '1', data: { key_id: 'ID2', key: 'K2' } });
    if (init.headers['x-pbx-authentication'] === 'ID1:OLD') return answer({ status: '0', isNotAuth: true });
    return answer({ status: '1', data: [{ uuid: 'u' }] });
  };
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, {
    creds: { key_id: 'ID1', key: 'OLD' }, authKey: 'AUTH', onRenew: (c) => { renewed = c; }, fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [{ uuid: 'u' }]);
  assert.deepEqual(seen.map((s) => s.auth), ['ID1:OLD', null, 'ID2:K2']);
  assert.deepEqual(renewed, { key_id: 'ID2', key: 'K2' });
});

test('pbxCall: пары ещё нет — сначала авторизация по auth_key, потом запрос; без auth_key — bad_credentials без сети', async () => {
  const seen = [];
  let renewed = null;
  const fetchImpl = async (url, init) => {
    seen.push(url.split('/').pop());
    if (url.endsWith('/auth.json')) return answer({ status: '1', data: { key_id: 'ID', key: 'K' } });
    return answer({ status: '1', data: { ok: 1 } });
  };
  const r = await pbxCall('clinic.onpbx.ru', 'call/now.json', { from: '101', to: '998' }, { authKey: 'AUTH', onRenew: (c) => { renewed = c; }, fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['auth.json', 'now.json']);
  assert.deepEqual(renewed, { key_id: 'ID', key: 'K' });

  const r2 = await pbxCall('clinic.onpbx.ru', 'call/now.json', {}, { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(r2.reason, 'bad_credentials');
});

test('pbxCall: ключ протух и повторная авторизация тоже не прошла — bad_credentials, не бесконечный цикл', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    n++;
    if (url.endsWith('/auth.json')) return answer({ status: '0', comment: 'bad auth key' });
    return answer({ status: '0', isNotAuth: true });
  };
  const r = await pbxCall('clinic.onpbx.ru', 'mongo_history/search.json', {}, { creds: { key_id: 'a', key: 'b' }, authKey: 'AUTH', fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_credentials');
  assert.equal(n, 2);
});

test('pbxHistory: окно не старше недели, pbxCallNow: from/to формой', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(init.body); return answer({ status: '1', data: [] }); };
  const o = { creds: { key_id: 'a', key: 'b' }, fetchImpl };
  await pbxHistory('clinic.onpbx.ru', 1, o);
  const from = Number(new URLSearchParams(bodies[0]).get('start_stamp_from'));
  assert.ok(from >= Math.floor(Date.now() / 1000) - 7 * 86400, 'запрос старше недели провайдер не принимает — окно подрезано');
  await pbxCallNow('clinic.onpbx.ru', '101', '+998901234567', o);
  const p = new URLSearchParams(bodies[1]);
  assert.equal(p.get('from'), '101');
  assert.equal(p.get('to'), '+998901234567');
});

test('normalizePbxCall: входящий, исходящий, пропущенный — в словарь Binotel (call_type, disposition, wait/bill)', () => {
  // Формы — с живой истории клиники: у входящего destination_number — очередь,
  // ответивший добавочный — в events[type=user].answered_stamp.
  const inbound = normalizePbxCall({ uuid: 'u1', accountcode: 'inbound', caller_id_number: '998901112233', destination_number: '10',
    start_stamp: 1789372800, end_stamp: 1789372840, duration: 40, user_talk_time: 30, hangup_cause: 'NORMAL_CLEARING',
    events: [{ type: 'transfer', number: '6100' }, { type: 'user', number: '105', end_stamp: 1789372805 }, { type: 'user', number: '108', answered_stamp: 1789372810, end_stamp: 1789372840 }] });
  assert.equal(inbound.general_call_id, 'onlinepbx:u1');
  assert.equal(inbound.started_at, '2026-09-14T08:00:00Z');
  assert.equal(inbound.call_type, 0);
  assert.equal(inbound.external_number, '998901112233');
  assert.equal(inbound.internal_number, '108', 'кто снял трубку, а не очередь');
  assert.equal(inbound.waitsec, 10, 'ждал до answered_stamp');
  assert.equal(inbound.billsec, 30);
  assert.equal(inbound.disposition, 'ANSWER');

  const outbound = normalizePbxCall({ uuid: 'u2', accountcode: 'outbound', caller_id_number: '101', destination_number: '998901112233', start_stamp: 1789372900, duration: 5, user_talk_time: 0, hangup_cause: 'NORMAL_CLEARING' });
  assert.equal(outbound.call_type, 1);
  assert.equal(outbound.external_number, '998901112233', 'у исходящего внешний — тот, кому звонили');
  assert.equal(outbound.internal_number, '101');
  assert.equal(outbound.disposition, 'NOANSWER');
  assert.equal(outbound.waitsec, 5);

  const cancelled = normalizePbxCall({ uuid: 'u3', accountcode: 'inbound', caller_id_number: '998901112233', destination_number: '10', start_stamp: 1789373000, duration: 65, user_talk_time: 0, hangup_cause: 'ORIGINATOR_CANCEL',
    events: [{ type: 'user', number: '108', end_stamp: 1789373060 }] });
  assert.equal(cancelled.call_type, 0);
  assert.equal(cancelled.disposition, 'CANCEL', 'звонящий повесил трубку, пока звонило');
  assert.equal(cancelled.internal_number, '10', 'никто не ответил — остаётся набранный номер');
  assert.equal(cancelled.waitsec, 65);

  const busy = normalizePbxCall({ uuid: 'u4', accountcode: 'outbound', caller_id_number: '102', destination_number: '998909999999', start_stamp: 1789373100, duration: 3, user_talk_time: 0, hangup_cause: 'USER_BUSY' });
  assert.equal(busy.disposition, 'BUSY');

  const missed = normalizePbxCall({ uuid: 'u5', accountcode: 'missed', caller_id_number: '998901112233', destination_number: '101', start_stamp: 1789373200, duration: 20, user_talk_time: 0, hangup_cause: 'NO_ANSWER' });
  assert.equal(missed.call_type, 0);
  assert.equal(missed.disposition, 'NOANSWER');

  assert.equal(normalizePbxCall({ accountcode: 'inbound', start_stamp: 1 }), null, 'без uuid нечего дедуплицировать');
  assert.equal(normalizePbxCall({ uuid: 'x' }), null, 'без времени нечего сортировать');
});
