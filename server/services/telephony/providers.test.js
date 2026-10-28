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

// MOIZVONKI_V2 — опрос «Моих Звонков»: calls.list по курсору db_call_id.
const MZ_CALL = (over = {}) => ({
  direction: 0, user_account: 'reg@clinic.uz', user_id: 7, client_number: '+998 90 111-22-33', client_name: '',
  start_time: 1789372800, answer_time: 1789372812, end_time: 1789372900, upload_time: 1789373000, duration: 88,
  src_number: '+998711234567', src_id: 3, src_slot: 0, recording: 'https://clinic.moizvonki.ru/rec/a.mp3',
  answered: 1, db_call_id: 1224, event_pbx_call_id: '1.1789372800', ...over,
});

test('poll: включённые «Мои Звонки» опрашиваются по calls.list — сначала за сутки по дате, затем from_id от последнего db_call_id; звонки ложатся в журнал с провайдером', async () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'moizvonki', enabled: true, config: { domain: 'clinic.moizvonki.ru', user_name: 'boss@clinic.uz' }, secret: { api_key: 'TESTONLY-key' } });
  db.prepare("INSERT INTO patients (full_name, phone) VALUES ('Иванов Иван', '+998901112233')").run();
  const seen = [];
  const mzListImpl = async (domain, cursor, o) => {
    seen.push({ domain, cursor, userName: o.userName, apiKey: o.apiKey });
    return { ok: true, truncated: false, data: [
      MZ_CALL(),
      MZ_CALL({ db_call_id: 1225, direction: 1, answered: 0, answer_time: 0, duration: 0, end_time: 1789372920, start_time: 1789372900, recording: '', client_number: '+998909999999' }),
      { client_number: 'мусор без времени' },
    ] };
  };
  await pollOnce(db, { hasModule: () => true, mzListImpl, fetchImpl: async () => { throw new Error('binotel must not be polled while disabled'); } });

  const rows = db.prepare('SELECT general_call_id, provider, provider_id, call_type, external_number, internal_number, disposition, billsec, waitsec, patient_id, source, recording_url FROM calls ORDER BY started_at').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].general_call_id, 'moizvonki:1224');
  assert.equal(rows[0].provider, 'moizvonki');
  assert.equal(rows[0].provider_id, p.id);
  assert.equal(rows[0].source, 'poll');
  assert.equal(rows[0].external_number, '+998901112233', 'номер приведён к формату клиники в recordCall');
  assert.equal(rows[0].internal_number, 'reg@clinic.uz', '«кто» у «Моих Звонков» — почта сотрудника');
  assert.equal(rows[0].disposition, 'ANSWER');
  assert.equal(rows[0].billsec, 88);
  assert.equal(rows[0].waitsec, 12);
  assert.equal(rows[0].recording_url, 'https://clinic.moizvonki.ru/rec/a.mp3');
  assert.ok(rows[0].patient_id, 'пациент найден по номеру тем же матчером');
  assert.equal(rows[1].general_call_id, 'moizvonki:1225');
  assert.equal(rows[1].call_type, 1);
  assert.equal(rows[1].disposition, 'NOANSWER');
  const row = getProviderRow(db, p.id);
  assert.ok(row.last_poll_at);
  assert.equal(row.last_error, '');
  assert.equal(row.last_call_at, '2026-09-14T08:01:40Z');

  // Первый проход — по дате, сутки назад; подпись — из настроек провайдера.
  assert.equal(seen[0].domain, 'clinic.moizvonki.ru');
  assert.equal(seen[0].userName, 'boss@clinic.uz');
  assert.equal(seen[0].apiKey, 'TESTONLY-key');
  assert.ok(!seen[0].cursor.fromId, 'первый раз нет известного db_call_id');
  const dayAgo = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
  assert.ok(Math.abs(seen[0].cursor.fromDate - dayAgo) < 30, 'from_date — сутки назад: ' + seen[0].cursor.fromDate);

  // Второй проход — from_id от последнего db_call_id этого провайдера + 1; дублей нет.
  await pollOnce(db, { hasModule: () => true, mzListImpl });
  assert.equal(seen[1].cursor.fromId, 1226);
  assert.ok(!seen[1].cursor.fromDate);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 2);
});

