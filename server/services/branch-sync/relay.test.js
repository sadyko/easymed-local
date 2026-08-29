import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../db/connection.js';
import { migrate } from '../../db/migrate.js';
import { b64url, writePairing, GROUP_KEY_BYTES } from './pairing.js';
import { relayIdFor, openPayload } from './relay-crypto.js';
import { publishCatalogue, fetchCatalogue, maybePublish, relayUrl, readLastPublish } from './relay.js';

// BRANCH_SYNC_RELAY_V1 — транспорт Маршрута Б на подставном fetch.
//
// Полный путь через настоящий сервер поставщика проверяет relay-e2e.test.js;
// здесь — решения, которых в e2e не видно: КОГДА фоновая выгрузка вообще
// происходит и что отвечает каждая ветка отказа. Фоновая выгрузка стоит
// отдельного теста: она единственное, что поддерживает копию живой, и если она
// молча перестанет срабатывать, филиал за упавшим VPN однажды обнаружит на
// сервере многомесячный прайс — без единой ошибки на экране.

const KEY = b64url(randomBytes(GROUP_KEY_BYTES));
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'em-relay-' + tag + '-'));

function clinic(tag, { role = 'main', relay = true, key = KEY, token = 'tok-AAAA' } = {}) {
  const dir = tmp(tag);
  const db = openDb(':memory:');
  migrate(db);
  db.prepare("UPDATE doc_settings SET clinic_name='Клиника Луч' WHERE id=1").run();
  db.prepare("INSERT INTO services (name, code, price, type, active) VALUES ('Приём','S-1',250000,'consultation',1)").run();
  if (token) fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ clinic_id: 'c-1', install_token: token }));
  const record = { role, group_id: 'BR-ABCDEF012345', secret: 'sss', main_url: 'http://10.0.0.5:8000', relay };
  if (key) record.group_key = key;
  writePairing(dir, record);
  return { dir, db };
}

// Подставной сервер поставщика: запоминает загруженное и отдаёт обратно.
function fakeVendor({ status = 200 } = {}) {
  const calls = [];
  const store = new Map();
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: (init.headers || {}).Authorization || null });
    const id = url.split('/').pop();
    if (method === 'PUT') {
      if (status === 200) store.set(id, Buffer.from(init.body));
      return { ok: status === 200, status, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const found = store.get(id);
    if (!found) return { ok: false, status: 404, body: null, arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      status: 200,
      body: null,
      arrayBuffer: async () => found.buffer.slice(found.byteOffset, found.byteOffset + found.byteLength),
    };
  };
  return { fetchImpl, calls, store };
}

test('адрес берётся из EASYMED_CONTROL_URL, по умолчанию — settings.easymed.uz', () => {
  assert.equal(relayUrl('abc', {}), 'https://settings.easymed.uz/cp/v1/relay/abc');
  assert.equal(relayUrl('abc', { EASYMED_CONTROL_URL: 'http://127.0.0.1:8090///' }), 'http://127.0.0.1:8090/cp/v1/relay/abc');
});

