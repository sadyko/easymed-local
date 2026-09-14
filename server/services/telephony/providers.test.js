// TELEPHONY_PROVIDERS_V1 — реестр провайдеров: сохранение без утечки секрета,
// проверка подключения, опрос каждого провайдера своим курсором.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { listProviders, saveProvider, deleteProvider, testProvider, providerSecrets, getProviderRow, ProviderError, KINDS } from './providers.js';
import { pollOnce, nextDelayMs } from './poller.js';

const fresh = () => { const db = openDb(':memory:'); migrate(db); return db; };

test('save: карточка создаётся, секрет наружу не выходит, пустой секрет не стирает сохранённый', () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'onlinepbx', name: 'Офис', config: { domain: 'https://Clinic.onpbx.ru/' }, secret: { auth_key: 'AUTH-1' }, poll_interval_sec: 5 });
  assert.equal(p.kind, 'onlinepbx');
  assert.equal(p.kind_label, KINDS.onlinepbx.label);
  assert.equal(p.config.domain, 'clinic.onpbx.ru', 'домен приведён к виду без схемы');
  assert.deepEqual(p.secret_set, { auth_key: true });
  assert.equal(p.poll_interval_sec, 10, 'интервал не чаще 10 секунд');
  assert.equal(JSON.stringify(p).includes('AUTH-1'), false, 'ключ не в ответе');
  assert.equal(JSON.stringify(listProviders(db)).includes('AUTH-1'), false);

  // Пересохранили форму с пустым полем ключа — ключ остался.
  saveProvider(db, { id: p.id, name: 'Офис 2', secret: { auth_key: '' } });
  assert.equal(providerSecrets(getProviderRow(db, p.id)).auth_key, 'AUTH-1');
  assert.equal(listProviders(db)[0].name, 'Офис 2');
});

test('save: новый auth_key сбрасывает выданную провайдером пару', () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'onlinepbx', config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'A' } });
  db.prepare('UPDATE telephony_providers SET secret = ? WHERE id = ?').run(JSON.stringify({ auth_key: 'A', key_id: 'ID', key: 'K' }), p.id);
  assert.equal(listProviders(db)[0].authorized, true);
  saveProvider(db, { id: p.id, secret: { auth_key: 'B' } });
  const sec = providerSecrets(getProviderRow(db, p.id));
  assert.equal(sec.auth_key, 'B');
  assert.equal(sec.key_id, undefined);
  assert.equal(listProviders(db)[0].authorized, false);
});

test('save: включить без домена или ключа нельзя; неизвестный вид — 400; чужой id — 404', () => {
  const db = fresh();
  assert.throws(() => saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain: 'c.onpbx.ru' } }),
    (e) => e instanceof ProviderError && e.status === 400 && /ключ/i.test(e.message));
  assert.throws(() => saveProvider(db, { kind: 'skype' }), (e) => e instanceof ProviderError && e.status === 400);
  assert.throws(() => saveProvider(db, { id: 999, name: 'x' }), (e) => e.status === 404);
  assert.throws(() => deleteProvider(db, 999), (e) => e.status === 404);
  const p = saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'A' } });
  assert.equal(p.enabled, true);
  deleteProvider(db, p.id);
  assert.equal(listProviders(db).length, 0);
});

test('test: введённый ключ проверяется без кэша, сохранённый — с выданной парой; каждая причина — русской фразой', async () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'onlinepbx', config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'SAVED' } });
  const seen = [];
  const pbxAuthImpl = async (domain, authKey) => { seen.push(['auth', domain, authKey]); return { ok: true, key_id: 'ID', key: 'K' }; };
  const pbxHistoryImpl = async (domain, since, o) => { seen.push(['history', domain, o.creds.key_id]); return { ok: true, data: [{ uuid: 'a' }, { uuid: 'b' }] }; };

  let r = await testProvider(db, { id: p.id }, { pbxAuthImpl, pbxHistoryImpl });
  assert.deepEqual(r, { ok: true, calls_last_minute: 2 });
  assert.deepEqual(seen, [['auth', 'c.onpbx.ru', 'SAVED'], ['history', 'c.onpbx.ru', 'ID']]);
  assert.equal(providerSecrets(getProviderRow(db, p.id)).key_id, 'ID', 'выданная пара запомнена — следующий опрос авторизацию не дёргает');

  seen.length = 0;
  r = await testProvider(db, { id: p.id }, { pbxAuthImpl, pbxHistoryImpl });
  assert.deepEqual(seen, [['history', 'c.onpbx.ru', 'ID']], 'пара есть — сразу история');

  seen.length = 0;
  r = await testProvider(db, { id: p.id, secret: { auth_key: 'TYPED' } }, { pbxAuthImpl, pbxHistoryImpl });
  assert.deepEqual(seen[0], ['auth', 'c.onpbx.ru', 'TYPED'], 'введённый ключ проверяется именно он');
  assert.equal(providerSecrets(getProviderRow(db, p.id)).auth_key, 'SAVED', 'проверка ничего не сохраняет');

  for (const reason of ['bad_credentials', 'offline', 'server_error', 'bad_response', 'rate_limited']) {
    const rr = await testProvider(db, { id: p.id }, { pbxAuthImpl, pbxHistoryImpl: async () => ({ ok: false, reason }) });
    assert.equal(rr.ok, false);
    assert.equal(rr.reason, reason);
    assert.match(rr.message, /[А-Яа-я]/);
  }
  const none = await testProvider(db, {}, { pbxAuthImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(none.reason, 'bad_credentials');
});

