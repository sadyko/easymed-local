// LIS_PROXY_V1 — карточка «LIS Proxy»: включить / выключить / сменить ключ;
// адрес с ключом — только админу и лаборанту; «Добавить» прибор прокси —
// только BS-200, BC-780, AutoLumo A1000; через RPC-маршрут настоящего приложения.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setDataDir } from '../control/config.js';
import { isReadOnlyRpc } from '../control/gate.js';
import { tmpDir } from '../../test-helpers/tmpdir.js';
import { readProxySettings, keyMatches } from '../../lis/lisproxy-settings.js';
import { lisProxyGet, lisProxySet, proxyState } from './lis-proxy.js';
import { lisDeviceAdd } from './lis.js';
import { RPC } from './index.js';
import { freshDb, addProxyDevice, startProxyApp, post, fixture } from '../../test-helpers/lisproxy-clinic.js';
import { listen } from '../../../control-plane/server/test-helpers/listen.js';   // LIS_PROXY_V1 — стенд получает listen от теста

const ADMIN = { id: 1, role: 'admin' };
const LAB = { id: 2, role: 'lab' };
const DOCTOR = { id: 3, role: 'doctor' };
const CASHIER = { id: 4, role: 'cashier' };

test('по умолчанию выключено; включение создаёт ключ; адреса — по адресам ПК и порту; выключение ключ хранит; «сменить ключ» — новый', () => {
  const dir = tmpDir('em-lpx-rpc-');
  setDataDir(dir);
  const db = freshDb();
  assert.deepEqual(lisProxyGet(db, {}, LAB).enabled, false);
  const on = lisProxySet(db, { enabled: true }, LAB);
  assert.equal(on.enabled, true);
  assert.match(on.key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(on.can_manage, true);
  assert.equal(readProxySettings(dir).changed_by, 2);
  const st = proxyState(dir, { port: 8123, addresses: ['192.168.1.10', '10.0.0.2'] });
  assert.deepEqual(st.urls, ['http://192.168.1.10:8123/api/lisproxy?key=' + on.key, 'http://10.0.0.2:8123/api/lisproxy?key=' + on.key]);
  const off = lisProxySet(db, { enabled: false }, ADMIN);
  assert.deepEqual([off.enabled, off.key, off.urls], [false, null, []]);
  assert.equal(readProxySettings(dir).key, on.key, 'ключ хранится');
  assert.equal(lisProxySet(db, { enabled: true }, ADMIN).key, on.key, 'включили снова — тот же адрес');
  const rotated = lisProxySet(db, { rotate: true }, ADMIN);
  assert.notEqual(rotated.key, on.key);
  assert.equal(keyMatches(on.key, readProxySettings(dir).key), false, 'старый ключ больше не подходит');
  db.close();
});

test('роли: адрес с ключом и правка — админ и лаборант; врач видит только «включён»; касса — 403; аргументы проверяются', () => {
  setDataDir(tmpDir('em-lpx-rpc-'));
  const db = freshDb();
  lisProxySet(db, { enabled: true }, ADMIN);
  const doc = lisProxyGet(db, {}, DOCTOR);
  assert.deepEqual([doc.enabled, doc.key, doc.urls, doc.can_manage], [true, null, [], false]);
  assert.throws(() => lisProxyGet(db, {}, CASHIER), (e) => e.status === 403);
  assert.throws(() => lisProxySet(db, { enabled: false }, DOCTOR), (e) => e.status === 403);
  assert.throws(() => lisProxySet(db, { enabled: 'да' }, ADMIN), /включить или выключить/);
  assert.throws(() => lisProxySet(db, {}, ADMIN), /Нечего менять/);
  assert.throws(() => lisProxySet(db, { rotate: 1 }, ADMIN), /Нечего менять/);
  db.close();
});

test('карта RPC: lis_proxy_get — чтение (лицензия), lis_proxy_set — запись', () => {
  assert.equal(typeof RPC.lis_proxy_get, 'function');
  assert.equal(typeof RPC.lis_proxy_set, 'function');
  assert.equal(isReadOnlyRpc('lis_proxy_get'), true);
  assert.equal(isReadOnlyRpc('lis_proxy_set'), false);
});

test('ключ сменили — старый адрес сразу 404, новый — 200', async () => {
  const db = freshDb();
  const app = await startProxyApp(db, { listen });
  setDataDir(app.dataDir);
  try {
    const before = await post(app.url, fixture('lists', 'cl_barcode_list'));
    assert.equal(before.status, 200);
    const { key } = lisProxySet(db, { rotate: true }, ADMIN);
    assert.equal((await post(app.url, fixture('lists', 'cl_barcode_list'))).status, 404);
    assert.equal((await post(app.base + '/api/lisproxy?key=' + key, fixture('lists', 'cl_barcode_list'))).status, 200);
  } finally { await app.close(); db.close(); }
});

test('«Добавить» прибор LIS Proxy: модель обязательна и одна из трёх; «общий HL7» — отказ; прибор своего порта — как прежде', () => {
  const db = freshDb();
  const id = addProxyDevice(db, { name: 'bs200', added: 0 });
  for (const args of [{ id, name: 'BS-200' }, { id, name: 'BS-200', generic: true }, { id, name: 'BS-200', profile: 'mindray-cl-900i' }]) {
    assert.throws(() => lisDeviceAdd(db, args, LAB), (e) => e.code === 'proxy_model_required' && /только BS-200, BC-780 и AutoLumo A1000/.test(e.message), JSON.stringify(args));
  }
  const ok = lisDeviceAdd(db, { id, name: 'BS-200 (лаб. ПК 1)', profile: 'mindray-bs-200' }, LAB);
  assert.deepEqual([ok.added, ok.profile, ok.model_confirmed], [1, 'mindray-bs-200', 1]);
  db.prepare("INSERT INTO lab_devices (id, name, profile, transport, host, enabled, discovered, added) VALUES (50, 'Анализатор 10.0.0.9', '', 'mllp', '10.0.0.9', 1, 1, 0)").run();
  assert.equal(lisDeviceAdd(db, { id: 50, name: 'Другой', generic: true }, LAB).added, 1, 'свой порт — «общий HL7» как прежде');
  db.close();
});