test('выгрузка кладёт шифротекст по адресу из ключа и представляется install_token-ом', async () => {
  const { dir, db } = clinic('pub');
  const vendor = fakeVendor();
  const r = await publishCatalogue(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  assert.equal(r.ok, true, JSON.stringify(r));

  assert.equal(vendor.calls[0].method, 'PUT');
  assert.equal(vendor.calls[0].auth, 'Bearer tok-AAAA', 'та же учётка, что у ежедневного check-in');
  assert.match(vendor.calls[0].url, new RegExp('/cp/v1/relay/' + relayIdFor(KEY) + '$'));

  // То, что уехало, читается только нашим ключом, и внутри именно справочник.
  const blob = vendor.store.get(relayIdFor(KEY));
  const opened = openPayload(KEY, blob);
  assert.equal(opened.ok, true);
  assert.ok(opened.payload.catalogue.services.some((x) => x.code === 'S-1'));
  assert.equal(blob.toString('latin1').includes('Клиника Луч'), false, 'название клиники не читается в блобе');
});

test('каждая выгрузка использует новый IV: тот же справочник даёт другие байты', async () => {
  const { dir, db } = clinic('iv');
  const vendor = fakeVendor();
  await publishCatalogue(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  const first = Buffer.from(vendor.store.get(relayIdFor(KEY)));
  await publishCatalogue(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  const second = vendor.store.get(relayIdFor(KEY));
  // Повтор IV на одном ключе ломает GCM полностью — это не эстетика.
  assert.equal(first.equals(second), false, 'один и тот же IV дважды недопустим');
  // Сравниваются САМИ ДАННЫЕ: catalogue.generated_at у двух выгрузок разный по
  // построению (это отметка момента выгрузки), и он к содержимому не относится.
  assert.deepEqual(openPayload(KEY, second).payload.catalogue.services,
    openPayload(KEY, first).payload.catalogue.services);
});

test('выгружает только главный филиал, только с согласия и только с ключом', async () => {
  const vendor = fakeVendor();
  const call = async (opts) => {
    const { dir, db } = clinic('guard', opts);
    return publishCatalogue(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  };
  // Вторичный не выгружает: он затёр бы чужой блоб своим, ещё не обновлённым
  // справочником, и главный филиал перестал бы быть источником правды.
  assert.equal((await call({ role: 'secondary' })).reason, 'relay_not_main');
  assert.equal((await call({ relay: false })).reason, 'relay_disabled');
  assert.equal((await call({ key: null })).reason, 'relay_no_key');
  // Клиника, лицензированная по телефону: у поставщика её просто нет.
  assert.equal((await call({ token: null })).reason, 'relay_not_enrolled');
  assert.equal(vendor.calls.length, 0, 'ни один отказ не должен был дойти до сети');
});

test('фоновая выгрузка молчит, пока справочник не изменился', async () => {
  const { dir, db } = clinic('skip');
  const vendor = fakeVendor();

  const first = await maybePublish(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  assert.equal(first.ok, true);
  assert.equal(vendor.calls.length, 1);

  const second = await maybePublish(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  assert.equal(second.skipped, true, 'гонять мегабайты каждые шесть часов ради того же прайса незачем');
  assert.equal(vendor.calls.length, 1);

  db.prepare("UPDATE services SET price = 320000 WHERE code='S-1'").run();
  const third = await maybePublish(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  assert.equal(third.ok, true);
  assert.equal(third.skipped, undefined);
  assert.equal(vendor.calls.length, 2);
});

test('но раз в сутки копия обновляется всё равно — иначе её вычистит удержание', async () => {
  const { dir, db } = clinic('refresh');
  const vendor = fakeVendor();
  await maybePublish(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  assert.equal(vendor.calls.length, 1);

  // Тот же справочник, но копия старше суток. Сервер поставщика чистит блобы,
  // к которым не обращались, и группа с редко меняющимся прайсом не должна
  // однажды обнаружить пустоту.
  const later = () => new Date(Date.now() + 30 * 60 * 60 * 1000);
  const r = await maybePublish(db, dir, { fetchImpl: vendor.fetchImpl, env: {}, now: later });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, undefined);
  assert.equal(vendor.calls.length, 2);
});

test('фоновая выгрузка не трогает сеть там, где выгружать нечего', async () => {
  const vendor = fakeVendor();
  for (const opts of [{ role: 'secondary' }, { relay: false }, { key: null }]) {
    const { dir, db } = clinic('bg-off', opts);
    const r = await maybePublish(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
    assert.equal(r.ok, false);
  }
  assert.equal(vendor.calls.length, 0,
    'установка, не назначенная главной или без согласия владельца, к поставщику не ходит вовсе');
});

test('журнал последней выгрузки помнит, когда и сколько байт уехало', async () => {
  const { dir, db } = clinic('log');
  const vendor = fakeVendor();
  assert.equal(readLastPublish(db), null);
  const r = await publishCatalogue(db, dir, { fetchImpl: vendor.fetchImpl, env: {} });
  const last = readLastPublish(db);
  assert.equal(last.at, r.at);
  assert.equal(last.bytes, r.bytes);
});

test('мёртвая сеть — это состояние, а не поломка, и ничего не записывает', async () => {
  const { dir, db } = clinic('offline');
  const dead = async () => { throw new Error('ECONNREFUSED'); };
  const r = await publishCatalogue(db, dir, { fetchImpl: dead, env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'relay_offline');
  assert.equal(readLastPublish(db), null, 'неудачная выгрузка не должна выглядеть удавшейся');
});

test('каждый ответ сервера переводится в свою причину', async () => {
  const { dir, db } = clinic('codes');
  const byStatus = async (status) => (await publishCatalogue(db, dir, {
    fetchImpl: async () => ({ ok: false, status }), env: {},
  })).reason;
  assert.equal(await byStatus(401), 'relay_unauthorized');
  assert.equal(await byStatus(413), 'relay_too_large');
  assert.equal(await byStatus(500), 'relay_server_error');
});

test('приёмник забирает копию и разбирает её ровно как ответ прямого пути', async () => {
  const vendor = fakeVendor();
  const main = clinic('rt-main', { role: 'main' });
  await publishCatalogue(main.db, main.dir, { fetchImpl: vendor.fetchImpl, env: {} });

  const sec = clinic('rt-sec', { role: 'secondary', token: 'tok-BBBB' });
  const got = await fetchCatalogue(sec.dir, { fetchImpl: vendor.fetchImpl, env: {} });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.ok(got.catalogue.services.some((x) => x.code === 'S-1'));
  assert.ok(got.generated_at, 'возраст копии обязан доехать: это не сегодняшние данные');
  assert.equal(got.group_id, 'BR-ABCDEF012345');
});

test('пустой сервер, чужой ключ и выключенный канал — три разные причины', async () => {
  const vendor = fakeVendor();
  const sec = clinic('miss', { role: 'secondary' });

  // Копии ещё нет: чинится это на ДРУГОЙ машине, и причина поэтому отдельная.
  assert.equal((await fetchCatalogue(sec.dir, { fetchImpl: vendor.fetchImpl, env: {} })).reason, 'relay_empty');

  // Копия есть, но запечатана другим ключом и лежит по нашему адресу.
  const main = clinic('miss-main', { role: 'main' });
  await publishCatalogue(main.db, main.dir, { fetchImpl: vendor.fetchImpl, env: {} });
  const other = b64url(randomBytes(GROUP_KEY_BYTES));
  vendor.store.set(relayIdFor(other), vendor.store.get(relayIdFor(KEY)));
  const wrong = clinic('miss-wrong', { role: 'secondary', key: other });
  assert.equal((await fetchCatalogue(wrong.dir, { fetchImpl: vendor.fetchImpl, env: {} })).reason, 'relay_bad_key');

  const off = clinic('miss-off', { role: 'secondary', relay: false });
  assert.equal((await fetchCatalogue(off.dir, { fetchImpl: vendor.fetchImpl, env: {} })).reason, 'relay_disabled');
  const noKey = clinic('miss-nokey', { role: 'secondary', key: null });
  assert.equal((await fetchCatalogue(noKey.dir, { fetchImpl: vendor.fetchImpl, env: {} })).reason, 'relay_no_key');
});

test('главный филиал не забирает копию сам у себя', async () => {
  const main = clinic('self', { role: 'main' });
  const r = await fetchCatalogue(main.dir, {
    fetchImpl: async () => { throw new Error('не должно вызываться'); }, env: {},
  });
  assert.equal(r.reason, 'relay_not_secondary', 'иначе вышло бы кольцо, в котором ничья цена не правда');
});