test('poll: включённый onlinePBX опрашивается своим курсором, звонки ложатся в общий журнал с провайдером', async () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'A' } });
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Иван', '+998901112233')").run();
  const since = [];
  const pbxHistoryImpl = async (domain, s) => {
    since.push(s);
    return { ok: true, data: [
      { uuid: 'u1', accountcode: 'inbound', caller_id_number: '998901112233', destination_number: '101', start_stamp: 1789372800, duration: 40, user_talk_time: 30 },
      { uuid: 'u2', accountcode: 'outbound', caller_id_number: '101', destination_number: '998909999999', start_stamp: 1789372900, duration: 5, user_talk_time: 0 },
      { accountcode: 'inbound' },
    ] };
  };
  await pollOnce(db, { hasModule: () => true, pbxHistoryImpl, fetchImpl: async () => { throw new Error('binotel must not be polled while disabled'); } });

  const rows = db.prepare('SELECT general_call_id, provider, provider_id, call_type, external_number, patient_id, source FROM calls ORDER BY started_at').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].general_call_id, 'onlinepbx:u1');
  assert.equal(rows[0].provider, 'onlinepbx');
  assert.equal(rows[0].provider_id, p.id);
  assert.equal(rows[0].source, 'poll');
  assert.ok(rows[0].patient_id, 'пациент найден по номеру тем же матчером');
  assert.equal(rows[1].call_type, 1);
  const row = getProviderRow(db, p.id);
  assert.ok(row.last_poll_at);
  assert.equal(row.last_error, '');
  assert.equal(row.last_call_at, '2026-09-14T08:01:40Z');

  // Второй тик: курсор — от последнего звонка ЭТОГО провайдера минус перекрытие; дублей нет.
  await pollOnce(db, { hasModule: () => true, pbxHistoryImpl });
  assert.equal(since[1], 1789372900 - 120);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 2);
});

test('poll: отказ провайдера — его last_error, лицензия не выдана — тишина', async () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'A' } });
  await pollOnce(db, { hasModule: () => true, pbxHistoryImpl: async () => ({ ok: false, reason: 'offline' }) });
  assert.equal(getProviderRow(db, p.id).last_error, 'offline');
  await pollOnce(db, { hasModule: () => true, pbxHistoryImpl: async () => ({ ok: true, data: [] }) });
  assert.equal(getProviderRow(db, p.id).last_error, '', 'удачный тик стирает ошибку');

  let called = 0;
  await pollOnce(db, { hasModule: () => false, pbxHistoryImpl: async () => { called++; return { ok: true, data: [] }; } });
  assert.equal(called, 0);
});

test('nextDelayMs: самый частый из включённых; никого — редкое дыхание', () => {
  const db = fresh();
  assert.equal(nextDelayMs(db), 30_000);
  saveProvider(db, { kind: 'onlinepbx', enabled: true, config: { domain: 'c.onpbx.ru' }, secret: { auth_key: 'A' }, poll_interval_sec: 20 });
  assert.equal(nextDelayMs(db), 20_000);
  db.prepare("UPDATE telephony_settings SET enabled = 1, api_key = 'k', api_secret = 's', poll_interval_sec = 15 WHERE id = 1").run();
  assert.equal(nextDelayMs(db), 15_000);
  db.prepare('UPDATE telephony_providers SET poll_interval_sec = 10').run();
  assert.equal(nextDelayMs(db), 10_000);
});