test('poll: отказ «Моих Звонков» — last_error провайдера словом; усечённый обход — too_many_calls, но звонки записаны', async () => {
  const db = fresh();
  const p = saveProvider(db, { kind: 'moizvonki', enabled: true, config: { domain: 'clinic.moizvonki.ru', user_name: 'boss@clinic.uz' }, secret: { api_key: 'TESTONLY-key' } });
  await pollOnce(db, { hasModule: () => true, mzListImpl: async () => ({ ok: false, reason: 'bad_credentials', data: [] }) });
  assert.equal(getProviderRow(db, p.id).last_error, 'bad_credentials');
  await pollOnce(db, { hasModule: () => true, mzListImpl: async () => ({ ok: true, truncated: true, data: [MZ_CALL()] }) });
  assert.equal(getProviderRow(db, p.id).last_error, 'too_many_calls');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM calls').get().n, 1);
  await pollOnce(db, { hasModule: () => true, mzListImpl: async () => ({ ok: true, truncated: false, data: [] }) });
  assert.equal(getProviderRow(db, p.id).last_error, '', 'удачный проход стирает ошибку');
  // Выключенный провайдер не опрашивается.
  saveProvider(db, { id: p.id, enabled: false });
  let called = 0;
  await pollOnce(db, { hasModule: () => true, mzListImpl: async () => { called++; return { ok: true, data: [] }; } });
  assert.equal(called, 0);
});

// FIX_318_V1 (C6) — два подключения «Моих Звонков» к одному кабинету (руководитель
// видит звонки всех): звонки подшивает первое, второе строк не получает (ON
// CONFLICT), и его курсор по «своим строкам» навсегда оставался «сутки назад» —
// каждый проход заново тянул весь день. Курсор теперь у каждого подключения свой:
// следующий за последним УВИДЕННЫМ им db_call_id, чьей бы ни стала строка.
test('FIX_318_V1: два подключения «Моих Звонков» к одному кабинету — у каждого свой курсор; второе не тянет сутки каждый проход', async () => {
  const db = fresh();
  const mk = (name) => saveProvider(db, { kind: 'moizvonki', name, enabled: true, poll_interval_sec: 30,
    config: { domain: 'clinic.moizvonki.ru', user_name: name + '@clinic.uz' }, secret: { api_key: 'TESTONLY-' + name } });
  const p1 = mk('boss');
  const p2 = mk('operator');
  const now = Math.floor(Date.now() / 1000);
  const day = Array.from({ length: 5 }, (_, i) => MZ_CALL({ db_call_id: 1000 + i, event_pbx_call_id: '', start_time: now - 3600 + i, client_number: '+99890' + String(1000000 + i) }));
  const seen = [];
  const mzListImpl = async (domain, cursor, o) => {
    seen.push([o.userName, cursor]);
    const from = cursor.fromId != null ? cursor.fromId : 0;
    return { ok: true, truncated: false, data: day.filter((c) => c.db_call_id >= from) };
  };
  await pollOnce(db, { hasModule: () => true, mzListImpl });
  assert.deepEqual(db.prepare('SELECT provider_id, COUNT(*) AS n FROM calls GROUP BY provider_id').all().map((r) => ({ ...r })), [{ provider_id: p1.id, n: 5 }]);
  seen.length = 0;
  await pollOnce(db, { hasModule: () => true, mzListImpl });
  assert.deepEqual(seen, [['boss@clinic.uz', { fromId: 1005 }], ['operator@clinic.uz', { fromId: 1005 }]],
    'второе подключение снова тянет сутки по дате');
  // Новый звонок — оба курсора идут дальше.
  day.push(MZ_CALL({ db_call_id: 1005, event_pbx_call_id: '', start_time: now - 60, client_number: '+998901234500' }));
  seen.length = 0;
  await pollOnce(db, { hasModule: () => true, mzListImpl });
  await pollOnce(db, { hasModule: () => true, mzListImpl });
  assert.deepEqual(seen.slice(2), [['boss@clinic.uz', { fromId: 1006 }], ['operator@clinic.uz', { fromId: 1006 }]]);
  // Сменили кабинет (другой адрес) — курсор прежнего кабинета не годится: снова сутки по дате.
  saveProvider(db, { id: p2.id, config: { domain: 'other.moizvonki.ru' } });
  seen.length = 0;
  await pollOnce(db, { hasModule: () => true, mzListImpl });
  assert.ok(seen[1][1].fromDate && !seen[1][1].fromId, 'курсор чужого кабинета: ' + JSON.stringify(seen[1][1]));
  // Курсор не уходит в браузер: в публичном виде подключения его нет.
  assert.ok(!JSON.stringify(listProviders(db)).includes('1006'));
});
